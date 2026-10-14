/**
 * CR-HM-OPS-INBOX-BE-01 — authoritative commercial action inbox.
 *
 * Focused validation over a disposable embedded PostgreSQL with the REAL
 * migration schema: discovery authority (Operations user without Tenant PIC
 * membership), Client/Building scope isolation, historical requests with open
 * commercial records, multiple execution scopes per request, duplicate-free
 * keyset pagination across page boundaries and large limits, filters and
 * authoritative counts, additions during pagination, and permission denial
 * without data leakage.
 *
 * The commercial records themselves are seeded with their repository-native
 * states (respecting the existing CHECK/FK/trigger contracts of migrations
 * 0435/0436); the lifecycle commands behind them are covered by their own
 * suites (handyman-scope-variations, handyman-material-purchasing).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import {
  addHandymanQuotationLine,
  createHandymanQuotationRevision,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  locationChain,
  realmFixture,
  scopeFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const INBOX_PATH = '/api/v1/handyman/operations/commercial-inbox';
const DB_PORT = 55479;
const DATA_DIR = '/tmp/handyman-ops-inbox-pg';
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
let admin: { token: string; userId: string } | null = null;

const realmA = { clientId: '', buildingAId: '', buildingBId: '' };
const realmC = { clientId: '', buildingId: '' };
const ops = {
  readToken: '',
  managerToken: '',
  readTokenB: '',
  foreignTokenC: '',
  noPermissionToken: '',
  unassignedToken: '',
};

type SeededIds = {
  clientId: string;
  buildingAId: string;
  buildingBId: string;
  scopeA1: string;
  scopeA1b: string;
  scopeA2: string;
  scopeA3: string;
  scopeB1: string;
  scopeC1: string;
  tenantA1: string;
  tenantA2: string;
  variations: Record<string, string>;
  materials: Record<string, string>;
};

let seeded: SeededIds | null = null;

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('test database is not initialized');
  return pool.query(text, params);
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function scopeContext(scopeId: string) {
  const res = await q(
    `SELECT id, client_id AS "clientId", handyman_request_id AS "handymanRequestId",
            tenant_company_id AS "tenantCompanyId", building_id AS "buildingId",
            approved_quotation_version_id AS "approvedVersionId"
       FROM handyman_execution_scopes WHERE id = $1`,
    [scopeId],
  );
  return res.rows[0];
}

async function firstApprovedLineId(scopeId: string): Promise<string> {
  const res = await q(
    `SELECT l.id FROM handyman_quotation_lines l
       JOIN handyman_execution_scopes s ON s.approved_quotation_version_id = l.quotation_version_id
      WHERE s.id = $1
      ORDER BY l.created_at ASC, l.id ASC LIMIT 1`,
    [scopeId],
  );
  return res.rows[0].id as string;
}

async function firstUomId(clientId: string): Promise<string> {
  const res = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [clientId],
  );
  return res.rows[0].id as string;
}

async function seedVariation(input: {
  scopeId: string;
  status: string;
  variationType?: 'ADD' | 'REDUCE';
  tenantDecisionOutcome?: string | null;
  revisedQuotationVersionId?: string | null;
  targetQuotationLineId?: string | null;
  originActorRole?: 'PIC_PEKERJAAN' | 'INSPECTOR';
  createdAt?: Date;
}): Promise<string> {
  const ctx = await scopeContext(input.scopeId);
  const uomId = await firstUomId(ctx.clientId);
  const id = randomUUID();
  await q(
    `INSERT INTO handyman_scope_variations
       (id, client_id, execution_scope_id, handyman_request_id,
        tenant_company_id, building_id, variation_type, line_type,
        target_quotation_line_id, revised_quotation_version_id,
        title, description, technical_finding, quantity, uom_id,
        quoted_unit_amount, quoted_total_delta, currency,
        status, tenant_decision_outcome,
        origin_actor_user_id, origin_actor_role,
        latest_evidence_reference, create_idempotency_key,
        version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'LABOR',$8,$9,
             'Seed variation','seed description','seed finding',2,$10,
             $11,$12,'IDR',
             $13,$14,
             $15,$16,
             $17,$18,
             1,$19,$19)`,
    [
      id,
      ctx.clientId,
      input.scopeId,
      ctx.handymanRequestId,
      ctx.tenantCompanyId,
      ctx.buildingId,
      input.variationType ?? 'ADD',
      input.targetQuotationLineId ?? null,
      input.revisedQuotationVersionId ?? null,
      uomId,
      input.revisedQuotationVersionId ? '1000.00' : null,
      input.revisedQuotationVersionId ? '2000.00' : null,
      input.status,
      input.tenantDecisionOutcome ?? null,
      admin!.userId,
      input.originActorRole ?? 'PIC_PEKERJAAN',
      `hm-ev://${randomUUID()}`,
      `seed-${id}`,
      input.createdAt ?? new Date(),
    ],
  );
  return id;
}

async function seedMaterial(input: {
  scopeId: string;
  status: string;
  issued?: string;
  purchased?: string;
  used?: string;
  returned?: string;
  createdAt?: Date;
}): Promise<string> {
  const ctx = await scopeContext(input.scopeId);
  const uom = await q(
    `SELECT id, code FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [ctx.clientId],
  );
  const id = randomUUID();
  await q(
    `INSERT INTO handyman_material_purchase_records
       (id, client_id, execution_scope_id, handyman_request_id,
        tenant_company_id, building_id,
        material_execution_line_id, source_item_id, item_name,
        uom_id, uom_code, funding_source, status,
        requested_quantity, approved_quantity, issued_quantity, purchased_quantity,
        used_quantity, returned_quantity,
        latest_evidence_reference, requested_by_user_id,
        create_idempotency_key, version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,
             NULL,NULL,'Seed valve',
             $7,$8,'PETTY_CASH',$9,
             '5.000','5.000',$10,$11,
             $12,$13,
             $14,$15,
             $16,1,$17,$17)`,
    [
      id,
      ctx.clientId,
      input.scopeId,
      ctx.handymanRequestId,
      ctx.tenantCompanyId,
      ctx.buildingId,
      uom.rows[0].id,
      uom.rows[0].code,
      input.status,
      input.issued ?? '0.000',
      input.purchased ?? '0.000',
      input.used ?? '0.000',
      input.returned ?? '0.000',
      `hm-ev://${randomUUID()}`,
      admin!.userId,
      `seed-${id}`,
      input.createdAt ?? new Date(),
    ],
  );
  return id;
}

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
    const adminClient = pg.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users CASCADE');

  admin = await createAdminUser();
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  const query = async (text: string, params: unknown[] = []) => {
    if (!pool) throw new Error('test database is not initialized');
    return pool.query(text, params);
  };
  initHandymanFixtures({
    adminUserId: admin.userId,
    disciplineId: discipline.id,
    query,
  });

  // Building A (Client A): the Operations actors' genuine scope.
  const a = await realmFixture('Commercial inbox A');
  const chainA1 = await locationChain(a);
  const scopeA1 = await scopeFixture(a, chainA1);
  const chainA2 = await locationChain(a);
  const scopeA2 = await scopeFixture(a, chainA2);
  const chainA3 = await locationChain(a);
  const scopeA3 = await scopeFixture(a, chainA3);

  // Sibling Building B under the SAME Client A: same-Client isolation proof.
  const buildingB = await buildingService.createBuilding({
    propertyId: a.property.id,
    code: `B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Sibling Building B',
  });
  const siblingRealm = { ...a, building: buildingB };
  const chainB1 = await locationChain(siblingRealm);
  const adminB = await createAdminUser();
  await buildingAssignmentService.createAssignment(adminB.userId, {
    buildingId: buildingB.id,
  });
  initHandymanFixtures({
    adminUserId: adminB.userId,
    disciplineId: discipline.id,
    query,
  });
  const scopeB1 = await scopeFixture(siblingRealm, chainB1);

  // Genuinely foreign Client C: cross-tenant denial proof.
  initHandymanFixtures({
    adminUserId: adminB.userId,
    disciplineId: discipline.id,
    query,
  });
  const c = await realmFixture('Foreign client C');
  const chainC1 = await locationChain(c);
  const scopeC1 = await scopeFixture(c, chainC1);

  // Operations actors: permissioned, Building-assigned, and NEVER Tenant PICs.
  initHandymanFixtures({
    adminUserId: admin.userId,
    disciplineId: discipline.id,
    query,
  });
  const readToken = await createSessionWithPermissions([
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);
  const readUserId = (
    await q(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`)
  ).rows[0].id as string;
  await buildingAssignmentService.createAssignment(readUserId, {
    buildingId: a.building.id,
  });

  const managerToken = await createSessionWithPermissions([
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
  ]);
  const managerUserId = (
    await q(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`)
  ).rows[0].id as string;
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: a.building.id,
  });

  const readTokenB = await createSessionWithPermissions([
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);
  const readUserIdB = (
    await q(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`)
  ).rows[0].id as string;
  await buildingAssignmentService.createAssignment(readUserIdB, {
    buildingId: buildingB.id,
  });

  const foreignTokenC = await createSessionWithPermissions([
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);
  const foreignUserIdC = (
    await q(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`)
  ).rows[0].id as string;
  await buildingAssignmentService.createAssignment(foreignUserIdC, {
    buildingId: c.building.id,
  });

  const noPermissionToken = await createSessionWithPermissions([]);
  const noPermissionUserId = (
    await q(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`)
  ).rows[0].id as string;
  await buildingAssignmentService.createAssignment(noPermissionUserId, {
    buildingId: a.building.id,
  });

  const unassignedToken = await createSessionWithPermissions([
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);

  ops.readToken = readToken;
  ops.managerToken = managerToken;
  ops.readTokenB = readTokenB;
  ops.foreignTokenC = foreignTokenC;
  ops.noPermissionToken = noPermissionToken;
  ops.unassignedToken = unassignedToken;

  // ---- Commercial records (repository-native states, seeded rows) --------

  const ctxA1 = await scopeContext(scopeA1.scope.id);
  const ctxA3 = await scopeContext(scopeA3.scope.id);
  const lineA1 = await firstApprovedLineId(scopeA1.scope.id);
  const uomA = await firstUomId(a.client.id);

  // Approve a revision of requestA1's quotation → a SECOND execution scope on
  // the SAME request (multiple-scope discovery proof), plus one further DRAFT
  // revision to carry the AUTHORIZED_SCOPE variation's revised-quotation
  // reference on that second scope.
  const scopeA1QuotationId = (await q(
    `SELECT quotation_id AS id FROM handyman_execution_scopes WHERE id = $1`,
    [scopeA1.scope.id],
  )).rows[0].id as string;
  const revisionA1 = await createHandymanQuotationRevision(
    scopeA1QuotationId,
    admin.userId,
  );
  await addHandymanQuotationLine(revisionA1.id, {
    lineType: 'LABOR', description: 'Revision hours', quantity: 2, uomId: uomA,
    currency: 'IDR', finalQuotedUnitAmount: 150,
  }, admin.userId);
  await issueHandymanQuotationVersion(revisionA1.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, admin.userId);
  const revisionDecision = await decideHandymanQuotation(revisionA1.id, {
    decision: 'APPROVE', idempotencyKey: `inbox-${randomUUID()}`,
  }, admin.userId);
  const revisionScopeId = revisionDecision.executionScope?.id ?? null;
  assert.ok(revisionScopeId, 'approved revision must create its execution scope');

  const draftRevisionA1b = await createHandymanQuotationRevision(
    scopeA1QuotationId,
    admin.userId,
  );

  const scopeA2QuotationId = (await q(
    `SELECT quotation_id AS id FROM handyman_execution_scopes WHERE id = $1`,
    [scopeA2.scope.id],
  )).rows[0].id as string;
  const draftRevisionA2 = await createHandymanQuotationRevision(
    scopeA2QuotationId,
    admin.userId,
  );

  const historical = new Date(Date.now() - 40 * 24 * 3_600_000);

  const v1 = await seedVariation({
    scopeId: scopeA1.scope.id,
    status: 'FIELD_FINDING',
    variationType: 'ADD',
  });
  const v2 = await seedVariation({
    scopeId: scopeA1.scope.id,
    status: 'PROPOSAL',
    variationType: 'REDUCE',
    targetQuotationLineId: lineA1,
  });
  const v3 = await seedVariation({
    scopeId: scopeA1.scope.id,
    status: 'OPERATIONS_REVIEW',
  });
  // AUTHORIZED_SCOPE variation sitting on requestA1's SECOND execution scope.
  const v4 = await seedVariation({
    scopeId: revisionScopeId as string,
    status: 'AUTHORIZED_SCOPE',
    tenantDecisionOutcome: 'APPROVED',
    revisedQuotationVersionId: draftRevisionA1b.id,
  });
  const v5 = await seedVariation({
    scopeId: scopeA2.scope.id,
    status: 'REVISED_QUOTATION',
    revisedQuotationVersionId: draftRevisionA2.id,
  });
  const v6 = await seedVariation({
    scopeId: scopeA2.scope.id,
    status: 'TENANT_DECISION',
    tenantDecisionOutcome: 'APPROVED',
    revisedQuotationVersionId: draftRevisionA2.id,
  });
  const v7Closed = await seedVariation({
    scopeId: scopeA2.scope.id,
    status: 'TENANT_DECISION',
    tenantDecisionOutcome: 'REJECTED',
    revisedQuotationVersionId: draftRevisionA2.id,
  });
  const v11Execution = await seedVariation({
    scopeId: scopeA2.scope.id,
    status: 'EXECUTION',
    tenantDecisionOutcome: 'APPROVED',
    revisedQuotationVersionId: draftRevisionA2.id,
  });
  const v8Historical = await seedVariation({
    scopeId: scopeA3.scope.id,
    status: 'FIELD_FINDING',
    createdAt: historical,
  });

  const v9Sibling = await seedVariation({
    scopeId: scopeB1.scope.id,
    status: 'PROPOSAL',
  });
  const v10Foreign = await seedVariation({
    scopeId: scopeC1.scope.id,
    status: 'OPERATIONS_REVIEW',
  });

  const m1 = await seedMaterial({ scopeId: scopeA1.scope.id, status: 'REQUEST' });
  const m2 = await seedMaterial({
    scopeId: scopeA1.scope.id, status: 'ISSUED', issued: '2.000',
  });
  const m3 = await seedMaterial({
    scopeId: scopeA2.scope.id, status: 'PURCHASED', purchased: '3.000',
  });
  const m4Balanced = await seedMaterial({
    scopeId: scopeA2.scope.id, status: 'USAGE', issued: '2.000', used: '2.000',
  });
  const m5Exception = await seedMaterial({
    scopeId: scopeA2.scope.id, status: 'USAGE', issued: '2.000', used: '1.000',
  });
  const m8Reconciled = await seedMaterial({
    scopeId: scopeA2.scope.id, status: 'RECONCILIATION',
    issued: '2.000', used: '2.000',
  });
  const m6HistoricalException = await seedMaterial({
    scopeId: scopeA3.scope.id, status: 'RETURN',
    issued: '2.000', used: '0.000', returned: '1.000',
    createdAt: historical,
  });
  const m7Sibling = await seedMaterial({
    scopeId: scopeB1.scope.id, status: 'REQUEST',
  });

  // Backdate requestA3 so its open commercial records prove historical
  // request visibility (an old request whose commercial record stays open).
  await q(
    `UPDATE handyman_service_requests
        SET created_at = $2, updated_at = $2
      WHERE id = $1`,
    [ctxA3.handymanRequestId, historical],
  );

  seeded = {
    clientId: a.client.id,
    buildingAId: a.building.id,
    buildingBId: buildingB.id,
    scopeA1: scopeA1.scope.id,
    scopeA1b: revisionScopeId as string,
    scopeA2: scopeA2.scope.id,
    scopeA3: scopeA3.scope.id,
    scopeB1: scopeB1.scope.id,
    scopeC1: scopeC1.scope.id,
    tenantA1: ctxA1.tenantCompanyId as string,
    tenantA2: (await scopeContext(scopeA2.scope.id)).tenantCompanyId as string,
    variations: {
      v1, v2, v3, v4, v5, v6, v7Closed, v8Historical,
      v9Sibling, v10Foreign,
    },
    materials: {
      m1, m2, m3, m4Balanced, m5Exception, m6HistoricalException,
      m7Sibling, m8Reconciled,
    },
  };

  realmA.clientId = a.client.id;
  realmA.buildingAId = a.building.id;
  realmA.buildingBId = buildingB.id;
  realmC.clientId = c.client.id;
  realmC.buildingId = c.building.id;
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
  if (!database || !pool || !admin || !seeded) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

type InboxItem = {
  recordId: string;
  recordType: string;
  recordStatus: string;
  executionScopeId: string;
  handymanRequestId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  responsible: { persona: string; action: string };
  reconciliationException: boolean;
};

async function fetchAll(
  token: string,
  extraQuery: Record<string, unknown> = {},
): Promise<{ status: number; items: InboxItem[]; body: any }> {
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  let cursor: string | undefined;
  let status = 0;
  let body: any;
  for (let guard = 0; guard < 200; guard += 1) {
    const response = await api()
      .get(INBOX_PATH)
      .set(auth(token))
      .query({
        clientId: seeded!.clientId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...extraQuery,
      });
    status = response.status;
    body = response.body;
    assert.equal(status, 200, JSON.stringify(body));
    for (const item of body.data.items) {
      assert.ok(!seen.has(item.recordId), 'duplicate record across pages');
      seen.add(item.recordId);
      items.push(item);
    }
    cursor = body.data.pagination.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return { status, items, body };
}

const EXPECTED_A_IDS = () => [
  seeded!.variations.v1,
  seeded!.variations.v2,
  seeded!.variations.v3,
  seeded!.variations.v4,
  seeded!.variations.v5,
  seeded!.variations.v6,
  seeded!.variations.v8Historical,
  seeded!.materials.m1,
  seeded!.materials.m2,
  seeded!.materials.m3,
  seeded!.materials.m4Balanced,
  seeded!.materials.m5Exception,
  seeded!.materials.m6HistoricalException,
];

describe('Handyman Operations commercial action inbox (CR-HM-OPS-INBOX-BE-01)', () => {
  it('OpenAPI contract: the inbox operation is documented with the tenant_company.read authority', () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as Record<string, any>;
    const op = (spec.paths as Record<string, any>)[
      '/handyman/operations/commercial-inbox'
    ]?.get;
    assert.ok(op, 'GET /handyman/operations/commercial-inbox is documented');
    assert.equal(op.operationId, 'listHandymanOperationsCommercialInbox');
    assert.equal(op['x-required-permission'], 'tenant_company.read');
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    assert.ok(op.responses['401'], 'canonical 401 is documented');
    assert.ok(op.responses['403'], 'scope denial is documented');
    assert.ok(op.responses['400'], 'validation errors are documented');
    const enumStatuses: string[] =
      op.parameters.find((parameter: any) => parameter.name === 'status')
        ?.schema?.enum ?? [];
    for (const status of [
      'FIELD_FINDING', 'PROPOSAL', 'OPERATIONS_REVIEW', 'REVISED_QUOTATION',
      'TENANT_DECISION', 'AUTHORIZED_SCOPE',
      'REQUEST', 'ISSUED', 'PURCHASED', 'USAGE', 'RETURN',
    ]) {
      assert.ok(enumStatuses.includes(status), `status ${status} is documented`);
    }
  });

  it('P0-B: discovers every actionable Variation and Material record within the assigned Building — across all execution scopes, request ages, and record types, without Tenant PIC membership', async (t) => {
    if (!requireDatabase(t)) return;
    const { items } = await fetchAll(ops.readToken);
    const ids = items.map((item) => item.recordId).sort();
    assert.deepEqual(ids, [...EXPECTED_A_IDS()].sort());

    // Closed, terminal, downstream, sibling and foreign records never leak.
    for (const closed of [
      seeded!.variations.v7Closed,
      seeded!.variations.v11Execution,
      seeded!.materials.m8Reconciled,
      seeded!.variations.v9Sibling,
      seeded!.materials.m7Sibling,
      seeded!.variations.v10Foreign,
    ]) {
      assert.ok(!ids.includes(closed), `closed/out-of-scope ${closed} must not appear`);
    }

    // Every result carries the authoritative identities.
    const byId = new Map(items.map((item) => [item.recordId, item]));
    const v4 = byId.get(seeded!.variations.v4)!;
    assert.equal(v4.recordType, 'SCOPE_VARIATION');
    assert.equal(v4.recordStatus, 'AUTHORIZED_SCOPE');
    assert.equal(v4.executionScopeId, seeded!.scopeA1b);
    assert.equal(v4.clientId, seeded!.clientId);
    assert.equal(v4.buildingId, seeded!.buildingAId);
    assert.ok(v4.handymanRequestId);

    // Historical request visibility: the 40-day-old request's open records.
    const historical = items.filter(
      (item) => item.recordId === seeded!.variations.v8Historical ||
        item.recordId === seeded!.materials.m6HistoricalException,
    );
    assert.equal(historical.length, 2);

    // Derived responsibility comes from existing authority only.
    const v1 = byId.get(seeded!.variations.v1)!;
    assert.deepEqual(v1.responsible, { persona: 'PIC_PEKERJAAN', action: 'PROPOSAL' });
    const v2 = byId.get(seeded!.variations.v2)!;
    assert.deepEqual(v2.responsible, { persona: 'OPERATIONS_MANAGER', action: 'OPERATIONS_REVIEW' });
    const v5 = byId.get(seeded!.variations.v5)!;
    assert.deepEqual(v5.responsible, { persona: 'TENANT', action: 'TENANT_DECISION' });
    const v6 = byId.get(seeded!.variations.v6)!;
    assert.deepEqual(v6.responsible, { persona: 'OPERATIONS_MANAGER', action: 'AUTHORIZED_SCOPE' });
    const m1 = byId.get(seeded!.materials.m1)!;
    assert.deepEqual(m1.responsible, { persona: 'OPERATIONS_MANAGER', action: 'APPROVAL' });
    const m2 = byId.get(seeded!.materials.m2)!;
    assert.deepEqual(m2.responsible, { persona: 'PIC_PEKERJAAN', action: 'USAGE' });
    const m4 = byId.get(seeded!.materials.m4Balanced)!;
    assert.deepEqual(m4.responsible, { persona: 'OPERATIONS_MANAGER', action: 'RECONCILIATION' });
    assert.equal(m4.reconciliationException, false);
    const m5 = byId.get(seeded!.materials.m5Exception)!;
    assert.equal(m5.reconciliationException, true);
    const m6 = byId.get(seeded!.materials.m6HistoricalException)!;
    assert.equal(m6.reconciliationException, true);

    for (const item of items) {
      assert.equal(Object.hasOwn(item, 'workOrderId'), false);
      assert.ok(item.sourceReference.startsWith('hm-ev://'));
      assert.ok(item.createdAt && item.updatedAt);
      assert.ok(['SCOPE_VARIATION', 'MATERIAL_PURCHASE'].includes(item.recordType));
    }
  });

  it('P1: keyset pagination produces no duplicates and no omissions across page boundaries, with an explicit continuation contract', async (t) => {
    if (!requireDatabase(t)) return;
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const response = await api()
        .get(INBOX_PATH)
        .set(auth(ops.readToken))
        .query({
          clientId: seeded!.clientId,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const page = response.body.data;
      assert.ok(page.items.length <= 2);
      for (const item of page.items) collected.push(item.recordId);
      pages += 1;
      const { nextCursor, hasMore } = page.pagination;
      assert.equal(hasMore, page.items.length === 2 && nextCursor !== null);
      if (!nextCursor) break;
      assert.notEqual(nextCursor, cursor);
      cursor = nextCursor;
    }
    assert.ok(pages >= 6, `expected several pages, got ${pages}`);
    assert.equal(new Set(collected).size, collected.length, 'no duplicates across pages');
    assert.deepEqual(
      [...collected].sort(),
      [...EXPECTED_A_IDS()].sort(),
      'no omissions across pages',
    );
  });

  it('P1: handles large pagination boundaries (limit=1 walk, max limit validation)', async (t) => {
    if (!requireDatabase(t)) return;
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const response = await api()
        .get(INBOX_PATH)
        .set(auth(ops.readToken))
        .query({
          clientId: seeded!.clientId,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const page = response.body.data;
      for (const item of page.items) collected.push(item.recordId);
      if (!page.pagination.nextCursor) break;
      cursor = page.pagination.nextCursor;
    }
    assert.deepEqual(
      [...collected].sort(),
      [...EXPECTED_A_IDS()].sort(),
    );

    const tooLarge = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, limit: 101 });
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.body.error.code, 'VALIDATION_ERROR');

    const malformedCursor = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, cursor: 'not-a-cursor' });
    assert.equal(malformedCursor.status, 400);
    assert.equal(malformedCursor.body.error.code, 'VALIDATION_ERROR');

    // A well-formed cursor pointing at the oldest key bound continues as a
    // clean empty page (explicit contract, no silent page restart).
    const epochCursor = Buffer.from(JSON.stringify({
      createdAt: '1970-01-01T00:00:00.000Z',
      recordType: 'MATERIAL_PURCHASE',
      recordId: randomUUID(),
    })).toString('base64url');
    const pastCursor = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, limit: 5, cursor: epochCursor });
    assert.equal(pastCursor.status, 200, JSON.stringify(pastCursor.body));
    assert.equal(pastCursor.body.data.items.length, 0);
    assert.equal(pastCursor.body.data.pagination.nextCursor, null);
    assert.equal(pastCursor.body.data.pagination.hasMore, false);
  });

  it('P1: additions during pagination never duplicate or shift an in-flight continuation', async (t) => {
    if (!requireDatabase(t)) return;
    const firstPage = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, limit: 2 });
    assert.equal(firstPage.status, 200);
    const pageItems = firstPage.body.data.items as InboxItem[];
    const cursor = firstPage.body.data.pagination.nextCursor as string;
    assert.ok(cursor);

    // A record inserted after page 1 sorts (by created_at DESC) BEFORE the
    // outstanding cursor: it must appear on a fresh first page, never inside
    // the continuation walk.
    const added = await seedVariation({
      scopeId: seeded!.scopeA2,
      status: 'OPERATIONS_REVIEW',
    });

    const continuationIds: string[] = [];
    let next: string | undefined = cursor;
    for (let guard = 0; guard < 100 && next; guard += 1) {
      const response = await api()
        .get(INBOX_PATH)
        .set(auth(ops.readToken))
        .query({ clientId: seeded!.clientId, limit: 2, cursor: next });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      for (const item of response.body.data.items) {
        continuationIds.push(item.recordId);
      }
      next = response.body.data.pagination.nextCursor ?? undefined;
    }
    assert.ok(!continuationIds.includes(added), 'addition must not invade the continuation');
    assert.equal(
      new Set([...pageItems, ...continuationIds]).size,
      pageItems.length + continuationIds.length,
      'no duplicates after a mid-pagination insert',
    );

    const fresh = await fetchAll(ops.readToken);
    assert.ok(fresh.items.some((item) => item.recordId === added));
    // Reset the expectation for later subtests.
    seeded!.variations.v12Late = added;
  });

  it('P1: server-side filters narrow discovery by record type, status, persona, tenant, and authoritative dates', async (t) => {
    if (!requireDatabase(t)) return;
    const materials = await fetchAll(ops.readToken, {
      recordType: 'MATERIAL_PURCHASE',
    });
    assert.ok(materials.items.length > 0);
    assert.ok(materials.items.every((item) => item.recordType === 'MATERIAL_PURCHASE'));
    assert.deepEqual(
      materials.items.map((item) => item.recordId).sort(),
      EXPECTED_A_IDS().filter((id) => Object.values(seeded!.materials).includes(id)).sort(),
    );

    const requestStatus = await fetchAll(ops.readToken, { status: 'REQUEST' });
    assert.deepEqual(
      requestStatus.items.map((item) => item.recordId).sort(),
      [seeded!.materials.m1].sort(),
    );

    const tenantWaiting = await fetchAll(ops.readToken, {
      status: 'TENANT_DECISION',
    });
    assert.deepEqual(
      tenantWaiting.items.map((item) => item.recordId).sort(),
      [seeded!.variations.v6].sort(),
      'a tenant-REJECTED decision is closed and never discovered',
    );

    const tenantPersona = await fetchAll(ops.readToken, { responsible: 'TENANT' });
    assert.deepEqual(
      tenantPersona.items.map((item) => item.recordId).sort(),
      [seeded!.variations.v5].sort(),
    );

    const operations = await fetchAll(ops.readToken, {
      responsible: 'OPERATIONS_MANAGER',
    });
    assert.ok(operations.items.length > 0);
    assert.ok(
      operations.items.every((item) => item.responsible.persona === 'OPERATIONS_MANAGER'),
    );

    const tenantScoped = await fetchAll(ops.readToken, {
      tenantCompanyId: seeded!.tenantA2,
    });
    assert.ok(tenantScoped.items.length > 0);
    assert.ok(
      tenantScoped.items.every((item) => item.tenantCompanyId === seeded!.tenantA2),
    );

    const recentOnly = await fetchAll(ops.readToken, {
      createdFrom: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    });
    const recentIds = recentOnly.items.map((item) => item.recordId).sort();
    assert.ok(!recentIds.includes(seeded!.variations.v8Historical));
    assert.ok(!recentIds.includes(seeded!.materials.m6HistoricalException));
    assert.ok(recentIds.includes(seeded!.variations.v1));

    const everything = await fetchAll(ops.readToken);
    const expectedRecent = everything.items
      .filter((item) => new Date(item.createdAt).getTime() >= Date.now() - 24 * 3_600_000)
      .map((item) => item.recordId)
      .sort();
    assert.deepEqual(recentIds, expectedRecent);
  });

  it('P1: counts are authoritative over the COMPLETE permitted set — even when the served page is partial', async (t) => {
    if (!requireDatabase(t)) return;
    const partial = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, limit: 2, includeCounts: true });
    assert.equal(partial.status, 200, JSON.stringify(partial.body));
    const counts = partial.body.data.counts;
    assert.ok(counts, 'counts are present when requested');
    assert.equal(partial.body.data.items.length, 2);

    const complete = await fetchAll(ops.readToken);
    assert.equal(counts.total, complete.items.length);
    assert.equal(
      counts.byRecordType.SCOPE_VARIATION +
        counts.byRecordType.MATERIAL_PURCHASE,
      counts.total,
    );
    const statusSum = Object.values(counts.byStatus).reduce(
      (sum: number, value) => sum + (value as number),
      0,
    );
    const personaSum = Object.values(counts.byResponsiblePersona).reduce(
      (sum: number, value) => sum + (value as number),
      0,
    );
    assert.equal(statusSum, counts.total);
    assert.equal(personaSum, counts.total);
    // Closed/terminal records are absent from the authoritative counts too.
    assert.equal(counts.byStatus['RECONCILIATION'], undefined);

    const materialCounts = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({
        clientId: seeded!.clientId,
        recordType: 'MATERIAL_PURCHASE',
        includeCounts: true,
      });
    assert.equal(
      materialCounts.body.data.counts.total,
      complete.items.filter((item) => item.recordType === 'MATERIAL_PURCHASE').length,
    );

    // Counts are opt-in: default responses carry no page-total confusion.
    const noCounts = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, limit: 2 });
    assert.equal(noCounts.body.data.counts, undefined);
  });

  it('P0-A/P0-B: Operations discovery requires neither Tenant PIC membership nor PLATFORM_ADMIN, and preserves Client/Building isolation', async (t) => {
    if (!requireDatabase(t)) return;
    // The sibling-Building Operations actor — same Client, different Building —
    // discovers ONLY its own Building's records.
    const sibling = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readTokenB))
      .query({ clientId: seeded!.clientId, limit: 50 });
    assert.equal(sibling.status, 200, JSON.stringify(sibling.body));
    const siblingIds = sibling.body.data.items.map((item: InboxItem) => item.recordId).sort();
    assert.deepEqual(
      siblingIds,
      [seeded!.variations.v9Sibling, seeded!.materials.m7Sibling].sort(),
    );

    // The Building-A actor cannot filter the sibling Building (no same-Client
    // shortcut): 403 without data.
    const siblingFilter = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, buildingId: seeded!.buildingBId });
    assert.equal(siblingFilter.status, 403);
    assert.equal(siblingFilter.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(siblingFilter.body.data, undefined);

    // An explicit own-Building filter narrows to the same set.
    const ownBuilding = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: seeded!.clientId, buildingId: seeded!.buildingAId, limit: 50 });
    assert.equal(ownBuilding.status, 200);
    const expectedOwnBuilding = [...EXPECTED_A_IDS()];
    if (seeded!.variations.v12Late) expectedOwnBuilding.push(seeded!.variations.v12Late);
    assert.deepEqual(
      ownBuilding.body.data.items.map((item: InboxItem) => item.recordId).sort(),
      expectedOwnBuilding.sort(),
    );

    // Cross-tenant: the Building-A actor cannot reach Client C at all.
    const crossTenant = await api()
      .get(INBOX_PATH)
      .set(auth(ops.readToken))
      .query({ clientId: realmC.clientId });
    assert.equal(crossTenant.status, 403);
    assert.equal(crossTenant.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(crossTenant.body.data, undefined);
    const foreignView = await api()
      .get(INBOX_PATH)
      .set(auth(ops.foreignTokenC))
      .query({ clientId: realmC.clientId, limit: 50 });
    assert.equal(foreignView.status, 200);
    assert.deepEqual(
      foreignView.body.data.items.map((item: InboxItem) => item.recordId),
      [seeded!.variations.v10Foreign],
    );
  });

  it('denies permission-less and assignment-less actors with no data leakage', async (t) => {
    if (!requireDatabase(t)) return;
    const denied = await api()
      .get(INBOX_PATH)
      .set(auth(ops.noPermissionToken))
      .query({ clientId: seeded!.clientId });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    assert.equal(denied.body.data, undefined);

    const unassigned = await api()
      .get(INBOX_PATH)
      .set(auth(ops.unassignedToken))
      .query({ clientId: seeded!.clientId });
    assert.equal(unassigned.status, 403);
    assert.equal(unassigned.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(unassigned.body.data, undefined);

    const anonymous = await api().get(INBOX_PATH).query({ clientId: seeded!.clientId });
    assert.equal(anonymous.status, 401);
  });

  it('manager scope discovers identically (read authority shared; manage never widens discovery)', async (t) => {
    if (!requireDatabase(t)) return;
    const managerView = await fetchAll(ops.managerToken);
    const expectedManager = [...EXPECTED_A_IDS()];
    if (seeded!.variations.v12Late) expectedManager.push(seeded!.variations.v12Late);
    assert.deepEqual(
      managerView.items.map((item) => item.recordId).sort(),
      expectedManager.sort(),
    );
  });
});
