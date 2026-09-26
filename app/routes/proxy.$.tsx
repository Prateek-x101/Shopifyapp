/**
 * Storefront API behind the app proxy:  https://<store>/apps/engine/...
 *
 *   GET  /apps/engine/reviews?product=123&page=2&sort=newest&rating=5&media=1   -> JSON page of published reviews
 *   POST /apps/engine/reviews   (multipart: product, rating, body, author, location, title, photos[], website=honeypot)
 *                           -> new review saved as "pending"
 *   POST /apps/engine/helpful   (review=<id>)                                   -> +1 helpful
 *
 * Shopify signs every proxied request; authenticate.public.appProxy verifies it.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createReview, gql, listReviews, patchReview, publicReview, uploadImages } from "../lib/reviews.server";
import { legacyGet, legacyPost } from "../lib/legacy-proxy.server";

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });

/* very small in-memory rate limit: 5 reviews / 10 min per customer-or-ip */
const hits = new Map<string, number[]>();
function limited(key: string, max = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "App not installed" }, { status: 401 });
  const path = params["*"] || "";
  const sp = new URL(request.url).searchParams;

  // storefront review widget: /apps/engine?action=...
  if (!path && sp.get("action")) return legacyGet(session.shop, sp);

  if (path === "reviews") {
    const productId = (sp.get("product") || "").replace(/\D/g, "");
    if (!productId) return json({ error: "product required" }, { status: 400 });
    const list = await listReviews({
      shop: session.shop,
      productId,
      status: "published",
      rating: sp.get("rating") ? parseInt(sp.get("rating")!, 10) : undefined,
      media: sp.get("media") === "1",
      page: parseInt(sp.get("page") || "1", 10),
      perPage: Math.min(20, parseInt(sp.get("per") || "10", 10)),
      sort: (sp.get("sort") as any) || "newest",
    });
    return json(
      { page: list.page, pages: list.pages, total: list.total, reviews: list.rows.map(publicReview) },
      // short CDN/browser cache: fast for everyone, fresh within a minute
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  }

  if (path === "photos") {
    // all review photos for the product gallery ("Customer photos")
    const productId = (sp.get("product") || "").replace(/\D/g, "");
    const rows = await prisma.review.findMany({
      where: { shop: session.shop, productId, status: "published", hasMedia: true },
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
      take: 60,
      select: { id: true, images: true, rating: true, author: true, body: true },
    });
    const photos = rows.flatMap((r) =>
      (JSON.parse(r.images) as { url: string }[]).map((i) => ({ url: i.url, review: r.id.split("/").pop(), rating: r.rating, author: r.author })),
    );
    return json({ photos }, { headers: { "Cache-Control": "public, max-age=120" } });
  }

  return json({ error: "Not found" }, { status: 404 });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) return json({ error: "App not installed" }, { status: 401 });
  const path = params["*"] || "";
  const sp = new URL(request.url).searchParams;
  const customerId = sp.get("logged_in_customer_id") || "";
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anon";

  // storefront review widget: POST /apps/engine with a JSON body { actionType, ... }
  if (!path) {
    let body: any = {};
    try { body = await request.json(); } catch { return json({ success: false, error: "Invalid request" }, { status: 400 }); }
    try {
      return await legacyPost(admin, session.shop, sp, body, ip);
    } catch (e: any) {
      return json({ success: false, error: e?.message || "Something went wrong" }, { status: 500 });
    }
  }

  if (path === "helpful") {
    const fd = await request.formData();
    const id = `gid://shopify/Metaobject/${String(fd.get("review") || "").replace(/\D/g, "")}`;
    if (limited(`h:${ip}:${id}`, 1, 24 * 3600 * 1000)) return json({ ok: true, dup: true });
    const r = await prisma.review.findUnique({ where: { id } });
    if (!r || r.shop !== session.shop || r.status !== "published") return json({ error: "Not found" }, { status: 404 });
    await patchReview(admin, session.shop, id, { helpful: r.helpful + 1 });
    return json({ ok: true, helpful: r.helpful + 1 });
  }

  if (path === "reviews") {
    const fd = await request.formData();
    if (String(fd.get("website") || "")) return json({ ok: true }); // honeypot: bots fill hidden field
    if (limited(`r:${customerId || ip}`)) return json({ error: "Too many reviews. Please try again later." }, { status: 429 });

    const productId = String(fd.get("product") || "").replace(/\D/g, "");
    const rating = parseInt(String(fd.get("rating") || "0"), 10);
    const body = String(fd.get("body") || "").trim().slice(0, 3000);
    const author = String(fd.get("author") || "").trim().slice(0, 60);
    if (!productId || !(rating >= 1 && rating <= 5) || body.length < 5 || !author) {
      return json({ error: "Please add a star rating, your name and a few words." }, { status: 400 });
    }

    // Verified buyer: logged-in customer who has an order containing this product
    let verified = false;
    let orderId: string | null = null;
    if (customerId) {
      try {
        const d = await gql(admin, `query($id: ID!) { customer(id: $id) { orders(first: 50, reverse: true) { nodes { name lineItems(first: 50) { nodes { product { id } } } } } } }`, {
          id: `gid://shopify/Customer/${customerId}`,
        });
        const hit = d.customer?.orders.nodes.find((o: any) => o.lineItems.nodes.some((li: any) => li.product?.id === `gid://shopify/Product/${productId}`));
        if (hit) { verified = true; orderId = hit.name; }
      } catch { /* not verified */ }
    }

    let images: Awaited<ReturnType<typeof uploadImages>> = [];
    try {
      images = await uploadImages(admin, fd.getAll("photos").filter((f): f is File => typeof f !== "string" && f.size <= 8 * 1024 * 1024).slice(0, 4));
    } catch { images = []; }

    await createReview(admin, session.shop, {
      productId,
      rating,
      title: String(fd.get("title") || "").trim().slice(0, 120) || null,
      body,
      author,
      location: String(fd.get("location") || "").trim().slice(0, 60) || null,
      status: "pending",
      verified,
      source: "Website",
      orderId,
      images,
    });
    return json({ ok: true, message: "Thank you! Your review will appear after a quick check." });
  }

  return json({ error: "Not found" }, { status: 404 });
};
