"use client";

import Script from "next/script";

import { redactAnalyticsUrl } from "@/lib/analytics/redact-url";

/**
 * Umami analytics, wired so it cannot leak meeting codes or usernames.
 *
 * Renders nothing unless both `NEXT_PUBLIC_UMAMI_WEBSITE_ID` and
 * `NEXT_PUBLIC_UMAMI_SRC` are set, so local development and forks send no data
 * without anyone opting in.
 *
 * The tracker handles client-side navigation on its own — it watches for path
 * changes — so no route-change effect is needed on top of it.
 */

/**
 * Name of the global the tracker looks up for `data-before-send`.
 *
 * The attribute takes a function *name*, not a function, so the handler has to be
 * reachable on `window` under exactly this string.
 */
const BEFORE_SEND_HANDLER = "meshasecUmamiBeforeSend";

/** The subset of the Umami payload this app rewrites. */
interface UmamiPayload {
  url?: string;
  referrer?: string;
  [key: string]: unknown;
}

type BeforeSendHandler = (
  type: string,
  payload: UmamiPayload,
) => UmamiPayload | false;

/**
 * Publishes the handler under the name the tracker will look for.
 *
 * A cast rather than a `declare global` augmentation of `Window`: the global has
 * a computed key, and augmenting `Window` from inside a `"use client"` module
 * confuses the RSC bundler into omitting this component from the client manifest.
 */
function installBeforeSend(): void {
  if (typeof window === "undefined") {
    return;
  }

  (window as unknown as Record<string, BeforeSendHandler>)[
    BEFORE_SEND_HANDLER
  ] = beforeSend;
}

/**
 * Last stop before anything leaves the browser.
 *
 * Returning a payload continues the send; returning a false-y value cancels it.
 */
function beforeSend(_type: string, payload: UmamiPayload): UmamiPayload {
  return {
    ...payload,
    ...(typeof payload.url === "string"
      ? { url: redactAnalyticsUrl(payload.url) }
      : {}),
    ...(typeof payload.referrer === "string"
      ? { referrer: redactAnalyticsUrl(payload.referrer) }
      : {}),
  };
}

/** Hostname the tracker is allowed to run on, or undefined to allow any. */
function allowedHostname(): string | undefined {
  const configured = process.env.NEXT_PUBLIC_UMAMI_DOMAINS?.trim();

  if (configured !== undefined && configured.length > 0) {
    return configured;
  }

  // Falls back to the app's own public origin, which keeps Vercel preview
  // deployments — a different hostname — out of the production numbers.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (appUrl === undefined || appUrl.length === 0) {
    return undefined;
  }

  try {
    return new URL(
      /^https?:\/\//i.test(appUrl) ? appUrl : `https://${appUrl}`,
    ).hostname;
  } catch {
    return undefined;
  }
}

export function UmamiAnalytics() {
  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  const src = process.env.NEXT_PUBLIC_UMAMI_SRC;

  if (
    websiteId === undefined ||
    websiteId.length === 0 ||
    src === undefined ||
    src.length === 0
  ) {
    return null;
  }

  // Installed during render rather than in an effect. The tracker resolves
  // `data-before-send` by name the moment it initialises, and an
  // `afterInteractive` script can run before effects have flushed — so an effect
  // would risk the first pageview being sent unredacted. Idempotent, so
  // repeating it on re-render is harmless.
  installBeforeSend();

  return (
    <Script
      src={src}
      // Not `beforeInteractive`: analytics must never sit on the critical path of
      // a page whose job is to join a video call.
      strategy="afterInteractive"
      data-website-id={websiteId}
      data-before-send={BEFORE_SEND_HANDLER}
      // Belt and braces alongside the redaction above, which already drops both.
      data-exclude-search="true"
      data-exclude-hash="true"
      // This app sells itself on privacy, so honouring the browser signal is the
      // consistent choice even though it costs some coverage.
      data-do-not-track="true"
      {...(allowedHostname() === undefined
        ? {}
        : { "data-domains": allowedHostname() })}
    />
  );
}
