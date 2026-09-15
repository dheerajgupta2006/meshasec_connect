import "server-only";

/**
 * Constant-time room passcode comparison.
 *
 * Separate from `passcode.ts` because `node:crypto` cannot be bundled into a
 * client component, and the lobby needs the normalisation helpers from that
 * module. Verification only ever happens on the server, so the split costs
 * nothing.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Compares a submitted passcode against the stored one without leaking how much
 * of it matched.
 *
 * `timingSafeEqual` throws on differing buffer lengths, so length is checked
 * first. That check leaks nothing here: every valid passcode is exactly six
 * digits, so a length mismatch already means "not a passcode" rather than "wrong
 * passcode".
 *
 * Timing is the lesser threat for a six-digit secret. Brute force is the real
 * one, and that is bounded by the attempt limit in `authorizeMeetingJoin`.
 */
export function passcodeMatches(
  expected: string | null,
  submitted: string | null,
): boolean {
  if (expected === null || submitted === null) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const submittedBuffer = Buffer.from(submitted, "utf8");

  if (expectedBuffer.length !== submittedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, submittedBuffer);
}
