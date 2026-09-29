/**
 * App settings, stored on the shop (metafield vw_reviews.settings, JSON) so they live in Shopify
 * and the theme can read the public parts in Liquid.
 *
 *   { google_login, google_client_id, login_mode: "shopify" | "widget",
 *     banner_mode: "auto" | "selected", banner_max, banner_min_rating, banner_shuffle }
 *
 *   login_mode "shopify": the widget's log-in sheet sends shoppers to the store's own sign-in (Shopify customer
 *   accounts, with Google turned on there), so one login works for the widget, orders and checkout.
 *   login_mode "widget": the widget signs shoppers in with Google by itself (widget only).
 *
 *   Review banner ("What our customers say"): chosen + pinned reviews always; "auto" fills up with unique
 *   reviews of at least `banner_min_rating` stars, up to `banner_max`; "selected" shows only the chosen + pinned ones.
 */
import { gql } from "./reviews.server";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

export const SETTINGS_NS = "vw_reviews";
export const SETTINGS_KEY = "settings";

export type LoginMode = "shopify" | "widget";
export type BannerMode = "auto" | "selected";
export type AppSettings = {
  google_login: boolean;
  google_client_id: string;
  login_mode: LoginMode;
  banner_mode: BannerMode;
  banner_max: number;
  banner_min_rating: number;
  banner_shuffle: boolean;
};

export async function ensureSettingsDefinition(admin: Admin) {
  const d = await gql(admin, `{ metafieldDefinitions(first: 5, ownerType: SHOP, namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { nodes { id } } }`);
  if (d.metafieldDefinitions.nodes.length) return;
  await gql(admin, `mutation($d: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { message } } }`, {
    d: {
      name: "Reviews app settings",
      namespace: SETTINGS_NS,
      key: SETTINGS_KEY,
      ownerType: "SHOP",
      type: "json",
      description: "Written by the Vesture Studio app (Settings page). Read by the review widget.",
      access: { storefront: "PUBLIC_READ" },
    },
  });
}

function clean(v: any): AppSettings {
  const num = (x: any, lo: number, hi: number, dflt: number) => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  return {
    google_login: !!v.google_login && !!String(v.google_client_id || "").trim(),
    google_client_id: String(v.google_client_id || "").trim(),
    login_mode: v.login_mode === "widget" ? "widget" : "shopify",
    banner_mode: v.banner_mode === "selected" ? "selected" : "auto",
    banner_max: num(v.banner_max, 1, 30, 10),
    banner_min_rating: num(v.banner_min_rating, 1, 5, 4),
    banner_shuffle: v.banner_shuffle === undefined ? true : !!v.banner_shuffle,
  };
}

export async function getSettings(admin: Admin): Promise<AppSettings & { shopId: string }> {
  const d = await gql(admin, `{ shop { id metafield(namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { value } } }`);
  let v: any = {};
  try { v = JSON.parse(d.shop.metafield?.value || "{}"); } catch { v = {}; }
  return { shopId: d.shop.id, ...clean(v) };
}

/** Saves the given settings on top of the current ones. */
export async function saveSettings(admin: Admin, patch: Partial<AppSettings>) {
  const { shopId, ...cur } = await getSettings(admin);
  const value = clean({ ...cur, ...patch });
  const r = await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`, {
    m: [{ ownerId: shopId, namespace: SETTINGS_NS, key: SETTINGS_KEY, type: "json", value: JSON.stringify(value) }],
  });
  const errs = r.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  return value;
}
