/**
 * AI actions for the admin pages (POST only). See lib/ai.server.ts.
 *   intent=reply      reviewId, targetId?          → { ok, text }   store reply (to a comment, or to the review)
 *   intent=improve    reviewId, targetId?, draft   → { ok, text }   polish the admin's draft
 *   intent=draft      productId, text?, image?, translate? → { ok, draft }   real customer message → review draft
 *   intent=insights   productId                    → { ok, insights }
 *   intent=test-generate  productId, count, mix, language, comments → { ok, message }   hidden "Test" reviews
 *   intent=test-delete    productId                    → { ok, message }   removes all of them
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createReview, deleteReview, ensureDefinitions, gql, recomputeSummary } from "../lib/reviews.server";
import type { ReviewComment } from "../lib/reviews.shared";
import { TEST_SOURCE } from "../lib/reviews.shared";
import { AiError, draftFromCustomerMessage, generateTestReviews, reviewInsights, suggestStoreReply } from "../lib/ai.server";
import type { TestComment } from "../lib/ai.server";

const cid = () => `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
/** AI comment tree → stored comments, each a little later than the one before */
function testThread(list: TestComment[], start: number, shopName: string, parent: string | null): ReviewComment[] {
  let t = start;
  return list.map((c) => {
    t += (1 + Math.random() * 30) * 3600_000;
    const id = cid();
    const node: ReviewComment = {
      id,
      name: c.store ? shopName : c.name,
      text: c.text,
      date: new Date(Math.min(t, Date.now() - 60_000)).toISOString(),
      type: c.store ? "store" : "customer",
      status: "approved",
      customerId: null,
      avatar: null,
      verified: false,
      likeCount: Math.floor(Math.random() * 4),
      parentCommentId: parent,
      replies: [],
    };
    node.replies = testThread(c.replies || [], t, shopName, id);
    return node;
  });
}

const num = (v: unknown) => String(v ?? "").split("/").pop()!.replace(/\D/g, "");

async function names(admin: any, productId: string) {
  const d = await gql(admin, `query($id: ID!) { product(id: $id) { title } shop { name } }`, { id: `gid://shopify/Product/${productId}` });
  return { productTitle: (d.product?.title as string) || "Product", shopName: (d.shop?.name as string) || "Store" };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");
  try {
    if (intent === "reply" || intent === "improve") {
      const reviewId = `gid://shopify/Metaobject/${num(fd.get("reviewId"))}`;
      const review = await prisma.review.findUnique({ where: { id: reviewId } });
      if (!review || review.shop !== session.shop) return { ok: false, message: "Review not found" };
      const { productTitle, shopName } = await names(admin, review.productId);
      const draft = intent === "improve" ? String(fd.get("draft") || "") : "";
      if (intent === "improve" && !draft.trim()) return { ok: false, message: "Write something first, then Improve" };
      const text = await suggestStoreReply(session.shop, {
        shopName,
        productTitle,
        review,
        targetId: String(fd.get("targetId") || "") || null,
        draft,
      });
      return { ok: true, text };
    }

    if (intent === "draft") {
      const productId = num(fd.get("productId"));
      const file = fd.get("image");
      let image: { mime: string; base64: string } | null = null;
      if (file && typeof file !== "string" && file.size > 0) {
        if (!/^image\/(png|jpe?g|webp|heic|heif)$/i.test(file.type)) return { ok: false, message: "The screenshot must be a PNG, JPG or WEBP image" };
        if (file.size > 8 * 1024 * 1024) return { ok: false, message: "The screenshot is too big (max 8 MB)" };
        image = { mime: file.type, base64: Buffer.from(await file.arrayBuffer()).toString("base64") };
      }
      const { productTitle } = await names(admin, productId);
      const draft = await draftFromCustomerMessage(session.shop, {
        productTitle,
        text: String(fd.get("text") || ""),
        image,
        translate: fd.get("translate") === "true",
      });
      return { ok: true, draft };
    }

    if (intent === "test-generate") {
      const productId = num(fd.get("productId"));
      const d = await gql(admin, `query($id: ID!) { product(id: $id) { title description } shop { name } }`, { id: `gid://shopify/Product/${productId}` });
      if (!d.product) return { ok: false, message: "Product not found" };
      await ensureDefinitions(admin); // allows the "Test" source on older review definitions
      const list = await generateTestReviews(session.shop, {
        productTitle: d.product.title,
        productText: String(d.product.description || ""),
        count: parseInt(String(fd.get("count") || "10"), 10) || 10,
        mix: String(fd.get("mix") || "realistic"),
        language: String(fd.get("language") || "mixed"),
        withComments: fd.get("comments") === "true",
      });
      let made = 0;
      for (const r of list) {
        const created = Date.now() - r.daysAgo * 86400_000 - Math.floor(Math.random() * 8 * 3600_000);
        await createReview(admin, session.shop, {
          productId,
          rating: r.rating,
          title: null,
          body: r.body,
          author: r.author,
          location: r.city || null,
          status: "hidden",
          verified: false,
          source: TEST_SOURCE,
          replies: testThread(r.comments, created, d.shop.name, null),
          helpful: Math.floor(Math.random() * 6),
          createdAt: new Date(created).toISOString(),
        }, { skipSummary: true });
        made++;
      }
      return { ok: true, message: `${made} test review${made === 1 ? "" : "s"} added (hidden, never on the store)` };
    }

    if (intent === "test-delete") {
      const productId = num(fd.get("productId"));
      const rows = await prisma.review.findMany({ where: { shop: session.shop, productId, source: TEST_SOURCE }, select: { id: true } });
      for (const r of rows) await deleteReview(admin, session.shop, r.id, { skipSummary: true });
      await recomputeSummary(admin, session.shop, productId);
      return { ok: true, message: rows.length ? `${rows.length} test review${rows.length === 1 ? "" : "s"} deleted` : "No test reviews to delete" };
    }

    if (intent === "insights") {
      const productId = num(fd.get("productId"));
      const reviews = await prisma.review.findMany({
        where: { shop: session.shop, productId, status: "published", NOT: { source: TEST_SOURCE } },
        orderBy: { createdAt: "desc" },
        take: 300,
        select: { rating: true, body: true, createdAt: true, replies: true },
      });
      const { productTitle } = await names(admin, productId);
      const insights = await reviewInsights(session.shop, { productTitle, reviews });
      return { ok: true, insights, count: reviews.length };
    }

    return { ok: false, message: "Unknown AI action" };
  } catch (e: any) {
    if (e instanceof AiError) return { ok: false, message: e.message };
    console.error("[ai]", intent, e);
    return { ok: false, message: "AI request failed. Try again." };
  }
};
