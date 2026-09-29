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

/* ───────────────────────── bulk upload ───────────────────────── */
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

function toItem(o: any, where: string, errors: string[]): BulkItem | null {
  const author = String(pick(o, ["author", "name", "reviewer", "customer", "customername"]) ?? "").trim();
  const body = String(pick(o, ["body", "text", "review", "content", "comment", "message"]) ?? "").trim();
  const rating = Math.round(Number(pick(o, ["rating", "stars", "star", "score"]) ?? 5));
  if (!author) { errors.push(`${where}: name missing`); return null; }
  if (!body) { errors.push(`${where}: review text missing`); return null; }
  if (!(rating >= 1 && rating <= 5)) { errors.push(`${where}: rating must be 1–5`); return null; }
  const v = pick(o, ["verified", "verifiedbuyer"]);
  const helpful = parseInt(String(pick(o, ["helpful", "likes", "helpfulcount"]) ?? ""), 10);
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
  };
}

/**
 * JSON: an array of reviews (or { "reviews": [...] }).
 * Text: one review per line → Name | City | Rating | Review text | Date | photo URLs (comma separated).
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

  src.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith("#")) return;
    const parts = l.split(l.includes("|") ? "|" : "\t").map((x) => x.trim());
    if (i === 0 && /name/i.test(parts[0]) && parts.some((p) => /rating|stars/i.test(p))) return; // header row
    const [name, city, rating, text, date, photos] = parts;
    const it = toItem({ name, city, rating, text, date, photos }, `Line ${i + 1}`, errors);
    if (it) items.push(it);
  });
  return { items, errors };
}
