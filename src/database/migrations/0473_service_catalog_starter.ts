import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter foundation.
 *
 * Promotes the existing flat `service_catalog` reference master (0321) into a
 * two-level Service Catalog (Service Category → Service Item) and adds the
 * Client/Building availability + separate-pricing seams required by the
 * Apartment Indonesia Handyman starter pack.
 *
 *   1. `service_category` — governed, Client-scoped Service-Category master
 *      (the CR-BE-SVC-01 §4.3 "future promotion", now realized). `code` is
 *      unique per Client and uses the byte-identical code grammar as
 *      `service_catalog` (`/^[A-Z][A-Z0-9_-]*$/`, 2–64). Lifecycle is the
 *      reference-master ACTIVE/INACTIVE idiom. `source` records whether the
 *      row came from the governed STARTER_PACK import or a MANUAL create.
 *
 *   2. `service_catalog` gains `service_category_id` (nullable FK to the new
 *      master) and `source`. Existing rows are untouched (NULL link, MANUAL
 *      source) — this is a purely additive evolution; no existing catalogue
 *      identity, code uniqueness or lifecycle changes.
 *
 *   3. `service_catalog_availability` — Client/Building availability grants.
 *      A service with NO availability rows is available across the whole
 *      Client; once at least one row exists the service becomes explicitly
 *      Building-scoped and is available only where an ACTIVE row grants it.
 *      Building scope implicitly covers the Building's Property (a Building
 *      belongs to exactly one Property → one Client).
 *
 * Pricing is deliberately NOT a column here: the governed reference price
 * remains the existing `price_catalog_entries` SERVICE authority (0319) and
 * is composed at read time. The catalogue therefore carries no default price
 * and never invents a nominal amount.
 */
export const migration0473ServiceCatalogStarter: Migration = {
  id: '0473_service_catalog_starter',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE service_category (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        code               TEXT NOT NULL,
        name               TEXT NOT NULL,
        description        TEXT,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        source             TEXT NOT NULL DEFAULT 'MANUAL',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT service_category_client_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT service_category_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT service_category_code_check
          CHECK (code ~ '^[A-Z][A-Z0-9_-]*$'
            AND length(btrim(code)) BETWEEN 2 AND 64),
        CONSTRAINT service_category_name_check
          CHECK (length(btrim(name)) BETWEEN 1 AND 200),
        CONSTRAINT service_category_description_check
          CHECK (description IS NULL
            OR length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT service_category_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT service_category_source_check
          CHECK (source IN ('MANUAL', 'STARTER_PACK'))
      )
    `);

    await client.query(`
      CREATE INDEX service_category_client_idx
        ON service_category (client_id, status);
      CREATE INDEX service_category_client_code_idx
        ON service_category (client_id, code);
    `);

    // Additive evolution of the existing service_catalog master.
    await client.query(`
      ALTER TABLE service_catalog
        ADD COLUMN IF NOT EXISTS service_category_id UUID
          REFERENCES service_category (id),
        ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL';
      ALTER TABLE service_catalog
        ADD CONSTRAINT service_catalog_source_check
          CHECK (source IN ('MANUAL', 'STARTER_PACK'));
      CREATE INDEX IF NOT EXISTS service_catalog_category_idx
        ON service_catalog (client_id, service_category_id, status);
    `);

    await client.query(`
      CREATE TABLE service_catalog_availability (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        service_catalog_id UUID NOT NULL REFERENCES service_catalog (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT service_catalog_availability_service_building_unique
          UNIQUE (service_catalog_id, building_id),
        CONSTRAINT service_catalog_availability_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT service_catalog_availability_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX service_catalog_availability_service_idx
        ON service_catalog_availability (service_catalog_id, status);
      CREATE INDEX service_catalog_availability_building_idx
        ON service_catalog_availability (building_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS service_catalog_availability;
      ALTER TABLE service_catalog
        DROP CONSTRAINT IF EXISTS service_catalog_source_check;
      ALTER TABLE service_catalog
        DROP COLUMN IF EXISTS source;
      ALTER TABLE service_catalog
        DROP COLUMN IF EXISTS service_category_id;
      DROP TABLE IF EXISTS service_category;
    `);
  },
};
