/**
 * "Continue with Google" for the storefront review widget.
 *
 * Shopify only lets Plus stores sign shoppers in from outside (Multipass), so this does not create a
 * Shopify login session. It proves who the shopper is for the review widget only:
 *   1. The widget gets a Google ID token (Google Identity Services) and posts it to the app proxy.
 *   2. We check the token with Google, require it to be for the store's configured client id and a verified email.
 *   3. We find the Shopify customer with that email, or create one (no marketing consent).
 *   4. We return a signed token for that customer; the widget sends it with comments, reviews and votes.
 * Orders placed with the same email still count for "Verified buyer".
 */
import crypto from "node:crypto";
import { gql } from "./reviews.server";
import { getSettings } from "./settings.server";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

const TOKEN_DAYS = 30;
const secret = () => process.env.SHOPIFY_API_SECRET || "";
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (body: string) => b64u(crypto.createHmac("sha256", secret()).update(body).digest());

export function signToken(shop: string, customerId: string, name: string) {
  const body = b64u(JSON.stringify({ s: shop, c: customerId, n: name, e: Date.now() + TOKEN_DAYS * 864e5 }));
  return `${body}.${sign(body)}`;
}

/** Customer id from a widget token, or "" if missing, forged, expired or for another shop. */
export function customerFromToken(token: unknown, shop: string): string {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !secret()) return "";
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "";
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p.s !== shop || !p.c || !(p.e > Date.now())) return "";
    return String(p.c).replace(/\D/g, "");
  } catch {
    return "";
  }
}

async function verifyGoogleIdToken(credential: string, clientId: string) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!res.ok) throw new Error("Google sign-in could not be verified. Please try again.");
  const p: any = await res.json();
  if (p.aud !== clientId) throw new Error("This Google sign-in is not for this store.");
  if (p.iss !== "accounts.google.com" && p.iss !== "https://accounts.google.com") throw new Error("Invalid Google sign-in.");
  if (!(Number(p.exp) * 1000 > Date.now())) throw new Error("Google sign-in expired. Please try again.");
  if (String(p.email_verified) !== "true" || !p.email) throw new Error("Please use a Google account with a verified email.");
  return {
    email: String(p.email).toLowerCase(),
    firstName: String(p.given_name || "").slice(0, 60),
    lastName: String(p.family_name || "").slice(0, 60),
    name: String(p.name || p.given_name || "").slice(0, 60),
  };
}

async function findOrCreateCustomer(admin: Admin, g: { email: string; firstName: string; lastName: string }) {
  const q = await gql(admin, `query($q: String!) { customers(first: 1, query: $q) { nodes { id firstName displayName } } }`, {
    q: `email:"${g.email.replace(/"/g, "")}"`,
  });
  const hit = q.customers.nodes[0];
  if (hit) return { id: String(hit.id).split("/").pop()!, name: hit.firstName || hit.displayName || "" };
  const c = await gql(admin, `mutation($i: CustomerInput!) { customerCreate(input: $i) { customer { id firstName displayName } userErrors { field message } } }`, {
    i: { email: g.email, firstName: g.firstName || null, lastName: g.lastName || null, tags: ["google-login", "reviews"] },
  });
  const errs = c.customerCreate.userErrors;
  if (errs?.length) throw new Error("Could not sign you in: " + errs.map((e: any) => e.message).join(", "));
  const cu = c.customerCreate.customer;
  return { id: String(cu.id).split("/").pop()!, name: cu.firstName || cu.displayName || "" };
}

export async function googleLogin(admin: Admin, shop: string, credential: string) {
  const settings = await getSettings(admin);
  if (!settings.google_login || !settings.google_client_id) throw new Error("Google sign-in is turned off for this store.");
  const g = await verifyGoogleIdToken(credential, settings.google_client_id);
  const cu = await findOrCreateCustomer(admin, g);
  const name = cu.name || g.firstName || g.name || "Customer";
  return { token: signToken(shop, cu.id, name), customerId: cu.id, name, days: TOKEN_DAYS };
}
