-- Reviews chosen for the storefront banner
ALTER TABLE "Review" ADD COLUMN "banner" BOOLEAN NOT NULL DEFAULT false;
