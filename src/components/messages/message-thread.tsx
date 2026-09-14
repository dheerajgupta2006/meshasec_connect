"use client";

import {
  Check,
  CornerUpLeft,
  LoaderCircle,
  Pencil,
  Reply,
  Send,
  Trash2,
  UserRound,
  Video,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { startDirectCall } from "@/app/connections/actions";
import {
  deleteDirectMessage,
  editDirectMessage,
  markThreadRead,
  sendDirectMessage,
} from "@/app/messages/actions";
import { mintCreationRequestId } from "@/lib/meetings/creation-request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface QuotedMessageView {
  id: string;
  /** Null when the quoted message was deleted. */
  body: string | null;
  deleted: boolean;
  outgoing: boolean;
}

/**
 * Wire shape of a thread message.
 *
 * The editing and quoting fields are optional so a server component may hand
 * over just the base shape; anything missing is filled in by the first poll.
 */
export interface ThreadMessageView {
  id: string;
  body: string;
  createdAt: string;
  outgoing: boolean;
  editedAt?: string | null;
  deleted?: boolean;
  replyTo?: QuotedMessageView | null;
}

/** Fully resolved message used for rendering, with no optional fields left. */
interface ThreadItem {
  id: string;
  body: string;
  createdAt: string;
  outgoing: boolean;
  editedAt: string | null;
  deleted: boolean;
  replyTo: QuotedMessageView | null;
}

interface MessageThreadProps {
  contactId: string;
  contactUsername: string;
  contactName: string | null;
  initialMessages: ThreadMessageView[];
}

/**
 * How often to check for new messages while the thread is open. Each tick is a
 * database round trip, so this trades a little latency for pool headroom.
 */
const POLL_INTERVAL_MS = 7000;

/** How long a jumped-to message stays highlighted. */
const HIGHLIGHT_MS = 1600;

const DELETED_LABEL = "This message was deleted";
const DELETED_QUOTE_LABEL = "Original message deleted";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseQuoted(value: unknown): QuotedMessageView | null {
  const record = asRecord(value);

  if (record === null || typeof record.id !== "string") {
    return null;
  }

  return {
    id: record.id,
    body: typeof record.body === "string" ? record.body : null,
    deleted: record.deleted === true,
    outgoing: record.outgoing === true,
  };
}

function parseMessage(value: unknown): ThreadItem | null {
  const record = asRecord(value);

  if (
    record === null ||
    typeof record.id !== "string" ||
    typeof record.body !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    body: record.body,
    createdAt: record.createdAt,
    outgoing: record.outgoing === true,
    editedAt: typeof record.editedAt === "string" ? record.editedAt : null,
    deleted: record.deleted === true,
    replyTo: parseQuoted(record.replyTo),
  };
}

/** Narrows the poll response without trusting its shape. */
function parseMessages(payload: unknown): ThreadItem[] | null {
  const record = asRecord(payload);

  if (record === null || !Array.isArray(record.messages)) {
    return null;
  }

  const items: ThreadItem[] = [];

  record.messages.forEach((entry: unknown) => {
    const parsed = parseMessage(entry);

    if (parsed !== null) {
      items.push(parsed);
    }
  });

  return items;
}

function normalizeInitial(views: ThreadMessageView[]): ThreadItem[] {
  return views.map((view) => ({
    id: view.id,
    body: view.body,
    createdAt: view.createdAt,
    outgoing: view.outgoing,
    editedAt: view.editedAt ?? null,
    deleted: view.deleted ?? false,
    replyTo: view.replyTo ?? null,
  }));
}

export function MessageThread({
  contactId,
  contactUsername,
  contactName,
  initialMessages,
}: MessageThreadProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<ThreadItem[]>(() =>
    normalizeInitial(initialMessages),
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSending, startSending] = useTransition();
  const [isCalling, startCalling] = useTransition();
  const [isMutating, startMutating] = useTransition();

  /** Composer target for a quote, or null for a plain message. */
  const [replyTarget, setReplyTarget] = useState<ThreadItem | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const lastIdRef = useRef<string | null>(initialMessages.at(-1)?.id ?? null);
  /** Held across retries of one unsent message; cleared once it commits. */
  const pendingClientIdRef = useRef<string | null>(null);
  const pollInFlightRef = useRef(false);
  /** DOM nodes by message id, so a quote can jump to its original. */
  const nodesRef = useRef(new Map<string, HTMLDivElement>());

  const refresh = useCallback(async () => {
    // Skip while a previous poll is still open, and while the tab is hidden:
    // overlapping requests are what exhaust the connection pool.
    if (pollInFlightRef.current) {
      return;
    }

    pollInFlightRef.current = true;

    try {
      const response = await fetch(
        `/api/messages/${encodeURIComponent(contactUsername)}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        return;
      }

      const payload: unknown = await response.json();
      const next = parseMessages(payload);

      if (next === null) {
        return;
      }

      setMessages(next);

      const newestId = next.at(-1)?.id ?? null;

      // Only clear unread when something actually arrived, so the poll does not
      // write to the database on every tick.
      if (newestId !== lastIdRef.current) {
        lastIdRef.current = newestId;
        await markThreadRead(contactId);
        router.refresh();
      }
    } catch {
      // A failed poll is not worth surfacing; the next tick retries.
    } finally {
      pollInFlightRef.current = false;
    }
  }, [contactUsername, contactId, router]);

  // Clear the unread badge for messages already on screen when the thread opens,
  // and pull a full payload straight away: the server component may have handed
  // over the base shape without edit, delete or quote metadata.
  useEffect(() => {
    void markThreadRead(contactId).then(() => router.refresh());
    void refresh();
  }, [contactId, router, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, POLL_INTERVAL_MS);

    // Catch up immediately when the tab comes back rather than waiting a tick.
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (editingId !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  useEffect(() => {
    if (highlightId === null) {
      return;
    }

    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);

    return () => window.clearTimeout(timer);
  }, [highlightId]);

  function registerNode(id: string, node: HTMLDivElement | null): void {
    if (node === null) {
      nodesRef.current.delete(id);
      return;
    }

    nodesRef.current.set(id, node);
  }

  function jumpToMessage(id: string): void {
    const node = nodesRef.current.get(id);

    if (node === undefined) {
      return;
    }

    node.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightId(id);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const body = draft.trim();

    if (body.length === 0 || isSending) {
      return;
    }

    setError(null);

    // Minted once per attempt and reused across retries of the same text, so a
    // double-tap or network retry collapses server-side instead of duplicating.
    const clientId = pendingClientIdRef.current ?? mintCreationRequestId();
    pendingClientIdRef.current = clientId;

    const quotedId = replyTarget?.id;

    startSending(async () => {
      const outcome = await sendDirectMessage(
        contactId,
        body,
        clientId,
        quotedId,
      );

      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }

      pendingClientIdRef.current = null;
      setDraft("");
      setReplyTarget(null);
      await refresh();
    });
  }

  function beginEdit(message: ThreadItem) {
    setError(null);
    setConfirmDeleteId(null);
    setEditingId(message.id);
    setEditDraft(message.body);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
  }

  function handleEditSubmit(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();

    const body = editDraft.trim();

    if (body.length === 0 || isMutating) {
      return;
    }

    setError(null);

    startMutating(async () => {
      const outcome = await editDirectMessage(id, body);

      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }

      cancelEdit();
      await refresh();
    });
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  }

  function handleDelete(id: string) {
    if (isMutating) {
      return;
    }

    setError(null);

    startMutating(async () => {
      const outcome = await deleteDirectMessage(id);

      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }

      setConfirmDeleteId(null);

      // A deleted message cannot stay open for editing, and its quote in the
      // composer would now be pointless.
      setEditingId((current) => (current === id ? null : current));
      setReplyTarget((current) => (current?.id === id ? null : current));
      await refresh();
    });
  }

  function handleCall() {
    if (isCalling) {
      return;
    }

    setError(null);

    startCalling(async () => {
      const outcome = await startDirectCall(contactId);

      if (outcome.ok && outcome.meetingCode !== null) {
        router.push(
          `/meeting/${encodeURIComponent(outcome.meetingCode)}/lobby`,
        );
        return;
      }

      setError(outcome.message);
    });
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-3 py-3 sm:px-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <UserRound className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {contactName ?? `@${contactUsername}`}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            @{contactUsername}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCall}
          disabled={isCalling}
          aria-label={`Start a call with @${contactUsername}`}
        >
          {isCalling ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Video className="h-4 w-4" />
          )}
          Call
        </Button>
      </header>

      <div
        className="flex-1 space-y-3 overflow-y-auto px-3 py-5 sm:px-4"
        role="log"
        aria-label={`Conversation with @${contactUsername}`}
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No messages yet. Say hello.
          </p>
        ) : (
          messages.map((message) => {
            const isEditing = editingId === message.id;
            const canModify = message.outgoing && !message.deleted;
            const quoted = message.replyTo;

            return (
              <div
                key={message.id}
                ref={(node) => {
                  registerNode(message.id, node);
                }}
                className={`group flex scroll-mt-6 flex-col ${
                  message.outgoing ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2.5 transition-shadow sm:max-w-[75%] sm:px-4 ${
                    message.outgoing
                      ? "bg-primary-emphasis text-primary-emphasis-foreground"
                      : "bg-muted text-foreground"
                  } ${
                    highlightId === message.id
                      ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                      : ""
                  }`}
                >
                  {quoted !== null && (
                    <button
                      type="button"
                      onClick={() => jumpToMessage(quoted.id)}
                      disabled={quoted.deleted}
                      className={`mb-2 flex w-full items-start gap-1.5 rounded-lg border-l-2 px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-default ${
                        message.outgoing
                          ? "border-primary-emphasis-foreground/50 bg-black/10 text-primary-emphasis-foreground/85 hover:bg-black/20"
                          : "border-foreground/25 bg-foreground/5 text-muted-foreground hover:bg-foreground/10"
                      }`}
                      aria-label={
                        quoted.deleted
                          ? DELETED_QUOTE_LABEL
                          : "Go to the quoted message"
                      }
                    >
                      <CornerUpLeft className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">
                          {quoted.outgoing ? "You" : `@${contactUsername}`}
                        </span>
                        {quoted.deleted ? (
                          <span className="block italic opacity-80">
                            {DELETED_QUOTE_LABEL}
                          </span>
                        ) : (
                          <span className="line-clamp-2 block break-words">
                            {quoted.body}
                          </span>
                        )}
                      </span>
                    </button>
                  )}

                  {message.deleted ? (
                    <p className="text-sm italic text-muted-foreground">
                      {DELETED_LABEL}
                    </p>
                  ) : isEditing ? (
                    <form
                      onSubmit={(event) => handleEditSubmit(event, message.id)}
                      className="flex flex-col gap-2"
                    >
                      <label
                        className="sr-only"
                        htmlFor={`edit-${message.id}`}
                      >
                        Edit message
                      </label>
                      <Input
                        id={`edit-${message.id}`}
                        ref={editInputRef}
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onKeyDown={handleEditKeyDown}
                        maxLength={4000}
                        autoComplete="off"
                        disabled={isMutating}
                        className="h-9 border-input-strong bg-background text-foreground"
                      />
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={cancelEdit}
                          disabled={isMutating}
                          className="h-8 px-2 text-xs"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          variant="secondary"
                          disabled={isMutating || editDraft.trim().length === 0}
                          className="h-8 px-2 text-xs"
                        >
                          {isMutating ? (
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          Save
                        </Button>
                      </div>
                      <p
                        className={`text-[10px] ${
                          message.outgoing
                            ? "text-primary-emphasis-foreground/70"
                            : "text-muted-foreground"
                        }`}
                      >
                        Press Escape to cancel.
                      </p>
                    </form>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {message.body}
                    </p>
                  )}

                  <p
                    className={`mt-1 text-[10px] ${
                      message.outgoing
                        ? "text-primary-emphasis-foreground/70"
                        : "text-muted-foreground"
                    }`}
                  >
                    {timeFormatter.format(new Date(message.createdAt))}
                    {message.editedAt !== null && !message.deleted && (
                      <span className="ml-1">(edited)</span>
                    )}
                  </p>
                </div>

                {!isEditing && !message.deleted && (
                  <div
                    className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    // Hidden actions must not be clickable while invisible, but
                    // Tab still reaches them, which is what reveals them.
                    style={{ pointerEvents: "auto" }}
                  >
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setReplyTarget(message);
                        setConfirmDeleteId(null);
                      }}
                      className="h-7 w-7 text-muted-foreground"
                      aria-label="Reply to this message"
                    >
                      <Reply className="h-3.5 w-3.5" />
                    </Button>

                    {canModify && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => beginEdit(message)}
                        className="h-7 w-7 text-muted-foreground"
                        aria-label="Edit this message"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {canModify && confirmDeleteId !== message.id && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => setConfirmDeleteId(message.id)}
                        className="h-7 w-7 text-muted-foreground hover:text-destructive-text"
                        aria-label="Delete this message"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {canModify && confirmDeleteId === message.id && (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        Delete?
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDelete(message.id)}
                          disabled={isMutating}
                          className="h-7 px-2 text-[11px]"
                        >
                          {isMutating ? (
                            <LoaderCircle className="h-3 w-3 animate-spin" />
                          ) : null}
                          Yes
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDeleteId(null)}
                          className="h-7 px-2 text-[11px]"
                        >
                          No
                        </Button>
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {error !== null && (
        <div className="px-3 pb-3 sm:px-4">
          <Alert role="alert" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      {replyTarget !== null && (
        <div className="flex items-start gap-2 border-t bg-muted/40 px-3 py-2 sm:px-4">
          <CornerUpLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-medium">
              Replying to{" "}
              {replyTarget.outgoing ? "yourself" : `@${contactUsername}`}
            </p>
            <p className="truncate text-muted-foreground">
              {replyTarget.deleted ? DELETED_QUOTE_LABEL : replyTarget.body}
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setReplyTarget(null)}
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-label="Cancel reply"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t px-3 py-3 sm:px-4"
      >
        <label className="sr-only" htmlFor="message-body">
          Message
        </label>
        <Input
          id="message-body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            replyTarget === null
              ? `Message @${contactUsername}`
              : "Write your reply"
          }
          maxLength={4000}
          autoComplete="off"
          disabled={isSending}
          className="h-11 min-w-0 flex-1 border-input-strong sm:h-10"
        />
        <Button
          type="submit"
          size="icon"
          disabled={isSending || draft.trim().length === 0}
          className="h-11 w-11 shrink-0 sm:h-10 sm:w-10"
          aria-label={replyTarget === null ? "Send message" : "Send reply"}
        >
          {isSending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
