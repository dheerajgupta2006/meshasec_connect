/**
 * Rules for files and images attached to direct messages.
 *
 * Shared by the browser and the server, so the limits the composer enforces for
 * fast feedback are the same numbers the upload route enforces for real. Pure
 * and dependency-free: no `window`, no Node built-ins.
 *
 * The server is still the authority. Everything the browser decides here is a
 * courtesy that saves a doomed upload; `attachment-content.ts` re-derives the
 * type from the bytes and ignores what the client claimed.
 */

export type AttachmentKind = "image" | "file";

/**
 * Largest file accepted, after any browser-side image downscaling.
 *
 * Bounded by the deployment rather than by taste. Vercel refuses serverless
 * request bodies above 4.5 MB, so anything larger never reaches the route at
 * all, and the multipart envelope plus a caption have to fit alongside the file.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/**
 * Largest request body the upload route will read.
 *
 * The file limit plus room for the multipart boundaries, the caption (up to
 * 4,000 characters, so as much as 16 KB of UTF-8) and the small text fields.
 */
export const MAX_ATTACHMENT_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 128 * 1024;

/**
 * Bytes one person may upload in a rolling day.
 *
 * Attachment bytes live in Postgres, which makes database storage the scarcest
 * budget this deployment has. This keeps one account from filling it.
 */
export const MAX_ATTACHMENT_BYTES_PER_DAY = 50 * 1024 * 1024;

export const ATTACHMENT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Longest side a photo is downscaled to before upload.
 *
 * Large enough to stay sharp on a high-density laptop screen, small enough that
 * a phone photo of several megabytes lands comfortably under the size limit.
 */
export const IMAGE_UPLOAD_MAX_DIMENSION = 2048;

/**
 * Largest source image the browser will try to decode before downscaling.
 *
 * Above the upload limit on purpose — a 12 MB phone photo is normal and shrinks
 * to well under 4 MB — but bounded so a hostile file cannot make the tab decode
 * something enormous.
 */
export const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;

/**
 * Decoded-size limits, checked against the dimensions in the file header.
 *
 * A 4 MB PNG can describe a 30,000 × 30,000 image that needs gigabytes of
 * memory to display, which would crash the recipient's tab. Refusing it at
 * upload is the only place that protects the recipient.
 */
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Display-name length, in code points. Long enough for real file names. */
export const MAX_FILE_NAME_CHARS = 120;

/**
 * Images shown inline in the thread.
 *
 * SVG is absent on purpose: it is a document format that can carry script, and
 * serving it from this origin would turn an attachment into stored XSS.
 */
export const IMAGE_TYPES = [
  { mimeType: "image/png", extension: "png" },
  { mimeType: "image/jpeg", extension: "jpg" },
  { mimeType: "image/gif", extension: "gif" },
  { mimeType: "image/webp", extension: "webp" },
] as const;

export type ImageMimeType = (typeof IMAGE_TYPES)[number]["mimeType"];

/** Every extension that names an inline image, including the `jpeg` spelling. */
export const IMAGE_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
];

/**
 * How a file type proves its contents match its name.
 *
 * Each id is implemented in `attachment-content.ts`. Every allowed type has one,
 * so a renamed executable cannot ride in on an innocent extension.
 */
export type ContentSignature =
  | "pdf"
  | "text"
  | "rtf"
  | "ole"
  | "zip"
  | "mp3"
  | "isoBmff"
  | "wav"
  | "ogg"
  | "webm"
  | "heif";

export interface FileType {
  /** Lowercase, without the dot. */
  extension: string;
  /** What the download is served as. Decided here, never by the client. */
  mimeType: string;
  signature: ContentSignature;
  /** Short human label for the file card. */
  label: string;
}

/**
 * Files offered as downloads. Anything not listed is refused.
 *
 * An allowlist rather than a blocklist: a blocklist of dangerous extensions is
 * always one entry short, whereas this fails closed.
 */
export const FILE_TYPES: readonly FileType[] = [
  { extension: "pdf", mimeType: "application/pdf", signature: "pdf", label: "PDF" },
  { extension: "txt", mimeType: "text/plain", signature: "text", label: "Text" },
  { extension: "md", mimeType: "text/markdown", signature: "text", label: "Markdown" },
  { extension: "csv", mimeType: "text/csv", signature: "text", label: "CSV" },
  { extension: "json", mimeType: "application/json", signature: "text", label: "JSON" },
  { extension: "rtf", mimeType: "application/rtf", signature: "rtf", label: "Rich text" },
  { extension: "doc", mimeType: "application/msword", signature: "ole", label: "Word" },
  { extension: "xls", mimeType: "application/vnd.ms-excel", signature: "ole", label: "Excel" },
  { extension: "ppt", mimeType: "application/vnd.ms-powerpoint", signature: "ole", label: "PowerPoint" },
  {
    extension: "docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    signature: "zip",
    label: "Word",
  },
  {
    extension: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    signature: "zip",
    label: "Excel",
  },
  {
    extension: "pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    signature: "zip",
    label: "PowerPoint",
  },
  { extension: "odt", mimeType: "application/vnd.oasis.opendocument.text", signature: "zip", label: "Document" },
  { extension: "ods", mimeType: "application/vnd.oasis.opendocument.spreadsheet", signature: "zip", label: "Spreadsheet" },
  { extension: "odp", mimeType: "application/vnd.oasis.opendocument.presentation", signature: "zip", label: "Presentation" },
  { extension: "zip", mimeType: "application/zip", signature: "zip", label: "ZIP" },
  { extension: "mp3", mimeType: "audio/mpeg", signature: "mp3", label: "Audio" },
  { extension: "m4a", mimeType: "audio/mp4", signature: "isoBmff", label: "Audio" },
  { extension: "weba", mimeType: "audio/webm", signature: "webm", label: "Audio" },
  { extension: "wav", mimeType: "audio/wav", signature: "wav", label: "Audio" },
  { extension: "ogg", mimeType: "audio/ogg", signature: "ogg", label: "Audio" },
  { extension: "mp4", mimeType: "video/mp4", signature: "isoBmff", label: "Video" },
  { extension: "mov", mimeType: "video/quicktime", signature: "isoBmff", label: "Video" },
  { extension: "webm", mimeType: "video/webm", signature: "webm", label: "Video" },
];

/**
 * The `accept` attribute for the composer's file picker.
 *
 * HEIC/HEIF are intentionally absent. iOS then converts a library photo to
 * JPEG; asking for HEIC makes it hand over an original whose GPS metadata this
 * app cannot safely remove when the browser lacks a decoder.
 */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_TYPES.map((type) => type.mimeType),
  ...FILE_TYPES.map((type) => `.${type.extension}`),
].join(",");

/** What the server tells every client about a stored attachment. */
export interface AttachmentView {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Pixel dimensions for images, so the thread can reserve space before load. */
  width: number | null;
  height: number | null;
}

/** Just enough to label a quoted attachment. */
export interface AttachmentLabelView {
  kind: AttachmentKind;
  fileName: string;
}

/** URL an attachment is served from. Access is checked on every request. */
export function attachmentUrl(id: string, download = false): string {
  const base = `/api/direct-messages/attachments/${encodeURIComponent(id)}`;

  return download ? `${base}?download=1` : base;
}

/**
 * Control and format characters, Unicode categories Cc and Cf.
 *
 * Cf includes the bidirectional overrides. U+202E turns `photo‮gpj.exe` into
 * something that displays as `photoexe.jpg`, which is the classic way to
 * disguise an executable as a picture.
 *
 * Built with `new RegExp` because this project's tsconfig declares no `target`,
 * so a regex literal is checked against ES5, which rejects property escapes.
 */
const INVISIBLE = new RegExp("[\\p{Cc}\\p{Cf}]", "gu");

/** Reserved on Windows, or path separators everywhere. */
const RESERVED = /[<>:"/\\|?*]/g;

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function takeCodePoints(value: string, count: number): string {
  return Array.from(value).slice(0, count).join("");
}

/** The lowercase extension of a file name, without the dot, or null. */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");

  if (dot <= 0 || dot === name.length - 1) {
    return null;
  }

  const extension = name.slice(dot + 1).toLowerCase();

  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : null;
}

/**
 * Makes an uploaded file name safe to store, display and offer as a download.
 *
 * The result is only ever a label. It is never used as a filesystem path, but it
 * does reach a `Content-Disposition` header and the recipient's downloads
 * folder, so anything that could inject a header, hide an extension or create a
 * hidden file is removed.
 */
export function sanitizeFileName(raw: string, fallback = "file"): string {
  // Last path segment only. Browsers already strip directories, but a crafted
  // request need not.
  const segments = raw.split(/[/\\]/);
  const lastSegment = segments[segments.length - 1] ?? "";

  let name = lastSegment
    .replace(INVISIBLE, "")
    .replace(RESERVED, "_")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot makes a hidden file; trailing dots and spaces are silently
    // dropped by Windows and so change the extension the user sees.
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");

  if (name.length === 0) {
    name = fallback;
  }

  if (countCodePoints(name) <= MAX_FILE_NAME_CHARS) {
    return name;
  }

  // Truncate the stem, never the extension, so the type survives.
  const extension = fileExtension(name);

  if (extension === null) {
    return takeCodePoints(name, MAX_FILE_NAME_CHARS).trim();
  }

  const stem = name.slice(0, name.length - extension.length - 1);
  const room = Math.max(1, MAX_FILE_NAME_CHARS - extension.length - 1);

  return `${takeCodePoints(stem, room).trim()}.${extension}`;
}

/** Swaps or adds an extension, keeping the stem. */
export function withExtension(name: string, extension: string): string {
  const current = fileExtension(name);
  const stem =
    current !== null && IMAGE_EXTENSIONS.includes(current)
      ? name.slice(0, name.length - current.length - 1)
      : name;

  return sanitizeFileName(`${stem}.${extension}`);
}

/** The file type for a name, or null when it is not allowed. */
export function fileTypeFor(name: string): FileType | null {
  const extension = fileExtension(name);

  if (extension === null) {
    return null;
  }

  return FILE_TYPES.find((type) => type.extension === extension) ?? null;
}

/** True when the extension names one of the inline image formats. */
export function hasImageExtension(name: string): boolean {
  const extension = fileExtension(name);

  return extension !== null && IMAGE_EXTENSIONS.includes(extension);
}

/** Human-readable size: `512 B`, `14 KB`, `3.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  const megabytes = bytes / (1024 * 1024);

  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/**
 * Scales dimensions down to fit a square limit, preserving aspect ratio.
 *
 * Never scales up, and never returns zero, so a 1 × 4000 strip still produces a
 * drawable image.
 */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  return fitWithinBox(width, height, maxSide, maxSide);
}

/** Scales dimensions down to fit a rectangle, preserving aspect ratio. */
export function fitWithinBox(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { width: Math.max(1, Math.round(maxWidth)), height: Math.max(1, Math.round(maxHeight)) };
  }

  const scale = Math.min(1, maxWidth / width, maxHeight / height);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * One-line description of an attachment for previews and notifications.
 *
 * Used wherever a message would otherwise show its body: an attachment sent
 * without a caption has an empty body, and an empty preview reads as a bug.
 */
const VOICE_MESSAGE_EXTENSIONS = ["m4a", "weba", "ogg", "mp3", "wav"];

/** True only for the safe filename pattern generated by the browser recorder. */
export function isVoiceMessageAttachment(
  attachment: AttachmentLabelView | null,
): boolean {
  if (attachment === null || attachment.kind !== "file") {
    return false;
  }

  const extension = fileExtension(attachment.fileName);

  return (
    attachment.fileName.toLowerCase().startsWith("voice-message-") &&
    extension !== null &&
    VOICE_MESSAGE_EXTENSIONS.includes(extension)
  );
}

export function attachmentPreviewText(
  attachment: AttachmentLabelView | null,
): string {
  if (attachment === null) {
    return "📎 Attachment";
  }

  if (isVoiceMessageAttachment(attachment)) {
    return "🎤 Voice message";
  }

  return attachment.kind === "image" ? "📷 Photo" : `📎 ${attachment.fileName}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readDimension(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_IMAGE_SIDE
    ? value
    : null;
}

/**
 * Narrows an attachment arriving over the wire.
 *
 * The thread polls an endpoint and renders whatever it returns, so the shape is
 * checked rather than trusted, exactly as the rest of the message is.
 */
export function parseAttachmentView(value: unknown): AttachmentView | null {
  const record = asRecord(value);

  if (
    record === null ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    (record.kind !== "image" && record.kind !== "file") ||
    typeof record.fileName !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.sizeBytes !== "number" ||
    !Number.isFinite(record.sizeBytes) ||
    record.sizeBytes < 0
  ) {
    return null;
  }

  return {
    id: record.id,
    kind: record.kind,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    width: readDimension(record.width),
    height: readDimension(record.height),
  };
}

/** Narrows the label carried on a quoted message. */
export function parseAttachmentLabel(value: unknown): AttachmentLabelView | null {
  const record = asRecord(value);

  if (
    record === null ||
    (record.kind !== "image" && record.kind !== "file") ||
    typeof record.fileName !== "string"
  ) {
    return null;
  }

  return { kind: record.kind, fileName: record.fileName };
}
