/**
 * Conversation UI for a review (comments + replies), shared by the review editor and the reviews list popup.
 * Every change posts to the review editor route's action (`actionUrl`), so both pages behave the same.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { ReviewComment } from "../lib/reviews.shared";

export const initials = (name: string) =>
  (String(name || "?").match(/[A-Za-zऀ-ॿ]+/g) || ["?"]).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

/** Everyone who speaks in this review: the reviewer and each commenter (for "Reply as"). */
export function peopleOf(review: any) {
  const out: { name: string; avatar: string | null }[] = [];
  const seen = new Set<string>();
  const add = (name: string, avatar: string | null) => {
    const k = name.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ name: name.trim(), avatar });
  };
  if (review?.author) add(review.author, review.avatar?.url || null);
  const walk = (list: ReviewComment[]) =>
    list.forEach((c) => {
      if (c.type !== "store") add(c.name, c.avatar || null);
      walk(c.replies || []);
    });
  walk(review?.replies || []);
  return out;
}

/** Where comment actions are posted (the editor route of this review). */
const ActionUrl = createContext<string | undefined>(undefined);

/* calm, neutral look: white surface, hairline greys, one dark accent */
export const CV_CSS = `
.cv { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #303030; }
.cv-av { flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
  background: #f3f3f3; color: #707070; font-size: 11.5px; font-weight: 600; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06); }
.cv-av.sm { width: 26px; height: 26px; font-size: 10px; }
.cv-av.lg { width: 40px; height: 40px; font-size: 13px; }
.cv-av.store { background: #fff; color: #303030; box-shadow: inset 0 0 0 1px #d4d4d4; }
.cv-av img { width: 100%; height: 100%; object-fit: cover; }

.cv-review { display: flex; gap: 12px; padding: 2px 0 18px; margin-bottom: 4px; border-bottom: 1px solid #f1f1f1; }
.cv-review-name { font-weight: 600; font-size: 14px; color: #1f1f1f; }
.cv-stars { color: #4a4a4a; letter-spacing: 1.5px; font-size: 10.5px; margin-left: 8px; vertical-align: 1px; }
.cv-stars i { color: #dedede; font-style: normal; }
.cv-review-text { margin-top: 8px; font-size: 13.5px; line-height: 21px; color: #4a4a4a; }
.cv-muted { color: #9a9a9a; font-size: 12px; margin-top: 1px; }

.cv-list { padding: 4px 0 8px; }
.cv-node { position: relative; }
.cv-row { display: flex; gap: 10px; padding: 14px 0 0; }
.cv-body { flex: 1; min-width: 0; }
.cv-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: #9a9a9a; line-height: 18px; }
.cv-name { color: #1f1f1f; font-weight: 600; font-size: 13px; }
.cv-tag { font-size: 11px; color: #8a8a8a; }
.cv-tag.hidden { color: #a86a00; }
.cv-tag.pending { color: #b42318; }
.cv-act.approve { color: #1f1f1f; font-weight: 600; border: 1px solid #d4d4d4; margin-right: 4px; }
.cv-act.approve:hover { background: #303030; color: #fff; border-color: #303030; }
.cv-text { margin: 2px 0 0; font-size: 13.5px; line-height: 20px; color: #3a3a3a; white-space: pre-wrap; word-wrap: break-word; }
.cv-node.is-hidden > .cv-row .cv-text, .cv-node.is-hidden > .cv-row .cv-av { opacity: 0.4; }

.cv-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 4px 0 0 -6px; }
.cv-act { border: 0; background: none; padding: 3px 6px; border-radius: 6px; font: inherit; font-size: 12px; color: #8a8a8a; cursor: pointer; }
.cv-act:hover { background: #f5f5f5; color: #303030; }
.cv-act.danger:hover { background: #fdf2f2; color: #b42318; }
.cv-act.on { color: #1f1f1f; font-weight: 600; }
.cv-act[disabled] { opacity: 0.5; cursor: default; }

/* like count: small stepper, edits the number shown on the store */
.cv-likes { display: inline-flex; align-items: center; height: 24px; margin-right: 4px; border: 1px solid #ececec; border-radius: 999px; overflow: hidden; }
.cv-likes button { border: 0; background: none; width: 22px; height: 100%; font-size: 13px; color: #8a8a8a; cursor: pointer; line-height: 1; }
.cv-likes button:hover { background: #f5f5f5; color: #303030; }
.cv-likes input { width: 40px; height: 100%; border: 0; padding: 0; text-align: center; font: inherit; font-size: 12px; color: #303030;
  background: transparent; -moz-appearance: textfield; }
.cv-likes input::-webkit-outer-spin-button, .cv-likes input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.cv-likes input:focus { outline: none; background: #fafafa; }
.cv-likes .cv-heart { padding-left: 8px; font-size: 11px; color: #b0b0b0; }
.cv-likes.saving { border-color: #d4d4d4; }

/* thread lines: parent avatar → each reply */
.cv-kids { position: relative; margin-left: 15px; padding-left: 20px; }
.cv-kids::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; border-left: 1px solid #e6e6e6; }
.cv-kids > .cv-node::before { content: ""; position: absolute; left: -20px; top: 0; width: 14px; height: 27px;
  border-left: 1px solid #e6e6e6; border-bottom: 1px solid #e6e6e6; border-bottom-left-radius: 10px; z-index: 1; }
.cv-kids > .cv-node:last-child::after { content: ""; position: absolute; left: -21px; top: 16px; bottom: 0; width: 3px; background: #fff; }
.cv-node.has-kids > .cv-row { position: relative; }
.cv-node.has-kids > .cv-row::after { content: ""; position: absolute; left: 15px; top: 50px; bottom: 0; border-left: 1px solid #e6e6e6; }
.cv-kids .cv-node.has-kids > .cv-row::after { left: 12px; top: 44px; }
.cv-kids .cv-kids { margin-left: 12px; }

.cv-edit { margin-top: 8px; display: grid; gap: 8px; padding: 12px; border: 1px solid #efefef; border-radius: 10px; background: #fcfcfc; }
.cv-edit-row { display: grid; grid-template-columns: 1fr 96px; gap: 8px; }
.cv-label { display: block; font-size: 11px; color: #8a8a8a; margin-bottom: 4px; }
.cv-input, .cv-textarea { width: 100%; box-sizing: border-box; border: 1px solid #e3e3e3; border-radius: 8px;
  padding: 7px 10px; font: inherit; font-size: 13px; background: #fff; color: #1f1f1f; }
.cv-textarea { resize: vertical; min-height: 66px; line-height: 19px; }
.cv-input:focus, .cv-textarea:focus { outline: none; border-color: #8a8a8a; }
.cv-btns { display: flex; gap: 6px; justify-content: flex-end; }
.cv-btn { border: 1px solid #303030; border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; background: #303030; color: #fff; }
.cv-btn.ghost { background: #fff; color: #4a4a4a; border-color: #e3e3e3; }
.cv-btn[disabled] { opacity: 0.5; cursor: default; }

/* composer: stays at the bottom of the popup */
.cv-composer { position: sticky; bottom: -16px; margin: 10px -16px -16px; padding: 12px 16px 14px; background: #fff; border-top: 1px solid #f1f1f1; }
.cv-target { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; color: #8a8a8a; }
.cv-target b { color: #303030; font-weight: 600; }
.cv-x { border: 0; background: none; padding: 0 2px; font: inherit; font-size: 12px; color: #8a8a8a; cursor: pointer; text-decoration: underline; }
.cv-x:hover { color: #303030; }
.cv-line { display: flex; align-items: flex-end; gap: 8px; }
.cv-as { position: relative; flex-shrink: 0; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px 0 4px;
  border: 1px solid #e3e3e3; border-radius: 999px; background: #fff; max-width: 180px; }
.cv-as:hover { border-color: #cfcfcf; }
.cv-as select { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.cv-as-name { font-size: 12.5px; font-weight: 500; color: #303030; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-as-caret { font-size: 9px; color: #9a9a9a; }
.cv-msg { flex: 1; min-width: 0; min-height: 36px; max-height: 140px; resize: none; border: 1px solid #e3e3e3; border-radius: 18px;
  padding: 8px 14px; font: inherit; font-size: 13.5px; line-height: 18px; box-sizing: border-box; background: #fafafa; color: #1f1f1f; }
.cv-msg:focus { outline: none; border-color: #8a8a8a; background: #fff; }
.cv-send { flex-shrink: 0; width: 36px; height: 36px; border: 0; border-radius: 50%; background: #303030; color: #fff; cursor: pointer; display: grid; place-items: center; }
.cv-send[disabled] { background: #f1f1f1; color: #b5b5b5; cursor: default; }
.cv-send svg { width: 15px; height: 15px; fill: currentColor; }
.cv-new { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cv-new .cv-input { flex: 1; }
.cv-file { font-size: 12px; color: #707070; max-width: 190px; }
.cv-hint { margin-top: 6px; font-size: 11px; color: #b0b0b0; text-align: right; }
.cv-empty { padding: 26px 0 12px; text-align: center; color: #9a9a9a; font-size: 13px; }

/* right-column summary */
.cv-sum-row { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f3f3f3; }
.cv-sum-row:last-child { border-bottom: 0; }
.cv-sum-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: #616161; font-size: 12.5px; line-height: 18px; }
`;

export function Avatar({ name, src, store, size }: { name: string; src?: string | null; store?: boolean; size?: "sm" | "lg" }) {
  return (
    <span className={`cv-av${size ? " " + size : ""}${store && !src ? " store" : ""}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

/** Right column: counts, the two latest messages and a button that opens the full conversation. */
export function ThreadSummary({ review, modalId = "thread-modal" }: { review: any; modalId?: string }) {
  const all: ReviewComment[] = [];
  const walk = (list: ReviewComment[]) => list.forEach((c) => { all.push(c); walk(c.replies || []); });
  walk(review.replies || []);
  const latest = [...all].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 2);
  const hidden = all.filter((c) => c.status === "hidden").length;
  const waiting = all.filter((c) => c.status === "pending").length;

  return (
    <s-stack gap="base">
      <style>{CV_CSS}</style>
      {all.length === 0 ? (
        <s-text color="subdued">No comments yet.</s-text>
      ) : (
        <div className="cv">
          {(review.needsReply || hidden > 0 || waiting > 0) && (
            <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              {waiting > 0 && <s-badge tone="critical">{waiting} waiting for approval</s-badge>}
              {review.needsReply && <s-badge>Needs reply</s-badge>}
              {hidden > 0 && <s-badge>{hidden} hidden</s-badge>}
            </div>
          )}
          {latest.map((c) => (
            <div key={c.id} className="cv-sum-row">
              <Avatar name={c.name} src={c.avatar} store={c.type === "store"} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cv-name">{c.name}</div>
                <div className="cv-sum-text">{c.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <s-button icon="chat" commandFor={modalId} command="--show">
        {all.length ? `Open conversation (${all.length})` : "Write a comment"}
      </s-button>
    </s-stack>
  );
}

/** Top of the conversation popup: the review itself. */
export function ReviewHeader({ review }: { review: any }) {
  const n = Math.max(1, Math.min(5, review.rating || 5));
  return (
    <div className="cv">
      <style>{CV_CSS}</style>
      <div className="cv-review">
        <Avatar name={review.author} src={review.avatar?.url} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>
            <span className="cv-review-name">{review.author}</span>
            <span className="cv-stars">{"★".repeat(n)}<i>{"★".repeat(5 - n)}</i></span>
          </div>
          <div className="cv-muted">
            {[review.location, new Date(review.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })].filter(Boolean).join(" · ")}
          </div>
          <div className="cv-review-text">{review.body}</div>
        </div>
      </div>
    </div>
  );
}

export function Thread({
  review,
  shopName,
  people,
  actionUrl,
}: {
  review: any;
  shopName: string;
  people: { name: string; avatar: string | null }[];
  actionUrl?: string;
}) {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const replies: ReviewComment[] = review.replies || [];
  return (
    <ActionUrl.Provider value={actionUrl}>
      <div className="cv">
        <style>{CV_CSS}</style>
        <div className="cv-list">
          {replies.length === 0 && <div className="cv-empty">No comments yet — write the first one below.</div>}
          {replies.map((c) => (
            <Node key={c.id} node={c} depth={0} onReply={(n) => setTarget({ id: n.id, name: n.name })} activeId={target?.id} />
          ))}
        </div>
        <Composer target={target} onDone={() => setTarget(null)} shopName={shopName} people={people} />
      </div>
    </ActionUrl.Provider>
  );
}

/** −  ♥ 12  + : saves on its own a moment after the last change. */
function Likes({ id, count }: { id: string; count: number }) {
  const fetcher = useFetcher<any>();
  const actionUrl = useContext(ActionUrl);
  const [val, setVal] = useState(String(count || 0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(count || 0);

  useEffect(() => { setVal(String(count || 0)); saved.current = count || 0; }, [count]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = (raw: string, wait: number) => {
    const n = Math.max(0, Math.min(99999, parseInt(raw, 10) || 0));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (n === saved.current) return;
      saved.current = n;
      fetcher.submit({ intent: "comment-likes", commentId: id, likes: String(n) }, { method: "POST", action: actionUrl });
    }, wait);
  };
  const step = (d: number) => {
    const n = Math.max(0, (parseInt(val, 10) || 0) + d);
    setVal(String(n));
    commit(String(n), 700);
  };

  return (
    <span className={`cv-likes${fetcher.state !== "idle" ? " saving" : ""}`} title="Likes shown on the store">
      <span className="cv-heart">♥</span>
      <input
        type="number"
        min={0}
        value={val}
        aria-label="Likes"
        onChange={(e) => { setVal(e.currentTarget.value); commit(e.currentTarget.value, 900); }}
        onBlur={(e) => commit(e.currentTarget.value, 0)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget.value, 0); } }}
      />
      <button type="button" onClick={() => step(-1)} aria-label="One less like">−</button>
      <button type="button" onClick={() => step(1)} aria-label="One more like">+</button>
    </span>
  );
}

function Node({ node, depth, onReply, activeId }: { node: ReviewComment; depth: number; onReply: (n: ReviewComment) => void; activeId?: string }) {
  const fetcher = useFetcher<any>();
  const actionUrl = useContext(ActionUrl);
  const shopify = useAppBridge();
  const [editing, setEditing] = useState(false);
  const busy = fetcher.state !== "idle";
  const hidden = node.status === "hidden";
  const pending = node.status === "pending";
  const store = node.type === "store";
  const kids = node.replies || [];

  useEffect(() => {
    const d: any = fetcher.data;
    if (d?.message) { shopify.toast.show(d.message, { isError: d.ok === false }); if (d.ok) setEditing(false); }
  }, [fetcher.data, shopify]);

  const send = (data: Record<string, string>) => fetcher.submit({ commentId: node.id, ...data }, { method: "POST", action: actionUrl });
  const when = new Date(node.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <div className={`cv-node${kids.length ? " has-kids" : ""}${hidden || pending ? " is-hidden" : ""}`}>
      <div className="cv-row">
        <Avatar name={node.name} src={node.avatar} store={store} size={depth ? "sm" : undefined} />
        <div className="cv-body">
          <div className="cv-meta">
            <span className="cv-name">{node.name}</span>
            {store && <span className="cv-tag">· Store</span>}
            {hidden && <span className="cv-tag hidden">· Hidden</span>}
            {pending && <span className="cv-tag pending">· Waiting for approval</span>}
            <span>· {when}</span>
          </div>

          {editing ? (
            <fetcher.Form method="post" action={actionUrl} className="cv-edit">
              <input type="hidden" name="intent" value="comment-edit" />
              <input type="hidden" name="commentId" value={node.id} />
              <div className="cv-edit-row">
                <label><span className="cv-label">Name</span><input className="cv-input" name="name" defaultValue={node.name} /></label>
                <label><span className="cv-label">Likes</span><input className="cv-input" name="likes" type="number" min={0} max={99999} defaultValue={node.likeCount || 0} /></label>
              </div>
              <label><span className="cv-label">Message</span><textarea className="cv-textarea" name="text" defaultValue={node.text} /></label>
              <div className="cv-btns">
                <button className="cv-btn ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
                <button className="cv-btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
              </div>
            </fetcher.Form>
          ) : (
            <p className="cv-text">{node.text}</p>
          )}

          {!editing && (
            <div className="cv-actions">
              {pending && (
                <button type="button" className="cv-act approve" disabled={busy} onClick={() => send({ intent: "comment-status", status: "approved" })}>
                  Approve
                </button>
              )}
              <Likes id={node.id} count={node.likeCount} />
              <button type="button" className={`cv-act${activeId === node.id ? " on" : ""}`} onClick={() => onReply(node)}>Reply</button>
              <button type="button" className="cv-act" onClick={() => setEditing(true)}>Edit</button>
              {!pending && (
                <button type="button" className="cv-act" disabled={busy} onClick={() => send({ intent: "comment-status", status: hidden ? "approved" : "hidden" })}>
                  {hidden ? "Show" : "Hide"}
                </button>
              )}
              <button type="button" className="cv-act danger" disabled={busy} onClick={() => { if (confirm("Delete this and its replies?")) send({ intent: "comment-delete" }); }}>
                Delete
              </button>
              {!store && node.customerId && (
                <button
                  type="button"
                  className="cv-act danger"
                  disabled={busy}
                  title="They won't be able to post reviews, comments or replies"
                  onClick={() => { if (confirm(`Block ${node.name}? They won't be able to post reviews, comments or replies. This comment will be hidden.`)) send({ intent: "block-user", hide: "true" }); }}
                >
                  Block
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {kids.length > 0 && (
        <div className="cv-kids">
          {kids.map((c) => (
            <Node key={c.id} node={c} depth={depth + 1} onReply={onReply} activeId={activeId} />
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({
  target,
  onDone,
  shopName,
  people,
}: {
  target: { id: string; name: string } | null;
  onDone: () => void;
  shopName: string;
  people: { name: string; avatar: string | null }[];
}) {
  const fetcher = useFetcher<any>();
  const actionUrl = useContext(ActionUrl);
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const [as, setAs] = useState<string>("store");
  const [newPic, setNewPic] = useState<string>("");
  const [text, setText] = useState("");
  const busy = fetcher.state !== "idle";
  const person = as.startsWith("person:") ? people.find((p) => `person:${p.name}` === as) : null;
  const asName = as === "store" ? shopName : as === "new" ? "New person" : as.slice(7);

  useEffect(() => { if (target) msgRef.current?.focus(); }, [target]);
  useEffect(() => {
    const d: any = fetcher.data;
    if (!d?.message) return;
    shopify.toast.show(d.message, { isError: d.ok === false });
    if (d.ok) {
      formRef.current?.reset();
      setText("");
      setNewPic("");
      if (msgRef.current) msgRef.current.style.height = "";
      onDone();
    }
  }, [fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cv-composer">
      <fetcher.Form method="post" action={actionUrl} encType="multipart/form-data" ref={formRef}>
        <input type="hidden" name="intent" value="reply-add" />
        <input type="hidden" name="parentId" value={target?.id || ""} />
        <input type="hidden" name="shopName" value={shopName} />
        <input type="hidden" name="replyAs" value={as} />
        <input type="hidden" name="personAvatar" value={person?.avatar || ""} />

        {target && (
          <div className="cv-target">
            <span>Replying to <b>{target.name}</b></span>
            <button type="button" className="cv-x" onClick={onDone}>cancel</button>
          </div>
        )}

        {as === "new" && (
          <div className="cv-new">
            <Avatar name="+" src={newPic || null} size="sm" />
            <input className="cv-input" name="newName" placeholder="New person's name" required />
            <input
              className="cv-file"
              type="file"
              name="newAvatar"
              accept="image/*"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                setNewPic(f ? URL.createObjectURL(f) : "");
              }}
            />
          </div>
        )}

        <div className="cv-line">
          <label className="cv-as" title="Reply as">
            <Avatar name={asName} src={as === "new" ? newPic || null : person?.avatar || null} store={as === "store"} size="sm" />
            <span className="cv-as-name">{asName}</span>
            <span className="cv-as-caret">▾</span>
            <select value={as} onChange={(e) => setAs(e.currentTarget.value)} aria-label="Reply as">
              <option value="store">{shopName} (store)</option>
              {people.map((p) => (
                <option key={p.name} value={`person:${p.name}`}>{p.name}</option>
              ))}
              <option value="new">+ New person…</option>
            </select>
          </label>
          <textarea
            ref={msgRef}
            className="cv-msg"
            name="replyText"
            rows={1}
            value={text}
            placeholder={target ? `Reply to ${target.name}…` : "Add a comment…"}
            onChange={(e) => {
              setText(e.currentTarget.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = Math.min(140, e.currentTarget.scrollHeight) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) formRef.current?.requestSubmit();
            }}
          />
          <button type="submit" className="cv-send" disabled={busy || !text.trim()} aria-label="Send">
            <svg viewBox="0 0 24 24"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          </button>
        </div>
        <div className="cv-hint">Ctrl + Enter to send</div>
      </fetcher.Form>
    </div>
  );
}
