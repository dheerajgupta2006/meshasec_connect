"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { createMeeting } from "@/lib/meetings/create-meeting";
import {
  logOperationalFailure,
  newCorrelationId,
} from "@/lib/meetings/diagnostics";
import { assertTrustedOrigin } from "@/lib/meetings/origin";
import type { CreateMeetingActionResult } from "@/lib/meetings/types";

const UNAUTHENTICATED_MESSAGE =
  "Your session has ended. Sign in again to create this meeting.";
const UNTRUSTED_ORIGIN_MESSAGE =
  "This request could not be verified. Reload the page and try again.";
const AUTH_UNAVAILABLE_MESSAGE =
  "We could not verify your session. Please try again.";

/**
 * A Server Action is a public POST endpoint with no authentication of its own,
 * so identity and trust are established here on every call and `input` is
 * treated as untrusted. It is typed `unknown` deliberately: Next.js validates
 * the action ID, not the argument's shape.
 */
export async function createMeetingAction(
  input: unknown,
): Promise<CreateMeetingActionResult> {
  const correlationId = newCorrelationId();

  let clerkId: string | null;

  try {
    const session = await auth();
    clerkId = session.userId;
  } catch (error: unknown) {
    logOperationalFailure({
      correlationId,
      stage: "auth",
      clerkId: null,
      creationRequestId: null,
      error,
    });
    return {
      ok: false,
      failure: {
        kind: "operational",
        message: AUTH_UNAVAILABLE_MESSAGE,
        correlationId,
      },
    };
  }

  if (clerkId === null) {
    return {
      ok: false,
      failure: {
        kind: "authorization",
        reason: "unauthenticated",
        message: UNAUTHENTICATED_MESSAGE,
      },
    };
  }

  // Next.js already compares Origin against Host for Server Actions; this is the
  // typed, in-service equivalent so the failure carries the right taxonomy.
  const originCheck = assertTrustedOrigin(headers());
  if (!originCheck.trusted) {
    return {
      ok: false,
      failure: {
        kind: "authorization",
        reason: "untrusted_origin",
        message: UNTRUSTED_ORIGIN_MESSAGE,
      },
    };
  }

  const result = await createMeeting({
    clerkId,
    rawInput: input,
    correlationId,
  });

  if (result.ok) {
    // `/dashboard` already opts out of the server cache; this discards the
    // client Router Cache entry so a navigation right after creation is fresh.
    revalidatePath("/dashboard");
  }

  return result;
}
