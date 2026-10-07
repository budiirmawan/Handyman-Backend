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
import { parseManagementPendingApprovalQuery } from '../src/modules/management-pending-approval';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 03A focused tests — Pending Approval only. */

const PATH = '/api/v1/management/pending-approvals';
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

  const recentDate = new Date(Date.now() - 86400000)
    .toISOString()
    .slice(0, 10);
  const oldDate = new Date(Date.now() - 10 * 86400000)
    .toISOString()
    .slice(0, 10);
  const recentAt = `${recentDate}T12:00:00.000Z`;
  const oldAt = `${oldDate}T12:00:00.000Z`;

  await insertPermitApproval(scopeA, recentAt);
  await insertProcurementApproval(scopeA, recentAt);
  await insertTenantApproval(scopeA, recentAt);
  await insertDocumentApproval(scopeA, recentAt, false);
  await insertDocumentApproval(scopeA, oldAt, true);

  await insertProcurementApproval(scopeB, recentAt);
  await insertTenantApproval(scopeB, recentAt);
  await insertDocumentApproval(scopeB, recentAt, false);

  await insertProcurementApproval(hidden, recentAt);
  await insertDocumentApproval(hidden, recentAt, false);
  await insertProcurementApproval(scopeA, recentAt, 'APPROVED');

  return { scopeA, scopeB, hidden, recentDate };
}

async function createBuildingScope(label: string) {
  const client = await clientService.createClient({
    code: `PA_${label}_${suffix()}`,
    name: `Pending Approval Client ${label}`,
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

async function insertProcurementApproval(
  scope: Scope,
  createdAt: string,
  status: 'PENDING' | 'APPROVED' = 'PENDING',
): Promise<string> {
  const requestId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_requests
       (id,client_id,building_id,request_number,request_type,title,status,
        requested_by_user_id,requested_at,created_at)
     VALUES ($1,$2,$3,$4,'GENERAL','Purchase request','OPEN',$5,$6,$6)`,
    [
      requestId,
      scope.client.id,
      scope.building.id,
      `PR_${suffix()}`,
      managerUserId,
      createdAt,
    ],
  );
  const approvalId = randomUUID();
  await pool!.query(
    `INSERT INTO procurement_approval_bindings
       (id,client_id,building_id,request_type,purchase_request_id,
        approval_type,approver_user_id,status,decided_at,
        created_by_user_id,created_at)
     VALUES ($1,$2,$3,'PURCHASE_REQUEST',$4,'BUDGET',$5,$6,$7,$5,$8)`,
    [
      approvalId,
      scope.client.id,
      scope.building.id,
      requestId,
      managerUserId,
      status,
      status === 'APPROVED' ? createdAt : null,
      createdAt,
    ],
  );
  return approvalId;
}

async function insertTenantApproval(
  scope: Scope,
  createdAt: string,
): Promise<string> {
  const companyId = randomUUID();
  const picId = randomUUID();
  const requestId = randomUUID();
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
        request_number,request_type,title,status,requested_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'GENERAL','Tenant request','OPEN',$7,$7)`,
    [
      requestId,
      scope.client.id,
      companyId,
      picId,
      scope.building.id,
      `TSR_${suffix()}`,
      createdAt,
    ],
  );
  const approvalId = randomUUID();
  await pool!.query(
    `INSERT INTO tenant_approval_bindings
       (id,client_id,tenant_company_id,building_id,request_type,
        service_request_id,approval_type,approver_user_id,created_by_user_id,
        created_at)
     VALUES ($1,$2,$3,$4,'SERVICE_REQUEST',$5,'SERVICE',$6,$6,$7)`,
    [
      approvalId,
      scope.client.id,
      companyId,
      scope.building.id,
      requestId,
      managerUserId,
      createdAt,
    ],
  );
  return approvalId;
}

async function insertPermitApproval(
  scope: Scope,
  createdAt: string,
): Promise<string> {
  const vendorId = randomUUID();
  const permitId = randomUUID();
  const applicationId = randomUUID();
  const reviewId = randomUUID();
  const approvalId = randomUUID();
  await pool!.query(
    `INSERT INTO vendors (id,client_id,vendor_code,vendor_name)
     VALUES ($1,$2,$3,'Permit Vendor')`,
    [vendorId, scope.client.id, `VEN_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO permits
       (id,client_id,building_id,permit_number,permit_type,title,
        work_description,contractor_context_type,contractor_vendor_id,
        requested_at,created_by_user_id,created_at)
     VALUES ($1,$2,$3,$4,'GENERAL','Permit','Work',
             'VENDOR_CONTRACTOR',$5,$6,$7,$6)`,
    [
      permitId,
      scope.client.id,
      scope.building.id,
      `PTW_${suffix()}`,
      vendorId,
      createdAt,
      managerUserId,
    ],
  );
  await pool!.query(
    `INSERT INTO permit_applications
       (id,permit_id,requested_work_at,status,submitted_at,
        submitted_by_user_id,created_by_user_id,created_at)
     VALUES ($1,$2,$3,'SUBMITTED',$3,$4,$4,$3)`,
    [applicationId, permitId, createdAt, managerUserId],
  );
  await pool!.query(
    `INSERT INTO reviews
       (id,client_id,target_type,target_id,reviewer_user_id,status,created_at)
     VALUES ($1,$2,'PERMIT_APPLICATION',$3,$4,'PENDING',$5)`,
    [reviewId, scope.client.id, applicationId, managerUserId, createdAt],
  );
  await pool!.query(
    `INSERT INTO permit_approval_bindings
       (id,permit_application_id,review_id,approval_stage,approval_type,
        created_by_user_id,created_at)
     VALUES ($1,$2,$3,'FINAL','SAFETY',$4,$5)`,
    [approvalId, applicationId, reviewId, managerUserId, createdAt],
  );
  return approvalId;
}

async function insertDocumentApproval(
  scope: Scope,
  createdAt: string,
  clientLevel: boolean,
): Promise<string> {
  const documentId = randomUUID();
  const approvalId = randomUUID();
  await pool!.query(
    `INSERT INTO documents
       (id,client_id,building_id,document_number,document_type,context_type,
        title,status,created_by_user_id,created_at)
     VALUES ($1,$2,$3,$4,'GENERAL','INTERNAL','Document','ACTIVE',$5,$6)`,
    [
      documentId,
      scope.client.id,
      clientLevel ? null : scope.building.id,
      `DOC_${suffix()}`,
      managerUserId,
      createdAt,
    ],
  );
  await pool!.query(
    `INSERT INTO reviews
       (id,client_id,target_type,target_id,reviewer_user_id,status,created_at)
     VALUES ($1,$2,'DOCUMENT',$3,$4,'PENDING',$5)`,
    [approvalId, scope.client.id, documentId, managerUserId, createdAt],
  );
  return approvalId;
}

describe('BE-24 PART 03A — Management Pending Approval', () => {
  it('documents the endpoint and delegates scope/period parsing to PART 01', () => {
    const parsed = parseManagementPendingApprovalQuery({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
    });
    assert.equal(parsed.scope.dateFrom, '2026-08-01');
    assert.equal(parsed.scope.dateTo, '2026-08-17');

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/pending-approvals']);
    assert.ok(spec.components?.schemas?.ManagementPendingApproval);
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

  it('returns pending count, source references, status, dates, and source actions', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.pendingCount, 8);
    assert.equal(data.items.length, 8);
    assert.ok(data.items.every((item: any) => item.currentStatus === 'PENDING'));
    assert.ok(data.items.every((item: any) => item.resourceId && item.submittedAt));
    assert.deepEqual(
      new Set(data.items.map((item: any) => item.source)),
      new Set(['PERMIT', 'PROCUREMENT', 'TENANT', 'DOCUMENT']),
    );

    const procurement = data.items.find((item: any) => item.source === 'PROCUREMENT');
    const tenant = data.items.find((item: any) => item.source === 'TENANT');
    const permit = data.items.find((item: any) => item.source === 'PERMIT');
    const document = data.items.find((item: any) => item.source === 'DOCUMENT');
    assert.deepEqual(procurement.availableActions, ['APPROVE', 'REJECT']);
    assert.deepEqual(tenant.availableActions, ['APPROVE', 'REJECT']);
    assert.deepEqual(permit.availableActions, ['REJECT', 'REQUEST_REWORK']);
    assert.deepEqual(document.availableActions, []);
  });

  it('supports Building, Client, and explicit multi-Building scope', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.pendingCount, 4);
    assert.ok(single.body.data.data.items.every(
      (item: any) => item.buildingId === f.scopeA.building.id,
    ));

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.pendingCount, 5);
    assert.ok(client.body.data.data.items.some(
      (item: any) => item.source === 'DOCUMENT' && item.buildingId === null,
    ));

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [f.scopeA.building.id, f.scopeB.building.id],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.pendingCount, 7);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies the shared submitted-date period without changing workflow state', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const response = await api()
      .get(PATH)
      .query({ dateFrom: f.recentDate, dateTo: f.recentDate })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.data.pendingCount, 7);
    assert.ok(response.body.data.data.items.every(
      (item: any) => item.submittedAt.startsWith(f.recentDate),
    ));
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, { pendingCount: 0, items: [] });
  });

  it('rejects invalid scope and period filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
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
