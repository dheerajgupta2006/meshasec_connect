"use client";

import { tokenizeBody } from "@/lib/messages/links";

interface MessageBodyProps {
  body: string;
  outgoing: boolean;
}

/**
 * Renders a message body with URLs turned into links.
 *
 * Uses the same `tokenizeBody` the server uses to pick a preview target, so the
 * highlighted link and the card below always refer to the same URL.
 *
 * Text is rendered as React children rather than interpolated into markup, so
 * nothing here can inject HTML — the linkification decides *where* an anchor
 * goes, never what the anchor contains.
 */
export function MessageBody({ body, outgoing }: MessageBodyProps) {
  const tokens = tokenizeBody(body);

  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {tokens.map((token, index) =>
        token.kind === "text" ? (
          // Index keys are safe here: the list is derived from the body and is
          // re-rendered wholesale whenever it changes.
          <span key={index}>{token.value}</span>
        ) : (
          <a
            key={index}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className={`underline decoration-1 underline-offset-2 transition-opacity hover:opacity-80 ${
              outgoing ? "text-primary-emphasis-foreground" : "text-primary"
            }`}
          >
            {token.label}
          </a>
        ),
      )}
    </p>
  );
}
