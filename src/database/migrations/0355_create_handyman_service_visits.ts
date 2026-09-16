import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-05 RUN 2 — Handyman service visit identity + versioned schedule
 * windows.
 *
 *   handyman_jobs (Run 1 thin binding, one ACTIVE composition)
 *     → handyman_service_visits        (occurrence identity, sequenced)
 *       → handyman_service_visit_schedules (versioned planned windows)
 *
 * Governance decisions encoded here (CR-HM-BE-05 Run 2):
 * - VISIT AUTHORITY: a visit is an OCCURRENCE IDENTITY with minimal state —
 *   NO arrival/check-in/out columns, NO GPS/QR/device columns, NO actual
 *   labor timestamps, and NO visit status column. A "cancelled visit" is not
 *   a separate state: it is exactly a visit whose schedule history closed
 *   with CANCELLED and has no ACTIVE successor (a superseded schedule always
 *   has one), so cancellation is derivable from the schedule authority and
 *   no mirrored state exists. Provider/crew are NEVER copied onto the visit:
 *   the authoritative composition resolves from the job
 *   (handyman_job_assignments ACTIVE row).
 * - Sequence authority: visit_sequence is unique per job (structural) and
 *   generated server-side under the Run-1 job-row lock, so concurrent visit
 *   creation cannot duplicate a sequence.
 * - SCHEDULE AUTHORITY: planned windows are VERSIONED rows, never a mutable
 *   timestamp on the job/work order. Reschedule closes ACTIVE → SUPERSEDED
 *   (the old window is never mutated) and inserts a new ACTIVE row; cancel
 *   closes ACTIVE → CANCELLED. Exactly one ACTIVE schedule per visit is a
 *   partial unique index; history is append-only (no DELETE authority) and
 *   closure attribution is pinned by state CHECKs.
 * - Half-open windows: planned_end_at > planned_start_at is structural, and
 *   temporal conflict detection uses the repository's established
 *   tstzrange(..., '[)') half-open interval idiom (0319/0333), so
 *   back-to-back windows (09:00–10:00 vs 10:00–11:00) do NOT overlap.
 *   Deliberately NO GiST EXCLUDE constraint: the conflicting party is the
 *   crew/worker set resolved dynamically through the job's ACTIVE
 *   composition (never copied onto schedule rows), which an exclusion
 *   constraint on static columns cannot express. Race safety comes from the
 *   documented deterministic row-lock strategy in the service (job → visit →
 *   crew → sorted worker bindings) instead.
 * - Permit readiness stays on the EXISTING BE-15D authority
 *   (vendor_assignment → vendor_work → work_permit_readiness): NO Handyman
 *   permit table, NO permit lifecycle vocabulary here.
 *
 * Cross-table rules the FKs cannot express live in the service layer:
 *   schedule-time revalidation of the job (work order pre-execution, ACTIVE
 *   composition), provider (designation/vendor/relationship/capability
 *   eligibility) and crew (ACTIVE, provider match, valid lead, full CR04
 *   worker chain) authorities at TIME OF USE; temporal crew and shared-worker
 *   conflict rejection against other jobs' ACTIVE schedules.
 *
 * RBAC permissions: `handyman_service_visit.read`,
 * `handyman_service_visit.manage`, bootstrapped to PLATFORM_ADMIN (the
 * 0353/0354 pattern).
 */
export const migration0355CreateHandymanServiceVisits: Migration = {
  id: '0355_create_handyman_service_visits',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_service_visits (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL,
        handyman_job_id      UUID NOT NULL,
        visit_sequence       INTEGER NOT NULL,
        created_by_user_id   UUID NOT NULL,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_service_visits_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_service_visits_handyman_job_id_fkey
          FOREIGN KEY (handyman_job_id) REFERENCES handyman_jobs (id),
        CONSTRAINT handyman_service_visits_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_service_visits_sequence_check
          CHECK (visit_sequence >= 1),
        -- Server-side sequence authority: unique per job (concurrency
        -- backstop for the job-row-locked max+1 generation).
        CONSTRAINT handyman_service_visits_job_sequence_unique
          UNIQUE (handyman_job_id, visit_sequence)
      )
    `);
    await client.query(
      `CREATE INDEX handyman_service_visits_client_idx
         ON handyman_service_visits (client_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX handyman_service_visits_job_idx
         ON handyman_service_visits (handyman_job_id, visit_sequence)`,
    );

    await client.query(`
      CREATE TABLE handyman_service_visit_schedules (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL,
        handyman_service_visit_id   UUID NOT NULL,
        planned_start_at            TIMESTAMPTZ NOT NULL,
        planned_end_at              TIMESTAMPTZ NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id          UUID NOT NULL,
        superseded_at               TIMESTAMPTZ,
        superseded_by_user_id       UUID,
        cancelled_at                TIMESTAMPTZ,
        cancelled_by_user_id        UUID,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_service_visit_schedules_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_service_visit_schedules_visit_id_fkey
          FOREIGN KEY (handyman_service_visit_id)
          REFERENCES handyman_service_visits (id),
        CONSTRAINT handyman_service_visit_schedules_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_service_visit_schedules_superseded_by_user_id_fkey
          FOREIGN KEY (superseded_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_service_visit_schedules_cancelled_by_user_id_fkey
          FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_service_visit_schedules_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'CANCELLED')),
        -- A planned window is a real interval (half-open '[)' semantics are
        -- applied at conflict time; equality is never a window).
        CONSTRAINT handyman_service_visit_schedules_window_check
          CHECK (planned_end_at > planned_start_at),
        -- Append-only closure attribution: ACTIVE carries no closure fields;
        -- SUPERSEDED is fully supersede-attributed (and never cancel-
        -- attributed); CANCELLED is fully cancel-attributed (and never
        -- supersede-attributed).
        CONSTRAINT handyman_service_visit_schedules_active_state_check
          CHECK (
            status <> 'ACTIVE'
            OR (
              superseded_at IS NULL AND superseded_by_user_id IS NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
            )
          ),
        CONSTRAINT handyman_service_visit_schedules_superseded_state_check
          CHECK (
            status <> 'SUPERSEDED'
            OR (
              superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
            )
          ),
        CONSTRAINT handyman_service_visit_schedules_cancelled_state_check
          CHECK (
            status <> 'CANCELLED'
            OR (
              cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
              AND superseded_at IS NULL AND superseded_by_user_id IS NULL
            )
          )
      )
    `);
    // Exactly one ACTIVE schedule per visit; superseded/cancelled history is
    // retained (the partial-unique idiom).
    await client.query(`
      CREATE UNIQUE INDEX handyman_service_visit_schedules_one_active_per_visit
        ON handyman_service_visit_schedules (handyman_service_visit_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(
      `CREATE INDEX handyman_service_visit_schedules_visit_idx
         ON handyman_service_visit_schedules (handyman_service_visit_id, status)`,
    );
    // Overlap-scan support: ACTIVE windows by time (the half-open range
    // predicate filters on these bounds).
    await client.query(`
      CREATE INDEX handyman_service_visit_schedules_active_window_idx
        ON handyman_service_visit_schedules (planned_start_at, planned_end_at)
        WHERE status = 'ACTIVE'
    `);

    // Bootstrap permissions (the 0353/0354 pattern).
    const perms: [string, string][] = [
      ['handyman_service_visit.read', 'Read Handyman Service Visits'],
      ['handyman_service_visit.manage', 'Manage Handyman Service Visits'],
    ];

    for (const [code, name] of perms) {
      await client.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }

    const roleResult = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN'`,
    );
    const roleId = roleResult.rows[0]?.id;
    if (roleId) {
      for (const [code] of perms) {
        const permResult = await client.query<{ id: string }>(
          `SELECT id FROM permissions WHERE code = $1`,
          [code],
        );
        const permId = permResult.rows[0]?.id;
        if (permId) {
          await client.query(
            `INSERT INTO role_permission_assignments (id, role_id, permission_id, status)
             SELECT $1, $2, $3, 'ACTIVE'
             WHERE NOT EXISTS (
               SELECT 1 FROM role_permission_assignments
               WHERE role_id = $2 AND permission_id = $3 AND status = 'ACTIVE'
             )`,
            [randomUUID(), roleId, permId],
          );
        }
      }
    }
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_service_visit_schedules');
    await client.query('DROP TABLE IF EXISTS handyman_service_visits');
    // Note: permissions and role assignments are preserved on downgrade per
    // Asentra migration convention.
  },
};
