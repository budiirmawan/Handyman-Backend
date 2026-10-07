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
import { parseManagementDailyOperationsQuery } from '../src/modules/management-daily-operations';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 02A focused tests — Daily Operations only. */

const PATH = '/api/v1/management/daily-operations';
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
  const operationalDate = new Date(Date.now() - 86400000)
    .toISOString()
    .slice(0, 10);

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

  await insertTasks({
    clientId: scopeA.client.id,
    buildingId: scopeA.building.id,
    teamId: teamA,
    operationalDate,
    statuses: ['OPEN', 'IN_PROGRESS', 'COMPLETED'],
  });
  await insertTasks({
    clientId: scopeB.client.id,
    buildingId: scopeB.building.id,
    teamId: teamB,
    operationalDate,
    statuses: ['ASSIGNED', 'COMPLETED'],
  });
  await insertTasks({
    clientId: hidden.client.id,
    buildingId: hidden.building.id,
    teamId: teamHidden,
    operationalDate,
    statuses: ['OPEN'],
  });

  await insertFindings(
    scopeA.client.id,
    scopeA.building.id,
    operationalDate,
    ['OPEN', 'IN_PROGRESS'],
  );
  await insertFindings(
    scopeB.client.id,
    scopeB.building.id,
    operationalDate,
    ['PENDING_REVIEW'],
  );
  await insertFindings(
    hidden.client.id,
    hidden.building.id,
    operationalDate,
    ['OPEN'],
  );

  await insertSecurityIncident(
    scopeA.client.id,
    scopeA.building.id,
    operationalDate,
    'CRITICAL',
  );
  await insertSecurityIncident(
    scopeB.client.id,
    scopeB.building.id,
    operationalDate,
    'CRITICAL',
  );
  await insertSecurityIncident(
    hidden.client.id,
    hidden.building.id,
    operationalDate,
    'CRITICAL',
  );

  await insertTenantRequest(
    scopeA.client.id,
    scopeA.building.id,
    operationalDate,
    'CRITICAL',
  );
  await insertTenantRequest(
    scopeB.client.id,
    scopeB.building.id,
    operationalDate,
    'CRITICAL',
  );
  await insertTenantRequest(
    hidden.client.id,
    hidden.building.id,
    operationalDate,
    'CRITICAL',
  );

  return { operationalDate, scopeA, scopeB, hidden };
}

async function createBuildingScope(label: string) {
  const client = await clientService.createClient({
    code: `DO_${label}_${suffix()}`,
    name: `Daily Operations Client ${label}`,
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

async function insertTeam(clientId: string, label: string): Promise<string> {
  const organizationId = randomUUID();
  const departmentId = randomUUID();
  const teamId = randomUUID();
  await pool!.query(
    `INSERT INTO organizations (id, client_id, code, name)
     VALUES ($1,$2,$3,$4)`,
    [organizationId, clientId, `ORG_${label}_${suffix()}`, `Org ${label}`],
  );
  await pool!.query(
    `INSERT INTO departments (id, organization_id, code, name)
     VALUES ($1,$2,$3,$4)`,
    [departmentId, organizationId, `DEP_${label}_${suffix()}`, `Dept ${label}`],
  );
  await pool!.query(
    `INSERT INTO teams (id, department_id, code, name)
     VALUES ($1,$2,$3,$4)`,
    [teamId, departmentId, `TEAM_${label}_${suffix()}`, `Team ${label}`],
  );
  return teamId;
}

async function insertTasks(input: {
  clientId: string;
  buildingId: string;
  teamId: string;
  operationalDate: string;
  statuses: string[];
}): Promise<void> {
  const scheduleId = randomUUID();
  await pool!.query(
    `INSERT INTO schedule_definitions
       (id,client_id,code,name,target_type,target_id,building_id,start_at,timezone)
     VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,'UTC')`,
    [
      scheduleId,
      input.clientId,
      `SCH_${suffix()}`,
      'Daily operations schedule',
      randomUUID(),
      input.buildingId,
      `${input.operationalDate}T00:00:00.000Z`,
    ],
  );

  for (const [index, status] of input.statuses.entries()) {
    const taskId = randomUUID();
    const hour = String(index + 1).padStart(2, '0');
    const occurrence = `${input.operationalDate}T${hour}:00:00.000Z`;
    await pool!.query(
      `INSERT INTO generated_tasks
         (id,client_id,schedule_definition_id,occurrence_at,target_type,
          target_id,building_id,status,started_at,completed_at)
       VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,$8,$9)`,
      [
        taskId,
        input.clientId,
        scheduleId,
        occurrence,
        randomUUID(),
        input.buildingId,
        status,
        status === 'IN_PROGRESS' || status === 'COMPLETED' ? occurrence : null,
        status === 'COMPLETED'
          ? `${input.operationalDate}T${hour}:30:00.000Z`
          : null,
      ],
    );
    await pool!.query(
      `INSERT INTO task_assignments
         (id,task_id,assignee_type,team_id,assigned_by_user_id)
       VALUES ($1,$2,'TEAM',$3,$4)`,
      [randomUUID(), taskId, input.teamId, managerUserId],
    );
  }
}

async function insertFindings(
  clientId: string,
  buildingId: string,
  date: string,
  statuses: string[],
): Promise<void> {
  for (const [index, status] of statuses.entries()) {
    await pool!.query(
      `INSERT INTO findings
         (id,client_id,building_id,finding_number,title,status,
          reported_by_user_id,reported_at,state_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        randomUUID(),
        clientId,
        buildingId,
        `F_${suffix()}`,
        `Open finding ${index}`,
        status,
        managerUserId,
        `${date}T04:00:00.000Z`,
      ],
    );
  }
}

async function insertSecurityIncident(
  clientId: string,
  buildingId: string,
  date: string,
  severity: 'CRITICAL' | 'HIGH',
): Promise<void> {
  const incidentId = randomUUID();
  await pool!.query(
    `INSERT INTO incidents
       (id,client_id,building_id,incident_number,incident_type,title,severity,
        priority,reported_by_user_id,reported_at)
     VALUES ($1,$2,$3,$4,'OPERATIONAL',$5,$6,'HIGH',$7,$8)`,
    [
      incidentId,
      clientId,
      buildingId,
      `INC_${suffix()}`,
      'Security incident',
      severity,
      managerUserId,
      `${date}T05:00:00.000Z`,
    ],
  );
  await pool!.query(
    `INSERT INTO operational_incidents
       (id,incident_id,operational_category,occurred_at,created_by_user_id)
     VALUES ($1,$2,'SECURITY',$3,$4)`,
    [randomUUID(), incidentId, `${date}T05:00:00.000Z`, managerUserId],
  );
}

async function insertTenantRequest(
  clientId: string,
  buildingId: string,
  date: string,
  priority: 'CRITICAL' | 'HIGH',
): Promise<void> {
  const companyId = randomUUID();
  const picId = randomUUID();
  await pool!.query(
    `INSERT INTO tenant_companies
       (id,client_id,tenant_code,tenant_name)
     VALUES ($1,$2,$3,$4)`,
    [companyId, clientId, `TEN_${suffix()}`, 'Tenant'],
  );
  await pool!.query(
    `INSERT INTO tenant_pics
       (id,tenant_company_id,pic_name,is_primary)
     VALUES ($1,$2,'Tenant PIC',TRUE)`,
    [picId, companyId],
  );
  await pool!.query(
    `INSERT INTO tenant_service_requests
       (id,client_id,tenant_company_id,tenant_pic_id,building_id,
        request_number,request_type,title,priority,requested_at)
     VALUES ($1,$2,$3,$4,$5,$6,'GENERAL','Critical request',$7,$8)`,
    [
      randomUUID(),
      clientId,
      companyId,
      picId,
      buildingId,
      `REQ_${suffix()}`,
      priority,
      `${date}T06:00:00.000Z`,
    ],
  );
}

describe('BE-24 PART 02A — Management Daily Operations', () => {
  it('documents the endpoint and delegates PART 01 / BE-23 filter semantics', () => {
    const parsed = parseManagementDailyOperationsQuery(
      { date: '2026-08-17', graceMinutes: '15' },
      new Date('2026-08-18T00:00:00.000Z'),
    );
    assert.equal(parsed.operationalDate, '2026-08-17');
    assert.equal(parsed.graceMinutes, 15);
    assert.equal(parsed.scope.dateFrom, '2026-08-17');
    assert.equal(parsed.scope.dateTo, '2026-08-17');

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/daily-operations']);
    assert.ok(spec.components?.schemas?.ManagementDailyOperations);
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

  it('returns the authorized multi-Building daily aggregate', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const response = await api()
      .get(PATH)
      .query({ date: f.operationalDate })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.scope.mode, 'ALL_ACCESSIBLE');
    assert.deepEqual(response.body.data.period, {
      dateFrom: f.operationalDate,
      dateTo: f.operationalDate,
      timeBasis: 'UTC',
      dateToMode: 'INCLUSIVE_DAY',
    });
    assert.deepEqual(response.body.data.data, {
      scheduled: 2,
      completed: 2,
      inProgress: 1,
      overdue: 3,
      openFindings: 3,
      criticalOperationalItems: {
        total: 4,
        securityIncidents: 2,
        tenantServiceRequests: 2,
      },
    });
  });

  it('supports single and explicit multi-Building selection without leakage', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ date: f.operationalDate, buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.deepEqual(single.body.data.data, {
      scheduled: 1,
      completed: 1,
      inProgress: 1,
      overdue: 2,
      openFindings: 2,
      criticalOperationalItems: {
        total: 2,
        securityIncidents: 1,
        tenantServiceRequests: 1,
      },
    });

    const multi = await api()
      .get(PATH)
      .query({
        date: f.operationalDate,
        buildingIds: [f.scopeA.building.id, f.scopeB.building.id],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.scheduled, 2);
    assert.equal(multi.body.data.data.overdue, 3);

    const inaccessible = await api()
      .get(PATH)
      .query({ date: f.operationalDate, buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({ date: fixture!.operationalDate })
      .set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      scheduled: 0,
      completed: 0,
      inProgress: 0,
      overdue: 0,
      openFindings: 0,
      criticalOperationalItems: {
        total: 0,
        securityIncidents: 0,
        tenantServiceRequests: 0,
      },
    });
  });

  it('rejects invalid daily, grace, and scope filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { date: '2026-02-30' },
      { date: 'not-a-date' },
      { graceMinutes: '10081' },
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
