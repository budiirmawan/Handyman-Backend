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
 * CR-HM-05 PART 06A — focused HTTP/OpenAPI tests for the Handyman
 * READINESS surfaces (frozen containment F7).
 *
* Ten cases prove the 12-operation / 9-path surface works end-to-end:
 * read vs manage RBAC split, actor/client/location/timezone/target/QR/
 * FM smuggling structurally ignored, supersede + deterministic history
 * through HTTP, and OpenAPI parity with ZERO target-binding, arrival
 * and FM APIs. 
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let token = '';
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
  token = admin.token;
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

const HM = '/api/v1/handyman';
const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });
const NOTE = 'Authorized by building management.';

function schedBody() {
  return {
    preferredWindowStart: START,
    preferredWindowEnd: END,
  };
}
function accessBody() {
  return { accessWindowStart: START, accessWindowEnd: END,
    authorizationNote: NOTE };
}
function permitBody(type = 'UNIT') {
  return { permitType: type, validFrom: START, validUntil: END,
    authorizationNote: NOTE };
}

const SCHED = (id: string) => `${HM}/requests/${id}/scheduling-readiness`;
const ACC = (id: string) => `${HM}/requests/${id}/unit-access-readiness`;
const PERM = (id: string) => `${HM}/requests/${id}/permit-readiness`;

describe('CR-HM-05 PART 06A — readiness HTTP/OpenAPI surface', () => {
  it('1: scheduling create/read HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await api().post(SCHED(f.request.id)).set(auth())
      .send(schedBody());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.timezone, 'Asia/Jakarta');
    assert.equal(created.body.data.createdByUserId, adminUserId);
    const read = await api().get(SCHED(f.request.id)).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.current.id, created.body.data.id);
    assert.equal(read.body.data.history.length, 1);
    const dup = await api().post(SCHED(f.request.id)).set(auth())
      .send(schedBody());
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code,
      'HANDYMAN_SCHEDULING_READINESS_ALREADY_EXISTS');
  });

  it('2: scheduling supersede/changeReason/history HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await api().post(SCHED(f.request.id)).set(auth())
      .send(schedBody());
    const sup = await api()
      .post(`${HM}/scheduling-readiness/${created.body.data.id}/supersede`)
      .set(auth())
      .send({
        preferredWindowStart: START2,
        preferredWindowEnd: END2,
        changeReason: 'Morning only per customer.',
      });
    assert.equal(sup.status, 201, JSON.stringify(sup.body));
    assert.equal(sup.body.data.status, 'ACTIVE');
    assert.equal(sup.body.data.changeReason, 'Morning only per customer.');
    assert.equal(sup.body.data.supersedesReadinessId, created.body.data.id);
    const history = await api()
      .get(`${SCHED(f.request.id)}/history`).set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.data[0].id, created.body.data.id);
    assert.equal(history.body.data[0].status, 'INACTIVE');
    assert.equal(history.body.data[1].id, sup.body.data.id);
    // supersede a historical row → 400
    const again = await api()
      .post(`${HM}/scheduling-readiness/${created.body.data.id}/supersede`)
      .set(auth())
      .send({ preferredWindowStart: START, preferredWindowEnd: END });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code,
      'HANDYMAN_SCHEDULING_READINESS_INVALID_STATUS');
  });

  it('3: unit-access create/read HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await api().post(ACC(f.request.id)).set(auth())
      .send(accessBody());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.buildingId, f.building.id);
    assert.equal(created.body.data.spaceId, f.space.id);
    assert.equal(created.body.data.authorizedByUserId, adminUserId);
    const read = await api().get(ACC(f.request.id)).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.current.id, created.body.data.id);
    const dup = await api().post(ACC(f.request.id)).set(auth())
      .send(accessBody());
    assert.equal(dup.status, 409);
  });

  it('4: unit-access supersede/history HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await api().post(ACC(f.request.id)).set(auth())
      .send(accessBody());
    const sup = await api()
      .post(`${HM}/unit-access-readiness/${created.body.data.id}/supersede`)
      .set(auth())
      .send({ accessWindowStart: START2, accessWindowEnd: END2,
        authorizationNote: 'Re-authorized with new window.' });
    assert.equal(sup.status, 201);
    assert.equal(sup.body.data.supersedesReadinessId, created.body.data.id);
    assert.equal(sup.body.data.buildingId, f.building.id);
    const history = await api()
      .get(`${ACC(f.request.id)}/history`).set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.data[0].status, 'INACTIVE');
    assert.equal(history.body.data[1].status, 'ACTIVE');
  });

  it('5: permit create/read HTTP (bounded type vocabulary)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await api().post(PERM(f.request.id)).set(auth())
      .send(permitBody('BUILDING_COMMON_AREA'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.permitType, 'BUILDING_COMMON_AREA');
    assert.equal(created.body.data.buildingId, f.building.id);
    assert.equal(created.body.data.authorizedByUserId, adminUserId);
    const read = await api().get(PERM(f.request.id)).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.current.id, created.body.data.id);
    const dup = await api().post(PERM(f.request.id)).set(auth())
      .send(permitBody());
    assert.equal(dup.status, 409);
    const bad = await api().post(PERM(f.request.id)).set(auth())
      .send(permitBody('HOT_WORK'));
    assert.equal(bad.status, 400); // parser-level enum reject
    const f2 = await requestFixture();
    const bad2 = await api().post(PERM(f2.request.id)).set(auth())
      .send(permitBody('HOT_WORK'));
    assert.equal(bad2.body.error.code, 'VALIDATION_ERROR');
  });

  it('6: permit supersede/history HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await api().post(PERM(f.request.id)).set(auth())
      .send(permitBody());
    const sup = await api()
      .post(`${HM}/permit-readiness/${created.body.data.id}/supersede`)
      .set(auth())
      .send(permitBody('BUILDING_COMMON_AREA'));
    assert.equal(sup.status, 201);
    assert.equal(sup.body.data.permitType, 'BUILDING_COMMON_AREA');
    assert.equal(sup.body.data.supersedesReadinessId, created.body.data.id);
    const history = await api()
      .get(`${PERM(f.request.id)}/history`).set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 2);
  });

  it('7: read vs manage permission enforcement', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const created = await api().post(SCHED(f.request.id)).set(auth())
      .send(schedBody());
    assert.equal(created.status, 201);
    const plain = await createPlainSession();
    const readOnly = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    for (const [method, url] of [
      ['get', SCHED(f.request.id)],
      ['get', `${SCHED(f.request.id)}/history`],
      ['get', ACC(f.request.id)],
      ['get', PERM(f.request.id)],
    ] as const) {
      const res = await api()[method](url).set(auth(plain));
      assert.equal(res.status, 403, `plain GET ${url}`);
    }
    // read token can never mutate (manage gate)
    for (const body of [schedBody(), accessBody(), permitBody()]) {
      const url = body === schedBody() ? SCHED(f.request.id)
        : body === accessBody() ? ACC(f.request.id) : PERM(f.request.id);
      const res = await api().post(url).set(auth(readOnly)).send(body);
      assert.equal(res.status, 403, `read-only POST ${url}`);
    }
    const sup = await api()
      .post(`${HM}/scheduling-readiness/${created.body.data.id}/supersede`)
      .set(auth(readOnly))
      .send(schedBody());
    assert.equal(sup.status, 403);
    // full actor still works
    const adminRead = await api().get(SCHED(f.request.id)).set(auth());
    assert.equal(adminRead.status, 200);
  });

  it('8: actor/client/location/timezone/target/QR/FM smuggling blocked or ignored', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const smuggle = {
      clientId: otherClient.id,
      buildingId: randomUUID(),
      spaceId: randomUUID(),
      timezone: 'UTC',
      createdByUserId: randomUUID(),
      authorizedByUserId: randomUUID(),
      executionScopeId: randomUUID(),
      targetId: randomUUID(),
      handymanCrewId: randomUUID(),
      handymanProviderContextId: randomUUID(),
      qrToken: 'QR9',
      geofenceProof: { lat: 0, lng: 0 },
      fmPermitId: randomUUID(),
      workOrderId: randomUUID(),
    };
    const sched = await api().post(SCHED(f.request.id)).set(auth())
      .send({ ...schedBody(), ...smuggle });
    assert.equal(sched.status, 201, JSON.stringify(sched.body));
    assert.equal(sched.body.data.clientId, f.client.id);
    assert.equal(sched.body.data.timezone, 'Asia/Jakarta');
    assert.equal(sched.body.data.createdByUserId, adminUserId);
    const f2 = await requestFixture();
    const acc = await api().post(ACC(f2.request.id)).set(auth())
      .send({ ...accessBody(), ...smuggle });
    assert.equal(acc.status, 201);
    assert.equal(acc.body.data.buildingId, f2.building.id);
    assert.equal(acc.body.data.spaceId, f2.space.id);
    assert.equal(acc.body.data.authorizedByUserId, adminUserId);
    const perm = await api().post(PERM(f2.request.id)).set(auth())
      .send({ ...permitBody(), ...smuggle });
    assert.equal(perm.status, 201);
    assert.equal(perm.body.data.clientId, f2.client.id);
    assert.equal(perm.body.data.authorizedByUserId, adminUserId);
    const raw = perm.body.data as Record<string, unknown>;
    for (const forbidden of ['executionScopeId', 'targetId',
      'workOrderId', 'fmPermitId', 'qrToken']) {
      assert.equal(forbidden in raw, false,
        `forbidden field echoed: ${forbidden}`);
    }
  });

  it('9: history ordering + current-state authority preserved through HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const a = await api().post(SCHED(f.request.id)).set(auth())
      .send(schedBody());
    const b = await api()
      .post(`${HM}/scheduling-readiness/${a.body.data.id}/supersede`)
      .set(auth())
      .send({ preferredWindowStart: START2, preferredWindowEnd: END2 });
    const c = await api()
      .post(`${HM}/scheduling-readiness/${b.body.data.id}/supersede`)
      .set(auth())
      .send({
        preferredWindowStart: '2030-01-07T10:00:00.000Z',
        preferredWindowEnd: '2030-01-07T12:00:00.000Z',
      });
    assert.equal(c.status, 201);
    const history = await api()
      .get(`${SCHED(f.request.id)}/history`).set(auth());
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.body.data.map((r: { id: string }) => r.id),
      [a.body.data.id, b.body.data.id, c.body.data.id],
    );
    assert.deepEqual(
      history.body.data.map((r: { status: string }) => r.status),
      ['INACTIVE', 'INACTIVE', 'ACTIVE'],
    );
    // current-state authority = rows: read bundle tail equals current
    const read = await api().get(SCHED(f.request.id)).set(auth());
    assert.equal(read.body.data.current.id, c.body.data.id);
    assert.equal(read.body.data.history.length, 3);
  });

  it('10: OpenAPI/runtime parity; ZERO target-binding/arrival/FM APIs', async (t) => {
    if (!requireDatabase(t)) return;
    const { parse: parseYaml } = await import('yaml');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const doc = parseYaml(readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'), 'utf8',
    )) as {
      paths: Record<string, Record<string, { operationId?: string } | unknown>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const surface: Record<string, [string, string][]> = {
      '/handyman/requests/{handymanRequestId}/scheduling-readiness': [
        ['post', 'createHandymanSchedulingReadiness'],
        ['get', 'getHandymanSchedulingReadiness'],
      ],
      '/handyman/requests/{handymanRequestId}/scheduling-readiness/history':
        [['get', 'listHandymanSchedulingReadinessHistory']],
      '/handyman/scheduling-readiness/{readinessId}/supersede':
        [['post', 'supersedeHandymanSchedulingReadiness']],
      '/handyman/requests/{handymanRequestId}/unit-access-readiness': [
        ['post', 'createHandymanUnitAccessReadiness'],
        ['get', 'getHandymanUnitAccessReadiness'],
      ],
      '/handyman/requests/{handymanRequestId}/unit-access-readiness/history':
        [['get', 'listHandymanUnitAccessReadinessHistory']],
      '/handyman/unit-access-readiness/{readinessId}/supersede':
        [['post', 'supersedeHandymanUnitAccessReadiness']],
      '/handyman/requests/{handymanRequestId}/permit-readiness': [
        ['post', 'createHandymanPermitReadiness'],
        ['get', 'getHandymanPermitReadiness'],
      ],
      '/handyman/requests/{handymanRequestId}/permit-readiness/history':
        [['get', 'listHandymanPermitReadinessHistory']],
      '/handyman/permit-readiness/{readinessId}/supersede':
        [['post', 'supersedeHandymanPermitReadiness']],
    };
    for (const [path, ops] of Object.entries(surface)) {
      const actual = doc.paths[path];
      assert.ok(actual, `missing path ${path}`);
      for (const [method, operationId] of ops) {
        const op = actual[method] as { operationId?: string } | undefined;
        assert.ok(op, `${path} missing ${method.toUpperCase()}`);
        assert.equal(String(op.operationId), operationId);
      }
      assert.equal(
        Object.keys(actual).filter((k) => k === 'get' || k === 'post')
          .length,
        ops.length,
        `${path} must expose exactly ${ops.length} operation(s)`,
      );
    }
    // ZERO target-binding / crew-assignment / arrival / QR / geofence /
    // check-in / FM work-order APIs anywhere under /handyman
    const forbiddenPath =
      /assign|target|executionscope|arrival|qr|geofence|check-?in|work-?order|permit-to-work/i;
    const leaked = Object.keys(doc.paths).filter((p) =>
      p.startsWith('/handyman') && forbiddenPath.test(p),
    );
    assert.deepEqual(leaked, []);
    // readiness schemas carry exactly the allowed fields
    const forbiddenField =
      /assign|target|scope|arrival|qr|geofence|scheduledwindow|workorder|fmpermit|crew|provider/i;
    for (const name of [
      'HandymanSchedulingReadinessRecord',
      'HandymanUnitAccessReadinessRecord',
      'HandymanPermitReadinessRecord',
      'CreateHandymanSchedulingReadinessRequest',
      'CreateHandymanUnitAccessReadinessRequest',
      'CreateHandymanPermitReadinessRequest',
    ]) {
      const schema = doc.components.schemas[name];
      assert.ok(schema, `missing schema ${name}`);
      const bad = Object.keys(schema.properties ?? {})
        .filter((k) => forbiddenField.test(k));
      assert.deepEqual(bad, [], `${name} leaks ${bad}`);
    }
  });
});
