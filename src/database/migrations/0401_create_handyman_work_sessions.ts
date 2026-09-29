import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-08 Work Session & Field Execution PART 01 — work-session
 * persistence foundation ONLY (FROZEN governance
 * `CR-HM-08_START_GOVERNANCE.md` §5/§6/§7/§11).
 *
 * THREE tables: the session projection, the append-only transition
 * event stream, and the append-only helper-presence snapshot store.
 * NO session commands, NO arrival gate logic, NO HTTP/OpenAPI, NO
 * billing/material/QC/BAST/payment/warranty fields, NO FM work_order
 * FK or state (firewall §12). Helper presence rows are
 * server-derived in later PARTs from CURRENT crew membership — the
 * schema accepts NO helper runtime input and NO billable flag/rate/
 * duration (§6/§7).
 *
 * Invariants (DB-enforced):
 *   1. execution_scope_id FKs handyman_execution_scopes ONLY;
 *      assignment_id FKs handyman_execution_scope_assignments;
 *      lead_worker_id FKs handyman_worker_contexts; lead_user_id /
 *      actor_user_id FK users;
 *   2. client_id structurally consistent with scope + assignment
 *      (same consistency-trigger pattern as 0396/0397);
 *   3. at most ONE non-CHECKED_OUT session per execution_scope_id —
 *      CHECKED_OUT is the only terminal state (governance §5);
 *   4. timestamp columns obey the lifecycle: started_work_at implies
 *      the work clock has opened, completed_at implies COMPLETED or
 *      CHECKED_OUT, checked_out_at implies CHECKED_OUT;
 *   5. events are the append-only source of truth: exactly seven
 *      event types; UNIQUE (session_id, event_type, idempotency_key)
 *      idempotency boundary (governance §11); ALL UPDATE/DELETE
 *      blocked; event client/scope must equal the session's;
 *   6. helper-presence snapshots are append-only: ALL UPDATE/DELETE
 *      blocked; client/scope consistent with the parent session.
 */
export const migration0401CreateHandymanWorkSessions: Migration = {
  id: '0401_create_handyman_work_sessions',
  async up(client: PoolClient): Promise<void> {
    // ---- SESSION projection ------------------------------------
    await client.query(`
      CREATE TABLE handyman_work_sessions (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        assignment_id      UUID NOT NULL
          REFERENCES handyman_execution_scope_assignments (id),
        lead_worker_id     UUID NOT NULL
          REFERENCES handyman_worker_contexts (id),
        lead_user_id       UUID NOT NULL
          REFERENCES users (id),
        status             TEXT NOT NULL DEFAULT 'CHECKED_IN',
        checked_in_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_work_at    TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ,
        checked_out_at     TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_work_sessions_status_check
          CHECK (status IN (
            'CHECKED_IN', 'IN_PROGRESS', 'PAUSED',
            'MATERIAL_RUN', 'COMPLETED', 'CHECKED_OUT')),
        CONSTRAINT handyman_work_sessions_started_work_at_check
          CHECK (started_work_at IS NULL OR status <> 'CHECKED_IN'),
        CONSTRAINT handyman_work_sessions_completed_at_check
          CHECK (completed_at IS NULL
                 OR status IN ('COMPLETED', 'CHECKED_OUT')),
        CONSTRAINT handyman_work_sessions_checked_out_at_check
          CHECK (checked_out_at IS NULL OR status = 'CHECKED_OUT')
      )
    `);
    // Invariant 3: one ACTIVE (non-terminal) session per scope —
    // CHECKED_OUT rows are excluded so later sessions are legal.
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_sessions_one_active_idx
        ON handyman_work_sessions (execution_scope_id)
        WHERE status <> 'CHECKED_OUT'
    `);
    await client.query(`
      CREATE INDEX handyman_work_sessions_scope_idx
        ON handyman_work_sessions (execution_scope_id, created_at)
    `);

    // ---- EVENT stream (append-only) -----------------------------
    await client.query(`
      CREATE TABLE handyman_work_session_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        session_id         UUID NOT NULL
          REFERENCES handyman_work_sessions (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        event_type         TEXT NOT NULL,
        idempotency_key    TEXT NOT NULL,
        occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_user_id      UUID NOT NULL
          REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_work_session_events_type_check
          CHECK (event_type IN (
            'CHECK_IN', 'START_WORK', 'PAUSE', 'MATERIAL_RUN',
            'RESUME', 'COMPLETE', 'CHECK_OUT'))
      )
    `);
    // Invariant 5: idempotency boundary is the (session, action) pair
    // — replay of the same transition key returns the SAME row; a new
    // action may reuse the key only under its own event_type.
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_session_events_idem_idx
        ON handyman_work_session_events
        (session_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_work_session_events_session_idx
        ON handyman_work_session_events (session_id, occurred_at)
    `);

    // ---- HELPER presence snapshot (append-only) -----------------
    await client.query(`
      CREATE TABLE handyman_work_session_helper_presence (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        session_id         UUID NOT NULL
          REFERENCES handyman_work_sessions (id),
        event_id           UUID NOT NULL
          REFERENCES handyman_work_session_events (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        helper_worker_id   UUID NOT NULL
          REFERENCES handyman_worker_contexts (id),
        helper_user_id     UUID
          REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX handyman_ws_helper_presence_session_idx
        ON handyman_work_session_helper_presence (session_id, event_id)
    `);

    // ---- Client/binding consistency -----------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_work_session_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client      UUID;
        assignment_client UUID;
      BEGIN
        SELECT client_id INTO scope_client
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        SELECT client_id INTO assignment_client
          FROM handyman_execution_scope_assignments
          WHERE id = NEW.assignment_id;
        IF scope_client IS NULL OR assignment_client IS NULL THEN
          -- Absent referents fall through to the FK constraints.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client
           OR NEW.client_id IS DISTINCT FROM assignment_client THEN
          RAISE EXCEPTION
            'Handyman work session client_id must match the execution scope and assignment client (cross-client binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_work_session_client_check
        BEFORE INSERT OR UPDATE ON handyman_work_sessions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_work_session_client_consistency();
    `);

    // Event/presence rows must sit INSIDE the parent session: the
    // client AND the scope must equal the session's (never merely
    // "some consistent triple").
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_work_session_child_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client UUID;
        parent_scope  UUID;
      BEGIN
        SELECT client_id, execution_scope_id
          INTO parent_client, parent_scope
          FROM handyman_work_sessions
          WHERE id = NEW.session_id;
        IF parent_client IS NULL THEN
          -- Absent parent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client
           OR NEW.execution_scope_id IS DISTINCT FROM parent_scope THEN
          RAISE EXCEPTION
            'Handyman work session child row must share the session client and execution scope (cross-session/cross-scope binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_work_session_event_child_check
        BEFORE INSERT OR UPDATE ON handyman_work_session_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_work_session_child_consistency();
    `);
    await client.query(`
      CREATE TRIGGER handyman_ws_helper_presence_child_check
        BEFORE INSERT OR UPDATE ON handyman_work_session_helper_presence
        FOR EACH ROW
        EXECUTE FUNCTION handyman_work_session_child_consistency();
    `);

    // ---- Immutability -------------------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_work_session_event_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman work session events are append-only: history rows cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_work_session_event_no_write
        BEFORE UPDATE OR DELETE ON handyman_work_session_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_work_session_event_block_mutation();
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_ws_helper_presence_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman work session helper presence snapshots are append-only: history rows cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_ws_helper_presence_no_write
        BEFORE UPDATE OR DELETE ON handyman_work_session_helper_presence
        FOR EACH ROW
        EXECUTE FUNCTION handyman_ws_helper_presence_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_ws_helper_presence_no_write
        ON handyman_work_session_helper_presence;
      DROP TRIGGER IF EXISTS handyman_work_session_event_no_write
        ON handyman_work_session_events;
      DROP TRIGGER IF EXISTS handyman_ws_helper_presence_child_check
        ON handyman_work_session_helper_presence;
      DROP TRIGGER IF EXISTS handyman_work_session_event_child_check
        ON handyman_work_session_events;
      DROP TRIGGER IF EXISTS handyman_work_session_client_check
        ON handyman_work_sessions;
      DROP FUNCTION IF EXISTS
        handyman_ws_helper_presence_block_mutation;
      DROP FUNCTION IF EXISTS
        handyman_work_session_event_block_mutation;
      DROP FUNCTION IF EXISTS
        handyman_work_session_child_consistency;
      DROP FUNCTION IF EXISTS
        handyman_work_session_client_consistency;
      DROP TABLE IF EXISTS handyman_work_session_helper_presence;
      DROP TABLE IF EXISTS handyman_work_session_events;
      DROP TABLE IF EXISTS handyman_work_sessions;
    `);
  },
};
