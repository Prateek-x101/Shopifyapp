import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { REVIEW_TYPE, removeFromIndex, syncOne } from "../lib/reviews.server";

/**
 * metaobjects/create | update | delete for type vw_review (filtered in shopify.app.toml).
 * Keeps the Prisma index and the product summary metafields in step with reviews
 * that were added or edited outside the app, so nobody has to press "Resync".
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin, payload } = await authenticate.webhook(request);
  const p = payload as Record<string, any>;
  if (p?.type && p.type !== REVIEW_TYPE) return new Response();

  const raw = String(p?.admin_graphql_api_id || p?.id || "");
  const id = raw.startsWith("gid://") ? raw : raw ? `gid://shopify/Metaobject/${raw}` : "";
  if (!id || !admin) return new Response();

  try {
    if (String(topic).toUpperCase().includes("DELETE")) await removeFromIndex(admin, shop, id);
    else await syncOne(admin, shop, id);
  } catch (e) {
    console.error(`[webhook ${topic}] ${id}`, e);
  }
  return new Response();
};
