import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — authoritative Work Session
 * binding for Crew Leader execution-photo field evidence.
 *
 * Stored field-evidence records gain an OPTIONAL authoritative link to the
 * Work Session under which the submission was made:
 *
 *   - `work_session_id` references `handyman_work_sessions (id)` and is
 *     nullable: historical evidence and every non-session workflow
 *     (arrival/inspection, pre-session uploads, receipt/variation evidence)
 *     keep working with `NULL`, and no existing row is ever backfilled or
 *     reinterpreted (no fabricated associations).
 *   - The composite FK `(... work_session_id, execution_scope_id)` anchors
 *     the binding to the EXACT execution scope of the referenced session:
 *     a bound row can never claim a different scope than its session
 *     (MATCH SIMPLE keeps unbound, scope-less, and session-less rows
 *     untouched). The paired CHECK refuses a session link without a scope.
 *   - `hm_field_evidence_work_session_freeze` makes the linkage immutable
 *     after insert: staging bytes, verification, or any later UPDATE can
 *     change every other column but never the stored Work Session link.
 *
 * Validation of existence, exact Request/scope, Client/Building, Crew Lead
 * identity and lifecycle state lives in the field-evidence service, at
 * presign/finalization, inside the caller's locked transaction.
 */
export const migration0535HandymanFieldEvidenceWorkSession: Migration = {
  id: '0535_handyman_field_evidence_work_session',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_field_evidence_uploads
        ADD COLUMN work_session_id UUID
    `);
    // The referenced (id, execution_scope_id) pair is unique by
    // construction (id is the PK); the explicit unique index backs the
    // composite foreign key below.
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_sessions_id_scope_uidx
        ON handyman_work_sessions (id, execution_scope_id)
    `);
    await client.query(`
      ALTER TABLE handyman_field_evidence_uploads
        ADD CONSTRAINT handyman_field_evidence_work_session_scope_fk
        FOREIGN KEY (work_session_id, execution_scope_id)
        REFERENCES handyman_work_sessions (id, execution_scope_id)
    `);
    await client.query(`
      ALTER TABLE handyman_field_evidence_uploads
        ADD CONSTRAINT handyman_field_evidence_work_session_scope_check
        CHECK (work_session_id IS NULL OR execution_scope_id IS NOT NULL)
    `);
    await client.query(`
      CREATE INDEX handyman_field_evidence_work_session_idx
        ON handyman_field_evidence_uploads (work_session_id)
        WHERE work_session_id IS NOT NULL
    `);
    await client.query(`
      CREATE FUNCTION hm_field_evidence_work_session_freeze()
        RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.work_session_id IS DISTINCT FROM OLD.work_session_id THEN
          RAISE EXCEPTION 'Field evidence work-session linkage is immutable once stored.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await client.query(`
      CREATE TRIGGER hm_field_evidence_work_session_freeze
        BEFORE UPDATE ON handyman_field_evidence_uploads
        FOR EACH ROW EXECUTE FUNCTION hm_field_evidence_work_session_freeze()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS hm_field_evidence_work_session_freeze
        ON handyman_field_evidence_uploads
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS hm_field_evidence_work_session_freeze()
    `);
    // Stored bindings are authoritative history: never drop them silently.
    if (
      (
        await client.query<{ used: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM handyman_field_evidence_uploads
              WHERE work_session_id IS NOT NULL) AS used`,
        )
      ).rows[0]?.used
    ) {
      throw new Error(
        'Refusing to remove stored field evidence Work Session bindings.',
      );
    }
    await client.query(`
      DROP INDEX IF EXISTS handyman_field_evidence_work_session_idx
    `);
    await client.query(`
      ALTER TABLE handyman_field_evidence_uploads
        DROP CONSTRAINT IF EXISTS handyman_field_evidence_work_session_scope_check,
        DROP CONSTRAINT IF EXISTS handyman_field_evidence_work_session_scope_fk
    `);
    await client.query(`
      DROP INDEX IF EXISTS handyman_work_sessions_id_scope_uidx
    `);
    await client.query(`
      ALTER TABLE handyman_field_evidence_uploads
        DROP COLUMN IF EXISTS work_session_id
    `);
  },
};
