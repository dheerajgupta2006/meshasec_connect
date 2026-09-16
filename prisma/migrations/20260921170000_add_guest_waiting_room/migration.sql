-- Waiting room for guests, who have no User row to hang a WaitingRoomEntry off.
--
-- Additive: with no rows, guest admission behaves exactly as before.
CREATE TABLE "GuestWaitingEntry" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "KnockStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,

    CONSTRAINT "GuestWaitingEntry_pkey" PRIMARY KEY ("id")
);

-- One knock per guest per meeting, so reloading the lobby does not fill the
-- host's queue with duplicates of the same person.
CREATE UNIQUE INDEX "GuestWaitingEntry_meetingId_guestId_key" ON "GuestWaitingEntry"("meetingId", "guestId");

-- Serves the host's pending-queue poll.
CREATE INDEX "GuestWaitingEntry_meetingId_status_idx" ON "GuestWaitingEntry"("meetingId", "status");

ALTER TABLE "GuestWaitingEntry" ADD CONSTRAINT "GuestWaitingEntry_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
