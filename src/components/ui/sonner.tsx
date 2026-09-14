"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * App-wide toast host. Styled with the project's semantic tokens so it tracks
 * light and dark mode without a theme provider.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-center"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "group rounded-xl border border-border bg-card text-card-foreground shadow-xl",
          title: "text-sm font-medium",
          description: "text-xs text-muted-foreground",
          actionButton:
            "rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground",
          cancelButton:
            "rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground",
          closeButton: "border-border bg-card text-muted-foreground",
        },
      }}
    />
  );
}
