"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/** The three states, in the order the button cycles through them. */
const ORDER = ["system", "light", "dark"] as const;

type ThemeChoice = (typeof ORDER)[number];

const LABELS: Record<ThemeChoice, string> = {
  system: "Match system",
  light: "Light",
  dark: "Dark",
};

function isThemeChoice(value: string | undefined): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Cycles system → light → dark.
 *
 * A three-way cycle rather than a two-way switch so "follow my OS" stays
 * reachable; a plain toggle silently pins the theme forever after one click.
 */
export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  // The server cannot know the stored preference, so rendering the real icon on
  // the first pass would mismatch and get replaced. Render a stable placeholder
  // until mounted instead.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const choice: ThemeChoice = isThemeChoice(theme) ? theme : "system";

  function advance() {
    const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    setTheme(next);
  }

  if (!mounted) {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9"
        aria-label="Change theme"
        disabled
      >
        <Sun className="h-[18px] w-[18px]" />
      </Button>
    );
  }

  const Icon =
    choice === "system" ? Monitor : resolvedTheme === "dark" ? Moon : Sun;

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={advance}
      className="h-9 w-9 text-muted-foreground hover:text-foreground"
      // The label carries the current state because the icon alone does not
      // announce it, and the state is what a screen reader user needs.
      aria-label={`Theme: ${LABELS[choice]}. Activate to switch.`}
      title={`Theme: ${LABELS[choice]}`}
    >
      <Icon className="h-[18px] w-[18px]" />
    </Button>
  );
}
