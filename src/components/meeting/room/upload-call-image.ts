import type { PreparedUpload } from "@/components/messages/prepare-attachment";

const UPLOAD_TIMEOUT_MS = 120_000;

export interface UploadCallImageRequest {
  meetingCode: string;
  upload: PreparedUpload;
  body: string;
  clientId: string;
  onProgress?: (percent: number) => void;
}

export type UploadCallImageOutcome =
  | { ok: true; sent: unknown; liveDelivered: boolean }
  | { ok: false; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function interpret(status: number, text: string): UploadCallImageOutcome {
  let payload: unknown = null;

  try {
    payload = JSON.parse(text);
  } catch {
    // Platform errors can be HTML or empty.
  }

  const record = asRecord(payload);

  if (status >= 200 && status < 300 && record?.ok === true) {
    return {
      ok: true,
      sent: record.sent ?? null,
      liveDelivered: record.liveDelivered === true,
    };
  }

  return {
    ok: false,
    message:
      typeof record?.message === "string" && record.message.length > 0
        ? record.message
        : status === 413
          ? "That image is too large to send."
          : "The image could not be sent. Try again.",
  };
}

/** Uploads an already-sanitised image with progress. Never rejects. */
export function uploadCallImage(
  request: UploadCallImageRequest,
): Promise<UploadCallImageOutcome> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("body", request.body);
    form.append("clientId", request.clientId);
    form.append("file", request.upload.blob, request.upload.fileName);

    const xhr = new XMLHttpRequest();
    let lastPercent = -1;

    xhr.open(
      "POST",
      `/api/meetings/${encodeURIComponent(request.meetingCode)}/chat-image`,
    );
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-Message-Client-Id", request.clientId);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }

      const percent = Math.min(
        100,
        Math.floor((event.loaded / event.total) * 100),
      );

      if (percent !== lastPercent) {
        lastPercent = percent;
        request.onProgress?.(percent);
      }
    };

    xhr.onload = () => resolve(interpret(xhr.status, xhr.responseText));
    xhr.onerror = () =>
      resolve({
        ok: false,
        message: "The image did not finish sending. Check your connection.",
      });
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = xhr.onerror;

    try {
      xhr.send(form);
    } catch {
      xhr.onerror?.(new ProgressEvent("error"));
    }
  });
}
