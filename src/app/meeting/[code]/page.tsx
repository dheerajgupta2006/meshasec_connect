import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { MeetingRoom } from "@/components/meeting/meeting-room";
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

  if (!userId) {
    redirect("/sign-in");
  }

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
