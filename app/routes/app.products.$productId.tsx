/**
 * Product page editor (Elementor-style): widgets on the left, a phone preview in the middle (click a block to edit it),
 * the selected widget's settings on the right. Save writes the product's metafields / metaobjects the theme reads.
 */
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadProductWidgets, saveWidget } from "../lib/product-widgets.server";
import { AFTER_END, FIT_CHOICES, ICONS, ON_TAP, TIMER_MODES } from "../lib/product-widgets.shared";
import type { Offer, OfferCard, VideoItem } from "../lib/product-widgets.shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const data = await loadProductWidgets(admin, params.productId!);
  if (!data) throw new Response("Product not found", { status: 404 });
  return data;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const fd = await request.formData();
  try {
    const message = await saveWidget(admin, params.productId!, String(fd.get("widget") || ""), fd);
    return { ok: true, message, widget: String(fd.get("widget") || "") };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Could not save", widget: String(fd.get("widget") || "") };
  }
};

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type WidgetKey = "offer" | "specialOffers" | "badges" | "sizeGuide" | "videos" | "whatsapp" | "reviews";

const WIDGETS: { key: WidgetKey; label: string; icon: string; hint: string }[] = [
  { key: "offer", label: "Offer bar", icon: "⏱", hint: "Timer bar under the header" },
  { key: "badges", label: "Swatch badges", icon: "🏷", hint: "Tags on colours and sizes" },
  { key: "sizeGuide", label: "Size guide", icon: "📏", hint: "Size chart and fit" },
  { key: "whatsapp", label: "WhatsApp button", icon: "💬", hint: "Rotating questions" },
  { key: "specialOffers", label: "Special Offers", icon: "🎁", hint: "Offer cards under Buy Now" },
  { key: "videos", label: "Floating videos", icon: "🎬", hint: "Small video player" },
  { key: "reviews", label: "Reviews", icon: "★", hint: "Rating and reviews" },
];

const DEFAULT_WA = ["Which size fits me? Ask on WhatsApp", "Is Cash on Delivery available? Ask us", "When will it reach me? Ask on WhatsApp"];
const BADGE_SUGGESTIONS = ["Trending", "New", "Best seller", "Most bought", "Limited edition", "Popular"];
const STOCK_WORDS = /low stock|only \d+ left|\bleft\b|sold out|out of stock/i;

/* ───────────────────────── drafts (what the forms edit) ───────────────────────── */
type SlideDraft = Offer["slides"][number] & { file?: File | null; preview?: string };
type OfferDraft = Omit<Offer, "slides"> & { slides: SlideDraft[]; new?: boolean; removeBg?: boolean; bgFile?: File | null; bgPreview?: string };
type CardDraft = OfferCard & { new?: boolean; dirty?: boolean };
type Drafts = {
  offer: { mode: "default" | "offer"; offerId: string; edit: OfferDraft | null };
  specialOffers: { cards: CardDraft[] };
  badges: { rows: { value: string; badge: string }[] };
  sizeGuide: { chartId: string; chartUrl: string; removeChart: boolean; file: File | null; preview: string; fit: string };
  videos: { items: VideoItem[]; files: File[] };
  whatsapp: { rows: { q: string; msg: string }[] };
};

function initDrafts(d: Data): Drafts {
  return {
    offer: { mode: d.offerId ? "offer" : "default", offerId: d.offerId, edit: null },
    specialOffers: { cards: d.cardIds.map((id) => d.cards.find((c) => c.id === id)).filter(Boolean) as CardDraft[] },
    badges: {
      rows: d.badges.split(/\r?\n/).map((l) => l.split("=")).filter((p) => p.length >= 2 && p[0].trim())
        .map((p) => ({ value: p[0].trim(), badge: p.slice(1).join("=").trim() })),
    },
    sizeGuide: { chartId: d.sizeChart.id, chartUrl: d.sizeChart.url, removeChart: false, file: null, preview: "", fit: d.sizeFit },
    videos: { items: d.videos, files: [] },
    whatsapp: {
      rows: d.whatsapp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [q, ...m] = l.split("|");
        return { q: q.trim(), msg: m.join("|").trim() };
      }),
    },
  };
}

const move = <T,>(list: T[], i: number, d: number) => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const n = list.slice();
  [n[i], n[j]] = [n[j], n[i]];
  return n;
};

/* ───────────────────────── styles ───────────────────────── */
const CSS = `
.ed { display: grid; grid-template-columns: 220px minmax(320px, 380px) minmax(0, 1fr); gap: 16px; align-items: start;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #303030; }
@media (max-width: 1100px) { .ed { grid-template-columns: 200px minmax(0, 1fr); } .ed-prev-col { display: none; } }
@media (max-width: 760px) { .ed { grid-template-columns: 1fr; } }
.ed-card { background: #fff; border-radius: 12px; box-shadow: 0 1px 0 rgba(26,26,26,.07), inset 0 0 0 1px rgba(26,26,26,.06); }
.ed-list { padding: 8px; position: sticky; top: 12px; }
.ed-w { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 9px; background: none; cursor: pointer; text-align: left; font: inherit; color: inherit; }
.ed-w:hover { background: #f6f6f6; }
.ed-w.on { background: #f1f1f1; box-shadow: inset 3px 0 0 #303030; }
.ed-w-ic { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: #f3f3f3; font-size: 14px; flex-shrink: 0; }
.ed-w-name { font-size: 13px; font-weight: 600; color: #1f1f1f; }
.ed-w-sub { font-size: 11.5px; color: #8a8a8a; }
.ed-w-dot { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: #d9d9d9; flex-shrink: 0; }
.ed-w-dot.set { background: #29845a; }
.ed-w-dot.dirty { background: #e8a302; }
.ed-legend { display: flex; gap: 10px; padding: 8px 10px 4px; font-size: 11px; color: #8a8a8a; }
.ed-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; }

/* phone preview */
.ed-prev-col { position: sticky; top: 12px; }
.ph { width: 100%; max-width: 360px; margin: 0 auto; border-radius: 36px; background: #111; padding: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
.ph-screen { position: relative; border-radius: 28px; overflow: hidden; background: #fff; height: 640px; overflow-y: auto; scrollbar-width: none; }
.ph-screen::-webkit-scrollbar { display: none; }
.ph-hdr { height: 44px; background: #141414; color: #fff; display: flex; align-items: center; justify-content: center; font: 700 14px/1 Roboto, Arial, sans-serif; letter-spacing: .02em; }
.pv { position: relative; cursor: pointer; outline: 2px solid transparent; outline-offset: -2px; transition: outline-color .15s; }
.pv:hover { outline-color: rgba(0, 91, 211, .35); }
.pv.on { outline-color: #005bd3; }
.pv-tag { position: absolute; top: 0; right: 0; z-index: 3; background: #005bd3; color: #fff; font: 600 10px/1 -apple-system, sans-serif; padding: 4px 6px; border-bottom-left-radius: 6px; display: none; }
.pv.on .pv-tag, .pv:hover .pv-tag { display: block; }
.pv-off { opacity: .45; }
.pv-empty { margin: 8px 12px; padding: 10px; border: 1px dashed #cfcfcf; border-radius: 10px; text-align: center; font-size: 11.5px; color: #8a8a8a; }
.vo { height: 56px; color: #fff; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px; font-family: Roboto, Arial, sans-serif; }
.vo-t { font-weight: 800; font-size: 15px; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vo-s { font-size: 10px; opacity: .85; margin-top: 2px; }
.vo-tm { display: flex; gap: 3px; align-items: center; }
.vo-n { min-width: 28px; height: 28px; border-radius: 6px; background: #fff; color: #111; display: grid; place-items: center; font: 800 16px/1 Roboto, Arial, sans-serif; }
.vo-c { font-weight: 800; }
.pp-img { width: 100%; aspect-ratio: 4/5; object-fit: cover; display: block; background: #f3f3f3; }
.pp-info { padding: 10px 12px; background: #faf6f3; font-family: Roboto, Arial, sans-serif; display: flex; justify-content: space-between; gap: 8px; }
.pp-title { font-weight: 700; font-size: 14px; line-height: 1.25; }
.pp-price { font-weight: 800; font-size: 18px; white-space: nowrap; }
.pp-stars { font-size: 11px; color: #e0261b; text-align: right; }
.sw { padding: 10px 12px 4px; font-family: Roboto, Arial, sans-serif; }
.sw-l { font-size: 11px; font-weight: 700; margin: 6px 0; }
.sw-colors { display: flex; gap: 8px; flex-wrap: wrap; }
.sw-c { position: relative; width: 70px; border: 1.5px solid #e3e3e3; border-radius: 10px; padding: 4px; text-align: center; font-size: 10.5px; }
.sw-c img, .sw-c span.ph-x { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 7px; background: #eee; }
.sw-sizes { display: flex; gap: 6px; flex-wrap: wrap; }
.sw-s { position: relative; min-width: 38px; padding: 7px 8px; border: 1px solid #d9d9d9; border-radius: 8px; text-align: center; font-size: 11px; font-weight: 600; }
.sw-tag { position: absolute; top: -7px; left: 4px; background: #b3261e; color: #fff; font-size: 8.5px; font-weight: 700; padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
.sw-c .sw-tag { top: 6px; left: 6px; }
.sw-tag.new { background: #1a7f37; }
.sg { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; font: 12px Roboto, Arial, sans-serif; }
.sg a { color: #141414; text-decoration: underline; font-weight: 600; }
.bt { padding: 6px 12px 10px; display: grid; gap: 8px; font-family: Roboto, Arial, sans-serif; }
.bt-row { display: grid; grid-template-columns: 90px 1fr; gap: 8px; }
.bt-b { height: 40px; border-radius: 10px; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.bt-atc { border: 1.5px solid #141414; }
.bt-qty { border: 1px solid #d9d9d9; }
.bt-buy { background: #141414; color: #fff; }
.bt-wa { border: 1.5px solid #25d366; display: flex; align-items: center; justify-content: center; gap: 8px; overflow: hidden; }
.bt-wa b { width: 18px; height: 18px; border-radius: 50%; background: #25d366; flex-shrink: 0; }
.bt-wa span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; animation: waIn .4s ease; }
@keyframes waIn { from { transform: translateY(100%); opacity: 0; } to { transform: none; opacity: 1; } }
.so { margin: 6px 12px 10px; padding: 10px; border-radius: 12px; background: #faf6f3; font-family: Roboto, Arial, sans-serif; }
.so-h { font-size: 11px; font-weight: 700; margin-bottom: 6px; }
.so-c { position: relative; display: flex; align-items: center; gap: 8px; padding: 10px; border-radius: 10px; margin-bottom: 6px; background: #141414; color: #fff; }
.so-c.light { background: #fff; color: #141414; border: 1px solid #eadfd8; }
.so-lab { position: absolute; top: -7px; left: 10px; font-size: 8.5px; font-weight: 800; padding: 1px 6px; border-radius: 4px; background: #e0261b; color: #fff; }
.so-ic { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,.14); font-size: 13px; flex-shrink: 0; }
.so-c.light .so-ic { background: #f3ebe6; }
.so-t { font-size: 12px; font-weight: 700; }
.so-s { font-size: 10px; opacity: .75; }
.so-code { margin-left: auto; border: 1px dashed currentColor; border-radius: 6px; padding: 3px 6px; font-size: 10px; font-weight: 700; }
.rv { padding: 10px 12px 16px; font-family: Roboto, Arial, sans-serif; }
.rv-h { font-size: 13px; font-weight: 700; }
.rv-q { font-size: 11px; color: #555; margin-top: 6px; border-left: 2px solid #eee; padding-left: 8px; }
.fv { position: absolute; left: 10px; bottom: 12px; width: 74px; height: 120px; border-radius: 12px; overflow: hidden; border: 2px solid #fff; box-shadow: 0 6px 16px rgba(0,0,0,.25); background: #333; z-index: 4; cursor: pointer; }
.fv img, .fv video { width: 100%; height: 100%; object-fit: cover; display: block; }
.fv span { position: absolute; top: 4px; right: 4px; font-size: 9px; color: #fff; background: rgba(0,0,0,.5); padding: 1px 4px; border-radius: 4px; }
.fv.on { outline: 2px solid #005bd3; }

/* settings panel */
.st { padding: 16px; }
.st-h { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.st-h h2 { margin: 0; font-size: 16px; }
.st-p { margin: 0 0 14px; color: #6d6d6d; font-size: 12.5px; line-height: 1.45; }
.st-f { display: grid; gap: 4px; margin-bottom: 12px; }
.st-f > span { font-size: 12px; font-weight: 600; color: #303030; }
.st-f small { color: #8a8a8a; font-size: 11.5px; }
.st-in, .st-sel, .st-ta { width: 100%; box-sizing: border-box; border: 1px solid #c9cccf; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; background: #fff; color: #1f1f1f; }
.st-in:focus, .st-sel:focus, .st-ta:focus { outline: 2px solid #005bd3; outline-offset: -1px; border-color: transparent; }
.st-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.st-box { border: 1px solid #ebebeb; border-radius: 10px; padding: 12px; margin-bottom: 10px; background: #fcfcfc; }
.st-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.st-row .st-in { flex: 1; }
.st-ib { border: 1px solid #d4d4d4; background: #fff; border-radius: 7px; width: 30px; height: 30px; cursor: pointer; font-size: 13px; color: #4a4a4a; flex-shrink: 0; }
.st-ib:hover { background: #f5f5f5; }
.st-ib.x:hover { color: #b42318; border-color: #f0c2bd; background: #fdf2f2; }
.st-add { border: 1px dashed #b5b5b5; background: #fff; border-radius: 8px; padding: 8px 12px; cursor: pointer; font: inherit; font-size: 13px; color: #303030; width: 100%; }
.st-add:hover { background: #fafafa; }
.st-warn { font-size: 11.5px; color: #8c5a00; margin: -4px 0 8px 2px; }
.st-seg { display: inline-flex; border: 1px solid #c9cccf; border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
.st-seg button { border: 0; background: #fff; padding: 7px 12px; font: inherit; font-size: 12.5px; cursor: pointer; color: #303030; }
.st-seg button + button { border-left: 1px solid #c9cccf; }
.st-seg button.on { background: #303030; color: #fff; }
.st-img { width: 100%; max-height: 220px; object-fit: contain; border-radius: 8px; border: 1px solid #ebebeb; background: #fafafa; }
.st-vids { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; margin-bottom: 12px; }
.st-vid { border: 1px solid #ebebeb; border-radius: 10px; overflow: hidden; background: #fafafa; }
.st-vid img, .st-vid video { width: 100%; aspect-ratio: 9/16; object-fit: cover; display: block; background: #222; }
.st-vid div { display: flex; justify-content: space-between; padding: 4px; }
.st-foot { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid #f1f1f1; background: #fff; border-radius: 0 0 12px 12px; }
.st-note { font-size: 11.5px; color: #8a8a8a; margin-right: auto; }
`;

function money(a: string | number) {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(a)); } catch { return String(a); }
}
const ICON_CHAR: Record<string, string> = { Lightning: "⚡", Tag: "🏷", Percent: "%", Wallet: "👛", Gift: "🎁", Truck: "🚚", Bank: "🏦" };
const img = (u: string, w = 400) => (u ? `${u}${u.includes("?") ? "&" : "?"}width=${w}` : "");

/* ───────────────────────── preview (phone) ───────────────────────── */
function Preview({ d, drafts, sel, onSel }: { d: Data; drafts: Drafts; sel: WidgetKey; onSel: (k: WidgetKey) => void }) {
  const p = d.product;
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 2500); return () => clearInterval(t); }, []);

  const offer: Partial<OfferDraft> | null = (() => {
    const o = drafts.offer;
    if (o.edit) return o.edit;
    if (o.mode === "offer") return d.offers.find((x) => x.id === o.offerId) || null;
    return d.offers.find((x) => x.handle === "default-offer") || null;
  })();
  const colorOpt = p.options.find((o) => /colou?r/i.test(o.name));
  const sizeOpt = p.options.find((o) => /size/i.test(o.name));
  const badgeFor = (v: string) => drafts.badges.rows.find((r) => r.value.toLowerCase() === v.toLowerCase() && !STOCK_WORDS.test(r.badge))?.badge;
  const imgFor = (color: string) => p.variants.find((v: any) => colorOpt && v.options[colorOpt.name] === color && v.image)?.image || p.image;
  const v0 = p.variants[0] || { price: "0", compareAtPrice: null };
  const wa = drafts.whatsapp.rows.length ? drafts.whatsapp.rows.map((r) => r.q) : DEFAULT_WA;
  const waLines = ["Chat with us on WhatsApp", ...wa];
  const waNow = waLines[tick % waLines.length];
  const bg = offer?.background ? offer.background : "";
  const block = (k: WidgetKey, label: string, children: React.ReactNode, extra = "") => (
    <div className={`pv${sel === k ? " on" : ""} ${extra}`} onClick={() => onSel(k)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onSel(k); }}>
      <span className="pv-tag">{label}</span>
      {children}
    </div>
  );
  const firstVideo = drafts.videos.items[0];

  return (
    <div className="ph">
      <div className="ph-screen">
        <div className="ph-hdr">vesturewears</div>
        {block("offer", "Offer bar", offer && offer.enabled !== false ? (
          <div className="vo" style={{ background: bg ? bg : "linear-gradient(90deg,#5d1415,#5f1516 60%,#9e3329)" }}>
            <div style={{ minWidth: 0 }}>
              <div className="vo-t">{offer.title || "Limited Time Offer"}</div>
              <div className="vo-s">{offer.timerMode === "Fixed end date" ? (offer.endTime ? `Ends ${new Date(offer.endTime).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "Set an end date") : offer.timerMode === "No timer" ? "" : "Today only · ends at midnight"}</div>
            </div>
            {offer.timerMode !== "No timer" && (
              <div className="vo-tm"><span className="vo-n">07</span><span className="vo-c">:</span><span className="vo-n">41</span><span className="vo-c">:</span><span className="vo-n">{String(59 - (tick * 2.5 % 60 | 0)).padStart(2, "0")}</span></div>
            )}
          </div>
        ) : <div className="pv-empty">Offer bar hidden {offer ? "(turned off)" : "(no offer)"}</div>)}
        {p.images[0] ? <img className="pp-img" src={img(p.images[0], 600)} alt="" /> : <div className="pp-img" />}
        {block("reviews", "Title & rating", (
          <div className="pp-info">
            <div className="pp-title">{p.title}</div>
            <div>
              {d.reviews.count > 0 && <div className="pp-stars">★★★★★ {Number(d.reviews.avg).toFixed(1)} ({d.reviews.count})</div>}
              <div className="pp-price">{money(v0.price)}</div>
            </div>
          </div>
        ))}
        {block("badges", "Swatch badges", (
          <div className="sw">
            {colorOpt && (
              <>
                <div className="sw-l">{colorOpt.name.toUpperCase()}</div>
                <div className="sw-colors">
                  {colorOpt.values.map((c) => {
                    const b = badgeFor(c);
                    const u = imgFor(c);
                    return (
                      <div key={c} className="sw-c">
                        {b && <span className={`sw-tag${/new/i.test(b) ? " new" : ""}`}>{b}</span>}
                        {u ? <img src={img(u, 160)} alt="" /> : <span className="ph-x" />}
                        {c}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {sizeOpt && (
              <>
                <div className="sw-l">{sizeOpt.name.toUpperCase()}</div>
                <div className="sw-sizes">
                  {sizeOpt.values.map((s) => {
                    const b = badgeFor(s);
                    return <div key={s} className="sw-s">{b && <span className={`sw-tag${/new/i.test(b) ? " new" : ""}`}>{b}</span>}{s}</div>;
                  })}
                </div>
              </>
            )}
          </div>
        ))}
        {block("sizeGuide", "Size guide", (
          <div className="sg">
            <span>{drafts.sizeGuide.fit ? `Fit: ${drafts.sizeGuide.fit}` : ""}</span>
            <a>📏 Size Guide</a>
          </div>
        ))}
        {block("whatsapp", "WhatsApp button", (
          <div className="bt">
            <div className="bt-row"><div className="bt-b bt-qty">– 1 +</div><div className="bt-b bt-atc">Add to cart</div></div>
            <div className="bt-b bt-buy">BUY NOW</div>
            <div className="bt-b bt-wa"><b /><span key={waNow}>{waNow}</span></div>
          </div>
        ))}
        {block("specialOffers", "Special Offers", drafts.specialOffers.cards.length ? (
          <div className="so">
            <div className="so-h">Special Offers</div>
            {drafts.specialOffers.cards.map((c) => (
              <div key={c.id} className={`so-c${c.style === "Light" ? " light" : ""}`}>
                {c.label && <span className="so-lab">{c.label}</span>}
                <span className="so-ic">{ICON_CHAR[c.icon] || "🏷"}</span>
                <div style={{ minWidth: 0 }}><div className="so-t">{c.title || "Offer"}</div>{c.subtitle && <div className="so-s">{c.subtitle}</div>}</div>
                {c.code && <span className="so-code">{c.code}</span>}
              </div>
            ))}
          </div>
        ) : <div className="pv-empty">No Special Offers on this product (box hidden)</div>)}
        {block("reviews", "Reviews", (
          <div className="rv">
            <div className="rv-h">{d.reviews.count ? `★ ${Number(d.reviews.avg).toFixed(1)} · ${d.reviews.count} reviews` : "No reviews yet"}</div>
            {(d.reviews.top || []).map((r: any) => <div key={r.id} className="rv-q">“{String(r.body || "").slice(0, 90)}” — {r.author}</div>)}
          </div>
        ))}
        {firstVideo && (
          <div className={`fv${sel === "videos" ? " on" : ""}`} onClick={() => onSel("videos")} role="button" tabIndex={0}>
            {firstVideo.poster ? <img src={img(firstVideo.poster, 200)} alt="" /> : firstVideo.url ? <video src={firstVideo.url} muted /> : null}
            <span>1/{drafts.videos.items.length}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── settings forms ───────────────────────── */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="st-f"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function OfferForm({ d, v, set }: { d: Data; v: Drafts["offer"]; set: (v: Drafts["offer"]) => void }) {
  const def = d.offers.find((o) => o.handle === "default-offer");
  const current = v.mode === "offer" ? d.offers.find((o) => o.id === v.offerId) : def;
  const e = v.edit;
  const upd = (patch: Partial<OfferDraft>) => set({ ...v, edit: { ...(e as OfferDraft), ...patch } });
  const blank: OfferDraft = {
    id: "new", handle: "", title: "Limited Time Offer", enabled: true, timerMode: TIMER_MODES[0], endTime: "", afterEnd: AFTER_END[0],
    background: "", backgroundImage: "", backgroundImageId: "", rotate: 5, slides: [], new: true,
  };
  const users = v.mode === "default" ? "every product without its own offer" : "every product that picked this offer";
  return (
    <>
      <div className="st-seg" role="group">
        <button type="button" className={v.mode === "default" ? "on" : ""} onClick={() => set({ ...v, mode: "default", edit: null })}>Default offer</button>
        <button type="button" className={v.mode === "offer" ? "on" : ""} onClick={() => set({ ...v, mode: "offer", offerId: v.offerId || d.offers[0]?.id || "", edit: null })}>Own offer</button>
      </div>
      {v.mode === "default" && <p className="st-p">This product shows the theme’s default offer{def ? ` (“${def.title}”)` : ""}.</p>}
      {v.mode === "offer" && !e && (
        <Field label="Offer for this product">
          <select className="st-sel" value={v.offerId} onChange={(ev) => set({ ...v, offerId: ev.currentTarget.value })}>
            {d.offers.map((o) => <option key={o.id} value={o.id}>{o.title || o.handle}{o.handle === "default-offer" ? " (default)" : ""}</option>)}
          </select>
        </Field>
      )}
      {!e ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {current && <button type="button" className="st-add" onClick={() => set({ ...v, edit: { ...current, slides: current.slides.map((s) => ({ ...s })) } })}>✎ Edit “{current.title || current.handle}”</button>}
          <button type="button" className="st-add" onClick={() => set({ ...v, mode: "offer", edit: { ...blank } })}>+ New offer</button>
        </div>
      ) : (
        <>
          <p className="st-p">{e.new ? "New offer — used by this product after saving." : `Changes apply to ${users}.`}</p>
          <Field label="Title"><input className="st-in" value={e.title} maxLength={80} onChange={(ev) => upd({ title: ev.currentTarget.value })} /></Field>
          <div className="st-2">
            <Field label="Timer">
              <select className="st-sel" value={e.timerMode} onChange={(ev) => upd({ timerMode: ev.currentTarget.value })}>
                {TIMER_MODES.map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Show the bar">
              <select className="st-sel" value={e.enabled ? "on" : "off"} onChange={(ev) => upd({ enabled: ev.currentTarget.value === "on" })}>
                <option value="on">On</option><option value="off">Off</option>
              </select>
            </Field>
          </div>
          {e.timerMode === "Fixed end date" && (
            <div className="st-2">
              <Field label="Ends at"><input className="st-in" type="datetime-local" value={e.endTime ? new Date(new Date(e.endTime).getTime() + 5.5 * 3600e3).toISOString().slice(0, 16) : ""} onChange={(ev) => upd({ endTime: ev.currentTarget.value ? new Date(ev.currentTarget.value + ":00+05:30").toISOString() : "" })} /></Field>
              <Field label="When it ends">
                <select className="st-sel" value={e.afterEnd} onChange={(ev) => upd({ afterEnd: ev.currentTarget.value })}>
                  {AFTER_END.map((m) => <option key={m}>{m}</option>)}
                </select>
              </Field>
            </div>
          )}
          <div className="st-2">
            <Field label="Background colour" hint="Empty = the gift-box picture">
              <div className="st-row" style={{ marginBottom: 0 }}>
                <input type="color" value={e.background || "#8e1b1b"} onChange={(ev) => upd({ background: ev.currentTarget.value })} style={{ width: 40, height: 32, border: 0, background: "none" }} />
                <input className="st-in" value={e.background} placeholder="gift-box" onChange={(ev) => upd({ background: ev.currentTarget.value })} />
                {e.background && <button type="button" className="st-ib x" onClick={() => upd({ background: "" })}>✕</button>}
              </div>
            </Field>
            <Field label="Seconds per banner"><input className="st-in" type="number" min={2} max={20} value={e.rotate} onChange={(ev) => upd({ rotate: Number(ev.currentTarget.value) })} /></Field>
          </div>
          <Field label="Background picture (optional)">
            {(e.bgPreview || (e.backgroundImage && !e.removeBg)) && <img className="st-img" src={e.bgPreview || img(e.backgroundImage, 800)} alt="" />}
            <div className="st-row">
              <input type="file" accept="image/*" onChange={(ev) => { const f = ev.currentTarget.files?.[0] || null; upd({ bgFile: f, bgPreview: f ? URL.createObjectURL(f) : "", removeBg: false }); }} />
              {(e.backgroundImage || e.bgPreview) && !e.removeBg && <button type="button" className="st-ib x" onClick={() => upd({ removeBg: true, bgFile: null, bgPreview: "" })}>✕</button>}
            </div>
          </Field>
          <div className="st-f"><span>Banner slides (after the timer)</span></div>
          {e.slides.map((s, i) => (
            <div key={s.id + i} className="st-box">
              <div className="st-row">
                <input className="st-in" placeholder="Headline" value={s.headline} onChange={(ev) => { const sl = e.slides.slice(); sl[i] = { ...s, headline: ev.currentTarget.value }; upd({ slides: sl }); }} />
                <button type="button" className="st-ib" onClick={() => upd({ slides: move(e.slides, i, -1) })}>↑</button>
                <button type="button" className="st-ib" onClick={() => upd({ slides: move(e.slides, i, 1) })}>↓</button>
                <button type="button" className="st-ib x" onClick={() => upd({ slides: e.slides.filter((_, j) => j !== i) })}>✕</button>
              </div>
              <div className="st-row"><input className="st-in" placeholder="Small line" value={s.subheadline} onChange={(ev) => { const sl = e.slides.slice(); sl[i] = { ...s, subheadline: ev.currentTarget.value }; upd({ slides: sl }); }} /></div>
              <div className="st-2">
                <select className="st-sel" value={s.onTap} onChange={(ev) => { const sl = e.slides.slice(); sl[i] = { ...s, onTap: ev.currentTarget.value }; upd({ slides: sl }); }}>
                  {ON_TAP.map((m) => <option key={m}>{m}</option>)}
                </select>
                {s.onTap === "Open link" ? <input className="st-in" placeholder="https://…" value={s.link} onChange={(ev) => { const sl = e.slides.slice(); sl[i] = { ...s, link: ev.currentTarget.value }; upd({ slides: sl }); }} /> : <span />}
              </div>
              <div className="st-row" style={{ marginTop: 8 }}>
                {(s.preview || s.image) && <img src={s.preview || img(s.image, 300)} alt="" style={{ width: 90, borderRadius: 6 }} />}
                <input type="file" accept="image/*" onChange={(ev) => { const f = ev.currentTarget.files?.[0] || null; const sl = e.slides.slice(); sl[i] = { ...s, file: f, preview: f ? URL.createObjectURL(f) : "" }; upd({ slides: sl }); }} />
              </div>
            </div>
          ))}
          <button type="button" className="st-add" onClick={() => upd({ slides: [...e.slides, { id: `new${Date.now()}`, headline: "", subheadline: "", onTap: "Nothing", link: "", image: "", imageId: "" }] })}>+ Add a banner slide</button>
          <div style={{ marginTop: 10 }}><button type="button" className="st-add" onClick={() => set({ ...v, edit: null })}>Cancel editing</button></div>
        </>
      )}
    </>
  );
}

function CardsForm({ d, v, set }: { d: Data; v: Drafts["specialOffers"]; set: (v: Drafts["specialOffers"]) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const [pick, setPick] = useState("");
  const unused = d.cards.filter((c) => !v.cards.some((x) => x.id === c.id));
  const upd = (i: number, patch: Partial<CardDraft>) => { const c = v.cards.slice(); c[i] = { ...c[i], ...patch, dirty: true }; set({ cards: c }); };
  return (
    <>
      {v.cards.length === 0 && <p className="st-p">No cards: the Special Offers box is hidden on this product.</p>}
      {v.cards.map((c, i) => (
        <div key={c.id} className="st-box">
          <div className="st-row">
            <strong style={{ flex: 1, fontSize: 13 }}>{c.title || "New card"}{c.label ? ` · ${c.label}` : ""}</strong>
            <button type="button" className="st-ib" onClick={() => setOpen(open === i ? null : i)} title="Edit">✎</button>
            <button type="button" className="st-ib" onClick={() => set({ cards: move(v.cards, i, -1) })}>↑</button>
            <button type="button" className="st-ib" onClick={() => set({ cards: move(v.cards, i, 1) })}>↓</button>
            <button type="button" className="st-ib x" onClick={() => set({ cards: v.cards.filter((_, j) => j !== i) })} title="Remove from this product">✕</button>
          </div>
          {open === i && (
            <>
              {!c.new && <p className="st-p">This card is shared — edits show on every product that uses it.</p>}
              <Field label="Main line"><input className="st-in" value={c.title} maxLength={80} onChange={(e) => upd(i, { title: e.currentTarget.value })} /></Field>
              <div className="st-2">
                <Field label="Tag"><input className="st-in" value={c.label} maxLength={30} onChange={(e) => upd(i, { label: e.currentTarget.value })} /></Field>
                <Field label="Coupon code" hint="Must exist in Shopify Discounts"><input className="st-in" value={c.code} maxLength={40} onChange={(e) => upd(i, { code: e.currentTarget.value.toUpperCase() })} /></Field>
              </div>
              <Field label="Small line"><input className="st-in" value={c.subtitle} maxLength={100} onChange={(e) => upd(i, { subtitle: e.currentTarget.value })} /></Field>
              <div className="st-2">
                <Field label="Icon"><select className="st-sel" value={c.icon} onChange={(e) => upd(i, { icon: e.currentTarget.value })}>{ICONS.map((x) => <option key={x}>{x}</option>)}</select></Field>
                <Field label="Style"><select className="st-sel" value={c.style} onChange={(e) => upd(i, { style: e.currentTarget.value })}><option>Dark</option><option>Light</option></select></Field>
              </div>
            </>
          )}
        </div>
      ))}
      {unused.length > 0 && (
        <div className="st-row">
          <select className="st-sel" value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
            <option value="">Add an existing card…</option>
            {unused.map((c) => <option key={c.id} value={c.id}>{c.title}{c.label ? ` · ${c.label}` : ""}</option>)}
          </select>
          <button type="button" className="st-ib" disabled={!pick} onClick={() => { const c = d.cards.find((x) => x.id === pick); if (c) set({ cards: [...v.cards, c] }); setPick(""); }}>＋</button>
        </div>
      )}
      <button type="button" className="st-add" onClick={() => { set({ cards: [...v.cards, { id: `new${Date.now()}`, handle: "", title: "", label: "", subtitle: "", icon: "Tag", code: "", style: "Dark", new: true, dirty: true }] }); setOpen(v.cards.length); }}>+ New card</button>
    </>
  );
}

function BadgesForm({ d, v, set }: { d: Data; v: Drafts["badges"]; set: (v: Drafts["badges"]) => void }) {
  const values = d.product.options.flatMap((o) => o.values.map((x) => ({ opt: o.name, value: x })));
  return (
    <>
      <p className="st-p">A small tag on a colour or size. “Low stock / Only 2 left” is added automatically from inventory, so it isn’t typed here.</p>
      <datalist id="badge-words">{BADGE_SUGGESTIONS.map((b) => <option key={b} value={b} />)}</datalist>
      {v.rows.map((r, i) => (
        <div key={i}>
          <div className="st-row">
            <select className="st-sel" style={{ flex: 1 }} value={r.value} onChange={(e) => { const rows = v.rows.slice(); rows[i] = { ...r, value: e.currentTarget.value }; set({ rows }); }}>
              <option value="">Colour or size…</option>
              {values.map((x) => <option key={x.opt + x.value} value={x.value}>{x.opt}: {x.value}</option>)}
              {r.value && !values.some((x) => x.value === r.value) && <option value={r.value}>{r.value} (not on this product)</option>}
            </select>
            <input className="st-in" list="badge-words" placeholder="Badge" value={r.badge} maxLength={30} onChange={(e) => { const rows = v.rows.slice(); rows[i] = { ...r, badge: e.currentTarget.value }; set({ rows }); }} />
            <button type="button" className="st-ib x" onClick={() => set({ rows: v.rows.filter((_, j) => j !== i) })}>✕</button>
          </div>
          {STOCK_WORDS.test(r.badge) && <div className="st-warn">Stock words are ignored — low stock comes from real inventory.</div>}
        </div>
      ))}
      <button type="button" className="st-add" onClick={() => set({ rows: [...v.rows, { value: "", badge: "" }] })}>+ Add a badge</button>
    </>
  );
}

function SizeForm({ v, set }: { v: Drafts["sizeGuide"]; set: (v: Drafts["sizeGuide"]) => void }) {
  const shown = v.preview || (!v.removeChart && v.chartUrl);
  return (
    <>
      <Field label="How it fits" hint="The Size Guide recommender moves its suggestion up or down a size.">
        <select className="st-sel" value={v.fit} onChange={(e) => set({ ...v, fit: e.currentTarget.value })}>
          <option value="">Not set</option>
          {FIT_CHOICES.map((f) => <option key={f}>{f}</option>)}
        </select>
      </Field>
      <Field label="Size chart picture" hint="Shown inside the Size Guide popup.">
        {shown ? <img className="st-img" src={v.preview || img(v.chartUrl, 900)} alt="" /> : <div className="pv-empty" style={{ margin: 0 }}>No size chart</div>}
        <div className="st-row" style={{ marginTop: 8 }}>
          <input type="file" accept="image/*" onChange={(e) => { const f = e.currentTarget.files?.[0] || null; set({ ...v, file: f, preview: f ? URL.createObjectURL(f) : "", removeChart: false }); }} />
          {shown && <button type="button" className="st-ib x" onClick={() => set({ ...v, file: null, preview: "", removeChart: true })}>✕</button>}
        </div>
      </Field>
    </>
  );
}

function VideosForm({ v, set }: { v: Drafts["videos"]; set: (v: Drafts["videos"]) => void }) {
  return (
    <>
      <p className="st-p">4–5 short vertical videos (9:16, 5–15 s, under 20 MB). They play in a small card; tap opens them full screen.</p>
      <div className="st-vids">
        {v.items.map((it, i) => (
          <div key={it.id} className="st-vid">
            {it.poster ? <img src={img(it.poster, 240)} alt="" /> : <video src={it.url} muted />}
            <div>
              <button type="button" className="st-ib" onClick={() => set({ ...v, items: move(v.items, i, -1) })}>←</button>
              <button type="button" className="st-ib x" onClick={() => set({ ...v, items: v.items.filter((_, j) => j !== i) })}>✕</button>
              <button type="button" className="st-ib" onClick={() => set({ ...v, items: move(v.items, i, 1) })}>→</button>
            </div>
          </div>
        ))}
        {v.files.map((f, i) => (
          <div key={f.name + i} className="st-vid">
            <video src={URL.createObjectURL(f)} muted />
            <div><small style={{ fontSize: 10, color: "#8a8a8a" }}>new</small><button type="button" className="st-ib x" onClick={() => set({ ...v, files: v.files.filter((_, j) => j !== i) })}>✕</button></div>
          </div>
        ))}
      </div>
      <input type="file" accept="video/mp4,video/quicktime,video/webm" multiple onChange={(e) => { const fs = Array.from(e.currentTarget.files || []); set({ ...v, files: [...v.files, ...fs].slice(0, 8) }); e.currentTarget.value = ""; }} />
    </>
  );
}

function WhatsAppForm({ v, set }: { v: Drafts["whatsapp"]; set: (v: Drafts["whatsapp"]) => void }) {
  return (
    <>
      <p className="st-p">Lines that take turns on the WhatsApp button after “Chat with us on WhatsApp”. The message is what opens in WhatsApp (PRODUCT_NAME, VARIANT_INFO, PRODUCT_PRICE work). Empty = the theme’s default lines.</p>
      {v.rows.length === 0 && <div className="st-box" style={{ fontSize: 12, color: "#6d6d6d" }}>Default lines: {DEFAULT_WA.join(" · ")}</div>}
      {v.rows.map((r, i) => (
        <div key={i} className="st-box">
          <div className="st-row">
            <input className="st-in" placeholder="Which size fits me? Ask on WhatsApp" value={r.q} maxLength={90} onChange={(e) => { const rows = v.rows.slice(); rows[i] = { ...r, q: e.currentTarget.value }; set({ rows }); }} />
            <button type="button" className="st-ib" onClick={() => set({ rows: move(v.rows, i, -1) })}>↑</button>
            <button type="button" className="st-ib" onClick={() => set({ rows: move(v.rows, i, 1) })}>↓</button>
            <button type="button" className="st-ib x" onClick={() => set({ rows: v.rows.filter((_, j) => j !== i) })}>✕</button>
          </div>
          <input className="st-in" placeholder="Message (optional) — e.g. Hi, which size of PRODUCT_NAME should I take?" value={r.msg} maxLength={300} onChange={(e) => { const rows = v.rows.slice(); rows[i] = { ...r, msg: e.currentTarget.value }; set({ rows }); }} />
        </div>
      ))}
      <button type="button" className="st-add" onClick={() => set({ rows: [...v.rows, { q: "", msg: "" }] })}>+ Add a line</button>
    </>
  );
}

function ReviewsPanel({ d }: { d: Data }) {
  return (
    <>
      <p className="st-p">
        {d.reviews.count ? `★ ${Number(d.reviews.avg).toFixed(1)} from ${d.reviews.count} published reviews.` : "No published reviews yet."}
      </p>
      <s-stack direction="inline" gap="base">
        <s-button href={`/app/reviews/${d.product.id}`}>Manage reviews</s-button>
        <s-button href={`/app/reviews/${d.product.id}/new`}>Add a review</s-button>
        <s-button href="/app/settings" variant="tertiary">Banner settings</s-button>
      </s-stack>
    </>
  );
}

/* ───────────────────────── page ───────────────────────── */
export default function ProductEditor() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [sel, setSel] = useState<WidgetKey>("offer");
  const base = useMemo(() => initDrafts(d), [d]);
  const [drafts, setDrafts] = useState<Drafts>(base);
  const [dirty, setDirty] = useState<Partial<Record<WidgetKey, boolean>>>({});
  const pendingReset = useRef<WidgetKey | null>(null);
  const busy = fetcher.state !== "idle";

  // after a save, take the saved widget fresh from the server (other unsaved edits stay)
  useEffect(() => {
    const k = pendingReset.current;
    if (!k) return;
    pendingReset.current = null;
    setDrafts((cur) => ({ ...cur, [k]: (base as any)[k] }));
    setDirty((cur) => ({ ...cur, [k]: false }));
  }, [base]);

  useEffect(() => {
    const r: any = fetcher.data;
    if (!r?.message) return;
    shopify.toast.show(r.message, { isError: r.ok === false });
    if (r.ok) { pendingReset.current = r.widget; revalidator.revalidate(); }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const setW = <K extends keyof Drafts>(k: K) => (v: Drafts[K]) => { setDrafts((cur) => ({ ...cur, [k]: v })); setDirty((cur) => ({ ...cur, [k]: true })); };

  const save = () => {
    if (sel === "reviews") return;
    const fd = new FormData();
    fd.append("widget", sel);
    if (sel === "offer") {
      const o = drafts.offer;
      const edit = o.edit ? { ...o.edit, slides: o.edit.slides.map(({ file: _f, preview: _p, ...s }) => s), bgFile: undefined, bgPreview: undefined } : null;
      fd.append("data", JSON.stringify({ mode: o.mode, offerId: o.offerId, edit }));
      if (o.edit?.bgFile) fd.append("offerBackground", o.edit.bgFile);
      o.edit?.slides.forEach((s, i) => { if (s.file) fd.append(`slideImage_${i}`, s.file); });
    } else if (sel === "specialOffers") {
      fd.append("data", JSON.stringify({ cards: drafts.specialOffers.cards }));
    } else if (sel === "badges") {
      fd.append("data", JSON.stringify({ rows: drafts.badges.rows }));
    } else if (sel === "sizeGuide") {
      const s = drafts.sizeGuide;
      fd.append("data", JSON.stringify({ chartId: s.chartId, removeChart: s.removeChart, fit: s.fit }));
      if (s.file) fd.append("sizeChart", s.file);
    } else if (sel === "videos") {
      fd.append("data", JSON.stringify({ ids: drafts.videos.items.map((v) => v.id) }));
      drafts.videos.files.forEach((f) => fd.append("videos", f));
    } else if (sel === "whatsapp") {
      fd.append("data", JSON.stringify({ rows: drafts.whatsapp.rows }));
    }
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };
  const discard = () => { setDrafts((cur) => ({ ...cur, [sel]: (base as any)[sel] })); setDirty((cur) => ({ ...cur, [sel]: false })); };

  const isSet = (k: WidgetKey) =>
    k === "offer" ? !!d.offerId : k === "specialOffers" ? d.cardIds.length > 0 : k === "badges" ? !!d.badges : k === "sizeGuide" ? !!(d.sizeChart.id || d.sizeFit)
      : k === "videos" ? d.videos.length > 0 : k === "whatsapp" ? !!d.whatsapp : d.reviews.count > 0;
  const W = WIDGETS.find((w) => w.key === sel)!;
  const anyDirty = Object.values(dirty).some(Boolean);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (anyDirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  return (
    <s-page heading={d.product.title} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/products">Products</s-link>
      {d.product.url && <s-button slot="secondary-actions" href={d.product.url} target="_blank">View on store</s-button>}
      <s-button slot="secondary-actions" href={`shopify://admin/products/${d.product.id}`} target="_top">Edit in Shopify</s-button>
      <style>{CSS}</style>
      <div className="ed">
        <div className="ed-card ed-list">
          {WIDGETS.map((w) => (
            <button key={w.key} type="button" className={`ed-w${sel === w.key ? " on" : ""}`} onClick={() => setSel(w.key)}>
              <span className="ed-w-ic">{w.icon}</span>
              <span style={{ minWidth: 0 }}>
                <div className="ed-w-name">{w.label}</div>
                <div className="ed-w-sub">{w.hint}</div>
              </span>
              <span className={`ed-w-dot${dirty[w.key] ? " dirty" : isSet(w.key) ? " set" : ""}`} title={dirty[w.key] ? "Unsaved changes" : isSet(w.key) ? "Set on this product" : "Not set"} />
            </button>
          ))}
          <div className="ed-legend"><span><i style={{ background: "#29845a" }} />set</span><span><i style={{ background: "#e8a302" }} />unsaved</span><span><i style={{ background: "#d9d9d9" }} />empty</span></div>
        </div>

        <div className="ed-prev-col">
          <Preview d={d} drafts={drafts} sel={sel} onSel={setSel} />
        </div>

        <div className="ed-card">
          <div className="st">
            <div className="st-h"><h2>{W.icon} {W.label}</h2>{dirty[sel] && <s-badge tone="warning">Unsaved</s-badge>}</div>
            <p className="st-p">{W.hint}. Changes show in the preview straight away and on the store after Save.</p>
            {sel === "offer" && <OfferForm d={d} v={drafts.offer} set={setW("offer")} />}
            {sel === "specialOffers" && <CardsForm d={d} v={drafts.specialOffers} set={setW("specialOffers")} />}
            {sel === "badges" && <BadgesForm d={d} v={drafts.badges} set={setW("badges")} />}
            {sel === "sizeGuide" && <SizeForm v={drafts.sizeGuide} set={setW("sizeGuide")} />}
            {sel === "videos" && <VideosForm v={drafts.videos} set={setW("videos")} />}
            {sel === "whatsapp" && <WhatsAppForm v={drafts.whatsapp} set={setW("whatsapp")} />}
            {sel === "reviews" && <ReviewsPanel d={d} />}
          </div>
          {sel !== "reviews" && (
            <div className="st-foot">
              <span className="st-note">Saved to this product’s metafields</span>
              <s-button onClick={discard} {...(!dirty[sel] || busy ? { disabled: true } : {})}>Discard</s-button>
              <s-button variant="primary" onClick={save} {...(busy ? { loading: true } : !dirty[sel] ? { disabled: true } : {})}>Save</s-button>
            </div>
          )}
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
