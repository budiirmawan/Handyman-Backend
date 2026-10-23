import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handymanDispatchRepository } from '../src/modules/handyman-dispatch';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import {
  addHandymanCrewMember,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDbHandle,
} from './helpers/embedded-test-db';
import {
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-part02-helper-attendance-pg';
const DB_PORT = 55572;

let dbHandle: EmbeddedTestDbHandle | null = null;
let pool: Pool | null = null;
let adminId = '';

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

  const admin = await createAdminUser();
  adminId = admin.userId;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) {
    throw new Error('GENERAL_HANDYMAN discipline seed missing');
  }

  initHandymanFixtures({
    adminUserId: adminId,
    disciplineId: discipline.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('Pool not initialized');
      return pool.query(text, params);
    },
  });
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

async function q(text: string, params: unknown[] = []) {
  if (!pool) throw new Error('Pool not initialized');
  return pool.query(text, params);
}

async function loginExistingUser(userId: string, email: string): Promise<string> {
  const password = `Pass#${randomUUID().slice(0, 8)}Aa1`;
  await credentialService.createInitialCredential({ userId, password });
  const res = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.sessionToken as string;
}

async function createPersonaUser(
  label: string,
  permissionCodes: string[],
  buildingIds: string[],
): Promise<{ userId: string; roleId: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
  const user = await userService.createUser({
    email,
    displayName: `Actor ${label}`,
  });

  const role = await roleService.createRole({
    code: `ROLE_${label.toUpperCase()}_${randomUUID().slice(0, 6)}`,
    name: `Role ${label}`,
  });

  for (const code of permissionCodes) {
    const perm = await permissionService
      .createPermission({ code, name: `Scoped ${code}` })
      .catch(async () => permissionRepository.findByCode(code));
    assert.ok(perm, `Expected permission ${code} to exist`);
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }

  if (permissionCodes.length > 0) {
    await roleService.assignRoleToUser(user.id, role.id);
  }

  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }

  const token = await loginExistingUser(user.id, email);
  return { userId: user.id, roleId: role.id, token };
}

async function createLoginlessHelper(input: {
  realm: Awaited<ReturnType<typeof realmFixture>>;
  vendorId: string;
  providerContextId: string;
  fullName: string;
  placeAtBuilding: boolean;
}) {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const profile = await workforceService.createWorkforceProfile({
    organizationId: input.realm.organization.id,
    departmentId: input.realm.department.id,
    positionId: input.realm.position.id,
    employeeCode: `HLP_${suffix}`,
    fullName: input.fullName,
    workforceType: 'EXTERNAL',
    // Explicitly NO userId -> login-less Helper without smartphone / Mobile account
  });
  if (input.placeAtBuilding) {
    await assignBuildingToWorkforce({
      workforceProfileId: profile.id,
      buildingId: input.realm.building.id,
    });
  }
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: input.vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VPH_${suffix}`,
  });
  const workerContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: input.providerContextId,
        workforceProfileId: profile.id,
      },
      adminId,
    );
  return { profile, workerContext };
}

async function createWorkOrderRow(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  _chain: Awaited<ReturnType<typeof locationChain>>,
  label: string,
): Promise<string> {
  const woId = randomUUID();
  const woNum = `WO-HLP-${label}-${randomUUID().slice(0, 6).toUpperCase()}`;
  await q(
    `INSERT INTO work_orders (
       id, client_id, building_id, work_order_number,
       title, description, work_type, status, created_by_user_id
     ) VALUES (
       $1, $2, $3, $4,
       $5, 'Helper attendance test work order', 'CORRECTIVE', 'OPEN', $6
     )`,
    [
      woId,
      realm.client.id,
      realm.building.id,
      woNum,
      `Work Order ${label}`,
      adminId,
    ],
  );
  return woId;
}

const REF_COORDS = { latitude: -6.2, longitude: 106.816666 };

async function performDispatchArrivalAndLeadCheckIn(input: {
  realm: Awaited<ReturnType<typeof realmFixture>>;
  chain: Awaited<ReturnType<typeof locationChain>>;
  scopeId: string;
  assignmentId: string;
  leadUserId: string;
  leadToken: string;
}): Promise<string> {
  if (!pool) throw new Error('Pool not initialized');
  const existingRelease = await handymanDispatchRepository.findActiveByScope(
    pool,
    input.scopeId,
  );
  if (!existingRelease) {
    await handymanDispatchRepository.insert(pool, {
      clientId: input.realm.client.id,
      executionScopeId: input.scopeId,
      assignmentId: input.assignmentId,
      appointmentId: null,
      releasedByUserId: adminId,
      readinessSnapshot: { ready: true },
    });
  }

  await saveHandymanBuildingGeospatialPolicy(
    {
      buildingId: input.realm.building.id,
      referenceLatitude: REF_COORDS.latitude,
      referenceLongitude: REF_COORDS.longitude,
      geofenceRadiusMeters: 100,
      maxAccuracyMeters: 40,
      maxLocationAgeSeconds: 900,
    },
    adminId,
  );
  const reg = await createHandymanArrivalLocationIdentifier(
    {
      buildingId: input.realm.building.id,
      floorId: input.chain.floor.id,
      areaId: input.chain.area.id,
      roomId: input.chain.room.id,
      spaceId: input.chain.space.id,
    },
    adminId,
  );
  const challenge = await createHandymanArrivalChallenge(
    { executionScopeId: input.scopeId },
    input.leadUserId,
  );
  const arrival = await evaluateHandymanArrivalVerification(
    {
      executionScopeId: input.scopeId,
      challengeToken: challenge.token,
      qrOpaqueCode: reg.value,
      deviceLocation: {
        latitude: REF_COORDS.latitude,
        longitude: REF_COORDS.longitude,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
    },
    input.leadUserId,
  );
  assert.equal(arrival.status, 'VERIFIED');

  const checkInRes = await api()
    .post(`${V1}/handyman/execution-scopes/${input.scopeId}/work-sessions/check-in`)
    .set('Authorization', `Bearer ${input.leadToken}`)
    .send({ idempotencyKey: `checkin-${randomUUID()}` });
  assert.equal(checkInRes.status, 200, JSON.stringify(checkInRes.body));
  return checkInRes.body.data.session.id as string;
}

describe('CR-HM-FIELD-EXPENSE-HELPER-01 PART 02 — Konfirmasi Kehadiran Helper', () => {
  it('1: supports login-less Helpers, separates unverified roster/presence snapshot from verified attendance, enforces correctionReason & immutable history, and never auto-approves fees', async () => {
    const realm = await realmFixture('Part02A');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crew = await crewFixture(realm);
    const workOrderId = await createWorkOrderRow(realm, chain, 'A');

    // Add 2 login-less Helpers (no user_id, no smartphone / Mobile account)
    const helperA = await createLoginlessHelper({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Andi (Tanpa HP)',
      placeAtBuilding: true,
    });
    const helperB = await createLoginlessHelper({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Budi (Tanpa HP)',
      placeAtBuilding: true,
    });

    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: helperA.workerContext.id,
      },
      adminId,
    );
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: helperB.workerContext.id,
      },
      adminId,
    );

    const assignment = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
        idempotencyKey: `assign-${randomUUID()}`,
      },
      adminId,
    );

    const leadToken = await loginExistingUser(
      crew.leadUser.id,
      crew.leadUser.email,
    );
    const opsReader = await createPersonaUser(
      'opsread',
      ['tenant_company.read'],
      [realm.building.id],
    );

    // Before Lead check-in: confirming helper attendance is blocked (no active session)
    const preSessionConfirm = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: helperA.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `pre-${randomUUID()}`,
      });
    assert.equal(preSessionConfirm.status, 409);
    assert.equal(
      preSessionConfirm.body.error.code,
      'HANDYMAN_HELPER_ATTENDANCE_SESSION_REQUIRED',
    );

    // Lead performs arrival verification + check-in
    const sessionId = await performDispatchArrivalAndLeadCheckIn({
      realm,
      chain,
      scopeId: scope.id,
      assignmentId: assignment.id,
      leadUserId: crew.leadUser.id,
      leadToken,
    });

    // Verify `handyman_work_session_helper_presence` has 2 unverified snapshot rows,
    // YET helper-attendance projection reports BOTH as UNCONFIRMED (`attendanceVerified = false`)!
    const preConfirmGet = await api()
      .get(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance`)
      .set('Authorization', `Bearer ${leadToken}`);
    assert.equal(preConfirmGet.status, 200, JSON.stringify(preConfirmGet.body));
    const preData = preConfirmGet.body.data;
    assert.equal(preData.workSessionId, sessionId);
    assert.equal(preData.summary.totalEffectiveHelpers, 2);
    assert.equal(preData.summary.loginlessHelperCount, 2);
    assert.equal(preData.summary.unverifiedPresenceSnapshotCount, 2);
    assert.equal(preData.summary.confirmedPresentCount, 0);
    assert.equal(preData.summary.confirmedAbsentCount, 0);
    assert.equal(preData.summary.unconfirmedCount, 2);
    assert.equal(preData.summary.allHelpersConfirmed, false);
    assert.equal(preData.summary.presenceSnapshotIsVerifiedProof, false);
    assert.equal(preData.summary.feeApprovalAutomatic, false);
    for (const member of preData.roster) {
      assert.equal(member.helperUserId, null);
      assert.equal(member.hasMobileAccount, false);
      assert.equal(member.unverifiedPresenceSnapshotRecorded, true);
      assert.equal(member.attendanceStatus, 'UNCONFIRMED');
      assert.equal(member.attendanceVerified, false);
    }

    // Lead confirms actual attendance: Helper A = HADIR, Helper B = TIDAK_HADIR
    const confirmKey = `conf-${randomUUID()}`;
    const confirmRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        workSessionId: sessionId,
        confirmations: [
          {
            helperWorkerId: helperA.workerContext.id,
            attendanceStatus: 'HADIR',
            notes: 'Hadir tepat waktu membawa tangga lipat',
          },
          {
            helperWorkerId: helperB.workerContext.id,
            attendanceStatus: 'TIDAK_HADIR',
            notes: 'Belum tiba di lokasi saat mulai kerja',
          },
        ],
        idempotencyKey: confirmKey,
      });
    assert.equal(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    assert.equal(confirmRes.body.data.replayed, false);
    assert.equal(confirmRes.body.data.workOrderId, workOrderId);
    assert.equal(confirmRes.body.data.summary.confirmedPresentCount, 1);
    assert.equal(confirmRes.body.data.summary.confirmedAbsentCount, 1);
    assert.equal(confirmRes.body.data.summary.unconfirmedCount, 0);
    assert.equal(confirmRes.body.data.summary.allHelpersConfirmed, true);

    // Idempotent replay with same key returns replayed = true and zero duplicate events
    const replayRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        workSessionId: sessionId,
        confirmations: [
          {
            helperWorkerId: helperA.workerContext.id,
            attendanceStatus: 'HADIR',
          },
          {
            helperWorkerId: helperB.workerContext.id,
            attendanceStatus: 'TIDAK_HADIR',
          },
        ],
        idempotencyKey: confirmKey,
      });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.body.data.replayed, true);
    assert.equal(replayRes.body.data.history.length, 2);

    // Changing Helper B from TIDAK_HADIR -> HADIR without correctionReason fails 422
    const missingReasonRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: helperB.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `corr-missing-${randomUUID()}`,
      });
    assert.equal(missingReasonRes.status, 422);
    assert.equal(
      missingReasonRes.body.error.code,
      'HANDYMAN_HELPER_ATTENDANCE_CORRECTION_REASON_REQUIRED',
    );

    // Valid correction with correctionReason records full audit trail
    const correctionRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: helperB.workerContext.id,
            attendanceStatus: 'HADIR',
            notes: 'Tiba pukul 09:20',
            correctionReason: 'Tertahan pemeriksaan KTP di pos sekuriti basement',
          },
        ],
        idempotencyKey: `corr-ok-${randomUUID()}`,
      });
    assert.equal(correctionRes.status, 200, JSON.stringify(correctionRes.body));
    assert.equal(correctionRes.body.data.summary.confirmedPresentCount, 2);
    assert.equal(correctionRes.body.data.summary.confirmedAbsentCount, 0);

    // Operations read view sees complete history, actors, timestamps, and Work Order
    const opsView = await api()
      .get(`${V1}/handyman/execution-scopes/${scope.id}/helper-attendance`)
      .set('Authorization', `Bearer ${opsReader.token}`);
    assert.equal(opsView.status, 200, JSON.stringify(opsView.body));
    assert.equal(opsView.body.data.history.length, 3);
    const correctionEvent = opsView.body.data.history[2];
    assert.equal(correctionEvent.eventType, 'STATUS_CORRECTION');
    assert.equal(correctionEvent.previousStatus, 'TIDAK_HADIR');
    assert.equal(correctionEvent.newStatus, 'HADIR');
    assert.equal(
      correctionEvent.correctionReason,
      'Tertahan pemeriksaan KTP di pos sekuriti basement',
    );
    assert.equal(correctionEvent.actorUserId, crew.leadUser.id);
    assert.equal(correctionEvent.actorWorkerId, crew.workerContext.id);
    assert.equal(correctionEvent.actorRole, 'CREW_LEAD');
    assert.equal(correctionEvent.workOrderId, workOrderId);

    // DB triggers enforce append-only immutability on events and block deletion of confirmations
    await assert.rejects(
      () =>
        q(
          `UPDATE handyman_helper_attendance_events SET new_status = 'TIDAK_HADIR' WHERE id = $1`,
          [correctionEvent.id],
        ),
      /append-only/i,
    );
    await assert.rejects(
      () =>
        q(`DELETE FROM handyman_helper_attendance_events WHERE id = $1`, [
          correctionEvent.id,
        ]),
      /append-only/i,
    );
    await assert.rejects(
      () =>
        q(
          `DELETE FROM handyman_helper_attendance_confirmations WHERE execution_scope_id = $1`,
          [scope.id],
        ),
      /cannot be deleted/i,
    );

    // Confirming helper attendance NEVER auto-creates or auto-approves fees,
    // customer ledger transactions, or entitlement facts, and 0471 tables carry zero fee columns.
    const entitlementsRes = await q(
      `SELECT count(*)::int AS cnt
         FROM handyman_entitlement_facts
        WHERE execution_scope_id = $1`,
      [scope.id],
    );
    assert.equal(entitlementsRes.rows[0].cnt, 0);

    const ledgerRes = await q(
      `SELECT count(*)::int AS cnt
         FROM handyman_customer_transactions
        WHERE execution_scope_id = $1`,
      [scope.id],
    );
    assert.equal(ledgerRes.rows[0].cnt, 0);

    const feeColsRes = await q(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name IN (
          'handyman_scope_helper_personnel_changes',
          'handyman_helper_attendance_confirmations',
          'handyman_helper_attendance_events'
        )
          AND (
            column_name ILIKE '%fee%'
            OR column_name ILIKE '%rate%'
            OR column_name ILIKE '%price%'
            OR column_name ILIKE '%amount%'
            OR column_name ILIKE '%wage%'
            OR column_name ILIKE '%billable%'
          )`,
    );
    assert.deepEqual(feeColsRes.rows, []);
  });

  it('2: enforces Operations authorization for helper personnel changes (ADD_HELPER, SUBSTITUTE_HELPER, REMOVE_HELPER) and blocks unauthorized roster bypass', async () => {
    const realm = await realmFixture('Part02B');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crew = await crewFixture(realm);
    const workOrderId = await createWorkOrderRow(realm, chain, 'B');

    const helperA = await createLoginlessHelper({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Awal A',
      placeAtBuilding: true,
    });
    const helperB = await createLoginlessHelper({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Awal B',
      placeAtBuilding: true,
    });
    // Eligible login-less helpers NOT initially in the crew roster
    const helperC = await createLoginlessHelper({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Tambahan C',
      placeAtBuilding: true,
    });
    const helperD = await createLoginlessHelper({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Pengganti D',
      placeAtBuilding: true,
    });

    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: helperA.workerContext.id,
      },
      adminId,
    );
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: helperB.workerContext.id,
      },
      adminId,
    );

    const assignment = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
        idempotencyKey: `assign-${randomUUID()}`,
      },
      adminId,
    );

    const leadToken = await loginExistingUser(
      crew.leadUser.id,
      crew.leadUser.email,
    );
    const opsManager = await createPersonaUser(
      'opsmgr',
      ['tenant_company.read', 'tenant_company.manage'],
      [realm.building.id],
    );

    await performDispatchArrivalAndLeadCheckIn({
      realm,
      chain,
      scopeId: scope.id,
      assignmentId: assignment.id,
      leadUserId: crew.leadUser.id,
      leadToken,
    });

    // 1. Lead CANNOT confirm unlisted Helper C without Operations authorization
    const unauthHelperConfirm = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: helperC.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `unlisted-${randomUUID()}`,
      });
    assert.equal(unauthHelperConfirm.status, 422);
    assert.equal(
      unauthHelperConfirm.body.error.code,
      'HANDYMAN_HELPER_ATTENDANCE_NOT_IN_ROSTER',
    );

    // 2. Lead CANNOT confirm themselves as a Helper
    const selfLeadConfirm = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: crew.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `selflead-${randomUUID()}`,
      });
    assert.equal(selfLeadConfirm.status, 422);
    assert.equal(
      selfLeadConfirm.body.error.code,
      'HANDYMAN_HELPER_ATTENDANCE_NOT_IN_ROSTER',
    );

    // 3. Lead CANNOT authorize personnel changes (requires tenant_company.manage)
    const leadPersonnelAttempt = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/helper-attendance/personnel-changes`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        changeType: 'ADD_HELPER',
        targetHelperWorkerId: helperC.workerContext.id,
        reason: 'Lead mencoba tambah sendiri',
        idempotencyKey: `lead-chg-${randomUUID()}`,
      });
    assert.equal(leadPersonnelAttempt.status, 403);

    // 4. Lead confirms Helper A = HADIR first
    const initConfirm = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: helperA.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `init-a-${randomUUID()}`,
      });
    assert.equal(initConfirm.status, 200);
    assert.equal(initConfirm.body.data.summary.confirmedPresentCount, 1);

    // 5. Operations authorizes ADD_HELPER for login-less Helper C
    const addRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/helper-attendance/personnel-changes`)
      .set('Authorization', `Bearer ${opsManager.token}`)
      .send({
        workOrderId,
        changeType: 'ADD_HELPER',
        targetHelperWorkerId: helperC.workerContext.id,
        reason: 'Beban angkut pipa memerlukan tambahan 1 helper',
        idempotencyKey: `ops-add-${randomUUID()}`,
      });
    assert.equal(addRes.status, 201, JSON.stringify(addRes.body));
    const addedMember = addRes.body.data.projection.roster.find(
      (r: { helperWorkerId: string }) =>
        r.helperWorkerId === helperC.workerContext.id,
    );
    assert.ok(addedMember);
    assert.equal(addedMember.rosterSource, 'OPERATIONS_ADDITION');
    assert.equal(addedMember.hasMobileAccount, false);
    // Operations addition is still UNCONFIRMED until Crew Lead verifies arrival on site!
    assert.equal(addedMember.attendanceStatus, 'UNCONFIRMED');
    assert.equal(addedMember.attendanceVerified, false);

    // Now Lead can confirm Helper C on site as HADIR
    const confirmC = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: helperC.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `conf-c-${randomUUID()}`,
      });
    assert.equal(confirmC.status, 200);
    assert.equal(confirmC.body.data.summary.confirmedPresentCount, 2);

    // 6. Mid-session SUBSTITUTE_HELPER: Operations replaces Helper A (who was HADIR) with Helper D
    const subRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/helper-attendance/personnel-changes`)
      .set('Authorization', `Bearer ${opsManager.token}`)
      .send({
        workOrderId,
        changeType: 'SUBSTITUTE_HELPER',
        replacedHelperWorkerId: helperA.workerContext.id,
        targetHelperWorkerId: helperD.workerContext.id,
        reason: 'Helper A sakit mendadak di lokasi, diganti Helper D',
        idempotencyKey: `ops-sub-${randomUUID()}`,
      });
    assert.equal(subRes.status, 201, JSON.stringify(subRes.body));
    // Helper A was moved to removedHelpers and superseded from HADIR -> TIDAK_HADIR!
    assert.equal(subRes.body.data.projection.summary.confirmedPresentCount, 1);
    const removedA = subRes.body.data.projection.removedHelpers.find(
      (r: { helperWorkerId: string }) =>
        r.helperWorkerId === helperA.workerContext.id,
    );
    assert.ok(removedA);
    assert.equal(removedA.activeInRoster, false);
    assert.equal(removedA.replacedByHelperWorkerId, helperD.workerContext.id);
    assert.equal(removedA.attendanceStatus, 'TIDAK_HADIR');

    const supersedeEvent = subRes.body.data.projection.history.find(
      (e: { eventType: string }) => e.eventType === 'ROSTER_REMOVED_SUPERSEDED',
    );
    assert.ok(supersedeEvent);
    assert.equal(supersedeEvent.actorRole, 'OPERATIONS');
    assert.equal(supersedeEvent.actorUserId, opsManager.userId);
    assert.equal(supersedeEvent.previousStatus, 'HADIR');
    assert.equal(supersedeEvent.newStatus, 'TIDAK_HADIR');

    // Lead confirms substitute Helper D as HADIR on site
    const confirmD = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        confirmations: [
          {
            helperWorkerId: helperD.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `conf-d-${randomUUID()}`,
      });
    assert.equal(confirmD.status, 200);
    assert.equal(confirmD.body.data.summary.confirmedPresentCount, 2);

    // 7. Operations authorizes REMOVE_HELPER for Helper B
    const remRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/helper-attendance/personnel-changes`)
      .set('Authorization', `Bearer ${opsManager.token}`)
      .send({
        workOrderId,
        changeType: 'REMOVE_HELPER',
        replacedHelperWorkerId: helperB.workerContext.id,
        reason: 'Helper B ditarik ke pekerjaan darurat lantai lain',
        idempotencyKey: `ops-rem-${randomUUID()}`,
      });
    assert.equal(remRes.status, 201, JSON.stringify(remRes.body));
    assert.equal(remRes.body.data.projection.summary.totalEffectiveHelpers, 2);
    assert.equal(remRes.body.data.projection.summary.allHelpersConfirmed, true);

    // Personnel changes log is immutable in DB
    await assert.rejects(
      () =>
        q(
          `DELETE FROM handyman_scope_helper_personnel_changes WHERE id = $1`,
          [remRes.body.data.personnelChange.id],
        ),
      /append-only/i,
    );
  });

  it('3: enforces exact-Building & Client scope, cross-Work-Order guard, worker Building placement eligibility, and live IAM revocation', async () => {
    const realmA = await realmFixture('Part02C_A');
    const chainA1 = await locationChain(realmA);
    const chainA2 = await locationChain(realmA);
    const { scope: scopeA } = await scopeFixture(realmA, chainA1);
    const crewA = await crewFixture(realmA);
    const woA1 = await createWorkOrderRow(realmA, chainA1, 'CA1');
    const woA2 = await createWorkOrderRow(realmA, chainA2, 'CA2');

    const helperA = await createLoginlessHelper({
      realm: realmA,
      vendorId: crewA.vendor.id,
      providerContextId: crewA.providerContext.id,
      fullName: 'Helper Gedung A',
      placeAtBuilding: true,
    });
    const unplacedHelper = await createLoginlessHelper({
      realm: realmA,
      vendorId: crewA.vendor.id,
      providerContextId: crewA.providerContext.id,
      fullName: 'Helper Belum Ditempatkan',
      placeAtBuilding: false,
    });

    await addHandymanCrewMember(
      {
        handymanCrewId: crewA.crew.id,
        handymanWorkerContextId: helperA.workerContext.id,
      },
      adminId,
    );
    const assignmentA = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeA.id,
        providerContextId: crewA.providerContext.id,
        crewId: crewA.crew.id,
        idempotencyKey: `assign-${randomUUID()}`,
      },
      adminId,
    );

    const realmB = await realmFixture('Part02C_B');
    const chainB = await locationChain(realmB);
    const woB = await createWorkOrderRow(realmB, chainB, 'CB1');

    const leadTokenA = await loginExistingUser(
      crewA.leadUser.id,
      crewA.leadUser.email,
    );
    const opsA = await createPersonaUser(
      'opsA',
      ['tenant_company.read', 'tenant_company.manage'],
      [realmA.building.id],
    );
    const opsOtherBuilding = await createPersonaUser(
      'opsB',
      ['tenant_company.read', 'tenant_company.manage'],
      [realmB.building.id],
    );
    const nonLeadWorkerUser = await createPersonaUser(
      'nonlead',
      [],
      [realmA.building.id],
    );

    await performDispatchArrivalAndLeadCheckIn({
      realm: realmA,
      chain: chainA1,
      scopeId: scopeA.id,
      assignmentId: assignmentA.id,
      leadUserId: crewA.leadUser.id,
      leadToken: leadTokenA,
    });

    // 1. Cross-Building Operations actor denied with 403 BUILDING_ACCESS_DENIED
    const crossBuildingRead = await api()
      .get(`${V1}/handyman/execution-scopes/${scopeA.id}/helper-attendance`)
      .set('Authorization', `Bearer ${opsOtherBuilding.token}`);
    assert.equal(crossBuildingRead.status, 403);
    assert.equal(crossBuildingRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossBuildingMutate = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA.id}/helper-attendance/personnel-changes`)
      .set('Authorization', `Bearer ${opsOtherBuilding.token}`)
      .send({
        changeType: 'REMOVE_HELPER',
        replacedHelperWorkerId: helperA.workerContext.id,
        reason: 'Cross building attempt',
        idempotencyKey: `xb-${randomUUID()}`,
      });
    assert.equal(crossBuildingMutate.status, 403);
    assert.equal(crossBuildingMutate.body.error.code, 'BUILDING_ACCESS_DENIED');

    // 2. Non-Lead user in same Building denied on Field endpoints
    const nonLeadRead = await api()
      .get(`${V1}/handyman/field/execution-scopes/${scopeA.id}/helper-attendance`)
      .set('Authorization', `Bearer ${nonLeadWorkerUser.token}`);
    assert.equal(nonLeadRead.status, 403);
    assert.equal(
      nonLeadRead.body.error.code,
      'HANDYMAN_HELPER_ATTENDANCE_FORBIDDEN',
    );

    // 3. Worker without Building placement rejected on Operations ADD_HELPER
    const unplacedAdd = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA.id}/helper-attendance/personnel-changes`)
      .set('Authorization', `Bearer ${opsA.token}`)
      .send({
        workOrderId: woA1,
        changeType: 'ADD_HELPER',
        targetHelperWorkerId: unplacedHelper.workerContext.id,
        reason: 'Mencoba tambah helper tanpa penempatan gedung',
        idempotencyKey: `unplaced-${randomUUID()}`,
      });
    assert.equal(unplacedAdd.status, 409);
    assert.equal(
      unplacedAdd.body.error.code,
      'HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT',
    );

    // 4. Cross-Client/Building Work Order rejected (409 HANDYMAN_HELPER_CROSS_WORK_ORDER_MISMATCH)
    const crossWoConfirm = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadTokenA}`)
      .send({
        workOrderId: woB,
        confirmations: [
          {
            helperWorkerId: helperA.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `xwo-${randomUUID()}`,
      });
    assert.equal(crossWoConfirm.status, 409);
    assert.equal(
      crossWoConfirm.body.error.code,
      'HANDYMAN_HELPER_CROSS_WORK_ORDER_MISMATCH',
    );

    // Bind to woA1 legitimately, then attempt to switch to woA2 -> 409 HANDYMAN_HELPER_CROSS_WORK_ORDER_MISMATCH
    const validBind = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadTokenA}`)
      .send({
        workOrderId: woA1,
        confirmations: [
          {
            helperWorkerId: helperA.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `bind-wo1-${randomUUID()}`,
      });
    assert.equal(validBind.status, 200);

    const switchWo = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA.id}/helper-attendance/confirm`)
      .set('Authorization', `Bearer ${leadTokenA}`)
      .send({
        workOrderId: woA2,
        confirmations: [
          {
            helperWorkerId: helperA.workerContext.id,
            attendanceStatus: 'TIDAK_HADIR',
            correctionReason: 'Mencoba klaim di Work Order lain',
          },
        ],
        idempotencyKey: `bind-wo2-${randomUUID()}`,
      });
    assert.equal(switchWo.status, 409);
    assert.equal(
      switchWo.body.error.code,
      'HANDYMAN_HELPER_CROSS_WORK_ORDER_MISMATCH',
    );

    // 5. Live IAM Revocation compatibility: revoking Operations role assignment
    // immediately denies existing session token on the very next request!
    const preRevoke = await api()
      .get(`${V1}/handyman/execution-scopes/${scopeA.id}/helper-attendance`)
      .set('Authorization', `Bearer ${opsA.token}`);
    assert.equal(preRevoke.status, 200);

    await q(`DELETE FROM user_role_assignments WHERE user_id = $1`, [
      opsA.userId,
    ]);

    const postRevoke = await api()
      .get(`${V1}/handyman/execution-scopes/${scopeA.id}/helper-attendance`)
      .set('Authorization', `Bearer ${opsA.token}`);
    assert.equal(postRevoke.status, 403);
    assert.equal(postRevoke.body.error.code, 'PERMISSION_DENIED');
  });
});
