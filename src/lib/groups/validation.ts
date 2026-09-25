/**
 * Validation for group input.
 *
 * Pure and isomorphic so the create dialog and the server actions judge input the
 * same way. The client calls these to show an error inline; the server calls them
 * again because the client's call proves nothing.
 */

import {
  GROUP_DESCRIPTION_MAX_CHARS,
  GROUP_NAME_MAX_CHARS,
  GROUP_NAME_MIN_CHARS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_MESSAGE_CHARS,
  MIN_INITIAL_MEMBERS,
} from "@/lib/groups/limits";

export type Validated<T> =
  | ({ ok: true } & T)
  | { ok: false; message: string };

/**
 * Control and formatting characters: Cc and Cf.
 *
 * Stripped rather than rejected: a name pasted from a chat window or a document
 * routinely carries a zero-width joiner or a direction mark, and refusing the
 * paste teaches nothing. What matters is that the stored name cannot contain
 * something invisible that makes two different groups render identically.
 *
 * Built with `new RegExp` rather than as a literal for the same reason as
 * `CONTROL_CHARACTER_PATTERN` in the meeting validator: the project's
 * `tsconfig.json` declares no `target`, so a regex literal is typechecked against
 * ES5, which rejects Unicode property escapes. Pattern and flags are identical.
 */
const INVISIBLE = new RegExp("[\\p{Cc}\\p{Cf}]", "gu");

/** Collapses runs of whitespace and trims, which is what makes names comparable. */
function tidy(value: string): string {
  return value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/**
 * Counts what a reader would call characters.
 *
 * `String.length` counts UTF-16 units, so an emoji costs two and a name of
 * thirty emoji would be refused at a limit of sixty. Code points are the closer
 * approximation, and the one the meeting validator already uses.
 */
function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function validateGroupName(raw: unknown): Validated<{ name: string }> {
  if (typeof raw !== "string") {
    return { ok: false, message: "Give the group a name." };
  }

  const name = tidy(raw);
  const length = countCodePoints(name);

  if (length < GROUP_NAME_MIN_CHARS) {
    return {
      ok: false,
      message: `Group names need at least ${String(GROUP_NAME_MIN_CHARS)} characters.`,
    };
  }

  if (length > GROUP_NAME_MAX_CHARS) {
    return {
      ok: false,
      message: `Group names are limited to ${String(GROUP_NAME_MAX_CHARS)} characters.`,
    };
  }

  return { ok: true, name };
}

/** Description is optional, so blank and absent both resolve to null. */
export function validateGroupDescription(
  raw: unknown,
): Validated<{ description: string | null }> {
  if (raw === undefined || raw === null) {
    return { ok: true, description: null };
  }

  if (typeof raw !== "string") {
    return { ok: false, message: "That description is not valid text." };
  }

  const description = tidy(raw);

  if (description.length === 0) {
    return { ok: true, description: null };
  }

  if (countCodePoints(description) > GROUP_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      message: `Descriptions are limited to ${String(GROUP_DESCRIPTION_MAX_CHARS)} characters.`,
    };
  }

  return { ok: true, description };
}

/**
 * A group message body.
 *
 * Whitespace is trimmed at the edges but *not* collapsed inside, unlike a name:
 * people lay messages out deliberately, and the thread renders with
 * `whitespace-pre-wrap` precisely so that survives.
 */
export function validateGroupMessageBody(
  raw: unknown,
): Validated<{ body: string }> {
  if (typeof raw !== "string") {
    return { ok: false, message: "Write a message first." };
  }

  const body = raw.trim();

  if (body.length === 0) {
    return { ok: false, message: "Write a message first." };
  }

  if (countCodePoints(body) > MAX_GROUP_MESSAGE_CHARS) {
    return {
      ok: false,
      message: `Messages are limited to ${String(MAX_GROUP_MESSAGE_CHARS)} characters.`,
    };
  }

  return { ok: true, body };
}

/**
 * Loose shape check for a database id.
 *
 * Not a cuid regex on purpose: pinning the exact format would break the day
 * Prisma's default id changes, and these ids are only ever used inside a `where`
 * clause that is parameterised anyway. This bounds the length and rejects
 * obvious junk, which is all it needs to do.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * Normalizes a submitted member list.
 *
 * Deduplicates, because the picker can hand back the same id twice if it is
 * re-rendered mid-selection, and a duplicate would otherwise be caught much
 * later by the unique index as a confusing failure.
 *
 * `capacityLeft` is how many seats remain, so the same function serves creating a
 * group and adding to a full one.
 */
export function normalizeMemberIds(
  raw: unknown,
  options: { minimum: number; capacityLeft: number },
): Validated<{ ids: string[] }> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "Choose who to add." };
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!isValidId(entry)) {
      return { ok: false, message: "That selection is not valid." };
    }

    if (seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    ids.push(entry);
  }

  if (ids.length < options.minimum) {
    return {
      ok: false,
      message:
        options.minimum === 1
          ? "Choose at least one person."
          : `Choose at least ${String(options.minimum)} people.`,
    };
  }

  if (ids.length > options.capacityLeft) {
    return {
      ok: false,
      message:
        options.capacityLeft <= 0
          ? `This group is full at ${String(MAX_GROUP_MEMBERS)} members.`
          : `Only ${String(options.capacityLeft)} more can be added.`,
    };
  }

  return { ok: true, ids };
}

/** Seats left in a group of `currentSize`. Never negative. */
export function capacityLeft(currentSize: number): number {
  return Math.max(0, MAX_GROUP_MEMBERS - currentSize);
}

export { MIN_INITIAL_MEMBERS };
