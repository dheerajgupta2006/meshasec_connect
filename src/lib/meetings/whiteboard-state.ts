/**
 * Whiteboard geometry and state.
 *
 * Pure, so the coordinate handling and stroke merging are testable without a
 * canvas or a room.
 *
 * Built on plain canvas rather than tldraw or Excalidraw deliberately: either
 * would add well over a megabyte to a bundle that already ships LiveKit, for a
 * feature used occasionally. This covers freehand drawing, colour, width and
 * erase — the things people actually reach for mid-call — and nothing more.
 */

/** Stroke coordinates are normalised 0-1 so a board looks the same at any size. */
export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  /** Author's LiveKit identity, so a person can undo only their own work. */
  author: string;
  color: string;
  /** Fraction of the canvas width, so line weight scales with the board. */
  width: number;
  points: Point[];
  /** Erase strokes paint the background rather than removing geometry. */
  erase: boolean;
}

export interface WhiteboardState {
  strokes: Stroke[];
}

export const EMPTY_WHITEBOARD: WhiteboardState = { strokes: [] };

/**
 * Bound on retained strokes.
 *
 * A whiteboard is unbounded by nature and every stroke is replayed on each
 * repaint, so an all-day session would eventually stutter. Oldest are dropped.
 */
export const MAX_STROKES = 600;

/** Bound per stroke, so one very long drag cannot produce an enormous payload. */
export const MAX_POINTS_PER_STROKE = 400;

export const STROKE_COLORS = [
  "#f8fafc",
  "#f87171",
  "#fbbf24",
  "#4ade80",
  "#60a5fa",
  "#c084fc",
] as const;

export const STROKE_WIDTHS = [0.003, 0.006, 0.012] as const;

export type WhiteboardMessage =
  | { kind: "stroke"; stroke: Stroke }
  | { kind: "undo"; strokeId: string }
  | { kind: "clear" }
  | { kind: "snapshot_request" }
  | { kind: "snapshot"; state: WhiteboardState };

/** Clamps to the unit square, so a drag outside the canvas cannot escape it. */
export function clampPoint(point: Point): Point {
  return {
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  };
}

/** True when the value is a usable normalised point. */
function isPoint(value: unknown): value is Point {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.x === "number" &&
    typeof record.y === "number" &&
    Number.isFinite(record.x) &&
    Number.isFinite(record.y)
  );
}

/**
 * Validates a stroke received from another client.
 *
 * Everything is bounded and clamped rather than trusted: the payload arrives from
 * a peer, and a stroke with a million points or a non-finite coordinate would
 * either hang the repaint loop or throw inside the canvas API.
 */
export function sanitizeStroke(value: unknown, author: string): Stroke | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }

  if (!Array.isArray(record.points) || record.points.length === 0) {
    return null;
  }

  const points: Point[] = [];

  record.points.slice(0, MAX_POINTS_PER_STROKE).forEach((entry) => {
    if (isPoint(entry)) {
      points.push(clampPoint(entry));
    }
  });

  if (points.length === 0) {
    return null;
  }

  const color =
    typeof record.color === "string" && /^#[0-9a-fA-F]{6}$/.test(record.color)
      ? record.color
      : STROKE_COLORS[0];

  const rawWidth = typeof record.width === "number" ? record.width : 0.006;
  const width = Math.min(0.05, Math.max(0.001, rawWidth));

  return {
    id: record.id,
    // Authorship comes from the packet, never the payload.
    author,
    color,
    width,
    points,
    erase: record.erase === true,
  };
}

/**
 * Applies one message.
 *
 * Returns the same object when nothing changed so React can skip a repaint.
 */
export function reduceWhiteboard(
  state: WhiteboardState,
  message: WhiteboardMessage,
  from: string,
): WhiteboardState {
  switch (message.kind) {
    case "stroke": {
      const stroke = sanitizeStroke(message.stroke, from);

      if (stroke === null) {
        return state;
      }

      if (state.strokes.some((existing) => existing.id === stroke.id)) {
        return state;
      }

      const strokes = [...state.strokes, stroke];

      return {
        strokes:
          strokes.length > MAX_STROKES
            ? strokes.slice(strokes.length - MAX_STROKES)
            : strokes,
      };
    }

    case "undo": {
      const index = state.strokes.findIndex(
        // Only your own strokes: undo must not reach into someone else's work.
        (stroke) => stroke.id === message.strokeId && stroke.author === from,
      );

      if (index === -1) {
        return state;
      }

      return {
        strokes: [
          ...state.strokes.slice(0, index),
          ...state.strokes.slice(index + 1),
        ],
      };
    }

    case "clear":
      return state.strokes.length === 0 ? state : EMPTY_WHITEBOARD;

    case "snapshot": {
      // Only while empty, so two clients answering one request cannot clobber
      // each other's newer state.
      if (state.strokes.length > 0) {
        return state;
      }

      const strokes: Stroke[] = [];

      if (Array.isArray(message.state?.strokes)) {
        message.state.strokes.slice(0, MAX_STROKES).forEach((entry) => {
          const author =
            typeof (entry as { author?: unknown }).author === "string"
              ? (entry as { author: string }).author
              : from;
          const stroke = sanitizeStroke(entry, author);

          if (stroke !== null) {
            strokes.push(stroke);
          }
        });
      }

      return { strokes };
    }

    default:
      return state;
  }
}

/** The most recent stroke belonging to `author`, for undo. */
export function lastStrokeBy(
  state: WhiteboardState,
  author: string,
): Stroke | null {
  for (let index = state.strokes.length - 1; index >= 0; index -= 1) {
    const stroke = state.strokes[index];

    if (stroke !== undefined && stroke.author === author) {
      return stroke;
    }
  }

  return null;
}
