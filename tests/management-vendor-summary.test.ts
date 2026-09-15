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
import { parseManagementVendorSummaryQuery } from '../src/modules/management-vendor-summary';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 04B focused tests — Vendor Summary & Performance only. */

const PATH = '/api/v1/management/vendor-summary';
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
  const scopeA = await createBuildingScope('A', true);
  const scopeB = await createBuildingScope('B', false);
  const hidden = await createBuildingScope('HIDDEN', false);
  for (const building of [scopeA.building, scopeA.secondBuilding!, scopeB.building]) {
    await buildingAssignmentService.createAssignment(managerUserId, {
      buildingId: building.id,
    });
  }

  const v1 = await insertVendor(scopeA.client.id, 'V1', 'ACTIVE');
  const v2 = await insertVendor(scopeA.client.id, 'V2', 'ACTIVE');
  const v3 = await insertVendor(scopeA.client.id, 'V3', 'INACTIVE');
  const v4 = await insertVendor(scopeB.client.id, 'V4', 'ACTIVE');
  const v5 = await insertVendor(hidden.client.id, 'V5', 'ACTIVE');

  await relateVendor(v1, scopeA.building.id);
  await relateVendor(v1, scopeA.secondBuilding!.id);
  await relateVendor(v2, scopeA.building.id);
  await relateVendor(v3, scopeA.building.id);
  await relateVendor(v4, scopeB.building.id);
  await relateVendor(v5, hidden.building.id);

  const oldDate = new Date(Date.now() - 10 * 86400000)
    .toISOString()
    .slice(0, 10);
  const recentDate = new Date(Date.now() - 86400000)
    .toISOString()
    .slice(0, 10);
  const oldAt = `${oldDate}T08:00:00.000Z`;
  const recentAt = `${recentDate}T08:00:00.000Z`;

  await insertVendorWork(scopeA, scopeA.building.id, v1, 'COMPLETED', recentAt, 2);
  await insertVendorWork(scopeA, scopeA.building.id, v1, 'NOT_STARTED', oldAt);
  await insertVendorWork(scopeA, scopeA.building.id, v2, 'IN_PROGRESS', oldAt);
  await insertVendorWork(scopeA, scopeA.building.id, v3, 'COMPLETED', recentAt, 1);
  await insertVendorWork(scopeA, scopeA.secondBuilding!.id, v1, 'ON_HOLD', oldAt);
  await insertVendorWork(scopeB, scopeB.building.id, v4, 'COMPLETED', recentAt, 3);
  await insertVendorWork(scopeB, scopeB.building.id, v4, 'NOT_STARTED', recentAt);
  await insertVendorWork(hidden, hidden.building.id, v5, 'NOT_STARTED', oldAt);

  return { scopeA, scopeB, hidden, recentDate, v1, v2, v3, v4 };
}

async function createBuildingScope(label: string, withSecond: boolean) {
  const client = await clientService.createClient({
    code: `VS_${label}_${suffix()}`,
    name: `Vendor Summary Client ${label}`,
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
  const secondBuilding = withSecond
    ? await buildingService.createBuilding({
        propertyId: property.id,
        code: `B2_${label}_${suffix()}`,
        name: `Building ${label} 2`,
      })
    : null;
  return { client, property, building, secondBuilding };
}

type Scope = Awaited<ReturnType<typeof createBuildingScope>>;

async function insertVendor(
  clientId: string,
  label: string,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendors
       (id,client_id,vendor_code,vendor_name,status)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, clientId, `${label}_${suffix()}`, `Vendor ${label}`, status],
  );
  return id;
}

async function relateVendor(vendorId: string, buildingId: string): Promise<void> {
  await pool!.query(
    `INSERT INTO vendor_building_relationships
       (id,vendor_id,building_id,status)
     VALUES ($1,$2,$3,'ACTIVE')`,
    [randomUUID(), vendorId, buildingId],
  );
}

async function insertVendorWork(
  scope: Scope,
  buildingId: string,
  vendorId: string,
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED',
  assignedAt: string,
  completionHours?: number,
): Promise<void> {
  const workOrderId = randomUUID();
  const assignmentId = randomUUID();
  const startedAt =
    status === 'NOT_STARTED' ? null : assignedAt;
  const completedAt =
    status === 'COMPLETED'
      ? new Date(
          new Date(assignedAt).getTime() + (completionHours ?? 1) * 3600000,
        ).toISOString()
      : null;

  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,status,
        created_by_user_id,created_at)
     VALUES ($1,$2,$3,$4,'Vendor work order','GENERAL','OPEN',$5,$6)`,
    [
      workOrderId,
      scope.client.id,
      buildingId,
      `WO_${suffix()}`,
      managerUserId,
      assignedAt,
    ],
  );
  await pool!.query(
    `INSERT INTO vendor_assignments
       (id,vendor_id,work_order_id,building_id,status,assigned_by_user_id,
        assigned_at,created_at)
     VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$6)`,
    [assignmentId, vendorId, workOrderId, buildingId, managerUserId, assignedAt],
  );
  await pool!.query(
    `INSERT INTO vendor_works
       (id,vendor_assignment_id,vendor_id,work_order_id,building_id,status,
        started_at,completed_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      assignmentId,
      vendorId,
      workOrderId,
      buildingId,
      status,
      startedAt,
      completedAt,
      assignedAt,
    ],
  );
}

describe('BE-24 PART 04B — Management Vendor Summary & Performance', () => {
  it('documents the endpoint and delegates PART 01 / BE-23H filters', () => {
    const parsed = parseManagementVendorSummaryQuery({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
      overdueAfterDays: '9',
    });
    assert.equal(parsed.scope.dateFrom, '2026-08-01');
    assert.equal(parsed.scope.dateTo, '2026-08-17');
    assert.equal(parsed.overdueAfterDays, 9);

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/vendor-summary']);
    assert.ok(spec.components?.schemas?.ManagementVendorSummary);
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

  it('returns BE-23H vendor-work and performance values', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.activeVendors, 3);
    assert.equal(data.assignedVendorWork, 7);
    assert.equal(data.completedVendorWork, 3);
    assert.equal(data.overdueVendorWork, 3);
    assert.equal(data.completionRate, 42.86);
    assert.equal(data.vendorPerformance.length, 4);

    const vendorOne = data.vendorPerformance.find(
      (row: any) => row.vendorId === fixture!.v1,
    );
    assert.deepEqual(vendorOne, {
      vendorId: fixture!.v1,
      vendorCode: vendorOne.vendorCode,
      vendorName: 'Vendor V1',
      vendorStatus: 'ACTIVE',
      total: 3,
      completed: 1,
      outstanding: 2,
      overdue: 2,
      completionRate: 33.33,
      averageCompletionHours: 2,
    });
  });

  it('supports Client, single, and explicit multi-Building scope without double-counting Vendors', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.activeVendors, 2);
    assert.equal(single.body.data.data.assignedVendorWork, 4);
    assert.equal(single.body.data.data.completedVendorWork, 2);
    assert.equal(single.body.data.data.overdueVendorWork, 2);
    assert.equal(single.body.data.data.completionRate, 50);

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.activeVendors, 2);
    assert.equal(client.body.data.data.assignedVendorWork, 5);
    assert.equal(client.body.data.data.overdueVendorWork, 3);

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [
          f.scopeA.building.id,
          f.scopeA.secondBuilding!.id,
          f.scopeB.building.id,
        ],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.activeVendors, 3);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies BE-23H period and overdue-age semantics', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const period = await api()
      .get(PATH)
      .query({ dateFrom: f.recentDate, dateTo: f.recentDate })
      .set(auth());
    assert.equal(period.status, 200, JSON.stringify(period.body));
    assert.equal(period.body.data.data.activeVendors, 3);
    assert.equal(period.body.data.data.assignedVendorWork, 4);
    assert.equal(period.body.data.data.completedVendorWork, 3);
    assert.equal(period.body.data.data.overdueVendorWork, 0);
    assert.equal(period.body.data.data.completionRate, 75);

    const age = await api()
      .get(PATH)
      .query({ overdueAfterDays: 20 })
      .set(auth());
    assert.equal(age.status, 200, JSON.stringify(age.body));
    assert.equal(age.body.data.data.overdueVendorWork, 0);
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      activeVendors: 0,
      assignedVendorWork: 0,
      completedVendorWork: 0,
      overdueVendorWork: 0,
      completionRate: 0,
      vendorPerformance: [],
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
