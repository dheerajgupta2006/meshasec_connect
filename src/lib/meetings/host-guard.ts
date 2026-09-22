import "server-only";

/**
 * The single host check for the meeting feature.
 *
 * Extracted so moderation, roles and the polls actions all gate on the same
 * logic. Two copies of a permission check are two chances for them to drift, and
 * the one that drifts is the one that gets exploited.
 *
 * Every answer here is derived from the meeting row and the caller's session.
 * Nothing the caller sends contributes to the decision beyond naming which
 * meeting they mean.
 */

import { actingHostId } from "@/lib/meetings/host-succession";
import { prisma } from "@/lib/prisma";
import { ensureCurrentUser } from "@/lib/users/current-user";

/**
 * One refusal for every gate failure: not signed in, not the host, no such
 * meeting. Distinguishing them would let anyone probe meeting codes and learn who
 * hosts what.
 */
export const NOT_HOST = "Only the host can do that.";

export interface HostContext {
  meetingId: string;
  meetingCode: string;
  /** Clerk subject, which is what LiveKit uses as the participant identity. */
  hostClerkId: string | null;
  localUserId: string;
  /** True only for the meeting owner, false for a co-host. */
  isOwner: boolean;
  /**
   * The caller's own LiveKit identity. Needed when an action has to name the
   * moderator who performed it, as the poll actions do.
   */
  actorIdentity: string | null;
}

/**
 * Resolves the caller and proves they may moderate `meetingCode`.
 *
 * `level` separates the two tiers deliberately:
 * - `"moderator"` admits the host *and* co-hosts. Muting, removing, locking,
 *   admitting, and running polls are all delegated powers.
 * - `"owner"` admits only the host. Ending the meeting and appointing co-hosts are
 *   ownership, not moderation — a co-host who could do either would be able to
 *   close someone else's meeting or make the role self-propagating.
 *
 * Returns null on any failure so a caller cannot mistake a refusal for success.
 * The refusal message is intentionally identical for "not permitted" and "no such
 * meeting", so meeting codes cannot be probed.
 *
 * A guest has no `User` row, so `ensureCurrentUser` returns null for them and
 * they can never pass this gate — which is the intended outcome, not an accident.
 */
export async function requireMeetingHost(
  meetingCode: string,
  level: "owner" | "moderator" = "moderator",
): Promise<HostContext | null> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return null;
  }

  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode },
    select: {
      id: true,
      meetingCode: true,
      hostId: true,
      currentHostId: true,
      participants: {
        where: { userId: me.id, isCoHost: true },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (meeting === null) {
    return null;
  }

  // The acting host, which may be a successor rather than the creator.
  const actingId = actingHostId(meeting);
  const isOwner = actingId === me.id;
  const isCreator = meeting.hostId === me.id;
  const isCoHost = meeting.participants.length > 0;

  if (level === "owner" && !isOwner) {
    return null;
  }

  // The creator keeps moderation rights after handing the room over: opening a
  // meeting must never leave you unable to moderate it.
  if (!isOwner && !isCreator && !isCoHost) {
    return null;
  }

  const acting = await prisma.user.findUnique({
    where: { id: actingId },
    select: { clerkId: true },
  });

  return {
    meetingId: meeting.id,
    meetingCode: meeting.meetingCode,
    hostClerkId: acting?.clerkId ?? null,
    localUserId: me.id,
    isOwner,
    actorIdentity: me.clerkId,
  };
}
