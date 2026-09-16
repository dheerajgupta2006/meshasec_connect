-- Bans for guests, who have no User row to hang a DENIED knock off.
--
-- Additive: with no rows, guest removal behaves exactly as before this migration.
CREATE TABLE "MeetingGuestBan" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingGuestBan_pkey" PRIMARY KEY ("id")
);

-- One ban per guest per meeting; a repeated removal updates nothing rather than
-- stacking rows.
CREATE UNIQUE INDEX "MeetingGuestBan_meetingId_guestId_key" ON "MeetingGuestBan"("meetingId", "guestId");

CREATE INDEX "MeetingGuestBan_meetingId_idx" ON "MeetingGuestBan"("meetingId");

ALTER TABLE "MeetingGuestBan" ADD CONSTRAINT "MeetingGuestBan_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
