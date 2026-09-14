/**
 * Isomorphic validation for meeting creation.
 *
 * Every exported function is total: failures are returned as `ValidationOutcome`
 * values and nothing here ever throws. No Prisma, no Clerk, no `node:crypto`,
 * no `next/*`.
 *
 * The client pass and the server pass share the same normalization, code-point
 * counting, and character-class rules. Only the server pass compares against a
 * clock, rejects forbidden keys, and checks the Creation_Request_ID shape.
 */

import {
  FORBIDDEN_INPUT_KEYS,
  MAX_CREATION_REQUEST_ID_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
} from "@/lib/meetings/types";
import type { CreateMeetingInput, MeetingMode } from "@/lib/meetings/types";
import type { CreationDraft } from "@/lib/meetings/form-state";

export interface FieldErrors {
  title?: string;
  mode?: string;
  startsAt?: string;
  endsAt?: string;
}

export type ValidationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: FieldErrors; formMessage: string | null };

export interface NormalizedCreationInput {
  normalizedTitle: string;
  mode: MeetingMode;
  startsAt: Date | null;
  endsAt: Date | null;
  creationRequestId: string;
}

/**
 * Req 4.5: C0, DEL, and C1 controls. `.trim()` does not remove `\u0000`-`\u001F`,
 * so a title made only of control characters survives trimming and is caught here.
 *
 * These two are `/\p{Cc}/u` and `/\p{Cf}/u`, built with `new RegExp` rather than
 * as literals only because the project's `tsconfig.json` declares no `target`
 * and therefore typechecks against ES5, which rejects Unicode property escapes
 * in a regex literal. Pattern and flags are identical either way.
 */
const CONTROL_CHARACTER_PATTERN = new RegExp("\\p{Cc}", "u");

/** Req 4.5 (hardening): zero-width joiners, bidi overrides, and other format characters. */
const FORMAT_CHARACTER_PATTERN = new RegExp("\\p{Cf}", "u");

/** Req 6.1: the 32-character hex form minted by `mintCreationRequestId`. */
const HEX_CREATION_REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Req 6.1: the `crypto.randomUUID()` fallback form. */
const UUID_CREATION_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Req 5.4: an explicit UTC designator or numeric offset is mandatory. A
 * zone-less value such as `2026-03-04T09:30` does not identify one instant on
 * the server and is rejected rather than silently read in the server's zone.
 */
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/;

const MILLIS_PER_MINUTE = 60_000;
const MAX_OFFSET_HOURS = 23;
const MAX_MINUTES = 59;
const MAX_SECONDS = 59;
const MAX_HOURS = 23;

/**
 * `validateClientInput` cannot know the adopted Creation_Request_ID: the reducer
 * decides whether to keep the current one or adopt a freshly minted candidate.
 * The caller replaces this placeholder with `state.creationRequestId` before
 * invoking the Server Action.
 */
const UNASSIGNED_CREATION_REQUEST_ID = "";

const TITLE_REQUIRED_MESSAGE = "Enter a meeting title.";
const TITLE_TOO_LONG_MESSAGE = `Use ${TITLE_MAX_CHARS} characters or fewer for the meeting title.`;
const TITLE_CONTROL_MESSAGE =
  "Remove control characters from the meeting title.";
const TITLE_FORMAT_MESSAGE =
  "Remove hidden or zero-width characters from the meeting title.";
const MODE_INVALID_MESSAGE =
  "Choose either an instant meeting or a scheduled meeting.";
const START_REQUIRED_MESSAGE =
  "Choose a start date and time for your scheduled meeting.";
const START_INVALID_MESSAGE = "Enter a valid start date and time.";
const START_AMBIGUOUS_MESSAGE =
  "Enter a start date and time that identifies exactly one instant.";
const START_NOT_FUTURE_MESSAGE = "Choose a start time in the future.";
const END_INVALID_MESSAGE = "Enter a valid end date and time.";
const END_AMBIGUOUS_MESSAGE =
  "Enter an end date and time that identifies exactly one instant.";
const END_NOT_AFTER_START_MESSAGE =
  "Choose an end time that is after the start time.";
const FIX_FIELDS_MESSAGE =
  "Please correct the highlighted fields, then try again.";
const MALFORMED_PAYLOAD_MESSAGE =
  "This submission could not be read. Reload the page and try again.";
const FORBIDDEN_KEY_MESSAGE =
  "This submission included fields that cannot be set here. Reload the page and try again.";
const CREATION_REQUEST_ID_MESSAGE =
  "This submission could not be verified. Reload the page and try again.";

/** Req 4.2: leading/trailing whitespace removal only. No case or Unicode folding. */
export function normalizeTitle(raw: string): string {
  return raw.trim();
}

/**
 * Req 4.3: counts Unicode code points, not UTF-16 units. `String.length` counts
 * an astral character such as an emoji as 2 and would reject valid titles.
 */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/** Req 4.5: true when the value contains Cc (control) or Cf (format) characters. */
export function hasDisallowedCharacters(value: string): boolean {
  return (
    CONTROL_CHARACTER_PATTERN.test(value) || FORMAT_CHARACTER_PATTERN.test(value)
  );
}

/**
 * Req 5.3/5.4: strict ISO-8601 with an explicit UTC offset. Returns null when
 * the value is malformed, is not a real calendar instant, or omits the offset.
 */
export function parseIso8601Instant(value: string): Date | null {
  const match = ISO_INSTANT_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(optionalGroup(match, 6) ?? "0");
  const fraction = optionalGroup(match, 7);
  const millisecond =
    fraction === null ? 0 : Number(`${fraction}000`.slice(0, 3));

  if (
    hour > MAX_HOURS ||
    minute > MAX_MINUTES ||
    second > MAX_SECONDS ||
    month < 1 ||
    month > 12 ||
    day < 1
  ) {
    return null;
  }

  const offsetMinutes = readOffsetMinutes(match);
  if (offsetMinutes === null) {
    return null;
  }

  const zonedMillis = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  if (Number.isNaN(zonedMillis)) {
    return null;
  }

  // Rejects values such as 2026-02-30 that Date.UTC would silently roll over.
  const rollOverCheck = new Date(zonedMillis);
  if (
    rollOverCheck.getUTCFullYear() !== year ||
    rollOverCheck.getUTCMonth() !== month - 1 ||
    rollOverCheck.getUTCDate() !== day
  ) {
    return null;
  }

  const instant = new Date(zonedMillis - offsetMinutes * MILLIS_PER_MINUTE);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Client-side pass: shape, title rules, mode enum, start presence and
 * parseability, and end-after-start. Deliberately performs no wall-clock
 * comparison: the browser clock can be skewed, and a false client rejection of
 * a valid time is worse than a server round trip (Req 5.6).
 *
 * The returned `creationRequestId` is an empty placeholder. The reducer owns the
 * Creation_Request_ID lifecycle, so the caller must overwrite it with the
 * adopted identifier before sending the request.
 */
export function validateClientInput(
  draft: CreationDraft,
): ValidationOutcome<CreateMeetingInput> {
  const fieldErrors: FieldErrors = {};

  const normalizedTitle = readTitle(draft.title, fieldErrors);
  const mode = readMode(draft.mode, fieldErrors);

  let startsAt: Date | null = null;
  let endsAt: Date | null = null;

  if (mode === "scheduled") {
    const startValue = draft.startsAtLocal.trim();
    if (startValue.length === 0) {
      fieldErrors.startsAt = START_REQUIRED_MESSAGE;
    } else {
      const parsedStart = parseLocalDateTime(startValue);
      if (parsedStart === null) {
        fieldErrors.startsAt = START_INVALID_MESSAGE;
      } else {
        startsAt = parsedStart;
      }
    }

    const endValue = draft.endsAtLocal.trim();
    if (endValue.length > 0) {
      const parsedEnd = parseLocalDateTime(endValue);
      if (parsedEnd === null) {
        fieldErrors.endsAt = END_INVALID_MESSAGE;
      } else if (
        startsAt !== null &&
        parsedEnd.getTime() <= startsAt.getTime()
      ) {
        fieldErrors.endsAt = END_NOT_AFTER_START_MESSAGE;
      } else {
        endsAt = parsedEnd;
      }
    }
  }

  if (hasAnyFieldError(fieldErrors)) {
    return { ok: false, fieldErrors, formMessage: FIX_FIELDS_MESSAGE };
  }
  if (normalizedTitle === null || mode === null) {
    return { ok: false, fieldErrors, formMessage: MALFORMED_PAYLOAD_MESSAGE };
  }

  return {
    ok: true,
    value: {
      title: normalizedTitle,
      mode,
      startsAt: startsAt === null ? null : startsAt.toISOString(),
      endsAt: endsAt === null ? null : endsAt.toISOString(),
      creationRequestId: UNASSIGNED_CREATION_REQUEST_ID,
    },
  };
}

/**
 * Authoritative pass. `now` is Server_Receipt_Time, injected so the boundary
 * stays pure and testable.
 *
 * Order is deliberate: an unreadable payload and then forbidden server-assigned
 * keys are rejected before any field rule runs (Req 10.4).
 */
export function validateServerInput(
  raw: unknown,
  now: Date,
): ValidationOutcome<NormalizedCreationInput> {
  if (!isRecord(raw)) {
    return { ok: false, fieldErrors: {}, formMessage: MALFORMED_PAYLOAD_MESSAGE };
  }
  if (findForbiddenKey(raw) !== null) {
    return { ok: false, fieldErrors: {}, formMessage: FORBIDDEN_KEY_MESSAGE };
  }

  const fieldErrors: FieldErrors = {};
  let formMessage: string | null = null;

  const rawTitle = raw.title;
  let normalizedTitle: string | null = null;
  if (typeof rawTitle === "string") {
    normalizedTitle = readTitle(rawTitle, fieldErrors);
  } else {
    fieldErrors.title = TITLE_REQUIRED_MESSAGE;
  }

  const mode = readMode(raw.mode, fieldErrors);

  const rawCreationRequestId = raw.creationRequestId;
  const creationRequestId =
    typeof rawCreationRequestId === "string" &&
    isAcceptedCreationRequestId(rawCreationRequestId)
      ? rawCreationRequestId
      : null;
  if (creationRequestId === null) {
    formMessage = CREATION_REQUEST_ID_MESSAGE;
  }

  let startsAt: Date | null = null;
  let endsAt: Date | null = null;

  // Instant mode discards any submitted schedule input: both columns persist as
  // null (Req 5.9, 5.10).
  if (mode === "scheduled") {
    const startField = readScheduleField(raw.startsAt);
    if (startField.kind === "absent") {
      fieldErrors.startsAt = START_REQUIRED_MESSAGE;
    } else if (startField.kind === "invalid") {
      fieldErrors.startsAt = START_AMBIGUOUS_MESSAGE;
    } else {
      const parsedStart = parseIso8601Instant(startField.raw);
      if (parsedStart === null) {
        fieldErrors.startsAt = START_AMBIGUOUS_MESSAGE;
      } else if (parsedStart.getTime() <= now.getTime()) {
        fieldErrors.startsAt = START_NOT_FUTURE_MESSAGE;
      } else {
        startsAt = parsedStart;
      }
    }

    const endField = readScheduleField(raw.endsAt);
    if (endField.kind === "invalid") {
      fieldErrors.endsAt = END_AMBIGUOUS_MESSAGE;
    } else if (endField.kind === "present") {
      const parsedEnd = parseIso8601Instant(endField.raw);
      if (parsedEnd === null) {
        fieldErrors.endsAt = END_AMBIGUOUS_MESSAGE;
      } else if (
        startsAt !== null &&
        parsedEnd.getTime() <= startsAt.getTime()
      ) {
        fieldErrors.endsAt = END_NOT_AFTER_START_MESSAGE;
      } else {
        endsAt = parsedEnd;
      }
    }
  }

  if (formMessage !== null || hasAnyFieldError(fieldErrors)) {
    return {
      ok: false,
      fieldErrors,
      formMessage: formMessage ?? FIX_FIELDS_MESSAGE,
    };
  }
  if (normalizedTitle === null || mode === null || creationRequestId === null) {
    return { ok: false, fieldErrors, formMessage: MALFORMED_PAYLOAD_MESSAGE };
  }

  return {
    ok: true,
    value: {
      normalizedTitle,
      mode,
      startsAt,
      endsAt,
      creationRequestId,
    },
  };
}

function readTitle(rawTitle: string, fieldErrors: FieldErrors): string | null {
  const normalizedTitle = normalizeTitle(rawTitle);
  const length = countCodePoints(normalizedTitle);

  if (length < TITLE_MIN_CHARS) {
    fieldErrors.title = TITLE_REQUIRED_MESSAGE;
    return null;
  }
  if (length > TITLE_MAX_CHARS) {
    fieldErrors.title = TITLE_TOO_LONG_MESSAGE;
    return null;
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalizedTitle)) {
    fieldErrors.title = TITLE_CONTROL_MESSAGE;
    return null;
  }
  if (FORMAT_CHARACTER_PATTERN.test(normalizedTitle)) {
    fieldErrors.title = TITLE_FORMAT_MESSAGE;
    return null;
  }

  return normalizedTitle;
}

function readMode(rawMode: unknown, fieldErrors: FieldErrors): MeetingMode | null {
  if (rawMode === "instant" || rawMode === "scheduled") {
    return rawMode;
  }
  fieldErrors.mode = MODE_INVALID_MESSAGE;
  return null;
}

type ScheduleField =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; raw: string };

function readScheduleField(value: unknown): ScheduleField {
  if (value === null || value === undefined) {
    return { kind: "absent" };
  }
  if (typeof value !== "string") {
    return { kind: "invalid" };
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? { kind: "absent" } : { kind: "present", raw: trimmed };
}

/**
 * Req 5.3: `<input type="datetime-local">` yields a zone-less value such as
 * `2026-03-04T09:30`, which ECMAScript parses as local time. The caller
 * serializes the result with `toISOString()`, producing the explicit-offset
 * instant the server requires.
 */
function parseLocalDateTime(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isAcceptedCreationRequestId(value: string): boolean {
  if (value.length > MAX_CREATION_REQUEST_ID_CHARS) {
    return false;
  }
  return (
    HEX_CREATION_REQUEST_ID_PATTERN.test(value) ||
    UUID_CREATION_REQUEST_ID_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findForbiddenKey(payload: Record<string, unknown>): string | null {
  for (const key of FORBIDDEN_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return key;
    }
  }
  return null;
}

function hasAnyFieldError(fieldErrors: FieldErrors): boolean {
  return (
    fieldErrors.title !== undefined ||
    fieldErrors.mode !== undefined ||
    fieldErrors.startsAt !== undefined ||
    fieldErrors.endsAt !== undefined
  );
}

function readOffsetMinutes(match: RegExpExecArray): number | null {
  const sign = optionalGroup(match, 8);
  if (sign === null) {
    return 0;
  }

  const offsetHours = Number(optionalGroup(match, 9) ?? "0");
  const offsetMinutes = Number(optionalGroup(match, 10) ?? "0");
  if (offsetHours > MAX_OFFSET_HOURS || offsetMinutes > MAX_MINUTES) {
    return null;
  }

  const total = offsetHours * 60 + offsetMinutes;
  return sign === "-" ? -total : total;
}

function optionalGroup(match: RegExpExecArray, index: number): string | null {
  const group: string | undefined = match[index];
  return group === undefined ? null : group;
}
