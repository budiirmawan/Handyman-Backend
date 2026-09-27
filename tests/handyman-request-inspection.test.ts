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
  handymanServiceRequestInspectionService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import type { CreateHandymanInspectionInput } from '../src/modules/handyman-requests';
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
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-03 PART 02 — focused tests for the Handyman inspection record.
 *
 * Ten cases prove the bounded INSPECTION_REQUIRED → DIAGNOSIS transition,
 * structured result + notes persistence, source-state/actor/context guards,
 * atomic record+projection+journal commit, no-partial-commit behavior,
 * DB-level append-only immutability, frozen F3 (evidence rows untouched),
 * and zero FM/tenant-service-request/work-order/vendor-quotation effects.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    service_catalog, evidence_submissions, operational_events,
    tenant_service_requests, work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
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

async function serviceEntry(clientId: string) {
  return serviceCatalogService.createServiceCatalogEntry({
    clientId,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
}

/** Request carried to INSPECTION_REQUIRED via the PART 01 triage chain. */
async function inspectionFixture() {
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
      triageNote: 'Requires on-site inspection.',
    },
    adminUserId,
  );
  return { ...f, service, request };
}

describe('CR-HM-03 PART 02 — inspection record', () => {
  it('1: INSPECTION_REQUIRED → DIAGNOSIS succeeds', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const record = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Ceiling cavity inspected from ceiling void.',
        },
        adminUserId,
      );
    assert.ok(record.id);
    assert.equal(record.handymanRequestId, f.request.id);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'DIAGNOSIS');
  });

  it('2: record persists structured result + notes + verbatim request snapshot', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const record = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: '  Pipe joint visibly cracked at elbow.  ',
        },
        adminUserId,
      );
    assert.equal(record.inspectionResult, 'INSPECTED');
    assert.equal(record.inspectionNotes, 'Pipe joint visibly cracked at elbow.');
    assert.equal(record.inspectedByUserId, adminUserId);
    assert.equal(record.clientId, f.client.id);
    assert.equal(record.channelAttributionId, f.attribution.id);
    assert.equal(record.buildingId, f.building.id);
    assert.ok(!Number.isNaN(Date.parse(record.inspectedAt)));
    const rows = await q(
      `SELECT inspection_result, inspection_notes, client_id, building_id
         FROM handyman_request_inspections WHERE id = $1`,
      [record.id],
    );
    assert.equal(rows.rows[0].inspection_result, 'INSPECTED');
    assert.equal(rows.rows[0].inspection_notes, 'Pipe joint visibly cracked at elbow.');
    assert.equal(rows.rows[0].client_id, f.client.id);
    assert.equal(rows.rows[0].building_id, f.building.id);
    // the diagnosis-free record guard: no classification/spec target exists
    assert.deepEqual(Object.keys(record).sort(), [
      'buildingId', 'channelAttributionId', 'clientId', 'handymanRequestId',
      'id', 'inspectedAt', 'inspectedByUserId', 'inspectionNotes',
      'inspectionResult',
    ]);
  });

  it('3: wrong source state is rejected (INTAKE and already-DIAGNOSIS)', async (t) => {
    if (!requireDatabase(t)) return;
    // (a) INTAKE: no triage performed yet
    const fa = await attributedFixture();
    const serviceA = await serviceEntry(fa.client.id);
    const intakeRequest = await handymanServiceRequestService
      .createHandymanServiceRequest(
        {
          channelAttributionId: fa.attribution.id,
          serviceCatalogId: serviceA.id,
        },
        adminUserId,
      );
    assert.equal(intakeRequest.status, 'INTAKE');
    await assert.rejects(
      handymanServiceRequestInspectionService.recordHandymanInspection(
        {
          handymanRequestId: intakeRequest.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Attempt from INTAKE.',
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SERVICE_REQUEST_NOT_INSPECTION_REQUIRED',
    );
    // (b) DIAGNOSIS reached via a straight triage disposition (no inspection routed)
    const f2 = await attributedFixture();
    const service2 = await serviceEntry(f2.client.id);
    const request2 = await handymanServiceRequestService
      .createHandymanServiceRequest(
        {
          channelAttributionId: f2.attribution.id,
          serviceCatalogId: service2.id,
        },
        adminUserId,
      );
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: request2.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Direct diagnosis path.',
      },
      adminUserId,
    );
    await assert.rejects(
      handymanServiceRequestInspectionService.recordHandymanInspection(
        {
          handymanRequestId: request2.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Attempt after direct DIAGNOSIS.',
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SERVICE_REQUEST_NOT_INSPECTION_REQUIRED',
    );
    // (c) second inspection on an already-inspected request conflicts
    const f3 = await inspectionFixture();
    await handymanServiceRequestInspectionService.recordHandymanInspection(
      {
        handymanRequestId: f3.request.id,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'First valid inspection.',
      },
      adminUserId,
    );
    const pre = await tableCount('handyman_request_inspections');
    // the F1 chain already advanced to DIAGNOSIS ⇒ fail-closed at the source
    // gate; concurrent racers converge on the UNIQUE's race-safe 409 contract
    await assert.rejects(
      handymanServiceRequestInspectionService.recordHandymanInspection(
        {
          handymanRequestId: f3.request.id,
          inspectionResult: 'NOT_INSPECTABLE',
          inspectionNotes: 'Second attempt must fail closed.',
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SERVICE_REQUEST_NOT_INSPECTION_REQUIRED',
    );
    assert.equal(await tableCount('handyman_request_inspections'), pre);
  });

  it('4: inspector identity persisted from the explicit local user', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const record = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'NOT_INSPECTABLE',
          inspectionNotes: 'Roof not safely accessible today.',
        },
        adminUserId,
      );
    assert.equal(record.inspectedByUserId, adminUserId);
    const journal = await q(
      `SELECT actor_user_id, event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST'
          AND entity_id = $1
          AND event_type = 'HANDYMAN_INSPECTION_RECORDED'`,
      [f.request.id],
    );
    assert.equal(journal.rowCount, 1);
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
  });

  it('5: caller context smuggle cannot override the request context snapshot', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const other = await attributedFixture();
    const smuggled = {
      handymanRequestId: f.request.id,
      inspectionResult: 'INSPECTED',
      inspectionNotes: 'Context must stay request-derived.',
      clientId: other.client.id,
      buildingId: other.building.id,
      spaceId: other.space.id,
      tenantCompanyId: other.company.id,
      channelAttributionId: other.attribution.id,
      inspectedByUserId: other.linkedUser.id,
    } as unknown as CreateHandymanInspectionInput;
    const record = await handymanServiceRequestInspectionService
      .recordHandymanInspection(smuggled, adminUserId);
    assert.equal(record.clientId, f.client.id);
    assert.equal(record.buildingId, f.building.id);
    assert.equal(record.channelAttributionId, f.attribution.id);
    assert.equal(record.inspectedByUserId, adminUserId);
    assert.notEqual(record.inspectedByUserId, other.linkedUser.id);
  });

  it('6: inspection record + status projection + journal commit atomically', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const beforeRecords = await tableCount('handyman_request_inspections');
    const beforeEvents = await tableCount('operational_events');
    const record = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Atomic happy path.',
        },
        adminUserId,
      );
    assert.equal(
      await tableCount('handyman_request_inspections'),
      beforeRecords + 1,
    );
    assert.equal(await tableCount('operational_events'), beforeEvents + 1);
    const request = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(request.rows[0].status, 'DIAGNOSIS');
    const journal = await q(
      `SELECT event_type, entity_type, entity_id, actor_user_id, metadata
         FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1
        ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
      [f.request.id],
    );
    assert.equal(journal.rows[0].event_type, 'HANDYMAN_INSPECTION_RECORDED');
    assert.equal(journal.rows[0].entity_id, f.request.id);
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
    assert.equal(journal.rows[0].metadata.inspectionId, record.id);
    assert.equal(journal.rows[0].metadata.inspectionResult, 'INSPECTED');
    assert.deepEqual(
      Object.keys(journal.rows[0].metadata).sort(),
      ['inspectionId', 'inspectionResult'],
    );
  });

  it('7: forced service failure leaves no partial inspection/status/journal', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const beforeRecords = await tableCount('handyman_request_inspections');
    const beforeEvents = await tableCount('operational_events');
    // Access gate failure (valid UUID, inexistent user) rejects the whole
    // attempt; the t7 invariant mirrors PART 01: any failure path resolves
    // through the same withTransaction catch → ROLLBACK, so no partial row,
    // no projection, no journal can persist.
    await assert.rejects(
      handymanServiceRequestInspectionService.recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Forced failure at the realm gate.',
        },
        randomUUID(),
      ),
    );
    assert.equal(
      await tableCount('handyman_request_inspections'),
      beforeRecords,
    );
    assert.equal(await tableCount('operational_events'), beforeEvents);
    const request = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(request.rows[0].status, 'INSPECTION_REQUIRED');
  });

  it('8: inspection record is append-only — UPDATE/DELETE are refused', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const record = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Original inspection outcome.',
        },
        adminUserId,
      );
    // record/get are the only service seams — no mutation surface exists
    assert.deepEqual(
      Object.keys(handymanServiceRequestInspectionService).sort(),
      ['getHandymanRequestInspection', 'recordHandymanInspection'],
    );
    await assert.rejects(
      q(
        `UPDATE handyman_request_inspections
            SET inspection_notes = 'tampered' WHERE id = $1`,
        [record.id],
      ),
    );
    await assert.rejects(
      q(
        'DELETE FROM handyman_request_inspections WHERE id = $1',
        [record.id],
      ),
    );
    const persisted = await q(
      'SELECT inspection_notes FROM handyman_request_inspections WHERE id = $1',
      [record.id],
    );
    assert.equal(
      persisted.rows[0].inspection_notes,
      'Original inspection outcome.',
    );
  });

  it('9: FROZEN F3 — inspection records zero evidence rows and does not touch evidence', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const beforeEvidence = await tableCount('evidence_submissions');
    await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Not an evidence step.',
        },
        adminUserId,
      );
    assert.equal(await tableCount('evidence_submissions'), beforeEvidence);
  });

  it('10: no FM/tenant-service-request/work-order/quotation side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionFixture();
    const tables = [
      'tenant_service_requests',
      'work_requests',
      'work_orders',
      'vendor_quotations',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (name) => [name, await tableCount(name)])),
    );
    await handymanServiceRequestInspectionService.recordHandymanInspection(
      {
        handymanRequestId: f.request.id,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Side effects stay at zero.',
      },
      adminUserId,
    );
    for (const name of tables) {
      assert.equal(await tableCount(name), before[name], `${name} unchanged`);
    }
    const	request = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(request.rows[0].status, 'DIAGNOSIS');
  });
});
