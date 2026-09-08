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
import { parseManagementPortfolioOverviewQuery } from '../src/modules/management-portfolio-overview';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 08B focused tests — Portfolio Overview only. */

const PATH = '/api/v1/management/portfolio-overview';
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
  if (pool) await closePool(pool);
  pool = null;
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
  const scopeA = await createScope('A');
  const scopeB = await createScope('B');
  const hidden = await createScope('HIDDEN');
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

  await insertWorkOrder(scopeA, oldDate, 'OPEN');
  await insertWorkOrder(scopeA, oldDate, 'CLOSED');
  await insertWorkOrder(scopeB, oldDate, 'CLOSED');

  await insertAsset(scopeA, 'ACTIVE');
  await insertAsset(scopeA, 'UNDER_MAINTENANCE');
  await insertAsset(scopeB, 'ACTIVE');

  const severity = randomUUID();
  await pool!.query(
    `INSERT INTO finding_severities (id,client_id,code,name,rank,status)
     VALUES ($1,$2,'CRITICAL','Critical',5,'ACTIVE')`,
    [severity, scopeA.client.id],
  );
  await insertFinding(scopeA, severity, oldDate, 'OPEN');
  await insertFinding(scopeA, severity, oldDate, 'CLOSED');
  await insertTenantRequest(scopeA, oldDate);
  await pool!.query(
    `INSERT INTO security_posts
       (id,client_id,building_id,code,name,post_type,status)
     VALUES ($1,$2,$3,$4,'Lobby','LOBBY','ACTIVE')`,
    [randomUUID(), scopeA.client.id, scopeA.building.id, `POST_${suffix()}`],
  );
  return { scopeA, scopeB, hidden };
}

async function createScope(label: string) {
  const client = await clientService.createClient({
    code: `PF_${label}_${suffix()}`,
    name: `Portfolio Client ${label}`,
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

type Scope = Awaited<ReturnType<typeof createScope>>;

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
): Promise<void> {
  const at = `${date}T08:00:00.000Z`;
  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,status,
        created_by_user_id,completed_at,closed_at,created_at)
     VALUES ($1,$2,$3,$4,'Work','GENERAL',$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
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
}

async function insertAsset(
  scope: Scope,
  status: 'ACTIVE' | 'UNDER_MAINTENANCE',
): Promise<void> {
  await pool!.query(
    `INSERT INTO assets (id,client_id,building_id,asset_code,asset_name,status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      randomUUID(),
      scope.client.id,
      scope.building.id,
      `AST_${suffix()}`,
      `${status} Asset`,
      status,
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

async function insertTenantRequest(scope: Scope, date: string): Promise<void> {
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

describe('BE-24 PART 08B — Management Portfolio Overview', () => {
  it('documents the endpoint and reuses PART 08A filters', () => {
    const parsed = parseManagementPortfolioOverviewQuery({
      graceMinutes: '15',
      overdueAfterDays: '9',
      expiringWithinDays: '45',
      interval: 'DAY',
    });
    assert.equal(parsed.graceMinutes, 15);
    assert.equal(parsed.overdueAfterDays, 9);
    assert.equal(parsed.expiringWithinDays, 45);
    assert.equal(parsed.utilityInterval, 'DAY');

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/portfolio-overview']);
    assert.ok(spec.components?.schemas?.ManagementPortfolioOverview);
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

  it('returns exact scope-wide summaries and the PART 08A Building list', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.buildingCount, 2);
    assert.deepEqual(data.operational, {
      completionRate: 66.67,
      overdueRate: 33.33,
    });
    assert.deepEqual(data.workOrders, {
      total: 3,
      open: 1,
      inProgress: 0,
      completed: 0,
      overdue: 1,
      verified: 0,
      closed: 2,
    });
    assert.deepEqual(data.findings, { open: 1, closed: 1, critical: 1 });
    assert.equal(data.assetEngineering.totalAssets, 3);
    assert.equal(data.assetEngineering.activeAssets, 2);
    assert.equal(data.assetEngineering.availabilityRate, 66.67);
    assert.equal(data.housekeeping.cleaningTotal, 0);
    assert.equal(data.security.activePosts, 1);
    assert.equal(data.utility.electricityConsumption, 0);
    assert.equal(data.tenantService.totalRequests, 1);
    assert.equal(data.financial.clientSummaries.length, 2);
    assert.equal(data.buildingPerformance.length, 2);
    assert.equal(data.score, undefined);
    assert.equal(data.rank, undefined);
  });

  it('does not average Building rates', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    const data = response.body.data.data;
    const rates = data.buildingPerformance.map(
      (building: any) => building.operational.completionRate,
    );
    assert.deepEqual(new Set(rates), new Set([50, 100]));
    // Exact scope-wide 2/3 rate; arithmetic mean would incorrectly be 75.
    assert.equal(data.operational.completionRate, 66.67);
  });

  it('supports Client and explicit multi-Building selection without leakage', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.buildingCount, 1);
    assert.equal(client.body.data.data.operational.completionRate, 50);
    assert.equal(client.body.data.data.financial.clientSummaries.length, 1);

    const multi = await api()
      .get(PATH)
      .query({ buildingIds: [f.scopeA.building.id, f.scopeB.building.id] })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.buildingCount, 2);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingIds: [f.scopeA.building.id, f.hidden.building.id] })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('passes thresholds to exact component summaries', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({ graceMinutes: 10080, overdueAfterDays: 20 })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.operational.completionRate, 66.67);
    assert.equal(data.operational.overdueRate, 0);
    assert.equal(data.workOrders.overdue, 0);
    assert.equal(data.tenantService.overdueRequests, 0);
  });

  it('returns an empty Portfolio for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.equal(response.body.data.data.buildingCount, 0);
    assert.deepEqual(response.body.data.data.buildingPerformance, []);
    assert.deepEqual(response.body.data.data.financial.clientSummaries, []);
  });

  it('rejects invalid scope and delegated filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { graceMinutes: 10081 },
      { overdueAfterDays: 366 },
      { expiringWithinDays: 366 },
      { interval: 'WEEK' },
      { includeSubMeters: 'maybe' },
      { buildingIds: `${f.scopeA.building.id},not-a-uuid` },
    ];
    for (const query of cases) {
      const response = await api().get(PATH).query(query).set(auth());
      assert.equal(response.status, 400, JSON.stringify({ query, body: response.body }));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });
});
