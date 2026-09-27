import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-03 PART 03 — Handyman diagnosis + scope authority (FROZEN F1/F2/
 * F4/F5/F9).
 *
 * Additive minimum (new bounded tables; one same-name status CHECK re-add
 * per the 1209/0161/0380 re-add convention inside the added Handyman table
 * only; reverting `down`; nothing else touched).
 *
 *   handyman_disciplines                FROZEN F9 machine-readable scope
 *     authority (Handyman-owned ONLY; never vendor_categories/
 *     asset_categories/incident categories). Seeded exactly with the
 *     F9-frozen disciplines. `service_catalog.category` remains
 *     descriptive free-form metadata and is never consulted as authority.
 *
 *   handyman_discipline_service_associations
 *     Handyman-owned optional link: one ACTIVE service_catalog entry → ONE
 *     discipline. Preserves client isolation via the verbatim client
 *     snapshot. Does NOT modify service_catalog semantics and carries no
 *     provider/vendor meaning.
 *
 *   handyman_request_diagnoses          FROZEN F2 immutable/append-only
 *     diagnosis decision (minimum record: request ref + discipline ref +
 *     concise diagnosis + optional recommended catalogue anchor + actor +
 *     server timestamp). The classification + status mapping are
 *     server-DERIVED from discipline.scope_class (F9.7) and stored as
 *     authoritative snapshots; a caller-supplied classification field
 *     never exists at the persistence layer.
 *
 *   request status CHECK re-add         adds exactly the F1-frozen
 *     READY_FOR_NEXT_STEP and REFERRED statuses (REFERRED is terminal in
 *     CR-HM-03; no execution/quotation/provider/work-order vocabulary).
 *
 * DB protection: BEFORE UPDATE / DELETE triggers on the diagnosis record
 * and the registry rows (same family as 0380/0381 pre-existing Handyman
 * triggers).
 */
export const migration0382CreateHandymanDiagnosisScopeAuthority: Migration = {
  id: '0382_create_handyman_diagnosis_scope_authority',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_disciplines (
        id          UUID PRIMARY KEY,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        scope_class TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        CONSTRAINT handyman_disciplines_code_unique UNIQUE (code),
        CONSTRAINT handyman_disciplines_scope_class_check
          CHECK (scope_class IN
            ('GENERAL_HANDYMAN', 'SPECIALIST', 'OUT_OF_HANDYMAN_SCOPE')),
        CONSTRAINT handyman_disciplines_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    const seeds: Array<[string, string, string]> = [
      ['SIMPLE_PLUMBING', 'Simple Plumbing', 'GENERAL_HANDYMAN'],
      ['FURNITURE', 'Furniture', 'GENERAL_HANDYMAN'],
      ['MINOR_CIVIL', 'Minor Civil', 'GENERAL_HANDYMAN'],
      ['GENERAL_HANDYMAN', 'General Handyman', 'GENERAL_HANDYMAN'],
      ['ELECTRICAL', 'Electrical', 'SPECIALIST'],
      ['AC', 'Air Conditioning', 'SPECIALIST'],
      ['FM_COMMON_BUILDING', 'FM Common Building', 'OUT_OF_HANDYMAN_SCOPE'],
    ];
    for (const [code, name, scopeClass] of seeds) {
      await client.query(
        `INSERT INTO handyman_disciplines (id, code, name, scope_class)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), code, name, scopeClass],
      );
    }

    await client.query(`
      CREATE TABLE handyman_discipline_service_associations (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        handyman_discipline_id  UUID NOT NULL REFERENCES handyman_disciplines (id),
        service_catalog_id      UUID NOT NULL REFERENCES service_catalog (id),
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_discipline_service_associations_catalog_unique
          UNIQUE (service_catalog_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_discipline_service_associations_scope_idx
        ON handyman_discipline_service_associations (client_id, created_at)
    `);

    await client.query(`
      CREATE TABLE handyman_request_diagnoses (
        id                            UUID PRIMARY KEY,
        client_id                     UUID NOT NULL REFERENCES clients (id),
        handyman_request_id           UUID NOT NULL,
        channel_attribution_id        UUID NOT NULL REFERENCES handyman_channel_attributions (id),
        building_id                   UUID NOT NULL REFERENCES buildings (id),
        handyman_discipline_id        UUID NOT NULL REFERENCES handyman_disciplines (id),
        discipline_code               TEXT NOT NULL,
        diagnosis                     TEXT NOT NULL,
        scope_classification          TEXT NOT NULL,
        recommended_service_catalog_id UUID REFERENCES service_catalog (id),
        diagnosed_by_user_id          UUID NOT NULL REFERENCES users (id),
        diagnosed_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_diagnoses_diagnosis_length_check
          CHECK (char_length(diagnosis) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_request_diagnoses_classification_check
          CHECK (scope_classification IN
            ('GENERAL_HANDYMAN', 'SPECIALIST_REQUIRED',
             'OUT_OF_HANDYMAN_SCOPE')),
        CONSTRAINT handyman_request_diagnoses_request_unique
          UNIQUE (handyman_request_id),
        CONSTRAINT handyman_request_diagnoses_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_request_diagnoses_scope_idx
        ON handyman_request_diagnoses (client_id, diagnosed_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_request_diagnoses_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman diagnosis records are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_diagnoses_no_update
        BEFORE UPDATE ON handyman_request_diagnoses
        FOR EACH ROW EXECUTE FUNCTION handyman_request_diagnoses_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_diagnoses_no_delete
        BEFORE DELETE ON handyman_request_diagnoses
        FOR EACH ROW EXECUTE FUNCTION handyman_request_diagnoses_block_mutation()
    `);

    // 0380 re-add convention: exact same-name CHECK, vocabulary extended
    // only with F1-frozen READY_FOR_NEXT_STEP and REFERRED.
    await client.query(
      'ALTER TABLE handyman_service_requests ' +
        'DROP CONSTRAINT handyman_service_requests_status_check',
    );
    await client.query(`
      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_status_check
        CHECK (status IN (
          'INTAKE', 'TRIAGE', 'INSPECTION_REQUIRED', 'DIAGNOSIS',
          'READY_FOR_NEXT_STEP', 'REFERRED'
        ))
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'ALTER TABLE handyman_service_requests ' +
        'DROP CONSTRAINT IF EXISTS handyman_service_requests_status_check',
    );
    await client.query(`
      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_status_check
        CHECK (status IN
          ('INTAKE', 'TRIAGE', 'INSPECTION_REQUIRED', 'DIAGNOSIS'))
    `);
    await client.query('DROP TABLE IF EXISTS handyman_request_diagnoses CASCADE');
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_diagnoses_block_mutation() CASCADE',
    );
    await client.query(
      'DROP TABLE IF EXISTS handyman_discipline_service_associations CASCADE',
    );
    await client.query('DROP TABLE IF EXISTS handyman_disciplines CASCADE');
  },
};
