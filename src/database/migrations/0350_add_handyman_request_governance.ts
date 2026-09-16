import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-03 RUN 1 — Handyman Request governance foundation:
 * triage history, governed service selection, and inspection.
 *
 * Establishes the operational authority BEFORE any customer commerce:
 *
 *   Handyman Request → Triage History → Governed Service Selection
 *                    → optional Inspection → Inspection Completion
 *
 * Governance decisions encoded here (CR-HM-BE-03 governance + correction):
 * - `handyman_requests.status` is widened ADDITIVELY only (TRIAGED,
 *   INSPECTION_REQUIRED, INSPECTION_COMPLETED, QUOTATION_PENDING, APPROVED,
 *   QUOTATION_REJECTED). No mutable triage columns are added to the request;
 *   CR-HM-BE-01 fields, idempotency and cancel semantics (SUBMITTED →
 *   CANCELLED only) are untouched.
 * - `handyman_request_triages` is the append-only triage history authority:
 *   at most one ACTIVE decision per request (partial unique index); re-triage
 *   supersedes the prior ACTIVE row and inserts a new one — history is never
 *   overwritten or deleted (the CR-HM-BE-02 designation-history idiom).
 * - `handyman_request_services` is the FIRST authoritative request↔service
 *   binding, referencing the existing CR-BE-SVC-01 `service_catalog` through
 *   the composite `(service_catalog_id, client_id)` scope FK (0321 precedent)
 *   — same-client is proven structurally. At most one ACTIVE row per
 *   (request, service); multiple distinct services may be ACTIVE; superseded
 *   history is preserved. Free-text request fields never become service
 *   authority.
 * - `handyman_inspections` is a thin domain aggregate: at most one OPEN
 *   inspection per request (partial unique index), COMPLETED rows are
 *   immutable and carry diagnosis + scope. It reuses the existing BE-07
 *   checklist engine through an optional `checklist_execution_id` binding and
 *   creates NO checklist/evidence logic — evidence keeps flowing through the
 *   existing `evidence_submissions` (execution_type CHECKLIST_EXECUTION)
 *   foundation, which is deliberately NOT modified.
 * - Deliberately absent: quotations, revisions, lines, pricing, approvals,
 *   approval links, provider assignment, scheduling, execution, QC/BAST,
 *   invoice/payment, ledger, warranty (later CR-HM-BE-03 runs and CR-HM-BE-04+).
 *
 * RBAC permissions: `handyman_triage.manage`,
 * `handyman_request_service.manage`, `handyman_inspection.manage`,
 * bootstrapped to PLATFORM_ADMIN (the CR-HM-BE-01/02 pattern). Governed
 * reads reuse the existing `handyman_request.read`.
 */
export const migration0350AddHandymanRequestGovernance: Migration = {
  id: '0350_add_handyman_request_governance',

  async up(client: PoolClient): Promise<void> {
    // 1. Additive request lifecycle widening. The CR-HM-BE-01 statuses keep
    //    their exact semantics; cancel stays SUBMITTED → CANCELLED only
    //    (guarded in the BE-01 service, untouched here).
    await client.query(`
      ALTER TABLE handyman_requests
        DROP CONSTRAINT handyman_requests_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_requests
        ADD CONSTRAINT handyman_requests_status_check
        CHECK (status IN (
          'SUBMITTED',
          'CANCELLED',
          'TRIAGED',
          'INSPECTION_REQUIRED',
          'INSPECTION_COMPLETED',
          'QUOTATION_PENDING',
          'APPROVED',
          'QUOTATION_REJECTED'
        ))
    `);

    // 2. Append-only triage history: one ACTIVE decision per request.
    await client.query(`
      CREATE TABLE handyman_request_triages (
        id                    UUID PRIMARY KEY,
        request_id            UUID NOT NULL REFERENCES handyman_requests (id),
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        path                  TEXT NOT NULL,
        notes                 TEXT,
        triaged_by_user_id    UUID NOT NULL REFERENCES users (id),
        triaged_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        superseded_at         TIMESTAMPTZ,
        superseded_by_user_id UUID REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_request_triages_path_check
          CHECK (path IN ('QUOTATION', 'INSPECTION')),
        CONSTRAINT handyman_request_triages_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
        CONSTRAINT handyman_request_triages_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
        CONSTRAINT handyman_request_triages_history_check
          CHECK (
            (status = 'ACTIVE'
              AND superseded_at IS NULL AND superseded_by_user_id IS NULL)
            OR (status = 'SUPERSEDED'
              AND superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL)
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_request_triages_one_active_per_request
        ON handyman_request_triages (request_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_request_triages_request_idx
        ON handyman_request_triages (request_id, status, triaged_at DESC);
      CREATE INDEX handyman_request_triages_client_idx
        ON handyman_request_triages (client_id, status);
      CREATE INDEX handyman_request_triages_building_idx
        ON handyman_request_triages (building_id, status, triaged_at DESC)
    `);

    // 3. Governed request↔service selection: one ACTIVE row per
    //    (request, service); multiple distinct services may be ACTIVE.
    await client.query(`
      CREATE TABLE handyman_request_services (
        id                    UUID PRIMARY KEY,
        request_id            UUID NOT NULL REFERENCES handyman_requests (id),
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        service_catalog_id    UUID NOT NULL,
        selected_by_user_id   UUID NOT NULL REFERENCES users (id),
        selected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source                TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        superseded_at         TIMESTAMPTZ,
        superseded_by_user_id UUID REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_request_services_service_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
          REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_request_services_source_check
          CHECK (source IN ('TRIAGE', 'INSPECTION')),
        CONSTRAINT handyman_request_services_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
        CONSTRAINT handyman_request_services_history_check
          CHECK (
            (status = 'ACTIVE'
              AND superseded_at IS NULL AND superseded_by_user_id IS NULL)
            OR (status = 'SUPERSEDED'
              AND superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL)
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_request_services_one_active_per_request_service
        ON handyman_request_services (request_id, service_catalog_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_request_services_request_idx
        ON handyman_request_services (request_id, status, selected_at DESC);
      CREATE INDEX handyman_request_services_client_idx
        ON handyman_request_services (client_id, status);
      CREATE INDEX handyman_request_services_service_idx
        ON handyman_request_services (service_catalog_id, status);
      CREATE INDEX handyman_request_services_building_idx
        ON handyman_request_services (building_id, status)
    `);

    // 4. Thin inspection aggregate: one OPEN per request; COMPLETED is
    //    immutable; checklist reuse through an optional execution binding.
    await client.query(`
      CREATE TABLE handyman_inspections (
        id                     UUID PRIMARY KEY,
        request_id             UUID NOT NULL REFERENCES handyman_requests (id),
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        space_id               UUID NOT NULL REFERENCES spaces (id),
        status                 TEXT NOT NULL DEFAULT 'OPEN',
        diagnosis              TEXT,
        scope_notes            TEXT,
        checklist_execution_id UUID REFERENCES checklist_executions (id),
        opened_by_user_id      UUID NOT NULL REFERENCES users (id),
        opened_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        inspected_by_user_id   UUID REFERENCES users (id),
        inspected_at           TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_inspections_status_check
          CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED')),
        CONSTRAINT handyman_inspections_diagnosis_check
          CHECK (diagnosis IS NULL OR length(btrim(diagnosis)) BETWEEN 1 AND 4000),
        CONSTRAINT handyman_inspections_scope_notes_check
          CHECK (scope_notes IS NULL OR length(btrim(scope_notes)) BETWEEN 1 AND 2000),
        CONSTRAINT handyman_inspections_open_state_check
          CHECK (
            status <> 'OPEN'
            OR (diagnosis IS NULL AND scope_notes IS NULL
              AND inspected_by_user_id IS NULL AND inspected_at IS NULL)
          ),
        CONSTRAINT handyman_inspections_completed_state_check
          CHECK (
            status <> 'COMPLETED'
            OR (diagnosis IS NOT NULL AND scope_notes IS NOT NULL
              AND inspected_by_user_id IS NOT NULL AND inspected_at IS NOT NULL)
          ),
        CONSTRAINT handyman_inspections_cancelled_state_check
          CHECK (
            status <> 'CANCELLED'
            OR (inspected_by_user_id IS NULL AND inspected_at IS NULL)
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_inspections_one_open_per_request
        ON handyman_inspections (request_id)
        WHERE status = 'OPEN'
    `);
    await client.query(`
      CREATE INDEX handyman_inspections_request_idx
        ON handyman_inspections (request_id, status);
      CREATE INDEX handyman_inspections_client_idx
        ON handyman_inspections (client_id, status);
      CREATE INDEX handyman_inspections_building_idx
        ON handyman_inspections (building_id, status);
      CREATE INDEX handyman_inspections_checklist_execution_idx
        ON handyman_inspections (checklist_execution_id)
        WHERE checklist_execution_id IS NOT NULL
    `);

    // 5. Bootstrap permissions (CR-HM-BE-01/02 pattern).
    const perms: [string, string][] = [
      ['handyman_triage.manage', 'Triage Handyman Requests'],
      ['handyman_request_service.manage', 'Manage Handyman Request Services'],
      ['handyman_inspection.manage', 'Manage Handyman Inspections'],
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
    await client.query('DROP TABLE IF EXISTS handyman_inspections');
    await client.query('DROP TABLE IF EXISTS handyman_request_services');
    await client.query('DROP TABLE IF EXISTS handyman_request_triages');
    // Restore the CR-HM-BE-01 status universe (succeeds only when no rows
    // carry Run-1 lifecycle statuses — the safe downgrade direction).
    await client.query(`
      ALTER TABLE handyman_requests
        DROP CONSTRAINT handyman_requests_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_requests
        ADD CONSTRAINT handyman_requests_status_check
        CHECK (status IN ('SUBMITTED', 'CANCELLED'))
    `);
    // Note: permissions and role assignments are preserved on downgrade per
    // Asentra migration convention.
  },
};
