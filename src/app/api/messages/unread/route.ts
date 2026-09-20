import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { latestUnreadForClerkUser } from "@/lib/messages/queries";

export const runtime = "nodejs";

/**
 * The newest unread message for the signed-in user.
 *
 * Exists so a direct message can announce itself while the recipient is anywhere
 * in the app. Web push covers the closed-tab case, but it is useless for someone
 * sitting on the dashboard with the tab open: the browser suppresses a push
 * notification for a focused page, so without this a DM arrived silently.
 *
 * Deliberately one indexed query and nothing else. This is polled, so the cost of
 * a tick is the thing being optimised — see `latestUnreadForClerkUser` for why it
 * keys on the Clerk subject rather than resolving the local user first.
 */
export async function GET(): Promise<NextResponse> {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const latest = await latestUnreadForClerkUser(clerkId);

  return NextResponse.json(
    { latest },
    { headers: { "Cache-Control": "no-store" } },
  );
}
