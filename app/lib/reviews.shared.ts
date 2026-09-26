/** Values used by both the server and the admin UI (safe to ship to the browser). */
export const STATUSES = ["pending", "published", "hidden"] as const;
export const SOURCES = ["Website", "WhatsApp", "Instagram", "Email", "Import"] as const;

/** Comment thread node (same shape the storefront review widget uses). Top level = comment, nested = reply. */
export type ReviewComment = {
  id: string;
  name: string;
  text: string;
  date: string;
  type: "store" | "customer";
  status: "approved" | "pending";
  customerId?: string | null;
  verified?: boolean;
  likeCount: number;
  parentCommentId?: string | null;
  replies?: ReviewComment[];
};

/** Accepts both the new tree and the first version's flat store replies ({author, isStore, createdAt}). */
export function normalizeComments(raw: unknown): ReviewComment[] {
  const list = Array.isArray(raw) ? raw : [];
  const norm = (c: any, parent: string | null): ReviewComment => ({
    id: String(c.id || `c_${Math.random().toString(36).slice(2, 10)}`),
    name: String(c.name ?? c.author ?? "Customer"),
    text: String(c.text ?? ""),
    date: String(c.date ?? c.createdAt ?? new Date().toISOString()),
    type: c.type === "store" || c.isStore ? "store" : "customer",
    status: c.status === "pending" ? "pending" : "approved",
    customerId: c.customerId ? String(c.customerId) : null,
    verified: !!c.verified,
    likeCount: Math.max(0, parseInt(c.likeCount ?? c.likes ?? 0, 10) || 0),
    parentCommentId: parent,
    replies: (Array.isArray(c.replies) ? c.replies : []).map((r: any) => norm(r, String(c.id))),
  });
  return list.filter((c) => c && typeof c === "object").map((c) => norm(c, null));
}
export function countComments(list: ReviewComment[]): number {
  return list.reduce((n, c) => n + 1 + countComments(c.replies || []), 0);
}
