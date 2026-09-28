-- Product names are no longer scoped by category. Stop before the destructive
-- schema change if existing records would violate the new global invariant.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (
            SELECT lower(btrim("name")) AS normalized_name
            FROM "Product"
            GROUP BY lower(btrim("name"))
            HAVING count(*) > 1
        ) AS duplicate_names
    ) THEN
        RAISE EXCEPTION 'Cannot remove categories: product names must be unique globally before migration';
    END IF;
END $$;

ALTER TABLE "Product" DROP CONSTRAINT "Product_categoryId_fkey";
DROP INDEX "Product_categoryId_idx";
ALTER TABLE "Product" DROP COLUMN "categoryId";
DROP TABLE "Category";

CREATE UNIQUE INDEX "Product_name_lower_key" ON "Product" (lower(btrim("name")));
