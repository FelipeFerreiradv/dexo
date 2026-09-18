-- Apply with psql -X -v ON_ERROR_STOP=1 before enabling
-- CATALOG_IDENTITY_TENANT_IDS. This file uses \gexec and must not be pasted in
-- an editor that wraps the whole script in a transaction. No stock changes.
--
-- A cancelled CREATE INDEX CONCURRENTLY leaves an invalid relation behind.
-- IF NOT EXISTS would silently keep that unusable index, so remove only a
-- same-named index that is invalid, not ready, or has a different definition.
-- This SELECT and the CREATE below run in psql autocommit mode.
SET search_path = pg_catalog, public;
SET quote_all_identifiers = off;
SET lock_timeout = '15s';
SET statement_timeout = '5min';

DO $$
DECLARE
  existing_relation OID := to_regclass('public."Product_id_userId_key"');
  index_is_usable BOOLEAN := FALSE;
  backing_constraints TEXT;
BEGIN
  IF existing_relation IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM pg_index
     WHERE indexrelid = existing_relation
       AND indrelid = 'public."Product"'::regclass
  ) THEN
    RAISE EXCEPTION 'Product_id_userId_key is occupied by a relation that is not an index on Product';
  END IF;

  IF existing_relation IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM pg_index index_metadata
        JOIN pg_class index_relation
          ON index_relation.oid = index_metadata.indexrelid
        JOIN pg_class product_relation
          ON product_relation.oid = index_metadata.indrelid
        JOIN pg_am access_method
          ON access_method.oid = index_relation.relam
       WHERE index_metadata.indexrelid = existing_relation
         AND product_relation.oid = 'public."Product"'::regclass
         AND index_relation.relnamespace = product_relation.relnamespace
         AND index_metadata.indisvalid
         AND index_metadata.indisready
         AND index_metadata.indisunique
         AND index_metadata.indimmediate
         AND access_method.amname = 'btree'
         AND index_metadata.indpred IS NULL
         AND index_metadata.indexprs IS NULL
         AND index_metadata.indnkeyatts = 2
         AND index_metadata.indkey[0] IN (
           SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public."Product"'::regclass
              AND attname IN ('id', 'userId')
         )
         AND index_metadata.indkey[1] IN (
           SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public."Product"'::regclass
              AND attname IN ('id', 'userId')
         )
         AND index_metadata.indkey[0] <> index_metadata.indkey[1]
    ) INTO index_is_usable;

    SELECT string_agg(quote_ident(conname), ', ' ORDER BY conname)
      INTO backing_constraints
      FROM pg_constraint
     WHERE conindid = existing_relation;
    IF NOT index_is_usable AND backing_constraints IS NOT NULL THEN
      RAISE EXCEPTION 'Product_id_userId_key has a divergent definition and is required by constraint(s): %. Remove or repair those constraints before retrying', backing_constraints;
    END IF;
  END IF;
END;
$$;

SELECT format(
         'DROP INDEX CONCURRENTLY %I.%I',
         index_namespace.nspname,
         index_relation.relname
       )
  FROM pg_index index_metadata
  JOIN pg_class index_relation
    ON index_relation.oid = index_metadata.indexrelid
  JOIN pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_class product_relation
    ON product_relation.oid = index_metadata.indrelid
  JOIN pg_am access_method
    ON access_method.oid = index_relation.relam
 WHERE index_relation.oid = to_regclass('public."Product_id_userId_key"')
   AND product_relation.oid = 'public."Product"'::regclass
   AND NOT (
     index_relation.relnamespace = product_relation.relnamespace
     AND index_metadata.indisvalid
     AND index_metadata.indisready
     AND index_metadata.indisunique
     AND index_metadata.indimmediate
     AND access_method.amname = 'btree'
     AND index_metadata.indpred IS NULL
     AND index_metadata.indexprs IS NULL
     AND index_metadata.indnkeyatts = 2
     AND index_metadata.indkey[0] IN (
       SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public."Product"'::regclass
          AND attname IN ('id', 'userId')
     )
     AND index_metadata.indkey[1] IN (
       SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public."Product"'::regclass
          AND attname IN ('id', 'userId')
     )
     AND index_metadata.indkey[0] <> index_metadata.indkey[1]
   )
\gexec

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Product_id_userId_key"
  ON public."Product"(id, "userId");

-- Do not enter the transactional DDL unless the concurrent build produced the
-- valid unique index required by the composite foreign key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index index_metadata
      JOIN pg_class index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_class product_relation
        ON product_relation.oid = index_metadata.indrelid
      JOIN pg_am access_method
        ON access_method.oid = index_relation.relam
     WHERE index_relation.oid =
       to_regclass('public."Product_id_userId_key"')
       AND product_relation.oid = 'public."Product"'::regclass
       AND index_relation.relnamespace = product_relation.relnamespace
       AND index_metadata.indisvalid
       AND index_metadata.indisready
       AND index_metadata.indisunique
       AND index_metadata.indimmediate
       AND access_method.amname = 'btree'
       AND index_metadata.indpred IS NULL
       AND index_metadata.indexprs IS NULL
       AND index_metadata.indnkeyatts = 2
       AND index_metadata.indkey[0] IN (
         SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public."Product"'::regclass
            AND attname IN ('id', 'userId')
       )
       AND index_metadata.indkey[1] IN (
         SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public."Product"'::regclass
            AND attname IN ('id', 'userId')
       )
       AND index_metadata.indkey[0] <> index_metadata.indkey[1]
  ) THEN
    RAISE EXCEPTION 'Product_id_userId_key is missing, invalid, or has an unexpected definition';
  END IF;
END;
$$;

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Take the strongest locks up front, while no weaker lock from this transaction
-- exists. This avoids lock-upgrade deadlocks during ALTER TABLE / DROP TRIGGER.
-- Run this maintenance with API and sync processes stopped.
LOCK TABLE public."User", public."Product", public."MarketplaceAccount",
  public."ProductListing" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public."ProductIngestionIdentity" (
  "userId" TEXT,
  platform TEXT,
  "identityKey" TEXT,
  "productId" TEXT,
  status TEXT,
  "sellerSkus" TEXT[],
  "updatedAt" TIMESTAMP(3)
);

LOCK TABLE public."ProductIngestionIdentity" IN ACCESS EXCLUSIVE MODE;

-- IF NOT EXISTS alone is unsafe for a partially-created table. Abort on a
-- divergent column layout; repair defaults/nullability and constraints below.
DO $$
BEGIN
  IF EXISTS (
    WITH expected(attname, atttypid, atttypmod) AS (
      VALUES
        ('userId', 'text'::regtype, -1),
        ('platform', 'text'::regtype, -1),
        ('identityKey', 'text'::regtype, -1),
        ('productId', 'text'::regtype, -1),
        ('status', 'text'::regtype, -1),
        ('sellerSkus', 'text[]'::regtype, -1),
        ('updatedAt', 'timestamp without time zone'::regtype, 3)
    ), actual AS (
      SELECT attname, atttypid, atttypmod
        FROM pg_attribute
       WHERE attrelid = 'public."ProductIngestionIdentity"'::regclass
         AND attnum > 0 AND NOT attisdropped
    )
    SELECT 1
      FROM expected
      FULL JOIN actual USING (attname)
     WHERE expected.attname IS NULL OR actual.attname IS NULL
        OR expected.atttypid IS DISTINCT FROM actual.atttypid
        OR expected.atttypmod IS DISTINCT FROM actual.atttypmod
  ) THEN
    RAISE EXCEPTION 'ProductIngestionIdentity has an unexpected column layout';
  END IF;
END;
$$;

ALTER TABLE public."ProductIngestionIdentity"
  ALTER COLUMN "userId" DROP DEFAULT,
  ALTER COLUMN "userId" SET NOT NULL,
  ALTER COLUMN platform DROP DEFAULT,
  ALTER COLUMN platform SET NOT NULL,
  ALTER COLUMN "identityKey" DROP DEFAULT,
  ALTER COLUMN "identityKey" SET NOT NULL,
  ALTER COLUMN "productId" DROP DEFAULT,
  ALTER COLUMN "productId" DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'OBSERVED',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN "sellerSkus" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "sellerSkus" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

-- Remove uniqueness left by experimental/partial versions. Only the composite
-- primary key is valid: a product must have both listing and gallery aliases.
DO $$
DECLARE
  constraint_row RECORD;
  index_row RECORD;
  dependent_constraints TEXT;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public."ProductIngestionIdentity"'::regclass
       AND contype IN ('u', 'x')
  LOOP
    EXECUTE format(
      'ALTER TABLE public."ProductIngestionIdentity" DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;

  SELECT string_agg(
           format('%I.%I -> %I', index_namespace.nspname,
                  index_relation.relname, dependency.conname),
           ', ' ORDER BY index_relation.relname, dependency.conname
         )
    INTO dependent_constraints
    FROM pg_index index_metadata
    JOIN pg_class index_relation
      ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_constraint dependency
      ON dependency.conindid = index_metadata.indexrelid
   WHERE index_metadata.indrelid =
     'public."ProductIngestionIdentity"'::regclass
     AND (index_metadata.indisunique OR index_metadata.indisexclusion)
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint expected_primary_key
        WHERE expected_primary_key.conindid = index_metadata.indexrelid
          AND expected_primary_key.conrelid =
            'public."ProductIngestionIdentity"'::regclass
          AND expected_primary_key.contype = 'p'
     );
  IF dependent_constraints IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected ProductIngestionIdentity uniqueness is required by constraint(s): %. Remove those dependencies before retrying', dependent_constraints;
  END IF;

  FOR index_row IN
    SELECT index_namespace.nspname, index_relation.relname
      FROM pg_index index_metadata
      JOIN pg_class index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
     WHERE index_metadata.indrelid =
       'public."ProductIngestionIdentity"'::regclass
       AND (index_metadata.indisunique OR index_metadata.indisexclusion)
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint expected_primary_key
          WHERE expected_primary_key.conindid = index_metadata.indexrelid
            AND expected_primary_key.conrelid =
              'public."ProductIngestionIdentity"'::regclass
            AND expected_primary_key.contype = 'p'
       )
  LOOP
    EXECUTE format(
      'DROP INDEX %I.%I',
      index_row.nspname,
      index_row.relname
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_index index_metadata
     WHERE index_metadata.indrelid =
       'public."ProductIngestionIdentity"'::regclass
       AND (index_metadata.indisunique OR index_metadata.indisexclusion)
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint expected_primary_key
          WHERE expected_primary_key.conindid = index_metadata.indexrelid
            AND expected_primary_key.conrelid =
              'public."ProductIngestionIdentity"'::regclass
            AND expected_primary_key.contype = 'p'
       )
  ) THEN
    RAISE EXCEPTION 'Unexpected ProductIngestionIdentity uniqueness survived cleanup';
  END IF;
END;
$$;

DO $$
DECLARE
  primary_key_count INTEGER;
  primary_key_correct BOOLEAN;
BEGIN
  SELECT COUNT(*)::INTEGER,
         COALESCE(BOOL_AND(
           conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public."ProductIngestionIdentity"'::regclass
                 AND attname = 'userId'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public."ProductIngestionIdentity"'::regclass
                 AND attname = 'platform'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public."ProductIngestionIdentity"'::regclass
                 AND attname = 'identityKey')
           ]::SMALLINT[]
           AND NOT condeferrable
           AND convalidated
         ), FALSE)
    INTO primary_key_count, primary_key_correct
    FROM pg_constraint
   WHERE conrelid = 'public."ProductIngestionIdentity"'::regclass
     AND contype = 'p';

  IF primary_key_count = 0 THEN
    ALTER TABLE public."ProductIngestionIdentity"
      ADD CONSTRAINT "ProductIngestionIdentity_pkey"
      PRIMARY KEY ("userId", platform, "identityKey");
  ELSIF primary_key_count <> 1 OR NOT primary_key_correct THEN
    RAISE EXCEPTION 'ProductIngestionIdentity has an unexpected primary key';
  END IF;
END;
$$;

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  -- This table is owned by this DDL. Replacing every FK also validates rows
  -- left by an interrupted/older attempt and removes weaker extra variants.
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public."ProductIngestionIdentity"'::regclass
       AND contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE public."ProductIngestionIdentity" DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;

  ALTER TABLE public."ProductIngestionIdentity"
    ADD CONSTRAINT "ProductIngestionIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;
END;
$$;

-- This table is owned by this DDL. Replace all prior CHECK variants so a
-- partial/older attempt cannot leave weaker or unexpectedly stricter rules.
DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public."ProductIngestionIdentity"'::regclass
       AND contype = 'c'
  LOOP
    EXECUTE format(
      'ALTER TABLE public."ProductIngestionIdentity" DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END;
$$;

ALTER TABLE public."ProductIngestionIdentity"
  ADD CONSTRAINT "ProductIngestionIdentity_status_check"
    CHECK (status IN ('OBSERVED', 'CONFIRMED', 'AMBIGUOUS')),
  ADD CONSTRAINT "ProductIngestionIdentity_product_status_check"
    CHECK (
      (status IN ('OBSERVED', 'CONFIRMED') AND "productId" IS NOT NULL)
      OR (status = 'AMBIGUOUS' AND "productId" IS NULL)
    );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."ProductIngestionIdentity" i
      LEFT JOIN public."Product" p ON p.id = i."productId"
     WHERE i."productId" IS NOT NULL
       AND (p.id IS NULL OR p."userId" IS DISTINCT FROM i."userId")
  ) THEN
    RAISE EXCEPTION 'ProductIngestionIdentity contains cross-tenant product references';
  END IF;
END;
$$;

-- Replace any old single/composite product FK with the exact tenant-safe one.
DO $$
DECLARE
  constraint_row RECORD;
  product_attnum SMALLINT;
BEGIN
  SELECT attnum INTO product_attnum FROM pg_attribute
   WHERE attrelid = 'public."ProductIngestionIdentity"'::regclass
     AND attname = 'productId';
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public."ProductIngestionIdentity"'::regclass
       AND contype = 'f' AND product_attnum = ANY(conkey)
  LOOP
    EXECUTE format(
      'ALTER TABLE public."ProductIngestionIdentity" DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END;
$$;

ALTER TABLE public."ProductIngestionIdentity"
  ADD CONSTRAINT "ProductIngestionIdentity_productId_userId_fkey"
  FOREIGN KEY ("productId", "userId")
  REFERENCES public."Product"(id, "userId") ON DELETE CASCADE;

DO $$
DECLARE
  existing_relation OID :=
    to_regclass('public."ProductIngestionIdentity_productId_idx"');
BEGIN
  IF existing_relation IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM pg_index
     WHERE indexrelid = existing_relation
       AND indrelid = 'public."ProductIngestionIdentity"'::regclass
  ) THEN
    RAISE EXCEPTION 'ProductIngestionIdentity_productId_idx is occupied by a relation outside ProductIngestionIdentity';
  END IF;

  IF existing_relation IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM pg_index index_metadata
      JOIN pg_class index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_class identity_relation
        ON identity_relation.oid = index_metadata.indrelid
      JOIN pg_am access_method
        ON access_method.oid = index_relation.relam
     WHERE index_metadata.indexrelid = existing_relation
       AND identity_relation.oid =
         'public."ProductIngestionIdentity"'::regclass
       AND index_relation.relnamespace = identity_relation.relnamespace
       AND index_metadata.indisvalid
       AND index_metadata.indisready
       AND NOT index_metadata.indisunique
       AND NOT index_metadata.indisexclusion
       AND access_method.amname = 'btree'
       AND index_metadata.indpred IS NULL
       AND index_metadata.indexprs IS NULL
       AND index_metadata.indnkeyatts = 1
       AND index_metadata.indnatts = 1
       AND index_metadata.indkey[0] = (
         SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public."ProductIngestionIdentity"'::regclass
            AND attname = 'productId'
       )
  ) THEN
    DROP INDEX public."ProductIngestionIdentity_productId_idx";
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "ProductIngestionIdentity_productId_idx"
  ON public."ProductIngestionIdentity"("productId");

-- A conta e o produto usados pelo novo fluxo são validados e bloqueados na mesma
-- transação pelo CatalogIdentityService. Não imponha essa regra globalmente a ProductListing:
-- o banco possui vínculos legados deliberados entre contas e estoques de
-- usuários relacionados. Remova triggers de uma eventual versão parcial
-- anterior deste DDL sem alterar esses vínculos.
DROP TRIGGER IF EXISTS "ProductListing_same_tenant_guard"
  ON public."ProductListing";
DROP TRIGGER IF EXISTS "Product_linked_tenant_guard" ON public."Product";
DROP TRIGGER IF EXISTS "Product_tenant_immutable" ON public."Product";
DROP TRIGGER IF EXISTS "MarketplaceAccount_linked_tenant_guard"
  ON public."MarketplaceAccount";
DROP TRIGGER IF EXISTS "MarketplaceAccount_tenant_immutable"
  ON public."MarketplaceAccount";

DROP FUNCTION IF EXISTS public.assert_product_listing_same_tenant();
DROP FUNCTION IF EXISTS public.forbid_product_tenant_change();
DROP FUNCTION IF EXISTS public.forbid_marketplace_account_tenant_change();

COMMIT;
