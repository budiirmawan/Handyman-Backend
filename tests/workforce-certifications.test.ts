import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService, sessionService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanCrewMember,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import {
  readHandymanWorkerProfileByContextId,
  readMyHandymanWorkerProfileProjection,
} from '../src/modules/handyman-worker-profile/handyman-worker-profile.service';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { skillService } from '../src/modules/skills';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import {
  isSafeCertificationFileReference,
  resolveWorkforceCertificationExpiryStatus,
  validateCreateWorkforceCertificationInput,
  workforceCertificationService,
  type WorkforceCertificationActor,
} from '../src/modules/workforce-certifications';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import { createAdminUser, createOwnerUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import {
  crewFixture,
  initHandymanFixtures,
  realmFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED_DIR = '/tmp/hm-workforce-certifications-pg';
const EMBEDDED_PORT = 55649;

let embedded: EmbeddedTestDatabase | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

let realmA: Awaited<ReturnType<typeof realmFixture>>;
let crewA: Awaited<ReturnType<typeof crewFixture>>;
let helperUserIdA = '';
let helperWorkforceProfileIdA = '';
let helperWorkerContextIdA = '';

let realmB: Awaited<ReturnType<typeof realmFixture>>;
let crewB: Awaited<ReturnType<typeof crewFixture>>;

let managerUserIdA = '';
let skillIdA = '';
let inactiveSkillIdA = '';
let skillIdB = '';
let documentIdA = '';
let documentIdB = '';

const FUTURE_DATE = '2029-12-31T00:00:00.000Z';
const PAST_DATE = '2021-06-30T00:00:00.000Z';
const ISSUE_DATE = '2024-01-15T00:00:00.000Z';
const EARLY_ISSUE_DATE = '2019-01-15T00:00:00.000Z';

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

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
  });
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles, permissions CASCADE');

  const admin = await createAdminUser();
  adminUserId = admin.userId;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) {
    throw new Error('GENERAL_HANDYMAN discipline seed missing');
  }
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: async (text: string, params: unknown[] = []) => {
      if (!pool) throw new Error('database pool is not initialized');
      return pool.query(text, params);
    },
  });

  realmA = await realmFixture('CertClientA');
  crewA = await crewFixture(realmA);

  // Helper crew member in Client A
  const helperUser = await userService.createUser({
    email: `helper-a-${suffix().toLowerCase()}@example.com`,
    displayName: 'Helper Worker A',
  });
  helperUserIdA = helperUser.id;
  const helperProfile = await workforceService.createWorkforceProfile({
    organizationId: realmA.organization.id,
    departmentId: realmA.department.id,
    positionId: realmA.position.id,
    employeeCode: `HLP_${suffix()}`,
    fullName: 'Helper Worker A',
    workforceType: 'EXTERNAL',
    userId: helperUser.id,
  });
  helperWorkforceProfileIdA = helperProfile.id;

  await assignBuildingToWorkforce({
    workforceProfileId: helperProfile.id,
    buildingId: realmA.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: crewA.vendor.id,
    workforceProfileId: helperProfile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const helperContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: crewA.providerContext.id,
        workforceProfileId: helperProfile.id,
      },
      adminUserId,
    );
  helperWorkerContextIdA = helperContext.id;
  await addHandymanCrewMember(
    {
      handymanCrewId: crewA.crew.id,
      handymanWorkerContextId: helperContext.id,
    },
    adminUserId,
  );
  await buildingAssignmentService.createAssignment(helperUser.id, {
    buildingId: realmA.building.id,
  });

  // Workforce manager user in Client A
  const managerUser = await userService.createUser({
    email: `mgr-a-${suffix().toLowerCase()}@example.com`,
    displayName: 'Workforce Manager A',
  });
  managerUserIdA = managerUser.id;
  await buildingAssignmentService.createAssignment(managerUser.id, {
    buildingId: realmA.building.id,
  });

  // Second isolated Client B
  realmB = await realmFixture('CertClientB');
  crewB = await crewFixture(realmB);

  // Skills in Client A and Client B
  const skillA = await skillService.createSkill({
    clientId: realmA.client.id,
    code: `SKL_A_${suffix()}`,
    name: 'K3 Listrik Tegangan Rendah',
    category: 'SAFETY',
  });
  skillIdA = skillA.id;

  const inactiveSkill = await skillService.createSkill({
    clientId: realmA.client.id,
    code: `SKL_INA_${suffix()}`,
    name: 'Legacy Skill',
    category: 'TECHNICAL',
  });
  inactiveSkillIdA = inactiveSkill.id;
  await pool.query(`UPDATE skills SET status = 'INACTIVE' WHERE id = $1`, [
    inactiveSkillIdA,
  ]);

  const skillB = await skillService.createSkill({
    clientId: realmB.client.id,
    code: `SKL_B_${suffix()}`,
    name: 'Client B HVAC',
    category: 'TECHNICAL',
  });
  skillIdB = skillB.id;

  // Shared documents in Client A and Client B
  documentIdA = randomUUID();
  await pool.query(
    `INSERT INTO documents (
       id, client_id, building_id, document_number, document_type,
       context_type, title, description, file_reference, status, created_by_user_id
     )
     VALUES (
       $1, $2, $3, $4, 'OTHER',
       'INTERNAL', 'Sertifikat K3 Listrik PDF',
       'Bukti sertifikat teknisi', 'certifications/client-a/k3-listrik-001.pdf', 'ACTIVE', $5
     )`,
    [
      documentIdA,
      realmA.client.id,
      realmA.building.id,
      `DOC-A-${suffix()}`,
      adminUserId,
    ],
  );

  documentIdB = randomUUID();
  await pool.query(
    `INSERT INTO documents (
       id, client_id, building_id, document_number, document_type,
       context_type, title, description, file_reference, status, created_by_user_id
     )
     VALUES (
       $1, $2, $3, $4, 'OTHER',
       'INTERNAL', 'Client B Document',
       'Dokumen Client B', 'certifications/client-b/hvac-001.pdf', 'ACTIVE', $5
     )`,
    [
      documentIdB,
      realmB.client.id,
      realmB.building.id,
      `DOC-B-${suffix()}`,
      adminUserId,
    ],
  );

  database = db;
});

after(async () => {
  if (pool) await closePool(pool).catch(() => undefined);
  pool = null;
  database = null;
  if (embedded) await embedded.stop();
  embedded = null;
});

describe('CR-HM-WORKER-COMPETENCY-01 PART 01: Individual Worker Certification Foundation', () => {
  it('keeps certifications optional so workers with zero certificates remain valid', async (t) => {
    if (!ready(t)) return;

    const leadActor = actorFor(crewA.leadUser.id);
    const list =
      await workforceCertificationService.listWorkforceCertifications(
        crewA.profile.id,
        {},
        leadActor,
      );
    assert.deepEqual(list, []);

    const current =
      await workforceCertificationService.listCurrentWorkforceCertifications(
        crewA.profile.id,
        leadActor,
      );
    assert.deepEqual(current, []);

    // Mobile worker profile projection remains 100% compatible
    const mobileProfile = await readMyHandymanWorkerProfileProjection(
      crewA.leadUser.id,
    );
    assert.equal(
      mobileProfile.certificationsAndExpiry.individualCertificateNumberModeled,
      true,
    );
    assert.deepEqual(
      mobileProfile.certificationsAndExpiry.individualCertifications,
      [],
    );
    assert.ok(
      Array.isArray(mobileProfile.certificationsAndExpiry.skillValidityWindows),
    );
    assert.ok(
      Array.isArray(
        mobileProfile.certificationsAndExpiry.providerLicensesAndCertifications,
      ),
    );
  });

  it('creates, reads, updates, verifies, and deactivates an individual worker certification', async (t) => {
    if (!ready(t)) return;

    const managerActor = actorFor(managerUserIdA, ['skill.manage']);
    const certNumber = `CERT-K3-${suffix()}`;

    const created =
      await workforceCertificationService.createWorkforceCertification(
        crewA.profile.id,
        {
          skillId: skillIdA,
          certificateNumber: certNumber,
          certificateName: 'Sertifikat K3 Listrik Teknisi',
          issuingAuthority: 'Kementerian Ketenagakerjaan RI',
          issueDate: ISSUE_DATE,
          expiryDate: FUTURE_DATE,
          documentId: documentIdA,
          fileReference: 'certifications/workers/k3-teknisi-001.pdf',
          notes: 'Sertifikat kompetensi teknisi listrik gedung.',
        },
        managerActor,
      );

    assert.equal(created.clientId, realmA.client.id);
    assert.equal(created.workforceProfileId, crewA.profile.id);
    assert.equal(created.skillId, skillIdA);
    assert.equal(created.skill?.id, skillIdA);
    assert.equal(created.skill?.category, 'SAFETY');
    assert.equal(created.certificateNumber, certNumber);
    assert.equal(created.certificateName, 'Sertifikat K3 Listrik Teknisi');
    assert.equal(created.issuingAuthority, 'Kementerian Ketenagakerjaan RI');
    assert.equal(created.issueDate, ISSUE_DATE);
    assert.equal(created.expiryDate, FUTURE_DATE);
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.expiryStatus, 'VALID');
    assert.equal(created.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(created.verifiedByUserId, null);
    assert.equal(created.verifiedAt, null);
    assert.equal(created.documentId, documentIdA);
    assert.equal(
      created.fileReference,
      'certifications/workers/k3-teknisi-001.pdf',
    );
    assert.equal(created.documentReference?.id, documentIdA);
    assert.equal(created.createdByUserId, managerUserIdA);

    // Duplicate ACTIVE certificateNumber for the same worker is rejected
    await assert.rejects(
      () =>
        workforceCertificationService.createWorkforceCertification(
          crewA.profile.id,
          {
            certificateNumber: `  ${certNumber.toLowerCase()}  `,
            certificateName: 'Duplicate Cert',
            issuingAuthority: 'Kemnaker',
            issueDate: ISSUE_DATE,
            expiryDate: FUTURE_DATE,
          },
          managerActor,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 409 &&
        err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_ALREADY_ACTIVE,
    );

    // Same certificateNumber on a different worker is allowed
    const helperCert =
      await workforceCertificationService.createWorkforceCertification(
        helperWorkforceProfileIdA,
        {
          certificateNumber: certNumber,
          certificateName: 'Sertifikat K3 Helper',
          issuingAuthority: 'BNSP',
          issueDate: ISSUE_DATE,
          expiryDate: null,
        },
        managerActor,
      );
    assert.equal(helperCert.workforceProfileId, helperWorkforceProfileIdA);
    assert.equal(helperCert.expiryDate, null);
    assert.equal(helperCert.status, 'ACTIVE');
    assert.equal(helperCert.expiryStatus, 'VALID');

    // Verify the certification (PENDING_VERIFICATION -> VERIFIED)
    const verified =
      await workforceCertificationService.verifyWorkforceCertification(
        crewA.profile.id,
        created.id,
        {
          verificationStatus: 'VERIFIED',
          notes: 'Telah diverifikasi sesuai dokumen asli.',
        },
        managerActor,
      );
    assert.equal(verified.verificationStatus, 'VERIFIED');
    assert.equal(verified.verifiedByUserId, managerUserIdA);
    assert.ok(typeof verified.verifiedAt === 'string');
    assert.equal(verified.notes, 'Telah diverifikasi sesuai dokumen asli.');

    // Rejecting verification (VERIFIED -> REJECTED) updates audit fields
    const rejected =
      await workforceCertificationService.verifyWorkforceCertification(
        crewA.profile.id,
        created.id,
        {
          verificationStatus: 'REJECTED',
          notes: 'Masa berlaku dokumen lampiran buram.',
        },
        managerActor,
      );
    assert.equal(rejected.verificationStatus, 'REJECTED');
    assert.equal(rejected.verifiedByUserId, managerUserIdA);
    assert.ok(typeof rejected.verifiedAt === 'string');

    // Resetting to PENDING_VERIFICATION clears verifier audit fields
    const resetPending =
      await workforceCertificationService.verifyWorkforceCertification(
        crewA.profile.id,
        created.id,
        {
          verificationStatus: 'PENDING_VERIFICATION',
        },
        managerActor,
      );
    assert.equal(resetPending.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(resetPending.verifiedByUserId, null);
    assert.equal(resetPending.verifiedAt, null);

    // Deactivate certification -> status INACTIVE, expiryStatus NOT_APPLICABLE
    const deactivated =
      await workforceCertificationService.deactivateWorkforceCertification(
        crewA.profile.id,
        created.id,
        managerActor,
      );
    assert.equal(deactivated.status, 'INACTIVE');
    assert.equal(deactivated.expiryStatus, 'NOT_APPLICABLE');

    // Once INACTIVE, the same certificateNumber can be re-registered as ACTIVE
    const reissued =
      await workforceCertificationService.createWorkforceCertification(
        crewA.profile.id,
        {
          skillId: skillIdA,
          certificateNumber: certNumber,
          certificateName: 'Sertifikat K3 Listrik Teknisi (Pembaruan)',
          issuingAuthority: 'Kementerian Ketenagakerjaan RI',
          issueDate: ISSUE_DATE,
          expiryDate: FUTURE_DATE,
          verificationStatus: 'VERIFIED',
          documentId: documentIdA,
        },
        managerActor,
      );
    assert.equal(reissued.status, 'ACTIVE');
    assert.equal(reissued.verificationStatus, 'VERIFIED');
    assert.equal(reissued.verifiedByUserId, managerUserIdA);
    // Falls back fileReference to linked document's fileReference when not explicitly provided
    assert.equal(
      reissued.fileReference,
      'certifications/client-a/k3-listrik-001.pdf',
    );
  });

  it('enforces expiry status resolution and date consistency rules', async (t) => {
    if (!ready(t)) return;

    const managerActor = actorFor(managerUserIdA, ['workforce.manage']);

    assert.equal(
      resolveWorkforceCertificationExpiryStatus('ACTIVE', FUTURE_DATE),
      'VALID',
    );
    assert.equal(
      resolveWorkforceCertificationExpiryStatus('ACTIVE', null),
      'VALID',
    );
    assert.equal(
      resolveWorkforceCertificationExpiryStatus('EXPIRED', PAST_DATE),
      'EXPIRED',
    );
    assert.equal(
      resolveWorkforceCertificationExpiryStatus('INACTIVE', FUTURE_DATE),
      'NOT_APPLICABLE',
    );

    // Past expiryDate without explicit status automatically resolves to EXPIRED
    const expiredCert =
      await workforceCertificationService.createWorkforceCertification(
        crewA.profile.id,
        {
          certificateNumber: `CERT-EXP-${suffix()}`,
          certificateName: 'Sertifikat Lama',
          issuingAuthority: 'BNSP',
          issueDate: EARLY_ISSUE_DATE,
          expiryDate: PAST_DATE,
        },
        managerActor,
      );
    assert.equal(expiredCert.status, 'EXPIRED');
    assert.equal(expiredCert.expiryStatus, 'EXPIRED');

    // Requesting status ACTIVE with a past expiryDate is rejected
    await assert.rejects(
      () =>
        workforceCertificationService.createWorkforceCertification(
          crewA.profile.id,
          {
            certificateNumber: `CERT-BAD-${suffix()}`,
            certificateName: 'Invalid Active Past Expiry',
            issuingAuthority: 'BNSP',
            issueDate: EARLY_ISSUE_DATE,
            expiryDate: PAST_DATE,
            status: 'ACTIVE',
          },
          managerActor,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 400 &&
        err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_STATUS_DATE_MISMATCH,
    );

    // Requesting status EXPIRED with a future expiryDate is rejected
    await assert.rejects(
      () =>
        workforceCertificationService.createWorkforceCertification(
          crewA.profile.id,
          {
            certificateNumber: `CERT-BAD2-${suffix()}`,
            certificateName: 'Invalid Expired Future Expiry',
            issuingAuthority: 'BNSP',
            issueDate: ISSUE_DATE,
            expiryDate: FUTURE_DATE,
            status: 'EXPIRED',
          },
          managerActor,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 400 &&
        err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_STATUS_DATE_MISMATCH,
    );

    // listCurrentWorkforceCertifications excludes EXPIRED and INACTIVE records
    const currentCerts =
      await workforceCertificationService.listCurrentWorkforceCertifications(
        crewA.profile.id,
        managerActor,
      );
    assert.ok(currentCerts.length >= 1);
    assert.ok(currentCerts.every((c) => c.status === 'ACTIVE'));
    assert.ok(currentCerts.every((c) => c.expiryStatus === 'VALID'));
  });

  it('validates safe document references and blocks unsafe file references at both validation and DB layers', async (t) => {
    if (!ready(t)) return;

    const validEvidenceRef = `hm-ev://${randomUUID()}`;
    assert.equal(isSafeCertificationFileReference(validEvidenceRef), true);
    assert.equal(
      isSafeCertificationFileReference(
        'certifications/2026/worker_cert-01.pdf',
      ),
      true,
    );

    const unsafeReferences = [
      '../etc/passwd',
      'certifications/../../secret.key',
      '/absolute/path/cert.pdf',
      'certs\\windows\\path.pdf',
      'https://evil.example.com/cert.pdf',
      'http://internal.metadata/latest',
      'file:///etc/shadow',
      'javascript:alert(1)',
      'data:application/pdf;base64,AAAA',
      'certifications/with space/cert.pdf',
    ];

    for (const unsafeRef of unsafeReferences) {
      assert.equal(
        isSafeCertificationFileReference(unsafeRef),
        false,
        `expected unsafe fileReference to be rejected: ${unsafeRef}`,
      );
      assert.throws(
        () =>
          validateCreateWorkforceCertificationInput({
            number: 'CERT-001',
            name: 'Test Cert',
            issuer: 'BNSP',
            issuedAt: ISSUE_DATE,
            storageReference: unsafeRef,
          }),
        (err: unknown) =>
          err instanceof AppError &&
          err.statusCode === 400 &&
          err.code ===
            ERROR_CODES.WORKFORCE_CERTIFICATION_INVALID_FILE_REFERENCE,
      );
    }

    // Direct SQL insert with unsafe file_reference is blocked by DB CHECK constraint
    await assert.rejects(
      () =>
        pool!.query(
          `INSERT INTO workforce_certifications (
             id, client_id, workforce_profile_id, certificate_number,
             certificate_name, issuing_authority, issue_date, file_reference
           )
           VALUES ($1, $2, $3, 'CERT-SQL-UNSAFE', 'SQL Test', 'BNSP', NOW(), '../traversal.pdf')`,
          [randomUUID(), realmA.client.id, crewA.profile.id],
        ),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === '23514',
    );
  });

  it('enforces multi-client isolation at both service and PostgreSQL trigger layers', async (t) => {
    if (!ready(t)) return;

    const managerActorA = actorFor(managerUserIdA, ['skill.manage']);
    const leadActorB = actorFor(crewB.leadUser.id, ['skill.manage']);

    // Cross-client skillId is rejected by service
    await assert.rejects(
      () =>
        workforceCertificationService.createWorkforceCertification(
          crewA.profile.id,
          {
            skillId: skillIdB,
            certificateNumber: `CERT-XSKL-${suffix()}`,
            certificateName: 'Cross Client Skill Cert',
            issuingAuthority: 'BNSP',
            issueDate: ISSUE_DATE,
          },
          managerActorA,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 409 &&
        err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_CLIENT_MISMATCH,
    );

    // Inactive skillId on creation is rejected by service
    await assert.rejects(
      () =>
        workforceCertificationService.createWorkforceCertification(
          crewA.profile.id,
          {
            skillId: inactiveSkillIdA,
            certificateNumber: `CERT-INAS-${suffix()}`,
            certificateName: 'Inactive Skill Cert',
            issuingAuthority: 'BNSP',
            issueDate: ISSUE_DATE,
          },
          managerActorA,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 400 &&
        err.code === ERROR_CODES.SKILL_INACTIVE,
    );

    // Cross-client documentId is rejected by service
    await assert.rejects(
      () =>
        workforceCertificationService.createWorkforceCertification(
          crewA.profile.id,
          {
            documentId: documentIdB,
            certificateNumber: `CERT-XDOC-${suffix()}`,
            certificateName: 'Cross Client Document Cert',
            issuingAuthority: 'BNSP',
            issueDate: ISSUE_DATE,
          },
          managerActorA,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 409 &&
        err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_DOCUMENT_MISMATCH,
    );

    // Actor from Client B attempting to read or manage Client A worker certifications is denied (403 BUILDING_ACCESS_DENIED)
    await assert.rejects(
      () =>
        workforceCertificationService.listWorkforceCertifications(
          crewA.profile.id,
          {},
          leadActorB,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 403 &&
        err.code === ERROR_CODES.BUILDING_ACCESS_DENIED,
    );

    await assert.rejects(
      () =>
        workforceCertificationService.createWorkforceCertification(
          crewA.profile.id,
          {
            certificateNumber: `CERT-XB-${suffix()}`,
            certificateName: 'Cross Tenant Attempt',
            issuingAuthority: 'BNSP',
            issueDate: ISSUE_DATE,
          },
          leadActorB,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 403 &&
        err.code === ERROR_CODES.BUILDING_ACCESS_DENIED,
    );

    // Direct SQL cross-client insert (Client B client_id with Client A workforce_profile_id) is blocked by trigger
    await assert.rejects(
      () =>
        pool!.query(
          `INSERT INTO workforce_certifications (
             id, client_id, workforce_profile_id, certificate_number,
             certificate_name, issuing_authority, issue_date
           )
           VALUES ($1, $2, $3, 'CERT-SQL-XCLIENT', 'Trigger Test', 'BNSP', NOW())`,
          [randomUUID(), realmB.client.id, crewA.profile.id],
        ),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === '23514',
    );

    // Direct SQL cross-client skill_id is blocked by trigger
    await assert.rejects(
      () =>
        pool!.query(
          `INSERT INTO workforce_certifications (
             id, client_id, workforce_profile_id, skill_id, certificate_number,
             certificate_name, issuing_authority, issue_date
           )
           VALUES ($1, $2, $3, $4, 'CERT-SQL-XSKILL', 'Trigger Test', 'BNSP', NOW())`,
          [randomUUID(), realmA.client.id, crewA.profile.id, skillIdB],
        ),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === '23514',
    );

    // Direct SQL cross-client document_id is blocked by trigger
    await assert.rejects(
      () =>
        pool!.query(
          `INSERT INTO workforce_certifications (
             id, client_id, workforce_profile_id, document_id, certificate_number,
             certificate_name, issuing_authority, issue_date
           )
           VALUES ($1, $2, $3, $4, 'CERT-SQL-XDOC', 'Trigger Test', 'BNSP', NOW())`,
          [randomUUID(), realmA.client.id, crewA.profile.id, documentIdB],
        ),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === '23514',
    );
  });

  it('enforces RBAC for self-read, crew-lead read, peer denial, and management mutations', async (t) => {
    if (!ready(t)) return;

    const leadActor = actorFor(crewA.leadUser.id, []);
    const helperActor = actorFor(helperUserIdA, []);
    const readOnlyOpsActor = actorFor(managerUserIdA, ['skill.read']);

    // Worker can read their own certifications
    const ownCerts =
      await workforceCertificationService.listWorkforceCertifications(
        helperWorkforceProfileIdA,
        {},
        helperActor,
      );
    assert.equal(ownCerts.length, 1);

    // Active Crew Lead (PIC_PEKERJAAN) can read their crew helper's certifications
    const leadReadsHelper =
      await workforceCertificationService.listWorkforceCertifications(
        helperWorkforceProfileIdA,
        {},
        leadActor,
      );
    assert.equal(leadReadsHelper.length, 1);
    assert.equal(leadReadsHelper[0].id, ownCerts[0].id);

    // Peer Crew Member (non-lead) is forbidden from reading the Crew Lead's certifications
    await assert.rejects(
      () =>
        workforceCertificationService.listWorkforceCertifications(
          crewA.profile.id,
          {},
          helperActor,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 403 &&
        err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_FORBIDDEN,
    );

    // Read-only actor can read certifications in the same client
    const opsRead =
      await workforceCertificationService.listWorkforceCertifications(
        crewA.profile.id,
        {},
        readOnlyOpsActor,
      );
    assert.ok(opsRead.length >= 1);

    // Field worker or read-only actor cannot create, verify, or deactivate certifications
    for (const unauthorizedActor of [leadActor, helperActor, readOnlyOpsActor]) {
      await assert.rejects(
        () =>
          workforceCertificationService.createWorkforceCertification(
            helperWorkforceProfileIdA,
            {
              certificateNumber: `CERT-UNAUTH-${suffix()}`,
              certificateName: 'Unauthorized Create',
              issuingAuthority: 'BNSP',
              issueDate: ISSUE_DATE,
            },
            unauthorizedActor,
          ),
        (err: unknown) =>
          err instanceof AppError &&
          err.statusCode === 403 &&
          err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_FORBIDDEN,
      );

      await assert.rejects(
        () =>
          workforceCertificationService.verifyWorkforceCertification(
            helperWorkforceProfileIdA,
            ownCerts[0].id,
            { verificationStatus: 'VERIFIED' },
            unauthorizedActor,
          ),
        (err: unknown) =>
          err instanceof AppError &&
          err.statusCode === 403 &&
          err.code === ERROR_CODES.WORKFORCE_CERTIFICATION_FORBIDDEN,
      );
    }

    // Mobile worker profile endpoints remain intact for both lead and helper
    const leadProfile = await readMyHandymanWorkerProfileProjection(
      crewA.leadUser.id,
    );
    assert.equal(
      leadProfile.workerIdentity.workforceProfileId,
      crewA.profile.id,
    );
    assert.equal(
      leadProfile.certificationsAndExpiry.individualCertificateNumberModeled,
      true,
    );
    assert.ok(
      leadProfile.certificationsAndExpiry.individualCertifications.length >= 1,
    );

    const helperProfileByLead = await readHandymanWorkerProfileByContextId(
      crewA.leadUser.id,
      helperWorkerContextIdA,
    );
    assert.equal(
      helperProfileByLead.workerIdentity.workforceProfileId,
      helperWorkforceProfileIdA,
    );
  });
});

describe('CR-HM-WORKER-COMPETENCY-01 PART 02 — REST API & Worker Profile Integration', () => {
  let managerTokenA = '';
  let readOnlyTokenA = '';
  let noPermTokenA = '';
  let leadTokenA = '';
  let helperTokenA = '';
  let platformAdminToken = '';
  let uncertifiedUserTokenA = '';
  let uncertifiedWorkforceProfileIdA = '';
  let uncertifiedWorkerContextIdA = '';

  async function assignPermissionsToUser(
    userId: string,
    codes: string[],
  ): Promise<void> {
    const role = await roleService.createRole({
      code: `ROLE_${suffix()}`,
      name: `Role ${suffix()}`,
    });
    for (const code of codes) {
      let perm = await permissionRepository.findByCode(code);
      if (!perm) {
        perm = await permissionRepository.create({
          code,
          name: code,
        });
      }
      await permissionService.assignPermissionToRole(role.id, perm.id);
    }
    await roleService.assignRoleToUser(userId, role.id);
  }

  async function issueSessionToken(userId: string): Promise<string> {
    await credentialService
      .createInitialCredential({
        userId,
        password: 'TestPassword123!',
      })
      .catch(() => {
        // credential may already exist
      });
    const session = await sessionService.createSessionForUser(userId);
    return session.sessionToken;
  }

  before(async () => {
    if (!database || !pool) return;

    // 1. Manager in Client A with skill.read + skill.manage
    await assignPermissionsToUser(managerUserIdA, [
      'skill.read',
      'skill.manage',
    ]);
    managerTokenA = await issueSessionToken(managerUserIdA);

    // 2. Read-only user in Client A with skill.read only
    const readOnlyUser = await userService.createUser({
      email: `readonly-a-${suffix().toLowerCase()}@example.com`,
      displayName: 'Read Only User A',
    });
    await buildingAssignmentService.createAssignment(readOnlyUser.id, {
      buildingId: realmA.building.id,
    });
    await assignPermissionsToUser(readOnlyUser.id, ['skill.read']);
    readOnlyTokenA = await issueSessionToken(readOnlyUser.id);

    // 3. Authenticated user in Client A with no skill permissions
    const noPermUser = await userService.createUser({
      email: `noperm-a-${suffix().toLowerCase()}@example.com`,
      displayName: 'No Perm User A',
    });
    await buildingAssignmentService.createAssignment(noPermUser.id, {
      buildingId: realmA.building.id,
    });
    noPermTokenA = await issueSessionToken(noPermUser.id);

    // 4. Lead worker & helper worker sessions in Client A
    // Grant skill.read + skill.manage to leadUser to also test that even a user
    // holding skill.manage is forbidden from self-verifying their own certificate!
    await assignPermissionsToUser(crewA.leadUser.id, [
      'skill.read',
      'skill.manage',
    ]);
    leadTokenA = await issueSessionToken(crewA.leadUser.id);
    helperTokenA = await issueSessionToken(helperUserIdA);

    // 5. Uncertified worker in Client A (0 certificates) for mobile profile HTTP test
    const uncertifiedUser = await userService.createUser({
      email: `uncert-a-${suffix().toLowerCase()}@example.com`,
      displayName: 'Uncertified Worker A',
    });
    const uncertifiedProfile = await workforceService.createWorkforceProfile({
      organizationId: realmA.organization.id,
      departmentId: realmA.department.id,
      positionId: realmA.position.id,
      employeeCode: `UNC_${suffix()}`,
      fullName: 'Uncertified Worker A',
      workforceType: 'EXTERNAL',
      userId: uncertifiedUser.id,
    });
    uncertifiedWorkforceProfileIdA = uncertifiedProfile.id;
    await assignBuildingToWorkforce({
      workforceProfileId: uncertifiedProfile.id,
      buildingId: realmA.building.id,
    });
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: crewA.vendor.id,
      workforceProfileId: uncertifiedProfile.id,
      vendorPersonnelCode: `VP_UNC_${suffix()}`,
    });
    const uncertifiedContext =
      await handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: crewA.providerContext.id,
          workforceProfileId: uncertifiedProfile.id,
        },
        adminUserId,
      );
    uncertifiedWorkerContextIdA = uncertifiedContext.id;
    await addHandymanCrewMember(
      {
        handymanCrewId: crewA.crew.id,
        handymanWorkerContextId: uncertifiedContext.id,
      },
      adminUserId,
    );
    await buildingAssignmentService.createAssignment(uncertifiedUser.id, {
      buildingId: realmA.building.id,
    });
    uncertifiedUserTokenA = await issueSessionToken(uncertifiedUser.id);

    // 6. PLATFORM_ADMIN without any worker context
    const owner = await createOwnerUser();
    platformAdminToken = owner.token;
  });

  it('supports full HTTP CRUD, verify/reject, self-verification block, expired-verification block, and deactivate', async (t) => {
    if (!ready(t)) return;

    const certNumber = `CERT-HTTP-${suffix()}`;
    const expiringSoonDate = new Date(
      Date.now() + 10 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // 1. Create certificate via POST /api/v1/workforce/:workforceId/certifications
    const createRes = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        skillId: skillIdA,
        certificateNumber: certNumber,
        certificateName: 'Sertifikat Kompetensi K3 Teknisi Listrik',
        issuingAuthority: 'BNSP / Kemnaker RI',
        issueDate: ISSUE_DATE,
        expiryDate: expiringSoonDate,
        documentId: documentIdA,
        notes: 'Dokumen asli telah diperiksa saat onboarding.',
      });
    assert.equal(
      createRes.status,
      201,
      `expected 201, got ${createRes.status}: ${JSON.stringify(createRes.body)}`,
    );
    const created = createRes.body.data;
    assert.ok(created.id);
    assert.equal(created.workforceProfileId, crewA.profile.id);
    assert.equal(created.clientId, realmA.client.id);
    assert.equal(created.certificateNumber, certNumber);
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.expiryStatus, 'VALID');
    assert.equal(created.isExpired, false);
    assert.ok(
      typeof created.daysUntilExpiry === 'number' &&
        created.daysUntilExpiry >= 9 &&
        created.daysUntilExpiry <= 11,
    );
    assert.equal(created.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(created.isValidForRequirement, false);
    assert.equal(created.hasDocument, true);
    assert.equal(created.documentId, documentIdA);
    assert.ok(created.documentReference.documentNumber.startsWith('DOC-A-'));

    // 2. Missing certificateNumber is rejected with 400 VALIDATION_ERROR
    const missingNumRes = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        certificateName: 'No Number Cert',
        issuingAuthority: 'BNSP',
        issueDate: ISSUE_DATE,
      });
    assert.equal(missingNumRes.status, 400);
    assert.equal(missingNumRes.body.error.code, 'VALIDATION_ERROR');

    // 3. Duplicate ACTIVE certificateNumber on same worker returns 409
    const dupRes = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        certificateNumber: certNumber,
        certificateName: 'Duplicate Active Cert',
        issuingAuthority: 'BNSP',
        issueDate: ISSUE_DATE,
      });
    assert.equal(dupRes.status, 409);
    assert.equal(
      dupRes.body.error.code,
      ERROR_CODES.WORKFORCE_CERTIFICATION_ALREADY_ACTIVE,
    );

    // 4. List certificates via GET /api/v1/workforce/:workforceId/certifications
    const listRes = await api()
      .get(
        `/api/v1/workforce/${crewA.profile.id}/certifications?status=ACTIVE&skillId=${skillIdA}`,
      )
      .set('Authorization', `Bearer ${readOnlyTokenA}`);
    assert.equal(listRes.status, 200);
    assert.ok(
      listRes.body.data.some(
        (c: { id: string }) => c.id === created.id,
      ),
    );

    // 5. Get certificate detail via GET /api/v1/workforce/:workforceId/certifications/:certificationId
    const detailRes = await api()
      .get(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${created.id}`,
      )
      .set('Authorization', `Bearer ${readOnlyTokenA}`);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.data.id, created.id);
    assert.equal(detailRes.body.data.certificateNumber, certNumber);

    // 6. Update certificate metadata via PATCH /api/v1/workforce/:workforceId/certifications/:certificationId
    const patchRes = await api()
      .patch(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${created.id}`,
      )
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        certificateName: 'Sertifikat Kompetensi K3 Teknisi Listrik (Level Madya)',
        notes: 'Diperbarui ke kualifikasi Level Madya.',
      });
    assert.equal(patchRes.status, 200);
    assert.equal(
      patchRes.body.data.certificateName,
      'Sertifikat Kompetensi K3 Teknisi Listrik (Level Madya)',
    );
    assert.equal(
      patchRes.body.data.notes,
      'Diperbarui ke kualifikasi Level Madya.',
    );

    // 7. Self-verification is forbidden (403 WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN)
    // even when the certificate owner holds `skill.manage`!
    const selfVerifyRes = await api()
      .post(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${created.id}/verify`,
      )
      .set('Authorization', `Bearer ${leadTokenA}`)
      .send({
        verificationStatus: 'VERIFIED',
        notes: 'Mencoba verifikasi sertifikat milik sendiri.',
      });
    assert.equal(selfVerifyRes.status, 403);
    assert.equal(
      selfVerifyRes.body.error.code,
      ERROR_CODES.WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN,
    );

    // Self-verification via create or patch is also forbidden
    const selfCreateVerifiedRes = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${leadTokenA}`)
      .send({
        certificateNumber: `CERT-SELF-${suffix()}`,
        certificateName: 'Self Verified Create',
        issuingAuthority: 'BNSP',
        issueDate: ISSUE_DATE,
        verificationStatus: 'VERIFIED',
      });
    assert.equal(selfCreateVerifiedRes.status, 403);
    assert.equal(
      selfCreateVerifiedRes.body.error.code,
      ERROR_CODES.WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN,
    );

    // 8. Authorized manager verifies the certificate via POST .../verify
    const verifyRes = await api()
      .post(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${created.id}/verify`,
      )
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        verificationStatus: 'VERIFIED',
        notes: 'Diverifikasi oleh Workforce Manager A.',
      });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.body.data.verificationStatus, 'VERIFIED');
    assert.equal(verifyRes.body.data.verifiedByUserId, managerUserIdA);
    assert.ok(typeof verifyRes.body.data.verifiedAt === 'string');
    assert.equal(verifyRes.body.data.isValidForRequirement, true);

    // 9. Authorized manager can also reject a certificate via POST .../verify
    const rejectRes = await api()
      .post(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${created.id}/verify`,
      )
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        verificationStatus: 'REJECTED',
        notes: 'Stempel penerbit perlu konfirmasi ulang.',
      });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.data.verificationStatus, 'REJECTED');
    assert.equal(rejectRes.body.data.isValidForRequirement, false);

    // Re-verify back to VERIFIED so it remains active & verified for subsequent checks
    const reVerifyRes = await api()
      .post(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${created.id}/verify`,
      )
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        verificationStatus: 'VERIFIED',
        notes: 'Konfirmasi penerbit selesai, valid.',
      });
    assert.equal(reVerifyRes.status, 200);
    assert.equal(reVerifyRes.body.data.isValidForRequirement, true);

    // 10. Expired certificate cannot be marked VERIFIED and is never valid for requirements
    const expiredCreateRes = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        certificateNumber: `CERT-HTTP-EXP-${suffix()}`,
        certificateName: 'Sertifikat Lama Kedaluwarsa',
        issuingAuthority: 'BNSP',
        issueDate: EARLY_ISSUE_DATE,
        expiryDate: PAST_DATE,
      });
    assert.equal(expiredCreateRes.status, 201);
    assert.equal(expiredCreateRes.body.data.status, 'EXPIRED');
    assert.equal(expiredCreateRes.body.data.isExpired, true);
    assert.equal(expiredCreateRes.body.data.isValidForRequirement, false);

    const verifyExpiredRes = await api()
      .post(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${expiredCreateRes.body.data.id}/verify`,
      )
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        verificationStatus: 'VERIFIED',
      });
    assert.equal(verifyExpiredRes.status, 400);
    assert.equal(
      verifyExpiredRes.body.error.code,
      ERROR_CODES.WORKFORCE_CERTIFICATION_STATUS_DATE_MISMATCH,
    );

    // 11. Deactivate certificate via POST /api/v1/workforce/:workforceId/certifications/:certificationId/deactivate
    const toDeactivateRes = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        certificateNumber: `CERT-DEACT-${suffix()}`,
        certificateName: 'Sertifikat Sementara',
        issuingAuthority: 'BNSP',
        issueDate: ISSUE_DATE,
      });
    assert.equal(toDeactivateRes.status, 201);

    const deactivateRes = await api()
      .post(
        `/api/v1/workforce/${crewA.profile.id}/certifications/${toDeactivateRes.body.data.id}/deactivate`,
      )
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        notes: 'Sertifikat digantikan oleh sertifikat baru.',
      });
    assert.equal(deactivateRes.status, 200);
    assert.equal(deactivateRes.body.data.status, 'INACTIVE');
    assert.equal(deactivateRes.body.data.expiryStatus, 'NOT_APPLICABLE');
    assert.equal(deactivateRes.body.data.isValidForRequirement, false);
    assert.equal(
      deactivateRes.body.data.notes,
      'Sertifikat digantikan oleh sertifikat baru.',
    );

    // Verify audit events were recorded in operational_events
    const auditEvents = await pool!.query<{ event_type: string }>(
      `SELECT event_type
         FROM operational_events
        WHERE entity_type = 'WORKFORCE_CERTIFICATION'
          AND entity_id IN ($1, $2)`,
      [created.id, toDeactivateRes.body.data.id],
    );
    const eventTypes = new Set(auditEvents.rows.map((r) => r.event_type));
    assert.ok(eventTypes.has('WORKFORCE_CERTIFICATION_CREATED'));
    assert.ok(eventTypes.has('WORKFORCE_CERTIFICATION_UPDATED'));
    assert.ok(eventTypes.has('WORKFORCE_CERTIFICATION_VERIFIED'));
    assert.ok(eventTypes.has('WORKFORCE_CERTIFICATION_DEACTIVATED'));
  });

  it('lists expiring certificates via GET /api/v1/workforce/certifications/expiring with strict Client isolation', async (t) => {
    if (!ready(t)) return;

    // Create an expiring certificate in Client B (via owner/platform admin or direct service)
    const expiringBDate = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const certB =
      await workforceCertificationService.createWorkforceCertification(
        crewB.profile.id,
        {
          certificateNumber: `CERT-B-EXP-${suffix()}`,
          certificateName: 'Client B Expiring Cert',
          issuingAuthority: 'BNSP',
          issueDate: ISSUE_DATE,
          expiryDate: expiringBDate,
        },
      );

    // Client A read-only user queries GET /api/v1/workforce/certifications/expiring?withinDays=30
    const expiringResA = await api()
      .get('/api/v1/workforce/certifications/expiring?withinDays=30')
      .set('Authorization', `Bearer ${readOnlyTokenA}`);
    assert.equal(expiringResA.status, 200);
    assert.ok(Array.isArray(expiringResA.body.data));
    assert.ok(expiringResA.body.data.length >= 1);
    // Every returned certificate must belong to Client A — never Client B!
    for (const c of expiringResA.body.data) {
      assert.equal(c.clientId, realmA.client.id);
      assert.notEqual(c.id, certB.id);
      assert.equal(c.status, 'ACTIVE');
      assert.equal(c.isExpired, false);
    }

    // Including already expired certificates via includeExpired=true
    const withExpiredRes = await api()
      .get(
        `/api/v1/workforce/certifications/expiring?withinDays=30&includeExpired=true&workforceProfileId=${crewA.profile.id}`,
      )
      .set('Authorization', `Bearer ${readOnlyTokenA}`);
    assert.equal(withExpiredRes.status, 200);
    assert.ok(
      withExpiredRes.body.data.some(
        (c: { status: string }) => c.status === 'EXPIRED',
      ),
    );

    // Client A user explicitly filtering by Client B's clientId is rejected with 403 BUILDING_ACCESS_DENIED
    const crossClientFilterRes = await api()
      .get(
        `/api/v1/workforce/certifications/expiring?clientId=${realmB.client.id}`,
      )
      .set('Authorization', `Bearer ${readOnlyTokenA}`);
    assert.equal(crossClientFilterRes.status, 403);
    assert.equal(
      crossClientFilterRes.body.error.code,
      ERROR_CODES.BUILDING_ACCESS_DENIED,
    );

    // Client A user explicitly filtering by Client B's workforceProfileId is rejected with 403 BUILDING_ACCESS_DENIED
    const crossProfileFilterRes = await api()
      .get(
        `/api/v1/workforce/certifications/expiring?workforceProfileId=${crewB.profile.id}`,
      )
      .set('Authorization', `Bearer ${readOnlyTokenA}`);
    assert.equal(crossProfileFilterRes.status, 403);
    assert.equal(
      crossProfileFilterRes.body.error.code,
      ERROR_CODES.BUILDING_ACCESS_DENIED,
    );
  });

  it('enforces HTTP authentication, RBAC permissions, and cross-client isolation on all routes', async (t) => {
    if (!ready(t)) return;

    // 1. Unauthenticated -> 401
    const unauthRes = await api().get(
      `/api/v1/workforce/${crewA.profile.id}/certifications`,
    );
    assert.equal(unauthRes.status, 401);

    // 2. Authenticated user without skill.read -> 403 on GET routes
    const noPermList = await api()
      .get(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${noPermTokenA}`);
    assert.equal(noPermList.status, 403);

    const noPermExpiring = await api()
      .get('/api/v1/workforce/certifications/expiring')
      .set('Authorization', `Bearer ${noPermTokenA}`);
    assert.equal(noPermExpiring.status, 403);

    // 3. Authenticated user with skill.read only -> 403 on POST/PATCH/verify/deactivate
    const readOnlyCreate = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${readOnlyTokenA}`)
      .send({
        certificateNumber: `CERT-RO-${suffix()}`,
        certificateName: 'Read Only Attempt',
        issuingAuthority: 'BNSP',
        issueDate: ISSUE_DATE,
      });
    assert.equal(readOnlyCreate.status, 403);

    // 4. Manager in Client A (holding skill.read + skill.manage) cannot read or mutate Client B workforce certifications
    const crossClientRead = await api()
      .get(`/api/v1/workforce/${crewB.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`);
    assert.equal(crossClientRead.status, 403);
    assert.equal(
      crossClientRead.body.error.code,
      ERROR_CODES.BUILDING_ACCESS_DENIED,
    );

    const crossClientCreate = await api()
      .post(`/api/v1/workforce/${crewB.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        certificateNumber: `CERT-XB-${suffix()}`,
        certificateName: 'Cross Client Create',
        issuingAuthority: 'BNSP',
        issueDate: ISSUE_DATE,
      });
    assert.equal(crossClientCreate.status, 403);
    assert.equal(
      crossClientCreate.body.error.code,
      ERROR_CODES.BUILDING_ACCESS_DENIED,
    );

    // 5. Manager in Client A cannot link a Client B document to a Client A certification
    const crossDocCreate = await api()
      .post(`/api/v1/workforce/${crewA.profile.id}/certifications`)
      .set('Authorization', `Bearer ${managerTokenA}`)
      .send({
        certificateNumber: `CERT-XDOC-${suffix()}`,
        certificateName: 'Cross Client Document Link',
        issuingAuthority: 'BNSP',
        issueDate: ISSUE_DATE,
        documentId: documentIdB,
      });
    assert.equal(crossDocCreate.status, 409);
    assert.equal(
      crossDocCreate.body.error.code,
      ERROR_CODES.WORKFORCE_CERTIFICATION_DOCUMENT_MISMATCH,
    );
  });

  it('integrates individual certifications into mobile worker profile endpoints while keeping uncertified workers and PLATFORM_ADMIN safe', async (t) => {
    if (!ready(t)) return;

    // 1. Certified worker (Lead Worker A) calls GET /api/v1/handyman/field/me/profile
    const meRes = await api()
      .get('/api/v1/handyman/field/me/profile')
      .set('Authorization', `Bearer ${leadTokenA}`);
    assert.equal(
      meRes.status,
      200,
      `expected 200, got ${meRes.status}: ${JSON.stringify(meRes.body)}`,
    );
    const leadProfile = meRes.body.data.profile;
    assert.equal(
      leadProfile.certificationsAndExpiry.individualCertificateNumberModeled,
      true,
    );
    assert.ok(
      Array.isArray(
        leadProfile.certificationsAndExpiry.individualCertifications,
      ),
    );
    assert.ok(
      leadProfile.certificationsAndExpiry.individualCertifications.length >= 1,
    );
    // Verify required fields on individualCertifications entry
    const verifiedCert =
      leadProfile.certificationsAndExpiry.individualCertifications.find(
        (c: { verificationStatus: string; status: string }) =>
          c.status === 'ACTIVE' && c.verificationStatus === 'VERIFIED',
      );
    assert.ok(verifiedCert, 'expected at least one ACTIVE VERIFIED cert');
    assert.equal(verifiedCert.workforceProfileId, crewA.profile.id);
    assert.ok(typeof verifiedCert.certificationId === 'string');
    assert.ok(typeof verifiedCert.certificateNumber === 'string');
    assert.ok(typeof verifiedCert.certificateName === 'string');
    assert.ok(typeof verifiedCert.issuingAuthority === 'string');
    assert.equal(verifiedCert.expiryStatus, 'VALID');
    assert.equal(verifiedCert.isExpired, false);
    assert.equal(verifiedCert.isValidForRequirement, true);
    assert.equal(verifiedCert.hasDocument, true);
    assert.ok(verifiedCert.documentReference);

    // Existing skillValidityWindows and providerLicensesAndCertifications remain intact
    assert.ok(
      Array.isArray(leadProfile.certificationsAndExpiry.skillValidityWindows),
    );
    assert.ok(
      Array.isArray(
        leadProfile.certificationsAndExpiry.providerLicensesAndCertifications,
      ),
    );

    // 2. Scoped worker profile GET /api/v1/handyman/field/workers/:workerContextId/profile
    const helperContextRes = await api()
      .get(`/api/v1/handyman/field/workers/${helperWorkerContextIdA}/profile`)
      .set('Authorization', `Bearer ${leadTokenA}`);
    assert.equal(helperContextRes.status, 200);
    const helperProfile = helperContextRes.body.data.profile;
    assert.equal(
      helperProfile.certificationsAndExpiry.individualCertificateNumberModeled,
      true,
    );
    assert.equal(
      helperProfile.certificationsAndExpiry.individualCertifications.length,
      1,
    );
    assert.equal(
      helperProfile.certificationsAndExpiry.individualCertifications[0]
        .workforceProfileId,
      helperWorkforceProfileIdA,
    );

    // 3. Worker WITHOUT any certificates still receives HTTP 200 with an empty individualCertifications list
    const uncertMeRes = await api()
      .get('/api/v1/handyman/field/me/profile')
      .set('Authorization', `Bearer ${uncertifiedUserTokenA}`);
    assert.equal(uncertMeRes.status, 200);
    assert.equal(
      uncertMeRes.body.data.profile.workerIdentity.workforceProfileId,
      uncertifiedWorkforceProfileIdA,
    );
    assert.equal(
      uncertMeRes.body.data.profile.certificationsAndExpiry
        .individualCertificateNumberModeled,
      true,
    );
    assert.deepEqual(
      uncertMeRes.body.data.profile.certificationsAndExpiry
        .individualCertifications,
      [],
    );

    const uncertByContextRes = await api()
      .get(
        `/api/v1/handyman/field/workers/${uncertifiedWorkerContextIdA}/profile`,
      )
      .set('Authorization', `Bearer ${leadTokenA}`);
    assert.equal(uncertByContextRes.status, 200);
    assert.deepEqual(
      uncertByContextRes.body.data.profile.certificationsAndExpiry
        .individualCertifications,
      [],
    );

    // 4. PLATFORM_ADMIN without worker context receives controlled 404 HANDYMAN_WORKER_PROFILE_NOT_FOUND, never 500
    const adminMeRes = await api()
      .get('/api/v1/handyman/field/me/profile')
      .set('Authorization', `Bearer ${platformAdminToken}`);
    assert.equal(adminMeRes.status, 404);
    assert.equal(
      adminMeRes.body.error.code,
      ERROR_CODES.HANDYMAN_WORKER_PROFILE_NOT_FOUND,
    );
  });
});
