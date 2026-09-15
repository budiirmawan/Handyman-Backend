import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 10 — Scheduled Operation Lineage SERVICE + INDEX: focused validation.
 *
 * PART 10 completes the module with service.ts and index.ts and wires nothing else: no route,
 * controller, permission, Reporting dataset enum entry, registry adapter, projection, OpenAPI
 * surface or migration. The PART 09 types and repository stay authoritative and byte-unchanged.
 *
 * The service imports the repository, which imports `getPool` (`pg`), so it is NOT
 * live-importable in this dependency-free sandbox and is asserted statically against
 * comment-stripped source, scoped per function so one helper cannot satisfy another's proof.
 * The runtime-free authorities it reuses (`cleaning-assignment.types`,
 * `scheduled-operation-lineage.types`) ARE asserted live — the R08 PART 01B / R10 PART 03
 * convention. Live execution of the read path against PostgreSQL is therefore CI-required.
 *
 * Proofs: 1 verified read permission documented for PART 11 · 2 no new permission · 3 explicit
 * buildingId asserts access · 4 explicit buildingId scopes to exactly it · 5 omitted uses
 * accessible ids · 6 empty scope returns a well-formed empty envelope · 7 repository not called
 * then · 8 no NULL-building widening · 9 clientId not a filter · 10 exactly the 11 PART 09
 * filters · 11 taskId not accepted · 12 generatedTaskId is the identity filter · 13
 * scheduleDefinitionId narrows only · 14 bindings stay separate · 15 assigneeType reuses
 * existing authority · 16 status uses the typed guard · 17 invalid dates rejected · 18
 * dateFrom >= dateTo rejected · 19 no default period · 20 occurrenceAt is the date authority ·
 * 21 exactly one asOf · 22 asOf is envelope metadata only · 23 no missed/overdue derivation ·
 * 24 repository called exactly once · 25 rows verbatim · 26 no collapse or dedup · 27 no
 * business sort · 28 no assignment/executor transform · 29 minimal index surface · 30 nothing
 * else wired.  */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/scheduled-operation-lineage');
const SERVICE_PATH = resolve(MODULE_DIR, 'scheduled-operation-lineage.service.ts');
const INDEX_PATH = resolve(MODULE_DIR, 'index.ts');
const TYPES_PATH = resolve(MODULE_DIR, 'scheduled-operation-lineage.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'scheduled-operation-lineage.repository.ts');
const ASSIGNMENT_TYPES = resolve(ROOT, 'src/modules/cleaning-assignments/cleaning-assignment.types.ts');
const TASK_ROUTES = resolve(ROOT, 'src/modules/tasks/task.routes.ts');
const SCHEDULE_ROUTES = resolve(ROOT, 'src/modules/schedules/schedule.routes.ts');
const ACCESS_SEED = resolve(ROOT, 'src/database/seeds/foundation-access.seed.ts');
const EXPORT_REGISTRY = resolve(ROOT, 'src/modules/reporting-export/reporting-export.registry.ts');
const EXPORT_TYPES = resolve(ROOT, 'src/modules/reporting-export/reporting-export.types.ts');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ARCHIVE_DIR = resolve(ROOT, 'src/modules/reporting-archives');

/** The eleven filters PART 09 froze — the service may read exactly these. */
const FROZEN_FILTERS = ['buildingId', 'scheduleDefinitionId', 'generatedTaskId', 'status',
  'checklistExecutionId', 'formInstanceId', 'assigneeType', 'assignedWorkforceProfileId', 'assignedTeamId',
  'dateFrom', 'dateTo'];
/** Parameters that must never exist on this read model. */
const FORBIDDEN_PARAMS = ['taskId', 'clientId', 'missed', 'overdue', 'dueBefore', 'graceMinutes', 'executor',
  'completedBy', 'page', 'limit', 'offset', 'sort', 'search', 'sortBy', 'orderBy', 'pageSize'];
const ENVELOPE_KEYS = ['buildingId', 'buildingScope', 'dateFrom', 'dateTo', 'asOf', 'rows'];
/** The full persisted generated-task status domain (migration 0079's CHECK constraint). */
const FULL_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

const read = (path: string): string => readFileSync(path, 'utf8');
/** Strips comments, so "must not exist" assertions test the CODE contract, not the prose. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const serviceCode = code(SERVICE_PATH);
const serviceRaw = read(SERVICE_PATH);
const indexRaw = read(INDEX_PATH);

/** One top-level function body, so a helper can never satisfy another function's proof. */
function bodyOf(signature: string): string {
  const at = serviceCode.indexOf(signature);
  assert.ok(at >= 0, `${signature} must exist`);
  const end = serviceCode.indexOf('\n}', at);
  assert.ok(end > at, `${signature} must be closed`);
  return serviceCode.slice(at, end);
}
const lineageFn = () => bodyOf('export async function getScheduledOperationLineage(');
const scopeFn = () => bodyOf('async function resolveScope(');
const parserFn = () => bodyOf('export function parseScheduledOperationLineageQuery(');
/**
 * `scheduledOperationLineageRange` declares a MULTI-LINE return type, so the first `\n}`
 * after its signature closes that type literal rather than the body. Its body is opened by
 * `\n} {` and closed by the next `\n}`.
 */
function rangeFn(): string {
  const at = serviceCode.indexOf('export function scheduledOperationLineageRange(');
  assert.ok(at >= 0, 'scheduledOperationLineageRange must exist');
  const bodyStart = serviceCode.indexOf('\n} {', at);
  assert.ok(bodyStart > at, 'its body must open');
  const end = serviceCode.indexOf('\n}', bodyStart + 4);
  assert.ok(end > bodyStart, 'its body must close');
  return serviceCode.slice(bodyStart + 4, end);
}

describe('R10 PART 10 — Scheduled Operation Lineage service and index', () => {
  it('1/2 — task.read is the verified authority; no permission is created', () => {
    // 1. The permission is source-verified, not guessed: it gates the generated-task reads.
    const routes = read(TASK_ROUTES);
    assert.match(routes, /requirePermission\('task\.read'\)/, 'task.read exists in the task routes');  // 1
    assert.match(routes, /rd=requirePermission\('task\.read'\)/, 'bound as the read gate');  // 1
    assert.match(routes, /r\.get\('\/tasks',a,rd,list\);r\.get\('\/tasks\/:id',a,rd,get\)/,
      'and it governs GET /tasks and GET /tasks/:id over generated_tasks');  // 1
    assert.match(read(ACCESS_SEED), /\{ code: 'task\.read', name: 'Read Tasks' \}/, 'it is already seeded');  // 1
    assert.match(serviceRaw, /`task\.read`/, 'the service documents the verified permission for PART 11');  // 1
    assert.match(serviceRaw, /requiredReadPermission/, 'and names the PART 11 wiring point');  // 1
    // schedule.read was considered and rejected: it gates the definition/preview routes.
    assert.match(read(SCHEDULE_ROUTES), /requirePermission\('schedule\.read'\)/, 'schedule.read exists too');
    assert.match(serviceRaw, /`schedule\.read` was considered and REJECTED/, 'and its rejection is recorded');  // 1
    assert.match(serviceRaw, /mobile-assignments/, 'the generated_tasks precedent is recorded');  // 1
    // 2. No new permission, no gate inside the service, no fallback.
    const seed = read(ACCESS_SEED);
    assert.ok(!/code: '[a-z_]*(scheduled_operation|lineage)[a-z_.]*'/i.test(seed), 'no new permission seeded');  // 2
    assert.ok(!/'[a-z_]+\.read'/.test(serviceCode), 'the service declares no permission literal of its own');  // 2
    assert.ok(!/requirePermission|reporting\.read|lineage\.read|scheduled_operation\.read|admin/.test(serviceCode),
      'no gate, no invented grant and no admin fallback');  // 2
  });

  it('3/4/5/6/7/8/9 — building scope resolves fail-closed', () => {
    const scope = scopeFn();
    // 3/4. An explicit buildingId must EXIST and be ACCESSIBLE, then becomes the whole scope.
    assert.match(scope, /if \(filters\.buildingId\) \{/, 'the explicit-building branch exists');  // 3
    assert.match(scope, /await buildingRepository\.findById\(filters\.buildingId\)/, 'existence is proved');  // 3
    assert.match(scope, /throw buildingNotFoundError\(\)/, 'a missing building is a 404, not a widening');  // 3
    assert.match(scope, /await contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\)/,
      'access is asserted for the authenticated user');  // 3
    assert.match(scope, /buildingIds: \[filters\.buildingId\]/, 'the scope is exactly that one building');  // 4
    // 5. Omitted buildingId rolls up across exactly the accessible buildings.
    assert.match(scope, /await contextAccessService\.getAccessibleBuildingIds\(\s*\n?\s*userId,?\s*\n?\s*\)/,
      'the accessible set is resolved from the authenticated user');  // 5
    assert.equal((scope.match(/getAccessibleBuildingIds/g) || []).length, 1, 'resolved once');  // 5
    // 6/7. Empty scope yields a well-formed empty envelope and never reaches the repository.
    const fn = lineageFn();
    assert.match(fn, /if \(buildingIds\.length === 0\) \{\s*\n?\s*return \{ \.\.\.base, rows: \[\] \};/,
      'an empty scope returns a well-formed empty envelope');  // 6
    assert.ok(fn.indexOf('buildingIds.length === 0') < fn.indexOf('getScheduledOperationLineageRows('),
      'the early return precedes the only repository call, so it is never queried');  // 7
    assert.ok(!/return null|return undefined/.test(fn), 'and never returns null');  // 6
    for (const key of ENVELOPE_KEYS) {
      assert.ok(fn.includes(key), `the envelope always carries ${key}`);  // 6
    }
    assert.match(fn, /buildingScope: buildingIds/, 'buildingScope is the authorized scope, not the rows');  // 6
    // 8. No NULL-building widening and no client-scope compensation anywhere in the module.
    for (const path of [SERVICE_PATH, REPO_PATH, TYPES_PATH, INDEX_PATH]) {
      const src = code(path);
      assert.ok(!/building_id IS NULL AND|client_id = ANY\(|getAccessibleClientIds/.test(src),
        `${path.split('/').pop()} never re-admits NULL-building rows`);  // 8
    }
    assert.match(serviceRaw, /NULL-BUILDING/, 'the rule is documented');  // 8
    // 9. clientId is not an accepted public filter or scope override.
    assert.ok(!/query\.clientId|filters\.clientId|clientId:/.test(serviceCode), 'no clientId is read or set');  // 9
    assert.ok(!parserFn().includes('clientId'), 'the parser never looks at it');  // 9
  });

  it('10/11/12/13/14 — exactly the eleven PART 09 filters; no taskId alias', async () => {
    const parser = parserFn();
    // 10. The contract is PART 09's, live-verified from the authoritative types module.
    const types = await import(pathToFileURL(TYPES_PATH).href);
    assert.deepEqual(Object.keys(types).filter((k) => k !== 'default'), [], 'types.ts is still runtime-free');
    const declared = fieldsOf('export type ScheduledOperationLineageFilters = {', code(TYPES_PATH));
    assert.deepEqual(declared, FROZEN_FILTERS, 'PART 09 froze exactly eleven filters');  // 10
    assert.equal(FROZEN_FILTERS.length, 11);  // 10
    const readKeys = [...parser.matchAll(/query\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(readKeys)].sort(), [...FROZEN_FILTERS].sort(),
      'the parser reads exactly those eleven keys and nothing else');  // 10
    // Unknown parameters are dropped because the result is built key by key.
    assert.ok(!/\.\.\.query|\.\.\.filters|\.\.\.rest/.test(parser), 'no spread forwards unrecognized input');  // 10
    for (const bad of FORBIDDEN_PARAMS) {
      assert.ok(!readKeys.includes(bad), `${bad} is not an accepted parameter`);  // 10/11
    }
    // 11/12. No taskId alias; generatedTaskId is the identity filter.
    assert.ok(!/taskId/.test(serviceCode), 'taskId appears nowhere in the service');  // 11
    assert.ok(!declared.includes('taskId'), 'nor in the PART 09 contract it parses into');  // 11
    assert.match(serviceRaw, /NO\s*\n?\s*\* `taskId = generatedTaskId` alias|`taskId` is NOT accepted/,
      'the rejection of a taskId alias is documented');  // 11
    assert.match(parser, /readOptionalUuid\(query\.generatedTaskId, 'generatedTaskId', details\)/,
      'generatedTaskId is the UUID-validated task identity filter');  // 12
    // 13. Every other identifier narrows only and can never create scope.
    assert.ok(!scopeFn().includes('scheduleDefinitionId') && !scopeFn().includes('generatedTaskId'),
      'scope resolution never consults a narrowing identifier');  // 13
    assert.equal((scopeFn().match(/filters\.\w+/g) || []).filter((f) => f !== 'filters.buildingId').length, 0,
      'buildingId is the only filter resolveScope reads');  // 13
    // 14. The two bindings stay separate filters; nothing merges them.
    assert.match(parser, /readOptionalUuid\(\s*\n?\s*query\.checklistExecutionId/, 'checklist binding filter');  // 14
    assert.match(parser, /readOptionalUuid\(query\.formInstanceId, 'formInstanceId', details\)/, 'form filter');  // 14
    assert.ok(!/executionId|COALESCE/.test(serviceCode), 'and no merged executionId is constructed');  // 14
    // Seven identifiers are UUID-validated; two enums; two dates. Nothing else.
    assert.equal((parser.match(/readOptionalUuid\(/g) || []).length, 7, 'seven UUID filters');  // 10
    assert.equal((parser.match(/readOptionalEnum\(/g) || []).length, 2, 'two enum filters');  // 10
    assert.equal((parser.match(/readOptionalDate\(/g) || []).length, 2, 'two date filters');  // 10
    assert.ok(!/readOptionalBoolean/.test(serviceCode), 'this contract has no boolean filter');  // 10
  });

  it('15/16 — assigneeType and status reuse existing authority, never a duplicate', async () => {
    const parser = parserFn();
    // 15. The assignment vocabulary is the owning domain's OWN runtime authority, live-checked.
    const assignment = await import(pathToFileURL(ASSIGNMENT_TYPES).href);
    assert.deepEqual([...assignment.ASSIGNEE_TYPES], ['WORKFORCE', 'TEAM'], 'the existing runtime authority');  // 15
    assert.equal(assignment.isAssigneeType('WORKFORCE'), true);  // 15
    assert.equal(assignment.isAssigneeType('EXECUTOR'), false, 'it rejects a non-vocabulary value');  // 15
    assert.match(serviceCode, /isAssigneeType,?\s*\n?\s*from '\.\.\/cleaning-assignments\/cleaning-assignment\.types'|import \{ ASSIGNEE_TYPES, isAssigneeType \} from '\.\.\/cleaning-assignments\/cleaning-assignment\.types'/,
      'the service imports that authority rather than restating it');  // 15
    assert.match(parser, /isAssigneeType,/, 'and passes the real guard to the enum reader');  // 15
    assert.ok(!/'WORKFORCE', 'TEAM'|\['WORKFORCE'/.test(serviceCode), 'no duplicate assignee vocabulary');  // 15
    // 16. Generated-task status uses a typed guard over PART 09's type authority.
    assert.match(serviceCode, /const GENERATED_TASK_STATUSES: readonly GeneratedTaskStatus\[\] = \[/,
      'the guard list is typed against PART 09 GeneratedTaskStatus, so it cannot drift');  // 16
    const listed = serviceCode.slice(serviceCode.indexOf('const GENERATED_TASK_STATUSES'));
    assert.deepEqual([...listed.slice(0, listed.indexOf('];')).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]),
      FULL_STATUSES, 'and it is the FULL persisted status domain');  // 16
    assert.match(code(TYPES_PATH), /'OPEN'\s*\n?\s*\| 'ASSIGNED'\s*\n?\s*\| 'IN_PROGRESS'\s*\n?\s*\| 'COMPLETED'\s*\n?\s*\| 'CANCELLED'/,
      'matching the PART 09 union');  // 16
    assert.match(parser, /isGeneratedTaskStatus,/, 'the parser validates through the guard');  // 16
    assert.match(parser, /readOptionalEnum\(\s*\n?\s*query\.status,/, 'status is read only through the guard');  // 16
    // The purpose-specific SUBSET constants are deliberately not reused.
    assert.ok(!/SCHEDULED_TASK_STATUSES|EXECUTABLE_TASK_STATUSES/.test(serviceCode),
      'no partial subset vocabulary is adopted');  // 16
    assert.match(serviceRaw, /deliberately NOT\s*\n?\s*\* reused/, 'and the reason is documented');  // 16
    assert.match(read(resolve(ROOT, 'src/modules/engineering-daily-operations/engineering-daily-operations.types.ts')),
      /SCHEDULED_TASK_STATUSES = \['OPEN', 'ASSIGNED'\]/, 'those subsets omit persisted statuses');  // 16
    // Status is never reinterpreted into a KPI meaning.
    for (const bad of ['Completed On Time', 'On Time', 'Late', 'Missed', 'Overdue', 'Successful', 'Failed']) {
      assert.ok(!serviceCode.includes(bad), `status is never mapped to ${bad}`);  // 16
    }
  });

  it('17/18/19/20 — date window validates only, over occurrence_at', () => {
    const parser = parserFn();
    // 17. Invalid dates are rejected, not coerced or dropped silently.
    assert.equal((parser.match(/readOptionalDate\(/g) || []).length, 2, 'both bounds are validated');  // 17
    assert.match(bodyOf('function readOptionalDate('), /Number\.isNaN\(parsed\.getTime\(\)\)/,
      'an unparseable date is detected');  // 17
    assert.match(bodyOf('function readOptionalDate('), /must be a valid ISO-8601 date or datetime/,
      'and reported as a validation error');  // 17
    assert.match(parser, /throw AppError\.validation\('Request validation failed\.', details\)/,
      'accumulated details fail the request');  // 17
    // 18. Half-open window: an equal or reversed pair is rejected, never swapped.
    assert.match(parser, /dateFrom\.getTime\(\) >= dateTo\.getTime\(\)/, 'dateFrom >= dateTo is rejected');  // 18
    assert.match(parser, /dateFrom must be earlier than dateTo\./, 'with an explicit message');  // 18
    assert.ok(!/Math\.min\(|Math\.max\(|\.sort\(|swap/i.test(parser), 'the two bounds are never reordered');  // 18
    // 19. No default reporting period is invented.
    for (const bad of ['DEFAULT_RANGE', 'defaultPeriod', 'daysBack', 'MAX_RANGE_DAYS', '30 * 24', '365 *']) {
      assert.ok(!serviceCode.includes(bad), `no ${bad}`);  // 19
    }
    assert.match(rangeFn(), /filters\.dateFrom \? new Date\(filters\.dateFrom\) : null/,
      'an omitted dateFrom stays null rather than defaulting');  // 19
    // 20. occurrence_at is the authority; a date-only dateTo covers that whole UTC day.
    assert.match(rangeFn(), /DATE_ONLY\.test\(filters\.dateTo\) \? new Date\(to\.getTime\(\) \+ 86400000\) : to/,
      'a date-only dateTo is inclusive of the whole UTC day');  // 20
    assert.match(code(REPO_PATH), /gt\.occurrence_at >= \$\$\{values\.length\}/, 'inclusive over occurrence_at');  // 20
    assert.match(code(REPO_PATH), /gt\.occurrence_at < \$\$\{values\.length\}/, 'exclusive over occurrence_at');  // 20
    assert.ok(!/createdAt|generatedAt/.test(rangeFn() + parser), 'never an alternate period semantic');  // 20
    assert.match(serviceRaw, /generated_tasks\.occurrence_at/, 'the authority PART 09 froze is documented');  // 20
  });

  it('21/22/23 — one asOf, envelope metadata only, no derivation from it', () => {
    const fn = lineageFn();
    // 21. Exactly one instant is created per invocation.
    assert.equal((fn.match(/new Date\(\)/g) || []).length, 1, 'one new Date() in the read entry point');  // 21
    assert.equal((serviceCode.match(/new Date\(\)/g) || []).length, 1, 'and one in the whole service');  // 21
    assert.equal((serviceCode.match(/new Date\(/g) || []).length, 5,
      'the other four are date parsing/normalization, never a second clock read');  // 21
    assert.ok(!/Date\.now\(|performance\.now|process\.hrtime/.test(serviceCode), 'no other clock source');  // 21
    assert.equal((fn.match(/\basOf\b/g) || []).length, 3, 'declared once, then published as the envelope value');  // 21
    // 22. asOf is NOT passed to the repository, whose signature takes no instant.
    assert.match(fn, /await getScheduledOperationLineageRows\(buildingIds, filters, start, end\)/,
      'the repository receives scope, filters and the normalized window only');  // 22
    assert.ok(!/getScheduledOperationLineageRows\([^)]*asOf/.test(serviceCode), 'asOf is never an argument');  // 22
    assert.match(code(REPO_PATH), /start: Date \| null,\s*\n?\s*end: Date \| null,\s*\n?\s*\): Promise/,
      'the PART 09 signature requires no instant');  // 22
    assert.match(fn, /asOf: asOf\.toISOString\(\)/, 'it is published as envelope metadata');  // 22
    assert.ok(!/asOf\.getTime\(\)|asOf -|- asOf|EXTRACT/.test(serviceCode), 'and no fact is computed from it');  // 22
    // 23. Zero missed/overdue/lateness derivation anywhere in the service.
    for (const bad of ['missed', 'overdue', 'dueBefore', 'graceMinutes', 'isLate', 'onTime', 'compliance',
      'occurrenceAt <', 'occurrenceAt >', 'elapsed']) {
      assert.ok(!serviceCode.toLowerCase().includes(bad.toLowerCase()), `no ${bad} derivation`);  // 23
    }
    assert.ok(!/occurrenceAt/.test(serviceCode), 'the service never touches occurrence values at all');  // 23
    assert.match(serviceRaw, /no missed\/overdue\s*\n?\s*\* calculation/, 'the prohibition is documented');  // 23
    assert.match(serviceRaw, /never\s*\n?\s*\* treated as permission to derive one/,
      'asOf is explicitly not a licence to derive one');  // 23
  });

  it('24/25/26/27/28 — one repository call; rows returned verbatim', () => {
    const fn = lineageFn();
    // 24. Exactly one call site for a non-empty scope.
    assert.equal((serviceCode.match(/getScheduledOperationLineageRows\(/g) || []).length, 1,
      'the repository is invoked from exactly one place');  // 24
    assert.match(fn, /const rows = await getScheduledOperationLineageRows\(buildingIds, filters, start, end\);/,
      'with the authorized scope and the normalized PART 09 filters');  // 24
    assert.ok(!/getScheduledOperationLineageRows\(.*\).*getScheduledOperationLineageRows\(/s.test(serviceCode),
      'never called twice or in a loop');  // 24
    assert.ok(!/for \(|while \(|Promise\.all/.test(fn), 'no iteration or fan-out around the read');  // 24
    // 25/26. Rows are the repository's output verbatim.
    assert.match(fn, /return \{ \.\.\.base, rows \};/, 'the rows are returned untouched');  // 25
    assert.ok(!/rows\.map\(|rows\.filter\(|rows\.slice\(|rows\.reduce\(|rows\.flatMap\(/.test(serviceCode),
      'never post-filtered, projected or reshaped');  // 25
    assert.ok(!/new Set\(|new Map\(|DISTINCT|dedup|groupBy|\.sort\(/.test(serviceCode),
      'never collapsed, deduplicated or grouped');  // 26
    assert.ok(!/checklistExecutionId|formInstanceId/.test(fn), 'and the two bindings are never merged here');  // 26
    // 27. No business re-sorting: the repository's deterministic order is preserved.
    assert.ok(!/localeCompare|orderBy|sortBy/.test(serviceCode), 'no ordering is imposed by the service');  // 27
    assert.match(code(REPO_PATH), /ORDER BY gt\.occurrence_at ASC, gt\.id ASC/, 'the repository owns ordering');  // 27
    // 28. No assignment selection and no executor transformation.
    for (const bad of ['executor', 'executedBy', 'performedBy', 'completedBy', 'assignee', 'assignedWorkforce',
      'assignedTeam']) {
      assert.ok(!fn.toLowerCase().includes(bad.toLowerCase()), `the read path never transforms ${bad}`);  // 28
    }
    assert.ok(!/task_assignments|assignee_type|workforce_profile/.test(serviceCode),
      'the service contains no assignment selection rule');  // 28
    assert.match(serviceRaw, /no executor inference/i, 'the boundary is documented');  // 28
  });

  it('29/30 — minimal index surface; nothing else wired', async () => {
    // 29. The index exports the service entry points and the public types only.
    const exported = [...indexRaw.matchAll(/^\s{2}(\w+),$/gm)].map((m) => m[1]);
    for (const sym of ['getScheduledOperationLineage', 'parseScheduledOperationLineageQuery',
      'scheduledOperationLineageRange', 'scheduledOperationLineageService']) {
      assert.ok(exported.includes(sym), `the index exports ${sym}`);  // 29
    }
    for (const type of ['PublicScheduledOperationLineage', 'PublicScheduledOperationLineageRow',
      'ScheduledOperationLineageFilters', 'GeneratedTaskStatus']) {
      assert.ok(exported.includes(type), `the index exports the public type ${type}`);  // 29
    }
    assert.ok(!indexRaw.includes('getScheduledOperationLineageRows'), 'the repository is NOT re-exported');  // 29
    assert.ok(!/export \*|from '\.\.\/\.\.\/database'|require\(/.test(indexRaw), 'no wildcard or db re-export');  // 29
    assert.ok(!/export type \{[^}]*AssigneeType/.test(indexRaw), 'the borrowed AssigneeType is not re-exported');  // 29
    assert.match(indexRaw, /`AssigneeType` is likewise NOT re-exported/, 'and the reason is documented');  // 29
    assert.ok(!/ValidationDetail/.test(indexRaw), 'the internal validation detail type stays internal');  // 29
    assert.deepEqual(readdirSync(MODULE_DIR).sort(), ['index.ts', 'scheduled-operation-lineage.repository.ts',
      'scheduled-operation-lineage.service.ts', 'scheduled-operation-lineage.types.ts'],
      'exactly four module files');  // 29
    assert.match(indexRaw, /No route, controller, permission, Reporting dataset enum entry, registry adapter/,
      'the index states what it does not add');  // 29
    // The exported service surface is exactly what the service declares.
    const serviceExports = [...serviceCode.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(serviceExports.sort(), ['getScheduledOperationLineage', 'parseScheduledOperationLineageQuery',
      'scheduledOperationLineageRange', 'scheduledOperationLineageService'], 'no unintended service export');  // 29
    // 30. No registry, OpenAPI, route, controller, permission or migration surface.
    const exportTypes = await import(pathToFileURL(EXPORT_TYPES).href);
    assert.equal(exportTypes.REPORTING_EXPORT_DATASETS.length, 14, 'the dataset enum is still 14');  // 30
    assert.ok(![...exportTypes.REPORTING_EXPORT_DATASETS].some((d) => /LINEAGE|SCHEDULED_OPERATION/i.test(d)),
      'no lineage dataset was registered');  // 30
    assert.ok(!code(EXPORT_REGISTRY).includes('scheduled-operation-lineage'), 'the registry does not import it');  // 30
    assert.ok(!/ScheduledOperationLineage|scheduledOperationLineage/.test(read(OPENAPI_PATH)),
      'OpenAPI is unchanged');  // 30
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => /scheduled_operation/i.test(f)), 'no migration added');  // 30
    for (const file of readdirSync(ARCHIVE_DIR)) {
      assert.ok(!/scheduledOperationLineage|SCHEDULED_OPERATION_LINEAGE/.test(code(resolve(ARCHIVE_DIR, file))),
        `${file} gains no lineage branch`);  // 30
    }
    assert.ok(!/from 'express'|Router\(|requirePermission\(|import type \{ Request|\bResponse\b/.test(serviceCode),
      'no HTTP surface in this PART');  // 30
    assert.ok(!/scheduled-operation-lineage/.test(read(resolve(ROOT, 'src/app.ts'))), 'not wired into the app');  // 30
  });
});

/** Field names of a type block, in declaration order (block starts AT the declaration). */
function fieldsOf(decl: string, src: string): string[] {
  const at = src.indexOf(decl);
  assert.ok(at >= 0, `${decl} must exist`);
  const b = src.slice(at);
  return [...b.slice(b.indexOf('{') + 1, b.indexOf('\n}')).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}
