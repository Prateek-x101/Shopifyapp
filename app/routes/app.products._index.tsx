import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listProducts } from "../lib/product-widgets.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;
  const q = (sp.get("q") || "").trim();
  const status = sp.get("status") || "";
  const query = [q ? `title:*${q.replace(/[*"]/g, "")}*` : "", status ? `status:${status}` : ""].filter(Boolean).join(" ");
  return { ...(await listProducts(admin, query, sp.get("after"))), q, status };
};

const CSS = `
.pw-row { display: flex; align-items: center; gap: 12px; }
.pw-img { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; background: #f1f1f1; flex-shrink: 0; border: 1px solid #ececec; }
.pw-title { font-weight: 600; color: #1f1f1f; }
.pw-sub { font-size: 12px; color: #8a8a8a; }
.pw-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pw-chip { font-size: 11.5px; line-height: 18px; padding: 0 8px; border-radius: 999px; background: #f1f1f1; color: #9a9a9a; white-space: nowrap; }
.pw-chip.on { background: #e8f5ec; color: #1a7f37; }
.pw-stars { color: #e0261b; letter-spacing: 1px; }
`;

const WIDGETS: [string, string][] = [
  ["offer", "Offer bar"],
  ["specialOffers", "Special Offers"],
  ["badges", "Badges"],
  ["sizeGuide", "Size guide"],
  ["videos", "Videos"],
  ["whatsapp", "WhatsApp"],
];

export default function Products() {
  const { rows, hasNext, cursor, q, status } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    if (!("after" in next)) p.delete("after");
    navigate(`/app/products?${p.toString()}`);
  };
  const money = (a: string, c: string) => {
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: c, maximumFractionDigits: 0 }).format(Number(a)); } catch { return a; }
  };

  return (
    <s-page heading="Products" inlineSize="large">
      <style>{CSS}</style>
      <s-section padding="none">
        <s-table
          paginate
          hasNextPage={hasNext}
          hasPreviousPage={!!params.get("after")}
          onNextPage={() => go({ after: cursor })}
          onPreviousPage={() => go({ after: null })}
        >
          <s-stack slot="filters" direction="inline" gap="base" alignItems="center">
            <form
              style={{ flex: 1 }}
              onSubmit={(e) => { e.preventDefault(); go({ q: (new FormData(e.currentTarget).get("q") as string) || null }); }}
            >
              <s-search-field name="q" label="Search products" labelAccessibilityVisibility="exclusive" placeholder="Search products" defaultValue={q} />
            </form>
            <s-select label="Status" labelAccessibilityVisibility="exclusive" value={status} onChange={(e: any) => go({ status: e.currentTarget.value || null })}>
              <s-option value="">All statuses</s-option>
              <s-option value="active">Active</s-option>
              <s-option value="draft">Draft</s-option>
              <s-option value="archived">Archived</s-option>
            </s-select>
          </s-stack>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Widgets on the page</s-table-header>
            <s-table-header>Reviews</s-table-header>
            <s-table-header format="numeric">Price</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id} clickDelegate={`edit-${r.id}`}>
                <s-table-cell>
                  <div className="pw-row">
                    {r.image ? <img className="pw-img" src={`${r.image}${r.image.includes("?") ? "&" : "?"}width=100`} alt="" /> : <span className="pw-img" />}
                    <div>
                      <s-link id={`edit-${r.id}`} href={`/app/products/${r.id}`}>
                        <span className="pw-title">{r.title}</span>
                      </s-link>
                      <div className="pw-sub">
                        {r.status === "ACTIVE" ? "Active" : r.status === "DRAFT" ? "Draft" : "Archived"} · {r.inventory ?? 0} in stock
                      </div>
                    </div>
                  </div>
                </s-table-cell>
                <s-table-cell>
                  <div className="pw-chips">
                    {WIDGETS.map(([k, label]) => {
                      const v = (r.widgets as any)[k];
                      const on = typeof v === "number" ? v > 0 : !!v;
                      return (
                        <span key={k} className={`pw-chip${on ? " on" : ""}`}>
                          {on ? "✓ " : ""}{label}{typeof v === "number" && v > 0 ? ` ${v}` : ""}
                        </span>
                      );
                    })}
                  </div>
                </s-table-cell>
                <s-table-cell>
                  {r.reviews.count ? (
                    <span><span className="pw-stars">★</span> {Number(r.reviews.avg).toFixed(1)} · {r.reviews.count}</span>
                  ) : (
                    <span className="pw-sub">No reviews</span>
                  )}
                </s-table-cell>
                <s-table-cell>{money(r.price, r.currency)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!rows.length && (
          <s-box padding="large">
            <s-stack alignItems="center" gap="base">
              <s-heading>No products found</s-heading>
              {(q || status) && <s-button onClick={() => go({ q: null, status: null })}>Clear search</s-button>}
            </s-stack>
          </s-box>
        )}
      </s-section>
      <s-text color="subdued">Click a product to edit its page widgets: offer bar, special offers, badges, size guide, videos and WhatsApp lines.</s-text>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
