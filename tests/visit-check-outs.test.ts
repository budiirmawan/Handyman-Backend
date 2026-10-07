import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-13H — Check-Out focused validation.
 *
 * Covers:
 *  - valid check-out closes the active visit
 *  - check-in history preserved on the same row
 *  - visit not checked-in rejected (cancelled row)
 *  - duplicate check-out rejected (terminal, immutable)
 *  - completed visit no longer appears as active; visit slot freed
 *  - check-out time validation (future / before check-in)
 *  - completed visit listing by Building/date
 *  - RBAC and Client / Building isolation
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       visit_check_ins, host_confirmations, visitor_photos,
       walk_in_visits, expected_visitors, visitor_invitations, visitors,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
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
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

const HOUR = 60 * 60 * 1000;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Check-out client A',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });

  const clientB = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Check-out client B',
  });
  const propertyB = await propertyService.createProperty({
    clientId: clientB.id,
    code: `P_${suffix()}`,
    name: 'Property B',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyB.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });

  const bAdmin = await createAdminUser();
  await buildingAssignmentService.createAssignment(bAdmin.userId, {
    buildingId: buildingB.id,
  });

  return { clientA, clientB, buildingA, buildingB, bAdmin };
}

/** Creates visitor + walk-in + active check-in; returns the check-in. */
async function activeCheckIn(
  f: Awaited<ReturnType<typeof seed>>,
  label = 'Departing Guest',
) {
  const visitor = (
    await api()
      .post(`/api/v1/clients/${f.clientA.id}/visitors`)
      .set(auth())
      .send({ fullName: `${label} ${suffix()}` })
  ).body.data;
  const walkIn = (
    await api()
      .post('/api/v1/walk-in-visits')
      .set(auth())
      .send({
        buildingId: f.buildingA.id,
        visitorId: visitor.id,
        hostName: 'Departure host',
        purpose: 'Check-out test',
      })
  ).body.data;
  const checkIn = await api()
    .post('/api/v1/visit-check-ins')
    .set(auth())
    .send({ walkInVisitId: walkIn.id, entryNotes: 'Original entry note.' });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
  return { visitor, walkIn, checkIn: checkIn.body.data };
}

async function checkOut(
  id: string,
  body: Record<string, unknown> = {},
  token = managerToken,
) {
  return api()
    .post(`/api/v1/visit-check-ins/${id}/check-out`)
    .set(auth(token))
    .send(body);
}

describe('BE-13H visit check-out', () => {
  it('checks out an active visit and preserves check-in history', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const { checkIn } = await activeCheckIn(f);

    const response = await checkOut(checkIn.id, {
      exitNotes: 'Badge returned at lobby.',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.id, checkIn.id);
    assert.equal(data.status, 'CHECKED_OUT');
    assert.ok(data.checkedOutAt);
    assert.equal(data.checkedOutByUserId, managerUserId);
    assert.equal(data.exitNotes, 'Badge returned at lobby.');

    // Original check-in history preserved on the SAME row.
    assert.equal(data.checkedInAt, checkIn.checkedInAt);
    assert.equal(data.checkedInByUserId, checkIn.checkedInByUserId);
    assert.equal(data.entryNotes, 'Original entry note.');
    assert.equal(data.visitorId, checkIn.visitorId);
    assert.equal(data.walkInVisitId, checkIn.walkInVisitId);
    assert.equal(data.buildingId, checkIn.buildingId);

    // Get reflects the completed state.
    const read = await api()
      .get(`/api/v1/visit-check-ins/${checkIn.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, 'CHECKED_OUT');
    assert.equal(read.body.data.entryNotes, 'Original entry note.');
  });

  it('accepts an explicit check-out time within the valid window', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const { checkIn } = await activeCheckIn(f, 'Timed Guest');

    const checkedOutAt = new Date().toISOString();
    const response = await checkOut(checkIn.id, { checkedOutAt });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.checkedOutAt, checkedOutAt);
  });

  it('rejects check-out of a visit that is not actively checked in', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A CANCELLED check-in cannot be checked out.
    const { checkIn } = await activeCheckIn(f, 'Cancelled Guest');
    await api()
      .post(`/api/v1/visit-check-ins/${checkIn.id}/cancel`)
      .set(auth());
    const cancelledOut = await checkOut(checkIn.id);
    assert.equal(cancelledOut.status, 409, JSON.stringify(cancelledOut.body));
    assert.equal(
      cancelledOut.body.error.code,
      'VISIT_CHECK_OUT_NOT_ACTIVE',
    );

    // Unknown row → 404.
    const unknown = await checkOut(randomUUID());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'VISIT_CHECK_IN_NOT_FOUND');
  });

  it('rejects duplicate check-out and keeps the record immutable', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const { checkIn } = await activeCheckIn(f, 'Twice Guest');

    const first = await checkOut(checkIn.id);
    assert.equal(first.status, 200);

    // Duplicate check-out → 409.
    const dup = await checkOut(checkIn.id);
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(
      dup.body.error.code,
      'VISIT_CHECK_OUT_ALREADY_CHECKED_OUT',
    );

    // A completed visit cannot be cancelled either — history is closed.
    const cancelAfter = await api()
      .post(`/api/v1/visit-check-ins/${checkIn.id}/cancel`)
      .set(auth());
    assert.equal(cancelAfter.status, 409);
    assert.equal(
      cancelAfter.body.error.code,
      'VISIT_CHECK_OUT_ALREADY_CHECKED_OUT',
    );
  });

  it('validates the check-out timestamp', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const { checkIn } = await activeCheckIn(f, 'Time Guest');

    // Future timestamp.
    const future = await checkOut(checkIn.id, {
      checkedOutAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    assert.equal(future.status, 400);
    assert.equal(future.body.error.code, 'VISIT_CHECK_OUT_TIME_IN_FUTURE');

    // Before the original check-in.
    const tooEarly = await checkOut(checkIn.id, {
      checkedOutAt: new Date(Date.now() - 5 * HOUR).toISOString(),
    });
    assert.equal(tooEarly.status, 400);
    assert.equal(
      tooEarly.body.error.code,
      'VISIT_CHECK_OUT_BEFORE_CHECK_IN',
    );

    // Malformed timestamp.
    const malformed = await checkOut(checkIn.id, { checkedOutAt: 'later' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    // The row is still active after the failed attempts.
    const read = await api()
      .get(`/api/v1/visit-check-ins/${checkIn.id}`)
      .set(auth());
    assert.equal(read.body.data.status, 'CHECKED_IN');
  });

  it('removes completed visits from the active list and frees the visit slot', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const { walkIn, checkIn } = await activeCheckIn(f, 'Completed Guest');

    await checkOut(checkIn.id);

    // No longer in the currently-checked-in listing.
    const active = await api()
      .get(
        `/api/v1/visit-check-ins?buildingId=${f.buildingA.id}&status=CHECKED_IN`,
      )
      .set(auth());
    assert.equal(active.status, 200);
    assert.ok(
      !active.body.data.some((x: { id: string }) => x.id === checkIn.id),
    );

    // Appears in the completed listing by Building/date window.
    const completed = await api()
      .get(
        `/api/v1/visit-check-ins?buildingId=${f.buildingA.id}&status=CHECKED_OUT` +
          `&checkedOutFrom=${encodeURIComponent(
            new Date(Date.now() - 1 * HOUR).toISOString(),
          )}`,
      )
      .set(auth());
    assert.equal(completed.status, 200);
    assert.ok(
      completed.body.data.some((x: { id: string }) => x.id === checkIn.id),
    );
    assert.ok(
      completed.body.data.every(
        (x: { status: string }) => x.status === 'CHECKED_OUT',
      ),
    );

    // The visit slot is freed — a NEW check-in for the same visit is
    // allowed after the previous one completed (return visit).
    const again = await api()
      .post('/api/v1/visit-check-ins')
      .set(auth())
      .send({ walkInVisitId: walkIn.id });
    assert.equal(again.status, 201, JSON.stringify(again.body));
  });

  it('enforces RBAC on check-out', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const { checkIn } = await activeCheckIn(f, 'RBAC Guest');
    const plainToken = await createPlainSession();

    const forbidden = await checkOut(checkIn.id, {}, plainToken);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().post(
      `/api/v1/visit-check-ins/${checkIn.id}/check-out`,
    );
    assert.equal(unauthenticated.status, 401);

    // The record is untouched.
    const read = await api()
      .get(`/api/v1/visit-check-ins/${checkIn.id}`)
      .set(auth());
    assert.equal(read.body.data.status, 'CHECKED_IN');
  });

  it('enforces Client / Building isolation on check-out', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const { checkIn } = await activeCheckIn(f, 'Isolated Guest');

    // A user without building-A access cannot check out a building-A
    // visit — Building context always derives from the row.
    const denied = await checkOut(checkIn.id, {}, f.bAdmin.token);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Completed rows stay isolated too.
    await checkOut(checkIn.id);
    const deniedRead = await api()
      .get(`/api/v1/visit-check-ins/${checkIn.id}`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Scoped completed listing never leaks building-A rows.
    const scoped = await api()
      .get('/api/v1/visit-check-ins?status=CHECKED_OUT')
      .set(auth(f.bAdmin.token));
    assert.equal(scoped.status, 200);
    const ids = scoped.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(checkIn.id));
  });
});
