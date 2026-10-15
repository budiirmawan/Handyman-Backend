import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { computeEvidenceSha256 } from '../src/modules/evidence/evidence-integrity';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../src/modules/evidence/storage';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import {
  addTenantInvoiceLine,
  createTenantInvoice,
  finalizeTenantInvoice,
} from '../src/modules/tenant-invoices';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-FIN-DOCUMENTS-01 — focused PostgreSQL verification suite for the
 * Finance payment-proof retrieval contract and the Finance detail-read
 * door (Handyman-Operations Draft PR #15 consumer).
 *
 * Covers, on one disposable embedded PostgreSQL + isolated evidence
 * storage:
 *   1. authorized Finance retrieval of the exact payment-bound proof
 *      (metadata + checksum-verified bytes);
 *   2. wrong/cross payment IDs denied (bounded 404, no cross-proof leak);
 *   3. cross-Client / sibling-Building / unauthenticated / wrong
 *      permission denials (401/403; `tenant_company.read` is NOT a
 *      substitute for `handyman.finance.read`);
 *   4. generic Field Evidence / HANDYMAN_REQUEST attachments and REMOVED
 *      proofs are never served as payment proof;
 *   5. missing and corrupted stored bytes are rejected without
 *      fabrication (explicit unavailable state / bounded 409);
 *   6. Finance-only detailed ledger read (`financial-ledger`) works
 *      WITHOUT `tenant_company.read`, and Finance gets no tenant-wide
 *      read (customer-ledger doors unchanged);
 *   7. GET reads mutate nothing — payment reporting (tenant) and Finance
 *      verification (`handyman.finance.manage`) remain separate.
 */

const PG_DIR = '/tmp/hm-fin-documents-01-pg';
const PG_PORT = 55571;
const STORAGE_DIR = '/tmp/hm-fin-documents-01-evidence';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PG_PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_NAME: 'asentra_test',
  DB_SSL: 'false',
  EVIDENCE_STORAGE_DIR: STORAGE_DIR,
});

const V1 = '/api/v1';
const key = () => `k-${randomUUID()}`;
const PW = 'CorrectHorseBatteryStaple!9';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';

// Actors under test.
let financeReader = { userId: '', token: '' }; // handyman.finance.read @ A1
let financeManager = { userId: '', token: '' }; // handyman.finance.manage @ A1
let tenantReader = { userId: '', token: '' }; // tenant_company.read @ A1
let careReporter = { userId: '', token: '' }; // tenant_company.manage @ A1
let siblingReader = { userId: '', token: '' }; // handyman.finance.read @ A2 only
let foreignReader = { userId: '', token: '' }; // handyman.finance.read @ B1 only
let plainToken = ''; // no permissions

// Fixture identities.
let clientAId = '';
let scope1Id = ''; // scope on building A1 (authorized scope under test)
let scope2Id = ''; // sibling scope on building A2
let foreignScopeId = ''; // scope on foreign client building B1
let requestId1 = '';
let payment1Id = ''; // main payment with genuine proof
let payment2Id = ''; // second payment with its own proof (exact-payment binding)
let payment3Id = ''; // payment whose proof becomes REMOVED
let payment4Id = ''; // payment whose proof bytes are never stored
let payment5Id = ''; // payment with generic attachments only (never a proof)
let foreignPaymentId = '';
let proof1Id = '';
let proof2Id = '';
let proof3Id = '';
let proof4Id = '';
const proof1Bytes = Buffer.from('\x89PNG\r\n\x1a\nfin-documents-01 proof bytes');
let baselineSnapshot: Record<string, unknown> = {};

const q = (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('pool not initialized');
  return pool.query(text, params);
};

const get = (token: string, url: string) =>
  api().get(url).set('Authorization', `Bearer ${token}`);
const post = (token: string, url: string, body: Record<string, unknown> = {}) =>
  api().post(url).set('Authorization', `Bearer ${token}`).send(body);

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
  const user = await userService.createUser({ email, displayName: options.label });
  await credentialService.createInitialCredential({ userId: user.id, password: PW });
  await grantPermissionsToUser(user.id, options.permissions);
  for (const buildingId of options.buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api()
    .post(`${V1}/auth/login`)
    .send({ email, password: PW });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

/** Insert one 0433-compliant bound payment proof row (identity only). */
async function insertBoundProof(input: {
  evidenceId: string;
  clientId: string;
  paymentId: string;
  bytes: Buffer | null;
  mimeType?: string;
  originalName?: string;
}): Promise<void> {
  const size = input.bytes ? input.bytes.byteLength : 32;
  const sha = input.bytes
    ? computeEvidenceSha256(input.bytes)
    : repeatShaPlaceholder();
  await q(
    `INSERT INTO evidence_submissions (
       id, client_id, evidence_requirement_id, execution_type, execution_id,
       evidence_type, file_reference, original_file_name, mime_type, file_size,
       submitted_by_user_id, content_sha256, content_hashed_at, hash_algorithm
     ) VALUES ($1, $2, NULL, 'HANDYMAN_CUSTOMER_PAYMENT', $3,
       'PHOTO', $4, $5, $6, $7, NULL, $8, NOW(), 'SHA-256')`,
    [
      input.evidenceId,
      input.clientId,
      input.paymentId,
      evidenceStorageKey(input.evidenceId),
      input.originalName ?? 'transfer-receipt.png',
      input.mimeType ?? 'image/png',
      size,
      sha,
    ],
  );
  if (input.bytes) {
    await createEvidenceStorage().put(evidenceStorageKey(input.evidenceId), {
      buffer: input.bytes,
      mimeType: input.mimeType ?? 'image/png',
    });
  }
}

function repeatShaPlaceholder(): string {
  return 'a'.repeat(64);
}

async function snapshotState(): Promise<Record<string, unknown>> {
  const result = await q(
    `SELECT
       (SELECT count(*)::int FROM handyman_customer_payment_events) AS payment_events,
       (SELECT count(*)::int FROM handyman_payment_allocations) AS allocations,
       (SELECT count(*)::int FROM handyman_ledger_corrections) AS corrections,
       (SELECT count(*)::int FROM operational_events) AS operational_events,
       (SELECT count(*)::int FROM evidence_submissions) AS evidence_rows,
       (SELECT jsonb_object_agg(id, status) FROM handyman_customer_payments
         WHERE id = ANY($1::uuid[])) AS payment_statuses,
       (SELECT jsonb_object_agg(id, jsonb_build_object(
          'status', status, 'updated_at', updated_at, 'content_sha256', content_sha256,
          'file_size', file_size, 'file_reference', file_reference))
         FROM evidence_submissions WHERE id = ANY($2::uuid[])) AS proof_rows`,
    [[payment1Id, payment2Id, payment3Id, payment4Id, payment5Id], [proof1Id, proof2Id, proof3Id, proof4Id]],
  );
  return result.rows[0] as Record<string, unknown>;
}

before(async () => {
  resetAppConfigCache();
  await rm(PG_DIR, { recursive: true, force: true });
  await rm(STORAGE_DIR, { recursive: true, force: true });
  await mkdir(PG_DIR, { recursive: true });
  await mkdir(STORAGE_DIR, { recursive: true });
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

  const db = await ensureTestDatabase();
  assert.ok(db, 'EmbeddedPostgres test database must be reachable');
  pool = await initDatabase(db);
  await migrateUp(pool);
  resetAppConfigCache();

  const adminActor = await createAdminUser();
  adminUserId = adminActor.userId;
  adminToken = adminActor.token;
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

  // Realm A: one client with buildings A1 (under test) + A2 (sibling).
  const realmA = await realmFixture('FinDocsA');
  clientAId = realmA.client.id;
  const buildingA1 = realmA.building;
  const buildingA2 = await buildingService.createBuilding({
    propertyId: realmA.property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA2.id,
  });

  // Realm B: foreign client + building B1.
  const realmB = await realmFixture('FinDocsB');
  const buildingB1 = realmB.building;

  await clientMonetaryContextService.setClientMonetaryContext(
    {
      clientId: realmA.client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes: ['IDR', 'USD'],
    },
    adminUserId,
  );
  await clientMonetaryContextService.setClientMonetaryContext(
    {
      clientId: realmB.client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes: ['IDR', 'USD'],
    },
    adminUserId,
  );

  // Authorized scope (A1) with an opened ledger transaction + charge line.
  const chainA1 = await locationChain(realmA);
  const { scope: scope1 } = await scopeFixture(realmA, chainA1);
  assert.ok(scope1);
  scope1Id = scope1.id;
  requestId1 = (await q(
    'SELECT handyman_request_id FROM handyman_execution_scopes WHERE id = $1',
    [scope1Id],
  )).rows[0].handyman_request_id as string;
  await openHandymanCustomerTransaction(
    { executionScopeId: scope1Id, idempotencyKey: key() },
    adminUserId,
  );
  const quoteLine1 = (await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 ORDER BY created_at, id LIMIT 1`,
    [scope1.approvedQuotationVersionId],
  )).rows[0] as { id: string };
  const charge1 = await composeHandymanChargeLine(
    {
      executionScopeId: scope1Id,
      quotationLineId: quoteLine1.id,
      idempotencyKey: key(),
    },
    adminUserId,
  );
  const chargeAmount = String(charge1.chargeLine.amount);

  // Sibling scope (A2) and foreign scope (B1) for denial cases.
  const targetA2 = { ...realmA, building: { id: buildingA2.id } };
  const chainA2 = await locationChain(targetA2);
  const { scope: scope2 } = await scopeFixture(targetA2, chainA2);
  assert.ok(scope2);
  scope2Id = scope2.id;

  const chainB1 = await locationChain(realmB);
  const { scope: foreignScope } = await scopeFixture(realmB, chainB1);
  assert.ok(foreignScope);
  foreignScopeId = foreignScope.id;
  await openHandymanCustomerTransaction(
    { executionScopeId: foreignScopeId, idempotencyKey: key() },
    adminUserId,
  );
  const foreignPayment = await recordHandymanCustomerPayment(
    {
      executionScopeId: foreignScopeId,
      amount: '10.00',
      channel: 'CASH',
      idempotencyKey: key(),
    },
    adminUserId,
  );
  foreignPaymentId = foreignPayment.payment.id;

  // Finalized single-scope Handyman invoice for scope1 (0433 precondition).
  const invoice = await createTenantInvoice(
    {
      tenantCompanyId: scope1.tenantCompanyId,
      buildingId: scope1.buildingId,
      spaceId: scope1.spaceId!,
      invoiceNumber: `HM-PRF-${suffix()}`,
      invoiceDate: '2026-10-01',
      dueDate: '2026-11-01',
      currencyCode: 'IDR',
    },
    adminUserId,
  );
  await addTenantInvoiceLine(
    invoice.id,
    { sourceType: 'HANDYMAN_CHARGE', sourceId: charge1.chargeLine.id },
    adminUserId,
  );
  await finalizeTenantInvoice(invoice.id, adminUserId);

  // Five PENDING payment claims on the scope1 transaction.
  const recordOnScope1 = async (label: string) =>
    (
      await recordHandymanCustomerPayment(
        {
          executionScopeId: scope1Id,
          amount: chargeAmount,
          channel: 'BANK_TRANSFER',
          externalReference: `EXT-${label}-${suffix()}`,
          idempotencyKey: key(),
        },
        adminUserId,
      )
    ).payment.id;
  payment1Id = await recordOnScope1('P1');
  payment2Id = await recordOnScope1('P2');
  payment3Id = await recordOnScope1('P3');
  payment4Id = await recordOnScope1('P4');
  payment5Id = await recordOnScope1('P5');

  // Genuine proofs for P1/P2/P3; P4's proof row has NO stored bytes.
  proof1Id = randomUUID();
  proof2Id = randomUUID();
  proof3Id = randomUUID();
  proof4Id = randomUUID();
  await insertBoundProof({
    evidenceId: proof1Id,
    clientId: clientAId,
    paymentId: payment1Id,
    bytes: proof1Bytes,
    originalName: 'transfer-receipt.png',
  });
  await insertBoundProof({
    evidenceId: proof2Id,
    clientId: clientAId,
    paymentId: payment2Id,
    bytes: Buffer.from('second payment proof bytes'),
    originalName: 'second-receipt.png',
  });
  await insertBoundProof({
    evidenceId: proof3Id,
    clientId: clientAId,
    paymentId: payment3Id,
    bytes: Buffer.from('removed proof bytes'),
    originalName: 'removed-receipt.png',
  });
  await insertBoundProof({
    evidenceId: proof4Id,
    clientId: clientAId,
    paymentId: payment4Id,
    bytes: null, // deliberate: identity row only, stored bytes unavailable
    originalName: 'ghost-receipt.png',
  });
  // P3's proof becomes REMOVED (0433 allows terminal removal, never reactivation).
  await q(
    `UPDATE evidence_submissions SET status = 'REMOVED', updated_at = NOW() WHERE id = $1`,
    [proof3Id],
  );

  // P5 has only generic attachments: a HANDYMAN_REQUEST evidence row and a
  // Field Evidence upload row — neither may ever resolve as payment proof.
  const genericEvidenceId = randomUUID();
  await q(
    `INSERT INTO evidence_submissions (
       id, client_id, evidence_requirement_id, execution_type, execution_id,
       evidence_type, file_reference, original_file_name, mime_type, file_size,
       submitted_by_user_id, content_sha256, content_hashed_at, hash_algorithm
     ) VALUES ($1, $2, NULL, 'HANDYMAN_REQUEST', $3,
       'PHOTO', $4, 'site-photo.png', 'image/png', 16, $5, repeat('b', 64), NOW(), 'SHA-256')`,
    [genericEvidenceId, clientAId, requestId1, `evidence/${genericEvidenceId}`, adminUserId],
  );
  await q(
    `INSERT INTO handyman_field_evidence_uploads (
       id, client_id, tenant_company_id, building_id, handyman_request_id,
       execution_scope_id, purpose, upload_status, original_file_name, mime_type,
       storage_key, declared_byte_size, verified_byte_size, sha256_checksum,
       uploaded_by_user_id, uploaded_by_role, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6,
       'QC_EVIDENCE', 'STAGED_BYTES', 'field-photo.png', 'image/png',
       $7, 16, 0, NULL, $8, 'OPERATIONS_MANAGER', $9)`,
    [
      randomUUID(),
      clientAId,
      scope1.tenantCompanyId,
      scope1.buildingId,
      requestId1,
      scope1Id,
      `field/${randomUUID()}`,
      adminUserId,
      key(),
    ],
  );

  // Personas.
  financeReader = await createPersonaActor({
    label: 'finance-reader',
    buildingIds: [buildingA1.id],
    permissions: ['handyman.finance.read'],
  });
  financeManager = await createPersonaActor({
    label: 'finance-manager',
    buildingIds: [buildingA1.id],
    permissions: ['handyman.finance.read', 'handyman.finance.manage'],
  });
  tenantReader = await createPersonaActor({
    label: 'tenant-reader',
    buildingIds: [buildingA1.id],
    permissions: ['tenant_company.read'],
  });
  careReporter = await createPersonaActor({
    label: 'care-reporter',
    buildingIds: [buildingA1.id],
    permissions: ['tenant_company.manage'],
  });
  siblingReader = await createPersonaActor({
    label: 'sibling-reader',
    buildingIds: [buildingA2.id],
    permissions: ['handyman.finance.read'],
  });
  foreignReader = await createPersonaActor({
    label: 'foreign-reader',
    buildingIds: [buildingB1.id],
    permissions: ['handyman.finance.read'],
  });
  const plain = await userService.createUser({
    email: `plain-${suffix().toLowerCase()}@example.com`,
    displayName: 'No Permission',
  });
  await credentialService.createInitialCredential({ userId: plain.id, password: PW });
  const plainLogin = await api()
    .post(`${V1}/auth/login`)
    .send({ email: plain.email, password: PW });
  assert.equal(plainLogin.status, 200);
  plainToken = plainLogin.body.data.sessionToken as string;

  baselineSnapshot = await snapshotState();
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(PG_DIR, { recursive: true, force: true });
    await rm(STORAGE_DIR, { recursive: true, force: true });
    resetAppConfigCache();
  }
});

const proofUrl = (scopeId: string, paymentId: string) =>
  `${V1}/handyman/execution-scopes/${scopeId}/customer-payments/${paymentId}/payment-proof`;
const proofContentUrl = (scopeId: string, paymentId: string) =>
  `${proofUrl(scopeId, paymentId)}/content`;

describe('CR-HM-FIN-DOCUMENTS-01 — payment-proof retrieval & Finance detail read', () => {
  it('1: authorized Finance reads the exact payment-bound proof metadata and authentic verified bytes', async () => {
    // Metadata.
    const meta = await get(financeReader.token, proofUrl(scope1Id, payment1Id));
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    assert.equal(meta.body.success, true);
    const proof = meta.body.data.paymentProof;
    assert.equal(proof.paymentId, payment1Id);
    assert.equal(proof.evidenceId, proof1Id);
    assert.equal(proof.executionType, 'HANDYMAN_CUSTOMER_PAYMENT');
    assert.equal(proof.executionId, payment1Id);
    assert.equal(proof.clientId, clientAId);
    assert.equal(proof.evidenceType, 'PHOTO');
    assert.equal(proof.originalFileName, 'transfer-receipt.png');
    assert.equal(proof.mimeType, 'image/png');
    assert.equal(proof.fileSize, proof1Bytes.byteLength);
    assert.equal(proof.contentSha256, computeEvidenceSha256(proof1Bytes));
    assert.equal(proof.hashAlgorithm, 'SHA-256');
    assert.equal(proof.status, 'ACTIVE');
    assert.equal(proof.retentionState, 'ACTIVE');

    // No storage key, storage URL or token is ever disclosed.
    const raw = JSON.stringify(meta.body);
    assert.ok(!raw.includes('file_reference'), 'storage key field must not leak');
    assert.ok(!raw.includes(evidenceStorageKey(proof1Id)), 'storage key must not leak');
    assert.ok(!raw.includes(STORAGE_DIR), 'storage path must not leak');
    assert.ok(!raw.includes('http'), 'no URL must leak');
    assert.ok(!raw.includes('Bearer'), 'no token must leak');
    assert.equal(proof.fileReference, undefined);

    // Content: authentic bytes, correct MIME delivery, no-store.
    const content = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment1Id),
    );
    assert.equal(content.status, 200, JSON.stringify(content.body));
    assert.equal(content.headers['content-type'], 'image/png');
    assert.equal(content.headers['content-length'], String(proof1Bytes.byteLength));
    assert.equal(content.headers['cache-control'], 'no-store');
    assert.match(String(content.headers['content-disposition']), /transfer-receipt\.png/);
    assert.equal(content.headers.location, undefined);
    assert.ok(Buffer.from(content.body).equals(proof1Bytes), 'bytes must match upload exactly');
  });

  it('2: wrong payment IDs are denied and proof is bound to the exact payment only', async () => {
    // Unknown payment id: bounded 404 (payment vocabulary).
    const unknown = await get(financeReader.token, proofUrl(scope1Id, randomUUID()));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'HANDYMAN_CUSTOMER_PAYMENT_NOT_FOUND');

    // A foreign-tenant payment id under the authorized scope: never resolved.
    const crossTenant = await get(
      financeReader.token,
      proofUrl(scope1Id, foreignPaymentId),
    );
    assert.equal(crossTenant.status, 404);
    assert.equal(crossTenant.body.error.code, 'HANDYMAN_CUSTOMER_PAYMENT_NOT_FOUND');

    // Payment 2 resolves ITS OWN proof — no cross-proof substitution.
    const second = await get(financeReader.token, proofUrl(scope1Id, payment2Id));
    assert.equal(second.status, 200);
    assert.equal(second.body.data.paymentProof.evidenceId, proof2Id);
    assert.notEqual(second.body.data.paymentProof.evidenceId, proof1Id);
    const secondContent = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment2Id),
    );
    assert.equal(secondContent.status, 200);
    assert.ok(
      Buffer.from(secondContent.body).equals(Buffer.from('second payment proof bytes')),
    );
  });

  it('3: enforces authentication, Finance read permission and Client/Building scope', async () => {
    const url = proofUrl(scope1Id, payment1Id);

    // 401 unauthenticated.
    const unauth = await api().get(url);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    // 403 authenticated but no permission.
    const noPerm = await get(plainToken, url);
    assert.equal(noPerm.status, 403);
    assert.equal(noPerm.body.error.code, 'PERMISSION_DENIED');

    // `tenant_company.read` is NOT a substitute for `handyman.finance.read`.
    const tenantOnly = await get(tenantReader.token, url);
    assert.equal(tenantOnly.status, 403);
    assert.equal(tenantOnly.body.error.code, 'PERMISSION_DENIED');

    // Sibling-Building (same Client) actor: exact-Building wall, bounded 403.
    const sibling = await get(siblingReader.token, url);
    assert.equal(sibling.status, 403);
    assert.equal(sibling.body.error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');

    // Foreign-Client actor: bounded 403, same vocabulary, no data leak.
    const foreign = await get(foreignReader.token, url);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');

    // Unknown scope: bounded 404 (scope 404 precedes the access wall).
    const unknownScope = await get(
      financeReader.token,
      proofUrl(randomUUID(), payment1Id),
    );
    assert.equal(unknownScope.status, 404);
    assert.equal(
      unknownScope.body.error.code,
      'HANDYMAN_CUSTOMER_TRANSACTION_SCOPE_NOT_FOUND',
    );

    // Content door enforces the exact same wall.
    const contentDenied = await get(
      siblingReader.token,
      proofContentUrl(scope1Id, payment1Id),
    );
    assert.equal(contentDenied.status, 403);
  });

  it('4: generic Field Evidence, HANDYMAN_REQUEST attachments and REMOVED proofs are never served as payment proof', async () => {
    // P5 has only generic attachments: uniformly 404, nothing fabricated.
    const genericOnly = await get(financeReader.token, proofUrl(scope1Id, payment5Id));
    assert.equal(genericOnly.status, 404);
    assert.equal(genericOnly.body.error.code, 'HANDYMAN_PAYMENT_PROOF_NOT_FOUND');
    const genericContent = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment5Id),
    );
    assert.equal(genericContent.status, 404);
    assert.equal(genericContent.body.error.code, 'HANDYMAN_PAYMENT_PROOF_NOT_FOUND');

    // REMOVED proof is terminal: never retrievable, never reactivated.
    const removed = await get(financeReader.token, proofUrl(scope1Id, payment3Id));
    assert.equal(removed.status, 404);
    assert.equal(removed.body.error.code, 'HANDYMAN_PAYMENT_PROOF_NOT_FOUND');
    const removedContent = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment3Id),
    );
    assert.equal(removedContent.status, 404);

    // The generic User evidence surface has no payment-proof authority either:
    // no Field-Evidence-style door leaks the bound proof.
    const genericDoor = await api()
      .get(`${V1}/evidence/${proof1Id}/file/content`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(genericDoor.status, 404);
  });

  it('5: missing stored bytes are an explicit unavailable state and corrupt bytes are rejected (never fabricated)', async () => {
    // P4's proof row is authoritative but its bytes were never stored:
    // metadata truthfully resolves; content is an explicit 404 — no
    // placeholder download is ever manufactured.
    const ghostMeta = await get(financeReader.token, proofUrl(scope1Id, payment4Id));
    assert.equal(ghostMeta.status, 200);
    assert.equal(ghostMeta.body.data.paymentProof.evidenceId, proof4Id);
    const ghostContent = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment4Id),
    );
    assert.equal(ghostContent.status, 404);
    assert.equal(ghostContent.body.error.code, 'EVIDENCE_FILE_NOT_FOUND');

    // Corrupt the stored bytes of the main proof (same length, different
    // content): checksum validation rejects delivery with a bounded 409.
    const storage = createEvidenceStorage();
    const corrupt = Buffer.from(proof1Bytes.map((b, i) => (i === 0 ? b ^ 0xff : b)));
    await storage.put(evidenceStorageKey(proof1Id), {
      buffer: corrupt,
      mimeType: 'image/png',
    });
    const corruptRes = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment1Id),
    );
    assert.equal(corruptRes.status, 409, JSON.stringify(corruptRes.body));
    assert.equal(corruptRes.body.error.code, 'HANDYMAN_PAYMENT_PROOF_INTEGRITY_CONFLICT');

    // Truncated bytes: size validation rejects delivery too.
    await storage.put(evidenceStorageKey(proof1Id), {
      buffer: proof1Bytes.subarray(0, 4),
      mimeType: 'image/png',
    });
    const truncated = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment1Id),
    );
    assert.equal(truncated.status, 409);
    assert.equal(truncated.body.error.code, 'HANDYMAN_PAYMENT_PROOF_INTEGRITY_CONFLICT');

    // Restore authentic bytes: delivery resumes, nothing was mutated.
    await storage.put(evidenceStorageKey(proof1Id), {
      buffer: proof1Bytes,
      mimeType: 'image/png',
    });
    const restored = await get(
      financeReader.token,
      proofContentUrl(scope1Id, payment1Id),
    );
    assert.equal(restored.status, 200);
    assert.ok(Buffer.from(restored.body).equals(proof1Bytes));
  });

  it('6: Finance-only detail read works without tenant_company.read; Finance receives no tenant-wide read', async () => {
    const detailUrl = `${V1}/handyman/execution-scopes/${scope1Id}/financial-ledger`;

    // The missing dedicated Finance detail-read door: handyman.finance.read
    // alone (NO tenant_company.read) reads the exact-scope ledger detail.
    const detail = await get(financeReader.token, detailUrl);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.readOnly, true);
    assert.ok(Array.isArray(detail.body.data.chargeLines));
    assert.ok(detail.body.data.chargeLines.length >= 1);
    assert.ok(detail.body.data.payments.length >= 1);
    assert.equal(detail.body.data.transaction.executionScopeId, scope1Id);

    // Finance-only actor gets NO tenant-wide reads: both customer-ledger
    // doors remain `tenant_company.read`-gated (existing contract unchanged).
    for (const url of [
      `${V1}/handyman/customer-ledger?clientId=${clientAId}`,
      `${V1}/handyman/execution-scopes/${scope1Id}/customer-ledger`,
      `${V1}/handyman/execution-scopes/${scope1Id}/customer-payments`,
    ]) {
      const denied = await get(financeReader.token, url);
      assert.equal(denied.status, 403, `expected 403 for ${url}`);
      assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    }

    // The existing tenant door is unchanged and still works for tenants.
    const tenantDoor = await get(
      tenantReader.token,
      `${V1}/handyman/execution-scopes/${scope1Id}/customer-ledger`,
    );
    assert.equal(tenantDoor.status, 200, JSON.stringify(tenantDoor.body));

    // And the Finance door is NOT opened by tenant_company.read.
    const tenantOnFinanceDoor = await get(tenantReader.token, detailUrl);
    assert.equal(tenantOnFinanceDoor.status, 403);
    assert.equal(tenantOnFinanceDoor.body.error.code, 'PERMISSION_DENIED');
  });

  it('7: GET reads mutate nothing; customer reporting and Finance verification remain separate', async () => {
    // Re-read everything once more, then compare the full snapshot.
    for (const url of [
      proofUrl(scope1Id, payment1Id),
      proofContentUrl(scope1Id, payment1Id),
      proofUrl(scope1Id, payment2Id),
      `${V1}/handyman/execution-scopes/${scope1Id}/financial-ledger`,
    ]) {
      const res = await get(financeReader.token, url);
      assert.ok([200].includes(res.status), `expected 200 for ${url}`);
    }

    // Payment discovery regression: the action-inbox still resolves the
    // authoritative proof id for the PENDING payment.
    const inbox = await get(
      financeReader.token,
      `${V1}/handyman/finance/action-inbox?clientId=${clientAId}`,
    );
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    const pendingItem = (inbox.body.data.items as Array<Record<string, unknown>>).find(
      (item) => item.recordId === payment1Id,
    );
    assert.ok(pendingItem, 'PENDING payment must be discoverable');
    assert.equal(
      (pendingItem!.provenance as Record<string, unknown>).paymentProofEvidenceId,
      proof1Id,
    );

    // Zero mutations from every GET above.
    assert.deepEqual(await snapshotState(), baselineSnapshot);

    // Reporting (tenant) and verification (Finance) stay separate authorities:
    // Finance read cannot record (report) a payment...
    const recordDenied = await post(financeReader.token, `${V1}/handyman/execution-scopes/${scope1Id}/customer-payments`, {
      amount: '1.00',
      channel: 'CASH',
      idempotencyKey: key(),
    });
    assert.equal(recordDenied.status, 403);
    assert.equal(recordDenied.body.error.code, 'PERMISSION_DENIED');

    // ...and Finance READ cannot verify (confirm) a payment.
    const confirmDenied = await post(
      financeReader.token,
      `${V1}/handyman/execution-scopes/${scope1Id}/customer-payments/${payment2Id}/confirm`,
      { idempotencyKey: key() },
    );
    assert.equal(confirmDenied.status, 403);
    assert.equal(confirmDenied.body.error.code, 'PERMISSION_DENIED');

    // Customer reporting still works for its own authority (PENDING claim).
    const reported = await post(
      careReporter.token,
      `${V1}/handyman/execution-scopes/${scope1Id}/customer-payments`,
      {
        amount: '1.00',
        channel: 'CASH',
        idempotencyKey: key(),
      },
    );
    assert.equal(reported.status, 200, JSON.stringify(reported.body));
    assert.equal(reported.body.data.payment.status, 'PENDING');

    // Finance verification still works for its own authority.
    const confirmed = await post(
      financeManager.token,
      `${V1}/handyman/execution-scopes/${scope1Id}/customer-payments/${payment2Id}/confirm`,
      { idempotencyKey: key() },
    );
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.payment.status, 'CONFIRMED');

    // The main payment under review remains PENDING — reading a proof never
    // marks anything PAID, CONFIRMED, or otherwise.
    const paymentState = await q(
      `SELECT status FROM handyman_customer_payments WHERE id = $1`,
      [payment1Id],
    );
    assert.equal(paymentState.rows[0].status, 'PENDING');
  });
});
