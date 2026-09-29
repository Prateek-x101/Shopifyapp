/**
 * Small, targeted repairs to the review widget in the live theme (Online Store → published theme).
 *
 * Reads the current files from the theme, applies only the patches that are still missing, and writes them back,
 * so whatever else is in a file stays exactly as it is. Safe to run again (each patch checks itself first).
 * engine-google-login.js belongs to this app, so it is replaced as a whole by the version in app/theme-assets.
 */
import { gql } from "./reviews.server";
import GOOGLE_LOGIN_JS from "../theme-assets/engine-google-login.js?raw";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

type Patch = { label: string; applied: (s: string) => boolean; apply: (s: string) => string | null };

/** Insert `add` right before the first match of `re` (null when there is no match). */
function before(s: string, re: RegExp, add: string) {
  const m = s.match(re);
  if (!m || m.index === undefined) return null;
  return s.slice(0, m.index) + add + s.slice(m.index);
}
/** Replace the first match of `re` (null when there is no match). */
function swap(s: string, re: RegExp, to: (m: RegExpMatchArray) => string) {
  const m = s.match(re);
  if (!m || m.index === undefined) return null;
  return s.slice(0, m.index) + to(m) + s.slice(m.index + m[0].length);
}

const WIDGET_JS: Patch[] = [
  {
    // submitComment() calls getCommenterName(), which was missing → ReferenceError, the reply is never sent
    label: "Replies: missing getCommenterName()",
    applied: (s) => /function\s+getCommenterName\s*\(/.test(s),
    apply: (s) =>
      before(s, /let\s+isSubmitting\s*=\s*(?:false|!1)\s*;/,
        "function getCommenterName() {\n" +
        "        try { if (typeof getCustomerDisplayName === 'function') { const n = getCustomerDisplayName(); if (n) return n; } } catch (e) {}\n" +
        "        const c = window.__arwCustomer || null;\n" +
        "        return (c && (c.name || [c.firstName, c.lastName].filter(Boolean).join(' '))) || 'Customer';\n" +
        "    }\n    "),
  },
  {
    // if anything throws while drawing the new reply, release the lock so the next send still works
    label: "Replies: never stay stuck after an error",
    applied: (s) => s.includes("__arwSubmitGuard"),
    apply: (s) =>
      before(s, /async\s+function\s+submitComment\s*\(\s*\)\s*\{/,
        "(function __arwSubmitGuard() { const unlock = function () { try { isSubmitting = false; } catch (e) {} };\n" +
        "        window.addEventListener('unhandledrejection', unlock); window.addEventListener('error', unlock); })();\n    "),
  },
  {
    // Google sign-in switches the customer without reloading the page
    label: "Login: no page reload after signing in",
    applied: (s) => s.includes("__arwSetCustomer"),
    apply: (s) =>
      swap(s, /const\s+CUSTOMER\s*=\s*window\.__arwCustomer\s*\|\|\s*null\s*;/, () =>
        "let CUSTOMER = window.__arwCustomer || null;\n    window.__arwSetCustomer = function (c) { CUSTOMER = c || null; };"),
  },
  {
    // the sheet kept its open height while sliding away, then snapped smaller → it looked like it jumped
    label: "Comments sheet: smooth close",
    applied: (s) => s.includes("__arwSheetH"),
    apply: (s) =>
      swap(s, /(function\s+closeReplies\s*\([^)]*\)\s*\{[\s\S]*?sheet\.classList\.remove\(\s*'active'\s*\)\s*;\s*)sheet\.style\.height\s*=\s*''\s*;/, (m) =>
        m[1] + "const __arwSheetH = sheet; setTimeout(function () { if (!__arwSheetH.classList.contains('active')) __arwSheetH.style.height = ''; }, 420);"),
  },
  {
    // nobody replies to their own comment: hide "Reply" on it
    label: "Comments: no Reply on your own comment",
    applied: (s) => s.includes("__arwIsMine"),
    apply: (s) => {
      const withHelper = before(s, /function\s+ytItem\s*\(/,
        "function __arwIsMine(item) {\n" +
        "        if (!item || !CUSTOMER || !CUSTOMER.id) return false;\n" +
        "        return item.mine === true || (item.customerId != null && String(item.customerId) === String(CUSTOMER.id));\n" +
        "    }\n    ");
      if (!withHelper) return null;
      return swap(withHelper, /html\s*\+=\s*`<button type="button" class="yt-reply" onclick="ARWidget\._replyTo\('\$\{escapeHtml\(id\)\}'/, (m) =>
        "if (!__arwIsMine(item)) " + m[0]);
    },
  },
  {
    // a comment you just posted is yours at once (before the page is reloaded)
    label: "Comments: your new comment is marked as yours",
    applied: (s) => /id:\s*'cmt_'\s*\+\s*Date\.now\(\),\s*mine:\s*true/.test(s),
    apply: (s) => swap(s, /id:\s*'cmt_'\s*\+\s*Date\.now\(\),/, (m) => m[0] + " mine: true,"),
  },
];

const WIDGET_CSS: Patch[] = [
  {
    // the page scrollbar disappeared while the sheet was open → the whole page shifted sideways and back
    label: "Comments sheet: page doesn't shift when it opens/closes",
    applied: (s) => s.includes("engine: steady page"),
    apply: (s) =>
      s.replace(/\s*$/, "") +
      "\n\n/* engine: steady page while the comments sheet is open (no scrollbar jump, same height open and closing) */\n" +
      "html { scrollbar-gutter: stable; }\n" +
      ".ai-reply-sheet { height: 70vh; }\n",
  },
];

const same = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
const GOOGLE_LOGIN: Patch[] = [
  {
    label: "Login: one login with the store account (Google), back to the same review",
    applied: (s) => same(s, GOOGLE_LOGIN_JS),
    apply: () => GOOGLE_LOGIN_JS,
  },
];

const WIDGET_LIQUID: Patch[] = [
  {
    // tell the login script which log-in to use (Engine → Settings → Customer login)
    label: "Login: uses the store sign-in chosen in Settings",
    applied: (s) => s.includes("vw_app_settings.login_mode"),
    apply: (s) =>
      swap(s, /window\.__vwGoogle\s*=\s*\{\s*/, (m) => m[0] + "mode: {{ vw_app_settings.login_mode | default: 'shopify' | json }}, "),
  },
];

const FILES: Record<string, Patch[]> = {
  "assets/review-widget.js": WIDGET_JS,
  "assets/review-widget.css": WIDGET_CSS,
  "assets/engine-google-login.js": GOOGLE_LOGIN,
  "sections/engine-review-widget.liquid": WIDGET_LIQUID,
};

async function mainTheme(admin: Admin) {
  const names = JSON.stringify(Object.keys(FILES));
  const d = await gql(admin, `{ themes(first: 1, roles: [MAIN]) { nodes { id name
    files(filenames: ${names}, first: 10) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } } } }`);
  const t = d.themes.nodes[0];
  if (!t) throw new Error("No published theme found");
  const files: Record<string, string> = {};
  (t.files?.nodes || []).forEach((f: any) => { if (typeof f.body?.content === "string") files[f.filename] = f.body.content; });
  return { id: t.id as string, name: t.name as string, files };
}

/** What the live widget still needs. */
export async function widgetStatus(admin: Admin) {
  const t = await mainTheme(admin);
  const found = !!t.files["assets/review-widget.js"];
  const missing: string[] = [];
  for (const [file, patches] of Object.entries(FILES)) {
    const s = t.files[file];
    if (s === undefined) continue;
    patches.forEach((p) => { if (!p.applied(s)) missing.push(p.label); });
  }
  return { theme: t.name, found, missing };
}

export async function repairWidget(admin: Admin) {
  const t = await mainTheme(admin);
  if (!t.files["assets/review-widget.js"]) throw new Error(`assets/review-widget.js was not found in the theme "${t.name}"`);
  const done: string[] = [];
  const failed: string[] = [];
  const changed: { filename: string; body: { type: "TEXT"; value: string } }[] = [];
  for (const [file, patches] of Object.entries(FILES)) {
    let s = t.files[file];
    if (s === undefined) continue;
    const start = s;
    for (const p of patches) {
      if (p.applied(s)) continue;
      const next = p.apply(s);
      if (next && p.applied(next)) { s = next; done.push(p.label); } else failed.push(p.label);
    }
    if (s !== start) changed.push({ filename: file, body: { type: "TEXT", value: s } });
  }
  if (!changed.length) return { theme: t.name, done, failed };
  const r = await gql(admin, `mutation($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $id, files: $files) { upsertedThemeFiles { filename } userErrors { field message } } }`, {
    id: t.id,
    files: changed,
  });
  const errs = r.themeFilesUpsert.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  return { theme: t.name, done, failed };
}

/** For tests: the patch lists. */
export const __patches = FILES;
