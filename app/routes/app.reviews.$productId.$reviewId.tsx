import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SOURCES } from "../lib/reviews.shared";
import {
  createReview,
  deleteReview,
  gql,
  patchReview,
  updateReview,
  uploadImages,
} from "../lib/reviews.server";
import type { ReviewImage, ReviewReply } from "../lib/reviews.server";

const gidOf = (id: string) => `gid://shopify/Metaobject/${id}`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = params.productId!;
  const isNew = params.reviewId === "new";
  const d = await gql(admin, `query($id: ID!) { product(id: $id) { title } shop { name } }`, { id: `gid://shopify/Product/${productId}` });
  let review: any = null;
  if (!isNew) {
    const r = await prisma.review.findUnique({ where: { id: gidOf(params.reviewId!) } });
    if (!r || r.shop !== session.shop) throw new Response("Review not found", { status: 404 });
    review = {
      ...r,
      images: JSON.parse(r.images) as ReviewImage[],
      replies: JSON.parse(r.replies) as ReviewReply[],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
  return { productId, productTitle: d.product?.title || "Product", shopName: d.shop.name, isNew, review };
};

/** Verified buyer only when the order really contains this product. */
async function orderHasProduct(admin: any, orderName: string, productId: string) {
  const name = orderName.trim().replace(/^#?/, "#");
  const d = await gql(admin, `query($q: String!) { orders(first: 1, query: $q) { nodes { name lineItems(first: 50) { nodes { product { id } } } } } }`, {
    q: `name:${name}`,
  });
  const order = d.orders.nodes[0];
  if (!order) return false;
  return order.lineItems.nodes.some((li: any) => li.product?.id === `gid://shopify/Product/${productId}`);
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const productId = params.productId!;
  const isNew = params.reviewId === "new";
  const id = isNew ? "" : gidOf(params.reviewId!);
  const fd = await request.formData();
  const intent = (fd.get("intent") as string) || "save";

  if (intent === "delete") {
    await deleteReview(admin, session.shop, id);
    return redirect(`/app/reviews/${productId}`);
  }

  if (intent === "reply-add" || intent === "reply-delete") {
    const cur = await prisma.review.findUnique({ where: { id } });
    if (!cur) return { error: "Review not found" };
    let replies: ReviewReply[] = JSON.parse(cur.replies);
    if (intent === "reply-add") {
      const text = String(fd.get("replyText") || "").trim();
      if (!text) return { error: "Write a reply first" };
      replies = [
        ...replies,
        { id: `r_${Date.now().toString(36)}`, author: String(fd.get("replyAuthor") || "Store"), text, isStore: true, createdAt: new Date().toISOString() },
      ];
    } else {
      replies = replies.filter((r) => r.id !== fd.get("replyId"));
    }
    await patchReview(admin, session.shop, id, { replies });
    return { ok: true, message: intent === "reply-add" ? "Reply added" : "Reply removed" };
  }

  // ── save (create / update) ──
  const rating = parseInt(String(fd.get("rating") || "5"), 10);
  const body = String(fd.get("body") || "").trim();
  const author = String(fd.get("author") || "").trim();
  const orderId = String(fd.get("orderId") || "").trim() || null;
  const wantVerified = fd.get("verified") === "on" || fd.get("verified") === "true";
  const errors: Record<string, string> = {};
  if (!body) errors.body = "Write the review text";
  if (!author) errors.author = "Add the customer's name";
  if (!(rating >= 1 && rating <= 5)) errors.rating = "Choose 1 to 5 stars";

  let verified = false;
  if (wantVerified) {
    if (!orderId) errors.orderId = "Add the order number to mark as verified";
    else if (!(await orderHasProduct(admin, orderId, productId))) errors.orderId = "This order does not contain this product";
    else verified = true;
  }
  if (Object.keys(errors).length) return { errors };

  const existing = isNew ? null : await prisma.review.findUnique({ where: { id } });
  const keep = new Set(fd.getAll("keepImage").map(String));
  const kept: ReviewImage[] = existing ? (JSON.parse(existing.images) as ReviewImage[]).filter((i) => keep.has(i.id)) : [];
  let uploaded: ReviewImage[] = [];
  try {
    uploaded = await uploadImages(admin, fd.getAll("photos").filter((f): f is File => typeof f !== "string"));
  } catch (e: any) {
    return { errors: { photos: e.message || "Photo upload failed" } };
  }

  const createdRaw = String(fd.get("createdAt") || "");
  const input = {
    productId,
    rating,
    title: String(fd.get("title") || "").trim() || null,
    body,
    author,
    location: String(fd.get("location") || "").trim() || null,
    status: String(fd.get("status") || "published"),
    verified,
    source: String(fd.get("source") || "Website"),
    orderId,
    images: [...kept, ...uploaded].slice(0, 8),
    replies: existing ? JSON.parse(existing.replies) : [],
    helpful: existing?.helpful || 0,
    featured: fd.get("featured") === "on" || fd.get("featured") === "true",
    createdAt: createdRaw ? new Date(createdRaw + "T12:00:00+05:30").toISOString() : existing?.createdAt.toISOString(),
  };

  if (isNew) {
    await createReview(admin, session.shop, input);
    return redirect(`/app/reviews/${productId}`);
  }
  await updateReview(admin, session.shop, id, input);
  return { ok: true, message: "Review saved" };
};

export default function EditReview() {
  const { productId, productTitle, shopName, isNew, review } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>() as any;
  const nav = useNavigation();
  const shopify = useAppBridge();
  const saving = nav.state === "submitting" && nav.formData?.get("intent") !== "delete";
  const errors = data?.errors || {};
  const replyFetcher = useFetcher<typeof action>();

  useEffect(() => {
    const msg = data?.message || (replyFetcher.data as any)?.message;
    if (msg) shopify.toast.show(msg);
  }, [data, replyFetcher.data, shopify]);

  const r = review || {};
  const date = (r.createdAt ? new Date(r.createdAt) : new Date()).toISOString().slice(0, 10);

  return (
    <s-page heading={isNew ? "Add review" : `Review by ${r.author}`}>
      <s-link slot="breadcrumb-actions" href={`/app/reviews/${productId}`}>{productTitle}</s-link>

      <Form method="post" encType="multipart/form-data" id="review-form">
        <input type="hidden" name="intent" value="save" />

        <s-section heading="Review">
          <s-stack gap="base">
            <s-select label="Rating" name="rating" value={String(r.rating || 5)} error={errors.rating}>
              {[5, 4, 3, 2, 1].map((n) => (
                <s-option key={n} value={String(n)}>{"★".repeat(n)}{"☆".repeat(5 - n)}  ({n})</s-option>
              ))}
            </s-select>
            <s-text-field label="Title (optional)" name="title" defaultValue={r.title || ""} placeholder="e.g. Perfect fit" />
            <s-text-area label="Review" name="body" rows={5} defaultValue={r.body || ""} error={errors.body} required />
          </s-stack>
        </s-section>

        <s-section heading="Photos">
          <s-stack gap="base">
            {(r.images || []).length > 0 && (
              <s-stack direction="inline" gap="base">
                {r.images.map((img: ReviewImage) => (
                  <s-box key={img.id} padding="small-200" border="base" borderRadius="base">
                    <s-stack gap="small-200" alignItems="center">
                      <s-thumbnail src={img.url} alt="Review photo" size="large" />
                      <s-checkbox name="keepImage" value={img.id} label="Keep" defaultChecked />
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
            <s-box padding="base" border="base" borderStyle="dashed" borderRadius="base">
              <s-stack gap="small-200">
                <s-text>Add photos (up to 6, JPG / PNG / WEBP)</s-text>
                <input type="file" name="photos" accept="image/*" multiple />
                {errors.photos && <s-text tone="critical">{errors.photos}</s-text>}
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>

        <s-section heading="Customer">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field label="Name" name="author" defaultValue={r.author || ""} error={errors.author} required />
            <s-text-field label="City" name="location" defaultValue={r.location || ""} placeholder="e.g. Pune" />
            <s-date-field label="Review date" name="createdAt" defaultValue={date} />
            <s-select label="Source" name="source" value={r.source || (isNew ? "WhatsApp" : "Website")} details="Where this review came from">
              {SOURCES.map((s) => <s-option key={s} value={s}>{s}</s-option>)}
            </s-select>
          </s-grid>
        </s-section>

        <s-section heading="Verified buyer">
          <s-stack gap="base">
            <s-paragraph>
              The Verified badge is only given when the order number really contains this product.
            </s-paragraph>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base" alignItems="end">
              <s-text-field label="Order number" name="orderId" defaultValue={r.orderId || ""} placeholder="#1001" error={errors.orderId} />
              <s-checkbox name="verified" label="Mark as verified buyer" defaultChecked={!!r.verified} />
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading="Visibility">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base" alignItems="end">
            <s-select label="Status" name="status" value={r.status || "published"}>
              <s-option value="published">Published — shown on the store</s-option>
              <s-option value="pending">Pending — waiting for approval</s-option>
              <s-option value="hidden">Hidden</s-option>
            </s-select>
            <s-checkbox name="featured" label="Pin to the top of the list" defaultChecked={!!r.featured} />
          </s-grid>
        </s-section>
      </Form>

      {!isNew && (
        <s-section heading={`Replies (${(r.replies || []).length})`}>
          <s-stack gap="base">
            {(r.replies || []).map((rp: ReviewReply) => (
              <s-box key={rp.id} padding="base" background={rp.isStore ? "subdued" : "base"} borderRadius="base" border="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="start" gap="base">
                  <s-stack gap="small-200">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-text type="strong">{rp.author}</s-text>
                      {rp.isStore && <s-badge tone="info">Store</s-badge>}
                      <s-text color="subdued">{new Date(rp.createdAt).toLocaleDateString("en-IN")}</s-text>
                    </s-stack>
                    <s-text>{rp.text}</s-text>
                  </s-stack>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    icon="delete"
                    accessibilityLabel="Remove reply"
                    onClick={() => replyFetcher.submit({ intent: "reply-delete", replyId: rp.id }, { method: "POST" })}
                  />
                </s-stack>
              </s-box>
            ))}
            <replyFetcher.Form method="post">
              <input type="hidden" name="intent" value="reply-add" />
              <input type="hidden" name="replyAuthor" value={shopName} />
              <s-stack gap="small-200">
                <s-text-area label={`Reply as ${shopName}`} name="replyText" rows={3} placeholder="Thank you for the review!" />
                <s-stack direction="inline" justifyContent="end">
                  <s-button type="submit" {...(replyFetcher.state !== "idle" ? { loading: true } : {})}>Post reply</s-button>
                </s-stack>
              </s-stack>
            </replyFetcher.Form>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Save">
        <s-stack gap="base">
          <s-button
            variant="primary"
            onClick={() => (document.getElementById("review-form") as HTMLFormElement | null)?.requestSubmit()}
            {...(saving ? { loading: true } : {})}
          >
            {isNew ? "Add review" : "Save changes"}
          </s-button>
          {!isNew && (
            <Form method="post" onSubmit={(e) => { if (!confirm("Delete this review permanently?")) e.preventDefault(); }}>
              <input type="hidden" name="intent" value="delete" />
              <s-button type="submit" tone="critical" variant="secondary">Delete review</s-button>
            </Form>
          )}
          {!isNew && r.helpful > 0 && <s-text color="subdued">{r.helpful} people found this helpful</s-text>}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
