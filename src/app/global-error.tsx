"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary, for errors thrown by the root layout itself.
 *
 * `error.tsx` sits *inside* the layout, so it cannot catch a failure in the layout
 * — a Clerk or theme provider throwing, for example. This one replaces the whole
 * document, which is why it must render its own `<html>` and `<body>`.
 *
 * Styling is inline rather than Tailwind: if the layout failed, the stylesheet it
 * imports may never have loaded, and an unstyled page is exactly the outcome this
 * exists to avoid.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("global_error", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#09090b",
          color: "#fafafa",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          padding: "1rem",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 600,
              margin: "0 0 0.75rem",
              letterSpacing: "-0.01em",
            }}
          >
            Meshasec Connect could not start
          </h1>
          <p
            style={{
              margin: "0 0 1.5rem",
              lineHeight: 1.7,
              color: "#a1a1aa",
            }}
          >
            Something failed before the app finished loading. Reloading usually
            clears it.
          </p>

          {error.digest !== undefined && (
            <p
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                color: "#71717a",
                margin: "0 0 1.5rem",
              }}
            >
              Reference: {error.digest}
            </p>
          )}

          <button
            type="button"
            onClick={reset}
            style={{
              appearance: "none",
              border: 0,
              borderRadius: "0.6rem",
              padding: "0.65rem 1.25rem",
              background: "#4f46e5",
              color: "#ffffff",
              fontSize: "0.9rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
