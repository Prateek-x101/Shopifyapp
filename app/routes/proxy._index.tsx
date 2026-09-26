/**
 * App proxy root: https://<store>/apps/engine  (no sub-path)
 * Used by the storefront review widget: GET ?action=...  /  POST { actionType, ... }
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { json, legacyGet, legacyPost } from "../lib/legacy-proxy.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ success: false, error: "App not installed" }, { status: 401 });
  return legacyGet(session.shop, new URL(request.url).searchParams);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) return json({ success: false, error: "App not installed" }, { status: 401 });
  const sp = new URL(request.url).searchParams;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anon";
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid request" }, { status: 400 });
  }
  try {
    return await legacyPost(admin, session.shop, sp, body, ip);
  } catch (e: any) {
    return json({ success: false, error: e?.message || "Something went wrong" }, { status: 500 });
  }
};
