import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-05 RUN 1 — Handyman execution binding + provider/crew assignment
 * composition.
 *
 *   APPROVED handyman_request (+ APPROVED quotation, exact approved revision)
 *     → handyman_jobs (thin immutable identity/commercial binding)
 *       → work_orders (EXISTING BE-08 execution-lifecycle authority)
 *       → handyman_job_assignments (Handyman composition binding)
 *         → vendor_assignments (EXISTING BE-15A provider operational
 *           assignment)
 *         → handyman_work_crews (EXISTING CR-HM-BE-04 crew authority)
 *         → vendor_works (EXISTING BE-15B execution context, NOT_STARTED)
 *
 * Governance decisions encoded here (CR-HM-BE-05):
 * - NO second work-order lifecycle: `handyman_jobs` carries NO status
 *   column. Execution state authority stays on `work_orders.status` (BE-08C
 *   guarded transitions). The job row is immutable identity/commercial
 *   linkage only — no mutable job metadata, no provider_id, no crew_id, no
 *   schedule and no permit columns (visits/schedules/permit readiness are
 *   later runs/CRs).
 * - One job per approved request and one work order per job are STRUCTURAL
 *   (UNIQUE constraints), so business-identity idempotency and concurrency
 *   have a database authority; the work-order number is derived
 *   deterministically from the request number, making the existing
 *   (client, work_order_number) uniqueness the cross-process serialization
 *   point for job creation.
 * - The approved commercial binding is exact and immutable: the composite FK
 *   (handyman_quotation_revision_id, handyman_quotation_id) into
 *   handyman_quotation_revisions makes binding a foreign revision
 *   structurally impossible (the CR-HM-BE-03 approval idiom).
 * - NO second provider-assignment table: the composition row REFERENCES the
 *   existing BE-15A `vendor_assignments` row. BE-15A generally allows
 *   several vendors per work order; the HANDYMAN authority nevertheless
 *   guarantees exactly one ACTIVE provider+crew composition per job via the
 *   partial unique index below.
 * - Append-only assignment history: ACTIVE → SUPERSEDED with attribution,
 *   never deleted, never rewritten; state-consistency CHECKs pin the
 *   attribution shape.
 *
 * Cross-table rules the FKs cannot express live in the service layer:
 *   - request/quotation/approval must be APPROVED with the exact sent
 *     revision (CR-HM-BE-03 authority, consumed read-only),
 *   - work order client/building must equal the request's,
 *   - provider designation ACTIVE, vendor ACTIVE, ACTIVE
 *     vendor_building_relationship for the work order's building (BE-06D),
 *     and every ACTIVE governed request service covered by the provider's
 *     BE-06E/CR-HM-BE-02 eligibility authority — all revalidated at TIME OF
 *     USE,
 *   - crew ACTIVE, belonging to the selected provider, with exactly one
 *     valid ACTIVE Lead Worker and every ACTIVE member passing the CR-HM-BE-04
 *     worker chain (binding ACTIVE, EXTERNAL profile ACTIVE, same
 *     vendor/client),
 *   - assignment/reassignment only while the work order is in a
 *     pre-execution state (OPEN/ASSIGNED) and the current vendor work (if
 *     any) is NOT_STARTED.
 *
 * RBAC permissions: `handyman_job.read`, `handyman_job.manage`,
 * `handyman_job_assignment.read`, `handyman_job_assignment.manage`,
 * bootstrapped to PLATFORM_ADMIN (the CR-HM-BE-02/04 pattern).
 */
export const migration0354CreateHandymanJobs: Migration = {
  id: '0354_create_handyman_jobs',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_jobs (
        id                           UUID PRIMARY KEY,
        client_id                    UUID NOT NULL,
        handyman_request_id          UUID NOT NULL,
        handyman_quotation_id        UUID NOT NULL,
        handyman_quotation_revision_id UUID NOT NULL,
        work_order_id                UUID NOT NULL,
        created_by_user_id           UUID NOT NULL,
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_jobs_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_jobs_handyman_request_id_fkey
          FOREIGN KEY (handyman_request_id) REFERENCES handyman_requests (id),
        CONSTRAINT handyman_jobs_handyman_quotation_id_fkey
          FOREIGN KEY (handyman_quotation_id) REFERENCES handyman_quotations (id),
        CONSTRAINT handyman_jobs_revision_scope_fk
          FOREIGN KEY (handyman_quotation_revision_id, handyman_quotation_id)
          REFERENCES handyman_quotation_revisions (id, quotation_id),
        CONSTRAINT handyman_jobs_work_order_id_fkey
          FOREIGN KEY (work_order_id) REFERENCES work_orders (id),
        CONSTRAINT handyman_jobs_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users (id),
        -- One job per approved request (business-identity idempotency).
        CONSTRAINT handyman_jobs_request_unique
          UNIQUE (handyman_request_id),
        -- One work order per job (and one job per work order).
        CONSTRAINT handyman_jobs_work_order_unique
          UNIQUE (work_order_id)
      )
    `);
    await client.query(
      `CREATE INDEX handyman_jobs_client_idx
         ON handyman_jobs (client_id, created_at DESC)`,
    );

    await client.query(`
      CREATE TABLE handyman_job_assignments (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL,
        handyman_job_id        UUID NOT NULL,
        vendor_assignment_id   UUID NOT NULL,
        handyman_work_crew_id  UUID NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        assigned_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        assigned_by_user_id    UUID NOT NULL,
        superseded_at          TIMESTAMPTZ,
        superseded_by_user_id  UUID,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_job_assignments_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_job_assignments_job_id_fkey
          FOREIGN KEY (handyman_job_id) REFERENCES handyman_jobs (id),
        CONSTRAINT handyman_job_assignments_vendor_assignment_id_fkey
          FOREIGN KEY (vendor_assignment_id) REFERENCES vendor_assignments (id),
        CONSTRAINT handyman_job_assignments_crew_id_fkey
          FOREIGN KEY (handyman_work_crew_id) REFERENCES handyman_work_crews (id),
        CONSTRAINT handyman_job_assignments_assigned_by_user_id_fkey
          FOREIGN KEY (assigned_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_job_assignments_superseded_by_user_id_fkey
          FOREIGN KEY (superseded_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_job_assignments_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
        -- Append-only history: an ACTIVE composition carries no supersede
        -- attribution; a SUPERSEDED row is fully attributed, closed
        -- evidence.
        CONSTRAINT handyman_job_assignments_active_state_check
          CHECK (
            status <> 'ACTIVE'
            OR (superseded_at IS NULL AND superseded_by_user_id IS NULL)
          ),
        CONSTRAINT handyman_job_assignments_superseded_state_check
          CHECK (
            status <> 'SUPERSEDED'
            OR (superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL)
          )
      )
    `);
    // Exactly one ACTIVE Handyman provider+crew composition per job;
    // SUPERSEDED history is retained (the partial-unique idiom).
    await client.query(`
      CREATE UNIQUE INDEX handyman_job_assignments_one_active_per_job
        ON handyman_job_assignments (handyman_job_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(
      `CREATE INDEX handyman_job_assignments_job_idx
         ON handyman_job_assignments (handyman_job_id, status)`,
    );
    await client.query(
      `CREATE INDEX handyman_job_assignments_crew_idx
         ON handyman_job_assignments (handyman_work_crew_id, status)`,
    );
    await client.query(
      `CREATE INDEX handyman_job_assignments_vendor_assignment_idx
         ON handyman_job_assignments (vendor_assignment_id)`,
    );

    // Bootstrap permissions (the 0349/0353 pattern).
    const perms: [string, string][] = [
      ['handyman_job.read', 'Read Handyman Jobs'],
      ['handyman_job.manage', 'Manage Handyman Jobs'],
      ['handyman_job_assignment.read', 'Read Handyman Job Assignments'],
      ['handyman_job_assignment.manage', 'Manage Handyman Job Assignments'],
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
    await client.query('DROP TABLE IF EXISTS handyman_job_assignments');
    await client.query('DROP TABLE IF EXISTS handyman_jobs');
    // Note: permissions and role assignments are preserved on downgrade per
    // Asentra migration convention.
  },
};
