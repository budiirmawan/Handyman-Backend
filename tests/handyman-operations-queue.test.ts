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
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { parseHandymanOperationsQueueQuery } from '../src/modules/handyman-operations-queue';
import { locationChain, realmFixture, scopeFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { createAdminUser } from './helpers/access';
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
let fixture: {
  clientId: string;
  buildingId: string;
  siblingBuildingId: string;
  scopeIds: string[];
  c6DeniedScopeId: string;
  foreignScopeId: string;
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

  // Make the queue actor an ACTIVE represented PIC for the two in-scope
  // requests, preserving the existing Customer Care read wall.
  initHandymanFixtures({ adminUserId: actorId, disciplineId: discipline.id, query });
  await q(
    `UPDATE tenant_pics pic
        SET user_id = $1
      WHERE pic.id IN (
        SELECT r.tenant_pic_id
          FROM handyman_service_requests r
         WHERE r.building_id = $2
      )`,
    [actorId, realm.building.id],
  );

  // Same Client + Building, but a different active PIC: the queue actor must
  // not receive this row through the existing C6 customer read wall.
  const deniedC6Chain = await locationChain(realm);
  const deniedC6Scope = await scopeFixture(realm, deniedC6Chain);

  fixture = {
    clientId: realm.client.id,
    buildingId: realm.building.id,
    siblingBuildingId: sibling.id,
    scopeIds: [scopeA1.scope.id, scopeA2.scope.id],
    c6DeniedScopeId: deniedC6Scope.scope.id,
    foreignScopeId: foreignScope.scope.id,
  };
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
  if (!database || !pool || !admin || !fixture) {
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

  it('pages only exact-building-authorized rows and maps lifecycle, scope, readiness, assignment, and SLA facts', async (t) => {
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
    assert.equal(second.body.data.pagination.nextOffset, null);
    assert.notEqual(
      first.body.data.items[0].handymanRequestId,
      second.body.data.items[0].handymanRequestId,
    );

    const all = await api()
      .get(QUEUE_PATH)
      .set(auth(admin!.token))
      .query({ clientId: fixture!.clientId, limit: 50 });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.data.items.length, 2);
    assert.ok(all.body.data.items.every(
      (item: { buildingId: string }) => item.buildingId === fixture!.buildingId,
    ));
    assert.ok(!all.body.data.items.some(
      (item: { executionScopeId: string }) => item.executionScopeId === fixture!.foreignScopeId,
    ));
    assert.ok(!all.body.data.items.some(
      (item: { executionScopeId: string }) => item.executionScopeId === fixture!.c6DeniedScopeId,
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

});
