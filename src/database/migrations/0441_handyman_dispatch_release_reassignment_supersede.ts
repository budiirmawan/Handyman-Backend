import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-OPS-DISPATCH-02 final gate — reassignment supersedes any prior
 * dispatch release. When a crew assignment is superseded, an ACTIVE
 * (RELEASED) dispatch release tied to that assignment must be marked
 * SUPERSEDED so the prior PIC loses mutation authority and MY_JOBS no
 * longer surfaces the work order as actionable.
 *
 * An IN_PROGRESS release (work session already CHECKED_IN) MUST NOT be
 * superseded — reassignment is blocked upstream by the active-session
 * guard in handyman-scope-assignment.service.ts; the trigger below
 * enforces it as defense-in-depth.
 */
export const migration0441HandymanDispatchReleaseReassignmentSupersede: Migration = {
  id: '0441_handyman_dispatch_release_reassignment_supersede',
  async up(client: PoolClient): Promise<void> {
    // Allow SUPERSEDED as a terminal state for releases superseded by
    // reassignment before a work session begins.
    await client.query(`
      ALTER TABLE handyman_dispatch_releases
        DROP CONSTRAINT IF EXISTS handyman_dispatch_releases_status_check;
      ALTER TABLE handyman_dispatch_releases
        ADD CONSTRAINT handyman_dispatch_releases_status_check
          CHECK (status IN (
            'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'SUPERSEDED'
          ));

      -- Recreate transition guard to include RELEASED -> SUPERSEDED.
      CREATE OR REPLACE FUNCTION handyman_dispatch_release_guard()
      RETURNS trigger AS $$
      DECLARE
        a_status TEXT;
        a_scope UUID;
        a_client UUID;
        v_kind TEXT;
        v_state TEXT;
        v_scope UUID;
      BEGIN
        SELECT status, execution_scope_id, client_id
          INTO a_status, a_scope, a_client
          FROM handyman_execution_scope_assignments WHERE id = NEW.assignment_id;
        IF NOT FOUND OR a_status <> 'ACTIVE'
           OR a_scope <> NEW.execution_scope_id
           OR a_client <> NEW.client_id THEN
          RAISE EXCEPTION 'Dispatch release requires an ACTIVE assignment for the execution scope'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.appointment_id IS NOT NULL THEN
          SELECT kind, state, execution_scope_id INTO v_kind, v_state, v_scope
            FROM handyman_visit_appointments WHERE id = NEW.appointment_id;
          IF NOT FOUND OR v_kind <> 'EXECUTION'
             OR v_scope <> NEW.execution_scope_id
             OR v_state NOT IN ('CONFIRMED','IN_PROGRESS') THEN
            RAISE EXCEPTION 'Dispatch release appointment must be a CONFIRMED/IN_PROGRESS EXECUTION visit for the scope'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW.id <> OLD.id OR NEW.client_id <> OLD.client_id
             OR NEW.execution_scope_id <> OLD.execution_scope_id
             OR NEW.assignment_id <> OLD.assignment_id
             OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
             OR NEW.released_by_user_id <> OLD.released_by_user_id
             OR NEW.released_at <> OLD.released_at
             OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'Dispatch release identity is immutable' USING ERRCODE = '23514';
          END IF;
          IF NOT ((OLD.status = 'RELEASED'     AND NEW.status IN ('IN_PROGRESS','CANCELLED','SUPERSEDED'))
                 OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))
                 OR (OLD.status = 'SUPERSEDED'  AND NEW.status = 'SUPERSEDED')
                 OR (OLD.status = 'CANCELLED'   AND NEW.status = 'CANCELLED')
                 OR (OLD.status = 'COMPLETED'   AND NEW.status = 'COMPLETED')) THEN
            RAISE EXCEPTION 'Invalid dispatch release status transition: % -> %', OLD.status, NEW.status
              USING ERRCODE = '23514';
          END IF;
          IF NEW.status = 'SUPERSEDED' THEN
            IF NEW.cancelled_by_user_id IS NULL
               OR NEW.cancelled_at IS NULL
               OR NEW.cancel_reason IS NULL THEN
              RAISE EXCEPTION 'SUPERSEDED releases require provenance (actor, timestamp, reason)'
                USING ERRCODE = '23514';
            END IF;
            -- Defense-in-depth: must never supersede an IN_PROGRESS release
            -- (reassignment already blocks this upstream).
            IF OLD.status = 'IN_PROGRESS' THEN
              RAISE EXCEPTION 'Cannot supersede an IN_PROGRESS dispatch release (active work session)'
                USING ERRCODE = '23514';
            END IF;
          END IF;
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'Dispatch release version must increment by 1' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- Partial unique index excludes SUPERSEDED so a new RELEASED row can be
      -- inserted for the new crew after reassignment.
      DROP INDEX IF EXISTS handyman_dispatch_release_one_active_idx;
      CREATE UNIQUE INDEX handyman_dispatch_release_one_active_idx
        ON handyman_dispatch_releases (execution_scope_id)
        WHERE status IN ('RELEASED', 'IN_PROGRESS');
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS handyman_dispatch_release_one_active_idx;
      CREATE UNIQUE INDEX handyman_dispatch_release_one_active_idx
        ON handyman_dispatch_releases (execution_scope_id)
        WHERE status IN ('RELEASED', 'IN_PROGRESS');
    `);
  },
};
