import { ImageResponse } from "next/og";

import { APP_NAME, APP_TAGLINE } from "@/lib/brand";

/**
 * Social preview card, generated at build time from JSX.
 *
 * This app's whole distribution mechanism is pasting a meeting link into a chat,
 * and without an OpenGraph image those links render as a bare URL with no title
 * card — the most visible rough edge the product had.
 *
 * Generated rather than designed so there is no binary asset to keep in sync with
 * the brand, and no design tool in the loop.
 */

export const runtime = "edge";

export const alt = `${APP_NAME} — ${APP_TAGLINE}`;

/** The size every major platform crops from. */
export const size = { width: 1200, height: 630 };

export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background:
            "linear-gradient(135deg, #0b1020 0%, #111827 55%, #020617 100%)",
          color: "#f8fafc",
          fontFamily: "sans-serif",
        }}
      >
        {/* Glow, echoing the radial gradient on the dashboard. */}
        <div
          style={{
            position: "absolute",
            top: -200,
            left: 300,
            width: 700,
            height: 700,
            borderRadius: "9999px",
            background: "rgba(99,102,241,0.28)",
            filter: "blur(120px)",
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            marginBottom: 44,
          }}
        >
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: 22,
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Inline SVG: an icon font would need loading, and this cannot fail. */}
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                stroke="#ffffff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {APP_NAME}
          </div>
        </div>

        <div
          style={{
            fontSize: 68,
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-0.03em",
            maxWidth: 900,
          }}
        >
          {APP_TAGLINE}
        </div>

        <div
          style={{
            marginTop: 30,
            fontSize: 30,
            color: "#a5b4fc",
            maxWidth: 860,
            lineHeight: 1.4,
          }}
        >
          Secure video meetings, direct messaging, and a lobby that respects your
          devices.
        </div>
      </div>
    ),
    size,
  );
}
