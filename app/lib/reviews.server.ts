/**
 * Reviews: storage + sync
 *
 *  Source of truth : Shopify metaobject type `vw_review` (lives in the store forever)
 *  Fast index      : Prisma `Review` table (pagination / filters for 10,000+ reviews)
 *  Storefront SSR  : product metafield `vw_reviews.summary` (avg, counts, top reviews)
 *  Votes           : customer metafield `vw_reviews.votes` = { h: [review ids marked helpful], l: [comment/reply ids liked] }
 *                    (private, admin only). Counts live on the review metaobject (helpful, replies[].likeCount).
 */
import prisma from "../db.server";

export const REVIEW_TYPE = "vw_review";
export const SUMMARY_NS = "vw_reviews";
export const SUMMARY_KEY = "summary";
export const VOTES_NS = "vw_reviews";
export const VOTES_KEY = "votes";
import { SOURCES, STATUSES, countComments, normalizeComments } from "./reviews.shared";
import type { BulkComment, BulkItem, CommentFilter, ReviewComment } from "./reviews.shared";
export { SOURCES, STATUSES, countComments, normalizeComments };
export type { ReviewComment };
const TOP_IN_SUMMARY = 6;

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

export type ReviewImage = { id: string; url: string; alt?: string; kind?: "image" | "video"; poster?: string };
export type ReviewReply = ReviewComment;
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
  images?: ReviewImage[];               // photos and videos (kind: "video")
  avatar?: ReviewImage | null;          // reviewer picture
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

  // fields added after the first version
  const def = await gql(admin, `{ metaobjectDefinitionByType(type: "${REVIEW_TYPE}") { id fieldDefinitions { key } } }`);
  const keys = new Set((def.metaobjectDefinitionByType?.fieldDefinitions || []).map((f: any) => f.key));
  if (def.metaobjectDefinitionByType && !keys.has("avatar")) {
    await gql(admin, `mutation($id: ID!, $d: MetaobjectDefinitionUpdateInput!) {
      metaobjectDefinitionUpdate(id: $id, definition: $d) { metaobjectDefinition { id } userErrors { message } } }`, {
      id: def.metaobjectDefinitionByType.id,
      d: { fieldDefinitions: [{ create: { key: "avatar", name: "Reviewer picture", type: "file_reference", validations: [{ name: "file_type_options", value: '["Image"]' }] } }] },
    });
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

  const vd = await gql(admin, `{ metafieldDefinitions(first: 5, ownerType: CUSTOMER, namespace: "${VOTES_NS}", key: "${VOTES_KEY}") { nodes { id } } }`);
  if (!vd.metafieldDefinitions.nodes.length) {
    await gql(admin, `mutation($d: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { message } } }`, {
      d: {
        name: "Review votes",
        namespace: VOTES_NS,
        key: VOTES_KEY,
        ownerType: "CUSTOMER",
        type: "json",
        description: "Written by the Vesture Studio app. Reviews this customer marked helpful (h) and comments/replies they liked (l), so nobody can vote twice.",
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
    { key: "avatar", value: r.avatar?.id || "" },
  ];
  return f;
}

const MO_FIELDS = `id updatedAt fields { key value
  reference { ... on MediaImage { id image { url } } }
  references(first: 12) { nodes {
    ... on MediaImage { id alt image { url } }
    ... on Video { id alt sources { url mimeType } preview { image { url } } } } } }`;

function fromMetaobject(shop: string, m: any) {
  const get = (k: string) => m.fields.find((f: any) => f.key === k);
  const val = (k: string) => get(k)?.value ?? null;
  const imgs: ReviewImage[] = (get("images")?.references?.nodes || [])
    .map((n: any) => {
      if (n?.image?.url) return { id: n.id, url: n.image.url, alt: n.alt || "", kind: "image" as const };
      const src = (n?.sources || []).find((x: any) => /mp4/.test(x.mimeType || "")) || (n?.sources || [])[0];
      if (src?.url) return { id: n.id, url: src.url, alt: n.alt || "", kind: "video" as const, poster: n.preview?.image?.url || "" };
      return null;
    })
    .filter(Boolean) as ReviewImage[];
  const av = get("avatar")?.reference;
  const avatar = av?.image?.url ? { id: av.id, url: av.image.url } : null;
  let replies: ReviewComment[] = [];
  try { replies = normalizeComments(JSON.parse(val("replies") || "[]")); } catch { replies = []; }
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
    avatar: avatar ? JSON.stringify(avatar) : null,
    replies: JSON.stringify(replies),
    helpful: parseInt(val("helpful") || "0", 10),
    featured: val("featured") === "true",
    hasMedia: imgs.length > 0,
    ...commentState(replies),
    createdAt: new Date(val("created") || m.updatedAt),
  };
}

/** needsReply: some thread's latest message is from a customer. lastCommentAt: latest customer message. */
export function commentState(tree: ReviewComment[]) {
  let needsReply = false;
  let last: number | null = null;
  let count = 0;
  const walk = (n: ReviewComment, acc: ReviewComment[]) => {
    acc.push(n);
    (n.replies || []).forEach((c) => walk(c, acc));
  };
  for (const top of tree) {
    const nodes: ReviewComment[] = [];
    walk(top, nodes);
    count += nodes.length;
    const latest = nodes.reduce((a, b) => (Date.parse(b.date) > Date.parse(a.date) ? b : a));
    if (latest.type === "customer") needsReply = true;
    nodes.forEach((n) => {
      const t = Date.parse(n.date);
      if (n.type === "customer" && Number.isFinite(t) && (last === null || t > last)) last = t;
    });
  }
  return { needsReply, commentCount: count, lastCommentAt: last === null ? null : new Date(last) };
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

export async function updateReview(admin: Admin, shop: string, id: string, input: ReviewInput, opts: { skipSummary?: boolean } = {}) {
  const before = await prisma.review.findUnique({ where: { id } });
  const d = await gql(admin, `mutation($id: ID!, $m: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $m) { metaobject { ${MO_FIELDS} } userErrors { field message } } }`, {
    id, m: { fields: toFields(input) },
  });
  const errs = d.metaobjectUpdate.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  const row = fromMetaobject(shop, d.metaobjectUpdate.metaobject);
  await upsertIndex(row);
  if (opts.skipSummary) return row;
  await recomputeSummary(admin, shop, row.productId);
  if (before && before.productId !== row.productId) await recomputeSummary(admin, shop, before.productId);
  return row;
}

/** Small patch (status, featured, helpful, replies) without re-sending everything from the UI. */
export async function patchReview(admin: Admin, shop: string, id: string, patch: Partial<ReviewInput>, opts: { skipSummary?: boolean } = {}) {
  const cur = await prisma.review.findUnique({ where: { id } });
  if (!cur) throw new Error("Review not found");
  const merged: ReviewInput = {
    productId: cur.productId, rating: cur.rating, title: cur.title, body: cur.body, author: cur.author,
    location: cur.location, status: cur.status, verified: cur.verified, source: cur.source, orderId: cur.orderId,
    images: JSON.parse(cur.images), replies: JSON.parse(cur.replies), helpful: cur.helpful, featured: cur.featured,
    avatar: cur.avatar ? JSON.parse(cur.avatar) : null,
    createdAt: cur.createdAt.toISOString(), ...patch,
  };
  return updateReview(admin, shop, id, merged, opts);
}

export async function deleteReview(admin: Admin, shop: string, id: string, opts: { skipSummary?: boolean } = {}) {
  const cur = await prisma.review.findUnique({ where: { id } });
  await gql(admin, `mutation($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { message } } }`, { id });
  await prisma.review.deleteMany({ where: { id } });
  if (cur && !opts.skipSummary) await recomputeSummary(admin, shop, cur.productId);
}

/* ───────────────────────── webhook sync ─────────────────────────
   A review changed outside the app (Shopify admin, API, import): bring the index and summary in step. */
export async function syncOne(admin: Admin, shop: string, id: string) {
  const before = await prisma.review.findUnique({ where: { id }, select: { productId: true } });
  const d = await gql(admin, `query($id: ID!) { metaobject(id: $id) { type ${MO_FIELDS} } }`, { id });
  const m = d.metaobject;
  if (!m || m.type !== REVIEW_TYPE) {
    await removeFromIndex(admin, shop, id);
    return;
  }
  const row = fromMetaobject(shop, m);
  await upsertIndex(row);
  await recomputeSummary(admin, shop, row.productId);
  if (before && before.productId !== row.productId) await recomputeSummary(admin, shop, before.productId);
}

export async function removeFromIndex(admin: Admin, shop: string, id: string) {
  const before = await prisma.review.findUnique({ where: { id }, select: { productId: true } });
  if (!before) return;
  await prisma.review.deleteMany({ where: { id } });
  await recomputeSummary(admin, shop, before.productId);
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
  // Same data in the format of the storefront review widget (engine-review-widget):
  // engine_review.summary_v2 = { total_count, avg_rating, star_counts, preview_reviews, page_count }
  const preview = await prisma.review.findMany({
    where,
    orderBy: [{ featured: "desc" }, { hasMedia: "desc" }, { createdAt: "desc" }],
    take: LEGACY_PREVIEW,
  });
  const legacy = {
    total_count: agg._count,
    avg_rating: summary.avg,
    star_counts: dist,
    photo_count: photos,
    page_count: 0, // the widget loads the rest page by page from the app proxy
    preview_reviews: preview.map((r) => legacyReview(r)),
    updated_at: summary.updated,
  };
  await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`, {
    m: [
      { ownerId: productGid(productId), namespace: SUMMARY_NS, key: SUMMARY_KEY, type: "json", value: JSON.stringify(summary) },
      { ownerId: productGid(productId), namespace: LEGACY_NS, key: LEGACY_KEY, type: "json", value: JSON.stringify(legacy) },
    ],
  });
  return summary;
}

/* ───────────────────────── votes (customer metafield) ───────────────────────── */
export type VoteList = { h: string[]; l: string[] };
const customerGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`);

/** The customer's own votes. First read after the update also carries over votes the old version kept in the database. */
export async function getVotes(admin: Admin, shop: string, customerId: string): Promise<VoteList> {
  const d = await gql(admin, `query($id: ID!) { customer(id: $id) { metafield(namespace: "${VOTES_NS}", key: "${VOTES_KEY}") { value } } }`, {
    id: customerGid(customerId),
  });
  const raw = d.customer?.metafield?.value;
  if (raw) {
    try {
      const v = JSON.parse(raw);
      return { h: Array.isArray(v.h) ? v.h.map(String) : [], l: Array.isArray(v.l) ? v.l.map(String) : [] };
    } catch {
      /* fall through to a fresh list */
    }
  }
  const old = await prisma.vote.findMany({ where: { shop, customerId }, select: { kind: true, targetId: true } });
  const v: VoteList = {
    h: old.filter((x) => x.kind === "helpful").map((x) => x.targetId),
    l: old.filter((x) => x.kind === "like").map((x) => x.targetId),
  };
  if (old.length) await saveVotes(admin, customerId, v);
  return v;
}

async function saveVotes(admin: Admin, customerId: string, v: VoteList) {
  const r = await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`, {
    m: [{ ownerId: customerGid(customerId), namespace: VOTES_NS, key: VOTES_KEY, type: "json", value: JSON.stringify(v) }],
  });
  const errs = r.metafieldsSet.userErrors;
  if (errs?.length) throw new Error("Could not save vote: " + errs.map((e: any) => e.message).join(", "));
}

/* ───────────────────────── storefront widget format ───────────────────────── */
export const LEGACY_NS = "engine_review";
export const LEGACY_KEY = "summary_v2"; // v1 holds the old generated data and is left untouched
const LEGACY_PREVIEW = 10;

/** A review in the shape the storefront widget renders (name, text, comments[], helpfulCount…). */
export function legacyReview(r: any, helpfulByCustomerIds: string[] = [], likedBy: Record<string, string[]> = {}) {
  const images: ReviewImage[] = typeof r.images === "string" ? JSON.parse(r.images) : r.images || [];
  const comments = normalizeComments(typeof r.replies === "string" ? JSON.parse(r.replies) : r.replies || []);
  const visible = (c: ReviewComment) => c.status === "approved";
  const mapC = (c: ReviewComment): any => ({
    id: c.id,
    name: c.name,
    avatar: c.avatar || null,
    text: c.text,
    date: c.date,
    type: c.type,
    status: c.status,
    verified: !!c.verified,
    likeCount: c.likeCount,
    likedByCustomerIds: likedBy[c.id] || [],
    parentCommentId: c.parentCommentId || null,
    replies: (c.replies || []).filter(visible).map(mapC),
  });
  let avatarUrl: string | null = null;
  try { avatarUrl = r.avatar ? (typeof r.avatar === "string" ? JSON.parse(r.avatar) : r.avatar)?.url || null : null; } catch { avatarUrl = null; }
  return {
    id: String(r.id).split("/").pop(),
    productId: `gid://shopify/Product/${r.productId}`,
    name: r.author,
    title: r.title || "",
    text: r.body,
    rating: r.rating,
    date: new Date(r.createdAt).toISOString(),
    location: r.location || "",
    verified: !!r.verified,
    status: "approved",
    sentiment: r.rating >= 4 ? "positive" : r.rating === 3 ? "neutral" : "negative",
    helpfulCount: r.helpful,
    likeCount: r.helpful,
    helpfulByCustomerIds,
    avatar: avatarUrl,
    images: images.filter((i) => i.url && i.kind !== "video").map((i) => i.url),
    videos: images.filter((i) => i.url && i.kind === "video").map((i) => i.url),
    comments: comments.filter(visible).map(mapC),
  };
}

/** Page of reviews for the widget. Page 1 = first 250, page N>1 = 10 reviews from (N-1)*10 (the widget's paging). */
export async function legacyPage(shop: string, productId: string, page: number, customerId = "", votes: VoteList | null = null) {
  const where = { shop, productId, status: "published" };
  const take = page <= 1 ? 250 : 10;
  const skip = page <= 1 ? 0 : (page - 1) * 10;
  const [total, rows] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({ where, orderBy: [{ featured: "desc" }, { createdAt: "desc" }], skip, take }),
  ]);
  const mine = customerId && votes ? votes : { h: [], l: [] };
  const liked: Record<string, string[]> = {};
  mine.l.forEach((id) => (liked[id] = [customerId]));
  return {
    success: true,
    reviews: rows.map((r) => legacyReview(r, mine.h.includes(r.id) ? [customerId] : [], liked)),
    count: rows.length,
    totalCount: total,
    pageCount: Math.max(1, Math.ceil(total / 10)),
    hasMore: skip + rows.length < total,
  };
}

/* ───────────────────────── comments, replies, votes ───────────────────────── */
function findNode(list: ReviewComment[], id: string): ReviewComment | null {
  for (const c of list) {
    if (c.id === id) return c;
    const hit = findNode(c.replies || [], id);
    if (hit) return hit;
  }
  return null;
}

function removeNode(list: ReviewComment[], id: string): boolean {
  const i = list.findIndex((c) => c.id === id);
  if (i >= 0) {
    list.splice(i, 1);
    return true;
  }
  return list.some((c) => removeNode(c.replies || [], id));
}

/** Add a comment on a review (parentId = null) or a reply under a comment/reply. */
export async function addComment(
  admin: Admin,
  shop: string,
  reviewId: string,
  input: {
    name: string; text: string; type: "store" | "customer"; customerId?: string | null; verified?: boolean; id?: string;
    avatar?: string | null; status?: "approved" | "pending";
  },
  parentId: string | null = null,
) {
  const cur = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!cur || cur.shop !== shop) throw new Error("Review not found");
  const tree = normalizeComments(JSON.parse(cur.replies));
  const safeId = input.id && /^[A-Za-z0-9_-]{3,40}$/.test(input.id) && !findNode(tree, input.id) ? input.id : null;
  const node: ReviewComment = {
    id: safeId || `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: input.name.slice(0, 60),
    text: input.text.slice(0, 2000),
    date: new Date().toISOString(),
    type: input.type,
    status: input.status || "approved",
    customerId: input.customerId || null,
    avatar: input.avatar || null,
    verified: !!input.verified,
    likeCount: 0,
    parentCommentId: parentId,
    replies: [],
  };
  if (parentId) {
    const parent = findNode(tree, parentId);
    if (!parent) throw new Error("Comment not found");
    (parent.replies ||= []).push(node);
  } else {
    tree.push(node);
  }
  await patchReview(admin, shop, reviewId, { replies: tree });
  return node;
}

/** Edit a comment/reply from the admin: text, name, picture, or hide/show it. */
export async function updateComment(
  admin: Admin,
  shop: string,
  reviewId: string,
  commentId: string,
  patch: { text?: string; name?: string; avatar?: string | null; status?: "approved" | "hidden"; likeCount?: number },
) {
  const cur = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!cur || cur.shop !== shop) throw new Error("Review not found");
  const tree = normalizeComments(JSON.parse(cur.replies));
  const node = findNode(tree, commentId);
  if (!node) throw new Error("Comment not found");
  if (patch.text !== undefined) node.text = patch.text.slice(0, 2000);
  if (patch.name !== undefined && patch.name.trim()) node.name = patch.name.trim().slice(0, 60);
  if (patch.avatar !== undefined) node.avatar = patch.avatar;
  if (patch.status) node.status = patch.status;
  if (patch.likeCount !== undefined && Number.isFinite(patch.likeCount)) node.likeCount = Math.max(0, Math.min(99999, Math.round(patch.likeCount)));
  await patchReview(admin, shop, reviewId, { replies: tree });
  return node;
}

export async function removeComment(admin: Admin, shop: string, reviewId: string, commentId: string) {
  const cur = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!cur || cur.shop !== shop) throw new Error("Review not found");
  const tree = normalizeComments(JSON.parse(cur.replies));
  removeNode(tree, commentId);
  await patchReview(admin, shop, reviewId, { replies: tree });
}

/** Helpful on a review: one vote per customer (kept on the customer), can be undone. */
export async function setHelpful(admin: Admin, shop: string, reviewId: string, customerId: string, liked: boolean) {
  const cur = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!cur || cur.shop !== shop || cur.status !== "published") throw new Error("Review not found");
  const v = await getVotes(admin, shop, customerId);
  const has = v.h.includes(reviewId);
  if (liked === has) return { liked, helpfulCount: cur.helpful };
  v.h = liked ? [...v.h, reviewId] : v.h.filter((x) => x !== reviewId);
  await saveVotes(admin, customerId, v);
  const count = Math.max(0, (cur.helpful || 0) + (liked ? 1 : -1));
  await patchReview(admin, shop, reviewId, { helpful: count });
  return { liked, helpfulCount: count };
}

/** Like on a comment or reply (kept on the customer). */
export async function setThreadLike(admin: Admin, shop: string, reviewId: string, targetId: string, customerId: string, liked: boolean) {
  const cur = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!cur || cur.shop !== shop) throw new Error("Review not found");
  const tree = normalizeComments(JSON.parse(cur.replies));
  const node = findNode(tree, targetId);
  if (!node) throw new Error("Comment not found");
  const v = await getVotes(admin, shop, customerId);
  const has = v.l.includes(targetId);
  if (liked === has) return { liked, likeCount: node.likeCount };
  v.l = liked ? [...v.l, targetId] : v.l.filter((x) => x !== targetId);
  await saveVotes(admin, customerId, v);
  node.likeCount = Math.max(0, (node.likeCount || 0) + (liked ? 1 : -1));
  await patchReview(admin, shop, reviewId, { replies: tree });
  return { liked, likeCount: node.likeCount };
}

/** Shape sent to the storefront: no order ids, no internal fields. */
export function publicReview(r: any) {
  const replies = normalizeComments(typeof r.replies === "string" ? JSON.parse(r.replies) : r.replies || []);
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
    replies: replies.filter((x) => x.status === "approved").map((x) => ({ author: x.name, text: x.text, isStore: x.type === "store", createdAt: x.date })),
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
/** Photos and videos (videos can take a little longer: Shopify processes them). */
export async function uploadMedia(admin: Admin, files: File[]): Promise<ReviewImage[]> {
  const list = files.filter((f) => f && f.size > 0 && /^(image|video)\//.test(f.type)).slice(0, 10);
  const imgs = list.filter((f) => f.type.startsWith("image/"));
  const vids = list.filter((f) => f.type.startsWith("video/")).slice(0, 3);
  const out: ReviewImage[] = (await uploadImages(admin, imgs)).map((i) => ({ ...i, kind: "image" as const }));
  if (!vids.length) return out;
  if (vids.some((v) => v.size > 100 * 1024 * 1024)) throw new Error("Each video must be under 100 MB");
  const staged = await gql(admin, `mutation($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } } }`, {
    input: vids.map((f) => ({ filename: f.name || "review.mp4", mimeType: f.type, resource: "VIDEO", httpMethod: "POST", fileSize: String(f.size) })),
  });
  const targets = staged.stagedUploadsCreate.stagedTargets;
  await Promise.all(targets.map(async (t: any, i: number) => {
    const form = new FormData();
    t.parameters.forEach((p: any) => form.append(p.name, p.value));
    form.append("file", vids[i]);
    const up = await fetch(t.url, { method: "POST", body: form });
    if (!up.ok) throw new Error("Video upload failed");
  }));
  const created = await gql(admin, `mutation($files: [FileCreateInput!]!) {
    fileCreate(files: $files) { files { id } userErrors { message } } }`, {
    files: targets.map((t: any) => ({ originalSource: t.resourceUrl, contentType: "VIDEO", alt: "Customer review video" })),
  });
  const ids: string[] = created.fileCreate.files.map((f: any) => f.id);
  for (let attempt = 0; attempt < 40; attempt++) {
    const d = await gql(admin, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Video { id fileStatus sources { url mimeType } preview { image { url } } } } }`, { ids });
    const ready = d.nodes.filter((n: any) => n?.sources?.length);
    if (ready.length === ids.length) {
      return out.concat(ready.map((n: any) => {
        const src = n.sources.find((x: any) => /mp4/.test(x.mimeType || "")) || n.sources[0];
        return { id: n.id, url: src.url, alt: "", kind: "video" as const, poster: n.preview?.image?.url || "" };
      }));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // still processing: keep the file ids; the next sync (webhook) fills in the URLs
  return out.concat(ids.map((id) => ({ id, url: "", alt: "", kind: "video" as const })));
}

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
export type ProductStat = {
  total: number; published: number; pending: number; avg: number; sum: number;
  needsReply: number; comments: number; lastReviewAt: string | null; lastCommentAt: string | null;
};

export async function productStats(shop: string) {
  const [rows, dates, attention] = await Promise.all([
    prisma.review.groupBy({ by: ["productId", "status"], where: { shop }, _count: true, _avg: { rating: true } }),
    prisma.review.groupBy({
      by: ["productId"], where: { shop }, _max: { createdAt: true, lastCommentAt: true }, _sum: { commentCount: true },
    }),
    prisma.review.groupBy({ by: ["productId"], where: { shop, needsReply: true }, _count: true }),
  ]);
  const map: Record<string, ProductStat> = {};
  const get = (id: string) =>
    (map[id] ||= { total: 0, published: 0, pending: 0, avg: 0, sum: 0, needsReply: 0, comments: 0, lastReviewAt: null, lastCommentAt: null });
  rows.forEach((r: any) => {
    const m = get(r.productId);
    m.total += r._count;
    if (r.status === "published") { m.published += r._count; m.sum += (r._avg.rating || 0) * r._count; }
    if (r.status === "pending") m.pending += r._count;
  });
  dates.forEach((d: any) => {
    const m = get(d.productId);
    m.lastReviewAt = d._max.createdAt ? new Date(d._max.createdAt).toISOString() : null;
    m.lastCommentAt = d._max.lastCommentAt ? new Date(d._max.lastCommentAt).toISOString() : null;
    m.comments = d._sum.commentCount || 0;
  });
  attention.forEach((a: any) => { get(a.productId).needsReply = a._count; });
  Object.values(map).forEach((m) => { m.avg = m.published ? Math.round((m.sum / m.published) * 10) / 10 : 0; });
  return map;
}

/** Every comment and reply across the store, newest first (for the Comments page). */
export async function listComments(opts: { shop: string; productId?: string; needsReply?: boolean; q?: string; page?: number; perPage?: number }) {
  const where: any = { shop: opts.shop, commentCount: { gt: 0 } };
  if (opts.productId) where.productId = opts.productId;
  if (opts.needsReply) where.needsReply = true;
  const rows = await prisma.review.findMany({
    where,
    orderBy: [{ lastCommentAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    take: 500,
    select: { id: true, productId: true, author: true, body: true, rating: true, replies: true, needsReply: true },
  });
  type Item = {
    reviewId: string; productId: string; reviewAuthor: string; reviewBody: string; rating: number;
    node: ReviewComment; parentName: string | null; depth: number; awaiting: boolean;
  };
  const items: Item[] = [];
  const q = (opts.q || "").toLowerCase();
  for (const r of rows) {
    const tree = normalizeComments(JSON.parse(r.replies));
    for (const top of tree) {
      const nodes: { n: ReviewComment; parent: string | null; depth: number }[] = [];
      const walk = (n: ReviewComment, parent: string | null, depth: number) => {
        nodes.push({ n, parent, depth });
        (n.replies || []).forEach((c) => walk(c, n.name, depth + 1));
      };
      walk(top, null, 0);
      const latest = nodes.reduce((a, b) => (Date.parse(b.n.date) > Date.parse(a.n.date) ? b : a));
      for (const x of nodes) {
        const awaiting = x === latest && x.n.type === "customer";
        if (opts.needsReply && !awaiting) continue;
        if (q && !`${x.n.name} ${x.n.text}`.toLowerCase().includes(q)) continue;
        items.push({
          reviewId: r.id, productId: r.productId, reviewAuthor: r.author, reviewBody: r.body, rating: r.rating,
          node: x.n, parentName: x.parent, depth: x.depth, awaiting,
        });
      }
    }
  }
  items.sort((a, b) => Date.parse(b.node.date) - Date.parse(a.node.date));
  const perPage = opts.perPage || 25;
  const page = Math.max(1, opts.page || 1);
  return {
    total: items.length,
    page,
    pages: Math.max(1, Math.ceil(items.length / perPage)),
    items: items.slice((page - 1) * perPage, page * perPage),
  };
}

export type ReviewFilters = {
  shop: string; productId: string; status?: string; rating?: number; media?: boolean; q?: string;
  customer?: boolean;               // written by shoppers in the widget (not added/imported by the store)
  from?: string; to?: string;       // YYYY-MM-DD, inclusive (India time)
  flagged?: boolean;                // has comments waiting for approval (same as comments: "waiting")
  comments?: CommentFilter;
};

function commentWhere(f: CommentFilter | undefined): any[] {
  const has = (s: string) => ({ replies: { contains: s } });
  switch (f) {
    case "with": return [{ commentCount: { gt: 0 } }];
    case "without": return [{ commentCount: 0 }];
    case "replies": return [has('"replies":[{')];              // some comment has a reply under it
    case "store": return [has('"type":"store"')];
    case "nostore": return [{ commentCount: { gt: 0 } }, { NOT: has('"type":"store"') }];
    case "needs": return [{ needsReply: true }];
    case "waiting": return [has('"status":"pending"')];
    default: return [];
  }
}

function reviewWhere(opts: ReviewFilters) {
  const where: any = { shop: opts.shop, productId: opts.productId };
  if (opts.status && opts.status !== "all") where.status = opts.status;
  if (opts.rating) where.rating = opts.rating;
  if (opts.media) where.hasMedia = true;
  if (opts.customer) where.source = "Website";
  const and = commentWhere(opts.flagged ? "waiting" : opts.comments);
  if (and.length) where.AND = and;
  const day = (s: string | undefined, end: boolean) =>
    s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T${end ? "23:59:59.999" : "00:00:00"}+05:30`) : null;
  const from = day(opts.from, false);
  const to = day(opts.to, true);
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  if (opts.q) {
    const c = { contains: opts.q, mode: "insensitive" as const };
    where.OR = [{ body: c }, { author: c }, { title: c }, { location: c }];
  }
  return where;
}

/** How many of this product's reviews each "Comments" filter option would show. */
export async function commentFilterCounts(shop: string, productId: string) {
  const keys: CommentFilter[] = ["with", "without", "replies", "store", "nostore", "needs", "waiting"];
  const counts = await Promise.all(keys.map((k) => prisma.review.count({ where: reviewWhere({ shop, productId, comments: k }) })));
  return Object.fromEntries(keys.map((k, i) => [k, counts[i]])) as Record<CommentFilter, number>;
}

/** Every review id that matches the filters (for "select all" bulk actions). */
export async function reviewIdsMatching(opts: ReviewFilters, limit = 1000) {
  const rows = await prisma.review.findMany({ where: reviewWhere(opts), select: { id: true }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => r.id);
}

export async function listReviews(opts: ReviewFilters & {
  page?: number; perPage?: number; sort?: "newest" | "oldest" | "highest" | "lowest" | "helpful";
}) {
  const perPage = Math.min(50, opts.perPage || 20);
  const page = Math.max(1, opts.page || 1);
  const where = reviewWhere(opts);
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

/* ───────────────────────── bulk upload ───────────────────────── */
/** Photos by URL → Shopify files. Returns url → file (only the ones Shopify could fetch). */
async function filesFromUrls(admin: Admin, urls: string[]) {
  const out = new Map<string, ReviewImage>();
  const ids = new Map<string, string>();
  for (let i = 0; i < urls.length; i += 5) {
    await Promise.all(urls.slice(i, i + 5).map(async (url) => {
      try {
        const d = await gql(admin, `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id } userErrors { message } } }`, {
          files: [{ originalSource: url, contentType: "IMAGE", alt: "Customer review photo" }],
        });
        const id = d.fileCreate.files?.[0]?.id;
        if (id) ids.set(id, url);
      } catch { /* skip this photo */ }
    }));
  }
  let waiting = [...ids.keys()];
  for (let attempt = 0; attempt < 20 && waiting.length; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < waiting.length; i += 50) {
      const d = await gql(admin, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id fileStatus image { url } } } }`, { ids: waiting.slice(i, i + 50) });
      d.nodes.forEach((n: any) => {
        if (n?.image?.url) out.set(ids.get(n.id)!, { id: n.id, url: n.image.url, alt: "", kind: "image" });
        if (n?.image?.url || n?.fileStatus === "FAILED") ids.delete(n.id);
      });
    }
    waiting = [...ids.keys()];
  }
  return out;
}

/** Bulk-upload comments → the thread the widget shows. Missing dates fall a few hours after the message above. */
function bulkThread(list: BulkComment[] | undefined, after: number, shopName: string, avatars: Map<string, ReviewImage>, parent: string | null): ReviewComment[] {
  let prev = after;
  return (list || []).map((c) => {
    const given = c.date ? Date.parse(c.date) : NaN;
    const t = Number.isFinite(given) ? given : Math.min(Date.now(), prev + (2 + Math.random() * 20) * 3600000);
    prev = Math.max(prev, t);
    const id = `c_${t.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    return {
      id,
      name: c.store ? c.name || shopName : c.name,
      text: c.text,
      date: new Date(t).toISOString(),
      type: c.store ? "store" : "customer",
      status: "approved",
      avatar: c.avatar ? avatars.get(c.avatar)?.url || null : null,
      customerId: null,
      verified: false,
      likeCount: c.likes || 0,
      parentCommentId: parent,
      replies: bulkThread(c.replies, t, shopName, avatars, id),
    } as ReviewComment;
  });
}

/** Creates many reviews at once (max 200 per upload); the product summary is recomputed once at the end. */
export async function importReviews(
  admin: Admin,
  shop: string,
  productId: string,
  items: BulkItem[],
  opts: { status: string; verified: boolean; spreadDays: number; shopName?: string },
) {
  await ensureDefinitions(admin);
  const list = items.slice(0, 200);
  const commentAvatars = (cs: BulkComment[] = []): string[] => cs.flatMap((c) => [c.avatar || "", ...commentAvatars(c.replies)]);
  const urls = [...new Set(list.flatMap((i) => [...(i.images || []), i.avatar || "", ...commentAvatars(i.comments)]).filter(Boolean))];
  const files = urls.length ? await filesFromUrls(admin, urls) : new Map<string, ReviewImage>();
  const now = Date.now();
  const failed: string[] = [];
  let created = 0;
  let photoMisses = 0;

  for (let i = 0; i < list.length; i += 5) {
    await Promise.all(list.slice(i, i + 5).map(async (it) => {
      const images = (it.images || []).map((u) => files.get(u)).filter(Boolean) as ReviewImage[];
      photoMisses += (it.images || []).length - images.length;
      const av = it.avatar ? files.get(it.avatar) : undefined;
      const date = it.date || (opts.spreadDays > 0 ? new Date(now - Math.random() * opts.spreadDays * 86400000).toISOString() : new Date().toISOString());
      const input: ReviewInput = {
        productId,
        rating: it.rating,
        title: it.title || null,
        body: it.body,
        author: it.author,
        location: it.location || null,
        status: opts.status,
        verified: it.verified ?? opts.verified,
        source: "Import",
        images,
        avatar: av ? { id: av.id, url: av.url } : null,
        replies: bulkThread(it.comments, Date.parse(date), opts.shopName || "Store", files, null),
        helpful: it.helpful || 0,
        featured: false,
        createdAt: date,
      };
      try {
        const d = await gql(admin, `mutation($m: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $m) { metaobject { ${MO_FIELDS} } userErrors { field message } } }`, {
          m: { type: REVIEW_TYPE, fields: toFields(input) },
        });
        const errs = d.metaobjectCreate.userErrors;
        if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
        await upsertIndex(fromMetaobject(shop, d.metaobjectCreate.metaobject));
        created++;
      } catch (e: any) {
        failed.push(`${it.author}: ${e.message || "failed"}`);
      }
    }));
  }
  if (created) await recomputeSummary(admin, shop, productNum(productGid(productId)));
  return { created, failed, skipped: items.length - list.length, photoMisses };
}
