"use client";

import { ArrowRight, CalendarCheck } from "lucide-react";
import Link from "next/link";

import { MeetingShareDetails } from "@/components/meeting/meeting-share-details";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CreationResult } from "@/lib/meetings/types";

interface MeetingCreatedDialogProps {
  result: CreationResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Shown the moment a scheduled meeting exists, with everything the host needs to
 * invite people: title, time, link and guest passcode.
 *
 * A dialog rather than a navigation because a scheduled meeting is for later. The
 * old behaviour dropped the host straight into its lobby — somewhere they had no
 * reason to be yet — and the passcode was only readable from inside the call,
 * which is too late to put it in an invitation.
 */
export function MeetingCreatedDialog({
  result,
  open,
  onOpenChange,
}: MeetingCreatedDialogProps) {
  const lobbyHref = `/meeting/${encodeURIComponent(result.meetingCode)}/lobby`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <CalendarCheck
              className="h-5 w-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            Meeting scheduled
          </DialogTitle>
          <DialogDescription>
            Share these details with the people you are inviting. You can find
            them again under Manage meeting on your dashboard.
          </DialogDescription>
        </DialogHeader>

        <MeetingShareDetails
          meetingCode={result.meetingCode}
          title={result.title}
          startsAt={result.startsAt}
          endsAt={result.endsAt}
          passcode={result.passcode}
        />

        <DialogFooter>
          <Button asChild variant="outline">
            <Link href={lobbyHref}>Open lobby</Link>
          </Button>
          <Button asChild>
            <Link href="/dashboard">
              Go to dashboard
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
