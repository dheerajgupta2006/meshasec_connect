/**
 * Search bounds shared by the client and the server.
 *
 * Kept out of `queries.ts` because that module is `server-only` and imports
 * Prisma; the search box needs these values in the browser. The client uses them
 * to avoid pointless requests, the server re-applies them because a client-side
 * check is not a limit.
 */

/** Below this a search is mostly a full-table scan for no user benefit. */
export const MIN_SEARCH_CHARS = 2;

/** Bounds the pattern so a huge string cannot be pushed into a LIKE scan. */
export const MAX_SEARCH_CHARS = 200;

/** Cap on returned hits. */
export const MAX_SEARCH_HITS = 40;
