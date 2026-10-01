/**
 * Visitor journeys, kept entirely in Shopify.
 *
 * The storefront script (theme asset engine-journey.js) records what a shopper looks at and taps.
 * Once they have a cart it posts the journey here (app proxy), and we keep it as a vw_journey
 * metaobject keyed by the cart token. When the order is created (orders/create webhook) we find
 * the journey through the cart token Fastrr saves on the order (note attribute shopifyCartToken)
 * or Shopify's own cart_token, write it into the order note and add short jr:* tags.
 */

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

export const JOURNEY_TYPE = "vw_journey";
const NOTE_MARK = "🧭 Journey";
const APP_URL = process.env.SHOPIFY_APP_URL || "https://shopify-engine.onrender.com";

async function gql(admin: Admin, query: string, variables?: Record<string, unknown>) {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const body: any = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

/** "hWNHSvXw…?key=5b5d…" → "hWNHSvXw…" */
export function cartId(token: string) {
  return String(token || "").split("?")[0].replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}
function handleFor(token: string) {
  return ("j-" + cartId(token).toLowerCase()).slice(0, 100);
}

let definitionReady = false;
async function ensureDefinition(admin: Admin) {
  if (definitionReady) return;
  const existing = await gql(admin, `{ metaobjectDefinitionByType(type: "${JOURNEY_TYPE}") { id } }`);
  if (!existing.metaobjectDefinitionByType) {
    const r = await gql(admin, `mutation($d: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $d) { metaobjectDefinition { id } userErrors { field message } } }`, {
      d: {
        name: "Visitor journey",
        type: JOURNEY_TYPE,
        displayNameKey: "cart",
        access: { storefront: "NONE" },
        description: "What a shopper looked at before ordering (Vesture Studio app). Copied into the order note.",
        fieldDefinitions: [
          { key: "cart", name: "Cart token", type: "single_line_text_field" },
          { key: "summary", name: "Summary", type: "multi_line_text_field" },
          { key: "tags", name: "Tags", type: "single_line_text_field" },
          { key: "data", name: "Details", type: "json" },
          { key: "order", name: "Order", type: "single_line_text_field" },
          { key: "updated", name: "Updated", type: "date_time" },
        ],
      },
    });
    const errs = r.metaobjectDefinitionCreate.userErrors;
    if (errs?.length && !/taken|exists/i.test(JSON.stringify(errs))) throw new Error("Journey definition: " + JSON.stringify(errs));
  }
  definitionReady = true;
}

let webhookReady = false;
/** orders/create → /webhooks/orders/create, created through the API so no CLI deploy is needed */
export async function ensureOrdersWebhook(admin: Admin) {
  if (webhookReady) return;
  const uri = APP_URL.replace(/\/$/, "") + "/webhooks/orders/create";
  const d = await gql(admin, `{ webhookSubscriptions(first: 50, topics: [ORDERS_CREATE]) { nodes { id uri } } }`);
  const has = (d.webhookSubscriptions?.nodes || []).some((n: any) => n.uri === uri);
  if (!has) {
    const r = await gql(admin, `mutation($sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: $sub) { webhookSubscription { id } userErrors { message } } }`,
      { sub: { uri, format: "JSON" } });
    const errs = r.webhookSubscriptionCreate.userErrors;
    if (errs?.length && !/taken|exists/i.test(JSON.stringify(errs))) throw new Error("orders/create webhook: " + JSON.stringify(errs));
  }
  webhookReady = true;
}

const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);

export type JourneyInput = { cart: string; summary: string; tags: string[]; data: unknown };

/** Save / replace the journey of one cart */
export async function saveJourney(admin: Admin, input: JourneyInput) {
  const id = cartId(input.cart);
  if (id.length < 10) throw new Error("Bad cart");
  await ensureDefinition(admin);
  // readable tags like "4 Reviews: 45 sec"; Shopify tags can't contain commas
  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map((t) => clean(t, 60).replace(/,/g, " ").replace(/[^\p{L}\p{N} :/()+.·&'-]/gu, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);
  let data = "";
  try { data = JSON.stringify(input.data ?? {}).slice(0, 20000); } catch { data = "{}"; }
  const r = await gql(admin, `mutation($h: MetaobjectHandleInput!, $m: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $h, metaobject: $m) { metaobject { id } userErrors { field message } } }`, {
    h: { type: JOURNEY_TYPE, handle: handleFor(id) },
    m: {
      fields: [
        { key: "cart", value: id },
        { key: "summary", value: clean(input.summary, 1500) || "-" },
        { key: "tags", value: tags.join(",") },
        { key: "data", value: data || "{}" },
        { key: "updated", value: new Date().toISOString() },
      ],
    },
  });
  const errs = r.metaobjectUpsert.userErrors;
  if (errs?.length) throw new Error(JSON.stringify(errs).slice(0, 300));
  if (Math.random() < 0.03) pruneOld(admin).catch(() => {});
}

/** Journeys of carts that never ordered are removed after 21 days */
async function pruneOld(admin: Admin) {
  const d = await gql(admin, `{ metaobjects(type: "${JOURNEY_TYPE}", first: 50, sortKey: "updated_at") { nodes { id updatedAt } } }`);
  const cutoff = Date.now() - 21 * 864e5;
  for (const n of d.metaobjects?.nodes || []) {
    if (new Date(n.updatedAt).getTime() < cutoff) {
      await gql(admin, `mutation($id: ID!) { metaobjectDelete(id: $id) { deletedId } }`, { id: n.id });
    }
  }
}

/** orders/create payload → note + tags on the order (idempotent) */
export async function applyJourneyToOrder(admin: Admin, order: any) {
  const attrs: any[] = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const fromAttr = attrs.find((a) => /^shopifycarttoken$/i.test(String(a?.name || "")))?.value;
  const token = cartId(fromAttr || order?.cart_token || "");
  const orderGid = order?.admin_graphql_api_id || (order?.id ? `gid://shopify/Order/${order.id}` : "");
  if (!token || !orderGid) return { applied: false, reason: "no cart token" };
  if (String(order?.note || "").includes(NOTE_MARK)) return { applied: false, reason: "already applied" };

  const d = await gql(admin, `query($h: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $h) { id summary: field(key: "summary") { value } tags: field(key: "tags") { value } } }`,
    { h: { type: JOURNEY_TYPE, handle: handleFor(token) } });
  const mo = d.metaobjectByHandle;
  if (!mo) return { applied: false, reason: "no journey for cart " + token };

  const summary = String(mo.summary?.value || "").trim();
  const note = [String(order?.note || "").trim(), `${NOTE_MARK}\n${summary}`].filter(Boolean).join("\n\n");
  const up = await gql(admin, `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { message } } }`,
    { input: { id: orderGid, note: note.slice(0, 5000) } });
  if (up.orderUpdate.userErrors?.length) throw new Error(JSON.stringify(up.orderUpdate.userErrors));

  const tags = String(mo.tags?.value || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tags.length) {
    await gql(admin, `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: orderGid, tags });
  }
  await gql(admin, `mutation($id: ID!, $m: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $m) { userErrors { message } } }`,
    { id: mo.id, m: { fields: [{ key: "order", value: String(order?.name || order?.id || "") }] } });
  return { applied: true };
}
