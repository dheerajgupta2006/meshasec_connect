/**
 * SSRF classification for outbound preview fetches.
 *
 * A link preview is a server-side fetch of a URL chosen by an untrusted user, so
 * without this the feature is a request proxy into the deployment's private
 * network: cloud metadata endpoints, internal admin panels, databases bound to
 * localhost.
 *
 * Pure on purpose. DNS resolution happens in the caller; this module only judges
 * hostnames and the addresses they resolve to, which makes every rule directly
 * testable.
 */

/**
 * Hostnames refused before DNS is consulted.
 *
 * Blocking by name is not sufficient on its own — a public name can resolve to a
 * private address — but it short-circuits the obvious cases and covers names
 * that never appear in DNS at all.
 */
const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  // AWS/GCP/Azure instance metadata. Reaching this leaks IAM credentials.
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

export type HostVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

const ALLOWED: HostVerdict = { allowed: true };

function refuse(reason: string): HostVerdict {
  return { allowed: false, reason };
}

/** Strips the brackets Node keeps around a literal IPv6 host. */
function unwrapIpv6(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** True for a dotted-quad IPv4 literal with all four octets in range. */
export function isIpv4Literal(value: string): boolean {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    // Rejects "01" and "010": a leading zero means octal to some resolvers,
    // which is a classic filter bypass.
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }

    return Number(part) <= 255;
  });
}

/**
 * True when an IPv4 address is not routable on the public internet.
 *
 * Covers every range that could reach something private, including the ones that
 * are easy to forget: link-local (cloud metadata), carrier-grade NAT, and the
 * benchmarking and reserved blocks.
 */
export function isPrivateIpv4(value: string): boolean {
  if (!isIpv4Literal(value)) {
    return false;
  }

  const [a, b] = value.split(".").map(Number) as [number, number, number, number];

  if (a === 0) return true; // "this network", and 0.0.0.0
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 88) return true; // 6to4 relay anycast
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

/**
 * Extracts the embedded IPv4 address from an IPv4-mapped IPv6 address.
 *
 * Two notations must both be handled, and missing the second one is a real SSRF
 * bypass:
 * - the readable form, `::ffff:169.254.169.254`;
 * - the hex form, `::ffff:a9fe:a9fe`, which is what the WHATWG URL parser
 *   normalises the readable form into. `new URL("http://[::ffff:169.254.169.254]/")`
 *   reports its hostname as `[::ffff:a9fe:a9fe]`, so a check that only understands
 *   dotted quads lets the cloud metadata endpoint straight through.
 *
 * Returns null when the address is not IPv4-mapped.
 */
function embeddedIpv4(bare: string): string | null {
  const dotted = /^::ffff:(?:0:)?((?:\d{1,3}\.){3}\d{1,3})$/.exec(bare);

  if (dotted !== null) {
    return dotted[1] ?? null;
  }

  const hex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);

  if (hex === null) {
    return null;
  }

  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);

  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return null;
  }

  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    ".",
  );
}

/** True when an IPv6 address is not routable on the public internet. */
export function isPrivateIpv6(value: string): boolean {
  const address = unwrapIpv6(value).toLowerCase();

  // Zone index ("fe80::1%eth0") is never meaningful for an outbound fetch.
  const bare = address.split("%")[0] ?? address;

  if (bare === "::" || bare === "::1") {
    return true;
  }

  // IPv4-mapped forms tunnel an IPv4 address through IPv6, so the embedded
  // address has to be judged by the IPv4 rules.
  const mapped = embeddedIpv4(bare);

  if (mapped !== null) {
    return isPrivateIpv4(mapped);
  }

  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true; // unique local
  if (bare.startsWith("ff")) return true; // multicast
  if (bare.startsWith("2001:db8")) return true; // documentation
  if (bare.startsWith("64:ff9b:")) return true; // NAT64
  if (bare.startsWith("100::")) return true; // discard-only

  return false;
}

/** True when the address, of either family, must not be fetched. */
export function isPrivateAddress(value: string): boolean {
  const bare = unwrapIpv6(value.trim());

  if (bare.length === 0) {
    return true;
  }

  return bare.includes(":") ? isPrivateIpv6(bare) : isPrivateIpv4(bare);
}

/**
 * Judges a hostname before DNS.
 *
 * Returns allowed for ordinary public names; the caller must still resolve them
 * and check every returned address with `isPrivateAddress`.
 */
export function classifyHostname(rawHostname: string): HostVerdict {
  const hostname = unwrapIpv6(rawHostname.trim().toLowerCase()).replace(
    /\.$/,
    "",
  );

  if (hostname.length === 0) {
    return refuse("empty hostname");
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return refuse(`hostname ${hostname} is not permitted`);
  }

  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return refuse(`hostname suffix ${suffix} is not permitted`);
    }
  }

  // A name with no dot is a single-label host, which on most networks means an
  // internal machine reached through a search domain.
  if (!hostname.includes(".") && !hostname.includes(":")) {
    return refuse("single-label hostnames are not permitted");
  }

  if (isPrivateAddress(hostname)) {
    return refuse("address is not publicly routable");
  }

  return ALLOWED;
}

/**
 * Full pre-flight check on a URL string.
 *
 * Scheme, port and hostname only. DNS is the caller's job because it is I/O.
 */
export function classifyPreviewUrl(raw: string): HostVerdict {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    return refuse("not a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return refuse(`scheme ${parsed.protocol} is not permitted`);
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    // Credentials in the URL would be forwarded by our fetch, and are also used
    // to disguise the real host from a human reader.
    return refuse("credentials in the URL are not permitted");
  }

  if (parsed.port.length > 0) {
    const port = Number(parsed.port);
    // Restricting to the web ports keeps the fetcher away from internal services
    // on odd ports that happen to be publicly resolvable.
    if (port !== 80 && port !== 443) {
      return refuse(`port ${parsed.port} is not permitted`);
    }
  }

  return classifyHostname(parsed.hostname);
}
