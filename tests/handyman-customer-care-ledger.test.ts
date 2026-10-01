import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import YAML from 'yaml';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService }
  from '../src/modules/building-assignments';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import {
  adjustHandymanCustomerLedger,
  refundHandymanCustomerPayment,
  reverseHandymanPaymentAllocation,
} from '../src/modules/handyman-customer-ledger-corrections';
import {
  readHandymanLedgerClientBasisAt,
  readHandymanLedgerTransactionAt,
} from '../src/modules/handyman-customer-ledger-read';
import { allocateHandymanCustomerPayment }
  from '../src/modules/handyman-customer-payment-allocations';
import {
  confirmHandymanCustomerPayment,
  recordHandymanCustomerPayment,
} from '../src/modules/handyman-customer-payments';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import { permissionRepository, permissionService }
  from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser, createPlainSession } from './helpers/access';
import {
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-17 GAP PART 05 — B6 Customer Ledger & Payment Transport
 * focused verification suite.
 *
 * Verifies:
 *  1. `GET /api/v1/handyman/execution-scopes/:executionScopeId/customer-ledger`
 *     returns the published CR-HM-13 PART 06 transaction read contract
 *     (`LABOR`/`MATERIAL` lines, payments, allocations, corrections,
 *     gross/net totals, authority gate) for Customer Care actors with
 *     `tenant_company.read` + `canAccessClient`.
 *  2. `GET /api/v1/handyman/customer-ledger` returns the published
 *     windowed client-level customer ledger basis read contract.
 *  3. Bounded customer payment transport (`GET/POST .../customer-payments`,
 *     `POST .../confirm`, `POST .../reject`) enforces `tenant_company.manage`,
 *     `canAccessClient`, idempotency replay safety, ignoring smuggled
 *     authority keys, and one-way payment decisions.
 *  4. Access control (`401`, `403`, `404`, `400`) and strict client
 *     isolation across all 6 operations.
 *  5. Strict firewall: zero CR-HM-14 provider/BM entitlement or
 *     settlement exposure, zero gateway-specific authority, zero local
 *     financial math, zero FM/SaaS fallback, and OpenAPI parity.
 */

const V1 = '/api/v1';
const DIR = '/tmp/hm17-gap-part05-pg';
const PORT = 55445;

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ASENTRA_USE_EMBEDDED_POSTGRES: 'true',
  DB_NAME: 'asentra_test',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL: 'false',
});

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    authMethod: 'trust',
  });
  await pg.initialise();
  await pg.start();
  const adminClient = pg.getPgClient('postgres', '127.0.0.1');
  await adminClient.connect();
  await adminClient.query('CREATE DATABASE asentra_test');
  await adminClient.end();

  const db = await ensureTestDatabase();
  assert.ok(db, 'test database must be available');
  pool = await initDatabase(db);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) {
    throw new Error('GENERAL_HANDYMAN discipline seed missing');
  }
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    pool = null;
    pg = null;
    await rm(DIR, { recursive: true, force: true });
  }
});

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const key = () => `k-${randomUUID()}`;

async function loginUser(userId: string, email: string): Promise<string> {
  const password = `Pass${randomUUID().slice(0, 8)}!1`;
  await credentialService.createInitialCredential({ userId, password });
  const login = await api().post(`${V1}/auth/login`).send({
    email,
    password,
  });
  return login.body.data.sessionToken as string;
}

async function createCustomerCareActor(
  buildingId: string,
  permissions: Array<{ code: string; name: string }>,
): Promise<{ userId: string; token: string }> {
  const suffix = randomUUID().slice(0, 8);
  const email = `care-ledger-${suffix}@example.com`;
  const user = await userService.createUser({
    email,
    displayName: `Care Ledger Actor ${suffix}`,
  });
  if (permissions.length > 0) {
    const role = await roleService.createRole({
      code: `CARE_LEDGER_ROLE_${suffix.toUpperCase()}`,
      name: `Care Ledger Role ${suffix}`,
    });
    for (const perm of permissions) {
      let record = await permissionRepository.findByCode(perm.code);
      if (!record) {
        record = await permissionService.createPermission(perm);
      }
      await permissionService.assignPermissionToRole(role.id, record.id);
    }
    await roleService.assignRoleToUser(user.id, role.id);
  }
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const token = await loginUser(user.id, user.email);
  return { userId: user.id, token };
}

async function setupScopeLedgerFixture() {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  assert.ok(f.scope, 'approved scope required');
  const scope = f.scope!;
  const versionId = scope.approvedQuotationVersionId;

  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [scope.clientId],
  );
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Copper pipe', 4,
               $3::uuid, 25, 100, 'IDR', NULL, $4::uuid)`,
    [materialLineId, versionId, uomRow.rows[0].id, adminUserId],
  );
  const laborRow = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
    [versionId],
  );
  const laborLineId = laborRow.rows[0].id as string;

  const opened = await openHandymanCustomerTransaction(
    {
      executionScopeId: scope.id,
      idempotencyKey: key(),
    },
    adminUserId,
  );
  const laborCharge = await composeHandymanChargeLine(
    {
      executionScopeId: scope.id,
      quotationLineId: laborLineId,
      idempotencyKey: key(),
    },
    adminUserId,
  );
  const materialCharge = await composeHandymanChargeLine(
    {
      executionScopeId: scope.id,
      quotationLineId: materialLineId,
      idempotencyKey: key(),
    },
    adminUserId,
  );

  return {
    realm,
    chain,
    clientId: scope.clientId,
    buildingId: realm.building.id,
    executionScopeId: scope.id,
    quotationVersionId: versionId,
    transactionId: opened.transaction.id,
    laborLineId,
    materialLineId,
    laborChargeLineId: laborCharge.chargeLine.id,
    materialChargeLineId: materialCharge.chargeLine.id,
  };
}

describe('CR-HM-17 GAP PART 05 — Customer Ledger & Payment Transport (B6)', () => {
  it('1: GET /handyman/execution-scopes/:executionScopeId/customer-ledger returns authoritative CR-HM-13 transaction facts and totals', async () => {
    const f = await setupScopeLedgerFixture();
    const careReader = await createCustomerCareActor(f.buildingId, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);

    const recorded = await recordHandymanCustomerPayment(
      {
        executionScopeId: f.executionScopeId,
        amount: '100.00',
        channel: 'BANK_TRANSFER',
        providerName: 'Bank Transfer',
        providerReference: `ref-${randomUUID()}`,
        externalReference: `ext-${randomUUID()}`,
        idempotencyKey: key(),
      },
      adminUserId,
    );
    await confirmHandymanCustomerPayment(
      {
        executionScopeId: f.executionScopeId,
        paymentId: recorded.payment.id,
        idempotencyKey: key(),
      },
      adminUserId,
    );
    const allocLabor = await allocateHandymanCustomerPayment(
      {
        executionScopeId: f.executionScopeId,
        paymentId: recorded.payment.id,
        chargeLineId: f.laborChargeLineId,
        amount: '40.00',
        idempotencyKey: key(),
      },
      adminUserId,
    );
    const allocMaterial = await allocateHandymanCustomerPayment(
      {
        executionScopeId: f.executionScopeId,
        paymentId: recorded.payment.id,
        chargeLineId: f.materialChargeLineId,
        amount: '30.00',
        idempotencyKey: key(),
      },
      adminUserId,
    );
    await reverseHandymanPaymentAllocation(
      {
        executionScopeId: f.executionScopeId,
        allocationId: allocMaterial.allocation.id,
        reason: 'reverse material allocation',
        idempotencyKey: key(),
      },
      adminUserId,
    );
    await refundHandymanCustomerPayment(
      {
        executionScopeId: f.executionScopeId,
        paymentId: recorded.payment.id,
        amount: '20.00',
        reason: 'partial goodwill refund',
        idempotencyKey: key(),
      },
      adminUserId,
    );
    await adjustHandymanCustomerLedger(
      {
        executionScopeId: f.executionScopeId,
        chargeLineId: f.laborChargeLineId,
        amount: '10.00',
        reason: 'labor courtesy adjustment',
        idempotencyKey: key(),
      },
      adminUserId,
    );

    const res = await api()
      .get(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-ledger`)
      .set('Authorization', `Bearer ${careReader.token}`);
    assert.equal(res.status, 200);

    const expected = await readHandymanLedgerTransactionAt(
      f.executionScopeId,
      careReader.userId,
    );
    assert.deepEqual(res.body.data, expected);

    const data = res.body.data;
    assert.equal(data.contractVersion, 'CR-HM-13-PART-06');
    assert.equal(data.readOnly, true);
    assert.equal(data.transaction.transactionId, f.transactionId);
    assert.equal(data.transaction.executionScopeId, f.executionScopeId);
    assert.equal(data.chargeLines.length, 2);
    const kinds = data.chargeLines.map((l: { lineKind: string }) => l.lineKind).sort();
    assert.deepEqual(kinds, ['LABOR', 'MATERIAL']);
    assert.equal(data.payments.length, 1);
    assert.equal(data.payments[0].paymentId, recorded.payment.id);
    assert.equal(data.payments[0].status, 'CONFIRMED');
    assert.equal(data.allocations.length, 2);
    assert.equal(
      data.allocations.find(
        (a: { allocationId: string }) => a.allocationId === allocLabor.allocation.id,
      ).reversed,
      false,
    );
    assert.equal(
      data.allocations.find(
        (a: { allocationId: string }) => a.allocationId === allocMaterial.allocation.id,
      ).reversed,
      true,
    );
    assert.equal(data.corrections.length, 3);
    assert.deepEqual(data.totals, {
      chargedGross: '200.00',
      laborGross: '100.00',
      materialGross: '100.00',
      laborAdjusted: '10.00',
      materialAdjusted: '0.00',
      adjustedTransactionScope: '0.00',
      adjusted: '10.00',
      chargedNet: '190.00',
      laborNet: '90.00',
      materialNet: '100.00',
      allocated: '70.00',
      reversedAllocations: '30.00',
      applied: '40.00',
      receivedGross: '100.00',
      receivedReversed: '0.00',
      receivedNet: '100.00',
      refunded: '20.00',
      netReceived: '80.00',
      outstanding: '150.00',
      corrections: { refunds: 1, reversals: 1, adjustments: 1 },
    });
    assert.equal(data.authority.authoritativeForEntitlement, true);
    assert.deepEqual(data.authority.deniedBy, []);
  });

  it('2: GET /handyman/customer-ledger returns windowed client-level ledger basis with query validation', async () => {
    const f1 = await setupScopeLedgerFixture();
    // Open a second scope in the same client with a PENDING payment
    const chain2 = await locationChain(f1.realm);
    const scope2 = await scopeFixture(f1.realm, chain2);
    assert.ok(scope2.scope);
    const laborRow2 = await q(
      `SELECT id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
      [scope2.scope!.approvedQuotationVersionId],
    );
    const opened2 = await openHandymanCustomerTransaction(
      {
        executionScopeId: scope2.scope!.id,
        idempotencyKey: key(),
      },
      adminUserId,
    );
    await composeHandymanChargeLine(
      {
        executionScopeId: scope2.scope!.id,
        quotationLineId: laborRow2.rows[0].id as string,
        idempotencyKey: key(),
      },
      adminUserId,
    );
    await recordHandymanCustomerPayment(
      {
        executionScopeId: scope2.scope!.id,
        amount: '50.00',
        channel: 'QRIS',
        idempotencyKey: key(),
      },
      adminUserId,
    );

    const careReader = await createCustomerCareActor(f1.buildingId, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);

    const res = await api()
      .get('/api/v1/handyman/customer-ledger')
      .query({
        clientId: f1.clientId,
        from: '2000-01-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z',
        limit: '25',
      })
      .set('Authorization', `Bearer ${careReader.token}`);
    assert.equal(res.status, 200);

    const expected = await readHandymanLedgerClientBasisAt(
      f1.clientId,
      careReader.userId,
      {
        from: '2000-01-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z',
        limit: 25,
      },
    );
    assert.deepEqual(res.body.data, expected);
    assert.equal(res.body.data.contractVersion, 'CR-HM-13-PART-06');
    assert.equal(res.body.data.readOnly, true);
    assert.equal(res.body.data.clientId, f1.clientId);
    assert.equal(res.body.data.limit, 25);
    assert.equal(res.body.data.transactions.length, 2);
    assert.equal(res.body.data.totals.transactionCount, 2);
    assert.equal(res.body.data.authority.authoritativeForEntitlement, false);
    assert.deepEqual(res.body.data.authority.deniedBy, [
      'PROVISIONAL_PAYMENTS_PENDING',
    ]);
    assert.deepEqual(res.body.data.authority.nonAuthoritativeTransactionIds, [
      opened2.transaction.id,
    ]);

    // Invalid query parameters fail closed with 400
    const missingClient = await api()
      .get('/api/v1/handyman/customer-ledger')
      .set('Authorization', `Bearer ${careReader.token}`);
    assert.equal(missingClient.status, 400);

    const badWindow = await api()
      .get('/api/v1/handyman/customer-ledger')
      .query({
        clientId: f1.clientId,
        from: '2026-10-02T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${careReader.token}`);
    assert.equal(badWindow.status, 400);

    const badLimit = await api()
      .get('/api/v1/handyman/customer-ledger')
      .query({
        clientId: f1.clientId,
        limit: '501',
      })
      .set('Authorization', `Bearer ${careReader.token}`);
    assert.equal(badLimit.status, 400);
  });

  it('3: bounded customer payment transport records, replays, confirms, rejects, and lists payments', async () => {
    const f = await setupScopeLedgerFixture();
    const careManager = await createCustomerCareActor(f.buildingId, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
      { code: 'tenant_company.manage', name: 'Manage tenant company' },
    ]);

    const recordKey = key();
    const extRef = `ext-${randomUUID()}`;
    // Record payment #1 with smuggled authority fields that must be ignored
    const recordRes = await api()
      .post(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({
        amount: '120.00',
        channel: 'VIRTUAL_ACCOUNT',
        providerName: 'Neutral Bank VA',
        providerReference: 'va-ref-001',
        externalReference: extRef,
        idempotencyKey: recordKey,
        // Smuggled authority keys — must be ignored
        status: 'CONFIRMED',
        currency: 'USD',
        clientId: randomUUID(),
        providerPayable: '999.00',
        bmFeeAmount: '111.00',
        settlementStatus: 'SETTLED',
      });
    assert.equal(recordRes.status, 200);
    assert.equal(recordRes.body.data.replayed, false);
    assert.equal(recordRes.body.data.payment.status, 'PENDING');
    assert.equal(recordRes.body.data.payment.amount, '120.00');
    assert.equal(recordRes.body.data.payment.currency, 'IDR');
    assert.equal(recordRes.body.data.payment.channel, 'VIRTUAL_ACCOUNT');
    assert.equal(recordRes.body.data.payment.recordedByUserId, careManager.userId);
    assert.equal(recordRes.body.data.event.eventType, 'RECORD_PAYMENT');
    const payment1Id = recordRes.body.data.payment.id as string;

    // Replay with the same idempotencyKey returns the exact same payment
    const replayRecord = await api()
      .post(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({
        amount: '120.00',
        channel: 'VIRTUAL_ACCOUNT',
        externalReference: extRef,
        idempotencyKey: recordKey,
      });
    assert.equal(replayRecord.status, 200);
    assert.equal(replayRecord.body.data.replayed, true);
    assert.equal(replayRecord.body.data.payment.id, payment1Id);

    // Duplicate externalReference with a new idempotencyKey fails closed with 409
    const dupExtRes = await api()
      .post(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({
        amount: '120.00',
        channel: 'VIRTUAL_ACCOUNT',
        externalReference: extRef,
        idempotencyKey: key(),
      });
    assert.equal(dupExtRes.status, 409);

    // Confirm payment #1 + replay + conflicting re-decision
    const confirmKey = key();
    const confirmRes = await api()
      .post(
        `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${payment1Id}/confirm`,
      )
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({ idempotencyKey: confirmKey });
    assert.equal(confirmRes.status, 200);
    assert.equal(confirmRes.body.data.replayed, false);
    assert.equal(confirmRes.body.data.payment.status, 'CONFIRMED');
    assert.equal(confirmRes.body.data.payment.decidedByUserId, careManager.userId);
    assert.equal(confirmRes.body.data.event.eventType, 'CONFIRM_PAYMENT');

    const replayConfirm = await api()
      .post(
        `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${payment1Id}/confirm`,
      )
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({ idempotencyKey: confirmKey });
    assert.equal(replayConfirm.status, 200);
    assert.equal(replayConfirm.body.data.replayed, true);

    const rejectAfterConfirm = await api()
      .post(
        `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${payment1Id}/reject`,
      )
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({ idempotencyKey: key(), reason: 'late reject attempt' });
    assert.equal(rejectAfterConfirm.status, 409);

    // Record payment #2 and reject it
    const record2Res = await api()
      .post(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({
        amount: '80.00',
        channel: 'QRIS',
        idempotencyKey: key(),
      });
    assert.equal(record2Res.status, 200);
    const payment2Id = record2Res.body.data.payment.id as string;

    const rejectKey = key();
    const rejectRes = await api()
      .post(
        `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${payment2Id}/reject`,
      )
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({
        idempotencyKey: rejectKey,
        reason: 'unverified transfer slip',
      });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.data.replayed, false);
    assert.equal(rejectRes.body.data.payment.status, 'REJECTED');
    assert.equal(
      rejectRes.body.data.payment.rejectionReason,
      'unverified transfer slip',
    );
    assert.equal(rejectRes.body.data.event.eventType, 'REJECT_PAYMENT');

    const replayReject = await api()
      .post(
        `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${payment2Id}/reject`,
      )
      .set('Authorization', `Bearer ${careManager.token}`)
      .send({
        idempotencyKey: rejectKey,
        reason: 'unverified transfer slip',
      });
    assert.equal(replayReject.status, 200);
    assert.equal(replayReject.body.data.replayed, true);

    // List customer payments for the execution scope
    const listRes = await api()
      .get(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${careManager.token}`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.executionScopeId, f.executionScopeId);
    assert.equal(listRes.body.data.payments.length, 2);
    assert.deepEqual(
      listRes.body.data.payments.map((p: { status: string }) => p.status),
      ['CONFIRMED', 'REJECTED'],
    );
  });

  it('4: enforces 401, 403, 404, 400 and strict client isolation across all ledger and payment endpoints', async () => {
    const f = await setupScopeLedgerFixture();
    const otherRealm = await realmFixture();

    const recorded = await recordHandymanCustomerPayment(
      {
        executionScopeId: f.executionScopeId,
        amount: '50.00',
        channel: 'CASH',
        idempotencyKey: key(),
      },
      adminUserId,
    );
    const paymentId = recorded.payment.id;

    const plainToken = await createPlainSession();
    const readerOnly = await createCustomerCareActor(f.buildingId, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);
    const crossClientActor = await createCustomerCareActor(
      otherRealm.building.id,
      [
        { code: 'tenant_company.read', name: 'Read tenant company' },
        { code: 'tenant_company.manage', name: 'Manage tenant company' },
      ],
    );
    const validManager = await createCustomerCareActor(f.buildingId, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
      { code: 'tenant_company.manage', name: 'Manage tenant company' },
    ]);

    const getRoutes = [
      `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-ledger`,
      `/api/v1/handyman/customer-ledger?clientId=${f.clientId}`,
      `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`,
    ];
    for (const route of getRoutes) {
      const unauth = await api().get(route);
      assert.equal(unauth.status, 401, `expected 401 on GET ${route}`);

      const noPerm = await api()
        .get(route)
        .set('Authorization', `Bearer ${plainToken}`);
      assert.equal(noPerm.status, 403, `expected 403 (no perm) on GET ${route}`);

      const foreign = await api()
        .get(route)
        .set('Authorization', `Bearer ${crossClientActor.token}`);
      assert.equal(
        foreign.status,
        403,
        `expected 403 (cross-client) on GET ${route}`,
      );
    }

    const postRoutes: Array<{ url: string; body: Record<string, unknown> }> = [
      {
        url: `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`,
        body: {
          amount: '50.00',
          channel: 'CASH',
          idempotencyKey: key(),
        },
      },
      {
        url: `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${paymentId}/confirm`,
        body: { idempotencyKey: key() },
      },
      {
        url: `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${paymentId}/reject`,
        body: { idempotencyKey: key(), reason: 'denied' },
      },
    ];
    for (const op of postRoutes) {
      const unauth = await api().post(op.url).send(op.body);
      assert.equal(unauth.status, 401, `expected 401 on POST ${op.url}`);

      const readerForbidden = await api()
        .post(op.url)
        .set('Authorization', `Bearer ${readerOnly.token}`)
        .send(op.body);
      assert.equal(
        readerForbidden.status,
        403,
        `expected 403 (read-only) on POST ${op.url}`,
      );

      const foreignForbidden = await api()
        .post(op.url)
        .set('Authorization', `Bearer ${crossClientActor.token}`)
        .send(op.body);
      assert.equal(
        foreignForbidden.status,
        403,
        `expected 403 (cross-client) on POST ${op.url}`,
      );
    }

    // 404 on unknown scope / client / payment
    const unknownUuid = randomUUID();
    const missingScopeLedger = await api()
      .get(`/api/v1/handyman/execution-scopes/${unknownUuid}/customer-ledger`)
      .set('Authorization', `Bearer ${readerOnly.token}`);
    assert.equal(missingScopeLedger.status, 404);

    const missingClientLedger = await api()
      .get(`/api/v1/handyman/customer-ledger?clientId=${unknownUuid}`)
      .set('Authorization', `Bearer ${readerOnly.token}`);
    assert.equal(missingClientLedger.status, 404);

    const missingPaymentConfirm = await api()
      .post(
        `/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments/${unknownUuid}/confirm`,
      )
      .set('Authorization', `Bearer ${validManager.token}`)
      .send({ idempotencyKey: key() });
    assert.equal(missingPaymentConfirm.status, 404);

    // 400 on malformed UUIDs and invalid payment payloads
    const badScopeLedger = await api()
      .get('/api/v1/handyman/execution-scopes/not-a-uuid/customer-ledger')
      .set('Authorization', `Bearer ${readerOnly.token}`);
    assert.equal(badScopeLedger.status, 400);

    const badAmountPost = await api()
      .post(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${validManager.token}`)
      .send({
        amount: '-10.00',
        channel: 'CASH',
        idempotencyKey: key(),
      });
    assert.equal(badAmountPost.status, 400);

    const badChannelPost = await api()
      .post(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${validManager.token}`)
      .send({
        amount: '10.00',
        channel: 'UNSUPPORTED_CHANNEL',
        idempotencyKey: key(),
      });
    assert.equal(badChannelPost.status, 400);
  });

  it('5: strict CR-HM-14 settlement/entitlement firewall, gateway neutrality, and OpenAPI parity', async () => {
    const apiDir = 'src/modules/handyman-customer-ledger-api';
    const files = readdirSync(apiDir).sort();
    assert.deepEqual(files, [
      'handyman-customer-ledger-api.controller.ts',
      'handyman-customer-ledger-api.routes.ts',
      'handyman-customer-ledger-api.validation.ts',
      'index.ts',
    ]);

    const source = files
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(`${apiDir}/${f}`, 'utf8'))
      .join('\n');

    // Zero CR-HM-14 module imports or references
    for (const forbidden of [
      'handyman-financial-entitlements',
      'handyman-settlement',
      'handyman-financial-read',
      'deriveHandymanFinancialEntitlement',
      'prepareHandymanSettlementUnit',
      'readHandymanFinancialTransactionAt',
      'readHandymanFinancialClientAt',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `customer ledger transport must not reference CR-HM-14 symbol ${forbidden}`,
      );
    }

    // Zero named payment gateway runtime or FM/SaaS billing fallback
    for (const forbidden of [
      'midtrans',
      'xendit',
      'stripe',
      'doku',
      'payment_gateway',
      'tenant_invoices',
      'tenant_charges',
      'invoice_payment_status',
      'payment_receipts',
      'vendor_invoices',
      'platform_billing',
      'platform_payments',
      'platform_subscriptions',
    ]) {
      assert.ok(
        !source.toLowerCase().includes(forbidden),
        `customer ledger transport must not reference ${forbidden}`,
      );
    }

    // Zero direct SQL or local financial arithmetic in the transport layer
    for (const forbidden of [
      'getPool',
      'withTransaction',
      'SELECT ',
      'INSERT INTO',
      'UPDATE ',
      'DELETE FROM',
      'toCents',
      'fromCents',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `customer ledger transport must remain thin (found ${forbidden})`,
      );
    }

    // Runtime payload scan: zero CR-HM-14 settlement/entitlement fields or merged charge totals
    const f = await setupScopeLedgerFixture();
    const reader = await createCustomerCareActor(f.buildingId, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);
    const scopeLedgerRes = await api()
      .get(`/api/v1/handyman/execution-scopes/${f.executionScopeId}/customer-ledger`)
      .set('Authorization', `Bearer ${reader.token}`);
    assert.equal(scopeLedgerRes.status, 200);
    const clientLedgerRes = await api()
      .get(`/api/v1/handyman/customer-ledger?clientId=${f.clientId}`)
      .set('Authorization', `Bearer ${reader.token}`);
    assert.equal(clientLedgerRes.status, 200);

    const keys = new Set<string>();
    const collectKeys = (val: unknown) => {
      if (Array.isArray(val)) {
        val.forEach(collectKeys);
      } else if (val && typeof val === 'object') {
        for (const [k, v] of Object.entries(val)) {
          keys.add(k);
          collectKeys(v);
        }
      }
    };
    collectKeys(scopeLedgerRes.body.data);
    collectKeys(clientLedgerRes.body.data);

    for (const forbiddenKey of [
      'providerEntitlement',
      'bmFeeEntitlement',
      'providerPayable',
      'bmFeeAmount',
      'settlementUnit',
      'settlementStatus',
      'reconciliation',
      'payout',
      'disbursement',
      'commission',
      'totalCharge',
      'totalAmount',
      'grandTotal',
    ]) {
      assert.ok(
        !keys.has(forbiddenKey),
        `customer ledger payload must not expose ${forbiddenKey}`,
      );
    }

    // OpenAPI parity check
    const doc = YAML.parse(readFileSync('docs/api/openapi.yaml', 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: {
        parameters: Record<string, unknown>;
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };

    assert.equal(
      doc.paths['/handyman/execution-scopes/{executionScopeId}/customer-ledger']?.get
        ?.operationId,
      'getHandymanExecutionScopeCustomerLedger',
    );
    assert.equal(
      doc.paths['/handyman/customer-ledger']?.get?.operationId,
      'getHandymanClientCustomerLedger',
    );
    assert.equal(
      doc.paths['/handyman/execution-scopes/{executionScopeId}/customer-payments']?.get
        ?.operationId,
      'listHandymanExecutionScopeCustomerPayments',
    );
    assert.equal(
      doc.paths['/handyman/execution-scopes/{executionScopeId}/customer-payments']?.post
        ?.operationId,
      'recordHandymanCustomerPayment',
    );
    assert.equal(
      doc.paths[
        '/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/confirm'
      ]?.post?.operationId,
      'confirmHandymanCustomerPayment',
    );
    assert.equal(
      doc.paths[
        '/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/reject'
      ]?.post?.operationId,
      'rejectHandymanCustomerPayment',
    );
    assert.ok(doc.components.parameters.CustomerPaymentIdPath);
    for (const schemaName of [
      'HandymanCustomerLedgerTransactionRead',
      'HandymanCustomerLedgerClientBasisRead',
      'HandymanCustomerLedgerChargeLine',
      'HandymanCustomerLedgerPaymentRead',
      'HandymanCustomerLedgerAllocation',
      'HandymanCustomerLedgerCorrection',
      'HandymanCustomerLedgerTotals',
      'HandymanCustomerPaymentRecord',
      'HandymanCustomerPaymentEventRecord',
      'HandymanCustomerPaymentsListView',
      'HandymanCustomerPaymentRecordRequest',
      'HandymanCustomerPaymentConfirmRequest',
      'HandymanCustomerPaymentRejectRequest',
      'HandymanCustomerPaymentCommandResult',
    ]) {
      assert.ok(
        doc.components.schemas[schemaName],
        `missing OpenAPI schema ${schemaName}`,
      );
    }
    const settlementPaths = Object.keys(doc.paths).filter(
      (p) => p.startsWith('/handyman') && /settlement|entitlement/i.test(p),
    );
    assert.deepEqual(settlementPaths, []);
  });
});
