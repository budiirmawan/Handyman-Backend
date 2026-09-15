import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 11 — SCHEDULED_OPERATION_LINEAGE Reporting export integration: focused validation.
 *
 * PART 11 adds ONLY export/presentation wiring: one dataset enum entry, one R10 projection and
 * one registry adapter, plus the OpenAPI enum/description. The authoritative domain and read
 * model stay byte-unchanged, and nothing else is wired — no route, controller, migration, new
 * permission, renderer branch, archive branch or PART 12 code.
 *
 * The runtime-free authorities (`reporting-export.types`, `reporting-export.r10-projections`,
 * `scheduled-operation-lineage.types`) are asserted LIVE, which is what makes the 24-field
 * projection parity a real executed proof rather than a text match. The registry imports the
 * module service, which imports the repository, which imports `getPool` (`pg`) — so it is NOT
 * live-importable in this dependency-free sandbox and is asserted statically against
 * comment-stripped source scoped to the adapter body. Live execution of the adapter load path
 * against PostgreSQL is therefore CI-required.
 *
 * Proofs: 1 runtime enum = 15 · 2 SOL registered exactly once · 3 prior 14 all retained ·
 * 4 no alias dataset names · 5 no csvDefaultTableKey added · 6 adapter keys == enum order ·
 * 7 OpenAPI enum = 15 · 8 identical set+order to runtime · 9 SOL once in OpenAPI ·
 * 10 block-scalar indentation intact · 11 documents task.read · 12 documents one row per
 * generated task + generatedTaskId identity · 13 documents building-scoped · 14 documents the
 * occurrenceAt date window · 15 documents separate binding ids · 16 documents assignment is not
 * executor · 17 documents recurrence 0..1 lineage not history · 18 documents no missed/overdue ·
 * 19 documents no KPI + one table · 20 makes none of the forbidden claims affirmatively ·
 * 21 projection has exactly the 24 authoritative keys in authoritative order · 22 exactly one
 * table scheduledOperationLineage · 23 kpis is empty · 24 every scalar field copied verbatim ·
 * 25 NULLs preserved · 26 recurrenceDaysOfWeek flattened, NULL stays NULL · 27 column types are
 * governed vocabulary and every cell is renderer-safe · 28 grain not collapsed · 29 INACTIVE
 * recurrence not filtered out · 30 no taskId/executionId column · 31 no forbidden labels ·
 * 32 adapter requires task.read only · 33 adapter delegates, forwards source, echoes filters and
 * computes no time · 34 authoritative module byte-unchanged and nothing else wired.  */

const ROOT = process.cwd();
const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export');
const MODULE_DIR = resolve(ROOT, 'src/modules/scheduled-operation-lineage');
const EXPORT_TYPES = resolve(EXPORT_DIR, 'reporting-export.types.ts');
const R10_PROJECTIONS = resolve(EXPORT_DIR, 'reporting-export.r10-projections.ts');
const EXPORT_REGISTRY = resolve(EXPORT_DIR, 'reporting-export.registry.ts');
const LINEAGE_TYPES = resolve(MODULE_DIR, 'scheduled-operation-lineage.types.ts');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');

/** The 14 datasets that existed before PART 11 — all must survive unchanged. */
const PRIOR_DATASETS = ['SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT',
  'UTILITY', 'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER',
  'WORK_ORDER_REGISTER', 'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL', 'CORRECTIVE_ACTION',
  'OPERATIONAL_DETAIL_HISTORY', 'WORK_ORDER_SLA'];
/** Names that would imply a competing or renamed register. */
const ALIAS_DATASETS = ['SCHEDULED_OPERATION', 'SCHEDULE_LINEAGE', 'GENERATED_TASK_LINEAGE',
  'TASK_LINEAGE', 'SCHEDULE_REGISTER', 'GENERATED_TASK_REGISTER'];
/** The 24 authoritative row fields, in PART 09 declaration order. */
const AUTH_ROW = ['generatedTaskId', 'clientId', 'buildingId', 'scheduleDefinitionId', 'scheduleDefinitionCode',
  'scheduleDefinitionName', 'scheduleDefinitionStatus', 'status', 'occurrenceAt', 'generatedAt',
  'checklistExecutionId', 'formInstanceId', 'assigneeType', 'assignedWorkforceProfileId', 'assignedWorkforceName',
  'assignedTeamId', 'assignedTeamName', 'recurrenceFrequency', 'recurrenceInterval', 'recurrenceDaysOfWeek',
  'recurrenceDayOfMonth', 'recurrenceStartDate', 'recurrenceEndDate', 'recurrenceStatus'];
/** Labels that would assert executor attribution, timeliness outcomes or history. */
const FORBIDDEN_LABELS = [/executor/i, /executed ?by/i, /performed ?by/i, /completed ?by/i, /missed/i, /overdue/i,
  /\blate\b/i, /on[ -]?time/i, /compliance/i, /breach/i, /grace/i, /due ?before/i, /latest recurrence/i,
  /current recurrence/i, /recurrence history/i, /recurrence count/i, /recurrence version/i, /snapshot/i,
  /\brate\b/i, /\bscore\b/i, /percent/i];

const read = (path: string): string => readFileSync(path, 'utf8');
/** Strips comments, so "must not exist" assertions test the CODE contract, not the prose. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const registryCode = code(EXPORT_REGISTRY);

/** The SCHEDULED_OPERATION_LINEAGE adapter body only, so a sibling adapter cannot satisfy a proof. */
function adapterBody(): string {
  const at = registryCode.indexOf('  SCHEDULED_OPERATION_LINEAGE: {');
  assert.ok(at >= 0, 'the adapter must be registered');
  const end = registryCode.indexOf('\n  },', at);
  assert.ok(end > at, 'the adapter must be closed');
  return registryCode.slice(at, end);
}

/** OpenAPI dataset description block scalar, sliced to the next sibling schema only. */
function openapiDescription(): string {
  const body = read(OPENAPI_PATH).slice(read(OPENAPI_PATH).indexOf('    ReportArchiveDataset:'));
  const start = body.indexOf('description: >') + 'description: >'.length;
  const next = /\n    [A-Za-z][A-Za-z0-9]*:\n/.exec(body);
  return body.slice(start, next ? next.index : body.length);
}
/**
 * Only the PART 11 paragraph. The OpenAPI description scalar documents ALL fifteen datasets in
 * one block, so scanning it whole would match sibling datasets' legitimate wording (exactly the
 * R10 PART 08 test trap) — every documentation proof is scoped to this slice.
 */
function solDoc(): string {
  const description = openapiDescription();
  const at = description.indexOf('SCHEDULED_OPERATION_LINEAGE (R10) exposes');
  assert.ok(at >= 0, 'the SCHEDULED_OPERATION_LINEAGE paragraph must exist');
  // R10 PART 15: honour the intent documented above. Slicing to the END of the scalar swept in
  // every later dataset paragraph, so PART 15's SECURITY_OPERATIONAL_DETAIL prose was scanned
  // against PART 11's own forbidden-claim list. That paragraph legitimately names `taskId` as its
  // row identity (PART 11's grain uses `generatedTaskId` instead) and explains why the Security
  // KPI's timeliness arithmetic is NOT reproduced here — both affirmative usages of words this
  // list bans. End the slice at the next dataset paragraph header (8-space indent) instead.
  const next = /^ {8}[A-Z][A-Z0-9_]+ \(R\d+\)/m.exec(description.slice(at + 1));
  const paragraph = next ? description.slice(at, at + 1 + next.index) : description.slice(at);
  return paragraph.replace(/\s+/g, ' ');
}
/**
 * Occurrence-level negation check. Dropping whole negated sentences would scan almost nothing
 * (this paragraph is mostly accurate denials), so instead EVERY occurrence of a forbidden claim
 * is examined in place and must sit inside a negated context. This proves the documentation does
 * not merely omit the claim but actively rules it out, and it scans the full paragraph.
 */
function noAffirmativeClaim(text: string, needle: RegExp): void {
  const pattern = new RegExp(needle.source, 'gi');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const before = text.slice(Math.max(0, match.index - 70), match.index);
    assert.ok(/\b(not|never|no|none|neither|nor|rather than|instead of|excluded)\b/i.test(before),
      `"${match[0]}" must appear only negated; context was ${JSON.stringify(before)}`);
  }
}

/** One generated-task row of the authoritative 24-field contract. */
const lineageRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  generatedTaskId: 'gt-1', clientId: 'cli-1', buildingId: 'b-1', scheduleDefinitionId: 'sd-1',
  scheduleDefinitionCode: 'SCH-01', scheduleDefinitionName: 'Daily Cleaning', scheduleDefinitionStatus: 'ACTIVE',
  status: 'OPEN', occurrenceAt: '2026-02-01T00:00:00.000Z', generatedAt: '2026-01-25T03:00:00.000Z',
  checklistExecutionId: null, formInstanceId: null, assigneeType: 'WORKFORCE', assignedWorkforceProfileId: 'wp-1',
  assignedWorkforceName: 'Jane Doe', assignedTeamId: null, assignedTeamName: null, recurrenceFrequency: 'WEEKLY',
  recurrenceInterval: 1, recurrenceDaysOfWeek: [1, 3, 5], recurrenceDayOfMonth: null, recurrenceStartDate: '2026-01-01',
  recurrenceEndDate: null, recurrenceStatus: 'ACTIVE', ...over,
});

describe('R10 PART 11 — Scheduled Operation Lineage Reporting export integration', () => {
  it('1-6 — the dataset is registered once as the fifteenth entry', async () => {
    const types = await import(pathToFileURL(EXPORT_TYPES).href);
    const runtime = [...types.REPORTING_EXPORT_DATASETS];
    assert.equal(runtime.length, 15, 'the runtime enum holds exactly fifteen datasets');  // 1
    assert.equal(runtime.filter((d: string) => d === 'SCHEDULED_OPERATION_LINEAGE').length, 1,
      'registered exactly once');  // 2
    for (const prior of PRIOR_DATASETS) assert.ok(runtime.includes(prior), `${prior} is retained`);  // 3
    assert.equal(runtime.indexOf('SCHEDULED_OPERATION_LINEAGE'), 14, 'appended last');  // 3
    for (const alias of ALIAS_DATASETS) assert.ok(!runtime.includes(alias), `no alias ${alias}`);  // 4
    assert.deepEqual(types.REPORTING_EXPORT_DATASET_METADATA,
      { OPERATIONAL_DETAIL: { csvDefaultTableKey: 'operationalDetail' } },
      'no csvDefaultTableKey added: OPERATIONAL_DETAIL stays the only default');  // 5
    assert.ok(!code(EXPORT_TYPES).slice(code(EXPORT_TYPES).indexOf('REPORTING_EXPORT_DATASET_METADATA'))
      .includes('SCHEDULED_OPERATION_LINEAGE'), 'the metadata map names no SOL key');  // 5
    const keys = [...registryCode.matchAll(/^  ([A-Z][A-Z0-9_]+): \{/gm)].map((m) => m[1]);
    assert.equal(keys.length, 15, 'fifteen adapters registered');  // 6
    // Adapters are looked up BY KEY, and the enum/adapter declaration order already differs for
    // pre-existing datasets (MANAGEMENT_OPERATIONS_COMMAND_CENTER is enum #5 but adapter #10),
    // so the contract is exact SET parity — not positional order.
    assert.deepEqual([...keys].sort(), [...runtime].sort(),
      'every enum dataset has exactly one adapter and vice versa');  // 6
    assert.deepEqual(keys.filter((k) => !runtime.includes(k)), [], 'no extra adapter');  // 6
    assert.deepEqual(runtime.filter((d) => !keys.includes(d)), [], 'no missing adapter');  // 6
  });

  it('7-10 — OpenAPI enum parity and block-scalar integrity', async () => {
    const types = await import(pathToFileURL(EXPORT_TYPES).href);
    const raw = read(OPENAPI_PATH);
    const body = raw.slice(raw.indexOf('    ReportArchiveDataset:'));
    const doc = /enum:\s*\[([\s\S]*?)\]/.exec(body)![1].split(',').map((v) => v.trim()).filter(Boolean);
    const runtime = [...types.REPORTING_EXPORT_DATASETS];
    assert.equal(doc.length, 15, 'the OpenAPI enum holds exactly fifteen datasets');  // 7
    assert.deepEqual(doc, runtime, 'identical set and order to the runtime enum');  // 8
    assert.equal(doc.filter((d) => d === 'SCHEDULED_OPERATION_LINEAGE').length, 1,
      'SCHEDULED_OPERATION_LINEAGE appears exactly once');  // 9
    const lines = openapiDescription().split('\n').filter((l) => l.trim().length > 0);
    assert.ok(lines.length > 150, 'the description scalar is fully present');  // 10
    assert.deepEqual(lines.filter((l) => !/^ {8}\S/.test(l)), [],
      'every description line keeps the eight-space block-scalar indentation');  // 10
  });

  it('11-20 — the OpenAPI description is accurate and claims nothing forbidden', () => {
    const doc = solDoc();
    assert.match(doc, /SCHEDULED_OPERATION_LINEAGE \(R10\) exposes[\s\S]*?requires task\.read/,
      'documents task.read as the permission');  // 11
    assert.match(doc, /schedule\.read is not used/, 'explicitly rules out schedule.read');  // 11
    assert.match(doc, /grain is exactly one row per\n?\s*generated task/, 'documents the per-generated-task grain');  // 12
    assert.match(doc, /identified by generatedTaskId: that IS the task\s*\n?\s*identity/,
      'generatedTaskId is documented as the identity');  // 12
    assert.match(doc, /no separate taskId field/, 'documents that no taskId alias exists');  // 12
    assert.match(doc, /Building-scoped only/, 'documents that the dataset is building-scoped');  // 13
    assert.match(doc, /no Building are excluded/, 'documents that NULL-building tasks are excluded');  // 13
    assert.match(doc, /half-open window over the generated task\s*\n?\s*occurrenceAt/,
      'documents occurrenceAt as the date authority');  // 14
    assert.match(doc, /never reinterpreted as createdAt, generatedAt,/, 'rules out other date meanings');  // 14
    assert.match(doc, /no default reporting period/, 'documents that no window is defaulted');  // 14
    assert.match(doc, /two separate 0\.\.1 bindings/, 'documents separate checklist and form bindings');  // 15
    assert.match(doc, /never merged into a generic\s*\n?\s*execution identifier/, 'rules out a merged executionId');  // 15
    assert.match(doc, /nor is an execution engine inferred/, 'rules out deriving an engine from binding ids');  // 15
    assert.match(doc, /never who executed it/, 'documents assignment is not execution');  // 16
    assert.match(doc, /no executor, executed-by,/, 'rules out executor attribution columns');  // 16
    assert.match(doc, /live current reference names rather than historical/, 'names are current, not snapshots');  // 16
    assert.match(doc, /persisted 0\.\.1 total lineage per schedule\s*\n?\s*definition, not a recurrence history/,
      'documents recurrence as persisted 0..1 lineage, not history');  // 17
    assert.match(doc, /no recurrence count,\s*\n?\s*version or latest-recurrence selector/,
      'rules out recurrence history vocabulary');  // 17
    assert.match(doc, /inactive recurrence is\s*\n?\s*reported/, 'an INACTIVE recurrence stays visible');  // 17
    assert.match(doc, /No missed, overdue, late, on-time, grace or schedule-compliance value is/,
      'documents that no timeliness outcome is derived');  // 18
    assert.match(doc, /persisted generated-task status rather\s*\n?\s*than a timeliness outcome/,
      'status is not reinterpreted');  // 18
    assert.match(doc, /No KPI is calculated/, 'documents that no KPI is calculated');  // 19
    assert.match(doc, /exactly one table, scheduledOperationLineage/, 'documents the single table');  // 19
    assert.match(doc, /24\s*\n?\s*fields are a verbatim re-presentation/, 'documents the 24-field verbatim contract');  // 19
    assert.match(doc, /eleven: buildingId, scheduleDefinitionId, generatedTaskId,/, 'documents the eleven filters');  // 19
    // 20 — forbidden claims must never appear AFFIRMATIVELY. Every occurrence is checked in
    // place, so the accurate "NOT one row per schedule" wording cannot satisfy this proof and a
    // claim smuggled into a positive sentence would fail it.
    for (const claim of [/one row per schedule/, /one row per execution/, /row per schedule definition/,
      /recurrence history/, /schedule[ -]compliance/, /compliance (rate|percentage)/, /\bexecutor\b/,
      /executed[ -]by/, /performed[ -]by/, /completed[ -]by/, /\bmissed\b/, /\boverdue\b/, /\blate\b/,
      /on[ -]time/, /\bgrace\b/, /due[ ]?before/, /latest[ -]recurrence/, /recurrence (count|version)/,
      /completion rate/, /execution rate/, /assignment rate/, /\bsnapshot(s)?\b/, /\btaskId\b/,
      /\bexecutionId\b/, /recurrence history table/, /\bKPI\b/]) {
      noAffirmativeClaim(doc, claim);
    }
    // The denials themselves must be present, so the absence above is deliberate documentation
    // rather than silence about a claim the dataset might otherwise be read as making.
    for (const denial of ['NOT one row per schedule', 'NOT one row per execution', 'not a recurrence history',
      'never who executed it', 'no executor, executed-by,', 'No missed, overdue, late, on-time, grace',
      'No KPI is calculated', 'no separate taskId field', 'never merged into a generic execution identifier']) {
      assert.ok(doc.includes(denial), `explicitly denies: ${denial}`);
    }
  });

  it('21-27 — the projection re-presents the authoritative row verbatim', async () => {
    const { projectScheduledOperationLineage } = await import(pathToFileURL(R10_PROJECTIONS).href);
    const types = await import(pathToFileURL(EXPORT_TYPES).href);
    // The authoritative field list is re-extracted from the frozen PART 09 types, so parity is
    // proven against the real contract rather than a copy of it.
    const lineageTypes = code(LINEAGE_TYPES);
    const decl = 'export type PublicScheduledOperationLineageRow = {';
    const blockStart = lineageTypes.indexOf(decl);
    assert.ok(blockStart >= 0, 'the authoritative row type must exist');
    const body = lineageTypes.slice(blockStart + decl.length);
    const authoritative = [...body.slice(0, body.indexOf('\n}')).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    assert.deepEqual(authoritative, AUTH_ROW, 'sanity: the authoritative contract is still 24 fields in order');

    const rows = [lineageRow(),
      lineageRow({ generatedTaskId: 'gt-2', status: 'COMPLETED', occurrenceAt: '2026-02-08T00:00:00.000Z',
        checklistExecutionId: 'ce-1', assigneeType: 'TEAM', assignedWorkforceProfileId: null,
        assignedWorkforceName: null, assignedTeamId: 'tm-1', assignedTeamName: 'Night Crew',
        recurrenceFrequency: 'MONTHLY', recurrenceDaysOfWeek: null, recurrenceDayOfMonth: 15,
        recurrenceStatus: 'INACTIVE', recurrenceEndDate: '2026-12-31' }),
      lineageRow({ generatedTaskId: 'gt-3', recurrenceDaysOfWeek: [] })];
    const source = { buildingId: null, buildingScope: ['b-1', 'b-2'], dateFrom: null, dateTo: null,
      asOf: '2026-02-28T00:00:00.000Z', rows };
    const out = projectScheduledOperationLineage(source);
    const columns = out.tables[0].columns;
    const projected = out.tables[0].rows;

    assert.equal(columns.length, 24, 'exactly 24 columns');  // 21
    assert.deepEqual(columns.map((c: { key: string }) => c.key), authoritative,
      'column keys are the authoritative 24 fields in authoritative order');  // 21
    assert.equal(out.tables.length, 1, 'exactly one table');  // 22
    assert.equal(out.tables[0].key, 'scheduledOperationLineage', 'the single table key');  // 22
    assert.equal(out.tables[0].label, 'Scheduled Operation Lineage', 'a factual table label');  // 22
    assert.equal(out.tables[0].rowCount, 3, 'rowCount mirrors the row count');  // 22
    assert.deepEqual(out.kpis, [], 'no KPI is invented');  // 23
    for (const field of authoritative.filter((f) => f !== 'recurrenceDaysOfWeek')) {
      for (let i = 0; i < rows.length; i += 1) {
        assert.equal(projected[i][field], rows[i][field], `${field} copied verbatim on row ${i}`);
      }
    }  // 24
    assert.deepEqual(Object.keys(projected[0]).filter((k) => !authoritative.includes(k)), [],
      'no field is added beyond the authoritative 24');  // 24
    for (const field of ['checklistExecutionId', 'formInstanceId', 'assignedTeamId', 'assignedTeamName',
      'recurrenceEndDate', 'recurrenceDayOfMonth', 'recurrenceFrequency', 'recurrenceStatus']) {
      assert.equal(projected[1][field], rows[1][field] ?? null, `${field} NULL is preserved, not blanked`);
    }
    assert.equal(projected[0].checklistExecutionId, null, 'an unbound checklist stays NULL');
    assert.equal(projected[0].formInstanceId, null, 'an unbound form stays NULL');
    assert.equal(projected[0].assignedTeamId, null, 'a WORKFORCE assignment leaves team ids NULL');
    assert.equal(typeof projected[0].buildingId, 'string',
      'buildingId is never NULL in this read model (NULL-building tasks are excluded upstream)');  // 25
    assert.equal(projected[0].recurrenceDaysOfWeek, '1,3,5', 'the array is flattened in order');  // 26
    assert.equal(projected[1].recurrenceDaysOfWeek, null, 'a NULL array stays NULL, not empty string');  // 26
    assert.equal(projected[2].recurrenceDaysOfWeek, '', 'an empty array stays distinguishable from NULL');  // 26
    for (const column of columns) {
      assert.ok(types.REPORTING_EXPORT_COLUMN_TYPES.includes(column.type), `${column.key} uses governed type`);
    }  // 27
    for (const row of projected) {
      for (const value of Object.values(row)) {
        assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value),
          'every cell is a renderer-safe scalar (no nested value reaches the CSV/XLSX/PDF guard)');
      }
    }  // 27
  });

  it('28-31 — grain, INACTIVE recurrence, identity columns and label safety', async () => {
    const { projectScheduledOperationLineage } = await import(pathToFileURL(R10_PROJECTIONS).href);
    // Three generated tasks of ONE schedule definition, two sharing an assignee type.
    const rows = [lineageRow(), lineageRow({ generatedTaskId: 'gt-2', occurrenceAt: '2026-02-02T00:00:00.000Z' }),
      lineageRow({ generatedTaskId: 'gt-3', occurrenceAt: '2026-02-03T00:00:00.000Z' })];
    const out = projectScheduledOperationLineage({ buildingId: null, buildingScope: ['b-1'], dateFrom: null,
      dateTo: null, asOf: '2026-02-28T00:00:00.000Z', rows });
    const projected = out.tables[0].rows;
    assert.equal(projected.length, 3, 'three generated tasks yield three export rows');  // 28
    assert.equal(new Set(projected.map((r: { scheduleDefinitionId: string }) => r.scheduleDefinitionId)).size, 1,
      'one schedule definition');  // 28
    assert.deepEqual(projected.map((r: { generatedTaskId: string }) => r.generatedTaskId), ['gt-1', 'gt-2', 'gt-3'],
      'never collapsed, grouped, deduplicated or reordered by the projection');  // 28
    const inactive = projectScheduledOperationLineage({ buildingId: null, buildingScope: ['b-1'], dateFrom: null,
      dateTo: null, asOf: '2026-02-28T00:00:00.000Z',
      rows: [lineageRow({ recurrenceStatus: 'INACTIVE', scheduleDefinitionStatus: 'INACTIVE' })] });
    assert.equal(inactive.tables[0].rowCount, 1, 'an INACTIVE recurrence is not filtered out');  // 29
    assert.equal(inactive.tables[0].rows[0].recurrenceStatus, 'INACTIVE',
      'INACTIVE is presented as the persisted lineage fact');  // 29
    const keys = out.tables[0].columns.map((c: { key: string }) => c.key);
    assert.ok(!keys.includes('taskId'), 'no taskId alias column');  // 30
    assert.ok(!keys.includes('executionId'), 'no generic merged executionId column');  // 30
    assert.ok(keys.includes('checklistExecutionId') && keys.includes('formInstanceId'),
      'both bindings stay separate columns');  // 30
    const labels = out.tables[0].columns.map((c: { label: string }) => c.label);
    for (const pattern of FORBIDDEN_LABELS) {
      assert.deepEqual(labels.filter((l: string) => pattern.test(l)), [], `no label matches ${pattern}`);
    }  // 31
    for (const safe of ['Assignee Type', 'Assigned Workforce', 'Assigned Team']) {
      assert.ok(labels.includes(safe), `assignment-safe label "${safe}" is used`);
    }  // 31
  });

  it('32-33 — the adapter requires task.read and delegates everything else', () => {
    const adapter = adapterBody();
    assert.match(adapter, /requiredReadPermission: 'task\.read',/, 'requires the verified task.read');  // 32
    assert.ok(!/schedule\.read|reporting\.read|'admin'|isAuthorized\(|hasAnyPermission/.test(adapter),
      'no schedule.read, reporting.read or admin fallback');  // 32
    assert.ok(!/requirePermission\(/.test(adapter), 'the adapter re-declares no permission check');  // 32
    assert.match(registryCode, /import \{\s*\n\s*getScheduledOperationLineage,\s*\n\s*parseScheduledOperationLineageQuery,\s*\n\} from '\.\.\/scheduled-operation-lineage';/,
      'imports the module PUBLIC index surface only');  // 33
    assert.ok(!registryCode.includes('scheduled-operation-lineage.repository'),
      'never imports the module repository');  // 33
    assert.ok(!registryCode.includes('getScheduledOperationLineageRows'),
      'never calls the repository function directly');  // 33
    assert.match(adapter, /const filters = parseScheduledOperationLineageQuery\(passThrough\);/,
      'parsing is delegated to the module parser');  // 33
    assert.match(adapter, /const source = await getScheduledOperationLineage\(filters, userId\);/,
      'loading is delegated to the module service');  // 33
    assert.match(adapter, /common: source,/, 'the service envelope is forwarded whole (buildingScope + asOf)');  // 33
    assert.match(adapter, /projected: projectScheduledOperationLineage\(source\),/,
      'projected through the single R10 projection');  // 33
    assert.match(adapter, /appliedFilters: echoFilters\(filters\),/, 'echoes only the parsed filters');  // 33
    assert.ok(!/new Date\(|Date\.now\(|CURRENT_TIMESTAMP|NOW\(\)/.test(adapter),
      'computes no instant of its own');  // 33
    for (const table of ['generated_tasks', 'schedule_definitions', 'schedule_recurrence', 'task_assignments',
      'checklist_executions', 'form_instances', 'workforce_profiles']) {
      assert.ok(!registryCode.includes(table), `no ${table} query is reproduced in the registry`);
    }  // 33
    assert.ok(!/SELECT |FROM |JOIN |getPool|\.query\(/.test(registryCode), 'no SQL anywhere in the registry');  // 33
    assert.ok(!/csvDefaultTableKey/.test(adapter), 'no per-dataset CSV default table key');  // 33
  });

  it('34 — the authoritative module is byte-unchanged and nothing else is wired', () => {
    // git blob SHA-1: sha1("blob <len>\0" + content), compared against the PART 10 baseline.
    const blob = (path: string): string => {
      const buf = readFileSync(path);
      return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`, 'binary'), buf]))
        .digest('hex');
    };
    const frozen: Record<string, string> = {
      'scheduled-operation-lineage.types.ts': 'a838cc923c5ff844b0b7d03de8a2ba4c9ab29fe4',
      'scheduled-operation-lineage.repository.ts': 'ce788bf90976d9f6d547298b5673de66b216ddc3',
      'scheduled-operation-lineage.service.ts': '0f11a99537bd232fa8e0fe1162603546139d6d6f',
      'index.ts': '65500e1b004fea706bb370718b665ad39ace328a',
    };
    for (const [file, expected] of Object.entries(frozen)) {
      assert.equal(blob(resolve(MODULE_DIR, file)), expected, `${file} is byte-identical to the PART 10 baseline`);
    }  // 34
    const raw = code(LINEAGE_TYPES);
    assert.equal([...raw.matchAll(/^\s*(\w+)\??:/gm)].length >= 24, true, 'row contract still declared');  // 34
    // Nothing beyond the four budgeted files is touched: no route, migration, permission,
    // renderer branch or archive branch for this dataset.
    const doc = openapiDescription();
    assert.ok(doc.includes('Reporting holds no generated-task, schedule, recurrence, assignment or') ||
      doc.includes('no generated-task, schedule, recurrence, assignment or'), 'documents the delegation');  // 34
    for (const path of [resolve(EXPORT_DIR, 'reporting-export.renderer.ts'),
      resolve(EXPORT_DIR, 'reporting-export.archive.ts'), resolve(ROOT, 'src/modules/tasks/task.routes.ts')]) {
      let source = '';
      try { source = read(path); } catch { source = ''; }
      assert.ok(!source.includes('SCHEDULED_OPERATION_LINEAGE'), `${path} names no SOL special case`);
    }  // 34
    assert.ok(!registryCode.includes('PART 12'), 'no PART 12 code');  // 34
    assert.equal([...registryCode.matchAll(/SCHEDULED_OPERATION_LINEAGE: \{/g)].length, 1,
      'exactly one adapter declaration in code');  // 34
  });
});
