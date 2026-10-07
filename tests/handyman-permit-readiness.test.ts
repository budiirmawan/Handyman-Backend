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
import { handymanPermitReadinessService } from '../src/modules/handyman-scheduling';
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
 * CR-HM-05 PART 03 — focused tests for Handyman Permit Readiness
 * (FROZEN containment F4/F5/F7/F8/F9/F10).
 *
 * Ten cases prove: permit-readiness creation is server-derived
 * (client/location chain), the bounded type vocabulary is enforced,
 * validity ranges are validated, one-ACTIVE-per-request + supersede
 * history holds, cross-client requests are denied, smuggled authority
 * (actor/client/location/worker/crew/QR/FM refs) is structurally
 * ignored, mutation + journal are atomic, and FM permits/PTW + work
 * orders + arrival/attendance/session surfaces stay untouched. Real
 * migrated PostgreSQL.
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
  await pool.query(`TRUNCATE handyman_permit_readiness, handyman_unit_access_readiness,
    handyman_scheduling_readiness,
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

describe('CR-HM-05 PART 03 — permit readiness', () => {
  const NOTE = 'Building office authorized permit for unit service access.';
  const NOTE2 = 'Permit re-issued with extended validity.';

  function create(f: Awaited<ReturnType<typeof requestFixture>>,
    permitType = 'UNIT') {
    return handymanPermitReadinessService.createHandymanPermitReadiness(
      {
        handymanRequestId: f.request.id,
        permitType,
        validFrom: START,
        validUntil: END,
        authorizationNote: NOTE,
      },
      adminUserId,
    );
  }

  it('1: valid request/access context → ACTIVE permit readiness', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    // ACTIVE unit-access readiness present → permit must agree with it
    await handymanUnitAccessReadinessServiceSeed(f);
    const row = await create(f);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.permitType, 'UNIT');
    assert.equal(row.handymanRequestId, f.request.id);
    assert.equal(row.authorizedByUserId, adminUserId);
    assert.equal(row.buildingId, f.building.id);
    assert.equal(row.spaceId, f.space.id);
    // NOT FM PTW / execution: no lifecycle/proof fields
    const raw = row as unknown as Record<string, unknown>;
    for (const k of [
      'fmPermitId', 'workOrderId', 'executionScopeId', 'targetId',
      'workStartedAt', 'completedAt', 'approvedAt', 'issuedAt',
      'safetyChecklistId', 'handymanCrewId',
    ]) {
      assert.equal(k in raw, false, `FM/execution field leaked: ${k}`);
    }
  });

  it('2: client/location server-derived from the request chain', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const row = await create(f);
    assert.equal(row.clientId, f.client.id);
    assert.equal(row.buildingId, f.building.id);
    assert.equal(row.spaceId, f.space.id);
    assert.equal(row.roomId, f.room.id);
    assert.equal(row.areaId, f.area.id);
    assert.equal(row.floorId, f.floor.id);
  });

  it('3: bounded permitType accepted; unsupported type rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const unit = await requestFixture();
    const unitRow = await create(unit, 'UNIT');
    assert.equal(unitRow.permitType, 'UNIT');
    const common = await requestFixture();
    const commonRow = await create(common, 'BUILDING_COMMON_AREA');
    assert.equal(commonRow.permitType, 'BUILDING_COMMON_AREA');
    const before = await tableCount('handyman_permit_readiness');
    for (const bad of ['HOT_WORK', 'FM_PERMIT_TO_WORK', 'RANDOM']) {
      await assert.rejects(
        handymanPermitReadinessService.createHandymanPermitReadiness(
          {
            handymanRequestId: (await requestFixture()).request.id,
            permitType: bad,
            validFrom: START,
            validUntil: END,
            authorizationNote: NOTE,
          },
          adminUserId,
        ),
        (e: unknown) =>
          errorCode(e) === 'HANDYMAN_PERMIT_READINESS_TYPE_UNSUPPORTED',
      );
    }
    assert.equal(await tableCount('handyman_permit_readiness'), before);
  });

  it('4: invalid / zero / reversed validity rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const before = await tableCount('handyman_permit_readiness');
    for (const [s, e] of [
      [END, START],
      [START, START],
      ['not-a-date', END],
    ]) {
      await assert.rejects(
        handymanPermitReadinessService.createHandymanPermitReadiness(
          {
            handymanRequestId: f.request.id,
            permitType: 'UNIT',
            validFrom: s,
            validUntil: e,
            authorizationNote: NOTE,
          },
          adminUserId,
        ),
        (err: unknown) =>
          errorCode(err) === 'HANDYMAN_PERMIT_READINESS_VALIDITY_INVALID',
      );
    }
    assert.equal(await tableCount('handyman_permit_readiness'), before);
  });

  it('5: duplicate ACTIVE readiness rejected (one current per request)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const before = await tableCount('handyman_permit_readiness');
    await create(f);
    await assert.rejects(
      handymanPermitReadinessService.createHandymanPermitReadiness(
        {
          handymanRequestId: f.request.id,
          permitType: 'BUILDING_COMMON_AREA',
          validFrom: START2,
          validUntil: END2,
          authorizationNote: NOTE,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_PERMIT_READINESS_ALREADY_EXISTS',
    );
    assert.equal(await tableCount('handyman_permit_readiness'), before + 1);
  });

  it('6: material permit change supersedes rows; history preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const first = await create(f);
    const second = await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        first.id,
        { permitType: 'BUILDING_COMMON_AREA', validFrom: START2,
          validUntil: END2, authorizationNote: NOTE2 },
        adminUserId,
      );
    assert.equal(second.status, 'ACTIVE');
    assert.equal(second.permitType, 'BUILDING_COMMON_AREA');
    const read = await handymanPermitReadinessService
      .getHandymanPermitReadiness(f.request.id, adminUserId);
    assert.equal(read.history.length, 2);
    assert.equal(
      read.history.find((r) => r.id === first.id)?.status, 'INACTIVE');
    assert.equal(read.current?.id, second.id);
    await assert.rejects(
      handymanPermitReadinessService.supersedeHandymanPermitReadiness(
        first.id,
        { permitType: 'UNIT', validFrom: START, validUntil: END,
          authorizationNote: NOTE },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_PERMIT_READINESS_INVALID_STATUS',
    );
  });

  it('7: inaccessible request scope (caller without client access) rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const outsider = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });
    const before = await tableCount('handyman_permit_readiness');
    await assert.rejects(
      handymanPermitReadinessService.createHandymanPermitReadiness(
        {
          handymanRequestId: f.request.id,
          permitType: 'UNIT',
          validFrom: START,
          validUntil: END,
          authorizationNote: NOTE,
        },
        outsider.id,
      ),
      (e: unknown) => errorCode(e) === 'BUILDING_ACCESS_DENIED',
    );
    assert.equal(await tableCount('handyman_permit_readiness'), before);
  });

  it('8: actor/client/location/worker/crew/QR/FM smuggling cannot become authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const smuggled = {
      handymanRequestId: f.request.id,
      permitType: 'UNIT',
      validFrom: START,
      validUntil: END,
      authorizationNote: NOTE,
      clientId: otherClient.id,
      buildingId: randomUUID(),
      spaceId: randomUUID(),
      authorizedByUserId: randomUUID(),
      fmPermitId: randomUUID(),
      workOrderId: randomUUID(),
      handymanCrewId: randomUUID(),
      handymanProviderContextId: randomUUID(),
      handymanWorkerContextId: randomUUID(),
      qrToken: 'QR123',
      actorUserId: randomUUID(),
    } as unknown as Parameters<
      typeof handymanPermitReadinessService.createHandymanPermitReadiness
    >[0];
    const row = await handymanPermitReadinessService
      .createHandymanPermitReadiness(smuggled, adminUserId);
    assert.equal(row.clientId, f.client.id);
    assert.equal(row.buildingId, f.building.id);
    assert.equal(row.spaceId, f.space.id);
    assert.equal(row.authorizedByUserId, adminUserId);
  });

  it('9: mutation + journal atomic (failure = zero partial commits)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await create(f);
    const beforeRows = await tableCount('handyman_permit_readiness');
    const beforeEv = await tableCount('operational_events');
    await assert.rejects(
      handymanPermitReadinessService.supersedeHandymanPermitReadiness(
        created.id,
        { permitType: 'UNIT', validFrom: END, validUntil: START,
          authorizationNote: NOTE },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_PERMIT_READINESS_VALIDITY_INVALID',
    );
    await assert.rejects(create(f),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_PERMIT_READINESS_ALREADY_EXISTS',
    );
    assert.equal(await tableCount('handyman_permit_readiness'), beforeRows);
    assert.equal(await tableCount('operational_events'), beforeEv);
    await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        created.id,
        { permitType: 'UNIT', validFrom: START2, validUntil: END2,
          authorizationNote: NOTE2 },
        adminUserId,
      );
    assert.equal(
      await tableCount('handyman_permit_readiness'), beforeRows + 1);
    assert.equal(await tableCount('operational_events'), beforeEv + 2);
    const events = await q(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'HANDYMAN_PERMIT_READINESS'
         AND metadata->>'handymanRequestId' = $1
       ORDER BY created_at ASC, id ASC`,
      [f.request.id],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_type),
      [
        'HANDYMAN_PERMIT_READINESS_CREATED',
        'HANDYMAN_PERMIT_READINESS_SUPERSEDED',
        'HANDYMAN_PERMIT_READINESS_CREATED',
      ],
    );
  });

  it('10: FM permits/work-orders + arrival/attendance/session surfaces unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const tables = [
      'permits',
      'permit_applications',
      'permit_validities',
      'work_orders',
      'work_requests',
      'attendance_records',
      'visitor_passes',
      'handyman_work_crews',
      'schedule_definitions',
      'handyman_unit_access_readiness',
      'handyman_scheduling_readiness',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (n) => [n, await tableCount(n)])),
    );
    const created = await create(f);
    await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        created.id,
        { permitType: 'UNIT', validFrom: START2, validUntil: END2,
          authorizationNote: NOTE2 },
        adminUserId,
      );
    for (const n of tables) {
      assert.equal(
        await tableCount(n),
        before[n],
        `${n} must be untouched by permit readiness`,
      );
    }
  });

  /** Seed an ACTIVE unit-access readiness (PART 02 seam) for a request. */
  async function handymanUnitAccessReadinessServiceSeed(
    f: Awaited<ReturnType<typeof requestFixture>>,
  ) {
    await q(
      `INSERT INTO handyman_unit_access_readiness (
         id, client_id, handyman_request_id, building_id, floor_id,
         area_id, room_id, space_id, access_window_start,
         access_window_end, authorization_note, authorized_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7,
         $8::timestamptz, $9::timestamptz, 'seed', $10
       )`,
      [f.client.id, f.request.id, f.building.id, f.floor.id,
       f.area.id, f.room.id, f.space.id, START, END, adminUserId],
    );
  }
});
