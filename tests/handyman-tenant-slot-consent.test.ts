import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {migrations} from '../src/database/migrations';
import {migration0434CreateHandymanTenantSlotConsents} from '../src/database/migrations/0434_create_handyman_tenant_slot_consents';
import {AppError, ERROR_CODES} from '../src/shared/errors';
import {acceptTenantSlotChoice, type TenantSlotConsentDeps} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.service';
import {confirmTenantSlotVisit} from '../src/modules/handyman-appointment-contract/handyman-visit-confirmation.service';
import {createHandymanTenantSlotConsentRouter} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.routes';
import {
  signTenantSlotChoiceAssertion,
  type TenantSlotChoiceAssertion,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — slot-choice ingest and confirmation gate.
 *
 * Real service code with an injected fake pool and transaction (no live DB).
 * Proves: any trust failure rejects before a transaction; a verified choice
 * writes consent + TENANT_SELECTED only (never CONFIRMED); replay, stale
 * version, slot drift and scope drift each fail closed with no visit write;
 * and confirmation is disabled while BM authority is not provisioned.
 */
const SECRET = 'bm-slot-secret-0123456789abcdef';
const ENV = {HANDYMAN_VISIT_SLOT_SECRET_BM_TENANT: SECRET} as NodeJS.ProcessEnv;
const ids = {request: randomUUID(), appointment: randomUUID(), client: randomUUID(), building: randomUUID(),
  company: randomUUID(), pic: randomUUID(), context: randomUUID(), integration: randomUUID()};
const FUTURE_START = new Date(Date.now() + 3 * 24 * 3600_000);
const FUTURE_END = new Date(FUTURE_START.getTime() + 3600_000);

function signed(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  const body = {
    iss: 'BM_TENANT', aud: 'handyman-backend', purpose: 'TENANT_SLOT_CHOICE',
    jti: `slot-jti-${randomUUID()}`, iat: new Date(now).toISOString(), exp: new Date(now + 120_000).toISOString(),
    handymanRequestId: ids.request, appointmentId: ids.appointment, appointmentVersion: 1, kind: 'INSPECTION',
    tenantCompanyId: ids.company, buildingId: ids.building, tenantPicId: ids.pic,
    tenantUserReference: 'bm-user-ref-1', selectedStartAt: FUTURE_START.toISOString(),
    selectedEndAt: FUTURE_END.toISOString(), bmConsentEvidenceId: `bm-evidence-${randomUUID()}`,
    method: 'BM_AUTHENTICATED_TENANT_SELECTION', ...overrides,
  } as TenantSlotChoiceAssertion;
  return {body, header: signTenantSlotChoiceAssertion(body, SECRET)};
}

type Fixture = {
  integration?: {status: string; scoped: boolean} | null;
  appointment?: Partial<Record<string, unknown>>;
  consentError?: {code: string; constraint?: string};
  resolved?: Partial<Record<string, unknown>>;
  requestBinding?: string;
};

function harness(fixture: Fixture = {}) {
  const calls: string[] = [];
  const appointment = {
    id: ids.appointment, clientId: ids.client, handymanRequestId: ids.request, tenantCompanyId: ids.company,
    buildingId: ids.building, kind: 'INSPECTION', state: 'PROPOSED', version: 1,
    startAt: FUTURE_START, endAt: FUTURE_END, ...fixture.appointment,
  };
  const fakeTx = {
    async query(sql: string, params: unknown[] = []) {
      calls.push(sql.trim().split('\n')[0].slice(0, 60));
      if (sql.includes('FROM handyman_service_requests')) {
        return {rows: [{id: fixture.requestBinding ?? ids.request, clientId: ids.client, buildingId: ids.building,
          status: 'INSPECTION_REQUIRED', timezone: 'Asia/Jakarta'}], rowCount: 1};
      }
      if (sql.includes('FROM handyman_visit_appointments') && sql.includes('FOR UPDATE')) {
        return {rows: [appointment], rowCount: 1};
      }
      if (sql.includes('INSERT INTO handyman_visit_tenant_slot_consents')) {
        if (fixture.consentError) throw Object.assign(new Error('constraint'), fixture.consentError);
        assert.equal(params[0] !== undefined, true);
        return {rows: [], rowCount: 1};
      }
      if (sql.includes('UPDATE handyman_visit_appointments')) return {rows: [], rowCount: 1};
      if (sql.includes('INSERT INTO operational_events')) {
        return {rows: [{id: randomUUID(), event_type: 'x', entity_type: 'x', entity_id: ids.appointment,
          summary: 'x', metadata: {}, created_at: new Date()}], rowCount: 1};
      }
      throw new Error(`unexpected SQL in fake transaction: ${sql.slice(0, 80)}`);
    },
  } as unknown as PoolClient;
  let transactions = 0;
  let resolverCalls = 0;
  const deps: TenantSlotConsentDeps = {
    resolveTenantContext: async () => {
      resolverCalls += 1;
      return {clientId: ids.client, tenantCompanyId: ids.company, buildingId: ids.building,
        tenantPicId: ids.pic, tenantBuildingContextId: ids.context, ...fixture.resolved} as never;
    },
    db: {query: async (sql: string) => {
      assert.match(sql, /FROM handyman_handoff_integrations/);
      const integration = fixture.integration === undefined
        ? {id: ids.integration, integrationCode: 'BM_TENANT', status: 'ACTIVE', scoped: true}
        : fixture.integration === null ? undefined : {id: ids.integration, integrationCode: 'BM_TENANT', ...fixture.integration};
      return {rows: integration ? [integration] : [], rowCount: integration ? 1 : 0};
    }} as never,
    transact: async <T>(work: (tx: PoolClient) => Promise<T>) => {
      transactions += 1;
      return work(fakeTx);
    },
  };
  return {deps, calls, get transactions() { return transactions; }, get resolverCalls() { return resolverCalls; }};
}

async function expectRejects(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    return true;
  });
}

const invalid = (p: Promise<unknown>) => expectRejects(p, ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID, 401);

test('verified BM choice records consent and moves the visit to TENANT_SELECTED only', async () => {
  const h = harness();
  const {body, header} = signed();
  const result = await acceptTenantSlotChoice(body, header, h.deps, ENV);
  assert.equal(result.state, 'TENANT_SELECTED');
  assert.equal(result.version, 2);
  assert.equal(result.confirmedBooking, false, 'never CONFIRMED from tenant choice');
  assert.equal(h.transactions, 1);
  const consentAt = h.calls.findIndex(c => c.includes('INSERT INTO handyman_visit_tenant_slot_consents'));
  const updateAt = h.calls.findIndex(c => c.includes('UPDATE handyman_visit_appointments'));
  assert.ok(consentAt > 0 && updateAt > consentAt, 'consent is written before the visit moves');
  assert.ok(h.calls.some(c => c.includes('INSERT INTO operational_events')), 'audit in the same transaction');
});

test('trust failures reject before any transaction or tenant resolution', async () => {
  const {body, header} = signed();
  let h = harness({integration: null});
  await invalid(acceptTenantSlotChoice(body, header, h.deps, ENV));
  assert.equal(h.transactions + h.resolverCalls, 0, 'unknown integration');

  h = harness({integration: {status: 'ACTIVE', scoped: false}});
  await invalid(acceptTenantSlotChoice(body, header, h.deps, ENV));
  assert.equal(h.transactions + h.resolverCalls, 0, 'no scope grant');

  h = harness();
  await invalid(acceptTenantSlotChoice(body, header, h.deps, {} as NodeJS.ProcessEnv));
  assert.equal(h.transactions + h.resolverCalls, 0, 'secret not deployed');

  h = harness();
  await invalid(acceptTenantSlotChoice(body, signTenantSlotChoiceAssertion(body, 'wrong-secret-0123456789abcdef'), h.deps, ENV));
  assert.equal(h.transactions + h.resolverCalls, 0, 'bad signature');

  h = harness();
  const stale = signed({iat: new Date(Date.now() - 600_000).toISOString(), exp: new Date(Date.now() - 500_000).toISOString()});
  await invalid(acceptTenantSlotChoice(stale.body, stale.header, h.deps, ENV));
  assert.equal(h.transactions + h.resolverCalls, 0, 'expired assertion');

  h = harness();
  await invalid(acceptTenantSlotChoice({...body, extra: 1}, header, h.deps, ENV));
  assert.equal(h.transactions + h.resolverCalls, 0, 'unknown member');
});

test('tenant identity mismatch from the resolver fails closed without a visit write', async () => {
  const {body, header} = signed();
  const h = harness({resolved: {tenantPicId: null}});
  await invalid(acceptTenantSlotChoice(body, header, h.deps, ENV));
  assert.equal(h.transactions, 0);
  const other = harness({resolved: {tenantPicId: randomUUID()}});
  await invalid(acceptTenantSlotChoice(body, header, other.deps, ENV));
  assert.equal(other.transactions, 0);
});

test('stale version, non-PROPOSED state, slot drift, scope drift and started slot all conflict', async () => {
  const {body, header} = signed();
  const cases: Array<[string, Fixture]> = [
    ['stale version', {appointment: {version: 2}}],
    ['not PROPOSED', {appointment: {state: 'TENANT_SELECTED'}}],
    ['slot drift', {appointment: {startAt: new Date(FUTURE_START.getTime() + 60_000)}}],
    ['client scope drift', {resolved: {clientId: randomUUID()}}],
    ['building drift', {resolved: {buildingId: randomUUID()}}],
    ['request binding drift', {requestBinding: randomUUID()}],
    ['kind mismatch', {appointment: {kind: 'EXECUTION'}}],
    ['started slot', {appointment: {startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 60_000)}}],
  ];
  for (const [name, fixture] of cases) {
    const h = harness(fixture);
    const started = name === 'started slot';
    const request = started ? signed({selectedStartAt: new Date(Date.now() - 60_000).toISOString(),
      selectedEndAt: new Date(Date.now() + 60_000).toISOString()}) : {body, header};
    const expected = name === 'stale version' || name === 'not PROPOSED'
      ? ERROR_CODES.HANDYMAN_VISIT_STATE_CONFLICT : ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT;
    await expectRejects(acceptTenantSlotChoice(request.body, request.header, h.deps, ENV), expected, 409);
    assert.equal(h.calls.some(c => c.includes('INSERT INTO handyman_visit_tenant_slot_consents')), false,
      `${name}: no consent is written`);
    assert.equal(h.calls.some(c => c.includes('UPDATE handyman_visit_appointments')), false,
      `${name}: visit is not moved`);
  }
});

test('one-time use: replayed JTI or BM evidence and a second consent both fail closed', async () => {
  const {body, header} = signed();
  let h = harness({consentError: {code: '23505', constraint: 'handyman_visit_consents_jti_unique'}});
  await expectRejects(acceptTenantSlotChoice(body, header, h.deps, ENV),
    ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED, 409);
  assert.equal(h.calls.some(c => c.includes('UPDATE handyman_visit_appointments')), false, 'no visit write on replay');

  h = harness({consentError: {code: '23505', constraint: 'handyman_visit_consents_evidence_unique'}});
  await expectRejects(acceptTenantSlotChoice(body, header, h.deps, ENV),
    ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED, 409);

  h = harness({consentError: {code: '23505', constraint: 'handyman_visit_consents_one_per_appointment'}});
  await expectRejects(acceptTenantSlotChoice(body, header, h.deps, ENV),
    ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT, 409);
  assert.equal(h.calls.some(c => c.includes('UPDATE handyman_visit_appointments')), false);

  h = harness({consentError: {code: '23514'}});
  await expectRejects(acceptTenantSlotChoice(body, header, h.deps, ENV),
    ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT, 409);
});

test('confirmation is disabled and touches no database while BM consent authority is absent', async () => {
  let admitted = false;
  await expectRejects(confirmTenantSlotVisit(ids.request, ids.appointment, 2, randomUUID(), {
    admitResource: async () => { admitted = true; },
    authorityConfigured: async () => false,
  }), ERROR_CODES.HANDYMAN_VISIT_CONFIRMATION_DISABLED, 409);
  assert.equal(admitted, false, 'no eligibility check and no lock when disabled');
});

test('migration 0434 is registered and carries the consent guards without granting any integration', async () => {
  assert.ok(migrations.some(m => m.id === '0434_create_handyman_tenant_slot_consents'), 'registered');
  const sql: string[] = [];
  const client = {query: async (text: string) => { sql.push(text); return {rows: [], rowCount: 0}; }} as unknown as PoolClient;
  await migration0434CreateHandymanTenantSlotConsents.up(client);
  const ddl = sql.join('\n');
  for (const required of [
    'tenant_slot_choice_scope BOOLEAN NOT NULL DEFAULT FALSE',
    'CREATE TABLE handyman_visit_tenant_slot_consents',
    'handyman_visit_consents_jti_unique UNIQUE (integration_id, assertion_jti)',
    'handyman_visit_consents_evidence_unique UNIQUE (integration_id, bm_consent_evidence_id)',
    'handyman_visit_consents_one_per_appointment UNIQUE (appointment_id)',
    "method = 'BM_AUTHENTICATED_TENANT_SELECTION'",
    'BEFORE UPDATE OR DELETE ON handyman_visit_tenant_slot_consents',
    'DEFERRABLE INITIALLY DEFERRED',
    "ERRCODE = '23514'",
  ]) assert.ok(ddl.includes(required), `DDL missing: ${required}`);
  assert.equal(/INSERT INTO handyman_handoff_integrations/.test(ddl), false, 'no integration grant in migration');
  assert.equal(/tenant_slot_choice_scope BOOLEAN NOT NULL DEFAULT TRUE/.test(ddl), false, 'scope default must be FALSE');
});

test('slot-choice ingest and Ops confirm are mounted on their own router, not the visit router', () => {
  const paths = ((createHandymanTenantSlotConsentRouter() as unknown as {stack: Array<{route?: {path: string; methods: Record<string, boolean>}}>}).stack)
    .filter(layer => layer.route)
    .map(layer => `${Object.keys(layer.route!.methods).map(m => m.toUpperCase()).join(',')} ${layer.route!.path}`);
  assert.deepEqual(paths.sort(), [
    'POST /handyman/integrations/tenant-slot-choices',
    'POST /handyman/requests/:handymanRequestId/visits/:appointmentId/confirm',
  ]);
});
