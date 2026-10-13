/**
 * AI actions for the admin pages (POST only). See lib/ai.server.ts.
 *   intent=reply      reviewId, targetId?          → { ok, text }   store reply (to a comment, or to the review)
 *   intent=improve    reviewId, targetId?, draft   → { ok, text }   polish the admin's draft
 *   intent=draft      productId, text?, image?, translate? → { ok, draft }   real customer message → review draft
 *   intent=insights   productId                    → { ok, insights }
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { gql } from "../lib/reviews.server";
import { AiError, draftFromCustomerMessage, reviewInsights, suggestStoreReply } from "../lib/ai.server";

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

    if (intent === "insights") {
      const productId = num(fd.get("productId"));
      const reviews = await prisma.review.findMany({
        where: { shop: session.shop, productId, status: "published" },
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
