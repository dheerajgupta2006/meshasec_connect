-- Co-host role, granted by the host during a call.
--
-- Additive with a false default, so every existing participant keeps exactly the
-- rights they have today.
ALTER TABLE "Participant" ADD COLUMN "isCoHost" BOOLEAN NOT NULL DEFAULT false;

-- Serves the room's role lookup, which needs the co-hosts for one meeting.
CREATE INDEX "Participant_meetingId_isCoHost_idx" ON "Participant"("meetingId", "isCoHost");
