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
import { parseManagementWorkforceSummaryQuery } from '../src/modules/management-workforce-summary';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 04A focused tests — Workforce Summary only. */

const PATH = '/api/v1/management/workforce-summary';
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

  const engineering = await insertHierarchy(scopeA.client.id, 'ENG', 'ALPHA');
  const operations = await insertHierarchy(scopeA.client.id, 'OPS', 'BETA');
  const security = await insertHierarchy(scopeB.client.id, 'SEC', 'GUARD');
  const hiddenHierarchy = await insertHierarchy(
    hidden.client.id,
    'HID',
    'HIDDEN',
  );

  const w1 = await insertWorkforce(engineering, 'W1', 'INTERNAL', 'ACTIVE');
  const w2 = await insertWorkforce(engineering, 'W2', 'OUTSOURCED', 'ACTIVE');
  const w3 = await insertWorkforce(operations, 'W3', 'CONTRACT', 'INACTIVE');
  const w4 = await insertWorkforce(security, 'W4', 'INTERNAL', 'ACTIVE');
  const w5 = await insertWorkforce(
    hiddenHierarchy,
    'W5',
    'INTERNAL',
    'ACTIVE',
  );

  await assignWorkforce(w1, scopeA.building.id);
  await assignWorkforce(w2, scopeA.building.id);
  await assignWorkforce(w2, scopeA.secondBuilding!.id);
  await assignWorkforce(w3, scopeA.building.id);
  await assignWorkforce(w4, scopeB.building.id);
  await assignWorkforce(w5, hidden.building.id);

  const operationalDate = new Date(Date.now() - 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const nextDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  await insertTask(
    scopeA.client.id,
    scopeA.building.id,
    w1,
    operationalDate,
    1,
    'COMPLETED',
    2,
  );
  await insertTask(
    scopeA.client.id,
    scopeA.building.id,
    w1,
    operationalDate,
    4,
    'OPEN',
  );
  await insertTask(
    scopeA.client.id,
    scopeA.secondBuilding!.id,
    w2,
    operationalDate,
    1,
    'COMPLETED',
    1,
  );
  await insertTask(
    scopeB.client.id,
    scopeB.building.id,
    w4,
    operationalDate,
    2,
    'IN_PROGRESS',
  );
  await insertTask(
    scopeB.client.id,
    scopeB.building.id,
    w4,
    operationalDate,
    5,
    'COMPLETED',
    null,
  );
  await insertTask(
    hidden.client.id,
    hidden.building.id,
    w5,
    operationalDate,
    1,
    'OPEN',
  );

  return {
    scopeA,
    scopeB,
    hidden,
    operationalDate,
    nextDate,
    engineering,
    operations,
    security,
  };
}

async function createBuildingScope(label: string, withSecond: boolean) {
  const client = await clientService.createClient({
    code: `WF_${label}_${suffix()}`,
    name: `Workforce Client ${label}`,
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

type Hierarchy = {
  organizationId: string;
  departmentId: string;
  departmentCode: string;
  teamId: string;
  teamCode: string;
  positionId: string;
};

async function insertHierarchy(
  clientId: string,
  departmentCode: string,
  teamCode: string,
): Promise<Hierarchy> {
  const organizationId = randomUUID();
  const departmentId = randomUUID();
  const teamId = randomUUID();
  const positionId = randomUUID();
  await pool!.query(
    `INSERT INTO organizations (id,client_id,code,name)
     VALUES ($1,$2,$3,$4)`,
    [organizationId, clientId, `ORG_${suffix()}`, 'Organization'],
  );
  await pool!.query(
    `INSERT INTO departments (id,organization_id,code,name)
     VALUES ($1,$2,$3,$4)`,
    [departmentId, organizationId, departmentCode, `${departmentCode} Department`],
  );
  await pool!.query(
    `INSERT INTO teams (id,department_id,code,name)
     VALUES ($1,$2,$3,$4)`,
    [teamId, departmentId, teamCode, `${teamCode} Team`],
  );
  await pool!.query(
    `INSERT INTO positions (id,organization_id,department_id,code,name)
     VALUES ($1,$2,$3,$4,$5)`,
    [positionId, organizationId, departmentId, `POS_${suffix()}`, 'Technician'],
  );
  return {
    organizationId,
    departmentId,
    departmentCode,
    teamId,
    teamCode,
    positionId,
  };
}

async function insertWorkforce(
  hierarchy: Hierarchy,
  code: string,
  workforceType: 'INTERNAL' | 'OUTSOURCED' | 'CONTRACT',
  status: 'ACTIVE' | 'INACTIVE',
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO workforce_profiles
       (id,organization_id,department_id,team_id,position_id,employee_code,
        full_name,workforce_type,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      hierarchy.organizationId,
      hierarchy.departmentId,
      hierarchy.teamId,
      hierarchy.positionId,
      `${code}_${suffix()}`,
      `Workforce ${code}`,
      workforceType,
      status,
    ],
  );
  return id;
}

async function assignWorkforce(
  workforceProfileId: string,
  buildingId: string,
): Promise<void> {
  await pool!.query(
    `INSERT INTO workforce_building_assignments
       (id,workforce_profile_id,building_id,status)
     VALUES ($1,$2,$3,'ACTIVE')`,
    [randomUUID(), workforceProfileId, buildingId],
  );
}

async function insertTask(
  clientId: string,
  buildingId: string,
  workforceId: string,
  date: string,
  hour: number,
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED',
  measuredHours?: number | null,
): Promise<void> {
  const scheduleId = randomUUID();
  const taskId = randomUUID();
  const startAt = `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const completedAt =
    status === 'COMPLETED'
      ? `${date}T${String(hour + (measuredHours ?? 1)).padStart(2, '0')}:00:00.000Z`
      : null;
  const startedAt =
    status === 'IN_PROGRESS' ||
    (status === 'COMPLETED' && measuredHours !== null)
      ? startAt
      : null;

  await pool!.query(
    `INSERT INTO schedule_definitions
       (id,client_id,code,name,target_type,target_id,building_id,start_at,timezone)
     VALUES ($1,$2,$3,'Schedule','CHECKLIST_TEMPLATE',$4,$5,$6,'UTC')`,
    [scheduleId, clientId, `SCH_${suffix()}`, randomUUID(), buildingId, startAt],
  );
  await pool!.query(
    `INSERT INTO generated_tasks
       (id,client_id,schedule_definition_id,occurrence_at,target_type,target_id,
        building_id,status,started_at,completed_at)
     VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,$8,$9)`,
    [
      taskId,
      clientId,
      scheduleId,
      startAt,
      randomUUID(),
      buildingId,
      status,
      startedAt,
      completedAt,
    ],
  );
  await pool!.query(
    `INSERT INTO task_assignments
       (id,task_id,assignee_type,workforce_profile_id,assigned_by_user_id)
     VALUES ($1,$2,'WORKFORCE',$3,$4)`,
    [randomUUID(), taskId, workforceId, managerUserId],
  );
}

describe('BE-24 PART 04A — Management Workforce Summary', () => {
  it('documents the endpoint and delegates PART 01 / BE-23G filters', () => {
    const parsed = parseManagementWorkforceSummaryQuery({
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
    assert.ok(spec.paths?.['/management/workforce-summary']);
    assert.ok(spec.components?.schemas?.ManagementWorkforceSummary);
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

  it('returns BE-23G workforce, assignment, overdue, and man-hour values', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.data, {
      totalWorkforce: 4,
      activeWorkforce: 3,
      assignedWorkforce: 3,
      byDepartment: [
        {
          departmentId: fixture!.engineering.departmentId,
          departmentCode: 'ENG',
          departmentName: 'ENG Department',
          totalWorkforce: 2,
          activeWorkforce: 2,
        },
        {
          departmentId: fixture!.operations.departmentId,
          departmentCode: 'OPS',
          departmentName: 'OPS Department',
          totalWorkforce: 1,
          activeWorkforce: 0,
        },
        {
          departmentId: fixture!.security.departmentId,
          departmentCode: 'SEC',
          departmentName: 'SEC Department',
          totalWorkforce: 1,
          activeWorkforce: 1,
        },
      ],
      byTeam: [
        {
          teamId: fixture!.engineering.teamId,
          teamCode: 'ALPHA',
          teamName: 'ALPHA Team',
          departmentId: fixture!.engineering.departmentId,
          departmentCode: 'ENG',
          departmentName: 'ENG Department',
          totalWorkforce: 2,
          activeWorkforce: 2,
        },
        {
          teamId: fixture!.operations.teamId,
          teamCode: 'BETA',
          teamName: 'BETA Team',
          departmentId: fixture!.operations.departmentId,
          departmentCode: 'OPS',
          departmentName: 'OPS Department',
          totalWorkforce: 1,
          activeWorkforce: 0,
        },
        {
          teamId: fixture!.security.teamId,
          teamCode: 'GUARD',
          teamName: 'GUARD Team',
          departmentId: fixture!.security.departmentId,
          departmentCode: 'SEC',
          departmentName: 'SEC Department',
          totalWorkforce: 1,
          activeWorkforce: 1,
        },
      ],
      assignments: { scheduled: 5, completed: 3, overdue: 2 },
      manHours: {
        totalHours: 3,
        measuredAssignments: 2,
        unmeasuredAssignments: 1,
        averageHoursPerAssignment: 1.5,
        averageHoursPerWorkforce: 1,
      },
    });
  });

  it('supports Client, single, and explicit multi-Building scope without double-counting', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.totalWorkforce, 3);
    assert.equal(single.body.data.data.assignedWorkforce, 1);
    assert.deepEqual(single.body.data.data.assignments, {
      scheduled: 2,
      completed: 1,
      overdue: 1,
    });

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.totalWorkforce, 3);
    assert.equal(client.body.data.data.assignedWorkforce, 2);

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
    assert.equal(multi.body.data.data.totalWorkforce, 4);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies BE-23G period and grace semantics without changing headcount', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const period = await api()
      .get(PATH)
      .query({ dateFrom: f.operationalDate, dateTo: f.operationalDate })
      .set(auth());
    assert.equal(period.status, 200, JSON.stringify(period.body));
    assert.equal(period.body.data.data.totalWorkforce, 4);
    assert.equal(period.body.data.data.assignments.scheduled, 5);

    const emptyPeriod = await api()
      .get(PATH)
      .query({ dateFrom: f.nextDate, dateTo: f.nextDate })
      .set(auth());
    assert.equal(emptyPeriod.status, 200, JSON.stringify(emptyPeriod.body));
    assert.equal(emptyPeriod.body.data.data.totalWorkforce, 4);
    assert.deepEqual(emptyPeriod.body.data.data.assignments, {
      scheduled: 0,
      completed: 0,
      overdue: 0,
    });

    const grace = await api()
      .get(PATH)
      .query({ graceMinutes: 10080 })
      .set(auth());
    assert.equal(grace.status, 200, JSON.stringify(grace.body));
    assert.equal(grace.body.data.data.assignments.overdue, 0);
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.equal(response.body.data.data.totalWorkforce, 0);
    assert.equal(response.body.data.data.activeWorkforce, 0);
    assert.equal(response.body.data.data.assignedWorkforce, 0);
    assert.deepEqual(response.body.data.data.byDepartment, []);
    assert.deepEqual(response.body.data.data.byTeam, []);
    assert.deepEqual(response.body.data.data.assignments, {
      scheduled: 0,
      completed: 0,
      overdue: 0,
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
