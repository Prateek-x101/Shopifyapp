-- CreateTable
CREATE TABLE "Vote" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vote_targetId_customerId_kind_key" ON "Vote"("targetId", "customerId", "kind");

-- CreateIndex
CREATE INDEX "Vote_reviewId_idx" ON "Vote"("reviewId");
