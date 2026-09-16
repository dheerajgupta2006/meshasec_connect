"use client";

import { useDataChannel, useRoomContext } from "@livekit/components-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Eraser, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import type { Participant } from "livekit-client";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  EMPTY_WHITEBOARD,
  STROKE_COLORS,
  STROKE_WIDTHS,
  clampPoint,
  lastStrokeBy,
  reduceWhiteboard,
  type Point,
  type Stroke,
  type WhiteboardMessage,
  type WhiteboardState,
} from "@/lib/meetings/whiteboard-state";
import { cn } from "@/lib/utils";

import { useMeetingRoles } from "./roles-provider";

/** Its own topic so board traffic does not reach the reaction or poll handlers. */
const WHITEBOARD_TOPIC = "meshasec-room-board";

/** Board background. Erase strokes paint this colour rather than deleting. */
const BOARD_BACKGROUND = "#18181b";

export interface WhiteboardProps {
  open: boolean;
  onClose: () => void;
}

function parsePayload(payload: Uint8Array): WhiteboardMessage | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { kind?: unknown }).kind !== "string"
    ) {
      return null;
    }

    return parsed as WhiteboardMessage;
  } catch {
    return null;
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Collaborative whiteboard, synced over the room's data channel.
 *
 * Strokes are stored in normalised 0-1 coordinates, so a board drawn on a laptop
 * appears correctly on a phone. Nothing is persisted: the board belongs to the
 * conversation, and a late joiner catches up through a snapshot request.
 */
export function Whiteboard({
  open,
  onClose,
}: WhiteboardProps): React.JSX.Element {
  const room = useRoomContext();
  const { canModerate } = useMeetingRoles();
  const shouldReduceMotion = useReducedMotion() === true;

  const [state, setState] = React.useState<WhiteboardState>(EMPTY_WHITEBOARD);
  const [color, setColor] = React.useState<string>(STROKE_COLORS[0]);
  const [width, setWidth] = React.useState<number>(STROKE_WIDTHS[1]);
  const [erasing, setErasing] = React.useState(false);

  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef<Stroke | null>(null);
  const stateRef = React.useRef(state);

  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const localIdentity = room.localParticipant.identity;

  const handleIncoming = React.useCallback(
    (payload: Uint8Array, from: Participant | undefined) => {
      if (from === undefined || from.identity.length === 0) {
        return;
      }

      const message = parsePayload(payload);

      if (message === null) {
        return;
      }

      if (message.kind === "snapshot_request") {
        const current = stateRef.current;

        if (current.strokes.length === 0) {
          return;
        }

        const reply = new TextEncoder().encode(
          JSON.stringify({ kind: "snapshot", state: current }),
        );
        void sendRef.current(reply, { reliable: true }).catch(() => undefined);
        return;
      }

      setState((current) => reduceWhiteboard(current, message, from.identity));
    },
    [],
  );

  const handleIncomingRef = React.useRef(handleIncoming);
  React.useEffect(() => {
    handleIncomingRef.current = handleIncoming;
  }, [handleIncoming]);

  const onDataMessage = React.useCallback(
    (message: { payload: Uint8Array; from?: Participant }) => {
      handleIncomingRef.current(message.payload, message.from);
    },
    [],
  );

  const { send } = useDataChannel(WHITEBOARD_TOPIC, onDataMessage);

  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const broadcast = React.useCallback((message: WhiteboardMessage) => {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    void sendRef.current(payload, { reliable: true }).catch(() => undefined);
  }, []);

  // Catch up on open rather than on mount: the board is usually never opened, and
  // requesting a snapshot then would be wasted traffic for every participant.
  React.useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(() => {
      broadcast({ kind: "snapshot_request" });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [open, broadcast]);

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

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  /** Repaints every stroke. Cheap enough at the stroke cap, and always correct. */
  const repaint = React.useCallback(() => {
    const canvas = canvasRef.current;

    if (canvas === null) {
      return;
    }

    const context = canvas.getContext("2d");

    if (context === null) {
      return;
    }

    const { width: pixelWidth, height: pixelHeight } = canvas;

    context.fillStyle = BOARD_BACKGROUND;
    context.fillRect(0, 0, pixelWidth, pixelHeight);

    const paint = (stroke: Stroke) => {
      if (stroke.points.length === 0) {
        return;
      }

      context.beginPath();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = stroke.erase ? BOARD_BACKGROUND : stroke.color;
      // Width is a fraction of the canvas, so weight scales with the board.
      context.lineWidth = Math.max(1, stroke.width * pixelWidth);

      stroke.points.forEach((point, index) => {
        const x = point.x * pixelWidth;
        const y = point.y * pixelHeight;

        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });

      // A single tap has one point and would draw nothing, so it becomes a dot.
      if (stroke.points.length === 1) {
        const only = stroke.points[0];

        if (only !== undefined) {
          context.arc(
            only.x * pixelWidth,
            only.y * pixelHeight,
            Math.max(1, (stroke.width * pixelWidth) / 2),
            0,
            Math.PI * 2,
          );
          context.fillStyle = stroke.erase ? BOARD_BACKGROUND : stroke.color;
          context.fill();
        }
      }

      context.stroke();
    };

    state.strokes.forEach(paint);

    const inProgress = drawingRef.current;

    if (inProgress !== null) {
      paint(inProgress);
    }
  }, [state]);

  // Sizes the backing store to the element, accounting for device pixel ratio so
  // lines are not blurry on a high-density screen.
  React.useEffect(() => {
    if (!open) {
      return;
    }

    const canvas = canvasRef.current;

    if (canvas === null) {
      return;
    }

    function resize() {
      const element = canvasRef.current;

      if (element === null) {
        return;
      }

      const rect = element.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);

      element.width = Math.max(1, Math.floor(rect.width * ratio));
      element.height = Math.max(1, Math.floor(rect.height * ratio));
      repaint();
    }

    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    return () => observer.disconnect();
  }, [open, repaint]);

  React.useEffect(() => {
    repaint();
  }, [repaint]);

  function toBoardPoint(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();

    return clampPoint({
      x: (event.clientX - rect.left) / Math.max(1, rect.width),
      y: (event.clientY - rect.top) / Math.max(1, rect.height),
    });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    // Capture so a drag that leaves the canvas still finishes the stroke rather
    // than leaving it open forever.
    event.currentTarget.setPointerCapture(event.pointerId);

    drawingRef.current = {
      id: newId(),
      author: localIdentity,
      color,
      width,
      points: [toBoardPoint(event)],
      erase: erasing,
    };

    repaint();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const stroke = drawingRef.current;

    if (stroke === null) {
      return;
    }

    stroke.points.push(toBoardPoint(event));
    repaint();
  }

  function finishStroke() {
    const stroke = drawingRef.current;
    drawingRef.current = null;

    if (stroke === null) {
      return;
    }

    // Applied locally as well as broadcast, so the author sees no round trip.
    setState((current) => reduceWhiteboard(current, { kind: "stroke", stroke }, localIdentity));
    broadcast({ kind: "stroke", stroke });
  }

  function undo() {
    const mine = lastStrokeBy(state, localIdentity);

    if (mine === null) {
      return;
    }

    setState((current) =>
      reduceWhiteboard(current, { kind: "undo", strokeId: mine.id }, localIdentity),
    );
    broadcast({ kind: "undo", strokeId: mine.id });
  }

  function clearAll() {
    setState(EMPTY_WHITEBOARD);
    broadcast({ kind: "clear" });
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          aria-label="Whiteboard"
          initial={shouldReduceMotion ? undefined : { opacity: 0 }}
          animate={shouldReduceMotion ? undefined : { opacity: 1 }}
          exit={shouldReduceMotion ? undefined : { opacity: 0 }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.15 }}
          className="absolute inset-0 z-30 flex flex-col bg-zinc-950/95 backdrop-blur"
        >
          <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
            <h2 className="mr-auto text-sm font-semibold">Whiteboard</h2>

            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="Pen colour"
            >
              {STROKE_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => {
                    setColor(swatch);
                    setErasing(false);
                  }}
                  aria-label={`Use colour ${swatch}`}
                  aria-pressed={!erasing && color === swatch}
                  className={cn(
                    "h-6 w-6 rounded-full border transition-transform",
                    !erasing && color === swatch
                      ? "scale-110 border-white"
                      : "border-white/25",
                  )}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>

            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="Pen width"
            >
              {STROKE_WIDTHS.map((size, index) => (
                <Button
                  key={size}
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => setWidth(size)}
                  aria-pressed={width === size}
                  aria-label={`Pen width ${index + 1}`}
                  className={cn(
                    "h-7 w-7",
                    width === size ? "bg-white/15 text-white" : "text-zinc-400",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="rounded-full bg-current"
                    style={{
                      width: `${4 + index * 3}px`,
                      height: `${4 + index * 3}px`,
                    }}
                  />
                </Button>
              ))}
            </div>

            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => setErasing((current) => !current)}
              aria-pressed={erasing}
              aria-label={erasing ? "Switch to pen" : "Switch to eraser"}
              className={cn(
                "h-7 w-7",
                erasing ? "bg-white/15 text-white" : "text-zinc-400",
              )}
            >
              {erasing ? (
                <Eraser className="h-4 w-4" />
              ) : (
                <Pencil className="h-4 w-4" />
              )}
            </Button>

            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={undo}
              aria-label="Undo your last stroke"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-100"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>

            {/* Clearing wipes everyone's work, so it is a moderation action. */}
            {canModerate && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={clearAll}
                aria-label="Clear the whiteboard for everyone"
                className="h-7 w-7 text-zinc-400 hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}

            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onClose}
              aria-label="Close whiteboard"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </header>

          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
            // Stops the browser scrolling or zooming the page mid-stroke on touch.
            className="min-h-0 flex-1 touch-none"
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
