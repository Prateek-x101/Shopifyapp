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
    });
    return { ok: true, message: "Comment updated" };
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
    helpful: existing?.helpful || 0,
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

      {!isNew && (
        <s-section slot="aside" heading={`Comments & replies (${countComments(r.replies || [])})`}>
          <ThreadSummary review={r} />
        </s-section>
      )}

      {!isNew && (
        <s-modal id="thread-modal" heading={`Conversation · ${r.author}`} size="large">
          <ReviewHeader review={r} />
          <s-divider />
          <div style={{ paddingTop: 8 }}>
            <Thread review={r} shopName={shopName} people={people} />
          </div>
        </s-modal>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

/* ───────────────────────── comments panel ───────────────────────── */

/** Right column: counts, the two latest messages and a button that opens the full conversation. */
function ThreadSummary({ review }: { review: any }) {
  const all: ReviewComment[] = [];
  const walk = (list: ReviewComment[]) => list.forEach((c) => { all.push(c); walk(c.replies || []); });
  walk(review.replies || []);
  const latest = [...all].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 2);
  const hidden = all.filter((c) => c.status === "hidden").length;

  return (
    <s-stack gap="base">
      {all.length === 0 ? (
        <s-text color="subdued">No comments yet. Start the conversation as the store or as a customer.</s-text>
      ) : (
        <>
          <s-stack direction="inline" gap="small-200">
            {review.needsReply && <s-badge tone="critical">Needs reply</s-badge>}
            {hidden > 0 && <s-badge tone="warning">{hidden} hidden</s-badge>}
          </s-stack>
          {latest.map((c) => (
            <s-stack key={c.id} direction="inline" gap="small-200" alignItems="start">
              <Who name={c.name} avatar={c.avatar} store={c.type === "store"} size="small-200" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <s-text type="strong">{c.name}</s-text>
                <div style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", color: "#4a4a4a", fontSize: 13, lineHeight: "18px" }}>
                  {c.text}
                </div>
              </div>
            </s-stack>
          ))}
        </>
      )}
      <s-button variant="primary" icon="chat" commandFor="thread-modal" command="--show">
        {all.length ? `Open conversation (${all.length})` : "Write a comment"}
      </s-button>
    </s-stack>
  );
}

/** Top of the conversation popup: the review itself. */
function ReviewHeader({ review }: { review: any }) {
  return (
    <div style={{ paddingBottom: 12 }}>
      <s-stack direction="inline" gap="base" alignItems="start">
        <Who name={review.author} avatar={review.avatar?.url} size="base" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <s-stack gap="small-300">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">{review.author}</s-text>
              <span style={{ color: "#e0261b", letterSpacing: 1 }}>{"★".repeat(review.rating)}<span style={{ color: "#d9d9d9" }}>{"★".repeat(5 - review.rating)}</span></span>
              {review.location && <s-text color="subdued">{review.location}</s-text>}
            </s-stack>
            <s-text>{review.body}</s-text>
          </s-stack>
        </div>
      </s-stack>
    </div>
  );
}

function Thread({ review, shopName, people }: { review: any; shopName: string; people: { name: string; avatar: string | null }[] }) {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const replies: ReviewComment[] = review.replies || [];

  const replyTo = (n: ReviewComment) => {
    setTarget({ id: n.id, name: n.name });
    setTimeout(() => composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  return (
    <s-stack gap="base">
      {replies.length === 0 && <s-text color="subdued">No comments yet.</s-text>}
      {replies.map((c) => (
        <Node key={c.id} node={c} depth={0} onReply={replyTo} />
      ))}
      <div ref={composerRef}>
        <Composer
          key={target?.id || "top"}
          target={target}
          onDone={() => setTarget(null)}
          shopName={shopName}
          people={people}
          reviewer={review.author}
        />
      </div>
    </s-stack>
  );
}

function Who({ name, avatar, store, size = "small" }: { name: string; avatar?: string | null; store?: boolean; size?: any }) {
  return (
    <s-avatar
      size={size}
      initials={store ? "✓" : initials(name)}
      alt={name}
      {...(avatar ? { src: avatar } : {})}
    />
  );
}

function Node({ node, depth, onReply }: { node: ReviewComment; depth: number; onReply: (n: ReviewComment) => void }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [editing, setEditing] = useState(false);
  const busy = fetcher.state !== "idle";
  const hidden = node.status === "hidden";
  const store = node.type === "store";

  useEffect(() => {
    const d: any = fetcher.data;
    if (d?.message) { shopify.toast.show(d.message, { isError: d.ok === false }); if (d.ok) setEditing(false); }
  }, [fetcher.data, shopify]);

  const send = (data: Record<string, string>) => fetcher.submit({ commentId: node.id, ...data }, { method: "POST" });
  const when = new Date(node.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <div style={{ marginLeft: depth ? 14 : 0, paddingLeft: depth ? 12 : 0, borderLeft: depth ? "2px solid #e3e3e3" : "none" }}>
      <div style={{ opacity: hidden ? 0.55 : 1, padding: "8px 0" }}>
        <s-stack direction="inline" gap="small-200" alignItems="start">
          <Who name={node.name} avatar={node.avatar} store={store} size={depth ? "small-200" : "small"} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <s-stack gap="small-300">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text type="strong">{node.name}</s-text>
                {store && <s-badge tone="info">Store</s-badge>}
                {hidden && <s-badge tone="warning">Hidden</s-badge>}
                <s-text color="subdued">{when}</s-text>
                {node.likeCount > 0 && <s-text color="subdued">👍 {node.likeCount}</s-text>}
              </s-stack>

              {editing ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="comment-edit" />
                  <input type="hidden" name="commentId" value={node.id} />
                  <s-stack gap="small-200">
                    <s-text-field label="Name" name="name" defaultValue={node.name} />
                    <s-text-area label="Text" name="text" rows={3} defaultValue={node.text} />
                    <s-stack direction="inline" gap="small-200">
                      <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>Save</s-button>
                      <s-button variant="tertiary" onClick={() => setEditing(false)}>Cancel</s-button>
                    </s-stack>
                  </s-stack>
                </fetcher.Form>
              ) : (
                <s-text>{node.text}</s-text>
              )}

              {!editing && (
                <s-stack direction="inline" gap="small-100">
                  <s-button variant="tertiary" icon="chat" onClick={() => onReply(node)}>Reply</s-button>
                  <s-button variant="tertiary" icon="edit" onClick={() => setEditing(true)}>Edit</s-button>
                  <s-button
                    variant="tertiary"
                    icon={hidden ? "view" : "hide"}
                    onClick={() => send({ intent: "comment-status", status: hidden ? "approved" : "hidden" })}
                    {...(busy ? { disabled: true } : {})}
                  >
                    {hidden ? "Show" : "Hide"}
                  </s-button>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    icon="delete"
                    accessibilityLabel="Delete"
                    onClick={() => { if (confirm("Delete this and its replies?")) send({ intent: "comment-delete" }); }}
                  />
                </s-stack>
              )}
            </s-stack>
          </div>
        </s-stack>
      </div>
      {(node.replies || []).map((c) => (
        <Node key={c.id} node={c} depth={depth + 1} onReply={onReply} />
      ))}
    </div>
  );
}

function Composer({
  target,
  onDone,
  shopName,
  people,
  reviewer,
}: {
  target: { id: string; name: string } | null;
  onDone: () => void;
  shopName: string;
  people: { name: string; avatar: string | null }[];
  reviewer: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const [as, setAs] = useState<string>("store");
  const [newPic, setNewPic] = useState<string>("");
  const busy = fetcher.state !== "idle";
  const person = as.startsWith("person:") ? people.find((p) => `person:${p.name}` === as) : null;

  useEffect(() => {
    const d: any = fetcher.data;
    if (!d?.message) return;
    shopify.toast.show(d.message, { isError: d.ok === false });
    if (d.ok) {
      formRef.current?.reset();
      setNewPic("");
      onDone();
    }
  }, [fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = as === "store" ? shopName : as === "new" ? "a new person" : as.slice(7);

  return (
    <s-box padding="base" border="base" borderRadius="base" background="subdued">
      <fetcher.Form method="post" encType="multipart/form-data" ref={formRef}>
        <input type="hidden" name="intent" value="reply-add" />
        <input type="hidden" name="parentId" value={target?.id || ""} />
        <input type="hidden" name="shopName" value={shopName} />
        <input type="hidden" name="replyAs" value={as} />
        <input type="hidden" name="personAvatar" value={person?.avatar || ""} />
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{target ? `Reply to ${target.name}` : `Comment on ${reviewer}'s review`}</s-text>
            {target && <s-button variant="tertiary" onClick={onDone}>Cancel</s-button>}
          </s-stack>

          <s-select label="Reply as" value={as} onChange={(e: any) => setAs(e.currentTarget.value)}>
            <s-option value="store">{shopName} (store)</s-option>
            {people.map((p) => (
              <s-option key={p.name} value={`person:${p.name}`}>{p.name}</s-option>
            ))}
            <s-option value="new">+ New person…</s-option>
          </s-select>

          {as === "new" && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-avatar size="small" initials="+" alt="New person" {...(newPic ? { src: newPic } : {})} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <s-stack gap="small-200">
                  <s-text-field label="Name" name="newName" placeholder="e.g. Aman Verma" />
                  <input
                    type="file"
                    name="newAvatar"
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.currentTarget.files?.[0];
                      setNewPic(f ? URL.createObjectURL(f) : "");
                    }}
                  />
                </s-stack>
              </div>
            </s-stack>
          )}

          <s-text-area label={`Message as ${label}`} name="replyText" rows={3} placeholder={target ? `Reply to ${target.name}…` : "Write a comment…"} />
          <s-stack direction="inline" justifyContent="end">
            <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
              {target ? "Post reply" : "Post comment"}
            </s-button>
          </s-stack>
        </s-stack>
      </fetcher.Form>
    </s-box>
  );
}
