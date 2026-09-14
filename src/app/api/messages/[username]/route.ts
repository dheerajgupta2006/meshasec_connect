import { NextResponse } from "next/server";

import { areUsersConnected } from "@/lib/connections/queries";
import { listThread } from "@/lib/messages/queries";
import { prisma } from "@/lib/prisma";
import {
  getCurrentLocalUserId,
  normalizeUsername,
} from "@/lib/users/current-user";

export const runtime = "nodejs";

interface RouteContext {
  params: { username: string };
}

/**
 * Poll endpoint for an open thread.
 *
 * The connection gate is re-checked on every poll, so a revoked connection stops
 * returning history immediately rather than at the next page load.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  // Polled endpoint: use the cheap single-query lookup rather than the
  // provisioning path, and resolve both people in parallel.
  const username = normalizeUsername(decodeURIComponent(params.username));

  const [myId, other] = await Promise.all([
    getCurrentLocalUserId(),
    prisma.user.findUnique({
      where: { username },
      select: { id: true },
    }),
  ]);

  if (myId === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (other === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await areUsersConnected(myId, other.id))) {
    return NextResponse.json({ error: "Not connected" }, { status: 403 });
  }

  const messages = await listThread(myId, other.id);

  return NextResponse.json(
    {
      messages: messages.map((message) => ({
        id: message.id,
        // `listThread` already blanks the body of a soft-deleted row, so the
        // placeholder is the client's to render and the text never ships.
        body: message.body,
        createdAt: message.createdAt.toISOString(),
        outgoing: message.outgoing,
        editedAt: message.editedAt?.toISOString() ?? null,
        deleted: message.deleted,
        replyTo:
          message.replyTo === null
            ? null
            : {
                id: message.replyTo.id,
                body: message.replyTo.body,
                deleted: message.replyTo.deleted,
                outgoing: message.replyTo.outgoing,
              },
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
