import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 07 — Work Order SLA Register SERVICE + INDEX: focused validation.
 *
 * PART 07 completes the module with service.ts and index.ts and wires nothing else:
 * no route, controller, permission, Reporting dataset enum entry, registry adapter,
 * OpenAPI surface or migration. The PART 06 types and repository stay authoritative
 * and byte-unchanged.
 *
 * The service imports the repository, which imports `getPool` (`pg`), so it is NOT
 * live-importable and is asserted statically against comment-stripped source, scoped
 * per function so one helper cannot satisfy another's proof. The runtime-free
 * authorities it reuses (`sla-escalation-action.types`, `work-order-sla-register.types`)
 * ARE asserted live via dynamic import — the R08 PART 01B / R10 PART 03 convention.
 * Paths resolve from process.cwd() for `tsx --test` and `node --test` alike.
 *
 * Proofs: 1 work_order.read context pattern · 2 explicit buildingId asserts access ·
 * 3 explicit buildingId scopes to exactly it · 4 omitted uses accessible ids ·
 * 5 empty scope returns a well-formed empty register · 6 repository not called then ·
 * 7 workOrderId narrowing only · 8 no clientId scope override · 9 exactly 12 filters ·
 * 10 unknown filters dropped · 11 clockType authority · 12 clockStatus authority ·
 * 13 escalationStatus authority · 14 breached boolean · 15 paused boolean ·
 * 16 invalid dates rejected · 17 dateFrom >= dateTo rejected · 18 no default period ·
 * 19 one asOf per call · 20 repository gets the envelope asOf · 21 one repository
 * call · 22 rows verbatim · 23 no SLA recomputation · 24 no clock collapse ·
 * 25 no business sort · 26 minimal index surface · 27 nothing else wired.  */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/work-order-sla-register');
const SERVICE_PATH = resolve(MODULE_DIR, 'work-order-sla-register.service.ts');
const INDEX_PATH = resolve(MODULE_DIR, 'index.ts');
const TYPES_PATH = resolve(MODULE_DIR, 'work-order-sla-register.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'work-order-sla-register.repository.ts');
const ESCALATION_TYPES = resolve(ROOT, 'src/modules/sla-escalation-actions/sla-escalation-action.types.ts');
const POLICY_TYPES = resolve(ROOT, 'src/modules/sla-escalation-policies/sla-escalation-policy.types.ts');
const SLA_DOMAIN_TYPES = resolve(ROOT, 'src/modules/applied-slas/applied-sla.types.ts');
const ACCESS_SEED = resolve(ROOT, 'src/database/seeds/foundation-access.seed.ts');
const EXPORT_REGISTRY = resolve(ROOT, 'src/modules/reporting-export/reporting-export.registry.ts');
const EXPORT_TYPES = resolve(ROOT, 'src/modules/reporting-export/reporting-export.types.ts');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ARCHIVE_DIR = resolve(ROOT, 'src/modules/reporting-archives');

/** The twelve filters PART 06 froze — the service may read exactly these. */
const FROZEN_FILTERS = ['buildingId', 'workOrderId', 'clockType', 'clockStatus', 'breached', 'paused',
  'escalationStatus', 'definitionCode', 'workType', 'priority', 'dateFrom', 'dateTo'];
/** Parameters that must never exist on this register. */
const FORBIDDEN_PARAMS = ['clientId', 'operationalType', 'approachingBreach', 'severity', 'daysOverdue',
  'page', 'limit', 'offset', 'sort', 'search', 'sortBy', 'orderBy', 'pageSize'];
/** Coercions that would weaken the boolean or date rules. */
const COERCIONS = ["=== '1'", "=== 'yes'", "=== 'on'", '!!', 'parseInt(', 'Number(raw', '? true : false'];
const ENVELOPE_KEYS = ['buildingId', 'buildingScope', 'dateFrom', 'dateTo', 'asOf', 'rows'];

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
const registerFn = () => bodyOf('export async function getWorkOrderSlaRegister(');
const scopeFn = () => bodyOf('async function resolveScope(');
const parserFn = () => bodyOf('export function parseWorkOrderSlaRegisterQuery(');

const escalationModule = async () => import(pathToFileURL(ESCALATION_TYPES).href);
const typesModule = async () => import(pathToFileURL(TYPES_PATH).href);

describe('R10 PART 07 — Work Order SLA Register service and index', () => {
  it('1/27 — existing work_order.read context pattern; no HTTP surface of its own', () => {
    // 1. The service applies the shared context-access pattern with the caller's userId.
    assert.match(serviceCode, /import \{ contextAccessService \} from '\.\.\/context-access';/);
    assert.match(scopeFn(), /contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\)/);
    assert.match(scopeFn(), /contextAccessService\.getAccessibleBuildingIds\(\s*\n?\s*userId,?\s*\n?\s*\)/);
    assert.match(serviceCode, /userId: string/, 'the authenticated user drives scope');
    // The authoritative permission is the EXISTING work_order.read, documented for the
    // later route/registry layer; no gate is declared here and none is invented.
    assert.match(serviceRaw, /`work_order\.read`/, 'the existing permission authority is named');
    assert.match(read(ACCESS_SEED), /code: 'work_order\.read'/, 'it already exists in the access seed');
    assert.ok(!/requirePermission|sla\.read|reporting\.read|admin/.test(serviceCode),
      'no route gate, no alternative or admin-only permission');
    assert.ok(!/'[a-z_]+\.read'/.test(serviceCode), 'the service declares no permission literal of its own');
    // 27. No route, controller, registry, OpenAPI, permission or migration surface.
    assert.deepEqual(readdirSync(MODULE_DIR).sort(), ['index.ts', 'work-order-sla-register.repository.ts',
      'work-order-sla-register.service.ts', 'work-order-sla-register.types.ts'], 'exactly four module files');
    // Precise markers only: the literal 'Request validation failed.' is not an HTTP surface.
    assert.ok(!/from 'express'|Router\(|create\w*Router|requirePermission|import type \{ Request|\bResponse\b/
      .test(serviceCode + code(INDEX_PATH)), 'no HTTP surface in this PART');
    // PART 07 added no wiring of its own. R10 PART 08 later registered this module as
    // the WORK_ORDER_SLA dataset, and it does so strictly through the public index the
    // PART 07 surface published — so those two phase-scoped "not yet wired" guards are
    // restated here as the wiring PART 08 is required to have.
    assert.match(code(EXPORT_REGISTRY), /from '\.\.\/work-order-sla-register';/,
      'PART 08 reaches the register through its public index');
    assert.ok(!code(EXPORT_REGISTRY).includes('work-order-sla-register.repository'),
      'and never through the repository');
    assert.equal((code(EXPORT_REGISTRY).match(/getWorkOrderSlaRegister\(/g) || []).length, 1,
      'calling the published service exactly once');
    assert.match(read(OPENAPI_PATH), /WORK_ORDER_SLA/, 'PART 08 documents the dataset in OpenAPI');
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => /work_order_sla|sla_register/i.test(f)), 'no migration');
    for (const file of readdirSync(ARCHIVE_DIR)) {
      assert.ok(!code(resolve(ARCHIVE_DIR, file)).includes('workOrderSla'), `${file} gains no branch`);
    }
  });

  it('2/3/4/5/6 — building scope resolves fail-closed', () => {
    const scope = scopeFn();
    // 2. An explicit buildingId must EXIST and be ACCESSIBLE before it narrows anything.
    assert.match(scope, /buildingRepository\.findById\(filters\.buildingId\)/, 'existence-checked');  // 2
    assert.match(scope, /throw buildingNotFoundError\(\)/, 'a missing building is a 404, not a silent pass');
    assert.match(scope, /assertBuildingAccess\(userId, filters\.buildingId\)/, 'access-asserted');  // 2
    assert.ok(scope.indexOf('findById') < scope.indexOf('assertBuildingAccess'), 'existence precedes access');
    // 3. It then becomes the ENTIRE repository scope — exactly one building.
    assert.match(scope, /buildingIds: \[filters\.buildingId\]/, 'scope is exactly the asserted building');  // 3
    // 4. Omitted means the caller's own accessible set, and nothing wider.
    assert.match(scope, /getAccessibleBuildingIds\(/, 'the accessible set is the fallback scope');  // 4
    assert.equal((scope.match(/buildingIds/g) || []).length, 4, 'no third scope path exists');
    assert.ok(!/buildingIds:\s*\[\]|buildingIds\.push|concat\(/.test(scope), 'scope is never widened or emptied');
    // 5/6. An empty authorized scope returns a well-formed empty register, unqueried.
    const register = registerFn();
    assert.match(register, /if \(buildingIds\.length === 0\) \{\s*\n?\s*return \{ \.\.\.base, rows: \[\] \};/,
      'empty scope yields an empty register, not null and not a 403');  // 5
    const emptyAt = register.indexOf('if (buildingIds.length === 0)');
    const callAt = register.indexOf('getWorkOrderSlaRegisterRows(');
    assert.ok(emptyAt >= 0 && callAt > emptyAt, 'the early return precedes the repository call');  // 6
    // The envelope is well-formed in both paths: one shared base, rows appended.
    assert.match(register, /const base = \{/, 'a single base shape serves both paths');
    for (const key of ENVELOPE_KEYS.slice(0, 5)) {
      assert.match(register, new RegExp(`${key}:`), `the base carries ${key}`);
    }
    assert.equal((register.match(/return \{ \.\.\.base, rows/g) || []).length, 2, 'both returns use that base');
    assert.ok(!/ANY\(|::uuid\[\]/.test(serviceCode), 'no raw SQL or empty-array scope is built in the service');
  });

  it('7/8 — workOrderId narrows only; clientId is never a scope override', () => {
    // 7. workOrderId is parsed as an identifier and never touches scope resolution.
    assert.match(parserFn(), /readOptionalUuid\(query\.workOrderId, 'workOrderId', details\)/,
      'validated as a UUID like every other identifier');  // 7
    assert.ok(!/workOrderId/.test(scopeFn()), 'scope resolution never reads workOrderId');  // 7
    const register = registerFn();
    assert.ok(!/workOrderId/.test(register), 'the envelope and scope never depend on it either');
    assert.match(register, /buildingScope: buildingIds/, 'scope comes only from resolved buildings');
    assert.ok(!/buildingIds:\s*\[filters\.workOrderId|assertBuildingAccess\(userId, filters\.workOrderId\)/
      .test(serviceCode), 'a Work Order can never create or widen building authority');
    // 8. No caller-provided clientId is read, echoed or used as scope.
    assert.ok(!/clientId/.test(serviceCode), 'the service never reads or forwards a clientId');  // 8
    assert.ok(!/query\.clientId/.test(serviceRaw), 'not even in a comment-documented parameter');
    assert.ok(!/clientId/.test(code(TYPES_PATH).slice(code(TYPES_PATH).indexOf('WorkOrderSlaRegisterFilters'))
      .split('};')[0]), 'and it is not part of the PART 06 filter contract');
    assert.match(code(REPO_PATH), /a\.client_id AS client_id/, 'client scope stays a structural row fact');
  });

  it('9/10 — exactly the twelve frozen filters; unknown parameters are dropped', () => {
    const parser = parserFn();
    // 9. The set of query keys read is exactly the PART 06 frozen contract.
    const readKeys = [...parser.matchAll(/query\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(readKeys)].sort(), [...FROZEN_FILTERS].sort(), 'exactly the frozen twelve');  // 9
    assert.equal(FROZEN_FILTERS.length, 12);
    assert.equal(new Set(readKeys).size, 12, 'no filter is read twice under another name');
    // 10. The result is built key by key, so an unknown parameter cannot be forwarded.
    assert.ok(!/\.\.\.query|\.\.\.rest|Object\.assign\(\{\}, query/.test(serviceCode),
      'no query object is ever spread into the filters');  // 10
    const returned = [...parser.slice(parser.indexOf('return {')).matchAll(/\{ (\w+)(?::| \})/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(returned)].sort(), [...FROZEN_FILTERS].sort(),
      'and exactly those twelve keys are returned');
    for (const bad of FORBIDDEN_PARAMS) {
      assert.ok(!new RegExp(`query\\.${bad}\\b`).test(serviceRaw), `${bad} is not a supported parameter`);  // 9
    }
    assert.ok(!/page|limit|offset/.test(parser), 'no pagination is parsed here or plumbed to the repository');
    // The PART 06 contract itself is unchanged and still declares exactly twelve.
    const typesCode = code(TYPES_PATH);
    const filterBody = typesCode.slice(typesCode.indexOf('export type WorkOrderSlaRegisterFilters = {'));
    assert.deepEqual([...filterBody.slice(0, filterBody.indexOf('\n}')).matchAll(/^\s*(\w+)\??:/gm)]
      .map((m) => m[1]).sort(), [...FROZEN_FILTERS].sort(), 'the frozen contract is intact');
  });

  it('11/12/13 — enum filters reuse existing vocabulary authority', async () => {
    const escalation = await escalationModule();
    // 11/12. No runtime clock authority exists, so minimal guards are TYPED against the
    // owning domain's types and cannot drift — the R08 EXECUTION_REVIEW_CHILD_STATUSES precedent.
    assert.match(read(SLA_DOMAIN_TYPES), /export type SlaClockType='RESPONSE'\|'RESOLUTION'/, 'the type authority');
    assert.match(read(SLA_DOMAIN_TYPES), /export type SlaClockStatus='RUNNING'\|'SATISFIED'\|'TERMINATED'/);
    assert.match(serviceCode, /import type \{ SlaClockStatus, SlaClockType \} from '\.\.\/applied-slas\/applied-sla\.types';/);
    assert.match(serviceCode, /const CLOCK_TYPES: readonly SlaClockType\[\] = \['RESPONSE', 'RESOLUTION'\];/,
      'clockType is bound to the authority type');  // 11
    assert.match(serviceCode, /const CLOCK_STATUSES: readonly SlaClockStatus\[\] = \['RUNNING', 'SATISFIED', 'TERMINATED'\];/);  // 12
    assert.match(serviceCode, /function isSlaClockType\(value: unknown\): value is SlaClockType/);  // 11
    assert.match(serviceCode, /function isSlaClockStatus\(value: unknown\): value is SlaClockStatus/);  // 12
    assert.match(parserFn(), /isSlaClockType/, 'the parser validates through the guard');
    assert.match(parserFn(), /isSlaClockStatus/);
    // The escalation-POLICY vocabulary additionally contains 'ANY' and must not be used.
    assert.match(read(POLICY_TYPES), /SLA_ESCALATION_CLOCK_TYPES = \['RESPONSE', 'RESOLUTION', 'ANY'\]/);
    assert.ok(!/SLA_ESCALATION_CLOCK_TYPES/.test(serviceCode),
      'the policy vocabulary, which allows ANY, is never used for a clock filter');  // 11
    // 13. Escalation status reuses the ledger's OWN runtime array — nothing restated.
    assert.deepEqual([...escalation.SLA_ESCALATION_ACTION_STATUSES], ['PENDING', 'TRIGGERED', 'CANCELLED', 'SKIPPED']);
    assert.match(serviceCode, /SLA_ESCALATION_ACTION_STATUSES,/, 'the runtime authority is imported');  // 13
    assert.match(serviceCode, /\(SLA_ESCALATION_ACTION_STATUSES as readonly string\[\]\)\.includes\(value\)/,
      'and used directly as the membership test');
    assert.ok(!/'PENDING',\s*'TRIGGERED'|'TRIGGERED',\s*'CANCELLED'/.test(serviceCode),
      'the escalation vocabulary is never copied');  // 13
    // All three normalize and reject rather than reinterpret.
    assert.match(serviceCode, /const normalized = raw\.trim\(\)\.toUpperCase\(\);/, 'upper-cased like the sibling registers');
    assert.equal((parserFn().match(/readOptionalEnum\(/g) || []).length, 3, 'exactly three enum filters');
    const mod = await typesModule();
    assert.deepEqual(Object.keys(mod).filter((k) => k !== 'default'), [], 'types.ts stays type-only');
  });

  it('14/15/16/17/18 — booleans are strict; dates are validated, never defaulted', () => {
    const parser = parserFn();
    // 14/15. Only true/false, via the Reporting query convention; no loose coercion.
    assert.match(serviceCode, /function readOptionalBoolean\(/, 'a dedicated strict boolean reader');
    assert.match(serviceCode, /if \(raw === 'true'\) return true;\s*\n?\s*if \(raw === 'false'\) return false;/,
      'exactly the two wire forms of a real boolean are accepted');  // 14
    assert.match(serviceCode, /message: `\$\{field\} must be true or false\.`/, 'anything else is a validation error');
    assert.equal((parser.match(/readOptionalBoolean\(/g) || []).length, 2, 'breached and paused both use it');
    assert.match(parser, /readOptionalBoolean\(query\.breached, 'breached', details\)/);  // 14
    assert.match(parser, /readOptionalBoolean\(query\.paused, 'paused', details\)/);  // 15
    for (const bad of COERCIONS) assert.ok(!serviceCode.includes(bad), `no "${bad}" coercion anywhere`);
    // A bare 'Boolean(' scan would hit the helper's own NAME, so target coercion USES.
    assert.ok(!/(?<!readOptional)Boolean\(/.test(serviceCode),
      'no Boolean() coercion of an arbitrary value (the helper name itself is excluded)');
    assert.match(serviceCode, /typeof filters\.breached === 'boolean'|breached === undefined \? \{\} : \{ breached \}/,
      'a parsed boolean is forwarded only when present');
    // 16. Invalid dates are rejected, not dropped or defaulted.
    assert.match(serviceCode, /Number\.isNaN\(parsed\.getTime\(\)\)/, 'an unparseable date is detected');  // 16
    assert.match(serviceCode, /must be a valid ISO-8601 date or datetime\./);
    assert.equal((parser.match(/readOptionalDate\(/g) || []).length, 2, 'dateFrom and dateTo are both validated');
    // 17. Half-open means dateFrom must be STRICTLY earlier; never silently swapped.
    assert.match(parser, /dateFrom\.getTime\(\) >= dateTo\.getTime\(\)/, 'equal or reversed is rejected');  // 17
    assert.match(parser, /dateFrom must be earlier than dateTo\./);
    assert.ok(!/Math\.min|Math\.max|\.sort\(|\[dateTo, dateFrom\]/.test(serviceCode), 'the pair is never swapped');
    // 18. No default reporting period and no range cap is invented.
    assert.ok(!/MAX_RANGE_DAYS|DEFAULT_RANGE|DEFAULT_DAYS|days?Ago|366|86400000 \* \d/.test(serviceCode),
      'no default window and no maximum-range rule');  // 18
    assert.match(serviceCode, /const start = filters\.dateFrom \? new Date\(filters\.dateFrom\) : null;/,
      'an omitted dateFrom stays open rather than defaulting');
    assert.match(serviceCode, /DATE_ONLY\.test\(filters\.dateTo\)\s*\n?\s*\? new Date\(to\.getTime\(\) \+ 86400000\)\s*\n?\s*: to;/,
      'a date-only dateTo covers that whole UTC day, keeping the window half-open');
    assert.match(parser, /details\.push/, 'violations accumulate');
    assert.match(parser, /throw AppError\.validation\('Request validation failed\.', details\)/,
      'and are thrown together, so nothing invalid reaches the repository');
  });

  it('19/20/21/22 — one frozen asOf, one repository call, rows verbatim', () => {
    const register = registerFn();
    // 19. Exactly one clock read in the whole service, inside the register call.
    assert.equal((register.match(/new Date\(\)/g) || []).length, 1, 'one frozen asOf per service call');  // 19
    assert.equal((serviceCode.match(/new Date\(\)/g) || []).length, 1, 'and nowhere else in the service');
    assert.match(register, /const asOf = new Date\(\);/);
    assert.ok(!/Date\.now\(\)|new Date\(\)\.getTime\(\)|process\.hrtime/.test(serviceCode), 'no second clock source');
    // 20. The repository receives that exact instant and the envelope publishes it.
    assert.match(register, /getWorkOrderSlaRegisterRows\(buildingIds, filters, start, end, asOf\)/,
      'the same asOf is handed to the repository, as the fifth argument');  // 20
    assert.match(register, /asOf: asOf\.toISOString\(\)/, 'and published verbatim in the envelope');  // 20
    assert.equal((register.match(/asOf\.toISOString\(\)/g) || []).length, 1, 'serialized once, from that instant');
    assert.equal((register.match(/\basOf\b/g) || []).length, 4,
      'declared once, published as the envelope key and value, passed once — never re-read');
    // 21. Exactly one call site, after the fail-closed early return.
    assert.equal((serviceCode.match(/getWorkOrderSlaRegisterRows\(/g) || []).length, 1, 'called exactly once');  // 21
    assert.ok(!/while|for \(|\.map\(async|Promise\.all/.test(register), 'no loop or fan-out around that call');
    // 22. Rows are the repository's output verbatim.
    assert.match(register, /const rows = await getWorkOrderSlaRegisterRows\(/);
    assert.match(register, /return \{ \.\.\.base, rows \};\s*$/, 'returned unchanged');  // 22
    assert.ok(!/rows\.(map|filter|sort|slice|splice|reduce|forEach)\(/.test(serviceCode),
      'rows are never transformed in the service');  // 22
    assert.ok(!/rows\./.test(register.replace('rows: []', '').replace('{ ...base, rows }', '')),
      'no row-level access at all');
  });

  it('23/24/25 — no SLA recomputation, no clock collapse, no business sort', () => {
    // 23. The service performs no SLA arithmetic and derives no breach/pause/elapsed fact.
    for (const forbidden of ['breachedAt', 'effectiveElapsedMilliseconds', 'totalPausedMilliseconds',
      'pauseCount', 'isPaused', 'targetMinutes', 'escalationCount', 'latestEscalation']) {
      assert.ok(!serviceCode.includes(forbidden), `${forbidden} is never computed or assigned in the service`);  // 23
    }
    assert.ok(!/\*\s*1000|\*\s*60000|EXTRACT\(|GREATEST\(|FLOOR\(/.test(serviceCode), 'no elapsed arithmetic');
    // The `breached` / `paused` FILTERS are legitimate here; deriving breach or pause
    // STATE is not. So assert on derivation shapes, not on the words themselves.
    assert.ok(!/approaching|isBreached|breachedAt\s*[:=]|deriveBreach|computeBreach|breachThreshold/
      .test(serviceCode), 'no breach is derived, and no approaching-breach rule exists');  // 23
    assert.ok(!/paused_at|resumed_at|pause_interval|sla_clock_pause/i.test(serviceCode),
      'no pause interval fact is computed here');  // 23
    assert.ok(!/SELECT|FROM |JOIN /.test(serviceCode), 'the service issues no SQL');
    // 24. Clocks are never collapsed: no grouping, deduplication or per-Work-Order pick.
    for (const bad of ['GROUP BY', 'DISTINCT', 'groupBy', 'reduce(', 'new Map(', 'find(', 'findIndex(',
      'workOrderId]', 'byWorkOrder', 'primaryClock', 'latestClock']) {
      assert.ok(!serviceCode.includes(bad), `"${bad}" would collapse or prefer a clock`);  // 24
    }
    // 25. No post-query ordering for business meaning; the repository's order stands.
    assert.ok(!/\.sort\(|localeCompare|orderBy|sortBy/.test(serviceCode), 'no service-level sort');  // 25
    assert.ok(!/ORDER BY/.test(serviceCode), 'and no ordering SQL');
    assert.match(code(REPO_PATH), /ORDER BY a\.applied_at ASC, a\.work_order_id ASC, c\.clock_type ASC, c\.id ASC/,
      'the deterministic order remains the repository\'s alone');
  });

  it('26 — index exports the intended public surface only', () => {
    const exported = [...indexRaw.matchAll(/export \{([\s\S]*?)\} from/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    const exportedTypes = [...indexRaw.matchAll(/export type \{([\s\S]*?)\} from/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    assert.deepEqual(exported.sort(), ['getWorkOrderSlaRegister', 'parseWorkOrderSlaRegisterQuery',
      'workOrderSlaRegisterRange', 'workOrderSlaRegisterService'], 'the service entry points');  // 26
    assert.deepEqual(exportedTypes.sort(), ['PublicWorkOrderSlaRegister', 'PublicWorkOrderSlaRow',
      'WorkOrderSlaRegisterFilters'], 'and the public types');  // 26
    assert.equal((indexRaw.match(/from '\.\/work-order-sla-register\.service'/g) || []).length, 1);
    assert.equal((indexRaw.match(/from '\.\/work-order-sla-register\.types'/g) || []).length, 1);
    // The repository stays internal: exporting the row reader would invite a call that
    // bypasses the fail-closed scope resolved by the service.
    assert.ok(!indexRaw.includes('work-order-sla-register.repository'), 'the repository is not re-exported');  // 26
    assert.ok(!/getWorkOrderSlaRegisterRows/.test(indexRaw), 'nor is its row reader');
    assert.ok(!/Router|createWorkOrderSla|routes|controller|requirePermission/.test(code(INDEX_PATH)),
      'no route or controller export');  // 26
    assert.equal((indexRaw.match(/^export /gm) || []).length, 2, 'exactly two export statements');
    // Every exported symbol really exists in the service source.
    for (const name of exported) {
      assert.ok(new RegExp(`(export (async )?function ${name}|export const ${name})`).test(serviceCode),
        `${name} is exported by the service`);
    }
    // PART 06 production files are untouched by this PART.
    assert.match(code(REPO_PATH), /CASE WHEN c\.clock_type = 'RESOLUTION'/, 'FIX 01 guard still present');
    assert.match(code(REPO_PATH), /a\.building_id = ANY\(\$1::uuid\[\]\)/, 'the scope bridge still present');
  });
});
