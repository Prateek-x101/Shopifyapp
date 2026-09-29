/**
 * Comments & replies across all products: the approval queue (comments with abusive words wait here),
 * hidden ones, and the latest activity. Every action posts to the review editor route of that review.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { gql } from "../lib/reviews.server";
import { normalizeComments } from "../lib/reviews.shared";
import type { ReviewComment } from "../lib/reviews.shared";
import { initials } from "../components/review-thread";

type Tab = "waiting" | "hidden" | "recent";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const tab = (new URL(request.url).searchParams.get("tab") || "waiting") as Tab;
  const shop = session.shop;

  const [waitingCount, hiddenCount] = await Promise.all([
    prisma.review.count({ where: { shop, replies: { contains: '"status":"pending"' } } }),
    prisma.review.count({ where: { shop, replies: { contains: '"status":"hidden"' } } }),
  ]);

  const where: any =
    tab === "waiting" ? { shop, replies: { contains: '"status":"pending"' } } :
    tab === "hidden" ? { shop, replies: { contains: '"status":"hidden"' } } :
    { shop, commentCount: { gt: 0 } };
  const reviews = await prisma.review.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 150,
    select: { id: true, productId: true, author: true, body: true, rating: true, replies: true },
  });

  const items: {
    reviewId: string; productId: string; reviewAuthor: string; reviewBody: string; rating: number;
    comment: Omit<ReviewComment, "replies">; parentName: string | null;
  }[] = [];
  for (const r of reviews) {
    const walk = (list: ReviewComment[], parent: ReviewComment | null) =>
      list.forEach((c) => {
        const want = tab === "waiting" ? c.status === "pending" : tab === "hidden" ? c.status === "hidden" : c.type !== "store";
        if (want) {
          const { replies: _kids, ...comment } = c;
          items.push({ reviewId: r.id, productId: r.productId, reviewAuthor: r.author, reviewBody: r.body, rating: r.rating, comment, parentName: parent?.name || null });
        }
        walk(c.replies || [], c);
      });
    walk(normalizeComments(JSON.parse(r.replies)), null);
  }
  items.sort((a, b) => Date.parse(b.comment.date) - Date.parse(a.comment.date));
  const shown = items.slice(0, 100);

  const productIds = [...new Set(shown.map((i) => i.productId))];
  const titles: Record<string, { title: string; image: string }> = {};
  if (productIds.length) {
    const d = await gql(admin, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title featuredMedia { preview { image { url } } } } } }`, {
      ids: productIds.map((p) => `gid://shopify/Product/${p}`),
    });
    d.nodes.forEach((n: any) => {
      if (n?.id) titles[n.id.split("/").pop()] = { title: n.title, image: n.featuredMedia?.preview?.image?.url || "" };
    });
  }
  return { tab, waitingCount, hiddenCount, items: shown, total: items.length, titles };
};

const CSS = `
.cm { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #303030; }
.cm-item { display: grid; grid-template-columns: 36px 1fr auto; gap: 12px; padding: 14px 16px; border-top: 1px solid #f1f1f1; }
.cm-item:first-child { border-top: 0; }
.cm-av { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; background: #f1f1f1; color: #616161;
  font-size: 12px; font-weight: 600; box-shadow: inset 0 0 0 1px rgba(0,0,0,.06); }
.cm-av img { width: 100%; height: 100%; object-fit: cover; }
.cm-meta { font-size: 12px; color: #8a8a8a; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cm-name { font-size: 13px; font-weight: 600; color: #1f1f1f; }
.cm-text { margin: 4px 0 6px; font-size: 13.5px; line-height: 20px; white-space: pre-wrap; word-break: break-word; }
.cm-ctx { display: flex; gap: 8px; align-items: center; font-size: 12px; color: #8a8a8a; }
.cm-ctx img { width: 22px; height: 22px; border-radius: 4px; object-fit: cover; }
.cm-ctx a { color: #616161; }
.cm-quote { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-acts { display: flex; gap: 6px; align-items: flex-start; }
.cm-btn { height: 30px; padding: 0 12px; border: 1px solid #dcdcdc; border-radius: 8px; background: #fff; color: #303030; font: inherit; font-size: 12.5px; cursor: pointer; }
.cm-btn:hover { background: #fafafa; border-color: #b5b5b5; }
.cm-btn.primary { background: #303030; border-color: #303030; color: #fff; }
.cm-btn.danger { color: #b42318; }
.cm-btn[disabled] { opacity: .5; cursor: default; }
.cm-empty { padding: 40px 16px; text-align: center; color: #8a8a8a; font-size: 13px; }
`;

function Item({ it, product }: { it: ReturnType<typeof useLoaderData<typeof loader>>["items"][number]; product?: { title: string; image: string } }) {
  const fetcher = useFetcher<any>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const url = `/app/reviews/${it.productId}/${encodeURIComponent(it.reviewId.split("/").pop() || "")}`;
  useEffect(() => {
    const d = fetcher.data;
    if (d?.message) shopify.toast.show(d.message, { isError: d.ok === false });
  }, [fetcher.data, shopify]);
  const send = (data: Record<string, string>) => fetcher.submit({ commentId: it.comment.id, ...data }, { method: "POST", action: url });
  const c = it.comment;

  return (
    <div className="cm-item">
      <span className="cm-av">{c.avatar ? <img src={c.avatar} alt="" /> : initials(c.name)}</span>
      <div style={{ minWidth: 0 }}>
        <div className="cm-meta">
          <span className="cm-name">{c.name}</span>
          {c.verified && <span>· ✓ buyer</span>}
          <span>· {new Date(c.date).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
          {it.parentName && <span>· replying to {it.parentName}</span>}
          {c.status === "pending" && <s-badge tone="critical">Waiting</s-badge>}
          {c.status === "hidden" && <s-badge>Hidden</s-badge>}
        </div>
        <div className="cm-text">{c.text}</div>
        <div className="cm-ctx">
          {product?.image && <img src={product.image} alt="" />}
          <span>{product?.title || "Product"}</span>
          <span>·</span>
          <span className="cm-quote">on {it.reviewAuthor}'s review “{it.reviewBody}”</span>
          <a href={url}>Open</a>
        </div>
      </div>
      <div className="cm-acts">
        {c.status !== "approved" && (
          <button type="button" className="cm-btn primary" disabled={busy} onClick={() => send({ intent: "comment-status", status: "approved" })}>
            {c.status === "pending" ? "Approve" : "Show"}
          </button>
        )}
        {c.status !== "hidden" && (
          <button type="button" className="cm-btn" disabled={busy} onClick={() => send({ intent: "comment-status", status: "hidden" })}>Hide</button>
        )}
        <button type="button" className="cm-btn danger" disabled={busy} onClick={() => { if (confirm("Delete this comment and its replies?")) send({ intent: "comment-delete" }); }}>
          Delete
        </button>
        {c.type !== "store" && c.customerId && (
          <button
            type="button"
            className="cm-btn danger"
            disabled={busy}
            onClick={() => { if (confirm(`Block ${c.name}? They won't be able to post reviews, comments or replies. This comment will be hidden.`)) send({ intent: "block-user", hide: "true" }); }}
          >
            Block user
          </button>
        )}
      </div>
    </div>
  );
}

export default function Comments() {
  const { tab, waitingCount, hiddenCount, items, total, titles } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const go = (t: Tab) => {
    const p = new URLSearchParams(params);
    if (t === "waiting") p.delete("tab"); else p.set("tab", t);
    navigate(`/app/comments?${p.toString()}`);
  };

  return (
    <s-page heading="Comments" inlineSize="large">
      <style>{CSS}</style>
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="inline" gap="small-200">
            <s-button variant={tab === "waiting" ? "primary" : "secondary"} onClick={() => go("waiting")}>Waiting for approval{tab === "waiting" ? ` (${total})` : waitingCount ? " •" : ""}</s-button>
            <s-button variant={tab === "hidden" ? "primary" : "secondary"} onClick={() => go("hidden")}>Hidden{tab === "hidden" ? ` (${total})` : hiddenCount ? " •" : ""}</s-button>
            <s-button variant={tab === "recent" ? "primary" : "secondary"} onClick={() => go("recent")}>Recent customer comments</s-button>
          </s-stack>
        </s-box>
        <s-divider />
        <div className="cm">
          {items.length === 0 ? (
            <div className="cm-empty">
              {tab === "waiting" ? "Nothing waiting. Comments with abusive words land here for your approval." : tab === "hidden" ? "No hidden comments." : "No customer comments yet."}
            </div>
          ) : (
            items.map((it) => <Item key={it.reviewId + it.comment.id} it={it} product={titles[it.productId]} />)
          )}
        </div>
      </s-section>
      <s-text color="subdued">
        {total > items.length ? `Showing the latest ${items.length} of ${total}` : `${total} comment${total === 1 ? "" : "s"}`}
        {tab === "waiting" ? " · Blocked words: Settings → Moderation" : ""}
      </s-text>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
