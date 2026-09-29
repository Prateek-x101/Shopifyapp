/**
 * Live preview for the product page editor.
 *
 * The storefront refuses to be framed (X-Frame-Options: DENY), so the app fetches the real product page on the server
 * and serves it from its own domain inside the editor. The page is the real one (same theme, same data); the app only
 *   - adds <base> so the theme's CSS/JS/images load from the store,
 *   - removes tracking / checkout scripts (Meta pixel, analytics, Shiprocket, sales popup) so editing never counts as
 *     a visit or fires ad events,
 *   - adds a small "bridge" script: hover/click to pick a widget, outline for the selected one, and instant (unsaved)
 *     text changes sent from the editor.
 * Links are signed (HMAC with the app secret, 1 hour), so this is not an open proxy.
 */
import crypto from "node:crypto";
import { BRIDGE_JS } from "./preview-bridge.server";

const secret = () => process.env.SHOPIFY_API_SECRET || "";
const sign = (s: string) => crypto.createHmac("sha256", secret()).update(s).digest("base64url");

export function previewUrl(shop: string, domain: string, handle: string) {
  const exp = Date.now() + 3600e3;
  const payload = [shop, domain, handle, exp].join("|");
  const q = new URLSearchParams({ shop, d: domain, h: handle, e: String(exp), s: sign(payload) });
  return `/preview?${q.toString()}`;
}

function verify(sp: URLSearchParams) {
  const shop = sp.get("shop") || "", domain = sp.get("d") || "", handle = sp.get("h") || "", exp = sp.get("e") || "", s = sp.get("s") || "";
  if (!secret() || !shop || !domain || !handle || !exp || !s) return null;
  if (!(Number(exp) > Date.now())) return null;
  const want = Buffer.from(sign([shop, domain, handle, exp].join("|")));
  const got = Buffer.from(s);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(domain) || !/^[a-z0-9-]+$/i.test(handle)) return null;
  return { shop, domain, handle };
}

// scripts that must not run in the editor: tracking, ads, checkout, popups
const BLOCK = /web-?pixels|webPixelsManager|trekkie|monorail|fbevents|connect\.facebook|fbq\(|googletagmanager|gtag\(|google-analytics|clarity\.ms|hotjar|conversionbear|salespop|pickrr|fastrr|shiprocket|otpless|spf-analytics|perf-kit|shop-js|portable-wallets|boomerang|shopify_pay|klaviyo|tiktok|snap\.licdn|ttq\./i;

function rewrite(html: string, domain: string) {
  let out = html;
  // drop blocked <script> tags (inline and external)
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => (BLOCK.test(tag) ? "" : tag));
  out = out.replace(/<link\b[^>]*(?:rel=["']?(?:preconnect|dns-prefetch)["']?)[^>]*>/gi, (tag) => (BLOCK.test(tag) ? "" : tag));
  // no page-level CSP / frame rules from the store
  out = out.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  // everything relative loads from the store
  out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${domain}/">`);
  out = out.replace(/<\/body>/i, `<script>${BRIDGE_JS}</script></body>`);
  return out;
}

export async function renderPreview(request: Request) {
  const sp = new URL(request.url).searchParams;
  const v = verify(sp);
  if (!v) return new Response("This preview link has expired. Reload the editor.", { status: 403, headers: { "Content-Type": "text/plain" } });
  const url = `${v.domain}/products/${encodeURIComponent(v.handle)}?_vwp=${Date.now()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36 VesturePreview", Accept: "text/html" },
      redirect: "follow",
    });
  } catch {
    return new Response("Could not reach the store.", { status: 502, headers: { "Content-Type": "text/plain" } });
  }
  const html = await res.text();
  if (!res.ok) {
    return new Response(res.status === 404 ? "This product is not on the online store (draft, archived or not published)." : `The store answered ${res.status}.`, {
      status: res.status, headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response(rewrite(html, v.domain), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
