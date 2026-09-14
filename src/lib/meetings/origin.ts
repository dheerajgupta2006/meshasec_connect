import "server-only";

/**
 * Trusted_Application_Origin check for state-changing requests.
 *
 * This is the feature's own origin guard, layered behind the framework's
 * `experimental.serverActions.allowedOrigins` check in `next.config.mjs`.
 * Behind a reverse proxy both lists must name the same host, or the framework
 * aborts the action before this code ever runs.
 */

export type OriginCheck =
  | { trusted: true }
  | { trusted: false; reason: "missing_origin" | "origin_mismatch" };

const TRUSTED = { trusted: true } as const;
const MISSING_ORIGIN = { trusted: false, reason: "missing_origin" } as const;
const ORIGIN_MISMATCH = { trusted: false, reason: "origin_mismatch" } as const;

/**
 * Req 10.6, 10.7: decides trust by exact host-and-port equality.
 *
 * Precedence:
 * 1. When `TRUSTED_APP_ORIGIN` is set it is the sole allowlist. Nothing else is
 *    consulted, so a spoofed `x-forwarded-host` cannot widen it.
 * 2. Otherwise the `Origin` host is compared against `x-forwarded-host`, then
 *    `host` — the same fallback Next.js itself uses.
 *
 * A missing `Origin` header on a state-changing request is untrusted: browsers
 * send it on every cross-origin form post and `fetch`, so its absence is not
 * something to give the benefit of the doubt to.
 *
 * Comparison is exact. `evil-localhost:3000` does not match `localhost:3000`,
 * and neither does `localhost:3001`, because suffix and prefix matching are the
 * standard way origin checks get bypassed.
 */
export function assertTrustedOrigin(headerList: Headers): OriginCheck {
  const originHeader = headerList.get("origin");

  if (originHeader === null || originHeader.trim().length === 0) {
    return MISSING_ORIGIN;
  }

  const originHost = readHost(originHeader);
  if (originHost === null) {
    // Present but not a parseable origin, including the literal `null` an
    // opaque origin sends. Untrusted, but distinguishable from absent.
    return ORIGIN_MISMATCH;
  }

  const allowedHosts = readAllowedHosts(headerList);
  if (allowedHosts.length === 0) {
    return ORIGIN_MISMATCH;
  }

  return allowedHosts.includes(originHost) ? TRUSTED : ORIGIN_MISMATCH;
}

/**
 * The allowlist, in precedence order. Returns an empty list when nothing
 * usable is configured or forwarded, which fails closed.
 */
function readAllowedHosts(headerList: Headers): string[] {
  const configured = readConfiguredHosts();
  if (configured.length > 0) {
    return configured;
  }

  const forwardedHost = readForwardedHost(headerList.get("x-forwarded-host"));
  if (forwardedHost !== null) {
    return [forwardedHost];
  }

  const host = normalizeHost(headerList.get("host"));
  return host === null ? [] : [host];
}

/**
 * `TRUSTED_APP_ORIGIN` is server-only (deliberately no `NEXT_PUBLIC_` prefix).
 * A comma-separated list is accepted so a deployment can name both its apex and
 * its preview host; each entry may be a full origin or a bare host.
 */
function readConfiguredHosts(): string[] {
  const configured = process.env.TRUSTED_APP_ORIGIN;
  if (configured === undefined) {
    return [];
  }

  const hosts: string[] = [];
  for (const entry of configured.split(",")) {
    const host = readHost(entry) ?? normalizeHost(entry);
    if (host !== null && !hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

/**
 * `x-forwarded-host` accumulates one entry per proxy hop. The first entry is
 * the host the client actually addressed; the rest describe the internal chain
 * and must not be matchable.
 */
function readForwardedHost(headerValue: string | null): string | null {
  if (headerValue === null) {
    return null;
  }
  const [firstHop] = headerValue.split(",");
  return normalizeHost(firstHop);
}

/** Extracts `host:port` from a full origin such as `https://app.example.com`. */
function readHost(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return normalizeHost(new URL(trimmed).host);
  } catch {
    return null;
  }
}

/**
 * Hosts are case-insensitive, so folding case is not a widening of the check.
 * The port is retained: `localhost:3000` and `localhost:3001` are different
 * origins, and no default-port normalization is applied.
 */
function normalizeHost(value: string | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}
