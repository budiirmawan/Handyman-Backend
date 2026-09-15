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
import { parseManagementOperationalKpiQuery } from '../src/modules/management-operational-kpi';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 07 focused tests — Operational KPI only. */

const PATH = '/api/v1/management/operational-kpi';
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

  const teamA = await insertTeam(scopeA.client.id, 'A');
  const teamB = await insertTeam(scopeB.client.id, 'B');
  const teamHidden = await insertTeam(hidden.client.id, 'H');
  const operationalDate = new Date(Date.now() - 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const nextDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  await insertTasks(scopeA, teamA, operationalDate, [
    'COMPLETED',
    'COMPLETED',
    'OPEN',
    'IN_PROGRESS',
  ]);
  await insertTasks(scopeB, teamB, operationalDate, ['COMPLETED', 'OPEN']);
  await insertTasks(hidden, teamHidden, operationalDate, ['OPEN']);

  await insertWorkOrder(scopeA, operationalDate, 'OPEN');
  await insertWorkOrder(scopeA, operationalDate, 'CLOSED');
  await insertWorkOrder(scopeA, operationalDate, 'ASSIGNED');
  await insertWorkOrder(scopeB, operationalDate, 'OPEN');
  await insertWorkOrder(scopeB, operationalDate, 'CLOSED');
  await insertWorkOrder(hidden, operationalDate, 'OPEN');

  await insertFinding(scopeA, operationalDate, 'OPEN');
  await insertFinding(scopeA, operationalDate, 'REWORK_REQUIRED');
  await insertFinding(scopeA, operationalDate, 'CLOSED');
  await insertFinding(scopeA, operationalDate, 'VERIFIED');
  await insertFinding(scopeB, operationalDate, 'ASSIGNED');
  await insertFinding(scopeB, operationalDate, 'CLOSED');
  await insertFinding(hidden, operationalDate, 'OPEN');

  await insertIncident(scopeA, operationalDate, 'CRITICAL', 'SECURITY');
  await insertIncident(scopeA, operationalDate, 'HIGH', 'HVAC');
  await insertIncident(scopeB, operationalDate, 'CRITICAL', 'SECURITY');
  await insertIncident(hidden, operationalDate, 'CRITICAL', 'SECURITY');

  await insertCriticalTenantRequest(scopeA, operationalDate);
  await insertCriticalTenantRequest(scopeB, operationalDate);
  await insertCriticalTenantRequest(hidden, operationalDate);

  return { scopeA, scopeB, hidden, operationalDate, nextDate };
}

async function createBuildingScope(label: string) {
  const client = await clientService.createClient({
    code: `OK_${label}_${suffix()}`,
    name: `Operational KPI Client ${label}`,
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
  statuses: Array<'OPEN' | 'IN_PROGRESS' | 'COMPLETED'>,
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
    const at = `${date}T${String(index + 1).padStart(2, '0')}:00:00.000Z`;
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
        status === 'IN_PROGRESS' || status === 'COMPLETED' ? at : null,
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
  status: 'OPEN' | 'ASSIGNED' | 'CLOSED',
): Promise<void> {
  const at = `${date}T08:00:00.000Z`;
  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,status,
        created_by_user_id,completed_at,closed_at,created_at)
     VALUES ($1,$2,$3,$4,'Work Order','GENERAL',$5,$6,$7,$8,$9)`,
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

async function insertFinding(
  scope: Scope,
  date: string,
  status: 'OPEN' | 'ASSIGNED' | 'REWORK_REQUIRED' | 'VERIFIED' | 'CLOSED',
): Promise<void> {
  const at = `${date}T09:00:00.000Z`;
  await pool!.query(
    `INSERT INTO findings
       (id,client_id,building_id,finding_number,title,status,state_changed_at,
        reported_by_user_id,reported_at,closed_at,closed_by_user_id,
        closure_notes,created_at)
     VALUES ($1,$2,$3,$4,'Finding',$5,$6,$7,$6,$8,$9,$10,$6)`,
    [
      randomUUID(),
      scope.client.id,
      scope.building.id,
      `FND_${suffix()}`,
      status,
      at,
      managerUserId,
      status === 'CLOSED' ? at : null,
      status === 'CLOSED' ? managerUserId : null,
      status === 'CLOSED' ? 'Closed' : null,
    ],
  );
}

async function insertIncident(
  scope: Scope,
  date: string,
  severity: 'HIGH' | 'CRITICAL',
  category: 'SECURITY' | 'HVAC',
): Promise<void> {
  const incidentId = randomUUID();
  const at = `${date}T10:00:00.000Z`;
  await pool!.query(
    `INSERT INTO incidents
       (id,client_id,building_id,incident_number,incident_type,title,severity,
        priority,status,reported_by_user_id,reported_at,created_at)
     VALUES ($1,$2,$3,$4,'OPERATIONAL','Incident',$5,'HIGH','REPORTED',$6,$7,$7)`,
    [
      incidentId,
      scope.client.id,
      scope.building.id,
      `INC_${suffix()}`,
      severity,
      managerUserId,
      at,
    ],
  );
  await pool!.query(
    `INSERT INTO operational_incidents
       (id,incident_id,operational_category,occurred_at,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), incidentId, category, at, managerUserId],
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
        request_number,request_type,title,priority,status,requested_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'GENERAL','Request','CRITICAL','OPEN',$7,$7)`,
    [
      randomUUID(),
      scope.client.id,
      companyId,
      picId,
      scope.building.id,
      `TSR_${suffix()}`,
      `${date}T11:00:00.000Z`,
    ],
  );
}

describe('BE-24 PART 07 — Management Operational KPI', () => {
  it('documents the endpoint and delegates PART 01 / BE-23G filters', () => {
    const parsed = parseManagementOperationalKpiQuery({
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
    assert.ok(spec.paths?.['/management/operational-kpi']);
    assert.ok(spec.components?.schemas?.ManagementOperationalKpi);
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

  it('returns BE-23-aligned Operational KPI values', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.data, {
      scheduled: 6,
      completed: 3,
      completionRate: 50,
      overdue: 3,
      overdueRate: 50,
      workOrders: { open: 2, closed: 2 },
      findings: { open: 3, closed: 2 },
      incidentCount: 3,
      criticalOperationalItems: {
        total: 4,
        securityIncidents: 2,
        tenantServiceRequests: 2,
      },
    });
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
    assert.deepEqual(single.body.data.data, {
      scheduled: 4,
      completed: 2,
      completionRate: 50,
      overdue: 2,
      overdueRate: 50,
      workOrders: { open: 1, closed: 1 },
      findings: { open: 2, closed: 1 },
      incidentCount: 2,
      criticalOperationalItems: {
        total: 2,
        securityIncidents: 1,
        tenantServiceRequests: 1,
      },
    });

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeB.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.scheduled, 2);
    assert.equal(client.body.data.data.incidentCount, 1);

    const multi = await api()
      .get(PATH)
      .query({ buildingIds: [f.scopeA.building.id, f.scopeB.building.id] })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.scheduled, 6);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies the shared period and BE-23 overdue grace semantics', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const period = await api()
      .get(PATH)
      .query({ dateFrom: f.operationalDate, dateTo: f.operationalDate })
      .set(auth());
    assert.equal(period.status, 200, JSON.stringify(period.body));
    assert.equal(period.body.data.data.scheduled, 6);
    assert.equal(period.body.data.data.incidentCount, 3);

    const empty = await api()
      .get(PATH)
      .query({ dateFrom: f.nextDate, dateTo: f.nextDate })
      .set(auth());
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.data.data.scheduled, 0);
    assert.equal(empty.body.data.data.workOrders.open, 0);
    assert.equal(empty.body.data.data.findings.open, 0);
    assert.equal(empty.body.data.data.incidentCount, 0);
    assert.equal(empty.body.data.data.criticalOperationalItems.total, 0);

    const grace = await api()
      .get(PATH)
      .query({ graceMinutes: 10080 })
      .set(auth());
    assert.equal(grace.status, 200, JSON.stringify(grace.body));
    assert.equal(grace.body.data.data.overdue, 0);
    assert.equal(grace.body.data.data.overdueRate, 0);
    assert.equal(grace.body.data.data.completionRate, 50);
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      scheduled: 0,
      completed: 0,
      completionRate: 0,
      overdue: 0,
      overdueRate: 0,
      workOrders: { open: 0, closed: 0 },
      findings: { open: 0, closed: 0 },
      incidentCount: 0,
      criticalOperationalItems: {
        total: 0,
        securityIncidents: 0,
        tenantServiceRequests: 0,
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
