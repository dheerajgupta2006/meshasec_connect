"use server";

/**
 * Host settings for a meeting: what the host needs to share it, and the title
 * and schedule they may still change before it starts.
 *
 * Gated to the meeting's owner — the acting host, or the creator if the room has
 * been handed over. Deliberately not co-hosts: a co-host is a role granted during
 * a call to help run it, whereas moving the time everyone has in their calendar is
 * the owner's decision. The same reasoning keeps `endMeeting` owner-only.
 *
 * Nothing the caller sends contributes to whether they may act, or whether the
 * meeting is still changeable. The caller names a meeting code and proposes new
 * values; both answers come from the meeting row.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import {
  NOT_HOST,
  requireMeetingHost,
  type HostContext,
} from "@/lib/meetings/host-guard";
import { isScheduleEditable } from "@/lib/meetings/lifecycle";
import { assertTrustedOrigin } from "@/lib/meetings/origin";
import {
  validateScheduleEdit,
  type FieldErrors,
} from "@/lib/meetings/validation";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";

/** Matches the token route's bound, so no path accepts a longer code than another. */
const MAX_MEETING_CODE_LENGTH = 128;

const ALREADY_STARTED =
  "This meeting has already started, so its schedule can no longer be changed.";
const UNTRUSTED_ORIGIN =
  "This request could not be verified. Reload the page and try again.";
const FIX_FIELDS = "Check the highlighted fields and try again.";

export interface MeetingSettingsView {
  meetingCode: string;
  title: string;
  /** ISO instants. A null start means an instant meeting. */
  startsAt: string | null;
  endsAt: string | null;
  /**
   * The room passcode. Only ever returned to the owner, who is the person deciding
   * whom to share it with.
   */
  passcode: string | null;
  /** Whether the title and schedule can still be changed. */
  editable: boolean;
}

export type MeetingSettingsResult =
  | { ok: true; settings: MeetingSettingsView }
  | { ok: false; message: string };

export type UpdateMeetingScheduleResult =
  | { ok: true; message: string; settings: MeetingSettingsView }
  | {
      ok: false;
      message: string;
      fieldErrors: FieldErrors;
      /**
       * True when the refusal is because the meeting has started, so the dialog
       * can switch to read-only instead of inviting another attempt that will
       * fail the same way.
       */
      locked: boolean;
    };

const settingsSelect = {
  meetingCode: true,
  title: true,
  createdAt: true,
  startsAt: true,
  endsAt: true,
  passcode: true,
} as const;

interface SettingsRow {
  meetingCode: string;
  title: string;
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
  passcode: string | null;
}

function toView(row: SettingsRow, now: number): MeetingSettingsView {
  return {
    meetingCode: row.meetingCode,
    title: row.title,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    passcode: row.passcode,
    editable: isScheduleEditable(row, now),
  };
}

function isPlausibleCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MEETING_CODE_LENGTH
  );
}

function refusal(
  message: string,
  options: { locked?: boolean; fieldErrors?: FieldErrors } = {},
): UpdateMeetingScheduleResult {
  return {
    ok: false,
    message,
    fieldErrors: options.fieldErrors ?? {},
    locked: options.locked ?? false,
  };
}

/**
 * The owner gate, built on the single host check rather than beside it.
 *
 * `requireMeetingHost` at "moderator" admits the acting host, the creator and
 * co-hosts; this narrows it to the first two. Not the "owner" level, which admits
 * only the acting host: if someone joined early and host succession moved the
 * role, that would lock the person who scheduled the meeting out of rescheduling
 * it.
 */
async function requireOwner(meetingCode: string): Promise<HostContext | null> {
  const host = await requireMeetingHost(meetingCode, "moderator");

  if (host === null || (!host.isOwner && !host.isCreator)) {
    return null;
  }

  return host;
}

/**
 * What the settings dialog opens with.
 *
 * Fetched when the dialog opens rather than rendered into the dashboard, so the
 * passcode for every meeting on the page is not sitting in its HTML.
 */
export async function getMeetingSettings(
  meetingCode: string,
): Promise<MeetingSettingsResult> {
  if (!isPlausibleCode(meetingCode)) {
    return { ok: false, message: NOT_HOST };
  }

  const host = await requireOwner(meetingCode);

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  const row = await prisma.meeting.findUnique({
    where: { id: host.meetingId },
    select: settingsSelect,
  });

  if (row === null) {
    return { ok: false, message: NOT_HOST };
  }

  return { ok: true, settings: toView(row, Date.now()) };
}

/**
 * Changes a scheduled meeting's title, start and end. Only before it starts.
 *
 * `input` is untrusted and typed `unknown` on purpose: Next.js validates the
 * action id, not the argument's shape. It is judged by `validateScheduleEdit`,
 * which applies exactly the rules creation applies.
 */
export async function updateMeetingSchedule(
  meetingCode: string,
  input: unknown,
): Promise<UpdateMeetingScheduleResult> {
  if (!isPlausibleCode(meetingCode)) {
    return refusal(NOT_HOST);
  }

  // Next.js already compares Origin against Host before an action runs. This is
  // the same in-service check `createMeetingAction` makes, so creating a meeting
  // and changing one are guarded identically.
  if (!assertTrustedOrigin(headers()).trusted) {
    return refusal(UNTRUSTED_ORIGIN);
  }

  const host = await requireOwner(meetingCode);

  if (host === null) {
    return refusal(NOT_HOST);
  }

  const now = new Date();
  const validation = validateScheduleEdit(input, now);

  if (!validation.ok) {
    return refusal(validation.formMessage ?? FIX_FIELDS, {
      fieldErrors: validation.fieldErrors,
    });
  }

  // Charged after the gate and validation, so neither a stranger nor a typo can
  // spend the owner's budget.
  const verdict = consumeRateLimit("meetingSettings", host.localUserId);

  if (!verdict.allowed) {
    return refusal(
      `You are changing this meeting too often. Try again in ${describeRetryAfter(
        verdict.retryAfterSeconds,
      )}.`,
    );
  }

  const current = await prisma.meeting.findUnique({
    where: { id: host.meetingId },
    select: settingsSelect,
  });

  if (current === null) {
    return refusal(NOT_HOST);
  }

  // Checked first for a clear answer. The conditional write below is what
  // actually guarantees it.
  if (!isScheduleEditable(current, now.getTime())) {
    return refusal(ALREADY_STARTED, { locked: true });
  }

  const { normalizedTitle, startsAt, endsAt } = validation.value;

  // Conditional on the meeting still being ahead, which closes the gap between
  // the check above and this write: if the start passes, or the host ends the
  // meeting from another tab in between, nothing changes. The predicate is
  // `isScheduleEditable` restated for the database — a start still in the future,
  // and no end that has already arrived.
  const updated = await prisma.meeting.updateMany({
    where: {
      id: host.meetingId,
      startsAt: { gt: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    data: { title: normalizedTitle, startsAt, endsAt },
  });

  if (updated.count === 0) {
    return refusal(ALREADY_STARTED, { locked: true });
  }

  revalidatePath("/dashboard");

  return {
    ok: true,
    message: "Meeting updated.",
    settings: toView(
      { ...current, title: normalizedTitle, startsAt, endsAt },
      now.getTime(),
    ),
  };
}
