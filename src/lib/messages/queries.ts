import "server-only";

/**
 * Read side of direct messaging.
 *
 * Every function here is scoped to a viewer id. Callers must still pass the
 * connection gate (`areUsersConnected`) before exposing a thread — these queries
 * enforce participation, not permission.
 */

import {
  MAX_SEARCH_CHARS,
  MAX_SEARCH_HITS,
  MIN_SEARCH_CHARS,
} from "@/lib/messages/search-limits";
import { prisma } from "@/lib/prisma";

/**
 * Compact stand-in for a quoted message.
 *
 * Deliberately not the full row: a reply only needs enough to render a preview,
 * and a soft-deleted original must not leak its body here either.
 */
export interface QuotedMessagePreview {
  id: string;
  /** Truncated for display. Null when the quoted message was deleted. */
  body: string | null;
  deleted: boolean;
  /** True when the viewer wrote the quoted message. */
  outgoing: boolean;
}

export interface ThreadMessage {
  id: string;
  /** Empty string when `deleted` is true — the real body is never served. */
  body: string;
  createdAt: Date;
  /** True when the signed-in viewer wrote it. */
  outgoing: boolean;
  /** Non-null once the author has edited, which drives the "(edited)" tag. */
  editedAt: Date | null;
  deleted: boolean;
  replyTo: QuotedMessagePreview | null;
}

export interface ConversationSummary {
  person: {
    id: string;
    username: string;
    name: string | null;
  };
  lastMessage: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
}

export interface MessageSearchHit {
  id: string;
  /** Window of the body around the match, ellipsised at the edges. */
  snippet: string;
  createdAt: Date;
  outgoing: boolean;
  person: {
    id: string;
    username: string;
    name: string | null;
  };
}

const MAX_THREAD_MESSAGES = 200;
const QUOTED_PREVIEW_CHARS = 120;

/** Placeholder shown wherever a soft-deleted message would otherwise appear. */
export const DELETED_MESSAGE_PLACEHOLDER = "This message was deleted";

// Re-exported so existing server-side importers keep working unchanged.
export { MIN_SEARCH_CHARS } from "@/lib/messages/search-limits";

const SNIPPET_LEAD_CHARS = 40;
const SNIPPET_TRAIL_CHARS = 100;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}

/** Messages exchanged between two people, oldest first. */
export async function listThread(
  viewerId: string,
  otherId: string,
): Promise<ThreadMessage[]> {
  const rows = await prisma.directMessage.findMany({
    where: {
      OR: [
        { senderId: viewerId, receiverId: otherId },
        { senderId: otherId, receiverId: viewerId },
      ],
    },
    select: {
      id: true,
      body: true,
      createdAt: true,
      senderId: true,
      editedAt: true,
      deletedAt: true,
      replyTo: {
        select: { id: true, body: true, senderId: true, deletedAt: true },
      },
    },
    // Newest-first *then* reversed, which is not the same as ordering ascending.
    // `orderBy: asc` with a `take` keeps the OLDEST N rows, so once a thread
    // passed 200 messages every new message fell outside the window and the
    // conversation appeared frozen. The window has to be anchored to the recent
    // end and flipped afterwards.
    orderBy: { createdAt: "desc" },
    take: MAX_THREAD_MESSAGES,
  });

  // Restores the oldest-first order the caller and the UI expect.
  rows.reverse();

  return rows.map((row) => {
    const deleted = row.deletedAt !== null;
    const quoted = row.replyTo;

    return {
      id: row.id,
      // Soft-deleted rows survive so replies keep their context, but the body
      // stops leaving the server entirely.
      body: deleted ? "" : row.body,
      createdAt: row.createdAt,
      outgoing: row.senderId === viewerId,
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
              outgoing: quoted.senderId === viewerId,
            },
    };
  });
}

/**
 * Centres a snippet on the first match so the hit is visible without opening
 * the thread. The database matched case-insensitively via collation; locating
 * the offset again in JavaScript is an approximation, and a miss just falls back
 * to the head of the body.
 */
function buildSnippet(body: string, needle: string): string {
  const index = body.toLowerCase().indexOf(needle.toLowerCase());

  if (index === -1) {
    return truncate(body, SNIPPET_LEAD_CHARS + SNIPPET_TRAIL_CHARS);
  }

  const start = Math.max(0, index - SNIPPET_LEAD_CHARS);
  const end = Math.min(
    body.length,
    index + needle.length + SNIPPET_TRAIL_CHARS,
  );

  const core = body.slice(start, end).trim();

  return `${start > 0 ? "…" : ""}${core}${end < body.length ? "…" : ""}`;
}

/**
 * Keyword search across the viewer's own conversations.
 *
 * The participation clause is ANDed with the keyword rather than ORed, so no
 * combination of input can surface a row the viewer is not named on. Deleted
 * messages are excluded outright.
 */
export async function searchMessages(
  viewerId: string,
  rawQuery: string,
): Promise<MessageSearchHit[]> {
  const query = rawQuery.trim().slice(0, MAX_SEARCH_CHARS);

  if (query.length < MIN_SEARCH_CHARS) {
    return [];
  }

  const rows = await prisma.directMessage.findMany({
    where: {
      AND: [
        // The gate: viewer must be one of the two people on the row.
        { OR: [{ senderId: viewerId }, { receiverId: viewerId }] },
        { deletedAt: null },
        { body: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      body: true,
      createdAt: true,
      senderId: true,
      sender: { select: { id: true, username: true, name: true } },
      receiver: { select: { id: true, username: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_SEARCH_HITS,
  });

  const hits: MessageSearchHit[] = [];

  rows.forEach((row) => {
    const outgoing = row.senderId === viewerId;
    const person = outgoing ? row.receiver : row.sender;

    // `username` is nullable in the schema, and a thread with no handle has no
    // reachable URL, so it cannot be offered as a result.
    if (person.username === null) {
      return;
    }

    hits.push({
      id: row.id,
      snippet: buildSnippet(row.body, query),
      createdAt: row.createdAt,
      outgoing,
      person: {
        id: person.id,
        username: person.username,
        name: person.name,
      },
    });
  });

  return hits;
}

export async function countUnreadMessages(viewerId: string): Promise<number> {
  return prisma.directMessage.count({
    where: { receiverId: viewerId, readAt: null },
  });
}

export async function countUnreadFrom(
  viewerId: string,
  otherId: string,
): Promise<number> {
  return prisma.directMessage.count({
    where: { receiverId: viewerId, senderId: otherId, readAt: null },
  });
}

/**
 * Builds one row per contact, newest activity first.
 *
 * Contacts are the source of truth rather than the message table, so a brand-new
 * connection still shows up with an empty thread ready to start.
 */
export async function listConversations(
  viewerId: string,
  contacts: { id: string; username: string; name: string | null }[],
): Promise<ConversationSummary[]> {
  if (contacts.length === 0) {
    return [];
  }

  const contactIds = contacts.map((contact) => contact.id);

  const [recent, unreadGroups] = await Promise.all([
    prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: viewerId, receiverId: { in: contactIds } },
          { receiverId: viewerId, senderId: { in: contactIds } },
        ],
      },
      select: {
        body: true,
        createdAt: true,
        senderId: true,
        receiverId: true,
        deletedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 400,
    }),
    prisma.directMessage.groupBy({
      by: ["senderId"],
      where: {
        receiverId: viewerId,
        readAt: null,
        senderId: { in: contactIds },
      },
      _count: { _all: true },
    }),
  ]);

  const unreadByPerson = new Map<string, number>(
    unreadGroups.map((group) => [group.senderId, group._count._all]),
  );

  // `recent` is newest-first, so the first hit per person is their latest message.
  const latestByPerson = new Map<
    string,
    { body: string; createdAt: Date }
  >();

  for (const message of recent) {
    const otherId =
      message.senderId === viewerId ? message.receiverId : message.senderId;

    if (!latestByPerson.has(otherId)) {
      latestByPerson.set(otherId, {
        // A soft-deleted last message still dates the conversation, but its body
        // is replaced rather than served.
        body:
          message.deletedAt === null
            ? message.body
            : DELETED_MESSAGE_PLACEHOLDER,
        createdAt: message.createdAt,
      });
    }
  }

  const summaries: ConversationSummary[] = contacts.map((contact) => {
    const latest = latestByPerson.get(contact.id);

    return {
      person: contact,
      lastMessage: latest?.body ?? null,
      lastMessageAt: latest?.createdAt ?? null,
      unreadCount: unreadByPerson.get(contact.id) ?? 0,
    };
  });

  return summaries.sort((first, second) => {
    const firstTime = first.lastMessageAt?.getTime() ?? 0;
    const secondTime = second.lastMessageAt?.getTime() ?? 0;
    return secondTime - firstTime;
  });
}
