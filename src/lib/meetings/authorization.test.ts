import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizeMeetingJoin,
  recordAttendance,
} from "@/lib/meetings/authorization";
import { RATE_LIMITS } from "@/lib/rate-limit";

/**
 * Room admission is the security boundary that keeps a leaked meeting code from
 * becoming a listening device on a private 1-on-1 call. Prisma is mocked so the
 * decision logic is exercised without a database, and so the `where` clauses can
 * be asserted directly — a query that forgets to scope by user is the exact bug
 * this file exists to catch.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    meeting: {
      findUnique: vi.fn(),
    },
    participant: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const HOST_ID = "user_host";
const PARTICIPANT_ID = "user_participant";
const STRANGER_ID = "user_stranger";
const MEETING_CODE = "AbCdEfGhIjKlMnOpQrStUv";

interface MeetingRowOptions {
  isPrivate: boolean;
  hostId?: string;
  participantMatches?: boolean;
  /** Null models a room created before passcodes existed. */
  passcode?: string | null;
  isLocked?: boolean;
  waitingRoomEnabled?: boolean;
  /** The viewer's own knock row, or null when they have never knocked. */
  knockStatus?: "PENDING" | "ADMITTED" | "DENIED" | null;
}

function meetingRow({
  isPrivate,
  hostId = HOST_ID,
  participantMatches = false,
  passcode = null,
  isLocked = false,
  waitingRoomEnabled = false,
  knockStatus = null,
}: MeetingRowOptions) {
  return {
    id: "meeting_1",
    meetingCode: MEETING_CODE,
    isPrivate,
    hostId,
    passcode,
    isLocked,
    waitingRoomEnabled,
    // Prisma applies the `where: { userId }` filter, so a non-empty array here
    // means "this viewer is enrolled".
    participants: participantMatches ? [{ id: "participant_1" }] : [],
    knocks: knockStatus === null ? [] : [{ status: knockStatus }],
  };
}

beforeEach(() => {
  prismaMock.meeting.findUnique.mockReset();
  prismaMock.participant.upsert.mockReset();
  prismaMock.participant.upsert.mockResolvedValue({ id: "participant_1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authorizeMeetingJoin", () => {
  it("reports not_found for an unknown code rather than leaking existence", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(null);

    const decision = await authorizeMeetingJoin("nope", STRANGER_ID);

    expect(decision).toEqual({ allowed: false, reason: "not_found" });
  });

  it("refuses a stranger on a private meeting even with the correct code", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, STRANGER_ID);

    expect(decision).toEqual({ allowed: false, reason: "forbidden" });
  });

  it("admits the host of a private meeting and treats them as enrolled", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, HOST_ID);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.enrolled).toBe(true);
      expect(decision.meeting.meetingCode).toBe(MEETING_CODE);
      expect(decision.meeting.isPrivate).toBe(true);
    }
  });

  it("admits an invited participant of a private meeting", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, participantMatches: true }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, PARTICIPANT_ID);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.enrolled).toBe(true);
    }
  });

  it("admits a link-holder to an open meeting but marks them not yet enrolled", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: false }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, STRANGER_ID);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      // False is what drives the caller to record attendance, which is how an
      // invite-link join reaches the joiner's dashboard history.
      expect(decision.enrolled).toBe(false);
    }
  });

  it("never leaks the host id or the raw participant rows to the caller", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: false }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, STRANGER_ID);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(Object.keys(decision.meeting).sort()).toEqual([
        "id",
        "isPrivate",
        "meetingCode",
      ]);
    }
  });

  it("scopes the participant lookup to the joining user", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, participantMatches: true }),
    );

    await authorizeMeetingJoin(MEETING_CODE, PARTICIPANT_ID);

    const args = prismaMock.meeting.findUnique.mock.calls[0]?.[0];
    expect(args.where).toEqual({ meetingCode: MEETING_CODE });
    // Without this filter every private meeting with any attendee would appear
    // joinable to everyone.
    expect(args.select.participants.where).toEqual({ userId: PARTICIPANT_ID });
  });

  it("holds the admission rule for every combination of privacy and membership", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (isPrivate, isHost, isParticipant) => {
          prismaMock.meeting.findUnique.mockResolvedValue(
            meetingRow({
              isPrivate,
              hostId: isHost ? STRANGER_ID : HOST_ID,
              participantMatches: isParticipant,
            }),
          );

          const decision = await authorizeMeetingJoin(
            MEETING_CODE,
            STRANGER_ID,
          );

          const expected = !isPrivate || isHost || isParticipant;
          expect(decision.allowed).toBe(expected);

          if (decision.allowed) {
            expect(decision.enrolled).toBe(isHost || isParticipant);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("authorizeMeetingJoin — room passcode", () => {
  const PASSCODE = "839201";

  /** Unique per test so the shared attempt-limit map cannot leak between them. */
  let guestCounter = 0;
  function nextGuest(): string {
    guestCounter += 1;
    return `guest_${guestCounter}_${Math.random().toString(36).slice(2)}`;
  }

  it("asks for a passcode when a guest supplies none", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, nextGuest());

    expect(decision).toEqual({ allowed: false, reason: "passcode_required" });
  });

  it("admits a guest who supplies the correct passcode", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );

    const decision = await authorizeMeetingJoin(
      MEETING_CODE,
      nextGuest(),
      PASSCODE,
    );

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      // Not yet enrolled, which is what makes the caller record attendance.
      expect(decision.enrolled).toBe(false);
    }
  });

  it("accepts a passcode pasted with spaces or dashes", async () => {
    for (const typed of ["839 201", "839-201", " 839201 "]) {
      prismaMock.meeting.findUnique.mockResolvedValue(
        meetingRow({ isPrivate: true, passcode: PASSCODE }),
      );

      const decision = await authorizeMeetingJoin(
        MEETING_CODE,
        nextGuest(),
        typed,
      );

      expect(decision.allowed).toBe(true);
    }
  });

  it("rejects a wrong passcode distinctly from a missing one", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );

    const decision = await authorizeMeetingJoin(
      MEETING_CODE,
      nextGuest(),
      "000000",
    );

    expect(decision).toEqual({ allowed: false, reason: "passcode_invalid" });
  });

  it("treats a malformed passcode as missing rather than wrong", async () => {
    // Nothing six-digit was supplied, so there is no guess to charge for.
    for (const malformed of ["", "12", "abcdef", "12345678"]) {
      prismaMock.meeting.findUnique.mockResolvedValue(
        meetingRow({ isPrivate: true, passcode: PASSCODE }),
      );

      const decision = await authorizeMeetingJoin(
        MEETING_CODE,
        nextGuest(),
        malformed,
      );

      expect(decision).toEqual({ allowed: false, reason: "passcode_required" });
    }
  });

  it("refuses a private room that has no passcode set", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: null }),
    );

    const decision = await authorizeMeetingJoin(
      MEETING_CODE,
      nextGuest(),
      PASSCODE,
    );

    // Indistinguishable from "not invited": a room with no passcode must not
    // reveal that a passcode is what is missing.
    expect(decision).toEqual({ allowed: false, reason: "forbidden" });
  });

  it("never prompts the host or an enrolled participant", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );
    expect((await authorizeMeetingJoin(MEETING_CODE, HOST_ID)).allowed).toBe(
      true,
    );

    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: true,
        passcode: PASSCODE,
        participantMatches: true,
      }),
    );
    expect(
      (await authorizeMeetingJoin(MEETING_CODE, PARTICIPANT_ID)).allowed,
    ).toBe(true);
  });

  it("does not require a passcode for an open meeting", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: false, passcode: PASSCODE }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, nextGuest());

    // Requiring one here would break every invite link already in circulation.
    expect(decision.allowed).toBe(true);
  });

  it("throttles repeated wrong guesses so six digits cannot be walked", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );

    const guest = nextGuest();
    const limit = RATE_LIMITS.meetingPasscode.limit;
    let throttled = false;

    for (let attempt = 0; attempt < limit + 2; attempt += 1) {
      const decision = await authorizeMeetingJoin(
        MEETING_CODE,
        guest,
        "000000",
      );

      if (!decision.allowed && decision.reason === "passcode_throttled") {
        throttled = true;
        expect(decision.retryAfterSeconds).toBeGreaterThan(0);
        break;
      }
    }

    expect(throttled).toBe(true);
  });

  it("never charges attempt budget for a correct passcode", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );

    const guest = nextGuest();

    // Well past the raw attempt budget. Rejoining a room repeatedly — a reconnect
    // loop on a flaky network does exactly this — must never lock a guest out of
    // a room they can open.
    for (let attempt = 0; attempt < RATE_LIMITS.meetingPasscode.limit * 3; attempt += 1) {
      const decision = await authorizeMeetingJoin(
        MEETING_CODE,
        guest,
        PASSCODE,
      );

      expect(decision.allowed).toBe(true);
    }
  });

  it("still admits a guest who mistypes a few times and then gets it right", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );

    const guest = nextGuest();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wrong = await authorizeMeetingJoin(MEETING_CODE, guest, "000000");
      expect(wrong.allowed).toBe(false);
    }

    const right = await authorizeMeetingJoin(MEETING_CODE, guest, PASSCODE);
    expect(right.allowed).toBe(true);
  });

  it("scopes the attempt budget per meeting and per user", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, passcode: PASSCODE }),
    );

    const attacker = nextGuest();

    for (let attempt = 0; attempt < RATE_LIMITS.meetingPasscode.limit + 2; attempt += 1) {
      await authorizeMeetingJoin(MEETING_CODE, attacker, "000000");
    }

    // A different guest on the same room is unaffected, so one attacker cannot
    // lock out the people who were legitimately invited.
    const bystander = await authorizeMeetingJoin(
      MEETING_CODE,
      nextGuest(),
      PASSCODE,
    );

    expect(bystander.allowed).toBe(true);
  });
});

describe("authorizeMeetingJoin — host moderation", () => {
  const PASSCODE = "839201";

  let guestCounter = 0;
  function nextGuest(): string {
    guestCounter += 1;
    return `modguest_${guestCounter}_${Math.random().toString(36).slice(2)}`;
  }

  it("refuses an unenrolled guest when the meeting is locked", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: false, isLocked: true }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, nextGuest());

    expect(decision).toEqual({ allowed: false, reason: "locked" });
  });

  it("does not eject existing participants when locked", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: false,
        isLocked: true,
        participantMatches: true,
      }),
    );

    // Locking is about new arrivals. Kicking out the people already talking
    // would make the button unusable.
    expect(
      (await authorizeMeetingJoin(MEETING_CODE, PARTICIPANT_ID)).allowed,
    ).toBe(true);
  });

  it("never locks the host out of their own meeting", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, isLocked: true, waitingRoomEnabled: true }),
    );

    expect((await authorizeMeetingJoin(MEETING_CODE, HOST_ID)).allowed).toBe(
      true,
    );
  });

  it("holds a guest for the host when the waiting room is on", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: false, waitingRoomEnabled: true }),
    );

    const decision = await authorizeMeetingJoin(MEETING_CODE, nextGuest());

    expect(decision).toEqual({ allowed: false, reason: "waiting_for_host" });
  });

  it("admits a guest the host has approved", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: false,
        waitingRoomEnabled: true,
        knockStatus: "ADMITTED",
      }),
    );

    expect((await authorizeMeetingJoin(MEETING_CODE, nextGuest())).allowed).toBe(
      true,
    );
  });

  it("applies the waiting room after the passcode, not instead of it", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: true,
        passcode: PASSCODE,
        waitingRoomEnabled: true,
      }),
    );

    // Wrong passcode is still reported as such: the waiting room must not become
    // a way to skip the passcode.
    const wrong = await authorizeMeetingJoin(
      MEETING_CODE,
      nextGuest(),
      "000000",
    );
    expect(wrong).toEqual({ allowed: false, reason: "passcode_invalid" });

    // Correct passcode gets them as far as the queue, not into the room.
    const right = await authorizeMeetingJoin(
      MEETING_CODE,
      nextGuest(),
      PASSCODE,
    );
    expect(right).toEqual({ allowed: false, reason: "waiting_for_host" });
  });

  it("keeps a removed person out even though they were enrolled", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: false,
        participantMatches: true,
        knockStatus: "DENIED",
      }),
    );

    // This is the whole point of recording removal as a DENIED row: it has to
    // outrank the Participant row, or the person walks straight back in.
    const decision = await authorizeMeetingJoin(MEETING_CODE, PARTICIPANT_ID);

    expect(decision).toEqual({ allowed: false, reason: "removed" });
  });

  it("keeps a removed guest out even with the correct passcode", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: true,
        passcode: PASSCODE,
        knockStatus: "DENIED",
      }),
    );

    const decision = await authorizeMeetingJoin(
      MEETING_CODE,
      nextGuest(),
      PASSCODE,
    );

    expect(decision).toEqual({ allowed: false, reason: "removed" });
  });

  it("still admits the host even if they somehow hold a DENIED row", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: true, knockStatus: "DENIED" }),
    );

    expect((await authorizeMeetingJoin(MEETING_CODE, HOST_ID)).allowed).toBe(
      true,
    );
  });

  it("treats a pending knock as still waiting, not as approval", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: false,
        waitingRoomEnabled: true,
        knockStatus: "PENDING",
      }),
    );

    expect(await authorizeMeetingJoin(MEETING_CODE, nextGuest())).toEqual({
      allowed: false,
      reason: "waiting_for_host",
    });
  });

  it("ignores the waiting room when it is switched off", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({ isPrivate: false, waitingRoomEnabled: false }),
    );

    expect((await authorizeMeetingJoin(MEETING_CODE, nextGuest())).allowed).toBe(
      true,
    );
  });

  it("prioritises removal over lock, so the reason is the durable one", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue(
      meetingRow({
        isPrivate: false,
        isLocked: true,
        knockStatus: "DENIED",
      }),
    );

    // "removed" is permanent, "locked" is temporary. Reporting the temporary one
    // would suggest they could get in later.
    expect(await authorizeMeetingJoin(MEETING_CODE, nextGuest())).toEqual({
      allowed: false,
      reason: "removed",
    });
  });
});

describe("recordAttendance", () => {
  it("upserts on the composite key so repeat joins cannot duplicate a row", async () => {
    await recordAttendance("meeting_1", PARTICIPANT_ID);

    const args = prismaMock.participant.upsert.mock.calls[0]?.[0];
    expect(args.where).toEqual({
      userId_meetingId: { userId: PARTICIPANT_ID, meetingId: "meeting_1" },
    });
    expect(args.update).toEqual({});
  });

  it("is idempotent across repeated calls", async () => {
    await recordAttendance("meeting_1", PARTICIPANT_ID);
    await recordAttendance("meeting_1", PARTICIPANT_ID);
    await recordAttendance("meeting_1", PARTICIPANT_ID);

    expect(prismaMock.participant.upsert).toHaveBeenCalledTimes(3);
    for (const call of prismaMock.participant.upsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
  });

  it("swallows a write failure so bookkeeping cannot block an authorized join", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.participant.upsert.mockRejectedValue(
      new Error("connection pool timeout"),
    );

    await expect(
      recordAttendance("meeting_1", PARTICIPANT_ID),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });

  it("logs a non-Error rejection without crashing on `.message`", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.participant.upsert.mockRejectedValue("plain string rejection");

    await expect(
      recordAttendance("meeting_1", PARTICIPANT_ID),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });
});
