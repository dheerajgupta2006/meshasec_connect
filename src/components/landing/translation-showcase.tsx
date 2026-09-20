import {
  ArrowRight,
  AudioLines,
  Captions,
  Check,
  Languages,
  Mic,
  Waypoints,
} from "lucide-react";

import { TRANSLATION_SAMPLE } from "@/lib/landing/languages";

/**
 * Visual for the `#translation` section.
 *
 * Two stacked cards, because the feature has two ideas that a single picture
 * blurs together:
 *
 * 1. Each participant chooses their own output language. Nobody negotiates a
 *    shared one, which is the actual difference from "the meeting is in English".
 * 2. One spoken sentence fans out into a caption and a dubbed voice per person.
 *
 * Server Component, decorative, `aria-hidden` — the surrounding prose carries the
 * same information for assistive technology.
 */
export function TranslationShowcase() {
  return (
    <div className="relative" aria-hidden="true">
      <div className="absolute -inset-5 -z-10 rounded-[2.5rem] bg-gradient-to-br from-primary/15 via-transparent to-emerald-400/15 blur-2xl" />
      <div className="space-y-4">
        <PipelineCard />
        <PreferencesCard />
      </div>
    </div>
  );
}

const PIPELINE = [
  { icon: Mic, label: "Speech", detail: "हिन्दी in" },
  { icon: Waypoints, label: "Translate", detail: "on the fly" },
  { icon: Captions, label: "Captions", detail: "per viewer" },
  { icon: AudioLines, label: "Voice", detail: "dubbed out" },
];

function PipelineCard() {
  return (
    <div className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">One sentence, four steps</p>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Near real time
        </span>
      </div>

      {/* A 2x2 on phones and a single row from `sm`. The connecting arrows only
          appear in the row layout, where they actually point somewhere. */}
      <ol className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr))] sm:gap-1">
        {PIPELINE.map(({ icon: Icon, label, detail }, index) => (
          <li key={label} className="flex items-center gap-1 sm:gap-1.5">
            <div className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-3 text-center">
              <span className="mx-auto grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <p className="mt-2 truncate text-xs font-semibold">{label}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {detail}
              </p>
            </div>
            {index < PIPELINE.length - 1 && (
              <ArrowRight
                className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground/60 sm:block"
                aria-hidden="true"
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Per-participant output language. The middle row is shown mid-change to make the
 * point that it is a personal setting, adjustable during the call.
 */
const PREFERENCES = [
  {
    initials: "EC",
    name: "Elena Costa",
    language: "Español",
    mode: "Captions + audio",
    tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    active: true,
  },
  {
    initials: "JM",
    name: "Jordan Miles",
    language: "English",
    mode: "Captions only",
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    active: false,
  },
  {
    initials: "YT",
    name: "Yuki Tanaka",
    language: "日本語",
    mode: "Captions + audio",
    tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    active: false,
  },
];

function PreferencesCard() {
  const { speaker } = TRANSLATION_SAMPLE;

  return (
    <div className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Everyone picks their own</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {speaker.name} keeps speaking {speaker.language}
          </p>
        </div>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Languages className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>

      <ul className="mt-4 space-y-2">
        {PREFERENCES.map(({ initials, name, language, mode, tone, active }) => (
          <li
            key={name}
            className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${
              active ? "border-primary/40 bg-primary/[0.06]" : "bg-background"
            }`}
          >
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${tone}`}
            >
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{name}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {mode}
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11px] font-semibold">
              {language}
              <Check
                className="h-3 w-3 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
