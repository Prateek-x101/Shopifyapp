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
  const pendingOnly = url.searchParams.get("pending") === "1";

  const stats = await productStats(session.shop);

  let products: any[] = [];
  let pageInfo: any = { hasNextPage: false, hasPreviousPage: false };

  if (pendingOnly) {
    // only products that have reviews waiting
    const ids = Object.entries(stats).filter(([, s]) => s.pending > 0).map(([id]) => `gid://shopify/Product/${id}`);
    if (ids.length) {
      const d = await gql(admin, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title handle status featuredMedia { preview { image { url } } } } } }`, { ids });
      products = d.nodes.filter(Boolean);
    }
  } else {
    const d = await gql(admin, `query($first: Int, $last: Int, $after: String, $before: String, $q: String) {
      products(first: $first, last: $last, after: $after, before: $before, query: $q, sortKey: TITLE) {
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        nodes { id title handle status featuredMedia { preview { image { url } } } }
      } }`, before ? { last: PER_PAGE, before, q: q || null } : { first: PER_PAGE, after, q: q || null });
    products = d.products.nodes;
    pageInfo = d.products.pageInfo;
  }

  const rows = products.map((p: any) => {
    const id = p.id.split("/").pop();
    const s = stats[id] || { total: 0, published: 0, pending: 0, avg: 0 };
    return {
      id,
      title: p.title,
      status: p.status,
      image: p.featuredMedia?.preview?.image?.url || "",
      ...s,
    };
  });
  const totals = Object.values(stats).reduce(
    (a, s) => ({ published: a.published + s.published, pending: a.pending + s.pending }),
    { published: 0, pending: 0 },
  );
  return { rows, pageInfo, q, pendingOnly, totals };
};

function Stars({ value }: { value: number }) {
  if (!value) return <s-text color="subdued">—</s-text>;
  return (
    <s-text>
      <span style={{ color: "#f5a623" }}>★</span> {value.toFixed(1)}
    </s-text>
  );
}

export default function ReviewsProducts() {
  const { rows, pageInfo, q, pendingOnly, totals } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v === null ? p.delete(k) : p.set(k, v)));
    navigate(`/app/reviews?${p.toString()}`);
  };

  return (
    <s-page heading="Reviews" inlineSize="large">
      <s-section padding="none">
        <s-table
          paginate={!pendingOnly}
          hasNextPage={pageInfo.hasNextPage}
          hasPreviousPage={pageInfo.hasPreviousPage}
          onNextPage={() => go({ after: pageInfo.endCursor, before: null })}
          onPreviousPage={() => go({ before: pageInfo.startCursor, after: null })}
        >
          <s-stack slot="filters" direction="inline" gap="base" alignItems="center">
            <form
              method="get"
              style={{ flex: 1 }}
              onSubmit={(e) => {
                e.preventDefault();
                const v = new FormData(e.currentTarget).get("q") as string;
                go({ q: v || null, after: null, before: null });
              }}
            >
              <s-search-field name="q" label="Search products" labelAccessibilityVisibility="exclusive" placeholder="Search products" defaultValue={q} />
            </form>
            <s-button
              variant={pendingOnly ? "primary" : "secondary"}
              onClick={() => go({ pending: pendingOnly ? null : "1", after: null, before: null })}
            >
              Pending {totals.pending ? `(${totals.pending})` : ""}
            </s-button>
          </s-stack>

          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Rating</s-table-header>
            <s-table-header format="numeric">Published</s-table-header>
            <s-table-header format="numeric">Pending</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id} clickDelegate={`open-${r.id}`}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-thumbnail src={r.image || undefined} alt={r.title} size="small" />
                    <s-link id={`open-${r.id}`} href={`/app/reviews/${r.id}`}>{r.title}</s-link>
                    {r.status !== "ACTIVE" && <s-badge>{r.status.toLowerCase()}</s-badge>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell><Stars value={r.avg} /></s-table-cell>
                <s-table-cell>{r.published}</s-table-cell>
                <s-table-cell>
                  {r.pending ? <s-badge tone="warning">{r.pending}</s-badge> : <s-text color="subdued">0</s-text>}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!rows.length && (
          <s-box padding="large">
            <s-paragraph>{pendingOnly ? "No reviews are waiting for approval." : "No products found."}</s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
