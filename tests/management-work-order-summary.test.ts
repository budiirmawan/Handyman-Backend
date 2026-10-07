import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { parseManagementWorkOrderSummaryQuery } from '../src/modules/management-work-order-summary';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 02B focused tests — Work Order Summary only. */

const PATH = '/api/v1/management/work-order-summary';
const MANAGEMENT_PERMISSION = {
  code: 'management_read_model.read',
  name: 'Read Management and Owner Read Models',
} as const;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';
let plainToken = '';
let noAssignmentToken = '';
let fixture: Awaited<ReturnType<typeof seed>> | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles, permissions CASCADE');

  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  plainToken = await createPlainSession();
  noAssignmentToken = await createSessionWithPermissions([
    MANAGEMENT_PERMISSION,
  ]);
  fixture = await seed();
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
  if (!database || !pool || !fixture) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function seed() {
  const scopeA = await createBuildingScope('A');
  const scopeB = await createBuildingScope('B');
  const hidden = await createBuildingScope('HIDDEN');

  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: scopeA.building.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: scopeB.building.id,
  });

  const oldDate = new Date(Date.now() - 10 * 86400000)
    .toISOString()
    .slice(0, 10);
  const recentDate = new Date(Date.now() - 86400000)
    .toISOString()
    .slice(0, 10);
  const oldAt = `${oldDate}T12:00:00.000Z`;
  const recentAt = `${recentDate}T12:00:00.000Z`;

  await insertWorkOrder(scopeA, 'OPEN', 'LOW', oldAt);
  await insertWorkOrder(scopeA, 'IN_PROGRESS', 'HIGH', oldAt);
  await insertWorkOrder(scopeA, 'COMPLETED', 'HIGH', recentAt, true);
  await insertWorkOrder(scopeA, 'CLOSED', 'CRITICAL', recentAt, true);
  await insertWorkOrder(scopeA, 'ASSIGNED', 'MEDIUM', oldAt);
  await insertWorkOrder(scopeA, 'ON_HOLD', 'CRITICAL', oldAt);
  await insertWorkOrder(scopeA, 'CANCELLED', 'LOW', recentAt);

  await insertWorkOrder(scopeB, 'OPEN', 'MEDIUM', recentAt);
  await insertWorkOrder(scopeB, 'IN_PROGRESS', 'CRITICAL', oldAt);
  await insertWorkOrder(scopeB, 'COMPLETED', 'LOW', recentAt);
  await insertWorkOrder(scopeB, 'CLOSED', 'HIGH', recentAt, true);

  await insertWorkOrder(hidden, 'OPEN', 'CRITICAL', oldAt);

  return { scopeA, scopeB, hidden, recentDate };
}

async function createBuildingScope(label: string) {
  const client = await clientService.createClient({
    code: `WO_${label}_${suffix()}`,
    name: `Work Order Client ${label}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${label}_${suffix()}`,
    name: `Property ${label}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${label}_${suffix()}`,
    name: `Building ${label}`,
  });
  return { client, property, building };
}

async function insertWorkOrder(
  scope: Awaited<ReturnType<typeof createBuildingScope>>,
  status:
    | 'OPEN'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'ON_HOLD'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'CLOSED',
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  createdAt: string,
  approved = false,
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,priority,
        status,created_by_user_id,completed_at,closed_at,created_at)
     VALUES ($1,$2,$3,$4,$5,'GENERAL',$6,$7,$8,$9,$10,$11)`,
    [
      id,
      scope.client.id,
      scope.building.id,
      `WO_${suffix()}`,
      `${status} Work Order`,
      priority,
      status,
      managerUserId,
      status === 'COMPLETED' || status === 'CLOSED' ? createdAt : null,
      status === 'CLOSED' ? createdAt : null,
      createdAt,
    ],
  );
  if (approved) {
    await pool!.query(
      `INSERT INTO reviews
         (id,client_id,target_type,target_id,reviewer_user_id,decision,
          status,reviewed_at)
       VALUES ($1,$2,'WORK_ORDER',$3,$4,'APPROVED','COMPLETED',$5)`,
      [randomUUID(), scope.client.id, id, managerUserId, createdAt],
    );
  }
  return id;
}

describe('BE-24 PART 02B — Management Work Order Summary', () => {
  it('documents the endpoint and reuses PART 01 / BE-23 filter conventions', () => {
    const parsed = parseManagementWorkOrderSummaryQuery({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
      overdueAfterDays: '9',
    });
    assert.equal(parsed.scope.dateFrom, '2026-08-01');
    assert.equal(parsed.scope.dateTo, '2026-08-17');
    assert.equal(parsed.overdueAfterDays, 9);

    const defaults = parseManagementWorkOrderSummaryQuery({});
    assert.equal(defaults.overdueAfterDays, 7);

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/work-order-summary']);
    assert.ok(spec.components?.schemas?.ManagementWorkOrderSummary);
  });

  it('enforces authentication and management-read RBAC', async (t) => {
    if (!ready(t)) return;
    const unauthenticated = await api().get(PATH);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await api().get(PATH).set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns the authorized multi-Building Work Order aggregate', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.scope.mode, 'ALL_ACCESSIBLE');
    assert.equal(response.body.data.filters.overdueAfterDays, 7);
    assert.deepEqual(response.body.data.data, {
      total: 11,
      open: 2,
      inProgress: 2,
      completed: 2,
      overdue: 5,
      verified: 3,
      closed: 2,
      priority: { low: 3, medium: 2, high: 3, critical: 3 },
    });
  });

  it('supports single and explicit multi-Building scope without leakage', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.deepEqual(single.body.data.data, {
      total: 7,
      open: 1,
      inProgress: 1,
      completed: 1,
      overdue: 4,
      verified: 2,
      closed: 1,
      priority: { low: 2, medium: 1, high: 2, critical: 2 },
    });

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [f.scopeA.building.id, f.scopeB.building.id],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.total, 11);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('supports period narrowing and explicit overdue reporting age', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const period = await api()
      .get(PATH)
      .query({ dateFrom: f.recentDate, dateTo: f.recentDate })
      .set(auth());
    assert.equal(period.status, 200, JSON.stringify(period.body));
    assert.equal(period.body.data.data.total, 6);
    assert.equal(period.body.data.data.overdue, 0);
    assert.equal(period.body.data.data.verified, 3);
    assert.deepEqual(period.body.data.period, {
      dateFrom: f.recentDate,
      dateTo: f.recentDate,
      timeBasis: 'UTC',
      dateToMode: 'INCLUSIVE_DAY',
    });

    const threshold = await api()
      .get(PATH)
      .query({ overdueAfterDays: 20 })
      .set(auth());
    assert.equal(threshold.status, 200, JSON.stringify(threshold.body));
    assert.equal(threshold.body.data.data.overdue, 0);
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      total: 0,
      open: 0,
      inProgress: 0,
      completed: 0,
      overdue: 0,
      verified: 0,
      closed: 0,
      priority: { low: 0, medium: 0, high: 0, critical: 0 },
    });
  });

  it('rejects invalid scope, period, and overdue filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { overdueAfterDays: 366 },
      { overdueAfterDays: -1 },
      { dateFrom: '2026-08-18', dateTo: '2026-08-17' },
      { dateFrom: '2026-02-30' },
      {
        buildingId: f.scopeA.building.id,
        buildingIds: f.scopeB.building.id,
      },
    ];
    for (const query of cases) {
      const response = await api().get(PATH).query(query).set(auth());
      assert.equal(response.status, 400, JSON.stringify({ query, body: response.body }));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });
});
