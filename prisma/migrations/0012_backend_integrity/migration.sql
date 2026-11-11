BEGIN;

LOCK TABLE "Product" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT lower(btrim("sku")) FROM "Product"
    WHERE "sku" IS NOT NULL AND btrim("sku") <> ''
    GROUP BY lower(btrim("sku")) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Resolve case-insensitive duplicate product SKUs before applying this migration';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "Product_sku_lower_key" ON "Product" (lower(btrim("sku")))
WHERE "sku" IS NOT NULL AND btrim("sku") <> '';

CREATE FUNCTION prevent_used_product_tracking_mode_change() RETURNS trigger AS $$
BEGIN
  IF NEW."trackingMode" IS DISTINCT FROM OLD."trackingMode" AND (
    EXISTS (SELECT 1 FROM "InventoryStock" WHERE "productId" = OLD."id") OR
    EXISTS (SELECT 1 FROM "InventoryMovement" WHERE "productId" = OLD."id") OR
    EXISTS (SELECT 1 FROM "Asset" WHERE "productId" = OLD."id")
  ) THEN
    RAISE EXCEPTION 'The tracking mode of a used product cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Product_tracking_mode_guard"
BEFORE UPDATE OF "trackingMode" ON "Product"
FOR EACH ROW EXECUTE FUNCTION prevent_used_product_tracking_mode_change();

COMMIT;
