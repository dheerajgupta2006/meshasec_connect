"use client";

import { VideoTrack } from "@livekit/components-react";
import type { TrackReference } from "@livekit/components-react";
import { Check, Crown, MonitorUp, ZoomIn } from "lucide-react";
import * as React from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import {
  ConnectionQualityIcon,
  participantDisplayName,
} from "./participant-tile";

/**
 * Viewer-side display controls for a shared screen.
 *
 * Separate from `ParticipantVideoTile` on purpose. That component's sizing is
 * deliberately inescapable — `h-full w-full` plus `max-h-full max-w-full` — because
 * a screen share once rendered at its native 1080p+ pixels and forced the whole
 * page wider than the viewport. Percentage zoom needs exactly that native sizing,
 * so rather than loosen the guard for every tile, the oversized content is
 * confined to the scroll container below. The page-level `overflow-hidden` in
 * `meeting-room.tsx` and the spotlight wrapper in `video-grid.tsx` both stay as
 * they are; nothing can escape this box.
 */

export type ScreenShareZoom = "fit" | "50" | "100" | "150" | "200";

const ZOOM_OPTIONS: {
  value: ScreenShareZoom;
  label: string;
  hint?: string;
}[] = [
  { value: "fit", label: "Fit to Window" },
  { value: "50", label: "50%" },
  { value: "100", label: "100%", hint: "Original size" },
  { value: "150", label: "150%" },
  { value: "200", label: "200%" },
];

/** Scale factor applied to the stream's own resolution. */
const MULTIPLIER: Record<Exclude<ScreenShareZoom, "fit">, number> = {
  "50": 0.5,
  "100": 1,
  "150": 1.5,
  "200": 2,
};

function zoomLabel(zoom: ScreenShareZoom): string {
  return ZOOM_OPTIONS.find((option) => option.value === zoom)?.label ?? "Fit to Window";
}

interface Size {
  width: number;
  height: number;
}

/**
 * The stream's real resolution, read from the video element.
 *
 * `videoWidth`/`videoHeight` rather than the publication's declared dimensions:
 * this is what the browser actually decoded, so "100%" means true pixel size. The
 * `resize` event matters as much as `loadedmetadata` — a sharer switching from a
 * laptop screen to an external monitor changes the resolution mid-stream, and
 * without it the zoom maths would keep using the old one.
 */
function useIntrinsicSize(element: HTMLVideoElement | null): Size | null {
  const [size, setSize] = React.useState<Size | null>(null);

  React.useEffect(() => {
    if (element === null) {
      return;
    }

    function read(): void {
      if (element === null) {
        return;
      }

      const { videoWidth, videoHeight } = element;

      if (videoWidth > 0 && videoHeight > 0) {
        setSize((current) =>
          current !== null &&
          current.width === videoWidth &&
          current.height === videoHeight
            ? current
            : { width: videoWidth, height: videoHeight },
        );
      }
    }

    read();

    element.addEventListener("loadedmetadata", read);
    element.addEventListener("resize", read);

    return () => {
      element.removeEventListener("loadedmetadata", read);
      element.removeEventListener("resize", read);
    };
  }, [element]);

  return size;
}

export interface ScreenShareViewportProps {
  trackRef: TrackReference;
  isHost?: boolean;
}

export function ScreenShareViewport({
  trackRef,
  isHost = false,
}: ScreenShareViewportProps): React.JSX.Element {
  const [zoom, setZoom] = React.useState<ScreenShareZoom>("fit");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [videoElement, setVideoElement] =
    React.useState<HTMLVideoElement | null>(null);
  const [isPannable, setIsPannable] = React.useState(false);
  const [isPanning, setIsPanning] = React.useState(false);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const panOriginRef = React.useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const intrinsic = useIntrinsicSize(videoElement);

  const trackSid = trackRef.publication.trackSid;

  // A new share is a new screen. Carrying 200% over to it would drop the viewer
  // into the corner of something they have not seen yet.
  React.useEffect(() => {
    setZoom("fit");
  }, [trackSid]);

  /**
   * Explicit pixel size for a percentage zoom, or null for fit-to-window.
   *
   * Both dimensions come from the same multiplier, so the aspect ratio is exact
   * at every scale rather than merely preserved by `object-fit`. Falls back to
   * fit while the resolution is still unknown, which is briefly true right after
   * a share starts.
   */
  const scaledSize = React.useMemo<Size | null>(() => {
    if (zoom === "fit" || intrinsic === null) {
      return null;
    }

    const multiplier = MULTIPLIER[zoom];

    return {
      width: Math.round(intrinsic.width * multiplier),
      height: Math.round(intrinsic.height * multiplier),
    };
  }, [zoom, intrinsic]);

  // Whether the content currently overflows, which is what decides if dragging
  // does anything. Re-measured on container resize (covers window resize) and
  // whenever the scaled size changes.
  React.useEffect(() => {
    const node = scrollRef.current;

    if (node === null) {
      return;
    }

    function measure(): void {
      if (node === null) {
        return;
      }

      // The 1px tolerance keeps sub-pixel rounding from reporting a permanent
      // one-pixel overflow, which would leave the grab cursor on in fit mode.
      setIsPannable(
        node.scrollWidth > node.clientWidth + 1 ||
          node.scrollHeight > node.clientHeight + 1,
      );
    }

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [scaledSize]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const node = scrollRef.current;

    // Touch is left to the browser: native momentum scrolling beats anything
    // reimplemented here, and capturing the pointer would break pinch-zoom.
    if (
      node === null ||
      !isPannable ||
      event.pointerType === "touch" ||
      event.button !== 0
    ) {
      return;
    }

    panOriginRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: node.scrollLeft,
      top: node.scrollTop,
    };
    setIsPanning(true);
    node.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const node = scrollRef.current;
    const origin = panOriginRef.current;

    if (node === null || origin === null) {
      return;
    }

    // Inverted: dragging the image left scrolls the viewport right, which is how
    // grabbing a piece of paper behaves.
    node.scrollLeft = origin.left - (event.clientX - origin.x);
    node.scrollTop = origin.top - (event.clientY - origin.y);
  }

  function endPan(event: React.PointerEvent<HTMLDivElement>): void {
    const node = scrollRef.current;

    panOriginRef.current = null;
    setIsPanning(false);

    if (node !== null && node.hasPointerCapture(event.pointerId)) {
      node.releasePointerCapture(event.pointerId);
    }
  }

  const label = participantDisplayName(trackRef.participant);

  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-inset ring-white/10">
      {/* A flex row, and the sizer below is its only child. This is the one
          structure that works for both modes without swapping any DOM: swapping
          would unmount the <video> and restart the stream on every zoom change.

          Critically, this element has a *definite* height — `flex-1` inside a
          `h-full` column — which is what lets the fit-mode percentages below
          resolve. An auto-height ancestor anywhere in this chain is what made a
          screen share fall back to its intrinsic 1080p size in the first place. */}
      <div
        ref={scrollRef}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 [scrollbar-width:thin]",
          // Only scrollable when zoomed. Left on in fit mode, a sub-pixel
          // rounding difference could raise a scrollbar, which shrinks the box,
          // which changes the fit — an oscillating layout.
          scaledSize === null ? "overflow-hidden" : "overflow-auto",
          isPannable && (isPanning ? "cursor-grabbing" : "cursor-grab"),
          isPanning && "select-none",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          className={cn(
            scaledSize === null
              ? // Fills the scroll box, so CSS alone handles a window resize and
                // `object-contain` on the video keeps the aspect ratio.
                "h-full w-full"
              : // `shrink-0` is load-bearing: a flex item shrinks to fit by
                // default, which would quietly undo the zoom instead of
                // overflowing. `m-auto` centres the content while it is smaller
                // than the box and collapses to zero once it is larger — unlike
                // `justify-center`, which would put the top-left of an oversized
                // share out of scrolling reach.
                "m-auto shrink-0",
          )}
          style={
            scaledSize === null
              ? undefined
              : { width: scaledSize.width, height: scaledSize.height }
          }
        >
          <VideoTrack
            ref={setVideoElement}
            trackRef={trackRef}
            // Otherwise the browser starts a ghost-image drag and swallows the
            // pan gesture.
            draggable={false}
            className={cn(
              "block h-full w-full",
              // Only meaningful in fit mode; when zoomed the box is already the
              // exact scaled size, which is what makes 100% true pixels.
              scaledSize === null && "max-h-full max-w-full object-contain",
            )}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-2">
        {zoom !== "fit" && (
          <span className="rounded-full bg-zinc-950/75 px-2 py-1 text-[11px] font-medium text-zinc-200 backdrop-blur">
            {zoomLabel(zoom)}
          </span>
        )}

        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-zinc-950/75 px-3 py-1.5 text-xs font-medium text-zinc-100 backdrop-blur transition-colors hover:bg-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              aria-expanded={menuOpen}
              aria-label={`View options. Current: ${zoomLabel(zoom)}`}
            >
              <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
              View Options
            </button>
          </PopoverTrigger>

          <PopoverContent
            align="end"
            sideOffset={8}
            className="w-52 border-white/10 bg-zinc-900/95 p-1 text-zinc-100 backdrop-blur-xl"
          >
            {/* A radio group, not checkboxes: exactly one scale is active. */}
            <div role="radiogroup" aria-label="Shared screen scale">
              {ZOOM_OPTIONS.map((option) => {
                const active = option.value === zoom;

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      setZoom(option.value);
                      setMenuOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:bg-white/10",
                      active && "bg-white/[0.08]",
                    )}
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        active ? "text-emerald-400" : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                    <span className="flex-1">{option.label}</span>
                    {option.hint !== undefined && (
                      <span className="text-[10px] text-zinc-400">
                        {option.hint}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {isPannable && (
              <p className="border-t border-white/10 px-2 py-2 text-[10px] leading-4 text-zinc-400">
                Drag the screen to move around it, or use the scrollbars.
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-gradient-to-t from-zinc-950/85 to-transparent px-2.5 py-2">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-zinc-50 sm:text-sm">
          <MonitorUp
            className="h-3.5 w-3.5 shrink-0 text-sky-300"
            aria-hidden="true"
          />
          {isHost && (
            <Crown
              className="h-3.5 w-3.5 shrink-0 text-amber-300"
              aria-hidden="true"
            />
          )}
          <span className="truncate">{label}&apos;s screen</span>
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <ConnectionQualityIcon participant={trackRef.participant} />
        </span>
      </div>
    </div>
  );
}
