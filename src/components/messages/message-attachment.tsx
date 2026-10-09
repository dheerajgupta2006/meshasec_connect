"use client";

/**
 * How an attachment looks in the thread and in the composer.
 *
 * Photos render inline at their own aspect ratio, with the space reserved from
 * the stored dimensions so the thread does not jump as they load. Everything
 * else is a card that downloads the file. Both point at the attachment route,
 * which re-checks access on every request; nothing here grants access by itself.
 */

import {
  Download,
  FileArchive,
  FileImage,
  FileMusic,
  FileText,
  FileVideoCamera,
  ImageOff,
  LoaderCircle,
  Mic,
  X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  attachmentUrl,
  fileTypeFor,
  fitWithinBox,
  formatBytes,
  isVoiceMessageAttachment,
  type AttachmentKind,
  type AttachmentView,
} from "@/lib/messages/attachment-rules";

/** Largest box a photo takes up in the thread, in CSS pixels. */
const THREAD_IMAGE_MAX_WIDTH = 280;
const THREAD_IMAGE_MAX_HEIGHT = 320;

function displayBox(attachment: AttachmentView): { width: number; height: number } {
  if (attachment.width === null || attachment.height === null) {
    return {
      width: THREAD_IMAGE_MAX_WIDTH,
      height: Math.round(THREAD_IMAGE_MAX_WIDTH * 0.75),
    };
  }

  return fitWithinBox(
    attachment.width,
    attachment.height,
    THREAD_IMAGE_MAX_WIDTH,
    THREAD_IMAGE_MAX_HEIGHT,
  );
}

/** Short type label for a file card: "PDF", "Word", "Audio". */
function typeLabel(fileName: string, kind: AttachmentKind): string {
  if (isVoiceMessageAttachment({ kind, fileName })) {
    return "Voice";
  }

  return fileTypeFor(fileName)?.label ?? (kind === "image" ? "Photo" : "File");
}

function AttachmentIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  const Icon = mimeType.startsWith("audio/")
    ? FileMusic
    : mimeType.startsWith("video/")
      ? FileVideoCamera
      : mimeType.startsWith("image/")
        ? FileImage
        : mimeType === "application/zip"
          ? FileArchive
          : FileText;

  return <Icon className={className} aria-hidden="true" />;
}

interface MessageAttachmentProps {
  attachment: AttachmentView;
  outgoing: boolean;
  /**
   * Object URL of an image or audio recording while this tab is uploading it.
   * Null after acknowledgement, when the authenticated route becomes the source.
   */
  localUrl: string | null;
  /** Upload progress, 0 to 100, while it is still being sent; otherwise null. */
  progress: number | null;
  /**
   * False until the server has acknowledged the message. Until then the id is a
   * local placeholder and there is nothing to link to.
   */
  linkable: boolean;
  className?: string;
}

function ImageAttachment({
  attachment,
  localUrl,
  progress,
  linkable,
  className = "",
}: MessageAttachmentProps) {
  const [failed, setFailed] = useState(false);
  const box = displayBox(attachment);
  const src = localUrl ?? (linkable ? attachmentUrl(attachment.id) : null);

  if (failed || src === null) {
    return (
      <div
        role="img"
        aria-label="Photo unavailable"
        className={`grid place-items-center rounded-xl bg-black/10 text-xs ${className}`}
        style={{
          width: box.width,
          maxWidth: "100%",
          aspectRatio: `${box.width} / ${box.height}`,
        }}
      >
        <span className="flex flex-col items-center gap-1 opacity-80">
          <ImageOff className="h-5 w-5" aria-hidden="true" />
          Photo unavailable
        </span>
      </div>
    );
  }

  const image = (
    // A plain <img>: the route is authenticated per request and serves private
    // bytes, which `next/image` would route through its shared optimiser cache.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Photo"
      width={box.width}
      height={box.height}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      // `width` and `height` above give the browser the aspect ratio before the
      // image arrives, so `h-auto` reserves exactly the right space.
      className="block h-auto max-w-full bg-black/10 object-cover"
      style={{ width: box.width }}
    />
  );

  if (progress !== null) {
    return (
      <div className={`relative w-fit max-w-full overflow-hidden rounded-xl ${className}`}>
        {image}
        <div
          role="progressbar"
          aria-label="Sending photo"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="absolute inset-0 grid place-items-center bg-black/35 text-white"
        >
          {/* Hidden from assistive technology: the thread is a live region, and
              a changing percentage inside it would be read out on every tick.
              The progressbar's value carries the same information silently. */}
          <span
            aria-hidden="true"
            className="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium tabular-nums"
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {progress < 100 ? `${progress}%` : "Finishing"}
          </span>
        </div>
      </div>
    );
  }

  if (!linkable) {
    return (
      <div className={`w-fit max-w-full overflow-hidden rounded-xl ${className}`}>
        {image}
      </div>
    );
  }

  return (
    <a
      href={attachmentUrl(attachment.id)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open photo in a new tab"
      className={`block w-fit max-w-full overflow-hidden rounded-xl transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${className}`}
    >
      {image}
    </a>
  );
}

function AudioAttachment({
  attachment,
  outgoing,
  localUrl,
  progress,
  linkable,
  className = "",
}: MessageAttachmentProps) {
  const [failed, setFailed] = useState(false);
  const src = localUrl ?? (linkable ? attachmentUrl(attachment.id) : null);
  const voiceMessage = isVoiceMessageAttachment(attachment);
  const title = voiceMessage ? "Voice message" : attachment.fileName;
  const detail = `${voiceMessage ? "Voice recording" : "Audio"} · ${formatBytes(
    attachment.sizeBytes,
  )}`;
  const mutedText = outgoing
    ? "text-primary-emphasis-foreground/75"
    : "text-muted-foreground";

  return (
    <div
      className={`w-[280px] max-w-full rounded-xl border px-3 py-2.5 ${
        outgoing
          ? "border-primary-emphasis-foreground/25 bg-black/15"
          : "border-foreground/15 bg-foreground/[0.04]"
      } ${className}`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            outgoing ? "bg-black/15" : "bg-background"
          }`}
        >
          {voiceMessage ? (
            <Mic className="h-4 w-4" aria-hidden="true" />
          ) : (
            <FileMusic className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className={`block truncate text-xs ${mutedText}`}>
            {detail}
          </span>
        </span>
        {linkable && progress === null && (
          <a
            href={attachmentUrl(attachment.id, true)}
            download={attachment.fileName}
            onClick={(event) => event.stopPropagation()}
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mutedText}`}
            aria-label={`Download ${title}`}
            title={`Download ${title}`}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
      </div>

      {src !== null && !failed ? (
        <audio
          controls
          preload="metadata"
          src={src}
          onError={() => setFailed(true)}
          className="mt-2 h-9 w-full max-w-full"
          aria-label={`Play ${title}`}
        >
          Your browser cannot play this audio.
        </audio>
      ) : (
        <p className={`mt-2 text-xs ${mutedText}`}>
          {linkable
            ? "Audio playback is unavailable. Use the download button instead."
            : "Audio preview is unavailable in this browser."}
        </p>
      )}

      {progress !== null && (
        <span
          role="progressbar"
          aria-label={`Sending ${title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="mt-2 block h-1 overflow-hidden rounded-full bg-black/20"
        >
          <span
            className="block h-full rounded-full bg-current transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </span>
      )}
    </div>
  );
}

function FileAttachment({
  attachment,
  outgoing,
  progress,
  linkable,
  className = "",
}: MessageAttachmentProps) {
  const meta = `${typeLabel(attachment.fileName, attachment.kind)} · ${formatBytes(
    attachment.sizeBytes,
  )}`;
  const mutedText = outgoing
    ? "text-primary-emphasis-foreground/75"
    : "text-muted-foreground";

  const content = (
    <>
      <span
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${
          outgoing ? "bg-black/15" : "bg-background"
        }`}
      >
        <AttachmentIcon mimeType={attachment.mimeType} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {attachment.fileName}
        </span>
        <span className={`block truncate text-xs ${mutedText}`}>{meta}</span>
        {progress !== null && (
          <span
            role="progressbar"
            aria-label={`Sending ${attachment.fileName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="mt-1.5 block h-1 overflow-hidden rounded-full bg-black/20"
          >
            <span
              className="block h-full rounded-full bg-current transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </span>
        )}
      </span>
      {progress === null && linkable && (
        <Download className={`h-4 w-4 shrink-0 ${mutedText}`} aria-hidden="true" />
      )}
    </>
  );

  const frame = `flex w-64 max-w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${
    outgoing
      ? "border-primary-emphasis-foreground/25 bg-black/15"
      : "border-foreground/15 bg-foreground/[0.04]"
  } ${className}`;

  if (progress !== null || !linkable) {
    return <div className={frame}>{content}</div>;
  }

  return (
    <a
      href={attachmentUrl(attachment.id, true)}
      // The server's Content-Disposition names the file too; this keeps the
      // click a download rather than a navigation away from the thread.
      download={attachment.fileName}
      aria-label={`Download ${attachment.fileName}, ${meta}`}
      className={`${frame} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        outgoing ? "hover:bg-black/25" : "hover:bg-foreground/[0.08]"
      }`}
    >
      {content}
    </a>
  );
}

/** A photo, playable audio clip, or downloadable file inside a message bubble. */
export function MessageAttachment(props: MessageAttachmentProps) {
  if (props.attachment.kind === "image") {
    return <ImageAttachment {...props} />;
  }

  if (props.attachment.mimeType.startsWith("audio/")) {
    return <AudioAttachment {...props} />;
  }

  return <FileAttachment {...props} />;
}

type PendingAttachmentPreviewProps =
  | {
      status: "preparing";
      fileName: string;
      onRemove: () => void;
    }
  | {
      status: "ready";
      kind: AttachmentKind;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      /** Thumbnail or local audio source; null for other files. */
      previewUrl: string | null;
      onRemove: () => void;
    };

/** The attachment waiting in the composer, with preview and a way to remove it. */
export function PendingAttachmentPreview(props: PendingAttachmentPreviewProps) {
  const preparing = props.status === "preparing";
  const isPhoto = props.status === "ready" && props.kind === "image";
  const isAudio =
    props.status === "ready" && props.mimeType.startsWith("audio/");
  const voiceMessage =
    props.status === "ready" &&
    isVoiceMessageAttachment({ kind: props.kind, fileName: props.fileName });

  return (
    <div
      className="flex items-center gap-3 border-t bg-muted/40 px-3 py-2 sm:px-4"
      aria-live="polite"
    >
      <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border bg-background text-muted-foreground">
        {props.status === "preparing" ? (
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : isPhoto && props.previewUrl !== null ? (
          // Decorative: the line beside it says what this is.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={props.previewUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : voiceMessage ? (
          <Mic className="h-5 w-5" aria-hidden="true" />
        ) : (
          <AttachmentIcon mimeType={props.mimeType} className="h-5 w-5" />
        )}
      </span>

      <div className="min-w-0 flex-1 text-xs">
        <p className="truncate font-medium">
          {isPhoto ? "Photo" : voiceMessage ? "Voice message" : props.fileName}
        </p>
        <p className="truncate text-muted-foreground">
          {props.status === "preparing"
            ? "Preparing…"
            : `${typeLabel(props.fileName, props.kind)} · ${formatBytes(
                props.sizeBytes,
              )} · Add a caption or send`}
        </p>

        {isAudio && props.previewUrl !== null && (
          <audio
            controls
            preload="metadata"
            src={props.previewUrl}
            className="mt-2 h-8 w-full max-w-[280px]"
            aria-label={voiceMessage ? "Preview voice message" : "Preview audio"}
          >
            Your browser cannot play this audio.
          </audio>
        )}
      </div>

      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={props.onRemove}
        className="h-7 w-7 shrink-0 text-muted-foreground"
        aria-label={preparing ? "Cancel attachment" : "Remove attachment"}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
