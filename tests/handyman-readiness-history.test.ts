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
import {
  handymanPermitReadinessService,
  handymanSchedulingReadinessService,
  handymanUnitAccessReadinessService,
} from '../src/modules/handyman-scheduling';
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
 * CR-HM-05 PART 04 — focused tests for readiness HISTORY semantics
 * (FROZEN F2/F8/F9/F10). Supersede = pre-execution reschedule.
 *
 * Ten cases prove: initial+supersede chains are deterministically
 * reconstructable from the immutable readiness ROWS (never from the
 * journal) — old/new windows, actor, server ordering and row-level
 * supersession links; current ACTIVE always equals the chain tail;
 * history reads reject inaccessible scope; journal metadata agrees
 * with rows without being current-state authority; and ZERO
 * target/assignment/arrival/FM/attendance/session side effects.
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

describe('CR-HM-05 PART 04 — readiness history semantics', () => {
  const REASON = 'Customer asked to move the visit to the morning.';

  async function schedPair(f: Awaited<ReturnType<typeof requestFixture>>) {
    const a = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    const b = await handymanSchedulingReadinessService
      .supersedeHandymanSchedulingReadiness(
        a.id,
        {
          preferredWindowStart: START2,
          preferredWindowEnd: END2,
          changeReason: REASON,
        },
        adminUserId,
      );
    return { a, b };
  }

  it('1: scheduling initial+supersede reconstructs exact chronological history', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const { a, b } = await schedPair(f);
    const history = await handymanSchedulingReadinessService
      .listHandymanSchedulingReadinessHistory(f.request.id, adminUserId);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((r) => r.id), [a.id, b.id]);
    assert.equal(history[0].status, 'INACTIVE');
    assert.equal(history[0].supersedesReadinessId, null);
    assert.equal(history[1].status, 'ACTIVE');
    assert.equal(history[1].supersedesReadinessId, a.id);
  });

  it('2: scheduling old/new windows + actor + ordering + bounded reason preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const { a, b } = await schedPair(f);
    const history = await handymanSchedulingReadinessService
      .listHandymanSchedulingReadinessHistory(f.request.id, adminUserId);
    assert.equal(history[0].preferredWindowStart, a.preferredWindowStart);
    assert.equal(history[0].preferredWindowEnd, a.preferredWindowEnd);
    assert.equal(history[1].preferredWindowStart, b.preferredWindowStart);
    assert.equal(history[1].preferredWindowEnd, b.preferredWindowEnd);
    assert.equal(history[1].changeReason, REASON);
    assert.equal(history[0].changeReason, null);
    for (const r of history) assert.equal(r.createdByUserId, adminUserId);
    assert.ok(history[1].createdAt >= history[0].createdAt);
    assert.ok(history[1].supersedesReadinessId !== null);
    // reason is optional, scheduling-owned, taxonomy-free: too long rejects
    const f2 = await requestFixture();
    const c = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f2.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    await assert.rejects(
      handymanSchedulingReadinessService
        .supersedeHandymanSchedulingReadiness(
          c.id,
          {
            preferredWindowStart: START2,
            preferredWindowEnd: END2,
            changeReason: 'x'.repeat(501),
          },
          adminUserId,
        ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SCHEDULING_READINESS_REASON_INVALID',
    );
  });

  it('3: unit-access initial+supersede reconstructs exact history', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const a = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: 'Zugriff genehmigt.',
        },
        adminUserId,
      );
    const b = await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        a.id,
        {
          accessWindowStart: START2,
          accessWindowEnd: END2,
          authorizationNote: 'Window moved.',
        },
        adminUserId,
      );
    const history = await handymanUnitAccessReadinessService
      .listHandymanUnitAccessReadinessHistory(f.request.id, adminUserId);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((r) => r.id), [a.id, b.id]);
    assert.equal(history[0].status, 'INACTIVE');
    assert.equal(history[0].supersedesReadinessId, null);
    assert.equal(history[1].status, 'ACTIVE');
    assert.equal(history[1].supersedesReadinessId, a.id);
    assert.equal(history[0].authorizedByUserId, adminUserId);
    assert.equal(history[1].authorizedByUserId, adminUserId);
    // no arrival semantics anywhere in the history surface
    const raw = history as unknown as Record<string, unknown>[];
    for (const r of raw) {
      for (const k of ['arrivedAt', 'checkedInAt', 'verifiedAt']) {
        assert.equal(k in r, false, `arrival field leaked: ${k}`);
      }
    }
  });

  it('4: unit-access location authority immutable + server-derived across history', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const a = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: 'Authorized.',
        },
        adminUserId,
      );
    await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        a.id,
        { accessWindowStart: START2, accessWindowEnd: END2,
          authorizationNote: 'Re-authorized.' },
        adminUserId,
      );
    const history = await handymanUnitAccessReadinessService
      .listHandymanUnitAccessReadinessHistory(f.request.id, adminUserId);
    for (const r of history) {
      assert.equal(r.buildingId, f.building.id);
      assert.equal(r.spaceId, f.space.id);
      assert.equal(r.roomId, f.room.id);
      assert.equal(r.areaId, f.area.id);
      assert.equal(r.floorId, f.floor.id);
      assert.equal(r.clientId, f.client.id);
    }
  });

  it('5: permit initial+supersede reconstructs exact history', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const a = await handymanPermitReadinessService
      .createHandymanPermitReadiness(
        {
          handymanRequestId: f.request.id,
          permitType: 'UNIT',
          validFrom: START,
          validUntil: END,
          authorizationNote: 'Permit authorized.',
        },
        adminUserId,
      );
    const b = await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        a.id,
        { permitType: 'BUILDING_COMMON_AREA', validFrom: START2,
          validUntil: END2, authorizationNote: 'Permit re-issued.' },
        adminUserId,
      );
    const history = await handymanPermitReadinessService
      .listHandymanPermitReadinessHistory(f.request.id, adminUserId);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((r) => r.id), [a.id, b.id]);
    assert.equal(history[0].status, 'INACTIVE');
    assert.equal(history[0].supersedesReadinessId, null);
    assert.equal(history[1].status, 'ACTIVE');
    assert.equal(history[1].supersedesReadinessId, a.id);
  });

  it('6: permit type/validity + actor/order preserved (no FM PTW semantics)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const a = await handymanPermitReadinessService
      .createHandymanPermitReadiness(
        {
          handymanRequestId: f.request.id,
          permitType: 'UNIT',
          validFrom: START,
          validUntil: END,
          authorizationNote: 'Permit authorized.',
        },
        adminUserId,
      );
    await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        a.id,
        { permitType: 'BUILDING_COMMON_AREA', validFrom: START2,
          validUntil: END2, authorizationNote: 'Permit re-issued.' },
        adminUserId,
      );
    const history = await handymanPermitReadinessService
      .listHandymanPermitReadinessHistory(f.request.id, adminUserId);
    assert.equal(history[0].permitType, 'UNIT');
    assert.equal(history[0].validFrom, START);
    assert.equal(history[0].validUntil, END);
    assert.equal(history[1].permitType, 'BUILDING_COMMON_AREA');
    assert.equal(history[1].validFrom, START2);
    assert.equal(history[1].validUntil, END2);
    for (const r of history) assert.equal(r.authorizedByUserId, adminUserId);
    assert.ok(history[1].createdAt >= history[0].createdAt);
    const raw = history as unknown as Record<string, unknown>[];
    for (const r of raw) {
      for (const k of ['fmPermitId', 'workOrderId', 'workStartedAt',
        'approvedAt', 'issuedAt']) {
        assert.equal(k in r, false, `FM PTW field leaked: ${k}`);
      }
    }
  });

  it('7: current ACTIVE record always agrees with the history tail', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const { a, b } = await schedPair(f);
    const c = await handymanSchedulingReadinessService
      .supersedeHandymanSchedulingReadiness(
        b.id,
        { preferredWindowStart: '2030-01-07T10:00:00.000Z',
          preferredWindowEnd: '2030-01-07T12:00:00.000Z' },
        adminUserId,
      );
    const history = await handymanSchedulingReadinessService
      .listHandymanSchedulingReadinessHistory(f.request.id, adminUserId);
    assert.equal(history.length, 3);
    const read = await handymanSchedulingReadinessService
      .getHandymanSchedulingReadiness(f.request.id, adminUserId);
    const tail = history[history.length - 1];
    assert.equal(tail.id, c.id);
    assert.equal(tail.status, 'ACTIVE');
    assert.equal(read.current?.id, tail.id);
    assert.equal(history.filter((r) => r.status === 'ACTIVE').length, 1);
    assert.deepEqual(
      [history[0].id, history[1].id, history[2].id],
      [a.id, b.id, c.id],
    );
    assert.equal(history[1].supersedesReadinessId, a.id);
    assert.equal(history[2].supersedesReadinessId, b.id);
  });

  it('8: inaccessible history reads rejected (cross-client scope)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    await schedPair(f);
    const outsider = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });
    for (const read of [
      () => handymanSchedulingReadinessService
        .listHandymanSchedulingReadinessHistory(f.request.id, outsider.id),
      () => handymanUnitAccessReadinessService
        .listHandymanUnitAccessReadinessHistory(f.request.id, outsider.id),
      () => handymanPermitReadinessService
        .listHandymanPermitReadinessHistory(f.request.id, outsider.id),
    ]) {
      await assert.rejects(read(), (e: unknown) =>
        errorCode(e) === 'BUILDING_ACCESS_DENIED');
    }
  });

  it('9: journal metadata agrees with immutable rows but is not current-state authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const { a, b } = await schedPair(f);
    const history = await handymanSchedulingReadinessService
      .listHandymanSchedulingReadinessHistory(f.request.id, adminUserId);
    const events = await q(
      `SELECT event_type, entity_id, metadata
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_SCHEDULING_READINESS'
         AND metadata->>'handymanRequestId' = $1
       ORDER BY created_at ASC, id ASC`,
      [f.request.id],
    );
    assert.equal(events.rows.length, 3);
    // events within one transaction share insert timestamps; resolve
    // deterministically by (event_type, entity_id) rather than clock ties
    const byKey = new Map(
      events.rows.map((r) => [`${r.event_type}:${r.entity_id}`, r]),
    );
    const created = byKey
      .get(`HANDYMAN_SCHEDULING_READINESS_CREATED:${a.id}`)!;
    const superseded = byKey
      .get(`HANDYMAN_SCHEDULING_READINESS_SUPERSEDED:${a.id}`)!;
    const recreated = byKey
      .get(`HANDYMAN_SCHEDULING_READINESS_CREATED:${b.id}`)!;
    assert.ok(created && superseded && recreated);
    assert.equal(created.metadata.readinessId, a.id);
    assert.equal(superseded.event_type,
      'HANDYMAN_SCHEDULING_READINESS_SUPERSEDED');
    assert.equal(superseded.entity_id, a.id);
    assert.equal(superseded.metadata.supersededByReadinessId, b.id);
    assert.equal(recreated.event_type,
      'HANDYMAN_SCHEDULING_READINESS_CREATED');
    assert.equal(recreated.entity_id, b.id);
    assert.equal(recreated.metadata.supersedesReadinessId, a.id);
    // row linkage == journal linkage (journal mirrors, never leads)
    assert.equal(history[1].supersedesReadinessId, a.id);
    assert.equal(
      history[1].supersedesReadinessId,
      recreated.metadata.supersedesReadinessId,
    );
    // current state derives from ROWS only: history tail is ACTIVE
    // regardless of journal content shape (journal queried read-only here)
    assert.equal(history[history.length - 1].status, 'ACTIVE');
    assert.equal(history[history.length - 1].id, b.id);
  });

  it('10: zero target/assignment/arrival/FM/attendance/session side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const tables = [
      'work_orders',
      'work_requests',
      'permits',
      'permit_applications',
      'attendance_records',
      'visitor_passes',
      'handyman_work_crews',
      'handyman_crew_memberships',
      'schedule_definitions',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (n) => [n, await tableCount(n)])),
    );
    await schedPair(f);
    const au = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: START,
          accessWindowEnd: END,
          authorizationNote: 'Authorized.',
        },
        adminUserId,
      );
    await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        au.id,
        { accessWindowStart: START2, accessWindowEnd: END2,
          authorizationNote: 'Re-authorized.' },
        adminUserId,
      );
    const pr = await handymanPermitReadinessService
      .createHandymanPermitReadiness(
        {
          handymanRequestId: f.request.id,
          permitType: 'UNIT',
          validFrom: START,
          validUntil: END,
          authorizationNote: 'Permit authorized.',
        },
        adminUserId,
      );
    await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        pr.id,
        { permitType: 'UNIT', validFrom: START2,
          validUntil: END2, authorizationNote: 'Permit re-issued.' },
        adminUserId,
      );
    // full history surface reachable via bounded domain reads
    for (const read of [
      handymanSchedulingReadinessService
        .listHandymanSchedulingReadinessHistory(f.request.id, adminUserId),
      handymanUnitAccessReadinessService
        .listHandymanUnitAccessReadinessHistory(f.request.id, adminUserId),
      handymanPermitReadinessService
        .listHandymanPermitReadinessHistory(f.request.id, adminUserId),
    ]) {
      assert.equal((await read).length, 2);
    }
    for (const n of tables) {
      assert.equal(
        await tableCount(n),
        before[n],
        `${n} must be untouched by readiness history`,
      );
    }
  });
});
