import { Plus } from "lucide-react";

export interface FaqItem {
  question: string;
  answer: string;
}

/**
 * Landing-page FAQ built on native `<details>`/`<summary>`.
 *
 * No Radix accordion is installed, and adding one would ship client JavaScript to
 * do what the platform already does: `<details>` is keyboard operable, announced
 * correctly as a disclosure, and works before hydration — which matters on a
 * marketing page where the first interaction often beats the JS bundle.
 *
 * The `group-open:` variants handle the open state purely in CSS. The `+`/`−`
 * affordance is a rotated `Plus` rather than a `ChevronDown`, so the control still
 * reads as expandable if the rotation is frozen by reduced-motion.
 */
export function Faq({ items }: { items: readonly FaqItem[] }) {
  return (
    <div className="divide-y rounded-2xl border bg-card">
      {items.map(({ question, answer }) => (
        <details key={question} className="group px-5 sm:px-6">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-left font-medium marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-webkit-details-marker]:hidden">
            <span className="text-[15px] leading-6">{question}</span>
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground transition-transform duration-200 group-open:rotate-45 group-open:border-primary/40 group-open:text-primary">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </summary>
          <p className="pb-5 pr-10 text-[15px] leading-7 text-muted-foreground">
            {answer}
          </p>
        </details>
      ))}
    </div>
  );
}
