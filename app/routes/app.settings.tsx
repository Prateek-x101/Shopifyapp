import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureSettingsDefinition, getSettings, saveSettings } from "../lib/settings.server";
import { getModeration, saveModeration, unblockUser } from "../lib/moderation.server";
import { repairWidget, widgetStatus } from "../lib/theme-repair.server";
import { recomputeAllSummaries } from "../lib/reviews.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await ensureSettingsDefinition(admin);
  const [s, mod, widget] = await Promise.all([
    getSettings(admin),
    getModeration(admin),
    widgetStatus(admin).catch((e: any) => ({ theme: "", found: false, missing: [] as string[], error: String(e?.message || e) })),
  ]);
  return {
    google_login: s.google_login, google_client_id: s.google_client_id, login_mode: s.login_mode, shop: session.shop, mod, widget,
    banner: { mode: s.banner_mode, max: s.banner_max, min: s.banner_min_rating, shuffle: s.banner_shuffle },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();
  if (fd.get("intent") === "repair-widget") {
    try {
      const r = await repairWidget(admin);
      if (!r.done.length && !r.failed.length) return { ok: true, message: "The widget is already up to date" };
      if (r.failed.length) return { ok: false, message: `Could not apply: ${r.failed.join(", ")}` };
      return { ok: true, message: `Widget repaired in "${r.theme}" (${r.done.length} fix${r.done.length === 1 ? "" : "es"})` };
    } catch (e: any) {
      return { ok: false, message: e?.message || "Could not update the theme" };
    }
  }
  if (fd.get("intent") === "banner") {
    try {
      await saveSettings(admin, {
        banner_mode: fd.get("banner_mode") === "selected" ? "selected" : "auto",
        banner_max: parseInt(String(fd.get("banner_max") || "10"), 10),
        banner_min_rating: parseInt(String(fd.get("banner_min_rating") || "4"), 10),
        banner_shuffle: fd.get("banner_shuffle") === "on",
      });
      const n = await recomputeAllSummaries(admin, session.shop);
      return { ok: true, message: `Banner saved and rebuilt on ${n} product${n === 1 ? "" : "s"}` };
    } catch (e: any) {
      return { ok: false, message: e?.message || "Could not save" };
    }
  }
  if (fd.get("intent") === "unblock") {
    try {
      await unblockUser(admin, session.shop, String(fd.get("id") || ""));
      return { ok: true, message: "Unblocked" };
    } catch (e: any) {
      return { ok: false, message: e?.message || "Could not unblock" };
    }
  }
  if (fd.get("intent") === "moderation") {
    try {
      await saveModeration(admin, session.shop, {
        buyers_only: fd.get("buyers_only") === "on",
        auto_publish: fd.get("auto_publish") === "on",
        spam_filter: fd.get("spam_filter") === "on",
        auto_block: parseInt(String(fd.get("auto_block") || "0"), 10) || 0,
        max_comments_per_hour: parseInt(String(fd.get("max_comments_per_hour") || "0"), 10) || 0,
        max_reviews_per_day: parseInt(String(fd.get("max_reviews_per_day") || "0"), 10) || 0,
        extra_words: String(fd.get("extra_words") || "").split(/[\n,]+/),
      });
      return { ok: true, message: "Moderation saved" };
    } catch (e: any) {
      return { ok: false, message: e?.message || "Could not save" };
    }
  }
  const clientId = String(fd.get("google_client_id") || "").trim();
  const mode = fd.get("login_mode") === "widget" ? "widget" : "shopify";
  const on = mode === "widget" && fd.get("google_login") === "on";
  if (on && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return { ok: false, message: "Paste the Client ID from Google Cloud (it ends with .apps.googleusercontent.com)." };
  }
  try {
    await saveSettings(admin, { google_login: on, google_client_id: clientId, login_mode: mode });
    return {
      ok: true,
      message: mode === "shopify" ? "Saved. The widget uses your store's sign-in (with Google)." : on ? "Saved. Widget-only Google sign-in is on." : "Saved.",
    };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Could not save" };
  }
};

function UnblockRow({ b }: { b: { id: string; name: string; at: string; reason: string } }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);
  return (
    <s-box padding="small-200" border="base" borderRadius="base">
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack gap="none">
          <s-text type="strong">{b.name || "Customer"}</s-text>
          <s-text color="subdued">
            {b.reason} · {new Date(b.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · customer #{b.id}
          </s-text>
        </s-stack>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="unblock" />
          <input type="hidden" name="id" value={b.id} />
          <s-button type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Unblock</s-button>
        </fetcher.Form>
      </s-stack>
    </s-box>
  );
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const modFetcher = useFetcher<typeof action>();
  const fixFetcher = useFetcher<typeof action>();
  const bannerFetcher = useFetcher<typeof action>();
  const [bMode, setBMode] = useState<string>(data.banner.mode);
  const shopify = useAppBridge();
  const w: any = data.widget;
  useEffect(() => {
    if (bannerFetcher.data?.message) shopify.toast.show(bannerFetcher.data.message, { isError: !bannerFetcher.data.ok });
  }, [bannerFetcher.data, shopify]);
  useEffect(() => {
    if (fixFetcher.data?.message) shopify.toast.show(fixFetcher.data.message, { isError: !fixFetcher.data.ok });
  }, [fixFetcher.data, shopify]);
  const [on, setOn] = useState(data.google_login);
  const [mode, setMode] = useState<string>(data.login_mode);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);
  useEffect(() => {
    if (modFetcher.data?.message) shopify.toast.show(modFetcher.data.message, { isError: !modFetcher.data.ok });
  }, [modFetcher.data, shopify]);

  return (
    <s-page heading="Settings">
      <fetcher.Form method="post">
        <s-section heading="Customer login">
          <s-stack gap="base">
            <input type="hidden" name="login_mode" value={mode} />
            <s-choice-list label="How shoppers log in from the review widget" name="login_mode_choice" values={[mode]} onChange={(e: any) => setMode(e.currentTarget.values?.[0] || "shopify")}>
              <s-choice value="shopify">
                Store account (recommended)
                <s-text slot="details">
                  The widget's log-in sheet opens your store's own sign-in — with “Continue with Google” (Settings → Customer accounts →
                  Google). One login for reviews, orders and checkout; the shopper comes back to the same review.
                </s-text>
              </s-choice>
              <s-choice value="widget">
                Widget only
                <s-text slot="details">
                  The widget signs shoppers in with Google by itself (needs the Client ID below). They are not logged in to the store
                  account or checkout.
                </s-text>
              </s-choice>
            </s-choice-list>
            {mode === "widget" && (
              <>
                <s-checkbox
                  name="google_login"
                  label="Show “Continue with Google” in the review widget"
                  checked={on}
                  onChange={(e: any) => setOn(!!e.currentTarget.checked)}
                />
                <s-text-field
                  label="Google Client ID"
                  name="google_client_id"
                  defaultValue={data.google_client_id}
                  placeholder="1234567890-abc123.apps.googleusercontent.com"
                  details="Public ID, not a password."
                />
              </>
            )}
            {mode === "shopify" && <input type="hidden" name="google_client_id" value={data.google_client_id} />}
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>Save</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </fetcher.Form>

      <bannerFetcher.Form method="post">
        <input type="hidden" name="intent" value="banner" />
        <input type="hidden" name="banner_mode" value={bMode} />
        <s-section heading="Review banner (“What our customers say”)">
          <s-stack gap="base">
            <s-choice-list label="Which reviews" name="banner_mode_choice" values={[bMode]} onChange={(e: any) => setBMode(e.currentTarget.values?.[0] || "auto")}>
              <s-choice value="auto">
                Chosen + pinned, then the best of the rest (recommended)
                <s-text slot="details">Reviews you mark “Show in banner” and pinned ones come first; the banner is filled up with other reviews of the minimum stars below. No two cards with the same text or name.</s-text>
              </s-choice>
              <s-choice value="selected">
                Only the reviews I choose
                <s-text slot="details">Only “Show in banner” and pinned reviews (Reviews → select → Show in banner). With none chosen, it works like the option above.</s-text>
              </s-choice>
            </s-choice-list>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field label="Most cards in the banner" name="banner_max" min={1} max={30} step={1} defaultValue={String(data.banner.max)} />
              <s-select label="Minimum stars (filled-up reviews)" name="banner_min_rating" value={String(data.banner.min)}>
                <s-option value="5">5 stars only</s-option>
                <s-option value="4">4 stars and up</s-option>
                <s-option value="3">3 stars and up</s-option>
              </s-select>
            </s-grid>
            <s-checkbox name="banner_shuffle" label="Random order on every visit" defaultChecked={data.banner.shuffle} />
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" {...(bannerFetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </bannerFetcher.Form>

      <s-section heading="Storefront widget">
        <s-stack gap="base">
          {w.error ? (
            <s-banner tone="warning">Could not read the theme: {w.error}</s-banner>
          ) : !w.found ? (
            <s-paragraph>The review widget file (assets/review-widget.js) is not in the published theme “{w.theme}”.</s-paragraph>
          ) : w.missing.length ? (
            <s-banner tone="critical" heading="The review widget in your live theme needs a fix">
              <s-unordered-list>
                {w.missing.map((m: string) => <s-list-item key={m}>{m}</s-list-item>)}
              </s-unordered-list>
            </s-banner>
          ) : (
            <s-paragraph>✓ The review widget in “{w.theme}” is up to date.</s-paragraph>
          )}
          <s-paragraph>
            Repair changes only the broken parts of assets/review-widget.js in your published theme; everything else in the file stays as it is.
          </s-paragraph>
          <fixFetcher.Form method="post">
            <input type="hidden" name="intent" value="repair-widget" />
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant={w.missing?.length ? "primary" : "secondary"} {...(fixFetcher.state !== "idle" ? { loading: true } : {})}>
                Repair widget
              </s-button>
            </s-stack>
          </fixFetcher.Form>
        </s-stack>
      </s-section>

      <modFetcher.Form method="post">
        <input type="hidden" name="intent" value="moderation" />
        <s-section heading="Moderation">
          <s-stack gap="base">
            <s-checkbox
              name="buyers_only"
              label="Only customers who bought the product can review it"
              details="The shopper must be logged in (Shopify or Google) with the account that placed an order of that product."
              defaultChecked={data.mod.buyers_only}
            />
            <s-checkbox
              name="auto_publish"
              label="Publish clean reviews right away"
              details="Reviews without abusive words go live at once. Reviews, comments and replies with abusive words always wait in Pending. Turn off to check every review yourself."
              defaultChecked={data.mod.auto_publish}
            />
            <s-checkbox
              name="spam_filter"
              label="Spam filter"
              details="Links, phone numbers, promotions (earn money, WhatsApp me, crypto…), ALL CAPS, emoji floods, the same message again, or many messages at once → the message waits in Pending and counts as a strike."
              defaultChecked={data.mod.spam_filter}
            />
            <s-number-field
              label="Block automatically after this many spam strikes in 24 hours"
              name="auto_block"
              min={0}
              max={20}
              step={1}
              defaultValue={String(data.mod.auto_block)}
              details="0 = never block automatically. Blocked shoppers can't post reviews, comments or replies."
            />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field
                label="Comments & replies per shopper, per hour"
                name="max_comments_per_hour"
                min={0}
                max={200}
                step={1}
                defaultValue={String(data.mod.max_comments_per_hour)}
                details="0 = no limit"
              />
              <s-number-field
                label="Reviews per shopper, per day"
                name="max_reviews_per_day"
                min={0}
                max={50}
                step={1}
                defaultValue={String(data.mod.max_reviews_per_day)}
                details="0 = no limit"
              />
            </s-grid>
            <s-paragraph>Going over a limit shows the shopper a friendly message and counts as a spam strike, so someone who keeps trying gets blocked automatically.</s-paragraph>
            <s-text-area
              label="Extra blocked words"
              name="extra_words"
              rows={3}
              defaultValue={data.mod.extra_words.join(", ")}
              placeholder="word1, word2, word3"
              details="Reviews, comments and replies with abusive words (a built-in English + Hindi/Hinglish list, plus these) wait in Pending until you approve them."
            />
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" {...(modFetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </modFetcher.Form>

      <s-section heading={`Blocked shoppers (${data.mod.blocked.length})`}>
        {data.mod.blocked.length === 0 ? (
          <s-paragraph>Nobody is blocked. Use “Block” on a comment (Comments page or a review’s conversation), or let the spam filter do it.</s-paragraph>
        ) : (
          <s-stack gap="small-200">
            {data.mod.blocked.map((b) => (
              <UnblockRow key={b.id} b={b} />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Get a Google Client ID">
        <s-ordered-list>
          <s-list-item>Open console.cloud.google.com → APIs &amp; Services → Credentials (create a project if asked).</s-list-item>
          <s-list-item>OAuth consent screen: User type External, app name “Vesturewears”, your support email. Publish it.</s-list-item>
          <s-list-item>Create credentials → OAuth client ID → Application type “Web application”.</s-list-item>
          <s-list-item>
            Authorized JavaScript origins: https://www.vesturewears.in and https://vesturewears.in (no redirect URI needed).
          </s-list-item>
          <s-list-item>Copy the Client ID, paste it here, tick the box and Save.</s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Good to know">
        <s-paragraph>
          Shopify only allows outside sign-in to the whole store on Shopify Plus. Google sign-in here works for the review
          widget; for checkout and the account page shoppers still use Shopify’s own login.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
