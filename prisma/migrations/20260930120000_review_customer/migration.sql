-- Customer who wrote the review in the store (for blocking)
ALTER TABLE "Review" ADD COLUMN "customerId" TEXT;
