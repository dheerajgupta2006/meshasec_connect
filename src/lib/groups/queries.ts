import "server-only";

/**
 * Read side of groups.
 *
 * Every function is scoped to a viewer id, and membership is the gate. Unlike the
 * direct-message queries — which enforce participation and leave permission to
 * their callers — there is nothing above this layer that could check group
 * membership more cheaply, so `groupRoleFor` is the gate and the reads below use
 * it or filter on it directly.
 */

import { GroupRole } from "@prisma/client";

import { MAX_GROUP_THREAD_MESSAGES } from "@/lib/groups/limits";
import { prisma } from "@/lib/prisma";

export { GroupRole };

/** Placeholder shown wherever a soft-deleted message would otherwise appear. */
export const DELETED_MESSAGE_PLACEHOLDER = "This message was deleted";

const QUOTED_PREVIEW_CHARS = 120;

export interface GroupPerson {
  id: string;
  username: string;
  name: string | null;
}

export interface GroupMemberView extends GroupPerson {
  role: GroupRole;
  joinedAt: Date;
}

export interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  /** The viewer's own role, which decides what controls they are shown. */
  myRole: GroupRole;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  /** Display name of whoever wrote the last message. Null when there is none. */
  lastMessageBy: string | null;
  unreadCount: number;
}

export interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  myRole: GroupRole;
  members: GroupMemberView[];
}

/** Compact stand-in for a quoted message, matching the direct-message shape. */
export interface GroupQuotedPreview {
  id: string;
  /** Truncated for display. Null when the quoted message was deleted. */
  body: string | null;
  deleted: boolean;
  /** Who wrote it, already resolved to something displayable. */
  authorName: string;
}

export interface GroupThreadMessage {
  id: string;
  /** Empty string when `deleted` is true — the real body is never served. */
  body: string;
  createdAt: Date;
  /** True when the viewer wrote it. */
  outgoing: boolean;
  author: GroupPerson;
  editedAt: Date | null;
  deleted: boolean;
  replyTo: GroupQuotedPreview | null;
}

const personSelect = { id: true, username: true, name: true } as const;

function toPerson(row: {
  id: string;
  username: string | null;
  name: string | null;
}): GroupPerson {
  return {
    id: row.id,
    // A row can predate the username column, so surface something stable rather
    // than a blank handle.
    username: row.username ?? row.id.slice(0, 8),
    name: row.name,
  };
}

/** What to call someone in prose. */
export function displayName(person: GroupPerson): string {
  return person.name ?? `@${person.username}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}

/**
 * The membership gate.
 *
 * Returns the viewer's role, or null when they are not a member. Every group
 * action and route starts here, and a null is reported to the caller as
 * "no such group" so a non-member cannot tell an existing group from a fictional
 * one by the error they get.
 */
export async function groupRoleFor(
  groupId: string,
  viewerId: string,
): Promise<GroupRole | null> {
  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: viewerId } },
    select: { role: true },
  });

  return membership?.role ?? null;
}

/** True for the roles allowed to add and remove people. */
export function canManageMembers(role: GroupRole): boolean {
  return role === GroupRole.OWNER || role === GroupRole.ADMIN;
}

/**
 * Unread condition for one membership.
 *
 * Three clauses, and all three matter: newer than the cursor, not written by the
 * viewer (your own message is not news), and not soft-deleted (announcing a
 * message that renders as "This message was deleted" is worse than staying quiet
 * — the same call the direct-message alert makes).
 *
 * A null cursor means the group has never been opened, so everything counts.
 */
function unreadWhere(
  groupId: string,
  viewerId: string,
  lastReadAt: Date | null,
) {
  return {
    groupId,
    senderId: { not: viewerId },
    deletedAt: null,
    ...(lastReadAt === null ? {} : { createdAt: { gt: lastReadAt } }),
  };
}

/**
 * Every group the viewer belongs to, most recently active first.
 *
 * Four queries, and the shape is deliberate. The obvious single-query approach —
 * taking a flat window of the newest N messages across all the viewer's groups
 * and folding it — silently loses the last message for a quiet group whenever a
 * busy one fills the window. Asking for the maximum `createdAt` per group and
 * then fetching exactly those rows costs one extra round trip and is exact
 * regardless of how lopsided the traffic is.
 */
export async function listMyGroups(viewerId: string): Promise<GroupSummary[]> {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: viewerId },
    select: {
      role: true,
      lastReadAt: true,
      group: {
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          _count: { select: { members: true } },
        },
      },
    },
  });

  if (memberships.length === 0) {
    return [];
  }

  const groupIds = memberships.map((membership) => membership.group.id);

  const [latestTimes, unreadCounts] = await Promise.all([
    prisma.groupMessage.groupBy({
      by: ["groupId"],
      where: { groupId: { in: groupIds } },
      _max: { createdAt: true },
    }),
    // One count per group, but a single query: each membership contributes its own
    // cursor clause, which is why this cannot be a plain `groupBy`.
    prisma.groupMessage.groupBy({
      by: ["groupId"],
      where: {
        OR: memberships.map((membership) =>
          unreadWhere(membership.group.id, viewerId, membership.lastReadAt),
        ),
      },
      _count: { _all: true },
    }),
  ]);

  const stamps = latestTimes
    .map((entry) => ({ groupId: entry.groupId, createdAt: entry._max.createdAt }))
    .filter(
      (entry): entry is { groupId: string; createdAt: Date } =>
        entry.createdAt !== null,
    );

  const latest =
    stamps.length === 0
      ? []
      : await prisma.groupMessage.findMany({
          where: {
            OR: stamps.map((stamp) => ({
              groupId: stamp.groupId,
              createdAt: stamp.createdAt,
            })),
          },
          select: {
            groupId: true,
            body: true,
            createdAt: true,
            deletedAt: true,
            sender: { select: personSelect },
          },
        });

  const latestByGroup = new Map<
    string,
    { body: string; createdAt: Date; by: string }
  >();

  // Two messages can share a millisecond, so the first one wins rather than the
  // map being overwritten arbitrarily.
  latest.forEach((message) => {
    if (latestByGroup.has(message.groupId)) {
      return;
    }

    latestByGroup.set(message.groupId, {
      body:
        message.deletedAt === null
          ? message.body
          : DELETED_MESSAGE_PLACEHOLDER,
      createdAt: message.createdAt,
      by: displayName(toPerson(message.sender)),
    });
  });

  const unreadByGroup = new Map<string, number>(
    unreadCounts.map((entry) => [entry.groupId, entry._count._all]),
  );

  const summaries: GroupSummary[] = memberships.map((membership) => {
    const last = latestByGroup.get(membership.group.id);

    return {
      id: membership.group.id,
      name: membership.group.name,
      description: membership.group.description,
      memberCount: membership.group._count.members,
      myRole: membership.role,
      lastMessage: last?.body ?? null,
      lastMessageAt: last?.createdAt ?? null,
      lastMessageBy: last?.by ?? null,
      unreadCount: unreadByGroup.get(membership.group.id) ?? 0,
    };
  });

  // A group with no messages yet sorts by when it was created, so a group made
  // seconds ago does not appear below one that has been silent for a month.
  const createdAtById = new Map(
    memberships.map((membership) => [
      membership.group.id,
      membership.group.createdAt,
    ]),
  );

  return summaries.sort((first, second) => {
    const firstTime = (
      first.lastMessageAt ??
      createdAtById.get(first.id) ??
      new Date(0)
    ).getTime();
    const secondTime = (
      second.lastMessageAt ??
      createdAtById.get(second.id) ??
      new Date(0)
    ).getTime();

    return secondTime - firstTime;
  });
}

/**
 * One group with its roster, or null when the viewer is not a member.
 *
 * Null rather than a distinct "forbidden", so a non-member learns nothing about
 * whether the id exists.
 */
export async function getGroupDetail(
  groupId: string,
  viewerId: string,
): Promise<GroupDetail | null> {
  const group = await prisma.group.findFirst({
    where: { id: groupId, members: { some: { userId: viewerId } } },
    select: {
      id: true,
      name: true,
      description: true,
      ownerId: true,
      members: {
        select: {
          role: true,
          joinedAt: true,
          user: { select: personSelect },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      },
    },
  });

  if (group === null) {
    return null;
  }

  const members: GroupMemberView[] = group.members.map((member) => ({
    ...toPerson(member.user),
    role: member.role,
    joinedAt: member.joinedAt,
  }));

  const mine = members.find((member) => member.id === viewerId);

  if (mine === undefined) {
    // The `some` filter above already proved membership, so this is unreachable
    // unless the row vanished between the two reads of the same query.
    return null;
  }

  return {
    id: group.id,
    name: group.name,
    description: group.description,
    ownerId: group.ownerId,
    myRole: mine.role,
    members,
  };
}

/**
 * The newest window of a group's messages, oldest first.
 *
 * Ordered newest-first with a `take` and then reversed, which is not the same as
 * ordering ascending: `asc` with a `take` keeps the *oldest* N, so a group would
 * appear frozen once it passed the limit.
 */
export async function listGroupThread(
  groupId: string,
  viewerId: string,
): Promise<GroupThreadMessage[]> {
  const rows = await prisma.groupMessage.findMany({
    where: { groupId },
    select: {
      id: true,
      body: true,
      createdAt: true,
      senderId: true,
      editedAt: true,
      deletedAt: true,
      sender: { select: personSelect },
      replyTo: {
        select: {
          id: true,
          body: true,
          deletedAt: true,
          sender: { select: personSelect },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_GROUP_THREAD_MESSAGES,
  });

  rows.reverse();

  return rows.map((row) => {
    const deleted = row.deletedAt !== null;
    const quoted = row.replyTo;

    return {
      id: row.id,
      body: deleted ? "" : row.body,
      createdAt: row.createdAt,
      outgoing: row.senderId === viewerId,
      author: toPerson(row.sender),
      editedAt: deleted ? null : row.editedAt,
      deleted,
      replyTo:
        quoted === null || quoted === undefined
          ? null
          : {
              id: quoted.id,
              body:
                quoted.deletedAt === null
                  ? truncate(quoted.body, QUOTED_PREVIEW_CHARS)
                  : null,
              deleted: quoted.deletedAt !== null,
              authorName: displayName(toPerson(quoted.sender)),
            },
    };
  });
}

/**
 * Total unread across every group the viewer is in, for the nav badge.
 *
 * One query. The per-membership cursors go in as an OR, exactly as in
 * `listMyGroups`, so this cannot drift from the per-group counts shown there.
 */
export async function countUnreadGroupMessages(
  viewerId: string,
): Promise<number> {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: viewerId },
    select: { groupId: true, lastReadAt: true },
  });

  if (memberships.length === 0) {
    return 0;
  }

  return prisma.groupMessage.count({
    where: {
      OR: memberships.map((membership) =>
        unreadWhere(membership.groupId, viewerId, membership.lastReadAt),
      ),
    },
  });
}

/** Member ids for a group, used when a call has to enroll and ring everyone. */
export async function listGroupMemberIds(groupId: string): Promise<string[]> {
  const members = await prisma.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });

  return members.map((member) => member.userId);
}
