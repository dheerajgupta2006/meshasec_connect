import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  extractUrls,
  normalizeUrl,
  previewTarget,
  tokenizeBody,
} from "@/lib/messages/links";

describe("normalizeUrl", () => {
  it("keeps an ordinary http(s) URL", () => {
    expect(normalizeUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("drops the fragment, which never reaches the server", () => {
    expect(normalizeUrl("https://example.com/a#section")).toBe(
      "https://example.com/a",
    );
  });

  it("rejects non-web schemes", () => {
    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://example.com",
      "mailto:a@b.com",
    ]) {
      expect(normalizeUrl(raw)).toBeNull();
    }
  });

  it("rejects a value that cannot be parsed as a URL at all", () => {
    for (const raw of ["", "   ", "https://", "http://["]) {
      expect(normalizeUrl(raw)).toBeNull();
    }
  });

  it("leaves host policy to the SSRF layer", () => {
    // `http:///path` is normalised by the URL parser into `http://path/`, so
    // `path` becomes a single-label hostname rather than an empty one. This
    // function only decides "is it a parseable http(s) URL"; refusing internal
    // hosts is `classifyPreviewUrl`'s job, and it rejects single-label hosts.
    expect(normalizeUrl("http:///path")).toBe("http://path/");
    expect(normalizeUrl("http://localhost:3000/x")).toBe(
      "http://localhost:3000/x",
    );
  });

  it("rejects an absurdly long URL", () => {
    expect(normalizeUrl(`https://example.com/${"a".repeat(5000)}`)).toBeNull();
  });

  it("never throws and only ever returns an http(s) URL or null", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normalizeUrl(raw);

        if (result !== null) {
          expect(result).toMatch(/^https?:\/\//);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("extractUrls", () => {
  it("finds a bare URL", () => {
    expect(extractUrls("look at https://example.com/a now")).toEqual([
      "https://example.com/a",
    ]);
  });

  it("does not swallow trailing sentence punctuation", () => {
    expect(extractUrls("see https://example.com.")).toEqual([
      "https://example.com/",
    ]);
    expect(extractUrls("see https://example.com/a, then")).toEqual([
      "https://example.com/a",
    ]);
    expect(extractUrls("really? https://example.com/a!")).toEqual([
      "https://example.com/a",
    ]);
  });

  it("keeps balanced parentheses that belong to the URL", () => {
    // Wikipedia-style URLs genuinely contain parens.
    expect(
      extractUrls("see https://en.wikipedia.org/wiki/Foo_(bar) ok"),
    ).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });

  it("drops an unbalanced closing paren", () => {
    expect(extractUrls("(see https://example.com/a)")).toEqual([
      "https://example.com/a",
    ]);
  });

  it("deduplicates while preserving order", () => {
    expect(
      extractUrls("https://b.com https://a.com https://b.com"),
    ).toEqual(["https://b.com/", "https://a.com/"]);
  });

  it("ignores bare hostnames and version numbers", () => {
    // Matching these would turn ordinary prose into outbound fetches.
    expect(extractUrls("upgrade to v2.0 on example.com today")).toEqual([]);
    expect(extractUrls("e.g. see the docs")).toEqual([]);
  });

  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        expect(() => extractUrls(body)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it("returns only normalized URLs", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        extractUrls(body).forEach((url) => {
          expect(normalizeUrl(url)).toBe(url);
        });
      }),
      { numRuns: 500 },
    );
  });
});

describe("previewTarget", () => {
  it("returns the first URL, or null", () => {
    expect(previewTarget("a https://one.com b https://two.com")).toBe(
      "https://one.com/",
    );
    expect(previewTarget("no links here")).toBeNull();
  });

  it("agrees with extractUrls", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        expect(previewTarget(body)).toBe(extractUrls(body)[0] ?? null);
      }),
      { numRuns: 500 },
    );
  });
});

describe("tokenizeBody", () => {
  it("splits text and links in order", () => {
    expect(tokenizeBody("hi https://example.com bye")).toEqual([
      { kind: "text", value: "hi " },
      {
        kind: "link",
        href: "https://example.com/",
        label: "https://example.com",
      },
      { kind: "text", value: " bye" },
    ]);
  });

  it("returns a single text token when there is no link", () => {
    expect(tokenizeBody("just words")).toEqual([
      { kind: "text", value: "just words" },
    ]);
  });

  it("handles an empty body", () => {
    expect(tokenizeBody("")).toEqual([]);
  });

  it("loses no characters: concatenating every token restores the input", () => {
    // This is the invariant that stops the renderer silently dropping or
    // duplicating text around a link.
    fc.assert(
      fc.property(fc.string(), (body) => {
        const rebuilt = tokenizeBody(body)
          .map((token) => (token.kind === "text" ? token.value : token.label))
          .join("");

        expect(rebuilt).toBe(body);
      }),
      { numRuns: 1000 },
    );
  });

  it("loses no characters for bodies that are mostly URLs", () => {
    const urlish = fc
      .array(
        fc.oneof(
          fc.constant("https://example.com/a"),
          fc.constant("http://a.b/c?d=1&e=2"),
          fc.constant("https://en.wikipedia.org/wiki/X_(y)"),
          fc.string({ maxLength: 12 }),
        ),
        { maxLength: 12 },
      )
      .map((parts) => parts.join(" "));

    fc.assert(
      fc.property(urlish, (body) => {
        const rebuilt = tokenizeBody(body)
          .map((token) => (token.kind === "text" ? token.value : token.label))
          .join("");

        expect(rebuilt).toBe(body);
      }),
      { numRuns: 500 },
    );
  });

  it("emits only normalized hrefs", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        tokenizeBody(body).forEach((token) => {
          if (token.kind === "link") {
            expect(token.href).toMatch(/^https?:\/\//);
            expect(normalizeUrl(token.href)).toBe(token.href);
          }
        });
      }),
      { numRuns: 500 },
    );
  });

  it("never emits an empty text token", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        tokenizeBody(body).forEach((token) => {
          if (token.kind === "text") {
            expect(token.value.length).toBeGreaterThan(0);
          }
        });
      }),
      { numRuns: 500 },
    );
  });
});
