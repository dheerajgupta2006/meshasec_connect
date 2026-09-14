-- Cached OpenGraph metadata for URLs shared in direct messages.
--
-- Additive only: no existing table or column is touched, so this migration is
-- safe to apply to a live database.
CREATE TABLE "LinkPreview" (
    "id" TEXT NOT NULL,
    -- SHA-256 hex of the normalized URL. Fixed 64 characters, which is what
    -- makes it safe to index; the URL itself can be far longer than Postgres
    -- allows in a btree entry.
    "urlHash" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "title" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "siteName" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkPreview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LinkPreview_urlHash_key" ON "LinkPreview"("urlHash");

-- Supports eviction of stale rows by age.
CREATE INDEX "LinkPreview_updatedAt_idx" ON "LinkPreview"("updatedAt");
