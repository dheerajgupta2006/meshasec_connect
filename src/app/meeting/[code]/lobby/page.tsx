import { auth } from "@clerk/nextjs/server";
import { unstable_noStore as noStore } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { PreJoinLobby } from "@/components/meeting/pre-join-lobby";
import { prisma } from "@/lib/prisma";

interface LobbyPageProps {
  params: {
    code: string;
  };
}

export default async function LobbyPage({ params }: LobbyPageProps) {
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
    <PreJoinLobby
      meetingCode={meeting.meetingCode}
      meetingTitle={meeting.title}
    />
  );
}
