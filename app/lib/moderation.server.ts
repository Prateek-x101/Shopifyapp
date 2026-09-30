/**
 * Moderation for what shoppers write in the review widget.
 *
 *   - Abusive words (English, Hindi/Hinglish, Devanagari) → the review / comment / reply waits as "pending" for the admin.
 *   - "Publish clean reviews right away" → reviews without abusive words go live at once (otherwise all wait).
 *   - "Only buyers can review" → a review needs a logged-in customer with an order of that product.
 *
 * Settings live on the shop in a private metafield `vw_reviews.moderation` (JSON, no storefront access, because the
 * extra blocked words should not be readable by shoppers):
 *   { buyers_only, auto_publish, extra_words: string[], spam_filter, auto_block: number, blocked: [{ id, name, at, reason }] }
 *
 *   - Spam (links, phone numbers, promotions, the same text again and again, bursts) → waits as "pending" and counts
 *     as a strike; after `auto_block` strikes in 24 hours the shopper is blocked. Blocked shoppers can't post at all.
 */
import { gql } from "./reviews.server";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

const NS = "vw_reviews";
const KEY = "moderation";

export type BlockedUser = { id: string; name: string; at: string; reason: string };
export type Moderation = {
  buyers_only: boolean;
  auto_publish: boolean;
  extra_words: string[];
  spam_filter: boolean;
  auto_block: number; // strikes in 24 h before an automatic block (0 = never)
  blocked: BlockedUser[];
  max_comments_per_hour: number; // comments + replies one shopper may post per hour (0 = no limit)
  max_reviews_per_day: number; // reviews one shopper may post per day (0 = no limit)
};
const DEFAULTS: Moderation = {
  buyers_only: true, auto_publish: true, extra_words: [], spam_filter: true, auto_block: 3, blocked: [],
  max_comments_per_hour: 10, max_reviews_per_day: 2,
};

/* ───────────────────────── word lists ───────────────────────── */
// Matched as whole words (after normalising), so "class" or "assistant" never trip "ass".
const WORDS = [
  // English
  "fuck", "fucking", "fucker", "fuk", "fck", "motherfucker", "shit", "bullshit", "bitch", "bitches", "bastard", "asshole", "ass",
  "dick", "dickhead", "cock", "pussy", "cunt", "slut", "whore", "wanker", "twat", "prick", "retard", "nigger", "nigga",
  "idiot", "stupid", "moron", "dumbass", "jackass", "douche", "porn", "nude",
  // (complaints like "fraud", "scam", "bekar" are not abuse: they stay visible)
  // Hinglish
  "chutiya", "chutiye", "chutia", "chutiyapa", "chut", "choot", "gandu", "gaandu", "gand", "gaand", "bhosdi", "bhosdike", "bhosdika",
  "bhosda", "bhosadi", "bsdk", "bc", "mc", "bkl", "mkc", "madarchod", "madharchod", "maderchod", "behenchod", "bhenchod", "benchod",
  "bhenchood", "behnchod", "lund", "lauda", "lawda", "loda", "lode", "lodu", "laude", "lavde", "randi", "raand", "randwa", "harami",
  "haramkhor", "haramzada", "haramzadi", "kamina", "kamine", "kutta", "kutte", "kutiya", "saala", "saale", "sala", "suar", "suwar",
  "tatti", "jhatu", "jhaatu", "jhant", "chodu", "chudai", "chinal", "hijda", "hijra", "gandmasti", "bakchod", "bakchodi",
  "ullu", "nalayak", "fattu", "tharki", "dalla", "bhadwa", "bhadwe", "bhadve", "kutti", "kuttiya", "chakka", "maakichut",
  // Devanagari
  "चूतिया", "चुतिया", "चूत", "गांडू", "गांड", "भोसडी", "भोसड़ी", "भोसडीके", "मादरचोद", "बहनचोद", "बहनचोद", "लौड़ा", "लौडा", "लंड",
  "रंडी", "हरामी", "हरामजादा", "कमीना", "कुत्ता", "कुत्ती", "कुतिया", "साला", "सूअर", "टट्टी", "झाटू", "भड़वा", "भडवा",
];
// Long enough to be matched inside other words too (e.g. "madarchodd", "xbehenchodx").
const STEMS = ["madarch", "maderch", "madharch", "behench", "bhench", "bhosd", "chutiy", "fuck", "motherf", "gaandu", "randibaaz", "haramzad", "मादरच", "बहनच", "भोसड"];

/** Lowercase, undo "leetspeak" and stretched letters: "F@@ckkk" → "fack"→ "fuck"-like forms still hit the stems. */
function normalise(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/(.)\1{2,}/gu, "$1$1"); // "chuuuutiya" → "chuutiya"
}

const squash = (w: string) => w.replace(/(.)\1+/gu, "$1"); // "chuutiya" → "chutiya"

/** True when the text contains a blocked word (built-in list + the shop's own words). */
export function isAbusive(text: string, extra: string[] = []) {
  const norm = normalise(text);
  const tokens = norm.split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  const words = new Set([...WORDS, ...extra].map((w) => squash(normalise(w.trim()))).filter(Boolean));
  for (const t of tokens) {
    if (words.has(t) || words.has(squash(t))) return true;
  }
  // "f u c k", "c.h.u.t.i.y.a": join everything and look for the long stems
  const joined = squash(tokens.join(""));
  const joinedSpaced = squash(norm.replace(/[^\p{L}\p{M}]+/gu, ""));
  return STEMS.some((s) => joined.includes(squash(s)) || joinedSpaced.includes(squash(s)));
}

/* ───────────────────────── settings ───────────────────────── */
const cache = new Map<string, { at: number; v: Moderation }>();

export async function getModeration(admin: Admin, shop = ""): Promise<Moderation> {
  const hit = shop ? cache.get(shop) : null;
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v: Moderation = { ...DEFAULTS };
  try {
    const d = await gql(admin, `{ shop { metafield(namespace: "${NS}", key: "${KEY}") { value } } }`);
    const raw = JSON.parse(d.shop.metafield?.value || "{}");
    v = {
      buyers_only: raw.buyers_only === undefined ? DEFAULTS.buyers_only : !!raw.buyers_only,
      auto_publish: raw.auto_publish === undefined ? DEFAULTS.auto_publish : !!raw.auto_publish,
      extra_words: Array.isArray(raw.extra_words) ? raw.extra_words.map(String).slice(0, 500) : [],
      spam_filter: raw.spam_filter === undefined ? DEFAULTS.spam_filter : !!raw.spam_filter,
      auto_block: Number.isFinite(raw.auto_block) ? Math.max(0, Math.min(20, raw.auto_block)) : DEFAULTS.auto_block,
      blocked: Array.isArray(raw.blocked) ? raw.blocked.filter((b: any) => b && b.id).slice(0, 2000) : [],
      max_comments_per_hour: Number.isFinite(raw.max_comments_per_hour) ? Math.max(0, Math.min(200, raw.max_comments_per_hour)) : DEFAULTS.max_comments_per_hour,
      max_reviews_per_day: Number.isFinite(raw.max_reviews_per_day) ? Math.max(0, Math.min(50, raw.max_reviews_per_day)) : DEFAULTS.max_reviews_per_day,
    };
  } catch { /* defaults */ }
  if (shop) cache.set(shop, { at: Date.now(), v });
  return v;
}

/** Saves the given settings on top of the current ones. */
export async function saveModeration(admin: Admin, shop: string, patch: Partial<Moderation>) {
  const cur = await getModeration(admin, "");
  const next = { ...cur, ...patch };
  const d = await gql(admin, `{ shop { id } }`);
  const value: Moderation = {
    buyers_only: !!next.buyers_only,
    auto_publish: !!next.auto_publish,
    extra_words: [...new Set(next.extra_words.map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 500),
    spam_filter: !!next.spam_filter,
    auto_block: Math.max(0, Math.min(20, Math.round(Number(next.auto_block) || 0))),
    blocked: next.blocked.slice(0, 2000),
    max_comments_per_hour: Math.max(0, Math.min(200, Math.round(Number(next.max_comments_per_hour) || 0))),
    max_reviews_per_day: Math.max(0, Math.min(50, Math.round(Number(next.max_reviews_per_day) || 0))),
  };
  const r = await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`, {
    m: [{ ownerId: d.shop.id, namespace: NS, key: KEY, type: "json", value: JSON.stringify(value) }],
  });
  const errs = r.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  cache.set(shop, { at: Date.now(), v: value });
  return value;
}

/* ───────────────────────── blocking ───────────────────────── */
export const isBlocked = (mod: Moderation, customerId: string) => !!customerId && mod.blocked.some((b) => b.id === customerId);

export async function blockUser(admin: Admin, shop: string, user: { id: string; name: string; reason: string }) {
  const mod = await getModeration(admin, "");
  if (isBlocked(mod, user.id)) return mod;
  return saveModeration(admin, shop, {
    blocked: [{ id: user.id, name: user.name.slice(0, 60), at: new Date().toISOString(), reason: user.reason.slice(0, 120) }, ...mod.blocked],
  });
}

export async function unblockUser(admin: Admin, shop: string, id: string) {
  const mod = await getModeration(admin, "");
  return saveModeration(admin, shop, { blocked: mod.blocked.filter((b) => b.id !== id) });
}

/* ───────────────────────── spam ───────────────────────── */
const PROMO = [
  "earn money", "make money", "work from home", "whatsapp me", "whatsapp karo", "dm me", "dm for", "inbox me", "telegram",
  "join my", "join our", "subscribe", "follow me", "follow my", "free followers", "click here", "click the link", "visit my",
  "check my profile", "crypto", "bitcoin", "forex", "trading tips", "investment plan", "loan", "betting", "casino", "satta",
  "lottery", "giveaway", "promo code", "discount code", "cheap price", "wholesale", "reseller", "call me", "contact me",
];
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|co|xyz|shop|store|link|me|ly|app|site|online)\b|wa\.me|t\.me|bit\.ly)/i;
const PHONE = /(\+?\d[\d\s-]{8,}\d)/;

const recent = new Map<string, { text: string; at: number }[]>(); // customer → last messages
const strikes = new Map<string, number[]>(); // customer → spam strike times

/** Why this message looks like spam ("" = fine). */
export function spamReason(customerId: string, text: string): string {
  const t = text.trim();
  const low = t.toLowerCase();
  if (LINK.test(low)) return "link";
  if (PHONE.test(t) && t.replace(/\D/g, "").length >= 10) return "phone number";
  if (PROMO.some((p) => low.includes(p))) return "promotion";
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 20 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.8) return "all caps";
  if ((t.match(/\p{Extended_Pictographic}/gu) || []).length > 12) return "too many emojis";
  if (/(.)\1{9,}/u.test(t) || /\b(\w+)\b(?:\s+\1\b){4,}/i.test(t)) return "repeated text";

  const now = Date.now();
  const mine = (recent.get(customerId) || []).filter((m) => now - m.at < 24 * 3600e3);
  const norm = low.replace(/\s+/g, " ");
  const dup = mine.some((m) => m.text === norm);
  const burst = mine.filter((m) => now - m.at < 2 * 60e3).length >= 5;
  mine.push({ text: norm, at: now });
  recent.set(customerId, mine.slice(-30));
  if (dup && norm.length > 3) return "same message again";
  if (burst) return "too many messages at once";
  return "";
}

/** Counts a spam strike; true when the shopper has now reached the automatic block. */
export function addStrike(customerId: string, limit: number) {
  const now = Date.now();
  const list = (strikes.get(customerId) || []).filter((t) => now - t < 24 * 3600e3);
  list.push(now);
  strikes.set(customerId, list);
  return limit > 0 && list.length >= limit;
}

/* ───────────────────────── posting limits ───────────────────────── */
const posts = new Map<string, number[]>(); // "c:<customer>" / "r:<customer>" → times

/** True when this post would go over the limit (the post is not counted then). 0 = no limit. */
export function overLimit(kind: "comment" | "review", customerId: string, mod: Moderation) {
  const max = kind === "comment" ? mod.max_comments_per_hour : mod.max_reviews_per_day;
  if (!max || !customerId) return false;
  const windowMs = kind === "comment" ? 3600e3 : 24 * 3600e3;
  const key = `${kind[0]}:${customerId}`;
  const now = Date.now();
  const list = (posts.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { posts.set(key, list); return true; }
  list.push(now);
  posts.set(key, list);
  return false;
}
