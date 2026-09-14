import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizeMeetingJoin,
  recordAttendance,
} from "@/lib/meetings/authorization";

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
}

function meetingRow({
  isPrivate,
  hostId = HOST_ID,
  participantMatches = false,
}: MeetingRowOptions) {
  return {
    id: "meeting_1",
    meetingCode: MEETING_CODE,
    isPrivate,
    hostId,
    // Prisma applies the `where: { userId }` filter, so a non-empty array here
    // means "this viewer is enrolled".
    participants: participantMatches ? [{ id: "participant_1" }] : [],
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
