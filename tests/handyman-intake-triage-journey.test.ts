import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import {
  admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion,
} from '../src/modules/handyman-care-workspace/care-workspace.service';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextRepository } from '../src/modules/tenant-building-contexts';
import { tenantCompanyRepository } from '../src/modules/tenant-companies';
import { tenantSpaceRepository } from '../src/modules/tenant-spaces';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * W02 PART 04 — Intake → Operations triage runtime journey (focused).
 *
 * Journey (real endpoints, real authority, no fixture shortcuts on the flow):
 *   Customer Care session → create-exchange (tenant + unit) → POST care intake
 *   (INTAKE + reporter snapshot) → Operations queue list/detail → triage
 *   (existing `tenant_company.manage` + Building scope) → status projection →
 *   queue status filters → triage read → audit event.
 *
 * Negative cases: Operations-only operator cannot triage; cross-building and
 * revoked-assignment denial; Care token cannot act as an operator; invalid
 * disposition; triage on a non-INTAKE request; replay and concurrent replay
 * (exactly one triage, one event); requests outside the operator's scope.
 *
 * Authority note (not changed here): triage POST is guarded by the existing
 * `tenant_company.manage` + Building scope. The Operations queue read
 * permission `handyman.operations.request.read` alone does NOT grant triage.
 */

const CARE = '/api/v1/handyman/care/properties';
const CREATE = '/api/v1/handyman/requests/care';
const QUEUE = '/api/v1/handyman/operations/requests';
const HM = '/api/v1/handyman/requests';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55549;
const DIR = '/tmp/handyman-intake-triage-journey-pg';
const SECRET = 'intake-triage-journey-test-integration-secret';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const OPS = [{ code: 'handyman.operations.request.read', name: 'Read Handyman Operations Request Queue' }];
// W02 PART 04A: Operations triage authority is its own permission, not tenant_company.manage.
const TRIAGE = [
  { code: 'handyman.operations.request.triage', name: 'Triage Handyman Operations Requests' },
  { code: 'tenant_company.read', name: 'Read Tenant Companies' },
];
const TRIAGE_ONLY = [{ code: 'handyman.operations.request.triage', name: 'Triage Handyman Operations Requests' }];
const MANAGE_ONLY = [
  { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
  { code: 'tenant_company.read', name: 'Read Tenant Companies' },
];

let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string;
let envKey: string;
let careActorId: string;
let adminId: string;
let careToken = '';
let clientA: string;
let clientB: string;
let propA: string;
let propB: string;
let buildingA: string;
let buildingA2: string;
let buildingB: string;
let spaceA: string;
let spaceA2: string;
let spaceB: string;
let tenantA: string;
let tenantB: string;
let serviceA: string;
let serviceB: string;
let queueA: { token: string; userId: string };
let triageA: { token: string; userId: string };
let triageA2: { token: string; userId: string };
let opsOnlyA: { token: string; userId: string };
let queueA2: { token: string; userId: string };
let queueB: { token: string; userId: string };
let noAssign: { token: string; userId: string };
let revocable: { token: string; userId: string };

/** One assertion object is signed and admitted; never two different ones. */
async function admit() {
  const a = assertion();
  return admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET));
}

async function operator(codes: { code: string; name: string }[], buildingIds: string[]) {
  const token = await createSessionWithPermissions(codes);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'scoped-%' ORDER BY created_at DESC LIMIT 1`,
  );
  const userId = rows[0].id;
  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(userId, { buildingId }, adminId);
  }
  return { token, userId };
}

function assertion(overrides: Partial<CareWorkspaceAssertion> = {}): CareWorkspaceAssertion {
  return {
    purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'intake-agent-w04' }, ...overrides,
  };
}

/** Full Customer Care leg: create-exchange for tenant + unit, then the care POST. */
async function intake(
  tenant: 'A' | 'A2' | 'B',
  body: Record<string, unknown> = {},
): Promise<{ status: number; id: string; body: any }> {
  const config = tenant === 'B'
    ? { property: propB, tenantCompanyId: tenantB, buildingId: buildingB, spaceId: spaceB, serviceId: serviceB }
    : { property: propA, tenantCompanyId: tenantA, buildingId: tenant === 'A' ? buildingA : buildingA2,
        spaceId: tenant === 'A' ? spaceA : spaceA2, serviceId: serviceA };
  const issued = await api().post(`${CARE}/${config.property}/create-exchanges`)
    .set('Authorization', `Bearer ${careToken}`)
    .send({ tenantCompanyId: config.tenantCompanyId, buildingId: config.buildingId, spaceId: config.spaceId });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const created = await api().post(CREATE).send({
    exchangeToken: issued.body.data.exchangeToken,
    serviceCatalogId: config.serviceId,
    description: 'Journey intake',
    ...body,
  });
  return { status: created.status, id: created.body?.data?.id ?? '', body: created.body };
}

const triage = (credential: string, id: string, payload: Record<string, unknown>) =>
  api().post(`${HM}/${id}/triage`).set('Authorization', `Bearer ${credential}`).send(payload);
const triageRead = (credential: string, id: string) =>
  api().get(`${HM}/${id}/triage`).set('Authorization', `Bearer ${credential}`);
const list = (credential: string, query: Record<string, unknown> = {}) =>
  api().get(QUEUE).set('Authorization', `Bearer ${credential}`).query({ limit: 100, ...query });
const detail = (credential: string, id: string) =>
  api().get(`${QUEUE}/${id}`).set('Authorization', `Bearer ${credential}`);

const GOOD_REPORTER = { reporter: { name: 'Journey Reporter', phone: '+628111222333', email: 'journey@example.com' } };
const decision = { disposition: 'INSPECTION_REQUIRED', note: 'Site inspection needed before quotation' };

async function state(id: string) {
  const r = await pool.query(
    `SELECT r.status,
            (SELECT count(*)::int FROM handyman_request_triage_decisions t WHERE t.handyman_request_id = r.id) AS triage
       FROM handyman_service_requests r WHERE r.id = $1`,
    [id],
  );
  return r.rows[0] as { status: string; triage: number };
}
async function triageEvents(id: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM operational_events WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_TRIAGED'`,
    [id],
  );
  return r.rows[0].n;
}

before(async () => {
  if (EMBEDDED) {
    Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
      DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Intake→triage journey requires PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);

  code = `IJT_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Journey BM' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  careActorId = (await handymanCareActorService.createCareActor({
    integrationId: integration.id, actorReference: 'intake-agent-w04', displayName: 'Care',
  })).id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;

  adminId = (await createAdminUser()).userId;
  clientA = (await clientService.createClient({ code: `JA_${suffix()}`, name: 'Journey client A' })).id;
  clientB = (await clientService.createClient({ code: `JB_${suffix()}`, name: 'Journey client B' })).id;
  propA = (await propertyService.createProperty({ clientId: clientA, code: `P_${suffix()}`, name: 'Property A' })).id;
  propB = (await propertyService.createProperty({ clientId: clientB, code: `P_${suffix()}`, name: 'Property B' })).id;
  buildingA = (await buildingService.createBuilding({ propertyId: propA, code: `B_${suffix()}`, name: 'Building A' })).id;
  buildingA2 = (await buildingService.createBuilding({ propertyId: propA, code: `B_${suffix()}`, name: 'Building A2' })).id;
  buildingB = (await buildingService.createBuilding({ propertyId: propB, code: `B_${suffix()}`, name: 'Building B' })).id;
  for (const b of [buildingA, buildingA2, buildingB]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId: b }, adminId);
  }
  await grantCareActorProperty({ careActorId, propertyId: propA, clientId: clientA }, adminId);
  await grantCareActorProperty({ careActorId, propertyId: propB, clientId: clientB }, adminId);

  const unit = async (buildingId: string) => {
    const floor = await floorService.createFloor({ buildingId, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
    const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
    const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
    return (await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Unit' })).id;
  };
  spaceA = await unit(buildingA);
  spaceA2 = await unit(buildingA2);
  spaceB = await unit(buildingB);

  serviceA = (await serviceCatalogService.createServiceCatalogEntry({
    clientId: clientA, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN',
  }, adminId)).id;
  serviceB = (await serviceCatalogService.createServiceCatalogEntry({
    clientId: clientB, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN',
  }, adminId)).id;

  tenantA = (await tenantCompanyRepository.create({ clientId: clientA, tenantCode: `T_${suffix()}`, tenantName: 'Tenant A', email: 'billing-a@example.com' })).id;
  tenantB = (await tenantCompanyRepository.create({ clientId: clientB, tenantCode: `T_${suffix()}`, tenantName: 'Tenant B', email: 'billing-b@example.com' })).id;
  const link = (tc: string, b: string, s: string) => Promise.all([
    tenantBuildingContextRepository.create({ tenantCompanyId: tc, buildingId: b, status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null }),
    tenantSpaceRepository.create({ tenantCompanyId: tc, buildingId: b, spaceId: s, status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null }),
  ]);
  await link(tenantA, buildingA, spaceA);
  await link(tenantA, buildingA2, spaceA2);
  await link(tenantB, buildingB, spaceB);

  queueA = await operator(OPS, [buildingA]);
  triageA = await operator(TRIAGE, [buildingA]);
  triageA2 = await operator(TRIAGE, [buildingA2]);
  opsOnlyA = await operator(OPS, [buildingA]);
  queueA2 = await operator(OPS, [buildingA2]);
  queueB = await operator(OPS, [buildingB]);
  noAssign = await operator(OPS, []);
  revocable = await operator([...TRIAGE, ...OPS], [buildingA]);

  careToken = (await admit()).workspaceToken;
});

beforeEach(() => {
  clearLoginRateLimits();
});

after(async () => {
  if (envKey) delete process.env[envKey];
  clearLoginRateLimits();
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});

describe('W02 PART 04 — Customer Care intake → Operations triage journey', () => {
  let requestId = '';
  let requestPicId: string | null = null;

  it('J1 Customer Care intake creates one INTAKE request with the reporter snapshot', async () => {
    const created = await intake('A', GOOD_REPORTER);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    requestId = created.id;
    assert.equal(created.body.data.status, 'INTAKE');
    assert.equal(created.body.data.tenantCompanyId, tenantA);
    assert.equal(created.body.data.buildingId, buildingA);
    assert.equal(created.body.data.spaceId, spaceA);
    assert.equal(created.body.data.originChannel, 'BM_SUPER_APP');
    requestPicId = created.body.data.tenantPicId;
    const snapshot = await pool.query('SELECT count(*)::int AS n FROM handyman_service_request_contacts WHERE handyman_request_id = $1', [requestId]);
    assert.equal(snapshot.rows[0].n, 1);
  });

  it('J2 Operations queue lists the request in INTAKE, and detail is consistent with the intake', async () => {
    const page = await list(queueA.token, { status: 'INTAKE' });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const row = page.body.data.items.find((i: { id: string }) => i.id === requestId);
    assert.ok(row, 'intake request appears in the Operations queue');
    assert.equal(row.status, 'INTAKE');
    assert.equal(row.tenant.id, tenantA);
    assert.equal(row.location.buildingId, buildingA);
    assert.equal(row.location.spaceId, spaceA);
    assert.equal(row.attribution.originChannel, 'BM_SUPER_APP');
    assert.equal(row.attribution.actorType, 'CUSTOMER_CARE');
    assert.equal(row.attribution.careActorId, careActorId);
    assert.deepEqual(row.contact.reporter, { name: 'Journey Reporter', phone: '+628111222333', email: 'journey@example.com' });
    assert.equal(row.tenant.picId, requestPicId, 'PIC id is the attribution value, not an operator choice');

    const single = await detail(queueA.token, requestId);
    assert.equal(single.status, 200);
    assert.deepEqual(single.body.data.location, row.location);
    assert.deepEqual(single.body.data.contact, row.contact);
  });

  it('J3 Operations triage moves INTAKE to INSPECTION_REQUIRED, with one decision record and one audit event', async () => {
    const response = await triage(triageA.token, requestId, decision);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.triageDisposition, 'INSPECTION_REQUIRED');
    assert.equal(response.body.data.buildingId, buildingA);
    assert.equal(response.body.data.actorUserId, triageA.userId, 'actor is the authenticated operator');

    const after = await state(requestId);
    assert.equal(after.status, 'INSPECTION_REQUIRED');
    assert.equal(after.triage, 1);
    assert.equal(await triageEvents(requestId), 1);

    const audit = await pool.query(
      `SELECT actor_user_id, building_id, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_TRIAGED'`,
      [requestId],
    );
    assert.equal(audit.rows[0].actor_user_id, triageA.userId);
    assert.equal(audit.rows[0].building_id, buildingA);
    assert.equal(audit.rows[0].metadata.triageDisposition, 'INSPECTION_REQUIRED');
    assert.ok(!JSON.stringify(audit.rows[0].metadata).includes('Site inspection needed'), 'audit carries no note text');
  });

  it('J4 after triage the queue shows the request under the correct status filter and detail reflects it', async () => {
    const intakeOnly = await list(queueA.token, { status: 'INTAKE' });
    assert.ok(!intakeOnly.body.data.items.some((i: { id: string }) => i.id === requestId), 'no longer in INTAKE');
    const triaged = await list(queueA.token, { status: 'INSPECTION_REQUIRED' });
    assert.equal(triaged.status, 200);
    const row = triaged.body.data.items.find((i: { id: string }) => i.id === requestId);
    assert.ok(row, 'still visible in the queue after triage');
    assert.equal(row.status, 'INSPECTION_REQUIRED');
    assert.equal(row.tenant.id, tenantA, 'tenant unchanged by triage');
    assert.equal(row.location.buildingId, buildingA, 'location unchanged by triage');
    assert.equal(row.contact.reporter.name, 'Journey Reporter', 'reporter snapshot unchanged by triage');
    const everything = await list(queueA.token);
    assert.ok(everything.body.data.items.some((i: { id: string }) => i.id === requestId), 'default list keeps the request');
    const single = await detail(queueA.token, requestId);
    assert.equal(single.body.data.status, 'INSPECTION_REQUIRED');
    // W02 PART 04A: triage read is admitted to the Operations queue operator with the same Building scope.
    assert.equal((await triageRead(queueA.token, requestId)).status, 200);
    // ...but an operator without Building assignment is still denied.
    assert.equal((await triageRead(noAssign.token, requestId)).status, 403);
    const read = await triageRead(triageA.token, requestId);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.triageDisposition, 'INSPECTION_REQUIRED');
  });

  it('N1 Operations-only operator (queue permission, no triage authority) cannot triage: 403, no change', async () => {
    const created = await intake('A', GOOD_REPORTER);
    const response = await triage(opsOnlyA.token, created.id, decision);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    const after = await state(created.id);
    assert.equal(after.status, 'INTAKE');
    assert.equal(after.triage, 0);
    assert.equal(await triageEvents(created.id), 0);
  });

  it('N2 cross-building: an operator assigned only to another Building cannot triage (403), and cannot see the request', async () => {
    const created = await intake('A', GOOD_REPORTER);
    const response = await triage(triageA2.token, created.id, decision);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal((await state(created.id)).status, 'INTAKE');
    assert.equal((await detail(queueA2.token, created.id)).status, 404, 'other Building queue detail is 404');
    assert.equal((await list(queueA2.token)).body.data.items.some((i: { id: string }) => i.id === created.id), false);
  });

  it('N3 cross-client: an operator of another Client sees nothing and cannot triage the request', async () => {
    const created = await intake('A', GOOD_REPORTER);
    assert.equal((await triage(queueB.token, created.id, decision)).status, 403);
    assert.equal((await detail(queueB.token, created.id)).status, 404);
    assert.equal((await state(created.id)).status, 'INTAKE');
  });

  it('N4 revoked assignment: triage and queue are denied on the next request, with no state change', async () => {
    const created = await intake('A', GOOD_REPORTER);
    await buildingAssignmentService.deactivateAssignment(revocable.userId, buildingA);
    assert.equal((await triage(revocable.token, created.id, decision)).status, 403);
    assert.equal((await list(revocable.token)).status, 403, 'no assignment left: explicit denial');
    assert.equal((await state(created.id)).status, 'INTAKE');
  });

  it('N5 unauthorized operator and no-assignment operator are denied at the queue and at triage', async () => {
    const created = await intake('A', GOOD_REPORTER);
    assert.equal((await list(noAssign.token)).status, 403);
    assert.equal((await triage(noAssign.token, created.id, decision)).status, 403);
    assert.equal((await triage('not-a-session', created.id, decision)).status, 401);
    assert.equal((await triage(queueA.token, created.id, decision)).status, 403, 'queue permission alone cannot triage');
    assert.equal((await state(created.id)).status, 'INTAKE');
  });

  it('N6 a Customer Care workspace token cannot act as an operator on triage or the queue', async () => {
    const created = await intake('A', GOOD_REPORTER);
    const session = (await admit()).workspaceToken;
    assert.equal((await triage(session, created.id, decision)).status, 401);
    assert.equal((await list(session)).status, 401);
    assert.equal((await state(created.id)).status, 'INTAKE');
  });

  it('N7 invalid disposition and invalid body are rejected; the request stays INTAKE with no decision', async () => {
    const created = await intake('A', GOOD_REPORTER);
    for (const payload of [
      { disposition: 'READY_FOR_NEXT_STEP', note: 'not a triage disposition' },
      { disposition: 'QUOTATION', note: 'not a triage disposition' },
      { disposition: 'DIAGNOSIS' },
      { disposition: 'DIAGNOSIS', note: 'x'.repeat(501) },
    ]) {
      const response = await triage(triageA.token, created.id, payload);
      assert.equal(response.status, 400, JSON.stringify({ payload, body: response.body }));
    }
    const after = await state(created.id);
    assert.equal(after.status, 'INTAKE');
    assert.equal(after.triage, 0);
  });

  it('N8 invalid status transition: a request already triaged cannot be triaged again, and the status does not move back', async () => {
    const created = await intake('A', GOOD_REPORTER);
    assert.equal((await triage(triageA.token, created.id, decision)).status, 201);
    const again = await triage(triageA.token, created.id, { disposition: 'DIAGNOSIS', note: 'Second attempt' });
    assert.equal(again.status, 400, JSON.stringify(again.body));
    assert.equal(again.body.error.code, 'HANDYMAN_SERVICE_REQUEST_NOT_INTAKE');
    const after = await state(created.id);
    assert.equal(after.status, 'INSPECTION_REQUIRED');
    assert.equal(after.triage, 1);
    assert.equal(await triageEvents(created.id), 1);
  });

  it('N9 a request outside the operator scope, unknown id, and body status are not authority', async () => {
    assert.equal((await triage(triageA.token, randomUUID(), decision)).status, 404);
    assert.equal((await triage(triageA.token, 'not-a-uuid', decision)).status, 400);
    assert.equal((await triage(triageA.token, randomUUID(), { ...decision, status: 'DIAGNOSIS' })).status, 404, 'body status is not an authority');
  });

  it('R1 replay: sequential replay of the same triage creates no duplicate decision and no duplicate event', async () => {
    const created = await intake('A', GOOD_REPORTER);
    const first = await triage(triageA.token, created.id, decision);
    assert.equal(first.status, 201);
    for (let i = 0; i < 3; i++) {
      const replay = await triage(triageA.token, created.id, decision);
      assert.equal(replay.status, 400);
    }
    const after = await state(created.id);
    assert.equal(after.triage, 1);
    assert.equal(await triageEvents(created.id), 1);
  });

  it('R2 concurrent triage of one request: exactly one succeeds, one decision, one event', async () => {
    const created = await intake('A', GOOD_REPORTER);
    const results = await Promise.all([
      triage(triageA.token, created.id, { disposition: 'DIAGNOSIS', note: 'Parallel one' }),
      triage(triageA.token, created.id, { disposition: 'INSPECTION_REQUIRED', note: 'Parallel two' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
    const winner = results.find((r) => r.status === 201)!;
    const after = await state(created.id);
    assert.equal(after.triage, 1);
    assert.equal(after.status, winner.body.data.triageDisposition);
    assert.equal(await triageEvents(created.id), 1);
  });

  it('R3 intake replay: the same care exchange cannot create a second request, reporter snapshot or triage target', async () => {
    const issued = await api().post(`${CARE}/${propA}/create-exchanges`)
      .set('Authorization', `Bearer ${careToken}`)
      .send({ tenantCompanyId: tenantA, buildingId: buildingA, spaceId: spaceA });
    assert.equal(issued.status, 201);
    const exchange = issued.body.data.exchangeToken as string;
    const first = await api().post(CREATE).send({ exchangeToken: exchange, serviceCatalogId: serviceA, ...GOOD_REPORTER });
    assert.equal(first.status, 201);
    const before = await pool.query('SELECT count(*)::int AS n FROM handyman_service_requests WHERE channel_attribution_id IN (SELECT channel_attribution_id FROM handyman_service_requests WHERE id = $1)', [first.body.data.id]);
    const replay = await api().post(CREATE).send({ exchangeToken: exchange, serviceCatalogId: serviceA, reporter: { name: 'Replay' } });
    assert.equal(replay.status, 401);
    const after = await pool.query('SELECT count(*)::int AS n FROM handyman_service_requests WHERE channel_attribution_id IN (SELECT channel_attribution_id FROM handyman_service_requests WHERE id = $1)', [first.body.data.id]);
    assert.equal(after.rows[0].n, before.rows[0].n);
    const contacts = await pool.query('SELECT count(*)::int AS n FROM handyman_service_request_contacts WHERE handyman_request_id = $1', [first.body.data.id]);
    assert.equal(contacts.rows[0].n, 1);
  });
});

describe('W02 PART 04A — Operations triage authority separation', () => {
  it('registry: the triage permission is registered once, ACTIVE, and unassigned by default (no auto-grant)', async () => {
    const rows = await pool.query<{ n: number; status: string }>(
      `SELECT count(*)::int AS n, min(status) AS status FROM permissions WHERE code = 'handyman.operations.request.triage'`,
    );
    assert.equal(rows.rows[0].n, 1);
    assert.equal(rows.rows[0].status, 'ACTIVE');
    const grants = await pool.query<{ n: number }>(
      // Roles created by the test helper are SCOPED_* fixtures; no other role (seeded or
      // migrated) may hold the triage permission. Default grants are also excluded by
      // UNASSIGNED_BY_DEFAULT_PERMISSION_CODES below.
      `SELECT count(*)::int AS n FROM role_permission_assignments r
         JOIN permissions p ON p.id = r.permission_id
         JOIN roles ro ON ro.id = r.role_id
        WHERE p.code = 'handyman.operations.request.triage'
          AND ro.code NOT LIKE 'SCOPED\_%'`,
    );
    assert.equal(grants.rows[0].n, 0, 'migration 0436 must not grant the permission to any non-fixture role');
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.operations.request.triage'));
  });

  it('POST triage: the read-only Operations queue operator is denied (403) and nothing changes', async () => {
    const f = await intake('A');
    const res = await triage(queueA.token, f.id, decision);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal((await state(f.id)).status, 'INTAKE');
  });

  it('POST triage: triage permission + Building assignment is accepted without tenant_company.read', async () => {
    const pure = await operator(TRIAGE_ONLY, [buildingA]);
    const f = await intake('A');
    const res = await triage(pure.token, f.id, decision);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.actorUserId, pure.userId);
    assert.equal((await state(f.id)).status, 'INSPECTION_REQUIRED');
  });

  it('POST triage: a tenant_company.manage holder is no longer an Operations triage authority (breaking change, explicit)', async () => {
    const manager = await operator(MANAGE_ONLY, [buildingA]);
    const f = await intake('A');
    const res = await triage(manager.token, f.id, decision);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal((await state(f.id)).status, 'INTAKE');
  });

  it('POST triage: triage permission without Building assignment is denied; no change', async () => {
    const unassigned = await operator(TRIAGE_ONLY, []);
    const f = await intake('A');
    const res = await triage(unassigned.token, f.id, decision);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal((await state(f.id)).status, 'INTAKE');
  });

  it('POST triage: cross-building and cross-client operators with triage permission are denied', async () => {
    const f = await intake('A');
    const otherBuilding = await operator(TRIAGE_ONLY, [buildingA2]);
    const otherClient = await operator(TRIAGE_ONLY, [buildingB]);
    assert.equal((await triage(otherBuilding.token, f.id, decision)).status, 403);
    assert.equal((await triage(otherClient.token, f.id, decision)).status, 403);
    assert.equal((await state(f.id)).status, 'INTAKE');
  });

  it('POST triage: a revoked triage role is denied on the next request, with no state change', async () => {
    const revoke = await operator(TRIAGE_ONLY, [buildingA]);
    const f = await intake('A');
    await pool.query(`UPDATE user_role_assignments SET status = 'REVOKED' WHERE user_id = $1`, [revoke.userId]);
    const res = await triage(revoke.token, f.id, decision);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal((await state(f.id)).status, 'INTAKE');
  });

  it('POST triage: an inactive user is denied at authentication (401), with no change', async () => {
    const inactive = await operator(TRIAGE_ONLY, [buildingA]);
    const f = await intake('A');
    await pool.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [inactive.userId]);
    const res = await triage(inactive.token, f.id, decision);
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal((await state(f.id)).status, 'INTAKE');
  });

  it('GET triage: queue read permission + same Building scope is admitted; other Building and no assignment are denied', async () => {
    const f = await intake('A');
    assert.equal((await triage(triageA.token, f.id, decision)).status, 201);
    assert.equal((await triageRead(queueA.token, f.id)).status, 200);
    assert.equal((await triageRead(queueA2.token, f.id)).status, 403);
    assert.equal((await triageRead(noAssign.token, f.id)).status, 403);
  });

  it('GET triage: a caller with neither read authority is denied', async () => {
    const f = await intake('A');
    const plain = await operator(TRIAGE_ONLY, [buildingA]);
    const res = await triageRead(plain.token, f.id);
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('generic C6 unchanged: the triage permission and the queue read permission do not open the generic request surface', async () => {
    const f = await intake('A');
    const generic = `/api/v1/handyman/requests/${f.id}`;
    const triageOnly = await operator(TRIAGE_ONLY, [buildingA]);
    assert.equal((await api().get(generic).set('Authorization', `Bearer ${triageOnly.token}`)).status, 403);
    assert.equal((await api().get(generic).set('Authorization', `Bearer ${queueA.token}`)).status, 403);
  });
});

