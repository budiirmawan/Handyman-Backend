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
 * BE-18B — Electricity / Water / Gas focused validation.
 *
 * Covers only this PART: utility type configuration per Client (ELECTRICITY,
 * WATER, GAS), the allowed BE-07 UOM mapping, rejection of invalid utility
 * types and invalid utility type / UOM combinations on BE-18A Meters,
 * configuration update, Meter filtering by utility type, RBAC, and
 * Client / Building isolation.
 *
 * Main/Sub meter, Tenant meter, readings, consumption and billing are out of
 * scope and are deliberately not exercised here.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
// Privileged setup user always assigned to the fixture Building, used to
// seed Client-scoped fixture data (e.g. UOM) even when the actor under test
// is deliberately left unassigned to the Building — mirrors the pattern
// established in tests/utility-meters.test.ts and tests/utility-tenant-approvals.test.ts
// (CR-BE-TEST-01).
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
    `TRUNCATE utility_type_uoms, utility_type_configurations, utility_meters,
       units_of_measure, functional_locations, spaces, rooms, areas, floors,
       user_building_assignments, buildings, properties, users, roles,
       permissions, role_permission_assignments, user_role_assignments,
       clients CASCADE`,
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
  // seed it with the setup user (always assigned to the fixture Building)
  // even when the actor under test is deliberately left unassigned.
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth(setupToken))
    .send({
      code: `UOM_${suffix()}`,
      name: 'Measurement unit',
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
  // The setup user is always assigned so shared fixture data (e.g. UOM) can
  // be seeded by `createUom` regardless of the actor-under-test assignment.
  await buildingAssignmentService.createAssignment(setupUserId, {
    buildingId: building.id,
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const uomId = await createUom(client.id);

  return { client, property, building, floor, area, room, space, uomId };
}

function configPayload(
  utilityType: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    utilityType,
    name: `${utilityType} configuration`,
    ...overrides,
  };
}

async function createConfiguration(
  clientId: string,
  utilityType: string,
  overrides: Record<string, unknown> = {},
) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/utility-type-configurations`)
    .set(auth())
    .send(configPayload(utilityType, overrides));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data;
}

function meterPayload(
  uomId: string,
  utilityType: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    code: `MTR_${suffix()}`,
    name: 'Utility meter',
    utilityType,
    uomId,
    ...overrides,
  };
}

describe('BE-18B utility type configuration — ELECTRICITY / WATER / GAS', () => {
  it('configures ELECTRICITY with an allowed BE-07 UOM and a default', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const secondUomId = await createUom(fixture.client.id, { symbol: 'MWh' });

    const created = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(
        configPayload('ELECTRICITY', {
          name: 'Electricity',
          description: 'Electrical energy consumption',
          decimalPrecision: 2,
          uomIds: [fixture.uomId, secondUomId],
          defaultUomId: fixture.uomId,
        }),
      );

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const configuration = created.body.data;
    assert.equal(configuration.clientId, fixture.client.id);
    assert.equal(configuration.utilityType, 'ELECTRICITY');
    assert.equal(configuration.name, 'Electricity');
    assert.equal(configuration.description, 'Electrical energy consumption');
    assert.equal(configuration.decimalPrecision, 2);
    assert.equal(configuration.status, 'ACTIVE');
    assert.equal(configuration.allowedUoms.length, 2);
    assert.equal(configuration.defaultUomId, fixture.uomId);
    // BE-07 UOM is referenced and resolved, never duplicated.
    const defaultMapping = configuration.allowedUoms.find(
      (entry: { isDefault: boolean }) => entry.isDefault,
    );
    assert.equal(defaultMapping.uomId, fixture.uomId);
    assert.equal(defaultMapping.uom.symbol, 'kWh');

    const fetched = await api()
      .get(`/api/v1/utility/type-configurations/${configuration.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, configuration.id);
    assert.equal(fetched.body.data.utilityType, 'ELECTRICITY');
  });

  it('configures WATER independently of the other utility types', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const waterUomId = await createUom(fixture.client.id, { symbol: 'm3' });

    const configuration = await createConfiguration(fixture.client.id, 'WATER', {
      name: 'Water',
      decimalPrecision: 3,
      uomIds: [waterUomId],
      defaultUomId: waterUomId,
    });

    assert.equal(configuration.utilityType, 'WATER');
    assert.equal(configuration.decimalPrecision, 3);
    assert.equal(configuration.allowedUoms.length, 1);
    assert.equal(configuration.allowedUoms[0].uomId, waterUomId);
    assert.equal(configuration.defaultUomId, waterUomId);
  });

  it('configures GAS and normalizes a lowercase utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const gasUomId = await createUom(fixture.client.id, { symbol: 'Nm3' });

    const configuration = await createConfiguration(fixture.client.id, 'gas', {
      name: 'Gas',
      uomIds: [gasUomId],
    });

    assert.equal(configuration.utilityType, 'GAS');
    assert.equal(configuration.allowedUoms.length, 1);
    // No default was requested, so none is reported.
    assert.equal(configuration.defaultUomId, null);
  });

  it('lists the three configurations for a client and filters them', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    await createConfiguration(fixture.client.id, 'ELECTRICITY', {
      uomIds: [fixture.uomId],
    });
    await createConfiguration(fixture.client.id, 'WATER');
    const gas = await createConfiguration(fixture.client.id, 'GAS');

    const listed = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.data.map((entry: { utilityType: string }) => entry.utilityType),
      ['ELECTRICITY', 'GAS', 'WATER'],
    );

    const filtered = await api()
      .get(
        `/api/v1/clients/${fixture.client.id}/utility-type-configurations?utilityType=WATER`,
      )
      .set(auth());
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].utilityType, 'WATER');

    await api()
      .patch(`/api/v1/utility/type-configurations/${gas.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });

    const activeOnly = await api()
      .get(
        `/api/v1/clients/${fixture.client.id}/utility-type-configurations?status=ACTIVE`,
      )
      .set(auth());
    assert.equal(activeOnly.status, 200, JSON.stringify(activeOnly.body));
    assert.deepEqual(
      activeOnly.body.data.map((entry: { utilityType: string }) => entry.utilityType),
      ['ELECTRICITY', 'WATER'],
    );
  });

  it('rejects a duplicate configuration for the same client and utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    await createConfiguration(fixture.client.id, 'ELECTRICITY');

    const duplicate = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('ELECTRICITY', { name: 'Duplicate' }));

    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'UTILITY_TYPE_CONFIGURATION_ALREADY_EXISTS',
    );
  });

  it('allows the same utility type under a DIFFERENT client', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await createStructure();
    const second = await createStructure();

    const a = await createConfiguration(first.client.id, 'ELECTRICITY');
    const b = await createConfiguration(second.client.id, 'ELECTRICITY');
    assert.notEqual(a.clientId, b.clientId);
  });
});

describe('BE-18B utility type configuration — invalid input', () => {
  it('rejects an unsupported utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('STEAM'));

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'utilityType',
      ),
    );
  });

  it('rejects an unknown, inactive, or cross-client UOM mapping', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const other = await createStructure();

    const unknown = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('ELECTRICITY', { uomIds: [randomUUID()] }));
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'UTILITY_METER_UOM_NOT_FOUND');

    const foreign = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('ELECTRICITY', { uomIds: [other.uomId] }));
    assert.equal(foreign.status, 400, JSON.stringify(foreign.body));
    assert.equal(foreign.body.error.code, 'UTILITY_METER_UOM_CLIENT_MISMATCH');

    const inactiveUomId = await createUom(fixture.client.id, {
      status: 'INACTIVE',
    });
    const inactive = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('ELECTRICITY', { uomIds: [inactiveUomId] }));
    assert.equal(inactive.status, 400, JSON.stringify(inactive.body));
    assert.equal(inactive.body.error.code, 'UTILITY_METER_UOM_INACTIVE');

    // A rejected mapping must not leave a half-created configuration behind.
    const listed = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth());
    assert.equal(listed.body.data.length, 0);
  });

  it('rejects an out-of-range precision and a default outside uomIds', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const precision = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('WATER', { decimalPrecision: 9 }));
    assert.equal(precision.status, 400, JSON.stringify(precision.body));
    assert.ok(
      precision.body.error.details.some(
        (detail: { field: string }) => detail.field === 'decimalPrecision',
      ),
    );

    const strayDefault = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send(
        configPayload('WATER', {
          uomIds: [fixture.uomId],
          defaultUomId: randomUUID(),
        }),
      );
    assert.equal(strayDefault.status, 400, JSON.stringify(strayDefault.body));
    assert.ok(
      strayDefault.body.error.details.some(
        (detail: { field: string }) => detail.field === 'defaultUomId',
      ),
    );
  });

  it('returns 404 for an unknown configuration', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/utility/type-configurations/${randomUUID()}`)
      .set(auth());
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_TYPE_CONFIGURATION_NOT_FOUND');
  });
});

describe('BE-18B utility type configuration — update and UOM mapping', () => {
  it('updates metadata and status but keeps the utility type immutable', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const configuration = await createConfiguration(
      fixture.client.id,
      'ELECTRICITY',
    );

    const updated = await api()
      .patch(`/api/v1/utility/type-configurations/${configuration.id}`)
      .set(auth())
      .send({
        name: 'Electricity (renamed)',
        description: 'Updated description',
        decimalPrecision: 4,
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.name, 'Electricity (renamed)');
    assert.equal(updated.body.data.description, 'Updated description');
    assert.equal(updated.body.data.decimalPrecision, 4);
    assert.equal(updated.body.data.utilityType, 'ELECTRICITY');

    const immutable = await api()
      .patch(`/api/v1/utility/type-configurations/${configuration.id}`)
      .set(auth())
      .send({ utilityType: 'GAS' });
    assert.equal(immutable.status, 400, JSON.stringify(immutable.body));
    assert.ok(
      immutable.body.error.details.some(
        (detail: { field: string }) => detail.field === 'utilityType',
      ),
    );

    const deactivated = await api()
      .patch(`/api/v1/utility/type-configurations/${configuration.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');
  });

  it('adds an allowed UOM, moves the default, and retires a mapping', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const configuration = await createConfiguration(
      fixture.client.id,
      'ELECTRICITY',
      { uomIds: [fixture.uomId], defaultUomId: fixture.uomId },
    );
    const secondUomId = await createUom(fixture.client.id, { symbol: 'MWh' });

    const added = await api()
      .post(`/api/v1/utility/type-configurations/${configuration.id}/uoms`)
      .set(auth())
      .send({ uomId: secondUomId, isDefault: true });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.data.allowedUoms.length, 2);
    // Promoting the new mapping demoted the previous default.
    assert.equal(added.body.data.defaultUomId, secondUomId);

    const duplicate = await api()
      .post(`/api/v1/utility/type-configurations/${configuration.id}/uoms`)
      .set(auth())
      .send({ uomId: secondUomId });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'UTILITY_TYPE_UOM_ALREADY_MAPPED');

    const retired = await api()
      .patch(
        `/api/v1/utility/type-configurations/${configuration.id}/uoms/${secondUomId}`,
      )
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    // An INACTIVE mapping can never remain the default.
    assert.equal(retired.body.data.defaultUomId, null);

    const unknownMapping = await api()
      .patch(
        `/api/v1/utility/type-configurations/${configuration.id}/uoms/${randomUUID()}`,
      )
      .set(auth())
      .send({ isDefault: true });
    assert.equal(unknownMapping.status, 404, JSON.stringify(unknownMapping.body));
    assert.equal(
      unknownMapping.body.error.code,
      'UTILITY_TYPE_UOM_MAPPING_NOT_FOUND',
    );
  });

  it('rejects mapping a UOM that belongs to another client', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const other = await createStructure();
    const configuration = await createConfiguration(fixture.client.id, 'GAS');

    const response = await api()
      .post(`/api/v1/utility/type-configurations/${configuration.id}/uoms`)
      .set(auth())
      .send({ uomId: other.uomId });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_UOM_CLIENT_MISMATCH');
  });
});

describe('BE-18B meter utility classification — valid type / UOM combination', () => {
  it('accepts a meter whose UOM is allowed for its utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    await createConfiguration(fixture.client.id, 'ELECTRICITY', {
      uomIds: [fixture.uomId],
      defaultUomId: fixture.uomId,
    });

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, 'ELECTRICITY'));

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.utilityType, 'ELECTRICITY');
    assert.equal(created.body.data.uomId, fixture.uomId);
  });

  it('rejects a meter whose UOM is not allowed for its utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const waterUomId = await createUom(fixture.client.id, { symbol: 'm3' });

    await createConfiguration(fixture.client.id, 'ELECTRICITY', {
      uomIds: [fixture.uomId],
      defaultUomId: fixture.uomId,
    });
    await createConfiguration(fixture.client.id, 'WATER', {
      uomIds: [waterUomId],
      defaultUomId: waterUomId,
    });

    // A cubic-metre UOM is valid BE-07 data, but not for ELECTRICITY.
    const mismatched = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(waterUomId, 'ELECTRICITY'));
    assert.equal(mismatched.status, 400, JSON.stringify(mismatched.body));
    assert.equal(mismatched.body.error.code, 'UTILITY_TYPE_UOM_NOT_ALLOWED');

    // The same UOM is accepted for WATER.
    const accepted = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(waterUomId, 'WATER'));
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  });

  it('rejects an update that breaks the utility type / UOM combination', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const gasUomId = await createUom(fixture.client.id, { symbol: 'Nm3' });

    await createConfiguration(fixture.client.id, 'ELECTRICITY', {
      uomIds: [fixture.uomId],
    });
    await createConfiguration(fixture.client.id, 'GAS', { uomIds: [gasUomId] });

    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, 'ELECTRICITY'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const meterId = created.body.data.id;

    const invalid = await api()
      .patch(`/api/v1/utility/meters/${meterId}`)
      .set(auth())
      .send({ uomId: gasUomId });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.equal(invalid.body.error.code, 'UTILITY_TYPE_UOM_NOT_ALLOWED');

    // Switching both sides together is a valid combination.
    const valid = await api()
      .patch(`/api/v1/utility/meters/${meterId}`)
      .set(auth())
      .send({ utilityType: 'GAS', uomId: gasUomId });
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
    assert.equal(valid.body.data.utilityType, 'GAS');
    assert.equal(valid.body.data.uomId, gasUomId);
  });

  it('rejects a meter for a deactivated utility type configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const configuration = await createConfiguration(fixture.client.id, 'WATER', {
      uomIds: [fixture.uomId],
    });

    const deactivated = await api()
      .patch(`/api/v1/utility/type-configurations/${configuration.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));

    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, 'WATER'));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_TYPE_CONFIGURATION_INACTIVE',
    );
  });

  it('filters meters by utility type once the client is configured', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const waterUomId = await createUom(fixture.client.id, { symbol: 'm3' });
    await createConfiguration(fixture.client.id, 'ELECTRICITY', {
      uomIds: [fixture.uomId],
    });
    await createConfiguration(fixture.client.id, 'WATER', {
      uomIds: [waterUomId],
    });

    await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(fixture.uomId, 'ELECTRICITY'));
    await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
      .set(auth())
      .send(meterPayload(waterUomId, 'WATER'));

    const water = await api()
      .get(
        `/api/v1/buildings/${fixture.building.id}/utility-meters?utilityType=WATER`,
      )
      .set(auth());
    assert.equal(water.status, 200, JSON.stringify(water.body));
    assert.equal(water.body.data.length, 1);
    assert.equal(water.body.data[0].utilityType, 'WATER');

    const electricity = await api()
      .get(
        `/api/v1/clients/${fixture.client.id}/utility-meters?utilityType=ELECTRICITY`,
      )
      .set(auth());
    assert.equal(electricity.status, 200, JSON.stringify(electricity.body));
    assert.equal(electricity.body.data.length, 1);
    assert.equal(electricity.body.data[0].utilityType, 'ELECTRICITY');
  });
});

describe('BE-18B utility type configuration — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const created = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .send(configPayload('ELECTRICITY'));
    assert.equal(created.status, 401);

    const listed = await api().get(
      `/api/v1/clients/${fixture.client.id}/utility-type-configurations`,
    );
    assert.equal(listed.status, 401);
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const plainToken = await createPlainSession();

    const created = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth(plainToken))
      .send(configPayload('ELECTRICITY'));
    assert.equal(created.status, 403, JSON.stringify(created.body));

    const listed = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth(plainToken));
    assert.equal(listed.status, 403);

    const patched = await api()
      .patch(`/api/v1/utility/type-configurations/${randomUUID()}`)
      .set(auth(plainToken))
      .send({ name: 'Nope' });
    assert.equal(patched.status, 403);
  });
});

describe('BE-18B utility type configuration — client isolation', () => {
  it('denies configuring a client the user has no building assignment for', async (t) => {
    if (!requireDatabase(t)) return;
    const unassigned = await createStructure({ assignUserId: null });

    const created = await api()
      .post(`/api/v1/clients/${unassigned.client.id}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('ELECTRICITY'));
    assert.equal(created.status, 403, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api()
      .get(`/api/v1/clients/${unassigned.client.id}/utility-type-configurations`)
      .set(auth());
    assert.equal(listed.status, 403, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading or updating another client configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const configuration = await createConfiguration(
      fixture.client.id,
      'ELECTRICITY',
      { uomIds: [fixture.uomId] },
    );

    // A second administrator with full RBAC but no assignment to this Client.
    const outsider = await createAdminUser();

    const fetched = await api()
      .get(`/api/v1/utility/type-configurations/${configuration.id}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));
    assert.equal(fetched.body.error.code, 'BUILDING_ACCESS_DENIED');

    const patched = await api()
      .patch(`/api/v1/utility/type-configurations/${configuration.id}`)
      .set(auth(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(patched.status, 403, JSON.stringify(patched.body));

    const mapped = await api()
      .post(`/api/v1/utility/type-configurations/${configuration.id}/uoms`)
      .set(auth(outsider.token))
      .send({ uomId: fixture.uomId });
    assert.equal(mapped.status, 403, JSON.stringify(mapped.body));
  });

  it('rejects an unknown client', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .post(`/api/v1/clients/${randomUUID()}/utility-type-configurations`)
      .set(auth())
      .send(configPayload('ELECTRICITY'));
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });
});
