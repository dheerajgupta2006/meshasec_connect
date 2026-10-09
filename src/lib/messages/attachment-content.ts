/**
 * Deciding what an uploaded file actually is, from its bytes.
 *
 * Nothing the client says about a file is trusted: not its name, not the
 * `Content-Type` of its multipart part. A file's type is what its leading bytes
 * prove it to be, and the name only chooses between types that pass that proof.
 *
 * Pure and dependency-free — it works on a `Uint8Array` and nothing else — so
 * every rule here is unit-testable with hand-built byte fixtures.
 */

import {
  FILE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  fileExtension,
  fileTypeFor,
  hasImageExtension,
  IMAGE_TYPES,
  sanitizeFileName,
  withExtension,
  type ContentSignature,
  type ImageMimeType,
} from "@/lib/messages/attachment-rules";

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }

  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) {
      return false;
    }
  }

  return true;
}

function ascii(text: string): number[] {
  const codes: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    codes.push(text.charCodeAt(index));
  }

  return codes;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) {
    return "";
  }

  let text = "";

  for (let index = offset; index < offset + length; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }

  return text;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");

/** The inline image format these bytes are, or null. */
export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, PNG)) {
    return "image/png";
  }

  if (startsWith(bytes, JPEG)) {
    return "image/jpeg";
  }

  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) {
    return "image/gif";
  }

  if (startsWith(bytes, RIFF) && readAscii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }

  return null;
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  // `>>> 0` keeps the result unsigned; a plain shift goes negative past 2^31.
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

export interface ImageDimensions {
  width: number;
  height: number;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  // The IHDR chunk must come first: 8-byte signature, 4-byte length, "IHDR".
  if (bytes.length < 24 || readAscii(bytes, 12, 4) !== "IHDR") {
    return null;
  }

  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) {
    return null;
  }

  return { width: uint16le(bytes, 6), height: uint16le(bytes, 8) };
}

/** Start-of-frame markers, which carry the dimensions. C4, C8 and CC share the
 * range but are a Huffman table, a reserved marker and arithmetic conditioning. */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2;

  // Each pass advances by at least two bytes, so this terminates on any input.
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }

    // Any number of 0xFF fill bytes may precede a marker.
    let markerOffset = offset + 1;

    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }

    if (markerOffset >= bytes.length) {
      return null;
    }

    const marker = bytes[markerOffset];
    const segment = markerOffset + 1;

    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = segment;
      continue;
    }

    // End of image, or the start of scan data, with no frame header seen.
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }

    if (segment + 1 >= bytes.length) {
      return null;
    }

    const length = uint16be(bytes, segment);

    if (length < 2) {
      return null;
    }

    if (isStartOfFrame(marker)) {
      // Length (2), precision (1), height (2), width (2).
      if (segment + 6 >= bytes.length) {
        return null;
      }

      return {
        height: uint16be(bytes, segment + 3),
        width: uint16be(bytes, segment + 5),
      };
    }

    offset = segment + length;
  }

  return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  const chunk = readAscii(bytes, 12, 4);

  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag, then the 9D 01 2A start code, then 14-bit
    // dimensions with two scaling bits on top.
    if (bytes.length < 30 || !startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
      return null;
    }

    return {
      width: uint16le(bytes, 26) & 0x3fff,
      height: uint16le(bytes, 28) & 0x3fff,
    };
  }

  if (chunk === "VP8L") {
    // Lossless: a 0x2F signature byte, then width-1 and height-1 packed into
    // 14 bits each.
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      return null;
    }

    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];

    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }

  if (chunk === "VP8X") {
    // Extended: canvas width-1 and height-1 as 24-bit little-endian values.
    if (bytes.length < 30) {
      return null;
    }

    return {
      width: 1 + uint24le(bytes, 24),
      height: 1 + uint24le(bytes, 27),
    };
  }

  return null;
}

/**
 * Pixel dimensions from an image's header, without decoding it.
 *
 * Null for a header that cannot be read, which the caller treats as a damaged
 * file. This is what lets the server refuse a decompression bomb before any
 * client ever tries to render it.
 */
export function readImageDimensions(
  bytes: Uint8Array,
  mimeType: ImageMimeType,
): ImageDimensions | null {
  let dimensions: ImageDimensions | null;

  switch (mimeType) {
    case "image/png":
      dimensions = pngDimensions(bytes);
      break;
    case "image/jpeg":
      dimensions = jpegDimensions(bytes);
      break;
    case "image/gif":
      dimensions = gifDimensions(bytes);
      break;
    case "image/webp":
      dimensions = webpDimensions(bytes);
      break;
    default:
      dimensions = null;
  }

  if (dimensions === null || dimensions.width <= 0 || dimensions.height <= 0) {
    return null;
  }

  return dimensions;
}

/** JPEG markers that can carry EXIF/XMP, IPTC, or a free-form comment. */
const JPEG_PRIVATE_MARKERS = [0xe1, 0xed, 0xfe];
/** PNG ancillary chunks that can carry user text, timestamps, XMP, or EXIF. */
const PNG_PRIVATE_CHUNKS = [
  "eXIf",
  "iTXt",
  "tEXt",
  "zTXt",
  "tIME",
  // Animated PNG control. Flattened by the normal browser preparation path.
  "acTL",
];
/** WebP chunks that carry metadata or make the image animated. */
const WEBP_PRIVATE_CHUNKS = ["EXIF", "XMP ", "ANIM", "ANMF"];

function jpegHasPrivateMetadata(bytes: Uint8Array): boolean {
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return false;
    }

    let markerOffset = offset + 1;

    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }

    if (markerOffset >= bytes.length) {
      return false;
    }

    const marker = bytes[markerOffset];
    const segment = markerOffset + 1;

    if (JPEG_PRIVATE_MARKERS.includes(marker)) {
      return true;
    }

    // Scan metadata only before compressed pixels. Bytes after SOS contain
    // escaped 0xFF values that are not segment markers.
    if (marker === 0xda || marker === 0xd9) {
      return false;
    }

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = segment;
      continue;
    }

    if (segment + 1 >= bytes.length) {
      return false;
    }

    const length = uint16be(bytes, segment);

    if (length < 2 || segment + length > bytes.length) {
      return false;
    }

    offset = segment + length;
  }

  return false;
}

function pngHasPrivateMetadata(bytes: Uint8Array): boolean {
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = uint32be(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);

    if (PNG_PRIVATE_CHUNKS.includes(type)) {
      return true;
    }

    // Length excludes the type and CRC. Stop safely on a truncated or crafted
    // chunk rather than letting an integer point past the buffer.
    const next = offset + 12 + length;

    if (next > bytes.length || next <= offset) {
      return false;
    }

    if (type === "IEND") {
      return false;
    }

    offset = next;
  }

  return false;
}

function webpHasPrivateMetadataOrAnimation(bytes: Uint8Array): boolean {
  // Extended WebP declares animation, EXIF and XMP in its feature byte even if
  // a malformed file hides or truncates the corresponding chunk later.
  if (
    readAscii(bytes, 12, 4) === "VP8X" &&
    bytes.length >= 21 &&
    (bytes[20] & 0x0e) !== 0
  ) {
    return true;
  }

  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const type = readAscii(bytes, offset, 4);
    const length = uint32le(bytes, offset + 4);

    if (WEBP_PRIVATE_CHUNKS.includes(type)) {
      return true;
    }

    // Chunks are padded to an even number of bytes.
    const paddedLength = length + (length % 2);
    const next = offset + 8 + paddedLength;

    if (next > bytes.length || next <= offset) {
      return false;
    }

    offset = next;
  }

  return false;
}

/**
 * Whether bytes must be redrawn before this app will store them as a photo.
 *
 * The normal composer does that redraw. Repeating the check server-side means a
 * crafted multipart request cannot bypass GPS stripping or send an animation
 * with an unbounded cumulative decode workload to the recipient.
 */
function imageNeedsSanitising(
  bytes: Uint8Array,
  mimeType: ImageMimeType,
): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return jpegHasPrivateMetadata(bytes);
    case "image/png":
      return pngHasPrivateMetadata(bytes);
    case "image/webp":
      return webpHasPrivateMetadataOrAnimation(bytes);
    // The browser redraws GIFs to PNG. The server cannot cheaply distinguish all
    // metadata extensions and bound every frame, so originals fail closed.
    case "image/gif":
      return true;
    default:
      return true;
  }
}

/**
 * Valid UTF-8 with no NUL bytes.
 *
 * NUL is the cheap tell for binary content, which is what an executable renamed
 * to `.txt` would be.
 */
export function isProbablyText(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      return false;
    }
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** ISO base media file format box types that may open an MP4, M4A or MOV. */
const ISO_BMFF_BOXES = [
  "ftyp",
  "styp",
  "moov",
  "mdat",
  "wide",
  "free",
  "skip",
  "pnot",
];

/** HEIF brands, read from the `ftyp` box. */
const HEIF_BRANDS = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
];

/** True when the bytes are what `signature` says this type must look like. */
export function matchesSignature(
  bytes: Uint8Array,
  signature: ContentSignature,
): boolean {
  switch (signature) {
    case "pdf": {
      // The header may sit anywhere in the first kilobyte; some generators put
      // a few bytes of junk ahead of it.
      const head = readAscii(bytes, 0, Math.min(bytes.length, 1024));
      return head.includes("%PDF-");
    }
    case "text":
      return isProbablyText(bytes);
    case "rtf":
      return startsWith(bytes, ascii("{\\rtf"));
    case "ole":
      return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "zip":
      // Local file header, empty archive, or spanned archive.
      return (
        startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
        startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
      );
    case "mp3":
      // An ID3 tag, or straight into an MPEG audio frame sync.
      return (
        startsWith(bytes, ascii("ID3")) ||
        (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      );
    case "isoBmff":
      return ISO_BMFF_BOXES.includes(readAscii(bytes, 4, 4));
    case "wav":
      return startsWith(bytes, RIFF) && readAscii(bytes, 8, 4) === "WAVE";
    case "ogg":
      return startsWith(bytes, ascii("OggS"));
    case "webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "heif":
      return (
        readAscii(bytes, 4, 4) === "ftyp" &&
        HEIF_BRANDS.includes(readAscii(bytes, 8, 4))
      );
    default:
      return false;
  }
}

/**
 * Native executables and Java classes.
 *
 * Every allowed type already has to pass a content signature, so this is
 * defence in depth: it names the thing being kept out, so a future loosening of
 * a signature cannot quietly let it back in.
 */
export function looksExecutable(bytes: Uint8Array): boolean {
  return (
    // Windows PE / DOS MZ.
    startsWith(bytes, [0x4d, 0x5a]) ||
    // ELF.
    startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    // Mach-O, both endiannesses and widths, and fat binaries / Java classes.
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])
  );
}

export type InspectionFailure =
  | "empty"
  | "too_large"
  | "executable"
  | "damaged_image"
  | "image_too_large"
  | "unsanitized_image"
  | "content_mismatch"
  | "unsupported_type";

export type InspectionResult =
  | {
      ok: true;
      kind: "image";
      mimeType: ImageMimeType;
      fileName: string;
      width: number;
      height: number;
    }
  | {
      ok: true;
      kind: "file";
      mimeType: string;
      fileName: string;
      width: null;
      height: null;
    }
  | { ok: false; reason: InspectionFailure; message: string };

const SUPPORTED_SUMMARY =
  "Send a photo (PNG, JPEG, GIF, WebP) or a document such as PDF, Word, Excel, PowerPoint, text, CSV or ZIP.";

/**
 * Classifies an upload, or explains why it is refused.
 *
 * Images are recognised by content regardless of their name, and the name is
 * corrected to match, so `photo.jpg` that is really a PNG becomes `photo.png`.
 * Everything else must have an allowed extension *and* content that matches it.
 */
export function inspectAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
}): InspectionResult {
  const { bytes } = input;
  const fileName = sanitizeFileName(input.fileName);

  if (bytes.length === 0) {
    return { ok: false, reason: "empty", message: "That file is empty." };
  }

  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: "Files are limited to 4 MB.",
    };
  }

  if (looksExecutable(bytes)) {
    return {
      ok: false,
      reason: "executable",
      message: "Programs and executable files can't be sent.",
    };
  }

  const imageType = sniffImageType(bytes);

  if (imageType !== null) {
    const dimensions = readImageDimensions(bytes, imageType);

    if (dimensions === null) {
      return {
        ok: false,
        reason: "damaged_image",
        message: "That image appears to be damaged.",
      };
    }

    if (imageNeedsSanitising(bytes, imageType)) {
      return {
        ok: false,
        reason: "unsanitized_image",
        message:
          imageType === "image/gif"
            ? "That GIF could not be prepared safely. Convert it to PNG or JPEG first."
            : "That photo still contains private metadata or animation data. Choose it through the message composer so it can be prepared safely.",
      };
    }

    if (
      dimensions.width > MAX_IMAGE_SIDE ||
      dimensions.height > MAX_IMAGE_SIDE ||
      dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
    ) {
      return {
        ok: false,
        reason: "image_too_large",
        message: "That image is too large to display safely.",
      };
    }

    const extension =
      IMAGE_TYPES.find((type) => type.mimeType === imageType)?.extension ?? "img";

    return {
      ok: true,
      kind: "image",
      mimeType: imageType,
      fileName: withExtension(fileName, extension),
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  // Named as an image but not one: refused rather than downloaded, because the
  // recipient would open it expecting a picture.
  if (hasImageExtension(fileName)) {
    return {
      ok: false,
      reason: "content_mismatch",
      message: "That file isn't a valid image.",
    };
  }

  const extension = fileExtension(fileName);

  // HEIC/HEIF commonly carries the same EXIF/GPS block as JPEG. A browser that
  // can decode it redraws it to JPEG in the composer; an undecodable original
  // fails closed instead of being stored as a metadata-bearing download.
  if (extension === "heic" || extension === "heif") {
    return {
      ok: false,
      reason: "unsanitized_image",
      message:
        "This browser could not prepare that HEIC photo safely. Convert it to JPEG or PNG first.",
    };
  }

  const fileType = fileTypeFor(fileName);

  if (fileType === null) {
    return {
      ok: false,
      reason: "unsupported_type",
      message: `That file type can't be sent. ${SUPPORTED_SUMMARY}`,
    };
  }

  if (!matchesSignature(bytes, fileType.signature)) {
    return {
      ok: false,
      reason: "content_mismatch",
      message: `That file doesn't look like a real .${fileType.extension} file.`,
    };
  }

  return {
    ok: true,
    kind: "file",
    mimeType: fileType.mimeType,
    fileName,
    width: null,
    height: null,
  };
}

/** Every MIME type this module can ever assign, for the download route's check. */
export const ASSIGNABLE_MIME_TYPES: readonly string[] = [
  ...IMAGE_TYPES.map((type) => type.mimeType),
  ...FILE_TYPES.map((type) => type.mimeType),
];

/**
 * Plain-ASCII stand-in for the legacy `filename` parameter.
 *
 * Quotes and backslashes would end or escape the quoted string, and anything
 * outside printable ASCII is undefined in that parameter, so all of it becomes
 * an underscore. The real name travels in `filename*`.
 */
function asciiFallback(fileName: string): string {
  let fallback = "";

  for (let index = 0; index < fileName.length; index += 1) {
    const code = fileName.charCodeAt(index);
    const character = fileName[index];

    fallback +=
      code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\"
        ? character
        : "_";
  }

  return fallback.length > 0 ? fallback : "file";
}

/** RFC 5987 encoding. `encodeURIComponent` leaves `'()*` alone; they are not
 * attribute characters, so they are escaped too. */
function encodeRfc5987(value: string): string {
  let encoded: string;

  try {
    encoded = encodeURIComponent(value);
  } catch {
    // `encodeURIComponent` throws on a lone surrogate. Names decoded from a
    // multipart body cannot contain one, but a header builder must not be able
    // to throw, so the ASCII form is encoded instead.
    encoded = encodeURIComponent(asciiFallback(value));
  }

  return encoded.replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * A `Content-Disposition` header value that cannot be used to inject headers.
 *
 * Both forms are sent: browsers that understand `filename*` use the exact
 * Unicode name, and the ASCII fallback covers the rest.
 */
export function contentDisposition(
  type: "inline" | "attachment",
  fileName: string,
): string {
  return `${type}; filename="${asciiFallback(fileName)}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

/**
 * Whether an `If-None-Match` header covers this entity tag.
 *
 * Handles lists, the `*` wildcard and weak validators, which is what a browser
 * revalidating a cached image actually sends.
 */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) {
    return false;
  }

  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === "*" ||
        candidate === etag ||
        candidate.replace(/^W\//, "") === etag,
    );
}
