"use client";

import { LoaderCircle, Search, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  searchDirectMessages,
  type MessageSearchResultView,
} from "@/app/messages/actions";
import { Input } from "@/components/ui/input";
import { MIN_SEARCH_CHARS } from "@/lib/messages/search-limits";

/**
 * How long to wait after the last keystroke before querying.
 *
 * Every search is a `LIKE` scan against the message table, so firing per
 * keystroke would be one full scan per character typed.
 */
const DEBOUNCE_MS = 300;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Keyword search across the viewer's own conversations.
 *
 * The action underneath resolves the viewer from the session, so this component
 * cannot be made to search anyone else's threads regardless of what it sends.
 */
export function MessageSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSearchResultView[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  /**
   * Monotonic id per request. A slow earlier search must not overwrite the
   * results of a later one that has already returned.
   */
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (value: string) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setStatus("searching");
    setError(null);

    const outcome = await searchDirectMessages(value);

    // Stale response, or the component went away mid-flight.
    if (!mountedRef.current || requestId !== requestIdRef.current) {
      return;
    }

    setStatus("done");

    if (!outcome.ok) {
      setError(outcome.message);
      setResults([]);
      return;
    }

    setResults(outcome.results);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < MIN_SEARCH_CHARS) {
      // Cancels any in-flight result from a longer query that is being deleted.
      requestIdRef.current += 1;
      setResults([]);
      setStatus("idle");
      setError(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void run(trimmed);
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query, run]);

  const trimmed = query.trim();
  const showResults = trimmed.length >= MIN_SEARCH_CHARS;

  return (
    <div className="mb-6">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <label className="sr-only" htmlFor="message-search">
          Search your messages
        </label>
        <Input
          id="message-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your messages"
          autoComplete="off"
          className="h-11 border-input-strong pl-9 pr-10"
          aria-describedby="message-search-status"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Announced politely so a screen reader hears the count without the
          results list stealing focus on every keystroke. */}
      <p
        id="message-search-status"
        role="status"
        aria-live="polite"
        className="mt-2 min-h-5 text-xs text-muted-foreground"
      >
        {error !== null
          ? error
          : status === "searching"
            ? "Searching…"
            : showResults && status === "done"
              ? results.length === 0
                ? "No messages matched."
                : `${results.length} match${results.length === 1 ? "" : "es"}`
              : trimmed.length > 0
                ? `Type at least ${MIN_SEARCH_CHARS} characters.`
                : ""}
      </p>

      {showResults && results.length > 0 && (
        <ul className="mt-3 space-y-2">
          {results.map((hit) => (
            <li key={hit.id}>
              <Link
                href={`/messages/${encodeURIComponent(hit.personUsername)}`}
                className="block rounded-xl border bg-card p-3 transition-colors hover:border-primary/40"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-sm font-medium">
                    {hit.outgoing ? "You" : hit.personName ?? `@${hit.personUsername}`}
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {hit.outgoing ? `to @${hit.personUsername}` : ""}
                    </span>
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dateFormatter.format(new Date(hit.createdAt))}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {hit.snippet}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {status === "searching" && results.length === 0 && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Looking through your conversations…
        </p>
      )}
    </div>
  );
}
