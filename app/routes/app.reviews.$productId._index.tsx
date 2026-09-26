import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deleteReview, gql, listReviews, patchReview } from "../lib/reviews.server";
import { countComments, normalizeComments } from "../lib/reviews.shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = params.productId!;
  const url = new URL(request.url);
  const sp = url.searchParams;

  const [prod, list, counts] = await Promise.all([
    gql(admin, `query($id: ID!) { product(id: $id) { id title handle onlineStoreUrl featuredMedia { preview { image { url } } } } }`, {
      id: `gid://shopify/Product/${productId}`,
    }),
    listReviews({
      shop: session.shop,
      productId,
      status: sp.get("status") || "all",
      rating: sp.get("rating") ? parseInt(sp.get("rating")!, 10) : undefined,
      media: sp.get("media") === "1",
      q: sp.get("q") || undefined,
      page: parseInt(sp.get("page") || "1", 10),
      sort: (sp.get("sort") as any) || "newest",
    }),
    prisma.review.groupBy({ by: ["status"], where: { shop: session.shop, productId }, _count: true }),
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
    byStatus,
    list: {
      ...list,
      rows: list.rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        author: r.author,
        location: r.location,
        status: r.status,
        verified: r.verified,
        source: r.source,
        featured: r.featured,
        images: JSON.parse(r.images) as { url: string }[],
        replies: countComments(normalizeComments(JSON.parse(r.replies))),
        needsReply: r.needsReply,
        createdAt: r.createdAt.toISOString(),
      })),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = fd.get("intent") as string;
  const id = fd.get("id") as string;
  if (intent === "delete") {
    await deleteReview(admin, session.shop, id);
    return { ok: true, message: "Review deleted" };
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
  return { ok: false, message: "Unknown action" };
};

const statusTone: Record<string, "success" | "warning" | "neutral"> = { published: "success", pending: "warning", hidden: "neutral" };

function Stars({ n }: { n: number }) {
  return (
    <span style={{ color: "#f5a623", letterSpacing: 1, whiteSpace: "nowrap" }} aria-label={`${n} stars`}>
      {"★".repeat(n)}
      <span style={{ color: "#d9d9d9" }}>{"★".repeat(5 - n)}</span>
    </span>
  );
}

function RowActions({ r }: { r: any }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);
  const send = (data: Record<string, string>) => fetcher.submit({ id: r.id, ...data }, { method: "POST" });

  return (
    <s-stack direction="inline" gap="small-200" justifyContent="end">
      {r.status !== "published" && (
        <s-button variant="primary" onClick={() => send({ intent: "status", status: "published" })} {...(busy ? { loading: true } : {})}>
          Publish
        </s-button>
      )}
      {r.status === "published" && (
        <s-button onClick={() => send({ intent: "status", status: "hidden" })} {...(busy ? { disabled: true } : {})}>Hide</s-button>
      )}
      <s-button
        variant="tertiary"
        icon="pin"
        tone={r.featured ? "auto" : undefined}
        accessibilityLabel={r.featured ? "Unpin" : "Pin to top"}
        onClick={() => send({ intent: "pin", featured: String(!r.featured) })}
      />
      <s-button variant="tertiary" icon="edit" accessibilityLabel="Edit" href={`/app/reviews/${r.productId}/${encodeURIComponent(r.id.split("/").pop())}`} />
      <s-button
        variant="tertiary"
        tone="critical"
        icon="delete"
        accessibilityLabel="Delete"
        onClick={() => {
          if (confirm("Delete this review permanently?")) send({ intent: "delete" });
        }}
      />
    </s-stack>
  );
}

export default function ProductReviews() {
  const { product, byStatus, list } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get("status") || "all";

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v === null || v === "" ? p.delete(k) : p.set(k, v)));
    if (!("page" in next)) p.delete("page");
    navigate(`/app/reviews/${product.id}?${p.toString()}`);
  };

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
      {product.url && (
        <s-button slot="secondary-actions" href={product.url} target="_blank">View on store</s-button>
      )}

      <s-section padding="none">
        <s-table
          paginate
          hasNextPage={list.page < list.pages}
          hasPreviousPage={list.page > 1}
          onNextPage={() => go({ page: String(list.page + 1) })}
          onPreviousPage={() => go({ page: String(list.page - 1) })}
        >
          <s-stack slot="filters" gap="base">
            <s-stack direction="inline" gap="small-200">
              {tabs.map(([key, label]) => (
                <s-button key={key} variant={status === key ? "primary" : "secondary"} onClick={() => go({ status: key === "all" ? null : key })}>
                  {label}
                </s-button>
              ))}
            </s-stack>
            <s-stack direction="inline" gap="base" alignItems="end">
              <form
                style={{ flex: 1 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  go({ q: (new FormData(e.currentTarget).get("q") as string) || null });
                }}
              >
                <s-search-field name="q" label="Search reviews" labelAccessibilityVisibility="exclusive" placeholder="Search text or name" defaultValue={params.get("q") || ""} />
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
              <s-button variant={params.get("media") === "1" ? "primary" : "secondary"} icon="image" onClick={() => go({ media: params.get("media") === "1" ? null : "1" })}>
                With photos
              </s-button>
            </s-stack>
          </s-stack>

          <s-table-header-row>
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
                  <s-stack gap="small-200">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <Stars n={r.rating} />
                      {r.featured && <s-badge tone="info" icon="pin">Pinned</s-badge>}
                    </s-stack>
                    {r.title && <s-text type="strong">{r.title}</s-text>}
                    <s-text>{r.body.length > 180 ? r.body.slice(0, 180) + "…" : r.body}</s-text>
                    {(r.images.length > 0 || r.replies > 0) && (
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        {r.images.slice(0, 4).map((img, i) => <s-thumbnail key={i} src={img.url} alt="Review photo" size="base" />)}
                        {r.images.length > 4 && <s-text color="subdued">+{r.images.length - 4}</s-text>}
                        {r.replies > 0 && <s-badge icon="chat">{r.replies} comment{r.replies > 1 ? "s" : ""}</s-badge>}
                        {r.needsReply && <s-badge tone="critical">Needs reply</s-badge>}
                      </s-stack>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-300">
                    <s-text>{r.author}</s-text>
                    {r.location && <s-text color="subdued">{r.location}</s-text>}
                    <s-stack direction="inline" gap="small-300">
                      {r.verified && <s-badge tone="success" icon="check">Verified</s-badge>}
                      <s-badge>{r.source}</s-badge>
                    </s-stack>
                  </s-stack>
                </s-table-cell>
                <s-table-cell><s-badge tone={statusTone[r.status] || "neutral"}>{r.status}</s-badge></s-table-cell>
                <s-table-cell>{new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</s-table-cell>
                <s-table-cell><RowActions r={{ ...r, productId: product.id }} /></s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!list.rows.length && (
          <s-box padding="large">
            <s-stack gap="base" alignItems="center">
              <s-heading>No reviews here yet</s-heading>
              <s-paragraph>Reviews customers send from the product page arrive here as Pending.</s-paragraph>
              <s-button href={`/app/reviews/${product.id}/new`}>Add a review</s-button>
            </s-stack>
          </s-box>
        )}
      </s-section>
      <s-text color="subdued">
        Showing page {list.page} of {list.pages} · {list.total} review{list.total === 1 ? "" : "s"}
      </s-text>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
