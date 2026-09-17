import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-06 RUN 2 — Handyman work sessions (field execution presence
 * windows) for the guarded execution start.
 *
 *   handyman_service_visits (BE-05 occurrence identity)
 *     → handyman_work_sessions (OPEN/CLOSED execution windows; the START
 *                               command's session fact + idempotency home)
 *
 * Governance decisions encoded here (CR-HM-BE-06 Run 2):
 * - A session is a VISIT-SCOPED EXECUTION WINDOW FACT — it never owns the
 *   vendor_work / work_order lifecycle (those transition exclusively through
 *   their owning BE-15B / BE-08C authorities in the post-commit seam), and
 *   it is NOT attendance, NOT billing, NOT payroll, NOT duration-as-money.
 *   No DELETED and no PAUSED state exists: history is append-only
 *   (OPEN → CLOSED is the only mutation; start facts are frozen).
 * - EXACTLY ONE OPEN SESSION PER VISIT (partial unique index). Multiple
 *   CLOSED sessions per visit over time are legal (a later legal execution
 *   window may start again).
 * - START-TIME SNAPSHOT: vendor_work_id and handyman_job_assignment_id are
 *   frozen at START (the composition/vendor work in force when the session
 *   opened). A later reassignment never rewrites history.
 * - CLOSURE INTEGRITY: OPEN ⇒ ended_at/ended_by_user_id NULL; CLOSED ⇒
 *   both populated and ended_at > started_at. Closure attribution
 *   (ended_by_user_id) records the actual closing actor — IDs only, no PII.
 * - SERVER-AUTHORITATIVE TIME: started_at/ended_at default to NOW() and are
 *   set exclusively by the service; occurred_at is the nullable
 *   client-claimed evidence timestamp carried by the established offline
 *   convention (Run-1 arrivals) and is never lifecycle authority.
 * - IDEMPOTENCY: (client_id, idempotency_key) unique + sha256 business-fact
 *   fingerprint, exactly the CR-HM-BE-01/Run-1 convention (same key + same
 *   facts converges; same key + different facts is a 409 at the service).
 */
export const migration0357CreateHandymanWorkSessions: Migration = {
  id: '0357_create_handyman_work_sessions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_work_sessions (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL,
        visit_id                    UUID NOT NULL,
        vendor_work_id              UUID NOT NULL,
        handyman_job_assignment_id  UUID NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'OPEN',
        started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_by_user_id          UUID NOT NULL,
        ended_at                    TIMESTAMPTZ,
        ended_by_user_id            UUID,
        occurred_at                 TIMESTAMPTZ,
        idempotency_key             TEXT NOT NULL,
        idempotency_fingerprint     TEXT NOT NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_work_sessions_status_check
          CHECK (status IN ('OPEN', 'CLOSED')),
        CONSTRAINT handyman_work_sessions_client_fk
          FOREIGN KEY (client_id) REFERENCES clients(id),
        CONSTRAINT handyman_work_sessions_visit_fk
          FOREIGN KEY (visit_id) REFERENCES handyman_service_visits(id),
        CONSTRAINT handyman_work_sessions_vendor_work_fk
          FOREIGN KEY (vendor_work_id) REFERENCES vendor_works(id),
        CONSTRAINT handyman_work_sessions_assignment_fk
          FOREIGN KEY (handyman_job_assignment_id)
            REFERENCES handyman_job_assignments(id),
        CONSTRAINT handyman_work_sessions_started_by_fk
          FOREIGN KEY (started_by_user_id) REFERENCES users(id),
        CONSTRAINT handyman_work_sessions_ended_by_fk
          FOREIGN KEY (ended_by_user_id) REFERENCES users(id)
      )
    `);

    // Idempotent start command (the Run-1 convention, client-scoped).
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_sessions_client_key_unique
        ON handyman_work_sessions (client_id, idempotency_key)
    `);

    // EXACTLY ONE OPEN SESSION PER VISIT. CLOSED history is unlimited.
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_sessions_visit_one_open_unique
        ON handyman_work_sessions (visit_id)
        WHERE status = 'OPEN'
    `);

    await client.query(`
      CREATE INDEX handyman_work_sessions_visit_status_idx
        ON handyman_work_sessions (visit_id, status)
    `);
    await client.query(`
      CREATE INDEX handyman_work_sessions_vendor_work_idx
        ON handyman_work_sessions (vendor_work_id)
    `);

    // Note: no updated_at trigger — the repository convention sets
    // `updated_at = NOW()` explicitly in the single guarded closure UPDATE.

    // Closure integrity + append-only start facts. The only legal UPDATE is
    // OPEN → CLOSED with closure attribution; every start-time fact
    // (identity, snapshot, server time, actor, evidence claim, idempotency
    // pair) is frozen at INSERT and structurally immutable afterwards.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_work_session_integrity()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.status = 'OPEN' THEN
          IF NEW.ended_at IS NOT NULL OR NEW.ended_by_user_id IS NOT NULL THEN
            RAISE EXCEPTION
              'HANDYMAN_WORK_SESSION_STATE_INVALID: open session % must not carry closure facts',
              NEW.id;
          END IF;
        ELSIF NEW.status = 'CLOSED' THEN
          IF NEW.ended_at IS NULL OR NEW.ended_by_user_id IS NULL THEN
            RAISE EXCEPTION
              'HANDYMAN_WORK_SESSION_STATE_INVALID: closed session % must carry closure attribution',
              NEW.id;
          END IF;
          IF NEW.ended_at <= NEW.started_at THEN
            RAISE EXCEPTION
              'HANDYMAN_WORK_SESSION_STATE_INVALID: closed session % must end after it started',
              NEW.id;
          END IF;
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF NEW.client_id <> OLD.client_id
            OR NEW.visit_id <> OLD.visit_id
            OR NEW.vendor_work_id <> OLD.vendor_work_id
            OR NEW.handyman_job_assignment_id <> OLD.handyman_job_assignment_id
            OR NEW.started_at <> OLD.started_at
            OR NEW.started_by_user_id <> OLD.started_by_user_id
            OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
            OR NEW.idempotency_key <> OLD.idempotency_key
            OR NEW.idempotency_fingerprint <> OLD.idempotency_fingerprint
            OR OLD.status <> 'OPEN'
            OR (NEW.ended_at IS NOT NULL AND OLD.ended_at IS NOT NULL)
          THEN
            RAISE EXCEPTION
              'HANDYMAN_WORK_SESSION_STATE_INVALID: work session % start facts and closure are append-only',
              NEW.id;
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TRIGGER handyman_work_session_integrity
        BEFORE INSERT OR UPDATE ON handyman_work_sessions
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_work_session_integrity()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_work_sessions');
    await client.query(
      'DROP FUNCTION IF EXISTS assert_handyman_work_session_integrity()',
    );
  },
};
