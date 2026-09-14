import "server-only";

/**
 * Slow-path visibility.
 *
 * A single `200 in 3200ms` line hides whether the time went to auth, the
 * database, or a cold start. This logs a labelled duration only when it crosses
 * a threshold, so healthy requests stay quiet and slow ones explain themselves.
 */

const SLOW_THRESHOLD_MS = 400;

/** Times an awaited step and reports it when it is slow enough to matter. */
export async function timed<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();

  try {
    return await operation();
  } finally {
    const elapsed = Date.now() - startedAt;

    if (elapsed >= SLOW_THRESHOLD_MS) {
      console.warn(`slow_step ${label} ${elapsed}ms`);
    }
  }
}
