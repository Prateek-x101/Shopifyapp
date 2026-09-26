-- AlterTable
ALTER TABLE "Review" ADD COLUMN "needsReply" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Review" ADD COLUMN "commentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Review" ADD COLUMN "lastCommentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Review_shop_needsReply_idx" ON "Review"("shop", "needsReply");
