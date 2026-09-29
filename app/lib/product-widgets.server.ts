/**
 * Product page widgets, edited per product in the app (Products → product → editor).
 * Everything is stored where the theme already reads it, so the theme needs no change:
 *
 *   Offer bar        product metafield custom.offer            → metaobject offer_banner (slides → offer_slide)
 *   Special Offers   product metafield custom.special_offers   → list of metaobject special_offer
 *   Swatch badges    product metafield custom.swatch_badges    (lines "Value = Badge")
 *   Size guide       product metafields custom.size_chart (image) + custom.size_fit (Runs Small / True to Size / Runs Large)
 *   Floating videos  product metafield custom.floating_videos  (list of videos)
 *   WhatsApp lines   product metafield custom.whatsapp_questions (lines "Question | message")
 *   Reviews          vw_reviews.summary (read only here; managed in Reviews)
 *
 * Offer and Special Offer entries are shared: one entry can be used by many products.
 */
import { gql, uploadImages, uploadMedia } from "./reviews.server";
import { AFTER_END, FIT_CHOICES, ICONS, ON_TAP, TIMER_MODES } from "./product-widgets.shared";
import type { Offer, OfferCard, VideoItem } from "./product-widgets.shared";
export type { Offer, OfferCard, VideoItem } from "./product-widgets.shared";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

const productGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`);

const FILE_FRAG = `reference { ... on MediaImage { id image { url } } }`;
const OFFER_FIELDS = `id handle fields { key value ${FILE_FRAG}
  references(first: 20) { nodes { ... on Metaobject { id fields { key value ${FILE_FRAG} } } } } }`;
const CARD_FIELDS = `id handle fields { key value }`;

function fieldMap(fields: any[]) {
  const m: Record<string, any> = {};
  (fields || []).forEach((f) => (m[f.key] = f));
  return m;
}

function toOffer(n: any): Offer {
  const f = fieldMap(n.fields);
  return {
    id: n.id,
    handle: n.handle,
    title: f.title?.value || "",
    enabled: f.enabled?.value !== "false",
    timerMode: f.timer_mode?.value || TIMER_MODES[0],
    endTime: f.end_time?.value || "",
    afterEnd: f.after_end?.value || AFTER_END[0],
    background: f.background_color?.value || "",
    backgroundImage: f.background_image?.reference?.image?.url || "",
    backgroundImageId: f.background_image?.reference?.id || "",
    rotate: parseInt(f.rotate_seconds?.value || "5", 10) || 5,
    slides: (f.slides?.references?.nodes || []).filter(Boolean).map((s: any) => {
      const g = fieldMap(s.fields);
      return {
        id: s.id,
        headline: g.headline?.value || "",
        subheadline: g.subheadline?.value || "",
        onTap: g.on_tap?.value || "Nothing",
        link: g.link?.value || "",
        image: g.image?.reference?.image?.url || "",
        imageId: g.image?.reference?.id || "",
      };
    }),
  };
}

function toCard(n: any): OfferCard {
  const f = fieldMap(n.fields);
  return {
    id: n.id, handle: n.handle, title: f.title?.value || "", label: f.label?.value || "", subtitle: f.subtitle?.value || "",
    icon: f.icon?.value || "Tag", code: f.code?.value || "", style: f.style?.value || "Dark",
  };
}

/* ───────────────────────── products table ───────────────────────── */
export type ProductRow = {
  id: string; title: string; handle: string; status: string; inventory: number; image: string; price: string; currency: string;
  reviews: { count: number; avg: number };
  widgets: { offer: boolean; specialOffers: number; badges: boolean; sizeGuide: boolean; videos: number; whatsapp: boolean };
};
export async function listProducts(admin: Admin, q: string, after?: string | null) {
  const d = await gql(admin, `query($q: String, $after: String) {
    products(first: 25, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { id title handle status totalInventory featuredMedia { preview { image { url } } }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        offer: metafield(namespace: "custom", key: "offer") { id }
        so: metafield(namespace: "custom", key: "special_offers") { value }
        badges: metafield(namespace: "custom", key: "swatch_badges") { id }
        chart: metafield(namespace: "custom", key: "size_chart") { id }
        fit: metafield(namespace: "custom", key: "size_fit") { value }
        videos: metafield(namespace: "custom", key: "floating_videos") { value }
        wa: metafield(namespace: "custom", key: "whatsapp_questions") { id }
        summary: metafield(namespace: "vw_reviews", key: "summary") { value } } } }`, { q: q || null, after: after || null });
  const p = d.products;
  return {
    hasNext: p.pageInfo.hasNextPage,
    cursor: p.pageInfo.endCursor as string | null,
    rows: (p.nodes as any[]).map((n: any): ProductRow => {
      let reviews = { count: 0, avg: 0 };
      try { const s = JSON.parse(n.summary?.value || "{}"); reviews = { count: s.count || 0, avg: s.avg || 0 }; } catch { /* none */ }
      const count = (v?: string) => { try { return (JSON.parse(v || "[]") as unknown[]).length; } catch { return 0; } };
      return {
        id: n.id.split("/").pop() as string,
        title: n.title as string,
        handle: n.handle as string,
        status: n.status as string,
        inventory: n.totalInventory as number,
        image: n.featuredMedia?.preview?.image?.url || "",
        price: n.priceRangeV2?.minVariantPrice?.amount || "0",
        currency: n.priceRangeV2?.minVariantPrice?.currencyCode || "INR",
        reviews,
        widgets: {
          offer: !!n.offer,
          specialOffers: count(n.so?.value),
          badges: !!n.badges,
          sizeGuide: !!n.chart || !!n.fit,
          videos: count(n.videos?.value),
          whatsapp: !!n.wa,
        },
      };
    }),
  };
}

/* ───────────────────────── one product, everything the editor needs ───────────────────────── */
export async function loadProductWidgets(admin: Admin, productId: string) {
  const d = await gql(admin, `query($id: ID!) {
    shop { primaryDomain { url } }
    product(id: $id) { id title handle status onlineStoreUrl onlineStorePreviewUrl templateSuffix
      featuredMedia { preview { image { url } } }
      media(first: 12) { nodes { ... on MediaImage { image { url } } } }
      options { name values }
      variants(first: 100) { nodes { id title price compareAtPrice inventoryQuantity selectedOptions { name value } image { url } } }
      offer: metafield(namespace: "custom", key: "offer") { reference { ... on Metaobject { ${OFFER_FIELDS} } } }
      so: metafield(namespace: "custom", key: "special_offers") { references(first: 20) { nodes { ... on Metaobject { ${CARD_FIELDS} } } } }
      badges: metafield(namespace: "custom", key: "swatch_badges") { value }
      chart: metafield(namespace: "custom", key: "size_chart") { reference { ... on MediaImage { id image { url } } } }
      fit: metafield(namespace: "custom", key: "size_fit") { value }
      videos: metafield(namespace: "custom", key: "floating_videos") { references(first: 10) { nodes {
        ... on Video { id preview { image { url } } sources { url mimeType } } } } }
      wa: metafield(namespace: "custom", key: "whatsapp_questions") { value }
      summary: metafield(namespace: "vw_reviews", key: "summary") { value } }
    offers: metaobjects(type: "offer_banner", first: 50) { nodes { ${OFFER_FIELDS} } }
    cards: metaobjects(type: "special_offer", first: 100) { nodes { ${CARD_FIELDS} } } }`, { id: productGid(productId) });
  const p = d.product;
  if (!p) return null;

  let reviews: any = { count: 0, avg: 0, dist: {}, top: [] };
  try { reviews = { ...reviews, ...JSON.parse(p.summary?.value || "{}") }; } catch { /* none */ }
  const variants = p.variants.nodes.map((v: any) => ({
    id: v.id, title: v.title, price: v.price, compareAtPrice: v.compareAtPrice, inventory: v.inventoryQuantity,
    options: Object.fromEntries(v.selectedOptions.map((o: any) => [o.name, o.value])), image: v.image?.url || "",
  }));

  return {
    product: {
      id: productId,
      title: p.title as string,
      handle: p.handle as string,
      status: p.status as string,
      url: (p.onlineStoreUrl as string) || "",
      templateSuffix: (p.templateSuffix as string) || "",
      domain: String(d.shop?.primaryDomain?.url || "").replace(/\/$/, ""),
      image: p.featuredMedia?.preview?.image?.url || "",
      images: (p.media?.nodes || []).map((m: any) => m?.image?.url).filter(Boolean) as string[],
      options: p.options as { name: string; values: string[] }[],
      variants,
    },
    offerId: p.offer?.reference?.id || "",
    offers: (d.offers.nodes || []).map(toOffer) as Offer[],
    cardIds: (p.so?.references?.nodes || []).filter(Boolean).map((n: any) => n.id) as string[],
    cards: (d.cards.nodes || []).map(toCard) as OfferCard[],
    badges: (p.badges?.value as string) || "",
    sizeChart: { id: p.chart?.reference?.id || "", url: p.chart?.reference?.image?.url || "" },
    sizeFit: (p.fit?.value as string) || "",
    videos: (p.videos?.references?.nodes || []).filter((n: any) => n?.id).map((n: any) => {
      const src = (n.sources || []).find((s: any) => /mp4/.test(s.mimeType || "")) || (n.sources || [])[0];
      return { id: n.id, poster: n.preview?.image?.url || "", url: src?.url || "" };
    }) as VideoItem[],
    whatsapp: (p.wa?.value as string) || "",
    reviews: { count: reviews.count || 0, avg: reviews.avg || 0, dist: reviews.dist || {}, top: (reviews.top || []).slice(0, 3) },
  };
}

/* ───────────────────────── saving ───────────────────────── */
async function setOrClear(admin: Admin, productId: string, key: string, type: string, value: string | null) {
  const ownerId = productGid(productId);
  if (value === null || value === "" || value === "[]") {
    const r = await gql(admin, `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { message } } }`, {
      m: [{ ownerId, namespace: "custom", key }],
    });
    const errs = r.metafieldsDelete.userErrors;
    if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
    return;
  }
  const r = await gql(admin, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`, {
    m: [{ ownerId, namespace: "custom", key, type, value }],
  });
  const errs = r.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
}

async function saveMetaobject(admin: Admin, type: string, id: string | null, fields: { key: string; value: string }[]) {
  if (id) {
    const r = await gql(admin, `mutation($id: ID!, $m: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $m) {
      metaobject { id } userErrors { field message } } }`, { id, m: { fields } });
    const errs = r.metaobjectUpdate.userErrors;
    if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
    return r.metaobjectUpdate.metaobject.id as string;
  }
  const r = await gql(admin, `mutation($m: MetaobjectCreateInput!) { metaobjectCreate(metaobject: $m) {
    metaobject { id } userErrors { field message } } }`, { m: { type, fields } });
  const errs = r.metaobjectCreate.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  return r.metaobjectCreate.metaobject.id as string;
}

const clean = (s: unknown, max = 200) => String(s ?? "").trim().slice(0, max);
const choice = (v: unknown, list: readonly string[], dflt: string) => (list.includes(String(v)) ? String(v) : dflt);
const fileOf = (v: FormDataEntryValue | null) => (v && typeof v !== "string" && v.size > 0 ? v : null);

export async function saveWidget(admin: Admin, productId: string, widget: string, fd: FormData) {
  // one Save can carry several widgets: each sends its own "data_<widget>"
  const data = JSON.parse(String(fd.get(`data_${widget}`) || fd.get("data") || "{}"));

  if (widget === "offer") {
    // data.mode: "default" = the theme's default offer, "offer" = data.offerId (or the offer being edited/created)
    let offerId: string = data.mode === "offer" ? data.offerId || "" : "";
    if (data.edit) {
      const o = data.edit as Offer & { new?: boolean; removeBg?: boolean };
      // banner slides: save each (new ones are created), keep their order
      const slideIds: string[] = [];
      for (let i = 0; i < (o.slides || []).length; i++) {
        const s = o.slides[i];
        let imageId = s.imageId || "";
        const up = fileOf(fd.get(`slideImage_${i}`));
        if (up) imageId = (await uploadImages(admin, [up]))[0]?.id || imageId;
        const onTap = choice(s.onTap, ON_TAP, "Nothing");
        slideIds.push(await saveMetaobject(admin, "offer_slide", s.id && !s.id.startsWith("new") ? s.id : null, [
          { key: "headline", value: clean(s.headline, 120) },
          { key: "subheadline", value: clean(s.subheadline, 160) },
          { key: "on_tap", value: onTap },
          { key: "link", value: onTap === "Open link" ? clean(s.link, 500) : "" },
          { key: "image", value: imageId },
        ]));
      }
      let bgId = o.removeBg ? "" : o.backgroundImageId || "";
      const bg = fileOf(fd.get("offerBackground"));
      if (bg) bgId = (await uploadImages(admin, [bg]))[0]?.id || bgId;
      const mode = choice(o.timerMode, TIMER_MODES, TIMER_MODES[0]);
      const end = mode === "Fixed end date" && o.endTime ? new Date(o.endTime).toISOString() : "";
      const savedId = await saveMetaobject(admin, "offer_banner", o.new ? null : o.id, [
        { key: "title", value: clean(o.title, 80) || "Limited Time Offer" },
        { key: "enabled", value: String(o.enabled !== false) },
        { key: "timer_mode", value: mode },
        { key: "end_time", value: end },
        { key: "after_end", value: choice(o.afterEnd, AFTER_END, AFTER_END[0]) },
        { key: "background_color", value: /^#[0-9a-f]{6}$/i.test(o.background || "") ? o.background : "" },
        { key: "background_image", value: bgId },
        { key: "rotate_seconds", value: String(Math.max(2, Math.min(20, Math.round(Number(o.rotate) || 5)))) },
        { key: "slides", value: slideIds.length ? JSON.stringify(slideIds) : "" },
      ]);
      // editing the default offer keeps this product on the default; otherwise the product uses what was edited
      if (data.mode === "offer") offerId = savedId;
    }
    await setOrClear(admin, productId, "offer", "metaobject_reference", offerId || null);
    return "Offer bar saved";
  }

  if (widget === "specialOffers") {
    const ids: string[] = [];
    for (const c of (data.cards || []) as (OfferCard & { new?: boolean; dirty?: boolean })[]) {
      if (!c.new && !c.dirty) { ids.push(c.id); continue; }
      ids.push(await saveMetaobject(admin, "special_offer", c.new ? null : c.id, [
        { key: "title", value: clean(c.title, 80) || "Offer" },
        { key: "label", value: clean(c.label, 30) },
        { key: "subtitle", value: clean(c.subtitle, 100) },
        { key: "icon", value: choice(c.icon, ICONS, "Tag") },
        { key: "code", value: clean(c.code, 40).toUpperCase() },
        { key: "style", value: choice(c.style, ["Dark", "Light"], "Dark") },
      ]));
    }
    await setOrClear(admin, productId, "special_offers", "list.metaobject_reference", JSON.stringify([...new Set(ids)]));
    return ids.length ? "Special Offers saved" : "Special Offers removed from this product";
  }

  if (widget === "badges") {
    const lines = ((data.rows || []) as { value: string; badge: string }[])
      .map((r) => ({ value: clean(r.value, 60), badge: clean(r.badge, 30) }))
      .filter((r) => r.value && r.badge)
      .map((r) => `${r.value} = ${r.badge}`);
    await setOrClear(admin, productId, "swatch_badges", "multi_line_text_field", lines.join("\n") || null);
    return "Badges saved";
  }

  if (widget === "sizeGuide") {
    let chartId = data.removeChart ? "" : data.chartId || "";
    const up = fileOf(fd.get("sizeChart"));
    if (up) chartId = (await uploadImages(admin, [up]))[0]?.id || chartId;
    await setOrClear(admin, productId, "size_chart", "file_reference", chartId || null);
    await setOrClear(admin, productId, "size_fit", "single_line_text_field", data.fit ? choice(data.fit, FIT_CHOICES, "True to Size") : null);
    return "Size guide saved";
  }

  if (widget === "videos") {
    const keep: string[] = (data.ids || []).filter((x: unknown) => typeof x === "string");
    const files = fd.getAll("videos").filter((f): f is File => typeof f !== "string" && f.size > 0);
    const added = files.length ? (await uploadMedia(admin, files)).map((m) => m.id) : [];
    const ids = [...keep, ...added].slice(0, 8);
    await setOrClear(admin, productId, "floating_videos", "list.file_reference", JSON.stringify(ids));
    return added.length ? `Videos saved (${added.length} uploaded — Shopify may take a minute to process them)` : "Videos saved";
  }

  if (widget === "whatsapp") {
    const lines = ((data.rows || []) as { q: string; msg: string }[])
      .map((r) => ({ q: clean(r.q, 90).replace(/\|/g, "/"), msg: clean(r.msg, 300) }))
      .filter((r) => r.q)
      .map((r) => (r.msg ? `${r.q} | ${r.msg}` : r.q));
    await setOrClear(admin, productId, "whatsapp_questions", "multi_line_text_field", lines.join("\n") || null);
    return lines.length ? "WhatsApp lines saved" : "WhatsApp lines removed (the theme's default lines show)";
  }

  throw new Error("Unknown widget");
}
