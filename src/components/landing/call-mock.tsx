import {
  AudioLines,
  Hand,
  Languages,
  MessageSquare,
  Mic,
  PhoneOff,
  ScreenShare,
  Users,
  Video,
} from "lucide-react";

import { LANDING_LANGUAGES, TRANSLATION_SAMPLE } from "@/lib/landing/languages";

/**
 * The hero's product shot: a mocked call whose subject is live translation.
 *
 * Intentionally hand-built markup rather than a screenshot. A screenshot would go
 * stale the moment the room UI changes, would ship a heavy asset into the largest
 * contentful paint, and could not render crisply at every width. This composes
 * from the same tokens the real room uses.
 *
 * A Server Component — every moving part is a CSS animation, so the hero ships no
 * JavaScript for the visual. The global `prefers-reduced-motion` rule freezes
 * those animations, which is why nothing here conveys meaning through motion
 * alone: the caption, the language tags and the "live" labels are all text.
 *
 * `aria-hidden` on the whole tree is deliberate. It is decorative art, and the
 * hero's heading and body copy already state everything it depicts; reading out
 * "AS, Speaking, Hindi, 00:14:02" would be noise for a screen reader.
 */
export function CallMock() {
  const { speaker, listener, captionSpanish } = TRANSLATION_SAMPLE;

  return (
    <div className="relative mx-auto w-full max-w-2xl lg:mr-0" aria-hidden="true">
      {/* Bloom behind the frame. Sits at -z-10 so it never intercepts pointers. */}
      <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-gradient-to-tr from-primary/25 via-violet-500/15 to-emerald-400/15 blur-3xl" />

      <div className="overflow-hidden rounded-[1.5rem] border border-white/10 bg-zinc-950 p-2 shadow-2xl shadow-primary/20 ring-1 ring-black/10 dark:ring-white/5 sm:rounded-[1.75rem] sm:p-2.5">
        <div className="overflow-hidden rounded-[1.1rem] border border-zinc-800 bg-zinc-900 sm:rounded-[1.3rem]">
          <MockHeader />

          {/* Explicit 3x3 so both layouts fill completely: on a phone the speaker
              takes the top two rows with the three thumbnails in a row beneath,
              and from `sm` it takes two columns with the thumbnails stacked down
              the third. Left implicit, the thumbnails collapse to zero height —
              their children are all absolutely positioned. */}
          <div className="relative grid aspect-[1.18/1] grid-cols-3 grid-rows-3 gap-1.5 bg-zinc-950 p-1.5 sm:aspect-[1.62/1] sm:gap-2 sm:p-2">
            <div className="relative col-span-3 row-span-2 overflow-hidden rounded-xl bg-gradient-to-br from-blue-950 via-slate-900 to-indigo-950 sm:col-span-2 sm:row-span-3">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_62%_22%,rgba(96,165,250,0.22),transparent_34%)]" />
              <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />

              <div className="absolute left-1/2 top-[38%] grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-blue-500/20 text-lg font-semibold text-blue-50 shadow-xl sm:h-20 sm:w-20 sm:text-xl">
                {speaker.initials}
              </div>

              <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[9px] font-semibold text-emerald-300 backdrop-blur sm:text-[10px]">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                Speaking · {speaker.language}
              </span>

              {/* Name plate and caption share one flow container pinned to the
                  bottom, so the plate cannot drift over the caption when the
                  caption wraps to a different number of lines. */}
              <div className="absolute inset-x-2 bottom-2 space-y-1.5 sm:inset-x-3 sm:bottom-3 sm:space-y-2">
                <span className="hidden items-center gap-1.5 text-[11px] font-medium text-white sm:flex">
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-emerald-500/25 text-emerald-300">
                    <Mic className="h-2.5 w-2.5" aria-hidden="true" />
                  </span>
                  {speaker.name}
                </span>

                {/* Caption stack: original above, translation below. The original
                    stays visible because the claim is "understand them", not
                    "replace them" — and checking a name or a number against the
                    source is the common real behaviour. */}
                <div className="rounded-xl border border-white/10 bg-black/65 p-2.5 backdrop-blur-md sm:p-3">
                  <div className="flex items-center gap-1.5">
                    <Languages
                      className="h-3 w-3 shrink-0 text-blue-300"
                      aria-hidden="true"
                    />
                    <span className="truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-blue-200 sm:text-[10px]">
                      {speaker.languageEnglish} → {listener.languageEnglish}
                    </span>
                  </div>
                  <p className="mt-1.5 truncate text-[10px] text-zinc-400 sm:text-[11px]">
                    {speaker.spoken}
                  </p>
                  <p className="mt-1 text-[11px] font-medium leading-snug text-white sm:text-[13px]">
                    {captionSpanish}
                  </p>
                </div>
              </div>
            </div>

            <MockThumb
              initials={listener.initials}
              name={listener.name}
              tag={listener.language}
              tone="from-violet-950 via-zinc-900 to-fuchsia-950"
              ring="bg-violet-500/20 text-violet-50"
            />
            <MockThumb
              initials="JM"
              name="Jordan Miles"
              tag="English"
              tone="from-emerald-950 via-zinc-900 to-teal-950"
              ring="bg-emerald-500/20 text-emerald-50"
            />
            <MockThumb
              initials="YT"
              name="Yuki Tanaka"
              tag="日本語"
              tone="from-amber-950 via-zinc-900 to-orange-950"
              ring="bg-amber-500/20 text-amber-50"
            />
          </div>

          <MockDock />
        </div>
      </div>

      <TranslatedAudioCard language={listener.language} />

      <div className="absolute -right-2 -top-4 hidden items-center gap-2 rounded-full border bg-card/95 px-3.5 py-2 text-xs font-semibold shadow-lg backdrop-blur sm:flex lg:-right-5">
        <Languages className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        Captions in {LANDING_LANGUAGES.length} languages
      </div>
    </div>
  );
}

function MockHeader() {
  return (
    <div className="flex h-11 items-center justify-between gap-2 border-b border-zinc-800 px-2.5 sm:h-12 sm:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Video className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-zinc-200 sm:text-xs">
            Design review
          </p>
          <p className="text-[9px] text-zinc-500 sm:text-[10px]">
            7 across 4 languages
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="hidden items-center gap-1.5 rounded-full border border-blue-400/25 bg-blue-400/10 px-2 py-1 text-[10px] font-medium text-blue-200 sm:inline-flex">
          <Languages className="h-3 w-3" aria-hidden="true" />
          Auto-translate
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-[9px] font-medium text-zinc-300 sm:text-[10px]">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          00:14:02
        </span>
      </div>
    </div>
  );
}

interface MockThumbProps {
  initials: string;
  name: string;
  tag: string;
  tone: string;
  ring: string;
}

function MockThumb({ initials, name, tag, tone, ring }: MockThumbProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${tone}`}
    >
      <div
        className={`absolute left-1/2 top-[42%] grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[10px] font-semibold sm:h-12 sm:w-12 sm:text-xs ${ring}`}
      >
        {initials}
      </div>
      <div className="absolute inset-x-0 bottom-0 space-y-0.5 bg-gradient-to-t from-black/70 to-transparent p-1.5 sm:p-2">
        <p className="truncate text-[8px] font-medium text-zinc-100 sm:text-[10px]">
          {name}
        </p>
        <p className="truncate text-[7px] text-zinc-400 sm:text-[9px]">{tag}</p>
      </div>
    </div>
  );
}

function MockDock() {
  return (
    <div className="flex h-14 items-center justify-between gap-2 border-t border-zinc-800 px-2.5 sm:h-16 sm:px-4">
      <div className="hidden items-center gap-1.5 text-[10px] text-zinc-500 lg:flex">
        <AudioLines className="h-3 w-3 text-emerald-400" aria-hidden="true" />
        Dubbing 120 ms behind
      </div>
      <div className="mx-auto flex items-center gap-1.5 sm:gap-2 lg:mx-0">
        {[Mic, Video, ScreenShare, MessageSquare, Users, Hand].map(
          (Icon, index) => (
            <span
              key={index}
              className="grid h-8 w-8 place-items-center rounded-full border border-zinc-700 bg-zinc-800 text-zinc-300 sm:h-9 sm:w-9"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          ),
        )}
        {/* The captions control is shown engaged, because it is the point of the
            whole illustration. */}
        <span className="grid h-8 w-8 place-items-center rounded-full border border-blue-400/40 bg-blue-500/20 text-blue-200 sm:h-9 sm:w-9">
          <Languages className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-red-500 text-white sm:h-9 sm:w-9">
          <PhoneOff className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

/** Bar heights and delays for the dubbing meter, kept static so it is stable. */
const WAVE_BARS = [
  { height: "h-2", delay: "0ms" },
  { height: "h-4", delay: "120ms" },
  { height: "h-6", delay: "240ms" },
  { height: "h-3", delay: "360ms" },
  { height: "h-5", delay: "480ms" },
  { height: "h-2.5", delay: "600ms" },
];

function TranslatedAudioCard({ language }: { language: string }) {
  return (
    <div className="absolute -bottom-6 -left-2 hidden items-center gap-3 rounded-2xl border bg-card/95 p-3 shadow-xl backdrop-blur sm:flex lg:-left-7">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <AudioLines className="h-4 w-4" aria-hidden="true" />
      </span>
      <div>
        <p className="text-xs font-semibold">Translated audio on</p>
        <p className="text-[10px] text-muted-foreground">
          Hearing everyone in {language}
        </p>
      </div>
      <span className="flex h-6 items-end gap-[3px]">
        {WAVE_BARS.map(({ height, delay }) => (
          <span
            key={delay}
            style={{ animationDelay: delay }}
            className={`w-[3px] rounded-full bg-emerald-500 animate-pulse ${height}`}
          />
        ))}
      </span>
    </div>
  );
}
