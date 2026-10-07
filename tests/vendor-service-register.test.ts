import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { assetService } from '../src/modules/assets';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { vendorAssignmentService } from '../src/modules/vendor-assignments';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import {
  getVendorServiceRegister,
  parseVendorServiceRegisterQuery,
} from '../src/modules/vendor-service-register';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-REPORT-READ-01 PART 01 — Vendor Service Register focused validation.
 *
 * Covers ONLY the read contract surface (service-level; no HTTP endpoint):
 *  - one fully-linked vendor-service row (all 11 links present)
 *  - nullable optional links do not remove the base vendor-work row
 *  - existing statuses are returned verbatim (no inference)
 *  - one row per vendor work (multi-row links never fan out)
 *  - latest-verification and latest-rework selection reuse the
 *    authorities' ordering semantics
 *  - data scope: rollup isolation, explicit-building assertion, denial
 *    outside authorized scope, well-formed empty scope
 *  - safe read filters + query validation
 *
 * Spine fixtures use the authoritative services; linked rows are pinned by
 * direct SQL exactly as the BE-23H KPI test does — the register is a read
 * model over precisely those authoritative columns.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       vendor_rework_cycles, reviews,
       vendor_bast_bindings,
       vendor_checklist_bindings,
       checklist_executions, checklist_items, checklist_templates,
       vendor_completion_reports, vendor_service_reports,
       vendor_works, vendor_assignments,
       vendor_building_relationships, vendors,
       work_orders, work_requests, assets,
       spaces, rooms, areas, floors,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerUserId = manager.userId;
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
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString();
const dayOffset = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

type Seed = {
  buildingAId: string;
  buildingBId: string;
  buildingCId: string;
  clientAId: string;
  acmeId: string;
  globexId: string;
  work1Id: string;
  workOrder1Id: string;
  asset1Id: string;
  completion1Id: string;
  service1Id: string;
  reviewNewId: string;
  reworkNewId: string;
  bast1Id: string;
  work2Id: string;
  workOrder2Id: string;
};

/**
 * Seeds two buildings the manager can access (A: fully-linked work + bare
 * work; B: one bare work) and one building/client the manager can NOT
 * access (C). Returns the pinned identifiers the assertions need.
 */
async function seed(): Promise<Seed> {
  await pool!.query(
    `TRUNCATE
       vendor_rework_cycles, reviews,
       vendor_bast_bindings,
       vendor_checklist_bindings,
       checklist_executions, checklist_items, checklist_templates,
       vendor_completion_reports, vendor_service_reports,
       vendor_works, vendor_assignments,
       vendor_building_relationships, vendors,
       work_orders, work_requests, assets
     CASCADE`,
  );

  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Register client',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });

  const acme = await vendorService.createVendor({
    clientId: clientA.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Acme Services',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: acme.id,
    buildingId: buildingA.id,
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: acme.id,
    buildingId: buildingB.id,
  });
  const globex = await vendorService.createVendor({
    clientId: clientA.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Globex Maintenance',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: globex.id,
    buildingId: buildingA.id,
  });
  const otherVendor = await vendorService.createVendor({
    clientId: clientC.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Other Vendor',
  });

  async function makeAssignment(
    vendorId: string,
    buildingId: string,
    clientId: string,
    assignedDaysAgo: number,
  ) {
    const wo = await workOrderService.createWorkOrder({
      clientId,
      buildingId,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Register work order',
      workType: 'REPAIR',
      createdByUserId: managerUserId,
    });
    const assignment = await vendorAssignmentService.assignVendor({
      vendorId,
      workOrderId: wo.id,
      assignedByUserId: managerUserId,
    });
    await pool!.query(
      'UPDATE vendor_assignments SET assigned_at = $2 WHERE id = $1',
      [assignment.id, daysAgoIso(assignedDaysAgo)],
    );
    return { wo, assignment };
  }

  async function makeWork(
    assignmentId: string,
    vendorId: string,
    workOrderId: string,
    buildingId: string,
    status: string,
    startedAt: string | null,
    completedAt: string | null,
  ) {
    const id = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_works
         (id, vendor_assignment_id, vendor_id, work_order_id, building_id,
          status, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        assignmentId,
        vendorId,
        workOrderId,
        buildingId,
        status,
        startedAt,
        completedAt,
      ],
    );
    return id;
  }

  /* ---------------- Work 1: fully linked (Building A, Acme) ---------------- */

  const asset1 = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Genset 1',
  });
  const link1 = await makeAssignment(acme.id, buildingA.id, clientA.id, 2);
  await pool!.query('UPDATE work_orders SET asset_id = $2 WHERE id = $1', [
    link1.wo.id,
    asset1.id,
  ]);
  const work1Id = await makeWork(
    link1.assignment.id,
    acme.id,
    link1.wo.id,
    buildingA.id,
    'COMPLETED',
    daysAgoIso(2),
    daysAgoIso(1),
  );

  const completion1Id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_completion_reports
       (id, client_id, vendor_work_id, work_order_id, building_id,
        completion_status, summary, completed_by_user_id, completed_at,
        evidence_ready, missing_evidence_types, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'SUBMITTED','Done',$6,$7,TRUE,'[]'::jsonb,$6)`,
    [
      completion1Id,
      clientA.id,
      work1Id,
      link1.wo.id,
      buildingA.id,
      managerUserId,
      daysAgoIso(1),
    ],
  );

  const service1Id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_service_reports
       (id, client_id, vendor_work_id, completion_report_id, work_order_id,
        building_id, service_report_number, service_date, summary,
        work_performed, prepared_by_user_id, status, finalized_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Svc summary','Svc work',$9,'FINALIZED',$10)`,
    [
      service1Id,
      clientA.id,
      work1Id,
      completion1Id,
      link1.wo.id,
      buildingA.id,
      `SRV_${suffix()}`,
      dayOffset(-1),
      managerUserId,
      daysAgoIso(1),
    ],
  );

  // Two verifications: the NEWER row must win regardless of decision.
  const reviewOldId = randomUUID();
  const reviewNewId = randomUUID();
  await pool!.query(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, decision,
        status, reviewed_at, created_at)
     VALUES ($1,$2,'VENDOR_WORK',$3,$4,'REJECTED','COMPLETED',$5,$6)`,
    [
      reviewOldId,
      clientA.id,
      work1Id,
      managerUserId,
      daysAgoIso(1),
      daysAgoIso(1),
    ],
  );
  await pool!.query(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, decision,
        status, reviewed_at, created_at)
     VALUES ($1,$2,'VENDOR_WORK',$3,$4,'REWORK_REQUIRED','COMPLETED',$5,$6)`,
    [
      reviewNewId,
      clientA.id,
      work1Id,
      managerUserId,
      daysAgoIso(0),
      daysAgoIso(0),
    ],
  );

  // Two rework cycles: count = 2, latest = the REQUESTED one.
  const reworkOldId = randomUUID();
  const reworkNewId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_rework_cycles
       (id, vendor_work_id, review_id, requested_by_user_id, reason,
        resubmitted_by_user_id, requested_at, resubmitted_at, status)
     VALUES ($1,$2,$3,$4,'Fix wiring',$4,$5,$6,'RESUBMITTED')`,
    [
      reworkOldId,
      work1Id,
      reviewOldId,
      managerUserId,
      daysAgoIso(1),
      daysAgoIso(1),
    ],
  );
  await pool!.query(
    `INSERT INTO vendor_rework_cycles
       (id, vendor_work_id, review_id, requested_by_user_id, reason,
        requested_at, status)
     VALUES ($1,$2,$3,$4,'Re-torque terminals',$5,'REQUESTED')`,
    [reworkNewId, work1Id, reviewNewId, managerUserId, daysAgoIso(0)],
  );

  // Two checklist bindings (different templates): count = 2 on ONE row.
  for (const withExecution of [true, false]) {
    const templateId = randomUUID();
    await pool!.query(
      `INSERT INTO checklist_templates
         (id, client_id, code, name, status)
       VALUES ($1,$2,$3,'Checklist','ACTIVE')`,
      [templateId, clientA.id, `CHK_${suffix()}`],
    );
    let executionId: string | null = null;
    if (withExecution) {
      executionId = randomUUID();
      await pool!.query(
        `INSERT INTO checklist_executions
           (id, client_id, checklist_template_id, status, started_at,
            completed_at)
         VALUES ($1,$2,$3,'COMPLETED',$4,$5)`,
        [
          executionId,
          clientA.id,
          templateId,
          daysAgoIso(2),
          daysAgoIso(1),
        ],
      );
    }
    await pool!.query(
      `INSERT INTO vendor_checklist_bindings
         (id, client_id, vendor_work_id, checklist_template_id,
          checklist_execution_id, building_id, work_order_id, status,
          created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8)`,
      [
        randomUUID(),
        clientA.id,
        work1Id,
        templateId,
        executionId,
        buildingA.id,
        link1.wo.id,
        managerUserId,
      ],
    );
  }

  const bast1Id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_bast_bindings
       (id, client_id, vendor_work_id, completion_report_id,
        service_report_id, work_order_id, building_id, bast_number,
        bast_date, prepared_by_user_id, submitted_by_user_id,
        accepted_by_user_id, acceptance_status, submitted_at, accepted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ACCEPTED',$13,$14)`,
    [
      bast1Id,
      clientA.id,
      work1Id,
      completion1Id,
      service1Id,
      link1.wo.id,
      buildingA.id,
      `BAST_${suffix()}`,
      dayOffset(-1),
      managerUserId,
      managerUserId,
      managerUserId,
      daysAgoIso(1),
      daysAgoIso(0),
    ],
  );

  /* ---------------- Work 2: bare (Building A, Globex) ---------------- */

  const link2 = await makeAssignment(globex.id, buildingA.id, clientA.id, 30);
  const work2Id = await makeWork(
    link2.assignment.id,
    globex.id,
    link2.wo.id,
    buildingA.id,
    'IN_PROGRESS',
    daysAgoIso(30),
    null,
  );

  /* ---------------- Work 3: bare (Building B, Acme) ---------------- */

  const link3 = await makeAssignment(acme.id, buildingB.id, clientA.id, 2);
  await makeWork(
    link3.assignment.id,
    acme.id,
    link3.wo.id,
    buildingB.id,
    'NOT_STARTED',
    null,
    null,
  );

  /* ---------------- Work 4: inaccessible (Building C) ---------------- */

  const link4 = await makeAssignment(
    otherVendor.id,
    buildingC.id,
    clientC.id,
    2,
  );
  await makeWork(
    link4.assignment.id,
    otherVendor.id,
    link4.wo.id,
    buildingC.id,
    'IN_PROGRESS',
    daysAgoIso(2),
    null,
  );

  return {
    buildingAId: buildingA.id,
    buildingBId: buildingB.id,
    buildingCId: buildingC.id,
    clientAId: clientA.id,
    acmeId: acme.id,
    globexId: globex.id,
    work1Id,
    workOrder1Id: link1.wo.id,
    asset1Id: asset1.id,
    completion1Id,
    service1Id,
    reviewNewId,
    reworkNewId,
    bast1Id,
    work2Id,
    workOrder2Id: link2.wo.id,
  };
}

describe('vendor-service-register read contract', () => {
  it('returns one fully-linked row with verbatim statuses', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    const result = await getVendorServiceRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );

    assert.equal(result.buildingId, s.buildingAId);
    assert.deepEqual(result.buildingScope, [s.buildingAId]);
    // Two works in A; multi-row links on work 1 must not fan out.
    assert.equal(result.rows.length, 2);

    const row = result.rows.find((r) => r.vendorWorkId === s.work1Id);
    assert.ok(row);
    assert.equal(row.vendorId, s.acmeId);
    assert.equal(row.vendorCode.length > 0, true);
    assert.equal(row.vendorName, 'Acme Services');
    assert.equal(row.workOrderId, s.workOrder1Id);
    assert.equal(row.workOrderStatus, 'OPEN');
    assert.equal(row.assetId, s.asset1Id);
    assert.equal(row.assetName, 'Genset 1');
    assert.equal(row.vendorWorkStatus, 'COMPLETED');
    assert.ok(row.vendorWorkStartedAt);
    assert.ok(row.vendorWorkCompletedAt);
    assert.equal(row.checklistBindingCount, 2);
    assert.equal(row.completionReportId, s.completion1Id);
    assert.equal(row.completionReportStatus, 'SUBMITTED');
    assert.ok(row.completionSubmittedAt);
    assert.equal(row.serviceReportId, s.service1Id);
    assert.equal(row.serviceReportStatus, 'FINALIZED');
    assert.equal(row.serviceReportDate, dayOffset(-1));
    assert.ok(row.serviceReportFinalizedAt);
    // Latest verification = the newer row, not the older REJECTED one.
    assert.equal(row.verificationReviewId, s.reviewNewId);
    assert.equal(row.verificationDecision, 'REWORK_REQUIRED');
    assert.ok(row.verificationReviewedAt);
    assert.equal(row.reworkCount, 2);
    assert.equal(row.latestReworkId, s.reworkNewId);
    assert.equal(row.latestReworkStatus, 'REQUESTED');
    assert.equal(row.bastBindingId, s.bast1Id);
    assert.equal(row.bastAcceptanceStatus, 'ACCEPTED');
    assert.equal(row.bastDate, dayOffset(-1));
    assert.equal(row.canonicalBastDocumentId, null);
    assert.equal(row.canonicalBastAcceptanceStatus, null);
    assert.equal(row.buildingId, s.buildingAId);
    assert.equal(row.clientId, s.clientAId);
  });

  it('keeps the base row when optional links are missing', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    const result = await getVendorServiceRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    const row = result.rows.find((r) => r.vendorWorkId === s.work2Id);
    assert.ok(row);
    assert.equal(row.vendorName, 'Globex Maintenance');
    assert.equal(row.workOrderId, s.workOrder2Id);
    assert.equal(row.assetId, null);
    assert.equal(row.assetCode, null);
    assert.equal(row.assetName, null);
    assert.equal(row.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(row.checklistBindingCount, 0);
    assert.equal(row.completionReportId, null);
    assert.equal(row.completionReportStatus, null);
    assert.equal(row.completionSubmittedAt, null);
    assert.equal(row.serviceReportId, null);
    assert.equal(row.serviceReportStatus, null);
    assert.equal(row.verificationReviewId, null);
    assert.equal(row.verificationDecision, null);
    assert.equal(row.reworkCount, 0);
    assert.equal(row.latestReworkId, null);
    assert.equal(row.latestReworkStatus, null);
    assert.equal(row.bastBindingId, null);
    assert.equal(row.bastAcceptanceStatus, null);
  });

  it('rolls up across accessible buildings and excludes the rest', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    const result = await getVendorServiceRegister({}, managerUserId);

    assert.equal(result.buildingId, null);
    assert.ok(result.buildingScope.includes(s.buildingAId));
    assert.ok(result.buildingScope.includes(s.buildingBId));
    assert.equal(result.buildingScope.includes(s.buildingCId), false);
    // A(2) + B(1); the inaccessible C work is excluded.
    assert.equal(result.rows.length, 3);
    const buildings = new Set(result.rows.map((r) => r.buildingId));
    assert.deepEqual([...buildings].sort(), [s.buildingAId, s.buildingBId].sort());
  });

  it('denies an explicit building outside authorized scope', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    await assert.rejects(
      getVendorServiceRegister({ buildingId: s.buildingCId }, managerUserId),
    );
    await assert.rejects(
      getVendorServiceRegister(
        { buildingId: '00000000-0000-0000-0000-000000000000' },
        managerUserId,
      ),
    );
  });

  it('returns a well-formed empty register for an empty scope', async (t) => {
    if (!ready(t)) return;
    await seed();

    const outsider = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });
    const result = await getVendorServiceRegister({}, outsider.id);

    assert.equal(result.buildingId, null);
    assert.deepEqual(result.buildingScope, []);
    assert.deepEqual(result.rows, []);
  });

  it('supports safe read filters without new semantics', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    const byVendor = await getVendorServiceRegister(
      { vendorId: s.globexId },
      managerUserId,
    );
    assert.equal(byVendor.rows.length, 1);
    assert.equal(byVendor.rows[0].vendorWorkId, s.work2Id);

    const byWorkOrder = await getVendorServiceRegister(
      { workOrderId: s.workOrder1Id },
      managerUserId,
    );
    assert.equal(byWorkOrder.rows.length, 1);
    assert.equal(byWorkOrder.rows[0].vendorWorkId, s.work1Id);

    const byAsset = await getVendorServiceRegister(
      { assetId: s.asset1Id },
      managerUserId,
    );
    assert.equal(byAsset.rows.length, 1);
    assert.equal(byAsset.rows[0].vendorWorkId, s.work1Id);

    const byStatus = await getVendorServiceRegister(
      { vendorWorkStatus: 'COMPLETED' },
      managerUserId,
    );
    assert.equal(byStatus.rows.length, 1);
    assert.equal(byStatus.rows[0].vendorWorkId, s.work1Id);

    const byDecision = await getVendorServiceRegister(
      { verificationDecision: 'REWORK_REQUIRED' },
      managerUserId,
    );
    assert.equal(byDecision.rows.length, 1);
    assert.equal(byDecision.rows[0].vendorWorkId, s.work1Id);

    // Assigned-at window: work 2 (30 days ago) falls outside.
    const byWindow = await getVendorServiceRegister(
      { dateFrom: dayOffset(-7), dateTo: dayOffset(0) },
      managerUserId,
    );
    const ids = byWindow.rows.map((r) => r.vendorWorkId);
    assert.ok(ids.includes(s.work1Id));
    assert.equal(ids.includes(s.work2Id), false);
  });

  it('rejects invalid query input', async (t) => {
    if (!ready(t)) return;

    assert.throws(() =>
      parseVendorServiceRegisterQuery({ vendorId: 'not-a-uuid' }),
    );
    assert.throws(() =>
      parseVendorServiceRegisterQuery({ vendorWorkStatus: 'DONE' }),
    );
    assert.throws(() =>
      parseVendorServiceRegisterQuery({ verificationDecision: 'MAYBE' }),
    );
    assert.throws(() =>
      parseVendorServiceRegisterQuery({
        dateFrom: dayOffset(0),
        dateTo: dayOffset(-7),
      }),
    );
  });
});
