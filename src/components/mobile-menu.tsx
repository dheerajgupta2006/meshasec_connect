"use client";

import { SignedIn } from "@clerk/nextjs";
import { LayoutDashboard, Menu, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { isMarketingNavHidden, MARKETING_LINKS } from "@/components/marketing-nav";
import { PushToggle } from "@/components/notifications/push-toggle";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Header overflow menu for narrow viewports.
 *
 * Exists for two reasons, both mobile-only:
 *
 * - `MarketingNav` hides itself below `lg`, so Features / How it works /
 *   Security were unreachable on every phone and tablet. This restores them.
 * - A 375px phone gives the header ~343px of usable width. The signed-in
 *   control cluster (push, theme, dashboard, messages, notifications, account)
 *   needs more than that, and an overflowing header makes the *whole page* pan
 *   sideways — which is what made the app look zoomed out on a phone. The
 *   secondary controls move in here below `sm` instead of being cut off.
 *
 * Hidden from `lg` up, where both the nav and the full cluster fit.
 */
export function MobileMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const showMarketingLinks = !isMarketingNavHidden(pathname);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground lg:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          <Menu className="h-[18px] w-[18px]" aria-hidden="true" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={10}
        // Capped against the viewport rather than a fixed width, matching the
        // pattern already used by the notification and mini-call popovers.
        className="w-[min(17rem,calc(100vw-2rem))] p-2"
      >
        <nav aria-label="Menu">
          {showMarketingLinks && (
            <ul className="space-y-0.5">
              {MARKETING_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="flex h-11 items-center rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* Only shown where the header itself hides these. Above `sm` the
              Dashboard button and both toggles are in the header already, and
              repeating them here would be two controls for one setting. */}
          <div className="sm:hidden">
            <SignedIn>
              {showMarketingLinks && (
                <span aria-hidden="true" className="my-2 block h-px bg-border" />
              )}
              <Link
                href="/dashboard"
                onClick={() => setOpen(false)}
                className="flex h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <LayoutDashboard className="h-4 w-4 shrink-0" aria-hidden="true" />
                Dashboard
              </Link>
              <Link
                href="/dashboard/groups"
                onClick={() => setOpen(false)}
                className="flex h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
                Groups
              </Link>
            </SignedIn>

            <span aria-hidden="true" className="my-2 block h-px bg-border" />

            <div className="flex h-11 items-center justify-between gap-3 px-3">
              <span className="text-sm text-muted-foreground">Theme</span>
              <ThemeToggle />
            </div>

            <SignedIn>
              {/* Renders its own row, and renders nothing at all where the
                  browser has no push support — label included. */}
              <PushToggle rowLabel="Call notifications" />
            </SignedIn>
          </div>
        </nav>
      </PopoverContent>
    </Popover>
  );
}
