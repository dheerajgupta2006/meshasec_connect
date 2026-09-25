"use client";

import {
  CornerUpLeft,
  LoaderCircle,
  Pencil,
  Reply,
  Send,
  Trash2,
  UserRound,
  Users,
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

import { startGroupCall } from "@/app/dashboard/groups/call-actions";
import {
  deleteGroupMessage,
  editGroupMessage,
  markGroupRead,
  sendGroupMessage,
} from "@/app/dashboard/groups/message-actions";
import { GroupMembersPanel } from "@/components/groups/group-members-panel";
import { LinkPreviewCard } from "@/components/messages/link-preview-card";
import { MessageBody } from "@/components/messages/message-body";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_GROUP_MESSAGE_CHARS } from "@/lib/groups/limits";
import { mintCreationRequestId } from "@/lib/meetings/creation-request-id";
import { previewTarget } from "@/lib/messages/links";
import { cn } from "@/lib/utils";

export interface GroupPersonView {
  id: string;
  username: string;
  name: string | null;
}

export interface GroupMemberSummary extends GroupPersonView {
  role: "OWNER" | "ADMIN" | "MEMBER";
}

export interface GroupQuotedView {
  id: string;
  body: string | null;
  deleted: boolean;
  authorName: string;
}

/**
 * Wire shape of a group message.
 *
 * The editing and quoting fields are optional so a server component may hand over
 * just the base shape; anything missing is filled in by the first poll.
 */
export interface GroupMessageView {
  id: string;
  body: string;
  createdAt: string;
  outgoing: boolean;
  author: GroupPersonView;
  editedAt?: string | null;
  deleted?: boolean;
  replyTo?: GroupQuotedView | null;
}

/** Fully resolved message used for rendering, with no optional fields left. */
interface ThreadItem {
  id: string;
  body: string;
  createdAt: string;
  outgoing: boolean;
  author: GroupPersonView;
  editedAt: string | null;
  deleted: boolean;
  replyTo: GroupQuotedView | null;
  /** Rendered locally and not yet acknowledged by the server. */
  pending?: boolean;
}

interface GroupThreadProps {
  groupId: string;
  groupName: string;
  description: string | null;
  myRole: "OWNER" | "ADMIN" | "MEMBER";
  myUserId: string;
  members: GroupMemberSummary[];
  initialMessages: GroupMessageView[];
}

/** How often to check for new messages while the thread is open. */
const POLL_INTERVAL_MS = 7000;

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

function parsePerson(value: unknown): GroupPersonView | null {
  const record = asRecord(value);

  if (
    record === null ||
    typeof record.id !== "string" ||
    typeof record.username !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    username: record.username,
    name: typeof record.name === "string" ? record.name : null,
  };
}

function parseQuoted(value: unknown): GroupQuotedView | null {
  const record = asRecord(value);

  if (record === null || typeof record.id !== "string") {
    return null;
  }

  return {
    id: record.id,
    body: typeof record.body === "string" ? record.body : null,
    deleted: record.deleted === true,
    authorName:
      typeof record.authorName === "string" ? record.authorName : "Someone",
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

  const author = parsePerson(record.author);

  if (author === null) {
    return null;
  }

  return {
    id: record.id,
    body: record.body,
    createdAt: record.createdAt,
    outgoing: record.outgoing === true,
    author,
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

function normalizeInitial(views: GroupMessageView[]): ThreadItem[] {
  return views.map((view) => ({
    id: view.id,
    body: view.body,
    createdAt: view.createdAt,
    outgoing: view.outgoing,
    author: view.author,
    editedAt: view.editedAt ?? null,
    deleted: view.deleted ?? false,
    replyTo: view.replyTo ?? null,
  }));
}

/**
 * Group chat.
 *
 * Deliberately a close sibling of `MessageThread` rather than a shared abstraction
 * of it: the two differ in three places that run right through the component —
 * every message needs an author label and avatar, reads are a per-group cursor
 * rather than a per-message flag, and there is no translation pipeline here. A
 * shared component would have needed a conditional at each of those points, which
 * is how both surfaces end up hard to change.
 */
export function GroupThread({
  groupId,
  groupName,
  description,
  myRole,
  myUserId,
  members,
  initialMessages,
}: GroupThreadProps) {
  const router = useRouter();

  const [messages, setMessages] = useState<ThreadItem[]>(() =>
    normalizeInitial(initialMessages),
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The pending flag is deliberately discarded: the composer must stay live while
  // a send is in flight, and the bubble itself shows the in-flight state.
  const [, startSending] = useTransition();
  const [isCalling, startCalling] = useTransition();
  const [isMutating, startMutating] = useTransition();

  const [replyTarget, setReplyTarget] = useState<ThreadItem | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const lastIdRef = useRef<string | null>(initialMessages.at(-1)?.id ?? null);
  /** Held across retries of one unsent message; cleared once it commits. */
  const pendingClientIdRef = useRef<string | null>(null);
  /**
   * Rows held on top of whatever the server last returned.
   *
   * Covers a poll that lands while a send is still open, and a poll that was
   * already in flight when the send committed and so returns a payload predating
   * it. Entries are dropped only once the id shows up in a poll.
   */
  const localRowsRef = useRef<ThreadItem[]>([]);
  const pollInFlightRef = useRef(false);
  /** DOM nodes by message id, so a quote can jump to its original. */
  const nodesRef = useRef(new Map<string, HTMLDivElement>());

  const canModerate = myRole === "OWNER" || myRole === "ADMIN";

  const refresh = useCallback(async () => {
    if (pollInFlightRef.current) {
      return;
    }

    pollInFlightRef.current = true;

    try {
      const response = await fetch(
        `/api/groups/${encodeURIComponent(groupId)}/messages`,
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

      // Retire local rows the server now reports, then re-append the rest so a
      // poll can never drop a message the user can already see.
      const known = new Set(next.map((item) => item.id));
      localRowsRef.current = localRowsRef.current.filter(
        (item) => !known.has(item.id),
      );

      const extras = localRowsRef.current;
      setMessages(extras.length === 0 ? next : [...next, ...extras]);

      const newest = next.at(-1) ?? null;
      const newestId = newest?.id ?? null;

      if (newestId !== lastIdRef.current) {
        lastIdRef.current = newestId;

        // Only somebody else's message can be unread. Firing on your own sends
        // would cost a write plus a full tree refetch per message.
        if (newest !== null && !newest.outgoing) {
          await markGroupRead(groupId);
          router.refresh();
        }
      }
    } catch {
      // A failed poll is not worth surfacing; the next tick retries.
    } finally {
      pollInFlightRef.current = false;
    }
  }, [groupId, router]);

  // Clear the unread count for what is already on screen, and pull a full payload
  // straight away: the server component may have handed over the base shape only.
  useEffect(() => {
    void markGroupRead(groupId).then(() => router.refresh());
    void refresh();
  }, [groupId, router, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, POLL_INTERVAL_MS);

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

    if (body.length === 0) {
      return;
    }

    setError(null);

    // Minted once per attempt and reused across retries of the same text, so a
    // double-tap or network retry collapses server-side instead of duplicating.
    const clientId = pendingClientIdRef.current ?? mintCreationRequestId();
    pendingClientIdRef.current = clientId;

    const quoted = replyTarget;
    const optimisticId = `pending:${clientId}`;

    const me = members.find((member) => member.id === myUserId);

    const optimistic: ThreadItem = {
      id: optimisticId,
      body,
      createdAt: new Date().toISOString(),
      outgoing: true,
      author: {
        id: myUserId,
        username: me?.username ?? "you",
        name: me?.name ?? null,
      },
      editedAt: null,
      deleted: false,
      replyTo:
        quoted === null
          ? null
          : {
              id: quoted.id,
              body: quoted.deleted ? null : quoted.body,
              deleted: quoted.deleted,
              authorName:
                quoted.author.name ?? `@${quoted.author.username}`,
            },
      pending: true,
    };

    localRowsRef.current = [...localRowsRef.current, optimistic];
    setMessages((current) => [...current, optimistic]);
    setDraft("");
    setReplyTarget(null);

    startSending(async () => {
      const outcome = await sendGroupMessage(
        groupId,
        body,
        clientId,
        quoted?.id,
      );

      if (!outcome.ok) {
        setError(outcome.message);
        localRowsRef.current = localRowsRef.current.filter(
          (item) => item.id !== optimisticId,
        );
        setMessages((current) =>
          current.filter((item) => item.id !== optimisticId),
        );
        // Hand the text back so it is not lost, but never clobber something typed
        // since. `pendingClientIdRef` stays set, so a retry cannot duplicate.
        setDraft((current) => (current.length === 0 ? body : current));
        return;
      }

      pendingClientIdRef.current = null;

      // A null `sent` means the row committed but could not be read back. Keep the
      // optimistic bubble under its temporary id and let a poll reconcile it.
      const settled: ThreadItem =
        outcome.sent === null
          ? { ...optimistic, pending: false }
          : { ...outcome.sent, pending: false };

      localRowsRef.current = localRowsRef.current.map((item) =>
        item.id === optimisticId ? settled : item,
      );

      setMessages((current) =>
        current.map((item) => (item.id === optimisticId ? settled : item)),
      );
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
      const outcome = await editGroupMessage(id, body);

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
      const outcome = await deleteGroupMessage(id);

      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }

      setConfirmDeleteId(null);
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
      const outcome = await startGroupCall(groupId);

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
    // `dvh` so the composer stays on screen on a phone: with `vh` the card is as
    // tall as the viewport plus the URL bar, which pushes the input below the fold.
    <div className="flex h-[calc(100dvh-10rem)] flex-col rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-3 py-3 sm:px-4">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"
        >
          <Users className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{groupName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {description ?? `${String(members.length)} members`}
          </p>
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setMembersOpen(true)}
          aria-label={`Manage members of ${groupName}`}
        >
          <Users className="h-4 w-4" aria-hidden="true" />
          {members.length}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCall}
          disabled={isCalling}
          aria-label={`Start a call with ${groupName}`}
        >
          {isCalling ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Video className="h-4 w-4" aria-hidden="true" />
          )}
          Call
        </Button>
      </header>

      <div
        className="flex-1 space-y-3 overflow-y-auto px-3 py-5 sm:px-4"
        role="log"
        aria-label={`Messages in ${groupName}`}
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No messages yet. Say hello to the group.
          </p>
        ) : (
          messages.map((message) => {
            const isEditing = editingId === message.id;
            // The author can always change their own. An owner or admin can also
            // delete anyone's, because a group is a shared space — but editing
            // someone else's words is never offered.
            const canEdit = message.outgoing && !message.deleted;
            const canDelete =
              (message.outgoing || canModerate) && !message.deleted;
            const linkTarget = message.deleted
              ? null
              : previewTarget(message.body);

            return (
              <div
                key={message.id}
                ref={(node) => registerNode(message.id, node)}
                className={cn(
                  "group relative flex gap-2",
                  message.outgoing ? "justify-end" : "justify-start",
                )}
              >
                {!message.outgoing && (
                  <span
                    aria-hidden="true"
                    className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
                  >
                    <UserRound className="h-3.5 w-3.5" />
                  </span>
                )}

                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3 py-2 transition-shadow",
                    message.outgoing
                      ? "bg-primary-emphasis text-primary-emphasis-foreground"
                      : "bg-muted text-foreground",
                    highlightId === message.id && "ring-2 ring-ring",
                    message.pending === true && "opacity-60",
                  )}
                >
                  {/* Only shown on incoming messages: a column of your own name
                      above your own words is noise. */}
                  {!message.outgoing && (
                    <p className="mb-0.5 text-xs font-medium opacity-80">
                      {message.author.name ?? `@${message.author.username}`}
                    </p>
                  )}

                  {message.replyTo !== null && (
                    <button
                      type="button"
                      onClick={() => jumpToMessage(message.replyTo?.id ?? "")}
                      disabled={message.replyTo.deleted}
                      className={cn(
                        "mb-1.5 block w-full rounded-lg border-l-2 px-2 py-1 text-left text-xs",
                        message.outgoing
                          ? "border-primary-emphasis-foreground/40 bg-black/10"
                          : "border-foreground/30 bg-foreground/5",
                        message.replyTo.deleted && "cursor-default",
                      )}
                    >
                      <span className="block font-medium opacity-80">
                        {message.replyTo.authorName}
                      </span>
                      <span className="block truncate opacity-70">
                        {message.replyTo.deleted
                          ? DELETED_QUOTE_LABEL
                          : message.replyTo.body}
                      </span>
                    </button>
                  )}

                  {message.deleted ? (
                    <p className="text-sm italic opacity-70">{DELETED_LABEL}</p>
                  ) : isEditing ? (
                    <form
                      onSubmit={(event) => handleEditSubmit(event, message.id)}
                      className="flex items-center gap-1.5"
                    >
                      <label className="sr-only" htmlFor={`edit-${message.id}`}>
                        Edit message
                      </label>
                      <Input
                        id={`edit-${message.id}`}
                        ref={editInputRef}
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onKeyDown={handleEditKeyDown}
                        maxLength={MAX_GROUP_MESSAGE_CHARS}
                        className="h-8 min-w-0 flex-1 text-sm"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={isMutating}
                        className="h-8"
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={cancelEdit}
                        className="h-8"
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <MessageBody
                        body={message.body}
                        outgoing={message.outgoing}
                      />
                      {linkTarget !== null && (
                        <LinkPreviewCard
                          url={linkTarget}
                          outgoing={message.outgoing}
                        />
                      )}
                    </>
                  )}

                  <p className="mt-1 text-[11px] opacity-60">
                    {timeFormatter.format(new Date(message.createdAt))}
                    {message.editedAt !== null && !message.deleted
                      ? " (edited)"
                      : ""}
                  </p>
                </div>

                {/* Absolutely positioned, and `pointer-events-none` until hover:
                    in flow at `opacity-0` this added a band of dead space under
                    every message whose invisible buttons were still clickable. */}
                {!isEditing && !message.deleted && (
                  <div
                    className={cn(
                      "pointer-events-none absolute -top-3 flex items-center gap-1 rounded-lg border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
                      message.outgoing ? "right-2" : "left-9",
                    )}
                  >
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => setReplyTarget(message)}
                      className="h-7 w-7"
                      aria-label="Reply to this message"
                    >
                      <Reply className="h-3.5 w-3.5" />
                    </Button>

                    {canEdit && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => beginEdit(message)}
                        className="h-7 w-7"
                        aria-label="Edit this message"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {canDelete &&
                      (confirmDeleteId === message.id ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={isMutating}
                          onClick={() => handleDelete(message.id)}
                          className="h-7 px-2 text-xs"
                        >
                          Delete?
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => setConfirmDeleteId(message.id)}
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          aria-label="Delete this message"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ))}
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
              {replyTarget.outgoing
                ? "yourself"
                : (replyTarget.author.name ??
                  `@${replyTarget.author.username}`)}
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
        <label className="sr-only" htmlFor="group-message-body">
          Message
        </label>
        <Input
          id="group-message-body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            replyTarget === null ? `Message ${groupName}` : "Write your reply"
          }
          maxLength={MAX_GROUP_MESSAGE_CHARS}
          autoComplete="off"
          className="h-11 min-w-0 flex-1 border-input-strong sm:h-10"
        />
        <Button
          type="submit"
          size="icon"
          disabled={draft.trim().length === 0}
          className="h-11 w-11 shrink-0 sm:h-10 sm:w-10"
          aria-label={replyTarget === null ? "Send message" : "Send reply"}
        >
          <Send className="h-4 w-4" />
        </Button>
      </form>

      <GroupMembersPanel
        open={membersOpen}
        onOpenChange={setMembersOpen}
        groupId={groupId}
        groupName={groupName}
        description={description}
        myRole={myRole}
        myUserId={myUserId}
        members={members}
      />
    </div>
  );
}
