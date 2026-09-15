import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-CONTRACT-01 PART 05 — Finding, Rework & Verification contract.
 *
 * Verifies the backend-authoritative Finding/Rework/Verification surface is
 * published in OpenAPI and that the runtime enforces the documented RBAC,
 * Building isolation, and deterministic transition validation. Workflow
 * authority is never inferred — it comes from /findings/:id/available-actions
 * and the BE-09 action authority.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const DB_PORT = 55442;
const DATA_DIR = '/tmp/asentra-mob-finding-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE findings, finding_assignments, finding_rework_cycles, reviews,
       operational_events, finding_classifications, finding_severities,
       user_credentials, users, roles, permissions, clients, properties,
       buildings, user_building_assignments CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function createHierarchy(
  assignUserId: string | null,
): Promise<{ clientId: string; buildingId: string }> {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Finding Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Finding Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Finding Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(
      assignUserId,
      { buildingId: building.id },
      assignUserId,
    );
  }
  return { clientId: client.id, buildingId: building.id };
}

function loadSpec(): Record<string, any> {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
}

// --------------------------------------------------------------------------
// Layer 1 — OpenAPI contract (no database)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 05 — Finding OpenAPI contract', () => {
  const spec = loadSpec();

  const PATHS: Array<[string, string]> = [
    ['/buildings/{buildingId}/findings', 'get'],
    ['/buildings/{buildingId}/findings', 'post'],
    ['/findings/{findingId}', 'get'],
    ['/findings/{findingId}', 'patch'],
    ['/findings/{findingId}/state', 'patch'],
    ['/findings/{findingId}/source', 'get'],
    ['/findings/{findingId}/source', 'patch'],
    ['/findings/{findingId}/cancel', 'post'],
    ['/findings/{findingId}/rework', 'get'],
    ['/findings/{findingId}/rework', 'post'],
    ['/findings/{findingId}/rework', 'patch'],
    ['/findings/{findingId}/reject', 'post'],
    ['/findings/{findingId}/resubmit', 'post'],
    ['/findings/{findingId}/reviews', 'get'],
    ['/findings/{findingId}/reviews', 'post'],
    ['/findings/{findingId}/reviews/current', 'get'],
    ['/findings/{findingId}/verification', 'get'],
    ['/findings/{findingId}/verification', 'post'],
    ['/findings/{findingId}/assignments', 'get'],
    ['/findings/{findingId}/assignments', 'post'],
    ['/findings/{findingId}/assignments/current', 'get'],
    ['/findings/{findingId}/history', 'get'],
    ['/findings/{findingId}/closure', 'get'],
    ['/findings/{findingId}/close', 'post'],
  ];

  it('publishes the Finding/Rework/Verification paths', () => {
    for (const [path, method] of PATHS) {
      const op = spec.paths?.[path]?.[method];
      assert.ok(op, `${method.toUpperCase()} ${path} must be documented`);
      assert.ok(
        Array.isArray(op.security) &&
          op.security.some((s: Record<string, unknown>) => 'bearerAuth' in s),
        `${method.toUpperCase()} ${path} must require bearerAuth`,
      );
    }
  });

  it('publishes the Finding schema with authoritative status', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.Finding, 'Finding required');
    assert.ok(schemas.Finding.required.includes('status'));
    assert.ok(schemas.Finding.required.includes('buildingId'));
    assert.ok(schemas.Finding.required.includes('sourceType'));
    assert.ok(schemas.Finding.required.includes('sourceId'));

    assert.deepEqual(schemas.FindingStatus.enum, [
      'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REJECTED',
      'REWORK_REQUIRED', 'RESUBMITTED', 'VERIFIED', 'CLOSED', 'CANCELLED',
    ]);
    assert.deepEqual(schemas.FindingSourceType.enum, [
      'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
    ]);
  });

  it('publishes Rework / Review / Verification / Assignment schemas', () => {
    const schemas = spec.components.schemas;

    assert.ok(schemas.FindingRework, 'FindingRework required');
    assert.ok(schemas.FindingReworkContext, 'FindingReworkContext required');
    assert.deepEqual(schemas.FindingReworkStatus.enum, ['REQUESTED', 'RESUBMITTED']);

    assert.ok(schemas.FindingReview, 'FindingReview required');
    assert.ok(schemas.FindingVerificationState, 'FindingVerificationState required');
    assert.deepEqual(schemas.FindingReviewStatus.enum, ['PENDING', 'COMPLETED']);
    assert.deepEqual(schemas.ReviewDecision.enum, ['APPROVED', 'REJECTED', 'REWORK_REQUIRED']);

    assert.ok(schemas.FindingAssignment, 'FindingAssignment required');
    assert.deepEqual(schemas.FindingAssigneeType.enum, [
      'WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE',
    ]);

    assert.ok(schemas.FindingHistoryEvent, 'FindingHistoryEvent required');
    assert.ok(schemas.FindingClosureInfo, 'FindingClosureInfo required');
    assert.ok(schemas.FindingSourceState, 'FindingSourceState required');
  });

  it('keeps available-actions + mobile verification as the action authority', () => {
    assert.ok(spec.paths['/findings/{findingId}/available-actions'], 'available-actions documented');
    assert.ok(spec.paths['/mobile/verification/{targetType}/{targetId}'], 'mobile verification documented');
  });
});

// --------------------------------------------------------------------------
// Layer 2 — runtime read/mutation + isolation + RBAC (embedded PostgreSQL)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 05 — Finding runtime contract', () => {
  it('creates and reads a finding (status OPEN, source null)', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);

    const create = await api()
      .post(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, findingNumber: 'FN-0001', title: 'Leaking pipe' });
    assert.equal(create.status, 201);
    assert.equal(create.body.data.status, 'OPEN');
    assert.equal(create.body.data.sourceType, null);
    assert.equal(create.body.data.sourceId, null);
    const findingId = create.body.data.id;

    const detail = await api()
      .get(`${API_PREFIX}/findings/${findingId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.findingNumber, 'FN-0001');

    const list = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((f: any) => f.id === findingId));
  });

  it('returns authoritative available-actions and state', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const create = await api()
      .post(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, findingNumber: 'FN-0002', title: 'Loose cable' });
    const findingId = create.body.data.id;

    const actions = await api()
      .get(`${API_PREFIX}/findings/${findingId}/available-actions`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(actions.status, 200);
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.findingId, findingId);

    const state = await api()
      .get(`${API_PREFIX}/findings/${findingId}/state`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(state.status, 200);
    assert.equal(state.body.data.state, 'OPEN');
  });

  it('returns empty rework/reviews/verification/assignments/history for a fresh finding', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const create = await api()
      .post(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, findingNumber: 'FN-0003', title: 'Dirty filter' });
    const findingId = create.body.data.id;

    const rework = await api()
      .get(`${API_PREFIX}/findings/${findingId}/rework`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(rework.status, 200);
    assert.equal(rework.body.data.current, null);
    assert.deepEqual(rework.body.data.cycles, []);

    const reviews = await api()
      .get(`${API_PREFIX}/findings/${findingId}/reviews`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(reviews.status, 200);
    assert.deepEqual(reviews.body.data, []);

    const verification = await api()
      .get(`${API_PREFIX}/findings/${findingId}/verification`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(verification.status, 200);
    assert.equal(verification.body.data.findingId, findingId);

    const assignments = await api()
      .get(`${API_PREFIX}/findings/${findingId}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(assignments.status, 200);
    assert.deepEqual(assignments.body.data, []);

    const history = await api()
      .get(`${API_PREFIX}/findings/${findingId}/history`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body.data));

    const closure = await api()
      .get(`${API_PREFIX}/findings/${findingId}/closure`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(closure.status, 200);
    assert.equal(closure.body.data.findingId, findingId);
  });

  it('rejects an invalid state transition (403 FINDING_ACTION_NOT_ALLOWED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const create = await api()
      .post(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, findingNumber: 'FN-0004', title: 'Invalid transition' });
    const findingId = create.body.data.id;

    // OPEN → VERIFIED is not a valid transition (no action maps to it) — the
    // BE-09 action authority rejects it deterministically.
    const transition = await api()
      .patch(`${API_PREFIX}/findings/${findingId}/state`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ state: 'VERIFIED' });
    assert.equal(transition.status, 403);
    assert.equal(transition.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('denies finding reads without permission (403 PERMISSION_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const create = await api()
      .post(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, findingNumber: 'FN-0005', title: 'RBAC' });
    const findingId = create.body.data.id;

    const token = await createPlainSession();
    const response = await api()
      .get(`${API_PREFIX}/findings/${findingId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies cross-Building finding access (403 BUILDING_ACCESS_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const create = await api()
      .post(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, findingNumber: 'FN-0006', title: 'Isolation' });
    const findingId = create.body.data.id;

    // Caller holds finding.read but NO assignment to the Building.
    const token = await createSessionWithPermissions([
      { code: 'finding.read', name: 'Read Findings' },
    ]);
    const response = await api()
      .get(`${API_PREFIX}/findings/${findingId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies the cross-Building list route (403 BUILDING_ACCESS_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const token = await createSessionWithPermissions([
      { code: 'finding.read', name: 'Read Findings' },
    ]);
    const response = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/findings`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
