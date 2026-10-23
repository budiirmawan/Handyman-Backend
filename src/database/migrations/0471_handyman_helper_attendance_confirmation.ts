import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-EXPENSE-HELPER-01 PART 02 — Konfirmasi Kehadiran Helper.
 *
 * Establishes dedicated, governed persistence for:
 *   1. `handyman_scope_helper_personnel_changes`: Operations-authorized
 *      per-Execution-Scope / Work-Order helper roster exceptions
 *      (`ADD_HELPER`, `SUBSTITUTE_HELPER`, `REMOVE_HELPER`), preserving
 *      login-less Helpers (`target_helper_user_id` / `replaced_helper_user_id`
 *      nullable) and append-only immutability.
 *   2. `handyman_helper_attendance_confirmations`: Explicit verified
 *      per-Helper attendance state (`HADIR` | `TIDAK_HADIR`) bound to
 *      canonical `client_id`, `building_id`, `handyman_request_id`,
 *      `execution_scope_id`, optional `work_order_id` (`REFERENCES work_orders(id)`),
 *      `assignment_id`, and `work_session_id`.
 *      `handyman_work_session_helper_presence` (0401) remains strictly an
 *      unverified roster snapshot and is NEVER treated as verified attendance.
 *   3. `handyman_helper_attendance_events`: Append-only immutable audit and
 *      correction history capturing timestamp, confirming/authorizing actor,
 *      Work Order / Execution Scope, session, previous/new status, and
 *      mandatory correction reason on any post-initial modification.
 *
 * Non-coupling invariant: ZERO fee, rate, wage, billable, or financial
 * entitlement columns or triggers exist here — attendance confirmation never
 * turns into automatic fee approval.
 */
export const migration0471HandymanHelperAttendanceConfirmation: Migration = {
  id: '0471_handyman_helper_attendance_confirmation',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_scope_helper_personnel_changes (
        id                        UUID PRIMARY KEY,
        client_id                 UUID NOT NULL REFERENCES clients (id),
        building_id               UUID NOT NULL REFERENCES buildings (id),
        handyman_request_id       UUID NOT NULL REFERENCES handyman_service_requests (id),
        execution_scope_id        UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        work_order_id             UUID REFERENCES work_orders (id),
        assignment_id             UUID NOT NULL REFERENCES handyman_execution_scope_assignments (id),
        crew_id                   UUID NOT NULL REFERENCES handyman_work_crews (id),
        work_session_id           UUID REFERENCES handyman_work_sessions (id),
        change_type               TEXT NOT NULL,
        target_helper_worker_id   UUID REFERENCES handyman_worker_contexts (id),
        target_helper_user_id     UUID REFERENCES users (id),
        replaced_helper_worker_id UUID REFERENCES handyman_worker_contexts (id),
        replaced_helper_user_id   UUID REFERENCES users (id),
        reason                    TEXT NOT NULL,
        authorized_by_user_id     UUID NOT NULL REFERENCES users (id),
        authorized_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        idempotency_key           TEXT NOT NULL,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT hm_scope_helper_change_type_check
          CHECK (change_type IN ('ADD_HELPER', 'SUBSTITUTE_HELPER', 'REMOVE_HELPER')),
        CONSTRAINT hm_scope_helper_change_reason_check
          CHECK (length(btrim(reason)) > 0),
        CONSTRAINT hm_scope_helper_change_shape_check
          CHECK (
            (change_type = 'ADD_HELPER'
              AND target_helper_worker_id IS NOT NULL
              AND replaced_helper_worker_id IS NULL)
            OR (change_type = 'REMOVE_HELPER'
              AND target_helper_worker_id IS NULL
              AND replaced_helper_worker_id IS NOT NULL)
            OR (change_type = 'SUBSTITUTE_HELPER'
              AND target_helper_worker_id IS NOT NULL
              AND replaced_helper_worker_id IS NOT NULL
              AND target_helper_worker_id <> replaced_helper_worker_id)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX hm_scope_helper_changes_idem_idx
        ON handyman_scope_helper_personnel_changes (execution_scope_id, idempotency_key)
    `);

    await client.query(`
      CREATE INDEX hm_scope_helper_changes_scope_assignment_idx
        ON handyman_scope_helper_personnel_changes (execution_scope_id, assignment_id, authorized_at, id)
    `);

    await client.query(`
      CREATE TABLE handyman_helper_attendance_confirmations (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        handyman_request_id      UUID NOT NULL REFERENCES handyman_service_requests (id),
        execution_scope_id       UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        work_order_id            UUID REFERENCES work_orders (id),
        assignment_id            UUID NOT NULL REFERENCES handyman_execution_scope_assignments (id),
        work_session_id          UUID NOT NULL REFERENCES handyman_work_sessions (id),
        helper_worker_id         UUID NOT NULL REFERENCES handyman_worker_contexts (id),
        helper_user_id           UUID REFERENCES users (id),
        roster_source            TEXT NOT NULL,
        personnel_change_id      UUID REFERENCES handyman_scope_helper_personnel_changes (id),
        attendance_status        TEXT NOT NULL,
        confirmed_by_user_id     UUID NOT NULL REFERENCES users (id),
        confirmed_by_worker_id   UUID REFERENCES handyman_worker_contexts (id),
        first_confirmed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_confirmed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        confirmation_count       INTEGER NOT NULL DEFAULT 1,
        latest_notes             TEXT,
        latest_correction_reason TEXT,
        version                  INTEGER NOT NULL DEFAULT 1,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT hm_helper_att_roster_source_check
          CHECK (roster_source IN (
            'CREW_ROSTER',
            'OPERATIONS_ADDITION',
            'OPERATIONS_SUBSTITUTION'
          )),
        CONSTRAINT hm_helper_att_status_check
          CHECK (attendance_status IN ('HADIR', 'TIDAK_HADIR')),
        CONSTRAINT hm_helper_att_count_check
          CHECK (confirmation_count >= 1),
        CONSTRAINT hm_helper_att_version_check
          CHECK (version >= 1),
        CONSTRAINT hm_helper_att_session_helper_uniq
          UNIQUE (work_session_id, helper_worker_id)
      )
    `);

    await client.query(`
      CREATE INDEX hm_helper_att_confirmations_scope_idx
        ON handyman_helper_attendance_confirmations (execution_scope_id, work_session_id, created_at)
    `);

    await client.query(`
      CREATE INDEX hm_helper_att_confirmations_wo_idx
        ON handyman_helper_attendance_confirmations (work_order_id, attendance_status)
        WHERE work_order_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE handyman_helper_attendance_events (
        id                  UUID PRIMARY KEY,
        confirmation_id     UUID NOT NULL REFERENCES handyman_helper_attendance_confirmations (id),
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        handyman_request_id UUID NOT NULL REFERENCES handyman_service_requests (id),
        execution_scope_id  UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        work_order_id       UUID REFERENCES work_orders (id),
        work_session_id     UUID NOT NULL REFERENCES handyman_work_sessions (id),
        helper_worker_id    UUID NOT NULL REFERENCES handyman_worker_contexts (id),
        helper_user_id      UUID REFERENCES users (id),
        event_type          TEXT NOT NULL,
        previous_status     TEXT,
        new_status          TEXT NOT NULL,
        notes               TEXT,
        correction_reason   TEXT,
        actor_user_id       UUID NOT NULL REFERENCES users (id),
        actor_worker_id     UUID REFERENCES handyman_worker_contexts (id),
        actor_role          TEXT NOT NULL,
        idempotency_key     TEXT NOT NULL,
        occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT hm_helper_att_event_type_check
          CHECK (event_type IN (
            'INITIAL_CONFIRMATION',
            'STATUS_CORRECTION',
            'ROSTER_REMOVED_SUPERSEDED'
          )),
        CONSTRAINT hm_helper_att_event_prev_status_check
          CHECK (previous_status IS NULL OR previous_status IN ('HADIR', 'TIDAK_HADIR')),
        CONSTRAINT hm_helper_att_event_new_status_check
          CHECK (new_status IN ('HADIR', 'TIDAK_HADIR')),
        CONSTRAINT hm_helper_att_event_actor_role_check
          CHECK (actor_role IN ('CREW_LEAD', 'OPERATIONS')),
        CONSTRAINT hm_helper_att_event_correction_check
          CHECK (
            (event_type = 'INITIAL_CONFIRMATION' AND previous_status IS NULL)
            OR (
              event_type IN ('STATUS_CORRECTION', 'ROSTER_REMOVED_SUPERSEDED')
              AND previous_status IS NOT NULL
              AND correction_reason IS NOT NULL
              AND length(btrim(correction_reason)) > 0
            )
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX hm_helper_att_events_idem_idx
        ON handyman_helper_attendance_events (work_session_id, helper_worker_id, idempotency_key)
    `);

    await client.query(`
      CREATE INDEX hm_helper_att_events_scope_idx
        ON handyman_helper_attendance_events (execution_scope_id, occurred_at, id)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_helper_attendance_append_only()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman helper attendance audit history and personnel change records are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TRIGGER hm_scope_helper_changes_immutable
        BEFORE UPDATE OR DELETE ON handyman_scope_helper_personnel_changes
        FOR EACH ROW
        EXECUTE FUNCTION handyman_helper_attendance_append_only();
    `);

    await client.query(`
      CREATE TRIGGER hm_helper_att_events_immutable
        BEFORE UPDATE OR DELETE ON handyman_helper_attendance_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_helper_attendance_append_only();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_helper_attendance_confirmation_no_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman helper attendance confirmation records cannot be deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TRIGGER hm_helper_att_confirmations_no_delete
        BEFORE DELETE ON handyman_helper_attendance_confirmations
        FOR EACH ROW
        EXECUTE FUNCTION handyman_helper_attendance_confirmation_no_delete();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS hm_helper_att_confirmations_no_delete
        ON handyman_helper_attendance_confirmations;
      DROP TRIGGER IF EXISTS hm_helper_att_events_immutable
        ON handyman_helper_attendance_events;
      DROP TRIGGER IF EXISTS hm_scope_helper_changes_immutable
        ON handyman_scope_helper_personnel_changes;
      DROP FUNCTION IF EXISTS handyman_helper_attendance_confirmation_no_delete;
      DROP FUNCTION IF EXISTS handyman_helper_attendance_append_only;
      DROP TABLE IF EXISTS handyman_helper_attendance_events;
      DROP TABLE IF EXISTS handyman_helper_attendance_confirmations;
      DROP TABLE IF EXISTS handyman_scope_helper_personnel_changes;
    `);
  },
};
