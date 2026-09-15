"use server";

/**
 * Server Actions for the connection system.
 *
 * Every action re-establishes identity from the Clerk session. Nothing trusts a
 * client-supplied user id, and the security gate is enforced here rather than in
 * the UI.
 */

import { ConnectionStatus, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import {
  areUsersConnected,
  getConnectionState,
} from "@/lib/connections/queries";
import { sendConnectionRequestEmail } from "@/lib/email/connection-request-email";
import { authorizeMeetingJoin } from "@/lib/meetings/authorization";
import {
  generateMeetingCode,
  generateRoomPasscode,
} from "@/lib/meetings/meeting-code";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";
import { ensureCurrentUser, normalizeUsername } from "@/lib/users/current-user";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * How long a direct call stays reusable.
 *
 * Without this both people pressing "Call" create two rooms and each sits alone
 * in their own. Reusing the recent one means the second press joins the first.
 */
const CALL_REUSE_WINDOW_MS = 30 * 60 * 1000;

function rateLimited(
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

export interface StartCallResult extends ActionResult {
  meetingCode: string | null;
}

const SIGN_IN_REQUIRED = "Your session has ended. Sign in again to continue.";
const MEETING_CODE_ATTEMPTS = 5;

function refreshViews(): void {
  revalidatePath("/dashboard");
}

/** Sends, or re-sends, a connection request to the holder of `rawUsername`. */
export async function sendConnectionRequest(
  rawUsername: string,
): Promise<ActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const username = normalizeUsername(rawUsername);

  if (username.length === 0) {
    return { ok: false, message: "Enter a username to send a request." };
  }

  if (username === me.username.toLowerCase()) {
    return { ok: false, message: "You cannot send a request to yourself." };
  }

  const receiver = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, name: true, email: true },
  });

  if (receiver === null) {
    return {
      ok: false,
      message: `No account found for @${username}. Check the spelling and try again.`,
    };
  }

  if (receiver.id === me.id) {
    return { ok: false, message: "You cannot send a request to yourself." };
  }

  const state = await getConnectionState(me.id, receiver.id);

  switch (state.kind) {
    case "accepted":
      return {
        ok: false,
        message: `You are already connected with @${username}.`,
      };
    case "outgoing_pending":
      return {
        ok: false,
        message: `You already have a pending request to @${username}.`,
      };
    case "incoming_pending":
      return {
        ok: false,
        message: `@${username} already sent you a request. Open your notifications to accept it.`,
      };
    default:
      break;
  }

  const throttled = rateLimited("connectionRequest", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  try {
    // The uniqueness constraint covers the ordered pair, so A->B and B->A are
    // two different rows. Re-checking for a reverse row inside the transaction
    // closes the window where both people send simultaneously and each ends up
    // holding a pending request against the other.
    const created = await prisma.$transaction(async (tx) => {
      const reverse = await tx.connectionRequest.findUnique({
        where: {
          senderId_receiverId: { senderId: receiver.id, receiverId: me.id },
        },
        select: { status: true },
      });

      if (reverse !== null && reverse.status !== ConnectionStatus.REJECTED) {
        return false;
      }

      // A prior rejection is reused rather than duplicated: re-sending means
      // moving that same row back to PENDING.
      await tx.connectionRequest.upsert({
        where: {
          senderId_receiverId: { senderId: me.id, receiverId: receiver.id },
        },
        create: {
          senderId: me.id,
          receiverId: receiver.id,
          status: ConnectionStatus.PENDING,
        },
        update: { status: ConnectionStatus.PENDING },
      });

      return true;
    });

    if (!created) {
      return {
        ok: false,
        message: `@${username} already sent you a request. Open your notifications to accept it.`,
      };
    }
  } catch (error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        ok: false,
        message: `A request between you and @${username} already exists.`,
      };
    }
    console.error("connection_request_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return {
      ok: false,
      message: "We could not send that request. Please try again.",
    };
  }

  // Email is best effort; the in-app notification already exists at this point.
  if (receiver.email !== null) {
    const outcome = await sendConnectionRequestEmail({
      to: receiver.email,
      senderName: me.name ?? me.username,
      senderUsername: me.username,
      receiverName: receiver.name,
    });

    if (!outcome.delivered && outcome.reason === "not_configured") {
      console.warn(
        "connection_request_email_skipped: RESEND_API_KEY / RESEND_FROM_EMAIL not set",
      );
    }
  }

  refreshViews();

  return {
    ok: true,
    message: `Request sent to @${username}.`,
  };
}

/** Accepts or declines an incoming request. Only the receiver may respond. */
export async function respondToConnectionRequest(
  requestId: string,
  decision: "accept" | "decline",
): Promise<ActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const throttled = rateLimited("connectionResponse", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  const request = await prisma.connectionRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      receiverId: true,
      status: true,
      sender: { select: { username: true } },
    },
  });

  if (request === null) {
    return { ok: false, message: "That request no longer exists." };
  }

  // Authorization: only the receiver decides, never the sender.
  if (request.receiverId !== me.id) {
    return {
      ok: false,
      message: "You are not the recipient of that request.",
    };
  }

  if (request.status !== ConnectionStatus.PENDING) {
    return { ok: false, message: "That request has already been answered." };
  }

  const handle = request.sender.username ?? "that user";

  await prisma.connectionRequest.update({
    where: { id: request.id },
    data: {
      status:
        decision === "accept"
          ? ConnectionStatus.ACCEPTED
          : ConnectionStatus.REJECTED,
    },
  });

  refreshViews();

  return {
    ok: true,
    message:
      decision === "accept"
        ? `You are now connected with @${handle}.`
        : `Request from @${handle} declined.`,
  };
}

/**
 * The security gate for calling. Creates a 1-on-1 meeting only when an ACCEPTED
 * connection exists, and enrolls both people so it appears on both dashboards.
 */
export async function startDirectCall(
  contactUserId: string,
): Promise<StartCallResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, meetingCode: null };
  }

  const contact = await prisma.user.findUnique({
    where: { id: contactUserId },
    select: { id: true, username: true, name: true },
  });

  if (contact === null) {
    return { ok: false, message: "That person no longer exists.", meetingCode: null };
  }

  if (contact.id === me.id) {
    return {
      ok: false,
      message: "You cannot start a call with yourself.",
      meetingCode: null,
    };
  }

  const connected = await areUsersConnected(me.id, contact.id);

  if (!connected) {
    const handle = contact.username ?? "this user";
    return {
      ok: false,
      message: `You must connect with @${handle} and have your request accepted before calling or chatting.`,
      meetingCode: null,
    };
  }

  const throttled = rateLimited("startCall", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled, meetingCode: null };
  }

  // Reuse a recent call between exactly these two people instead of opening a
  // second room. Without this, both pressing "Call" lands them in separate
  // meetings, each waiting for someone who is elsewhere.
  const existing = await prisma.meeting.findFirst({
    where: {
      isPrivate: true,
      createdAt: { gte: new Date(Date.now() - CALL_REUSE_WINDOW_MS) },
      OR: [
        { hostId: me.id, participants: { some: { userId: contact.id } } },
        { hostId: contact.id, participants: { some: { userId: me.id } } },
      ],
    },
    select: { meetingCode: true },
    orderBy: { createdAt: "desc" },
  });

  if (existing !== null) {
    return {
      ok: true,
      message: `Joining your call with @${contact.username ?? "contact"}.`,
      meetingCode: existing.meetingCode,
    };
  }

  const title = `Call with ${contact.name ?? `@${contact.username ?? "contact"}`}`;

  for (let attempt = 0; attempt < MEETING_CODE_ATTEMPTS; attempt += 1) {
    const meetingCode = generateMeetingCode();

    try {
      await prisma.meeting.create({
        data: {
          title,
          meetingCode,
          hostId: me.id,
          // Private: only these two may mint a token, so a leaked code is not
          // enough for a third party to listen in.
          isPrivate: true,
          // The room PIN is what lets this 1-on-1 be widened later. A guest with
          // the link still cannot enter a private room without it.
          passcode: generateRoomPasscode(),
          participants: {
            create: [{ userId: me.id }, { userId: contact.id }],
          },
        },
        select: { meetingCode: true },
      });

      refreshViews();

      return {
        ok: true,
        message: `Call ready with @${contact.username ?? "contact"}.`,
        meetingCode,
      };
    } catch (error: unknown) {
      const isCodeCollision =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        JSON.stringify(error.meta?.target ?? "").includes("meetingCode");

      if (isCodeCollision) {
        continue;
      }

      console.error("start_direct_call_failed", {
        message: error instanceof Error ? error.message : "unknown error",
      });
      return {
        ok: false,
        message: "We could not start that call. Please try again.",
        meetingCode: null,
      };
    }
  }

  return {
    ok: false,
    message: "We could not start that call. Please try again.",
    meetingCode: null,
  };
}

export interface InviteableFriend {
  id: string;
  username: string;
  name: string | null;
}

export interface InviteableFriendsResult {
  ok: boolean;
  message: string;
  friends: InviteableFriend[];
  /** Null unless the caller is entitled to see it. */
  passcode: string | null;
}

/**
 * Accepted connections the caller can pull into a meeting they are already in.
 *
 * Membership of the meeting is required before anything is returned, so this
 * cannot be used as a contact-list oracle against a room you are not in. People
 * already enrolled are filtered out, because inviting them again would ring
 * someone who is sitting in the call.
 *
 * The room passcode rides along in the same response: the modal needs it for its
 * share tab, and fetching it separately would mean a second authorization check
 * for the same question.
 */
export async function getInviteableFriends(
  meetingCode: string,
): Promise<InviteableFriendsResult> {
  const empty = { friends: [], passcode: null };

  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED, ...empty };
  }

  const decision = await authorizeMeetingJoin(meetingCode, me.id);

  // Only an enrolled member may invite. `allowed` alone is not enough: an open
  // meeting admits anyone holding the link, and a passer-by must not be able to
  // enumerate the room or read its passcode.
  if (!decision.allowed || !decision.enrolled) {
    return {
      ok: false,
      message: "You must be in this meeting to invite people.",
      ...empty,
    };
  }

  const [meeting, connections] = await Promise.all([
    prisma.meeting.findUnique({
      where: { id: decision.meeting.id },
      select: {
        passcode: true,
        participants: { select: { userId: true } },
      },
    }),
    prisma.connectionRequest.findMany({
      where: {
        status: ConnectionStatus.ACCEPTED,
        OR: [{ senderId: me.id }, { receiverId: me.id }],
      },
      select: {
        sender: { select: { id: true, username: true, name: true } },
        receiver: { select: { id: true, username: true, name: true } },
      },
    }),
  ]);

  if (meeting === null) {
    return { ok: false, message: "That meeting no longer exists.", ...empty };
  }

  const alreadyIn = new Set(
    meeting.participants.map((participant) => participant.userId),
  );

  const friends: InviteableFriend[] = [];
  const seen = new Set<string>();

  connections.forEach((row) => {
    // A connection row names two people; the friend is whichever one is not me.
    const other = row.sender.id === me.id ? row.receiver : row.sender;

    // No username means no reachable profile, so there is nothing to show.
    if (other.username === null) {
      return;
    }

    if (other.id === me.id || alreadyIn.has(other.id) || seen.has(other.id)) {
      return;
    }

    seen.add(other.id);
    friends.push({
      id: other.id,
      username: other.username,
      name: other.name,
    });
  });

  friends.sort((first, second) =>
    (first.name ?? first.username).localeCompare(
      second.name ?? second.username,
    ),
  );

  return {
    ok: true,
    message: friends.length === 0 ? "No one left to invite." : "",
    friends,
    passcode: meeting.passcode,
  };
}

/**
 * Invites an accepted connection into a meeting the caller is already in.
 *
 * Enrolls them as a `Participant` immediately, which is deliberate: it is what
 * lets them join without a passcode prompt, and what makes the meeting appear in
 * their dashboard history. The `CallInvite` row is separate and drives the
 * ringing banner.
 *
 * Both writes go in one transaction so a rung invite can never point at a
 * meeting the invitee is not enrolled on — that combination would ring them and
 * then refuse them at the door.
 */
export async function inviteFriendToCall(
  meetingCode: string,
  friendUserId: string,
): Promise<ActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const throttled = rateLimited("startCall", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  if (friendUserId === me.id) {
    return { ok: false, message: "You are already in this meeting." };
  }

  const decision = await authorizeMeetingJoin(meetingCode, me.id);

  if (!decision.allowed || !decision.enrolled) {
    return {
      ok: false,
      message: "You must be in this meeting to invite people.",
    };
  }

  const friend = await prisma.user.findUnique({
    where: { id: friendUserId },
    select: { id: true, username: true },
  });

  if (friend === null) {
    return { ok: false, message: "That person no longer exists." };
  }

  // Re-checked here rather than trusted from the list the client was shown: the
  // connection could have been removed between rendering and clicking.
  const connected = await areUsersConnected(me.id, friend.id);

  if (!connected) {
    return {
      ok: false,
      message: `You must be connected with @${
        friend.username ?? "this user"
      } to invite them.`,
    };
  }

  const handle = friend.username ?? "them";

  try {
    await prisma.$transaction([
      prisma.participant.upsert({
        where: {
          userId_meetingId: {
            userId: friend.id,
            meetingId: decision.meeting.id,
          },
        },
        create: { userId: friend.id, meetingId: decision.meeting.id },
        // Already enrolled is fine — they may have been invited before, or left
        // and are being called back in.
        update: {},
        select: { id: true },
      }),
      prisma.callInvite.upsert({
        where: {
          meetingId_receiverId: {
            meetingId: decision.meeting.id,
            receiverId: friend.id,
          },
        },
        create: {
          meetingId: decision.meeting.id,
          senderId: me.id,
          receiverId: friend.id,
        },
        // Re-inviting re-rings: the timestamp moves into the ringing window and
        // any previous accept/dismiss is cleared so the banner shows again.
        update: {
          senderId: me.id,
          createdAt: new Date(),
          acceptedAt: null,
          dismissedAt: null,
        },
        select: { id: true },
      }),
    ]);
  } catch (error: unknown) {
    console.error("invite_friend_to_call_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });

    return { ok: false, message: "We could not send that invite." };
  }

  refreshViews();

  return { ok: true, message: `Invited @${handle}.` };
}

/**
 * Marks a ringing invite as answered or declined so it stops ringing.
 *
 * Scoped to the receiver: you can only respond to an invite addressed to you.
 * `updateMany` rather than `update` so an already-answered or unknown invite is a
 * silent no-op instead of a thrown error on a fire-and-forget call.
 */
export async function respondToCallInvite(
  meetingCode: string,
  response: "accept" | "dismiss",
): Promise<ActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const now = new Date();

  await prisma.callInvite.updateMany({
    where: {
      receiverId: me.id,
      meeting: { is: { meetingCode } },
      acceptedAt: null,
      dismissedAt: null,
    },
    data:
      response === "accept" ? { acceptedAt: now } : { dismissedAt: now },
  });

  return { ok: true, message: "" };
}

/**
 * Removes a connection in either direction.
 *
 * This is what makes the messaging page's promise true: with no ACCEPTED row
 * left, `areUsersConnected` fails and the gate closes both chat and calling on
 * the next request. Message history is retained but unreachable, so reconnecting
 * later restores the thread rather than losing it.
 */
export async function removeConnection(
  otherUserId: string,
): Promise<ActionResult> {
  const me = await ensureCurrentUser();

  if (me === null) {
    return { ok: false, message: SIGN_IN_REQUIRED };
  }

  const throttled = rateLimited("removeConnection", me.id);

  if (throttled !== null) {
    return { ok: false, message: throttled };
  }

  const other = await prisma.user.findUnique({
    where: { id: otherUserId },
    select: { id: true, username: true },
  });

  if (other === null) {
    return { ok: false, message: "That person no longer exists." };
  }

  if (other.id === me.id) {
    return { ok: false, message: "You cannot remove yourself." };
  }

  // Scoped to rows this user is part of, so nobody can sever someone else's
  // connection by passing an arbitrary id.
  const removed = await prisma.connectionRequest.deleteMany({
    where: {
      OR: [
        { senderId: me.id, receiverId: other.id },
        { senderId: other.id, receiverId: me.id },
      ],
    },
  });

  if (removed.count === 0) {
    return {
      ok: false,
      message: `You are not connected with @${other.username ?? "that user"}.`,
    };
  }

  refreshViews();
  revalidatePath("/messages");

  return {
    ok: true,
    message: `Removed @${other.username ?? "that user"}. Messaging and calling are now closed.`,
  };
}
