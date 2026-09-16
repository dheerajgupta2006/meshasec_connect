import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  EMPTY_ROOM_GRACE_MS,
  STALE_AFTER_MS,
  groupMeetingsByActivity,
  hasEnded,
  openedAt,
  partitionMeetings,
  resolveMeetingActivity,
  resolveMeetingStatus,
  type MeetingLifecycleFields,
} from "@/lib/meetings/lifecycle";

const NOW = new Date("2026-09-14T12:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function at(offsetMs: number): Date {
  return new Date(NOW + offsetMs);
}

/** An instant meeting, exactly as `createMeeting` persists one. */
function instant(createdOffsetMs: number, endsAt: Date | null = null) {
  return { createdAt: at(createdOffsetMs), startsAt: null, endsAt };
}

function scheduled(
  startOffsetMs: number,
  endOffsetMs: number | null = null,
  createdOffsetMs = startOffsetMs - HOUR,
) {
  return {
    createdAt: at(createdOffsetMs),
    startsAt: at(startOffsetMs),
    endsAt: endOffsetMs === null ? null : at(endOffsetMs),
  };
}

describe("resolveMeetingStatus — the reported bug", () => {
  it("treats a just-created instant meeting as live, not upcoming", () => {
    // Instant meetings carry `startsAt: null`, which the old dashboard test read
    // as "has not started".
    expect(resolveMeetingStatus(instant(-5 * MINUTE), NOW)).toBe("live");
  });

  it("treats an instant meeting the host ended as ended", () => {
    // The exact scenario reported: joined an instant meeting, ended it, and it
    // still showed under Upcoming because nothing wrote `endsAt`.
    const ended = instant(-30 * MINUTE, at(-1 * MINUTE));

    expect(resolveMeetingStatus(ended, NOW)).toBe("ended");
    expect(hasEnded(ended, NOW)).toBe(true);
  });

  it("never leaves an instant meeting with no recorded end in Upcoming forever", () => {
    const abandoned = instant(-STALE_AFTER_MS - MINUTE);

    // Someone closed the tab and no end was written. It must not sit in Upcoming
    // indefinitely.
    expect(resolveMeetingStatus(abandoned, NOW)).toBe("ended");
  });

  it("keeps an instant meeting live right up to the staleness boundary", () => {
    expect(resolveMeetingStatus(instant(-STALE_AFTER_MS + MINUTE), NOW)).toBe(
      "live",
    );
    expect(resolveMeetingStatus(instant(-STALE_AFTER_MS), NOW)).toBe("ended");
  });
});

describe("resolveMeetingStatus — scheduled meetings", () => {
  it("is upcoming before the start time", () => {
    expect(resolveMeetingStatus(scheduled(2 * HOUR), NOW)).toBe("upcoming");
  });

  it("is live between start and end", () => {
    expect(resolveMeetingStatus(scheduled(-30 * MINUTE, 30 * MINUTE), NOW)).toBe(
      "live",
    );
  });

  it("is ended once the end time passes", () => {
    expect(resolveMeetingStatus(scheduled(-2 * HOUR, -1 * HOUR), NOW)).toBe(
      "ended",
    );
  });

  it("stays upcoming when both start and end are still ahead", () => {
    expect(resolveMeetingStatus(scheduled(HOUR, 2 * HOUR), NOW)).toBe(
      "upcoming",
    );
  });

  it("falls back to the staleness window when no end was recorded", () => {
    expect(resolveMeetingStatus(scheduled(-1 * HOUR), NOW)).toBe("live");
    expect(
      resolveMeetingStatus(scheduled(-STALE_AFTER_MS - HOUR), NOW),
    ).toBe("ended");
  });

  it("lets a recorded end win over the staleness window", () => {
    // Started long enough ago to be presumed stale, but explicitly ends later.
    const meeting = scheduled(-STALE_AFTER_MS - HOUR, 2 * HOUR);

    expect(resolveMeetingStatus(meeting, NOW)).toBe("live");
  });
});

describe("resolveMeetingStatus — invariants", () => {
  const meetingArb = fc.record({
    createdAt: fc.date({ noInvalidDate: true }),
    startsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
    endsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
  });

  it("always returns one of the three known statuses", () => {
    fc.assert(
      fc.property(meetingArb, fc.integer(), (meeting, now) => {
        expect(["upcoming", "live", "ended"]).toContain(
          resolveMeetingStatus(meeting, now),
        );
      }),
      { numRuns: 500 },
    );
  });

  it("agrees with hasEnded, so the dashboard split cannot disagree with the badge", () => {
    fc.assert(
      fc.property(meetingArb, fc.integer(), (meeting, now) => {
        expect(hasEnded(meeting, now)).toBe(
          resolveMeetingStatus(meeting, now) === "ended",
        );
      }),
      { numRuns: 500 },
    );
  });

  it("is monotonic: once ended, later moments are still ended", () => {
    fc.assert(
      fc.property(
        meetingArb,
        fc.integer({ min: -8.64e12, max: 8.64e12 }),
        fc.integer({ min: 0, max: 8.64e12 }),
        (meeting, now, delta) => {
          // A meeting cannot un-end as time moves forward.
          if (resolveMeetingStatus(meeting, now) === "ended") {
            expect(resolveMeetingStatus(meeting, now + delta)).toBe("ended");
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never reports an invalid date as upcoming", () => {
    // NaN comparisons are all false, which is how a corrupt row could slip into
    // Upcoming permanently.
    const corrupt: MeetingLifecycleFields = {
      createdAt: new Date(Number.NaN),
      startsAt: new Date(Number.NaN),
      endsAt: new Date(Number.NaN),
    };

    expect(resolveMeetingStatus(corrupt, NOW)).toBe("ended");
  });

  it("uses startsAt when present and createdAt otherwise", () => {
    expect(openedAt(scheduled(HOUR))).toBe(NOW + HOUR);
    expect(openedAt(instant(-HOUR))).toBe(NOW - HOUR);
  });
});

describe("partitionMeetings", () => {
  it("puts every meeting in exactly one list", () => {
    const meetingArb = fc.record({
      createdAt: fc.date({ noInvalidDate: true }),
      startsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
      endsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
    });

    fc.assert(
      fc.property(fc.array(meetingArb, { maxLength: 40 }), (meetings) => {
        const { upcoming, past } = partitionMeetings(meetings, NOW);

        // No loss, no duplication: the two lists must reconstruct the input.
        expect(upcoming.length + past.length).toBe(meetings.length);
      }),
      { numRuns: 300 },
    );
  });

  it("sorts upcoming soonest-first and past most-recent-first", () => {
    const soon = scheduled(HOUR);
    const later = scheduled(5 * HOUR);
    const endedRecently = instant(-2 * HOUR, at(-10 * MINUTE));
    const endedEarlier = instant(-6 * HOUR, at(-5 * HOUR));

    const { upcoming, past } = partitionMeetings(
      [later, endedEarlier, soon, endedRecently],
      NOW,
    );

    expect(upcoming).toEqual([soon, later]);
    expect(past).toEqual([endedRecently, endedEarlier]);
  });

  it("orders a never-closed meeting by its presumed end", () => {
    const closedLongAgo = instant(-40 * HOUR, at(-39 * HOUR));
    // No `endsAt`: presumed to have ended at createdAt + the staleness window.
    const abandoned = instant(-STALE_AFTER_MS - HOUR);

    const { past } = partitionMeetings([closedLongAgo, abandoned], NOW);

    expect(past).toEqual([abandoned, closedLongAgo]);
  });

  it("does not mutate the array it was given", () => {
    const input = [scheduled(5 * HOUR), scheduled(HOUR)];
    const snapshot = [...input];

    partitionMeetings(input, NOW);

    expect(input).toEqual(snapshot);
  });

  it("handles an empty list", () => {
    expect(partitionMeetings([], NOW)).toEqual({ upcoming: [], past: [] });
  });
});

describe("resolveMeetingActivity", () => {
  const ONE_MINUTE = MINUTE;

  it("reports ongoing whenever someone is connected, whatever the row says", () => {
    // A live call must never be filed as past, even if the stored end time has
    // passed or the staleness window has lapsed.
    const stale = instant(-STALE_AFTER_MS - HOUR);
    const closed = instant(-2 * HOUR, at(-HOUR));

    for (const meeting of [stale, closed]) {
      expect(
        resolveMeetingActivity({ meeting, liveParticipants: 1, now: NOW }),
      ).toBe("ongoing");
    }
  });

  it("keeps a just-created empty instant meeting joinable", () => {
    // The host has made the room and copied the link but not opened it yet.
    // Filing that under past would be absurd.
    expect(
      resolveMeetingActivity({
        meeting: instant(-ONE_MINUTE),
        liveParticipants: 0,
        now: NOW,
      }),
    ).toBe("upcoming");
  });

  it("retires an empty room once the grace window lapses", () => {
    // This is what moves a meeting everyone has left into past.
    expect(
      resolveMeetingActivity({
        meeting: instant(-EMPTY_ROOM_GRACE_MS - ONE_MINUTE),
        liveParticipants: 0,
        now: NOW,
      }),
    ).toBe("past");
  });

  it("treats the grace boundary exactly", () => {
    expect(
      resolveMeetingActivity({
        meeting: instant(-EMPTY_ROOM_GRACE_MS + ONE_MINUTE),
        liveParticipants: 0,
        now: NOW,
      }),
    ).toBe("upcoming");

    expect(
      resolveMeetingActivity({
        meeting: instant(-EMPTY_ROOM_GRACE_MS),
        liveParticipants: 0,
        now: NOW,
      }),
    ).toBe("past");
  });

  it("reports past for an explicitly ended meeting with nobody in it", () => {
    expect(
      resolveMeetingActivity({
        meeting: instant(-30 * MINUTE, at(-ONE_MINUTE)),
        liveParticipants: 0,
        now: NOW,
      }),
    ).toBe("past");
  });

  it("reports upcoming for a scheduled meeting that has not started", () => {
    expect(
      resolveMeetingActivity({
        meeting: scheduled(2 * HOUR),
        liveParticipants: 0,
        now: NOW,
      }),
    ).toBe("upcoming");
  });

  it("does not assume a room is empty when LiveKit is unreachable", () => {
    // Null means "cannot tell". Treating it as zero would sweep every live
    // meeting into past the moment the media server hiccupped.
    expect(
      resolveMeetingActivity({
        meeting: instant(-2 * HOUR),
        liveParticipants: null,
        now: NOW,
      }),
    ).toBe("ongoing");
  });

  it("still trusts the database when LiveKit is unreachable", () => {
    // An explicit end and the staleness rule both still apply.
    expect(
      resolveMeetingActivity({
        meeting: instant(-2 * HOUR, at(-HOUR)),
        liveParticipants: null,
        now: NOW,
      }),
    ).toBe("past");

    expect(
      resolveMeetingActivity({
        meeting: instant(-STALE_AFTER_MS - HOUR),
        liveParticipants: null,
        now: NOW,
      }),
    ).toBe("past");
  });

  it("always returns one of the three groups", () => {
    fc.assert(
      fc.property(
        fc.record({
          createdAt: fc.date({ noInvalidDate: true }),
          startsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
          endsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
        }),
        fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
        fc.integer(),
        (meeting, liveParticipants, now) => {
          expect(["upcoming", "ongoing", "past"]).toContain(
            resolveMeetingActivity({ meeting, liveParticipants, now }),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never reports past while participants are connected", () => {
    fc.assert(
      fc.property(
        fc.record({
          createdAt: fc.date({ noInvalidDate: true }),
          startsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
          endsAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
        }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer(),
        (meeting, liveParticipants, now) => {
          expect(
            resolveMeetingActivity({ meeting, liveParticipants, now }),
          ).toBe("ongoing");
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("groupMeetingsByActivity", () => {
  /** Attaches a meeting code, which is what the live-count map is keyed by. */
  function coded(
    code: string,
    meeting: MeetingLifecycleFields,
  ): MeetingLifecycleFields & { meetingCode: string } {
    return { meetingCode: code, ...meeting };
  }

  it("routes each meeting into exactly one group", () => {
    const live = coded("LIVE", instant(-30 * MINUTE));
    const soon = coded("SOON", { ...scheduled(HOUR) });
    const done = coded("DONE", instant(-5 * HOUR, at(-4 * HOUR)));

    const counts = new Map([["LIVE", 2]]);
    const groups = groupMeetingsByActivity([live, soon, done], counts, NOW);

    expect(groups.ongoing).toEqual([live]);
    expect(groups.upcoming).toEqual([soon]);
    expect(groups.past).toEqual([done]);
  });

  it("treats a code missing from the map as empty", () => {
    const abandoned = coded(
      "GONE",
      instant(-EMPTY_ROOM_GRACE_MS - HOUR),
    );

    const groups = groupMeetingsByActivity([abandoned], new Map(), NOW);

    expect(groups.past).toEqual([abandoned]);
    expect(groups.ongoing).toEqual([]);
  });

  it("loses nothing", () => {
    const meetings = [
      coded("A", instant(-MINUTE)),
      coded("B", instant(-EMPTY_ROOM_GRACE_MS - MINUTE)),
      coded("C", instant(-HOUR, at(-MINUTE))),
      coded("D", { ...scheduled(3 * HOUR) }),
    ];

    const groups = groupMeetingsByActivity(meetings, new Map([["A", 1]]), NOW);

    expect(
      groups.ongoing.length + groups.upcoming.length + groups.past.length,
    ).toBe(meetings.length);
  });

  it("sorts ongoing newest first and upcoming soonest first", () => {
    const older = coded("OLD", instant(-40 * MINUTE));
    const newer = coded("NEW", instant(-5 * MINUTE));
    const later = coded("LATER", { ...scheduled(5 * HOUR) });
    const sooner = coded("SOONER", { ...scheduled(HOUR) });

    const groups = groupMeetingsByActivity(
      [older, later, newer, sooner],
      new Map([
        ["OLD", 1],
        ["NEW", 1],
      ]),
      NOW,
    );

    expect(groups.ongoing).toEqual([newer, older]);
    expect(groups.upcoming).toEqual([sooner, later]);
  });

  it("does not mutate its input", () => {
    const meetings = [
      coded("A", instant(-MINUTE)),
      coded("B", instant(-2 * MINUTE)),
    ];
    const snapshot = [...meetings];

    groupMeetingsByActivity(meetings, new Map(), NOW);

    expect(meetings).toEqual(snapshot);
  });
});
