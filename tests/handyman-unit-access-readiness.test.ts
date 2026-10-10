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
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { handymanUnitAccessReadinessService } from '../src/modules/handyman-scheduling';
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
 * CR-HM-05 PART 02 — focused tests for Handyman Unit Access Readiness
 * (FROZEN containment F5/F6/F7/F8/F9/F10).
 *
 * Ten cases prove: access-readiness creation is server-derived
 * (client/building/unit-space chain from the authoritative request +
 * masters), windows are validated, one-ACTIVE-per-request + supersede
 * history holds, cross-client requests are denied, smuggled authority
 * (client/location/QR/crew/authorizer) is structurally ignored,
 * mutation + journal are atomic, and ZERO arrival/QR/geofence/
 * attendance/session/permit/FM side effects occur. Real migrated
 * PostgreSQL.
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
  await pool.query(`TRUNCATE handyman_unit_access_readiness, handyman_scheduling_readiness,
    handyman_crew_leads, handyman_crew_memberships, handyman_work_crews,
    handyman_worker_contexts, handyman_provider_contexts,
    handyman_request_referrals, handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_service_variants, service_catalog,
    attendance_records, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    vendor_workforce_bindings, vendors, workforce_profiles,
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

const START = '2030-01-05T09:00:00.000Z';
const END = '2030-01-05T13:00:00.000Z';
const START2 = '2030-01-06T10:00:00.000Z';
const END2 = '2030-01-06T12:00:00.000Z';

/** Full tenant context + attribution (+ request), building tz-controlled. */
async function requestFixture(buildingTimezone: string | null = 'Asia/Jakarta') {
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
    timezone: buildingTimezone,
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
    email: `sched-${suffix().toLowerCase()}@example.com`,
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
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
        description: 'AC dripping in unit.',
      },
      adminUserId,
    );
  return { client, building, floor, area, room, space, company, attribution, request };
}

describe('CR-HM-05 PART 02 — unit access readiness', () => {
  const NOTE = 'Gate pass authorized for unit access window.';
  const NOTE2 = 'Access re-authorized: window moved.';

  it('1: valid request/location → ACTIVE access readiness created', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const row = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: NOTE,
        },
        adminUserId,
      );
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.handymanRequestId, f.request.id);
    assert.equal(row.authorizedByUserId, adminUserId);
    assert.equal(row.authorizationNote, NOTE);
    // NOT arrival verification: no presence/proof fields
    const raw = row as unknown as Record<string, unknown>;
    for (const k of [
      'arrivedAt', 'checkedInAt', 'verifiedAt', 'verificationOutcome',
      'qrChallengeCode', 'geofenceResult', 'riskScore', 'onSite',
      'workStartedAt', 'attendanceId', 'permitId',
    ]) {
      assert.equal(k in raw, false, `presence/proof field leaked: ${k}`);
    }
  });

  it('2: client/building/unit-space + full chain server-derived', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const row = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: NOTE,
        },
        adminUserId,
      );
    assert.equal(row.clientId, f.client.id);
    assert.equal(row.buildingId, f.building.id);
    assert.equal(row.spaceId, f.space.id);
    assert.equal(row.roomId, f.room.id);
    assert.equal(row.areaId, f.area.id);
    assert.equal(row.floorId, f.floor.id);
  });

  it('3: caller redirection to another building/unit ignored; space-less request rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const otherBuildingSpace = randomUUID();
    const smuggled = {
      handymanRequestId: f.request.id,
      accessWindowStart: START,
      accessWindowEnd: END,
      authorizationNote: NOTE,
      buildingId: randomUUID(),
      spaceId: otherBuildingSpace,
      floorId: randomUUID(),
      roomId: randomUUID(),
    } as unknown as Parameters<
      typeof handymanUnitAccessReadinessService
        .createHandymanUnitAccessReadiness
    >[0];
    const row = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(smuggled, adminUserId);
    assert.equal(row.buildingId, f.building.id);
    assert.equal(row.spaceId, f.space.id);
    // a request chain with NO authoritative unit/space is a bounded
    // rejection — never an invented location: build a raw request
    // without space (attribution without spaceId)
    const f2 = await requestFixture();
    await q(`UPDATE handyman_service_requests SET space_id = NULL
             WHERE id = $1`, [f2.request.id]);
    await assert.rejects(
      handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f2.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: NOTE,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) ===
        'HANDYMAN_UNIT_ACCESS_READINESS_UNIT_SPACE_UNAVAILABLE',
    );
  });

  it('4: invalid / zero / reversed access window rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const before = await tableCount('handyman_unit_access_readiness');
    for (const [s, e] of [
      [END, START],
      [START, START],
      ['not-a-date', END],
    ]) {
      await assert.rejects(
        handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
          {
            handymanRequestId: f.request.id,
            accessWindowStart: s,
            accessWindowEnd: e,
            authorizationNote: NOTE,
          },
          adminUserId,
        ),
        (err: unknown) =>
          errorCode(err) === 'HANDYMAN_UNIT_ACCESS_READINESS_WINDOW_INVALID',
      );
    }
    assert.equal(await tableCount('handyman_unit_access_readiness'), before);
  });

  it('5: duplicate ACTIVE readiness rejected (one current per request)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const before = await tableCount('handyman_unit_access_readiness');
    await handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
      {
        handymanRequestId: f.request.id,
        accessWindowStart: START,
        accessWindowEnd: END,
        authorizationNote: NOTE,
      },
      adminUserId,
    );
    await assert.rejects(
      handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START2,
          accessWindowEnd: END2,
          authorizationNote: NOTE,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_UNIT_ACCESS_READINESS_ALREADY_EXISTS',
    );
    assert.equal(
      await tableCount('handyman_unit_access_readiness'), before + 1);
  });

  it('6: authorization/readiness change supersedes rows; history preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const first = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: NOTE,
        },
        adminUserId,
      );
    const second = await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        first.id,
        { accessWindowStart: START2, accessWindowEnd: END2,
          authorizationNote: NOTE2 },
        adminUserId,
      );
    assert.equal(second.status, 'ACTIVE');
    assert.equal(second.authorizationNote, NOTE2);
    const read = await handymanUnitAccessReadinessService
      .getHandymanUnitAccessReadiness(f.request.id, adminUserId);
    assert.equal(read.history.length, 2);
    assert.equal(
      read.history.find((r) => r.id === first.id)?.status, 'INACTIVE');
    assert.equal(read.current?.id, second.id);
    await assert.rejects(
      handymanUnitAccessReadinessService
        .supersedeHandymanUnitAccessReadiness(
          first.id,
          { accessWindowStart: START, accessWindowEnd: END,
            authorizationNote: NOTE },
          adminUserId,
        ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_UNIT_ACCESS_READINESS_INVALID_STATUS',
    );
  });

  it('7: inaccessible request scope (caller without client access) rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const outsider = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });
    const before = await tableCount('handyman_unit_access_readiness');
    await assert.rejects(
      handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: NOTE,
        },
        outsider.id,
      ),
      (e: unknown) => errorCode(e) === 'BUILDING_ACCESS_DENIED',
    );
    assert.equal(await tableCount('handyman_unit_access_readiness'), before);
  });

  it('8: actor/client/location/QR/crew smuggling cannot become authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const smuggled = {
      handymanRequestId: f.request.id,
      accessWindowStart: START,
      accessWindowEnd: END,
      authorizationNote: NOTE,
      clientId: otherClient.id,
      buildingId: randomUUID(),
      spaceId: randomUUID(),
      authorizedByUserId: randomUUID(),
      actorUserId: randomUUID(),
      qrToken: 'QR123',
      geofenceProof: { lat: 0, lng: 0 },
      handymanCrewId: randomUUID(),
      handymanProviderContextId: randomUUID(),
      permitId: randomUUID(),
      workOrderId: randomUUID(),
    } as unknown as Parameters<
      typeof handymanUnitAccessReadinessService
        .createHandymanUnitAccessReadiness
    >[0];
    const row = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(smuggled, adminUserId);
    assert.equal(row.clientId, f.client.id);
    assert.equal(row.buildingId, f.building.id);
    assert.equal(row.spaceId, f.space.id);
    assert.equal(row.authorizedByUserId, adminUserId);
  });

  it('9: mutation + journal atomic (failure = zero partial commits)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: NOTE,
        },
        adminUserId,
      );
    const beforeRows = await tableCount('handyman_unit_access_readiness');
    const beforeEv = await tableCount('operational_events');
    await assert.rejects(
      handymanUnitAccessReadinessService
        .supersedeHandymanUnitAccessReadiness(
          created.id,
          { accessWindowStart: END, accessWindowEnd: START,
            authorizationNote: NOTE },
          adminUserId,
        ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_UNIT_ACCESS_READINESS_WINDOW_INVALID',
    );
    await assert.rejects(
      handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START2,
          accessWindowEnd: END2,
          authorizationNote: NOTE,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_UNIT_ACCESS_READINESS_ALREADY_EXISTS',
    );
    assert.equal(
      await tableCount('handyman_unit_access_readiness'), beforeRows);
    assert.equal(await tableCount('operational_events'), beforeEv);
    await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        created.id,
        { accessWindowStart: START2, accessWindowEnd: END2,
          authorizationNote: NOTE2 },
        adminUserId,
      );
    assert.equal(
      await tableCount('handyman_unit_access_readiness'), beforeRows + 1);
    assert.equal(await tableCount('operational_events'), beforeEv + 2);
    // W01 PART 04: order-independent journal assertion. operational_events
    // created_at defaults to NOW() (transaction start), so CREATED/SUPERSEDED
    // written in one transaction tie and an ORDER BY id tie-break is random.
    // Assert the same event types, the entity references, and the supersession
    // link instead of the sequence.
    const events = await q(
      `SELECT event_type, entity_id, metadata FROM operational_events
       WHERE entity_type = 'HANDYMAN_UNIT_ACCESS_READINESS'
         AND metadata->>'handymanRequestId' = $1`,
      [f.request.id],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_type).sort(),
      [
        'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
        'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
        'HANDYMAN_UNIT_ACCESS_READINESS_SUPERSEDED',
      ].sort(),
    );
    const supersededEvents = events.rows.filter(
      (r) => r.event_type === 'HANDYMAN_UNIT_ACCESS_READINESS_SUPERSEDED');
    assert.equal(supersededEvents.length, 1);
    assert.equal(supersededEvents[0].entity_id, created.id);
    const createdEntityIds = events.rows
      .filter((r) => r.event_type === 'HANDYMAN_UNIT_ACCESS_READINESS_CREATED')
      .map((r) => r.entity_id);
    assert.ok(createdEntityIds.includes(created.id));
    const successorId = createdEntityIds.find((id) => id !== created.id);
    assert.ok(successorId, 'successor CREATED event references the new row');
    assert.equal(supersededEvents[0].metadata.supersededByReadinessId, successorId);
  });

  it('10: zero arrival/QR/geofence/attendance/session/permit/FM side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const tables = [
      'attendance_records',
      'work_orders',
      'work_requests',
      'permits',
      'schedule_definitions',
      'visitors',
      'expected_visitors',
      'visitor_passes',
      'handyman_scheduling_readiness',
      'handyman_work_crews',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (n) => [n, await tableCount(n)])),
    );
    const created = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: NOTE,
        },
        adminUserId,
      );
    await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        created.id,
        { accessWindowStart: START2, accessWindowEnd: END2,
          authorizationNote: NOTE2 },
        adminUserId,
      );
    for (const n of tables) {
      assert.equal(
        await tableCount(n),
        before[n],
        `${n} must be untouched by unit access readiness`,
      );
    }
  });
});
