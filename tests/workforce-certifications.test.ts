import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
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
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import {
  crewFixture,
  initHandymanFixtures,
  realmFixture,
} from './helpers/handyman-fixtures';
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
    // PART 02 — the individual certificate number IS now modeled, and the list
    // is present-but-empty for a worker without certificates.
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

    const managerActor = actorFor(managerUserIdA, [
    'workforce_certification.manage',
    'workforce_certification.verify',
  ]);
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
          documentId: documentIdA,
        },
        managerActor,
      );
    assert.equal(reissued.status, 'ACTIVE');
    // PART 02 — a create can never mint a VERIFIED attestation; the decision is
    // its own authority/endpoint.
    assert.equal(reissued.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(reissued.verifiedByUserId, null);
    const reissuedVerified =
      await workforceCertificationService.verifyWorkforceCertification(
        crewA.profile.id,
        reissued.id,
        { verificationStatus: 'VERIFIED' },
        managerActor,
      );
    assert.equal(reissuedVerified.verificationStatus, 'VERIFIED');
    assert.equal(reissuedVerified.verifiedByUserId, managerUserIdA);
    // Falls back fileReference to linked document's fileReference when not explicitly provided
    assert.equal(
      reissued.fileReference,
      'certifications/client-a/k3-listrik-001.pdf',
    );
  });

  it('enforces expiry status resolution and date consistency rules', async (t) => {
    if (!ready(t)) return;

    // Read and manage are separate codes (manage is not a package that implies
    // read), exactly as the mounted routes require.
    const managerActor = actorFor(managerUserIdA, [
      'workforce_certification.read',
      'workforce_certification.manage',
    ]);

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

    const managerActorA = actorFor(managerUserIdA, [
    'workforce_certification.manage',
  ]);
    const leadActorB = actorFor(crewB.leadUser.id, [
    'workforce_certification.manage',
  ]);

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
    const readOnlyOpsActor = actorFor(managerUserIdA, [
    'workforce_certification.read',
  ]);

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
