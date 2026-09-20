/**
 * Parsing for the "join by code" inputs.
 *
 * Lifted out of `components/dashboard/join-by-code.tsx` because the landing page
 * now offers the same affordance in its hero. Two copies of this parser would
 * drift, and the failure mode of drift is a guest who can paste an invite link
 * on one screen but not the other.
 *
 * Deliberately pure and free of React so it can be unit tested and imported from
 * both a Server and a Client Component.
 */

/**
 * The Meeting_Code alphabet: unpadded base64url, mirrored from the server's
 * generator contract. Used only to reject obvious junk before navigating; the
 * lobby route remains the authority on whether a meeting exists.
 */
export const MEETING_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Route segments that follow the code in an invite URL. */
const TRAILING_ROUTE_SEGMENTS = new Set(["lobby", "room"]);

export const JOIN_CODE_EMPTY_MESSAGE =
  "Enter a meeting code or paste an invite link.";

export const JOIN_CODE_SHAPE_MESSAGE =
  "That does not look like a meeting code. Check the link and try again.";

/** `decodeURIComponent` throws on malformed input, so the raw value stands in. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Accepts either a bare code or a pasted invite URL.
 *
 * An invite link is `https://host/meeting/<code>/lobby`, so the last path
 * segment is the route, not the code. The code is taken from just after the
 * `meeting` segment when one is present, and only otherwise from the final
 * segment — which is what makes both a pasted link and a hand-typed code work.
 */
export function extractMeetingCode(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return "";
  }

  // Drop any query string or fragment before looking at path segments.
  const pathOnly = trimmed.split(/[?#]/)[0] ?? "";
  const segments = pathOnly
    .split("/")
    .map((segment) => safeDecode(segment.trim()))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return "";
  }

  const meetingIndex = segments.lastIndexOf("meeting");

  if (meetingIndex !== -1) {
    const afterMeeting: string | undefined = segments[meetingIndex + 1];

    if (afterMeeting !== undefined) {
      return afterMeeting;
    }
  }

  const last: string | undefined = segments[segments.length - 1];

  if (last === undefined) {
    return "";
  }

  // A URL that ends in a known route segment still carries the code before it.
  if (TRAILING_ROUTE_SEGMENTS.has(last.toLowerCase()) && segments.length > 1) {
    return segments[segments.length - 2] ?? "";
  }

  return last;
}

/**
 * The lobby path a parsed code resolves to, or a message explaining why it did
 * not resolve. Both callers navigate to exactly this, so the route shape is
 * stated once.
 */
export type JoinCodeResult =
  | { ok: true; href: string; code: string }
  | { ok: false; message: string };

export function resolveJoinCode(raw: string): JoinCodeResult {
  const code = extractMeetingCode(raw);

  if (code.length === 0) {
    return { ok: false, message: JOIN_CODE_EMPTY_MESSAGE };
  }
  if (!MEETING_CODE_PATTERN.test(code)) {
    return { ok: false, message: JOIN_CODE_SHAPE_MESSAGE };
  }

  return {
    ok: true,
    code,
    href: `/meeting/${encodeURIComponent(code)}/lobby`,
  };
}
