import "server-only";

/**
 * Local_User resolution and provisioning.
 *
 * Server-only for two reasons: identity is read from Clerk's Backend API, never
 * from a browser-submitted field (Req 2.1), and the email pre-check runs on the
 * caller's transaction client.
 *
 * The full resolution order, split across this module and the service:
 *
 * 1. `tx.user.findUnique({ where: { clerkId } })`. A hit is the host, unchanged
 *    (Req 2.2). This feature never mutates an existing row: profile refresh is a
 *    separate concern, and writing on every creation would add contention for no
 *    requirement.
 * 2. On a miss, Clerk's Backend User supplies the optional fields (Req 2.4).
 * 3. `currentUser()` returning null or throwing is *not* fatal — the row is
 *    provisioned with the Clerk ID and empty optional fields and the degradation
 *    is logged (Req 2.5). This is deliberately unlike `auth()` failing, which is
 *    an Operational_Error, because Req 2.5 mandates a usable host regardless.
 * 4. The candidate email is pre-checked and omitted when it belongs to a
 *    different row (Req 2.6). Clerk-ID ownership is never traded for an email.
 * 5. That pre-check is not atomic, so a concurrent writer can still win and
 *    raise `P2002`. The service's attempt loop owns that retry (Req 2.7, 2.8).
 */

import { currentUser } from "@clerk/nextjs/server";
import type { Prisma } from "@prisma/client";

import { logProfileDegradation } from "@/lib/meetings/diagnostics";

export interface AuthoritativeProfile {
  name: string | null;
  /** Present only when Clerk reports the primary email as verified. */
  verifiedEmail: string | null;
  image: string | null;
}

export interface ProvisionPlan {
  clerkId: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

type ClerkBackendUser = NonNullable<Awaited<ReturnType<typeof currentUser>>>;

/**
 * `loadAuthoritativeProfile` takes only a correlation ID by contract, and the
 * two paths that degrade are exactly the paths where Clerk did not hand back a
 * subject. The correlation ID is what joins this record to the request's other
 * log lines, which do carry the real Clerk ID.
 */
const CLERK_ID_UNAVAILABLE = "unknown";

const NO_BACKEND_USER_MESSAGE =
  "Clerk currentUser() returned no Backend User for the active session.";

/**
 * Reads Clerk's Backend User and maps it to Authoritative_Profile_Data.
 *
 * Returns `null` when profile data is unavailable. That is a degradation, not a
 * failure: the caller provisions with empty optional fields and the request
 * still succeeds (Req 2.5).
 */
export async function loadAuthoritativeProfile(
  correlationId: string,
): Promise<AuthoritativeProfile | null> {
  let clerkUser: ClerkBackendUser | null;

  try {
    clerkUser = await currentUser();
  } catch (error: unknown) {
    logProfileDegradation({
      correlationId,
      clerkId: CLERK_ID_UNAVAILABLE,
      error,
    });
    return null;
  }

  if (clerkUser === null) {
    logProfileDegradation({
      correlationId,
      clerkId: CLERK_ID_UNAVAILABLE,
      error: new Error(NO_BACKEND_USER_MESSAGE),
    });
    return null;
  }

  return mapAuthoritativeProfile(clerkUser);
}

/**
 * Builds the row this request would insert for `clerkId`.
 *
 * On a `clerkId` hit the plan mirrors the stored values verbatim, so nothing the
 * caller does with it can modify the existing host (Req 2.2). On a miss the
 * Clerk profile fills the optional fields, minus any email that already belongs
 * to someone else (Req 2.6).
 */
export async function buildProvisionPlan(
  tx: Prisma.TransactionClient,
  clerkId: string,
  profile: AuthoritativeProfile | null,
): Promise<ProvisionPlan> {
  const existing = await tx.user.findUnique({
    where: { clerkId },
    select: { name: true, email: true, image: true },
  });

  if (existing !== null) {
    return {
      clerkId,
      name: existing.name,
      email: existing.email,
      image: existing.image,
    };
  }

  const candidateEmail = normalizeOptional(profile?.verifiedEmail ?? null);

  return {
    clerkId,
    name: profile?.name ?? null,
    image: profile?.image ?? null,
    email:
      candidateEmail === null
        ? null
        : await claimEmail(tx, clerkId, candidateEmail),
  };
}

/**
 * Req 2.6: returns the email only when it is unowned, or already owned by this
 * same Clerk subject. A conflict drops the email rather than the association —
 * an email is optional profile data, the Clerk ID is the identity.
 */
async function claimEmail(
  tx: Prisma.TransactionClient,
  clerkId: string,
  candidateEmail: string,
): Promise<string | null> {
  const emailOwner = await tx.user.findUnique({
    where: { email: candidateEmail },
    select: { clerkId: true },
  });

  if (emailOwner === null || emailOwner.clerkId === clerkId) {
    return candidateEmail;
  }
  return null;
}

/**
 * Req 2.4: `verifiedEmail` is populated only for a verified primary address.
 * The glossary defines Authoritative_Profile_Data as the *verified* primary
 * email, so an unverified, failed, or expired one is simply absent.
 */
function mapAuthoritativeProfile(
  clerkUser: ClerkBackendUser,
): AuthoritativeProfile {
  const primaryEmail = clerkUser.primaryEmailAddress;
  const isVerified = primaryEmail?.verification?.status === "verified";

  return {
    name:
      clerkUser.fullName ?? clerkUser.firstName ?? clerkUser.username ?? null,
    verifiedEmail:
      isVerified && primaryEmail !== null
        ? normalizeOptional(primaryEmail.emailAddress)
        : null,
    image: clerkUser.imageUrl || null,
  };
}

/**
 * An empty string is absence, not a value. Letting `""` through would occupy the
 * `User.email` unique index and collide with the next such row.
 */
function normalizeOptional(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
