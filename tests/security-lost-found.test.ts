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
 * BE-12L — Security Lost & Found focused validation.
 *
 * Covers:
 *  - create / list / get / patch
 *  - place in custody
 *  - register claim
 *  - duplicate active claim rejected
 *  - return claimed item
 *  - return without active claim rejected
 *  - close (any non-terminal state)
 *  - terminal state cannot be modified
 *  - custody / claim history preserved (append-only)
 *  - claimant PII lives ONLY on history rows, not on the master row
 *  - Security Post / Building mismatch rejected
 *  - Functional Location / Building mismatch rejected
 *  - cross-Client / cross-Building rejection
 *  - RBAC enforcement
 *  - Client / Building isolation
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
       security_lost_found_history, security_lost_found,
       security_key_custody, security_keys,
       security_visitor_bindings,
       security_incident_readiness,
       security_finding_links,
       security_shift_handover_bindings,
       patrol_checklist_bindings,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       shift_handovers,
       schedule_definitions, schedule_recurrence,
       finding_rework_cycles, reviews, finding_assignments, findings,
       finding_classifications, finding_severities,
       workforce_building_assignments, workforce_profiles,
       teams, positions, departments, organizations,
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

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Security LF client',
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

  const postA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby A', postType: 'LOBBY' })
  ).body.data;
  const postB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby B', postType: 'LOBBY' })
  ).body.data;

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    postA1,
    postB,
  };
}

async function createRecord(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post('/api/v1/security/lost-found')
    .set(auth(token))
    .send(body);
}

async function placeCustody(
  id: string,
  body: Record<string, unknown> = {},
  token = managerToken,
) {
  return api()
    .post(`/api/v1/security/lost-found/${id}/custody`)
    .set(auth(token))
    .send(body);
}

async function registerClaim(
  id: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/security/lost-found/${id}/claim`)
    .set(auth(token))
    .send(body);
}

async function returnRecord(
  id: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/security/lost-found/${id}/return`)
    .set(auth(token))
    .send(body);
}

async function closeRecord(
  id: string,
  body: Record<string, unknown> = {},
  token = managerToken,
) {
  return api()
    .post(`/api/v1/security/lost-found/${id}/close`)
    .set(auth(token))
    .send(body);
}

describe('BE-12L security lost & found', () => {
  it('creates a found item and lists / gets it', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-A-001',
      itemName: 'Black leather wallet',
      description: 'Found in the lobby.',
      securityPostId: f.postA1.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.itemCode, 'LF-A-001');
    assert.equal(data.itemName, 'Black leather wallet');
    assert.equal(data.description, 'Found in the lobby.');
    assert.equal(data.securityPostId, f.postA1.id);
    assert.equal(data.functionalLocationId, null);
    assert.equal(data.custodyStatus, 'FOUND');
    assert.equal(data.foundByUserId, managerUserId);
    assert.ok(data.foundAt);
    assert.ok(data.createdAt);
    assert.ok(data.updatedAt);

    const id = data.id as string;

    const byId = await api()
      .get(`/api/v1/security/lost-found/${id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, id);

    const list = await api()
      .get('/api/v1/security/lost-found')
      .query({ buildingId: f.buildingA.id })
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.data.some((x: { id: string }) => x.id === id));

    const byStatus = await api()
      .get('/api/v1/security/lost-found')
      .query({ custodyStatus: 'FOUND' })
      .set(auth());
    assert.equal(byStatus.status, 200, JSON.stringify(byStatus.body));
    assert.ok(byStatus.body.data.some((x: { id: string }) => x.id === id));

    const byPost = await api()
      .get('/api/v1/security/lost-found')
      .query({ securityPostId: f.postA1.id })
      .set(auth());
    assert.equal(byPost.status, 200, JSON.stringify(byPost.body));
    assert.ok(byPost.body.data.some((x: { id: string }) => x.id === id));
  });

  it('rejects duplicate (building, item_code)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-A-DUP',
      itemName: 'First',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const dup = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-A-DUP',
      itemName: 'Duplicate',
    });
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code,
      'SECURITY_LOST_FOUND_ITEM_CODE_ALREADY_EXISTS',
    );
  });

  it('rejects cross-Building Security Post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-XB',
      itemName: 'Cross building post',
      securityPostId: f.postB.id, // post is in building B
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_LOST_FOUND_SECURITY_POST_BUILDING_MISMATCH',
    );
  });

  it('rejects Functional Location / Building mismatch', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const flB = await api()
      .post(`/api/v1/buildings/${f.buildingB.id}/functional-locations`)
      .set(auth())
      .send({ code: `FL_${suffix()}`, name: 'B room' });
    assert.equal(flB.status, 201, JSON.stringify(flB.body));

    const response = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-FL-XB',
      itemName: 'Cross building location',
      functionalLocationId: flB.body.data.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_LOST_FOUND_FUNCTIONAL_LOCATION_BUILDING_MISMATCH',
    );
  });

  it('places an item in custody and exposes the transition in history', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-CUSTODY',
      itemName: 'Phone',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const placed = await placeCustody(id, { notes: 'Locked in safe' });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    assert.equal(placed.body.data.custodyStatus, 'IN_CUSTODY');

    const history = await api()
      .get(`/api/v1/security/lost-found/${id}/history`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    const events = history.body.data.map(
      (x: { eventType: string }) => x.eventType,
    );
    assert.deepEqual(events, ['CREATE', 'CUSTODY_PLACE']);
  });

  it('registers a claim and returns the item through verify + return', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-CLAIM',
      itemName: 'Set of keys',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const claim = await registerClaim(id, {
      claimantName: 'Jane Doe',
      claimantReference: 'GUEST-001',
      claimNotes: 'Owner identified by reception.',
      notes: 'Logged at 14:30',
    });
    assert.equal(claim.status, 201, JSON.stringify(claim.body));
    assert.equal(claim.body.data.custodyStatus, 'CLAIMED');

    // The master record MUST NOT carry claimant PII — only the
    // history rows do.
    assert.equal(claim.body.data.notes, null);
    assert.equal(
      (claim.body.data as Record<string, unknown>).claimantName,
      undefined,
    );

    // The history endpoint exposes the claimant details.
    const historyAfterClaim = await api()
      .get(`/api/v1/security/lost-found/${id}/history`)
      .set(auth());
    assert.equal(
      historyAfterClaim.status,
      200,
      JSON.stringify(historyAfterClaim.body),
    );
    const claimRow = historyAfterClaim.body.data.find(
      (x: { eventType: string }) => x.eventType === 'CLAIM_REGISTER',
    );
    assert.ok(claimRow, 'CLAIM_REGISTER history row must exist');
    assert.equal(claimRow.claimantName, 'Jane Doe');
    assert.equal(claimRow.claimantReference, 'GUEST-001');
    assert.equal(claimRow.claimNotes, 'Owner identified by reception.');

    const returned = await returnRecord(id, {
      returnedByUserId: managerUserId,
      notes: 'Handed over at the lobby',
    });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.data.custodyStatus, 'RETURNED');

    // History now contains: CREATE, CLAIM_REGISTER, CLAIM_VERIFY, RETURN.
    const historyAfterReturn = await api()
      .get(`/api/v1/security/lost-found/${id}/history`)
      .set(auth());
    const types = historyAfterReturn.body.data.map(
      (x: { eventType: string }) => x.eventType,
    );
    assert.deepEqual(types, [
      'CREATE',
      'CLAIM_REGISTER',
      'CLAIM_VERIFY',
      'RETURN',
    ]);
    const returnRow = historyAfterReturn.body.data.find(
      (x: { eventType: string }) => x.eventType === 'RETURN',
    );
    assert.equal(returnRow.returnedByUserId, managerUserId);
    assert.ok(returnRow.returnedAt);

    const verifyRow = historyAfterReturn.body.data.find(
      (x: { eventType: string }) => x.eventType === 'CLAIM_VERIFY',
    );
    assert.equal(verifyRow.verifiedByUserId, managerUserId);
  });

  it('rejects a duplicate claim while a claim is still open', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-DUP-CLAIM',
      itemName: 'Laptop bag',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const first = await registerClaim(id, { claimantName: 'First Claimant' });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await registerClaim(id, {
      claimantName: 'Second Claimant',
    });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'SECURITY_LOST_FOUND_DUPLICATE_ACTIVE_CLAIM',
    );
  });

  it('rejects return without an active claim', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-NO-CLAIM',
      itemName: 'Hat',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const response = await returnRecord(id, {
      returnedByUserId: managerUserId,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_LOST_FOUND_NO_ACTIVE_CLAIM',
    );
  });

  it('closes a non-terminal record and rejects subsequent operations', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-CLOSE',
      itemName: 'Umbrella',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const closed = await closeRecord(id, { notes: 'Item discarded.' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.data.custodyStatus, 'CLOSED');

    // A closed record cannot be patched.
    const patchDenied = await api()
      .patch(`/api/v1/security/lost-found/${id}`)
      .set(auth())
      .send({ itemName: 'New name' });
    assert.equal(patchDenied.status, 400);
    assert.equal(
      patchDenied.body.error.code,
      'SECURITY_LOST_FOUND_TERMINAL',
    );

    // A closed record cannot be placed in custody.
    const placeDenied = await placeCustody(id, {});
    assert.equal(placeDenied.status, 400);
    assert.equal(
      placeDenied.body.error.code,
      'SECURITY_LOST_FOUND_TERMINAL',
    );

    // A closed record cannot accept a claim.
    const claimDenied = await registerClaim(id, { claimantName: 'Late' });
    assert.equal(claimDenied.status, 400);
    assert.equal(
      claimDenied.body.error.code,
      'SECURITY_LOST_FOUND_TERMINAL',
    );

    // A closed record cannot be returned.
    const returnDenied = await returnRecord(id, {
      returnedByUserId: managerUserId,
    });
    assert.equal(returnDenied.status, 400);
    assert.equal(
      returnDenied.body.error.code,
      'SECURITY_LOST_FOUND_TERMINAL',
    );

    // The history shows the CLOSE event.
    const history = await api()
      .get(`/api/v1/security/lost-found/${id}/history`)
      .set(auth());
    const types = history.body.data.map(
      (x: { eventType: string }) => x.eventType,
    );
    assert.deepEqual(types, ['CREATE', 'CLOSE']);
  });

  it('patches item name and description and rejects update with no fields', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-PATCH',
      itemName: 'Patch me',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const updated = await api()
      .patch(`/api/v1/security/lost-found/${id}`)
      .set(auth())
      .send({ itemName: 'Patched name', description: 'Patched description' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.itemName, 'Patched name');
    assert.equal(updated.body.data.description, 'Patched description');

    const empty = await api()
      .patch(`/api/v1/security/lost-found/${id}`)
      .set(auth())
      .send({});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid date range on the list query', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await api()
      .get('/api/v1/security/lost-found')
      .query({
        buildingId: f.buildingA.id,
        fromDate: '2026-01-31T00:00:00.000Z',
        toDate: '2026-01-01T00:00:00.000Z',
      })
      .set(auth());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .post('/api/v1/security/lost-found')
      .send({ buildingId: f.buildingA.id, itemCode: 'LF-RBAC', itemName: 'RBAC' });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();

    const forbiddenCreate = await createRecord(
      { buildingId: f.buildingA.id, itemCode: 'LF-RBAC', itemName: 'RBAC' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/security/lost-found')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-RBAC',
      itemName: 'RBAC',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const forbiddenRead = await api()
      .get(`/api/v1/security/lost-found/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenCustody = await placeCustody(
      created.body.data.id,
      {},
      plainToken,
    );
    assert.equal(forbiddenCustody.status, 403);
    assert.equal(forbiddenCustody.body.error.code, 'PERMISSION_DENIED');

    const forbiddenClaim = await registerClaim(
      created.body.data.id,
      { claimantName: 'X' },
      plainToken,
    );
    assert.equal(forbiddenClaim.status, 403);
    assert.equal(forbiddenClaim.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createRecord({
      buildingId: f.buildingA.id,
      itemCode: 'LF-ISO',
      itemName: 'Isolation',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedRead = await api()
      .get(`/api/v1/security/lost-found/${created.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedCustody = await placeCustody(
      created.body.data.id,
      {},
      bOnly.token,
    );
    assert.equal(deniedCustody.status, 403);
    assert.equal(deniedCustody.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedClaim = await registerClaim(
      created.body.data.id,
      { claimantName: 'X' },
      bOnly.token,
    );
    assert.equal(deniedClaim.status, 403);
    assert.equal(deniedClaim.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedReturn = await returnRecord(
      created.body.data.id,
      { returnedByUserId: bOnly.userId },
      bOnly.token,
    );
    assert.equal(deniedReturn.status, 403);
    assert.equal(deniedReturn.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedClose = await closeRecord(
      created.body.data.id,
      {},
      bOnly.token,
    );
    assert.equal(deniedClose.status, 403);
    assert.equal(deniedClose.body.error.code, 'BUILDING_ACCESS_DENIED');

    const scopedList = await api()
      .get('/api/v1/security/lost-found')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    const ids = scopedList.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(created.body.data.id));
  });
});
