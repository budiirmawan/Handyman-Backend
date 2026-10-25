import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {migrations} from '../src/database/migrations';
import {migration0434CreateHandymanTenantSlotConsents} from '../src/database/migrations/0434_create_handyman_tenant_slot_consents';
import {AppError, ERROR_CODES} from '../src/shared/errors';
import {acceptTenantSlotChoice, type TenantSlotConsentDeps} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.service';
import {defaultVisitConfirmationPorts} from '../src/modules/handyman-appointment-contract/handyman-visit-confirmation.service';
import {createHandymanTenantSlotConsentRouter} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.routes';
import {
  signTenantSlotChoiceAssertion,
  type TenantSlotChoiceAssertion,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2A — no-database unit tests.
 *
 * Every trust failure must reject BEFORE any transaction or tenant resolution.
 * State, guard, binding, replay and confirmation behaviour is proven against real
 * PostgreSQL in handyman-tenant-slot-consent-db.test.ts.
 */
const SECRET = 'bm-slot-secret-0123456789abcdef';
const ENV = {HANDYMAN_VISIT_SLOT_SECRET_BM_TENANT: SECRET} as NodeJS.ProcessEnv;
const ids = {request: randomUUID(), client: randomUUID(), building: randomUUID(),
  company: randomUUID(), pic: randomUUID(), context: randomUUID(), integration: randomUUID()};

function signed(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  const body = {
    iss: 'BM_TENANT', aud: 'handyman-backend', purpose: 'TENANT_SLOT_CHOICE',
    jti: `slot-jti-${randomUUID()}`, iat: new Date(now).toISOString(), exp: new Date(now + 120_000).toISOString(),
    handymanRequestId: ids.request, kind: 'INSPECTION', tenantCompanyId: ids.company, buildingId: ids.building,
    tenantPicId: ids.pic, tenantUserReference: 'bm-user-ref-1',
    selectedStartAt: new Date(now + 3 * 24 * 3600_000).toISOString(),
    selectedEndAt: new Date(now + 3 * 24 * 3600_000 + 3600_000).toISOString(),
    bmConsentEvidenceId: `bm-evidence-${randomUUID()}`,
    method: 'BM_AUTHENTICATED_TENANT_SELECTION', ...overrides,
  } as TenantSlotChoiceAssertion;
  return {body, header: signTenantSlotChoiceAssertion(body, SECRET)};
}

function harness(opts: {integration?: {status: string; scoped: boolean} | null; resolvedPic?: string | null} = {}) {
  let transactions = 0;
  let resolverCalls = 0;
  const deps: TenantSlotConsentDeps = {
    resolveTenantContext: async () => {
      resolverCalls += 1;
      return {clientId: ids.client, tenantCompanyId: ids.company, buildingId: ids.building,
        tenantPicId: opts.resolvedPic === undefined ? ids.pic : opts.resolvedPic,
        tenantBuildingContextId: ids.context} as never;
    },
    db: {query: async () => {
      const integration = opts.integration === undefined
        ? {id: ids.integration, integrationCode: 'BM_TENANT', status: 'ACTIVE', scoped: true}
        : opts.integration === null ? undefined : {id: ids.integration, integrationCode: 'BM_TENANT', ...opts.integration};
      return {rows: integration ? [integration] : [], rowCount: integration ? 1 : 0};
    }} as never,
    transact: async <T>(_work: (tx: PoolClient) => Promise<T>): Promise<T> => {
      transactions += 1;
      throw new Error('transaction must not start for a rejected assertion');
    },
  };
  return {deps, get transactions() { return transactions; }, get resolverCalls() { return resolverCalls; }};
}

const invalid = (p: Promise<unknown>) => assert.rejects(p, (error: unknown) => {
  assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
  assert.equal(error.code, ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID);
  assert.equal(error.statusCode, 401);
  return true;
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
  await invalid(acceptTenantSlotChoice({...body, appointmentId: randomUUID()}, header, h.deps, ENV));
  assert.equal(h.transactions + h.resolverCalls, 0, 'assertion that names an appointment');
});

test('a resolver that does not confirm the claimed PIC rejects before any transaction', async () => {
  const {body, header} = signed();
  for (const resolvedPic of [null, randomUUID()]) {
    const h = harness({resolvedPic});
    await invalid(acceptTenantSlotChoice(body, header, h.deps, ENV));
    assert.equal(h.transactions, 0, `resolved PIC ${String(resolvedPic)}`);
  }
});

test('migration 0434 is registered and carries the request-level, binding and commit guards without any integration grant', async () => {
  assert.ok(migrations.some(m => m.id === '0434_create_handyman_tenant_slot_consents'), 'registered');
  const sql: string[] = [];
  const client = {query: async (text: string) => { sql.push(text); return {rows: [], rowCount: 0}; }} as unknown as PoolClient;
  await migration0434CreateHandymanTenantSlotConsents.up(client);
  const ddl = sql.join('\n');
  for (const required of [
    'tenant_slot_choice_scope BOOLEAN NOT NULL DEFAULT FALSE',
    'CREATE TABLE handyman_visit_tenant_slot_consents',
    'CREATE TABLE handyman_visit_tenant_slot_bindings',
    'handyman_visit_consents_jti_unique UNIQUE (integration_id, assertion_jti)',
    'handyman_visit_consents_evidence_unique UNIQUE (integration_id, bm_consent_evidence_id)',
    'handyman_visit_consents_binding_key',
    'handyman_visit_bindings_consent_fk',
    "method = 'BM_AUTHENTICATED_TENANT_SELECTION'",
    'DEFERRABLE INITIALLY DEFERRED',
    "ERRCODE = '23514'",
  ]) assert.ok(ddl.includes(required), `DDL missing: ${required}`);
  assert.equal(/INSERT INTO handyman_handoff_integrations/.test(ddl), false, 'no integration grant in migration');
  assert.equal(/tenant_slot_choice_scope BOOLEAN NOT NULL DEFAULT TRUE/.test(ddl), false, 'scope default must be FALSE');
});

test('ingest and Ops confirm are mounted on their own router, not the R1C visit router', () => {
  const paths = ((createHandymanTenantSlotConsentRouter() as unknown as {stack: Array<{route?: {path: string; methods: Record<string, boolean>}}>}).stack)
    .filter(layer => layer.route)
    .map(layer => `${Object.keys(layer.route!.methods).map(m => m.toUpperCase()).join(',')} ${layer.route!.path}`);
  assert.deepEqual(paths.sort(), [
    'POST /handyman/integrations/tenant-slot-choices',
    'POST /handyman/requests/:handymanRequestId/visits/:appointmentId/confirm',
  ]);
});

test('Operations confirmation depends on stored tenant coordination, not BM API provisioning', () => {
  assert.equal(defaultVisitConfirmationPorts.authorityConfigured, undefined);
  assert.equal(typeof defaultVisitConfirmationPorts.scope, 'function');
  assert.equal(typeof defaultVisitConfirmationPorts.admitResource, 'function');
  // Real state/provenance/capacity denials and confirmation without a deployed
  // secret are exercised by handyman-tenant-slot-consent-db.test.ts.
});
