/**
 * Strips identifying values out of URLs before they are sent to analytics.
 *
 * Umami reports the page URL verbatim, which is fine for a marketing site and
 * actively harmful here. Two routes in this app put secrets in the path:
 *
 * - `/meeting/<code>` and `/meeting/<code>/lobby`. A meeting code is half of the
 *   join credential — paired with the room passcode it admits a guest with no
 *   account at all. Sending it to a third party would put live join codes in an
 *   analytics dashboard and in that provider's database.
 * - `/messages/<username>`. Not a credential, but it discloses who talks to whom.
 *   That is the social graph of a private messaging feature.
 *
 * Replacing the dynamic segment with a placeholder keeps the analytics useful —
 * you still see how many lobby views or thread opens there were — while the value
 * never leaves the browser.
 */

/**
 * Route segment to the placeholder that replaces the value it owns.
 *
 * Keyed by the first path segment. Add a route here the moment it starts carrying
 * an id, a code, or a name in its path.
 */
const REDACTED_SEGMENTS: Record<string, string | undefined> = {
  meeting: "[code]",
  messages: "[username]",
};

/**
 * Redacts a path, dropping any query string and hash.
 *
 * The query goes wholesale rather than being filtered. The only search parameter
 * this app puts in a URL is `redirect_url`, which is handed a meeting lobby path
 * by `GuestGate` and by the middleware's sign-in redirect — so it carries the
 * very code the path redaction exists to remove. Nothing currently depends on
 * query analytics, and an allowlist is easy to add later if campaign tracking is
 * ever wanted.
 */
export function redactAnalyticsPath(input: string): string {
  const path = input.split("?")[0].split("#")[0];

  if (path.length === 0) {
    return "/";
  }

  // A leading slash leaves an empty first element, so the route name sits at
  // index 1 and the value it owns at index 2.
  const segments = path.split("/");
  const placeholder = REDACTED_SEGMENTS[segments[1] ?? ""];

  if (
    placeholder !== undefined &&
    segments.length > 2 &&
    segments[2].length > 0
  ) {
    segments[2] = placeholder;
  }

  return segments.join("/");
}

/**
 * Redacts either a bare path or an absolute URL.
 *
 * Both shapes turn up: Umami sends `url` as a path, and `referrer` as a full URL.
 * The referrer matters just as much — navigating from a lobby into its room makes
 * the lobby URL, meeting code and all, the referrer of the next pageview.
 */
export function redactAnalyticsUrl(input: string): string {
  if (input.length === 0) {
    return input;
  }

  if (!/^https?:\/\//i.test(input)) {
    return redactAnalyticsPath(input);
  }

  try {
    const parsed = new URL(input);

    return `${parsed.origin}${redactAnalyticsPath(parsed.pathname)}`;
  } catch {
    // Unparseable and therefore unredactable. Dropped rather than forwarded: an
    // empty referrer costs one data point, a leaked one cannot be taken back.
    return "";
  }
}
