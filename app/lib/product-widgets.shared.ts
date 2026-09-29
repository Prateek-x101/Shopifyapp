/** Choices and shapes for the product page editor (used by the server and the browser). */
export const FIT_CHOICES = ["Runs Small", "True to Size", "Runs Large"] as const;
export const ICONS = ["Lightning", "Tag", "Percent", "Wallet", "Gift", "Truck", "Bank"] as const;
export const TIMER_MODES = ["Daily (ends at midnight)", "Fixed end date", "No timer"] as const;
export const AFTER_END = ["Hide the bar", "Show 'Offer ended'"] as const;
export const ON_TAP = ["Nothing", "Scroll to reviews", "Open size guide", "Scroll to description", "Open link"] as const;

/* ───────────────────────── shapes sent to the editor ───────────────────────── */
export type OfferSlide = { id: string; headline: string; subheadline: string; onTap: string; link: string; image: string; imageId: string };
export type Offer = {
  id: string; handle: string; title: string; enabled: boolean; timerMode: string; endTime: string; afterEnd: string;
  background: string; backgroundImage: string; backgroundImageId: string; rotate: number; slides: OfferSlide[];
};
export type OfferCard = { id: string; handle: string; title: string; label: string; subtitle: string; icon: string; code: string; style: string };
export type VideoItem = { id: string; poster: string; url: string };

