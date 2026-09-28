import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { countComments, normalizeComments } from "../lib/reviews.shared";
import {
  addComment,
  createReview,
  deleteReview,
  gql,
  removeComment,
  updateComment,
  updateReview,
  uploadImages,
  uploadMedia,
} from "../lib/reviews.server";
import type { ReviewImage } from "../lib/reviews.server";
import { ReviewHeader, Thread, ThreadSummary, initials, peopleOf } from "../components/review-thread";

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
      avatar: r.avatar ? (JSON.parse(r.avatar) as { id: string; url: string }) : null,
      replies: normalizeComments(JSON.parse(r.replies)),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
  return { productId, productTitle: d.product?.title || "Product", shopName: d.shop.name as string, isNew, review, people: peopleOf(review) };
};

const fileOf = (v: FormDataEntryValue | null) => (v && typeof v !== "string" && v.size > 0 ? v : null);

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

  /* ── comments ── */
  if (intent === "reply-add") {
    const text = String(fd.get("replyText") || "").trim();
    if (!text) return { ok: false, message: "Write the reply first" };
    const parentId = String(fd.get("parentId") || "") || null;
    const as = String(fd.get("replyAs") || "store");
    let name = String(fd.get("shopName") || "Store");
    let type: "store" | "customer" = "store";
    let avatar: string | null = null;
    if (as.startsWith("person:")) {
      name = as.slice(7);
      type = "customer";
      avatar = String(fd.get("personAvatar") || "") || null;
    } else if (as === "new") {
      name = String(fd.get("newName") || "").trim();
      if (!name) return { ok: false, message: "Add the new person's name" };
      type = "customer";
      const pic = fileOf(fd.get("newAvatar"));
      if (pic) {
        try { avatar = (await uploadImages(admin, [pic]))[0]?.url || null; } catch { return { ok: false, message: "Picture upload failed" }; }
      }
    }
    await addComment(admin, session.shop, id, { name, text, type, avatar }, parentId);
    return { ok: true, message: parentId ? `Reply posted as ${name}` : `Comment posted as ${name}` };
  }
  if (intent === "comment-edit") {
    await updateComment(admin, session.shop, id, String(fd.get("commentId")), {
      text: String(fd.get("text") || ""),
      name: String(fd.get("name") || ""),
      ...(fd.has("likes") ? { likeCount: parseInt(String(fd.get("likes") || "0"), 10) || 0 } : {}),
    });
    return { ok: true, message: "Comment updated" };
  }
  if (intent === "comment-likes") {
    const likeCount = Math.max(0, parseInt(String(fd.get("likes") || "0"), 10) || 0);
    await updateComment(admin, session.shop, id, String(fd.get("commentId")), { likeCount });
    return { ok: true, message: `Likes set to ${likeCount}` };
  }
  if (intent === "comment-status") {
    const status = fd.get("status") === "hidden" ? "hidden" : "approved";
    await updateComment(admin, session.shop, id, String(fd.get("commentId")), { status });
    return { ok: true, message: status === "hidden" ? "Hidden from the store" : "Shown on the store" };
  }
  if (intent === "comment-delete") {
    await removeComment(admin, session.shop, id, String(fd.get("commentId") || ""));
    return { ok: true, message: "Deleted" };
  }

  /* ── save (create / update) ── */
  const rating = parseInt(String(fd.get("rating") || "5"), 10);
  const body = String(fd.get("body") || "").trim();
  const author = String(fd.get("author") || "").trim();
  const errors: Record<string, string> = {};
  if (!body) errors.body = "Write the review text";
  if (!author) errors.author = "Add the reviewer's name";
  if (!(rating >= 1 && rating <= 5)) errors.rating = "Choose 1 to 5 stars";
  if (Object.keys(errors).length) return { errors };

  const existing = isNew ? null : await prisma.review.findUnique({ where: { id } });
  const keep = new Set(fd.getAll("keepMedia").map(String));
  const kept: ReviewImage[] = existing ? (JSON.parse(existing.images) as ReviewImage[]).filter((i) => keep.has(i.id)) : [];
  let uploaded: ReviewImage[] = [];
  try {
    uploaded = await uploadMedia(admin, fd.getAll("media").filter((f): f is File => typeof f !== "string"));
  } catch (e: any) {
    return { errors: { media: e.message || "Upload failed" } };
  }

  let avatar = existing?.avatar ? JSON.parse(existing.avatar) : null;
  if (fd.get("removeAvatar") === "true") avatar = null;
  const pic = fileOf(fd.get("avatarFile"));
  if (pic) {
    try {
      const up = (await uploadImages(admin, [pic]))[0];
      if (up) avatar = { id: up.id, url: up.url };
    } catch {
      return { errors: { avatar: "Picture upload failed" } };
    }
  }

  const createdRaw = String(fd.get("createdAt") || "");
  const input = {
    productId,
    rating,
    title: String(fd.get("title") || "").trim() || null,
    body,
    author,
    avatar,
    location: String(fd.get("location") || "").trim() || null,
    status: String(fd.get("status") || "published"),
    verified: fd.get("verified") === "true",
    source: String(fd.get("source") || "Website"),
    orderId: String(fd.get("orderId") || "").trim() || null,
    images: [...kept, ...uploaded].slice(0, 12),
    replies: existing ? JSON.parse(existing.replies) : [],
    helpful: fd.has("helpful") ? Math.max(0, Math.min(99999, parseInt(String(fd.get("helpful") || "0"), 10) || 0)) : existing?.helpful || 0,
    featured: fd.get("featured") === "true",
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
  const { productId, productTitle, shopName, isNew, review, people } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>() as any;
  const nav = useNavigation();
  const shopify = useAppBridge();
  const saving = nav.state === "submitting" && nav.formData?.get("intent") === "save";
  const errors = data?.errors || {};
  const r = review || {};

  // right-column controls feed hidden inputs of the main form
  const [status, setStatus] = useState<string>(r.status || "published");
  const [featured, setFeatured] = useState<boolean>(!!r.featured);
  const [verified, setVerified] = useState<boolean>(isNew ? true : !!r.verified);
  const [orderId, setOrderId] = useState<string>(r.orderId || "");
  const [avatarPreview, setAvatarPreview] = useState<string>(r.avatar?.url || "");
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [authorName, setAuthorName] = useState<string>(r.author || "");
  const [helpful, setHelpful] = useState<string>(String(r.helpful || 0));

  useEffect(() => {
    if (data?.message) shopify.toast.show(data.message, { isError: data.ok === false });
  }, [data, shopify]);

  const date = (r.createdAt ? new Date(r.createdAt) : new Date()).toISOString().slice(0, 10);

  return (
    <s-page heading={isNew ? "Add review" : `Review by ${r.author}`}>
      <s-link slot="breadcrumb-actions" href={`/app/reviews/${productId}`}>{productTitle}</s-link>

      <Form method="post" encType="multipart/form-data" id="review-form">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="status" value={status} />
        <input type="hidden" name="featured" value={String(featured)} />
        <input type="hidden" name="verified" value={String(verified)} />
        <input type="hidden" name="orderId" value={orderId} />
        <input type="hidden" name="helpful" value={helpful} />
        <input type="hidden" name="removeAvatar" value={String(removeAvatar)} />
        <input type="hidden" name="title" value={r.title || ""} />
        <input type="hidden" name="source" value={r.source || (isNew ? "WhatsApp" : "Website")} />

        {/* 1 · reviewer first, then the rating */}
        <s-section heading="Reviewer">
          <s-stack gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-avatar
                size="large"
                initials={initials(authorName || "?")}
                alt={authorName || "Reviewer"}
                {...(avatarPreview && !removeAvatar ? { src: avatarPreview } : {})}
              />
              <s-stack gap="small-200">
                <s-text type="strong">Picture</s-text>
                <input
                  type="file"
                  name="avatarFile"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (f) { setAvatarPreview(URL.createObjectURL(f)); setRemoveAvatar(false); }
                  }}
                />
                {(avatarPreview && !removeAvatar) ? (
                  <s-button variant="tertiary" tone="critical" onClick={() => { setRemoveAvatar(true); setAvatarPreview(""); }}>Remove picture</s-button>
                ) : (
                  <s-text color="subdued">Optional. Without a picture the initials show.</s-text>
                )}
                {errors.avatar && <s-text tone="critical">{errors.avatar}</s-text>}
              </s-stack>
            </s-stack>

            <s-text-field
              label="Name"
              name="author"
              defaultValue={r.author || ""}
              error={errors.author}
              required
              onInput={(e: any) => setAuthorName(e.currentTarget.value)}
            />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field label="City" name="location" defaultValue={r.location || ""} placeholder="e.g. Pune" />
              <s-date-field label="Review date" name="createdAt" defaultValue={date} />
            </s-grid>
            <s-select label="Rating" name="rating" value={String(r.rating || 5)} error={errors.rating}>
              {[5, 4, 3, 2, 1].map((n) => (
                <s-option key={n} value={String(n)}>{"★".repeat(n)}{"☆".repeat(5 - n)} ({n})</s-option>
              ))}
            </s-select>
          </s-stack>
        </s-section>

        {/* 2 · photos and videos */}
        <s-section heading="Photos & videos">
          <s-stack gap="base">
            {(r.images || []).length > 0 && (
              <s-stack direction="inline" gap="base">
                {r.images.map((m: ReviewImage) => (
                  <s-box key={m.id} padding="small-200" border="base" borderRadius="base">
                    <s-stack gap="small-200" alignItems="center">
                      {m.kind === "video" ? (
                        <video src={m.url} poster={m.poster || undefined} muted playsInline controls style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, background: "#000" }} />
                      ) : (
                        <s-thumbnail src={m.url} alt="Review photo" size="large" />
                      )}
                      <s-checkbox name="keepMedia" value={m.id} label={m.kind === "video" ? "Keep video" : "Keep"} defaultChecked />
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
            <s-box padding="base" border="base" borderStyle="dashed" borderRadius="base">
              <s-stack gap="small-200">
                <s-text>Add photos or videos (JPG, PNG, WEBP, MP4 · videos up to 100 MB)</s-text>
                <input type="file" name="media" accept="image/*,video/*" multiple />
                <s-text color="subdued">Videos take a few seconds to process after saving.</s-text>
                {errors.media && <s-text tone="critical">{errors.media}</s-text>}
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>

        {/* 3 · the review text */}
        <s-section heading="Review text">
          <s-text-area label="Review" labelAccessibilityVisibility="exclusive" name="body" rows={6} defaultValue={r.body || ""} error={errors.body} required />
        </s-section>
      </Form>

      {/* ── right column ── */}
      <s-section slot="aside" heading="Visibility">
        <s-stack gap="base">
          <s-select label="Status" value={status} onChange={(e: any) => setStatus(e.currentTarget.value)}>
            <s-option value="published">Published — on the store</s-option>
            <s-option value="pending">Pending — waiting</s-option>
            <s-option value="hidden">Hidden</s-option>
          </s-select>
          <s-checkbox label="Pin to the top" checked={featured} onChange={(e: any) => setFeatured(!!e.currentTarget.checked)} />
          <s-checkbox
            label="Verified buyer"
            details="Shows “✓ Verified buyer” on the store"
            checked={verified}
            onChange={(e: any) => setVerified(!!e.currentTarget.checked)}
          />
          {verified && (
            <s-text-field label="Order number (optional)" value={orderId} placeholder="#1001" onInput={(e: any) => setOrderId(e.currentTarget.value)} />
          )}
          <s-number-field
            label="Helpful count"
            details="The “👍 Helpful (n)” number on the store"
            value={helpful}
            min={0}
            max={99999}
            step={1}
            onInput={(e: any) => setHelpful(String(e.currentTarget.value ?? "0"))}
            onChange={(e: any) => setHelpful(String(e.currentTarget.value ?? "0"))}
          />
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
        </s-stack>
      </s-section>

      {!isNew && (
        <s-section slot="aside" heading={`Comments & replies (${countComments(r.replies || [])})`}>
          <ThreadSummary review={r} />
        </s-section>
      )}

      {!isNew && (
        <s-modal id="thread-modal" heading={`Conversation · ${r.author}`} size="large">
          <ReviewHeader review={r} />
          <Thread review={r} shopName={shopName} people={people} />
        </s-modal>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
