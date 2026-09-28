ALTER TABLE "Assignment" DISABLE TRIGGER "Assignment_history_immutable";

ALTER TABLE "Assignment" ADD COLUMN "personName" VARCHAR(150);

UPDATE "Assignment" assignment
SET "personName" = person."displayName"
FROM "User" person
WHERE assignment."personId" = person.id;

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "Assignment" ENABLE TRIGGER "Assignment_history_immutable";

ALTER TABLE "Assignment"
ALTER COLUMN "personName" SET NOT NULL;

ALTER TABLE "Assignment"
ALTER COLUMN "personId" DROP NOT NULL;
