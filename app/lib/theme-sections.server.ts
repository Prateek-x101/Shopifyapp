/**
 * Theme section settings for the product page editor — the same settings Shopify's theme editor shows.
 *
 * Reads the published theme: the product template the product uses (templates/product[.suffix].json), the header group
 * (sections/header-group.json), each section's {% schema %}, the English schema translations (t: keys) and the colour
 * schemes. Saving patches only the changed values in those JSON files (the header comment is kept), optionally on the
 * other product templates too, and writes them back with themeFilesUpsert.
 */
import { gql, uploadImages } from "./reviews.server";
import type { SectionData, SettingDef } from "./theme-sections.shared";

type Admin = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

const HEADER = "sections/header-group.json";

function splitJson(text: string) {
  const m = text.match(/^\s*\/\*[\s\S]*?\*\/\s*/);
  const head = m ? m[0] : "";
  return { head, json: JSON.parse(text.slice(head.length)) };
}
const joinJson = (head: string, obj: unknown) => `${head}${JSON.stringify(obj, null, 2)}\n`;

async function mainTheme(admin: Admin) {
  const d = await gql(admin, `{ themes(first: 1, roles: [MAIN]) { nodes { id name } } }`);
  const t = d.themes.nodes[0];
  if (!t) throw new Error("No published theme");
  return t as { id: string; name: string };
}

async function readFiles(admin: Admin, themeId: string, names: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i += 40) {
    const chunk = names.slice(i, i + 40);
    const d = await gql(admin, `query($id: ID!, $f: [String!]!) { theme(id: $id) { files(filenames: $f, first: 50) {
      nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`, { id: themeId, f: chunk });
    (d.theme?.files?.nodes || []).forEach((n: any) => { if (typeof n.body?.content === "string") out[n.filename] = n.body.content; });
  }
  return out;
}

async function listProductTemplates(admin: Admin, themeId: string) {
  const d = await gql(admin, `query($id: ID!) { theme(id: $id) { files(filenames: ["templates/product*.json"], first: 50) { nodes { filename } } } }`, { id: themeId });
  return (d.theme?.files?.nodes || []).map((n: any) => n.filename as string).filter((f: string) => /^templates\/product(\.[\w-]+)?\.json$/.test(f));
}

function schemaOf(liquid: string) {
  const m = liquid.match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function translator(locale: any) {
  return (v: unknown): string => {
    if (typeof v !== "string") return v == null ? "" : String(v);
    if (!v.startsWith("t:")) return v;
    const val = v.slice(2).split(".").reduce((o: any, k) => (o && typeof o === "object" ? o[k] : undefined), locale);
    if (typeof val === "string") return val;
    const last = v.split(".").pop() || v;
    return last.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  };
}

function cleanSettings(list: any[], t: (v: unknown) => string): SettingDef[] {
  return (list || []).map((s: any) => ({
    type: String(s.type || "text"),
    id: s.id ? String(s.id) : "",
    label: t(s.label ?? s.content ?? ""),
    info: s.info ? t(s.info) : "",
    content: s.content ? t(s.content) : "",
    default: s.default ?? null,
    min: s.min, max: s.max, step: s.step, unit: s.unit ? t(s.unit) : "",
    placeholder: s.placeholder ? t(s.placeholder) : "",
    options: Array.isArray(s.options) ? s.options.map((o: any) => ({ value: String(o.value), label: t(o.label ?? o.value) })) : undefined,
  }));
}

/** Everything the editor needs for the page's sections. */
export async function loadPageSections(admin: Admin, templateSuffix: string | null) {
  const theme = await mainTheme(admin);
  const templateFile = `templates/product${templateSuffix ? `.${templateSuffix}` : ""}.json`;
  const templates = await listProductTemplates(admin, theme.id);
  const first = await readFiles(admin, theme.id, [templateFile, HEADER, "locales/en.default.schema.json", "config/settings_data.json"]);
  const tplText = first[templateFile] ?? first["templates/product.json"];
  if (!tplText) throw new Error(`${templateFile} not found`);
  const tpl = splitJson(tplText).json;
  const hdr = first[HEADER] ? splitJson(first[HEADER]).json : { order: [], sections: {} };
  let locale: any = {};
  try { locale = JSON.parse(first["locales/en.default.schema.json"] || "{}"); } catch { locale = {}; }
  const t = translator(locale);
  let schemes: { value: string; label: string }[] = [];
  try {
    const sd = splitJson(first["config/settings_data.json"] || "{}").json;
    const cs = sd?.current?.color_schemes || {};
    schemes = Object.keys(cs).map((k, i) => ({ value: k, label: `Scheme ${i + 1}` }));
  } catch { schemes = []; }

  const types = new Set<string>();
  [tpl, hdr].forEach((g: any) => (g.order || []).forEach((k: string) => g.sections[k]?.type && types.add(g.sections[k].type)));
  const liquids = await readFiles(admin, theme.id, [...types].map((ty) => `sections/${ty}.liquid`));

  const build = (group: "header" | "template", g: any): SectionData[] =>
    (g.order || []).map((key: string) => {
      const s = g.sections[key] || {};
      const schema = schemaOf(liquids[`sections/${s.type}.liquid`] || "") || {};
      const blockDefs: Record<string, any> = {};
      (schema.blocks || []).forEach((b: any) => { if (b.type) blockDefs[b.type] = b; });
      return {
        id: `${group}:${key}`,
        group,
        key,
        type: s.type,
        name: t(schema.name) || s.type,
        disabled: !!s.disabled,
        settings: cleanSettings(schema.settings || [], t),
        values: s.settings || {},
        blocks: (s.block_order || Object.keys(s.blocks || {})).map((bk: string) => {
          const b = (s.blocks || {})[bk] || {};
          const def = blockDefs[b.type] || {};
          return {
            key: bk,
            type: b.type,
            name: t(def.name) || String(b.type || "Block").replace(/^_/, "").replace(/[-_]/g, " ").replace(/^\w/, (c: string) => c.toUpperCase()),
            disabled: !!b.disabled,
            settings: cleanSettings(def.settings || [], t),
            values: b.settings || {},
          };
        }),
      } as SectionData;
    });

  return {
    theme: theme.name,
    templateFile: first[templateFile] ? templateFile : "templates/product.json",
    otherTemplates: templates.filter((f: string) => f !== templateFile),
    colorSchemes: schemes,
    sections: [...build("header", hdr), ...build("template", tpl)],
  };
}

export type SectionChange = { id: string; disabled?: boolean; settings?: Record<string, unknown>; blocks?: Record<string, Record<string, unknown>> };

/** Writes the changed values (only those) into the header group / product template(s). */
export async function saveSections(admin: Admin, templateFile: string, changes: SectionChange[], alsoTemplates: string[]) {
  const theme = await mainTheme(admin);
  const touchesHeader = changes.some((c) => c.id.startsWith("header:"));
  const tplFiles = [templateFile, ...alsoTemplates.filter((f) => /^templates\/product(\.[\w-]+)?\.json$/.test(f) && f !== templateFile)];
  const names = [...(touchesHeader ? [HEADER] : []), ...(changes.some((c) => c.id.startsWith("template:")) ? tplFiles : [])];
  const files = await readFiles(admin, theme.id, names);
  const out: { filename: string; body: { type: "TEXT"; value: string } }[] = [];

  for (const name of names) {
    if (!files[name]) continue;
    const { head, json } = splitJson(files[name]);
    const group = name === HEADER ? "header" : "template";
    let changed = false;
    for (const c of changes) {
      const [g, key] = [c.id.split(":")[0], c.id.slice(c.id.indexOf(":") + 1)];
      if (g !== group) continue;
      const s = json.sections?.[key];
      if (!s) continue; // this template doesn't have the section
      if (c.disabled !== undefined) { if (c.disabled) s.disabled = true; else delete s.disabled; changed = true; }
      if (c.settings) { s.settings = { ...(s.settings || {}), ...c.settings }; changed = true; }
      if (c.blocks) {
        for (const [bk, vals] of Object.entries(c.blocks)) {
          if (s.blocks?.[bk]) { s.blocks[bk].settings = { ...(s.blocks[bk].settings || {}), ...vals }; changed = true; }
        }
      }
    }
    if (changed) out.push({ filename: name, body: { type: "TEXT", value: joinJson(head, json) } });
  }
  if (!out.length) return 0;
  const r = await gql(admin, `mutation($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $id, files: $files) { upsertedThemeFiles { filename } userErrors { field message } } }`, { id: theme.id, files: out });
  const errs = r.themeFilesUpsert.userErrors;
  if (errs?.length) throw new Error(errs.map((e: any) => e.message).join(", "));
  return out.length;
}

/** A picture for an image_picker setting: uploaded to Files, referenced the way themes expect. */
export async function themeImageFromUpload(admin: Admin, file: File) {
  const up = (await uploadImages(admin, [file]))[0];
  if (!up?.url) throw new Error("Picture upload failed");
  const name = decodeURIComponent(new URL(up.url).pathname.split("/").pop() || "");
  return `shopify://shop_images/${name}`;
}
