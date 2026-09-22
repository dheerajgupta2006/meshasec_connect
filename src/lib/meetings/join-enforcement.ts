import "server-only";

/**
 * Whether someone who has just appeared in a LiveKit room is actually allowed in.
 *
 * This exists because of a gap that no amount of care in the moderation actions
 * can close on its own. A LiveKit access token is validated by the media server at
 * connect time and nowhere else, and it is handed to the browser in a JSON
 * response — so it can be lifted out of devtools and replayed with
 * `room.connect()` directly. That request never reaches this app, which means
 * `isGuestBanned`, `authorizeMeetingJoin`, the DENIED knock and `isLocked` are all
 * bypassed. Shortening the token TTL bounds that window; only asking LiveKit to
 * tell us about joins closes it.
 *
 * So the `participant_joined` webhook calls this, and anyone barred is evicted
 * again immediately. Removal, bans and room lock become enforced at the media
 * server rather than merely recorded in the database.
 */

import { guestIdFromIdentity } from "@/lib/meetings/guest-session";
import { prisma } from "@/lib/prisma";
import { KnockStatus } from "@prisma/client";

/** Why a participant may not be in the room, or null when they may. */
export type JoinBar = "banned" | "removed" | "locked" | "no_meeting";

/**
 * Decides whether `identity` belongs in `meetingCode`.
 *
 * Mirrors exactly what `removeFromMeeting` writes, which is the point — the two
 * must not be able to disagree:
 * - a guest is barred by a `MeetingGuestBan` row,
 * - a signed-in participant by a DENIED `WaitingRoomEntry`.
 *
 * A locked room bars anyone arriving *after* the lock. That is safe to apply here
 * because this only ever runs on a fresh join: LiveKit does not re-fire
 * `participant_joined` for people already connected when the lock went on, so
 * locking a room still cannot eject the people already in it.
 */
export async function joinBarFor(
  meetingCode: string,
  identity: string,
): Promise<JoinBar | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: { id: true, isLocked: true },
  });

  if (meeting === null) {
    return "no_meeting";
  }

  const guestId = guestIdFromIdentity(identity);

  if (guestId !== null) {
    const banned = await prisma.meetingGuestBan.findUnique({
      where: {
        meetingId_guestId: { meetingId: meeting.id, guestId },
      },
      select: { id: true },
    });

    if (banned !== null) {
      return "banned";
    }

    return meeting.isLocked ? "locked" : null;
  }

  // Not a guest, so the identity is the Clerk subject.
  const user = await prisma.user.findUnique({
    where: { clerkId: identity },
    select: { id: true },
  });

  // An identity that matches no account and is not a guest should not be in the
  // room at all — nothing in this app can mint a token for it.
  if (user === null) {
    return "removed";
  }

  const denied = await prisma.waitingRoomEntry.findUnique({
    where: {
      meetingId_userId: { meetingId: meeting.id, userId: user.id },
    },
    select: { status: true },
  });

  if (denied?.status === KnockStatus.DENIED) {
    return "removed";
  }

  return meeting.isLocked ? "locked" : null;
}
