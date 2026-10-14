import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Additive CR-HM-QC-AUTHORITY-01 extension of the EXISTING QC aggregates. */
export const migration0442HardenHandymanQc: Migration = {
  id: '0442_harden_handyman_qc',
  async up(tx: PoolClient): Promise<void> {
    // No role receives either capability by migration or foundation seed.
    for (const [code, name] of [
      ['handyman.qc.manage', 'Inspect and decide Handyman QC'],
      ['handyman.qc.configure', 'Configure Handyman QC checklist requirements'],
    ]) {
      await tx.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }

    // Immutable, scope-specific required-item manifest. Never taken from an
    // OPEN or FINISH payload; no FM checklist or parallel QC engine is added.
    await tx.query(`
      CREATE TABLE handyman_qc_checklist_specs (
        execution_scope_id UUID PRIMARY KEY REFERENCES handyman_execution_scopes(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        checklist_identity TEXT NOT NULL CHECK (char_length(checklist_identity) BETWEEN 1 AND 200),
        required_item_keys TEXT[] NOT NULL
          CHECK (cardinality(required_item_keys) BETWEEN 1 AND 64),
        configured_by_user_id UUID NOT NULL REFERENCES users(id),
        configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION handyman_qc_specs_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'QC checklist requirements cannot be modified after configuration';
      END; $$;
      CREATE TRIGGER handyman_qc_specs_immutable_trigger
        BEFORE UPDATE OR DELETE ON handyman_qc_checklist_specs
        FOR EACH ROW EXECUTE FUNCTION handyman_qc_specs_immutable();
    `);

    await tx.query(`
      ALTER TABLE handyman_qc_runs
        ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        ADD COLUMN failure_reason TEXT;
      ALTER TABLE handyman_qc_run_events
        ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE handyman_defect_records
        ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        ADD COLUMN rectification_session_id UUID REFERENCES handyman_work_sessions(id),
        ADD COLUMN rectification_evidence_upload_id UUID REFERENCES handyman_field_evidence_uploads(id);
      ALTER TABLE handyman_defect_events
        ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    // Only byte-verified, exact-scope field uploads may be bound. Service
    // additionally verifies the storage bytes/digest at binding and FINISH.
    await tx.query(`
      CREATE TABLE handyman_qc_run_evidence (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES handyman_qc_runs(id),
        evidence_upload_id UUID NOT NULL REFERENCES handyman_field_evidence_uploads(id),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (run_id, evidence_upload_id),
        UNIQUE (run_id, idempotency_key)
      );
      CREATE OR REPLACE FUNCTION handyman_qc_evidence_scope_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_qc_runs r
          JOIN handyman_field_evidence_uploads e
            ON e.id = NEW.evidence_upload_id
           AND e.execution_scope_id = r.execution_scope_id
           AND e.client_id = r.client_id
           AND e.purpose = 'QC_EVIDENCE'
           AND e.upload_status = 'VERIFIED'
          WHERE r.id = NEW.run_id AND r.status = 'OPEN'
        ) THEN
          RAISE EXCEPTION 'QC evidence requires a verified QC upload on the open run scope'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER handyman_qc_evidence_scope_guard_trigger
        BEFORE INSERT ON handyman_qc_run_evidence
        FOR EACH ROW EXECUTE FUNCTION handyman_qc_evidence_scope_guard();
      CREATE TRIGGER handyman_qc_run_evidence_no_mutation
        BEFORE UPDATE OR DELETE ON handyman_qc_run_evidence
        FOR EACH ROW EXECUTE FUNCTION handyman_eqc_row_block_mutation();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DROP TABLE IF EXISTS handyman_qc_run_evidence;
      DROP FUNCTION IF EXISTS handyman_qc_evidence_scope_guard();
      ALTER TABLE handyman_defect_events DROP COLUMN IF EXISTS metadata;
      ALTER TABLE handyman_defect_records
        DROP COLUMN IF EXISTS rectification_evidence_upload_id,
        DROP COLUMN IF EXISTS rectification_session_id,
        DROP COLUMN IF EXISTS version;
      ALTER TABLE handyman_qc_run_events DROP COLUMN IF EXISTS metadata;
      ALTER TABLE handyman_qc_runs
        DROP COLUMN IF EXISTS failure_reason,
        DROP COLUMN IF EXISTS version;
      DROP TABLE IF EXISTS handyman_qc_checklist_specs;
      DROP FUNCTION IF EXISTS handyman_qc_specs_immutable();
    `);
    // Capability catalogue entries remain: deleting permissions on rollback
    // could invalidate grants. Rollback never grants or revokes actor rights.
  },
};
