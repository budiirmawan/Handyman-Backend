import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase } from '../src/database';
import {
  getMigrationStatus,
  migrateDown,
  migrateUp,
  verifyMigrationReadiness,
} from '../src/database/migrate';
import { migration0478ServicePriceTierKey } from '../src/database/migrations/0478_service_price_tier_key';
import { migrations } from '../src/database/migrations';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';

/**
 * BA-03 / FINAL REMEDIATION PART 04.
 *
 * Every database in this file is a disposable embedded PostgreSQL instance.
 * The production procedure remains native pg_dump/pg_restore with paired
 * evidence; the restore proof below deliberately uses a stopped-writer
 * physical copy because this sandbox has no PostgreSQL client binaries.
 */

const MIGRATION_0478 = '0478_service_price_tier_key';
const UNSAFE_DOWN_MESSAGE = /Unsafe downgrade 0478_service_price_tier_key refused/;

async function getUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function startEmbeddedTestDatabase(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const port = await getUnusedPort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  try {
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
    return {
      pg,
      dir,
      config: {
        host: '127.0.0.1',
        port,
        name: 'asentra_test',
        user: 'postgres',
        password: '',
        ssl: false,
      },
      stop: async () => {
        await pg.stop();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await pg.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

type Fixture = {
  token: string | null;
  userId: string;
  clientId: string;
  buildingId: string;
  serviceId: string;
  entryIds: string[];
};

type Harness = Awaited<ReturnType<typeof startEmbeddedTestDatabase>> & {
  pool: Pool;
  fixture: Fixture | null;
};

async function createFixture(pool: Pool, withSession = false): Promise<Fixture> {
  const identity = withSession
    ? await createAdminUser()
    : {
        token: null,
        userId: (await userService.createUser({
          email: `ba03-${randomUUID().slice(0, 8)}@example.com`,
          displayName: 'BA-03 Fixture Owner',
        })).id,
      };
  const client = await clientService.createClient({
    code: `BA03${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'BA-03 Disposable Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `BA03P${randomUUID().slice(0, 5).toUpperCase()}`,
    name: 'BA-03 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BA03B${randomUUID().slice(0, 5).toUpperCase()}`,
    name: 'BA-03 Building',
  });

  if (identity.token) {
    await pool.query(
      `INSERT INTO user_building_assignments (id, user_id, building_id, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [randomUUID(), identity.userId, building.id],
    );
  }

  const serviceId = randomUUID();
  await pool.query(
    `INSERT INTO service_catalog
       (id, client_id, code, name, category, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [serviceId, client.id, `BA03S${randomUUID().slice(0, 5).toUpperCase()}`,
      'BA-03 Tiered Service', 'RECOVERY_TEST', identity.userId],
  );

  const entryIds: string[] = [];
  for (const [index, servicePriceKey] of ['TIER_SMALL', 'TIER_LARGE'].entries()) {
    const entryId = randomUUID();
    entryIds.push(entryId);
    await pool.query(
      `INSERT INTO price_catalog_entries
         (id, client_id, building_id, source_mode, entry_kind, service_id,
          service_price_key, currency, unit_price, effective_from, status,
          activated_at, activated_by_user_id, idempotency_key,
          idempotency_fingerprint, created_by_user_id)
       VALUES
         ($1, $2, $3, 'SERVICE', 'REFERENCE', $4, $5, 'IDR', $6,
          '2026-01-01T00:00:00.000Z', 'ACTIVE', NOW(), $7, $8, $9, $7)`,
      [
        entryId,
        client.id,
        building.id,
        serviceId,
        servicePriceKey,
        String((index + 1) * 100),
        identity.userId,
        `ba03-${randomUUID()}`,
        String(index + 10).repeat(64).slice(0, 64),
      ],
    );
  }

  return {
    token: identity.token,
    userId: identity.userId,
    clientId: client.id,
    buildingId: building.id,
    serviceId,
    entryIds,
  };
}

async function openHarness(options: { fixture?: boolean; session?: boolean } = {}): Promise<Harness> {
  const database = await startEmbeddedTestDatabase('asentra-ba03-recovery');
  try {
    const pool = await initDatabase(database.config);
    await migrateUp(pool);
    const fixture = options.fixture === false
      ? null
      : await createFixture(pool, options.session === true);
    return { ...database, pool, fixture };
  } catch (error) {
    await closePool().catch(() => undefined);
    await database.stop().catch(() => undefined);
    throw error;
  }
}

async function closeHarness(harness: Harness): Promise<void> {
  await closePool().catch(() => undefined);
  await harness.stop();
}

async function snapshot0478(pool: Pool) {
  const [ledger, tables, constraints, columns, tiers, catalog] = await Promise.all([
    pool.query('SELECT id, applied_at::text FROM schema_migrations ORDER BY id'),
    pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    ),
    pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'price_catalog_entries'::regclass
       ORDER BY conname`,
    ),
    pool.query(
      `SELECT column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'price_catalog_entries'
       ORDER BY ordinal_position`,
    ),
    pool.query(
      `SELECT id, client_id, building_id, service_id, service_price_key,
              currency, unit_price::text, effective_from::text, effective_to::text,
              status, activated_by_user_id, created_by_user_id
       FROM price_catalog_entries ORDER BY id`,
    ),
    pool.query(
      `SELECT id, client_id, code, name, category, status, created_by_user_id
       FROM service_catalog ORDER BY id`,
    ),
  ]);
  return {
    ledger: ledger.rows,
    tables: tables.rows,
    constraints: constraints.rows,
    columns: columns.rows,
    tiers: tiers.rows,
    catalog: catalog.rows,
  };
}

async function reach0478(pool: Pool): Promise<void> {
  assert.equal(await migrateDown(pool), migrations.at(-1)!.id);
  assert.equal(await migrateDown(pool), migrations.at(-2)!.id);
  assert.equal((await getMigrationStatus(pool)).find((row) => row.id === MIGRATION_0478)?.applied, true);
}

async function caught(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

it('proves the historical 0478 down fails atomically on concurrent ACTIVE tier keys', { timeout: 180_000 }, async () => {
  const harness = await openHarness();
  try {
    assert.equal(migrations.length, 478);
    assert.equal(migrations.at(-1)!.id, '0480_handyman_service_request_item_inherited_attributes');
    const before = await snapshot0478(harness.pool);
    assert.equal(before.tiers.length, 2);
    assert.deepEqual(before.tiers.map((row) => row.status), ['ACTIVE', 'ACTIVE']);
    assert.match(
      before.constraints.find((row) => row.conname === 'price_catalog_entries_service_window_exclusion')!.definition,
      /service_price_key WITH =/,
    );

    const client = await harness.pool.connect();
    let error: unknown;
    try {
      await client.query('BEGIN');
      error = await caught(() => migration0478ServicePriceTierKey.down(client));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    assert.ok(error && typeof error === 'object');
    assert.equal((error as { code?: string }).code, '23P01');
    assert.equal(
      (error as { constraint?: string }).constraint,
      'price_catalog_entries_service_window_exclusion',
    );
    assert.match(
      (error as Error).message,
      /could not create exclusion constraint "price_catalog_entries_service_window_exclusion"/,
    );
    assert.match(String((error as { detail?: string }).detail), /conflicts with key/);
    assert.deepEqual(await snapshot0478(harness.pool), before);
  } finally {
    await closeHarness(harness);
  }
});

it('rejects unsafe runner and CLI down before mutation and preserves schema, tiers, and ledger', { timeout: 180_000 }, async () => {
  const harness = await openHarness();
  try {
    await reach0478(harness.pool);
    const before = await snapshot0478(harness.pool);
    const error = await caught(() => migrateDown(harness.pool));

    // Atomicity is asserted independently of the error wording so the raw
    // pre-guard PostgreSQL failure is also proven not to corrupt state.
    assert.deepEqual(await snapshot0478(harness.pool), before);
    assert.ok(error instanceof Error);
    assert.match(error.message, UNSAFE_DOWN_MESSAGE);
    assert.match(error.message, /forward fix|paired backup\/restore/);

    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/database/cli.ts', 'down'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
          DB_HOST: harness.config.host,
          DB_PORT: String(harness.config.port),
          DB_NAME: harness.config.name,
          DB_USER: harness.config.user,
          DB_PASSWORD: harness.config.password,
          DB_SSL: 'false',
        },
      },
    );
    assert.equal(cli.status, 1, `${cli.stdout}\n${cli.stderr}`);
    assert.match(`${cli.stdout}\n${cli.stderr}`, UNSAFE_DOWN_MESSAGE);
    assert.doesNotMatch(`${cli.stdout}\n${cli.stderr}`, /Rolled back/);
    assert.deepEqual(await snapshot0478(harness.pool), before);
  } finally {
    await closeHarness(harness);
  }
});

it('rejects even one non-conflicting keyed tier instead of silently dropping its identity', { timeout: 180_000 }, async () => {
  const harness = await openHarness();
  try {
    await harness.pool.query('DELETE FROM price_catalog_entries WHERE id = $1', [harness.fixture!.entryIds[1]]);
    await reach0478(harness.pool);
    const before = await snapshot0478(harness.pool);
    assert.equal(before.tiers.length, 1);
    assert.equal(before.tiers[0]!.service_price_key, 'TIER_SMALL');

    const error = await caught(() => migrateDown(harness.pool));
    assert.ok(error instanceof Error, 'the historical down otherwise succeeds and erases the tier key');
    assert.match(error.message, UNSAFE_DOWN_MESSAGE);
    assert.deepEqual(await snapshot0478(harness.pool), before);
  } finally {
    await closeHarness(harness);
  }
});

it('retains empty-data 0478 rollback and forward reapply behavior', { timeout: 180_000 }, async () => {
  const harness = await openHarness({ fixture: false });
  try {
    await reach0478(harness.pool);
    assert.equal(await migrateDown(harness.pool), MIGRATION_0478);
    assert.equal(
      (await getMigrationStatus(harness.pool)).find((row) => row.id === MIGRATION_0478)?.applied,
      false,
    );
    assert.equal(
      (await harness.pool.query(
        `SELECT count(*)::int AS count FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'price_catalog_entries'
           AND column_name = 'service_price_key'`,
      )).rows[0]!.count,
      0,
    );

    assert.deepEqual(await migrateUp(harness.pool), migrations.slice(-3).map((migration) => migration.id));
    await verifyMigrationReadiness(harness.pool);
  } finally {
    await closeHarness(harness);
  }
});

it('restores a stopped-writer backup into an isolated cluster and preserves catalog reads', { timeout: 240_000 }, async () => {
  const source = await openHarness({ session: true });
  let sourceRunning = true;
  let restored: EmbeddedPostgres | null = null;
  let restoreDir = '';
  try {
    const expected = await snapshot0478(source.pool);
    const restorePort = await getUnusedPort();
    restoreDir = await mkdtemp(join(tmpdir(), 'asentra-ba03-restored-'));
    const restoredDataDir = join(restoreDir, 'pg');

    const freezeStarted = Date.now();
    await closePool();
    await source.pg.stop();
    sourceRunning = false;
    await cp(source.dir, restoredDataDir, { recursive: true });
    const backupCompleted = Date.now();

    restored = new EmbeddedPostgres({
      databaseDir: restoredDataDir,
      port: restorePort,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    // Do not initialise: starting the copied PGDATA is the restore under test.
    await restored.start();
    const restoreCompleted = Date.now();

    const restoredPool = await initDatabase({
      host: '127.0.0.1',
      port: restorePort,
      name: source.config.name,
      user: 'postgres',
      password: '',
      ssl: false,
    });
    assert.deepEqual(await snapshot0478(restoredPool), expected);
    await verifyMigrationReadiness(restoredPool);
    assert.equal((await getMigrationStatus(restoredPool)).filter((row) => row.applied).length, migrations.length);
    assert.deepEqual(await migrateUp(restoredPool), []);

    for (const [index, entryId] of source.fixture!.entryIds.entries()) {
      const response = await api()
        .get(`/api/v1/price-catalog/entries/${entryId}`)
        .set('Authorization', `Bearer ${source.fixture!.token}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.id, entryId);
      assert.equal(response.body.data.servicePriceKey, index === 0 ? 'TIER_SMALL' : 'TIER_LARGE');
      assert.equal(response.body.data.status, 'ACTIVE');
    }

    const validationCompleted = Date.now();
    console.log(
      `BA-03 disposable stopped-writer recovery timings (not production RTO): ` +
      `freeze+backup=${backupCompleted - freezeStarted}ms, ` +
      `restore-start=${restoreCompleted - backupCompleted}ms, ` +
      `validation=${validationCompleted - restoreCompleted}ms`,
    );
  } finally {
    await closePool().catch(() => undefined);
    if (restored) await restored.stop().catch(() => undefined);
    if (sourceRunning) await source.stop().catch(() => undefined);
    else await rm(source.dir, { recursive: true, force: true });
    if (restoreDir) await rm(restoreDir, { recursive: true, force: true });
  }
});

it('recovers forward from a failed disposable migration without down or partial bookkeeping', { timeout: 180_000 }, async () => {
  const harness = await openHarness({ fixture: false });
  const id = '9998_ba03_disposable_forward_recovery';
  const table = 'ba03_disposable_forward_recovery';
  migrations.push({
    id,
    async up(client) {
      await client.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
      throw new Error('intentional BA-03 disposable forward-fix failure');
    },
    async down(client) {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
    },
  });

  try {
    await assert.rejects(migrateUp(harness.pool), /intentional BA-03 disposable forward-fix failure/);
    assert.equal((await harness.pool.query(`SELECT to_regclass('${table}') AS table_name`)).rows[0]!.table_name, null);
    assert.equal((await harness.pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id])).rowCount, 0);

    const forwardFix = migrations.at(-1)!;
    forwardFix.up = async (client) => {
      await client.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
      await client.query(`INSERT INTO ${table} (id) VALUES (1)`);
    };
    assert.deepEqual(await migrateUp(harness.pool), [id]);
    assert.equal((await harness.pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]!.count, 1);
    assert.equal((await harness.pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id])).rowCount, 1);
    assert.deepEqual(await migrateUp(harness.pool), []);
  } finally {
    migrations.pop();
    await harness.pool.query(`DROP TABLE IF EXISTS ${table}`);
    await harness.pool.query('DELETE FROM schema_migrations WHERE id = $1', [id]);
    await closeHarness(harness);
  }
});
