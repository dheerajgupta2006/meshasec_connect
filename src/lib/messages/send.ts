import "server-only";

/**
 * The one place a direct message is written.
 *
 * Shared by the `sendDirectMessage` Server Action, which sends text, and the
 * attachment upload route, which sends a file with an optional caption. Both go
 * through the same connection gate, quote check, idempotency handling and push,
 * so a fix to any of them cannot land on one path and miss the other.
 *
 * Deliberately not a `"use server"` module. Everything exported from one of
 * those becomes a callable endpoint, and this takes an already-authenticated
 * sender as an argument — exposed directly, it would let anyone send as anyone.
 */

import { Prisma } from "@prisma/client";

import { areUsersConnected } from "@/lib/connections/queries";
import {
  ATTACHMENT_BUDGET_WINDOW_MS,
  MAX_ATTACHMENT_BYTES_PER_DAY,
  attachmentPreviewText,
  type AttachmentKind,
  type AttachmentLabelView,
  type AttachmentView,
} from "@/lib/messages/attachment-rules";
import {
  fromAttachmentKind,
  loadAttachmentForRetry,
  loadAttachmentSummaries,
  type AttachmentRetryView,
} from "@/lib/messages/attachments";
import { prisma } from "@/lib/prisma";
import { pushConfigured, sendPushToUser } from "@/lib/push/send";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";

/** Bounds the idempotency key so it cannot be used to store bulk data. */
const MAX_CLIENT_ID_CHARS = 64;

/** Keeps a push notification body to a glanceable length. */
const PUSH_PREVIEW_CHARS = 120;

export const MAX_BODY_CHARS = 4000;

export const SIGN_IN_REQUIRED =
  "Your session has ended. Sign in again to continue.";

const ATTACHMENT_BUDGET_ERROR = "DM_ATTACHMENT_BUDGET_EXCEEDED";

/** Raised inside the atomic attachment transaction when the rolling budget is full. */
export class AttachmentBudgetExceededError extends Error {
  constructor() {
    super(ATTACHMENT_BUDGET_ERROR);
    this.name = "AttachmentBudgetExceededError";
  }
}

/** Prisma normally preserves callback errors; the message fallback covers wrapped transaction errors. */
export function isAttachmentBudgetExceededError(error: unknown): boolean {
  return (
    error instanceof AttachmentBudgetExceededError ||
    (error instanceof Error && error.message.includes(ATTACHMENT_BUDGET_ERROR))
  );
}

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
    attachment: AttachmentLabelView | null;
  } | null;
  attachment: AttachmentView | null;
}

export interface SendMessageResult extends MessageActionResult {
  /** Present only when `ok`; null on every refusal. */
  sent: SentMessageView | null;
}

/** A file that has already passed `inspectAttachment`, ready to store. */
export interface PreparedAttachment {
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  /** Backed by a plain `ArrayBuffer`, which is what Prisma's `Bytes` accepts. */
  data: Uint8Array<ArrayBuffer>;
}

/** Just the parts of the signed-in user a send needs. */
export interface MessageSender {
  id: string;
  username: string;
  name: string | null;
}

export function notConnectedMessage(username: string): string {
  return `You must connect with @${username} and have your request accepted before calling or chatting.`;
}

/**
 * Shared trim-and-bound check, so editing enforces exactly what sending does.
 *
 * `allowEmpty` is only for a caption on an attachment: a file is a complete
 * message on its own, whereas an empty text message is nothing at all.
 */
export function validateMessageBody(
  rawBody: string,
  options: { allowEmpty?: boolean } = {},
): { ok: true; body: string } | { ok: false; message: string } {
  const body = rawBody.trim();

  if (body.length === 0 && options.allowEmpty !== true) {
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

function normalizeMessageClientId(clientId: string | undefined): string | null {
  if (typeof clientId !== "string") {
    return null;
  }

  const normalized = clientId.trim();

  return normalized.length > 0
    ? normalized.slice(0, MAX_CLIENT_ID_CHARS)
    : null;
}

/**
 * Whether this sender has already committed a message under an idempotency key.
 *
 * The attachment route uses this before consuming its in-memory write quota, so
 * replaying a request whose response was lost is not charged as a fresh write.
 * It reveals nothing across accounts: `senderId` always comes from the session.
 */
export async function messageAttemptExists(
  senderId: string,
  clientId: string | undefined,
): Promise<boolean> {
  const key = normalizeMessageClientId(clientId);

  if (key === null) {
    return false;
  }

  const existing = await prisma.directMessage.findFirst({
    where: { senderId, clientId: key },
    select: { id: true },
  });

  return existing !== null;
}

/**
 * Edits, deletes and sends — with or without an attachment — share the
 * `directMessage` bucket.
 *
 * One bucket per person covers every write to the message table, which is the
 * behaviour worth bounding. The extra cost of an attachment is bounded
 * separately, by the per-day byte budget the upload route checks.
 */
export function checkMessageWriteQuota(
  userId: string,
): { ok: false; message: string; retryAfterSeconds: number } | null {
  const throttled = consumeRateLimit("directMessage", userId);

  if (throttled.allowed) {
    return null;
  }

  return {
    ok: false,
    message: `You are sending messages too quickly. Try again in ${describeRetryAfter(
      throttled.retryAfterSeconds,
    )}.`,
    retryAfterSeconds: throttled.retryAfterSeconds,
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function attachmentLabel(
  attachment: AttachmentView | undefined,
): AttachmentLabelView | null {
  return attachment === undefined
    ? null
    : { kind: attachment.kind, fileName: attachment.fileName };
}

function sameAttachment(
  stored: AttachmentRetryView | null,
  requested: PreparedAttachment | null,
): boolean {
  if (stored === null || requested === null) {
    return stored === null && requested === null;
  }

  return (
    stored.kind === requested.kind &&
    stored.fileName === requested.fileName &&
    stored.mimeType === requested.mimeType &&
    stored.sizeBytes === requested.sizeBytes &&
    stored.width === requested.width &&
    stored.height === requested.height &&
    stored.sha256 === requested.sha256
  );
}

/** What the recipient's notification says. Never empty. */
function pushPreview(body: string, attachment: PreparedAttachment | null): string {
  if (attachment === null) {
    return truncate(body, PUSH_PREVIEW_CHARS);
  }

  const label = attachmentPreviewText({
    kind: attachment.kind,
    fileName: attachment.fileName,
  });

  if (body.length === 0) {
    return truncate(label, PUSH_PREVIEW_CHARS);
  }

  // The icon from the label, then the caption: "📷 Look at this".
  const icon = attachment.kind === "image" ? "📷" : "📎";

  return truncate(`${icon} ${body}`, PUSH_PREVIEW_CHARS);
}

export interface DeliverInput {
  recipientId: string;
  /** Already validated. Empty only when `attachment` is present. */
  body: string;
  clientId?: string;
  replyToId?: string;
  attachment: PreparedAttachment | null;
}

/**
 * Writes a message from `sender` to `input.recipientId`.
 *
 * The caller has authenticated the sender, checked the write quota and
 * validated the body. Everything that depends on the *other* person — that they
 * exist, that the two are connected, that a quoted message belongs to this
 * conversation — is decided here, on every send.
 *
 * Database errors other than a duplicate idempotency key propagate. That
 * includes the attachment table being missing, which the upload route reports
 * as "not available yet" rather than as a failure.
 */
export async function deliverDirectMessage(
  sender: MessageSender,
  input: DeliverInput,
): Promise<SendMessageResult> {
  const { body, attachment } = input;

  if (body.length === 0 && attachment === null) {
    return { ok: false, message: "Write a message first.", sent: null };
  }

  if (input.recipientId === sender.id) {
    return { ok: false, message: "You cannot message yourself.", sent: null };
  }

  // Run in parallel: the connection check keys on `recipientId`, which is already
  // known, so it never needed the profile lookup to finish first. This was two
  // serialized round trips to Neon for no reason.
  const [recipient, connected] = await Promise.all([
    prisma.user.findUnique({
      where: { id: input.recipientId },
      select: { id: true, username: true },
    }),
    areUsersConnected(sender.id, input.recipientId),
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

  const idempotencyKey = normalizeMessageClientId(input.clientId);

  // A quote is a client-supplied id, so it is checked against this exact pair of
  // people. Without that, anyone could quote a message out of a conversation
  // they are not part of and have its text rendered back to them.
  let quotedId: string | null = null;
  let quotedView: SentMessageView["replyTo"] = null;

  if (typeof input.replyToId === "string" && input.replyToId.trim().length > 0) {
    const quoted = await prisma.directMessage.findUnique({
      where: { id: input.replyToId.trim() },
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
      return { ok: false, message: "That message no longer exists.", sent: null };
    }

    const participants = [quoted.senderId, quoted.receiverId];
    const sameConversation =
      participants.includes(sender.id) && participants.includes(recipient.id);

    if (!sameConversation) {
      return {
        ok: false,
        message: "You can only quote a message from this conversation.",
        sent: null,
      };
    }

    // Only a live original can say what it carried; a deleted one has had its
    // attachment purged anyway.
    const quotedAttachment =
      quoted.deletedAt === null
        ? ((await loadAttachmentSummaries([quoted.id])).get(quoted.id) ?? null)
        : null;

    // A soft-deleted original is still a valid target: the reply renders
    // "Original message deleted" rather than losing its context.
    quotedId = quoted.id;
    quotedView = {
      id: quoted.id,
      body: quoted.deletedAt === null ? quoted.body : null,
      deleted: quoted.deletedAt !== null,
      outgoing: quoted.senderId === sender.id,
      attachment:
        quotedAttachment === null
          ? null
          : { kind: quotedAttachment.kind, fileName: quotedAttachment.fileName },
    };
  }

  const base: Prisma.DirectMessageUncheckedCreateInput = {
    senderId: sender.id,
    receiverId: recipient.id,
    body,
    clientId: idempotencyKey,
    replyToId: quotedId,
  };

  let created: { id: string; createdAt: Date } | null = null;
  let storedAttachment: AttachmentView | null = null;
  let returnedBody = body;
  let returnedEditedAt: string | null = null;
  let returnedDeleted = false;
  let returnedQuotedView = quotedView;
  /** False on an idempotent retry: the winning request already sent the push. */
  let createdNow = false;

  try {
    if (attachment === null) {
      // Kept free of any attachment relation, so text keeps sending on a
      // database that has not had the attachment migration applied.
      created = await prisma.directMessage.create({
        data: base,
        select: { id: true, createdAt: true },
      });
      createdNow = true;
    } else {
      // Serialize the rolling storage check per sender and keep it in the same
      // transaction as the nested create. A check followed by a separate create
      // lets 30 parallel 4 MB uploads all observe the same old total; the
      // transaction-scoped advisory lock makes each one see the previous commit.
      const since = new Date(Date.now() - ATTACHMENT_BUDGET_WINDOW_MS);
      const row = await prisma.$transaction(
        async (transaction) => {
          // Hash collisions only serialize two unrelated senders; they cannot
          // weaken the limit or mix data. Parameters remain query parameters,
          // never executable SQL.
          await transaction.$executeRaw`
            SELECT pg_advisory_xact_lock(
              hashtext('dm_attachment_budget'),
              hashtext(${sender.id})
            )
          `;

          // One write for the message and its file, so there is never a message
          // without its attachment or an attachment without its message.
          const createdRow = await transaction.directMessage.create({
            data: {
              ...base,
              attachment: {
                create: {
                  kind: fromAttachmentKind(attachment.kind),
                  fileName: attachment.fileName,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                  width: attachment.width,
                  height: attachment.height,
                  sha256: attachment.sha256,
                  data: attachment.data,
                },
              },
            },
            select: {
              id: true,
              createdAt: true,
              attachment: { select: { id: true } },
            },
          });

          // Count after the create, while the lock is held. Throwing rolls the
          // new message and its bytes back together.
          const total = await transaction.directMessageAttachment.aggregate({
            where: {
              createdAt: { gte: since },
              message: { is: { senderId: sender.id } },
            },
            _sum: { sizeBytes: true },
          });

          if ((total._sum.sizeBytes ?? 0) > MAX_ATTACHMENT_BYTES_PER_DAY) {
            throw new AttachmentBudgetExceededError();
          }

          return createdRow;
        },
        { maxWait: 10_000, timeout: 30_000 },
      );

      created = { id: row.id, createdAt: row.createdAt };
      createdNow = true;
      storedAttachment =
        row.attachment === null
          ? null
          : {
              id: row.attachment.id,
              kind: attachment.kind,
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              width: attachment.width,
              height: attachment.height,
            };
    }
  } catch (error: unknown) {
    // A retry or double-tap carrying the same key hits the unique index. The
    // first write already succeeded, so this is a success from the caller's
    // point of view rather than an error to surface.
    const isDuplicate =
      idempotencyKey !== null &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002";

    if (!isDuplicate) {
      throw error;
    }

    // Read the winning row back exactly as stored. Normally every field matches
    // this request because a retry repeats the same payload. Treating the
    // request body as the result would be unsafe, though: client ids are supplied
    // by the browser, and a reused key with a changed caption or recipient must
    // never make an old row appear to contain new data.
    const winner = await prisma.directMessage.findFirst({
      where: { senderId: sender.id, clientId: idempotencyKey },
      select: {
        id: true,
        body: true,
        createdAt: true,
        editedAt: true,
        deletedAt: true,
        receiverId: true,
        replyToId: true,
        replyTo: {
          select: { id: true, body: true, senderId: true, deletedAt: true },
        },
      },
    });

    if (winner === null) {
      return {
        ok: false,
        message: "The message could not be confirmed. Try again.",
        sent: null,
      };
    }

    // A key can identify only one conversation. This also prevents a deliberately
    // reused key from putting the id or attachment metadata of a different
    // recipient's message into the thread currently open in the browser.
    if (winner.receiverId !== recipient.id) {
      return {
        ok: false,
        message: "That retry belongs to a different conversation.",
        sent: null,
      };
    }

    const winnerAttachment = await loadAttachmentForRetry(winner.id);

    if (
      winner.body !== body ||
      winner.replyToId !== quotedId ||
      !sameAttachment(winnerAttachment, attachment)
    ) {
      return {
        ok: false,
        message:
          "That send was already completed with different content. Refresh the conversation before trying again.",
        sent: null,
      };
    }

    created = { id: winner.id, createdAt: winner.createdAt };
    returnedBody = winner.deletedAt === null ? winner.body : "";
    returnedEditedAt =
      winner.deletedAt === null ? winner.editedAt?.toISOString() ?? null : null;
    returnedDeleted = winner.deletedAt !== null;

    const idsToLoad: string[] = [];

    if (winner.replyTo !== null && winner.replyTo.deletedAt === null) {
      idsToLoad.push(winner.replyTo.id);
    }

    const winnerAttachments = await loadAttachmentSummaries(idsToLoad);
    storedAttachment = winner.deletedAt === null ? winnerAttachment : null;

    returnedQuotedView =
      winner.replyTo === null
        ? null
        : {
            id: winner.replyTo.id,
            body:
              winner.replyTo.deletedAt === null ? winner.replyTo.body : null,
            deleted: winner.replyTo.deletedAt !== null,
            outgoing: winner.replyTo.senderId === sender.id,
            attachment:
              winner.replyTo.deletedAt !== null
                ? null
                : attachmentLabel(
                    winnerAttachments.get(winner.replyTo.id),
                  ),
          };
  }

  // Deliberately awaited, not floated. A promise left running after a Server
  // Action returns is killed by the serverless runtime, so a fire-and-forget push
  // would be delivered only sometimes. The client no longer waits on this
  // response — it renders the message optimistically — so the cost is invisible.
  if (createdNow && pushConfigured()) {
    await sendPushToUser(recipient.id, {
      kind: "message",
      fromName: sender.name ?? `@${sender.username}`,
      fromUsername: sender.username,
      preview: pushPreview(body, attachment),
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
            body: returnedBody,
            createdAt: created.createdAt.toISOString(),
            outgoing: true,
            editedAt: returnedEditedAt,
            deleted: returnedDeleted,
            replyTo: returnedQuotedView,
            attachment: storedAttachment,
          },
  };
}
