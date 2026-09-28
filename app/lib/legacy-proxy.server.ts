/**
 * Storefront review widget API (engine-review-widget / review-widget.js).
 *
 *   GET  /apps/engine?action=get_reviews_page&productId=123&page=1
 *   GET  /apps/engine?action=get_review_stats&productId=123
 *   GET  /apps/engine?action=sales_popup_feed
 *   POST /apps/engine   JSON { actionType: submit_review | submit_comment | submit_reply | set_helpful | set_thread_like, ... }
 *
 * The widget sends the logged-in customer through Shopify's signed proxy parameter `logged_in_customer_id`.
 */
import prisma from "../db.server";
import {
  addComment,
  createReview,
  gql,
  legacyPage,
  getVotes,
  setHelpful,
  setThreadLike,
  uploadImages,
} from "./reviews.server";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });

const hits = new Map<string, number[]>();
export function limited(key: string, max = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

const num = (v: unknown) => String(v ?? "").split("/").pop()!.replace(/\D/g, "");
const reviewGid = (id: unknown) => `gid://shopify/Metaobject/${num(id)}`;

export async function legacyGet(shop: string, sp: URLSearchParams, admin: Admin | null = null) {
  const action = sp.get("action") || "";
  const productId = num(sp.get("productId") || sp.get("product"));

  if (action === "get_reviews_page") {
    if (!productId) return json({ success: false, error: "productId required" }, { status: 400 });
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
    const customerId = num(sp.get("logged_in_customer_id"));
    // a logged-in shopper also gets their own helpful/like marks, so that answer must not be shared
    let votes = null;
    if (customerId && admin) {
      try { votes = await getVotes(admin, shop, customerId); } catch { votes = null; }
    }
    return json(await legacyPage(shop, productId, page, customerId, votes), {
      headers: { "Cache-Control": customerId ? "private, no-store" : "public, max-age=30" },
    });
  }

  if (action === "get_review_stats") {
    if (!productId) return json({ success: false, error: "productId required" }, { status: 400 });
    const [approvedCount, pendingCount] = await Promise.all([
      prisma.review.count({ where: { shop, productId, status: "published" } }),
      prisma.review.count({ where: { shop, productId, status: "pending" } }),
    ]);
    return json({ success: true, approvedCount, pendingCount, totalCount: approvedCount }, { headers: { "Cache-Control": "public, max-age=30" } });
  }

  if (action === "sales_popup_feed") {
    // The old "recent purchases" feed is not part of this app: tell the popup to stay quiet.
    return json({ success: true, events: [], pollAfterSeconds: 900 }, { headers: { "Cache-Control": "public, max-age=300" } });
  }

  return json({ success: false, error: "Unknown action" }, { status: 404 });
}

/** Customer's orders that contain the product. */
async function ordersWithProduct(admin: Admin, customerId: string, productId: string) {
  const d = await gql(admin, `query($id: ID!) { customer(id: $id) { displayName orders(first: 50, reverse: true) {
      nodes { name displayFulfillmentStatus lineItems(first: 50) { nodes { product { id } } } } } } }`, {
    id: `gid://shopify/Customer/${customerId}`,
  });
  const orders = (d.customer?.orders?.nodes || []).filter((o: any) =>
    o.lineItems.nodes.some((li: any) => li.product?.id === `gid://shopify/Product/${productId}`),
  );
  return { name: d.customer?.displayName as string | undefined, orders };
}

function dataUrlToFile(dataUrl: string, i: number): File | null {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp|gif|heic));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
  const ext = m[1].split("/")[1].replace("jpeg", "jpg");
  return new File([buf], `review-${Date.now()}-${i}.${ext}`, { type: m[1] });
}

export async function legacyPost(admin: Admin, shop: string, sp: URLSearchParams, body: any, ip: string) {
  const actionType = String(body?.actionType || "");
  const customerId = num(sp.get("logged_in_customer_id"));
  const productId = num(body?.productId);

  /* ── new review ── */
  if (actionType === "submit_review") {
    if (limited(`r:${customerId || ip}`)) return json({ success: false, error: "Too many reviews. Please try again later." }, { status: 429 });
    const rating = parseInt(String(body.rating || "0"), 10);
    const text = String(body.text || "").trim().slice(0, 3000);
    let name = String(body.name || "").trim().slice(0, 60);
    if (!productId || !(rating >= 1 && rating <= 5) || text.length < 3) {
      return json({ success: false, error: "Please add a star rating and a few words." }, { status: 400 });
    }
    if (body.requireLoginToReview && !customerId) {
      return json({ success: false, error: "Please log in to write a review." }, { status: 401 });
    }
    let verified = false;
    let orderId: string | null = null;
    if (customerId) {
      try {
        const info = await ordersWithProduct(admin, customerId, productId);
        if (!name && info.name) name = info.name;
        const delivered = info.orders.find((o: any) => o.displayFulfillmentStatus === "FULFILLED");
        const hit = delivered || info.orders[0];
        if (body.requireDeliveredOrderForReview && !delivered) {
          return json({ success: false, error: "You can review this product after your order is delivered." }, { status: 403 });
        }
        if (hit) { verified = true; orderId = hit.name; }
      } catch {
        if (body.requireDeliveredOrderForReview) return json({ success: false, error: "Could not check your order. Please try again." }, { status: 503 });
      }
    }
    if (!name) return json({ success: false, error: "Please add your name." }, { status: 400 });

    const files = (Array.isArray(body.images) ? body.images : []).slice(0, 4).map(dataUrlToFile).filter(Boolean) as File[];
    let images: Awaited<ReturnType<typeof uploadImages>> = [];
    try { images = await uploadImages(admin, files); } catch { images = []; }

    await createReview(admin, shop, {
      productId, rating, body: text, author: name, status: "pending", verified, orderId, images, source: "Website",
      location: String(body.location || "").trim().slice(0, 60) || null,
    });
    return json({ success: true, status: "pending", persisted: true, message: "Thank you! Your review will appear after a quick check." });
  }

  /* ── comment on a review / reply to a comment ── */
  if (actionType === "submit_comment" || actionType === "submit_reply") {
    if (!customerId) return json({ success: false, error: "Please log in to reply." }, { status: 401 });
    if (limited(`c:${customerId}`, 20)) return json({ success: false, error: "Too many replies. Please wait a bit." }, { status: 429 });
    const text = String(body.text || "").trim();
    if (text.length < 1) return json({ success: false, error: "Write a reply first." }, { status: 400 });
    let verified = false;
    let name = String(body.name || "").trim();
    try {
      const info = await ordersWithProduct(admin, customerId, productId);
      verified = info.orders.length > 0;
      if (!name && info.name) name = info.name;
    } catch { /* not verified */ }
    const node = await addComment(
      admin, shop, reviewGid(body.reviewId),
      { name: name || "Customer", text, type: "customer", customerId, verified, id: body.clientId },
      actionType === "submit_reply" ? String(body.commentId || "") : null,
    );
    return json({ success: true, comment: node });
  }

  /* ── helpful on a review ── */
  if (actionType === "set_helpful") {
    if (!customerId) return json({ success: false, error: "Please log in to mark reviews as helpful." }, { status: 401 });
    const r = await setHelpful(admin, shop, reviewGid(body.reviewId), customerId, !!body.liked);
    return json({ success: true, ...r });
  }

  /* ── like on a comment / reply ── */
  if (actionType === "set_thread_like") {
    if (!customerId) return json({ success: false, error: "Please log in to like." }, { status: 401 });
    const target = String(body.replyId || body.commentId || "");
    const r = await setThreadLike(admin, shop, reviewGid(body.reviewId), target, customerId, !!body.liked);
    return json({ success: true, ...r });
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
}
