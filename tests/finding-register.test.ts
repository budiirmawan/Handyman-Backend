import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { AppError } from '../src/shared/errors';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { findingClassificationService } from '../src/modules/finding-classifications';
import { findingRegisterService } from '../src/modules/finding-register';
import { findingSeverityService } from '../src/modules/finding-severities';
import { findingService } from '../src/modules/findings';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-REPORT-READ-02 PART 01 — Finding Register focused validation.
 *
 * Covers ONLY the read contract surface (service-level; no HTTP endpoint):
 *  1. fully linked finding row (classification, severity, WORK_ORDER source,
 *     ACTIVE workforce assignment, evidence, rework, completed verification,
 *     closure, history)
 *  2. finding preserved when all optional relations are absent (bare row)
 *  3. authoritative statuses/decisions returned verbatim (no inference)
 *  4. no join fan-out (multi-row aggregates produce exactly one row per
 *     finding; duplicate LATERAL rows cannot appear)
 *  5. explicit-building unauthorized access is rejected
 *  6. accessible-building rollup excludes inaccessible buildings
 *  7. empty authorized scope returns empty result
 *  8. supported filters (status, severityId, classificationId, sourceType,
 *     assignedUserId, verificationDecision, date window)
 *  9. invalid filter rejection (bad UUID, bad enum, bad date, inverted range)
 *
 * Spine fixtures use the authoritative services; linked rows are pinned by
 * direct SQL exactly as the sibling vendor-service-register test does — the
 * register is a read model over precisely those authoritative columns.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerUserId = '';
let outsiderUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       operational_events, evidence_submissions,
       finding_rework_cycles, reviews, finding_assignments,
       findings, work_orders, work_requests,
       workforce_building_assignments, workforce_profiles,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const admin = await createAdminUser();
  managerUserId = admin.userId;

  // Plain user with no building assignments (empty authorized scope).
  const outsider = await userService.createUser({
    email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Outsider User',
  });
  outsiderUserId = outsider.id;
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

type Seed = {
  clientAId: string;
  clientCId: string;
  buildingAId: string;
  buildingBId: string;
  buildingCId: string;
  workerUserId: string;
  workerProfileId: string;
  classAId: string;
  sevCritId: string;
  wo1Id: string;
  wo1Number: string;
  fFullId: string;
  fBareId: string;
  fOtherBuildingId: string;
  fForbiddenId: string;
};

async function seed(): Promise<Seed> {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Register client A',
  });
  const propA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propA.id,
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
    name: 'Forbidden client',
  });
  const propC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propC.id,
    code: `B_${suffix()}`,
    name: 'Building C (forbidden)',
  });

  const org = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Engineering org',
  });
  const dept = await departmentService.createDepartment({
    organizationId: org.id,
    code: `D_${suffix()}`,
    name: 'Engineering dept',
  });
  const pos = await positionService.createPosition({
    organizationId: org.id,
    code: `POS_${suffix()}`,
    name: 'Technician',
  });
  // A workforce profile bound to a separate worker user, used to prove
  // assignedUserId resolution through workforce_profiles.user_id.
  const workerUser = await userService.createUser({
    email: `worker-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Assigned Worker',
  });
  const worker = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: dept.id,
    positionId: pos.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Assigned Worker',
    userId: workerUser.id,
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: worker.id,
    buildingId: buildingA.id,
  });

  const classA = await findingClassificationService.createFindingClassification({
    clientId: clientA.id,
    code: `CLS_${suffix()}`,
    name: 'Safety / Electrical',
  });
  const sevCrit = await findingSeverityService.createFindingSeverity({
    clientId: clientA.id,
    code: `SEV_${suffix()}`,
    name: 'Critical',
    rank: 1,
  });

  // Work order (WORK_ORDER source) for the fully linked finding.
  const wo1Number = `WO_${suffix()}`;
  const wo1 = await workOrderService.createWorkOrder({
    clientId: clientA.id,
    buildingId: buildingA.id,
    workOrderNumber: wo1Number,
    title: 'Chiller corrective work',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });

  /* ------------------ f1: fully linked (VERIFIED+CLOSED) ------------------ */
  const fFull = await findingService.createFinding({
    clientId: clientA.id,
    buildingId: buildingA.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Exposed wiring on chiller',
    description: 'High-voltage wiring exposed on panel.',
    reportedByUserId: managerUserId,
  });
  await findingService.updateFinding(fFull.id, {
    classificationId: classA.id,
    severityId: sevCrit.id,
  });
  await pool!.query(
    `UPDATE findings
       SET source_type='WORK_ORDER', source_id=$2, reported_at=$3,
           state_changed_at=$4
     WHERE id=$1`,
    [fFull.id, wo1.id, daysAgoIso(5), daysAgoIso(1)],
  );

  // ACTIVE workforce assignment (mirrors findActiveByFindingId).
  const assignId = randomUUID();
  await pool!.query(
    `INSERT INTO finding_assignments
       (id, finding_id, assignee_type, workforce_profile_id, team_id, vendor_id,
        assigned_by_user_id, assigned_at, status)
     VALUES ($1,$2,'WORKFORCE',$3,NULL,NULL,$4,$5,'ACTIVE')`,
    [assignId, fFull.id, worker.id, managerUserId, daysAgoIso(4)],
  );

  // Two ACTIVE evidence rows + one REMOVED (should not be counted).
  const ev1 = randomUUID();
  const ev2 = randomUUID();
  await pool!.query(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type, file_size,
        captured_at, submitted_by_user_id, status)
     VALUES
       ($1,$2,NULL,'FINDING',$3,'IMAGE','ref1','a.jpg','image/jpeg',100,$4,$5,'ACTIVE'),
       ($6,$2,NULL,'FINDING',$3,'IMAGE','ref2','b.jpg','image/jpeg',200,$4,$5,'ACTIVE')`,
    [ev1, clientA.id, fFull.id, daysAgoIso(4), managerUserId,
     ev2],
  );
  const evRemoved = randomUUID();
  await pool!.query(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type, file_size,
        captured_at, submitted_by_user_id, status)
     VALUES ($1,$2,NULL,'FINDING',$3,'IMAGE','ref3','c.jpg','image/jpeg',300,$4,$5,'REMOVED')`,
    [evRemoved, clientA.id, fFull.id, daysAgoIso(4), managerUserId],
  );

  // Two rework cycles (one older RESUBMITTED, one REQUESTED = current/latest).
  const rwOld = randomUUID();
  const rwNew = randomUUID();
  const vOld = randomUUID();
  const vNew = randomUUID();
  await pool!.query(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, decision, notes,
        reviewed_at, status)
     VALUES
       ($1,$2,'FINDING',$3,$4,'REWORK_REQUIRED','rework needed',$5,'COMPLETED'),
       ($6,$2,'FINDING',$3,$4,'APPROVED','looks good',$7,'COMPLETED')`,
    [vOld, clientA.id, fFull.id, managerUserId, daysAgoIso(3),
     vNew, daysAgoIso(2)],
  );
  await pool!.query(
    `INSERT INTO finding_rework_cycles
       (id, finding_id, review_id, requested_by_user_id, reason,
        resubmitted_by_user_id, requested_at, resubmitted_at, status)
     VALUES
       ($1,$2,$3,$4,'fix wiring',$5,$6,$7,'RESUBMITTED'),
       ($8,$2,$9,$4,'fix wiring again',NULL,$10,NULL,'REQUESTED')`,
    [rwOld, fFull.id, vOld, managerUserId, managerUserId,
     daysAgoIso(3), daysAgoIso(2),
     rwNew, vNew, daysAgoIso(1)],
  );

  // Closure fields.
  await pool!.query(
    `UPDATE findings
       SET status='CLOSED', closed_at=$2, closed_by_user_id=$3,
           closure_notes=$4, state_changed_at=$2
     WHERE id=$1`,
    [fFull.id, daysAgoIso(1), managerUserId, 'Closed after verification.'],
  );

  // Two history events.
  await pool!.query(
    `INSERT INTO operational_events
       (id, client_id, entity_type, entity_id, actor_user_id, building_id,
        event_type, summary, metadata, occurred_at)
     VALUES
       ($1,$2,'FINDING',$3,$4,$5,'CREATED','finding created','{}'::jsonb,$6),
       ($7,$2,'FINDING',$3,$4,$5,'CLOSED','finding closed','{}'::jsonb,$8)`,
    [randomUUID(), clientA.id, fFull.id, managerUserId, buildingA.id, daysAgoIso(5),
     randomUUID(), daysAgoIso(1)],
  );

  /* -------------- f2: bare finding (no optional links) -------------- */
  const fBare = await findingService.createFinding({
    clientId: clientA.id,
    buildingId: buildingA.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Bare open finding',
    reportedByUserId: managerUserId,
  });
  // No classification, severity, source, assignment, evidence, reviews,
  // rework, closure, or history — ensures LEFT joins don't drop the base row.

  /* -------------- f3: other building (Building B) -------------- */
  const fOther = await findingService.createFinding({
    clientId: clientA.id,
    buildingId: buildingB.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Building B finding',
    reportedByUserId: managerUserId,
  });

  /* -------------- f4: forbidden building (Building C) -------------- */
  const fForbidden = await findingService.createFinding({
    clientId: clientC.id,
    buildingId: buildingC.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Forbidden building finding',
    reportedByUserId: managerUserId,
  });

  return {
    clientAId: clientA.id,
    clientCId: clientC.id,
    buildingAId: buildingA.id,
    buildingBId: buildingB.id,
    buildingCId: buildingC.id,
    workerUserId: workerUser.id,
    workerProfileId: worker.id,
    classAId: classA.id,
    sevCritId: sevCrit.id,
    wo1Id: wo1.id,
    wo1Number,
    fFullId: fFull.id,
    fBareId: fBare.id,
    fOtherBuildingId: fOther.id,
    fForbiddenId: fForbidden.id,
  };
}

describe('CR-BE-REPORT-READ-02 PART 01 — Finding Register read contract', () => {
  it('1. fully linked finding row exposes every authoritative field verbatim', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await findingRegisterService.getFindingRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    assert.equal(result.buildingId, s.buildingAId);
    assert.deepEqual(result.buildingScope, [s.buildingAId]);
    const full = result.rows.find((r) => r.findingId === s.fFullId);
    assert.ok(full, 'fully-linked finding must appear');

    // Identity.
    assert.equal(full!.title, 'Exposed wiring on chiller');
    assert.equal(full!.description, 'High-voltage wiring exposed on panel.');
    assert.equal(full!.status, 'CLOSED');

    // Classification / severity.
    assert.equal(full!.classificationId, s.classAId);
    assert.ok(full!.classificationCode?.startsWith('CLS_'));
    assert.equal(full!.classificationName, 'Safety / Electrical');
    assert.equal(full!.severityId, s.sevCritId);
    assert.ok(full!.severityCode?.startsWith('SEV_'));
    assert.equal(full!.severityName, 'Critical');
    assert.equal(full!.severityRank, 1);

    // Source — WORK_ORDER bounded enrichment.
    assert.equal(full!.sourceType, 'WORK_ORDER');
    assert.equal(full!.sourceId, s.wo1Id);
    assert.equal(full!.sourceReferenceNumber, s.wo1Number);

    // Context.
    assert.equal(full!.buildingId, s.buildingAId);
    assert.equal(full!.clientId, s.clientAId);
    // assetId/functionalLocationId not set on wo1 — must be null, not
    // fabricated.
    assert.equal(full!.assetId, null);
    assert.equal(full!.functionalLocationId, null);

    // Assignment (ACTIVE workforce).
    assert.equal(full!.assigneeType, 'WORKFORCE');
    assert.equal(full!.assignedWorkforceProfileId, s.workerProfileId);
    assert.equal(full!.assignedTeamId, null);
    assert.equal(full!.assignedVendorId, null);
    assert.equal(full!.assignedByUserId, managerUserId);
    assert.ok(full!.assignedAt, 'assignedAt must be populated');

    // Evidence count (ACTIVE only; REMOVED excluded).
    assert.equal(full!.evidenceCount, 2);

    // Rework.
    assert.equal(full!.reworkCount, 2);
    assert.ok(full!.latestReworkId, 'latestReworkId must be set');
    assert.equal(full!.latestReworkStatus, 'REQUESTED');
    assert.ok(full!.latestReworkRequestedAt);

    // Verification — latest review is vNew (APPROVED, COMPLETED).
    assert.ok(full!.verificationReviewId);
    assert.equal(full!.verificationReviewStatus, 'COMPLETED');
    assert.equal(full!.verificationDecision, 'APPROVED');
    assert.equal(full!.verificationReviewerUserId, managerUserId);
    assert.ok(full!.verificationReviewedAt);

    // Closure.
    assert.ok(full!.closedAt);
    assert.equal(full!.closedByUserId, managerUserId);
    assert.equal(full!.closureNotes, 'Closed after verification.');

    // History.
    assert.equal(full!.historyAvailable, true);
    assert.equal(full!.historyCount, 2);
  });

  it('2. finding preserved when optional relations absent (bare row)', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await findingRegisterService.getFindingRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    const bare = result.rows.find((r) => r.findingId === s.fBareId);
    assert.ok(bare, 'bare finding must be preserved despite nulls');
    assert.equal(bare!.status, 'OPEN');
    assert.equal(bare!.classificationId, null);
    assert.equal(bare!.classificationCode, null);
    assert.equal(bare!.severityId, null);
    assert.equal(bare!.sourceType, null);
    assert.equal(bare!.sourceId, null);
    assert.equal(bare!.sourceReferenceNumber, null);
    assert.equal(bare!.assigneeType, null);
    assert.equal(bare!.assignedWorkforceProfileId, null);
    assert.equal(bare!.evidenceCount, 0);
    assert.equal(bare!.reworkCount, 0);
    assert.equal(bare!.latestReworkId, null);
    assert.equal(bare!.latestReworkStatus, null);
    assert.equal(bare!.verificationReviewId, null);
    assert.equal(bare!.verificationDecision, null);
    assert.equal(bare!.closedAt, null);
    assert.equal(bare!.historyAvailable, false);
    assert.equal(bare!.historyCount, 0);
  });

  it('3. authoritative statuses/decisions returned verbatim', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await findingRegisterService.getFindingRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    // Known statuses directly from authority (CLOSED via update, OPEN default).
    const closed = result.rows.find((r) => r.findingId === s.fFullId)!;
    const open = result.rows.find((r) => r.findingId === s.fBareId)!;
    assert.equal(closed.status, 'CLOSED');
    assert.equal(open.status, 'OPEN');
    assert.equal(closed.verificationDecision, 'APPROVED');
    assert.equal(closed.latestReworkStatus, 'REQUESTED');
    // No translation/mapping must occur — raw DB values pass through.
  });

  it('4. no join fan-out: one row per finding', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await findingRegisterService.getFindingRegister({}, managerUserId);
    const ids = result.rows.map((r) => r.findingId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate finding rows indicate fan-out');
    // manager can access buildings A & B: expect full+bare+other=3; forbidden C excluded.
    assert.ok(ids.includes(s.fFullId));
    assert.ok(ids.includes(s.fBareId));
    assert.ok(ids.includes(s.fOtherBuildingId));
    assert.ok(!ids.includes(s.fForbiddenId), 'forbidden building finding must not appear');
    assert.equal(ids.length, 3);
  });

  it('5. explicit-building unauthorized access is rejected', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    // Non-existent building id → notFound.
    await assert.rejects(
      () =>
        findingRegisterService.getFindingRegister(
          { buildingId: '00000000-0000-4000-8000-000000000000' },
          managerUserId,
        ),
      /not found/i,
    );
    // Existing building C (other client, no assignment) → access error.
    await assert.rejects(
      () =>
        findingRegisterService.getFindingRegister(
          { buildingId: s.buildingCId },
          managerUserId,
        ),
    );
  });

  it('6. accessible-building rollup excludes inaccessible buildings', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await findingRegisterService.getFindingRegister({}, managerUserId);
    assert.equal(result.buildingId, null, 'rollup must have null buildingId');
    assert.deepEqual(
      [...result.buildingScope].sort(),
      [s.buildingAId, s.buildingBId].sort(),
    );
    const buildings = new Set(result.rows.map((r) => r.buildingId));
    assert.ok(buildings.has(s.buildingAId));
    assert.ok(buildings.has(s.buildingBId));
    assert.ok(!buildings.has(s.buildingCId));
  });

  it('7. empty authorized scope returns empty result', async (t) => {
    if (!ready(t)) return;
    await seed();
    const result = await findingRegisterService.getFindingRegister({}, outsiderUserId);
    assert.equal(result.buildingId, null);
    assert.deepEqual(result.buildingScope, []);
    assert.deepEqual(result.rows, []);
  });

  it('8. supported filters narrow the rows', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    // status filter.
    const onlyOpen = await findingRegisterService.getFindingRegister(
      { status: 'OPEN' },
      managerUserId,
    );
    assert.ok(onlyOpen.rows.every((r) => r.status === 'OPEN'));
    assert.ok(onlyOpen.rows.some((r) => r.findingId === s.fBareId));
    assert.ok(!onlyOpen.rows.some((r) => r.findingId === s.fFullId));

    // severityId filter.
    const crit = await findingRegisterService.getFindingRegister(
      { severityId: s.sevCritId },
      managerUserId,
    );
    assert.ok(crit.rows.every((r) => r.severityId === s.sevCritId));
    assert.equal(crit.rows.length, 1);
    assert.equal(crit.rows[0].findingId, s.fFullId);

    // classificationId filter.
    const byCls = await findingRegisterService.getFindingRegister(
      { classificationId: s.classAId },
      managerUserId,
    );
    assert.ok(byCls.rows.every((r) => r.classificationId === s.classAId));
    assert.equal(byCls.rows.length, 1);

    // sourceType filter — WORK_ORDER only.
    const woSource = await findingRegisterService.getFindingRegister(
      { sourceType: 'WORK_ORDER' },
      managerUserId,
    );
    assert.ok(woSource.rows.every((r) => r.sourceType === 'WORK_ORDER'));
    assert.equal(woSource.rows.length, 1);

    // assignedUserId filter — only fFull assigned to the worker.
    const assigned = await findingRegisterService.getFindingRegister(
      { assignedUserId: s.workerUserId },
      managerUserId,
    );
    assert.equal(assigned.rows.length, 1);
    assert.equal(assigned.rows[0].findingId, s.fFullId);

    // verificationDecision filter.
    const approved = await findingRegisterService.getFindingRegister(
      { verificationDecision: 'APPROVED' },
      managerUserId,
    );
    assert.ok(approved.rows.every((r) => r.verificationDecision === 'APPROVED'));
    assert.equal(approved.rows.length, 1);

    // date window filter (fFull reported 5d ago, fBare just created).
    const windowed = await findingRegisterService.getFindingRegister(
      {
        dateFrom: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
        dateTo: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10),
      },
      managerUserId,
    );
    assert.ok(windowed.rows.every((r) => r.findingId !== s.fBareId));
    assert.ok(windowed.rows.some((r) => r.findingId === s.fFullId));
  });

  it('9. invalid filter rejection', async (t) => {
    if (!ready(t)) return;
    await seed();

    function mustThrow(query: Record<string, unknown>, label: string) {
      assert.throws(
        () => findingRegisterService.parseFindingRegisterQuery(query),
        (err: unknown) => err instanceof AppError && err.code === 'VALIDATION',
        `expected VALIDATION error for ${label}`,
      );
    }

    mustThrow({ buildingId: 'not-a-uuid' }, 'bad buildingId UUID');
    mustThrow({ status: 'NOT_A_STATUS' }, 'bad status enum');
    mustThrow({ sourceType: 'ALIEN' }, 'bad sourceType enum');
    mustThrow({ verificationDecision: 'MAYBE' }, 'bad decision enum');
    mustThrow({ dateFrom: 'not-a-date' }, 'bad dateFrom');
    mustThrow({ dateFrom: '2025-12-31', dateTo: '2025-01-01' }, 'inverted range');
    mustThrow(
      { dateFrom: '2025-01-01', dateTo: '2030-01-01' },
      'range > 366 days',
    );

    // Arrays are rejected (not a single param).
    mustThrow({ status: ['OPEN', 'CLOSED'] }, 'array status param');
  });
});
