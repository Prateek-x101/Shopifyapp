/**
 * Reviews: storage + sync
 *
 *  Source of truth : Shopify metaobject type `vw_review` (lives in the store forever)
 *  Fast index      : Prisma `Review` table (pagination / filters for 10,000+ reviews)
 *  Storefront SSR  : product metafield `vw_reviews.summary` (avg, counts, top reviews)
 */
import prisma from "../db.server";

export const REVIEW_TYPE = "vw_review";
export const SUMMARY_NS = "vw_reviews";
export const SUMMARY_KEY = "summary";
import { SOURCES, STATUSES } from "./reviews.shared";
export { SOURCES, STATUSES };
const TOP_IN_SUMMARY = 6;

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

export type ReviewImage = { id: string; url: string; alt?: string };
export type ReviewReply = { id: string; author: string; text: string; isStore: boolean; createdAt: string };
export type ReviewInput = {
  productId: string;
  rating: number;
  title?: string | null;
  body: string;
  author: string;
  location?: string | null;
  status: string;
  verified?: boolean;
  source?: string;
  orderId?: string | null;
  images?: ReviewImage[];
  replies?: ReviewReply[];
  helpful?: number;
  featured?: boolean;
  createdAt?: string;
};

export async function gql<T = any>(admin: Admin, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json: any = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data as T;
}

const productGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`);
const productNum = (gid: string) => gid.split("/").pop() as string;

/* ───────────────────────── definitions (idempotent) ───────────────────────── */
export async function ensureDefinitions(admin: Admin) {
  const existing = await gql(admin, `{ metaobjectDefinitionByType(type: "${REVIEW_TYPE}") { id } }`);
  if (!existing.metaobjectDefinitionByType) {
    const choices = (xs: readonly string[]) => [{ name: "choices", value: JSON.stringify(xs) }];
    const r = await gql(admin, `mutation($d: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $d) { metaobjectDefinition { id } userErrors { field message } } }`, {
      d: {
        name: "Review",
        type: REVIEW_TYPE,
        displayNameKey: "author",
        access: { storefront: "PUBLIC_READ" },
        description: "Customer review (managed by the Vesture Studio app).",
        fieldDefinitions: [
          { key: "product", name: "Product", type: "product_reference", required: true },
          { key: "rating", name: "Rating", type: "number_integer", required: true, validations: [{ name: "min", value: "1" }, { name: "max", value: "5" }] },
          { key: "title", name: "Title", type: "single_line_text_field" },
          { key: "body", name: "Review", type: "multi_line_text_field", required: true },
          { key: "author", name: "Name", type: "single_line_text_field", required: true },
          { key: "location", name: "City", type: "single_line_text_field" },
          { key: "images", name: "Photos", type: "list.file_reference" },
          { key: "status", name: "Status", type: "single_line_text_field", validations: choices(STATUSES) },
          { key: "verified", name: "Verified buyer", type: "boolean" },
          { key: "source", name: "Source", type: "single_line_text_field", validations: choices(SOURCES) },
          { key: "order_id", name: "Order", type: "single_line_text_field" },
          { key: "replies", name: "Replies", type: "json" },
          { key: "helpful", name: "Helpful votes", type: "number_integer" },
          { key: "featured", name: "Pinned", type: "boolean" },
          { key: "created", name: "Date", type: "date_time" },
        ],
      },
    });
    const errs = r.metaobjectDefinitionCreate.userErrors;
    if (errs?.length) throw new Error("Review definition: " + JSON.stringify(errs));
  }

  const mf = await gql(admin, `{ metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: "${SUMMARY_NS}", key: "${SUMMARY_KEY}") { nodes { id } } }`);
  if (!mf.metafieldDefinitions.nodes.length) {
    await gql(admin, `mutation($d: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { message } } }`, {
      d: {
        name: "Reviews summary",
        namespace: SUMMARY_NS,
        key: SUMMARY_KEY,
        ownerType: "PRODUCT",
        type: "json",
        description: "Written by the Vesture Studio app. Rating, counts and top reviews for the product page.",
        access: { storefront: "PUBLIC_READ" },
      },
    });
  }
}

/* ───────────────────────── metaobject <-> review ───────────────────────── */
function toFields(r: ReviewInput) {
  const f: { key: string; value: string }[] = [
    { key: "product", value: productGid(r.productId) },
    { key: "rating", value: String(Math.min(5, Math.max(1, Math.round(r.rating)))) },
    { key: "title", value: r.title || "" },
    { key: "body", value: r.body },
    { key: "author", value: r.author },
    { key: "location", value: r.location || "" },
    { key: "images", value: JSON.stringify((r.images || []).map((i) => i.id)) },
    { key: "status", value: r.status },
    { key: "verified", value: String(!!r.verified) },
    { key: "source", value: r.source || "Website" },
    { key: "order_id", value: r.orderId || "" },
    { key: "replies", value: JSON.stringify(r.replies || []) },
    { key: "helpful", value: String(r.helpful || 0) },
    { key: "featured", value: String(!!r.featured) },
    { key: "created", value: r.createdAt || new Date().toISOString() },
  ];
  return f;
}

const MO_FIELDS = `id updatedAt fields { key value
  references(first: 10) { nodes { ... on MediaImage { id alt image { url } } } } }`;

function fromMetaobject(shop: string, m: any) {
  const get = (k: string) => m.fields.find((f: any) => f.key === k);
  const val = (k: string) => get(k)?.value ?? null;
  const imgs: ReviewImage[] = (get("images")?.references?.nodes || [])
    .filter((n: any) => n?.image?.url)
    .map((n: any) => ({ id: n.id, url: n.image.url, alt: n.alt || "" }));
  let replies: ReviewReply[] = [];
  try { replies = JSON.parse(val("replies") || "[]") || []; } catch { replies = []; }
  return {
    id: m.id as string,
    shop,
    productId: productNum(val("product") || ""),
    rating: parseInt(val("rating") || "5", 10),
    title: val("title") || null,
    body: val("body") || "",
    author: val("author") || "Customer",
    location: val("location") || null,
    status: val("status") || "pending",
    verified: val("verified") === "true",
    source: val("source") || "Website",
    orderId: val("order_id") || null,
    images: JSON.stringify(imgs),
    replies: JSON.stringify(replies),
    helpful: parseInt(val("helpful") || "0", 10),
    featured: val("featured") === "true",
    hasMedia: imgs.length > 0,
    createdAt: new Date(val("created") || m.updatedAt),
  };
}

async function upsertIndex(row: ReturnType<typeof fromMetaobject>) {
  const { id, ...rest } = row;
  await prisma.review.upsert({ where: { id }, create: row, update: rest });
}

/* ───────────────────────── CRUD ───────────────────────── */
export async function createReview(admin: Admin, shop: string, input: ReviewInput) {
  const d = await gql(admin, `mutation($m: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $m) { metaobject { ${MO_FIELDS} } userErrors { field message } } }`, {
    m: { type: REVIEW_TYPE, fields: toFields(input) },
  });
  const errs = d.metaobjectCreate.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  const row = fromMetaobject(shop, d.metaobjectCreate.metaobject);
  await upsertIndex(row);
  await recomputeSummary(admin, shop, row.productId);
  return row;
}

export async function updateReview(admin: Admin, shop: string, id: string, input: ReviewInput) {
  const before = await prisma.review.findUnique({ where: { id } });
  const d = await gql(admin, `mutation($id: ID!, $m: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $m) { metaobject { ${MO_FIELDS} } userErrors { field message } } }`, {
    id, m: { fields: toFields(input) },
  });
  const errs = d.metaobjectUpdate.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  const row = fromMetaobject(shop, d.metaobjectUpdate.metaobject);
  await upsertIndex(row);
  await recomputeSummary(admin, shop, row.productId);
  if (before && before.productId !== row.productId) await recomputeSummary(admin, shop, before.productId);
  return row;
}

/** Small patch (status, featured, helpful, replies) without re-sending everything from the UI. */
export async function patchReview(admin: Admin, shop: string, id: string, patch: Partial<ReviewInput>) {
  const cur = await prisma.review.findUnique({ where: { id } });
  if (!cur) throw new Error("Review not found");
  const merged: ReviewInput = {
    productId: cur.productId, rating: cur.rating, title: cur.title, body: cur.body, author: cur.author,
    location: cur.location, status: cur.status, verified: cur.verified, source: cur.source, orderId: cur.orderId,
    images: JSON.parse(cur.images), replies: JSON.parse(cur.replies), helpful: cur.helpful, featured: cur.featured,
    createdAt: cur.createdAt.toISOString(), ...patch,
  };
  return updateReview(admin, shop, id, merged);
}

export async function deleteReview(admin: Admin, shop: string, id: string) {
  const cur = await prisma.review.findUnique({ where: { id } });
  await gql(admin, `mutation($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { message } } }`, { id });
  await prisma.review.deleteMany({ where: { id } });
  if (cur) await recomputeSummary(admin, shop, cur.productId);
}

/* ───────────────────────── summary metafield ───────────────────────── */
export async function recomputeSummary(admin: Admin, shop: string, productId: string) {
  const where = { shop, productId, status: "published" };
  const [agg, groups, photos, top] = await Promise.all([
    prisma.review.aggregate({ where, _avg: { rating: true }, _count: true }),
    prisma.review.groupBy({ by: ["rating"], where, _count: true }),
    prisma.review.count({ where: { ...where, hasMedia: true } }),
    prisma.review.findMany({
      where,
      orderBy: [{ featured: "desc" }, { hasMedia: "desc" }, { rating: "desc" }, { createdAt: "desc" }],
      take: TOP_IN_SUMMARY,
    }),
  ]);
  const dist: Record<string, number> = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
  groups.forEach((g: any) => { dist[String(g.rating)] = g._count; });
  const summary = {
    v: 1,
    count: agg._count,
    avg: agg._count ? Math.round((agg._avg.rating || 0) * 10) / 10 : 0,
    dist,
    photos,
    updated: new Date().toISOString(),
    top: top.map(publicReview),
  };
  await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`, {
    m: [{ ownerId: productGid(productId), namespace: SUMMARY_NS, key: SUMMARY_KEY, type: "json", value: JSON.stringify(summary) }],
  });
  return summary;
}

/** Shape sent to the storefront: no order ids, no internal fields. */
export function publicReview(r: any) {
  const replies: ReviewReply[] = typeof r.replies === "string" ? JSON.parse(r.replies) : r.replies || [];
  const images: ReviewImage[] = typeof r.images === "string" ? JSON.parse(r.images) : r.images || [];
  return {
    id: r.id.split("/").pop(),
    rating: r.rating,
    title: r.title || "",
    body: r.body,
    author: r.author,
    location: r.location || "",
    verified: r.verified,
    images: images.map((i) => ({ url: i.url, alt: i.alt || "" })),
    replies: replies.map((x) => ({ author: x.author, text: x.text, isStore: x.isStore, createdAt: x.createdAt })),
    helpful: r.helpful,
    date: new Date(r.createdAt).toISOString(),
  };
}

/* ───────────────────────── full resync ───────────────────────── */
export async function resyncAll(admin: Admin, shop: string) {
  let after: string | null = null;
  const seen = new Set<string>();
  const products = new Set<string>();
  do {
    const d: any = await gql(admin, `query($after: String) {
      metaobjects(type: "${REVIEW_TYPE}", first: 100, after: $after) {
        pageInfo { hasNextPage endCursor } nodes { ${MO_FIELDS} } } }`, { after });
    for (const m of d.metaobjects.nodes) {
      const row = fromMetaobject(shop, m);
      await upsertIndex(row);
      seen.add(row.id);
      products.add(row.productId);
    }
    after = d.metaobjects.pageInfo.hasNextPage ? d.metaobjects.pageInfo.endCursor : null;
  } while (after);
  const stale = await prisma.review.findMany({ where: { shop }, select: { id: true, productId: true } });
  for (const s of stale) if (!seen.has(s.id)) { await prisma.review.delete({ where: { id: s.id } }); products.add(s.productId); }
  for (const p of products) await recomputeSummary(admin, shop, p);
  return { reviews: seen.size, products: products.size };
}

/* ───────────────────────── photos upload ───────────────────────── */
export async function uploadImages(admin: Admin, files: File[]): Promise<ReviewImage[]> {
  const imgs = files.filter((f) => f && f.size > 0 && /^image\//.test(f.type)).slice(0, 6);
  if (!imgs.length) return [];
  const staged = await gql(admin, `mutation($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } } }`, {
    input: imgs.map((f) => ({ filename: f.name || "review.jpg", mimeType: f.type, resource: "IMAGE", httpMethod: "POST", fileSize: String(f.size) })),
  });
  const targets = staged.stagedUploadsCreate.stagedTargets;
  await Promise.all(targets.map(async (t: any, i: number) => {
    const form = new FormData();
    t.parameters.forEach((p: any) => form.append(p.name, p.value));
    form.append("file", imgs[i]);
    const up = await fetch(t.url, { method: "POST", body: form });
    if (!up.ok) throw new Error("Photo upload failed");
  }));
  const created = await gql(admin, `mutation($files: [FileCreateInput!]!) {
    fileCreate(files: $files) { files { id alt } userErrors { message } } }`, {
    files: targets.map((t: any) => ({ originalSource: t.resourceUrl, contentType: "IMAGE", alt: "Customer review photo" })),
  });
  const ids: string[] = created.fileCreate.files.map((f: any) => f.id);
  // wait until Shopify has processed the images (usually 1-3 s)
  for (let attempt = 0; attempt < 12; attempt++) {
    const d = await gql(admin, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id alt fileStatus image { url } } } }`, { ids });
    const ready = d.nodes.filter((n: any) => n?.image?.url);
    if (ready.length === ids.length) return ready.map((n: any) => ({ id: n.id, url: n.image.url, alt: n.alt || "" }));
    await new Promise((r) => setTimeout(r, 1000));
  }
  return ids.map((id) => ({ id, url: "", alt: "" }));
}

/* ───────────────────────── queries for the admin UI ───────────────────────── */
export async function productStats(shop: string) {
  const rows = await prisma.review.groupBy({
    by: ["productId", "status"],
    where: { shop },
    _count: true,
    _avg: { rating: true },
  });
  const map: Record<string, { total: number; published: number; pending: number; avg: number; sum: number }> = {};
  rows.forEach((r: any) => {
    const m = (map[r.productId] ||= { total: 0, published: 0, pending: 0, avg: 0, sum: 0 });
    m.total += r._count;
    if (r.status === "published") { m.published += r._count; m.sum += (r._avg.rating || 0) * r._count; }
    if (r.status === "pending") m.pending += r._count;
  });
  Object.values(map).forEach((m) => { m.avg = m.published ? Math.round((m.sum / m.published) * 10) / 10 : 0; });
  return map;
}

export async function listReviews(opts: {
  shop: string; productId: string; status?: string; rating?: number; media?: boolean; q?: string; page?: number; perPage?: number;
  sort?: "newest" | "oldest" | "highest" | "lowest" | "helpful";
}) {
  const perPage = Math.min(50, opts.perPage || 20);
  const page = Math.max(1, opts.page || 1);
  const where: any = { shop: opts.shop, productId: opts.productId };
  if (opts.status && opts.status !== "all") where.status = opts.status;
  if (opts.rating) where.rating = opts.rating;
  if (opts.media) where.hasMedia = true;
  if (opts.q) where.OR = [{ body: { contains: opts.q } }, { author: { contains: opts.q } }, { title: { contains: opts.q } }];
  const orderBy: any =
    opts.sort === "oldest" ? [{ createdAt: "asc" }] :
    opts.sort === "highest" ? [{ rating: "desc" }, { createdAt: "desc" }] :
    opts.sort === "lowest" ? [{ rating: "asc" }, { createdAt: "desc" }] :
    opts.sort === "helpful" ? [{ helpful: "desc" }, { createdAt: "desc" }] :
    [{ featured: "desc" }, { createdAt: "desc" }];
  const [total, rows] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({ where, orderBy, skip: (page - 1) * perPage, take: perPage }),
  ]);
  return { total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)), rows };
}
