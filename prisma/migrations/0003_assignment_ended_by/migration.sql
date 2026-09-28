ALTER TABLE "Assignment" ADD COLUMN "endedById" UUID;

CREATE INDEX "Assignment_endedById_idx" ON "Assignment"("endedById");

ALTER TABLE "Assignment"
ADD CONSTRAINT "Assignment_endedById_fkey"
FOREIGN KEY ("endedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE RESTRICT;
