"use client";

import { ArrowUpRight, Check, Copy, Link2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AddToCalendar } from "@/components/calendar/add-to-calendar";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface InviteModalProps {
  /** null while no meeting has been created yet. */
  meetingCode: string | null;
  meetingTitle?: string | null;
  /**
   * ISO start time. Optional because an instant meeting has none until it is
   * created; when absent the calendar offer is hidden rather than guessed.
   */
  startsAt?: string | null;
  endsAt?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const COPY_SUCCESS_MESSAGE = "Invite link copied";
const COPY_MANUAL_MESSAGE =
  "We could not copy for you. The link is selected — press Ctrl+C or Cmd+C.";

export function InviteModal({
  meetingCode,
  meetingTitle = null,
  startsAt = null,
  endsAt = null,
  open,
  onOpenChange,
}: InviteModalProps) {
  // Read in an effect rather than during render: `window` is absent on the
  // server and reading it inline would produce a hydration mismatch.
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // A fresh dialog should never show a stale "Copied" state.
  useEffect(() => {
    setCopied(false);
  }, [open, meetingCode]);

  const lobbyPath =
    meetingCode === null
      ? null
      : `/meeting/${encodeURIComponent(meetingCode)}/lobby`;

  // Falls back to the path alone if the origin has not been read yet, so the
  // field is never empty while the dialog is open.
  const inviteUrl =
    lobbyPath === null ? "" : origin === null ? lobbyPath : `${origin}${lobbyPath}`;

  function selectForManualCopy(): void {
    const field = linkFieldRef.current;

    if (field !== null) {
      field.focus();
      field.select();
      // iOS Safari ignores select() on readonly inputs without this.
      field.setSelectionRange(0, field.value.length);
    }

    toast.error(COPY_MANUAL_MESSAGE);
  }

  async function handleCopy(): Promise<void> {
    if (inviteUrl.length === 0) {
      return;
    }

    // Typed as possibly absent on purpose: `navigator.clipboard` is undefined in
    // insecure contexts and in some in-app browsers, even though the DOM types
    // declare it as always present.
    const clipboard: Clipboard | undefined = navigator.clipboard;

    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      selectForManualCopy();
      return;
    }

    try {
      await clipboard.writeText(inviteUrl);
      setCopied(true);
      toast.success(COPY_SUCCESS_MESSAGE);
    } catch {
      // Permission denied, or the document was not focused when we asked.
      setCopied(false);
      selectForManualCopy();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-zinc-900/95 text-zinc-100 backdrop-blur-xl">
        <DialogHeader>
          <span
            aria-hidden="true"
            className="mb-1 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white"
          >
            <Link2 className="h-5 w-5" />
          </span>
          <DialogTitle>Your meeting is ready</DialogTitle>
          <DialogDescription className="text-zinc-400">
            {meetingTitle === null || meetingTitle.length === 0
              ? "Share this link with anyone you want in the room."
              : `Share this link to invite people to ${meetingTitle}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="invite-link" className="text-zinc-300">
            Invite link
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="invite-link"
              ref={linkFieldRef}
              value={inviteUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
              aria-label="Meeting invite link"
              className="h-11 min-w-0 border-white/15 bg-white/[0.06] font-mono text-xs text-zinc-100 sm:h-10 sm:text-sm"
            />
            <Button
              type="button"
              onClick={handleCopy}
              disabled={inviteUrl.length === 0}
              className="h-11 w-full shrink-0 bg-white text-zinc-900 hover:bg-zinc-200 sm:h-10 sm:w-auto"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? "Copied" : "Copy Link"}
            </Button>
          </div>
          {meetingCode !== null && (
            <p className="text-xs text-zinc-500">
              Meeting code:{" "}
              <span className="break-all font-mono text-zinc-300">
                {meetingCode}
              </span>
            </p>
          )}

          {meetingCode !== null && startsAt !== null && (
            <AddToCalendar
              meetingCode={meetingCode}
              title={
                meetingTitle === null || meetingTitle.length === 0
                  ? `${APP_NAME} meeting`
                  : meetingTitle
              }
              startsAt={startsAt}
              endsAt={endsAt}
              tone="dark"
              className="h-10 w-full border-white/15 bg-white/[0.06] text-zinc-200 hover:bg-white/[0.12] hover:text-white"
            />
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-11 w-full text-zinc-300 hover:bg-white/10 hover:text-zinc-100 sm:h-10 sm:w-auto"
          >
            Later
          </Button>
          {lobbyPath !== null && (
            <Button
              asChild
              className="h-11 w-full bg-gradient-to-r from-indigo-500 to-violet-500 text-white hover:from-indigo-400 hover:to-violet-400 sm:h-10 sm:w-auto"
            >
              <Link href={lobbyPath}>
                Join now
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
