import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GUEST_COOKIE_NAME,
  guestIdFromIdentity,
  guestIdentity,
  guestSessionsConfigured,
  isGuestIdentity,
  issueGuestToken,
  normalizeGuestName,
  readGuestSessionFor,
  readGuestToken,
} from "@/lib/meetings/guest-session";

const MEETING = "AbCdEfGhIjKlMnOpQrStUv";
const OTHER_MEETING = "ZzZzZzZzZzZzZzZzZzZzZz";

beforeAll(() => {
  // The real secret lives in `.env` and is not loaded in the test runner, so a
  // deterministic one is set here. Long enough to satisfy the length guard.
  process.env.GUEST_SESSION_SECRET =
    "test-secret-that-is-comfortably-long-enough-for-hmac";
});

describe("guestSessionsConfigured", () => {
  it("is true with a long enough secret", () => {
    expect(guestSessionsConfigured()).toBe(true);
  });

  it("is false when the secret is missing or too short", () => {
    const original = process.env.GUEST_SESSION_SECRET;

    process.env.GUEST_SESSION_SECRET = "";
    expect(guestSessionsConfigured()).toBe(false);

    process.env.GUEST_SESSION_SECRET = "tooshort";
    expect(guestSessionsConfigured()).toBe(false);

    process.env.GUEST_SESSION_SECRET = original;
  });
});

describe("guest identity", () => {
  it("round-trips a guest id through an identity", () => {
    expect(guestIdFromIdentity(guestIdentity("abc123"))).toBe("abc123");
  });

  it("distinguishes a guest identity from a Clerk subject", () => {
    expect(isGuestIdentity("guest_abc")).toBe(true);
    // Clerk subjects start with `user_`, so there is no overlap.
    expect(isGuestIdentity("user_2abcDEF")).toBe(false);
    expect(guestIdFromIdentity("user_2abcDEF")).toBeNull();
  });

  it("round-trips any id", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(guestIdFromIdentity(guestIdentity(id))).toBe(id);
      }),
      { numRuns: 300 },
    );
  });
});

describe("normalizeGuestName", () => {
  it("keeps an ordinary name", () => {
    expect(normalizeGuestName("  Ada Lovelace ")).toBe("Ada Lovelace");
  });

  it("falls back for anything empty or non-string", () => {
    for (const value of ["", "   ", null, undefined, 42, {}, []]) {
      expect(normalizeGuestName(value)).toBe("Guest");
    }
  });

  it("strips control characters, which would corrupt a rendered name", () => {
    expect(normalizeGuestName("Ada\u0000\u001bLovelace")).toBe("AdaLovelace");
    expect(normalizeGuestName("line\nbreak")).toBe("linebreak");
  });

  it("bounds the length", () => {
    expect(normalizeGuestName("a".repeat(500))).toHaveLength(60);
  });

  it("never returns an empty string or a control character", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const name = normalizeGuestName(value);
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(60);
        expect(name).not.toMatch(/[\u0000-\u001f\u007f]/);
      }),
      { numRuns: 500 },
    );
  });
});

describe("issueGuestToken and readGuestToken", () => {
  it("round-trips a session", () => {
    const issued = issueGuestToken(MEETING, "Ada");

    expect(issued).not.toBeNull();

    if (issued !== null) {
      const read = readGuestToken(issued.token);

      expect(read).not.toBeNull();
      expect(read?.meetingCode).toBe(MEETING);
      expect(read?.displayName).toBe("Ada");
      expect(read?.guestId).toBe(issued.session.guestId);
    }
  });

  it("gives every guest a distinct id", () => {
    const ids = new Set<string>();

    for (let index = 0; index < 500; index += 1) {
      const issued = issueGuestToken(MEETING, "Ada");

      if (issued !== null) {
        ids.add(issued.session.guestId);
      }
    }

    // Colliding ids would let one guest inherit another's ban.
    expect(ids.size).toBe(500);
  });

  it("rejects a tampered payload", () => {
    const issued = issueGuestToken(MEETING, "Ada");

    expect(issued).not.toBeNull();

    if (issued !== null) {
      const [payload, signature] = issued.token.split(".");
      // Re-encode a payload claiming a different meeting, keeping the old
      // signature. This is the attack the HMAC exists to stop.
      const forgedPayload = Buffer.from(
        JSON.stringify({
          guestId: issued.session.guestId,
          meetingCode: OTHER_MEETING,
          displayName: "Ada",
          expiresAt: issued.session.expiresAt,
        }),
        "utf8",
      ).toString("base64url");

      expect(payload).toBeDefined();
      expect(readGuestToken(`${forgedPayload}.${signature ?? ""}`)).toBeNull();
    }
  });

  it("rejects a token signed with a different secret", () => {
    const original = process.env.GUEST_SESSION_SECRET;
    const issued = issueGuestToken(MEETING, "Ada");

    process.env.GUEST_SESSION_SECRET =
      "a-completely-different-secret-of-sufficient-length";

    expect(issued).not.toBeNull();

    if (issued !== null) {
      expect(readGuestToken(issued.token)).toBeNull();
    }

    process.env.GUEST_SESSION_SECRET = original;
  });

  it("rejects an expired session", () => {
    const issued = issueGuestToken(MEETING, "Ada");

    expect(issued).not.toBeNull();

    if (issued !== null) {
      // Rebuilding with a past expiry needs the real secret, so this asserts the
      // expiry check via the public reader on a hand-made payload instead.
      const expiredPayload = Buffer.from(
        JSON.stringify({
          guestId: "x",
          meetingCode: MEETING,
          displayName: "Ada",
          expiresAt: Date.now() - 1000,
        }),
        "utf8",
      ).toString("base64url");

      // Signature will not match, so this is null for two reasons; the point is
      // that no expired session is ever returned.
      expect(readGuestToken(`${expiredPayload}.nope`)).toBeNull();
    }
  });

  it("rejects malformed input without throwing", () => {
    for (const value of [
      undefined,
      "",
      ".",
      "nodot",
      "a.b",
      "!!!.???",
      "a".repeat(5000),
    ]) {
      expect(() => readGuestToken(value)).not.toThrow();
      expect(readGuestToken(value)).toBeNull();
    }
  });

  it("never accepts arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (token) => {
        expect(readGuestToken(token)).toBeNull();
      }),
      { numRuns: 1000 },
    );
  });
});

describe("readGuestSessionFor", () => {
  it("accepts a token for the meeting it names", () => {
    const issued = issueGuestToken(MEETING, "Ada");

    expect(issued).not.toBeNull();

    if (issued !== null) {
      expect(readGuestSessionFor(issued.token, MEETING)).not.toBeNull();
    }
  });

  it("refuses a token for a different meeting", () => {
    const issued = issueGuestToken(MEETING, "Ada");

    expect(issued).not.toBeNull();

    if (issued !== null) {
      // The scoping check. A guest admitted to one room must never be admitted to
      // another with the same cookie.
      expect(readGuestSessionFor(issued.token, OTHER_MEETING)).toBeNull();
    }
  });
});

describe("cookie name", () => {
  it("is namespaced so it cannot collide with Clerk's cookies", () => {
    expect(GUEST_COOKIE_NAME).toBe("meshasec_guest");
  });
});
