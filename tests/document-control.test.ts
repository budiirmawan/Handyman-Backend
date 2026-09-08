import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-22 final review regression — shared Document control surface.
 *
 * Guards the BE-22B–I creation paths that previously had no PostgreSQL-backed
 * coverage (and whose create() repositories crashed with
 * `missing FROM-clause entry for table`). Covers the ONE shared foundation
 * flow: Document → Version → Expiry → Approval, then Work Completion → BAST
 * (including the BE-15H vendor_bast_bindings sync) → Handover → Sign-Off →
 * Supporting Document, plus archive protection of the lifecycle.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE supporting_documents, acceptance_sign_offs, handover_documents,
    bast_documents, work_completion_documents, document_versions, documents,
    vendor_bast_bindings, vendor_works, vendor_assignments, vendors,
    work_orders, operational_events, users, roles, clients, properties,
    buildings CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function structure(assign = true) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Document Control Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  if (assign) await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  return { client, building };
}

async function completedWorkOrder(clientId: string, buildingId: string): Promise<string> {
  const workOrderId = randomUUID();
  await pool!.query(
    `INSERT INTO work_orders (id, client_id, building_id, work_order_number, title, work_type, status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'REPAIR','COMPLETED',$6)`,
    [workOrderId, clientId, buildingId, `WO_${suffix()}`, 'Completed work', userId],
  );
  return workOrderId;
}

async function createDocument(buildingId: string, clientId: string, overrides: Record<string, unknown> = {}) {
  const response = await api().post('/api/v1/documents').set(auth()).send({
    clientId,
    buildingId,
    documentNumber: `DOC_${suffix()}`,
    documentType: 'REPORT',
    contextType: 'INTERNAL',
    title: 'Document control regression',
    ...overrides,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

describe('BE-22 — Document control (shared foundation)', () => {
  it('creates Work Completion, BAST, Handover, Sign-Off and Supporting Documents on the shared foundation', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const workOrderId = await completedWorkOrder(client.id, building.id);

    const wcd = await api().post('/api/v1/work-completion-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'INTERNAL',
      documentNumber: `WCD_${suffix()}`,
      documentType: 'REPORT',
      title: 'Completion',
      workOrderId,
    });
    assert.equal(wcd.status, 201, JSON.stringify(wcd.body));
    assert.equal(wcd.body.data.document.status, 'DRAFT');

    const bast = await api().post('/api/v1/bast-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'INTERNAL',
      documentNumber: `BAST_${suffix()}`,
      documentType: 'BAST',
      title: 'Serah terima',
      workOrderId,
      workCompletionDocumentId: wcd.body.data.id,
      bastNumber: `BST_${suffix()}`,
      bastDate: '2026-08-17',
    });
    assert.equal(bast.status, 201, JSON.stringify(bast.body));
    assert.equal(bast.body.data.acceptanceStatus, 'DRAFT');

    const handover = await api().post('/api/v1/handover-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'INTERNAL',
      documentNumber: `HDO_${suffix()}`,
      documentType: 'HANDOVER',
      title: 'Handover',
      workOrderId,
      workCompletionDocumentId: wcd.body.data.id,
      bastDocumentId: bast.body.data.id,
      handoverNumber: `HDO_${suffix()}`,
      handoverDate: '2026-08-17',
    });
    assert.equal(handover.status, 201, JSON.stringify(handover.body));
    assert.ok(handover.body.data.handedOverAt === null);

    const signOff = await api().post('/api/v1/acceptance-sign-offs').set(auth()).send({
      bastDocumentId: bast.body.data.id,
      decision: 'ACCEPTED',
      notes: 'ok',
    });
    assert.equal(signOff.status, 201, JSON.stringify(signOff.body));
    assert.equal(signOff.body.data.decision, 'ACCEPTED');

    const supporting = await api().post('/api/v1/supporting-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'INTERNAL',
      documentNumber: `SUP_${suffix()}`,
      documentType: 'SUPPORT',
      title: 'Attachment',
      parentType: 'BAST',
      parentId: bast.body.data.id,
      fileReference: 'objects/attachment.pdf',
    });
    assert.equal(supporting.status, 201, JSON.stringify(supporting.body));

    // Every document-backed record (WCD, BAST, Handover, Supporting) must be
    // backed by a row in the ONE shared foundation; sign-off is a lifecycle
    // record on the BAST and does not create its own Document.
    const docs = await pool!.query('SELECT id FROM documents WHERE client_id = $1', [client.id]);
    assert.equal(docs.rowCount, 4);
  });

  it('syncs BE-15H vendor_bast_bindings to the authoritative BAST for VENDOR context', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const workOrderId = await completedWorkOrder(client.id, building.id);
    const vendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Vendor',
    });
    const vendorAssignmentId = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_assignments (id, vendor_id, work_order_id, building_id, status, assigned_by_user_id)
       VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
      [vendorAssignmentId, vendor.id, workOrderId, building.id, userId],
    );
    const vendorWorkId = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_works (id, vendor_assignment_id, vendor_id, work_order_id, building_id, status, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,'COMPLETED',NOW() - INTERVAL '1 day', NOW())`,
      [vendorWorkId, vendorAssignmentId, vendor.id, workOrderId, building.id],
    );

    const bast = await api().post('/api/v1/bast-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'VENDOR',
      sourceType: 'VENDOR',
      sourceId: vendor.id,
      documentNumber: `BAST_${suffix()}`,
      documentType: 'BAST',
      title: 'Vendor BAST',
      workOrderId,
      vendorWorkId,
      bastNumber: `BST_${suffix()}`,
      bastDate: '2026-08-17',
    });
    assert.equal(bast.status, 201, JSON.stringify(bast.body));

    const binding = await pool!.query(
      'SELECT bast_document_id FROM vendor_bast_bindings WHERE vendor_work_id = $1',
      [vendorWorkId],
    );
    assert.equal(binding.rowCount, 1);
    assert.equal(binding.rows[0].bast_document_id, bast.body.data.id);

    // One BAST per vendor work — duplicate must be rejected
    const duplicate = await api().post('/api/v1/bast-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'VENDOR',
      sourceType: 'VENDOR',
      sourceId: vendor.id,
      documentNumber: `BAST_${suffix()}`,
      documentType: 'BAST',
      title: 'Vendor BAST 2',
      workOrderId,
      vendorWorkId,
      bastNumber: `BST_${suffix()}`,
      bastDate: '2026-08-17',
    });
    assert.equal(duplicate.status, 409);
  });

  it('keeps immutable version history across expiry updates and preserves it through archive/restore', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const document = await createDocument(building.id, client.id);

    const versions1 = await api().get(`/api/v1/documents/${document.id}/versions`).set(auth());
    assert.equal(versions1.status, 200);
    assert.equal(versions1.body.data.length, 1);
    assert.equal(versions1.body.data[0].versionNumber, 1);

    const version2 = await api().post(`/api/v1/documents/${document.id}/versions`).set(auth()).send({ title: 'Second version' });
    assert.equal(version2.status, 201, JSON.stringify(version2.body));
    assert.equal(version2.body.data.versionNumber, 2);

    const expiry = await api().put(`/api/v1/documents/${document.id}/expiry`).set(auth()).send({ expiryDate: '2031-01-01T00:00:00.000Z' });
    assert.equal(expiry.status, 200, JSON.stringify(expiry.body));

    const versions2 = await api().get(`/api/v1/documents/${document.id}/versions`).set(auth());
    assert.equal(versions2.status, 200);
    assert.equal(versions2.body.data.length, 3, 'expiry change must append a version, never overwrite');

    const archived = await api().post(`/api/v1/documents/${document.id}/archive`).set(auth()).send({ reason: 'retention' });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal((await api().patch(`/api/v1/documents/${document.id}`).set(auth()).send({ title: 'no' })).status, 409);
    assert.equal((await api().post(`/api/v1/documents/${document.id}/versions`).set(auth()).send({ title: 'no' })).status, 409);
    assert.equal((await api().put(`/api/v1/documents/${document.id}/expiry`).set(auth()).send({ expiryDate: null })).status, 409);

    const restored = await api().post(`/api/v1/documents/${document.id}/restore`).set(auth()).send({});
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.data.status, 'DRAFT');

    const versions3 = await api().get(`/api/v1/documents/${document.id}/versions`).set(auth());
    assert.equal(versions3.body.data.length, 3, 'version history must survive archive/restore');
  });

  it('preserves approval history for document and version targets and blocks duplicate pending reviews', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const document = await createDocument(building.id, client.id);

    const submitted = await api().post(`/api/v1/documents/${document.id}/approvals`).set(auth()).send({
      approverUserId: userId,
      notes: 'please review',
    });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const approvalId = submitted.body.data.id;

    const duplicate = await api().post(`/api/v1/documents/${document.id}/approvals`).set(auth()).send({
      approverUserId: userId,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'DOCUMENT_APPROVAL_ALREADY_PENDING');

    const approved = await api().post(`/api/v1/document-approvals/${approvalId}/approve`).set(auth()).send({ notes: 'ok' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.approvalStatus, 'APPROVED');
    assert.equal((await api().post(`/api/v1/document-approvals/${approvalId}/approve`).set(auth()).send({})).status, 409);

    const versions = await api().get(`/api/v1/documents/${document.id}/versions`).set(auth());
    const versionApproval = await api().post(`/api/v1/documents/${document.id}/approvals`).set(auth()).send({
      approverUserId: userId,
      versionId: versions.body.data[0].id,
    });
    assert.equal(versionApproval.status, 201, JSON.stringify(versionApproval.body));
    const rejected = await api().post(`/api/v1/document-approvals/${versionApproval.body.data.id}/reject`).set(auth()).send({});
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));

    const history = await api().get(`/api/v1/documents/${document.id}/approvals`).set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 2, 'document and version approval history both preserved');
    assert.ok(history.body.data.some((a: { decision: string }) => a.decision === 'APPROVED'));
    assert.ok(history.body.data.some((a: { decision: string }) => a.decision === 'REJECTED'));
  });

  it('blocks new sign-offs and supporting documents once the parent BAST document is archived', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const workOrderId = await completedWorkOrder(client.id, building.id);

    const bast = await api().post('/api/v1/bast-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'INTERNAL',
      documentNumber: `BAST_${suffix()}`,
      documentType: 'BAST',
      title: 'Serah terima',
      workOrderId,
      bastNumber: `BST_${suffix()}`,
      bastDate: '2026-08-17',
    });
    assert.equal(bast.status, 201, JSON.stringify(bast.body));

    const archived = await api().post(`/api/v1/documents/${bast.body.data.document.id}/archive`).set(auth()).send({ reason: 'retention' });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));

    const signOff = await api().post('/api/v1/acceptance-sign-offs').set(auth()).send({
      bastDocumentId: bast.body.data.id,
      decision: 'ACCEPTED',
    });
    assert.equal(signOff.status, 409);
    assert.equal(signOff.body.error.code, 'DOCUMENT_UPDATE_NOT_ALLOWED');

    const supporting = await api().post('/api/v1/supporting-documents').set(auth()).send({
      clientId: client.id,
      buildingId: building.id,
      contextType: 'INTERNAL',
      documentNumber: `SUP_${suffix()}`,
      documentType: 'SUPPORT',
      title: 'Attachment',
      parentType: 'BAST',
      parentId: bast.body.data.id,
      fileReference: 'objects/attachment.pdf',
    });
    assert.equal(supporting.status, 409);
    assert.equal(supporting.body.error.code, 'DOCUMENT_UPDATE_NOT_ALLOWED');
  });
});
