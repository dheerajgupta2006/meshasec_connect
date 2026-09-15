"use client";

import { ExternalLink, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface LinkPreviewData {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

interface LinkPreviewCardProps {
  url: string;
  /** Outgoing bubbles are dark, so the card needs different contrast. */
  outgoing: boolean;
}

/**
 * Per-tab memo of resolved previews.
 *
 * The same link often appears in several messages, and a thread re-renders on
 * every poll tick. Without this, each render would re-request every preview in
 * view. `null` is cached too, so a link with no preview is not retried on
 * every scroll.
 */
const cache = new Map<string, LinkPreviewData | null>();
/** Deduplicates concurrent requests for the same URL across sibling cards. */
const inFlight = new Map<string, Promise<LinkPreviewData | null>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePreview(payload: unknown): LinkPreviewData | null {
  const outer = asRecord(payload);

  if (outer === null) {
    return null;
  }

  const preview = asRecord(outer.preview);

  if (preview === null) {
    return null;
  }

  const url = readString(preview, "url");

  if (url === null) {
    return null;
  }

  return {
    url,
    canonicalUrl: readString(preview, "canonicalUrl"),
    title: readString(preview, "title"),
    description: readString(preview, "description"),
    imageUrl: readString(preview, "imageUrl"),
    siteName: readString(preview, "siteName"),
  };
}

async function loadPreview(url: string): Promise<LinkPreviewData | null> {
  const cached = cache.get(url);

  if (cached !== undefined) {
    return cached;
  }

  const pending = inFlight.get(url);

  if (pending !== undefined) {
    return pending;
  }

  const request = (async () => {
    try {
      const response = await fetch(
        `/api/link-preview?url=${encodeURIComponent(url)}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        cache.set(url, null);
        return null;
      }

      const parsed = parsePreview(await response.json());
      cache.set(url, parsed);
      return parsed;
    } catch {
      // A failed preview must never break the message it belongs to.
      cache.set(url, null);
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, request);

  return request;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * OpenGraph card for a link shared in a message.
 *
 * Renders nothing until a preview resolves, and nothing at all if there isn't
 * one — an empty card is worse than no card.
 */
export function LinkPreviewCard({ url, outgoing }: LinkPreviewCardProps) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(
    () => cache.get(url) ?? null,
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadPreview(url).then((result) => {
      if (!cancelled && mountedRef.current) {
        setPreview(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (preview === null || (preview.title === null && preview.description === null)) {
    return null;
  }

  const target = preview.canonicalUrl ?? preview.url;
  const host = hostOf(target);

  return (
    <a
      href={target}
      target="_blank"
      // `noreferrer` as well as `noopener`: the destination should not learn
      // which conversation the link was shared in.
      rel="noopener noreferrer"
      className={`mt-2 block overflow-hidden rounded-xl border transition-colors ${
        outgoing
          ? "border-primary-emphasis-foreground/25 bg-black/15 hover:bg-black/25"
          : "border-foreground/15 bg-foreground/[0.04] hover:bg-foreground/[0.08]"
      }`}
    >
      {preview.imageUrl !== null && (
        // Deliberately a plain <img>: next/image needs every preview host in
        // `images.remotePatterns`, and the hosts here are arbitrary by design.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="max-h-40 w-full object-cover"
          // A broken image would otherwise leave a grey slab above the text.
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}

      <div className="px-3 py-2">
        <p
          className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide ${
            outgoing
              ? "text-primary-emphasis-foreground/70"
              : "text-muted-foreground"
          }`}
        >
          <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{preview.siteName ?? host ?? "Link"}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
        </p>

        {preview.title !== null && (
          <p className="mt-1 line-clamp-2 text-sm font-semibold">
            {preview.title}
          </p>
        )}

        {preview.description !== null && (
          <p
            className={`mt-0.5 line-clamp-2 text-xs ${
              outgoing
                ? "text-primary-emphasis-foreground/80"
                : "text-muted-foreground"
            }`}
          >
            {preview.description}
          </p>
        )}
      </div>
    </a>
  );
}
