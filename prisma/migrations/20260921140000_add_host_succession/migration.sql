-- Host succession: the role transfers when the acting host leaves.
--
-- `hostId` still records the creator and is untouched, so meeting history and the
-- dashboard's "You are the host" keep working. `currentHostId` is who is running
-- the room now; NULL means the creator has not been replaced.
ALTER TABLE "Meeting" ADD COLUMN "currentHostId" TEXT;

CREATE INDEX "Meeting_currentHostId_idx" ON "Meeting"("currentHostId");

-- SET NULL rather than CASCADE: if the acting host's account is deleted the
-- meeting must survive and fall back to the creator, not be deleted with them.
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_currentHostId_fkey" FOREIGN KEY ("currentHostId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
