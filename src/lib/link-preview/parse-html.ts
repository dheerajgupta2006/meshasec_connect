/**
 * Minimal OpenGraph / HTML metadata extraction.
 *
 * Deliberately regex-based rather than a DOM parser: the only inputs are `<meta>`
 * and `<title>` from the document head, a full parser is a large dependency for
 * that, and the source is untrusted HTML we never render. Everything here is
 * pure and operates on a string that the caller has already size-capped.
 */

export interface ParsedMetadata {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  canonicalUrl: string | null;
}

/** Cheap bound so a hostile page cannot make a single field enormous. */
const MAX_FIELD_CHARS = 500;
const MAX_TITLE_CHARS = 200;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  "#39": "'",
};

/**
 * Decodes the handful of entities that actually appear in title and description
 * text. Unknown entities are left as-is rather than guessed at.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    const key = body.toLowerCase();
    const named = NAMED_ENTITIES[key];

    if (named !== undefined) {
      return named;
    }

    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return codePointOrOriginal(code, whole);
    }

    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return codePointOrOriginal(code, whole);
    }

    return whole;
  });
}

function codePointOrOriginal(code: number, original: string): string {
  // Surrogates and out-of-range values throw in String.fromCodePoint, and a
  // hostile page is exactly where they would appear.
  if (
    !Number.isFinite(code) ||
    code < 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return original;
  }

  return String.fromCodePoint(code);
}

/** Collapses whitespace and bounds the length. */
function clean(value: string | null, max: number): string | null {
  if (value === null) {
    return null;
  }

  const collapsed = decodeEntities(value).replace(/\s+/g, " ").trim();

  if (collapsed.length === 0) {
    return null;
  }

  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * Reads the `content` of a meta tag whose identifying attribute matches `key`.
 *
 * Attribute order is not fixed in real HTML — `content` can precede `property` —
 * so each tag is isolated first and its attributes read independently.
 */
function readMeta(html: string, attribute: string, key: string): string | null {
  const tagPattern = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null = tagPattern.exec(html);

  while (tag !== null) {
    const source = tag[0];
    const identifier = readAttribute(source, attribute);

    if (identifier !== null && identifier.toLowerCase() === key) {
      const content = readAttribute(source, "content");

      if (content !== null && content.trim().length > 0) {
        return content;
      }
    }

    tag = tagPattern.exec(html);
  }

  return null;
}

/** Reads one attribute value, tolerating single, double or unquoted forms. */
function readAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  );
  const match = pattern.exec(tag);

  if (match === null) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function readTitleTag(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  return match === null ? null : (match[1] ?? null);
}

function readCanonical(html: string): string | null {
  const tagPattern = /<link\b[^>]*>/gi;
  let tag: RegExpExecArray | null = tagPattern.exec(html);

  while (tag !== null) {
    const rel = readAttribute(tag[0], "rel");

    if (rel !== null && rel.trim().toLowerCase() === "canonical") {
      const href = readAttribute(tag[0], "href");

      if (href !== null && href.trim().length > 0) {
        return href;
      }
    }

    tag = tagPattern.exec(html);
  }

  return null;
}

/**
 * Extracts card metadata, preferring OpenGraph, then Twitter cards, then plain
 * HTML. That order matches what the tags are actually for: `og:*` is the
 * publisher's chosen social representation.
 */
export function parseMetadata(html: string): ParsedMetadata {
  const title =
    readMeta(html, "property", "og:title") ??
    readMeta(html, "name", "og:title") ??
    readMeta(html, "name", "twitter:title") ??
    readTitleTag(html);

  const description =
    readMeta(html, "property", "og:description") ??
    readMeta(html, "name", "og:description") ??
    readMeta(html, "name", "twitter:description") ??
    readMeta(html, "name", "description");

  const imageUrl =
    readMeta(html, "property", "og:image:secure_url") ??
    readMeta(html, "property", "og:image:url") ??
    readMeta(html, "property", "og:image") ??
    readMeta(html, "name", "og:image") ??
    readMeta(html, "name", "twitter:image") ??
    readMeta(html, "name", "twitter:image:src");

  const siteName =
    readMeta(html, "property", "og:site_name") ??
    readMeta(html, "name", "application-name");

  const canonicalUrl =
    readMeta(html, "property", "og:url") ?? readCanonical(html);

  return {
    title: clean(title, MAX_TITLE_CHARS),
    description: clean(description, MAX_FIELD_CHARS),
    // Not cleaned through `clean`: collapsing whitespace is right for prose and
    // wrong for a URL, which must stay byte-exact to resolve.
    imageUrl: imageUrl === null ? null : decodeEntities(imageUrl).trim(),
    siteName: clean(siteName, 120),
    canonicalUrl: canonicalUrl === null ? null : decodeEntities(canonicalUrl).trim(),
  };
}

/**
 * Resolves a possibly-relative metadata URL against the page it came from.
 *
 * Returns null for anything that is not http(s) after resolution, which drops
 * `data:` and `javascript:` image URLs before they can reach an `<img src>`.
 */
export function resolveMetadataUrl(
  value: string | null,
  baseUrl: string,
): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  try {
    const resolved = new URL(value, baseUrl);

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
}
