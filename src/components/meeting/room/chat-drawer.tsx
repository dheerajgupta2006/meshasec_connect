"use client";

import {
  useChat,
  useDataChannel,
  useRoomContext,
} from "@livekit/components-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Participant, RemoteParticipant } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { ImagePlus, LoaderCircle, Send, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  directCallChatCapability,
  sendDirectCallText,
} from "@/app/meeting/[code]/chat-actions";
import { MessageAttachment } from "@/components/messages/message-attachment";
import { prepareAttachment } from "@/components/messages/prepare-attachment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DIRECT_CALL_CHAT_TOPIC,
  parseDirectCallChatEnvelope,
} from "@/lib/meetings/direct-call-chat";
import { mintCreationRequestId } from "@/lib/meetings/creation-request-id";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  type AttachmentView,
} from "@/lib/messages/attachment-rules";
import type { SentMessageView } from "@/lib/messages/send";
import { cn } from "@/lib/utils";

import { uploadCallImage } from "./upload-call-image";

/** A chat line: either a real message or a locally generated room notice. */
export type ChatEntry =
  | {
      kind: "message";
      id: string;
      timestamp: number;
      author: string;
      body: string;
      attachment: AttachmentView | null;
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
  send: (body: string) => Promise<boolean>;
  sendImage: (file: File, caption: string) => Promise<boolean>;
  imagesEnabled: boolean;
  isSending: boolean;
  unreadCount: number;
  markRead: () => void;
}

const MeetingChatContext =
  React.createContext<MeetingChatContextValue | null>(null);

const MAX_MESSAGE_LENGTH = 2000;
const MAX_SYSTEM_ENTRIES = 100;
const MAX_PERSISTED_ENTRIES = 500;
const MAX_PERSISTED_ID_LENGTH = 128;

function attachmentFrom(value: unknown): AttachmentView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > MAX_PERSISTED_ID_LENGTH ||
    record.kind !== "image" ||
    typeof record.fileName !== "string" ||
    record.fileName.length === 0 ||
    Array.from(record.fileName).length > MAX_FILE_NAME_CHARS ||
    typeof record.mimeType !== "string" ||
    !record.mimeType.startsWith("image/") ||
    typeof record.sizeBytes !== "number" ||
    !Number.isInteger(record.sizeBytes) ||
    record.sizeBytes <= 0 ||
    record.sizeBytes > MAX_ATTACHMENT_BYTES ||
    typeof record.width !== "number" ||
    !Number.isInteger(record.width) ||
    record.width <= 0 ||
    record.width > MAX_IMAGE_SIDE ||
    typeof record.height !== "number" ||
    !Number.isInteger(record.height) ||
    record.height <= 0 ||
    record.height > MAX_IMAGE_SIDE ||
    record.width * record.height > MAX_IMAGE_PIXELS
  ) {
    return null;
  }

  return {
    id: record.id,
    kind: record.kind,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
  };
}

/** Narrows the attachment upload's untrusted JSON response. */
function parseSentMessage(value: unknown): SentMessageView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const attachment = attachmentFrom(record.attachment);

  if (
    typeof record.id !== "string" ||
    typeof record.body !== "string" ||
    typeof record.createdAt !== "string" ||
    attachment === null
  ) {
    return null;
  }

  return {
    id: record.id,
    body: record.body,
    createdAt: record.createdAt,
    outgoing: true,
    editedAt: null,
    deleted: false,
    replyTo: null,
    attachment,
  };
}

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
  meetingCode,
}: {
  children: React.ReactNode;
  meetingCode: string;
}): React.JSX.Element {
  const room = useRoomContext();
  const {
    chatMessages,
    send: sendChat,
    isSending: liveKitSending,
  } = useChat();

  const [systemEntries, setSystemEntries] = React.useState<
    readonly ChatEntry[]
  >([]);
  const [localPersistedEntries, setLocalPersistedEntries] = React.useState<
    readonly ChatEntry[]
  >([]);
  const [serverPersistedEntries, setServerPersistedEntries] = React.useState<
    readonly ChatEntry[]
  >([]);
  const [persistenceBusy, setPersistenceBusy] = React.useState(false);
  const [chatMode, setChatMode] = React.useState<
    "checking" | "persisted" | "ephemeral"
  >("checking");
  const [lastReadAt, setLastReadAt] = React.useState<number>(() => Date.now());
  const sequenceRef = React.useRef(0);
  /** Retained across an uncertain response; changed text gets a fresh key. */
  const pendingTextAttemptRef = React.useRef<{
    body: string;
    clientId: string;
  } | null>(null);
  /** Same for an image the user reselects after a lost upload response. */
  const pendingImageAttemptRef = React.useRef<{
    fingerprint: string;
    clientId: string;
  } | null>(null);

  // This controls presentation only. Every send re-runs server authorization,
  // because the room may expand or end after this read. `checking` fails closed:
  // ordinary participant packets stay hidden until the server says this is an
  // ephemeral room, so a stale client cannot flash an unpersisted message in an
  // eligible direct call.
  const refreshCapability = React.useCallback(async () => {
    try {
      const capability = await directCallChatCapability(meetingCode);
      setChatMode(capability.enabled ? "persisted" : "ephemeral");
    } catch {
      // Keep the current mode. A transient failed read must not downgrade a known
      // direct room to a bypassable participant-chat path.
    }
  }, [meetingCode]);

  React.useEffect(() => {
    let cancelled = false;

    void directCallChatCapability(meetingCode).then((capability) => {
      if (!cancelled) {
        setChatMode(capability.enabled ? "persisted" : "ephemeral");
      }
    }).catch(() => undefined);

    // Backstop for expansion that happens without a participant event reaching
    // this tab. The next send also transitions immediately from its server result.
    const timer = window.setInterval(() => {
      if (!cancelled) {
        void refreshCapability();
      }
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [meetingCode, refreshCapability]);

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
      // A third participant's token stamps expansion before LiveKit admits them.
      // Re-read now so ordinary ephemeral chat becomes visible immediately.
      void refreshCapability();
    }

    function handleDisconnected(participant: RemoteParticipant) {
      const label = nameOf(participant);
      pushSystem(`${label} left the meeting`);
      toast(`${label} left`);
      // ExpandedAt is permanent, but re-reading also covers a call ending while
      // this provider remains mounted during router navigation.
      void refreshCapability();
    }

    room.on(RoomEvent.ParticipantConnected, handleConnected);
    room.on(RoomEvent.ParticipantDisconnected, handleDisconnected);

    return () => {
      room.off(RoomEvent.ParticipantConnected, handleConnected);
      room.off(RoomEvent.ParticipantDisconnected, handleDisconnected);
    };
  }, [refreshCapability, room]);

  const localIdentity = room.localParticipant.identity;

  const onPersistedMessage = React.useCallback(
    (message: { payload: Uint8Array; from?: Participant }) => {
      // Server origin is the authentication. A participant's packet is always
      // stamped with `from`, even if they publish on this topic directly.
      if (message.from !== undefined) {
        return;
      }

      const persisted = parseDirectCallChatEnvelope(message.payload);

      if (persisted === null) {
        return;
      }

      const isLocal = persisted.senderIdentity === localIdentity;
      const sender = isLocal
        ? room.localParticipant
        : room.remoteParticipants.get(persisted.senderIdentity);
      const entry: ChatEntry = {
        kind: "message",
        id: persisted.id,
        timestamp: persisted.timestamp,
        author: sender === undefined ? persisted.senderIdentity : nameOf(sender),
        body: persisted.body,
        attachment: persisted.attachment,
        isLocal,
      };

      setServerPersistedEntries((current) => {
        if (current.some((existing) => existing.id === entry.id)) {
          return current;
        }

        const next = [...current, entry];
        return next.length > MAX_PERSISTED_ENTRIES
          ? next.slice(next.length - MAX_PERSISTED_ENTRIES)
          : next;
      });
    },
    [localIdentity, room],
  );

  useDataChannel(DIRECT_CALL_CHAT_TOPIC, onPersistedMessage);

  const entries = React.useMemo<readonly ChatEntry[]>(() => {
    // Ordinary LiveKit text exists only for meetings where persistence is not
    // eligible. Canonical direct-call messages arrive on the server-only topic.
    const ordinaryMessages: ChatEntry[] =
      chatMode === "ephemeral"
        ? chatMessages.map((message) => ({
            kind: "message" as const,
            id: message.id,
            timestamp: message.timestamp,
            author:
              message.from === undefined ? "Unknown" : nameOf(message.from),
            body: message.message,
            attachment: null,
            isLocal:
              message.from !== undefined &&
              message.from.identity === localIdentity,
          }))
        : [];

    const seen = new Set([
      ...ordinaryMessages.map((entry) => entry.id),
      ...serverPersistedEntries.map((entry) => entry.id),
    ]);
    const localOnly = localPersistedEntries.filter(
      (entry) => !seen.has(entry.id),
    );

    return [
      ...ordinaryMessages,
      ...serverPersistedEntries,
      ...localOnly,
      ...systemEntries,
    ].sort((left, right) => left.timestamp - right.timestamp);
  }, [
    chatMessages,
    chatMode,
    localIdentity,
    localPersistedEntries,
    serverPersistedEntries,
    systemEntries,
  ]);

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

  const showPersistedLocally = React.useCallback(
    (message: SentMessageView, liveDelivered: boolean): void => {
      const entry: ChatEntry = {
        kind: "message",
        id: message.id,
        timestamp: new Date(message.createdAt).getTime(),
        author: nameOf(room.localParticipant),
        body: message.body,
        attachment: message.attachment,
        isLocal: true,
      };

      setLocalPersistedEntries((current) =>
        current.some((existing) => existing.id === entry.id)
          ? current
          : [...current, entry],
      );

      if (!liveDelivered) {
        toast.warning(
          "Saved to your messages, but it was not delivered in the live chat.",
        );
      }
    },
    [room.localParticipant],
  );

  const send = React.useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed.length === 0 || persistenceBusy) {
        return false;
      }

      if (trimmed.length > MAX_MESSAGE_LENGTH) {
        toast.error(`Call messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
        return false;
      }

      setPersistenceBusy(true);

      const previousAttempt = pendingTextAttemptRef.current;
      const clientId =
        previousAttempt?.body === trimmed
          ? previousAttempt.clientId
          : mintCreationRequestId();
      pendingTextAttemptRef.current = { body: trimmed, clientId };

      try {
        const outcome = await sendDirectCallText(
          meetingCode,
          trimmed,
          clientId,
        );

        if (outcome.mode === "failed") {
          toast.error(outcome.message);
          return false;
        }

        if (outcome.mode === "ephemeral") {
          setChatMode("ephemeral");
          await sendChat(trimmed);
          pendingTextAttemptRef.current = null;
          return true;
        }

        if (!outcome.result.ok || outcome.result.sent === null) {
          toast.error(outcome.result.message || "That message could not be saved.");
          return false;
        }

        setChatMode("persisted");
        showPersistedLocally(
          outcome.result.sent,
          outcome.liveDelivered,
        );
        pendingTextAttemptRef.current = null;
        return true;
      } catch {
        toast.error("That message could not be sent.");
        return false;
      } finally {
        setPersistenceBusy(false);
      }
    },
    [meetingCode, persistenceBusy, sendChat, showPersistedLocally],
  );

  const sendImage = React.useCallback(
    async (file: File, caption: string): Promise<boolean> => {
      if (chatMode !== "persisted" || persistenceBusy) {
        return false;
      }

      setPersistenceBusy(true);

      const fingerprint = `${file.name}:${String(file.size)}:${String(
        file.lastModified,
      )}:${caption.trim()}`;
      const previousAttempt = pendingImageAttemptRef.current;
      const clientId =
        previousAttempt?.fingerprint === fingerprint
          ? previousAttempt.clientId
          : mintCreationRequestId();
      pendingImageAttemptRef.current = { fingerprint, clientId };

      try {
        const prepared = await prepareAttachment(file);

        if (!prepared.ok) {
          toast.error(prepared.message);
          return false;
        }

        if (prepared.upload.kind !== "image") {
          toast.error("Only images can be sent from call chat.");
          return false;
        }

        const uploaded = await uploadCallImage({
          meetingCode,
          upload: prepared.upload,
          body: caption.trim(),
          clientId,
        });

        if (!uploaded.ok) {
          toast.error(uploaded.message);
          return false;
        }

        const sent = parseSentMessage(uploaded.sent);

        if (sent === null) {
          toast.error("The server returned an unreadable image message.");
          return false;
        }

        showPersistedLocally(sent, uploaded.liveDelivered);
        pendingImageAttemptRef.current = null;
        return true;
      } finally {
        setPersistenceBusy(false);
      }
    },
    [chatMode, meetingCode, persistenceBusy, showPersistedLocally],
  );

  const isSending = liveKitSending || persistenceBusy;
  const imagesEnabled = chatMode === "persisted";

  const value = React.useMemo<MeetingChatContextValue>(
    () => ({
      entries,
      send,
      sendImage,
      imagesEnabled,
      isSending,
      unreadCount,
      markRead,
    }),
    [entries, imagesEnabled, isSending, markRead, send, sendImage, unreadCount],
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
  const {
    entries,
    send,
    sendImage,
    imagesEnabled,
    isSending,
    markRead,
  } = useMeetingChat();
  const shouldReduceMotion = useReducedMotion() === true;

  const [draft, setDraft] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const imageInputRef = React.useRef<HTMLInputElement | null>(null);

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

    void send(draft).then((sent) => {
      if (sent) {
        setDraft("");
      }
    });
  }

  function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear immediately so selecting the same image after a refusal fires change.
    event.target.value = "";

    if (file === undefined) {
      return;
    }

    void sendImage(file, draft).then((sent) => {
      if (sent) {
        setDraft("");
      }
    });
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
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                        entry.isLocal
                          ? "bg-emerald-500/90 text-zinc-950"
                          : "bg-white/10 text-zinc-100",
                      )}
                    >
                      {entry.body.length > 0 && (
                        <p className="whitespace-pre-wrap break-words">
                          {entry.body}
                        </p>
                      )}
                      {entry.attachment !== null && (
                        <MessageAttachment
                          attachment={entry.attachment}
                          outgoing={entry.isLocal}
                          localUrl={null}
                          progress={null}
                          linkable
                          className={entry.body.length > 0 ? "mt-2" : ""}
                        />
                      )}
                    </div>
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
            {imagesEnabled && (
              <>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*,.heic,.heif,.avif,.bmp,.tif,.tiff"
                  className="sr-only"
                  onChange={handleImageChange}
                  aria-label="Choose an image to send"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={isSending}
                  onClick={() => imageInputRef.current?.click()}
                  aria-label="Send an image"
                  title="Send an image — it will also appear in your direct messages"
                  className="h-10 w-10 shrink-0 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                >
                  {isSending ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                </Button>
              </>
            )}
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
