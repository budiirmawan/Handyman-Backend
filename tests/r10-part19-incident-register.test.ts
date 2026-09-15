/**
 * R10 PART 19 — INCIDENT_REGISTER.
 *
 * EXECUTED FOR REAL: the 18-entry dataset enum, the INCIDENT_REGISTER registry adapter, the new
 * projection, and the owning BE-21A read path — the real `parseIncidentFilters`, the real
 * `listIncidents`, the real `assertBuildingAccess` / accessible-Building scoping branch, the real
 * `incidentRepository.list` SQL generation and the real `toPublicIncident` mapper. Generated SQL,
 * bound parameters and mapped rows are OBSERVED, not read from source text.
 *
 * ONLY THE I/O BOUNDARY IS FAKED via `module.registerHooks` (the PART 13-18 technique):
 * `src/database` returns canned driver rows routed by each grain's own unique FROM table, and
 * `../context-access` returns a controllable authorized scope. `../incidents` is served by a
 * router-free FACADE re-exporting the real service and the real validation module, because that
 * module's public index also re-exports `createIncidentRouter`, whose express chain cannot load
 * without node_modules; `../clients` is likewise a facade over the real `isValidUuid` authority.
 * The nine sibling modules `incident.service.ts` imports for its create/update paths are inert
 * stubs, generated from the names that file actually imports — `listIncidents` touches none of
 * them. Other registry siblings are inert stubs too.
 *
 * The fake pool returns canned rows verbatim and does not apply the generated WHERE clause, so
 * filter-to-row correspondence is not asserted here (the owning BE-21A read owns that SQL); what IS
 * asserted is the generated SQL text, the bound parameters, and the load-bearing fact that this
 * read carries NO date predicate at all. Canned rows use the SELECT alias order so the observed
 * runtime key order faithfully emulates the real driver result.
 *
 * node_modules is absent, so there is no tsc/vitest; assertions run under `node --test` with native
 * TypeScript type stripping. Live-PostgreSQL execution remains CI-required.
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
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Fixed baseline so the file-budget proofs hold both before and after commit. */
const BASE = '69f56753b4704e35e0df26a396fea4d1ff8ff136';
const REG = 'src/modules/reporting-export/reporting-export.registry.ts';
const PROJ = 'src/modules/reporting-export/reporting-export.r10-projections.ts';
const TYPES = 'src/modules/reporting-export/reporting-export.types.ts';
const INC = 'src/modules/incidents';
const SELF = 'tests/r10-part19-incident-register.test.ts';

const BLDG = '66666666-6666-4666-8666-666666666666';
const BLDG2 = '77777777-7777-4777-8777-777777777777';
const USER = '88888888-8888-4888-8888-888888888888';
const OTHER = '99999999-9999-4999-8999-999999999999';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INC1 = '11111111-1111-4111-8111-111111111111';
const INC2 = '22222222-2222-4222-8222-222222222222';
const INC3 = '33333333-3333-4333-8333-333333333333';
const INC4 = '44444444-4444-4444-8444-444444444444';

const ctl = { calls: [], rows: [], scope: [BLDG, BLDG2] };
globalThis.__P19 = ctl;

/**
 * Driver-level rows in the exact SELECT alias order, because `incidentRepository.list` returns
 * `result.rows` directly. Three foundation records sharing ONE clientId, ONE buildingId and ONE
 * roomId, spanning all three `incidentType` kinds and all three statuses: proves those repeated
 * related facts are never deduplicated and that neither type nor status is relabeled or inferred.
 */
const incRow = (id, incidentNumber, incidentType, status, extra = {}) => ({
  id, clientId: CLIENT, buildingId: BLDG, incidentNumber, incidentType,
  title: `Incident ${incidentNumber}`, description: null, severity: 'HIGH', priority: 'MEDIUM',
  status, locationType: 'ROOM', floorId: null, areaId: null, roomId: ROOM, spaceId: null,
  functionalLocationId: null, reportedByUserId: USER,
  reportedAt: new Date('2026-03-01T06:00:00.000Z'),
  cancelledAt: null, cancelledByUserId: null,
  closedAt: null, closedByUserId: null, closureNotes: null,
  createdAt: new Date('2026-03-01T06:00:00.000Z'),
  updatedAt: new Date('2026-03-02T06:00:00.000Z'),
  ...extra,
});
const ROWS = [
  incRow(INC1, 'INC-2026-0001', 'OPERATIONAL', 'REPORTED'),
  incRow(INC2, 'INC-2026-0002', 'ASSET_FAILURE', 'CANCELLED', {
    cancelledAt: new Date('2026-03-02T09:00:00.000Z'), cancelledByUserId: OTHER,
  }),
  incRow(INC3, 'INC-2026-0003', 'FINDING_ESCALATION', 'CLOSED', {
    severity: 'CRITICAL', closedAt: new Date('2026-03-03T09:00:00.000Z'),
    closedByUserId: OTHER, closureNotes: 'Resolved on site',
  }),
];
ctl.rows = ROWS;

const registrySrc = rd(REG);
const serviceSrc = rd(`${INC}/incident.service.ts`);
/** Names `incident.service.ts` really imports from a sibling; [^{}]* cannot span another block. */
const importsOf = (spec) => {
  const m = new RegExp(`import\\s*\\{([^{}]*)\\}\\s*from\\s*'${spec.replace(/\//g, '\\/')}';`)
    .exec(serviceSrc);
  assert.ok(m, `test harness: ${spec} must still be imported by incident.service.ts`);
  return m[1].split(',').map((t) => t.trim()).filter((t) => t && !t.startsWith('type '));
};
const inertNames = (dir) => {
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

const INERT = ['finding-register', 'management-operations-command-center',
  'security-finding-incident-kpi', 'security-patrol-kpi', 'utility-kpi',
  'checklist-execution-summary', 'vendor-service-register', 'work-order-register',
  'work-order-sla-register', 'scheduled-operation-lineage', 'permit-to-work-register',
  'vendor-tenant-kpi', 'workforce-kpi', 'operational-detail-reporting', 'corrective-actions',
  'operational-detail-evidence', 'operational-detail-finding-rework',
  'operational-detail-review-history'];
/** Siblings used only by incident create/update paths; `listIncidents` touches none of them. */
const SIBLINGS = ['../areas', '../buildings', '../floors', '../functional-locations',
  '../operational-events', '../properties', '../rooms', '../spaces'];

const STUBS = new Map([[path.join(ROOT, 'src/database/index.ts'), 'database']]);
for (const d of INERT) STUBS.set(path.join(ROOT, `src/modules/${d}/index.ts`), d);
for (const s of SIBLINGS) STUBS.set(path.join(ROOT, `src/modules/${s.slice(3)}/index.ts`), s);
STUBS.set(path.join(ROOT, 'src/modules/context-access/index.ts'), 'context-access');
STUBS.set(path.join(ROOT, 'src/modules/security-reports/index.ts'), 'security-reports');
STUBS.set(path.join(ROOT, 'src/modules/clients/index.ts'), 'clients');
STUBS.set(path.join(ROOT, 'src/modules/incidents/index.ts'), 'incidents');

const SRC = {
  pg: 'export class Pool {}\nexport default { Pool };',
  // Routed by each grain's own unique FROM table; `FROM incidents` is checked LAST because the
  // other grains have longer, more specific table names.
  database: `export const getPool = () => ({ query: async (sql, params) => {
    const c = globalThis.__P19; c.calls.push({ sql, params });
    const rows = sql.includes('FROM security_incident_readiness') ? []
      : sql.includes('FROM security_finding_links') ? []
      : sql.includes('FROM security_shift_handover_bindings') ? []
      : sql.includes('FROM generated_tasks') ? []
      : sql.includes('FROM incidents') ? c.rows : [];
    return { rows, rowCount: rows.length }; } });`,
  // The scope authority the owning read itself uses: controllable so the empty-scope
  // short-circuit is observable, and a pure ACCESS assertion (403), never an existence check.
  'context-access': `import { buildingAccessDeniedError } from ${JSON.stringify(abs('src/modules/context-access/context-access.errors.ts'))};
export const getAccessibleBuildingIds = async () => globalThis.__P19.scope;
export const contextAccessService = {
  getAccessibleBuildingIds: async () => globalThis.__P19.scope,
  assertBuildingAccess: async (userId, buildingId) => {
    if (!globalThis.__P19.scope.includes(buildingId)) throw buildingAccessDeniedError();
  } };`,
  clients: `export { isValidUuid } from ${JSON.stringify(abs('src/modules/clients/client.validation.ts'))};`,
  // Router-free facade over the REAL BE-21A service and the REAL validation module.
  incidents: `export { listIncidents } from ${JSON.stringify(abs(`${INC}/incident.service.ts`))};
export { parseIncidentFilters } from ${JSON.stringify(abs(`${INC}/incident.validation.ts`))};`,
  'security-reports': `export { securityReportService } from ${JSON.stringify(abs('src/modules/security-reports/security-report.service.ts'))};
export { parseReportQuery, reportRange, HANDOVER_REPORT_STATUSES, FINDING_REPORT_STATUSES, INCIDENT_READINESS_REPORT_STATUSES } from ${JSON.stringify(abs('src/modules/security-reports/security-report.validation.ts'))};`,
};
for (const d of INERT) SRC[d] = inertNames(d).map((n) => `export const ${n} = () => {};`).join('\n');
for (const s of SIBLINGS) SRC[s] = importsOf(s).map((n) => `export const ${n} = () => {};`).join('\n');

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
const ADAPTER = registry.REPORTING_EXPORT_DATASET_REGISTRY.INCIDENT_REGISTER;
const REGISTRY = registry.REPORTING_EXPORT_DATASET_REGISTRY;
const docBlock = rd('docs/api/openapi.yaml').split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const oaEnum = [...docBlock.slice(docBlock.indexOf('enum:'), docBlock.indexOf('description:')).matchAll(/[A-Z][A-Z0-9_]{3,}/g)].map((m) => m[0]);
const DOC = docBlock.slice(docBlock.indexOf('INCIDENT_REGISTER (R10)')).replace(/\s+/g, ' ');

/**
 * The authoritative public field order, derived from the SOURCE rather than hardcoded:
 * `incidentRepository.list` returns driver rows whose keys are the shared SELECT aliases in
 * SELECT order, and `toPublicIncident` spreads that record (so the five timestamps keep their
 * positions) and APPENDS the derived `locationId` last.
 */
const repo = rd(`${INC}/incident.repository.ts`);
const selectBlock = repo.slice(repo.indexOf('const SELECT ='), repo.indexOf('`;', repo.indexOf('const SELECT =')));
const AUTH_FIELDS = [...selectBlock.matchAll(/(?:AS "(\w+)"|^ {2}(\w+),?$)/gm)]
  .map((m) => m[1] || m[2]).filter(Boolean).concat(['locationId']);
const baseFile = (f) => git('show', `${BASE}:${f}`);
const baseTypes = baseFile(TYPES);
const baseReg = baseFile(REG);
const baseProj = baseFile(PROJ);
const enumOf = (src) => {
  const i = src.indexOf('REPORTING_EXPORT_DATASETS = [');
  return [...src.slice(i, src.indexOf('] as const', i)).matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]);
};

/** Runs the REAL adapter end to end and returns its result plus the observed SQL calls. */
async function load(query) {
  ctl.calls = [];
  try { return { res: await ADAPTER.load(query, USER), calls: ctl.calls }; }
  catch (e) { return { err: e, calls: ctl.calls }; }
}
const details = (e) => (e.details ?? []).map((d) => `${d.field}: ${d.message}`).join(' | ');
const cols = (t) => t.columns.map((c) => c.key);

test('PART 19 — dataset count 17 -> 18, INCIDENT_REGISTER declared exactly once', () => {
  assert.equal(enumOf(baseTypes).length, 17, 'baseline count');                // 1
  assert.equal(DATASETS.length, 18);                                          // 1
  assert.equal(oaEnum.length, 18);                                            // 2
  assert.equal(Object.keys(REGISTRY).length, 18);                             // 3
  assert.deepEqual(oaEnum, [...DATASETS], 'OpenAPI enum matches runtime enum in order');
  assert.deepEqual(Object.keys(REGISTRY).sort(), [...DATASETS].sort(), 'registry keys match enum');
  // 4 — declared exactly once everywhere, appended last, with no alias.
  assert.equal(DATASETS.filter((d) => d === 'INCIDENT_REGISTER').length, 1);
  assert.equal(oaEnum.filter((d) => d === 'INCIDENT_REGISTER').length, 1);
  assert.equal(Object.keys(REGISTRY).filter((k) => k === 'INCIDENT_REGISTER').length, 1);
  assert.equal(DATASETS[DATASETS.length - 1], 'INCIDENT_REGISTER');
  assert.equal((rd(REG).match(/^ {2}INCIDENT_REGISTER: \{$/gm) ?? []).length, 1);
  assert.equal(ADAPTER.dataset, 'INCIDENT_REGISTER');
  for (const banned of ['INCIDENTS', 'INCIDENTS_REGISTER', 'INCIDENT_LIST', 'INCIDENT_DETAIL',
    'BE21A_INCIDENT', 'INCIDENT_FOUNDATION', 'SECURITY_INCIDENT_REGISTER']) {
    assert.equal(DATASETS.includes(banned), false, `${banned} must not be a dataset`);
  }
  // No OTHER enum was added, and the frozen SECURITY_OPERATIONAL_DETAIL source vocabulary is intact.
  assert.deepEqual(DATASETS.slice(0, 17), enumOf(baseTypes), 'the first 17 datasets are unchanged');
  assert.deepEqual([...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']);
  // The management subset is untouched: INCIDENT_REGISTER is not a management dataset.
  assert.deepEqual([...types.MANAGEMENT_REPORTING_EXPORT_DATASETS],
    ['MANAGEMENT_OPERATIONS_COMMAND_CENTER']);
});

test('PART 19 — permission, governed read, scope authority and the owned filter contract', async () => {
  // 5 — the exact owning permission, source-verified from the route that gates GET /incidents.
  assert.equal(ADAPTER.requiredReadPermission, 'incident.read');
  const routes = rd(`${INC}/incident.routes.ts`);
  assert.match(routes, /const read = requirePermission\('incident\.read'\)/);
  assert.match(routes, /router\.get\('\/incidents', auth, read, listIncidentsHandler\)/);
  for (const bad of ['incident.manage', 'incidents.read', 'incident_read', 'security.read',
    'operational_incident.read', 'incident_closure.read', 'reporting.read', 'admin']) {
    assert.notEqual(ADAPTER.requiredReadPermission, bad);
  }
  // 6 — the OWNING BE-21A read is used: one call, its own SQL, its own scope, its own ordering.
  const { res, calls } = await load({ buildingId: BLDG, status: 'REPORTED', severity: 'HIGH',
    priority: 'MEDIUM', incidentType: 'OPERATIONAL', dateFrom: '2026-03-01', dateTo: '2026-03-31' });
  assert.equal(res.err, undefined);
  assert.equal(calls.length, 1, 'the governed read is called exactly once');
  const sql = calls[0].sql;
  assert.match(sql, /FROM incidents/);
  assert.match(sql, /building_id = ANY\(\$1::uuid\[\]\)/, 'accessible-Building scope in SQL');
  assert.match(sql, /building_id = \$\d/, 'the supplied buildingId narrows');
  assert.match(sql, /incident_type = \$\d/);
  assert.match(sql, /severity = \$\d/);
  assert.match(sql, /priority = \$\d/);
  assert.match(sql, /status = \$\d/);
  assert.match(sql, /ORDER BY reported_at DESC, id DESC/, "the owning read's own ordering");
  assert.deepEqual(calls[0].params[0], [BLDG, BLDG2], 'the accessible scope is bound first');
  for (const v of [BLDG, 'OPERATIONAL', 'HIGH', 'MEDIUM', 'REPORTED']) {
    assert.ok(calls[0].params.includes(v), `${v} is bound through to the owning read`);
  }
  // NO PERIOD AUTHORITY: no date predicate exists even though dateFrom/dateTo were supplied, and
  // the owning parser ignores keys it does not own, so neither reaches the query or the echo.
  assert.equal(sql.includes('>='), false, 'no lower date bound');
  assert.equal(sql.includes('<'), false, 'no upper date bound');
  assert.equal(sql.includes('BETWEEN'), false, 'no BETWEEN period predicate');
  // The SELECT list legitimately names every timestamp column it publishes, so the predicate check
  // is scoped to the WHERE clause: no published instant is ever substituted as a bound.
  const where = sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'));
  assert.ok(where.length > 0, 'the WHERE clause must be present');
  assert.equal(/reported_at|cancelled_at|closed_at|created_at|updated_at/.test(where), false,
    'no timestamp predicate of any kind, so no instant is substituted as a bound');
  assert.equal(res.common.dateFrom, null, 'the envelope period stays null');
  assert.equal(res.common.dateTo, null);
  assert.equal('dateFrom' in res.appliedFilters, false, 'unowned keys are never echoed as filters');
  assert.equal('dateTo' in res.appliedFilters, false);
  // Filters the source does NOT own are ignored by its parser: never invented, never bound.
  for (const invented of ['openOnly', 'criticalOnly', 'unresolvedOnly', 'overdue', 'ageDays',
    'sla', 'latestOnly', 'currentOnly', 'page', 'limit', 'offset', 'sort', 'search']) {
    const r = await load({ buildingId: BLDG, [invented]: 'true' });
    assert.equal(r.err, undefined, `${invented} is ignored by the owning parser, not accepted`);
    assert.equal(invented in r.res.appliedFilters, false, `${invented} is never echoed`);
    assert.equal(r.calls[0].sql.toLowerCase().includes(invented.toLowerCase()), false,
      `${invented} never reaches the SQL`);
  }
  // The owning parser stays the authority on values: unknown enums and malformed UUIDs are 400s.
  for (const q of [{ status: 'BOGUS' }, { incidentType: 'BOGUS' }, { severity: 'BOGUS' },
    { priority: 'BOGUS' }, { buildingId: 'not-a-uuid' }, { buildingId: '   ' }]) {
    const r = await load(q);
    assert.ok(r.err, `must reject ${JSON.stringify(q)}`);
    assert.equal(r.err.statusCode, 400);
    assert.equal(r.calls.length, 0, 'the owning read is never reached');
  }
  for (const s of ['REPORTED', 'CANCELLED', 'CLOSED']) {
    const r = await load({ status: s });
    assert.equal(r.err, undefined, `${s} is part of the source's own vocabulary`);
    assert.ok(r.calls[0].params.includes(s));
  }
  for (const t of ['OPERATIONAL', 'ASSET_FAILURE', 'FINDING_ESCALATION']) {
    assert.equal((await load({ incidentType: t })).err, undefined, `${t} is a source type`);
  }
  // buildingId is OPTIONAL: the source's own multi-Building rollup is preserved, not narrowed.
  const rollup = await load({});
  assert.equal(rollup.err, undefined, 'a rollup with no buildingId is supported');
  assert.equal(rollup.res.common.buildingId, null, 'null for a multi-Building rollup');
  assert.deepEqual(rollup.res.common.buildingScope, [BLDG],
    'the distinct Buildings represented in the authoritative rows');
  assert.equal(rollup.calls[0].sql.includes('building_id = $2'), false, 'no narrowing predicate');
  // A second Building among the authoritative rows widens the reported scope accordingly, which is
  // the source's own rollup behaviour: Reporting never narrows it back to one Building.
  ctl.rows = [...ROWS, incRow(INC4, 'INC-2026-0004', 'OPERATIONAL', 'REPORTED',
    { buildingId: BLDG2 })];
  const two = await load({});
  assert.equal(two.res.common.buildingId, null, 'still a rollup');
  assert.deepEqual(two.res.common.buildingScope, [BLDG, BLDG2], 'both Buildings, sorted');
  assert.equal(two.res.projected.tables[0].rows.length, 4, 'no row was dropped, merged or grouped');
  ctl.rows = ROWS;
  const narrow = await load({ buildingId: BLDG });
  assert.equal(narrow.res.common.buildingId, BLDG);
  // Access denial stays the owning service's, and an empty scope short-circuits before any SQL.
  ctl.scope = [BLDG2];
  const denied = await load({ buildingId: BLDG });
  assert.ok(denied.err, 'an inaccessible Building is denied by the owning service');
  assert.equal(denied.err.statusCode, 403);
  assert.equal(denied.calls.length, 0, 'no incident query is issued for a denied Building');
  ctl.scope = [];
  const empty = await load({});
  assert.equal(empty.err, undefined);
  assert.equal(empty.calls.length, 0, 'an empty accessible scope never queries');
  assert.deepEqual(empty.res.projected.tables[0].rows, [], 'and yields an empty register');
  assert.deepEqual(empty.res.common.buildingScope, []);
  ctl.scope = [BLDG, BLDG2];
});

test('PART 19 — grain, identity, 26 fields, status and actor semantics, no KPI', async () => {
  const { res } = await load({});
  // 10, 16 — exactly one table with the exact key, and no KPI.
  assert.deepEqual(res.projected.kpis, []);
  assert.equal(res.projected.tables.length, 1);
  const t = res.projected.tables[0];
  assert.equal(t.key, 'incidentRegister');
  assert.equal(t.label, 'Incident Register');
  assert.deepEqual(res.projected.tables.map((x) => x.key), ['incidentRegister']);
  assert.equal(t.rows.length, 3, 'one row per authoritative public incident row');
  // 8 — the source field count and order are preserved exactly.
  assert.equal(AUTH_FIELDS.length, 26, 'the authoritative public row has twenty-six fields');
  assert.deepEqual(cols(t), AUTH_FIELDS, 'column order matches the source SELECT order');
  for (const r of t.rows) assert.deepEqual(Object.keys(r), AUTH_FIELDS, 'row key order matches');
  assert.equal(AUTH_FIELDS[AUTH_FIELDS.length - 1], 'locationId',
    'the source appends its derived locationId last');
  assert.deepEqual(t.columns.map((c) => c.type).filter((x) => x === 'DATE').length, 5,
    'exactly the five published instants are DATE columns');
  // 9 — identity is the record's own id, verbatim; incidentNumber is an ordinary fact.
  assert.deepEqual(t.rows.map((r) => r.id), [INC1, INC2, INC3]);
  assert.equal(new Set(t.rows.map((r) => r.id)).size, 3);
  assert.deepEqual(t.rows.map((r) => r.incidentNumber),
    ['INC-2026-0001', 'INC-2026-0002', 'INC-2026-0003']);
  for (const r of t.rows) {
    for (const banned of ['incidentKey', 'incidentCompositeId', 'latestIncidentId',
      'currentIncidentId', 'primaryIncidentId', 'rowKey', 'compositeId']) {
      assert.equal(banned in r, false, `no synthesized identity field ${banned}`);
    }
    // 13 — no SLA, overdue or age arithmetic anywhere on the row.
    for (const k of Object.keys(r)) {
      assert.equal(/sla|overdue|age|timeOpen|breach|responseTime|resolutionTime|daysToClose|dueBefore|grace|stale/i
        .test(k), false, `no SLA or ageing field ${k}`);
    }
    // 14 — actor roles keep their exact source meaning and no name is resolved.
    for (const k of Object.keys(r)) {
      assert.equal(/executor|performedBy|completedBy|assignee|owner|reviewer|responder|actor|executedBy/i
        .test(k), false, `no relabeled actor role (${k})`);
      assert.equal(/Name$/.test(k), false, `no name is resolved for any reference (${k})`);
    }
    // 15 — no derived status or closure flag.
    for (const banned of ['isClosed', 'closed', 'isOpen', 'open', 'resolved', 'derivedStatus',
      'closureState', 'isCancelled', 'cancelled', 'readiness']) {
      assert.equal(banned in r, false, `no derived status field ${banned}`);
    }
    // Renderer safety: all twenty-six values are scalars.
    for (const [k, v] of Object.entries(r)) {
      assert.ok(v === null || typeof v === 'string' || typeof v === 'number',
        `${k} must be a renderer-safe scalar`);
    }
  }
  // 15 — status is copied verbatim; the three source statuses survive side by side and the
  // REPORTED record is never escalated by its timestamps.
  assert.deepEqual(t.rows.map((r) => r.status), ['REPORTED', 'CANCELLED', 'CLOSED']);
  assert.equal(t.rows[0].closedAt, null, 'a REPORTED record keeps its null closedAt');
  assert.equal(t.rows[0].cancelledAt, null);
  // Closure facts stay separate persisted columns, copied verbatim (BE-21K).
  assert.equal(t.rows[2].closedAt, '2026-03-03T09:00:00.000Z');
  assert.equal(t.rows[2].closureNotes, 'Resolved on site');
  assert.equal(t.rows[1].cancelledAt, '2026-03-02T09:00:00.000Z');
  // 14 — actor references verbatim, with no inference where the source has none.
  assert.deepEqual(t.rows.map((r) => r.reportedByUserId), [USER, USER, USER], 'the reporter');
  assert.deepEqual(t.rows.map((r) => r.cancelledByUserId), [null, OTHER, null], 'who cancelled');
  assert.deepEqual(t.rows.map((r) => r.closedByUserId), [null, null, OTHER], 'who closed');
  // All three incidentType kinds share this one register: no split, no per-type table, no relabel.
  assert.deepEqual(t.rows.map((r) => r.incidentType),
    ['OPERATIONAL', 'ASSET_FAILURE', 'FINDING_ESCALATION']);
  // 12 — repeated related facts are never collapsed or deduplicated.
  assert.deepEqual(t.rows.map((r) => r.clientId), [CLIENT, CLIENT, CLIENT]);
  assert.deepEqual(t.rows.map((r) => r.buildingId), [BLDG, BLDG, BLDG]);
  assert.deepEqual(t.rows.map((r) => r.roomId), [ROOM, ROOM, ROOM]);
  assert.equal(t.rows.length, ROWS.length, 'no row was dropped, merged or grouped');
  // severity/priority are copied verbatim, never recomputed from one another.
  assert.deepEqual(t.rows.map((r) => r.severity), ['HIGH', 'HIGH', 'CRITICAL']);
  assert.deepEqual(t.rows.map((r) => r.priority), ['MEDIUM', 'MEDIUM', 'MEDIUM']);
  // The source's OWN locationId derivation is copied, never re-derived here, and all five BE-04
  // references stay published side by side.
  assert.deepEqual(t.rows.map((r) => r.locationId), [ROOM, ROOM, ROOM],
    'locationType ROOM implies roomId, exactly as the owning mapper resolved it');
  assert.deepEqual(t.rows.map((r) => r.locationType), ['ROOM', 'ROOM', 'ROOM']);
  for (const k of ['floorId', 'areaId', 'spaceId', 'functionalLocationId']) {
    assert.ok(k in t.rows[0], `${k} stays published`);
    assert.deepEqual(t.rows.map((r) => r[k]), [null, null, null]);
  }
  // The source's own derived tenancy fact is copied, never accepted from the caller or re-derived.
  assert.deepEqual(t.rows.map((r) => r.clientId), [CLIENT, CLIENT, CLIENT]);
  const callerClient = await load({ clientId: OTHER, buildingId: BLDG });
  assert.equal(callerClient.err, undefined);
  assert.equal('clientId' in callerClient.res.appliedFilters, false,
    'a caller-supplied clientId is ignored, never used as a filter');
  assert.deepEqual(callerClient.res.projected.tables[0].rows.map((r) => r.clientId),
    [CLIENT, CLIENT, CLIENT], 'tenancy still comes from the source rows');
  // The five published instants are ISO strings, verbatim, and none is a period bound.
  assert.equal(t.rows[0].reportedAt, '2026-03-01T06:00:00.000Z');
  assert.equal(t.rows[0].createdAt, '2026-03-01T06:00:00.000Z');
  assert.equal(t.rows[0].updatedAt, '2026-03-02T06:00:00.000Z');
  assert.equal(typeof res.common.asOf, 'string');
});

test('PART 19 — no selector or derivation, SECURITY_OPERATIONAL_DETAIL frozen, docs truthful', () => {
  const sproj = strip(rd(PROJ));
  const irProj = sproj.slice(sproj.indexOf('export function projectIncidentRegister'));
  // 11 — no latest/current election, no ranking construct, no post-query manipulation, no clock.
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT', 'GROUP BY', 'MAX(', 'mostRecent',
    'latestIncident', 'currentIncident', 'primaryIncident', '.sort(', '.find(', '.filter(',
    '.reduce(', '[0]', 'new Date(', 'Date.now(', 'toISOString()']) {
    assert.equal(irProj.includes(banned), false, `no ${banned} in the incident projection`);
  }
  for (const banned of ['sla', 'overdue', 'ageDays', 'timeOpen', 'breach', 'daysToClose',
    'closureRate', 'incidentCount', 'openCount', 'criticalCount', 'kpis.push', 'count(',
    'averageAge']) {
    assert.equal(irProj.toLowerCase().includes(banned.toLowerCase()), false,
      `no ${banned} in the incident projection`);
  }
  const sreg = strip(rd(REG));
  const adapter = sreg.slice(sreg.indexOf('  INCIDENT_REGISTER: {'));
  assert.ok(adapter.length > 400, 'the adapter slice must be non-trivial');
  for (const banned of ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT', 'GROUP BY', 'latest', 'current',
    'mostRecent', 'sla', 'overdue', 'ageDays', 'closureRate', 'incidentCount']) {
    assert.equal(adapter.toLowerCase().includes(banned.toLowerCase()), false,
      `no ${banned} in the INCIDENT_REGISTER adapter`);
  }
  // Exactly one clock read: the envelope instant, nothing else.
  assert.equal((adapter.match(/new Date\(\)\.toISOString\(\)/g) ?? []).length, 1,
    'one envelope instant only');
  // Rows reach the projection untouched: no post-query filter, sort, dedup, group, collapse or
  // enrichment. The single `rows.map` is the documented Building-scope projection over the
  // authoritative rows — it yields scope metadata and never a modified rowset.
  assert.equal((adapter.match(/rows\.map\(/g) ?? []).length, 1,
    'the only rows.map is the documented Building-scope projection');
  assert.equal(/rows\.(filter|sort|reduce|find|slice|splice)\(/.test(adapter), false);
  // No second incident authority, no lifecycle mutation and no unrelated-module enrichment.
  for (const banned of ['incidentRepository', 'createIncident', 'updateIncident', 'cancelIncident',
    'closeIncident', 'operationalIncidentService', 'listOperationalIncidents',
    'incidentClosure', 'listClosureStatuses', 'securityIncidentReadiness', 'userRepository',
    'workforceRepository', 'teamRepository', 'findingRegister']) {
    assert.equal(sreg.includes(banned), false, `registry never touches ${banned}`);
    assert.equal(sproj.includes(banned), false, `projections never touch ${banned}`);
  }
  // 7 — no incident SQL is authored in Reporting (comments stripped: the prose legitimately names
  // the owning tables to say they are never queried here).
  for (const f of [REG, PROJ]) {
    const code = strip(rd(f));
    for (const tbl of ['FROM incidents', 'incident_number', 'incident_type', 'location_type',
      'reported_at', 'reported_by_user_id', 'cancelled_at', 'cancelled_by_user_id', 'closed_at',
      'closed_by_user_id', 'closure_notes', 'client_id', 'building_id', 'functional_location_id',
      'getPool', '.query(', 'security_incident_readiness', 'security_finding_links',
      'security_shift_handover_bindings', 'patrol_schedule_bindings', 'generated_tasks']) {
      assert.equal(code.includes(tbl), false, `${f} must hold no ${tbl} SQL`);
    }
  }
  // The adapter imports the owning module's PUBLIC index and never its repository or router.
  assert.match(rd(REG), /import \{ listIncidents, parseIncidentFilters \} from '\.\.\/incidents';/);
  assert.equal(/from '\.\.\/incidents\//.test(rd(REG)), false, 'no submodule import');
  // Stripped code: the import comment legitimately names `createIncidentRouter` in order to say
  // that it is never imported, so the absence check must ignore comments.
  assert.equal(sreg.includes('createIncidentRouter'), false, 'the incident router is never imported');

  // 17 — no dataset CSV default; OPERATIONAL_DETAIL remains the only configured metadata default.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.INCIDENT_REGISTER, undefined);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL.csvDefaultTableKey,
    'operationalDetail', 'the OPERATIONAL_DETAIL default is intact');
  assert.equal(sreg.slice(sreg.indexOf('  INCIDENT_REGISTER: {')).includes('csvDefaultTableKey'),
    false);

  // 18 — SECURITY_OPERATIONAL_DETAIL is byte-identical to the baseline: the whole adapter and all
  // four of its projections are untouched, as is the frozen source vocabulary.
  const marker = '  SECURITY_OPERATIONAL_DETAIL: {';
  const curSod = rd(REG).slice(rd(REG).indexOf(marker), rd(REG).indexOf('\n  // ----', rd(REG).indexOf(marker))).trimEnd();
  const baseSod = baseReg.slice(baseReg.indexOf(marker), baseReg.indexOf('\n};', baseReg.indexOf(marker))).trimEnd();
  assert.equal(curSod, baseSod, 'the SECURITY_OPERATIONAL_DETAIL adapter is unchanged');
  const pMarker = 'export function projectSecurityOperationalPatrol';
  const curSecProj = rd(PROJ).slice(rd(PROJ).indexOf(pMarker), rd(PROJ).indexOf('\n/**\n * R10 PART 19')).trimEnd();
  assert.equal(curSecProj, baseProj.slice(baseProj.indexOf(pMarker)).trimEnd(),
    'all four SECURITY_OPERATIONAL_DETAIL projections are unchanged');
  const vMarker = 'export const SECURITY_OPERATIONAL_DETAIL_SOURCES = [';
  assert.equal(rd(TYPES).slice(rd(TYPES).indexOf(vMarker), rd(TYPES).indexOf('] as const', rd(TYPES).indexOf(vMarker))),
    baseTypes.slice(baseTypes.indexOf(vMarker), baseTypes.indexOf('] as const', baseTypes.indexOf(vMarker))),
    'the frozen source vocabulary is unchanged');

  // 19, 20 — no route, no permission, no migration, no renderer or archive change, and the whole
  // owning incident domain is untouched.
  const changed = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  assert.deepEqual(changed.filter((f) => /migrations|seeds|routes|controller/.test(f)), []);
  assert.deepEqual(changed.filter((f) => /csv-renderer|xlsx-renderer|pdf-renderer|archive/.test(f)), []);
  assert.deepEqual(changed.filter((f) => f.startsWith('src/modules/incidents/')), [],
    'the owning BE-21A incident module is unchanged');
  assert.deepEqual(changed.filter((f) => /operational-incidents|incident-closure|security-incident-readiness/.test(f)), [],
    'the neighbouring incident modules are unchanged');
  assert.equal(/requirePermission\(/.test(git('diff', BASE, '--', 'src/modules/reporting-export')), false,
    'no permission enforcement invented in Reporting');
  assert.equal(/requirePermission\(|permissions/.test(git('diff', BASE, '--', 'src/modules/incidents')), false);
  // Production budget: exactly the four authorized files.
  assert.deepEqual(changed.filter((f) => !f.startsWith('tests/')).sort(), [
    'docs/api/openapi.yaml',
    'src/modules/reporting-export/reporting-export.r10-projections.ts',
    'src/modules/reporting-export/reporting-export.registry.ts',
    'src/modules/reporting-export/reporting-export.types.ts',
  ], 'exactly the four authorized production files');
  // State-independent: `git diff` omits UNTRACKED files, so this test file is absent from the list
  // before commit and present after. What holds in both states is that no OTHER test file was
  // touched — PART 19 repairs no historical test.
  assert.deepEqual(changed.filter((f) => f.startsWith('tests/') && f !== SELF), [],
    'no prior-phase test file was modified');
  // Purely additive production TypeScript: the dataset enum entry, the import, the adapter and the
  // projection are all additions, so not one executable line is removed anywhere under src/.
  const removed = git('diff', BASE, '--', 'src/').split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    .filter((l) => !/^(\/\/|\*|\/\*)/.test(l));
  assert.deepEqual(removed, [], 'no executable line is removed from src/');

  // OpenAPI documents INCIDENT_REGISTER truthfully, at 18 datasets, source-verified facts only.
  assert.equal(oaEnum.length, 18);
  assert.ok(DOC.length > 3000, 'documentation present');
  for (const claim of ['pure Reporting adapter over the existing BE-21A shared Incident foundation list read',
    'GET /incidents', 'no incident lifecycle, no incident repository, no incident status authority',
    'no universal incident model and no duplicate Incident model',
    'not the BE-21B composite operational-incident view',
    'exactly one table, incidentRegister, with no secondary child table',
    '26 fields', 'id, clientId, buildingId, incidentNumber, incidentType, title, description, severity, priority, status, locationType, floorId, areaId, roomId, spaceId, functionalLocationId, reportedByUserId, reportedAt, cancelledAt, cancelledByUserId, closedAt, closedByUserId, closureNotes, createdAt, updatedAt and locationId',
    'The row identity is id', 'incidentNumber is the Client-unique business number',
    'No incidentKey, incidentCompositeId, latestIncidentId or currentIncidentId is minted',
    'no latest, current, most recent, active or primary incident is selected',
    'rows are never collapsed, grouped, deduplicated or ranked',
    'exactly the five the owning read owns: buildingId, incidentType, severity, priority and status',
    'OPERATIONAL, ASSET_FAILURE and FINDING_ESCALATION', 'REPORTED, CANCELLED and CLOSED',
    'No criticalOnly, openOnly, unresolvedOnly, overdue, ageDays, SLA, latestOnly or currentOnly',
    'buildingId is an OPTIONAL narrowing filter', 'asserts Building access for the actor',
    'returning zero rows without querying when that scope is empty',
    'client and Building isolation is never bypassed',
    'This register has no period authority', 'the envelope dateFrom and dateTo are null',
    'are persisted facts and are never used as bounds', 'with no post-query sort',
    'Closure is never inferred', 'reportedByUserId is who reported the incident',
    'never relabeled as an executor, completer, assignee, owner, reviewer or responder',
    'Reporting resolves no user, team or workforce name',
    "locationId is the owning module's own published derivation",
    'INCIDENT_REGISTER has no dataset-specific CSV default',
    'no incident count, open count, critical count, closure rate, average age or SLA KPI',
    'kpis is empty']) {
    assert.ok(DOC.includes(claim), `documentation must state: ${claim}`);
  }
  // The prior dataset documentation is untouched, so no earlier contract was rewritten.
  for (const prior of ['SECURITY_OPERATIONAL_DETAIL (R10) exposes', 'PERMIT_TO_WORK (R10) exposes',
    'CORRECTIVE_ACTION (R10) is a pure Reporting adapter', 'WORK_ORDER_SLA (R10) exposes']) {
    assert.ok(docBlock.includes(prior), `prior documentation must survive: ${prior}`);
  }
});
