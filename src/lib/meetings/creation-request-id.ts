/**
 * Creation_Request_ID generator (Req 6.1).
 *
 * Isomorphic: uses the Web Crypto global only, so it runs in the browser bundle
 * and in the server runtime without importing `node:crypto`.
 */

/** 16 bytes, hex-encoded: 32 characters carrying the full 128 bits Req 6.1 states. */
const CREATION_REQUEST_ID_BYTES = 16;

/**
 * `crypto.getRandomValues` is the primary source rather than
 * `crypto.randomUUID()` for two reasons. Entropy: a version-4 UUID fixes 6 bits
 * for its version and variant, leaving 122 random bits, short of the required
 * 128. Availability: `getRandomValues` works in insecure contexts, while
 * `randomUUID` requires a secure context in several browsers.
 *
 * `randomUUID()` remains as a fallback for the unlikely case that
 * `getRandomValues` is missing; the server accepts both the 32-character hex
 * form and the UUID form, so a client on the fallback path is never rejected.
 */
export function mintCreationRequestId(): string {
  const webCrypto = resolveWebCrypto();

  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(CREATION_REQUEST_ID_BYTES);
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, toHexOctet).join("");
  }

  if (webCrypto !== undefined && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  // No cryptographic random source at all. Falling back to Math.random would
  // silently weaken idempotency and Req 6.1, so the caller is told instead.
  throw new Error(
    "Cannot mint a Creation_Request_ID: no cryptographically secure random source is available.",
  );
}

function resolveWebCrypto(): Crypto | undefined {
  const candidate: Crypto | undefined = globalThis.crypto;
  return candidate;
}

function toHexOctet(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}
