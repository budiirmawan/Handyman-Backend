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
import { handymanSchedulingReadinessService } from '../src/modules/handyman-scheduling';
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
 * CR-HM-05 PART 01 — focused tests for Handyman Scheduling Readiness
 * (FROZEN containment F1/F2/F7/F8/F9/F10).
 *
 * Ten cases prove: readiness creation is server-derived (client/building
 * context, building-authoritative timezone), windows are validated,
 * one-ACTIVE-per-request + supersede-history semantics hold, cross-client
 * requests are denied, smuggled authority is structurally ignored,
 * mutation + journal are atomic, and ZERO execution/job/WO/assignment/
 * session/attendance side effects occur. Real migrated PostgreSQL.
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
  await pool.query(`TRUNCATE handyman_scheduling_readiness,
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
  return { client, building, space, company, attribution, request };
}

describe('CR-HM-05 PART 01 — scheduling readiness foundation', () => {
  it('1: valid request → ACTIVE readiness created', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const row = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.handymanRequestId, f.request.id);
    assert.equal(row.createdByUserId, adminUserId);
    assert.equal(row.preferredWindowStart, START);
    assert.equal(row.preferredWindowEnd, END);
    // NOT an execution schedule: no execution/target/provider fields
    const raw = row as unknown as Record<string, unknown>;
    for (const k of [
      'targetId', 'executionScopeId', 'handymanCrewId',
      'handymanProviderContextId', 'assignedByUserId', 'workOrderId',
    ]) {
      assert.equal(k in raw, false, `execution field leaked: ${k}`);
    }
  });

  it('2: clientId/building context server-derived from the request chain', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const row = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    assert.equal(row.clientId, f.client.id);
    const stored = await q(
      `SELECT client_id, handyman_request_id
       FROM handyman_scheduling_readiness WHERE id = $1`,
      [row.id],
    );
    assert.equal(stored.rows[0].client_id, f.client.id);
    assert.equal(stored.rows[0].handyman_request_id, f.request.id);
  });

  it('3: timezone server-derived from building authority; null → refused', async (t) => {
    if (!requireDatabase(t)) return;
    const ok = await requestFixture('Asia/Jakarta');
    const row = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: ok.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    assert.equal(row.timezone, 'Asia/Jakarta');
    const noTz = await requestFixture(null);
    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        {
          handymanRequestId: noTz.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) ===
        'HANDYMAN_SCHEDULING_READINESS_TIMEZONE_UNAVAILABLE',
    );
    assert.equal(
      (await handymanSchedulingReadinessService
        .getHandymanSchedulingReadiness(noTz.request.id, adminUserId))
        .current,
      null,
    );
  });

  it('4: reversed / zero / invalid windows rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const before = await tableCount('handyman_scheduling_readiness');
    for (const [s, e] of [
      [END, START],           // reversed
      [START, START],         // zero-length
      ['not-a-date', END],    // unparseable
    ]) {
      await assert.rejects(
        handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
          {
            handymanRequestId: f.request.id,
            preferredWindowStart: s,
            preferredWindowEnd: e,
          },
          adminUserId,
        ),
        (err: unknown) =>
          errorCode(err) === 'HANDYMAN_SCHEDULING_READINESS_WINDOW_INVALID',
      );
    }
    assert.equal(await tableCount('handyman_scheduling_readiness'), before);
  });

  it('5: duplicate ACTIVE readiness rejected (one current per request)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const before = await tableCount('handyman_scheduling_readiness');
    await handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
      {
        handymanRequestId: f.request.id,
        preferredWindowStart: START,
        preferredWindowEnd: END,
      },
      adminUserId,
    );
    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START2,
          preferredWindowEnd: END2,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SCHEDULING_READINESS_ALREADY_EXISTS',
    );
    assert.equal(await tableCount('handyman_scheduling_readiness'), before + 1);
  });

  it('6: material window change supersedes rows; full history preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const first = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    const second = await handymanSchedulingReadinessService
      .supersedeHandymanSchedulingReadiness(
        first.id,
        { preferredWindowStart: START2, preferredWindowEnd: END2 },
        adminUserId,
      );
    assert.equal(second.status, 'ACTIVE');
    const read = await handymanSchedulingReadinessService
      .getHandymanSchedulingReadiness(f.request.id, adminUserId);
    assert.equal(read.history.length, 2);
    assert.equal(
      read.history.find((r) => r.id === first.id)?.status, 'INACTIVE');
    assert.equal(
      read.history.find((r) => r.id === second.id)?.status, 'ACTIVE');
    assert.equal(read.current?.id, second.id);
    // superseding a non-ACTIVE (historical) row is rejected
    await assert.rejects(
      handymanSchedulingReadinessService
        .supersedeHandymanSchedulingReadiness(
          first.id,
          { preferredWindowStart: START, preferredWindowEnd: END },
          adminUserId,
        ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SCHEDULING_READINESS_INVALID_STATUS',
    );
  });

  it('7: inaccessible request scope (caller without client access) rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const outsider = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });
    const before = await tableCount('handyman_scheduling_readiness');
    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        outsider.id,
      ),
      (e: unknown) => errorCode(e) === 'BUILDING_ACCESS_DENIED',
    );
    assert.equal(await tableCount('handyman_scheduling_readiness'), before);
  });

  it('8: smuggled client/timezone/provider/crew/target keys can never become authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture('Asia/Jakarta');
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const smuggled = {
      handymanRequestId: f.request.id,
      preferredWindowStart: START,
      preferredWindowEnd: END,
      clientId: otherClient.id,
      buildingId: randomUUID(),
      timezone: 'UTC',
      handymanProviderContextId: randomUUID(),
      handymanCrewId: randomUUID(),
      targetId: randomUUID(),
      executionScopeId: randomUUID(),
      actorUserId: randomUUID(),
    } as unknown as Parameters<
      typeof handymanSchedulingReadinessService
        .createHandymanSchedulingReadiness
    >[0];
    const row = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(smuggled, adminUserId);
    assert.equal(row.clientId, f.client.id);
    assert.equal(row.timezone, 'Asia/Jakarta');
    assert.equal(row.createdByUserId, adminUserId);
  });

  it('9: mutation + journal atomic (failure = zero partial commits)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    const beforeRows = await tableCount('handyman_scheduling_readiness');
    const beforeEv = await tableCount('operational_events');
    // force a transactional failure AFTER row/state work has begun: supersede
    // with an invalid window → whole attempt must roll back
    await assert.rejects(
      handymanSchedulingReadinessService
        .supersedeHandymanSchedulingReadiness(
          created.id,
          { preferredWindowStart: END, preferredWindowEnd: START },
          adminUserId,
        ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SCHEDULING_READINESS_WINDOW_INVALID',
    );
    // duplicate create also rolls its journal back
    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START2,
          preferredWindowEnd: END2,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SCHEDULING_READINESS_ALREADY_EXISTS',
    );
    assert.equal(await tableCount('handyman_scheduling_readiness'), beforeRows);
    assert.equal(await tableCount('operational_events'), beforeEv);
    // happy path: supersede commits row pair + 2 events atomically
    await handymanSchedulingReadinessService
      .supersedeHandymanSchedulingReadiness(
        created.id,
        { preferredWindowStart: START2, preferredWindowEnd: END2 },
        adminUserId,
      );
    assert.equal(
      await tableCount('handyman_scheduling_readiness'), beforeRows + 1);
    assert.equal(await tableCount('operational_events'), beforeEv + 2);
    const events = await q(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'HANDYMAN_SCHEDULING_READINESS'
         AND metadata->>'handymanRequestId' = $1
       ORDER BY created_at ASC, id ASC`,
      [f.request.id],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_type),
      [
        'HANDYMAN_SCHEDULING_READINESS_CREATED',
        'HANDYMAN_SCHEDULING_READINESS_SUPERSEDED',
        'HANDYMAN_SCHEDULING_READINESS_CREATED',
      ],
    );
  });

  it('10: zero execution/job/WO/assignment/session/attendance side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const tables = [
      'handyman_work_crews',
      'handyman_crew_memberships',
      'handyman_crew_leads',
      'work_orders',
      'work_requests',
      'tenant_service_requests',
      'attendance_records',
      'schedule_definitions',
      'permits',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (n) => [n, await tableCount(n)])),
    );
    const created = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: START,
          preferredWindowEnd: END,
        },
        adminUserId,
      );
    await handymanSchedulingReadinessService
      .supersedeHandymanSchedulingReadiness(
        created.id,
        { preferredWindowStart: START2, preferredWindowEnd: END2 },
        adminUserId,
      );
    for (const n of tables) {
      assert.equal(
        await tableCount(n),
        before[n],
        `${n} must be untouched by scheduling readiness`,
      );
    }
  });
});
