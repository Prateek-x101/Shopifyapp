/**
 * AI helpers (Google Gemini) with the store's own API key (Settings → AI).
 *
 * The key lives in the app database, encrypted, and never goes to the browser or a metafield.
 * What the AI does:
 *   - writes / polishes replies AS THE STORE in a review's conversation (the admin checks and sends)
 *   - turns a real customer's message or chat screenshot into a review draft, in the customer's own words
 *   - sums up a product's reviews for the admin (likes, complaints, sizing, open questions)
 *   - makes TEST reviews (with comments) for trying out the widget: they are saved with source "Test",
 *     always hidden, never on the store, and deleted together (see guardTest in reviews.server.ts)
 * It never writes published reviews, comments or replies in a customer's name.
 */
import crypto from "node:crypto";
import prisma from "../db.server";
import type { ReviewComment } from "./reviews.shared";

export const DEFAULT_MODEL = "gemini-2.5-flash";
const API = "https://generativelanguage.googleapis.com/v1beta";

export class AiError extends Error {}

/* ───────────────────────── key storage ───────────────────────── */
function sealKey() {
  const s = process.env.SHOPIFY_API_SECRET || process.env.SESSION_SECRET || "vesture-studio-local";
  return crypto.createHash("sha256").update("ai-key:" + s).digest();
}
function seal(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
function unseal(sealed: string) {
  try {
    const [v, iv, tag, data] = String(sealed || "").split(".");
    if (v !== "v1") return "";
    const d = crypto.createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export type AiLanguage = "auto" | "english" | "hinglish";
export type AiSettings = { hasKey: boolean; keyHint: string; model: string; voice: string; facts: string; language: AiLanguage };

async function loadAi(shop: string) {
  const row = await prisma.aiConfig.findUnique({ where: { shop } });
  const key = row ? unseal(row.apiKey) : "";
  const pub: AiSettings = {
    hasKey: !!key,
    keyHint: key ? `…${key.slice(-4)}` : "",
    model: row?.model || DEFAULT_MODEL,
    voice: row?.voice || "",
    facts: row?.facts || "",
    language: (["auto", "english", "hinglish"].includes(row?.language || "") ? row!.language : "auto") as AiLanguage,
  };
  return { key, pub };
}

/** What the Settings page may see (no key). */
export async function getAiSettings(shop: string): Promise<AiSettings> {
  return (await loadAi(shop)).pub;
}

export async function saveAiSettings(
  shop: string,
  patch: { apiKey?: string | null; model?: string; voice?: string; facts?: string; language?: string },
) {
  const data: Record<string, string> = {};
  if (patch.apiKey === null) data.apiKey = "";
  else if (patch.apiKey && patch.apiKey.trim()) data.apiKey = seal(patch.apiKey.trim());
  if (patch.model !== undefined) data.model = String(patch.model).replace(/^models\//, "").trim().slice(0, 80) || DEFAULT_MODEL;
  if (patch.voice !== undefined) data.voice = String(patch.voice).slice(0, 1500);
  if (patch.facts !== undefined) data.facts = String(patch.facts).slice(0, 3000);
  if (patch.language !== undefined) data.language = ["auto", "english", "hinglish"].includes(patch.language) ? patch.language : "auto";
  await prisma.aiConfig.upsert({ where: { shop }, create: { shop, ...data }, update: data });
}

/** Models this key can use for text (newest Gemini first); also proves the key works. */
export async function listModels(shop: string, keyOverride?: string) {
  const key = (keyOverride || "").trim() || (await loadAi(shop)).key;
  if (!key) throw new AiError("Add your Gemini API key first");
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiError(friendlyError(res.status, body, ""));
  const names: string[] = (body.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: any) => String(m.name || "").replace(/^models\//, ""))
    .filter((n: string) => /^gemini/i.test(n) && !/(tts|image|embedding|live|audio|vision)/i.test(n));
  return names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/* ───────────────────────── calling Gemini ───────────────────────── */
function friendlyError(status: number, body: any, model: string) {
  const msg = String(body?.error?.message || "");
  const reason = JSON.stringify(body?.error?.details || "");
  if (/API_KEY_INVALID|API key not valid/i.test(msg + reason)) return "This Gemini API key isn't valid. Check it in Settings → AI.";
  if (status === 404) return `The model "${model}" isn't available for this key. Pick another one in Settings → AI.`;
  if (status === 429) return "Gemini's limit is used up for now (free tier). Try again in a minute, or turn on billing in Google AI Studio.";
  if (status === 403) return "This key isn't allowed to use Gemini. Check the key's project in Google AI Studio.";
  if (status >= 500) return "Gemini is busy right now. Try again in a moment.";
  return msg ? `Gemini: ${msg.slice(0, 200)}` : `Gemini error (${status})`;
}

const hits = new Map<string, number[]>();
function overLimit(shop: string, max = 40, windowMs = 60_000) {
  const now = Date.now();
  const list = (hits.get(shop) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(shop, list);
  return list.length > max;
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

async function gemini(
  shop: string,
  opts: { system: string; parts: Part[]; json?: boolean; temperature?: number; maxTokens?: number },
): Promise<string> {
  const { key, pub } = await loadAi(shop);
  if (!key) throw new AiError("Add your Gemini API key in Settings → AI first.");
  if (overLimit(shop)) throw new AiError("Too many AI requests in a minute. Wait a moment and try again.");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(`${API}/models/${encodeURIComponent(pub.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: "user", parts: opts.parts }],
        generationConfig: {
          temperature: opts.temperature ?? 0.7,
          maxOutputTokens: opts.maxTokens ?? 4096,
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
        },
      }),
      signal: ctl.signal,
    });
  } catch (e: any) {
    throw new AiError(e?.name === "AbortError" ? "Gemini took too long. Try again." : "Couldn't reach Gemini. Try again.");
  } finally {
    clearTimeout(timer);
  }
  const body: any = await res.json().catch(() => ({}));
  // older models allow fewer output tokens: try once more with their limit
  if (res.status === 400 && (opts.maxTokens || 0) > 8192 && /output.?tokens/i.test(String(body?.error?.message || ""))) {
    return gemini(shop, { ...opts, maxTokens: 8192 });
  }
  if (!res.ok) throw new AiError(friendlyError(res.status, body, pub.model));
  if (body?.promptFeedback?.blockReason) throw new AiError("Gemini refused this text (safety filter). Edit it and try again.");
  const cand = body?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
  if (!text) {
    if (cand?.finishReason === "SAFETY") throw new AiError("Gemini refused this text (safety filter).");
    throw new AiError("Gemini sent an empty answer. Try again.");
  }
  return text;
}

function parseJson<T>(text: string): T {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new AiError("Gemini's answer couldn't be read. Try again.");
  }
}

function languageRule(lang: AiLanguage) {
  if (lang === "english") return "Always reply in simple, friendly English.";
  if (lang === "hinglish") return "Always reply in Hinglish (Hindi words written in English letters, mixed with English), the way Indian shoppers chat on WhatsApp.";
  return "Reply in the same language and script the customer used: English → English, Hinglish (Hindi in English letters) → Hinglish, Hindi in Devanagari → Hindi.";
}

function storeRules(s: AiSettings) {
  return [
    s.voice.trim() ? `How the store talks:\n${s.voice.trim()}` : "",
    s.facts.trim()
      ? `Store facts (the only facts you may state; nothing else about prices, offers, delivery dates, stock or policies):\n${s.facts.trim()}`
      : "You have no store facts: don't state prices, offers, delivery dates, stock or policies.",
  ].filter(Boolean).join("\n\n");
}

/* ───────────────────────── 1 · replies as the store ───────────────────────── */
type ReviewLike = { author: string; rating: number; body: string; location?: string | null; createdAt: Date | string; replies: string | ReviewComment[] };

function threadText(list: ReviewComment[], shopName: string, depth = 0): string[] {
  const out: string[] = [];
  list.forEach((c) => {
    if (c.status === "hidden") return;
    const who = c.type === "store" ? `[Store] ${shopName}` : `[Customer] ${c.name}`;
    const when = new Date(c.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    out.push(`${"  ".repeat(depth)}- ${who} (${when}) [id ${c.id}]: ${String(c.text || "").replace(/\s+/g, " ").slice(0, 600)}`);
    out.push(...threadText(c.replies || [], shopName, depth + 1));
  });
  return out;
}

function findComment(list: ReviewComment[], id: string): ReviewComment | null {
  for (const c of list) {
    if (c.id === id) return c;
    const hit = findComment(c.replies || [], id);
    if (hit) return hit;
  }
  return null;
}

export async function suggestStoreReply(
  shop: string,
  input: { shopName: string; productTitle: string; review: ReviewLike; targetId?: string | null; draft?: string },
) {
  const { pub } = await loadAi(shop);
  const comments: ReviewComment[] = typeof input.review.replies === "string" ? JSON.parse(input.review.replies || "[]") : input.review.replies || [];
  const target = input.targetId ? findComment(comments, input.targetId) : null;
  if (input.targetId && !target) throw new AiError("That comment isn't in this review any more.");
  if (target && target.type === "store") throw new AiError("That message is from your store. Pick a customer's comment to reply to.");

  const r = input.review;
  const context = [
    `Product: ${input.productTitle}`,
    `Review by ${r.author}${r.location ? ` from ${r.location}` : ""}, ${r.rating}★, ${new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}:`,
    `"${String(r.body || "").slice(0, 1500)}"`,
    comments.length ? `\nConversation under the review (oldest first):\n${threadText(comments, input.shopName).join("\n")}` : "\nNo comments yet.",
    target ? `\nWrite the store's reply to this comment by ${target.name}: "${target.text}"` : `\nWrite the store's reply to ${r.author}'s review.`,
  ].join("\n");

  const polishing = !!input.draft?.trim();
  const system = [
    `You are the customer-care voice of the online store "${input.shopName}". You write the store's public replies under product reviews on its website.`,
    "Write as the store's team (we/our), never as a customer. Warm, human and specific to what they said; 1–3 short sentences; at most one emoji; no hashtags; no sign-off unless the store voice asks for one.",
    "Thank happy customers for something specific they mentioned. For a problem (late delivery, size, quality), say sorry briefly and offer help (for example: message us on WhatsApp with your order number). Answer a question only with the store facts; otherwise invite them to message the store.",
    "Never promise refunds, discounts, gifts or dates unless the store facts say so. Never ask for phone numbers or addresses in public.",
    languageRule(pub.language),
    storeRules(pub),
    polishing
      ? "The admin wrote a draft reply. Rewrite it so it reads well and follows these rules, keeping its meaning and any facts it contains. Return only the reply text."
      : "Return only the reply text, nothing else.",
  ].join("\n\n");

  const parts: Part[] = [{ text: context + (polishing ? `\n\nDraft reply to improve:\n"${input.draft!.trim()}"` : "") }];
  const text = await gemini(shop, { system, parts, temperature: polishing ? 0.4 : 0.8, maxTokens: 2048 });
  return text.replace(/^["“]|["”]$/g, "").trim().slice(0, 1200);
}

/* ───────────────────────── 2 · a real customer's message → review draft ───────────────────────── */
export type ReviewDraft = { author: string; city: string; rating: number | null; body: string; notes: string[] };

export async function draftFromCustomerMessage(
  shop: string,
  input: { productTitle: string; text?: string; image?: { mime: string; base64: string } | null; translate?: boolean },
): Promise<ReviewDraft> {
  if (!input.text?.trim() && !input.image) throw new AiError("Paste the customer's message or add a screenshot of the chat.");
  const system = [
    "You turn a REAL customer's feedback (usually a WhatsApp chat with the store, often in Hinglish) into one product review entry for the store's admin.",
    "Use only what the customer actually wrote. Never add praise, details, feelings or facts they didn't say. If there are several customer messages about the product, join them into one review in their own words.",
    "In a chat screenshot, the customer's messages are the ones on the LEFT; ignore the store's messages on the right, timestamps and system text.",
    input.translate
      ? "Translate the review into simple natural English, keeping the meaning and tone exactly."
      : "Keep the customer's language and wording; only fix obvious spelling and spacing.",
    "rating: a whole number 1–5 only if the customer clearly gave or implied one (stars, '5/5', 'best product', 'very bad'); otherwise null.",
    "author: the customer's name only if it appears (chat title or signature), else an empty string. city: only if mentioned, else empty.",
    "notes: short notes for the admin about anything unclear (for example 'no rating given', 'name not visible', 'message is not about the product').",
    'Answer as JSON: {"author": string, "city": string, "rating": number|null, "body": string, "notes": string[]}',
  ].join("\n");
  const parts: Part[] = [{ text: `Product: ${input.productTitle}\n\n${input.text?.trim() ? `Customer's message:\n${input.text.trim().slice(0, 6000)}` : "The customer's chat is in the screenshot."}` }];
  if (input.image) parts.push({ inline_data: { mime_type: input.image.mime, data: input.image.base64 } });
  const raw = parseJson<any>(await gemini(shop, { system, parts, json: true, temperature: 0.2, maxTokens: 4096 }));
  const rating = Number(raw.rating);
  const body = String(raw.body || "").trim();
  if (!body) throw new AiError("No product feedback found in that message.");
  return {
    author: String(raw.author || "").trim().slice(0, 60),
    city: String(raw.city || "").trim().slice(0, 60),
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    body: body.slice(0, 4000),
    notes: (Array.isArray(raw.notes) ? raw.notes : []).map((n: any) => String(n).slice(0, 200)).slice(0, 6),
  };
}

/* ───────────────────────── 4 · test data (hidden, labelled "Test") ───────────────────────── */
export type TestComment = { name: string; store: boolean; text: string; replies: TestComment[] };
export type TestReview = { author: string; city: string; rating: number; body: string; daysAgo: number; comments: TestComment[] };

export async function generateTestReviews(
  shop: string,
  input: { productTitle: string; productText: string; count: number; mix: string; language: string; withComments: boolean },
): Promise<TestReview[]> {
  const count = Math.max(1, Math.min(30, Math.round(input.count)));
  const mix =
    input.mix === "positive" ? "mostly 5 and 4 stars, a few 3"
      : input.mix === "mixed" ? "a real mix: about half 4–5 stars, the rest 1–3 stars with clear complaints (size, delivery, quality)"
      : "realistic: about 60% 5 stars, 25% 4 stars, 10% 3 stars, 5% 1–2 stars";
  const lang =
    input.language === "english" ? "English" : input.language === "hinglish" ? "Hinglish (Hindi in English letters)" : "a mix of English and Hinglish";
  const system = [
    "You create TEST DATA for software testing of an e-commerce review widget. The entries are saved hidden and labelled TEST; they are never shown to shoppers.",
    "Make the entries varied so the widget's features get exercised: short and long texts (some over 300 characters), different star ratings, Indian names and cities, some with typos or emojis, different topics (fit, fabric, colour, delivery, packaging, price).",
    input.withComments
      ? "About half of the entries get a comment thread: shoppers asking questions (size, washing, delivery), the store answering (store: true), and sometimes a reply under a reply. Up to 3 comments per entry, replies nested at most 2 levels."
      : "No comments: every comments list is empty.",
    `Language: ${lang}. Star ratings: ${mix}. daysAgo: a whole number 1–120, spread out.`,
    'Answer as JSON: {"reviews":[{"author":string,"city":string,"rating":1-5,"body":string,"daysAgo":number,"comments":[{"name":string,"store":boolean,"text":string,"replies":[...same shape]}]}]}',
  ].join("\n");
  const raw = parseJson<any>(await gemini(shop, {
    system,
    parts: [{ text: `Product: ${input.productTitle}\n${input.productText ? `About the product: ${input.productText.slice(0, 1500)}\n` : ""}Create ${count} test entries.` }],
    json: true,
    temperature: 1,
    maxTokens: 24000,
  }));
  const clean = (c: any, depth: number): TestComment | null => {
    const text = String(c?.text || "").trim();
    if (!text) return null;
    return {
      name: String(c?.name || "Shopper").trim().slice(0, 60),
      store: !!c?.store,
      text: text.slice(0, 1000),
      replies: depth < 2 ? (Array.isArray(c?.replies) ? c.replies : []).map((x: any) => clean(x, depth + 1)).filter(Boolean).slice(0, 3) as TestComment[] : [],
    };
  };
  const list: TestReview[] = (Array.isArray(raw?.reviews) ? raw.reviews : [])
    .map((r: any) => ({
      author: String(r?.author || "").trim().slice(0, 60) || "Test shopper",
      city: String(r?.city || "").trim().slice(0, 60),
      rating: Math.max(1, Math.min(5, Math.round(Number(r?.rating) || 5))),
      body: String(r?.body || "").trim().slice(0, 3000),
      daysAgo: Math.max(1, Math.min(365, Math.round(Number(r?.daysAgo) || 7))),
      comments: input.withComments ? (Array.isArray(r?.comments) ? r.comments : []).map((c: any) => clean(c, 0)).filter(Boolean).slice(0, 3) : [],
    }))
    .filter((r: TestReview) => r.body)
    .slice(0, count);
  if (!list.length) throw new AiError("Gemini didn't return any test reviews. Try again.");
  return list;
}

/* ───────────────────────── 3 · what customers say (admin summary) ───────────────────────── */
export type ReviewInsights = {
  summary: string;
  likes: string[];
  complaints: string[];
  sizing: string;
  questions: string[];
  actions: string[];
};

export async function reviewInsights(
  shop: string,
  input: { productTitle: string; reviews: { rating: number; body: string; createdAt: Date; replies: string }[] },
): Promise<ReviewInsights> {
  if (!input.reviews.length) throw new AiError("This product has no published reviews yet.");
  const lines = input.reviews.slice(0, 300).map((r, i) => {
    let comments: ReviewComment[] = [];
    try { comments = JSON.parse(r.replies || "[]"); } catch { comments = []; }
    const asked = comments.filter((c) => c.type !== "store" && c.status !== "hidden").map((c) => c.text.replace(/\s+/g, " ").slice(0, 200));
    return `${i + 1}. ${r.rating}★ (${new Date(r.createdAt).toISOString().slice(0, 10)}): ${String(r.body || "").replace(/\s+/g, " ").slice(0, 500)}${asked.length ? `\n   Shopper comments: ${asked.join(" | ")}` : ""}`;
  });
  const system = [
    "You analyse a product's customer reviews for the store owner. Be concrete and honest; base every point only on the reviews given, and say how many reviews mention it when useful (e.g. '6 reviews').",
    "summary: 2–3 sentences. likes: what customers praise. complaints: problems they mention. sizing: what they say about size and fit (or 'Not mentioned'). questions: open questions shoppers ask in comments. actions: practical next steps for the store (product page, sizing, delivery, replies).",
    "Write in simple English. Each list at most 6 short points.",
    'Answer as JSON: {"summary": string, "likes": string[], "complaints": string[], "sizing": string, "questions": string[], "actions": string[]}',
  ].join("\n");
  const raw = parseJson<any>(await gemini(shop, {
    system,
    parts: [{ text: `Product: ${input.productTitle}\nPublished reviews (${input.reviews.length}):\n${lines.join("\n")}` }],
    json: true,
    temperature: 0.3,
    maxTokens: 6000,
  }));
  const list = (v: any) => (Array.isArray(v) ? v : []).map((x: any) => String(x).slice(0, 300)).slice(0, 8);
  return {
    summary: String(raw.summary || "").slice(0, 1200),
    likes: list(raw.likes),
    complaints: list(raw.complaints),
    sizing: String(raw.sizing || "").slice(0, 500),
    questions: list(raw.questions),
    actions: list(raw.actions),
  };
}
