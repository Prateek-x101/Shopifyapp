import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Products() {
  return (
    <s-page heading="Products">
      <s-section>
        <s-stack gap="base" alignItems="center">
          <s-heading>Product page editor — coming next</s-heading>
          <s-paragraph>
            Pick a product, click a widget (Offer bar, Special Offers, Size chart, Badges, Videos…) and edit its
            settings in a form with a live preview.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
