/**
 * Turns a file the user picked, pasted or dropped into an upload.
 *
 * Photos are decoded and redrawn on a canvas before they leave the device. That
 * does two jobs at once. It shrinks a phone photo, often 5–12 MB, to something
 * that fits the upload limit and loads quickly for the recipient. And it keeps
 * only the pixels: the EXIF block a phone writes into every photo, including the
 * GPS position it was taken at, does not survive a canvas. Re-encoding is the one
 * dependable way to strip that metadata in a browser without a library.
 *
 * Nothing decided here is trusted. The final bytes are run through the same
 * `inspectAttachment` the server uses, purely so a file the server would refuse
 * is refused before it is uploaded rather than after. The server repeats every
 * check on what actually arrives.
 */

import {
  inspectAttachment,
  sniffImageType,
} from "@/lib/messages/attachment-content";
import {
  IMAGE_TYPES,
  IMAGE_UPLOAD_MAX_DIMENSION,
  MAX_ATTACHMENT_BYTES,
  MAX_SOURCE_IMAGE_BYTES,
  fileExtension,
  fileTypeFor,
  fitWithin,
  formatBytes,
  hasImageExtension,
  sanitizeFileName,
  type AttachmentKind,
} from "@/lib/messages/attachment-rules";

export interface PreparedUpload {
  /** The bytes to send: a re-encoded photo, or the original file untouched. */
  blob: Blob;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

export type PrepareResult =
  | { ok: true; upload: PreparedUpload }
  | { ok: false; message: string };

/**
 * Largest photo the browser will try to decode, in pixels.
 *
 * Generous because the result is downscaled anyway, and 108-megapixel phone
 * cameras exist. Bounded because decoding costs four bytes per pixel, and a file
 * whose header claims billions of pixels would take the tab down with it.
 */
const MAX_SOURCE_PIXELS = 120_000_000;

/** Enough of the file to identify its image signature. */
const HEAD_BYTES = 64;

/**
 * Formats some browser may be able to open even though the thread cannot show
 * them inline. Safari opens HEIC; Chrome and Firefox open AVIF and BMP. Any of
 * them that decodes is converted and sent as an ordinary photo.
 */
const CONVERTIBLE_EXTENSIONS = ["heic", "heif", "avif", "bmp", "tif", "tiff"];

const UNREADABLE_IMAGE =
  "That image couldn't be opened. It may be damaged, or in a format this browser can't read.";
const TOO_MANY_PIXELS =
  "That image is too large to prepare. Try a smaller copy of it.";
const COULD_NOT_ENCODE =
  "That photo couldn't be prepared for sending. Try another one.";
const UNSUPPORTED_FILE =
  "That file type can't be sent. Try a photo, PDF, Office document, text file, ZIP, audio or video.";

type EncodableType = "image/jpeg" | "image/png" | "image/webp";

/** What a source is, for choosing how to re-encode it. */
type SourceKind = EncodableType | "photo" | "graphic";

interface EncodeAttempt {
  type: EncodableType;
  quality: number;
  /**
   * Paint white underneath first. JPEG has no transparency, and a transparent
   * pixel encoded as JPEG comes out black, which ruins screenshots and logos.
   */
  opaque: boolean;
}

/** Camera photos: JPEG, a little lower the second time if the first is too big. */
const PHOTO_ATTEMPTS: readonly EncodeAttempt[] = [
  { type: "image/jpeg", quality: 0.86, opaque: true },
  { type: "image/jpeg", quality: 0.72, opaque: true },
];

/**
 * Keeps the original format first, which keeps transparency and keeps text in a
 * screenshot crisp, then falls back to JPEG for the noisy images where a
 * lossless encoding runs too large.
 */
function attemptsFor(source: SourceKind): readonly EncodeAttempt[] {
  if (source === "image/jpeg" || source === "photo") {
    return PHOTO_ATTEMPTS;
  }

  const first: EncodableType = source === "image/webp" ? "image/webp" : "image/png";

  return [
    { type: first, quality: 0.86, opaque: false },
    { type: "image/jpeg", quality: 0.82, opaque: true },
    { type: "image/jpeg", quality: 0.7, opaque: true },
  ];
}

function looksLikeImage(file: File): boolean {
  const extension = fileExtension(file.name);

  return (
    file.type.startsWith("image/") ||
    hasImageExtension(file.name) ||
    (extension !== null && CONVERTIBLE_EXTENSIONS.includes(extension))
  );
}

function isHeif(file: File): boolean {
  const extension = fileExtension(file.name);

  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    extension === "heic" ||
    extension === "heif"
  );
}

/** The original name with its extension replaced, for a converted photo. */
function renamed(original: string, extension: string): string {
  const name = sanitizeFileName(original, "photo");
  const current = fileExtension(name);
  const stem =
    current === null ? name : name.slice(0, name.length - current.length - 1);

  return sanitizeFileName(`${stem.length > 0 ? stem : "photo"}.${extension}`);
}

/** Final gate: exactly the classification the server will make. */
function inspect(bytes: Uint8Array, blob: Blob, fileName: string): PrepareResult {
  const inspection = inspectAttachment({ bytes, fileName });

  if (!inspection.ok) {
    return { ok: false, message: inspection.message };
  }

  return {
    ok: true,
    upload: {
      blob,
      kind: inspection.kind,
      fileName: inspection.fileName,
      mimeType: inspection.mimeType,
      sizeBytes: blob.size,
      width: inspection.width,
      height: inspection.height,
    },
  };
}

interface LoadedImage {
  image: HTMLImageElement;
  release: () => void;
}

/** Decodes a blob with the browser's own decoder, or null when it cannot. */
function loadImage(blob: Blob): Promise<LoadedImage | null> {
  const url = URL.createObjectURL(blob);

  return new Promise((resolve) => {
    const image = new Image();

    image.onload = () => {
      resolve({ image, release: () => URL.revokeObjectURL(url) });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

function drawScaled(
  image: HTMLImageElement,
  width: number,
  height: number,
  opaque: boolean,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (context === null) {
    return null;
  }

  if (opaque) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  try {
    // Browsers apply the EXIF orientation when drawing, so a portrait phone
    // photo stays upright even though the tag itself is dropped.
    context.drawImage(image, 0, 0, width, height);
  } catch {
    return null;
  }

  return canvas;
}

/** Frees a canvas's pixels now. iOS Safari caps canvas memory per tab and is slow to reclaim it. */
function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (canvas !== null) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: EncodableType,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      // A tainted canvas throws. A local file never taints one, but nothing here
      // is allowed to throw past the caller.
      resolve(null);
    }
  });
}

/** Downscales and re-encodes an image, which also strips its metadata. */
async function reencode(file: File, source: SourceKind): Promise<PrepareResult> {
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    return {
      ok: false,
      message: `Photos can be up to ${formatBytes(
        MAX_SOURCE_IMAGE_BYTES,
      )}. This one is ${formatBytes(file.size)}.`,
    };
  }

  const loaded = await loadImage(file);

  if (loaded === null) {
    return { ok: false, message: UNREADABLE_IMAGE };
  }

  try {
    const { image } = loaded;
    // Known once the header is parsed, before the pixels are decoded, so an
    // absurd image is refused before it costs any memory.
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;

    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return { ok: false, message: UNREADABLE_IMAGE };
    }

    if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
      return { ok: false, message: TOO_MANY_PIXELS };
    }

    const { width, height } = fitWithin(
      sourceWidth,
      sourceHeight,
      IMAGE_UPLOAD_MAX_DIMENSION,
    );

    let canvas: HTMLCanvasElement | null = null;
    let canvasIsOpaque = false;
    let encoded: Blob | null = null;
    let producedAny = false;

    try {
      for (const attempt of attemptsFor(source)) {
        // Redrawn only when the background changes, so successive qualities of
        // the same format reuse one drawing.
        if (canvas === null || canvasIsOpaque !== attempt.opaque) {
          releaseCanvas(canvas);
          canvas = drawScaled(image, width, height, attempt.opaque);
          canvasIsOpaque = attempt.opaque;

          if (canvas === null) {
            break;
          }
        }

        const blob = await encodeCanvas(canvas, attempt.type, attempt.quality);

        if (blob === null || blob.size === 0) {
          continue;
        }

        producedAny = true;

        if (blob.size <= MAX_ATTACHMENT_BYTES) {
          encoded = blob;
          break;
        }
      }
    } finally {
      releaseCanvas(canvas);
    }

    if (encoded === null) {
      return {
        ok: false,
        message: producedAny
          ? `That photo is still over ${formatBytes(
              MAX_ATTACHMENT_BYTES,
            )} after resizing. Try a smaller one.`
          : COULD_NOT_ENCODE,
      };
    }

    const bytes = new Uint8Array(await encoded.arrayBuffer());
    // Named by what the encoder actually produced. A browser that cannot write
    // WebP quietly returns PNG instead, and the name has to follow.
    const producedType = sniffImageType(bytes);
    const extension =
      IMAGE_TYPES.find((type) => type.mimeType === producedType)?.extension ?? null;

    if (extension === null) {
      return { ok: false, message: COULD_NOT_ENCODE };
    }

    return inspect(bytes, encoded, renamed(file.name, extension));
  } finally {
    loaded.release();
  }
}

/** Sends a non-image file exactly as it is after the local courtesy checks. */
async function sendFileUnchanged(file: File): Promise<PrepareResult> {
  if (fileTypeFor(sanitizeFileName(file.name)) === null) {
    return { ok: false, message: UNSUPPORTED_FILE };
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      message: `Files can be up to ${formatBytes(
        MAX_ATTACHMENT_BYTES,
      )}. This one is ${formatBytes(file.size)}.`,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  return inspect(bytes, file, file.name);
}

async function prepare(file: File): Promise<PrepareResult> {
  if (file.size === 0) {
    return { ok: false, message: "That file is empty." };
  }

  // Decided by the bytes, as the server decides it, not by the name or the type
  // the operating system guessed from the name.
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const sniffed = sniffImageType(head);

  if (sniffed !== null) {
    // GIF and animated WebP are deliberately flattened. Redrawing is what strips
    // comments/XMP/EXIF, and it also prevents a tiny file with thousands of
    // frames from imposing an unbounded decode workload on every recipient.
    return reencode(file, sniffed === "image/gif" ? "graphic" : sniffed);
  }

  if (looksLikeImage(file)) {
    // No unchanged fallback for HEIC/HEIF: if this browser cannot decode and
    // redraw it, the app cannot promise that GPS metadata was removed.
    return reencode(file, isHeif(file) ? "photo" : "graphic");
  }

  return sendFileUnchanged(file);
}

/**
 * Prepares one file for sending, or explains why it cannot be sent.
 *
 * Never throws. A file that disappeared from disk after it was picked, or a read
 * the browser refused, comes back as an ordinary refusal.
 */
export async function prepareAttachment(file: File): Promise<PrepareResult> {
  try {
    return await prepare(file);
  } catch {
    return {
      ok: false,
      message: "That file couldn't be read. Try choosing it again.",
    };
  }
}
