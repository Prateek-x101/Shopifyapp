-- AI (Gemini) settings per shop; the key is stored encrypted
CREATE TABLE "AiConfig" (
    "shop" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'gemini-2.5-flash',
    "voice" TEXT NOT NULL DEFAULT '',
    "facts" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'auto',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConfig_pkey" PRIMARY KEY ("shop")
);
