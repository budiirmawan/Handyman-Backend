import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment.
 *
 * Additive minimum: ONE new bounded table + THREE permission catalogue rows.
 * No existing table, column, row, trigger or grant is touched, and the
 * frozen 0381/0382 history is not read or written here.
 *
 *   handyman_request_inspection_assignments
 *     Append-oriented assignment fact for the pre-quotation Field
 *     Worker/Surveyor of an INSPECTION_REQUIRED request. It is NOT
 *     CR-HM-04 execution assignment: no provider, crew, Lead, Execution
 *     Scope, Tenant/PIC, BM or quotation identity is referenced — the
 *     target is the existing authenticated local `users.id`.
 *
 *     The context columns are the 0378/0381-style verbatim snapshot of the
 *     ALREADY-authoritative request row (never caller-supplied), proved by
 *     the composite scope FK (handyman_request_id, client_id) →
 *     handyman_service_requests (id, client_id).
 *
 *     One ACTIVE assignment per request (partial UNIQUE). Reassignment
 *     keeps the predecessor row forever: the predecessor is flipped to
 *     SUPERSEDED with a mandatory reason and a pointer to its successor,
 *     and that successor points back at its predecessor. The BEFORE UPDATE
 *     guard refuses any other mutation (immutable columns, resurrection of
 *     a superseded row), and BEFORE DELETE refuses deletion, so the chain
 *     is historic evidence, not mutable state.
 *
 *   permissions
 *     `handyman.operations.inspection.assign`,
 *     `handyman.field.inspection.report.submit`,
 *     `handyman.operations.inspection.report.review` join the existing
 *     `permissions` catalogue. NO role assignment and NO grant is created
 *     (they are listed in UNASSIGNED_BY_DEFAULT_PERMISSION_CODES): no role,
 *     PLATFORM_ADMIN included, inherits them.
 *
 * FROZEN F1 is untouched: assignment adds no request status and the
 * existing INSPECTION_REQUIRED → DIAGNOSIS projection stays where it is.
 */
export const migration0445HandymanInspectionAssignments: Migration = {
  id: '0445_handyman_inspection_assignments',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_request_inspection_assignments (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        handyman_request_id    UUID NOT NULL,
        channel_attribution_id UUID NOT NULL REFERENCES handyman_channel_attributions (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        assigned_field_user_id UUID NOT NULL REFERENCES users (id),
        assigned_by_user_id    UUID NOT NULL REFERENCES users (id),
        assigned_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        superseded_at          TIMESTAMPTZ,
        superseded_by_assignment_id UUID,
        supersedes_assignment_id    UUID,
        supersession_reason    TEXT,

        CONSTRAINT handyman_request_inspection_assignment_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
        -- Supersession is a one-way fact: an ACTIVE row carries no
        -- supersession fields, a SUPERSEDED row carries all of them (reason
        -- bounded). The backward chain link supersedes_assignment_id is NULL
        -- only on the request's first assignment, so it is deliberately NOT
        -- part of this status check.
        CONSTRAINT handyman_request_inspection_assignment_supersession_check
          CHECK (
            (status = 'ACTIVE'
              AND superseded_at IS NULL
              AND superseded_by_assignment_id IS NULL
              AND supersession_reason IS NULL)
            OR
            (status = 'SUPERSEDED'
              AND superseded_at IS NOT NULL
              AND superseded_by_assignment_id IS NOT NULL
              AND supersession_reason IS NOT NULL
              AND char_length(supersession_reason) BETWEEN 1 AND 500)
          ),
        -- The two chain links are DEFERRED so one transaction can write the
        -- forward link (predecessor -> successor) BEFORE the successor row
        -- exists, while the partial unique index still guarantees that the
        -- predecessor leaves ACTIVE before the successor enters it.
        CONSTRAINT handyman_request_inspection_assignment_successor_fk
          FOREIGN KEY (superseded_by_assignment_id)
            REFERENCES handyman_request_inspection_assignments (id)
            DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT handyman_request_inspection_assignment_predecessor_fk
          FOREIGN KEY (supersedes_assignment_id)
            REFERENCES handyman_request_inspection_assignments (id)
            DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT handyman_request_inspection_assignment_successor_unique
          UNIQUE (superseded_by_assignment_id),
        CONSTRAINT handyman_request_inspection_assignment_predecessor_unique
          UNIQUE (supersedes_assignment_id),
        CONSTRAINT handyman_request_inspection_assignment_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_request_inspection_assignment_active_unique
        ON handyman_request_inspection_assignments (handyman_request_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_request_inspection_assignment_scope_idx
        ON handyman_request_inspection_assignments (client_id, assigned_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_request_inspection_assignment_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman inspection assignments are append-only.';
        END IF;
        IF OLD.status <> 'ACTIVE' THEN
          RAISE EXCEPTION
            'A superseded Handyman inspection assignment is immutable.';
        END IF;
        IF NEW.id <> OLD.id
           OR NEW.client_id <> OLD.client_id
           OR NEW.handyman_request_id <> OLD.handyman_request_id
           OR NEW.channel_attribution_id <> OLD.channel_attribution_id
           OR NEW.building_id <> OLD.building_id
           OR NEW.assigned_field_user_id <> OLD.assigned_field_user_id
           OR NEW.assigned_by_user_id <> OLD.assigned_by_user_id
           OR NEW.assigned_at <> OLD.assigned_at
           OR NEW.status <> 'SUPERSEDED'
           OR NEW.supersedes_assignment_id IS NOT NULL THEN
          RAISE EXCEPTION
            'Only the supersession of an active Handyman inspection assignment may be written.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_inspection_assignment_no_delete
        BEFORE DELETE ON handyman_request_inspection_assignments
        FOR EACH ROW
        EXECUTE FUNCTION handyman_request_inspection_assignment_guard()
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_inspection_assignment_guard_update
        BEFORE UPDATE ON handyman_request_inspection_assignments
        FOR EACH ROW
        EXECUTE FUNCTION handyman_request_inspection_assignment_guard()
    `);

    // Catalogue only — the same statement shape as 0436/0440 so the seed and
    // this migration can never disagree about one row.
    await client.query(`
      INSERT INTO permissions (id, code, name, status)
      VALUES
        (gen_random_uuid(), 'handyman.operations.inspection.assign',
         'Assign Field Inspectors to Handyman Requests', 'ACTIVE'),
        (gen_random_uuid(), 'handyman.field.inspection.report.submit',
         'Submit Handyman Field Inspection Reports', 'ACTIVE'),
        (gen_random_uuid(), 'handyman.operations.inspection.report.review',
         'Review Handyman Field Inspection Reports', 'ACTIVE')
      ON CONFLICT (code) DO NOTHING
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM permissions
       WHERE code IN (
         'handyman.operations.inspection.assign',
         'handyman.field.inspection.report.submit',
         'handyman.operations.inspection.report.review'
       )
         AND NOT EXISTS (
           SELECT 1 FROM role_permission_assignments r
            WHERE r.permission_id = permissions.id
         )
    `);
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_inspection_assignments CASCADE',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_inspection_assignment_guard() CASCADE',
    );
  },
};
