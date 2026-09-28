import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import { useEffect, useRef, useState } from "react";
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
import type { ReviewComment } from "../lib/reviews.shared";

const gidOf = (id: string) => `gid://shopify/Metaobject/${id}`;
const initials = (name: string) =>
  (String(name || "?").match(/[A-Za-zऀ-ॿ]+/g) || ["?"]).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

/** Everyone who speaks in this review: the reviewer and each commenter (for "Reply as"). */
function peopleOf(review: any) {
  const out: { name: string; avatar: string | null }[] = [];
  const seen = new Set<string>();
  const add = (name: string, avatar: string | null) => {
    const k = name.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ name: name.trim(), avatar });
  };
  if (review?.author) add(review.author, review.avatar?.url || null);
  const walk = (list: ReviewComment[]) =>
    list.forEach((c) => {
      if (c.type !== "store") add(c.name, c.avatar || null);
      walk(c.replies || []);
    });
  walk(review?.replies || []);
  return out;
}

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

/* ───────────────────────── comments panel ───────────────────────── */

/* calm, neutral look: white surface, hairline greys, one dark accent */
const CV_CSS = `
.cv { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #303030; }
.cv-av { flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
  background: #f3f3f3; color: #707070; font-size: 11.5px; font-weight: 600; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06); }
.cv-av.sm { width: 26px; height: 26px; font-size: 10px; }
.cv-av.lg { width: 40px; height: 40px; font-size: 13px; }
.cv-av.store { background: #fff; color: #303030; box-shadow: inset 0 0 0 1px #d4d4d4; }
.cv-av img { width: 100%; height: 100%; object-fit: cover; }

.cv-review { display: flex; gap: 12px; padding: 2px 0 18px; margin-bottom: 4px; border-bottom: 1px solid #f1f1f1; }
.cv-review-name { font-weight: 600; font-size: 14px; color: #1f1f1f; }
.cv-stars { color: #4a4a4a; letter-spacing: 1.5px; font-size: 10.5px; margin-left: 8px; vertical-align: 1px; }
.cv-stars i { color: #dedede; font-style: normal; }
.cv-review-text { margin-top: 8px; font-size: 13.5px; line-height: 21px; color: #4a4a4a; }
.cv-muted { color: #9a9a9a; font-size: 12px; margin-top: 1px; }

.cv-list { padding: 4px 0 8px; }
.cv-node { position: relative; }
.cv-row { display: flex; gap: 10px; padding: 14px 0 0; }
.cv-body { flex: 1; min-width: 0; }
.cv-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: #9a9a9a; line-height: 18px; }
.cv-name { color: #1f1f1f; font-weight: 600; font-size: 13px; }
.cv-tag { font-size: 11px; color: #8a8a8a; }
.cv-tag.hidden { color: #a86a00; }
.cv-text { margin: 2px 0 0; font-size: 13.5px; line-height: 20px; color: #3a3a3a; white-space: pre-wrap; word-wrap: break-word; }
.cv-node.is-hidden > .cv-row .cv-text, .cv-node.is-hidden > .cv-row .cv-av { opacity: 0.4; }

.cv-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 4px 0 0 -6px; }
.cv-act { border: 0; background: none; padding: 3px 6px; border-radius: 6px; font: inherit; font-size: 12px; color: #8a8a8a; cursor: pointer; }
.cv-act:hover { background: #f5f5f5; color: #303030; }
.cv-act.danger:hover { background: #fdf2f2; color: #b42318; }
.cv-act.on { color: #1f1f1f; font-weight: 600; }
.cv-act[disabled] { opacity: 0.5; cursor: default; }

/* like count: small stepper, edits the number shown on the store */
.cv-likes { display: inline-flex; align-items: center; height: 24px; margin-right: 4px; border: 1px solid #ececec; border-radius: 999px; overflow: hidden; }
.cv-likes button { border: 0; background: none; width: 22px; height: 100%; font-size: 13px; color: #8a8a8a; cursor: pointer; line-height: 1; }
.cv-likes button:hover { background: #f5f5f5; color: #303030; }
.cv-likes input { width: 40px; height: 100%; border: 0; padding: 0; text-align: center; font: inherit; font-size: 12px; color: #303030;
  background: transparent; -moz-appearance: textfield; }
.cv-likes input::-webkit-outer-spin-button, .cv-likes input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.cv-likes input:focus { outline: none; background: #fafafa; }
.cv-likes .cv-heart { padding-left: 8px; font-size: 11px; color: #b0b0b0; }
.cv-likes.saving { border-color: #d4d4d4; }

/* thread lines: parent avatar → each reply */
.cv-kids { position: relative; margin-left: 15px; padding-left: 20px; }
.cv-kids::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; border-left: 1px solid #e6e6e6; }
.cv-kids > .cv-node::before { content: ""; position: absolute; left: -20px; top: 0; width: 14px; height: 27px;
  border-left: 1px solid #e6e6e6; border-bottom: 1px solid #e6e6e6; border-bottom-left-radius: 10px; z-index: 1; }
.cv-kids > .cv-node:last-child::after { content: ""; position: absolute; left: -21px; top: 16px; bottom: 0; width: 3px; background: #fff; }
.cv-node.has-kids > .cv-row { position: relative; }
.cv-node.has-kids > .cv-row::after { content: ""; position: absolute; left: 15px; top: 50px; bottom: 0; border-left: 1px solid #e6e6e6; }
.cv-kids .cv-node.has-kids > .cv-row::after { left: 12px; top: 44px; }
.cv-kids .cv-kids { margin-left: 12px; }

.cv-edit { margin-top: 8px; display: grid; gap: 8px; padding: 12px; border: 1px solid #efefef; border-radius: 10px; background: #fcfcfc; }
.cv-edit-row { display: grid; grid-template-columns: 1fr 96px; gap: 8px; }
.cv-label { display: block; font-size: 11px; color: #8a8a8a; margin-bottom: 4px; }
.cv-input, .cv-textarea { width: 100%; box-sizing: border-box; border: 1px solid #e3e3e3; border-radius: 8px;
  padding: 7px 10px; font: inherit; font-size: 13px; background: #fff; color: #1f1f1f; }
.cv-textarea { resize: vertical; min-height: 66px; line-height: 19px; }
.cv-input:focus, .cv-textarea:focus { outline: none; border-color: #8a8a8a; }
.cv-btns { display: flex; gap: 6px; justify-content: flex-end; }
.cv-btn { border: 1px solid #303030; border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; background: #303030; color: #fff; }
.cv-btn.ghost { background: #fff; color: #4a4a4a; border-color: #e3e3e3; }
.cv-btn[disabled] { opacity: 0.5; cursor: default; }

/* composer: stays at the bottom of the popup */
.cv-composer { position: sticky; bottom: -16px; margin: 10px -16px -16px; padding: 12px 16px 14px; background: #fff; border-top: 1px solid #f1f1f1; }
.cv-target { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; color: #8a8a8a; }
.cv-target b { color: #303030; font-weight: 600; }
.cv-x { border: 0; background: none; padding: 0 2px; font: inherit; font-size: 12px; color: #8a8a8a; cursor: pointer; text-decoration: underline; }
.cv-x:hover { color: #303030; }
.cv-line { display: flex; align-items: flex-end; gap: 8px; }
.cv-as { position: relative; flex-shrink: 0; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px 0 4px;
  border: 1px solid #e3e3e3; border-radius: 999px; background: #fff; max-width: 180px; }
.cv-as:hover { border-color: #cfcfcf; }
.cv-as select { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.cv-as-name { font-size: 12.5px; font-weight: 500; color: #303030; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-as-caret { font-size: 9px; color: #9a9a9a; }
.cv-msg { flex: 1; min-width: 0; min-height: 36px; max-height: 140px; resize: none; border: 1px solid #e3e3e3; border-radius: 18px;
  padding: 8px 14px; font: inherit; font-size: 13.5px; line-height: 18px; box-sizing: border-box; background: #fafafa; color: #1f1f1f; }
.cv-msg:focus { outline: none; border-color: #8a8a8a; background: #fff; }
.cv-send { flex-shrink: 0; width: 36px; height: 36px; border: 0; border-radius: 50%; background: #303030; color: #fff; cursor: pointer; display: grid; place-items: center; }
.cv-send[disabled] { background: #f1f1f1; color: #b5b5b5; cursor: default; }
.cv-send svg { width: 15px; height: 15px; fill: currentColor; }
.cv-new { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cv-new .cv-input { flex: 1; }
.cv-file { font-size: 12px; color: #707070; max-width: 190px; }
.cv-hint { margin-top: 6px; font-size: 11px; color: #b0b0b0; text-align: right; }
.cv-empty { padding: 26px 0 12px; text-align: center; color: #9a9a9a; font-size: 13px; }

/* right-column summary */
.cv-sum-row { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f3f3f3; }
.cv-sum-row:last-child { border-bottom: 0; }
.cv-sum-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: #616161; font-size: 12.5px; line-height: 18px; }
`;

function Avatar({ name, src, store, size }: { name: string; src?: string | null; store?: boolean; size?: "sm" | "lg" }) {
  return (
    <span className={`cv-av${size ? " " + size : ""}${store && !src ? " store" : ""}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

/** Right column: counts, the two latest messages and a button that opens the full conversation. */
function ThreadSummary({ review }: { review: any }) {
  const all: ReviewComment[] = [];
  const walk = (list: ReviewComment[]) => list.forEach((c) => { all.push(c); walk(c.replies || []); });
  walk(review.replies || []);
  const latest = [...all].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 2);
  const hidden = all.filter((c) => c.status === "hidden").length;

  return (
    <s-stack gap="base">
      <style>{CV_CSS}</style>
      {all.length === 0 ? (
        <s-text color="subdued">No comments yet.</s-text>
      ) : (
        <div className="cv">
          {(review.needsReply || hidden > 0) && (
            <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              {review.needsReply && <s-badge>Needs reply</s-badge>}
              {hidden > 0 && <s-badge>{hidden} hidden</s-badge>}
            </div>
          )}
          {latest.map((c) => (
            <div key={c.id} className="cv-sum-row">
              <Avatar name={c.name} src={c.avatar} store={c.type === "store"} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cv-name">{c.name}</div>
                <div className="cv-sum-text">{c.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <s-button icon="chat" commandFor="thread-modal" command="--show">
        {all.length ? `Open conversation (${all.length})` : "Write a comment"}
      </s-button>
    </s-stack>
  );
}

/** Top of the conversation popup: the review itself. */
function ReviewHeader({ review }: { review: any }) {
  const n = Math.max(1, Math.min(5, review.rating || 5));
  return (
    <div className="cv">
      <style>{CV_CSS}</style>
      <div className="cv-review">
        <Avatar name={review.author} src={review.avatar?.url} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>
            <span className="cv-review-name">{review.author}</span>
            <span className="cv-stars">{"★".repeat(n)}<i>{"★".repeat(5 - n)}</i></span>
          </div>
          <div className="cv-muted">
            {[review.location, new Date(review.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })].filter(Boolean).join(" · ")}
          </div>
          <div className="cv-review-text">{review.body}</div>
        </div>
      </div>
    </div>
  );
}

function Thread({ review, shopName, people }: { review: any; shopName: string; people: { name: string; avatar: string | null }[] }) {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const replies: ReviewComment[] = review.replies || [];
  return (
    <div className="cv">
      <div className="cv-list">
        {replies.length === 0 && <div className="cv-empty">No comments yet — write the first one below.</div>}
        {replies.map((c) => (
          <Node key={c.id} node={c} depth={0} onReply={(n) => setTarget({ id: n.id, name: n.name })} activeId={target?.id} />
        ))}
      </div>
      <Composer target={target} onDone={() => setTarget(null)} shopName={shopName} people={people} />
    </div>
  );
}

/** −  ♥ 12  + : saves on its own a moment after the last change. */
function Likes({ id, count }: { id: string; count: number }) {
  const fetcher = useFetcher<typeof action>();
  const [val, setVal] = useState(String(count || 0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(count || 0);

  useEffect(() => { setVal(String(count || 0)); saved.current = count || 0; }, [count]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = (raw: string, wait: number) => {
    const n = Math.max(0, Math.min(99999, parseInt(raw, 10) || 0));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (n === saved.current) return;
      saved.current = n;
      fetcher.submit({ intent: "comment-likes", commentId: id, likes: String(n) }, { method: "POST" });
    }, wait);
  };
  const step = (d: number) => {
    const n = Math.max(0, (parseInt(val, 10) || 0) + d);
    setVal(String(n));
    commit(String(n), 700);
  };

  return (
    <span className={`cv-likes${fetcher.state !== "idle" ? " saving" : ""}`} title="Likes shown on the store">
      <span className="cv-heart">♥</span>
      <input
        type="number"
        min={0}
        value={val}
        aria-label="Likes"
        onChange={(e) => { setVal(e.currentTarget.value); commit(e.currentTarget.value, 900); }}
        onBlur={(e) => commit(e.currentTarget.value, 0)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget.value, 0); } }}
      />
      <button type="button" onClick={() => step(-1)} aria-label="One less like">−</button>
      <button type="button" onClick={() => step(1)} aria-label="One more like">+</button>
    </span>
  );
}

function Node({ node, depth, onReply, activeId }: { node: ReviewComment; depth: number; onReply: (n: ReviewComment) => void; activeId?: string }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [editing, setEditing] = useState(false);
  const busy = fetcher.state !== "idle";
  const hidden = node.status === "hidden";
  const store = node.type === "store";
  const kids = node.replies || [];

  useEffect(() => {
    const d: any = fetcher.data;
    if (d?.message) { shopify.toast.show(d.message, { isError: d.ok === false }); if (d.ok) setEditing(false); }
  }, [fetcher.data, shopify]);

  const send = (data: Record<string, string>) => fetcher.submit({ commentId: node.id, ...data }, { method: "POST" });
  const when = new Date(node.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <div className={`cv-node${kids.length ? " has-kids" : ""}${hidden ? " is-hidden" : ""}`}>
      <div className="cv-row">
        <Avatar name={node.name} src={node.avatar} store={store} size={depth ? "sm" : undefined} />
        <div className="cv-body">
          <div className="cv-meta">
            <span className="cv-name">{node.name}</span>
            {store && <span className="cv-tag">· Store</span>}
            {hidden && <span className="cv-tag hidden">· Hidden</span>}
            <span>· {when}</span>
          </div>

          {editing ? (
            <fetcher.Form method="post" className="cv-edit">
              <input type="hidden" name="intent" value="comment-edit" />
              <input type="hidden" name="commentId" value={node.id} />
              <div className="cv-edit-row">
                <label><span className="cv-label">Name</span><input className="cv-input" name="name" defaultValue={node.name} /></label>
                <label><span className="cv-label">Likes</span><input className="cv-input" name="likes" type="number" min={0} max={99999} defaultValue={node.likeCount || 0} /></label>
              </div>
              <label><span className="cv-label">Message</span><textarea className="cv-textarea" name="text" defaultValue={node.text} /></label>
              <div className="cv-btns">
                <button className="cv-btn ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
                <button className="cv-btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
              </div>
            </fetcher.Form>
          ) : (
            <p className="cv-text">{node.text}</p>
          )}

          {!editing && (
            <div className="cv-actions">
              <Likes id={node.id} count={node.likeCount} />
              <button type="button" className={`cv-act${activeId === node.id ? " on" : ""}`} onClick={() => onReply(node)}>Reply</button>
              <button type="button" className="cv-act" onClick={() => setEditing(true)}>Edit</button>
              <button type="button" className="cv-act" disabled={busy} onClick={() => send({ intent: "comment-status", status: hidden ? "approved" : "hidden" })}>
                {hidden ? "Show" : "Hide"}
              </button>
              <button type="button" className="cv-act danger" disabled={busy} onClick={() => { if (confirm("Delete this and its replies?")) send({ intent: "comment-delete" }); }}>
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {kids.length > 0 && (
        <div className="cv-kids">
          {kids.map((c) => (
            <Node key={c.id} node={c} depth={depth + 1} onReply={onReply} activeId={activeId} />
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({
  target,
  onDone,
  shopName,
  people,
}: {
  target: { id: string; name: string } | null;
  onDone: () => void;
  shopName: string;
  people: { name: string; avatar: string | null }[];
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const [as, setAs] = useState<string>("store");
  const [newPic, setNewPic] = useState<string>("");
  const [text, setText] = useState("");
  const busy = fetcher.state !== "idle";
  const person = as.startsWith("person:") ? people.find((p) => `person:${p.name}` === as) : null;
  const asName = as === "store" ? shopName : as === "new" ? "New person" : as.slice(7);

  useEffect(() => { if (target) msgRef.current?.focus(); }, [target]);
  useEffect(() => {
    const d: any = fetcher.data;
    if (!d?.message) return;
    shopify.toast.show(d.message, { isError: d.ok === false });
    if (d.ok) {
      formRef.current?.reset();
      setText("");
      setNewPic("");
      if (msgRef.current) msgRef.current.style.height = "";
      onDone();
    }
  }, [fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cv-composer">
      <fetcher.Form method="post" encType="multipart/form-data" ref={formRef}>
        <input type="hidden" name="intent" value="reply-add" />
        <input type="hidden" name="parentId" value={target?.id || ""} />
        <input type="hidden" name="shopName" value={shopName} />
        <input type="hidden" name="replyAs" value={as} />
        <input type="hidden" name="personAvatar" value={person?.avatar || ""} />

        {target && (
          <div className="cv-target">
            <span>Replying to <b>{target.name}</b></span>
            <button type="button" className="cv-x" onClick={onDone}>cancel</button>
          </div>
        )}

        {as === "new" && (
          <div className="cv-new">
            <Avatar name="+" src={newPic || null} size="sm" />
            <input className="cv-input" name="newName" placeholder="New person's name" required />
            <input
              className="cv-file"
              type="file"
              name="newAvatar"
              accept="image/*"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                setNewPic(f ? URL.createObjectURL(f) : "");
              }}
            />
          </div>
        )}

        <div className="cv-line">
          <label className="cv-as" title="Reply as">
            <Avatar name={asName} src={as === "new" ? newPic || null : person?.avatar || null} store={as === "store"} size="sm" />
            <span className="cv-as-name">{asName}</span>
            <span className="cv-as-caret">▾</span>
            <select value={as} onChange={(e) => setAs(e.currentTarget.value)} aria-label="Reply as">
              <option value="store">{shopName} (store)</option>
              {people.map((p) => (
                <option key={p.name} value={`person:${p.name}`}>{p.name}</option>
              ))}
              <option value="new">+ New person…</option>
            </select>
          </label>
          <textarea
            ref={msgRef}
            className="cv-msg"
            name="replyText"
            rows={1}
            value={text}
            placeholder={target ? `Reply to ${target.name}…` : "Add a comment…"}
            onChange={(e) => {
              setText(e.currentTarget.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = Math.min(140, e.currentTarget.scrollHeight) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) formRef.current?.requestSubmit();
            }}
          />
          <button type="submit" className="cv-send" disabled={busy || !text.trim()} aria-label="Send">
            <svg viewBox="0 0 24 24"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          </button>
        </div>
        <div className="cv-hint">Ctrl + Enter to send</div>
      </fetcher.Form>
    </div>
  );
}
