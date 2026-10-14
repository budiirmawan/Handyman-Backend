import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import {
  addHandymanQuotationLine,
  createHandymanQuotationRevision,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { parseHandymanOperationsQueueQuery } from '../src/modules/handyman-operations-queue';
import { locationChain, realmFixture, scopeFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const QUEUE_PATH = '/api/v1/handyman/operations/queue';
const DB_PORT = 55473;
const DATA_DIR = '/tmp/handyman-ops-queue-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let admin: { token: string; userId: string } | null = null;
let operationsOnly: { token: string; userId: string } | null = null;
let noPermissionToken = '';
let unassignedToken = '';
let fixture: {
  clientId: string;
  buildingId: string;
  siblingBuildingId: string;
  foreignClientId: string;
  scopeIds: string[];
  inBuildingRequestIds: string[];
  siblingRequestIds: string[];
  foreignRequestIds: string[];
  latestScopeId: string;
} | null = null;
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('test database is not initialized');
  return pool.query(text, params);
};

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const adminClient = pg.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users CASCADE');

  admin = await createAdminUser();
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  const actorId = admin.userId;
  const query = async (text: string, params: unknown[] = []) => {
    if (!pool) throw new Error('test database is not initialized');
    return pool.query(text, params);
  };
  initHandymanFixtures({
    adminUserId: actorId,
    disciplineId: discipline.id,
    query,
  });

  const realm = await realmFixture('Operations queue');
  const chain = await locationChain(realm);
  const scopeA1 = await scopeFixture(realm, chain);
  const secondChain = await locationChain(realm);
  const scopeA2 = await scopeFixture(realm, secondChain);

  const sibling = await buildingService.createBuilding({
    propertyId: realm.property.id,
    code: `B_${suffix()}`,
    name: 'Unassigned sibling Building',
  });
  const siblingRealm = { ...realm, building: sibling };
  const siblingChain = await locationChain(siblingRealm);
  const foreignAdmin = await createAdminUser();
  await buildingAssignmentService.createAssignment(foreignAdmin.userId, {
    buildingId: sibling.id,
  });
  initHandymanFixtures({
    adminUserId: foreignAdmin.userId,
    disciplineId: discipline.id,
    query,
  });
  const foreignScope = await scopeFixture(siblingRealm, siblingChain);

  // A genuinely foreign Client (own property/building chain) reachable only
  // through its own assigned actor — never through the queue actors below.
  initHandymanFixtures({ adminUserId: foreignAdmin.userId, disciplineId: discipline.id, query });
  const otherRealm = await realmFixture('Foreign client');
  const otherChain = await locationChain(otherRealm);
  const otherScope = await scopeFixture(otherRealm, otherChain);

  // CR-HM-OPS-INBOX-BE-01 P0-A — a genuine Operations actor: exactly the
  // route's tenant_company.read permission and an ACTIVE Building assignment.
  // Deliberately NOT a Tenant PIC, NOT a PLATFORM_ADMIN, and holding no other
  // permission.
  operationsOnly = {
    token: await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]),
    userId: randomUUID(),
  };
  // Resolve the created user id from its session-independent identity: the
  // helper returns only a token, so re-derive the user by unique email prefix
  // is unnecessary — instead assign via a fresh scoped session user lookup.
  const opsUserId = await q(
    `SELECT id FROM users ORDER BY created_at DESC LIMIT 1`,
  );
  operationsOnly.userId = opsUserId.rows[0].id as string;
  await buildingAssignmentService.createAssignment(operationsOnly.userId, {
    buildingId: realm.building.id,
  });

  // Same Building assignment but WITHOUT the route permission → 403 RBAC.
  noPermissionToken = await createSessionWithPermissions([]);
  const noPermissionUserId = await q(
    `SELECT id FROM users ORDER BY created_at DESC LIMIT 1`,
  );
  await buildingAssignmentService.createAssignment(
    noPermissionUserId.rows[0].id as string,
    { buildingId: realm.building.id },
  );

  // Permission but NO Building assignment anywhere → unreachable Client.
  unassignedToken = await createSessionWithPermissions([
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);

  fixture = {
    clientId: realm.client.id,
    buildingId: realm.building.id,
    siblingBuildingId: sibling.id,
    foreignClientId: otherRealm.client.id,
    scopeIds: [scopeA1.scope.id, scopeA2.scope.id],
    inBuildingRequestIds: await inBuildingRequestIds(realm.building.id),
    siblingRequestIds: await inBuildingRequestIds(sibling.id),
    foreignRequestIds: await inBuildingRequestIds(otherRealm.building.id),
    latestScopeId: scopeA1.scope.id,
  };

  async function inBuildingRequestIds(buildingId: string): Promise<string[]> {
    const res = await q(
      `SELECT id FROM handyman_service_requests WHERE building_id = $1
        ORDER BY created_at ASC, id ASC`,
      [buildingId],
    );
    return res.rows.map((row) => row.id as string);
  }
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool || !admin || !operationsOnly || !fixture) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Handyman Production Operations read-only queue', () => {
  it('parses bounded pagination while keeping existing Client/lifecycle filters', () => {
    const clientId = randomUUID();
    assert.deepEqual(
      parseHandymanOperationsQueueQuery({ clientId }).limit,
      20,
    );
    const parsed = parseHandymanOperationsQueueQuery({
      clientId,
      buildingId: randomUUID(),
      status: 'READY_FOR_NEXT_STEP',
      limit: '7',
      offset: '14',
    });
    assert.equal(parsed.limit, 7);
    assert.equal(parsed.offset, 14);
    assert.equal(parsed.filters.status, 'READY_FOR_NEXT_STEP');
    assert.throws(
      () => parseHandymanOperationsQueueQuery({ clientId, limit: '51' }),
      { statusCode: 400 },
    );
  });

  it('CR-HM-OPS-INBOX-BE-01 P0-A: discovers rows for an Operations actor without Tenant PIC membership', async (t) => {
    if (!requireDatabase(t)) return;
    const all = await api()
      .get(QUEUE_PATH)
      .set(auth(operationsOnly!.token))
      .query({ clientId: fixture!.clientId, limit: 50 });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const ids = all.body.data.items.map(
      (item: { handymanRequestId: string }) => item.handymanRequestId,
    );
    assert.deepEqual(
      [...ids].sort(),
      [...fixture!.inBuildingRequestIds].sort(),
      'every request in the assigned Building is discoverable without PIC membership',
    );
    assert.ok(
      all.body.data.items.every(
        (item: { buildingId: string }) => item.buildingId === fixture!.buildingId,
      ),
    );
    // Cross-Building and cross-Client requests never leak.
    for (const siblingRequestId of fixture!.siblingRequestIds) {
      assert.ok(
        !ids.includes(siblingRequestId),
        'sibling-Building request must not leak into the assigned-Building queue',
      );
    }
    for (const foreignRequestId of fixture!.foreignRequestIds) {
      assert.ok(!ids.includes(foreignRequestId));
    }
  });

  it('pages only assigned-Building rows and maps lifecycle, scope, readiness, assignment, and SLA facts', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await api()
      .get(QUEUE_PATH)
      .set(auth(admin!.token))
      .query({ clientId: fixture!.clientId, limit: 1, offset: 0 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.items.length, 1);
    assert.equal(first.body.data.pagination.nextOffset, 1);

    const second = await api()
      .get(QUEUE_PATH)
      .set(auth(admin!.token))
      .query({ clientId: fixture!.clientId, limit: 1, offset: 1 });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.items.length, 1);
    assert.notEqual(
      first.body.data.items[0].handymanRequestId,
      second.body.data.items[0].handymanRequestId,
    );

    const all = await api()
      .get(QUEUE_PATH)
      .set(auth(admin!.token))
      .query({ clientId: fixture!.clientId, limit: 50 });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.data.items.length, fixture!.inBuildingRequestIds.length);
    assert.ok(all.body.data.items.every(
      (item: { buildingId: string }) => item.buildingId === fixture!.buildingId,
    ));

    const mapped = all.body.data.items.find(
      (item: { executionScopeId: string }) => item.executionScopeId === fixture!.scopeIds[0],
    );
    assert.ok(mapped, 'approved Handyman scope should map back to its request');
    const authoritative = await q(
      `SELECT s.handyman_request_id AS "handymanRequestId",
              s.client_id AS "clientId", s.building_id AS "buildingId",
              s.tenant_company_id AS "tenantCompanyId"
         FROM handyman_execution_scopes s
        WHERE s.id = $1`,
      [fixture!.scopeIds[0]],
    );
    assert.equal(mapped.handymanRequestId, authoritative.rows[0].handymanRequestId);
    assert.equal(mapped.clientId, authoritative.rows[0].clientId);
    assert.equal(mapped.buildingId, authoritative.rows[0].buildingId);
    assert.equal(mapped.tenantCompanyId, authoritative.rows[0].tenantCompanyId);
    assert.equal(mapped.lifecycle.requestStatus, 'READY_FOR_NEXT_STEP');
    assert.equal(mapped.lifecycle.executionScopeStatus, 'AUTHORIZED');
    assert.equal(mapped.assignment.status, null);
    assert.equal(mapped.readiness.schedulingStatus, null);
    assert.equal(mapped.slaMilestones.length, 9);
    assert.equal(Object.hasOwn(mapped, 'workOrderId'), false);
  });

  it('P1: returns exactly one row per request even when a request owns several execution scopes', async (t) => {
    if (!requireDatabase(t)) return;
    // Create a second approved quotation revision for the first request → a
    // second execution scope on the SAME request. The legacy Customer Care
    // projection JOIN fanned this out into duplicated queue rows.
    const firstRequest = fixture!.inBuildingRequestIds[0];
    const scopeRow = await q(
      `SELECT s.quotation_id AS "quotationId", s.client_id AS "clientId"
         FROM handyman_execution_scopes s
        WHERE s.id = $1`,
      [fixture!.scopeIds[0]],
    );
    const quotationId = scopeRow.rows[0].quotationId as string;
    const uom = await q(
      `SELECT id FROM units_of_measure LIMIT 1`,
    );
    const revision = await createHandymanQuotationRevision(
      quotationId,
      admin!.userId,
    );
    await addHandymanQuotationLine(revision.id, {
      lineType: 'LABOR', description: 'Revision hours', quantity: 2, uomId: uom.rows[0].id as string,
      currency: 'IDR', finalQuotedUnitAmount: 150,
    }, admin!.userId);
    await issueHandymanQuotationVersion(revision.id, {
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }, admin!.userId);
    const decision = await decideHandymanQuotation(revision.id, {
      decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
    }, admin!.userId);
    const revisedScopeId = decision.executionScope?.id ?? null;
    assert.ok(revisedScopeId, 'approved revision must create its execution scope');
    assert.notEqual(revisedScopeId, fixture!.scopeIds[0]);

    fixture!.latestScopeId = revisedScopeId;

    const all = await api()
      .get(QUEUE_PATH)
      .set(auth(admin!.token))
      .query({ clientId: fixture!.clientId, limit: 50 });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const ids = all.body.data.items.map(
      (item: { handymanRequestId: string }) => item.handymanRequestId,
    );
    assert.equal(
      new Set(ids).size,
      ids.length,
      'no duplicated queue rows caused by the execution-scope one-to-many join',
    );
    assert.deepEqual(
      [...ids].sort(),
      [...fixture!.inBuildingRequestIds].sort(),
    );
    const fanouted = all.body.data.items.find(
      (item: { handymanRequestId: string }) => item.handymanRequestId === firstRequest,
    );
    assert.ok(fanouted);
    assert.equal(
      fanouted.executionScopeId,
      revisedScopeId,
      'the scope pointer matches the per-item status read (latest scope)',
    );
    // The Operations actor still sees both scopes' commercial facts through
    // the commercial inbox; the request-keyed queue stays one-row-per-request.
  });

  it('denies a same-Client sibling Building filter with 403 and no data', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(QUEUE_PATH)
      .set(auth(admin!.token))
      .query({
        clientId: fixture!.clientId,
        buildingId: fixture!.siblingBuildingId,
      });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(response.body.data, undefined);
  });

  it('denies a Client the actor cannot reach through any assignment with 403 and no data', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(QUEUE_PATH)
      .set(auth(operationsOnly!.token))
      .query({ clientId: fixture!.foreignClientId });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(response.body.data, undefined);
  });

  it('denies a Building-assigned actor without the tenant_company.read permission (403 PERMISSION_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(QUEUE_PATH)
      .set(auth(noPermissionToken))
      .query({ clientId: fixture!.clientId });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.equal(response.body.data, undefined);
  });

  it('denies a permissioned actor with no Building assignment anywhere (403, no data leak)', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(QUEUE_PATH)
      .set(auth(unassignedToken))
      .query({ clientId: fixture!.clientId });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(response.body.data, undefined);
  });
});
