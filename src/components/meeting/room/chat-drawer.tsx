"use client";

import { useChat, useRoomContext } from "@livekit/components-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { RemoteParticipant } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { Send, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A chat line: either a real message or a locally generated room notice. */
export type ChatEntry =
  | {
      kind: "message";
      id: string;
      timestamp: number;
      author: string;
      body: string;
      isLocal: boolean;
    }
  | {
      kind: "system";
      id: string;
      timestamp: number;
      body: string;
    };

interface MeetingChatContextValue {
  entries: readonly ChatEntry[];
  send: (body: string) => void;
  isSending: boolean;
  unreadCount: number;
  markRead: () => void;
}

const MeetingChatContext =
  React.createContext<MeetingChatContextValue | null>(null);

const MAX_MESSAGE_LENGTH = 2000;
const MAX_SYSTEM_ENTRIES = 100;

function nameOf(participant: {
  name?: string;
  identity: string;
}): string {
  const name = participant.name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }
  return participant.identity;
}

/**
 * Merges LiveKit chat with locally derived join/leave notices, and tracks how
 * many lines the user has not seen yet.
 */
export function MeetingChatProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const room = useRoomContext();
  const { chatMessages, send: sendChat, isSending } = useChat();

  const [systemEntries, setSystemEntries] = React.useState<
    readonly ChatEntry[]
  >([]);
  const [lastReadAt, setLastReadAt] = React.useState<number>(() => Date.now());
  const sequenceRef = React.useRef(0);

  React.useEffect(() => {
    function pushSystem(body: string) {
      sequenceRef.current += 1;
      const entry: ChatEntry = {
        kind: "system",
        id: `system:${sequenceRef.current}`,
        timestamp: Date.now(),
        body,
      };
      setSystemEntries((current) => {
        const next = [...current, entry];
        return next.length > MAX_SYSTEM_ENTRIES
          ? next.slice(next.length - MAX_SYSTEM_ENTRIES)
          : next;
      });
    }

    function handleConnected(participant: RemoteParticipant) {
      const label = nameOf(participant);
      pushSystem(`${label} joined the meeting`);
      toast.success(`${label} joined`);
    }

    function handleDisconnected(participant: RemoteParticipant) {
      const label = nameOf(participant);
      pushSystem(`${label} left the meeting`);
      toast(`${label} left`);
    }

    room.on(RoomEvent.ParticipantConnected, handleConnected);
    room.on(RoomEvent.ParticipantDisconnected, handleDisconnected);

    return () => {
      room.off(RoomEvent.ParticipantConnected, handleConnected);
      room.off(RoomEvent.ParticipantDisconnected, handleDisconnected);
    };
  }, [room]);

  const localIdentity = room.localParticipant.identity;

  const entries = React.useMemo<readonly ChatEntry[]>(() => {
    const messages: ChatEntry[] = chatMessages.map((message) => {
      const from = message.from;
      return {
        kind: "message",
        id: message.id,
        timestamp: message.timestamp,
        author: from === undefined ? "Unknown" : nameOf(from),
        body: message.message,
        isLocal: from !== undefined && from.identity === localIdentity,
      };
    });

    return [...messages, ...systemEntries].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
  }, [chatMessages, localIdentity, systemEntries]);

  const unreadCount = React.useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.timestamp > lastReadAt &&
          !(entry.kind === "message" && entry.isLocal),
      ).length,
    [entries, lastReadAt],
  );

  const markRead = React.useCallback(() => {
    setLastReadAt(Date.now());
  }, []);

  const send = React.useCallback(
    (body: string) => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      void sendChat(trimmed.slice(0, MAX_MESSAGE_LENGTH)).catch(() => {
        toast.error("That message could not be sent");
      });
    },
    [sendChat],
  );

  const value = React.useMemo<MeetingChatContextValue>(
    () => ({ entries, send, isSending, unreadCount, markRead }),
    [entries, isSending, markRead, send, unreadCount],
  );

  return (
    <MeetingChatContext.Provider value={value}>
      {children}
    </MeetingChatContext.Provider>
  );
}

export function useMeetingChat(): MeetingChatContextValue {
  const context = React.useContext(MeetingChatContext);
  if (context === null) {
    throw new Error("useMeetingChat must be used inside a MeetingChatProvider");
  }
  return context;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface ChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

/** Slide-over chat panel. Escape closes it; the newest line is always visible. */
export function ChatDrawer({
  open,
  onClose,
}: ChatDrawerProps): React.JSX.Element {
  const { entries, send, isSending, markRead } = useMeetingChat();
  const shouldReduceMotion = useReducedMotion() === true;

  const [draft, setDraft] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  React.useEffect(() => {
    if (open) {
      markRead();
    }
  }, [entries.length, markRead, open]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const node = scrollRef.current;
    if (node === null) {
      return;
    }
    node.scrollTo({
      top: node.scrollHeight,
      behavior: shouldReduceMotion ? "auto" : "smooth",
    });
  }, [entries.length, open, shouldReduceMotion]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send(draft);
    setDraft("");
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          role="dialog"
          aria-label="Meeting chat"
          initial={{ x: shouldReduceMotion ? 0 : "100%", opacity: shouldReduceMotion ? 0 : 1 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: shouldReduceMotion ? 0 : "100%", opacity: shouldReduceMotion ? 0 : 1 }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 320, damping: 34 }
          }
          className="absolute inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-white/10 bg-zinc-950/95 text-zinc-100 shadow-2xl backdrop-blur-xl"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold tracking-tight">Chat</h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close chat"
              className="h-8 w-8 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </header>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
          >
            {entries.length === 0 ? (
              <p className="pt-6 text-center text-sm text-zinc-500">
                No messages yet. Say hello.
              </p>
            ) : (
              entries.map((entry) =>
                entry.kind === "system" ? (
                  <p
                    key={entry.id}
                    className="text-center text-xs text-zinc-500"
                  >
                    {entry.body}
                  </p>
                ) : (
                  <div
                    key={entry.id}
                    className={cn(
                      "flex flex-col gap-1",
                      entry.isLocal ? "items-end" : "items-start",
                    )}
                  >
                    <span className="flex items-baseline gap-2 text-[11px] text-zinc-500">
                      <span className="font-medium text-zinc-400">
                        {entry.isLocal ? "You" : entry.author}
                      </span>
                      <time dateTime={new Date(entry.timestamp).toISOString()}>
                        {formatTime(entry.timestamp)}
                      </time>
                    </span>
                    <p
                      className={cn(
                        "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm",
                        entry.isLocal
                          ? "bg-emerald-500/90 text-zinc-950"
                          : "bg-white/10 text-zinc-100",
                      )}
                    >
                      {entry.body}
                    </p>
                  </div>
                ),
              )
            )}
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-3"
          >
            <label htmlFor="meeting-chat-input" className="sr-only">
              Message
            </label>
            <Input
              id="meeting-chat-input"
              ref={inputRef}
              value={draft}
              maxLength={MAX_MESSAGE_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Send a message"
              autoComplete="off"
              className="h-10 border-white/15 bg-white/5 text-sm text-zinc-100 placeholder:text-zinc-500"
            />
            <Button
              type="submit"
              size="icon"
              disabled={isSending || draft.trim().length === 0}
              aria-label="Send message"
              className="h-10 w-10 shrink-0 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
