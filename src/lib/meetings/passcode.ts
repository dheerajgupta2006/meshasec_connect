/**
 * Room passcode normalisation and formatting.
 *
 * Deliberately free of `node:crypto` so it can be imported by client components —
 * the lobby input and the invite modal both need it. The constant-time comparison
 * lives in `passcode-verify.ts`, which is server-only for exactly that reason.
 *
 * Everything here is pure.
 */

import { ROOM_PASSCODE_DIGITS } from "@/lib/meetings/types";

/** Bound on what will even be considered, before any comparison happens. */
const MAX_SUBMITTED_LENGTH = 32;

/**
 * Reduces whatever the user typed to a comparable passcode.
 *
 * Spaces and dashes are stripped because people paste `839 201` and `839-201`
 * from a chat message. Returns null when the result is not exactly the required
 * number of digits, which is the single place that judgement lives.
 */
export function normalizePasscode(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  if (raw.length > MAX_SUBMITTED_LENGTH) {
    return null;
  }

  const digits = raw.replace(/[\s-]/g, "");

  if (digits.length !== ROOM_PASSCODE_DIGITS) {
    return null;
  }

  return /^\d+$/.test(digits) ? digits : null;
}

/** Formats for display: `839201` reads better as `839 201`. */
export function formatPasscodeForDisplay(passcode: string): string {
  if (passcode.length !== ROOM_PASSCODE_DIGITS) {
    return passcode;
  }

  return `${passcode.slice(0, 3)} ${passcode.slice(3)}`;
}
