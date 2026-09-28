BEGIN;

ALTER TABLE "InventoryMovement" DISABLE TRIGGER "InventoryMovement_immutable";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "InventoryMovement"
    WHERE "movementType" = 'TRANSFER'::"MovementType"
      AND ("locationId" IS NULL OR "sourceLocationId" IS NULL OR "destinationLocationId" IS NULL
        OR "locationId" NOT IN ("sourceLocationId", "destinationLocationId"))
  ) THEN
    RAISE EXCEPTION 'Cannot remove locations: a historical transfer has incomplete endpoints';
  END IF;
END $$;

CREATE TEMP TABLE "InventoryStock_collapsed" ON COMMIT DROP AS
SELECT
  (array_agg("id" ORDER BY "createdAt", "id"))[1] AS "id",
  "productId",
  SUM("quantity") AS "quantity",
  MIN("createdAt") AS "createdAt",
  MAX("updatedAt") AS "updatedAt"
FROM "InventoryStock"
GROUP BY "productId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InventoryStock_collapsed" WHERE "quantity" > 2147483647 OR "quantity" < 0) THEN
    RAISE EXCEPTION 'Cannot remove locations: collapsed stock is outside the supported integer range';
  END IF;
END $$;

UPDATE "InventoryMovement"
SET "movementType" = CASE
  WHEN "locationId" = "sourceLocationId" THEN 'EXIT'::"MovementType"
  ELSE 'ENTRY'::"MovementType"
END
WHERE "movementType" = 'TRANSFER'::"MovementType";

WITH ranked_initials AS (
  SELECT "id", row_number() OVER (PARTITION BY "productId" ORDER BY "effectiveAt", "createdAt", "id") AS position
  FROM "InventoryMovement"
  WHERE "movementType" = 'INITIAL'::"MovementType"
)
UPDATE "InventoryMovement" movement
SET "movementType" = 'ENTRY'::"MovementType"
FROM ranked_initials
WHERE movement."id" = ranked_initials."id"
  AND ranked_initials.position > 1;

DELETE FROM "InventoryStock";
ALTER TABLE "InventoryStock" DROP CONSTRAINT "InventoryStock_locationId_fkey";
DROP INDEX "InventoryStock_productId_locationId_key";
DROP INDEX "InventoryStock_locationId_idx";
ALTER TABLE "InventoryStock" DROP COLUMN "locationId";
INSERT INTO "InventoryStock" ("id", "productId", "quantity", "createdAt", "updatedAt")
SELECT "id", "productId", "quantity"::INTEGER, "createdAt", "updatedAt"
FROM "InventoryStock_collapsed";
CREATE UNIQUE INDEX "InventoryStock_productId_key" ON "InventoryStock"("productId");

ALTER TABLE "Asset" DROP CONSTRAINT "Asset_locationId_fkey";
DROP INDEX "Asset_locationId_status_idx";
ALTER TABLE "Asset" DROP COLUMN "locationId";

ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_locationId_fkey";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_sourceLocationId_fkey";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_destinationLocationId_fkey";
DROP INDEX "InventoryMovement_locationId_effectiveAt_idx";
ALTER TABLE "InventoryMovement" DROP COLUMN "locationId";
ALTER TABLE "InventoryMovement" DROP COLUMN "sourceLocationId";
ALTER TABLE "InventoryMovement" DROP COLUMN "destinationLocationId";
DROP TABLE "Location";

ALTER TYPE "MovementType" RENAME TO "MovementType_old";
CREATE TYPE "MovementType" AS ENUM ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'ADJUSTMENT');
ALTER TABLE "InventoryMovement"
  ALTER COLUMN "movementType" TYPE "MovementType"
  USING ("movementType"::TEXT::"MovementType");
DROP TYPE "MovementType_old";

ALTER TABLE "InventoryMovement" ENABLE TRIGGER "InventoryMovement_immutable";

COMMIT;
