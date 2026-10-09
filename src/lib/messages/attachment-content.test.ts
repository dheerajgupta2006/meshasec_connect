import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  contentDisposition,
  etagMatches,
  inspectAttachment,
  isProbablyText,
  looksExecutable,
  matchesSignature,
  readImageDimensions,
  sniffImageType,
} from "@/lib/messages/attachment-content";
import { MAX_ATTACHMENT_BYTES } from "@/lib/messages/attachment-rules";

// ---- Byte fixtures. Minimal but structurally real headers for each format. ----

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];

  parts.forEach((part) => {
    if (typeof part === "string") {
      for (let index = 0; index < part.length; index += 1) {
        out.push(part.charCodeAt(index));
      }
    } else {
      out.push(...part);
    }
  });

  return new Uint8Array(out);
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function be16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function le24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function png(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    "IHDR",
    be32(width),
    be32(height),
    [8, 6, 0, 0, 0],
    [0, 0, 0, 0],
  );
}

function jpeg(
  width: number,
  height: number,
  options: { sof?: number; prelude?: number[] } = {},
): Uint8Array {
  const sof = options.sof ?? 0xc0;

  return bytes(
    [0xff, 0xd8],
    // APP0 JFIF segment, which real files carry ahead of the frame header.
    [0xff, 0xe0],
    be16(16),
    "JFIF",
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    options.prelude ?? [],
    [0xff, sof],
    be16(17),
    [8],
    be16(height),
    be16(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xd9],
  );
}

function gif(width: number, height: number): Uint8Array {
  return bytes("GIF89a", le16(width), le16(height), [0xf7, 0, 0]);
}

function webpLossy(width: number, height: number): Uint8Array {
  return bytes(
    "RIFF",
    [0, 0, 0, 0],
    "WEBP",
    "VP8 ",
    [0, 0, 0, 0],
    [0, 0, 0],
    [0x9d, 0x01, 0x2a],
    le16(width),
    le16(height),
  );
}

function webpLossless(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);

  return bytes(
    "RIFF",
    [0, 0, 0, 0],
    "WEBP",
    "VP8L",
    [0, 0, 0, 0],
    [0x2f],
    [bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff],
  );
}

function webpExtended(width: number, height: number): Uint8Array {
  return bytes(
    "RIFF",
    [0, 0, 0, 0],
    "WEBP",
    "VP8X",
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    le24(width - 1),
    le24(height - 1),
  );
}

const PDF = bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], [20, 0, 0, 0]);
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], [0, 0]);
const TEXT = bytes("name,city\nAsha,Hyderabad\n");
const PE = bytes("MZ", [0x90, 0, 3, 0]);

describe("sniffImageType", () => {
  it("recognises each inline format", () => {
    expect(sniffImageType(png(1, 1))).toBe("image/png");
    expect(sniffImageType(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffImageType(gif(1, 1))).toBe("image/gif");
    expect(sniffImageType(webpLossy(1, 1))).toBe("image/webp");
  });

  it("does not mistake other formats for images", () => {
    expect(sniffImageType(PDF)).toBeNull();
    expect(sniffImageType(ZIP)).toBeNull();
    // A WAV is RIFF too; only RIFF....WEBP is an image.
    expect(sniffImageType(bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("readImageDimensions", () => {
  it("reads PNG", () => {
    expect(readImageDimensions(png(1920, 1080), "image/png")).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("reads PNG dimensions above 2^31 without going negative", () => {
    const dimensions = readImageDimensions(png(0x80000001, 10), "image/png");

    expect(dimensions?.width).toBe(0x80000001);
  });

  it("reads baseline and progressive JPEG past earlier segments", () => {
    expect(readImageDimensions(jpeg(4032, 3024), "image/jpeg")).toEqual({
      width: 4032,
      height: 3024,
    });
    expect(readImageDimensions(jpeg(640, 480, { sof: 0xc2 }), "image/jpeg")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("skips fill bytes and non-frame segments before the frame header", () => {
    // An EXIF APP1 segment and a Huffman table (C4, which is not a frame
    // marker despite sitting in the SOF range).
    const prelude = [0xff, 0xff, 0xe1, ...be16(6), 0x45, 0x78, 0x69, 0x66, 0xff, 0xc4, ...be16(4), 0, 0];

    expect(readImageDimensions(jpeg(300, 200, { prelude }), "image/jpeg")).toEqual({
      width: 300,
      height: 200,
    });
  });

  it("refuses a JPEG whose scan starts before any frame header", () => {
    const noFrame = bytes([0xff, 0xd8], [0xff, 0xda], be16(8), [1, 1, 0, 0, 0x3f, 0], [0xff, 0xd9]);

    expect(readImageDimensions(noFrame, "image/jpeg")).toBeNull();
  });

  it("refuses a truncated JPEG", () => {
    expect(readImageDimensions(jpeg(300, 200).slice(0, 25), "image/jpeg")).toBeNull();
  });

  it("reads GIF", () => {
    expect(readImageDimensions(gif(320, 240), "image/gif")).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("reads all three WebP variants", () => {
    expect(readImageDimensions(webpLossy(1024, 768), "image/webp")).toEqual({
      width: 1024,
      height: 768,
    });
    expect(readImageDimensions(webpLossless(1000, 700), "image/webp")).toEqual({
      width: 1000,
      height: 700,
    });
    expect(readImageDimensions(webpExtended(4000, 3000), "image/webp")).toEqual({
      width: 4000,
      height: 3000,
    });
  });

  it("refuses zero-sized images", () => {
    expect(readImageDimensions(png(0, 10), "image/png")).toBeNull();
    expect(readImageDimensions(gif(10, 0), "image/gif")).toBeNull();
  });

  it("never throws on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (input) => {
        readImageDimensions(input, "image/png");
        readImageDimensions(input, "image/jpeg");
        readImageDimensions(input, "image/gif");
        readImageDimensions(input, "image/webp");
        sniffImageType(input);
        return true;
      }),
    );
  });

  it("never loops on a JPEG of random segments", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (tail) => {
        const input = new Uint8Array(tail.length + 2);
        input.set([0xff, 0xd8]);
        input.set(tail, 2);
        readImageDimensions(input, "image/jpeg");
        return true;
      }),
    );
  });
});

describe("signatures", () => {
  it("accepts matching content", () => {
    expect(matchesSignature(PDF, "pdf")).toBe(true);
    expect(matchesSignature(ZIP, "zip")).toBe(true);
    expect(matchesSignature(OLE, "ole")).toBe(true);
    expect(matchesSignature(TEXT, "text")).toBe(true);
    expect(matchesSignature(bytes("{\\rtf1\\ansi"), "rtf")).toBe(true);
    expect(matchesSignature(bytes("ID3", [3, 0]), "mp3")).toBe(true);
    expect(matchesSignature(bytes([0xff, 0xfb, 0x90]), "mp3")).toBe(true);
    expect(matchesSignature(bytes([0, 0, 0, 0x20], "ftypisom"), "isoBmff")).toBe(true);
    expect(matchesSignature(bytes([0, 0, 0, 0x08], "moov"), "isoBmff")).toBe(true);
    expect(matchesSignature(bytes("RIFF", [0, 0, 0, 0], "WAVE"), "wav")).toBe(true);
    expect(matchesSignature(bytes("OggS", [0]), "ogg")).toBe(true);
    expect(matchesSignature(bytes([0x1a, 0x45, 0xdf, 0xa3]), "webm")).toBe(true);
    expect(matchesSignature(bytes([0, 0, 0, 0x18], "ftypheic"), "heif")).toBe(true);
  });

  it("finds a PDF header that is not at byte zero", () => {
    expect(matchesSignature(bytes("\n\n  %PDF-1.4"), "pdf")).toBe(true);
  });

  it("rejects mismatched content", () => {
    expect(matchesSignature(TEXT, "pdf")).toBe(false);
    expect(matchesSignature(PDF, "zip")).toBe(false);
    expect(matchesSignature(bytes([0, 0, 0, 0x18], "ftypisom"), "heif")).toBe(false);
  });

  it("treats NUL bytes and invalid UTF-8 as binary", () => {
    expect(isProbablyText(bytes("abc", [0], "def"))).toBe(false);
    expect(isProbablyText(bytes([0xc3, 0x28]))).toBe(false);
    expect(isProbablyText(new TextEncoder().encode("తెలుగు text"))).toBe(true);
  });

  it("recognises executables", () => {
    expect(looksExecutable(PE)).toBe(true);
    expect(looksExecutable(bytes([0x7f], "ELF"))).toBe(true);
    expect(looksExecutable(bytes([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(looksExecutable(PDF)).toBe(false);
  });
});

describe("inspectAttachment", () => {
  it("accepts an image and records its dimensions", () => {
    const result = inspectAttachment({ bytes: png(800, 600), fileName: "photo.png" });

    expect(result).toEqual({
      ok: true,
      kind: "image",
      mimeType: "image/png",
      fileName: "photo.png",
      width: 800,
      height: 600,
    });
  });

  it("trusts the bytes over the name for images", () => {
    const relabelled = inspectAttachment({ bytes: png(10, 10), fileName: "photo.jpg" });

    expect(relabelled.ok && relabelled.fileName).toBe("photo.png");

    const disguised = inspectAttachment({ bytes: png(10, 10), fileName: "notes.txt" });

    expect(disguised.ok && disguised.kind).toBe("image");
    expect(disguised.ok && disguised.fileName).toBe("notes.txt.png");
  });

  it("accepts documents whose content matches their extension", () => {
    const pdf = inspectAttachment({ bytes: PDF, fileName: "report.pdf" });

    expect(pdf).toEqual({
      ok: true,
      kind: "file",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      width: null,
      height: null,
    });

    expect(inspectAttachment({ bytes: ZIP, fileName: "notes.docx" }).ok).toBe(true);
    expect(inspectAttachment({ bytes: OLE, fileName: "old.xls" }).ok).toBe(true);
    expect(inspectAttachment({ bytes: TEXT, fileName: "people.csv" }).ok).toBe(true);
  });

  it("refuses a HEIC original when its metadata cannot be stripped", () => {
    const heic = inspectAttachment({
      bytes: bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]),
      fileName: "IMG_0001.HEIC",
    });

    expect(heic.ok).toBe(false);
    expect(!heic.ok && heic.reason).toBe("unsanitized_image");
  });

  it("refuses content that does not match its extension", () => {
    const result = inspectAttachment({ bytes: TEXT, fileName: "invoice.pdf" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("content_mismatch");
  });

  it("refuses binary data posing as text", () => {
    const result = inspectAttachment({ bytes: bytes("hi", [0, 1, 2]), fileName: "a.txt" });

    expect(!result.ok && result.reason).toBe("content_mismatch");
  });

  it("refuses a file named as an image that is not one", () => {
    const result = inspectAttachment({ bytes: TEXT, fileName: "photo.jpg" });

    expect(!result.ok && result.reason).toBe("content_mismatch");
  });

  it("refuses executables whatever they are called", () => {
    for (const fileName of ["setup.exe", "invoice.pdf", "notes.txt", "a.zip"]) {
      const result = inspectAttachment({ bytes: PE, fileName });

      expect(!result.ok && result.reason).toBe("executable");
    }
  });

  it("refuses types that are not on the allowlist", () => {
    for (const fileName of ["page.html", "logo.svg", "run.sh", "README"]) {
      const result = inspectAttachment({ bytes: TEXT, fileName });

      expect(!result.ok && result.reason).toBe("unsupported_type");
    }
  });

  it("refuses empty and oversized files", () => {
    expect(inspectAttachment({ bytes: new Uint8Array(), fileName: "a.txt" })).toMatchObject({
      ok: false,
      reason: "empty",
    });

    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(PDF);

    expect(inspectAttachment({ bytes: big, fileName: "big.pdf" })).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });

  it("refuses decompression bombs by their declared size", () => {
    // Tiny files that would need gigabytes to display.
    for (const bomb of [png(30_000, 30_000), png(20_000, 10), png(8000, 6000)]) {
      expect(inspectAttachment({ bytes: bomb, fileName: "bomb.png" })).toMatchObject({
        ok: false,
        reason: "image_too_large",
      });
    }
  });

  it("refuses an image whose header cannot be read", () => {
    const damaged = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "garbage-garbage-garbage");

    expect(inspectAttachment({ bytes: damaged, fileName: "a.png" })).toMatchObject({
      ok: false,
      reason: "damaged_image",
    });
  });

  it("sanitizes the stored name", () => {
    const result = inspectAttachment({ bytes: PDF, fileName: "../../secret\r\n.pdf" });

    expect(result.ok && result.fileName).toBe("secret.pdf");
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 256 }),
        fc.string({ unit: "binary", maxLength: 80 }),
        (input, fileName) => {
          inspectAttachment({ bytes: input, fileName });
          return true;
        },
      ),
    );
  });
});

describe("contentDisposition", () => {
  it("sends an ASCII fallback and the exact UTF-8 name", () => {
    expect(contentDisposition("attachment", "plan.pdf")).toBe(
      "attachment; filename=\"plan.pdf\"; filename*=UTF-8''plan.pdf",
    );

    const header = contentDisposition("inline", "రేపు.png");

    expect(header.startsWith('inline; filename="')).toBe(true);
    expect(header).toContain("filename*=UTF-8''%E0%B0%B0");
  });

  it("escapes quotes, backslashes and RFC 5987 specials", () => {
    const header = contentDisposition("attachment", 'a"b\\c(1)*\'.txt');

    expect(header).toContain('filename="a_b_c(1)*\'.txt"');
    expect(header).toContain("filename*=UTF-8''a%22b%5Cc%281%29%2A%27.txt");
  });

  it("can never be used to inject a header", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 120 }), (name) => {
        const header = contentDisposition("attachment", name);

        return !/[\r\n\u0000]/.test(header) && (header.match(/"/g) ?? []).length === 2;
      }),
    );
  });
});

describe("etagMatches", () => {
  const etag = '"abc123"';

  it("matches exact, weak, listed and wildcard validators", () => {
    expect(etagMatches('"abc123"', etag)).toBe(true);
    expect(etagMatches('W/"abc123"', etag)).toBe(true);
    expect(etagMatches('"other", "abc123"', etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
  });

  it("does not match anything else", () => {
    expect(etagMatches(null, etag)).toBe(false);
    expect(etagMatches('"abc"', etag)).toBe(false);
    expect(etagMatches("abc123", etag)).toBe(false);
  });
});
