import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  handymanDisciplineRepository,
  handymanDisciplineService,
} from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestInspectionService,
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
import { createAdminUser } from './helpers/access';
import {
  createHandymanQuotation,
  createHandymanQuotationRevision,
  getHandymanQuotation,
} from '../src/modules/handyman-quotations';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-06 PART 01 — focused tests for the Handyman quotation
 * foundation + immutable versions (FROZEN Decision Freeze F1-F5).
 *
 * Ten cases prove: a quotation thread can be created from a valid
 * diagnosed request; the first version is 1/DRAFT; client/request
 * lineage is server-derived; caller smuggling cannot override lineage;
 * missing/invalid requests are rejected; requests without quotation-
 * sufficient diagnosis/scope are rejected; revisions append monotonic
 * DRAFT versions; prior versions stay byte-ish identical with DB
 * immutability backstops; concurrent revision allocation can never
 * duplicate a version number; and ZERO FM/vendor/execution-scope/
 * payment/BAST side effects occur.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keepRef = () => ({ handymanServiceRequestInspectionService });

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineIds: Record<string, string> = {};
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_service_variants, handyman_discipline_service_associations,
    service_catalog, evidence_submissions, operational_events,
    tenant_service_requests, work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  for (const code of [
    'SIMPLE_PLUMBING', 'FURNITURE', 'MINOR_CIVIL', 'GENERAL_HANDYMAN',
    'ELECTRICAL', 'AC', 'FM_COMMON_BUILDING',
  ]) {
    const d = await handymanDisciplineRepository.findDisciplineByCode(undefined, code);
    if (!d) throw new Error(`F9 discipline seed missing: ${code}`);
    disciplineIds[code] = d.id;
  }
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

async function tableCount(name: string): Promise<number> {
  const result = await q(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

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

async function serviceEntry(clientId: string, category = 'FM_HINT_TEXT') {
  return serviceCatalogService.createServiceCatalogEntry({
    clientId,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category,
  }, adminUserId);
}

async function requestInDiagnosis(fixture: Awaited<ReturnType<typeof attributedFixture>>) {
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: fixture.attribution.id,
        serviceCatalogId: fixture.service.id,
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
  return request;
}

async function directDiagnosisFixture() {
  const f = await attributedFixture();
  const service = await serviceEntry(f.client.id);
  const request = await requestInDiagnosis({ ...f, service });
  return { ...f, service, request };
}

type _Unused = typeof handymanServiceRequestInspectionService;
async function _inspectedDiagnosisFixture() {
  const f = await attributedFixture();
  const service = await serviceEntry(f.client.id);
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
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: 'Needs site inspection.',
    },
    adminUserId,
  );
  await handymanServiceRequestInspectionService.recordHandymanInspection(
    {
      handymanRequestId: request.id,
      inspectionResult: 'INSPECTED',
      inspectionNotes: 'Inspected on site.',
    },
    adminUserId,
  );
  const after = await q(
    'SELECT status FROM handyman_service_requests WHERE id = $1',
    [request.id],
  );
  assert.equal(after.rows[0].status, 'DIAGNOSIS');
  return { ...f, service, request };
}

/** Full chain: request + diagnosis recorded -> READY_FOR_NEXT_STEP. */
async function diagnosedFixture(code: 'GENERAL_HANDYMAN' | 'FM_COMMON_BUILDING' =
  'GENERAL_HANDYMAN') {
  const f = await directDiagnosisFixture();
  const testDiagnosis = await handymanServiceRequestDiagnosisService
    .recordHandymanDiagnosis(
      {
        handymanRequestId: f.request.id,
        disciplineId: disciplineIds[code],
        diagnosis: 'Fixture diagnosis for quotation tests.',
      },
      adminUserId,
    );
  return { ...f, diagnosis: testDiagnosis };
}
describe('CR-HM-06 PART 01 — quotation foundation + immutable versions', () => {
  it('1: create quotation from valid Handyman request + diagnosis', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    assert.equal(bundle.quotation.handymanRequestId, f.request.id);
    assert.equal(bundle.quotation.clientId, f.client.id);
    assert.equal(bundle.quotation.createdByUserId, adminUserId);
    assert.equal(bundle.versions.length, 1);
  });

  it('2: first version = 1 + DRAFT', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    assert.equal(bundle.versions[0].versionNumber, 1);
    assert.equal(bundle.versions[0].status, 'DRAFT');
    assert.equal(bundle.versions[0].validUntil, null);
    assert.equal(bundle.versions[0].quotationId, bundle.quotation.id);
  });

  it('3: client/request lineage server-derived', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    const row = await q(
      `SELECT client_id, handyman_request_id, created_by_user_id
         FROM handyman_quotations WHERE id = $1`,
      [bundle.quotation.id],
    );
    assert.equal(row.rows[0].client_id, f.client.id);
    assert.equal(row.rows[0].handyman_request_id, f.request.id);
    assert.equal(row.rows[0].created_by_user_id, adminUserId);
  });

  it('4: caller authority smuggling cannot override lineage', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const otherClient = await clientService.createClient({
      code: `X_${suffix()}`,
      name: 'Foreign Client',
    });
    const smuggled = {
      handymanRequestId: f.request.id,
      clientId: otherClient.id,
      buildingId: randomUUID(),
      channelAttributionId: randomUUID(),
      tenantPicId: randomUUID(),
      scopeClassification: 'SPECIALIST',
      diagnosis: 'override attempt',
      customerUserId: randomUUID(),
    } as unknown as Parameters<typeof createHandymanQuotation>[0];
    const bundle = await createHandymanQuotation(smuggled, adminUserId);
    assert.equal(bundle.quotation.clientId, f.client.id);
    assert.equal(bundle.quotation.handymanRequestId, f.request.id);
    assert.equal(bundle.quotation.createdByUserId, adminUserId);
    assert.equal('buildingId' in bundle.quotation, false);
  });

  it('5: missing/invalid request rejected', async (t) => {
    if (!requireDatabase(t)) return;
    await assert.rejects(
      createHandymanQuotation(
        { handymanRequestId: randomUUID() },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_SERVICE_REQUEST_NOT_FOUND',
    );
    await assert.rejects(
      createHandymanQuotation(
        { handymanRequestId: 'not-a-uuid' },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'VALIDATION_ERROR',
    );
  });

  it('6: request without required diagnosis/scope rejected', async (t) => {
    if (!requireDatabase(t)) return;
    // In DIAGNOSIS but not yet diagnosed.
    const f = await directDiagnosisFixture();
    await assert.rejects(
      createHandymanQuotation(
        { handymanRequestId: f.request.id },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_DIAGNOSIS_REQUIRED',
    );
    // Diagnosed but OUT_OF_HANDYMAN_SCOPE → never quotable.
    const g = await diagnosedFixture('FM_COMMON_BUILDING');
    assert.equal(g.diagnosis.scopeClassification, 'OUT_OF_HANDYMAN_SCOPE');
    await assert.rejects(
      createHandymanQuotation(
        { handymanRequestId: g.request.id },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_QUOTATION_SCOPE_INSUFFICIENT',
    );
  });

  it('7: create revision produces version 2 DRAFT', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    const v2 = await createHandymanQuotationRevision(
      bundle.quotation.id,
      adminUserId,
    );
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.status, 'DRAFT');
    assert.equal(v2.quotationId, bundle.quotation.id);
    const read = await getHandymanQuotation(f.request.id, adminUserId);
    assert.deepEqual(
      read.versions.map((v) => v.versionNumber),
      [1, 2],
    );
    assert.equal(read.versions[0].status, 'DRAFT');
  });

  it('8: previous version remains unchanged + DB immutability backstop', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    const before = await q(
      `SELECT id, quotation_id, version_number, status, valid_until,
              created_by_user_id, created_at, updated_at
         FROM handyman_quotation_versions
        WHERE id = $1`,
      [bundle.versions[0].id],
    );
    const v2 = await createHandymanQuotationRevision(
      bundle.quotation.id,
      adminUserId,
    );
    assert.ok(v2.versionNumber === 2);
    const after = await q(
      `SELECT id, quotation_id, version_number, status, valid_until,
              created_by_user_id, created_at, updated_at
         FROM handyman_quotation_versions
        WHERE id = $1`,
      [bundle.versions[0].id],
    );
    assert.deepEqual(after.rows, before.rows);
    // Trigger backstop: version facts can never be rewritten/deleted.
    await assert.rejects(
      q(
        `UPDATE handyman_quotation_versions
            SET version_number = 99 WHERE id = $1`,
        [bundle.versions[0].id],
      ),
    );
    await assert.rejects(
      q(
        `DELETE FROM handyman_quotation_versions WHERE id = $1`,
        [bundle.versions[0].id],
      ),
    );
    await assert.rejects(
      q(
        `UPDATE handyman_quotations SET client_id = client_id || ' '
          WHERE id = $1`,
        [bundle.quotation.id],
      ),
    );
    const intact = await q(
      'SELECT count(*)::int AS n FROM handyman_quotation_versions WHERE quotation_id = $1',
      [bundle.quotation.id],
    );
    assert.equal(intact.rows[0].n, 2);
  });

  it('9: concurrent/duplicate revision cannot duplicate version number', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const bundle = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        createHandymanQuotationRevision(bundle.quotation.id, adminUserId),
      ),
    );
    const numbers = results.map((r) => r.versionNumber).sort();
    assert.deepEqual(numbers, [2, 3, 4]);
    assert.equal(new Set(numbers).size, 3);
    const rows = await q(
      `SELECT version_number FROM handyman_quotation_versions
        WHERE quotation_id = $1 ORDER BY version_number`,
      [bundle.quotation.id],
    );
    assert.deepEqual(
      rows.rows.map((r) => r.version_number),
      [1, 2, 3, 4],
    );
    // duplicate first creation is a safe-to-retry conflict
    await assert.rejects(
      createHandymanQuotation(
        { handymanRequestId: f.request.id },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_ALREADY_EXISTS',
    );
  });

  it('10: zero FM/vendor/execution-scope/payment/BAST side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const before = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      referrals: await tableCount('handyman_request_referrals'),
    };
    const bundle = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    const v2 = await createHandymanQuotationRevision(
      bundle.quotation.id,
      adminUserId,
    );
    assert.ok(v2);
    const after = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      referrals: await tableCount('handyman_request_referrals'),
    };
    assert.deepEqual(after, before);
    // Journal rows exist but carry only quotation metadata (audit-only).
    const events = await q(
      `SELECT event_type, entity_type, metadata
         FROM operational_events
        WHERE metadata->>'quotationId' = $1`,
      [bundle.quotation.id],
    );
    assert.equal(events.rows.length, 2);
    for (const row of events.rows) {
      assert.equal(row.event_type, 'HANDYMAN_QUOTATION_VERSION_CREATED');
      assert.equal(row.entity_type, 'HANDYMAN_QUOTATION');
      assert.equal(row.metadata.handymanRequestId, f.request.id);
      assert.equal('workOrderId' in row.metadata, false);
      assert.equal('vendorQuotationId' in row.metadata, false);
    }
  });
});
