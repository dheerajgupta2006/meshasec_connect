"use server";

/**
 * Server Actions for group chat.
 *
 * The membership gate lives here, not in the UI, and is re-resolved on every
 * write: being removed from a group closes the ability to post to it on the next
 * request rather than at the next page load.
 *
 * Shaped to mirror `src/app/messages/actions.ts` closely enough that the thread
 * component is a near-copy — same `{ ok, message, sent }` result, same
 * client-minted idempotency key, same soft delete. The one structural difference
 * is read tracking: a direct message has a single recipient and so can carry its
 * own `readAt`, whereas a group message has as many readers as the group has
 * members, so reads are a per-member cursor advanced by `markGroupRead`.
 */

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { groupRoleFor } from "@/lib/groups/queries";
import { isValidId, validateGroupMessageBody } from "@/lib/groups/validation";
import { prisma } from "@/lib/prisma";
import { pushConfigured, sendPushToUser } from "@/lib/push/send";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser } from "@/lib/users/current-user";

/** Bounds the idempotency key so it cannot be used to store bulk data. */
const MAX_CLIENT_ID_CHARS = 64;

/** Keeps a push notification body to a glanceable length. */
const PUSH_PREVIEW_CHARS = 120;

const SIGN_IN_REQUIRED = "Your session has ended. Sign in again to continue.";
const NO_SUCH_GROUP = "That group does not exist, or you are not a member.";

/**
 * Deliberately identical for "not yours" and "does not exist", so message ids
 * cannot be probed to learn which are real.
 */
const NOT_YOURS = "You can only change messages you sent.";

export interface GroupMessageActionResult {
  ok: boolean;
  message: string;
}

export interface SentGroupMessageView {
  id: string;
  body: string;
  createdAt: string;
  outgoing: boolean;
  author: { id: string; username: string; name: string | null };
  editedAt: string | null;
  deleted: boolean;
  replyTo: {
    id: string;
    body: string | null;
    deleted: boolean;
    authorName: string;
  } | null;
}

export interface SendGroupMessageResult extends GroupMessageActionResult {
  /** Present only when `ok`; null on every refusal. */
  sent: SentGroupMessageView | null;
}

function checkWriteQuota(userId: string): GroupMessageActionResult | null {
  const verdict = consumeRateLimit("groupMessage", userId);

  if (verdict.allowed) {
    return null;
  }

  return {
    ok: false,
    message: `You are sending messages too quickly. Try again in ${describeRetryAfter(
      verdict.retryAfterSeconds,
    )}.`,
  };
}

function revalidateGroup(groupId: string): void {
  revalidatePath("/groups");
  revalidatePath(`/groups/${groupId}`);
}

/**
 * Notifies every other member.
 *
 * Awaited rather than floated: a promise left running after a Server Action
 * returns is killed by the serverless runtime, so fire-and-forget would deliver
 * only sometimes. The client renders the message optimistically, so this latency
 * is not on the path the sender waits for.
 *
 * The fan-out is bounded by `MAX_GROUP_MEMBERS`, and `sendPushToUser` caps each
 * member at ten devices and never throws, so one unreachable member cannot hold
 * up the rest.
 */
async function notifyGroup(
  groupId: string,
  groupName: string,
  recipientIds: readonly string[],
  fromName: string,
  body: string,
): Promise<void> {
  if (!pushConfigured() || recipientIds.length === 0) {
    return;
  }

  const preview =
    body.length > PUSH_PREVIEW_CHARS
      ? `${body.slice(0, PUSH_PREVIEW_CHARS - 1)}…`
      : body;

  await Promise.all(
    recipientIds.map((userId) =>
      sendPushToUser(userId, {
        kind: "group_message",
        groupId,
        groupName,
        fromName,
        preview,
      }).catch(() => undefined),
    ),
  );
}

export async function sendGroupMessage(
  groupId: string,
  rawBody: string,
  clientId?: string,
  replyToId?: string,
): Promise<SendGroupMessageResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, sent: null };
  }

  if (!isValidId(groupId)) {
    return { ok: false, message: NO_SUCH_GROUP, sent: null };
  }

  const throttled = checkWriteQuota(me.id);

  if (throttled !== null) {
    return { ...throttled, sent: null };
  }

  const validated = validateGroupMessageBody(rawBody);

  if (!validated.ok) {
    return { ok: false, message: validated.message, sent: null };
  }

  const body = validated.body;

  // Membership and the roster in one read: the roster is needed for the push
  // fan-out, and the viewer appearing in it is the gate.
  const group = await prisma.group.findFirst({
    where: { id: groupId, members: { some: { userId: me.id } } },
    select: {
      id: true,
      name: true,
      members: { select: { userId: true } },
    },
  });

  if (group === null) {
    return { ok: false, message: NO_SUCH_GROUP, sent: null };
  }

  // A quote is a client-supplied id, so it is checked against this group.
  // Without that, anyone could quote a message out of a group they are not in and
  // have its text rendered back to them.
  let quotedId: string | null = null;
  let quotedView: SentGroupMessageView["replyTo"] = null;

  if (typeof replyToId === "string" && replyToId.trim().length > 0) {
    const quoted = await prisma.groupMessage.findUnique({
      where: { id: replyToId.trim() },
      select: {
        id: true,
        groupId: true,
        body: true,
        deletedAt: true,
        sender: { select: { username: true, name: true } },
      },
    });

    if (quoted === null) {
      return { ok: false, message: "That message no longer exists.", sent: null };
    }

    if (quoted.groupId !== group.id) {
      return {
        ok: false,
        message: "You can only quote a message from this group.",
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
      authorName:
        quoted.sender.name ?? `@${quoted.sender.username ?? "someone"}`,
    };
  }

  const idempotencyKey =
    typeof clientId === "string" && clientId.trim().length > 0
      ? clientId.trim().slice(0, MAX_CLIENT_ID_CHARS)
      : null;

  let created: { id: string; createdAt: Date } | null = null;

  try {
    created = await prisma.groupMessage.create({
      data: {
        groupId: group.id,
        senderId: me.id,
        body,
        clientId: idempotencyKey,
        replyToId: quotedId,
      },
      select: { id: true, createdAt: true },
    });
  } catch (error: unknown) {
    // A retry or double-tap carrying the same key hits the unique index. The
    // first write already succeeded, so this is a success rather than an error.
    const isDuplicate =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002";

    if (!isDuplicate) {
      throw error;
    }

    if (idempotencyKey !== null) {
      created = await prisma.groupMessage.findFirst({
        where: { senderId: me.id, clientId: idempotencyKey },
        select: { id: true, createdAt: true },
      });
    }
  }

  await notifyGroup(
    group.id,
    group.name,
    group.members
      .map((member) => member.userId)
      .filter((userId) => userId !== me.id),
    me.name ?? `@${me.username}`,
    body,
  );

  // Deliberately no `revalidatePath` here, matching `sendDirectMessage`: the
  // thread owns its own message state, and revalidating drags a full RSC
  // re-render into the action response for a payload the client discards.
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
            author: { id: me.id, username: me.username, name: me.name },
            editedAt: null,
            deleted: false,
            replyTo: quotedView,
          },
  };
}

/** Rewrites a message the caller sent. Membership is re-checked. */
export async function editGroupMessage(
  messageId: string,
  newBody: string,
): Promise<GroupMessageActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const throttled = checkWriteQuota(me.id);

  if (throttled !== null) {
    return throttled;
  }

  const validated = validateGroupMessageBody(newBody);

  if (!validated.ok) {
    return { ok: false, message: validated.message };
  }

  const existing = await prisma.groupMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      body: true,
      groupId: true,
      senderId: true,
      deletedAt: true,
    },
  });

  if (existing === null || existing.senderId !== me.id) {
    return { ok: false, message: NOT_YOURS };
  }

  if (existing.deletedAt !== null) {
    return { ok: false, message: "That message was deleted." };
  }

  // Leaving the group closes editing too, exactly as losing a connection does for
  // a direct message.
  if ((await groupRoleFor(existing.groupId, me.id)) === null) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  // Saving identical text is a no-op, so resubmitting an unchanged draft cannot
  // stamp a message as edited.
  if (validated.body === existing.body) {
    return { ok: true, message: "No changes." };
  }

  await prisma.groupMessage.update({
    where: { id: existing.id },
    data: { body: validated.body, editedAt: new Date() },
    select: { id: true },
  });

  revalidateGroup(existing.groupId);

  return { ok: true, message: "Edited." };
}

/**
 * Soft-deletes a message.
 *
 * The author can always delete their own. An owner or admin can also delete
 * anyone's, because a group is a shared space and moderation has to be possible —
 * unlike a direct message, where there is nobody to moderate on behalf of.
 */
export async function deleteGroupMessage(
  messageId: string,
): Promise<GroupMessageActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const throttled = checkWriteQuota(me.id);

  if (throttled !== null) {
    return throttled;
  }

  const existing = await prisma.groupMessage.findUnique({
    where: { id: messageId },
    select: { id: true, groupId: true, senderId: true, deletedAt: true },
  });

  if (existing === null) {
    return { ok: false, message: NOT_YOURS };
  }

  const myRole = await groupRoleFor(existing.groupId, me.id);

  if (myRole === null) {
    return { ok: false, message: NOT_YOURS };
  }

  const mine = existing.senderId === me.id;
  const moderator = myRole === "OWNER" || myRole === "ADMIN";

  if (!mine && !moderator) {
    return { ok: false, message: NOT_YOURS };
  }

  // Idempotent: a double-tap, or a retry after a lost response, is reported as the
  // success it already is.
  if (existing.deletedAt !== null) {
    return { ok: true, message: "Deleted." };
  }

  await prisma.groupMessage.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });

  revalidateGroup(existing.groupId);

  return { ok: true, message: "Deleted." };
}

/**
 * Advances the caller's read cursor for a group.
 *
 * `updateMany` scoped to the caller's own membership, so this can only ever move
 * your own cursor, and a call for a group you have left is a silent no-op rather
 * than a thrown error on a fire-and-forget path.
 */
export async function markGroupRead(
  groupId: string,
): Promise<GroupMessageActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  if (!isValidId(groupId)) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  await prisma.groupMember.updateMany({
    where: { groupId, userId: me.id },
    data: { lastReadAt: new Date() },
  });

  revalidatePath("/groups");

  return { ok: true, message: "Marked as read." };
}
