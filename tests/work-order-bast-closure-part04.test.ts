import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { vendorService } from '../src/modules/vendors';
import {
  type BastRequirement,
  workOrderService,
} from '../src/modules/work-orders';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55473;
const DIR = '/tmp/asentra-bast-part04-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

type Context = { clientId: string; buildingId: string };
type WorkOrderFixture = Context & { id: string };
type CanonicalStatus = 'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
let outsiderToken = '';
let profileId = '';
let primary: Context;
let isolated: Context;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles CASCADE');

  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  outsiderToken = await createSessionWithPermissions([
    { code: 'work_order.manage', name: 'Manage Work Orders' },
  ]);

  primary = await createContext('PRIMARY', true);
  isolated = await createContext('ISOLATED', false);
  profileId = await createWorkforceProfile(primary.clientId);
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function createContext(prefix: string, assign: boolean): Promise<Context> {
  const client = await clientService.createClient({
    code: `${prefix}_C_${suffix()}`,
    name: `${prefix} Closure Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `${prefix}_P_${suffix()}`,
    name: `${prefix} Closure Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `${prefix}_B_${suffix()}`,
    name: `${prefix} Closure Building`,
  });
  if (assign) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { clientId: client.id, buildingId: building.id };
}

async function createWorkforceProfile(clientId: string): Promise<string> {
  const organizationId = randomUUID();
  const departmentId = randomUUID();
  const positionId = randomUUID();
  const workforceProfileId = randomUUID();
  await pool!.query(
    `INSERT INTO organizations (id, client_id, code, name)
     VALUES ($1,$2,$3,'PART 04 Organization')`,
    [organizationId, clientId, `ORG_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO departments (id, organization_id, code, name)
     VALUES ($1,$2,$3,'PART 04 Department')`,
    [departmentId, organizationId, `DEP_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO positions (id, organization_id, code, name)
     VALUES ($1,$2,$3,'PART 04 Position')`,
    [positionId, organizationId, `POS_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO workforce_profiles
       (id, organization_id, department_id, position_id, user_id,
        employee_code, full_name, workforce_type)
     VALUES ($1,$2,$3,$4,$5,$6,'PART 04 Worker','INTERNAL')`,
    [
      workforceProfileId,
      organizationId,
      departmentId,
      positionId,
      userId,
      `WF_${suffix()}`,
    ],
  );
  return workforceProfileId;
}

async function approveWorkOrder(
  workOrderId: string,
  clientId: string,
  decision: 'APPROVED' | 'REJECTED' | 'REWORK_REQUIRED' = 'APPROVED',
): Promise<string> {
  const reviewId = randomUUID();
  await pool!.query(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id,
        decision, status, reviewed_at)
     VALUES ($1,$2,'WORK_ORDER',$3,$4,$5,'COMPLETED',NOW())`,
    [reviewId, clientId, workOrderId, userId, decision],
  );
  return reviewId;
}

async function createWorkOrder(input: {
  requirement?: BastRequirement;
  status?: 'OPEN' | 'COMPLETED';
  approved?: boolean;
  assigned?: boolean;
  context?: Context;
} = {}): Promise<WorkOrderFixture> {
  const context = input.context ?? primary;
  const requirement = input.requirement ?? 'NONE';
  const status = input.status ?? 'COMPLETED';
  const workOrder = await workOrderService.createWorkOrder({
    clientId: context.clientId,
    buildingId: context.buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'PART 04 closure work',
    workType: 'REPAIR',
    createdByUserId: userId,
  });
  if (requirement !== 'NONE') {
    await workOrderService.updateWorkOrderBastRequirement(
      workOrder.id,
      { bastRequirement: requirement },
      userId,
    );
  }
  if (status === 'COMPLETED') {
    await pool!.query(
      `UPDATE work_orders
       SET status = 'COMPLETED', completed_at = NOW(),
           completed_by_user_id = $2
       WHERE id = $1`,
      [workOrder.id, userId],
    );
  }
  if (input.approved ?? true) {
    await approveWorkOrder(workOrder.id, context.clientId);
  }
  if (input.assigned) {
    await pool!.query(
      `INSERT INTO work_order_assignments
         (id, work_order_id, assignee_type, workforce_profile_id,
          assigned_by_user_id)
       VALUES ($1,$2,'WORKFORCE',$3,$4)`,
      [randomUUID(), workOrder.id, profileId, userId],
    );
  }
  return { id: workOrder.id, ...context };
}

async function createVendorWork(workOrder: WorkOrderFixture): Promise<string> {
  const vendor = await vendorService.createVendor({
    clientId: workOrder.clientId,
    vendorCode: `V_${suffix()}`,
    vendorName: 'PART 04 Vendor',
  });
  const assignmentId = randomUUID();
  const vendorWorkId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_assignments
       (id, vendor_id, work_order_id, building_id, assigned_by_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      assignmentId,
      vendor.id,
      workOrder.id,
      workOrder.buildingId,
      userId,
    ],
  );
  await pool!.query(
    `INSERT INTO vendor_works
       (id, vendor_assignment_id, vendor_id, work_order_id, building_id,
        status, started_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,'COMPLETED',NOW() - INTERVAL '1 day',NOW())`,
    [
      vendorWorkId,
      assignmentId,
      vendor.id,
      workOrder.id,
      workOrder.buildingId,
    ],
  );
  return vendorWorkId;
}

async function createCanonicalBast(input: {
  workOrder: WorkOrderFixture;
  status: CanonicalStatus;
  vendorWorkId?: string;
  context?: Context;
  traceable?: boolean;
}): Promise<{
  bastId: string;
  attemptId: string | null;
  documentVersionId: string;
}> {
  const context = input.context ?? input.workOrder;
  const documentId = randomUUID();
  const versionId = randomUUID();
  const bastId = randomUUID();
  const isVendorScope = input.vendorWorkId !== undefined;
  const contextType = isVendorScope ? 'VENDOR' : 'INTERNAL';
  const vendorId = isVendorScope
    ? (
        await pool!.query<{ vendor_id: string }>(
          'SELECT vendor_id FROM vendor_works WHERE id = $1',
          [input.vendorWorkId],
        )
      ).rows[0].vendor_id
    : null;

  await pool!.query(
    `INSERT INTO documents
       (id, client_id, building_id, document_number, document_type,
        context_type, title, created_by_user_id)
     VALUES ($1,$2,$3,$4,'BAST',$5,'PART 04 canonical BAST',$6)`,
    [
      documentId,
      context.clientId,
      context.buildingId,
      `DOC_${suffix()}`,
      contextType,
      userId,
    ],
  );
  await pool!.query(
    `INSERT INTO document_versions
       (id, document_id, version_number, title, document_type, status,
        created_by_user_id)
     VALUES ($1,$2,1,'PART 04 canonical BAST','BAST','DRAFT',$3)`,
    [versionId, documentId, userId],
  );
  await pool!.query(
    `INSERT INTO bast_documents
       (id, document_id, work_order_id, vendor_work_id, vendor_id,
        acceptance_scope_type, client_id, building_id, context_type,
        bast_number, bast_date, acceptance_status, prepared_by_user_id,
        submitted_by_user_id, accepted_by_user_id, submitted_at, accepted_at)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'2026-08-18',$11,$12::uuid,
        CASE WHEN $11 <> 'DRAFT' THEN $12::uuid ELSE NULL END,
        CASE WHEN $11 IN ('ACCEPTED','REJECTED') THEN $12::uuid ELSE NULL END,
        CASE WHEN $11 <> 'DRAFT' THEN NOW() - INTERVAL '2 minutes' ELSE NULL END,
        CASE WHEN $11 IN ('ACCEPTED','REJECTED') THEN NOW() ELSE NULL END)`,
    [
      bastId,
      documentId,
      input.workOrder.id,
      input.vendorWorkId ?? null,
      vendorId,
      isVendorScope ? 'VENDOR_WORK' : 'WORK_ORDER',
      context.clientId,
      context.buildingId,
      contextType,
      `BAST_${suffix()}`,
      input.status,
      userId,
    ],
  );

  if (input.status === 'DRAFT') {
    return { bastId, attemptId: null, documentVersionId: versionId };
  }

  const attemptId = randomUUID();
  await pool!.query(
    `INSERT INTO bast_submission_attempts
       (id, bast_document_id, attempt_number, document_version_id,
        readiness_snapshot, submitted_by_user_id)
     VALUES ($1,$2,1,$3,'{}'::jsonb,$4)`,
    [attemptId, bastId, versionId, userId],
  );
  if (
    (input.status === 'ACCEPTED' || input.status === 'REJECTED') &&
    input.traceable !== false
  ) {
    await pool!.query(
      `INSERT INTO acceptance_sign_offs
         (id, bast_document_id, client_id, building_id, context_type,
          decision, signer_user_id, bast_submission_attempt_id,
          document_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        bastId,
        context.clientId,
        context.buildingId,
        contextType,
        input.status,
        userId,
        attemptId,
        versionId,
      ],
    );
  }
  return { bastId, attemptId, documentVersionId: versionId };
}

async function closeVia(workOrderId: string, authToken = token) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/close`)
    .set(auth(authToken))
    .send({});
}

async function statusOf(workOrderId: string): Promise<string> {
  return (
    await pool!.query<{ status: string }>(
      'SELECT status FROM work_orders WHERE id = $1',
      [workOrderId],
    )
  ).rows[0].status;
}

async function assertBastBlocked(
  response: Awaited<ReturnType<typeof closeVia>>,
  workOrderId: string,
  blocker: string,
): Promise<void> {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error.code, 'WORK_ORDER_CLOSE_BAST_NOT_READY');
  assert.ok(
    response.body.error.details.some(
      (detail: { message?: string }) => detail.message === blocker,
    ),
    JSON.stringify(response.body.error.details),
  );
  assert.equal(await statusOf(workOrderId), 'COMPLETED');
  const events = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM operational_events
     WHERE entity_type = 'WORK_ORDER' AND entity_id = $1
       AND event_type = 'WORK_ORDER_CLOSED'`,
    [workOrderId],
  );
  assert.equal(events.rows[0].count, 0);
}

async function mobileActions(workOrderId: string): Promise<string[]> {
  const response = await api().get('/api/v1/mobile/assignments').set(auth());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const item = response.body.data.find(
    (candidate: { reference: { workOrderId?: string } }) =>
      candidate.reference.workOrderId === workOrderId,
  );
  assert.ok(item, `Work Order ${workOrderId} was not in the mobile feed`);
  return item.availableActions as string[];
}

describe('CR-BE-BAST-01 PART 04 — Work Order closure and BAST cardinality', () => {
  it('1. NONE does not require a BAST', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder();
    const response = await closeVia(workOrder.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.status, 'CLOSED');
  });

  it('2. WORK_ORDER without a BAST is blocked, including exact-one cardinality', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({
      requirement: 'WORK_ORDER',
      assigned: true,
    });

    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'REQUIRED_BAST_MISSING',
    );
    assert.ok(!(await mobileActions(workOrder.id)).includes('CLOSE'));

    await createCanonicalBast({ workOrder, status: 'ACCEPTED' });
    await createCanonicalBast({ workOrder, status: 'ACCEPTED' });
    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'REQUIRED_BAST_CARDINALITY_VIOLATION',
    );
  });

  it('3. WORK_ORDER with a SUBMITTED BAST is blocked', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({ requirement: 'WORK_ORDER' });
    await createCanonicalBast({ workOrder, status: 'SUBMITTED' });
    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'REQUIRED_BAST_NOT_ACCEPTED',
    );
  });

  it('4. WORK_ORDER with a REJECTED BAST is blocked', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({ requirement: 'WORK_ORDER' });
    await createCanonicalBast({ workOrder, status: 'REJECTED' });
    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'REQUIRED_BAST_NOT_ACCEPTED',
    );
  });

  it('5. WORK_ORDER with one accepted traceable BAST can close and exposes CLOSE', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({
      requirement: 'WORK_ORDER',
      assigned: true,
    });
    const accepted = await createCanonicalBast({
      workOrder,
      status: 'ACCEPTED',
      traceable: false,
    });
    assert.ok(!(await mobileActions(workOrder.id)).includes('CLOSE'));
    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'ACCEPTANCE_NOT_TRACEABLE',
    );

    await pool!.query(
      `INSERT INTO acceptance_sign_offs
         (id, bast_document_id, client_id, building_id, context_type,
          decision, signer_user_id, bast_submission_attempt_id,
          document_version_id)
       VALUES ($1,$2,$3,$4,'INTERNAL','ACCEPTED',$5,$6,$7)`,
      [
        randomUUID(),
        accepted.bastId,
        workOrder.clientId,
        workOrder.buildingId,
        userId,
        accepted.attemptId,
        accepted.documentVersionId,
      ],
    );

    const quarantineId = randomUUID();
    await pool!.query(
      `INSERT INTO bast_reconciliation_quarantines
         (id, bast_document_id, reason_code, source_snapshot,
          created_by_user_id)
       VALUES ($1,$2,'LEGACY_CONTEXT_DIVERGENCE','{}'::jsonb,$3)`,
      [quarantineId, accepted.bastId, userId],
    );
    assert.ok(!(await mobileActions(workOrder.id)).includes('CLOSE'));
    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'RECONCILIATION_QUARANTINED',
    );
    await pool!.query(
      `UPDATE bast_reconciliation_quarantines
       SET status = 'RESOLVED', resolved_by_user_id = $2,
           resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [quarantineId, userId],
    );

    assert.ok((await mobileActions(workOrder.id)).includes('CLOSE'));
    const response = await closeVia(workOrder.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.status, 'CLOSED');
    assert.ok(!(await mobileActions(workOrder.id)).includes('CLOSE'));
  });

  it('6. EACH_VENDOR_WORK with incomplete accepted coverage is blocked', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({
      requirement: 'EACH_VENDOR_WORK',
    });
    const coveredVendorWorkId = await createVendorWork(workOrder);
    const missingVendorWorkId = await createVendorWork(workOrder);
    await createCanonicalBast({
      workOrder,
      vendorWorkId: coveredVendorWorkId,
      status: 'ACCEPTED',
    });

    const response = await closeVia(workOrder.id);
    await assertBastBlocked(response, workOrder.id, 'REQUIRED_BAST_MISSING');
    assert.ok(
      response.body.error.details.some(
        (detail: { vendorWorkId?: string }) =>
          detail.vendorWorkId === missingVendorWorkId,
      ),
    );
  });

  it('7. EACH_VENDOR_WORK with all accepted coverage closes after rework is resolved', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({
      requirement: 'EACH_VENDOR_WORK',
    });
    const firstVendorWorkId = await createVendorWork(workOrder);
    const secondVendorWorkId = await createVendorWork(workOrder);
    await createCanonicalBast({
      workOrder,
      vendorWorkId: firstVendorWorkId,
      status: 'ACCEPTED',
    });
    await createCanonicalBast({
      workOrder,
      vendorWorkId: secondVendorWorkId,
      status: 'ACCEPTED',
    });

    const reviewId = randomUUID();
    const reworkId = randomUUID();
    await pool!.query(
      `INSERT INTO reviews
         (id, client_id, target_type, target_id, reviewer_user_id,
          decision, status, reviewed_at)
       VALUES ($1,$2,'VENDOR_WORK',$3,$4,'REWORK_REQUIRED','COMPLETED',NOW())`,
      [reviewId, workOrder.clientId, secondVendorWorkId, userId],
    );
    await pool!.query(
      `INSERT INTO vendor_rework_cycles
         (id, vendor_work_id, review_id, requested_by_user_id, reason)
       VALUES ($1,$2,$3,$4,'Correct vendor work before closure')`,
      [reworkId, secondVendorWorkId, reviewId, userId],
    );
    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'UNRESOLVED_VENDOR_REWORK',
    );

    await pool!.query(
      `UPDATE vendor_rework_cycles
       SET status = 'RESUBMITTED', resubmitted_by_user_id = $2,
           resubmitted_at = NOW()
       WHERE id = $1`,
      [reworkId, userId],
    );
    const response = await closeVia(workOrder.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.status, 'CLOSED');
  });

  it('8. an accepted legacy projection cannot independently satisfy closure', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({ requirement: 'WORK_ORDER' });
    const vendorWorkId = await createVendorWork(workOrder);
    await pool!.query(
      `INSERT INTO vendor_bast_bindings
         (id, client_id, vendor_work_id, work_order_id, building_id,
          bast_number, bast_date, prepared_by_user_id, submitted_by_user_id,
          accepted_by_user_id, acceptance_status, submitted_at, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-08-18',$7,$7,$7,'ACCEPTED',NOW(),NOW())`,
      [
        randomUUID(),
        workOrder.clientId,
        vendorWorkId,
        workOrder.id,
        workOrder.buildingId,
        `LEGACY_${suffix()}`,
        userId,
      ],
    );

    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'REQUIRED_BAST_MISSING',
    );
    const canonical = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM bast_documents
       WHERE work_order_id = $1`,
      [workOrder.id],
    );
    assert.equal(canonical.rows[0].count, 0);
  });

  it('9. existing completion and approval closure rules remain enforced', async (t) => {
    if (!ready(t)) return;
    const unapproved = await createWorkOrder({ approved: false });
    const withoutApproval = await closeVia(unapproved.id);
    assert.equal(withoutApproval.status, 400, JSON.stringify(withoutApproval.body));
    assert.equal(
      withoutApproval.body.error.code,
      'WORK_ORDER_CLOSE_NOT_APPROVED',
    );
    assert.equal(await statusOf(unapproved.id), 'COMPLETED');

    const staleApproval = await createWorkOrder();
    await pool!.query(
      `INSERT INTO reviews
         (id, client_id, target_type, target_id, reviewer_user_id,
          decision, status, reviewed_at)
       VALUES ($1,$2,'WORK_ORDER',$3,$4,'REJECTED','COMPLETED',
               NOW() + INTERVAL '1 second')`,
      [randomUUID(), staleApproval.clientId, staleApproval.id, userId],
    );
    const latestRejected = await closeVia(staleApproval.id);
    assert.equal(latestRejected.status, 400, JSON.stringify(latestRejected.body));
    assert.equal(latestRejected.body.error.code, 'WORK_ORDER_CLOSE_NOT_APPROVED');
    assert.equal(await statusOf(staleApproval.id), 'COMPLETED');

    const incomplete = await createWorkOrder({ status: 'OPEN', approved: true });
    const beforeCompletion = await closeVia(incomplete.id);
    assert.equal(beforeCompletion.status, 400, JSON.stringify(beforeCompletion.body));
    assert.equal(
      beforeCompletion.body.error.code,
      'WORK_ORDER_CLOSE_INVALID_STATE',
    );
    assert.equal(await statusOf(incomplete.id), 'OPEN');
  });

  it('10. Client and Building isolation cannot satisfy or invoke closure', async (t) => {
    if (!ready(t)) return;
    const workOrder = await createWorkOrder({
      requirement: 'WORK_ORDER',
      approved: false,
    });

    await approveWorkOrder(workOrder.id, isolated.clientId);
    const crossClientReview = await closeVia(workOrder.id);
    assert.equal(crossClientReview.status, 400, JSON.stringify(crossClientReview.body));
    assert.equal(
      crossClientReview.body.error.code,
      'WORK_ORDER_CLOSE_NOT_APPROVED',
    );
    assert.equal(await statusOf(workOrder.id), 'COMPLETED');

    await approveWorkOrder(workOrder.id, workOrder.clientId);
    await createCanonicalBast({
      workOrder,
      status: 'ACCEPTED',
      context: isolated,
    });
    await assertBastBlocked(
      await closeVia(workOrder.id),
      workOrder.id,
      'CANONICAL_CONTEXT_MISMATCH',
    );

    const unauthorized = await closeVia(workOrder.id, outsiderToken);
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.body));
    assert.equal(unauthorized.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(await statusOf(workOrder.id), 'COMPLETED');
  });
});
