-- File and image attachments for direct messages.
--
-- Additive only: no existing table or column is touched, so this is safe to
-- apply to a live database. A deployment that has not applied it yet keeps
-- serving text messages: the read paths treat a missing table as "no
-- attachments", and only sending an attachment is refused until it exists.
CREATE TYPE "AttachmentKind" AS ENUM ('IMAGE', 'FILE');

CREATE TABLE "DirectMessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectMessageAttachment_pkey" PRIMARY KEY ("id")
);

-- One attachment per message.
CREATE UNIQUE INDEX "DirectMessageAttachment_messageId_key" ON "DirectMessageAttachment"("messageId");

-- Serves the per-sender daily upload budget.
CREATE INDEX "DirectMessageAttachment_createdAt_idx" ON "DirectMessageAttachment"("createdAt");

-- Deleting a message, or the account that sent it, removes its bytes too.
ALTER TABLE "DirectMessageAttachment" ADD CONSTRAINT "DirectMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
