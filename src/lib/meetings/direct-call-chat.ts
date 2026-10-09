import {
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  type AttachmentView,
} from "@/lib/messages/attachment-rules";

/** Separate from LiveKit's ordinary text-chat topic. */
export const DIRECT_CALL_CHAT_TOPIC = "meshasec-direct-call-chat-v1";

const MAX_ENVELOPE_BYTES = 32 * 1024;
const MAX_ID_CHARS = 128;
const MAX_BODY_CHARS = 4000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

export interface DirectCallChatEnvelope {
  id: string;
  timestamp: number;
  senderIdentity: string;
  body: string;
  attachment: AttachmentView | null;
}

export interface PersistedCallMessage {
  id: string;
  createdAt: string;
  senderIdentity: string;
  body: string;
  attachment: AttachmentView | null;
}

function parseAttachment(value: unknown): AttachmentView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > MAX_ID_CHARS ||
    record.kind !== "image" ||
    typeof record.fileName !== "string" ||
    record.fileName.length === 0 ||
    Array.from(record.fileName).length > MAX_FILE_NAME_CHARS ||
    typeof record.mimeType !== "string" ||
    !record.mimeType.startsWith("image/") ||
    typeof record.sizeBytes !== "number" ||
    !Number.isInteger(record.sizeBytes) ||
    record.sizeBytes <= 0 ||
    record.sizeBytes > MAX_ATTACHMENT_BYTES ||
    typeof record.width !== "number" ||
    !Number.isInteger(record.width) ||
    record.width <= 0 ||
    record.width > MAX_IMAGE_SIDE ||
    typeof record.height !== "number" ||
    !Number.isInteger(record.height) ||
    record.height <= 0 ||
    record.height > MAX_IMAGE_SIDE ||
    record.width * record.height > MAX_IMAGE_PIXELS
  ) {
    return null;
  }

  return {
    id: record.id,
    kind: "image",
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
  };
}

/** Strictly parses one server-published canonical DM event. */
export function parseDirectCallChatEnvelope(
  payload: Uint8Array,
): DirectCallChatEnvelope | null {
  if (payload.byteLength === 0 || payload.byteLength > MAX_ENVELOPE_BYTES) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const attachment =
    record.attachment === null ? null : parseAttachment(record.attachment);

  if (
    record.version !== 1 ||
    record.kind !== "message" ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > MAX_ID_CHARS ||
    typeof record.timestamp !== "number" ||
    !Number.isFinite(record.timestamp) ||
    record.timestamp < 0 ||
    record.timestamp > Date.now() + MAX_FUTURE_MS ||
    typeof record.senderIdentity !== "string" ||
    record.senderIdentity.length === 0 ||
    record.senderIdentity.length > MAX_ID_CHARS ||
    typeof record.body !== "string" ||
    record.body.length > MAX_BODY_CHARS ||
    (record.attachment !== null && attachment === null) ||
    (record.body.length === 0 && attachment === null)
  ) {
    return null;
  }

  return {
    id: record.id,
    timestamp: record.timestamp,
    senderIdentity: record.senderIdentity,
    body: record.body,
    attachment,
  };
}

/** Encodes only a server-returned persisted row, never client-authored fields. */
export function encodeDirectCallChatEnvelope(
  message: PersistedCallMessage,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      kind: "message",
      id: message.id,
      timestamp: new Date(message.createdAt).getTime(),
      senderIdentity: message.senderIdentity,
      body: message.body,
      attachment: message.attachment,
    }),
  );
}
