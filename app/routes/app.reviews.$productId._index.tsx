import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deleteReview, gql, importReviews, listReviews, patchReview, recomputeSummary } from "../lib/reviews.server";
import { countComments, normalizeComments } from "../lib/reviews.shared";
import { ReviewHeader, Thread, initials, peopleOf } from "../components/review-thread";
import { BulkUpload } from "../components/bulk-upload";
import type { BulkItem } from "../lib/reviews.shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = params.productId!;
  const url = new URL(request.url);
  const sp = url.searchParams;

  const [prod, list, counts] = await Promise.all([
    gql(admin, `query($id: ID!) { product(id: $id) { id title handle onlineStoreUrl featuredMedia { preview { image { url } } } } shop { name } }`, {
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
    shopName: prod.shop.name as string,
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
        images: (JSON.parse(r.images) as { url: string; kind?: string }[]).filter((i) => i.url && i.kind !== "video"),
        avatar: r.avatar ? (JSON.parse(r.avatar) as { id: string; url: string }) : null,
        thread: normalizeComments(JSON.parse(r.replies)),
        replies: countComments(normalizeComments(JSON.parse(r.replies))),
        needsReply: r.needsReply,
        createdAt: r.createdAt.toISOString(),
      })),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = fd.get("intent") as string;
  const id = fd.get("id") as string;
  if (intent === "bulk-import") {
    let items: BulkItem[] = [];
    try { items = JSON.parse(String(fd.get("payload") || "[]")); } catch { return { ok: false, message: "Could not read the reviews" }; }
    if (!Array.isArray(items) || !items.length) return { ok: false, message: "Nothing to import" };
    const status = ["published", "pending", "hidden"].includes(String(fd.get("status"))) ? String(fd.get("status")) : "published";
    const r = await importReviews(admin, session.shop, params.productId!, items, {
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
    let ids: string[] = [];
    try { ids = (JSON.parse(String(fd.get("ids") || "[]")) as string[]).filter((x) => typeof x === "string").slice(0, 250); } catch { ids = []; }
    const op = String(fd.get("op") || "");
    if (!ids.length) return { ok: false, message: "Select reviews first" };
    const own = await prisma.review.findMany({ where: { shop: session.shop, id: { in: ids } }, select: { id: true } });
    const run = async (rid: string) => {
      if (op === "delete") return deleteReview(admin, session.shop, rid);
      if (op === "published" || op === "pending" || op === "hidden") return patchReview(admin, session.shop, rid, { status: op });
      if (op === "pin" || op === "unpin") return patchReview(admin, session.shop, rid, { featured: op === "pin" });
      throw new Error("Unknown action");
    };
    let done = 0;
    let failed = 0;
    for (let i = 0; i < own.length; i += 4) {
      const res = await Promise.allSettled(own.slice(i, i + 4).map((r) => run(r.id)));
      res.forEach((x) => (x.status === "fulfilled" ? done++ : failed++));
    }
    await recomputeSummary(admin, session.shop, params.productId!); // once more, after the parallel updates settle
    const verb: Record<string, string> = {
      delete: "deleted", published: "published", pending: "moved to pending", hidden: "hidden", pin: "pinned", unpin: "unpinned",
    };
    return {
      ok: done > 0,
      message: `${done} review${done === 1 ? "" : "s"} ${verb[op] || "updated"}${failed ? ` · ${failed} failed` : ""}`,
    };
  }
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
  const { product, shopName, byStatus, list } = useLoaderData<typeof loader>();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.rows.find((r) => r.id === openId) || null;
  const openReview = open ? { ...open, replies: open.thread } : null;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get("status") || "all";

  // selection for bulk actions (current page)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pageIds = list.rows.map((r) => r.id);
  const pageKey = pageIds.join(",");
  useEffect(() => {
    setSelected((cur) => new Set([...cur].filter((x) => pageIds.includes(x))));
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const allOn = pageIds.length > 0 && pageIds.every((x) => selected.has(x));
  const someOn = selected.size > 0 && !allOn;
  const toggle = (rid: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(rid)) n.delete(rid); else n.add(rid);
      return n;
    });
  const bulk = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const bulkBusy = bulk.state !== "idle";
  useEffect(() => {
    const d: any = bulk.data;
    if (!d?.message) return;
    shopify.toast.show(d.message, { isError: d.ok === false });
    if (d.ok) setSelected(new Set());
  }, [bulk.data, shopify]);
  const runBulk = (op: string) => {
    if (op === "delete" && !confirm(`Delete ${selected.size} review${selected.size === 1 ? "" : "s"} permanently?`)) return;
    bulk.submit({ intent: "bulk", op, ids: JSON.stringify([...selected]) }, { method: "POST" });
  };

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
      <s-button slot="secondary-actions" icon="upload" commandFor="bulk-modal" command="--show">Bulk upload</s-button>
      {product.url && (
        <s-button slot="secondary-actions" href={product.url} target="_blank">View on store</s-button>
      )}
      <BulkUpload />
      <style>{`
        .rv-check { width: 16px; height: 16px; margin: 0; accent-color: #303030; cursor: pointer; }
        .rv-bulkbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #e3e3e3;
          border-radius: 10px; background: #fafafa; font-size: 13px; }
        .rv-bulk-count { font-weight: 600; color: #1f1f1f; }
        .rv-bulk-link { border: 0; background: none; padding: 0; font: inherit; color: #616161; text-decoration: underline; cursor: pointer; }
        .rv-bulk-sp { flex: 1; }
      `}</style>

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
            {selected.size > 0 && (
              <div className="rv-bulkbar">
                <span className="rv-bulk-count">{selected.size} selected</span>
                <button type="button" className="rv-bulk-link" onClick={() => setSelected(new Set())}>Clear</button>
                <span className="rv-bulk-sp" />
                <s-button onClick={() => runBulk("published")} {...(bulkBusy ? { disabled: true } : {})}>Publish</s-button>
                <s-button onClick={() => runBulk("hidden")} {...(bulkBusy ? { disabled: true } : {})}>Hide</s-button>
                <s-button onClick={() => runBulk("pending")} {...(bulkBusy ? { disabled: true } : {})}>Pending</s-button>
                <s-button icon="pin" onClick={() => runBulk("pin")} {...(bulkBusy ? { disabled: true } : {})}>Pin</s-button>
                <s-button onClick={() => runBulk("unpin")} {...(bulkBusy ? { disabled: true } : {})}>Unpin</s-button>
                <s-button tone="critical" icon="delete" onClick={() => runBulk("delete")} {...(bulkBusy ? { loading: true } : {})}>Delete</s-button>
              </div>
            )}
          </s-stack>

          <s-table-header-row>
            <s-table-header>
              <input
                type="checkbox"
                className="rv-check"
                aria-label="Select all on this page"
                checked={allOn}
                ref={(el) => { if (el) el.indeterminate = someOn; }}
                onChange={() => setSelected(allOn ? new Set() : new Set(pageIds))}
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
                  <input type="checkbox" className="rv-check" aria-label={`Select review by ${r.author}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                </s-table-cell>
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
                        {r.needsReply && <s-badge tone="critical">Needs reply</s-badge>}
                      </s-stack>
                    )}
                    <s-stack direction="inline">
                      <s-button variant="tertiary" icon="chat" commandFor="list-thread-modal" command="--show" onClick={() => setOpenId(r.id)}>
                        {r.replies > 0 ? `${r.replies} comment${r.replies > 1 ? "s" : ""}` : "Reply"}
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-300">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-avatar size="small" initials={initials(r.author)} alt={r.author} {...(r.avatar?.url ? { src: r.avatar.url } : {})} />
                      <s-stack gap="none">
                        <s-text>{r.author}</s-text>
                        {r.location && <s-text color="subdued">{r.location}</s-text>}
                      </s-stack>
                    </s-stack>
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
      <s-modal
        id="list-thread-modal"
        heading={open ? `Conversation · ${open.author}` : "Conversation"}
        size="large"
        onHide={() => setOpenId(null)}
      >
        {openReview && (
          <div key={openReview.id}>
            <ReviewHeader review={openReview} />
            <Thread
              review={openReview}
              shopName={shopName}
              people={peopleOf(openReview)}
              actionUrl={`/app/reviews/${product.id}/${encodeURIComponent(openReview.id.split("/").pop() || "")}`}
            />
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
