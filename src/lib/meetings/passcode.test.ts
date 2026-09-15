import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { generateRoomPasscode } from "@/lib/meetings/meeting-code";
import {
  formatPasscodeForDisplay,
  normalizePasscode,
} from "@/lib/meetings/passcode";
import { passcodeMatches } from "@/lib/meetings/passcode-verify";
import { ROOM_PASSCODE_DIGITS } from "@/lib/meetings/types";

describe("generateRoomPasscode", () => {
  it("always returns exactly six digits", () => {
    for (let i = 0; i < 2000; i += 1) {
      const passcode = generateRoomPasscode();
      expect(passcode).toMatch(/^\d{6}$/);
      expect(passcode).toHaveLength(ROOM_PASSCODE_DIGITS);
    }
  });

  it("preserves leading zeros rather than shortening the code", () => {
    // Padding is what keeps every passcode the same length, which the
    // constant-time comparison depends on.
    const padded = Array.from({ length: 20_000 }, () =>
      generateRoomPasscode(),
    ).filter((code) => code.startsWith("0"));

    expect(padded.length).toBeGreaterThan(0);
    padded.forEach((code) => {
      expect(code).toHaveLength(ROOM_PASSCODE_DIGITS);
    });
  });

  it("survives its own normalisation, so a generated code is always accepted", () => {
    for (let i = 0; i < 1000; i += 1) {
      const passcode = generateRoomPasscode();
      expect(normalizePasscode(passcode)).toBe(passcode);
    }
  });

  it("covers the whole range without obvious clustering", () => {
    // A biased generator (`randomBytes % 1000000`) skews toward low codes. This
    // is a smoke test for uniformity, not a statistical proof.
    const buckets = new Array<number>(10).fill(0);

    for (let i = 0; i < 20_000; i += 1) {
      const first = Number(generateRoomPasscode()[0]);
      buckets[first] = (buckets[first] ?? 0) + 1;
    }

    buckets.forEach((count) => {
      // Expected 2000 per bucket; allow a wide band so this cannot flake.
      expect(count).toBeGreaterThan(1200);
      expect(count).toBeLessThan(2800);
    });
  });

  it("does not repeat excessively across a large sample", () => {
    const seen = new Set<string>();

    for (let i = 0; i < 5000; i += 1) {
      seen.add(generateRoomPasscode());
    }

    // 5000 draws from 1,000,000 should collide rarely. This would fail loudly if
    // the generator ever became constant or near-constant.
    expect(seen.size).toBeGreaterThan(4900);
  });
});

describe("normalizePasscode", () => {
  it("accepts a plain six-digit code", () => {
    expect(normalizePasscode("839201")).toBe("839201");
  });

  it("strips the separators people paste from a chat message", () => {
    for (const typed of ["839 201", "839-201", " 839201 ", "8 3 9 2 0 1"]) {
      expect(normalizePasscode(typed)).toBe("839201");
    }
  });

  it("keeps leading zeros", () => {
    expect(normalizePasscode("001234")).toBe("001234");
  });

  it("rejects anything that is not exactly six digits", () => {
    for (const bad of ["", "1", "12345", "1234567", "abcdef", "12345a", "12.345"]) {
      expect(normalizePasscode(bad)).toBeNull();
    }
  });

  it("rejects a non-string", () => {
    for (const bad of [null, undefined, 839201, {}, [], true]) {
      expect(normalizePasscode(bad)).toBeNull();
    }
  });

  it("rejects an absurdly long input before doing any work", () => {
    expect(normalizePasscode(`${"1".repeat(10_000)}`)).toBeNull();
    // Separator-padded to six digits but still oversized overall.
    expect(normalizePasscode(`${" ".repeat(500)}839201`)).toBeNull();
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normalizePasscode(raw);

        if (once !== null) {
          expect(normalizePasscode(once)).toBe(once);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("never returns anything other than six digits or null", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normalizePasscode(raw);

        if (result !== null) {
          expect(result).toMatch(/^\d{6}$/);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => normalizePasscode(raw)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe("passcodeMatches", () => {
  it("accepts an exact match", () => {
    expect(passcodeMatches("839201", "839201")).toBe(true);
  });

  it("rejects a mismatch of the same length", () => {
    expect(passcodeMatches("839201", "839202")).toBe(false);
    expect(passcodeMatches("839201", "000000")).toBe(false);
  });

  it("rejects a length mismatch instead of throwing", () => {
    // `timingSafeEqual` throws on unequal buffer lengths, which would surface as
    // a 500 rather than a refusal.
    expect(() => passcodeMatches("839201", "83920")).not.toThrow();
    expect(passcodeMatches("839201", "83920")).toBe(false);
    expect(passcodeMatches("839201", "8392011")).toBe(false);
  });

  it("treats a null on either side as no match", () => {
    expect(passcodeMatches(null, "839201")).toBe(false);
    expect(passcodeMatches("839201", null)).toBe(false);
    expect(passcodeMatches(null, null)).toBe(false);
  });

  it("does not match an empty string against a real passcode", () => {
    expect(passcodeMatches("839201", "")).toBe(false);
    expect(passcodeMatches("", "839201")).toBe(false);
  });

  it("agrees with string equality for every pair, and never throws", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 20 }), { nil: null }),
        fc.option(fc.string({ maxLength: 20 }), { nil: null }),
        (expected, submitted) => {
          let result = false;
          expect(() => {
            result = passcodeMatches(expected, submitted);
          }).not.toThrow();

          const shouldMatch =
            expected !== null && submitted !== null && expected === submitted;

          expect(result).toBe(shouldMatch);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("accepts every generated passcode against itself", () => {
    for (let i = 0; i < 500; i += 1) {
      const passcode = generateRoomPasscode();
      expect(passcodeMatches(passcode, passcode)).toBe(true);
    }
  });
});

describe("formatPasscodeForDisplay", () => {
  it("splits a six-digit code into two groups of three", () => {
    expect(formatPasscodeForDisplay("839201")).toBe("839 201");
    expect(formatPasscodeForDisplay("001234")).toBe("001 234");
  });

  it("leaves anything of an unexpected length untouched", () => {
    for (const odd of ["", "123", "1234567"]) {
      expect(formatPasscodeForDisplay(odd)).toBe(odd);
    }
  });

  it("round-trips back through normalisation", () => {
    // The displayed form is what a host reads out and a guest types in, so it
    // must be accepted verbatim.
    for (let i = 0; i < 500; i += 1) {
      const passcode = generateRoomPasscode();
      expect(normalizePasscode(formatPasscodeForDisplay(passcode))).toBe(
        passcode,
      );
    }
  });
});
