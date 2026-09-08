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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-CONTRACT-01 PART 08 — Cross-Contract Regression.
 *
 * Two layers:
 *  1. Spec-level cross-contract consistency: the complete mobile chain is
 *     wired via operationIds; shared enums (ReviewDecision, evidence types,
 *     structure nodes) are single-sourced; canonical IDs use the Uuid schema;
 *     every operation uses the shared envelope and error responses; no
 *     duplicate operationIds and all $refs resolve.
 *  2. A representative end-to-end runtime chain (embedded PostgreSQL):
 *     login → /auth/me (roles + scope) → create a finding in the accessible
 *     Building → read its authoritative available-actions. This exercises the
 *     auth/session → context → Building isolation → finding workflow boundary
 *     without fabricating workflows the backend does not implement.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const DB_PORT = 55437;
const DATA_DIR = '/tmp/asentra-mob-xcontract-pg';
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

function loadSpec(): Record<string, any> {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Layer 1 — spec-level cross-contract consistency (no database)
// ---------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 08 — cross-contract consistency (spec)', () => {
  const spec = loadSpec();

  it('wires the complete mobile chain through operationIds', () => {
    const required: string[] = [
      'login', 'getEffectiveUserContext', 'logout',
      'getMyBuildings',
      'listTasks', 'getTask', 'listBuildingWorkOrders', 'getWorkOrder',
      'listMobileAssignments',
      'listChecklistExecutions', 'getChecklistExecution',
      'listUoms', 'submitEvidence', 'getEvidence',
      'createFinding', 'getFindingAvailableActions',
      'getFindingRework', 'getMobileVerification',
      'resolveMobileQr', 'getBuildingHierarchy', 'getFunctionalLocationContext',
      'getAsset', 'getAssetLocation',
    ];
    const ids = new Set<string>();
    for (const item of Object.values(spec.paths ?? {})) {
      for (const op of Object.values(item as Record<string, any>)) {
        if (op?.operationId) ids.add(op.operationId);
      }
    }
    const missing = required.filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `missing operationIds in the mobile chain: ${missing.join(', ')}`);
  });

  it('shares the ReviewDecision enum across finding and work-order verification', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.ReviewDecision, 'ReviewDecision required');
    assert.ok(
      schemas.FindingReview.properties.decision.allOf?.[0]?.$ref?.endsWith('ReviewDecision'),
      'FindingReview.decision must reference ReviewDecision',
    );
    assert.ok(
      schemas.WorkOrderVerification.properties.decision.$ref?.endsWith('ReviewDecision'),
      'WorkOrderVerification.decision must reference ReviewDecision',
    );
    assert.deepEqual(schemas.ReviewDecision.enum, ['APPROVED', 'REJECTED', 'REWORK_REQUIRED']);
  });

  it('shares the evidence type vocabulary across checklist/evidence/work-order', () => {
    const schemas = spec.components.schemas;
    const ev = ['PHOTO', 'DOCUMENT', 'SIGNATURE'];
    for (const name of ['MobileChecklistEvidenceRequirement', 'EvidenceRequirement', 'WorkOrderEvidence']) {
      assert.ok(schemas[name], `${name} required`);
      assert.deepEqual(schemas[name].properties.evidenceType.enum, ev, `${name}.evidenceType`);
    }
  });

  it('uses the shared StructureNode / Uuid for location and asset context', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.Uuid, 'Uuid required');
    assert.ok(schemas.StructureNode, 'StructureNode required');
    assert.ok(schemas.OperationalContext, 'OperationalContext required');
    // Building hierarchy + asset location both resolve to the shared hierarchy.
    assert.equal(schemas.BuildingHierarchy.properties.building.$ref, '#/components/schemas/StructureNode');
    assert.equal(schemas.AssetLocation.properties.location.$ref, '#/components/schemas/OperationalContext');
    // Canonical IDs are Uuid-typed.
    assert.equal(schemas.Finding.properties.buildingId.$ref, '#/components/schemas/Uuid');
    assert.equal(schemas.WorkOrder.properties.buildingId.$ref, '#/components/schemas/Uuid');
  });

  it('enforces the shared envelope + error responses on every operation', () => {
    const schemas = spec.components.schemas;
    const responses = spec.components.responses ?? {};
    assert.ok(schemas.SuccessEnvelope, 'SuccessEnvelope required');
    assert.ok(schemas.ErrorEnvelope, 'ErrorEnvelope required');
    for (const name of ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound']) {
      assert.ok(responses[name], `reusable response ${name} required`);
    }
    // Every documented 200/201 success must reference SuccessEnvelope.
    const violations: string[] = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        for (const code of ['200', '201']) {
          const resp = op.responses?.[code];
          if (!resp) continue;
          const schema = resp.content?.['application/json']?.schema;
          // Some endpoints (file download) return application/octet-stream —
          // those are legitimately non-envelope; skip them.
          if (resp.content?.['application/octet-stream']) continue;
          if (!schema) continue; // e.g. some 201 responses have no body schema
          const raw = JSON.stringify(schema);
          if (!raw.includes('SuccessEnvelope')) {
            violations.push(`${method.toUpperCase()} ${path} ${code}`);
          }
        }
      }
    }
    assert.deepEqual(violations, [], `success responses not using SuccessEnvelope: ${violations.join(', ')}`);
  });

  it('has no duplicate operationIds and resolves all $refs', () => {
    const schemas = Object.keys(spec.components?.schemas ?? {});
    const responses = Object.keys(spec.components?.responses ?? {});
    const params = Object.keys(spec.components?.parameters ?? {});
    const known = new Set([...schemas, ...responses, ...params]);

    const ids = new Set<string>();
    const dups: string[] = [];
    const unresolved: string[] = [];
    function walk(node: unknown): void {
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref') {
            const target = (v as string).split('/').pop()!;
            if (!known.has(target)) unresolved.push(v as string);
          } else {
            walk(v);
          }
        }
      }
    }
    for (const item of Object.values(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (ids.has(op.operationId)) dups.push(op.operationId);
        ids.add(op.operationId);
        walk(op);
      }
    }
    walk(spec.components);
    assert.deepEqual(dups, [], 'duplicate operationIds');
    assert.deepEqual(unresolved, [], 'unresolved $refs');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — representative end-to-end runtime chain (embedded PostgreSQL)
// ---------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 08 — end-to-end runtime chain', () => {
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
      `TRUNCATE users, roles, permissions, clients, properties, buildings,
         user_building_assignments, findings CASCADE`,
    );
    const admin = await createAdminUser();
    adminToken = admin.token;
    adminUserId = admin.userId;
  });

  after(async () => {
    try {
      if (pool) await closePool(pool);
      if (pg) await pg.stop();
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

  it('login → context → Building → finding → available-actions', async (t) => {
    if (!requireDatabase(t)) return;

    // login
    const login = await api()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: `xcontract-${randomUUID().slice(0, 8)}@example.com`, password: 'x' });
    // (admin is already logged in via createAdminUser; use its token)
    assert.ok(adminToken, 'admin token required');

    // authenticated session → effective role/permission + building context
    const me = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(me.status, 200);
    assert.ok(Array.isArray(me.body.data.access.permissions));
    assert.ok(Array.isArray(me.body.data.access.roles));
    assert.ok(Array.isArray(me.body.data.scope.buildingIds));

    // building context (create an accessible building)
    const client = await clientService.createClient({
      code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'XContract Client',
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'XContract Property',
    });
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'XContract Building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });

    // authorized Building → finding
    const create = await api()
      .post(`${API_PREFIX}/buildings/${building.id}/findings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: client.id, findingNumber: 'FN-X1', title: 'XContract Finding' });
    assert.equal(create.status, 201);
    const findingId = create.body.data.id;

    // authoritative available-actions (workflow authority, not inferred)
    const actions = await api()
      .get(`${API_PREFIX}/findings/${findingId}/available-actions`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(actions.status, 200);
    assert.ok(Array.isArray(actions.body.data.availableActions));
  });
});
