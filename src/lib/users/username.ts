/**
 * Pure username helpers.
 *
 * Deliberately separate from `current-user.ts`: that module memoises with
 * `React.cache`, which only exists inside the React Server Components runtime,
 * so importing it anywhere else — including a Node test runner — fails at module
 * scope. Keeping these string functions dependency-free makes them usable and
 * testable everywhere.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const FALLBACK_USERNAME_BASE = "user";

/** Normalizes anything a person might type into a comparable handle. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Reduces a display name or email local part to a safe handle: lowercase
 * letters, digits and underscores only.
 */
export function slugifyUsername(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    // Trimming the edges must happen *after* truncation. Truncating last can
    // sever a word mid-separator and leave a trailing underscore, which makes
    // the function non-idempotent: slugify(slugify(x)) would drop that
    // underscore and yield a different handle for the same person.
    .slice(0, USERNAME_MAX)
    .replace(/^_+|_+$/g, "");

  return slug.length >= USERNAME_MIN ? slug : FALLBACK_USERNAME_BASE;
}
