import "server-only";

/**
 * In-process rate limiting.
 *
 * A fixed-window counter keyed by action plus subject. This is a real limit for
 * a single server process, which is what this app runs as today.
 *
 * Known boundary: the state lives in module memory, so it is per-instance. On a
 * horizontally scaled or serverless deployment each instance keeps its own
 * counters and the effective limit multiplies by the instance count. Moving to
 * Redis (Upstash) is the drop-in fix and only this module needs to change.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitRule {
  /** Maximum permitted calls inside the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the window resets. Zero when allowed. */
  retryAfterSeconds: number;
}

/** Tuned per action: email-sending is the most expensive to abuse. */
export const RATE_LIMITS = {
  connectionRequest: { limit: 10, windowMs: 60 * 60 * 1000 },
  connectionResponse: { limit: 60, windowMs: 10 * 60 * 1000 },
  removeConnection: { limit: 30, windowMs: 60 * 60 * 1000 },
  directMessage: { limit: 30, windowMs: 60 * 1000 },
  /**
   * Each call can become an outbound request to a third party, so this bounds
   * how hard one account can make the server fetch on its behalf. Generous
   * enough for a long thread of links because cache hits also pass through here.
   */
  linkPreview: { limit: 120, windowMs: 5 * 60 * 1000 },
  meetingToken: { limit: 30, windowMs: 5 * 60 * 1000 },
  startCall: { limit: 20, windowMs: 10 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitAction = keyof typeof RATE_LIMITS;

const windows = new Map<string, Window>();

/** Bounds memory: without this a hostile caller could grow the map forever. */
const MAX_TRACKED_KEYS = 20_000;

function sweep(now: number): void {
  if (windows.size < MAX_TRACKED_KEYS) {
    return;
  }

  // `forEach` rather than `for...of`: this project's tsconfig declares no
  // `target`, so Map iteration is rejected under the default ES5 check.
  const expired: string[] = [];

  windows.forEach((window, key) => {
    if (window.resetAt <= now) {
      expired.push(key);
    }
  });

  for (const key of expired) {
    windows.delete(key);
  }
}

/**
 * Consumes one unit of quota.
 *
 * Call this only for accepted, authenticated work so a rejected request cannot
 * burn the caller's own quota.
 */
export function consumeRateLimit(
  action: RateLimitAction,
  subject: string,
): RateLimitVerdict {
  const rule: RateLimitRule = RATE_LIMITS[action];
  const now = Date.now();
  const key = `${action}:${subject}`;

  sweep(now);

  const existing = windows.get(key);

  if (existing === undefined || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= rule.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000),
      ),
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Human-readable wait, for user-facing copy. */
export function describeRetryAfter(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} seconds`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}
