"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import * as React from "react";

import {
  redactAnalyticsPath,
  redactAnalyticsUrl,
} from "@/lib/analytics/redact-url";

/**
 * Umami analytics, wired so it cannot leak meeting codes or usernames.
 *
 * Renders nothing unless both `NEXT_PUBLIC_UMAMI_WEBSITE_ID` and
 * `NEXT_PUBLIC_UMAMI_SRC` are set, so local development and forks send no data
 * without anyone opting in.
 *
 * Page views are sent explicitly from `usePathname`. Umami normally patches the
 * History API to detect SPA navigation, but that automatic path did not fire
 * reliably in this Next.js App Router application: manual events reached Umami
 * while route changes did not. `data-auto-pageview="false"` disables only Umami's
 * page-view automation; click events, performance collection and `umami.track`
 * remain available.
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

type UmamiTrackInput =
  | string
  | UmamiPayload
  | ((defaults: UmamiPayload) => UmamiPayload);

interface UmamiTracker {
  track(input?: UmamiTrackInput, data?: Record<string, unknown>): Promise<void>;
}

/** Reads the tracker without globally claiming that every page always has it. */
function readTracker(): UmamiTracker | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate = (window as unknown as { umami?: unknown }).umami;

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("track" in candidate) ||
    typeof (candidate as { track?: unknown }).track !== "function"
  ) {
    return null;
  }

  return candidate as UmamiTracker;
}

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
  const pathname = usePathname();
  const [trackerReady, setTrackerReady] = React.useState(false);
  /** Raw path, not redacted path: two different private group ids both redact to
      the same route, but navigating between them is still a real page view. */
  const lastTrackedPathRef = React.useRef<string | null>(null);

  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  const src = process.env.NEXT_PUBLIC_UMAMI_SRC;
  const configured =
    websiteId !== undefined &&
    websiteId.length > 0 &&
    src !== undefined &&
    src.length > 0;

  const handleTrackerReady = React.useCallback(() => {
    setTrackerReady(true);
  }, []);

  React.useEffect(() => {
    if (!configured || !trackerReady) {
      return;
    }

    const tracker = readTracker();

    if (tracker === null || lastTrackedPathRef.current === pathname) {
      return;
    }

    // Mark before invoking. Umami deliberately swallows delivery failures and
    // resolves the call, so retrying here cannot distinguish a failed network
    // request from a delivered one and risks double-counting.
    lastTrackedPathRef.current = pathname;

    const redactedPath = redactAnalyticsPath(pathname);

    // The function form preserves Umami's normal page-view properties (website,
    // hostname, screen, language and referrer) and changes only what this app owns.
    // Passing a string would create a named event — exactly what the manual
    // `umami.track("debug-test")` diagnosis did — not a page view.
    void tracker.track((defaults) => ({
      ...defaults,
      url: redactedPath,
      title: document.title,
    }));
  }, [configured, pathname, trackerReady]);

  if (!configured) {
    return null;
  }

  // Narrowed by `configured`, but TypeScript does not retain the relationship
  // between that boolean and two independent values.
  const trackerSrc = src as string;
  const trackerWebsiteId = websiteId as string;

  // Installed during render rather than in an effect. The tracker resolves
  // `data-before-send` by name the moment it initialises, and an
  // `afterInteractive` script can run before effects have flushed — so an effect
  // would risk the first pageview being sent unredacted. Idempotent, so
  // repeating it on re-render is harmless.
  installBeforeSend();

  return (
    <Script
      src={trackerSrc}
      // Not `beforeInteractive`: analytics must never sit on the critical path of
      // a page whose job is to join a video call.
      strategy="afterInteractive"
      data-website-id={trackerWebsiteId}
      data-before-send={BEFORE_SEND_HANDLER}
      // The App Router is the source of truth for navigation. Leaving Umami's
      // History API patch enabled as well would count every successful route
      // change twice once explicit tracking above works.
      data-auto-pageview="false"
      onLoad={handleTrackerReady}
      onReady={handleTrackerReady}
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
