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

/**
 * Refuses a production build that is still carrying Clerk development keys.
 *
 * A `pk_test_` key puts a "Development mode" badge under every sign-in form and
 * makes Clerk log a warning about relaxed security and strict usage limits. That
 * shipped to the live site once already and went unnoticed for weeks, because the
 * only signal was a line in a build log and a badge nobody was looking at. This
 * turns it into a failed deploy, which is the only signal that cannot be missed.
 *
 * Gated on `VERCEL_ENV === "production"` rather than `NODE_ENV`, and the
 * distinction matters: `NODE_ENV` is `production` for preview builds too, and a
 * preview *must* keep development keys. Clerk binds `pk_live_` to the production
 * domain and rejects every other origin, so a preview deployment built with live
 * keys cannot authenticate anyone. Local `next build` is likewise unaffected.
 *
 * @returns {void}
 */
function assertProductionAuthKeys() {
  if (process.env.VERCEL_ENV !== "production") {
    return;
  }

  // Deliberate, named, and loud. Needed when a release cannot wait for the Clerk
  // production instance's DNS to verify — but it leaves the badge on the live
  // site, so it is not something to set and forget.
  if (process.env.ALLOW_CLERK_DEV_KEYS === "true") {
    console.warn(
      "WARNING: building production with Clerk development keys because " +
        "ALLOW_CLERK_DEV_KEYS=true. The sign-in form will show a " +
        '"Development mode" badge and Clerk usage limits apply.',
    );
    return;
  }

  const offenders = [];

  if ((process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "").startsWith("pk_test_")) {
    offenders.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (pk_test_…)");
  }

  if ((process.env.CLERK_SECRET_KEY ?? "").startsWith("sk_test_")) {
    offenders.push("CLERK_SECRET_KEY (sk_test_…)");
  }

  if (offenders.length === 0) {
    return;
  }

  throw new Error(
    [
      "Refusing to build production with Clerk development keys.",
      "",
      `Development keys found: ${offenders.join(", ")}`,
      "",
      "These render a \"Development mode\" badge on the sign-in form and run",
      "under Clerk's development usage limits.",
      "",
      "To fix: create a production instance in the Clerk Dashboard, verify its",
      "domain, then set the pk_live_ / sk_live_ keys on the Production",
      "environment of this Vercel project. Leave the pk_test_ keys in place for",
      "local development and Preview deployments — live keys only work on the",
      "production domain.",
      "",
      "To ship anyway, set ALLOW_CLERK_DEV_KEYS=true. The badge stays visible.",
    ].join("\n"),
  );
}

assertProductionAuthKeys();

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: parseAllowedOrigins(process.env.TRUSTED_APP_ORIGIN),
    },
  },
};

export default nextConfig;
