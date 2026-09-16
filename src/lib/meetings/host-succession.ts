import "server-only";

/**
 * Applies host succession against the database and the live room.
 *
 * Two triggers, because neither alone is sufficient:
 * - an explicit hang-up, which is reliable but only covers people who press Leave;
 * - a throttled check during the roles poll, which catches a closed tab or a
 *   dropped connection, where no server call ever happens.
 */

import { listOccupants } from "@/lib/meetings/livekit-admin";
import {
  needsSuccession,
  pickSuccessor,
  type SuccessionCandidate,
} from "@/lib/meetings/succession";
import { prisma } from "@/lib/prisma";

/**
 * Minimum gap between presence checks for one meeting.
 *
 * The check costs a LiveKit round trip, and every participant polls roles
 * independently, so without this a five-person call would make five times the
 * necessary requests. In-memory and therefore per-instance: on a multi-instance
 * deployment the real rate is this divided by the instance count, which is
 * acceptable for a best-effort repair.
 */
const CHECK_INTERVAL_MS = 12_000;

const lastChecked = new Map<string, number>();

/** The user currently running the meeting: the successor, or the creator. */
export function actingHostId(meeting: {
  hostId: string;
  currentHostId: string | null;
}): string {
  return meeting.currentHostId ?? meeting.hostId;
}

interface MeetingForSuccession {
  id: string;
  meetingCode: string;
  hostId: string;
  currentHostId: string | null;
}

interface Roster {
  candidates: SuccessionCandidate[];
  /** Read from the live room, never inferred from enrollment rows. */
  actingHostPresent: boolean;
}

async function buildRoster(
  meeting: MeetingForSuccession,
  actingId: string,
): Promise<Roster | null> {
  const occupants = await listOccupants(meeting.meetingCode);

  // `listOccupants` returns an empty array both for an empty room and for an
  // unreachable LiveKit. Treating "cannot tell" as "empty" would hand the room to
  // nobody, or worse, repeatedly reassign it — so bail out instead.
  if (occupants.length === 0) {
    return null;
  }

  const presentIdentities = new Set(
    occupants.map((occupant) => occupant.identity),
  );

  const [participants, actingHost] = await Promise.all([
    prisma.participant.findMany({
      where: { meetingId: meeting.id },
      select: {
        userId: true,
        joinedAt: true,
        isCoHost: true,
        user: { select: { clerkId: true } },
      },
    }),
    // Looked up separately and deliberately. The acting host frequently has no
    // enrollment row — creating a meeting does not make one, and the admission
    // check never needs one for the owner — so their presence cannot be read off
    // the participant list.
    prisma.user.findUnique({
      where: { id: actingId },
      select: { clerkId: true },
    }),
  ]);

  const candidates: SuccessionCandidate[] = [];

  participants.forEach((participant) => {
    const identity = participant.user.clerkId;

    if (identity === null) {
      return;
    }

    candidates.push({
      userId: participant.userId,
      identity,
      joinedAt: participant.joinedAt.getTime(),
      isCoHost: participant.isCoHost,
      isPresent: presentIdentities.has(identity),
    });
  });

  const actingHostPresent =
    actingHost?.clerkId !== null &&
    actingHost?.clerkId !== undefined &&
    presentIdentities.has(actingHost.clerkId);

  return { candidates, actingHostPresent };
}

/**
 * Transfers the host role if the acting host is gone and others remain.
 *
 * Returns the new acting host id, which is unchanged when no handoff happened.
 *
 * The write is a compare-and-set on `currentHostId`, so concurrent callers — every
 * participant polls independently — converge on one outcome instead of fighting.
 * `pickSuccessor` is deterministic for the same input, so they all choose the same
 * person anyway.
 */
export async function applyHostSuccession(
  meeting: MeetingForSuccession,
): Promise<string> {
  const acting = actingHostId(meeting);

  const roster = await buildRoster(meeting, acting);

  if (roster === null) {
    return acting;
  }

  if (
    !needsSuccession(roster.candidates, acting, roster.actingHostPresent)
  ) {
    return acting;
  }

  const successor = pickSuccessor(roster.candidates, acting);

  if (successor === null) {
    return acting;
  }

  const updated = await prisma.meeting.updateMany({
    // Compare-and-set: only the caller that still sees the old value wins.
    where: { id: meeting.id, currentHostId: meeting.currentHostId },
    data: { currentHostId: successor.userId },
  });

  if (updated.count === 0) {
    // Someone else promoted a successor first. Their choice stands.
    return acting;
  }

  // The new host no longer needs a co-host grant; holding both would show two
  // badges for the same person.
  await prisma.participant
    .updateMany({
      where: { meetingId: meeting.id, userId: successor.userId },
      data: { isCoHost: false },
    })
    .catch(() => undefined);

  return successor.userId;
}

/**
 * Runs succession at most once per interval for a given meeting.
 *
 * Called from the roles poll, which every participant runs. Without the throttle
 * the LiveKit request count would scale with the number of people in the call.
 */
export async function maybeApplyHostSuccession(
  meeting: MeetingForSuccession,
): Promise<string> {
  const now = Date.now();
  const previous = lastChecked.get(meeting.id) ?? 0;

  if (now - previous < CHECK_INTERVAL_MS) {
    return actingHostId(meeting);
  }

  lastChecked.set(meeting.id, now);

  try {
    return await applyHostSuccession(meeting);
  } catch {
    // A failed handoff must not break the roles read that triggered it.
    return actingHostId(meeting);
  }
}
