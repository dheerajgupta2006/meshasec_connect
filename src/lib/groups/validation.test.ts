import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  GROUP_DESCRIPTION_MAX_CHARS,
  GROUP_NAME_MAX_CHARS,
  GROUP_NAME_MIN_CHARS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_MESSAGE_CHARS,
} from "@/lib/groups/limits";
import {
  capacityLeft,
  isValidId,
  normalizeMemberIds,
  validateGroupDescription,
  validateGroupMessageBody,
  validateGroupName,
} from "@/lib/groups/validation";

describe("validateGroupName", () => {
  it("accepts a normal name and collapses whitespace", () => {
    const result = validateGroupName("  Design   Team  ");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.name).toBe("Design Team");
    }
  });

  it("rejects a name that is too short", () => {
    expect(validateGroupName("a").ok).toBe(false);
    expect(validateGroupName("   ").ok).toBe(false);
  });

  it("rejects a name that is too long", () => {
    const tooLong = "x".repeat(GROUP_NAME_MAX_CHARS + 1);

    expect(validateGroupName(tooLong).ok).toBe(false);
  });

  it("measures length in code points, not UTF-16 units", () => {
    // Each of these is two UTF-16 units. At the old measure, half the limit's
    // worth of emoji would have been refused.
    const emoji = "🙂".repeat(GROUP_NAME_MAX_CHARS);

    expect(validateGroupName(emoji).ok).toBe(true);
    expect(validateGroupName(`${emoji}🙂`).ok).toBe(false);
  });

  it("strips invisible characters rather than refusing the paste", () => {
    // A zero-width space would otherwise let two groups render identically.
    const result = validateGroupName("Team\u200bAlpha");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.name).toBe("TeamAlpha");
    }
  });

  it("rejects a name made only of invisible characters", () => {
    expect(validateGroupName("\u200b\u200b\u200b").ok).toBe(false);
  });

  it("refuses anything that is not a string", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(validateGroupName(value).ok).toBe(false);
    }
  });

  it("never returns an accepted name outside the bounds", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = validateGroupName(raw);

        if (result.ok) {
          const length = Array.from(result.name).length;
          expect(length).toBeGreaterThanOrEqual(GROUP_NAME_MIN_CHARS);
          expect(length).toBeLessThanOrEqual(GROUP_NAME_MAX_CHARS);
          // Collapsing means an accepted name never has edge whitespace.
          expect(result.name).toBe(result.name.trim());
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("validateGroupDescription", () => {
  it("treats absent, null and blank as no description", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = validateGroupDescription(value);

      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.description).toBeNull();
      }
    }
  });

  it("keeps a real description, tidied", () => {
    const result = validateGroupDescription("  Weekly   planning  ");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.description).toBe("Weekly planning");
    }
  });

  it("rejects one that is too long", () => {
    const tooLong = "x".repeat(GROUP_DESCRIPTION_MAX_CHARS + 1);

    expect(validateGroupDescription(tooLong).ok).toBe(false);
  });

  it("never returns an accepted description over the limit", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = validateGroupDescription(raw);

        if (result.ok && result.description !== null) {
          expect(
            Array.from(result.description).length,
          ).toBeLessThanOrEqual(GROUP_DESCRIPTION_MAX_CHARS);
          expect(result.description.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("validateGroupMessageBody", () => {
  it("trims the edges", () => {
    const result = validateGroupMessageBody("  hello  ");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.body).toBe("hello");
    }
  });

  it("preserves deliberate internal layout", () => {
    // The thread renders with `whitespace-pre-wrap`, so collapsing here would
    // silently reflow someone's list.
    const result = validateGroupMessageBody("one\n\ntwo   three");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.body).toBe("one\n\ntwo   three");
    }
  });

  it("rejects blank and over-long bodies", () => {
    expect(validateGroupMessageBody("   ").ok).toBe(false);
    expect(
      validateGroupMessageBody("x".repeat(MAX_GROUP_MESSAGE_CHARS + 1)).ok,
    ).toBe(false);
  });

  it("never returns an empty accepted body", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = validateGroupMessageBody(raw);

        if (result.ok) {
          expect(result.body.length).toBeGreaterThan(0);
          expect(
            Array.from(result.body).length,
          ).toBeLessThanOrEqual(MAX_GROUP_MESSAGE_CHARS);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("isValidId", () => {
  it("accepts cuid-shaped ids", () => {
    expect(isValidId("clx1a2b3c4d5e6f7g8h9i0j1")).toBe(true);
    expect(isValidId("abc-123_XYZ")).toBe(true);
  });

  it("rejects junk and unbounded input", () => {
    for (const value of ["", "has space", "semi;colon", "x".repeat(65), 7, null]) {
      expect(isValidId(value)).toBe(false);
    }
  });
});

describe("normalizeMemberIds", () => {
  const room = { minimum: 1, capacityLeft: 10 };

  it("accepts a plain list", () => {
    const result = normalizeMemberIds(["a", "b"], room);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.ids).toEqual(["a", "b"]);
    }
  });

  it("deduplicates rather than failing later on the unique index", () => {
    const result = normalizeMemberIds(["a", "b", "a"], room);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.ids).toEqual(["a", "b"]);
    }
  });

  it("preserves the order the picker gave", () => {
    const result = normalizeMemberIds(["c", "a", "b"], room);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.ids).toEqual(["c", "a", "b"]);
    }
  });

  it("enforces the minimum", () => {
    expect(normalizeMemberIds([], room).ok).toBe(false);
    expect(normalizeMemberIds([], { minimum: 0, capacityLeft: 5 }).ok).toBe(
      true,
    );
  });

  it("enforces remaining capacity", () => {
    expect(
      normalizeMemberIds(["a", "b", "c"], { minimum: 1, capacityLeft: 2 }).ok,
    ).toBe(false);
  });

  it("explains a full group differently from a partial one", () => {
    const full = normalizeMemberIds(["a"], { minimum: 1, capacityLeft: 0 });

    expect(full.ok).toBe(false);

    if (!full.ok) {
      expect(full.message).toContain(String(MAX_GROUP_MEMBERS));
    }
  });

  it("refuses a non-array and a malformed entry", () => {
    expect(normalizeMemberIds("a", room).ok).toBe(false);
    expect(normalizeMemberIds(["ok", "not ok"], room).ok).toBe(false);
  });

  it("never returns more ids than capacity, nor any duplicates", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 30 }),
        fc.integer({ min: 0, max: 20 }),
        (raw, capacity) => {
          const result = normalizeMemberIds(raw, {
            minimum: 0,
            capacityLeft: capacity,
          });

          if (result.ok) {
            expect(result.ids.length).toBeLessThanOrEqual(capacity);
            expect(new Set(result.ids).size).toBe(result.ids.length);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("capacityLeft", () => {
  it("counts down from the ceiling and never goes negative", () => {
    expect(capacityLeft(0)).toBe(MAX_GROUP_MEMBERS);
    expect(capacityLeft(1)).toBe(MAX_GROUP_MEMBERS - 1);
    expect(capacityLeft(MAX_GROUP_MEMBERS)).toBe(0);
    expect(capacityLeft(MAX_GROUP_MEMBERS + 10)).toBe(0);
  });
});
