import "server-only";

/**
 * Guest sessions: letting someone without an account stay in a room after they
 * have proved they know the passcode.
 *
 * A guest has no `User` row, so there is nothing to attach a session to. Instead
 * the server issues a short-lived HMAC-signed token naming exactly one meeting.
 * That token is the guest's only credential, which is why it is deliberately
 * narrow: it is scoped to a single room, it expires, and it grants nothing beyond
 * being admitted to that room.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Lifetime of a guest session.
 *
 * Matched to the LiveKit token TTL: once no media token can be minted, staying
 * "signed in" as a guest is meaningless.
 */
const TTL_MS = 12 * 60 * 60 * 1000;

/** Cookie name. Prefixed so it cannot collide with Clerk's own cookies. */
export const GUEST_COOKIE_NAME = "meshasec_guest";

const MAX_NAME_CHARS = 60;

export interface GuestSession {
  /** Random per-guest id. Becomes the LiveKit identity, prefixed with `guest_`. */
  guestId: string;
  /** The single meeting this session admits. */
  meetingCode: string;
  displayName: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** LiveKit identity for a guest. The prefix is what distinguishes them from a Clerk id. */
export function guestIdentity(guestId: string): string {
  return `guest_${guestId}`;
}

/** True when a LiveKit identity belongs to a guest rather than an account. */
export function isGuestIdentity(identity: string): boolean {
  return identity.startsWith("guest_");
}

/** Extracts the guest id from an identity, or null when it is not a guest. */
export function guestIdFromIdentity(identity: string): string | null {
  return isGuestIdentity(identity) ? identity.slice("guest_".length) : null;
}

function secret(): string | null {
  const value = process.env.GUEST_SESSION_SECRET;

  return value === undefined || value.length < 32 ? null : value;
}

/** True when guest access can work at all. */
export function guestSessionsConfigured(): boolean {
  return secret() !== null;
}

/** Trims a submitted display name to something safe to show to other people. */
export function normalizeGuestName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "Guest";
  }

  // Control characters are stripped rather than escaped: this ends up in a
  // LiveKit participant name that every other client renders.
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME_CHARS);

  return cleaned.length === 0 ? "Guest" : cleaned;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * Issues a signed token for one meeting.
 *
 * The caller must already have verified the passcode — this function does not
 * check anything, it only attests to a decision already made.
 */
export function issueGuestToken(
  meetingCode: string,
  displayName: string,
): { token: string; session: GuestSession } | null {
  const key = secret();

  if (key === null) {
    return null;
  }

  const session: GuestSession = {
    guestId: randomBytes(12).toString("base64url"),
    meetingCode,
    displayName: normalizeGuestName(displayName),
    expiresAt: Date.now() + TTL_MS,
  };

  const payload = Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url",
  );

  return { token: `${payload}.${sign(payload, key)}`, session };
}

/**
 * Verifies a token and returns the session it attests to.
 *
 * Returns null for anything not currently valid: bad signature, expired, wrong
 * shape. The signature is compared in constant time, and length is checked first
 * because `timingSafeEqual` throws on a mismatch.
 */
export function readGuestToken(token: string | undefined): GuestSession | null {
  const key = secret();

  if (key === null || token === undefined) {
    return null;
  }

  const separator = token.lastIndexOf(".");

  if (separator <= 0) {
    return null;
  }

  const payload = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = sign(payload, key);

  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  if (
    typeof record.guestId !== "string" ||
    typeof record.meetingCode !== "string" ||
    typeof record.displayName !== "string" ||
    typeof record.expiresAt !== "number"
  ) {
    return null;
  }

  if (Date.now() >= record.expiresAt) {
    return null;
  }

  return {
    guestId: record.guestId,
    meetingCode: record.meetingCode,
    displayName: record.displayName,
    expiresAt: record.expiresAt,
  };
}

/**
 * Reads a session and confirms it is for this meeting.
 *
 * The meeting check is the important half: a token for one room must never admit
 * its holder to another.
 */
export function readGuestSessionFor(
  token: string | undefined,
  meetingCode: string,
): GuestSession | null {
  const session = readGuestToken(token);

  if (session === null || session.meetingCode !== meetingCode) {
    return null;
  }

  return session;
}

/** Cookie options. `httpOnly` so page scripts cannot read or forge the token. */
export function guestCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Off in development so the cookie works over plain http on localhost.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(TTL_MS / 1000),
  };
}
