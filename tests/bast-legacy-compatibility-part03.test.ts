import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55472;
const DIR = '/tmp/asentra-bast-part03-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const auth = () => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles CASCADE');
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function structure(assign: boolean) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Legacy compatibility client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Legacy compatibility property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Legacy compatibility building',
  });
  if (assign) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

async function completedWorkOrder(clientId: string, buildingId: string) {
  const workOrder = await workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Completed BAST compatibility work',
    workType: 'REPAIR',
    createdByUserId: userId,
  });
  await pool!.query(
    `UPDATE work_orders
     SET status = 'COMPLETED', completed_at = NOW(), completed_by_user_id = $2
     WHERE id = $1`,
    [workOrder.id, userId],
  );
  return workOrder;
}

async function completedVendorWork(input: {
  clientId: string;
  buildingId: string;
  workOrderId: string;
}) {
  const vendor = await vendorService.createVendor({
    clientId: input.clientId,
    vendorCode: `V_${suffix()}`,
    vendorName: 'BAST compatibility vendor',
  });
  const assignmentId = randomUUID();
  const vendorWorkId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_assignments
       (id, vendor_id, work_order_id, building_id, assigned_by_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [assignmentId, vendor.id, input.workOrderId, input.buildingId, userId],
  );
  await pool!.query(
    `INSERT INTO vendor_works
       (id, vendor_assignment_id, vendor_id, work_order_id, building_id,
        status, started_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,'COMPLETED',NOW() - INTERVAL '1 day',NOW())`,
    [vendorWorkId, assignmentId, vendor.id, input.workOrderId, input.buildingId],
  );
  await pool!.query(
    `INSERT INTO vendor_completion_reports
       (id, client_id, vendor_work_id, work_order_id, building_id,
        completion_status, evidence_ready, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'SUBMITTED',TRUE,$6)`,
    [
      randomUUID(),
      input.clientId,
      vendorWorkId,
      input.workOrderId,
      input.buildingId,
      userId,
    ],
  );
  await pool!.query(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id,
        decision, status, reviewed_at)
     VALUES
       ($1,$3,'WORK_ORDER',$4,$5,'APPROVED','COMPLETED',NOW()),
       ($2,$3,'VENDOR_WORK',$6,$5,'APPROVED','COMPLETED',NOW())`,
    [
      randomUUID(),
      randomUUID(),
      input.clientId,
      input.workOrderId,
      userId,
      vendorWorkId,
    ],
  );
  return { vendor, vendorWorkId };
}

async function createCanonicalVendorBast(input: {
  clientId: string;
  buildingId: string;
  workOrderId: string;
  vendorId: string;
  vendorWorkId: string;
}) {
  const response = await api()
    .post('/api/v1/bast-documents')
    .set(auth())
    .send({
      clientId: input.clientId,
      buildingId: input.buildingId,
      contextType: 'VENDOR',
      sourceType: 'VENDOR',
      sourceId: input.vendorId,
      documentNumber: `DOC_${suffix()}`,
      documentType: 'BAST',
      title: 'Canonical vendor BAST',
      workOrderId: input.workOrderId,
      vendorWorkId: input.vendorWorkId,
      bastNumber: `BAST_${suffix()}`,
      bastDate: '2026-08-18',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const bast = response.body.data as {
    id: string;
    documentId: string;
    bastNumber: string;
  };
  const version = await pool!.query<{ id: string }>(
    `SELECT id FROM document_versions
     WHERE document_id = $1 AND version_number = 1`,
    [bast.documentId],
  );
  const legacy = await pool!.query<{ id: string }>(
    `SELECT id FROM vendor_bast_bindings
     WHERE vendor_work_id = $1`,
    [input.vendorWorkId],
  );
  assert.equal(version.rowCount, 1);
  assert.equal(legacy.rowCount, 1);
  return {
    bast,
    documentVersionId: version.rows[0].id,
    legacyId: legacy.rows[0].id,
  };
}

async function insertLegacyOnly(input: {
  clientId: string;
  buildingId: string;
  workOrderId: string;
  vendorWorkId: string;
}) {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_bast_bindings
       (id, client_id, vendor_work_id, work_order_id, building_id,
        bast_number, bast_date, prepared_by_user_id, submitted_by_user_id,
        accepted_by_user_id, acceptance_status, submitted_at, accepted_at)
     VALUES ($1,$2,$3,$4,$5,$6,'2026-08-18',$7,$7,$7,'REJECTED',NOW(),NOW())`,
    [
      id,
      input.clientId,
      input.vendorWorkId,
      input.workOrderId,
      input.buildingId,
      `LEGACY_${suffix()}`,
      userId,
    ],
  );
  return id;
}

describe('CR-BE-BAST-01 PART 03 — legacy Vendor BAST compatibility', () => {
  it('projects canonical authority, delegates only safe writes, inventories divergence, and preserves isolation', async (t) => {
    if (!ready(t)) return;

    const { client, building } = await structure(true);
    const workOrder = await completedWorkOrder(client.id, building.id);
    const vendorWork = await completedVendorWork({
      clientId: client.id,
      buildingId: building.id,
      workOrderId: workOrder.id,
    });
    const linked = await createCanonicalVendorBast({
      clientId: client.id,
      buildingId: building.id,
      workOrderId: workOrder.id,
      vendorId: vendorWork.vendor.id,
      vendorWorkId: vendorWork.vendorWorkId,
    });

    const initialRead = await api()
      .get(`/api/v1/vendor-basts/${linked.legacyId}`)
      .set(auth());
    assert.equal(initialRead.status, 200, JSON.stringify(initialRead.body));
    assert.equal(initialRead.body.data.id, linked.legacyId);
    assert.equal(initialRead.body.data.bastDocumentId, linked.bast.id);
    assert.equal(initialRead.body.data.vendorWorkId, vendorWork.vendorWorkId);
    assert.equal(initialRead.body.data.acceptanceStatus, 'DRAFT');
    assert.deepEqual(initialRead.body.data.compatibility, {
      lifecycleAuthority: 'CANONICAL_BAST',
      reconciliationRequired: false,
      legacyAcceptanceStatus: 'DRAFT',
    });
    assert.equal(initialRead.body.data.acceptanceSignOff, null);

    const initiallyLinkedInventory = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: building.id })
      .set(auth());
    assert.equal(
      initiallyLinkedInventory.status,
      200,
      JSON.stringify(initiallyLinkedInventory.body),
    );
    assert.ok(
      initiallyLinkedInventory.body.data.items.some(
        (item: {
          classification: string;
          canonicalBastDocumentId: string;
          legacyVendorBastBindingId: string;
        }) =>
          item.classification === 'LINKED_CONSISTENT' &&
          item.canonicalBastDocumentId === linked.bast.id &&
          item.legacyVendorBastBindingId === linked.legacyId,
      ),
    );

    // The compatibility submit delegates to PART 02 and leaves every legacy
    // lifecycle column untouched.
    const submitted = await api()
      .post(`/api/v1/vendor-basts/${linked.legacyId}/submit`)
      .set(auth())
      .send({ documentVersionId: linked.documentVersionId });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.acceptanceStatus, 'SUBMITTED');
    assert.equal(submitted.body.data.submittedByUserId, userId);
    assert.ok(submitted.body.data.submittedAt);
    assert.equal(
      submitted.body.data.compatibility.legacyAcceptanceStatus,
      'DRAFT',
    );

    const accepted = await api()
      .post(`/api/v1/vendor-basts/${linked.legacyId}/accept`)
      .set(auth())
      .send({ notes: 'Accepted through canonical compatibility delegation.' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.acceptanceStatus, 'ACCEPTED');
    assert.equal(accepted.body.data.acceptedByUserId, userId);
    assert.ok(accepted.body.data.acceptedAt);
    assert.equal(accepted.body.data.acceptanceSignOff.decision, 'ACCEPTED');
    assert.equal(accepted.body.data.acceptanceSignOff.signerUserId, userId);
    assert.equal(
      accepted.body.data.acceptanceSignOff.documentVersionId,
      linked.documentVersionId,
    );
    assert.ok(accepted.body.data.acceptanceSignOff.bastSubmissionAttemptId);
    assert.equal(
      accepted.body.data.acceptanceSignOff.notes,
      'Accepted through canonical compatibility delegation.',
    );

    const storedStates = await pool!.query(
      `SELECT
         vb.acceptance_status AS legacy_status,
         vb.submitted_by_user_id AS legacy_submitter,
         vb.accepted_by_user_id AS legacy_acceptor,
         bd.acceptance_status AS canonical_status,
         (SELECT COUNT(*)::int FROM bast_submission_attempts a
          WHERE a.bast_document_id = bd.id) AS attempts,
         (SELECT COUNT(*)::int FROM acceptance_sign_offs s
          WHERE s.bast_document_id = bd.id
            AND s.bast_submission_attempt_id IS NOT NULL) AS sign_offs
       FROM vendor_bast_bindings vb
       JOIN bast_documents bd ON bd.id = vb.bast_document_id
       WHERE vb.id = $1`,
      [linked.legacyId],
    );
    assert.deepEqual(storedStates.rows, [
      {
        legacy_status: 'DRAFT',
        legacy_submitter: null,
        legacy_acceptor: null,
        canonical_status: 'ACCEPTED',
        attempts: 1,
        sign_offs: 1,
      },
    ]);

    const list = await api()
      .get('/api/v1/vendor-basts')
      .query({ buildingId: building.id })
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const listed = list.body.data.find(
      (item: { id: string }) => item.id === linked.legacyId,
    );
    assert.ok(listed);
    assert.equal(listed.bastDocumentId, linked.bast.id);
    assert.equal(listed.acceptanceStatus, 'ACCEPTED');
    assert.equal(listed.acceptanceSignOff.decision, 'ACCEPTED');

    // The old create contract cannot create a competing lifecycle.
    const beforeCreateCount = await pool!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM vendor_bast_bindings',
    );
    const legacyCreate = await api()
      .post('/api/v1/vendor-basts')
      .set(auth())
      .send({ vendorWorkId: randomUUID() });
    assert.equal(legacyCreate.status, 409, JSON.stringify(legacyCreate.body));
    assert.equal(
      legacyCreate.body.error.code,
      'BAST_LEGACY_WRITE_RESTRICTED',
    );
    assert.deepEqual(legacyCreate.body.error.conflict, {
      authority: 'BAST_DOCUMENT',
      retryable: false,
      guidance: 'Create BAST through POST /bast-documents.',
    });
    const afterCreateCount = await pool!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM vendor_bast_bindings',
    );
    assert.equal(
      afterCreateCount.rows[0].count,
      beforeCreateCount.rows[0].count,
    );

    // Legacy-only history remains readable but cannot accept/submit/reject.
    const legacyWorkOrder = await completedWorkOrder(client.id, building.id);
    const legacyVendorWork = await completedVendorWork({
      clientId: client.id,
      buildingId: building.id,
      workOrderId: legacyWorkOrder.id,
    });
    const legacyOnlyId = await insertLegacyOnly({
      clientId: client.id,
      buildingId: building.id,
      workOrderId: legacyWorkOrder.id,
      vendorWorkId: legacyVendorWork.vendorWorkId,
    });
    const legacyOnlyRead = await api()
      .get(`/api/v1/vendor-basts/${legacyOnlyId}`)
      .set(auth());
    assert.equal(
      legacyOnlyRead.status,
      200,
      JSON.stringify(legacyOnlyRead.body),
    );
    assert.equal(legacyOnlyRead.body.data.bastDocumentId, null);
    assert.equal(legacyOnlyRead.body.data.acceptanceStatus, 'REJECTED');
    assert.equal(
      legacyOnlyRead.body.data.compatibility.lifecycleAuthority,
      'LEGACY_ONLY_FALLBACK',
    );
    assert.equal(
      legacyOnlyRead.body.data.compatibility.reconciliationRequired,
      true,
    );
    assert.equal(legacyOnlyRead.body.data.acceptanceSignOff, null);

    const legacyOnlyBypass = await api()
      .post(`/api/v1/vendor-basts/${legacyOnlyId}/reject`)
      .set(auth())
      .send({ notes: 'Must not create a legacy decision.' });
    assert.equal(
      legacyOnlyBypass.status,
      409,
      JSON.stringify(legacyOnlyBypass.body),
    );
    assert.equal(
      legacyOnlyBypass.body.error.code,
      'BAST_LEGACY_WRITE_RESTRICTED',
    );
    const unchangedLegacyOnly = await pool!.query(
      `SELECT acceptance_status,
              (SELECT COUNT(*)::int FROM acceptance_sign_offs
               WHERE bast_document_id IS NULL) AS unbound_sign_offs
       FROM vendor_bast_bindings WHERE id = $1`,
      [legacyOnlyId],
    );
    assert.deepEqual(unchangedLegacyOnly.rows, [
      { acceptance_status: 'REJECTED', unbound_sign_offs: 0 },
    ]);

    // Add a second historical legacy link to the same canonical identity.
    // No cleanup/rewrite follows; reconciliation must inventory it.
    const duplicateVendorWork = await completedVendorWork({
      clientId: client.id,
      buildingId: building.id,
      workOrderId: workOrder.id,
    });
    const duplicateLegacyId = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_bast_bindings
         (id, client_id, vendor_work_id, work_order_id, building_id,
          bast_number, bast_date, prepared_by_user_id, bast_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-08-18',$7,$8)`,
      [
        duplicateLegacyId,
        client.id,
        duplicateVendorWork.vendorWorkId,
        workOrder.id,
        building.id,
        `DUP_${suffix()}`,
        userId,
        linked.bast.id,
      ],
    );

    // Canonical-only remains an inventory case and is not synthesized into a
    // fake legacy identity.
    const canonicalOnlyWorkOrder = await completedWorkOrder(
      client.id,
      building.id,
    );
    const canonicalOnly = await api()
      .post('/api/v1/bast-documents')
      .set(auth())
      .send({
        clientId: client.id,
        buildingId: building.id,
        contextType: 'INTERNAL',
        documentNumber: `DOC_${suffix()}`,
        documentType: 'BAST',
        title: 'Canonical-only BAST',
        workOrderId: canonicalOnlyWorkOrder.id,
        bastNumber: `BAST_${suffix()}`,
        bastDate: '2026-08-18',
      });
    assert.equal(canonicalOnly.status, 201, JSON.stringify(canonicalOnly.body));

    const inventoryBeforeIsolation = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: building.id })
      .set(auth());
    assert.equal(
      inventoryBeforeIsolation.status,
      200,
      JSON.stringify(inventoryBeforeIsolation.body),
    );
    const inventoryItems = inventoryBeforeIsolation.body.data.items as Array<{
      classification: string;
      canonicalBastDocumentId: string | null;
      legacyVendorBastBindingId: string | null;
    }>;
    assert.ok(
      inventoryItems.some(
        (item) =>
          item.classification === 'DIVERGENT_LIFECYCLE' &&
          item.canonicalBastDocumentId === linked.bast.id,
      ),
    );
    assert.ok(
      inventoryItems.some(
        (item) =>
          item.classification === 'DUPLICATE_ACCEPTANCE_SCOPE' &&
          item.canonicalBastDocumentId === linked.bast.id,
      ),
    );
    assert.ok(
      inventoryItems.some(
        (item) =>
          item.classification === 'LEGACY_ONLY' &&
          item.legacyVendorBastBindingId === legacyOnlyId,
      ),
    );
    assert.ok(
      inventoryItems.some(
        (item) =>
          item.classification === 'MISSING_REFERENCE' &&
          item.legacyVendorBastBindingId === legacyOnlyId,
      ),
    );
    assert.ok(
      inventoryItems.some(
        (item) =>
          item.classification === 'CANONICAL_ONLY' &&
          item.canonicalBastDocumentId === canonicalOnly.body.data.id,
      ),
    );

    const duplicateStillExists = await pool!.query(
      'SELECT bast_document_id FROM vendor_bast_bindings WHERE id = $1',
      [duplicateLegacyId],
    );
    assert.equal(duplicateStillExists.rows[0].bast_document_id, linked.bast.id);

    // Cross-Client/Building links are never projected or leaked.
    const hidden = await structure(false);
    const hiddenWorkOrderId = randomUUID();
    const hiddenDocumentId = randomUUID();
    const hiddenBastId = randomUUID();
    await pool!.query(
      `INSERT INTO work_orders
         (id, client_id, building_id, work_order_number, title, work_type,
          status, completed_at, completed_by_user_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,'Hidden work','REPAIR','COMPLETED',NOW(),$5,$5)`,
      [
        hiddenWorkOrderId,
        hidden.client.id,
        hidden.building.id,
        `WO_${suffix()}`,
        userId,
      ],
    );
    await pool!.query(
      `INSERT INTO documents
         (id, client_id, building_id, document_number, document_type,
          context_type, title, created_by_user_id)
       VALUES ($1,$2,$3,$4,'BAST','INTERNAL','Hidden BAST',$5)`,
      [
        hiddenDocumentId,
        hidden.client.id,
        hidden.building.id,
        `DOC_${suffix()}`,
        userId,
      ],
    );
    await pool!.query(
      `INSERT INTO bast_documents
         (id, document_id, work_order_id, client_id, building_id,
          context_type, bast_number, bast_date, prepared_by_user_id,
          acceptance_scope_type)
       VALUES ($1,$2,$3,$4,$5,'INTERNAL',$6,'2026-08-18',$7,'WORK_ORDER')`,
      [
        hiddenBastId,
        hiddenDocumentId,
        hiddenWorkOrderId,
        hidden.client.id,
        hidden.building.id,
        `BAST_${suffix()}`,
        userId,
      ],
    );
    await pool!.query(
      `UPDATE vendor_bast_bindings
       SET bast_document_id = $2 WHERE id = $1`,
      [legacyOnlyId, hiddenBastId],
    );

    const crossScopeRead = await api()
      .get(`/api/v1/vendor-basts/${legacyOnlyId}`)
      .set(auth());
    assert.equal(crossScopeRead.status, 200, JSON.stringify(crossScopeRead.body));
    assert.equal(crossScopeRead.body.data.bastDocumentId, null);
    assert.equal(
      crossScopeRead.body.data.compatibility.lifecycleAuthority,
      'UNRESOLVED_CANONICAL_LINK',
    );
    assert.equal(JSON.stringify(crossScopeRead.body).includes(hiddenBastId), false);

    const crossScopeWrite = await api()
      .post(`/api/v1/vendor-basts/${legacyOnlyId}/accept`)
      .set(auth())
      .send({ notes: 'Must not cross scope.' });
    assert.equal(crossScopeWrite.status, 409, JSON.stringify(crossScopeWrite.body));
    assert.equal(
      crossScopeWrite.body.error.code,
      'BAST_LEGACY_WRITE_RESTRICTED',
    );
    const hiddenState = await pool!.query(
      'SELECT acceptance_status FROM bast_documents WHERE id = $1',
      [hiddenBastId],
    );
    assert.deepEqual(hiddenState.rows, [{ acceptance_status: 'DRAFT' }]);

    const isolatedInventory = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: building.id })
      .set(auth());
    assert.equal(isolatedInventory.status, 200, JSON.stringify(isolatedInventory.body));
    assert.equal(JSON.stringify(isolatedInventory.body).includes(hiddenBastId), false);
    assert.ok(
      isolatedInventory.body.data.items.some(
        (item: { classification: string; legacyVendorBastBindingId: string }) =>
          item.classification === 'CROSS_SCOPE_SECURITY_MISMATCH' &&
          item.legacyVendorBastBindingId === legacyOnlyId,
      ),
    );

    const deniedHiddenInventory = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: hidden.building.id })
      .set(auth());
    assert.equal(deniedHiddenInventory.status, 403);
    assert.equal(
      deniedHiddenInventory.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );
  });
});
