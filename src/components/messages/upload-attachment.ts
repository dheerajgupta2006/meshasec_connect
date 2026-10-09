/**
 * Sends a prepared attachment to the upload route, reporting progress.
 *
 * `XMLHttpRequest` rather than `fetch`, because `fetch` still cannot report
 * upload progress in most browsers, and a 4 MB photo on a phone connection takes
 * long enough that a bubble with no feedback looks stuck.
 *
 * Never rejects. Every way an upload can end, including a dropped connection or
 * a proxy's HTML error page, resolves to an outcome the thread can render.
 */

import type { PreparedUpload } from "@/components/messages/prepare-attachment";

const UPLOAD_URL = "/api/direct-messages/attachments";

/** Generous: 4 MB over a poor mobile link can take most of a minute. */
const UPLOAD_TIMEOUT_MS = 120_000;

const CONNECTION_LOST =
  "The file didn't finish sending. Check your connection and try again.";

export interface UploadRequest {
  upload: PreparedUpload;
  recipientId: string;
  /** The caption, already trimmed. May be empty. */
  body: string;
  /** Idempotency key, so a retry after a lost response cannot send twice. */
  clientId: string;
  replyToId: string | null;
  /** Called with whole percentages, 0 to 100, as the bytes leave the device. */
  onProgress?: (percent: number) => void;
}

export type UploadOutcome =
  /** `sent` is the server's message, still unparsed. */
  | { ok: true; sent: unknown }
  | { ok: false; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/** For responses that never reached the route, such as the platform's own 413. */
function fallbackMessage(status: number): string {
  if (status === 413) {
    return "That file is too large to send.";
  }

  if (status === 401) {
    return "Your session has ended. Sign in again to continue.";
  }

  if (status === 429) {
    return "You are sending messages too quickly. Try again shortly.";
  }

  return "The file could not be sent. Try again.";
}

function interpret(status: number, responseText: string): UploadOutcome {
  let payload: unknown = null;

  try {
    payload = JSON.parse(responseText);
  } catch {
    // Not JSON: a gateway error page, or an empty body.
  }

  const record = asRecord(payload);

  if (status >= 200 && status < 300 && record !== null && record.ok === true) {
    return { ok: true, sent: record.sent ?? null };
  }

  const message =
    record !== null &&
    typeof record.message === "string" &&
    record.message.trim().length > 0
      ? record.message
      : fallbackMessage(status);

  return { ok: false, message };
}

export function uploadAttachment(request: UploadRequest): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("recipientId", request.recipientId);
    form.append("body", request.body);
    form.append("clientId", request.clientId);

    if (request.replyToId !== null) {
      form.append("replyToId", request.replyToId);
    }

    // The name travels as the part's filename. The server sanitises it again and
    // ignores the part's declared type entirely.
    form.append("file", request.upload.blob, request.upload.fileName);

    const xhr = new XMLHttpRequest();
    let lastPercent = -1;

    xhr.open("POST", UPLOAD_URL);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Accept", "application/json");
    // Mirrored outside the multipart body so the server can recognise a replay
    // before charging it as a new write. The server requires both copies to
    // match, so the header cannot change which operation is committed.
    xhr.setRequestHeader("X-Message-Client-Id", request.clientId);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }

      const percent = Math.min(100, Math.floor((event.loaded / event.total) * 100));

      // One callback per whole percent at most. Progress events fire far more
      // often than that, and each one re-renders the thread.
      if (percent !== lastPercent) {
        lastPercent = percent;
        request.onProgress?.(percent);
      }
    };

    xhr.onload = () => resolve(interpret(xhr.status, xhr.responseText));
    xhr.onerror = () => resolve({ ok: false, message: CONNECTION_LOST });
    xhr.ontimeout = () => resolve({ ok: false, message: CONNECTION_LOST });
    xhr.onabort = () => resolve({ ok: false, message: CONNECTION_LOST });

    try {
      xhr.send(form);
    } catch {
      resolve({ ok: false, message: CONNECTION_LOST });
    }
  });
}
