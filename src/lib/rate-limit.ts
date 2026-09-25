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
  /**
   * Wrong room-passcode attempts, keyed per meeting per user.
   *
   * A six-digit PIN is only 1,000,000 combinations, so constant-time comparison
   * alone is not protection — the attempt budget is. Ten wrong guesses per
   * fifteen minutes makes exhausting the space take centuries, while leaving
   * plenty of room for someone fat-fingering a code from a chat message.
   *
   * Only *failed* attempts consume quota, so a guest who types it correctly is
   * never throttled.
   */
  meetingPasscode: { limit: 10, windowMs: 15 * 60 * 1000 },
  /**
   * Failed guest passcode attempts for one meeting, summed across every caller.
   *
   * The per-subject budget above is keyed on a guest's IP, which is read from a
   * request header. Where no proxy overwrites that header the caller chooses it,
   * and a fresh key means a fresh budget — which is unlimited guessing against a
   * six-digit secret. This counter is keyed on the meeting id, which comes from
   * the database and cannot be rotated, so it bounds total guesses no matter how
   * many identities or instances an attacker spreads them across.
   *
   * A hundred wrong codes in fifteen minutes is not something real guests do; it
   * is roughly 9,600 a day, which leaves a million-code space needing months. The
   * accepted trade is that an attacker willing to burn the budget can keep guests
   * out for fifteen minutes at a time. That is worth it: the alternative is not a
   * denial of service but a successful entry, and the host can still admit people
   * by invite link while it lasts.
   *
   * Only failures consume, so a room filling up with legitimate guests never
   * approaches it.
   */
  meetingPasscodeRoom: { limit: 100, windowMs: 15 * 60 * 1000 },
  /**
   * New waiting-room entries one account can create.
   *
   * Knocking inserts a row into a host's admit queue and shows the caller's name
   * there, for any meeting code they can name — so unthrottled it is a way to spam
   * a stranger's moderation panel, or to sweep guessed codes. Keyed on the user
   * rather than the meeting for exactly that second reason: per-meeting counting
   * would leave fanning out across many codes free.
   *
   * Only *creating* an entry consumes quota. Re-reading an existing one is how the
   * waiting screen polls for a decision, and that has to stay free.
   */
  meetingKnock: { limit: 20, windowMs: 10 * 60 * 1000 },
  /**
   * Host-only poll and Q&A moderation: launching, closing, marking answered.
   *
   * Each call fans out to every participant through the media server, so the
   * limit bounds how much traffic one moderator can generate. Loose enough that
   * running a lively Q&A never hits it.
   */
  pollModeration: { limit: 60, windowMs: 60 * 1000 },
  startCall: { limit: 20, windowMs: 10 * 60 * 1000 },
  /**
   * Creating groups. Tight, because each one is a durable object with a roster.
   */
  groupCreate: { limit: 10, windowMs: 60 * 60 * 1000 },
  /**
   * Roster and settings changes: adding, removing, renaming, role changes.
   *
   * One bucket for all of them, because the behaviour worth bounding is churn on
   * other people's membership rather than any single verb.
   */
  groupManage: { limit: 60, windowMs: 10 * 60 * 1000 },
  /**
   * Group message writes: send, edit and delete.
   *
   * Separate from `directMessage` rather than shared, because one group send fans
   * out to every member — it is a different cost, so it gets a different budget.
   */
  groupMessage: { limit: 30, windowMs: 60 * 1000 },
  /**
   * Cloud speech synthesis for translated captions.
   *
   * Each call spends part of a metered monthly quota, so this bounds how fast one
   * account can drain it. Generous, because dubbing a continuous speaker is
   * legitimately chatty — a sentence every few seconds — and cache hits pass
   * through here too. The real defence for the quota is the clip cache in
   * `lib/translation/azure-tts.ts`; this only stops one account spending
   * everybody else's budget.
   */
  speechSynthesis: { limit: 240, windowMs: 10 * 60 * 1000 },
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

/**
 * Returns one unit of quota.
 *
 * Used where the cost should only apply to failure: a room passcode consumes an
 * attempt when wrong and refunds it when right, so a guest who mistypes once then
 * succeeds is not left with a depleted budget.
 *
 * Never drops below zero, and does nothing once the window has already reset.
 */
export function refundRateLimit(
  action: RateLimitAction,
  subject: string,
): void {
  const key = `${action}:${subject}`;
  const existing = windows.get(key);

  if (existing === undefined || existing.resetAt <= Date.now()) {
    return;
  }

  existing.count = Math.max(0, existing.count - 1);
}

/** Human-readable wait, for user-facing copy. */
export function describeRetryAfter(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} seconds`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}
