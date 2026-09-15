import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { REVIEW_TARGET_UNION } from '../src/database/migrations/0213_restore_review_target_union';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE incidents, operational_events, reviews,
    rooms, areas, floors, buildings, properties, users, roles, permissions,
    clients CASCADE`);
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

/** Builds Client → Property → Building, assigning the actor to the Building. */
async function structure(options: {
  client?: PublicClient;
  assignUserId?: string;
  assign?: boolean;
  withRoom?: boolean;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Incident Client',
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
    return { client, building, floor: null, area: null, room: null };
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
  return { client, building, floor, area, room };
}

function incidentBody(buildingId: string, overrides: Record<string, unknown> = {}) {
  return {
    buildingId,
    incidentNumber: `INC_${suffix()}`,
    incidentType: 'OPERATIONAL',
    title: 'Water leak in lobby',
    ...overrides,
  };
}

describe('BE-21A — Incident foundation: incident type discriminator', () => {
  it('creates an OPERATIONAL incident with derived Client and defaults', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, { description: 'Standing water.' }));

    assert.equal(response.status, 201);
    const incident = response.body.data;
    assert.equal(incident.incidentType, 'OPERATIONAL');
    assert.equal(incident.buildingId, building.id);
    // Client is derived through Building → Property → Client, never supplied.
    assert.equal(incident.clientId, client.id);
    assert.equal(incident.status, 'REPORTED');
    assert.equal(incident.severity, 'MEDIUM');
    assert.equal(incident.priority, 'MEDIUM');
    assert.equal(incident.reportedByUserId, userId);
    assert.ok(incident.reportedAt);
    assert.equal(incident.locationType, null);
    assert.equal(incident.locationId, null);
    assert.equal(incident.cancelledAt, null);
  });

  it('creates an ASSET_FAILURE incident on the same foundation', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, {
        incidentType: 'ASSET_FAILURE',
        title: 'Chiller compressor failure',
        severity: 'CRITICAL',
        priority: 'HIGH',
      }));

    assert.equal(response.status, 201);
    assert.equal(response.body.data.incidentType, 'ASSET_FAILURE');
    assert.equal(response.body.data.severity, 'CRITICAL');
    assert.equal(response.body.data.priority, 'HIGH');

    // BE-21C adds the Asset / Equipment typed binding — not this PART.
    const stored = await pool!.query(
      'SELECT incident_type FROM incidents WHERE id = $1',
      [response.body.data.id],
    );
    assert.equal(stored.rows[0].incident_type, 'ASSET_FAILURE');
  });

  it('creates a FINDING_ESCALATION incident on the same foundation', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, {
        incidentType: 'FINDING_ESCALATION',
        title: 'Repeated housekeeping finding escalated',
      }));

    assert.equal(response.status, 201);
    assert.equal(response.body.data.incidentType, 'FINDING_ESCALATION');
  });

  it('stores all three incident types in ONE incidents table', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    for (const incidentType of ['OPERATIONAL', 'ASSET_FAILURE', 'FINDING_ESCALATION']) {
      const created = await api()
        .post('/api/v1/incidents')
        .set(auth())
        .send(incidentBody(building.id, { incidentType }));
      assert.equal(created.status, 201);
    }

    const rows = await pool!.query(
      `SELECT DISTINCT incident_type FROM incidents
       WHERE building_id = $1 ORDER BY incident_type`,
      [building.id],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.incident_type),
      ['ASSET_FAILURE', 'FINDING_ESCALATION', 'OPERATIONAL'],
    );

    // No second incident/defect engine was introduced. `corrective_actions`
    // (BE-21G) is expected: it is a CHILD COLLECTION hanging off this
    // foundation, not a rival engine. What the guard really protects is that
    // it does not duplicate Incident identity — asserted directly below.
    const tables = await pool!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name LIKE '%defect%'
              OR table_name LIKE '%corrective_action%')
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        'corrective_action_responsibilities', // BE-21H, child of BE-21G
        'corrective_actions', // BE-21G child collection
      ],
    );

    // BE-21H stores ONE identity reference and no copied person data; the
    // person's details belong to the BE-03C Workforce Profile.
    const responsibilityColumns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'corrective_action_responsibilities'`,
    );
    const responsibilityNames = responsibilityColumns.rows.map(
      (row) => row.column_name,
    );
    for (const forbidden of [
      'full_name', 'email', 'employee_code', 'client_id', 'building_id',
      'incident_id',
    ]) {
      assert.ok(
        !responsibilityNames.includes(forbidden),
        `corrective_action_responsibilities must not duplicate ${forbidden}`,
      );
    }
    assert.ok(responsibilityNames.includes('workforce_profile_id'));

    const correctiveColumns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'corrective_actions'`,
    );
    const correctiveNames = correctiveColumns.rows.map((row) => row.column_name);
    // It resolves all of these through `incident_id`; holding its own copy
    // would fork Incident context and identity.
    for (const forbidden of [
      'incident_number', 'client_id', 'building_id', 'title', 'severity',
      'priority', 'incident_type', 'reported_by_user_id', 'location_type',
    ]) {
      assert.ok(
        !correctiveNames.includes(forbidden),
        `corrective_actions must not duplicate ${forbidden}`,
      );
    }
    assert.ok(correctiveNames.includes('incident_id'));
  });

  it('rejects an invalid incident type', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, { incidentType: 'SAFETY_BREACH' }));

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'incidentType',
      ),
    );
  });

  it('rejects a missing incident type', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const body = incidentBody(building.id);
    delete (body as Record<string, unknown>).incidentType;

    const response = await api().post('/api/v1/incidents').set(auth()).send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-21A — Building / Location validation', () => {
  it('accepts an optional ROOM location inside the same Building', async (t) => {
    if (!ready(t)) return;
    const { building, room } = await structure({ withRoom: true });
    assert.ok(room);

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, {
        locationType: 'ROOM',
        locationId: room.id,
      }));

    assert.equal(response.status, 201);
    assert.equal(response.body.data.locationType, 'ROOM');
    assert.equal(response.body.data.locationId, room.id);
    assert.equal(response.body.data.roomId, room.id);
    // Only the matching typed column is populated.
    assert.equal(response.body.data.floorId, null);
    assert.equal(response.body.data.areaId, null);
  });

  it('accepts an optional FLOOR location inside the same Building', async (t) => {
    if (!ready(t)) return;
    const { building, floor } = await structure({ withRoom: true });
    assert.ok(floor);

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, {
        locationType: 'FLOOR',
        locationId: floor.id,
      }));

    assert.equal(response.status, 201);
    assert.equal(response.body.data.floorId, floor.id);
    assert.equal(response.body.data.roomId, null);
  });

  it('rejects a location belonging to another Building', async (t) => {
    if (!ready(t)) return;
    const target = await structure();
    const other = await structure({ withRoom: true });
    assert.ok(other.room);

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(target.building.id, {
        locationType: 'ROOM',
        locationId: other.room.id,
      }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INCIDENT_LOCATION_MISMATCH');
  });

  it('rejects an unknown location reference', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, {
        locationType: 'ROOM',
        locationId: randomUUID(),
      }));

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_NOT_FOUND');
  });

  it('rejects a half-specified location', async (t) => {
    if (!ready(t)) return;
    const { building, room } = await structure({ withRoom: true });
    assert.ok(room);

    const missingId = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, { locationType: 'ROOM' }));
    assert.equal(missingId.status, 400);
    assert.equal(missingId.body.error.code, 'VALIDATION_ERROR');

    const missingType = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, { locationId: room.id }));
    assert.equal(missingType.status, 400);
    assert.equal(missingType.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an unknown Building', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(randomUUID()));

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'BUILDING_NOT_FOUND');
  });

  it('rejects a duplicate incident number within the Client', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const body = incidentBody(building.id);

    assert.equal((await api().post('/api/v1/incidents').set(auth()).send(body)).status, 201);
    const duplicate = await api().post('/api/v1/incidents').set(auth()).send(body);

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'INCIDENT_NUMBER_ALREADY_EXISTS');
  });
});

describe('BE-21A — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const created = await api().post('/api/v1/incidents').send(incidentBody(building.id));
    assert.equal(created.status, 401);
    const listed = await api().get('/api/v1/incidents');
    assert.equal(listed.status, 401);
  });

  it('denies an authenticated user without incident permissions', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const plain = await createPlainSession();

    const created = await api()
      .post('/api/v1/incidents')
      .set(auth(plain))
      .send(incidentBody(building.id));
    assert.equal(created.status, 403);

    const listed = await api().get('/api/v1/incidents').set(auth(plain));
    assert.equal(listed.status, 403);
  });

  it('exposes incident.read and incident.manage as distinct permissions', async (t) => {
    if (!ready(t)) return;
    const codes = await pool!.query(
      `SELECT code FROM permissions WHERE code LIKE 'incident.%' ORDER BY code`,
    );
    assert.deepEqual(
      codes.rows.map((row) => row.code),
      ['incident.manage', 'incident.read'],
    );
  });
});

describe('BE-21A — Client / Building isolation', () => {
  it('denies creating an incident in an unassigned Building', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure({ assign: false });

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id));

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading an incident from another Client', async (t) => {
    if (!ready(t)) return;
    const mine = await structure();
    const theirs = await structure({ assign: false });

    // A second admin owns the other Client's Building.
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreign = await api()
      .post('/api/v1/incidents')
      .set(auth(otherAdmin.token))
      .send(incidentBody(theirs.building.id));
    assert.equal(foreign.status, 201);

    const denied = await api()
      .get(`/api/v1/incidents/${foreign.body.data.id}`)
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Listing never leaks it either.
    const mineIncident = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(mine.building.id));
    assert.equal(mineIncident.status, 201);

    const listed = await api().get('/api/v1/incidents').set(auth());
    assert.equal(listed.status, 200);
    const ids = listed.body.data.map((item: { id: string }) => item.id);
    assert.ok(ids.includes(mineIncident.body.data.id));
    assert.ok(!ids.includes(foreign.body.data.id));
  });

  it('refuses a caller-supplied clientId', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const other = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });

    const response = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, { clientId: other.id }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('refuses a caller-supplied reportedByUserId or status', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const spoofedActor = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, { reportedByUserId: randomUUID() }));
    assert.equal(spoofedActor.status, 400);

    const spoofedStatus = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id, { status: 'CANCELLED' }));
    assert.equal(spoofedStatus.status, 400);
  });
});

describe('BE-21A — minimal lifecycle', () => {
  it('updates metadata and cancels a REPORTED incident', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id));
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/incidents/${id}`)
      .set(auth())
      .send({ title: 'Water leak — escalating', severity: 'HIGH' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.title, 'Water leak — escalating');
    assert.equal(updated.body.data.severity, 'HIGH');

    const cancelled = await api()
      .post(`/api/v1/incidents/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.ok(cancelled.body.data.cancelledAt);
    assert.equal(cancelled.body.data.cancelledByUserId, userId);

    // A cancelled incident is terminal in the foundation lifecycle.
    const reCancel = await api()
      .post(`/api/v1/incidents/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(reCancel.status, 400);
    assert.equal(reCancel.body.error.code, 'INCIDENT_CANCEL_NOT_ALLOWED');

    const lateUpdate = await api()
      .patch(`/api/v1/incidents/${id}`)
      .set(auth())
      .send({ title: 'Too late' });
    assert.equal(lateUpdate.status, 400);
    assert.equal(lateUpdate.body.error.code, 'INCIDENT_UPDATE_NOT_ALLOWED');
  });

  it('refuses to mutate immutable context fields', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send(incidentBody(building.id));

    const response = await api()
      .patch(`/api/v1/incidents/${created.body.data.id}`)
      .set(auth())
      .send({ incidentType: 'ASSET_FAILURE' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('reviews.review_target — pre-existing regression fix', () => {
  it('accepts FINDING after the latest migration state', async (t) => {
    if (!ready(t)) return;
    const { client } = await structure();

    // A direct insert proves the CHECK constraint itself admits FINDING —
    // this is exactly what failed before migration 0213.
    const inserted = await pool!.query(
      `INSERT INTO reviews
         (id, client_id, target_type, target_id, reviewer_user_id, status)
       VALUES ($1, $2, 'FINDING', $3, $4, 'PENDING')
       RETURNING target_type`,
      [randomUUID(), client.id, randomUUID(), userId],
    );
    assert.equal(inserted.rows[0].target_type, 'FINDING');
  });

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

  it('preserves the exact historical union in the constraint', async (t) => {
    if (!ready(t)) return;
    const definition = await pool!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conname = 'review_target'`,
    );
    const clause = definition.rows[0].definition;
    for (const targetType of REVIEW_TARGET_UNION) {
      assert.ok(
        clause.includes(`'${targetType}'`),
        `review_target must still admit ${targetType}`,
      );
    }
  });

  it('still rejects an unknown review target', async (t) => {
    if (!ready(t)) return;
    const { client } = await structure();

    await assert.rejects(
      pool!.query(
        `INSERT INTO reviews
           (id, client_id, target_type, target_id, reviewer_user_id, status)
         VALUES ($1, $2, 'NOT_A_REVIEW_TARGET', $3, $4, 'PENDING')`,
        [randomUUID(), client.id, randomUUID(), userId],
      ),
      /review_target/,
    );
  });

  it('does not add BE-21 review targets before their PART needs them', async (t) => {
    if (!ready(t)) return;
    const definition = await pool!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conname = 'review_target'`,
    );
    assert.ok(!definition.rows[0].definition.includes("'INCIDENT'"));
  });
});
