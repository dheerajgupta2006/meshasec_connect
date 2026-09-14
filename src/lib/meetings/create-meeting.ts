import "server-only";

/**
 * Meeting_Creation_Service.
 *
 * Owns validation, idempotent replay, host resolution, meeting-code generation,
 * the transaction boundary, the bounded retry loop, and the mapping of every
 * thrown error onto the failure taxonomy.
 *
 * Resolves for every anticipated failure and never rejects: a throw crossing the
 * Server Action boundary is replaced by an opaque digest in production, which
 * would destroy the field-level error data the form needs.
 */

import { Prisma } from "@prisma/client";

import {
  logOperationalFailure,
  type FailureStage,
} from "@/lib/meetings/diagnostics";
import { generateMeetingCode } from "@/lib/meetings/meeting-code";
import {
  MAX_CODE_ATTEMPTS,
  MAX_PROVISION_ATTEMPTS,
  type CreateMeetingActionResult,
  type CreationFailure,
  type CreationResult,
} from "@/lib/meetings/types";
import {
  buildProvisionPlan,
  loadAuthoritativeProfile,
  type AuthoritativeProfile,
} from "@/lib/meetings/user-provisioning";
import {
  validateServerInput,
  type NormalizedCreationInput,
} from "@/lib/meetings/validation";
import { prisma } from "@/lib/prisma";

export interface CreateMeetingCommand {
  clerkId: string;
  rawInput: unknown;
  correlationId: string;
}

const OPERATIONAL_MESSAGE =
  "We could not create your meeting. Please try again.";

/** Which unique constraint a P2002 violated. */
type UniqueTarget =
  | "meetingCode"
  | "creationRequest"
  | "clerkId"
  | "email"
  | "unknown";

interface MeetingProjection {
  meetingCode: string;
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

export async function createMeeting(
  command: CreateMeetingCommand,
): Promise<CreateMeetingActionResult> {
  const { clerkId, rawInput, correlationId } = command;

  // Validation first: a rejected payload never reaches the Persistence_Layer.
  const validation = validateServerInput(rawInput, new Date());
  if (!validation.ok) {
    return {
      ok: false,
      failure: {
        kind: "validation",
        fieldErrors: validation.fieldErrors,
        formMessage: validation.formMessage,
      },
    };
  }

  const input = validation.value;

  try {
    // Replay: a completed Creation_Request_ID returns the meeting that actually
    // committed, rebuilt from the stored row rather than from this payload.
    const replayed = await readCommittedResult(
      clerkId,
      input.creationRequestId,
    );
    if (replayed !== null) {
      return { ok: true, result: replayed };
    }

    // Clerk profile data is loaded outside the transaction: holding a Postgres
    // connection open across an external round trip exhausts the pool.
    const profile = await resolveProfile(clerkId, correlationId);

    return await runAttemptLoop({
      clerkId,
      correlationId,
      input,
      profile,
    });
  } catch (error: unknown) {
    return fail({
      correlationId,
      clerkId,
      creationRequestId: input.creationRequestId,
      stage: classifyStage(error),
      error,
    });
  }
}

interface AttemptContext {
  clerkId: string;
  correlationId: string;
  input: NormalizedCreationInput;
  profile: AuthoritativeProfile | null;
}

/**
 * Every retry is a *new* transaction. PostgreSQL marks a transaction aborted
 * after any constraint violation, so a P2002 cannot be recovered from inside the
 * transaction that raised it.
 *
 * Code collisions and provisioning races have separate budgets so a provisioning
 * race cannot consume the meeting-code allowance.
 */
async function runAttemptLoop(
  context: AttemptContext,
): Promise<CreateMeetingActionResult> {
  const { clerkId, correlationId, input, profile } = context;

  let codeAttempts = 0;
  let provisionAttempts = 0;
  let dropEmail = false;

  for (;;) {
    const meetingCode = generateMeetingCode();

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const hostId = await resolveHostId(tx, clerkId, profile, dropEmail);

          const meeting = await tx.meeting.create({
            data: {
              title: input.normalizedTitle,
              hostId,
              meetingCode,
              startsAt: input.mode === "scheduled" ? input.startsAt : null,
              endsAt: input.mode === "scheduled" ? input.endsAt : null,
            },
            select: {
              id: true,
              meetingCode: true,
              title: true,
              startsAt: true,
              endsAt: true,
            },
          });

          await tx.meetingCreationRequest.create({
            data: {
              clerkId,
              creationRequestId: input.creationRequestId,
              meetingId: meeting.id,
            },
          });

          return toCreationResult(meeting);
        },
        { maxWait: 5000, timeout: 10000 },
      );

      return { ok: true, result };
    } catch (error: unknown) {
      const target = readUniqueTarget(error);

      if (target === null) {
        throw error;
      }

      switch (target) {
        case "meetingCode": {
          codeAttempts += 1;
          if (codeAttempts < MAX_CODE_ATTEMPTS) {
            continue;
          }
          return fail({
            correlationId,
            clerkId,
            creationRequestId: input.creationRequestId,
            stage: "code_generation",
            error,
          });
        }

        case "creationRequest": {
          // A concurrent duplicate won the unique-index race. Its meeting is the
          // one that committed, so this request replays that result.
          const winner = await readCommittedResult(
            clerkId,
            input.creationRequestId,
          );
          if (winner !== null) {
            return { ok: true, result: winner };
          }
          return fail({
            correlationId,
            clerkId,
            creationRequestId: input.creationRequestId,
            stage: "persistence",
            error,
          });
        }

        case "clerkId": {
          // Another request provisioned this Clerk subject first. The next
          // attempt's lookup finds the winner.
          provisionAttempts += 1;
          if (provisionAttempts < MAX_PROVISION_ATTEMPTS) {
            continue;
          }
          return fail({
            correlationId,
            clerkId,
            creationRequestId: input.creationRequestId,
            stage: "provision",
            error,
          });
        }

        case "email": {
          // Clerk-ID ownership is never traded away for an email.
          if (!dropEmail) {
            dropEmail = true;
            continue;
          }
          return fail({
            correlationId,
            clerkId,
            creationRequestId: input.creationRequestId,
            stage: "provision",
            error,
          });
        }

        default: {
          // An unrecognized constraint must not be absorbed into the retry loop.
          return fail({
            correlationId,
            clerkId,
            creationRequestId: input.creationRequestId,
            stage: "unexpected",
            error,
          });
        }
      }
    }
  }
}

/** Finds the local host row, provisioning it only when absent. */
async function resolveHostId(
  tx: Prisma.TransactionClient,
  clerkId: string,
  profile: AuthoritativeProfile | null,
  dropEmail: boolean,
): Promise<string> {
  const existing = await tx.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });

  if (existing !== null) {
    return existing.id;
  }

  const plan = await buildProvisionPlan(tx, clerkId, profile);

  const created = await tx.user.create({
    data: {
      clerkId: plan.clerkId,
      name: plan.name,
      image: plan.image,
      email: dropEmail ? null : plan.email,
    },
    select: { id: true },
  });

  return created.id;
}

/**
 * A failure to read Clerk profile data is a degradation, not a failure: the row
 * is provisioned with empty optional fields and the request still succeeds.
 */
async function resolveProfile(
  clerkId: string,
  correlationId: string,
): Promise<AuthoritativeProfile | null> {
  const existing = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });

  if (existing !== null) {
    return null;
  }

  return loadAuthoritativeProfile(correlationId);
}

async function readCommittedResult(
  clerkId: string,
  creationRequestId: string,
): Promise<CreationResult | null> {
  const record = await prisma.meetingCreationRequest.findUnique({
    where: {
      clerkId_creationRequestId: { clerkId, creationRequestId },
    },
    select: {
      meeting: {
        select: {
          meetingCode: true,
          title: true,
          startsAt: true,
          endsAt: true,
        },
      },
    },
  });

  return record === null ? null : toCreationResult(record.meeting);
}

function toCreationResult(meeting: MeetingProjection): CreationResult {
  return {
    meetingCode: meeting.meetingCode,
    title: meeting.title,
    startsAt: meeting.startsAt === null ? null : meeting.startsAt.toISOString(),
    endsAt: meeting.endsAt === null ? null : meeting.endsAt.toISOString(),
  };
}

/**
 * Returns which unique constraint a P2002 violated, or null when the error is
 * not a unique-constraint violation at all.
 *
 * The composite idempotency index contains `clerkId`, so it must be tested
 * before the bare `clerkId` case.
 */
function readUniqueTarget(error: unknown): UniqueTarget | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const fields = readTargetFields(error.meta);

  if (fields.includes("meetingcode")) {
    return "meetingCode";
  }
  if (fields.includes("creationrequestid")) {
    return "creationRequest";
  }
  if (fields.includes("clerkid")) {
    return "clerkId";
  }
  if (fields.includes("email")) {
    return "email";
  }
  return "unknown";
}

function readTargetFields(meta: unknown): string {
  if (typeof meta !== "object" || meta === null || !("target" in meta)) {
    return "";
  }

  const target: unknown = (meta as { target: unknown }).target;

  if (Array.isArray(target)) {
    return target.map((entry) => String(entry)).join(",").toLowerCase();
  }
  if (typeof target === "string") {
    return target.toLowerCase();
  }
  return "";
}

/**
 * Anything Prisma raises is a persistence-stage failure, including the
 * unreachable/timeout/pool-exhausted codes (P1001, P1002, P1017, P2024).
 * Everything else is genuinely unexpected.
 */
function classifyStage(error: unknown): FailureStage {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientValidationError
  ) {
    return "persistence";
  }
  return "unexpected";
}

function fail(entry: {
  correlationId: string;
  clerkId: string;
  creationRequestId: string | null;
  stage: FailureStage;
  error: unknown;
}): CreateMeetingActionResult {
  logOperationalFailure({
    correlationId: entry.correlationId,
    stage: entry.stage,
    clerkId: entry.clerkId,
    creationRequestId: entry.creationRequestId,
    error: entry.error,
  });

  const failure: CreationFailure = {
    kind: "operational",
    message: OPERATIONAL_MESSAGE,
    correlationId: entry.correlationId,
  };

  return { ok: false, failure };
}
