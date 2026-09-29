/**
 * Product page editor — works like Shopify's theme editor:
 *   left    the page's widgets (click to edit)
 *   middle  the REAL product page (live preview served by the app); hover shows a widget, click selects it;
 *           text changes show instantly, the page reloads with the saved result after Save
 *   right   the selected widget's settings (Polaris)
 *   top     Shopify's own save bar (Save / Discard) whenever something changed
 */
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRevalidator } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadProductWidgets, saveWidget } from "../lib/product-widgets.server";
import { previewUrl } from "../lib/preview.server";
import { AFTER_END, FIT_CHOICES, ICONS, ON_TAP, TIMER_MODES } from "../lib/product-widgets.shared";
import type { Offer, OfferCard, VideoItem } from "../lib/product-widgets.shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const data = await loadProductWidgets(admin, params.productId!);
  if (!data) throw new Response("Product not found", { status: 404 });
  const live = data.product.status === "ACTIVE" && !!data.product.url && !!data.product.domain;
  return { ...data, previewSrc: live ? previewUrl(session.shop, data.product.domain, data.product.handle) : "" };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const fd = await request.formData();
  let widgets: string[] = [];
  try { widgets = JSON.parse(String(fd.get("widgets") || "[]")); } catch { widgets = []; }
  const saved: string[] = [];
  const errors: string[] = [];
  for (const w of widgets) {
    try { await saveWidget(admin, params.productId!, w, fd); saved.push(w); }
    catch (e: any) { errors.push(`${w}: ${e?.message || "could not save"}`); }
  }
  return {
    ok: errors.length === 0,
    saved,
    message: errors.length ? `Not saved — ${errors.join("; ")}` : saved.length > 1 ? `${saved.length} widgets saved` : "Saved",
    at: Date.now(),
  };
};

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type WidgetKey = "offer" | "specialOffers" | "badges" | "sizeGuide" | "videos" | "whatsapp" | "reviews";

const GROUPS: { title: string; items: { key: WidgetKey; label: string; icon: string; about: string }[] }[] = [
  { title: "Top of page", items: [{ key: "offer", label: "Offer bar", icon: "clock", about: "The timer bar under the header, with optional banner slides." }] },
  {
    title: "Product details",
    items: [
      { key: "badges", label: "Swatch badges", icon: "color", about: "Small tags on colours and sizes, like “Trending” or “New”." },
      { key: "sizeGuide", label: "Size guide", icon: "measurement-size", about: "The size chart picture and how this product fits." },
      { key: "whatsapp", label: "WhatsApp button", icon: "chat", about: "Lines that take turns on the WhatsApp button, each with its own message." },
      { key: "specialOffers", label: "Special Offers", icon: "gift-card", about: "Offer cards under the Buy buttons (coupon, prepaid, EMI…)." },
    ],
  },
  {
    title: "More",
    items: [
      { key: "videos", label: "Floating videos", icon: "video", about: "Short vertical videos in a small floating player." },
      { key: "reviews", label: "Reviews", icon: "star", about: "Rating, reviews and the reviews banner." },
    ],
  },
];
const ALL = GROUPS.flatMap((g) => g.items);
const SAVABLE: WidgetKey[] = ["offer", "specialOffers", "badges", "sizeGuide", "videos", "whatsapp"];

const DEFAULT_WA = ["Which size fits me? Ask on WhatsApp", "Is Cash on Delivery available? Ask us", "When will it reach me? Ask on WhatsApp"];
const BADGE_SUGGESTIONS = ["Trending", "New", "Best seller", "Most bought", "Limited edition"];
const STOCK_WORDS = /low stock|only \d+ left|\bleft\b|sold out|out of stock/i;

/* ───────────────────────── drafts ───────────────────────── */
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

const move = <T,>(list: T[], i: number, dir: number) => {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const n = list.slice();
  [n[i], n[j]] = [n[j], n[i]];
  return n;
};
const img = (u: string, w = 400) => (u ? `${u}${u.includes("?") ? "&" : "?"}width=${w}` : "");
const istDate = (iso: string) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString() : "");

/* ───────────────────────── styles (Shopify editor look) ───────────────────────── */
const CSS = `
.te { --bar: 52px; position: fixed; inset: 0; display: grid; grid-template-rows: var(--bar) 1fr; background: #f1f1f1;
  font-family: -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif; color: #303030; font-size: 13px; }
.te-top { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; padding: 0 12px; background: #fff; border-bottom: 1px solid #e3e3e3; }
.te-top-l { display: flex; align-items: center; gap: 10px; min-width: 0; }
.te-top-l img { width: 30px; height: 30px; border-radius: 6px; object-fit: cover; border: 1px solid #e3e3e3; }
.te-name { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.te-top-r { display: flex; justify-content: flex-end; gap: 6px; }
.te-dev { display: inline-flex; background: #f1f1f1; border-radius: 10px; padding: 3px; gap: 2px; }
.te-dev button { border: 0; background: none; border-radius: 8px; padding: 5px 12px; font: inherit; font-weight: 550; color: #616161; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.te-dev button.on { background: #fff; color: #303030; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.te-body { display: grid; grid-template-columns: 272px minmax(0, 1fr) 340px; min-height: 0; }
.te-side { background: #fff; overflow-y: auto; min-height: 0; }
.te-left { border-right: 1px solid #e3e3e3; padding: 8px 8px 24px; }
.te-right { border-left: 1px solid #e3e3e3; display: flex; flex-direction: column; }
.te-g { padding: 10px 8px 4px; font-size: 12px; font-weight: 650; color: #616161; }
.te-i { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: none; font: inherit; color: #303030; cursor: pointer; text-align: left; }
.te-i:hover { background: #f7f7f7; }
.te-i.on { background: #ebebeb; font-weight: 600; }
.te-i.missing { color: #8a8a8a; }
.te-i-meta { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #8a8a8a; }
.te-dot { width: 7px; height: 7px; border-radius: 50%; background: #c9c9c9; }
.te-dot.set { background: #29845a; }
.te-dot.dirty { background: #e8a302; }
.te-canvas { position: relative; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 16px; }
.te-frame { position: relative; height: 100%; width: 100%; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.08); transition: width .25s ease; }
.te-frame.mobile { width: 390px; max-width: 100%; }
.te-frame iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
.te-loading { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(255,255,255,.85); z-index: 2; }
.te-loading div { display: grid; justify-items: center; gap: 10px; color: #616161; }
.te-nolive { display: grid; place-items: center; height: 100%; text-align: center; padding: 24px; color: #616161; }
.te-head { padding: 14px 16px 10px; border-bottom: 1px solid #ebebeb; }
.te-head h2 { margin: 0; font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.te-head p { margin: 4px 0 0; color: #616161; font-size: 12.5px; line-height: 1.4; }
.te-form { padding: 14px 16px 28px; overflow-y: auto; min-height: 0; flex: 1; }
.te-sec { padding: 12px 0; border-bottom: 1px solid #f1f1f1; }
.te-sec:last-child { border-bottom: 0; }
.te-sec-t { font-size: 12px; font-weight: 650; color: #303030; margin-bottom: 8px; text-transform: none; }
.te-row { display: flex; gap: 6px; align-items: flex-end; }
.te-row > :first-child { flex: 1; min-width: 0; }
.te-item { border: 1px solid #e3e3e3; border-radius: 10px; margin-bottom: 8px; background: #fff; }
.te-item-h { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 10px; }
.te-item-h strong { flex: 1; font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.te-item-b { padding: 4px 10px 10px; border-top: 1px solid #f1f1f1; }
.te-thumb { width: 100%; max-height: 200px; object-fit: contain; border-radius: 8px; background: #fafafa; border: 1px solid #ebebeb; display: block; margin-bottom: 8px; }
.te-vids { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }
.te-vid { border: 1px solid #e3e3e3; border-radius: 8px; overflow: hidden; }
.te-vid img, .te-vid video { width: 100%; aspect-ratio: 9/16; object-fit: cover; display: block; background: #222; }
.te-vid div { display: flex; justify-content: center; gap: 2px; padding: 2px; }
.te-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.te-warn { color: #8c5a00; font-size: 12px; margin-top: 4px; }
.te-note { color: #616161; font-size: 12px; line-height: 1.45; }
@media (max-width: 1100px) { .te-body { grid-template-columns: 220px minmax(0, 1fr) 300px; } }
`;

function Sec({ title, children }: { title?: string; children: React.ReactNode }) {
  return <div className="te-sec">{title && <div className="te-sec-t">{title}</div>}<s-stack gap="base">{children}</s-stack></div>;
}

/* ───────────────────────── settings forms ───────────────────────── */
function OfferForm({ d, v, set }: { d: Data; v: Drafts["offer"]; set: (v: Drafts["offer"]) => void }) {
  const def = d.offers.find((o) => o.handle === "default-offer");
  const current = v.mode === "offer" ? d.offers.find((o) => o.id === v.offerId) : def;
  const e = v.edit;
  const upd = (patch: Partial<OfferDraft>) => set({ ...v, edit: { ...(e as OfferDraft), ...patch } });
  const blank: OfferDraft = {
    id: "new", handle: "", title: "Limited Time Offer", enabled: true, timerMode: TIMER_MODES[0], endTime: "", afterEnd: AFTER_END[0],
    background: "", backgroundImage: "", backgroundImageId: "", rotate: 5, slides: [], new: true,
  };
  const endIst = istDate(e?.endTime || "");
  const setEnd = (date: string, time: string) => upd({ endTime: date ? new Date(`${date}T${time || "23:59"}:00+05:30`).toISOString() : "" });
  const slide = (i: number, patch: Partial<SlideDraft>) => { const sl = (e as OfferDraft).slides.slice(); sl[i] = { ...sl[i], ...patch }; upd({ slides: sl }); };

  return (
    <>
      <Sec>
        <s-choice-list label="Offer shown on this product" values={[v.mode]} onChange={(ev: any) => set({ ...v, mode: ev.currentTarget.values?.[0] === "offer" ? "offer" : "default", offerId: v.offerId || d.offers[0]?.id || "", edit: null })}>
          <s-choice value="default">Store default{def ? ` — ${def.title}` : ""}</s-choice>
          <s-choice value="offer">A different offer</s-choice>
        </s-choice-list>
        {v.mode === "offer" && !e && (
          <s-select label="Offer" value={v.offerId} onChange={(ev: any) => set({ ...v, offerId: ev.currentTarget.value })}>
            {d.offers.map((o) => <s-option key={o.id} value={o.id}>{o.title || o.handle}{o.handle === "default-offer" ? " (default)" : ""}</s-option>)}
          </s-select>
        )}
        {!e && (
          <s-stack direction="inline" gap="small-200">
            {current && <s-button icon="edit" onClick={() => set({ ...v, edit: { ...current, slides: current.slides.map((s) => ({ ...s })) } })}>Edit offer</s-button>}
            <s-button icon="plus" variant="tertiary" onClick={() => set({ ...v, mode: "offer", edit: { ...blank } })}>New offer</s-button>
          </s-stack>
        )}
      </Sec>
      {e && (
        <>
          <Sec title={e.new ? "New offer" : "Offer settings"}>
            {!e.new && <s-banner tone="info">Shared: this offer shows on {v.mode === "default" ? "every product without its own offer" : "every product that uses it"}.</s-banner>}
            <s-text-field label="Title" value={e.title} maxLength={80} onInput={(ev: any) => upd({ title: ev.currentTarget.value })} />
            <s-switch label="Show the offer bar" checked={e.enabled} onChange={(ev: any) => upd({ enabled: !!ev.currentTarget.checked })} />
          </Sec>
          <Sec title="Timer">
            <s-select label="Timer" labelAccessibilityVisibility="exclusive" value={e.timerMode} onChange={(ev: any) => upd({ timerMode: ev.currentTarget.value })}>
              {TIMER_MODES.map((m) => <s-option key={m} value={m}>{m}</s-option>)}
            </s-select>
            {e.timerMode === "Fixed end date" && (
              <>
                <s-grid gridTemplateColumns="1fr 110px" gap="small-200">
                  <s-date-field label="Ends on" value={endIst.slice(0, 10)} onChange={(ev: any) => setEnd(ev.currentTarget.value, endIst.slice(11, 16))} />
                  <s-text-field label="Time (IST)" value={endIst.slice(11, 16) || "23:59"} placeholder="23:59" onChange={(ev: any) => setEnd(endIst.slice(0, 10), ev.currentTarget.value)} />
                </s-grid>
                <s-select label="When it ends" value={e.afterEnd} onChange={(ev: any) => upd({ afterEnd: ev.currentTarget.value })}>
                  {AFTER_END.map((m) => <s-option key={m} value={m}>{m}</s-option>)}
                </s-select>
              </>
            )}
          </Sec>
          <Sec title="Look">
            <s-stack direction="inline" gap="small-200" alignItems="end">
              <s-color-field label="Background colour" value={e.background || ""} placeholder="Gift-box picture" onChange={(ev: any) => upd({ background: ev.currentTarget.value || "" })} />
              {e.background && <s-button variant="tertiary" onClick={() => upd({ background: "" })}>Use picture</s-button>}
            </s-stack>
            {(e.bgPreview || (e.backgroundImage && !e.removeBg)) && <img className="te-thumb" src={e.bgPreview || img(e.backgroundImage, 800)} alt="" />}
            <s-drop-zone label="Background picture (optional)" accept="image/*" onChange={(ev: any) => { const f = ev.currentTarget.files?.[0] || null; upd({ bgFile: f, bgPreview: f ? URL.createObjectURL(f) : "", removeBg: false }); }} />
            {(e.backgroundImage || e.bgPreview) && !e.removeBg && <s-button variant="tertiary" tone="critical" onClick={() => upd({ removeBg: true, bgFile: null, bgPreview: "" })}>Remove picture</s-button>}
          </Sec>
          <Sec title="Banner slides">
            <s-number-field label="Seconds per slide" value={String(e.rotate)} min={2} max={20} step={1} onInput={(ev: any) => upd({ rotate: Number(ev.currentTarget.value) || 5 })} />
            {e.slides.map((s, i) => (
              <div key={s.id + i} className="te-item">
                <div className="te-item-h">
                  <strong>{s.headline || `Slide ${i + 1}`}</strong>
                  <s-button variant="tertiary" icon="arrow-up" accessibilityLabel="Move up" onClick={() => upd({ slides: move(e.slides, i, -1) })} />
                  <s-button variant="tertiary" icon="arrow-down" accessibilityLabel="Move down" onClick={() => upd({ slides: move(e.slides, i, 1) })} />
                  <s-button variant="tertiary" icon="delete" tone="critical" accessibilityLabel="Remove" onClick={() => upd({ slides: e.slides.filter((_, j) => j !== i) })} />
                </div>
                <div className="te-item-b">
                  <s-stack gap="small-200">
                    <s-text-field label="Headline" value={s.headline} onInput={(ev: any) => slide(i, { headline: ev.currentTarget.value })} />
                    <s-text-field label="Small line" value={s.subheadline} onInput={(ev: any) => slide(i, { subheadline: ev.currentTarget.value })} />
                    <s-select label="On tap" value={s.onTap} onChange={(ev: any) => slide(i, { onTap: ev.currentTarget.value })}>
                      {ON_TAP.map((m) => <s-option key={m} value={m}>{m}</s-option>)}
                    </s-select>
                    {s.onTap === "Open link" && <s-url-field label="Link" value={s.link} onInput={(ev: any) => slide(i, { link: ev.currentTarget.value })} />}
                    {(s.preview || s.image) && <img className="te-thumb" src={s.preview || img(s.image, 600)} alt="" />}
                    <s-drop-zone label="Picture" accept="image/*" onChange={(ev: any) => { const f = ev.currentTarget.files?.[0] || null; slide(i, { file: f, preview: f ? URL.createObjectURL(f) : "" }); }} />
                  </s-stack>
                </div>
              </div>
            ))}
            <s-button icon="plus" onClick={() => upd({ slides: [...e.slides, { id: `new${Date.now()}`, headline: "", subheadline: "", onTap: "Nothing", link: "", image: "", imageId: "" }] })}>Add slide</s-button>
          </Sec>
          <Sec><s-button variant="tertiary" onClick={() => set({ ...v, edit: null })}>Stop editing this offer</s-button></Sec>
        </>
      )}
    </>
  );
}

function CardsForm({ d, v, set, present }: { d: Data; v: Drafts["specialOffers"]; set: (v: Drafts["specialOffers"]) => void; present: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const unused = d.cards.filter((c) => !v.cards.some((x) => x.id === c.id));
  const upd = (i: number, patch: Partial<CardDraft>) => { const c = v.cards.slice(); c[i] = { ...c[i], ...patch, dirty: true }; set({ cards: c }); };
  return (
    <>
      {!present && <Sec><s-banner tone="warning">The Special Offers section is turned off in your theme, so the cards don’t show on the store yet. Turn it on in Online Store → Customize.</s-banner></Sec>}
      <Sec title="Cards on this product">
        {v.cards.length === 0 && <span className="te-note">No cards — the Special Offers box is hidden on this product.</span>}
        {v.cards.map((c, i) => (
          <div key={c.id} className="te-item">
            <div className="te-item-h">
              <strong onClick={() => setOpen(open === c.id ? null : c.id)}>{c.title || "New card"}{c.label ? ` · ${c.label}` : ""}</strong>
              <s-button variant="tertiary" icon="edit" accessibilityLabel="Edit" onClick={() => setOpen(open === c.id ? null : c.id)} />
              <s-button variant="tertiary" icon="arrow-up" accessibilityLabel="Move up" onClick={() => set({ cards: move(v.cards, i, -1) })} />
              <s-button variant="tertiary" icon="delete" tone="critical" accessibilityLabel="Remove from this product" onClick={() => set({ cards: v.cards.filter((_, j) => j !== i) })} />
            </div>
            {open === c.id && (
              <div className="te-item-b">
                <s-stack gap="small-200">
                  {!c.new && <span className="te-note">Shared card — edits show on every product that uses it.</span>}
                  <s-text-field label="Main line" value={c.title} maxLength={80} onInput={(ev: any) => upd(i, { title: ev.currentTarget.value })} />
                  <s-text-field label="Small line" value={c.subtitle} maxLength={100} onInput={(ev: any) => upd(i, { subtitle: ev.currentTarget.value })} />
                  <s-grid gridTemplateColumns="1fr 1fr" gap="small-200">
                    <s-text-field label="Tag" value={c.label} maxLength={30} onInput={(ev: any) => upd(i, { label: ev.currentTarget.value })} />
                    <s-text-field label="Coupon code" value={c.code} maxLength={40} details="Must exist in Discounts" onInput={(ev: any) => upd(i, { code: String(ev.currentTarget.value).toUpperCase() })} />
                  </s-grid>
                  <s-grid gridTemplateColumns="1fr 1fr" gap="small-200">
                    <s-select label="Icon" value={c.icon} onChange={(ev: any) => upd(i, { icon: ev.currentTarget.value })}>{ICONS.map((x) => <s-option key={x} value={x}>{x}</s-option>)}</s-select>
                    <s-select label="Style" value={c.style} onChange={(ev: any) => upd(i, { style: ev.currentTarget.value })}><s-option value="Dark">Dark</s-option><s-option value="Light">Light</s-option></s-select>
                  </s-grid>
                </s-stack>
              </div>
            )}
          </div>
        ))}
      </Sec>
      <Sec title="Add">
        {unused.length > 0 && (
          <div className="te-row">
            <s-select label="Existing card" value={pick} onChange={(ev: any) => setPick(ev.currentTarget.value)}>
              <s-option value="">Choose a card…</s-option>
              {unused.map((c) => <s-option key={c.id} value={c.id}>{c.title}{c.label ? ` · ${c.label}` : ""}</s-option>)}
            </s-select>
            <s-button {...(!pick ? { disabled: true } : {})} onClick={() => { const c = d.cards.find((x) => x.id === pick); if (c) set({ cards: [...v.cards, c] }); setPick(""); }}>Add</s-button>
          </div>
        )}
        <s-button icon="plus" onClick={() => { const id = `new${Date.now()}`; set({ cards: [...v.cards, { id, handle: "", title: "", label: "", subtitle: "", icon: "Tag", code: "", style: "Dark", new: true, dirty: true }] }); setOpen(id); }}>Create a new card</s-button>
      </Sec>
    </>
  );
}

function BadgesForm({ d, v, set }: { d: Data; v: Drafts["badges"]; set: (v: Drafts["badges"]) => void }) {
  const values = d.product.options.flatMap((o) => o.values.map((x) => ({ opt: o.name, value: x })));
  const row = (i: number, patch: Partial<{ value: string; badge: string }>) => { const rows = v.rows.slice(); rows[i] = { ...rows[i], ...patch }; set({ rows }); };
  return (
    <>
      <Sec>
        <span className="te-note">“Low stock / Only 2 left” comes from real inventory automatically — it isn’t typed here.</span>
      </Sec>
      <Sec title="Badges">
        {v.rows.map((r, i) => (
          <div key={i} className="te-item">
            <div className="te-item-b" style={{ borderTop: 0, paddingTop: 10 }}>
              <s-stack gap="small-200">
                <div className="te-row">
                  <s-select label="Colour or size" value={r.value} onChange={(ev: any) => row(i, { value: ev.currentTarget.value })}>
                    <s-option value="">Choose…</s-option>
                    {values.map((x) => <s-option key={x.opt + x.value} value={x.value}>{x.opt}: {x.value}</s-option>)}
                    {r.value && !values.some((x) => x.value === r.value) && <s-option value={r.value}>{r.value} (not on this product)</s-option>}
                  </s-select>
                  <s-button variant="tertiary" icon="delete" tone="critical" accessibilityLabel="Remove" onClick={() => set({ rows: v.rows.filter((_, j) => j !== i) })} />
                </div>
                <s-text-field label="Badge" value={r.badge} maxLength={30} onInput={(ev: any) => row(i, { badge: ev.currentTarget.value })} />
                <div className="te-chips">
                  {BADGE_SUGGESTIONS.map((b) => <s-clickable-chip key={b} onClick={() => row(i, { badge: b })}>{b}</s-clickable-chip>)}
                </div>
                {STOCK_WORDS.test(r.badge) && <div className="te-warn">Ignored on the store — stock badges come from inventory.</div>}
              </s-stack>
            </div>
          </div>
        ))}
        <s-button icon="plus" onClick={() => set({ rows: [...v.rows, { value: "", badge: "" }] })}>Add badge</s-button>
      </Sec>
    </>
  );
}

function SizeForm({ v, set }: { v: Drafts["sizeGuide"]; set: (v: Drafts["sizeGuide"]) => void }) {
  const shown = v.preview || (!v.removeChart && v.chartUrl);
  return (
    <>
      <Sec title="Fit">
        <s-select label="How this product fits" value={v.fit} details="The size recommender moves its suggestion up or down a size." onChange={(ev: any) => set({ ...v, fit: ev.currentTarget.value })}>
          <s-option value="">Not set</s-option>
          {FIT_CHOICES.map((f) => <s-option key={f} value={f}>{f}</s-option>)}
        </s-select>
      </Sec>
      <Sec title="Size chart">
        {shown ? <img className="te-thumb" src={v.preview || img(v.chartUrl, 900)} alt="Size chart" /> : <span className="te-note">No size chart picture.</span>}
        <s-drop-zone label={shown ? "Replace picture" : "Upload a size chart"} accept="image/*" onChange={(ev: any) => { const f = ev.currentTarget.files?.[0] || null; set({ ...v, file: f, preview: f ? URL.createObjectURL(f) : "", removeChart: false }); }} />
        {shown && <s-button variant="tertiary" tone="critical" onClick={() => set({ ...v, file: null, preview: "", removeChart: true })}>Remove picture</s-button>}
      </Sec>
    </>
  );
}

function VideosForm({ v, set }: { v: Drafts["videos"]; set: (v: Drafts["videos"]) => void }) {
  const newUrls = useMemo(() => v.files.map((f) => URL.createObjectURL(f)), [v.files]);
  return (
    <>
      <Sec><span className="te-note">4–5 vertical videos (9:16, 5–15 seconds, under 20 MB). The first one plays in the small card.</span></Sec>
      <Sec title={`Videos (${v.items.length + v.files.length})`}>
        {(v.items.length > 0 || v.files.length > 0) && (
          <div className="te-vids">
            {v.items.map((it, i) => (
              <div key={it.id} className="te-vid">
                {it.poster ? <img src={img(it.poster, 240)} alt="" /> : <video src={it.url} muted />}
                <div>
                  <s-button variant="tertiary" icon="arrow-up" accessibilityLabel="Earlier" onClick={() => set({ ...v, items: move(v.items, i, -1) })} />
                  <s-button variant="tertiary" icon="delete" tone="critical" accessibilityLabel="Remove" onClick={() => set({ ...v, items: v.items.filter((_, j) => j !== i) })} />
                </div>
              </div>
            ))}
            {v.files.map((f, i) => (
              <div key={f.name + i} className="te-vid">
                <video src={newUrls[i]} muted />
                <div><s-badge>New</s-badge><s-button variant="tertiary" icon="delete" tone="critical" accessibilityLabel="Remove" onClick={() => set({ ...v, files: v.files.filter((_, j) => j !== i) })} /></div>
              </div>
            ))}
          </div>
        )}
        <s-drop-zone label="Add videos" accept="video/*" multiple onChange={(ev: any) => { const fs = Array.from((ev.currentTarget.files || []) as File[]); set({ ...v, files: [...v.files, ...fs].slice(0, 8) }); }} />
      </Sec>
    </>
  );
}

function WhatsAppForm({ v, set }: { v: Drafts["whatsapp"]; set: (v: Drafts["whatsapp"]) => void }) {
  const row = (i: number, patch: Partial<{ q: string; msg: string }>) => { const rows = v.rows.slice(); rows[i] = { ...rows[i], ...patch }; set({ rows }); };
  return (
    <>
      <Sec>
        <span className="te-note">Each line takes a turn after “Chat with us on WhatsApp”. The message opens in WhatsApp (PRODUCT_NAME, VARIANT_INFO and PRODUCT_PRICE get filled in).</span>
        {v.rows.length === 0 && <s-banner>Using the store’s default lines: {DEFAULT_WA.join(" · ")}</s-banner>}
      </Sec>
      <Sec title="Lines">
        {v.rows.map((r, i) => (
          <div key={i} className="te-item">
            <div className="te-item-h">
              <strong>{r.q || `Line ${i + 1}`}</strong>
              <s-button variant="tertiary" icon="arrow-up" accessibilityLabel="Move up" onClick={() => set({ rows: move(v.rows, i, -1) })} />
              <s-button variant="tertiary" icon="arrow-down" accessibilityLabel="Move down" onClick={() => set({ rows: move(v.rows, i, 1) })} />
              <s-button variant="tertiary" icon="delete" tone="critical" accessibilityLabel="Remove" onClick={() => set({ rows: v.rows.filter((_, j) => j !== i) })} />
            </div>
            <div className="te-item-b">
              <s-stack gap="small-200">
                <s-text-field label="Line on the button" value={r.q} maxLength={90} placeholder="Which size fits me? Ask on WhatsApp" onInput={(ev: any) => row(i, { q: ev.currentTarget.value })} />
                <s-text-area label="Message (optional)" rows={2} value={r.msg} maxLength={300} placeholder="Hi, which size of PRODUCT_NAME should I take?" onInput={(ev: any) => row(i, { msg: ev.currentTarget.value })} />
              </s-stack>
            </div>
          </div>
        ))}
        <s-button icon="plus" onClick={() => set({ rows: [...v.rows, { q: "", msg: "" }] })}>Add line</s-button>
      </Sec>
    </>
  );
}

function ReviewsPanel({ d }: { d: Data }) {
  return (
    <Sec>
      <s-text>{d.reviews.count ? `★ ${Number(d.reviews.avg).toFixed(1)} from ${d.reviews.count} published reviews.` : "No published reviews yet."}</s-text>
      <s-stack direction="inline" gap="small-200">
        <s-button href={`/app/reviews/${d.product.id}`}>Manage reviews</s-button>
        <s-button href={`/app/reviews/${d.product.id}/new`} variant="tertiary">Add a review</s-button>
      </s-stack>
      <s-button href="/app/settings" variant="tertiary">Reviews banner settings</s-button>
    </Sec>
  );
}

/* ───────────────────────── page ───────────────────────── */
export default function ProductEditor() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [sel, setSel] = useState<WidgetKey>("offer");
  const base = useMemo(() => initDrafts(d), [d]);
  const [drafts, setDrafts] = useState<Drafts>(base);
  const [dirty, setDirty] = useState<Partial<Record<WidgetKey, boolean>>>({});
  const [mobile, setMobile] = useState(true);
  const [loading, setLoading] = useState(!!d.previewSrc);
  const [present, setPresent] = useState<string[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrollY = useRef(0);
  const restoreY = useRef<number | null>(null);
  const savedKeys = useRef<WidgetKey[]>([]);
  const busy = fetcher.state !== "idle";
  const anyDirty = SAVABLE.some((k) => dirty[k]);

  const post = useCallback((m: any) => { try { frame.current?.contentWindow?.postMessage(m, "*"); } catch { /* frame gone */ } }, []);

  /* messages from the preview */
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data || {};
      if (m.vw === "ready") {
        setLoading(false);
        setPresent(m.present || []);
        if (restoreY.current != null) { post({ vw: "scrollTo", y: restoreY.current }); restoreY.current = null; }
        post({ vw: "select", key: sel, scroll: false });
      }
      if (m.vw === "select" && ALL.some((w) => w.key === m.key)) setSel(m.key);
      if (m.vw === "scroll") scrollY.current = m.y || 0;
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [post, sel]);

  useEffect(() => { post({ vw: "select", key: sel }); }, [sel, post]);

  /* unsaved changes → preview right away (offer bar, badges, WhatsApp lines) */
  useEffect(() => {
    const t = setTimeout(() => {
      const o = drafts.offer;
      const offer = o.edit || (o.mode === "offer" ? d.offers.find((x) => x.id === o.offerId) : d.offers.find((x) => x.handle === "default-offer"));
      if (offer && dirty.offer) {
        post({ vw: "draft", key: "offer", data: {
          title: offer.title, enabled: offer.enabled, timerMode: offer.timerMode, background: offer.background,
          hasImage: !!(offer.backgroundImage || (o.edit as OfferDraft | null)?.bgPreview),
          endLabel: offer.endTime ? `Ends ${new Date(offer.endTime).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "",
        } });
      }
      if (dirty.badges) post({ vw: "draft", key: "badges", data: { lines: drafts.badges.rows.filter((r) => r.value && r.badge).map((r) => `${r.value} = ${r.badge}`).join("\n") } });
      if (dirty.whatsapp) post({ vw: "draft", key: "whatsapp", data: { lines: drafts.whatsapp.rows.length ? drafts.whatsapp.rows.map((r) => r.q).filter(Boolean) : DEFAULT_WA } });
    }, 120);
    return () => clearTimeout(t);
  }, [drafts, dirty, d.offers, post]);

  /* after Save: fresh data, and the preview reloads to show the real saved page at the same place */
  useEffect(() => {
    const r: any = fetcher.data;
    if (!r?.message) return;
    shopify.toast.show(r.message, { isError: r.ok === false });
    savedKeys.current = (r.saved || []) as WidgetKey[];
    if (r.saved?.length) {
      revalidator.revalidate();
      restoreY.current = scrollY.current;
      setLoading(true);
      setReloadKey((k) => k + 1);
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const keys = savedKeys.current;
    if (!keys.length) return;
    savedKeys.current = [];
    setDrafts((cur) => { const n: any = { ...cur }; keys.forEach((k) => (n[k] = (base as any)[k])); return n; });
    setDirty((cur) => { const n = { ...cur }; keys.forEach((k) => (n[k] = false)); return n; });
  }, [base]);

  const setW = <K extends keyof Drafts>(k: K) => (v: Drafts[K]) => { setDrafts((cur) => ({ ...cur, [k]: v })); setDirty((cur) => ({ ...cur, [k]: true })); };

  const save = () => {
    const keys = SAVABLE.filter((k) => dirty[k]);
    if (!keys.length) return;
    const fd = new FormData();
    fd.append("widgets", JSON.stringify(keys));
    for (const k of keys) {
      if (k === "offer") {
        const o = drafts.offer;
        const edit = o.edit ? { ...o.edit, slides: o.edit.slides.map(({ file: _f, preview: _p, ...s }) => s), bgFile: undefined, bgPreview: undefined } : null;
        fd.append("data_offer", JSON.stringify({ mode: o.mode, offerId: o.offerId, edit }));
        if (o.edit?.bgFile) fd.append("offerBackground", o.edit.bgFile);
        o.edit?.slides.forEach((s, i) => { if (s.file) fd.append(`slideImage_${i}`, s.file); });
      }
      if (k === "specialOffers") fd.append("data_specialOffers", JSON.stringify({ cards: drafts.specialOffers.cards }));
      if (k === "badges") fd.append("data_badges", JSON.stringify({ rows: drafts.badges.rows }));
      if (k === "sizeGuide") {
        const s = drafts.sizeGuide;
        fd.append("data_sizeGuide", JSON.stringify({ chartId: s.chartId, removeChart: s.removeChart, fit: s.fit }));
        if (s.file) fd.append("sizeChart", s.file);
      }
      if (k === "videos") {
        fd.append("data_videos", JSON.stringify({ ids: drafts.videos.items.map((x) => x.id) }));
        drafts.videos.files.forEach((f) => fd.append("videos", f));
      }
      if (k === "whatsapp") fd.append("data_whatsapp", JSON.stringify({ rows: drafts.whatsapp.rows }));
    }
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };
  const discard = () => {
    setDrafts(base);
    setDirty({});
    restoreY.current = scrollY.current;
    setLoading(true);
    setReloadKey((k) => k + 1); // throw away the unsaved preview changes too
  };

  const isSet = (k: WidgetKey) =>
    k === "offer" ? !!d.offerId : k === "specialOffers" ? d.cardIds.length > 0 : k === "badges" ? !!d.badges : k === "sizeGuide" ? !!(d.sizeChart.id || d.sizeFit)
      : k === "videos" ? d.videos.length > 0 : k === "whatsapp" ? !!d.whatsapp : d.reviews.count > 0;
  const W = ALL.find((w) => w.key === sel)!;
  const src = d.previewSrc ? `${d.previewSrc}&r=${reloadKey}` : "";
  const onPage = (k: WidgetKey) => !present || present.includes(k);

  return (
    <>
      <style>{CSS}</style>
      <SaveBar id="product-editor-save" open={anyDirty}>
        <button variant="primary" onClick={save} {...(busy ? { loading: "" } : {})}>Save</button>
        <button onClick={discard} {...(busy ? { disabled: true } : {})}>Discard</button>
      </SaveBar>
      <div className="te">
        <div className="te-top">
          <div className="te-top-l">
            <s-button variant="tertiary" icon="chevron-left" accessibilityLabel="Back to products" onClick={() => navigate("/app/products")} />
            {d.product.image && <img src={img(d.product.image, 80)} alt="" />}
            <span className="te-name">{d.product.title}</span>
            {d.product.status !== "ACTIVE" && <s-badge>{d.product.status === "DRAFT" ? "Draft" : "Archived"}</s-badge>}
          </div>
          <div className="te-dev" role="group" aria-label="Preview size">
            <button type="button" className={mobile ? "on" : ""} onClick={() => setMobile(true)}><s-icon type="mobile" />Mobile</button>
            <button type="button" className={!mobile ? "on" : ""} onClick={() => setMobile(false)}><s-icon type="desktop" />Desktop</button>
          </div>
          <div className="te-top-r">
            {src && <s-button variant="tertiary" icon="refresh" accessibilityLabel="Reload preview" onClick={() => { restoreY.current = scrollY.current; setLoading(true); setReloadKey((k) => k + 1); }} />}
            {d.product.url && <s-button icon="external" href={d.product.url} target="_blank">View</s-button>}
          </div>
        </div>

        <div className="te-body">
          <div className="te-side te-left">
            {GROUPS.map((g) => (
              <div key={g.title}>
                <div className="te-g">{g.title}</div>
                {g.items.map((w) => (
                  <button key={w.key} type="button" className={`te-i${sel === w.key ? " on" : ""}${onPage(w.key) ? "" : " missing"}`} onClick={() => setSel(w.key)}>
                    <s-icon type={w.icon as any} />
                    <span>{w.label}</span>
                    <span className="te-i-meta">
                      {!onPage(w.key) && <span>Off in theme</span>}
                      <span className={`te-dot${dirty[w.key] ? " dirty" : isSet(w.key) ? " set" : ""}`} title={dirty[w.key] ? "Unsaved changes" : isSet(w.key) ? "Set on this product" : "Not set"} />
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="te-canvas">
            <div className={`te-frame${mobile ? " mobile" : ""}`}>
              {src ? (
                <>
                  {loading && <div className="te-loading"><div><s-spinner accessibilityLabel="Loading preview" size="large" /><span>Loading the live page…</span></div></div>}
                  <iframe ref={frame} key={reloadKey} src={src} title="Live preview" onLoad={() => setTimeout(() => setLoading(false), 1500)} />
                </>
              ) : (
                <div className="te-nolive">
                  <s-stack gap="base" alignItems="center">
                    <s-heading>No live preview</s-heading>
                    <s-paragraph>This product isn’t on the online store yet (draft, archived or not published). You can still edit its widgets; they show once it’s published.</s-paragraph>
                  </s-stack>
                </div>
              )}
            </div>
          </div>

          <div className="te-side te-right">
            <div className="te-head">
              <h2><s-icon type={W.icon as any} />{W.label}{dirty[sel] && <s-badge tone="warning">Unsaved</s-badge>}</h2>
              <p>{W.about}</p>
            </div>
            <div className="te-form">
              {sel === "offer" && <OfferForm d={d} v={drafts.offer} set={setW("offer")} />}
              {sel === "specialOffers" && <CardsForm d={d} v={drafts.specialOffers} set={setW("specialOffers")} present={onPage("specialOffers")} />}
              {sel === "badges" && <BadgesForm d={d} v={drafts.badges} set={setW("badges")} />}
              {sel === "sizeGuide" && <SizeForm v={drafts.sizeGuide} set={setW("sizeGuide")} />}
              {sel === "videos" && <VideosForm v={drafts.videos} set={setW("videos")} />}
              {sel === "whatsapp" && <WhatsAppForm v={drafts.whatsapp} set={setW("whatsapp")} />}
              {sel === "reviews" && <ReviewsPanel d={d} />}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
