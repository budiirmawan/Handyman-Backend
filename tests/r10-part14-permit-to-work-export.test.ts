/**
 * R10 PART 14 — PERMIT_TO_WORK reporting export integration.
 *
 * EXECUTED FOR REAL (not stubbed, not read from source text): the 16-entry dataset enum,
 * the PERMIT_TO_WORK registry adapter, both PART 14 projection helpers, and the whole
 * `permit-to-work-register` module — its parser, view branching, scope resolution,
 * repository row mapping and envelope assembly — plus the real vocabulary and validator
 * authorities (`permit-application.types`, `permit.types`, `review.types`,
 * `permit-approval.types`, `client.validation`, `work-request.validation`,
 * `building.errors`, `shared/errors`).
 *
 * ONLY THE I/O BOUNDARY IS FAKED via `module.registerHooks` (Node >=22.19, the PART 13
 * technique): `../../database` returns canned raw driver rows and `../buildings` /
 * `../context-access` return a canned authorized Building scope. Every other sibling the
 * registry imports at value level is an inert stub: those adapters are never invoked here
 * and several pull in `express`, which is not installed in this workspace.
 *
 * node_modules is absent, so there is no tsc/vitest: assertions run under `node --test`
 * with native TypeScript type stripping. Hooks are process-wide and rely on `node --test`
 * per-file process isolation (the default). Integration against a live PostgreSQL instance
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

const B1 = '11111111-1111-4111-8111-111111111111';
const APP = '33333333-3333-4333-8333-333333333333';
const PERMIT = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const AP1 = '66666666-6666-4666-8666-666666666666';
const AP2 = '77777777-7777-4777-8777-777777777777';
const REV1 = '88888888-8888-4888-8888-888888888888';
const REV2 = '99999999-9999-4999-8999-999999999999';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Test-controlled I/O boundary, read lazily by the generated stubs. */
const ctl = {
  scope: [B1],
  lifecycleRows: [],
  approvalRows: [],
  queries: [],
};
globalThis.__PTW_CTL = ctl;

const LIFECYCLE_DB = {
  permit_application_id: APP, permit_id: PERMIT, permit_number: 'PTW-0001',
  client_id: CLIENT, building_id: B1,
  application_status: 'SUBMITTED', permit_status: 'DRAFT',
  requested_work_at: new Date('2026-03-01T08:00:00.000Z'),
  submitted_at: new Date('2026-02-20T09:00:00.000Z'), cancelled_at: null,
  created_at: new Date('2026-02-19T10:00:00.000Z'),
  work_lifecycle_status: 'IN_PROGRESS',
  work_lifecycle_started_at: new Date('2026-03-01T08:05:00.000Z'),
  work_lifecycle_closed_at: null,
  validity_status: 'VALID',
  valid_from: new Date('2026-03-01T00:00:00.000Z'),
  valid_until: new Date('2026-03-02T00:00:00.000Z'),
  approval_count: 2, pending_approval_count: 1,
};

// TWO approval bindings for the SAME application: the 1:N child grain. They must
// survive as two rows and never be collapsed, deduplicated or elected down to one.
const APPROVAL_DB = [
  {
    approval_id: AP1, permit_application_id: APP, permit_id: PERMIT,
    permit_number: 'PTW-0001', client_id: CLIENT, building_id: B1,
    approval_stage: 'STAGE_ONE', approval_type: 'HOT_WORK', review_id: REV1,
    review_status: 'COMPLETED', decision: 'APPROVED', approval_status: 'APPROVED',
    reviewed_at: new Date('2026-02-25T11:00:00.000Z'), notes: 'Current note only',
    assigned_approver_user_id: USER, created_by_user_id: USER,
    created_at: new Date('2026-02-21T10:00:00.000Z'),
    application_status: 'SUBMITTED', permit_status: 'DRAFT',
  },
  {
    approval_id: AP2, permit_application_id: APP, permit_id: PERMIT,
    permit_number: 'PTW-0001', client_id: CLIENT, building_id: B1,
    approval_stage: 'STAGE_TWO', approval_type: 'HOT_WORK', review_id: REV2,
    review_status: 'PENDING', decision: null, approval_status: 'PENDING',
    reviewed_at: null, notes: null,
    assigned_approver_user_id: USER, created_by_user_id: USER,
    created_at: new Date('2026-02-22T10:00:00.000Z'),
    application_status: 'SUBMITTED', permit_status: 'DRAFT',
  },
];

const LIFECYCLE_ORDER = [
  'permitApplicationId', 'permitId', 'permitNumber', 'clientId', 'buildingId',
  'applicationStatus', 'permitStatus', 'requestedWorkAt', 'submittedAt',
  'cancelledAt', 'createdAt', 'workLifecycleStatus', 'workLifecycleStartedAt',
  'workLifecycleClosedAt', 'validityStatus', 'validFrom', 'validUntil',
  'approvalCount', 'pendingApprovalCount',
];
const APPROVAL_ORDER = [
  'approvalId', 'permitApplicationId', 'permitId', 'permitNumber', 'clientId',
  'buildingId', 'approvalStage', 'approvalType', 'reviewId', 'reviewStatus',
  'decision', 'approvalStatus', 'reviewedAt', 'notes', 'assignedApproverUserId',
  'createdByUserId', 'createdAt', 'applicationStatus', 'permitStatus',
];

/** Registry siblings stubbed inertly: never invoked by the PERMIT_TO_WORK adapter. */
const INERT = [
  'finding-register', 'management-operations-command-center',
  'security-finding-incident-kpi', 'security-patrol-kpi', 'utility-kpi',
  'checklist-execution-summary', 'vendor-service-register', 'work-order-register',
  'work-order-sla-register', 'scheduled-operation-lineage', 'vendor-tenant-kpi',
  'workforce-kpi', 'operational-detail-reporting', 'corrective-actions',
  'operational-detail-evidence', 'operational-detail-finding-rework',
  'operational-detail-review-history',
  // R10 PART 15 added a seventeenth adapter (SECURITY_OPERATIONAL_DETAIL) that imports
  // `parseReportQuery`/`securityReportService` from '../security-reports'. That module's real
  // index re-exports the Express router, so without this entry the registry can no longer be
  // loaded in-process here (Cannot find package 'express'). PART 14 never exercises the patrol
  // adapter, so an inert stub is exactly right.
  'security-reports',
];

const registrySrc = rd('src/modules/reporting-export/reporting-export.registry.ts');
/** Exact value names the registry imports from each stubbed sibling. */
const inertNames = (dir) => {
  // [^}]* (not [\s\S]*?) — a lazy dot-all match would span earlier import blocks and
  // capture their closing braces, producing a syntactically invalid stub.
  const re = new RegExp(`import \\{([^}]*)\\} from '\\.\\./${dir}';`, 'g');
  const names = [];
  for (const m of registrySrc.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().replace(/^type\s+/, '');
      if (n && !raw.trim().startsWith('type ')) names.push(n);
    }
  }
  return [...new Set(names)];
};

const STUBS = new Map();
/** stub name -> the real directory its stub-relative re-exports resolve against. */
const STUB_DIR = {
  buildings: 'src/modules/buildings',
  clients: 'src/modules/clients',
  'work-requests': 'src/modules/work-requests',
};
STUBS.set(path.join(ROOT, 'src/database/index.ts'), 'database');
STUBS.set(path.join(ROOT, 'src/modules/buildings/index.ts'), 'buildings');
STUBS.set(path.join(ROOT, 'src/modules/clients/index.ts'), 'clients');
STUBS.set(path.join(ROOT, 'src/modules/context-access/index.ts'), 'context-access');
STUBS.set(path.join(ROOT, 'src/modules/work-requests/index.ts'), 'work-requests');
for (const d of INERT) STUBS.set(path.join(ROOT, `src/modules/${d}/index.ts`), d);

const STUB_SRC = {
  // The ONLY faked data path: canned raw driver rows, routed by the grain's own
  // unique SELECT alias.
  // NOTE: the fake pool routes by grain and returns the canned rows verbatim; it does NOT
  // apply the generated WHERE clause. Filter-to-row correspondence is therefore not
  // asserted here (PART 12 proved the SQL) — only grain selection, mapping and projection.
  database: `export const getPool = () => ({ query: async (sql) => {
    const c = globalThis.__PTW_CTL; c.queries.push(sql);
    return { rows: sql.includes('AS approval_id') ? c.approvalRows : c.lifecycleRows, rowCount: 0 };
  } });`,
  buildings: `export { buildingNotFoundError } from './building.errors';
export const buildingRepository = { findById: async (id) => ({ id, client_id: 'x' }) };`,
  // Real UUID validator, re-exported: the parser's own behaviour is preserved.
  clients: `export { isValidUuid } from './client.validation';`,
  'context-access': `export const contextAccessService = {
    getAccessibleBuildingIds: async () => globalThis.__PTW_CTL.scope,
    assertBuildingAccess: async () => undefined,
  };`,
  // Real code normalizer/validator, re-exported: approvalStage/approvalType go
  // through the genuine trim+upper-case authority.
  'work-requests': `export { isValidRequestType, normalizeRequestType } from './work-request.validation';`,
};
for (const d of INERT) {
  STUB_SRC[d] = inertNames(d).map((n) => `export const ${n} = () => {};`).join('\n');
}

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'pg') return { url: 'stub:pg', shortCircuit: true };
    // A stub module's parentURL is `stub:<name>`, which is not a hierarchical URL, so its
    // own relative re-exports must be resolved against the real directory it replaces.
    if (spec.startsWith('.') && ctx.parentURL?.startsWith('stub:')) {
      const dir = STUB_DIR[ctx.parentURL.slice(5)];
      if (!dir) return next(spec, ctx);
      let abs = path.resolve(ROOT, dir, spec);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        if (fs.existsSync(`${abs}.ts`)) abs = `${abs}.ts`;
        else abs = path.join(abs, 'index.ts');
      }
      return { url: pathToFileURL(abs).href, shortCircuit: true };
    }
    if (spec.startsWith('.') && ctx.parentURL?.startsWith('file:')) {
      const base = path.dirname(fileURLToPath(ctx.parentURL));
      let abs = path.resolve(base, spec);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        if (fs.existsSync(`${abs}.ts`)) abs = `${abs}.ts`;
        else if (fs.existsSync(path.join(abs, 'index.ts'))) abs = path.join(abs, 'index.ts');
      }
      const name = STUBS.get(abs);
      if (name) return { url: `stub:${name}`, shortCircuit: true };
      return { url: pathToFileURL(abs).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:pg') {
      return { format: 'module', shortCircuit: true, source: 'export class Pool {}\nexport default { Pool };' };
    }
    if (url.startsWith('stub:')) {
      return { format: 'module', shortCircuit: true, source: STUB_SRC[url.slice(5)] ?? '' };
    }
    return next(url, ctx);
  },
});

const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const registry = await import('../src/modules/reporting-export/reporting-export.registry.ts');
const ptw = await import('../src/modules/permit-to-work-register/index.ts');

const DATASETS = types.REPORTING_EXPORT_DATASETS;
const ADAPTER = registry.REPORTING_EXPORT_DATASET_REGISTRY.PERMIT_TO_WORK;
const openapi = rd('docs/api/openapi.yaml');
const docBlock = openapi.slice(
  openapi.indexOf('    ReportArchiveDataset:'),
  openapi.indexOf('    ReportArchiveFormat:'),
);
const docEnum = docBlock.slice(docBlock.indexOf('enum:'), docBlock.indexOf('description:'));
const openapiDatasets = [...docEnum.matchAll(/[A-Z][A-Z0-9_]{3,}/g)].map((m) => m[0]);

/**
 * The owning parser reports field-level failures on `AppError.details`, never in `.message`
 * (always the generic 'Request validation failed.'), so match the details plus the 400.
 */
function throwsDetail(fn, re) {
  assert.throws(fn, (e) => {
    assert.equal(e.statusCode, 400);
    const text = (e.details ?? []).map((d) => `${d.field}: ${d.message}`).join(' | ');
    assert.match(text, re);
    return true;
  });
}

/** Runs the REAL adapter end to end: parser -> service -> repository map -> projection. */
async function load(query) {
  ctl.queries = [];
  return ADAPTER.load(query, USER);
}

test('R10 PART 14 — dataset enum grew 15 -> 16 (surface now 17 after PART 15) with runtime/OpenAPI parity', () => {
  // R10 PART 15 appended SECURITY_OPERATIONAL_DETAIL as the seventeenth dataset, so the counts
  // PART 14 originally proved (16) are stale. PERMIT_TO_WORK itself is untouched: same spelling,
  // same position (index 15), still exactly one enum entry for the dataset and its two views.
  assert.equal(DATASETS.length, 17);
  assert.ok(DATASETS.includes('PERMIT_TO_WORK'));
  assert.equal(DATASETS[15], 'PERMIT_TO_WORK');
  // ONE dataset with two views: no per-view enum entries and no aliases.
  assert.deepEqual(DATASETS.filter((d) => d.startsWith('PERMIT_TO_WORK')), ['PERMIT_TO_WORK']);
  assert.equal(openapiDatasets.length, 17);
  assert.deepEqual([...openapiDatasets].sort(), [...DATASETS].sort());
  const keys = Object.keys(registry.REPORTING_EXPORT_DATASET_REGISTRY);
  assert.equal(keys.length, 17);
  assert.deepEqual([...keys].sort(), [...DATASETS].sort());
});

test('R10 PART 14 — adapter metadata reuses permit.read and adds no CSV default', () => {
  assert.equal(ADAPTER.dataset, 'PERMIT_TO_WORK');
  assert.equal(ADAPTER.datasetLabel, 'Permit To Work');
  assert.match(ADAPTER.sourceAuthority, /permit-to-work-register/);
  assert.equal(ADAPTER.requiredReadPermission, 'permit.read');
  for (const forbidden of ['permit.manage', 'permit.approve', 'reporting.read', 'admin']) {
    assert.notEqual(ADAPTER.requiredReadPermission, forbidden);
  }
  // OPERATIONAL_DETAIL stays the only dataset with a csvDefaultTableKey.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.PERMIT_TO_WORK, undefined);
});

test('R10 PART 14 — parsing is delegated to the owning parser, never duplicated', () => {
  const { parsePermitToWorkRegisterQuery } = ptw;
  // view is REQUIRED: no default, no inference from the filters present.
  throwsDetail(() => parsePermitToWorkRegisterQuery({}), /view is required/);
  throwsDetail(() => parsePermitToWorkRegisterQuery({ view: 'BOTH' }), /view must be one of/);
  // The owning parser normalizes case itself; Reporting adds no lowercase parser.
  assert.equal(parsePermitToWorkRegisterQuery({ view: 'lifecycle' }).view, 'LIFECYCLE');

  // The parser emits ONLY supplied keys (conditional spreads), so the contract is proven by
  // supplying every key of each view PLUS params that must never be accepted, then asserting
  // the resulting key set exactly. Checking an unsupplied key would be a tautology.
  const NOISE = {
    clientId: CLIENT, page: '2', limit: '50', offset: '10', sort: 'createdAt',
    search: 'ptw', currentApproval: 'true', latestApproval: 'true', decisionActor: USER,
  };
  const COMMON = {
    buildingId: B1, permitApplicationId: APP, permitId: PERMIT,
    applicationStatus: 'SUBMITTED', permitStatus: 'DRAFT',
    dateFrom: '2026-01-01', dateTo: '2026-04-01',
  };
  const life = parsePermitToWorkRegisterQuery({ view: 'LIFECYCLE', ...COMMON, ...NOISE });
  assert.deepEqual(Object.keys(life.filters).sort(), [
    'applicationStatus', 'buildingId', 'dateFrom', 'dateTo', 'permitApplicationId',
    'permitId', 'permitStatus',
  ]);
  assert.equal(life.filters.dateFrom, '2026-01-01');
  assert.equal(life.filters.dateTo, '2026-04-01');
  assert.equal(life.filters.buildingId, B1);

  const appr = parsePermitToWorkRegisterQuery({
    view: 'APPROVAL', ...COMMON, ...NOISE,
    approvalStage: 'stage_one', approvalType: 'hot_work', approvalStatus: 'PENDING',
    reviewStatus: 'PENDING', decision: 'APPROVED', assignedApproverUserId: USER,
  });
  assert.deepEqual(Object.keys(appr.filters).sort(), [
    'applicationStatus', 'approvalStage', 'approvalStatus', 'approvalType',
    'assignedApproverUserId', 'buildingId', 'dateFrom', 'dateTo', 'decision',
    'permitApplicationId', 'permitId', 'permitStatus', 'reviewStatus',
  ]);
  // Real normalizeRequestType authority: the free-form code is upper-cased, never mapped to
  // a vocabulary and never ranked into a workflow position.
  assert.equal(appr.filters.approvalStage, 'STAGE_ONE');
  assert.equal(appr.filters.approvalType, 'HOT_WORK');

  // An approval-only filter under LIFECYCLE is REJECTED, never silently stripped.
  throwsDetail(
    () => parsePermitToWorkRegisterQuery({ view: 'LIFECYCLE', approvalStage: 'STAGE_ONE' }),
    /approvalStage: .*only valid for view=APPROVAL/,
  );
  // Those params WERE supplied above and still never reach the filter contract, so neither
  // a pagination/sort/search surface nor a clientId or current/latest/decisionActor selector
  // exists on either view.
  for (const k of Object.keys(NOISE)) {
    assert.equal(k in life.filters, false, `${k} must never reach the filters`);
    assert.equal(k in appr.filters, false, `${k} must never reach the filters`);
  }
});

test('R10 PART 14 — view=LIFECYCLE returns exactly one table at the application grain', async () => {
  ctl.scope = [B1]; ctl.lifecycleRows = [LIFECYCLE_DB]; ctl.approvalRows = [];
  const res = await load({ view: 'LIFECYCLE', buildingId: B1 });

  assert.equal(res.projected.tables.length, 1);
  const t = res.projected.tables[0];
  assert.equal(t.key, 'permitToWorkLifecycle');
  assert.equal(t.label, 'Permit To Work Lifecycle');
  assert.deepEqual(res.projected.kpis, []);
  assert.equal(t.columns.length, 19);
  assert.deepEqual(t.columns.map((c) => c.key), LIFECYCLE_ORDER);
  assert.equal(t.rowCount, 1);
  assert.equal(t.rows.length, 1);

  // Envelope forwarded whole: authorized scope and the register's own clock.
  assert.equal(res.common.view, 'LIFECYCLE');
  assert.deepEqual(res.common.buildingScope, [B1]);
  assert.equal(res.common.buildingId, B1);
  assert.match(res.common.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(res.appliedFilters.view, 'LIFECYCLE');
  assert.equal(res.appliedFilters.buildingId, B1);
  assert.equal('approvalStage' in res.appliedFilters, false);

  // Verbatim through the REAL repository mapper: dates are ISO strings, counts numbers.
  const row = t.rows[0];
  assert.deepEqual(Object.keys(row), LIFECYCLE_ORDER);
  assert.equal(row.permitApplicationId, APP);
  assert.equal(row.requestedWorkAt, '2026-03-01T08:00:00.000Z');
  assert.equal(row.cancelledAt, null);
  assert.equal(row.workLifecycleStatus, 'IN_PROGRESS');
  assert.equal(row.validityStatus, 'VALID');
  assert.equal(row.approvalCount, 2);
  assert.equal(row.pendingApprovalCount, 1);
  for (const v of Object.values(row)) {
    assert.ok(v === null || ['string', 'number', 'boolean'].includes(typeof v),
      `renderer-unsafe cell: ${JSON.stringify(v)}`);
  }
  // Counts only: this grain carries no per-approval fact.
  for (const k of ['approvalId', 'approvalStage', 'approvalType', 'approvalStatus',
    'assignedApproverUserId']) {
    assert.equal(k in row, false, `LIFECYCLE must not expose ${k}`);
  }
  assert.equal(ctl.queries.length, 1);
  assert.match(ctl.queries[0], /AS approval_count/);
});

test('R10 PART 14 — view=APPROVAL returns exactly one table and keeps the 1:N child rows', async () => {
  ctl.scope = [B1]; ctl.lifecycleRows = []; ctl.approvalRows = APPROVAL_DB;
  const res = await load({ view: 'approval', buildingId: B1, approvalStage: 'stage_one' });

  assert.equal(res.projected.tables.length, 1);
  const t = res.projected.tables[0];
  assert.equal(t.key, 'permitToWorkApproval');
  assert.equal(t.label, 'Permit To Work Approval');
  assert.deepEqual(res.projected.kpis, []);
  assert.deepEqual(t.columns.map((c) => c.key), APPROVAL_ORDER);
  assert.equal(t.columns.length, 19);
  // 1:N preserved: two bindings for one application stay two rows.
  assert.equal(t.rowCount, 2);
  assert.deepEqual(t.rows.map((r) => r.permitApplicationId), [APP, APP]);
  assert.deepEqual(t.rows.map((r) => r.approvalId), [AP1, AP2]);

  assert.equal(res.common.view, 'APPROVAL');
  assert.deepEqual(res.common.buildingScope, [B1]);
  assert.equal(res.appliedFilters.view, 'APPROVAL');
  assert.equal(res.appliedFilters.approvalStage, 'STAGE_ONE');

  // approvalStatus is the owning domain's derivation copied VERBATIM: a PENDING
  // review yields PENDING, a COMPLETED review yields its decision. reviewStatus and
  // decision stay separate published inputs and are never re-judged here.
  assert.deepEqual(t.rows.map((r) => r.approvalStatus), ['APPROVED', 'PENDING']);
  assert.deepEqual(t.rows.map((r) => r.reviewStatus), ['COMPLETED', 'PENDING']);
  assert.deepEqual(t.rows.map((r) => r.decision), ['APPROVED', null]);
  // Three independent status dimensions; never one combined `status`.
  assert.equal('status' in t.rows[0], false);
  assert.equal(t.rows[0].applicationStatus, 'SUBMITTED');
  assert.equal(t.rows[0].permitStatus, 'DRAFT');
  // notes is the current mutable value only; NULL stays NULL.
  assert.deepEqual(t.rows.map((r) => r.notes), ['Current note only', null]);
  // Assignment, not attribution: labelled as an assignee, never a decision actor.
  const labels = t.columns.map((c) => c.label);
  assert.ok(labels.includes('Assigned Approver User Id'));
  for (const banned of ['Decision By', 'Approved By', 'Rejected By', 'Decided By',
    'Current Approval', 'Latest Approval', 'Next Stage', 'Current Stage']) {
    assert.equal(labels.includes(banned), false, `forbidden label ${banned}`);
  }
  assert.equal(ctl.queries.length, 1);
  assert.match(ctl.queries[0], /AS approval_id/);
});

test('R10 PART 14 — empty authorized scope fails closed without touching the repository', async () => {
  ctl.scope = []; ctl.lifecycleRows = [LIFECYCLE_DB]; ctl.approvalRows = APPROVAL_DB;
  const res = await load({ view: 'LIFECYCLE' });
  assert.equal(ctl.queries.length, 0);
  assert.deepEqual(res.common.buildingScope, []);
  assert.equal(res.projected.tables.length, 1);
  assert.equal(res.projected.tables[0].key, 'permitToWorkLifecycle');
  assert.equal(res.projected.tables[0].rowCount, 0);
  assert.deepEqual(res.projected.kpis, []);
});

test('R10 PART 14 — projections are pure, verbatim and free of derivation', () => {
  const src = rd('src/modules/reporting-export/reporting-export.r10-projections.ts');
  const reg = rd('src/modules/reporting-export/reporting-export.registry.ts');
  // Comments are stripped first: the adapter's own prose deliberately says "neither
  // `new Date()` nor `Date.now()` appears in this adapter", so a raw scan would match the
  // sentence that documents the absence of the call.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const ptwSlice = strip(reg.slice(reg.indexOf('  PERMIT_TO_WORK: {'),
    reg.indexOf('appliedFilters: echoFilters(parsed.filters')));

  for (const [fn, order] of [['projectPermitToWorkLifecycle', LIFECYCLE_ORDER],
    ['projectPermitToWorkApproval', APPROVAL_ORDER]]) {
    const body = src.slice(src.indexOf(`export function ${fn}`));
    const cols = [...body.slice(0, body.indexOf('source.rows.map'))
      .matchAll(/\{ key: '(\w+)', label: '([^']+)', type: (\w+) \}/g)];
    assert.deepEqual(cols.map((c) => c[1]), order, `${fn} column order`);
    // Column types come only from the existing Reporting vocabulary.
    for (const c of cols) assert.ok(['STRING', 'NUMBER', 'DATE', 'BOOLEAN'].includes(c[3]));
  }
  // No clock is read by the adapter or the projections: asOf stays the register's own.
  assert.equal(/new Date\(|Date\.now\(/.test(ptwSlice), false);
  const ptwProjections = strip(src.slice(src.indexOf('export function projectPermitToWorkLifecycle')));
  assert.equal(/new Date\(|Date\.now\(/.test(ptwProjections), false);
  // The owning service is called exactly once, and only through the public index.
  assert.equal((ptwSlice.match(/getPermitToWorkRegister\(/g) ?? []).length, 1);
  assert.equal(/from '\.\.\/permit-to-work-register\/permit-to-work-register\.repository'/.test(reg), false);
  assert.equal(/getPermitToWork(Lifecycle|Approval)Rows/.test(reg), false);
  assert.match(reg, /from '\.\.\/permit-to-work-register';/);
  // No PTW SQL and no row post-processing live in Reporting.
  const reportingDir = 'src/modules/reporting-export';
  for (const f of fs.readdirSync(path.join(ROOT, reportingDir))) {
    if (!f.endsWith('.ts')) continue;
    const body = rd(`${reportingDir}/${f}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.equal(/permit_approval_bindings|permit_applications|permit_work_lifecycles/.test(body), false,
      `${f} must hold no PTW SQL`);
  }
  // No forbidden labels or selectors anywhere in the PART 14 projection source.
  // Scan the ACTUAL emitted label and key values, not raw substrings: the projection's own
  // doc comment legitimately says "there is no Decision By, Approved By ... column", so a raw
  // `includes` scan would match the sentence documenting the absence.
  // R10 PART 15: this slice used to run to the END OF FILE. PART 15 appended
  // projectSecurityOperationalPatrol after the two PTW projections, so its 13 patrol labels were
  // counted as PTW's (38 -> 51) and its authoritative `Status` column would have been read as a
  // PTW-invented one. End the slice at the next top-level projection export instead, which keeps
  // this proof scoped to the two PART 14 tables whatever is appended after them.
  const ptwStart = src.indexOf('export function projectPermitToWorkLifecycle');
  const afterPtw = src.indexOf('\nexport function project',
    src.indexOf('export function projectPermitToWorkApproval') + 1);
  const ptwSrc = src.slice(ptwStart, afterPtw === -1 ? src.length : afterPtw);
  const labels = [...ptwSrc.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const keys = [...ptwSrc.matchAll(/\{ key: '(\w+)'/g)].map((m) => m[1]);
  assert.equal(labels.length, 38, 'two tables x 19 labels');
  assert.equal(keys.length, 38, 'two tables x 19 keys');
  for (const banned of ['Current Approval', 'Latest Approval', 'Next Approval',
    'Remaining Approval', 'Required Approval', 'Decision By', 'Approved By', 'Rejected By',
    'Decided By', 'Current Stage', 'Next Stage', 'Status']) {
    assert.equal(labels.includes(banned), false, `forbidden label ${banned}`);
  }
  for (const banned of ['currentApproval', 'latestApproval', 'nextApproval',
    'remainingApproval', 'requiredApproval', 'decisionBy', 'approvedBy', 'rejectedBy',
    'status']) {
    assert.equal(keys.includes(banned), false, `forbidden column ${banned}`);
  }
  // The frozen PART 12/13 module is byte-unchanged.
  const frozen = {
    'index.ts': '6289b4ae1b2f00dcee6ee3418d79deb0f95a13cc',
    'permit-to-work-register.repository.ts': 'c6486348b7fbd2238c858d83acf8e087293fa1f2',
    'permit-to-work-register.service.ts': 'c1377a1f83190784f76f7efc8d6d26ee1812f1c0',
    'permit-to-work-register.types.ts': 'd1bb395e8b5e063429e29f1221f42e58282b84e3',
  };
  for (const [f, hash] of Object.entries(frozen)) {
    const got = execFileSync('git', ['hash-object', `src/modules/permit-to-work-register/${f}`],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(got, hash, `${f} must stay byte-unchanged`);
  }
});

test('R10 PART 14 — OpenAPI documents the contract without inventing forbidden concepts', () => {
  // The description is a YAML FOLDED scalar, so a documented sentence is broken across
  // indented lines in the raw file. Collapse whitespace before matching, otherwise every
  // multi-word claim fails for a reason that has nothing to do with the documentation.
  const doc = docBlock.slice(docBlock.indexOf('PERMIT_TO_WORK (R10)')).replace(/\s+/g, ' ');
  assert.ok(doc.length > 1000, 'PERMIT_TO_WORK documentation must be present');
  for (const claim of [
    'requires permit.read', 'view is REQUIRED', 'LIFECYCLE or APPROVAL', 'has no default',
    'permitToWorkLifecycle', 'permitToWorkApproval', 'one row per permit application',
    'one row per approval binding', 'one-to-many', 'never collapsed',
    'aggregate counts only', 'no stage precedence', 'free-form persisted values',
    'records assignment only', 'neither is a decision actor', 'requestedWorkAt',
    'createdAt', 'copied verbatim', 'never a note history', 'Building-scoped only',
    'No KPI is calculated', 'ONE dataset with TWO required presentation views',
    'exactly one table and never both',
  ]) {
    assert.ok(doc.includes(claim), `missing documented claim: ${claim}`);
  }
  // Forbidden concepts appear only inside explicit negations, never as a surface.
  for (const banned of ['latestApproval', 'currentApproval', 'decisionActor', 'nextStage',
    'approvedBy', 'rejectedBy', 'decisionBy', 'PERMIT_TO_WORK_LIFECYCLE', 'PERMIT_TO_WORK_APPROVAL']) {
    assert.equal(doc.includes(banned), false, `${banned} must not be documented`);
  }
  assert.equal(doc.includes('There is no current, latest, next or active approval'), true);
});
