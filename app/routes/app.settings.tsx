import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureSettingsDefinition, getSettings, saveSettings } from "../lib/settings.server";
import { getModeration, saveModeration } from "../lib/moderation.server";
import { repairWidget, widgetStatus } from "../lib/theme-repair.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await ensureSettingsDefinition(admin);
  const [s, mod, widget] = await Promise.all([
    getSettings(admin),
    getModeration(admin),
    widgetStatus(admin).catch((e: any) => ({ theme: "", found: false, missing: [] as string[], error: String(e?.message || e) })),
  ]);
  return { google_login: s.google_login, google_client_id: s.google_client_id, shop: session.shop, mod, widget };
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
  if (fd.get("intent") === "moderation") {
    try {
      await saveModeration(admin, session.shop, {
        buyers_only: fd.get("buyers_only") === "on",
        auto_publish: fd.get("auto_publish") === "on",
        extra_words: String(fd.get("extra_words") || "").split(/[\n,]+/),
      });
      return { ok: true, message: "Moderation saved" };
    } catch (e: any) {
      return { ok: false, message: e?.message || "Could not save" };
    }
  }
  const clientId = String(fd.get("google_client_id") || "").trim();
  const on = fd.get("google_login") === "on";
  if (on && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return { ok: false, message: "Paste the Client ID from Google Cloud (it ends with .apps.googleusercontent.com)." };
  }
  try {
    const saved = await saveSettings(admin, { google_login: on, google_client_id: clientId });
    return { ok: true, message: saved.google_login ? "Saved. Google sign-in is on." : "Saved." };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Could not save" };
  }
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const modFetcher = useFetcher<typeof action>();
  const fixFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const w: any = data.widget;
  useEffect(() => {
    if (fixFetcher.data?.message) shopify.toast.show(fixFetcher.data.message, { isError: !fixFetcher.data.ok });
  }, [fixFetcher.data, shopify]);
  const [on, setOn] = useState(data.google_login);
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
        <s-section heading="Sign in with Google">
          <s-stack gap="base">
            <s-paragraph>
              Lets shoppers post reviews, comments and helpful votes with one tap using their Google account. Their Shopify
              customer (same email) is found or created, so orders still count for “Verified buyer”.
            </s-paragraph>
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
              details="Public ID, not a password. Create it once in Google Cloud (steps on the right)."
            />
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>Save</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </fetcher.Form>

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
