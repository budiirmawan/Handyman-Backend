import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-OPS-DISPATCH-02 P0-C — Dispatch Readiness & Release.
 *
 * Backend-authoritative, auditable dispatch release record. A release is the
 * explicit Operations action after eligibility, appointment, permit,
 * material/site readiness and assignment-current checks succeed. An execution
 * scope may hold at most one ACTIVE release (RELEASED / IN_PROGRESS); release
 * is CANCELLED/COMPLETED by work-session lifecycle, never by silent
 * reassignment.
 */
export const migration0440CreateHandymanDispatchReleases: Migration = {
  id: '0440_create_handyman_dispatch_releases',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_dispatch_releases (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients(id),
        execution_scope_id          UUID NOT NULL
          REFERENCES handyman_execution_scopes(id),
        assignment_id               UUID NOT NULL
          REFERENCES handyman_execution_scope_assignments(id),
        appointment_id              UUID
          REFERENCES handyman_visit_appointments(id),
        status                      TEXT NOT NULL DEFAULT 'RELEASED'
          CHECK (status IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
        released_by_user_id         UUID NOT NULL REFERENCES users(id),
        released_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancelled_by_user_id        UUID REFERENCES users(id),
        cancelled_at                TIMESTAMPTZ,
        cancel_reason               TEXT
          CHECK (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
        readiness_snapshot          JSONB NOT NULL DEFAULT '{}'::jsonb,
        version                     INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_dispatch_release_scope_fk
          FOREIGN KEY (execution_scope_id)
          REFERENCES handyman_execution_scopes(id),
        CONSTRAINT handyman_dispatch_release_assignment_fk
          FOREIGN KEY (assignment_id)
          REFERENCES handyman_execution_scope_assignments(id)
      );

      CREATE UNIQUE INDEX handyman_dispatch_release_one_active_idx
        ON handyman_dispatch_releases (execution_scope_id)
        WHERE status IN ('RELEASED', 'IN_PROGRESS');

      CREATE INDEX handyman_dispatch_release_client_idx
        ON handyman_dispatch_releases (client_id, released_at DESC);
    `);

    // Scope guard: the referenced assignment must be ACTIVE and belong to
    // the scope, and the appointment (when given) must be a CONFIRMED
    // EXECUTION visit for that scope.
    await client.query(`
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
          IF NOT ((OLD.status = 'RELEASED' AND NEW.status IN ('IN_PROGRESS','CANCELLED'))
                 OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))) THEN
            RAISE EXCEPTION 'Invalid dispatch release status transition' USING ERRCODE = '23514';
          END IF;
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'Dispatch release version must increment by 1' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER handyman_dispatch_release_guard_trigger
        BEFORE INSERT OR UPDATE ON handyman_dispatch_releases
        FOR EACH ROW EXECUTE FUNCTION handyman_dispatch_release_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_dispatch_release_guard_trigger ON handyman_dispatch_releases;
      DROP FUNCTION IF EXISTS handyman_dispatch_release_guard();
      DROP TABLE IF EXISTS handyman_dispatch_releases;
    `);
  },
};
