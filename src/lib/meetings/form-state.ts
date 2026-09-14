/**
 * Pure state machine for the Meeting_Creation_Form.
 *
 * Isomorphic and side-effect free: no `Date.now()`, no crypto, no DOM, no
 * `next/*`. Everything time-based or random is supplied by the caller through
 * events, which is what makes the duplicate-submit guard, the
 * Creation_Request_ID lifecycle, and value retention assertable as properties
 * without a DOM.
 */

import type {
  CreateMeetingInput,
  CreationFailure,
  CreationFieldName,
  CreationResult,
  MeetingMode,
} from "@/lib/meetings/types";
import type { FieldErrors, ValidationOutcome } from "@/lib/meetings/validation";

export interface CreationDraft {
  title: string;
  mode: MeetingMode;
  /** Raw datetime-local strings, preserved verbatim across mode switches. */
  startsAtLocal: string;
  endsAtLocal: string;
}

export type FormStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; result: CreationResult; navigationFailed: boolean }
  | { kind: "error"; failure: CreationFailure };

export interface FormState {
  draft: CreationDraft;
  status: FormStatus;
  fieldErrors: FieldErrors;
  /** null until the first Creation_Intent. */
  creationRequestId: string | null;
  /** Signature of the values the current creationRequestId was minted for. */
  intentSignature: string | null;
  focusTarget: CreationFieldName | null;
  announcement: string;
}

export type FormEvent =
  | {
      type: "FIELD_CHANGED";
      field: "title" | "startsAtLocal" | "endsAtLocal";
      value: string;
    }
  | { type: "MODE_CHANGED"; mode: MeetingMode }
  | {
      type: "SUBMIT_REQUESTED";
      validation: ValidationOutcome<CreateMeetingInput>;
      signature: string;
      /** Freshly minted on every submit; adopted only when the signature changed. */
      candidateRequestId: string;
    }
  | { type: "SERVER_SUCCEEDED"; result: CreationResult }
  | { type: "SERVER_FAILED"; failure: CreationFailure }
  | { type: "NAVIGATION_FAILED" }
  | { type: "FOCUS_APPLIED" };

/** Canonical control order, used to pick the first invalid field (Req 12.5). */
const FIELD_FOCUS_ORDER: readonly CreationFieldName[] = [
  "title",
  "mode",
  "startsAt",
  "endsAt",
];

const LOADING_ANNOUNCEMENT = "Creating your meeting. Please wait.";
const SUCCESS_ANNOUNCEMENT = "Meeting created. Opening the pre-join lobby.";
const NAVIGATION_FAILED_ANNOUNCEMENT =
  "Meeting created, but the lobby did not open automatically. Use the lobby link to continue.";
const CLIENT_INVALID_ANNOUNCEMENT =
  "Your meeting was not submitted. Check the highlighted fields and try again.";
const SERVER_VALIDATION_ANNOUNCEMENT =
  "Your meeting was not created. Check the highlighted fields and try again.";
const SERVER_AUTHORIZATION_ANNOUNCEMENT =
  "Your meeting was not created. Sign in again to continue.";
const SERVER_OPERATIONAL_ANNOUNCEMENT =
  "Your meeting was not created. You can try again.";

export const initialFormState: FormState = {
  draft: {
    title: "",
    mode: "instant",
    startsAtLocal: "",
    endsAtLocal: "",
  },
  status: { kind: "idle" },
  fieldErrors: {},
  creationRequestId: null,
  intentSignature: null,
  focusTarget: null,
  announcement: "",
};

/**
 * Stable string over the four submitted values; drives Creation_Request_ID
 * rotation. Raw values, not normalized ones: any change the user can make to
 * title, mode, start, or end must produce a different signature (Req 6.6).
 */
export function draftSignature(draft: CreationDraft): string {
  return JSON.stringify([
    draft.title,
    draft.mode,
    draft.startsAtLocal,
    draft.endsAtLocal,
  ]);
}

/** Pure. No Date.now(), no crypto, no side effects. */
export function meetingCreationReducer(
  state: FormState,
  event: FormEvent,
): FormState {
  switch (event.type) {
    case "FIELD_CHANGED": {
      return {
        ...state,
        draft: applyFieldChange(state.draft, event.field, event.value),
        fieldErrors: withoutFieldError(
          state.fieldErrors,
          fieldNameFor(event.field),
        ),
      };
    }

    case "MODE_CHANGED": {
      // Only `mode` moves. startsAtLocal and endsAtLocal are never cleared,
      // which is the entire mechanism behind Req 3.8 and 3.9.
      return {
        ...state,
        draft: { ...state.draft, mode: event.mode },
        fieldErrors: withoutFieldError(state.fieldErrors, "mode"),
      };
    }

    case "SUBMIT_REQUESTED": {
      // Req 6.4: a request or a definitive result is already outstanding, so the
      // activation is ignored outright and no identifier is adopted.
      if (state.status.kind === "loading" || state.status.kind === "success") {
        return state;
      }

      if (!event.validation.ok) {
        // Stays in the current phase: no request is sent (Req 11.1, 12.5).
        return {
          ...state,
          fieldErrors: event.validation.fieldErrors,
          focusTarget: firstInvalidField(event.validation.fieldErrors),
          announcement: CLIENT_INVALID_ANNOUNCEMENT,
        };
      }

      const rotate =
        state.creationRequestId === null ||
        event.signature !== state.intentSignature;

      return {
        ...state,
        status: { kind: "loading" },
        fieldErrors: {},
        creationRequestId: rotate
          ? event.candidateRequestId
          : state.creationRequestId,
        intentSignature: event.signature,
        focusTarget: null,
        announcement: LOADING_ANNOUNCEMENT,
      };
    }

    case "SERVER_SUCCEEDED": {
      // Success is terminal: a committed Creation_Result is never replaced.
      if (state.status.kind === "success") {
        return state;
      }
      return {
        ...state,
        status: { kind: "success", result: event.result, navigationFailed: false },
        fieldErrors: {},
        focusTarget: null,
        announcement: SUCCESS_ANNOUNCEMENT,
      };
    }

    case "SERVER_FAILED": {
      if (state.status.kind === "success") {
        return state;
      }
      // Req 11.5: every draft value is retained, and the Creation_Request_ID is
      // kept so a retry of unchanged values stays idempotent (Req 6.10).
      // focusTarget stays null so entering the error state never moves focus.
      return {
        ...state,
        status: { kind: "error", failure: event.failure },
        fieldErrors:
          event.failure.kind === "validation" ? event.failure.fieldErrors : {},
        focusTarget: null,
        announcement: announcementFor(event.failure),
      };
    }

    case "NAVIGATION_FAILED": {
      if (state.status.kind !== "success" || state.status.navigationFailed) {
        return state;
      }
      return {
        ...state,
        status: {
          kind: "success",
          result: state.status.result,
          navigationFailed: true,
        },
        announcement: NAVIGATION_FAILED_ANNOUNCEMENT,
      };
    }

    case "FOCUS_APPLIED": {
      if (state.focusTarget === null) {
        return state;
      }
      return { ...state, focusTarget: null };
    }

    default: {
      return state;
    }
  }
}

function applyFieldChange(
  draft: CreationDraft,
  field: "title" | "startsAtLocal" | "endsAtLocal",
  value: string,
): CreationDraft {
  switch (field) {
    case "title":
      return { ...draft, title: value };
    case "startsAtLocal":
      return { ...draft, startsAtLocal: value };
    case "endsAtLocal":
      return { ...draft, endsAtLocal: value };
    default:
      return draft;
  }
}

function fieldNameFor(
  field: "title" | "startsAtLocal" | "endsAtLocal",
): CreationFieldName {
  switch (field) {
    case "title":
      return "title";
    case "startsAtLocal":
      return "startsAt";
    case "endsAtLocal":
      return "endsAt";
    default:
      return "title";
  }
}

function withoutFieldError(
  fieldErrors: FieldErrors,
  field: CreationFieldName,
): FieldErrors {
  if (fieldErrors[field] === undefined) {
    return fieldErrors;
  }
  const next: FieldErrors = { ...fieldErrors };
  delete next[field];
  return next;
}

function firstInvalidField(fieldErrors: FieldErrors): CreationFieldName | null {
  for (const field of FIELD_FOCUS_ORDER) {
    if (fieldErrors[field] !== undefined) {
      return field;
    }
  }
  return null;
}

function announcementFor(failure: CreationFailure): string {
  switch (failure.kind) {
    case "validation":
      return SERVER_VALIDATION_ANNOUNCEMENT;
    case "authorization":
      return SERVER_AUTHORIZATION_ANNOUNCEMENT;
    case "operational":
      return SERVER_OPERATIONAL_ANNOUNCEMENT;
    default:
      return SERVER_OPERATIONAL_ANNOUNCEMENT;
  }
}
