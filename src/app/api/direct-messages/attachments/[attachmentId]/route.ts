import { AttachmentKind } from "@prisma/client";
import { NextResponse } from "next/server";

import { areUsersConnected } from "@/lib/connections/queries";
import {
  ASSIGNABLE_MIME_TYPES,
  contentDisposition,
  etagMatches,
} from "@/lib/messages/attachment-content";
import { isMissingAttachmentSchema } from "@/lib/messages/attachments";
import { prisma } from "@/lib/prisma";
import { getCurrentLocalUserId } from "@/lib/users/current-user";

export const runtime = "nodejs";
// Explicit, because caching a private response at the framework level would
// serve one person's attachment to whoever asked next.
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { attachmentId: string };
}

/** Prisma cuids. Anything else cannot be a real id, so it skips the database. */
const ID_PATTERN = /^[a-z0-9]{1,64}$/i;

/**
 * Hardening for a response that carries user-supplied bytes.
 *
 * `nosniff` stops a browser second-guessing the declared type; the CSP with
 * `sandbox` means that even opened directly in a tab, nothing in the response
 * can run script on this origin. `img-src 'self'` is there because some browsers
 * apply the CSP to the synthetic page they build to show a bare image.
 */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * One response for "does not exist", "not yours", "deleted" and "no longer
 * connected", so attachment ids cannot be probed to learn anything.
 */
function notFound(): NextResponse {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Serves an attachment to one of the two people in its conversation.
 *
 * Access is decided on every request, including revalidations. The cache policy
 * is `no-cache` rather than a max-age for exactly that reason: a browser may
 * keep the bytes, but it has to ask before reusing them, so signing out on a
 * shared computer — or losing the connection — cannot leave a cached copy
 * readable by the next person. The entity tag keeps those checks cheap: an
 * unchanged file answers 304 without its bytes being read.
 */
export async function GET(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const viewerId = await getCurrentLocalUserId();

  if (viewerId === null) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const id = params.attachmentId;

  if (!ID_PATTERN.test(id)) {
    return notFound();
  }

  let meta: {
    kind: AttachmentKind;
    fileName: string;
    mimeType: string;
    sha256: string;
    message: { senderId: string; receiverId: string; deletedAt: Date | null };
  } | null;

  try {
    // Everything but the bytes, so a refused or revalidated request never
    // reads them.
    meta = await prisma.directMessageAttachment.findUnique({
      where: { id },
      select: {
        kind: true,
        fileName: true,
        mimeType: true,
        sha256: true,
        message: {
          select: { senderId: true, receiverId: true, deletedAt: true },
        },
      },
    });
  } catch (error: unknown) {
    if (isMissingAttachmentSchema(error)) {
      return notFound();
    }

    throw error;
  }

  if (meta === null || meta.message.deletedAt !== null) {
    return notFound();
  }

  const { senderId, receiverId } = meta.message;

  if (viewerId !== senderId && viewerId !== receiverId) {
    return notFound();
  }

  // The same rule as reading the thread: a revoked connection closes access to
  // its history, attachments included.
  const otherId = viewerId === senderId ? receiverId : senderId;

  if (!(await areUsersConnected(viewerId, otherId))) {
    return notFound();
  }

  // Defence in depth. The stored type was assigned by this app from the bytes,
  // but only a type on the known list is ever echoed back.
  const mimeType = ASSIGNABLE_MIME_TYPES.includes(meta.mimeType)
    ? meta.mimeType
    : "application/octet-stream";

  // Only images are shown inline. Everything else is a download, so no
  // document format is ever rendered by the browser on this origin.
  const download = new URL(request.url).searchParams.get("download") === "1";
  const inline = meta.kind === AttachmentKind.IMAGE && !download;
  const etag = `"${meta.sha256}"`;

  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": mimeType,
    "Content-Disposition": contentDisposition(
      inline ? "inline" : "attachment",
      meta.fileName,
    ),
    "Cache-Control": "private, no-cache",
    ETag: etag,
  };

  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }

  const row = await prisma.directMessageAttachment.findUnique({
    where: { id },
    select: { data: true },
  });

  if (row === null) {
    return notFound();
  }

  const body = new Uint8Array(row.data);

  return new NextResponse(body, {
    status: 200,
    headers: { ...headers, "Content-Length": String(body.byteLength) },
  });
}
