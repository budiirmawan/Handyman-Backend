import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { findingService } from '../src/modules/findings';
import { organizationService } from '../src/modules/organizations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C05 PART 02 — Executor Finding rework permission-route alignment.
 *
 * Route gates must mirror the BE-09J action authority:
 *   - executor rework notes + resubmit → finding.read + finding.execute
 *     + current ACTIVE assignee (enforced server-side in the action authority
 *     and service),
 *   - request rework (reviewer)         → finding.review (+ current reviewer),
 *   - reject                            → finding.review (unchanged),
 *   - cancel / patch finding            → finding.manage (unchanged).
 *
 * Proves a field executor holding ONLY finding.read + finding.execute (no
 * finding.manage / finding.review) can update rework notes and resubmit,
 * while non-assignees, inactive assignees, non-executors, manage-only users
 * and cross-Building users are all rejected. No current-shift gate is
 * introduced; lifecycle and verification semantics are untouched.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    'TRUNCATE finding_rework_cycles, reviews, finding_assignments, findings, users, roles, clients CASCADE',
  );
  database = db;
});
after(async () => {
  if (pool) await closePool(pool);
  pool = null;
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
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Authenticated user whose role carries exactly the given permissions. */
async function scopedUser(
  prefix: string,
  permissions: string[],
): Promise<{ userId: string; token: string }> {
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: `${prefix} user`,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: `${prefix} Role`,
  });
  for (const code of permissions) {
    let permission = await permissionRepository.findByCode(code);
    if (!permission) {
      permission = await permissionService.createPermission({ code, name: code });
    }
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

type ReworkItem = {
  findingId: string;
  buildingId: string;
  /** The current ACTIVE assignee (finding.execute holder). */
  executor: { userId: string; token: string; profileId: string };
  /** The reviewer who opens review + requests rework. */
  reviewer: { userId: string; token: string };
};

/**
 * Builds a finding driven to REWORK_REQUIRED.
 *
 *   - `assigner` (needs finding.assign) creates the assignment and marks
 *     ASSIGNED,
 *   - `executor` (finding.execute) is the current ACTIVE assignee who drives
 *     IN_PROGRESS + PENDING_REVIEW,
 *   - `reviewer` (finding.review) opens the review and requests rework,
 *     becoming the reviewer identity bound to the rework cycle.
 */
async function driveToReworkRequired(
  executor: { userId: string; token: string },
  assigner: { userId: string; token: string },
  reviewer: { userId: string; token: string },
): Promise<ReworkItem> {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  // assigner / reviewer may be the same admin user; never double-assign.
  const assignedUserIds = new Set<string>();
  for (const actor of [assigner, executor, reviewer]) {
    if (!assignedUserIds.has(actor.userId)) {
      await buildingAssignmentService.createAssignment(actor.userId, {
        buildingId: building.id,
      });
      assignedUserIds.add(actor.userId);
    }
  }

  // Executor's ACTIVE workforce profile (same client as the building, so the
  // workforce building assignment is legal) becomes the finding assignee.
  const org = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Organization',
  });
  const dept = await departmentService.createDepartment({
    organizationId: org.id,
    code: `D_${suffix()}`,
    name: 'Department',
  });
  const pos = await positionService.createPosition({
    organizationId: org.id,
    code: `P_${suffix()}`,
    name: 'Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: dept.id,
    positionId: pos.id,
    userId: executor.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Executing worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: building.id,
  });

  const finding = await findingService.createFinding({
    clientId: client.id,
    buildingId: building.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Rework executor finding',
    reportedByUserId: assigner.userId,
  });

  const assignment = await api()
    .post(`/api/v1/findings/${finding.id}/assignments`)
    .set(auth(assigner.token))
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.body));

  const assignState = await api()
    .patch(`/api/v1/findings/${finding.id}/state`)
    .set(auth(assigner.token))
    .send({ state: 'ASSIGNED' });
  assert.equal(assignState.status, 200, JSON.stringify(assignState.body));

  const start = await api()
    .patch(`/api/v1/findings/${finding.id}/state`)
    .set(auth(executor.token))
    .send({ state: 'IN_PROGRESS' });
  assert.equal(start.status, 200, JSON.stringify(start.body));

  const submit = await api()
    .patch(`/api/v1/findings/${finding.id}/state`)
    .set(auth(executor.token))
    .send({ state: 'PENDING_REVIEW' });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));

  const review = await api()
    .post(`/api/v1/findings/${finding.id}/reviews`)
    .set(auth(reviewer.token))
    .send({ notes: 'Review opened' });
  assert.equal(review.status, 201, JSON.stringify(review.body));

  const rework = await api()
    .post(`/api/v1/findings/${finding.id}/rework`)
    .set(auth(reviewer.token))
    .send({ reason: 'Correct the executor work' });
  assert.equal(rework.status, 201, JSON.stringify(rework.body));
  assert.equal(rework.body.data.rework.status, 'REQUESTED');

  return {
    findingId: finding.id,
    buildingId: building.id,
    executor: { ...executor, profileId: profile.id },
    reviewer,
  };
}

async function executorUser(prefix: string): Promise<{ userId: string; token: string }> {
  return scopedUser(prefix, ['finding.read', 'finding.execute']);
}

describe('MOB-C05 PART 02 executor rework route alignment', () => {
  it('active assignee with only finding.read+finding.execute updates rework notes', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('execnotes');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    const res = await api()
      .patch(`/api/v1/findings/${item.findingId}/rework`)
      .set(auth(executor.token))
      .send({ notes: 'Executor updated the rework notes' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.reworkNotes, 'Executor updated the rework notes');
  });

  it('active assignee with only finding.read+finding.execute resubmits', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('execsub');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/resubmit`)
      .set(auth(executor.token))
      .send({ notes: 'Executor rework complete' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.rework.status, 'RESUBMITTED');
    assert.equal(res.body.data.rework.resubmittedByUserId, executor.userId);
  });

  it('a non-assignee holding finding.execute is rejected from resubmit', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('execnone');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    const stranger = await scopedUser('stranger', ['finding.read', 'finding.execute']);
    // Give the stranger Building access so rejection is specifically because
    // they are NOT the current active assignee (not an isolation artefact).
    await buildingAssignmentService.createAssignment(stranger.userId, {
      buildingId: item.buildingId,
    });
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/resubmit`)
      .set(auth(stranger.token))
      .send({ notes: 'Impostor resubmit' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('an inactive (deactivated) assignee is rejected from resubmit', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('execinact');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    await pool!.query("UPDATE workforce_profiles SET status = 'INACTIVE' WHERE id = $1", [
      item.executor.profileId,
    ]);
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/resubmit`)
      .set(auth(executor.token))
      .send({ notes: 'Deactivated resubmit' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('a finding.read-only user (no finding.execute) is rejected at the route', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('execroute');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    const readOnly = await scopedUser('readonly', ['finding.read']);
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/resubmit`)
      .set(auth(readOnly.token))
      .send({ notes: 'No execute' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('a finding.manage-only user does not gain executor resubmit', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('execmgr');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    const manageOnly = await scopedUser('mgr', ['finding.read', 'finding.manage']);
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/resubmit`)
      .set(auth(manageOnly.token))
      .send({ notes: 'Manage does not imply execute' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('finding.execute-only executor cannot request rework (reviewer authority)', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('exreq');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/rework`)
      .set(auth(executor.token))
      .send({ reason: 'Executor cannot request rework' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('a finding.review-only reviewer can request rework', async (t) => {
    if (!ready(t)) return;
    // The assigner must hold finding.assign; a finding.review-only user opens
    // the review and requests rework, proving request-rework = finding.review.
    const assigner = await createAdminUser();
    const executor = await executorUser('exrev');
    const reviewOnly = await scopedUser('revonly', ['finding.read', 'finding.review']);
    const item = await driveToReworkRequired(executor, assigner, reviewOnly);
    // A fresh finding in REWORK_REQUIRED created by the review-only reviewer;
    // requesting rework again on the SAME cycle is already-open, so assert the
    // review-only reviewer identity was bound correctly by re-driving: instead,
    // confirm the reviewOnly reviewer could request rework during setup already
    // (201 in driveToReworkRequired) and that executor cannot.
    assert.ok(item.reviewer.token, 'review-only reviewer identity present');
    const denied = await api()
      .post(`/api/v1/findings/${item.findingId}/rework`)
      .set(auth(executor.token))
      .send({ reason: 'Executor cannot request rework' });
    assert.equal(denied.status, 403);
  });

  it('wrong lifecycle state rejects resubmit', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('exlife');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    // Resubmit already completed once would move to PENDING_REVIEW; instead
    // cancel the finding (finding.manage, reviewer) and assert further
    // resubmit is rejected from a terminal/invalid state.
    const stateRes = await api()
      .patch(`/api/v1/findings/${item.findingId}/state`)
      .set(auth(reviewer.token))
      .send({ state: 'CANCELLED' });
    assert.equal(stateRes.status, 200, JSON.stringify(stateRes.body));
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/resubmit`)
      .set(auth(executor.token))
      .send({ notes: 'Wrong state' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('cross-Building inaccessible user is rejected from resubmit', async (t) => {
    if (!ready(t)) return;
    const reviewer = await createAdminUser();
    const executor = await executorUser('execross');
    const item = await driveToReworkRequired(executor, reviewer, reviewer);
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other client',
    });
    const otherProp = await propertyService.createProperty({
      clientId: otherClient.id,
      code: `P_${suffix()}`,
      name: 'Other property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProp.id,
      code: `B_${suffix()}`,
      name: 'Other building',
    });
    const outsider = await scopedUser('outsider', ['finding.read', 'finding.execute']);
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: otherBuilding.id,
    });
    const res = await api()
      .post(`/api/v1/findings/${item.findingId}/resubmit`)
      .set(auth(outsider.token))
      .send({ notes: 'Cross building' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
