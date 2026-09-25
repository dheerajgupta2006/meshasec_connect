"use server";

/**
 * Server Actions for creating and managing groups.
 *
 * Two gates, and they are different questions:
 *
 * - **Membership** decides whether you can see a group at all, and is resolved by
 *   `groupRoleFor` from the database. A non-member always gets the same refusal as
 *   someone naming a group that does not exist, so group ids cannot be probed.
 * - **An accepted connection** decides who you may *add*. It is re-checked here on
 *   every add, never trusted from the list the client was shown, because the
 *   connection can be removed between rendering the picker and clicking it.
 *
 * Deliberately not required: a connection between every pair of members. Adding
 * needs one, but a group of five would otherwise collapse the moment any one pair
 * disconnected, and nobody would understand why.
 */

import { GroupRole, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { areUsersConnected } from "@/lib/connections/queries";
import { MAX_GROUP_MEMBERS, MIN_INITIAL_MEMBERS } from "@/lib/groups/limits";
import {
  canManageMembers,
  groupRoleFor,
  type GroupPerson,
} from "@/lib/groups/queries";
import {
  capacityLeft,
  isValidId,
  normalizeMemberIds,
  validateGroupDescription,
  validateGroupName,
} from "@/lib/groups/validation";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser } from "@/lib/users/current-user";

export interface GroupActionResult {
  ok: boolean;
  message: string;
}

export interface CreateGroupResult extends GroupActionResult {
  /** Present only on success, so the caller can navigate straight in. */
  groupId: string | null;
}

const SIGN_IN_REQUIRED = "Your session has ended. Sign in again to continue.";

/**
 * One refusal for "not a member" and "no such group".
 *
 * Distinguishing them would turn any group id into an oracle for whether that
 * group exists, which is the same reasoning behind `NOT_HOST` in meeting
 * moderation.
 */
const NO_SUCH_GROUP = "That group does not exist, or you are not a member.";

const NOT_ALLOWED = "Only the group owner or an admin can do that.";

function throttle(
  action: Parameters<typeof consumeRateLimit>[0],
  subject: string,
): string | null {
  const verdict = consumeRateLimit(action, subject);

  if (verdict.allowed) {
    return null;
  }

  return `You are doing that too often. Try again in ${describeRetryAfter(
    verdict.retryAfterSeconds,
  )}.`;
}

function refreshGroup(groupId: string): void {
  // The dashboard shows a groups summary, so it is revalidated too.
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/groups");
  revalidatePath(`/dashboard/groups/${groupId}`);
}

/**
 * Filters a candidate list down to people the caller may actually add.
 *
 * Runs the connection check in parallel across candidates: they are independent
 * reads, and doing them in sequence made adding eight people eight serialized
 * round trips to a remote database.
 *
 * Returns the permitted ids plus the handles that were refused, so the caller can
 * say which ones did not go through rather than failing the whole batch silently.
 */
async function partitionAddable(
  callerId: string,
  candidateIds: readonly string[],
): Promise<{ allowed: GroupPerson[]; refused: string[] }> {
  const people = await prisma.user.findMany({
    where: { id: { in: [...candidateIds] } },
    select: { id: true, username: true, name: true },
  });

  const checks = await Promise.all(
    people.map(async (person) => ({
      person,
      connected: await areUsersConnected(callerId, person.id),
    })),
  );

  const allowed: GroupPerson[] = [];
  const refused: string[] = [];

  checks.forEach(({ person, connected }) => {
    const handle = `@${person.username ?? person.id.slice(0, 8)}`;

    if (!connected || person.id === callerId) {
      refused.push(handle);
      return;
    }

    allowed.push({
      id: person.id,
      username: person.username ?? person.id.slice(0, 8),
      name: person.name,
    });
  });

  // An id that matched no user row at all is also a refusal, reported generically
  // because naming it would confirm which ids exist.
  const found = new Set(people.map((person) => person.id));
  candidateIds.forEach((id) => {
    if (!found.has(id)) {
      refused.push("someone who no longer exists");
    }
  });

  return { allowed, refused };
}

/**
 * Creates a group with the caller as owner and the chosen connections as members.
 *
 * One transaction, so a group can never exist with a partial roster — a half-built
 * group would be visible to some of the people who were supposed to be in it and
 * invisible to the rest.
 */
export async function createGroup(
  rawName: unknown,
  rawDescription: unknown,
  rawMemberIds: unknown,
): Promise<CreateGroupResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, groupId: null };
  }

  const name = validateGroupName(rawName);

  if (!name.ok) {
    return { ok: false, message: name.message, groupId: null };
  }

  const description = validateGroupDescription(rawDescription);

  if (!description.ok) {
    return { ok: false, message: description.message, groupId: null };
  }

  // The owner takes one of the seats, so a new group can hold one fewer member
  // than the ceiling.
  const members = normalizeMemberIds(rawMemberIds, {
    minimum: MIN_INITIAL_MEMBERS,
    capacityLeft: MAX_GROUP_MEMBERS - 1,
  });

  if (!members.ok) {
    return { ok: false, message: members.message, groupId: null };
  }

  // Charged after validation, so rejected input cannot burn the caller's own
  // quota — the same ordering `sendConnectionRequest` uses.
  const throttled = throttle("groupCreate", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled, groupId: null };
  }

  const { allowed, refused } = await partitionAddable(me.id, members.ids);

  if (allowed.length < MIN_INITIAL_MEMBERS) {
    return {
      ok: false,
      message:
        "You can only add people you are connected with. None of that selection qualified.",
      groupId: null,
    };
  }

  let groupId: string;

  try {
    const group = await prisma.group.create({
      data: {
        name: name.name,
        description: description.description,
        ownerId: me.id,
        members: {
          create: [
            { userId: me.id, role: GroupRole.OWNER },
            ...allowed.map((person) => ({
              userId: person.id,
              role: GroupRole.MEMBER,
            })),
          ],
        },
      },
      select: { id: true },
    });

    groupId = group.id;
  } catch (error: unknown) {
    console.error("create_group_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });

    return {
      ok: false,
      message: "We could not create that group. Please try again.",
      groupId: null,
    };
  }

  refreshGroup(groupId);

  const skipped =
    refused.length === 0
      ? ""
      : ` Could not add ${refused.join(", ")} — you need an accepted connection first.`;

  return {
    ok: true,
    message: `Created ${name.name} with ${String(allowed.length + 1)} members.${skipped}`,
    groupId,
  };
}

/** Adds accepted connections to a group. Owner and admins only. */
export async function addGroupMembers(
  groupId: string,
  rawMemberIds: unknown,
): Promise<GroupActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  if (!isValidId(groupId)) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  const myRole = await groupRoleFor(groupId, me.id);

  if (myRole === null) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  if (!canManageMembers(myRole)) {
    return { ok: false, message: NOT_ALLOWED };
  }

  const existing = await prisma.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });

  const members = normalizeMemberIds(rawMemberIds, {
    minimum: 1,
    capacityLeft: capacityLeft(existing.length),
  });

  if (!members.ok) {
    return { ok: false, message: members.message };
  }

  const throttled = throttle("groupManage", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  const alreadyIn = new Set(existing.map((member) => member.userId));
  const fresh = members.ids.filter((id) => !alreadyIn.has(id));

  if (fresh.length === 0) {
    return { ok: false, message: "They are already in this group." };
  }

  const { allowed, refused } = await partitionAddable(me.id, fresh);

  if (allowed.length === 0) {
    return {
      ok: false,
      message:
        "You can only add people you are connected with. None of that selection qualified.",
    };
  }

  try {
    // `createMany` with `skipDuplicates` rather than a loop of upserts: the unique
    // index is what settles a race between two admins adding the same person, and
    // this lets the database settle it in one statement.
    await prisma.groupMember.createMany({
      data: allowed.map((person) => ({
        groupId,
        userId: person.id,
        role: GroupRole.MEMBER,
      })),
      skipDuplicates: true,
    });
  } catch (error: unknown) {
    console.error("add_group_members_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });

    return { ok: false, message: "We could not add them. Please try again." };
  }

  refreshGroup(groupId);

  const skipped =
    refused.length === 0
      ? ""
      : ` Skipped ${refused.join(", ")} — you need an accepted connection first.`;

  return {
    ok: true,
    message: `Added ${allowed.map((person) => `@${person.username}`).join(", ")}.${skipped}`,
  };
}

/**
 * Removes someone from a group. Owner and admins only.
 *
 * The owner cannot be removed by anybody, including an admin: ownership is the
 * one role that has to be surrendered rather than taken, otherwise an admin could
 * evict the person who promoted them and take the group.
 */
export async function removeGroupMember(
  groupId: string,
  targetUserId: string,
): Promise<GroupActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  if (!isValidId(groupId) || !isValidId(targetUserId)) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  const myRole = await groupRoleFor(groupId, me.id);

  if (myRole === null) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  if (!canManageMembers(myRole)) {
    return { ok: false, message: NOT_ALLOWED };
  }

  if (targetUserId === me.id) {
    return {
      ok: false,
      message: "Use Leave group to remove yourself.",
    };
  }

  const throttled = throttle("groupManage", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  const target = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    select: { role: true, user: { select: { username: true } } },
  });

  if (target === null) {
    return { ok: false, message: "They are not in this group." };
  }

  if (target.role === GroupRole.OWNER) {
    return { ok: false, message: "The owner cannot be removed." };
  }

  // An admin outranks a member but not another admin, so demoting is the owner's
  // job. Without this, two admins could remove each other.
  if (target.role === GroupRole.ADMIN && myRole !== GroupRole.OWNER) {
    return { ok: false, message: "Only the owner can remove an admin." };
  }

  await prisma.groupMember.delete({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    select: { id: true },
  });

  refreshGroup(groupId);

  return {
    ok: true,
    message: `Removed @${target.user.username ?? "that member"}.`,
  };
}

/**
 * Leaves a group.
 *
 * When the owner leaves, ownership moves to the longest-standing remaining member
 * rather than the group being left without one — the same reasoning as meeting
 * host succession. If nobody is left, the group is deleted, because an empty group
 * is unreachable and would sit in the database forever.
 */
export async function leaveGroup(
  groupId: string,
): Promise<GroupActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  if (!isValidId(groupId)) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  const myRole = await groupRoleFor(groupId, me.id);

  if (myRole === null) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  const throttled = throttle("groupManage", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.groupMember.delete({
        where: { groupId_userId: { groupId, userId: me.id } },
        select: { id: true },
      });

      if (myRole !== GroupRole.OWNER) {
        return;
      }

      const successor = await tx.groupMember.findFirst({
        where: { groupId },
        // Longest-standing first, and an existing admin ahead of a plain member:
        // somebody already trusted with the roster is the natural heir.
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
        select: { userId: true },
      });

      if (successor === null) {
        // Nobody left to hand it to. Cascades clear the messages with it.
        await tx.group.delete({ where: { id: groupId }, select: { id: true } });
        return;
      }

      await tx.group.update({
        where: { id: groupId },
        data: { ownerId: successor.userId },
        select: { id: true },
      });

      await tx.groupMember.update({
        where: {
          groupId_userId: { groupId, userId: successor.userId },
        },
        data: { role: GroupRole.OWNER },
        select: { id: true },
      });
    });
  } catch (error: unknown) {
    console.error("leave_group_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });

    return { ok: false, message: "We could not leave that group." };
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/groups");

  return { ok: true, message: "You left the group." };
}

/** Renames a group or changes its description. Owner and admins only. */
export async function updateGroup(
  groupId: string,
  rawName: unknown,
  rawDescription: unknown,
): Promise<GroupActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  if (!isValidId(groupId)) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  const myRole = await groupRoleFor(groupId, me.id);

  if (myRole === null) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  if (!canManageMembers(myRole)) {
    return { ok: false, message: NOT_ALLOWED };
  }

  const name = validateGroupName(rawName);

  if (!name.ok) {
    return { ok: false, message: name.message };
  }

  const description = validateGroupDescription(rawDescription);

  if (!description.ok) {
    return { ok: false, message: description.message };
  }

  const throttled = throttle("groupManage", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  await prisma.group.update({
    where: { id: groupId },
    data: { name: name.name, description: description.description },
    select: { id: true },
  });

  refreshGroup(groupId);

  return { ok: true, message: "Group updated." };
}

/** Promotes or demotes a member. Owner only. */
export async function setGroupRole(
  groupId: string,
  targetUserId: string,
  makeAdmin: boolean,
): Promise<GroupActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  if (!isValidId(groupId) || !isValidId(targetUserId)) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  const myRole = await groupRoleFor(groupId, me.id);

  if (myRole === null) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  // Deliberately owner-only, not admin. Letting admins appoint admins makes the
  // role self-propagating and the owner loses control of who manages the roster —
  // the same reasoning as `setCoHost` being host-only.
  if (myRole !== GroupRole.OWNER) {
    return { ok: false, message: "Only the owner can change roles." };
  }

  if (targetUserId === me.id) {
    return { ok: false, message: "You are already the owner." };
  }

  const throttled = throttle("groupManage", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  const target = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    select: { role: true, user: { select: { username: true } } },
  });

  if (target === null) {
    return { ok: false, message: "They are not in this group." };
  }

  if (target.role === GroupRole.OWNER) {
    return { ok: false, message: "They already own this group." };
  }

  await prisma.groupMember.update({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    data: { role: makeAdmin ? GroupRole.ADMIN : GroupRole.MEMBER },
    select: { id: true },
  });

  refreshGroup(groupId);

  const handle = `@${target.user.username ?? "that member"}`;

  return {
    ok: true,
    message: makeAdmin ? `${handle} is now an admin.` : `${handle} is now a member.`,
  };
}

/**
 * Deletes a group and everything in it. Owner only.
 *
 * Messages and memberships go with it by cascade. Past *meetings* do not: their
 * `groupId` is set to null, so attendance history survives losing the group it
 * happened in.
 */
export async function deleteGroup(
  groupId: string,
): Promise<GroupActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  if (!isValidId(groupId)) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  const myRole = await groupRoleFor(groupId, me.id);

  if (myRole === null) {
    return { ok: false, message: NO_SUCH_GROUP };
  }

  if (myRole !== GroupRole.OWNER) {
    return { ok: false, message: "Only the owner can delete this group." };
  }

  const throttled = throttle("groupManage", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  try {
    await prisma.group.delete({ where: { id: groupId }, select: { id: true } });
  } catch (error: unknown) {
    // Already gone is the outcome the caller wanted, so it is reported as success
    // rather than an error on a double-click.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      revalidatePath("/dashboard");
  revalidatePath("/dashboard/groups");
      return { ok: true, message: "Group deleted." };
    }

    console.error("delete_group_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });

    return { ok: false, message: "We could not delete that group." };
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/groups");

  return { ok: true, message: "Group deleted." };
}

export interface AddableConnection extends GroupPerson {
  /** True when they are already in the group, so the picker can show it. */
  alreadyMember: boolean;
}

export interface AddableConnectionsResult {
  ok: boolean;
  message: string;
  connections: AddableConnection[];
  /** Seats left, so the picker can stop the user overshooting. */
  capacityLeft: number;
}

/**
 * Accepted connections the caller could put in a group.
 *
 * `groupId` is optional: omitted while creating a group, supplied when adding to
 * one. When supplied, membership is required before anything is returned, so this
 * cannot be used to read the roster of a group you are not in.
 */
export async function listAddableConnections(
  groupId?: string,
): Promise<AddableConnectionsResult> {
  const empty = { connections: [], capacityLeft: 0 };

  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, ...empty };
  }

  let memberIds = new Set<string>();
  let seatsLeft = MAX_GROUP_MEMBERS - 1;

  if (groupId !== undefined) {
    if (!isValidId(groupId)) {
      return { ok: false, message: NO_SUCH_GROUP, ...empty };
    }

    const myRole = await groupRoleFor(groupId, me.id);

    if (myRole === null) {
      return { ok: false, message: NO_SUCH_GROUP, ...empty };
    }

    if (!canManageMembers(myRole)) {
      return { ok: false, message: NOT_ALLOWED, ...empty };
    }

    const members = await prisma.groupMember.findMany({
      where: { groupId },
      select: { userId: true },
    });

    memberIds = new Set(members.map((member) => member.userId));
    seatsLeft = capacityLeft(members.length);
  }

  const rows = await prisma.connectionRequest.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ senderId: me.id }, { receiverId: me.id }],
    },
    select: {
      senderId: true,
      sender: { select: { id: true, username: true, name: true } },
      receiver: { select: { id: true, username: true, name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const connections: AddableConnection[] = [];
  const seen = new Set<string>();

  rows.forEach((row) => {
    const other = row.senderId === me.id ? row.receiver : row.sender;

    // No handle means no reachable profile, so there is nothing to show.
    if (other.username === null || other.id === me.id || seen.has(other.id)) {
      return;
    }

    seen.add(other.id);
    connections.push({
      id: other.id,
      username: other.username,
      name: other.name,
      alreadyMember: memberIds.has(other.id),
    });
  });

  connections.sort((first, second) =>
    (first.name ?? first.username).localeCompare(
      second.name ?? second.username,
    ),
  );

  return {
    ok: true,
    message:
      connections.length === 0
        ? "Connect with someone first, then you can put them in a group."
        : "",
    connections,
    capacityLeft: seatsLeft,
  };
}
