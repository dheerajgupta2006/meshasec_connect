import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { generateMeetingCode } from "@/lib/meetings/meeting-code";
import { MEETING_CODE_CHARS } from "@/lib/meetings/types";
import { assertTrustedOrigin } from "@/lib/meetings/origin";
import { redact } from "@/lib/meetings/diagnostics";
import {
  RATE_LIMITS,
  consumeRateLimit,
  describeRetryAfter,
} from "@/lib/rate-limit";
import {
  FALLBACK_USERNAME_BASE,
  USERNAME_MAX,
  USERNAME_MIN,
  normalizeUsername,
  slugifyUsername,
} from "@/lib/users/username";

/** Distinct subject per test so the shared window map cannot leak between them. */
let subjectCounter = 0;
function nextSubject(): string {
  subjectCounter += 1;
  return `subject-${subjectCounter}-${Math.random().toString(36).slice(2)}`;
}

describe("generateMeetingCode", () => {
  it("always produces 22 URL-safe characters with no padding", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateMeetingCode();
      expect(code).toHaveLength(MEETING_CODE_CHARS);
      expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(code).not.toContain("=");
    }
  });

  it("does not repeat across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(generateMeetingCode());
    }
    expect(seen.size).toBe(2000);
  });

  it("survives URL encoding unchanged, since it is used in a path segment", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateMeetingCode();
      expect(encodeURIComponent(code)).toBe(code);
    }
  });
});

describe("normalizeUsername", () => {
  it("is idempotent and strips leading @ symbols", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normalizeUsername(raw);
        expect(normalizeUsername(once)).toBe(once);
        expect(once.startsWith("@")).toBe(false);
        expect(once).toBe(once.toLowerCase());
      }),
      { numRuns: 300 },
    );
  });

  it("treats decorated and bare handles as the same person", () => {
    for (const raw of ["@Alice", "alice", "  ALICE  ", "@@alice"]) {
      expect(normalizeUsername(raw)).toBe("alice");
    }
  });
});

describe("slugifyUsername", () => {
  it("only ever emits lowercase letters, digits and interior underscores", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const slug = slugifyUsername(raw);
        expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/);
        expect(slug).not.toMatch(/__/);
      }),
      { numRuns: 500 },
    );
  });

  it("always stays inside the storable length range", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (raw) => {
        const slug = slugifyUsername(raw);
        expect(slug.length).toBeGreaterThanOrEqual(USERNAME_MIN);
        expect(slug.length).toBeLessThanOrEqual(USERNAME_MAX);
      }),
      { numRuns: 500 },
    );
  });

  it("is idempotent, so re-slugifying a stored handle never changes it", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = slugifyUsername(raw);
        expect(slugifyUsername(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("does not leave a trailing underscore when truncating a long input", () => {
    // 23 letters, a separator, then more text: the cut lands exactly on the
    // separator, which used to survive into the stored handle.
    const raw = `${"a".repeat(USERNAME_MAX - 1)} bcdef`;
    const slug = slugifyUsername(raw);
    expect(slug.endsWith("_")).toBe(false);
    expect(slugifyUsername(slug)).toBe(slug);
  });

  it("falls back when nothing usable survives", () => {
    for (const raw of ["", "   ", "@@@", "!!", "ab", "--", "😀"]) {
      expect(slugifyUsername(raw)).toBe(FALLBACK_USERNAME_BASE);
    }
  });

  it("derives readable handles from names and email local parts", () => {
    expect(slugifyUsername("Ada Lovelace")).toBe("ada_lovelace");
    expect(slugifyUsername("  Grace.Hopper  ")).toBe("grace_hopper");
    expect(slugifyUsername("ada+news@example.com")).toBe("ada_news_example_com");
  });

  it("agrees with normalizeUsername on the handles it produces", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const slug = slugifyUsername(raw);
        // A stored handle must survive the lookup path untouched, otherwise a
        // user could sign up under a handle they can never be found by.
        expect(normalizeUsername(slug)).toBe(slug);
      }),
      { numRuns: 500 },
    );
  });
});

describe("redact", () => {
  it("removes a Postgres connection string including its password", () => {
    const secret = "postgresql://user:sup3rs3cret@db.example.com:5432/app";
    const output = redact(`connect failed for ${secret} retrying`);
    expect(output).not.toContain("sup3rs3cret");
    expect(output).toContain("retrying");
  });

  it("removes Clerk secret keys and JWTs wherever they appear", () => {
    const clerk = "sk_test_abcdefghijklmnopqrstuvwxyz012345";
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    for (const secret of [clerk, jwt]) {
      const output = redact(`before ${secret} after`);
      expect(output).not.toContain(secret);
      expect(output).toContain("before");
      expect(output).toContain("after");
    }
  });

  it("removes bearer tokens", () => {
    const output = redact("Authorization: Bearer abc.def.ghi");
    expect(output).not.toContain("abc.def.ghi");
  });

  it("never throws and always returns a string", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(typeof redact(value)).toBe("string");
      }),
      { numRuns: 300 },
    );
  });
});

describe("assertTrustedOrigin", () => {
  function headers(entries: Record<string, string>): Headers {
    return new Headers(entries);
  }

  it("treats a missing Origin on a state-changing request as untrusted", () => {
    expect(assertTrustedOrigin(headers({ host: "localhost:3000" })).trusted).toBe(
      false,
    );
  });

  it("rejects a host that merely ends with an allowed host", () => {
    const check = assertTrustedOrigin(
      headers({
        origin: "http://evil-localhost:3000",
        host: "localhost:3000",
      }),
    );
    expect(check.trusted).toBe(false);
  });

  it("rejects a differing port", () => {
    const check = assertTrustedOrigin(
      headers({ origin: "http://localhost:3001", host: "localhost:3000" }),
    );
    expect(check.trusted).toBe(false);
  });

  it("accepts an exact host and port match", () => {
    const check = assertTrustedOrigin(
      headers({ origin: "http://localhost:3000", host: "localhost:3000" }),
    );
    expect(check.trusted).toBe(true);
  });

  it("never throws on arbitrary header values", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (origin, host) => {
        // Header values containing control characters are rejected by Headers
        // itself, so only exercise values it will accept.
        let list: Headers;
        try {
          list = headers({ origin, host });
        } catch {
          return;
        }
        expect(() => assertTrustedOrigin(list)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

describe("consumeRateLimit", () => {
  it("permits exactly the configured number of calls, then refuses", () => {
    const subject = nextSubject();
    const limit = RATE_LIMITS.directMessage.limit;

    for (let i = 0; i < limit; i += 1) {
      expect(consumeRateLimit("directMessage", subject).allowed).toBe(true);
    }

    const refused = consumeRateLimit("directMessage", subject);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps subjects independent, so one user cannot exhaust another's quota", () => {
    const noisy = nextSubject();
    const quiet = nextSubject();

    for (let i = 0; i < RATE_LIMITS.directMessage.limit + 5; i += 1) {
      consumeRateLimit("directMessage", noisy);
    }

    expect(consumeRateLimit("directMessage", quiet).allowed).toBe(true);
  });

  it("keeps actions independent, so messaging cannot exhaust the call quota", () => {
    const subject = nextSubject();

    for (let i = 0; i < RATE_LIMITS.directMessage.limit + 5; i += 1) {
      consumeRateLimit("directMessage", subject);
    }

    expect(consumeRateLimit("startCall", subject).allowed).toBe(true);
  });

  it("reports a retry window no longer than the configured window", () => {
    const subject = nextSubject();
    const rule = RATE_LIMITS.connectionRequest;

    for (let i = 0; i < rule.limit; i += 1) {
      consumeRateLimit("connectionRequest", subject);
    }

    const refused = consumeRateLimit("connectionRequest", subject);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(
      Math.ceil(rule.windowMs / 1000),
    );
  });

  it("never throws for any subject string", () => {
    fc.assert(
      fc.property(fc.string(), (subject) => {
        expect(() => consumeRateLimit("meetingToken", subject)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

describe("describeRetryAfter", () => {
  it("renders sub-minute waits in seconds and longer waits in minutes", () => {
    expect(describeRetryAfter(30)).toContain("second");
    expect(describeRetryAfter(59)).toContain("second");
    expect(describeRetryAfter(60)).toContain("minute");
    expect(describeRetryAfter(3600)).toContain("minute");
  });

  it("never produces an empty description", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (seconds) => {
        expect(describeRetryAfter(seconds).length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });
});
