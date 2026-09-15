-- Dynamic call expansion: room passcodes for guests, and mid-call invites.
--
-- Additive only. `passcode` is nullable so existing meetings are untouched; a
-- meeting with a NULL passcode simply cannot be joined by a guest, which is the
-- correct behaviour for rooms created before the feature existed.
ALTER TABLE "Meeting" ADD COLUMN "passcode" TEXT;

CREATE TABLE "CallInvite" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "CallInvite_pkey" PRIMARY KEY ("id")
);

-- One invite per person per meeting: re-inviting updates the row and re-rings,
-- rather than stacking duplicates in the recipient's banner.
CREATE UNIQUE INDEX "CallInvite_meetingId_receiverId_key" ON "CallInvite"("meetingId", "receiverId");

-- Serves the ringing poll, which filters by receiver and recency.
CREATE INDEX "CallInvite_receiverId_createdAt_idx" ON "CallInvite"("receiverId", "createdAt");

CREATE INDEX "CallInvite_meetingId_idx" ON "CallInvite"("meetingId");

ALTER TABLE "CallInvite" ADD CONSTRAINT "CallInvite_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CallInvite" ADD CONSTRAINT "CallInvite_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CallInvite" ADD CONSTRAINT "CallInvite_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
