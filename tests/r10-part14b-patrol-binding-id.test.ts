/**
 * R10 PART 14B — expose `patrolScheduleBindingId` on the security-report PATROL read model.
 *
 * TINY, ADDITIVE PART. One identity field, two production files, no row-set change.
 *
 * WHY THE FIELD EXISTS (source-verified, not assumed)
 *   `getPatrolDataset` joins `generated_tasks gt` to `patrol_schedule_bindings psb` ON
 *   `psb.schedule_definition_id = gt.schedule_definition_id` — the schedule definition
 *   ALONE. But migration 0123 creates `patrol_schedule_bindings_active_unique` as
 *   UNIQUE (patrol_route_id, schedule_definition_id) WHERE status = 'ACTIVE', which is NOT
 *   unique on schedule_definition_id by itself. Several ACTIVE bindings for one schedule
 *   definition across different patrol routes are therefore valid, so one generated task
 *   legitimately matches more than one binding and the same `taskId` appears on several
 *   rows. That multiplicity already exists in the shipped query; this part only makes it
 *   identifiable. The truthful row identity is (taskId, patrolScheduleBindingId).
 *
 * NULLABILITY PROVEN, NOT GUESSED: `psb` is an INNER JOIN and the WHERE clause pins
 * `psb.status = 'ACTIVE'`, while `patrol_schedule_bindings.id` is a UUID PRIMARY KEY.
 * Every row that exists therefore has a binding id, so the field is `string` and not
 * `string | null` — the same derivation as the sibling `patrolRouteId: string`.
 *
 * EXECUTED FOR REAL: `getPatrolDataset` is called through the actual repository module with
 * only the `../../database` pool faked (via `module.registerHooks`, the PART 13/14
 * technique). The generated SQL, the bound parameters and the mapper output are all
 * observed, not inferred from source text. `security-report.validation` and its
 * `isValidUuid` authority load for real.
 *
 * node_modules is absent, so there is no tsc/vitest; assertions run under `node --test`
 * with native TypeScript type stripping. Execution against a live PostgreSQL instance
 * remains CI-required.
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
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

/** The PART 14B baseline. Diffing against a fixed commit keeps these proofs valid after commit. */
const BASE = 'e6d42476eabbf7386dc7dc1ccd9c81cfed22cb04';
const TYPES = 'src/modules/security-reports/security-report.types.ts';
const REPO = 'src/modules/security-reports/security-report.repository.ts';

const TASK = '11111111-1111-4111-8111-111111111111';
const BIND1 = '22222222-2222-4222-8222-222222222222';
const BIND2 = '33333333-3333-4333-8333-333333333333';
const ROUTE1 = '44444444-4444-4444-8444-444444444444';
const ROUTE2 = '55555555-5555-4555-8555-555555555555';
const POST = '66666666-6666-4666-8666-666666666666';
const BLDG = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';

/** Observed SQL/params of every executed call, plus the canned driver rows to return. */
const ctl = { calls: [], rows: [] };
globalThis.__PTW14B = ctl;

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'pg') return { url: 'stub:pg', shortCircuit: true };
    if (spec.startsWith('.') && ctx.parentURL?.startsWith('file:')) {
      let abs = path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), spec);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        if (fs.existsSync(`${abs}.ts`)) abs = `${abs}.ts`;
        else if (fs.existsSync(path.join(abs, 'index.ts'))) abs = path.join(abs, 'index.ts');
        else return next(spec, ctx);
      }
      // The ONLY faked dependency: the connection pool.
      if (abs === path.join(ROOT, 'src/database/index.ts')) return { url: 'stub:db', shortCircuit: true };
      return { url: pathToFileURL(abs).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:pg') {
      return { format: 'module', shortCircuit: true, source: 'export class Pool {}\nexport default { Pool };' };
    }
    if (url === 'stub:db') {
      return {
        format: 'module', shortCircuit: true,
        source: `export const getPool = () => ({ query: async (sql, params) => {
          const c = globalThis.__PTW14B; c.calls.push({ sql, params });
          return { rows: c.rows, rowCount: c.rows.length };
        } });`,
      };
    }
    return next(url, ctx);
  },
});

const repo = await import('../src/modules/security-reports/security-report.repository.ts');

/** One raw driver row. Every column carries a distinct sentinel so mapping is provable. */
const dbRow = (bindingId, routeId, code, name) => ({
  task_id: TASK,
  patrol_schedule_binding_id: bindingId,
  patrol_route_id: routeId,
  patrol_route_code: code,
  patrol_route_name: name,
  start_security_post_id: POST,
  start_security_post_code: 'POST-1',
  start_security_post_name: 'Main Gate',
  status: 'PENDING',
  occurrence_at: new Date('2026-03-01T08:00:00.000Z'),
  started_at: new Date('2026-03-01T08:05:00.000Z'),
  completed_at: null,
  completed_by_user_id: null,
});

/** Calls the REAL getPatrolDataset and returns the observed SQL alongside the rows. */
async function run(filters, start, end, rows) {
  ctl.calls = [];
  ctl.rows = rows;
  const out = await repo.getPatrolDataset([BLDG, OTHER], filters, start ?? null, end ?? null);
  return { out, sql: ctl.calls[0].sql, params: ctl.calls[0].params };
}

const PUBLIC_KEYS = [
  'taskId', 'patrolScheduleBindingId', 'patrolRouteId', 'patrolRouteCode', 'patrolRouteName',
  'securityPostId', 'securityPostCode', 'securityPostName', 'status', 'occurrenceAt',
  'startedAt', 'completedAt', 'completedByUserId',
];

test('PART 14B — the mapper exposes patrolScheduleBindingId verbatim and keeps every existing field', async () => {
  const { out, sql } = await run({}, null, null, [dbRow(BIND1, ROUTE1, 'R-1', 'Route One')]);

  assert.equal(out.length, 1);
  // 1. exposed  4. verbatim  5. taskId unchanged
  assert.equal(out[0].patrolScheduleBindingId, BIND1);
  assert.equal(out[0].taskId, TASK);
  // The field sits beside the binding lineage it identifies; nothing existing was reordered.
  assert.deepEqual(Object.keys(out[0]), PUBLIC_KEYS);
  // All twelve pre-existing fields remain semantically identical, including ISO conversion.
  assert.deepEqual(out[0], {
    taskId: TASK, patrolScheduleBindingId: BIND1, patrolRouteId: ROUTE1,
    patrolRouteCode: 'R-1', patrolRouteName: 'Route One', securityPostId: POST,
    securityPostCode: 'POST-1', securityPostName: 'Main Gate', status: 'PENDING',
    occurrenceAt: '2026-03-01T08:00:00.000Z', startedAt: '2026-03-01T08:05:00.000Z',
    completedAt: null, completedByUserId: null,
  });
  // 2. the source is psb.id, aliased in the house snake_case convention
  assert.match(sql, /psb\.id AS patrol_schedule_binding_id/);
  assert.equal((sql.match(/patrol_schedule_binding_id/g) ?? []).length, 1, 'exactly one added column');
  // 3. the SELECT adds only the binding identity fact: the 12 frozen columns + 1 new = 13
  // aliases. Any extra column would show up here immediately. The comma count is also 13,
  // not 12, because COALESCE(psb.start_security_post_id, pr.start_security_post_id) carries
  // one comma of its own inside the sixth column.
  const selectList = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM'));
  assert.equal((selectList.match(/ AS \w+/g) ?? []).length, 13);
  assert.equal((selectList.match(/,/g) ?? []).length, 13);
  assert.equal((selectList.match(/COALESCE\(/g) ?? []).length, 1);
});

test('PART 14B — repeated taskId stays legal: two ACTIVE bindings yield two rows, never collapsed', async () => {
  // The exact scenario the unique index permits: one schedule definition, two patrol routes,
  // both bindings ACTIVE. Same task_id, different psb.id.
  const { out } = await run({}, null, null, [
    dbRow(BIND1, ROUTE1, 'R-1', 'Route One'),
    dbRow(BIND2, ROUTE2, 'R-2', 'Route Two'),
  ]);
  assert.equal(out.length, 2, 'both rows survive');
  assert.deepEqual(out.map((r) => r.taskId), [TASK, TASK], 'taskId repeats and is not deduplicated');
  assert.deepEqual(out.map((r) => r.patrolScheduleBindingId), [BIND1, BIND2]);
  const ids = out.map((r) => `${r.taskId}:${r.patrolScheduleBindingId}`);
  assert.equal(new Set(ids).size, 2, '(taskId, patrolScheduleBindingId) is a unique row identity');
});

test('PART 14B — no row-set semantic change: no DISTINCT, GROUP BY, LIMIT or binding selector', async () => {
  const { sql } = await run({}, null, null, []);
  const upper = sql.toUpperCase();
  // 6, 7, 8, 9 — nothing that could reduce or elect among rows
  for (const banned of ['DISTINCT', 'GROUP BY', 'LIMIT', 'OFFSET', 'ROW_NUMBER', 'LATERAL',
    'MAX(', 'MIN(', 'FETCH FIRST']) {
    assert.equal(upper.includes(banned), false, `${banned} must not be added`);
  }
  // 10 — no primary/current/selected/latest binding concept anywhere in the query or mapper
  for (const banned of ['primaryPatrolScheduleBinding', 'currentPatrolScheduleBinding',
    'selectedPatrolScheduleBinding', 'latestPatrolScheduleBinding', 'primary_patrol_schedule_binding',
    'isPrimaryBinding']) {
    assert.equal(sql.includes(banned), false, banned);
    assert.equal(rd(REPO).includes(banned), false, banned);
    assert.equal(rd(TYPES).includes(banned), false, banned);
  }
  // 11, 12, 13 — the joins and the ACTIVE predicate are byte-identical to the frozen query
  assert.match(sql, /FROM generated_tasks gt\s+JOIN patrol_schedule_bindings psb\s+ON psb\.schedule_definition_id = gt\.schedule_definition_id\s+JOIN patrol_routes pr\s+ON pr\.id = psb\.patrol_route_id\s+LEFT JOIN security_posts sp\s+ON sp\.id = COALESCE\(psb\.start_security_post_id, pr\.start_security_post_id\)/);
  assert.match(sql, /JOIN patrol_schedule_bindings psb/, 'the binding join stays INNER');
  assert.equal(/LEFT JOIN patrol_schedule_bindings/.test(sql), false, 'never weakened to a LEFT JOIN');
  assert.match(sql, /psb\.status = 'ACTIVE'/);
  assert.match(sql, /pr\.status = 'ACTIVE'/);
  // 17 — ordering unchanged
  assert.match(sql, /ORDER BY gt\.occurrence_at DESC, gt\.created_at DESC\s*$/);
});

test('PART 14B — building scope, security-post, date, route and status filters are unchanged', async () => {
  const base = await run({}, null, null, []);
  // 14 — building scope is the authorized id array bound as $1, never widened
  assert.match(base.sql, /gt\.building_id = ANY\(\$1::uuid\[\]\)/);
  assert.deepEqual(base.params[0], [BLDG, OTHER]);

  // 15 — the PATROL dataset keeps its own COALESCE security-post semantics. This part does
  // not "fix" the known divergence from the KPI domain's OR-form.
  const post = await run({ securityPostId: POST }, null, null, []);
  assert.match(post.sql, /COALESCE\(psb\.start_security_post_id, pr\.start_security_post_id\) = \$2/);
  assert.equal(post.params[1], POST);
  assert.equal(/psb\.start_security_post_id = .* OR /.test(post.sql), false, 'no KPI OR-form here');

  // 16 — date window stays a UTC half-open range over gt.occurrence_at
  const from = new Date('2026-03-01T00:00:00.000Z');
  const to = new Date('2026-04-01T00:00:00.000Z');
  const dated = await run({}, from, to, []);
  assert.match(dated.sql, /gt\.occurrence_at >= \$2/);
  assert.match(dated.sql, /gt\.occurrence_at < \$3/);
  assert.deepEqual(dated.params.slice(1), [from, to]);

  const routed = await run({ patrolRouteId: ROUTE1, status: 'PENDING' }, null, null, []);
  assert.match(routed.sql, /pr\.id = \$2/);
  assert.match(routed.sql, /gt\.status = \$3/);
  // Placeholder numbering is still driven by push order, so the added SELECT column did not
  // shift any parameter.
  for (const { sql } of [base, post, dated, routed]) {
    assert.equal(sql.includes('$0'), false);
    assert.match(sql, /\$1::uuid\[\]/);
  }
});

test('PART 14B — no missed/overdue derivation and no KPI, permission, parser or service change', () => {
  const repoSrc = rd(REPO);
  // Slice to the next exported function rather than to a comment separator, whose exact dash
  // count is a brittle anchor.
  const patrolFn = repoSrc.slice(repoSrc.indexOf('export async function getPatrolDataset'),
    repoSrc.indexOf('export async function getSecurityPostDataset'));
  assert.ok(patrolFn.length > 500, 'the patrol function body was actually isolated');
  // 18, 19 — no timeliness outcome is derived on patrol rows
  for (const banned of ['missed', 'overdue', 'dueBefore', 'graceMinutes', 'isOverdue', 'dueState']) {
    assert.equal(patrolFn.toLowerCase().includes(banned.toLowerCase()), false, `${banned} not derived`);
  }
  // 20 — the KPI authority is untouched by this part
  // Scoped by PATH, not by count: this focused test file is untracked before the commit and
  // tracked after it, so a bare `git diff --name-only` list changes length across the commit
  // boundary. Filtering to production paths keeps proof 28 true in both states.
  const changed = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const production = changed.filter((f) => !f.startsWith('tests/'));
  assert.deepEqual(production.sort(), [REPO, TYPES].sort(),
    '28. exactly the two authorized production files');
  assert.deepEqual(changed.filter((f) => f.startsWith('tests/')),
    ['tests/r10-part14b-patrol-binding-id.test.ts'],
    'the focused test is the only other file this part may add');
  assert.equal(git('diff', '--numstat', BASE).split('\n').filter((l) => l.includes('security-report.repository')).length, 1);
  // Purely additive: zero deleted lines anywhere in the diff.
  const deletions = git('diff', BASE).split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
  assert.deepEqual(deletions, [], 'no existing line was removed or modified');
});

test('PART 14B — types, service, routes, OpenAPI, Reporting, renderers and migrations untouched', () => {
  const typesSrc = rd(TYPES);
  // The public field is non-nullable, proven by the INNER JOIN and the UUID PRIMARY KEY.
  assert.match(typesSrc, /^ {2}patrolScheduleBindingId: string;$/m);
  assert.equal(/patrolScheduleBindingId\?:/.test(typesSrc), false, 'never optional');
  assert.equal(/patrolScheduleBindingId: string \| null/.test(typesSrc), false, 'never nullable');
  assert.match(rd(REPO), /^ {2}patrol_schedule_binding_id: string;$/m);

  // 21-27 — nothing outside the two authorized files changed. Diffing against the fixed
  // baseline keeps this true both before and after the commit.
  const diff = git('diff', '--name-only', BASE).split('\n').filter((f) => !f.startsWith('tests/'));
  for (const untouched of [
    'src/modules/security-reports/security-report.service.ts',
    'src/modules/security-reports/security-report.controller.ts',
    'src/modules/security-reports/security-report.routes.ts',
    'src/modules/security-reports/security-report.validation.ts',
    'src/modules/security-reports/index.ts',
    'docs/api/openapi.yaml',
    'src/modules/reporting-export/reporting-export.types.ts',
    'src/modules/reporting-export/reporting-export.registry.ts',
    'src/modules/reporting-export/reporting-export.r10-projections.ts',
    'src/modules/reporting-export/csv-renderer.ts',
    'src/modules/reporting-export/xlsx-renderer.ts',
    'src/modules/reporting-export/pdf-renderer.ts',
  ]) {
    assert.equal(diff.includes(untouched), false, `${untouched} must be untouched`);
  }
  assert.equal(diff.some((f) => f.includes('src/database/migrations')), false, '27. no migration');
  // 25 — no Reporting enum, registry, projection or PART 15 wiring references the new field
  for (const f of fs.readdirSync(path.join(ROOT, 'src/modules/reporting-export'))) {
    if (f.endsWith('.ts')) {
      assert.equal(rd(`src/modules/reporting-export/${f}`).includes('patrolScheduleBindingId'), false,
        `no PART 15 Reporting wiring in ${f}`);
    }
  }
  // No permission was introduced or altered.
  assert.equal(/patrol_schedule_binding\.read|security_report\.patrol/.test(git('diff', BASE)), false);
});
