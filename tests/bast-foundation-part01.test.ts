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

const PORT = 55470;
const DIR = '/tmp/asentra-bast-part01-pg';
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
    name: 'Canonical BAST Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Canonical BAST Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Canonical BAST Building',
  });
  if (assign) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

async function completedVendorWork(input: {
  clientId: string;
  buildingId: string;
  workOrderId: string;
}) {
  const vendor = await vendorService.createVendor({
    clientId: input.clientId,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Canonical BAST Vendor',
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
  return { vendor, vendorWorkId };
}

describe('CR-BE-BAST-01 PART 01 — canonical foundation and reconciliation', () => {
  it('pins canonical identity/references, cardinality and evidence while inventory remains isolated and read-only', async (t) => {
    if (!ready(t)) return;

    const { client, building } = await structure(true);
    const workOrder = await workOrderService.createWorkOrder({
      clientId: client.id,
      buildingId: building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Canonical BAST work',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    assert.equal(workOrder.bastRequirement, 'NONE');

    const policy = await api()
      .patch(`/api/v1/work-orders/${workOrder.id}/bast-requirement`)
      .set(auth())
      .send({ bastRequirement: 'EACH_VENDOR_WORK' });
    assert.equal(policy.status, 200, JSON.stringify(policy.body));
    assert.equal(policy.body.data.bastRequirement, 'EACH_VENDOR_WORK');
    const policyAudit = await pool!.query(
      `SELECT actor_user_id, metadata
       FROM operational_events
       WHERE entity_type = 'WORK_ORDER' AND entity_id = $1
         AND event_type = 'WORK_ORDER_BAST_REQUIREMENT_CHANGED'`,
      [workOrder.id],
    );
    assert.equal(policyAudit.rowCount, 1);
    assert.equal(policyAudit.rows[0].actor_user_id, userId);
    assert.deepEqual(policyAudit.rows[0].metadata, {
      from: 'NONE',
      to: 'EACH_VENDOR_WORK',
    });

    await pool!.query(
      `UPDATE work_orders
       SET status = 'COMPLETED', completed_at = NOW(), completed_by_user_id = $2
       WHERE id = $1`,
      [workOrder.id, userId],
    );
    const { vendor, vendorWorkId } = await completedVendorWork({
      clientId: client.id,
      buildingId: building.id,
      workOrderId: workOrder.id,
    });
    const completionReportId = randomUUID();
    const serviceReportId = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_completion_reports
         (id, client_id, vendor_work_id, work_order_id, building_id,
          completion_status, evidence_ready, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'SUBMITTED',TRUE,$6)`,
      [
        completionReportId,
        client.id,
        vendorWorkId,
        workOrder.id,
        building.id,
        userId,
      ],
    );
    await pool!.query(
      `INSERT INTO vendor_service_reports
         (id, client_id, vendor_work_id, completion_report_id, work_order_id,
          building_id, service_report_number, service_date,
          prepared_by_user_id, status, finalized_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-08-18',$8,'FINALIZED',NOW())`,
      [
        serviceReportId,
        client.id,
        vendorWorkId,
        completionReportId,
        workOrder.id,
        building.id,
        `SR_${suffix()}`,
        userId,
      ],
    );

    const bastNumber = `BAST_${suffix()}`;
    const created = await api()
      .post('/api/v1/bast-documents')
      .set(auth())
      .send({
        clientId: client.id,
        buildingId: building.id,
        contextType: 'VENDOR',
        sourceType: 'VENDOR',
        sourceId: vendor.id,
        documentNumber: `DOC_${suffix()}`,
        documentType: 'BAST',
        title: 'Canonical vendor acceptance',
        workOrderId: workOrder.id,
        vendorWorkId,
        bastNumber,
        bastDate: '2026-08-18',
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bast = created.body.data;
    assert.equal(bast.id.length, 36);
    assert.notEqual(bast.id, bast.documentId);
    assert.equal(bast.vendorId, vendor.id);
    assert.equal(bast.completionReportId, completionReportId);
    assert.equal(bast.serviceReportId, serviceReportId);
    assert.equal(bast.acceptanceScopeType, 'VENDOR_WORK');
    assert.equal(bast.bastRequirement, 'EACH_VENDOR_WORK');

    const compatibility = await pool!.query(
      `SELECT id, bast_document_id, completion_report_id, service_report_id,
              acceptance_status
       FROM vendor_bast_bindings WHERE vendor_work_id = $1`,
      [vendorWorkId],
    );
    assert.equal(compatibility.rowCount, 1);
    assert.equal(compatibility.rows[0].bast_document_id, bast.id);
    assert.equal(compatibility.rows[0].completion_report_id, completionReportId);
    assert.equal(compatibility.rows[0].service_report_id, serviceReportId);
    const compatibilityRead = await api()
      .get(`/api/v1/vendor-basts/${compatibility.rows[0].id}`)
      .set(auth());
    assert.equal(
      compatibilityRead.status,
      200,
      JSON.stringify(compatibilityRead.body),
    );
    assert.equal(compatibilityRead.body.data.bastDocumentId, bast.id);

    const version = await pool!.query(
      'SELECT id FROM document_versions WHERE document_id = $1 AND version_number = 1',
      [bast.documentId],
    );
    assert.equal(version.rowCount, 1);
    const attemptId = randomUUID();
    await pool!.query(
      `INSERT INTO bast_submission_attempts
         (id, bast_document_id, attempt_number, document_version_id,
          completion_report_id, service_report_id, readiness_snapshot,
          submitted_by_user_id)
       VALUES ($1,$2,1,$3,$4,$5,$6::jsonb,$7)`,
      [
        attemptId,
        bast.id,
        version.rows[0].id,
        completionReportId,
        serviceReportId,
        JSON.stringify({ evidenceReady: true, verified: true }),
        userId,
      ],
    );
    const evidenceId = randomUUID();
    await pool!.query(
      `INSERT INTO evidence_submissions
         (id, client_id, execution_type, execution_id, evidence_type,
          file_reference, original_file_name, mime_type, file_size,
          submitted_by_user_id)
       VALUES ($1,$2,'FORM_INSTANCE',$3,'DOCUMENT',$4,'bast.pdf',
               'application/pdf',10,$5)`,
      [evidenceId, client.id, randomUUID(), 'objects/bast.pdf', userId],
    );
    await pool!.query(
      `INSERT INTO bast_submission_attempt_evidence
         (submission_attempt_id, evidence_submission_id)
       VALUES ($1,$2)`,
      [attemptId, evidenceId],
    );
    await assert.rejects(
      pool!.query(
        `UPDATE bast_submission_attempts
         SET readiness_snapshot = '{"changed":true}'::jsonb WHERE id = $1`,
        [attemptId],
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === '55000',
    );
    await assert.rejects(
      pool!.query(
        `DELETE FROM bast_submission_attempt_evidence
         WHERE submission_attempt_id = $1`,
        [attemptId],
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === '55000',
    );

    const lockedPolicy = await api()
      .patch(`/api/v1/work-orders/${workOrder.id}/bast-requirement`)
      .set(auth())
      .send({ bastRequirement: 'WORK_ORDER' });
    assert.equal(lockedPolicy.status, 409, JSON.stringify(lockedPolicy.body));
    assert.equal(
      lockedPolicy.body.error.code,
      'WORK_ORDER_BAST_REQUIREMENT_LOCKED',
    );

    const consistentInventory = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: building.id })
      .set(auth());
    assert.equal(
      consistentInventory.status,
      200,
      JSON.stringify(consistentInventory.body),
    );
    assert.ok(
      consistentInventory.body.data.items.some(
        (item: { classification: string; canonicalBastDocumentId: string }) =>
          item.classification === 'LINKED_CONSISTENT' &&
          item.canonicalBastDocumentId === bast.id,
      ),
    );

    // Generic Sign-Off writes cannot bypass the canonical decision command.
    // A deliberately inserted historical pre-consolidation row lets the
    // read-only inventory report missing attempt/version pins non-destructively.
    const signOffBypass = await api()
      .post('/api/v1/acceptance-sign-offs')
      .set(auth())
      .send({ bastDocumentId: bast.id, decision: 'ACCEPTED' });
    assert.equal(signOffBypass.status, 400, JSON.stringify(signOffBypass.body));
    assert.equal(signOffBypass.body.error.code, 'ACCEPTANCE_INVALID_CONTEXT');
    await pool!.query(
      `INSERT INTO acceptance_sign_offs
         (id, bast_document_id, client_id, building_id, context_type,
          decision, signer_user_id)
       VALUES ($1,$2,$3,$4,'VENDOR','ACCEPTED',$5)`,
      [randomUUID(), bast.id, client.id, building.id, userId],
    );

    await pool!.query(
      `UPDATE vendor_bast_bindings SET acceptance_status = 'SUBMITTED'
       WHERE id = $1`,
      [compatibility.rows[0].id],
    );
    const beforeInventory = await pool!.query(
      `SELECT
         (SELECT acceptance_status FROM bast_documents WHERE id = $1) canonical,
         (SELECT acceptance_status FROM vendor_bast_bindings WHERE id = $2) legacy,
         (SELECT COUNT(*)::int FROM bast_submission_attempts WHERE bast_document_id = $1) attempts`,
      [bast.id, compatibility.rows[0].id],
    );
    const inventory = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: building.id })
      .set(auth());
    assert.equal(inventory.status, 200, JSON.stringify(inventory.body));
    assert.equal(inventory.body.data.readOnly, true);
    const classes = new Set(
      inventory.body.data.items.map(
        (item: { classification: string }) => item.classification,
      ),
    );
    assert.ok(classes.has('DIVERGENT_LIFECYCLE'));
    assert.ok(classes.has('CONTRADICTORY_SIGN_OFF'));
    assert.ok(classes.has('MISSING_VERSION'));

    const afterInventory = await pool!.query(
      `SELECT
         (SELECT acceptance_status FROM bast_documents WHERE id = $1) canonical,
         (SELECT acceptance_status FROM vendor_bast_bindings WHERE id = $2) legacy,
         (SELECT COUNT(*)::int FROM bast_submission_attempts WHERE bast_document_id = $1) attempts`,
      [bast.id, compatibility.rows[0].id],
    );
    assert.deepEqual(afterInventory.rows, beforeInventory.rows);

    // Unlinking a compatibility row is test fixture corruption only: the
    // inventory must detect it without repairing, deleting, or relinking it.
    await pool!.query(
      'UPDATE vendor_bast_bindings SET bast_document_id = NULL WHERE id = $1',
      [compatibility.rows[0].id],
    );
    const duplicates = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: building.id })
      .set(auth());
    const duplicateClasses = new Set(
      duplicates.body.data.items.map(
        (item: { classification: string }) => item.classification,
      ),
    );
    assert.ok(duplicateClasses.has('CANONICAL_ONLY'));
    assert.ok(duplicateClasses.has('LEGACY_ONLY'));
    assert.ok(duplicateClasses.has('DUPLICATE_NUMBER'));
    assert.ok(duplicateClasses.has('DUPLICATE_ACCEPTANCE_SCOPE'));
    const stillUnlinked = await pool!.query(
      'SELECT bast_document_id FROM vendor_bast_bindings WHERE id = $1',
      [compatibility.rows[0].id],
    );
    assert.equal(stillUnlinked.rows[0].bast_document_id, null);

    const inaccessible = await structure(false);
    const hiddenWorkOrderId = randomUUID();
    const hiddenDocumentId = randomUUID();
    const hiddenBastId = randomUUID();
    await pool!.query(
      `INSERT INTO work_orders
         (id, client_id, building_id, work_order_number, title, work_type,
          status, created_by_user_id)
       VALUES ($1,$2,$3,$4,'Hidden work','REPAIR','COMPLETED',$5)`,
      [
        hiddenWorkOrderId,
        inaccessible.client.id,
        inaccessible.building.id,
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
        inaccessible.client.id,
        inaccessible.building.id,
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
        inaccessible.client.id,
        inaccessible.building.id,
        `BAST_${suffix()}`,
        userId,
      ],
    );
    const isolatedInventory = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: building.id })
      .set(auth());
    assert.equal(
      isolatedInventory.status,
      200,
      JSON.stringify(isolatedInventory.body),
    );
    assert.equal(
      JSON.stringify(isolatedInventory.body).includes(hiddenBastId),
      false,
    );
    const denied = await api()
      .get('/api/v1/bast-documents/reconciliation')
      .query({ buildingId: inaccessible.building.id })
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
