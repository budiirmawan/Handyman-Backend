import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { findingService } from '../src/modules/findings';
import { propertyService } from '../src/modules/properties';
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
  await pool.query(`TRUNCATE finding_escalation_incidents,
    asset_failure_incidents, operational_incidents, incidents,
    finding_assignments, findings, operational_events, buildings, properties,
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

/** Builds Client → Property → Building with an optional BE-09 Finding. */
async function fixture(options: {
  client?: PublicClient;
  assign?: boolean;
  assignUserId?: string;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Escalation Client',
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
  const finding = await findingService.createFinding({
    clientId: client.id,
    buildingId: building.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Recurring water leak',
    reportedByUserId: options.assignUserId ?? userId,
  });
  return { client, building, finding };
}

function body(findingId: string, overrides: Record<string, unknown> = {}) {
  return {
    findingId,
    incidentNumber: `ESC_${suffix()}`,
    title: 'Escalated: recurring water leak',
    escalationReason: 'UNRESOLVED',
    ...overrides,
  };
}

const create = (payload: Record<string, unknown>, value = token) =>
  api().post('/api/v1/finding-escalations').set(auth(value)).send(payload);

describe('BE-21D — valid escalation', () => {
  it('escalates a Finding into Incident context', async (t) => {
    if (!ready(t)) return;
    const { client, building, finding } = await fixture();

    const response = await create(body(finding.id, {
      description: 'Third recurrence this quarter.',
      severity: 'HIGH',
      priority: 'HIGH',
      escalationReason: 'REPEAT_FINDING',
      notes: 'Escalated to building manager.',
    }));

    assert.equal(response.status, 201);
    const data = response.body.data;
    // Foundation fields come from BE-21A.
    assert.equal(data.incidentType, 'FINDING_ESCALATION');
    assert.equal(data.incidentStatus, 'REPORTED');
    assert.equal(data.severity, 'HIGH');
    assert.equal(data.reportedByUserId, userId);
    // Context is DERIVED from the Finding.
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    // Specialization fields are BE-21D's.
    assert.equal(data.escalationReason, 'REPEAT_FINDING');
    assert.equal(data.notes, 'Escalated to building manager.');
    assert.ok(data.escalatedAt);
    // The BE-09 Finding is projected read-only.
    assert.equal(data.finding.id, finding.id);
    assert.equal(data.finding.findingNumber, finding.findingNumber);
    assert.equal(data.finding.status, 'OPEN');
    // Only UPDATE_DETAILS: acting on the Finding belongs to BE-09.
    assert.deepEqual(data.availableActions, ['UPDATE_DETAILS']);

    const rows = await pool!.query(
      `SELECT i.incident_type, fe.finding_id, fe.escalation_reason
       FROM incidents i
       JOIN finding_escalation_incidents fe ON fe.incident_id = i.id
       WHERE i.id = $1`,
      [data.id],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].incident_type, 'FINDING_ESCALATION');
    assert.equal(rows.rows[0].finding_id, finding.id);
  });

  it('gets an escalation by the shared Incident id', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const created = await create(body(finding.id));

    const response = await api()
      .get(`/api/v1/finding-escalations/${created.body.data.id}`)
      .set(auth());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.finding.id, finding.id);
  });

  it('records the escalation on the Finding BE-09 history', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const created = await create(body(finding.id));

    // Reuses BE-09's history primitive rather than a parallel history.
    const events = await pool!.query(
      `SELECT event_type, metadata FROM operational_events
       WHERE entity_type = 'FINDING' AND entity_id = $1
         AND event_type = 'FINDING_ESCALATED'`,
      [finding.id],
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].metadata.incidentId, created.body.data.id);
  });

  it('filters by Finding, Building and status', async (t) => {
    if (!ready(t)) return;
    const first = await fixture();
    const second = await fixture({ client: first.client });
    // Both buildings belong to the same Client; the actor can reach both.
    const a = await create(body(first.finding.id, { escalationReason: 'SLA_BREACH' }));
    const b = await create(body(second.finding.id, { escalationReason: 'SAFETY_RISK' }));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const ids = async (query: string) => {
      const res = await api()
        .get(`/api/v1/finding-escalations?${query}`)
        .set(auth());
      assert.equal(res.status, 200);
      return res.body.data.map((item: { id: string }) => item.id);
    };

    assert.deepEqual(await ids(`findingId=${first.finding.id}`), [a.body.data.id]);
    assert.deepEqual(
      await ids(`buildingId=${second.building.id}`),
      [b.body.data.id],
    );
    assert.deepEqual(
      await ids(`buildingId=${first.building.id}&escalationReason=SLA_BREACH`),
      [a.body.data.id],
    );
    // findingStatus filters the LIVE BE-09 state through the JOIN.
    const open = await ids(`buildingId=${first.building.id}&findingStatus=OPEN`);
    assert.ok(open.includes(a.body.data.id));
    assert.deepEqual(
      await ids(`buildingId=${first.building.id}&findingStatus=CLOSED`),
      [],
    );
    assert.deepEqual(
      await ids(`buildingId=${first.building.id}&incidentStatus=CANCELLED`),
      [],
    );
  });

  it('projects live Finding state rather than a stale copy', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const created = await create(body(finding.id));
    assert.equal(created.body.data.finding.status, 'OPEN');

    // BE-09 remains the only place Finding state moves.
    const cancelled = await api()
      .patch(`/api/v1/findings/${finding.id}/state`)
      .set(auth())
      .send({ state: 'CANCELLED' });
    assert.equal(cancelled.status, 200);

    const read = await api()
      .get(`/api/v1/finding-escalations/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.body.data.finding.status, 'CANCELLED');
  });
});

describe('BE-21D — does not duplicate Finding state or workflow', () => {
  it('stores no Finding state on the specialization', async (t) => {
    if (!ready(t)) return;
    const columns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'finding_escalation_incidents'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'finding_status', 'status', 'state', 'finding_number', 'finding_title',
      'state_changed_at', 'client_id', 'building_id', 'severity', 'priority',
      'assignee_id', 'closed_at', 'closure_notes',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `finding_escalation_incidents must not duplicate ${forbidden}`,
      );
    }
  });

  it('does not change Finding state when escalating', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const before = await pool!.query(
      'SELECT status, state_changed_at FROM findings WHERE id = $1',
      [finding.id],
    );

    assert.equal((await create(body(finding.id))).status, 201);

    const after = await pool!.query(
      'SELECT status, state_changed_at FROM findings WHERE id = $1',
      [finding.id],
    );
    assert.equal(after.rows[0].status, before.rows[0].status);
    assert.deepEqual(
      after.rows[0].state_changed_at,
      before.rows[0].state_changed_at,
    );
  });

  it('refuses caller-supplied Finding state', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();

    const response = await create(body(finding.id, { findingStatus: 'CLOSED' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('refuses to re-point an escalation at another Finding', async (t) => {
    if (!ready(t)) return;
    const first = await fixture();
    const second = await fixture({ client: first.client });
    const created = await create(body(first.finding.id));

    const response = await api()
      .patch(`/api/v1/finding-escalations/${created.body.data.id}`)
      .set(auth())
      .send({ findingId: second.finding.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('creates no second incident engine', async (t) => {
    if (!ready(t)) return;
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
});

describe('BE-21D — incident_type fixed to FINDING_ESCALATION', () => {
  it('rejects a caller-supplied incidentType', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();

    const response = await create(body(finding.id, {
      incidentType: 'OPERATIONAL',
    }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('always persists FINDING_ESCALATION', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const created = await create(body(finding.id));

    const stored = await pool!.query(
      'SELECT incident_type FROM incidents WHERE id = $1',
      [created.body.data.id],
    );
    assert.equal(stored.rows[0].incident_type, 'FINDING_ESCALATION');
  });

  it('does not expose an escalation through the other specializations', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const created = await create(body(finding.id));

    for (const path of ['operational-incidents', 'asset-failures']) {
      const response = await api()
        .get(`/api/v1/${path}/${created.body.data.id}`)
        .set(auth());
      assert.equal(response.status, 404);
    }
  });
});

describe('BE-21D — invalid Finding rejected', () => {
  it('rejects a Finding that does not exist', async (t) => {
    if (!ready(t)) return;
    const response = await create(body(randomUUID()));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FINDING_NOT_FOUND');
  });

  it('rejects a malformed findingId', async (t) => {
    if (!ready(t)) return;
    const response = await create(body('not-a-uuid'));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a missing findingId', async (t) => {
    if (!ready(t)) return;
    const payload = body(randomUUID());
    delete (payload as Record<string, unknown>).findingId;

    const response = await create(payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a CANCELLED Finding', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const cancelled = await api()
      .patch(`/api/v1/findings/${finding.id}/state`)
      .set(auth())
      .send({ state: 'CANCELLED' });
    assert.equal(cancelled.status, 200);

    const response = await create(body(finding.id));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'FINDING_ESCALATION_FINDING_NOT_ESCALATABLE',
    );
  });

  it('rejects an invalid escalation reason', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();

    const response = await create(body(finding.id, {
      escalationReason: 'BECAUSE_I_SAID_SO',
    }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('leaves no orphan Incident when the Finding is rejected', async (t) => {
    if (!ready(t)) return;
    const before = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM incidents
       WHERE incident_type = 'FINDING_ESCALATION'`,
    );

    assert.equal((await create(body(randomUUID()))).status, 404);

    const orphans = await pool!.query(
      `SELECT i.id FROM incidents i
       LEFT JOIN finding_escalation_incidents fe ON fe.incident_id = i.id
       WHERE i.incident_type = 'FINDING_ESCALATION' AND fe.id IS NULL`,
    );
    assert.equal(orphans.rowCount, 0);
    const after = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM incidents
       WHERE incident_type = 'FINDING_ESCALATION'`,
    );
    assert.equal(after.rows[0].count, before.rows[0].count);
  });
});

describe('BE-21D — duplicate escalation rejected', () => {
  it('rejects a second active escalation of the same Finding', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();

    assert.equal((await create(body(finding.id))).status, 201);

    const duplicate = await create(body(finding.id));
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'FINDING_ESCALATION_ALREADY_ACTIVE',
    );

    // The rejected attempt must not leave a second Incident behind.
    const rows = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM finding_escalation_incidents WHERE finding_id = $1',
      [finding.id],
    );
    assert.equal(rows.rows[0].count, 1);
  });

  it('allows re-escalation once the previous escalation is CANCELLED', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const first = await create(body(finding.id));
    assert.equal(first.status, 201);

    // A spent escalation must not block the Finding forever.
    const cancelled = await api()
      .post(`/api/v1/incidents/${first.body.data.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200);

    const second = await create(body(finding.id));
    assert.equal(second.status, 201);
    assert.notEqual(second.body.data.id, first.body.data.id);
  });

  it('serializes concurrent escalations of the same Finding', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();

    // Without the row lock both would pass the duplicate check and insert.
    const [a, b] = await Promise.all([
      create(body(finding.id)),
      create(body(finding.id)),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const rows = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM finding_escalation_incidents WHERE finding_id = $1',
      [finding.id],
    );
    assert.equal(rows.rows[0].count, 1);
  });

  it('allows escalating different Findings independently', async (t) => {
    if (!ready(t)) return;
    const first = await fixture();
    const second = await fixture({ client: first.client });

    assert.equal((await create(body(first.finding.id))).status, 201);
    assert.equal((await create(body(second.finding.id))).status, 201);
  });
});

describe('BE-21D — Building / Client mismatch rejected', () => {
  it('denies escalating a Finding in an unassigned Building', async (t) => {
    if (!ready(t)) return;
    // The actor has no assignment to this Building, so the derived context is
    // inaccessible even though the Finding is perfectly valid.
    const { finding } = await fixture({ assign: false });

    const response = await create(body(finding.id));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('refuses a caller-supplied buildingId or clientId', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const other = await fixture();

    const withBuilding = await create(body(finding.id, {
      buildingId: other.building.id,
    }));
    assert.equal(withBuilding.status, 400);
    assert.equal(withBuilding.body.error.code, 'VALIDATION_ERROR');

    const withClient = await create(body(finding.id, {
      clientId: other.client.id,
    }));
    assert.equal(withClient.status, 400);
    assert.equal(withClient.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a Finding whose stored Client contradicts its Building', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const foreign = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Foreign Client',
    });
    // Force the drift the defence-in-depth check exists to catch.
    await pool!.query('UPDATE findings SET client_id = $2 WHERE id = $1', [
      finding.id,
      foreign.id,
    ]);

    const response = await create(body(finding.id));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'FINDING_ESCALATION_CLIENT_MISMATCH',
    );
  });
});

describe('BE-21D — lifecycle / update protection', () => {
  it('updates escalation and foundation details together', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const created = await create(body(finding.id));

    const response = await api()
      .patch(`/api/v1/finding-escalations/${created.body.data.id}`)
      .set(auth())
      .send({
        title: 'Escalated: recurring water leak — urgent',
        severity: 'CRITICAL',
        escalationReason: 'SAFETY_RISK',
        notes: 'Now a slip hazard.',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.severity, 'CRITICAL');
    assert.equal(response.body.data.escalationReason, 'SAFETY_RISK');
    assert.equal(response.body.data.notes, 'Now a slip hazard.');
  });

  it('blocks updates once the BE-21A Incident is CANCELLED', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const created = await create(body(finding.id));
    const id = created.body.data.id;

    const cancelled = await api()
      .post(`/api/v1/incidents/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200);

    const blocked = await api()
      .patch(`/api/v1/finding-escalations/${id}`)
      .set(auth())
      .send({ notes: 'Too late' });
    assert.equal(blocked.status, 400);
    assert.equal(
      blocked.body.error.code,
      'FINDING_ESCALATION_UPDATE_NOT_ALLOWED',
    );

    const read = await api()
      .get(`/api/v1/finding-escalations/${id}`)
      .set(auth());
    assert.equal(read.body.data.incidentStatus, 'CANCELLED');
    assert.deepEqual(read.body.data.availableActions, []);
  });
});

describe('BE-21D — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();

    assert.equal(
      (await api().post('/api/v1/finding-escalations').send(body(finding.id))).status,
      401,
    );
    assert.equal((await api().get('/api/v1/finding-escalations')).status, 401);
  });

  it('denies an authenticated user without escalation permissions', async (t) => {
    if (!ready(t)) return;
    const { finding } = await fixture();
    const plain = await createPlainSession();

    assert.equal((await create(body(finding.id), plain)).status, 403);
    assert.equal(
      (await api().get('/api/v1/finding-escalations').set(auth(plain))).status,
      403,
    );
  });

  it('exposes finding_escalation read and manage permissions', async (t) => {
    if (!ready(t)) return;
    const codes = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'finding_escalation.%' ORDER BY code`,
    );
    assert.deepEqual(
      codes.rows.map((row) => row.code),
      ['finding_escalation.manage', 'finding_escalation.read'],
    );
  });
});

describe('BE-21D — Client / Building isolation', () => {
  it('denies reading another Client escalation and never lists it', async (t) => {
    if (!ready(t)) return;
    const mine = await fixture();
    const theirs = await fixture({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });

    const foreign = await create(body(theirs.finding.id), otherAdmin.token);
    assert.equal(foreign.status, 201);
    const own = await create(body(mine.finding.id));
    assert.equal(own.status, 201);

    const denied = await api()
      .get(`/api/v1/finding-escalations/${foreign.body.data.id}`)
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api().get('/api/v1/finding-escalations').set(auth());
    const ids = listed.body.data.map((item: { id: string }) => item.id);
    assert.ok(ids.includes(own.body.data.id));
    assert.ok(!ids.includes(foreign.body.data.id));
  });

  it('denies filtering by an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await fixture({ assign: false });

    const response = await api()
      .get(`/api/v1/finding-escalations?buildingId=${theirs.building.id}`)
      .set(auth());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
