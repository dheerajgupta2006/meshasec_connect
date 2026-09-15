/**
 * Browser-only background helpers: rendering presets and preparing uploads.
 *
 * Split from `backgrounds.ts` so the pure model stays importable from anywhere.
 * Everything here touches `document` or `Image`, so it must only run on the
 * client.
 */

import {
  ACCEPTED_UPLOAD_TYPES,
  BACKGROUND_HEIGHT,
  BACKGROUND_WIDTH,
  MAX_STORED_BACKGROUND_CHARS,
  MAX_UPLOAD_BYTES,
  type BackgroundPreset,
} from "@/lib/meetings/backgrounds";

/** Memo so switching back and forth does not re-render the same gradient. */
const presetCache = new Map<string, string>();

/**
 * Renders a preset to a JPEG data URL.
 *
 * A gradient plus a soft vignette reads as depth rather than a flat wash, which
 * matters because the subject is composited straight on top of it.
 */
export function renderPreset(preset: BackgroundPreset): string {
  const cached = presetCache.get(preset.id);

  if (cached !== undefined) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = BACKGROUND_WIDTH;
  canvas.height = BACKGROUND_HEIGHT;

  const context = canvas.getContext("2d");

  if (context === null) {
    return "";
  }

  const linear = context.createLinearGradient(
    0,
    0,
    BACKGROUND_WIDTH,
    BACKGROUND_HEIGHT,
  );
  linear.addColorStop(0, preset.stops[0]);
  linear.addColorStop(0.55, preset.stops[1]);
  linear.addColorStop(1, preset.stops[2]);

  context.fillStyle = linear;
  context.fillRect(0, 0, BACKGROUND_WIDTH, BACKGROUND_HEIGHT);

  // Vignette: darkens the edges so the frame does not look like a solid card.
  const radial = context.createRadialGradient(
    BACKGROUND_WIDTH / 2,
    BACKGROUND_HEIGHT / 2,
    BACKGROUND_HEIGHT * 0.15,
    BACKGROUND_WIDTH / 2,
    BACKGROUND_HEIGHT / 2,
    BACKGROUND_WIDTH * 0.75,
  );
  radial.addColorStop(0, "rgba(0,0,0,0)");
  radial.addColorStop(1, "rgba(0,0,0,0.35)");

  context.fillStyle = radial;
  context.fillRect(0, 0, BACKGROUND_WIDTH, BACKGROUND_HEIGHT);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  presetCache.set(preset.id, dataUrl);

  return dataUrl;
}

export type UploadOutcome =
  | { ok: true; url: string }
  | { ok: false; message: string };

function loadImage(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image could not be decoded"));
    image.src = objectUrl;
  });
}

/**
 * Validates, downscales and encodes an uploaded background.
 *
 * Downscaling is not cosmetic. The result is persisted in `sessionStorage` so it
 * survives the lobby-to-room navigation, and a full-resolution phone photo would
 * blow the storage quota out on its own. Re-encoding also strips EXIF, so the
 * location a photo was taken at is not carried into the session.
 *
 * The file never leaves the browser — the effect is composited locally, so no
 * upload endpoint or object storage is involved.
 */
export async function prepareUploadedBackground(
  file: File,
): Promise<UploadOutcome> {
  if (!ACCEPTED_UPLOAD_TYPES.includes(file.type as never)) {
    return { ok: false, message: "Use a JPEG, PNG or WebP image." };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "That image is too large. Use one under 12MB." };
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(objectUrl);

    const canvas = document.createElement("canvas");
    canvas.width = BACKGROUND_WIDTH;
    canvas.height = BACKGROUND_HEIGHT;

    const context = canvas.getContext("2d");

    if (context === null) {
      return { ok: false, message: "This browser cannot process that image." };
    }

    // Cover rather than stretch: aspect ratio is preserved and the overflow is
    // cropped, which is what any video tool does with a background.
    const scale = Math.max(
      BACKGROUND_WIDTH / image.width,
      BACKGROUND_HEIGHT / image.height,
    );
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;

    context.drawImage(
      image,
      (BACKGROUND_WIDTH - drawWidth) / 2,
      (BACKGROUND_HEIGHT - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );

    // Step the quality down until it fits the storage budget rather than
    // failing outright on a detailed photo.
    for (const quality of [0.82, 0.7, 0.6, 0.5, 0.4]) {
      const url = canvas.toDataURL("image/jpeg", quality);

      if (url.length <= MAX_STORED_BACKGROUND_CHARS) {
        return { ok: true, url };
      }
    }

    return {
      ok: false,
      message: "That image is too detailed to use. Try a simpler one.",
    };
  } catch {
    return { ok: false, message: "That image could not be read." };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
