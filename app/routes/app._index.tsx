import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resyncAll } from "../lib/reviews.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [total, pending, published] = await Promise.all([
    prisma.review.count({ where: { shop: session.shop } }),
    prisma.review.count({ where: { shop: session.shop, status: "pending" } }),
    prisma.review.count({ where: { shop: session.shop, status: "published" } }),
  ]);
  return { total, pending, published };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const res = await resyncAll(admin, session.shop);
  return { ok: true, ...res };
};

export default function Dashboard() {
  const { total, pending, published } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const syncing = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(`Synced ${fetcher.data.reviews} reviews`);
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Dashboard">
      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
          <s-box padding="base" border="base" borderRadius="base">
            <s-text color="subdued">Published reviews</s-text>
            <s-heading>{published}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-text color="subdued">Waiting for approval</s-text>
            <s-heading>{pending}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-text color="subdued">All reviews</s-text>
            <s-heading>{total}</s-heading>
          </s-box>
        </s-grid>
        {pending > 0 && (
          <s-banner tone="warning" heading={`${pending} review${pending > 1 ? "s" : ""} waiting for approval`}>
            <s-link href="/app/reviews?pending=1">Review them</s-link>
          </s-banner>
        )}
      </s-section>

      <s-section heading="More coming soon">
        <s-paragraph>
          Sales, conversion and review insights will appear here.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Data">
        <s-paragraph>
          Reviews are stored in your store as <s-text type="strong">Review</s-text> metaobjects. If
          the app ever looks out of date, resync rebuilds the fast index from Shopify.
        </s-paragraph>
        <s-button onClick={() => fetcher.submit({}, { method: "POST" })} {...(syncing ? { loading: true } : {})}>
          Resync from Shopify
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
