import "server-only";

/**
 * Database access for direct-message attachments.
 *
 * Every read here tolerates the attachment table not existing yet. The schema
 * change is additive and shipped alongside the code, but a deployment can serve
 * the new code before `prisma migrate deploy` has run against its database. In
 * that window the thread must keep working exactly as it did — text messages
 * included — so a missing table is read as "no attachments" rather than allowed
 * to take the whole conversation down.
 *
 * Only that specific condition is swallowed. Any other database error still
 * propagates, so a real outage is never disguised as an empty result.
 */

import { AttachmentKind, Prisma } from "@prisma/client";

import { type AttachmentView } from "@/lib/messages/attachment-rules";
import { prisma } from "@/lib/prisma";

/**
 * Prisma's "table does not exist" and "column does not exist".
 *
 * Exported so the upload route can turn the same condition into an explicit
 * "not available yet" response instead of a 500.
 */
export function isMissingAttachmentSchema(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2021" || error.code === "P2022")
  );
}

let warnedMissingSchema = false;

/** Says so once per process, so a forgotten migration is visible in the logs. */
function warnMissingSchemaOnce(): void {
  if (warnedMissingSchema) {
    return;
  }

  warnedMissingSchema = true;
  console.warn(
    "Direct message attachments are disabled: the DirectMessageAttachment table " +
      "does not exist. Apply pending migrations with `npm run db:migrate`.",
  );
}

export function toAttachmentKind(kind: AttachmentKind): AttachmentView["kind"] {
  return kind === AttachmentKind.IMAGE ? "image" : "file";
}

export function fromAttachmentKind(kind: AttachmentView["kind"]): AttachmentKind {
  return kind === "image" ? AttachmentKind.IMAGE : AttachmentKind.FILE;
}

/** Everything about an attachment except its bytes. */
const summarySelect = {
  id: true,
  messageId: true,
  kind: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
} as const;

/**
 * Attachment metadata for a set of messages, keyed by message id.
 *
 * One indexed query for the whole thread window. Never selects the bytes, which
 * is the point of keeping them in their own table: this runs on every poll.
 */
export async function loadAttachmentSummaries(
  messageIds: readonly string[],
): Promise<Map<string, AttachmentView>> {
  const summaries = new Map<string, AttachmentView>();

  if (messageIds.length === 0) {
    return summaries;
  }

  let rows: {
    id: string;
    messageId: string;
    kind: AttachmentKind;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
  }[];

  try {
    rows = await prisma.directMessageAttachment.findMany({
      where: { messageId: { in: [...messageIds] } },
      select: summarySelect,
    });
  } catch (error: unknown) {
    if (isMissingAttachmentSchema(error)) {
      warnMissingSchemaOnce();
      return summaries;
    }

    throw error;
  }

  rows.forEach((row) => {
    summaries.set(row.messageId, {
      id: row.id,
      kind: toAttachmentKind(row.kind),
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
    });
  });

  return summaries;
}

/**
 * Removes an attachment's bytes when its message is deleted.
 *
 * The message row survives a delete so replies keep their context, but the file
 * is the privacy-sensitive part and has no reason to outlive it. The download
 * route also refuses deleted messages, so this is cleanup rather than the gate.
 */
export async function purgeAttachment(messageId: string): Promise<void> {
  try {
    await prisma.directMessageAttachment.deleteMany({ where: { messageId } });
  } catch (error: unknown) {
    if (isMissingAttachmentSchema(error)) {
      return;
    }

    throw error;
  }
}

/** Stored metadata used to prove that an idempotent retry is byte-for-byte the same operation. */
export interface AttachmentRetryView extends AttachmentView {
  sha256: string;
}

/**
 * One message's attachment fingerprint, without its bytes.
 *
 * A duplicate client id is only a successful retry when its recipient, caption,
 * quote and attachment all match the committed operation. The digest makes that
 * comparison cheap and avoids reading a private multi-megabyte `bytea` value.
 */
export async function loadAttachmentForRetry(
  messageId: string,
): Promise<AttachmentRetryView | null> {
  try {
    const row = await prisma.directMessageAttachment.findUnique({
      where: { messageId },
      select: { ...summarySelect, sha256: true },
    });

    if (row === null) {
      return null;
    }

    return {
      id: row.id,
      kind: toAttachmentKind(row.kind),
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
    };
  } catch (error: unknown) {
    if (isMissingAttachmentSchema(error)) {
      warnMissingSchemaOnce();
      return null;
    }

    throw error;
  }
}
