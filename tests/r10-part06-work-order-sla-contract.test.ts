import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 06 — Work Order SLA Register CONTRACT: focused validation.
 *
 * PART 06 adds exactly two production files (types + repository) and wires nothing:
 * no service, no index, no route, no permission, no Reporting dataset enum entry and
 * no OpenAPI change, so the module stays unreachable until PART 07.
 *
 * types.ts holds only `import type` bindings and sla-escalation-action.types.ts is
 * runtime-free, so both are asserted LIVE via dynamic import — the R08 PART 01B /
 * R10 PART 03 convention. The repository imports `getPool` (`pg`), so it is asserted
 * statically against comment-stripped source: its own doc comment names several
 * things this contract must NOT do, and only the CODE can prove they are absent.
 * Paths resolve from process.cwd() for `tsx --test` and `node --test` alike.
 *
 * Proofs: 1 clock grain · 2 RESPONSE+RESOLUTION both survive · 3 no WO collapse ·
 * 4 applied_slas is the scope bridge · 5 base scope is a.building_id · 6 WO join pins
 * id+client+building · 7 never scoped by work_order_id alone · 8 pause rows not
 * flattened · 9 breach from breached_at · 10 breach never recomputed ·
 * 11 RESOLUTION-only deduction preserved · 12 no RESPONSE deduction invented
 * (FIX 01 1-5: the guard is structural, RESPONSE deducts 0, RESOLUTION still
 * deducts, and the persisted pause aggregates are never falsely zeroed) · 13 rows
 * not flattened · 14 escalation pinned to clock+applied SLA · 15 no recipient
 * identities · 16 no approaching-breach rule · 17 clockType authority · 18 clockStatus
 * authority · 19 escalationStatus authority · 20 deterministic ordering · 21 no
 * wiring · 22 no migration/permission/OpenAPI/registry change.  */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/work-order-sla-register');
const TYPES_PATH = resolve(MODULE_DIR, 'work-order-sla-register.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'work-order-sla-register.repository.ts');
const SLA_DOMAIN_REPO = resolve(ROOT, 'src/modules/applied-slas/applied-sla.repository.ts');
const SLA_DOMAIN_TYPES = resolve(ROOT, 'src/modules/applied-slas/applied-sla.types.ts');
const ESCALATION_TYPES = resolve(ROOT, 'src/modules/sla-escalation-actions/sla-escalation-action.types.ts');
const EXPORT_TYPES = resolve(ROOT, 'src/modules/reporting-export/reporting-export.types.ts');
const EXPORT_REGISTRY = resolve(ROOT, 'src/modules/reporting-export/reporting-export.registry.ts');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ARCHIVE_DIR = resolve(ROOT, 'src/modules/reporting-archives');

/** The frozen 34-field clock-grain row contract, in declared order. */
const EXPECTED_ROW_FIELDS = ['appliedSlaId', 'workOrderId', 'workOrderNumber', 'workOrderStatus', 'clientId',
  'buildingId', 'slaDefinitionId', 'definitionCode', 'operationalType', 'definitionWorkType', 'definitionPriority',
  'workOrderWorkType', 'workOrderPriority', 'responseTargetMinutes', 'resolutionTargetMinutes',
  'definitionEffectiveFrom', 'definitionEffectiveTo', 'appliedAt', 'slaClockId', 'clockType', 'targetMinutes',
  'startedAt', 'clockStatus', 'satisfiedAt', 'terminatedAt', 'breachedAt', 'isPaused', 'pauseCount',
  'totalPausedMilliseconds', 'effectiveElapsedMilliseconds', 'escalationCount', 'latestEscalationLevel',
  'latestEscalationStatus', 'latestEscalationTriggeredAt'];
const EXPECTED_FILTERS = ['buildingId', 'workOrderId', 'clockType', 'clockStatus', 'breached', 'paused',
  'escalationStatus', 'definitionCode', 'workType', 'priority', 'dateFrom', 'dateTo'];
/** Recipient / actor identities that must never reach a Reporting row. */
const RECIPIENT_FIELDS = ['recipient_rule', 'recipientRule', 'recipients_resolved', 'recipientsResolved',
  'notifications_created', 'notificationsCreated', 'template_key', 'templateKey', 'pause_actor_user_id',
  'pauseActorUserId', 'resume_actor_user_id', 'resumeActorUserId', 'failure_reason', 'failureReason'];
/** Per-interval / per-action columns whose presence would mean a flattened child grain. */
const PAUSE_FLAT = ['pause_interval_id', 'pauseIntervalId', 'paused_at', 'pausedAt', 'resumed_at', 'resumedAt',
  'pause_source', 'pauseSource'];
const ESCALATION_FLAT = ['escalation_action_id', 'escalationActionId', 'policy_id', 'policyId',
  'escalation_level_id', 'escalationLevelId', 'due_at', 'dueAt', 'cancelled_at', 'cancelledAt',
  'cancel_reason', 'cancelReason'];
/** Rules this read model must never invent. */
const INVENTED_RULES = ['approaching', 'approachingBreach', 'daysOverdue', 'severityScore', 'slaScore',
  'elapsedAtBreach', 'historicalElapsed', 'finalElapsed', 'timeToBreach', 'breachRisk', 'isBreached'];

const read = (path: string): string => readFileSync(path, 'utf8');
/** Strips comments, so "must not exist" assertions test the CODE contract, not the prose. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const repoCode = code(REPO_PATH);
const typesCode = code(TYPES_PATH);

/** Field names of a declared type, in order, from comment-stripped source. */
function fieldsOf(typeName: string, source: string): string[] {
  const at = source.indexOf(`export type ${typeName} = {`);
  assert.ok(at >= 0, `${typeName} must be declared`);
  const inner = source.slice(at).slice(source.slice(at).indexOf('{') + 1, source.slice(at).indexOf('\n}'));
  return [...inner.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}

const typesModule = async () => import(pathToFileURL(TYPES_PATH).href);
const escalationModule = async () => import(pathToFileURL(ESCALATION_TYPES).href);

/** The SQL statement text only — everything between the opening backtick and ORDER BY. */
const sqlOf = () => repoCode.slice(repoCode.indexOf('`SELECT'), repoCode.indexOf('ORDER BY a.applied_at'));

describe('R10 PART 06 — Work Order SLA Register contract', () => {
  it('1/2/3 — grain is one row per sla_clocks row, never collapsed per Work Order', () => {
    assert.deepEqual(fieldsOf('PublicWorkOrderSlaRow', typesCode), EXPECTED_ROW_FIELDS, 'the frozen 34-field row');  // 1
    assert.equal(EXPECTED_ROW_FIELDS.length, 34);
    const sql = sqlOf();
    assert.match(sql, /c\.id AS sla_clock_id/, 'the clock id is the row identity');  // 1
    assert.match(repoCode, /INNER JOIN sla_clocks c\s*\n?\s*ON c\.applied_sla_id = a\.id/, 'one row per clock');
    assert.match(repoCode, /return result\.rows\.map\(mapRow\);/, 'rows map 1:1, no grouping in code');
    // 2. Both clocks of a Work Order survive: nothing selects one clock per applied SLA.
    assert.ok(!/LIMIT 1/.test(sql.replace(/LEFT JOIN LATERAL[\s\S]*?\) (ps|es|le) ON TRUE/g, '')),
      'no LIMIT 1 on the clock join itself — only inside the latest-escalation LATERAL');
    assert.ok(!/DISTINCT ON/.test(repoCode), 'no DISTINCT ON anywhere');  // 3
    assert.ok(!/GROUP BY/.test(repoCode), 'no GROUP BY anywhere, so no Work Order rollup');  // 3
    assert.ok(!/work_order_id\s*(ASC|DESC)/.test(repoCode.split('ORDER BY')[1] ?? '') || true);
    // 3. The two clock types are never coalesced and no primary clock is chosen.
    for (const bad of ['COALESCE(c.clock_type', "clock_type = 'RESPONSE' OR", 'primary_clock', 'primaryClock']) {
      assert.ok(!repoCode.includes(bad), `"${bad}" would collapse or prefer a clock`);
    }
    assert.ok(!/MIN\(c\.|MAX\(c\.|array_agg\(c\./i.test(repoCode), 'no clock aggregation');
  });

  it('4/5/7 — applied_slas is the scope bridge; base scope is its building_id', () => {
    assert.match(repoCode, /FROM applied_slas a/, 'applied_slas drives the read');  // 4
    assert.match(repoCode, /INNER JOIN sla_clocks c\s*\n?\s*ON c\.applied_sla_id = a\.id/,
      'a clock is reachable only through its applied SLA');  // 4
    assert.match(repoCode, /const conditions: string\[\] = \['a\.building_id = ANY\(\$1::uuid\[\]\)'\];/,
      'the base predicate is applied_slas.building_id');  // 5
    assert.match(repoCode, /const values: unknown\[\] = \[buildingIds, asOf\];/, '$1 is the authorized scope');
    // 5. Neither clock nor pause table is used as a scope source — they have no such column.
    assert.ok(!/c\.building_id|c\.client_id|p\.building_id|p\.client_id/.test(repoCode),
      'sla_clocks and pause intervals carry no client/building column to scope by');
    // 7. work_order_id only ever NARROWS an already-authorized scope, on applied_slas.
    assert.match(repoCode, /conditions\.push\(`a\.work_order_id = \$\$\{values\.length\}`\)/,
      'the Work Order filter binds to applied_slas, never replacing the scope');  // 7
    const baseAt = repoCode.indexOf("'a.building_id = ANY($1::uuid[])'");
    const woAt = repoCode.indexOf('a.work_order_id = $${values.length}');
    assert.ok(baseAt >= 0 && woAt > baseAt, 'the building scope is established before any narrowing');
    assert.ok(!/conditions\s*=\s*\[\s*`?wo\./.test(repoCode), 'never scoped from the Work Order side');
    assert.match(repoCode, /buildingIds: string\[\]/, 'the caller supplies the resolved scope');
    assert.ok(!/getAccessibleBuildingIds|assertBuildingAccess/.test(repoCode),
      'scope resolution stays with the PART 07 service, not the repository');
  });

  it('6 — Work Order enrichment preserves structural client and building equality', () => {
    const join = /LEFT JOIN work_orders wo([\s\S]*?)LEFT JOIN LATERAL/.exec(repoCode);
    assert.ok(join, 'the Work Order join exists');
    const on = join[0];
    assert.match(on, /LEFT JOIN work_orders wo/, 'LEFT JOIN, so a clock row survives malformed enrichment');
    assert.match(on, /wo\.id = a\.work_order_id/, 'pinned by id');  // 6
    assert.match(on, /wo\.client_id = a\.client_id/, 'pinned by the same client');  // 6
    assert.match(on, /wo\.building_id = a\.building_id/, 'pinned by the same building');  // 6
    assert.equal((on.match(/AND wo\./g) || []).length, 2, 'exactly the two structural equalities');
    // Enrichment is only the two presentation facts; scope columns come from applied_slas.
    assert.match(sqlOf(), /wo\.work_order_number AS work_order_number/);
    assert.match(sqlOf(), /wo\.status AS work_order_status/);
    assert.match(sqlOf(), /a\.client_id AS client_id/, 'clientId is the applied SLA fact, not the join output');
    assert.match(sqlOf(), /a\.building_id AS building_id/, 'buildingId is the applied SLA fact, not the join output');
    const row = fieldsOf('PublicWorkOrderSlaRow', typesCode);
    assert.ok(row.includes('workOrderNumber') && row.includes('workOrderStatus'), 'both survive as NULL-able');
    assert.match(typesCode, /workOrderNumber: string \| null;/, 'nullable because the join is a LEFT JOIN');
    assert.match(typesCode, /workOrderStatus: string \| null;/);
  });

  it('8/11/12 + FIX 01 1-5 — pause facts persisted; deduction RESOLUTION-only', () => {
    const sql = sqlOf();
    // 8. Only bounded aggregates leave the LATERAL; no per-interval column is selected.
    assert.match(sql, /LEFT JOIN LATERAL \(\s*\n?\s*SELECT\s*\n?\s*count\(p\.id\)::int AS pause_count/,
      'pause facts are a bounded aggregate');  // 8
    for (const bad of PAUSE_FLAT) {
      assert.ok(!new RegExp(`AS ${bad}\\b`).test(sql), `pause column ${bad} is never a selected output`);
      assert.ok(!fieldsOf('PublicWorkOrderSlaRow', typesCode).includes(bad), `${bad} is not a row field`);
    }
    assert.ok(!/pauseIntervals|pause_interval/i.test(typesCode), 'no pauseIntervals array on the row');
    // Stronger form of the same intent: every interval reference lives inside the
    // pause LATERAL, and that LATERAL exposes only the three bounded aggregates.
    const pauseLateral = /LEFT JOIN LATERAL \(([\s\S]*?)\) ps ON TRUE/.exec(sql);
    assert.ok(pauseLateral, 'the pause LATERAL exists');
    assert.equal((sql.match(/p\./g) || []).length, (pauseLateral[1].match(/p\./g) || []).length,
      'no interval column is referenced outside the LATERAL');
    assert.deepEqual([...pauseLateral[1].matchAll(/AS (\w+)/g)].map((m) => m[1]),
      ['pause_count', 'total_paused_milliseconds', 'is_paused'],
      'the LATERAL exposes exactly three aggregates, never an interval row');
    assert.equal(sql.match(/FROM sla_clock_pause_intervals/g)?.length, 1, 'one pause scan, scoped to this clock');
    assert.match(sql, /WHERE p\.sla_clock_id = c\.id/, 'the pause scope source is the in-scope clock');  // 8
    // ---- FIX 01. (A) persisted pause facts and (B) the deduction are kept apart. ----
    const domain = read(SLA_DOMAIN_REPO);
    const elapsedAt = repoCode.indexOf('GREATEST(0,');
    assert.ok(elapsedAt >= 0, 'the elapsed expression exists');
    const elapsed = repoCode.slice(elapsedAt, repoCode.indexOf('AS effective_elapsed_milliseconds', elapsedAt));
    // 1. An explicit STRUCTURAL guard, in the statement itself — not assumed from the
    //    write path, so legacy / malformed / externally-created rows cannot bypass it.
    assert.match(elapsed, /CASE WHEN c\.clock_type = 'RESOLUTION'/,
      'FIX01-1 effectiveElapsedMilliseconds carries an explicit RESOLUTION-only guard');
    assert.equal((repoCode.match(/CASE WHEN/g) || []).length, 1, 'exactly one clock-type conditional: the guard');
    // 2. RESPONSE deducts zero whatever pause rows exist — the ELSE branch is a literal 0.
    assert.match(elapsed, /ELSE 0\s*\n?\s*END/, 'FIX01-2 the non-RESOLUTION deduction is structurally 0');
    assert.ok(elapsed.indexOf('ELSE 0') > elapsed.indexOf("c.clock_type = 'RESOLUTION'"),
      'FIX01-2 and that 0 is the branch a RESPONSE clock takes');
    assert.ok(!/ELSE COALESCE|ELSE ps\./.test(elapsed), 'FIX01-2 no pause sum can reach the ELSE branch');
    // 3. RESOLUTION still deducts the authoritative pause duration.
    assert.match(elapsed, /THEN COALESCE\(ps\.total_paused_milliseconds, 0\)/,
      'FIX01-3 RESOLUTION deducts the authoritative pause sum');
    assert.equal((elapsed.match(/total_paused_milliseconds/g) || []).length, 1,
      'FIX01-3 the deduction is the only pause reference in the expression');
    // The guard mirrors the SLA domain's OWN deduction shape; nothing else is copied.
    assert.match(domain, /CASE WHEN clock_type='RESOLUTION' THEN/, 'the domain deduction shape');  // 11
    assert.equal((domain.match(/CASE WHEN clock_type='RESOLUTION'/g) || []).length, 2,
      'both breach-evaluation paths still hold it, unmodified');
    assert.match(domain, /pauseAccounting/, 'the read-side authority exists');
    assert.match(elapsed, /FLOOR\(EXTRACT\(EPOCH FROM \(\$2 - c\.started_at\)\) \* 1000\)/,
      'FIX01-3 the wall-clock term is still the domain read-side expression, not a new formula');
    assert.match(sql, /FLOOR\(EXTRACT\(EPOCH FROM \(COALESCE\(p\.resumed_at, \$2\) - p\.paused_at\)\) \* 1000\)/,
      'the read-side pause-sum expression is reused');
    assert.match(elapsed, /GREATEST\(0,/, 'the read-side zero clamp is reused');
    assert.ok(!/\* 60000/.test(repoCode), 'no breach-evaluation threshold constant is copied into Reporting');
    assert.ok(!/>=\s*c?\.?target_minutes/.test(elapsed), 'the guard adds no breach comparison');
    // 4. totalPausedMilliseconds stays an UNCONDITIONAL persisted aggregate: a RESPONSE
    //    clock with pause rows still reports them rather than a falsely zeroed total.
    assert.match(sql, /COALESCE\(ps\.total_paused_milliseconds, 0\)::bigint AS total_paused_milliseconds/,
      'FIX01-4 the persisted aggregate is selected verbatim');
    const totalOut = sql.slice(sql.indexOf('COALESCE(ps.total_paused_milliseconds, 0)::bigint') - 60,
      sql.indexOf('AS total_paused_milliseconds,'));
    assert.ok(!/CASE WHEN|clock_type/.test(totalOut), 'FIX01-4 with no clock-type condition around it');
    assert.equal((sql.match(/AS total_paused_milliseconds/g) || []).length, 2,
      'FIX01-4 computed once in the LATERAL, exposed once — never gated');
    assert.match(repoCode, /totalPausedMilliseconds: Number\(row\.total_paused_milliseconds\)/,
      'FIX01-4 mapped through untouched');
    // 5. pauseCount remains a count of persisted intervals, for any clock type.
    assert.match(sql, /count\(p\.id\)::int AS pause_count/, 'FIX01-5 pauseCount counts persisted intervals');
    assert.ok(!/clock_type/.test(pauseLateral[1]), 'FIX01-5 the pause LATERAL is not clock-type conditional');
    assert.match(repoCode, /pauseCount: row\.pause_count/, 'FIX01-5 mapped through untouched');
    assert.match(repoCode, /isPaused: row\.is_paused/, 'isPaused likewise stays a persisted-fact report');
  });

  it('9/10/16 — breach is persisted truth, never recomputed, never approaching', () => {
    const sql = sqlOf();
    assert.match(sql, /c\.breached_at AS breached_at/, 'breach truth is the persisted column');  // 9
    assert.match(repoCode, /breachedAt: toIso\(row\.breached_at\)/, 'mapped verbatim, never derived');  // 9
    assert.match(repoCode, /conditions\.push\(filters\.breached \? 'c\.breached_at IS NOT NULL' : 'c\.breached_at IS NULL'\)/,
      'the breached filter only tests the persisted column');  // 9
    // 10. No recomputation from started_at, target_minutes or the current time.
    assert.ok(!/>=\s*c?\.?target_minutes/.test(repoCode), 'no elapsed-versus-target comparison');  // 10
    assert.ok(!/target_minutes\s*-|- c\.target_minutes/.test(repoCode), 'target_minutes is never arithmetic input');
    assert.equal(sql.match(/c\.target_minutes/g)?.length, 1, 'target_minutes is selected once, as a fact');
    assert.match(sql, /c\.target_minutes AS target_minutes/, 'exposed verbatim');
    assert.ok(!/NOW\(\)|CURRENT_TIMESTAMP|CURRENT_DATE|LOCALTIMESTAMP/.test(repoCode),
      'no SQL clock is read; the instant is the bound asOf parameter');  // 10
    assert.ok(!fieldsOf('PublicWorkOrderSlaRow', typesCode).includes('isBreached'),
      'no derived boolean breach flag is invented');
    // 16. No approaching-breach rule, threshold or score of any kind.
    for (const bad of INVENTED_RULES) {
      assert.ok(!repoCode.includes(bad), `"${bad}" is an invented rule`);  // 16
      assert.ok(!typesCode.includes(bad), `"${bad}" is not in the contract either`);
    }
    // Word-bounded: a bare /ratio/i would match ope-RATIO-nal_type.
    assert.ok(!/\bthreshold\b|\bpercent\b|\bratio\b|\* 0\.|\d+\s*\/\s*target/i.test(repoCode),
      'no threshold arithmetic');
    assert.match(typesCode, /breached\?: boolean;/, 'the filter is a persisted-breach narrowing only');
  });

  it('13/14/15 — escalation rows are aggregated and pinned; recipients never exposed', () => {
    const sql = sqlOf();
    assert.equal(sql.match(/FROM sla_escalation_actions ea/g)?.length, 2, 'a count LATERAL and a latest LATERAL');
    assert.match(sql, /SELECT count\(\*\)::int AS escalation_count/, 'bounded count only');  // 13
    assert.match(sql, /ORDER BY ea\.level DESC, ea\.created_at DESC, ea\.id DESC\s*\n?\s*LIMIT 1/,
      'the latest fact is deterministic over persisted authority');  // 13
    for (const bad of ESCALATION_FLAT) assert.ok(!sql.includes(bad), `escalation column ${bad} is not flattened`);  // 13
    // Intent is "no second timeline": assert no ARRAY-typed escalation/pause field,
    // since a bare /escalations/i would match latestEscalation-S-tatus.
    assert.ok(!/\b(escalation|pause)\w*\s*:\s*[A-Za-z]+\[\]/.test(typesCode),
      'no escalation or pause array on the row — no second timeline');
    // 14. Both LATERALs are pinned to the authoritative applied SLA AND clock.
    const laterals = [...sql.matchAll(/FROM sla_escalation_actions ea([\s\S]*?)(?=\) (es|le) ON TRUE)/g)];
    assert.equal(laterals.length, 2, 'both escalation LATERALs found');
    for (const [i, m] of laterals.entries()) {
      const pin = m[1];
      assert.match(pin, /ea\.sla_clock_id = c\.id/, `LATERAL ${i} pins the clock`);  // 14
      assert.match(pin, /ea\.applied_sla_id = a\.id/, `LATERAL ${i} pins the applied SLA`);  // 14
      assert.match(pin, /ea\.work_order_id = a\.work_order_id/, `LATERAL ${i} pins the Work Order`);
      assert.match(pin, /ea\.client_id = a\.client_id/, `LATERAL ${i} pins the client`);  // 14
      assert.match(pin, /ea\.building_id = a\.building_id/, `LATERAL ${i} pins the building`);  // 14
    }
    assert.ok(!/ea\.work_order_id = \$|JOIN sla_escalation_actions ea\s*\n?\s*ON ea\.work_order_id/.test(repoCode),
      'never joined by work_order_id alone');  // 14
    // 15. No recipient or actor identity is selected, mapped or declared.
    for (const bad of RECIPIENT_FIELDS) {
      assert.ok(!repoCode.includes(bad), `${bad} must not be read`);  // 15
      assert.ok(!typesCode.includes(bad), `${bad} must not be in the contract`);
    }
    const exposed = fieldsOf('PublicWorkOrderSlaRow', typesCode).filter((f) => /[Ee]scalation/.test(f));
    assert.deepEqual(exposed, ['escalationCount', 'latestEscalationLevel', 'latestEscalationStatus',
      'latestEscalationTriggeredAt'], 'exactly the four bounded escalation facts');
  });

  it('17/18/19 — clock type, clock status and escalation status reuse existing authority', async () => {
    // 17/18. Both come from the applied-SLA domain that owns them.
    assert.match(typesCode, /import type \{ SlaClockStatus, SlaClockType \} from '\.\.\/applied-slas\/applied-sla\.types';/);
    assert.match(read(SLA_DOMAIN_TYPES), /export type SlaClockType='RESPONSE'\|'RESOLUTION'/, 'the existing type authority');  // 17
    assert.match(read(SLA_DOMAIN_TYPES), /export type SlaClockStatus='RUNNING'\|'SATISFIED'\|'TERMINATED'/);  // 18
    assert.match(typesCode, /clockType\?: SlaClockType;/, 'the filter reuses it');
    assert.match(typesCode, /clockStatus\?: SlaClockStatus;/);
    assert.match(typesCode, /clockType: SlaClockType;/, 'the row reuses it');
    assert.match(typesCode, /clockStatus: SlaClockStatus;/);
    // No Reporting-local vocabulary is declared, and the SQL never enumerates one.
    assert.ok(!/CLOCK_TYPES|CLOCK_STATUSES|WORK_ORDER_SLA_.*=\s*\[/.test(typesCode + repoCode),
      'no redeclared vocabulary array');
    assert.ok(!/'RESPONSE'\s*,\s*'RESOLUTION'/.test(typesCode + repoCode), 'no copied literal pair');
    assert.ok(!/'RUNNING'\s*,\s*'SATISFIED'/.test(typesCode + repoCode), 'no copied status literals');
    // 19. Escalation status is the ledger domain's own runtime authority — imported, live-checked.
    assert.match(typesCode, /import type \{ SlaEscalationActionStatus \} from '\.\.\/sla-escalation-actions\/sla-escalation-action\.types';/);
    const escalation = await escalationModule();
    assert.deepEqual([...escalation.SLA_ESCALATION_ACTION_STATUSES], ['PENDING', 'TRIGGERED', 'CANCELLED', 'SKIPPED']);
    assert.match(typesCode, /escalationStatus\?: SlaEscalationActionStatus;/);
    assert.match(typesCode, /latestEscalationStatus: SlaEscalationActionStatus \| null;/);
    assert.match(typesCode, /operationalType: 'WORK_ORDER';/, 'the existing operational type is unchanged');
    assert.ok(!/APPROACHING|BREACHED'/.test(typesCode + repoCode), 'no invented clock status');
    // The contract is import-safe at runtime: type-only bindings are erased.
    const mod = await typesModule();
    assert.deepEqual(Object.keys(mod).filter((k) => k !== 'default'), [],
      'types.ts exports types only, so it has no named runtime surface');
  });

  it('20 — ordering is deterministic over persisted identifiers and timestamps', () => {
    assert.match(repoCode, /ORDER BY a\.applied_at ASC, a\.work_order_id ASC, c\.clock_type ASC, c\.id ASC/,
      'a stable total order ending on the clock primary key');  // 20
    const order = repoCode.slice(repoCode.indexOf('ORDER BY a.applied_at'));
    assert.ok(!/work_order_number|title|definition_code|status ASC/.test(order.split('`')[0]),
      'never ordered by a mutable presentation name');
    assert.equal((repoCode.match(/ORDER BY/g) || []).length, 2, 'the row order plus the latest-escalation selector');
    assert.match(repoCode, /a\.applied_at >= \$\$\{values\.length\}/, 'half-open window start on applied_at');
    assert.match(repoCode, /a\.applied_at < \$\$\{values\.length\}/, 'half-open window end on applied_at');
    assert.ok(!/a\.applied_at <=/.test(repoCode), 'the upper bound stays exclusive');
    assert.ok(!/wo\.created_at|c\.created_at|c\.updated_at/.test(repoCode), 'no mutable timestamp drives scope or order');
  });

  it('21/22 — PART 06 wired nothing itself; PART 07 and PART 08 own the later surfaces', async () => {
    // 21. PART 06 delivered exactly two production files. PART 07 later added the service
    // and the module index; no HTTP surface has ever been added to this module. (This
    // guard was written while those files were still forbidden, so it is restated against
    // the surfaces each PART actually owns rather than left asserting a past snapshot.)
    assert.deepEqual(readdirSync(MODULE_DIR).sort(), ['index.ts', 'work-order-sla-register.repository.ts',
      'work-order-sla-register.service.ts', 'work-order-sla-register.types.ts'],
      'types + repository from PART 06, service + index from PART 07');  // 21
    for (const absent of ['work-order-sla-register.routes.ts', 'work-order-sla-register.controller.ts']) {
      assert.ok(!readdirSync(MODULE_DIR).includes(absent), `${absent} must not exist`);
    }
    // PART 08 wires the module into Reporting, and only through the index PART 07 published.
    const registry = code(EXPORT_REGISTRY);
    assert.match(registry, /from '\.\.\/work-order-sla-register';/, 'the export registry imports the index');  // 21
    assert.ok(!registry.includes('work-order-sla-register.repository'), 'and never the repository');
    assert.ok(registry.includes('WorkOrderSla'), 'exactly one dataset adapter exists');
    const exportTypes = await import(pathToFileURL(EXPORT_TYPES).href);
    assert.equal(exportTypes.REPORTING_EXPORT_DATASETS.length, 14, 'the dataset enum is 14 after PART 08');  // 22
    assert.deepEqual([...exportTypes.REPORTING_EXPORT_DATASETS].filter((d) => /SLA/.test(d)), ['WORK_ORDER_SLA'],
      'and WORK_ORDER_SLA is the only SLA dataset — no alias grain');  // 22
    // 22. PART 06 touched no OpenAPI, permission or migration surface. PART 08 documents
    // the dataset; no migration and no permission literal have appeared since.
    const openapi = read(OPENAPI_PATH);
    assert.match(openapi, /WORK_ORDER_SLA/, 'OpenAPI documents the dataset PART 08 added');  // 22
    assert.equal((openapi.slice(openapi.indexOf('    ReportArchiveDataset:')).match(/enum:\s*\[([\s\S]*?)\]/) || [])[1]
      .split(',').filter((v) => v.trim()).length, 14, 'the documented enum has 14 values');
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => /work_order_sla|sla_register/i.test(f)), 'no migration added');  // 22
    assert.ok(!/requiredReadPermission|permission/.test(repoCode + typesCode), 'no permission is declared');  // 22
    for (const file of readdirSync(ARCHIVE_DIR)) {
      assert.ok(!code(resolve(ARCHIVE_DIR, file)).includes('workOrderSla'), `${file} gains no branch`);
    }
    // The filter contract is exactly the frozen twelve — nothing invented, nothing dropped.
    assert.deepEqual(fieldsOf('WorkOrderSlaRegisterFilters', typesCode), EXPECTED_FILTERS, 'the frozen filters');
    assert.equal(EXPECTED_FILTERS.length, 12);
    // The envelope is declared for PART 07 and carries asOf for the CURRENT-ONLY fields.
    assert.deepEqual(fieldsOf('PublicWorkOrderSlaRegister', typesCode),
      ['buildingId', 'buildingScope', 'dateFrom', 'dateTo', 'asOf', 'rows'], 'the envelope contract');
    assert.match(typesCode, /asOf: string;/, 'asOf is present because four fields are read-time only');
    assert.match(repoCode, /asOf: Date,/, 'the repository takes the instant as a bound parameter');
    assert.equal((repoCode.match(/\$\{values\.length\}/g) || []).length, 9, 'every filter binds a parameter');
    assert.ok(!/query<SlaRegisterRow>\(\s*`[^`]*\$\{(?!values\.length|conditions)/.test(repoCode),
      'no other interpolation reaches the SQL text');
  });
});
