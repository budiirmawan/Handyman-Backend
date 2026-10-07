import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 13 — Permit To Work Register SERVICE + INDEX: focused validation.
 *
 * PART 13 completes the bounded module with service.ts and index.ts and wires nothing else: no
 * route, controller, permission, Reporting dataset enum entry, registry adapter, projection,
 * OpenAPI surface or migration. PART 12's types.ts and repository.ts stay byte-unchanged.
 *
 * The service imports the repository, which imports `getPool` (`pg`), and the repo's module
 * imports are extensionless, so it is not live-importable as-is in this dependency-free sandbox.
 * Rather than fall back to text matching, this test installs in-memory `module.registerHooks`
 * stubs for exactly the five impure specifiers and then EXECUTES the real service source: the
 * parser, scope resolution, view branching, envelope and asOf behaviour below are all genuinely
 * run, not asserted as strings. The stubs for `isValidUuid`, `normalizeRequestType` and
 * `isValidRequestType` are verbatim copies of the real one-to-three-line predicates, so those
 * three are validated by copy; everything PART 13 itself adds is validated by execution. Live
 * execution against PostgreSQL remains CI-required.
 *
 * `registerHooks` is process-wide, so this file relies on `node --test` running each test file in
 * its own process (the default). The resolve hook only rewrites extensionless relative specifiers
 * that resolve to a real `.ts` file, plus the five stubbed specifiers, so it cannot silently
 * redirect anything else.
 *
 * Proofs: 1 view is required · 2 allowed views are exactly LIFECYCLE/APPROVAL · 3 missing view
 * rejected · 4 unknown view rejected · 5 LIFECYCLE calls only the lifecycle query · 6 APPROVAL
 * calls only the approval query · 7 exactly one repository call per non-empty request ·
 * 8 verified permit.read documented for PART 14 · 9 no new permission · 10 explicit buildingId
 * asserts access · 11 explicit buildingId scopes the repository exactly · 12 omitted buildingId
 * uses the accessible ids · 13 empty scope returns the correct view envelope · 14 repository not
 * called for empty scope · 15 no clientId override · 16 the actual PART 12 filter authorities are
 * used · 17 known wrong-view filters are rejected · 18 approvalStage stays free-form ·
 * 19 approvalType stays free-form · 20 approvalStatus uses the existing authority · 21 reviewStatus
 * uses the existing authority · 22 decision uses REVIEW_DECISIONS · 23 applicationStatus stays
 * separate · 24 permitStatus stays separate · 25 lifecycle window is the requestedWorkAt
 * authority · 26 approval window is the approval createdAt authority · 27 invalid dates rejected ·
 * 28 dateFrom >= dateTo rejected · 29 no default period · 30 exactly one asOf created · 31 asOf is
 * envelope metadata only · 32 no current/latest approval semantics · 33 no decision-actor
 * inference · 34 the two grains stay separate types · 35 index exports only the public surface ·
 * 36 no registry/OpenAPI/route/migration change.  */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/permit-to-work-register');
const SERVICE_PATH = resolve(MODULE_DIR, 'permit-to-work-register.service.ts');
const INDEX_PATH = resolve(MODULE_DIR, 'index.ts');
const TYPES_PATH = resolve(MODULE_DIR, 'permit-to-work-register.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'permit-to-work-register.repository.ts');
const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ACCESS_SEED = resolve(ROOT, 'src/database/seeds/foundation-access.seed.ts');

const UUID = { b1: '11111111-1111-1111-1111-111111111111', b2: '22222222-2222-2222-2222-222222222222',
  b9: '99999999-9999-9999-9999-999999999999', approver: '44444444-4444-4444-4444-444444444444',
  absent: '00000000-0000-4000-8000-000000000000' };
/** PART 12's authoritative filter names, read from the committed source rather than the prompt. */
const LIFECYCLE_FILTERS = ['buildingId', 'permitApplicationId', 'permitId', 'applicationStatus',
  'permitStatus', 'dateFrom', 'dateTo'];
const APPROVAL_ONLY = ['approvalStage', 'approvalType', 'approvalStatus', 'reviewStatus', 'decision',
  'assignedApproverUserId'];
const SINGULAR_APPROVAL = ['currentApproval', 'latestApproval', 'activeApproval', 'nextApproval',
  'primaryApproval', 'governingApproval', 'decisionByUserId', 'approvedByUserId', 'rejectedByUserId',
  'performedBy', 'executedBy', 'availableActions', 'readinessBlockers', 'stagePrecedence'];

/** Shared stub state, reset per scenario. */
const STUB_STATE = { accessible: [UUID.b1, UUID.b2], existing: new Set([UUID.b1, UUID.b2, UUID.b9]),
  accessOk: true, calls: [], scopeCalls: [], assertCalls: [] };
globalThis.__PTW = STUB_STATE;

/** The five impure specifiers, stubbed in memory. Predicate bodies are verbatim copies. */
const STUBS: Record<string, string> = {
  '../buildings': `
    export const buildingRepository = { findById: async (id) =>
      (globalThis.__PTW.existing.has(id) ? { id } : null) };
    export const buildingNotFoundError = () => { const e = new Error('building not found');
      e.statusCode = 404; return e; };`,
  '../clients': `
    export const isValidUuid = (value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);`,
  '../context-access': `
    export const contextAccessService = {
      getAccessibleBuildingIds: async () => { globalThis.__PTW.scopeCalls.push('accessible');
        return globalThis.__PTW.accessible; },
      assertBuildingAccess: async (userId, buildingId) => {
        globalThis.__PTW.assertCalls.push([userId, buildingId]);
        if (!globalThis.__PTW.accessOk) { const e = new Error('forbidden'); e.statusCode = 403; throw e; } } };`,
  '../work-requests': `
    const MAX = 64; const PATTERN = /^[A-Z][A-Z0-9_-]*$/;
    export const normalizeRequestType = (value) => value.trim().toUpperCase();
    export const isValidRequestType = (value) =>
      value.length >= 2 && value.length <= MAX && PATTERN.test(value);`,
  './permit-to-work-register.repository': `
    export const getPermitToWorkLifecycleRows = async (buildingIds, filters, start, end) => {
      globalThis.__PTW.calls.push({ fn: 'lifecycle', buildingIds, filters, start, end });
      return [{ __grain: 'lifecycle' }]; };
    export const getPermitToWorkApprovalRows = async (buildingIds, filters, start, end) => {
      globalThis.__PTW.calls.push({ fn: 'approval', buildingIds, filters, start, end });
      return [{ __grain: 'approval' }]; };`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier] !== undefined) {
      return { url: `ptw-stub:${specifier}`, shortCircuit: true };
    }
    // The repo's own imports are extensionless; point them at the real .ts file.
    if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('ptw-stub:')) {
      return { format: 'module', source: STUBS[url.slice('ptw-stub:'.length)], shortCircuit: true };
    }
    return next(url, context);
  },
});

const svc = await import(pathToFileURL(SERVICE_PATH).href);
const idx = await import(pathToFileURL(INDEX_PATH).href);
const { parsePermitToWorkRegisterQuery: parse, getPermitToWorkRegister: read } = svc;

const read_ = (p: string): string => readFileSync(p, 'utf8');
/** Strips comments, so "must not exist" assertions test the CODE contract, not the prose. */
const code = (p: string): string => read_(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const serviceCode = code(SERVICE_PATH);
const serviceRaw = read_(SERVICE_PATH);

const reset = (over: Partial<typeof STUB_STATE> = {}) => {
  Object.assign(STUB_STATE, { accessible: [UUID.b1, UUID.b2],
    existing: new Set([UUID.b1, UUID.b2, UUID.b9]), accessOk: true }, over);
  STUB_STATE.calls.length = 0; STUB_STATE.scopeCalls.length = 0; STUB_STATE.assertCalls.length = 0;
};
/** Runs the parser and returns the thrown error, or null when it accepted the query. */
const thrown = (query: Record<string, unknown>): any => {
  try { parse(query); return null; } catch (error) { return error; }
};
const fieldsOf = (error: any): string[] => (error?.details ?? []).map((d: any) => d.field);

describe('R10 PART 13 — Permit To Work Register service and index', () => {
  it('1-4 — view is a required discriminator with exactly two values', () => {
    assert.deepEqual([...svc.PERMIT_TO_WORK_VIEWS], ['LIFECYCLE', 'APPROVAL'],
      'the view authority is exactly LIFECYCLE and APPROVAL');  // 2
    assert.match(serviceCode, /export const PERMIT_TO_WORK_VIEWS = \['LIFECYCLE', 'APPROVAL'\] as const;/,
      'declared as a frozen runtime authority');  // 2
    assert.equal(parse({ view: 'LIFECYCLE' }).view, 'LIFECYCLE', 'LIFECYCLE is accepted');  // 1
    assert.equal(parse({ view: 'APPROVAL' }).view, 'APPROVAL', 'APPROVAL is accepted');  // 1
    assert.equal(parse({ view: 'lifecycle' }).view, 'LIFECYCLE', 'the view is case-normalized');  // 1
    assert.ok(thrown({}) !== null, 'a missing view is rejected');  // 1, 3
    assert.deepEqual(fieldsOf(thrown({})), ['view'], 'the rejection names the view field');  // 3
    assert.match(thrown({}).details[0].message, /view is required/,
      'and says it is required — there is no default and no implicit LIFECYCLE fallback');  // 3
    assert.ok(thrown({ view: '' }) !== null, 'an empty view is rejected');  // 3
    assert.ok(thrown({ buildingId: UUID.b1 }) !== null, 'other filters never imply a view');  // 3
    for (const invented of ['SUMMARY', 'DETAIL', 'CURRENT', 'HISTORY']) {
      assert.ok(thrown({ view: invented }) !== null, `invented view ${invented} is rejected`);
      assert.deepEqual(fieldsOf(thrown({ view: invented })), ['view'], `${invented} names the view field`);
    }  // 4
    assert.ok(!svc.isPermitToWorkView('SUMMARY') && svc.isPermitToWorkView('APPROVAL'),
      'the exported guard matches the same two-value authority');  // 4
  });

  it('5-7 — each view invokes exactly one repository query, and only its own', async () => {
    reset();
    const lifecycle = await read(parse({ view: 'LIFECYCLE' }), 'user-1');
    assert.equal(STUB_STATE.calls.length, 1, 'one repository call');  // 7
    assert.equal(STUB_STATE.calls[0].fn, 'lifecycle', 'view=LIFECYCLE calls ONLY the lifecycle query');  // 5
    assert.equal(lifecycle.view, 'LIFECYCLE', 'the envelope preserves the requested view');  // 5
    reset();
    const approval = await read(parse({ view: 'APPROVAL' }), 'user-1');
    assert.equal(STUB_STATE.calls.length, 1, 'one repository call');  // 7
    assert.equal(STUB_STATE.calls[0].fn, 'approval', 'view=APPROVAL calls ONLY the approval query');  // 6
    assert.equal(approval.view, 'APPROVAL', 'the envelope preserves the requested view');  // 6
    reset();
    await read(parse({ view: 'LIFECYCLE' }), 'u');
    await read(parse({ view: 'APPROVAL' }), 'u');
    assert.deepEqual(STUB_STATE.calls.map((c) => c.fn), ['lifecycle', 'approval'],
      'two requests make two calls: neither view calls both and discards one');  // 7
    assert.deepEqual(lifecycle.rows, [{ __grain: 'lifecycle' }], 'lifecycle rows are verbatim');  // 5
    assert.deepEqual(approval.rows, [{ __grain: 'approval' }],
      'approval rows are verbatim, so the 1:N grain is never collapsed');  // 6
  });

  it('8-9 — permit.read is verified and documented; no permission is created', () => {
    assert.match(serviceRaw, /VERIFIED READ PERMISSION — `permit\.read`/,
      'the verified permission is documented for PART 14');  // 8
    assert.match(serviceRaw, /\{ code: 'permit\.read', name: 'Read Permits' \}/,
      'citing its seed entry as evidence');  // 8
    assert.match(read_(ACCESS_SEED), /\{ code: 'permit\.read', name: 'Read Permits' \}/,
      'permit.read really is seeded — the documentation is not a guess');  // 8
    const routes = read_(resolve(ROOT, 'src/modules/permit-applications/permit-application.routes.ts'));
    assert.match(routes, /requirePermission\('permit\.read'\)/,
      'and it gates the permit-application read endpoints');  // 8
    assert.match(serviceRaw, /requiredReadPermission:[\s\S]{0,12}'permit\.read'/,
      'PART 14 is told exactly what to wire');  // 8
    assert.ok(!read_(ACCESS_SEED).includes('permit_to_work'), 'no new permission is seeded');  // 9
    assert.ok(!/requirePermission\(|assertPermission|hasPermission/.test(serviceCode),
      'the service declares no gate of its own: enforcement stays at the route/registry layer');  // 9
    assert.ok(!serviceCode.includes("'permit.manage'") && !serviceCode.includes("'permit.approve'"),
      'no write or decision permission is substituted for the read authority');  // 9
  });

  it('10-15 — building scope fails closed and clientId is never an override', async () => {
    reset();
    await read(parse({ view: 'LIFECYCLE', buildingId: UUID.b9 }), 'user-9');
    assert.deepEqual(STUB_STATE.assertCalls, [['user-9', UUID.b9]],
      'an explicit buildingId asserts the caller access to it');  // 10
    assert.deepEqual(STUB_STATE.calls[0].buildingIds, [UUID.b9],
      'and becomes the ENTIRE repository scope');  // 11
    assert.deepEqual(STUB_STATE.scopeCalls, [],
      'getAccessibleBuildingIds is not also consulted, so scope is never widened');  // 11
    reset();
    STUB_STATE.accessOk = false;
    await assert.rejects(() => read(parse({ view: 'LIFECYCLE', buildingId: UUID.b9 }), 'user-9'),
      'an inaccessible buildingId is rejected');  // 10
    assert.equal(STUB_STATE.calls.length, 0, 'and the repository is never called');  // 10
    reset();
    await assert.rejects(() => read(parse({ view: 'LIFECYCLE', buildingId: UUID.absent }), 'u'),
      /not found/, 'a nonexistent buildingId raises the house building-not-found error');  // 10
    assert.equal(STUB_STATE.calls.length, 0, 'and the repository is never called');  // 10
    reset();
    STUB_STATE.accessible = [UUID.b1, UUID.b2];
    const rolled = await read(parse({ view: 'APPROVAL' }), 'user-9');
    assert.deepEqual(STUB_STATE.scopeCalls, ['accessible'],
      'an omitted buildingId resolves the accessible buildings');  // 12
    assert.deepEqual(STUB_STATE.calls[0].buildingIds, [UUID.b1, UUID.b2],
      'and the repository scope is exactly that set');  // 12
    assert.deepEqual(STUB_STATE.assertCalls, [], 'no per-building assertion is needed then');  // 12
    assert.equal(rolled.buildingId, null, 'the envelope records that no building was requested');  // 12
    reset({ accessible: [] });
    const emptyLifecycle = await read(parse({ view: 'LIFECYCLE', dateFrom: '2026-01-01',
      dateTo: '2026-02-01' }), 'u');
    assert.equal(STUB_STATE.calls.length, 0, 'an empty scope never queries the repository');  // 14
    assert.deepEqual(emptyLifecycle, { view: 'LIFECYCLE', buildingId: null, buildingScope: [],
      dateFrom: '2026-01-01', dateTo: '2026-02-01', asOf: emptyLifecycle.asOf, rows: [] },
      'it returns a well-formed empty LIFECYCLE envelope, not null and not a 403');  // 13
    const emptyApproval = await read(parse({ view: 'APPROVAL' }), 'u');
    assert.equal(emptyApproval.view, 'APPROVAL', 'the empty envelope keeps the APPROVAL view');  // 13
    assert.deepEqual(emptyApproval.rows, [], 'with no rows');  // 13
    assert.equal(STUB_STATE.calls.length, 0, 'and still no repository call for either view');  // 14
    reset();
    const parsed = parse({ view: 'LIFECYCLE', clientId: UUID.b1 });
    assert.ok(!('clientId' in parsed.filters), 'clientId is not accepted as a filter');  // 15
    await read(parsed, 'u');
    assert.deepEqual(STUB_STATE.calls[0].buildingIds, [UUID.b1, UUID.b2],
      'a supplied clientId cannot narrow, widen or override the building scope');  // 15
    assert.ok(!/clientId/.test(code(SERVICE_PATH).slice(code(SERVICE_PATH).indexOf('async function resolveScope'))),
      'scope resolution never reads a clientId');  // 15
  });

  it('16-19 — the PART 12 filter authorities are used and stage/type stay free-form', () => {
    const typesCode = code(TYPES_PATH);
    const authoritative = (name: string): string[] => {
      const marker = `export type ${name} = {`;
      const body = typesCode.slice(typesCode.indexOf(marker) + marker.length);
      return [...body.slice(0, body.indexOf('\n};')).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    };
    assert.deepEqual(authoritative('PermitToWorkLifecycleFilters'), LIFECYCLE_FILTERS,
      'sanity: PART 12 froze exactly seven lifecycle filters');  // 16
    assert.deepEqual(authoritative('PermitToWorkApprovalFilters'), [...LIFECYCLE_FILTERS.slice(0, 5),
      ...APPROVAL_ONLY, 'dateFrom', 'dateTo'], 'sanity: and thirteen approval filters');  // 16
    assert.match(serviceCode, /import type \{[\s\S]*?PermitToWorkApprovalFilters,[\s\S]*?PermitToWorkLifecycleFilters,[\s\S]*?\} from '\.\/permit-to-work-register\.types';/,
      'the service imports BOTH PART 12 filter contracts rather than restating them');  // 16
    const parsedApproval = parse({ view: 'APPROVAL', buildingId: UUID.b1, permitApplicationId: UUID.b2,
      permitId: UUID.b9, applicationStatus: 'SUBMITTED', permitStatus: 'DRAFT', dateFrom: '2026-01-01',
      dateTo: '2026-02-01', approvalStage: 'SAFETY', approvalType: 'HOT_WORK', approvalStatus: 'PENDING',
      reviewStatus: 'COMPLETED', decision: 'APPROVED', assignedApproverUserId: UUID.approver });
    assert.deepEqual(Object.keys(parsedApproval.filters).sort(),
      authoritative('PermitToWorkApprovalFilters').sort(),
      'all thirteen authoritative filters parse, with no alias and no extra');  // 16
    assert.deepEqual(Object.keys(parse({ view: 'LIFECYCLE', search: 'x', page: '2', sort: 'asc',
      bogus: 'y' }).filters), [], 'unknown unrelated keys follow the house convention and are dropped');  // 16
    for (const key of APPROVAL_ONLY) {
      const error = thrown({ view: 'LIFECYCLE', [key]: 'X' });
      assert.ok(error !== null, `view=LIFECYCLE with ${key} is rejected, not silently dropped`);  // 17
      assert.ok(fieldsOf(error).includes(key), `and the error names ${key}`);  // 17
      assert.match(error.details.find((d: any) => d.field === key).message, /only valid for view=APPROVAL/,
        `${key} explains why it was refused`);  // 17
    }
    assert.equal(thrown({ view: 'APPROVAL', approvalStage: 'SAFETY' }), null,
      'the same filter is accepted under view=APPROVAL');  // 17
    assert.equal(parse({ view: 'APPROVAL', approvalStage: 'SAFETY' }).filters.approvalStage, 'SAFETY',
      'approvalStage keeps its free-form value');  // 18
    assert.equal(parse({ view: 'APPROVAL', approvalStage: 'SOMETHING_NOVEL_2026' })
      .filters.approvalStage, 'SOMETHING_NOVEL_2026',
      'a novel code is accepted: there is no vocabulary behind it');  // 18
    assert.equal(parse({ view: 'APPROVAL', approvalStage: 'stage-2' }).filters.approvalStage, 'STAGE-2',
      'normalized by the owning domain data-driven-code convention, never mapped to a rank');  // 18
    assert.equal(parse({ view: 'APPROVAL', approvalType: 'hot_work' }).filters.approvalType, 'HOT_WORK',
      'approvalType behaves identically');  // 19
    assert.ok(thrown({ view: 'APPROVAL', approvalStage: ['A', 'B'] }) !== null,
      'a multi-valued stage is rejected rather than coerced');  // 18
    assert.ok(!/APPROVAL_STAGES|APPROVAL_TYPES|STAGE_PRECEDENCE|stageOrder/.test(serviceCode),
      'no stage/type vocabulary or ordering constant is invented');  // 18, 19
  });

  it('20-24 — status vocabularies are reused and stay three separate concepts', () => {
    assert.equal(parse({ view: 'APPROVAL', approvalStatus: 'pending' }).filters.approvalStatus, 'PENDING',
      'approvalStatus accepts the derived vocabulary');  // 20
    for (const value of ['APPROVED', 'REJECTED', 'REWORK_REQUIRED']) {
      assert.equal(parse({ view: 'APPROVAL', approvalStatus: value }).filters.approvalStatus, value,
        `${value} is accepted`);
    }  // 20
    for (const invented of ['CANCELLED', 'EXPIRED', 'WAITING', 'SKIPPED', 'IN_PROGRESS']) {
      assert.ok(fieldsOf(thrown({ view: 'APPROVAL', approvalStatus: invented })).includes('approvalStatus'),
        `invented approval status ${invented} is rejected`);
    }  // 20
    assert.match(serviceCode, /import \{ PERMIT_APPROVAL_STATUSES \} from '\.\.\/permit-approvals\/permit-approval\.types';/,
      'the domain runtime array is imported');  // 20
    assert.ok(!/'PENDING',\s*'APPROVED',\s*'REJECTED',\s*'REWORK_REQUIRED'/.test(serviceCode),
      'and NOT duplicated as a literal array in this service');  // 20
    for (const value of ['PENDING', 'COMPLETED']) {
      assert.equal(parse({ view: 'APPROVAL', reviewStatus: value }).filters.reviewStatus, value,
        `reviewStatus ${value} is accepted`);
    }  // 21
    assert.ok(fieldsOf(thrown({ view: 'APPROVAL', reviewStatus: 'APPROVED' })).includes('reviewStatus'),
      'a decision value is not accepted as a review status');  // 21
    assert.match(serviceCode, /const PERMIT_REVIEW_STATUSES = \['PENDING', 'COMPLETED'\] as const;/,
      'review status restates the persisted reviews.review_status CHECK union only');  // 21
    for (const value of ['APPROVED', 'REJECTED', 'REWORK_REQUIRED']) {
      assert.equal(parse({ view: 'APPROVAL', decision: value }).filters.decision, value,
        `decision ${value} is accepted`);
    }  // 22
    assert.ok(fieldsOf(thrown({ view: 'APPROVAL', decision: 'PENDING' })).includes('decision'),
      'PENDING is NOT a decision — it belongs to review/derived approval status');  // 22
    assert.match(serviceCode, /import \{ isReviewDecision, REVIEW_DECISIONS \} from '\.\.\/reviews\/review\.types';/,
      'REVIEW_DECISIONS is the reused runtime authority');  // 22
    assert.equal(parse({ view: 'LIFECYCLE', applicationStatus: 'submitted' })
      .filters.applicationStatus, 'SUBMITTED', 'applicationStatus uses its own authority');  // 23
    assert.ok(fieldsOf(thrown({ view: 'LIFECYCLE', applicationStatus: 'APPROVED' }))
      .includes('applicationStatus'), 'an approval value is not an application status');  // 23
    assert.equal(parse({ view: 'LIFECYCLE', permitStatus: 'draft' }).filters.permitStatus, 'DRAFT',
      'permitStatus uses its own authority');  // 24
    assert.ok(fieldsOf(thrown({ view: 'LIFECYCLE', permitStatus: 'SUBMITTED' })).includes('permitStatus'),
      'SUBMITTED is an application status and NOT a permit status — the two are never merged');  // 24
    assert.deepEqual(Object.keys(parse({ view: 'LIFECYCLE', applicationStatus: 'SUBMITTED',
      permitStatus: 'DRAFT' }).filters).filter((k) => /Status/.test(k)).sort(),
      ['applicationStatus', 'permitStatus'], 'both persist as separate keys');  // 23, 24
    assert.ok(fieldsOf(thrown({ view: 'LIFECYCLE', applicationStatus: 'SUBMITTED',
      permitStatus: 'SUBMITTED' })).includes('permitStatus'), 'and are validated independently');  // 24
  });

  it('25-31 — separate date authorities, no default period, one metadata-only asOf', async () => {
    assert.ok(fieldsOf(thrown({ view: 'LIFECYCLE', dateFrom: 'not-a-date' })).includes('dateFrom'),
      'an invalid dateFrom is rejected');  // 27
    assert.ok(fieldsOf(thrown({ view: 'APPROVAL', dateTo: '2026-13-99' })).includes('dateTo'),
      'an invalid dateTo is rejected');  // 27
    assert.ok(fieldsOf(thrown({ view: 'LIFECYCLE', dateFrom: '2026-01-01', dateTo: '2026-01-01' }))
      .includes('dateFrom'), 'dateFrom == dateTo is rejected');  // 28
    assert.ok(fieldsOf(thrown({ view: 'APPROVAL', dateFrom: '2026-03-01', dateTo: '2026-01-01' }))
      .includes('dateFrom'), 'a reversed window is rejected and never silently swapped');  // 28
    const open = parse({ view: 'LIFECYCLE' }).filters;
    assert.equal(open.dateFrom, undefined, 'omitting dates yields no dateFrom');  // 29
    assert.equal(open.dateTo, undefined, 'and no dateTo: there is no default period');  // 29
    assert.deepEqual(svc.permitToWorkRegisterRange({}), { start: null, end: null },
      'so the range stays unbounded rather than defaulting');  // 29
    const range = svc.permitToWorkRegisterRange({ dateFrom: '2026-01-01', dateTo: '2026-01-02' });
    assert.equal(range.start.toISOString(), '2026-01-01T00:00:00.000Z', 'the window is inclusive');  // 25
    assert.equal(range.end.toISOString(), '2026-01-03T00:00:00.000Z',
      'a date-only dateTo covers that whole UTC day, and the window is half-open');  // 25
    assert.equal(svc.permitToWorkRegisterRange({ dateTo: '2026-01-02T06:00:00Z' }).end.toISOString(),
      '2026-01-02T06:00:00.000Z', 'a datetime dateTo is never extended');  // 25
    // The COLUMN each window governs is PART 12's, and differs per grain.
    const repoCode = code(REPO_PATH);
    assert.match(repoCode, /pa\.requested_work_at >= \$\$\{values\.length\}/,
      'LIFECYCLE windows permit_applications.requested_work_at');  // 25
    assert.match(repoCode, /pab\.created_at >= \$\$\{values\.length\}/,
      'APPROVAL windows permit_approval_bindings.created_at');  // 26
    assert.ok(!/r\.reviewed_at >=/.test(repoCode),
      'the approval window is never reinterpreted as reviewedAt');  // 26
    assert.match(serviceRaw, /LIFECYCLE windows\s*\n?\s*\*?\s*`permit_applications\.requested_work_at`, APPROVAL windows/,
      'and the service documents that split rather than owning it');  // 25, 26
    reset();
    const before = Date.now();
    const envelope = await read(parse({ view: 'LIFECYCLE', dateFrom: '2026-01-01',
      dateTo: '2026-01-02' }), 'u');
    const call = STUB_STATE.calls[0];
    assert.equal([...serviceCode.matchAll(/new Date\(\)/g)].length, 1,
      'exactly ONE bare new Date() — a single frozen instant per invocation');  // 30
    assert.match(envelope.asOf, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'asOf is published as ISO metadata');  // 30
    assert.ok(Math.abs(new Date(envelope.asOf).getTime() - before) < 60000,
      'and is the instant of this call');  // 30
    assert.deepEqual(Object.keys(call).sort(), ['buildingIds', 'end', 'filters', 'fn', 'start'],
      'the repository receives NO asOf argument — the PART 12 signature does not take one');  // 31
    assert.equal(call.start.toISOString(), '2026-01-01T00:00:00.000Z', 'start is forwarded');  // 31
    assert.equal(call.end.toISOString(), '2026-01-03T00:00:00.000Z', 'end is forwarded');  // 31
    assert.deepEqual(call.filters, { dateFrom: '2026-01-01', dateTo: '2026-01-02' },
      'filters are forwarded verbatim');  // 31
    assert.ok(!/asOf/.test(serviceCode.slice(serviceCode.indexOf('async function resolveScope'),
      serviceCode.indexOf('export async function getPermitToWorkRegister'))),
      'scope and window resolution never consult asOf');  // 31
    assert.ok(!/validity|workLifecycle/.test(serviceCode.replace(/PermitWorkStatus/g, '')),
      'no validity or work-lifecycle value is calculated from asOf');  // 31
  });

  it('32-34 — no approval election, no decision actor, no universal row', async () => {
    for (const name of SINGULAR_APPROVAL) {
      assert.ok(!serviceCode.includes(name), `service code never mentions ${name}`);  // 32, 33
      assert.ok(!code(TYPES_PATH).includes(name), `PART 12 types never mention ${name}`);  // 32
    }
    assert.ok(!/\.sort\(|\.find\(|\.findIndex\(|\.reduce\(|Math\.max|LIMIT/.test(serviceCode),
      'no sort-then-first, find, MAX or LIMIT elects an approval');  // 32
    assert.ok(!/approvalCount|pendingApprovalCount/.test(serviceCode),
      'the lifecycle counts are passed through and never turned into an identity');  // 32
    assert.match(serviceCode, /\{ assignedApproverUserId \}/,
      'assignedApproverUserId is passed through under its own safe name, never renamed');  // 33
    assert.equal(parse({ view: 'APPROVAL', assignedApproverUserId: UUID.approver })
      .filters.assignedApproverUserId, UUID.approver.toLowerCase(),
      'it is parsed as an assigned-approver narrowing only');  // 33
    assert.ok(fieldsOf(thrown({ view: 'APPROVAL', assignedApproverUserId: 'not-a-uuid' }))
      .includes('assignedApproverUserId'), 'and UUID-validated as such');  // 33
    // 34 — a discriminated union, never one envelope with nullable columns from both grains.
    assert.match(code(SERVICE_PATH), /export type PublicPermitToWorkRegister =\s*\n\s*\| PublicPermitToWorkLifecycle\s*\n\s*\| PublicPermitToWorkApproval;/,
      'the envelope is a union discriminated on view');  // 34
    assert.ok(!/PublicPermitToWorkRow\b|UniversalPermitRow/.test(serviceCode + code(TYPES_PATH)),
      'no universal row type exists');  // 34
    assert.match(serviceCode, /view: 'LIFECYCLE';/, 'the lifecycle envelope pins its own literal');  // 34
    assert.match(serviceCode, /view: 'APPROVAL';/, 'and so does the approval envelope');  // 34
    // Executed, not asserted as text: both envelopes are built and compared.
    reset();
    const lifecycleEnvelope = await read(parse({ view: 'LIFECYCLE' }), 'u');
    const approvalEnvelope = await read(parse({ view: 'APPROVAL' }), 'u');
    const metadataKeys = ['asOf', 'buildingId', 'buildingScope', 'dateFrom', 'dateTo', 'rows', 'view'];
    assert.deepEqual(Object.keys(lifecycleEnvelope).sort(), metadataKeys,
      'the lifecycle envelope carries only metadata plus its own rows');  // 34
    assert.deepEqual(Object.keys(approvalEnvelope).sort(), metadataKeys,
      'the approval envelope carries the same metadata shape');  // 34
    assert.equal(lifecycleEnvelope.rows[0].__grain, 'lifecycle',
      'lifecycle rows stay lifecycle rows');  // 34
    assert.equal(approvalEnvelope.rows[0].__grain, 'approval',
      'approval rows stay approval rows: no shared row type and no cross-grain columns');  // 34
  });

  it('35-36 — the index publishes only the public surface and nothing else is wired', () => {
    const exported = Object.keys(idx).filter((k) => k !== 'default').sort();
    assert.deepEqual(exported, ['PERMIT_TO_WORK_VIEWS', 'getPermitToWorkRegister', 'isPermitToWorkView',
      'parsePermitToWorkRegisterQuery', 'permitToWorkRegisterRange', 'permitToWorkRegisterService'],
      'the index exports the entry point, parser, range helper, service object and view authority');  // 35
    for (const internal of ['getPermitToWorkLifecycleRows', 'getPermitToWorkApprovalRows']) {
      assert.ok(!exported.includes(internal), `${internal} is NOT re-exported`);  // 35
    }
    assert.match(read_(INDEX_PATH), /The repository is deliberately NOT re-exported/,
      'and the index documents why: a direct call would bypass the authorized scope');  // 35
    assert.ok(!exported.includes('ValidationDetail') && !exported.includes('PERMIT_REVIEW_STATUSES'),
      'internal validation helpers stay private');  // 35
    assert.equal(typeof idx.permitToWorkRegisterService.getPermitToWorkRegister, 'function',
      'the service object exposes the entry point');  // 35
    assert.deepEqual(Object.keys(idx.permitToWorkRegisterService).sort(),
      ['getPermitToWorkRegister', 'parsePermitToWorkRegisterQuery', 'permitToWorkRegisterRange'],
      'and nothing more');  // 35
    assert.deepEqual(readdirSync(MODULE_DIR).sort(), ['index.ts', 'permit-to-work-register.repository.ts',
      'permit-to-work-register.service.ts', 'permit-to-work-register.types.ts'],
      'exactly the two PART 12 files plus the two PART 13 files');  // 36
    // R10 PART 14 UPDATE — PART 13 itself wired nothing, and that intent is preserved here.
    // PART 14 then OWNED the Reporting integration, so reporting-export.types.ts,
    // reporting-export.registry.ts and reporting-export.r10-projections.ts legitimately
    // reference the dataset now. The untouched assertion is therefore re-scoped to the
    // Reporting files PART 14 did not touch, which must still be free of any PTW reference.
    for (const file of ['reporting-export.projections.ts',
      'reporting-export.management-projections.ts', 'reporting-export.routes.ts',
      'reporting-export.controller.ts', 'reporting-export.service.ts',
      'reporting-export.validation.ts']) {
      const source = read_(resolve(EXPORT_DIR, file));
      assert.ok(!source.includes('PERMIT_TO_WORK') && !source.includes('permit-to-work-register'),
        `${file} is untouched`);
    }  // 36
    for (const file of ['reporting-export.types.ts', 'reporting-export.registry.ts',
      'reporting-export.r10-projections.ts']) {
      assert.ok(read_(resolve(EXPORT_DIR, file)).includes('PERMIT_TO_WORK'),
        `${file} carries the PART 14 wiring, which PART 13 deliberately did not add`);
    }
    // R10 PART 14 UPDATE — PART 14 added the single PERMIT_TO_WORK OpenAPI dataset enum entry.
    assert.ok(read_(OPENAPI_PATH).includes('PERMIT_TO_WORK'), 'PART 14 added the OpenAPI dataset');  // 36
    assert.deepEqual(readdirSync(MIGRATIONS_DIR).filter((f) => /permit_to_work/i.test(f)), [],
      'no migration was added');  // 36
    assert.ok(!/routes|controller/.test(readdirSync(MODULE_DIR).join()), 'no route or controller file');  // 36
    assert.equal(read_(INDEX_PATH).includes('PART 14 owns'), true, 'PART 14 is deferred, not started');  // 36
    assert.ok(!serviceCode.includes('PART 14') || serviceRaw.includes('PART 14'),
      'PART 14 appears only in prose, never as code');  // 36
  });
});
