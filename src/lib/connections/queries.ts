import "server-only";

/**
 * Read side of the connection system.
 *
 * `ConnectionRequest` is unique on the ordered pair `[senderId, receiverId]`, so
 * every "are these two related?" question has to look in both directions.
 */

import { ConnectionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export interface ConnectionPerson {
  id: string;
  username: string;
  name: string | null;
  image: string | null;
}

export interface PendingRequest {
  requestId: string;
  createdAt: Date;
  sender: ConnectionPerson;
}

export type ConnectionState =
  | { kind: "self" }
  | { kind: "none" }
  | { kind: "outgoing_pending"; requestId: string }
  | { kind: "incoming_pending"; requestId: string }
  | { kind: "accepted"; requestId: string }
  | { kind: "outgoing_rejected"; requestId: string }
  | { kind: "incoming_rejected"; requestId: string };

const personSelect = {
  id: true,
  username: true,
  name: true,
  image: true,
} as const;

function toPerson(row: {
  id: string;
  username: string | null;
  name: string | null;
  image: string | null;
}): ConnectionPerson {
  return {
    id: row.id,
    // A row can predate the username column; surface something stable rather
    // than an empty string so the UI never renders a blank handle.
    username: row.username ?? row.id.slice(0, 8),
    name: row.name,
    image: row.image,
  };
}

/** Describes the relationship between two local users, in either direction. */
export async function getConnectionState(
  viewerId: string,
  otherId: string,
): Promise<ConnectionState> {
  if (viewerId === otherId) {
    return { kind: "self" };
  }

  const rows = await prisma.connectionRequest.findMany({
    where: {
      OR: [
        { senderId: viewerId, receiverId: otherId },
        { senderId: otherId, receiverId: viewerId },
      ],
    },
    select: { id: true, senderId: true, status: true },
  });

  const accepted = rows.find((row) => row.status === ConnectionStatus.ACCEPTED);
  if (accepted !== undefined) {
    return { kind: "accepted", requestId: accepted.id };
  }

  const pending = rows.find((row) => row.status === ConnectionStatus.PENDING);
  if (pending !== undefined) {
    return pending.senderId === viewerId
      ? { kind: "outgoing_pending", requestId: pending.id }
      : { kind: "incoming_pending", requestId: pending.id };
  }

  const rejected = rows.find((row) => row.status === ConnectionStatus.REJECTED);
  if (rejected !== undefined) {
    return rejected.senderId === viewerId
      ? { kind: "outgoing_rejected", requestId: rejected.id }
      : { kind: "incoming_rejected", requestId: rejected.id };
  }

  return { kind: "none" };
}

/**
 * The security gate. Meeting and messaging entry points must call this before
 * letting one user reach another.
 */
export async function areUsersConnected(
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> {
  if (firstUserId === secondUserId) {
    return true;
  }

  const accepted = await prisma.connectionRequest.findFirst({
    where: {
      status: ConnectionStatus.ACCEPTED,
      OR: [
        { senderId: firstUserId, receiverId: secondUserId },
        { senderId: secondUserId, receiverId: firstUserId },
      ],
    },
    select: { id: true },
  });

  return accepted !== null;
}

/** Incoming requests awaiting this user's decision. */
export async function listPendingRequests(
  userId: string,
): Promise<PendingRequest[]> {
  const rows = await prisma.connectionRequest.findMany({
    where: { receiverId: userId, status: ConnectionStatus.PENDING },
    select: {
      id: true,
      createdAt: true,
      sender: { select: personSelect },
    },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    requestId: row.id,
    createdAt: row.createdAt,
    sender: toPerson(row.sender),
  }));
}

export async function countPendingRequests(userId: string): Promise<number> {
  return prisma.connectionRequest.count({
    where: { receiverId: userId, status: ConnectionStatus.PENDING },
  });
}

/** Accepted connections in both directions, flattened to the other person. */
export async function listContacts(
  userId: string,
): Promise<ConnectionPerson[]> {
  const rows = await prisma.connectionRequest.findMany({
    where: {
      status: ConnectionStatus.ACCEPTED,
      OR: [{ senderId: userId }, { receiverId: userId }],
    },
    select: {
      senderId: true,
      sender: { select: personSelect },
      receiver: { select: personSelect },
    },
    orderBy: { updatedAt: "desc" },
  });

  return rows.map((row) =>
    toPerson(row.senderId === userId ? row.receiver : row.sender),
  );
}

/** Outgoing requests still awaiting the other person. */
export async function listSentPendingRequests(
  userId: string,
): Promise<ConnectionPerson[]> {
  const rows = await prisma.connectionRequest.findMany({
    where: { senderId: userId, status: ConnectionStatus.PENDING },
    select: { receiver: { select: personSelect } },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => toPerson(row.receiver));
}
