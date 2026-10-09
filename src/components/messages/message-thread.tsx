"use client";

import {
  Check,
  CornerUpLeft,
  LoaderCircle,
  Paperclip,
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
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
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
import { ComposerTranslationBar } from "@/components/messages/composer-translation";
import { LinkPreviewCard } from "@/components/messages/link-preview-card";
import {
  MessageAttachment,
  PendingAttachmentPreview,
} from "@/components/messages/message-attachment";
import { MessageBody } from "@/components/messages/message-body";
import {
  prepareAttachment,
  type PreparedUpload,
} from "@/components/messages/prepare-attachment";
import { TranslatedBody } from "@/components/messages/translated-body";
import { uploadAttachment } from "@/components/messages/upload-attachment";
import { useComposerTranslation } from "@/components/messages/use-composer-translation";
import { TranslationPicker } from "@/components/messages/translation-picker";
import { useThreadTranslation } from "@/components/messages/use-thread-translation";
import { mintCreationRequestId } from "@/lib/meetings/creation-request-id";
import {
  ATTACHMENT_ACCEPT,
  attachmentPreviewText,
  parseAttachmentLabel,
  parseAttachmentView,
  type AttachmentLabelView,
  type AttachmentView,
} from "@/lib/messages/attachment-rules";
import { previewTarget } from "@/lib/messages/links";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface QuotedMessageView {
  id: string;
  /** Null when the quoted message was deleted. */
  body: string | null;
  deleted: boolean;
  outgoing: boolean;
  /** What the original carried, so a photo sent without a caption can be labelled. */
  attachment: AttachmentLabelView | null;
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
  attachment?: AttachmentView | null;
}

/** Fully resolved message used for rendering, with no optional fields left. */
interface ThreadItem {
  id: string;
  /** Empty for an attachment sent without a caption. */
  body: string;
  createdAt: string;
  outgoing: boolean;
  editedAt: string | null;
  deleted: boolean;
  replyTo: QuotedMessageView | null;
  attachment: AttachmentView | null;
  /**
   * Rendered locally and not yet acknowledged by the server.
   *
   * Only ever set on optimistic rows, so a message from the server is never
   * mistaken for one in flight.
   */
  pending?: boolean;
}

/** A file waiting in the composer to be sent. */
interface ComposerAttachment {
  upload: PreparedUpload;
  /** Object URL for a photo's thumbnail, and later its bubble. Null for files. */
  previewUrl: string | null;
  /**
   * Idempotency key, minted when the file is attached and kept with it across
   * retries. Bound to the file rather than the composer, so retrying the same
   * photo after a lost response collapses server-side, while a different file
   * always gets a key of its own.
   */
  clientId: string;
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

/** Prefix of the temporary id an optimistic row carries until the server answers. */
const LOCAL_ID_PREFIX = "pending:";

function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/**
 * One line describing a message, for quotes and the reply bar.
 *
 * A photo sent without a caption has an empty body, which on its own would
 * render as a blank quote.
 */
function previewLine(
  body: string | null,
  attachment: AttachmentLabelView | null,
): string {
  const text = body ?? "";

  if (attachment === null) {
    return text.length > 0 ? text : attachmentPreviewText(null);
  }

  if (text.length === 0) {
    return attachmentPreviewText(attachment);
  }

  return `${attachment.kind === "image" ? "📷" : "📎"} ${text}`;
}

/** The quote an outgoing reply carries, built from the message it answers. */
function quoteOf(target: ThreadItem | null): QuotedMessageView | null {
  if (target === null) {
    return null;
  }

  return {
    id: target.id,
    body: target.deleted ? null : target.body,
    deleted: target.deleted,
    outgoing: target.outgoing,
    attachment:
      target.deleted || target.attachment === null
        ? null
        : { kind: target.attachment.kind, fileName: target.attachment.fileName },
  };
}

function withoutKey<T>(
  record: Partial<Record<string, T>>,
  key: string,
): Partial<Record<string, T>> {
  if (!(key in record)) {
    return record;
  }

  const next = { ...record };
  delete next[key];

  return next;
}

/**
 * Replaces one optimistic row without briefly rendering a duplicate.
 *
 * A poll can see the committed row before the send response reaches the browser.
 * In that case `current` already has the real id alongside the local id, so the
 * local one is removed rather than replaced with a second copy of the real row.
 */
function settleOptimisticRows(
  current: ThreadItem[],
  optimisticId: string,
  settled: ThreadItem,
): ThreadItem[] {
  const realAlreadyPresent =
    settled.id !== optimisticId &&
    current.some((item) => item.id === settled.id);

  if (realAlreadyPresent) {
    return current.filter((item) => item.id !== optimisticId);
  }

  let replaced = false;
  const next: ThreadItem[] = [];

  current.forEach((item) => {
    if (item.id !== optimisticId) {
      next.push(item);
      return;
    }

    // A double submit used to put the same optimistic id in twice. Keep one
    // settled row even if a browser managed to queue that state before the
    // synchronous submit guard ran.
    if (!replaced) {
      next.push(settled);
      replaced = true;
    }
  });

  return replaced ? next : [...next, settled];
}

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
    attachment: parseAttachmentLabel(record.attachment),
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
    attachment: parseAttachmentView(record.attachment),
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
    attachment: view.attachment ?? null,
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
  // The pending flag is deliberately unused: the composer must stay live while a
  // send is in flight, and the bubble itself shows the in-flight state.
  const [, startSending] = useTransition();
  const [isCalling, startCalling] = useTransition();
  const [isMutating, startMutating] = useTransition();

  /** Composer target for a quote, or null for a plain message. */
  const [replyTarget, setReplyTarget] = useState<ThreadItem | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  /** The file waiting to go with the next message, if any. */
  const [composerAttachment, setComposerAttachment] =
    useState<ComposerAttachment | null>(null);
  /** Name of a file still being resized or checked, or null. */
  const [preparingName, setPreparingName] = useState<string | null>(null);
  /** Upload percentage by optimistic row id, while each upload is open. */
  const [uploadProgress, setUploadProgress] = useState<
    Partial<Record<string, number>>
  >({});
  /**
   * Local object URLs for photos while their uploads are still open, keyed by
   * optimistic attachment id. A successful send immediately switches to the
   * authenticated route and revokes the URL, so private blobs cannot accumulate
   * for the lifetime of a long-open thread.
   */
  const [localPreviews, setLocalPreviews] = useState<
    Partial<Record<string, string>>
  >({});
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  /**
   * Reader-side translation. Driven off `messages`, so a translation appears for
   * anything the poll brings in without the send path having to know about it.
   */
  const translation = useThreadTranslation(contactUsername, messages);

  /**
   * Outgoing translation. Unlike `translation` above, this changes what is
   * actually sent, so the composer blocks sending until its preview matches the
   * draft.
   */
  const outgoing = useComposerTranslation(contactUsername, draft);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const lastIdRef = useRef<string | null>(initialMessages.at(-1)?.id ?? null);
  /** Held only when a failed text was restored and can safely reuse its key. */
  const pendingClientIdRef = useRef<string | null>(null);
  /**
   * Rows held on top of whatever the server last returned.
   *
   * Covers two cases that both otherwise make a just-sent message disappear:
   * a poll that lands while the send is still open, and a poll that was already
   * in flight when the send committed and so returns a payload predating it.
   * Entries are dropped only once the id actually shows up in a poll.
   */
  const localRowsRef = useRef<ThreadItem[]>([]);
  const pollInFlightRef = useRef(false);
  /** DOM nodes by message id, so a quote can jump to its original. */
  const nodesRef = useRef(new Map<string, HTMLDivElement>());

  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Mirrors `composerAttachment` for code that runs after an await. */
  const composerAttachmentRef = useRef<ComposerAttachment | null>(null);
  /**
   * Changes whenever the user changes the next message.
   *
   * A failed send restores its text/file only when this still matches the value
   * at send time. Without it, a slow failure could attach an old file to a new
   * caption after the user had already moved on and sent another message.
   */
  const composerRevisionRef = useRef(0);
  /** Same-revision submits are double clicks. Different revisions may send concurrently. */
  const activeComposerRevisionsRef = useRef(new Set<number>());
  /** Bumped on every pick and on cancel, so a slow preparation that lost the race is discarded. */
  const prepareTokenRef = useRef(0);
  /** Every object URL this thread created, so all of them are released on unmount. */
  const objectUrlsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  /** Nested drag-enter count. Each child element fires its own enter and leave. */
  const dragDepthRef = useRef(0);

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

      // Only clear unread when something actually arrived, so the poll does not
      // write to the database on every tick.
      if (newestId !== lastIdRef.current) {
        lastIdRef.current = newestId;

        // Only incoming mail can be unread. This used to fire for your own sends
        // too, costing a write plus a full tree refetch on every message.
        if (newest !== null && !newest.outgoing) {
          await markThreadRead(contactId);
          router.refresh();
        }
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

  // Object URLs pin their blobs in memory until revoked, and a photo can be
  // several megabytes, so leaving the thread releases every one it made.
  useEffect(() => {
    mountedRef.current = true;
    const urls = objectUrlsRef.current;

    return () => {
      mountedRef.current = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

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

  function createPreviewUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);

    return url;
  }

  function revokePreviewUrl(url: string | null): void {
    if (url !== null && objectUrlsRef.current.delete(url)) {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Swaps the composer's attachment.
   *
   * `releasePrevious` is false only when the previous one was just sent: its
   * preview now belongs to the bubble in the thread and must outlive the
   * composer.
   */
  function replaceComposerAttachment(
    next: ComposerAttachment | null,
    releasePrevious: boolean,
  ): void {
    const previous = composerAttachmentRef.current;
    composerAttachmentRef.current = next;
    setComposerAttachment(next);

    if (releasePrevious && previous !== null && previous !== next) {
      revokePreviewUrl(previous.previewUrl);
    }
  }

  /** Marks a deliberate user change, so an older failed send cannot overwrite it. */
  function noteComposerChange(): void {
    composerRevisionRef.current += 1;
    // A restored text's key only describes its exact body and reply. Once the
    // user changes either, this is a new message and needs a new key.
    pendingClientIdRef.current = null;
  }

  function handleDraftChange(event: ChangeEvent<HTMLInputElement>): void {
    noteComposerChange();
    setDraft(event.target.value);
  }

  function chooseReply(message: ThreadItem): void {
    noteComposerChange();
    setReplyTarget(message);
    setConfirmDeleteId(null);
    composerInputRef.current?.focus();
  }

  function cancelReply(): void {
    noteComposerChange();
    setReplyTarget(null);
  }

  function removeComposerAttachment(): void {
    noteComposerChange();
    replaceComposerAttachment(null, true);
  }

  /** Resizes or checks a picked file, then puts it in the composer. */
  async function attachFile(file: File): Promise<boolean> {
    noteComposerChange();
    setError(null);

    const token = prepareTokenRef.current + 1;
    prepareTokenRef.current = token;
    setPreparingName(file.name.length > 0 ? file.name : "file");

    const result = await prepareAttachment(file);

    // Superseded by a newer pick, cancelled, or the thread was closed meanwhile.
    if (token !== prepareTokenRef.current || !mountedRef.current) {
      return false;
    }

    setPreparingName(null);

    if (!result.ok) {
      setError(result.message);
      return false;
    }

    replaceComposerAttachment(
      {
        upload: result.upload,
        previewUrl:
          result.upload.kind === "image"
            ? createPreviewUrl(result.upload.blob)
            : null,
        clientId: mintCreationRequestId(),
      },
      true,
    );

    // Straight to the caption, which is what most people do next.
    composerInputRef.current?.focus();

    return true;
  }

  function cancelPreparing(): void {
    prepareTokenRef.current += 1;
    setPreparingName(null);
  }

  function handleFileChosen(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;

    // Cleared so that choosing the same file again still fires `change`.
    event.target.value = "";

    if (file !== null) {
      void attachFile(file);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const file = event.clipboardData.files[0];

    if (file === undefined) {
      return;
    }

    // Copying from Word or Excel puts a picture of the selection on the clipboard
    // beside the text. Text wins, or pasting a table would attach a screenshot
    // of it instead.
    if (event.clipboardData.getData("text/plain").length > 0) {
      return;
    }

    event.preventDefault();
    void attachFile(file);
  }

  /** Only file drags count; dragging selected text around the page is ignored. */
  function isFileDrag(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFile(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!isFileDrag(event)) {
      return;
    }

    // Without this the browser refuses the drop, and opens the file instead.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    // Some browsers empty `dataTransfer.types` on dragleave. The depth is the
    // reliable evidence that a file drag entered this thread.
    if (dragDepthRef.current === 0) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

    if (dragDepthRef.current === 0) {
      setIsDraggingFile(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (!isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);

    // Read now: the drag data is unavailable once this handler returns.
    const files = event.dataTransfer.files;
    const first = files[0];
    const count = files.length;

    if (first === undefined) {
      return;
    }

    void attachFile(first).then((attached) => {
      if (attached && count > 1) {
        setError(
          `One file goes with each message, so only “${first.name}” was attached.`,
        );
      }
    });
  }

  /** Sends the composer's attachment, with whatever is typed as its caption. */
  function sendAttachment(attachment: ComposerAttachment): void {
    const typed = draft.trim();
    // A caption is optional, and an empty one has nothing to translate, so it is
    // always ready.
    const caption = typed.length === 0 ? "" : outgoing.resolve(typed);

    if (caption === null) {
      return;
    }

    const revisionAtSend = composerRevisionRef.current;

    if (activeComposerRevisionsRef.current.has(revisionAtSend)) {
      return;
    }

    activeComposerRevisionsRef.current.add(revisionAtSend);
    setError(null);

    const { upload, previewUrl, clientId } = attachment;
    const quoted = replyTarget;
    const optimisticId = `${LOCAL_ID_PREFIX}${clientId}`;
    const optimistic: ThreadItem = {
      id: optimisticId,
      body: caption,
      createdAt: new Date().toISOString(),
      outgoing: true,
      editedAt: null,
      deleted: false,
      replyTo: quoteOf(quoted),
      attachment: {
        id: optimisticId,
        kind: upload.kind,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        width: upload.width,
        height: upload.height,
      },
      pending: true,
    };

    localRowsRef.current = [...localRowsRef.current, optimistic];
    setMessages((current) => [...current, optimistic]);
    setUploadProgress((current) => ({ ...current, [optimisticId]: 0 }));

    if (previewUrl !== null) {
      setLocalPreviews((current) => ({ ...current, [optimisticId]: previewUrl }));
    }

    // The preview now belongs to the bubble, so it is handed over, not released.
    replaceComposerAttachment(null, false);
    setDraft("");
    setReplyTarget(null);
    outgoing.reset();

    void uploadAttachment({
      upload,
      recipientId: contactId,
      body: caption,
      clientId,
      replyToId: quoted?.id ?? null,
      onProgress: (percent) => {
        setUploadProgress((current) =>
          current[optimisticId] === undefined
            ? current
            : { ...current, [optimisticId]: percent },
        );
      },
    })
      .catch(() => ({
        ok: false as const,
        message: "The file didn't finish sending. Check your connection and try again.",
      }))
      .then((outcome) => {
        activeComposerRevisionsRef.current.delete(revisionAtSend);

        // Unmounting already released every preview this thread made.
      if (!mountedRef.current) {
        return;
      }

      setUploadProgress((current) => withoutKey(current, optimisticId));

      if (!outcome.ok) {
        setError(outcome.message);
        localRowsRef.current = localRowsRef.current.filter(
          (item) => item.id !== optimisticId,
        );
        setMessages((current) =>
          current.filter((item) => item.id !== optimisticId),
        );
        setLocalPreviews((current) => withoutKey(current, optimisticId));

        // Hand the file, caption and quote back only if the user has not changed
        // the composer since this upload began. Its key is kept, so a retry
        // after a response lost in transit cannot send it twice. If they have
        // moved on, the old photo's object URL is no longer needed.
        if (
          composerRevisionRef.current === revisionAtSend &&
          composerAttachmentRef.current === null
        ) {
          replaceComposerAttachment(attachment, false);
          // `typed`, not the translated caption: handing back a translation
          // would replace the sender's words with a machine rendering of them.
          setDraft(typed);
          setReplyTarget(quoted);
        } else {
          revokePreviewUrl(previewUrl);
        }

        return;
      }

      const parsed = parseMessage(outcome.sent);

      if (parsed === null) {
        // The write may have committed even though its response was malformed.
        // Put the exact operation back with the same key; a retry will resolve
        // the committed winner instead of creating another message.
        setError("The file was sent but could not be confirmed. Try sending it again.");
        localRowsRef.current = localRowsRef.current.filter(
          (item) => item.id !== optimisticId,
        );
        setMessages((current) =>
          current.filter((item) => item.id !== optimisticId),
        );
        setLocalPreviews((current) => withoutKey(current, optimisticId));

        if (
          composerRevisionRef.current === revisionAtSend &&
          composerAttachmentRef.current === null
        ) {
          replaceComposerAttachment(attachment, false);
          setDraft(typed);
          setReplyTarget(quoted);
        } else {
          revokePreviewUrl(previewUrl);
        }

        return;
      }

      const settled: ThreadItem = { ...parsed, pending: false };

      // The authenticated route is now the source. Keeping the object URL would
      // pin the sender's private multi-megabyte blob in memory for as long as the
      // thread stayed open, including after the message was deleted or evicted.
      setLocalPreviews((current) => withoutKey(current, optimisticId));
      revokePreviewUrl(previewUrl);

      localRowsRef.current = settleOptimisticRows(
        localRowsRef.current,
        optimisticId,
        settled,
      );

      setMessages((current) =>
        settleOptimisticRows(current, optimisticId, settled),
      );
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // A file is still being resized. Sending now would either leave it behind or
    // send it without the caption being typed for it.
    if (preparingName !== null) {
      return;
    }

    if (composerAttachment !== null) {
      sendAttachment(composerAttachment);
      return;
    }

    const typed = draft.trim();

    if (typed.length === 0) {
      return;
    }

    // What actually gets sent, which is the translation when the sender chose to
    // send in another language. Null means the preview does not yet match the
    // draft, and sending text the sender has not seen is not acceptable.
    const body = outgoing.resolve(typed);

    if (body === null) {
      return;
    }

    const revisionAtSend = composerRevisionRef.current;

    if (activeComposerRevisionsRef.current.has(revisionAtSend)) {
      return;
    }

    activeComposerRevisionsRef.current.add(revisionAtSend);
    setError(null);

    // A key exists only when this exact text was restored after a failed
    // response. It is removed from the composer as soon as the attempt starts,
    // so the still-live composer can send a second message with a fresh key.
    const clientId = pendingClientIdRef.current ?? mintCreationRequestId();
    pendingClientIdRef.current = null;

    const quoted = replyTarget;

    // Shown before the request leaves, and reconciled when it returns. Waiting on
    // the server meant a round trip to Singapore, a poll, a mark-read and a tree
    // refetch all had to finish before the text appeared — with the composer
    // frozen throughout. The database is still the source of truth; the UI just
    // stops blocking on it.
    const optimisticId = `${LOCAL_ID_PREFIX}${clientId}`;
    const optimistic: ThreadItem = {
      id: optimisticId,
      body,
      createdAt: new Date().toISOString(),
      outgoing: true,
      editedAt: null,
      deleted: false,
      replyTo: quoteOf(quoted),
      attachment: null,
      pending: true,
    };

    localRowsRef.current = [...localRowsRef.current, optimistic];
    setMessages((current) => [...current, optimistic]);
    setDraft("");
    setReplyTarget(null);
    // Drops the preview of the message just sent, so it does not sit under an
    // empty composer.
    outgoing.reset();

    startSending(async () => {
      const outcome = await sendDirectMessage(
        contactId,
        body,
        clientId,
        quoted?.id,
      ).catch(() => ({
        ok: false as const,
        message: "The message could not be sent. Check your connection and try again.",
        sent: null,
      }));

      activeComposerRevisionsRef.current.delete(revisionAtSend);

      if (!mountedRef.current) {
        return;
      }

      if (!outcome.ok) {
        setError(outcome.message);
        localRowsRef.current = localRowsRef.current.filter(
          (item) => item.id !== optimisticId,
        );
        setMessages((current) =>
          current.filter((item) => item.id !== optimisticId),
        );

        // Restore only into a composer the user has not touched since this send.
        // `typed`, not `body`: handing back the translation would replace the
        // sender's own words with a machine rendering of them.
        if (
          composerRevisionRef.current === revisionAtSend &&
          composerAttachmentRef.current === null
        ) {
          pendingClientIdRef.current = clientId;
          setDraft(typed);
          setReplyTarget(quoted);
        }

        return;
      }

      // A null `sent` is retained defensively. The normal server path always
      // returns the committed row, which lets the real id replace this one.
      const settled: ThreadItem =
        outcome.sent === null
          ? { ...optimistic, pending: false }
          : { ...outcome.sent, pending: false };

      localRowsRef.current = settleOptimisticRows(
        localRowsRef.current,
        optimisticId,
        settled,
      );

      setMessages((current) =>
        settleOptimisticRows(current, optimisticId, settled),
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

  function handleEditSubmit(
    event: FormEvent<HTMLFormElement>,
    message: ThreadItem,
  ) {
    event.preventDefault();

    const body = editDraft.trim();

    // An attachment can stand on its own when its caption is removed. A text
    // message cannot be edited into an empty bubble.
    if ((body.length === 0 && message.attachment === null) || isMutating) {
      return;
    }

    setError(null);

    startMutating(async () => {
      const outcome = await editDirectMessage(message.id, body);

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
    // `dvh` so the composer stays on screen on a phone: with `vh` the card is as
    // tall as the viewport *plus* the URL bar, which pushed the input below the
    // fold and left the page and the message log both scrolling independently.
    <div
      className="relative flex h-[calc(100dvh-8rem)] flex-col rounded-xl border bg-card"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingFile && (
        // `pointer-events-none` so the drag keeps targeting the thread beneath,
        // which is what keeps the enter and leave counts balanced.
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/85">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            Drop to attach to your message
          </p>
        </div>
      )}

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
        <TranslationPicker
          status={translation.status}
          target={translation.target}
          progress={translation.progress}
          onChange={translation.setTarget}
        />

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
            // Computed once per message. A deleted body is empty, so there is
            // nothing to preview.
            const linkTarget = message.deleted
              ? null
              : previewTarget(message.body);
            // Null when translation is off, still running, or the model returned
            // the original unchanged.
            const translated = translation.translationFor(message.id);
            const attachment = message.deleted ? null : message.attachment;
            // Empty for a photo or file sent without a caption.
            const hasBody = message.body.length > 0;

            return (
              <div
                key={message.id}
                ref={(node) => {
                  registerNode(message.id, node);
                }}
                className={`group relative flex scroll-mt-6 flex-col ${
                  message.outgoing ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2.5 transition-opacity sm:max-w-[75%] sm:px-4 ${
                    message.outgoing
                      ? "bg-primary-emphasis text-primary-emphasis-foreground"
                      : "bg-muted text-foreground"
                  } ${
                    highlightId === message.id
                      ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                      : ""
                  } ${
                    // An upload shows its own progress; fading the photo under
                    // it as well would make it hard to see what is being sent.
                    message.pending === true && attachment === null
                      ? "opacity-60"
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
                            {previewLine(quoted.body, quoted.attachment)}
                          </span>
                        )}
                      </span>
                    </button>
                  )}

                  {/* Above the caption, and kept on screen while the caption is
                      edited so it is clear what the caption belongs to. */}
                  {attachment !== null && (
                    <MessageAttachment
                      attachment={attachment}
                      outgoing={message.outgoing}
                      localUrl={localPreviews[attachment.id] ?? null}
                      progress={
                        message.pending === true
                          ? (uploadProgress[message.id] ?? null)
                          : null
                      }
                      linkable={!isLocalId(attachment.id)}
                      className={hasBody || isEditing ? "mb-2" : ""}
                    />
                  )}

                  {message.deleted ? (
                    <p className="text-sm italic text-muted-foreground">
                      {DELETED_LABEL}
                    </p>
                  ) : isEditing ? (
                    <form
                      onSubmit={(event) => handleEditSubmit(event, message)}
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
                          disabled={
                            isMutating ||
                            (editDraft.trim().length === 0 &&
                              message.attachment === null)
                          }
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
                    <>
                      {hasBody ? (
                        <MessageBody
                          body={message.body}
                          outgoing={message.outgoing}
                        />
                      ) : attachment === null ? (
                        // An empty body with nothing attached means the file's
                        // details could not be loaded. A label reads better
                        // than an empty bubble.
                        <p className="text-sm italic opacity-80">
                          {attachmentPreviewText(null)}
                        </p>
                      ) : null}

                      {/* Below the original, never in place of it: a reader has
                          to be able to check a confusing translation against
                          what was actually sent. */}
                      {translated !== null && translation.target !== null && (
                        <TranslatedBody
                          text={translated.text}
                          sourceLanguage={translated.sourceLanguage}
                          targetLanguage={translation.target}
                          viaPivot={translated.viaPivot}
                          outgoing={message.outgoing}
                        />
                      )}

                      {/* One card per message, for the first link only. Several
                          cards would dominate the thread. */}
                      {linkTarget !== null && (
                        <LinkPreviewCard
                          url={linkTarget}
                          outgoing={message.outgoing}
                        />
                      )}
                    </>
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

                {/* Not on a row the server has not acknowledged yet: its id is a
                    local placeholder, so replying to it, editing it or deleting
                    it could only fail. */}
                {!isEditing && !message.deleted && !isLocalId(message.id) && (
                  <div
                    // Absolute, not in flow. In flow at `opacity-0` this still
                    // occupied ~32px under every single message, which is what
                    // put a bubble-sized gap between every pair of messages. It
                    // now floats over the 12px `space-y-3` gap and costs no
                    // layout height at all.
                    //
                    // `pointer-events-none` while hidden because an invisible
                    // row of buttons was still clickable: a click in the gap
                    // below a message could fire Reply, Edit or Delete. Keyboard
                    // focus is unaffected by it, so Tab still reaches the buttons
                    // and `focus-within` is what reveals them.
                    //
                    // Pinned to the message's own side so the "Delete?" confirm
                    // expands inward. Expanding outward would overflow the log,
                    // which scrolls on both axes once `overflow-y` is set.
                    className={`pointer-events-none absolute -bottom-3 z-10 flex items-center gap-0.5 rounded-full border bg-card px-1 py-0.5 opacity-0 shadow-sm transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${
                      message.outgoing ? "right-0" : "left-0"
                    }`}
                  >
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => chooseReply(message)}
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
              {replyTarget.deleted
                ? DELETED_QUOTE_LABEL
                : previewLine(replyTarget.body, replyTarget.attachment)}
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={cancelReply}
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-label="Cancel reply"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {preparingName !== null ? (
        <PendingAttachmentPreview
          status="preparing"
          fileName={preparingName}
          onRemove={cancelPreparing}
        />
      ) : composerAttachment !== null ? (
        <PendingAttachmentPreview
          status="ready"
          kind={composerAttachment.upload.kind}
          fileName={composerAttachment.upload.fileName}
          mimeType={composerAttachment.upload.mimeType}
          sizeBytes={composerAttachment.upload.sizeBytes}
          previewUrl={composerAttachment.previewUrl}
          onRemove={removeComposerAttachment}
        />
      ) : null}

      <ComposerTranslationBar
        translation={outgoing}
        hasDraft={draft.trim().length > 0}
      />

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t px-3 py-3 sm:px-4"
      >
        {/* Opened by the paperclip. Paste and drag-and-drop reach the same
            handler, so all three are checked identically. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          onChange={handleFileChosen}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          className="h-11 w-11 shrink-0 text-muted-foreground sm:h-10 sm:w-10"
          aria-label="Attach a photo or file"
          title="Attach a photo or file"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <label className="sr-only" htmlFor="message-body">
          {composerAttachment === null ? "Message" : "Caption"}
        </label>
        <Input
          id="message-body"
          ref={composerInputRef}
          value={draft}
          onChange={handleDraftChange}
          onPaste={handlePaste}
          placeholder={
            composerAttachment !== null
              ? "Add a caption (optional)"
              : replyTarget === null
                ? `Message @${contactUsername}`
                : "Write your reply"
          }
          maxLength={4000}
          autoComplete="off"
          className="h-11 min-w-0 flex-1 border-input-strong sm:h-10"
        />
        <Button
          type="submit"
          size="icon"
          // Blocked while a translation is outstanding: the translated text is
          // what gets sent, so it must be on screen first. Also blocked while a
          // file is still being prepared, so it cannot be left behind.
          disabled={
            preparingName !== null ||
            (composerAttachment === null && draft.trim().length === 0) ||
            !outgoing.isReady
          }
          className="h-11 w-11 shrink-0 sm:h-10 sm:w-10"
          aria-label={
            composerAttachment !== null
              ? "Send attachment"
              : replyTarget === null
                ? "Send message"
                : "Send reply"
          }
        >
          {outgoing.isReady ? (
            <Send className="h-4 w-4" />
          ) : (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          )}
        </Button>
      </form>
    </div>
  );
}
