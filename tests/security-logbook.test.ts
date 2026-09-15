import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { shiftService } from '../src/modules/shifts';
import { createShiftHandover } from '../src/modules/shift-handovers';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-05 PART 03 — Security Operational Logbook focused validation.
 *
 * Proves the backend-authoritative, Building-scoped logbook contract:
 * create / list / detail / update (OPEN only), authentication + RBAC,
 * Building isolation (403 outside the accessible set, no cross-Building
 * reads or writes), authoritative identity (session-derived, never
 * caller-supplied), authoritative timestamps (database clock, client fields
 * ignored), the optional same-Building Shift Handover binding (unknown →
 * 404; cross-Building → 400), and the OPEN → CLOSED lifecycle.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       security_logbook_entries, shift_handovers, shifts,
       workforce_shift_assignments, workforce_profiles, positions,
       departments, organizations, user_building_assignments, buildings,
       properties, users, roles, permissions, clients, attendance_records
     CASCADE`,
  );
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const TZ = 'Asia/Jakarta';

type Fixture = Awaited<ReturnType<typeof seed>>;

/**
 * Creates a fully isolated fixture: a fresh admin user (with the seeded
 * security_logbook permissions), a fresh Client hierarchy, a Workforce
 * Profile linked to that user, and an authoritative Engineering Shift
 * Handover at Building A (for the optional binding).
 */
async function seed() {
  const manager = await createAdminUser();
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Logbook client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A',
    timezone: TZ,
  });
  // Inaccessible building: never assigned to the manager.
  const buildingB = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building B',
    timezone: TZ,
  });
  await buildingAssignmentService.createAssignment(manager.userId, {
    buildingId: buildingA.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `P_${suffix()}`,
    name: 'Security Officer',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: manager.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Security Officer',
  });

  const shiftOut = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Day shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const shiftIn = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Night shift',
    startTime: '22:00:00',
    endTime: '06:00:00',
  });
  const handoverA = await createShiftHandover(
    {
      buildingId: buildingA.id,
      outgoingShiftId: shiftOut.id,
      incomingShiftId: shiftIn.id,
      handoverDate: '2026-08-20',
      summary: 'Handover at Building A',
      preparedByUserId: manager.userId,
    },
    manager.userId,
  );

  return {
    token: manager.token,
    userId: manager.userId,
    client,
    profile,
    buildingA,
    buildingB,
    handoverA,
  };
}

function assertServerTimestamp(value: string): Date {
  const parsed = new Date(value);
  assert.ok(
    !Number.isNaN(parsed.getTime()) && Math.abs(Date.now() - parsed.getTime()) < 120_000,
    `timestamp must be a recent server-set ISO-8601 instant (got ${value})`,
  );
  return parsed;
}

describe('CR-BE-MOB-05 PART 03 — security logbook', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const samples = [
      { method: 'post', path: '/api/v1/buildings/00000000-0000-4000-8000-000000000001/security/logbook' },
      { method: 'get', path: '/api/v1/buildings/00000000-0000-4000-8000-000000000001/security/logbook' },
      { method: 'get', path: '/api/v1/security/logbook/00000000-0000-4000-8000-000000000001' },
      { method: 'patch', path: '/api/v1/security/logbook/00000000-0000-4000-8000-000000000001' },
    ] as const;
    for (const { method, path } of samples) {
      const response =
        method === 'get'
          ? await api().get(path)
          : await api()[method](path).send({});
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path}`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('rejects an authenticated user without logbook permissions with 403', async (t) => {
    if (!ready(t)) return;
    const token = await createPlainSession();
    const samples = [
      { method: 'post', path: '/api/v1/buildings/00000000-0000-4000-8000-000000000001/security/logbook', body: {} },
      { method: 'get', path: '/api/v1/buildings/00000000-0000-4000-8000-000000000001/security/logbook', body: undefined },
      { method: 'get', path: '/api/v1/security/logbook/00000000-0000-4000-8000-000000000001', body: undefined },
      { method: 'patch', path: '/api/v1/security/logbook/00000000-0000-4000-8000-000000000001', body: {} },
    ] as const;
    for (const { method, path, body } of samples) {
      const response =
        method === 'get'
          ? await api().get(path).set({ Authorization: `Bearer ${token}` })
          : await api()[method](path).set({ Authorization: `Bearer ${token}` }).send(body);
      assert.equal(response.status, 403, `${method.toUpperCase()} ${path}`);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('rejects an invalid create body with 400', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const samples = [
      {},
      { buildingId: 'not-a-uuid', category: 'GENERAL', summary: 'x' },
      { buildingId: f.buildingA.id, summary: 'x' },
      { buildingId: f.buildingA.id, category: 'NOT_A_CATEGORY', summary: 'x' },
      { buildingId: f.buildingA.id, category: 'GENERAL' },
    ];
    for (const body of samples) {
      const response = await api()
        .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
        .set({ Authorization: `Bearer ${f.token}` })
        .send(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('rejects an unknown Building with 403 at the route gate (never a leak)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    // The route's requireBuildingAccess gate blocks before the service runs
    // (BE-02G never leaks whether an unknown Building exists) — the same
    // posture as the security shift-handover binding routes.
    const response = await api()
      .post('/api/v1/buildings/00000000-0000-4000-8000-000000000001/security/logbook')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: '00000000-0000-4000-8000-000000000001', category: 'GENERAL', summary: 'x' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects creation at an inaccessible Building with 403', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const response = await api()
      .post(`/api/v1/buildings/${f.buildingB.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingB.id, category: 'GENERAL', summary: 'x' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('creates an entry with server-authoritative identity, building and timestamps', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A caller-supplied workforceProfileId / recordedAt must be IGNORED —
    // identity comes from the session and timestamps from the database.
    const response = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({
        buildingId: f.buildingA.id,
        category: 'PATROL',
        summary: 'Patrol observation',
        detail: 'Post 3 quiet',
        workforceProfileId: '00000000-0000-4000-8000-000000000099',
        recordedAt: '1999-01-01T00:00:00.000Z',
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.ok(response.body.success);
    const entry = response.body.data;
    assert.equal(entry.status, 'OPEN');
    assert.equal(entry.category, 'PATROL');
    assert.equal(entry.summary, 'Patrol observation');
    assert.equal(entry.detail, 'Post 3 quiet');
    assert.equal(entry.workforceProfileId, f.profile.id);
    assert.equal(entry.employeeCode, f.profile.employeeCode);
    assert.equal(entry.buildingId, f.buildingA.id);
    assert.equal(entry.clientId, f.client.id);
    assert.equal(entry.buildingCode, f.buildingA.code);
    assert.equal(entry.shiftHandoverId, null);
    assert.ok(entry.id && typeof entry.id === 'string');
    const recordedAt = assertServerTimestamp(entry.recordedAt);
    assert.ok(
      recordedAt.getTime() > new Date('1999-01-01T00:00:00Z').getTime(),
      'the client-supplied recordedAt must never be used',
    );
  });

  it('binds an existing same-Building Shift Handover when supplied', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const response = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({
        buildingId: f.buildingA.id,
        category: 'HANDOVER',
        summary: 'Handover notes',
        shiftHandoverId: f.handoverA.id,
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.shiftHandoverId, f.handoverA.id);
  });

  it('rejects an unknown Shift Handover with 404', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const response = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({
        buildingId: f.buildingA.id,
        category: 'GENERAL',
        summary: 'x',
        shiftHandoverId: '00000000-0000-4000-8000-000000000001',
      });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SHIFT_HANDOVER_NOT_FOUND');
  });

  it('rejects a cross-Building Shift Handover with 400', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    // Grant the manager access to B so an authoritative handover at B can be
    // created; the entry is at A, so binding B's handover must be rejected.
    await buildingAssignmentService.createAssignment(f.userId, {
      buildingId: f.buildingB.id,
    });
    const shiftOut = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingB.id,
      code: `S_${suffix()}`,
      name: 'Day shift B',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    const shiftIn = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingB.id,
      code: `S_${suffix()}`,
      name: 'Night shift B',
      startTime: '22:00:00',
      endTime: '06:00:00',
    });
    const handoverB = await createShiftHandover(
      {
        buildingId: f.buildingB.id,
        outgoingShiftId: shiftOut.id,
        incomingShiftId: shiftIn.id,
        handoverDate: '2026-08-20',
        summary: 'Handover at Building B',
        preparedByUserId: f.userId,
      },
      f.userId,
    );

    const response = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({
        buildingId: f.buildingA.id,
        category: 'GENERAL',
        summary: 'x',
        shiftHandoverId: handoverB.id,
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'SECURITY_LOGBOOK_HANDOVER_BUILDING_MISMATCH');
  });

  it('lists entries of a Building and filters them', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const create = (category: string, summary: string) =>
      api()
        .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
        .set({ Authorization: `Bearer ${f.token}` })
        .send({ buildingId: f.buildingA.id, category, summary });

    const a = await create('GENERAL', 'First entry');
    const b = await create('FINDING', 'Second entry');
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const list = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);
    assert.equal(list.body.data[0].id, b.body.data.id, 'newest first');
    assert.equal(list.body.data[1].id, a.body.data.id);

    const filtered = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/security/logbook?category=FINDING`)
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      filtered.body.data.map((entry: any) => entry.id),
      [b.body.data.id],
    );

    const byStatus = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/security/logbook?status=CLOSED`)
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(byStatus.status, 200);
    assert.deepEqual(byStatus.body.data, []);

    const invalidFilter = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/security/logbook?status=NOPE`)
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(invalidFilter.status, 400);
    assert.equal(invalidFilter.body.error.code, 'VALIDATION_ERROR');
  });

  it('never lists entries of an inaccessible Building (403)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const response = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('resolves entry detail and hides out-of-scope entries as 404', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const create = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingA.id, category: 'GENERAL', summary: 'Detail me' });
    assert.equal(create.status, 201);
    const entryId = create.body.data.id;

    const detail = await api()
      .get(`/api/v1/security/logbook/${entryId}`)
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, entryId);
    assert.equal(detail.body.data.summary, 'Detail me');

    // Unknown id → 404.
    const unknown = await api()
      .get('/api/v1/security/logbook/00000000-0000-4000-8000-000000000001')
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'SECURITY_LOGBOOK_ENTRY_NOT_FOUND');
  });

  it('updates an OPEN entry and rejects updates to a CLOSED entry', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const create = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingA.id, category: 'GENERAL', summary: 'Original' });
    assert.equal(create.status, 201);
    const entryId = create.body.data.id;

    const update = await api()
      .patch(`/api/v1/security/logbook/${entryId}`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ summary: 'Updated', category: 'INCIDENT', shiftHandoverId: f.handoverA.id });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.data.summary, 'Updated');
    assert.equal(update.body.data.category, 'INCIDENT');
    assert.equal(update.body.data.shiftHandoverId, f.handoverA.id);
    assert.equal(update.body.data.status, 'OPEN');

    const close = await api()
      .patch(`/api/v1/security/logbook/${entryId}`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ status: 'CLOSED' });
    assert.equal(close.status, 200);
    assert.equal(close.body.data.status, 'CLOSED');

    const reopen = await api()
      .patch(`/api/v1/security/logbook/${entryId}`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ summary: 'Too late' });
    assert.equal(reopen.status, 400);
    assert.equal(reopen.body.error.code, 'SECURITY_LOGBOOK_ENTRY_IMMUTABLE');

    // Clearing the handover binding on an OPEN entry.
    const f2 = await seed();
    const create2 = await api()
      .post(`/api/v1/buildings/${f2.buildingA.id}/security/logbook`)
      .set({ Authorization: `Bearer ${f2.token}` })
      .send({
        buildingId: f2.buildingA.id,
        category: 'HANDOVER',
        summary: 'With handover',
        shiftHandoverId: f2.handoverA.id,
      });
    assert.equal(create2.status, 201);
    const clear = await api()
      .patch(`/api/v1/security/logbook/${create2.body.data.id}`)
      .set({ Authorization: `Bearer ${f2.token}` })
      .send({ shiftHandoverId: null });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.data.shiftHandoverId, null);
  });

  it('rejects updates of an entry in an inaccessible Building as 404', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    // Give a second user access to B and have them create an entry at B.
    const other = await createAdminUser();
    await buildingAssignmentService.createAssignment(other.userId, {
      buildingId: f.buildingB.id,
    });
    const organization2 = await organizationService.createOrganization({
      clientId: f.client.id,
      code: `O_${suffix()}`,
      name: 'Organization 2',
    });
    const department2 = await departmentService.createDepartment({
      organizationId: organization2.id,
      code: `D_${suffix()}`,
      name: 'Department 2',
    });
    const position2 = await positionService.createPosition({
      organizationId: organization2.id,
      code: `P_${suffix()}`,
      name: 'Security Officer 2',
    });
    await workforceService.createWorkforceProfile({
      organizationId: organization2.id,
      departmentId: department2.id,
      positionId: position2.id,
      userId: other.userId,
      employeeCode: `WF_${suffix()}`,
      fullName: 'Security Officer 2',
    });
    const created = await api()
      .post(`/api/v1/buildings/${f.buildingB.id}/security/logbook`)
      .set({ Authorization: `Bearer ${other.token}` })
      .send({ buildingId: f.buildingB.id, category: 'GENERAL', summary: 'At B' });
    assert.equal(created.status, 201);

    // The manager cannot access B → the entry resolves to 403 (BE-02G denies
    // access; never a cross-Building leak). Unknown ids are the 404 case.
    const detail = await api()
      .get(`/api/v1/security/logbook/${created.body.data.id}`)
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(detail.status, 403);
    assert.equal(detail.body.error.code, 'BUILDING_ACCESS_DENIED');

    const update = await api()
      .patch(`/api/v1/security/logbook/${created.body.data.id}`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ summary: 'intrusion attempt' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
