import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Versioned *configuration* for the existing QC run engine, not a second QC
 * execution/checklist engine. Older runs/specs remain untouched: they are
 * deliberately NOT assigned invented template versions or checklist items. */
export const migration0444VersionHandymanQcChecklists: Migration = {
  id: '0444_version_handyman_qc_checklists',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_qc_checklist_versions (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        code TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{0,127}$'),
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        required_item_keys TEXT[] NOT NULL
          CHECK (cardinality(required_item_keys) BETWEEN 1 AND 64),
        published_by_user_id UUID NOT NULL REFERENCES users(id),
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(client_id, code, version_number)
      );
      CREATE OR REPLACE FUNCTION handyman_qc_checklist_version_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Published QC checklist versions are immutable'
          USING ERRCODE = '23514';
      END; $$;
      CREATE TRIGGER handyman_qc_checklist_version_immutable_trigger
        BEFORE UPDATE OR DELETE ON handyman_qc_checklist_versions
        FOR EACH ROW EXECUTE FUNCTION handyman_qc_checklist_version_immutable();

      CREATE TABLE handyman_qc_scope_checklist_bindings (
        execution_scope_id UUID PRIMARY KEY
          REFERENCES handyman_qc_checklist_specs(execution_scope_id),
        checklist_version_id UUID NOT NULL
          REFERENCES handyman_qc_checklist_versions(id),
        bound_by_user_id UUID NOT NULL REFERENCES users(id),
        bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION handyman_qc_scope_binding_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_qc_checklist_specs s
          JOIN handyman_qc_checklist_versions v
            ON v.id = NEW.checklist_version_id
            AND v.client_id = s.client_id
            AND v.required_item_keys = s.required_item_keys
          WHERE s.execution_scope_id = NEW.execution_scope_id
            AND (s.checklist_identity = v.code || '@v' || v.version_number::text
                 OR lower(s.checklist_identity) = lower(v.code))
            AND NOT EXISTS (
              SELECT 1 FROM handyman_qc_runs r
              WHERE r.execution_scope_id = s.execution_scope_id
                AND r.status = 'OPEN')
        ) THEN
          RAISE EXCEPTION 'QC checklist version must match immutable scope requirements before an OPEN run'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER handyman_qc_scope_binding_guard_trigger
        BEFORE INSERT ON handyman_qc_scope_checklist_bindings
        FOR EACH ROW EXECUTE FUNCTION handyman_qc_scope_binding_guard();
      CREATE TRIGGER handyman_qc_scope_binding_immutable_trigger
        BEFORE UPDATE OR DELETE ON handyman_qc_scope_checklist_bindings
        FOR EACH ROW EXECUTE FUNCTION handyman_qc_checklist_version_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DROP TABLE handyman_qc_scope_checklist_bindings;
      DROP FUNCTION handyman_qc_scope_binding_guard();
      DROP TABLE handyman_qc_checklist_versions;
      DROP FUNCTION handyman_qc_checklist_version_immutable();
    `);
  },
};
