"use server";

/**
 * Host-only poll and Q&A moderation.
 *
 * These three actions exist because the rest of the feature runs peer-to-peer over
 * the LiveKit data channel, and peer-to-peer means the browser decides. Hiding a
 * button stops an honest participant; it does nothing about a console. Launching a
 * poll, closing one, and marking a question answered are the decisions that change
 * what the room believes, so they are taken away from the browser entirely:
 *
 * 1. the moderator's client calls one of these actions;
 * 2. `requireMeetingHost` proves, from the meeting row, that the caller moderates
 *    this meeting;
 * 3. the *server* publishes the resulting message into the room.
 *
 * Step 3 is what makes it stick. A packet published through the LiveKit server API
 * carries no participant identity, and a browser cannot produce one that does not.
 * Clients honour moderation messages only when they arrive that way, so a regular
 * participant replaying the same payload from their console is stamped with their
 * own identity and discarded by every recipient.
 *
 * Votes, questions and upvotes deliberately do *not* come through here. They are
 * open to everyone, the actor is the identity the media server stamps on the
 * packet, and routing them through the server would add a round trip to the two
 * interactions that most want to feel instant.
 */

import { NOT_HOST, requireMeetingHost } from "@/lib/meetings/host-guard";
import { broadcastRoomData } from "@/lib/meetings/livekit-admin";
import {
  POLLS_TOPIC,
  normalizePollDraft,
  type Poll,
  type PollsMessage,
} from "@/lib/meetings/poll-state";
import { consumeRateLimit, describeRetryAfter } from "@/lib/rate-limit";

export interface PollsActionResult {
  ok: boolean;
  message: string;
}

/**
 * Ids are generated in the browser, so they are treated as untrusted input even
 * though they are only ever used as opaque match keys. Bounded in length and
 * charset so a crafted id cannot bloat a packet that fans out to the whole room.
 */
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * Publishes a moderation message into the room.
 *
 * Failure is reported rather than swallowed: if the broadcast does not land, no
 * client saw the change, and telling the moderator it worked would leave them
 * looking at a poll they believe is closed.
 */
async function publish(
  meetingCode: string,
  message: PollsMessage,
): Promise<PollsActionResult> {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const outcome = await broadcastRoomData(meetingCode, POLLS_TOPIC, payload);

  return outcome.ok
    ? { ok: true, message: "" }
    : { ok: false, message: outcome.message };
}

/**
 * Resolves the caller's moderator identity, or a refusal.
 *
 * Bundles the three checks every action here needs: the role gate, a usable
 * LiveKit identity to attribute the action to, and the rate limit.
 */
async function requireModeratorIdentity(
  meetingCode: string,
): Promise<{ ok: true; identity: string } | { ok: false; message: string }> {
  const host = await requireMeetingHost(meetingCode, "moderator");

  if (host === null) {
    return { ok: false, message: NOT_HOST };
  }

  // Identity is the Clerk subject, which is what the token route publishes and
  // what every client compares against. Without one there is nothing to attribute
  // the decision to, so recipients would reject it anyway.
  if (host.actorIdentity === null) {
    return { ok: false, message: NOT_HOST };
  }

  const attempt = consumeRateLimit(
    "pollModeration",
    `${host.meetingId}:${host.localUserId}`,
  );

  if (!attempt.allowed) {
    return {
      ok: false,
      message: `Too many changes at once. Try again in ${describeRetryAfter(attempt.retryAfterSeconds)}.`,
    };
  }

  return { ok: true, identity: host.actorIdentity };
}

export interface PollDraftInput {
  id: string;
  question: string;
  options: string[];
}

/**
 * Releases a drafted poll to the room.
 *
 * The draft never left the host's browser, so this is the moment the poll becomes
 * real for everyone else — and the first moment its text is checked by anything
 * other than the client that typed it. `normalizePollDraft` runs again here for
 * exactly that reason: the client-side call was a convenience for showing an error
 * in the composer, not a guarantee.
 */
export async function launchPoll(
  meetingCode: string,
  draft: PollDraftInput,
): Promise<PollsActionResult> {
  if (!validId(draft.id)) {
    return { ok: false, message: "That poll is no longer available." };
  }

  const moderator = await requireModeratorIdentity(meetingCode);

  if (!moderator.ok) {
    return { ok: false, message: moderator.message };
  }

  const normalized = normalizePollDraft(draft.question, draft.options);

  if (!normalized.ok) {
    return { ok: false, message: normalized.message };
  }

  // Built here rather than accepted from the client: status, votes, timestamp and
  // authorship are all the server's to decide. A client that sent
  // `status: "closed"` with pre-filled votes would be describing a poll that had
  // already happened.
  const poll: Poll = {
    id: draft.id,
    question: normalized.question,
    options: normalized.options,
    votes: {},
    status: "live",
    createdAt: Date.now(),
    createdBy: moderator.identity,
  };

  const sent = await publish(meetingCode, {
    kind: "poll_launched",
    poll,
    by: moderator.identity,
  });

  return sent.ok
    ? { ok: true, message: "Poll is live." }
    : { ok: false, message: sent.message };
}

/** Ends voting. Results stay visible to everyone, read-only. */
export async function closePoll(
  meetingCode: string,
  pollId: string,
): Promise<PollsActionResult> {
  if (!validId(pollId)) {
    return { ok: false, message: "That poll is no longer available." };
  }

  const moderator = await requireModeratorIdentity(meetingCode);

  if (!moderator.ok) {
    return { ok: false, message: moderator.message };
  }

  const sent = await publish(meetingCode, {
    kind: "poll_closed",
    pollId,
    by: moderator.identity,
  });

  return sent.ok
    ? { ok: true, message: "Poll closed." }
    : { ok: false, message: sent.message };
}

/** Marks a question as addressed live. */
export async function markQuestionAnswered(
  meetingCode: string,
  questionId: string,
): Promise<PollsActionResult> {
  if (!validId(questionId)) {
    return { ok: false, message: "That question is no longer available." };
  }

  const moderator = await requireModeratorIdentity(meetingCode);

  if (!moderator.ok) {
    return { ok: false, message: moderator.message };
  }

  const sent = await publish(meetingCode, {
    kind: "question_answered",
    questionId,
    by: moderator.identity,
  });

  return sent.ok
    ? { ok: true, message: "Marked answered." }
    : { ok: false, message: sent.message };
}
