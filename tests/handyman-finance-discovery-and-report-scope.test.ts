import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  locationChain,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';

/**
 * CR-HM-FIN-DISCOVERY-02 — Focused PostgreSQL verification suite.
 *
 * P0-A: Finance Report Building Isolation (`HM-BE-FIN-REPORT-SCOPE`)
 * P0-B: Authoritative Finance Action Discovery (`HM-BE-FIN-DISCOVERY`)
 */

const PG_DIR = '/tmp/hm-fin-discovery-02-pg';
const PG_PORT = 55568;

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PG_PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_NAME: 'asentra_test',
  DB_SSL: 'false',
});

const V1 = '/api/v1';
const key = () => `k-${randomUUID()}`;
const PW = 'CorrectHorseBatteryStaple!9';

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('pool not initialized');
  return pool.query(text, params);
};

before(async () => {
  resetAppConfigCache();
  await rm(PG_DIR, { recursive: true, force: true });
  await mkdir(PG_DIR, { recursive: true });
  pg = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    port: PG_PORT,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  await pg.initialise();
  await pg.start();
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query('CREATE DATABASE asentra_test');
  await admin.end();

  const { ensureTestDatabase } = await import('./helpers/postgres');
  const db = await ensureTestDatabase();
  assert.ok(db, 'EmbeddedPostgres test database must be reachable');
  pool = await initDatabase(db);
  await migrateUp(pool);

  const adminActor = await createAdminUser();
  adminUserId = adminActor.userId;
  adminToken = adminActor.token;
  await grantPermissionsToUser(adminUserId, [
    'handyman.commercial.manage',
    'handyman.finance.read',
    'handyman.finance.manage',
    'handyman.settlement.manage',
  ]);

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline, 'GENERAL_HANDYMAN discipline must be seeded');
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: q,
  });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(PG_DIR, { recursive: true, force: true });
    resetAppConfigCache();
  }
});

const get = (token: string, url: string) =>
  api().get(url).set('Authorization', `Bearer ${token}`);

const post = (
  token: string,
  url: string,
  body: Record<string, unknown> = {},
) => api().post(url).set('Authorization', `Bearer ${token}`).send(body);

async function grantPermissionsToUser(
  userId: string,
  codes: readonly string[],
): Promise<void> {
  if (codes.length === 0) return;
  const role = await roleService.createRole({
    code: `ROLE_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Scoped Persona Role',
  });
  for (const code of codes) {
    const perm = await permissionService
      .createPermission({ code, name: `Scoped ${code}` })
      .catch(async () => permissionRepository.findByCode(code));
    assert.ok(perm, `permission ${code} must exist in database`);
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function createPersonaActor(options: {
  label: string;
  buildingIds: readonly string[];
  permissions: readonly string[];
}): Promise<{ userId: string; token: string }> {
  const email = `${options.label}-${randomUUID().slice(0, 8)}@example.com`;
  const user = await userService.createUser({
    email,
    displayName: options.label,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: PW,
  });
  await grantPermissionsToUser(user.id, options.permissions);
  for (const buildingId of options.buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api()
    .post(`${V1}/auth/login`)
    .send({ email, password: PW });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

async function ensureBuildingExistsInRealm(
  realm: Awaited<ReturnType<typeof baseFixture>>['realm'],
  buildingId: string,
): Promise<void> {
  const existing = await q(`SELECT 1 FROM buildings WHERE id = $1`, [
    buildingId,
  ]);
  if (existing.rowCount && existing.rowCount > 0) return;

  await q(
    `INSERT INTO buildings (id, property_id, code, name, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')`,
    [
      buildingId,
      realm.property.id,
      `BLD-${buildingId.slice(0, 8)}`,
      `Sibling Building ${buildingId.slice(0, 6)}`,
    ],
  );
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId,
  });
}

async function createScopedCrewAndScope(
  realm: Awaited<ReturnType<typeof baseFixture>>['realm'],
  buildingId = randomUUID(),
) {
  await ensureBuildingExistsInRealm(realm, buildingId);
  const targetRealm = {
    ...realm,
    building: { id: buildingId },
  };
  const chain = await locationChain(targetRealm);
  const { scope } = await scopeFixture(targetRealm, chain);
  assert.ok(scope);

  const crew = await crewFixture(targetRealm);
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: crew.workerContext.workforceProfileId,
    buildingId,
  });
  await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    adminUserId,
  );

  return { buildingId, scope, crew };
}

async function setupActiveCommercialAgreement(clientId: string): Promise<void> {
  const prepared = await post(
    adminToken,
    `${V1}/handyman/commercial-agreements`,
    { clientId, idempotencyKey: key() },
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const versionId = prepared.body.data.version.id as string;
  for (const [path, body] of [
    [
      'labor-pricing-basis',
      {
        mode: 'HOURLY',
        crewMode: 'PER_HEAD',
        billableTimeBasis: 'ACTUAL_WORK',
        unitAmount: '150000.00',
        currency: 'IDR',
      },
    ],
    ['material-pricing-basis', { mode: 'SETTLED_USAGE' }],
    ['bm-fee-rule', { basis: 'LABOR_ONLY', mode: 'DEFAULT' }],
    [
      'bm-fee-term',
      { termKind: 'PERCENTAGE_OF_BASIS', ratePercent: '10.0000' },
    ],
    [
      'bm-fee-beneficiary',
      {
        beneficiaryKind: 'CLIENT_ORGANIZATION',
        beneficiaryReferenceId: clientId,
      },
    ],
  ] as const) {
    const r = await post(
      adminToken,
      `${V1}/handyman/commercial-agreement-versions/${versionId}/${path}`,
      { ...body, idempotencyKey: key() },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const activated = await post(
    adminToken,
    `${V1}/handyman/commercial-agreement-versions/${versionId}/activate`,
    {
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: key(),
    },
  );
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
}

async function createAuthoritativeSettledScopeTransaction(
  scopeId: string,
  approvedQuotationVersionId: string,
): Promise<{
  transactionId: string;
  chargeLineId: string;
  paymentId: string;
  settlementUnitId: string;
}> {
  const scopeUrl = `${V1}/handyman/execution-scopes/${scopeId}`;
  const opened = await post(adminToken, `${scopeUrl}/customer-transaction`, {
    idempotencyKey: key(),
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const transactionId = opened.body.data.transaction.id as string;

  const laborLine = await q(
    `SELECT id
       FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR'
      LIMIT 1`,
    [approvedQuotationVersionId],
  );
  const quotationLineId = laborLine.rows[0].id as string;

  const composed = await post(adminToken, `${scopeUrl}/customer-charge-lines`, {
    quotationLineId,
    idempotencyKey: key(),
  });
  assert.equal(composed.status, 200, JSON.stringify(composed.body));
  const chargeLineId = composed.body.data.chargeLine.id as string;
  const lineAmount = composed.body.data.chargeLine.amount as string;

  const recorded = await post(adminToken, `${scopeUrl}/customer-payments`, {
    amount: lineAmount,
    channel: 'BANK_TRANSFER',
    providerName: 'BCA',
    providerReference: `ref-${randomUUID().slice(0, 8)}`,
    externalReference: `ext-${randomUUID().slice(0, 8)}`,
    idempotencyKey: key(),
  });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const paymentId = recorded.body.data.payment.id as string;

  const confirmed = await post(
    adminToken,
    `${scopeUrl}/customer-payments/${paymentId}/confirm`,
    { idempotencyKey: key() },
  );
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const allocated = await post(adminToken, `${scopeUrl}/payment-allocations`, {
    paymentId,
    chargeLineId,
    amount: lineAmount,
    idempotencyKey: key(),
  });
  assert.equal(allocated.status, 200, JSON.stringify(allocated.body));

  const derived = await post(
    adminToken,
    `${scopeUrl}/financial-entitlements/derive`,
    { idempotencyKey: key() },
  );
  assert.equal(derived.status, 200, JSON.stringify(derived.body));

  const prepared = await post(adminToken, `${scopeUrl}/settlement/prepare`, {
    idempotencyKey: key(),
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const settlementUnitId = prepared.body.data.unitId as string;

  await post(adminToken, `${scopeUrl}/settlement/include`, {
    idempotencyKey: key(),
  });
  await post(adminToken, `${scopeUrl}/settlement/reconcile`, {
    idempotencyKey: key(),
  });
  const settled = await post(adminToken, `${scopeUrl}/settlement/settle`, {
    idempotencyKey: key(),
  });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));

  return { transactionId, chargeLineId, paymentId, settlementUnitId };
}

describe('CR-HM-FIN-DISCOVERY-02 — P0-A Finance Report Building Isolation', () => {
  it('P0-A.1: isolates Client financial report and customer-ledger report to the actor’s assigned Buildings before pagination, totals, and authority metadata', async () => {
    const base = await baseFixture();
    const clientId = base.realm.client.id;
    const buildingA1 = base.realm.building.id;
    await setupActiveCommercialAgreement(clientId);

    // Building A2 (sibling) and Building A3 (sibling) in the SAME Client.
    const b2Auth = await createScopedCrewAndScope(base.realm);
    const b2Uncharged = await createScopedCrewAndScope(
      base.realm,
      b2Auth.buildingId,
    );
    const b3Auth = await createScopedCrewAndScope(base.realm);

    // Create sibling Building A2 & A3 transactions FIRST so they sort BEFORE Building A1
    // in `ORDER BY t.created_at ASC, t.id ASC` (proving SQL scope filtering precedes LIMIT).
    const txB2Auth = await createAuthoritativeSettledScopeTransaction(
      b2Auth.scope.id,
      b2Auth.scope.approvedQuotationVersionId!,
    );
    const openedB2Uncharged = await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${b2Uncharged.scope.id}/customer-transaction`,
      { idempotencyKey: key() },
    );
    assert.equal(openedB2Uncharged.status, 200);
    const txB2UnchargedId = openedB2Uncharged.body.data.transaction.id as string;

    const txB3Auth = await createAuthoritativeSettledScopeTransaction(
      b3Auth.scope.id,
      b3Auth.scope.approvedQuotationVersionId!,
    );

    // Now create Building A1 scopes (one authoritative + one pending payment).
    const b1Scope1 = await createScopedCrewAndScope(base.realm, buildingA1);
    const txB1Auth = await createAuthoritativeSettledScopeTransaction(
      b1Scope1.scope.id,
      b1Scope1.scope.approvedQuotationVersionId!,
    );

    const b1Pending = await createScopedCrewAndScope(base.realm, buildingA1);
    const openedB1Pending = await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${b1Pending.scope.id}/customer-transaction`,
      { idempotencyKey: key() },
    );
    assert.equal(openedB1Pending.status, 200);
    const txB1PendingId = openedB1Pending.body.data.transaction.id as string;
    const b1LaborLine = await q(
      `SELECT id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
      [b1Pending.scope.approvedQuotationVersionId],
    );
    await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${b1Pending.scope.id}/customer-charge-lines`,
      { quotationLineId: b1LaborLine.rows[0].id as string, idempotencyKey: key() },
    );
    await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${b1Pending.scope.id}/customer-payments`,
      {
        amount: '50.00',
        channel: 'QRIS',
        idempotencyKey: key(),
      },
    );

    // Foreign Client B
    const foreignBase = await baseFixture();

    // Actor 1: Single-Building Finance Reader assigned ONLY to Building A1
    const readerA1 = await createPersonaActor({
      label: 'fin-reader-b1',
      buildingIds: [buildingA1],
      permissions: ['handyman.finance.read', 'tenant_company.read'],
    });

    // 1. Client-wide query without buildingId returns ONLY Building A1 records
    const resA1 = await get(
      readerA1.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}`,
    );
    assert.equal(resA1.status, 200, JSON.stringify(resA1.body));
    const txIdsA1 = resA1.body.data.transactions.map(
      (entry: { transaction: { transactionId: string } }) =>
        entry.transaction.transactionId,
    );
    assert.deepEqual(txIdsA1, [txB1Auth.transactionId]);
    assert.deepEqual(resA1.body.data.excludedTransactionIds, [txB1PendingId]);
    assert.deepEqual(
      resA1.body.data.authority.nonAuthoritativeTransactionIds,
      [txB1PendingId],
    );
    // Sibling Building A2's NO_POSTED_CHARGE_FACTS denial must NOT leak into readerA1's authority.deniedBy!
    assert.deepEqual(resA1.body.data.authority.deniedBy, [
      'PROVISIONAL_PAYMENTS_PENDING',
    ]);
    assert.ok(!txIdsA1.includes(txB2Auth.transactionId));
    assert.ok(!txIdsA1.includes(txB3Auth.transactionId));
    assert.ok(
      !resA1.body.data.excludedTransactionIds.includes(txB2UnchargedId),
    );

    // 2. Pagination limit=1 on readerA1 must return Building A1's first transaction,
    // NOT an empty set consumed by earlier sibling Building A2/A3 rows!
    const resA1Limit1 = await get(
      readerA1.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}&limit=1`,
    );
    assert.equal(resA1Limit1.status, 200, JSON.stringify(resA1Limit1.body));
    assert.equal(resA1Limit1.body.data.transactions.length, 1);
    assert.equal(
      resA1Limit1.body.data.transactions[0].transaction.transactionId,
      txB1Auth.transactionId,
    );

    // 3. Explicit authorized buildingId=buildingA1 succeeds
    const resA1Explicit = await get(
      readerA1.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}&buildingId=${buildingA1}`,
    );
    assert.equal(resA1Explicit.status, 200);
    assert.equal(resA1Explicit.body.data.transactions.length, 1);
    assert.equal(
      resA1Explicit.body.data.transactions[0].transaction.transactionId,
      txB1Auth.transactionId,
    );

    // 4. Explicit unauthorized sibling buildingId=b2Auth.buildingId is denied 403 with zero leakage
    const resA1Sibling = await get(
      readerA1.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}&buildingId=${b2Auth.buildingId}`,
    );
    assert.equal(resA1Sibling.status, 403);
    assert.equal(
      resA1Sibling.body.error.code,
      'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED',
    );
    assert.equal(resA1Sibling.body.data, undefined);

    // 5. Foreign Client B is denied 403 with zero leakage
    const resA1Foreign = await get(
      readerA1.token,
      `${V1}/handyman/financial-transactions?clientId=${foreignBase.realm.client.id}`,
    );
    assert.equal(resA1Foreign.status, 403);
    assert.equal(
      resA1Foreign.body.error.code,
      'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED',
    );

    // 6. Customer ledger report (`GET /handyman/customer-ledger`) also isolates totals & rows to Building A1
    const ledgerA1 = await get(
      readerA1.token,
      `${V1}/handyman/customer-ledger?clientId=${clientId}`,
    );
    assert.equal(ledgerA1.status, 200, JSON.stringify(ledgerA1.body));
    assert.equal(ledgerA1.body.data.transactions.length, 2);
    assert.equal(ledgerA1.body.data.totals.transactionCount, 2);
    assert.deepEqual(
      ledgerA1.body.data.transactions
        .map((t: { transactionId: string }) => t.transactionId)
        .sort(),
      [txB1Auth.transactionId, txB1PendingId].sort(),
    );
    assert.deepEqual(ledgerA1.body.data.authority.deniedBy, [
      'PROVISIONAL_PAYMENTS_PENDING',
    ]);

    const ledgerA1Sibling = await get(
      readerA1.token,
      `${V1}/handyman/customer-ledger?clientId=${clientId}&buildingId=${b2Auth.buildingId}`,
    );
    assert.equal(ledgerA1Sibling.status, 403);

    // Actor 2: Multi-Building Finance Reader assigned to Building A1 AND Building A2 (but NOT Building A3)
    const readerA1A2 = await createPersonaActor({
      label: 'fin-reader-b1-b2',
      buildingIds: [buildingA1, b2Auth.buildingId],
      permissions: ['handyman.finance.read'],
    });

    const resA1A2 = await get(
      readerA1A2.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}`,
    );
    assert.equal(resA1A2.status, 200, JSON.stringify(resA1A2.body));
    const txIdsA1A2 = resA1A2.body.data.transactions
      .map(
        (entry: { transaction: { transactionId: string } }) =>
          entry.transaction.transactionId,
      )
      .sort();
    assert.deepEqual(
      txIdsA1A2,
      [txB1Auth.transactionId, txB2Auth.transactionId].sort(),
    );
    assert.ok(!txIdsA1A2.includes(txB3Auth.transactionId));
    assert.deepEqual(
      [...resA1A2.body.data.excludedTransactionIds].sort(),
      [txB1PendingId, txB2UnchargedId].sort(),
    );

    // Narrowing Multi-Building reader by buildingId=b2Auth.buildingId returns ONLY Building A2
    const resOnlyB2 = await get(
      readerA1A2.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}&buildingId=${b2Auth.buildingId}`,
    );
    assert.equal(resOnlyB2.status, 200);
    assert.deepEqual(
      resOnlyB2.body.data.transactions.map(
        (entry: { transaction: { transactionId: string } }) =>
          entry.transaction.transactionId,
      ),
      [txB2Auth.transactionId],
    );
    assert.deepEqual(resOnlyB2.body.data.excludedTransactionIds, [
      txB2UnchargedId,
    ]);

    // Multi-Building reader still denied 403 on unauthorized Building A3
    const resDeniedB3 = await get(
      readerA1A2.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}&buildingId=${b3Auth.buildingId}`,
    );
    assert.equal(resDeniedB3.status, 403);
  });

  it('P0-A.2: enforces handyman.finance.read with no generic tenant_company.manage fallback and rejects query spoofing', async () => {
    const base = await baseFixture();
    const clientId = base.realm.client.id;
    const buildingId = base.realm.building.id;

    const careManager = await createPersonaActor({
      label: 'care-mgr',
      buildingIds: [buildingId],
      permissions: ['tenant_company.read', 'tenant_company.manage'],
    });
    const commercialOnly = await createPersonaActor({
      label: 'commercial-only',
      buildingIds: [buildingId],
      permissions: ['handyman.commercial.manage'],
    });
    const settlementOnly = await createPersonaActor({
      label: 'settlement-only',
      buildingIds: [buildingId],
      permissions: ['handyman.settlement.manage'],
    });
    const unassignedFinanceReader = await createPersonaActor({
      label: 'unassigned-fin-reader',
      buildingIds: [],
      permissions: ['handyman.finance.read'],
    });
    const assignedFinanceReader = await createPersonaActor({
      label: 'assigned-fin-reader',
      buildingIds: [buildingId],
      permissions: ['handyman.finance.read'],
    });

    for (const actor of [careManager, commercialOnly, settlementOnly]) {
      const denied = await get(
        actor.token,
        `${V1}/handyman/financial-transactions?clientId=${clientId}`,
      );
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    }

    const unassignedRes = await get(
      unassignedFinanceReader.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}`,
    );
    assert.equal(unassignedRes.status, 403);
    assert.equal(
      unassignedRes.body.error.code,
      'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED',
    );

    const spoofRes = await get(
      assignedFinanceReader.token,
      `${V1}/handyman/financial-transactions?clientId=${clientId}&actorUserId=${adminUserId}`,
    );
    assert.equal(spoofRes.status, 400);
    assert.equal(spoofRes.body.error.code, 'VALIDATION_ERROR');
  });
});
