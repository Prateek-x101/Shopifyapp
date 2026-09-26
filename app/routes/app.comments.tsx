import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { addComment, gql, listComments, removeComment } from "../lib/reviews.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;
  const view = sp.get("view") || "needs-reply";
  const productId = sp.get("product") || "";
  const q = sp.get("q") || "";
  const page = parseInt(sp.get("page") || "1", 10);

  const [list, withComments, awaitingTotal, shop] = await Promise.all([
    listComments({ shop: session.shop, productId: productId || undefined, needsReply: view === "needs-reply", q, page }),
    prisma.review.groupBy({ by: ["productId"], where: { shop: session.shop, commentCount: { gt: 0 } }, _sum: { commentCount: true } }),
    prisma.review.count({ where: { shop: session.shop, needsReply: true } }),
    gql(admin, `{ shop { name } }`),
  ]);

  const ids = Array.from(new Set([...withComments.map((w) => w.productId), ...list.items.map((i) => i.productId)]));
  const titles: Record<string, { title: string; image: string }> = {};
  if (ids.length) {
    const d = await gql(admin, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title featuredMedia { preview { image { url } } } } } }`, {
      ids: ids.map((id) => `gid://shopify/Product/${id}`),
    });
    d.nodes.filter(Boolean).forEach((n: any) => {
      titles[n.id.split("/").pop()] = { title: n.title, image: n.featuredMedia?.preview?.image?.url || "" };
    });
  }
  return {
    view,
    productId,
    q,
    shopName: shop.shop.name as string,
    awaitingTotal,
    products: withComments.map((w) => ({ id: w.productId, title: titles[w.productId]?.title || "Product", count: w._sum.commentCount || 0 })),
    list: {
      ...list,
      items: list.items.map((i) => ({
        ...i,
        reviewNum: i.reviewId.split("/").pop(),
        product: titles[i.productId] || { title: "Product", image: "" },
      })),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();
  const reviewId = String(fd.get("reviewId") || "");
  if (fd.get("intent") === "delete") {
    await removeComment(admin, session.shop, reviewId, String(fd.get("commentId") || ""));
    return { ok: true, message: "Removed" };
  }
  const text = String(fd.get("text") || "").trim();
  if (!text) return { ok: false, message: "Write a reply first" };
  await addComment(admin, session.shop, reviewId, { name: String(fd.get("author") || "Store"), text, type: "store" }, String(fd.get("parentId") || "") || null);
  return { ok: true, message: "Reply posted" };
};

function when(iso: string) {
  const d = Date.parse(iso);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function CommentItem({ item, shopName }: { item: any; shopName: string }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [open, setOpen] = useState(item.awaiting);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);
  const n = item.node;

  return (
    <s-box padding="base" border="base" borderRadius="base" background={item.awaiting ? "subdued" : "base"}>
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-thumbnail src={item.product.image || undefined} alt={item.product.title} size="small-200" />
          <s-link href={`/app/reviews/${item.productId}/${item.reviewNum}`}>{item.product.title}</s-link>
          <s-text color="subdued">
            · review by {item.reviewAuthor} <span style={{ color: "#f5a623" }}>{"★".repeat(item.rating)}</span>
          </s-text>
        </s-stack>
        <s-text color="subdued">“{item.reviewBody.length > 110 ? item.reviewBody.slice(0, 110) + "…" : item.reviewBody}”</s-text>

        <div style={{ borderLeft: "3px solid #e3e3e3", paddingLeft: 12, marginLeft: item.depth ? 12 : 0 }}>
          <s-stack gap="small-300">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">{n.name}</s-text>
              {n.type === "store" && <s-badge tone="info">Store</s-badge>}
              {n.verified && <s-badge tone="success">Verified</s-badge>}
              {item.parentName && <s-text color="subdued">replying to {item.parentName}</s-text>}
              <s-text color="subdued">· {when(n.date)}</s-text>
              {item.awaiting && <s-badge tone="critical">Needs reply</s-badge>}
            </s-stack>
            <s-text>{n.text}</s-text>
          </s-stack>
        </div>

        <s-stack direction="inline" gap="small-200">
          <s-button variant={open ? "secondary" : "primary"} icon="chat" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Reply"}
          </s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            icon="delete"
            onClick={() => {
              if (confirm("Remove this comment and its replies?")) {
                fetcher.submit({ intent: "delete", reviewId: item.reviewId, commentId: n.id }, { method: "POST" });
              }
            }}
          >
            Delete
          </s-button>
        </s-stack>

        {open && (
          <fetcher.Form
            method="post"
            onSubmit={(e) => {
              const form = e.currentTarget;
              setTimeout(() => form.reset(), 0);
            }}
          >
            <input type="hidden" name="reviewId" value={item.reviewId} />
            <input type="hidden" name="parentId" value={n.id} />
            <input type="hidden" name="author" value={shopName} />
            <s-stack gap="small-200">
              <s-text-area label={`Reply to ${n.name} as ${shopName}`} name="text" rows={2} placeholder="Thanks! Happy you like it." />
              <s-stack direction="inline" justifyContent="end">
                <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>Post reply</s-button>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        )}
      </s-stack>
    </s-box>
  );
}

export default function Comments() {
  const { view, productId, q, shopName, awaitingTotal, products, list } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v === null || v === "" ? p.delete(k) : p.set(k, v)));
    if (!("page" in next)) p.delete("page");
    navigate(`/app/comments?${p.toString()}`);
  };

  return (
    <s-page heading="Comments" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/reviews">Reviews</s-link>

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200">
            <s-button variant={view === "needs-reply" ? "primary" : "secondary"} onClick={() => go({ view: null })}>
              Needs reply ({awaitingTotal})
            </s-button>
            <s-button variant={view === "all" ? "primary" : "secondary"} onClick={() => go({ view: "all" })}>All comments</s-button>
          </s-stack>
          <s-grid gridTemplateColumns="1fr 1fr" gap="base" alignItems="end">
            <s-select label="Product" value={productId} onChange={(e: any) => go({ product: e.currentTarget.value })}>
              <s-option value="">All products</s-option>
              {products.map((p) => (
                <s-option key={p.id} value={p.id}>{p.title} ({p.count})</s-option>
              ))}
            </s-select>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                go({ q: (new FormData(e.currentTarget).get("q") as string) || null });
              }}
            >
              <s-search-field name="q" label="Search" placeholder="Name or text" defaultValue={q} />
            </form>
          </s-grid>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack gap="base">
          {list.items.map((item) => (
            <CommentItem key={item.reviewId + item.node.id} item={item} shopName={shopName} />
          ))}
          {!list.items.length && (
            <s-box padding="large">
              <s-stack gap="small-200" alignItems="center">
                <s-heading>{view === "needs-reply" ? "All caught up" : "No comments yet"}</s-heading>
                <s-paragraph>
                  {view === "needs-reply"
                    ? "Every comment thread has your reply."
                    : "Customer comments and replies on reviews will show up here."}
                </s-paragraph>
              </s-stack>
            </s-box>
          )}
          {list.pages > 1 && (
            <s-stack direction="inline" gap="base" justifyContent="center" alignItems="center">
              <s-button disabled={list.page <= 1} onClick={() => go({ page: String(list.page - 1) })}>Previous</s-button>
              <s-text>Page {list.page} of {list.pages}</s-text>
              <s-button disabled={list.page >= list.pages} onClick={() => go({ page: String(list.page + 1) })}>Next</s-button>
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
