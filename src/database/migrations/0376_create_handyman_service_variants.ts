import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-02 PART 01 — Handyman Service Variant foundation.
 *
 * `handyman_service_variants` is the Handyman-governed child of the existing
 * `service_catalog` master (0321) per the frozen
 * `docs/handyman/CR-HM-02_START_GOVERNANCE.md` chain:
 * Service → Service Variant → (Common Material Profile, later PARTs).
 *
 * Identity/presentation only: code grammar is byte-identical to the
 * service-catalog code pattern (`/^[A-Z][A-Z0-9_-]*$/`, 2–64, normalized to
 * uppercase at write time in the service layer, as the master does).
 * Variant identity is unique per service (`service_catalog_id, code`).
 * `client_id` is NOT caller-supplied: it is derived from the parent service
 * entry and proven structurally by the composite scope-FK
 * `(service_catalog_id, client_id) → service_catalog (id, client_id)`
 * (the 0313/0319/0321 precedent mirrored for 0376). Lifecycle follows the
 * reference-master ACTIVE/INACTIVE idiom — never the price catalog's
 * DRAFT/ACTIVE/INACTIVE.
 *
 * A Variant is never a separate authoritative service master: the
 * `service_catalog` entry remains the sole master service reference. This
 * table carries NO material/media/price/request/evidence behavior (later
 * PARTs).
 */
export const migration0376CreateHandymanServiceVariants: Migration = {
  id: '0376_create_handyman_service_variants',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_service_variants (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        service_catalog_id UUID NOT NULL,
        code               TEXT NOT NULL,
        name               TEXT NOT NULL,
        description        TEXT,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_variants_service_code_unique
          UNIQUE (service_catalog_id, code),
        -- Scope-FK precedent (0313/0319/0321): the variant's Client scope is
        -- proven structurally against the service master.
        CONSTRAINT handyman_service_variants_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_service_variants_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_variants_code_check
          CHECK (code ~ '^[A-Z][A-Z0-9_-]*$'
            AND length(btrim(code)) BETWEEN 2 AND 64),
        CONSTRAINT handyman_service_variants_name_check
          CHECK (length(btrim(name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_service_variants_description_check
          CHECK (description IS NULL
            OR length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_service_variants_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX handyman_service_variants_client_idx
        ON handyman_service_variants (client_id, status);
      CREATE INDEX handyman_service_variants_service_idx
        ON handyman_service_variants (service_catalog_id, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_service_variants');
  },
};
