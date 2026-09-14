import "server-only";

/**
 * Absolute origin for links that leave the app: calendar files, emails, push
 * notifications. A relative path is useless in any of those.
 *
 * Precedence is deliberate. `NEXT_PUBLIC_APP_URL` wins because it is configured
 * rather than supplied by the request, so a forged `Host` header cannot redirect
 * an emailed or calendared link at an attacker's domain. Request headers are
 * only consulted in development, where nothing is configured yet.
 */

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    // `.origin` drops any path, query or trailing slash that crept into the env
    // value, which would otherwise produce a doubled slash in every link.
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/** Reads the configured public origin, or null when it is unset or unusable. */
export function configuredAppOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL;

  return configured === undefined ? null : normalizeOrigin(configured);
}

/**
 * Resolves the origin to use in an outbound link.
 *
 * Falls back to the request's own origin so local development works without
 * configuration; that fallback is why `NEXT_PUBLIC_APP_URL` must be set before
 * deploying.
 */
export function resolveAppOrigin(request: Request): string {
  const configured = configuredAppOrigin();

  if (configured !== null) {
    return configured;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}
