import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import YAML from 'yaml';
import { resetAppConfigCache } from '../src/config';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
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

describe('CR-HM-FIN-DISCOVERY-02 — P0-B Authoritative Finance Action Discovery & Persona Separation', () => {
  it('P0-B.1: discovers pending customer payments, unallocated/partially allocated payments, pending corrections, pending reconciliations, and Finance blockers with exact provenance', async () => {
    const base = await baseFixture();
    const clientId = base.realm.client.id;
    const buildingA1 = base.realm.building.id;
    await setupActiveCommercialAgreement(clientId);

    const careActor = await createPersonaActor({
      label: 'care-reporter',
      buildingIds: [buildingA1],
      permissions: ['tenant_company.read', 'tenant_company.manage'],
    });
    const financeReader = await createPersonaActor({
      label: 'finance-reader',
      buildingIds: [buildingA1],
      permissions: ['handyman.finance.read'],
    });
    const financeManager = await createPersonaActor({
      label: 'finance-manager',
      buildingIds: [buildingA1],
      permissions: ['handyman.finance.read', 'handyman.finance.manage'],
    });
    const settlementManager = await createPersonaActor({
      label: 'settlement-manager',
      buildingIds: [buildingA1],
      permissions: ['handyman.finance.read', 'handyman.settlement.manage'],
    });

    // Scope 1: Opened transaction with NO charge lines -> FINANCE_BLOCKER (NO_POSTED_CHARGE_FACTS)
    const s1 = await createScopedCrewAndScope(base.realm, buildingA1);
    const scope1Url = `${V1}/handyman/execution-scopes/${s1.scope.id}`;
    const open1 = await post(
      financeManager.token,
      `${scope1Url}/customer-transaction`,
      { idempotencyKey: key() },
    );
    assert.equal(open1.status, 200, JSON.stringify(open1.body));
    const tx1Id = open1.body.data.transaction.id as string;

    // Verify NO_POSTED_CHARGE_FACTS blocker is immediately discoverable without knowing executionScopeId
    const inboxBlocker1 = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&includeCounts=true`,
    );
    assert.equal(inboxBlocker1.status, 200, JSON.stringify(inboxBlocker1.body));
    assert.equal(inboxBlocker1.body.data.items.length, 1);
    const itemTx1 = inboxBlocker1.body.data.items[0];
    assert.equal(itemTx1.recordId, tx1Id);
    assert.equal(itemTx1.recordType, 'CUSTOMER_TRANSACTION');
    assert.equal(itemTx1.recordStatus, 'LEDGER_ONLY');
    assert.equal(itemTx1.actionCategory, 'FINANCE_BLOCKER');
    assert.equal(itemTx1.blockerCode, 'NO_POSTED_CHARGE_FACTS');
    assert.equal(itemTx1.executionScopeId, s1.scope.id);
    assert.equal(itemTx1.transactionId, tx1Id);
    assert.deepEqual(itemTx1.responsible, {
      permission: 'handyman.finance.manage',
      action: 'COMPOSE_CHARGE_LINES',
    });

    // Compose charge line on Scope 1 -> NO_POSTED_CHARGE_FACTS blocker resolves
    const laborLine1 = await q(
      `SELECT id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
      [s1.scope.approvedQuotationVersionId],
    );
    const composed1 = await post(
      financeManager.token,
      `${scope1Url}/customer-charge-lines`,
      {
        quotationLineId: laborLine1.rows[0].id as string,
        idempotencyKey: key(),
      },
    );
    assert.equal(composed1.status, 200);
    const chargeLine1Id = composed1.body.data.chargeLine.id as string;
    const line1Amount = composed1.body.data.chargeLine.amount as string;

    const inboxAfterCompose = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&includeCounts=true`,
    );
    assert.equal(inboxAfterCompose.status, 200);
    assert.equal(inboxAfterCompose.body.data.items.length, 0);
    assert.equal(inboxAfterCompose.body.data.counts.total, 0);

    // Customer Care reports a customer payment (`PENDING`) using `tenant_company.manage`
    const reported = await post(
      careActor.token,
      `${scope1Url}/customer-payments`,
      {
        amount: line1Amount,
        channel: 'BANK_TRANSFER',
        providerName: 'Mandiri',
        providerReference: 'MDR-001',
        externalReference: 'EXT-MDR-001',
        idempotencyKey: key(),
      },
    );
    assert.equal(reported.status, 200, JSON.stringify(reported.body));
    const payment1Id = reported.body.data.payment.id as string;

    // Finance Reader discovers the PENDING payment in PAYMENT_VERIFICATION
    const inboxPendingPay = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&includeCounts=true`,
    );
    assert.equal(inboxPendingPay.status, 200);
    assert.equal(inboxPendingPay.body.data.items.length, 1);
    const pendingItem = inboxPendingPay.body.data.items[0];
    assert.equal(pendingItem.recordId, payment1Id);
    assert.equal(pendingItem.recordType, 'CUSTOMER_PAYMENT');
    assert.equal(pendingItem.recordStatus, 'PENDING');
    assert.equal(pendingItem.actionCategory, 'PAYMENT_VERIFICATION');
    assert.equal(pendingItem.blockerCode, 'PROVISIONAL_PAYMENTS_PENDING');
    assert.equal(pendingItem.executionScopeId, s1.scope.id);
    assert.equal(pendingItem.transactionId, tx1Id);
    assert.equal(pendingItem.amount, line1Amount);
    assert.equal(pendingItem.provenance.paymentId, payment1Id);
    assert.equal(pendingItem.provenance.paymentStatus, 'PENDING');
    assert.equal(pendingItem.provenance.paymentChannel, 'BANK_TRANSFER');
    assert.equal(pendingItem.provenance.paymentReference, 'EXT-MDR-001');
    assert.equal(pendingItem.provenance.recordedByUserId, careActor.userId);
    assert.deepEqual(pendingItem.responsible, {
      permission: 'handyman.finance.manage',
      action: 'VERIFY_CUSTOMER_PAYMENT',
    });
    assert.equal(
      inboxPendingPay.body.data.counts.byActionCategory.PAYMENT_VERIFICATION,
      1,
    );

    // Finance Manager confirms the payment using the discovered executionScopeId & recordId
    const confirmed1 = await post(
      financeManager.token,
      `${V1}/handyman/execution-scopes/${pendingItem.executionScopeId}/customer-payments/${pendingItem.recordId}/confirm`,
      { idempotencyKey: key() },
    );
    assert.equal(confirmed1.status, 200, JSON.stringify(confirmed1.body));

    // Payment now transitions to PAYMENT_ALLOCATION (UNALLOCATED)
    const inboxUnallocated = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&includeCounts=true`,
    );
    assert.equal(inboxUnallocated.status, 200);
    assert.equal(inboxUnallocated.body.data.items.length, 1);
    const unallocItem = inboxUnallocated.body.data.items[0];
    assert.equal(unallocItem.recordId, payment1Id);
    assert.equal(unallocItem.recordType, 'CUSTOMER_PAYMENT');
    assert.equal(unallocItem.recordStatus, 'CONFIRMED');
    assert.equal(unallocItem.actionCategory, 'PAYMENT_ALLOCATION');
    assert.equal(unallocItem.allocationState, 'UNALLOCATED');
    assert.equal(unallocItem.allocatedAmount, '0.00');
    assert.equal(unallocItem.unallocatedAmount, line1Amount);
    assert.equal(unallocItem.blockerCode, null);
    assert.deepEqual(unallocItem.responsible, {
      permission: 'handyman.finance.manage',
      action: 'ALLOCATE_CUSTOMER_PAYMENT',
    });

    // Partially allocate 40.00 -> stays in PAYMENT_ALLOCATION with PARTIALLY_ALLOCATED
    const partialAlloc = await post(
      financeManager.token,
      `${scope1Url}/payment-allocations`,
      {
        paymentId: payment1Id,
        chargeLineId: chargeLine1Id,
        amount: '40.00',
        idempotencyKey: key(),
      },
    );
    assert.equal(partialAlloc.status, 200);

    const inboxPartial = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}`,
    );
    assert.equal(inboxPartial.status, 200);
    assert.equal(inboxPartial.body.data.items.length, 1);
    assert.equal(
      inboxPartial.body.data.items[0].allocationState,
      'PARTIALLY_ALLOCATED',
    );
    assert.equal(inboxPartial.body.data.items[0].allocatedAmount, '40.00');
    const remainingAmount = (Number(line1Amount) - 40).toFixed(2);
    assert.equal(
      inboxPartial.body.data.items[0].unallocatedAmount,
      remainingAmount,
    );

    // Allocate remaining balance -> payment leaves the Action Inbox
    const fullAlloc = await post(
      financeManager.token,
      `${scope1Url}/payment-allocations`,
      {
        paymentId: payment1Id,
        chargeLineId: chargeLine1Id,
        amount: remainingAmount,
        idempotencyKey: key(),
      },
    );
    assert.equal(fullAlloc.status, 200);

    const inboxAfterFullAlloc = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}`,
    );
    assert.equal(inboxAfterFullAlloc.status, 200);
    assert.equal(inboxAfterFullAlloc.body.data.items.length, 0);

    // Derive entitlements and prepare settlement unit -> appears in PENDING_RECONCILIATION (PAYABLE)
    const derived1 = await post(
      financeManager.token,
      `${scope1Url}/financial-entitlements/derive`,
      { idempotencyKey: key() },
    );
    assert.equal(derived1.status, 200);

    const prepared1 = await post(
      settlementManager.token,
      `${scope1Url}/settlement/prepare`,
      { idempotencyKey: key() },
    );
    assert.equal(prepared1.status, 200);
    const unit1Id = prepared1.body.data.unitId as string;

    const inboxPayable = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}`,
    );
    assert.equal(inboxPayable.status, 200);
    assert.equal(inboxPayable.body.data.items.length, 1);
    assert.equal(inboxPayable.body.data.items[0].recordId, unit1Id);
    assert.equal(inboxPayable.body.data.items[0].recordType, 'SETTLEMENT_UNIT');
    assert.equal(inboxPayable.body.data.items[0].recordStatus, 'PAYABLE');
    assert.equal(
      inboxPayable.body.data.items[0].actionCategory,
      'PENDING_RECONCILIATION',
    );
    assert.deepEqual(inboxPayable.body.data.items[0].responsible, {
      permission: 'handyman.settlement.manage',
      action: 'INCLUDE_IN_SETTLEMENT',
    });

    // Include & Reconcile & Settle -> terminal SETTLED with MATCHED leaves Action Inbox
    await post(settlementManager.token, `${scope1Url}/settlement/include`, {
      idempotencyKey: key(),
    });
    await post(settlementManager.token, `${scope1Url}/settlement/reconcile`, {
      idempotencyKey: key(),
    });
    const settled1 = await post(
      settlementManager.token,
      `${scope1Url}/settlement/settle`,
      { idempotencyKey: key() },
    );
    assert.equal(settled1.status, 200);

    const inboxAfterSettle = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}`,
    );
    assert.equal(inboxAfterSettle.status, 200);
    assert.equal(inboxAfterSettle.body.data.items.length, 0);

    // Record a post-settlement refund -> surfaces in PENDING_CORRECTION (LEDGER_CORRECTION)
    const refund1 = await post(
      financeManager.token,
      `${scope1Url}/ledger-refunds`,
      {
        paymentId: payment1Id,
        amount: '10.00',
        reason: 'Post-settlement goodwill refund',
        idempotencyKey: key(),
      },
    );
    assert.equal(refund1.status, 200, JSON.stringify(refund1.body));
    const correction1Id = refund1.body.data.correction.id as string;

    const inboxPendingCorr = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&includeCounts=true`,
    );
    assert.equal(inboxPendingCorr.status, 200);
    assert.equal(inboxPendingCorr.body.data.items.length, 1);
    const corrItem = inboxPendingCorr.body.data.items[0];
    assert.equal(corrItem.recordId, correction1Id);
    assert.equal(corrItem.recordType, 'LEDGER_CORRECTION');
    assert.equal(corrItem.recordStatus, 'REFUND');
    assert.equal(corrItem.actionCategory, 'PENDING_CORRECTION');
    assert.equal(corrItem.provenance.ledgerCorrectionId, correction1Id);
    assert.equal(corrItem.provenance.settlementCorrectionPending, true);
    assert.equal(corrItem.provenance.settlementUnitId, unit1Id);
    assert.deepEqual(corrItem.responsible, {
      permission: 'handyman.settlement.manage',
      action: 'RECORD_SETTLEMENT_CORRECTION',
    });

    // Propagate correction to settlement -> LEDGER_CORRECTION resolves, SETTLEMENT_UNIT surfaces as FINANCE_BLOCKER (OPEN_EXCEPTION / VARIANCE)
    const propCorr = await post(
      settlementManager.token,
      `${scope1Url}/settlement/correction`,
      {
        ledgerCorrectionId: correction1Id,
        idempotencyKey: key(),
      },
    );
    assert.equal(propCorr.status, 200, JSON.stringify(propCorr.body));

    const reconVariance = await post(
      settlementManager.token,
      `${scope1Url}/settlement/reconcile`,
      { idempotencyKey: key() },
    );
    assert.equal(reconVariance.status, 200);
    assert.equal(reconVariance.body.data.outcome, 'VARIANCE');

    const inboxVariance = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&includeCounts=true`,
    );
    assert.equal(inboxVariance.status, 200);
    assert.equal(inboxVariance.body.data.items.length, 1);
    const varItem = inboxVariance.body.data.items[0];
    assert.equal(varItem.recordId, unit1Id);
    assert.equal(varItem.recordType, 'SETTLEMENT_UNIT');
    assert.equal(varItem.actionCategory, 'FINANCE_BLOCKER');
    assert.equal(varItem.provenance.reconciliationOutcome, 'VARIANCE');
    assert.equal(varItem.blockerCode, varItem.provenance.varianceCause);
    assert.equal(inboxVariance.body.data.counts.byActionCategory.FINANCE_BLOCKER, 1);
  });

  it('P0-B.2: keyset pagination is duplicate-free, stable across mid-walk insertions, server-side filterable, and counts cover the complete authorized set', async () => {
    const base = await baseFixture();
    const clientId = base.realm.client.id;
    const buildingA1 = base.realm.building.id;
    const siblingB2 = randomUUID();
    await ensureBuildingExistsInRealm(base.realm, siblingB2);
    await setupActiveCommercialAgreement(clientId);

    const financeReaderA1 = await createPersonaActor({
      label: 'inbox-reader-a1',
      buildingIds: [buildingA1],
      permissions: ['handyman.finance.read'],
    });

    // Create 4 actionable items in Building A1 and 2 actionable items in sibling Building B2
    const sA1_1 = await createScopedCrewAndScope(base.realm, buildingA1);
    await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${sA1_1.scope.id}/customer-transaction`,
      { idempotencyKey: key() },
    ); // Item 1: NO_POSTED_CHARGE_FACTS

    const sA1_2 = await createScopedCrewAndScope(base.realm, buildingA1);
    const scopeA1_2Url = `${V1}/handyman/execution-scopes/${sA1_2.scope.id}`;
    await post(adminToken, `${scopeA1_2Url}/customer-transaction`, {
      idempotencyKey: key(),
    });
    const lineA1_2 = await q(
      `SELECT id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
      [sA1_2.scope.approvedQuotationVersionId],
    );
    await post(adminToken, `${scopeA1_2Url}/customer-charge-lines`, {
      quotationLineId: lineA1_2.rows[0].id as string,
      idempotencyKey: key(),
    });
    const payPending = await post(
      adminToken,
      `${scopeA1_2Url}/customer-payments`,
      {
        amount: '50.00',
        channel: 'QRIS',
        idempotencyKey: key(),
      },
    ); // Item 2: PENDING payment
    const payConfirmed = await post(
      adminToken,
      `${scopeA1_2Url}/customer-payments`,
      {
        amount: '60.00',
        channel: 'BANK_TRANSFER',
        idempotencyKey: key(),
      },
    );
    await post(
      adminToken,
      `${scopeA1_2Url}/customer-payments/${payConfirmed.body.data.payment.id}/confirm`,
      { idempotencyKey: key() },
    ); // Item 3: CONFIRMED unallocated payment

    const sA1_3 = await createScopedCrewAndScope(base.realm, buildingA1);
    const scopeA1_3Url = `${V1}/handyman/execution-scopes/${sA1_3.scope.id}`;
    await post(adminToken, `${scopeA1_3Url}/customer-transaction`, {
      idempotencyKey: key(),
    });
    const lineA1_3 = await q(
      `SELECT id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
      [sA1_3.scope.approvedQuotationVersionId],
    );
    const compA1_3 = await post(
      adminToken,
      `${scopeA1_3Url}/customer-charge-lines`,
      {
        quotationLineId: lineA1_3.rows[0].id as string,
        idempotencyKey: key(),
      },
    );
    const payA1_3 = await post(
      adminToken,
      `${scopeA1_3Url}/customer-payments`,
      {
        amount: compA1_3.body.data.chargeLine.amount as string,
        channel: 'BANK_TRANSFER',
        idempotencyKey: key(),
      },
    );
    await post(
      adminToken,
      `${scopeA1_3Url}/customer-payments/${payA1_3.body.data.payment.id}/confirm`,
      { idempotencyKey: key() },
    );
    await post(adminToken, `${scopeA1_3Url}/payment-allocations`, {
      paymentId: payA1_3.body.data.payment.id as string,
      chargeLineId: compA1_3.body.data.chargeLine.id as string,
      amount: compA1_3.body.data.chargeLine.amount as string,
      idempotencyKey: key(),
    });
    await post(adminToken, `${scopeA1_3Url}/financial-entitlements/derive`, {
      idempotencyKey: key(),
    });
    await post(adminToken, `${scopeA1_3Url}/settlement/prepare`, {
      idempotencyKey: key(),
    }); // Item 4: PAYABLE settlement unit

    // Create 2 items in sibling Building B2 (must NOT leak to financeReaderA1)
    const sB2_1 = await createScopedCrewAndScope(base.realm, siblingB2);
    const openB2 = await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${sB2_1.scope.id}/customer-transaction`,
      { idempotencyKey: key() },
    );
    const b2TxId = openB2.body.data.transaction.id as string;

    // 1. Partial page request (limit=1) with includeCounts=true returns counts over all 4 authorized items (not 1, and not 6!)
    const page1 = await get(
      financeReaderA1.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&limit=1&includeCounts=true`,
    );
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    assert.equal(page1.body.data.items.length, 1);
    assert.equal(page1.body.data.pagination.hasMore, true);
    assert.ok(page1.body.data.pagination.nextCursor);
    assert.equal(page1.body.data.counts.total, 4);
    assert.deepEqual(page1.body.data.counts.byActionCategory, {
      PAYMENT_VERIFICATION: 1,
      PAYMENT_ALLOCATION: 1,
      PENDING_CORRECTION: 0,
      PENDING_RECONCILIATION: 1,
      FINANCE_BLOCKER: 1,
    });

    // 2. Walk all pages at limit=1 and verify zero duplicates and zero sibling-Building leakage
    const walkedIds: string[] = [page1.body.data.items[0].recordId];
    let cursor: string | null = page1.body.data.pagination.nextCursor;

    // Insert a brand-new item in Building A1 AFTER page 1 is fetched -> must sort before cursor, never duplicate in continuation!
    const sA1_New = await createScopedCrewAndScope(base.realm, buildingA1);
    const openNew = await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${sA1_New.scope.id}/customer-transaction`,
      { idempotencyKey: key() },
    );
    const newTxId = openNew.body.data.transaction.id as string;

    while (cursor) {
      const nextRes = await get(
        financeReaderA1.token,
        `${V1}/handyman/finance/action-inbox?clientId=${clientId}&limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      assert.equal(nextRes.status, 200, JSON.stringify(nextRes.body));
      for (const item of nextRes.body.data.items) {
        assert.ok(
          !walkedIds.includes(item.recordId),
          `duplicate recordId ${item.recordId} in continuation walk`,
        );
        assert.notEqual(
          item.recordId,
          b2TxId,
          'sibling Building B2 item must never leak',
        );
        assert.notEqual(
          item.recordId,
          newTxId,
          'newly inserted item must not shift into an in-flight continuation walk',
        );
        walkedIds.push(item.recordId);
      }
      cursor = nextRes.body.data.pagination.nextCursor;
    }
    assert.equal(walkedIds.length, 4);

    // Fresh first-page fetch now surfaces all 5 authorized Building A1 items with newTxId first
    const freshFirst = await get(
      financeReaderA1.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&limit=10&includeCounts=true`,
    );
    assert.equal(freshFirst.status, 200);
    assert.equal(freshFirst.body.data.items.length, 5);
    assert.equal(freshFirst.body.data.counts.total, 5);
    assert.equal(freshFirst.body.data.items[0].recordId, newTxId);

    // 3. Server-side filters narrow both items and counts
    const onlyPayments = await get(
      financeReaderA1.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&recordType=CUSTOMER_PAYMENT&includeCounts=true`,
    );
    assert.equal(onlyPayments.status, 200);
    assert.equal(onlyPayments.body.data.items.length, 2);
    assert.equal(onlyPayments.body.data.counts.total, 2);

    const onlyVerification = await get(
      financeReaderA1.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&actionCategory=PAYMENT_VERIFICATION&includeCounts=true`,
    );
    assert.equal(onlyVerification.status, 200);
    assert.equal(onlyVerification.body.data.items.length, 1);
    assert.equal(
      onlyVerification.body.data.items[0].recordId,
      payPending.body.data.payment.id,
    );

    const onlyBlockers = await get(
      financeReaderA1.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&hasBlocker=true&includeCounts=true`,
    );
    assert.equal(onlyBlockers.status, 200);
    assert.equal(onlyBlockers.body.data.items.length, 3); // 2 NO_POSTED_CHARGE_FACTS + 1 PROVISIONAL_PAYMENTS_PENDING
    assert.equal(onlyBlockers.body.data.counts.total, 3);

    // 4. Sibling Building filter and malformed cursor are rejected
    const siblingDenied = await get(
      financeReaderA1.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&buildingId=${siblingB2}&includeCounts=true`,
    );
    assert.equal(siblingDenied.status, 403);
    assert.equal(siblingDenied.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(siblingDenied.body.data, undefined);

    const badCursor = await get(
      financeReaderA1.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientId}&cursor=not-a-valid-cursor`,
    );
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.error.code, 'VALIDATION_ERROR');
  });

  it('P0-B.3 & Persona Separation: enforces strict persona walls, zero unauthorized write persistence, and no automatic Platform Admin finance authority', async () => {
    const base = await baseFixture();
    const clientId = base.realm.client.id;
    const buildingId = base.realm.building.id;
    await setupActiveCommercialAgreement(clientId);

    const s = await createScopedCrewAndScope(base.realm, buildingId);
    const scopeUrl = `${V1}/handyman/execution-scopes/${s.scope.id}`;
    await post(adminToken, `${scopeUrl}/customer-transaction`, {
      idempotencyKey: key(),
    });
    const line = await q(
      `SELECT id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
      [s.scope.approvedQuotationVersionId],
    );
    const composed = await post(
      adminToken,
      `${scopeUrl}/customer-charge-lines`,
      {
        quotationLineId: line.rows[0].id as string,
        idempotencyKey: key(),
      },
    );
    const chargeLineId = composed.body.data.chargeLine.id as string;

    const careManager = await createPersonaActor({
      label: 'care-mgr-sep',
      buildingIds: [buildingId],
      permissions: ['tenant_company.read', 'tenant_company.manage'],
    });
    const commercialOnly = await createPersonaActor({
      label: 'commercial-only-sep',
      buildingIds: [buildingId],
      permissions: ['handyman.commercial.manage'],
    });
    const settlementOnly = await createPersonaActor({
      label: 'settlement-only-sep',
      buildingIds: [buildingId],
      permissions: ['handyman.settlement.manage'],
    });
    const financeOnly = await createPersonaActor({
      label: 'finance-only-sep',
      buildingIds: [buildingId],
      permissions: ['handyman.finance.read', 'handyman.finance.manage'],
    });

    // Platform Admin with default foundation seed grants (which withhold UNASSIGNED_BY_DEFAULT_PERMISSION_CODES:
    // handyman.commercial.manage, handyman.finance.read, handyman.finance.manage, handyman.settlement.manage)
    for (const withheld of [
      'handyman.commercial.manage',
      'handyman.finance.read',
      'handyman.finance.manage',
      'handyman.settlement.manage',
    ]) {
      assert.ok(
        UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(withheld),
        `${withheld} must be withheld from default PLATFORM_ADMIN seed`,
      );
    }
    const defaultPlatformAdminPerms = FOUNDATION_PERMISSIONS.map(
      (p) => p.code,
    ).filter((code) => !UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(code));
    const defaultPlatformAdmin = await createPersonaActor({
      label: 'foundation-platform-admin',
      buildingIds: [buildingId],
      permissions: defaultPlatformAdminPerms,
    });

    // Customer Care can report a payment (`tenant_company.manage`), but cannot verify, allocate, refund, or read Finance inbox
    const reported = await post(
      careManager.token,
      `${scopeUrl}/customer-payments`,
      {
        amount: '80.00',
        channel: 'CASH',
        idempotencyKey: key(),
      },
    );
    assert.equal(reported.status, 200);
    const paymentId = reported.body.data.payment.id as string;

    // Snapshot DB counts before unauthorized write attempts
    const beforeCounts = await q(
      `SELECT
         (SELECT COUNT(*)::int FROM handyman_customer_payments WHERE id = $1 AND status = 'CONFIRMED') AS confirmed_cnt,
         (SELECT COUNT(*)::int FROM handyman_payment_allocations WHERE payment_id = $1) AS alloc_cnt,
         (SELECT COUNT(*)::int FROM handyman_ledger_corrections WHERE source_payment_id = $1) AS corr_cnt,
         (SELECT COUNT(*)::int FROM handyman_settlement_units WHERE execution_scope_id = $2) AS settle_cnt`,
      [paymentId, s.scope.id],
    );

    // Denied Finance Action Inbox reads for Care, Commercial-only, Settlement-only, and default Platform Admin
    for (const token of [
      careManager.token,
      commercialOnly.token,
      settlementOnly.token,
      defaultPlatformAdmin.token,
    ]) {
      const inboxDenied = await get(
        token,
        `${V1}/handyman/finance/action-inbox?clientId=${clientId}`,
      );
      assert.equal(inboxDenied.status, 403);
      assert.equal(inboxDenied.body.error.code, 'PERMISSION_DENIED');
    }

    // Denied payment confirmation & allocation & refund for Care, Commercial-only, Settlement-only, and default Platform Admin
    for (const token of [
      careManager.token,
      commercialOnly.token,
      settlementOnly.token,
      defaultPlatformAdmin.token,
    ]) {
      const confirmDenied = await post(
        token,
        `${scopeUrl}/customer-payments/${paymentId}/confirm`,
        { idempotencyKey: key() },
      );
      assert.equal(confirmDenied.status, 403);

      const allocDenied = await post(token, `${scopeUrl}/payment-allocations`, {
        paymentId,
        chargeLineId,
        amount: '40.00',
        idempotencyKey: key(),
      });
      assert.equal(allocDenied.status, 403);

      const refundDenied = await post(token, `${scopeUrl}/ledger-refunds`, {
        paymentId,
        amount: '10.00',
        reason: 'unauthorized probe',
        idempotencyKey: key(),
      });
      assert.equal(refundDenied.status, 403);
    }

    // Finance-only actor cannot execute settlement ladder commands
    const settlePrepDenied = await post(
      financeOnly.token,
      `${scopeUrl}/settlement/prepare`,
      { idempotencyKey: key() },
    );
    assert.equal(settlePrepDenied.status, 403);
    assert.equal(settlePrepDenied.body.error.code, 'PERMISSION_DENIED');

    // Verify ZERO unauthorized writes persisted in PostgreSQL
    const afterCounts = await q(
      `SELECT
         (SELECT COUNT(*)::int FROM handyman_customer_payments WHERE id = $1 AND status = 'CONFIRMED') AS confirmed_cnt,
         (SELECT COUNT(*)::int FROM handyman_payment_allocations WHERE payment_id = $1) AS alloc_cnt,
         (SELECT COUNT(*)::int FROM handyman_ledger_corrections WHERE source_payment_id = $1) AS corr_cnt,
         (SELECT COUNT(*)::int FROM handyman_settlement_units WHERE execution_scope_id = $2) AS settle_cnt`,
      [paymentId, s.scope.id],
    );
    assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0]);
  });

  it('OpenAPI contract: documents /handyman/finance/action-inbox and Building-scoped /handyman/financial-transactions', () => {
    const spec = YAML.parse(
      readFileSync('docs/api/openapi.yaml', 'utf8'),
    ) as Record<string, any>;

    const inboxGet = spec.paths?.['/handyman/finance/action-inbox']?.get;
    assert.ok(inboxGet, '/handyman/finance/action-inbox GET must exist in openapi.yaml');
    assert.equal(inboxGet.operationId, 'listHandymanFinanceActionInbox');
    assert.equal(inboxGet['x-required-permission'], 'handyman.finance.read');
    assert.equal(inboxGet['x-building-scoped'], true);
    const inboxParams = (inboxGet.parameters ?? []).map((p: any) => p.name);
    for (const requiredParam of [
      'clientId',
      'buildingId',
      'recordType',
      'actionCategory',
      'recordStatus',
      'blockerCode',
      'hasBlocker',
      'responsiblePermission',
      'includeCounts',
      'limit',
      'cursor',
    ]) {
      assert.ok(
        inboxParams.includes(requiredParam),
        `openapi parameter ${requiredParam} must be documented on /handyman/finance/action-inbox`,
      );
    }

    const reportGet = spec.paths?.['/handyman/financial-transactions']?.get;
    assert.ok(reportGet, '/handyman/financial-transactions GET must exist in openapi.yaml');
    assert.equal(reportGet['x-required-permission'], 'handyman.finance.read');
    assert.equal(reportGet['x-building-scoped'], true);
    const reportParams = (reportGet.parameters ?? []).map((p: any) => p.name);
    assert.ok(reportParams.includes('clientId'));
    assert.ok(reportParams.includes('buildingId'));
  });
});
