import { NextResponse } from "next/server";

import { getLinkPreview } from "@/lib/link-preview/service";
import { previewTarget } from "@/lib/messages/links";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { getCurrentLocalUserId } from "@/lib/users/current-user";

export const runtime = "nodejs";

/**
 * Resolves a link preview for a URL that appeared in a message.
 *
 * Authenticated: this endpoint makes an outbound request on the caller's behalf,
 * so leaving it open would turn the deployment into a public URL fetcher. It is
 * also rate limited per user for the same reason.
 *
 * The URL is passed through `previewTarget`, which is the same extraction the
 * message renderer uses. That means the caller cannot ask for an arbitrary
 * address — only something that parses as a link in a message body.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const viewerId = await getCurrentLocalUserId();

  if (viewerId === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = consumeRateLimit("linkPreview", viewerId);

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Too many preview requests. Try again in ${describeRetryAfter(
          limit.retryAfterSeconds,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  const requested = new URL(request.url).searchParams.get("url");

  if (requested === null || requested.trim().length === 0) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const target = previewTarget(requested);

  if (target === null) {
    return NextResponse.json({ error: "url is not previewable" }, { status: 400 });
  }

  const preview = await getLinkPreview(target);

  if (preview === null) {
    // 200 with an explicit null rather than 404: "no preview available" is a
    // normal outcome for a valid link, and the client caches it the same way.
    return NextResponse.json(
      { preview: null },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  }

  return NextResponse.json(
    { preview },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
