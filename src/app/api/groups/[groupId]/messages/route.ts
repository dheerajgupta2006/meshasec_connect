import { NextResponse } from "next/server";

import { groupRoleFor, listGroupThread } from "@/lib/groups/queries";
import { isValidId } from "@/lib/groups/validation";
import { getCurrentLocalUserId } from "@/lib/users/current-user";

export const runtime = "nodejs";

interface RouteContext {
  params: { groupId: string };
}

/**
 * Poll endpoint for an open group thread.
 *
 * Membership is re-checked on every poll, so being removed from a group stops
 * returning its history immediately rather than at the next page load.
 *
 * Uses `getCurrentLocalUserId` rather than `ensureCurrentUser`: this runs every
 * few seconds per open thread, and the provisioning path is far too expensive for
 * something polled.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const groupId = params.groupId;

  if (!isValidId(groupId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const myId = await getCurrentLocalUserId();

  if (myId === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One refusal for "no such group" and "not a member", so group ids cannot be
  // probed from this endpoint either.
  if ((await groupRoleFor(groupId, myId)) === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const messages = await listGroupThread(groupId, myId);

  return NextResponse.json(
    {
      messages: messages.map((message) => ({
        id: message.id,
        // `listGroupThread` already blanks a soft-deleted body, so the placeholder
        // is the client's to render and the text never ships.
        body: message.body,
        createdAt: message.createdAt.toISOString(),
        outgoing: message.outgoing,
        author: message.author,
        editedAt: message.editedAt?.toISOString() ?? null,
        deleted: message.deleted,
        replyTo:
          message.replyTo === null
            ? null
            : {
                id: message.replyTo.id,
                body: message.replyTo.body,
                deleted: message.replyTo.deleted,
                authorName: message.replyTo.authorName,
              },
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
