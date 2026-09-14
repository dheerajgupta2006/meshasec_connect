"use client";

import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  KeyRound,
  LoaderCircle,
  Video,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";

import { createMeetingAction } from "@/app/meeting/new/actions";
import { InviteModal } from "@/components/dashboard/invite-modal";
import { JoinByCode } from "@/components/dashboard/join-by-code";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { mintCreationRequestId } from "@/lib/meetings/creation-request-id";
import { TITLE_MAX_CHARS, type CreationFailure } from "@/lib/meetings/types";
import { hasDisallowedCharacters } from "@/lib/meetings/validation";
import { cn } from "@/lib/utils";

interface QuickActionsProps {
  /** Used to title the instant meeting. Falls back to a generic title. */
  hostName?: string | null;
}

const DEFAULT_INSTANT_TITLE = "Instant meeting";

const CREATE_FAILED_MESSAGE =
  "We could not start your meeting. Check your connection and try again.";

const CREATING_ANNOUNCEMENT = "Starting your instant meeting. Please wait.";
const CREATED_ANNOUNCEMENT =
  "Your meeting is ready. The invite link is available in the dialog.";

/**
 * Titles are validated server-side, so the value sent is kept inside the same
 * rules: trimmed, free of control and format characters, and truncated by code
 * point rather than UTF-16 unit so an astral character cannot split.
 */
function instantTitleFor(hostName: string | null): string {
  const trimmed = (hostName ?? "").trim();

  if (trimmed.length === 0 || hasDisallowedCharacters(trimmed)) {
    return DEFAULT_INSTANT_TITLE;
  }

  return Array.from(`${trimmed}'s instant meeting`)
    .slice(0, TITLE_MAX_CHARS)
    .join("");
}

function failureMessage(failure: CreationFailure): string {
  if (failure.kind === "validation") {
    return failure.formMessage ?? CREATE_FAILED_MESSAGE;
  }
  return failure.message;
}

export function QuickActions({ hostName = null }: QuickActionsProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [failure, setFailure] = useState<CreationFailure | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  // State updates are asynchronous, so state alone can lose a double-click
  // race. This ref flips synchronously.
  const submitLockRef = useRef(false);

  // Held across retries of the same unchanged request so a retry after a failed
  // round trip replays the committed meeting instead of creating a duplicate.
  // Cleared on success, so the next instant meeting gets a fresh identifier.
  const creationRequestIdRef = useRef<string | null>(null);

  const instantTitle = instantTitleFor(hostName);

  async function handleInstantMeeting(): Promise<void> {
    if (submitLockRef.current || isCreating) {
      return;
    }

    submitLockRef.current = true;
    setIsCreating(true);
    setFailure(null);

    try {
      const creationRequestId =
        creationRequestIdRef.current ?? mintCreationRequestId();
      creationRequestIdRef.current = creationRequestId;

      const result = await createMeetingAction({
        title: instantTitle,
        mode: "instant",
        startsAt: null,
        endsAt: null,
        creationRequestId,
      });

      if (result.ok) {
        creationRequestIdRef.current = null;
        setInviteCode(result.result.meetingCode);
        setInviteOpen(true);
      } else {
        setFailure(result.failure);
      }
    } catch {
      // Either the request never reached a server, or this browser exposes no
      // cryptographic random source to mint the request identifier with.
      setFailure({
        kind: "operational",
        message: CREATE_FAILED_MESSAGE,
        correlationId: "",
      });
    } finally {
      submitLockRef.current = false;
      setIsCreating(false);
    }
  }

  const announcement = isCreating
    ? CREATING_ANNOUNCEMENT
    : inviteCode !== null
      ? CREATED_ANNOUNCEMENT
      : "";

  return (
    <section aria-labelledby="quick-actions-heading" className="space-y-4">
      <h2 id="quick-actions-heading" className="sr-only">
        Quick actions
      </h2>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ActionCard
          accent="from-indigo-500/25 via-violet-500/10"
          rule="via-indigo-400/70"
          icon={<Zap className="h-5 w-5" />}
          iconTone="from-indigo-500 to-violet-500"
          title="New Instant Meeting"
          description="Spin up a room now and share the link."
        >
          <Button
            type="button"
            onClick={handleInstantMeeting}
            disabled={isCreating}
            aria-busy={isCreating}
            className="h-11 w-full bg-gradient-to-r from-indigo-500 to-violet-500 text-white hover:from-indigo-400 hover:to-violet-400 sm:h-10"
          >
            {isCreating ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Video className="h-4 w-4" />
                Start now
              </>
            )}
          </Button>
        </ActionCard>

        <ActionCard
          accent="from-sky-500/25 via-cyan-500/10"
          rule="via-sky-400/70"
          icon={<KeyRound className="h-5 w-5" />}
          iconTone="from-sky-500 to-cyan-500"
          title="Join via Code"
          description="Paste an invite link or type the code."
        >
          <JoinByCode />
        </ActionCard>

        <ActionCard
          accent="from-amber-500/25 via-orange-500/10"
          rule="via-amber-400/70"
          icon={<CalendarClock className="h-5 w-5" />}
          iconTone="from-amber-500 to-orange-500"
          title="Schedule for Later"
          description="Pick a time and invite people ahead."
        >
          <Button
            asChild
            variant="outline"
            className="h-11 w-full border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.12] hover:text-white sm:h-10"
          >
            <Link href="/meeting/new">
              Open scheduler
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        </ActionCard>
      </div>

      {failure !== null && (
        <Alert
          role="alert"
          className="border-red-400/30 bg-red-500/10 text-red-100 backdrop-blur [&>svg]:text-red-300"
        >
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {failure.kind === "authorization"
              ? "Sign in to continue"
              : "Meeting not started"}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            <p className="break-words">{failureMessage(failure)}</p>

            {failure.kind === "operational" &&
              failure.correlationId.length > 0 && (
                <p className="text-xs">
                  Reference:{" "}
                  <span className="break-all font-mono">
                    {failure.correlationId}
                  </span>
                </p>
              )}

            {failure.kind === "authorization" && (
              <Button
                asChild
                size="sm"
                variant="outline"
                className="h-11 border-white/20 bg-white/[0.08] text-white hover:bg-white/[0.16] hover:text-white sm:h-9"
              >
                <Link href="/sign-in?redirect_url=/dashboard">Sign in</Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <InviteModal
        meetingCode={inviteCode}
        meetingTitle={instantTitle}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </section>
  );
}

interface ActionCardProps {
  /** Gradient wash for the card body. */
  accent: string;
  /** Gradient stop for the hairline along the top edge. */
  rule: string;
  icon: ReactNode;
  iconTone: string;
  title: string;
  description: string;
  children: ReactNode;
}

function ActionCard({
  accent,
  rule,
  icon,
  iconTone,
  title,
  description,
  children,
}: ActionCardProps) {
  return (
    <div className="relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/60 p-5 backdrop-blur transition-colors hover:border-white/20">
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent",
          accent,
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent",
          rule,
        )}
      />

      <div className="relative flex flex-1 flex-col gap-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white shadow-lg shadow-black/20",
              iconTone,
            )}
          >
            {icon}
          </span>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
            <p className="text-xs leading-relaxed text-zinc-400">
              {description}
            </p>
          </div>
        </div>

        <div className="mt-auto">{children}</div>
      </div>
    </div>
  );
}
