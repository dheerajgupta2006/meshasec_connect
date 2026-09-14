import {
  ClerkProvider,
  SignedIn,
} from "@clerk/nextjs";
import { Video } from "lucide-react";
import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";

import { HeaderAuthControls } from "@/components/auth/header-auth-controls";
import { IncomingCallBanner } from "@/components/calls/incoming-call-banner";
import { NotificationsMenu } from "@/components/connections/notifications-menu";
import { MessagesNavLink } from "@/components/messages/messages-nav-link";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Toaster } from "@/components/ui/sonner";

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
  title: {
    default: "Meshasec Connect — Meetings that move work forward",
    template: "%s | Meshasec Connect",
  },
  description:
    "Secure, high-quality video meetings with a focused pre-join experience and effortless collaboration.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
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
            <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
              <Link
                href="/"
                className="group flex items-center gap-2.5 font-semibold tracking-tight"
                aria-label="Meshasec Connect home"
              >
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/25 transition-transform group-hover:scale-105">
                  <Video className="h-[18px] w-[18px]" />
                </span>
                <span className="text-[15px] sm:text-base">
                  Meshasec <span className="text-primary">Connect</span>
                </span>
              </Link>

              <nav
                className="hidden items-center gap-7 text-sm text-muted-foreground lg:flex"
                aria-label="Primary navigation"
              >
                <Link
                  href="/#features"
                  className="transition-colors hover:text-foreground"
                >
                  Features
                </Link>
                <Link
                  href="/#how-it-works"
                  className="transition-colors hover:text-foreground"
                >
                  How it works
                </Link>
                <Link
                  href="/#security"
                  className="transition-colors hover:text-foreground"
                >
                  Security
                </Link>
              </nav>

              <div className="flex items-center gap-1.5 sm:gap-2.5">
                <ThemeToggle />
                <HeaderAuthControls
                  signedInSlot={
                    <>
                      <MessagesNavLink />
                      <NotificationsMenu />
                    </>
                  }
                />
              </div>
            </div>
          </header>
          <SignedIn>
            <IncomingCallBanner />
          </SignedIn>
          {children}
          <Toaster />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
