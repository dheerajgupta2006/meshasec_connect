-- Idempotent repair/forward migration for the atomic direct-call message guard.
-- Existing databases may already have these objects from the preceding migration;
-- fresh databases are protected either way.
ALTER TABLE "DirectMessage"
  ADD COLUMN IF NOT EXISTS "sourceMeetingId" TEXT;

CREATE INDEX IF NOT EXISTS "DirectMessage_sourceMeetingId_idx"
  ON "DirectMessage"("sourceMeetingId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DirectMessage_sourceMeetingId_fkey'
  ) THEN
    ALTER TABLE "DirectMessage"
      ADD CONSTRAINT "DirectMessage_sourceMeetingId_fkey"
      FOREIGN KEY ("sourceMeetingId") REFERENCES "Meeting"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END;
$$;

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

DROP TRIGGER IF EXISTS "DirectMessage_direct_call_guard" ON "DirectMessage";

CREATE TRIGGER "DirectMessage_direct_call_guard"
BEFORE INSERT ON "DirectMessage"
FOR EACH ROW
EXECUTE FUNCTION "enforce_direct_call_message"();
