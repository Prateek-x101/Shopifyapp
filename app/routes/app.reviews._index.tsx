import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { gql, productStats } from "../lib/reviews.server";

const PER_PAGE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const view = url.searchParams.get("view") || (url.searchParams.get("pending") === "1" ? "attention" : "all");

  const stats = await productStats(session.shop);
  const needsAttention = (s: { pending: number; needsReply: number }) => s.pending > 0 || s.needsReply > 0;

  let products: any[] = [];
  let pageInfo: any = { hasNextPage: false, hasPreviousPage: false };

  if (view === "attention" || view === "reviewed") {
    // only products with activity, most recent first
    const ids = Object.entries(stats)
      .filter(([, s]) => (view === "attention" ? needsAttention(s) : s.total > 0))
      .sort(([, a], [, b]) => Date.parse(b.lastCommentAt || b.lastReviewAt || "0") - Date.parse(a.lastCommentAt || a.lastReviewAt || "0"))
      .map(([id]) => `gid://shopify/Product/${id}`)
      .slice(0, 100);
    if (ids.length) {
      const d = await gql(admin, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title status featuredMedia { preview { image { url } } } } } }`, { ids });
      products = d.nodes.filter(Boolean);
    }
  } else {
    const d = await gql(admin, `query($first: Int, $last: Int, $after: String, $before: String, $q: String) {
      products(first: $first, last: $last, after: $after, before: $before, query: $q, sortKey: TITLE) {
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        nodes { id title status featuredMedia { preview { image { url } } } }
      } }`, before ? { last: PER_PAGE, before, q: q || null } : { first: PER_PAGE, after, q: q || null });
    products = d.products.nodes;
    pageInfo = d.products.pageInfo;
  }

  const empty = { total: 0, published: 0, pending: 0, avg: 0, needsReply: 0, comments: 0, lastReviewAt: null, lastCommentAt: null };
  const rows = products.map((p: any) => {
    const id = p.id.split("/").pop();
    return { id, title: p.title, status: p.status, image: p.featuredMedia?.preview?.image?.url || "", ...(stats[id] || empty) };
  });
  const totals = Object.values(stats).reduce(
    (a, s) => ({
      pending: a.pending + s.pending,
      needsReply: a.needsReply + s.needsReply,
      attention: a.attention + (needsAttention(s) ? 1 : 0),
      reviewed: a.reviewed + (s.total > 0 ? 1 : 0),
    }),
    { pending: 0, needsReply: 0, attention: 0, reviewed: 0 },
  );
  return { rows, pageInfo, q, view, totals };
};

function ago(iso: string | null) {
  if (!iso) return "—";
  const d = Date.parse(iso);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function ReviewsProducts() {
  const { rows, pageInfo, q, view, totals } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    p.delete("pending");
    Object.entries(next).forEach(([k, v]) => (v === null ? p.delete(k) : p.set(k, v)));
    navigate(`/app/reviews?${p.toString()}`);
  };
  const tabs: [string, string][] = [
    ["all", "All products"],
    ["reviewed", `With reviews (${totals.reviewed})`],
    ["attention", `Needs attention (${totals.attention})`],
  ];

  return (
    <s-page heading="Reviews" inlineSize="large">
      <s-button slot="secondary-actions" href="/app/comments">
        Comments{totals.needsReply ? ` · ${totals.needsReply} need reply` : ""}
      </s-button>

      {totals.attention > 0 && view !== "attention" && (
        <s-banner tone="warning" heading={`${totals.pending} pending review${totals.pending === 1 ? "" : "s"} · ${totals.needsReply} comment thread${totals.needsReply === 1 ? "" : "s"} waiting for your reply`}>
          <s-button variant="tertiary" onClick={() => go({ view: "attention", after: null, before: null, q: null })}>Show them</s-button>
        </s-banner>
      )}

      <s-section padding="none">
        <s-table
          paginate={view === "all"}
          hasNextPage={pageInfo.hasNextPage}
          hasPreviousPage={pageInfo.hasPreviousPage}
          onNextPage={() => go({ after: pageInfo.endCursor, before: null })}
          onPreviousPage={() => go({ before: pageInfo.startCursor, after: null })}
        >
          <s-stack slot="filters" gap="base">
            <s-stack direction="inline" gap="small-200">
              {tabs.map(([key, label]) => (
                <s-button key={key} variant={view === key ? "primary" : "secondary"} onClick={() => go({ view: key === "all" ? null : key, after: null, before: null })}>
                  {label}
                </s-button>
              ))}
            </s-stack>
            {view === "all" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget).get("q") as string;
                  go({ q: v || null, after: null, before: null });
                }}
              >
                <s-search-field name="q" label="Search products" labelAccessibilityVisibility="exclusive" placeholder="Search products" defaultValue={q} />
              </form>
            )}
          </s-stack>

          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Rating</s-table-header>
            <s-table-header format="numeric">Published</s-table-header>
            <s-table-header>Needs you</s-table-header>
            <s-table-header>Last activity</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => {
              const lastActivity = [r.lastReviewAt, r.lastCommentAt].filter(Boolean).sort().pop() || null;
              return (
                <s-table-row key={r.id} clickDelegate={`open-${r.id}`}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-thumbnail src={r.image || undefined} alt={r.title} size="base" />
                      <s-stack gap="small-300">
                        <s-link id={`open-${r.id}`} href={`/app/reviews/${r.id}`}>{r.title}</s-link>
                        {r.status !== "ACTIVE" && <s-text color="subdued">{r.status.toLowerCase()}</s-text>}
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {r.avg ? (
                      <s-text><span style={{ color: "#f5a623" }}>★</span> {r.avg.toFixed(1)}</s-text>
                    ) : (
                      <s-text color="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{r.published}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {r.pending > 0 && <s-badge tone="warning">{r.pending} pending</s-badge>}
                      {r.needsReply > 0 && <s-badge tone="critical" icon="chat">{r.needsReply} to reply</s-badge>}
                      {!r.pending && !r.needsReply && <s-text color="subdued">—</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-text>{ago(lastActivity)}</s-text>
                      {r.comments > 0 && <s-text color="subdued">{r.comments} comment{r.comments === 1 ? "" : "s"}</s-text>}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
        {!rows.length && (
          <s-box padding="large">
            <s-paragraph>
              {view === "attention" ? "All caught up: nothing is waiting for you." : view === "reviewed" ? "No reviews yet." : "No products found."}
            </s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
