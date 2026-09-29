import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  deleteReview,
  gql,
  importReviews,
  listReviews,
  patchReview,
  recomputeSummary,
  reviewIdsMatching,
} from "../lib/reviews.server";
import type { ReviewFilters } from "../lib/reviews.server";
import { countComments, normalizeComments } from "../lib/reviews.shared";
import type { BulkItem, ReviewComment } from "../lib/reviews.shared";
import { ReviewHeader, Thread, initials, peopleOf } from "../components/review-thread";
import { BulkUpload } from "../components/bulk-upload";
import { getModeration, isAbusive } from "../lib/moderation.server";

/** Filters come from the URL, so the loader and "select all matching" use exactly the same set. */
function filtersFrom(sp: URLSearchParams, shop: string, productId: string): ReviewFilters {
  return {
    shop,
    productId,
    status: sp.get("status") || "all",
    rating: sp.get("rating") ? parseInt(sp.get("rating")!, 10) : undefined,
    media: sp.get("media") === "1",
    customer: sp.get("customer") === "1",
    flagged: sp.get("flagged") === "1",
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    q: sp.get("q") || undefined,
  };
}

const countPending = (list: ReviewComment[]): number =>
  list.reduce((n, c) => n + (c.status === "pending" ? 1 : 0) + countPending(c.replies || []), 0);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = params.productId!;
  const sp = new URL(request.url).searchParams;
  const base = { shop: session.shop, productId };

  const [prod, list, counts, customerCount, flaggedCount, mod] = await Promise.all([
    gql(admin, `query($id: ID!) { product(id: $id) { id title handle onlineStoreUrl featuredMedia { preview { image { url } } } } shop { name } }`, {
      id: `gid://shopify/Product/${productId}`,
    }),
    listReviews({ ...filtersFrom(sp, session.shop, productId), page: parseInt(sp.get("page") || "1", 10), sort: (sp.get("sort") as any) || "newest" }),
    prisma.review.groupBy({ by: ["status"], where: base, _count: true }),
    prisma.review.count({ where: { ...base, source: "Website" } }),
    prisma.review.count({ where: { ...base, replies: { contains: '"status":"pending"' } } }),
    getModeration(admin, session.shop),
  ]);
  if (!prod.product) throw new Response("Product not found", { status: 404 });
  const byStatus: Record<string, number> = { published: 0, pending: 0, hidden: 0 };
  counts.forEach((c: any) => (byStatus[c.status] = c._count));

  return {
    product: {
      id: productId,
      title: prod.product.title,
      image: prod.product.featuredMedia?.preview?.image?.url || "",
      url: prod.product.onlineStoreUrl,
    },
    shopName: prod.shop.name as string,
    byStatus,
    customerCount,
    flaggedCount,
    list: {
      ...list,
      rows: list.rows.map((r) => {
        const thread = normalizeComments(JSON.parse(r.replies));
        return {
          id: r.id,
          rating: r.rating,
          title: r.title,
          body: r.body,
          author: r.author,
          location: r.location,
          status: r.status,
          verified: r.verified,
          source: r.source,
          orderId: r.orderId,
          featured: r.featured,
          helpful: r.helpful,
          media: (JSON.parse(r.images) as { url: string; kind?: string; poster?: string }[])
            .filter((i) => i.url)
            .map((i) => ({ url: i.url, kind: i.kind === "video" ? "video" : "image", poster: i.poster || "" })),
          avatar: r.avatar ? (JSON.parse(r.avatar) as { id: string; url: string }) : null,
          thread,
          replies: countComments(thread),
          pendingComments: countPending(thread),
          abusive: isAbusive(`${r.author} ${r.title || ""} ${r.body} ${r.location || ""}`, mod.extra_words),
          needsReply: r.needsReply,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = params.productId!;
  const fd = await request.formData();
  const intent = fd.get("intent") as string;
  const id = fd.get("id") as string;

  if (intent === "bulk-import") {
    let items: BulkItem[] = [];
    try { items = JSON.parse(String(fd.get("payload") || "[]")); } catch { return { ok: false, message: "Could not read the reviews" }; }
    if (!Array.isArray(items) || !items.length) return { ok: false, message: "Nothing to import" };
    const status = ["published", "pending", "hidden"].includes(String(fd.get("status"))) ? String(fd.get("status")) : "published";
    const r = await importReviews(admin, session.shop, productId, items, {
      status,
      verified: fd.get("verified") === "true",
      spreadDays: Math.max(0, Math.min(365, parseInt(String(fd.get("spreadDays") || "0"), 10) || 0)),
    });
    const bits = [`${r.created} review${r.created === 1 ? "" : "s"} added`];
    if (r.failed.length) bits.push(`${r.failed.length} failed`);
    if (r.photoMisses) bits.push(`${r.photoMisses} photo${r.photoMisses === 1 ? "" : "s"} could not be fetched`);
    if (r.skipped) bits.push(`${r.skipped} over the 200 limit`);
    return { ok: r.created > 0, message: bits.join(" · "), failed: r.failed.slice(0, 20) };
  }

  if (intent === "bulk") {
    const op = String(fd.get("op") || "");
    let ids: string[] = [];
    if (fd.get("scope") === "all") {
      // every review matching the filters the admin is looking at (all pages)
      ids = await reviewIdsMatching(filtersFrom(new URLSearchParams(String(fd.get("filters") || "")), session.shop, productId));
    } else {
      try { ids = (JSON.parse(String(fd.get("ids") || "[]")) as string[]).filter((x) => typeof x === "string").slice(0, 1000); } catch { ids = []; }
    }
    if (!ids.length) return { ok: false, message: "Select reviews first" };
    const own = await prisma.review.findMany({ where: { shop: session.shop, productId, id: { in: ids } }, select: { id: true } });
    const quiet = { skipSummary: true }; // the summary is recomputed once at the end
    const run = async (rid: string) => {
      if (op === "delete") return deleteReview(admin, session.shop, rid, quiet);
      if (op === "published" || op === "pending" || op === "hidden") return patchReview(admin, session.shop, rid, { status: op }, quiet);
      if (op === "pin" || op === "unpin") return patchReview(admin, session.shop, rid, { featured: op === "pin" }, quiet);
      if (op === "verified" || op === "unverified") return patchReview(admin, session.shop, rid, { verified: op === "verified" }, quiet);
      throw new Error("Unknown action");
    };
    let done = 0;
    let failed = 0;
    for (let i = 0; i < own.length; i += 5) {
      const res = await Promise.allSettled(own.slice(i, i + 5).map((r) => run(r.id)));
      res.forEach((x) => (x.status === "fulfilled" ? done++ : failed++));
    }
    await recomputeSummary(admin, session.shop, productId);
    const verb: Record<string, string> = {
      delete: "deleted", published: "published", pending: "moved to pending", hidden: "hidden", pin: "pinned", unpin: "unpinned",
      verified: "marked verified", unverified: "marked not verified",
    };
    return { ok: done > 0, message: `${done} review${done === 1 ? "" : "s"} ${verb[op] || "updated"}${failed ? ` · ${failed} failed` : ""}` };
  }

  if (intent === "delete") {
    await deleteReview(admin, session.shop, id);
    return { ok: true, message: "Review deleted", deleted: id };
  }
  if (intent === "status") {
    const status = fd.get("status") as string;
    await patchReview(admin, session.shop, id, { status });
    return { ok: true, message: status === "published" ? "Published" : status === "hidden" ? "Hidden" : "Moved to pending" };
  }
  if (intent === "pin") {
    await patchReview(admin, session.shop, id, { featured: fd.get("featured") === "true" });
    return { ok: true, message: fd.get("featured") === "true" ? "Pinned to top" : "Unpinned" };
  }
  if (intent === "verify") {
    await patchReview(admin, session.shop, id, { verified: fd.get("verified") === "true" });
    return { ok: true, message: fd.get("verified") === "true" ? "Marked as verified buyer" : "Verified badge removed" };
  }
  return { ok: false, message: "Unknown action" };
};

/* ───────────────────────── helpers ───────────────────────── */
type Row = ReturnType<typeof useLoaderData<typeof loader>>["list"]["rows"][number];

const statusTone: Record<string, "success" | "warning" | "neutral"> = { published: "success", pending: "warning", hidden: "neutral" };
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const dayStr = (daysAgo: number) => new Date(Date.now() + 5.5 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
const editUrl = (productId: string, rid: string) => `/app/reviews/${productId}/${encodeURIComponent(rid.split("/").pop() || "")}`;
const isLong = (t: string) => t.length > 220 || t.split("\n").length > 3;

/** Opens an s-modal from code (thumbnail / avatar / "Read more" clicks). */
function showModal(id: string) {
  const el: any = document.getElementById(id);
  if (el?.showOverlay) el.showOverlay();
  else (document.getElementById(`${id}-opener`) as any)?.click?.();
}
function hideModal(id: string) {
  (document.getElementById(id) as any)?.hideOverlay?.();
}

function Stars({ n }: { n: number }) {
  return (
    <span className="rv-stars" aria-label={`${n} stars`}>
      {"★".repeat(n)}
      <i>{"★".repeat(5 - n)}</i>
    </span>
  );
}

const CSS = `
.rv-check { width: 16px; height: 16px; margin: 0; accent-color: #303030; cursor: pointer; vertical-align: middle; }
.rv-stars { color: #f5a623; letter-spacing: 1px; white-space: nowrap; font-size: 13px; }
.rv-stars i { color: #dcdcdc; font-style: normal; }

/* filters */
.rv-filters { display: grid; gap: 10px; }
.rv-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rv-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid #dcdcdc; border-radius: 999px;
  background: #fff; color: #303030; font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.rv-chip:hover { border-color: #b5b5b5; background: #fafafa; }
.rv-chip.on { background: #303030; border-color: #303030; color: #fff; }
.rv-chip .n { font-size: 11px; opacity: .7; }
.rv-chip.alert:not(.on) .n { color: #b42318; opacity: 1; font-weight: 600; }
.rv-date { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 4px 0 10px; border: 1px solid #dcdcdc; border-radius: 999px;
  background: #fff; font-size: 12.5px; color: #616161; }
.rv-date.on { border-color: #303030; }
.rv-date input { border: 0; background: transparent; font: inherit; font-size: 12.5px; color: #303030; padding: 2px; }
.rv-date input:focus { outline: none; }
.rv-date select { border: 0; background: transparent; font: inherit; font-size: 12.5px; color: #303030; cursor: pointer; }
.rv-sep { width: 1px; height: 18px; background: #e3e3e3; }
.rv-clear { border: 0; background: none; font: inherit; font-size: 12.5px; color: #616161; text-decoration: underline; cursor: pointer; padding: 0 4px; }

/* bulk bar */
.rv-bulkbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: #f3f3f3; font-size: 13px; }
.rv-bulk-count { font-weight: 600; color: #1f1f1f; }
.rv-link { border: 0; background: none; padding: 0; font: inherit; color: #1f1f1f; text-decoration: underline; cursor: pointer; }
.rv-link.muted { color: #616161; }
.rv-sp { flex: 1; }

/* rows */
.rv-body { margin: 0; color: #303030; font-size: 13px; line-height: 19px; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; max-width: 560px; }
.rv-more { border: 0; background: none; padding: 0; font: inherit; font-size: 12.5px; font-weight: 600; color: #303030; cursor: pointer; text-decoration: underline; }
.rv-thumbs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.rv-thumb { position: relative; width: 44px; height: 44px; padding: 0; border: 1px solid #e3e3e3; border-radius: 8px; overflow: hidden; cursor: zoom-in; background: #f3f3f3; }
.rv-thumb img, .rv-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.rv-thumb:hover { border-color: #8a8a8a; }
.rv-thumb .play { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 14px; background: rgba(0,0,0,.25); }
.rv-thumb-more { font-size: 12px; color: #616161; }
.rv-who { display: flex; align-items: center; gap: 8px; }
.rv-av { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; border: 0; padding: 0; overflow: hidden; display: grid; place-items: center;
  background: #f1f1f1; color: #616161; font: 600 11.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.06); cursor: zoom-in; }
.rv-av img { width: 100%; height: 100%; object-fit: cover; }
.rv-av:hover { box-shadow: 0 0 0 2px #fff, 0 0 0 3px #8a8a8a; }
.rv-name { font-size: 13px; color: #1f1f1f; }
.rv-city { font-size: 12px; color: #8a8a8a; }
.rv-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #b42318; font-weight: 600; }

/* review popup */
.rp { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #303030; }
.rp-stage { position: relative; height: min(52vh, 460px); border-radius: 12px; background: #111; overflow: hidden; display: grid; place-items: center; }
.rp-stage img, .rp-stage video { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.rp-stage img.round { width: min(46vh, 380px); height: min(46vh, 380px); max-width: none; object-fit: cover; border-radius: 50%; }
.rp-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; border: 0; border-radius: 50%;
  background: rgba(255,255,255,.9); color: #1f1f1f; font-size: 18px; cursor: pointer; display: grid; place-items: center; }
.rp-nav.prev { left: 10px; } .rp-nav.next { right: 10px; }
.rp-count { position: absolute; right: 10px; bottom: 10px; padding: 2px 8px; border-radius: 999px; background: rgba(0,0,0,.55); color: #fff; font-size: 11.5px; }
.rp-open { position: absolute; left: 10px; bottom: 10px; padding: 3px 9px; border-radius: 999px; background: rgba(0,0,0,.55); color: #fff; font-size: 11.5px; text-decoration: none; }
.rp-strip { display: flex; gap: 6px; margin-top: 8px; overflow-x: auto; }
.rp-strip button { flex-shrink: 0; width: 52px; height: 52px; padding: 0; border: 2px solid transparent; border-radius: 8px; overflow: hidden; cursor: pointer; background: #f3f3f3; }
.rp-strip button.on { border-color: #303030; }
.rp-strip img, .rp-strip video { width: 100%; height: 100%; object-fit: cover; display: block; }
.rp-strip .round { border-radius: 50%; }
.rp-head { display: flex; gap: 12px; align-items: center; margin: 16px 0 10px; }
.rp-head .rv-av { width: 44px; height: 44px; font-size: 14px; }
.rp-name { font-weight: 600; font-size: 15px; color: #1f1f1f; }
.rp-meta { font-size: 12.5px; color: #8a8a8a; margin-top: 2px; }
.rp-title { font-weight: 600; font-size: 14px; margin: 4px 0; }
.rp-text { font-size: 14px; line-height: 22px; color: #303030; white-space: pre-wrap; word-break: break-word; }
.rp-facts { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 12px; font-size: 12.5px; color: #616161; }
.rp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid #f1f1f1; }
.rp-seg { display: inline-flex; border: 1px solid #dcdcdc; border-radius: 8px; overflow: hidden; }
.rp-seg button { border: 0; background: #fff; padding: 6px 12px; font: inherit; font-size: 12.5px; color: #303030; cursor: pointer; }
.rp-seg button + button { border-left: 1px solid #dcdcdc; }
.rp-seg button.on { background: #303030; color: #fff; }
.rp-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid #dcdcdc; border-radius: 8px;
  background: #fff; color: #303030; font: inherit; font-size: 12.5px; cursor: pointer; text-decoration: none; }
.rp-btn:hover { border-color: #b5b5b5; background: #fafafa; }
.rp-btn.on { background: #f1f1f1; }
.rp-btn.danger { color: #b42318; }
.rp-btn.danger:hover { background: #fdf2f2; border-color: #f0c2bd; }
.rp-btn[disabled] { opacity: .5; cursor: default; }
`;

/* ───────────────────────── row actions ───────────────────────── */
function RowActions({ r, productId }: { r: Row; productId: string }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    const d: any = fetcher.data;
    if (d?.message) shopify.toast.show(d.message, { isError: d.ok === false });
  }, [fetcher.data, shopify]);
  const send = (data: Record<string, string>) => fetcher.submit({ id: r.id, ...data }, { method: "POST" });

  return (
    <s-stack direction="inline" gap="small-200" justifyContent="end">
      {r.status !== "published" ? (
        <s-button variant="primary" onClick={() => send({ intent: "status", status: "published" })} {...(busy ? { loading: true } : {})}>
          Publish
        </s-button>
      ) : (
        <s-button onClick={() => send({ intent: "status", status: "hidden" })} {...(busy ? { disabled: true } : {})}>Hide</s-button>
      )}
      <s-button
        variant="tertiary"
        icon="pin"
        tone={r.featured ? "auto" : undefined}
        accessibilityLabel={r.featured ? "Unpin" : "Pin to top"}
        onClick={() => send({ intent: "pin", featured: String(!r.featured) })}
      />
      <s-button variant="tertiary" icon="edit" accessibilityLabel="Edit" href={editUrl(productId, r.id)} />
      <s-button
        variant="tertiary"
        tone="critical"
        icon="delete"
        accessibilityLabel="Delete"
        onClick={() => { if (confirm("Delete this review permanently?")) send({ intent: "delete" }); }}
      />
    </s-stack>
  );
}

/* ───────────────────────── review popup (read more / photos / avatar) ───────────────────────── */
type ViewItem = { url: string; kind: string; poster?: string };

function ReviewView({
  r,
  mode,
  start,
  productId,
  onConversation,
}: {
  r: Row;
  mode: "avatar" | "media" | "text";
  start: number;
  productId: string;
  onConversation: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const items: ViewItem[] = [
    ...(mode === "avatar" && r.avatar?.url ? [{ url: r.avatar.url, kind: "avatar" }] : []),
    ...r.media,
  ];
  const [i, setI] = useState(Math.min(start, Math.max(0, items.length - 1)));
  const cur = items[i];
  const showStage = items.length > 0 && (mode !== "text" || r.media.length > 0);

  useEffect(() => {
    const d: any = fetcher.data;
    if (!d?.message) return;
    shopify.toast.show(d.message, { isError: d.ok === false });
    if (d.deleted) hideModal("review-modal");
  }, [fetcher.data, shopify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (items.length < 2) return;
      if (e.key === "ArrowRight") setI((x) => (x + 1) % items.length);
      if (e.key === "ArrowLeft") setI((x) => (x - 1 + items.length) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length]);

  const send = (data: Record<string, string>) => fetcher.submit({ id: r.id, ...data }, { method: "POST" });
  const pending = fetcher.formData;
  const status = pending?.get("intent") === "status" ? String(pending.get("status")) : r.status;
  const featured = pending?.get("intent") === "pin" ? pending.get("featured") === "true" : r.featured;
  const verified = pending?.get("intent") === "verify" ? pending.get("verified") === "true" : r.verified;

  return (
    <div className="rp">
      {showStage && cur && (
        <>
          <div className="rp-stage">
            {cur.kind === "video" ? (
              <video key={cur.url} src={cur.url} poster={cur.poster || undefined} controls playsInline autoPlay muted />
            ) : (
              <img key={cur.url} src={cur.url} alt="" className={cur.kind === "avatar" ? "round" : undefined} />
            )}
            {items.length > 1 && (
              <>
                <button type="button" className="rp-nav prev" aria-label="Previous" onClick={() => setI((i - 1 + items.length) % items.length)}>‹</button>
                <button type="button" className="rp-nav next" aria-label="Next" onClick={() => setI((i + 1) % items.length)}>›</button>
                <span className="rp-count">{i + 1} / {items.length}</span>
              </>
            )}
            <a className="rp-open" href={cur.url} target="_blank" rel="noreferrer">Open original ↗</a>
          </div>
          {items.length > 1 && (
            <div className="rp-strip">
              {items.map((m, k) => (
                <button key={m.url + k} type="button" className={k === i ? "on" : ""} onClick={() => setI(k)} aria-label={`Show ${k + 1}`}>
                  {m.kind === "video" ? <video src={m.url} poster={m.poster || undefined} muted /> : <img src={m.url} alt="" className={m.kind === "avatar" ? "round" : undefined} />}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="rp-head">
        <span className="rv-av" aria-hidden="true">{r.avatar?.url ? <img src={r.avatar.url} alt="" /> : initials(r.author)}</span>
        <div>
          <div className="rp-name">{r.author}</div>
          <div className="rp-meta">
            <Stars n={r.rating} /> · {[r.location, fmtDate(r.createdAt)].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      {r.abusive && (
        <div className="rv-flag" style={{ margin: "0 0 6px" }}>⚑ Contains abusive words — it stays off the store until you publish it</div>
      )}
      {r.title && <div className="rp-title">{r.title}</div>}
      <div className="rp-text">{r.body}</div>
      <div className="rp-facts">
        <span>{verified ? "✓ Verified buyer" : "Not verified"}</span>
        {r.orderId && <span>Order {r.orderId}</span>}
        <span>Source: {r.source}</span>
        <span>♥ {r.helpful} helpful</span>
        <span>{r.replies} comment{r.replies === 1 ? "" : "s"}{r.pendingComments ? ` · ${r.pendingComments} waiting` : ""}</span>
      </div>

      <div className="rp-actions">
        <div className="rp-seg" role="group" aria-label="Status">
          {(["published", "pending", "hidden"] as const).map((s) => (
            <button key={s} type="button" className={status === s ? "on" : ""} disabled={busy} onClick={() => status !== s && send({ intent: "status", status: s })}>
              {s === "published" ? "Published" : s === "pending" ? "Pending" : "Hidden"}
            </button>
          ))}
        </div>
        <button type="button" className={`rp-btn${featured ? " on" : ""}`} disabled={busy} onClick={() => send({ intent: "pin", featured: String(!featured) })}>
          📌 {featured ? "Pinned" : "Pin"}
        </button>
        <button type="button" className={`rp-btn${verified ? " on" : ""}`} disabled={busy} onClick={() => send({ intent: "verify", verified: String(!verified) })}>
          ✓ {verified ? "Verified" : "Mark verified"}
        </button>
        <button type="button" className="rp-btn" onClick={onConversation}>💬 Conversation</button>
        <a className="rp-btn" href={editUrl(productId, r.id)}>✎ Edit</a>
        <span className="rv-sp" />
        <button type="button" className="rp-btn danger" disabled={busy} onClick={() => { if (confirm("Delete this review permanently?")) send({ intent: "delete" }); }}>
          Delete
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── page ───────────────────────── */
export default function ProductReviews() {
  const { product, shopName, byStatus, customerCount, flaggedCount, list } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const status = params.get("status") || "all";

  // popups
  const [threadId, setThreadId] = useState<string | null>(null);
  const [view, setView] = useState<{ id: string; mode: "avatar" | "media" | "text"; start: number; n: number } | null>(null);
  const threadRow = list.rows.find((r) => r.id === threadId) || null;
  const threadReview = threadRow ? { ...threadRow, replies: threadRow.thread } : null;
  const viewRow = view ? list.rows.find((r) => r.id === view.id) || null : null;
  const openView = (id: string, mode: "avatar" | "media" | "text", start = 0) => {
    setView((v) => ({ id, mode, start, n: (v?.n || 0) + 1 }));
    showModal("review-modal");
  };
  const openThread = (id: string) => {
    setThreadId(id);
    hideModal("review-modal");
    showModal("list-thread-modal");
  };

  // selection: rows on this page, or every review matching the filters
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const pageIds = list.rows.map((r) => r.id);
  const pageKey = pageIds.join(",") + "|" + params.toString();
  useEffect(() => {
    setSelected((cur) => new Set([...cur].filter((x) => pageIds.includes(x))));
    setAllMatching(false);
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const allOn = pageIds.length > 0 && pageIds.every((x) => selected.has(x));
  const someOn = selected.size > 0 && !allOn;
  const count = allMatching ? list.total : selected.size;
  const toggle = (rid: string) => {
    setAllMatching(false);
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(rid)) n.delete(rid); else n.add(rid);
      return n;
    });
  };
  const clearSel = () => { setSelected(new Set()); setAllMatching(false); };

  const bulk = useFetcher<typeof action>();
  const bulkBusy = bulk.state !== "idle";
  const bulkOp = bulk.formData?.get("op");
  useEffect(() => {
    const d: any = bulk.data;
    if (!d?.message) return;
    shopify.toast.show(d.message, { isError: d.ok === false });
    if (d.ok) clearSel();
  }, [bulk.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps
  const runBulk = (op: string) => {
    if (op === "delete" && !confirm(`Delete ${count} review${count === 1 ? "" : "s"} permanently? This cannot be undone.`)) return;
    if (allMatching && count > 50 && op !== "delete" && !confirm(`Apply to all ${count} reviews?`)) return;
    const f = new URLSearchParams(params);
    f.delete("page");
    bulk.submit(
      allMatching ? { intent: "bulk", op, scope: "all", filters: f.toString() } : { intent: "bulk", op, ids: JSON.stringify([...selected]) },
      { method: "POST" },
    );
  };
  const bb = (op: string) => ({ ...(bulkBusy ? (bulkOp === op ? { loading: true } : { disabled: true }) : {}) });

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v === null || v === "" ? p.delete(k) : p.set(k, v)));
    if (!("page" in next)) p.delete("page");
    navigate(`/app/reviews/${product.id}?${p.toString()}`);
  };
  const flag = (k: string) => params.get(k) === "1";
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const preset = from && !to ? ({ [dayStr(7)]: "7", [dayStr(30)]: "30", [dayStr(90)]: "90" } as Record<string, string>)[from] || "" : "";
  const anyFilter = ["q", "rating", "media", "customer", "flagged", "from", "to"].some((k) => params.get(k));

  const tabs: [string, string][] = [
    ["all", `All (${byStatus.published + byStatus.pending + byStatus.hidden})`],
    ["published", `Published (${byStatus.published})`],
    ["pending", `Pending (${byStatus.pending})`],
    ["hidden", `Hidden (${byStatus.hidden})`],
  ];

  return (
    <s-page heading={product.title} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/reviews">Reviews</s-link>
      <s-button slot="primary-action" variant="primary" href={`/app/reviews/${product.id}/new`}>Add review</s-button>
      <s-button slot="secondary-actions" icon="upload" commandFor="bulk-modal" command="--show">Bulk upload</s-button>
      {product.url && (
        <s-button slot="secondary-actions" href={product.url} target="_blank">View on store</s-button>
      )}
      <BulkUpload />
      <style>{CSS}</style>

      <s-section padding="none">
        <s-table
          paginate
          hasNextPage={list.page < list.pages}
          hasPreviousPage={list.page > 1}
          onNextPage={() => go({ page: String(list.page + 1) })}
          onPreviousPage={() => go({ page: String(list.page - 1) })}
        >
          <div slot="filters" className="rv-filters">
            <s-stack direction="inline" gap="small-200">
              {tabs.map(([key, label]) => (
                <s-button key={key} variant={status === key ? "primary" : "secondary"} onClick={() => go({ status: key === "all" ? null : key })}>
                  {label}
                </s-button>
              ))}
            </s-stack>

            <s-grid gridTemplateColumns="1fr 150px 170px" gap="small-200">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  go({ q: (new FormData(e.currentTarget).get("q") as string) || null });
                }}
              >
                <s-search-field name="q" label="Search reviews" labelAccessibilityVisibility="exclusive" placeholder="Search text, name or city" defaultValue={params.get("q") || ""} />
              </form>
              <s-select label="Stars" labelAccessibilityVisibility="exclusive" value={params.get("rating") || ""} onChange={(e: any) => go({ rating: e.currentTarget.value || null })}>
                <s-option value="">All stars</s-option>
                {[5, 4, 3, 2, 1].map((n) => <s-option key={n} value={String(n)}>{n} stars</s-option>)}
              </s-select>
              <s-select label="Sort" labelAccessibilityVisibility="exclusive" value={params.get("sort") || "newest"} onChange={(e: any) => go({ sort: e.currentTarget.value })}>
                <s-option value="newest">Newest</s-option>
                <s-option value="oldest">Oldest</s-option>
                <s-option value="highest">Highest rating</s-option>
                <s-option value="lowest">Lowest rating</s-option>
                <s-option value="helpful">Most helpful</s-option>
              </s-select>
            </s-grid>

            <div className="rv-row">
              <button type="button" className={`rv-chip${flag("media") ? " on" : ""}`} onClick={() => go({ media: flag("media") ? null : "1" })}>
                🖼 With photos
              </button>
              <button type="button" className={`rv-chip${flag("customer") ? " on" : ""}`} onClick={() => go({ customer: flag("customer") ? null : "1" })}>
                👤 Customer reviews <span className="n">{customerCount}</span>
              </button>
              <button
                type="button"
                className={`rv-chip alert${flag("flagged") ? " on" : ""}`}
                onClick={() => go({ flagged: flag("flagged") ? null : "1" })}
                title="Comments with abusive words wait here for your approval"
              >
                ⚑ Comments waiting <span className="n">{flaggedCount}</span>
              </button>
              <span className="rv-sep" />
              <label className={`rv-date${from || to ? " on" : ""}`}>
                📅
                <select value={preset} onChange={(e) => {
                  const v = e.currentTarget.value;
                  go(v ? { from: dayStr(parseInt(v, 10)), to: null } : { from: null, to: null });
                }} aria-label="Date range">
                  <option value="">{from || to ? "Custom" : "Any date"}</option>
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                </select>
              </label>
              <label className={`rv-date${from ? " on" : ""}`}>
                From <input type="date" value={from} max={to || undefined} onChange={(e) => go({ from: e.currentTarget.value || null })} />
              </label>
              <label className={`rv-date${to ? " on" : ""}`}>
                To <input type="date" value={to} min={from || undefined} onChange={(e) => go({ to: e.currentTarget.value || null })} />
              </label>
              {anyFilter && (
                <button type="button" className="rv-clear" onClick={() => go({ q: null, rating: null, media: null, customer: null, flagged: null, from: null, to: null })}>
                  Clear filters
                </button>
              )}
            </div>

            {count > 0 && (
              <div className="rv-bulkbar">
                <span className="rv-bulk-count">
                  {allMatching ? `All ${list.total} matching reviews selected` : `${selected.size} selected`}
                </span>
                {!allMatching && allOn && list.total > pageIds.length && (
                  <button type="button" className="rv-link" onClick={() => setAllMatching(true)}>
                    Select all {list.total} reviews
                  </button>
                )}
                <button type="button" className="rv-link muted" onClick={clearSel}>Clear</button>
                <span className="rv-sp" />
                <s-button onClick={() => runBulk("published")} {...bb("published")}>Publish</s-button>
                <s-button onClick={() => runBulk("hidden")} {...bb("hidden")}>Hide</s-button>
                <s-button onClick={() => runBulk("pending")} {...bb("pending")}>Pending</s-button>
                <s-button onClick={() => runBulk("verified")} {...bb("verified")}>Mark verified</s-button>
                <s-button icon="pin" onClick={() => runBulk("pin")} {...bb("pin")}>Pin</s-button>
                <s-button onClick={() => runBulk("unpin")} {...bb("unpin")}>Unpin</s-button>
                <s-button tone="critical" icon="delete" onClick={() => runBulk("delete")} {...bb("delete")}>Delete</s-button>
              </div>
            )}
          </div>

          <s-table-header-row>
            <s-table-header>
              <input
                type="checkbox"
                className="rv-check"
                aria-label="Select all on this page"
                checked={allOn}
                ref={(el) => { if (el) el.indeterminate = someOn; }}
                onChange={() => { setAllMatching(false); setSelected(allOn ? new Set() : new Set(pageIds)); }}
              />
            </s-table-header>
            <s-table-header listSlot="primary">Review</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Date</s-table-header>
            <s-table-header format="numeric">Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {list.rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>
                  <input
                    type="checkbox"
                    className="rv-check"
                    aria-label={`Select review by ${r.author}`}
                    checked={allMatching || selected.has(r.id)}
                    onChange={() => {
                      if (allMatching) { setAllMatching(false); setSelected(new Set(pageIds.filter((x) => x !== r.id))); }
                      else toggle(r.id);
                    }}
                  />
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-200">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <Stars n={r.rating} />
                      {r.featured && <s-badge tone="info" icon="pin">Pinned</s-badge>}
                      {r.abusive && <s-badge tone="critical">⚑ Abusive words</s-badge>}
                    </s-stack>
                    {r.title && <s-text type="strong">{r.title}</s-text>}
                    <p className="rv-body">{r.body}</p>
                    {isLong(r.body) && (
                      <div><button type="button" className="rv-more" onClick={() => openView(r.id, "text")}>Read more</button></div>
                    )}
                    {r.media.length > 0 && (
                      <div className="rv-thumbs">
                        {r.media.slice(0, 5).map((m, k) => (
                          <button key={m.url + k} type="button" className="rv-thumb" onClick={() => openView(r.id, "media", k)} aria-label="View photo">
                            {m.kind === "video" ? (
                              <>
                                {m.poster ? <img src={m.poster} alt="" /> : <video src={m.url} muted preload="metadata" />}
                                <span className="play">▶</span>
                              </>
                            ) : (
                              <img src={m.url} alt="" loading="lazy" />
                            )}
                          </button>
                        ))}
                        {r.media.length > 5 && (
                          <button type="button" className="rv-more rv-thumb-more" onClick={() => openView(r.id, "media", 5)}>+{r.media.length - 5}</button>
                        )}
                      </div>
                    )}
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-button variant="tertiary" icon="chat" onClick={() => openThread(r.id)}>
                        {r.replies > 0 ? `${r.replies} comment${r.replies > 1 ? "s" : ""}` : "Reply"}
                      </s-button>
                      {r.pendingComments > 0 && <span className="rv-flag">⚑ {r.pendingComments} waiting for approval</span>}
                      {r.needsReply && <s-badge tone="critical">Needs reply</s-badge>}
                    </s-stack>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-300">
                    <div className="rv-who">
                      <button type="button" className="rv-av" onClick={() => openView(r.id, r.avatar?.url ? "avatar" : "text")} aria-label={`View ${r.author}`}>
                        {r.avatar?.url ? <img src={r.avatar.url} alt="" /> : initials(r.author)}
                      </button>
                      <div>
                        <div className="rv-name">{r.author}</div>
                        {r.location && <div className="rv-city">{r.location}</div>}
                      </div>
                    </div>
                    <s-stack direction="inline" gap="small-300">
                      {r.verified && <s-badge tone="success" icon="check">Verified</s-badge>}
                      <s-badge>{r.source === "Website" ? "Customer" : r.source}</s-badge>
                    </s-stack>
                  </s-stack>
                </s-table-cell>
                <s-table-cell><s-badge tone={statusTone[r.status] || "neutral"}>{r.status}</s-badge></s-table-cell>
                <s-table-cell>{fmtDate(r.createdAt)}</s-table-cell>
                <s-table-cell><RowActions r={r} productId={product.id} /></s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!list.rows.length && (
          <s-box padding="large">
            <s-stack gap="base" alignItems="center">
              <s-heading>{anyFilter || status !== "all" ? "No reviews match these filters" : "No reviews here yet"}</s-heading>
              {anyFilter || status !== "all" ? (
                <s-button onClick={() => go({ q: null, rating: null, media: null, customer: null, flagged: null, from: null, to: null, status: null })}>
                  Clear filters
                </s-button>
              ) : (
                <>
                  <s-paragraph>Reviews customers send from the product page arrive here as Pending.</s-paragraph>
                  <s-button href={`/app/reviews/${product.id}/new`}>Add a review</s-button>
                </>
              )}
            </s-stack>
          </s-box>
        )}
      </s-section>

      {/* review popup: Read more, photos, avatar */}
      <div hidden><s-button id="review-modal-opener" commandFor="review-modal" command="--show" /></div>
      <s-modal id="review-modal" heading={viewRow ? `Review · ${viewRow.author}` : "Review"} size="large">
        {viewRow && view && (
          <ReviewView
            key={`${viewRow.id}-${view.n}`}
            r={viewRow}
            mode={view.mode}
            start={view.start}
            productId={product.id}
            onConversation={() => openThread(viewRow.id)}
          />
        )}
      </s-modal>

      {/* conversation popup */}
      <div hidden><s-button id="list-thread-modal-opener" commandFor="list-thread-modal" command="--show" /></div>
      <s-modal id="list-thread-modal" heading={threadRow ? `Conversation · ${threadRow.author}` : "Conversation"} size="large">
        {threadReview && (
          <div key={threadReview.id}>
            <ReviewHeader review={threadReview} />
            <Thread review={threadReview} shopName={shopName} people={peopleOf(threadReview)} actionUrl={editUrl(product.id, threadReview.id)} />
          </div>
        )}
      </s-modal>

      <s-text color="subdued">
        Showing page {list.page} of {list.pages} · {list.total} review{list.total === 1 ? "" : "s"}
      </s-text>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
