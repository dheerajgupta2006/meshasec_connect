-- Groups: a named set of people who can chat and call together.
--
-- Additive. Every existing query is untouched: the three new tables start empty,
-- and "Meeting"."groupId" is nullable, so every meeting created before now simply
-- has no group attribution.
--
-- Unread is a per-member cursor ("GroupMember"."lastReadAt") rather than a
-- per-message flag. "DirectMessage"."readAt" works because a direct message has
-- exactly one recipient; a group message has as many readers as the group has
-- members, so a flag would need a row per message per member.
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "GroupRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupMessage" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "replyToId" TEXT,

    CONSTRAINT "GroupMessage_pkey" PRIMARY KEY ("id")
);

-- The group this call belongs to, or NULL for a 1-on-1 or a link meeting.
ALTER TABLE "Meeting" ADD COLUMN     "groupId" TEXT;

CREATE INDEX "Group_ownerId_idx" ON "Group"("ownerId");

-- One membership per person per group, so adding someone twice updates the
-- existing row rather than giving them two seats and two unread counts.
CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");

-- Serves "which groups am I in", which every group page starts with.
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- Serves the owner/admin lookups that gate member management.
CREATE INDEX "GroupMember_groupId_role_idx" ON "GroupMember"("groupId", "role");

-- Idempotency: a retry carrying the same client key collapses here instead of
-- posting a second message.
CREATE UNIQUE INDEX "GroupMessage_senderId_clientId_key" ON "GroupMessage"("senderId", "clientId");

-- Serves the thread window, which reads one group newest-first.
CREATE INDEX "GroupMessage_groupId_createdAt_idx" ON "GroupMessage"("groupId", "createdAt");

CREATE INDEX "GroupMessage_replyToId_idx" ON "GroupMessage"("replyToId");

-- Serves the per-group call-reuse lookup, which filters by group and recency.
CREATE INDEX "Meeting_groupId_createdAt_idx" ON "Meeting"("groupId", "createdAt");

ALTER TABLE "Group" ADD CONSTRAINT "Group_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A deleted quote leaves the reply intact rather than taking it with it.
ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "GroupMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL, not CASCADE: deleting a group must not erase the attendance history
-- of the calls that happened in it.
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
