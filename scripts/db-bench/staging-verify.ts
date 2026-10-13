/**
 * CR-HM-DB-OPT-02 PART 02 — staging-scale query verification.
 *
 * Like run-bench.ts, but at larger, staging-representative volumes and with
 * plan analysis: p50/p95 latencies, EXPLAIN (ANALYZE, BUFFERS) plans,
 * sequential-scan detection, used-index extraction and pg_stat_user_indexes
 * idx_scan deltas (index utilization) around the measurement phase.
 *
 * Scratch database only (`asentra_staging`, created and dropped here).
 * SYNTHETIC fixtures — not production measurements.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres \
 *     npx tsx scripts/db-bench/staging-verify.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { createPool, migrateUp } from '../../src/database';
import type { DatabaseConfig } from '../../src/config';

const SCRATCH_DB = 'asentra_staging';
const ITERATIONS = 12;
const WARMUPS = 4;

type Plan = string;
type Measurement = {
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  plan: Plan;
  seqScans: string[];
  usedIndexes: string[];
};

function cfg(name: string): DatabaseConfig {
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

function md5Uuid(seed: string): string {
  const hex = createHash('md5').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function analyzePlan(plan: Plan): { seqScans: string[]; usedIndexes: string[] } {
  const seqScans = [...plan.matchAll(/Seq Scan on ([a-z0-9_]+)/gi)].map((m) => m[1]!);
  const usedIndexes = [
    ...plan.matchAll(/(?:Index Only Scan|Index Scan|Bitmap Index Scan)(?: Backward)? (?:using|on) ([a-z0-9_]+)/gi),
  ].map((m) => m[1]!);
  return { seqScans: [...new Set(seqScans)], usedIndexes: [...new Set(usedIndexes)] };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const c = cfg('postgres');
  const client = new Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: 'postgres' });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function loadFixtures(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET session_replication_role = replica');
    // 250k requests across 20 clients over 2 years.
    await client.query(`
      INSERT INTO handyman_service_requests
        (id, client_id, channel_attribution_id, tenant_company_id, building_id,
         service_catalog_id, origin_channel, description, status, created_at, updated_at)
      SELECT md5(g::text || '-req')::uuid, md5('client-' || (g % 20)::text)::uuid,
             md5(g::text || '-attr')::uuid, md5('tenant-' || (g % 60)::text)::uuid,
             md5('building-' || (g % 120)::text)::uuid, md5('catalog-' || (g % 30)::text)::uuid,
             'BM_SUPER_APP', 'SYNTHETIC staging fixture (CR-HM-DB-OPT-02)',
             (ARRAY['INTAKE','TRIAGE','INSPECTION_REQUIRED','DIAGNOSIS','READY_FOR_NEXT_STEP','REFERRED'])[1 + (g % 6)],
             NOW() - ((g % 730) || ' days')::interval - ((g % 1440) || ' minutes')::interval, NOW()
      FROM generate_series(1, 250000) g
    `);
    // 10k requests × 5 appointments (50k).
    await client.query(`
      INSERT INTO handyman_visit_appointments
        (id, client_id, handyman_request_id, tenant_company_id, building_id, kind,
         execution_scope_id, resource_type, resource_id, start_at, end_at, timezone,
         state, tenant_choice_evidence_ref, confirmed_by_user_id, confirmed_at,
         created_by_user_id, created_at, updated_at)
      SELECT md5(r::text || '-' || k::text || '-appt')::uuid,
             md5('client-' || (r % 20)::text)::uuid, md5(r::text || '-req')::uuid,
             md5('tenant-' || (r % 60)::text)::uuid, md5('building-' || (r % 120)::text)::uuid,
             CASE WHEN k % 2 = 1 THEN 'INSPECTION' ELSE 'EXECUTION' END,
             CASE WHEN k % 2 = 1 THEN NULL ELSE md5('scope-' || ((r % 15000) + 1)::text)::uuid END,
             CASE WHEN k % 2 = 1 THEN 'INSPECTOR_USER' ELSE 'CREW' END,
             md5(r::text || '-' || k::text || '-res')::uuid,
             NOW() - ((r % 365) || ' days')::interval + (k || ' hours')::interval,
             NOW() - ((r % 365) || ' days')::interval + ((k + 2) || ' hours')::interval,
             'Asia/Jakarta',
             CASE WHEN k = 1 THEN 'CONFIRMED' ELSE 'COMPLETED' END,
             'SYNTHETIC_EVIDENCE_REF', md5('user-' || ((r + 1) % 500)::text)::uuid,
             NOW() - ((r % 365) || ' days')::interval, md5('user-' || (r % 500)::text)::uuid,
             NOW() - ((r % 365) || ' days')::interval, NOW()
      FROM generate_series(1, 10000) r, generate_series(1, 5) k
    `);
    // 15k scopes × 4 assignments (60k), one ACTIVE each.
    await client.query(`
      INSERT INTO handyman_execution_scope_assignments
        (id, client_id, execution_scope_id, handyman_provider_context_id, handyman_crew_id,
         status, assigned_by_user_id, assigned_at, created_at, updated_at)
      SELECT md5(s::text || '-' || k::text || '-asg')::uuid, md5('client-' || (s % 20)::text)::uuid,
             md5('scope-' || s::text)::uuid, md5('provider-' || (s % 30)::text)::uuid,
             md5('crew-' || (s % 90)::text)::uuid,
             CASE WHEN k = 1 THEN 'ACTIVE' ELSE 'SUPERSEDED' END,
             md5('user-' || (s % 500)::text)::uuid,
             NOW() - ((s % 365) || ' days')::interval - ((5 - k) || ' hours')::interval,
             NOW() - ((s % 365) || ' days')::interval, NOW()
      FROM generate_series(1, 15000) s, generate_series(1, 4) k
    `);
    // 15k scopes × 3 arrivals (45k).
    await client.query(`
      INSERT INTO handyman_arrival_verification_results
        (id, client_id, execution_scope_id, assignment_id, actor_user_id, challenge_id,
         expected_building_id, qr_signal, status, primary_reason, evaluated_at, created_at)
      SELECT md5(s::text || '-' || k::text || '-arr')::uuid, md5('client-' || (s % 20)::text)::uuid,
             md5('scope-' || s::text)::uuid, md5(s::text || '-1-asg')::uuid,
             md5('user-' || (s % 500)::text)::uuid, md5(s::text || '-' || k::text || '-chal')::uuid,
             md5('building-' || (s % 120)::text)::uuid,
             (ARRAY['MATCH','MISMATCH','UNKNOWN'])[k],
             (ARRAY['VERIFIED','FAILED','MANUAL_REVIEW_REQUIRED'])[k],
             (ARRAY['ALL_POSITIVE_EVIDENCE','QR_MISMATCH','QR_UNKNOWN'])[k],
             NOW() - ((s % 365) || ' days')::interval - ((4 - k) * 30 || ' minutes')::interval,
             NOW() - ((s % 365) || ' days')::interval
      FROM generate_series(1, 15000) s, generate_series(1, 3) k
    `);
    // 15k scopes × 3 claims (45k).
    await client.query(`
      INSERT INTO handyman_service_warranty_claims
        (id, client_id, warranty_id, execution_scope_id, bast_id, status, claim_note,
         opened_by_user_id, submitted_at, claimant_user_id, decided_at, decided_by_user_id,
         decision_note, created_at, updated_at)
      SELECT md5(s::text || '-' || k::text || '-clm')::uuid, md5('client-' || (s % 20)::text)::uuid,
             md5('warranty-' || s::text || '-' || k::text)::uuid, md5('scope-' || s::text)::uuid,
             md5('bast-' || s::text)::uuid,
             (ARRAY['CLAIM_DRAFT','CLAIM_SUBMITTED','CLAIM_APPROVED'])[k],
             'SYNTHETIC staging fixture (CR-HM-DB-OPT-02)', md5('user-' || (s % 500)::text)::uuid,
             CASE WHEN k = 1 THEN NULL ELSE NOW() - ((s % 365) || ' days')::interval END,
             CASE WHEN k = 1 THEN NULL ELSE md5('user-' || ((s + 1) % 500)::text)::uuid END,
             CASE WHEN k = 3 THEN NOW() - ((s % 365) || ' days')::interval + interval '1 hour' END,
             CASE WHEN k = 3 THEN md5('user-' || ((s + 2) % 500)::text)::uuid END,
             CASE WHEN k = 3 THEN 'SYNTHETIC approval note' END,
             NOW() - ((s % 365) || ' days')::interval, NOW()
      FROM generate_series(1, 15000) s, generate_series(1, 3) k
    `);
    // 500k auth audit events across 400 users over 18 months.
    await client.query(`
      INSERT INTO authentication_audit_events
        (id, event_type, outcome, user_id, actor_user_id, request_id, metadata, created_at)
      SELECT md5(g::text || '-evt')::uuid,
             (ARRAY['LOGIN_SUCCESS','LOGIN_FAILED','LOGOUT','INVITATION_CREATED','INVITATION_ACCEPTED'])[1 + (g % 5)],
             (ARRAY['SUCCESS','FAILURE','SUCCESS','SUCCESS','SUCCESS'])[1 + (g % 5)],
             md5('user-' || (g % 400)::text)::uuid, md5('user-' || (g % 400)::text)::uuid,
             'bench-' || g::text, '{"synthetic": true}'::jsonb,
             NOW() - ((g % 548) || ' days')::interval - ((g % 1440) || ' minutes')::interval
      FROM generate_series(1, 500000) g
    `);
    await client.query('SET session_replication_role = DEFAULT');
    await client.query('COMMIT');
    await client.query('ANALYZE');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Shape = { name: string; sql: string; params: () => unknown[] };

function shapes(): Shape[] {
  return [
    {
      name: 'Q1 customer-care/queue list (client, created_at ASC, LIMIT 50)',
      sql: `SELECT id, client_id, building_id, tenant_company_id, status, created_at
              FROM handyman_service_requests r WHERE r.client_id = $1
             ORDER BY r.created_at ASC, r.id ASC LIMIT 50 OFFSET 0`,
      params: () => [md5Uuid('client-3')],
    },
    {
      name: 'Q2 workspace keyset page',
      sql: `SELECT id, created_at FROM handyman_service_requests r
             WHERE r.client_id = $1 AND (r.created_at, r.id) > ($2::timestamptz, $3::uuid)
             ORDER BY r.created_at ASC, r.id ASC LIMIT 25`,
      params: () => [md5Uuid('client-3'), new Date(Date.now() - Math.floor(Math.random() * 600) * 86_400_000).toISOString(), md5Uuid('cursor')],
    },
    {
      name: 'Q3 audit list (30-day range page + COUNT(*) OVER())',
      sql: `SELECT id, event_type, outcome, user_id, created_at, COUNT(*) OVER() AS total
              FROM authentication_audit_events
             WHERE created_at >= $1 AND created_at <= $2
             ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET 0`,
      params: () => [new Date(Date.now() - 30 * 86_400_000).toISOString(), new Date().toISOString()],
    },
    {
      name: 'Q4 audit list (user filter)',
      sql: `SELECT id, event_type, outcome, created_at FROM authentication_audit_events
             WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET 0`,
      params: () => [md5Uuid('user-' + Math.floor(Math.random() * 400))],
    },
    {
      name: 'Q5 appointment list per request',
      sql: `SELECT id, state, start_at, end_at FROM handyman_visit_appointments
             WHERE client_id = $1 AND handyman_request_id = $2
             ORDER BY created_at DESC, id DESC`,
      params: () => {
        const r = 1 + Math.floor(Math.random() * 10000);
        return [md5Uuid(`client-${r % 20}`), md5Uuid(`${r}-req`)];
      },
    },
    {
      name: 'Q6 execution-scope assignment stage',
      sql: `SELECT id, status, handyman_provider_context_id, handyman_crew_id
              FROM handyman_execution_scope_assignments WHERE execution_scope_id = $1
             ORDER BY (status = 'ACTIVE') DESC, assigned_at DESC, id DESC`,
      params: () => [md5Uuid('scope-' + (1 + Math.floor(Math.random() * 15000)))],
    },
    {
      name: 'Q7 arrival stage latest',
      sql: `SELECT id, status, primary_reason FROM handyman_arrival_verification_results
             WHERE execution_scope_id = $1
             ORDER BY evaluated_at DESC, created_at DESC, id DESC LIMIT 1`,
      params: () => [md5Uuid('scope-' + (1 + Math.floor(Math.random() * 15000)))],
    },
    {
      name: 'Q8 warranty claims stage',
      sql: `SELECT id, status FROM handyman_service_warranty_claims
             WHERE execution_scope_id = $1 ORDER BY created_at DESC, id DESC`,
      params: () => [md5Uuid('scope-' + (1 + Math.floor(Math.random() * 15000)))],
    },
    {
      name: 'Q9 deep offset page (LIMIT 50 OFFSET 2000) — pagination review',
      sql: `SELECT id, created_at FROM handyman_service_requests r
             WHERE r.client_id = $1 ORDER BY r.created_at ASC, r.id ASC LIMIT 50 OFFSET 2000`,
      params: () => [md5Uuid('client-3')],
    },
  ];
}

async function measure(pool: Pool, shape: Shape): Promise<Measurement> {
  const timings: number[] = [];
  for (let i = 0; i < WARMUPS + ITERATIONS; i += 1) {
    const start = process.hrtime.bigint();
    await pool.query(shape.sql, shape.params());
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    if (i >= WARMUPS) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${shape.sql}`, shape.params());
  const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');
  const { seqScans, usedIndexes } = analyzePlan(plan);
  return {
    p50Ms: Number(timings[Math.floor(timings.length / 2)]!.toFixed(3)),
    p95Ms: Number(percentile(timings, 95).toFixed(3)),
    minMs: Number(timings[0]!.toFixed(3)),
    plan,
    seqScans,
    usedIndexes,
  };
}

const NEW_INDEXES = [
  'handyman_service_requests_client_created_idx',
  'handyman_visit_appointments_request_created_idx',
  'handyman_es_assignments_scope_assigned_idx',
  'handyman_arrival_results_scope_evaluated_idx',
  'handyman_service_warranty_claims_scope_created_idx',
  'authentication_audit_events_created_at_id_idx',
  'authentication_audit_events_user_created_at_id_idx',
] as const;

async function idxScans(pool: Pool): Promise<Record<string, number>> {
  // PG14+: force the stats collector to flush so idx_scan deltas are visible
  // immediately; clear this session's snapshot before reading.
  await pool.query('SELECT pg_stat_force_next_flush()').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 500));
  await pool.query('SELECT pg_stat_clear_snapshot()').catch(() => undefined);
  const result = await pool.query<{ indexrelname: string; idx_scan: string }>(
    `SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE indexrelname = ANY($1::text[])`,
    [[...NEW_INDEXES]],
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) out[row.indexrelname] = Number(row.idx_scan);
  return out;
}

async function main(): Promise<void> {
  const config = cfg(SCRATCH_DB);
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });

  const pool = createPool(config);
  const version = (await pool.query('SELECT version() AS v')).rows[0]?.v ?? 'unknown';
  console.log(version);
  console.log('Applying migrations…');
  await migrateUp(pool);
  console.log('Loading SYNTHETIC staging fixtures…');
  await loadFixtures(pool);

  // Baseline: without the 0434 indexes.
  for (const name of NEW_INDEXES) await pool.query(`DROP INDEX IF EXISTS ${name}`);
  await pool.query('ANALYZE');

  const all = shapes();
  const before: Record<string, Measurement> = {};
  for (const shape of all) {
    console.log(`before: ${shape.name}`);
    before[shape.name] = await measure(pool, shape);
  }

  for (const name of NEW_INDEXES) {
    const sqlByIndex: Record<string, string> = {
      handyman_service_requests_client_created_idx: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_service_requests_client_created_idx ON handyman_service_requests (client_id, created_at, id)',
      handyman_visit_appointments_request_created_idx: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_visit_appointments_request_created_idx ON handyman_visit_appointments (client_id, handyman_request_id, created_at DESC, id DESC)',
      handyman_es_assignments_scope_assigned_idx: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_es_assignments_scope_assigned_idx ON handyman_execution_scope_assignments (execution_scope_id, assigned_at DESC, id DESC)',
      handyman_arrival_results_scope_evaluated_idx: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_arrival_results_scope_evaluated_idx ON handyman_arrival_verification_results (execution_scope_id, evaluated_at DESC, created_at DESC, id DESC)',
      handyman_service_warranty_claims_scope_created_idx: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_service_warranty_claims_scope_created_idx ON handyman_service_warranty_claims (execution_scope_id, created_at DESC, id DESC)',
      authentication_audit_events_created_at_id_idx: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS authentication_audit_events_created_at_id_idx ON authentication_audit_events (created_at DESC, id DESC)',
      authentication_audit_events_user_created_at_id_idx: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS authentication_audit_events_user_created_at_id_idx ON authentication_audit_events (user_id, created_at DESC, id DESC)',
    };
    await pool.query(sqlByIndex[name]!);
  }
  await pool.query('ANALYZE');

  const scansBefore = await idxScans(pool);
  const after: Record<string, Measurement> = {};
  for (const shape of all) {
    console.log(`after:  ${shape.name}`);
    after[shape.name] = await measure(pool, shape);
  }
  const scansAfter = await idxScans(pool);
  const utilization: Record<string, number> = {};
  for (const name of NEW_INDEXES) utilization[name] = (scansAfter[name] ?? 0) - (scansBefore[name] ?? 0);

  const rowCounts = await pool.query<{ table_name: string; n: string }>(
    `SELECT relname AS table_name, n_live_tup::text AS n FROM pg_stat_user_tables
      WHERE relname IN ('handyman_service_requests','handyman_visit_appointments','handyman_execution_scope_assignments','handyman_arrival_verification_results','handyman_service_warranty_claims','authentication_audit_events')`,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    disclaimer: 'SYNTHETIC staging-scale fixtures on isolated scratch PostgreSQL — NOT live production measurements.',
    postgresVersion: version,
    protocol: { warmups: WARMUPS, iterations: ITERATIONS, statistic: 'p50/p95/min of wall-clock, EXPLAIN (ANALYZE, BUFFERS) sample per shape' },
    rowCounts: Object.fromEntries(rowCounts.rows.map((r) => [r.table_name, Number(r.n)])),
    indexUtilizationDuringAfterPhase: utilization,
    results: all.map((shape) => ({
      name: shape.name,
      before: {
        p50Ms: before[shape.name]!.p50Ms,
        p95Ms: before[shape.name]!.p95Ms,
        seqScans: before[shape.name]!.seqScans,
        usedIndexes: before[shape.name]!.usedIndexes,
        plan: before[shape.name]!.plan,
      },
      after: {
        p50Ms: after[shape.name]!.p50Ms,
        p95Ms: after[shape.name]!.p95Ms,
        seqScans: after[shape.name]!.seqScans,
        usedIndexes: after[shape.name]!.usedIndexes,
        plan: after[shape.name]!.plan,
      },
    })),
  };

  const outDir = resolve(process.cwd(), 'scripts/db-bench/out');
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'staging-verify.json'), JSON.stringify(report, null, 2));

  console.log('\n=== staging-scale p50/p95 (ms) ===');
  for (const row of report.results) {
    console.log(`${row.name}\n  before: ${row.before.p50Ms} / ${row.before.p95Ms}  seq=${row.before.seqScans.length}  idx=[${row.before.usedIndexes.join(',')}]`);
    console.log(`  after:  ${row.after.p50Ms} / ${row.after.p95Ms}  seq=${row.after.seqScans.length}  idx=[${row.after.usedIndexes.join(',')}]`);
  }
  console.log('\nindex utilization during after-phase:', utilization);

  await pool.end();
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
