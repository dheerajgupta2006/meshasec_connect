import "server-only";

/**
 * Server-side speech synthesis, so a translation can be spoken in any browser.
 *
 * The browser's own `speechSynthesis` only has the voices the operating system
 * installed, and Windows ships none for Telugu, Kannada, Marathi or Malayalam. A
 * listener on Chrome and Windows therefore cannot hear those languages at all, no
 * matter what the app does. Synthesising here and returning audio bytes turns the
 * problem into ordinary audio playback, which every browser can do.
 *
 * ## Only used to fill the gap
 *
 * Callers should prefer a local voice when the device has one: it is free,
 * instant, and needs no network. This exists for the languages the device cannot
 * speak, which keeps English and Hindi — the common cases — off the paid path
 * entirely.
 *
 * ## Staying inside the free tier
 *
 * Azure's free tier covers 500,000 characters a month, roughly ten hours of
 * speech. Two things protect it: identical text is synthesised once and served
 * from cache afterwards, and a per-user rate limit bounds how fast one account
 * can spend the quota. Without the cache a repeated phrase would be billed every
 * time it was said.
 */

import { createHash } from "node:crypto";

import {
  buildSsml,
  parseAzureVoices,
  selectAzureVoice,
  speakableLocales,
  type AzureVoice,
} from "@/lib/translation/azure-voice-select";

/** MP3 rather than WAV: roughly a tenth the bytes over the wire, and every
 * browser can decode it in an `Audio` element. */
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

export const AUDIO_CONTENT_TYPE = "audio/mpeg";

/**
 * Slightly quick, matching the local-voice path.
 *
 * Dubbing already lags the speaker, so a fractionally faster delivery helps the
 * listener catch up rather than drift further behind.
 */
const SPEECH_RATE = "5%";

/** Hard bound on one request. A caption is a sentence, not a document. */
export const MAX_SYNTHESIS_CHARS = 600;

/** How long the voice catalogue is trusted. It changes on Azure's release
 * cadence, not ours, so this only has to be shorter than that. */
const VOICE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Bounds the audio cache. Each clip is a few kilobytes at this bitrate. */
const MAX_CACHED_CLIPS = 400;

const REQUEST_TIMEOUT_MS = 8000;

export interface AzureCredentials {
  key: string;
  region: string;
}

/**
 * Reads credentials, or null when synthesis is not configured.
 *
 * Null is an ordinary state, not an error: the feature is optional and the app
 * runs without it, falling back to whatever voices the device has.
 */
export function readAzureCredentials(): AzureCredentials | null {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (
    key === undefined ||
    key.length === 0 ||
    region === undefined ||
    region.length === 0
  ) {
    return null;
  }

  return { key, region };
}

interface VoiceCache {
  voices: AzureVoice[];
  fetchedAt: number;
}

let voiceCache: VoiceCache | null = null;
let voicesInFlight: Promise<AzureVoice[]> | null = null;

/** Completed clips, keyed by a hash of the text, locale and voice. */
const clips = new Map<string, Uint8Array>();

function clipKey(text: string, voiceName: string): string {
  return createHash("sha256").update(`${voiceName}\u0000${text}`).digest("hex");
}

function rememberClip(key: string, audio: Uint8Array): void {
  clips.set(key, audio);

  if (clips.size <= MAX_CACHED_CLIPS) {
    return;
  }

  // `forEach` rather than `for...of`: this project's tsconfig declares no
  // `target`. Insertion order makes the first key the oldest.
  let oldest: string | null = null;

  clips.forEach((_value, existing) => {
    if (oldest === null) {
      oldest = existing;
    }
  });

  if (oldest !== null) {
    clips.delete(oldest);
  }
}

/**
 * Azure's catalogue of voices, cached.
 *
 * In-flight requests are shared so a burst of first-time callers triggers one
 * upstream fetch rather than one each.
 */
async function loadVoices(
  credentials: AzureCredentials,
): Promise<AzureVoice[]> {
  const now = Date.now();

  if (voiceCache !== null && now - voiceCache.fetchedAt < VOICE_CACHE_TTL_MS) {
    return voiceCache.voices;
  }

  if (voicesInFlight !== null) {
    return voicesInFlight;
  }

  const request = (async () => {
    try {
      const response = await fetch(
        `https://${credentials.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
        {
          headers: { "Ocp-Apim-Subscription-Key": credentials.key },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          cache: "no-store",
        },
      );

      if (!response.ok) {
        return [];
      }

      const voices = parseAzureVoices(await response.json());

      // An empty list is not cached: it usually means a bad key or a transient
      // failure, and caching it would disable synthesis for hours.
      if (voices.length > 0) {
        voiceCache = { voices, fetchedAt: Date.now() };
      }

      return voices;
    } catch {
      return [];
    } finally {
      voicesInFlight = null;
    }
  })();

  voicesInFlight = request;

  return request;
}

/**
 * The locales this server can synthesise, from the ones offered.
 *
 * Empty when synthesis is unconfigured or Azure is unreachable, which the client
 * reads as "no cloud voices" and falls back to local ones.
 */
export async function listSpeakableLocales(
  locales: readonly string[],
): Promise<string[]> {
  const credentials = readAzureCredentials();

  if (credentials === null) {
    return [];
  }

  const voices = await loadVoices(credentials);

  return speakableLocales(voices, locales);
}

export type SynthesisResult =
  | { ok: true; audio: Uint8Array; cached: boolean }
  | {
      ok: false;
      reason: "unconfigured" | "unsupported_locale" | "too_long" | "failed";
    };

/**
 * Synthesises `text` in `locale`, returning MP3 bytes.
 *
 * Never throws: a failure here should cost one spoken sentence, not the call.
 */
export async function synthesizeSpeech(
  text: string,
  locale: string,
): Promise<SynthesisResult> {
  const credentials = readAzureCredentials();

  if (credentials === null) {
    return { ok: false, reason: "unconfigured" };
  }

  const cleaned = text.trim();

  if (cleaned.length === 0) {
    return { ok: false, reason: "too_long" };
  }

  if (cleaned.length > MAX_SYNTHESIS_CHARS) {
    return { ok: false, reason: "too_long" };
  }

  const voices = await loadVoices(credentials);
  const voice = selectAzureVoice(voices, locale);

  if (voice === null) {
    return { ok: false, reason: "unsupported_locale" };
  }

  const key = clipKey(cleaned, voice.ShortName);
  const cached = clips.get(key);

  // The whole reason the free tier holds: a phrase said twice is billed once.
  if (cached !== undefined) {
    return { ok: true, audio: cached, cached: true };
  }

  try {
    const response = await fetch(
      `https://${credentials.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": credentials.key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
          "User-Agent": "MeshasecConnext",
        },
        body: buildSsml(cleaned, voice, SPEECH_RATE),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return { ok: false, reason: "failed" };
    }

    const audio = new Uint8Array(await response.arrayBuffer());

    if (audio.byteLength === 0) {
      return { ok: false, reason: "failed" };
    }

    rememberClip(key, audio);

    return { ok: true, audio, cached: false };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
