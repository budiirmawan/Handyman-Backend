import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import { createSessionWithPermissions, createAdminUser } from './helpers/access';
import {
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-13 PART 04 (W01) — payment reporting vs verification authority.
 *
 * Verifies, over HTTP and against the real ledger:
 *  1. REPORT  — `handyman.payment.report` records a PENDING claim; the
 *               reporter is offered NO verification action.
 *  2. VERIFY  — `handyman.payment.verify` confirms a PENDING claim; only
 *               then does the fact count as received funds (no PAID before
 *               verification).
 *  3. REJECT  — the same explicit verifier rejects with a bounded reason;
 *               a rejected claim never becomes received funds.
 *  4. DENY    — `tenant_company.manage` alone (the pre-PART-04 authority)
 *               neither reports nor verifies; report-only cannot verify;
 *               verify-only cannot report.
 *  5. CROSS-BUILDING — a verifier of a same-client sibling Building is
 *               denied (exact-Building wall, CR-HM-SEC-01 PART 06E-2).
 *  6. MAKER-CHECKER — the identity that recorded a claim cannot confirm or
 *               reject it, even when it holds the verify permission; a
 *               different verifier still can (the block is identity-based).
 */

const V1 = '/api/v1';
const key = () => `k-${randomUUID()}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let pool: Pool | null = null;
let adminUserId = '';

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

before(async () => {
  const config = await ensureTestDatabase();
  assert.ok(config, 'test database must be available');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
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
  if (pool) await closePool(pool);
  pool = null;
});

/** Authenticated HTTP actor with explicit permissions and one Building. */
async function actor(buildingId: string, codes: string[]) {
  const token = await createSessionWithPermissions(
    codes.map((code) => ({ code, name: code })),
  );
  const row = await q(
    `SELECT user_id AS "userId" FROM user_sessions WHERE token_hash = $1`,
    [sha256(token)],
  );
  const userId = row.rows[0]?.userId as string | undefined;
  assert.ok(userId, 'session must resolve to its own authenticated user');
  await buildingAssignmentService.createAssignment(userId, { buildingId });
  return { token, userId };
}

/** Approved scope with an OPEN ledger transaction and one LABOR charge line. */
async function scenario() {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  assert.ok(f.scope, 'approved scope required');
  const scope = f.scope!;
  const labor = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
    [scope.approvedQuotationVersionId],
  );
  await openHandymanCustomerTransaction(
    { executionScopeId: scope.id, idempotencyKey: key() },
    adminUserId,
  );
  await composeHandymanChargeLine(
    {
      executionScopeId: scope.id,
      quotationLineId: labor.rows[0].id as string,
      idempotencyKey: key(),
    },
    adminUserId,
  );
  // A same-client sibling Building (exact-Building wall must deny it).
  const sibling = await buildingService.createBuilding({
    propertyId: realm.property.id,
    code: `B_${randomUUID().slice(0, 8)}`,
    name: 'Sibling Building',
  });
  return { realm, scope, sibling };
}

const paymentsUrl = (scopeId: string) =>
  `${V1}/handyman/execution-scopes/${scopeId}/customer-payments`;

async function report(
  scopeId: string,
  token: string,
  amount = '50.00',
) {
  return api()
    .post(paymentsUrl(scopeId))
    .set('Authorization', `Bearer ${token}`)
    .send({ amount, channel: 'CASH', idempotencyKey: key() });
}

async function decide(
  scopeId: string,
  paymentId: string,
  action: 'confirm' | 'reject',
  token: string,
) {
  const body: Record<string, string> = { idempotencyKey: key() };
  if (action === 'reject') body.reason = 'Bank statement mismatch';
  return api()
    .post(`${paymentsUrl(scopeId)}/${paymentId}/${action}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function listPayments(scopeId: string, token: string) {
  const res = await api()
    .get(paymentsUrl(scopeId))
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.payments as Array<{
    id: string;
    status: string;
    availableActions: string[];
    recordedByUserId: string;
    decidedByUserId: string | null;
    rejectionReason: string | null;
  }>;
}

async function receivedGross(scopeId: string, token: string): Promise<string> {
  const res = await api()
    .get(`${V1}/handyman/execution-scopes/${scopeId}/customer-ledger`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.totals.receivedGross as string;
}

async function paymentRowCount(scopeId: string): Promise<number> {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM handyman_customer_payments p
       JOIN handyman_customer_transactions t ON t.id = p.transaction_id
      WHERE t.execution_scope_id = $1`,
    [scopeId],
  );
  return r.rows[0].n as number;
}

describe('CR-HM-13 PART 04 (W01) — payment report vs verify authority', () => {
  it('REPORT: reporter records a PENDING claim and is offered no verification action', async () => {
    const s = await scenario();
    const reporter = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.report',
    ]);
    const res = await report(s.scope.id, reporter.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const payment = res.body.data.payment;
    assert.equal(payment.status, 'PENDING');
    assert.equal(payment.recordedByUserId, reporter.userId);
    assert.equal(payment.decidedByUserId, null);
    assert.deepEqual(payment.availableActions, [], 'reporter must not get CONFIRM/REJECT');
    // Reporting alone never makes money authoritative.
    assert.equal(await receivedGross(s.scope.id, reporter.token), '0.00');
  });

  it('DENY-REPORT: manage-only (pre-PART-04 authority) and verify-only cannot report', async () => {
    const s = await scenario();
    const managerOnly = await actor(s.realm.building.id, [
      'tenant_company.read', 'tenant_company.manage',
    ]);
    const verifyOnly = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.verify',
    ]);
    const before = await paymentRowCount(s.scope.id);
    const a = await report(s.scope.id, managerOnly.token);
    assert.equal(a.status, 403);
    assert.equal(a.body.error.code, 'PERMISSION_DENIED');
    const b = await report(s.scope.id, verifyOnly.token);
    assert.equal(b.status, 403);
    assert.equal(b.body.error.code, 'PERMISSION_DENIED');
    assert.equal(await paymentRowCount(s.scope.id), before, 'denied report writes nothing');
  });

  it('VERIFY: a different explicit verifier confirms; only then is the fact received', async () => {
    const s = await scenario();
    const reporter = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.report',
    ]);
    const verifier = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.verify',
    ]);
    const recorded = await report(s.scope.id, reporter.token, '75.00');
    assert.equal(recorded.status, 200);
    const paymentId = recorded.body.data.payment.id as string;

    // The verifier sees the decision actions for the reporter's PENDING claim.
    const pendingForVerifier = (await listPayments(s.scope.id, verifier.token))
      .find((p) => p.id === paymentId);
    assert.deepEqual(pendingForVerifier?.availableActions, ['CONFIRM', 'REJECT']);
    // ...and the reporter, who cannot verify, sees none.
    const pendingForReporter = (await listPayments(s.scope.id, reporter.token))
      .find((p) => p.id === paymentId);
    assert.deepEqual(pendingForReporter?.availableActions, []);
    assert.equal(await receivedGross(s.scope.id, verifier.token), '0.00');

    const confirmed = await decide(s.scope.id, paymentId, 'confirm', verifier.token);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.payment.status, 'CONFIRMED');
    assert.equal(confirmed.body.data.payment.decidedByUserId, verifier.userId);
    assert.equal(confirmed.body.data.payment.recordedByUserId, reporter.userId);
    assert.equal(confirmed.body.data.event.eventType, 'CONFIRM_PAYMENT');
    assert.equal(await receivedGross(s.scope.id, verifier.token), '75.00');
  });

  it('REJECT: the explicit verifier rejects with a reason; a rejected claim is never received', async () => {
    const s = await scenario();
    const reporter = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.report',
    ]);
    const verifier = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.verify',
    ]);
    const recorded = await report(s.scope.id, reporter.token, '40.00');
    const paymentId = recorded.body.data.payment.id as string;
    const rejected = await decide(s.scope.id, paymentId, 'reject', verifier.token);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.payment.status, 'REJECTED');
    assert.equal(rejected.body.data.payment.decidedByUserId, verifier.userId);
    assert.equal(rejected.body.data.payment.rejectionReason, 'Bank statement mismatch');
    assert.equal(rejected.body.data.event.eventType, 'REJECT_PAYMENT');
    assert.equal(await receivedGross(s.scope.id, verifier.token), '0.00');
    // Terminal: a second decision is a bounded conflict, never a re-decision.
    const again = await decide(s.scope.id, paymentId, 'confirm', verifier.token);
    assert.equal(again.status, 409);
  });

  it('DENY-VERIFY: report-only and manage-only cannot confirm or reject; claim stays PENDING', async () => {
    const s = await scenario();
    const reporter = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.report',
    ]);
    const managerOnly = await actor(s.realm.building.id, [
      'tenant_company.read', 'tenant_company.manage',
    ]);
    const recorded = await report(s.scope.id, reporter.token);
    const paymentId = recorded.body.data.payment.id as string;
    for (const token of [reporter.token, managerOnly.token]) {
      for (const action of ['confirm', 'reject'] as const) {
        const res = await decide(s.scope.id, paymentId, action, token);
        assert.equal(res.status, 403, `${action}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error.code, 'PERMISSION_DENIED');
      }
    }
    const [row] = (await listPayments(s.scope.id, reporter.token))
      .filter((p) => p.id === paymentId);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.decidedByUserId, null);
  });

  it('CROSS-BUILDING: a verifier of a same-client sibling Building is denied; claim stays PENDING', async () => {
    const s = await scenario();
    const reporter = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.report',
    ]);
    const siblingVerifier = await actor(s.sibling.id, [
      'tenant_company.read', 'handyman.payment.verify',
    ]);
    const siblingReporter = await actor(s.sibling.id, [
      'tenant_company.read', 'handyman.payment.report',
    ]);
    const recorded = await report(s.scope.id, reporter.token);
    const paymentId = recorded.body.data.payment.id as string;

    const deniedReport = await report(s.scope.id, siblingReporter.token);
    assert.equal(deniedReport.status, 403);
    assert.equal(deniedReport.body.error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');

    for (const action of ['confirm', 'reject'] as const) {
      const res = await decide(s.scope.id, paymentId, action, siblingVerifier.token);
      assert.equal(res.status, 403, `${action}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');
    }
    const [row] = (await listPayments(s.scope.id, reporter.token))
      .filter((p) => p.id === paymentId);
    assert.equal(row.status, 'PENDING');
    assert.equal(await receivedGross(s.scope.id, reporter.token), '0.00');
  });

  it('MAKER-CHECKER: the recorder cannot verify its own claim, even holding the verify permission', async () => {
    const s = await scenario();
    const both = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.report', 'handyman.payment.verify',
    ]);
    const other = await actor(s.realm.building.id, [
      'tenant_company.read', 'handyman.payment.verify',
    ]);
    const recorded = await report(s.scope.id, both.token, '60.00');
    assert.equal(recorded.status, 200);
    const paymentId = recorded.body.data.payment.id as string;

    // The recorder is offered no decision action for its own claim.
    const [mine] = (await listPayments(s.scope.id, both.token))
      .filter((p) => p.id === paymentId);
    assert.deepEqual(mine.availableActions, []);

    for (const action of ['confirm', 'reject'] as const) {
      const res = await decide(s.scope.id, paymentId, action, both.token);
      assert.equal(res.status, 403, `${action}: ${JSON.stringify(res.body)}`);
      assert.equal(
        res.body.error.code,
        'HANDYMAN_CUSTOMER_PAYMENT_SELF_VERIFICATION_DENIED',
      );
    }
    const [still] = (await listPayments(s.scope.id, other.token))
      .filter((p) => p.id === paymentId);
    assert.equal(still.status, 'PENDING', 'a self-verification attempt changes nothing');
    assert.equal(still.decidedByUserId, null);

    // Identity-based, not payment-blocking: a different verifier still decides.
    const confirmed = await decide(s.scope.id, paymentId, 'confirm', other.token);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.payment.decidedByUserId, other.userId);
    assert.equal(await receivedGross(s.scope.id, other.token), '60.00');
  });
});
