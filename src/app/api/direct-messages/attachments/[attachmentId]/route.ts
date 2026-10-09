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
 * can run script on this origin. `img-src` and `media-src` cover the synthetic
 * pages browsers may build when an image or audio file is opened directly.
 */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
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

type ByteRange = { start: number; end: number } | "invalid" | null;

/**
 * A single HTTP byte range for native audio metadata requests and seeking.
 * Multiple ranges are deliberately refused: files are capped at 4 MB and there
 * is no benefit in constructing multipart/byteranges responses here.
 */
function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) {
    return null;
  }

  if (header.length > 100 || size <= 0) {
    return "invalid";
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (match === null || (match[1].length === 0 && match[2].length === 0)) {
    return "invalid";
  }

  if (match[1].length === 0) {
    const suffixLength = Number(match[2]);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }

    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2].length === 0 ? size - 1 : Number(match[2]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return "invalid";
  }

  return { start, end: Math.min(requestedEnd, size - 1) };
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
    sizeBytes: number;
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
        sizeBytes: true,
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

  // Images and allowlisted audio are safe to render through their native media
  // elements. Every other document remains a forced download on this origin.
  const download = new URL(request.url).searchParams.get("download") === "1";
  const isAudio = mimeType.startsWith("audio/");
  const inline =
    (meta.kind === AttachmentKind.IMAGE || isAudio) && !download;
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

  if (isAudio) {
    headers["Accept-Ranges"] = "bytes";
  }

  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }

  const ifRange = request.headers.get("if-range");
  const range =
    isAudio && (ifRange === null || ifRange.trim() === etag)
      ? parseByteRange(request.headers.get("range"), meta.sizeBytes)
      : null;

  if (range === "invalid") {
    return new NextResponse(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${meta.sizeBytes}`,
        "Content-Length": "0",
      },
    });
  }

  const row = await prisma.directMessageAttachment.findUnique({
    where: { id },
    select: { data: true },
  });

  if (row === null) {
    return notFound();
  }

  const body = new Uint8Array(row.data);

  if (range !== null) {
    const partial = body.slice(range.start, range.end + 1);

    return new NextResponse(partial, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
        "Content-Length": String(partial.byteLength),
      },
    });
  }

  return new NextResponse(body, {
    status: 200,
    headers: { ...headers, "Content-Length": String(body.byteLength) },
  });
}
