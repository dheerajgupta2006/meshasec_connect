import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { assertTrustedOrigin } from "@/lib/meetings/origin";
import { inspectAttachment } from "@/lib/messages/attachment-content";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES_PER_DAY,
  MAX_ATTACHMENT_REQUEST_BYTES,
  formatBytes,
} from "@/lib/messages/attachment-rules";
import { isMissingAttachmentSchema } from "@/lib/messages/attachments";
import {
  MAX_BODY_CHARS,
  SIGN_IN_REQUIRED,
  checkMessageWriteQuota,
  deliverDirectMessage,
  isAttachmentBudgetExceededError,
  messageAttemptExists,
  validateMessageBody,
} from "@/lib/messages/send";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bound on user/message ids, which are never legitimately long. */
const MAX_ID_CHARS = 128;
/** Must match the bound in the shared send path. */
const MAX_CLIENT_ID_CHARS = 64;
const CLIENT_ID_HEADER = "x-message-client-id";

const UNAVAILABLE =
  "Sending files isn't available yet. The database needs updating first.";

function refusal(
  message: string,
  status: number,
  code?: string,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { ok: false, message, ...(code === undefined ? {} : { code }) },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

/** Reads a text field, or undefined. Files posing as text fields are ignored. */
function readText(form: FormData, name: string, max: number): string | undefined {
  const value = form.get(name);

  return typeof value === "string" ? value.slice(0, max) : undefined;
}

/**
 * Sends a direct message carrying one file or image, with an optional caption.
 *
 * A route handler rather than a Server Action because actions cap their request
 * bodies at 1 MB by default, and because the composer needs upload progress,
 * which only an `XMLHttpRequest` to an ordinary endpoint can report.
 *
 * That means the framework's built-in origin check for actions does not apply,
 * and a multipart POST is exactly what a cross-site form can send without a
 * preflight — so the same trusted-origin check the meeting actions use is done
 * here explicitly.
 *
 * The message and its file are written in one statement through the shared
 * send path in `lib/messages/send.ts`, so the connection gate, the quote check
 * and idempotency are identical to a text send, and no orphaned upload can ever
 * exist.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const origin = assertTrustedOrigin(request.headers);

  if (!origin.trusted) {
    return refusal("This request was refused.", 403, "untrusted_origin");
  }

  // Checked before anything is read. Without a declared length the body could be
  // arbitrarily large, and `formData()` buffers the whole thing in memory.
  const declaredLength = Number(request.headers.get("content-length"));

  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return refusal("The upload size is missing.", 411, "length_required");
  }

  if (declaredLength > MAX_ATTACHMENT_REQUEST_BYTES) {
    return refusal(
      `Files are limited to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      413,
      "too_large",
    );
  }

  const me = await ensureCurrentUser();

  if (me === null) {
    return refusal(SIGN_IN_REQUIRED, 401, "unauthorized");
  }

  // Mirrored outside the multipart body so an already-committed retry can be
  // recognised before consuming the write quota or buffering the file again.
  // The form copy is compared below; neither value is trusted on its own.
  const clientId = request.headers.get(CLIENT_ID_HEADER)?.trim();

  if (
    clientId === undefined ||
    clientId.length === 0 ||
    clientId.length > MAX_CLIENT_ID_CHARS
  ) {
    return refusal("The upload identifier is missing or invalid.", 400, "bad_request");
  }

  const alreadyCommitted = await messageAttemptExists(me.id, clientId);

  // An idempotent replay does no write and must not be refused because the
  // successful first response was lost. New attempts share the same bucket as
  // text sends, edits and deletes.
  if (!alreadyCommitted) {
    const throttled = checkMessageWriteQuota(me.id);

    if (throttled !== null) {
      return refusal(throttled.message, 429, "rate_limited", {
        "Retry-After": String(throttled.retryAfterSeconds),
      });
    }
  }

  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return refusal("The upload could not be read.", 400, "bad_request");
  }

  const formClientId = readText(
    form,
    "clientId",
    MAX_CLIENT_ID_CHARS + 1,
  )?.trim();

  if (formClientId !== clientId) {
    return refusal("The upload identifier did not match.", 400, "bad_request");
  }

  const entry = form.get("file");

  if (entry === null || typeof entry === "string") {
    return refusal("Choose a file to send.", 400, "missing_file");
  }

  if (entry.size > MAX_ATTACHMENT_BYTES) {
    return refusal(
      `Files are limited to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      413,
      "too_large",
    );
  }

  const recipientId = readText(form, "recipientId", MAX_ID_CHARS);

  if (recipientId === undefined || recipientId.trim().length === 0) {
    return refusal("Choose who to send this to.", 400, "bad_request");
  }

  // Read with headroom so an over-long caption is refused with a clear message
  // rather than silently truncated.
  const caption = validateMessageBody(
    readText(form, "body", MAX_BODY_CHARS * 2) ?? "",
    { allowEmpty: true },
  );

  if (!caption.ok) {
    return refusal(caption.message, 400, "bad_caption");
  }

  const bytes = new Uint8Array(await entry.arrayBuffer());

  // The client's name is a hint and its type is ignored entirely: what the file
  // is gets decided from the bytes.
  const inspection = inspectAttachment({ bytes, fileName: entry.name });

  if (!inspection.ok) {
    const status =
      inspection.reason === "too_large"
        ? 413
        : inspection.reason === "damaged_image" ||
            inspection.reason === "image_too_large" ||
            inspection.reason === "empty"
          ? 422
          : 415;

    return refusal(inspection.message, status, inspection.reason);
  }

  try {
    const result = await deliverDirectMessage(me, {
      recipientId: recipientId.trim(),
      body: caption.body,
      clientId,
      replyToId: readText(form, "replyToId", MAX_ID_CHARS),
      attachment: {
        kind: inspection.kind,
        fileName: inspection.fileName,
        mimeType: inspection.mimeType,
        sizeBytes: bytes.byteLength,
        width: inspection.width,
        height: inspection.height,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        data: bytes,
      },
    });

    if (!result.ok) {
      return refusal(result.message, 400, "refused");
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    if (isAttachmentBudgetExceededError(error)) {
      return refusal(
        `You've reached today's ${formatBytes(
          MAX_ATTACHMENT_BYTES_PER_DAY,
        )} limit for files. You can still send text.`,
        429,
        "daily_limit",
      );
    }

    if (isMissingAttachmentSchema(error)) {
      return refusal(UNAVAILABLE, 503, "attachments_unavailable");
    }

    // The file's contents are never logged: they are someone's private message.
    console.error(
      "Failed to send a direct message attachment",
      error instanceof Error ? error.message : "unknown error",
    );

    return refusal("The file could not be sent. Try again.", 500, "failed");
  }
}
