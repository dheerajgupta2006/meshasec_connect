import {
  AudioLines,
  CalendarCheck2,
  Check,
  ChevronRight,
  Globe2,
  LayoutDashboard,
  LockKeyhole,
  MessageSquare,
  Mic,
  Monitor,
  MousePointer2,
  PhoneOff,
  Radio,
  ScreenShare,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  WandSparkles,
  Wifi,
  Zap,
} from "lucide-react";
import Link from "next/link";

import { PrimaryCta } from "@/components/auth/primary-cta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const features = [
  {
    icon: Settings2,
    title: "Walk in prepared",
    description:
      "Preview your camera, choose the right microphone and speaker, and enter every conversation with confidence.",
    accent: "from-blue-500/15 to-cyan-500/5",
    iconClass: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  {
    icon: AudioLines,
    title: "Conversations that feel natural",
    description:
      "A media experience designed for clear speech, responsive video, and the moments where timing matters.",
    accent: "from-violet-500/15 to-fuchsia-500/5",
    iconClass: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  {
    icon: LayoutDashboard,
    title: "Your day, at a glance",
    description:
      "See upcoming sessions, revisit meeting history, and move from schedule to lobby without losing focus.",
    accent: "from-emerald-500/15 to-teal-500/5",
    iconClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  {
    icon: ShieldCheck,
    title: "Secure by design",
    description:
      "Authenticated access and room-scoped permissions keep every meeting connected to the right people.",
    accent: "from-amber-500/15 to-orange-500/5",
    iconClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  {
    icon: ScreenShare,
    title: "Built to collaborate",
    description:
      "Bring ideas into the room with a focused interface made for presentations, decisions, and teamwork.",
    accent: "from-sky-500/15 to-indigo-500/5",
    iconClass: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  {
    icon: Globe2,
    title: "Nothing to install",
    description:
      "Join directly from a modern browser on desktop or mobile. One link is all your guests need.",
    accent: "from-rose-500/15 to-pink-500/5",
    iconClass: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
];

const steps = [
  {
    number: "01",
    icon: CalendarCheck2,
    title: "Create your space",
    description:
      "Start an instant meeting or prepare one for later. Every room gets a simple code you can share.",
  },
  {
    number: "02",
    icon: WandSparkles,
    title: "Make it yours",
    description:
      "Set your display name, camera, microphone, and speaker in a calm pre-join experience.",
  },
  {
    number: "03",
    icon: Video,
    title: "Meet and move forward",
    description:
      "Join with one click and keep the conversation centered on people, ideas, and outcomes.",
  },
];

const trustPoints = [
  { icon: Wifi, label: "Low-latency media" },
  { icon: ShieldCheck, label: "Authenticated access" },
  { icon: Monitor, label: "Browser-native" },
];

function MeetingPreview() {
  return (
    <div className="relative mx-auto w-full max-w-2xl lg:mr-0">
      <div className="absolute -inset-8 -z-10 rounded-[3rem] bg-primary/10 blur-3xl" />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 p-2.5 shadow-2xl shadow-primary/10 ring-1 ring-black/10 dark:ring-white/5 sm:rounded-[1.4rem] sm:p-3">
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex h-12 items-center justify-between border-b border-zinc-800 px-3 sm:px-4">
            <div className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-blue-600 text-white">
                <Video className="h-3.5 w-3.5" />
              </span>
              <div>
                <p className="text-[11px] font-medium text-zinc-200 sm:text-xs">
                  Product weekly
                </p>
                <p className="text-[9px] text-zinc-500 sm:text-[10px]">
                  6 participants
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-[9px] font-medium text-zinc-300 sm:text-[10px]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              00:18:42
            </div>
          </div>

          <div className="grid aspect-[1.25/1] grid-cols-2 gap-1.5 bg-zinc-950 p-1.5 sm:aspect-[1.55/1] sm:gap-2 sm:p-2">
            <div className="relative col-span-2 overflow-hidden rounded-lg bg-gradient-to-br from-blue-950 via-slate-900 to-indigo-950 sm:col-span-1 sm:row-span-2">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_65%_25%,rgba(96,165,250,0.2),transparent_30%)]" />
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 to-transparent" />
              <div className="absolute left-1/2 top-[44%] grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/10 bg-blue-500/15 text-lg font-semibold text-blue-100 shadow-xl sm:h-20 sm:w-20 sm:text-xl">
                AR
              </div>
              <div className="absolute bottom-2.5 left-3 flex items-center gap-1.5 text-[10px] font-medium text-white sm:text-xs">
                <span className="grid h-4 w-4 place-items-center rounded-full bg-emerald-500/20 text-emerald-300">
                  <Mic className="h-2.5 w-2.5" />
                </span>
                Alex Rivera
              </div>
              <Badge className="absolute right-2.5 top-2.5 border-0 bg-black/45 px-2 text-[9px] text-zinc-200 hover:bg-black/45">
                Speaking
              </Badge>
            </div>

            <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-violet-950 via-zinc-900 to-fuchsia-950">
              <div className="absolute left-1/2 top-[45%] grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-violet-500/15 text-xs font-semibold text-violet-100 sm:h-14 sm:w-14 sm:text-sm">
                SK
              </div>
              <p className="absolute bottom-2 left-2.5 text-[9px] font-medium text-zinc-100 sm:text-[10px]">
                Sarah Kim
              </p>
            </div>

            <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-emerald-950 via-zinc-900 to-teal-950">
              <div className="absolute left-1/2 top-[45%] grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-100 sm:h-14 sm:w-14 sm:text-sm">
                JM
              </div>
              <p className="absolute bottom-2 left-2.5 text-[9px] font-medium text-zinc-100 sm:text-[10px]">
                Jordan Miles
              </p>
            </div>
          </div>

          <div className="flex h-14 items-center justify-between border-t border-zinc-800 px-3 sm:h-16 sm:px-5">
            <div className="hidden items-center gap-2 text-[10px] text-zinc-500 sm:flex">
              <Radio className="h-3 w-3 text-emerald-400" />
              Connection is excellent
            </div>
            <div className="mx-auto flex items-center gap-2 sm:mx-0">
              {[Mic, Video, ScreenShare, MessageSquare, Users].map((Icon, index) => (
                <span
                  key={index}
                  className="grid h-8 w-8 place-items-center rounded-full border border-zinc-700 bg-zinc-800 text-zinc-300 sm:h-9 sm:w-9"
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
              ))}
              <span className="grid h-8 w-8 place-items-center rounded-full bg-red-500 text-white sm:h-9 sm:w-9">
                <PhoneOff className="h-3.5 w-3.5" />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-5 -left-3 hidden items-center gap-3 rounded-xl border bg-card/95 p-3 shadow-xl backdrop-blur sm:flex lg:-left-8">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <AudioLines className="h-4 w-4" />
        </span>
        <div>
          <p className="text-xs font-semibold">Audio optimized</p>
          <p className="text-[10px] text-muted-foreground">
            Voice is clear and ready
          </p>
        </div>
        <Check className="ml-2 h-4 w-4 text-emerald-500" />
      </div>

      <div className="absolute -right-3 -top-5 hidden items-center gap-2 rounded-full border bg-card/95 px-3 py-2 text-xs font-medium shadow-lg backdrop-blur sm:flex lg:-right-6">
        <LockKeyhole className="h-3.5 w-3.5 text-primary" />
        Room access secured
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="overflow-hidden">
      <section className="relative isolate">
        <div className="absolute inset-0 -z-20 bg-[linear-gradient(to_bottom,hsl(var(--background)),hsl(var(--background)),hsl(var(--muted)/0.5))]" />
        <div className="absolute left-[8%] top-24 -z-10 h-72 w-72 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="absolute right-[5%] top-8 -z-10 h-96 w-96 rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

        <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl items-center gap-14 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[0.92fr_1.08fr] lg:gap-16 lg:px-8 lg:py-24">
          <div className="max-w-2xl">
            <Badge
              variant="outline"
              className="mb-6 gap-2 rounded-full bg-background/70 px-3.5 py-1.5 font-medium shadow-sm backdrop-blur"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              A calmer way to meet online
              <Sparkles className="h-3.5 w-3.5 text-primary" />
            </Badge>

            <h1 className="text-balance text-5xl font-semibold tracking-[-0.045em] sm:text-6xl lg:text-[4.65rem] lg:leading-[0.98]">
              Meetings that feel{" "}
              <span className="bg-gradient-to-r from-blue-600 via-primary to-violet-600 bg-clip-text text-transparent">
                effortless.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-pretty text-lg leading-8 text-muted-foreground sm:text-xl">
              Bring people together in a fast, secure meeting space designed to
              remove friction—and keep every conversation moving forward.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <PrimaryCta />
              <Button
                asChild
                variant="ghost"
                size="lg"
                className="h-12 rounded-xl px-5"
              >
                <Link href="#how-it-works">
                  See how it works
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>

            <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-6">
              {trustPoints.map(({ icon: Icon, label }) => (
                <div
                  key={label}
                  className="flex items-center gap-2 text-xs font-medium text-muted-foreground sm:text-sm"
                >
                  <Icon className="h-4 w-4 text-primary" />
                  {label}
                </div>
              ))}
            </div>
          </div>

          <MeetingPreview />
        </div>
      </section>

      <section className="border-y bg-card/50">
        <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-y px-4 sm:px-6 md:grid-cols-4 md:divide-y-0 lg:px-8">
          {[
            ["One click", "from invite to lobby"],
            ["HD ready", "clear video and audio"],
            ["Room scoped", "secure media access"],
            ["Any device", "modern browser support"],
          ].map(([value, label]) => (
            <div key={value} className="px-4 py-7 text-center sm:py-9">
              <p className="text-xl font-semibold tracking-tight sm:text-2xl">
                {value}
              </p>
              <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                {label}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section id="features" className="scroll-mt-24 py-24 sm:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="secondary" className="mb-4 rounded-full px-3 py-1">
              Designed around your attention
            </Badge>
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
              Everything you need. Nothing in the way.
            </h2>
            <p className="mt-5 text-pretty text-lg leading-8 text-muted-foreground">
              From the moment an invite arrives to the moment a decision is made,
              every detail is built to keep the experience simple.
            </p>
          </div>

          <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, title, description, accent, iconClass }) => (
              <Card
                key={title}
                className="group relative overflow-hidden border-border/70 bg-card/70 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-xl"
              >
                <div
                  className={`absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${accent} opacity-0 transition-opacity duration-300 group-hover:opacity-100`}
                />
                <CardHeader className="relative">
                  <span
                    className={`mb-3 grid h-11 w-11 place-items-center rounded-xl ${iconClass}`}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <CardTitle className="text-xl">{title}</CardTitle>
                </CardHeader>
                <CardContent className="relative">
                  <CardDescription className="text-[15px] leading-7">
                    {description}
                  </CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section
        id="how-it-works"
        className="scroll-mt-24 border-y bg-muted/35 py-24 sm:py-28"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-end gap-8 lg:grid-cols-2">
            <div>
              <Badge variant="outline" className="mb-4 rounded-full bg-background">
                From link to conversation
              </Badge>
              <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
                Ready when you are, in three simple steps.
              </h2>
            </div>
            <p className="max-w-xl text-lg leading-8 text-muted-foreground lg:justify-self-end">
              No downloads, complicated setup, or confusing controls. Meshasec
              Connect gets the details right before the meeting begins.
            </p>
          </div>

          <div className="relative mt-14 grid gap-5 lg:grid-cols-3">
            <div className="absolute left-[16%] right-[16%] top-12 hidden h-px bg-gradient-to-r from-transparent via-border to-transparent lg:block" />
            {steps.map(({ number, icon: Icon, title, description }) => (
              <div
                key={number}
                className="relative rounded-2xl border bg-background p-7 shadow-sm sm:p-8"
              >
                <div className="flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/20">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-sm font-semibold text-muted-foreground/60">
                    {number}
                  </span>
                </div>
                <h3 className="mt-7 text-xl font-semibold">{title}</h3>
                <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="security" className="scroll-mt-24 py-24 sm:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-3xl bg-zinc-950 px-6 py-12 text-zinc-50 shadow-2xl sm:px-10 sm:py-16 lg:px-16">
            <div className="absolute -right-24 -top-32 h-80 w-80 rounded-full bg-blue-600/20 blur-3xl" />
            <div className="absolute -bottom-40 left-1/3 h-80 w-80 rounded-full bg-violet-600/15 blur-3xl" />
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:44px_44px]" />

            <div className="relative grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
              <div>
                <Badge className="mb-5 border border-blue-400/20 bg-blue-400/10 text-blue-300 hover:bg-blue-400/10">
                  <LockKeyhole className="mr-1.5 h-3.5 w-3.5" />
                  Security without the friction
                </Badge>
                <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
                  The right people. The right room. Every time.
                </h2>
                <p className="mt-5 max-w-xl text-lg leading-8 text-zinc-400">
                  Identity-aware access, validated meeting records, and scoped
                  media permissions work together behind a simple experience.
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-2">
                  {[
                    "Authenticated member access",
                    "Room-specific media grants",
                    "Server-generated join tokens",
                    "Protected meeting routes",
                  ].map((item) => (
                    <div key={item} className="flex items-center gap-2.5 text-sm text-zinc-300">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-400/10 text-emerald-400">
                        <Check className="h-3 w-3" />
                      </span>
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              <div className="relative mx-auto w-full max-w-md">
                <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 shadow-2xl backdrop-blur sm:p-5">
                  <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <div className="flex items-center gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-400">
                        <ShieldCheck className="h-5 w-5" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold">Room protection</p>
                        <p className="text-xs text-zinc-500">Active and verified</p>
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
                      ["Room grant", "Scoped access"],
                      ["Token lifetime", "2 hours"],
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
                      <p className="text-[9px] text-zinc-500">Verified in milliseconds</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="pb-24 pt-8 sm:pb-28">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/[0.12] via-card to-violet-500/[0.08] px-6 py-14 text-center shadow-xl sm:px-12 sm:py-16">
            <div className="absolute left-1/2 top-0 h-32 w-96 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
            <div className="relative">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
                <MousePointer2 className="h-5 w-5" />
              </span>
              <h2 className="mx-auto mt-6 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
                Your next great conversation starts here.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-lg leading-8 text-muted-foreground">
                Create your workspace, invite your people, and make every meeting
                feel a little more human.
              </p>
              <div className="mt-8 flex justify-center">
                <PrimaryCta />
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                No downloads. Set up in minutes.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t bg-card/40">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-[1.4fr_0.6fr_0.6fr]">
            <div className="max-w-sm">
              <Link href="/" className="inline-flex items-center gap-2.5 font-semibold">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground">
                  <Video className="h-[18px] w-[18px]" />
                </span>
                Meshasec Connect
              </Link>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Secure, focused video meetings for teams that want technology to
                disappear into the background.
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold">Product</p>
              <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <Link href="/#features" className="hover:text-foreground">Features</Link>
                <Link href="/#how-it-works" className="hover:text-foreground">How it works</Link>
                <Link href="/dashboard" className="hover:text-foreground">Dashboard</Link>
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold">Trust</p>
              <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <Link href="/#security" className="hover:text-foreground">Security</Link>
                <span>Privacy-first design</span>
                <span>Secure access</span>
              </div>
            </div>
          </div>
          <div className="mt-10 flex flex-col gap-3 border-t pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} Meshasec Connect. All rights reserved.</p>
            <p>Made for better conversations.</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
