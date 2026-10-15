import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';

/**
 * CR-HM-FIN-AUTH-01 — dedicated Commercial / Finance / Settlement
 * authority regression suite (disposable embedded PostgreSQL, real
 * HTTP, persisted-state assertions).
 *
 * An actor holding only `tenant_company.manage` must be unable to
 * allocate, refund, correct, verify or settle; each domain permission
 * works only inside its own scope and never implies another domain.
 */
const DIR = '/tmp/hm-finance-authority-pg';
const PORT = 55545;
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_NAME: 'asentra_test',
  DB_SSL: 'false',
});

const V1 = '/api/v1';
let pg: EmbeddedPostgres;
let pool: Pool;
let adminId = '';
let adminToken = '';
const id = () => randomUUID();
const key = () => `auth-${randomUUID()}`;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `AUTH_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Finance authority test role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService
      .createPermission({ code: permissionCode, name: `Scoped ${permissionCode}` })
      .catch(async () => permissionRepository.findByCode(permissionCode));
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function makeUser(permissionCodes: string[]) {
  const suffix = randomUUID().slice(0, 8).toLowerCase();
  const password = 'AuthPass123';
  const user = await userService.createUser({
    email: `auth-${suffix}@example.com`,
    displayName: 'Authority Persona',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await grant(user.id, permissionCodes);
  const login = await api()
    .post(`${V1}/auth/login`)
    .send({ email: user.email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

function post(token: string, url: string, body: unknown) {
  return api().post(url).set('Authorization', `Bearer ${token}`).send(body as object);
}
function get(token: string, url: string) {
  return api().get(url).set('Authorization', `Bearer ${token}`);
}

before(async () => {
  resetAppConfigCache();
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  await pg.initialise();
  await pg.start();
  const adminClient = pg.getPgClient('postgres', '127.0.0.1');
  await adminClient.connect();
  await adminClient.query('CREATE DATABASE asentra_test');
  await adminClient.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase();
  assert.ok(config);
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline);
  initHandymanFixtures({ adminUserId: adminId, disciplineId: discipline.id, query: q });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
    resetAppConfigCache();
  }
});

async function configureCommercialViaHttp(clientId: string) {
  const prepared = await post(adminToken, `${V1}/handyman/commercial-agreements`, {
    clientId,
    idempotencyKey: key(),
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const versionId = prepared.body.data.version.id as string;
  for (const [path, body] of [
    ['labor-pricing-basis', { mode: 'HOURLY', crewMode: 'PER_HEAD', billableTimeBasis: 'ACTUAL_WORK', unitAmount: '150000.00', currency: 'IDR' }],
    ['material-pricing-basis', { mode: 'SETTLED_USAGE' }],
    ['bm-fee-rule', { basis: 'LABOR_ONLY', mode: 'DEFAULT' }],
    ['bm-fee-term', { termKind: 'PERCENTAGE_OF_BASIS', ratePercent: '2.5000' }],
    ['bm-fee-beneficiary', { beneficiaryKind: 'CLIENT_ORGANIZATION', beneficiaryReferenceId: clientId }],
  ] as const) {
    const r = await post(adminToken, `${V1}/handyman/commercial-agreement-versions/${versionId}/${path}`, { ...body, idempotencyKey: key() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const activated = await post(adminToken, `${V1}/handyman/commercial-agreement-versions/${versionId}/activate`, {
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    idempotencyKey: key(),
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return versionId;
}

describe('CR-HM-FIN-AUTH-01 dedicated finance authority', () => {
  it('domain permissions isolate Commercial, Finance and Settlement; scope still binds; reporting survives', async () => {
    const { realm, scope } = await baseFixture();
    const crew = await crewFixture(realm);
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: crew.workerContext.workforceProfileId,
      buildingId: realm.building.id,
    });
    await assignHandymanExecutionScopeCrew(
      { executionScopeId: scope.id, providerContextId: crew.providerContext.id, crewId: crew.crew.id },
      adminId,
    );
    const scopeUrl = `${V1}/handyman/execution-scopes/${scope.id}`;
    await configureCommercialViaHttp(realm.client.id);

    const opened = await post(adminToken, `${scopeUrl}/customer-transaction`, { idempotencyKey: key() });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const lines = await q(
      `SELECT id FROM handyman_quotation_lines WHERE quotation_version_id = $1 AND line_type = 'LABOR'`,
      [scope.approvedQuotationVersionId],
    );
    const charge = await post(adminToken, `${scopeUrl}/customer-charge-lines`, {
      quotationLineId: lines.rows[0].id,
      idempotencyKey: key(),
    });
    assert.equal(charge.status, 200, JSON.stringify(charge.body));
    const chargeLineId = charge.body.data.chargeLine.id as string;
    const recorded = await post(adminToken, `${scopeUrl}/customer-payments`, {
      amount: '100.00',
      channel: 'BANK_TRANSFER',
      providerReference: id(),
      idempotencyKey: key(),
    });
    const paymentId = recorded.body.data.payment.id as string;
    const confirmed = await post(adminToken, `${scopeUrl}/customer-payments/${paymentId}/confirm`, { idempotencyKey: key() });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const assignBuilding = async (u: { userId: string }) =>
      buildingAssignmentService.createAssignment(u.userId, { buildingId: realm.building.id });

    /* A — Customer Care / generic manager: tenant_company.manage only */
    const generic = await makeUser(['tenant_company.read', 'tenant_company.manage']);
    await assignBuilding(generic);
    const aAlloc = await post(generic.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '40.00', idempotencyKey: key(),
    });
    assert.equal(aAlloc.status, 403, JSON.stringify(aAlloc.body));
    const aRefund = await post(generic.token, `${scopeUrl}/ledger-refunds`, {
      paymentId, amount: '1.00', reason: 'probe', idempotencyKey: key(),
    });
    assert.equal(aRefund.status, 403);
    const aSettle = await post(generic.token, `${scopeUrl}/settlement/prepare`, { idempotencyKey: key() });
    assert.equal(aSettle.status, 403);
    const aCommercial = await post(generic.token, `${V1}/handyman/commercial-agreements`, {
      clientId: realm.client.id, idempotencyKey: key(),
    });
    assert.equal(aCommercial.status, 403);
    const aFinRead = await get(generic.token, `${scopeUrl}/financial-transaction`);
    assert.equal(aFinRead.status, 403);
    // Customer payment reporting remains available to this actor.
    const reports = await post(generic.token, `${scopeUrl}/customer-payments`, {
      amount: '20.00', channel: 'CASH', idempotencyKey: key(),
    });
    assert.equal(reports.status, 200, JSON.stringify(reports.body));
    const reportedPaymentId = reports.body.data.payment.id as string;
    // …but verification is Finance authority, not reporting authority.
    const aVerify = await post(generic.token, `${scopeUrl}/customer-payments/${reportedPaymentId}/confirm`, { idempotencyKey: key() });
    assert.equal(aVerify.status, 403);
    // Customer ledger read (reporting) still works for the generic actor.
    const aLedgerRead = await get(generic.token, `${scopeUrl}/customer-ledger`);
    assert.equal(aLedgerRead.status, 200, JSON.stringify(aLedgerRead.body));
    let allocs = await q(`SELECT count(*)::int AS n FROM handyman_payment_allocations WHERE payment_id = $1`, [paymentId]);
    assert.equal(allocs.rows[0].n, 0, 'denied allocation persisted nothing');
    let corrections = await q(`SELECT count(*)::int AS n FROM handyman_ledger_corrections WHERE transaction_id = $1`, [opened.body.data.transaction.id]);
    assert.equal(corrections.rows[0].n, 0, 'denied refund persisted nothing');
    const pending = await q(`SELECT status FROM handyman_customer_payments WHERE id = $1`, [reportedPaymentId]);
    assert.equal(pending.rows[0].status, 'PENDING', 'unverified payment stays PENDING');

    /* B — authorized Finance actor, exact Building */
    const finance = await makeUser(['handyman.finance.read', 'handyman.finance.manage']);
    await assignBuilding(finance);
    const bConfirm = await post(finance.token, `${scopeUrl}/customer-payments/${reportedPaymentId}/confirm`, { idempotencyKey: key() });
    assert.equal(bConfirm.status, 200, JSON.stringify(bConfirm.body));
    const bAlloc = await post(finance.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '40.00', idempotencyKey: key(),
    });
    assert.equal(bAlloc.status, 200, JSON.stringify(bAlloc.body));
    assert.equal(bAlloc.body.data.allocation.allocatedByUserId, finance.userId, 'audit: allocation actor is the Finance actor');
    const bAlloc2 = await post(finance.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '60.00', idempotencyKey: key(),
    });
    assert.equal(bAlloc2.status, 200, JSON.stringify(bAlloc2.body));
    const bDerive = await post(finance.token, `${scopeUrl}/financial-entitlements/derive`, { idempotencyKey: key() });
    assert.equal(bDerive.status, 200, JSON.stringify(bDerive.body));
    const bRead = await get(finance.token, `${scopeUrl}/financial-transaction`);
    assert.equal(bRead.status, 200);
    // Finance authority does NOT imply settlement authority.
    const bSettle = await post(finance.token, `${scopeUrl}/settlement/prepare`, { idempotencyKey: key() });
    assert.equal(bSettle.status, 403);
    // Spoofed authority fields stay rejected even for Finance.
    const spoof = await post(finance.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '1.00', actorUserId: finance.userId, role: 'FINANCE', idempotencyKey: key(),
    });
    assert.equal(spoof.status, 400);

    /* C — Settlement Manager without Finance authority */
    const settlement = await makeUser(['handyman.settlement.manage']);
    await assignBuilding(settlement);
    const cRefund = await post(settlement.token, `${scopeUrl}/ledger-refunds`, {
      paymentId, amount: '1.00', reason: 'probe', idempotencyKey: key(),
    });
    assert.equal(cRefund.status, 403, 'settlement authority must not imply refund authority');
    const cAlloc = await post(settlement.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '1.00', idempotencyKey: key(),
    });
    assert.equal(cAlloc.status, 403);
    corrections = await q(`SELECT count(*)::int AS n FROM handyman_ledger_corrections WHERE transaction_id = $1`, [opened.body.data.transaction.id]);
    assert.equal(corrections.rows[0].n, 0, 'denied settlement refund persisted nothing');
    for (const step of ['prepare', 'include', 'reconcile', 'settle']) {
      const r = await post(settlement.token, `${scopeUrl}/settlement/${step}`, { idempotencyKey: key() });
      assert.equal(r.status, 200, `${step}: ${JSON.stringify(r.body)}`);
    }
    // Finance refund stays available to Finance after settlement (forward-only fact).
    const bRefund = await post(finance.token, `${scopeUrl}/ledger-refunds`, {
      paymentId, amount: '10.00', reason: 'Finance refund', idempotencyKey: key(),
    });
    assert.equal(bRefund.status, 200, JSON.stringify(bRefund.body));
    assert.equal(bRefund.body.data.correction.correctedByUserId, finance.userId, 'audit: correction actor is the Finance actor');
    corrections = await q(`SELECT count(*)::int AS n FROM handyman_ledger_corrections WHERE transaction_id = $1`, [opened.body.data.transaction.id]);
    assert.equal(corrections.rows[0].n, 1, 'exactly the Finance refund exists');

    /* D — Commercial Manager without Finance authority */
    const commercial = await makeUser(['handyman.commercial.manage']);
    await assignBuilding(commercial);
    const dAgreement = await post(commercial.token, `${V1}/handyman/commercial-agreements`, {
      clientId: realm.client.id, idempotencyKey: key(),
    });
    assert.equal(dAgreement.status, 200, JSON.stringify(dAgreement.body));
    const dAlloc = await post(commercial.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '1.00', idempotencyKey: key(),
    });
    assert.equal(dAlloc.status, 403, 'commercial authority must not mutate payments');
    const dFinRead = await get(commercial.token, `${scopeUrl}/financial-transaction`);
    assert.equal(dFinRead.status, 403);

    /* E — foreign Building / unassigned / foreign Client */
    const other = await baseFixture();
    const foreignFinance = await makeUser(['handyman.finance.manage']);
    await buildingAssignmentService.createAssignment(foreignFinance.userId, { buildingId: other.realm.building.id });
    const eAlloc = await post(foreignFinance.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '1.00', idempotencyKey: key(),
    });
    assert.ok([403, 404].includes(eAlloc.status), `cross-Building must deny, got ${eAlloc.status}`);
    const unassignedFinance = await makeUser(['handyman.finance.manage']);
    const eUnassigned = await post(unassignedFinance.token, `${scopeUrl}/payment-allocations`, {
      paymentId, chargeLineId, amount: '1.00', idempotencyKey: key(),
    });
    assert.ok([403, 404].includes(eUnassigned.status));
    const eCrossClient = await post(commercial.token, `${V1}/handyman/commercial-agreements`, {
      clientId: other.realm.client.id, idempotencyKey: key(),
    });
    assert.ok([403, 404].includes(eCrossClient.status), 'commercial grant is Client-scoped');

    allocs = await q(`SELECT count(*)::int AS n, COALESCE(sum(amount),0) AS total FROM handyman_payment_allocations WHERE payment_id = $1`, [paymentId]);
    assert.equal(allocs.rows[0].n, 2);
    assert.equal(String(allocs.rows[0].total), '100.00', 'only Finance allocations persisted, exactly the charge');
  });
});
