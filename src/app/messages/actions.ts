"use server";

/**
 * Server Actions for direct messaging.
 *
 * The connection gate lives server-side, not in the UI: an ACCEPTED connection
 * is re-verified on every send, so revoking a connection immediately closes the
 * ability to write.
 *
 * Writing a message is delegated to `lib/messages/send.ts`, which the attachment
 * upload route uses too, so the gates are defined exactly once.
 */

import { revalidatePath } from "next/cache";

import { areUsersConnected } from "@/lib/connections/queries";
import {
  isMissingAttachmentSchema,
  loadAttachmentSummaries,
  purgeAttachment,
} from "@/lib/messages/attachments";
import { searchMessages } from "@/lib/messages/queries";
import {
  SIGN_IN_REQUIRED,
  checkMessageWriteQuota,
  deliverDirectMessage,
  messageAttemptExists,
  notConnectedMessage,
  validateMessageBody,
  type MessageActionResult,
  type SendMessageResult,
} from "@/lib/messages/send";
import { prisma } from "@/lib/prisma";
import { ensureCurrentUser } from "@/lib/users/current-user";

/**
 * Deliberately identical for "not yours" and "does not exist".
 *
 * A distinct not-found response would let anyone probe message ids to learn
 * which ones are real, so both cases collapse into one refusal.
 */
const NOT_YOURS = "You can only change messages you sent.";

/** The quota check, without the retry hint a Server Action has no header for. */
function checkWriteQuota(userId: string): MessageActionResult | null {
  const throttled = checkMessageWriteQuota(userId);

  return throttled === null
    ? null
    : { ok: false, message: throttled.message };
}

function revalidateThread(username: string | null): void {
  revalidatePath("/messages");

  if (username !== null) {
    revalidatePath(`/messages/${username}`);
  }
}

/** Sends a text message. Attachments go through `/api/direct-messages/attachments`. */
export async function sendDirectMessage(
  recipientId: string,
  rawBody: string,
  clientId?: string,
  replyToId?: string,
): Promise<SendMessageResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, sent: null };
  }

  const validated = validateMessageBody(rawBody);

  if (!validated.ok) {
    return { ok: false, message: validated.message, sent: null };
  }

  // A replay of a committed idempotency key performs no write. Do not let a
  // response lost in transit turn a successful send into a rate-limit error.
  if (!(await messageAttemptExists(me.id, clientId))) {
    const throttled = checkWriteQuota(me.id);

    if (throttled !== null) {
      return { ...throttled, sent: null };
    }
  }

  return deliverDirectMessage(me, {
    recipientId,
    body: validated.body,
    clientId,
    replyToId,
    attachment: null,
  });
}

/**
 * Rewrites a message the caller sent.
 *
 * Ownership is resolved from the row, never from the caller, and the connection
 * gate is re-checked exactly as it is on send — losing the connection closes
 * editing too. On an attachment this edits the caption; the file itself cannot
 * be changed.
 */
export async function editDirectMessage(
  messageId: string,
  newBody: string,
): Promise<MessageActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const throttled = checkWriteQuota(me.id);

  if (throttled !== null) {
    return throttled;
  }

  // Empty text is valid only when the existing message has an attachment: it
  // means "remove the caption", not "turn a text message into an empty bubble".
  // Length and trimming can be checked before loading the row; the attachment
  // condition is checked once ownership is known below.
  const validated = validateMessageBody(newBody, { allowEmpty: true });

  if (!validated.ok) {
    return { ok: false, message: validated.message };
  }

  const existing = await prisma.directMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      body: true,
      senderId: true,
      receiverId: true,
      deletedAt: true,
      receiver: { select: { username: true } },
    },
  });

  if (existing === null || existing.senderId !== me.id) {
    return { ok: false, message: NOT_YOURS };
  }

  if (existing.deletedAt !== null) {
    return { ok: false, message: "That message was deleted." };
  }

  const connected = await areUsersConnected(me.id, existing.receiverId);

  if (!connected) {
    return {
      ok: false,
      message: notConnectedMessage(existing.receiver.username ?? "this user"),
    };
  }

  // Saving identical text is a no-op rather than a write, so re-submitting an
  // unchanged draft cannot stamp a message as edited. This also keeps an
  // already-empty attachment caption editable during a rolling deployment if
  // its attachment table is not visible to this instance yet.
  if (validated.body === existing.body) {
    return { ok: true, message: "No changes." };
  }

  if (validated.body.length === 0) {
    const attachments = await loadAttachmentSummaries([existing.id]);

    if (!attachments.has(existing.id)) {
      return { ok: false, message: "Write a message first." };
    }
  }

  await prisma.directMessage.update({
    where: { id: existing.id },
    data: { body: validated.body, editedAt: new Date() },
    select: { id: true },
  });

  revalidateThread(existing.receiver.username);

  return { ok: true, message: "Edited." };
}

/**
 * Soft-deletes a message the caller sent.
 *
 * The row is kept so replies pointing at it keep their context, and the read
 * layer stops serving the body. An attached file is removed outright: it is the
 * privacy-sensitive part, and nothing needs it once the message is gone.
 */
export async function deleteDirectMessage(
  messageId: string,
): Promise<MessageActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const throttled = checkWriteQuota(me.id);

  if (throttled !== null) {
    return throttled;
  }

  const existing = await prisma.directMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      senderId: true,
      deletedAt: true,
      receiver: { select: { username: true } },
    },
  });

  if (existing === null || existing.senderId !== me.id) {
    return { ok: false, message: NOT_YOURS };
  }

  // A live message and its private bytes disappear in one transaction. If either
  // mutation fails, the message stays visible with its Delete control so the
  // user can retry; there is no hidden attachment orphan. During a rolling
  // deployment the attachment table may not exist yet, in which case the
  // transaction rolls back and the old text-only soft delete remains available.
  if (existing.deletedAt === null) {
    try {
      await prisma.$transaction([
        prisma.directMessage.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
          select: { id: true },
        }),
        prisma.directMessageAttachment.deleteMany({
          where: { messageId: existing.id },
        }),
      ]);
    } catch (error: unknown) {
      if (!isMissingAttachmentSchema(error)) {
        throw error;
      }

      await prisma.directMessage.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
    }
  } else {
    // Compatibility cleanup for a row deleted by an older deployment where the
    // two mutations were separate. Idempotent and tolerant of a missing table.
    await purgeAttachment(existing.id);
  }

  revalidateThread(existing.receiver.username);

  return { ok: true, message: "Deleted." };
}

export interface MessageSearchResultView {
  id: string;
  snippet: string;
  createdAt: string;
  outgoing: boolean;
  personUsername: string;
  personName: string | null;
}

export interface MessageSearchActionResult {
  ok: boolean;
  message: string;
  results: MessageSearchResultView[];
}

/**
 * Client entry point for keyword search.
 *
 * The viewer id comes from the session here, never from the caller, so the query
 * underneath can only ever read threads this person is part of.
 */
export async function searchDirectMessages(
  rawQuery: string,
): Promise<MessageSearchActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, results: [] };
  }

  const hits = await searchMessages(me.id, rawQuery);

  return {
    ok: true,
    message:
      hits.length === 0 ? "No messages matched." : `${hits.length} match(es).`,
    results: hits.map((hit) => ({
      id: hit.id,
      snippet: hit.snippet,
      createdAt: hit.createdAt.toISOString(),
      outgoing: hit.outgoing,
      personUsername: hit.person.username,
      personName: hit.person.name,
    })),
  };
}

/** Marks everything the other person sent as read. */
export async function markThreadRead(
  otherUserId: string,
): Promise<MessageActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  await prisma.directMessage.updateMany({
    where: { receiverId: me.id, senderId: otherUserId, readAt: null },
    data: { readAt: new Date() },
  });

  revalidatePath("/messages");

  return { ok: true, message: "Marked as read." };
}
