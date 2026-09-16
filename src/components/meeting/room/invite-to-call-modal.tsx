"use client";

import {
  Check,
  Copy,
  KeyRound,
  Link2,
  LoaderCircle,
  Search,
  UserPlus,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getInviteableFriends,
  inviteFriendToCall,
  type InviteableFriend,
} from "@/app/connections/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { APP_NAME } from "@/lib/brand";
import { formatPasscodeForDisplay } from "@/lib/meetings/passcode";

interface InviteToCallModalProps {
  meetingCode: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TabId = "friends" | "share";

const COPY_FEEDBACK_MS = 2000;

/** Per-friend request state, so one pending invite cannot disable the whole list. */
type InviteState = "idle" | "sending" | "sent" | "failed";

/**
 * Mid-call invitation surface.
 *
 * Two tabs because there are genuinely two different problems: pulling in someone
 * you are already connected to (which can ring their device), and handing a room
 * to someone the app has never heard of (which needs a link plus a passcode).
 */
export function InviteToCallModal({
  meetingCode,
  open,
  onOpenChange,
}: InviteToCallModalProps) {
  const [tab, setTab] = useState<TabId>("friends");
  const [friends, setFriends] = useState<InviteableFriend[]>([]);
  const [passcode, setPasscode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [states, setStates] = useState<Record<string, InviteState>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const outcome = await getInviteableFriends(meetingCode);

    if (!mountedRef.current) {
      return;
    }

    setLoading(false);

    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }

    setFriends(outcome.friends);
    setPasscode(outcome.passcode);
  }, [meetingCode]);

  // Reloaded each time the modal opens rather than once on mount: someone may
  // have joined or been invited since it was last shown.
  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  useEffect(() => {
    if (copied === null) {
      return;
    }

    const timer = window.setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);

    return () => window.clearTimeout(timer);
  }, [copied]);

  const meetingUrl = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return `${window.location.origin}/meeting/${encodeURIComponent(
      meetingCode,
    )}/lobby`;
  }, [meetingCode]);

  const fullInvitation = useMemo(() => {
    const lines = [`You are invited to a ${APP_NAME} meeting.`, ""];

    if (meetingUrl.length > 0) {
      lines.push(`Join: ${meetingUrl}`);
    }

    if (passcode !== null) {
      lines.push(`Room passcode: ${formatPasscodeForDisplay(passcode)}`);
    }

    return lines.join("\n");
  }, [meetingUrl, passcode]);

  const visibleFriends = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (needle.length === 0) {
      return friends;
    }

    return friends.filter((friend) => {
      const name = friend.name?.toLowerCase() ?? "";
      return (
        friend.username.toLowerCase().includes(needle) || name.includes(needle)
      );
    });
  }, [friends, query]);

  async function copy(value: string, label: string): Promise<void> {
    if (value.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setError("We could not copy that. Select the text and copy manually.");
    }
  }

  function invite(friend: InviteableFriend): void {
    setStates((current) => ({ ...current, [friend.id]: "sending" }));
    setError(null);

    void inviteFriendToCall(meetingCode, friend.id).then((outcome) => {
      if (!mountedRef.current) {
        return;
      }

      setStates((current) => ({
        ...current,
        [friend.id]: outcome.ok ? "sent" : "failed",
      }));

      if (!outcome.ok) {
        setError(outcome.message);
      }
    });
  }

  const tabButtonClass = (id: TabId) =>
    `flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      tab === id
        ? "bg-white/[0.12] text-white"
        : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
    }`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-white/10 bg-zinc-900/95 text-zinc-100 backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle>Add people</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Invite a connection directly, or share the link and passcode with
            anyone else.
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1"
          role="tablist"
          aria-label="Invitation method"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "friends"}
            aria-controls="invite-panel-friends"
            id="invite-tab-friends"
            onClick={() => setTab("friends")}
            className={tabButtonClass("friends")}
          >
            <Users className="h-4 w-4" aria-hidden="true" />
            Friends
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "share"}
            aria-controls="invite-panel-share"
            id="invite-tab-share"
            onClick={() => setTab("share")}
            className={tabButtonClass("share")}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Share link
          </button>
        </div>

        {error !== null && (
          <Alert role="alert" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {tab === "friends" ? (
          <div
            id="invite-panel-friends"
            role="tabpanel"
            aria-labelledby="invite-tab-friends"
            className="space-y-3"
          >
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
              />
              <label className="sr-only" htmlFor="invite-search">
                Search your connections
              </label>
              <Input
                id="invite-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connections"
                autoComplete="off"
                className="h-10 border-zinc-700 bg-zinc-950/70 pl-9 text-zinc-100 placeholder:text-zinc-500"
              />
            </div>

            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {loading ? (
                <p className="flex items-center gap-2 py-6 text-sm text-zinc-400">
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  Loading your connections…
                </p>
              ) : visibleFriends.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-400">
                  {friends.length === 0
                    ? "Everyone you are connected with is already here."
                    : "No connections match that search."}
                </p>
              ) : (
                visibleFriends.map((friend) => {
                  const state = states[friend.id] ?? "idle";

                  return (
                    <div
                      key={friend.id}
                      className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2"
                    >
                      <span
                        aria-hidden="true"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo-500/15 text-indigo-300"
                      >
                        <UserRound className="h-4 w-4" />
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-100">
                          {friend.name ?? `@${friend.username}`}
                        </p>
                        <p className="truncate font-mono text-xs text-zinc-500">
                          @{friend.username}
                        </p>
                      </div>

                      <Button
                        type="button"
                        size="sm"
                        variant={state === "sent" ? "secondary" : "outline"}
                        disabled={state === "sending" || state === "sent"}
                        onClick={() => invite(friend)}
                        className="h-9 shrink-0 border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14] hover:text-white"
                        aria-label={`Invite @${friend.username} to this call`}
                      >
                        {state === "sending" ? (
                          <LoaderCircle
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                          />
                        ) : state === "sent" ? (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <UserPlus className="h-4 w-4" aria-hidden="true" />
                        )}
                        {state === "sent" ? "Ringing" : "Invite"}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div
            id="invite-panel-share"
            role="tabpanel"
            aria-labelledby="invite-tab-share"
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-zinc-400"
                htmlFor="invite-url"
              >
                Meeting link
              </label>
              <div className="flex gap-2">
                <Input
                  id="invite-url"
                  readOnly
                  value={meetingUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-10 min-w-0 flex-1 border-zinc-700 bg-zinc-950/70 font-mono text-xs text-zinc-200"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => void copy(meetingUrl, "link")}
                  className="h-10 w-10 shrink-0 border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14]"
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
              <span className="text-xs font-medium text-zinc-400">
                Room passcode
              </span>

              {passcode === null ? (
                <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm text-zinc-400">
                  This room has no passcode, so guests cannot join by link. It was
                  created before passcodes existed.
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <p
                    className="flex h-12 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 font-mono text-xl tracking-[0.2em] text-zinc-50"
                    aria-label={`Room passcode ${passcode.split("").join(" ")}`}
                  >
                    <KeyRound
                      className="h-4 w-4 shrink-0 text-zinc-400"
                      aria-hidden="true"
                    />
                    {formatPasscodeForDisplay(passcode)}
                  </p>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => void copy(passcode, "passcode")}
                    className="h-12 w-12 shrink-0 border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14]"
                    aria-label="Copy the room passcode"
                  >
                    {copied === "passcode" ? (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Copy className="h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                </div>
              )}
            </div>

            <Button
              type="button"
              onClick={() => void copy(fullInvitation, "invitation")}
              className="h-11 w-full bg-gradient-to-r from-indigo-500 to-violet-500 text-white hover:from-indigo-400 hover:to-violet-400"
            >
              {copied === "invitation" ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied === "invitation" ? "Copied" : "Copy full invitation"}
            </Button>

            <p className="text-xs leading-relaxed text-zinc-500">
              Guests still need to sign in, then enter this passcode in the lobby.
              Anyone already in the meeting joins without it.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
