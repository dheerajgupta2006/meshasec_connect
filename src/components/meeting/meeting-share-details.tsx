"use client";

import { Check, Copy, KeyRound, Link2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { AddToCalendar } from "@/components/calendar/add-to-calendar";
import { LocalDateTime } from "@/components/local-date-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APP_NAME } from "@/lib/brand";
import { formatPasscodeForDisplay } from "@/lib/meetings/passcode";

/** How long the copied tick stays before reverting to the copy icon. */
const COPY_FEEDBACK_MS = 2000;

type CopyTarget = "link" | "passcode" | "invitation";

const COPIED_LABEL: Record<CopyTarget, string> = {
  link: "Meeting link copied",
  passcode: "Passcode copied",
  invitation: "Invitation copied",
};

export interface MeetingShareDetailsProps {
  meetingCode: string;
  title: string;
  /** ISO instants. A null start means an instant meeting. */
  startsAt: string | null;
  endsAt: string | null;
  passcode: string | null;
}

/**
 * The meeting time, for text that leaves the app.
 *
 * Unlike `LocalDateTime`, this is read by someone else, possibly in another time
 * zone, so the zone is spelled out. Only ever called from a click handler, so it
 * formats in the host's own zone rather than the server's.
 */
function describeWhen(
  startsAt: string | null,
  endsAt: string | null,
): string | null {
  if (startsAt === null) {
    return null;
  }

  const start = new Date(startsAt);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  // Explicit components rather than `dateStyle`: the two cannot be combined with
  // `timeZoneName`, which is the part a recipient elsewhere actually needs.
  const full: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };

  const startText = new Intl.DateTimeFormat(undefined, full).format(start);

  if (endsAt === null) {
    return startText;
  }

  const end = new Date(endsAt);

  if (Number.isNaN(end.getTime())) {
    return startText;
  }

  // Same day reads "…, 3:00 PM GMT+5:30 – 4:00 PM GMT+5:30" without repeating
  // the date.
  const sameDay = start.toDateString() === end.toDateString();
  const endText = new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" }
      : full,
  ).format(end);

  return `${startText} – ${endText}`;
}

function buildInvitation(input: {
  title: string;
  link: string;
  passcode: string | null;
  when: string | null;
}): string {
  const lines = [`You are invited to "${input.title}" on ${APP_NAME}.`, ""];

  if (input.when !== null) {
    lines.push(`When: ${input.when}`);
  }

  lines.push(`Join: ${input.link}`);

  if (input.passcode !== null) {
    lines.push(`Passcode: ${formatPasscodeForDisplay(input.passcode)}`);
    lines.push(
      "",
      "No account? Open the link and enter the passcode to join as a guest.",
    );
  }

  return lines.join("\n");
}

/**
 * Everything a host needs to invite people: title, time, link and guest passcode,
 * each copyable on its own or all together as one invitation.
 *
 * Shared by the dialog shown right after scheduling and the settings dialog on
 * the dashboard, so the two cannot describe the same meeting differently.
 */
export function MeetingShareDetails({
  meetingCode,
  title,
  startsAt,
  endsAt,
  passcode,
}: MeetingShareDetailsProps) {
  const linkId = useId();
  const passcodeId = useId();
  const passcodeHintId = useId();

  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  // The link needs the real origin, which only the browser knows: a preview
  // deployment and production run this code under different hostnames.
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (copied === null) {
      return;
    }

    const timer = window.setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);

    return () => window.clearTimeout(timer);
  }, [copied]);

  const link =
    origin === null
      ? ""
      : `${origin}/meeting/${encodeURIComponent(meetingCode)}/lobby`;

  async function copy(value: string, target: CopyTarget): Promise<void> {
    if (value.length === 0) {
      return;
    }

    setCopyError(null);

    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      // The clipboard needs a secure context and, in some browsers, a focused
      // document. Selecting the text by hand works everywhere.
      setCopyError(
        "We could not copy that. Select the text and copy it manually.",
      );
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-xs font-medium text-muted-foreground">Meeting</p>
        <p className="mt-0.5 break-words font-semibold">{title}</p>
        {startsAt !== null && (
          <p className="mt-1 text-sm text-muted-foreground">
            <LocalDateTime iso={startsAt} mode="dateTime" />
            {endsAt !== null && (
              <>
                {" – "}
                <LocalDateTime iso={endsAt} mode="time" />
              </>
            )}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor={linkId}
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          Meeting link
        </label>
        <div className="flex gap-2">
          <Input
            id={linkId}
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
            className="h-10 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={link.length === 0}
            onClick={() => void copy(link, "link")}
            className="h-10 w-10 shrink-0"
            aria-label="Copy the meeting link"
          >
            {copied === "link" ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor={passcodeId}
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          Guest passcode
        </label>

        {passcode === null ? (
          <p id={passcodeId} className="text-sm text-muted-foreground">
            This meeting has no passcode, so guests without an account cannot
            join it. Anyone signed in can still use the link.
          </p>
        ) : (
          <div className="flex gap-2">
            <Input
              id={passcodeId}
              readOnly
              value={formatPasscodeForDisplay(passcode)}
              onFocus={(event) => event.currentTarget.select()}
              aria-describedby={passcodeHintId}
              className="h-10 min-w-0 flex-1 font-mono text-base tracking-[0.3em]"
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              // The raw digits: the lobby strips spaces anyway, and a bare number
              // pastes cleanly into any field.
              onClick={() => void copy(passcode, "passcode")}
              className="h-10 w-10 shrink-0"
              aria-label="Copy the guest passcode"
            >
              {copied === "passcode" ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        )}

        <p id={passcodeHintId} className="text-xs text-muted-foreground">
          Guests without an account enter this passcode in the lobby. People
          signed in to {APP_NAME} join with the link alone, and you can ring your
          contacts directly from inside the call.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="secondary"
          disabled={link.length === 0}
          onClick={() =>
            void copy(
              buildInvitation({
                title,
                link,
                passcode,
                when: describeWhen(startsAt, endsAt),
              }),
              "invitation",
            )
          }
          className="sm:flex-1"
        >
          {copied === "invitation" ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
          {copied === "invitation" ? "Invitation copied" : "Copy invitation"}
        </Button>

        {startsAt !== null && (
          <AddToCalendar
            meetingCode={meetingCode}
            title={title}
            startsAt={startsAt}
            endsAt={endsAt}
            className="h-10 sm:flex-1"
          />
        )}
      </div>

      {/* The icon swap is invisible to a screen reader, so the result is announced. */}
      <p role="status" aria-live="polite" className="sr-only">
        {copied === null ? "" : COPIED_LABEL[copied]}
      </p>

      {copyError !== null && (
        <p role="alert" className="text-sm text-destructive-text">
          {copyError}
        </p>
      )}
    </div>
  );
}
