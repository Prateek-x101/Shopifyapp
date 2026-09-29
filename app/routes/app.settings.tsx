import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureSettingsDefinition, getSettings, saveSettings } from "../lib/settings.server";
import { getModeration, saveModeration } from "../lib/moderation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await ensureSettingsDefinition(admin);
  const [s, mod] = await Promise.all([getSettings(admin), getModeration(admin)]);
  return { google_login: s.google_login, google_client_id: s.google_client_id, shop: session.shop, mod };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();
  if (fd.get("intent") === "moderation") {
    try {
      await saveModeration(admin, session.shop, {
        buyers_only: fd.get("buyers_only") === "on",
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
  const shopify = useAppBridge();
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
            <s-text-area
              label="Extra blocked words"
              name="extra_words"
              rows={3}
              defaultValue={data.mod.extra_words.join(", ")}
              placeholder="word1, word2, word3"
              details="Comments and replies with abusive words (a built-in English + Hindi/Hinglish list, plus these) wait in Pending until you approve them."
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
