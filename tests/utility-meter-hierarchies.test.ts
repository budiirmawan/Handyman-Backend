import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-18C — Main / Sub Meter focused validation.
 *
 * Covers only this PART: binding a Sub Meter to a Main Meter, getting a
 * relationship, listing Sub Meters, resolving the Main Meter, ending /
 * updating a relationship, and the guard rails — self-reference, circular
 * hierarchy (including multi-level), utility mismatch, duplicate active
 * relationship, invalid meters, cross-Client / Building rejection, history
 * preservation, and RBAC.
 *
 * BE-18B utility configuration stays opt-in: these fixtures create NO utility
 * type configuration, proving meter binding never requires one.
 *
 * Tenant Meter and Meter Reading are out of scope and are deliberately not
 * exercised here.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE utility_meter_hierarchies, utility_type_uoms,
       utility_type_configurations, utility_meters, units_of_measure,
       functional_locations, spaces, rooms, areas, floors,
       user_building_assignments, buildings, properties, users, roles,
       permissions, role_permission_assignments, user_role_assignments,
       clients CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

async function createUom(clientId: string, symbol = 'kWh') {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth())
    .send({
      code: `UOM_${suffix()}`,
      name: 'Measurement unit',
      symbol,
      category: 'ENERGY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

/** Client → Property → Building → Floor → Area → Room → Space (BE-04 chain). */
async function createStructure(options: { assignUserId?: string | null } = {}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Utility Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Utility Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Utility Building',
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `FL_${suffix()}`,
    name: 'Ground floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AR_${suffix()}`,
    name: 'Plant area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RM_${suffix()}`,
    name: 'Panel room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${suffix()}`,
    name: 'Panel bay',
  });

  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const uomId = await createUom(client.id);

  return { client, property, building, floor, area, room, space, uomId };
}

type MeterFixture = { client: { id: string }; building: { id: string }; uomId: string };

/** Registers a BE-18A Meter — the hierarchy always reuses existing meters. */
async function createMeter(
  fixture: MeterFixture,
  options: {
    utilityType?: string;
    uomId?: string;
    buildingId?: string;
    status?: 'ACTIVE' | 'INACTIVE';
    token?: string;
  } = {},
) {
  const created = await api()
    .post(
      `/api/v1/buildings/${options.buildingId ?? fixture.building.id}/utility-meters`,
    )
    .set(auth(options.token))
    .send({
      code: `MTR_${suffix()}`,
      name: 'Utility meter',
      utilityType: options.utilityType ?? 'ELECTRICITY',
      uomId: options.uomId ?? fixture.uomId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  if (options.status === 'INACTIVE') {
    const patched = await api()
      .patch(`/api/v1/utility/meters/${created.body.data.id}/status`)
      .set(auth(options.token))
      .send({ status: 'INACTIVE' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }

  return created.body.data;
}

async function bind(
  mainMeterId: string,
  subMeterId: string,
  body: Record<string, unknown> = {},
  token = adminToken,
) {
  return api()
    .post(`/api/v1/utility/meters/${mainMeterId}/sub-meters`)
    .set(auth(token))
    .send({ subMeterId, ...body });
}

describe('BE-18C main / sub meter — valid binding', () => {
  it('binds a sub meter to a main meter and returns it on get', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);

    const created = await bind(main.id, sub.id, {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const hierarchy = created.body.data;
    assert.equal(hierarchy.mainMeterId, main.id);
    assert.equal(hierarchy.subMeterId, sub.id);
    assert.equal(hierarchy.status, 'ACTIVE');
    assert.equal(hierarchy.effectiveFrom, '2026-01-01T00:00:00.000Z');
    assert.equal(hierarchy.effectiveUntil, null);
    // Client scope is derived from the meters, never supplied by the caller.
    assert.equal(hierarchy.clientId, fixture.client.id);
    // BE-18A meters are referenced and resolved, never duplicated.
    assert.equal(hierarchy.mainMeter.code, main.code);
    assert.equal(hierarchy.subMeter.code, sub.code);

    const fetched = await api()
      .get(`/api/v1/utility/meter-hierarchies/${hierarchy.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, hierarchy.id);
  });

  it('binds without any BE-18B utility configuration (configuration stays opt-in)', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture, { utilityType: 'WATER' });
    const sub = await createMeter(fixture, { utilityType: 'WATER' });

    const configured = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth());
    assert.equal(configured.body.data.length, 0);

    const created = await bind(main.id, sub.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
  });

  it('lists sub meters by main meter and resolves the main meter of a sub meter', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const subA = await createMeter(fixture);
    const subB = await createMeter(fixture);

    assert.equal((await bind(main.id, subA.id)).status, 201);
    assert.equal((await bind(main.id, subB.id)).status, 201);

    const listed = await api()
      .get(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 2);
    assert.deepEqual(
      listed.body.data.map((entry: { subMeterId: string }) => entry.subMeterId).sort(),
      [subA.id, subB.id].sort(),
    );

    const resolved = await api()
      .get(`/api/v1/utility/meters/${subA.id}/main-meter`)
      .set(auth());
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.mainMeterId, main.id);
    assert.equal(resolved.body.data.mainMeter.code, main.code);

    // A top-level meter simply has no main meter — that is not an error.
    const topLevel = await api()
      .get(`/api/v1/utility/meters/${main.id}/main-meter`)
      .set(auth());
    assert.equal(topLevel.status, 200, JSON.stringify(topLevel.body));
    assert.equal(topLevel.body.data, null);
  });

  it('supports a multi-level chain: main → sub → sub-sub', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const top = await createMeter(fixture);
    const middle = await createMeter(fixture);
    const leaf = await createMeter(fixture);

    assert.equal((await bind(top.id, middle.id)).status, 201);
    assert.equal((await bind(middle.id, leaf.id)).status, 201);

    const middleSubs = await api()
      .get(`/api/v1/utility/meters/${middle.id}/sub-meters`)
      .set(auth());
    assert.equal(middleSubs.body.data.length, 1);
    assert.equal(middleSubs.body.data[0].subMeterId, leaf.id);

    const leafMain = await api()
      .get(`/api/v1/utility/meters/${leaf.id}/main-meter`)
      .set(auth());
    assert.equal(leafMain.body.data.mainMeterId, middle.id);
  });
});

describe('BE-18C main / sub meter — relationship rules', () => {
  it('rejects self-reference', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    const response = await bind(meter.id, meter.id);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_HIERARCHY_SELF_REFERENCE',
    );
  });

  it('rejects a direct circular hierarchy (A → B, then B → A)', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const a = await createMeter(fixture);
    const b = await createMeter(fixture);

    assert.equal((await bind(a.id, b.id)).status, 201);

    const circular = await bind(b.id, a.id);
    assert.equal(circular.status, 400, JSON.stringify(circular.body));
    assert.equal(circular.body.error.code, 'UTILITY_METER_HIERARCHY_CIRCULAR');
  });

  it('rejects a multi-level circular hierarchy (A → B → C, then C → A)', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const a = await createMeter(fixture);
    const b = await createMeter(fixture);
    const c = await createMeter(fixture);

    assert.equal((await bind(a.id, b.id)).status, 201);
    assert.equal((await bind(b.id, c.id)).status, 201);

    // Binding A beneath C would close the loop A → B → C → A.
    const circular = await bind(c.id, a.id);
    assert.equal(circular.status, 400, JSON.stringify(circular.body));
    assert.equal(circular.body.error.code, 'UTILITY_METER_HIERARCHY_CIRCULAR');
  });

  it('rejects a utility type mismatch', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const electricity = await createMeter(fixture, { utilityType: 'ELECTRICITY' });
    const water = await createMeter(fixture, { utilityType: 'WATER' });

    const response = await bind(electricity.id, water.id);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_HIERARCHY_UTILITY_MISMATCH',
    );

    // The compatible pair binds fine, proving only the mismatch was rejected.
    const gasA = await createMeter(fixture, { utilityType: 'GAS' });
    const gasB = await createMeter(fixture, { utilityType: 'GAS' });
    assert.equal((await bind(gasA.id, gasB.id)).status, 201);
  });

  it('rejects a duplicate active relationship for the same sub meter', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const otherMain = await createMeter(fixture);
    const sub = await createMeter(fixture);

    assert.equal((await bind(main.id, sub.id)).status, 201);

    const samePair = await bind(main.id, sub.id);
    assert.equal(samePair.status, 409, JSON.stringify(samePair.body));
    assert.equal(
      samePair.body.error.code,
      'UTILITY_METER_HIERARCHY_ALREADY_EXISTS',
    );

    // A second main meter cannot claim a sub meter that is already bound.
    const conflicting = await bind(otherMain.id, sub.id);
    assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
    assert.equal(
      conflicting.body.error.code,
      'UTILITY_METER_HIERARCHY_ALREADY_EXISTS',
    );
  });

  it('rejects an invalid meter reference', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);

    const unknownSub = await bind(main.id, randomUUID());
    assert.equal(unknownSub.status, 404, JSON.stringify(unknownSub.body));
    assert.equal(unknownSub.body.error.code, 'UTILITY_METER_NOT_FOUND');

    const unknownMain = await bind(randomUUID(), main.id);
    assert.equal(unknownMain.status, 404, JSON.stringify(unknownMain.body));
    assert.equal(unknownMain.body.error.code, 'UTILITY_METER_NOT_FOUND');

    const malformed = await api()
      .post(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth())
      .send({ subMeterId: 'not-a-uuid' });
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    const unknownHierarchy = await api()
      .get(`/api/v1/utility/meter-hierarchies/${randomUUID()}`)
      .set(auth());
    assert.equal(unknownHierarchy.status, 404);
    assert.equal(
      unknownHierarchy.body.error.code,
      'UTILITY_METER_HIERARCHY_NOT_FOUND',
    );
  });

  it('rejects an inactive meter on an active relationship', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const inactiveSub = await createMeter(fixture, { status: 'INACTIVE' });

    const response = await bind(main.id, inactiveSub.id);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_INACTIVE');
  });

  it('rejects an effective window that ends before it starts', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);

    const response = await bind(main.id, sub.id, {
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'effectiveUntil',
      ),
    );
  });
});

describe('BE-18C main / sub meter — cross client and building', () => {
  it('rejects binding meters from different clients', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await createStructure();
    const second = await createStructure();
    const main = await createMeter(first);
    const foreignSub = await createMeter(second);

    const response = await bind(main.id, foreignSub.id);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_HIERARCHY_CLIENT_MISMATCH',
    );
  });

  it('rejects binding meters from different buildings of the same client', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const sibling = await buildingService.createBuilding({
      propertyId: fixture.property.id,
      code: `BLDG_${suffix()}`,
      name: 'Sibling building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: sibling.id,
    });

    const main = await createMeter(fixture);
    const otherBuildingSub = await createMeter(fixture, {
      buildingId: sibling.id,
    });

    const response = await bind(main.id, otherBuildingSub.id);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_HIERARCHY_BUILDING_MISMATCH',
    );
  });

  it('denies access to meters in a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);
    const created = await bind(main.id, sub.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const fetched = await api()
      .get(`/api/v1/utility/meter-hierarchies/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));
    assert.equal(fetched.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api()
      .get(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403, JSON.stringify(listed.body));

    const bound = await bind(main.id, sub.id, {}, outsider.token);
    assert.equal(bound.status, 403, JSON.stringify(bound.body));

    const ended = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${created.body.data.id}/end`)
      .set(auth(outsider.token))
      .send({});
    assert.equal(ended.status, 403, JSON.stringify(ended.body));
  });
});

describe('BE-18C main / sub meter — end and update relationship', () => {
  it('ends a relationship, preserves history, and frees the sub meter', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const newMain = await createMeter(fixture);
    const sub = await createMeter(fixture);

    const created = await bind(main.id, sub.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const hierarchyId = created.body.data.id;

    const ended = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${hierarchyId}/end`)
      .set(auth())
      .send({ effectiveUntil: '2026-03-31T00:00:00.000Z' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.data.status, 'INACTIVE');
    assert.equal(ended.body.data.effectiveUntil, '2026-03-31T00:00:00.000Z');

    // The sub meter no longer resolves to a main meter...
    const resolved = await api()
      .get(`/api/v1/utility/meters/${sub.id}/main-meter`)
      .set(auth());
    assert.equal(resolved.body.data, null);

    // ...but the ended relationship is retained as history, never deleted.
    const history = await api()
      .get(`/api/v1/utility/meters/${sub.id}/main-meter-history`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].id, hierarchyId);
    assert.equal(history.body.data[0].status, 'INACTIVE');

    // Freed, the sub meter can be re-bound to a different main meter, and the
    // old relationship still stands alongside the new one.
    const rebound = await bind(newMain.id, sub.id);
    assert.equal(rebound.status, 201, JSON.stringify(rebound.body));

    const fullHistory = await api()
      .get(`/api/v1/utility/meters/${sub.id}/main-meter-history`)
      .set(auth());
    assert.equal(fullHistory.body.data.length, 2);
    assert.equal(
      fullHistory.body.data.filter(
        (entry: { status: string }) => entry.status === 'ACTIVE',
      ).length,
      1,
    );
  });

  it('updates the effective window and rejects an immutable meter change', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);
    const created = await bind(main.id, sub.id, {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    const hierarchyId = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${hierarchyId}`)
      .set(auth())
      .send({ effectiveUntil: '2026-12-31T00:00:00.000Z' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.effectiveUntil, '2026-12-31T00:00:00.000Z');
    assert.equal(updated.body.data.status, 'ACTIVE');

    // A partial update must not be able to invert the stored window.
    const inverted = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${hierarchyId}`)
      .set(auth())
      .send({ effectiveUntil: '2025-01-01T00:00:00.000Z' });
    assert.equal(inverted.status, 400, JSON.stringify(inverted.body));
    assert.equal(inverted.body.error.code, 'VALIDATION_ERROR');

    const immutable = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${hierarchyId}`)
      .set(auth())
      .send({ mainMeterId: randomUUID() });
    assert.equal(immutable.status, 400, JSON.stringify(immutable.body));
    assert.ok(
      immutable.body.error.details.some(
        (detail: { field: string }) => detail.field === 'mainMeterId',
      ),
    );
  });

  it('rejects re-activating a relationship while another is active', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const newMain = await createMeter(fixture);
    const sub = await createMeter(fixture);

    const first = await bind(main.id, sub.id);
    const firstId = first.body.data.id;

    await api()
      .patch(`/api/v1/utility/meter-hierarchies/${firstId}/end`)
      .set(auth())
      .send({});
    assert.equal((await bind(newMain.id, sub.id)).status, 201);

    const reactivated = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${firstId}`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 409, JSON.stringify(reactivated.body));
    assert.equal(
      reactivated.body.error.code,
      'UTILITY_METER_HIERARCHY_ALREADY_EXISTS',
    );
  });
});

describe('BE-18C main / sub meter — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);

    const created = await api()
      .post(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .send({ subMeterId: sub.id });
    assert.equal(created.status, 401);

    const listed = await api().get(`/api/v1/utility/meters/${main.id}/sub-meters`);
    assert.equal(listed.status, 401);
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);
    const plainToken = await createPlainSession();

    const created = await bind(main.id, sub.id, {}, plainToken);
    assert.equal(created.status, 403, JSON.stringify(created.body));

    const listed = await api()
      .get(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth(plainToken));
    assert.equal(listed.status, 403);

    const resolved = await api()
      .get(`/api/v1/utility/meters/${sub.id}/main-meter`)
      .set(auth(plainToken));
    assert.equal(resolved.status, 403);

    const patched = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${randomUUID()}`)
      .set(auth(plainToken))
      .send({ status: 'INACTIVE' });
    assert.equal(patched.status, 403);
  });
});
