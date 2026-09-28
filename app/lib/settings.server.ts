/**
 * App settings, stored on the shop (metafield vw_reviews.settings, JSON) so they live in Shopify
 * and the theme can read the public parts (Google client id, on/off switch) in Liquid.
 *
 *   { google_login: boolean, google_client_id: string }
 */
import { gql } from "./reviews.server";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

export const SETTINGS_NS = "vw_reviews";
export const SETTINGS_KEY = "settings";

export type AppSettings = {
  google_login: boolean;
  google_client_id: string;
};

export async function ensureSettingsDefinition(admin: Admin) {
  const d = await gql(admin, `{ metafieldDefinitions(first: 5, ownerType: SHOP, namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { nodes { id } } }`);
  if (d.metafieldDefinitions.nodes.length) return;
  await gql(admin, `mutation($d: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { message } } }`, {
    d: {
      name: "Reviews app settings",
      namespace: SETTINGS_NS,
      key: SETTINGS_KEY,
      ownerType: "SHOP",
      type: "json",
      description: "Written by the Vesture Studio app (Settings page). Read by the review widget.",
      access: { storefront: "PUBLIC_READ" },
    },
  });
}

export async function getSettings(admin: Admin): Promise<AppSettings & { shopId: string }> {
  const d = await gql(admin, `{ shop { id metafield(namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { value } } }`);
  let v: Partial<AppSettings> = {};
  try { v = JSON.parse(d.shop.metafield?.value || "{}"); } catch { v = {}; }
  return {
    shopId: d.shop.id,
    google_login: !!v.google_login,
    google_client_id: String(v.google_client_id || "").trim(),
  };
}

export async function saveSettings(admin: Admin, next: AppSettings) {
  const { shopId } = await getSettings(admin);
  const value: AppSettings = {
    google_login: !!next.google_login && !!next.google_client_id.trim(),
    google_client_id: next.google_client_id.trim(),
  };
  const r = await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`, {
    m: [{ ownerId: shopId, namespace: SETTINGS_NS, key: SETTINGS_KEY, type: "json", value: JSON.stringify(value) }],
  });
  const errs = r.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  return value;
}
