import { NextResponse } from "next/server";

import { SUPPORTED_LANGUAGES, isLanguageCode, speechLocaleFor } from "@/lib/i18n/languages";
import {
  AUDIO_CONTENT_TYPE,
  MAX_SYNTHESIS_CHARS,
  listSpeakableLocales,
  readAzureCredentials,
  synthesizeSpeech,
} from "@/lib/translation/azure-tts";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { getCurrentLocalUserId } from "@/lib/users/current-user";

export const runtime = "nodejs";

/**
 * Speaks a translated caption aloud for browsers whose device has no voice for
 * the language.
 *
 * Authenticated and rate limited for the same reason as the link preview route:
 * it spends a metered third-party quota on the caller's behalf, so leaving it
 * open would let anyone drain the month's synthesis budget.
 *
 * Text rather than audio crosses the wire in both directions here, and the text
 * is already a translated caption the caller is about to display, so this reveals
 * nothing to the server it did not already route.
 */

/**
 * Reports which languages the server can speak.
 *
 * The client merges this with the voices the device already has, so the listen
 * picker can offer Telugu on a machine that has no Telugu voice. Cached for an
 * hour: the answer depends on Azure's catalogue and our configuration, neither of
 * which changes during a call.
 */
export async function GET(): Promise<NextResponse> {
  const viewerId = await getCurrentLocalUserId();

  if (viewerId === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (readAzureCredentials() === null) {
    // 200 with an empty list rather than an error: synthesis is optional, and
    // "the server has no voices" is a normal answer the client handles by using
    // local ones.
    return NextResponse.json(
      { languages: [] },
      { headers: { "Cache-Control": "private, max-age=3600" } },
    );
  }

  const locales = SUPPORTED_LANGUAGES.map((language) => language.speechLocale);
  const speakable = await listSpeakableLocales(locales);

  // Mapped back to catalogue codes so the client never has to reason about
  // regional tags.
  const languages = SUPPORTED_LANGUAGES.filter((language) =>
    speakable.includes(language.speechLocale),
  ).map((language) => language.code);

  return NextResponse.json(
    { languages },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}

function readBody(value: unknown): { text: string; language: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.text !== "string" ||
    typeof record.language !== "string"
  ) {
    return null;
  }

  return { text: record.text, language: record.language };
}

export async function POST(request: Request): Promise<NextResponse> {
  const viewerId = await getCurrentLocalUserId();

  if (viewerId === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = consumeRateLimit("speechSynthesis", viewerId);

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Too many synthesis requests. Try again in ${describeRetryAfter(
          limit.retryAfterSeconds,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const body = readBody(payload);

  if (body === null) {
    return NextResponse.json(
      { error: "text and language are required" },
      { status: 400 },
    );
  }

  // Only catalogue languages, so the caller cannot ask for an arbitrary locale
  // and turn this into a general-purpose synthesis proxy.
  if (!isLanguageCode(body.language)) {
    return NextResponse.json(
      { error: "language is not supported" },
      { status: 400 },
    );
  }

  if (body.text.trim().length === 0) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  if (body.text.length > MAX_SYNTHESIS_CHARS) {
    return NextResponse.json(
      { error: `text is limited to ${MAX_SYNTHESIS_CHARS} characters` },
      { status: 413 },
    );
  }

  const result = await synthesizeSpeech(
    body.text,
    speechLocaleFor(body.language),
  );

  if (!result.ok) {
    if (result.reason === "unconfigured") {
      return NextResponse.json(
        { error: "Speech synthesis is not configured", code: "unconfigured" },
        { status: 503 },
      );
    }

    if (result.reason === "unsupported_locale") {
      return NextResponse.json(
        { error: "No voice is available for that language", code: "no_voice" },
        { status: 404 },
      );
    }

    if (result.reason === "too_long") {
      return NextResponse.json({ error: "text is not usable" }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Speech synthesis failed" },
      { status: 502 },
    );
  }

  // `private` because the audio is a fragment of somebody's conversation and must
  // never be held by a shared cache. Immutable because the same text in the same
  // language always yields the same clip, which lets the browser skip repeats
  // entirely.
  return new NextResponse(new Uint8Array(result.audio), {
    headers: {
      "Content-Type": AUDIO_CONTENT_TYPE,
      "Cache-Control": "private, max-age=86400, immutable",
      "Content-Length": String(result.audio.byteLength),
    },
  });
}
