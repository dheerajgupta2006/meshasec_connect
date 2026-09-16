"use client";

import { CalendarPlus, Download, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { meetingDescription } from "@/lib/brand";
import {
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
} from "@/lib/calendar/ics";

interface AddToCalendarProps {
  meetingCode: string;
  title: string;
  /** ISO string. Serialised because this crosses the server/client boundary. */
  startsAt: string;
  /** ISO string, or null for a meeting with no set end. */
  endsAt: string | null;
  className?: string;
  /** Dark surfaces (dashboard, lobby) need explicit contrast classes. */
  tone?: "default" | "dark";
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Offers the three ways people actually add an event: the two web calendars by
 * deep link, and a downloadable `.ics` for everything else (Apple Calendar,
 * Thunderbird, desktop Outlook).
 *
 * The web links are built on the client so they can carry the real absolute join
 * URL; the `.ics` is generated server-side because it must be authorized.
 */
export function AddToCalendar({
  meetingCode,
  title,
  startsAt,
  endsAt,
  className,
  tone = "default",
}: AddToCalendarProps) {
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const start = parseDate(startsAt);
  const end = endsAt === null ? null : parseDate(endsAt);

  // Nothing sensible to add without a start time.
  if (start === null) {
    return null;
  }

  const joinUrl =
    origin === null
      ? ""
      : `${origin}/meeting/${encodeURIComponent(meetingCode)}/lobby`;

  const linkInput = {
    title,
    description: meetingDescription(meetingCode),
    url: joinUrl,
    startsAt: start,
    endsAt: end,
  };

  const icsHref = `/api/meetings/${encodeURIComponent(meetingCode)}/calendar`;

  const isDark = tone === "dark";
  const itemClass = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
    isDark
      ? "text-zinc-200 hover:bg-white/10 hover:text-white"
      : "hover:bg-muted"
  }`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={className}
          aria-label={`Add ${title} to your calendar`}
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          Add to calendar
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={`w-60 p-1.5 ${
          isDark ? "border-white/10 bg-zinc-900/95 backdrop-blur" : ""
        }`}
      >
        <p
          className={`px-2.5 pb-1.5 pt-1 text-xs font-medium ${
            isDark ? "text-zinc-400" : "text-muted-foreground"
          }`}
        >
          Add to calendar
        </p>

        <a
          href={buildGoogleCalendarUrl(linkInput)}
          target="_blank"
          rel="noopener noreferrer"
          className={itemClass}
        >
          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
          Google Calendar
        </a>

        <a
          href={buildOutlookCalendarUrl(linkInput)}
          target="_blank"
          rel="noopener noreferrer"
          className={itemClass}
        >
          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
          Outlook
        </a>

        <a href={icsHref} download className={itemClass}>
          <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
          Download .ics
        </a>
      </PopoverContent>
    </Popover>
  );
}
