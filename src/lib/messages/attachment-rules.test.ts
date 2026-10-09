import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_ACCEPT,
  FILE_TYPES,
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_REQUEST_BYTES,
  MAX_FILE_NAME_CHARS,
  attachmentPreviewText,
  attachmentUrl,
  fileExtension,
  fileTypeFor,
  fitWithin,
  fitWithinBox,
  formatBytes,
  hasImageExtension,
  parseAttachmentLabel,
  parseAttachmentView,
  sanitizeFileName,
  withExtension,
} from "@/lib/messages/attachment-rules";

// `new RegExp` rather than a literal: tsconfig declares no `target`, so a literal
// with property escapes is rejected when the tests are typechecked.
const INVISIBLE = new RegExp("[\\p{Cc}\\p{Cf}]", "u");

describe("limits", () => {
  it("fits a full-size upload under Vercel's 4.5 MB request cap", () => {
    // Anything larger is refused by the platform before the route runs.
    expect(MAX_ATTACHMENT_REQUEST_BYTES).toBeLessThan(4_500_000);
    expect(MAX_ATTACHMENT_REQUEST_BYTES).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
  });
});

describe("fileExtension", () => {
  it("reads a lowercase extension", () => {
    expect(fileExtension("Report.PDF")).toBe("pdf");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });

  it("returns null when there is no real extension", () => {
    expect(fileExtension("README")).toBeNull();
    expect(fileExtension(".bashrc")).toBeNull();
    expect(fileExtension("trailing.")).toBeNull();
    expect(fileExtension("weird.ext with space")).toBeNull();
    expect(fileExtension("a.waytoolongextension")).toBeNull();
  });
});

describe("sanitizeFileName", () => {
  it("keeps an ordinary name intact", () => {
    expect(sanitizeFileName("Holiday photo.jpg")).toBe("Holiday photo.jpg");
    expect(sanitizeFileName("రేపు సమావేశం.pdf")).toBe("రేపు సమావేశం.pdf");
  });

  it("drops directory components", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\secret.txt")).toBe("secret.txt");
  });

  it("removes the bidirectional override used to disguise extensions", () => {
    // "photo<RLO>gpj.exe" displays as "photoexe.jpg".
    const disguised = `photo${String.fromCharCode(0x202e)}gpj.exe`;
    const cleaned = sanitizeFileName(disguised);

    expect(cleaned).toBe("photogpj.exe");
    expect(fileExtension(cleaned)).toBe("exe");
  });

  it("strips control characters, so a name cannot break a header", () => {
    const cleaned = sanitizeFileName("a\r\nSet-Cookie: x.pdf");

    expect(cleaned).not.toMatch(/[\r\n]/);
    expect(cleaned.endsWith(".pdf")).toBe(true);
  });

  it("replaces characters reserved on Windows", () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
  });

  it("removes leading dots and trailing dots or spaces", () => {
    expect(sanitizeFileName("...hidden.txt")).toBe("hidden.txt");
    expect(sanitizeFileName("name.txt. . ")).toBe("name.txt");
  });

  it("falls back when nothing is left", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("...")).toBe("file");
    expect(sanitizeFileName("/")).toBe("file");
  });

  it("truncates long names but keeps the extension", () => {
    const cleaned = sanitizeFileName(`${"a".repeat(500)}.docx`);

    expect(Array.from(cleaned).length).toBeLessThanOrEqual(MAX_FILE_NAME_CHARS);
    expect(cleaned.endsWith(".docx")).toBe(true);
  });

  it("always yields a short, single-segment, visible name", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 400 }), (raw) => {
        const cleaned = sanitizeFileName(raw);

        return (
          cleaned.length > 0 &&
          Array.from(cleaned).length <= MAX_FILE_NAME_CHARS &&
          !cleaned.includes("/") &&
          !cleaned.includes("\\") &&
          !INVISIBLE.test(cleaned) &&
          !cleaned.startsWith(".")
        );
      }),
    );
  });
});

describe("withExtension", () => {
  it("replaces an image extension", () => {
    expect(withExtension("photo.jpg", "png")).toBe("photo.png");
    expect(withExtension("photo.JPEG", "webp")).toBe("photo.webp");
  });

  it("appends to a non-image extension rather than hiding it", () => {
    expect(withExtension("notes.txt", "png")).toBe("notes.txt.png");
  });

  it("adds one when there was none", () => {
    expect(withExtension("screenshot", "png")).toBe("screenshot.png");
  });
});

describe("fileTypeFor and hasImageExtension", () => {
  it("finds allowed documents", () => {
    expect(fileTypeFor("deck.PPTX")?.label).toBe("PowerPoint");
    expect(fileTypeFor("table.csv")?.mimeType).toBe("text/csv");
  });

  it("refuses everything not on the allowlist", () => {
    for (const name of ["run.exe", "page.html", "logo.svg", "script.js", "noext"]) {
      expect(fileTypeFor(name)).toBeNull();
    }
  });

  it("recognises image extensions", () => {
    expect(hasImageExtension("a.JPG")).toBe(true);
    expect(hasImageExtension("a.webp")).toBe(true);
    expect(hasImageExtension("a.heic")).toBe(false);
    expect(hasImageExtension("a.svg")).toBe(false);
  });

  it("never lists SVG or HTML as an allowed type", () => {
    // Both are documents that can run script on this origin.
    const extensions = FILE_TYPES.map((type) => type.extension);

    expect(extensions).not.toContain("svg");
    expect(extensions).not.toContain("html");
    expect(extensions).not.toContain("htm");
  });
});

describe("ATTACHMENT_ACCEPT", () => {
  it("offers every image type and document extension", () => {
    IMAGE_TYPES.forEach((type) => expect(ATTACHMENT_ACCEPT).toContain(type.mimeType));
    FILE_TYPES.filter((type) => type.extension !== "heic" && type.extension !== "heif").forEach(
      (type) => expect(ATTACHMENT_ACCEPT).toContain(`.${type.extension}`),
    );
  });

  it("leaves HEIC out, so iPhones convert photos to JPEG on pick", () => {
    // Asking for HEIC makes iOS hand over the original, which most browsers
    // cannot display inline.
    expect(ATTACHMENT_ACCEPT.split(",")).not.toContain(".heic");
    expect(ATTACHMENT_ACCEPT.split(",")).not.toContain(".heif");
  });
});

describe("formatBytes", () => {
  it("formats each order of magnitude", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatBytes(42 * 1024 * 1024)).toBe("42 MB");
  });

  it("tolerates nonsense", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("fitWithin", () => {
  it("leaves small images alone", () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it("scales the long side down and keeps the ratio", () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
  });

  it("never produces a zero dimension", () => {
    expect(fitWithin(1, 100_000, 2048).width).toBeGreaterThanOrEqual(1);
  });

  it("fits a rectangle", () => {
    expect(fitWithinBox(1000, 1000, 280, 320)).toEqual({ width: 280, height: 280 });
    expect(fitWithinBox(400, 1600, 280, 320)).toEqual({ width: 80, height: 320 });
  });

  it("falls back to the box for unusable dimensions", () => {
    expect(fitWithinBox(0, 0, 280, 320)).toEqual({ width: 280, height: 320 });
    expect(fitWithinBox(Number.NaN, 5, 280, 320)).toEqual({ width: 280, height: 320 });
  });
});

describe("attachmentPreviewText", () => {
  it("describes each kind", () => {
    expect(attachmentPreviewText({ kind: "image", fileName: "a.png" })).toBe("📷 Photo");
    expect(attachmentPreviewText({ kind: "file", fileName: "plan.pdf" })).toBe("📎 plan.pdf");
    expect(attachmentPreviewText(null)).toBe("📎 Attachment");
  });
});

describe("attachmentUrl", () => {
  it("encodes the id and can request a download", () => {
    expect(attachmentUrl("abc")).toBe("/api/direct-messages/attachments/abc");
    expect(attachmentUrl("a/b")).toBe("/api/direct-messages/attachments/a%2Fb");
    expect(attachmentUrl("abc", true)).toBe(
      "/api/direct-messages/attachments/abc?download=1",
    );
  });
});

describe("parseAttachmentView", () => {
  const valid = {
    id: "att1",
    kind: "image",
    fileName: "a.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    width: 800,
    height: 600,
  };

  it("accepts a well-formed view", () => {
    expect(parseAttachmentView(valid)).toEqual(valid);
  });

  it("nulls out implausible dimensions rather than rejecting", () => {
    const parsed = parseAttachmentView({ ...valid, width: -4, height: 1.5 });

    expect(parsed?.width).toBeNull();
    expect(parsed?.height).toBeNull();
  });

  it("rejects malformed views", () => {
    expect(parseAttachmentView(null)).toBeNull();
    expect(parseAttachmentView([])).toBeNull();
    expect(parseAttachmentView({ ...valid, id: "" })).toBeNull();
    expect(parseAttachmentView({ ...valid, kind: "video" })).toBeNull();
    expect(parseAttachmentView({ ...valid, sizeBytes: "big" })).toBeNull();
    expect(parseAttachmentView({ ...valid, sizeBytes: -1 })).toBeNull();
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        parseAttachmentView(value);
        parseAttachmentLabel(value);
        return true;
      }),
    );
  });
});

describe("parseAttachmentLabel", () => {
  it("accepts a label and rejects junk", () => {
    expect(parseAttachmentLabel({ kind: "file", fileName: "a.pdf" })).toEqual({
      kind: "file",
      fileName: "a.pdf",
    });
    expect(parseAttachmentLabel({ kind: "doc", fileName: "a.pdf" })).toBeNull();
    expect(parseAttachmentLabel({ kind: "file" })).toBeNull();
  });
});
