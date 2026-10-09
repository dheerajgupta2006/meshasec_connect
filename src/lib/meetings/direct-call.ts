import "server-only";

import {
  DIRECT_CALL_CHAT_TOPIC,
  encodeDirectCallChatEnvelope,
  type PersistedCallMessage,
} from "@/lib/meetings/direct-call-chat";
import { broadcastRoomData } from "@/lib/meetings/livekit-admin";
import { prisma } from "@/lib/prisma";

/**
 * Resolves the other endpoint of an unexpanded, genuine direct contact call.
 *
 * The caller supplies only the meeting code. The browser never supplies a DM
 * recipient: accepting one would let any member of any meeting choose which
 * contact receives a copy of room chat.
 *
 * Every condition is deliberate:
 * - `directCallPeerId` proves `startDirectCall` created the room;
 * - `directCallExpandedAt: null` proves no third person has been invited/admitted;
 * - `groupId: null` is defence in depth against future creation-path drift;
 * - `endsAt: null` prevents a stale client writing after the call ended;
 * - endpoint + Participant checks prove the caller is one of the original pair
 *   and still enrolled (removal deletes that row).
 */
export interface DirectCallContext {
  meetingId: string;
  peerId: string;
  /** Clerk subject, which is the peer's LiveKit identity. */
  peerIdentity: string;
}

export async function resolveDirectCallContext(
  meetingCode: string,
  callerId: string,
): Promise<DirectCallContext | null> {
  const meeting = await prisma.meeting.findFirst({
    where: {
      meetingCode,
      isPrivate: true,
      groupId: null,
      endsAt: null,
      directCallPeerId: { not: null },
      directCallExpandedAt: null,
      OR: [{ hostId: callerId }, { directCallPeerId: callerId }],
      participants: { some: { userId: callerId } },
    },
    select: {
      id: true,
      hostId: true,
      directCallPeerId: true,
      host: { select: { clerkId: true } },
      directCallPeer: { select: { clerkId: true } },
      participants: { select: { userId: true } },
    },
  });

  if (
    meeting === null ||
    meeting.directCallPeerId === null ||
    meeting.directCallPeer === null
  ) {
    return null;
  }

  const endpointIds = [meeting.hostId, meeting.directCallPeerId];
  const bothEndpointsEnrolled =
    meeting.participants.some(
      (participant) => participant.userId === meeting.hostId,
    ) &&
    meeting.participants.some(
      (participant) => participant.userId === meeting.directCallPeerId,
    );
  const noOutsideAccounts = meeting.participants.every((participant) =>
    endpointIds.includes(participant.userId),
  );

  if (!bothEndpointsEnrolled || !noOutsideAccounts) {
    return null;
  }

  const peerId =
    meeting.hostId === callerId ? meeting.directCallPeerId : meeting.hostId;
  const peerIdentity =
    meeting.hostId === callerId
      ? meeting.directCallPeer.clerkId
      : meeting.host.clerkId;

  if (peerIdentity === null) {
    return null;
  }

  return { meetingId: meeting.id, peerId, peerIdentity };
}

/** Convenience for capability checks that need only the counterpart. */
export async function resolveDirectCallPeer(
  meetingCode: string,
  callerId: string,
): Promise<string | null> {
  return (await resolveDirectCallContext(meetingCode, callerId))?.peerId ?? null;
}

/**
 * Permanently disables call-chat-to-DM persistence for a direct room.
 *
 * Idempotent and intentionally never cleared. Once content has been visible to a
 * third person, later shrinking the room back to two does not make that content a
 * private two-party conversation retroactively.
 */
export async function markDirectCallExpanded(meetingId: string): Promise<void> {
  await prisma.meeting.updateMany({
    where: {
      id: meetingId,
      directCallPeerId: { not: null },
      directCallExpandedAt: null,
    },
    data: { directCallExpandedAt: new Date() },
  });
}

/** Marks expansion only when the joining account is outside the original pair. */
export async function markDirectCallExpandedByParticipant(
  meetingId: string,
  participantId: string,
): Promise<void> {
  await prisma.meeting.updateMany({
    where: {
      id: meetingId,
      directCallPeerId: { not: null },
      directCallExpandedAt: null,
      NOT: [{ hostId: participantId }, { directCallPeerId: participantId }],
    },
    data: { directCallExpandedAt: new Date() },
  });
}

/**
 * Publishes a committed DM into the active room from the LiveKit server.
 *
 * A participant packet always carries the participant identity. A packet sent by
 * `RoomServiceClient.sendData` carries no participant sender, giving recipients an
 * origin marker a browser cannot forge. Persistence has already succeeded when
 * this runs; failure therefore affects only live delivery, never the DM copy.
 */
export async function broadcastPersistedDirectCallMessage(
  meetingCode: string,
  message: PersistedCallMessage,
): Promise<boolean> {
  const outcome = await broadcastRoomData(
    meetingCode,
    DIRECT_CALL_CHAT_TOPIC,
    encodeDirectCallChatEnvelope(message),
  );

  return outcome.ok;
}
