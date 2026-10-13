import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-DB-OPT-01 PART 01 — evidence-backed composite indexes.
 *
 * Every index below is derived from an EXISTING query callsite (no
 * speculative columns, no Request↔WorkOrder linkage). Each CREATE runs
 * CONCURRENTLY so production builds never take a long write-blocking lock;
 * this migration is therefore `transactional: false` (the runner executes it
 * outside any transaction block and verifies index validity before recording
 * it as applied).
 *
 * Query evidence:
 *
 *  1. handyman_service_requests (client_id, created_at, id)
 *     - handyman-service-request.repository.ts `listCustomerCareProjectionsScoped`
 *       / `listWorkspaceProjectionsScoped`: WHERE r.client_id = $1
 *       [AND tenant/building/space/attribution/status …]
 *       ORDER BY r.created_at ASC, r.id ASC [LIMIT/OFFSET keyset]
 *     - Operations queue source list (bounded limit ≤ 50).
 *
 *  2. handyman_visit_appointments (client_id, handyman_request_id, created_at DESC, id DESC)
 *     - handyman-appointment.repository.ts `listHandymanVisitAppointments`:
 *       WHERE client_id = $1 AND handyman_request_id = $2
 *       ORDER BY created_at DESC, id DESC. The existing
 *       (client_id, handyman_request_id, kind, created_at DESC) index cannot
 *       provide this order (kind sits between the filter and sort keys).
 *
 *  3. handyman_execution_scope_assignments (execution_scope_id, assigned_at DESC, id DESC)
 *     - handyman-sla-status-api.service.ts assignment stage:
 *       WHERE execution_scope_id = $1
 *       ORDER BY (status = 'ACTIVE') DESC, assigned_at DESC, id DESC.
 *     - The existing partial unique (execution_scope_id) WHERE status='ACTIVE'
 *       only covers the single ACTIVE row, not the historical rows.
 *
 *  4. handyman_arrival_verification_results (execution_scope_id, evaluated_at DESC, created_at DESC, id DESC)
 *     - handyman-sla-status-api.service.ts arrival stage:
 *       WHERE execution_scope_id = $1
 *       ORDER BY evaluated_at DESC, created_at DESC, id DESC LIMIT 1.
 *
 *  5. handyman_service_warranty_claims (execution_scope_id, created_at DESC, id DESC)
 *     - handyman-sla-status-api.service.ts warranty-claim stage:
 *       WHERE execution_scope_id = $1 ORDER BY created_at DESC, id DESC.
 *     - GAP: no index on this table has execution_scope_id as leading column
 *       ((id, execution_scope_id) is unusable for scope lookups) — this query
 *       is a sequential scan today.
 *
 *  6. authentication_audit_events (created_at DESC, id DESC)
 *  7. authentication_audit_events (user_id, created_at DESC, id DESC)
 *     - audit.repository.ts `listAuditEvents`:
 *       [WHERE event_type/user_id/outcome/created_at range]
 *       ORDER BY created_at DESC, id DESC LIMIT/OFFSET, COUNT(*) OVER().
 *     - The existing single-column (created_at) and (user_id) indexes force a
 *       sort and cannot provide the id tie-break. They are left in place
 *       (this migration is additive-only); the DBA runbook lists them as
 *       optional, separately-approved cleanup.
 *
 * Uniqueness/overlap audit: none of the seven is redundant with an existing
 * index (checked against the full 2054-index inventory captured from the
 * migrated schema). None is UNIQUE; none is used for FK support beyond the
 * btree access paths above.
 */
const INDEXES: readonly { name: string; sql: string }[] = [
  {
    name: 'handyman_service_requests_client_created_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_service_requests_client_created_idx
            ON handyman_service_requests (client_id, created_at, id)`,
  },
  {
    name: 'handyman_visit_appointments_request_created_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_visit_appointments_request_created_idx
            ON handyman_visit_appointments (client_id, handyman_request_id, created_at DESC, id DESC)`,
  },
  {
    name: 'handyman_es_assignments_scope_assigned_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_es_assignments_scope_assigned_idx
            ON handyman_execution_scope_assignments (execution_scope_id, assigned_at DESC, id DESC)`,
  },
  {
    name: 'handyman_arrival_results_scope_evaluated_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_arrival_results_scope_evaluated_idx
            ON handyman_arrival_verification_results (execution_scope_id, evaluated_at DESC, created_at DESC, id DESC)`,
  },
  {
    name: 'handyman_service_warranty_claims_scope_created_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_service_warranty_claims_scope_created_idx
            ON handyman_service_warranty_claims (execution_scope_id, created_at DESC, id DESC)`,
  },
  {
    name: 'authentication_audit_events_created_at_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS authentication_audit_events_created_at_id_idx
            ON authentication_audit_events (created_at DESC, id DESC)`,
  },
  {
    name: 'authentication_audit_events_user_created_at_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS authentication_audit_events_user_created_at_id_idx
            ON authentication_audit_events (user_id, created_at DESC, id DESC)`,
  },
];

/**
 * CONCURRENTLY builds that fail midway leave an INVALID index that
 * `IF NOT EXISTS` would then silently skip on retry. Fail loudly instead:
 * the migration must not be recorded as applied while an index is unusable.
 */
async function assertIndexesValid(client: PoolClient): Promise<void> {
  const invalid = await client.query<{ index_name: string }>(
    `SELECT c.relname AS index_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid
        AND c.relname = ANY($1::text[])`,
    [INDEXES.map((index) => index.name)],
  );

  if (invalid.rows.length > 0) {
    const names = invalid.rows.map((row) => row.index_name).join(', ');
    throw new Error(
      `CR-HM-DB-OPT-01: index build left INVALID index(es): ${names}. ` +
        'Drop them and re-run the migration (see DBA runbook §Rollback).',
    );
  }
}

export const migration0434HandymanDbOptIndexes: Migration = {
  id: '0434_handyman_db_opt_indexes',
  // CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block.
  transactional: false,
  async up(client: PoolClient): Promise<void> {
    for (const index of INDEXES) {
      await client.query(index.sql);
    }
    await assertIndexesValid(client);
  },
  async down(client: PoolClient): Promise<void> {
    for (const index of INDEXES) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
    }
  },
};
