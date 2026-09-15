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
import { parseManagementAssetReliabilityWorkQuery } from '../src/modules/management-asset-reliability-work';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 05B focused tests — Asset Reliability & Work only. */

const PATH = '/api/v1/management/asset-reliability-work';
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

  const a1 = await insertAsset(scopeA, scopeA.building.id, 'ACTIVE');
  const a2 = await insertAsset(scopeA, scopeA.building.id, 'ACTIVE');
  const a3 = await insertAsset(scopeA, scopeA.building.id, 'INACTIVE');
  const a4 = await insertAsset(scopeA, scopeA.building.id, 'UNDER_MAINTENANCE');
  await insertAsset(scopeA, scopeA.building.id, 'RETIRED');
  const a5 = await insertAsset(scopeA, scopeA.secondBuilding!.id, 'ACTIVE');
  const b1 = await insertAsset(scopeB, scopeB.building.id, 'ACTIVE');
  const b2 = await insertAsset(scopeB, scopeB.building.id, 'UNDER_MAINTENANCE');
  const hiddenAsset = await insertAsset(hidden, hidden.building.id, 'ACTIVE');

  const operationalDate = new Date(Date.now() - 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const nextDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const at = `${operationalDate}T08:00:00.000Z`;

  const correctiveAOpen = await insertWorkOrder(scopeA, scopeA.building.id, 'OPEN', at);
  const correctiveACompleted = await insertWorkOrder(
    scopeA,
    scopeA.building.id,
    'COMPLETED',
    at,
  );
  await insertBreakdown(scopeA, scopeA.building.id, a1, 'OPEN', at, correctiveAOpen);
  await insertBreakdown(
    scopeA,
    scopeA.building.id,
    a2,
    'CLOSED',
    at,
    correctiveACompleted,
  );
  await insertBreakdown(scopeA, scopeA.building.id, a3, 'OPEN', at, null);

  const correctiveA2 = await insertWorkOrder(
    scopeA,
    scopeA.secondBuilding!.id,
    'IN_PROGRESS',
    at,
  );
  await insertBreakdown(
    scopeA,
    scopeA.secondBuilding!.id,
    a5,
    'OPEN',
    at,
    correctiveA2,
  );
  const correctiveB = await insertWorkOrder(scopeB, scopeB.building.id, 'CLOSED', at);
  await insertBreakdown(scopeB, scopeB.building.id, b1, 'CLOSED', at, correctiveB);
  await insertBreakdown(hidden, hidden.building.id, hiddenAsset, 'OPEN', at, null);

  await insertFailure(scopeA, scopeA.building.id, a1, 'OPEN', at);
  await insertFailure(scopeA, scopeA.building.id, a4, 'IN_PROGRESS', at);
  await insertFailure(scopeA, scopeA.secondBuilding!.id, a5, 'RESOLVED', at);
  await insertFailure(scopeB, scopeB.building.id, b2, 'OPEN', at);
  await insertFailure(hidden, hidden.building.id, hiddenAsset, 'OPEN', at);

  const pmAWorkOrder = await insertWorkOrder(
    scopeA,
    scopeA.building.id,
    'COMPLETED',
    at,
  );
  const pmA = await insertMaintenanceBinding(
    scopeA,
    scopeA.building.id,
    a1,
    'PREVENTIVE',
    'ACTIVE',
    pmAWorkOrder,
  );
  await insertMaintenanceTask(scopeA, scopeA.building.id, pmA, at, 'COMPLETED');
  await insertMaintenanceTask(scopeA, scopeA.building.id, pmA, at, 'OPEN');
  await insertMaintenanceTask(scopeA, scopeA.building.id, pmA, at, 'CANCELLED');

  const predictiveA = await insertMaintenanceBinding(
    scopeA,
    scopeA.building.id,
    a2,
    'PREDICTIVE',
    'ACTIVE',
    null,
  );
  await insertMaintenanceTask(
    scopeA,
    scopeA.building.id,
    predictiveA,
    at,
    'OPEN',
  );

  const pmA2 = await insertMaintenanceBinding(
    scopeA,
    scopeA.secondBuilding!.id,
    a5,
    'PREVENTIVE',
    'ACTIVE',
    null,
  );
  await insertMaintenanceTask(
    scopeA,
    scopeA.secondBuilding!.id,
    pmA2,
    at,
    'COMPLETED',
  );

  const pmBWorkOrder = await insertWorkOrder(scopeB, scopeB.building.id, 'CLOSED', at);
  const pmB = await insertMaintenanceBinding(
    scopeB,
    scopeB.building.id,
    b1,
    'PREVENTIVE',
    'ACTIVE',
    pmBWorkOrder,
  );
  await insertMaintenanceTask(scopeB, scopeB.building.id, pmB, at, 'COMPLETED');
  await insertMaintenanceTask(scopeB, scopeB.building.id, pmB, at, 'OPEN');

  const inactivePm = await insertMaintenanceBinding(
    scopeB,
    scopeB.building.id,
    b2,
    'PREVENTIVE',
    'INACTIVE',
    null,
  );
  await insertMaintenanceTask(
    scopeB,
    scopeB.building.id,
    inactivePm,
    at,
    'OPEN',
  );

  return { scopeA, scopeB, hidden, operationalDate, nextDate };
}

async function createBuildingScope(label: string, withSecond: boolean) {
  const client = await clientService.createClient({
    code: `AR_${label}_${suffix()}`,
    name: `Asset Reliability Client ${label}`,
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

async function insertAsset(
  scope: Scope,
  buildingId: string,
  status: 'ACTIVE' | 'INACTIVE' | 'UNDER_MAINTENANCE' | 'RETIRED',
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO assets
       (id,client_id,building_id,asset_code,asset_name,status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, scope.client.id, buildingId, `AST_${suffix()}`, `${status} Asset`, status],
  );
  return id;
}

async function insertWorkOrder(
  scope: Scope,
  buildingId: string,
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED',
  at: string,
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,status,
        created_by_user_id,completed_at,closed_at,created_at)
     VALUES ($1,$2,$3,$4,'Asset Work','MAINTENANCE',$5,$6,$7,$8,$9)`,
    [
      id,
      scope.client.id,
      buildingId,
      `WO_${suffix()}`,
      status,
      managerUserId,
      status === 'COMPLETED' || status === 'CLOSED' ? at : null,
      status === 'CLOSED' ? at : null,
      at,
    ],
  );
  return id;
}

async function insertBreakdown(
  scope: Scope,
  buildingId: string,
  assetId: string,
  status: 'OPEN' | 'CLOSED',
  at: string,
  workOrderId: string | null,
): Promise<void> {
  await pool!.query(
    `INSERT INTO breakdown_bindings
       (id,client_id,building_id,asset_id,work_order_id,category,description,
        reported_by_user_id,reported_at,status,created_at)
     VALUES ($1,$2,$3,$4,$5,'FAILURE','Breakdown',$6,$7,$8,$7)`,
    [
      randomUUID(),
      scope.client.id,
      buildingId,
      assetId,
      workOrderId,
      managerUserId,
      at,
      status,
    ],
  );
}

async function insertFailure(
  scope: Scope,
  buildingId: string,
  assetId: string,
  failureStatus: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED',
  at: string,
): Promise<void> {
  const incidentId = randomUUID();
  await pool!.query(
    `INSERT INTO incidents
       (id,client_id,building_id,incident_number,incident_type,title,severity,
        priority,status,reported_by_user_id,reported_at,created_at)
     VALUES ($1,$2,$3,$4,'ASSET_FAILURE','Asset Failure','HIGH','HIGH',
             'REPORTED',$5,$6,$6)`,
    [
      incidentId,
      scope.client.id,
      buildingId,
      `INC_${suffix()}`,
      managerUserId,
      at,
    ],
  );
  await pool!.query(
    `INSERT INTO asset_failure_incidents
       (id,incident_id,asset_id,failure_category,occurred_at,failure_status,
        created_by_user_id,created_at)
     VALUES ($1,$2,$3,'MECHANICAL_FAILURE',$4,$5,$6,$4)`,
    [randomUUID(), incidentId, assetId, at, failureStatus, managerUserId],
  );
}

async function insertMaintenanceBinding(
  scope: Scope,
  buildingId: string,
  assetId: string,
  maintenanceType: 'PREVENTIVE' | 'PREDICTIVE',
  status: 'ACTIVE' | 'INACTIVE',
  workOrderId: string | null,
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO maintenance_bindings
       (id,client_id,building_id,asset_id,work_order_id,name,maintenance_type,
        status,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'Maintenance',$6,$7,$8)`,
    [
      id,
      scope.client.id,
      buildingId,
      assetId,
      workOrderId,
      maintenanceType,
      status,
      managerUserId,
    ],
  );
  return id;
}

async function insertMaintenanceTask(
  scope: Scope,
  buildingId: string,
  maintenanceBindingId: string,
  at: string,
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED',
): Promise<void> {
  const scheduleId = randomUUID();
  await pool!.query(
    `INSERT INTO schedule_definitions
       (id,client_id,code,name,target_type,target_id,building_id,start_at,timezone)
     VALUES ($1,$2,$3,'Maintenance Schedule','CHECKLIST_TEMPLATE',$4,$5,$6,'UTC')`,
    [scheduleId, scope.client.id, `SCH_${suffix()}`, randomUUID(), buildingId, at],
  );
  await pool!.query(
    `INSERT INTO generated_tasks
       (id,client_id,schedule_definition_id,occurrence_at,target_type,target_id,
        building_id,status,started_at,completed_at,maintenance_binding_id)
     VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      scope.client.id,
      scheduleId,
      at,
      randomUUID(),
      buildingId,
      status,
      status === 'COMPLETED' ? at : null,
      status === 'COMPLETED' ? at : null,
      maintenanceBindingId,
    ],
  );
}

describe('BE-24 PART 05B — Management Asset Reliability & Work', () => {
  it('documents the endpoint and delegates PART 01 / BE-23 filters', () => {
    const parsed = parseManagementAssetReliabilityWorkQuery({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
      graceMinutes: '30',
    });
    assert.equal(parsed.scope.dateFrom, '2026-08-01');
    assert.equal(parsed.scope.dateTo, '2026-08-17');
    assert.equal(parsed.graceMinutes, 30);

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/asset-reliability-work']);
    assert.ok(spec.components?.schemas?.ManagementAssetReliabilityWork);
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

  it('returns reliability, maintenance, availability and PM values', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.data, {
      breakdowns: { total: 5, open: 3, closed: 2 },
      failures: { total: 4, open: 2, inProgress: 1, resolved: 1 },
      activeCorrectiveWorkOrders: 2,
      completedMaintenanceWork: 2,
      overdueMaintenanceWork: 3,
      assetAvailability: {
        availableAssets: 4,
        unavailableAssets: 3,
        retiredAssets: 1,
        availabilityRate: 57.14,
      },
      pmCompliance: {
        scheduled: 5,
        completed: 3,
        overdue: 2,
        complianceRate: 60,
      },
    });
    assert.equal(response.body.data.data.warranties, undefined);
    assert.equal(response.body.data.data.certifications, undefined);
  });

  it('supports Client, single, and explicit multi-Building scope', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.deepEqual(single.body.data.data.breakdowns, {
      total: 3,
      open: 2,
      closed: 1,
    });
    assert.equal(single.body.data.data.activeCorrectiveWorkOrders, 1);
    assert.equal(single.body.data.data.overdueMaintenanceWork, 2);
    assert.deepEqual(single.body.data.data.assetAvailability, {
      availableAssets: 2,
      unavailableAssets: 2,
      retiredAssets: 1,
      availabilityRate: 50,
    });
    assert.deepEqual(single.body.data.data.pmCompliance, {
      scheduled: 2,
      completed: 1,
      overdue: 1,
      complianceRate: 50,
    });

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.breakdowns.total, 4);
    assert.equal(client.body.data.data.activeCorrectiveWorkOrders, 2);
    assert.equal(client.body.data.data.assetAvailability.availabilityRate, 60);
    assert.equal(client.body.data.data.pmCompliance.complianceRate, 66.67);

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
    assert.equal(multi.body.data.data.failures.total, 4);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies operational period and BE-23 overdue grace semantics', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const period = await api()
      .get(PATH)
      .query({ dateFrom: f.operationalDate, dateTo: f.operationalDate })
      .set(auth());
    assert.equal(period.status, 200, JSON.stringify(period.body));
    assert.equal(period.body.data.data.breakdowns.total, 5);
    assert.equal(period.body.data.data.pmCompliance.scheduled, 5);

    const emptyPeriod = await api()
      .get(PATH)
      .query({ dateFrom: f.nextDate, dateTo: f.nextDate })
      .set(auth());
    assert.equal(emptyPeriod.status, 200, JSON.stringify(emptyPeriod.body));
    assert.equal(emptyPeriod.body.data.data.breakdowns.total, 0);
    assert.equal(emptyPeriod.body.data.data.failures.total, 0);
    assert.equal(emptyPeriod.body.data.data.completedMaintenanceWork, 0);
    assert.equal(emptyPeriod.body.data.data.pmCompliance.scheduled, 0);
    assert.equal(emptyPeriod.body.data.data.assetAvailability.availableAssets, 4);

    const grace = await api()
      .get(PATH)
      .query({ graceMinutes: 10080 })
      .set(auth());
    assert.equal(grace.status, 200, JSON.stringify(grace.body));
    assert.equal(grace.body.data.data.overdueMaintenanceWork, 0);
    assert.equal(grace.body.data.data.pmCompliance.overdue, 0);
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      breakdowns: { total: 0, open: 0, closed: 0 },
      failures: { total: 0, open: 0, inProgress: 0, resolved: 0 },
      activeCorrectiveWorkOrders: 0,
      completedMaintenanceWork: 0,
      overdueMaintenanceWork: 0,
      assetAvailability: {
        availableAssets: 0,
        unavailableAssets: 0,
        retiredAssets: 0,
        availabilityRate: 0,
      },
      pmCompliance: {
        scheduled: 0,
        completed: 0,
        overdue: 0,
        complianceRate: 0,
      },
    });
  });

  it('rejects invalid scope, period, and grace filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { graceMinutes: 10081 },
      { graceMinutes: -1 },
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
