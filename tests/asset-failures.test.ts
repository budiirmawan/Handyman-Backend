import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { REVIEW_TARGET_UNION } from '../src/database/migrations/0213_restore_review_target_union';
import { areaService } from '../src/modules/areas';
import { assetService } from '../src/modules/assets';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { functionalLocationService } from '../src/modules/functional-locations';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const PAST = '2026-08-01T09:30:00.000Z';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE asset_failure_incidents, operational_incidents,
    incidents, assets, functional_locations, operational_events, reviews,
    spaces, rooms, areas, floors, buildings, properties, users, roles,
    permissions, clients CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

/** Builds Client → Property → Building (→ Floor → Area → Room → Space). */
async function structure(options: {
  client?: PublicClient;
  assignUserId?: string;
  assign?: boolean;
  withRoom?: boolean;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Asset Failure Client',
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
  if (options.assign !== false) {
    await buildingAssignmentService.createAssignment(
      options.assignUserId ?? userId,
      { buildingId: building.id },
    );
  }
  if (!options.withRoom) {
    return { client, building, floor: null, area: null, room: null, space: null };
  }
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
    name: 'Space',
  });
  return { client, building, floor, area, room, space };
}

/** Registers a BE-05 Asset in the given Building. */
async function asset(buildingId: string, overrides: Record<string, unknown> = {}) {
  return assetService.createAsset({
    buildingId,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller Unit',
    ...overrides,
  });
}

function body(
  buildingId: string,
  assetId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    buildingId,
    assetId,
    incidentNumber: `AF_${suffix()}`,
    title: 'Chiller compressor failure',
    failureCategory: 'MECHANICAL_FAILURE',
    occurredAt: PAST,
    ...overrides,
  };
}

const create = (payload: Record<string, unknown>, value = token) =>
  api().post('/api/v1/asset-failures').set(auth(value)).send(payload);

describe('BE-21C — valid Asset Failure / Defect', () => {
  it('creates an Asset Failure on the shared BE-21A foundation', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const equipment = await asset(building.id);

    const response = await create(body(building.id, equipment.id, {
      description: 'Compressor seized under load.',
      severity: 'CRITICAL',
      priority: 'HIGH',
      operationalImpact: 'FULL_OUTAGE',
      notes: 'Backup chiller online.',
    }));

    assert.equal(response.status, 201);
    const data = response.body.data;
    // Foundation fields come from BE-21A.
    assert.equal(data.incidentType, 'ASSET_FAILURE');
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    assert.equal(data.incidentStatus, 'REPORTED');
    assert.equal(data.severity, 'CRITICAL');
    assert.equal(data.reportedByUserId, userId);
    // Specialization fields are BE-21C's.
    assert.equal(data.failureCategory, 'MECHANICAL_FAILURE');
    assert.equal(data.failureStatus, 'OPEN');
    assert.equal(data.operationalImpact, 'FULL_OUTAGE');
    assert.equal(data.occurredAt, PAST);
    assert.equal(data.notes, 'Backup chiller online.');
    // Backend is authoritative for available actions.
    assert.deepEqual(
      [...data.availableActions].sort(),
      ['RESOLVE', 'START_PROGRESS', 'UPDATE_DETAILS'],
    );

    // Exactly one foundation row + one specialization row, sharing identity.
    const rows = await pool!.query(
      `SELECT i.incident_type, af.failure_category, af.asset_id
       FROM incidents i
       JOIN asset_failure_incidents af ON af.incident_id = i.id
       WHERE i.id = $1`,
      [data.id],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].incident_type, 'ASSET_FAILURE');
    assert.equal(rows.rows[0].asset_id, equipment.id);
  });

  it('treats operational impact as optional', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    const response = await create(body(building.id, equipment.id));
    assert.equal(response.status, 201);
    assert.equal(response.body.data.operationalImpact, null);
  });

  it('gets an Asset Failure by the shared Incident id', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));

    const response = await api()
      .get(`/api/v1/asset-failures/${created.body.data.id}`)
      .set(auth());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.asset.id, equipment.id);
  });

  it('filters by Asset, Building, Location, category, severity, status, date', async (t) => {
    if (!ready(t)) return;
    const { building, room } = await structure({ withRoom: true });
    assert.ok(room);
    const chiller = await asset(building.id);
    const pump = await asset(building.id);

    const mech = await create(body(building.id, chiller.id, {
      failureCategory: 'MECHANICAL_FAILURE',
      severity: 'CRITICAL',
      occurredAt: '2026-08-02T10:00:00.000Z',
      locationType: 'ROOM',
      locationId: room.id,
    }));
    const leak = await create(body(building.id, pump.id, {
      failureCategory: 'LEAKAGE',
      severity: 'LOW',
      occurredAt: '2026-08-10T10:00:00.000Z',
      operationalImpact: 'DEGRADED',
    }));
    assert.equal(mech.status, 201);
    assert.equal(leak.status, 201);

    // Scoped to this Building so sibling tests cannot make results ambiguous.
    const ids = async (query: string) => {
      const res = await api()
        .get(`/api/v1/asset-failures?buildingId=${building.id}&${query}`)
        .set(auth());
      assert.equal(res.status, 200);
      return res.body.data.map((item: { id: string }) => item.id);
    };

    assert.deepEqual(await ids(''), [leak.body.data.id, mech.body.data.id]);
    assert.deepEqual(await ids(`assetId=${chiller.id}`), [mech.body.data.id]);
    assert.deepEqual(await ids(`assetId=${pump.id}`), [leak.body.data.id]);
    assert.deepEqual(await ids('failureCategory=LEAKAGE'), [leak.body.data.id]);
    assert.deepEqual(await ids('operationalImpact=DEGRADED'), [leak.body.data.id]);
    assert.deepEqual(await ids('severity=CRITICAL'), [mech.body.data.id]);
    assert.deepEqual(await ids('failureStatus=OPEN'), [
      leak.body.data.id,
      mech.body.data.id,
    ]);
    assert.deepEqual(
      await ids(`locationType=ROOM&locationId=${room.id}`),
      [mech.body.data.id],
    );
    assert.deepEqual(
      await ids('occurredFrom=2026-08-05T00:00:00.000Z'),
      [leak.body.data.id],
    );
    assert.deepEqual(
      await ids('occurredTo=2026-08-05T00:00:00.000Z'),
      [mech.body.data.id],
    );
  });
});

describe('BE-21C — incident_type fixed to ASSET_FAILURE', () => {
  it('rejects a caller-supplied incidentType', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    const response = await create(body(building.id, equipment.id, {
      incidentType: 'OPERATIONAL',
    }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'incidentType',
      ),
    );
  });

  it('always persists ASSET_FAILURE', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));

    const stored = await pool!.query(
      'SELECT incident_type FROM incidents WHERE id = $1',
      [created.body.data.id],
    );
    assert.equal(stored.rows[0].incident_type, 'ASSET_FAILURE');
  });

  it('does not expose an OPERATIONAL Incident through this endpoint', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const operational = await api()
      .post('/api/v1/operational-incidents')
      .set(auth())
      .send({
        buildingId: building.id,
        incidentNumber: `OPS_${suffix()}`,
        title: 'Operational incident',
        operationalCategory: 'HVAC',
        occurredAt: PAST,
      });
    assert.equal(operational.status, 201);

    const response = await api()
      .get(`/api/v1/asset-failures/${operational.body.data.id}`)
      .set(auth());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_FAILURE_NOT_FOUND');
  });

  it('keeps the two specializations disjoint', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));

    // An ASSET_FAILURE Incident must not be reachable as an Operational one.
    const asOperational = await api()
      .get(`/api/v1/operational-incidents/${created.body.data.id}`)
      .set(auth());
    assert.equal(asOperational.status, 404);
  });
});

describe('BE-21C — Asset / Equipment binding', () => {
  it('binds an existing BE-05 Asset and projects it read-only', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id, { assetName: 'Lift Motor' });
    const created = await create(body(building.id, equipment.id));

    const projected = created.body.data.asset;
    assert.equal(projected.id, equipment.id);
    assert.equal(projected.assetCode, equipment.assetCode);
    assert.equal(projected.assetName, 'Lift Motor');
    assert.equal(projected.status, 'ACTIVE');
    assert.equal(projected.buildingId, building.id);
  });

  it('does not duplicate Asset master data in the specialization', async (t) => {
    if (!ready(t)) return;
    const columns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'asset_failure_incidents'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'asset_code', 'asset_name', 'manufacturer', 'model', 'serial_number',
      'asset_status', 'building_id', 'client_id', 'incident_number',
      'severity', 'priority', 'status', 'reported_by_user_id', 'title',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `asset_failure_incidents must not duplicate ${forbidden}`,
      );
    }
  });

  it('reflects live Asset state rather than a stale copy', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));
    assert.equal(created.body.data.asset.status, 'ACTIVE');

    // BE-05 remains the only place the Asset lifecycle moves.
    await assetService.updateAssetStatus(equipment.id, {
      status: 'UNDER_MAINTENANCE',
    });

    const read = await api()
      .get(`/api/v1/asset-failures/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.body.data.asset.status, 'UNDER_MAINTENANCE');
  });

  it('does not drive the Asset lifecycle when a failure is recorded', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    const created = await create(body(building.id, equipment.id, {
      operationalImpact: 'FULL_OUTAGE',
    }));
    assert.equal(created.status, 201);

    // Recording a failure must not silently move the Asset out of service.
    const stored = await pool!.query(
      'SELECT status FROM assets WHERE id = $1',
      [equipment.id],
    );
    assert.equal(stored.rows[0].status, 'ACTIVE');
  });

  it('rejects Asset master data supplied on the failure', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    const response = await create(body(building.id, equipment.id, {
      assetName: 'Renamed via incident',
    }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('refuses to re-point an existing failure at another Asset', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const first = await asset(building.id);
    const second = await asset(building.id);
    const created = await create(body(building.id, first.id));

    const response = await api()
      .patch(`/api/v1/asset-failures/${created.body.data.id}`)
      .set(auth())
      .send({ assetId: second.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('records many failures against one Asset over its life', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    assert.equal((await create(body(building.id, equipment.id))).status, 201);
    assert.equal((await create(body(building.id, equipment.id))).status, 201);

    const listed = await api()
      .get(`/api/v1/asset-failures?assetId=${equipment.id}`)
      .set(auth());
    assert.equal(listed.body.data.length, 2);
  });
});

describe('BE-21C — invalid Asset rejected', () => {
  it('rejects an Asset that does not exist', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await create(body(building.id, randomUUID()));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });

  it('rejects a malformed assetId', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await create(body(building.id, 'not-a-uuid'));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a missing assetId', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const payload = body(building.id, randomUUID());
    delete (payload as Record<string, unknown>).assetId;

    const response = await create(payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a RETIRED Asset', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    await assetService.updateAssetStatus(equipment.id, { status: 'RETIRED' });

    const response = await create(body(building.id, equipment.id));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_FAILURE_ASSET_RETIRED');
  });

  it('accepts an Asset that is merely UNDER_MAINTENANCE', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    await assetService.updateAssetStatus(equipment.id, {
      status: 'UNDER_MAINTENANCE',
    });

    // Equipment being serviced is exactly when defects get recorded.
    const response = await create(body(building.id, equipment.id));
    assert.equal(response.status, 201);
  });

  it('leaves no orphan Incident when the Asset is rejected', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await create(body(building.id, randomUUID()));
    assert.equal(response.status, 404);

    const orphans = await pool!.query(
      `SELECT i.id FROM incidents i
       LEFT JOIN asset_failure_incidents af ON af.incident_id = i.id
       WHERE i.building_id = $1 AND af.id IS NULL`,
      [building.id],
    );
    assert.equal(orphans.rowCount, 0);
  });
});

describe('BE-21C — cross-Client and Building isolation of the Asset', () => {
  it('rejects an Asset owned by another Client', async (t) => {
    if (!ready(t)) return;
    const mine = await structure();
    // A second Client the actor can also reach — so the rejection is about
    // Asset ownership, not about the caller's Building access.
    const theirs = await structure();
    const foreignAsset = await asset(theirs.building.id);

    const response = await create(body(mine.building.id, foreignAsset.id));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_FAILURE_ASSET_CLIENT_MISMATCH',
    );
  });

  it('rejects an Asset in another Building of the SAME Client', async (t) => {
    if (!ready(t)) return;
    const client = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Shared Client',
    });
    const first = await structure({ client });
    const second = await structure({ client });
    const otherBuildingAsset = await asset(second.building.id);

    const response = await create(body(first.building.id, otherBuildingAsset.id));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_FAILURE_ASSET_BUILDING_MISMATCH',
    );
  });
});

describe('BE-21C — Location validation', () => {
  it('rejects a Location belonging to another Building', async (t) => {
    if (!ready(t)) return;
    const target = await structure();
    const other = await structure({ withRoom: true });
    assert.ok(other.room);
    const equipment = await asset(target.building.id);

    const response = await create(body(target.building.id, equipment.id, {
      locationType: 'ROOM',
      locationId: other.room.id,
    }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INCIDENT_LOCATION_MISMATCH');
  });

  it('rejects an Incident room contradicting the Asset authoritative location', async (t) => {
    if (!ready(t)) return;
    const { building, space, room } = await structure({ withRoom: true });
    assert.ok(space && room);

    // The Asset is pinned to a Functional Location inside `room`.
    const location = await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      spaceId: space.id,
      code: `FL_${suffix()}`,
      name: 'Plant Room FL',
    });
    const equipment = await asset(building.id);
    await assetService.updateAssetLocation(equipment.id, {
      functionalLocationId: location.id,
    });

    // A DIFFERENT room in the same building contradicts that.
    const elsewhere = await roomService.createRoom({
      areaId: (await areaService.getAreaById(room.areaId)).id,
      code: `R_${suffix()}`,
      name: 'Other Room',
    });

    const response = await create(body(building.id, equipment.id, {
      locationType: 'ROOM',
      locationId: elsewhere.id,
    }));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_FAILURE_ASSET_LOCATION_MISMATCH',
    );
  });

  it('accepts an Incident location matching the Asset authoritative location', async (t) => {
    if (!ready(t)) return;
    const { building, space, room } = await structure({ withRoom: true });
    assert.ok(space && room);
    const location = await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      spaceId: space.id,
      code: `FL_${suffix()}`,
      name: 'Plant Room FL',
    });
    const equipment = await asset(building.id);
    await assetService.updateAssetLocation(equipment.id, {
      functionalLocationId: location.id,
    });

    // Same room the Asset resolves to.
    const matching = await create(body(building.id, equipment.id, {
      locationType: 'ROOM',
      locationId: room.id,
    }));
    assert.equal(matching.status, 201);

    // And the Functional Location itself.
    const exact = await create(body(building.id, equipment.id, {
      locationType: 'FUNCTIONAL_LOCATION',
      locationId: location.id,
    }));
    assert.equal(exact.status, 201);
  });

  it('allows a Building-level Asset to take a more specific Incident location', async (t) => {
    if (!ready(t)) return;
    const { building, room } = await structure({ withRoom: true });
    assert.ok(room);
    // No functional location: the Asset is not authoritative below Building.
    const equipment = await asset(building.id);

    const response = await create(body(building.id, equipment.id, {
      locationType: 'ROOM',
      locationId: room.id,
    }));
    assert.equal(response.status, 201);
    assert.equal(response.body.data.roomId, room.id);
  });
});

describe('BE-21C — lifecycle / update protection', () => {
  it('updates failure and foundation details together', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));

    const response = await api()
      .patch(`/api/v1/asset-failures/${created.body.data.id}`)
      .set(auth())
      .send({
        title: 'Chiller compressor failure — recurring',
        severity: 'CRITICAL',
        failureCategory: 'ELECTRICAL_FAILURE',
        operationalImpact: 'PARTIAL_OUTAGE',
        notes: 'Contactor replaced.',
        failureStatus: 'IN_PROGRESS',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.title, 'Chiller compressor failure — recurring');
    assert.equal(response.body.data.failureCategory, 'ELECTRICAL_FAILURE');
    assert.equal(response.body.data.operationalImpact, 'PARTIAL_OUTAGE');
    assert.equal(response.body.data.failureStatus, 'IN_PROGRESS');
    assert.deepEqual(
      [...response.body.data.availableActions].sort(),
      ['REOPEN', 'RESOLVE', 'UPDATE_DETAILS'],
    );
  });

  it('honours every action it advertises', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));
    const id = created.body.data.id;

    const move = (failureStatus: string) =>
      api()
        .patch(`/api/v1/asset-failures/${id}`)
        .set(auth())
        .send({ failureStatus });

    const started = await move('IN_PROGRESS');
    assert.equal(started.status, 200);
    assert.ok(started.body.data.availableActions.includes('REOPEN'));

    const reopened = await move('OPEN');
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.data.failureStatus, 'OPEN');
  });

  it('rejects an invalid failure status transition', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));
    const id = created.body.data.id;

    const resolved = await api()
      .patch(`/api/v1/asset-failures/${id}`)
      .set(auth())
      .send({ failureStatus: 'RESOLVED' });
    assert.equal(resolved.status, 200);

    // RESOLVED → OPEN is not in the transition table.
    const invalid = await api()
      .patch(`/api/v1/asset-failures/${id}`)
      .set(auth())
      .send({ failureStatus: 'OPEN' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'ASSET_FAILURE_INVALID_TRANSITION');
  });

  it('blocks updates once the BE-21A Incident is CANCELLED', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const created = await create(body(building.id, equipment.id));
    const id = created.body.data.id;

    // The foundation owns cancellation.
    const cancelled = await api()
      .post(`/api/v1/incidents/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200);

    const blocked = await api()
      .patch(`/api/v1/asset-failures/${id}`)
      .set(auth())
      .send({ notes: 'Too late' });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'ASSET_FAILURE_UPDATE_NOT_ALLOWED');

    const read = await api().get(`/api/v1/asset-failures/${id}`).set(auth());
    assert.equal(read.body.data.incidentStatus, 'CANCELLED');
    assert.deepEqual(read.body.data.availableActions, []);
  });

  it('rejects a future occurrence date/time', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const response = await create(body(building.id, equipment.id, {
      occurredAt: future,
    }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_FAILURE_OCCURRENCE_INVALID');
  });

  it('rejects an invalid failure category', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    const response = await create(body(building.id, equipment.id, {
      failureCategory: 'GREMLINS',
    }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-21C — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    assert.equal(
      (await api().post('/api/v1/asset-failures').send(body(building.id, equipment.id))).status,
      401,
    );
    assert.equal((await api().get('/api/v1/asset-failures')).status, 401);
  });

  it('denies an authenticated user without asset failure permissions', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const plain = await createPlainSession();

    assert.equal((await create(body(building.id, equipment.id), plain)).status, 403);
    assert.equal(
      (await api().get('/api/v1/asset-failures').set(auth(plain))).status,
      403,
    );
  });

  it('exposes asset_failure read and manage permissions', async (t) => {
    if (!ready(t)) return;
    const codes = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'asset_failure.%' ORDER BY code`,
    );
    assert.deepEqual(
      codes.rows.map((row) => row.code),
      ['asset_failure.manage', 'asset_failure.read'],
    );
  });
});

describe('BE-21C — Client / Building isolation', () => {
  it('denies creating in an unassigned Building', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure({ assign: false });
    const equipment = await asset(building.id);

    const response = await create(body(building.id, equipment.id));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading another Client failure and never lists it', async (t) => {
    if (!ready(t)) return;
    const mine = await structure();
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });

    const foreignAsset = await asset(theirs.building.id);
    const foreign = await create(
      body(theirs.building.id, foreignAsset.id),
      otherAdmin.token,
    );
    assert.equal(foreign.status, 201);

    const ownAsset = await asset(mine.building.id);
    const own = await create(body(mine.building.id, ownAsset.id));
    assert.equal(own.status, 201);

    const denied = await api()
      .get(`/api/v1/asset-failures/${foreign.body.data.id}`)
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api().get('/api/v1/asset-failures').set(auth());
    const ids = listed.body.data.map((item: { id: string }) => item.id);
    assert.ok(ids.includes(own.body.data.id));
    assert.ok(!ids.includes(foreign.body.data.id));
  });

  it('refuses a caller-supplied clientId', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);
    const other = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });

    const response = await create(body(building.id, equipment.id, {
      clientId: other.id,
    }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-21C — preserves the BE-21A review_target fix', () => {
  it('keeps every historical review target valid', async (t) => {
    if (!ready(t)) return;
    const { client } = await structure();

    for (const targetType of REVIEW_TARGET_UNION) {
      const inserted = await pool!.query(
        `INSERT INTO reviews
           (id, client_id, target_type, target_id, reviewer_user_id, status)
         VALUES ($1, $2, $3, $4, $5, 'PENDING')
         RETURNING target_type`,
        [randomUUID(), client.id, targetType, randomUUID(), userId],
      );
      assert.equal(inserted.rows[0].target_type, targetType);
    }
  });

  it('still admits FINDING and adds no BE-21C target', async (t) => {
    if (!ready(t)) return;
    const definition = await pool!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conname = 'review_target'`,
    );
    const clause = definition.rows[0].definition;
    assert.ok(clause.includes("'FINDING'"));
    assert.ok(!clause.includes("'ASSET_FAILURE'"));
  });
});
