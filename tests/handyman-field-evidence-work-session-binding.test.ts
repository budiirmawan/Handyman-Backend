import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { baseFixture, crewFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { api } from './helpers/http';

/**
 * CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — ONE focused PostgreSQL
 * suite for the authoritative Work Session photo binding contract:
 *
 *   1. valid execution-photo binding across presign → bytes → confirm,
 *      with idempotent replay, checksum/identity preservation, immutable
 *      stored linkage and metadata exposure;
 *   2. wrong Leader session reference rejected;
 *   3. wrong scope session reference rejected;
 *   4. fabricated + stale (CHECKED_OUT) session references rejected;
 *   5. stale upload intent cannot finalize after the session closes;
 *   6. existing non-session evidence compatibility (execution photo,
 *      inspection evidence, multipart upload and historical unbound
 *      rows keep working with workSessionId = null).
 */

const DIR = '/tmp/hm-evidence-ws-binding-pg';
const STORAGE = '/tmp/hm-evidence-ws-binding-storage';
const PORT = 55791;

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

type ScopeWithCrew = Awaited<ReturnType<typeof setupScopeWithCrew>>;

async function loginUser(userId: string, email: string): Promise<string> {
  const password = `Pass${id().slice(0, 8)}!1`;
  await credentialService.createInitialCredential({ userId, password });
  const login = await api().post('/api/v1/auth/login').send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
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

/** Seed a Work Session row directly (open or terminal), mirroring
 * `seedCheckedOutWorkSession` with a parametrized lifecycle state. */
async function seedSession(
  f: ScopeWithCrew,
  status: 'IN_PROGRESS' | 'CHECKED_OUT',
  leadUserId = f.leadUserId,
): Promise<string> {
  const sessionId = id();
  const terminal = status === 'CHECKED_OUT';
  await pool.query(
    `INSERT INTO handyman_work_sessions
       (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
        lead_user_id, status, started_work_at, completed_at, checked_out_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)`,
    [
      sessionId,
      f.scope.clientId,
      f.scope.id,
      f.assignment.id,
      f.crew.workerContext.id,
      leadUserId,
      status,
      terminal ? new Date() : null,
      terminal ? new Date() : null,
    ],
  );
  return sessionId;
}

function presignBody(f: ScopeWithCrew, extra: Record<string, unknown> = {}) {
  return {
    executionScopeId: f.scope.id,
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

const getMetadata = (token: string, evidenceId: string) =>
  api().get(`/api/v1/handyman/field/evidence/${evidenceId}`).set(AUTH(token));

function errorCode(res: { body: unknown }): string {
  return (res.body as { error?: { code?: string } }).error?.code ?? '';
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

describe('CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE: authoritative Work Session photo binding', () => {
  it('binds valid execution-photo evidence through presign → bytes → confirm and exposes the linkage', async () => {
    const f = await setupScopeWithCrew();
    const sessionId = await seedSession(f, 'IN_PROGRESS');
    const body = presignBody(f, { workSessionId: sessionId });

    const created = await presign(f.leadToken, body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const evidence = created.body.data.evidence;
    assert.equal(evidence.workSessionId, sessionId);
    assert.equal(evidence.executionScopeId, f.scope.id);
    const evidenceId = evidence.id as string;

    const staged = await putBytes(f.leadToken, evidenceId);
    assert.equal(staged.status, 200, JSON.stringify(staged.body));
    assert.equal(staged.body.data.evidence.workSessionId, sessionId);
    const stagedRow = (
      await pool.query(
        `SELECT work_session_id, upload_status FROM handyman_field_evidence_uploads WHERE id = $1`,
        [evidenceId],
      )
    ).rows[0];
    assert.equal(stagedRow.work_session_id, sessionId);
    assert.equal(stagedRow.upload_status, 'STAGED_BYTES');

    // Idempotent replay of the same key + session returns the SAME
    // bound intent (linkage, idempotency and identity preserved).
    const replay = await presign(f.leadToken, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.evidence.id, evidenceId);
    assert.equal(replay.body.data.evidence.workSessionId, sessionId);

    const confirmed = await confirmUpload(f.leadToken, evidenceId);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const verified = confirmed.body.data.evidence;
    assert.equal(verified.uploadStatus, 'VERIFIED');
    assert.equal(verified.workSessionId, sessionId);
    assert.equal(verified.sha256Checksum, PNG_SHA);
    assert.equal(verified.attachmentReference, `hm-ev://${evidenceId}`);

    // Existing scoped metadata response exposes the authoritative link.
    const meta = await getMetadata(f.leadToken, evidenceId);
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    assert.equal(meta.body.data.evidence.workSessionId, sessionId);
    assert.equal(meta.body.data.evidence.sha256Checksum, PNG_SHA);

    // The stored linkage is immutable once written.
    await assert.rejects(
      pool.query(
        `UPDATE handyman_field_evidence_uploads SET work_session_id = NULL WHERE id = $1`,
        [evidenceId],
      ),
      /immutable once stored/,
    );

    // Verified evidence stays replayable even after the session closes
    // (historical linkage is preserved, never re-litigated).
    await pool.query(
      `UPDATE handyman_work_sessions
          SET status = 'CHECKED_OUT', completed_at = NOW(),
              checked_out_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [sessionId],
    );
    const lateConfirm = await confirmUpload(f.leadToken, evidenceId);
    assert.equal(lateConfirm.status, 200, JSON.stringify(lateConfirm.body));
    assert.equal(lateConfirm.body.data.evidence.workSessionId, sessionId);
  });

  it('rejects a Work Session that is not led by the authenticated Crew Leader', async () => {
    const f = await setupScopeWithCrew();
    const otherLeader = await userService.createUser({
      email: `wrong-leader-${id().slice(0, 8)}@example.com`,
      displayName: 'Not The Crew Leader',
    });
    const sessionId = await seedSession(f, 'IN_PROGRESS', otherLeader.id);

    const res = await presign(
      f.leadToken,
      presignBody(f, { workSessionId: sessionId }),
    );
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(errorCode(res), 'HANDYMAN_WORK_SESSION_NOT_AUTHORIZED');
    const orphan = (
      await pool.query(
        `SELECT count(*)::int AS n FROM handyman_field_evidence_uploads
          WHERE execution_scope_id = $1 AND work_session_id IS NOT NULL`,
        [f.scope.id],
      )
    ).rows[0];
    assert.equal(orphan.n, 0, 'no evidence row may be stored on rejection');
  });

  it('rejects a Work Session from a different execution scope (cross-scope reference)', async () => {
    const f = await setupScopeWithCrew();
    const g = await setupScopeWithCrew();
    const foreignSessionId = await seedSession(g, 'IN_PROGRESS');

    const res = await presign(
      f.leadToken,
      presignBody(f, { workSessionId: foreignSessionId }),
    );
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(errorCode(res), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');
    assert.match(
      (res.body as { error: { message: string } }).error.message,
      /execution scope/,
    );
  });

  it('rejects fabricated and stale (CHECKED_OUT) session references', async () => {
    const f = await setupScopeWithCrew();

    const fabricated = await presign(
      f.leadToken,
      presignBody(f, { workSessionId: id() }),
    );
    assert.equal(fabricated.status, 404, JSON.stringify(fabricated.body));
    assert.equal(errorCode(fabricated), 'HANDYMAN_WORK_SESSION_NOT_FOUND');

    const staleSessionId = await seedSession(f, 'CHECKED_OUT');
    const stale = await presign(
      f.leadToken,
      presignBody(f, { workSessionId: staleSessionId }),
    );
    assert.equal(stale.status, 403, JSON.stringify(stale.body));
    assert.equal(errorCode(stale), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');
    assert.match(
      (stale.body as { error: { message: string } }).error.message,
      /CHECKED_OUT/,
    );
  });

  it('revalidates the session at finalization so a stale upload intent cannot bypass authorization', async () => {
    const f = await setupScopeWithCrew();
    const sessionId = await seedSession(f, 'IN_PROGRESS');

    const created = await presign(
      f.leadToken,
      presignBody(f, { workSessionId: sessionId }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const evidenceId = created.body.data.evidence.id as string;

    const staged = await putBytes(f.leadToken, evidenceId);
    assert.equal(staged.status, 200, JSON.stringify(staged.body));

    // The Crew Leader checks out between staging and finalization.
    await pool.query(
      `UPDATE handyman_work_sessions
          SET status = 'CHECKED_OUT', completed_at = NOW(),
              checked_out_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [sessionId],
    );

    const confirmed = await confirmUpload(f.leadToken, evidenceId);
    assert.equal(confirmed.status, 403, JSON.stringify(confirmed.body));
    assert.equal(errorCode(confirmed), 'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN');
    assert.match(
      (confirmed.body as { error: { message: string } }).error.message,
      /CHECKED_OUT/,
    );

    // The intent stays bounded: staged bytes, no attachment reference,
    // linkage intact — never silently finalized or re-bound.
    const row = (
      await pool.query(
        `SELECT upload_status, attachment_reference, work_session_id
           FROM handyman_field_evidence_uploads WHERE id = $1`,
        [evidenceId],
      )
    ).rows[0];
    assert.equal(row.upload_status, 'STAGED_BYTES');
    assert.equal(row.attachment_reference, null);
    assert.equal(row.work_session_id, sessionId);
  });

  it('keeps existing non-session evidence workflows compatible (unbound contract preserved)', async () => {
    const f = await setupScopeWithCrew();
    // A live session exists on the scope, yet submissions that do not
    // carry a workSessionId keep the pre-existing contract (the mobile
    // app and older clients may omit the binding).
    await seedSession(f, 'IN_PROGRESS');

    // Flow B: execution photo without workSessionId.
    const unbound = await presign(f.leadToken, presignBody(f));
    assert.equal(unbound.status, 201, JSON.stringify(unbound.body));
    assert.equal(unbound.body.data.evidence.workSessionId, null);

    // Inspection evidence without any session stays valid (req 9).
    const inspection = await presign(
      f.leadToken,
      presignBody(f, { purpose: 'INSPECTION_EVIDENCE' }),
    );
    assert.equal(inspection.status, 201, JSON.stringify(inspection.body));
    assert.equal(inspection.body.data.evidence.workSessionId, null);

    // Flow A: multipart direct upload without workSessionId.
    const multipart = await api()
      .post(`/api/v1/handyman/field/execution-scopes/${f.scope.id}/evidence/upload`)
      .set(AUTH(f.leadToken))
      .field('purpose', 'BEFORE_AFTER_WORK')
      .field('idempotencyKey', id())
      .attach('file', VALID_PNG, { filename: 'direct.png', contentType: 'image/png' });
    assert.equal(multipart.status, 201, JSON.stringify(multipart.body));
    assert.equal(multipart.body.data.evidence.uploadStatus, 'VERIFIED');
    assert.equal(multipart.body.data.evidence.workSessionId, null);

    // A historical unbound VERIFIED row stays readable with a null link
    // (never fabricated, always exposed as null in metadata).
    const historicalId = id();
    await pool.query(
      `INSERT INTO handyman_field_evidence_uploads
         (id, client_id, tenant_company_id, building_id, handyman_request_id,
          execution_scope_id, purpose, upload_status, original_file_name,
          mime_type, storage_key, declared_byte_size, verified_byte_size,
          sha256_checksum, attachment_reference, uploaded_by_user_id,
          uploaded_by_role, idempotency_key, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'BEFORE_AFTER_WORK', 'VERIFIED',
               'legacy.png', 'image/png', $7, $8, $8, $9, $10, $11,
               'PIC_PEKERJAAN', $12, NOW())`,
      [
        historicalId,
        f.scope.clientId,
        f.scope.tenantCompanyId,
        f.realm.building.id,
        f.scope.handymanRequestId,
        f.scope.id,
        `evidence/${historicalId}`,
        VALID_PNG.byteLength,
        PNG_SHA,
        `hm-ev://${historicalId}`,
        f.leadUserId,
        `hist-${historicalId}`,
      ],
    );
    const historical = await getMetadata(f.leadToken, historicalId);
    assert.equal(historical.status, 200, JSON.stringify(historical.body));
    assert.equal(historical.body.data.evidence.workSessionId, null);
    assert.equal(historical.body.data.evidence.uploadStatus, 'VERIFIED');
  });
});
