import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPool } from '../src/database';
import {
  getMigrationStatus,
  migrateDown,
  migrateUp,
} from '../src/database/migrate';
import { migrations } from '../src/database/migrations';
import {
  assertIsolatedTestDatabase,
  skipIfNoTestDatabase,
} from './helpers/postgres';

/**
 * Migration runner test. The expected migration list is derived from the
 * `migrations` registry itself, so this test stays correct as migrations are
 * added (BE-07, BE-08) rather than hardcoding a snapshot count.
 */
describe('migration runner', () => {
  it('applies pending migrations only once on asentra_test', async (t) => {
    const database = await skipIfNoTestDatabase(t);
    if (!database) {
      return;
    }

    assertIsolatedTestDatabase(database.name);
    const pool = createPool(database);

    try {
      // Start from a clean data slate. Roll back every applied migration; a
      // `down` may legitimately refuse to revert when rows exist that the
      // reverted schema cannot represent, so begin on empty tables and keep
      // rolling back the latest migration until none remain.
      await pool.query('TRUNCATE users, roles, clients CASCADE');
      const initialStatus = await getMigrationStatus(pool);
      const initialApplied = initialStatus.filter((s) => s.applied).length;
      for (let i = 0; i < initialApplied; i++) {
        await migrateDown(pool).catch(() => undefined);
      }

      const expectedIds = migrations.map((m) => m.id);
      const first = await migrateUp(pool);
      assert.deepEqual(first, expectedIds);

      const second = await migrateUp(pool);
      assert.deepEqual(second, []);

      const status = await getMigrationStatus(pool);
      assert.equal(status.length, expectedIds.length);
      assert.equal(status[0]?.id, '0001_initial_foundation');
      assert.equal(status[0]?.applied, true);
      assert.ok(status[0]?.appliedAt);
      assert.equal(status[1]?.id, '0002_create_users');
      assert.equal(status[1]?.applied, true);
      assert.equal(status[2]?.id, '0003_create_user_credentials');
      assert.equal(status[2]?.applied, true);
      assert.equal(status[3]?.id, '0004_create_user_sessions');
      assert.equal(status[3]?.applied, true);
      assert.equal(status[4]?.id, '0005_create_roles');
      assert.equal(status[4]?.applied, true);

      const last = status[status.length - 1];
      assert.equal(last?.id, expectedIds[expectedIds.length - 1]);
      assert.equal(last?.applied, true);
    } finally {
      await pool.end();
    }
  });
});
