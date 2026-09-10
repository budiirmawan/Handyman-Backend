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
import { userLifecycleService, userService } from '../src/modules/users';
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
  await pool.query(`TRUNCATE operational_incidents, incidents,
    operational_events, reviews, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
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

async function structure(options: {
  client?: PublicClient;
  assignUserId?: string;
  assign?: boolean;
  withRoom?: boolean;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Operational Client',
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

function body(buildingId: string, overrides: Record<string, unknown> = {}) {
  return {
    buildingId,
    incidentNumber: `OPS_${suffix()}`,
    title: 'Chilled water pump tripped',
    operationalCategory: 'HVAC',
    occurredAt: PAST,
    ...overrides,
  };
}

const create = (payload: Record<string, unknown>, value = token) =>
  api().post('/api/v1/operational-incidents').set(auth(value)).send(payload);

describe('BE-21B — valid OPERATIONAL Incident', () => {
  it('creates an Operational Incident on the shared BE-21A foundation', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();

    const response = await create(body(building.id, {
      description: 'Pump 2 tripped on overload.',
      severity: 'HIGH',
      priority: 'HIGH',
      notes: 'Standby pump engaged.',
    }));

    assert.equal(response.status, 201);
    const data = response.body.data;
    // Foundation fields come from BE-21A.
    assert.equal(data.incidentType, 'OPERATIONAL');
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    assert.equal(data.incidentStatus, 'REPORTED');
    assert.equal(data.severity, 'HIGH');
    assert.equal(data.reportedByUserId, userId);
    // Specialization fields are BE-21B's.
    assert.equal(data.operationalCategory, 'HVAC');
    assert.equal(data.operationalStatus, 'OPEN');
    assert.equal(data.occurredAt, PAST);
    assert.equal(data.notes, 'Standby pump engaged.');
    // Backend is authoritative for available actions.
    assert.deepEqual(
      [...data.availableActions].sort(),
      ['RESOLVE', 'START_PROGRESS', 'UPDATE_DETAILS'],
    );

    // Exactly one foundation row + one specialization row, sharing identity.
    const rows = await pool!.query(
      `SELECT i.incident_type, i.incident_number, oi.operational_category
       FROM incidents i
       JOIN operational_incidents oi ON oi.incident_id = i.id
       WHERE i.id = $1`,
      [data.id],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].incident_type, 'OPERATIONAL');
    assert.equal(rows.rows[0].operational_category, 'HVAC');
  });

  it('gets an Operational Incident by the shared Incident id', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await create(body(building.id));

    const response = await api()
      .get(`/api/v1/operational-incidents/${created.body.data.id}`)
      .set(auth());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.incidentType, 'OPERATIONAL');
  });

  it('does not duplicate Incident identity or status in the specialization', async (t) => {
    if (!ready(t)) return;
    const columns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'operational_incidents'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'incident_number', 'client_id', 'building_id', 'title', 'description',
      'severity', 'priority', 'status', 'reported_by_user_id', 'location_type',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `operational_incidents must not duplicate ${forbidden}`,
      );
    }

    // And no second incident ENGINE was created. Each BE-21 specialization
    // adds exactly one thin table hanging off the single `incidents`
    // foundation; this list must only ever grow by such specializations.
    const tables = await pool!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE '%incident%'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        'asset_failure_incidents', // BE-21C specialization
        'finding_escalation_incidents', // BE-21D specialization
        'incidents', // the ONE shared foundation
        'operational_incidents', // BE-21B specialization
        'security_incident_readiness', // BE-12, unrelated to BE-21
      ],
    );
  });

  it('filters by Building, Location, category, severity, status and date', async (t) => {
    if (!ready(t)) return;
    const { building, room } = await structure({ withRoom: true });
    assert.ok(room);

    const hvac = await create(body(building.id, {
      operationalCategory: 'HVAC',
      severity: 'CRITICAL',
      occurredAt: '2026-08-02T10:00:00.000Z',
      locationType: 'ROOM',
      locationId: room.id,
    }));
    const leak = await create(body(building.id, {
      operationalCategory: 'WATER_LEAK',
      severity: 'LOW',
      occurredAt: '2026-08-10T10:00:00.000Z',
    }));
    assert.equal(hvac.status, 201);
    assert.equal(leak.status, 201);

    // Every assertion is scoped to this Building so incidents created by
    // sibling tests cannot make the expectations ambiguous.
    const ids = async (query: string) => {
      const res = await api()
        .get(`/api/v1/operational-incidents?buildingId=${building.id}&${query}`)
        .set(auth());
      assert.equal(res.status, 200);
      return res.body.data.map((item: { id: string }) => item.id);
    };

    assert.deepEqual(await ids(''), [leak.body.data.id, hvac.body.data.id]);
    assert.deepEqual(await ids('operationalCategory=WATER_LEAK'), [leak.body.data.id]);
    assert.deepEqual(await ids('severity=CRITICAL'), [hvac.body.data.id]);
    assert.deepEqual(await ids('operationalStatus=OPEN'), [
      leak.body.data.id,
      hvac.body.data.id,
    ]);
    assert.deepEqual(
      await ids(`locationType=ROOM&locationId=${room.id}`),
      [hvac.body.data.id],
    );
    assert.deepEqual(
      await ids('occurredFrom=2026-08-05T00:00:00.000Z'),
      [leak.body.data.id],
    );
    assert.deepEqual(
      await ids('occurredTo=2026-08-05T00:00:00.000Z'),
      [hvac.body.data.id],
    );
  });
});

describe('BE-21B — incident_type fixed to OPERATIONAL', () => {
  it('rejects a caller-supplied incidentType', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await create(body(building.id, {
      incidentType: 'ASSET_FAILURE',
    }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'incidentType',
      ),
    );
  });

  it('always persists OPERATIONAL even when OPERATIONAL is implied', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await create(body(building.id));

    const stored = await pool!.query(
      'SELECT incident_type FROM incidents WHERE id = $1',
      [created.body.data.id],
    );
    assert.equal(stored.rows[0].incident_type, 'OPERATIONAL');
  });

  it('does not expose a non-OPERATIONAL Incident through this endpoint', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    // A BE-21A ASSET_FAILURE Incident has no Operational specialization.
    const foundation = await api()
      .post('/api/v1/incidents')
      .set(auth())
      .send({
        buildingId: building.id,
        incidentNumber: `INC_${suffix()}`,
        incidentType: 'ASSET_FAILURE',
        title: 'Asset failure recorded via foundation',
      });
    assert.equal(foundation.status, 201);

    const response = await api()
      .get(`/api/v1/operational-incidents/${foundation.body.data.id}`)
      .set(auth());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'OPERATIONAL_INCIDENT_NOT_FOUND');
  });
});

describe('BE-21B — controlled operational category', () => {
  it('rejects an invalid operational category', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await create(body(building.id, {
      operationalCategory: 'TELEPORTER_FAILURE',
    }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'operationalCategory',
      ),
    );
  });

  it('rejects a missing operational category', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const payload = body(building.id);
    delete (payload as Record<string, unknown>).operationalCategory;

    const response = await create(payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a future occurrence date/time', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const response = await create(body(building.id, { occurredAt: future }));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'OPERATIONAL_INCIDENT_OCCURRENCE_INVALID',
    );
  });
});

describe('BE-21B — Building / Location validation', () => {
  it('rejects a Location belonging to another Building', async (t) => {
    if (!ready(t)) return;
    const target = await structure();
    const other = await structure({ withRoom: true });
    assert.ok(other.room);

    const response = await create(body(target.building.id, {
      locationType: 'ROOM',
      locationId: other.room.id,
    }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INCIDENT_LOCATION_MISMATCH');

    // The failed attempt must not leave an orphan foundation Incident.
    const orphans = await pool!.query(
      `SELECT i.id FROM incidents i
       LEFT JOIN operational_incidents oi ON oi.incident_id = i.id
       WHERE i.building_id = $1 AND oi.id IS NULL`,
      [target.building.id],
    );
    assert.equal(orphans.rowCount, 0);
  });

  it('rejects an unknown Building', async (t) => {
    if (!ready(t)) return;
    const response = await create(body(randomUUID()));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'BUILDING_NOT_FOUND');
  });
});

describe('BE-21B — reporter validation', () => {
  it('rejects a reporter that does not exist', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    const response = await create(body(building.id, {
      reportedByUserId: randomUUID(),
    }));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'OPERATIONAL_INCIDENT_REPORTER_INVALID',
    );
  });

  it('rejects a reporter without access to the Building', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const outsider = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });

    const response = await create(body(building.id, {
      reportedByUserId: outsider.id,
    }));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'OPERATIONAL_INCIDENT_REPORTER_INVALID',
    );
  });

  it('rejects a deactivated reporter', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const colleague = await createAdminUser();
    await buildingAssignmentService.createAssignment(colleague.userId, {
      buildingId: building.id,
    });
    await userLifecycleService.deactivateUser(colleague.userId);

    const response = await create(body(building.id, {
      reportedByUserId: colleague.userId,
    }));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'OPERATIONAL_INCIDENT_REPORTER_INVALID',
    );
  });

  it('accepts a valid colleague as reporter', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const colleague = await createAdminUser();
    await buildingAssignmentService.createAssignment(colleague.userId, {
      buildingId: building.id,
    });

    const response = await create(body(building.id, {
      reportedByUserId: colleague.userId,
    }));
    assert.equal(response.status, 201);
    assert.equal(response.body.data.reportedByUserId, colleague.userId);
    // The actor is still recorded separately from the reporter.
    assert.equal(response.body.data.createdByUserId, userId);
  });
});

describe('BE-21B — lifecycle / update protection', () => {
  it('updates operational and foundation details together', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await create(body(building.id));
    const id = created.body.data.id;

    const response = await api()
      .patch(`/api/v1/operational-incidents/${id}`)
      .set(auth())
      .send({
        title: 'Chilled water pump tripped — recurring',
        severity: 'CRITICAL',
        operationalCategory: 'ELECTRICAL',
        notes: 'Breaker inspected.',
        operationalStatus: 'IN_PROGRESS',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.title, 'Chilled water pump tripped — recurring');
    assert.equal(response.body.data.severity, 'CRITICAL');
    assert.equal(response.body.data.operationalCategory, 'ELECTRICAL');
    assert.equal(response.body.data.operationalStatus, 'IN_PROGRESS');
    assert.deepEqual(
      [...response.body.data.availableActions].sort(),
      ['REOPEN', 'RESOLVE', 'UPDATE_DETAILS'],
    );
  });

  it('honours every action it advertises', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await create(body(building.id));
    const id = created.body.data.id;

    const move = (operationalStatus: string) =>
      api()
        .patch(`/api/v1/operational-incidents/${id}`)
        .set(auth())
        .send({ operationalStatus });

    // IN_PROGRESS advertises REOPEN; that transition must really be accepted.
    const started = await move('IN_PROGRESS');
    assert.equal(started.status, 200);
    assert.ok(started.body.data.availableActions.includes('REOPEN'));

    const reopened = await move('OPEN');
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.data.operationalStatus, 'OPEN');
    assert.deepEqual(
      [...reopened.body.data.availableActions].sort(),
      ['RESOLVE', 'START_PROGRESS', 'UPDATE_DETAILS'],
    );
  });

  it('rejects an invalid operational status transition', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await create(body(building.id));
    const id = created.body.data.id;

    // OPEN → RESOLVED is allowed; RESOLVED → OPEN is not.
    const resolved = await api()
      .patch(`/api/v1/operational-incidents/${id}`)
      .set(auth())
      .send({ operationalStatus: 'RESOLVED' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.data.operationalStatus, 'RESOLVED');

    const invalid = await api()
      .patch(`/api/v1/operational-incidents/${id}`)
      .set(auth())
      .send({ operationalStatus: 'OPEN' });
    assert.equal(invalid.status, 400);
    assert.equal(
      invalid.body.error.code,
      'OPERATIONAL_INCIDENT_INVALID_TRANSITION',
    );
  });

  it('blocks updates once the BE-21A Incident is CANCELLED', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await create(body(building.id));
    const id = created.body.data.id;

    // The foundation owns cancellation.
    const cancelled = await api()
      .post(`/api/v1/incidents/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200);

    const blocked = await api()
      .patch(`/api/v1/operational-incidents/${id}`)
      .set(auth())
      .send({ notes: 'Too late' });
    assert.equal(blocked.status, 400);
    assert.equal(
      blocked.body.error.code,
      'OPERATIONAL_INCIDENT_UPDATE_NOT_ALLOWED',
    );

    // A cancelled Incident offers no operational actions.
    const read = await api()
      .get(`/api/v1/operational-incidents/${id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.incidentStatus, 'CANCELLED');
    assert.deepEqual(read.body.data.availableActions, []);
  });

  it('refuses to mutate immutable context fields', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const created = await create(body(building.id));

    const response = await api()
      .patch(`/api/v1/operational-incidents/${created.body.data.id}`)
      .set(auth())
      .send({ incidentNumber: `OPS_${suffix()}` });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-21B — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();

    assert.equal(
      (await api().post('/api/v1/operational-incidents').send(body(building.id))).status,
      401,
    );
    assert.equal((await api().get('/api/v1/operational-incidents')).status, 401);
  });

  it('denies an authenticated user without operational incident permissions', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const plain = await createPlainSession();

    assert.equal((await create(body(building.id), plain)).status, 403);
    assert.equal(
      (await api().get('/api/v1/operational-incidents').set(auth(plain))).status,
      403,
    );
  });

  it('exposes operational_incident read and manage permissions', async (t) => {
    if (!ready(t)) return;
    const codes = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'operational_incident.%' ORDER BY code`,
    );
    assert.deepEqual(
      codes.rows.map((row) => row.code),
      ['operational_incident.manage', 'operational_incident.read'],
    );
  });
});

describe('BE-21B — Client / Building isolation', () => {
  it('denies creating in an unassigned Building', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure({ assign: false });

    const response = await create(body(building.id));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading another Client incident and never lists it', async (t) => {
    if (!ready(t)) return;
    const mine = await structure();
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });

    const foreign = await create(body(theirs.building.id), otherAdmin.token);
    assert.equal(foreign.status, 201);
    const own = await create(body(mine.building.id));
    assert.equal(own.status, 201);

    const denied = await api()
      .get(`/api/v1/operational-incidents/${foreign.body.data.id}`)
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api().get('/api/v1/operational-incidents').set(auth());
    const ids = listed.body.data.map((item: { id: string }) => item.id);
    assert.ok(ids.includes(own.body.data.id));
    assert.ok(!ids.includes(foreign.body.data.id));
  });

  it('refuses a caller-supplied clientId', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const other = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });

    const response = await create(body(building.id, { clientId: other.id }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-21B — preserves the BE-21A review_target fix', () => {
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

  it('still admits FINDING and adds no BE-21B target', async (t) => {
    if (!ready(t)) return;
    const definition = await pool!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conname = 'review_target'`,
    );
    const clause = definition.rows[0].definition;
    assert.ok(clause.includes("'FINDING'"));
    assert.ok(!clause.includes("'OPERATIONAL_INCIDENT'"));
  });
});
