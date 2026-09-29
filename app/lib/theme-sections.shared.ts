/** Shapes for theme section settings in the product page editor (server + browser). */
export type SettingDef = {
  type: string;
  id: string;
  label: string;
  info: string;
  content: string;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit: string;
  placeholder: string;
  options?: { value: string; label: string }[];
  visibleIf?: string;
};

export type BlockData = { key: string; type: string; name: string; disabled: boolean; settings: SettingDef[]; values: Record<string, unknown> };

export type SectionData = {
  id: string; // "template:engine-swatches" or "header:engine-offer-bar"
  group: "header" | "template";
  key: string;
  type: string;
  name: string;
  disabled: boolean;
  settings: SettingDef[];
  values: Record<string, unknown>;
  blocks: BlockData[];
};

/** Product-level editors (metafields) attached to theme sections. */
export const WIDGET_OF_SECTION: Record<string, "offer" | "badges" | "sizeGuide" | "whatsapp" | "specialOffers" | "videos" | "reviews"> = {
  "engine-offer-bar": "offer",
  "engine-swatches": "badges",
  "engine-size-table": "sizeGuide",
  "engine-buy-whatsapp-pay": "whatsapp",
  "engine-special-offers": "specialOffers",
  "engine-video-float": "videos",
  "engine-review-widget": "reviews",
};

/**
 * Shopify's `visible_if` for settings, e.g. "{{ section.settings.show_badge }}" or
 * "{{ section.settings.button_mode != 'add_to_cart' and block.settings.x == blank }}".
 * Supports: section/block settings, strings, numbers, true/false/nil/blank/empty, == != > < >= <=, contains, and, or.
 * Anything it can't read counts as visible (never hide a setting by mistake).
 */
export function isVisible(expr: string | undefined, section: Record<string, unknown>, block: Record<string, unknown> = {}): boolean {
  if (!expr) return true;
  const src = expr.replace(/^\s*\{\{\s*/, "").replace(/\s*\}\}\s*$/, "");
  const toks = src.match(/'[^']*'|"[^"]*"|==|!=|>=|<=|>|<|[A-Za-z_][\w.-]*|-?\d+(?:\.\d+)?|\S/g) || [];
  let i = 0;
  const BLANK = Symbol("blank");
  const val = (t: string): unknown => {
    if (/^['"]/.test(t)) return t.slice(1, -1);
    if (/^-?\d/.test(t)) return Number(t);
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "nil" || t === "null") return null;
    if (t === "blank" || t === "empty") return BLANK;
    const m = t.match(/^(section|block)\.settings\.([\w-]+)$/);
    if (m) return (m[1] === "section" ? section : block)[m[2]];
    throw new Error("unknown " + t);
  };
  const isBlank = (v: unknown) => v === null || v === undefined || v === false || v === "" || (Array.isArray(v) && !v.length);
  const truthy = (v: unknown) => v !== null && v !== undefined && v !== false;
  const cmp = (a: unknown, op: string, b: unknown): boolean => {
    if (a === BLANK || b === BLANK) { const blank = isBlank(a === BLANK ? b : a); return op === "==" ? blank : op === "!=" ? !blank : false; }
    switch (op) {
      case "==": return a == b; // eslint-disable-line eqeqeq
      case "!=": return a != b; // eslint-disable-line eqeqeq
      case ">": return Number(a) > Number(b);
      case "<": return Number(a) < Number(b);
      case ">=": return Number(a) >= Number(b);
      case "<=": return Number(a) <= Number(b);
      case "contains": return Array.isArray(a) ? a.includes(b) : String(a ?? "").includes(String(b ?? ""));
    }
    return false;
  };
  const primary = (): boolean => {
    const a = val(toks[i++]);
    const op = toks[i];
    if (op && /^(==|!=|>=|<=|>|<|contains)$/.test(op)) { i++; return cmp(a, op, val(toks[i++])); }
    return a === BLANK ? false : truthy(a);
  };
  const and = (): boolean => { let v = primary(); while (toks[i] === "and") { i++; const r = primary(); v = v && r; } return v; };
  const or = (): boolean => { let v = and(); while (toks[i] === "or") { i++; const r = and(); v = v || r; } return v; };
  try { const r = or(); return i >= toks.length ? r : true; } catch { return true; }
}
