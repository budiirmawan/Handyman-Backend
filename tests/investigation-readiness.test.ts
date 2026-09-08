import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { assetService } from '../src/modules/assets';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { evaluateReadinessBlockers } from '../src/modules/investigation-readiness';
import type { IncidentReadinessFacts } from '../src/modules/investigation-readiness';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-21F — Investigation Readiness.
 *
 * Focused validation only: a ready Incident, a blocked Incident, an invalid
 * Incident, RBAC, and Client/Building isolation.
 *
 * The through-line is that readiness is COMPUTED: the same Incident must
 * change verdict as its facts change, with nothing stored in between.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE immediate_actions, finding_escalation_incidents,
    asset_failure_incidents, operational_incidents, incidents,
    operational_events, buildings, properties, users, roles, permissions,
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

async function structure(options: {
  client?: PublicClient;
  assign?: boolean;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Readiness Client',
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
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

/**
 * A bare BE-21A Incident: foundation row only, with NO BE-21B/C/D detail.
 * Created through the foundation endpoint precisely so the missing type
 * detail is a real gap rather than a contrived one.
 */
async function incident(
  buildingId: string,
  value = token,
  overrides: Record<string, unknown> = {},
) {
  const response = await api()
    .post('/api/v1/incidents')
    .set(auth(value))
    .send({
      buildingId,
      incidentNumber: `INC_${suffix()}`,
      incidentType: 'OPERATIONAL',
      title: 'Water leak in lobby',
      description: 'Standing water observed across the lobby floor.',
      ...overrides,
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

/**
 * A complete OPERATIONAL Incident: BE-21B creates the foundation row and its
 * detail row together and shares one identity, so `data.id` is the Incident
 * id that readiness is asked about.
 */
async function detailedIncident(
  buildingId: string,
  value = token,
  overrides: Record<string, unknown> = {},
) {
  const response = await api()
    .post('/api/v1/operational-incidents')
    .set(auth(value))
    .send({
      buildingId,
      incidentNumber: `OPS_${suffix()}`,
      title: 'Water leak in lobby',
      description: 'Standing water observed across the lobby floor.',
      operationalCategory: 'WATER_LEAK',
      occurredAt: ago(90),
      ...overrides,
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

async function immediateAction(
  incidentId: string,
  value = token,
  overrides: Record<string, unknown> = {},
) {
  const response = await api()
    .post('/api/v1/immediate-actions')
    .set(auth(value))
    .send({
      incidentId,
      actionType: 'ISOLATION',
      description: 'Closed the riser valve.',
      takenAt: ago(60),
      ...overrides,
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

/**
 * A complete ASSET_FAILURE Incident (BE-21C). Needed to prove the type-detail
 * lookup MATCHES the discriminator rather than always probing one table.
 */
async function assetFailureIncident(buildingId: string) {
  const asset = await assetService.createAsset({
    buildingId,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller Unit',
  });
  const response = await api()
    .post('/api/v1/asset-failures')
    .set(auth())
    .send({
      buildingId,
      assetId: asset.id,
      incidentNumber: `AF_${suffix()}`,
      title: 'Chiller compressor failure',
      description: 'Compressor seized during the afternoon peak.',
      failureCategory: 'MECHANICAL_FAILURE',
      occurredAt: ago(90),
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

const complete = (actionId: string, value = token) =>
  api()
    .post(`/api/v1/immediate-actions/${actionId}/complete`)
    .set(auth(value))
    .send({});

const readiness = (incidentId: string, value = token) =>
  api()
    .get(`/api/v1/incidents/${incidentId}/investigation-readiness`)
    .set(auth(value));

/** Builds an Incident that satisfies every readiness rule. */
async function readyIncident() {
  const { client, building } = await structure();
  const parent = await detailedIncident(building.id);
  const action = await immediateAction(parent.id);
  await complete(action.id);
  return { client, building, incident: parent, action };
}

const codes = (response: { body: { data: { blockers: { code: string }[] } } }) =>
  response.body.data.blockers.map((blocker) => blocker.code);

describe('BE-21F — ready Incident', () => {
  it('reports ready with no blockers once every precondition holds', async (t) => {
    if (!ready(t)) return;
    const { client, building, incident: parent } = await readyIncident();

    const response = await readiness(parent.id);

    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.ready, true);
    assert.deepEqual(data.blockers, []);
    // Readiness describes an Incident; it carries no id of its own.
    assert.equal(data.incidentId, parent.id);
    assert.equal(data.incidentNumber, parent.incidentNumber);
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    assert.equal(data.incidentStatus, 'REPORTED');
    // The evidence behind the verdict is returned with it.
    assert.equal(data.facts.hasDescription, true);
    assert.equal(data.facts.hasTypeDetail, true);
    assert.equal(data.facts.immediateActionCount, 1);
    assert.equal(data.facts.unsettledImmediateActionCount, 0);
    assert.equal(data.facts.completedImmediateActionCount, 1);
    assert.ok(data.evaluatedAt);
  });

  it('stores no readiness anywhere — the verdict is recomputed', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await readyIncident();

    // BE-21F must have created no table of its own. Asserted narrowly rather
    // than against every '%readiness%' table: unrelated domains already own
    // several, and a broad guard here would break whenever any other PART
    // adds one.
    const tables = await pool!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name LIKE '%investigation%'
       ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), []);

    // Nor may readiness be cached as a column on the Incident.
    const columns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'incidents'
         AND (column_name LIKE '%readiness%'
              OR column_name LIKE '%ready%'
              OR column_name LIKE '%investigation%')`,
    );
    assert.equal(columns.rowCount, 0);

    // The same Incident flips verdict purely because a FACT changed, with no
    // readiness write in between — the proof that it is computed.
    assert.equal((await readiness(parent.id)).body.data.ready, true);
    const extra = await immediateAction(parent.id, token, {
      actionType: 'CLEANUP',
    });
    const afterAdding = await readiness(parent.id);
    assert.equal(afterAdding.body.data.ready, false);
    assert.deepEqual(codes(afterAdding), ['IMMEDIATE_ACTION_UNSETTLED']);

    await complete(extra.id);
    const afterCompleting = await readiness(parent.id);
    assert.equal(afterCompleting.body.data.ready, true);
    assert.deepEqual(afterCompleting.body.data.blockers, []);
  });

  it('treats a cancelled immediate action as settled', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const parent = await detailedIncident(building.id);
    const action = await immediateAction(parent.id);
    await api()
      .post(`/api/v1/immediate-actions/${action.id}/cancel`)
      .set(auth())
      .send({});

    const response = await readiness(parent.id);

    // Abandoned containment is a resolved question, not an outstanding one.
    assert.equal(response.body.data.ready, true);
    assert.equal(response.body.data.facts.unsettledImmediateActionCount, 0);
    assert.equal(response.body.data.facts.completedImmediateActionCount, 0);
  });

  it('resolves type detail against the matching specialization table', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    // An ASSET_FAILURE Incident has a BE-21C row and NO BE-21B row. If the
    // lookup ignored the discriminator and always probed one table, this
    // would be reported as missing its detail.
    const parent = await assetFailureIncident(building.id);
    const action = await immediateAction(parent.id);
    await complete(action.id);

    const response = await readiness(parent.id);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.incidentType, 'ASSET_FAILURE');
    assert.equal(response.body.data.facts.hasTypeDetail, true);
    assert.equal(response.body.data.ready, true);
    assert.deepEqual(response.body.data.blockers, []);
  });

  it('lists readiness and filters on the computed verdict', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const readyOne = await detailedIncident(building.id);
    const action = await immediateAction(readyOne.id);
    await complete(action.id);
    const blockedOne = await incident(building.id);

    const all = await api()
      .get(`/api/v1/investigation-readiness?buildingId=${building.id}`)
      .set(auth());
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);

    const onlyReady = await api()
      .get(`/api/v1/investigation-readiness?buildingId=${building.id}&ready=true`)
      .set(auth());
    assert.deepEqual(
      onlyReady.body.data.map((row: { incidentId: string }) => row.incidentId),
      [readyOne.id],
    );

    // `ready=false` must not be read as truthy — it is a real filter value.
    const onlyBlocked = await api()
      .get(`/api/v1/investigation-readiness?buildingId=${building.id}&ready=false`)
      .set(auth());
    assert.deepEqual(
      onlyBlocked.body.data.map((row: { incidentId: string }) => row.incidentId),
      [blockedOne.id],
    );

    const badFlag = await api()
      .get(`/api/v1/investigation-readiness?buildingId=${building.id}&ready=maybe`)
      .set(auth());
    assert.equal(badFlag.status, 400);
    assert.equal(badFlag.body.error.code, 'VALIDATION_ERROR');
  });

  it('offers no way to write or override readiness', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await readyIncident();

    // A computed projection has no write surface at all.
    const posted = await api()
      .post(`/api/v1/incidents/${parent.id}/investigation-readiness`)
      .set(auth())
      .send({ ready: true });
    assert.equal(posted.status, 404);

    const patched = await api()
      .patch(`/api/v1/incidents/${parent.id}/investigation-readiness`)
      .set(auth())
      .send({ ready: true });
    assert.equal(patched.status, 404);

    // And no manage permission was invented for it.
    const perms = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'investigation_readiness.%' ORDER BY code`,
    );
    assert.deepEqual(
      perms.rows.map((row) => row.code),
      ['investigation_readiness.read'],
    );
  });
});

describe('BE-21F — blocked Incident', () => {
  it('blocks a bare Incident and reports every blocker at once', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    // Foundation only: no type detail, no description, no immediate action.
    const parent = await incident(building.id, token, { description: null });

    const response = await readiness(parent.id);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.ready, false);
    // Accumulated, not short-circuited: the caller sees the whole list.
    assert.deepEqual(codes(response), [
      'TYPE_DETAIL_MISSING',
      'DESCRIPTION_MISSING',
      'NO_IMMEDIATE_ACTION_RECORDED',
    ]);
    // Every blocker carries a human-facing message alongside its code.
    for (const blocker of response.body.data.blockers) {
      assert.ok(typeof blocker.message === 'string' && blocker.message.length > 0);
    }
  });

  it('blocks when the type detail record is missing', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const parent = await incident(building.id);
    const action = await immediateAction(parent.id);
    await complete(action.id);

    const response = await readiness(parent.id);

    assert.equal(response.body.data.ready, false);
    assert.deepEqual(codes(response), ['TYPE_DETAIL_MISSING']);
    assert.equal(response.body.data.facts.hasTypeDetail, false);
  });

  it('blocks when a whitespace-only description passes for an account', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const parent = await detailedIncident(building.id);
    const action = await immediateAction(parent.id);
    await complete(action.id);
    // Written directly: the API trims, but historical rows may not have.
    await pool!.query('UPDATE incidents SET description = $2 WHERE id = $1', [
      parent.id,
      '   ',
    ]);

    const response = await readiness(parent.id);

    assert.equal(response.body.data.ready, false);
    assert.deepEqual(codes(response), ['DESCRIPTION_MISSING']);
  });

  it('blocks while an immediate action is still outstanding', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const parent = await detailedIncident(building.id);
    const settled = await immediateAction(parent.id);
    await complete(settled.id);
    await immediateAction(parent.id, token, { actionType: 'CLEANUP' });

    const response = await readiness(parent.id);

    assert.equal(response.body.data.ready, false);
    // Not "none recorded" — one exists; the concern is that it is unfinished.
    assert.deepEqual(codes(response), ['IMMEDIATE_ACTION_UNSETTLED']);
    assert.equal(response.body.data.facts.immediateActionCount, 2);
    assert.equal(response.body.data.facts.unsettledImmediateActionCount, 1);
  });

  it('blocks a cancelled Incident and reports only that', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const parent = await incident(building.id, token, { description: null });
    await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Reported in error.' });

    const response = await readiness(parent.id);

    assert.equal(response.body.data.ready, false);
    // Terminal: listing "add a description" would invite pointless work on an
    // Incident that can never become investigable.
    assert.deepEqual(codes(response), ['INCIDENT_CANCELLED']);
  });

  it('applies the same rules deterministically as a pure function', async (t) => {
    if (!ready(t)) return;
    const base: IncidentReadinessFacts = {
      incidentId: randomUUID(),
      clientId: randomUUID(),
      buildingId: randomUUID(),
      incidentNumber: 'INC_PURE',
      incidentType: 'OPERATIONAL',
      title: 'Pure rules',
      severity: 'MEDIUM',
      priority: 'MEDIUM',
      status: 'REPORTED',
      reportedAt: new Date(),
      hasDescription: true,
      hasTypeDetail: true,
      immediateActionCount: 1,
      unsettledImmediateActionCount: 0,
      completedImmediateActionCount: 1,
    };

    // No database and no clock: the same facts always give the same verdict.
    assert.deepEqual(evaluateReadinessBlockers(base), []);
    assert.deepEqual(
      evaluateReadinessBlockers({ ...base, status: 'CANCELLED' }).map(
        (blocker) => blocker.code,
      ),
      ['INCIDENT_CANCELLED'],
    );
    assert.deepEqual(
      evaluateReadinessBlockers({
        ...base,
        immediateActionCount: 0,
        completedImmediateActionCount: 0,
      }).map((blocker) => blocker.code),
      ['NO_IMMEDIATE_ACTION_RECORDED'],
    );
    assert.deepEqual(
      evaluateReadinessBlockers({
        ...base,
        hasDescription: false,
        hasTypeDetail: false,
        immediateActionCount: 2,
        unsettledImmediateActionCount: 2,
        completedImmediateActionCount: 0,
      }).map((blocker) => blocker.code),
      [
        'TYPE_DETAIL_MISSING',
        'DESCRIPTION_MISSING',
        'IMMEDIATE_ACTION_UNSETTLED',
      ],
    );
  });
});

describe('BE-21F — invalid Incident', () => {
  it('returns 404 for an unknown Incident', async (t) => {
    if (!ready(t)) return;

    const response = await readiness(randomUUID());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'INCIDENT_NOT_FOUND');
  });

  it('rejects a malformed Incident id', async (t) => {
    if (!ready(t)) return;

    const response = await readiness('not-a-uuid');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal(response.body.error.details[0].field, 'incidentId');
  });

  it('rejects invalid list filters', async (t) => {
    if (!ready(t)) return;

    const badType = await api()
      .get('/api/v1/investigation-readiness?incidentType=NOT_A_TYPE')
      .set(auth());
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.details[0].field, 'incidentType');

    const badBuilding = await api()
      .get('/api/v1/investigation-readiness?buildingId=nope')
      .set(auth());
    assert.equal(badBuilding.status, 400);
    assert.equal(badBuilding.body.error.details[0].field, 'buildingId');
  });
});

describe('BE-21F — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await readyIncident();

    assert.equal(
      (await api().get(
        `/api/v1/incidents/${parent.id}/investigation-readiness`,
      )).status,
      401,
    );
    assert.equal(
      (await api().get('/api/v1/investigation-readiness')).status,
      401,
    );
  });

  it('denies an authenticated user without readiness permission', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await readyIncident();
    const plain = await createPlainSession();

    assert.equal((await readiness(parent.id, plain)).status, 403);
    assert.equal(
      (await api().get('/api/v1/investigation-readiness').set(auth(plain)))
        .status,
      403,
    );
  });

  it('exposes a read permission and no manage permission', async (t) => {
    if (!ready(t)) return;
    const perms = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'investigation_readiness.%' ORDER BY code`,
    );
    assert.deepEqual(
      perms.rows.map((row) => row.code),
      ['investigation_readiness.read'],
    );
  });
});

describe('BE-21F — Client / Building isolation', () => {
  it('denies reading readiness for another Client Incident', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreign = await incident(theirs.building.id, otherAdmin.token);

    const response = await readiness(foreign.id);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('never lists readiness for an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const mine = await readyIncident();
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreign = await incident(theirs.building.id, otherAdmin.token);

    const listed = await api().get('/api/v1/investigation-readiness').set(auth());

    assert.equal(listed.status, 200);
    const ids = listed.body.data.map((row: { incidentId: string }) => row.incidentId);
    assert.ok(ids.includes(mine.incident.id));
    assert.ok(!ids.includes(foreign.id));
  });

  it('denies filtering by an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });

    const response = await api()
      .get(`/api/v1/investigation-readiness?buildingId=${theirs.building.id}`)
      .set(auth());

    // 403, not an empty list: the caller learns the request was refused.
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
