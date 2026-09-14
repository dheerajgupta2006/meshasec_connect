-- CreateTable
CREATE TABLE "MeetingCreationRequest" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "creationRequestId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingCreationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingCreationRequest_meetingId_key" ON "MeetingCreationRequest"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingCreationRequest_clerkId_idx" ON "MeetingCreationRequest"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingCreationRequest_clerkId_creationRequestId_key" ON "MeetingCreationRequest"("clerkId", "creationRequestId");

-- AddForeignKey
ALTER TABLE "MeetingCreationRequest" ADD CONSTRAINT "MeetingCreationRequest_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
