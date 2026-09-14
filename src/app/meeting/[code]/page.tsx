import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { MeetingRoom } from "@/components/meeting/meeting-room";
import { prisma } from "@/lib/prisma";

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
    },
  });

  if (!meeting) {
    notFound();
  }

  return (
    <MeetingRoom
      meetingCode={meeting.meetingCode}
      meetingTitle={meeting.title}
    />
  );
}
