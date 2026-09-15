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
import { parseManagementTenantServiceSummaryQuery } from '../src/modules/management-tenant-service-summary';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 04C focused tests — Tenant Service Summary only. */

const PATH = '/api/v1/management/tenant-service-summary';
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

  const tenantA = await insertTenant(scopeA.client.id, 'A');
  const tenantB = await insertTenant(scopeB.client.id, 'B');
  const tenantHidden = await insertTenant(hidden.client.id, 'H');

  const oldDate = new Date(Date.now() - 10 * 86400000)
    .toISOString()
    .slice(0, 10);
  const recentDate = new Date(Date.now() - 86400000)
    .toISOString()
    .slice(0, 10);
  const oldAt = `${oldDate}T09:00:00.000Z`;
  const recentAt = `${recentDate}T09:00:00.000Z`;

  await insertServiceRequest(scopeA, tenantA, 'OPEN', oldAt);
  await insertServiceRequest(scopeA, tenantA, 'OPEN', recentAt);
  await insertServiceRequest(scopeA, tenantA, 'CONVERTED', oldAt, 'IN_PROGRESS');
  await insertServiceRequest(scopeA, tenantA, 'CONVERTED', recentAt, 'ON_HOLD');
  await insertServiceRequest(scopeA, tenantA, 'CONVERTED', oldAt, 'COMPLETED');
  await insertServiceRequest(scopeA, tenantA, 'CANCELLED', oldAt);

  await insertServiceRequest(
    { ...scopeA, building: scopeA.secondBuilding! },
    tenantA,
    'CONVERTED',
    recentAt,
    'CLOSED',
  );
  await insertServiceRequest(
    { ...scopeA, building: scopeA.secondBuilding! },
    tenantA,
    'CONVERTED',
    oldAt,
    'OPEN',
  );

  await insertServiceRequest(scopeB, tenantB, 'OPEN', oldAt);
  await insertServiceRequest(scopeB, tenantB, 'CONVERTED', recentAt, 'IN_PROGRESS');
  await insertServiceRequest(scopeB, tenantB, 'CONVERTED', recentAt, 'COMPLETED');
  await insertServiceRequest(scopeB, tenantB, 'CANCELLED', recentAt);
  await insertServiceRequest(hidden, tenantHidden, 'OPEN', oldAt);

  await insertComplaint(scopeA, tenantA, 'OPEN', oldAt);
  await insertComplaint(scopeA, tenantA, 'ESCALATED', recentAt);
  await insertComplaint(scopeA, tenantA, 'CANCELLED', recentAt);
  await insertComplaint(
    { ...scopeA, building: scopeA.secondBuilding! },
    tenantA,
    'OPEN',
    recentAt,
  );
  await insertComplaint(scopeB, tenantB, 'OPEN', oldAt);
  await insertComplaint(scopeB, tenantB, 'ESCALATED', recentAt);
  await insertComplaint(hidden, tenantHidden, 'OPEN', oldAt);

  return { scopeA, scopeB, hidden, recentDate };
}

async function createBuildingScope(label: string, withSecond: boolean) {
  const client = await clientService.createClient({
    code: `TS_${label}_${suffix()}`,
    name: `Tenant Service Client ${label}`,
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
type Tenant = { companyId: string; picId: string };

async function insertTenant(clientId: string, label: string): Promise<Tenant> {
  const companyId = randomUUID();
  const picId = randomUUID();
  await pool!.query(
    `INSERT INTO tenant_companies (id,client_id,tenant_code,tenant_name)
     VALUES ($1,$2,$3,$4)`,
    [companyId, clientId, `TEN_${label}_${suffix()}`, `Tenant ${label}`],
  );
  await pool!.query(
    `INSERT INTO tenant_pics (id,tenant_company_id,pic_name,is_primary)
     VALUES ($1,$2,$3,TRUE)`,
    [picId, companyId, `PIC ${label}`],
  );
  return { companyId, picId };
}

async function insertServiceRequest(
  scope: Scope,
  tenant: Tenant,
  status: 'OPEN' | 'CANCELLED' | 'CONVERTED',
  requestedAt: string,
  workOrderStatus?:
    | 'OPEN'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'ON_HOLD'
    | 'COMPLETED'
    | 'CLOSED',
): Promise<void> {
  const requestId = randomUUID();
  let workRequestId: string | null = null;
  let workOrderId: string | null = null;

  if (status === 'CONVERTED') {
    workRequestId = randomUUID();
    await pool!.query(
      `INSERT INTO work_requests
         (id,client_id,building_id,request_number,title,request_type,
          requested_by_user_id,requested_at,status,created_at)
       VALUES ($1,$2,$3,$4,'Work request','TENANT_SERVICE',$5,$6,
               'CONVERTED',$6)`,
      [
        workRequestId,
        scope.client.id,
        scope.building.id,
        `WR_${suffix()}`,
        managerUserId,
        requestedAt,
      ],
    );
    workOrderId = randomUUID();
    await pool!.query(
      `INSERT INTO work_orders
         (id,client_id,building_id,work_order_number,work_request_id,title,
          work_type,status,created_by_user_id,completed_at,closed_at,created_at)
       VALUES ($1,$2,$3,$4,$5,'Tenant Work Order','TENANT_SERVICE',$6,$7,$8,$9,$10)`,
      [
        workOrderId,
        scope.client.id,
        scope.building.id,
        `WO_${suffix()}`,
        workRequestId,
        workOrderStatus ?? 'OPEN',
        managerUserId,
        workOrderStatus === 'COMPLETED' || workOrderStatus === 'CLOSED'
          ? requestedAt
          : null,
        workOrderStatus === 'CLOSED' ? requestedAt : null,
        requestedAt,
      ],
    );
  }

  await pool!.query(
    `INSERT INTO tenant_service_requests
       (id,client_id,tenant_company_id,tenant_pic_id,building_id,
        request_number,request_type,title,status,requested_at,work_request_id,
        work_order_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'GENERAL','Tenant Service',$7,$8,$9,$10,$8)`,
    [
      requestId,
      scope.client.id,
      tenant.companyId,
      tenant.picId,
      scope.building.id,
      `TSR_${suffix()}`,
      status,
      requestedAt,
      workRequestId,
      workOrderId,
    ],
  );
}

async function insertComplaint(
  scope: Scope,
  tenant: Tenant,
  status: 'OPEN' | 'ESCALATED' | 'CANCELLED',
  reportedAt: string,
): Promise<void> {
  let findingId: string | null = null;
  if (status === 'ESCALATED') {
    findingId = randomUUID();
    await pool!.query(
      `INSERT INTO findings
         (id,client_id,building_id,finding_number,title,status,
          reported_by_user_id,reported_at,state_changed_at,created_at)
       VALUES ($1,$2,$3,$4,'Tenant complaint finding','OPEN',$5,$6,$6,$6)`,
      [
        findingId,
        scope.client.id,
        scope.building.id,
        `FND_${suffix()}`,
        managerUserId,
        reportedAt,
      ],
    );
  }
  await pool!.query(
    `INSERT INTO tenant_complaints
       (id,client_id,tenant_company_id,tenant_pic_id,building_id,
        complaint_number,complaint_type,title,severity,status,reported_at,
        finding_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'GENERAL','Complaint','MEDIUM',$7,$8,$9,$8)`,
    [
      randomUUID(),
      scope.client.id,
      tenant.companyId,
      tenant.picId,
      scope.building.id,
      `CMP_${suffix()}`,
      status,
      reportedAt,
      findingId,
    ],
  );
}

describe('BE-24 PART 04C — Management Tenant Service Summary', () => {
  it('documents the endpoint and delegates PART 01 / BE-23H filters', () => {
    const parsed = parseManagementTenantServiceSummaryQuery({
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
    assert.ok(spec.paths?.['/management/tenant-service-summary']);
    assert.ok(spec.components?.schemas?.ManagementTenantServiceSummary);
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

  it('returns BE-23H request values plus authoritative progress, overdue and complaint summaries', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.data, {
      totalRequests: 12,
      openRequests: 3,
      inProgressRequests: 3,
      completedRequests: 3,
      overdueRequests: 4,
      complaints: { total: 6, open: 3, escalated: 2, cancelled: 1 },
      completionRate: 30,
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
      totalRequests: 6,
      openRequests: 2,
      inProgressRequests: 2,
      completedRequests: 1,
      overdueRequests: 2,
      complaints: { total: 3, open: 1, escalated: 1, cancelled: 1 },
      completionRate: 20,
    });

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.totalRequests, 8);
    assert.equal(client.body.data.data.completedRequests, 2);
    assert.equal(client.body.data.data.overdueRequests, 3);
    assert.equal(client.body.data.data.completionRate, 28.57);

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
    assert.equal(multi.body.data.data.totalRequests, 12);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies BE-23H period and explicit overdue-age semantics', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const period = await api()
      .get(PATH)
      .query({ dateFrom: f.recentDate, dateTo: f.recentDate })
      .set(auth());
    assert.equal(period.status, 200, JSON.stringify(period.body));
    assert.deepEqual(period.body.data.data, {
      totalRequests: 6,
      openRequests: 1,
      inProgressRequests: 2,
      completedRequests: 2,
      overdueRequests: 0,
      complaints: { total: 4, open: 1, escalated: 2, cancelled: 1 },
      completionRate: 40,
    });

    const age = await api()
      .get(PATH)
      .query({ overdueAfterDays: 20 })
      .set(auth());
    assert.equal(age.status, 200, JSON.stringify(age.body));
    assert.equal(age.body.data.data.overdueRequests, 0);
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      totalRequests: 0,
      openRequests: 0,
      inProgressRequests: 0,
      completedRequests: 0,
      overdueRequests: 0,
      complaints: { total: 0, open: 0, escalated: 0, cancelled: 0 },
      completionRate: 0,
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
