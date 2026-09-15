/**
 * R10 PART 18 — SECURITY_OPERATIONAL_DETAIL / source=INCIDENT_READINESS.
 *
 * EXECUTED FOR REAL: the 17-entry dataset enum, the SECURITY_OPERATIONAL_DETAIL registry adapter
 * (its required `source` discriminator, its retained fail-closed guard, its required buildingId
 * assertion and ALL FOUR source branches), the new incident-readiness projection, the unchanged
 * PATROL / SHIFT_HANDOVER / SECURITY_FINDING projections, and the owning BE-12M reads — the real
 * `parseReportQuery`, the real `securityReportService` dataset functions, the real
 * `resolveBuildingScope` path and the real SQL generation and row mapping. Generated SQL, bound
 * parameters and mapped rows are OBSERVED, not read from source text.
 *
 * ONLY THE I/O BOUNDARY IS FAKED via `module.registerHooks` (the PART 13-17 technique):
 * `src/database` returns canned driver rows routed by each grain's own unique FROM table, and
 * `../buildings` / `../context-access` return a canned authorized scope. `../security-reports` is
 * served by a router-free FACADE re-exporting the real service and the real validation module,
 * because that module's public index also re-exports `createSecurityReportRouter`, whose
 * express -> auth -> bcryptjs chain cannot load without node_modules. The production adapter
 * imports the public index, asserted statically below. Other registry siblings are inert stubs.
 *
 * The fake pool returns canned rows verbatim and does not apply the generated WHERE clause, so
 * filter-to-row correspondence is not asserted here (the owning BE-12M read owns that SQL); what
 * IS asserted is the generated SQL text and the bound parameters — including the load-bearing
 * fact that this source's SQL carries NO date predicate at all.
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
const BASE = '0d93d1b294d58b6d23d49a346f9d77e033860125';
const REG = 'src/modules/reporting-export/reporting-export.registry.ts';
const PROJ = 'src/modules/reporting-export/reporting-export.r10-projections.ts';
const SEC = 'src/modules/security-reports';
const SELF = 'tests/r10-part18-security-operational-incident-readiness.test.ts';

const BLDG = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';
const POST = '55555555-5555-4555-8555-555555555555';
const ROUTE = '44444444-4444-4444-8444-444444444444';
const TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WORKFORCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IR1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const IR2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const FINDING = '99999999-9999-4999-8999-999999999999';
const LINK1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINK2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BIND1 = '22222222-2222-4222-8222-222222222222';
const BIND2 = '33333333-3333-4333-8333-333333333333';
const HANDOVER = '88888888-8888-4888-8888-888888888888';
const TASK = '11111111-1111-4111-8111-111111111111';

const ctl = { calls: [], irRows: [], findingRows: [], handoverRows: [], patrolRows: [] };
globalThis.__P18 = ctl;

/**
 * Two readiness records sharing ONE responsible team and ONE responsible workforce, with different
 * identities, statuses and categories: proves those related facts are never deduplicated and that
 * the persisted status is never normalized or collapsed.
 */
const irRow = (bindingId, status, category) => ({
  binding_id: bindingId, building_id: BLDG,
  security_post_id: POST, security_post_code: 'POST-1',
  category, status,
  team_id: TEAM, team_name: 'Alpha Team',
  primary_workforce_id: WORKFORCE, primary_workforce_full_name: 'Jane Guard',
  updated_at: new Date('2026-03-01T06:00:00.000Z'),
});
const IR_ROWS = [irRow(IR1, 'NOT_READY', 'FIRE'), irRow(IR2, 'READY', 'MEDICAL')];
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
ctl.irRows = IR_ROWS; ctl.findingRows = F_ROWS;
ctl.handoverRows = HO_ROWS; ctl.patrolRows = PT_ROWS;

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
  // Routed by each grain's own unique FROM table, because two grains share the `AS binding_id`
  // SELECT alias and cannot be told apart by alias alone.
  database: `export const getPool = () => ({ query: async (sql, params) => {
    const c = globalThis.__P18; c.calls.push({ sql, params });
    const rows = sql.includes('FROM security_incident_readiness') ? c.irRows
      : sql.includes('FROM security_finding_links') ? c.findingRows
      : sql.includes('FROM security_shift_handover_bindings') ? c.handoverRows
      : sql.includes('FROM generated_tasks') ? c.patrolRows : [];
    return { rows, rowCount: rows.length }; } });`,
  buildings: `export { buildingNotFoundError } from ${JSON.stringify(abs('src/modules/buildings/building.errors.ts'))};
export const buildingRepository = { findById: async (id) => ({ id }) };`,
  'context-access': `export const contextAccessService = {
    getAccessibleBuildingIds: async () => [], assertBuildingAccess: async () => undefined };`,
  // Router-free facade over the REAL service and the REAL validation module.
  'security-reports': `export { securityReportService } from ${JSON.stringify(abs(`${SEC}/security-report.service.ts`))};
export { parseReportQuery, reportRange, HANDOVER_REPORT_STATUSES, FINDING_REPORT_STATUSES, INCIDENT_READINESS_REPORT_STATUSES } from ${JSON.stringify(abs(`${SEC}/security-report.validation.ts`))};`,
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
const IR_FIELDS = fieldsOf('PublicIncidentReadinessDatasetRow');
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
const IR_Q = { source: 'INCIDENT_READINESS', buildingId: BLDG };

test('PART 18 — dataset surface stays 17 and all four frozen sources are implemented', () => {
  assert.equal(DATASETS.length, 17);                                     // 1
  assert.equal(oaEnum.length, 17);                                       // 2
  assert.deepEqual(oaEnum, [...DATASETS], 'OpenAPI enum matches runtime enum in order');
  assert.equal(DATASETS.filter((d) => d === 'SECURITY_OPERATIONAL_DETAIL').length, 1);
  assert.equal(Object.keys(registry.REPORTING_EXPORT_DATASET_REGISTRY).length, 17);
  // No dataset enum was added for the new source, and no alias exists.
  for (const banned of ['INCIDENT_READINESS', 'SECURITY_INCIDENT_READINESS',
    'INCIDENT_READINESS_DETAIL', 'SECURITY_OPERATIONAL_INCIDENT_READINESS', 'INCIDENT_DETAIL']) {
    assert.equal(DATASETS.includes(banned), false, `${banned} must not be a dataset`);
  }
  assert.deepEqual(DATASETS.filter((d) => /SECURITY_OPERATIONAL/.test(d)),
    ['SECURITY_OPERATIONAL_DETAIL']);
  // 3 — the frozen vocabulary is unchanged and now fully implemented, declared exactly once.
  assert.deepEqual([...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']);
  assert.match(rd(REG), /new Set<SecurityOperationalDetailSource>\(\[\s*'PATROL',\s*'SHIFT_HANDOVER',\s*'SECURITY_FINDING',\s*'INCIDENT_READINESS',\s*\]\)/);
  assert.equal((rd(REG).match(/new Set<SecurityOperationalDetailSource>/g) ?? []).length, 1,
    'exactly one implemented-source set exists');
  assert.equal((rd(REG).match(/if \(source === '/g) ?? []).length, 3,
    'three explicit source branches; the fourth source is the PATROL fall-through');
  // The vocabulary was already staged, so the type authority needed no change.
  assert.deepEqual(git('diff', '--name-only', BASE, '--',
    'src/modules/reporting-export/reporting-export.types.ts').split('\n').filter(Boolean), []);
});

test('PART 18 — permission, required buildingId, and every declared source now routes', async () => {
  assert.equal(ADAPTER.dataset, 'SECURITY_OPERATIONAL_DETAIL');
  assert.equal(ADAPTER.requiredReadPermission, 'security_report.read');  // 5
  for (const bad of ['security.read', 'incident.read', 'incident_readiness.read', 'readiness.read',
    'finding.read', 'reporting.read', 'admin']) {
    assert.notEqual(ADAPTER.requiredReadPermission, bad);
  }
  // The permission is the one the owning route already uses for this exact endpoint.
  const routes = rd(`${SEC}/security-report.routes.ts`);
  assert.match(routes, /const read = requirePermission\('security_report\.read'\)/);
  const irRoute = routes.slice(routes.indexOf("'/security/reports/incident-readiness'"));
  assert.match(irRoute.slice(0, 200), /auth,\s*read,\s*incidentReadinessDatasetHandler/);
  // `source` stays REQUIRED: no default, no inference from filters, no silent empty result.
  for (const q of [{}, { buildingId: BLDG }, { source: '', buildingId: BLDG },
    { source: '   ', buildingId: BLDG }, { source: ['INCIDENT_READINESS'], buildingId: BLDG },
    { buildingId: BLDG, status: 'READY' }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.match(details(err), /^source: source is required and must be one of/,
      'source is never inferred from the filters present');
    assert.equal(calls.length, 0, 'the owning read is never reached');
  }
  // The fail-closed guard is RETAINED even though the vocabulary is now fully implemented: an
  // unknown or future value is still rejected rather than routed to another source.
  for (const s of ['READINESS', 'INCIDENT', 'ALL', 'BOTH', 'PATROL_AND_FINDING']) {
    const unk = await load({ source: s, buildingId: BLDG });
    assert.ok(unk.err, `${s} must be rejected`);
    assert.equal(unk.err.statusCode, 400);
    assert.match(details(unk.err), /source is required and must be one of/);
    assert.equal(unk.calls.length, 0, `${s} must not query any Security read`);
  }
  // All four declared sources now route to their own read — behavioural proof of availability.
  for (const s of ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']) {
    const ok = await load({ source: s, buildingId: BLDG });
    assert.equal(ok.err, undefined, `${s} must be implemented`);
    assert.equal(ok.calls.length, 1, `${s} calls exactly one owning read`);
    assert.equal(ok.res.projected.tables.length, 1, `${s} returns exactly one table`);
  }
  // 4 — buildingId is REQUIRED and never widens to all accessible Buildings.
  for (const q of [{ source: 'INCIDENT_READINESS' }, { source: 'INCIDENT_READINESS', buildingId: '' }]) {
    const { err, calls } = await load(q);
    assert.ok(err, `must reject ${JSON.stringify(q)}`);
    assert.match(details(err), /buildingId: buildingId is required for source=INCIDENT_READINESS/);
    assert.equal(calls.length, 0, 'no roll-up query is issued');
  }
  // Whitespace-only or malformed values are rejected by the owning parser's own UUID authority:
  // PRESENCE is asserted in Reporting, FORMAT stays with BE-12M.
  const blank = await load({ source: 'INCIDENT_READINESS', buildingId: '   ' });
  assert.match(details(blank.err), /buildingId: buildingId must be a valid UUID/);
  assert.equal(blank.calls.length, 0);
  const bad = await load({ source: 'INCIDENT_READINESS', buildingId: 'not-a-uuid' });
  assert.match(details(bad.err), /buildingId must be a valid UUID/);
  assert.equal(bad.calls.length, 0);
  // The owning module's own readiness vocabulary is reused, so an unknown status is a validation
  // error rather than a silently empty register, and a real one is accepted.
  const bogus = await load({ ...IR_Q, status: 'BOGUS' });
  assert.match(details(bogus.err), /status/);
  assert.equal(bogus.calls.length, 0);
  for (const s of ['NOT_READY', 'PARTIAL', 'READY']) {
    const ok = await load({ ...IR_Q, status: s });
    assert.equal(ok.err, undefined, `${s} is part of the owning readiness vocabulary`);
    assert.ok(ok.calls[0].params.includes(s), `${s} is bound through to the owning read`);
  }
  // Case normalization stays the owning parser's, not a second parser in Reporting.
  const lower = await load({ source: 'incident_readiness', buildingId: BLDG });
  assert.equal(lower.err, undefined);
  assert.equal(lower.res.appliedFilters.source, 'INCIDENT_READINESS');
});

test('PART 18 — INCIDENT_READINESS delegates to the owning read with NO period bound', async () => {
  const { res, calls } = await load({ ...IR_Q, status: 'READY', securityPostId: POST,
    teamId: TEAM, workforceId: WORKFORCE, category: 'FIRE',
    dateFrom: '2026-03-01', dateTo: '2026-03-31' });
  assert.equal(res.err, undefined);
  // 6 — exactly ONE query, generated by the OWNING module: Reporting holds no readiness SQL.
  assert.equal(calls.length, 1, 'the governed read is called exactly once');
  const sql = calls[0].sql;
  assert.match(sql, /FROM security_incident_readiness sir/);
  assert.match(sql, /sir\.building_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(sql, /sir\.security_post_id = \$\d/);
  assert.match(sql, /sir\.responsible_team_id = \$\d/);
  assert.match(sql, /sir\.responsible_workforce_id = \$\d/);
  assert.match(sql, /sir\.readiness_status = \$\d/);
  assert.match(sql, /sir\.category = \$\d/);
  assert.match(sql, /LEFT JOIN security_posts sp ON sp\.id = sir\.security_post_id/);
  assert.match(sql, /LEFT JOIN teams t ON t\.id = sir\.responsible_team_id/);
  assert.match(sql, /LEFT JOIN workforce_profiles wp ON wp\.id = sir\.responsible_workforce_id/);
  assert.match(sql, /ORDER BY sir\.updated_at DESC, sir\.created_at DESC/);
  // The load-bearing period fact: NO date predicate exists, even though dateFrom/dateTo were
  // supplied. Neither updatedAt nor any other instant is used as a bound.
  assert.equal(sql.includes('>='), false, 'no lower date bound is applied');
  assert.equal(sql.includes('<'), false, 'no upper date bound is applied');
  assert.equal(sql.includes('BETWEEN'), false, 'no BETWEEN period predicate');
  assert.equal(/created_at >=|updated_at >=|reported_at/.test(sql), false,
    'no substituted timestamp bound');
  // This read does not apply patrolRouteId either.
  assert.equal(sql.includes('patrol_route_id'), false, 'patrolRouteId is not applied by this read');
  assert.deepEqual(calls[0].params[0], [BLDG], 'the requested Building is the bound scope');
  for (const v of ['READY', POST, TEAM, WORKFORCE, 'FIRE']) {
    assert.ok(calls[0].params.includes(v), `${v} is bound through to the owning read`);
  }
  // The echoed period describes the request, not an enforced bound; the scope is the authorized one.
  assert.equal(res.common.buildingId, BLDG);
  assert.deepEqual(res.common.buildingScope, [BLDG]);
  assert.equal(res.common.dateFrom, '2026-03-01');
  assert.equal(res.common.dateTo, '2026-03-31');
  assert.equal(typeof res.common.asOf, 'string');
  // 10, 15 — exactly one table, the readiness one, and no KPI.
  assert.deepEqual(res.projected.kpis, []);
  assert.equal(res.projected.tables.length, 1);
  const t = res.projected.tables[0];
  assert.equal(t.key, 'securityOperationalIncidentReadiness');
  assert.deepEqual(res.projected.tables.map((x) => x.key), ['securityOperationalIncidentReadiness']);
  assert.equal(t.rows.length, 2, 'one row per governed dataset row');
  // 9, 12 — identity is the record's own id; repeated related facts survive as distinct rows.
  assert.deepEqual(t.rows.map((r) => r.bindingId), [IR1, IR2]);
  assert.equal(new Set(t.rows.map((r) => r.bindingId)).size, 2);
  assert.deepEqual(t.rows.map((r) => r.teamId), [TEAM, TEAM],
    'a repeated responsible team is never deduplicated');
  assert.deepEqual(t.rows.map((r) => r.primaryWorkforceId), [WORKFORCE, WORKFORCE],
    'a repeated responsible workforce is never deduplicated');
  assert.deepEqual(t.rows.map((r) => r.securityPostId), [POST, POST]);
  for (const r of t.rows) {
    for (const banned of ['incidentReadinessKey', 'compositeIncidentId', 'currentIncident',
      'latestIncident', 'primaryIncident', 'rowKey', 'id', 'readinessKey']) {
      assert.equal(banned in r, false, `no synthesized identity field ${banned}`);
    }
  }
  // 17 — order is the owning read's: no post-query sort, filter, dedup, group or collapse.
  assert.deepEqual(t.rows.map((r) => r.status), ['NOT_READY', 'READY'],
    'rows keep the order and the distinct statuses the owning read produced');
  // 8 — every row holds exactly the authoritative fields, in authoritative order.
  assert.equal(IR_FIELDS.length, 11, 'the authoritative public row has eleven fields');
  for (const r of t.rows) assert.deepEqual(Object.keys(r), IR_FIELDS);
  assert.deepEqual(cols(t), IR_FIELDS, 'column order matches the authoritative type');
  assert.deepEqual(t.columns.map((c) => c.label), ['Binding Id', 'Building Id', 'Security Post Id',
    'Security Post Code', 'Category', 'Readiness Status', 'Team Id', 'Team Name',
    'Primary Workforce Id', 'Primary Workforce Name', 'Updated At']);
  // 13 — status and category are copied verbatim; nothing is derived or normalized.
  assert.deepEqual(t.rows.map((r) => r.category), ['FIRE', 'MEDICAL']);
  for (const r of t.rows) {
    for (const banned of ['ready', 'notReady', 'partial', 'compliant', 'overdue', 'breached',
      'stale', 'aging', 'isReady', 'readinessLevel', 'derivedStatus', 'readinessPercentage']) {
      assert.equal(banned in r, false, `no derived readiness field ${banned}`);
    }
    // 14 — no SLA, overdue or age arithmetic anywhere on the row.
    for (const k of Object.keys(r)) {
      assert.equal(/sla|overdue|age|timeOpen|breach|responseTime|resolutionTime|dueBefore|grace|stale/i
        .test(k), false, `no SLA or ageing field ${k}`);
    }
    // Actor semantics: RESPONSIBILITY is preserved under the authoritative names and is never
    // relabeled as execution.
    for (const k of Object.keys(r)) {
      assert.equal(/executor|performedBy|completedBy|assignee|responder|actor|executedBy/i.test(k),
        false, `responsibility is never relabeled as execution (${k})`);
    }
    assert.equal('teamId' in r && 'primaryWorkforceId' in r, true,
      'the responsible team and workforce keep their authoritative names');
    // Renderer safety: all eleven values are scalars, nothing serialized or flattened.
    for (const [k, v] of Object.entries(r)) {
      assert.ok(v === null || typeof v === 'string' || typeof v === 'number',
        `${k} must be a renderer-safe scalar`);
    }
  }
  // The verbatim scalar facts survive unchanged, including the LEFT JOIN labels.
  assert.equal(t.rows[0].buildingId, BLDG);
  assert.equal(t.rows[0].teamName, 'Alpha Team');
  assert.equal(t.rows[0].primaryWorkforceName, 'Jane Guard');
  assert.equal(t.rows[0].updatedAt, '2026-03-01T06:00:00.000Z');
  // A caller-supplied patrolRouteId is passed to the parser but never becomes a readiness predicate.
  const withRoute = await load({ ...IR_Q, patrolRouteId: ROUTE });
  assert.equal(withRoute.err, undefined);
  assert.equal(withRoute.calls[0].sql.includes('patrol_route_id'), false,
    'patrolRouteId is ignored by this read exactly as the owning endpoint ignores it');
});

test('PART 18 — no selector, no KPI, no CSV default; the other three sources unchanged', async () => {
  const projAll = strip(rd(PROJ));
  const irProj = projAll.slice(projAll.indexOf('export function projectSecurityOperationalIncidentReadiness'));
  // 11 — no latest/current election, no ranking construct, no post-query manipulation, no clock.
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT', 'GROUP BY', 'MAX(', 'mostRecent',
    'latestIncident', 'currentIncident', 'primaryIncident', 'activeIncident', '.sort(', '.find(',
    '.filter(', '.reduce(', '[0]', 'new Date(', 'Date.now(', 'toISOString()']) {
    assert.equal(irProj.includes(banned), false, `no ${banned} in the readiness projection`);
  }
  for (const banned of ['sla', 'overdue', 'ageDays', 'timeOpen', 'breach', 'responseTime',
    'resolutionTime', 'readinessPercentage', 'incidentCount', 'openCount', 'notReadyCount',
    'kpis.push', 'count(', 'rate']) {
    assert.equal(irProj.toLowerCase().includes(banned.toLowerCase()), false,
      `no ${banned} in the readiness projection`);
  }
  const regStripped = strip(rd(REG));
  const irBranch = regStripped.slice(regStripped.indexOf("if (source === 'INCIDENT_READINESS') {"),
    regStripped.indexOf('const filters = parseReportQuery(passThrough);'));
  assert.ok(irBranch.length > 200, 'the readiness branch slice must be non-trivial');
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT', 'GROUP BY', '.sort(', '.filter(',
    '.reduce(', 'latest', 'current', 'mostRecent', 'sla', 'overdue', 'ageDays', 'reportRange']) {
    assert.equal(irBranch.toLowerCase().includes(banned.toLowerCase()), false,
      `no ${banned} in the readiness branch`);
  }
  // Exactly one clock read in the branch: the envelope instant, nothing else.
  assert.equal((irBranch.match(/new Date\(\)\.toISOString\(\)/g) ?? []).length, 1,
    'one envelope instant only');
  // No second readiness authority, no enrichment and no cross-grain join.
  for (const banned of ['findingRegister', 'FindingRegister', 'incidentKpi', 'securityPatrolKpi',
    'workforceKpi', 'teamRepository', 'workforceRepository']) {
    assert.equal(irBranch.includes(banned), false, `readiness branch never touches ${banned}`);
  }
  // 19 — no dataset CSV default: the table key is source-dependent.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.SECURITY_OPERATIONAL_DETAIL, undefined);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL.csvDefaultTableKey,
    'operationalDetail', 'the OPERATIONAL_DETAIL default is intact');
  const adapterAll = regStripped.slice(regStripped.indexOf('  SECURITY_OPERATIONAL_DETAIL: {'));
  assert.equal(adapterAll.includes('csvDefaultTableKey'), false);

  // 16 — PATROL unchanged: same table, same 13-field identity semantics, no timeliness.
  const pt = await load({ source: 'PATROL', buildingId: BLDG });
  assert.equal(pt.err, undefined);
  assert.match(pt.calls[0].sql, /FROM generated_tasks/);
  assert.equal(pt.calls[0].sql.includes('security_incident_readiness'), false,
    'PATROL never queries the readiness read');
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

  // 17 — SHIFT_HANDOVER unchanged: same table, same 9-field binding identity.
  const ho = await load({ source: 'SHIFT_HANDOVER', buildingId: BLDG });
  assert.equal(ho.err, undefined);
  assert.match(ho.calls[0].sql, /FROM security_shift_handover_bindings/);
  assert.equal(ho.calls[0].sql.includes('security_incident_readiness'), false);
  assert.deepEqual(ho.res.projected.kpis, []);
  assert.deepEqual(ho.res.projected.tables.map((x) => x.key), ['securityOperationalShiftHandover']);
  const hoTable = ho.res.projected.tables[0];
  assert.equal(HO_FIELDS.length, 9);
  assert.deepEqual(cols(hoTable), HO_FIELDS, 'HANDOVER column order still matches its own type');
  assert.deepEqual(hoTable.rows.map((r) => r.bindingId), [BIND1, BIND2]);
  assert.deepEqual(hoTable.rows.map((r) => r.shiftHandoverId), [HANDOVER, HANDOVER],
    'a repeated shiftHandoverId still survives');

  // 18 — SECURITY_FINDING unchanged: same table, same 11-field link identity.
  const fd = await load({ source: 'SECURITY_FINDING', buildingId: BLDG });
  assert.equal(fd.err, undefined);
  assert.match(fd.calls[0].sql, /FROM security_finding_links/);
  assert.equal(fd.calls[0].sql.includes('security_incident_readiness'), false);
  assert.deepEqual(fd.res.projected.kpis, []);
  assert.deepEqual(fd.res.projected.tables.map((x) => x.key), ['securityOperationalFinding']);
  const fdTable = fd.res.projected.tables[0];
  assert.equal(F_FIELDS.length, 11);
  assert.deepEqual(cols(fdTable), F_FIELDS, 'FINDING column order still matches its own type');
  assert.deepEqual(fdTable.rows.map((r) => r.linkId), [LINK1, LINK2]);
  assert.deepEqual(fdTable.rows.map((r) => r.findingId), [FINDING, FINDING],
    'a repeated findingId still survives');
  assert.deepEqual(fdTable.rows.map((r) => r.linkStatus), ['ACTIVE', 'ACTIVE'],
    'the constant linkStatus literal is still copied, not derived');

  // Exactly one table per response across all four sources, each with its own key.
  const ir = await load(IR_Q);
  const seen = [pt.res, ho.res, fd.res, ir.res].map((r) => r.projected.tables.map((x) => x.key));
  assert.deepEqual(seen, [['securityOperationalPatrol'], ['securityOperationalShiftHandover'],
    ['securityOperationalFinding'], ['securityOperationalIncidentReadiness']]);
  for (const r of [pt.res, ho.res, fd.res, ir.res]) {
    assert.equal(r.projected.tables.length, 1, 'never more than one table');
    assert.deepEqual(r.projected.kpis, []);
  }
});

test('PART 18 — Reporting holds no Security SQL, no forbidden file changed, docs truthful', () => {
  // 7 — no Security-domain SQL is authored in Reporting (comments stripped: the prose
  // legitimately names the owning tables to say they are never queried here).
  for (const f of [REG, PROJ]) {
    const code = strip(rd(f));
    for (const tbl of ['security_incident_readiness', 'sir.', 'readiness_status',
      'responsible_team_id', 'responsible_workforce_id', 'workforce_profiles',
      'security_finding_links', 'FROM findings', 'JOIN findings', 'sfl.', 'f.reported_at',
      'security_shift_handover_bindings', 'shift_handovers', 'sshb.',
      'patrol_schedule_bindings', 'generated_tasks', 'patrol_routes', 'security_posts',
      'getPool', '.query(']) {
      assert.equal(code.includes(tbl), false, `${f} must hold no ${tbl} SQL`);
    }
  }
  // The adapter imports the owning module's PUBLIC index and never its repository.
  assert.match(rd(REG), /from '\.\.\/security-reports';/);
  assert.equal(/from '\.\.\/security-reports\//.test(rd(REG)), false, 'no submodule import');
  assert.equal(/securityReportRepository/.test(strip(rd(REG))), false, 'repository never used');
  assert.equal(strip(rd(REG)).includes('getIncidentReadinessDataset'), true, 'the owning read is used');
  // 20 — the Security domain is untouched: not one file changed under src/modules/security-reports.
  assert.deepEqual(git('diff', '--name-only', BASE, '--', SEC).split('\n').filter(Boolean), [],
    'no security-reports file changed');
  // 21 — no route, no new permission, no migration, no renderer or archive change.
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
  // touched (the PART 14B lesson) — PART 18 repairs no historical test.
  assert.deepEqual(changed.filter((f) => f.startsWith('tests/') && f !== SELF), [],
    'no prior-phase test file was modified');
  // Purely additive production TypeScript apart from the one literal this PART must change.
  const removed = git('diff', BASE, '--', 'src/').split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    .filter((l) => !/^(\/\/|\*|\/\*)/.test(l)).sort();
  assert.deepEqual(removed, [
    "'BE-12M security-reports patrol, shift-handover and security-finding datasets',",
  ], 'only the mandated sourceAuthority literal changed');
  // No PART 19 code: no further Security dataset read is wired and no vocabulary value was added.
  for (const banned of ['getSecurityPostDataset', 'getVisitorBindingDataset', 'getLostFoundDataset',
    'getKeyControlDataset', 'getSecuritySummary']) {
    assert.equal(strip(rd(REG)).includes(banned), false, `no ${banned} wired`);
  }
  assert.deepEqual([...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS'],
    'no fifth source was staged');

  // OpenAPI documents all four implemented sources truthfully, at 17 datasets.
  assert.equal(oaEnum.length, 17);
  assert.equal(oaEnum.filter((d) => d === 'SECURITY_OPERATIONAL_DETAIL').length, 1);
  assert.ok(DOC.length > 8000, 'documentation present');
  for (const claim of ['requires security_report.read', 'REQUIRED `source` discriminator',
    'all four are implemented', 'the fail-closed guard is deliberately retained',
    'securityOperationalIncidentReadiness', '11 fields', 'row identity is bindingId',
    'No synthetic identity is minted',
    'no incidentReadinessKey, compositeIncidentId, currentIncident, latestIncident or primaryIncident',
    'Rows are never collapsed, grouped, deduplicated or ranked',
    'no latest, current, most recent, active, effective or primary record is selected',
    'no LIMIT 1', 'no ROW_NUMBER', 'applies NO period bound at all',
    'do NOT restrict the returned rows', 'This read also does not apply patrolRouteId',
    'never used as a bound', 'with no post-query sort',
    '`buildingId` is REQUIRED for source=INCIDENT_READINESS',
    'never rolls up across every accessible Building', 'These rows do carry a buildingId column',
    'NOT_READY, PARTIAL and READY',
    'No openOnly, unresolvedOnly, criticalOnly, readyOnly, notReadyOnly, overdue, ageDays, SLA, latestOnly or currentOnly',
    'The source publishes RESPONSIBILITY, not execution',
    'never relabeled as an executor, performedBy, completedBy, assignee, responder or actor',
    'being responsible for a readiness record is not evidence of having performed anything',
    'Readiness is never inferred, recomputed or escalated here',
    'No SLA, overdue or age value is materialized',
    'no SLA, overdue, age, timeOpen, breach, responseTime, resolutionTime or readiness-percentage field',
    'no current-time arithmetic', 'No KPI is calculated for this source',
    'no readiness percentage, incident count, open count, not-ready count, response KPI, overdue KPI or SLA KPI',
    'kpis is empty', 'no dataset-specific CSV default',
    'never holds more than one of securityOperationalPatrol']) {
    assert.ok(DOC.includes(claim), `documentation must state: ${claim}`);
  }
  // The three earlier source contracts are still documented, semantically unchanged.
  for (const claim of ['13 fields', 'taskId and patrolScheduleBindingId', 'repeated taskId is valid',
    'no generatedTaskId field', 'NOT an exact contributor list',
    'securityOperationalShiftHandover', '9 fields', 'a repeated shiftHandoverId legitimately appears',
    'securityOperationalFinding', 'row identity is linkId', 'constant ACTIVE literal',
    'NOT the R08 Finding child grain and NOT the FINDING_REGISTER dataset']) {
    assert.ok(DOC.includes(claim), `prior documentation must still state: ${claim}`);
  }
  // The stale wording this PART was mandated to replace is gone, and nothing claims a fifth source.
  assert.equal(DOC.includes('INCIDENT_READINESS remains unimplemented'), false);
  assert.equal(DOC.includes('PATROL, SHIFT_HANDOVER and SECURITY_FINDING are implemented'), false);
  assert.equal(DOC.includes('only PATROL is implemented'), false);
  assert.equal(/INCIDENT_READINESS[^.]*remains unimplemented/.test(DOC), false);
  // PART 18 adds a SOURCE to an existing dataset, never a dataset, so the enum block must be
  // byte-identical to the baseline. Compared directly rather than by guessing YAML line wrapping.
  const enumNow = docBlock.slice(docBlock.indexOf('enum:'), docBlock.indexOf('description:'));
  const baseBlock = git('show', `${BASE}:docs/api/openapi.yaml`)
    .split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
  const enumBase = baseBlock.slice(baseBlock.indexOf('enum:'), baseBlock.indexOf('description:'));
  assert.equal(enumNow, enumBase, 'the dataset enum is byte-identical to the PART 17 baseline');
});
