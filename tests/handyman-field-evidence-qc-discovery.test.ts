import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  locationChain,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { createGuardedQcSupervisor } from './helpers/handyman-guarded-bast';
import { api } from './helpers/http';

/**
 * CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01B-BE — ONE focused PostgreSQL
 * suite for appointed QC evidence read & discovery:
 *
 *   1. appointed QC Supervisor lists ONLY confirmed (VERIFIED) evidence
 *      for the exact scope — safe fields, bounded pagination, no bytes,
 *      no storage paths, historical unbound evidence preserved;
 *   2. appointed QC Supervisor reads verified metadata + content with a
 *      byte/SHA-256 checksum match;
 *   3. incomplete upload intent stays undiscoverable/unreadable to QC;
 *   4. `handyman.qc.manage` WITHOUT the BE-03F appointment → 403;
 *   5. appointed QC of another scope (same Building/Client) → 403;
 *   6. cross-Building/Client listing/read → 403, guessed IDs never bypass;
 *   7. unknown scope listing → bounded 404, missing auth → 401;
 *   8. existing Operations reader access remains PASS;
 *   9. Crew Leader read access remains PASS.
 */

const DIR = '/tmp/hm-evidence-qc-discovery-pg';
const STORAGE = '/tmp/hm-evidence-qc-discovery-storage';
const PORT = 55792;

const VALID_PNG = Buffer.from(
  [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ],
);
const PNG_SHA = createHash('sha256').update(VALID_PNG).digest('hex');
const AUTH = (token: string) => ({ Authorization: `Bearer ${token}` });
const id = () => randomUUID();

let db: EmbeddedTestDatabase;
let pool: Pool;
let admin: string;
let storageDir = '';

async function loginUser(userId: string, email: string): Promise<string> {
  const password = `Pass${id().slice(0, 8)}!1`;
  await credentialService.createInitialCredential({ userId, password });
  const login = await api().post('/api/v1/auth/login').send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}

/** Grant seeded permission codes to a fresh throwaway role. */
async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `QCRD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'QC evidence read test role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService
      .createPermission({
        code: permissionCode,
        name: `Scoped ${permissionCode}`,
      })
      .catch(async () => {
        const { permissionRepository } = await import(
          '../src/modules/permissions'
        );
        return permissionRepository.findByCode(permissionCode);
      });
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function setupScopeWithCrew() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: f.scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    admin,
  );
  const leadToken = await loginUser(crew.leadUser.id, crew.leadUser.email);
  return {
    ...f,
    crew,
    assignment,
    leadUserId: crew.leadUser.id,
    leadToken,
  };
}

async function seedSession(f: {
  scope: { clientId: string; id: string };
  assignment: { id: string };
  crew: { workerContext: { id: string } };
  leadUserId: string;
}): Promise<string> {
  const sessionId = id();
  await pool.query(
    `INSERT INTO handyman_work_sessions
       (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
        lead_user_id, status, started_work_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'IN_PROGRESS', NOW())`,
    [
      sessionId,
      f.scope.clientId,
      f.scope.id,
      f.assignment.id,
      f.crew.workerContext.id,
      f.leadUserId,
    ],
  );
  return sessionId;
}

function presignBody(
  executionScopeId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    executionScopeId,
    purpose: 'BEFORE_AFTER_WORK',
    originalFileName: 'execution.png',
    mimeType: 'image/png',
    declaredByteSize: VALID_PNG.byteLength,
    idempotencyKey: id(),
    ...extra,
  };
}

const presign = (token: string, body: Record<string, unknown>) =>
  api().post('/api/v1/handyman/field/evidence/presign').set(AUTH(token)).send(body);

const putBytes = (token: string, evidenceId: string) =>
  api()
    .put(`/api/v1/handyman/field/evidence/${evidenceId}/bytes`)
    .set(AUTH(token))
    .set('Content-Type', 'image/png')
    .send(VALID_PNG);

const confirmUpload = (token: string, evidenceId: string) =>
  api()
    .post(`/api/v1/handyman/field/evidence/${evidenceId}/confirm`)
    .set(AUTH(token))
    .send({});

/** Full Flow A: presign → bytes → confirm → VERIFIED evidence id. */
async function uploadVerified(
  token: string,
  executionScopeId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const presigned = await presign(
    token,
    presignBody(executionScopeId, extra),
  );
  assert.equal(presigned.status, 201, JSON.stringify(presigned.body));
  const evidenceId = presigned.body.data.evidence.id as string;
  const put = await putBytes(token, evidenceId);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const confirmed = await confirmUpload(token, evidenceId);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.evidence.uploadStatus, 'VERIFIED');
  return evidenceId;
}

const listEvidence = (
  token: string | null,
  executionScopeId: string,
  query: Record<string, string> = {},
) => {
  const req = api().get(
    `/api/v1/handyman/field/execution-scopes/${executionScopeId}/evidence`,
  );
  if (token) req.set(AUTH(token));
  return req.query(query);
};

const getMetadata = (token: string, evidenceId: string) =>
  api().get(`/api/v1/handyman/field/evidence/${evidenceId}`).set(AUTH(token));

const getContent = (token: string, evidenceId: string) =>
  api()
    .get(`/api/v1/handyman/field/evidence/${evidenceId}/content`)
    .set(AUTH(token))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

function errorCode(res: { body: unknown }): string {
  return (res.body as { error?: { code?: string } }).error?.code ?? '';
}

type Scenario = Awaited<ReturnType<typeof buildScenario>>;
let cached: Scenario | null = null;

async function buildScenario() {
  const f = await setupScopeWithCrew();
  const sessionId = await seedSession(f);

  // Evidence surface on the appointed scope: one session-bound VERIFIED,
  // one historical unbound VERIFIED, one incomplete (staged) intent.
  const evidenceBound = await uploadVerified(f.leadToken, f.scope.id, {
    workSessionId: sessionId,
  });
  const evidenceUnbound = await uploadVerified(f.leadToken, f.scope.id);
  const pendingPresign = await presign(
    f.leadToken,
    presignBody(f.scope.id),
  );
  assert.equal(pendingPresign.status, 201, JSON.stringify(pendingPresign.body));
  const evidencePending = pendingPresign.body.data.evidence.id as string;

  // Appointed QC Supervisor: handyman.qc.manage + Building assignment +
  // BE-03F reporting line to the scope's current Crew Lead.
  const supervisor = await createGuardedQcSupervisor({
    realm: f.realm,
    crew: f.crew,
  });
  const supUser = await userService.getUserById(supervisor.id);
  const supervisorToken = await loginUser(supervisor.id, supUser.email);

  // Same Building/Client, different execution scope + its own crew/evidence.
  // A fresh location chain: a space can only be assigned to one tenant.
  const f2chain = await locationChain(f.realm);
  const f2 = await scopeFixture(f.realm, f2chain);
  const crew2 = await crewFixture(f.realm);
  await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: f2.scope.id,
      providerContextId: crew2.providerContext.id,
      crewId: crew2.crew.id,
    },
    admin,
  );
  const lead2Token = await loginUser(crew2.leadUser.id, crew2.leadUser.email);
  const otherScopeEvidence = await uploadVerified(lead2Token, f2.scope.id);

  // Cross-Building/Client fixture with its own verified evidence.
  const cross = await setupScopeWithCrew();
  const crossEvidence = await uploadVerified(cross.leadToken, cross.scope.id);

  // handyman.qc.manage + same Building but NO appointment/reporting line.
  const unappointedUser = await userService.createUser({
    email: `unappointed-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Unappointed QC',
  });
  await buildingAssignmentService.createAssignment(unappointedUser.id, {
    buildingId: f.realm.building.id,
  });
  await grant(unappointedUser.id, ['handyman.qc.manage']);
  const unappointedToken = await loginUser(
    unappointedUser.id,
    unappointedUser.email,
  );

  // Existing Operations reader (tenant_company.read + Building).
  const opsUser = await userService.createUser({
    email: `ops-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Operations Reader',
  });
  await buildingAssignmentService.createAssignment(opsUser.id, {
    buildingId: f.realm.building.id,
  });
  await grant(opsUser.id, ['tenant_company.read']);
  const opsToken = await loginUser(opsUser.id, opsUser.email);

  return {
    f,
    f2,
    cross,
    sessionId,
    evidenceBound,
    evidenceUnbound,
    evidencePending,
    otherScopeEvidence,
    crossEvidence,
    supervisorToken,
    unappointedToken,
    opsToken,
  };
}

async function scenario(): Promise<Scenario> {
  if (!cached) cached = await buildScenario();
  return cached;
}

before(async () => {
  storageDir = STORAGE;
  process.env.EVIDENCE_STORAGE_DIR = storageDir;
  resetAppConfigCache();
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({
    host: '127.0.0.1',
    port: PORT,
    name: 'asentra_test',
    user: 'postgres',
    password: '',
    ssl: false,
  });
  await migrateUp(pool);
  const root = await createAdminUser();
  admin = root.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline, 'GENERAL_HANDYMAN discipline must exist');
  initHandymanFixtures({
    adminUserId: admin,
    disciplineId: discipline.id,
    query: (text, params = []) => pool.query(text, params),
  });
});

after(async () => {
  if (pool) await closePool(pool);
  if (db) await db.stop();
  await rm(DIR, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.EVIDENCE_STORAGE_DIR;
  resetAppConfigCache();
});

describe('CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01B-BE: appointed QC evidence read & discovery', () => {
  it('appointed QC Supervisor lists only confirmed scope evidence with safe fields and bounded pagination', async () => {
    const s = await scenario();
    const res = await listEvidence(s.supervisorToken, s.f.scope.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const items = res.body.data.evidence as Array<Record<string, unknown>>;
    assert.equal(items.length, 2, 'VERIFIED evidence only');
    assert.equal(res.body.meta.total, 2);
    assert.equal(res.body.meta.page, 1);
    assert.equal(res.body.meta.pageSize, 50, 'default bound');
    const ids = items.map((i) => i.evidenceId);
    assert.ok(ids.includes(s.evidenceBound));
    assert.ok(ids.includes(s.evidenceUnbound));
    assert.ok(
      !ids.includes(s.evidencePending),
      'incomplete upload intent must not be discoverable',
    );

    const bound = items.find((i) => i.evidenceId === s.evidenceBound)!;
    assert.equal(bound.workSessionId, s.sessionId);
    assert.equal(bound.uploadStatus, 'VERIFIED');
    assert.equal(bound.mimeType, 'image/png');
    assert.equal(bound.sha256Checksum, PNG_SHA);
    assert.equal(bound.uploadedByUserId, s.f.leadUserId);
    assert.ok(typeof bound.createdAt === 'string' && bound.createdAt);

    const unbound = items.find((i) => i.evidenceId === s.evidenceUnbound)!;
    assert.equal(
      unbound.workSessionId,
      null,
      'historical unbound evidence stays discoverable',
    );

    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('storageKey'), 'no storage paths');
    assert.ok(!raw.includes('/tmp/'), 'no filesystem paths');
    assert.ok(!raw.includes('downloadPath'), 'no download paths');

    const paged = await listEvidence(s.supervisorToken, s.f.scope.id, {
      pageSize: '1',
    });
    assert.equal(paged.status, 200, JSON.stringify(paged.body));
    assert.equal((paged.body.data.evidence as unknown[]).length, 1);
    assert.equal(paged.body.meta.total, 2, 'total survives paging');
    assert.equal(paged.body.meta.pageSize, 1);

    const badPage = await listEvidence(s.supervisorToken, s.f.scope.id, {
      pageSize: '0',
    });
    assert.equal(badPage.status, 400, JSON.stringify(badPage.body));
    assert.equal(errorCode(badPage), 'VALIDATION_ERROR');
  });

  it('appointed QC Supervisor reads verified metadata and content bytes with checksum match', async () => {
    const s = await scenario();

    const meta = await getMetadata(s.supervisorToken, s.evidenceBound);
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    assert.equal(meta.body.data.evidence.id, s.evidenceBound);
    assert.equal(meta.body.data.evidence.uploadStatus, 'VERIFIED');
    assert.equal(meta.body.data.evidence.workSessionId, s.sessionId);

    const content = await getContent(s.supervisorToken, s.evidenceBound);
    assert.equal(content.status, 200, JSON.stringify(content.body));
    const bytes = content.body as Buffer;
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.byteLength, VALID_PNG.byteLength);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      PNG_SHA,
      'byte/SHA retrieval must match',
    );
    assert.equal(content.headers['x-content-sha256'], PNG_SHA);
  });

  it('incomplete upload intent stays unreadable to QC (403 metadata/content)', async () => {
    const s = await scenario();
    const meta = await getMetadata(s.supervisorToken, s.evidencePending);
    assert.equal(meta.status, 403, JSON.stringify(meta.body));
    assert.equal(errorCode(meta), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');
    const content = await getContent(s.supervisorToken, s.evidencePending);
    assert.equal(content.status, 403, JSON.stringify(content.body));
  });

  it('handyman.qc.manage without the BE-03F appointment grants nothing (403 listing/read)', async () => {
    const s = await scenario();
    const listing = await listEvidence(s.unappointedToken, s.f.scope.id);
    assert.equal(listing.status, 403, JSON.stringify(listing.body));
    assert.equal(errorCode(listing), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');

    const meta = await getMetadata(s.unappointedToken, s.evidenceBound);
    assert.equal(meta.status, 403, JSON.stringify(meta.body));
    assert.equal(errorCode(meta), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');

    const content = await getContent(s.unappointedToken, s.evidenceBound);
    assert.equal(content.status, 403, JSON.stringify(content.body));
  });

  it('appointed QC Supervisor cannot read/list another scope of the same Building/Client', async () => {
    const s = await scenario();
    const listing = await listEvidence(s.supervisorToken, s.f2.scope.id);
    assert.equal(listing.status, 403, JSON.stringify(listing.body));
    assert.equal(errorCode(listing), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');

    const meta = await getMetadata(s.supervisorToken, s.otherScopeEvidence);
    assert.equal(meta.status, 403, JSON.stringify(meta.body));
    assert.equal(errorCode(meta), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');
  });

  it('cross-Building/Client listing and evidence reads are rejected; guessed IDs never bypass', async () => {
    const s = await scenario();

    const listing = await listEvidence(
      s.supervisorToken,
      s.cross.scope.id,
    );
    assert.equal(listing.status, 403, JSON.stringify(listing.body));
    assert.equal(errorCode(listing), 'BUILDING_ACCESS_DENIED');

    const meta = await getMetadata(s.supervisorToken, s.crossEvidence);
    assert.equal(meta.status, 403, JSON.stringify(meta.body));
    assert.equal(errorCode(meta), 'BUILDING_ACCESS_DENIED');

    const content = await getContent(s.supervisorToken, s.crossEvidence);
    assert.equal(content.status, 403, JSON.stringify(content.body));

    // Guessed/nonexistent evidence id is bounded 404 — never a bypass.
    const missing = await getMetadata(s.supervisorToken, id());
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(errorCode(missing), 'HANDYMAN_EVIDENCE_UPLOAD_NOT_FOUND');
  });

  it('unknown execution scope listing is bounded 404 and missing auth is 401', async () => {
    const s = await scenario();
    const unknown = await listEvidence(s.supervisorToken, id());
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(errorCode(unknown), 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');

    const unauth = await listEvidence(null, s.f.scope.id);
    assert.equal(unauth.status, 401, JSON.stringify(unauth.body));
    assert.equal(errorCode(unauth), 'AUTHENTICATION_REQUIRED');
  });

  it('existing Operations reader access remains PASS', async () => {
    const s = await scenario();
    const listing = await listEvidence(s.opsToken, s.f.scope.id);
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    const ids = (listing.body.data.evidence as Array<{ evidenceId: string }>)
      .map((i) => i.evidenceId);
    assert.ok(ids.includes(s.evidenceBound));

    const meta = await getMetadata(s.opsToken, s.evidenceBound);
    assert.equal(meta.status, 200, JSON.stringify(meta.body));

    const content = await getContent(s.opsToken, s.evidenceBound);
    assert.equal(content.status, 200, JSON.stringify(content.body));
    assert.equal(
      createHash('sha256').update(content.body as Buffer).digest('hex'),
      PNG_SHA,
    );
  });

  it('Crew Leader read access remains PASS', async () => {
    const s = await scenario();
    const listing = await listEvidence(s.f.leadToken, s.f.scope.id);
    assert.equal(listing.status, 200, JSON.stringify(listing.body));

    const meta = await getMetadata(s.f.leadToken, s.evidenceBound);
    assert.equal(meta.status, 200, JSON.stringify(meta.body));

    const content = await getContent(s.f.leadToken, s.evidenceBound);
    assert.equal(content.status, 200, JSON.stringify(content.body));
  });
});
