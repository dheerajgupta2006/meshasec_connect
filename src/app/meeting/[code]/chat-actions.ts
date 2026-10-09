"use server";

import {
  broadcastPersistedDirectCallMessage,
  resolveDirectCallContext,
} from "@/lib/meetings/direct-call";
import {
  checkMessageWriteQuota,
  deliverDirectMessage,
  messageAttemptExists,
  type SendMessageResult,
  validateMessageBody,
} from "@/lib/messages/send";
import { ensureCurrentUser } from "@/lib/users/current-user";

const MAX_MEETING_CODE_CHARS = 128;
const MAX_CLIENT_ID_CHARS = 64;

export type DirectCallTextResult =
  | {
      mode: "persisted";
      result: SendMessageResult;
      /** False means it is in DMs but LiveKit server delivery failed. */
      liveDelivered: boolean;
    }
  | { mode: "ephemeral" }
  | { mode: "failed"; message: string };

export interface DirectCallChatCapability {
  enabled: boolean;
  /** Verified LiveKit identity of the other endpoint; null when unavailable. */
  peerIdentity: string | null;
}

/** UI capability only; every send re-runs the same authorization. */
export async function directCallChatCapability(
  rawMeetingCode: unknown,
): Promise<DirectCallChatCapability> {
  if (
    typeof rawMeetingCode !== "string" ||
    rawMeetingCode.trim().length === 0 ||
    rawMeetingCode.length > MAX_MEETING_CODE_CHARS
  ) {
    return { enabled: false, peerIdentity: null };
  }

  const me = await ensureCurrentUser();

  if (me === null) {
    return { enabled: false, peerIdentity: null };
  }

  const context = await resolveDirectCallContext(rawMeetingCode.trim(), me.id);

  return context === null
    ? { enabled: false, peerIdentity: null }
    : { enabled: true, peerIdentity: context.peerIdentity };
}

/**
 * Persists an authored in-call text message when this is a genuine, unexpanded
 * contact call.
 *
 * The browser cannot choose a recipient. It supplies only the room code, and the
 * server resolves the immutable opposite endpoint from Meeting provenance. A
 * group, guest-expanded, invite-only, legacy, ended, or removed-participant room
 * gets `ephemeral` and continues to use ordinary LiveKit chat without touching a
 * DM.
 *
 * Join/leave notices can never reach this action: they are created in the chat
 * provider's local `systemEntries` branch and only the composer calls here.
 */
export async function sendDirectCallText(
  rawMeetingCode: unknown,
  rawBody: unknown,
  rawClientId: unknown,
): Promise<DirectCallTextResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { mode: "failed", message: "Your session has ended." };
  }

  if (
    typeof rawMeetingCode !== "string" ||
    rawMeetingCode.trim().length === 0 ||
    rawMeetingCode.length > MAX_MEETING_CODE_CHARS ||
    typeof rawBody !== "string" ||
    typeof rawClientId !== "string" ||
    rawClientId.trim().length === 0 ||
    rawClientId.length > MAX_CLIENT_ID_CHARS
  ) {
    return { mode: "failed", message: "That message could not be sent." };
  }

  const body = validateMessageBody(rawBody);

  if (!body.ok) {
    return { mode: "failed", message: body.message };
  }

  const meetingCode = rawMeetingCode.trim();
  const clientId = rawClientId.trim();
  const directCall = await resolveDirectCallContext(meetingCode, me.id);

  if (directCall === null) {
    return { mode: "ephemeral" };
  }

  const recipientId = directCall.peerId;

  // A response lost after commit is retried with the same id. It must not consume
  // quota again or turn a successful call message into an error.
  if (!(await messageAttemptExists(me.id, clientId))) {
    const throttled = checkMessageWriteQuota(me.id);

    if (throttled !== null) {
      return { mode: "failed", message: throttled.message };
    }
  }

  try {
    const result = await deliverDirectMessage(me, {
      recipientId,
      body: body.body,
      clientId,
      attachment: null,
      sourceMeetingId: directCall.meetingId,
    });

    const liveDelivered =
      result.ok && result.sent !== null
        ? await broadcastPersistedDirectCallMessage(meetingCode, {
            id: result.sent.id,
            createdAt: result.sent.createdAt,
            senderIdentity: me.clerkId,
            body: result.sent.body,
            attachment: result.sent.attachment,
          })
        : false;

    return { mode: "persisted", result, liveDelivered };
  } catch {
    return { mode: "failed", message: "That message could not be saved." };
  }
}
