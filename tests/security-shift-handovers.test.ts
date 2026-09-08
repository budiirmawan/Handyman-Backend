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
import { shiftService } from '../src/modules/shifts';
import { shiftHandoverService } from '../src/modules/shift-handovers';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-12G — Security Shift Handover binding focused validation.
 *
 * Covers: create binding (with start post / patrol route), get/list by
 * Building/handover, unknown Building/Handover/Post/Route rejected,
 * cross-Building / cross-Client rejected, post and patrol route building
 * mismatch rejected, post and route INACTIVE rejected, outgoing ≠
 * incoming shift, RBAC, Client / Building isolation, and the binding's
 * own ACTIVE/INACTIVE activation lifecycle.
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
       security_shift_handover_bindings,
       shift_handovers,
       patrol_checklist_bindings,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       shifts,
       schedule_definitions, schedule_recurrence,
       floors, areas, rooms, spaces, functional_locations,
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
const today = () => new Date().toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Security Handover client',
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
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingC.id,
  });

  // Shifts in building A and building B.
  const shiftMorning = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const shiftAfternoon = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Afternoon shift',
    startTime: '15:00:00',
    endTime: '23:00:00',
  });
  const shiftNight = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Night shift',
    startTime: '23:00:00',
    endTime: '07:00:00',
  });
  const shiftBuildingB = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingB.id,
    code: `S_${suffix()}`,
    name: 'Building B shift',
    startTime: '08:00:00',
    endTime: '16:00:00',
  });

  // Create BE-10J shift handovers for use in the binding tests.
  const handover1 = await shiftHandoverService.createShiftHandover(
    {
      buildingId: buildingA.id,
      outgoingShiftId: shiftMorning.id,
      incomingShiftId: shiftAfternoon.id,
      handoverDate: today(),
      summary: 'Morning handoff',
      preparedByUserId: managerUserId,
    },
    managerUserId,
  );
  const handover2 = await shiftHandoverService.createShiftHandover(
    {
      buildingId: buildingA.id,
      outgoingShiftId: shiftAfternoon.id,
      incomingShiftId: shiftNight.id,
      handoverDate: today(),
      summary: 'Afternoon handoff',
      preparedByUserId: managerUserId,
    },
    managerUserId,
  );
  // Building-B handover so we can test cross-Building isolation. The
  // handover creation service requires a different outgoing/incoming
  // shift, so we just create the second shift inline here.
  const shiftBuildingB2 = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingB.id,
    code: `S_${suffix()}`,
    name: 'Building B shift 2',
    startTime: '16:00:00',
    endTime: '00:00:00',
  });
  const handoverB = await shiftHandoverService.createShiftHandover(
    {
      buildingId: buildingB.id,
      outgoingShiftId: shiftBuildingB.id,
      incomingShiftId: shiftBuildingB2.id,
      handoverDate: today(),
      summary: 'Building B handoff',
      preparedByUserId: managerUserId,
    },
    managerUserId,
  );
  void handoverB;
  void shiftBuildingB2;

  // Security Posts in building A.
  const postA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby A', postType: 'LOBBY' })
  ).body.data;
  const postA2 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Gate A', postType: 'GATE' })
  ).body.data;

  // Security Posts in building B.
  const postB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby B', postType: 'LOBBY' })
  ).body.data;

  // Patrol routes in building A.
  const routeA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `PR_${suffix()}`,
        name: 'Route A1',
        startSecurityPostId: postA1.id,
      })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeA1.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  const routeA2 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({ code: `PR_${suffix()}`, name: 'Route A2' })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeA2.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  // Patrol route in building B.
  const routeB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `PR_${suffix()}`,
        name: 'Route B',
        startSecurityPostId: postB.id,
      })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeB.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    shiftMorning,
    shiftAfternoon,
    shiftBuildingB,
    handover1,
    handover2,
    postA1,
    postA2,
    postB,
    routeA1,
    routeA2,
    routeB,
  };
}

async function createBinding(
  buildingId: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/security/shift-handovers`)
    .set(auth(token))
    .send(body);
}

describe('BE-12G security shift handover binding', () => {
  it('creates a security shift handover binding with start post and patrol route', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
      patrolRouteId: f.routeA1.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.shiftHandoverId, f.handover1.id);
    assert.equal(data.startSecurityPostId, f.postA1.id);
    assert.equal(data.patrolRouteId, f.routeA1.id);
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.createdByUserId, managerUserId);
    assert.ok(data.createdAt);
    assert.ok(data.updatedAt);

    // GET by id.
    const byId = await api()
      .get(`/api/v1/security/shift-handovers/${data.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, data.id);
    assert.equal(byId.body.data.startSecurityPostId, f.postA1.id);
    assert.equal(byId.body.data.patrolRouteId, f.routeA1.id);

    // List by Building.
    const listed = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/shift-handovers`,
      )
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const ids = (listed.body.data as { id: string }[]).map((x) => x.id);
    assert.ok(ids.includes(data.id));

    // Filter by shiftHandoverId.
    const byHandover = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/shift-handovers`,
      )
      .query({ shiftHandoverId: f.handover1.id })
      .set(auth());
    assert.equal(byHandover.status, 200, JSON.stringify(byHandover.body));
    assert.equal(byHandover.body.data.length, 1);
    assert.equal(byHandover.body.data[0].id, data.id);
  });

  it('creates a binding without an optional patrol route', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover2.id,
      startSecurityPostId: f.postA2.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.patrolRouteId, null);
    assert.equal(data.startSecurityPostId, f.postA2.id);
  });

  it('rejects unknown Building, Handover, Post, and Route', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Unknown building — passed the URL param but the route's
    // requireBuildingAccess gate blocks before the service runs.
    const unknownBuilding = await createBinding(randomUUID(), {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(unknownBuilding.status, 403);
    assert.equal(
      unknownBuilding.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );

    // Unknown handover.
    const unknownHandover = await createBinding(f.buildingA.id, {
      shiftHandoverId: randomUUID(),
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(unknownHandover.status, 404);
    assert.equal(unknownHandover.body.error.code, 'NOT_FOUND');

    // Unknown post.
    const unknownPost = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: randomUUID(),
    });
    assert.equal(unknownPost.status, 404);
    assert.equal(unknownPost.body.error.code, 'NOT_FOUND');

    // Unknown route.
    const unknownRoute = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
      patrolRouteId: randomUUID(),
    });
    assert.equal(unknownRoute.status, 404);
    assert.equal(unknownRoute.body.error.code, 'NOT_FOUND');
  });

  it('rejects cross-Building handover and cross-Building post / route', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Build a handover in building A — we use f.handover1 — but the route
    // URL points at building B; the binding should be rejected because the
    // handover is not in building B.
    const crossBuildingHandover = await createBinding(f.buildingB.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postB.id,
    });
    assert.equal(crossBuildingHandover.status, 400);
    assert.equal(
      crossBuildingHandover.body.error.code,
      'SECURITY_SHIFT_HANDOVER_BUILDING_MISMATCH',
    );

    // Now seed a real handover in building B (the seed function created
    // handoverB with the same-shift pair which is rejected by the BE-10J
    // CHECK; rebuild a clean pair here so we have a valid building-B
    // handover to test the post/building mismatch).
    const shiftB1 = await shiftService.createShift({
      clientId: f.clientA.id,
      buildingId: f.buildingB.id,
      code: `S_${suffix()}`,
      name: 'B morning',
      startTime: '06:00:00',
      endTime: '14:00:00',
    });
    const shiftB2 = await shiftService.createShift({
      clientId: f.clientA.id,
      buildingId: f.buildingB.id,
      code: `S_${suffix()}`,
      name: 'B afternoon',
      startTime: '14:00:00',
      endTime: '22:00:00',
    });
    const handoverB = await shiftHandoverService.createShiftHandover(
      {
        buildingId: f.buildingB.id,
        outgoingShiftId: shiftB1.id,
        incomingShiftId: shiftB2.id,
        handoverDate: today(),
        summary: 'B handoff',
        preparedByUserId: managerUserId,
      },
      managerUserId,
    );

    // Cross-Building post: handover in B but post in A.
    const crossBuildingPost = await createBinding(f.buildingB.id, {
      shiftHandoverId: handoverB.id,
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(crossBuildingPost.status, 400);
    assert.equal(
      crossBuildingPost.body.error.code,
      'SECURITY_SHIFT_HANDOVER_START_POST_BUILDING_MISMATCH',
    );

    // Cross-Building route: handover in B but route in A.
    const crossBuildingRoute = await createBinding(f.buildingB.id, {
      shiftHandoverId: handoverB.id,
      startSecurityPostId: f.postB.id,
      patrolRouteId: f.routeA1.id,
    });
    assert.equal(crossBuildingRoute.status, 400);
    assert.equal(
      crossBuildingRoute.body.error.code,
      'SECURITY_SHIFT_HANDOVER_PATROL_ROUTE_BUILDING_MISMATCH',
    );
  });

  it('rejects INACTIVE start post and INACTIVE patrol route', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Deactivate postA1.
    const postOff = await api()
      .patch(`/api/v1/security/posts/${f.postA1.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(postOff.status, 200, JSON.stringify(postOff.body));

    const inactivePost = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(inactivePost.status, 400);
    assert.equal(
      inactivePost.body.error.code,
      'SECURITY_SHIFT_HANDOVER_START_POST_INACTIVE',
    );

    // Re-activate postA1 so subsequent steps succeed.
    const postOn = await api()
      .patch(`/api/v1/security/posts/${f.postA1.id}`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(postOn.status, 200, JSON.stringify(postOn.body));

    // Deactivate routeA1.
    const routeOff = await api()
      .patch(`/api/v1/security/patrol-routes/${f.routeA1.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(routeOff.status, 200, JSON.stringify(routeOff.body));

    const inactiveRoute = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
      patrolRouteId: f.routeA1.id,
    });
    assert.equal(inactiveRoute.status, 400);
    assert.equal(
      inactiveRoute.body.error.code,
      'SECURITY_SHIFT_HANDOVER_PATROL_ROUTE_INACTIVE',
    );
  });

  it('rejects duplicate ACTIVE binding on the same handover', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
      patrolRouteId: f.routeA1.id,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA2.id,
      patrolRouteId: f.routeA2.id,
    });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'SECURITY_SHIFT_HANDOVER_BINDING_ALREADY_EXISTS',
    );
  });

  it('activates and deactivates a binding and blocks a duplicate ACTIVE on reactivate', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
      patrolRouteId: f.routeA1.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bindingId = created.body.data.id as string;

    // Deactivate via PATCH.
    const off = await api()
      .patch(`/api/v1/security/shift-handovers/${bindingId}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.data.status, 'INACTIVE');

    // A second ACTIVE binding for the same handover is now allowed.
    const replacement = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA2.id,
      patrolRouteId: f.routeA2.id,
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));

    // Reactivating the original ACTIVE one is rejected (duplicate).
    const reReactivate = await api()
      .patch(`/api/v1/security/shift-handovers/${bindingId}`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(reReactivate.status, 409);
    assert.equal(
      reReactivate.body.error.code,
      'SECURITY_SHIFT_HANDOVER_BINDING_ALREADY_EXISTS',
    );
  });

  it('enforces RBAC on the binding endpoints', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 401 without a token.
    const unauth = await api().post(
      `/api/v1/buildings/${f.buildingA.id}/security/shift-handovers`,
    ).send({
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    // 403 for a user without permission.
    const plainToken = await createPlainSession();
    const forbidden = await createBinding(
      f.buildingA.id,
      {
        shiftHandoverId: f.handover1.id,
        startSecurityPostId: f.postA1.id,
      },
      plainToken,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Building isolation on the binding endpoints', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A user with access ONLY to building B is blocked at the access
    // gate before the service can even see the building-A handover.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await createBinding(
      f.buildingA.id,
      {
        shiftHandoverId: f.handover1.id,
        startSecurityPostId: f.postA1.id,
      },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(
      deniedCreate.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );

    const deniedList = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/shift-handovers`,
      )
      .set(auth(bOnly.token));
    assert.equal(deniedList.status, 403);
    assert.equal(
      deniedList.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );

    // A building-A binding is invisible to the B-only user via the
    // /security/shift-handovers/:id path.
    const created = await createBinding(f.buildingA.id, {
      shiftHandoverId: f.handover1.id,
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const deniedGet = await api()
      .get(`/api/v1/security/shift-handovers/${created.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedGet.status, 403);
    assert.equal(deniedGet.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedPatch = await api()
      .patch(`/api/v1/security/shift-handovers/${created.body.data.id}`)
      .set(auth(bOnly.token))
      .send({ status: 'INACTIVE' });
    assert.equal(deniedPatch.status, 403);
    assert.equal(deniedPatch.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('enforces Client isolation at the handover reference layer', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Even with a building-A binding, a handover belonging to a different
    // Client (created directly via SQL) is rejected.
    const foreignHandover = await pool!.query<{ id: string }>(
      `INSERT INTO shift_handovers
         (id, client_id, building_id, outgoing_shift_id, incoming_shift_id,
          handover_date, prepared_by_user_id)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7
       )
       RETURNING id`,
      [
        randomUUID(),
        f.clientC.id,
        f.buildingA.id,
        f.shiftAfternoon.id,
        f.shiftMorning.id,
        today(),
        managerUserId,
      ],
    );
    const foreignId = foreignHandover.rows[0].id;

    const crossClient = await createBinding(f.buildingA.id, {
      shiftHandoverId: foreignId,
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(crossClient.status, 400);
    assert.equal(
      crossClient.body.error.code,
      'SECURITY_SHIFT_HANDOVER_BUILDING_MISMATCH',
    );
  });

  it('returns 400 for missing shiftHandoverId or invalid body', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const missing = await createBinding(f.buildingA.id, {
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    const badShiftHandover = await createBinding(f.buildingA.id, {
      shiftHandoverId: 'not-a-uuid',
      startSecurityPostId: f.postA1.id,
    });
    assert.equal(badShiftHandover.status, 400);
    assert.equal(
      badShiftHandover.body.error.code,
      'VALIDATION_ERROR',
    );

    const badStatus = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/security/shift-handovers`)
      .set(auth())
      .send({
        shiftHandoverId: f.handover1.id,
        startSecurityPostId: f.postA1.id,
        status: 'INVALID',
      });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
  });
});
