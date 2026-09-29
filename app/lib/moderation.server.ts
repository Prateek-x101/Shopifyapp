/**
 * Moderation for what shoppers write in the review widget.
 *
 *   - Abusive words (English, Hindi/Hinglish, Devanagari) → the review / comment / reply waits as "pending" for the admin.
 *   - "Publish clean reviews right away" → reviews without abusive words go live at once (otherwise all wait).
 *   - "Only buyers can review" → a review needs a logged-in customer with an order of that product.
 *
 * Settings live on the shop in a private metafield `vw_reviews.moderation` (JSON, no storefront access, because the
 * extra blocked words should not be readable by shoppers):  { buyers_only: boolean, auto_publish: boolean, extra_words: string[] }
 */
import { gql } from "./reviews.server";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

const NS = "vw_reviews";
const KEY = "moderation";

export type Moderation = { buyers_only: boolean; auto_publish: boolean; extra_words: string[] };
const DEFAULTS: Moderation = { buyers_only: true, auto_publish: true, extra_words: [] };

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
    };
  } catch { /* defaults */ }
  if (shop) cache.set(shop, { at: Date.now(), v });
  return v;
}

export async function saveModeration(admin: Admin, shop: string, next: Moderation) {
  const d = await gql(admin, `{ shop { id } }`);
  const value: Moderation = {
    buyers_only: !!next.buyers_only,
    auto_publish: !!next.auto_publish,
    extra_words: [...new Set(next.extra_words.map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 500),
  };
  const r = await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`, {
    m: [{ ownerId: d.shop.id, namespace: NS, key: KEY, type: "json", value: JSON.stringify(value) }],
  });
  const errs = r.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  cache.set(shop, { at: Date.now(), v: value });
  return value;
}
