import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BACKGROUND_PRESETS,
  MAX_STORED_BACKGROUND_CHARS,
  NO_BACKGROUND,
  describeBackgroundEffect,
  isUsableBackgroundUrl,
  parseBackgroundEffect,
  sameBackgroundEffect,
  type BackgroundEffect,
} from "@/lib/meetings/backgrounds";

const VALID_URL = "data:image/jpeg;base64,AAAABBBBCCCC=";

describe("BACKGROUND_PRESETS", () => {
  it("has unique ids", () => {
    const ids = BACKGROUND_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never uses the reserved custom id", () => {
    // "custom" identifies an uploaded image, so a preset claiming it would make
    // the two indistinguishable.
    expect(BACKGROUND_PRESETS.some((preset) => preset.id === "custom")).toBe(
      false,
    );
  });

  it("declares three colour stops per preset", () => {
    BACKGROUND_PRESETS.forEach((preset) => {
      expect(preset.stops).toHaveLength(3);
      preset.stops.forEach((stop) => {
        expect(stop).toMatch(/^#[0-9a-f]{6}$/i);
      });
    });
  });
});

describe("isUsableBackgroundUrl", () => {
  it("accepts a base64 data URL for a supported type", () => {
    for (const type of ["jpeg", "png", "webp"]) {
      expect(isUsableBackgroundUrl(`data:image/${type};base64,AAAA`)).toBe(true);
    }
  });

  it("rejects anything that is not an image data URL", () => {
    for (const value of [
      "",
      "https://example.com/a.jpg",
      "data:text/html;base64,AAAA",
      "data:image/svg+xml;base64,AAAA",
      "javascript:alert(1)",
      "data:image/jpeg,notbase64",
    ]) {
      expect(isUsableBackgroundUrl(value)).toBe(false);
    }
  });

  it("rejects SVG, which can carry script", () => {
    expect(isUsableBackgroundUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(
      false,
    );
  });
});

describe("parseBackgroundEffect", () => {
  it("reads a blur effect", () => {
    expect(parseBackgroundEffect({ kind: "blur" })).toEqual({ kind: "blur" });
  });

  it("reads a valid image effect", () => {
    expect(
      parseBackgroundEffect({ kind: "image", id: "studio", url: VALID_URL }),
    ).toEqual({ kind: "image", id: "studio", url: VALID_URL });
  });

  it("falls back to none for an unrecognised value", () => {
    for (const value of [
      null,
      undefined,
      "blur",
      42,
      [],
      {},
      { kind: "sparkle" },
      { kind: "image" },
      { kind: "image", id: "x" },
      { kind: "image", url: VALID_URL },
    ]) {
      expect(parseBackgroundEffect(value)).toEqual(NO_BACKGROUND);
    }
  });

  it("refuses an image URL that is not a safe data URL", () => {
    // The value comes out of sessionStorage, which the user can edit, and ends up
    // on a canvas.
    for (const url of [
      "https://evil.example/x.jpg",
      "javascript:alert(1)",
      "data:text/html;base64,AAAA",
      "data:image/svg+xml;base64,AAAA",
    ]) {
      expect(
        parseBackgroundEffect({ kind: "image", id: "custom", url }),
      ).toEqual(NO_BACKGROUND);
    }
  });

  it("refuses an oversized stored URL", () => {
    const huge = `data:image/jpeg;base64,${"A".repeat(
      MAX_STORED_BACKGROUND_CHARS,
    )}`;

    expect(
      parseBackgroundEffect({ kind: "image", id: "custom", url: huge }),
    ).toEqual(NO_BACKGROUND);
  });

  it("never throws, and always returns a known kind", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const effect = parseBackgroundEffect(value);
        expect(["none", "blur", "image"]).toContain(effect.kind);
      }),
      { numRuns: 1000 },
    );
  });

  it("is idempotent on its own output", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const once = parseBackgroundEffect(value);
        expect(parseBackgroundEffect(once)).toEqual(once);
      }),
      { numRuns: 500 },
    );
  });
});

describe("sameBackgroundEffect", () => {
  it("matches identical effects", () => {
    expect(sameBackgroundEffect(NO_BACKGROUND, { kind: "none" })).toBe(true);
    expect(sameBackgroundEffect({ kind: "blur" }, { kind: "blur" })).toBe(true);
    expect(
      sameBackgroundEffect(
        { kind: "image", id: "studio", url: VALID_URL },
        { kind: "image", id: "studio", url: VALID_URL },
      ),
    ).toBe(true);
  });

  it("distinguishes different kinds and different images", () => {
    expect(sameBackgroundEffect(NO_BACKGROUND, { kind: "blur" })).toBe(false);
    expect(
      sameBackgroundEffect(
        { kind: "image", id: "studio", url: VALID_URL },
        { kind: "image", id: "nature", url: VALID_URL },
      ),
    ).toBe(false);
    expect(
      sameBackgroundEffect(
        { kind: "image", id: "custom", url: VALID_URL },
        { kind: "image", id: "custom", url: `${VALID_URL}X` },
      ),
    ).toBe(false);
  });

  it("is reflexive and symmetric", () => {
    const effects: BackgroundEffect[] = [
      NO_BACKGROUND,
      { kind: "blur" },
      { kind: "image", id: "studio", url: VALID_URL },
      { kind: "image", id: "custom", url: `${VALID_URL}X` },
    ];

    effects.forEach((first) => {
      expect(sameBackgroundEffect(first, first)).toBe(true);

      effects.forEach((second) => {
        expect(sameBackgroundEffect(first, second)).toBe(
          sameBackgroundEffect(second, first),
        );
      });
    });
  });
});

describe("describeBackgroundEffect", () => {
  it("names each kind", () => {
    expect(describeBackgroundEffect(NO_BACKGROUND)).toContain("No background");
    expect(describeBackgroundEffect({ kind: "blur" })).toContain("blur");
  });

  it("uses the preset label when the id is known", () => {
    const preset = BACKGROUND_PRESETS[0];
    expect(preset).toBeDefined();

    if (preset !== undefined) {
      expect(
        describeBackgroundEffect({
          kind: "image",
          id: preset.id,
          url: VALID_URL,
        }),
      ).toContain(preset.label);
    }
  });

  it("calls an unknown id a custom background", () => {
    expect(
      describeBackgroundEffect({ kind: "image", id: "custom", url: VALID_URL }),
    ).toBe("Custom background");
  });

  it("always returns a non-empty string", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const described = describeBackgroundEffect(parseBackgroundEffect(value));
        expect(described.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });
});
