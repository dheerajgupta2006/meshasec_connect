import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DURATION_MINUTES,
  MAX_ICS_TIME_MS,
  MIN_ICS_TIME_MS,
  buildGoogleCalendarUrl,
  buildIcsCalendar,
  buildOutlookCalendarUrl,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  icsFilename,
  resolveEventWindow,
} from "@/lib/calendar/ics";

const START = new Date("2026-09-14T10:30:00.000Z");
const STAMP = new Date("2026-09-07T05:31:04.123Z");

/** Reverses RFC 5545 folding so a property can inspect logical lines. */
function unfold(document: string): string[] {
  return document.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
}

describe("formatIcsUtc", () => {
  it("emits the basic UTC form with no punctuation", () => {
    expect(formatIcsUtc(STAMP)).toBe("20260907T053104Z");
  });

  it("refuses an invalid date rather than emitting a broken stamp", () => {
    expect(() => formatIcsUtc(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("refuses a year outside the four-digit range the format allows", () => {
    // `toISOString` returns `+275760-09-13T00:00:00.000Z` here, which is not
    // valid iCalendar and used to be emitted as `+0100001T010000Z`.
    expect(() => formatIcsUtc(new Date(MAX_ICS_TIME_MS + 1000))).toThrow(
      RangeError,
    );
    expect(() => formatIcsUtc(new Date(MIN_ICS_TIME_MS - 1000))).toThrow(
      RangeError,
    );
  });

  it("always produces the same 16-character shape inside the supported range", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date(MIN_ICS_TIME_MS),
          max: new Date(MAX_ICS_TIME_MS),
          noInvalidDate: true,
        }),
        (value) => {
          expect(formatIcsUtc(value)).toMatch(/^\d{8}T\d{6}Z$/);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("escapeIcsText", () => {
  it("escapes the four characters RFC 5545 reserves in TEXT", () => {
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });

  it("doubles the backslash before anything else, so escapes are not re-escaped", () => {
    // Naive ordering turns this into `\\;` (an escaped backslash followed by a
    // bare semicolon), which truncates the property value in most parsers.
    expect(escapeIcsText("\\;")).toBe("\\\\\\;");
  });

  it("normalises every newline form to the literal \\n sequence", () => {
    for (const input of ["a\nb", "a\r\nb", "a\rb"]) {
      expect(escapeIcsText(input)).toBe("a\\nb");
    }
  });

  it("never leaves a raw CR or LF that would break the line structure", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const escaped = escapeIcsText(value);
        expect(escaped).not.toMatch(/[\r\n]/);
      }),
      { numRuns: 400 },
    );
  });
});

describe("foldIcsLine", () => {
  it("leaves a short line untouched", () => {
    expect(foldIcsLine("SUMMARY:Standup")).toBe("SUMMARY:Standup");
  });

  it("folds a long line with a leading space on each continuation", () => {
    const folded = foldIcsLine(`SUMMARY:${"x".repeat(200)}`);
    const segments = folded.split("\r\n");

    expect(segments.length).toBeGreaterThan(1);
    segments.slice(1).forEach((segment) => {
      expect(segment.startsWith(" ")).toBe(true);
    });
  });

  it("keeps every segment inside the 75-octet limit", () => {
    const encoder = new TextEncoder();

    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (value) => {
        const folded = foldIcsLine(`DESCRIPTION:${value}`);

        folded.split("\r\n").forEach((segment) => {
          expect(encoder.encode(segment).length).toBeLessThanOrEqual(75);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips: unfolding restores the original line exactly", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (value) => {
        const line = `DESCRIPTION:${escapeIcsText(value)}`;
        const restored = foldIcsLine(line).replace(/\r\n /g, "");
        expect(restored).toBe(line);
      }),
      { numRuns: 300 },
    );
  });

  it("never splits a multi-byte character across a fold", () => {
    // Four-octet emoji: a naive byte-slice would cut a surrogate pair and emit a
    // replacement character on unfold.
    const line = `DESCRIPTION:${"😀".repeat(60)}`;
    const restored = foldIcsLine(line).replace(/\r\n /g, "");

    expect(restored).toBe(line);
    expect(restored).not.toContain("\uFFFD");
  });
});

describe("resolveEventWindow", () => {
  it("applies the default duration when there is no end time", () => {
    const { start, end } = resolveEventWindow(START, null);

    expect(start.toISOString()).toBe(START.toISOString());
    expect(end.getTime() - start.getTime()).toBe(
      DEFAULT_DURATION_MINUTES * 60_000,
    );
  });

  it("replaces an end that is not after the start", () => {
    for (const end of [START, new Date(START.getTime() - 60_000)]) {
      const window = resolveEventWindow(START, end);
      expect(window.end.getTime()).toBeGreaterThan(window.start.getTime());
    }
  });

  it("clamps an extreme start so the fallback end cannot overflow to NaN", () => {
    // `new Date(maxTime).getTime() + 60min` is Invalid Date, which used to make
    // the whole window unformattable.
    const { start, end } = resolveEventWindow(new Date(8.64e15), null);

    expect(Number.isNaN(start.getTime())).toBe(false);
    expect(Number.isNaN(end.getTime())).toBe(false);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    expect(end.getTime()).toBeLessThanOrEqual(MAX_ICS_TIME_MS);
  });

  it("always yields a valid, in-range, strictly positive interval", () => {
    fc.assert(
      fc.property(
        // Deliberately unbounded, including years past 9999: the function is
        // responsible for clamping, not the caller.
        fc.date({ noInvalidDate: true }),
        fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
        (start, end) => {
          const window = resolveEventWindow(start, end);

          expect(Number.isNaN(window.start.getTime())).toBe(false);
          expect(Number.isNaN(window.end.getTime())).toBe(false);
          expect(window.end.getTime()).toBeGreaterThan(window.start.getTime());
          expect(window.start.getTime()).toBeGreaterThanOrEqual(MIN_ICS_TIME_MS);
          expect(window.end.getTime()).toBeLessThanOrEqual(MAX_ICS_TIME_MS);

          // The real contract: whatever comes out is formattable.
          expect(() => formatIcsUtc(window.start)).not.toThrow();
          expect(() => formatIcsUtc(window.end)).not.toThrow();
        },
      ),
      { numRuns: 400 },
    );
  });

  it("does not mutate the dates it was given", () => {
    const start = new Date(START.getTime());
    const end = new Date(START.getTime() + 5 * 60_000);

    resolveEventWindow(start, end);

    expect(start.toISOString()).toBe(START.toISOString());
    expect(end.toISOString()).toBe(
      new Date(START.getTime() + 5 * 60_000).toISOString(),
    );
  });
});

describe("buildIcsCalendar", () => {
  const base = {
    uid: "meeting-abc@meshasec",
    title: "Design review",
    description: "Meshasec Connext meeting. Code: ABC",
    url: "https://connext.example.com/meeting/ABC/lobby",
    startsAt: START,
    endsAt: new Date("2026-09-14T11:15:00.000Z"),
    stamp: STAMP,
  };

  it("emits a well-formed single-event calendar", () => {
    const lines = unfold(buildIcsCalendar(base));

    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("END:VEVENT");
    expect(lines).toContain("UID:meeting-abc@meshasec");
    expect(lines).toContain("DTSTART:20260914T103000Z");
    expect(lines).toContain("DTEND:20260914T111500Z");
    expect(lines).toContain("DTSTAMP:20260907T053104Z");
    expect(lines).toContain("SUMMARY:Design review");
  });

  it("terminates with CRLF, which parsers require", () => {
    expect(buildIcsCalendar(base).endsWith("\r\n")).toBe(true);
  });

  it("uses CRLF throughout and never a bare LF", () => {
    const document = buildIcsCalendar(base);
    expect(document).not.toMatch(/(?<!\r)\n/);
  });

  it("keeps the URL property unescaped so the join link stays clickable", () => {
    const lines = unfold(
      buildIcsCalendar({
        ...base,
        url: "https://connext.example.com/meeting/ABC/lobby?a=1,2",
      }),
    );

    // TEXT escaping would turn the comma into `\,` and break the link.
    expect(lines).toContain(
      "URL:https://connext.example.com/meeting/ABC/lobby?a=1,2",
    );
  });

  it("omits ORGANIZER when the host has no email on file", () => {
    const withoutEmail = unfold(
      buildIcsCalendar({ ...base, organizerEmail: null }),
    );
    expect(withoutEmail.some((line) => line.startsWith("ORGANIZER"))).toBe(
      false,
    );

    const withEmail = unfold(
      buildIcsCalendar({
        ...base,
        organizerName: "Ada Lovelace",
        organizerEmail: "ada@example.com",
      }),
    );
    expect(withEmail).toContain(
      "ORGANIZER;CN=Ada Lovelace:mailto:ada@example.com",
    );
  });

  it("survives a hostile title without breaking out of its property", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (title) => {
        const document = buildIcsCalendar({ ...base, title });
        const lines = unfold(document);

        // Exactly one event, and the structure is intact: an unescaped newline in
        // the title would inject extra lines or a second VEVENT.
        expect(
          lines.filter((line) => line === "BEGIN:VEVENT"),
        ).toHaveLength(1);
        expect(lines.filter((line) => line === "END:VEVENT")).toHaveLength(1);
        expect(lines.at(-1)).toBe("END:VCALENDAR");
        expect(
          lines.filter((line) => line.startsWith("SUMMARY:")),
        ).toHaveLength(1);
      }),
      { numRuns: 300 },
    );
  });

  it("cannot be made to inject a property via a newline in the title", () => {
    const lines = unfold(
      buildIcsCalendar({
        ...base,
        title: "Real\r\nDTSTART:19700101T000000Z\r\nSUMMARY:Fake",
      }),
    );

    expect(lines.filter((line) => line.startsWith("DTSTART:"))).toHaveLength(1);
    expect(lines).toContain("DTSTART:20260914T103000Z");
  });
});

describe("calendar deep links", () => {
  const input = {
    title: "Design review",
    description: "Meshasec Connext meeting. Code: ABC",
    url: "https://connext.example.com/meeting/ABC/lobby",
    startsAt: START,
    endsAt: new Date("2026-09-14T11:15:00.000Z"),
  };

  it("builds a Google link with a compact UTC range", () => {
    const url = new URL(buildGoogleCalendarUrl(input));

    expect(url.origin + url.pathname).toBe(
      "https://calendar.google.com/calendar/render",
    );
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe(
      "20260914T103000Z/20260914T111500Z",
    );
    expect(url.searchParams.get("text")).toBe("Design review");
  });

  it("builds an Outlook link with ISO timestamps", () => {
    const url = new URL(buildOutlookCalendarUrl(input));

    expect(url.searchParams.get("rru")).toBe("addevent");
    expect(url.searchParams.get("startdt")).toBe("2026-09-14T10:30:00.000Z");
    expect(url.searchParams.get("enddt")).toBe("2026-09-14T11:15:00.000Z");
  });

  it("produces parseable URLs for arbitrary titles", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (title) => {
        for (const build of [buildGoogleCalendarUrl, buildOutlookCalendarUrl]) {
          const raw = build({ ...input, title });
          expect(() => new URL(raw)).not.toThrow();
          expect(new URL(raw).protocol).toBe("https:");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("round-trips the title through query encoding", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (title) => {
        const google = new URL(buildGoogleCalendarUrl({ ...input, title }));
        expect(google.searchParams.get("text")).toBe(title);

        const outlook = new URL(buildOutlookCalendarUrl({ ...input, title }));
        expect(outlook.searchParams.get("subject")).toBe(title);
      }),
      { numRuns: 300 },
    );
  });
});

describe("icsFilename", () => {
  it("slugifies the title and appends the code", () => {
    expect(icsFilename("Design Review!", "ABC123")).toBe(
      "design-review-ABC123.ics",
    );
  });

  it("falls back when the title has no usable characters", () => {
    expect(icsFilename("!!!", "ABC123")).toBe("meeting-ABC123.ics");
  });

  it("never emits a character that could break the header", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (title) => {
        const name = icsFilename(title, "ABC123");
        // A quote, newline or semicolon here would let the title escape the
        // Content-Disposition value.
        expect(name).toMatch(/^[a-zA-Z0-9._-]+$/);
        expect(name.endsWith(".ics")).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});
