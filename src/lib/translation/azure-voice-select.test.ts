import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildSsml,
  escapeSsml,
  parseAzureVoice,
  parseAzureVoices,
  selectAzureVoice,
  speakableLocales,
  type AzureVoice,
} from "@/lib/translation/azure-voice-select";

function voice(
  Locale: string,
  ShortName: string,
  VoiceType = "Neural",
  Gender = "Female",
): AzureVoice {
  return { Locale, ShortName, VoiceType, Gender };
}

describe("parseAzureVoice", () => {
  it("accepts a well-formed entry", () => {
    const parsed = parseAzureVoice({
      Locale: "te-IN",
      ShortName: "te-IN-MohanNeural",
      VoiceType: "Neural",
      Gender: "Male",
    });

    expect(parsed?.ShortName).toBe("te-IN-MohanNeural");
  });

  it("rejects entries missing the fields synthesis needs", () => {
    expect(parseAzureVoice(null)).toBeNull();
    expect(parseAzureVoice("te-IN")).toBeNull();
    expect(parseAzureVoice({})).toBeNull();
    expect(parseAzureVoice({ Locale: "te-IN" })).toBeNull();
    expect(parseAzureVoice({ ShortName: "x" })).toBeNull();
    expect(parseAzureVoice({ Locale: "", ShortName: "x" })).toBeNull();
    expect(parseAzureVoice({ Locale: "te-IN", ShortName: "" })).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const parsed = parseAzureVoice({
      Locale: "te-IN",
      ShortName: "te-IN-MohanNeural",
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.VoiceType).toBe("");
  });
});

describe("parseAzureVoices", () => {
  it("drops unparseable entries but keeps the rest", () => {
    // A shape change should cost one language, not break synthesis entirely.
    const voices = parseAzureVoices([
      { Locale: "te-IN", ShortName: "te-IN-MohanNeural" },
      { Locale: "broken" },
      "nonsense",
      null,
      { Locale: "ta-IN", ShortName: "ta-IN-PallaviNeural" },
    ]);

    expect(voices).toHaveLength(2);
  });

  it("returns empty for a non-array payload", () => {
    expect(parseAzureVoices(null)).toEqual([]);
    expect(parseAzureVoices({ voices: [] })).toEqual([]);
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        parseAzureVoices(value);
        return true;
      }),
    );
  });
});

describe("selectAzureVoice", () => {
  it("finds a voice for an exact locale", () => {
    const chosen = selectAzureVoice(
      [voice("te-IN", "te-IN-MohanNeural"), voice("en-US", "en-US-JennyNeural")],
      "te-IN",
    );

    expect(chosen?.ShortName).toBe("te-IN-MohanNeural");
  });

  it("falls back to another region of the same language", () => {
    // A Sri Lankan Tamil voice is far better than no Tamil at all.
    const chosen = selectAzureVoice([voice("ta-LK", "ta-LK-KumarNeural")], "ta-IN");

    expect(chosen?.ShortName).toBe("ta-LK-KumarNeural");
  });

  it("prefers the exact region when both exist", () => {
    const chosen = selectAzureVoice(
      [voice("ta-LK", "ta-LK-KumarNeural"), voice("ta-IN", "ta-IN-PallaviNeural")],
      "ta-IN",
    );

    expect(chosen?.ShortName).toBe("ta-IN-PallaviNeural");
  });

  it("prefers a neural voice over an older generation", () => {
    const chosen = selectAzureVoice(
      [
        voice("te-IN", "te-IN-Chitra", "Standard"),
        voice("te-IN", "te-IN-MohanNeural", "Neural"),
      ],
      "te-IN",
    );

    expect(chosen?.ShortName).toBe("te-IN-MohanNeural");
  });

  it("still returns something when no neural voice exists", () => {
    const chosen = selectAzureVoice(
      [voice("te-IN", "te-IN-Chitra", "Standard")],
      "te-IN",
    );

    expect(chosen?.ShortName).toBe("te-IN-Chitra");
  });

  it("is deterministic regardless of response order", () => {
    // A voice that changes between deployments would invalidate every cached
    // audio clip for that language.
    const options = [
      voice("te-IN", "te-IN-ShrutiNeural"),
      voice("te-IN", "te-IN-MohanNeural"),
    ];

    const forwards = selectAzureVoice(options, "te-IN");
    const backwards = selectAzureVoice(options.slice().reverse(), "te-IN");

    expect(forwards?.ShortName).toBe(backwards?.ShortName);
  });

  it("returns null when the language is absent", () => {
    expect(selectAzureVoice([voice("en-US", "en-US-JennyNeural")], "te-IN")).toBeNull();
    expect(selectAzureVoice([], "te-IN")).toBeNull();
  });

  it("ignores case in locale tags", () => {
    expect(selectAzureVoice([voice("TE-in", "x")], "te-IN")).not.toBeNull();
  });
});

describe("speakableLocales", () => {
  it("keeps only the locales Azure covers", () => {
    const voices = [
      voice("te-IN", "te-IN-MohanNeural"),
      voice("hi-IN", "hi-IN-SwaraNeural"),
    ];

    expect(speakableLocales(voices, ["te-IN", "hi-IN", "kn-IN"])).toEqual([
      "te-IN",
      "hi-IN",
    ]);
  });

  it("returns nothing when the voice list is empty", () => {
    expect(speakableLocales([], ["te-IN"])).toEqual([]);
  });
});

describe("escapeSsml", () => {
  it("escapes the characters that would break the document", () => {
    // Not defensive: captions are a live transcript, so an ampersand in ordinary
    // speech would otherwise make Azure reject the whole request.
    expect(escapeSsml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeSsml("a < b")).toBe("a &lt; b");
    expect(escapeSsml("a > b")).toBe("a &gt; b");
    expect(escapeSsml('say "hi"')).toBe("say &quot;hi&quot;");
    expect(escapeSsml("it's")).toBe("it&apos;s");
  });

  it("escapes the ampersand before the entities it introduces", () => {
    // Escaping in the wrong order yields `&amp;lt;` for a literal `<`.
    expect(escapeSsml("<")).toBe("&lt;");
    expect(escapeSsml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves non-Latin text untouched", () => {
    expect(escapeSsml("రేపు కలుద్దాం")).toBe("రేపు కలుద్దాం");
  });

  it("never emits a raw angle bracket or bare ampersand", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const escaped = escapeSsml(text);

        return (
          !escaped.includes("<") &&
          !escaped.includes(">") &&
          // Every surviving ampersand must begin one of the five entities.
          escaped
            .split("&")
            .slice(1)
            .every((part) =>
              ["amp;", "lt;", "gt;", "quot;", "apos;"].some((entity) =>
                part.startsWith(entity),
              ),
            )
        );
      }),
    );
  });
});

describe("buildSsml", () => {
  it("names the voice and locale Azure expects", () => {
    const ssml = buildSsml("hello", voice("te-IN", "te-IN-MohanNeural"), "5%");

    expect(ssml).toContain('xml:lang="te-IN"');
    expect(ssml).toContain('name="te-IN-MohanNeural"');
    expect(ssml).toContain('rate="5%"');
    expect(ssml).toContain("hello");
  });

  it("escapes the spoken text", () => {
    const ssml = buildSsml("a & b", voice("en-US", "en-US-JennyNeural"), "0%");

    expect(ssml).toContain("a &amp; b");
    expect(ssml).not.toContain("a & b");
  });
});
