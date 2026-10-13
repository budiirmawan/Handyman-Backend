/**
 * CR-HM-DB-OPT-01 — synthetic fixture benchmark harness.
 *
 * WHAT THIS IS
 * ------------
 * A reproducible, self-contained benchmark for the query shapes that motivated
 * migration 0434. It creates its OWN database (asentra_bench), applies the
 * repository migration chain, loads clearly-labeled SYNTHETIC fixture rows,
 * and measures the target queries with and without the 0434 indexes.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT production traffic and NOT a live measurement: all rows are
 * generated (INSERT ... generate_series) inside a disposable scratch database
 * on the machine running the harness. FK trigger enforcement is disabled while
 * loading fixtures (session_replication_role = replica) so the synthetic rows
 * do not have to fabricate the full domain graph; this does not affect
 * planner choices, which use table statistics (ANALYZE runs after loading).
 *
 * USAGE
 * -----
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres \
 *     npx tsx scripts/db-bench/run-bench.ts
 *
 * The target server must be a SCRATCH PostgreSQL (≥14). The harness refuses to
 * run against databases whose name is not `asentra_bench`, and it drops and
 * recreates only that database.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { createPool, migrateUp } from '../../src/database';
import type { DatabaseConfig } from '../../src/config';

const BENCH_DB = 'asentra_bench';
const ITERATIONS = 10;
const WARMUPS = 3;

type TimedQuery = {
  name: string;
  evidence: string;
  sql: string;
  params: () => unknown[];
};

type QueryResult = {
  name: string;
  evidence: string;
  before: { medianMs: number; p95Ms: number; plan: string };
  after: { medianMs: number; p95Ms: number; plan: string };
};

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function requireScratchConfig(): DatabaseConfig {
  const host = process.env.DB_HOST ?? '127.0.0.1';
  const port = Number(process.env.DB_PORT ?? '55432');
  const user = process.env.DB_USER ?? 'postgres';
  const password = process.env.DB_PASSWORD ?? 'postgres';
  return {
    host,
    port,
    name: BENCH_DB,
    user,
    password,
    ssl: false,
    pool: {
      max: 4,
      min: 0,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 0,
      idleInTransactionSessionTimeoutMs: 0,
    },
  };
}

async function withAdmin<T>(config: DatabaseConfig, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: 'postgres',
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** SYNTHETIC fixtures — clearly labeled; never real records. */
async function loadSyntheticFixtures(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Synthetic bulk load: skip FK trigger enforcement for generated rows only.
    await client.query('SET session_replication_role = replica');
    await client.query('ALTER TABLE handyman_service_requests DISABLE TRIGGER ALL');
    await client.query('ALTER TABLE handyman_visit_appointments DISABLE TRIGGER ALL');
    await client.query('ALTER TABLE handyman_execution_scope_assignments DISABLE TRIGGER ALL');
    await client.query('ALTER TABLE handyman_arrival_verification_results DISABLE TRIGGER ALL');
    await client.query('ALTER TABLE handyman_service_warranty_claims DISABLE TRIGGER ALL');
    await client.query('ALTER TABLE authentication_audit_events DISABLE TRIGGER ALL');

    // 60k requests across 12 clients (hot client ≈ 5k), 2 years of history.
    await client.query(`
      INSERT INTO handyman_service_requests
        (id, client_id, channel_attribution_id, tenant_company_id, building_id,
         service_catalog_id, origin_channel, description, status, created_at, updated_at)
      SELECT md5(g::text || '-req')::uuid,
             md5('client-' || (g % 12)::text)::uuid,
             md5(g::text || '-attr')::uuid,
             md5('tenant-' || (g % 40)::text)::uuid,
             md5('building-' || (g % 60)::text)::uuid,
             md5('catalog-' || (g % 25)::text)::uuid,
             'BM_SUPER_APP',
             'SYNTHETIC fixture row (CR-HM-DB-OPT-01 benchmark) — not real data',
             (ARRAY['INTAKE','TRIAGE','INSPECTION_REQUIRED','DIAGNOSIS','READY_FOR_NEXT_STEP','REFERRED'])[1 + (g % 6)],
             NOW() - ((g % 730) || ' days')::interval - ((g % 1440) || ' minutes')::interval,
             NOW()
      FROM generate_series(1, 60000) g
    `);

    // 8k synthetic requests × 5 appointments (40k rows). Exactly one live
    // appointment per (request, kind) so the partial-unique
    // handyman_visit_appointments_one_live_per_request_kind index stays honest.
    // States/references satisfy the CHECK constraints (confirm proof, kind ↔
    // scope/resource pairing, window ordering).
    await client.query(`
      INSERT INTO handyman_visit_appointments
        (id, client_id, handyman_request_id, tenant_company_id, building_id, kind,
         execution_scope_id, resource_type, resource_id, start_at, end_at, timezone,
         state, tenant_choice_evidence_ref, confirmed_by_user_id, confirmed_at,
         created_by_user_id, created_at, updated_at)
      SELECT md5(r::text || '-' || k::text || '-appt')::uuid,
             md5('client-' || (r % 12)::text)::uuid,
             md5(r::text || '-req')::uuid,
             md5('tenant-' || (r % 40)::text)::uuid,
             md5('building-' || (r % 60)::text)::uuid,
             CASE WHEN k % 2 = 1 THEN 'INSPECTION' ELSE 'EXECUTION' END,
             CASE WHEN k % 2 = 1 THEN NULL
                  ELSE md5('scope-' || ((r % 12000) + 1)::text)::uuid END,
             CASE WHEN k % 2 = 1 THEN 'INSPECTOR_USER' ELSE 'CREW' END,
             md5(r::text || '-' || k::text || '-resource')::uuid,
             NOW() - ((r % 365) || ' days')::interval + (k || ' hours')::interval,
             NOW() - ((r % 365) || ' days')::interval + ((k + 2) || ' hours')::interval,
             'Asia/Jakarta',
             CASE WHEN k = 1 THEN 'CONFIRMED' ELSE 'COMPLETED' END,
             'SYNTHETIC_EVIDENCE_REF',
             md5('user-' || ((r + 1) % 500)::text)::uuid,
             NOW() - ((r % 365) || ' days')::interval - (k || ' minutes')::interval,
             md5('user-' || (r % 500)::text)::uuid,
             NOW() - ((r % 365) || ' days')::interval - (k || ' minutes')::interval,
             NOW()
      FROM generate_series(1, 8000) r, generate_series(1, 5) k
    `);

    // 12k execution scopes × 4 assignment rows (40k). Exactly one ACTIVE per
    // scope (partial-unique handyman_es_assignments_one_active_idx).
    await client.query(`
      INSERT INTO handyman_execution_scope_assignments
        (id, client_id, execution_scope_id, handyman_provider_context_id, handyman_crew_id,
         status, assigned_by_user_id, assigned_at, created_at, updated_at)
      SELECT md5(s::text || '-' || k::text || '-asg')::uuid,
             md5('client-' || (s % 12)::text)::uuid,
             md5('scope-' || s::text)::uuid,
             md5('provider-' || (s % 30)::text)::uuid,
             md5('crew-' || (s % 90)::text)::uuid,
             CASE WHEN k = 1 THEN 'ACTIVE' ELSE 'SUPERSEDED' END,
             md5('user-' || (s % 500)::text)::uuid,
             NOW() - ((s % 365) || ' days')::interval - ((5 - k) || ' hours')::interval,
             NOW() - ((s % 365) || ' days')::interval,
             NOW()
      FROM generate_series(1, 12000) s, generate_series(1, 4) k
    `);

    // 12k scopes × 3 arrival results (36k) with valid (status, reason, qr)
    // triples per the hmar_* CHECK constraints; evaluated_at strictly ordered.
    await client.query(`
      INSERT INTO handyman_arrival_verification_results
        (id, client_id, execution_scope_id, assignment_id, actor_user_id, challenge_id,
         expected_building_id, qr_signal, status, primary_reason, evaluated_at, created_at)
      SELECT md5(s::text || '-' || k::text || '-arr')::uuid,
             md5('client-' || (s % 12)::text)::uuid,
             md5('scope-' || s::text)::uuid,
             md5(s::text || '-1-asg')::uuid,
             md5('user-' || (s % 500)::text)::uuid,
             md5(s::text || '-' || k::text || '-chal')::uuid,
             md5('building-' || (s % 60)::text)::uuid,
             (ARRAY['MATCH','MISMATCH','UNKNOWN'])[k],
             (ARRAY['VERIFIED','FAILED','MANUAL_REVIEW_REQUIRED'])[k],
             (ARRAY['ALL_POSITIVE_EVIDENCE','QR_MISMATCH','QR_UNKNOWN'])[k],
             NOW() - ((s % 365) || ' days')::interval - ((4 - k) * 30 || ' minutes')::interval,
             NOW() - ((s % 365) || ' days')::interval
      FROM generate_series(1, 12000) s, generate_series(1, 3) k
    `);

    // 12k scopes × 3 warranty claims (36k); warranty_id unique per claim so the
    // partial-unique open-claims index cannot conflict. Status/columns satisfy
    // the submit/decision/withdrawn CHECK triples.
    await client.query(`
      INSERT INTO handyman_service_warranty_claims
        (id, client_id, warranty_id, execution_scope_id, bast_id, status, claim_note,
         opened_by_user_id, submitted_at, claimant_user_id, decided_at, decided_by_user_id,
         decision_note, created_at, updated_at)
      SELECT md5(s::text || '-' || k::text || '-clm')::uuid,
             md5('client-' || (s % 12)::text)::uuid,
             md5('warranty-' || s::text || '-' || k::text)::uuid,
             md5('scope-' || s::text)::uuid,
             md5('bast-' || s::text)::uuid,
             (ARRAY['CLAIM_DRAFT','CLAIM_SUBMITTED','CLAIM_APPROVED'])[k],
             'SYNTHETIC fixture row (CR-HM-DB-OPT-01 benchmark)',
             md5('user-' || (s % 500)::text)::uuid,
             CASE WHEN k = 1 THEN NULL
                  ELSE NOW() - ((s % 365) || ' days')::interval END,
             CASE WHEN k = 1 THEN NULL
                  ELSE md5('user-' || ((s + 1) % 500)::text)::uuid END,
             CASE WHEN k = 3 THEN NOW() - ((s % 365) || ' days')::interval + interval '1 hour' END,
             CASE WHEN k = 3 THEN md5('user-' || ((s + 2) % 500)::text)::uuid END,
             CASE WHEN k = 3 THEN 'SYNTHETIC approval note' END,
             NOW() - ((s % 365) || ' days')::interval - (k * 60 || ' minutes')::interval,
             NOW()
      FROM generate_series(1, 12000) s, generate_series(1, 3) k
    `);

    // 200k auth audit events across 250 users over 18 months.
    await client.query(`
      INSERT INTO authentication_audit_events
        (id, event_type, outcome, user_id, actor_user_id, request_id, metadata, created_at)
      SELECT md5(g::text || '-evt')::uuid,
             (ARRAY['LOGIN_SUCCESS','LOGIN_FAILED','LOGOUT','INVITATION_CREATED','INVITATION_ACCEPTED'])[1 + (g % 5)],
             (ARRAY['SUCCESS','FAILURE','SUCCESS','SUCCESS','SUCCESS'])[1 + (g % 5)],
             md5('user-' || (g % 250)::text)::uuid,
             md5('user-' || (g % 250)::text)::uuid,
             'bench-' || g::text,
             '{"synthetic": true}'::jsonb,
             NOW() - ((g % 548) || ' days')::interval - ((g % 1440) || ' minutes')::interval
      FROM generate_series(1, 200000) g
    `);

    await client.query('COMMIT');
    await client.query('SET session_replication_role = DEFAULT');
    await client.query('ANALYZE');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Query shapes copied from the audited callsites (simplified column lists). */
function targetQueries(): TimedQuery[] {
  return [
    {
      name: 'Q1 customer-care / queue list (client, created_at ASC)',
      evidence:
        'handyman-service-request.repository.ts listCustomerCareProjectionsScoped — WHERE r.client_id=$1 ORDER BY r.created_at ASC, r.id ASC LIMIT 50 OFFSET 0',
      sql: `SELECT id, client_id, building_id, tenant_company_id, status, created_at
              FROM handyman_service_requests r
             WHERE r.client_id = $1
             ORDER BY r.created_at ASC, r.id ASC
             LIMIT 50 OFFSET 0`,
      params: () => [randomHexUuid('client-3')],
    },
    {
      name: 'Q2 workspace keyset page (client, created cursor)',
      evidence:
        'handyman-service-request.repository.ts listWorkspaceProjectionsScoped — keyset (created_at, id) pagination',
      sql: `SELECT id, created_at
              FROM handyman_service_requests r
             WHERE r.client_id = $1 AND (r.created_at, r.id) > ($2::timestamptz, $3::uuid)
             ORDER BY r.created_at ASC, r.id ASC
             LIMIT 25`,
      params: () => [
        randomHexUuid('client-3'),
        new Date(Date.now() - Math.floor(Math.random() * 600) * 86_400_000).toISOString(),
        randomHexUuid('random'),
      ],
    },
    {
      name: 'Q3 audit list (time range, created_at DESC page)',
      evidence:
        'audit.repository.ts listAuditEvents — WHERE created_at range ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET 0 with COUNT(*) OVER()',
      sql: `SELECT id, event_type, outcome, user_id, created_at, COUNT(*) OVER() AS total
              FROM authentication_audit_events
             WHERE created_at >= $1 AND created_at <= $2
             ORDER BY created_at DESC, id DESC
             LIMIT 50 OFFSET 0`,
      params: () => [
        new Date(Date.now() - 30 * 86_400_000).toISOString(),
        new Date().toISOString(),
      ],
    },
    {
      name: 'Q4 audit list (user filter)',
      evidence:
        'audit.repository.ts listAuditEvents — WHERE user_id=$1 ORDER BY created_at DESC, id DESC',
      sql: `SELECT id, event_type, outcome, created_at
              FROM authentication_audit_events
             WHERE user_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT 50 OFFSET 0`,
      params: () => [randomHexUuid('user-' + Math.floor(Math.random() * 250))],
    },
    {
      name: 'Q5 appointment list per request',
      evidence:
        'handyman-appointment.repository.ts listHandymanVisitAppointments — WHERE client_id=$1 AND handyman_request_id=$2 ORDER BY created_at DESC, id DESC',
      sql: `SELECT id, state, start_at, end_at
              FROM handyman_visit_appointments
             WHERE client_id = $1 AND handyman_request_id = $2
             ORDER BY created_at DESC, id DESC`,
      params: () => {
        const r = 1 + Math.floor(Math.random() * 8000);
        return [randomHexUuid(`client-${r % 12}`), randomHexUuid(`${r}-req`)];
      },
    },
    {
      name: 'Q6 execution-scope assignment stage',
      evidence:
        'handyman-sla-status-api.service.ts composeStatusVisibility — WHERE execution_scope_id=$1 ORDER BY (status = \'ACTIVE\') DESC, assigned_at DESC, id DESC',
      sql: `SELECT id, status, handyman_provider_context_id, handyman_crew_id
              FROM handyman_execution_scope_assignments
             WHERE execution_scope_id = $1
             ORDER BY (status = 'ACTIVE') DESC, assigned_at DESC, id DESC`,
      params: () => [randomHexUuid('scope-' + (1 + Math.floor(Math.random() * 12000)))],
    },
    {
      name: 'Q7 arrival stage latest',
      evidence:
        'handyman-sla-status-api.service.ts composeStatusVisibility — WHERE execution_scope_id=$1 ORDER BY evaluated_at DESC, created_at DESC, id DESC LIMIT 1',
      sql: `SELECT id, status, primary_reason
              FROM handyman_arrival_verification_results
             WHERE execution_scope_id = $1
             ORDER BY evaluated_at DESC, created_at DESC, id DESC
             LIMIT 1`,
      params: () => [randomHexUuid('scope-' + (1 + Math.floor(Math.random() * 12000)))],
    },
    {
      name: 'Q8 warranty claims stage',
      evidence:
        'handyman-sla-status-api.service.ts composeStatusVisibility — WHERE execution_scope_id=$1 ORDER BY created_at DESC, id DESC',
      sql: `SELECT id, status
              FROM handyman_service_warranty_claims
             WHERE execution_scope_id = $1
             ORDER BY created_at DESC, id DESC`,
      params: () => [randomHexUuid('scope-' + (1 + Math.floor(Math.random() * 12000)))],
    },
  ];
}

/** Deterministic md5()-based UUID matching the fixture generator. */
function randomHexUuid(seed: string): string {
  return md5Uuid(seed);
}

function md5Uuid(seed: string): string {
  // Mirror SQL md5(text)::uuid formatting.
  const hex = createHash('md5').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function measure(
  pool: Pool,
  query: TimedQuery,
): Promise<{ medianMs: number; p95Ms: number; plan: string }> {
  const timings: number[] = [];
  for (let i = 0; i < WARMUPS + ITERATIONS; i++) {
    const params = query.params();
    const start = process.hrtime.bigint();
    await pool.query(query.sql, params);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    if (i >= WARMUPS) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  const explain = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query.sql}`,
    query.params(),
  );
  return {
    medianMs: Number(timings[Math.floor(timings.length / 2)]!.toFixed(3)),
    p95Ms: Number(percentile(timings, 95).toFixed(3)),
    plan: explain.rows.map((row) => row['QUERY PLAN']).join('\n'),
  };
}

async function tableSizes(pool: Pool): Promise<Record<string, string>> {
  const result = await pool.query<{ table_name: string; total: string; indexes: string }>(
    `SELECT relname AS table_name,
            pg_size_pretty(pg_total_relation_size(relid)) AS total,
            pg_size_pretty(pg_indexes_size(relid)) AS indexes
       FROM pg_catalog.pg_statio_user_tables
      WHERE relname = ANY($1::text[])`,
    [[
      'handyman_service_requests',
      'handyman_visit_appointments',
      'handyman_execution_scope_assignments',
      'handyman_arrival_verification_results',
      'handyman_service_warranty_claims',
      'authentication_audit_events',
    ]],
  );
  const sizes: Record<string, string> = {};
  for (const row of result.rows) {
    sizes[row.table_name] = `total=${row.total}, indexes=${row.indexes}`;
  }
  return sizes;
}

const NEW_INDEXES: readonly { name: string; sql: string }[] = [
  {
    name: 'handyman_service_requests_client_created_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_service_requests_client_created_idx ON handyman_service_requests (client_id, created_at, id)`,
  },
  {
    name: 'handyman_visit_appointments_request_created_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_visit_appointments_request_created_idx ON handyman_visit_appointments (client_id, handyman_request_id, created_at DESC, id DESC)`,
  },
  {
    name: 'handyman_es_assignments_scope_assigned_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_es_assignments_scope_assigned_idx ON handyman_execution_scope_assignments (execution_scope_id, assigned_at DESC, id DESC)`,
  },
  {
    name: 'handyman_arrival_results_scope_evaluated_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_arrival_results_scope_evaluated_idx ON handyman_arrival_verification_results (execution_scope_id, evaluated_at DESC, created_at DESC, id DESC)`,
  },
  {
    name: 'handyman_service_warranty_claims_scope_created_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS handyman_service_warranty_claims_scope_created_idx ON handyman_service_warranty_claims (execution_scope_id, created_at DESC, id DESC)`,
  },
  {
    name: 'authentication_audit_events_created_at_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS authentication_audit_events_created_at_id_idx ON authentication_audit_events (created_at DESC, id DESC)`,
  },
  {
    name: 'authentication_audit_events_user_created_at_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS authentication_audit_events_user_created_at_id_idx ON authentication_audit_events (user_id, created_at DESC, id DESC)`,
  },
];

async function main(): Promise<void> {
  const config = requireScratchConfig();
  if (config.name !== BENCH_DB) {
    throw new Error(`Refusing to benchmark any database other than ${BENCH_DB}`);
  }

  await withAdmin(config, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${BENCH_DB}`);
    await admin.query(`CREATE DATABASE ${BENCH_DB}`);
  });

  const pool = createPool(config);
  console.log('Applying repository migrations…');
  const applied = await migrateUp(pool);
  console.log(`Applied ${applied.length} migrations (chain includes 0434_handyman_db_opt_indexes).`);

  console.log('Loading SYNTHETIC fixtures…');
  await loadSyntheticFixtures(pool);

  // Baseline: remove the 0434 indexes to reproduce the pre-change planner.
  for (const index of NEW_INDEXES) {
    await pool.query(`DROP INDEX IF EXISTS ${index.name}`);
  }
  await pool.query('ANALYZE');

  const sizesBefore = await tableSizes(pool);
  const queries = targetQueries();
  const results: QueryResult[] = [];

  console.log('Measuring BASELINE (0434 indexes absent)…');
  const beforeMeasurements = new Map<string, { medianMs: number; p95Ms: number; plan: string }>();
  for (const query of queries) {
    console.log(`  before: ${query.name}`);
    beforeMeasurements.set(query.name, await measure(pool, query));
  }

  console.log('Building the 0434 indexes (CONCURRENTLY, as the migration does)…');
  for (const index of NEW_INDEXES) {
    await pool.query(index.sql);
  }
  await pool.query('ANALYZE');

  console.log('Measuring AFTER (0434 indexes present)…');
  for (const query of queries) {
    console.log(`  after:  ${query.name}`);
    const after = await measure(pool, query);
    results.push({
      name: query.name,
      evidence: query.evidence,
      before: beforeMeasurements.get(query.name)!,
      after,
    });
  }
  const sizesAfter = await tableSizes(pool);

  const version = (await pool.query('SELECT version() AS v')).rows[0]?.v ?? 'unknown';
  const report = {
    generatedAt: new Date().toISOString(),
    disclaimer:
      'SYNTHETIC fixture benchmark on an isolated scratch database — NOT a live production measurement.',
    postgresVersion: version,
    fixtureVolumes: {
      handyman_service_requests: 60000,
      handyman_visit_appointments: 40000,
      handyman_execution_scope_assignments: 40000,
      handyman_arrival_verification_results: 36000,
      handyman_service_warranty_claims: 36000,
      authentication_audit_events: 200000,
    },
    iterations: ITERATIONS,
    warmups: WARMUPS,
    sizesBefore,
    sizesAfter,
    results,
  };

  const outDir = resolve(process.cwd(), 'scripts/db-bench/out');
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'bench-results.json'), JSON.stringify(report, null, 2));

  console.log('\n=== CR-HM-DB-OPT-01 synthetic benchmark (median / p95 ms) ===');
  for (const row of results) {
    console.log(
      `${row.name}\n  before: ${row.before.medianMs} / ${row.before.p95Ms}\n  after:  ${row.after.medianMs} / ${row.after.p95Ms}`,
    );
  }
  console.log('\nTable sizes before:', sizesBefore);
  console.log('Table sizes after:', sizesAfter);
  console.log(`\nFull report: scripts/db-bench/out/bench-results.json (${version})`);

  await pool.end();
  await withAdmin(config, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${BENCH_DB}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
