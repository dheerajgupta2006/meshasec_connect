import { LANDING_LANGUAGES } from "@/lib/landing/languages";

/**
 * Scrolling ticker of supported languages.
 *
 * A Server Component: the loop is pure CSS, so this ships no JavaScript. The list
 * is rendered twice — the first copy is the real, readable list and the second is
 * `aria-hidden`, present only so the `marquee-x` keyframe can shift by half the
 * track width and land on an identical frame.
 *
 * Under `prefers-reduced-motion` the global rule in `globals.css` freezes the
 * animation at `translateX(0)`, which leaves the first copy sitting in place and
 * still perfectly legible. The gradient masks at both edges are what make a
 * frozen or mid-scroll track look intentional rather than clipped.
 */
export function LanguageMarquee() {
  return (
    <div className="relative overflow-hidden py-1">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-background to-transparent sm:w-28"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-background to-transparent sm:w-28"
      />

      <div className="flex w-max animate-marquee-x items-center gap-2.5 sm:gap-3">
        <LanguageRun />
        <LanguageRun duplicate />
      </div>
    </div>
  );
}

function LanguageRun({ duplicate = false }: { duplicate?: boolean }) {
  return (
    <ul
      aria-hidden={duplicate ? "true" : undefined}
      aria-label={duplicate ? undefined : "Supported languages"}
      className="flex shrink-0 items-center gap-2.5 sm:gap-3"
    >
      {LANDING_LANGUAGES.map(({ native, english }) => (
        <li
          key={`${duplicate ? "dup" : "main"}-${english}`}
          className="flex shrink-0 items-baseline gap-2 rounded-full border bg-card px-4 py-2 shadow-sm"
        >
          <span className="text-sm font-semibold tracking-tight">{native}</span>
          {/* The exonym is the fallback that still reads if the device has no
              font for the script above it. */}
          {native !== english && (
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {english}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
