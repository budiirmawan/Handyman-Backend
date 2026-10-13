/**
 * CR-HM-DB-OPT-02 PART 01 — migration safety verification for 0434.
 *
 * Runs against a disposable scratch database (`asentra_migtest`, created and
 * dropped by this harness). Never points at a shared/production database.
 *
 * Scenarios (all evidence written to scripts/db-bench/out/migration-safety.json):
 *   S1 — full chain applies; 0434 index definitions match the migration
 *        source byte-for-byte (modulo identifier formatting); all indexes
 *        VALID; schema_migrations ledger == registry set, ordered.
 *   S2 — interrupted CONCURRENTLY build: a real CREATE INDEX CONCURRENTLY on
 *        one of the 0434 names is terminated mid-build via
 *        pg_terminate_backend, leaving an INVALID index. Re-running migrateUp
 *        MUST refuse to record 0434 (assertIndexesValid throws) while the
 *        invalid index persists.
 *   S3 — documented manual recovery: DROP INDEX CONCURRENTLY on the invalid
 *        index (runbook §3), then migrateUp applies cleanly with all indexes
 *        valid and recorded.
 *   S4 — ledger consistency re-verified after recovery.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { createPool, migrateUp } from '../../src/database';
import type { DatabaseConfig } from '../../src/config';

const SCRATCH_DB = 'asentra_migtest';
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

type Evidence = {
  generatedAt: string;
  disclaimer: string;
  postgresVersion: string;
  scenarios: Record<string, unknown>;
};

function config(name: string): DatabaseConfig {
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? '55432'),
    name,
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    ssl: false,
    pool: {
      max: 4,
      min: 0,
      connectionTimeoutMs: 15_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 0,
      idleInTransactionSessionTimeoutMs: 0,
    },
  };
}

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const cfg = config('postgres');
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: 'postgres',
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function indexRows(pool: Pool): Promise<{ index_name: string; valid: boolean; indexdef: string }[]> {
  const result = await pool.query<{ index_name: string; valid: boolean; indexdef: string }>(
    `SELECT c.relname AS index_name, i.indisvalid AS valid, pg_indexes.indexdef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       LEFT JOIN pg_indexes ON pg_indexes.indexname = c.relname
      WHERE c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [[...NEW_INDEXES]],
  );
  return result.rows;
}

async function ledgerRows(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM schema_migrations ORDER BY id ASC',
  );
  return result.rows.map((row) => row.id);
}

/** Expected definitions from the migration source (guards against drift). */
async function expectedDefinitions(): Promise<{ name: string; normalized: string }[]> {
  const source = await readFile(
    resolve(process.cwd(), 'src/database/migrations/0434_handyman_db_opt_indexes.ts'),
    'utf8',
  );
  const blocks = [...source.matchAll(/name: '([a-z0-9_]+)',\s*sql: `([^`]+)`/g)];
  return blocks.map((match) => ({
    name: match[1]!,
    normalized: normalize(match[2]!),
  }));
}

/** Compare index definitions ignoring whitespace/case/schema prefix/access method. */
function normalize(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/public\./g, '')
    .replace(/ using btree/g, '')
    .replace(/ if not exists /g, ' ');
}

function tailFromOn(sql: string): string {
  const normalized = normalize(sql);
  const at = normalized.indexOf(' on ');
  return at >= 0 ? normalized.slice(at + 1) : normalized;
}

async function main(): Promise<void> {
  const cfg = config(SCRATCH_DB);
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });

  const evidence: Evidence = {
    generatedAt: new Date().toISOString(),
    disclaimer:
      'Isolated scratch PostgreSQL verification (CR-HM-DB-OPT-02) — no production resources involved.',
    postgresVersion: '',
    scenarios: {},
  };

  const pool = createPool(cfg);
  evidence.postgresVersion = (await pool.query('SELECT version() AS v')).rows[0]?.v ?? 'unknown';

  // ── S1 — full chain, definitions, validity, ledger ──────────────────────
  const applied = await migrateUp(pool);
  const rows = await indexRows(pool);
  const ledger = await ledgerRows(pool);
  const expected = await expectedDefinitions();

  const definitionMismatches: string[] = [];
  for (const row of rows) {
    const exp = expected.find((e) => e.name === row.index_name);
    if (!exp) {
      definitionMismatches.push(`${row.index_name}: not found in migration source`);
      continue;
    }
    const actualTail = tailFromOn(row.indexdef ?? '');
    const wantTail = tailFromOn(exp.normalized);
    if (actualTail !== wantTail) {
      definitionMismatches.push(`${row.index_name}: source=[${wantTail}] catalog=[${actualTail}]`);
    }
  }

  const { migrations } = await import('../../src/database/migrations');
  const registryIds = migrations.map((m) => m.id);
  const ledgerMatchesRegistry =
    registryIds.length === ledger.length && registryIds.every((id, i) => ledger[i] === id);

  evidence.scenarios.S1 = {
    migrationsApplied: applied.length,
    indexCount: rows.length,
    allValid: rows.every((row) => row.valid),
    definitionMismatches,
    ledgerCount: ledger.length,
    registryCount: registryIds.length,
    ledgerMatchesRegistry,
    ledgerHead: ledger.slice(-3),
  };
  console.log('S1', JSON.stringify(evidence.scenarios.S1, null, 2));
  if (rows.length !== 7 || definitionMismatches.length > 0 || !ledgerMatchesRegistry) {
    throw new Error('S1 failed: definitions/validity/ledger inconsistent');
  }

  // ── S2 — interrupted CONCURRENTLY build + refused recording ─────────────
  // Simulate a runner that died mid-`up()`: 0434 is not in the ledger, and one
  // of its indexes exists in INVALID state (the exact hazard IF NOT EXISTS
  // would otherwise paper over).
  await pool.query(`DELETE FROM schema_migrations WHERE id = '0434_handyman_db_opt_indexes'`);
  for (const name of NEW_INDEXES) {
    await pool.query(`DROP INDEX IF EXISTS ${name}`);
  }

  // Staging-scale rows so the CONCURRENTLY build is interruptible. FK trigger
  // enforcement is disabled for this synthetic load in the disposable scratch
  // database (CHECK/UNIQUE constraints still enforced); planner statistics
  // come from the ANALYZE below. SET + INSERT share one session on purpose.
  const loadClient = await pool.connect();
  try {
    await loadClient.query('SET session_replication_role = replica');
    await loadClient.query(`
      INSERT INTO handyman_service_requests
        (id, client_id, channel_attribution_id, tenant_company_id, building_id,
         service_catalog_id, origin_channel, description, status, created_at, updated_at)
      SELECT md5(g::text || '-s2req')::uuid, md5('client-1')::uuid, md5(g::text || '-s2attr')::uuid,
             md5('tenant-1')::uuid, md5('building-1')::uuid, md5('catalog-1')::uuid,
             'BM_SUPER_APP', 'SYNTHETIC migration-safety fixture', 'INTAKE', NOW(), NOW()
      FROM generate_series(1, 800000) g
    `);
    await loadClient.query('SET session_replication_role = DEFAULT');
  } finally {
    loadClient.release();
  }
  await pool.query('ANALYZE handyman_service_requests');

  let interrupted = false;
  for (let attempt = 1; attempt <= 5 && !interrupted; attempt += 1) {
    const builder = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.name });
    const killer = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.name });
    await builder.connect();
    await killer.connect();
    const pid = (await builder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const build = builder
      .query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TARGET_INDEX} ON handyman_service_requests (client_id, created_at, id)`)
      .catch(() => undefined);
    // Give the build time to pass phase 1 on an 800k-row table, then kill it.
    await new Promise((r) => setTimeout(r, 150 + attempt * 100));
    await killer.query('SELECT pg_terminate_backend($1)', [pid]).catch(() => undefined);
    await build;
    await builder.end().catch(() => undefined);
    await killer.end().catch(() => undefined);

    const state = await pool.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
      [TARGET_INDEX],
    );
    if (state.rows.length === 1 && state.rows[0].valid === false) {
      interrupted = true;
    } else if (state.rows.length === 1 && state.rows[0].valid === true) {
      await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${TARGET_INDEX}`);
    }
  }

  if (!interrupted) {
    throw new Error('S2 failed: could not produce an INVALID index via pg_terminate_backend in 5 attempts');
  }

  // Re-run migrateUp exactly as an operator would after a crashed run.
  let refusal: string | null = null;
  try {
    await migrateUp(pool);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  const afterRefusal = await indexRows(pool);
  const ledgerAfterRefusal = await ledgerRows(pool);
  const recorded = ledgerAfterRefusal.includes('0434_handyman_db_opt_indexes');

  evidence.scenarios.S2 = {
    interruptedBuildProducedInvalidIndex: interrupted,
    migrateUpRefusedWith: refusal,
    refusedWhenInvalidIndexPresent: refusal !== null && /INVALID/.test(refusal),
    historyRecordedDespiteInvalid: recorded,
    invalidIndexStillPresent: afterRefusal.some((row) => row.index_name === TARGET_INDEX && !row.valid),
    otherIndexesCreatedValid: afterRefusal.filter((row) => row.index_name !== TARGET_INDEX).every((row) => row.valid),
  };
  console.log('S2', JSON.stringify(evidence.scenarios.S2, null, 2));
  if (refusal === null || recorded) {
    throw new Error('S2 failed: migrateUp must refuse to record 0434 while an invalid index exists');
  }

  // ── S3 — documented manual recovery ─────────────────────────────────────
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${TARGET_INDEX}`);
  const reapplied = await migrateUp(pool);
  const recovered = await indexRows(pool);

  evidence.scenarios.S3 = {
    recoveryCommand: `DROP INDEX CONCURRENTLY IF EXISTS ${TARGET_INDEX}`,
    migrateUpAfterRecoveryApplied: reapplied,
    allSevenPresent: recovered.length === 7,
    allSevenValid: recovered.every((row) => row.valid),
  };
  console.log('S3', JSON.stringify(evidence.scenarios.S3, null, 2));
  if (recovered.length !== 7 || !recovered.every((row) => row.valid)) {
    throw new Error('S3 failed: recovery did not restore all indexes as valid');
  }

  // ── S4 — ledger consistency after recovery ──────────────────────────────
  const finalLedger = await ledgerRows(pool);
  const finalMatches =
    finalLedger.length === registryIds.length &&
    registryIds.every((id, i) => finalLedger[i] === id);
  evidence.scenarios.S4 = {
    ledgerMatchesRegistry: finalMatches,
    head: finalLedger.slice(-3),
  };
  console.log('S4', JSON.stringify(evidence.scenarios.S4, null, 2));
  if (!finalMatches) {
    throw new Error('S4 failed: ledger inconsistent after recovery');
  }

  const outDir = resolve(process.cwd(), 'scripts/db-bench/out');
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'migration-safety.json'), JSON.stringify(evidence, null, 2));
  console.log('\nAll migration-safety scenarios passed. Evidence: scripts/db-bench/out/migration-safety.json');

  await pool.end();
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
