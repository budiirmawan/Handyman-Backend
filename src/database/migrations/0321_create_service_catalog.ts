import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SVC-01 PART 01 — Service Catalog Foundation.
 *
 * `service_catalog` is the governed Service master identity defined by
 * `docs/CR-BE-SVC-01_START_GOVERNANCE.md` (§4–§11):
 *
 *   - ONE flat, Client-scoped reference master — the SERVICE analog of
 *     `inventory_items` (0166). It is the stable identity and code where today
 *     only the free-text `service_requests.service_type` string exists.
 *   - `code` is unique per Client, normalized to uppercase at write time and
 *     byte-compatible with the existing `service_type` validation pattern
 *     (`/^[A-Z][A-Z0-9_-]*$/`, 2–64) — the migration bridge so today's
 *     accepted free-text codes are valid catalog codes with zero grammar
 *     friction. `code` is immutable once any governed child references it
 *     (enforced in the service layer; future scope-FK children arrive in
 *     later PARTs).
 *   - Classification is a free `category` column (the `skills` `0025`
 *     precedent). A governed Service-Category master is a documented future
 *     promotion (governance §4.3), not a v1 requirement.
 *   - Lifecycle is ACTIVE / INACTIVE (the reference-master idiom) — NOT the
 *     price catalog's DRAFT/ACTIVE/INACTIVE. A service concept has no
 *     effective-dated validity; commercial windows live on the price entry
 *     (PRICE-01 §4.2), not on the subject.
 *   - `UNIQUE (id, client_id)` follows the `0313`/`0319` scope-FK precedent so
 *     future child rows (service_requests, price entries, lineage snapshots)
 *     can prove Client scope structurally when they reference this master.
 *
 * This table creates no RFQ, quotation, award, PO, commitment, price, quantity,
 * UOM, or SERVICE-pricing behavior. It is identity only.
 */
export const migration0321CreateServiceCatalog: Migration = {
  id: '0321_create_service_catalog',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE service_catalog (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        code               TEXT NOT NULL,
        name               TEXT NOT NULL,
        description        TEXT,
        category           TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT service_catalog_client_code_unique
          UNIQUE (client_id, code),
        -- Scope-FK precedent (0313/0319): lets future child rows prove Client
        -- scope structurally when they reference a catalog entry.
        CONSTRAINT service_catalog_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT service_catalog_code_check
          CHECK (code ~ '^[A-Z][A-Z0-9_-]*$'
            AND length(btrim(code)) BETWEEN 2 AND 64),
        CONSTRAINT service_catalog_name_check
          CHECK (length(btrim(name)) BETWEEN 1 AND 200),
        CONSTRAINT service_catalog_description_check
          CHECK (description IS NULL
            OR length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT service_catalog_category_check
          CHECK (length(btrim(category)) BETWEEN 1 AND 100),
        CONSTRAINT service_catalog_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX service_catalog_client_idx
        ON service_catalog (client_id, status);
      CREATE INDEX service_catalog_client_code_idx
        ON service_catalog (client_id, code);
      CREATE INDEX service_catalog_category_idx
        ON service_catalog (client_id, category, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS service_catalog');
  },
};
