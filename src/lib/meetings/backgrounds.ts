/**
 * Camera background effects.
 *
 * Isomorphic: the pure parts (parsing, validation, preset definitions) are used
 * by the lobby, the room and the tests. The canvas-backed helpers are guarded so
 * importing this module on the server is harmless.
 */

export type BackgroundEffect =
  | { kind: "none" }
  | { kind: "blur" }
  /** `url` is a data URL — either a rendered preset or a downscaled upload. */
  | { kind: "image"; id: string; url: string };

export const NO_BACKGROUND: BackgroundEffect = { kind: "none" };

export interface BackgroundPreset {
  id: string;
  label: string;
  /** Three stops, rendered as a diagonal gradient. */
  stops: [string, string, string];
}

/**
 * Built-in backgrounds, rendered procedurally rather than shipped as photos.
 *
 * A gradient is not a photograph, and that is a deliberate trade: bundling real
 * background images would add megabytes of binary assets to the repo for a
 * feature most people use once. Drop JPEGs into `public/backgrounds/` and add
 * them to `FILE_PRESETS` below to offer real scenes as well.
 */
export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: "studio",
    label: "Studio",
    stops: ["#1e293b", "#0f172a", "#020617"],
  },
  {
    id: "office",
    label: "Office",
    stops: ["#e2e8f0", "#cbd5e1", "#94a3b8"],
  },
  {
    id: "nature",
    label: "Nature",
    stops: ["#14532d", "#166534", "#052e16"],
  },
  {
    id: "dusk",
    label: "Dusk",
    stops: ["#7c3aed", "#4c1d95", "#1e1b4b"],
  },
  {
    id: "warm",
    label: "Warm",
    stops: ["#fed7aa", "#fb923c", "#c2410c"],
  },
  {
    id: "slate",
    label: "Slate",
    stops: ["#f1f5f9", "#e2e8f0", "#cbd5e1"],
  },
];

/**
 * Optional real images. Any path listed here must exist under `public/`.
 *
 * Empty by design: the repo ships no binary background assets, and referencing a
 * missing file would render a broken background rather than fail loudly.
 */
export const FILE_PRESETS: { id: string; label: string; src: string }[] = [];

/** Rendered background dimensions. 720p is what LiveKit publishes by default. */
export const BACKGROUND_WIDTH = 1280;
export const BACKGROUND_HEIGHT = 720;

/**
 * Cap on an uploaded image before downscaling.
 *
 * Generous, because the file is never sent anywhere — it is downscaled in the
 * browser and applied locally. The cap only exists to avoid stalling the tab on
 * a 100MB TIFF.
 */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Cap on the *downscaled* data URL that gets persisted.
 *
 * `sessionStorage` is typically limited to around 5MB per origin and is shared
 * with the device preferences written by the lobby, so this stays well clear.
 */
export const MAX_STORED_BACKGROUND_CHARS = 2_000_000;

export const ACCEPTED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** True when the value is a data URL for an accepted image type. */
export function isUsableBackgroundUrl(value: string): boolean {
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * Narrows a persisted effect without trusting it.
 *
 * The value comes out of `sessionStorage`, which the user can edit, and the
 * `url` ends up on a canvas. Anything unrecognised degrades to no effect rather
 * than throwing on a page the user is trying to join a call from.
 */
export function parseBackgroundEffect(value: unknown): BackgroundEffect {
  const record = asRecord(value);

  if (record === null) {
    return NO_BACKGROUND;
  }

  if (record.kind === "blur") {
    return { kind: "blur" };
  }

  if (record.kind === "image") {
    const url = record.url;
    const id = record.id;

    if (
      typeof url === "string" &&
      typeof id === "string" &&
      url.length <= MAX_STORED_BACKGROUND_CHARS &&
      isUsableBackgroundUrl(url)
    ) {
      return { kind: "image", id, url };
    }
  }

  return NO_BACKGROUND;
}

/** Stable label for the current effect, used in button titles and aria text. */
export function describeBackgroundEffect(effect: BackgroundEffect): string {
  if (effect.kind === "none") {
    return "No background effect";
  }

  if (effect.kind === "blur") {
    return "Background blur";
  }

  const preset = BACKGROUND_PRESETS.find((entry) => entry.id === effect.id);

  return preset === undefined
    ? "Custom background"
    : `${preset.label} background`;
}

/** True when two effects would produce the same camera output. */
export function sameBackgroundEffect(
  first: BackgroundEffect,
  second: BackgroundEffect,
): boolean {
  if (first.kind !== second.kind) {
    return false;
  }

  if (first.kind === "image" && second.kind === "image") {
    return first.id === second.id && first.url === second.url;
  }

  return true;
}
