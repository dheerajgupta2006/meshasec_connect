/**
 * Server Action origin allowlist.
 *
 * Next.js 14 runs its own origin check before a Server Action executes, and
 * behind a reverse proxy the forwarded host no longer matches the host the
 * server sees, so the action is aborted before any application code runs. The
 * allowlist below is what lets the framework check pass in that topology.
 *
 * It is derived from `TRUSTED_APP_ORIGIN` on purpose: `src/lib/meetings/origin.ts`
 * enforces the same value at request time, and the two lists silently drifting
 * apart is exactly the failure mode that produces an unexplained aborted action.
 * Next.js expects bare hosts here (`app.example.com`, `localhost:3000`), not
 * full origins, so each entry is reduced to its host.
 *
 * @param {string | undefined} configured
 * @returns {string[]}
 */
function parseAllowedOrigins(configured) {
  if (!configured) {
    return ["localhost:3000"];
  }

  /** @type {string[]} */
  const hosts = [];

  for (const entry of configured.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }

    let host = trimmed.toLowerCase();
    try {
      host = new URL(trimmed).host.toLowerCase();
    } catch {
      // Already a bare host rather than a full origin.
    }

    if (host !== "" && !hosts.includes(host)) {
      hosts.push(host);
    }
  }

  return hosts.length > 0 ? hosts : ["localhost:3000"];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: parseAllowedOrigins(process.env.TRUSTED_APP_ORIGIN),
    },
  },
};

export default nextConfig;
