import "server-only";

/**
 * Resolves the signed-in Clerk user to a local `User` row.
 *
 * Every connection feature keys off the local row rather than the Clerk subject,
 * because `ConnectionRequest.senderId` / `receiverId` are foreign keys to
 * `User.id`.
 *
 * `username` is nullable in the schema so its migration stayed additive, so this
 * module also backfills a handle for rows created before the column existed.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { cache } from "react";

import { prisma } from "@/lib/prisma";
import {
  USERNAME_MAX,
  normalizeUsername,
  slugifyUsername,
} from "@/lib/users/username";

export interface LocalUser {
  id: string;
  clerkId: string;
  username: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

const CLAIM_ATTEMPTS = 6;

// Re-exported so existing importers keep working; the implementation lives in a
// dependency-free module because this one requires the RSC runtime.
export { normalizeUsername };

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** Finds a handle nobody holds yet. The unique index is still authoritative. */
async function findFreeUsername(preferred: string): Promise<string> {
  const base = slugifyUsername(preferred);

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const candidate =
      attempt === 0
        ? base
        : `${base.slice(0, USERNAME_MAX - 5)}_${randomSuffix()}`;

    const taken = await prisma.user.findUnique({
      where: { username: candidate },
      select: { id: true },
    });

    if (taken === null) {
      return candidate;
    }
  }

  return `${base.slice(0, USERNAME_MAX - 9)}_${Date.now().toString(36)}`;
}

/** Which unique column a P2002 violated, or null for any other error. */
function conflictField(
  error: unknown,
): "clerkId" | "username" | "email" | "other" | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const target = JSON.stringify(error.meta?.target ?? "").toLowerCase();

  if (target.includes("clerkid")) {
    return "clerkId";
  }
  if (target.includes("username")) {
    return "username";
  }
  if (target.includes("email")) {
    return "email";
  }
  return "other";
}

interface ClerkProfile {
  preferredUsername: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

async function readClerkProfile(clerkId: string): Promise<ClerkProfile> {
  try {
    const clerkUser = await currentUser();

    if (clerkUser === null) {
      return {
        preferredUsername: clerkId,
        name: null,
        email: null,
        image: null,
      };
    }

    const email = clerkUser.primaryEmailAddress?.emailAddress ?? null;
    const name =
      clerkUser.fullName ?? clerkUser.firstName ?? clerkUser.username ?? null;

    return {
      preferredUsername:
        clerkUser.username ?? email?.split("@")[0] ?? name ?? clerkId,
      name,
      email,
      image: clerkUser.imageUrl || null,
    };
  } catch {
    // Profile data is a convenience; identity comes from the session.
    return { preferredUsername: clerkId, name: null, email: null, image: null };
  }
}

/**
 * Cheap read for hot paths: one query, no provisioning, no writes.
 *
 * `ensureCurrentUser` can issue several round trips and may write, which is far
 * too expensive for an endpoint polled every few seconds. Use this wherever the
 * row is already expected to exist.
 */
async function resolveCurrentLocalUserId(): Promise<string | null> {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return null;
  }

  const row = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });

  return row?.id ?? null;
}

/**
 * Request-scoped memoisation.
 *
 * `React.cache` collapses repeat calls within one render pass or request. That
 * matters here because the header, the nav badge, and the page body each resolve
 * the current user independently — without this, a single page load pays for the
 * same lookup several times over.
 */
export const getCurrentLocalUserId: () => Promise<string | null> = cache(
  resolveCurrentLocalUserId,
);

/**
 * Returns the local row for the signed-in user, creating it or backfilling its
 * username when needed. Returns `null` when there is no session.
 */
async function resolveCurrentUser(): Promise<LocalUser | null> {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return null;
  }

  let existing = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      clerkId: true,
      username: true,
      name: true,
      email: true,
      image: true,
    },
  });

  if (existing !== null && existing.username !== null) {
    return { ...existing, clerkId, username: existing.username };
  }

  const profile = await readClerkProfile(clerkId);

  // Email is unique, so a collision must be survivable rather than fatal.
  let emailCandidate = (await isEmailFree(profile.email))
    ? profile.email
    : null;

  // Several server components resolve the user on the same page render, so the
  // create below genuinely races against itself on a user's first visit. Every
  // unique column involved therefore has a recovery path.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const username = await findFreeUsername(profile.preferredUsername);

    try {
      if (existing !== null) {
        // Row predates the username column: backfill only that field.
        const updated = await prisma.user.update({
          where: { id: existing.id },
          data: { username },
          select: {
            id: true,
            username: true,
            name: true,
            email: true,
            image: true,
          },
        });

        return {
          id: updated.id,
          clerkId,
          username: updated.username ?? username,
          name: updated.name,
          email: updated.email,
          image: updated.image,
        };
      }

      const created = await prisma.user.create({
        data: {
          clerkId,
          username,
          name: profile.name,
          image: profile.image,
          email: emailCandidate,
        },
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          image: true,
        },
      });

      return {
        id: created.id,
        clerkId,
        username: created.username ?? username,
        name: created.name,
        email: created.email,
        image: created.image,
      };
    } catch (error: unknown) {
      const field = conflictField(error);

      if (field === null || field === "other") {
        throw error;
      }

      if (field === "clerkId") {
        // A concurrent render won the race. Its row is the user's row, so adopt
        // it rather than competing for the same identity.
        const winner = await prisma.user.findUnique({
          where: { clerkId },
          select: {
            id: true,
            clerkId: true,
            username: true,
            name: true,
            email: true,
            image: true,
          },
        });

        if (winner === null) {
          // Rolled back between the conflict and this read; try again.
          continue;
        }

        if (winner.username !== null) {
          return { ...winner, clerkId, username: winner.username };
        }

        // Won the insert but has no handle yet: fall through to the backfill
        // branch on the next pass.
        existing = winner;
        continue;
      }

      if (field === "email") {
        // Profile data is optional; identity is not. Drop the email and retry.
        emailCandidate = null;
        continue;
      }

      // Username collision: the next pass picks a different handle.
    }
  }

  return null;
}

/**
 * Request-scoped memoisation of the provisioning path.
 *
 * Beyond saving round trips, this removes the create race entirely for the
 * common case: three components resolving the same new user on one page load now
 * share one insert instead of competing and recovering from `P2002`.
 */
export const ensureCurrentUser: () => Promise<LocalUser | null> =
  cache(resolveCurrentUser);

async function isEmailFree(email: string | null): Promise<boolean> {
  if (email === null || email.trim().length === 0) {
    return false;
  }
  const owner = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  return owner === null;
}
