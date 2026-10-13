import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, createPool, migrateUp } from '../src/database';
import { skipIfNoTestDatabase } from './helpers/postgres';
import type { DatabaseConfig } from '../src/config';

/**
 * CR-HM-DB-OPT-02 PART 01 — interrupted CONCURRENTLY recovery contract.
 *
 * Reproduces the documented crash scenario deterministically: 0434 is not
 * recorded in schema_migrations and one of its index names exists in INVALID
 * state (as a pg_terminate_backend-interrupted CREATE INDEX CONCURRENTLY
 * leaves it). The runner MUST refuse to record the migration while any of its
 * indexes is invalid, and the runbook recovery (DROP INDEX CONCURRENTLY +
 * re-run) MUST restore a fully valid, recorded state. No historical migration
 * is touched and no cleanup is performed automatically beyond the documented
 * manual step being exercised explicitly by the test.
 */
const NEW_INDEXES = [
  'handyman_service_requests_client_created_idx',
  'handyman_visit_appointments_request_created_idx',
  'handyman_es_assignments_scope_assigned_idx',
  'handyman_arrival_results_scope_evaluated_idx',
  'handyman_service_warranty_claims_scope_created_idx',
  'authentication_audit_events_created_at_id_idx',
  'authentication_audit_events_user_created_at_id_idx',
] as const;

const TARGET_INDEX = 'handyman_service_requests_client_created_idx';
const MIGRATION_ID = '0434_handyman_db_opt_indexes';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

async function indexState(): Promise<{ index_name: string; valid: boolean }[]> {
  const result = await pool!.query<{ index_name: string; valid: boolean }>(
    `SELECT c.relname AS index_name, i.indisvalid AS valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [[...NEW_INDEXES]],
  );
  return result.rows;
}

async function historyHas0434(): Promise<boolean> {
  const result = await pool!.query(
    'SELECT 1 FROM schema_migrations WHERE id = $1',
    [MIGRATION_ID],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Produces an INVALID index deterministically. Preferred method flips
 * pg_index.indisvalid directly (requires superuser, used by the scratch/test
 * tooling); falls back to terminating a real CONCURRENTLY build; returns
 * false when neither is permitted so the caller can skip honestly.
 */
async function makeIndexInvalid(): Promise<boolean> {
  await pool!.query(`DROP INDEX IF EXISTS ${TARGET_INDEX}`);
  await pool!.query(
    `CREATE INDEX ${TARGET_INDEX} ON handyman_service_requests (client_id, created_at, id)`,
  );
  try {
    await pool!.query(
      `UPDATE pg_catalog.pg_index SET indisvalid = false, indisready = false
        WHERE indexrelid = '${TARGET_INDEX}'::regclass`,
    );
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '42501' && code !== '0A000') {
      throw error;
    }
  }
  // Fallback: leave it valid and report inability (caller skips).
  return false;
}

describe('CR-HM-DB-OPT-02 — 0434 interrupted-build recovery contract', () => {
  before(async (t) => {
    database = await skipIfNoTestDatabase(t);
    if (!database) return;
    pool = createPool(database);
    await migrateUp(pool);
  });

  after(async () => {
    if (pool) {
      // Leave the database in the fully-applied state.
      await migrateUp(pool).catch(() => undefined);
      await closePool(pool);
    }
    pool = null;
    database = null;
  });

  it('refuses to record 0434 while an invalid index exists, and records it after the documented recovery', async (t) => {
    if (!pool) return t.skip('test database unavailable');

    // Simulate a crashed run: 0434 absent from the ledger.
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [MIGRATION_ID]);
    for (const name of NEW_INDEXES) {
      await pool.query(`DROP INDEX IF EXISTS ${name}`);
    }

    const poisoned = await makeIndexInvalid();
    if (!poisoned) {
      t.skip('test database user cannot create an invalid index state (needs superuser)');
      await migrateUp(pool);
      return;
    }

    // Re-running must refuse: the invalid index makes IF NOT EXISTS skip the
    // build and assertIndexesValid must reject the state.
    await assert.rejects(
      () => migrateUp(pool!),
      /INVALID index/,
      'migrateUp must fail loudly on an invalid 0434 index',
    );
    assert.equal(await historyHas0434(), false, '0434 must not be recorded');
    const midState = await indexState();
    assert.ok(
      midState.some((row) => row.index_name === TARGET_INDEX && !row.valid),
      'the invalid index must still be present after the refusal',
    );

    // Documented manual recovery (DBA runbook §3), then re-run.
    await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${TARGET_INDEX}`);
    const applied = await migrateUp(pool);
    assert.deepEqual(applied, [MIGRATION_ID]);

    const finalState = await indexState();
    assert.equal(finalState.length, NEW_INDEXES.length);
    for (const row of finalState) {
      assert.equal(row.valid, true, `${row.index_name} must be valid after recovery`);
    }
    assert.equal(await historyHas0434(), true);
  });
});
