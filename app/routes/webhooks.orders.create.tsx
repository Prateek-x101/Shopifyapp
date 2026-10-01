import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyJourneyToOrder } from "../lib/journey.server";

/**
 * orders/create: copy the shopper's journey (what they viewed and tapped) into the order note and tags.
 * The subscription is created through the API by ensureOrdersWebhook (journey.server.ts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  if (!admin) return new Response();
  try {
    await applyJourneyToOrder(admin, payload);
  } catch (e) {
    console.error(`[orders/create] ${shop}`, e);
  }
  return new Response();
};
