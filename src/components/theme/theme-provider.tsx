"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Thin client wrapper so the root layout can stay a Server Component.
 *
 * `next-themes` reads `localStorage` and the OS preference, so it has to run on
 * the client; importing it directly into the layout would turn the whole tree
 * into a client bundle.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
