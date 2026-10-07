import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 08 — WORK_ORDER_SLA Reporting export integration: focused validation.
 *
 * PART 08 adds presentation only — enum value, registry adapter, R10 projection, OpenAPI
 * doc. The authoritative read model stays work-order-sla-register (byte-unchanged) and
 * Reporting holds no SLA query. reporting-export.types has no imports and r10-projections
 * imports only `import type` bindings, so both are asserted LIVE (R08 PART 01B / R10 PART
 * 03 convention); the registry pulls in `pg` through the modules it adapts, so it is
 * asserted statically on comment-stripped source scoped to the WORK_ORDER_SLA adapter.
 *
 * Proofs: 1 runtime datasets 14 · 2 OpenAPI 14 · 3 sets and order match · 4 declared once
 * · 5 prior 13 intact · 6 work_order.read · 7 delegates to the register parser and service
 * · 8 repository never imported · 9 no SLA SQL · 10 one table workOrderSla · 11 exactly 34
 * fields · 12 order matches the authority · 13 grain is slaClockId · 14 duplicate workOrderId
 * not collapsed · 15 clockType · 16 clockStatus · 17 breachedAt · 18 effectiveElapsed all
 * verbatim · 19 no approaching-breach · 20 pause facts separate · 21 escalation facts bounded
 * · 22 no recipient identities · 23 buildingScope from the service · 24 asOf from the service
 * · 25 no clock read · 26 no KPI formula · 27 no csvDefaultTableKey · 28 OPERATIONAL_DETAIL
 * still the default · 29 no renderer or archive branch · 30 no migration/route/permission.  */

const ROOT = process.cwd();
const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export');
const SLA_DIR = resolve(ROOT, 'src/modules/work-order-sla-register');
const TYPES_PATH = resolve(EXPORT_DIR, 'reporting-export.types.ts');
const PROJECTIONS_PATH = resolve(EXPORT_DIR, 'reporting-export.r10-projections.ts');
const REGISTRY_PATH = resolve(EXPORT_DIR, 'reporting-export.registry.ts');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const ARCHIVE_DIR = resolve(ROOT, 'src/modules/reporting-archives');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ACCESS_SEED = resolve(ROOT, 'src/database/seeds/foundation-access.seed.ts');
const PRIOR_13 = ['SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT', 'UTILITY',
  'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER', 'WORK_ORDER_REGISTER',
  'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL', 'CORRECTIVE_ACTION', 'OPERATIONAL_DETAIL_HISTORY'];
/** Aliases that must never appear as a second SLA dataset or child grain. */
const ALIASES = ['SLA_REGISTER', 'WORK_ORDER_SLA_HISTORY', 'SLA_CLOCK', 'SLA_EXCEPTION', 'WORK_ORDER_SLA_REGISTER'];
/** Derived judgements and recipient/actor identities that must never be exposed. */
const FORBIDDEN_KEYS = ['approachingBreach', 'isBreached', 'breachDuration', 'overdueMilliseconds', 'dueState',
  'complianceRate', 'breachRate', 'responseCompliance', 'resolutionCompliance', 'averageElapsed', 'nearBreachCount',
  'slaStatus', 'latenessBucket', 'historicalElapsed', 'finalElapsed', 'recipientRule', 'recipientsResolved', 'templateKey',
  'notificationsCreated', 'pauseActorUserId', 'resumeActorUserId', 'failureReason', 'escalationActions'];
const FORBIDDEN_LABELS = /overdue|breach duration|violation|compliance|approaching|lateness|time to breach|current sla status|recipient|percent|rate\b|score|near breach/i;
/** SLA tables Reporting must never touch, and the reader it must never import. */
const SLA_SOURCES = ['sla_clocks', 'applied_slas', 'sla_clock_pause_intervals', 'sla_escalation_actions', 'sla_definitions',
  'work-order-sla-register.repository', 'getWorkOrderSlaRegisterRows'];
const DOWNSTREAM = ['csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts', 'reporting-export.validation.ts',
  'reporting-export.service.ts', 'reporting-export.controller.ts', 'reporting-export.routes.ts'];

const read = (path: string): string => readFileSync(path, 'utf8');
/** Strips comments, so absence assertions test the CODE contract, not the prose. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const registryCode = code(REGISTRY_PATH);
const projectionsCode = code(PROJECTIONS_PATH);
// Sliced to this projection only, so a sibling dataset can never satisfy or break a proof.
const slaProjection = () => projectionsCode.slice(projectionsCode.indexOf('function projectWorkOrderSla'));
/** The WORK_ORDER_SLA adapter only — a sibling adapter can never satisfy these proofs. */
function slaAdapter(): string {
  const at = registryCode.indexOf('  WORK_ORDER_SLA: {');
  const end = at >= 0 ? registryCode.indexOf('\n  },', at) : -1;
  assert.ok(at >= 0 && end > at, 'the WORK_ORDER_SLA adapter must be registered and closed');
  return registryCode.slice(at, end);
}
/** Field names of an authoritative row contract, in declaration order. */
function authoritativeFields(typeName: string, path: string): string[] {
  const src = code(path);
  const body = src.slice(src.indexOf(`export type ${typeName} = {`));
  assert.ok(body.length > 0, `${typeName} must exist`);
  const inner = body.slice(body.indexOf('{') + 1, body.indexOf('\n}'));
  return [...inner.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}
const slaRowFields = () => authoritativeFields('PublicWorkOrderSlaRow', resolve(SLA_DIR, 'work-order-sla-register.types.ts'));

/** A satisfied, unbreached, unpaused RESPONSE clock with no escalation. */
const slaRow = (o: Record<string, unknown> = {}) => ({
  appliedSlaId: 'applied-1', workOrderId: 'work-order-1', workOrderNumber: 'WO-0001', workOrderStatus: 'IN_PROGRESS',
  clientId: 'client-1', buildingId: 'building-1', slaDefinitionId: 'definition-1', definitionCode: 'SLA-WO-01',
  operationalType: 'WORK_ORDER', definitionWorkType: 'CORRECTIVE', definitionPriority: 'HIGH',
  workOrderWorkType: 'CORRECTIVE', workOrderPriority: 'HIGH', responseTargetMinutes: 60, resolutionTargetMinutes: 480,
  definitionEffectiveFrom: '2026-01-01T00:00:00.000Z', definitionEffectiveTo: null, slaClockId: 'clock-response',
  appliedAt: '2026-01-05T08:00:00.000Z', clockType: 'RESPONSE', targetMinutes: 60, clockStatus: 'SATISFIED',
  startedAt: '2026-01-05T08:00:00.000Z', satisfiedAt: '2026-01-05T08:40:00.000Z', terminatedAt: null,
  breachedAt: null, isPaused: false, pauseCount: 0, totalPausedMilliseconds: 0, escalationCount: 0,
  effectiveElapsedMilliseconds: 2400000, latestEscalationLevel: null, latestEscalationStatus: null,
  latestEscalationTriggeredAt: null, ...o });
/** A breached, paused, escalated RESOLUTION clock for the SAME Work Order. */
const resolutionRow = () => slaRow({
  slaClockId: 'clock-resolution', clockType: 'RESOLUTION', targetMinutes: 480, clockStatus: 'RUNNING',
  satisfiedAt: null, breachedAt: '2026-01-06T08:00:00.000Z', isPaused: true, pauseCount: 2,
  totalPausedMilliseconds: 3600000, effectiveElapsedMilliseconds: 90000000, escalationCount: 2,
  latestEscalationLevel: 2, latestEscalationStatus: 'TRIGGERED', latestEscalationTriggeredAt: '2026-01-06T09:00:00.000Z' });

const projectionsModule = async () => import(pathToFileURL(PROJECTIONS_PATH).href);
/** Projects two clocks of ONE Work Order — the collapse probe for proofs 13 and 14. */
async function twoClocksForOneWorkOrder() {
  const rows = [slaRow(), resolutionRow()];
  const mod = await projectionsModule();
  const projected = mod.projectWorkOrderSla({ buildingId: null, dateFrom: null, dateTo: null,
    buildingScope: ['building-1', 'building-2'], asOf: '2026-01-31T00:00:00.000Z', rows });
  return { projected, rows, table: projected.tables[0], columns: projected.tables[0].columns };
}

describe('R10 PART 08 — WORK_ORDER_SLA Reporting export integration', () => {
  it('1/2/3/4/5 — dataset surface becomes exactly 14, in parity', async () => {
    const mod = await import(pathToFileURL(TYPES_PATH).href);
    const runtime = [...mod.REPORTING_EXPORT_DATASETS];
    assert.equal(runtime.length, 14, 'runtime dataset count is exactly 14');  // 1
    assert.deepEqual(runtime, [...PRIOR_13, 'WORK_ORDER_SLA'], 'WORK_ORDER_SLA is appended last');
    const openapi = read(OPENAPI_PATH);
    const body = openapi.slice(openapi.indexOf('    ReportArchiveDataset:') + '    ReportArchiveDataset:'.length);
    const documented = /enum:\s*\[([\s\S]*?)\]/.exec(body)[1].split(',').map((v) => v.trim()).filter(Boolean);
    assert.equal(documented.length, 14, 'OpenAPI dataset count is exactly 14');  // 2
    assert.deepEqual(documented, runtime, 'runtime and OpenAPI agree on set AND order');  // 3
    assert.equal(runtime.filter((v) => v === 'WORK_ORDER_SLA').length, 1, 'declared exactly once');  // 4
    assert.equal(documented.filter((v) => v === 'WORK_ORDER_SLA').length, 1);  // 4
    for (const prior of PRIOR_13) {  // 5
      assert.ok(runtime.includes(prior) && documented.includes(prior), `${prior} survives`); }
    // OPERATIONAL_DETAIL_HISTORY stays ONE dataset despite its three history grains.
    assert.equal(runtime.filter((v) => v === 'OPERATIONAL_DETAIL_HISTORY').length, 1, 'never counted per grain');
    assert.deepEqual([...mod.OPERATIONAL_DETAIL_HISTORY_VALUES], ['EVIDENCE', 'FINDING_REWORK', 'REVIEW'],
      'its discriminator vocabulary is unchanged and is not a dataset');
    for (const alias of ALIASES) {
      assert.ok(!runtime.includes(alias) && !documented.includes(alias), `no alias dataset ${alias}`); }
    const dEnd = /\n    [A-Za-z][A-Za-z0-9]*:\n/.exec(body);
    const flat = (dEnd ? body.slice(0, dEnd.index) : body).replace(/\s+/g, ' ');
    const doc = flat.slice(flat.indexOf('WORK_ORDER_SLA (R10)'));
    assert.ok(doc.length > 100, 'the dataset is documented');
    // The wording deliberately NEGATES the forbidden claims, so assert the accurate text.
    for (const claim of ['Its grain is exactly one row per SLA clock, NOT one row per Work Order',
      'a single Work Order legitimately produces both a RESPONSE and a RESOLUTION row',
      'exactly one table, workOrderSla, whose 34 fields', 'breachedAt is the persisted breach truth',
      'effectiveElapsedMilliseconds is a CURRENT-ONLY read-time value', 'not a historical or final elapsed snapshot',
      'the pause deduction applied to elapsed is RESOLUTION-only in the owning SLA authority',
      'bounded aggregate and latest facts only', 'no full escalation history is exposed',
      'no recipient identity is returned', 'requires work_order.read', 'no approaching-breach rule or threshold exists',
      'No SLA KPI is calculated', 'never a breach, overdue or SLA violation duration']) {
      assert.ok(doc.includes(claim), `documents: ${claim}`);
    }
  });

  it('6/7/8/9 — work_order.read; delegates to the register; no repository, no SLA SQL', () => {
    const adapter = slaAdapter();
    assert.match(adapter, /requiredReadPermission: 'work_order\.read'/, 'enforces the existing permission');  // 6
    assert.equal((adapter.match(/requiredReadPermission/g) || []).length, 1, 'exactly one permission');  // 6
    assert.match(read(ACCESS_SEED), /code: 'work_order\.read'/, 'which already exists in the access seed');  // 30
    assert.ok(!/reporting\.read|sla\.read|admin/.test(adapter), 'no alternative or admin fallback');  // 6
    // 7. Parsing AND loading both delegate to the register's published surface.
    assert.match(adapter, /parseWorkOrderSlaRegisterQuery\(passThrough\)/, 'parsing is delegated');  // 7
    assert.match(adapter, /await getWorkOrderSlaRegister\(filters, userId\)/, 'loading is delegated');  // 7
    assert.match(registryCode, /import \{\s*getWorkOrderSlaRegister,\s*parseWorkOrderSlaRegisterQuery,\s*\} from '\.\.\/work-order-sla-register';/,
      'both entry points come from the module index');  // 7
    assert.equal((registryCode.match(/parseWorkOrderSlaRegisterQuery\(/g) || []).length, 1, 'parser called once');
    assert.equal((registryCode.match(/getWorkOrderSlaRegister\(/g) || []).length, 1, 'service called once');
    // No second parser and no filter handling of its own.
    assert.ok(!/function parseWorkOrderSla|isValidUuid|toUpperCase\(\)/.test(adapter), 'no second parser in Reporting');
    assert.equal((adapter.match(/query\.\w+/g) || []).length, 0, 'the adapter never reads raw query keys');
    // 8/9. The repository is never imported and no SLA table is queried.
    assert.ok(!registryCode.includes('work-order-sla-register.repository'), 'the repository is not imported');  // 8
    for (const source of SLA_SOURCES) {  // 8/9
      assert.ok(!registryCode.includes(source), `reporting-export must not reference ${source}`);
      assert.ok(!projectionsCode.includes(source), `the projection must not reference ${source}`); }
    assert.ok(!/SELECT |FROM |JOIN |getPool|\.query\(/.test(registryCode), 'the registry issues no SQL at all');  // 9
  });

  it('10/11/12/13/14 — one table, 34 fields in authority order, clock grain preserved', async () => {
    const { projected, rows, table, columns } = await twoClocksForOneWorkOrder();
    assert.equal(projected.tables.length, 1, 'exactly one table');  // 10
    assert.equal(table.key, 'workOrderSla', 'named workOrderSla');  // 10
    assert.equal(table.rowCount, 2);
    assert.equal(columns.length, 34, 'exactly 34 columns');  // 11
    assert.equal(slaRowFields().length, 34, 'the PART 06 contract is still 34 fields');
    assert.deepEqual(columns.map((c) => c.key), slaRowFields(), 'keys are the authoritative row, in order');  // 12
    // 13/14. Two clocks of ONE Work Order stay two rows: never collapsed or grouped.
    assert.equal(table.rows.length, rows.length, 'one row per clock, no dedup');  // 13
    assert.deepEqual(table.rows.map((r) => r.slaClockId), ['clock-response', 'clock-resolution'], 'per clock');  // 13
    assert.equal(new Set(table.rows.map((r) => r.workOrderId)).size, 1, 'duplicate workOrderId preserved');  // 14
    assert.equal(new Set(table.rows.map((r) => r.appliedSlaId)).size, 1, 'never grouped by appliedSlaId');  // 14
    assert.deepEqual(table.rows.map((r) => r.clockType), ['RESPONSE', 'RESOLUTION'], 'both clocks present');  // 14
    assert.ok(!/GROUP BY|DISTINCT|groupBy|reduce\(|new Map\(|primaryClock|currentClock/i.test(projectionsCode),
      'the projection holds no collapsing construct');  // 14
    assert.ok(!/\bfind\(|\bfilter\(|\bsort\(|\breduce\(|primaryClock|currentClock/.test(slaProjection()),
      'and no clock is selected, preferred or reduced');
    assert.match(slaProjection(), /source\.rows\.map\(\(row\) => \(\{/, 'rows map 1:1');
    assert.match(slaAdapter(), /projectWorkOrderSla\(source\)/, 'the adapter projects the service envelope');
  });

  it('15/16/17/18/19 — SLA facts are verbatim; no approaching breach exists', async () => {
    const { projected, rows, table, columns } = await twoClocksForOneWorkOrder();
    const out = table.rows;
    const byKey = (k) => columns.find((c) => c.key === k);
    // 15/16/17/18. Every SLA fact is copied through unchanged, NULLs included.
    assert.deepEqual(out.map((r) => r.clockType), rows.map((r) => r.clockType), 'clockType verbatim');  // 15
    assert.deepEqual(out.map((r) => r.clockStatus), rows.map((r) => r.clockStatus), 'clockStatus verbatim');  // 16
    assert.equal(out[0].breachedAt, null, 'an unbreached clock keeps NULL');  // 17
    assert.equal(out[1].breachedAt, '2026-01-06T08:00:00.000Z', 'a breached clock keeps its instant');  // 17
    assert.deepEqual(out.map((r) => r.effectiveElapsedMilliseconds), rows.map((r) => r.effectiveElapsedMilliseconds),
      'effectiveElapsed verbatim, never rescaled or recomputed');  // 18
    for (const field of slaRowFields()) {
      assert.deepEqual(out.map((r) => r[field]), rows.map((r) => r[field]), `${field} is copied verbatim`); }
    assert.equal(out[0].workOrderStatus, 'IN_PROGRESS', 'LEFT-JOIN enrichment survives');
    assert.equal(out[0].definitionEffectiveTo, null, 'a nullable enrichment stays NULL, never back-filled');
    // 19. No approaching-breach field, label or derivation anywhere.
    const keys = columns.map((c) => c.key);
    for (const bad of FORBIDDEN_KEYS) assert.ok(!keys.includes(bad), `no derived or foreign column ${bad}`);  // 19
    for (const label of columns.map((c) => c.label)) {  // 19
      assert.ok(!FORBIDDEN_LABELS.test(label), `label "${label}" is not a judgement`); }
    // `isOverdue`/`dueState` are legitimate columns of a SIBLING projection: scan only this one.
    for (const bad of ['approaching', 'isBreached', 'breachRate', 'compliance', 'overdue', 'lateness',
      'breachDuration', 'dueState', 'PERCENT']) {  // 19
      assert.ok(!new RegExp(bad, 'i').test(slaProjection()), `no ${bad} derivation in this projection`); }
    assert.equal(byKey('breachedAt').label, 'Breached At', 'breach is a persisted timestamp only');  // 17
    assert.equal(byKey('effectiveElapsedMilliseconds').label, 'Effective Elapsed Milliseconds',
      'never a breach, overdue or violation duration');  // 18
  });

  it('20/21/22 — pause facts stay separate; escalation stays bounded; no recipients', async () => {
    const { projected, columns } = await twoClocksForOneWorkOrder();
    const byKey = (k) => columns.find((c) => c.key === k);
    // 20. Three separate factual pause fields, never merged into one pause state.
    for (const [key, label, type] of [['isPaused', 'Paused', 'BOOLEAN'], ['pauseCount', 'Pause Count', 'NUMBER'],
      ['totalPausedMilliseconds', 'Total Paused Milliseconds', 'NUMBER']]) {  // 20
      assert.equal(byKey(key).label, label, `${key} keeps its own factual label`);
      assert.equal(byKey(key).type, type, `${key} keeps its own type`); }
    assert.equal(columns.filter((c) => /[Pp]ause/.test(c.key)).length, 3, 'exactly three pause fields');  // 20
    assert.ok(!/pauseDeduct|deducted|RESOLUTION/.test(slaProjection()),
      'neither applies nor reverses the RESOLUTION-only deduction');  // 20
    // 21. Bounded escalation aggregate plus three latest facts — no timeline.
    assert.equal(columns.filter((c) => /[Ee]scalation/.test(c.key)).length, 4, 'exactly four escalation fields');  // 21
    assert.equal(byKey('escalationCount').type, 'NUMBER');
    assert.equal(byKey('latestEscalationStatus').label, 'Latest Escalation Status',
      'the latest action status, never a current SLA status');  // 21
    assert.ok(!columns.some((c) => /escalations$|escalationActions$|Timeline/i.test(c.key)),
      'no escalation array or timeline column');  // 21
    // 22. No recipient or actor identity is exposed or read.
    for (const bad of ['recipientRule', 'recipientsResolved', 'notificationsCreated', 'templateKey',
      'pauseActorUserId', 'resumeActorUserId', 'failureReason']) {  // 22
      assert.ok(!columns.some((c) => c.key === bad), `${bad} is not exposed`);
      assert.ok(!projectionsCode.includes(bad), `${bad} is never read`); }
    assert.ok(!/recipient/i.test(projectionsCode), 'the projection never mentions a recipient');  // 22
    assert.equal(projected.kpis.length, 0, 'kpis is empty');  // 26
  });

  it('23/24/25/26 — scope and asOf come from the service; no clock read, no KPI', () => {
    const adapter = slaAdapter();
    // 23/24. The register's envelope is forwarded whole, so buildingScope and asOf are the
    // service's values — never derived from rows and never re-read here.
    assert.match(adapter, /common: source,/, 'the service envelope is forwarded as common metadata');  // 23
    assert.ok(!/buildingScope:/.test(adapter), 'Reporting never constructs buildingScope itself');  // 23
    assert.ok(!/rows\.map\(\(r\) => r\.buildingId|new Set\(/.test(adapter), 'nor derives it from the rows');  // 23
    assert.ok(!/asOf:/.test(adapter), 'Reporting never constructs asOf itself');  // 24
    assert.ok(!/\.toISOString\(\)/.test(adapter), 'and never serializes an instant of its own');  // 24
    // 25. No clock is read anywhere in this adapter.
    assert.equal((adapter.match(/new Date\(/g) || []).length, 0, 'no new Date() in the adapter');  // 25
    assert.ok(!/Date\.now\(\)|performance\.now|process\.hrtime|frozenNowIso/.test(adapter), 'no clock source');  // 25
    // 26. No KPI is calculated.
    const projection = slaProjection();
    assert.match(projection, /kpis: \[\],/, 'kpis declared empty, not computed');  // 26
    assert.ok(!/kpis:\s*\[{|value:|breachRate|complianceRate|average|sum\(|\/\s*rows\.length/.test(projection),
      'no KPI formula, average or rate');  // 26
  });

  it('27/28/29/30 — no csv default, no renderer or archive branch, nothing else wired', async () => {
    const mod = await import(pathToFileURL(TYPES_PATH).href);
    // 27/28. Only OPERATIONAL_DETAIL owns the legacy CSV default; WORK_ORDER_SLA emits one
    // table, so the generic sole-table behaviour suffices.
    assert.deepEqual(Object.keys(mod.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL'],
      'the metadata map still holds exactly one entry');  // 28
    assert.equal(mod.REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL.csvDefaultTableKey, 'operationalDetail',
      'OPERATIONAL_DETAIL remains the configured default');  // 28
    assert.equal(mod.REPORTING_EXPORT_DATASET_METADATA.WORK_ORDER_SLA, undefined, 'no entry was added');  // 27
    assert.ok(!code(TYPES_PATH).includes("csvDefaultTableKey: 'workOrderSla'"), 'and no default key for it');  // 27
    assert.ok(!slaAdapter().includes('csvDefaultTableKey'), 'the adapter declares none either');  // 27
    assert.ok(!/csvDefaultTableKey/.test(projectionsCode), 'the projection declares none');  // 27
    // 29. No dataset-specific branch in any renderer, validation, service or archive file.
    for (const file of DOWNSTREAM) {  // 29
      assert.ok(!/workOrderSla|WORK_ORDER_SLA/.test(code(resolve(EXPORT_DIR, file))),
        `${file} gains no dataset-specific branch`); }
    for (const file of readdirSync(ARCHIVE_DIR)) {  // 29
      assert.ok(!/workOrderSla|WORK_ORDER_SLA/.test(code(resolve(ARCHIVE_DIR, file))),
        `${file} gains no WORK_ORDER_SLA branch`); }
    // 30. No migration, route, controller or new permission.
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => /work_order_sla|sla_register|sla_export/i.test(f)),
      'no migration added');  // 30
    assert.deepEqual(readdirSync(SLA_DIR).sort(), ['index.ts', 'work-order-sla-register.repository.ts',
      'work-order-sla-register.service.ts', 'work-order-sla-register.types.ts'], 'no routes or controller');  // 30
    assert.equal((read(ACCESS_SEED).match(/code: '[a-z_]+\.read'/g) || []).filter((c) => /sla/.test(c)).length, 0,
      'no SLA permission was seeded');  // 30
    assert.ok(!/WORK_ORDER_SLA/.test(read(resolve(ROOT, 'src/app.ts'))), 'no route wiring in the app');  // 30
    // The authoritative module is untouched by this PART: the PART 06/FIX 01 invariants hold.
    const repo = code(resolve(SLA_DIR, 'work-order-sla-register.repository.ts'));
    assert.match(repo, /CASE WHEN c\.clock_type = 'RESOLUTION'/, 'the FIX 01 deduction guard is intact');
    assert.match(repo, /a\.building_id = ANY\(\$1::uuid\[\]\)/, 'the scope bridge is intact');
    assert.match(code(resolve(SLA_DIR, 'work-order-sla-register.service.ts')), /if \(buildingIds\.length === 0\)/,
      'the fail-closed empty-scope path is intact');
  });
});
