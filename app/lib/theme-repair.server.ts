/**
 * Small, targeted repairs to the review widget in the live theme (Online Store → published theme).
 *
 * Reads the current file from the theme, applies only the listed patches that are still missing, and writes it back,
 * so whatever else is in the file stays exactly as it is. Safe to run again (each patch checks itself first).
 */
import { gql } from "./reviews.server";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

const FILE = "assets/review-widget.js";

type Patch = { id: string; label: string; applied: (s: string) => boolean; apply: (s: string) => string | null };

const PATCHES: Patch[] = [
  {
    // submitComment() calls getCommenterName(), which is missing → ReferenceError, the reply is never sent and the
    // widget stays "submitting" (every later reply is ignored too).
    id: "commenter-name",
    label: "Replies: missing getCommenterName()",
    applied: (s) => /function\s+getCommenterName\s*\(/.test(s),
    apply: (s) => {
      const fn =
        "function getCommenterName() {\n" +
        "        try { if (typeof getCustomerDisplayName === 'function') { const n = getCustomerDisplayName(); if (n) return n; } } catch (e) {}\n" +
        "        const c = window.__arwCustomer || null;\n" +
        "        return (c && (c.name || [c.firstName, c.lastName].filter(Boolean).join(' '))) || 'Customer';\n" +
        "    }\n    ";
      const m = s.match(/let\s+isSubmitting\s*=\s*(?:false|!1)\s*;/);
      if (!m || m.index === undefined) return null;
      return s.slice(0, m.index) + fn + s.slice(m.index);
    },
  },
  {
    // if anything throws while drawing the new reply, release the lock so the next send still works
    id: "submit-unlock",
    label: "Replies: never stay stuck after an error",
    applied: (s) => s.includes("__arwSubmitGuard"),
    apply: (s) => {
      const m = s.match(/async\s+function\s+submitComment\s*\(\s*\)\s*\{/);
      if (!m || m.index === undefined) return null;
      // submitComment is async, so a crash inside it surfaces as an unhandled rejection
      const guard =
        "(function __arwSubmitGuard() { const unlock = function () { try { isSubmitting = false; } catch (e) {} };\n" +
        "        window.addEventListener('unhandledrejection', unlock); window.addEventListener('error', unlock); })();\n    ";
      return s.slice(0, m.index) + guard + s.slice(m.index);
    },
  },
];

async function mainTheme(admin: Admin) {
  const d = await gql(admin, `{ themes(first: 1, roles: [MAIN]) { nodes { id name
    files(filenames: ["${FILE}"]) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } } } }`);
  const t = d.themes.nodes[0];
  if (!t) throw new Error("No published theme found");
  const content: string | undefined = t.files?.nodes?.[0]?.body?.content;
  return { id: t.id as string, name: t.name as string, content };
}

/** What the live widget still needs. */
export async function widgetStatus(admin: Admin) {
  const t = await mainTheme(admin);
  if (!t.content) return { theme: t.name, found: false, missing: [] as string[] };
  return { theme: t.name, found: true, missing: PATCHES.filter((p) => !p.applied(t.content!)).map((p) => p.label) };
}

export async function repairWidget(admin: Admin) {
  const t = await mainTheme(admin);
  if (!t.content) throw new Error(`${FILE} was not found in the theme "${t.name}"`);
  let s = t.content;
  const done: string[] = [];
  const failed: string[] = [];
  for (const p of PATCHES) {
    if (p.applied(s)) continue;
    const next = p.apply(s);
    if (next && p.applied(next)) { s = next; done.push(p.label); } else failed.push(p.label);
  }
  if (!done.length) return { theme: t.name, done, failed };
  const r = await gql(admin, `mutation($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $id, files: $files) { upsertedThemeFiles { filename } userErrors { field message } } }`, {
    id: t.id,
    files: [{ filename: FILE, body: { type: "TEXT", value: s } }],
  });
  const errs = r.themeFilesUpsert.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  return { theme: t.name, done, failed };
}
