/** Values used by both the server and the admin UI (safe to ship to the browser). */
export const STATUSES = ["pending", "published", "hidden"] as const;
export const SOURCES = ["Website", "WhatsApp", "Instagram", "Email", "Import"] as const;

/** Comment thread node (same shape the storefront review widget uses). Top level = comment, nested = reply. */
export type ReviewComment = {
  id: string;
  name: string;
  text: string;
  date: string;
  type: "store" | "customer";
  status: "approved" | "pending" | "hidden";
  avatar?: string | null; // image URL (store-added characters, Google profile…)
  customerId?: string | null;
  verified?: boolean;
  likeCount: number;
  parentCommentId?: string | null;
  replies?: ReviewComment[];
};

/** Accepts both the new tree and the first version's flat store replies ({author, isStore, createdAt}). */
export function normalizeComments(raw: unknown): ReviewComment[] {
  const list = Array.isArray(raw) ? raw : [];
  const norm = (c: any, parent: string | null): ReviewComment => ({
    id: String(c.id || `c_${Math.random().toString(36).slice(2, 10)}`),
    name: String(c.name ?? c.author ?? "Customer"),
    text: String(c.text ?? ""),
    date: String(c.date ?? c.createdAt ?? new Date().toISOString()),
    type: c.type === "store" || c.isStore ? "store" : "customer",
    status: c.status === "pending" ? "pending" : c.status === "hidden" ? "hidden" : "approved",
    avatar: c.avatar ? String(c.avatar) : null,
    customerId: c.customerId ? String(c.customerId) : null,
    verified: !!c.verified,
    likeCount: Math.max(0, parseInt(c.likeCount ?? c.likes ?? 0, 10) || 0),
    parentCommentId: parent,
    replies: (Array.isArray(c.replies) ? c.replies : []).map((r: any) => norm(r, String(c.id))),
  });
  return list.filter((c) => c && typeof c === "object").map((c) => norm(c, null));
}
export function countComments(list: ReviewComment[]): number {
  return list.reduce((n, c) => n + 1 + countComments(c.replies || []), 0);
}

/** "Comments" filter on the reviews list. */
export const COMMENT_FILTERS = {
  with: "With comments",
  without: "No comments",
  replies: "With replies in the thread",
  store: "Store has replied",
  nostore: "Store hasn't replied",
  needs: "Needs reply",
  waiting: "Waiting for approval",
} as const;
export type CommentFilter = keyof typeof COMMENT_FILTERS;

/* ───────────────────────── bulk upload ───────────────────────── */
/** A comment (top level) or reply (nested) in a bulk upload. `store: true` = written as the store. */
export type BulkComment = {
  name: string;
  text: string;
  date?: string; // ISO
  store?: boolean;
  avatar?: string;
  likes?: number;
  replies: BulkComment[];
};

export type BulkItem = {
  author: string;
  rating: number;
  body: string;
  title?: string;
  location?: string;
  date?: string; // ISO
  verified?: boolean;
  images: string[]; // photo URLs
  avatar?: string; // picture URL
  helpful?: number;
  comments?: BulkComment[];
};

const pick = (o: any, keys: string[]) => {
  for (const k of keys) {
    const hit = Object.keys(o).find((x) => x.toLowerCase().replace(/[\s_-]/g, "") === k);
    if (hit && o[hit] !== undefined && o[hit] !== null && String(o[hit]).trim() !== "") return o[hit];
  }
  return undefined;
};

function toDate(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // 25/09/2026
  const t = dmy ? Date.parse(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}T12:00:00+05:30`) : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

const urlList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/))
    .map((x: any) => String(typeof x === "object" && x ? x.url || x.src || "" : x).trim())
    .filter((x) => /^https?:\/\//i.test(x));

/** "@store", "store", "Vesturewears (store)" → written as the store. */
const STORE_NAME = /^@?store$/i;
const STORE_TAG = /\s*[([]store[)\]]\s*$/i;

const MAX_COMMENTS = 60; // per review, all levels
const MAX_DEPTH = 4;

function toComment(o: any, where: string, errors: string[], depth: number, budget: { n: number }): BulkComment | null {
  if (!o || typeof o !== "object") { errors.push(`${where}: comment is not an object`); return null; }
  let name = String(pick(o, ["name", "author", "by", "user"]) ?? "").trim();
  const text = String(pick(o, ["text", "comment", "message", "body", "reply"]) ?? "").trim();
  if (!text) { errors.push(`${where}: comment text missing`); return null; }
  if (budget.n >= MAX_COMMENTS) return null;
  budget.n++;
  const typ = String(pick(o, ["type"]) ?? "");
  let store = o.store === true || /^(true|yes|1)$/i.test(String(pick(o, ["store", "isstore"]) ?? "")) || /^store$/i.test(typ);
  if (STORE_NAME.test(name)) { store = true; name = ""; }
  if (STORE_TAG.test(name)) { store = true; name = name.replace(STORE_TAG, ""); }
  if (!name && !store) { errors.push(`${where}: comment name missing`); budget.n--; return null; }
  const likes = parseInt(String(pick(o, ["likes", "likecount", "helpful"]) ?? ""), 10);
  const kids = pick(o, ["replies", "children", "answers"]);
  return {
    name: name.slice(0, 60),
    text: text.slice(0, 2000),
    date: toDate(pick(o, ["date", "createdat", "created"])),
    store: store || undefined,
    avatar: urlList(pick(o, ["avatar", "picture", "photo"]))[0],
    likes: Number.isFinite(likes) && likes > 0 ? likes : undefined,
    replies: depth < MAX_DEPTH && Array.isArray(kids)
      ? (kids.map((k: any, i: number) => toComment(k, `${where}.${i + 1}`, errors, depth + 1, budget)).filter(Boolean) as BulkComment[])
      : [],
  };
}

function toItem(o: any, where: string, errors: string[]): BulkItem | null {
  const author = String(pick(o, ["author", "name", "reviewer", "customer", "customername"]) ?? "").trim();
  const body = String(pick(o, ["body", "text", "review", "content", "message"]) ?? "").trim();
  const rating = Math.round(Number(pick(o, ["rating", "stars", "star", "score"]) ?? 5));
  if (!author) { errors.push(`${where}: name missing`); return null; }
  if (!body) { errors.push(`${where}: review text missing`); return null; }
  if (!(rating >= 1 && rating <= 5)) { errors.push(`${where}: rating must be 1–5`); return null; }
  const v = pick(o, ["verified", "verifiedbuyer"]);
  const helpful = parseInt(String(pick(o, ["helpful", "helpfulcount"]) ?? ""), 10);
  const rawComments = pick(o, ["comments", "thread", "conversation"]);
  const budget = { n: 0 };
  return {
    author: author.slice(0, 60),
    rating,
    body: body.slice(0, 5000),
    title: String(pick(o, ["title", "heading"]) ?? "").trim().slice(0, 120) || undefined,
    location: String(pick(o, ["location", "city", "place"]) ?? "").trim().slice(0, 60) || undefined,
    date: toDate(pick(o, ["date", "createdat", "created", "reviewdate"])),
    verified: v === undefined ? undefined : !/^(false|no|0)$/i.test(String(v)),
    images: urlList(pick(o, ["images", "photos", "image", "photo", "media"])).slice(0, 6),
    avatar: urlList(pick(o, ["avatar", "picture", "profilepic", "photourl"]))[0],
    helpful: Number.isFinite(helpful) && helpful > 0 ? helpful : undefined,
    comments: Array.isArray(rawComments)
      ? (rawComments.map((c: any, i: number) => toComment(c, `${where} comment ${i + 1}`, errors, 1, budget)).filter(Boolean) as BulkComment[])
      : undefined,
  };
}

export const countBulkComments = (list: BulkComment[] = []): number =>
  list.reduce((n, c) => n + 1 + countBulkComments(c.replies), 0);

/**
 * JSON: an array of reviews (or { "reviews": [...] }), each may have "comments": [{ name, text, replies: [...] }].
 * Text: one review per line → Name | City | Rating | Review text | Date | photo URLs (comma separated).
 *       Lines under a review starting with ">" are comments, ">>" replies to the comment above, ">>>" deeper:
 *       > Priya | Is the size true to fit? | 14/09/2026
 *       >> @store | Yes, it's true to size!
 */
export function parseBulkReviews(raw: string): { items: BulkItem[]; errors: string[] } {
  const errors: string[] = [];
  const items: BulkItem[] = [];
  const src = raw.replace(/^﻿/, "").trim();
  if (!src) return { items, errors: ["The file is empty"] };

  if (src.startsWith("[") || src.startsWith("{")) {
    let data: any;
    try { data = JSON.parse(src); } catch (e: any) { return { items, errors: [`Invalid JSON: ${e.message}`] }; }
    const list = Array.isArray(data) ? data : Array.isArray(data?.reviews) ? data.reviews : [data];
    list.forEach((o: any, i: number) => {
      if (!o || typeof o !== "object") { errors.push(`Review ${i + 1}: not an object`); return; }
      const it = toItem(o, `Review ${i + 1}`, errors);
      if (it) items.push(it);
    });
    return { items, errors };
  }

  let last: BulkItem | null = null; // review the ">" lines belong to
  let lastBudget = { n: 0 };
  const stack: BulkComment[] = []; // stack[d-1] = latest comment at depth d
  src.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith("#")) return;

    const quote = l.match(/^(>+)\s*(.*)$/);
    if (quote) {
      const depth = Math.min(quote[1].length, MAX_DEPTH);
      if (!last) { errors.push(`Line ${i + 1}: comment before any review`); return; }
      if (depth > stack.length + 1) { errors.push(`Line ${i + 1}: reply ("${quote[1]}") without a comment above it`); return; }
      const [name, text, date] = quote[2].split("|").map((x) => x.trim());
      const c = toComment({ name, text, date }, `Line ${i + 1}`, errors, depth, lastBudget);
      if (!c) return;
      if (depth === 1) (last.comments ||= []).push(c);
      else stack[depth - 2].replies.push(c);
      stack.length = depth - 1;
      stack.push(c);
      return;
    }

    const parts = l.split(l.includes("|") ? "|" : "\t").map((x) => x.trim());
    if (i === 0 && /name/i.test(parts[0]) && parts.some((p) => /rating|stars/i.test(p))) return; // header row
    const [name, city, rating, text, date, photos] = parts;
    const it = toItem({ name, city, rating, text, date, photos }, `Line ${i + 1}`, errors);
    last = it;
    lastBudget = { n: 0 };
    stack.length = 0;
    if (it) items.push(it);
  });
  return { items, errors };
}
