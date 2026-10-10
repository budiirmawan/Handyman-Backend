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
import {
  canAccessBuildingScopedResource,
  contextAccessService,
} from '../src/modules/context-access';
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
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-02 PART 01 — focused tests for the BE-02G exact-Building
 * authorization guard applied to the THREE Handyman readiness services
 * (CR-HM-05 PART 01/02/03), 12 operations total:
 *
 *   scheduling readiness   create / supersede / get current / list history
 *   unit-access readiness  create / supersede / get current / list history
 *   permit readiness       create / supersede / get current / list history
 *
 * Authority (CR-HM-SEC-02 PART 00 audit, findings B-1a/B-1b/B-1c; frozen
 * in PART 00A decision D1):
 *   - BE-02G (`docs/data-isolation.md`): access = authentication +
 *     permission + explicit ACTIVE `user_building_assignment` to the
 *     EXACT Building. "No same-Client shortcut."
 *   - The parent `handyman_service_requests` row is building-scoped
 *     (`building_id UUID NOT NULL`, migration 0378, server-derived) —
 *     the authoritative building for CREATE/GET/HISTORY of all three
 *     readiness kinds.
 *   - `handyman_unit_access_readiness` (migration 0388) and
 *     `handyman_permit_readiness` (migration 0389) carry their OWN
 *     authoritative `building_id` — SUPERSEDE guards on the loaded
 *     readiness row's own buildingId.
 *   - The previous wall was the client-level `canAccessClient` shortcut:
 *     an actor assigned only to a same-Client SIBLING building passed it.
 *     The reusable `assertBuildingScopedResourceAccess` guard replaces
 *     it; denial stays 403 BUILDING_ACCESS_DENIED in the wall's original
 *     position (resource 404 first, authorization before any mutation).
 *
 * Eight focused cases:
 *   A. authorized exact-building actor — all operations allowed;
 *   B. same-client sibling-building actor — denied 403 on every
 *      operation (service + HTTP), zero mutation;
 *   C. permission-only actor (read+manage, ZERO assignments) — 403;
 *   D. cross-client actor — 403;
 *   E. no mutation on denied CREATE/SUPERSEDE (row counts, ACTIVE row
 *      identity, windows/validity, journal events all unchanged);
 *   F. no current/history data leakage on denied GETs;
 *   G. actor explicitly assigned to BOTH client buildings — allowed
 *      (the only policy-supported shape of client-wide reach);
 *   H. regression detection — the OLD client-level wall passes for the
 *      sibling actor while the guard denies, so reverting the guard to
 *      `canAccessClient` fails cases B/E/F (the suite detects the
 *      vulnerability, it does not pass vacuously).
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
  await pool.query(`TRUNCATE handyman_permit_readiness,
    handyman_unit_access_readiness, handyman_scheduling_readiness,
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

const readinessRows = async (
  table: string,
  requestId: string,
): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM ${table} WHERE handyman_request_id = $1`,
      [requestId],
    )
  ).rows[0].n as number;

const schedulingRows = (requestId: string) =>
  readinessRows('handyman_scheduling_readiness', requestId);
const unitAccessRows = (requestId: string) =>
  readinessRows('handyman_unit_access_readiness', requestId);
const permitRows = (requestId: string) =>
  readinessRows('handyman_permit_readiness', requestId);

const readinessEventRows = async (requestId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE metadata->>'handymanRequestId' = $1
          AND entity_type IN ('HANDYMAN_SCHEDULING_READINESS',
            'HANDYMAN_UNIT_ACCESS_READINESS', 'HANDYMAN_PERMIT_READINESS')`,
      [requestId],
    )
  ).rows[0].n as number;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

function assertBuildingDenied(error: unknown): boolean {
  assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
  assert.equal(errorStatus(error), 403);
  return true;
}

const START = '2030-01-05T09:00:00.000Z';
const END = '2030-01-05T13:00:00.000Z';
const START2 = '2030-01-06T10:00:00.000Z';
const END2 = '2030-01-06T12:00:00.000Z';
const NOTE = 'Authorized site access for the service window.';

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * request's building, A2 = the same-client sibling), plus a second
 * client with one building for the cross-client case.
 */
async function realmFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA1 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A1 (request building)',
    timezone: 'Asia/Jakarta',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
    timezone: 'Asia/Jakarta',
  });
  const otherClient = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other Client',
  });
  const otherProperty = await propertyService.createProperty({
    clientId: otherClient.id,
    code: `P_${suffix()}`,
    name: 'Other Property',
  });
  const otherBuilding = await buildingService.createBuilding({
    propertyId: otherProperty.id,
    code: `B_${suffix()}`,
    name: 'Other Building (other client)',
    timezone: 'Asia/Jakarta',
  });
  return {
    client,
    property,
    buildingA1,
    buildingA2,
    otherClient,
    otherProperty,
    otherBuilding,
  };
}

/** Tenant context + immutable attribution + request at building A1. */
async function requestFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: realm.buildingA1.id,
  });
  const floor = await floorService.createFloor({
    buildingId: realm.buildingA1.id,
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
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Tenant Company',
    },
    adminUserId,
  );
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.buildingA1.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant Requester',
      email: 'requester@tenant.example.com',
      userId: linkedUser.id,
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
      spaceId: space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM${suffix()}`,
      name: 'Handyman Service',
      category: 'HANDYMAN',
    },
    adminUserId,
  );
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
        description: 'AC dripping in unit.',
      },
      adminUserId,
    );
  return { attribution, service, request };
}

/**
 * Authenticated actor holding exactly `tenant_company.read` +
 * `tenant_company.manage` (the readiness routes' read/manage
 * permissions) plus the given explicit ACTIVE building assignments.
 */
async function createScopedActor(
  buildingIds: readonly string[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `guard-${tag.toLowerCase()}@example.com`,
    displayName: 'Readiness Scope Guard Actor',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `GUARD_${tag}`,
    name: 'Readiness Scope Guard Actor',
  });
  for (const code of ['tenant_company.read', 'tenant_company.manage']) {
    const existing = await permissionRepository.findByCode(code);
    const permission =
      existing ??
      (await permissionService.createPermission({
        code,
        name: code,
      }));
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }

  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

const SCHED_CREATE = (requestId: string) =>
  `/api/v1/handyman/requests/${requestId}/scheduling-readiness`;
const SCHED_SUPERSEDE = (readinessId: string) =>
  `/api/v1/handyman/scheduling-readiness/${readinessId}/supersede`;
const ACCESS_CREATE = (requestId: string) =>
  `/api/v1/handyman/requests/${requestId}/unit-access-readiness`;
const ACCESS_SUPERSEDE = (readinessId: string) =>
  `/api/v1/handyman/unit-access-readiness/${readinessId}/supersede`;
const PERMIT_CREATE = (requestId: string) =>
  `/api/v1/handyman/requests/${requestId}/permit-readiness`;
const PERMIT_SUPERSEDE = (readinessId: string) =>
  `/api/v1/handyman/permit-readiness/${readinessId}/supersede`;

const SCHED_BODY = { preferredWindowStart: START, preferredWindowEnd: END };
const SCHED_BODY2 = {
  preferredWindowStart: START2,
  preferredWindowEnd: END2,
};
const ACCESS_BODY = {
  accessWindowStart: START,
  accessWindowEnd: END,
  authorizationNote: NOTE,
};
const ACCESS_BODY2 = {
  accessWindowStart: START2,
  accessWindowEnd: END2,
  authorizationNote: NOTE,
};
const PERMIT_BODY = {
  permitType: 'UNIT',
  validFrom: START,
  validUntil: END,
  authorizationNote: NOTE,
};
const PERMIT_BODY2 = {
  permitType: 'UNIT',
  validFrom: START2,
  validUntil: END2,
  authorizationNote: NOTE,
};

/** Authorized actor creates all three readiness kinds (service layer). */
async function createAllReadiness(
  requestId: string,
  actorUserId: string,
): Promise<{
  scheduling: { id: string };
  unitAccess: { id: string };
  permit: { id: string };
}> {
  const scheduling =
    await handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
      { handymanRequestId: requestId, ...SCHED_BODY },
      actorUserId,
    );
  const unitAccess =
    await handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
      { handymanRequestId: requestId, ...ACCESS_BODY },
      actorUserId,
    );
  const permit =
    await handymanPermitReadinessService.createHandymanPermitReadiness(
      { handymanRequestId: requestId, ...PERMIT_BODY },
      actorUserId,
    );
  return { scheduling, unitAccess, permit };
}

describe('CR-HM-SEC-02 PART 01 — readiness exact-building scope guard (12 operations)', () => {
  it('A: authorized exact-building actor — create/get/history allowed for all three kinds (service + HTTP)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([realm.buildingA1.id]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );

    // Service layer: all three creates succeed, server-derived context.
    const { scheduling, unitAccess, permit } = await createAllReadiness(
      request.id,
      actor.userId,
    );
    assert.equal(scheduling.clientId, realm.client.id);
    assert.equal(scheduling.status, 'ACTIVE');
    assert.equal(scheduling.timezone, 'Asia/Jakarta');
    assert.equal(unitAccess.clientId, realm.client.id);
    assert.equal(unitAccess.buildingId, realm.buildingA1.id);
    assert.equal(permit.clientId, realm.client.id);
    assert.equal(permit.buildingId, realm.buildingA1.id);

    // Service layer: current + history reads return the data.
    const schedView =
      await handymanSchedulingReadinessService.getHandymanSchedulingReadiness(
        request.id,
        actor.userId,
      );
    assert.equal(schedView.current?.id, scheduling.id);
    assert.equal(schedView.history.length, 1);
    const schedHistory =
      await handymanSchedulingReadinessService
        .listHandymanSchedulingReadinessHistory(request.id, actor.userId);
    assert.equal(schedHistory.length, 1);
    const accessView =
      await handymanUnitAccessReadinessService.getHandymanUnitAccessReadiness(
        request.id,
        actor.userId,
      );
    assert.equal(accessView.current?.id, unitAccess.id);
    const permitHistory =
      await handymanPermitReadinessService.listHandymanPermitReadinessHistory(
        request.id,
        actor.userId,
      );
    assert.equal(permitHistory.length, 1);

    // HTTP layer: POST 201 + GET 200 on the scheduling surface.
    const realm2 = await realmFixture();
    const second = await requestFixture(realm2);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: realm2.buildingA1.id,
    });
    const created = await api()
      .post(SCHED_CREATE(second.request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send(SCHED_BODY);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');
    const current = await api()
      .get(SCHED_CREATE(second.request.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.data.current.id, created.body.data.id);
    const history = await api()
      .get(`${SCHED_CREATE(second.request.id)}/history`)
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);
  });

  it('B: same-client sibling building — denied 403 on every operation (service + HTTP), zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    // Assignment ONLY to the sibling building of the SAME client/property:
    // the exact same-client shortcut BE-02G forbids.
    const actor = await createScopedActor([realm.buildingA2.id]);

    // The OLD client-level wall passed here; the guard must not (case H pin).
    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      true,
    );
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
    );

    // Service layer: CREATE denied for all three kinds.
    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        { handymanRequestId: request.id, ...SCHED_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
        { handymanRequestId: request.id, ...ACCESS_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanPermitReadinessService.createHandymanPermitReadiness(
        { handymanRequestId: request.id, ...PERMIT_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );

    // HTTP layer: POST denied for all three kinds, controlled code.
    for (const [route, body] of [
      [SCHED_CREATE(request.id), SCHED_BODY],
      [ACCESS_CREATE(request.id), ACCESS_BODY],
      [PERMIT_CREATE(request.id), PERMIT_BODY],
    ] as const) {
      const res = await api()
        .post(route)
        .set('Authorization', `Bearer ${actor.token}`)
        .send(body);
      assert.equal(res.status, 403, `${route}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
    }

    // Zero mutation on denial.
    assert.equal(await schedulingRows(request.id), 0);
    assert.equal(await unitAccessRows(request.id), 0);
    assert.equal(await permitRows(request.id), 0);
    assert.equal(await readinessEventRows(request.id), 0);
  });

  it('C: permission-only actor (read+manage, ZERO assignments) — denied 403, zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([]);

    // Permission is NOT data scope.
    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      false,
    );

    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        { handymanRequestId: request.id, ...SCHED_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanUnitAccessReadinessService.createHandymanUnitAccessReadiness(
        { handymanRequestId: request.id, ...ACCESS_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanPermitReadinessService.createHandymanPermitReadiness(
        { handymanRequestId: request.id, ...PERMIT_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );

    const res = await api()
      .post(SCHED_CREATE(request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send(SCHED_BODY);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');

    assert.equal(await schedulingRows(request.id), 0);
    assert.equal(await unitAccessRows(request.id), 0);
    assert.equal(await permitRows(request.id), 0);
    assert.equal(await readinessEventRows(request.id), 0);
  });

  it('D: cross-client actor — denied 403, zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([realm.otherBuilding.id]);

    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      false,
    );

    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        { handymanRequestId: request.id, ...SCHED_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanPermitReadinessService.createHandymanPermitReadiness(
        { handymanRequestId: request.id, ...PERMIT_BODY },
        actor.userId,
      ),
      assertBuildingDenied,
    );

    const res = await api()
      .post(ACCESS_CREATE(request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send(ACCESS_BODY);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');

    assert.equal(await schedulingRows(request.id), 0);
    assert.equal(await unitAccessRows(request.id), 0);
    assert.equal(await permitRows(request.id), 0);
    assert.equal(await readinessEventRows(request.id), 0);
  });

  it('E: no mutation on denied CREATE/SUPERSEDE — ACTIVE rows, windows and journal unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Baseline: authorized actor creates all three kinds.
    const { scheduling, unitAccess, permit } = await createAllReadiness(
      request.id,
      authorized.userId,
    );
    const eventsBefore = await readinessEventRows(request.id);
    assert.equal(eventsBefore, 3);

    // Sibling SUPERSEDE denied at the service layer for all three kinds
    // (SUPERSEDE guards on the loaded row's OWN authoritative buildingId).
    await assert.rejects(
      handymanSchedulingReadinessService
        .supersedeHandymanSchedulingReadiness(
          scheduling.id,
          SCHED_BODY2,
          sibling.userId,
        ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanUnitAccessReadinessService
        .supersedeHandymanUnitAccessReadiness(
          unitAccess.id,
          ACCESS_BODY2,
          sibling.userId,
        ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanPermitReadinessService.supersedeHandymanPermitReadiness(
        permit.id,
        PERMIT_BODY2,
        sibling.userId,
      ),
      assertBuildingDenied,
    );

    // HTTP layer: supersede denied for all three kinds.
    for (const [route, body] of [
      [SCHED_SUPERSEDE(scheduling.id), SCHED_BODY2],
      [ACCESS_SUPERSEDE(unitAccess.id), ACCESS_BODY2],
      [PERMIT_SUPERSEDE(permit.id), PERMIT_BODY2],
    ] as const) {
      const res = await api()
        .post(route)
        .set('Authorization', `Bearer ${sibling.token}`)
        .send(body);
      assert.equal(res.status, 403, `${route}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
    }

    // Zero mutation: still exactly one row per kind, the SAME ACTIVE row
    // with the ORIGINAL window/validity, no supersession links, no events.
    assert.equal(await schedulingRows(request.id), 1);
    assert.equal(await unitAccessRows(request.id), 1);
    assert.equal(await permitRows(request.id), 1);
    const schedRow = (
      await q(
        `SELECT id, status, preferred_window_start, preferred_window_end,
                supersedes_readiness_id
           FROM handyman_scheduling_readiness WHERE handyman_request_id = $1`,
        [request.id],
      )
    ).rows[0];
    assert.equal(schedRow.id, scheduling.id);
    assert.equal(schedRow.status, 'ACTIVE');
    assert.equal(
      new Date(schedRow.preferred_window_start).toISOString(),
      START,
    );
    assert.equal(new Date(schedRow.preferred_window_end).toISOString(), END);
    assert.equal(schedRow.supersedes_readiness_id, null);
    const accessRow = (
      await q(
        `SELECT id, status, access_window_start, access_window_end,
                supersedes_readiness_id
           FROM handyman_unit_access_readiness WHERE handyman_request_id = $1`,
        [request.id],
      )
    ).rows[0];
    assert.equal(accessRow.id, unitAccess.id);
    assert.equal(accessRow.status, 'ACTIVE');
    assert.equal(accessRow.supersedes_readiness_id, null);
    const permitRow = (
      await q(
        `SELECT id, status, valid_from, valid_until, supersedes_readiness_id
           FROM handyman_permit_readiness WHERE handyman_request_id = $1`,
        [request.id],
      )
    ).rows[0];
    assert.equal(permitRow.id, permit.id);
    assert.equal(permitRow.status, 'ACTIVE');
    assert.equal(permitRow.supersedes_readiness_id, null);
    assert.equal(await readinessEventRows(request.id), eventsBefore);

    // Denied CREATE on a fresh request leaves zero rows (sibling).
    const realm2 = await realmFixture();
    const second = await requestFixture(realm2);
    await assert.rejects(
      handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
        { handymanRequestId: second.request.id, ...SCHED_BODY },
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    assert.equal(await schedulingRows(second.request.id), 0);
  });

  it('F: no current/history data leakage on denied GETs (service + HTTP)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Baseline data: authorized actor creates + supersedes all three
    // kinds (two history rows each).
    const { scheduling, unitAccess, permit } = await createAllReadiness(
      request.id,
      authorized.userId,
    );
    await handymanSchedulingReadinessService
      .supersedeHandymanSchedulingReadiness(
        scheduling.id,
        SCHED_BODY2,
        authorized.userId,
      );
    await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        unitAccess.id,
        ACCESS_BODY2,
        authorized.userId,
      );
    await handymanPermitReadinessService.supersedeHandymanPermitReadiness(
      permit.id,
      PERMIT_BODY2,
      authorized.userId,
    );
    assert.equal(await schedulingRows(request.id), 2);
    assert.equal(await unitAccessRows(request.id), 2);
    assert.equal(await permitRows(request.id), 2);

    // Service layer: sibling reads denied for all three kinds.
    await assert.rejects(
      handymanSchedulingReadinessService.getHandymanSchedulingReadiness(
        request.id,
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanSchedulingReadinessService
        .listHandymanSchedulingReadinessHistory(request.id, sibling.userId),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanUnitAccessReadinessService.getHandymanUnitAccessReadiness(
        request.id,
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanUnitAccessReadinessService
        .listHandymanUnitAccessReadinessHistory(request.id, sibling.userId),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanPermitReadinessService.getHandymanPermitReadiness(
        request.id,
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanPermitReadinessService.listHandymanPermitReadinessHistory(
        request.id,
        sibling.userId,
      ),
      assertBuildingDenied,
    );

    // HTTP layer: sibling GET current + history denied, no data payload.
    for (const base of [
      SCHED_CREATE(request.id),
      ACCESS_CREATE(request.id),
      PERMIT_CREATE(request.id),
    ]) {
      for (const suffixPath of ['', '/history']) {
        const res = await api()
          .get(`${base}${suffixPath}`)
          .set('Authorization', `Bearer ${sibling.token}`);
        assert.equal(
          res.status,
          403,
          `${base}${suffixPath}: ${JSON.stringify(res.body)}`,
        );
        assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
        assert.equal(res.body.data, undefined);
      }
    }
  });

  it('G: actor explicitly assigned to BOTH client buildings — allowed (the only policy-supported client-wide reach)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([
      realm.buildingA1.id,
      realm.buildingA2.id,
    ]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );
    // A single FOREIGN-building assignment does not satisfy the guard.
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.otherBuilding.id,
      }),
      false,
    );

    // All three creates + a supersede + reads succeed at the service layer.
    const { scheduling, unitAccess, permit } = await createAllReadiness(
      request.id,
      actor.userId,
    );
    const superseded =
      await handymanSchedulingReadinessService
        .supersedeHandymanSchedulingReadiness(
          scheduling.id,
          SCHED_BODY2,
          actor.userId,
        );
    assert.equal(superseded.status, 'ACTIVE');
    assert.equal(superseded.supersedesReadinessId, scheduling.id);
    assert.equal(await schedulingRows(request.id), 2);
    const view =
      await handymanSchedulingReadinessService.getHandymanSchedulingReadiness(
        request.id,
        actor.userId,
      );
    assert.equal(view.current?.id, superseded.id);
    assert.equal(view.history.length, 2);
    assert.ok(unitAccess.id);
    assert.ok(permit.id);

    // HTTP layer: create + read succeed for the both-buildings actor.
    const res = await api()
      .post(SCHED_CREATE(request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send(SCHED_BODY);
    // The request already has an ACTIVE scheduling readiness → the
    // one-ACTIVE-per-request rule answers 409, NOT 403: authorization
    // passed. A fresh request proves the 201 path.
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const realm2 = await realmFixture();
    const second = await requestFixture(realm2);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: realm2.buildingA1.id,
    });
    const created = await api()
      .post(SCHED_CREATE(second.request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send(SCHED_BODY);
    assert.equal(created.status, 201, JSON.stringify(created.body));
  });

  it('H: guard regression detection — the old client wall passes for the sibling actor, the guard denies', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Vulnerability-detection pin: with the guard reverted to the old
    // client-level `canAccessClient` wall, the sibling actor would be
    // WRONGLY ALLOWED and cases B/E/F would fail. The pin proves the
    // suite detects the vulnerability rather than passing vacuously.
    assert.equal(
      await contextAccessService.canAccessClient(
        sibling.userId,
        realm.client.id,
      ),
      true,
      'old client-level wall must pass for the sibling actor (regression pin)',
    );
    assert.equal(
      await canAccessBuildingScopedResource(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
      'BE-02G guard must deny the sibling actor',
    );

    // Every guarded operation denies the sibling at the service layer.
    const { scheduling } = await createAllReadiness(
      request.id,
      adminUserId,
    );
    // Lazily-created thunks: awaiting each rejection in turn (eagerly
    // created promises would reject unhandled before their turn).
    const denialChecks: Array<() => Promise<unknown>> = [
      () =>
        handymanSchedulingReadinessService.createHandymanSchedulingReadiness(
          { handymanRequestId: request.id, ...SCHED_BODY },
          sibling.userId,
        ),
      () =>
        handymanSchedulingReadinessService
          .supersedeHandymanSchedulingReadiness(
            scheduling.id,
            SCHED_BODY2,
            sibling.userId,
          ),
      () =>
        handymanSchedulingReadinessService.getHandymanSchedulingReadiness(
          request.id,
          sibling.userId,
        ),
      () =>
        handymanSchedulingReadinessService
          .listHandymanSchedulingReadinessHistory(
            request.id,
            sibling.userId,
          ),
    ];
    for (const check of denialChecks) {
      await assert.rejects(check(), assertBuildingDenied);
    }
    // The pre-existing rows created by the authorized admin remain intact.
    assert.equal(await schedulingRows(request.id), 1);
    assert.equal(await unitAccessRows(request.id), 1);
    assert.equal(await permitRows(request.id), 1);
  });
});
