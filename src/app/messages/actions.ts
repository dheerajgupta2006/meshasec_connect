"use server";

/**
 * Server Actions for direct messaging.
 *
 * The connection gate lives here, not in the UI: an ACCEPTED connection is
 * re-verified on every send, so revoking a connection immediately closes the
 * ability to write.
 */

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { areUsersConnected } from "@/lib/connections/queries";
import { searchMessages } from "@/lib/messages/queries";
import { prisma } from "@/lib/prisma";
import { pushConfigured, sendPushToUser } from "@/lib/push/send";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser } from "@/lib/users/current-user";

/** Bounds the idempotency key so it cannot be used to store bulk data. */
const MAX_CLIENT_ID_CHARS = 64;

/** Keeps a push notification body to a glanceable length. */
const PUSH_PREVIEW_CHARS = 120;

export interface MessageActionResult {
  ok: boolean;
  message: string;
}

/**
 * The committed row, shaped exactly like the thread's wire format.
 *
 * Returned so the client can swap its optimistic bubble for the real message
 * without a follow-up fetch. Before this, a send cost four serialized requests
 * (action, poll, mark-read, refresh) before the text appeared at all.
 */
export interface SentMessageView {
  id: string;
  body: string;
  createdAt: string;
  outgoing: boolean;
  editedAt: string | null;
  deleted: boolean;
  replyTo: {
    id: string;
    body: string | null;
    deleted: boolean;
    outgoing: boolean;
  } | null;
}

export interface SendMessageResult extends MessageActionResult {
  /** Present only when `ok`; null on every refusal. */
  sent: SentMessageView | null;
}

const MAX_BODY_CHARS = 4000;
const SIGN_IN_REQUIRED = "Your session has ended. Sign in again to continue.";
/**
 * Deliberately identical for "not yours" and "does not exist".
 *
 * A distinct not-found response would let anyone probe message ids to learn
 * which ones are real, so both cases collapse into one refusal.
 */
const NOT_YOURS = "You can only change messages you sent.";

function notConnectedMessage(username: string): string {
  return `You must connect with @${username} and have your request accepted before calling or chatting.`;
}

/** Shared trim-and-bound check, so editing enforces exactly what sending does. */
function validateBody(
  rawBody: string,
): { ok: true; body: string } | { ok: false; message: string } {
  const body = rawBody.trim();

  if (body.length === 0) {
    return { ok: false, message: "Write a message first." };
  }

  if (body.length > MAX_BODY_CHARS) {
    return {
      ok: false,
      message: `Messages are limited to ${MAX_BODY_CHARS} characters.`,
    };
  }

  return { ok: true, body };
}

/**
 * Edits, deletes and sends all share the `directMessage` bucket.
 *
 * One bucket per person covers every write to the message table, which is the
 * behaviour worth bounding; splitting it would need a new rule in
 * `lib/rate-limit.ts`.
 */
function checkWriteQuota(userId: string): MessageActionResult | null {
  const throttled = consumeRateLimit("directMessage", userId);

  if (throttled.allowed) {
    return null;
  }

  return {
    ok: false,
    message: `You are sending messages too quickly. Try again in ${describeRetryAfter(
      throttled.retryAfterSeconds,
    )}.`,
  };
}

function revalidateThread(username: string | null): void {
  revalidatePath("/messages");

  if (username !== null) {
    revalidatePath(`/messages/${username}`);
  }
}

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

  const throttled = checkWriteQuota(me.id);

  if (throttled !== null) {
    return { ...throttled, sent: null };
  }

  const validated = validateBody(rawBody);

  if (!validated.ok) {
    return { ok: false, message: validated.message, sent: null };
  }

  const body = validated.body;

  if (recipientId === me.id) {
    return { ok: false, message: "You cannot message yourself.", sent: null };
  }

  // Run in parallel: the connection check keys on `recipientId`, which is already
  // known, so it never needed the profile lookup to finish first. This was two
  // serialized round trips to Neon for no reason.
  const [recipient, connected] = await Promise.all([
    prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, username: true },
    }),
    areUsersConnected(me.id, recipientId),
  ]);

  if (recipient === null) {
    return { ok: false, message: "That person no longer exists.", sent: null };
  }

  if (!connected) {
    return {
      ok: false,
      message: notConnectedMessage(recipient.username ?? "this user"),
      sent: null,
    };
  }

  const idempotencyKey =
    typeof clientId === "string" && clientId.trim().length > 0
      ? clientId.trim().slice(0, MAX_CLIENT_ID_CHARS)
      : null;

  // A quote is a client-supplied id, so it is checked against this exact pair of
  // people. Without that, anyone could quote a message out of a conversation
  // they are not part of and have its text rendered back to them.
  let quotedId: string | null = null;
  let quotedView: SentMessageView["replyTo"] = null;

  if (typeof replyToId === "string" && replyToId.trim().length > 0) {
    const quoted = await prisma.directMessage.findUnique({
      where: { id: replyToId.trim() },
      // `body` and `deletedAt` come along so the reply can be rendered from this
      // response alone, rather than costing the client another fetch.
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        body: true,
        deletedAt: true,
      },
    });

    if (quoted === null) {
      return {
        ok: false,
        message: "That message no longer exists.",
        sent: null,
      };
    }

    const participants = [quoted.senderId, quoted.receiverId];
    const sameConversation =
      participants.includes(me.id) && participants.includes(recipient.id);

    if (!sameConversation) {
      return {
        ok: false,
        message: "You can only quote a message from this conversation.",
        sent: null,
      };
    }

    // A soft-deleted original is still a valid target: the reply renders
    // "Original message deleted" rather than losing its context.
    quotedId = quoted.id;
    quotedView = {
      id: quoted.id,
      body: quoted.deletedAt === null ? quoted.body : null,
      deleted: quoted.deletedAt !== null,
      outgoing: quoted.senderId === me.id,
    };
  }

  let created: { id: string; createdAt: Date } | null = null;

  try {
    created = await prisma.directMessage.create({
      data: {
        senderId: me.id,
        receiverId: recipient.id,
        body,
        clientId: idempotencyKey,
        replyToId: quotedId,
      },
      select: { id: true, createdAt: true },
    });
  } catch (error: unknown) {
    // A retry or double-tap carrying the same key hits the unique index. The
    // first write already succeeded, so this is a success from the caller's
    // point of view rather than an error to surface.
    const isDuplicate =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002";

    if (!isDuplicate) {
      throw error;
    }

    // The winning row is the one to report back, so a retry resolves to the same
    // message the client already has rather than a second bubble.
    if (idempotencyKey !== null) {
      created = await prisma.directMessage.findFirst({
        where: { senderId: me.id, clientId: idempotencyKey },
        select: { id: true, createdAt: true },
      });
    }
  }

  // Deliberately awaited, not floated. A promise left running after a Server
  // Action returns is killed by the serverless runtime, so a fire-and-forget push
  // would be delivered only sometimes. The client no longer waits on this
  // response — it renders the message optimistically — so the cost is invisible.
  if (pushConfigured()) {
    await sendPushToUser(recipient.id, {
      kind: "message",
      fromName: me.name ?? `@${me.username}`,
      fromUsername: me.username,
      preview:
        body.length > PUSH_PREVIEW_CHARS
          ? `${body.slice(0, PUSH_PREVIEW_CHARS - 1)}…`
          : body,
    }).catch(() => undefined);
  }

  // Only the conversation list and the header's unread badge depend on server
  // state here, and both are `noStore()` so they re-read on navigation anyway.
  // Revalidating forced a full RSC re-render of this thread page into the action
  // response — several more round trips to Singapore for a payload the client
  // discards, since the thread owns its own message state.
  return {
    ok: true,
    message: "Sent.",
    sent:
      created === null
        ? null
        : {
            id: created.id,
            body,
            createdAt: created.createdAt.toISOString(),
            outgoing: true,
            editedAt: null,
            deleted: false,
            replyTo: quotedView,
          },
  };
}

/**
 * Rewrites a message the caller sent.
 *
 * Ownership is resolved from the row, never from the caller, and the connection
 * gate is re-checked exactly as it is on send — losing the connection closes
 * editing too.
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

  const validated = validateBody(newBody);

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
  // unchanged draft cannot stamp a message as edited.
  if (validated.body === existing.body) {
    return { ok: true, message: "No changes." };
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
 * Never a hard delete: replies pointing at this row keep their context, and the
 * read layer stops serving the body instead.
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

  // Idempotent: a double-tap, or a retry after the response was lost, lands here
  // and is reported as the success it already is.
  if (existing.deletedAt !== null) {
    return { ok: true, message: "Deleted." };
  }

  await prisma.directMessage.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });

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
