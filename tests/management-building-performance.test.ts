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
import { parseManagementBuildingPerformanceQuery } from '../src/modules/management-building-performance';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 08A focused tests — Building Performance only. */

const PATH = '/api/v1/management/building-performance';
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

  const taskDate = new Date(Date.now() - 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const oldDate = new Date(Date.now() - 10 * 86400000)
    .toISOString()
    .slice(0, 10);
  const teamA = await insertTeam(scopeA.client.id, 'A');
  const teamB = await insertTeam(scopeB.client.id, 'B');
  await insertTasks(scopeA, teamA, taskDate, ['COMPLETED', 'OPEN']);
  await insertTasks(scopeB, teamB, taskDate, ['COMPLETED']);

  const openWorkOrder = await insertWorkOrder(scopeA, oldDate, 'OPEN');
  await insertWorkOrder(scopeA, oldDate, 'CLOSED');
  await insertWorkOrder(scopeB, oldDate, 'CLOSED');

  const activeAssetA = await insertAsset(scopeA, 'ACTIVE');
  await insertAsset(scopeA, 'UNDER_MAINTENANCE');
  await insertAsset(scopeB, 'ACTIVE');
  await insertBreakdown(scopeA, activeAssetA, openWorkOrder, oldDate);

  const severity = randomUUID();
  await pool!.query(
    `INSERT INTO finding_severities (id,client_id,code,name,rank,status)
     VALUES ($1,$2,'CRITICAL','Critical',5,'ACTIVE')`,
    [severity, scopeA.client.id],
  );
  await insertFinding(scopeA, severity, oldDate, 'OPEN');
  await insertFinding(scopeA, severity, oldDate, 'CLOSED');

  await insertSecurityIncident(scopeA, oldDate);
  await insertCriticalTenantRequest(scopeA, oldDate);
  await pool!.query(
    `INSERT INTO security_posts
       (id,client_id,building_id,code,name,post_type,status)
     VALUES ($1,$2,$3,$4,'Lobby','LOBBY','ACTIVE')`,
    [randomUUID(), scopeA.client.id, scopeA.building.id, `POST_${suffix()}`],
  );

  return { scopeA, scopeB, hidden };
}

async function createBuildingScope(label: string) {
  const client = await clientService.createClient({
    code: `BP_${label}_${suffix()}`,
    name: `Building Performance Client ${label}`,
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

type Scope = Awaited<ReturnType<typeof createBuildingScope>>;

async function insertTeam(clientId: string, label: string): Promise<string> {
  const organizationId = randomUUID();
  const departmentId = randomUUID();
  const teamId = randomUUID();
  await pool!.query(
    `INSERT INTO organizations (id,client_id,code,name)
     VALUES ($1,$2,$3,'Organization')`,
    [organizationId, clientId, `ORG_${label}_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO departments (id,organization_id,code,name)
     VALUES ($1,$2,$3,'Department')`,
    [departmentId, organizationId, `DEP_${label}_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO teams (id,department_id,code,name)
     VALUES ($1,$2,$3,'Team')`,
    [teamId, departmentId, `TEAM_${label}_${suffix()}`],
  );
  return teamId;
}

async function insertTasks(
  scope: Scope,
  teamId: string,
  date: string,
  statuses: Array<'OPEN' | 'COMPLETED'>,
): Promise<void> {
  const scheduleId = randomUUID();
  await pool!.query(
    `INSERT INTO schedule_definitions
       (id,client_id,code,name,target_type,target_id,building_id,start_at,timezone)
     VALUES ($1,$2,$3,'Schedule','CHECKLIST_TEMPLATE',$4,$5,$6,'UTC')`,
    [
      scheduleId,
      scope.client.id,
      `SCH_${suffix()}`,
      randomUUID(),
      scope.building.id,
      `${date}T00:00:00.000Z`,
    ],
  );
  for (const [index, status] of statuses.entries()) {
    const taskId = randomUUID();
    const at = `${date}T0${index + 1}:00:00.000Z`;
    await pool!.query(
      `INSERT INTO generated_tasks
         (id,client_id,schedule_definition_id,occurrence_at,target_type,
          target_id,building_id,status,started_at,completed_at)
       VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,$8,$9)`,
      [
        taskId,
        scope.client.id,
        scheduleId,
        at,
        randomUUID(),
        scope.building.id,
        status,
        status === 'COMPLETED' ? at : null,
        status === 'COMPLETED' ? at : null,
      ],
    );
    await pool!.query(
      `INSERT INTO task_assignments
         (id,task_id,assignee_type,team_id,assigned_by_user_id)
       VALUES ($1,$2,'TEAM',$3,$4)`,
      [randomUUID(), taskId, teamId, managerUserId],
    );
  }
}

async function insertWorkOrder(
  scope: Scope,
  date: string,
  status: 'OPEN' | 'CLOSED',
): Promise<string> {
  const id = randomUUID();
  const at = `${date}T08:00:00.000Z`;
  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,status,
        created_by_user_id,completed_at,closed_at,created_at)
     VALUES ($1,$2,$3,$4,'Work','GENERAL',$5,$6,$7,$8,$9)`,
    [
      id,
      scope.client.id,
      scope.building.id,
      `WO_${suffix()}`,
      status,
      managerUserId,
      status === 'CLOSED' ? at : null,
      status === 'CLOSED' ? at : null,
      at,
    ],
  );
  return id;
}

async function insertAsset(
  scope: Scope,
  status: 'ACTIVE' | 'UNDER_MAINTENANCE',
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO assets (id,client_id,building_id,asset_code,asset_name,status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      scope.client.id,
      scope.building.id,
      `AST_${suffix()}`,
      `${status} Asset`,
      status,
    ],
  );
  return id;
}

async function insertBreakdown(
  scope: Scope,
  assetId: string,
  workOrderId: string,
  date: string,
): Promise<void> {
  const at = `${date}T09:00:00.000Z`;
  await pool!.query(
    `INSERT INTO breakdown_bindings
       (id,client_id,building_id,asset_id,work_order_id,category,description,
        reported_by_user_id,reported_at,status)
     VALUES ($1,$2,$3,$4,$5,'FAILURE','Breakdown',$6,$7,'OPEN')`,
    [
      randomUUID(),
      scope.client.id,
      scope.building.id,
      assetId,
      workOrderId,
      managerUserId,
      at,
    ],
  );
}

async function insertFinding(
  scope: Scope,
  severityId: string,
  date: string,
  status: 'OPEN' | 'CLOSED',
): Promise<void> {
  const at = `${date}T10:00:00.000Z`;
  await pool!.query(
    `INSERT INTO findings
       (id,client_id,building_id,finding_number,title,severity_id,status,
        state_changed_at,reported_by_user_id,reported_at,closed_at,
        closed_by_user_id,closure_notes)
     VALUES ($1,$2,$3,$4,'Finding',$5,$6,$7,$8,$7,$9,$10,$11)`,
    [
      randomUUID(),
      scope.client.id,
      scope.building.id,
      `FND_${suffix()}`,
      severityId,
      status,
      at,
      managerUserId,
      status === 'CLOSED' ? at : null,
      status === 'CLOSED' ? managerUserId : null,
      status === 'CLOSED' ? 'Closed' : null,
    ],
  );
}

async function insertSecurityIncident(scope: Scope, date: string): Promise<void> {
  const incidentId = randomUUID();
  const at = `${date}T11:00:00.000Z`;
  await pool!.query(
    `INSERT INTO incidents
       (id,client_id,building_id,incident_number,incident_type,title,severity,
        priority,status,reported_by_user_id,reported_at)
     VALUES ($1,$2,$3,$4,'OPERATIONAL','Incident','CRITICAL','HIGH',
             'REPORTED',$5,$6)`,
    [
      incidentId,
      scope.client.id,
      scope.building.id,
      `INC_${suffix()}`,
      managerUserId,
      at,
    ],
  );
  await pool!.query(
    `INSERT INTO operational_incidents
       (id,incident_id,operational_category,occurred_at,created_by_user_id)
     VALUES ($1,$2,'SECURITY',$3,$4)`,
    [randomUUID(), incidentId, at, managerUserId],
  );
}

async function insertCriticalTenantRequest(
  scope: Scope,
  date: string,
): Promise<void> {
  const companyId = randomUUID();
  const picId = randomUUID();
  await pool!.query(
    `INSERT INTO tenant_companies (id,client_id,tenant_code,tenant_name)
     VALUES ($1,$2,$3,'Tenant')`,
    [companyId, scope.client.id, `TEN_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO tenant_pics (id,tenant_company_id,pic_name,is_primary)
     VALUES ($1,$2,'PIC',TRUE)`,
    [picId, companyId],
  );
  await pool!.query(
    `INSERT INTO tenant_service_requests
       (id,client_id,tenant_company_id,tenant_pic_id,building_id,
        request_number,request_type,title,priority,status,requested_at)
     VALUES ($1,$2,$3,$4,$5,$6,'GENERAL','Request','CRITICAL','OPEN',$7)`,
    [
      randomUUID(),
      scope.client.id,
      companyId,
      picId,
      scope.building.id,
      `TSR_${suffix()}`,
      `${date}T12:00:00.000Z`,
    ],
  );
}

describe('BE-24 PART 08A — Management Building Performance', () => {
  it('documents the endpoint and delegates component filters', () => {
    const parsed = parseManagementBuildingPerformanceQuery({
      graceMinutes: '15',
      overdueAfterDays: '9',
      expiringWithinDays: '45',
      interval: 'DAY',
      includeSubMeters: 'true',
    });
    assert.equal(parsed.graceMinutes, 15);
    assert.equal(parsed.overdueAfterDays, 9);
    assert.equal(parsed.expiringWithinDays, 45);
    assert.equal(parsed.utilityInterval, 'DAY');
    assert.equal(parsed.includeSubMeters, true);

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/building-performance']);
    assert.ok(spec.components?.schemas?.ManagementBuildingPerformance);
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

  it('composes an existing-summary row without a synthetic score', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({ buildingId: fixture!.scopeA.building.id })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = response.body.data.data.buildings[0];
    assert.equal(row.buildingId, fixture!.scopeA.building.id);
    assert.deepEqual(row.operational, {
      completionRate: 50,
      overdueRate: 50,
    });
    assert.deepEqual(row.workOrders, {
      total: 2,
      open: 1,
      inProgress: 0,
      completed: 0,
      overdue: 1,
      verified: 0,
      closed: 1,
    });
    assert.deepEqual(row.findings, { open: 1, closed: 1, critical: 1 });
    assert.equal(row.engineeringAssetHealth.totalAssets, 2);
    assert.equal(row.engineeringAssetHealth.activeAssets, 1);
    assert.equal(row.engineeringAssetHealth.availabilityRate, 50);
    assert.deepEqual(row.engineeringAssetHealth.breakdowns, {
      total: 1,
      open: 1,
      closed: 0,
    });
    assert.equal(row.housekeeping.cleaningTotal, 0);
    assert.equal(row.housekeeping.qualityAuditAverageScore, null);
    assert.equal(row.security.activePosts, 1);
    assert.equal(row.utility.electricityConsumption, 0);
    assert.deepEqual(row.tenantService, {
      totalRequests: 1,
      openRequests: 1,
      inProgressRequests: 0,
      completedRequests: 0,
      overdueRequests: 1,
      completionRate: 0,
      complaints: { total: 0, open: 0, escalated: 0, cancelled: 0 },
    });
    assert.equal(row.score, undefined);
    assert.equal(row.rank, undefined);
  });

  it('supports Client and explicit multi-Building scope as per-Building rows only', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.buildings.length, 1);

    const multi = await api()
      .get(PATH)
      .query({ buildingIds: [f.scopeA.building.id, f.scopeB.building.id] })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.buildings.length, 2);
    assert.equal(multi.body.data.data.portfolio, undefined);

    const b = multi.body.data.data.buildings.find(
      (row: any) => row.buildingId === f.scopeB.building.id,
    );
    assert.deepEqual(b.operational, { completionRate: 100, overdueRate: 0 });
    assert.equal(b.workOrders.closed, 1);
    assert.equal(b.engineeringAssetHealth.availabilityRate, 100);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('passes component thresholds without recalculating source summaries', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({
        buildingId: fixture!.scopeA.building.id,
        graceMinutes: 10080,
        overdueAfterDays: 20,
      })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = response.body.data.data.buildings[0];
    assert.equal(row.operational.completionRate, 50);
    assert.equal(row.operational.overdueRate, 0);
    assert.equal(row.workOrders.overdue, 0);
    assert.equal(row.tenantService.overdueRequests, 0);
  });

  it('returns an empty row list for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, { buildings: [] });
  });

  it('rejects invalid scope and delegated component filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { graceMinutes: 10081 },
      { overdueAfterDays: 366 },
      { expiringWithinDays: 366 },
      { interval: 'WEEK' },
      { includeSubMeters: 'maybe' },
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
