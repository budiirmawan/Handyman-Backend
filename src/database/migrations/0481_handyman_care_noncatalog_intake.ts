import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-CARE-NONCATALOG-E2E-01 — additive Customer Care intake closure.
 *
 * A canonical Handyman Request may now be genuinely non-catalog: its
 * service_catalog_id is NULL, no variant is allowed, and the tenant need
 * description is mandatory. Existing catalogue rows and their foreign keys
 * are untouched; no historical row is rewritten.
 *
 * Customer Care's optional intake note is deliberately a separate,
 * INTERNAL-only fact. It is not a complaint, tenant communication, request
 * description, triage note, or operational event payload. Keeping it out of
 * handyman_service_requests also keeps it out of every existing tenant-safe
 * request projection by construction.
 *
 * Preferred windows continue to use handyman_scheduling_readiness (0387), so
 * no appointment or duplicate scheduling columns are introduced here.
 */
export const migration0481HandymanCareNoncatalogIntake: Migration = {
  id: '0481_handyman_care_noncatalog_intake',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_service_requests
        ALTER COLUMN service_catalog_id DROP NOT NULL;

      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_catalog_or_noncatalog_check
        CHECK (
          service_catalog_id IS NOT NULL
          OR (
            service_variant_id IS NULL
            AND description IS NOT NULL
            AND length(btrim(description)) BETWEEN 1 AND 1000
          )
        );

      CREATE TABLE handyman_care_internal_notes (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        handyman_request_id     UUID NOT NULL UNIQUE
          REFERENCES handyman_service_requests (id),
        note                    TEXT NOT NULL,
        visibility              TEXT NOT NULL DEFAULT 'INTERNAL',
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_care_internal_notes_note_check
          CHECK (length(btrim(note)) BETWEEN 1 AND 4000),
        CONSTRAINT handyman_care_internal_notes_visibility_check
          CHECK (visibility = 'INTERNAL'),
        CONSTRAINT handyman_care_internal_notes_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id, building_id)
          REFERENCES handyman_service_requests (id, client_id, building_id)
      );

      CREATE INDEX handyman_care_internal_notes_scope_idx
        ON handyman_care_internal_notes (client_id, building_id, created_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS handyman_care_internal_notes;
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_catalog_or_noncatalog_check;
      ALTER TABLE handyman_service_requests
        ALTER COLUMN service_catalog_id SET NOT NULL;
    `);
  },
};
