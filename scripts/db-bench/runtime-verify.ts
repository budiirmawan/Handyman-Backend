/**
 * CR-HM-DB-OPT-02 PART 03 — Railway runtime verification.
 *
 * Exercises the production DB runtime layer (src/database) under concurrency:
 *   R1 pool configuration (env-validated limits actually reach the pg Pool)
 *   R2 concurrent "API-like" workloads: connection acquisition + release hygiene
 *   R3 transaction failure mid-flight: rollback, client release, pool intact
 *   R4 statement/query error inside a client: release, pool intact
 *   R5 graceful shutdown: closePool drains and refuses new work
 *   R6 connection budget across backend instances + background workers
 *
 * Requires a scratch database (see scripts/db-bench/staging-verify.ts header).
 * Evidence: scripts/db-bench/out/runtime-verify.json
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config';
import { closePool, createPool, initDatabase } from '../../src/database/connection';
import { withTransaction } from '../../src/database/transaction';
import type { Pool } from 'pg';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'runtime-verify.json');
type Check = { id: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };

async function poolHealth(pool: Pool): Promise<{ waiting: number; idle: number; total: number }> {
  return { waiting: pool.waitingCount, idle: pool.idleCount, total: pool.totalCount };
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  // R1 — validated pool settings reach the pg Pool exactly.
  process.env.DB_POOL_MAX = process.env.DB_POOL_MAX ?? '4';
  process.env.DB_POOL_MIN = process.env.DB_POOL_MIN ?? '1';
  const cfg = loadConfig(process.env);
  const settings = cfg.database.pool;
  const probe = createPool(cfg.database);
  const poolOk =
    probe.options.max === settings.max &&
    probe.options.min === settings.min &&
    probe.options.idleTimeoutMillis === settings.idleTimeoutMs &&
    probe.options.connectionTimeoutMillis === settings.connectionTimeoutMs;
  checks.push({
    id: 'R1-pool-config',
    status: poolOk ? 'PASS' : 'FAIL',
    detail: `DB_POOL_MAX=${settings.max} DB_POOL_MIN=${settings.min} idleTimeoutMs=${settings.idleTimeoutMs} connectionTimeoutMs=${settings.connectionTimeoutMs} statementTimeoutMs=${settings.statementTimeoutMs} idleInTransactionSessionTimeoutMs=${settings.idleInTransactionSessionTimeoutMs} (private DATABASE_URL honored; DATABASE_PUBLIC_URL is never consulted — see tests/config-db-pool.test.ts)`,
  });
  await probe.end();

  const pool = await initDatabase(cfg.database);
  const serverMax = Number(
    (await pool.query<{ max_connections: string }>('SHOW max_connections')).rows[0]!.max_connections,
  );

  // R2 — concurrent acquisition/release hygiene (simulates bursty API traffic).
  const peakObserved: number[] = [];
  const sampler = setInterval(() => peakObserved.push(pool.totalCount), 25);
  await Promise.all(
    Array.from({ length: 30 }, async (_, i) => {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_sleep(0.05), $1::int AS n', [i]);
      } finally {
        client.release();
      }
    }),
  );
  clearInterval(sampler);
  await new Promise((r) => setTimeout(r, 200));
  const after = await poolHealth(pool);
  const leaked = (await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity WHERE state <> 'idle' AND pid <> pg_backend_pid()`,
  )).rows[0]!;
  checks.push({
    id: 'R2-concurrent-release',
    status: after.waiting === 0 && after.total <= settings.max && after.idle === after.total ? 'PASS' : 'FAIL',
    detail: `30 concurrent connects (max=${settings.max}); peak pool.totalCount=${Math.max(...peakObserved, 0)}; after: waiting=${after.waiting} idle=${after.idle} total=${after.total}; active backend sessions outside pool probe=${leaked.n}`,
  });

  // R3 — transaction failure mid-flight: rollback + release + pool intact.
  // Real (non-temp) scratch table: pool clients are different sessions, so a
  // TEMP table would be invisible across them.
  await pool.query(`DROP TABLE IF EXISTS runtime_probe`);
  await pool.query(`CREATE TABLE runtime_probe(id serial PRIMARY KEY, note text NOT NULL)`);
  const results = await Promise.allSettled([
    withTransaction(async (c) => {
      await c.query(`INSERT INTO runtime_probe(note) VALUES ('ok-a')`);
    }),
    withTransaction(async (c) => {
      await c.query(`INSERT INTO runtime_probe(note) VALUES ('doomed')`);
      await c.query(`INSERT INTO runtime_probe(note) VALUES ('ok-b')`);
      throw new Error('injected transaction failure');
    }),
    withTransaction(async (c) => {
      await c.query(`INSERT INTO runtime_probe(note) VALUES ('ok-c')`);
    }),
    withTransaction(async (c) => {
      await c.query(`INSERT INTO runtime_probe(note) VALUES (NULL)`); // NOT NULL violation
    }).catch((e) => {
      throw e;
    }),
  ]);
  const rejected = results.filter((r) => r.status === 'rejected').length;
  const rows = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM runtime_probe');
  const afterTx = await poolHealth(pool);
  checks.push({
    id: 'R3-transaction-failure',
    status: rejected === 2 && rows.rows[0]!.n === '2' && afterTx.waiting === 0 && afterTx.total <= settings.max
      ? 'PASS'
      : 'FAIL',
    detail: `4 concurrent transactions (2 succeed, 1 thrown, 1 constraint violation); rejected=${rejected}; surviving rows=${rows.rows[0]!.n} (rolled-back rows absent); pool after: waiting=${afterTx.waiting} idle=${afterTx.idle} total=${afterTx.total}`,
  });

  // R4 — query error on a checked-out client does not leak the connection.
  await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      const client = await pool.connect();
      try {
        await client.query('SELECT * FROM table_that_does_not_exist_xyz');
      } catch {
        /* expected */
      } finally {
        client.release();
      }
    }),
  );
  const afterErr = await poolHealth(pool);
  checks.push({
    id: 'R4-error-release',
    status: afterErr.waiting === 0 && afterErr.idle === afterErr.total ? 'PASS' : 'FAIL',
    detail: `8 failing queries on checked-out clients; pool after: waiting=${afterErr.waiting} idle=${afterErr.idle} total=${afterErr.total}`,
  });

  // R6 — connection budget across backend instances + workers (workers hold 1).
  const budgets = [1, 2, 3, 5].map((instances) => ({
    backendInstances: instances,
    workerProcesses: 2,
    poolMaxPerInstance: settings.max,
    connections: instances * settings.max + 2,
    headroomVsServerMax: serverMax - (instances * settings.max + 2),
  }));
  checks.push({
    id: 'R6-connection-budget',
    status: budgets.every((b) => b.headroomVsServerMax > 0) ? 'PASS' : 'FAIL',
    detail: `max_connections=${serverMax}; formula: instances*DB_POOL_MAX + workers*1. ` +
      budgets.map((b) => `${b.backendInstances} inst + ${b.workerProcesses} workers = ${b.connections} (headroom ${b.headroomVsServerMax})`).join('; '),
  });

  // R5 — graceful shutdown drains the pool and refuses new work.
  await closePool(pool);
  let refuses = false;
  try {
    await pool.query('SELECT 1');
  } catch {
    refuses = true;
  }
  await pool.query(`DROP TABLE IF EXISTS runtime_probe`).catch(() => undefined);
  checks.push({
    id: 'R5-graceful-shutdown',
    status: refuses ? 'PASS' : 'FAIL',
    detail: `closePool() completed; subsequent query refused=${refuses}; server.ts wires SIGINT/SIGTERM -> requestShutdown -> server.close + closePool (src/server.ts). Workers call closePool via src/database/cli.ts paths.`,
  });

  const fail = checks.filter((c) => c.status === 'FAIL');
  const s = {
    generatedAt: new Date().toISOString(),
    disclaimer:
      'Runtime verification against isolated scratch PostgreSQL — exercises the production DB runtime layer (src/database) under simulated concurrency; worker/HTTP processes themselves are not run here.',
    dbPoolSettingsUsed: settings,
    serverMaxConnections: serverMax,
    checks,
  };
  writeFileSync(OUT, JSON.stringify(s, null, 2));
  for (const c of checks) console.log(`[${c.status}] ${c.id}: ${c.detail}`);
  console.log(`\nevidence: ${OUT}`);
  if (fail.length > 0) {
    console.log(`\nFAILURES (${fail.length})`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
