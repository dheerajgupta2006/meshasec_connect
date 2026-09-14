import "server-only";

/**
 * Fetches and caches OpenGraph metadata for a URL a user pasted into a message.
 *
 * This is the only place in the app that makes an outbound HTTP request to a
 * user-supplied address, so the hardening lives here: an SSRF classification
 * before and after DNS, per-hop redirect validation, a request timeout, a
 * response size cap, and a content-type check.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

import { prisma } from "@/lib/prisma";
import { normalizeUrl } from "@/lib/messages/links";

import { parseMetadata, resolveMetadataUrl } from "./parse-html";
import { classifyPreviewUrl, isPrivateAddress } from "./ssrf";

/** How long a successful scrape is trusted before it is fetched again. */
const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Failures are cached far more briefly than successes, but long enough that a
 * link to a permanently dead host is not retried on every render.
 */
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 6000;

/** Enough to contain any real `<head>`; the body beyond it is not needed. */
const MAX_RESPONSE_BYTES = 512 * 1024;

const MAX_REDIRECTS = 3;

/**
 * Identifies the app rather than impersonating a browser. Many sites serve
 * OpenGraph tags specifically to named crawlers.
 */
const USER_AGENT =
  "MeshasecConnextBot/1.0 (+link preview; renders shared links in chat)";

export interface LinkPreviewData {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

interface ScrapeSuccess {
  ok: true;
  data: Omit<LinkPreviewData, "url">;
}

interface ScrapeFailure {
  ok: false;
  reason: string;
}

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * Resolves a hostname and refuses it if *any* returned address is private.
 *
 * All addresses are checked, not just the first: a hostile name can return one
 * public and one private address and let the connection pick.
 *
 * Known limitation: there is a window between this check and the socket being
 * opened in which DNS could change (a rebinding attack). Closing it fully needs
 * a custom HTTP agent that pins the resolved address, which `fetch` does not
 * expose. The port allowlist and redirect re-validation bound the impact.
 */
async function assertPublicHost(hostname: string): Promise<string | null> {
  // A literal address needs no resolution, and `dns.lookup` on one just echoes
  // it back.
  if (isPrivateAddress(hostname)) {
    return "resolved address is not publicly routable";
  }

  let addresses: { address: string }[];

  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return "hostname could not be resolved";
  }

  if (addresses.length === 0) {
    return "hostname resolved to no addresses";
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      return "hostname resolves to a private address";
    }
  }

  return null;
}

/** Reads at most `MAX_RESPONSE_BYTES` and decodes as UTF-8. */
async function readCappedText(response: Response): Promise<string> {
  const body = response.body;

  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      const value = chunk.value;

      if (value === undefined) {
        continue;
      }

      received += value.byteLength;

      if (received > MAX_RESPONSE_BYTES) {
        const overshoot = received - MAX_RESPONSE_BYTES;
        text += decoder.decode(value.subarray(0, value.byteLength - overshoot));
        break;
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases the socket even when the cap cut the read short.
    await reader.cancel().catch(() => undefined);
  }

  return text;
}

function isHtml(contentType: string | null): boolean {
  if (contentType === null) {
    // Absent content-type: attempt the parse rather than refuse. Nothing is
    // rendered from it unless recognisable metadata is found.
    return true;
  }

  const value = contentType.toLowerCase();

  return (
    value.includes("text/html") ||
    value.includes("application/xhtml+xml") ||
    value.includes("text/plain")
  );
}

/**
 * Performs the fetch, following redirects manually so every hop is re-validated.
 *
 * `redirect: "manual"` is essential: with automatic following, a public URL can
 * redirect straight to `http://169.254.169.254/` and the pre-flight check is
 * bypassed entirely.
 */
async function fetchDocument(
  startUrl: string,
): Promise<
  { ok: true; response: Response; finalUrl: string } | ScrapeFailure
> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = classifyPreviewUrl(currentUrl);

    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason };
    }

    const hostFailure = await assertPublicHost(new URL(currentUrl).hostname);

    if (hostFailure !== null) {
      return { ok: false, reason: hostFailure };
    }

    let response: Response;

    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          // Asking for identity avoids having to decompress a hostile stream
          // before the size cap can be applied.
          "Accept-Encoding": "identity",
          "Accept-Language": "en",
        },
        // Never send or store cookies for a third-party page.
        credentials: "omit",
        cache: "no-store",
      });
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === "TimeoutError";
      return { ok: false, reason: aborted ? "request timed out" : "request failed" };
    }

    const isRedirect = response.status >= 300 && response.status < 400;

    if (!isRedirect) {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: `upstream returned ${response.status}` };
      }

      if (!isHtml(response.headers.get("content-type"))) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "response is not an HTML document" };
      }

      return { ok: true, response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);

    if (location === null || location.trim().length === 0) {
      return { ok: false, reason: "redirect without a location" };
    }

    let next: string;

    try {
      next = new URL(location, currentUrl).toString();
    } catch {
      return { ok: false, reason: "redirect to an unparseable location" };
    }

    currentUrl = next;
  }

  return { ok: false, reason: "too many redirects" };
}

async function scrape(url: string): Promise<ScrapeSuccess | ScrapeFailure> {
  const fetched = await fetchDocument(url);

  if (!fetched.ok) {
    return fetched;
  }

  let html: string;

  try {
    html = await readCappedText(fetched.response);
  } catch {
    return { ok: false, reason: "response body could not be read" };
  }

  const parsed = parseMetadata(html);
  const base = parsed.canonicalUrl ?? fetched.finalUrl;

  const data: Omit<LinkPreviewData, "url"> = {
    // Resolved against the page so a relative `og:image` works, and filtered to
    // http(s) so `javascript:` or `data:` can never reach an <img src>.
    canonicalUrl: resolveMetadataUrl(parsed.canonicalUrl, fetched.finalUrl),
    title: parsed.title,
    description: parsed.description,
    imageUrl: resolveMetadataUrl(parsed.imageUrl, base),
    siteName: parsed.siteName,
  };

  // A card with neither a title nor a description is an empty box; treat it as a
  // miss so it is not rendered.
  if (data.title === null && data.description === null) {
    return { ok: false, reason: "no usable metadata found" };
  }

  return { ok: true, data };
}

function toPreviewData(row: {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}): LinkPreviewData {
  return {
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    siteName: row.siteName,
  };
}

/**
 * Returns cached metadata for `rawUrl`, scraping it if the cache is cold or
 * stale. Null means there is nothing worth rendering.
 */
export async function getLinkPreview(
  rawUrl: string,
): Promise<LinkPreviewData | null> {
  const url = normalizeUrl(rawUrl);

  if (url === null) {
    return null;
  }

  // Refuse before touching the database: a blocked URL should not even create a
  // cache row.
  const verdict = classifyPreviewUrl(url);

  if (!verdict.allowed) {
    return null;
  }

  const urlHash = hashUrl(url);
  const now = Date.now();

  const cached = await prisma.linkPreview.findUnique({
    where: { urlHash },
    select: {
      url: true,
      canonicalUrl: true,
      title: true,
      description: true,
      imageUrl: true,
      siteName: true,
      fetchedAt: true,
      failedAt: true,
    },
  });

  if (cached !== null) {
    if (
      cached.fetchedAt !== null &&
      now - cached.fetchedAt.getTime() < SUCCESS_TTL_MS
    ) {
      return toPreviewData(cached);
    }

    if (
      cached.failedAt !== null &&
      now - cached.failedAt.getTime() < FAILURE_TTL_MS
    ) {
      return null;
    }
  }

  const result = await scrape(url);

  if (!result.ok) {
    await prisma.linkPreview
      .upsert({
        where: { urlHash },
        create: {
          urlHash,
          url,
          failedAt: new Date(),
          failureReason: result.reason.slice(0, 200),
        },
        update: {
          failedAt: new Date(),
          failureReason: result.reason.slice(0, 200),
        },
        select: { id: true },
      })
      // A cache write failure must not turn into a failed message render.
      .catch(() => undefined);

    return null;
  }

  const stored = {
    ...result.data,
    fetchedAt: new Date(),
    failedAt: null,
    failureReason: null,
  };

  await prisma.linkPreview
    .upsert({
      where: { urlHash },
      create: { urlHash, url, ...stored },
      update: stored,
      select: { id: true },
    })
    .catch(() => undefined);

  return { url, ...result.data };
}
