import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-OPS-DISPATCH-02 P0-A — Inspector Visit Assignment.
 *
 * Append-only assignment history tied to the actual Inspection Visit
 * appointment id. At most one ACTIVE row per INSPECTION visit. Operations
 * (tenant_company.manage) creates/supersedes; the Inspector reads via the
 * existing `/handyman/field/my-jobs` feed (extended to include PROPOSED /
 * TENANT_SELECTED rows where the user is the ACTIVE assignee). Existing
 * visit appointment capacity and lifecycle authorities remain untouched.
 */
export const migration0438CreateHandymanInspectorAssignments: Migration = {
  id: '0438_create_handyman_inspector_assignments',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_inspector_assignments (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients(id),
        handyman_request_id         UUID NOT NULL,
        visit_appointment_id        UUID NOT NULL
          REFERENCES handyman_visit_appointments(id),
        inspector_user_id           UUID NOT NULL REFERENCES users(id),
        status                      TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REVOKED')),
        assigned_by_user_id         UUID NOT NULL REFERENCES users(id),
        assigned_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        supersedes_assignment_id    UUID
          REFERENCES handyman_inspector_assignments(id),
        reassignment_reason         TEXT,
        version                     INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_insp_assignments_no_self_supersede
          CHECK (supersedes_assignment_id IS NULL
                 OR supersedes_assignment_id <> id),
        CONSTRAINT handyman_insp_assignments_reason_check
          CHECK (status = 'ACTIVE' OR char_length(btrim(reassignment_reason)) BETWEEN 1 AND 1000)
      );

      CREATE UNIQUE INDEX handyman_insp_assignments_one_active_idx
        ON handyman_inspector_assignments (visit_appointment_id)
        WHERE status = 'ACTIVE';

      CREATE INDEX handyman_insp_assignments_inspector_idx
        ON handyman_inspector_assignments (client_id, inspector_user_id, assigned_at DESC);

      CREATE INDEX handyman_insp_assignments_request_idx
        ON handyman_inspector_assignments (client_id, handyman_request_id, assigned_at DESC);
    `);

    // Scope guard: visit must be kind=INSPECTION and belong to same request/client.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_insp_assignment_scope_guard()
      RETURNS trigger AS $$
      DECLARE
        v RECORD;
      BEGIN
        SELECT id, client_id, handyman_request_id, kind, state
          INTO v FROM handyman_visit_appointments WHERE id = NEW.visit_appointment_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inspector assignment visit appointment not found' USING ERRCODE = '23503';
        END IF;
        IF v.kind <> 'INSPECTION' THEN
          RAISE EXCEPTION 'Inspector assignments may only target INSPECTION visits' USING ERRCODE = '23514';
        END IF;
        IF NEW.client_id IS DISTINCT FROM v.client_id THEN
          RAISE EXCEPTION 'Inspector assignment client_id must match visit client_id' USING ERRCODE = '23514';
        END IF;
        IF NEW.handyman_request_id IS DISTINCT FROM v.handyman_request_id THEN
          RAISE EXCEPTION 'Inspector assignment handyman_request_id must match visit request' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER handyman_insp_assignment_scope_check
        BEFORE INSERT OR UPDATE ON handyman_inspector_assignments
        FOR EACH ROW EXECUTE FUNCTION handyman_insp_assignment_scope_guard();
    `);

    // Immutability guard: only status transitions ACTIVE -> SUPERSEDED/REVOKED
    // may update an existing row; all identity columns stay frozen.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_insp_assignment_freeze()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Inspector assignment history is immutable; delete forbidden.' USING ERRCODE = '23514';
        END IF;
        IF NEW.id <> OLD.id
           OR NEW.client_id <> OLD.client_id
           OR NEW.handyman_request_id <> OLD.handyman_request_id
           OR NEW.visit_appointment_id <> OLD.visit_appointment_id
           OR NEW.inspector_user_id <> OLD.inspector_user_id
           OR NEW.assigned_by_user_id <> OLD.assigned_by_user_id
           OR NEW.assigned_at <> OLD.assigned_at
           OR NEW.supersedes_assignment_id IS DISTINCT FROM OLD.supersedes_assignment_id
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'Inspector assignment identity columns are immutable.' USING ERRCODE = '23514';
        END IF;
        IF NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('SUPERSEDED','REVOKED')) THEN
          RAISE EXCEPTION 'Only ACTIVE -> SUPERSEDED|REVOKED transitions are allowed.' USING ERRCODE = '23514';
        END IF;
        IF NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'Inspector assignment version must increment by 1.' USING ERRCODE = '23514';
        END IF;
        IF NEW.updated_at <= OLD.updated_at THEN
          NEW.updated_at = NOW();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER handyman_insp_assignment_freeze_trigger
        BEFORE UPDATE OR DELETE ON handyman_inspector_assignments
        FOR EACH ROW EXECUTE FUNCTION handyman_insp_assignment_freeze();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_insp_assignment_freeze_trigger ON handyman_inspector_assignments;
      DROP FUNCTION IF EXISTS handyman_insp_assignment_freeze();
      DROP TRIGGER IF EXISTS handyman_insp_assignment_scope_check ON handyman_inspector_assignments;
      DROP FUNCTION IF EXISTS handyman_insp_assignment_scope_guard();
      DROP TABLE IF EXISTS handyman_inspector_assignments;
    `);
  },
};
