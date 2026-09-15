/**
 * R10 PART 16 — SECURITY_OPERATIONAL_DETAIL / source=SHIFT_HANDOVER.
 *
 * EXECUTED FOR REAL: the 17-entry dataset enum, the SECURITY_OPERATIONAL_DETAIL registry
 * adapter (its required `source` discriminator, its fail-closed guard, its required buildingId
 * assertion and BOTH source branches), the new shift-handover projection, the unchanged PATROL
 * projection, and the owning BE-12M reads — the real `parseReportQuery`, the real
 * `securityReportService.getShiftHandoverDataset` / `getPatrolDataset`, the real
 * `resolveBuildingScope` path and the real SQL generation and row mapping. The generated SQL,
 * bound parameters and mapped rows are OBSERVED, not read from source text.
 *
 * ONLY THE I/O BOUNDARY IS FAKED via `module.registerHooks` (the PART 13/14/14B/15 technique):
 * `src/database` returns canned driver rows and `../buildings` / `../context-access` return a
 * canned authorized scope. `../security-reports` is served by a router-free FACADE re-exporting
 * the real service and the real validation module, because that module's public index also
 * re-exports `createSecurityReportRouter`, whose express -> auth -> bcryptjs chain cannot load
 * without node_modules. The production adapter imports the public index, asserted statically
 * below. Every other registry sibling is an inert stub: those adapters are never invoked.
 *
 * The fake pool returns the canned rows verbatim and does not apply the generated WHERE clause,
 * so filter-to-row correspondence is not asserted here (the owning BE-12M read owns that SQL);
 * what IS asserted is the generated SQL text and the bound parameters.
 *
 * node_modules is absent, so there is no tsc/vitest; assertions run under `node --test` with
 * native TypeScript type stripping. Live-PostgreSQL execution remains CI-required.
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
// maxBuffer raised: `git show` of docs/api/openapi.yaml is far larger than the 1 MB default.
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Fixed baseline so the file-budget proofs hold both before and after commit. */
const BASE = '1d5d0ad0867ba5b66393499bbaaf7bd6e91738f2';
const REG = 'src/modules/reporting-export/reporting-export.registry.ts';
const PROJ = 'src/modules/reporting-export/reporting-export.r10-projections.ts';
const SEC = 'src/modules/security-reports';
const SELF = 'tests/r10-part16-security-operational-shift-handover.test.ts';

const BLDG = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';
const POST = '55555555-5555-4555-8555-555555555555';
const ROUTE = '44444444-4444-4444-8444-444444444444';
const HANDOVER = '88888888-8888-4888-8888-888888888888';
const BIND1 = '22222222-2222-4222-8222-222222222222';
const BIND2 = '33333333-3333-4333-8333-333333333333';
const TASK = '11111111-1111-4111-8111-111111111111';

const ctl = { calls: [], handoverRows: [], patrolRows: [] };
globalThis.__P16 = ctl;

/** Two bindings for ONE shift handover: same shiftHandoverId, different row identity. */
const hoRow = (bindingId, bindingStatus, handoverStatus) => ({
  binding_id: bindingId, shift_handover_id: HANDOVER,
  start_security_post_id: POST, start_security_post_code: 'POST-1',
  patrol_route_id: ROUTE, patrol_route_code: 'R-1',
  binding_status: bindingStatus, handover_status: handoverStatus,
  handover_created_at: new Date('2026-03-01T06:00:00.000Z'),
});
const HO_ROWS = [hoRow(BIND1, 'ACTIVE', 'ACKNOWLEDGED'), hoRow(BIND2, 'ACTIVE', 'READY')];
const ptRow = (bindingId, code) => ({
  task_id: TASK, patrol_schedule_binding_id: bindingId, patrol_route_id: ROUTE,
  patrol_route_code: code, patrol_route_name: `Route ${code}`,
  start_security_post_id: POST, start_security_post_code: 'POST-1',
  start_security_post_name: 'Main Gate', status: 'COMPLETED',
  occurrence_at: new Date('2026-03-01T08:00:00.000Z'),
  started_at: new Date('2026-03-01T08:05:00.000Z'), completed_at: null,
  completed_by_user_id: null,
});
const PT_ROWS = [ptRow(BIND1, 'R-1'), ptRow(BIND2, 'R-2')];
// Wire the canned driver rows into the stubbed pool. `load()` resets only the observed call log,
// so both grains stay available to every test below.
ctl.handoverRows = HO_ROWS;
ctl.patrolRows = PT_ROWS;

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
  // Routed by each grain's own unique SELECT alias, so the two sources cannot be confused.
  database: `export const getPool = () => ({ query: async (sql, params) => {
    const c = globalThis.__P16; c.calls.push({ sql, params });
    const rows = sql.includes('AS binding_id') ? c.handoverRows
      : sql.includes('AS patrol_schedule_binding_id') ? c.patrolRows : [];
    return { rows, rowCount: rows.length }; } });`,
  buildings: `export { buildingNotFoundError } from ${JSON.stringify(abs('src/modules/buildings/building.errors.ts'))};
export const buildingRepository = { findById: async (id) => ({ id }) };`,
  'context-access': `export const contextAccessService = {
    getAccessibleBuildingIds: async () => [], assertBuildingAccess: async () => undefined };`,
  // Router-free facade over the REAL service and the REAL validation module.
  'security-reports': `export { securityReportService } from ${JSON.stringify(abs(`${SEC}/security-report.service.ts`))};
export { parseReportQuery, reportRange, HANDOVER_REPORT_STATUSES } from ${JSON.stringify(abs(`${SEC}/security-report.validation.ts`))};`,
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
/** The 9 authoritative fields, read from the FROZEN public shift-handover row type. */
const HO_FIELDS = (() => {
  const t = rd(`${SEC}/security-report.types.ts`);
  const i = t.indexOf('export type PublicShiftHandoverDatasetRow = {');
  assert.ok(i >= 0, 'the authoritative public row type must exist');
  return [...t.slice(i, t.indexOf('\n};', i)).matchAll(/^ {2}(\w+)(\??): ([^;]+);/gm)].map((m) => m[1]);
})();
const PT_FIELDS = (() => {
  const t = rd(`${SEC}/security-report.types.ts`);
  const i = t.indexOf('export type PublicPatrolDatasetRow = {');
  return [...t.slice(i, t.indexOf('\n};', i)).matchAll(/^ {2}(\w+)(\??): ([^;]+);/gm)].map((m) => m[1]);
})();

/** Runs the REAL adapter end to end and returns its result plus the observed SQL calls. */
async function load(query) {
  ctl.calls = [];
  try { return { res: await ADAPTER.load(query, USER), calls: ctl.calls }; }
  catch (e) { return { err: e, calls: ctl.calls }; }
}
const details = (e) => (e.details ?? []).map((d) => `${d.field}: ${d.message}`).join(' | ');
const cols = (t) => t.columns.map((c) => c.key);

test('PART 16 — dataset surface stays 17 and one dataset gains a second source', () => {
  assert.equal(DATASETS.length, 17);                                     // 1
  assert.equal(oaEnum.length, 17);                                       // 2
  assert.deepEqual([...oaEnum].sort(), [...DATASETS].sort());
  assert.equal(DATASETS.filter((d) => d === 'SECURITY_OPERATIONAL_DETAIL').length, 1);  // 3
  assert.equal(Object.keys(registry.REPORTING_EXPORT_DATASET_REGISTRY).length, 17);
  // No source-specific dataset enum was added for the new source, and no alias exists.
  for (const banned of ['SECURITY_SHIFT_HANDOVER', 'SHIFT_HANDOVER_DETAIL',
    'SECURITY_HANDOVER_REPORT', 'SHIFT_HANDOVER']) {
    assert.equal(DATASETS.includes(banned), false, `${banned} must not be a dataset`);
  }
  assert.deepEqual(DATASETS.filter((d) => /SECURITY_OPERATIONAL/.test(d)),
    ['SECURITY_OPERATIONAL_DETAIL']);
  // 4 — the declared vocabulary is unchanged; implementation availability is what moved.
  assert.deepEqual([...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']);
  assert.match(rd(REG), /new Set<SecurityOperationalDetailSource>\(\['PATROL', 'SHIFT_HANDOVER'\]\)/);
  assert.equal((rd(REG).match(/new Set<SecurityOperationalDetailSource>/g) ?? []).length, 1,
    'exactly one implemented-source set exists');
  // PART 15's own type authority needed no edit: the vocabulary was already staged.
  assert.deepEqual(git('diff', '--name-only', BASE, '--', 'src/modules/reporting-export/reporting-export.types.ts')
    .split('\n').filter(Boolean), []);
});

test('PART 16 — permission, fail-closed sources and required buildingId', async () => {
  assert.equal(ADAPTER.dataset, 'SECURITY_OPERATIONAL_DETAIL');
  assert.equal(ADAPTER.requiredReadPermission, 'security_report.read');  // 8
  for (const bad of ['security.read', 'shift_handover.read', 'handover.read', 'reporting.read', 'admin']) {
    assert.notEqual(ADAPTER.requiredReadPermission, bad);
  }
  // The permission is the one the owning route already uses for this exact endpoint.
  assert.match(rd(`${SEC}/security-report.routes.ts`), /requirePermission\('security_report\.read'\)/);
  assert.match(rd(`${SEC}/security-report.routes.ts`), /'\/security\/reports\/shift-handovers'/);
  // source stays REQUIRED: no default, no inference, no silent empty result.
  for (const q of [{}, { buildingId: BLDG }, { source: '', buildingId: BLDG },
    { source: '   ', buildingId: BLDG }, { source: ['SHIFT_HANDOVER'], buildingId: BLDG }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.match(details(err), /^source: source is required/);
    assert.equal(calls.length, 0, 'the owning read is never reached');
  }
  // 5, 6 — the two future sources STILL fail closed now that a second source is implemented.
  for (const s of ['SECURITY_FINDING', 'INCIDENT_READINESS']) {
    const { err, calls } = await load({ source: s, buildingId: BLDG });
    assert.ok(err, `${s} must fail closed`);
    assert.equal(err.statusCode, 400);
    assert.match(details(err),
      new RegExp(`source ${s} is not implemented yet; supported: PATROL, SHIFT_HANDOVER`));
    assert.equal(calls.length, 0, `${s} must not query any Security read`);
  }
  // An unknown source is not silently mapped onto an implemented one.
  const unk = await load({ source: 'HANDOVER', buildingId: BLDG });
  assert.match(details(unk.err), /source: source is required and must be one of/);
  assert.equal(unk.calls.length, 0);
  // 7 — buildingId is REQUIRED for the new source and never rolls up to accessible Buildings.
  for (const q of [{ source: 'SHIFT_HANDOVER' }, { source: 'SHIFT_HANDOVER', buildingId: '' }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.match(details(err), /buildingId: buildingId is required for source=SHIFT_HANDOVER/);
    assert.equal(calls.length, 0, 'no roll-up query is issued');
  }
  const bad = await load({ source: 'SHIFT_HANDOVER', buildingId: 'not-a-uuid' });
  assert.match(details(bad.err), /buildingId must be a valid UUID/);
  assert.equal(bad.calls.length, 0);
  // The owning module's own status vocabulary is reused, so an unknown status is a validation
  // error rather than a silently empty register.
  const st = await load({ source: 'SHIFT_HANDOVER', buildingId: BLDG, status: 'BOGUS' });
  assert.match(details(st.err), /status/);
  assert.equal(st.calls.length, 0);
  // Case normalization stays the owning parser's, not a second parser in Reporting.
  const ok = await load({ source: 'shift_handover', buildingId: BLDG });
  assert.equal(ok.err, undefined);
  assert.equal(ok.res.appliedFilters.source, 'SHIFT_HANDOVER');
});

test('PART 16 — SHIFT_HANDOVER delegates to the owning read at the binding grain', async () => {
  const { res, calls } = await load({ source: 'SHIFT_HANDOVER', buildingId: BLDG, status: 'READY' });
  assert.equal(res.err, undefined);
  // 9 — exactly one query, generated by the OWNING module: Reporting holds no shift-handover SQL.
  assert.equal(calls.length, 1, 'exactly one owning read is invoked');
  const sql = calls[0].sql;
  assert.match(sql, /FROM security_shift_handover_bindings sshb/);
  assert.match(sql, /JOIN shift_handovers sh ON sh\.id = sshb\.shift_handover_id/);
  assert.match(sql, /sshb\.building_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(sql, /sh\.status = \$\d/);
  assert.match(sql, /ORDER BY sh\.created_at DESC, sshb\.created_at DESC/);
  assert.deepEqual(calls[0].params[0], [BLDG], 'the requested Building is the bound scope');
  assert.ok(calls[0].params.includes('READY'), 'status is bound through to the owning read');
  // The scope and period echoed are the authorized filter's, never derived from rows.
  assert.equal(res.common.buildingId, BLDG);
  assert.deepEqual(res.common.buildingScope, [BLDG]);
  assert.equal(typeof res.common.asOf, 'string');
  // 13, 15, 20 — exactly one table, the shift-handover one, and no KPI.
  assert.deepEqual(res.projected.kpis, []);
  assert.equal(res.projected.tables.length, 1);
  const t = res.projected.tables[0];
  assert.equal(t.key, 'securityOperationalShiftHandover');
  assert.deepEqual(res.projected.tables.map((x) => x.key), ['securityOperationalShiftHandover']);
  assert.equal(t.rows.length, 2, 'one row per governed dataset row');
  // 17 — a repeated shiftHandoverId across two bindings survives as two rows.
  assert.deepEqual(t.rows.map((r) => r.shiftHandoverId), [HANDOVER, HANDOVER]);
  assert.deepEqual(t.rows.map((r) => r.bindingId), [BIND1, BIND2], 'row identity is the binding id');
  assert.equal(new Set(t.rows.map((r) => r.bindingId)).size, 2);
  // Order is the owning read's: Reporting performs no post-query sort, filter, dedup or collapse.
  assert.deepEqual(t.rows.map((r) => r.handoverStatus), ['ACKNOWLEDGED', 'READY'],
    'rows are returned in the order the owning read produced them');
  // 11, 12 — every projected row holds exactly the authoritative fields, in authoritative order.
  assert.equal(HO_FIELDS.length, 9, 'the authoritative public row has nine fields');
  for (const r of t.rows) assert.deepEqual(Object.keys(r), HO_FIELDS);
  assert.deepEqual(cols(t), HO_FIELDS, 'column order matches the authoritative type');
  assert.deepEqual(t.columns.map((c) => c.label), ['Binding Id', 'Shift Handover Id',
    'Start Security Post Id', 'Start Security Post Code', 'Patrol Route Id', 'Patrol Route Code',
    'Binding Status', 'Handover Status', 'Handover Created At']);
  // 18 — both persisted statuses are copied through, separately and unmodified.
  assert.deepEqual(t.rows[0].bindingStatus, 'ACTIVE');
  assert.deepEqual(t.rows[0].handoverStatus, 'ACKNOWLEDGED');
  assert.deepEqual(t.rows[1].handoverStatus, 'READY');
  for (const r of t.rows) {
    for (const banned of ['acknowledged', 'isAcknowledged', 'completed', 'accepted', 'pending',
      'overdue', 'missed', 'late', 'onTime', 'complianceStatus', 'status', 'derivedStatus']) {
      assert.equal(banned in r, false, `no invented status field ${banned}`);
    }
    // 19 — the authoritative row publishes no actor, so none is invented.
    for (const k of Object.keys(r)) {
      assert.equal(/creator|author|submittedBy|handoverBy|receiver|acknowledg|workforce|executor|user/i
        .test(k), false, `no invented actor field ${k}`);
    }
  }
  // Renderer safety: all nine values are scalars, nothing serialized or flattened.
  for (const r of t.rows) {
    for (const [k, v] of Object.entries(r)) {
      assert.ok(v === null || typeof v === 'string' || typeof v === 'number',
        `${k} must be a renderer-safe scalar`);
    }
  }
});

test('PART 16 — no handover selector, no KPI, no CSV default, PATROL unchanged', async () => {
  const projSrc = strip(rd(PROJ)).slice(strip(rd(PROJ)).indexOf('export function projectSecurityOperationalShiftHandover'));
  // 16 — no latest/current/most-recent/active/effective election and no ranking construct.
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT ON', 'DISTINCT', 'GROUP BY',
    'MAX(', 'mostRecent', 'latestHandover', 'currentHandover', 'activeHandover',
    'effectiveHandover', '.sort(', '.find(', '.filter(', '[0]']) {
    assert.equal(projSrc.includes(banned), false, `no ${banned} in the shift-handover projection`);
  }
  const regStripped = strip(rd(REG));
  const hoAdapter = regStripped.slice(regStripped.indexOf("if (source === 'SHIFT_HANDOVER') {"),
    regStripped.indexOf('const filters = parseReportQuery(passThrough);'));
  assert.ok(hoAdapter.length > 200, 'the shift-handover branch slice must be non-trivial');
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT', 'GROUP BY', '.sort(', '.filter(',
    'latest', 'current', 'mostRecent']) {
    assert.equal(hoAdapter.includes(banned), false, `no ${banned} in the shift-handover branch`);
  }
  // 20 — no KPI arithmetic anywhere in the new code path.
  for (const banned of ['handoverCount', 'completionRate', 'pendingCount', 'lateHandover',
    'shiftCompliance', 'kpis.push', 'count(', 'rate']) {
    assert.equal(projSrc.includes(banned), false, `no ${banned} in the projection`);
  }
  // 21 — no dataset CSV default: the table key is source-dependent.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.SECURITY_OPERATIONAL_DETAIL, undefined);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL.csvDefaultTableKey,
    'operationalDetail', 'the OPERATIONAL_DETAIL default is intact');
  const adapterAll = strip(rd(REG)).slice(strip(rd(REG)).indexOf('  SECURITY_OPERATIONAL_DETAIL: {'));
  assert.equal(adapterAll.includes('csvDefaultTableKey'), false);
  // 14, 15, 22 — PATROL is untouched: same table, same 13-field identity semantics.
  const pt = await load({ source: 'PATROL', buildingId: BLDG });
  assert.equal(pt.err, undefined);
  assert.equal(pt.calls.length, 1);
  assert.match(pt.calls[0].sql, /patrol_schedule_bindings/);
  assert.equal(pt.calls[0].sql.includes('security_shift_handover_bindings'), false,
    'PATROL never queries the shift-handover read');
  assert.equal(pt.res.projected.tables.length, 1);
  const ptTable = pt.res.projected.tables[0];
  assert.equal(ptTable.key, 'securityOperationalPatrol');
  assert.deepEqual(pt.res.projected.kpis, []);
  assert.equal(PT_FIELDS.length, 13);
  assert.deepEqual(cols(ptTable), PT_FIELDS, 'PATROL column order still matches its own type');
  assert.deepEqual(ptTable.rows.map((r) => r.taskId), [TASK, TASK], 'repeated taskId still survives');
  assert.deepEqual(ptTable.rows.map((r) => r.patrolScheduleBindingId), [BIND1, BIND2]);
  for (const r of ptTable.rows) {
    assert.equal('generatedTaskId' in r, false, 'no generatedTaskId alias in PATROL');
    for (const banned of ['missed', 'overdue', 'dueBefore', 'graceMinutes', 'complianceStatus']) {
      assert.equal(banned in r, false, `PATROL still derives no ${banned}`);
    }
  }
  // The two sources never share a response: one table each, no placeholder for a future source.
  const ho = await load({ source: 'SHIFT_HANDOVER', buildingId: BLDG });
  assert.deepEqual(ho.res.projected.tables.map((x) => x.key), ['securityOperationalShiftHandover']);
  assert.equal(ho.res.projected.tables.some((x) => x.key === 'securityOperationalPatrol'), false);
  assert.equal(pt.res.projected.tables.some((x) => x.key === 'securityOperationalShiftHandover'), false);
  assert.equal(ho.res.projected.tables.some((x) => /securityFinding|incidentReadiness/i.test(x.key)), false);
});

test('PART 16 — Reporting holds no Security SQL and no forbidden file changed', () => {
  // 10 — no Security-domain SQL is authored in Reporting (comments stripped: the prose
  // legitimately names the owning tables to say they are never queried here).
  for (const f of fs.readdirSync(path.join(ROOT, 'src/modules/reporting-export'))) {
    if (!f.endsWith('.ts')) continue;
    const code = strip(rd(`src/modules/reporting-export/${f}`));
    for (const tbl of ['security_shift_handover_bindings', 'shift_handovers',
      'patrol_schedule_bindings', 'generated_tasks', 'patrol_routes', 'security_posts']) {
      assert.equal(code.includes(tbl), false, `${f} must hold no ${tbl} SQL`);
    }
  }
  // The adapter imports the owning module's PUBLIC index and never its repository.
  assert.match(rd(REG), /from '\.\.\/security-reports';/);
  assert.equal(/from '\.\.\/security-reports\//.test(rd(REG)), false, 'no submodule import');
  assert.equal(/securityReportRepository/.test(strip(rd(REG))), false, 'repository never used');
  assert.equal(strip(rd(REG)).includes('getShiftHandoverDataset'), true, 'the owning read is used');
  // 23 — the Security domain is untouched: not one file changed under src/modules/security-reports.
  assert.deepEqual(git('diff', '--name-only', BASE, '--', SEC).split('\n').filter(Boolean), [],
    'no security-reports file changed');
  // 24 — no route, no new permission, no migration, no renderer or archive change.
  const changed = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  assert.deepEqual(changed.filter((f) => /migrations|seeds|routes|controller/.test(f)), []);
  assert.deepEqual(changed.filter((f) => /csv-renderer|xlsx-renderer|pdf-renderer|archive/.test(f)), []);
  assert.equal(/requirePermission\(|permission/.test(git('diff', BASE, '--', SEC)), false);
  // Production budget: exactly the three authorized files. types.ts needed no change because
  // PART 15 already staged the full source vocabulary.
  const production = changed.filter((f) => !f.startsWith('tests/')).sort();
  assert.deepEqual(production, [
    'docs/api/openapi.yaml',
    'src/modules/reporting-export/reporting-export.r10-projections.ts',
    'src/modules/reporting-export/reporting-export.registry.ts',
  ], 'exactly the three authorized production files');
  // State-independent: `git diff` omits UNTRACKED files, so this test file is absent from the
  // list before commit and present after. What holds in both states is that no OTHER test file
  // was touched (the PART 14B lesson) — PART 16 repairs no historical test.
  assert.deepEqual(changed.filter((f) => f.startsWith('tests/') && f !== SELF), [],
    'no prior-phase test file was modified');
  // Purely additive production TypeScript: no executable line removed anywhere in src/.
  const removed = git('diff', BASE, '--', 'src/').split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    // The only permitted removals are comment/import/docblock reflow and the two literals that
    // this PART is mandated to change: the sourceAuthority string and the implemented set.
    .filter((l) => !/^(\/\/|\*|\/\*)/.test(l)).sort();
  assert.deepEqual(removed, [
    "import { parseReportQuery, securityReportService } from '../security-reports';",
    "import type { PublicPatrolDatasetRow } from '../security-reports';",
    "new Set<SecurityOperationalDetailSource>(['PATROL']);",
    "sourceAuthority: 'BE-12M security-reports patrol dataset',",
  ].sort(), 'only import reflow plus the two mandated literal changes');
  // No PART 17/18 code: the two future sources stay declared-but-unimplemented.
  assert.equal(/SECURITY_FINDING|INCIDENT_READINESS/.test(strip(rd(PROJ))), false,
    'no projection exists for an unimplemented source');
  assert.equal(strip(rd(REG)).includes('getSecurityFindingDataset'), false);
  assert.equal(strip(rd(REG)).includes('getIncidentReadinessDataset'), false);
});

test('PART 16 — OpenAPI documents both sources truthfully at 17 datasets', () => {
  assert.equal(oaEnum.length, 17);
  assert.equal(oaEnum.filter((d) => d === 'SECURITY_OPERATIONAL_DETAIL').length, 1);
  assert.ok(DOC.length > 4000, 'documentation present');
  for (const claim of ['requires security_report.read', 'REQUIRED `source` discriminator',
    'PATROL is implemented and SHIFT_HANDOVER is', 'rejected as not yet implemented',
    'securityOperationalShiftHandover', 'securityOperationalPatrol', '9 fields',
    'bindingId', 'shiftHandoverId', 'row identity is bindingId', 'No synthetic handover',
    'repeated shiftHandoverId', 'never collapsed', 'no latest, current, most recent, active',
    'no LIMIT 1', 'no ROW_NUMBER', '`buildingId` is REQUIRED for source=SHIFT_HANDOVER',
    'never rolls up across every accessible Building', 'half-open range', 'bindingStatus',
    'handoverStatus', 'publishes no actor field', 'No KPI is calculated for this source',
    'no handover count', 'no dataset-specific CSV default',
    'SECURITY_FINDING and INCIDENT_READINESS remain unimplemented',
    'never holds both securityOperationalPatrol']) {
    assert.ok(DOC.includes(claim), `documentation must state: ${claim}`);
  }
  // The PATROL contract is still documented, semantically unchanged.
  for (const claim of ['13 fields', 'taskId and patrolScheduleBindingId', 'repeated taskId is valid',
    'no generatedTaskId field', 'no primary, current, first or latest binding',
    'NOT an exact contributor list']) {
    assert.ok(DOC.includes(claim), `PATROL documentation must still state: ${claim}`);
  }
  // No claim of PART 17/18 functionality for the unimplemented sources.
  assert.equal(DOC.includes('securityOperationalSecurityFinding'), false);
  assert.equal(DOC.includes('securityOperationalIncidentReadiness'), false);
  assert.equal(/SECURITY_FINDING[^.]*is implemented/.test(DOC), false);
  assert.equal(/INCIDENT_READINESS[^.]*is implemented/.test(DOC), false);
  // The stale PART 15 wording that this PART is mandated to replace is gone.
  assert.equal(DOC.includes('only PATROL is implemented'), false);
  // PART 16 adds a SOURCE to an existing dataset, never a dataset, so the enum block must be
  // byte-identical to the PART 15 baseline. Compared directly rather than by guessing the YAML
  // line wrapping, and state-independently (both sides come from git/the file, not the index).
  const enumNow = docBlock.slice(docBlock.indexOf('enum:'), docBlock.indexOf('description:'));
  const baseBlock = git('show', `${BASE}:docs/api/openapi.yaml`)
    .split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
  const enumBase = baseBlock.slice(baseBlock.indexOf('enum:'), baseBlock.indexOf('description:'));
  assert.equal(enumNow, enumBase, 'the dataset enum is byte-identical to the PART 15 baseline');
  assert.deepEqual(oaEnum, [...DATASETS], 'the OpenAPI enum matches the runtime enum in order');
  assert.equal(oaEnum[16], 'SECURITY_OPERATIONAL_DETAIL');
});
