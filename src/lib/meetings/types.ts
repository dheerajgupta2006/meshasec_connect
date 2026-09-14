/**
 * Wire contract shared by the Server Action and the client form.
 *
 * Isomorphic: no Prisma, no Clerk, no `node:crypto`, no `next/*`, no runtime
 * dependencies of any kind. Both the browser bundle and the server runtime
 * import this module directly.
 */

export type MeetingMode = "instant" | "scheduled";

export type CreationFieldName = "title" | "mode" | "startsAt" | "endsAt";

/** Exactly the client-controlled fields Req 10.3 permits, and nothing else. */
export interface CreateMeetingInput {
  title: string;
  mode: MeetingMode;
  /** ISO_8601_Instant with an explicit offset, or null. */
  startsAt: string | null;
  endsAt: string | null;
  creationRequestId: string;
}

/**
 * Server-assigned columns a client may never supply. Presence of any of these
 * as an own key on the payload is a Validation_Error before any other check
 * (Req 10.4).
 */
export const FORBIDDEN_INPUT_KEYS = [
  "hostId",
  "clerkId",
  "meetingCode",
  "createdAt",
] as const;

export interface CreationResult {
  meetingCode: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * Returned as a value, never thrown. A throw crossing the Server Action
 * boundary is replaced by an opaque digest in production, which would destroy
 * the field-level error data Req 11.1 requires.
 */
export type CreationFailure =
  | {
      kind: "validation";
      fieldErrors: Partial<Record<CreationFieldName, string>>;
      formMessage: string | null;
    }
  | {
      kind: "authorization";
      reason: "unauthenticated" | "session_expired" | "untrusted_origin";
      message: string;
    }
  | {
      kind: "operational";
      message: string;
      correlationId: string;
    };

export type CreateMeetingActionResult =
  | { ok: true; result: CreationResult }
  | { ok: false; failure: CreationFailure };

export const TITLE_MIN_CHARS = 1;
export const TITLE_MAX_CHARS = 100;
export const MAX_CREATION_REQUEST_ID_CHARS = 64;
export const MEETING_CODE_CHARS = 22;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_PROVISION_ATTEMPTS = 2;
