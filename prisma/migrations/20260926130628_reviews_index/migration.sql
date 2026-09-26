-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "location" TEXT,
    "status" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'Website',
    "orderId" TEXT,
    "images" TEXT NOT NULL DEFAULT '[]',
    "replies" TEXT NOT NULL DEFAULT '[]',
    "helpful" INTEGER NOT NULL DEFAULT 0,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "hasMedia" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Review_shop_productId_status_createdAt_idx" ON "Review"("shop", "productId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Review_shop_productId_status_rating_idx" ON "Review"("shop", "productId", "status", "rating");

-- CreateIndex
CREATE INDEX "Review_shop_status_idx" ON "Review"("shop", "status");
