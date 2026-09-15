-- Host moderation: meeting lock, waiting room, and the knock queue.
--
-- Additive. Both new Meeting columns default to false, so every existing meeting
-- keeps its current behaviour: unlocked, no waiting room.
ALTER TABLE "Meeting" ADD COLUMN "isLocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meeting" ADD COLUMN "waitingRoomEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "KnockStatus" AS ENUM ('PENDING', 'ADMITTED', 'DENIED');

CREATE TABLE "WaitingRoomEntry" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "KnockStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,

    CONSTRAINT "WaitingRoomEntry_pkey" PRIMARY KEY ("id")
);

-- One knock per person per meeting: re-knocking updates rather than duplicating.
CREATE UNIQUE INDEX "WaitingRoomEntry_meetingId_userId_key" ON "WaitingRoomEntry"("meetingId", "userId");

-- Serves the host's pending-queue poll.
CREATE INDEX "WaitingRoomEntry_meetingId_status_idx" ON "WaitingRoomEntry"("meetingId", "status");

-- Serves the guest polling for their own admission decision.
CREATE INDEX "WaitingRoomEntry_userId_status_idx" ON "WaitingRoomEntry"("userId", "status");

ALTER TABLE "WaitingRoomEntry" ADD CONSTRAINT "WaitingRoomEntry_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WaitingRoomEntry" ADD CONSTRAINT "WaitingRoomEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
