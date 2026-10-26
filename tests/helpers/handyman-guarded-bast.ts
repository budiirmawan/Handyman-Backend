import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../../src/database';
import { resetAppConfigCache } from '../../src/config';
import { buildingAssignmentService } from '../../src/modules/building-assignments';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../../src/modules/evidence/storage';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
  rejectHandymanBast,
  voidHandymanBast,
} from '../../src/modules/handyman-bast';
import {
  bindHandymanQcEvidence,
  configureHandymanQcChecklist,
  createHandymanEvidenceRecord,
  finishHandymanQcRun,
  openHandymanQcRun,
  publishHandymanQcChecklistVersion,
  setHandymanQcRunItemOutcome,
} from '../../src/modules/handyman-evidence-qc';
import { assignHandymanExecutionScopeCrew } from '../../src/modules/handyman-scope-assignments';
import {
  permissionRepository,
  permissionService,
} from '../../src/modules/permissions';
import { roleService } from '../../src/modules/roles';
import { userService } from '../../src/modules/users';
import { workforceService } from '../../src/modules/workforce';
import { assignSupervisor } from '../../src/modules/workforce-reporting-lines';
import { baseFixture, crewFixture } from './handyman-fixtures';
import { handymanCustomerForScope, handymanCustomerConsentInput } from './handyman-customer-consent';

/**
 * CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01 — shared guarded
 * BAST/QC arrangement for the current-generation lifecycle gates.
 *
 * Since migrations 0442/0444/0445 (Supervisor QC authority, versioned
 * QC checklists, BAST bound to a current guarded QC PASS — plus the
 * completed-work-session precondition), every BAST PREPARE requires:
 *   ACTIVE crew assignment + completed/CHECKED_OUT work session
 *   + current versioned PASSED Supervisor QC run with verified bytes.
 * QC WRITE commands (OPEN/ITEM_SET/FINISH) belong to the assigned,
 * RBAC-granted Supervisor — never the executing Lead.
 *
 * This helper composes exactly the arrangement the merged
 * `tests/handyman-e2e-finance-close-api.test.ts` uses (its
 * scopedFixture + acceptedBastFixture seams, service-side), so the
 * pre-gate warranty suites assert the SAME frozen guards against real
 * persisted state instead of a now-rejected shortcut.
 *
 * Callers must have run `initHandymanFixtures` against their migrated
 * database; the suite's `q` runner is used for the work-session and
 * evidence-upload INSERTs (identical to the E2E file).
 */

export type GuardedBastStage =
  | 'DRAFT' | 'ISSUED' | 'ACCEPTED' | 'REJECTED' | 'VOID'
  | 'VOID_THEN_ACCEPTED';

export type GuardedQcQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount: number | null }>;

export type GuardedBastFixture = {
  realm: Awaited<ReturnType<typeof baseFixture>>['realm'];
  scope: Awaited<ReturnType<typeof baseFixture>>['scope'];
  crew: Awaited<ReturnType<typeof crewFixture>>;
  assignment: { id: string };
  supervisorUserId: string;
  qcRunId: string;
  bastId: string;
  customerUserId: string;
  bast: { id: string; status: string };
};

const QC_CODE = 'HANDYMAN_FINAL';
const QC_IDENTITY = `${QC_CODE}@v1`;
const QC_ITEM_KEY = 'quality';

let storageDirEnsured = false;

function ensureEvidenceStorageDir(): void {
  if (storageDirEnsured) return;
  if (!process.env.EVIDENCE_STORAGE_DIR) {
    process.env.EVIDENCE_STORAGE_DIR = join(
      mkdtempSync(join(tmpdir(), 'hm-guarded-bast-evidence-')),
      'evidence',
    );
    resetAppConfigCache();
  }
  storageDirEnsured = true;
}

async function grant(
  userId: string,
  permissionCodes: readonly string[],
  roleTag: string,
): Promise<void> {
  const role = await roleService.createRole({
    code: `${roleTag}_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Guarded-BAST arrangement role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService
      .createPermission({ code: permissionCode, name: `Scoped ${permissionCode}` })
      .catch(async () => permissionRepository.findByCode(permissionCode));
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

/** Publish (replay-tolerant) + pin the versioned QC checklist to the scope. */
/** Public seam: pin the versioned HANDYMAN_FINAL@v1 checklist spec. */
export async function configureGuardedQcChecklist(input: {
  clientId: string;
  executionScopeId: string;
  adminUserId: string;
}): Promise<void> {
  await ensureVersionedQcChecklist(input);
}

async function ensureVersionedQcChecklist(input: {
  clientId: string;
  executionScopeId: string;
  adminUserId: string;
}): Promise<void> {
  await grant(input.adminUserId, ['handyman.qc.configure'], 'GBQC');
  const template = await publishHandymanQcChecklistVersion(
    {
      clientId: input.clientId,
      code: QC_CODE,
      versionNumber: 1,
      requiredItemKeys: [QC_ITEM_KEY],
    },
    input.adminUserId,
  );
  await configureHandymanQcChecklist(
    {
      executionScopeId: input.executionScopeId,
      templateVersionId: template.version.id,
    },
    input.adminUserId,
  );
}

/**
 * Store integrity-verified bytes and bind them to an OPEN run — the
 * precondition every FINISH-PASSED assertion needs
 * (`no byte-verified QC evidence bound to run` otherwise).
 */
async function attachVerifiedQcEvidence(input: {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string;
  uploaderUserId: string;
  qcRunId: string;
  expectedVersion: number;
  q: GuardedQcQuery;
  /** QC WRITE actor (the assigned Supervisor); defaults to uploader. */
  actorUserId?: string;
}): Promise<void> {
  const reference = await seedVerifiedQcEvidenceBytes(input.q, {
    clientId: input.clientId,
    tenantCompanyId: input.tenantCompanyId,
    buildingId: input.buildingId,
    handymanRequestId: input.handymanRequestId,
    executionScopeId: input.executionScopeId,
    uploaderUserId: input.uploaderUserId,
  });
  await bindHandymanQcEvidence(
    {
      qcRunId: input.qcRunId,
      evidenceReference: reference,
      expectedVersion: input.expectedVersion,
      idempotencyKey: `gbb-${randomUUID()}`,
    },
    input.actorUserId ?? input.uploaderUserId,
  );
}

/**
 * Store integrity-verified PNG bytes and register the VERIFIED
 * QC_EVIDENCE upload row; returns the `hm-ev://` reference so a
 * caller can bind it itself (e.g. over HTTP in transport suites).
 */
export async function seedVerifiedQcEvidenceBytes(
  q: GuardedQcQuery,
  input: {
    clientId: string;
    tenantCompanyId: string;
    buildingId: string;
    handymanRequestId: string;
    executionScopeId: string;
    uploaderUserId: string;
    /** Defaults to QC_EVIDENCE; BEFORE_AFTER_WORK for defect rework proof. */
    purpose?: 'QC_EVIDENCE' | 'BEFORE_AFTER_WORK';
  },
): Promise<string> {
  ensureEvidenceStorageDir();
  const uploadId = randomUUID();
  const storageKey = evidenceStorageKey(uploadId);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`qc-${uploadId}`),
  ]);
  await createEvidenceStorage().put(storageKey, {
    buffer: bytes,
    mimeType: 'image/png',
  });
  const reference = `hm-ev://${uploadId}`;
  await q(
    `INSERT INTO handyman_field_evidence_uploads
       (id, client_id, tenant_company_id, building_id, handyman_request_id,
        execution_scope_id, purpose, upload_status, original_file_name,
        mime_type, storage_key, declared_byte_size, verified_byte_size,
        sha256_checksum, attachment_reference, uploaded_by_user_id,
        uploaded_by_role, idempotency_key, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'VERIFIED','qc.png','image/png',
       $8,$9,$9,$10,$11,$12,'PIC_PEKERJAAN',$13,NOW())`,
    [
      uploadId,
      input.clientId,
      input.tenantCompanyId,
      input.buildingId,
      input.handymanRequestId,
      input.executionScopeId,
      input.purpose ?? 'QC_EVIDENCE',
      storageKey,
      bytes.byteLength,
      createHash('sha256').update(bytes).digest('hex'),
      reference,
      input.uploaderUserId,
      `gbu-${randomUUID()}`,
    ],
  );
  return reference;
}

/** Create the explicitly permitted current Supervisor of the crew Lead:
 * login user, workforce profile, ACTIVE reporting line, building access
 * and the dedicated handyman.qc.manage capability (0442 authority). */
export async function createGuardedQcSupervisor(input: {
  realm: {
    organization: { id: string };
    department: { id: string };
    position: { id: string };
    building: { id: string };
  };
  crew: { workerContext: { workforceProfileId: string } };
}): Promise<{ id: string; profileId: string }> {
  const supervisor = await userService.createUser({
    email: `supervisor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Guarded QC Supervisor',
  });
  const supProfile = await workforceService.createWorkforceProfile({
    organizationId: input.realm.organization.id,
    departmentId: input.realm.department.id,
    positionId: input.realm.position.id,
    employeeCode: `SUP_${randomUUID().slice(0, 8).toUpperCase()}`,
    fullName: 'Guarded QC Supervisor',
    userId: supervisor.id,
  });
  await assignSupervisor({
    workforceProfileId: input.crew.workerContext.workforceProfileId,
    supervisorWorkforceProfileId: supProfile.id,
  });
  await buildingAssignmentService.createAssignment(supervisor.id, {
    buildingId: input.realm.building.id,
  });
  await grant(supervisor.id, ['handyman.qc.manage'], 'GBSUP');
  return { id: supervisor.id, profileId: supProfile.id };
}

/** Seed one completed CHECKED_OUT work session (QC PASS gate input). */
export async function seedCheckedOutWorkSession(
  q: GuardedQcQuery,
  input: {
    clientId: string;
    executionScopeId: string;
    assignmentId: string;
    leadWorkerContextId: string;
    leadUserId: string;
  },
): Promise<void> {
  await q(
    `INSERT INTO handyman_work_sessions
       (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
        lead_user_id, status, started_work_at, completed_at, checked_out_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_OUT', NOW(), NOW(), NOW())`,
    [randomUUID(), input.clientId, input.executionScopeId,
      input.assignmentId, input.leadWorkerContextId, input.leadUserId],
  );
}

/**
 * One Supervisor-run QC cycle on the scope's pinned checklist:
 * OPEN → ITEM_SET(quality) → verified-bytes BIND → FINISH
 * (server-evaluated; a PASS assertion always requires bound bytes).
 * Reusable for post-BAST flows (e.g. warranty rework verification)
 * because each run is a fresh additive row; publish/configure replay
 * is a no-op.
 */
export async function runGuardedQcCycle(input: {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string;
  adminUserId: string;
  supervisorUserId: string;
  uploaderUserId: string;
  q: GuardedQcQuery;
  item?: 'PASS' | 'DEFECT';
}): Promise<{ run: { id: string; status: string } }> {
  ensureEvidenceStorageDir();
  const idem = () => `gq-${randomUUID()}`;
  await ensureVersionedQcChecklist(input);
  const item = input.item ?? 'PASS';
  const { run } = await openHandymanQcRun(
    {
      executionScopeId: input.executionScopeId,
      checklistIdentity: QC_IDENTITY,
      idempotencyKey: idem(),
    },
    input.supervisorUserId,
  );
  await setHandymanQcRunItemOutcome(
    {
      qcRunId: run.id,
      itemKey: QC_ITEM_KEY,
      outcome: item,
      expectedVersion: 1,
      idempotencyKey: idem(),
    },
    input.supervisorUserId,
  );
  await attachVerifiedQcEvidence({
    clientId: input.clientId,
    tenantCompanyId: input.tenantCompanyId,
    buildingId: input.buildingId,
    handymanRequestId: input.handymanRequestId,
    executionScopeId: input.executionScopeId,
    uploaderUserId: input.uploaderUserId,
    actorUserId: input.supervisorUserId,
    qcRunId: run.id,
    expectedVersion: 2,
    q: input.q,
  });
  const finished = await finishHandymanQcRun(
    {
      qcRunId: run.id,
      outcome: item === 'PASS' ? 'PASSED' : 'FAILED',
      expectedVersion: 3,
      reason: item === 'PASS' ? null : 'Rework QC defect recorded.',
      idempotencyKey: idem(),
    },
    input.supervisorUserId,
  );
  return { run: finished.run };
}

/**
 * Add the current BAST prerequisites to an existing scope/crew fixture:
 * one completed work session and a genuine versioned Supervisor QC PASS
 * with verified bytes. This keeps older scope-guard suites on the same
 * production readiness path as arrangeGuardedBast without replacing their
 * tenant/building arrangement.
 */
export async function arrangeGuardedQcPass(input: {
  realm: {
    organization: { id: string };
    department: { id: string };
    position: { id: string };
  };
  buildingId: string;
  scope: {
    id: string;
    clientId: string;
    tenantCompanyId: string;
    handymanRequestId: string;
  };
  crew: {
    workerContext: { id: string; workforceProfileId: string };
    leadUser: { id: string };
  };
  assignment: { id: string };
  adminUserId: string;
  q: GuardedQcQuery;
}): Promise<void> {
  const supervisor = await createGuardedQcSupervisor({
    realm: {
      ...input.realm,
      building: { id: input.buildingId },
    },
    crew: input.crew,
  });
  await seedCheckedOutWorkSession(input.q, {
    clientId: input.scope.clientId,
    executionScopeId: input.scope.id,
    assignmentId: input.assignment.id,
    leadWorkerContextId: input.crew.workerContext.id,
    leadUserId: input.crew.leadUser.id,
  });
  const { run } = await runGuardedQcCycle({
    clientId: input.scope.clientId,
    tenantCompanyId: input.scope.tenantCompanyId,
    buildingId: input.buildingId,
    handymanRequestId: input.scope.handymanRequestId,
    executionScopeId: input.scope.id,
    adminUserId: input.adminUserId,
    supervisorUserId: supervisor.id,
    uploaderUserId: input.crew.leadUser.id,
    q: input.q,
  });
  assert.equal(run.status, 'PASSED');
}

/**
 * Arrange an AUTHORIZED scope with ACTIVE crew, a genuine guarded QC
 * PASS (work session + versioned supervisor run + verified bytes) and
 * a BAST advanced to `until`. `ACCEPTED` additionally signs off with a
 * same-scope AFTER evidence record (the E2E contract).
 */
export async function arrangeGuardedBast(input: {
  adminUserId: string;
  q: GuardedQcQuery;
  until?: GuardedBastStage;
  includeStructuredRequestItem?: boolean;
}): Promise<GuardedBastFixture> {
  ensureEvidenceStorageDir();
  const until = input.until ?? 'ACCEPTED';
  const adminId = input.adminUserId;
  const idem = () => `gb-${randomUUID()}`;
  await grant(adminId, ['handyman.qc.configure'], 'GB');

  const { realm, scope } = await baseFixture({
    includeStructuredRequestItem: input.includeStructuredRequestItem,
  });
  const customer = await handymanCustomerForScope(scope.id);
  await grant(customer.id, ['tenant_company.manage', 'tenant_company.read'], 'GB_CUSTOMER');
  // NOTE: the shared crewFixture already performs the 0439-required
  // workforce_building placement (and the Lead's user_building_assignments)
  // for the realm's building — do NOT repeat it here (a second ACTIVE
  // placement of the same Building is a WORKFORCE_BUILDING_ALREADY_ASSIGNED).
  const crew = await crewFixture(realm);
  const assignment = await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    adminId,
  );

  // Versioned QC checklist (0444) pinned to the scope.
  await ensureVersionedQcChecklist({
    clientId: scope.clientId,
    executionScopeId: scope.id,
    adminUserId: adminId,
  });

  // Supervisor distinct from the executing crew (0442 authority).
  const supervisor = await createGuardedQcSupervisor({ realm, crew });

  // Completed work session (precondition of the guarded PASS read).
  await input.q(
    `INSERT INTO handyman_work_sessions
       (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
        lead_user_id, status, started_work_at, completed_at, checked_out_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_OUT', NOW(), NOW(), NOW())`,
    [
      randomUUID(),
      scope.clientId,
      scope.id,
      assignment.id,
      crew.workerContext.id,
      crew.leadUser.id,
    ],
  );

  // Genuine PASSED supervisor run with verified bytes bound.
  const { run } = await openHandymanQcRun(
    {
      executionScopeId: scope.id,
      checklistIdentity: QC_IDENTITY,
      idempotencyKey: idem(),
    },
    supervisor.id,
  );
  await setHandymanQcRunItemOutcome(
    {
      qcRunId: run.id,
      itemKey: QC_ITEM_KEY,
      outcome: 'PASS',
      expectedVersion: 1,
      idempotencyKey: idem(),
    },
    supervisor.id,
  );
  await attachVerifiedQcEvidence({
    clientId: scope.clientId,
    tenantCompanyId: scope.tenantCompanyId,
    buildingId: realm.building.id,
    handymanRequestId: scope.handymanRequestId,
    executionScopeId: scope.id,
    uploaderUserId: crew.leadUser.id,
    actorUserId: supervisor.id,
    qcRunId: run.id,
    expectedVersion: 2,
    q: input.q,
  });
  const finished = await finishHandymanQcRun(
    {
      qcRunId: run.id,
      outcome: 'PASSED',
      expectedVersion: 3,
      idempotencyKey: idem(),
    },
    supervisor.id,
  );
  assert.equal(finished.run.status, 'PASSED');

  const prepared = await prepareHandymanBast(adminId, {
    executionScopeId: scope.id,
    idempotencyKey: idem(),
  });
  let bastId = prepared.bast.id;
  if (until !== 'DRAFT') {
    await issueHandymanBast(adminId, { bastId, idempotencyKey: idem() });
  }
  const signAccept = async (targetBastId: string) => {
    const consent = await handymanCustomerConsentInput(targetBastId, customer.id);
    await acceptHandymanBast(customer.id, {
      bastId: targetBastId, idempotencyKey: idem(), signatureDigest: consent.signatureDigest,
    });
  };
  if (until === 'ACCEPTED') await signAccept(bastId);
  if (until === 'REJECTED') {
    await rejectHandymanBast(customer.id, {
      bastId,
      idempotencyKey: idem(),
      signatureDigest: '',
      rejectReason: 'guarded arrangement reject',
    });
  }
  if (until === 'VOID') {
    await voidHandymanBast(adminId, {
      bastId, idempotencyKey: idem(), voidReason: 'guarded arrangement void',
    });
  }
  if (until === 'VOID_THEN_ACCEPTED') {
    await voidHandymanBast(adminId, {
      bastId, idempotencyKey: idem(), voidReason: 'guarded arrangement void',
    });
    const second = await prepareHandymanBast(adminId, {
      executionScopeId: scope.id,
      idempotencyKey: idem(),
    });
    bastId = second.bast.id;
    await issueHandymanBast(adminId, { bastId, idempotencyKey: idem() });
    await signAccept(bastId);
  }
  const row = (await input.q(
    `SELECT id, status FROM handyman_bast_documents WHERE id=$1`,
    [bastId],
  )).rows[0];
  assert.ok(row, `BAST row missing for ${bastId}`);
  return {
    realm,
    scope,
    crew,
    assignment,
    supervisorUserId: supervisor.id,
    qcRunId: run.id,
    bastId,
    customerUserId: customer.id,
    bast: { id: row.id as string, status: row.status as string },
  };
}

/** Pool-bound convenience for suites that keep a Pool handle. */
export function guardedPoolQuery(pool: {
  query: (sql: string, params?: unknown[]) => Promise<any>;
}): GuardedQcQuery {
  return (sql, params = []) => pool.query(sql, params);
}

export function getGuardedPool() {
  return getPool();
}
