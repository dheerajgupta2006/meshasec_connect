import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { cookies } from "next/headers";

import { MeetingRoom } from "@/components/meeting/meeting-room";
import {
  GUEST_COOKIE_NAME,
  readGuestSessionFor,
} from "@/lib/meetings/guest-session";
import { prisma } from "@/lib/prisma";
import { getCurrentLocalUserId } from "@/lib/users/current-user";

export const metadata: Metadata = {
  title: "Meeting room",
};

interface MeetingRoomPageProps {
  params: {
    code: string;
  };
}

export default async function MeetingRoomPage({
  params,
}: MeetingRoomPageProps) {
  noStore();

  const { userId } = await auth();

  const meeting = await prisma.meeting.findUnique({
    where: {
      meetingCode: params.code,
    },
    select: {
      title: true,
      meetingCode: true,
      hostId: true,
    },
  });

  if (!meeting) {
    notFound();
  }

  // A guest reaching the room directly, e.g. by reloading. Without a session they
  // are sent back through the passcode exchange rather than to a sign-in page.
  if (!userId) {
    const store = await cookies();
    const guest = readGuestSessionFor(
      store.get(GUEST_COOKIE_NAME)?.value,
      meeting.meetingCode,
    );

    if (guest === null) {
      redirect(`/meeting/${encodeURIComponent(meeting.meetingCode)}/lobby`);
    }

    // A guest is never host or co-host, so no role is passed through.
    return (
      <MeetingRoom
        meetingCode={meeting.meetingCode}
        meetingTitle={meeting.title}
        isHost={false}
      />
    );
  }

  // Resolved from the meeting row rather than inferred in the browser. The room
  // previously guessed the host from LiveKit metadata or whoever joined first,
  // which is fine for a crown badge and not good enough to gate moderation.
  const localUserId = await getCurrentLocalUserId();
  const isHost = localUserId !== null && localUserId === meeting.hostId;

  return (
    <MeetingRoom
      meetingCode={meeting.meetingCode}
      meetingTitle={meeting.title}
      isHost={isHost}
    />
  );
}
