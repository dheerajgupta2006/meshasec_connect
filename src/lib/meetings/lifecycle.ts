/**
 * Meeting lifecycle: deciding whether a meeting is still ahead, happening now,
 * or finished.
 *
 * Pure and isomorphic so the dashboard, the lobby and the test suite all agree on
 * one definition of "ended".
 *
 * Why a derived status rather than trusting `endsAt` alone: an instant meeting is
 * created with `endsAt: null`, and a participant who closes the tab never tells
 * the server anything. Treating "no end recorded" as "not finished" leaves every
 * instant meeting in Upcoming permanently, which is the bug this module fixes.
 * `endsAt` is authoritative when present; the staleness window below is the
 * fallback for everything else.
 */

export type MeetingStatus = "upcoming" | "live" | "ended";

/**
 * How long a room stays joinable without an explicit end.
 *
 * Matched to the 12-hour LiveKit access-token TTL in
 * `src/app/api/meetings/token/route.ts`: once no valid token can be minted for a
 * room, nobody can be inside it, so calling it live would be a lie.
 */
export const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/** The subset of a meeting row the status depends on. */
export interface MeetingLifecycleFields {
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
}

function timeOf(value: Date | null): number | null {
  if (value === null) {
    return null;
  }

  const ms = value.getTime();

  // A corrupt date must not silently become "now" through NaN comparisons, which
  // are all false and would classify the meeting as upcoming.
  return Number.isNaN(ms) ? null : ms;
}

/**
 * When the meeting becomes joinable.
 *
 * An instant meeting has no `startsAt`, so it opened the moment it was created.
 */
export function openedAt(meeting: MeetingLifecycleFields): number {
  return timeOf(meeting.startsAt) ?? timeOf(meeting.createdAt) ?? 0;
}

/**
 * Classifies a meeting at a point in time.
 *
 * Order matters: a recorded `endsAt` wins over the staleness fallback, so a
 * meeting the host explicitly ended is finished immediately rather than after the
 * window elapses.
 */
export function resolveMeetingStatus(
  meeting: MeetingLifecycleFields,
  now: number,
): MeetingStatus {
  const start = openedAt(meeting);
  const end = timeOf(meeting.endsAt);

  if (end !== null) {
    if (now >= end) {
      return "ended";
    }

    // An end is recorded but has not arrived yet: a scheduled meeting still to
    // come, or one currently running.
    return now >= start ? "live" : "upcoming";
  }

  if (now < start) {
    return "upcoming";
  }

  // Open, with no end recorded. Live until the window lapses, then presumed over
  // rather than left in Upcoming forever.
  return now - start >= STALE_AFTER_MS ? "ended" : "live";
}

/** True when the meeting should appear under Past. */
export function hasEnded(
  meeting: MeetingLifecycleFields,
  now: number,
): boolean {
  return resolveMeetingStatus(meeting, now) === "ended";
}

/**
 * Sort key for a finished meeting: when it actually stopped.
 *
 * Falls back to the presumed end so meetings that were never closed still order
 * sensibly against ones that were.
 */
export function endedOrder(meeting: MeetingLifecycleFields): number {
  return timeOf(meeting.endsAt) ?? openedAt(meeting) + STALE_AFTER_MS;
}

export interface PartitionedMeetings<T> {
  /** Soonest first — the next thing you need to attend is at the top. */
  upcoming: T[];
  /** Most recently finished first. */
  past: T[];
}

/**
 * Splits meetings into the dashboard's two lists.
 *
 * Generic over the row type so it accepts the Prisma selection directly without
 * the dashboard having to reshape it.
 */
export function partitionMeetings<T extends MeetingLifecycleFields>(
  meetings: readonly T[],
  now: number,
): PartitionedMeetings<T> {
  const upcoming: T[] = [];
  const past: T[] = [];

  meetings.forEach((meeting) => {
    if (hasEnded(meeting, now)) {
      past.push(meeting);
      return;
    }

    upcoming.push(meeting);
  });

  upcoming.sort((first, second) => openedAt(first) - openedAt(second));
  past.sort((first, second) => endedOrder(second) - endedOrder(first));

  return { upcoming, past };
}

/**
 * Where a meeting belongs on the dashboard.
 *
 * Distinct from `MeetingStatus`, which only reads the database. This also accounts
 * for whether anyone is actually connected right now, which is the difference
 * between "scheduled for later", "happening", and "over".
 */
export type MeetingActivity = "upcoming" | "ongoing" | "past";

/**
 * How long an open-but-empty meeting stays joinable.
 *
 * A room nobody has joined yet still needs to appear as joinable — otherwise a
 * host who creates an instant meeting and copies the link sees it filed under
 * past before they have even opened it. After this window an empty room is
 * treated as finished, which is also what retires a meeting whose participants
 * have all left.
 */
export const EMPTY_ROOM_GRACE_MS = 15 * 60 * 1000;

export interface ActivityInput {
  meeting: MeetingLifecycleFields;
  /**
   * Participants currently connected, or null when LiveKit could not be reached.
   * Null falls back to database-only reasoning rather than assuming zero.
   */
  liveParticipants: number | null;
  now: number;
}

/**
 * Classifies a meeting for the dashboard.
 *
 * Order is deliberate:
 * 1. Anyone connected means it is happening, whatever the stored fields say. A
 *    live call must never be filed as past.
 * 2. An explicit end wins next — the host said so.
 * 3. A start time still ahead is upcoming.
 * 4. Open but empty is upcoming inside the grace window, past after it.
 */
export function resolveMeetingActivity({
  meeting,
  liveParticipants,
  now,
}: ActivityInput): MeetingActivity {
  if (liveParticipants !== null && liveParticipants > 0) {
    return "ongoing";
  }

  const status = resolveMeetingStatus(meeting, now);

  if (status === "ended") {
    return "past";
  }

  if (status === "upcoming") {
    return "upcoming";
  }

  // Open, and either empty or unknowable.
  const openFor = now - openedAt(meeting);

  if (liveParticipants === null) {
    // Cannot see the room. Trust the database rather than guess it is empty; the
    // staleness rule in `resolveMeetingStatus` already retired it if it is old.
    return "ongoing";
  }

  return openFor < EMPTY_ROOM_GRACE_MS ? "upcoming" : "past";
}

export interface ActivityGroups<T> {
  /** Someone is connected. Sorted by when the room opened, newest first. */
  ongoing: T[];
  /** Soonest first. */
  upcoming: T[];
  /** Most recently finished first. */
  past: T[];
}

/**
 * Splits meetings into the dashboard's three lists.
 *
 * `liveCounts` is keyed by meeting code; pass null when LiveKit is unavailable so
 * every meeting falls back to database-only classification.
 */
export function groupMeetingsByActivity<
  T extends MeetingLifecycleFields & { meetingCode: string },
>(
  meetings: readonly T[],
  liveCounts: Map<string, number> | null,
  now: number,
): ActivityGroups<T> {
  const ongoing: T[] = [];
  const upcoming: T[] = [];
  const past: T[] = [];

  meetings.forEach((meeting) => {
    const activity = resolveMeetingActivity({
      meeting,
      liveParticipants:
        liveCounts === null ? null : (liveCounts.get(meeting.meetingCode) ?? 0),
      now,
    });

    if (activity === "ongoing") {
      ongoing.push(meeting);
      return;
    }

    if (activity === "upcoming") {
      upcoming.push(meeting);
      return;
    }

    past.push(meeting);
  });

  ongoing.sort((first, second) => openedAt(second) - openedAt(first));
  upcoming.sort((first, second) => openedAt(first) - openedAt(second));
  past.sort((first, second) => endedOrder(second) - endedOrder(first));

  return { ongoing, upcoming, past };
}
