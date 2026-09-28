ALTER TABLE "User" ADD COLUMN "phone" VARCHAR(40);

CREATE TABLE "ActivationCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivationCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActivationCode_codeHash_key" ON "ActivationCode"("codeHash");
CREATE INDEX "ActivationCode_userId_expiresAt_idx" ON "ActivationCode"("userId", "expiresAt");
CREATE INDEX "ActivationCode_userId_usedAt_idx" ON "ActivationCode"("userId", "usedAt");

ALTER TABLE "ActivationCode" ADD CONSTRAINT "ActivationCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
