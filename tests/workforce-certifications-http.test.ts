import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { api } from './helpers/http';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { sessionService } from '../src/modules/auth/session.service';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanCrewMember,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import { permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { skillService } from '../src/modules/skills';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
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

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 02 — REST API & Worker Profile Integration.
 *
 * Focused HTTP suite (real app, real sessions, real RBAC middleware, real
 * PostgreSQL migrations — no mocked permission resolver). It pins the whole
 * transport contract:
 *
 *   - every operation's status codes and the shared `{success,data,meta}`
 *     envelope,
 *   - the dedicated `workforce_certification.*` authority (and the fact that
 *     `skill.*` / `workforce.*` / `tenant_company.*` are NOT substitutes),
 *   - verification as separation of duties (manage ≠ verify, and the owner can
 *     never decide on their own record),
 *   - Client isolation on every operation, including the expiry watch and the
 *     document reference,
 *   - expiry semantics (`isExpired` / `isValid`, verify-while-expired),
 *   - the Mobile worker profile projection (individual certificates, empty list,
 *     and a controlled domain response for a PLATFORM_ADMIN without a worker
 *     context).
 */

const EMBEDDED_DIR = '/tmp/hm-workforce-certifications-http-pg';
const EMBEDDED_PORT = 55661;

const API = '/api/v1';

/** One app instance for the whole suite (routers are static). */
const request = api();
const ISSUE_DATE = '2024-02-01T00:00:00.000Z';
const FUTURE_DATE = '2030-06-30T00:00:00.000Z';
const PAST_DATE = '2020-06-30T00:00:00.000Z';

const CERT_READ = { code: 'workforce_certification.read', name: 'Read Workforce Certifications' };
const CERT_MANAGE = {
  code: 'workforce_certification.manage',
  name: 'Manage Workforce Certifications',
};
const CERT_VERIFY = {
  code: 'workforce_certification.verify',
  name: 'Verify or Reject Workforce Certifications',
};

let embedded: EmbeddedTestDatabase | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

type Realm = Awaited<ReturnType<typeof realmFixture>>;
type Crew = Awaited<ReturnType<typeof crewFixture>>;

let realmA: Realm;
let realmB: Realm;
let crewA: Crew;

/** Client-A worker whose certificates are the subject of every assertion. */
let workerUserIdA = '';
let workerProfileIdA = '';
let workerContextIdA = '';
/** Client-A ops actor: read + manage. */
let managerTokenA = '';
/** Client-A verifier: read + verify (NOT manage). */
let verifierTokenA = '';
/** Client-A read-only actor. */
let readerTokenA = '';
/** Client-A actor holding manage but NOT verify. */
let manageOnlyTokenA = '';
/** Client-B ops actor: read + manage + verify, in the OTHER Client. */
let managerTokenB = '';
/** The certificate owner, holding read + verify (to prove self-verification). */
let ownerVerifyTokenA = '';
/** A user with no permissions at all. */
let plainTokenA = '';

let skillIdA = '';
let documentIdA = '';
let documentIdB = '';

async function createSessionFor(
  email: string,
  displayName: string,
  permissions: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const password = 'CertHttp123';
  const user = await userService.createUser({ email, displayName });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });

  const role = await roleService.createRole({
    code: `CERT_${suffix()}`,
    name: `Cert Role ${suffix()}`,
  });
  for (const permission of permissions) {
    const permissionId = await ensurePermissionId(permission);
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  const session = await sessionService.createSessionForUser(user.id);
  return { token: session.sessionToken, userId: user.id };
}

async function ensurePermissionId(permission: {
  code: string;
  name: string;
}): Promise<string> {
  const { permissionRepository } = await import(
    '../src/modules/permissions/permission.repository'
  );
  const existing = await permissionRepository.findByCode(permission.code);
  if (existing) {
    return existing.id;
  }
  const created = await permissionService.createPermission({
    code: permission.code,
    name: permission.name,
  });
  return created.id;
}

/**
 * Context access is derived from ACTIVE Building assignments, so every actor in
 * this suite must be explicitly assigned to the Building of the Client they are
 * expected to reach. Nothing is granted implicitly.
 */
async function assignActorToBuilding(
  userId: string,
  buildingId: string,
): Promise<void> {
  await buildingAssignmentService.createAssignment(userId, { buildingId });
}

/**
 * Builds a complete, production-shaped worker: workforce profile → building
 * placement → vendor binding → worker context → crew membership, plus the
 * Building assignment that makes the actor's Client reachable.
 */
async function createWorkerProfileForUser(options: {
  userId?: string;
  realm: Realm;
  crew: Crew;
  label: string;
  memberOfCrew: boolean;
  createIdentity: boolean;
}): Promise<{ userId: string; profileId: string; contextId: string }> {
  const { realm, crew, label } = options;

  let userId = options.userId ?? '';
  if (options.createIdentity) {
    const user = await userService.createUser({
      email: `worker-${label}-${suffix().toLowerCase()}@example.com`,
      displayName: `Worker ${label}`,
    });
    await credentialService.createInitialCredential({
      userId: user.id,
      password: 'WorkerPass123',
    });
    userId = user.id;
  }

  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `WRK_${suffix()}`,
    fullName: `Worker ${label}`,
    workforceType: 'EXTERNAL',
    userId,
  });

  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: realm.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: crew.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const context = await handymanWorkerContextService.createHandymanWorkerContext(
    {
      handymanProviderContextId: crew.providerContext.id,
      workforceProfileId: profile.id,
    },
    adminUserId,
  );
  if (options.memberOfCrew) {
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: context.id,
      },
      adminUserId,
    );
  }
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: realm.building.id,
  });

  return { userId, profileId: profile.id, contextId: context.id };
}

async function createWorker(
  realm: Realm,
  crew: Crew,
  label: string,
  options: { memberOfCrew: boolean },
): Promise<{ userId: string; profileId: string; contextId: string }> {
  return createWorkerProfileForUser({
    realm,
    crew,
    label,
    memberOfCrew: options.memberOfCrew,
    createIdentity: true,
  });
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

type Envelope<T> = {
  success: boolean;
  data: T;
  meta: Record<string, unknown>;
  error?: { code: string; message: string };
};

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

  realmA = await realmFixture('CertHttpA');
  realmB = await realmFixture('CertHttpB');
  crewA = await crewFixture(realmA);

  const workerA = await createWorker(realmA, crewA, 'subject', {
    memberOfCrew: true,
  });
  workerUserIdA = workerA.userId;
  workerProfileIdA = workerA.profileId;
  workerContextIdA = workerA.contextId;

  managerTokenA = (
    await createSessionFor(
      `mgr-a-${suffix().toLowerCase()}@example.com`,
      'Cert Manager A',
      [CERT_READ, CERT_MANAGE],
    )
  ).token;

  manageOnlyTokenA = (
    await createSessionFor(
      `mgr-only-a-${suffix().toLowerCase()}@example.com`,
      'Manage Only A',
      [CERT_MANAGE],
    )
  ).token;

  verifierTokenA = (
    await createSessionFor(
      `verifier-a-${suffix().toLowerCase()}@example.com`,
      'Cert Verifier A',
      [CERT_READ, CERT_VERIFY],
    )
  ).token;

  readerTokenA = (
    await createSessionFor(
      `reader-a-${suffix().toLowerCase()}@example.com`,
      'Cert Reader A',
      [CERT_READ],
    )
  ).token;

  managerTokenB = (
    await createSessionFor(
      `mgr-b-${suffix().toLowerCase()}@example.com`,
      'Cert Manager B',
      [CERT_READ, CERT_MANAGE, CERT_VERIFY],
    )
  ).token;

  // The certificate owner themselves, holding BOTH dedicated permissions —
  // self-verification must still be refused.
  ownerVerifyTokenA = (
    await createSessionFor(
      `worker-owner-${suffix().toLowerCase()}@example.com`,
      'Owner Actor',
      [CERT_READ, CERT_MANAGE, CERT_VERIFY],
    )
  ).token;

  plainTokenA = (
    await createSessionFor(
      `plain-a-${suffix().toLowerCase()}@example.com`,
      'Plain Actor',
      [],
    )
  ).token;

  // Context access is explicit: every actor is assigned to the Building of the
  // Client they are meant to reach, and only that Client.
  for (const token of [
    managerTokenA,
    manageOnlyTokenA,
    verifierTokenA,
    readerTokenA,
    plainTokenA,
  ]) {
    await assignActorToBuilding(
      (await userForToken(token)).userId,
      realmA.building.id,
    );
  }
  await assignActorToBuilding(
    (await userForToken(managerTokenB)).userId,
    realmB.building.id,
  );

  skillIdA = (
    await skillService.createSkill({
      clientId: realmA.client.id,
      code: `SKL_HTTP_${suffix()}`,
      name: 'K3 Listrik Tegangan Rendah',
      category: 'SAFETY',
    })
  ).id;

  documentIdA = randomUUID();
  await pool.query(
    `INSERT INTO documents (
       id, client_id, building_id, document_number, document_type,
       context_type, title, description, file_reference, status, created_by_user_id
     )
     VALUES ($1, $2, $3, $4, 'OTHER', 'INTERNAL',
       'Sertifikat K3 PDF', 'Bukti sertifikat', 
       'certifications/http/client-a/k3.pdf', 'ACTIVE', $5)`,
    [documentIdA, realmA.client.id, realmA.building.id, `DOC-A-${suffix()}`, adminUserId],
  );

  documentIdB = randomUUID();
  await pool.query(
    `INSERT INTO documents (
       id, client_id, building_id, document_number, document_type,
       context_type, title, description, file_reference, status, created_by_user_id
     )
     VALUES ($1, $2, $3, $4, 'OTHER', 'INTERNAL',
       'Client B Document', 'Dokumen Client B',
       'certifications/http/client-b/hvac.pdf', 'ACTIVE', $5)`,
    [documentIdB, realmB.client.id, realmB.building.id, `DOC-B-${suffix()}`, adminUserId],
  );

  database = db;
});

async function userForToken(
  token: string,
): Promise<{ userId: string }> {
  const context = await sessionService.resolveSessionContext(token);
  return { userId: context.userId };
}

after(async () => {
  if (pool) await closePool(pool).catch(() => undefined);
  pool = null;
  database = null;
  if (embedded) await embedded.stop();
  embedded = null;
});

type CreateBody = {
  certificateNumber: string;
  certificateName: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate?: string | null;
  skillId?: string | null;
  documentId?: string | null;
  fileReference?: string | null;
  notes?: string | null;
};

function certBody(overrides: Partial<CreateBody> = {}): CreateBody {
  return {
    certificateNumber: `CERT-HTTP-${suffix()}`,
    certificateName: 'Sertifikat K3 Listrik Teknisi',
    issuingAuthority: 'Kementerian Ketenagakerjaan RI',
    issueDate: ISSUE_DATE,
    expiryDate: FUTURE_DATE,
    ...overrides,
  };
}

async function createCert(
  token: string,
  body: CreateBody,
  workforceProfileId = workerProfileIdA,
) {
  return request
    .post(`${API}/workforce/${workforceProfileId}/certifications`)
    .set(auth(token))
    .send(body);
}

describe('CR-HM-WORKER-COMPETENCY-01 PART 02 — certification REST API', () => {
  it('requires authentication on every operation', async (t) => {
    if (!ready(t)) return;
    const paths: Array<[string, string]> = [
      ['get', `/workforce/certifications/expiring`],
      ['get', `/workforce/${workerProfileIdA}/certifications`],
      ['get', `/workforce/${workerProfileIdA}/certifications/${randomUUID()}`],
      ['post', `/workforce/${workerProfileIdA}/certifications`],
      ['patch', `/workforce/${workerProfileIdA}/certifications/${randomUUID()}`],
      [
        'post',
        `/workforce/${workerProfileIdA}/certifications/${randomUUID()}/verify`,
      ],
      [
        'post',
        `/workforce/${workerProfileIdA}/certifications/${randomUUID()}/deactivate`,
      ],
    ];
    for (const [method, path] of paths) {
      const response =
        method === 'get'
          ? await request.get(`${API}${path}`)
          : method === 'post'
            ? await request.post(`${API}${path}`).send({})
            : await request.patch(`${API}${path}`).send({});
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path}`);
      assert.equal(response.body.success, false);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('creates a certificate with the shared success envelope, as PENDING_VERIFICATION', async (t) => {
    if (!ready(t)) return;

    const body = certBody({
      skillId: skillIdA,
      documentId: documentIdA,
      fileReference: 'certifications/http/k3-teknisi.pdf',
    });
    const response = await createCert(managerTokenA, body);
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.meta, {});

    const created = response.body.data;
    assert.equal(created.clientId, realmA.client.id);
    assert.equal(created.workforceProfileId, workerProfileIdA);
    assert.equal(created.certificateNumber, body.certificateNumber);
    assert.equal(created.issuingAuthority, 'Kementerian Ketenagakerjaan RI');
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.expiryStatus, 'VALID');
    assert.equal(created.isExpired, false);
    assert.equal(created.isValid, false, 'unverified is never usable');
    assert.equal(created.verificationStatus, 'PENDING_VERIFICATION');
    assert.equal(created.verifiedByUserId, null);
    assert.equal(created.verifiedAt, null);
    assert.equal(created.skill?.id, skillIdA);
    assert.equal(created.documentId, documentIdA);
    assert.equal(created.documentReference?.id, documentIdA);
    assert.equal(created.fileReference, 'certifications/http/k3-teknisi.pdf');

    // Detail + list round-trip.
    const detail = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(readerTokenA));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.success, true);
    assert.equal(detail.body.data.id, created.id);

    const list = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications`)
      .set(auth(readerTokenA));
    assert.equal(list.status, 200);
    assert.ok(
      list.body.data.some((row: { id: string }) => row.id === created.id),
    );

    // The Skill assignment authority and vendor licences remain untouched: a
    // certificate is a separate fact, never a disguised skill/vendor record.
    const skillAssignments = await pool!.query(
      'SELECT id FROM workforce_skill_assignments WHERE workforce_profile_id = $1',
      [workerProfileIdA],
    );
    assert.equal(skillAssignments.rowCount, 0);
    const vendorLicences = await pool!.query(
      'SELECT id FROM vendor_licenses_certifications WHERE vendor_id = $1',
      [crewA.vendor.id],
    );
    assert.equal(vendorLicences.rowCount, 0);
  });

  it('rejects a create that tries to set verificationStatus (no self-attestation)', async (t) => {
    if (!ready(t)) return;
    const response = await createCert(managerTokenA, {
      ...certBody(),
      verificationStatus: 'VERIFIED',
    } as never);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      String(response.body.error.details ?? response.body.error.message).includes(
        'verificationStatus',
      ),
    );
  });

  it('validates mandatory metadata, dates, and safe document references', async (t) => {
    if (!ready(t)) return;

    const missingNumber = await createCert(managerTokenA, {
      certificateName: 'Tanpa Nomor',
      issuingAuthority: 'BNSP',
      issueDate: ISSUE_DATE,
    } as never);
    assert.equal(missingNumber.status, 400);
    assert.ok(
      missingNumber.body.error.details.some((detail: string) =>
        detail.includes('certificateNumber'),
      ),
    );

    const reversedDates = await createCert(
      managerTokenA,
      certBody({ issueDate: FUTURE_DATE, expiryDate: PAST_DATE }),
    );
    assert.equal(reversedDates.status, 400);
    assert.ok(
      reversedDates.body.error.details.some((detail: string) =>
        detail.includes('expiryDate'),
      ),
    );

    const unsafeReference = await createCert(
      managerTokenA,
      certBody({ fileReference: 'https://evil.example/cert.pdf' }),
    );
    assert.equal(unsafeReference.status, 400);
    assert.equal(
      unsafeReference.body.error.code,
      'WORKFORCE_CERTIFICATION_INVALID_FILE_REFERENCE',
    );

    const traversal = await createCert(
      managerTokenA,
      certBody({ fileReference: '../../etc/passwd' }),
    );
    assert.equal(traversal.status, 400);
    assert.equal(
      traversal.body.error.code,
      'WORKFORCE_CERTIFICATION_INVALID_FILE_REFERENCE',
    );

    const badParam = await request
      .get(`${API}/workforce/not-a-uuid/certifications`)
      .set(auth(readerTokenA));
    assert.equal(badParam.status, 400);
    assert.equal(badParam.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a duplicate ACTIVE certificate number for the same worker', async (t) => {
    if (!ready(t)) return;
    const body = certBody();
    const first = await createCert(managerTokenA, body);
    assert.equal(first.status, 201);

    const duplicate = await createCert(managerTokenA, {
      ...body,
      certificateNumber: ` ${body.certificateNumber.toLowerCase()} `,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'WORKFORCE_CERTIFICATION_ALREADY_ACTIVE',
    );
  });

  it('updates metadata only — never the verification decision', async (t) => {
    if (!ready(t)) return;
    const created = (await createCert(managerTokenA, certBody())).body.data;

    const updated = await request
      .patch(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(managerTokenA))
      .send({ certificateName: 'Sertifikat K3 (koreksi nama)', notes: 'Nama diperbaiki.' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.certificateName, 'Sertifikat K3 (koreksi nama)');
    assert.equal(updated.body.data.notes, 'Nama diperbaiki.');
    assert.equal(updated.body.data.verificationStatus, 'PENDING_VERIFICATION');

    const verifyViaPatch = await request
      .patch(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(managerTokenA))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(verifyViaPatch.status, 400);
    assert.equal(verifyViaPatch.body.error.code, 'VALIDATION_ERROR');

    const emptyPatch = await request
      .patch(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(managerTokenA))
      .send({});
    assert.equal(emptyPatch.status, 400);
    assert.equal(emptyPatch.body.error.code, 'VALIDATION_ERROR');

    // A partial update re-validates status against the STORED record.
    const contradictory = await request
      .patch(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(managerTokenA))
      .send({ expiryDate: PAST_DATE });
    assert.equal(contradictory.status, 400);
    assert.equal(
      contradictory.body.error.code,
      'WORKFORCE_CERTIFICATION_STATUS_DATE_MISMATCH',
    );
  });

  it('records a verification decision with the dedicated permission only', async (t) => {
    if (!ready(t)) return;
    const created = (await createCert(managerTokenA, certBody())).body.data;

    // manage is NOT verify.
    const byManager = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.id}/verify`,
      )
      .set(auth(manageOnlyTokenA))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(byManager.status, 403);
    assert.equal(byManager.body.error.code, 'PERMISSION_DENIED');

    const verified = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.id}/verify`,
      )
      .set(auth(verifierTokenA))
      .send({ verificationStatus: 'VERIFIED', notes: 'Sesuai dokumen asli.' });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.data.verificationStatus, 'VERIFIED');
    assert.equal(verified.body.data.isValid, true);
    assert.ok(verified.body.data.verifiedByUserId);
    assert.ok(typeof verified.body.data.verifiedAt === 'string');

    // The decision is audited.
    const events = await pool!.query(
      `SELECT event_type, actor_user_id, metadata
         FROM operational_events
        WHERE entity_id = $1 AND event_type = 'WORKFORCE_CERTIFICATION_VERIFIED'`,
      [created.id],
    );
    assert.ok((events.rowCount ?? 0) >= 1);
    assert.equal(events.rows[0].actor_user_id, (
      await userForToken(verifierTokenA)
    ).userId);
    assert.equal(events.rows[0].metadata.previousVerificationStatus, 'PENDING_VERIFICATION');
    assert.equal(events.rows[0].metadata.verificationStatus, 'VERIFIED');

    // Rejection is recorded the same way.
    const rejected = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.id}/verify`,
      )
      .set(auth(verifierTokenA))
      .send({ verificationStatus: 'REJECTED' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.verificationStatus, 'REJECTED');
    assert.equal(rejected.body.data.isValid, false);
  });

  it('forbids the certificate owner from verifying their own record', async (t) => {
    if (!ready(t)) return;

    // A workforce profile owned BY the owner-actor session: the actor is the
    // subject of the certificate even though they hold the verify permission.
    const ownerUserId = (await userForToken(ownerVerifyTokenA)).userId;
    const owned = await createWorkerProfileForUser({
      userId: ownerUserId,
      realm: realmA,
      crew: crewA,
      label: 'owned',
      memberOfCrew: true,
      createIdentity: false,
    });

    const created = await createCert(ownerVerifyTokenA, certBody(), owned.profileId);
    assert.equal(created.status, 201);

    const selfVerify = await request
      .post(
        `${API}/workforce/${owned.profileId}/certifications/${created.body.data.id}/verify`,
      )
      .set(auth(ownerVerifyTokenA))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(selfVerify.status, 403);
    assert.equal(
      selfVerify.body.error.code,
      'WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN',
    );

    // A different verifier may decide on it.
    const otherVerifier = await request
      .post(
        `${API}/workforce/${owned.profileId}/certifications/${created.body.data.id}/verify`,
      )
      .set(auth(verifierTokenA))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(otherVerifier.status, 200);
  });

  it('deactivates a certificate, keeps the row, and drops it from the active profile', async (t) => {
    if (!ready(t)) return;
    const created = (await createCert(managerTokenA, certBody())).body.data;

    const deactivated = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.id}/deactivate`,
      )
      .set(auth(managerTokenA))
      .send({ reason: 'Sertifikat dicabut penerbit.' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.expiryStatus, 'NOT_APPLICABLE');
    assert.equal(deactivated.body.data.isValid, false);

    const stillThere = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(readerTokenA));
    assert.equal(stillThere.status, 200, 'history survives deactivation');

    // An INACTIVE certificate can never be verified.
    const verifyInactive = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.id}/verify`,
      )
      .set(auth(verifierTokenA))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(verifyInactive.status, 409);
    assert.equal(
      verifyInactive.body.error.code,
      'WORKFORCE_CERTIFICATION_VERIFICATION_NOT_ALLOWED',
    );
  });

  it('never treats an expired certificate as valid or verifiable', async (t) => {
    if (!ready(t)) return;

    const expired = await createCert(
      managerTokenA,
      certBody({ issueDate: '2018-01-01T00:00:00.000Z', expiryDate: PAST_DATE }),
    );
    assert.equal(expired.status, 201);
    assert.equal(expired.body.data.status, 'EXPIRED');
    assert.equal(expired.body.data.expiryStatus, 'EXPIRED');
    assert.equal(expired.body.data.isExpired, true);
    assert.equal(expired.body.data.isValid, false);

    const verifyExpired = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${expired.body.data.id}/verify`,
      )
      .set(auth(verifierTokenA))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(verifyExpired.status, 409);
    assert.equal(
      verifyExpired.body.error.code,
      'WORKFORCE_CERTIFICATION_VERIFICATION_NOT_ALLOWED',
    );

    // `currentOnly` excludes it; the default list still shows the history.
    const current = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications?currentOnly=true`)
      .set(auth(readerTokenA));
    assert.equal(current.status, 200);
    assert.equal(
      current.body.data.some(
        (row: { id: string }) => row.id === expired.body.data.id,
      ),
      false,
    );

    const all = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications`)
      .set(auth(readerTokenA));
    assert.equal(
      all.body.data.some(
        (row: { id: string }) => row.id === expired.body.data.id,
      ),
      true,
    );
  });

  it('lists certificates approaching expiry inside the caller’s Client scope', async (t) => {
    if (!ready(t)) return;

    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const soonBody = certBody({ expiryDate: soon });
    const soonCert = await createCert(managerTokenA, soonBody);
    assert.equal(soonCert.status, 201);

    const response = await request
      .get(`${API}/workforce/certifications/expiring?days=30`)
      .set(auth(readerTokenA));
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.meta.days, 30);

    const ids = response.body.data.map(
      (item: { certification: { id: string } }) => item.certification.id,
    );
    assert.ok(ids.includes(soonCert.body.data.id));
    for (const item of response.body.data as Array<{
      certification: { isExpired: boolean; status: string };
      workforceProfile: { id: string; fullName: string };
      daysUntilExpiry: number;
    }>) {
      assert.equal(item.certification.isExpired, false);
      assert.equal(item.certification.status, 'ACTIVE');
      assert.ok(item.daysUntilExpiry >= 0 && item.daysUntilExpiry <= 30);
      assert.ok(item.workforceProfile.fullName.length > 0);
    }

    // A one-day window excludes a certificate that expires in five days.
    const narrow = await request
      .get(`${API}/workforce/certifications/expiring?days=1`)
      .set(auth(readerTokenA));
    assert.equal(narrow.status, 200);
    assert.equal(
      narrow.body.data.some(
        (item: { certification: { id: string } }) =>
          item.certification.id === soonCert.body.data.id,
      ),
      false,
    );

    const invalidDays = await request
      .get(`${API}/workforce/certifications/expiring?days=0`)
      .set(auth(readerTokenA));
    assert.equal(invalidDays.status, 400);
    assert.equal(invalidDays.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces Client isolation on reads, writes, the expiry watch and documents', async (t) => {
    if (!ready(t)) return;
    const created = (await createCert(managerTokenA, certBody())).body.data;

    // Client-B actor cannot read Client-A certificates.
    const crossRead = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications`)
      .set(auth(managerTokenB));
    assert.equal(crossRead.status, 403);
    assert.equal(crossRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossDetail = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(managerTokenB));
    assert.equal(crossDetail.status, 403);
    assert.equal(crossDetail.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossCreate = await createCert(managerTokenB, certBody());
    assert.equal(crossCreate.status, 403);
    assert.equal(crossCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossVerify = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.id}/verify`,
      )
      .set(auth(managerTokenB))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(crossVerify.status, 403);
    assert.equal(crossVerify.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A Client-B document can never be attached to a Client-A certificate, and
    // reading the document reference is itself Client-scoped.
    const crossDocument = await createCert(
      managerTokenA,
      certBody({ documentId: documentIdB }),
    );
    assert.equal(crossDocument.status, 409);
    assert.equal(
      crossDocument.body.error.code,
      'WORKFORCE_CERTIFICATION_DOCUMENT_MISMATCH',
    );

    // The expiry watch stays inside the caller's own Client.
    const clientBExpiring = await request
      .get(`${API}/workforce/certifications/expiring?days=365`)
      .set(auth(managerTokenB));
    assert.equal(clientBExpiring.status, 200);
    for (const item of clientBExpiring.body.data as Array<{
      certification: { id: string };
    }>) {
      assert.notEqual(item.certification.id, created.id);
    }
  });

  it('binds each operation to its dedicated permission, never a broader one', async (t) => {
    if (!ready(t)) return;
    const created = (await createCert(managerTokenA, certBody())).body.data;

    // No permission at all.
    const plainRead = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications`)
      .set(auth(plainTokenA));
    assert.equal(plainRead.status, 403);
    assert.equal(plainRead.body.error.code, 'PERMISSION_DENIED');

    const plainCreate = await createCert(plainTokenA, certBody());
    assert.equal(plainCreate.status, 403);
    assert.equal(plainCreate.body.error.code, 'PERMISSION_DENIED');

    // A read-only actor cannot mutate or verify...
    const readOnlyCreate = await createCert(readerTokenA, certBody());
    assert.equal(readOnlyCreate.status, 403);

    const readOnlyPatch = await request
      .patch(`${API}/workforce/${workerProfileIdA}/certifications/${created.id}`)
      .set(auth(readerTokenA))
      .send({ certificateName: 'Nope' });
    assert.equal(readOnlyPatch.status, 403);

    const readOnlyDeactivate = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.id}/deactivate`,
      )
      .set(auth(readerTokenA))
      .send({});
    assert.equal(readOnlyDeactivate.status, 403);

    // ...and a verifier cannot manage.
    const verifierCreate = await createCert(verifierTokenA, certBody());
    assert.equal(verifierCreate.status, 403);
    assert.equal(verifierCreate.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns a controlled 404 for unknown profiles and certificates', async (t) => {
    if (!ready(t)) return;
    const unknownProfile = randomUUID();
    const listUnknown = await request
      .get(`${API}/workforce/${unknownProfile}/certifications`)
      .set(auth(readerTokenA));
    assert.equal(listUnknown.status, 404);
    assert.equal(listUnknown.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');

    const unknownCert = await request
      .get(`${API}/workforce/${workerProfileIdA}/certifications/${randomUUID()}`)
      .set(auth(readerTokenA));
    assert.equal(unknownCert.status, 404);
    assert.equal(unknownCert.body.error.code, 'WORKFORCE_CERTIFICATION_NOT_FOUND');
  });
});

describe('CR-HM-WORKER-COMPETENCY-01 PART 02 — Mobile worker profile integration', () => {
  it('projects the worker’s individual certificates without exposing storage keys', async (t) => {
    if (!ready(t)) return;

    const withDoc = certBody({
      certificateNumber: `CERT-MOB-${suffix()}`,
      skillId: skillIdA,
      documentId: documentIdA,
    });
    const created = await createCert(managerTokenA, withDoc);
    assert.equal(created.status, 201);

    // Verified + unexpired → usable.
    const verified = await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${created.body.data.id}/verify`,
      )
      .set(auth(verifierTokenA))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(verified.status, 200);

    const workerSession = await sessionService.createSessionForUser(
      workerUserIdA,
    );
    const profile = await request
      .get(`${API}/handyman/field/me/profile`)
      .set(auth(workerSession.sessionToken));
    assert.equal(profile.status, 200);
    assert.equal(profile.body.success, true);

    const certifications = profile.body.data.profile.certificationsAndExpiry;
    assert.equal(certifications.individualCertificateNumberModeled, true);
    assert.ok(Array.isArray(certifications.individualCertifications));

    const projected = certifications.individualCertifications.find(
      (item: { id: string }) => item.id === created.body.data.id,
    );
    assert.ok(projected, 'the registered certificate must appear');
    assert.equal(projected.certificateNumber, withDoc.certificateNumber);
    assert.equal(projected.certificateName, withDoc.certificateName);
    assert.equal(projected.issuingAuthority, withDoc.issuingAuthority);
    assert.equal(projected.status, 'ACTIVE');
    assert.equal(projected.verificationStatus, 'VERIFIED');
    assert.equal(projected.expiryStatus, 'VALID');
    assert.equal(projected.isExpired, false);
    assert.equal(projected.isValid, true);
    assert.equal(projected.issueDate, ISSUE_DATE);
    assert.equal(projected.expiryDate, FUTURE_DATE);
    assert.equal(projected.skillId, skillIdA);
    assert.ok(projected.skillCode);
    assert.equal(projected.documentAvailable, true);
    assert.equal(projected.documentId, documentIdA);

    // No raw storage reference is leaked to the Mobile contract.
    assert.equal('fileReference' in projected, false);
    assert.equal(
      JSON.stringify(certifications).includes('certifications/http/'),
      false,
    );

    // The three existing facts keep their meaning and shape.
    assert.ok(Array.isArray(certifications.skillValidityWindows));
    assert.ok(
      Array.isArray(certifications.providerLicensesAndCertifications),
    );

    // INACTIVE certificates are withdrawn from the worker's own profile.
    const toDeactivate = (await createCert(managerTokenA, certBody())).body.data;
    await request
      .post(
        `${API}/workforce/${workerProfileIdA}/certifications/${toDeactivate.id}/deactivate`,
      )
      .set(auth(managerTokenA))
      .send({});
    const afterDeactivate = await request
      .get(`${API}/handyman/field/me/profile`)
      .set(auth(workerSession.sessionToken));
    assert.equal(
      afterDeactivate.body.data.profile.certificationsAndExpiry.individualCertifications.some(
        (item: { id: string }) => item.id === toDeactivate.id,
      ),
      false,
    );
  });

  it('returns a successful profile with an empty certificate list for an uncredentialed worker', async (t) => {
    if (!ready(t)) return;

    const bare = await createWorker(realmA, crewA, 'bare', {
      memberOfCrew: true,
    });
    const session = await sessionService.createSessionForUser(bare.userId);
    const response = await request
      .get(`${API}/handyman/field/me/profile`)
      .set(auth(session.sessionToken));
    assert.equal(response.status, 200);
    const certifications =
      response.body.data.profile.certificationsAndExpiry;
    assert.deepEqual(certifications.individualCertifications, []);
    assert.equal(certifications.individualCertificateNumberModeled, true);
  });

  it('exposes the same projection on the scoped worker-profile endpoint', async (t) => {
    if (!ready(t)) return;

    const opsSession = await sessionService.createSessionForUser(
      (await userForToken(managerTokenA)).userId,
    );
    const response = await request
      .get(`${API}/handyman/field/workers/${workerContextIdA}/profile`)
      .set(auth(opsSession.sessionToken));
    // The ops actor has no `tenant_company.read`, so it must be forbidden
    // rather than silently allowed: the projection is not a permission bypass.
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'HANDYMAN_WORKER_PROFILE_FORBIDDEN');

    // The worker can read their own scoped profile and sees the certificates.
    const workerSession = await sessionService.createSessionForUser(
      workerUserIdA,
    );
    const own = await request
      .get(`${API}/handyman/field/workers/${workerContextIdA}/profile`)
      .set(auth(workerSession.sessionToken));
    assert.equal(own.status, 200);
    assert.ok(
      Array.isArray(
        own.body.data.profile.certificationsAndExpiry.individualCertifications,
      ),
    );
  });

  it('returns a controlled domain response (never 500) for a PLATFORM_ADMIN without a worker context', async (t) => {
    if (!ready(t)) return;

    const owner = await createAdminUser();
    const response = await request
      .get(`${API}/handyman/field/me/profile`)
      .set(auth(owner.token));
    assert.equal(response.status, 404);
    assert.equal(response.body.success, false);
    assert.equal(
      response.body.error.code,
      'HANDYMAN_WORKER_PROFILE_NOT_FOUND',
    );

    // And a scoped read of a real worker context is a controlled 403, not a 500.
    const scoped = await request
      .get(`${API}/handyman/field/workers/${workerContextIdA}/profile`)
      .set(auth(owner.token));
    assert.equal(scoped.status, 403);
    assert.equal(scoped.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
