import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 09 — Scheduled Operation Lineage contract: focused validation.
 *
 * PART 09 delivers exactly two production files (types + repository) and wires nothing: no
 * service, index, Reporting dataset, registry adapter, projection, OpenAPI, route,
 * permission or migration.
 *
 * The repository imports `getPool`, which pulls in `pg`, so it is NOT live-importable in
 * this dependency-free sandbox: it is asserted statically on comment-stripped source and
 * every cardinality and vocabulary claim is cross-checked against the MIGRATION that
 * actually creates it rather than against prose. Live database execution of the statement
 * is therefore CI-required. types.ts is runtime-free and is loaded live to prove it parses
 * with zero runtime exports.
 *
 * Proofs: 1 grain is generated_tasks.id · 2 base scope gt.building_id = ANY($1) · 3 no
 * NULL-building widening via client scope · 4 structural client/building equality · 5
 * checklist and form bindings separate · 6 no merged executionId · 7 no execution-history
 * fanout · 8 recurrence plain 0..1 · 9 no recurrence LATERAL/LIMIT/latest · 10 no
 * recurrenceCount or history · 11 recurrence fields are persisted facts · 12 assignment
 * semantics only · 13 no executor naming · 14 assignment selector follows the owning domain
 * · 15 malformed assignments cannot hide · 16 no missed · 17 no overdue · 18 no
 * dueBefore/grace arithmetic · 19 no KPI/compliance · 20 window is occurrence_at not
 * created_at · 21 status stays persisted · 22 deterministic ordering · 23 no service/index/
 * export wiring · 24 no route/OpenAPI/permission/migration change.  */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/scheduled-operation-lineage');
const TYPES_PATH = resolve(MODULE_DIR, 'scheduled-operation-lineage.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'scheduled-operation-lineage.repository.ts');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export');
const ARCHIVE_DIR = resolve(ROOT, 'src/modules/reporting-archives');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const ACCESS_SEED = resolve(ROOT, 'src/database/seeds/foundation-access.seed.ts');
const HOUSEKEEPING_REPO = resolve(ROOT, 'src/modules/housekeeping-reports/housekeeping-report.repository.ts');
const CLEANING_REPO = resolve(ROOT, 'src/modules/cleaning-schedule-bindings/cleaning-schedule-binding.repository.ts');
const TASK_ROUTES = resolve(ROOT, 'src/modules/tasks/task.routes.ts');
const mig = (id: string): string => readFileSync(resolve(MIGRATIONS_DIR, id), 'utf8');

const read = (path: string): string => readFileSync(path, 'utf8');
/** Strips comments so absence assertions test the CODE contract, not the prose. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const typesCode = code(TYPES_PATH);
/** Documentation lives in comments, so contract-intent proofs read the raw file. */
const rawTypes = read(TYPES_PATH);
const repoCode = code(REPO_PATH);
/** The single SQL statement only. */
const sql = repoCode.slice(repoCode.indexOf('`SELECT'), repoCode.indexOf('ORDER BY') + 60);

/** Field names of a type block, in declaration order (block starts AT the declaration). */
function fieldsOf(decl: string, src: string): string[] {
  const at = src.indexOf(decl);
  assert.ok(at >= 0, `${decl} must exist`);
  const b = src.slice(at);
  return [...b.slice(b.indexOf('{') + 1, b.indexOf('\n}')).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}
const rowFields = () => fieldsOf('export type PublicScheduledOperationLineageRow = {', typesCode);
const filterFields = () => fieldsOf('export type ScheduledOperationLineageFilters = {', typesCode);
const EXPECTED_ROWS = ['generatedTaskId', 'clientId', 'buildingId', 'scheduleDefinitionId', 'scheduleDefinitionCode',
  'scheduleDefinitionName', 'scheduleDefinitionStatus', 'status', 'occurrenceAt', 'generatedAt', 'checklistExecutionId',
  'formInstanceId', 'assigneeType', 'assignedWorkforceProfileId', 'assignedWorkforceName', 'assignedTeamId',
  'assignedTeamName', 'recurrenceFrequency', 'recurrenceInterval', 'recurrenceDaysOfWeek', 'recurrenceDayOfMonth',
  'recurrenceStartDate', 'recurrenceEndDate', 'recurrenceStatus'];
const EXPECTED_FILTERS = ['buildingId', 'scheduleDefinitionId', 'generatedTaskId', 'status', 'checklistExecutionId',
  'formInstanceId', 'assigneeType', 'assignedWorkforceProfileId', 'assignedTeamId', 'dateFrom', 'dateTo'];
/** Semantics this contract must never express. */
const FORBIDDEN = /executor|executedBy|executed_by|performedBy|performed_by|completedBy|completed_by|missed|overdue|dueBefore|due_before|graceMinutes|grace_minutes|onTime|on_time|late\b|delay|breach|compliance|isLate|timeliness/i;

describe('R10 PART 09 — Scheduled Operation Lineage contract', () => {
  it('1/2/3/4 — generated_tasks.id grain; fail-closed building scope; structural equality', () => {
    // 1. generated_tasks is the FROM table and its id is the row identity.
    assert.match(sql, /FROM generated_tasks gt/, 'generated_tasks is the base row authority');  // 1
    assert.match(sql, /gt\.id AS generated_task_id/, 'gt.id is selected as the row identity');  // 1
    // No construct can collapse or multiply the grain.
    for (const bad of ['GROUP BY', 'DISTINCT ON', 'ROW_NUMBER', 'OVER (', 'OVER(', 'UNION', 'LIMIT']) {
      assert.ok(!sql.includes(bad), `no ${bad} — the grain is never collapsed, ranked or capped`);  // 1
    }
    // `IS NOT DISTINCT FROM` is structural NULL-safe equality, not a DISTINCT projection.
    assert.ok(!/DISTINCT(?!\s+FROM)/.test(sql), 'no DISTINCT projection');  // 1
    // Every join is provably 0..1 or 1..1 in the schema that creates it.
    assert.equal((sql.match(/LEFT JOIN/g) || []).length, 7, 'exactly seven LEFT JOINs, no inner fanout');  // 1
    assert.ok(!/LATERAL/.test(sql), 'no LATERAL anywhere in the statement');  // 1
    assert.match(mig('0077_create_tasks.ts'), /schedule_definition_id UUID NOT NULL REFERENCES schedule_definitions/,
      'schedule lineage is 1..1 through a NOT NULL FK');  // 1
    // 2. Base scope is the authorized Building array, bound as $1.
    assert.match(repoCode, /'gt\.building_id = ANY\(\$1::uuid\[\]\)'/, 'base scope predicate');  // 2
    assert.match(repoCode, /const values: unknown\[\] = \[buildingIds\];/, '$1 is the caller-resolved scope');  // 2
    // 3. NULL-building tasks are excluded and never re-admitted through client scope.
    assert.match(repoCode, /'gt\.building_id IS NOT NULL'/, 'NULL-building rows are explicitly excluded');  // 3
    const domainList = read(TASK_ROUTES);
    assert.match(domainList, /building_id IS NULL AND client_id = ANY/,
      'the task domain does widen to client-scoped NULL-building rows elsewhere');
    assert.ok(!/building_id IS NULL AND/.test(repoCode), 'and this read model never reproduces that branch');  // 3
    assert.ok(!/client_id = ANY\(/.test(repoCode), 'client_id is never used as scope authority');  // 3
    assert.ok(!filtersInclude('clientId'), 'no clientId filter or scope override exists');  // 3
    // 4. Enrichment carrying authoritative scope columns is pinned structurally.
    assert.match(sql, /sd\.id = gt\.schedule_definition_id\s*\n?\s*AND sd\.client_id = gt\.client_id\s*\n?\s*AND sd\.building_id IS NOT DISTINCT FROM gt\.building_id/,
      'schedule join pins id AND client AND building, never UUID uniqueness alone');  // 4
    assert.match(sql, /ce\.generated_task_id = gt\.id\s*\n?\s*AND ce\.client_id = gt\.client_id/,
      'checklist binding pins client equality');  // 4
    assert.match(sql, /fi\.generated_task_id = gt\.id\s*\n?\s*AND fi\.client_id = gt\.client_id/,
      'form binding pins client equality');  // 4
    // The generator copies sd.building_id into gt.building_id, so IS NOT DISTINCT FROM is lossless.
    assert.match(read(TASK_ROUTES), /s\.target_type,s\.target_id,s\.building_id\]/,
      'generated_tasks.building_id is copied from the schedule definition');  // 4
    assert.ok(!mig('0070_create_checklist_executions.ts').includes('building_id'),
      'checklist_executions has no building_id, so client equality is the available pin');  // 4
  });

  it('5/6/7 — checklist and form bindings stay separate; no execution history', () => {
    // 5/6. Two separate persisted bindings; no merged or inferred identifier.
    assert.match(sql, /ce\.id AS checklist_execution_id/, 'checklist binding id exposed');  // 5
    assert.match(sql, /fi\.id AS form_instance_id/, 'form binding id exposed separately');  // 5
    assert.ok(rowFields().includes('checklistExecutionId') && rowFields().includes('formInstanceId'), 'both survive');  // 5
    assert.ok(!rowFields().includes('executionId'), 'no generic merged executionId');  // 6
    assert.ok(!/executionId|execution_id AS|COALESCE\(ce\.id|COALESCE\(fi\.id/.test(repoCode),
      'and neither is one coalesced from whichever binding happens to be non-NULL');  // 6
    assert.ok(!/target_type|engine|bindingType|executionType/i.test(sql), 'no engine is inferred');  // 6
    // 7. Only the bound row's id is read: no child history, no execution facts.
    for (const bad of ['checklist_item_responses', 'form_responses', 'ce.status', 'fi.status', 'ce.started_at',
      'fi.started_at', 'ce.completed_at', 'fi.completed_at', 'ce.created_at']) {  // 7
      assert.ok(!sql.includes(bad), `${bad} is never selected or joined`); }
    assert.equal((sql.match(/checklist_executions/g) || []).length, 1, 'one checklist join, no fanout');  // 7
    assert.equal((sql.match(/form_instances/g) || []).length, 1, 'one form join, no fanout');  // 7
    // Cardinality is enforced by the migrations that create the bindings.
    assert.match(mig('0339_unique_checklist_execution_per_generated_task.ts'),
      /CREATE UNIQUE INDEX checklist_executions_generated_task_unique[\s\S]*?WHERE generated_task_id IS NOT NULL/,
      'checklist binding is 0..1 per generated task');  // 7
    assert.match(mig('0340_bind_form_instance_to_generated_task.ts'),
      /CREATE UNIQUE INDEX form_instances_generated_task_unique[\s\S]*?WHERE generated_task_id IS NOT NULL/,
      'form binding is 0..1 per generated task');  // 7
  });

  it('8/9/10/11 — recurrence is a plain 0..1 total join over persisted facts', () => {
    // 8. Plain bounded join; uniqueness is a database constraint, not a selector.
    assert.match(mig('0076_create_schedule_recurrence.ts'), /recurrence_schedule_unique UNIQUE\(schedule_definition_id\)/,
      'migration 0076 proves TOTAL 0..1 recurrence per schedule definition');  // 8
    assert.match(sql, /LEFT JOIN schedule_recurrence sr\s*\n?\s*ON sr\.schedule_definition_id = sd\.id/,
      'a plain bounded join on the schedule id');  // 8
    assert.equal((sql.match(/schedule_recurrence/g) || []).length, 1, 'joined exactly once');  // 8
    // The domain's own recurrence read relies on the same constraint with no selector.
    assert.match(code(CLEANING_REPO), /FROM schedule_recurrence\s*\n?\s*WHERE schedule_definition_id = \$1/,
      'matching the owning domain plain read');  // 8
    // 9. No latest/current recurrence selector of any kind.
    for (const bad of ['LATERAL', 'LIMIT 1', 'MAX(created_at)', 'max(sr.', 'ORDER BY sr.', 'ROW_NUMBER']) {  // 9
      assert.ok(!sql.includes(bad), `no ${bad} recurrence selector`); }
    assert.ok(!/latestRecurrence|currentRecurrence|latest_recurrence|current_recurrence/i.test(repoCode + typesCode),
      'no latest/current recurrence concept exists');  // 9
    // 9. sr.status is deliberately NOT filtered: this is lineage, not a scheduler.
    assert.ok(!/sr\.status = 'ACTIVE'/.test(sql), 'no ACTIVE filter hides INACTIVE recurrence lineage');  // 9
    assert.match(read(TASK_ROUTES), /schedule_recurrence WHERE schedule_definition_id=\$1 AND status='ACTIVE'/,
      'the ACTIVE filter belongs to the generation path only');  // 9
    // 10. No count and no history semantics.
    for (const bad of ['recurrenceCount', 'recurrence_count', 'recurrenceHistory', 'count(sr.', 'COUNT(*)']) {  // 10
      assert.ok(!repoCode.includes(bad) && !typesCode.includes(bad), `no ${bad}`); }
    // 11. Every recurrence field is a persisted column of schedule_recurrence.
    const created = mig('0076_create_schedule_recurrence.ts');
    const rows = rowFields();
    const pairs: [string, string][] = [['recurrenceFrequency', 'frequency TEXT NOT NULL'],
      ['recurrenceInterval', 'interval INTEGER NOT NULL'], ['recurrenceDaysOfWeek', 'days_of_week INTEGER[]'],
      ['recurrenceDayOfMonth', 'day_of_month INTEGER'], ['recurrenceStartDate', 'start_date DATE NOT NULL'],
      ['recurrenceEndDate', 'end_date DATE'], ['recurrenceStatus', "status TEXT NOT NULL DEFAULT 'ACTIVE'"]];
    for (const [field, column] of pairs) {
      assert.ok(rows.includes(field), `${field} is exposed`);  // 11
      assert.ok(created.includes(column), `${field} maps to a persisted column: ${column}`);  // 11
      assert.ok(new RegExp(`sr\\.${column.split(' ')[0]} AS recurrence_`).test(sql),
        `${field} is selected from sr.${column.split(' ')[0]}`);  // 11
    }
    assert.equal(rows.filter((f) => f.startsWith('recurrence')).length, 7, 'exactly seven recurrence fields');  // 11
    assert.ok(!/nextOccurrence|next_occurrence|projected|forecast|expand/i.test(repoCode + typesCode),
      'no occurrence is projected or expanded from the recurrence rule');  // 11
  });

  it('12/13/14/15 — assignment semantics only, on the domain deterministic selector', () => {
    const rows = rowFields();
    // 12. Every assignment field is named as an assignment.
    for (const field of ['assigneeType', 'assignedWorkforceProfileId', 'assignedWorkforceName', 'assignedTeamId',
      'assignedTeamName']) {  // 12
      assert.ok(rows.includes(field), `${field} is exposed with assignment semantics`); }
    assert.match(sql, /ta\.assignee_type AS assignee_type/, 'sourced from task_assignments');  // 12
    assert.match(rawTypes, /ASSIGNMENT SEMANTICS/, 'the contract states assignment is not execution');  // 12
    // 13. No executor naming anywhere in either production file.
    for (const bad of ['Executor', 'Executed By', 'executedBy', 'Performed By', 'performedBy', 'Completed By',
      'completedBy', 'completed_by_user_id', 'started_at', 'completed_at', 'completion_notes']) {
      assert.ok(!repoCode.includes(bad), `no ${bad} in the repository`);  // 13
      assert.ok(!typesCode.includes(bad), `no ${bad} in the contract`);  // 13
    }
    assert.ok(!FORBIDDEN.test(sql), 'the SQL derives no timeliness or executor fact');  // 13
    assert.ok(!/'Executor'|'Executed By'|'Performed By'|'Completed By'/.test(repoCode + typesCode),
      'no forbidden presentation label exists');  // 13
    // 14. The selector is the owning domain's own: a plain ACTIVE join, no invented precedence.
    assert.match(sql, /LEFT JOIN task_assignments ta\s*\n?\s*ON ta\.task_id = gt\.id\s*\n?\s*AND ta\.status = 'ACTIVE'/,
      'the current-assignment shape is the domain authority');  // 14
    assert.match(code(HOUSEKEEPING_REPO), /LEFT JOIN task_assignments ta ON ta\.task_id = gt\.id AND ta\.status = 'ACTIVE'/,
      'copied verbatim from housekeeping-report.repository.ts');  // 14
    assert.ok(!/assigned_at|ORDER BY ta\.|MAX\(ta\.| newest|most recent/i.test(sql),
      'no recency precedence is invented over assignments');  // 14
    // 15. Ambiguity is structurally impossible, so nothing can be silently hidden.
    assert.match(mig('0078_create_task_assignments.ts'),
      /task_active_assignment_unique ON task_assignments\(task_id\) WHERE status='ACTIVE'/,
      'a partial UNIQUE index enforces at most one ACTIVE assignment per task');  // 15
    assert.ok(!rows.includes('assignmentCount'), 'so no assignmentCount is needed to expose ambiguity');  // 15
    assert.match(rawTypes, /task_active_assignment_unique/, 'the guarantee is documented in the contract');  // 15
    assert.ok(!/ta\.status IS NULL|COALESCE\(ta\./.test(sql), 'no fallback invents an assignment');  // 15
    // Names are live/current reference-table values, never presented as snapshots.
    assert.match(sql, /wp\.full_name AS assigned_workforce_name/, 'workforce name comes from full_name');  // 12
    assert.match(sql, /t\.name AS assigned_team_name/, 'team name comes from teams.name');  // 12
    assert.match(mig('0024_create_workforce_profiles.ts'), /full_name\s+TEXT NOT NULL/, 'verified column');
    assert.ok(!/snapshot|historical name|nameAt|asNamed/i.test(typesCode + repoCode),
      'no name is labelled a historical snapshot');  // 12
    assert.ok(!/assigned_by_user_id/.test(sql), 'the assigning actor identity is not exposed');  // 13
  });

  it('16/17/18/19/21 — no missed, overdue, grace or KPI derivation; status stays persisted', () => {
    // 16/17/18. No timeliness arithmetic of any kind.
    for (const bad of ['missed', 'overdue', 'dueBefore', 'due_before', 'graceMinutes', 'grace', 'isLate', 'late',
      'delay', 'breach', 'EXTRACT(EPOCH', 'INTERVAL', 'NOW()', 'CURRENT_TIMESTAMP', 'AGE(']) {  // 16/17/18
      assert.ok(!sql.includes(bad), `the SQL contains no ${bad}`); }
    assert.ok(!/occurrence_at\s*[<>=]|occurrence_at\s*-|- gt\.occurrence_at|gt\.occurrence_at \+/.test(sql),
      'occurrence_at is never compared or used in arithmetic');  // 18
    assert.ok(!FORBIDDEN.test(typesCode + repoCode), 'neither production file expresses a forbidden semantic');
    // 19. No KPI, rate, percentage or compliance formula.
    for (const bad of ['percent', 'compliance', 'score', 'COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(']) {
      assert.ok(!sql.includes(bad), `no ${bad} aggregate or formula`);  // 19
    }
    assert.ok(!/\bkpi\b|\brate\b|\bratio\b|percentage/i.test(sql + repoCode + typesCode),
      'no KPI, rate, ratio or percentage anywhere');  // 19
    // 21. Status is the persisted column, with the migration-verified vocabulary.
    assert.match(sql, /gt\.status AS status/, 'task status is read, never derived');  // 21
    assert.match(mig('0079_extend_task_execution.ts'),
      /CHECK\(status IN \('OPEN','ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED'\)\)/, 'its persisted domain');  // 21
    assert.match(typesCode, /'OPEN'\s*\n?\s*\| 'ASSIGNED'\s*\n?\s*\| 'IN_PROGRESS'\s*\n?\s*\| 'COMPLETED'\s*\n?\s*\| 'CANCELLED'/,
      'the contract restates exactly those five values');  // 21
    for (const bad of ['Completed On Time', 'On Time', 'Late', 'Missed', 'Overdue', 'Successful', 'Failed']) {  // 21
      assert.ok(!typesCode.includes(`'${bad}'`), `status is never reinterpreted as ${bad}`); }
    assert.match(sql, /sd\.status AS schedule_definition_status/, 'schedule status likewise persisted');  // 21
    assert.match(mig('0075_create_schedule_definitions.ts'), /schedule_status CHECK\(status IN \('ACTIVE','INACTIVE'\)\)/,
      'its persisted domain');  // 21
  });

  it('20/22 + contract parity — occurrence_at window, deterministic order, 24 fields', async () => {
    // 20. The window is the authoritative planned occurrence instant.
    assert.match(mig('0077_create_tasks.ts'), /occurrence_at TIMESTAMPTZ NOT NULL/, 'occurrence_at is persisted');  // 20
    assert.match(repoCode, /conditions\.push\(`gt\.occurrence_at >= \$\$\{values\.length\}`\)/, 'dateFrom inclusive');  // 20
    assert.match(repoCode, /conditions\.push\(`gt\.occurrence_at < \$\$\{values\.length\}`\)/, 'dateTo exclusive');  // 20
    assert.ok(!/created_at >=|created_at <|updated_at >=|gt\.created_at/.test(sql + repoCode),
      'created_at is never a window fallback');  // 20
    assert.ok(!/DEFAULT_RANGE|defaultPeriod|daysBack|30 \* 24/.test(repoCode), 'no default report period');  // 20
    assert.ok(!/dateMode|windowField|dateField/.test(typesCode + repoCode), 'and no second date mode exists');  // 20
    // 22. Deterministic ordering over persisted values only.
    assert.match(sql, /ORDER BY gt\.occurrence_at ASC, gt\.id ASC/, 'occurrence then the row identity');  // 22
    assert.ok(!/ORDER BY.*name|ORDER BY.*code/i.test(sql), 'never ordered by a mutable presentation name');  // 22
    // Contract parity: public row == raw SQL row type == select aliases == mapRow.
    const rows = rowFields();
    assert.equal(rows.length, 24, 'exactly 24 public row fields');
    assert.deepEqual(rows, EXPECTED_ROWS, 'in the authoritative declared order');
    const raw = fieldsOf('type ScheduledOperationLineageRow = {', repoCode);
    const aliases = [...sql.matchAll(/^\s*(?:gt|sd|sr|ce|fi|ta|wp|t)\.[\w"]+ AS (\w+),?$/gm)].map((m) => m[1]);
    const mb = repoCode.slice(repoCode.indexOf('function mapRow'));
    const mapped = [...mb.slice(0, mb.indexOf('\n}')).matchAll(/^\s*(\w+): (?:\w+\()?row\.(\w+)\)?,$/gm)];
    assert.equal(aliases.length, 24, 'the select list has 24 aliases');
    assert.deepEqual(raw, aliases, 'the raw row type is the select list, in order');
    assert.deepEqual(mapped.map((m) => m[2]), raw, 'mapRow reads every raw column, in order');
    assert.deepEqual(mapped.map((m) => m[1]), rows, 'and emits every public field, in order');
    // Filter contract: exactly the bounded eleven, no pagination, no sort, no search.
    assert.deepEqual(filterFields(), EXPECTED_FILTERS, 'the frozen filter contract');
    assert.equal(EXPECTED_FILTERS.length, 11);
    assert.ok(!filtersInclude('taskId'), 'no taskId: the schema has no task entity separate from generated_tasks');
    const gt0077 = mig('0077_create_tasks.ts');
    const gtCols = gt0077.slice(gt0077.indexOf('CREATE TABLE generated_tasks('), gt0077.indexOf('CONSTRAINT task_status'));
    assert.ok(!/\btask_id\b/.test(gtCols), 'generated_tasks has no task_id column, so none is invented');
    assert.match(mig('0078_create_task_assignments.ts'), /task_id UUID NOT NULL REFERENCES generated_tasks\(id\)/,
      'task_id exists only as the assignment FK back to generated_tasks.id');
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => mig(f).includes('CREATE TABLE tasks(')),
      'and there is no separate tasks table');
    for (const bad of ['limit', 'offset', 'sort', 'search', 'page', 'missed', 'overdue', 'graceMinutes', 'executor',
      'completedBy']) {
      assert.ok(!filtersInclude(bad), `no ${bad} filter`); }
    // Envelope contract, and no clock: the repository takes no instant and reads none.
    assert.deepEqual(fieldsOf('export type PublicScheduledOperationLineage = {', typesCode),
      ['buildingId', 'buildingScope', 'dateFrom', 'dateTo', 'asOf', 'rows'], 'the envelope for PART 10');
    assert.match(repoCode, /buildingIds: string\[\],\s*\n?\s*filters: ScheduledOperationLineageFilters,\s*\n?\s*start: Date \| null,\s*\n?\s*end: Date \| null,\s*\n?\s*\)/,
      'the repository signature carries no asOf, because no field is read-time derived');
    assert.ok(!/new Date\(|Date\.now\(|performance\.now|process\.hrtime/.test(repoCode),
      'the repository reads no clock and invents no current-time fact');
    assert.equal((repoCode.match(/\$\{values\.length\}/g) || []).length, 10, 'every filter binds a parameter');
    assert.ok(!/query<[^>]*>\(\s*`[^`]*\$\{(?!values\.length|conditions)/.test(repoCode),
      'no other interpolation reaches the SQL text');
    // types.ts is runtime-free and parses live with zero runtime exports.
    const mod = await import(pathToFileURL(TYPES_PATH).href);
    assert.deepEqual(Object.keys(mod).filter((k) => k !== 'default'), [], 'types only, no runtime surface');
  });

  it('23/24 — nothing is wired: no service, index, dataset, registry, OpenAPI, route', async () => {
    // 23. Exactly the two intended production files exist.
    assert.deepEqual(readdirSync(MODULE_DIR).sort(), ['scheduled-operation-lineage.repository.ts',
      'scheduled-operation-lineage.types.ts'], 'types + repository only');  // 23
    for (const absent of ['scheduled-operation-lineage.service.ts', 'index.ts', 'scheduled-operation-lineage.routes.ts',
      'scheduled-operation-lineage.controller.ts']) {  // 23
      assert.ok(!readdirSync(MODULE_DIR).includes(absent), `${absent} must not exist in PART 09`); }
    // No Reporting surface knows about this module yet.
    const exportTypes = await import(pathToFileURL(resolve(EXPORT_DIR, 'reporting-export.types.ts')).href);
    assert.equal(exportTypes.REPORTING_EXPORT_DATASETS.length, 14, 'the dataset enum is still 14');  // 23
    assert.ok(![...exportTypes.REPORTING_EXPORT_DATASETS].some((d) => /LINEAGE|SCHEDULED_OPERATION/i.test(d)),
      'no lineage dataset was registered');  // 23
    for (const file of readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.ts'))) {  // 23
      const src = code(resolve(EXPORT_DIR, file));
      assert.ok(!src.includes('scheduled-operation-lineage'), `reporting-export/${file} does not import it`);
      assert.ok(!/ScheduledOperationLineage|scheduledOperationLineage/.test(src), `${file} gains no branch`); }
    for (const file of readdirSync(ARCHIVE_DIR)) {  // 23
      assert.ok(!/scheduledOperationLineage|SCHEDULED_OPERATION_LINEAGE/.test(code(resolve(ARCHIVE_DIR, file))),
        `${file} gains no lineage branch`); }
    // 24. No OpenAPI, permission, route or migration surface was touched.
    assert.ok(!/SCHEDULED_OPERATION_LINEAGE|scheduledOperationLineage/i.test(read(OPENAPI_PATH)),
      'OpenAPI is unchanged');  // 24
    // `0324_add_service_lineage_identity.ts` predates this PART and is unrelated, so the
    // proof is that no migration exists for THIS read model — it reads existing tables only.
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => /scheduled_operation/i.test(f)),
      'no migration filename references this read model');  // 24
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => mig(f).includes('scheduled_operation_lineage')),
      'no migration creates a lineage table or column');  // 24
    const seed = read(ACCESS_SEED);
    assert.ok(!/scheduled_operation/i.test(seed), 'no scheduled_operation permission seeded');  // 24
    assert.ok(!/code: '[a-z_]*lineage/i.test(seed), 'no lineage permission code seeded');  // 24
    assert.ok(!/requiredReadPermission|permission/i.test(repoCode + typesCode),
      'no permission is declared in this PART');  // 24
    assert.ok(!/from 'express'|Router\(|requirePermission|import type \{ Request|\bResponse\b/.test(repoCode + typesCode),
      'no HTTP surface');  // 24
    assert.ok(!/scheduled-operation-lineage/.test(read(resolve(ROOT, 'src/app.ts'))), 'not wired into the app');  // 24
    // The module is genuinely unreachable at runtime: nothing outside it imports it.
    assert.deepEqual(grepFiles(ROOT, 'scheduled-operation-lineage', ['src', 'docs']),
      ['src/modules/scheduled-operation-lineage/scheduled-operation-lineage.repository.ts'],
      'nothing outside the module references it — it is unreachable at runtime');  // 23
  });
});

/** True when the filter contract declares `name` (as an own key, not a substring). */
function filtersInclude(name: string): boolean {
  return filterFields().includes(name);
}

/** Repo-relative paths under `dirs` whose text contains `needle`. */
function grepFiles(root: string, needle: string, dirs: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|yaml|yml)$/.test(entry.name) && read(resolve(root, rel)).includes(needle)) hits.push(rel);
    }
  };
  for (const dir of dirs) walk(dir);
  return hits.sort();
}
