import {
  countCodePoints,
  hasDisallowedCharacters,
} from "@/lib/meetings/validation";

/**
 * Maximum user-chosen code points in a meeting-scoped display name.
 *
 * Counted as Unicode code points rather than UTF-16 units, so an emoji consumes
 * one character instead of two. The final LiveKit name may be longer because it
 * can append a verified `@username` or the `(guest)` marker.
 */
export const MEETING_DISPLAY_NAME_MAX_CODE_POINTS = 60;

export type MeetingDisplayNameResult =
  | { ok: true; name: string }
  | { ok: false; message: string };

/**
 * Validates the alias somebody wants to use for one meeting.
 *
 * Server-side use is authoritative; the lobby calls the same helper only for
 * immediate feedback. `fallback` preserves compatibility with callers that do
 * not send the new field yet, while a field that is present but malformed is
 * rejected rather than silently replaced.
 */
export function validateMeetingDisplayName(
  raw: unknown,
  fallback: string,
): MeetingDisplayNameResult {
  const candidate = raw === undefined ? fallback : raw;

  if (typeof candidate !== "string") {
    return { ok: false, message: "Display name must be text." };
  }

  const name = candidate.trim();

  if (name.length === 0) {
    return { ok: false, message: "Enter a display name." };
  }

  if (hasDisallowedCharacters(name)) {
    return {
      ok: false,
      message: "Remove hidden or control characters from the display name.",
    };
  }

  if (countCodePoints(name) > MEETING_DISPLAY_NAME_MAX_CODE_POINTS) {
    return {
      ok: false,
      message: `Use ${String(MEETING_DISPLAY_NAME_MAX_CODE_POINTS)} characters or fewer for the display name.`,
    };
  }

  return { ok: true, name };
}

/**
 * Keeps a signed-in alias visibly tied to the verified account behind it.
 *
 * An arbitrary name by itself recreates the impersonation bug the token route
 * previously avoided by ignoring the lobby field. The stable handle makes the
 * alias useful while retaining attribution on every LiveKit surface.
 */
export function attributedAccountDisplayName(
  alias: string,
  accountName: string,
  username: string,
): string {
  return alias === accountName ? accountName : `${alias} (@${username})`;
}
