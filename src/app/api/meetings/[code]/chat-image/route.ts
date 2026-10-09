import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import {
  broadcastPersistedDirectCallMessage,
  resolveDirectCallContext,
} from "@/lib/meetings/direct-call";
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
  checkMessageWriteQuota,
  deliverDirectMessage,
  isAttachmentBudgetExceededError,
  messageAttemptExists,
  validateMessageBody,
} from "@/lib/messages/send";
import { ensureCurrentUser } from "@/lib/users/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CLIENT_ID_CHARS = 64;
const CLIENT_ID_HEADER = "x-message-client-id";

interface RouteContext {
  params: { code: string };
}

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

function readText(form: FormData, name: string, max: number): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

/**
 * Persists one image from an unexpanded direct call into the pair's normal DM.
 *
 * The meeting code lives in the URL so membership and the server-resolved peer
 * can be checked before `formData()` buffers up to four megabytes. There is no
 * recipient field anywhere in this contract. Files are deliberately rejected:
 * the requested call-chat feature is images, while the normal DM composer remains
 * the place for arbitrary documents.
 */
export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  if (!assertTrustedOrigin(request.headers).trusted) {
    return refusal("This request was refused.", 403, "untrusted_origin");
  }

  const declaredLength = Number(request.headers.get("content-length"));

  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return refusal("The upload size is missing.", 411, "length_required");
  }

  if (declaredLength > MAX_ATTACHMENT_REQUEST_BYTES) {
    return refusal(
      `Images are limited to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      413,
      "too_large",
    );
  }

  const me = await ensureCurrentUser();

  if (me === null) {
    return refusal("Your session has ended.", 401, "unauthorized");
  }

  const directCall = await resolveDirectCallContext(params.code, me.id);

  if (directCall === null) {
    return refusal(
      "Images are saved only in an active one-to-one contact call.",
      403,
      "not_direct_call",
    );
  }

  const clientId = request.headers.get(CLIENT_ID_HEADER)?.trim();

  if (
    clientId === undefined ||
    clientId.length === 0 ||
    clientId.length > MAX_CLIENT_ID_CHARS
  ) {
    return refusal("The upload identifier is missing or invalid.", 400);
  }

  if (!(await messageAttemptExists(me.id, clientId))) {
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
    return refusal("The image upload could not be read.", 400);
  }

  const formClientId = readText(
    form,
    "clientId",
    MAX_CLIENT_ID_CHARS + 1,
  )?.trim();

  if (formClientId !== clientId) {
    return refusal("The upload identifier did not match.", 400);
  }

  const entry = form.get("file");

  if (entry === null || typeof entry === "string") {
    return refusal("Choose an image to send.", 400, "missing_file");
  }

  if (entry.size > MAX_ATTACHMENT_BYTES) {
    return refusal(
      `Images are limited to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      413,
      "too_large",
    );
  }

  const caption = validateMessageBody(
    readText(form, "body", MAX_BODY_CHARS * 2) ?? "",
    { allowEmpty: true },
  );

  if (!caption.ok) {
    return refusal(caption.message, 400, "bad_caption");
  }

  const bytes = new Uint8Array(await entry.arrayBuffer());
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

  if (inspection.kind !== "image") {
    return refusal("Only images can be sent from call chat.", 415, "image_only");
  }

  try {
    const result = await deliverDirectMessage(me, {
      recipientId: directCall.peerId,
      body: caption.body,
      clientId,
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
      sourceMeetingId: directCall.meetingId,
    });

    if (!result.ok || result.sent === null) {
      return refusal(result.message, 400, "refused");
    }

    const liveDelivered = await broadcastPersistedDirectCallMessage(
      params.code,
      {
        id: result.sent.id,
        createdAt: result.sent.createdAt,
        senderIdentity: me.clerkId,
        body: result.sent.body,
        attachment: result.sent.attachment,
      },
    );

    return NextResponse.json(
      { ...result, liveDelivered },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: unknown) {
    if (isAttachmentBudgetExceededError(error)) {
      return refusal(
        `You've reached today's ${formatBytes(
          MAX_ATTACHMENT_BYTES_PER_DAY,
        )} image limit. You can still send text.`,
        429,
        "daily_limit",
      );
    }

    if (isMissingAttachmentSchema(error)) {
      return refusal(
        "Sending images isn't available until the database migration is applied.",
        503,
        "attachments_unavailable",
      );
    }

    console.error(
      "Failed to persist a direct-call image",
      error instanceof Error ? error.message : "unknown error",
    );
    return refusal("The image could not be sent. Try again.", 500);
  }
}
