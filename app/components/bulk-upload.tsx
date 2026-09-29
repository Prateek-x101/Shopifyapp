/** "Bulk upload" popup on a product's reviews page: JSON or text file (or pasted text) → many reviews at once. */
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { parseBulkReviews } from "../lib/reviews.shared";

const SAMPLE_JSON = JSON.stringify(
  [
    {
      name: "Rahul Sharma",
      city: "Pune",
      rating: 5,
      text: "Fabric quality is great, fits perfectly.",
      date: "2026-09-12",
      photos: ["https://example.com/photo1.jpg"],
      avatar: "",
      helpful: 4,
    },
    { name: "Priya", city: "Delhi", rating: 4, text: "Nice jacket, delivery was quick." },
  ],
  null,
  2,
);
const SAMPLE_TXT = `# Name | City | Rating | Review text | Date (optional) | Photo URLs (optional, comma separated)
Rahul Sharma | Pune | 5 | Fabric quality is great, fits perfectly. | 12/09/2026 |
Priya | Delhi | 4 | Nice jacket, delivery was quick. | |
Aman | Jaipur | 5 | Worth the price! | 2026-09-20 | https://example.com/a.jpg, https://example.com/b.jpg
`;

const dl = (text: string, type: string) => `data:${type};charset=utf-8,${encodeURIComponent(text)}`;

const CSS = `
.bu { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #303030; font-size: 13px; }
.bu-drop { display: grid; place-items: center; gap: 6px; padding: 22px 16px; border: 1px dashed #cfcfcf; border-radius: 12px; background: #fafafa;
  text-align: center; cursor: pointer; transition: border-color .15s, background .15s; }
.bu-drop:hover, .bu-drop.over { border-color: #8a8a8a; background: #f5f5f5; }
.bu-drop b { font-size: 13.5px; color: #1f1f1f; }
.bu-drop span { color: #8a8a8a; font-size: 12px; }
.bu-drop input { display: none; }
.bu-or { margin: 12px 0 6px; color: #9a9a9a; font-size: 12px; }
.bu-text { width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical; border: 1px solid #e3e3e3; border-radius: 10px; padding: 10px 12px;
  font: 12.5px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #1f1f1f; background: #fff; }
.bu-text:focus { outline: none; border-color: #8a8a8a; }
.bu-help { margin-top: 8px; color: #8a8a8a; font-size: 12px; line-height: 18px; }
.bu-help a { color: #303030; }
.bu-help code { background: #f3f3f3; border-radius: 4px; padding: 0 4px; font-size: 11.5px; }
.bu-sum { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; margin: 16px 0 8px; }
.bu-sum b { font-size: 14px; color: #1f1f1f; }
.bu-sum .bad { color: #b42318; }
.bu-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.bu-table th { text-align: left; font-weight: 500; color: #8a8a8a; padding: 6px 8px; border-bottom: 1px solid #efefef; }
.bu-table td { padding: 7px 8px; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
.bu-table td.t { color: #4a4a4a; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bu-stars { color: #4a4a4a; letter-spacing: 1px; font-size: 10.5px; white-space: nowrap; }
.bu-stars i { color: #dedede; font-style: normal; }
.bu-more { color: #9a9a9a; font-size: 12px; padding: 6px 8px; }
.bu-errs { margin: 8px 0 0; padding: 8px 12px; border-radius: 8px; background: #fdf6f6; color: #8c2a1f; font-size: 12px; line-height: 18px; max-height: 110px; overflow: auto; }
.bu-opts { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; margin-top: 16px; padding-top: 14px; border-top: 1px solid #f1f1f1; }
.bu-opts label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.bu-opts select { border: 1px solid #e3e3e3; border-radius: 8px; padding: 5px 8px; font: inherit; background: #fff; }
`;

export function BulkUpload({ modalId = "bulk-modal" }: { modalId?: string }) {
  const fetcher = useFetcher<any>();
  const shopify = useAppBridge();
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [over, setOver] = useState(false);
  const [status, setStatus] = useState("published");
  const [verified, setVerified] = useState(true);
  const [spread, setSpread] = useState(true);
  const busy = fetcher.state !== "idle";

  const parsed = useMemo(() => (raw.trim() ? parseBulkReviews(raw) : { items: [], errors: [] }), [raw]);
  const photos = parsed.items.reduce((n, i) => n + i.images.length + (i.avatar ? 1 : 0), 0);

  const readFile = (f?: File | null) => {
    if (!f) return;
    setFileName(f.name);
    f.text().then(setRaw);
  };

  useEffect(() => {
    const d = fetcher.data;
    if (!d?.message) return;
    shopify.toast.show(d.message, { isError: d.ok === false, duration: 6000 });
    if (d.ok) {
      setRaw("");
      setFileName("");
      (document.getElementById(modalId) as any)?.hideOverlay?.();
    }
  }, [fetcher.data, shopify, modalId]);

  const submit = () =>
    fetcher.submit(
      {
        intent: "bulk-import",
        payload: JSON.stringify(parsed.items),
        status,
        verified: String(verified),
        spreadDays: spread ? "60" : "0",
      },
      { method: "POST" },
    );

  return (
    <s-modal id={modalId} heading="Bulk upload reviews" size="large">
      <style>{CSS}</style>
      <div className="bu">
        <label
          className={`bu-drop${over ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); readFile(e.dataTransfer.files?.[0]); }}
        >
          <b>{fileName || "Choose a .json or .txt file"}</b>
          <span>{fileName ? "Click to pick another file" : "or drop it here"}</span>
          <input type="file" accept=".json,.txt,.csv,.tsv,application/json,text/plain" onChange={(e) => readFile(e.currentTarget.files?.[0])} />
        </label>

        <div className="bu-or">…or paste the text / JSON</div>
        <textarea
          className="bu-text"
          value={raw}
          placeholder={"Rahul | Pune | 5 | Fabric quality is great | 12/09/2026"}
          onChange={(e) => { setRaw(e.currentTarget.value); setFileName(""); }}
        />
        <div className="bu-help">
          <b>Text:</b> one review per line — <code>Name | City | Rating | Review | Date | Photo URLs</code> (date and photos optional).{" "}
          <b>JSON:</b> a list of <code>{"{ name, city, rating, text, date, photos, avatar, helpful }"}</code>.{" "}
          Samples: <a href={dl(SAMPLE_TXT, "text/plain")} download="reviews-sample.txt">.txt</a> ·{" "}
          <a href={dl(SAMPLE_JSON, "application/json")} download="reviews-sample.json">.json</a>
        </div>

        {(parsed.items.length > 0 || parsed.errors.length > 0) && (
          <>
            <div className="bu-sum">
              <b>{parsed.items.length} review{parsed.items.length === 1 ? "" : "s"} ready</b>
              {photos > 0 && <span>{photos} photo{photos === 1 ? "" : "s"} to fetch</span>}
              {parsed.errors.length > 0 && <span className="bad">{parsed.errors.length} skipped</span>}
              {parsed.items.length > 200 && <span className="bad">Only the first 200 are imported per upload</span>}
            </div>
            {parsed.items.length > 0 && (
              <table className="bu-table">
                <thead>
                  <tr><th>Name</th><th>City</th><th>Rating</th><th>Review</th><th>Date</th><th>Photos</th></tr>
                </thead>
                <tbody>
                  {parsed.items.slice(0, 6).map((it, i) => (
                    <tr key={i}>
                      <td>{it.author}</td>
                      <td>{it.location || "—"}</td>
                      <td className="bu-stars">{"★".repeat(it.rating)}<i>{"★".repeat(5 - it.rating)}</i></td>
                      <td className="t">{it.body}</td>
                      <td>{it.date ? new Date(it.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : spread ? "random" : "today"}</td>
                      <td>{it.images.length || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {parsed.items.length > 6 && <div className="bu-more">+ {parsed.items.length - 6} more</div>}
            {parsed.errors.length > 0 && (
              <div className="bu-errs">{parsed.errors.slice(0, 30).map((e, i) => <div key={i}>{e}</div>)}</div>
            )}
          </>
        )}

        <div className="bu-opts">
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
              <option value="published">Published</option>
              <option value="pending">Pending</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <label><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.currentTarget.checked)} /> Verified buyer</label>
          <label><input type="checkbox" checked={spread} onChange={(e) => setSpread(e.currentTarget.checked)} /> No date → random date in the last 60 days</label>
        </div>
      </div>

      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!parsed.items.length || busy}
        onClick={submit}
        {...(busy ? { loading: true } : {})}
      >
        {busy ? "Importing…" : `Import ${Math.min(200, parsed.items.length) || ""} review${parsed.items.length === 1 ? "" : "s"}`}
      </s-button>
      <s-button slot="secondary-actions" commandFor={modalId} command="--hide">Cancel</s-button>
    </s-modal>
  );
}
