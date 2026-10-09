-- Explicit provenance for contact-to-contact calls.
--
-- No backfill is intentional: existing private meetings cannot be safely
-- distinguished from group or invite-only rooms based on participant history.
ALTER TABLE "Meeting"
  ADD COLUMN "directCallPeerId" TEXT,
  ADD COLUMN "directCallExpandedAt" TIMESTAMP(3);

CREATE INDEX "Meeting_direct_call_active_idx"
  ON "Meeting"("hostId", "directCallPeerId", "directCallExpandedAt", "createdAt");

ALTER TABLE "Meeting"
  ADD CONSTRAINT "Meeting_directCallPeerId_fkey"
  FOREIGN KEY ("directCallPeerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The source link is also the atomic confidentiality boundary. Application-level
-- "check then insert" cannot prevent a third-person expansion committing in the
-- gap between those two statements, so PostgreSQL validates while inserting.
ALTER TABLE "DirectMessage"
  ADD COLUMN "sourceMeetingId" TEXT;

CREATE INDEX "DirectMessage_sourceMeetingId_idx"
  ON "DirectMessage"("sourceMeetingId");

ALTER TABLE "DirectMessage"
  ADD CONSTRAINT "DirectMessage_sourceMeetingId_fkey"
  FOREIGN KEY ("sourceMeetingId") REFERENCES "Meeting"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "enforce_direct_call_message"()
RETURNS TRIGGER AS $$
DECLARE
  direct_meeting "Meeting"%ROWTYPE;
  outside_count INTEGER;
  endpoint_count INTEGER;
BEGIN
  IF NEW."sourceMeetingId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- SHARE conflicts with the UPDATE that stamps expansion. Whichever transaction
  -- obtains the meeting row first defines the boundary: a message already being
  -- committed finishes before expansion; an expansion already being committed
  -- makes the later message see the timestamp and fail.
  SELECT * INTO direct_meeting
  FROM "Meeting"
  WHERE "id" = NEW."sourceMeetingId"
  FOR SHARE;

  IF NOT FOUND
     OR direct_meeting."directCallPeerId" IS NULL
     OR direct_meeting."directCallExpandedAt" IS NOT NULL
     OR direct_meeting."groupId" IS NOT NULL
     OR direct_meeting."endsAt" IS NOT NULL
     OR direct_meeting."isPrivate" IS NOT TRUE
     OR NOT (
       (NEW."senderId" = direct_meeting."hostId" AND
        NEW."receiverId" = direct_meeting."directCallPeerId")
       OR
       (NEW."senderId" = direct_meeting."directCallPeerId" AND
        NEW."receiverId" = direct_meeting."hostId")
     ) THEN
    RAISE EXCEPTION 'DIRECT_CALL_PERSISTENCE_REFUSED'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    COUNT(*) FILTER (
      WHERE "userId" NOT IN (
        direct_meeting."hostId",
        direct_meeting."directCallPeerId"
      )
    ),
    COUNT(*) FILTER (
      WHERE "userId" IN (
        direct_meeting."hostId",
        direct_meeting."directCallPeerId"
      )
    )
  INTO outside_count, endpoint_count
  FROM "Participant"
  WHERE "meetingId" = direct_meeting."id";

  IF outside_count > 0 OR endpoint_count <> 2 THEN
    RAISE EXCEPTION 'DIRECT_CALL_PERSISTENCE_REFUSED'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DirectMessage_direct_call_guard"
BEFORE INSERT ON "DirectMessage"
FOR EACH ROW
EXECUTE FUNCTION "enforce_direct_call_message"();
