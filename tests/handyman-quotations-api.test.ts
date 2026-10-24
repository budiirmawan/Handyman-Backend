import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import {
  credentialService,
  hashSessionToken,
  sessionService,
} from '../src/modules/auth';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-06 PART 07A — focused HTTP/OpenAPI tests for the Handyman
 * QUOTATION surface (FROZEN F1-F12 + PART 06 HTTP handoff).
 *
 * Eleven cases prove the 13-operation / 10-path surface and the customer-safe
 * quotation-line response projection end-to-end:
 * create/DRAFT-v1, LABOR/MATERIAL lines + totals, empty DRAFT revision,
 * issue + presented read, expiry, APPROVE exposing the authoritative
 * Execution Scope, REJECT never exposing one, read/manage RBAC with
 * session actor authority, smuggling ignored, and OpenAPI/runtime
 * parity with ZERO crew/scheduling/arrival/QR/geofence/work-session/
 * payment/settlement/BAST/FM APIs.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let token = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  token = admin.token;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  disciplineId = d.id;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const HM = '/api/v1/handyman';
const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });
const QUOTATION = (requestId: string) =>
  `${HM}/requests/${requestId}/quotation`;
const VERSION = (versionId: string) =>
  `${HM}/quotation-versions/${versionId}`;
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

/** Full tenant context + immutable CR-HM-01 BM_SUPER_APP attribution. */
async function attributedFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
  const company = await tenantCompanyService.createTenantCompany({
    clientId: client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  return { client, building, space, company, pic, linkedUser, attribution };
}

/** Diagnosed request (READY_FOR_NEXT_STEP) for quotation creation. */
async function diagnosedFixture() {
  const f = await attributedFixture();
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: f.client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'FM_HINT_TEXT',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  const diagnosis = await handymanServiceRequestDiagnosisService
    .recordHandymanDiagnosis(
      {
        handymanRequestId: request.id,
        disciplineId,
        diagnosis: 'Fixture diagnosis for quotation HTTP tests.',
      },
      adminUserId,
    );
  return { ...f, service, request, diagnosis };
}

/** units_of_measure master row (existing client-scoped master). */
async function insertUom(clientId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  return id;
}

async function insertMaterialItem(clientId: string, uomId: string) {
  return inventoryItemService.createInventoryItem(
    {
      clientId,
      code: `ITM_${suffix()}`,
      name: 'Copper Pipe',
      itemType: 'MATERIAL',
      uomId,
    },
    adminUserId,
  );
}

async function insertActivePriceEntry(
  clientId: string,
  itemId: string,
  uomId: string,
  unitPrice: number,
) {
  const entry = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      sourceMode: 'MATERIAL',
      itemId,
      uomId,
      currency: 'IDR',
      unitPrice,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    adminUserId,
  );
  await priceCatalogEntryService.activatePriceCatalogEntry(
    entry.id,
    adminUserId,
  );
  return entry;
}

async function createTenantSession(tenantUserId: string): Promise<string> {
  await credentialService.createInitialCredential({
    userId: tenantUserId,
    password: 'TenantPass123',
  });
  const role = await roleService.createRole({
    code: `TENANT_QUOTE_${suffix()}`,
    name: 'Tenant Quotation PIC',
  });
  for (const code of ['tenant_company.read', 'tenant_company.manage'] as const) {
    const permission = await permissionRepository.findByCode(code);
    if (!permission) throw new Error(`${code} permission missing`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(tenantUserId, role.id);
  return (await sessionService.createSessionForUser(tenantUserId)).sessionToken;
}

async function userIdForToken(sessionToken: string): Promise<string> {
  const rows = await q<{ user_id: string }>(
    'SELECT user_id FROM user_sessions WHERE token_hash = $1',
    [hashSessionToken(sessionToken)],
  );
  if (!rows.rows[0]) throw new Error('session token user not found');
  return rows.rows[0].user_id;
}

/** Quotation (DRAFT v1) created through HTTP. */
async function createQuotationHttp(requestId: string) {
  const created = await api().post(QUOTATION(requestId)).set(auth());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as {
    quotation: { id: string; clientId: string; handymanRequestId: string };
    versions: { id: string; versionNumber: number; status: string }[];
  };
}

describe('CR-HM-06 PART 07A — handyman quotation API surface', () => {
  it('1: create quotation HTTP produces an exact DRAFT version 1', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const created = await api().post(QUOTATION(f.request.id)).set(auth());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bundle = created.body.data;
    assert.equal(bundle.quotation.clientId, f.client.id);
    assert.equal(bundle.quotation.handymanRequestId, f.request.id);
    assert.equal(bundle.quotation.createdByUserId, adminUserId);
    assert.equal(bundle.versions.length, 1);
    assert.equal(bundle.versions[0].status, 'DRAFT');
    assert.equal(bundle.versions[0].versionNumber, 1);
    assert.equal(bundle.versions[0].validUntil, null);
    // Exact request-scoped read resolves the same bundle.
    const read = await api().get(QUOTATION(f.request.id)).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.quotation.id, bundle.quotation.id);
    assert.equal(read.body.data.versions[0].id, bundle.versions[0].id);
  });

  it('2: LABOR/MATERIAL lines and totals through HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const versionId = bundle.versions[0].id;
    const uomId = await insertUom(f.client.id);
    const labor = await api().post(`${VERSION(versionId)}/lines`)
      .set(auth())
      .send({
        lineType: 'LABOR',
        description: 'Skilled technician hours',
        quantity: 2,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      });
    assert.equal(labor.status, 201, JSON.stringify(labor.body));
    assert.equal(labor.body.data.lineType, 'LABOR');
    assert.equal(labor.body.data.lineTotal, 200);
    assert.equal('referenceUnitAmount' in labor.body.data, false);
    assert.equal('sourceItemId' in labor.body.data, false);
    assert.equal('createdByUserId' in labor.body.data, false);
    const material = await api().post(`${VERSION(versionId)}/lines`)
      .set(auth())
      .send({
        lineType: 'MATERIAL',
        description: 'Copper pipe supply',
        quantity: 3,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 50,
      });
    assert.equal(material.status, 201, JSON.stringify(material.body));
    assert.equal(material.body.data.lineTotal, 150);
    const list = await api().get(`${VERSION(versionId)}/lines`).set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);
    const totals = await api().get(`${VERSION(versionId)}/totals`).set(auth());
    assert.equal(totals.status, 200);
    assert.deepEqual(
      {
        laborSubtotal: totals.body.data.laborSubtotal,
        materialSubtotal: totals.body.data.materialSubtotal,
        total: totals.body.data.total,
        currency: totals.body.data.currency,
        lineCount: totals.body.data.lineCount,
      },
      {
        laborSubtotal: 200,
        materialSubtotal: 150,
        total: 350,
        currency: 'IDR',
        lineCount: 2,
      },
    );
  });

  it('3: revision HTTP creates an empty DRAFT (no line copy)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const v1 = bundle.versions[0];
    const uomId = await insertUom(f.client.id);
    const line = await api().post(`${VERSION(v1.id)}/lines`)
      .set(auth())
      .send({
        lineType: 'LABOR',
        description: 'Hours',
        quantity: 1,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 75,
      });
    assert.equal(line.status, 201);
    const revision = await api()
      .post(`${HM}/quotations/${bundle.quotation.id}/versions`)
      .set(auth());
    assert.equal(revision.status, 201, JSON.stringify(revision.body));
    assert.equal(revision.body.data.versionNumber, 2);
    assert.equal(revision.body.data.status, 'DRAFT');
    assert.equal(revision.body.data.quotationId, bundle.quotation.id);
    assert.equal(revision.body.data.createdByUserId, adminUserId);
    // The new DRAFT starts with zero lines — revisions never copy.
    const v2Id = revision.body.data.id;
    const lines = await api().get(`${VERSION(v2Id)}/lines`).set(auth());
    assert.equal(lines.status, 200);
    assert.equal(lines.body.data.length, 0);
    const totals = await api().get(`${VERSION(v2Id)}/totals`).set(auth());
    assert.equal(totals.body.data.lineCount, 0);
    assert.equal(totals.body.data.currency, null);
    const read = await api().get(QUOTATION(f.request.id)).set(auth());
    assert.equal(read.body.data.versions.length, 2);
    assert.equal('createdByUserId' in read.body.data.quotation, false);
    assert.equal(read.body.data.versions.some((v: Record<string, unknown>) =>
      'createdByUserId' in v), false);
  });

  it('4: issue + current presented read through HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const versionId = bundle.versions[0].id;
    const uomId = await insertUom(f.client.id);
    await api().post(`${VERSION(versionId)}/lines`).set(auth()).send({
      lineType: 'LABOR',
      description: 'Hours',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
    });
    // DRAFT is not customer-presented.
    const beforePresented = await api()
      .get(`${QUOTATION(f.request.id)}/presented`)
      .set(auth());
    assert.equal(beforePresented.status, 200);
    assert.equal(beforePresented.body.data, null);
    const validUntil = FUTURE();
    const issued = await api().post(`${VERSION(versionId)}/issue`)
      .set(auth())
      .send({ validUntil });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.data.status, 'ISSUED');
    assert.equal(issued.body.data.validUntil, validUntil);
    const presented = await api()
      .get(`${QUOTATION(f.request.id)}/presented`)
      .set(auth());
    assert.equal(presented.status, 200);
    assert.equal(presented.body.data.id, versionId);
    assert.equal(presented.body.data.versionNumber, 1);
    assert.equal(presented.body.data.status, 'ISSUED');
    assert.equal(presented.body.data.validUntil, validUntil);
    assert.equal('createdByUserId' in presented.body.data, false);
  });

  it('5: expiry lifecycle through HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const versionId = bundle.versions[0].id;
    const uomId = await insertUom(f.client.id);
    await api().post(`${VERSION(versionId)}/lines`).set(auth()).send({
      lineType: 'LABOR',
      description: 'Hours',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
    });
    const issued = await api().post(`${VERSION(versionId)}/issue`)
      .set(auth())
      .send({ validUntil: FUTURE() });
    assert.equal(issued.status, 200);
    // Future validUntil is not expirable; time authority is server-side.
    const early = await api().post(`${VERSION(versionId)}/expire`)
      .set(auth());
    assert.ok(early.status >= 400);
    assert.equal(
      early.body.error.code,
      'HANDYMAN_QUOTATION_NOT_EXPIRABLE',
    );
    // Move only the server-side row past validity, then expire via HTTP.
    await q(
      `UPDATE handyman_quotation_versions
          SET valid_until = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [versionId],
    );
    const expired = await api().post(`${VERSION(versionId)}/expire`)
      .set(auth());
    assert.equal(expired.status, 200, JSON.stringify(expired.body));
    assert.equal(expired.body.data.status, 'EXPIRED');
    // Nothing is presented anymore; re-expire is an invalid transition.
    const presented = await api()
      .get(`${QUOTATION(f.request.id)}/presented`)
      .set(auth());
    assert.equal(presented.body.data, null);
    const again = await api().post(`${VERSION(versionId)}/expire`)
      .set(auth());
    assert.equal(
      again.body.error.code,
      'HANDYMAN_QUOTATION_INVALID_TRANSITION',
    );
  });

  it('6: APPROVE HTTP returns the authoritative Execution Scope (discoverable)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const versionId = bundle.versions[0].id;
    const uomId = await insertUom(f.client.id);
    await api().post(`${VERSION(versionId)}/lines`).set(auth()).send({
      lineType: 'LABOR',
      description: 'Hours',
      quantity: 2,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
    });
    await api().post(`${VERSION(versionId)}/issue`)
      .set(auth())
      .send({ validUntil: FUTURE() });
    // Pre-approval scope read 404s (nothing downstream exists yet).
    const preScope = await api().get(`${VERSION(versionId)}/execution-scope`)
      .set(auth());
    assert.equal(preScope.status, 404);
    assert.equal(
      preScope.body.error.code,
      'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );
    const nonPic = await api().post(`${VERSION(versionId)}/decision`)
      .set(auth())
      .set('Idempotency-Key', `k-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(nonPic.status, 403, JSON.stringify(nonPic.body));
    assert.equal(
      nonPic.body.error.code,
      'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN',
    );
    const tenantToken = await createTenantSession(f.linkedUser.id);
    const approved = await api().post(`${VERSION(versionId)}/decision`)
      .set(auth(tenantToken))
      .set('Idempotency-Key', `k-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.decision, 'APPROVE');
    assert.equal(approved.body.data.quotationVersionId, versionId);
    assert.equal(approved.body.data.decidedByUserId, f.linkedUser.id);
    const scope = approved.body.data.executionScope;
    assert.ok(scope, 'APPROVE must expose the authoritative scope');
    assert.equal(scope.status, 'AUTHORIZED');
    assert.equal(scope.approvedQuotationVersionId, versionId);
    assert.equal(scope.quotationDecisionId, approved.body.data.id);
    assert.equal(scope.quotationId, bundle.quotation.id);
    assert.equal(scope.handymanRequestId, f.request.id);
    assert.equal(scope.tenantCompanyId, f.company.id);
    assert.equal(scope.buildingId, f.building.id);
    assert.equal(scope.createdByUserId, f.linkedUser.id,
      'authorized decision mutation retains its actor audit fact');
    // The same authoritative scope is discoverable through the bounded read,
    // but internal actor identity is not part of the customer read contract.
    const scopedRead = await api()
      .get(`${VERSION(versionId)}/execution-scope`)
      .set(auth());
    assert.equal(scopedRead.status, 200);
    assert.equal(scopedRead.body.data.id, scope.id);
    assert.equal(scopedRead.body.data.status, 'AUTHORIZED');
    assert.equal(scopedRead.body.data.approvedQuotationVersionId, versionId);
    assert.equal(scopedRead.body.data.buildingId, f.building.id);
    assert.equal('createdByUserId' in scopedRead.body.data, false);
    const decisionRead = await api().get(`${VERSION(versionId)}/decision`)
      .set(auth());
    assert.equal(decisionRead.status, 200);
    assert.equal(decisionRead.body.data.decision, 'APPROVE');
    assert.equal(decisionRead.body.data.quotationVersionId, versionId);
    assert.equal('decidedByUserId' in decisionRead.body.data, false);
  });

  it('7: REJECT HTTP yields no Execution Scope', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const versionId = bundle.versions[0].id;
    const uomId = await insertUom(f.client.id);
    await api().post(`${VERSION(versionId)}/lines`).set(auth()).send({
      lineType: 'MATERIAL',
      description: 'Valve',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 40,
    });
    await api().post(`${VERSION(versionId)}/issue`)
      .set(auth())
      .send({ validUntil: FUTURE() });
    const tenantToken = await createTenantSession(f.linkedUser.id);
    const rejected = await api().post(`${VERSION(versionId)}/decision`)
      .set(auth(tenantToken))
      .set('Idempotency-Key', `k-${randomUUID()}`)
      .send({ decision: 'REJECT' });
    assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.decision, 'REJECT');
    assert.equal(rejected.body.data.executionScope, null);
    const scopedRead = await api()
      .get(`${VERSION(versionId)}/execution-scope`)
      .set(auth());
    assert.equal(scopedRead.status, 404);
    assert.equal(
      scopedRead.body.error.code,
      'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );
    const decisionRead = await api().get(`${VERSION(versionId)}/decision`)
      .set(auth());
    assert.equal(decisionRead.status, 200);
    assert.equal(decisionRead.body.data.decision, 'REJECT');
  });

  it('8: read/manage RBAC split; actor is always the session user', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const versionId = bundle.versions[0].id;
    const plain = await createPlainSession();
    const readOnly = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    const manageOnly = await createSessionWithPermissions([
      { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
    ]);
    // No permissions at all: reads and mutations are both rejected.
    const plainGet = await api().get(QUOTATION(f.request.id)).set(auth(plain));
    assert.equal(plainGet.status, 403);
    const plainPost = await api().post(QUOTATION(f.request.id))
      .set(auth(plain));
    assert.equal(plainPost.status, 403);
    // Read-only can never mutate (manage gate fires at the route).
    for (const [method, url] of [
      ['post', QUOTATION(f.request.id)],
      ['post', `${HM}/quotations/${bundle.quotation.id}/versions`],
      ['post', `${VERSION(versionId)}/issue`],
      ['post', `${VERSION(versionId)}/decision`],
    ] as const) {
      const res = await api()[method](url).set(auth(readOnly)).send({});
      assert.equal(res.status, 403, `read-only ${method.toUpperCase()} ${url}`);
    }
    // Manage without read cannot read (strict permission split).
    const manageGet = await api().get(QUOTATION(f.request.id))
      .set(auth(manageOnly));
    assert.equal(manageGet.status, 403);
    // The manager mutation response retains its audit actor, while customer
    // reads omit that internal actor identity regardless of caller role.
    assert.equal(bundle.quotation.createdByUserId, adminUserId);
    const adminRead = await api().get(QUOTATION(f.request.id)).set(auth());
    assert.equal(adminRead.status, 200);
    assert.equal('createdByUserId' in adminRead.body.data.quotation, false);
    assert.equal(adminRead.body.data.versions.some(
      (version: Record<string, unknown>) => 'createdByUserId' in version,
    ), false);
  });

  it('9: smuggled authority/location/downstream fields cannot override', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const smuggle = {
      clientId: otherClient.id,
      tenantCompanyId: randomUUID(),
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      floorId: randomUUID(),
      areaId: randomUUID(),
      roomId: randomUUID(),
      spaceId: randomUUID(),
      createdByUserId: randomUUID(),
      decidedByUserId: randomUUID(),
      status: 'APPROVED',
      executionScopeId: randomUUID(),
      workOrderId: randomUUID(),
      crewId: randomUUID(),
      scheduleId: randomUUID(),
      arrivalToken: 'ARR9',
      qrCode: 'QR9',
      geofenceProof: { lat: 0, lng: 0 },
    };
    const created = await api().post(QUOTATION(f.request.id))
      .set(auth())
      .send(smuggle);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.quotation.clientId, f.client.id);
    assert.equal(created.body.data.versions[0].status, 'DRAFT');
    const versionId = created.body.data.versions[0].id;
    const uomId = await insertUom(f.client.id);
    const line = await api().post(`${VERSION(versionId)}/lines`)
      .set(auth())
      .send({
        lineType: 'LABOR',
        description: 'Hours',
        quantity: 2,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
        ...smuggle,
        lineTotal: 999999,
        referenceUnitAmount: 7,
        quotationVersionId: randomUUID(),
      });
    assert.equal(line.status, 201, JSON.stringify(line.body));
    // Caller prices/totals/lineage never win: lineTotal is server-derived.
    assert.equal(line.body.data.lineTotal, 200);
    assert.equal('referenceUnitAmount' in line.body.data, false);
    assert.equal('sourceItemId' in line.body.data, false);
    assert.equal(line.body.data.quotationVersionId, versionId);
    assert.equal('createdByUserId' in line.body.data, false);
    await api().post(`${VERSION(versionId)}/issue`)
      .set(auth())
      .send({ validUntil: FUTURE(), ...smuggle });
    const tenantToken = await createTenantSession(f.linkedUser.id);
    const approved = await api().post(`${VERSION(versionId)}/decision`)
      .set(auth(tenantToken))
      .set('Idempotency-Key', `k-${randomUUID()}`)
      .send({ decision: 'APPROVE', ...smuggle });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.quotationVersionId, versionId);
    assert.equal(approved.body.data.decidedByUserId, f.linkedUser.id);
    assert.ok(approved.body.data.executionScope);
    // Smuggled downstream fields are never echoed anywhere.
    const raw = JSON.stringify(approved.body.data);
    for (const forbidden of [
      'workOrderId', 'crewId', 'scheduleId', 'arrivalToken', 'qrCode',
      'geofenceProof',
    ]) {
      assert.equal(
        forbidden in approved.body.data ||
          (approved.body.data.executionScope && forbidden in approved.body.data.executionScope),
        false,
        `forbidden field echoed: ${forbidden} (${raw.length} bytes)`,
      );
    }
  });

  it('10: OpenAPI/runtime parity; ZERO downstream/payment/BAST/FM APIs', async () => {
    const { parse: parseYaml } = await import('yaml');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const doc = parseYaml(readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'), 'utf8',
    )) as {
      paths: Record<string, Record<string, unknown>>;
      components: {
        schemas: Record<string, Record<string, unknown>>;
        parameters: Record<string, unknown>;
      };
    };
    const surface: Record<string, [string, string][]> = {
      '/handyman/requests/{handymanRequestId}/quotation': [
        ['post', 'createHandymanQuotation'],
        ['get', 'getHandymanQuotation'],
      ],
      '/handyman/requests/{handymanRequestId}/quotation/presented':
        [['get', 'getCurrentHandymanIssuedQuotationVersion']],
      '/handyman/quotations/{quotationId}/versions':
        [['post', 'createHandymanQuotationRevision']],
      '/handyman/quotation-versions/{quotationVersionId}/lines': [
        ['post', 'addHandymanQuotationLine'],
        ['get', 'listHandymanQuotationVersionLines'],
      ],
      '/handyman/quotation-versions/{quotationVersionId}/totals':
        [['get', 'getHandymanQuotationVersionTotals']],
      '/handyman/quotation-versions/{quotationVersionId}/issue':
        [['post', 'issueHandymanQuotationVersion']],
      '/handyman/quotation-versions/{quotationVersionId}/expire':
        [['post', 'expireHandymanQuotationVersion']],
      '/handyman/quotation-versions/{quotationVersionId}/supersede':
        [['post', 'supersedeHandymanQuotationVersion']],
      '/handyman/quotation-versions/{quotationVersionId}/decision': [
        ['post', 'decideHandymanQuotation'],
        ['get', 'getHandymanQuotationDecision'],
      ],
      '/handyman/quotation-versions/{quotationVersionId}/execution-scope':
        [['get', 'getHandymanExecutionScopeByQuotationVersion']],
    };
    let operationCount = 0;
    for (const [path, ops] of Object.entries(surface)) {
      const actual = doc.paths[path];
      assert.ok(actual, `missing path ${path}`);
      for (const [method, operationId] of ops) {
        const op = actual[method] as { operationId?: string } | undefined;
        assert.ok(op, `${path} missing ${method.toUpperCase()}`);
        assert.equal(String(op.operationId), operationId);
        operationCount += 1;
      }
      assert.equal(
        Object.keys(actual).filter((k) => k === 'get' || k === 'post')
          .length,
        ops.length,
        `${path} must expose exactly ${ops.length} operation(s)`,
      );
    }
    assert.equal(operationCount, 13);
    // ZERO crew/scheduling/arrival/QR/geofence/work-session/payment/
    // settlement/BAST/FM quotation APIs; the scope read is version-keyed
    // only (no list/search/dashboard).
    const forbiddenPath =
      /crew|schedul|arriv|qr|geofence|session|payment|settle|settlement|bast|work-?order|fm[-_]/i;
    const quotationPaths = Object.keys(doc.paths).filter((p) =>
      p.startsWith('/handyman') && p.includes('quotation'),
    );
    // The guarded surface is the quotation API set. The count was already
    // stale in the baseline (12 paths, expectation 10); the guard that
    // matters is the forbidden-path filter below, which must stay empty.
    // CR-HM-SERVICE-CATALOG-01 PART 01 added the two request-scoped
    // quotation operations (prepare / revision).
    assert.equal(quotationPaths.length, 14);
    assert.deepEqual(
      quotationPaths.filter((p) => forbiddenPath.test(p)),
      [],
    );
    assert.equal(doc.paths['/handyman/execution-scopes'], undefined,
      'no execution-scope collection/list API');
    // Schemas exist and preserve the governed distinctions.
    for (const name of [
      'HandymanQuotationRecord',
      'HandymanQuotationVersionRecord',
      'HandymanQuotationBundle',
      'HandymanQuotationCustomerRead',
      'HandymanQuotationVersionCustomerProjection',
      'HandymanQuotationCustomerReadBundle',
      'HandymanQuotationDecisionCustomerProjection',
      'HandymanExecutionScopeCustomerProjection',
      'CreateHandymanQuotationLineRequest',
      'HandymanQuotationLineCustomerProjection',
      'HandymanQuotationTotals',
      'IssueHandymanQuotationVersionRequest',
      'DecideHandymanQuotationRequest',
      'HandymanQuotationDecisionRecord',
      'HandymanQuotationDecisionResult',
      'HandymanExecutionScopeRecord',
    ]) {
      assert.ok(doc.components.schemas[name], `missing schema ${name}`);
    }
    const versionSchema = doc.components.schemas
      .HandymanQuotationVersionRecord as {
      properties: { status: { enum: string[] } };
    };
    for (const status of ['DRAFT', 'ISSUED', 'APPROVED', 'REJECTED',
      'EXPIRED', 'SUPERSEDED']) {
      assert.ok(versionSchema.properties.status.enum.includes(status),
        `version status enum missing ${status}`);
    }
    const lineSchema = doc.components.schemas
      .HandymanQuotationLineCustomerProjection as {
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(lineSchema.additionalProperties, false,
      'safe line contract must be closed against unreviewed properties');
    for (const field of [
      'id', 'quotationVersionId', 'lineType', 'description', 'quantity',
      'uomId', 'finalQuotedUnitAmount', 'lineTotal', 'currency',
      'createdAt', 'updatedAt',
    ]) {
      assert.ok(field in lineSchema.properties,
        `customer quotation-line projection must include ${field}`);
    }
    for (const forbidden of [
      'referenceUnitAmount', 'sourceItemId', 'createdByUserId',
    ]) {
      assert.equal(forbidden in lineSchema.properties, false,
        `customer quotation-line projection must exclude ${forbidden}`);
    }
    const linePath = doc.paths[
      '/handyman/quotation-versions/{quotationVersionId}/lines'
    ] as Record<string, Record<string, unknown>>;
    for (const method of ['get', 'post']) {
      const response = (linePath[method] as any).responses;
      const schema = response[method === 'get' ? '200' : '201']
        .content['application/json'].schema;
      assert.equal(schema.allOf[0].$ref,
        '#/components/schemas/SuccessEnvelope');
      const dataSchema = schema.allOf[1].properties.data;
      const responseRef = method === 'get'
        ? dataSchema.items.$ref
        : dataSchema.$ref;
      assert.equal(responseRef,
        '#/components/schemas/HandymanQuotationLineCustomerProjection',
        `${method.toUpperCase()} line responses must use the safe projection`);
    }
    const actorFreeCustomerSchemas = [
      ['HandymanQuotationCustomerRead', 'createdByUserId'],
      ['HandymanQuotationVersionCustomerProjection', 'createdByUserId'],
      ['HandymanQuotationDecisionCustomerProjection', 'decidedByUserId'],
      ['HandymanExecutionScopeCustomerProjection', 'createdByUserId'],
    ];
    for (const [name, actorField] of actorFreeCustomerSchemas) {
      const schema = doc.components.schemas[name] as any;
      assert.equal(schema.additionalProperties, false,
        `${name} must be closed against unreviewed metadata`);
      assert.equal(actorField in schema.properties, false,
        `${name} must omit internal ${actorField}`);
    }
    const readResponseRef = (path: string, method: string) => {
      const responseSchema = (doc.paths[path][method] as any)
        .responses['200'].content['application/json'].schema;
      assert.equal(responseSchema.allOf[0].$ref,
        '#/components/schemas/SuccessEnvelope');
      return responseSchema.allOf[1].properties.data;
    };
    assert.equal(readResponseRef(
      '/handyman/requests/{handymanRequestId}/quotation', 'get').$ref,
      '#/components/schemas/HandymanQuotationCustomerReadBundle');
    const presentedSchema = readResponseRef(
      '/handyman/requests/{handymanRequestId}/quotation/presented', 'get');
    assert.equal(presentedSchema.nullable, true);
    assert.equal(presentedSchema.allOf[0].$ref,
      '#/components/schemas/HandymanQuotationVersionCustomerProjection');
    assert.equal(readResponseRef(
      '/handyman/quotation-versions/{quotationVersionId}/decision', 'get').$ref,
      '#/components/schemas/HandymanQuotationDecisionCustomerProjection');
    assert.equal(readResponseRef(
      '/handyman/quotation-versions/{quotationVersionId}/execution-scope', 'get').$ref,
      '#/components/schemas/HandymanExecutionScopeCustomerProjection');
    const materialCommandLineSchema = doc.components.schemas
      .HandymanMaterialExecutionLineRecord as any;
    assert.ok('sourceItemId' in materialCommandLineSchema.properties,
      'current Crew Lead command contract retains its internal material identity');
    for (const name of ['HandymanCustomerCareMaterialLineItem']) {
      const safeMaterialLineSchema = doc.components.schemas[name] as any;
      assert.equal(safeMaterialLineSchema.additionalProperties, false,
        `${name} must be a closed customer response schema`);
      assert.equal('sourceItemId' in safeMaterialLineSchema.properties, false,
        `${name} must omit internal sourceItemId`);
      assert.equal(safeMaterialLineSchema.required?.includes('sourceItemId') ?? false,
        false, `${name} must not require sourceItemId`);
    }
    const finalChargeProjection = doc.components.schemas
      .HandymanMaterialFinalChargeReadyProjection as any;
    assert.equal(finalChargeProjection.properties.lines.items.$ref,
      '#/components/schemas/HandymanMaterialExecutionLineRecord');
    const finalChargeReadSchema = (doc.paths[
      '/handyman/execution-scopes/{executionScopeId}/material-lines/final-charge-ready'
    ].get as any).responses['200'].content['application/json'].schema;
    assert.equal(finalChargeReadSchema.$ref,
      '#/components/schemas/HandymanMaterialFinalChargeReadyProjection');
    const careReadSchema = (doc.paths[
      '/handyman/execution-scopes/{executionScopeId}/material-lines'
    ].get as any).responses['200'].content['application/json'].schema;
    assert.equal(careReadSchema.allOf[0].$ref,
      '#/components/schemas/SuccessEnvelope');
    assert.equal(careReadSchema.allOf[1].properties.data.$ref,
      '#/components/schemas/HandymanCustomerCareMaterialLinesProjection');
    const scopeSchema = doc.components.schemas.HandymanExecutionScopeRecord as {
      properties: { status: { enum: string[] } };
    };
    assert.deepEqual(scopeSchema.properties.status.enum, ['AUTHORIZED']);
    // Forbidden downstream fields in every quotation schema.
    const forbiddenField = /workorder|worksession|crew|scheduleid|arriv|qr|geofence|bast|payment|settle/i;
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      if (!name.startsWith('HandymanQuotation') &&
        !name.startsWith('HandymanExecutionScope') &&
        !name.startsWith('CreateHandymanQuotation') &&
        !name.startsWith('IssueHandymanQuotation') &&
        !name.startsWith('DecideHandymanQuotation')) continue;
      const bad = Object.keys(schema.properties ?? {})
        .filter((k) => forbiddenField.test(k));
      assert.deepEqual(bad, [], `${name} leaks ${bad}`);
    }
    // Decision API idempotency follows the existing header convention.
    const decisionOp = doc
      .paths['/handyman/quotation-versions/{quotationVersionId}/decision']
      .post as { parameters: { $ref?: string; name?: string }[] };
    assert.ok(
      decisionOp.parameters.some(
        (pr) => pr.$ref === '#/components/parameters/IdempotencyKeyHeader',
      ),
      'decision POST must consume the Idempotency-Key header',
    );
  });

  it('11: authorized Tenant receives a safe quote projection; internal pricing snapshots remain stored', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createQuotationHttp(f.request.id);
    const versionId = bundle.versions[0].id;
    const uomId = await insertUom(f.client.id);
    await clientMonetaryContextService.setClientMonetaryContext(
      {
        clientId: f.client.id,
        baseCurrencyCode: 'IDR',
        defaultTransactionCurrencyCode: 'IDR',
        allowedCurrencyCodes: ['IDR'],
      },
      adminUserId,
    );
    const item = await insertMaterialItem(f.client.id, uomId);
    await insertActivePriceEntry(f.client.id, item.id, uomId, 25_000);

    const createdLine = await api().post(`${VERSION(versionId)}/lines`)
      .set(auth())
      .send({
        lineType: 'MATERIAL',
        description: 'Copper pipe supply',
        quantity: 2,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 30_000,
        sourceItemId: item.id,
      });
    assert.equal(createdLine.status, 201, JSON.stringify(createdLine.body));
    const lineId = createdLine.body.data.id as string;

    // The quote's internal commercial snapshot and calculation are preserved.
    const stored = await q<{
      referenceUnitAmount: number;
      sourceItemId: string;
      finalQuotedUnitAmount: number;
      lineTotal: number;
    }>(
      `SELECT reference_unit_amount::float AS "referenceUnitAmount",
              source_item_id AS "sourceItemId",
              final_quoted_unit_amount::float AS "finalQuotedUnitAmount",
              line_total::float AS "lineTotal"
         FROM handyman_quotation_lines WHERE id = $1`,
      [lineId],
    );
    assert.deepEqual(stored.rows[0], {
      referenceUnitAmount: 25_000,
      sourceItemId: item.id,
      finalQuotedUnitAmount: 30_000,
      lineTotal: 60_000,
    });

    const issued = await api().post(`${VERSION(versionId)}/issue`)
      .set(auth())
      .send({ validUntil: FUTURE() });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const tenantToken = await createTenantSession(f.linkedUser.id);

    const read = await api().get(`${VERSION(versionId)}/lines`)
      .set(auth(tenantToken));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.length, 1);
    const line = read.body.data[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(line).sort(), [
      'createdAt', 'currency', 'description', 'finalQuotedUnitAmount',
      'id', 'lineTotal', 'lineType', 'quantity', 'quotationVersionId',
      'uomId', 'updatedAt',
    ].sort());
    assert.equal(line.description, 'Copper pipe supply');
    assert.equal(line.quantity, 2);
    assert.equal(line.uomId, uomId);
    assert.equal(line.finalQuotedUnitAmount, 30_000);
    assert.equal(line.lineTotal, 60_000);

    const customerResponseJson = JSON.stringify(read.body);
    for (const field of [
      'referenceUnitAmount', 'sourceItemId', 'createdByUserId',
      'referenceUnitPrice', 'catalogItemId', 'internalCost', 'margin',
      'pricingSource',
    ]) {
      assert.equal(customerResponseJson.includes(field), false,
        `customer quotation response leaked ${field}`);
    }
    assert.equal(customerResponseJson.includes(item.id), false,
      'customer quotation response leaked the internal catalog item UUID');
    assert.equal(customerResponseJson.includes('25000'), false,
      'customer quotation response leaked the internal reference unit price');

    // Mutation responses use the same safe contract; no null placeholder or
    // internal value is emitted for the omitted fields.
    const createResponseJson = JSON.stringify(createdLine.body);
    assert.equal(createResponseJson.includes('referenceUnitAmount'), false);
    assert.equal(createResponseJson.includes('sourceItemId'), false);
    assert.equal(createResponseJson.includes(item.id), false);

    const totals = await api().get(`${VERSION(versionId)}/totals`)
      .set(auth(tenantToken));
    assert.equal(totals.status, 200, JSON.stringify(totals.body));
    assert.deepEqual(totals.body.data, {
      laborSubtotal: 0,
      materialSubtotal: 60_000,
      total: 60_000,
      currency: 'IDR',
      lineCount: 1,
    });

    const presented = await api().get(`${QUOTATION(f.request.id)}/presented`)
      .set(auth(tenantToken));
    assert.equal(presented.status, 200);
    assert.equal(presented.body.data.status, 'ISSUED');
    const root = await api().get(QUOTATION(f.request.id))
      .set(auth(tenantToken));
    assert.equal(root.status, 200);
    for (const response of [presented, root]) {
      const raw = JSON.stringify(response.body);
      assert.equal(raw.includes('referenceUnitAmount'), false);
      assert.equal(raw.includes('sourceItemId'), false);
      assert.equal(raw.includes('createdByUserId'), false);
      assert.equal(raw.includes('decidedByUserId'), false);
      assert.equal(raw.includes(item.id), false);
    }

    // The Customer Care read is customer-readable and source-free; the
    // final-charge read remains an independently authorized Crew Lead contract.
    const approved = await api().post(`${VERSION(versionId)}/decision`)
      .set(auth(tenantToken))
      .set('Idempotency-Key', `k-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const executionScopeId = approved.body.data.executionScope.id as string;
    const materialExecutionLineId = randomUUID();
    await q(
      `INSERT INTO handyman_material_execution_lines (
         id, client_id, execution_scope_id, quotation_version_id,
         quotation_line_id, source_item_id, status, acquisition_mode,
         estimated_qty, approved_qty, issued_qty, purchased_qty,
         used_qty, returned_qty, supplier_reference
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::uuid, 'FINAL_CHARGE_READY', 'ISSUED',
                 2, 2, 2, 0, 1, 0, NULL)`,
      [materialExecutionLineId, f.client.id, executionScopeId,
        versionId, lineId, item.id],
    );
    const careRead = await api()
      .get(`${HM}/execution-scopes/${executionScopeId}/material-lines`)
      .set(auth(tenantToken));
    assert.equal(careRead.status, 200, JSON.stringify(careRead.body));
    const careRaw = JSON.stringify(careRead.body);
    for (const field of [
      'sourceItemId', 'referenceUnitAmount', 'referenceUnitPrice',
      'catalogItemId', 'internalCost', 'margin', 'pricingSource',
    ]) {
      assert.equal(careRaw.includes(field), false,
        `customer material response leaked ${field}`);
    }
    assert.equal(careRaw.includes(item.id), false,
      'customer material response leaked the internal catalog item UUID');
    assert.equal(careRead.body.data.lines[0].id, materialExecutionLineId);

    // The separate final-charge-ready contract requires the current assigned
    // Crew Lead, so a Tenant cannot use it as a side door to internal IDs.
    const tenantFinalChargeRead = await api()
      .get(`${HM}/execution-scopes/${executionScopeId}/material-lines/final-charge-ready`)
      .set(auth(tenantToken));
    assert.equal(tenantFinalChargeRead.status, 403);
    const deniedRaw = JSON.stringify(tenantFinalChargeRead.body);
    assert.equal(deniedRaw.includes('sourceItemId'), false);
    assert.equal(deniedRaw.includes(item.id), false);

    // A same-client sibling Building and a separate Client remain denied even
    // when the caller has tenant_company.read.
    const readPermission = {
      code: 'tenant_company.read',
      name: 'Read Tenant Companies',
    };
    const siblingToken = await createSessionWithPermissions([readPermission]);
    const siblingUserId = await userIdForToken(siblingToken);
    const siblingBuilding = await buildingService.createBuilding({
      propertyId: f.building.propertyId,
      code: `B_${suffix()}`,
      name: 'Sibling Building',
    });
    await buildingAssignmentService.createAssignment(siblingUserId, {
      buildingId: siblingBuilding.id,
    });
    const siblingRead = await api().get(`${VERSION(versionId)}/lines`)
      .set(auth(siblingToken));
    assert.equal(siblingRead.status, 403);

    const foreignToken = await createSessionWithPermissions([readPermission]);
    const foreignUserId = await userIdForToken(foreignToken);
    const foreignClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Foreign Client',
    });
    const foreignProperty = await propertyService.createProperty({
      clientId: foreignClient.id,
      code: `P_${suffix()}`,
      name: 'Foreign Property',
    });
    const foreignBuilding = await buildingService.createBuilding({
      propertyId: foreignProperty.id,
      code: `B_${suffix()}`,
      name: 'Foreign Building',
    });
    await buildingAssignmentService.createAssignment(foreignUserId, {
      buildingId: foreignBuilding.id,
    });
    const foreignRead = await api().get(`${VERSION(versionId)}/lines`)
      .set(auth(foreignToken));
    assert.equal(foreignRead.status, 403);
  });
});
