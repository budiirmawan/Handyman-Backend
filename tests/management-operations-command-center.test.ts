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
import { parseManagementOperationsCommandCenterQuery } from '../src/modules/management-operations-command-center';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 09 focused tests — Operations Command Center only. */

const PATH = '/api/v1/management/operations-command-center';
const OPERATIONAL_DATE = '2026-08-17';
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

  const teamId = await insertTeam(scopeA.client.id);
  await insertTask(scopeA, teamId);
  await insertWorkOrder(scopeA, 'OPEN');
  await insertWorkOrder(scopeB, 'CLOSED');
  await insertAsset(scopeA);
  await insertCriticalFinding(scopeA);
  return { scopeA, scopeB, hidden };
}

async function createScope(label: string) {
  const client = await clientService.createClient({
    code: `CC_${label}_${suffix()}`,
    name: `Command Center Client ${label}`,
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

async function insertTeam(clientId: string): Promise<string> {
  const organizationId = randomUUID();
  const departmentId = randomUUID();
  const teamId = randomUUID();
  await pool!.query(
    `INSERT INTO organizations (id,client_id,code,name)
     VALUES ($1,$2,$3,'Organization')`,
    [organizationId, clientId, `ORG_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO departments (id,organization_id,code,name)
     VALUES ($1,$2,$3,'Department')`,
    [departmentId, organizationId, `DEP_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO teams (id,department_id,code,name)
     VALUES ($1,$2,$3,'Team')`,
    [teamId, departmentId, `TEAM_${suffix()}`],
  );
  return teamId;
}

async function insertTask(scope: Scope, teamId: string): Promise<void> {
  const scheduleId = randomUUID();
  const taskId = randomUUID();
  const at = `${OPERATIONAL_DATE}T08:00:00.000Z`;
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
      `${OPERATIONAL_DATE}T00:00:00.000Z`,
    ],
  );
  await pool!.query(
    `INSERT INTO generated_tasks
       (id,client_id,schedule_definition_id,occurrence_at,target_type,
        target_id,building_id,status,started_at,completed_at)
     VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,'COMPLETED',$4,$4)`,
    [
      taskId,
      scope.client.id,
      scheduleId,
      at,
      randomUUID(),
      scope.building.id,
    ],
  );
  await pool!.query(
    `INSERT INTO task_assignments
       (id,task_id,assignee_type,team_id,assigned_by_user_id)
     VALUES ($1,$2,'TEAM',$3,$4)`,
    [randomUUID(), taskId, teamId, managerUserId],
  );
}

async function insertWorkOrder(
  scope: Scope,
  status: 'OPEN' | 'CLOSED',
): Promise<void> {
  const at = '2026-08-10T08:00:00.000Z';
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

async function insertAsset(scope: Scope): Promise<void> {
  await pool!.query(
    `INSERT INTO assets (id,client_id,building_id,asset_code,asset_name,status)
     VALUES ($1,$2,$3,$4,'Active Asset','ACTIVE')`,
    [randomUUID(), scope.client.id, scope.building.id, `AST_${suffix()}`],
  );
}

async function insertCriticalFinding(scope: Scope): Promise<void> {
  const severityId = randomUUID();
  const at = '2026-08-10T10:00:00.000Z';
  await pool!.query(
    `INSERT INTO finding_severities (id,client_id,code,name,rank,status)
     VALUES ($1,$2,'HIGHEST','Highest',5,'ACTIVE')`,
    [severityId, scope.client.id],
  );
  await pool!.query(
    `INSERT INTO findings
       (id,client_id,building_id,finding_number,title,severity_id,status,
        state_changed_at,reported_by_user_id,reported_at)
     VALUES ($1,$2,$3,$4,'Critical Finding',$5,'OPEN',$6,$7,$6)`,
    [
      randomUUID(),
      scope.client.id,
      scope.building.id,
      `FND_${suffix()}`,
      severityId,
      at,
      managerUserId,
    ],
  );
}

const query = () => ({
  date: OPERATIONAL_DATE,
  dateFrom: '2026-08-01',
  dateTo: OPERATIONAL_DATE,
  graceMinutes: 0,
  overdueAfterDays: 7,
  expiringWithinDays: 30,
  interval: 'MONTH',
});

describe('BE-24 PART 09 — Management Operations Command Center', () => {
  it('documents the endpoint and delegates all component filters', () => {
    const parsed = parseManagementOperationsCommandCenterQuery(
      {
        date: OPERATIONAL_DATE,
        graceMinutes: '15',
        overdueAfterDays: '9',
        expiringWithinDays: '45',
        interval: 'DAY',
        includeSubMeters: 'true',
      },
      new Date('2026-08-18T00:00:00.000Z'),
    );
    assert.equal(parsed.operationalDate, OPERATIONAL_DATE);
    assert.equal(parsed.graceMinutes, 15);
    assert.equal(parsed.overdueAfterDays, 9);
    assert.equal(parsed.expiringWithinDays, 45);
    assert.equal(parsed.utilityInterval, 'DAY');
    assert.equal(parsed.includeSubMeters, true);

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as {
      paths?: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    assert.ok(spec.paths?.['/management/operations-command-center']);
    assert.ok(spec.components?.schemas?.ManagementOperationsCommandCenter);
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

  it('composes completed BE-24 blocks without presentation metadata', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).query(query()).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;

    assert.equal(data.dailyOperations.scheduled, 0);
    assert.equal(data.dailyOperations.completed, 1);
    assert.equal(data.pendingApprovals.pendingCount, 0);
    assert.equal(data.criticalFindings.criticalFindingCount, 1);
    assert.equal(data.workOrderSummary.total, 2);
    assert.equal(data.assetEngineeringHealth.assetRegistryCompliance.totalAssets, 1);
    assert.equal(data.operationalKpi.completed, 1);
    assert.equal(data.portfolioContext.buildingCount, 2);
    assert.equal(data.buildingPerformance.length, 2);
    assert.ok(data.workforceSummary);
    assert.ok(data.vendorSummary);
    assert.ok(data.tenantServiceSummary);
    assert.ok(data.utilitySummary);
    assert.equal(data.financialSummary.clientSummaries.length, 2);
    assert.equal(data.chart, undefined);
    assert.equal(data.widgets, undefined);
    assert.equal(data.score, undefined);
  });

  it('copies exact component and Portfolio values instead of recalculating them', async (t) => {
    if (!ready(t)) return;
    const componentQuery = query();
    const [command, daily, workOrders, operational, portfolio] =
      await Promise.all([
        api().get(PATH).query(componentQuery).set(auth()),
        api()
          .get('/api/v1/management/daily-operations')
          .query({
            date: componentQuery.date,
            graceMinutes: componentQuery.graceMinutes,
          })
          .set(auth()),
        api()
          .get('/api/v1/management/work-order-summary')
          .query(componentQuery)
          .set(auth()),
        api()
          .get('/api/v1/management/operational-kpi')
          .query(componentQuery)
          .set(auth()),
        api()
          .get('/api/v1/management/portfolio-overview')
          .query(componentQuery)
          .set(auth()),
      ]);
    for (const response of [command, daily, workOrders, operational, portfolio]) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }

    const data = command.body.data.data;
    assert.deepEqual(data.dailyOperations, daily.body.data.data);
    assert.deepEqual(data.workOrderSummary, workOrders.body.data.data);
    assert.deepEqual(data.operationalKpi, operational.body.data.data);
    assert.deepEqual(
      data.buildingPerformance,
      portfolio.body.data.data.buildingPerformance,
    );
    assert.deepEqual(data.portfolioContext, {
      buildingCount: portfolio.body.data.data.buildingCount,
      operational: portfolio.body.data.data.operational,
    });
  });

  it('supports accessible single and multi-Building scopes without leakage', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const single = await api()
      .get(PATH)
      .query({ ...query(), buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.portfolioContext.buildingCount, 1);
    assert.equal(single.body.data.data.workOrderSummary.total, 1);

    const multi = await api()
      .get(PATH)
      .query({
        ...query(),
        buildingIds: [f.scopeA.building.id, f.scopeB.building.id],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.portfolioContext.buildingCount, 2);

    const inaccessible = await api()
      .get(PATH)
      .query({ ...query(), buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns a well-formed empty command center for no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query(query())
      .set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.equal(data.dailyOperations.scheduled, 0);
    assert.equal(data.pendingApprovals.pendingCount, 0);
    assert.equal(data.workOrderSummary.total, 0);
    assert.equal(data.portfolioContext.buildingCount, 0);
    assert.deepEqual(data.buildingPerformance, []);
    assert.deepEqual(data.financialSummary.clientSummaries, []);
  });

  it('rejects invalid scope and delegated component filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { date: '17-08-2026' },
      { graceMinutes: 10081 },
      { overdueAfterDays: 366 },
      { expiringWithinDays: 366 },
      { interval: 'WEEK' },
      { includeSubMeters: 'maybe' },
      { buildingIds: `${f.scopeA.building.id},not-a-uuid` },
    ];
    for (const invalid of cases) {
      const response = await api()
        .get(PATH)
        .query({ ...query(), ...invalid })
        .set(auth());
      assert.equal(
        response.status,
        400,
        JSON.stringify({ query: invalid, body: response.body }),
      );
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });
});
