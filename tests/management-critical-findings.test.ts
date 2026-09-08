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
import {
  MANAGEMENT_CRITICAL_SEVERITY_RULE,
  parseManagementCriticalFindingsQuery,
} from '../src/modules/management-critical-findings';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 03B focused tests — Critical Findings only. */

const PATH = '/api/v1/management/critical-findings';
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

  const severityA = await insertSeverities(scopeA.client.id, [
    ['LOW', 1, 'ACTIVE'],
    ['HIGH', 3, 'ACTIVE'],
    ['CLIENT_A_CRITICAL', 5, 'ACTIVE'],
    ['INACTIVE_EMERGENCY', 9, 'INACTIVE'],
  ]);
  const severityB = await insertSeverities(scopeB.client.id, [
    ['MAJOR', 2, 'ACTIVE'],
    ['SEVERE', 4, 'ACTIVE'],
  ]);
  const severityHidden = await insertSeverities(hidden.client.id, [
    ['HIDDEN_CRITICAL', 8, 'ACTIVE'],
  ]);

  const teamA = await insertTeam(scopeA.client.id, 'A');
  const teamB = await insertTeam(scopeB.client.id, 'B');

  const aOld = await insertFinding({
    scope: scopeA,
    severityId: severityA.CLIENT_A_CRITICAL,
    status: 'OPEN',
    reportedAt: oldAt,
    sourceType: 'WORK_ORDER',
    context: 'ENGINEERING',
  });
  await assignTeam(aOld, teamA, oldAt);

  const aRecent = await insertFinding({
    scope: scopeA,
    severityId: severityA.CLIENT_A_CRITICAL,
    status: 'IN_PROGRESS',
    reportedAt: recentAt,
    sourceType: null,
    context: 'SECURITY',
  });
  await insertFinding({
    scope: scopeA,
    severityId: severityA.HIGH,
    status: 'OPEN',
    reportedAt: oldAt,
    sourceType: null,
    context: 'GENERAL',
  });
  await insertFinding({
    scope: scopeA,
    severityId: severityA.CLIENT_A_CRITICAL,
    status: 'CLOSED',
    reportedAt: oldAt,
    sourceType: null,
    context: 'GENERAL',
  });
  await insertFinding({
    scope: scopeA,
    severityId: severityA.CLIENT_A_CRITICAL,
    status: 'VERIFIED',
    reportedAt: oldAt,
    sourceType: null,
    context: 'GENERAL',
  });

  const bOld = await insertFinding({
    scope: scopeB,
    severityId: severityB.SEVERE,
    status: 'ASSIGNED',
    reportedAt: oldAt,
    sourceType: 'CHECKLIST_EXECUTION',
    context: 'GENERAL',
  });
  await assignTeam(bOld, teamB, oldAt);
  await insertFinding({
    scope: scopeB,
    severityId: severityB.SEVERE,
    status: 'PENDING_REVIEW',
    reportedAt: recentAt,
    sourceType: null,
    context: 'GENERAL',
  });
  await insertFinding({
    scope: scopeB,
    severityId: severityB.MAJOR,
    status: 'OPEN',
    reportedAt: oldAt,
    sourceType: null,
    context: 'GENERAL',
  });

  await insertFinding({
    scope: hidden,
    severityId: severityHidden.HIDDEN_CRITICAL,
    status: 'OPEN',
    reportedAt: oldAt,
    sourceType: null,
    context: 'GENERAL',
  });

  return { scopeA, scopeB, hidden, recentDate, aOld, aRecent, bOld, teamA, teamB };
}

async function createBuildingScope(label: string) {
  const client = await clientService.createClient({
    code: `CF_${label}_${suffix()}`,
    name: `Critical Finding Client ${label}`,
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

async function insertSeverities(
  clientId: string,
  values: Array<[string, number, 'ACTIVE' | 'INACTIVE']>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [code, rank, status] of values) {
    const id = randomUUID();
    result[code] = id;
    await pool!.query(
      `INSERT INTO finding_severities (id,client_id,code,name,rank,status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, clientId, code, `${code} severity`, rank, status],
    );
  }
  return result;
}

async function insertTeam(clientId: string, label: string): Promise<string> {
  const organizationId = randomUUID();
  const departmentId = randomUUID();
  const teamId = randomUUID();
  await pool!.query(
    `INSERT INTO organizations (id,client_id,code,name)
     VALUES ($1,$2,$3,$4)`,
    [organizationId, clientId, `ORG_${label}_${suffix()}`, `Org ${label}`],
  );
  await pool!.query(
    `INSERT INTO departments (id,organization_id,code,name)
     VALUES ($1,$2,$3,$4)`,
    [departmentId, organizationId, `DEP_${label}_${suffix()}`, `Dept ${label}`],
  );
  await pool!.query(
    `INSERT INTO teams (id,department_id,code,name)
     VALUES ($1,$2,$3,$4)`,
    [teamId, departmentId, `TEAM_${label}_${suffix()}`, `Team ${label}`],
  );
  return teamId;
}

async function insertFinding(input: {
  scope: Scope;
  severityId: string;
  status: string;
  reportedAt: string;
  sourceType: 'WORK_ORDER' | 'CHECKLIST_EXECUTION' | null;
  context: 'ENGINEERING' | 'SECURITY' | 'GENERAL';
}): Promise<string> {
  const id = randomUUID();
  const sourceId = input.sourceType ? randomUUID() : null;
  await pool!.query(
    `INSERT INTO findings
       (id,client_id,building_id,finding_number,title,severity_id,source_type,
        source_id,status,state_changed_at,reported_by_user_id,reported_at,
        closed_at,closed_by_user_id,closure_notes,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$12,$13,$14,$10)`,
    [
      id,
      input.scope.client.id,
      input.scope.building.id,
      `FND_${suffix()}`,
      `${input.status} critical finding`,
      input.severityId,
      input.sourceType,
      sourceId,
      input.status,
      input.reportedAt,
      managerUserId,
      input.status === 'CLOSED' ? input.reportedAt : null,
      input.status === 'CLOSED' ? managerUserId : null,
      input.status === 'CLOSED' ? 'Closed in fixture' : null,
    ],
  );

  if (input.context === 'ENGINEERING') {
    await pool!.query(
      `INSERT INTO engineering_finding_links
         (id,client_id,building_id,finding_id,operation_type,source_type,
          source_id,created_by_user_id)
       VALUES ($1,$2,$3,$4,'BREAKDOWN','WORK_ORDER',$5,$6)`,
      [
        randomUUID(),
        input.scope.client.id,
        input.scope.building.id,
        id,
        sourceId ?? randomUUID(),
        managerUserId,
      ],
    );
  }
  if (input.context === 'SECURITY') {
    await pool!.query(
      `INSERT INTO security_finding_links
         (id,client_id,building_id,finding_id,source_type,source_id,
          created_by_user_id)
       VALUES ($1,$2,$3,$4,'SECURITY_DAILY_ACTIVITY',$5,$6)`,
      [
        randomUUID(),
        input.scope.client.id,
        input.scope.building.id,
        id,
        randomUUID(),
        managerUserId,
      ],
    );
  }
  return id;
}

async function assignTeam(
  findingId: string,
  teamId: string,
  assignedAt: string,
): Promise<void> {
  await pool!.query(
    `INSERT INTO finding_assignments
       (id,finding_id,assignee_type,team_id,assigned_by_user_id,assigned_at)
     VALUES ($1,$2,'TEAM',$3,$4,$5)`,
    [randomUUID(), findingId, teamId, managerUserId, assignedAt],
  );
}

describe('BE-24 PART 03B — Management Critical Findings', () => {
  it('documents the endpoint and freezes non-hardcoded severity semantics', () => {
    const parsed = parseManagementCriticalFindingsQuery({
      overdueAfterDays: '12',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
    });
    assert.equal(parsed.overdueAfterDays, 12);
    assert.equal(parsed.scope.dateFrom, '2026-08-01');
    assert.equal(
      MANAGEMENT_CRITICAL_SEVERITY_RULE,
      'HIGHEST_ACTIVE_RANK_PER_CLIENT',
    );

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/critical-findings']);
    assert.ok(spec.components?.schemas?.ManagementCriticalFindings);
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

  it('returns configured critical Findings with source, context, status, responsibility and overdue state', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body.data;
    assert.equal(result.filters.criticalSeverityRule, MANAGEMENT_CRITICAL_SEVERITY_RULE);
    assert.equal(result.filters.overdueAfterDays, 7);
    assert.equal(result.data.criticalFindingCount, 4);
    assert.equal(result.data.items.filter((item: any) => item.overdue).length, 2);
    assert.ok(result.data.items.every((item: any) =>
      !['CLOSED', 'CANCELLED', 'VERIFIED'].includes(item.status),
    ));

    const engineering = result.data.items.find(
      (item: any) => item.findingId === fixture!.aOld,
    );
    assert.equal(engineering.context.type, 'ENGINEERING');
    assert.equal(engineering.source.type, 'WORK_ORDER');
    assert.equal(engineering.severity.code, 'CLIENT_A_CRITICAL');
    assert.deepEqual(engineering.responsibleParty, {
      type: 'TEAM',
      workforceProfileId: null,
      teamId: fixture!.teamA,
      vendorId: null,
    });

    const security = result.data.items.find(
      (item: any) => item.findingId === fixture!.aRecent,
    );
    assert.equal(security.context.type, 'SECURITY');
    assert.equal(security.source.type, 'SECURITY_DAILY_ACTIVITY');
    assert.equal(security.responsibleParty, null);
  });

  it('supports Client, single, and explicit multi-Building scope without leakage', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.criticalFindingCount, 2);

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeB.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.criticalFindingCount, 2);
    assert.ok(client.body.data.data.items.some(
      (item: any) => item.severity.code === 'SEVERE',
    ));

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [f.scopeA.building.id, f.scopeB.building.id],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.criticalFindingCount, 4);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies the shared period and explicit reporting-age threshold', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const recent = await api()
      .get(PATH)
      .query({ dateFrom: f.recentDate, dateTo: f.recentDate })
      .set(auth());
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    assert.equal(recent.body.data.data.criticalFindingCount, 2);
    assert.ok(recent.body.data.data.items.every((item: any) => !item.overdue));

    const age = await api()
      .get(PATH)
      .query({ overdueAfterDays: 20 })
      .set(auth());
    assert.equal(age.status, 200, JSON.stringify(age.body));
    assert.ok(age.body.data.data.items.every((item: any) => !item.overdue));
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      criticalFindingCount: 0,
      items: [],
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
