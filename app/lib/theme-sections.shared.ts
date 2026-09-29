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
