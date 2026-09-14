/**
 * URL detection inside message bodies.
 *
 * Pure and isomorphic: the client uses it to render clickable links, the server
 * uses it to decide which URL to fetch a preview for. Both must agree, otherwise
 * a message shows a card for a link the text does not highlight.
 */

/**
 * Only absolute http(s) URLs are recognised.
 *
 * Bare hosts like `example.com` are deliberately not matched: the false-positive
 * rate on ordinary prose ("v2.0", "e.g.") is high, and every match here becomes
 * an outbound fetch on the server.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

/** Bounds the fan-out of outbound preview fetches from a single message. */
export const MAX_PREVIEWS_PER_MESSAGE = 1;

/** Rejects absurd inputs before they reach the network layer. */
export const MAX_URL_LENGTH = 2048;

/**
 * Trailing characters that are almost always sentence punctuation rather than
 * part of the URL. `)` is handled separately because it is legitimate inside
 * many URLs.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"”’\]}>]+$/;

/**
 * Strips trailing punctuation, keeping parentheses balanced.
 *
 * "see https://example.com/a_(b)." must yield ".../a_(b)", so a closing paren is
 * only dropped when the candidate has no matching opener.
 */
function trimTrailingNoise(candidate: string): string {
  let result = candidate;

  // Repeated because punctuation and parens can interleave: "(https://x.com)."
  for (let pass = 0; pass < 5; pass += 1) {
    const before = result;

    result = result.replace(TRAILING_PUNCTUATION, "");

    while (result.endsWith(")")) {
      const opens = (result.match(/\(/g) ?? []).length;
      const closes = (result.match(/\)/g) ?? []).length;

      if (closes <= opens) {
        break;
      }

      result = result.slice(0, -1);
    }

    if (result === before) {
      break;
    }
  }

  return result;
}

/**
 * Normalises for use as a cache key and for comparison.
 *
 * The fragment is dropped because it never reaches the server and so cannot
 * change the response. Returns null when the value is not a usable http(s) URL,
 * which is the single place that judgement is made.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  // A URL with no host ("http:///path") parses but cannot be fetched.
  if (parsed.hostname.length === 0) {
    return null;
  }

  parsed.hash = "";

  const normalized = parsed.toString();

  return normalized.length > MAX_URL_LENGTH ? null : normalized;
}

/** Every distinct http(s) URL in the body, in the order it appears. */
export function extractUrls(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  // `exec` in a loop rather than `matchAll`: this project's tsconfig sets no
  // `target`, so iterating an iterator is rejected under the default ES5 check.
  const pattern = new RegExp(URL_PATTERN.source, "gi");
  let match: RegExpExecArray | null = pattern.exec(body);

  while (match !== null) {
    const normalized = normalizeUrl(trimTrailingNoise(match[0]));

    if (normalized !== null && !seen.has(normalized)) {
      seen.add(normalized);
      found.push(normalized);
    }

    match = pattern.exec(body);
  }

  return found;
}

/** The URL a preview card should be built for, or null when there is none. */
export function previewTarget(body: string): string | null {
  return extractUrls(body)[0] ?? null;
}

export type BodyToken =
  | { kind: "text"; value: string }
  | { kind: "link"; href: string; label: string };

/**
 * Splits a body into plain text and link runs for rendering.
 *
 * Concatenating every token's raw text reproduces the input exactly, which is
 * what stops the renderer from silently dropping or duplicating characters.
 */
export function tokenizeBody(body: string): BodyToken[] {
  const tokens: BodyToken[] = [];
  const pattern = new RegExp(URL_PATTERN.source, "gi");

  let cursor = 0;
  let match: RegExpExecArray | null = pattern.exec(body);

  while (match !== null) {
    const raw = match[0];
    const start = match.index;
    const candidate = trimTrailingNoise(raw);
    const href = normalizeUrl(candidate);

    if (href === null) {
      // Not a usable URL: leave it as text and carry on from after it.
      match = pattern.exec(body);
      continue;
    }

    if (start > cursor) {
      tokens.push({ kind: "text", value: body.slice(cursor, start) });
    }

    tokens.push({ kind: "link", href, label: candidate });
    cursor = start + candidate.length;

    // Punctuation trimmed off the candidate is text, and re-scanning must resume
    // there so it is not lost.
    pattern.lastIndex = cursor;
    match = pattern.exec(body);
  }

  if (cursor < body.length) {
    tokens.push({ kind: "text", value: body.slice(cursor) });
  }

  return tokens;
}
