/**
 * R10 PART 20 — CLOSURE GUARD.
 *
 * This is a CLOSURE VALIDATION test, not a feature test. It pins the frozen R10 end state so that
 * the track can be declared complete, bounded and internally coherent: 18 Reporting datasets, the
 * eight R10 artifacts, one table per response, discriminator-grained datasets that never flatten
 * independent grains, no rederived KPI or SLA authority, no invented actor semantics, no synthetic
 * journey engine, and no forbidden infrastructure change.
 *
 * METHOD — deliberately STATIC and bounded. Only `reporting-export.types.ts` is imported at
 * runtime (it has no database or express dependency); every other invariant is proven from source
 * text and from the R10 commit range. There is no dynamic harness, no database, no live-PostgreSQL
 * requirement and no historical regression sweep. The per-PART focused tests (PART 01-19) already
 * executed the runtime behaviour of each dataset; this file exists to prove the WHOLE is coherent,
 * which is a static property.
 *
 * SCOPE — R10 only. The R10 range is `R10_PARENT..HEAD`, where R10_PARENT is the parent of
 * `33aac3491ff3f6f1268d170c0a42072561072f2f` (R10 PART 01, the additive FINDING_REGISTER sourceId
 * filter). Anything older belongs to R01-R09 and is out of scope: where a pre-R10 condition is
 * observed it is pinned as pre-existing rather than treated as an R10 defect.
 *
 * This file adds no dataset, no adapter, no read model and no production change. Historical
 * phase-scoped tests are intentionally NOT repaired here: later PARTs legitimately invalidate older
 * count and fail-closed guards, and PART 20 must not modernize PART 01-19.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** PART 19 head — the frozen R10 implementation this guard closes. */
const BASE = '4e087f304364b575b0f5af8b933bc215a3b57623';
/** R10 PART 01 and its parent: everything after the parent is R10. */
const R10_FIRST = '33aac3491ff3f6f1268d170c0a42072561072f2f';
const R10_PARENT = '232bcffbfd8872181d44244198a6c88114e2d09c';
const SELF = 'tests/r10-part20-closure-guard.test.ts';

const RE = 'src/modules/reporting-export';
const TYPES = `${RE}/reporting-export.types.ts`;
const REG = `${RE}/reporting-export.registry.ts`;
const R10PROJ = `${RE}/reporting-export.r10-projections.ts`;
const OPENAPI = 'docs/api/openapi.yaml';

const typesSrc = rd(TYPES);
const regSrc = rd(REG);
const projSrc = rd(R10PROJ);
const sreg = strip(regSrc);
const sproj = strip(projSrc);

/** The eight R10 artifacts the track must end with, and nothing more. */
const R10_ARTIFACTS = ['FINDING_REGISTER', 'CORRECTIVE_ACTION', 'OPERATIONAL_DETAIL_HISTORY',
  'WORK_ORDER_SLA', 'SCHEDULED_OPERATION_LINEAGE', 'PERMIT_TO_WORK', 'SECURITY_OPERATIONAL_DETAIL',
  'INCIDENT_REGISTER'];
/** The seven datasets R10 appended to the enum (FINDING_REGISTER pre-existed; PART 01 only added
 * a filter to it). */
const R10_APPENDED = ['CORRECTIVE_ACTION', 'OPERATIONAL_DETAIL_HISTORY', 'WORK_ORDER_SLA',
  'SCHEDULED_OPERATION_LINEAGE', 'PERMIT_TO_WORK', 'SECURITY_OPERATIONAL_DETAIL',
  'INCIDENT_REGISTER'];

const enumOf = (src) => {
  const i = src.indexOf('REPORTING_EXPORT_DATASETS = [');
  assert.ok(i >= 0, 'the dataset enum must exist');
  return [...src.slice(i, src.indexOf('] as const', i)).matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]);
};
const RUNTIME = enumOf(typesSrc);
const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
const docBlock = rd(OPENAPI).split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const OPENAPI_ENUM = [...docBlock.slice(docBlock.indexOf('enum:'), docBlock.indexOf('description:'))
  .matchAll(/[A-Z][A-Z0-9_]{3,}/g)].map((m) => m[0]);
const dup = (a) => a.filter((x, j) => a.indexOf(x) !== j);
/** One R10 projection helper's body, sliced to the next helper so siblings are never swallowed. */
const projBody = (name) => {
  const i = sproj.indexOf(`export function ${name}(`);
  assert.ok(i >= 0, `${name} must exist in the R10 projection seam`);
  const j = sproj.indexOf('\nexport function ', i + 10);
  return sproj.slice(i, j > 0 ? j : sproj.length);
};
const tableKeysOf = (name) => [...projBody(name).matchAll(/table\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
const R10_PROJECTIONS = [...sproj.matchAll(/^export function (project\w+)\(/gm)].map((m) => m[1]);
/** Files changed by R10 only. */
const r10Files = git('diff', '--name-only', `${R10_PARENT}..HEAD`).split('\n').filter(Boolean);
const r10AddedCode = git('diff', `${R10_PARENT}..HEAD`, '--', 'src/')
  .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  .map((l) => l.slice(1)).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const types = await import('../src/modules/reporting-export/reporting-export.types.ts');

test('CLOSURE 01/02/18 — dataset parity is 18, CSV default is singular, boundary holds', () => {
  // CHECK 01 — runtime, registry and OpenAPI agree on 18 datasets with no duplicate, no hidden
  // placeholder and nothing missing in either direction.
  assert.equal(RUNTIME.length, 18, 'runtime dataset enum is 18');
  assert.equal(registryKeys.length, 18, 'registry adapter count is 18');
  assert.equal(OPENAPI_ENUM.length, 18, 'OpenAPI dataset enum is 18');
  assert.deepEqual(dup(RUNTIME), [], 'no duplicate dataset at runtime');
  assert.deepEqual(dup(registryKeys), [], 'no duplicate adapter');
  assert.deepEqual(dup(OPENAPI_ENUM), [], 'no duplicate OpenAPI entry');
  assert.deepEqual(OPENAPI_ENUM, RUNTIME, 'OpenAPI order matches runtime order position by position');
  assert.deepEqual(RUNTIME.filter((d) => !registryKeys.includes(d)), [], 'no dataset lacks an adapter');
  assert.deepEqual(registryKeys.filter((k) => !RUNTIME.includes(k)), [], 'no undeclared adapter');
  assert.deepEqual([...registryKeys].sort(), [...RUNTIME].sort(), 'registry and enum sets are equal');
  // The registry is a keyed object literal, so its declaration order carries no contract. It
  // diverges from the enum order at positions 6-11 (MANAGEMENT_OPERATIONS_COMMAND_CENTER), and
  // that divergence is PRE-EXISTING: it is already present at R10's parent commit, introduced by
  // the R01-R04 tracks. Pinned here so it is never mistaken for an R10 defect.
  const parentEnum = enumOf(git('show', `${R10_PARENT}:${TYPES}`));
  const parentKeys = [...git('show', `${R10_PARENT}:${REG}`).matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
  assert.equal(parentEnum.length, 11, 'R10 started from 11 datasets');
  assert.deepEqual([...parentKeys].sort(), [...parentEnum].sort(), 'sets already matched pre-R10');
  assert.notDeepEqual(parentKeys, parentEnum,
    'the declaration-order divergence already existed before R10');
  // R10 appended exactly seven datasets, in the same order in both the enum and the registry.
  assert.deepEqual(RUNTIME.slice(11), R10_APPENDED, 'R10 appended exactly these seven datasets');
  assert.deepEqual(RUNTIME.slice(0, 11), parentEnum, 'the eleven pre-R10 datasets are unchanged');
  assert.deepEqual(registryKeys.slice(-7), R10_APPENDED, 'registry appends them in the same order');
  // CHECK 02 — exactly one dataset-level CSV default, and no discriminator-driven dataset has one.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.deepEqual(types.REPORTING_EXPORT_DATASET_METADATA,
    { OPERATIONAL_DETAIL: { csvDefaultTableKey: 'operationalDetail' } });
  assert.equal((typesSrc.match(/csvDefaultTableKey:/g) ?? []).length, 1,
    'exactly one csvDefaultTableKey is configured');
  for (const d of ['PERMIT_TO_WORK', 'SECURITY_OPERATIONAL_DETAIL', 'OPERATIONAL_DETAIL_HISTORY',
    'WORK_ORDER_SLA', 'SCHEDULED_OPERATION_LINEAGE', 'INCIDENT_REGISTER', 'CORRECTIVE_ACTION']) {
    assert.equal(types.REPORTING_EXPORT_DATASET_METADATA[d], undefined,
      `${d} must have no dataset CSV default: its table key is discriminator- or source-dependent`);
  }
  assert.equal(sreg.slice(sreg.indexOf('  INCIDENT_REGISTER: {')).includes('csvDefaultTableKey'), false);
  // CHECK 18 — R10 boundary: the eight frozen artifacts, no PART 21, no R11, no extra dataset.
  for (const a of R10_ARTIFACTS) assert.ok(RUNTIME.includes(a), `${a} is part of the R10 end state`);
  assert.equal(RUNTIME.length - parentEnum.length, 7, 'R10 added seven datasets and no more');
  const allSrc = rd(TYPES) + regSrc + projSrc + rd(OPENAPI);
  for (const banned of ['PART 21', 'PART21', 'R11 —', 'COMMERCIAL_JOURNEY', 'RESOURCE_JOURNEY',
    'SERVICE_JOURNEY']) {
    assert.equal(allSrc.includes(banned), false, `no ${banned} artifact exists`);
  }
  assert.deepEqual(git('ls-files', 'tests').split('\n').filter((f) => /part2[1-9]/.test(f)), [],
    'no PART 21+ test exists');
});

test('CLOSURE 03/04/08 — one table per response, discriminator grains never flattened', () => {
  // CHECK 03 — every R10 projection emits EXACTLY ONE table, and the discriminator contracts map
  // to exactly the frozen table keys.
  assert.equal(R10_PROJECTIONS.length, 13, 'R10 owns thirteen projection helpers');
  const expected = {
    projectCorrectiveAction: ['correctiveAction'],
    projectOperationalDetailEvidence: ['operationalDetailEvidence'],
    projectOperationalDetailFindingRework: ['operationalDetailFindingRework'],
    projectOperationalDetailReviewHistory: ['operationalDetailReviewHistory'],
    projectWorkOrderSla: ['workOrderSla'],
    projectScheduledOperationLineage: ['scheduledOperationLineage'],
    projectPermitToWorkLifecycle: ['permitToWorkLifecycle'],
    projectPermitToWorkApproval: ['permitToWorkApproval'],
    projectSecurityOperationalPatrol: ['securityOperationalPatrol'],
    projectSecurityOperationalShiftHandover: ['securityOperationalShiftHandover'],
    projectSecurityOperationalFinding: ['securityOperationalFinding'],
    projectSecurityOperationalIncidentReadiness: ['securityOperationalIncidentReadiness'],
    projectIncidentRegister: ['incidentRegister'],
  };
  for (const [fn, keys] of Object.entries(expected)) {
    assert.deepEqual(tableKeysOf(fn), keys, `${fn} emits exactly ${keys[0]} and nothing else`);
  }
  // No response can return two child grains together: each adapter branch projects once.
  assert.equal((sreg.match(/projected: project/g) ?? []).length, 21,
    'every non-PTW branch projects exactly one dataset table');
  assert.match(sreg, /source\.view === 'LIFECYCLE'/,
    'PTW selects ONE of its two tables by view, and never projects both');
  for (const pair of [['permitToWorkLifecycle', 'permitToWorkApproval'],
    ['operationalDetailEvidence', 'operationalDetailFindingRework'],
    ['securityOperationalPatrol', 'securityOperationalFinding']]) {
    for (const fn of R10_PROJECTIONS) {
      const keys = tableKeysOf(fn);
      assert.ok(!(keys.includes(pair[0]) && keys.includes(pair[1])),
        `${fn} never merges two independent grains`);
    }
  }
  // Discriminator vocabularies are frozen and exhaustive.
  assert.deepEqual([...types.OPERATIONAL_DETAIL_HISTORY_VALUES], ['EVIDENCE', 'FINDING_REWORK', 'REVIEW']);
  assert.deepEqual([...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    ['PATROL', 'SHIFT_HANDOVER', 'SECURITY_FINDING', 'INCIDENT_READINESS']);
  assert.match(rd('src/modules/permit-to-work-register/permit-to-work-register.service.ts'),
    /PERMIT_TO_WORK_VIEWS = \['LIFECYCLE', 'APPROVAL'\] as const/);
  // CHECK 04 — SECURITY_OPERATIONAL_DETAIL is complete: declared == implemented == four sources,
  // the fail-closed guard survives completion, and no source-specific dataset was ever added.
  const impl = /new Set<SecurityOperationalDetailSource>\(\[([\s\S]*?)\]\)/.exec(regSrc);
  assert.ok(impl, 'the implemented-source set must exist');
  const implemented = [...impl[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(implemented, [...types.SECURITY_OPERATIONAL_DETAIL_SOURCES],
    'no source remains declared-but-unimplemented');
  assert.equal(implemented.length, 4);
  assert.match(regSrc, /is not implemented yet; supported:/,
    'the fail-closed guard is retained even though the vocabulary is complete');
  assert.equal((regSrc.match(/if \(source === '/g) ?? []).length, 3,
    'three explicit source branches; the fourth source is the PATROL fall-through');
  assert.deepEqual(RUNTIME.filter((d) => /^(PATROL|SHIFT_HANDOVER|SECURITY_FINDING|INCIDENT_READINESS)(_DETAIL)?$/.test(d)),
    [], 'no source-specific Reporting dataset exists');
  // PATROL identity stays composite and gains no alias.
  const patrol = projBody('projectSecurityOperationalPatrol');
  assert.match(patrol, /key: 'taskId'/);
  assert.match(patrol, /key: 'patrolScheduleBindingId'/);
  assert.equal(/generatedTaskId/.test(patrol), false, 'no generatedTaskId alias in Security PATROL');
  assert.equal(/\.sort\(|\.filter\(|LIMIT 1|ROW_NUMBER|DISTINCT/.test(patrol), false,
    'no PATROL row collapse or election');
  // CHECK 08 — history grains stay separate and the R08 Finding child is excluded.
  assert.equal(types.OPERATIONAL_DETAIL_HISTORY_VALUES.includes('FINDING'), false,
    'the R08 Finding child grain is not part of OPERATIONAL_DETAIL_HISTORY');
  assert.equal((sreg.match(/if \(history === '/g) ?? []).length, 2,
    'two explicit history branches; EVIDENCE is the fall-through');
  for (const fn of ['projectOperationalDetailEvidence', 'projectOperationalDetailFindingRework',
    'projectOperationalDetailReviewHistory']) {
    assert.equal(tableKeysOf(fn).length, 1, `${fn} stays a single child grain`);
  }
  // No duplicate Finding Register authority inside the history datasets.
  assert.equal(/findingRegister/.test(sreg.slice(sreg.indexOf('  OPERATIONAL_DETAIL_HISTORY: {'),
    sreg.indexOf('  WORK_ORDER_SLA: {'))), false,
    'the history adapter never reuses the Finding Register authority');
});

test('CLOSURE 05/06/07 — PTW, lineage and WO SLA safety invariants hold in code, not just prose', () => {
  const ptw = 'src/modules/permit-to-work-register';
  const lin = 'src/modules/scheduled-operation-lineage';
  const sla = 'src/modules/work-order-sla-register';
  const code = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts'))
    .map((f) => strip(rd(`${dir}/${f}`))).join('\n');
  const RANKING = ['LIMIT 1', 'ROW_NUMBER', 'DISTINCT ON', 'MAX(created_at)', 'MAX(reviewed_at)',
    'MAX(completed_at)', 'mostRecent', 'latestApproval', 'currentApproval', 'primaryApproval'];
  // CHECK 05 — PTW: `view` is required, both grains are 1:N-safe, and no approval is elected.
  const ptwCode = code(ptw);
  for (const b of RANKING) assert.equal(ptwCode.includes(b), false, `PTW read model has no ${b}`);
  assert.match(rd(`${ptw}/permit-to-work-register.service.ts`),
    /view is required and must be one of/, 'view is a required discriminator');
  assert.match(ptwCode, /permit_applications/, 'LIFECYCLE grain is the permit application');
  assert.match(ptwCode, /permit_approval_bindings/, 'APPROVAL grain is the approval binding');
  assert.equal(/decisionActor|decidedBy|approverDecision|actualApprover/.test(ptwCode), false,
    'no decision actor is invented');
  assert.match(rd(`${ptw}/permit-to-work-register.service.ts`), /assignedApproverUserId/,
    'assignedApproverUserId remains an assignment field');
  assert.equal(/assignedApproverUserId:\s*row\.assigned_approver_user_id/.test(ptwCode), true,
    'the assigned approver is copied verbatim from its own column');
  // CHECK 06 — lineage: grain is generated_tasks.id, recurrence is a singular authoritative
  // relation, and checklist execution vs form instance lineage stay separate.
  const linCode = code(lin);
  for (const b of RANKING) assert.equal(linCode.includes(b), false, `lineage read model has no ${b}`);
  // `IS NOT DISTINCT FROM` is a NULL-safe equality operator, not a dedup or ranking construct, so
  // it is allowed; GROUP BY, DISTINCT ON and SELECT DISTINCT would all collapse the grain.
  assert.equal(/GROUP BY|DISTINCT ON|SELECT DISTINCT/.test(linCode), false,
    'no grouping or dedup in lineage');
  assert.match(linCode, /IS NOT DISTINCT FROM/, 'the only DISTINCT token is NULL-safe equality');
  assert.match(linCode, /generatedTaskId/, 'the lineage grain is the generated task id');
  assert.equal(/missed|overdue|dueBefore|graceMinutes/i.test(linCode), false,
    'no missed or overdue derivation in lineage code');
  assert.equal(/executor|executedBy|performedBy/i.test(linCode), false,
    'no executor invention in lineage code');
  assert.match(rd(`${lin}/scheduled-operation-lineage.repository.ts`),
    /recurrence_schedule_unique/, 'recurrence is 0..1 by its own unique constraint');
  assert.equal(/recurrenceCount|recurrence_count/.test(linCode), false, 'no recurrence count is invented');
  assert.match(rd(`${lin}/scheduled-operation-lineage.types.ts`), /checklistExecutionId/);
  assert.match(rd(`${lin}/scheduled-operation-lineage.types.ts`), /formInstanceId/,
    'checklist execution and form instance lineage remain separate relations');
  // CHECK 07 — WO SLA: grain is one row per sla_clocks row, scope follows the applied SLA
  // Building/client authority, and the RESOLUTION-only pause deduction is expressed in the SQL.
  const slaRepo = rd(`${sla}/work-order-sla-register.repository.ts`);
  const slaCode = strip(slaRepo);
  for (const b of RANKING.filter((x) => x !== 'LIMIT 1')) {
    assert.equal(slaCode.includes(b), false, `WO SLA read model has no ${b}`);
  }
  // The grain invariant is "no LIMIT 1 on the CLOCK join", pinned by PART 06's own focused test.
  // Exactly one LIMIT 1 exists and it sits inside the latest-escalation LATERAL, which resolves a
  // bounded 1:N child attribute per clock (deterministically ordered) and can neither collapse the
  // clock grain nor elect a "primary clock".
  assert.equal((slaCode.match(/LIMIT 1/g) ?? []).length, 1,
    'exactly one LIMIT 1: the latest-escalation LATERAL only');
  const lateral = slaCode.slice(slaCode.lastIndexOf('LEFT JOIN LATERAL'), slaCode.lastIndexOf(') le ON TRUE'));
  assert.match(lateral, /FROM sla_escalation_actions ea/, 'the single LIMIT 1 is inside the escalation LATERAL');
  assert.match(lateral, /ORDER BY ea\.level DESC, ea\.created_at DESC, ea\.id DESC/,
    'the latest escalation action is deterministically ordered, not arbitrarily picked');
  assert.equal((slaCode.match(/FROM sla_escalation_actions ea/g) ?? []).length, 2,
    'a count LATERAL and a latest LATERAL, exactly as PART 06 pinned');
  const clockSide = slaCode.slice(0, slaCode.indexOf('LEFT JOIN LATERAL'));
  assert.equal(/LIMIT|ROW_NUMBER|DISTINCT ON/.test(clockSide), false,
    'the clock join itself elects nothing');
  assert.match(slaCode, /ORDER BY a\.applied_at ASC, a\.work_order_id ASC, c\.clock_type ASC, c\.id ASC/,
    'both RESPONSE and RESOLUTION clocks are returned per Work Order, never coalesced');
  assert.match(slaCode, /a\.building_id = ANY\(\$1::uuid\[\]\)/,
    'scope is the applied SLA building authority, never work_order_id alone');
  assert.match(slaCode, /wo\.client_id = a\.client_id/, 'client isolation is preserved through the join');
  assert.match(slaCode, /CASE WHEN c\.clock_type = 'RESOLUTION'/,
    'the pause deduction is RESOLUTION-only in the statement itself');
  assert.match(slaCode, /ELSE 0\s*END/, 'a RESPONSE clock deducts structurally zero');
  assert.match(slaCode, /sla_clocks/, 'the grain is the SLA clock');
  assert.match(slaCode, /c\.breached_at/, 'breach truth is the persisted column, never recomputed');
  // No new SLA formula exists in Reporting itself: it holds no SQL at all.
  for (const f of fs.readdirSync(path.join(ROOT, RE)).filter((x) => x.endsWith('.ts'))) {
    const c = strip(rd(`${RE}/${f}`));
    for (const b of ['getPool', '.query(', 'SELECT ', ' FROM ', ' JOIN ', 'EXTRACT(EPOCH']) {
      assert.equal(c.includes(b), false, `${f} holds no SQL (${b})`);
    }
  }
});

test('CLOSURE 09/10/12 — source filter, incident register and KPI safety', () => {
  // CHECK 09 — FINDING_REGISTER sourceId stays an optional exact match, independent of sourceType
  // and conjunctive with it, and never weakens the authorized-building predicate.
  const fr = strip(rd('src/modules/finding-register/finding-register.repository.ts'));
  assert.match(fr, /if \(filters\.sourceId\) \{/, 'sourceId is optional');
  assert.match(fr, /f\.source_id = \$\$\{values\.length\}/, 'sourceId is an exact match');
  assert.match(fr, /if \(filters\.sourceType\) \{/, 'sourceType is a separate, independent filter');
  assert.equal(/source_id IN|source_id::text|ILIKE/.test(fr), false, 'no fuzzy or list matching');
  assert.match(fr, /f\.building_id = ANY\(\$1::uuid\[\]\)/,
    'the authorized-building predicate is seeded unconditionally');
  assert.equal(/polymorphic|sourceRegistry|universalSource/.test(fr), false,
    'no universal source engine was introduced');
  // CHECK 10 — INCIDENT_REGISTER adapts the BE-21A foundation read only.
  const ir = sreg.slice(sreg.indexOf('  INCIDENT_REGISTER: {'));
  assert.match(ir, /requiredReadPermission: 'incident\.read'/);
  assert.match(ir, /parseIncidentFilters\(passThrough\)/, 'the owning parser is reused');
  assert.match(ir, /listIncidents\(filters, userId\)/, 'the owning BE-21A list read is used');
  assert.equal(/operationalIncident|listOperationalIncidents|availableActions/.test(ir), false,
    'the BE-21B composite operational-incident view is not used');
  assert.equal(/incidentRepository|createIncident|updateIncident|cancelIncident|closeIncident/.test(sreg + sproj),
    false, 'no second incident authority and no lifecycle mutation');
  const irProj = projBody('projectIncidentRegister');
  assert.match(irProj, /key: 'id', label: 'Incident Id'/, 'identity is the record id');
  assert.equal(/sla|overdue|ageDays|daysToClose|currentIncident|latestIncident|primaryIncident/i
    .test(irProj), false, 'no SLA, age, overdue, current or latest derivation');
  // CHECK 12 — no new KPI authority: every R10 projection returns kpis: [] and computes nothing.
  for (const fn of R10_PROJECTIONS) {
    assert.match(projBody(fn), /kpis: \[\]/, `${fn} returns kpis: []`);
  }
  assert.equal((sproj.match(/\bkpi\(/g) ?? []).length, 0, 'no KPI value is constructed in R10');
  for (const banned of ['missedPatrol', 'overduePatrol', 'patrolContributor', 'readinessPercentage',
    'closureRate', 'incidentAge', 'averageAge', 'breachRate', 'slaFormula', 'responseTime',
    'resolutionTime', 'contributorCount']) {
    assert.equal(sproj.toLowerCase().includes(banned.toLowerCase()), false,
      `no rederived ${banned} in R10 projections`);
    assert.equal(sreg.toLowerCase().includes(banned.toLowerCase()), false,
      `no rederived ${banned} in the R10 registry`);
  }
  assert.equal(/\.reduce\(|\.length \/|\/ rows\.length|Math\.round|toFixed/.test(sproj), false,
    'no rate, ratio, percentage or rounding arithmetic in R10 projections');
});

test('CLOSURE 11/13/16 — attribution language, no journey engine, truthful OpenAPI', () => {
  // CHECK 11 — attribution language: no executor invention anywhere in R10 presentation.
  const labels = [...projSrc.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const keys = [...projSrc.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  assert.equal(labels.length, keys.length, 'every column has exactly one label');
  assert.ok(labels.length > 200, 'the R10 presentation surface is fully scanned');
  assert.deepEqual(labels.filter((l) => /^(Executed By|Executor|Performed By|Actual Executor)/i.test(l)),
    [], 'no forbidden executor label');
  assert.deepEqual(keys.filter((k) => /executedBy|executor|performedBy|actualExecutor/i.test(k)),
    [], 'no forbidden executor key');
  // Assignment stays assignment, completion stays completion, responsibility stays responsibility.
  for (const kept of ['Assigned Approver User Id', 'Assigned Team Id', 'Assigned Workforce Profile Id']) {
    assert.ok(labels.includes(kept), `${kept} keeps its assignment semantics`);
  }
  for (const kept of ['Completed By User Id', 'Completed At']) {
    assert.ok(labels.includes(kept), `${kept} keeps its completion-actor semantics`);
  }
  for (const kept of ['Team Id', 'Team Name', 'Primary Workforce Id', 'Primary Workforce Name',
    'Reported By User Id', 'Cancelled By User Id', 'Closed By User Id']) {
    assert.ok(labels.includes(kept), `${kept} keeps its responsibility/actor semantics`);
  }
  // CHECK 13 — R10 stays a consumer/presentation layer: no synthetic journey engine.
  for (const banned of ['journey', 'JourneyEngine', 'lifecycle_relationship', 'synthetic lineage',
    'crossDomainLineage', 'universalLifecycle', 'relationship_inference', 'inferRelation']) {
    assert.equal(r10AddedCode.toLowerCase().includes(banned.toLowerCase()), false,
      `no ${banned} was introduced by R10`);
  }
  // No relation is inferred by matching timestamps, names or statuses.
  assert.equal(/matching (timestamp|name|status)|same timestamp|same name implies/i.test(r10AddedCode), false);
  // CHECK 16 — OpenAPI claims nothing R10 does not do.
  const DOC = docBlock.slice(docBlock.indexOf('description:')).replace(/\s+/g, ' ');
  for (const banned of ['current approval', 'latest approval', 'most recent approval',
    'the current approver', 'PART 21', 'R11 ', 'exact missed contributors',
    'exact overdue contributors', 'is a missed/overdue contributor list']) {
    assert.equal(DOC.toLowerCase().includes(banned.toLowerCase()), false,
      `OpenAPI must not claim: ${banned}`);
  }
  // "actual executor" may appear ONLY inside an explicit denial.
  for (const m of DOC.matchAll(/actual executor/gi)) {
    const ctx = DOC.slice(Math.max(0, m.index - 120), m.index + 40).toLowerCase();
    assert.ok(/neither is|not an|never|no /.test(ctx),
      `every "actual executor" mention must be a denial, got: ...${ctx.slice(-90)}`);
  }
  // Period filtering is never claimed where the source has none.
  const irDoc = DOC.slice(DOC.indexOf('INCIDENT_REGISTER (R10)'));
  assert.match(irDoc, /This register has no period authority/);
  assert.match(irDoc, /the envelope dateFrom and dateTo are null/);
  const readinessDoc = DOC.slice(DOC.indexOf('source=INCIDENT_READINESS'));
  assert.match(readinessDoc, /applies NO period bound at all/);
  // Every R10 dataset is documented, and each documented table key exists in code.
  for (const d of R10_ARTIFACTS) assert.ok(DOC.includes(d), `${d} is documented`);
  for (const t of ['operationalDetailEvidence', 'operationalDetailFindingRework',
    'operationalDetailReviewHistory', 'workOrderSla', 'scheduledOperationLineage',
    'permitToWorkLifecycle', 'permitToWorkApproval', 'securityOperationalPatrol',
    'securityOperationalShiftHandover', 'securityOperationalFinding',
    'securityOperationalIncidentReadiness', 'incidentRegister', 'correctiveAction']) {
    assert.ok(DOC.includes(t), `${t} is documented`);
    assert.ok(projSrc.includes(`'${t}'`), `${t} exists in the projection seam`);
  }
});

test('CLOSURE 14/15/17 — no forbidden infrastructure change, isolation intact, no test churn', () => {
  // CHECK 14 — no migration, seed, route, renderer or archive change in R10.
  assert.deepEqual(r10Files.filter((f) => /migrations|seeds/.test(f)), [], 'no migration or seed');
  assert.deepEqual(r10Files.filter((f) => /\.routes\.ts$|\.controller\.ts$/.test(f)), [],
    'no route or controller');
  assert.deepEqual(r10Files.filter((f) => /renderer|archive/.test(f)), [],
    'no renderer or archive special-case');
  assert.equal(/\brequirePermission\(/.test(r10AddedCode), false, 'no new permission enforcement');
  assert.equal(/code: '[a-z_]+\.(read|manage)'/.test(r10AddedCode), false, 'no new permission code');
  // The read models R10 added are read-only: no mutation statement anywhere in them.
  for (const dir of ['src/modules/permit-to-work-register', 'src/modules/scheduled-operation-lineage',
    'src/modules/work-order-sla-register']) {
    const c = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts'))
      .map((f) => strip(rd(`${dir}/${f}`))).join('\n');
    assert.equal(/INSERT INTO|UPDATE \w+ SET|DELETE FROM/.test(c), false,
      `${dir} is a read-only read model`);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, dir)).filter((f) => /routes|controller/.test(f)), [],
      `${dir} exposes no endpoint of its own`);
  }
  // No new domain status vocabulary and no lifecycle transition authority. The ONLY status
  // constant R10 added is a filter allow-list whose two values mirror the pre-existing
  // `review_status` CHECK constraint from migration 0074, so it reuses the domain's own vocabulary
  // rather than inventing one.
  const addedStatuses = [...r10AddedCode.matchAll(/const (\w*STATUSES\w*) = \[([^\]]*)\]/g)];
  assert.deepEqual(addedStatuses.map((m) => m[1]), ['PERMIT_REVIEW_STATUSES'],
    'exactly one status allow-list was added by R10');
  assert.deepEqual([...addedStatuses[0][2].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]),
    ['PENDING', 'COMPLETED']);
  assert.match(rd('src/database/migrations/0074_create_reviews.ts'),
    /review_status CHECK\(status IN \('PENDING','COMPLETED'\)\)/,
    'those values are the pre-R10 database constraint, not a new domain status');
  assert.equal(/canTransition|transitionTo|applyTransition/.test(r10AddedCode), false,
    'no workflow transition authority was added by R10');
  // PART 14B's additive security-report row identity field is the only intentional source-domain
  // additive change, and it remains purely additive.
  const secDiff = git('diff', R10_PARENT + '..HEAD', '--', 'src/modules/security-reports');
  const secRemoved = secDiff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim()).filter((l) => l && !/^(\/\/|\*|\/\*)/.test(l));
  assert.deepEqual(secRemoved, [], 'the security-report change removed no executable line');
  assert.match(secDiff, /\+.*patrol_schedule_binding_id/, 'the additive identity column is present');
  assert.match(rd('src/modules/security-reports/security-report.types.ts'),
    /patrolScheduleBindingId: string;/, 'and remains on the public row type');
  // CHECK 15 — isolation: no R10 adapter bypasses the source scope.
  assert.equal(/getPool|\.query\(/.test(sreg + sproj), false,
    'no Reporting adapter issues SQL, scoped or otherwise');
  assert.equal(/clientId:\s*(passThrough|query|input)/.test(sreg), false,
    'no adapter accepts a caller-supplied clientId');
  // SECURITY_OPERATIONAL_DETAIL still requires buildingId in all four branches.
  const sod = sreg.slice(sreg.indexOf('  SECURITY_OPERATIONAL_DETAIL: {'),
    sreg.indexOf('  INCIDENT_REGISTER: {'));
  assert.equal((sod.match(/buildingId is required for source=/g) ?? []).length, 4,
    'buildingId is required for every SECURITY_OPERATIONAL_DETAIL source');
  assert.equal((sod.match(/buildingScope: \[filters\.buildingId\]/g) ?? []).length, 4,
    'scope is the authorized building, never an all-Building expansion');
  // INCIDENT_REGISTER preserves the source's own optional-buildingId rollup instead of normalizing
  // it, and still never widens: scope comes from the owning service.
  assert.match(sreg.slice(sreg.indexOf('  INCIDENT_REGISTER: {')),
    /buildingId: filters\.buildingId \?\? null/,
    'the incident rollup keeps the source contract rather than inventing a narrower one');
  // CHECK 17 — PART 20 changes no production file and repairs no historical test. Commit-state
  // independent: `git diff` omits untracked files, so before the commit this file appears as
  // untracked and after it appears as tracked; in both states it is the ONLY change.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  assert.deepEqual([...new Set([...changedTracked, ...untracked])], [SELF],
    'PART 20 adds only this closure guard: zero production files, zero historical test repairs');
  assert.deepEqual(git('diff', '--name-only', BASE, '--', 'src/', 'docs/').split('\n').filter(Boolean),
    [], 'no production file changed in PART 20');
  assert.deepEqual(git('diff', '--name-only', BASE, '--', 'tests').split('\n').filter(Boolean)
    .filter((f) => f !== SELF), [], 'no prior-phase test was modified');
});
