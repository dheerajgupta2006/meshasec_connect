import "server-only";

/**
 * Meeting_Code generation.
 *
 * Server-only: the code is a bearer-ish room identifier and must never be
 * produced by, or predictable from, anything the browser runs.
 */

import { randomBytes } from "node:crypto";

import { MEETING_CODE_CHARS } from "@/lib/meetings/types";

/** Req 7.1: 128 bits drawn from the OS CSPRNG. */
const MEETING_CODE_BYTES = 16;

/**
 * Req 7.2: the unpadded base64url alphabet. Anchored, so a single stray `=` or
 * `+` fails the check.
 */
const MEETING_CODE_ALPHABET_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Returns a fresh Meeting_Code: 16 bytes from `node:crypto` `randomBytes`,
 * base64url-encoded to exactly 22 URL-safe characters.
 *
 * Base64 of 16 bytes is 22 significant characters plus two padding characters.
 * Node's `base64url` encoding emits those 22 characters with `-`/`_`
 * substituted and the padding omitted, which is Req 7.2 exactly — no custom
 * encoder, no alphabet table, and no modulo bias, because no value is ever
 * reduced into a smaller range.
 */
export function generateMeetingCode(): string {
  const meetingCode = randomBytes(MEETING_CODE_BYTES).toString("base64url");
  assertEncodingContract(meetingCode);
  return meetingCode;
}

/**
 * Development-only guard. It exists so a future change to the byte count or the
 * encoding cannot silently break the length-and-alphabet contract that the
 * lobby URL, the unique index, and Req 7.2 all depend on. Skipped in production
 * so the hot path stays two operations.
 */
function assertEncodingContract(meetingCode: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  if (meetingCode.length !== MEETING_CODE_CHARS) {
    throw new Error(
      `generateMeetingCode produced ${String(meetingCode.length)} characters; the contract is ${String(MEETING_CODE_CHARS)}.`,
    );
  }
  if (!MEETING_CODE_ALPHABET_PATTERN.test(meetingCode)) {
    throw new Error(
      "generateMeetingCode produced characters outside the A-Za-z0-9-_ alphabet.",
    );
  }
}
