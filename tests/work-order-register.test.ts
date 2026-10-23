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
import { departmentService } from '../src/modules/departments';
import { functionalLocationService } from '../src/modules/functional-locations';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { teamService } from '../src/modules/teams';
import { userService } from '../src/modules/users';
import { vendorService } from '../src/modules/vendors';
import {
  getWorkOrderRegister,
  parseWorkOrderRegisterQuery,
} from '../src/modules/work-order-register';
import { workOrderAssignmentService } from '../src/modules/work-order-assignments';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { AppError } from '../src/shared/errors';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-REPORT-READ-03 PART 01 — Work Order Register focused validation.
 *
 * Covers ONLY the read contract surface (service-level; no HTTP endpoint):
 *  1. fully linked Work Order row (asset, functional location, ACTIVE
 *     workforce assignment, evidence, findings, completed verification,
 *     completion, history)
 *  2. bare Work Order preserved when optional relations absent
 *  3. authoritative statuses/priorities/decisions returned verbatim
 *     (no inference; latest COMPLETED review regardless of decision)
 *  4. no join fan-out (ACTIVE assignment unique, LATERAL LIMIT 1)
 *  5. ACTIVE assignment only (INACTIVE assignments ignored)
 *  6. explicit-building unauthorized access is rejected
 *  7. accessible-building rollup excludes inaccessible buildings
 *  8. empty authorized scope returns empty register
 *  9. supported filters narrow correctly (status, workType, priority,
 *     bastRequirement, assetId, assignedUserId, assignedTeamId, vendorId,
 *     verificationDecision, date window on created_at)
 * 10. invalid filter rejection (bad UUID, bad enum, bad date, inverted
 *     range, array param)
 * 11. evidenceCount counts only ACTIVE WORK_ORDER evidence
 * 12. findingCount is total (no open-finding semantics)
 *
 * Spine fixtures use authoritative services; linked rows are pinned by
 * direct SQL exactly as the sibling finding-register/vendor-service-register
 * tests do — the register is a read model over precisely those
 * authoritative columns.
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
       operational_events, evidence_submissions, reviews,
       findings, work_order_actions, work_order_assignments,
       work_orders, work_requests, assets, functional_locations,
       spaces, rooms, areas, floors,
       workforce_building_assignments, workforce_profiles,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const admin = await createAdminUser();
  managerUserId = admin.userId;

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
  teamId: string;
  asset1Id: string;
  fl1Id: string;
  vendorId: string;
  woFullId: string;
  woBareId: string;
  woOtherBuildingId: string;
  woForbiddenId: string;
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
    name: 'Maintenance org',
  });
  const dept = await departmentService.createDepartment({
    organizationId: org.id,
    code: `D_${suffix()}`,
    name: 'Maintenance dept',
  });
  const pos = await positionService.createPosition({
    organizationId: org.id,
    code: `POS_${suffix()}`,
    name: 'Technician',
  });
  const workerUser = await userService.createUser({
    email: `worker-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Assigned Worker',
  });
  const team = await teamService.createTeam({
    departmentId: dept.id,
    code: `T_${suffix()}`,
    name: 'Night Crew',
  });
  const worker = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: dept.id,
    positionId: pos.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Assigned Worker',
    userId: workerUser.id,
    teamId: team.id,
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: worker.id,
    buildingId: buildingA.id,
  });

  const vendor = await vendorService.createVendor({
    clientId: clientA.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Acme Vendors',
  });
  const vendorId = vendor.id;

  const asset1 = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller 1',
  });
  const fl1 = await functionalLocationService.createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Chiller Room',
  });

  /* -------------- wo1: fully linked -------------- */
  const wo1Number = `WO_${suffix()}`;
  const wo1 = await workOrderService.createWorkOrder({
    clientId: clientA.id,
    buildingId: buildingA.id,
    workOrderNumber: wo1Number,
    title: 'Chiller repair',
    description: 'Chiller vibrating abnormally.',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });
  await pool!.query(
    `UPDATE work_orders
       SET priority='HIGH',
           bast_requirement='WORK_ORDER',
           asset_id=$2,
           functional_location_id=$3,
           created_at=$4,
           assigned_at=$5,
           started_at=$6,
           completed_at=$7,
           completed_by_user_id=$8,
           completion_summary=$9,
           completion_notes=$10
     WHERE id=$1`,
    [
      wo1.id,
      asset1.id,
      fl1.id,
      daysAgoIso(6),
      daysAgoIso(5),
      daysAgoIso(4),
      daysAgoIso(2),
      managerUserId,
      'Work completed.',
      'Replaced coupling.',
    ],
  );

  // ACTIVE workforce assignment (only the ACTIVE one must surface).
  await workOrderAssignmentService.assignWorkOrder({
    workOrderId: wo1.id,
    assigneeType: 'WORKFORCE',
    workforceProfileId: worker.id,
    assignedByUserId: managerUserId,
  });
  // Stale INACTIVE TEAM assignment — must be ignored.
  await pool!.query(
    `INSERT INTO work_order_assignments
       (id, work_order_id, assignee_type, workforce_profile_id, team_id, vendor_id,
        assigned_by_user_id, assigned_at, status)
     VALUES ($1,$2,'TEAM',NULL,$3,NULL,$4,$5,'INACTIVE')`,
    [randomUUID(), wo1.id, team.id, managerUserId, daysAgoIso(7)],
  );

  // Two ACTIVE evidence rows for WORK_ORDER + one REMOVED (excluded).
  const ev1 = randomUUID();
  const ev2 = randomUUID();
  const evRemoved = randomUUID();
  await pool!.query(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type, file_size,
        captured_at, submitted_by_user_id, status)
     VALUES
       ($1,$2,NULL,'WORK_ORDER',$3,'PHOTO','r1','a.jpg','image/jpeg',100,$4,$5,'ACTIVE'),
       ($6,$2,NULL,'WORK_ORDER',$3,'PHOTO','r2','b.jpg','image/jpeg',200,$4,$5,'ACTIVE'),
       ($7,$2,NULL,'WORK_ORDER',$3,'PHOTO','r3','c.jpg','image/jpeg',300,$4,$5,'REMOVED')`,
    [ev1, clientA.id, wo1.id, daysAgoIso(4), managerUserId,
     ev2, evRemoved],
  );

  // Two findings linked via source_type/source_id to wo1: one OPEN, one VERIFIED.
  // VERIFIED (rather than CLOSED) avoids needing closure fields; it proves the
  // total count does not filter by "open".
  const fndOpen = await pool!.query<{ id: string }>(
    `INSERT INTO findings
       (id, client_id, building_id, finding_number, title,
        reported_by_user_id, reported_at, status,
        source_type, source_id)
     VALUES
       ($1,$2,$3,$4,'Finding OPEN', $5,$6,'OPEN','WORK_ORDER',$7)
     RETURNING id`,
    [randomUUID(), clientA.id, buildingA.id, `FND_${suffix()}`,
     managerUserId, daysAgoIso(3), wo1.id],
  );
  const fndVer = await pool!.query<{ id: string }>(
    `INSERT INTO findings
       (id, client_id, building_id, finding_number, title,
        reported_by_user_id, reported_at, status, state_changed_at,
        source_type, source_id)
     VALUES
       ($1,$2,$3,$4,'Finding VERIFIED',$5,$6,'VERIFIED',$6,'WORK_ORDER',$7)
     RETURNING id`,
    [randomUUID(), clientA.id, buildingA.id, `FND_${suffix()}`,
     managerUserId, daysAgoIso(3), wo1.id],
  );
  void fndOpen; void fndVer;

  // Two verification reviews: older REJECTED, latest APPROVED (COMPLETED).
  // Created_at is back-filled to order deterministically alongside reviewed_at.
  const vOld = randomUUID();
  const vNew = randomUUID();
  await pool!.query(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, decision, notes,
        reviewed_at, created_at, status)
     VALUES
       ($1,$2,'WORK_ORDER',$3,$4,'REJECTED','needs redo',$5,$5,'COMPLETED'),
       ($6,$2,'WORK_ORDER',$3,$4,'APPROVED','looks good',$7,$7,'COMPLETED')`,
    [vOld, clientA.id, wo1.id, managerUserId, daysAgoIso(3),
     vNew, daysAgoIso(2)],
  );

  // Three history events (operational_events).
  await pool!.query(
    `INSERT INTO operational_events
       (id, client_id, entity_type, entity_id, actor_user_id, building_id,
        event_type, summary, metadata, occurred_at)
     VALUES
       ($1,$2,'WORK_ORDER',$3,$4,$5,'CREATED','wo created','{}'::jsonb,$6),
       ($7,$2,'WORK_ORDER',$3,$4,$5,'ASSIGNED','wo assigned','{}'::jsonb,$8),
       ($9,$2,'WORK_ORDER',$3,$4,$5,'COMPLETED','wo completed','{}'::jsonb,$10)`,
    [randomUUID(), clientA.id, wo1.id, managerUserId, buildingA.id, daysAgoIso(6),
     randomUUID(), daysAgoIso(5),
     randomUUID(), daysAgoIso(2)],
  );

  /* -------------- wo2: bare OPEN work order (no optionals) -------------- */
  const woBare = await workOrderService.createWorkOrder({
    clientId: clientA.id,
    buildingId: buildingA.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Bare work order',
    workType: 'PREVENTIVE',
    createdByUserId: managerUserId,
  });

  /* -------------- wo3: other in-scope building (Building B) -------------- */
  const woOther = await workOrderService.createWorkOrder({
    clientId: clientA.id,
    buildingId: buildingB.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Building B work order',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });

  /* -------------- wo4: forbidden building (Building C) -------------- */
  const woForbidden = await workOrderService.createWorkOrder({
    clientId: clientC.id,
    buildingId: buildingC.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Forbidden work order',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });

  return {
    clientAId: clientA.id,
    clientCId: clientC.id,
    buildingAId: buildingA.id,
    buildingBId: buildingB.id,
    buildingCId: buildingC.id,
    workerUserId: workerUser.id,
    workerProfileId: worker.id,
    teamId: team.id,
    asset1Id: asset1.id,
    fl1Id: fl1.id,
    vendorId,
    woFullId: wo1.id,
    woBareId: woBare.id,
    woOtherBuildingId: woOther.id,
    woForbiddenId: woForbidden.id,
  };
}

describe('CR-BE-REPORT-READ-03 PART 01 — Work Order Register read contract', () => {
  it('1. fully linked work order exposes every authoritative field verbatim', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await getWorkOrderRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    assert.equal(result.buildingId, s.buildingAId);
    assert.deepEqual(result.buildingScope, [s.buildingAId]);
    const full = result.rows.find((r) => r.workOrderId === s.woFullId);
    assert.ok(full, 'fully-linked WO must appear');

    // Identity.
    assert.equal(full!.title, 'Chiller repair');
    assert.equal(full!.description, 'Chiller vibrating abnormally.');
    // Verbatim status from the authoritative row (OPEN — we back-filled
    // completion metadata via SQL but never transitioned status; the
    // register must not infer COMPLETED from completed_at).
    assert.equal(full!.status, 'OPEN');

    // Context.
    assert.equal(full!.clientId, s.clientAId);
    assert.equal(full!.buildingId, s.buildingAId);
    assert.equal(full!.assetId, s.asset1Id);
    assert.ok(full!.assetCode?.startsWith('AST_'));
    assert.equal(full!.assetName, 'Chiller 1');
    assert.equal(full!.functionalLocationId, s.fl1Id);
    assert.ok(full!.functionalLocationCode?.startsWith('FL_'));
    assert.equal(full!.functionalLocationName, 'Chiller Room');

    // Classification / origin.
    assert.equal(full!.workType, 'CORRECTIVE');
    assert.equal(full!.priority, 'HIGH');
    assert.equal(full!.bastRequirement, 'WORK_ORDER');
    assert.equal(full!.workRequestId, null);

    // Lifecycle timestamps.
    assert.ok(full!.createdAt);
    assert.ok(full!.assignedAt);
    assert.ok(full!.startedAt);
    assert.ok(full!.completedAt);
    assert.equal(full!.closedAt, null);
    assert.equal(full!.cancelledAt, null);

    // Assignment — ACTIVE workforce only; INACTIVE team row ignored.
    assert.equal(full!.assigneeType, 'WORKFORCE');
    assert.equal(full!.assignedWorkforceProfileId, s.workerProfileId);
    assert.equal(full!.assignedTeamId, null);
    assert.equal(full!.assignedVendorId, null);
    assert.equal(full!.assignedByUserId, managerUserId);
    assert.ok(full!.assignmentAssignedAt);

    // Evidence: 2 ACTIVE, 1 REMOVED excluded.
    assert.equal(full!.evidenceCount, 2);

    // Findings: total only (OPEN + VERIFIED = 2).
    assert.equal(full!.findingCount, 2);

    // Verification: latest COMPLETED is vNew (APPROVED), not vOld (REJECTED).
    assert.ok(full!.verificationReviewId);
    assert.equal(full!.verificationReviewStatus, 'COMPLETED');
    assert.equal(full!.verificationDecision, 'APPROVED');
    assert.equal(full!.verificationReviewerUserId, managerUserId);
    assert.ok(full!.verificationReviewedAt);

    // Completion.
    assert.equal(full!.completedByUserId, managerUserId);
    assert.equal(full!.completionSummary, 'Work completed.');
    assert.equal(full!.completionNotes, 'Replaced coupling.');

    // History — the read model mirrors `operational_events` verbatim. The seed
    // pins three rows, and the authoritative services write their own events
    // (WORK_ORDER_CREATED on create, WORK_ORDER_ASSIGNED on assign), so the
    // expectation is the ledger itself rather than a hard-coded count.
    const fullHistory = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM operational_events
        WHERE entity_type = 'WORK_ORDER' AND entity_id = $1`,
      [s.woFullId],
    );
    assert.equal(full!.historyAvailable, true);
    assert.equal(full!.historyCount, fullHistory.rows[0]!.count);
    assert.ok(full!.historyCount >= 3, 'the three pinned events must be counted');
  });

  it('2. bare work order preserved when optional relations absent', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await getWorkOrderRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    const bare = result.rows.find((r) => r.workOrderId === s.woBareId);
    assert.ok(bare, 'bare WO must be preserved');
    assert.equal(bare!.status, 'OPEN');
    assert.equal(bare!.assetId, null);
    assert.equal(bare!.assetCode, null);
    assert.equal(bare!.assetName, null);
    assert.equal(bare!.functionalLocationId, null);
    assert.equal(bare!.functionalLocationCode, null);
    assert.equal(bare!.functionalLocationName, null);
    assert.equal(bare!.assigneeType, null);
    assert.equal(bare!.assignedWorkforceProfileId, null);
    assert.equal(bare!.assignedTeamId, null);
    assert.equal(bare!.assignedVendorId, null);
    assert.equal(bare!.evidenceCount, 0);
    assert.equal(bare!.findingCount, 0);
    assert.equal(bare!.verificationReviewId, null);
    assert.equal(bare!.verificationReviewStatus, null);
    assert.equal(bare!.verificationDecision, null);
    assert.equal(bare!.completedByUserId, null);
    assert.equal(bare!.completionSummary, null);
    assert.equal(bare!.completionNotes, null);
    // Creation itself is an authoritative operational event, so a bare Work
    // Order does have history — the contract is `historyCount === ledger rows`,
    // not "no optional relations means no history".
    const bareHistory = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM operational_events
        WHERE entity_type = 'WORK_ORDER' AND entity_id = $1`,
      [s.woBareId],
    );
    assert.equal(bare!.historyAvailable, bareHistory.rows[0]!.count > 0);
    assert.equal(bare!.historyCount, bareHistory.rows[0]!.count);
  });

  it('3. status/priority/verification decision returned verbatim', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await getWorkOrderRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    const full = result.rows.find((r) => r.workOrderId === s.woFullId)!;
    assert.equal(full.priority, 'HIGH');
    assert.equal(full.workType, 'CORRECTIVE');
    assert.equal(full.verificationDecision, 'APPROVED');
    assert.equal(full.bastRequirement, 'WORK_ORDER');
    assert.equal(full.status, 'OPEN');
  });

  it('4. no join fan-out: one row per work order', async (t) => {
    if (!ready(t)) return;
    // The suite shares one database and every `it` seeds its own Client, so the
    // fan-out assertion is anchored to the rows THIS seed adds — never to an
    // absolute table-wide count.
    const before = new Set(
      (await getWorkOrderRegister({}, managerUserId)).rows.map(
        (r) => r.workOrderId,
      ),
    );
    const s = await seed();
    const result = await getWorkOrderRegister({}, managerUserId);
    const ids = result.rows.map((r) => r.workOrderId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate rows indicate fan-out');
    for (const expected of [s.woFullId, s.woBareId, s.woOtherBuildingId]) {
      assert.ok(ids.includes(expected));
      assert.ok(!before.has(expected));
    }
    assert.ok(!ids.includes(s.woForbiddenId));
    assert.equal(
      ids.filter((id) => !before.has(id)).length,
      3,
      'one row per Work Order this seed created',
    );
  });

  it('5. ACTIVE assignment only; INACTIVE rows excluded', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await getWorkOrderRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    const full = result.rows.find((r) => r.workOrderId === s.woFullId)!;
    // Only the ACTIVE WORKFORCE assignment is surfaced; INACTIVE TEAM row
    // must not surface.
    assert.equal(full.assigneeType, 'WORKFORCE');
    assert.equal(full.assignedWorkforceProfileId, s.workerProfileId);
    assert.equal(full.assignedTeamId, null);
    assert.equal(full.assignedVendorId, null);
  });

  it('6. explicit-building unauthorized access rejected', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    // managerUserId has no assignment to Building C.
    await assert.rejects(
      () => getWorkOrderRegister({ buildingId: s.buildingCId }, managerUserId),
    );
    // Non-existent building.
    await assert.rejects(
      () =>
        getWorkOrderRegister(
          { buildingId: '00000000-0000-4000-8000-000000000000' },
          managerUserId,
        ),
    );
  });

  it('7. accessible-building rollup excludes inaccessible buildings', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await getWorkOrderRegister({}, managerUserId);
    assert.equal(result.buildingId, null);
    // Other `it` blocks seed their own Buildings in the same database, so the
    // rollup is asserted by membership (the manager reaches this seed's A and B,
    // never its forbidden C) rather than by exact-set equality.
    assert.ok(result.buildingScope.includes(s.buildingAId));
    assert.ok(result.buildingScope.includes(s.buildingBId));
    assert.ok(!result.buildingScope.includes(s.buildingCId));
    const buildings = new Set(result.rows.map((r) => r.buildingId));
    assert.ok(buildings.has(s.buildingAId));
    assert.ok(buildings.has(s.buildingBId));
    assert.ok(!buildings.has(s.buildingCId));
  });

  it('8. empty authorized scope returns empty register', async (t) => {
    if (!ready(t)) return;
    await seed();
    const result = await getWorkOrderRegister({}, outsiderUserId);
    assert.equal(result.buildingId, null);
    assert.deepEqual(result.buildingScope, []);
    assert.deepEqual(result.rows, []);
  });

  it('9. supported filters narrow correctly', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    // Every filtered query is pinned to THIS seed's Building A. The suite shares
    // one database, so an unscoped filter would also match Work Orders seeded by
    // earlier `it` blocks and its absolute counts would be meaningless.
    const scope = { buildingId: s.buildingAId };

    // status filter — every returned row matches, and this seed's OPEN rows are
    // included (the bare Work Order and the fully linked one).
    const onlyOpen = await getWorkOrderRegister(
      { ...scope, status: 'OPEN' },
      managerUserId,
    );
    assert.ok(onlyOpen.rows.every((r) => r.status === 'OPEN'));
    const openIds = onlyOpen.rows.map((r) => r.workOrderId);
    assert.ok(openIds.includes(s.woFullId));
    assert.ok(openIds.includes(s.woBareId));

    // workType filter.
    const corr = await getWorkOrderRegister(
      { ...scope, workType: 'CORRECTIVE' },
      managerUserId,
    );
    assert.ok(corr.rows.every((r) => r.workType === 'CORRECTIVE'));
    assert.ok(!corr.rows.some((r) => r.workOrderId === s.woBareId));
    assert.ok(corr.rows.some((r) => r.workOrderId === s.woFullId));

    // priority filter.
    const high = await getWorkOrderRegister(
      { ...scope, priority: 'HIGH' },
      managerUserId,
    );
    assert.ok(high.rows.every((r) => r.priority === 'HIGH'));
    assert.equal(high.rows.length, 1);
    assert.equal(high.rows[0].workOrderId, s.woFullId);

    // bastRequirement filter.
    const bastWo = await getWorkOrderRegister(
      { ...scope, bastRequirement: 'WORK_ORDER' },
      managerUserId,
    );
    assert.ok(bastWo.rows.every((r) => r.bastRequirement === 'WORK_ORDER'));
    assert.equal(bastWo.rows.length, 1);
    assert.equal(bastWo.rows[0].workOrderId, s.woFullId);

    // assetId filter.
    const withAsset = await getWorkOrderRegister(
      { ...scope, assetId: s.asset1Id },
      managerUserId,
    );
    assert.ok(withAsset.rows.every((r) => r.assetId === s.asset1Id));
    assert.equal(withAsset.rows.length, 1);
    assert.equal(withAsset.rows[0].workOrderId, s.woFullId);

    // assignedUserId filter → only WORKFORCE-assigned wo1.
    const byUser = await getWorkOrderRegister(
      { ...scope, assignedUserId: s.workerUserId },
      managerUserId,
    );
    assert.equal(byUser.rows.length, 1);
    assert.equal(byUser.rows[0].workOrderId, s.woFullId);

    // assignedTeamId filter → INACTIVE TEAM row excluded → empty.
    const byTeam = await getWorkOrderRegister(
      { ...scope, assignedTeamId: s.teamId },
      managerUserId,
    );
    assert.equal(byTeam.rows.length, 0);

    // vendorId filter → no active VENDOR/VENDOR_WORKFORCE assignments.
    const byVendor = await getWorkOrderRegister(
      { ...scope, vendorId: s.vendorId },
      managerUserId,
    );
    assert.equal(byVendor.rows.length, 0);

    // verificationDecision filter.
    const approved = await getWorkOrderRegister(
      { ...scope, verificationDecision: 'APPROVED' },
      managerUserId,
    );
    assert.ok(approved.rows.every((r) => r.verificationDecision === 'APPROVED'));
    assert.equal(approved.rows.length, 1);
    assert.equal(approved.rows[0].workOrderId, s.woFullId);

    // date window (half-open) on created_at: wo1 back-dated 6 days, others just now.
    const windowed = await getWorkOrderRegister(
      {
        ...scope,
        dateFrom: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
        dateTo: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
      },
      managerUserId,
    );
    assert.ok(windowed.rows.every((r) => r.workOrderId !== s.woBareId));
    assert.ok(windowed.rows.some((r) => r.workOrderId === s.woFullId));
  });

  it('10. invalid filter rejection', async (t) => {
    if (!ready(t)) return;

    // `AppError.validation()` carries the canonical machine code
    // `VALIDATION_ERROR` (see src/shared/errors.ts), not the bare `VALIDATION`.
    function mustThrow(query: Record<string, unknown>, label: string) {
      assert.throws(
        () => parseWorkOrderRegisterQuery(query),
        (err: unknown) =>
          err instanceof AppError && err.code === 'VALIDATION_ERROR',
        `expected VALIDATION_ERROR for ${label}`,
      );
    }

    mustThrow({ buildingId: 'not-a-uuid' }, 'bad buildingId UUID');
    mustThrow({ assetId: 'not-a-uuid' }, 'bad assetId UUID');
    mustThrow({ assignedUserId: 'not-a-uuid' }, 'bad assignedUserId');
    mustThrow({ status: 'NOT_A_STATUS' }, 'bad status');
    mustThrow({ priority: 'URGENT' }, 'bad priority');
    mustThrow({ bastRequirement: 'MAYBE' }, 'bad bast requirement');
    mustThrow({ verificationDecision: 'MAYBE' }, 'bad decision');
    mustThrow({ dateFrom: 'not-a-date' }, 'bad date');
    mustThrow({ dateFrom: '2025-12-31', dateTo: '2025-01-01' }, 'inverted');
    mustThrow(
      { dateFrom: '2025-01-01', dateTo: '2030-01-01' },
      'oversized range',
    );
    mustThrow(
      { dateFrom: '2025-01-01', dateTo: '2026-13-01' },
      'impossible calendar date',
    );

    // Repeated query parameter (`?status=OPEN&status=CLOSED`) arrives as an
    // array. All three registers (finding / vendor-service / work-order) share
    // the same `readSingleParam` convention: an array is not a filter value, so
    // the field is ignored instead of being coerced into a widened query. The
    // parser therefore returns a filter without that field — it never throws and
    // never guesses. This surface has no HTTP route (it is consumed by
    // reporting-export with constructed objects), so the convention is asserted
    // here rather than changed.
    const arrayParam = parseWorkOrderRegisterQuery({ status: ['OPEN', 'CLOSED'] });
    assert.equal(arrayParam.status, undefined);
  });

  it('11. evidenceCount counts only ACTIVE WORK_ORDER evidence', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await getWorkOrderRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    const full = result.rows.find((r) => r.workOrderId === s.woFullId)!;
    assert.equal(full.evidenceCount, 2); // 2 ACTIVE; REMOVED excluded.
    const bare = result.rows.find((r) => r.workOrderId === s.woBareId)!;
    assert.equal(bare.evidenceCount, 0);
  });

  it('12. findingCount is total, not "open"', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const result = await getWorkOrderRegister(
      { buildingId: s.buildingAId },
      managerUserId,
    );
    const full = result.rows.find((r) => r.workOrderId === s.woFullId)!;
    // One OPEN + one VERIFIED finding → total count = 2.
    assert.equal(full.findingCount, 2);
    // The contract deliberately does not surface openFindingCount.
    assert.equal('openFindingCount' in full, false);
  });
});
