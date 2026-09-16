import { auth } from "@clerk/nextjs/server";
import { ShieldAlert } from "lucide-react";
import { unstable_noStore as noStore } from "next/cache";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { GuestGate } from "@/components/meeting/guest-gate";
import { guestApprovalState } from "@/lib/meetings/guest-admission";
import { PreJoinLobby } from "@/components/meeting/pre-join-lobby";
import {
  GUEST_COOKIE_NAME,
  readGuestSessionFor,
} from "@/lib/meetings/guest-session";
import { Button } from "@/components/ui/button";
import { authorizeMeetingJoin } from "@/lib/meetings/authorization";
import { prisma } from "@/lib/prisma";
import { getCurrentLocalUserId } from "@/lib/users/current-user";

interface LobbyPageProps {
  params: {
    code: string;
  };
}

export default async function LobbyPage({ params }: LobbyPageProps) {
  noStore();

  const { userId } = await auth();

  const meeting = await prisma.meeting.findUnique({
    where: {
      meetingCode: params.code,
    },
    select: {
      title: true,
      meetingCode: true,
      startsAt: true,
      hostId: true,
    },
  });

  if (!meeting) {
    notFound();
  }

  // No account: this is an invited guest. They get the passcode exchange, and only
  // once that has issued a session cookie do they see the device lobby. Signing in
  // is offered but not required — that is the whole point of a guest invite.
  if (!userId) {
    const store = await cookies();
    const guest = readGuestSessionFor(
      store.get(GUEST_COOKIE_NAME)?.value,
      meeting.meetingCode,
    );

    if (guest === null) {
      return (
        <GuestGate
          meetingCode={meeting.meetingCode}
          meetingTitle={meeting.title}
        />
      );
    }

    // Verified guest. No passcode prompt and no waiting room — both are keyed to a
    // user id — and the token route re-checks the session and the ban list.
    return (
      <PreJoinLobby
        meetingCode={meeting.meetingCode}
        meetingTitle={meeting.title}
        guestName={guest.displayName}
        // Passing the guest through the host's admit queue when the waiting room
        // is on. Resolved here so the lobby knows before the user presses Join.
        guestWaitingRequired={
          (await guestApprovalState(meeting.meetingCode, guest.guestId)) ===
          "waiting"
        }
        opensAt={
          meeting.startsAt !== null ? meeting.startsAt.toISOString() : null
        }
      />
    );
  }

  // Asked without a passcode, purely to learn whether one is needed. That path
  // returns before consuming any attempt budget, so rendering the lobby cannot
  // burn a guest's allowance.
  const localUserId = await getCurrentLocalUserId();
  const decision =
    localUserId === null
      ? null
      : await authorizeMeetingJoin(meeting.meetingCode, localUserId);

  const passcodeRequired =
    decision !== null &&
    !decision.allowed &&
    (decision.reason === "passcode_required" ||
      decision.reason === "passcode_invalid" ||
      decision.reason === "passcode_throttled");

  if (decision !== null && !decision.allowed && decision.reason === "not_found") {
    notFound();
  }

  // Blocked outright, and no input from the user can change it. Shown as a plain
  // page rather than the device lobby, because there is nothing to set up.
  const blocked =
    decision !== null &&
    !decision.allowed &&
    (decision.reason === "removed" ||
      decision.reason === "locked" ||
      decision.reason === "forbidden")
      ? decision.reason
      : null;

  if (blocked !== null) {
    return <JoinBlocked reason={blocked} />;
  }

  return (
    <PreJoinLobby
      meetingCode={meeting.meetingCode}
      meetingTitle={meeting.title}
      passcodeRequired={passcodeRequired}
      waitingRoomRequired={
        decision !== null &&
        !decision.allowed &&
        decision.reason === "waiting_for_host"
      }
      // The host may open a scheduled room early; everyone else waits here until
      // the start time, which is what makes this a waiting lobby rather than a
      // device check they can walk straight through.
      opensAt={
        meeting.startsAt !== null && localUserId !== meeting.hostId
          ? meeting.startsAt.toISOString()
          : null
      }
    />
  );
}

const BLOCKED_COPY: Record<string, { title: string; detail: string }> = {
  removed: {
    title: "You were removed from this meeting",
    detail:
      "The host removed you, so you cannot rejoin. Ask them to invite you again if that was a mistake.",
  },
  locked: {
    title: "This meeting is locked",
    detail:
      "The host locked the room, so no one new can join. Ask them to unlock it.",
  },
  forbidden: {
    title: "You do not have access to this meeting",
    detail:
      "This is a private meeting. Ask the host to invite you, or to share the room passcode.",
  },
};

function JoinBlocked({ reason }: { reason: string }) {
  const copy = BLOCKED_COPY[reason] ?? BLOCKED_COPY.forbidden;

  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-zinc-950 px-4 text-zinc-100">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/70 p-8 text-center">
        <span
          aria-hidden="true"
          className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-zinc-400"
        >
          <ShieldAlert className="h-5 w-5" />
        </span>
        <h1 className="text-lg font-semibold">{copy?.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          {copy?.detail}
        </p>
        <Button asChild className="mt-6 w-full">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
