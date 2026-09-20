import {
  ArrowRight,
  AudioLines,
  BellRing,
  Brush,
  Captions,
  Check,
  ChevronRight,
  DoorOpen,
  Gauge,
  Globe2,
  GraduationCap,
  Hand,
  Headphones,
  Languages,
  LayoutDashboard,
  Link2,
  ListChecks,
  LockKeyhole,
  MessageSquare,
  Monitor,
  Network,
  Quote,
  ScreenShare,
  Settings2,
  ShieldCheck,
  Smile,
  Sparkles,
  UserPlus,
  Users,
  Video,
  Wifi,
  Zap,
} from "lucide-react";
import Link from "next/link";

import { PrimaryCta } from "@/components/auth/primary-cta";
import { BrandLogo } from "@/components/brand-logo";
import { CallMock } from "@/components/landing/call-mock";
import { Faq, type FaqItem } from "@/components/landing/faq";
import { HeroJoin } from "@/components/landing/hero-join";
import { LanguageMarquee } from "@/components/landing/language-marquee";
import { TranslationShowcase } from "@/components/landing/translation-showcase";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { APP_NAME } from "@/lib/brand";
import {
  isTranslationPreview,
  LANDING_LANGUAGES,
  TRANSLATION_BADGE_LABEL,
} from "@/lib/landing/languages";

/**
 * Landing page.
 *
 * Structure follows the three products this was benchmarked against: a hero that
 * lets a visitor *act* (Jitsi and JioMeet both put a join field on the front
 * page), a pillar band and use-case block (Whereby), then feature depth, trust,
 * and an FAQ.
 *
 * Two rules held while writing the copy:
 *
 * 1. Every claim except live translation maps to code that exists. `npm run
 *    roadmap` is the ledger — recording, file attachments, typing indicators,
 *    presence and group channels are all absent and so appear nowhere here.
 * 2. Live translation is the one forward-looking claim, and it is labelled as
 *    such through `TRANSLATION_BADGE_LABEL` and `isTranslationPreview` rather
 *    than being quietly presented as shipped. Flip `TRANSLATION_STAGE` in
 *    `@/lib/landing/languages` when it lands.
 *
 * Kept a Server Component; the only client pieces are `PrimaryCta` (needs Clerk's
 * signed-in state) and `HeroJoin` (needs the router).
 */

const pillars = [
  {
    icon: Languages,
    title: "Speak your own language",
    description:
      "Live captions and translated voice so a shared language is no longer the price of admission.",
  },
  {
    icon: LockKeyhole,
    title: "Private by default",
    description:
      "Passcoded rooms, a waiting room you control, and join tokens minted per room on the server.",
  },
  {
    icon: Gauge,
    title: "Ready before you join",
    description:
      "Check your camera, pick the right mic, and see your connection quality in the lobby first.",
  },
  {
    icon: Monitor,
    title: "Nothing to install",
    description:
      "A modern browser on any desktop or phone. Guests need one link and a passcode.",
  },
];

const translationCapabilities = [
  {
    icon: Captions,
    title: "Captions in the language you chose",
    description:
      "Subtitles appear in your language while the speaker's original line stays visible underneath, so names, numbers and dates remain checkable against the source.",
  },
  {
    icon: AudioLines,
    title: "Translated audio, not just text",
    description:
      "Turn on a dubbed voice track and listen instead of reading. Your eyes stay on the room, the slide, or the whiteboard.",
  },
  {
    icon: Headphones,
    title: "Per-person, not per-meeting",
    description:
      "Each participant sets their own output language and switches it mid-call. Nobody negotiates a common tongue before the agenda starts.",
  },
];

const roomFeatures = [
  {
    icon: ScreenShare,
    title: "Share your screen",
    description:
      "Present a window, a tab, or the whole desktop, with the active speaker kept in view beside it.",
    iconClass: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    span: "lg:col-span-2",
  },
  {
    icon: ListChecks,
    title: "Polls and Q&A",
    description:
      "Open a poll for a quick decision, or collect questions with upvotes and mark them answered as you go.",
    iconClass: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    span: "",
  },
  {
    icon: Brush,
    title: "Shared whiteboard",
    description:
      "Sketch the idea instead of describing it. Everyone draws on the same canvas in real time.",
    iconClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    span: "",
  },
  {
    icon: Sparkles,
    title: "Blur and virtual backgrounds",
    description:
      "Blur what is behind you or drop in a preset, and upload your own image when a preset will not do.",
    iconClass: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
    span: "",
  },
  {
    icon: Smile,
    title: "Chat, reactions, raised hands",
    description:
      "Side conversation without interrupting the speaker, plus reactions and a raised hand for turn-taking.",
    iconClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    span: "",
  },
  {
    icon: ShieldCheck,
    title: "Host and co-host controls",
    description:
      "Mute one person or everyone, promote a co-host, lock the room, and remove someone so their token stops working.",
    iconClass: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    span: "lg:col-span-2",
  },
];

const aroundTheCall = [
  {
    icon: Settings2,
    title: "A lobby that checks itself",
    description:
      "Camera preview, microphone and speaker pickers, a live input meter, and a network-quality read before you walk in.",
  },
  {
    icon: LayoutDashboard,
    title: "One dashboard",
    description:
      "Upcoming, live and finished meetings in one place, with live participant counts and join-by-code.",
  },
  {
    icon: UserPlus,
    title: "Connections by username",
    description:
      "Send a request, get an email about it, and call or message a contact straight from your list.",
  },
  {
    icon: MessageSquare,
    title: "Direct messages that behave",
    description:
      "Edit, delete, reply and quote, with search across a thread and unread counts in the header.",
  },
  {
    icon: Link2,
    title: "Link previews you can trust",
    description:
      "Pasted URLs unfurl into a preview card, fetched through an SSRF guard and cached server-side.",
  },
  {
    icon: BellRing,
    title: "Push and calendar",
    description:
      "Web push for incoming calls and messages, plus .ics files and Google or Outlook links for scheduled meetings.",
  },
];

const useCases = [
  {
    icon: Network,
    title: "Distributed teams",
    description:
      "Stand-ups across time zones where half the room is speaking their second language. Captions carry the detail that accents blur.",
    points: ["Instant or scheduled rooms", "Calendar invites", "Whiteboard and polls"],
  },
  {
    icon: GraduationCap,
    title: "Teaching and training",
    description:
      "Run a session where every learner reads along in their own language, and use Q&A with upvotes to surface what the room is stuck on.",
    points: ["Q&A with upvotes", "Screen share", "Mute-all for focus"],
  },
  {
    icon: Headphones,
    title: "Client and support calls",
    description:
      "Send a link and a passcode to someone who has never used the product. No sign-up, no download, no explaining an installer.",
    points: ["Guest join by passcode", "Waiting room", "Browser only"],
  },
  {
    icon: Users,
    title: "Communities and interviews",
    description:
      "Admit people one at a time from the waiting room, hand a co-host the controls, and lock the room once everyone is in.",
    points: ["Knock and admit", "Co-host handover", "Lock mid-call"],
  },
];

const steps = [
  {
    number: "01",
    icon: Video,
    title: "Open a room",
    description:
      "Start instantly or schedule for later. Every meeting gets a short code and a six-digit passcode you can share.",
  },
  {
    number: "02",
    icon: Languages,
    title: "Set your language",
    description:
      "Check your camera and mic in the lobby, then choose whether you want captions, translated audio, or both.",
  },
  {
    number: "03",
    icon: Hand,
    title: "Talk like normal",
    description:
      "Everyone speaks the language they think in. Present, sketch, poll and decide without waiting on a translator.",
  },
];

const securityPoints = [
  "Authenticated member access",
  "Six-digit room passcodes",
  "Server-minted, room-scoped join tokens",
  "Waiting room with knock and admit",
  "Lock the room mid-call",
  "Removal that invalidates the token",
  "Guest sessions scoped to one meeting",
  "Trusted-origin enforcement",
];

const faqItems: readonly FaqItem[] = [
  {
    question: "Do guests need an account to join?",
    answer:
      "No. A guest opens the link or types the meeting code on this page, enters the six-digit passcode, picks a display name, and joins. No account is created for them, and their session is scoped to that one meeting.",
  },
  {
    question: "Is there anything to download?",
    answer:
      "Nothing. Everything runs in a modern browser on desktop or mobile — camera, microphone, screen share, whiteboard and backgrounds included.",
  },
  {
    question: "When will live translation be available?",
    answer: isTranslationPreview
      ? "Live captions and translated audio are in active development and are not switched on in calls yet. Every other capability described on this page is already in the product. We would rather tell you what we are building than quietly ship a half-working caption track over your meeting."
      : "Live captions and translated audio are available in calls today. Each participant picks their own output language from the control dock and can change it at any point.",
  },
  {
    question: "How much control does a host have?",
    answer:
      "Hosts can mute one person or the whole room, turn on a waiting room and admit people individually, lock the room so nobody else gets in, promote a co-host, and remove someone in a way that stops their existing join token from working.",
  },
  {
    question: "What happens if I navigate away during a call?",
    answer:
      "The call keeps running. It moves into a compact bar so you can open your dashboard or reply to a message without dropping out and rejoining.",
  },
  {
    question: "Can I put a meeting on my calendar?",
    answer:
      "Yes. Scheduled meetings produce a downloadable .ics file plus one-click links for Google Calendar and Outlook, each carrying the meeting code.",
  },
];

const heroTrust = [
  { icon: Wifi, label: "Low-latency media" },
  { icon: LockKeyhole, label: "Passcoded rooms" },
  { icon: Languages, label: `${LANDING_LANGUAGES.length}+ languages` },
];

export default function HomePage() {
  return (
    <main className="overflow-hidden">
      <HeroSection />
      <PillarBand />
      <LanguageBand />
      <TranslationSection />
      <RoomFeaturesSection />
      <AroundTheCallSection />
      <UseCasesSection />
      <HowItWorksSection />
      <SecuritySection />
      <FaqSection />
      <ClosingCta />
      <SiteFooter />
    </main>
  );
}

function HeroSection() {
  return (
    <section className="relative isolate">
      {/* Background stack, all behind the content and all pointer-transparent.
          `drift` is decorative only and is frozen under reduced-motion. */}
      <div className="absolute inset-0 -z-20 bg-[linear-gradient(to_bottom,hsl(var(--background)),hsl(var(--background)),hsl(var(--muted)/0.6))]" />
      <div className="absolute left-[6%] top-16 -z-10 h-72 w-72 animate-drift rounded-full bg-primary/15 blur-3xl" />
      <div className="absolute right-[4%] top-4 -z-10 h-[26rem] w-[26rem] animate-drift rounded-full bg-violet-500/15 blur-3xl [animation-delay:3s]" />
      <div className="absolute bottom-0 left-1/3 -z-10 h-72 w-72 animate-drift rounded-full bg-emerald-400/10 blur-3xl [animation-delay:6s]" />
      <div className="absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl items-center gap-14 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[0.95fr_1.05fr] lg:gap-14 lg:px-8 lg:py-24">
        <div className="max-w-2xl">
          <Badge
            variant="outline"
            className="mb-6 gap-2 rounded-full bg-background/70 px-3.5 py-1.5 font-medium shadow-sm backdrop-blur"
          >
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            {TRANSLATION_BADGE_LABEL}
          </Badge>

          <h1 className="text-balance text-[2.75rem] font-semibold leading-[1.03] tracking-[-0.045em] sm:text-6xl lg:text-[4.4rem]">
            Everyone speaks.{" "}
            <span className="bg-gradient-to-r from-blue-600 via-primary to-violet-600 bg-clip-text text-transparent">
              Everyone understands.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-lg leading-8 text-muted-foreground sm:text-xl">
            {APP_NAME} is a secure browser-based meeting room where language stops
            being the bottleneck. Live captions and translated audio are on the
            way; the rest — passcoded rooms, a lobby that checks your setup,
            whiteboard, polls and host controls — is here today.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <PrimaryCta />
            <Button
              asChild
              variant="ghost"
              size="lg"
              className="h-12 rounded-xl px-5"
            >
              <Link href="#translation">
                See how translation works
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>

          <div className="mt-8 max-w-lg">
            <div className="mb-3 flex items-center gap-3">
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                or join a meeting
              </span>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </div>
            <HeroJoin />
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-6">
            {heroTrust.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-2 text-xs font-medium text-muted-foreground sm:text-sm"
              >
                <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                {label}
              </div>
            ))}
          </div>
        </div>

        <CallMock />
      </div>
    </section>
  );
}

function PillarBand() {
  return (
    <section className="border-y bg-card/50" aria-label={`Why ${APP_NAME}`}>
      {/* `divide-*` rather than a `gap-px` grid on a tinted parent: the cells
          inherit the band's translucent background, so giving them their own
          would stack the alpha and make this strip a shade off from the rest. */}
      <div className="mx-auto grid max-w-7xl divide-x divide-y sm:grid-cols-2 lg:grid-cols-4 lg:divide-y-0">
        {pillars.map(({ icon: Icon, title, description }) => (
          <div key={title} className="px-5 py-8 sm:px-7 sm:py-10">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <h2 className="mt-4 text-base font-semibold tracking-tight">
              {title}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LanguageBand() {
  return (
    <section className="border-b bg-muted/30 py-12 sm:py-14">
      <div className="mx-auto mb-8 max-w-3xl px-4 text-center sm:px-6">
        <h2 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
          Built for the languages your meetings are actually held in
        </h2>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          Starting with {LANDING_LANGUAGES.length} and growing, including deep
          coverage of Indian languages.
        </p>
      </div>
      <LanguageMarquee />
    </section>
  );
}

function TranslationSection() {
  return (
    <section id="translation" className="scroll-mt-24 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid items-start gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <div>
            <Badge
              variant="secondary"
              className="mb-4 gap-1.5 rounded-full px-3 py-1"
            >
              <Languages className="h-3.5 w-3.5" aria-hidden="true" />
              {TRANSLATION_BADGE_LABEL}
            </Badge>
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
              Say it once. Heard in every language in the room.
            </h2>
            <p className="mt-5 max-w-xl text-pretty text-lg leading-8 text-muted-foreground">
              Most meetings quietly tax whoever is furthest from the shared
              language — they spend the call decoding instead of contributing.
              Live translation removes that tax in both directions: read it, or
              hear it.
            </p>

            <dl className="mt-10 space-y-8">
              {translationCapabilities.map(
                ({ icon: Icon, title, description }) => (
                  <div key={title} className="flex gap-4">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <dt className="text-lg font-semibold tracking-tight">
                        {title}
                      </dt>
                      <dd className="mt-1.5 text-[15px] leading-7 text-muted-foreground">
                        {description}
                      </dd>
                    </div>
                  </div>
                ),
              )}
            </dl>

            {/* Honesty note. It is deliberately not styled as a warning — it is
                a roadmap statement, and burying it would make every claim above
                it less trustworthy. */}
            {isTranslationPreview && (
              <p className="mt-9 flex gap-3 rounded-xl border border-dashed bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
                <Quote
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span>
                  Straight answer: live captions and translated audio are in
                  active development and are not switched on in calls yet.
                  Everything else described on this page is already in the
                  product.
                </span>
              </p>
            )}
          </div>

          <TranslationShowcase />
        </div>
      </div>
    </section>
  );
}

function RoomFeaturesSection() {
  return (
    <section
      id="features"
      className="scroll-mt-24 border-y bg-muted/30 py-24 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="outline" className="mb-4 rounded-full bg-background">
            Inside the room
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            The tools you reach for, already in the dock
          </h2>
          <p className="mt-5 text-pretty text-lg leading-8 text-muted-foreground">
            Not a feature list bolted on after the fact. Each of these is one tap
            from the call you are already in.
          </p>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {roomFeatures.map(
            ({ icon: Icon, title, description, iconClass, span }) => (
              <Card
                key={title}
                className={`group border-border/70 bg-card/80 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-xl ${span}`}
              >
                <CardHeader>
                  <span
                    className={`mb-3 grid h-11 w-11 place-items-center rounded-xl ${iconClass}`}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <CardTitle className="text-xl">{title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-[15px] leading-7">
                    {description}
                  </CardDescription>
                </CardContent>
              </Card>
            ),
          )}
        </div>
      </div>
    </section>
  );
}

function AroundTheCallSection() {
  return (
    <section className="py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid items-end gap-8 lg:grid-cols-2">
          <div>
            <Badge variant="secondary" className="mb-4 rounded-full px-3 py-1">
              Before and after
            </Badge>
            <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
              A meeting is more than the thirty minutes it occupies
            </h2>
          </div>
          <p className="max-w-xl text-lg leading-8 text-muted-foreground lg:justify-self-end">
            Scheduling, setup, the follow-up thread and the call you take from
            your phone are all part of the same job. They live in the same place
            here.
          </p>
        </div>

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {aroundTheCall.map(({ icon: Icon, title, description }) => (
            <div key={title} className="bg-card p-6 sm:p-7">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-muted text-foreground">
                <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-[17px] font-semibold tracking-tight">
                {title}
              </h3>
              <p className="mt-2 text-[15px] leading-7 text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function UseCasesSection() {
  return (
    <section
      id="use-cases"
      className="scroll-mt-24 border-y bg-card/40 py-24 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="outline" className="mb-4 rounded-full bg-background">
            Where it fits
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            Four rooms, one set of controls
          </h2>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {useCases.map(({ icon: Icon, title, description, points }) => (
            <div
              key={title}
              className="flex flex-col rounded-2xl border bg-background p-7 shadow-sm sm:p-8"
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/20">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-xl font-semibold tracking-tight">
                {title}
              </h3>
              <p className="mt-3 flex-1 text-[15px] leading-7 text-muted-foreground">
                {description}
              </p>
              <ul className="mt-5 flex flex-wrap gap-2 border-t pt-5">
                {points.map((point) => (
                  <li
                    key={point}
                    className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
                  >
                    <Check
                      className="h-3 w-3 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  return (
    <section id="how-it-works" className="scroll-mt-24 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="secondary" className="mb-4 rounded-full px-3 py-1">
            From link to conversation
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            Three steps, none of them a download
          </h2>
        </div>

        <div className="relative mt-14 grid gap-5 lg:grid-cols-3">
          <div
            aria-hidden="true"
            className="absolute left-[16%] right-[16%] top-12 hidden h-px bg-gradient-to-r from-transparent via-border to-transparent lg:block"
          />
          {steps.map(({ number, icon: Icon, title, description }) => (
            <div
              key={number}
              className="relative rounded-2xl border bg-card p-7 shadow-sm sm:p-8"
            >
              <div className="flex items-center justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/20">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="font-mono text-sm font-semibold text-muted-foreground/60">
                  {number}
                </span>
              </div>
              <h3 className="mt-7 text-xl font-semibold tracking-tight">
                {title}
              </h3>
              <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-col items-start gap-4 rounded-2xl border border-dashed bg-muted/40 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
          <div className="flex gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-background text-primary shadow-sm">
              <DoorOpen className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-[17px] font-semibold tracking-tight">
                Inviting someone without an account?
              </h3>
              <p className="mt-1.5 text-[15px] leading-7 text-muted-foreground">
                Send them the link and the six-digit passcode. They type a name
                and join — no sign-up, and their access ends with the meeting.
              </p>
            </div>
          </div>
          <Button
            asChild
            variant="outline"
            className="h-11 w-full shrink-0 rounded-xl sm:w-auto"
          >
            <Link href="#faq">
              Guest questions
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function SecuritySection() {
  return (
    <section id="security" className="scroll-mt-24 pb-24 sm:pb-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Deliberately dark in both themes. The section is about the room being
            sealed, and the existing dashboard cards use the same device. */}
        <div className="relative overflow-hidden rounded-3xl bg-zinc-950 px-6 py-12 text-zinc-50 shadow-2xl sm:px-10 sm:py-16 lg:px-16">
          <div className="absolute -right-24 -top-32 h-80 w-80 rounded-full bg-blue-600/20 blur-3xl" />
          <div className="absolute -bottom-40 left-1/3 h-80 w-80 rounded-full bg-violet-600/15 blur-3xl" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:44px_44px]" />

          <div className="relative grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <Badge className="mb-5 border border-blue-400/20 bg-blue-400/10 text-blue-300 hover:bg-blue-400/10">
                <LockKeyhole className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Security without the friction
              </Badge>
              <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
                An open door is a decision, not a default
              </h2>
              <p className="mt-5 max-w-xl text-lg leading-8 text-zinc-400">
                Guests get in through a passcode you control, not a URL that
                leaked. Hosts can lock the room, admit people one at a time, and
                remove someone in a way that stops their token from working
                again.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {securityPoints.map((item) => (
                  <div
                    key={item}
                    className="flex items-center gap-2.5 text-sm text-zinc-300"
                  >
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-400/10 text-emerald-400">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </span>
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-md" aria-hidden="true">
              <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 shadow-2xl backdrop-blur sm:p-5">
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-400">
                      <ShieldCheck className="h-5 w-5" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold">Room protection</p>
                      <p className="text-xs text-zinc-500">
                        Active and verified
                      </p>
                    </div>
                  </div>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Secure
                  </span>
                </div>
                <div className="space-y-3 pt-4">
                  {[
                    ["Identity", "Authenticated"],
                    ["Passcode", "6 digits"],
                    ["Waiting room", "Host admits"],
                    ["Room grant", "Scoped access"],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-black/20 px-4 py-3"
                    >
                      <span className="text-xs text-zinc-500">{label}</span>
                      <span className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="absolute -bottom-4 -right-3 rounded-xl border border-white/10 bg-zinc-900 px-3 py-2.5 shadow-xl sm:-right-6">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-amber-400" />
                  <div>
                    <p className="text-[10px] font-semibold">Access granted</p>
                    <p className="text-[9px] text-zinc-500">
                      Verified in milliseconds
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section id="faq" className="scroll-mt-24 border-t bg-muted/30 py-24 sm:py-28">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="outline" className="mb-4 rounded-full bg-background">
            Straight answers
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Questions people actually ask
          </h2>
        </div>
        <div className="mt-12">
          <Faq items={faqItems} />
        </div>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="py-24 sm:py-28">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/[0.12] via-card to-violet-500/[0.08] px-6 py-14 text-center shadow-xl sm:px-12 sm:py-16">
          <div className="absolute left-1/2 top-0 h-32 w-96 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <Languages className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 className="mx-auto mt-6 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
              Stop choosing a language for the room
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-8 text-muted-foreground">
              Open a room, share a code, and let everyone contribute in the
              language they think in.
            </p>
            <div className="mt-8 flex justify-center">
              <PrimaryCta />
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              No downloads. Guests join with a code and a passcode.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  const columns = [
    {
      heading: "Product",
      links: [
        { href: "/#translation", label: "Live translation" },
        { href: "/#features", label: "In the room" },
        { href: "/#how-it-works", label: "How it works" },
        { href: "/dashboard", label: "Dashboard" },
      ],
    },
    {
      heading: "Use cases",
      links: [
        { href: "/#use-cases", label: "Distributed teams" },
        { href: "/#use-cases", label: "Teaching" },
        { href: "/#use-cases", label: "Client calls" },
        { href: "/#use-cases", label: "Communities" },
      ],
    },
    {
      heading: "Trust",
      links: [
        { href: "/#security", label: "Security" },
        { href: "/#faq", label: "FAQ" },
      ],
    },
  ];

  return (
    <footer className="border-t bg-card/40">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.5fr_repeat(3,0.6fr)]">
          <div className="max-w-sm">
            <BrandLogo />
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Secure, browser-based meetings built so that the language someone
              speaks is not the thing that decides how much they get to
              contribute.
            </p>
            <p className="mt-5 inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <Languages className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              {LANDING_LANGUAGES.length}+ languages planned
            </p>
          </div>

          {columns.map(({ heading, links }) => (
            <div key={heading}>
              <h2 className="text-sm font-semibold">{heading}</h2>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                {links.map(({ href, label }) => (
                  <li key={label}>
                    <Link href={href} className="hover:text-foreground">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {APP_NAME}. All rights reserved.
          </p>
          <p className="inline-flex items-center gap-1.5">
            <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
            Built for conversations that cross borders.
          </p>
        </div>
      </div>
    </footer>
  );
}
