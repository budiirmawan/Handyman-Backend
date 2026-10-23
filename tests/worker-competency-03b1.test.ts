import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { skillService } from '../src/modules/skills';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { assignBuildingToWorkforce }
  from '../src/modules/workforce-building-assignments';
import { assignSkillToWorkforce } from '../src/modules/workforce-skills';
import {
  workforceCertificationService,
  type WorkforceCertificationActor,
} from '../src/modules/workforce-certifications';
import { handymanProviderContextService, handymanWorkCrewService }
  from '../src/modules/handyman-providers';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { serviceCompetencyRequirementService }
  from '../src/modules/service-competency-requirements';
import { handymanScopeAssignmentService }
  from '../src/modules/handyman-scope-assignments';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
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

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B1 — re-verification + decision history.
 *
 * PART A (certification re-verification):
 *   - a MATERIAL metadata edit resets VERIFIED/REJECTED back to
 *     PENDING_VERIFICATION and clears the verifier audit triple,
 *   - the previous decision survives in the append-only ledger,
 *   - a non-material edit (notes) and a no-op re-send do NOT reset,
 *   - a reset certificate stops satisfying a MANDATORY requirement until it is
 *     verified again,
 *   - maker-checker is untouched: an owner still cannot verify their own record.
 *
 * PART B (assignment decision history):
 *   - assign and reassign append immutable per-worker/per-requirement rows in
 *     the same transaction as the assignment,
 *   - a rejected/rolled-back assignment leaves no decision row,
 *   - the read endpoint is paginated, RBAC-guarded and Building-scoped,
 *   - no certificate number, document id or storage key is ever stored.
 */

const EMBEDDED_DIR = '/tmp/hm-competency-03b1-pg';
const EMBEDDED_PORT = 55661;

let embedded: EmbeddedTestDatabase | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

let realmA: Awaited<ReturnType<typeof realmFixture>>;
let crewA: Awaited<ReturnType<typeof crewFixture>>;
let realmB: Awaited<ReturnType<typeof realmFixture>>;
let crewB: Awaited<ReturnType<typeof crewFixture>>;

let managerUserIdA = '';
let managerUserIdB = '';
let workerUserIdA = '';
let workerProfileIdA = '';
let skillIdA = '';

const FUTURE_DATE = '2029-12-31T00:00:00.000Z';
const ISSUE_DATE = '2024-01-15T00:00:00.000Z';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function actorFor(
  userId: string,
  permissions?: readonly string[],
): WorkforceCertificationActor {
  return {
    id: userId,
    email: `${userId}@test.local`,
    displayName: 'Test Actor',
    status: 'ACTIVE',
    sessionId: randomUUID(),
    permissions,
  };
}

const READ = 'workforce_certification.read';
const MANAGE = 'workforce_certification.manage';
const VERIFY = 'workforce_certification.verify';

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
  });
  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles, permissions CASCADE');

  const admin = await createAdminUser();
  adminUserId = admin.userId;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: async (text: string, params: unknown[] = []) => {
      if (!pool) throw new Error('database pool is not initialized');
      return pool.query(text, params);
    },
  });

  realmA = await realmFixture('B1ClientA');
  crewA = await crewFixture(realmA);
  realmB = await realmFixture('B1ClientB');
  crewB = await crewFixture(realmB);

  // Manager in Client A, worker bound to crew A's Lead profile.
  const managerUser = await userService.createUser({
    email: `mgr-b1-a-${suffix().toLowerCase()}@example.com`,
    displayName: 'Manager A',
  });
  managerUserIdA = managerUser.id;
  await buildingAssignmentService.createAssignment(managerUser.id, {
    buildingId: realmA.building.id,
  });

  const managerUserB = await userService.createUser({
    email: `mgr-b1-b-${suffix().toLowerCase()}@example.com`,
    displayName: 'Manager B',
  });
  managerUserIdB = managerUserB.id;
  await buildingAssignmentService.createAssignment(managerUserB.id, {
    buildingId: realmB.building.id,
  });

  // A dedicated worker profile so certificates are never the manager's own.
  const workerUser = await userService.createUser({
    email: `wk-b1-a-${suffix().toLowerCase()}@example.com`,
    displayName: 'Worker A',
  });
  workerUserIdA = workerUser.id;
  const workerProfile = await workforceService.createWorkforceProfile({
    organizationId: realmA.organization.id,
    departmentId: realmA.department.id,
    positionId: realmA.position.id,
    employeeCode: `WK_${suffix()}`,
    fullName: 'Worker A',
    workforceType: 'EXTERNAL',
    userId: workerUser.id,
  });
  workerProfileIdA = workerProfile.id;
  await assignBuildingToWorkforce({
    workforceProfileId: workerProfile.id,
    buildingId: realmA.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: crewA.vendor.id,
    workforceProfileId: workerProfile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  await buildingAssignmentService.createAssignment(workerUser.id, {
    buildingId: realmA.building.id,
  });

  const skill = await skillService.createSkill({
    clientId: realmA.client.id,
    code: `SKL_B1_${suffix()}`,
    name: 'K3 Listrik Tegangan Rendah',
    category: 'SAFETY',
  });
  skillIdA = skill.id;

  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (embedded) await embedded.stop();
  } finally {
    pool = null;
    database = null;
    embedded = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const managerActorA = () =>
  actorFor(managerUserIdA, [READ, MANAGE, VERIFY]);

async function createCertifiedWorkforceCertificate(): Promise<string> {
  const created =
    await workforceCertificationService.createWorkforceCertification(
      workerProfileIdA,
      {
        skillId: skillIdA,
        certificateNumber: `CERT-B1-${suffix()}`,
        certificateName: 'Sertifikat K3 Listrik',
        issuingAuthority: 'Kementerian Ketenagakerjaan RI',
        issueDate: ISSUE_DATE,
        expiryDate: FUTURE_DATE,
      },
      managerActorA(),
    );
  await workforceCertificationService.verifyWorkforceCertification(
    workerProfileIdA,
    created.id,
    { verificationStatus: 'VERIFIED', notes: 'Sesuai dokumen asli.' },
    managerActorA(),
  );
  return created.id;
}

/**
 * `scopeFixture(realm, chain)` returns only the scope, so the job type is read
 * back from the request lineage — exactly the chain the evaluator walks.
 */
async function scopeWithJobType(label: string) {
  const realm = await realmFixture(label);
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  const result = await q(
    `SELECT sr.service_catalog_id AS "serviceCatalogId"
       FROM handyman_execution_scopes es
       JOIN handyman_service_requests sr ON sr.id = es.handyman_request_id
      WHERE es.id = $1`,
    [f.scope.id],
  );
  return { realm, scope: f.scope, serviceCatalogId: result.rows[0].serviceCatalogId as string };
}

/**
 * A reader with exactly `tenant_company.read` plus a Building assignment in the
 * given Building — the shape the eligibility/history surfaces require.
 */
async function createScopedReader(
  buildingId: string,
  code = 'tenant_company.read',
  name = 'Read Tenant Companies',
) {
  const user = await userService.createUser({
    email: `reader-b1-${suffix().toLowerCase()}@example.com`,
    displayName: 'Scoped Reader',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ScopedPass123',
  });
  const role = await roleService.createRole({
    code: `READ_B1_${suffix()}`,
    name: 'Scoped Reader Role',
  });
  const existing = await permissionRepository.findByCode(code);
  const permissionId = existing
    ? existing.id
    : (await permissionService.createPermission({ code, name })).id;
  await permissionService.assignPermissionToRole(role.id, permissionId);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'ScopedPass123',
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function decisionRows(certificationId: string) {
  const result = await q(
    `SELECT decision, previous_verification_status, changed_fields, reason,
            decided_by_user_id, previous_verified_by_user_id
       FROM workforce_certification_decisions
      WHERE certification_id = $1
      ORDER BY decided_at ASC, id ASC`,
    [certificationId],
  );
  return result.rows as Array<{
    decision: string;
    previous_verification_status: string | null;
    changed_fields: string[] | null;
    reason: string | null;
    decided_by_user_id: string | null;
    previous_verified_by_user_id: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// PART A — certification re-verification
// ---------------------------------------------------------------------------

describe('PART 03B1-A — certification re-verification policy', () => {
  it('A1: a material edit resets verification and preserves the previous decision', async (t) => {
    if (!ready(t)) return;
    const certificationId = await createCertifiedWorkforceCertificate();

    const updated =
      await workforceCertificationService.updateWorkforceCertification(
        workerProfileIdA,
        certificationId,
        { certificateName: 'Sertifikat K3 Listrik (revisi)' },
        managerActorA(),
      );

    assert.equal(updated.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(updated.verifiedByUserId, null);
    assert.equal(updated.verifiedAt, null);
    assert.equal(updated.isValid, false);

    const decisions = await decisionRows(certificationId);
    // verify + reset
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].decision, 'VERIFIED');
    assert.equal(decisions[0].previous_verification_status, 'PENDING_VERIFICATION');
    assert.equal(decisions[0].reason, 'Sesuai dokumen asli.');
    assert.equal(decisions[0].decided_by_user_id, managerUserIdA);

    assert.equal(decisions[1].decision, 'PENDING_VERIFICATION');
    assert.equal(decisions[1].previous_verification_status, 'VERIFIED');
    assert.equal(decisions[1].previous_verified_by_user_id, managerUserIdA);
    assert.deepEqual(decisions[1].changed_fields, ['certificateName']);
    assert.equal(decisions[1].decided_by_user_id, managerUserIdA);
  });

  it('A2: a non-material edit (notes) does not reset verification', async (t) => {
    if (!ready(t)) return;
    const certificationId = await createCertifiedWorkforceCertificate();

    const updated =
      await workforceCertificationService.updateWorkforceCertification(
        workerProfileIdA,
        certificationId,
        { notes: 'Catatan administrasi internal.' },
        managerActorA(),
      );

    assert.equal(updated.verificationStatus, 'VERIFIED');
    assert.equal(updated.verifiedByUserId, managerUserIdA);
    assert.ok(updated.verifiedAt);

    const decisions = await decisionRows(certificationId);
    assert.equal(decisions.length, 1, 'notes must not append a reset row');
    assert.equal(decisions[0].decision, 'VERIFIED');
  });

  it('A3: re-sending unchanged values does not reset verification', async (t) => {
    if (!ready(t)) return;
    const certificationId = await createCertifiedWorkforceCertificate();
    const before =
      await workforceCertificationService.getWorkforceCertificationById(
        workerProfileIdA,
        certificationId,
        managerActorA(),
      );

    const updated =
      await workforceCertificationService.updateWorkforceCertification(
        workerProfileIdA,
        certificationId,
        {
          certificateNumber: before.certificateNumber,
          certificateName: before.certificateName,
          issuingAuthority: before.issuingAuthority,
          issueDate: before.issueDate,
          expiryDate: before.expiryDate,
          skillId: before.skillId,
        },
        managerActorA(),
      );

    assert.equal(updated.verificationStatus, 'VERIFIED');
    const decisions = await decisionRows(certificationId);
    assert.equal(decisions.length, 1);
  });

  it('A4: a RESET certificate no longer satisfies a MANDATORY requirement', async (t) => {
    if (!ready(t)) return;

    const certificationId = await createCertifiedWorkforceCertificate();
    const ok = await workforceCertificationService.getWorkforceCertificationById(
      workerProfileIdA,
      certificationId,
      managerActorA(),
    );
    assert.equal(ok.isValid, true);

    await workforceCertificationService.updateWorkforceCertification(
      workerProfileIdA,
      certificationId,
      { issuingAuthority: 'BNSP' },
      managerActorA(),
    );

    const after =
      await workforceCertificationService.getWorkforceCertificationById(
        workerProfileIdA,
        certificationId,
        managerActorA(),
      );
    assert.equal(after.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(after.isValid, false);

    // Restoring the attestation restores eligibility.
    const reverified =
      await workforceCertificationService.verifyWorkforceCertification(
        workerProfileIdA,
        certificationId,
        { verificationStatus: 'VERIFIED', notes: 'Dokumen ulang diperiksa.' },
        managerActorA(),
      );
    assert.equal(reverified.isValid, true);

    const decisions = await decisionRows(certificationId);
    assert.deepEqual(
      decisions.map((decision) => decision.decision),
      ['VERIFIED', 'PENDING_VERIFICATION', 'VERIFIED'],
    );
  });

  it('A5: an expired certificate can never be (re)verified — and the reset stays PENDING', async (t) => {
    if (!ready(t)) return;
    const created =
      await workforceCertificationService.createWorkforceCertification(
        workerProfileIdA,
        {
          skillId: skillIdA,
          certificateNumber: `CERT-EXP-${suffix()}`,
          certificateName: 'Sertifikat K3 Kedaluwarsa',
          issuingAuthority: 'Kemnaker',
          issueDate: '2019-01-01T00:00:00.000Z',
          expiryDate: FUTURE_DATE,
        },
        managerActorA(),
      );
    await workforceCertificationService.verifyWorkforceCertification(
      workerProfileIdA,
      created.id,
      { verificationStatus: 'VERIFIED' },
      managerActorA(),
    );

    // Shortening validity to the past is material → reset, and the record now
    // reports EXPIRED, so verification is refused.
    const updated =
      await workforceCertificationService.updateWorkforceCertification(
        workerProfileIdA,
        created.id,
        { expiryDate: '2021-01-01T00:00:00.000Z' },
        managerActorA(),
      );
    assert.equal(updated.status, 'EXPIRED');
    assert.equal(updated.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(updated.isValid, false);

    await assert.rejects(
      () =>
        workforceCertificationService.verifyWorkforceCertification(
          workerProfileIdA,
          created.id,
          { verificationStatus: 'VERIFIED' },
          managerActorA(),
        ),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'WORKFORCE_CERTIFICATION_VERIFICATION_NOT_ALLOWED',
    );

    const decisions = await decisionRows(created.id);
    assert.equal(decisions.at(-1)?.decision, 'PENDING_VERIFICATION');
    assert.ok(decisions.at(-1)?.changed_fields?.includes('expiryDate'));
  });

  it('A6: the certificate owner still cannot verify their own record', async (t) => {
    if (!ready(t)) return;
    const created =
      await workforceCertificationService.createWorkforceCertification(
        workerProfileIdA,
        {
          skillId: skillIdA,
          certificateNumber: `CERT-SELF-${suffix()}`,
          certificateName: 'Sertifikat K3 Self',
          issuingAuthority: 'Kemnaker',
          issueDate: ISSUE_DATE,
          expiryDate: FUTURE_DATE,
        },
        managerActorA(),
      );

    await assert.rejects(
      () =>
        workforceCertificationService.verifyWorkforceCertification(
          workerProfileIdA,
          created.id,
          { verificationStatus: 'VERIFIED' },
          actorFor(workerUserIdA, [READ, MANAGE, VERIFY]),
        ),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN',
    );

    const decisions = await decisionRows(created.id);
    assert.equal(decisions.length, 0, 'a refused decision writes nothing');
  });

  it('A7: cross-client decision read is refused', async (t) => {
    if (!ready(t)) return;
    const certificationId = await createCertifiedWorkforceCertificate();

    await assert.rejects(
      () =>
        workforceCertificationService.listWorkforceCertificationDecisions(
          workerProfileIdA,
          certificationId,
          {},
          actorFor(managerUserIdB, [READ, MANAGE, VERIFY]),
        ),
      (error: unknown) =>
        (error as { code?: string }).code === 'BUILDING_ACCESS_DENIED',
    );
  });

  it('A8: the decision ledger endpoint pages the append-only history', async (t) => {
    if (!ready(t)) return;
    const certificationId = await createCertifiedWorkforceCertificate();
    await workforceCertificationService.updateWorkforceCertification(
      workerProfileIdA,
      certificationId,
      { issuingAuthority: 'BNSP' },
      managerActorA(),
    );

    // A reader whose ONLY permission is workforce_certification.read — a broad
    // permission is never required to see a history the read scope allows.
    const reader = await createScopedReader(
      realmA.building.id,
      'workforce_certification.read',
      'Read Workforce Certifications',
    );
    const base =
      `/api/v1/workforce/${workerProfileIdA}/certifications/${certificationId}/decisions`;

    const page1 = await api()
      .get(`${base}?page=1&pageSize=1`)
      .set('Authorization', `Bearer ${reader.token}`);
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.length, 1);
    assert.equal(page1.body.data[0].decision, 'PENDING_VERIFICATION');
    assert.deepEqual(page1.body.meta, {
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });

    const page2 = await api()
      .get(`${base}?page=2&pageSize=1`)
      .set('Authorization', `Bearer ${reader.token}`);
    assert.equal(page2.status, 200);
    assert.equal(page2.body.data.length, 1);
    assert.equal(page2.body.data[0].decision, 'VERIFIED');

    // Without paging params the contract carries an empty meta (BE-25A).
    const unpaged = await api()
      .get(base)
      .set('Authorization', `Bearer ${reader.token}`);
    assert.equal(unpaged.status, 200);
    assert.equal(unpaged.body.data.length, 2);
    assert.deepEqual(unpaged.body.meta, {});

    // Anonymous is still refused.
    const anonymous = await api().get(base);
    assert.equal(anonymous.status, 401);
  });

  it('A9: the decision ledger is append-only at the database layer', async (t) => {
    if (!ready(t)) return;
    const certificationId = await createCertifiedWorkforceCertificate();

    await assert.rejects(
      () =>
        q(
          `UPDATE workforce_certification_decisions
              SET decision = 'REJECTED'
            WHERE certification_id = $1`,
          [certificationId],
        ),
      /append-only/i,
    );
    await assert.rejects(
      () =>
        q(
          `DELETE FROM workforce_certification_decisions
            WHERE certification_id = $1`,
          [certificationId],
        ),
      /append-only/i,
    );
  });
});

// ---------------------------------------------------------------------------
// PART B — assignment competency decision history
// ---------------------------------------------------------------------------

describe('PART 03B1-B — assignment competency decision history', () => {
  it('B1: assign and reassign append per-worker/per-requirement decisions', async (t) => {
    if (!ready(t)) return;
    const { realm, scope, serviceCatalogId } = await scopeWithJobType('B1Hist');
    const crew = await crewFixture(realm);
    const otherCrew = await crewFixture(realm);

    const skill = await skillService.createSkill({
      clientId: realm.client.id,
      code: `SKL_H_${suffix()}`,
      name: 'Electrical',
      category: 'TECHNICAL',
    });
    await assignSkillToWorkforce({
      workforceProfileId: crew.profile.id,
      skillId: skill.id,
      proficiencyLevel: 'ADVANCED',
    });
    await assignSkillToWorkforce({
      workforceProfileId: otherCrew.profile.id,
      skillId: skill.id,
      proficiencyLevel: 'EXPERT',
    });

    await serviceCompetencyRequirementService.createCompetencyRequirement(
      serviceCatalogId,
      {
        clientId: realm.client.id,
        serviceCatalogId: serviceCatalogId,
        requirementType: 'SKILL',
        enforcementLevel: 'MANDATORY',
        skillId: skill.id,
        minimumProficiencyLevel: 'INTERMEDIATE',
        certificateName: null,
        notes: null,
        createdByUserId: adminUserId,
      },
      adminUserId,
    );

    const first = await handymanScopeAssignmentService
      .assignHandymanExecutionScopeCrew(
        {
          executionScopeId: scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );

    const assigned = await q(
      `SELECT action, assignment_id, worker_context_id, requirement_id,
              satisfied, reason, evidence_proficiency_level, skill_code,
              decision_group_id
         FROM handyman_assignment_competency_evaluations
        WHERE execution_scope_id = $1
        ORDER BY evaluated_at ASC`,
      [scope.id],
    );
    assert.equal(assigned.rowCount, 1);
    assert.equal(assigned.rows[0].action, 'ASSIGNED');
    assert.equal(assigned.rows[0].assignment_id, first.id);
    assert.equal(assigned.rows[0].worker_context_id, crew.workerContext.id);
    assert.equal(assigned.rows[0].satisfied, true);
    assert.equal(assigned.rows[0].reason, null);
    assert.equal(assigned.rows[0].evidence_proficiency_level, 'ADVANCED');
    assert.equal(assigned.rows[0].skill_code, skill.code);

    const reassigned = await handymanScopeAssignmentService
      .reassignHandymanExecutionScopeCrew(
        {
          executionScopeId: scope.id,
          providerContextId: otherCrew.providerContext.id,
          crewId: otherCrew.crew.id,
          reason: 'Rotasi crew terampil.',
          expectedVersion: first.version,
        },
        adminUserId,
      );

    const second = await q(
      `SELECT action, assignment_id, satisfied, evidence_proficiency_level
         FROM handyman_assignment_competency_evaluations
        WHERE execution_scope_id = $1 AND action = 'REASSIGNED'`,
      [scope.id],
    );
    assert.equal(second.rowCount, 1);
    assert.equal(second.rows[0].assignment_id, reassigned.id);
    assert.equal(second.rows[0].satisfied, true);
    assert.equal(second.rows[0].evidence_proficiency_level, 'EXPERT');
  });

  it('B2: a rejected assignment writes no decision row (transaction rollback)', async (t) => {
    if (!ready(t)) return;
    const { realm, scope, serviceCatalogId } = await scopeWithJobType('B1Rollback');
    const crew = await crewFixture(realm);

    const skill = await skillService.createSkill({
      clientId: realm.client.id,
      code: `SKL_R_${suffix()}`,
      name: 'Welding',
      category: 'TECHNICAL',
    });
    await assignSkillToWorkforce({
      workforceProfileId: crew.profile.id,
      skillId: skill.id,
      proficiencyLevel: 'BASIC',
    });
    await serviceCompetencyRequirementService.createCompetencyRequirement(
      serviceCatalogId,
      {
        clientId: realm.client.id,
        serviceCatalogId: serviceCatalogId,
        requirementType: 'SKILL',
        enforcementLevel: 'MANDATORY',
        skillId: skill.id,
        minimumProficiencyLevel: 'ADVANCED',
        certificateName: null,
        notes: null,
        createdByUserId: adminUserId,
      },
      adminUserId,
    );

    await assert.rejects(
      () =>
        handymanScopeAssignmentService.assignHandymanExecutionScopeCrew(
          {
            executionScopeId: scope.id,
            providerContextId: crew.providerContext.id,
            crewId: crew.crew.id,
          },
          adminUserId,
        ),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_COMPETENCY_REQUIRED',
    );

    const decisions = await q(
      `SELECT id FROM handyman_assignment_competency_evaluations
        WHERE execution_scope_id = $1`,
      [scope.id],
    );
    assert.equal(decisions.rowCount, 0);
    const assignments = await q(
      `SELECT id FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1`,
      [scope.id],
    );
    assert.equal(assignments.rowCount, 0);
  });

  it('B3: the ledger stores no certificate number, document id or storage key', async (t) => {
    if (!ready(t)) return;
    const { realm, scope, serviceCatalogId } = await scopeWithJobType('B1Privacy');
    const crew = await crewFixture(realm);

    // A verified, in-date certificate satisfies the requirement.
    const certificateId = randomUUID();
    await q(
      `INSERT INTO workforce_certifications (
         id, client_id, workforce_profile_id, skill_id, certificate_number,
         certificate_name, issuing_authority, issue_date, expiry_date, status,
         verification_status, verified_by_user_id, verified_at,
         file_reference, created_by_user_id
       ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,'ACTIVE','VERIFIED',$9,NOW(),$10,$9)`,
      [
        certificateId,
        realm.client.id,
        crew.profile.id,
        `SECRET-NUMBER-${suffix()}`,
        'K3 Listrik',
        'Kemnaker',
        '2024-01-01T00:00:00.000Z',
        FUTURE_DATE,
        adminUserId,
        'certifications/private/secret-key.pdf',
      ],
    );
    await serviceCompetencyRequirementService.createCompetencyRequirement(
      serviceCatalogId,
      {
        clientId: realm.client.id,
        serviceCatalogId: serviceCatalogId,
        requirementType: 'CERTIFICATION',
        enforcementLevel: 'MANDATORY',
        skillId: null,
        minimumProficiencyLevel: null,
        certificateName: 'K3 Listrik',
        notes: null,
        createdByUserId: adminUserId,
      },
      adminUserId,
    );

    await handymanScopeAssignmentService.assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    const row = await q(
      `SELECT * FROM handyman_assignment_competency_evaluations
        WHERE execution_scope_id = $1`,
      [scope.id],
    );
    assert.equal(row.rowCount, 1);
    const record = row.rows[0] as Record<string, unknown>;
    assert.equal(record.satisfied, true);
    assert.equal(record.evidence_certification_id, certificateId);
    assert.equal(record.evidence_verification_status, 'VERIFIED');

    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes('SECRET-NUMBER'), false);
    assert.equal(serialized.includes('certifications/private'), false);
    assert.equal(
      Object.keys(record).some((key) => key === 'document_id'),
      false,
    );
  });

  it('B4: history is paginated, RBAC-guarded and Building-scoped', async (t) => {
    if (!ready(t)) return;
    const { realm, scope, serviceCatalogId } = await scopeWithJobType('B1History');
    const crew = await crewFixture(realm);

    const skill = await skillService.createSkill({
      clientId: realm.client.id,
      code: `SKL_HIS_${suffix()}`,
      name: 'Plumbing',
      category: 'TECHNICAL',
    });
    await assignSkillToWorkforce({
      workforceProfileId: crew.profile.id,
      skillId: skill.id,
      proficiencyLevel: 'ADVANCED',
    });
    await serviceCompetencyRequirementService.createCompetencyRequirement(
      serviceCatalogId,
      {
        clientId: realm.client.id,
        serviceCatalogId: serviceCatalogId,
        requirementType: 'SKILL',
        enforcementLevel: 'MANDATORY',
        skillId: skill.id,
        minimumProficiencyLevel: 'BASIC',
        certificateName: null,
        notes: null,
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    await handymanScopeAssignmentService.assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    const history = (query = '') =>
      `/api/v1/handyman/execution-scopes/${scope.id}/competency/history${query}`;

    // Unauthenticated
    const anonymous = await api().get(history());
    assert.equal(anonymous.status, 401);

    // An actor with tenant_company.read but Building reach only in ANOTHER
    // Client can never read this scope's decisions.
    const outsider = await createScopedReader(realmB.building.id);
    const denied = await api()
      .get(history())
      .set({ Authorization: `Bearer ${outsider.token}` });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The client's own reader sees the decision, paginated.
    const reader = await createScopedReader(realm.building.id);
    const ok = await api()
      .get(history('?page=1&pageSize=1'))
      .set({ Authorization: `Bearer ${reader.token}` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.length, 1);
    assert.equal(ok.body.meta.page, 1);
    assert.equal(ok.body.meta.pageSize, 1);
    assert.equal(ok.body.meta.total, 1);
    assert.equal(ok.body.data[0].action, 'ASSIGNED');
    assert.equal(ok.body.data[0].satisfied, true);
    assert.equal(ok.body.data[0].executionScopeId, scope.id);

    // Filtering narrows without widening: a non-matching filter returns [].
    const filtered = await api()
      .get(history('?satisfied=false'))
      .set({ Authorization: `Bearer ${reader.token}` });
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.deepEqual(filtered.body.data, []);
    assert.equal(filtered.body.meta.total, 0);

    // Invalid filter values are 400, never silently ignored.
    const invalid = await api()
      .get(history('?action=DELETED'))
      .set({ Authorization: `Bearer ${reader.token}` });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  });

  it('B5: decision rows cannot be updated or deleted (append-only)', async (t) => {
    if (!ready(t)) return;
    const { realm, scope, serviceCatalogId } = await scopeWithJobType('B1Ledger');
    const crew = await crewFixture(realm);

    const skill = await skillService.createSkill({
      clientId: realm.client.id,
      code: `SKL_LED_${suffix()}`,
      name: 'Carpentry',
      category: 'TECHNICAL',
    });
    await assignSkillToWorkforce({
      workforceProfileId: crew.profile.id,
      skillId: skill.id,
      proficiencyLevel: 'EXPERT',
    });
    await serviceCompetencyRequirementService.createCompetencyRequirement(
      serviceCatalogId,
      {
        clientId: realm.client.id,
        serviceCatalogId: serviceCatalogId,
        requirementType: 'SKILL',
        enforcementLevel: 'MANDATORY',
        skillId: skill.id,
        minimumProficiencyLevel: 'BASIC',
        certificateName: null,
        notes: null,
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    await handymanScopeAssignmentService.assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    await assert.rejects(
      () =>
        q(
          `UPDATE handyman_assignment_competency_evaluations
              SET satisfied = false
            WHERE execution_scope_id = $1`,
          [scope.id],
        ),
      /append-only/i,
    );
    await assert.rejects(
      () =>
        q(
          `DELETE FROM handyman_assignment_competency_evaluations
            WHERE execution_scope_id = $1`,
          [scope.id],
        ),
      /append-only/i,
    );
  });
});
