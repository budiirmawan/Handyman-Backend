/**
 * R10 PART 17 — SECURITY_OPERATIONAL_DETAIL / source=SECURITY_FINDING.
 *
 * EXECUTED FOR REAL: the 17-entry dataset enum, the SECURITY_OPERATIONAL_DETAIL registry adapter
 * (its required `source` discriminator, its fail-closed guard, its required buildingId assertion
 * and ALL THREE source branches), the new security-finding projection, the unchanged PATROL and
 * SHIFT_HANDOVER projections, and the owning BE-12M reads — the real `parseReportQuery`, the real
 * `securityReportService.getSecurityFindingDataset` / `getShiftHandoverDataset` /
 * `getPatrolDataset`, the real `resolveBuildingScope` path and the real SQL generation and row
 * mapping. Generated SQL, bound parameters and mapped rows are OBSERVED, not read from source.
 *
 * ONLY THE I/O BOUNDARY IS FAKED via `module.registerHooks` (the PART 13-16 technique):
 * `src/database` returns canned driver rows routed by each grain's own unique SELECT alias, and
 * `../buildings` / `../context-access` return a canned authorized scope. `../security-reports` is
 * served by a router-free FACADE re-exporting the real service and the real validation module,
 * because that module's public index also re-exports `createSecurityReportRouter`, whose
 * express -> auth -> bcryptjs chain cannot load without node_modules. The production adapter
 * imports the public index, asserted statically below. Other registry siblings are inert stubs.
 *
 * The fake pool returns canned rows verbatim and does not apply the generated WHERE clause, so
 * filter-to-row correspondence is not asserted here (the owning BE-12M read owns that SQL); what
 * IS asserted is the generated SQL text and the bound parameters.
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
// maxBuffer raised: `git show` of docs/api/openapi.yaml far exceeds the 1 MB default.
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Fixed baseline so the file-budget proofs hold both before and after commit. */
const BASE = 'ba67ed6862d1bee0e1636b05fdf63885d9b2b0e6';
const REG = 'src/modules/reporting-export/reporting-export.registry.ts';
const PROJ = 'src/modules/reporting-export/reporting-export.r10-projections.ts';
const SEC = 'src/modules/security-reports';
const SELF = 'tests/r10-part17-security-operational-finding.test.ts';

const BLDG = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';
const POST = '55555555-5555-4555-8555-555555555555';
const ROUTE = '44444444-4444-4444-8444-444444444444';
const FINDING = '99999999-9999-4999-8999-999999999999';
const LINK1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINK2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BIND1 = '22222222-2222-4222-8222-222222222222';
const BIND2 = '33333333-3333-4333-8333-333333333333';
const HANDOVER = '88888888-8888-4888-8888-888888888888';
const TASK = '11111111-1111-4111-8111-111111111111';

const ctl = { calls: [], findingRows: [], handoverRows: [], patrolRows: [] };
globalThis.__P17 = ctl;

/** Two links for ONE finding: same findingId, different row identity, different statuses. */
const fRow = (linkId, status, postCode) => ({
  link_id: linkId, finding_id: FINDING, finding_number: 'SEC-2026-0001',
  finding_title: 'Gate left unattended', finding_status: status, link_status: 'ACTIVE',
  source_post_id: POST, source_post_code: postCode,
  source_route_id: ROUTE, source_route_code: 'R-1',
  reported_at: new Date('2026-03-01T06:00:00.000Z'),
});
const F_ROWS = [fRow(LINK1, 'OPEN', 'POST-1'), fRow(LINK2, 'CLOSED', 'POST-2')];
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
// Wire the canned driver rows into the stubbed pool: `load()` resets only the observed call log.
ctl.findingRows = F_ROWS; ctl.handoverRows = HO_ROWS; ctl.patrolRows = PT_ROWS;

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
  // Routed by each grain's own unique SELECT alias, so the three sources cannot be confused.
  database: `export const getPool = () => ({ query: async (sql, params) => {
    const c = globalThis.__P17; c.calls.push({ sql, params });
    const rows = sql.includes('AS link_id') ? c.findingRows
      : sql.includes('AS binding_id') ? c.handoverRows
      : sql.includes('AS patrol_schedule_binding_id') ? c.patrolRows : [];
    return { rows, rowCount: rows.length }; } });`,
  buildings: `export { buildingNotFoundError } from ${JSON.stringify(abs('src/modules/buildings/building.errors.ts'))};
export const buildingRepository = { findById: async (id) => ({ id }) };`,
  'context-access': `export const contextAccessService = {
    getAccessibleBuildingIds: async () => [], assertBuildingAccess: async () => undefined };`,
  // Router-free facade over the REAL service and the REAL validation module.
  'security-reports': `export { securityReportService } from ${JSON.stringify(abs(`${SEC}/security-report.service.ts`))};
export { parseReportQuery, reportRange, HANDOVER_REPORT_STATUSES, FINDING_REPORT_STATUSES } from ${JSON.stringify(abs(`${SEC}/security-report.validation.ts`))};`,
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
/** Authoritative public row fields, read from the FROZEN security-report types. */
const fieldsOf = (typeName) => {
  const t = rd(`${SEC}/security-report.types.ts`);
  const i = t.indexOf(`export type ${typeName} = {`);
  assert.ok(i >= 0, `${typeName} must exist in the authoritative public types`);
  return [...t.slice(i, t.indexOf('\n};', i)).matchAll(/^ {2}(\w+)(\??): ([^;]+);/gm)].map((m) => m[1]);
};
const F_FIELDS = fieldsOf('PublicSecurityFindingDatasetRow');
const HO_FIELDS = fieldsOf('PublicShiftHandoverDatasetRow');
const PT_FIELDS = fieldsOf('PublicPatrolDatasetRow');

/** Runs the REAL adapter end to end and returns its result plus the observed SQL calls. */
async function load(query) {
  ctl.calls = [];
  try { return { res: await ADAPTER.load(query, USER), calls: ctl.calls }; }
  catch (e) { return { err: e, calls: ctl.calls }; }
}
const details = (e) => (e.details ?? []).map((d) => `${d.field}: ${d.message}`).join(' | ');
const cols = (t) => t.columns.map((c) => c.key);
const FINDING_Q = { source: 'SECURITY_FINDING', buildingId: BLDG };

test('PART 17 — dataset surface stays 17 and one dataset gains a third source', () => {
  assert.equal(DATASETS.length, 17);                                     // 1
  assert.equal(oaEnum.length, 17);                                       // 2
  assert.deepEqual(oaEnum, [...DATASETS], 'OpenAPI enum matches runtime enum in order');
  assert.equal(DATASETS.filter((d) => d === 'SECURITY_OPERATIONAL_DETAIL').length, 1);  // 3
  assert.equal(Object.keys(registry.REPORTING_EXPORT_DATASET_REGISTRY).length, 17);
  // No dataset enum was added for the new source, and no alias exists.
  for (const banned of ['SECURITY_FINDING', 'SECURITY_FINDING_DETAIL', 'FINDING_DETAIL',
    'SECURITY_OPERATIONAL_FINDING', 'SECURITY_FINDING_OPERATIONAL_DETAIL']) {
    assert.equal(DATASETS.includes(banned), false, `${banned} must not be a dataset`);
  }
  assert.deepEqual(DATASETS.filter((d) => /SECURITY_OPERATIONAL/.test(d)),
    ['SECURITY_OPERATIONAL_DETAIL']);
  // FINDING_REGISTER stays a separate, untouched dataset — not merged with this source.
  assert.ok(DATASETS.includes('FINDING_REGISTER'), 'FINDING_REGISTER remains its own dataset');
  // The declared vocabulary is unchanged; implementation availability is what moved.
  assert.deepEqual([...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']);
  // 4 — the implemented set is exactly the three sources, in vocabulary order, declared once.
  assert.match(rd(REG), /new Set<SecurityOperationalDetailSource>\(\[\s*'PATROL',\s*'SHIFT_HANDOVER',\s*'SECURITY_FINDING',\s*\]\)/);
  assert.equal((rd(REG).match(/new Set<SecurityOperationalDetailSource>/g) ?? []).length, 1,
    'exactly one implemented-source set exists');
  // PART 16 already staged the vocabulary, so the type authority needed no semantic change.
  assert.deepEqual(git('diff', '--name-only', BASE, '--',
    'src/modules/reporting-export/reporting-export.types.ts').split('\n').filter(Boolean), []);
});

test('PART 17 — permission, fail-closed INCIDENT_READINESS and required buildingId', async () => {
  assert.equal(ADAPTER.dataset, 'SECURITY_OPERATIONAL_DETAIL');
  assert.equal(ADAPTER.requiredReadPermission, 'security_report.read');  // 7
  for (const bad of ['security.read', 'finding.read', 'findings.read', 'security_finding.read',
    'reporting.read', 'admin']) {
    assert.notEqual(ADAPTER.requiredReadPermission, bad);
  }
  // The permission is the one the owning route already uses for the findings endpoint itself.
  const routes = rd(`${SEC}/security-report.routes.ts`);
  assert.match(routes, /const read = requirePermission\('security_report\.read'\)/);
  const findingsRoute = routes.slice(routes.indexOf("'/security/reports/findings'"));
  assert.match(findingsRoute.slice(0, 200), /auth,\s*read,\s*securityFindingDatasetHandler/);
  // `source` stays REQUIRED: no default, no inference from filters, no silent empty result.
  for (const q of [{}, { buildingId: BLDG }, { source: '', buildingId: BLDG },
    { source: '   ', buildingId: BLDG }, { source: ['SECURITY_FINDING'], buildingId: BLDG },
    { buildingId: BLDG, status: 'OPEN' }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.match(details(err), /^source: source is required and must be one of/,
      'source is never inferred from the filters present');
    assert.equal(calls.length, 0, 'the owning read is never reached');
  }
  // 5 — INCIDENT_READINESS STILL fails closed now that three sources are implemented.
  const ir = await load({ source: 'INCIDENT_READINESS', buildingId: BLDG });
  assert.ok(ir.err, 'INCIDENT_READINESS must fail closed');
  assert.equal(ir.err.statusCode, 400);
  assert.match(details(ir.err),
    /source INCIDENT_READINESS is not implemented yet; supported: PATROL, SHIFT_HANDOVER, SECURITY_FINDING/);
  assert.equal(ir.calls.length, 0, 'it must not query any Security read');
  // An unknown source is never silently mapped onto an implemented one.
  const unk = await load({ source: 'FINDING', buildingId: BLDG });
  assert.match(details(unk.err), /source: source is required and must be one of/);
  assert.equal(unk.calls.length, 0);
  // 6 — buildingId is REQUIRED and never widens to all accessible Buildings.
  for (const q of [{ source: 'SECURITY_FINDING' }, { source: 'SECURITY_FINDING', buildingId: '' }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.match(details(err), /buildingId: buildingId is required for source=SECURITY_FINDING/);
    assert.equal(calls.length, 0, 'no roll-up query is issued');
  }
  // A whitespace-only buildingId is rejected even earlier, by the owning parser's own UUID
  // authority. That division is deliberate and is what the adapter documents: PRESENCE is asserted
  // in Reporting so the roll-up path is structurally unreachable, while FORMAT stays with BE-12M.
  // Either way it is a 400 validation error and no query is issued.
  const blank = await load({ source: 'SECURITY_FINDING', buildingId: '   ' });
  assert.match(details(blank.err), /buildingId: buildingId must be a valid UUID/);
  assert.equal(blank.err.statusCode, 400);
  assert.equal(blank.calls.length, 0, 'no roll-up query is issued');
  const bad = await load({ source: 'SECURITY_FINDING', buildingId: 'not-a-uuid' });
  assert.match(details(bad.err), /buildingId must be a valid UUID/);
  assert.equal(bad.calls.length, 0);
  // The owning module's own finding status vocabulary is reused, so an unknown status is a
  // validation error rather than a silently empty register.
  const bogus = await load({ ...FINDING_Q, status: 'BOGUS' });
  assert.match(details(bogus.err), /status/);
  assert.equal(bogus.calls.length, 0);
  const real = await load({ ...FINDING_Q, status: 'OPEN' });
  assert.equal(real.err, undefined, 'a status from the owning vocabulary is accepted');
  // Case normalization stays the owning parser's, not a second parser in Reporting.
  const lower = await load({ source: 'security_finding', buildingId: BLDG });
  assert.equal(lower.err, undefined);
  assert.equal(lower.res.appliedFilters.source, 'SECURITY_FINDING');
});

test('PART 17 — SECURITY_FINDING delegates to the owning read at the finding-link grain', async () => {
  const { res, calls } = await load({ ...FINDING_Q, status: 'OPEN', securityPostId: POST,
    patrolRouteId: ROUTE, dateFrom: '2026-03-01', dateTo: '2026-03-31' });
  assert.equal(res.err, undefined);
  // 8 — exactly ONE query, generated by the OWNING module: Reporting holds no finding SQL.
  assert.equal(calls.length, 1, 'the governed read is called exactly once');
  const sql = calls[0].sql;
  assert.match(sql, /FROM security_finding_links sfl/);
  assert.match(sql, /JOIN findings f ON f\.id = sfl\.finding_id/);
  assert.match(sql, /sfl\.building_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(sql, /f\.status = \$\d/);
  assert.match(sql, /sfl\.start_security_post_id = \$\d/);
  assert.match(sql, /sfl\.patrol_route_id = \$\d/);
  // The period authority is the finding's own reported instant, half-open, preserved verbatim.
  assert.match(sql, /f\.reported_at >= \$\d/);
  assert.match(sql, /f\.reported_at < \$\d/);
  assert.match(sql, /ORDER BY f\.reported_at DESC, sfl\.created_at DESC/);
  assert.equal(/createdAt|updated_at|resolved_at/.test(sql), false, 'no substituted date column');
  assert.deepEqual(calls[0].params[0], [BLDG], 'the requested Building is the bound scope');
  for (const v of ['OPEN', POST, ROUTE]) {
    assert.ok(calls[0].params.includes(v), `${v} is bound through to the owning read`);
  }
  // Scope and period echoed are the authorized filter's, never derived from rows.
  assert.equal(res.common.buildingId, BLDG);
  assert.deepEqual(res.common.buildingScope, [BLDG]);
  assert.equal(res.common.dateFrom, '2026-03-01');
  assert.equal(res.common.dateTo, '2026-03-31');
  assert.equal(typeof res.common.asOf, 'string');
  // 12, 20 — exactly one table, the finding one, and no KPI.
  assert.deepEqual(res.projected.kpis, []);
  assert.equal(res.projected.tables.length, 1);
  const t = res.projected.tables[0];
  assert.equal(t.key, 'securityOperationalFinding');
  assert.deepEqual(res.projected.tables.map((x) => x.key), ['securityOperationalFinding']);
  assert.equal(t.rows.length, 2, 'one row per governed dataset row');
  // 13, 16 — a repeated findingId across two links survives as two distinct rows.
  assert.deepEqual(t.rows.map((r) => r.findingId), [FINDING, FINDING]);
  assert.deepEqual(t.rows.map((r) => r.linkId), [LINK1, LINK2], 'row identity is the link id');
  assert.equal(new Set(t.rows.map((r) => r.linkId)).size, 2);
  // No synthetic identity was minted.
  for (const r of t.rows) {
    for (const banned of ['securityFindingKey', 'compositeFindingId', 'findingReference',
      'sourceFindingId', 'rowKey', 'id']) {
      assert.equal(banned in r, false, `no synthesized identity field ${banned}`);
    }
  }
  // 17 — order is the owning read's: no post-query sort, filter, dedup, group or collapse.
  assert.deepEqual(t.rows.map((r) => r.findingStatus), ['OPEN', 'CLOSED'],
    'rows are returned in the order the owning read produced them');
  // 10, 11 — every row holds exactly the authoritative fields, in authoritative order.
  assert.equal(F_FIELDS.length, 11, 'the authoritative public row has eleven fields');
  for (const r of t.rows) assert.deepEqual(Object.keys(r), F_FIELDS);
  assert.deepEqual(cols(t), F_FIELDS, 'column order matches the authoritative type');
  assert.deepEqual(t.columns.map((c) => c.label), ['Link Id', 'Finding Id', 'Finding Number',
    'Finding Title', 'Finding Status', 'Link Status', 'Source Post Id', 'Source Post Code',
    'Source Route Id', 'Source Route Code', 'Reported At']);
  // 14 — both published statuses are copied through, separately and unmodified.
  assert.equal(t.rows[0].findingStatus, 'OPEN');
  assert.equal(t.rows[1].findingStatus, 'CLOSED');
  assert.deepEqual(t.rows.map((r) => r.linkStatus), ['ACTIVE', 'ACTIVE'],
    'the owning read publishes linkStatus as a constant ACTIVE literal; it is copied, not derived');
  for (const r of t.rows) {
    for (const banned of ['open', 'closed', 'resolved', 'overdue', 'aging', 'breached',
      'escalated', 'isOverdue', 'dueState', 'severity', 'derivedStatus', 'status']) {
      assert.equal(banned in r, false, `no invented status or severity field ${banned}`);
    }
    // 15 — the authoritative row publishes no actor, so none is invented.
    for (const k of Object.keys(r)) {
      assert.equal(/createdBy|reportedBy|assignedTo|verifiedBy|resolvedBy|executor|performedBy|completedBy|workforce|user/i
        .test(k), false, `no invented actor field ${k}`);
    }
    // 18, 19 — no SLA, overdue, age or breach arithmetic anywhere on the row.
    for (const k of Object.keys(r)) {
      assert.equal(/sla|overdue|age|timeOpen|breach|responseTime|resolutionTime|dueBefore|grace/i
        .test(k), false, `no SLA or ageing field ${k}`);
    }
    // Renderer safety: all eleven values are scalars, nothing serialized or flattened.
    for (const [k, v] of Object.entries(r)) {
      assert.ok(v === null || typeof v === 'string' || typeof v === 'number',
        `${k} must be a renderer-safe scalar`);
    }
  }
  // The verbatim scalar facts survive unchanged, including the nullable LEFT JOIN codes.
  assert.equal(t.rows[0].findingNumber, 'SEC-2026-0001');
  assert.equal(t.rows[0].findingTitle, 'Gate left unattended');
  assert.equal(t.rows[0].reportedAt, '2026-03-01T06:00:00.000Z');
  assert.deepEqual(t.rows.map((r) => r.sourcePostCode), ['POST-1', 'POST-2']);
});

test('PART 17 — no selector, no SLA, no KPI, no CSV default; PATROL and HANDOVER unchanged', async () => {
  const projAll = strip(rd(PROJ));
  const fProj = projAll.slice(projAll.indexOf('export function projectSecurityOperationalFinding'));
  // No latest/current election, no ranking construct, no post-query manipulation, no clock.
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT', 'GROUP BY', 'MAX(', 'mostRecent',
    'latestFinding', 'currentFinding', 'activeFinding', 'effectiveFinding', '.sort(', '.find(',
    '.filter(', '.reduce(', '[0]', 'new Date(', 'Date.now(', 'toISOString()']) {
    assert.equal(fProj.includes(banned), false, `no ${banned} in the finding projection`);
  }
  for (const banned of ['sla', 'overdue', 'ageDays', 'timeOpen', 'breach', 'responseTime',
    'resolutionTime', 'handoverCount', 'findingCount', 'openCount', 'criticalCount',
    'closureRate', 'averageAge', 'kpis.push', 'count(', 'rate']) {
    assert.equal(fProj.toLowerCase().includes(banned.toLowerCase()), false,
      `no ${banned} in the finding projection`);
  }
  const regStripped = strip(rd(REG));
  const fBranch = regStripped.slice(regStripped.indexOf("if (source === 'SECURITY_FINDING') {"),
    regStripped.indexOf('const filters = parseReportQuery(passThrough);'));
  assert.ok(fBranch.length > 200, 'the finding branch slice must be non-trivial');
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT', 'GROUP BY', '.sort(', '.filter(',
    '.reduce(', 'latest', 'current', 'mostRecent', 'sla', 'overdue', 'ageDays',
    'getIncidentReadinessDataset']) {
    assert.equal(fBranch.toLowerCase().includes(banned.toLowerCase()), false,
      `no ${banned} in the finding branch`);
  }
  // Exactly one clock read in the finding branch: the envelope instant, nothing else.
  assert.equal((fBranch.match(/new Date\(\)\.toISOString\(\)/g) ?? []).length, 1,
    'one envelope instant only');
  // No join to the R08 Finding child grain or to FINDING_REGISTER, and no enrichment.
  for (const banned of ['findingRegister', 'FindingRegister', 'finding-rework', 'findingRework',
    'evidence', 'reviewHistory']) {
    assert.equal(fBranch.includes(banned), false, `finding branch never touches ${banned}`);
  }
  // 23 — no dataset CSV default: the table key is source-dependent.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.SECURITY_OPERATIONAL_DETAIL, undefined);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL.csvDefaultTableKey,
    'operationalDetail', 'the OPERATIONAL_DETAIL default is intact');
  const adapterAll = regStripped.slice(regStripped.indexOf('  SECURITY_OPERATIONAL_DETAIL: {'));
  assert.equal(adapterAll.includes('csvDefaultTableKey'), false);

  // 21 — PATROL is unchanged: same table, same 13-field identity semantics, no timeliness.
  const pt = await load({ source: 'PATROL', buildingId: BLDG });
  assert.equal(pt.err, undefined);
  assert.equal(pt.calls.length, 1);
  assert.match(pt.calls[0].sql, /patrol_schedule_bindings/);
  assert.equal(pt.calls[0].sql.includes('security_finding_links'), false,
    'PATROL never queries the finding read');
  assert.deepEqual(pt.res.projected.kpis, []);
  assert.deepEqual(pt.res.projected.tables.map((x) => x.key), ['securityOperationalPatrol']);
  const ptTable = pt.res.projected.tables[0];
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

  // 22 — SHIFT_HANDOVER is unchanged: same table, same 9-field binding identity.
  const ho = await load({ source: 'SHIFT_HANDOVER', buildingId: BLDG });
  assert.equal(ho.err, undefined);
  assert.equal(ho.calls.length, 1);
  assert.match(ho.calls[0].sql, /security_shift_handover_bindings/);
  assert.equal(ho.calls[0].sql.includes('security_finding_links'), false,
    'SHIFT_HANDOVER never queries the finding read');
  assert.deepEqual(ho.res.projected.kpis, []);
  assert.deepEqual(ho.res.projected.tables.map((x) => x.key), ['securityOperationalShiftHandover']);
  const hoTable = ho.res.projected.tables[0];
  assert.equal(HO_FIELDS.length, 9);
  assert.deepEqual(cols(hoTable), HO_FIELDS, 'HANDOVER column order still matches its own type');
  assert.deepEqual(hoTable.rows.map((r) => r.bindingId), [BIND1, BIND2]);
  assert.deepEqual(hoTable.rows.map((r) => r.shiftHandoverId), [HANDOVER, HANDOVER],
    'a repeated shiftHandoverId still survives');

  // One table per response, never several, and no placeholder for INCIDENT_READINESS.
  const fRes = (await load(FINDING_Q)).res;
  for (const r of [pt.res, ho.res, fRes]) {
    assert.equal(r.projected.tables.length, 1);
  }
  assert.equal(fRes.projected.tables.some((x) => /incidentReadiness|IncidentReadiness/i.test(x.key)),
    false, 'no placeholder table for the unimplemented source');
  assert.equal(fRes.projected.tables.some((x) => x.key !== 'securityOperationalFinding'), false);
});

test('PART 17 — Reporting holds no Security SQL, no forbidden file changed, docs truthful', () => {
  // 9 — no Security-domain SQL is authored in Reporting (comments stripped: the prose
  // legitimately names the owning tables to say they are never queried here).
  for (const f of [REG, PROJ]) {
    const code = strip(rd(f));
    for (const tbl of ['security_finding_links', 'FROM findings', 'JOIN findings', 'sfl.',
      'f.reported_at', 'security_shift_handover_bindings', 'shift_handovers', 'sshb.',
      'patrol_schedule_bindings', 'generated_tasks', 'patrol_routes', 'security_posts',
      'getPool', '.query(']) {
      assert.equal(code.includes(tbl), false, `${f} must hold no ${tbl} SQL`);
    }
  }
  // The adapter imports the owning module's PUBLIC index and never its repository.
  assert.match(rd(REG), /from '\.\.\/security-reports';/);
  assert.equal(/from '\.\.\/security-reports\//.test(rd(REG)), false, 'no submodule import');
  assert.equal(/securityReportRepository/.test(strip(rd(REG))), false, 'repository never used');
  assert.equal(strip(rd(REG)).includes('getSecurityFindingDataset'), true, 'the owning read is used');
  // 24 — the Security domain is untouched: not one file changed under src/modules/security-reports.
  assert.deepEqual(git('diff', '--name-only', BASE, '--', SEC).split('\n').filter(Boolean), [],
    'no security-reports file changed');
  // 25 — no route, no new permission, no migration, no renderer or archive change.
  const changed = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  assert.deepEqual(changed.filter((f) => /migrations|seeds|routes|controller/.test(f)), []);
  assert.deepEqual(changed.filter((f) => /csv-renderer|xlsx-renderer|pdf-renderer|archive/.test(f)), []);
  assert.equal(/requirePermission\(|permission/.test(git('diff', BASE, '--', SEC)), false);
  assert.equal(/requirePermission\(/.test(git('diff', BASE, '--', 'src/modules/reporting-export')), false,
    'no permission enforcement invented in Reporting');
  // Production budget: exactly the three authorized files.
  const production = changed.filter((f) => !f.startsWith('tests/')).sort();
  assert.deepEqual(production, [
    'docs/api/openapi.yaml',
    'src/modules/reporting-export/reporting-export.r10-projections.ts',
    'src/modules/reporting-export/reporting-export.registry.ts',
  ], 'exactly the three authorized production files');
  // State-independent: `git diff` omits UNTRACKED files, so this test file is absent from the list
  // before commit and present after. What holds in both states is that no OTHER test file was
  // touched (the PART 14B lesson) — PART 17 repairs no historical test.
  assert.deepEqual(changed.filter((f) => f.startsWith('tests/') && f !== SELF), [],
    'no prior-phase test file was modified');
  // Purely additive production TypeScript apart from the two literals this PART must change.
  const removed = git('diff', BASE, '--', 'src/').split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    .filter((l) => !/^(\/\/|\*|\/\*)/.test(l)).sort();
  assert.deepEqual(removed, [
    "new Set<SecurityOperationalDetailSource>(['PATROL', 'SHIFT_HANDOVER']);",
    "sourceAuthority: 'BE-12M security-reports patrol and shift-handover datasets',",
  ].sort(), 'only the two mandated literal changes');
  // No PART 18 code: INCIDENT_READINESS stays declared-but-unimplemented.
  assert.equal(/INCIDENT_READINESS/.test(strip(rd(PROJ))), false,
    'no projection exists for the unimplemented source');
  assert.equal(strip(rd(REG)).includes('getIncidentReadinessDataset'), false);
  assert.equal(/projectSecurityOperationalIncidentReadiness/.test(rd(REG)), false);

  // OpenAPI documents the three implemented sources truthfully, at 17 datasets.
  assert.equal(oaEnum.length, 17);
  assert.equal(oaEnum.filter((d) => d === 'SECURITY_OPERATIONAL_DETAIL').length, 1);
  assert.ok(DOC.length > 6000, 'documentation present');
  for (const claim of ['requires security_report.read', 'REQUIRED `source` discriminator',
    'PATROL, SHIFT_HANDOVER and SECURITY_FINDING are implemented',
    'INCIDENT_READINESS remains unimplemented', 'rejected as not yet implemented',
    'securityOperationalFinding', '11 fields', 'row identity is linkId',
    'No synthetic identity is minted',
    'no securityFindingKey, compositeFindingId, findingReference or sourceFindingId',
    'a repeated findingId legitimately appears on several rows and is preserved',
    'never collapsed, grouped, deduplicated or ranked',
    'no latest, current, most recent, active or effective finding', 'no LIMIT 1',
    'no ROW_NUMBER', 'NOT the R08 Finding child grain and NOT the FINDING_REGISTER dataset',
    'performs no join to either',
    '`buildingId` is REQUIRED for source=SECURITY_FINDING',
    'never rolls up across every accessible Building',
    'bound the FINDING\'s persisted reported instant with a half-open range',
    'constant ACTIVE literal', 'no open, closed, resolved, overdue, aging, breached or escalated',
    'publishes no actor field of any kind',
    'no createdBy, reportedBy, assignedTo, verifiedBy or resolvedBy column',
    'No SLA, overdue or age value is materialized',
    'no SLA, overdue, age, timeOpen, breach, responseTime or resolutionTime field',
    'no current-time arithmetic', 'No KPI is calculated for this source',
    'no finding count, open count, critical count, closure rate, average age or overdue count',
    'kpis is empty', 'no dataset-specific CSV default',
    'never holds more than one of securityOperationalPatrol']) {
    assert.ok(DOC.includes(claim), `documentation must state: ${claim}`);
  }
  // The PATROL and SHIFT_HANDOVER contracts are still documented, semantically unchanged.
  for (const claim of ['13 fields', 'taskId and patrolScheduleBindingId', 'repeated taskId is valid',
    'no generatedTaskId field', 'no primary, current, first or latest binding',
    'NOT an exact contributor list', 'securityOperationalShiftHandover', '9 fields',
    'row identity is bindingId', 'a repeated shiftHandoverId legitimately appears']) {
    assert.ok(DOC.includes(claim), `prior documentation must still state: ${claim}`);
  }
  // No claim of PART 18 functionality, and the stale PART 16 wording is gone.
  assert.equal(DOC.includes('securityOperationalIncidentReadiness'), false);
  assert.equal(/INCIDENT_READINESS[^.]*is implemented/.test(DOC), false);
  assert.equal(DOC.includes('PATROL is implemented and SHIFT_HANDOVER is implemented'), false);
  assert.equal(DOC.includes('only PATROL is implemented'), false);
  // PART 17 adds a SOURCE to an existing dataset, never a dataset, so the enum block must be
  // byte-identical to the baseline. Compared directly rather than by guessing YAML line wrapping.
  const enumNow = docBlock.slice(docBlock.indexOf('enum:'), docBlock.indexOf('description:'));
  const baseBlock = git('show', `${BASE}:docs/api/openapi.yaml`)
    .split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
  const enumBase = baseBlock.slice(baseBlock.indexOf('enum:'), baseBlock.indexOf('description:'));
  assert.equal(enumNow, enumBase, 'the dataset enum is byte-identical to the PART 16 baseline');
});
