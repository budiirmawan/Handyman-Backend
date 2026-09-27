import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-03 PART 01 — Handyman request triage foundation.
 *
 * Additive minimum (two bounded writes: one NEW decision table + one
 * bounded CHECK re-add; reverting `down`). No existing non-Handyman table
 * is touched, and both effects are PK-checked by catalog name.
 *
 *   handyman_request_triage_decisions   FROZEN F2 decision record: minimum,
 *     immutable, append-oriented (first-triage-per-request enforced by
 *     UNIQUE(handyman_request_id)); the row carries ONLY the triage facts —
 *     no diagnosis / classification / specialist-target / provider /
 *     quotation / execution columns are created. Context columns are the
 *     0378-style verbatim snapshot of the ALREADY-authoritative request
 *     row (client/attribution/building are projection facts, never
 *     re-derived, never re-authorized), and the composite scope-FK
 *     `(handyman_request_id, client_id) → handyman_service_requests
 *     (id, client_id)` (0378's handyman_service_requests_id_client_unique)
 *     proves that derivation structurally — the same idiom used by the
 *     variant/profile masters in 0376/0377/0378.
 *
 *     Journal semantics per FROZEN F6: the per-request decision history
 *     lives in the shared append-only BE-07 operational_events authority
 *     (the exact authority the finding-history pattern reads) — written
 *     through `recordOperationalEvent` on the SAME executor/transaction as
 *     this row and the request projection update (see the service). No
 *     8-col duplicate of the shared authority is created by this CR.
 *
 *   handyman_service_requests_status_check   FROZEN F1 bounded vocabulary,
 *   exactly: INTAKE → TRIAGE → INSPECTION_REQUIRED | DIAGNOSIS.
 *   (`READY_FOR_NEXT_STEP` / `REFERRED` arrive with the decision chain
 *   (PART 03/04); no execution/quotation/provider state is added.)
 *
 * DB protection (F2/F6 append-only pattern — same convention family as the
 * canonical lifecycle guards in 0256/0257/0259): BEFORE UPDATE / DELETE
 * trigger on the decision table blocks row mutation/deletion. INSERT is
 * the only write ever allowed.
 *
 * No FM table, no evidence/stage expansion (FROZEN F3), no quotation /
 * specialist / provider structure in this migration.
 */
export const migration0380CreateHandymanRequestTriage: Migration = {
  id: '0380_create_handyman_request_triage',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_request_triage_decisions (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        handyman_request_id  UUID NOT NULL,
        channel_attribution_id UUID NOT NULL REFERENCES handyman_channel_attributions (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        triage_disposition   TEXT NOT NULL,
        triage_note          TEXT NOT NULL,
        actor_user_id        UUID NOT NULL REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_triage_disposition_check
          CHECK (triage_disposition IN ('INSPECTION_REQUIRED', 'DIAGNOSIS')),
        CONSTRAINT handyman_request_triage_note_length_check
          CHECK (char_length(triage_note) BETWEEN 1 AND 500),
        CONSTRAINT handyman_request_triage_request_unique
          UNIQUE (handyman_request_id),
        CONSTRAINT handyman_request_triage_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_request_triage_scope_idx
        ON handyman_request_triage_decisions (client_id, created_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_request_triage_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman triage decision records are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_triage_no_update
        BEFORE UPDATE ON handyman_request_triage_decisions
        FOR EACH ROW EXECUTE FUNCTION handyman_request_triage_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_triage_no_delete
        BEFORE DELETE ON handyman_request_triage_decisions
        FOR EACH ROW EXECUTE FUNCTION handyman_request_triage_block_mutation()
    `);

    await client.query(`
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT handyman_service_requests_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_status_check
          CHECK (status IN ('INTAKE', 'TRIAGE', 'INSPECTION_REQUIRED', 'DIAGNOSIS'))
    `);
  },
  async down(client: PoolClient): Promise<void> {
    // The pre-triage F1 vocabulary is not transition-safe for rows already
    // moved past INTAKE: DOWN never fabricates a parent status; it applies
    // only when no post-INTAKE rows remain.
    await client.query(`
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT handyman_service_requests_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_status_check
          CHECK (status IN ('INTAKE'))
    `);
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_triage_decisions CASCADE',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_triage_block_mutation() CASCADE',
    );
  },
};
