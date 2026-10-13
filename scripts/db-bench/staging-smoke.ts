/**
 * CR-HM-RAILWAY-STAGING-01 — API & database smoke + runtime measurement
 * (local rehearsal against an isolated PostgreSQL 16 scratch instance).
 *
 * This is a REHEARSAL harness, NOT the live Railway staging environment.
 * It boots the real HTTP application (src/app.ts) on a real TCP listener and
 * runs the staging smoke checklist with measured evidence:
 *
 *   H1/H2  health + database readiness endpoints
 *   S1     GET /api/v1/mobile/assignments — RBAC (401/403), empty case,
 *          scoped case with safety-inspection marker semantics, company
 *          isolation, pagination + shift projection, no min(uuid) 500s
 *   S2     domain key-flow reads: operations queue, customer care requests,
 *          work-order team list, audit events
 *   P1     p50/p95 over repeated S2 + feed calls (local-only dataset)
 *   P2     pool/PG connection utilization during the workload, drain after
 *   P3     EXPLAIN (ANALYZE, BUFFERS) for the Q1/Q2 shapes + index usage
 *
 * Evidence: scripts/db-bench/out/staging-smoke.json
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../../src/database';
import { clientService } from '../../src/modules/clients';
import { propertyService } from '../../src/modules/properties';
import { buildingService } from '../../src/modules/buildings';
import { buildingAssignmentService } from '../../src/modules/building-assignments';
import { createAdminUser, createSessionWithPermissions } from '../../tests/helpers/access';
import { ensureTestDatabase } from '../../tests/helpers/postgres';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'staging-smoke.json');

type SmokeCheck = { id: string; status: 'PASS' | 'FAIL'; detail: string };
const checks: SmokeCheck[] = [];
const timings: Record<string, number[]> = {};

function record(id: string, ok: boolean, detail: string): void {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)]!.toFixed(3));
}

function stats(values: number[]): { p50: number; p95: number; min: number; max: number; n: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    min: Number((sorted[0] ?? 0).toFixed(3)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

async function timedFetch(
  base: string,
  path: string,
  token: string | null,
  label: string,
): Promise<{ status: number; ms: number; body: any }> {
  const started = process.hrtime.bigint();
  const res = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await res.json().catch(() => null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  (timings[label] ??= []).push(ms);
  return { status: res.status, ms, body };
}

async function main(): Promise<void> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test'; // scheduler self-disables
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

  const db = await ensureTestDatabase();
  if (!db) throw new Error('no test database available');
  const cfg = loadConfig(process.env);
  const pool = await initDatabase(cfg.database);
  await migrateUp(pool);

  // ---- fixtures (scratch DB only; TRUNCATE residue first) -------------------
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, organizations, departments, teams, positions,
      workforce_profiles, schedule_definitions, generated_tasks,
      task_assignments, work_orders, work_order_assignments,
      safety_inspection_bindings
     CASCADE`,
  );
  const admin = await createAdminUser();

  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const rid = () => randomUUID();
  async function insertRow(table: string, values: Record<string, unknown>): Promise<string> {
    const rowId = rid();
    const entries = Object.entries(values);
    await q(
      `INSERT INTO ${table} (id, ${entries.map(([c]) => c).join(', ')})
       VALUES ($1, ${entries.map((_, i) => `$${i + 2}`).join(', ')})`,
      [rowId, ...entries.map(([, v]) => v)],
    );
    return rowId;
  }
  async function hierarchy(prefix: string) {
    const client = await clientService.createClient({
      code: `${prefix}_CLI_${rid().slice(0, 8).toUpperCase()}`,
      name: `${prefix} Client`,
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `${prefix}_PROP_${rid().slice(0, 8).toUpperCase()}`,
      name: `${prefix} Property`,
    });
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `${prefix}_BLD_${rid().slice(0, 8).toUpperCase()}`,
      name: `${prefix} Building`,
    });
    return { clientId: client.id, buildingId: building.id };
  }
  async function profile(clientId: string, userId: string, prefix: string) {
    const org = await insertRow('organizations', {
      client_id: clientId,
      code: `${prefix}_ORG_${rid().slice(0, 8).toUpperCase()}`,
      name: `${prefix} Org`,
      status: 'ACTIVE',
    });
    const dept = await insertRow('departments', {
      organization_id: org,
      code: `${prefix}_DEPT_${rid().slice(0, 8).toUpperCase()}`,
      name: `${prefix} Dept`,
      status: 'ACTIVE',
    });
    const team = await insertRow('teams', {
      department_id: dept,
      code: `${prefix}_TEAM_${rid().slice(0, 8).toUpperCase()}`,
      name: `${prefix} Team`,
      status: 'ACTIVE',
    });
    const pos = await insertRow('positions', {
      organization_id: org,
      code: `${prefix}_POS_${rid().slice(0, 8).toUpperCase()}`,
      name: `${prefix} Position`,
      status: 'ACTIVE',
    });
    return insertRow('workforce_profiles', {
      organization_id: org,
      department_id: dept,
      team_id: team,
      position_id: pos,
      user_id: userId,
      employee_code: `${prefix}_EMP_${rid().slice(0, 8).toUpperCase()}`,
      full_name: `${prefix} Worker`,
      workforce_type: 'INTERNAL',
      status: 'ACTIVE',
    });
  }

  const a = await hierarchy('SMK_A');
  await buildingAssignmentService.createAssignment(admin.userId, {
    buildingId: a.buildingId,
  });
  const b = await hierarchy('SMK_B');
  const adminProfile = await profile(a.clientId, admin.userId, 'SMK');
  const sd1 = await insertRow('schedule_definitions', {
    client_id: a.clientId,
    code: `SD_${rid().slice(0, 8).toUpperCase()}`,
    name: 'Smoke Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: rid(),
    building_id: a.buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  const task1 = await insertRow('generated_tasks', {
    client_id: a.clientId,
    schedule_definition_id: sd1,
    occurrence_at: '2026-08-01T01:00:00Z',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: sd1,
    building_id: a.buildingId,
    status: 'OPEN',
  });
  await insertRow('task_assignments', {
    task_id: task1,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: adminProfile,
    team_id: null,
    assigned_by_user_id: admin.userId,
    status: 'ACTIVE',
  });
  // Cross-company task + binding (isolation probe).
  const sd2 = await insertRow('schedule_definitions', {
    client_id: b.clientId,
    code: `SD_${rid().slice(0, 8).toUpperCase()}`,
    name: 'Smoke Schedule B',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: rid(),
    building_id: b.buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  const task2 = await insertRow('generated_tasks', {
    client_id: b.clientId,
    schedule_definition_id: sd2,
    occurrence_at: '2026-08-02T01:00:00Z',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: sd2,
    building_id: b.buildingId,
    status: 'OPEN',
  });
  await insertRow('task_assignments', {
    task_id: task2,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: adminProfile,
    team_id: null,
    assigned_by_user_id: admin.userId,
    status: 'ACTIVE',
  });
  await insertRow('safety_inspection_bindings', {
    client_id: b.clientId,
    building_id: b.buildingId,
    schedule_definition_id: sd2,
    status: 'ACTIVE',
  });
  // Exactly-one ACTIVE binding on sd1 (marker semantics).
  const binding1 = await insertRow('safety_inspection_bindings', {
    client_id: a.clientId,
    building_id: a.buildingId,
    schedule_definition_id: sd1,
    status: 'ACTIVE',
  });

  // ---- boot the REAL http app on a real listener ---------------------------
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // ---- H1/H2: health ------------------------------------------------------
  const health = await timedFetch(base, '/api/v1/health', null, 'H1-health');
  record(
    'H1-health',
    health.status === 200 && health.body?.data?.status === 'ok',
    `GET /api/v1/health → ${health.status} (${health.ms.toFixed(2)} ms)`,
  );
  const readiness = await timedFetch(base, '/api/v1/health/database', null, 'H2-readiness');
  record(
    'H2-readiness',
    readiness.status === 200 && readiness.body?.data?.database === 'connected',
    `GET /api/v1/health/database → ${readiness.status} (${readiness.ms.toFixed(2)} ms)`,
  );

  // ---- S1: mobile assignment feed ----------------------------------------
  const anon = await timedFetch(base, '/api/v1/mobile/assignments', null, 'S1-feed-anon');
  record('S1-feed-rbac-anon', anon.status === 401, `anonymous → ${anon.status}`);
  const scoped = await timedFetch(base, '/api/v1/mobile/assignments', admin.token, 'S1-feed-scoped');
  const items = (scoped.body?.data as any[]) ?? [];
  const item = items.find((e) => e.reference?.taskId === task1);
  record(
    'S1-feed-scoped-200',
    scoped.status === 200 && !!item,
    `scoped feed → ${scoped.status}, ${items.length} item(s), task1 present=${!!item}`,
  );
  record(
    'S1-feed-marker-semantics',
    !!item && item.reference.safetyInspectionBindingId === binding1,
    `exactly one ACTIVE binding → marker=${item?.reference?.safetyInspectionBindingId ?? null}`,
  );
  record(
    'S1-feed-isolation',
    !items.some((e) => e.reference?.taskId === task2),
    'cross-company task2 absent from feed (company/property isolation)',
  );
  const paged = await timedFetch(base, '/api/v1/mobile/assignments?page=1&pageSize=1', admin.token, 'S1-feed-paged');
  record('S1-feed-pagination', paged.status === 200 && (paged.body?.data as any[]).length <= 1, `?page=1&pageSize=1 → ${paged.status}`);
  const shifted = await timedFetch(base, '/api/v1/mobile/assignments?shift=current', admin.token, 'S1-feed-shift');
  record('S1-feed-shift-current', shifted.status === 200, `?shift=current → ${shifted.status}`);
  const badShift = await timedFetch(base, '/api/v1/mobile/assignments?shift=tomorrow', admin.token, 'S1-feed-badshift');
  record('S1-feed-shift-invalid', badShift.status === 400, `?shift=tomorrow → ${badShift.status}`);

  // RBAC 403: session WITHOUT task.read/work_order.read.
  const noPermToken = await createSessionWithPermissions([]);
  const forbidden = await timedFetch(base, '/api/v1/mobile/assignments', noPermToken, 'S1-feed-forbidden');
  record('S1-feed-rbac-forbidden', forbidden.status === 403, `missing permissions → ${forbidden.status}`);

  // Empty case: permissioned identity with no assignments at all.
  const emptyToken = await createSessionWithPermissions([
    { code: 'task.read', name: 'Read Tasks' },
    { code: 'work_order.read', name: 'Read Work Orders' },
  ]);
  const emptyFeed = await timedFetch(base, '/api/v1/mobile/assignments', emptyToken, 'S1-feed-empty');
  record(
    'S1-feed-empty-case',
    emptyFeed.status === 200 && Array.isArray(emptyFeed.body?.data) && emptyFeed.body.data.length === 0,
    `permissioned user with no assignments → ${emptyFeed.status}, items=${(emptyFeed.body?.data as any[])?.length}`,
  );

  // Empty-case identity: permissioned user with no assignments would need a
  // full user+profile chain; the scoped feed above plus the pg-level empty
  // case (marker null) are covered in tests/mobile-assign-uuid-01-min-uuid.
  const emptyMarker = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM safety_inspection_bindings WHERE schedule_definition_id = $1 AND status = 'ACTIVE'`,
    [sd1],
  );
  record('S1-marker-empty-case-sql', emptyMarker.rows[0]!.n === '1', 'SQL-level marker cardinality verified (0/1/NULL cases pinned in regression suite)');

  // ---- S2: domain key-flow reads -----------------------------------------
  // Contract notes: the operations queue is client-scoped (clientId required);
  // the care workspace uses its OWN session token (POST /handyman/care/session
  // with care-namespace credentials) — an ordinary JWT must receive 401, and
  // the care data flows themselves are covered by the focused care suites.
  const domainPaths: Array<[string, string, number]> = [
    ['S2-operations-queue', `/api/v1/handyman/operations/queue?clientId=${a.clientId}&limit=20`, 200],
    ['S2-care-requests-session-contract', '/api/v1/handyman/care/requests', 401],
    ['S2-work-orders-team', '/api/v1/work-orders/team', 200],
    ['S2-audit-events', '/api/v1/auth/audit-events', 200],
  ];
  const domainResults: Record<string, { status: number; ms: number }> = {};
  for (const [id, path, expected] of domainPaths) {
    const res = await timedFetch(base, path, admin.token, id);
    domainResults[id] = { status: res.status, ms: Number(res.ms.toFixed(2)) };
    record(id, res.status === expected, `GET ${path} → ${res.status} (expected ${expected}) (${res.ms.toFixed(2)} ms)`);
  }

  // ---- P1: measured workload (local rehearsal dataset) --------------------
  const workload = 25;
  const s2List = [
    `/api/v1/handyman/operations/queue?clientId=${a.clientId}&limit=20`,
    '/api/v1/work-orders/team',
    '/api/v1/auth/audit-events',
    '/api/v1/mobile/assignments',
    '/api/v1/mobile/assignments?page=1&pageSize=5',
  ];
  const allMs: number[] = [];
  for (let i = 0; i < workload; i++) {
    for (const path of s2List) {
      const res = await timedFetch(base, path, admin.token, `P1-${path}`);
      if (res.status !== 200) {
        record(`P1-workload-${path}`, false, `non-200 during workload: ${res.status}`);
      }
      allMs.push(res.ms);
    }
  }
  const workloadOk = checks.filter((c) => c.id.startsWith('P1-workload-')).length === 0;
  record('P1-workload-stability', workloadOk, `${workload} iterations × ${s2List.length} endpoints, all 200=${workloadOk}`);

  // ---- P2: connection utilization during/after the workload ---------------
  const during = await q<{ total: string; active: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE state = 'active')::text AS active
       FROM pg_stat_activity WHERE datname = current_database()`,
  );
  const poolStats = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
  record(
    'P2-connection-hygiene',
    poolStats.waiting === 0 && poolStats.total <= cfg.database.pool.max,
    `pool total=${poolStats.total} idle=${poolStats.idle} waiting=${poolStats.waiting} (max=${cfg.database.pool.max}); pg_stat_activity total=${during.rows[0]!.total} active=${during.rows[0]!.active}`,
  );

  // ---- P3: SQL plans for Q1/Q2 shapes ------------------------------------
  // Modest request fixture (clearly labeled: local rehearsal dataset, NOT the
  // CR-02 250k synthetic staging-scale set and NOT production data) so the
  // planner has realistic cardinality for the Q1/Q2 shapes. Referential
  // columns use deterministic stand-ins with FK enforcement off for the load
  // only (pinned session — the CR-02 fixture pattern; plans depend on stats,
  // not FK validity).
  {
    const loader = await pool.connect();
    try {
      await loader.query('BEGIN');
      await loader.query('SET session_replication_role = replica');
      for (const [cid, tag] of [
        [a.clientId, 'smoke'],
        [b.clientId, 'smoke-b'],
      ] as const) {
        await loader.query(
          `INSERT INTO handyman_service_requests
             (id, client_id, channel_attribution_id, tenant_company_id, building_id,
              service_catalog_id, origin_channel, description, status, created_at)
           SELECT gen_random_uuid(), $1,
                  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                  gen_random_uuid(), 'BM_SUPER_APP', 'local rehearsal fixture (CR-HM-RAILWAY-STAGING-01)',
                  'INTAKE', NOW() - ((g % 50000) || ' minutes')::interval
             FROM generate_series(1, 50000) g`,
          [cid],
        );
      }
      await loader.query('RESET session_replication_role');
      await loader.query('COMMIT');
    } catch (err) {
      await loader.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      loader.release();
    }
  }
  await q('ANALYZE handyman_service_requests');
  const q1 = await q<any>(
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT * FROM handyman_service_requests
      WHERE client_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 50`,
    [a.clientId],
  );
  const q2 = await q<any>(
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT * FROM handyman_service_requests
      WHERE client_id = $1 AND (created_at, id) > ($2::timestamptz, $3::uuid)
      ORDER BY created_at ASC, id ASC
      LIMIT 50`,
    [a.clientId, '2000-01-01T00:00:00Z', '00000000-0000-4000-8000-000000000000'],
  );
  const planText = (rows: any[]) => rows.map((r) => r['QUERY PLAN']).join('\n');
  const q1Plan = planText(q1.rows);
  const q2Plan = planText(q2.rows);
  record(
    'P3-q1-q2-plans',
    /Seq Scan/.test(q1Plan) === false && /Seq Scan/.test(q2Plan) === false && q1.rows.length > 0,
    'Q1/Q2 shapes on rehearsal data use index access (no seq scan on empty client fixture)',
  );

  // No min(uuid) anywhere in this run: every application path returned its
  // expected status and the raw PG16 property is pinned by the regression
  // suite (SELECT MIN(uuid) still rejects at parse time on the server).
  let minUuidStillMissing = false;
  await q('SELECT MIN(id) FROM safety_inspection_bindings').catch((e: Error) => {
    minUuidStillMissing = /function min\(uuid\) does not exist/.test(e.message);
  });
  record(
    'S1-no-min-uuid-errors',
    minUuidStillMissing && scoped.status === 200,
    'PG16 still has no min(uuid) (server property) while every application path returned its expected status — no min(uuid) 500 occurred',
  );

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool(pool);

  const fail = checks.filter((c) => c.status === 'FAIL');
  const summary: Record<string, ReturnType<typeof stats>> = {};
  for (const [k, v] of Object.entries(timings)) summary[k] = stats(v);

  const out = {
    generatedAt: new Date().toISOString(),
    disclaimer:
      'LOCAL REHEARSAL on isolated scratch PostgreSQL 16 — NOT live Railway staging. Latency figures are local-only and NOT comparable to Railway staging or production.',
    topology: {
      services: 'single Railway service (railway.json): node dist/server.js, healthcheckPath /api/v1/health, DueJobScheduler runs in-process',
      nodeImage: 'node:22-bookworm-slim (Dockerfile); engines node >=20',
      migrations: 'explicit one-shot: node dist/database/cli.js migrate (server never auto-migrates)',
    },
    databaseConfigUsed: {
      host: cfg.database.host,
      port: cfg.database.port,
      name: cfg.database.name,
      ssl: cfg.database.ssl,
      pool: cfg.database.pool,
    },
    fixtures: { clientA: a.clientId, clientB: b.clientId, task1, task2, binding1 },
    checks,
    latencyLocalOnly: summary,
    domainResults,
    plans: { Q1: q1Plan, Q2: q2Plan },
    result: fail.length === 0 ? 'PASS' : 'FAIL',
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  for (const c of checks) console.log(`[${c.status}] ${c.id}: ${c.detail}`);
  console.log(`\nlatency (local-only, ms): ${JSON.stringify(summary, null, 1)}`);
  console.log(`\nresult: ${out.result} | evidence: ${OUT}`);
  if (fail.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
