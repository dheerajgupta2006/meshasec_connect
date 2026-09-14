-- AlterTable
ALTER TABLE "DirectMessage" ADD COLUMN     "clientId" TEXT;

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "DirectMessage_senderId_clientId_key" ON "DirectMessage"("senderId", "clientId");
