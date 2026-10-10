import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { sessionService } from '../src/modules/auth/session.service';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { areaService } from '../src/modules/areas';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextRepository } from '../src/modules/tenant-building-contexts';
import { tenantCompanyRepository } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceRepository } from '../src/modules/tenant-spaces';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * W02 PART 02 — Operations queue & intake handoff (focused runtime tests).
 *
 * Covers `GET /api/v1/handyman/operations/requests[/:id]`:
 *   - Building-scoped authority (explicit ACTIVE assignment), RBAC
 *     `tenant_company.read`, fail-closed for tenant PIC identities.
 *   - Cross-building, cross-property, and cross-client isolation.
 *   - Requests created through `POST /handyman/requests/care` appear in the queue.
 *   - Pagination, filters, and cursor tampering stay inside scope.
 *   - Revoked permission, revoked session, and deactivated assignment are denied.
 *   - The generic Customer Care read `GET /handyman/requests` stays on C6.
 *
 * Fixtures are created through the real Customer Care path (workspace admission,
 * create-exchange, care POST), so the queue is exercised with production rows.
 */

const QUEUE = '/api/v1/handyman/operations/requests';
const GENERIC = '/api/v1/handyman/requests';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55545;
const DIR = '/tmp/handyman-operations-queue-pg';
const SECRET = 'operations-queue-test-integration-secret';

let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string;
let envKey: string;
let careToken = '';
let adminId: string;
let clientA: string;
let clientB: string;
let props: string[] = [];
let buildings: string[] = []; // B1, B2 (P1), B3 (P2), B4 (client B)
let spaces: Record<string, string> = {}; // building -> space id
let tenants: Record<string, string> = {}; // T1, T2, T3, T4
let serviceId: string;
let serviceIdB: string;
let requests: Record<string, { id: string; createdAt?: string }> = {};
let opsA: { token: string; userId: string };
let picUser: { token: string; userId: string };
let picNoOps: { token: string; userId: string };
let tenantReadOnly: { token: string; userId: string };
let noAssign: { token: string; userId: string };
let noPerm: { token: string; userId: string };
let opsB: { token: string; userId: string };
let opsC: { token: string; userId: string };
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function assertion(overrides: Partial<CareWorkspaceAssertion> = {}): CareWorkspaceAssertion {
  return {
    purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'ops-queue-care' }, ...overrides,
  };
}
async function admit(a = assertion()) {
  return admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET));
}

/** Creates a local user with the given permissions and optional Building assignments. */
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

/** W02 PART 02A — the Operations queue authority (not tenant_company.read). */
const OPS = [{ code: 'handyman.operations.request.read', name: 'Read Handyman Operations Request Queue' }];
const READ = [{ code: 'tenant_company.read', name: 'Read Tenant Companies' }];

/** Create one request through the real Customer Care path. */
async function intake(name: string, tenantId: string, buildingId: string, spaceId?: string) {
  // Service catalog is Client-scoped: client B buildings need client B's catalog.
  const catalogue = buildingId === buildings[3] ? serviceIdB : serviceId;
  const issued = await api().post(`/api/v1/handyman/care/properties/${propertyOf(buildingId)}/create-exchanges`)
    .set('Authorization', `Bearer ${careToken}`)
    .send({ tenantCompanyId: tenantId, buildingId, ...(spaceId ? { spaceId } : {}) });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const created = await api().post('/api/v1/handyman/requests/care')
    .send({ exchangeToken: issued.body.data.exchangeToken, serviceCatalogId: catalogue, description: `Queue ${name}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  requests[name] = { id: created.body.data.id };
  return created.body.data.id as string;
}
const propertyOf = (buildingId: string) => props[buildings.indexOf(buildingId) < 2 ? 0 : buildings.indexOf(buildingId) === 2 ? 1 : 2];

const list = (credential: string, query: Record<string, unknown> = {}) =>
  api().get(QUEUE).set('Authorization', `Bearer ${credential}`).query(query as any);
const detail = (credential: string, id: string) =>
  api().get(`${QUEUE}/${id}`).set('Authorization', `Bearer ${credential}`);
const generic = (credential: string, query: Record<string, unknown> = {}) =>
  api().get(GENERIC).set('Authorization', `Bearer ${credential}`).query(query as any);

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
  assert.ok(config, 'Operations queue tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);

  code = `OPQ_${randomUUID().slice(0, 8).toUpperCase()}`;
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Ops queue BM' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  const careActor = await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'ops-queue-care', displayName: 'Care' });
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;

  const adminUser = await createAdminUser();
  adminId = adminUser.userId;
  clientA = (await clientService.createClient({ code: `CA_${suffix()}`, name: 'Ops client A' })).id;
  clientB = (await clientService.createClient({ code: `CB_${suffix()}`, name: 'Ops client B' })).id;

  // P1 (client A): B1, B2. P2 (client A): B3. P3 (client B): B4.
  const layout: [string, number][] = [[clientA, 2], [clientA, 1], [clientB, 1]];
  for (const [cid, count] of layout) {
    const p = await propertyService.createProperty({ clientId: cid, code: `P_${suffix()}`, name: 'Ops property' });
    props.push(p.id);
    for (let i = 0; i < count; i++) {
      const building = await buildingService.createBuilding({ propertyId: p.id, code: `B_${suffix()}`, name: 'Ops building' });
      buildings.push(building.id);
      // Admin grants require explicit Building access (same as W02 PART 01 fixture).
      await buildingAssignmentService.createAssignment(adminId, { buildingId: building.id });
    }
    await grantCareActorProperty({ careActorId: careActor.id, propertyId: p.id, clientId: cid }, adminId);
  }
  const [b1, b2, b3, b4] = buildings;

  serviceId = (await serviceCatalogService.createServiceCatalogEntry({
    clientId: clientA, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN',
  }, adminId)).id;

  serviceIdB = (await serviceCatalogService.createServiceCatalogEntry({
    clientId: clientB, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN',
  }, adminId)).id;

  for (const buildingId of buildings) {
    const floor = await floorService.createFloor({ buildingId, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
    const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
    const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
    spaces[buildingId] = (await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Unit Alpha' })).id;
  }

  const tenant = async (name: string, client: string) =>
    (await tenantCompanyRepository.create({ clientId: client, tenantCode: `T_${suffix()}`, tenantName: name, email: 'billing@example.com' })).id;
  tenants.T1 = await tenant('Tenant One', clientA);
  tenants.T2 = await tenant('Tenant Two', clientA);
  tenants.T3 = await tenant('Tenant Three', clientA);
  tenants.T4 = await tenant('Tenant Four', clientB);
  const context = (tenantCompanyId: string, buildingId: string) => tenantBuildingContextRepository.create({
    tenantCompanyId, buildingId, status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null });
  await context(tenants.T1, b1);
  await context(tenants.T1, b2);
  await context(tenants.T2, b1);
  await context(tenants.T3, b3);
  await context(tenants.T4, b4);
  for (const [tc, b] of [[tenants.T1, b1], [tenants.T3, b3], [tenants.T4, b4]] as const) {
    await tenantSpaceRepository.create({ tenantCompanyId: tc, buildingId: b, spaceId: spaces[b],
      status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null });
  }

  // Operators. Explicit assignments only; no PIC shortcut.
  opsA = await operator(OPS, [b1]);
  opsB = await operator(OPS, [b3]);
  opsC = await operator(OPS, [b4]);
  noAssign = await operator(OPS, []);
  noPerm = await operator([{ code: 'checklist.read', name: 'Read Checklists' }], [b1]);
  tenantReadOnly = await operator(READ, [b1]);
  // Dual-role: tenant PIC link + Operations permission + explicit assignment.
  picUser = await operator(OPS, [b1]);
  // Tenant PIC without the Operations permission (assignment present).
  picNoOps = await operator(READ, [b1]);
  for (const pic of [picUser, picNoOps]) {
    await tenantPicService.createTenantPic({
      tenantCompanyId: tenants.T1, picName: 'Tenant One PIC', email: `pic-${pic.userId.slice(0, 8)}@tenant-one.example.com`, userId: pic.userId,
    }, adminId);
  }

  careToken = (await admit()).workspaceToken;
  // Tenant-scoped requests, all created through the Customer Care path.
  await intake('R1', tenants.T1, b1, spaces[b1]);
  await intake('R2', tenants.T1, b2);
  await intake('R3', tenants.T3, b3, spaces[b3]);
  await intake('R4', tenants.T4, b4, spaces[b4]);
  await intake('R5', tenants.T2, b1);
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

describe('W02 PART 02 — Operations queue', () => {
  it('authorized operator reads its Building queue; other Buildings, Properties, and Clients never appear', async () => {
    const response = await list(opsA.token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const ids = response.body.data.items.map((item: any) => item.id);
    assert.ok(ids.includes(requests.R1.id), 'Building B1 request must be visible');
    assert.ok(ids.includes(requests.R5.id), 'same-Building request from another tenant is visible to the Building operator');
    for (const hidden of ['R2', 'R3', 'R4']) {
      assert.ok(!ids.includes(requests[hidden].id), `${hidden} is outside the operator scope`);
    }
    const item = response.body.data.items.find((r: any) => r.id === requests.R1.id);
    assert.equal(item.status, 'INTAKE');
    assert.equal(item.tenant.id, tenants.T1);
    assert.equal(item.tenant.name, 'Tenant One');
    assert.equal(item.location.buildingId, opsBuilding('b1'));
    assert.equal(item.location.spaceId, spaces[opsBuilding('b1')]);
    assert.equal(item.service.catalogName, 'Repair');
    assert.equal(typeof item.attribution.originChannel, 'string');
    assert.ok(item.attribution.originChannel.length > 0);
    assert.equal(item.attribution.actorType, 'CUSTOMER_CARE');
    assert.ok(item.createdAt && item.updatedAt);
  });

  it('cross-property and cross-client operators see only their own Building (no lateral reads)', async () => {
    const propertyOperator = await list(opsB.token, { limit: 100 });
    const propertyIds = propertyOperator.body.data.items.map((r: any) => r.id);
    assert.ok(propertyIds.includes(requests.R3.id), 'P2 operator sees its own Building');
    assert.ok(!propertyIds.includes(requests.R1.id) && !propertyIds.includes(requests.R5.id), 'P2 operator cannot see P1 rows');
    assert.equal((await detail(opsB.token, requests.R1.id)).status, 404);

    const clientOperator = await list(opsC.token, { limit: 100 });
    const clientIds = clientOperator.body.data.items.map((r: any) => r.id);
    assert.ok(clientIds.includes(requests.R4.id), 'client B operator sees its own Building');
    assert.ok(!clientIds.includes(requests.R1.id) && !clientIds.includes(requests.R3.id), 'client B operator cannot see client A rows');
    assert.equal((await detail(opsC.token, requests.R3.id)).status, 404);
  });

  it('projection excludes assertion, token, actor subject, and creator identifiers', async () => {
    const response = await list(opsA.token);
    const raw = JSON.stringify(response.body);
    for (const forbidden of ['actorReference', 'createdByUserId', 'exchangeToken', 'tokenHash', 'hcw_', 'assertion', 'ops-queue-care', 'billing@example.com']) {
      assert.ok(!raw.includes(forbidden), `response must not contain ${forbidden}`);
    }
  });

  it('a request created through POST /handyman/requests/care appears in the queue on the next read', async () => {
    const id = await intake('R6', tenants.T2, opsBuilding('b1'));
    const response = await list(opsA.token, { status: 'INTAKE' });
    assert.equal(response.status, 200);
    assert.ok(response.body.data.items.some((r: any) => r.id === id));
  });

  it('pagination walks the queue FIFO with no duplicates and no out-of-scope rows', async () => {
    const full = await list(opsA.token, { limit: 100 });
    const expected = full.body.data.items.map((r: any) => r.id);
    assert.ok(expected.length >= 3);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const response = await list(opsA.token, { limit: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.items.length <= 1, true);
      seen.push(...response.body.data.items.map((r: any) => r.id));
      cursor = response.body.data.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, expected, 'paged order must equal the unpaged FIFO order');
    assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
    assert.ok(!seen.includes(requests.R2.id) && !seen.includes(requests.R4.id));
  });

  it('filters by status and buildingId without widening scope', async () => {
    const triage = await list(opsA.token, { status: 'TRIAGE' });
    assert.equal(triage.status, 200);
    assert.deepEqual(triage.body.data.items, []);

    const byBuilding = await list(opsA.token, { buildingId: opsBuilding('b1'), limit: 100 });
    assert.ok(byBuilding.body.data.items.every((r: any) => r.location.buildingId === opsBuilding('b1')));
    assert.ok(byBuilding.body.data.items.some((r: any) => r.id === requests.R1.id));

    const foreign = await list(opsA.token, { buildingId: opsBuilding('b2') });
    assert.equal(foreign.status, 200);
    assert.deepEqual(foreign.body.data.items, [], 'a foreign Building yields an empty page, not an error');

    const otherProperty = await list(opsA.token, { buildingId: opsBuilding('b3') });
    assert.deepEqual(otherProperty.body.data.items, []);
  });

  it('rejects invalid queries and cannot escape scope with a crafted cursor', async () => {
    const tenantSelector = await list(opsA.token, { clientId: clientB });
    assert.equal(tenantSelector.status, 400, 'client/tenant selectors are not accepted');
    assert.equal((await list(opsA.token, { tenantCompanyId: tenants.T1 })).status, 400);
    assert.equal((await list(opsA.token, { status: 'NOPE' })).status, 400);
    assert.equal((await list(opsA.token, { limit: 0 })).status, 400);
    assert.equal((await list(opsA.token, { limit: 101 })).status, 400);
    assert.equal((await list(opsA.token, { cursor: 'not-a-cursor' })).status, 400);

    // A cursor that points at an out-of-scope row must not reveal it.
    const crafted = Buffer.from(JSON.stringify({ c: '2000-01-01T00:00:00.000000Z', i: requests.R4.id })).toString('base64url');
    const response = await list(opsA.token, { cursor: crafted, limit: 100 });
    assert.equal(response.status, 200);
    assert.ok(!response.body.data.items.some((r: any) => r.id === requests.R4.id));
  });

  it('detail returns an in-scope request, and out-of-scope and unknown IDs get the same 404', async () => {
    const ok = await detail(opsA.token, requests.R1.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.id, requests.R1.id);

    const otherBuilding = await detail(opsA.token, requests.R2.id);
    const otherClient = await detail(opsA.token, requests.R4.id);
    const unknown = await detail(opsA.token, randomUUID());
    for (const response of [otherBuilding, otherClient, unknown]) {
      assert.equal(response.status, 404, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'HANDYMAN_SERVICE_REQUEST_NOT_FOUND');
    }
    // requestId differs per response by design; compare the existence-relevant fields only.
    const shape = (r: any) => ({ code: r.body.error.code, category: r.body.error.category, message: r.body.error.message });
    assert.deepEqual(shape(otherBuilding), shape(unknown), 'no existence oracle (other Building)');
    assert.deepEqual(shape(otherClient), shape(unknown), 'no existence oracle (other Client)');
  });

  it('a User with the permission but without an ACTIVE Building assignment is denied (403) on list and detail', async () => {
    const response = await list(noAssign.token);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    const one = await detail(noAssign.token, requests.R1.id);
    assert.equal(one.status, 403, JSON.stringify(one.body));
  });

  it('tenant_company.read alone is no longer the Operations queue authority (403)', async () => {
    assert.equal((await list(tenantReadOnly.token)).status, 403);
    assert.equal((await detail(tenantReadOnly.token, requests.R1.id)).status, 403);
  });

  it('a User with a Building assignment but without tenant_company.read is denied (403)', async () => {
    const response = await list(noPerm.token);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal((await detail(noPerm.token, requests.R1.id)).status, 403);
  });

  it('a tenant PIC without the Operations permission is denied (403), even with a Building assignment', async () => {
    const queue = await list(picNoOps.token);
    assert.equal(queue.status, 403, JSON.stringify(queue.body));
    assert.equal((await detail(picNoOps.token, requests.R1.id)).status, 403);
  });

  it('dual-role user (tenant PIC + Operations permission + assignment) is admitted by the authority, not by role', async () => {
    const queue = await list(picUser.token, { limit: 100 });
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const ids = queue.body.data.items.map((r: any) => r.id);
    assert.ok(ids.includes(requests.R1.id) && ids.includes(requests.R5.id), 'Building-scoped authority applies');
    assert.ok(!ids.includes(requests.R2.id) && !ids.includes(requests.R3.id), 'still fail-closed outside the Building');
    assert.equal((await detail(picUser.token, requests.R1.id)).status, 200);
  });

  it('the generic Customer Care read GET /handyman/requests stays on the C6 wall', async () => {
    // Operator without PIC link: the C6 wall returns no rows.
    // Generic read needs tenant_company.read (C6 unchanged). tenantReadOnly has no PIC link.
    const operatorView = await generic(tenantReadOnly.token, { clientId: clientA });
    assert.equal(operatorView.status, 200);
    const operatorIds = operatorView.body.data.map((r: any) => r.id);
    assert.ok(!operatorIds.includes(requests.R1.id), 'C6 wall unchanged for non-PIC operators');
    // Operations permission alone does not open the generic C6 read either.
    assert.equal((await generic(opsA.token, { clientId: clientA })).status, 403);

    // Represented PIC: the C6 wall still shows its own tenant's occupied request.
    const picView = await generic(picNoOps.token, { clientId: clientA, tenantCompanyId: tenants.T1 });
    assert.equal(picView.status, 200, JSON.stringify(picView.body));
    const picIds = picView.body.data.map((r: any) => r.id);
    assert.ok(picIds.includes(requests.R1.id), 'C6 PIC read unchanged');
    assert.ok(!picIds.includes(requests.R3.id), 'C6 PIC read stays tenant-scoped');
  });

  it('a revoked permission is denied on the next request', async () => {
    const revoke = await operator(OPS, [opsBuilding('b1')]);
    assert.equal((await list(revoke.token)).status, 200);
    await pool.query(`UPDATE user_role_assignments SET status = 'REVOKED' WHERE user_id = $1`, [revoke.userId]);
    const response = await list(revoke.token);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal((await detail(revoke.token, requests.R1.id)).status, 403);
  });

  it('a revoked session is rejected with 401', async () => {
    const session = await operator(OPS, [opsBuilding('b1')]);
    assert.equal((await list(session.token)).status, 200);
    await sessionService.revokeActiveSessionsForUser(session.userId);
    const response = await list(session.token);
    assert.equal(response.status, 401, JSON.stringify(response.body));
  });

  it('deactivated Building assignments remove requests; the last assignment removed is a 403', async () => {
    const assigned = await operator(OPS, [opsBuilding('b1'), opsBuilding('b2')]);
    const both = await list(assigned.token, { limit: 100 });
    assert.ok(both.body.data.items.some((r: any) => r.id === requests.R1.id));
    await buildingAssignmentService.deactivateAssignment(assigned.userId, opsBuilding('b1'));
    const partial = await list(assigned.token, { limit: 100 });
    assert.equal(partial.status, 200);
    assert.ok(!partial.body.data.items.some((r: any) => r.id === requests.R1.id), 'B1 removed');
    assert.equal((await detail(assigned.token, requests.R1.id)).status, 404);
    await buildingAssignmentService.deactivateAssignment(assigned.userId, opsBuilding('b2'));
    assert.equal((await list(assigned.token)).status, 403, 'no assignment left: explicit denial');
    assert.equal((await detail(assigned.token, requests.R2.id)).status, 403);
  });

  it('inactive user is denied at authentication (401), with no queue data', async () => {
    const inactive = await operator(OPS, [opsBuilding('b1')]);
    assert.equal((await list(inactive.token)).status, 200);
    await pool.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [inactive.userId]);
    const response = await list(inactive.token);
    assert.equal(response.status, 401, JSON.stringify(response.body));
    assert.equal((await detail(inactive.token, requests.R1.id)).status, 401);
  });

  it('queue list and detail are parity-identical for every visible request', async () => {
    const queue = await list(opsA.token, { limit: 100 });
    assert.equal(queue.status, 200);
    assert.ok(queue.body.data.items.length >= 3);
    for (const item of queue.body.data.items) {
      const one = await detail(opsA.token, item.id);
      assert.equal(one.status, 200, JSON.stringify(one.body));
      assert.deepEqual(one.body.data, item, `detail parity for ${item.id}`);
    }
  });
});

/** Building ids by fixture role: b1 = P1/B1, b2 = P1/B2, b3 = P2/B3, b4 = client B. */
function opsBuilding(role: 'b1' | 'b2' | 'b3' | 'b4'): string {
  const index = { b1: 0, b2: 1, b3: 2, b4: 3 }[role];
  return buildings[index];
}
