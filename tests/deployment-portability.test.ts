import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { after, before, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, createPool, getPool, initDatabase } from '../src/database';
import { migrateUp, verifyMigrationReadiness, getMigrationStatus } from '../src/database/migrate';
import { migrations } from '../src/database/migrations';
import { api } from './helpers/http';

let pg: EmbeddedPostgres;
let dir: string;
const port = 57301;
const database = { host: '127.0.0.1', port, name: 'postgres', user: 'postgres', password: 'local-disposable-only', ssl: false };
before(async () => {
  // Test the current compiled artifact, including on a fresh checkout without dist.
  await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc']);
  dir = await mkdtemp(join(tmpdir(), 'hm-deployment-'));
  pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: database.user, password: database.password, persistent: true });
  await pg.initialise();
  await pg.start();
  await initDatabase(database);
}, { timeout: 120000 });
after(async () => {
  await closePool().catch(() => undefined);
  await pg?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function boot(overrides: NodeJS.ProcessEnv = {}): { child: ChildProcess; exited: Promise<[number | null, NodeJS.Signals | null]>; output: () => string } {
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', PORT: '57302',
      DB_HOST: database.host, DB_PORT: String(port), DB_NAME: database.name, DB_USER: database.user,
      DB_PASSWORD: database.password, DB_SSL: 'false', SCHEDULER_ENABLED: 'false',
      EVIDENCE_STORAGE_DIR: join(dir, 'evidence'), ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const guard = setTimeout(() => child.kill('SIGKILL'), 12000);
  child.once('exit', () => clearTimeout(guard));
  let output = '';
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; });
  return { child, exited: once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>, output: () => output };
}

it('refuses an empty schema without creating history or opening HTTP', { timeout: 15000 }, async () => {
  await assert.rejects(verifyMigrationReadiness(getPool()), /history unavailable/);
  const server = boot();
  assert.equal((await server.exited)[0], 1);
  assert.match(server.output(), /Migration history unavailable/);
  assert.equal((await getPool().query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t, null);
});

it('bootstraps the complete canonical registry and repeats without changes', { timeout: 120000 }, async () => {
  assert.deepEqual(await migrateUp(getPool()), migrations.map((m) => m.id));
  assert.deepEqual(await migrateUp(getPool()), []);
  await verifyMigrationReadiness(getPool());
  const status = await getMigrationStatus(getPool());
  assert.ok(status.every((s) => s.applied));
  assert.match(status.at(-1)!.id, /^0455_/);
  assert.ok(status.some((s) => /^0450_/.test(s.id)));
  assert.ok(!status.some((s) => /^0449_/.test(s.id)));
  console.log(`Verified ${status.length} canonical migrations; latest ${status.at(-1)!.id}`);
});

it('rejects a concurrent runner using a separate PostgreSQL session', async () => {
  const locker = await getPool().connect();
  try {
    await locker.query('SELECT pg_advisory_lock(724196031)');
    await assert.rejects(migrateUp(getPool()), /Another migration runner/);
  } finally {
    await locker.query('SELECT pg_advisory_unlock(724196031)');
    locker.release();
  }
  assert.deepEqual(await migrateUp(getPool()), []);
});

it('fails readiness for pending and unknown history, keeping liveness separate', async () => {
  const latest = migrations.at(-1)!.id;
  await getPool().query('DELETE FROM schema_migrations WHERE id=$1', [latest]);
  try {
    assert.equal((await api().get('/api/v1/health')).status, 200);
    assert.equal((await api().get('/api/v1/health/database')).status, 503);
  } finally {
    await getPool().query('INSERT INTO schema_migrations(id) VALUES($1)', [latest]);
  }
  await getPool().query("INSERT INTO schema_migrations(id) VALUES('9999_future')");
  try {
    await assert.rejects(verifyMigrationReadiness(getPool()), /does not match/);
    await assert.rejects(migrateUp(getPool()), /Unknown applied/);
    assert.ok((await getMigrationStatus(getPool())).some((s) => s.id === '9999_future'));
  } finally {
    await getPool().query("DELETE FROM schema_migrations WHERE id='9999_future'");
  }
  assert.equal((await api().get('/api/v1/health/database')).status, 200);
});

it('rolls back failed DDL and bookkeeping and releases the migration lock', async () => {
  const id = '9998_disposable_failure_test';
  migrations.push({
    id,
    async up(client) {
      await client.query('CREATE TABLE disposable_failed_ddl (id integer)');
      throw new Error('intentional disposable migration failure');
    },
    async down() {},
  });
  try {
    await assert.rejects(migrateUp(getPool()), /intentional disposable migration failure/);
    assert.equal((await getPool().query("SELECT to_regclass('disposable_failed_ddl') AS t")).rows[0].t, null);
    assert.equal((await getPool().query('SELECT id FROM schema_migrations WHERE id=$1', [id])).rowCount, 0);
  } finally {
    migrations.pop();
  }
  assert.deepEqual(await migrateUp(getPool()), []);
});

it('uses a read-only migration readiness query with a non-owner app role', async () => {
  await getPool().query("CREATE ROLE hm_readiness LOGIN PASSWORD 'disposable-role-only'");
  await getPool().query('GRANT USAGE ON SCHEMA public TO hm_readiness');
  await getPool().query('GRANT SELECT ON schema_migrations TO hm_readiness');
  const app = createPool({ ...database, user: 'hm_readiness', password: 'disposable-role-only' });
  try { await verifyMigrationReadiness(app); } finally { await app.end(); }
});

it('returns 503 during a database outage and recovers using the same pool', { timeout: 30000 }, async () => {
  await pg.stop();
  assert.equal((await api().get('/api/v1/health')).status, 200);
  assert.equal((await api().get('/api/v1/health/database')).status, 503);
  await pg.start();
  assert.equal((await api().get('/api/v1/health/database')).status, 200);
});

it('exits finitely on unavailable database and invalid config without leaking password', { timeout: 20000 }, async () => {
  for (const overrides of [{ DB_PORT: '57303' }, { DB_PORT: 'invalid' }, { EVIDENCE_STORAGE_DRIVER: 's3' }, { EVIDENCE_STORAGE_DIR: join(process.cwd(), 'package.json') }]) {
    const server = boot(overrides);
    assert.equal((await server.exited)[0], 1);
    assert.doesNotMatch(server.output(), /local-disposable-only/);
  }
});

it('drains HTTP and closes its pool on SIGTERM', { timeout: 20000 }, async () => {
  const server = boot();
  const abort = setTimeout(() => server.child.kill('SIGKILL'), 15000);
  try {
    // Synchronize on startup logs, not a fixed sleep.
    await new Promise<void>((resolve, reject) => {
      server.child.stderr!.on('data', () => {
        if (server.output().includes('Asentra Backend started')) resolve();
      });
      server.exited.then(() => reject(new Error(server.output())));
    });
    assert.equal((await fetch('http://127.0.0.1:57302/api/v1/health/database')).status, 200);
    server.child.kill('SIGTERM');
    assert.equal((await server.exited)[0], 0);
    assert.match(server.output(), /PostgreSQL pool closed/);
    assert.match(server.output(), /Shutdown completed/);
  } finally {
    clearTimeout(abort);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
  }
});
