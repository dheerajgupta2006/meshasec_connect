import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  needsSuccession,
  pickSuccessor,
  type SuccessionCandidate,
} from "@/lib/meetings/succession";

function candidate(
  overrides: Partial<SuccessionCandidate> & { userId: string },
): SuccessionCandidate {
  return {
    identity: `clerk_${overrides.userId}`,
    joinedAt: 1000,
    isCoHost: false,
    isPresent: true,
    ...overrides,
  };
}

const HOST = "host";

describe("needsSuccession", () => {
  it("is false while the acting host is still connected", () => {
    const roster = [
      candidate({ userId: HOST }),
      candidate({ userId: "guest" }),
    ];

    expect(needsSuccession(roster, HOST)).toBe(false);
  });

  it("is true when the host is gone and someone else is present", () => {
    const roster = [
      candidate({ userId: HOST, isPresent: false }),
      candidate({ userId: "guest" }),
    ];

    expect(needsSuccession(roster, HOST)).toBe(true);
  });

  it("is false for an empty room", () => {
    // Nobody to hand it to, and the meeting is about to be retired anyway.
    const roster = [
      candidate({ userId: HOST, isPresent: false }),
      candidate({ userId: "guest", isPresent: false }),
    ];

    expect(needsSuccession(roster, HOST)).toBe(false);
    expect(needsSuccession([], HOST)).toBe(false);
  });

  it("is false when the host is absent from the roster but nobody is present", () => {
    expect(
      needsSuccession([candidate({ userId: "guest", isPresent: false })], HOST),
    ).toBe(false);
  });
});

describe("pickSuccessor", () => {
  it("hands the room to the longest-present participant", () => {
    const roster = [
      candidate({ userId: "late", joinedAt: 3000 }),
      candidate({ userId: "early", joinedAt: 1000 }),
      candidate({ userId: "middle", joinedAt: 2000 }),
    ];

    expect(pickSuccessor(roster, HOST)?.userId).toBe("early");
  });

  it("prefers a co-host over an earlier plain participant", () => {
    // The host already delegated moderation to them, so they are the natural
    // successor even if they joined later.
    const roster = [
      candidate({ userId: "early", joinedAt: 1000 }),
      candidate({ userId: "cohost", joinedAt: 5000, isCoHost: true }),
    ];

    expect(pickSuccessor(roster, HOST)?.userId).toBe("cohost");
  });

  it("picks the longest-present co-host when there are several", () => {
    const roster = [
      candidate({ userId: "cohostB", joinedAt: 4000, isCoHost: true }),
      candidate({ userId: "cohostA", joinedAt: 2000, isCoHost: true }),
    ];

    expect(pickSuccessor(roster, HOST)?.userId).toBe("cohostA");
  });

  it("never picks someone who is not connected", () => {
    // Handing the room to a closed tab would leave it unmoderated again.
    const roster = [
      candidate({ userId: "absent", joinedAt: 100, isPresent: false }),
      candidate({ userId: "present", joinedAt: 9000 }),
    ];

    expect(pickSuccessor(roster, HOST)?.userId).toBe("present");
  });

  it("never picks the person leaving", () => {
    const roster = [
      candidate({ userId: HOST, joinedAt: 1 }),
      candidate({ userId: "guest", joinedAt: 5000 }),
    ];

    expect(pickSuccessor(roster, HOST)?.userId).toBe("guest");
  });

  it("returns null when nobody is eligible", () => {
    expect(pickSuccessor([], HOST)).toBeNull();
    expect(
      pickSuccessor([candidate({ userId: HOST })], HOST),
    ).toBeNull();
    expect(
      pickSuccessor([candidate({ userId: "guest", isPresent: false })], HOST),
    ).toBeNull();
  });

  it("breaks a join-time tie deterministically", () => {
    // Two people enrolled in the same transaction share a timestamp. Every
    // participant polls independently, so the choice must not depend on ordering
    // or the handoff would flap between them.
    const a = candidate({ userId: "a", identity: "clerk_a", joinedAt: 1000 });
    const b = candidate({ userId: "b", identity: "clerk_b", joinedAt: 1000 });

    expect(pickSuccessor([a, b], HOST)?.userId).toBe(
      pickSuccessor([b, a], HOST)?.userId,
    );
  });

  it("is order-independent for any roster", () => {
    const rosterArb = fc.array(
      fc.record({
        userId: fc.string({ minLength: 1, maxLength: 6 }),
        identity: fc.string({ minLength: 1, maxLength: 8 }),
        joinedAt: fc.integer({ min: 0, max: 10_000 }),
        isCoHost: fc.boolean(),
        isPresent: fc.boolean(),
      }),
      { maxLength: 12 },
    );

    fc.assert(
      fc.property(rosterArb, (roster) => {
        // Duplicate ids would make "the same person" ambiguous.
        const unique = roster.filter(
          (entry, index) =>
            roster.findIndex((other) => other.userId === entry.userId) === index,
        );

        const forward = pickSuccessor(unique, HOST)?.userId ?? null;
        const backward = pickSuccessor([...unique].reverse(), HOST)?.userId ?? null;

        expect(forward).toBe(backward);
      }),
      { numRuns: 500 },
    );
  });

  it("only ever returns a present, non-leaving candidate", () => {
    const rosterArb = fc.array(
      fc.record({
        userId: fc.string({ minLength: 1, maxLength: 6 }),
        identity: fc.string({ minLength: 1, maxLength: 8 }),
        joinedAt: fc.integer({ min: 0, max: 10_000 }),
        isCoHost: fc.boolean(),
        isPresent: fc.boolean(),
      }),
      { maxLength: 12 },
    );

    fc.assert(
      fc.property(rosterArb, fc.string({ minLength: 1 }), (roster, leaving) => {
        const chosen = pickSuccessor(roster, leaving);

        if (chosen !== null) {
          expect(chosen.isPresent).toBe(true);
          expect(chosen.userId).not.toBe(leaving);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("agrees with needsSuccession: a successor exists exactly when one is needed", () => {
    const rosterArb = fc.array(
      fc.record({
        userId: fc.string({ minLength: 1, maxLength: 6 }),
        identity: fc.string({ minLength: 1, maxLength: 8 }),
        joinedAt: fc.integer({ min: 0, max: 10_000 }),
        isCoHost: fc.boolean(),
        isPresent: fc.boolean(),
      }),
      { maxLength: 12 },
    );

    fc.assert(
      fc.property(rosterArb, (roster) => {
        if (needsSuccession(roster, HOST)) {
          // If a handoff is called for, one must be available — otherwise the
          // caller would decide to hand over and then find nobody to hand to.
          expect(pickSuccessor(roster, HOST)).not.toBeNull();
        }
      }),
      { numRuns: 500 },
    );
  });
});
