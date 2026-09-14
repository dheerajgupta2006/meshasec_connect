import "server-only";

/**
 * Operational diagnostics for meeting creation.
 *
 * Two guarantees this module exists to provide:
 *
 * 1. Every operational failure produces exactly one structured log line
 *    carrying a correlation ID, so a user-reported reference can be found
 *    without the log holding anything sensitive (Req 11.7, 11.8).
 * 2. Nothing reaches a log sink without passing through `redact` (Req 11.9).
 *
 * Never logged, by construction rather than by convention: the Meeting_Title
 * and the schedule values (user content, and neither helps diagnose a failure),
 * the session token, and in production the stack trace, because `error.stack`
 * from Prisma can embed the datasource URL.
 */

import { randomUUID } from "node:crypto";

export type FailureStage =
  | "auth"
  | "origin"
  | "input"
  | "profile"
  | "provision"
  | "code_generation"
  | "persistence"
  | "unexpected";

/** The single event name a log collector filters on for this feature. */
const OPERATIONAL_FAILURE_EVENT = "meeting_creation_failure";

/**
 * A degradation is not a failure: provisioning continues with empty optional
 * fields (Req 2.5), so it gets its own event and warn level rather than
 * polluting the failure stream.
 */
const PROFILE_DEGRADATION_EVENT = "meeting_creation_profile_degraded";

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * The shape-based rules. Order matters only in that the broadest rule must not
 * consume a narrower one's match first; each of these targets a disjoint shape,
 * and where they do overlap (`Bearer eyJ...`) either order still redacts.
 */
const REDACTION_RULES: readonly RedactionRule[] = [
  // Prisma connection errors embed the datasource URL, password included.
  {
    pattern: /postgres(?:ql)?:\/\/\S*/gi,
    replacement: "postgresql://[REDACTED]",
  },
  // Clerk secret key.
  {
    pattern: /sk_(?:test|live)_[A-Za-z0-9]+/g,
    replacement: "[REDACTED_CLERK_SECRET]",
  },
  // Clerk publishable key: not secret, but noise in logs.
  {
    pattern: /pk_(?:test|live)_[A-Za-z0-9]+/g,
    replacement: "[REDACTED_CLERK_PUBLISHABLE]",
  },
  // Session JWTs: three dot-separated base64url segments beginning `eyJ`.
  {
    pattern: /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED_TOKEN]",
  },
  // Authorization headers echoed into an error message.
  {
    pattern: /Bearer\s+\S+/gi,
    replacement: "Bearer [REDACTED]",
  },
];

/**
 * Backstop for a secret that leaks in a shape none of the rules above
 * anticipate: the literal configured value is replaced wherever it appears.
 */
const SECRET_ENV_NAMES = [
  "DATABASE_URL",
  "CLERK_SECRET_KEY",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

/**
 * A short configured value (a placeholder such as `...`, or an unset-but-empty
 * one) would turn the backstop into a find-and-replace over ordinary prose. Real
 * credentials are far longer than this floor.
 */
const MIN_ENV_LITERAL_CHARS = 8;

interface ErrorFacts {
  name: string;
  message: string;
  /** The Prisma error code when the thrown value carries one. */
  code: string | null;
  stack: string | null;
}

interface FailureLogRecord {
  event: string;
  correlationId: string;
  stage: FailureStage;
  clerkId: string | null;
  creationRequestId: string | null;
  error: {
    name: string;
    code?: string;
    message: string;
    stack?: string;
  };
}

interface DegradationLogRecord {
  event: string;
  correlationId: string;
  clerkId: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * The reference shown to the user on an operational failure and written to every
 * log record for the request. It identifies a request, not a principal, so a
 * UUID's 122 bits are ample and it carries nothing sensitive.
 */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Req 11.9: strips credentials, tokens, and connection strings while leaving
 * everything else byte-for-byte intact, so the surrounding diagnostic text stays
 * useful.
 */
export function redact(value: string): string {
  let redacted = value;

  for (const rule of REDACTION_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }

  for (const envName of SECRET_ENV_NAMES) {
    const literal = process.env[envName]?.trim();
    if (literal === undefined || literal.length < MIN_ENV_LITERAL_CHARS) {
      continue;
    }
    // split/join rather than a regex: the value is arbitrary text and must not
    // be interpreted as a pattern.
    redacted = redacted.split(literal).join(`[REDACTED_ENV:${envName}]`);
  }

  return redacted;
}

/**
 * Writes the one and only log record for an operational failure. Exactly one
 * `console.error` per failure, structured as a single JSON line so it survives
 * any downstream collector and matches the existing convention in
 * `src/app/api/meetings/token/route.ts`.
 */
export function logOperationalFailure(entry: {
  correlationId: string;
  stage: FailureStage;
  clerkId: string | null;
  creationRequestId: string | null;
  error: unknown;
}): void {
  const facts = readErrorFacts(entry.error);

  const record: FailureLogRecord = {
    event: OPERATIONAL_FAILURE_EVENT,
    correlationId: entry.correlationId,
    stage: entry.stage,
    clerkId: entry.clerkId,
    creationRequestId: entry.creationRequestId,
    error: {
      name: facts.name,
      message: redact(facts.message),
    },
  };

  if (facts.code !== null) {
    record.error.code = facts.code;
  }

  const stack = readLoggableStack(facts.stack);
  if (stack !== null) {
    record.error.stack = stack;
  }

  console.error(JSON.stringify(record));
}

/**
 * Req 2.5: Clerk profile data was unavailable. Provisioning continues with empty
 * optional fields, so this is a warning and never surfaces to the user. The
 * correlation ID ties it to the request's other records.
 */
export function logProfileDegradation(entry: {
  correlationId: string;
  clerkId: string;
  error: unknown;
}): void {
  const facts = readErrorFacts(entry.error);

  const record: DegradationLogRecord = {
    event: PROFILE_DEGRADATION_EVENT,
    correlationId: entry.correlationId,
    clerkId: entry.clerkId,
    error: {
      name: facts.name,
      message: redact(facts.message),
    },
  };

  const stack = readLoggableStack(facts.stack);
  if (stack !== null) {
    record.error.stack = stack;
  }

  console.warn(JSON.stringify(record));
}

/**
 * A catch clause receives `unknown`, and a rejected promise can carry any value
 * at all, so every field is read defensively rather than asserted.
 */
function readErrorFacts(error: unknown): ErrorFacts {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: readErrorCode(error),
      stack: typeof error.stack === "string" ? error.stack : null,
    };
  }

  return {
    name: describeType(error),
    message: describeValue(error),
    code: readErrorCode(error),
    stack: null,
  };
}

/**
 * Prisma's `PrismaClientKnownRequestError` exposes `code` (`P2002`, `P1001`,
 * and so on). Read structurally rather than through an `instanceof` check so
 * this module needs no Prisma import and still works for any error that follows
 * the same convention.
 */
function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * Stacks are logged outside production only, and still redacted: a Prisma stack
 * can quote the datasource URL.
 */
function readLoggableStack(stack: string | null): string | null {
  if (stack === null || process.env.NODE_ENV === "production") {
    return null;
  }
  return redact(stack);
}

function describeType(value: unknown): string {
  if (value === null) {
    return "NullThrown";
  }
  if (Array.isArray(value)) {
    return "ArrayThrown";
  }
  return `${capitalize(typeof value)}Thrown`;
}

/** `String(value)` throws on a symbol and on a null-prototype object. */
function describeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
      return String(value);
    case "symbol":
      return value.toString();
    default:
      break;
  }

  if (value === null) {
    return "null";
  }

  try {
    return JSON.stringify(value) ?? "[unserializable value]";
  } catch {
    return "[unserializable value]";
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
