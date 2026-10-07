/**
 * R10 PART 15 — SECURITY_OPERATIONAL_DETAIL / source=PATROL.
 *
 * EXECUTED FOR REAL: the 17-entry dataset enum, the SECURITY_OPERATIONAL_DETAIL registry
 * adapter (including its required `source` discriminator, its fail-closed guard and its
 * required buildingId assertion), the PATROL projection, and the owning BE-12M read — the
 * real `parseReportQuery`, the real `securityReportService.getPatrolDataset`, the real
 * `resolveBuildingScope` path and the real patrol SQL generation and row mapping. The
 * generated SQL, bound parameters and mapped rows are OBSERVED, not read from source text.
 *
 * ONLY THE I/O BOUNDARY IS FAKED via `module.registerHooks` (the PART 13/14/14B technique):
 * `src/database` returns canned driver rows and `../buildings` / `../context-access` return a
 * canned authorized scope. The `../security-reports` specifier is served by a router-free
 * FACADE that re-exports the real service and the real validation module, because the
 * module's public index also re-exports `createSecurityReportRouter`, whose express -> auth ->
 * bcryptjs chain cannot load without node_modules. The production adapter imports the public
 * index, which is asserted statically below. Every other registry sibling is an inert stub:
 * those adapters are never invoked here.
 *
 * node_modules is absent, so there is no tsc/vitest; assertions run under `node --test` with
 * native TypeScript type stripping. Hooks are process-wide and rely on `node --test` per-file
 * process isolation. Live-PostgreSQL execution remains CI-required.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Diff against a FIXED baseline so the file-budget proofs hold before and after commit. */
const BASE = '656174e9559f97068fc11c2f2ef70c25fac52959';

const TASK = '11111111-1111-4111-8111-111111111111';
const BIND1 = '22222222-2222-4222-8222-222222222222';
const BIND2 = '33333333-3333-4333-8333-333333333333';
const ROUTE = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';
const BLDG = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';

const ctl = { calls: [], rows: [] };
globalThis.__P15 = ctl;

/** Two ACTIVE bindings for one schedule definition: same task, different binding identity. */
const dbRow = (bindingId, routeCode, status) => ({
  task_id: TASK, patrol_schedule_binding_id: bindingId, patrol_route_id: ROUTE,
  patrol_route_code: routeCode, patrol_route_name: `Route ${routeCode}`,
  start_security_post_id: POST, start_security_post_code: 'POST-1',
  start_security_post_name: 'Main Gate', status,
  occurrence_at: new Date('2026-03-01T08:00:00.000Z'),
  started_at: new Date('2026-03-01T08:05:00.000Z'), completed_at: null,
  completed_by_user_id: null,
});

const REG = 'src/modules/reporting-export/reporting-export.registry.ts';
const registrySrc = rd(REG);
/** Registry siblings stubbed inertly: never invoked by the SECURITY_OPERATIONAL_DETAIL adapter. */
const INERT = ['finding-register', 'management-operations-command-center',
  'security-finding-incident-kpi', 'security-patrol-kpi', 'utility-kpi',
  'checklist-execution-summary', 'vendor-service-register', 'work-order-register',
  'work-order-sla-register', 'scheduled-operation-lineage', 'permit-to-work-register',
  'vendor-tenant-kpi', 'workforce-kpi', 'operational-detail-reporting', 'corrective-actions',
  'operational-detail-evidence', 'operational-detail-finding-rework',
  'operational-detail-review-history'];
const inertNames = (dir) => {
  // [^}]* — a lazy dot-all match would span earlier import blocks and capture their braces.
  const re = new RegExp(`import \\{([^}]*)\\} from '\\.\\./${dir}';`, 'g');
  const out = [];
  for (const m of registrySrc.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().replace(/^type\s+/, '');
      if (n && !raw.trim().startsWith('type ')) out.push(n);
    }
  }
  return [...new Set(out)];
};
const abs = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const STUBS = new Map([[path.join(ROOT, 'src/database/index.ts'), 'database']]);
for (const d of INERT) STUBS.set(path.join(ROOT, `src/modules/${d}/index.ts`), d);
STUBS.set(path.join(ROOT, 'src/modules/buildings/index.ts'), 'buildings');
STUBS.set(path.join(ROOT, 'src/modules/context-access/index.ts'), 'context-access');
STUBS.set(path.join(ROOT, 'src/modules/security-reports/index.ts'), 'security-reports');

const SRC = {
  pg: 'export class Pool {}\nexport default { Pool };',
  database: `export const getPool = () => ({ query: async (sql, params) => {
    const c = globalThis.__P15; c.calls.push({ sql, params });
    return { rows: c.rows, rowCount: c.rows.length }; } });`,
  buildings: `export { buildingNotFoundError } from ${JSON.stringify(abs('src/modules/buildings/building.errors.ts'))};
export const buildingRepository = { findById: async (id) => ({ id }) };`,
  'context-access': `export const contextAccessService = {
    getAccessibleBuildingIds: async () => [], assertBuildingAccess: async () => undefined };`,
  // Router-free facade over the REAL service and the REAL validation module.
  'security-reports': `export { securityReportService } from ${JSON.stringify(abs('src/modules/security-reports/security-report.service.ts'))};
export { parseReportQuery, reportRange } from ${JSON.stringify(abs('src/modules/security-reports/security-report.validation.ts'))};`,
};
for (const d of INERT) SRC[d] = inertNames(d).map((n) => `export const ${n} = () => {};`).join('\n');

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'pg') return { url: 'stub:pg', shortCircuit: true };
    if (spec.startsWith('.') && ctx.parentURL?.startsWith('file:')) {
      let p = path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), spec);
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        if (fs.existsSync(`${p}.ts`)) p = `${p}.ts`;
        else if (fs.existsSync(path.join(p, 'index.ts'))) p = path.join(p, 'index.ts');
        else return next(spec, ctx);
      }
      const name = STUBS.get(p);
      return name ? { url: `stub:${name}`, shortCircuit: true } : { url: pathToFileURL(p).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith('stub:')) {
      const n = url.slice(5);
      if (SRC[n] !== undefined) return { format: 'module', shortCircuit: true, source: SRC[n] };
    }
    return next(url, ctx);
  },
});

const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const registry = await import('../src/modules/reporting-export/reporting-export.registry.ts');
const DATASETS = types.REPORTING_EXPORT_DATASETS;
const ADAPTER = registry.REPORTING_EXPORT_DATASET_REGISTRY.SECURITY_OPERATIONAL_DETAIL;
const docBlock = rd('docs/api/openapi.yaml').split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const oaEnum = [...docBlock.slice(docBlock.indexOf('enum:'), docBlock.indexOf('description:')).matchAll(/[A-Z][A-Z0-9_]{3,}/g)].map((m) => m[0]);
const DOC = docBlock.slice(docBlock.indexOf('SECURITY_OPERATIONAL_DETAIL (R10)')).replace(/\s+/g, ' ');
/** The 13 authoritative fields, read from the FROZEN PART 14B public row type. */
const PATROL_FIELDS = (() => {
  const t = rd('src/modules/security-reports/security-report.types.ts');
  const i = t.indexOf('export type PublicPatrolDatasetRow = {');
  return [...t.slice(i, t.indexOf('\n};', i)).matchAll(/^ {2}(\w+)(\??): ([^;]+);/gm)].map((m) => m[1]);
})();

/** Runs the REAL adapter end to end and returns its result plus the observed SQL. */
async function load(query, rows = []) {
  ctl.calls = []; ctl.rows = rows;
  try { return { res: await ADAPTER.load(query, USER), calls: ctl.calls }; }
  catch (e) { return { err: e, calls: ctl.calls }; }
}
const details = (e) => (e.details ?? []).map((d) => `${d.field}: ${d.message}`).join(' | ');

test('PART 15 — dataset enum 16 -> 17 with runtime/OpenAPI/registry parity', () => {
  assert.equal(DATASETS.length, 17);                                    // 1
  assert.equal(oaEnum.length, 17);                                       // 2
  assert.deepEqual([...oaEnum].sort(), [...DATASETS].sort());            // 3
  assert.equal(DATASETS.filter((d) => d === 'SECURITY_OPERATIONAL_DETAIL').length, 1);  // 4
  assert.equal(DATASETS[16], 'SECURITY_OPERATIONAL_DETAIL');
  for (const prior of ['SECURITY_PATROL', 'PERMIT_TO_WORK', 'SCHEDULED_OPERATION_LINEAGE',
    'WORK_ORDER_SLA', 'OPERATIONAL_DETAIL_HISTORY', 'CORRECTIVE_ACTION', 'OPERATIONAL_DETAIL']) {
    assert.ok(DATASETS.includes(prior), `${prior} still present`);       // 5
  }
  // No source-specific dataset enum entry and no alias.
  assert.deepEqual(DATASETS.filter((d) => /PATROL|SECURITY_OPERATIONAL/.test(d)),
    ['SECURITY_PATROL', 'SECURITY_OPERATIONAL_DETAIL']);
  assert.equal(DATASETS.includes('PATROL_DETAIL'), false);
  assert.equal(DATASETS.includes('PATROL_OPERATIONAL_DETAIL'), false);
  const keys = Object.keys(registry.REPORTING_EXPORT_DATASET_REGISTRY);
  assert.equal(keys.length, 17);
  assert.deepEqual([...keys].sort(), [...DATASETS].sort());
  // The staged source vocabulary is frozen and complete, with a real type guard.
  assert.deepEqual([...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']);
  assert.equal(types.isSecurityOperationalDetailSource('PATROL'), true);
  assert.equal(types.isSecurityOperationalDetailSource('patrol'), false, 'guard is exact-case');
});

test('PART 15 — adapter requires security_report.read, a source, and a buildingId', async () => {
  assert.equal(ADAPTER.dataset, 'SECURITY_OPERATIONAL_DETAIL');
  assert.equal(ADAPTER.requiredReadPermission, 'security_report.read');  // 6
  for (const bad of ['security.read', 'task.read', 'reporting.read', 'admin', 'security_patrol_kpi.read']) {
    assert.notEqual(ADAPTER.requiredReadPermission, bad);
  }
  // 7 — source is REQUIRED: no default, no inference, no silent empty result.
  for (const q of [{}, { buildingId: BLDG }, { source: '', buildingId: BLDG },
    { source: '   ', buildingId: BLDG }, { source: ['PATROL'], buildingId: BLDG },
    { source: 'BOTH', buildingId: BLDG }, { source: 'ALL', buildingId: BLDG }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.equal(err.statusCode, 400);
    assert.match(details(err), /^source: source is required/);
    assert.equal(calls.length, 0, 'the owning read is never reached');
  }
  // Declared but NOT implemented: fails closed instead of falling through to PATROL.
  for (const s of ['SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']) {
    const { err, calls } = await load({ source: s, buildingId: BLDG });
    assert.ok(err, `${s} must fail closed`);
    assert.match(details(err), new RegExp(`source ${s} is not implemented yet; supported: PATROL`));
    assert.equal(calls.length, 0, `${s} must not query the patrol read`);
  }
  // 8 — buildingId is REQUIRED for PATROL and never expands to all accessible Buildings.
  for (const q of [{ source: 'PATROL' }, { source: 'PATROL', buildingId: '' }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.match(details(err), /buildingId: buildingId is required for source=PATROL/);
    assert.equal(calls.length, 0, 'no roll-up query is issued');
  }
  // A malformed buildingId stays the owning parser's authority, not a second validation.
  const bad = await load({ source: 'PATROL', buildingId: 'not-a-uuid' });
  assert.match(details(bad.err), /buildingId must be a valid UUID/);
  // The owning parser normalizes case; Reporting adds no lowercase parser of its own.
  const ok = await load({ source: 'patrol', buildingId: BLDG }, []);
  assert.equal(ok.err, undefined);
  assert.equal(ok.res.appliedFilters.source, 'PATROL');
});

test('PART 15 — PATROL yields exactly one table at the (taskId, bindingId) grain', async () => {
  // securityPostId is supplied so the owning read's post FILTER predicate is actually
  // generated and can be proven unchanged (without it only the SELECT/JOIN COALESCE exists).
  const { res, calls } = await load(
    { source: 'PATROL', buildingId: BLDG, securityPostId: POST,
      dateFrom: '2026-03-01', dateTo: '2026-03-31' },
    [dbRow(BIND1, 'R-1', 'PENDING'), dbRow(BIND2, 'R-2', 'COMPLETED')]);
  assert.equal(calls.length, 1, 'the owning read is called exactly once');  // 9

  assert.equal(res.projected.tables.length, 1);                            // 11
  const t = res.projected.tables[0];
  assert.equal(t.key, 'securityOperationalPatrol');
  assert.equal(t.label, 'Security Operational Patrol');
  assert.deepEqual(res.projected.kpis, []);                                // 26
  assert.equal(t.columns.length, 13);
  assert.deepEqual(t.columns.map((c) => c.key), PATROL_FIELDS);            // 12
  assert.equal(PATROL_FIELDS.length, 13, 'authoritative row is 13 fields');
  assert.deepEqual(Object.keys(res.projected.tables[0].rows[0]), PATROL_FIELDS);
  for (const c of t.columns) assert.ok(['STRING', 'NUMBER', 'DATE', 'BOOLEAN'].includes(c.type));

  // 13, 14 — both identity fields verbatim; 16 — repeated taskId survives as two rows.
  assert.equal(t.rowCount, 2);
  assert.deepEqual(t.rows.map((r) => r.taskId), [TASK, TASK]);             // 13
  assert.deepEqual(t.rows.map((r) => r.patrolScheduleBindingId), [BIND1, BIND2]);  // 14
  assert.equal(new Set(t.rows.map((r) => `${r.taskId}:${r.patrolScheduleBindingId}`)).size, 2);
  // 15 — no generatedTaskId alias anywhere in the projection
  assert.equal('generatedTaskId' in t.rows[0], false);
  assert.equal(t.columns.some((c) => c.key === 'generatedTaskId' || c.label === 'Generated Task Id'), false);
  // Every other field is copied verbatim, including the nullable security post and actors.
  assert.deepEqual(t.rows[1], {
    taskId: TASK, patrolScheduleBindingId: BIND2, patrolRouteId: ROUTE, patrolRouteCode: 'R-2',
    patrolRouteName: 'Route R-2', securityPostId: POST, securityPostCode: 'POST-1',
    securityPostName: 'Main Gate', status: 'COMPLETED',
    occurrenceAt: '2026-03-01T08:00:00.000Z', startedAt: '2026-03-01T08:05:00.000Z',
    completedAt: null, completedByUserId: null,
  });
  for (const v of Object.values(t.rows[0])) {
    assert.ok(v === null || ['string', 'number', 'boolean'].includes(typeof v), 'renderer-safe scalar');
  }
  // Envelope: the authorized scope is exactly the requested Building, never a roll-up.
  assert.equal(res.common.buildingId, BLDG);
  assert.deepEqual(res.common.buildingScope, [BLDG]);
  assert.equal(res.common.dateFrom, '2026-03-01');
  assert.equal(res.common.dateTo, '2026-03-31');
  assert.match(res.common.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(calls[0].params[0], [BLDG], 'scope bound to SQL is the one Building');
  assert.equal(res.appliedFilters.source, 'PATROL');
  assert.equal(res.appliedFilters.buildingId, BLDG);

  // 10, 27 — the executed SQL is the owning patrol query, with its own post semantics.
  assert.match(calls[0].sql, /FROM generated_tasks gt\s+JOIN patrol_schedule_bindings psb\s+ON psb\.schedule_definition_id = gt\.schedule_definition_id/);
  assert.match(calls[0].sql, /COALESCE\(psb\.start_security_post_id, pr\.start_security_post_id\) = /);
  assert.equal(/psb\.start_security_post_id = [^)]* OR /.test(calls[0].sql), false, 'KPI OR-form not substituted');
  // 17, 18, 19 — nothing collapses rows
  const up = calls[0].sql.toUpperCase();
  for (const b of ['DISTINCT', 'GROUP BY', 'ROW_NUMBER', 'LATERAL', 'LIMIT']) {
    assert.equal(up.includes(b), false, `${b} must not appear`);
  }
});

test('PART 15 — no timeliness derivation, no KPI, no contributor claim, no CSV default', () => {
  const pj = rd('src/modules/reporting-export/reporting-export.r10-projections.ts');
  const body = pj.slice(pj.indexOf('export function projectSecurityOperationalPatrol'));
  const keys = [...body.matchAll(/\{ key: '(\w+)'/g)].map((m) => m[1]);
  const labels = [...body.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  // 21-24 — no materialized timeliness field
  for (const b of ['missed', 'isMissed', 'overdue', 'isOverdue', 'dueBefore', 'graceMinutes',
    'onTime', 'late', 'complianceStatus', 'patrolKpiContribution']) {
    assert.equal(keys.includes(b), false, `column ${b}`);
    assert.equal(labels.some((l) => l.toLowerCase() === b.toLowerCase()), false, `label ${b}`);
  }
  // 25 — no missed/overdue ARITHMETIC: the projection does no date math and reads no clock.
  const code = strip(body);
  assert.equal(/new Date\(|Date\.now\(|getTime\(\)|graceMinutes|dueBefore/.test(code), false);
  assert.equal(/[-+]\s*86400000|asOf\s*-/.test(code), false);
  // 20 — no primary/current/latest binding semantics, and no invented identity
  for (const b of ['primaryPatrolScheduleBinding', 'currentPatrolScheduleBinding',
    'latestPatrolScheduleBinding', 'selectedPatrolScheduleBinding', 'compositeId', 'rowKey']) {
    assert.equal(body.includes(b), false, b);
  }
  assert.equal(/patrolScheduleBindingId:.*(COALESCE|\?\?|\|\||\+|join)/.test(code), false,
    'the binding id is copied, never derived or synthesized');
  // 29 — no post-query filtering, dedup, sort, grouping or election
  assert.equal(/source\.(filter|sort|reduce|find|findIndex|some|every|flatMap)\(/.test(code), false);
  assert.equal(/new (Map|Set)\(/.test(code), false);
  assert.equal((code.match(/source\.map\(/g) ?? []).length, 1, 'a single 1:1 map');
  // 28 — no KPI contributor claim in the dataset label or the OpenAPI surface
  assert.equal(ADAPTER.datasetLabel, 'Security Operational Detail');
  assert.equal(/contributor/i.test(ADAPTER.datasetLabel), false);
  assert.ok(DOC.includes('NOT an exact contributor list'));
  // 30, 31 — no CSV default for this dataset; OPERATIONAL_DETAIL stays the only one
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.SECURITY_OPERATIONAL_DETAIL, undefined);
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(strip(rd(REG)).slice(strip(rd(REG)).indexOf('  SECURITY_OPERATIONAL_DETAIL: {')).includes('csvDefaultTableKey'), false);
});

test('PART 15 — Reporting holds no security SQL, and no forbidden file changed', () => {
  // 10 — no patrol/security SQL authored in Reporting (comments stripped: the adapter prose
  // legitimately names patrol_schedule_bindings to say it is never queried here).
  for (const f of fs.readdirSync(path.join(ROOT, 'src/modules/reporting-export'))) {
    if (!f.endsWith('.ts')) continue;
    const code = strip(rd(`src/modules/reporting-export/${f}`));
    for (const tbl of ['patrol_schedule_bindings', 'generated_tasks', 'patrol_routes', 'security_posts']) {
      assert.equal(code.includes(tbl), false, `${f} must hold no ${tbl} SQL`);
    }
  }
  // The production adapter really does import the owning module's PUBLIC index.
  assert.match(rd(REG), /from '\.\.\/security-reports';/);
  assert.equal(/from '\.\.\/security-reports\//.test(rd(REG)), false, 'no submodule import');
  assert.equal(/securityReportRepository/.test(strip(rd(REG))), false, 'repository never used');

  // 32-35 — everything outside the four authorized production files is untouched
  const changed = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const production = changed.filter((f) => !f.startsWith('tests/') && !f.startsWith('.audit'));
  assert.deepEqual(production.sort(), [
    'docs/api/openapi.yaml',
    'src/modules/reporting-export/reporting-export.r10-projections.ts',
    'src/modules/reporting-export/reporting-export.registry.ts',
    'src/modules/reporting-export/reporting-export.types.ts',
  ].sort(), '35. exactly the four authorized production files');
  // 32-35 — everything outside the four authorized production files is untouched, EXCEPT five
  // prior-phase test files whose over-broad source slices PART 15 legitimately invalidated. Those
  // repairs are disclosed and mechanically constrained below: no assertion is removed from any of
  // them, so they re-scope stale windows and refresh stale counts without weakening a single proof.
  // State-independent on purpose: `git diff` omits UNTRACKED files, so this test file is absent
  // from the list before it is committed and present afterwards (the PART 14B lesson).
  const SELF = 'tests/r10-part15-security-operational-patrol.test.ts';
  const REPAIRED = [
    'tests/r10-part03-odh-evidence.test.ts',
    'tests/r10-part04-odh-finding-rework.test.ts',
    'tests/r10-part05-odh-review.test.ts',
    'tests/r10-part11-scheduled-operation-lineage-export.test.ts',
    'tests/r10-part14-permit-to-work-export.test.ts',
  ];
  const touchedTests = changed.filter((f) => f.startsWith('tests/'));
  // SELF is UNTRACKED until this PART is committed, so it is legitimately absent from `git diff`
  // before the commit and present after it. Asserting its presence would therefore pass in one
  // state and fail in the other — exactly the PART 14B defect. What is provable in BOTH states is
  // that the tracked prior-phase repairs are precisely the five disclosed, and that nothing else
  // under tests/ was touched.
  assert.deepEqual(touchedTests.filter((f) => f !== SELF).sort(), [...REPAIRED].sort(),
    '33. the repaired prior-phase files are exactly the five disclosed');
  assert.deepEqual(touchedTests.filter((f) => !REPAIRED.includes(f) && f !== SELF), [],
    '33. no other test file was modified');
  // The repairs delete no assertion. Each one either re-scoped a slice that ran to the end of its
  // file (and so silently swept in later siblings) or refreshed a hardcoded dataset count, so the
  // assertion inventory of every repaired file must be unchanged or larger.
  const assertLines = (s) => s.split('\n')
    .filter((l) => /\bassert\.(ok|equal|notEqual|strictEqual|deepEqual|match|doesNotMatch)\(/.test(l)).length;
  for (const f of REPAIRED) {
    const before = assertLines(git('show', `${BASE}:${f}`));
    const after = assertLines(rd(f));
    assert.ok(after >= before, `${f}: assertion count must not decrease (${before} -> ${after})`);
  }
  // No production TypeScript line is removed. The ONE deleted production line in the whole diff is
  // the OpenAPI enum's closing-bracket line, which must be re-flowed to append a 17th entry; every
  // prior dataset name survives, as the runtime/OpenAPI parity test above proves.
  const tsRemoved = git('diff', BASE, '--', 'src/').split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'));
  assert.deepEqual(tsRemoved, [], '35. no production TypeScript line removed');
  const docsRemoved = git('diff', BASE, '--', 'docs/').split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'));
  assert.equal(docsRemoved.length, 1, 'only the re-flowed OpenAPI enum line');
  assert.match(docsRemoved[0], /SCHEDULED_OPERATION_LINEAGE, PERMIT_TO_WORK\]$/);
  // 34 — the PART 14B security-report source is byte-unchanged
  const frozen = {
    'security-report.types.ts': '9c287bb25761d0365cd0acdfc0df12e03f3f0f2e',
    'security-report.repository.ts': '77811df3247fe693a27c08e144afc6e4e3292f6f',
  };
  for (const [f, h] of Object.entries(frozen)) {
    assert.equal(git('hash-object', `src/modules/security-reports/${f}`), h, `${f} frozen`);
  }
  for (const untouched of ['security-report.service.ts', 'security-report.controller.ts',
    'security-report.routes.ts', 'security-report.validation.ts', 'src/modules/security-reports/index.ts',
    'csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts']) {
    assert.equal(changed.some((f) => f.endsWith(untouched)), false, `${untouched} untouched`);  // 32, 33
  }
  assert.equal(changed.some((f) => f.includes('migrations') || f.includes('seeds')), false);  // 35
  assert.equal(/requirePermission\(|permission/.test(git('diff', BASE, '--', 'src/modules/security-reports')), false);
  // No PART 16 code: the other three sources are declared but not implemented.
  // No PART 16 code: exactly one Security operational projection is referenced, and exactly
  // one source is in the implemented set.
  const regCode = strip(rd(REG));
  assert.deepEqual([...new Set([...regCode.matchAll(/projectSecurityOperational\w+/g)].map((m) => m[0]))],
    ['projectSecurityOperationalPatrol']);
  assert.match(regCode, /new Set<SecurityOperationalDetailSource>\(\['PATROL'\]\)/);
  assert.equal((regCode.match(/securityReportService\.get\w+Dataset\(/g) ?? []).join(),
    'securityReportService.getPatrolDataset(', 'only the PATROL read is wired');
});

test('PART 15 — OpenAPI documents the contract truthfully', () => {
  assert.ok(DOC.length > 2000, 'documentation present');
  for (const claim of ['requires security_report.read', 'REQUIRED `source` discriminator',
    'only PATROL is implemented', 'rejected as not yet implemented', '`buildingId` is REQUIRED',
    'never rolls up across every accessible Building', 'securityOperationalPatrol',
    '13 fields', 'taskId and patrolScheduleBindingId', 'repeated taskId is valid',
    'never collapsed', 'no primary, current, first or latest binding',
    'no generatedTaskId field', 'NOT an exact contributor list', 'No KPI is calculated',
    'COALESCE', 'deliberately not reconciled', 'no dataset-specific CSV default']) {
    assert.ok(DOC.includes(claim), `missing documented claim: ${claim}`);
  }
  for (const banned of ['missed patrols', 'overdue patrols', 'primaryPatrolScheduleBindingId',
    'currentPatrolScheduleBindingId']) {
    assert.equal(DOC.includes(banned), false, `${banned} must not be documented`);
  }
  // These names DO appear, but only inside the sentence that says they do not exist. Assert
  // the negation rather than banning the substring, which would fail on correct documentation.
  assert.ok(DOC.includes('no PATROL_DETAIL, no PATROL_OPERATIONAL_DETAIL and no alias'));
});
