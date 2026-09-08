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
import { functionalLocationService } from '../src/modules/functional-locations';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import {
  isValidUtilityMeterCode,
  normalizeUtilityMeterCode,
} from '../src/modules/utility-meters';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-18A — Meter Master focused validation.
 *
 * Covers only this PART: create / get / update / status change, duplicate
 * meter code within Client scope, utility type + BE-07 UOM validation,
 * Building / location validation, RBAC, and Client / Building isolation.
 *
 * Main/Sub meter, Tenant meter, readings, consumption and billing are out of
 * scope and are deliberately not exercised here.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
// A privileged setup user that always owns the fixture Building. It exists so
// shared fixture data (e.g. UOM, whose Client access is derived from Building
// assignments) can be seeded deterministically even when a test deliberately
// leaves `adminUserId` unassigned to the Building under test.
let setupToken = '';
let setupUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE utility_meters, units_of_measure, functional_locations, spaces,
       rooms, areas, floors, user_building_assignments, buildings, properties,
       users, roles, permissions, role_permission_assignments,
       user_role_assignments, clients CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const setup = await createAdminUser();
  setupToken = setup.token;
  setupUserId = setup.userId;
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

async function createUom(
  clientId: string,
  options: { status?: 'ACTIVE' | 'INACTIVE'; symbol?: string } = {},
) {
  // UOM is Client-scoped and access is derived from Building assignments, so
  // seed it with the setup user (always assigned to the fixture Building).
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth(setupToken))
    .send({
      code: `UOM_${suffix()}`,
      name: 'Kilowatt hour',
      symbol: options.symbol ?? 'kWh',
      category: 'ENERGY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  if (options.status === 'INACTIVE') {
    const patched = await api()
      .patch(`/api/v1/uoms/${created.body.data.id}`)
      .set(auth(setupToken))
      .send({ status: 'INACTIVE' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }

  return created.body.data.id as string;
}

/** Client → Property → Building → Floor → Area → Room → Space + Functional Location. */
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
  const functionalLocation = await functionalLocationService.createFunctionalLocation({
    buildingId: building.id,
    code: `FLOC_${suffix()}`,
    name: 'Main electrical riser',
    spaceId: space.id,
  });

  // The setup user is always assigned so shared fixture data can be seeded.
  await buildingAssignmentService.createAssignment(setupUserId, {
    buildingId: building.id,
  });

  // The actor under test is assigned only when requested, so Building-access
  // isolation cases can deliberately leave them unassigned.
  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const uomId = await createUom(client.id);

  return { client, property, building, floor, area, room, space, functionalLocation, uomId };
}

function meterPayload(uomId: string, overrides: Record<string, unknown> = {}) {
  return {
    code: `MTR_${suffix()}`,
    name: 'Main incoming meter',
    utilityType: 'ELECTRICITY',
    uomId,
    ...overrides,
  };
}

describe('BE-18A Meter Master — create / get / update', () => {
  it('creates a meter, derives client scope, and returns it on get', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const payload = meterPayload(fixture.uomId, {
      serialNumber: 'SN-0001-XY',
      spaceId: fixture.space.id,
      functionalLocationId: fixture.functionalLocation.id,
    });

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(payload);

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.success, true);
    const meter = created.body.data;
    assert.equal(meter.code, payload.code);
    assert.equal(meter.name, 'Main incoming meter');
    assert.equal(meter.utilityType, 'ELECTRICITY');
    assert.equal(meter.uomId, fixture.uomId);
    assert.equal(meter.serialNumber, 'SN-0001-XY');
    assert.equal(meter.status, 'ACTIVE');
    assert.equal(meter.buildingId, fixture.building.id);
    assert.equal(meter.spaceId, fixture.space.id);
    assert.equal(meter.functionalLocationId, fixture.functionalLocation.id);
    // Client is derived through Building → Property → Client, never supplied.
    assert.equal(meter.clientId, fixture.client.id);
    // BE-07 UOM is referenced and resolved, never duplicated.
    assert.equal(meter.uom.id, fixture.uomId);
    assert.equal(meter.uom.symbol, 'kWh');

    const fetched = await api()
      .get(`/api/v1/utility/meters/${meter.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, meter.id);
    assert.equal(fetched.body.data.code, payload.code);
  });

  it('normalizes the meter code and accepts a meter without optional fields', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const rawCode = `mtr_${suffix().toLowerCase()}`;

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send({
        code: rawCode,
        name: 'Water meter',
        utilityType: 'water',
        uomId: fixture.uomId,
      });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.code, rawCode.toUpperCase());
    assert.equal(created.body.data.utilityType, 'WATER');
    assert.equal(created.body.data.serialNumber, null);
    assert.equal(created.body.data.spaceId, null);
    assert.equal(created.body.data.functionalLocationId, null);
  });

  it('updates mutable attributes and changes status', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const otherUomId = await createUom(fixture.client.id, { symbol: 'm3' });

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const meterId = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/utility/meters/${meterId}`)
      .set(auth())
      .send({
        name: 'Renamed meter',
        utilityType: 'GAS',
        uomId: otherUomId,
        serialNumber: 'SN-UPDATED',
        spaceId: fixture.space.id,
      });

    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.name, 'Renamed meter');
    assert.equal(updated.body.data.utilityType, 'GAS');
    assert.equal(updated.body.data.uomId, otherUomId);
    assert.equal(updated.body.data.serialNumber, 'SN-UPDATED');
    assert.equal(updated.body.data.spaceId, fixture.space.id);
    // Code and Building remain immutable in BE-18A.
    assert.equal(updated.body.data.code, created.body.data.code);
    assert.equal(updated.body.data.buildingId, fixture.building.id);

    const deactivated = await api()
      .patch(`/api/v1/utility/meters/${meterId}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Inactive meters are preserved, never hard-deleted.
    const stillReadable = await api()
      .get(`/api/v1/utility/meters/${meterId}`)
      .set(auth());
    assert.equal(stillReadable.status, 200);
    assert.equal(stillReadable.body.data.status, 'INACTIVE');

    const clearedSerial = await api()
      .patch(`/api/v1/utility/meters/${meterId}`)
      .set(auth())
      .send({ serialNumber: null, spaceId: null });
    assert.equal(clearedSerial.status, 200, JSON.stringify(clearedSerial.body));
    assert.equal(clearedSerial.body.data.serialNumber, null);
    assert.equal(clearedSerial.body.data.spaceId, null);
  });

  it('returns 404 for an unknown meter id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/utility/meters/${randomUUID()}`)
      .set(auth());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'UTILITY_METER_NOT_FOUND');
  });
});

describe('BE-18A Meter Master — list / search / filter', () => {
  it('lists meters by building and by client with filters', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const electricity = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(
        meterPayload(fixture.uomId, {
          name: 'Electric main',
          serialNumber: 'ELEC-777',
        }),
      );
    assert.equal(electricity.status, 201, JSON.stringify(electricity.body));

    const water = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(
        meterPayload(fixture.uomId, {
          name: 'Water main',
          utilityType: 'WATER',
        }),
      );
    assert.equal(water.status, 201, JSON.stringify(water.body));

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.equal(byBuilding.body.data.length, 2);

    const filteredByType = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/utility-meters?utilityType=WATER`)
      .set(auth());
    assert.equal(filteredByType.status, 200);
    assert.equal(filteredByType.body.data.length, 1);
    assert.equal(filteredByType.body.data[0].utilityType, 'WATER');

    const searched = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/utility-meters?search=ELEC-777`)
      .set(auth());
    assert.equal(searched.status, 200);
    assert.equal(searched.body.data.length, 1);
    assert.equal(searched.body.data[0].serialNumber, 'ELEC-777');

    const byClient = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-meters`)
      .set(auth());
    assert.equal(byClient.status, 200, JSON.stringify(byClient.body));
    assert.equal(byClient.body.data.length, 2);

    const byClientAndBuilding = await api()
      .get(
        `/api/v1/clients/${fixture.client.id}/utility-meters?buildingId=${fixture.building.id}&status=ACTIVE`,
      )
      .set(auth());
    assert.equal(byClientAndBuilding.status, 200);
    assert.equal(byClientAndBuilding.body.data.length, 2);
  });

  it('rejects an unknown filter value instead of silently ignoring it', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/utility-meters?utilityType=STEAM`)
      .set(auth());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18A Meter Master — duplicate meter code', () => {
  it('rejects a duplicate code within the same client', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const payload = meterPayload(fixture.uomId);

    const first = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(payload);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send({ ...payload, name: 'Another meter' });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'UTILITY_METER_CODE_ALREADY_EXISTS');

    // Case-insensitive: the normalized code collides too.
    const lowercaseDuplicate = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send({ ...payload, code: payload.code.toLowerCase() });
    assert.equal(lowercaseDuplicate.status, 409);
    assert.equal(
      lowercaseDuplicate.body.error.code,
      'UTILITY_METER_CODE_ALREADY_EXISTS',
    );
  });

  it('rejects a duplicate code across buildings of the SAME client', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const siblingBuilding = await buildingService.createBuilding({
      propertyId: fixture.property.id,
      code: `BLDG_${suffix()}`,
      name: 'Sibling building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: siblingBuilding.id,
    });

    const payload = meterPayload(fixture.uomId);
    const first = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(payload);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const sameCodeOtherBuilding = await api()
      .post(`/api/v1/buildings/${siblingBuilding.id}/utility-meters`)
      .set(auth())
      .send(payload);
    assert.equal(sameCodeOtherBuilding.status, 409, JSON.stringify(sameCodeOtherBuilding.body));
    assert.equal(
      sameCodeOtherBuilding.body.error.code,
      'UTILITY_METER_CODE_ALREADY_EXISTS',
    );
  });

  it('allows the same code under a DIFFERENT client', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await createStructure();
    const second = await createStructure();
    const sharedCode = `MTR_${suffix()}`;

    const created = await api()
      .post(`/api/v1/buildings/${first.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(first.uomId, { code: sharedCode }));
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const other = await api()
      .post(`/api/v1/buildings/${second.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(second.uomId, { code: sharedCode }));
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.notEqual(other.body.data.clientId, created.body.data.clientId);
  });
});

describe('BE-18A Meter Master — utility type and UOM validation', () => {
  it('rejects an unsupported utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, { utilityType: 'STEAM' }));

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'utilityType',
      ),
    );
  });

  it('accepts each of ELECTRICITY, WATER, and GAS', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    for (const utilityType of ['ELECTRICITY', 'WATER', 'GAS']) {
      const created = await api()
        .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
        .set(auth())
        .send(meterPayload(fixture.uomId, { utilityType }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.utilityType, utilityType);
    }
  });

  it('requires a UOM reference', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send({
        code: `MTR_${suffix()}`,
        name: 'No UOM meter',
        utilityType: 'ELECTRICITY',
      });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'uomId',
      ),
    );
  });

  it('rejects an unknown, inactive, or cross-client UOM', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const unknown = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(randomUUID()));
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'UTILITY_METER_UOM_NOT_FOUND');

    const inactiveUomId = await createUom(fixture.client.id, { status: 'INACTIVE' });
    const inactive = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(inactiveUomId));
    assert.equal(inactive.status, 400, JSON.stringify(inactive.body));
    assert.equal(inactive.body.error.code, 'UTILITY_METER_UOM_INACTIVE');

    const otherClient = await createStructure();
    const crossClient = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(otherClient.uomId));
    assert.equal(crossClient.status, 400, JSON.stringify(crossClient.body));
    assert.equal(crossClient.body.error.code, 'UTILITY_METER_UOM_CLIENT_MISMATCH');
  });

  it('rejects a cross-client UOM on update', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const otherClient = await createStructure();

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId));
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const response = await api()
      .patch(`/api/v1/utility/meters/${created.body.data.id}`)
      .set(auth())
      .send({ uomId: otherClient.uomId });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_UOM_CLIENT_MISMATCH');
  });
});

describe('BE-18A Meter Master — building and location validation', () => {
  it('rejects an unknown building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await api()
      .post(`/api/v1/buildings/${randomUUID()}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId));

    // An unknown Building is never in the actor's accessible set.
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects a malformed building id with a validation error', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await api()
      .post('/api/v1/buildings/not-a-uuid/utility-meters')
      .set(auth())
      .send(meterPayload(fixture.uomId));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a space belonging to a different building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const other = await createStructure();

    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, { spaceId: other.space.id }));

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_LOCATION_MISMATCH');
  });

  it('rejects a functional location belonging to a different building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const other = await createStructure();

    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(
        meterPayload(fixture.uomId, {
          functionalLocationId: other.functionalLocation.id,
        }),
      );

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_LOCATION_MISMATCH');
  });

  it('rejects unknown space and functional location references', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const unknownSpace = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, { spaceId: randomUUID() }));
    assert.equal(unknownSpace.status, 404, JSON.stringify(unknownSpace.body));
    assert.equal(unknownSpace.body.error.code, 'SPACE_NOT_FOUND');

    const unknownLocation = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, { functionalLocationId: randomUUID() }));
    assert.equal(unknownLocation.status, 404, JSON.stringify(unknownLocation.body));
    assert.equal(
      unknownLocation.body.error.code,
      'FUNCTIONAL_LOCATION_NOT_FOUND',
    );
  });

  it('rejects a cross-building location on update', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const other = await createStructure();

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId));
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const response = await api()
      .patch(`/api/v1/utility/meters/${created.body.data.id}`)
      .set(auth())
      .send({ spaceId: other.space.id });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_LOCATION_MISMATCH');
  });
});

describe('BE-18A Meter Master — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .send(meterPayload(fixture.uomId));
    assert.equal(created.status, 401);

    const listed = await api().get(
      `/api/v1/buildings/${fixture.building.id}/utility-meters`,
    );
    assert.equal(listed.status, 401);
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const plainToken = await createPlainSession();

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth(plainToken))
      .send(meterPayload(fixture.uomId));
    assert.equal(created.status, 403, JSON.stringify(created.body));

    const listed = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth(plainToken));
    assert.equal(listed.status, 403);

    const patched = await api()
      .patch(`/api/v1/utility/meters/${randomUUID()}`)
      .set(auth(plainToken))
      .send({ name: 'Nope' });
    assert.equal(patched.status, 403);
  });
});

describe('BE-18A Meter Master — client and building isolation', () => {
  it('denies access to a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    // Structure created WITHOUT a building assignment for the admin.
    const unassigned = await createStructure({ assignUserId: null });

    const created = await api()
      .post(`/api/v1/buildings/${unassigned.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(unassigned.uomId));
    assert.equal(created.status, 403, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api()
      .get(`/api/v1/buildings/${unassigned.building.id}/utility-meters`)
      .set(auth());
    assert.equal(listed.status, 403);
    assert.equal(listed.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading a meter from a building the user cannot access', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const meterId = created.body.data.id;

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const fetched = await api()
      .get(`/api/v1/utility/meters/${meterId}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));
    assert.equal(fetched.body.error.code, 'BUILDING_ACCESS_DENIED');

    const patched = await api()
      .patch(`/api/v1/utility/meters/${meterId}`)
      .set(auth(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(patched.status, 403);

    const statusChanged = await api()
      .patch(`/api/v1/utility/meters/${meterId}/status`)
      .set(auth(outsider.token))
      .send({ status: 'INACTIVE' });
    assert.equal(statusChanged.status, 403);
  });

  it('denies client-scoped listing for an unrelated client', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const outsider = await createAdminUser();

    const response = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-meters`)
      .set(auth(outsider.token));
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects a building that belongs to another client in client-scoped listing', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const other = await createStructure();

    const response = await api()
      .get(
        `/api/v1/clients/${fixture.client.id}/utility-meters?buildingId=${other.building.id}`,
      )
      .set(auth());
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_LOCATION_MISMATCH');
  });
});

describe('BE-18A Meter Master — code helpers', () => {
  it('normalizes and validates meter codes', () => {
    assert.equal(normalizeUtilityMeterCode('  mtr-01 '), 'MTR-01');
    assert.equal(isValidUtilityMeterCode('MTR-01'), true);
    assert.equal(isValidUtilityMeterCode('M'), false);
    assert.equal(isValidUtilityMeterCode('1MTR'), false);
    assert.equal(isValidUtilityMeterCode('MTR 01'), false);
  });
});
