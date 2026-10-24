import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseConfig } from '../../src/config';
import {
  createPool,
  sanitizeDatabaseError,
} from '../../src/database/connection';
import {
  getMigrationStatus,
  verifyMigrationReadiness,
} from '../../src/database/migrate';
import { migrations } from '../../src/database/migrations';

async function main(): Promise<void> {
  const database = parseConfig({
    ...process.env,
    NODE_ENV: 'test',
  }).database;
  assert.ok(
    ['127.0.0.1', 'localhost', '::1'].includes(database.host),
    `Migration lifecycle requires a local disposable database, not ${database.host}`,
  );
  assert.match(
    database.name,
    /^asentra_(?:ci|test)(?:_|$)/,
    'Migration lifecycle requires an explicitly isolated CI/test database name',
  );

  const pool = createPool(database);
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DB_HOST: database.host,
    DB_PORT: String(database.port),
    DB_NAME: database.name,
    DB_USER: database.user,
    DB_PASSWORD: database.password,
    DB_SSL: 'false',
  };
  const runCli = (command: 'migrate' | 'status') => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/database/cli.ts', command],
      {
        cwd: process.cwd(),
        env: environment,
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.error) {
      const output = sanitizeDatabaseError(
        `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`,
        database.password,
      );
      throw new Error(`db:${command} failed (exit ${result.status}):\n${output}`);
    }
    return (result.stdout ?? '') as string;
  };
  const appliedStatus = async () => {
    const status = await getMigrationStatus(pool);
    assert.equal(status.length, migrations.length, 'Migration status has unknown or missing IDs');
    assert.ok(status.every((row) => row.applied), 'Migration status contains pending IDs');
    assert.deepEqual(
      status.map((row) => row.id),
      migrations.map((migration) => migration.id),
      'Migration status order differs from the canonical registry',
    );
    await verifyMigrationReadiness(pool);
    return status;
  };

  try {
    const history = await pool.query<{ present: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS present",
    );
    if (history.rows[0]?.present) {
      const rows = await pool.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM schema_migrations',
      );
      assert.equal(
        rows.rows[0]?.count,
        0,
        'Fresh-apply proof requires an empty disposable migration history',
      );
    }

    const first = runCli('migrate');
    assert.match(
      first,
      new RegExp(`Applied ${migrations.length} migration\\(s\\)\\.`),
      'Fresh CLI apply did not report the complete registry',
    );
    const afterFirst = await appliedStatus();

    const statusOutput = runCli('status');
    const appliedLines = statusOutput.match(/^\[applied\] /gm) ?? [];
    assert.equal(appliedLines.length, migrations.length, 'CLI status omitted applied IDs');
    assert.doesNotMatch(statusOutput, /^\[pending\] /m, 'CLI status reported pending IDs');

    const second = runCli('migrate');
    assert.match(second, /No pending migrations\./, 'Second CLI apply was not a no-op');
    assert.doesNotMatch(second, /^Applied /m, 'Second CLI apply unexpectedly rewrote history');
    const afterSecond = await appliedStatus();
    assert.deepEqual(
      afterSecond,
      afterFirst,
      'Idempotent reapply changed migration IDs or timestamps',
    );

    console.log(
      `MIGRATION_LIFECYCLE_PASS | FRESH_APPLIED=${migrations.length} ` +
      `STATUS_APPLIED=${appliedLines.length} SECOND_APPLY=NO_OP ` +
      `HEAD=${migrations.at(-1)!.id}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
