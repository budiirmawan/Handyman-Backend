import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, createPool, migrateDown, migrateUp } from '../src/database';
import { migrations } from '../src/database/migrations';
import { skipIfNoTestDatabase } from './helpers/postgres';
import type { DatabaseConfig } from '../src/config';

/**
 * CR-HM-DB-OPT-01 PART 03 — migration 0434 verification.
 *
 * On the isolated test database: the additive index migration applies after
 * the historical chain, every new index exists and is VALID (CONCURRENTLY
 * builds that fail leave INVALID indexes), re-running is a no-op, and the
 * `down` path drops exactly the new indexes before `up` restores them.
 * Nothing touches financial/audit/evidence rows.
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

const MIGRATION_ID = '0434_handyman_db_opt_indexes';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

async function indexRows(): Promise<{ index_name: string; valid: boolean }[]> {
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

describe('CR-HM-DB-OPT-01 — migration 0434 index migration', () => {
  before(async (t) => {
    database = await skipIfNoTestDatabase(t);
    if (!database) return;
    pool = createPool(database);
    await migrateUp(pool);
  });

  after(async () => {
    if (pool) await closePool(pool);
    pool = null;
    database = null;
  });

  it('registers 0434 as a non-transactional migration after the historical chain', () => {
    const migration = migrations.find((m) => m.id === MIGRATION_ID);
    assert.ok(migration, 'migration 0434 must be registered');
    assert.equal(migration!.transactional, false);
    assert.equal(migrations.at(-1)?.id, MIGRATION_ID);
  });

  it('creates every documented index in a valid state', async (t) => {
    if (!pool) return t.skip('test database unavailable');

    const rows = await indexRows();
    assert.equal(rows.length, NEW_INDEXES.length);
    for (const row of rows) {
      assert.equal(row.valid, true, `${row.index_name} must be valid`);
    }
  });

  it('is idempotent: re-running migrateUp applies nothing', async (t) => {
    if (!pool) return t.skip('test database unavailable');

    const applied = await migrateUp(pool);
    assert.deepEqual(applied, []);
  });

  it('down drops exactly the 0434 indexes; up restores them', async (t) => {
    if (!pool) return t.skip('test database unavailable');

    const rolledBack = await migrateDown(pool);
    assert.equal(rolledBack, MIGRATION_ID);

    assert.deepEqual(await indexRows(), []);

    const reapplied = await migrateUp(pool);
    assert.deepEqual(reapplied, [MIGRATION_ID]);

    const restored = await indexRows();
    assert.equal(restored.length, NEW_INDEXES.length);
    for (const row of restored) {
      assert.equal(row.valid, true, `${row.index_name} must be valid after re-apply`);
    }
  });

  it('leaves row counts untouched (additive schema only)', async (t) => {
    if (!pool) return t.skip('test database unavailable');

    const counts = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['handyman_service_requests', 'authentication_audit_events', 'handyman_visit_appointments']],
    );
    assert.equal(counts.rows.length, 3);
    for (const row of counts.rows) {
      const count = await pool!.query(`SELECT COUNT(*)::int AS c FROM ${row.table_name}`);
      assert.ok(Number.isInteger(count.rows[0]?.c), `${row.table_name} must remain queryable`);
    }
  });
});
