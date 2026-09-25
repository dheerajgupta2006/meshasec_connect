/**
 * Choosing an Azure voice for a language.
 *
 * Kept pure and separate from the network code in `azure-tts.ts` so the selection
 * rules are testable without a key or a request.
 *
 * ## Why the voice list is fetched rather than hardcoded
 *
 * Azure names voices like `te-IN-MohanNeural`, and that catalogue changes: voices
 * are added, renamed and retired. A hardcoded table would be wrong the moment
 * Microsoft edits theirs, and the failure mode is a 400 at runtime for one
 * language while every other language works — the kind of bug that survives
 * testing and surfaces to whichever user speaks that language. Asking Azure what
 * exists is self-correcting.
 */

/** One entry from Azure's `/cognitiveservices/voices/list` response. */
export interface AzureVoice {
  /** BCP 47 tag, always regional here, e.g. `te-IN`. */
  Locale: string;
  /** The name passed back in SSML, e.g. `te-IN-MohanNeural`. */
  ShortName: string;
  /** `Neural` for the current generation. */
  VoiceType: string;
  Gender: string;
}

/** The bare language subtag, so `te-IN` and `te` compare equal. */
function baseLanguage(tag: string): string {
  const separator = tag.indexOf("-");

  return (separator === -1 ? tag : tag.slice(0, separator)).toLowerCase();
}

/**
 * Narrows one untrusted entry from the voice list.
 *
 * Azure's response is trusted infrastructure, but it is still parsed rather than
 * cast: a shape change should drop the offending entry, not crash synthesis for
 * every language at once.
 */
export function parseAzureVoice(value: unknown): AzureVoice | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.Locale !== "string" ||
    record.Locale.length === 0 ||
    typeof record.ShortName !== "string" ||
    record.ShortName.length === 0
  ) {
    return null;
  }

  return {
    Locale: record.Locale,
    ShortName: record.ShortName,
    VoiceType: typeof record.VoiceType === "string" ? record.VoiceType : "",
    Gender: typeof record.Gender === "string" ? record.Gender : "",
  };
}

/** Narrows the whole list, discarding entries that do not parse. */
export function parseAzureVoices(payload: unknown): AzureVoice[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const voices: AzureVoice[] = [];

  payload.forEach((entry: unknown) => {
    const voice = parseAzureVoice(entry);

    if (voice !== null) {
      voices.push(voice);
    }
  });

  return voices;
}

/**
 * Picks the best voice for `locale`, or null when Azure offers none.
 *
 * Matching falls back to the base subtag, so a `ta-LK` voice serves Tamil when no
 * `ta-IN` one exists — a regional accent is far better than silence. Neural
 * voices win over older ones because they are the only generation still improving
 * and the quality gap is audible.
 */
export function selectAzureVoice(
  voices: readonly AzureVoice[],
  locale: string,
): AzureVoice | null {
  const wanted = baseLanguage(locale);
  const candidates = voices.filter(
    (voice) => baseLanguage(voice.Locale) === wanted,
  );

  if (candidates.length === 0) {
    return null;
  }

  const exact = candidates.filter(
    (voice) => voice.Locale.toLowerCase() === locale.toLowerCase(),
  );
  const pool = exact.length > 0 ? exact : candidates;

  const neural = pool.filter((voice) => voice.VoiceType === "Neural");

  // Deterministic rather than "first in the response": a voice that changes
  // between deployments makes a caller's audio cache useless.
  const chosen = (neural.length > 0 ? neural : pool)
    .slice()
    .sort((left, right) => left.ShortName.localeCompare(right.ShortName));

  return chosen[0] ?? null;
}

/**
 * Which of `locales` Azure can speak.
 *
 * Used to tell the browser what the server can cover, so a picker can offer a
 * language the device itself has no voice for.
 */
export function speakableLocales(
  voices: readonly AzureVoice[],
  locales: readonly string[],
): string[] {
  return locales.filter((locale) => selectAzureVoice(voices, locale) !== null);
}

/**
 * Escapes text for inclusion in SSML.
 *
 * Mandatory, not defensive. The text is a live transcript of whatever somebody
 * said, and a stray `&` or `<` would make Azure reject the whole request — so an
 * unescaped ampersand silently breaks dubbing for one sentence.
 */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wraps text in the SSML document Azure's REST endpoint expects. */
export function buildSsml(
  text: string,
  voice: AzureVoice,
  rate: string,
): string {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voice.Locale}">` +
    `<voice name="${voice.ShortName}">` +
    `<prosody rate="${rate}">${escapeSsml(text)}</prosody>` +
    `</voice></speak>`
  );
}
