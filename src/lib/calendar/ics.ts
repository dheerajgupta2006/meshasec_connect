/**
 * iCalendar (RFC 5545) generation and "add to calendar" deep links.
 *
 * Pure and isomorphic on purpose: the same builder serves the `.ics` download
 * route on the server and can be exercised directly by the test suite. Nothing
 * here touches Prisma, Clerk or the network.
 */

/** Product identifier written into every calendar we emit. */
const PROD_ID = "-//Meshasec//Connext//EN";

/** RFC 5545 caps a content line at 75 octets before folding. */
const MAX_LINE_OCTETS = 75;

/** Applied when a meeting has no explicit end, so the event is not zero-length. */
export const DEFAULT_DURATION_MINUTES = 60;

const MINUTE_MS = 60_000;

/**
 * Representable range for an iCalendar timestamp.
 *
 * The format is a fixed four-digit year. JavaScript's `Date` reaches year 275760
 * and `toISOString` switches to an expanded, sign-prefixed form for anything
 * outside 0000-9999 — which no calendar client can parse. Clamping to this range
 * keeps every emitted stamp well-formed.
 */
export const MIN_ICS_TIME_MS = Date.UTC(1970, 0, 1, 0, 0, 0);
export const MAX_ICS_TIME_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

export interface CalendarEventInput {
  /** Globally unique, stable across regenerations of the same meeting. */
  uid: string;
  title: string;
  description: string;
  /** Join URL. Also appended to the description for clients that ignore URL. */
  url: string;
  startsAt: Date;
  /** Null falls back to `DEFAULT_DURATION_MINUTES` after `startsAt`. */
  endsAt: Date | null;
  organizerName?: string | null;
  organizerEmail?: string | null;
  /** Injectable so a test can assert an exact DTSTAMP. Defaults to now. */
  stamp?: Date;
}

function isUsableDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

const DEFAULT_DURATION_MS = DEFAULT_DURATION_MINUTES * MINUTE_MS;

/** Forces a timestamp into the range the format can represent. */
function clampTime(ms: number): number {
  if (Number.isNaN(ms)) {
    return MIN_ICS_TIME_MS;
  }

  return Math.min(Math.max(ms, MIN_ICS_TIME_MS), MAX_ICS_TIME_MS);
}

/**
 * Resolves the event window.
 *
 * Guarantees a valid, in-range, strictly positive interval. Three cases would
 * otherwise produce a calendar no client can parse:
 * - a missing end, which needs the default duration;
 * - an end at or before the start, which is a non-positive duration;
 * - a start so late that adding the default duration overflows `Date` to
 *   `Invalid Date`, which is why the start is clamped with headroom for it.
 */
export function resolveEventWindow(
  startsAt: Date,
  endsAt: Date | null,
): { start: Date; end: Date } {
  // Headroom so the fallback end can never exceed the representable maximum.
  const startMs = Math.min(
    clampTime(startsAt.getTime()),
    MAX_ICS_TIME_MS - DEFAULT_DURATION_MS,
  );
  const start = new Date(startMs);
  const fallbackEnd = new Date(startMs + DEFAULT_DURATION_MS);

  if (endsAt === null || !isUsableDate(endsAt)) {
    return { start, end: fallbackEnd };
  }

  const endMs = clampTime(endsAt.getTime());

  return endMs > startMs ? { start, end: new Date(endMs) } : { start, end: fallbackEnd };
}

/** Formats as a UTC timestamp in the basic form RFC 5545 requires. */
export function formatIcsUtc(value: Date): string {
  if (!isUsableDate(value)) {
    throw new RangeError("Cannot format an invalid date as an iCalendar stamp");
  }

  const ms = value.getTime();

  // Outside this range `toISOString` returns an expanded, sign-prefixed year
  // (`+275760-09-13T...`) which is not valid iCalendar. Callers reach this only
  // by bypassing `resolveEventWindow`, so failing loudly is the right outcome.
  if (ms < MIN_ICS_TIME_MS || ms > MAX_ICS_TIME_MS) {
    throw new RangeError(
      "Date is outside the range an iCalendar timestamp can represent",
    );
  }

  const iso = value.toISOString();
  // 2026-09-07T05:31:04.123Z -> 20260907T053104Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/**
 * Escapes a TEXT value.
 *
 * Order matters: the backslash must be doubled first, otherwise the backslashes
 * introduced by the later replacements would themselves be escaped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

function octetLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Folds one content line to the 75-octet limit.
 *
 * Measured in octets rather than characters because the limit is defined that
 * way and a single emoji is four octets. Splitting is done by code point so a
 * surrogate pair is never cut in half, which would corrupt the character.
 */
export function foldIcsLine(line: string): string {
  if (octetLength(line) <= MAX_LINE_OCTETS) {
    return line;
  }

  const pieces: string[] = [];
  let current = "";
  // Continuation lines begin with a space, which itself consumes an octet.
  let budget = MAX_LINE_OCTETS;

  for (const char of line) {
    const size = octetLength(char);

    if (octetLength(current) + size > budget) {
      pieces.push(current);
      current = char;
      budget = MAX_LINE_OCTETS - 1;
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    pieces.push(current);
  }

  return pieces
    .map((piece, index) => (index === 0 ? piece : ` ${piece}`))
    .join("\r\n");
}

/** Builds a single-event VCALENDAR document. */
export function buildIcsCalendar(input: CalendarEventInput): string {
  const { start, end } = resolveEventWindow(input.startsAt, input.endsAt);
  const stamp = input.stamp ?? new Date();

  const descriptionWithUrl =
    input.url.length === 0
      ? input.description
      : `${input.description}\n\nJoin: ${input.url}`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PROD_ID}`,
    "CALSCALE:GREGORIAN",
    // REQUEST would make clients treat this as an invitation needing an RSVP.
    // A download is a subscription to our copy of the event, so PUBLISH.
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(input.uid)}`,
    `DTSTAMP:${formatIcsUtc(stamp)}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
    `DESCRIPTION:${escapeIcsText(descriptionWithUrl)}`,
  ];

  if (input.url.length > 0) {
    // URL is not a TEXT property, so commas and semicolons inside it must not be
    // escaped; it is emitted verbatim.
    lines.push(`URL:${input.url}`);
    lines.push(`LOCATION:${escapeIcsText(input.url)}`);
  }

  const organizerEmail = input.organizerEmail ?? null;

  if (organizerEmail !== null && organizerEmail.length > 0) {
    const name = input.organizerName ?? null;
    const cnPart =
      name === null || name.length === 0
        ? ""
        : `;CN=${escapeIcsText(name)}`;
    lines.push(`ORGANIZER${cnPart}:mailto:${organizerEmail}`);
  }

  lines.push("STATUS:CONFIRMED");
  lines.push("TRANSP:OPAQUE");
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  // CRLF is mandatory, and the document must end with one.
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/** Compact `YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ` range both web calendars accept. */
function formatRange(start: Date, end: Date): string {
  return `${formatIcsUtc(start)}/${formatIcsUtc(end)}`;
}

export interface CalendarLinkInput {
  title: string;
  description: string;
  url: string;
  startsAt: Date;
  endsAt: Date | null;
}

/** Google Calendar pre-filled event composer. */
export function buildGoogleCalendarUrl(input: CalendarLinkInput): string {
  const { start, end } = resolveEventWindow(input.startsAt, input.endsAt);

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: formatRange(start, end),
    details:
      input.url.length === 0
        ? input.description
        : `${input.description}\n\nJoin: ${input.url}`,
    location: input.url,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook / Microsoft 365 pre-filled event composer. */
export function buildOutlookCalendarUrl(input: CalendarLinkInput): string {
  const { start, end } = resolveEventWindow(input.startsAt, input.endsAt);

  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: input.title,
    // Outlook expects ISO 8601 rather than the compact iCalendar form.
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body:
      input.url.length === 0
        ? input.description
        : `${input.description}\n\nJoin: ${input.url}`,
    location: input.url,
  });

  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/**
 * Filename for the download.
 *
 * Sanitised because it lands in a `Content-Disposition` header, where a quote or
 * newline would let the title break out of the header value.
 */
export function icsFilename(title: string, meetingCode: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${base.length > 0 ? base : "meeting"}-${meetingCode}.ics`.replace(
    /[^a-zA-Z0-9._-]/g,
    "",
  );
}
