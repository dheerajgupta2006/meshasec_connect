"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Routes where the marketing links are noise rather than navigation.
 *
 * The links all jump to anchors on the landing page, so following one from
 * inside a call tears the room down. They are hidden here instead.
 */
const HIDDEN_PREFIXES = ["/meeting", "/messages"];

/**
 * Shared with `MobileMenu`, which surfaces these same links below `lg` where
 * this nav hides itself. Exported so there is one list rather than two that
 * drift apart.
 */
export const MARKETING_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#security", label: "Security" },
];

/** Same rule for both navs: anchor links are noise in a call or a DM thread. */
export function isMarketingNavHidden(pathname: string): boolean {
  return HIDDEN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Landing-page navigation, hidden on the pages where it does not belong.
 *
 * A client component so it can read the current path; the root layout stays a
 * Server Component.
 */
export function MarketingNav() {
  const pathname = usePathname();

  if (isMarketingNavHidden(pathname)) {
    return null;
  }

  return (
    <nav
      className="hidden items-center gap-7 text-sm text-muted-foreground lg:flex"
      aria-label="Primary navigation"
    >
      {MARKETING_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="transition-colors hover:text-foreground"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
