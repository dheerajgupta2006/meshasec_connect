import {
  ClerkProvider,
  SignedIn,
} from "@clerk/nextjs";
import { Video } from "lucide-react";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";

import { HeaderAuthControls } from "@/components/auth/header-auth-controls";
import { IncomingCallBanner } from "@/components/calls/incoming-call-banner";
import { NotificationsMenu } from "@/components/connections/notifications-menu";
import { MarketingNav } from "@/components/marketing-nav";
import { MobileMenu } from "@/components/mobile-menu";
import { CallProvider } from "@/components/meeting/call-provider";
import { MessagesNavLink } from "@/components/messages/messages-nav-link";
import { PushToggle } from "@/components/notifications/push-toggle";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Toaster } from "@/components/ui/sonner";
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { configuredAppOrigin } from "@/lib/meetings/app-origin";

import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  // Required for `opengraph-image` to be advertised as an absolute URL. Without
  // it Next emits a relative path, which most chat apps will not fetch — so the
  // preview card silently never appears.
  metadataBase: new URL(configuredAppOrigin() ?? "http://localhost:3000"),
  title: {
    default: `${APP_NAME} — ${APP_TAGLINE}`,
    template: `%s | ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: `${APP_NAME} — ${APP_TAGLINE}`,
    description: APP_DESCRIPTION,
  },
  twitter: {
    // Large image, because a meeting link pasted into a chat is the main way this
    // app is shared and a thumbnail-sized card wastes the space.
    card: "summary_large_image",
    title: `${APP_NAME} — ${APP_TAGLINE}`,
    description: APP_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    // Meeting and message routes are behind auth, but telling crawlers not to
    // archive anything avoids a stale snapshot of a shared link.
    googleBot: { index: true, follow: true, noarchive: true },
  },
};

/**
 * Next injects a default viewport tag, but not the two settings that matter on
 * a phone:
 *
 * - `interactiveWidget: "resizes-content"` shrinks the layout when the on-screen
 *   keyboard opens. Under the default the keyboard overlays the page, hiding the
 *   bottom-anchored message composer behind it while you type into it.
 * - `themeColor` paints the browser chrome to match, so the address bar does not
 *   sit as a white band above a dark call.
 *
 * `maximumScale`/`userScalable` are deliberately left alone: pinch-zoom is an
 * accessibility requirement and blocking it is a WCAG failure.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Without these, Clerk's post-auth redirect defaults to `/` — so signing in
    // through the header modal dropped you back on the landing page with a
    // "Dashboard" button instead of going there.
    //
    // `fallback`, deliberately not `force`: two flows in this app legitimately
    // carry a `redirect_url`, and `force` would override both. `middleware.ts`
    // protects most routes, so a user who followed a link to a DM thread signs
    // in and must land on that thread; and `GuestGate` links to
    // `/sign-in?redirect_url=/meeting/<code>/lobby`, so an invited guest who
    // chooses to sign in has to arrive at the meeting, not the dashboard.
    // `fallback` honours those and only sends people to the dashboard when there
    // is nowhere else they were headed.
    //
    // Set as props rather than `NEXT_PUBLIC_CLERK_*_FALLBACK_REDIRECT_URL` so the
    // behaviour ships with the code and needs no matching Vercel env var.
    <ClerkProvider
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
    >
      {/* next-themes writes the resolved class onto <html> before paint, which
          the server render cannot predict. Suppressing the warning on this one
          element is the documented way to allow it. */}
      <html lang="en" suppressHydrationWarning>
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            // Transitions on every themed colour would otherwise animate the
            // whole page on switch, which reads as a flash.
            disableTransitionOnChange
          >
          <header className="sticky top-0 z-50 h-16 border-b bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
            <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-2 px-4 sm:gap-6 sm:px-6 lg:px-8">
              <Link
                href="/"
                className="group flex min-w-0 items-center gap-2.5 font-semibold tracking-tight"
                aria-label="Meshasec Connect home"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/25 transition-transform group-hover:scale-105">
                  <Video className="h-[18px] w-[18px]" />
                </span>
                {/* Shortened to just "Connect" on phones. The full wordmark plus
                    the signed-in control cluster does not fit in the ~343px a
                    375px screen leaves, and `truncate` keeps it from forcing the
                    header wider than the viewport if an estimate is ever off. */}
                <span className="truncate text-[15px] sm:text-base">
                  <span className="hidden sm:inline">Meshasec </span>
                  <span className="text-primary">Connect</span>
                </span>
              </Link>

              <MarketingNav />

              <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
                {/* Below `sm` these move into `MobileMenu`; six controls in a row
                    overflow a phone header. */}
                <div className="hidden items-center gap-2.5 sm:flex">
                  <SignedIn>
                    <PushToggle />
                  </SignedIn>
                  <ThemeToggle />
                </div>
                <HeaderAuthControls
                  signedInSlot={
                    <>
                      <MessagesNavLink />
                      <NotificationsMenu />
                    </>
                  }
                />
                <MobileMenu />
              </div>
            </div>
          </header>
          <SignedIn>
            <IncomingCallBanner />
          </SignedIn>
          {/* Holds the LiveKit connection above the router, so navigating does
              not tear the call down. */}
          <CallProvider>{children}</CallProvider>
          <Toaster />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
