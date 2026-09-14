import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MAX_CREATION_REQUEST_ID_CHARS,
  TITLE_MAX_CHARS,
} from "@/lib/meetings/types";
import {
  countCodePoints,
  hasDisallowedCharacters,
  normalizeTitle,
  parseIso8601Instant,
  validateServerInput,
} from "@/lib/meetings/validation";

/** A request ID the server accepts, so title/schedule rules are what is under test. */
const VALID_REQUEST_ID = "0123456789abcdef0123456789abcdef";

function serverPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Team sync",
    mode: "instant",
    startsAt: null,
    endsAt: null,
    creationRequestId: VALID_REQUEST_ID,
    ...overrides,
  };
}

function isoIn(minutes: number, from = Date.now()): string {
  return new Date(from + minutes * 60_000).toISOString();
}

describe("normalizeTitle", () => {
  it("is idempotent and leaves no surrounding whitespace", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normalizeTitle(raw);
        expect(normalizeTitle(once)).toBe(once);
        expect(once).toBe(once.trim());
      }),
      { numRuns: 300 },
    );
  });

  it("never alters interior characters", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(raw.includes(normalizeTitle(raw)) || normalizeTitle(raw) === "").toBe(
          true,
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("countCodePoints", () => {
  it("counts astral characters as one, unlike String.length", () => {
    expect(countCodePoints("😀")).toBe(1);
    expect("😀".length).toBe(2);
    expect(countCodePoints("👨‍👩‍👧")).toBeLessThan("👨‍👩‍👧".length);
  });

  it("never exceeds String.length", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(countCodePoints(value)).toBeLessThanOrEqual(value.length);
      }),
      { numRuns: 200 },
    );
  });
});

describe("hasDisallowedCharacters", () => {
  it("flags control characters that survive trimming", () => {
    // \u0000-\u001F are not whitespace, so .trim() leaves them in place.
    expect(hasDisallowedCharacters("\u0000")).toBe(true);
    expect(hasDisallowedCharacters("ok\u0007bell")).toBe(true);
    expect(hasDisallowedCharacters("\u007F")).toBe(true);
  });

  it("flags zero-width and bidi-override characters", () => {
    expect(hasDisallowedCharacters("a\u200Bb")).toBe(true);
    expect(hasDisallowedCharacters("a\u202Eb")).toBe(true);
  });

  it("accepts ordinary text, punctuation, and emoji", () => {
    for (const value of ["Team sync", "Q4 — planning!", "スタンドアップ", "🎉 launch"]) {
      expect(hasDisallowedCharacters(value)).toBe(false);
    }
  });
});

describe("parseIso8601Instant", () => {
  it("round-trips any UTC instant through toISOString", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("1970-01-01T00:00:00.000Z"),
          max: new Date("2200-01-01T00:00:00.000Z"),
          noInvalidDate: true,
        }),
        (instant) => {
          const parsed = parseIso8601Instant(instant.toISOString());
          expect(parsed).not.toBeNull();
          expect(parsed?.getTime()).toBe(instant.getTime());
        },
      ),
      { numRuns: 300 },
    );
  });

  it("requires an explicit offset, rejecting zone-less values", () => {
    expect(parseIso8601Instant("2026-03-04T09:30")).toBeNull();
    expect(parseIso8601Instant("2026-03-04T09:30:00")).toBeNull();
    expect(parseIso8601Instant("2026-03-04T09:30:00Z")).not.toBeNull();
    expect(parseIso8601Instant("2026-03-04T09:30:00+05:30")).not.toBeNull();
  });

  it("applies the numeric offset rather than ignoring it", () => {
    const utc = parseIso8601Instant("2026-03-04T09:30:00Z");
    const plus = parseIso8601Instant("2026-03-04T15:00:00+05:30");
    expect(utc?.getTime()).toBe(plus?.getTime());
  });

  it("rejects impossible calendar dates instead of rolling over", () => {
    for (const value of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-03-04T24:00:00Z",
      "2026-03-04T09:60:00Z",
    ]) {
      expect(parseIso8601Instant(value)).toBeNull();
    }
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(() => parseIso8601Instant(value)).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });
});

describe("validateServerInput — totality and hostile input", () => {
  it("never throws, whatever it is handed", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => validateServerInput(raw, new Date())).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });

  it("rejects non-object payloads", () => {
    for (const raw of [null, undefined, 42, "title", true, [], () => undefined]) {
      expect(validateServerInput(raw, new Date()).ok).toBe(false);
    }
  });

  it("rejects server-assigned keys before any field rule runs", () => {
    for (const key of ["hostId", "clerkId", "meetingCode", "createdAt"]) {
      const outcome = validateServerInput(
        serverPayload({ [key]: "injected" }),
        new Date(),
      );
      expect(outcome.ok).toBe(false);
    }
  });

  it("rejects a forbidden key even when its value is undefined", () => {
    const outcome = validateServerInput(
      serverPayload({ hostId: undefined }),
      new Date(),
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("validateServerInput — title boundary", () => {
  it("accepts exactly the stated code-point range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: TITLE_MAX_CHARS }), (length) => {
        const outcome = validateServerInput(
          serverPayload({ title: "a".repeat(length) }),
          new Date(),
        );
        expect(outcome.ok).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it("accepts a 100-emoji title that String.length would over-count", () => {
    const outcome = validateServerInput(
      serverPayload({ title: "😀".repeat(TITLE_MAX_CHARS) }),
      new Date(),
    );
    expect(outcome.ok).toBe(true);
  });

  it("rejects one code point past the limit", () => {
    expect(
      validateServerInput(
        serverPayload({ title: "a".repeat(TITLE_MAX_CHARS + 1) }),
        new Date(),
      ).ok,
    ).toBe(false);
    expect(
      validateServerInput(
        serverPayload({ title: "😀".repeat(TITLE_MAX_CHARS + 1) }),
        new Date(),
      ).ok,
    ).toBe(false);
  });

  it("rejects whitespace-only and control-only titles", () => {
    for (const title of ["", "   ", "\t\n ", "\u0000", "\u0000\u0001"]) {
      expect(validateServerInput(serverPayload({ title }), new Date()).ok).toBe(
        false,
      );
    }
  });

  it("rejects non-string titles", () => {
    for (const title of [null, undefined, 7, {}, []]) {
      expect(validateServerInput(serverPayload({ title }), new Date()).ok).toBe(
        false,
      );
    }
  });

  it("persists the trimmed title verbatim", () => {
    const outcome = validateServerInput(
      serverPayload({ title: "  Weekly   sync  " }),
      new Date(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.normalizedTitle).toBe("Weekly   sync");
    }
  });
});

describe("validateServerInput — schedule rules", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("discards schedule input in instant mode", () => {
    const outcome = validateServerInput(
      serverPayload({
        mode: "instant",
        startsAt: isoIn(60, now.getTime()),
        endsAt: isoIn(120, now.getTime()),
      }),
      now,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.startsAt).toBeNull();
      expect(outcome.value.endsAt).toBeNull();
    }
  });

  it("requires a start time in scheduled mode", () => {
    expect(
      validateServerInput(
        serverPayload({ mode: "scheduled", startsAt: null }),
        now,
      ).ok,
    ).toBe(false);
  });

  it("accepts a start strictly in the future and rejects now-or-earlier", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 * 24 * 365 }), (minutes) => {
        const outcome = validateServerInput(
          serverPayload({
            mode: "scheduled",
            startsAt: isoIn(minutes, now.getTime()),
          }),
          now,
        );
        expect(outcome.ok).toBe(true);
      }),
      { numRuns: 80 },
    );

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 * 24 * 365 }), (minutes) => {
        const outcome = validateServerInput(
          serverPayload({
            mode: "scheduled",
            startsAt: isoIn(-minutes, now.getTime()),
          }),
          now,
        );
        expect(outcome.ok).toBe(false);
      }),
      { numRuns: 80 },
    );
  });

  it("treats a start exactly equal to now as not in the future", () => {
    const outcome = validateServerInput(
      serverPayload({ mode: "scheduled", startsAt: now.toISOString() }),
      now,
    );
    expect(outcome.ok).toBe(false);
  });

  it("requires end strictly after start", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (startOffset, gap) => {
          const start = isoIn(startOffset, now.getTime());
          const after = validateServerInput(
            serverPayload({
              mode: "scheduled",
              startsAt: start,
              endsAt: isoIn(startOffset + gap, now.getTime()),
            }),
            now,
          );
          expect(after.ok).toBe(true);

          const notAfter = validateServerInput(
            serverPayload({
              mode: "scheduled",
              startsAt: start,
              endsAt: start,
            }),
            now,
          );
          expect(notAfter.ok).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("persists scheduled instants exactly, with no timezone drift", () => {
    const startsAt = "2026-07-01T09:30:00.000Z";
    const endsAt = "2026-07-01T10:30:00.000Z";
    const outcome = validateServerInput(
      serverPayload({ mode: "scheduled", startsAt, endsAt }),
      now,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.startsAt?.toISOString()).toBe(startsAt);
      expect(outcome.value.endsAt?.toISOString()).toBe(endsAt);
    }
  });

  it("rejects an invalid mode", () => {
    for (const mode of ["INSTANT", "Scheduled", "", null, 1, {}]) {
      expect(validateServerInput(serverPayload({ mode }), now).ok).toBe(false);
    }
  });
});

describe("validateServerInput — request ID shape", () => {
  it("accepts the 32-char hex and UUID forms", () => {
    for (const id of [
      VALID_REQUEST_ID,
      "0123456789abcdef0123456789ABCDEF".toLowerCase(),
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    ]) {
      expect(
        validateServerInput(
          serverPayload({ creationRequestId: id }),
          new Date(),
        ).ok,
      ).toBe(true);
    }
  });

  it("rejects the empty client placeholder", () => {
    expect(
      validateServerInput(
        serverPayload({ creationRequestId: "" }),
        new Date(),
      ).ok,
    ).toBe(false);
  });

  it("rejects malformed, oversized, and non-string identifiers", () => {
    const oversized = "a".repeat(MAX_CREATION_REQUEST_ID_CHARS + 10);
    for (const id of [
      "not-hex",
      "0123456789abcdef",
      "0123456789abcdef0123456789abcdeg",
      oversized,
      null,
      undefined,
      42,
    ]) {
      expect(
        validateServerInput(
          serverPayload({ creationRequestId: id }),
          new Date(),
        ).ok,
      ).toBe(false);
    }
  });
});
