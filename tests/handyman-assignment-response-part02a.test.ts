import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import {
  closePool,
  initDatabase,
  migrateUp,
  withTransaction,
} from '../src/database';
import {
  assignmentResponseRepository,
  notifyWorkOrderAssignedPending,
} from '../src/modules/assignment-responses';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
import { teamService } from '../src/modules/teams';
import { userService } from '../src/modules/users';
import { workOrderAssignmentRepository } from '../src/modules/work-order-assignments';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDbHandle,
} from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-ASSIGNMENT-RESPONSE-01 PART 02A — Assignment Response Core & Standard
 * Work Order (disposable PostgreSQL integration test suite).
 */

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-part02a-assignment-response-pg';
const DB_PORT = 55579;

let dbHandle: EmbeddedTestDbHandle | null = null;
let pool: Pool | null = null;

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function createUserWithPermissions(
  permissionCodes: string[],
  displayName = 'Scoped User',
): Promise<{ userId: string; token: string }> {
  const password = 'Password123!';
  const user = await userService.createUser({
    email: `user_${suffix().toLowerCase()}@example.com`,
    displayName,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });

  if (permissionCodes.length > 0) {
    const role = await roleService.createRole({
      code: `ROLE_${suffix()}`,
      name: `Role ${suffix()}`,
    });
    for (const code of permissionCodes) {
      let perm = await permissionRepository.findByCode(code);
      if (!perm) {
        perm = await permissionRepository.createPermission({
          code,
          name: code,
        });
      }
      await permissionService.assignPermissionToRole(role.id, perm.id);
    }
    await roleService.assignRoleToUser(user.id, role.id);
  }

  const login = await api().post(`${V1}/auth/login`).send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200);
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

async function setupStandardWorkOrderFixture(options?: {
  withSla?: boolean;
}) {
  const ops = await createAdminUser();
  const workerA = await createAdminUser();
  const workerB = await createAdminUser();

  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Part02A Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Part02A Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Part02A Building',
  });

  for (const actor of [ops, workerA, workerB]) {
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: building.id,
    });
  }

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'Part02A Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Part02A Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Part02A Position',
  });

  const profileA = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: workerA.userId,
    employeeCode: `WFA_${suffix()}`,
    fullName: 'Worker Alpha',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profileA.id,
    buildingId: building.id,
  });

  const profileB = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: workerB.userId,
    employeeCode: `WFB_${suffix()}`,
    fullName: 'Worker Bravo',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profileB.id,
    buildingId: building.id,
  });

  if (options?.withSla) {
    await slaDefinitionRepository.create({
      clientId: client.id,
      code: `SLA_${suffix()}`,
      name: 'Part02A Response SLA',
      operationalType: 'WORK_ORDER',
      workType: 'REPAIR',
      responseTargetMinutes: 30,
      resolutionTargetMinutes: 120,
      effectiveFrom: '2026-01-01T00:00:00Z',
    });
  }

  const wo = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Perbaikan Pipa Air Bersih',
    workType: 'REPAIR',
    createdByUserId: ops.userId,
  });

  return {
    ops,
    workerA,
    workerB,
    client,
    property,
    building,
    organization,
    department,
    position,
    profileA,
    profileB,
    wo,
  };
}

before(async () => {
  await rm(DB_DIR, { recursive: true, force: true });
  dbHandle = await startEmbeddedTestDatabase({ dir: DB_DIR, port: DB_PORT });
  resetAppConfigCache();
  const config = await ensureTestDatabase();
  if (!config) {
    throw new Error('Embedded PostgreSQL test database failed to initialize');
  }
  pool = await initDatabase(config);
  await migrateUp(pool);
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (dbHandle) await dbHandle.stop();
  } finally {
    await rm(DB_DIR, { recursive: true, force: true });
    resetAppConfigCache();
  }
});

describe('CR-HM-ASSIGNMENT-RESPONSE-01 PART 02A — Standard Work Order Assignment Response', () => {
  it('1. Assign -> PENDING -> IN_APP notification to individual worker and authorized Team members', async () => {
    const f = await setupStandardWorkOrderFixture();

    const assigned = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });

    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.status, 'ACTIVE');
    assert.equal(assigned.body.data.responseStatus, 'PENDING');
    assert.equal(assigned.body.data.respondedByUserId, null);
    assert.equal(assigned.body.data.respondedAt, null);
    assert.equal(assigned.body.data.declineReason, null);
    assert.equal(assigned.body.data.reassignmentRequired, false);

    // Worker A receives exactly one IN_APP notification with WORK_ORDER_FIELD_WORK target.
    const inboxA = await api()
      .get(`${V1}/notifications`)
      .set(auth(f.workerA.token));
    assert.equal(inboxA.status, 200);
    const pendingNotifsA = (inboxA.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'WORK_ORDER_ASSIGNMENT' &&
        n.sourceEntityId === assigned.body.data.id &&
        n.sourceEventType === 'WORK_ORDER_ASSIGNMENT_PENDING',
    );
    assert.equal(pendingNotifsA.length, 1);
    assert.equal(pendingNotifsA[0].channel, 'IN_APP');
    assert.equal(pendingNotifsA[0].status, 'UNREAD');
    assert.deepEqual(pendingNotifsA[0].navigationTarget, {
      type: 'WORK_ORDER_FIELD_WORK',
      id: f.wo.id,
    });

    // Unassigned Worker B receives no notification for this assignment.
    const inboxB = await api()
      .get(`${V1}/notifications`)
      .set(auth(f.workerB.token));
    assert.equal(inboxB.status, 200);
    assert.equal(
      (inboxB.body.data as any[]).filter(
        (n) => n.sourceEntityId === assigned.body.data.id,
      ).length,
      0,
    );

    // Decision history records ASSIGNMENT_PENDING_CREATED.
    const history = await api()
      .get(
        `${V1}/work-orders/${f.wo.id}/assignments/${assigned.body.data.id}/response-history`,
      )
      .set(auth(f.ops.token));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].eventType, 'ASSIGNMENT_PENDING_CREATED');
    assert.equal(history.body.data[0].newStatus, 'PENDING');

    // TEAM assignment notifies only active linked team members.
    const team = await teamService.createTeam({
      departmentId: f.department.id,
      code: `TM_${suffix()}`,
      name: 'Engineering Team',
    });
    await workforceService.updateWorkforceProfile(f.profileB.id, {
      teamId: team.id,
    });
    const woTeam = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Inspeksi Panel',
      workType: 'MAINTENANCE',
      createdByUserId: f.ops.userId,
    });
    const teamAssign = await api()
      .post(`${V1}/work-orders/${woTeam.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'TEAM',
        teamId: team.id,
      });
    assert.equal(teamAssign.status, 201);
    assert.equal(teamAssign.body.data.responseStatus, 'PENDING');

    const inboxBAfterTeam = await api()
      .get(`${V1}/notifications`)
      .set(auth(f.workerB.token));
    const teamNotifsB = (inboxBAfterTeam.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'WORK_ORDER_ASSIGNMENT' &&
        n.sourceEntityId === teamAssign.body.data.id,
    );
    assert.equal(teamNotifsB.length, 1);
  });

  it('2. TERIMA integrates with ACKNOWLEDGE without duplicating action, event, SLA, or notification', async () => {
    const f = await setupStandardWorkOrderFixture({ withSla: true });

    const assigned = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });
    assert.equal(assigned.status, 201);
    const assignmentId = assigned.body.data.id as string;

    // Worker A responds TERIMA via assignment-ID endpoint.
    const accepted = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerA.token))
      .send({
        decision: 'TERIMA',
        notes: 'Siap menuju lokasi sekarang',
      });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.responseStatus, 'TERIMA');
    assert.equal(accepted.body.data.respondedByUserId, f.workerA.userId);
    assert.ok(accepted.body.data.respondedAt);
    assert.equal(accepted.body.data.declineReason, null);
    assert.equal(
      accepted.body.data.responseNotes,
      'Siap menuju lokasi sekarang',
    );
    assert.equal(accepted.body.data.reassignmentRequired, false);

    // Work Order status transitioned OPEN -> ASSIGNED.
    const woAfter = await api()
      .get(`${V1}/work-orders/${f.wo.id}`)
      .set(auth(f.ops.token));
    assert.equal(woAfter.status, 200);
    assert.equal(woAfter.body.data.status, 'ASSIGNED');

    // Subsequent call to POST /work-orders/:id/acknowledge is idempotent and does not duplicate actions/events/SLA.
    const ackReplay = await api()
      .post(`${V1}/work-orders/${f.wo.id}/acknowledge`)
      .set(auth(f.workerA.token))
      .send({ notes: 'Replay acknowledge' });
    assert.equal(ackReplay.status, 201);
    assert.equal(ackReplay.body.data.actionType, 'ACKNOWLEDGED');

    // Subsequent call to POST /work-orders/:id/assignments/:assignmentId/respond with TERIMA is also idempotent.
    const respondReplay = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerA.token))
      .send({ decision: 'TERIMA' });
    assert.equal(respondReplay.status, 200);
    assert.equal(respondReplay.body.data.responseStatus, 'TERIMA');

    // Verify strictly ONE ACKNOWLEDGED action in work_order_actions.
    const actions = await api()
      .get(`${V1}/work-orders/${f.wo.id}/actions`)
      .set(auth(f.ops.token));
    assert.equal(actions.status, 200);
    const ackActions = (actions.body.data as any[]).filter(
      (a) => a.actionType === 'ACKNOWLEDGED',
    );
    assert.equal(ackActions.length, 1);

    // Verify strictly ONE WORK_ORDER_EXECUTION_ACTION event for ACKNOWLEDGED.
    const history = await api()
      .get(
        `${V1}/work-orders/${f.wo.id}/history?eventType=WORK_ORDER_EXECUTION_ACTION`,
      )
      .set(auth(f.ops.token));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 1);

    // Verify SLA RESPONSE clock is satisfied exactly once.
    const sla = await api()
      .get(`${V1}/work-orders/${f.wo.id}/sla`)
      .set(auth(f.ops.token));
    assert.equal(sla.status, 200);
    const responseClock = (sla.body.data.clocks as any[]).find(
      (c) => c.clockType === 'RESPONSE',
    );
    assert.ok(responseClock);
    assert.ok(responseClock.metAt || responseClock.respondedAt || responseClock.status);

    // Verify Operations receives strictly ONE WORK_ORDER_ASSIGNMENT_ACCEPTED notification.
    const opsInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(f.ops.token));
    assert.equal(opsInbox.status, 200);
    const acceptedNotifs = (opsInbox.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'WORK_ORDER_ASSIGNMENT' &&
        n.sourceEntityId === assignmentId &&
        n.sourceEventType === 'WORK_ORDER_ASSIGNMENT_ACCEPTED',
    );
    assert.equal(acceptedNotifs.length, 1);
  });

  it('3. TIDAK_BISA requires mandatory reason, preserves Tenant Work Order, notifies Operations, and blocks START', async () => {
    const f = await setupStandardWorkOrderFixture();

    const assigned = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });
    assert.equal(assigned.status, 201);
    const assignmentId = assigned.body.data.id as string;

    // Missing declineReason -> 400 VALIDATION_ERROR.
    const missingReason = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerA.token))
      .send({ decision: 'TIDAK_BISA' });
    assert.equal(missingReason.status, 400);
    assert.equal(missingReason.body.error.code, 'VALIDATION_ERROR');

    // Blank declineReason -> 400 VALIDATION_ERROR.
    const blankReason = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerA.token))
      .send({ decision: 'TIDAK_BISA', declineReason: '   ' });
    assert.equal(blankReason.status, 400);
    assert.equal(blankReason.body.error.code, 'VALIDATION_ERROR');

    // Valid TIDAK_BISA with reason.
    const declined = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerA.token))
      .send({
        decision: 'TIDAK_BISA',
        declineReason: 'Sedang menangani pipa pecah darurat di Tower B',
      });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(declined.body.data.respondedByUserId, f.workerA.userId);
    assert.ok(declined.body.data.respondedAt);
    assert.equal(
      declined.body.data.declineReason,
      'Sedang menangani pipa pecah darurat di Tower B',
    );
    assert.equal(declined.body.data.reassignmentRequired, true);

    // Tenant Work Order is NOT cancelled.
    const woCheck = await api()
      .get(`${V1}/work-orders/${f.wo.id}`)
      .set(auth(f.ops.token));
    assert.equal(woCheck.status, 200);
    assert.notEqual(woCheck.body.data.status, 'CANCELLED');
    assert.equal(woCheck.body.data.status, 'OPEN');

    // Operations reads current assignment and sees TIDAK_BISA + reassignmentRequired = true.
    const currentForOps = await api()
      .get(`${V1}/work-orders/${f.wo.id}/assignments/current`)
      .set(auth(f.ops.token));
    assert.equal(currentForOps.status, 200);
    assert.equal(currentForOps.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(currentForOps.body.data.reassignmentRequired, true);

    // Operations receives IN_APP notification for TIDAK_BISA.
    const opsInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(f.ops.token));
    assert.equal(opsInbox.status, 200);
    const declineNotifs = (opsInbox.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'WORK_ORDER_ASSIGNMENT' &&
        n.sourceEntityId === assignmentId &&
        n.sourceEventType === 'WORK_ORDER_ASSIGNMENT_DECLINED',
    );
    assert.equal(declineNotifs.length, 1);
    assert.equal(
      declineNotifs[0].metadata.declineReason,
      'Sedang menangani pipa pecah darurat di Tower B',
    );
    assert.equal(declineNotifs[0].metadata.reassignmentRequired, true);

    // Contradictory transition TIDAK_BISA -> TERIMA on same assignment is rejected (409).
    const flipAttempt = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerA.token))
      .send({ decision: 'TERIMA' });
    assert.equal(flipAttempt.status, 409);
    assert.equal(
      flipAttempt.body.error.code,
      'WORK_ORDER_ASSIGNMENT_RESPONSE_CONFLICT',
    );

    const ackAfterDecline = await api()
      .post(`${V1}/work-orders/${f.wo.id}/acknowledge`)
      .set(auth(f.workerA.token))
      .send({});
    assert.equal(ackAfterDecline.status, 409);
    assert.equal(
      ackAfterDecline.body.error.code,
      'WORK_ORDER_ASSIGNMENT_RESPONSE_CONFLICT',
    );

    // Worker A who declined cannot execute START under that assignment (409 WORK_ORDER_ASSIGNMENT_DECLINED).
    const startAfterDecline = await api()
      .post(`${V1}/work-orders/${f.wo.id}/start`)
      .set(auth(f.workerA.token))
      .send({});
    assert.equal(startAfterDecline.status, 409);
    assert.equal(
      startAfterDecline.body.error.code,
      'WORK_ORDER_ASSIGNMENT_DECLINED',
    );

    // Mobile feed suppresses ACKNOWLEDGE and START for the declined assignment.
    const feedA = await api()
      .get(`${V1}/mobile/assignments`)
      .set(auth(f.workerA.token));
    assert.equal(feedA.status, 200);
    const feedItem = (feedA.body.data as any[]).find(
      (item) => item.reference.workOrderId === f.wo.id,
    );
    assert.ok(feedItem);
    assert.equal(feedItem.availableActions.includes('ACKNOWLEDGE'), false);
    assert.equal(feedItem.availableActions.includes('START'), false);
  });

  it('4. Atomic reassignment supersedes old assignment, preserves historical response, and creates new PENDING assignment', async () => {
    const f = await setupStandardWorkOrderFixture();

    // Assign to Worker A -> Worker A declines (TIDAK_BISA).
    const first = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });
    assert.equal(first.status, 201);
    const firstId = first.body.data.id as string;

    const declined = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${firstId}/respond`)
      .set(auth(f.workerA.token))
      .send({
        decision: 'TIDAK_BISA',
        declineReason: 'Peralatan las sedang diperbaiki',
      });
    assert.equal(declined.status, 200);

    // Operations reassigns to Worker B.
    const reassigned = await api()
      .patch(`${V1}/work-orders/${f.wo.id}/assignments/${firstId}`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileB.id,
      });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
    const secondId = reassigned.body.data.id as string;
    assert.notEqual(secondId, firstId);
    assert.equal(reassigned.body.data.status, 'ACTIVE');
    assert.equal(reassigned.body.data.workforceProfileId, f.profileB.id);
    assert.equal(reassigned.body.data.responseStatus, 'PENDING');
    assert.equal(reassigned.body.data.declineReason, null);
    assert.equal(reassigned.body.data.reassignmentRequired, false);

    // Idempotent retry of the exact same reassignment payload creates no duplicate assignment or notification.
    const retryReassign = await api()
      .patch(`${V1}/work-orders/${f.wo.id}/assignments/${firstId}`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileB.id,
      });
    assert.equal(retryReassign.status, 200);
    assert.equal(retryReassign.body.data.id, secondId);

    // Old assignment retains historical TIDAK_BISA response and has status INACTIVE.
    const allAssignments = await api()
      .get(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token));
    assert.equal(allAssignments.status, 200);
    assert.equal(allAssignments.body.data.length, 2);
    assert.equal(allAssignments.body.data[0].id, firstId);
    assert.equal(allAssignments.body.data[0].status, 'INACTIVE');
    assert.equal(allAssignments.body.data[0].responseStatus, 'TIDAK_BISA');
    assert.equal(allAssignments.body.data[0].reassignmentRequired, false);
    assert.equal(allAssignments.body.data[1].id, secondId);
    assert.equal(allAssignments.body.data[1].status, 'ACTIVE');
    assert.equal(allAssignments.body.data[1].responseStatus, 'PENDING');

    // Old assignment history includes ASSIGNMENT_PENDING_CREATED -> ASSIGNMENT_DECLINED -> ASSIGNMENT_SUPERSEDED.
    const firstHistory = await api()
      .get(
        `${V1}/work-orders/${f.wo.id}/assignments/${firstId}/response-history`,
      )
      .set(auth(f.ops.token));
    assert.equal(firstHistory.status, 200);
    assert.deepEqual(
      (firstHistory.body.data as any[]).map((e) => e.eventType),
      [
        'ASSIGNMENT_PENDING_CREATED',
        'ASSIGNMENT_DECLINED',
        'ASSIGNMENT_SUPERSEDED',
      ],
    );

    // Worker A cannot respond to the superseded assignment (409 WORK_ORDER_ASSIGNMENT_SUPERSEDED).
    const lateRespondOld = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${firstId}/respond`)
      .set(auth(f.workerA.token))
      .send({ decision: 'TERIMA' });
    assert.equal(lateRespondOld.status, 409);
    assert.equal(
      lateRespondOld.body.error.code,
      'WORK_ORDER_ASSIGNMENT_SUPERSEDED',
    );

    // Worker A cannot execute actions on the Work Order anymore (403 WORK_ORDER_EXECUTION_UNAUTHORIZED).
    const startByOldWorker = await api()
      .post(`${V1}/work-orders/${f.wo.id}/start`)
      .set(auth(f.workerA.token))
      .send({});
    assert.equal(startByOldWorker.status, 403);
    assert.equal(
      startByOldWorker.body.error.code,
      'WORK_ORDER_EXECUTION_UNAUTHORIZED',
    );

    // Worker B receives exactly one PENDING notification and can accept (TERIMA) and START.
    const inboxB = await api()
      .get(`${V1}/notifications`)
      .set(auth(f.workerB.token));
    assert.equal(inboxB.status, 200);
    const notifsB = (inboxB.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'WORK_ORDER_ASSIGNMENT' &&
        n.sourceEntityId === secondId &&
        n.sourceEventType === 'WORK_ORDER_ASSIGNMENT_PENDING',
    );
    assert.equal(notifsB.length, 1);

    const acceptB = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${secondId}/respond`)
      .set(auth(f.workerB.token))
      .send({ decision: 'TERIMA' });
    assert.equal(acceptB.status, 200);
    assert.equal(acceptB.body.data.responseStatus, 'TERIMA');

    const startB = await api()
      .post(`${V1}/work-orders/${f.wo.id}/start`)
      .set(auth(f.workerB.token))
      .send({});
    assert.equal(startB.status, 201);
    assert.equal(startB.body.data.actionType, 'STARTED');
  });

  it('5. Transaction rollback leaves zero phantom assignments, response rows, or IN_APP notifications', async () => {
    const f = await setupStandardWorkOrderFixture();

    const beforeAssignCount = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_order_assignments WHERE work_order_id = $1`,
      [f.wo.id],
    );
    const beforeNotifCount = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1`,
      [f.workerA.userId],
    );

    await assert.rejects(
      async () => {
        await withTransaction(async (tx) => {
          const created = await workOrderAssignmentRepository.create(
            {
              workOrderId: f.wo.id,
              assigneeType: 'WORKFORCE',
              workforceProfileId: f.profileA.id,
              teamId: null,
              vendorId: null,
              assignedByUserId: f.ops.userId,
            },
            tx,
          );
          await assignmentResponseRepository.ensurePendingForAssignment(
            {
              clientId: f.client.id,
              buildingId: f.building.id,
              assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
              assignmentId: created.id,
              workOrderId: f.wo.id,
              assignedByUserId: f.ops.userId,
              assignedAt: created.assignedAt,
            },
            tx,
          );
          await notifyWorkOrderAssignedPending(f.wo, created, tx);
          throw new Error('SIMULATED_ASSIGNMENT_TX_FAILURE');
        });
      },
      /SIMULATED_ASSIGNMENT_TX_FAILURE/,
    );

    const afterAssignCount = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_order_assignments WHERE work_order_id = $1`,
      [f.wo.id],
    );
    const afterRespCount = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM handyman_assignment_responses WHERE work_order_id = $1`,
      [f.wo.id],
    );
    const afterNotifCount = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1`,
      [f.workerA.userId],
    );

    assert.equal(afterAssignCount.rows[0].n, beforeAssignCount.rows[0].n);
    assert.equal(afterRespCount.rows[0].n, 0);
    assert.equal(afterNotifCount.rows[0].n, beforeNotifCount.rows[0].n);
  });

  it('6. Enforces session authentication, RBAC permissions, Building/Client isolation, and assignee authority', async () => {
    const f = await setupStandardWorkOrderFixture();

    const assigned = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });
    assert.equal(assigned.status, 201);
    const assignmentId = assigned.body.data.id as string;

    // 401 unauthenticated.
    const unauthRespond = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .send({ decision: 'TERIMA' });
    assert.equal(unauthRespond.status, 401);

    const unauthHistory = await api().get(
      `${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/response-history`,
    );
    assert.equal(unauthHistory.status, 401);

    // 403 missing permission.
    const noPermUser = await createUserWithPermissions([]);
    await buildingAssignmentService.createAssignment(noPermUser.userId, {
      buildingId: f.building.id,
    });
    const noPermRespond = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(noPermUser.token))
      .send({ decision: 'TERIMA' });
    assert.equal(noPermRespond.status, 403);
    assert.equal(noPermRespond.body.error.code, 'PERMISSION_DENIED');

    // 403 cross-Building / cross-Client denial.
    const crossClientUser = await createAdminUser();
    const crossRespond = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(crossClientUser.token))
      .send({ decision: 'TERIMA' });
    assert.equal(crossRespond.status, 403);
    assert.equal(crossRespond.body.error.code, 'BUILDING_ACCESS_DENIED');

    // 403 non-assignee worker in the same building.
    const wrongWorkerRespond = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerB.token))
      .send({ decision: 'TERIMA' });
    assert.equal(wrongWorkerRespond.status, 403);
    assert.equal(
      wrongWorkerRespond.body.error.code,
      'WORK_ORDER_EXECUTION_UNAUTHORIZED',
    );

    // Real MOBILE_STAFF_ROLE worker (work_order.read ONLY, NO work_order.manage)
    // can respond to their own assignment, while being denied Operations management routes.
    const mobileWorker = await createUserWithPermissions(
      ['work_order.read'],
      'Mobile Staff Worker',
    );
    await buildingAssignmentService.createAssignment(mobileWorker.userId, {
      buildingId: f.building.id,
    });
    const mobileProfile = await workforceService.createWorkforceProfile({
      organizationId: f.organization.id,
      departmentId: f.department.id,
      positionId: f.position.id,
      userId: mobileWorker.userId,
      employeeCode: `WFM_${suffix()}`,
      fullName: 'Mobile Staff Worker',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: mobileProfile.id,
      buildingId: f.building.id,
    });

    // Mobile worker cannot reassign (requires work_order.manage -> 403 PERMISSION_DENIED)
    const illegalManageByWorker = await api()
      .patch(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}`)
      .set(auth(mobileWorker.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: mobileProfile.id,
      });
    assert.equal(illegalManageByWorker.status, 403);
    assert.equal(illegalManageByWorker.body.error.code, 'PERMISSION_DENIED');

    // Operations reassigns to mobileWorker
    const reassignedToMobile = await api()
      .patch(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: mobileProfile.id,
      });
    assert.equal(reassignedToMobile.status, 200);
    const mobileAssignmentId = reassignedToMobile.body.data.id as string;

    // Mobile worker with work_order.read (and NO work_order.manage) responds TERIMA -> 200 OK
    const mobileRespond = await api()
      .post(
        `${V1}/work-orders/${f.wo.id}/assignments/${mobileAssignmentId}/respond`,
      )
      .set(auth(mobileWorker.token))
      .send({ decision: 'TERIMA' });
    assert.equal(mobileRespond.status, 200);
    assert.equal(mobileRespond.body.data.responseStatus, 'TERIMA');
    assert.equal(
      mobileRespond.body.data.respondedByUserId,
      mobileWorker.userId,
    );
  });

  it('7. Coexists cleanly with Expense-Helper migrations (0470-0471) and database-level immutability triggers', async () => {
    const f = await setupStandardWorkOrderFixture();

    const assigned = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });
    assert.equal(assigned.status, 201);
    const assignmentId = assigned.body.data.id as string;

    const accepted = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${assignmentId}/respond`)
      .set(auth(f.workerA.token))
      .send({ decision: 'TERIMA' });
    assert.equal(accepted.status, 200);

    // Verify 0470, 0471, and 0472 tables all exist and enforce their triggers.
    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (
            'handyman_material_purchase_records',
            'handyman_helper_attendance_confirmations',
            'handyman_assignment_responses',
            'handyman_assignment_response_events'
          )
        ORDER BY tablename ASC`,
    );
    assert.equal(tables.rows.length, 4);

    // Verify DB trigger blocks deleting handyman_assignment_responses.
    await assert.rejects(
      async () => {
        await pool!.query(
          `DELETE FROM handyman_assignment_responses WHERE assignment_id = $1`,
          [assignmentId],
        );
      },
      /cannot be deleted/,
    );

    // Verify DB trigger blocks mutating terminal response_status (TERIMA -> TIDAK_BISA).
    await assert.rejects(
      async () => {
        await pool!.query(
          `UPDATE handyman_assignment_responses
              SET response_status = 'TIDAK_BISA',
                  decline_reason = 'Illegal flip'
            WHERE assignment_id = $1`,
          [assignmentId],
        );
      },
      /cannot transition/,
    );

    // Verify DB trigger blocks mutating or deleting handyman_assignment_response_events.
    await assert.rejects(
      async () => {
        await pool!.query(
          `DELETE FROM handyman_assignment_response_events WHERE assignment_id = $1`,
          [assignmentId],
        );
      },
      /append-only/,
    );
  });

  it('8. Direct POST /work-orders/:id/acknowledge syncs TERIMA, blocks START after post-acknowledge reassignment until new worker accepts, and rejects late responses', async () => {
    const f = await setupStandardWorkOrderFixture();

    const first = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });
    assert.equal(first.status, 201);
    const firstId = first.body.data.id as string;

    // Worker A calls POST /work-orders/:id/acknowledge directly -> syncs TERIMA on assignment response.
    const ack = await api()
      .post(`${V1}/work-orders/${f.wo.id}/acknowledge`)
      .set(auth(f.workerA.token))
      .send({ notes: 'Acknowledged via legacy route' });
    assert.equal(ack.status, 201);

    const currentAfterAck = await api()
      .get(`${V1}/work-orders/${f.wo.id}/assignments/current`)
      .set(auth(f.ops.token));
    assert.equal(currentAfterAck.status, 200);
    assert.equal(currentAfterAck.body.data.responseStatus, 'TERIMA');
    assert.equal(
      currentAfterAck.body.data.respondedByUserId,
      f.workerA.userId,
    );

    // Calling respond(TERIMA) after acknowledge is idempotent and does not duplicate actions.
    const respondAfterAck = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${firstId}/respond`)
      .set(auth(f.workerA.token))
      .send({ decision: 'TERIMA' });
    assert.equal(respondAfterAck.status, 200);
    assert.equal(respondAfterAck.body.data.responseStatus, 'TERIMA');

    const actionsAfterAck = await api()
      .get(`${V1}/work-orders/${f.wo.id}/actions`)
      .set(auth(f.ops.token));
    assert.equal(actionsAfterAck.body.data.length, 1);

    // Now Operations reassigns the ASSIGNED Work Order to Worker B -> new assignment is PENDING.
    const reassigned = await api()
      .patch(`${V1}/work-orders/${f.wo.id}/assignments/${firstId}`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileB.id,
      });
    assert.equal(reassigned.status, 200);
    const secondId = reassigned.body.data.id as string;
    assert.equal(reassigned.body.data.responseStatus, 'PENDING');

    // Even though work_orders.status is already ASSIGNED, Worker B cannot START before accepting their own assignment.
    const prematureStartB = await api()
      .post(`${V1}/work-orders/${f.wo.id}/start`)
      .set(auth(f.workerB.token))
      .send({});
    assert.equal(prematureStartB.status, 400);
    assert.equal(
      prematureStartB.body.error.code,
      'WORK_ORDER_EXECUTION_INVALID_STATE',
    );

    // Worker B accepts (TERIMA) and starts -> IN_PROGRESS.
    const acceptB = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${secondId}/respond`)
      .set(auth(f.workerB.token))
      .send({ decision: 'TERIMA' });
    assert.equal(acceptB.status, 200);

    const startB = await api()
      .post(`${V1}/work-orders/${f.wo.id}/start`)
      .set(auth(f.workerB.token))
      .send({});
    assert.equal(startB.status, 201);

    // Reassign while IN_PROGRESS -> late response on IN_PROGRESS Work Order is rejected (409 WORK_ORDER_ASSIGNMENT_RESPONSE_LATE).
    const reassignedInProgress = await api()
      .patch(`${V1}/work-orders/${f.wo.id}/assignments/${secondId}`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profileA.id,
      });
    assert.equal(reassignedInProgress.status, 200);
    const thirdId = reassignedInProgress.body.data.id as string;

    const lateDeclineInProgress = await api()
      .post(`${V1}/work-orders/${f.wo.id}/assignments/${thirdId}/respond`)
      .set(auth(f.workerA.token))
      .send({
        decision: 'TIDAK_BISA',
        declineReason: 'Terlambat menolak saat sudah IN_PROGRESS',
      });
    assert.equal(lateDeclineInProgress.status, 409);
    assert.equal(
      lateDeclineInProgress.body.error.code,
      'WORK_ORDER_ASSIGNMENT_RESPONSE_LATE',
    );
  });
});
