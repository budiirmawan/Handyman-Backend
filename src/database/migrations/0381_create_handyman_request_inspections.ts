import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-03 PART 02 — Handyman inspection record (FROZEN F1/F2/F3/F6/F7).
 *
 * Additive minimum (one new bounded table; reverting `down`). No existing
 * table is touched. DIAGNOSIS is already part of the frozen F1 status CHECK
 * (added by 0380's bounded vocabulary: INTAKE → TRIAGE →
 * INSPECTION_REQUIRED | DIAGNOSIS), so no status re-add exists here.
 *
 *   handyman_request_inspections   FROZEN F2 decision-record row for the
 *     inspection step: MINIMUM structured record — request reference,
 *     inspection-specific outcome, concise notes, inspecting actor, server
 *     timestamp. The context columns are the 0378-style verbatim snapshot
 *     of the ALREADY-authoritative request row (never caller-supplied,
 *     never re-derived) proved structurally by the composite scope-FK
 *     (handyman_request_id, client_id) → handyman_service_requests
 *     (id, client_id). UNIQUE(handyman_request_id) keeps exactly one
 *     inspection per request (one-trip decision chain; no re-inspection
 *     vocabulary exists in CR-HM-03).
 *
 *     Result vocabulary is minimal and inspection-specific
 *     (INSPECTED / NOT_INSPECTABLE) — by freeze it carries NO diagnosis,
 *     NO classification, NO specialist target.
 *
 *     FROZEN F3: no inspection evidence exists — no evidence column, no
 *     parent/stage expansion, no link into the evidence engine. PHOTO /
 *     VIDEO behavior from CR-HM-02 PART 04 is untouched (INTAKE-seam only,
 *     unchanged).
 *
 * DB protection (same family as 0380): BEFORE UPDATE / DELETE trigger
 * rejects mutation/deletion; INSERT is the only write ever allowed.
 */
export const migration0381CreateHandymanRequestInspections: Migration = {
  id: '0381_create_handyman_request_inspections',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_request_inspections (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        handyman_request_id   UUID NOT NULL,
        channel_attribution_id UUID NOT NULL REFERENCES handyman_channel_attributions (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        inspection_result     TEXT NOT NULL,
        inspection_notes      TEXT NOT NULL,
        inspected_by_user_id  UUID NOT NULL REFERENCES users (id),
        inspected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_inspection_result_check
          CHECK (inspection_result IN ('INSPECTED', 'NOT_INSPECTABLE')),
        CONSTRAINT handyman_request_inspection_notes_length_check
          CHECK (char_length(inspection_notes) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_request_inspection_request_unique
          UNIQUE (handyman_request_id),
        CONSTRAINT handyman_request_inspection_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_request_inspection_scope_idx
        ON handyman_request_inspections (client_id, inspected_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_request_inspection_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman inspection records are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_inspection_no_update
        BEFORE UPDATE ON handyman_request_inspections
        FOR EACH ROW EXECUTE FUNCTION handyman_request_inspection_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_inspection_no_delete
        BEFORE DELETE ON handyman_request_inspections
        FOR EACH ROW EXECUTE FUNCTION handyman_request_inspection_block_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_inspections CASCADE',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_inspection_block_mutation() CASCADE',
    );
  },
};
