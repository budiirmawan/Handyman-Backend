import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { QueryResultRow } from 'pg';
import request from 'supertest';
import { parse as parseYaml } from 'yaml';
import { createApp } from '../src/app';
import { createApiRouter } from '../src/routes';
import {
  closePool,
  getPool,
  initDatabase,
  migrateUp,
  withTransaction,
} from '../src/database';
import { applyToNewSubject } from '../src/modules/applied-slas/applied-sla.service';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
} from '../src/modules/handyman-bast';
import { handymanCareActorService } from '../src/modules/handyman-care-actors';
import { proposeHandymanChargeableAdditionalWork } from '../src/modules/handyman-chargeable-additional-works';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanEvidenceFile,
  createHandymanEvidenceRecord,
  openHandymanDefect,
  openHandymanQcRun,
} from '../src/modules/handyman-evidence-qc';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import {
  handoffIntegrationSecretEnvName,
  handoffRuntimeRepository,
  signHandoffAssertion,
  type HandoffAssertion,
} from '../src/modules/handyman-handoff';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { estimateHandymanMaterialExecutionLine } from '../src/modules/handyman-material-execution';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { HANDYMAN_SERVICE_WARRANTY_STATUSES, startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import { HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION } from '../src/modules/handyman-service-warranty-contracts';
import { proposeHandymanServiceWarrantyRework } from '../src/modules/handyman-service-warranty-reworks';
import {
  checkInHandymanWorkSession,
  startWorkHandymanWorkSession,
} from '../src/modules/handyman-work-sessions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import {
  HANDYMAN_SLA_SUBJECT_MILESTONES,
  HANDYMAN_SLA_SUBJECT_TYPES,
} from '../src/modules/sla-definitions/handyman-sla-subjects';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import {
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55468;
const DIR = '/tmp/hm17-part08-certification-pg';
Object.assign(process.env, {
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: '',
  DB_NAME: 'asentra_test',
  DB_SSL: 'false',
});

let pg: EmbeddedPostgres | null = null;
let adminUserId = '';
let disciplineId = '';
const app = createApp();

const sql = <T extends QueryResultRow = QueryResultRow>(q: string, p?: unknown[]) =>
  getPool().query<T>(q, p);
const id = () => randomUUID();
const shortCode = () => randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();

/** Certification-only exit gate; runtime authority remains CR-HM-01..16. */
type Schema = {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | Schema;
};
type ResponseSpec = { $ref?: string; content?: Record<string, { schema: Schema }> };
type Operation = { operationId?: string; responses: Record<string, ResponseSpec> };
type ApiSpec = { paths: Record<string, Record<string, Operation>> };
let spec: ApiSpec;
const secretEnvNames: string[] = [];
const secrets: string[] = [];
type ReadCase = { template: string; url: string; query?: Record<string, string> };
let readCases: ReadCase[] = [];
let journey: {
  clientId: string; buildingId: string; requestId: string; scopeId: string;
  bastId: string; warrantyId: string; claimId: string; reworkId: string;
  workId: string; paymentId: string; token: string; userId: string;
};
const successes: Array<{ template: string; method: string; status: number; body: unknown }> = [];

async function scopedSession(buildingId: string, codes: string[]) {
  const token = await createSessionWithPermissions(codes.map((code) => ({ code, name: code })));
  const row = await sql<{ userId: string }>(
    `SELECT user_id AS "userId" FROM user_sessions WHERE token_hash = $1`,
    [createHash('sha256').update(token).digest('hex')],
  );
  assert.ok(row.rows[0], 'session must resolve to its own authenticated user');
  await buildingAssignmentService.createAssignment(row.rows[0].userId, { buildingId });
  return { token, userId: row.rows[0].userId };
}

function resolveRef<T>(ref: string): T {
  assert.ok(ref.startsWith('#/'), `local OpenAPI reference required: ${ref}`);
  let resolved: unknown = spec;
  for (const key of ref.slice(2).split('/')) {
    assert.ok(resolved && typeof resolved === 'object', `unresolved reference ${ref}`);
    resolved = (resolved as Record<string, unknown>)[key];
  }
  assert.ok(resolved, `unresolved reference ${ref}`);
  return resolved as T;
}

// Bounded OpenAPI 3 shape assertions, not a new runtime validator/authority.
function assertSchema(value: unknown, schema: Schema, at = '$'): void {
  if (value === null && schema.nullable) return;
  if (schema.$ref) assertSchema(value, resolveRef<Schema>(schema.$ref), at);
  for (const part of schema.allOf ?? []) assertSchema(value, part, at);
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const matches = alternatives.filter((part) => {
      try { assertSchema(value, part, at); return true; } catch { return false; }
    }).length;
    assert.ok(schema.oneOf ? matches === 1 : matches > 0, `${at}: schema alternatives`);
  }
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const, `${at}: const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${at}: enum ${schema.enum.join(', ')}`);
  if (schema.type === 'object' || schema.properties || schema.required) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${at}: object required`);
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(object, key), `${at}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) assertSchema(item, property, `${at}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${at}.${key}: unexpected property`);
      else if (typeof schema.additionalProperties === 'object') assertSchema(item, schema.additionalProperties, `${at}.${key}`);
    }
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${at}: array required`);
    if (schema.items) value.forEach((item, index) => assertSchema(item, schema.items!, `${at}[${index}]`));
  }
  if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${at}: string required`);
    const text = value as string;
    if (schema.minLength !== undefined) assert.ok(text.length >= schema.minLength, `${at}: minLength`);
    if (schema.maxLength !== undefined) assert.ok(text.length <= schema.maxLength, `${at}: maxLength`);
    if (schema.pattern) assert.match(text, new RegExp(schema.pattern), `${at}: pattern`);
    if (schema.format === 'uuid') assert.match(text, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `${at}: UUID`);
    if (schema.format === 'date-time') assert.ok(Number.isFinite(Date.parse(text)), `${at}: date-time`);
  }
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${at}: boolean required`);
  if (schema.type === 'number' || schema.type === 'integer') {
    assert.equal(typeof value, 'number', `${at}: number required`);
    assert.ok(Number.isFinite(value), `${at}: finite number`);
    if (schema.type === 'integer') assert.ok(Number.isInteger(value), `${at}: integer`);
    if (schema.minimum !== undefined) assert.ok((value as number) >= schema.minimum, `${at}: minimum`);
    if (schema.maximum !== undefined) assert.ok((value as number) <= schema.maximum, `${at}: maximum`);
  }
}

function assertResponseFirewall(value: unknown): void {
  const raw = JSON.stringify(value);
  for (const secret of secrets) assert.equal(raw.includes(secret), false, 'secret value leak');
  const visit = (item: unknown) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      assert.equal(
        /^(?:workOrder|storageKey|storagePath|tokenHash|challengeToken|exchangeToken|providerEntitlement|bmFeeEntitlement|providerPayable|bmFeeAmount|settlementUnit|settlementStatus|reconciliation|payout|disbursement|subscription|license)/i.test(key),
        false, `forbidden response key ${key}`,
      );
      visit(child);
    }
  };
  visit(value);
}

async function fingerprints(mode: 'all' | 'financial' = 'all') {
  const tables = await sql<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      AND (tablename LIKE 'handyman_%' OR tablename IN
        ('applied_slas', 'sla_clocks', 'sla_clock_pause_intervals', 'sla_escalation_actions'))
      ORDER BY tablename`,
  );
  const result: Record<string, string> = {};
  for (const { tablename } of tables.rows) {
    if (mode === 'financial' && !/^handyman_(?:entitlement|settlement)_/.test(tablename)) continue;
    assert.match(tablename, /^[a-z0-9_]+$/);
    const row = await sql<{ fingerprint: string }>(
      `SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)::text) AS fingerprint FROM "${tablename}" r`,
    );
    result[tablename] = row.rows[0].fingerprint;
  }
  assert.ok(Object.keys(result).length > 0, 'non-vacuous fingerprint scope');
  return result;
}

async function customerPost(template: string, url: string, token: string, body: object) {
  const response = await request(app).post(url).set('Authorization', `Bearer ${token}`).send(body);
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(response.body)}`);
  successes.push({ template, method: 'post', status: response.status, body: response.body });
  assertResponseFirewall(response.body);
  return response.body.data;
}


before(async () => {
  spec = parseYaml(await readFile('docs/api/openapi.yaml', 'utf8')) as ApiSpec;
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  await pg.initialise();
  await pg.start();
  const c = pg.getPgClient('postgres', '127.0.0.1');
  await c.connect();
  await c.query('CREATE DATABASE asentra_test');
  await c.end();

  const cfg = await ensureTestDatabase();
  assert.ok(cfg, 'database config required');
  await migrateUp(await initDatabase(cfg));

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline);
  disciplineId = discipline.id;
  initHandymanFixtures({
    adminUserId,
    disciplineId,
    query: sql,
  });
});

after(async () => {
  for (const name of secretEnvNames) delete process.env[name];
  await closePool();
  if (pg) {
    try {
      await pg.stop();
    } catch {
      /* ignore */
    }
  }
  await rm(DIR, { recursive: true, force: true });
});

describe('CR-HM-17 GAP PART 08 — Customer Care Transport End-to-End Certification', () => {
  it('certifies end-to-end Customer Care journey across B3, B4, PART03, B5, B6, B7, and B8 with Backend-resolved represented context and Customer Care != represented tenant', async () => {
    const realm = await realmFixture();
    const chain = await locationChain(realm);

    const financialBefore = await fingerprints('financial');
    // A local Customer Care session is separate from attested BM provenance.
    const cc = await scopedSession(realm.building.id, ['tenant_company.read', 'tenant_company.manage']);
    const ccReadManageToken = cc.token;
    const ccUserId = cc.userId;

    // Represented tenant context (distinct from Customer Care actor)
    const company = await tenantCompanyService.createTenantCompany(
      {
        clientId: realm.client.id,
        tenantCode: `TNT_${shortCode()}`,
        tenantName: 'Certified Tenant Corp',
      },
      adminUserId,
    );
    const tenantUser = await userService.createUser({
      email: `tenant-${shortCode().toLowerCase()}@example.com`,
      displayName: 'Represented Tenant Person',
    });
    await buildingAssignmentService.createAssignment(tenantUser.id, {
      buildingId: realm.building.id,
    });
    const pic = await tenantPicService.createTenantPic(
      {
        tenantCompanyId: company.id,
        picName: 'Represented Tenant PIC',
        email: 'pic@tenant.example.com',
        userId: tenantUser.id,
      },
      adminUserId,
    );
    await tenantSpaceService.assignSpaceToTenant(
      {
        tenantCompanyId: company.id,
        buildingId: realm.building.id,
        spaceId: chain.space.id,
      },
      adminUserId,
    );
    await tenantBuildingContextService.createTenantBuildingContext(
      {
        tenantCompanyId: company.id,
        buildingId: realm.building.id,
      },
      adminUserId,
    );

    // Attested Customer Care actor row (CR-HM-01 AMENDMENT 01)
    const integration = await handoffRuntimeRepository.createIntegration({
      integrationCode: `BM_CARE_${shortCode()}`,
      displayName: 'BM Customer Care Integration',
    });
    await handymanCareActorService.setIntegrationActorCapability({
      integrationId: integration.id,
      capability: 'CUSTOMER_CARE',
    });
    const careActor = await handymanCareActorService.createCareActor({
      integrationId: integration.id,
      actorReference: `CC_AGENT_${shortCode()}`,
      displayName: 'CC Agent Rina',
    });

    // Real signed BM handoff: backend resolves represented tenant context;
    // binding cannot fabricate a user/session or make the Care actor a tenant.
    const secret = `certification-only-secret-${id()}`;
    const secretEnv = handoffIntegrationSecretEnvName(integration.integrationCode);
    process.env[secretEnv] = secret;
    secretEnvNames.push(secretEnv);
    const assertion: HandoffAssertion = {
      integrationCode: integration.integrationCode,
      assertionId: id(),
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      tenantCompanyId: company.id, tenantPicId: pic.id,
      buildingId: realm.building.id, spaceId: chain.space.id,
      actor: { type: 'CUSTOMER_CARE', actorReference: careActor.actorReference },
    };
    const identityCounts = async () => {
      const counts = await sql(`SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM user_sessions) AS sessions,
        (SELECT count(*)::int FROM user_role_assignments) AS roles`);
      return counts.rows[0];
    };
    const identitiesBefore = await identityCounts();
    const signature = signHandoffAssertion(assertion, secret);
    const tampered = await request(app).post('/api/v1/handoff/assertions')
      .set('x-hub-signature-256', signature)
      .send({ ...assertion, actor: { type: 'CUSTOMER_CARE', actorReference: `FORGED_${shortCode()}` } });
    assert.equal(tampered.status, 401);
    assert.equal(tampered.body.error.code, 'HANDYMAN_HANDOFF_ASSERTION_INVALID');
    const handoff = await request(app).post('/api/v1/handoff/assertions')
      .set('x-hub-signature-256', signature).send(assertion);
    assert.equal(handoff.status, 201, JSON.stringify(handoff.body));
    assert.equal(handoff.body.data.context.clientId, realm.client.id);
    assert.equal(handoff.body.data.context.tenantCompanyId, company.id);
    assert.equal(handoff.body.data.context.tenantPicId, pic.id);
    assert.equal(handoff.body.data.context.buildingId, realm.building.id);
    assert.equal(handoff.body.data.context.spaceId, chain.space.id);
    assert.equal(handoff.body.data.context.resolvedUserId, tenantUser.id);
    assert.equal(handoff.body.data.context.careActorId, careActor.id);
    assert.notEqual(careActor.id, tenantUser.id);
    assert.notEqual(ccUserId, tenantUser.id);
    const exchangeToken = handoff.body.data.exchangeToken as string;
    secrets.push(secret, exchangeToken);
    // Exchange credentials are not a Bearer session.
    await request(app).get('/api/v1/handyman/requests').query({ clientId: realm.client.id })
      .set('Authorization', `Bearer ${exchangeToken}`).expect(401);
    const bound = await request(app).post('/api/v1/handoff/channel-attributions')
      .send({ exchangeToken, clientId: id(), tenantCompanyId: id(), createdByUserId: ccUserId });
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
    const attribution = bound.body.data;
    assert.equal(attribution.clientId, realm.client.id);
    assert.equal(attribution.tenantCompanyId, company.id);
    assert.equal(attribution.tenantPicId, pic.id);
    assert.equal(attribution.actorType, 'CUSTOMER_CARE');
    assert.equal(attribution.careActorId, careActor.id);
    assert.equal(attribution.createdByUserId, null);
    await request(app).post('/api/v1/handoff/channel-attributions').send({ exchangeToken }).expect(401);
    const replay = await request(app).post('/api/v1/handoff/assertions')
      .set('x-hub-signature-256', signature).send(assertion);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'HANDYMAN_HANDOFF_ASSERTION_REPLAYED');
    assert.deepEqual(await identityCounts(), identitiesBefore);

    const service = await serviceCatalogService.createServiceCatalogEntry(
      {
        clientId: realm.client.id,
        code: `HM_${shortCode()}`,
        name: 'AC Inspection & Repair',
        category: 'HVAC',
      },
      adminUserId,
    );
    const intake = await request(app).post('/api/v1/handyman/requests')
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({
        channelAttributionId: attribution.id, serviceCatalogId: service.id,
        // Smuggled authority must not substitute represented context/provenance.
        clientId: id(), tenantCompanyId: id(), tenantPicId: ccUserId,
        buildingId: id(), spaceId: id(), createdByUserId: ccUserId,
        actorType: 'TENANT', careActorId: id(), originChannel: 'FM', status: 'DONE',
      });
    assert.equal(intake.status, 201, JSON.stringify(intake.body));
    const hmRequest = intake.body.data;
    assert.equal(hmRequest.clientId, realm.client.id);
    assert.equal(hmRequest.tenantCompanyId, company.id);
    assert.equal(hmRequest.tenantPicId, pic.id);
    assert.equal(hmRequest.buildingId, realm.building.id);
    assert.equal(hmRequest.spaceId, chain.space.id);
    assert.equal(hmRequest.createdByUserId, null);
    assert.equal(hmRequest.originChannel, 'BM_SUPER_APP');
    assert.equal(hmRequest.status, 'INTAKE');
    successes.push({ template: '/handyman/requests', method: 'post', status: 201, body: intake.body });
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: hmRequest.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Direct to diagnosis for certification.',
      },
      adminUserId,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: hmRequest.id,
        disciplineId,
        diagnosis: 'Compressor capacitor replacement needed.',
      },
      adminUserId,
    );

    const qBundle = await createHandymanQuotation(
      { handymanRequestId: hmRequest.id },
      adminUserId,
    );
    const qVersion = qBundle.versions[0];
    const uomId = id();
    await sql(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, 'Unit', 'u', 'COUNT')`,
      [uomId, realm.client.id, `U_${shortCode()}`],
    );
    const laborQLine = await addHandymanQuotationLine(
      qVersion.id,
      {
        lineType: 'LABOR',
        description: 'Technician labor',
        quantity: 1,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 250000,
      },
      adminUserId,
    );
    const materialQLineId = id();
    await sql(
      `INSERT INTO handyman_quotation_lines (
         id, quotation_version_id, line_type, description, quantity,
         uom_id, final_quoted_unit_amount, line_total, currency,
         source_item_id, created_by_user_id
       ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Capacitor 45uF', 2,
                 $3::uuid, 75000, 150000, 'IDR', NULL, $4::uuid)`,
      [materialQLineId, qVersion.id, uomId, adminUserId],
    );
    await issueHandymanQuotationVersion(
      qVersion.id,
      { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
      adminUserId,
    );
    const decision = await decideHandymanQuotation(
      qVersion.id,
      { decision: 'APPROVE', idempotencyKey: `q-dec-${id()}` },
      adminUserId,
    );
    const scope = decision.executionScope;

    // -------------------------------------------------------------------------
    // 1. B3 (PART 01) — Request List & Detail Reads + Customer Care != Tenant
    // -------------------------------------------------------------------------
    const listReqRes = await request(app)
      .get('/api/v1/handyman/requests')
      .query({ clientId: realm.client.id, actorType: 'CUSTOMER_CARE' })
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(listReqRes.status, 200);
    assert.equal(listReqRes.body.data.length, 1);
    assert.equal(listReqRes.body.data[0].id, hmRequest.id);
    assert.equal(
      listReqRes.body.data[0].attribution.actorType,
      'CUSTOMER_CARE',
    );
    assert.equal(
      listReqRes.body.data[0].attribution.careActorId,
      careActor.id,
    );
    assert.equal(listReqRes.body.data[0].attribution.createdByUserId, null);
    assert.equal(listReqRes.body.data[0].tenantCompanyId, company.id);
    assert.equal(listReqRes.body.data[0].tenantPicId, pic.id);
    assert.notEqual(
      listReqRes.body.data[0].attribution.careActorId,
      listReqRes.body.data[0].tenantPicId,
    );

    const detailReqRes = await request(app)
      .get(`/api/v1/handyman/requests/${hmRequest.id}`)
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(detailReqRes.status, 200);
    assert.equal(detailReqRes.body.data.id, hmRequest.id);
    assert.equal(detailReqRes.body.data.careActorId, careActor.id);
    assert.equal(
      detailReqRes.body.data.actorReference,
      careActor.actorReference,
    );
    assert.equal(detailReqRes.body.data.executionScopeId, scope.id);

    // -------------------------------------------------------------------------
    // 2. B4 (PART 02) — Provider & Crew Availability Projection
    // -------------------------------------------------------------------------
    const crew = await crewFixture(realm);
    const availBeforeRes = await request(app)
      .get('/api/v1/handyman/provider-availability')
      .query({ clientId: realm.client.id })
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(availBeforeRes.status, 200);
    assert.equal(availBeforeRes.body.data.length, 1);
    assert.equal(availBeforeRes.body.data[0].crews[0].hasActiveAssignment, false);
    assert.equal(availBeforeRes.body.data[0].crews[0].activeAssignmentCount, 0);

    const assignment = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    const availAssignedRes = await request(app)
      .get('/api/v1/handyman/provider-availability')
      .query({ clientId: realm.client.id })
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(availAssignedRes.status, 200);
    assert.equal(availAssignedRes.body.data[0].crews[0].hasActiveAssignment, true);
    assert.equal(availAssignedRes.body.data[0].crews[0].activeAssignmentCount, 1);

    // -------------------------------------------------------------------------
    // 3. PART 03 — Arrival, Work Session, Material Execution Reads & Lead Firewall
    // -------------------------------------------------------------------------
    const REF = { latitude: -6.2, longitude: 106.816666 };
    await saveHandymanBuildingGeospatialPolicy(
      {
        buildingId: scope.buildingId,
        referenceLatitude: REF.latitude,
        referenceLongitude: REF.longitude,
        geofenceRadiusMeters: 100,
        maxAccuracyMeters: 40,
        maxLocationAgeSeconds: 900,
      },
      adminUserId,
    );
    const qr = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: scope.buildingId,
        floorId: scope.floorId,
        areaId: scope.areaId,
        roomId: scope.roomId,
        spaceId: scope.spaceId,
      },
      adminUserId,
    );
    const ch = await createHandymanArrivalChallenge(
      {
        executionScopeId: scope.id,
        assignmentId: assignment.id,
        ttlSeconds: 600,
      },
      crew.leadUser.id,
    );
    await evaluateHandymanArrivalVerification(
      {
        executionScopeId: scope.id,
        challengeToken: ch.token,
        qrOpaqueCode: qr.value,
        deviceLocation: {
          latitude: REF.latitude,
          longitude: REF.longitude,
          accuracyMeters: 5,
          capturedAt: new Date().toISOString(),
        },
      },
      crew.leadUser.id,
    );

    const session = await checkInHandymanWorkSession(
      {
        executionScopeId: scope.id,
        idempotencyKey: `ws-ci-${id()}`,
      },
      crew.leadUser.id,
    );
    await startWorkHandymanWorkSession(
      {
        sessionId: session.session.id,
        idempotencyKey: `ws-sw-${id()}`,
      },
      crew.leadUser.id,
    );
    const matLine = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: scope.id,
        quotationVersionId: scope.approvedQuotationVersionId,
        quotationLineId: materialQLineId,
        estimatedQty: 2,
        idempotencyKey: `mat-${id()}`,
      },
      crew.leadUser.id,
    );
    assert.ok(session.session.id);
    assert.ok(matLine.line.id);

    const [arrivalGet, wsGet, matGet] = await Promise.all([
      request(app)
        .get(`/api/v1/handyman/execution-scopes/${scope.id}/arrival-verification`)
        .set('Authorization', `Bearer ${ccReadManageToken}`),
      request(app)
        .get(`/api/v1/handyman/execution-scopes/${scope.id}/work-sessions`)
        .set('Authorization', `Bearer ${ccReadManageToken}`),
      request(app)
        .get(`/api/v1/handyman/execution-scopes/${scope.id}/material-lines`)
        .set('Authorization', `Bearer ${ccReadManageToken}`),
    ]);
    assert.equal(arrivalGet.status, 200);
    assert.equal(arrivalGet.body.data.arrivalVerified, true);
    assert.equal(wsGet.status, 200);
    assert.equal(wsGet.body.data.sessions.length, 1);
    assert.equal(matGet.status, 200);
    assert.equal(matGet.body.data.lines.length, 1);
    assert.equal(
      /tokenValue|challengeToken|storageKey/.test(
        JSON.stringify([arrivalGet.body, wsGet.body, matGet.body]),
      ),
      false,
      'secret/storage keys must never leak in PART 03 responses',
    );

    // Crew Lead command firewall: Customer Care user cannot invoke field POST commands
    const ccFieldPostRes = await request(app)
      .post(`/api/v1/handyman/execution-scopes/${scope.id}/work-sessions/check-in`)
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({ idempotencyKey: `forbid-${id()}` });
    assert.equal(ccFieldPostRes.status, 403);

    // -------------------------------------------------------------------------
    // 4. B5 (PART 04) — Evidence / QC / Defect Reads & BAST Transport
    // -------------------------------------------------------------------------
    const defectEv = await createHandymanEvidenceRecord(
      {
        executionScopeId: scope.id,
        stage: 'DEFECT' as never,
        description: 'Capacitor housing photo',
        idempotencyKey: `ev-${id()}`,
      },
      crew.leadUser.id,
    );
    const storageKey = `evidence/${id()}`;
    secrets.push(storageKey, ch.token, qr.value);
    await addHandymanEvidenceFile({
      evidenceRecordId: defectEv.record.id, mediaKind: 'PHOTO', storageKey,
      contentType: 'image/jpeg', byteSize: 2048, sha256Digest: 'a'.repeat(64),
      captureTime: new Date().toISOString(), idempotencyKey: `file-${id()}`,
    }, crew.leadUser.id);
    const qcRun = await openHandymanQcRun(
      {
        executionScopeId: scope.id,
        checklistIdentity: 'HVAC_CHECKLIST_V1',
        idempotencyKey: `qc-${id()}`,
      },
      crew.leadUser.id,
    );
    const defect = await openHandymanDefect(
      {
        executionScopeId: scope.id,
        runId: qcRun.run.id,
        description: 'Panel screw loose',
        idempotencyKey: `def-${id()}`,
      },
      crew.leadUser.id,
    );

    const [evRead, qcListRead, defListRead] = await Promise.all([
      request(app)
        .get(`/api/v1/handyman/execution-scopes/${scope.id}/evidence`)
        .set('Authorization', `Bearer ${ccReadManageToken}`),
      request(app)
        .get(`/api/v1/handyman/execution-scopes/${scope.id}/qc-runs`)
        .set('Authorization', `Bearer ${ccReadManageToken}`),
      request(app)
        .get(`/api/v1/handyman/execution-scopes/${scope.id}/defects`)
        .set('Authorization', `Bearer ${ccReadManageToken}`),
    ]);
    assert.equal(evRead.status, 200);
    assert.equal(evRead.body.data.records.length, 1);
    assert.equal(JSON.stringify(evRead.body).includes('storageKey'), false);
    assert.equal(qcListRead.status, 200);
    assert.equal(qcListRead.body.data.runs.length, 1);
    assert.equal(defListRead.status, 200);
    assert.equal(defListRead.body.data.defects.length, 1);

    // Crew Lead command firewall on QC/Defect POST
    const ccQcPostRes = await request(app)
      .post(`/api/v1/handyman/execution-scopes/${scope.id}/qc-runs`)
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({ checklistIdentity: 'HVAC', idempotencyKey: `forbid-qc-${id()}` });
    assert.equal(ccQcPostRes.status, 403);

    // BAST prepared & issued in-process by provider/admin -> accepted & read via Customer Care HTTP transport
    const preparedBast = await prepareHandymanBast(adminUserId, {
      executionScopeId: scope.id,
      idempotencyKey: `bast-prep-${id()}`,
    });
    const bastId = preparedBast.bast.id;
    await issueHandymanBast(adminUserId, {
      bastId,
      idempotencyKey: `bast-iss-${id()}`,
    });

    const bastAcc = await request(app)
      .post(`/api/v1/handyman/bast/${bastId}/accept`)
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({
        idempotencyKey: `bast-acc-${id()}`,
        signatureDigest: `sig-${id()}`,
      });
    assert.equal(bastAcc.status, 200);
    successes.push({ template: '/handyman/bast/{bastId}/accept', method: 'post', status: 200, body: bastAcc.body });
    assert.equal(bastAcc.body.data.acceptance.customerAccepted, true);
    assert.equal(bastAcc.body.data.acceptance.warrantyStartEligible, true);

    const bastGet = await request(app)
      .get(`/api/v1/handyman/execution-scopes/${scope.id}/bast`)
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(bastGet.status, 200);
    assert.equal(bastGet.body.data.bast.id, bastId);

    // -------------------------------------------------------------------------
    // 5. B6 (PART 05) — Customer Ledger & Payment Transport + CR-HM-14 Firewall
    // -------------------------------------------------------------------------
    await openHandymanCustomerTransaction(
      {
        executionScopeId: scope.id,
        idempotencyKey: `tx-open-${id()}`,
      },
      adminUserId,
    );
    await composeHandymanChargeLine(
      {
        executionScopeId: scope.id,
        quotationLineId: laborQLine.id,
        idempotencyKey: `cl-labor-${id()}`,
      },
      adminUserId,
    );

    const payRecRes = await request(app)
      .post(`/api/v1/handyman/execution-scopes/${scope.id}/customer-payments`)
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({
        amount: '250000.00',
        channel: 'VIRTUAL_ACCOUNT',
        providerName: 'Neutral Bank VA',
        providerReference: 'VA-BCA-001',
        externalReference: `EXT-${shortCode()}`,
        idempotencyKey: `pay-rec-${id()}`,
      });
    assert.equal(payRecRes.status, 200);
    successes.push({ template: '/handyman/execution-scopes/{executionScopeId}/customer-payments', method: 'post', status: 200, body: payRecRes.body });
    const paymentId = payRecRes.body.data.payment.id as string;

    const payConfRes = await request(app)
      .post(
        `/api/v1/handyman/execution-scopes/${scope.id}/customer-payments/${paymentId}/confirm`,
      )
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({
        idempotencyKey: `pay-conf-${id()}`,
      });
    assert.equal(payConfRes.status, 200);
    successes.push({ template: '/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/confirm', method: 'post', status: 200, body: payConfRes.body });

    const ledgerGet = await request(app)
      .get(`/api/v1/handyman/execution-scopes/${scope.id}/customer-ledger`)
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(ledgerGet.status, 200);
    assert.equal(ledgerGet.body.data.contractVersion, 'CR-HM-13-PART-06');
    assert.equal(ledgerGet.body.data.readOnly, true);
    assert.equal(ledgerGet.body.data.transaction.executionScopeId, scope.id);
    assert.equal(ledgerGet.body.data.totals.laborGross, '250000.00');
    assert.equal(ledgerGet.body.data.totals.materialGross, '0.00');
    assert.equal(ledgerGet.body.data.totals.receivedGross, '250000.00');
    // CR-HM-13's published eligibility marker is not a CR-HM-14 entitlement.
    assert.equal(ledgerGet.body.data.authority.authoritativeForEntitlement, true);
    assert.deepEqual(ledgerGet.body.data.authority.deniedBy, []);
    assert.equal(
      /providerSettlement|providerEntitlement|bmFeeEntitlement|providerPayable|bmFeeAmount|bmShare|platformFee|settlementUnit|reconciliation|payout|disbursement/i.test(
        JSON.stringify(ledgerGet.body),
      ),
      false,
      'CR-HM-14 financial facts must never appear in B6 responses (the CR-HM-13 authority marker is permitted)',
    );

    // -------------------------------------------------------------------------
    // 6. B7 (PART 06) — Service Warranty, Claim, Rework & Chargeable Work
    // -------------------------------------------------------------------------
    const startedWarranty = await startHandymanServiceWarranty(
      {
        executionScopeId: scope.id,
        idempotencyKey: `war-start-${id()}`,
      },
      adminUserId,
    );
    const warrantyId = startedWarranty.warranty.id;

    const claimOpenRes = await request(app)
      .post(`/api/v1/handyman/service-warranties/${warrantyId}/claims`)
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({
        evidenceRecordId: defectEv.record.id,
        claimNote: 'Post-repair vibration noise',
        idempotencyKey: `claim-open-${id()}`,
      });
    assert.equal(claimOpenRes.status, 200, JSON.stringify(claimOpenRes.body));
    successes.push({ template: '/handyman/service-warranties/{warrantyId}/claims', method: 'post', status: 200, body: claimOpenRes.body });
    const claimId = claimOpenRes.body.data.claim.id as string;

    const claimSubRes = await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claimId}/submit`)
      .set('Authorization', `Bearer ${ccReadManageToken}`)
      .send({ idempotencyKey: `claim-sub-${id()}` });
    assert.equal(claimSubRes.status, 200);
    successes.push({ template: '/handyman/service-warranty-claims/{claimId}/submit', method: 'post', status: 200, body: claimSubRes.body });

    const warGetRes = await request(app)
      .get(`/api/v1/handyman/execution-scopes/${scope.id}/service-warranty`)
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(warGetRes.status, 200);
    assert.equal(warGetRes.body.data.warranty.id, warrantyId);
    assert.equal(warGetRes.body.data.claims.length, 1);

    await customerPost('/handyman/service-warranty-claims/{claimId}/approve',
      `/api/v1/handyman/service-warranty-claims/${claimId}/approve`, ccReadManageToken,
      { idempotencyKey: `approve-${id()}`, decisionNote: 'Covered workmanship defect' });
    const proposedRework = await proposeHandymanServiceWarrantyRework(crew.leadUser.id, {
      claimId, scopeNote: 'Free covered rework', idempotencyKey: `rework-${id()}`,
    });
    const reworkId = proposedRework.rework.id;
    const authorized = await customerPost('/handyman/service-warranty-reworks/{reworkId}/authorize',
      `/api/v1/handyman/service-warranty-reworks/${reworkId}/authorize`, ccReadManageToken,
      { idempotencyKey: `authorize-${id()}` });
    assert.equal(authorized.rework.status, 'REWORK_AUTHORIZED');

    // Separate chargeable path on a second original scope/warranty — never
    // convert the authorized free rework into a financial/chargeable record.
    const chargeFixture = await scopeFixture(realm, await locationChain(realm));
    const chargeScope = chargeFixture.scope;
    assert.ok(chargeScope);
    const chargeCrew = await crewFixture(realm);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: chargeScope.id, providerContextId: chargeCrew.providerContext.id, crewId: chargeCrew.crew.id,
    }, adminUserId);
    const chargeBast = await prepareHandymanBast(adminUserId, {
      executionScopeId: chargeScope.id, idempotencyKey: `cb-prep-${id()}`,
    });
    await issueHandymanBast(adminUserId, { bastId: chargeBast.bast.id, idempotencyKey: `cb-issue-${id()}` });
    await acceptHandymanBast(adminUserId, { bastId: chargeBast.bast.id, idempotencyKey: `cb-accept-${id()}`, signatureDigest: 'certification-sig' });
    const chargeWarranty = await startHandymanServiceWarranty({
      executionScopeId: chargeScope.id, idempotencyKey: `cw-${id()}`,
    }, adminUserId);
    const chargeClaim = await customerPost('/handyman/service-warranties/{warrantyId}/claims',
      `/api/v1/handyman/service-warranties/${chargeWarranty.warranty.id}/claims`, ccReadManageToken,
      { claimNote: 'Uncovered additional installation', idempotencyKey: `cclaim-${id()}` });
    const chargeEvidence = await createHandymanEvidenceRecord({
      executionScopeId: chargeScope.id, stage: 'DEFECT', idempotencyKey: `cev-${id()}`,
    }, chargeCrew.leadUser.id);
    await customerPost('/handyman/service-warranty-claims/{claimId}/submit',
      `/api/v1/handyman/service-warranty-claims/${chargeClaim.claim.id}/submit`, ccReadManageToken,
      { evidenceRecordId: chargeEvidence.record.id, idempotencyKey: `csubmit-${id()}` });
    await customerPost('/handyman/service-warranty-claims/{claimId}/reject',
      `/api/v1/handyman/service-warranty-claims/${chargeClaim.claim.id}/reject`, ccReadManageToken,
      { decisionNote: 'Outside warranty scope', idempotencyKey: `creject-${id()}` });
    const proposedWork = await proposeHandymanChargeableAdditionalWork(adminUserId, {
      claimId: chargeClaim.claim.id, scopeNote: 'Separated chargeable installation', idempotencyKey: `cpropose-${id()}`,
    });
    const workId = proposedWork.work.id;
    const chargeAccepted = await customerPost('/handyman/chargeable-additional-works/{workId}/accept',
      `/api/v1/handyman/chargeable-additional-works/${workId}/accept`, ccReadManageToken,
      { idempotencyKey: `caccept-${id()}` });
    assert.equal(chargeAccepted.work.status, 'CHARGEABLE_AUTHORIZED');
    assert.equal(chargeAccepted.paymentTrigger.eventType, 'PAYMENT_TRIGGER');
    assert.equal('amount' in chargeAccepted.work, false);

    // -------------------------------------------------------------------------
    // 7. B8 (PART 07) — SLA Subjects, Provider Performance & Status Visibility
    // -------------------------------------------------------------------------
    const now = new Date('2026-09-20T09:00:00.000Z');
    for (const subjectType of HANDYMAN_SLA_SUBJECT_TYPES) {
      await slaDefinitionRepository.create({
        clientId: realm.client.id,
        code: `SLA_${subjectType}_${shortCode()}`,
        name: `SLA ${subjectType}`,
        operationalType: subjectType,
        responseTargetMinutes: 30,
        resolutionTargetMinutes: 120,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      });
    }
    const subjectMap: Record<(typeof HANDYMAN_SLA_SUBJECT_TYPES)[number], string> =
      {
        HANDYMAN_SERVICE_REQUEST: hmRequest.id,
        HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT: assignment.id,
        HANDYMAN_EXECUTION_SCOPE: scope.id,
        HANDYMAN_DEFECT_RECORD: defect.defect.id,
        HANDYMAN_SERVICE_WARRANTY_CLAIM: claimId,
      };
    for (const subjectType of HANDYMAN_SLA_SUBJECT_TYPES) {
      await withTransaction((tx) =>
        applyToNewSubject(
          {
            subjectType,
            subjectId: subjectMap[subjectType],
            clientId: realm.client.id,
            buildingId: realm.building.id,
            createdAt: now,
          },
          tx,
        ),
      );
    }

    const slaSubjRes = await request(app)
      .get(
        `/api/v1/handyman/sla/subjects/HANDYMAN_SERVICE_REQUEST/${hmRequest.id}`,
      )
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(slaSubjRes.status, 200);
    assert.equal(slaSubjRes.body.data.milestones.length, 2);

    const perfRes = await request(app)
      .get('/api/v1/handyman/provider-performance')
      .query({
        clientId: realm.client.id,
        buildingId: realm.building.id,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(perfRes.status, 200);
    assert.equal(perfRes.body.data.milestoneAdherence.length, 9);

    const statusVisRes = await request(app)
      .get(`/api/v1/handyman/requests/${hmRequest.id}/status-visibility`)
      .set('Authorization', `Bearer ${ccReadManageToken}`);
    assert.equal(statusVisRes.status, 200);
    assert.equal(statusVisRes.body.data.handymanRequestId, hmRequest.id);
    assert.equal(statusVisRes.body.data.executionScopeId, scope.id);
    assert.equal(
      statusVisRes.body.data.slaMilestones.length,
      HANDYMAN_SLA_SUBJECT_MILESTONES.length,
    );
    journey = { clientId: realm.client.id, buildingId: realm.building.id, requestId: hmRequest.id,
      scopeId: scope.id, bastId, warrantyId, claimId, reworkId, workId, paymentId,
      token: ccReadManageToken, userId: ccUserId };
    const scopePath = '/handyman/execution-scopes/{executionScopeId}';
    const scopeUrl = `/api/v1/handyman/execution-scopes/${scope.id}`;
    readCases = [
      { template: '/handyman/requests', url: '/api/v1/handyman/requests', query: { clientId: realm.client.id } },
      { template: '/handyman/requests/{handymanRequestId}', url: `/api/v1/handyman/requests/${hmRequest.id}` },
      { template: '/handyman/provider-availability', url: '/api/v1/handyman/provider-availability', query: { clientId: realm.client.id } },
      ...['arrival-verification', 'work-sessions', 'material-lines', 'evidence', 'qc-runs', 'defects', 'bast', 'customer-ledger', 'customer-payments', 'service-warranty'].map((tail) => ({ template: `${scopePath}/${tail}`, url: `${scopeUrl}/${tail}` })),
      { template: '/handyman/evidence-records/{evidenceRecordId}', url: `/api/v1/handyman/evidence-records/${defectEv.record.id}` },
      { template: '/handyman/qc-runs/{qcRunId}', url: `/api/v1/handyman/qc-runs/${qcRun.run.id}` },
      { template: '/handyman/defects/{defectId}', url: `/api/v1/handyman/defects/${defect.defect.id}` },
      { template: '/handyman/bast/{bastId}', url: `/api/v1/handyman/bast/${bastId}` },
      { template: '/handyman/customer-ledger', url: '/api/v1/handyman/customer-ledger', query: { clientId: realm.client.id } },
      { template: '/handyman/service-warranties/{warrantyId}', url: `/api/v1/handyman/service-warranties/${warrantyId}` },
      { template: '/handyman/service-warranty-claims/{claimId}', url: `/api/v1/handyman/service-warranty-claims/${claimId}` },
      { template: '/handyman/service-warranty-reworks/{reworkId}', url: `/api/v1/handyman/service-warranty-reworks/${reworkId}` },
      { template: '/handyman/chargeable-additional-works/{workId}', url: `/api/v1/handyman/chargeable-additional-works/${workId}` },
      ...HANDYMAN_SLA_SUBJECT_TYPES.map((subjectType) => ({ template: '/handyman/sla/subjects/{subjectType}/{subjectId}', url: `/api/v1/handyman/sla/subjects/${subjectType}/${subjectMap[subjectType]}` })),
      { template: '/handyman/provider-performance', url: '/api/v1/handyman/provider-performance', query: { clientId: realm.client.id } },
      { template: '/handyman/requests/{id}/status-visibility', url: `/api/v1/handyman/requests/${hmRequest.id}/status-visibility` },
      { template: '/handyman/execution-scopes/{id}/status-visibility', url: `${scopeUrl}/status-visibility` },
    ];
    assert.equal(readCases.length, 30);
    assert.equal(new Set(readCases.map((c) => c.template)).size, 26);
    assert.deepEqual(await fingerprints('financial'), financialBefore, 'journey commands must never write CR-HM-14 entitlement/settlement');

  });

  it('certifies all 26 GET operations: authenticated Customer Care read access, manage != read, cross-client isolation, secrets, and zero state mutation', async () => {
    assert.ok(journey, 'completed journey required');
    const plainToken = await createPlainSession();
    const readOnly = await scopedSession(journey.buildingId, ['tenant_company.read']);
    const manageOnly = await scopedSession(journey.buildingId, ['tenant_company.manage']);
    const foreignRealm = await realmFixture();
    const foreign = await scopedSession(foreignRealm.building.id, ['tenant_company.read', 'tenant_company.manage']);
    const before = await fingerprints();
    for (const c of readCases) {
      const get = (token?: string) => {
        const call = request(app).get(c.url).query(c.query ?? {});
        return token ? call.set('Authorization', `Bearer ${token}`) : call;
      };
      const noAuth = await get();
      assert.equal(noAuth.status, 401, c.url);
      for (const token of [plainToken, manageOnly.token]) {
        const noRead = await get(token);
        assert.equal(noRead.status, 403, c.url);
        assert.equal(noRead.body.error.code, 'PERMISSION_DENIED', c.url);
      }
      const crossClient = await get(foreign.token);
      assert.equal(crossClient.status, 403, `${c.url}: ${JSON.stringify(crossClient.body)}`);
      assert.ok(crossClient.body.error.code, 'bounded cross-client error');
      const allowed = await get(readOnly.token);
      assert.equal(allowed.status, 200, `${c.url}: ${JSON.stringify(allowed.body)}`);
      assert.equal(allowed.body.success, true);
      assertResponseFirewall(allowed.body);
      successes.push({ template: c.template, method: 'get', status: 200, body: allowed.body });
    }
    assert.deepEqual(await fingerprints(), before, 'GET/denied access must not write Handyman or shared SLA state');
  });

  it('certifies manage-only customer commands, read-only and foreign-client command denial, and Lead/provider/FM/SaaS/CR-HM-14 command firewalls', async () => {
    assert.ok(journey);
    const reader = await scopedSession(journey.buildingId, ['tenant_company.read']);
    const manager = await scopedSession(journey.buildingId, ['tenant_company.manage']);
    const foreignRealm = await realmFixture();
    const foreign = await scopedSession(foreignRealm.building.id, ['tenant_company.read', 'tenant_company.manage']);
    const root = `/api/v1/handyman/execution-scopes/${journey.scopeId}`;
    const commandUrls = [
      ...['accept', 'reject', 'sign-off'].map((action) => `/api/v1/handyman/bast/${journey.bastId}/${action}`),
      `${root}/customer-payments`, ...['confirm', 'reject'].map((action) => `${root}/customer-payments/${journey.paymentId}/${action}`),
      `/api/v1/handyman/service-warranties/${journey.warrantyId}/claims`,
      ...['submit', 'approve', 'reject', 'withdraw'].map((action) => `/api/v1/handyman/service-warranty-claims/${journey.claimId}/${action}`),
      `/api/v1/handyman/service-warranty-reworks/${journey.reworkId}/authorize`,
      ...['accept', 'reject'].map((action) => `/api/v1/handyman/chargeable-additional-works/${journey.workId}/${action}`),
    ];
    assert.equal(commandUrls.length, 14);
    const before = await fingerprints();
    for (const url of commandUrls) {
      const body = { idempotencyKey: `denied-${id()}`, decision: 'ACCEPT', signatureDigest: 'sig',
        amount: '10.00', channel: 'CASH', reason: 'Reject pending intake', decisionNote: 'Outside coverage' };
      const unauth = await request(app).post(url).send(body);
      assert.equal(unauth.status, 401, url);
      const readOnly = await request(app).post(url).set('Authorization', `Bearer ${reader.token}`).send(body);
      assert.equal(readOnly.status, 403, url);
      assert.equal(readOnly.body.error.code, 'PERMISSION_DENIED');
      // Warranty transport validates forbidden financial-shaped fields before its authority check.
      const ordinary = url.includes('customer-payments') ? body : { idempotencyKey: body.idempotencyKey,
        decision: 'ACCEPT', signatureDigest: 'sig', decisionNote: 'Outside coverage' };
      const cross = await request(app).post(url).set('Authorization', `Bearer ${foreign.token}`).send(ordinary);
      assert.equal(cross.status, 403, `${url}: ${JSON.stringify(cross.body)}`);
    }
    // Existing field command authorities cannot be replaced by Care/manage RBAC.
    for (const [url, body, code] of [
      [`${root}/work-sessions/check-in`, { idempotencyKey: `lead-${id()}` }, 'HANDYMAN_WORK_SESSION_NOT_AUTHORIZED'],
      [`${root}/qc-runs`, { checklistIdentity: 'CERT', idempotencyKey: `lead-${id()}` }, 'HANDYMAN_QC_NOT_AUTHORIZED'],
      [`${root}/evidence`, { stage: 'AFTER', idempotencyKey: `lead-${id()}` }, 'HANDYMAN_EVIDENCE_NOT_AUTHORIZED'],
    ] as const) {
      const response = await request(app).post(url).set('Authorization', `Bearer ${journey.token}`).send(body);
      assert.equal(response.status, 403, url);
      assert.equal(response.body.error.code, code);
    }
    for (const type of ['WORK_ORDER', 'FM_WORK_ORDER', 'SAAS_TICKET', 'ASSET_WARRANTY']) {
      await request(app).get(`/api/v1/handyman/sla/subjects/${type}/${id()}`)
        .set('Authorization', `Bearer ${journey.token}`).expect(400);
    }
    for (const url of [
      '/api/v1/handyman/provider-availability', '/api/v1/handyman/provider-performance',
      `${root}/customer-ledger/open`, `${root}/service-warranty/start`,
      `/api/v1/handyman/bast/${journey.bastId}/prepare`, `/api/v1/handyman/bast/${journey.bastId}/issue`,
      `/api/v1/handyman/service-warranty-reworks/${journey.reworkId}/start`,
      '/api/v1/handyman/settlements', '/api/v1/handyman/financial-entitlements',
      `${root}/financial-settlement`, `${root}/asset-warranty`,
    ]) {
      await request(app).post(url).set('Authorization', `Bearer ${journey.token}`)
        .send({ idempotencyKey: `absent-${id()}` }).expect(404);
    }
    assert.deepEqual(await fingerprints(), before, 'denied/absent commands must never change lifecycle or financial state');
    // Positive manage-only path: no implicit read grant, no internal money writer.
    const financialBefore = await fingerprints('financial');
    const pending = await customerPost('/handyman/execution-scopes/{executionScopeId}/customer-payments',
      `${root}/customer-payments`, manager.token,
      { amount: '10.00', channel: 'CASH', idempotencyKey: `manage-${id()}` });
    assert.equal(pending.payment.status, 'PENDING');
    assert.equal(pending.payment.recordedByUserId, manager.userId);
    const rejected = await customerPost('/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/reject',
      `${root}/customer-payments/${pending.payment.id}/reject`, manager.token,
      { reason: 'Certification of manage boundary', idempotencyKey: `reject-${id()}` });
    assert.equal(rejected.payment.status, 'REJECTED');
    assert.deepEqual(await fingerprints('financial'), financialBefore);
  });

  it('certifies mounted route/operation parity and real full HTTP success bodies against OpenAPI across PART 01–07', async () => {
    const requiredPaths: Array<{ path: string; methods: string[] }> = [
      // PART 01 — B3
      { path: '/handyman/requests', methods: ['get', 'post'] },
      { path: '/handyman/requests/{handymanRequestId}', methods: ['get'] },
      // PART 02 — B4
      { path: '/handyman/provider-availability', methods: ['get'] },
      // PART 03 — Arrival / Work / Material Customer Care reads
      {
        path: '/handyman/execution-scopes/{executionScopeId}/arrival-verification',
        methods: ['get'],
      },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/work-sessions',
        methods: ['get'],
      },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/material-lines',
        methods: ['get'],
      },
      // PART 04 — B5 Evidence / QC / Defect reads + BAST transport
      {
        path: '/handyman/execution-scopes/{executionScopeId}/evidence',
        methods: ['get', 'post'],
      },
      {
        path: '/handyman/evidence-records/{evidenceRecordId}',
        methods: ['get'],
      },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/qc-runs',
        methods: ['get', 'post'],
      },
      { path: '/handyman/qc-runs/{qcRunId}', methods: ['get'] },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/defects',
        methods: ['get', 'post'],
      },
      { path: '/handyman/defects/{defectId}', methods: ['get'] },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/bast',
        methods: ['get'],
      },
      { path: '/handyman/bast/{bastId}', methods: ['get'] },
      { path: '/handyman/bast/{bastId}/accept', methods: ['post'] },
      { path: '/handyman/bast/{bastId}/reject', methods: ['post'] },
      { path: '/handyman/bast/{bastId}/sign-off', methods: ['post'] },
      // PART 05 — B6 Customer ledger / payment transport
      {
        path: '/handyman/execution-scopes/{executionScopeId}/customer-ledger',
        methods: ['get'],
      },
      { path: '/handyman/customer-ledger', methods: ['get'] },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/customer-payments',
        methods: ['get', 'post'],
      },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/confirm',
        methods: ['post'],
      },
      {
        path: '/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/reject',
        methods: ['post'],
      },
      // PART 06 — B7 Service warranty / claim / rework / chargeable additional work
      {
        path: '/handyman/execution-scopes/{executionScopeId}/service-warranty',
        methods: ['get'],
      },
      { path: '/handyman/service-warranties/{warrantyId}', methods: ['get'] },
      {
        path: '/handyman/service-warranties/{warrantyId}/claims',
        methods: ['post'],
      },
      {
        path: '/handyman/service-warranty-claims/{claimId}',
        methods: ['get'],
      },
      {
        path: '/handyman/service-warranty-claims/{claimId}/submit',
        methods: ['post'],
      },
      {
        path: '/handyman/service-warranty-claims/{claimId}/approve',
        methods: ['post'],
      },
      {
        path: '/handyman/service-warranty-claims/{claimId}/reject',
        methods: ['post'],
      },
      {
        path: '/handyman/service-warranty-claims/{claimId}/withdraw',
        methods: ['post'],
      },
      {
        path: '/handyman/service-warranty-reworks/{reworkId}',
        methods: ['get'],
      },
      {
        path: '/handyman/service-warranty-reworks/{reworkId}/authorize',
        methods: ['post'],
      },
      {
        path: '/handyman/chargeable-additional-works/{workId}',
        methods: ['get'],
      },
      {
        path: '/handyman/chargeable-additional-works/{workId}/accept',
        methods: ['post'],
      },
      {
        path: '/handyman/chargeable-additional-works/{workId}/reject',
        methods: ['post'],
      },
      // PART 07 — B8 SLA & Status Visibility
      {
        path: '/handyman/sla/subjects/{subjectType}/{subjectId}',
        methods: ['get'],
      },
      { path: '/handyman/provider-performance', methods: ['get'] },
      { path: '/handyman/requests/{id}/status-visibility', methods: ['get'] },
      {
        path: '/handyman/execution-scopes/{id}/status-visibility',
        methods: ['get'],
      },
    ];

    for (const entry of requiredPaths) {
      const pathObj = spec.paths[entry.path];
      assert.ok(pathObj, `OpenAPI missing path ${entry.path}`);
      for (const method of entry.methods) {
        assert.ok(
          pathObj[method],
          `OpenAPI missing method ${method.toUpperCase()} on ${entry.path}`,
        );
      }
    }

    assert.equal(requiredPaths.reduce((n, entry) => n + entry.methods.length, 0), 44);
    const baseline = parseYaml(execSync('git show b87d72f:docs/api/openapi.yaml', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as ApiSpec;
    assert.deepEqual(Object.keys(spec.paths), Object.keys(baseline.paths), 'certification adds no API paths');
    for (const url of Object.keys(spec.paths)) {
      assert.deepEqual(Object.keys(spec.paths[url]), Object.keys(baseline.paths[url]),
        `certification adds no methods on ${url}`);
    }
    type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
    const mounted: string[] = [];
    const normalize = (url: string) => url.replace(/:[A-Za-z0-9_]+|\{[^}]+\}/g, '{}');
    const walk = (layers: Layer[]) => {
      for (const layer of layers) {
        if (layer.route) for (const [method, on] of Object.entries(layer.route.methods)) {
          if (on) mounted.push(`${method} ${normalize(layer.route.path)}`);
        }
        if (layer.handle?.stack) walk(layer.handle.stack);
      }
    };
    walk(createApiRouter().stack as Layer[]);
    for (const { path: url, methods } of requiredPaths) for (const method of methods) {
      assert.equal(mounted.filter((key) => key === `${method} ${normalize(url)}`).length, 1,
        `exactly one mounted authority for ${method} ${url}`);
      const operation = spec.paths[url][method];
      assert.ok(operation.operationId);
      assert.ok(operation.responses['401']);
      assert.ok(operation.responses['403']);
    }
    assert.equal(successes.length, 44, '44 real full HTTP success samples required');
    const dataBound = (schema: Schema): boolean => {
      if (schema.$ref) return schema.$ref !== '#/components/schemas/SuccessEnvelope'
        && dataBound(resolveRef<Schema>(schema.$ref));
      return Boolean(schema.properties?.data)
        || Boolean(schema.allOf?.some(dataBound));
    };
    assert.deepEqual(resolveRef<Schema>('#/components/schemas/HandymanServiceWarrantyStatus').enum,
      [...HANDYMAN_SERVICE_WARRANTY_STATUSES], 'warranty head vocabulary must come from its owner, not claim/rework vocabularies');
    assert.deepEqual(resolveRef<Schema>('#/components/schemas/HandymanServiceWarrantyContract').properties?.contractVersion?.enum,
      [HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION], 'published warranty version type/value must be preserved');
    assert.deepEqual(resolveRef<Schema>('#/components/schemas/HandymanSlaSubjectType').enum,
      [...HANDYMAN_SLA_SUBJECT_TYPES]);
    assert.deepEqual(resolveRef<Schema>('#/components/schemas/HandymanSlaMilestoneName').enum,
      HANDYMAN_SLA_SUBJECT_MILESTONES.map((m) => m.milestone));
    // Validator sanity probes: missing required fields and wrong frozen enums are rejected.
    assert.throws(() => assertSchema({}, { type: 'object', required: ['executionScopeId'] }));
    assert.throws(() => assertSchema('FM_DONE', { type: 'string', enum: ['INTAKE'] }));
    const mismatches: string[] = [];
    for (const success of successes) {
      const response = spec.paths[success.template]?.[success.method]?.responses[String(success.status)];
      assert.ok(response, `documented response status for ${success.template}`);
      const definition = response.$ref ? resolveRef<ResponseSpec>(response.$ref) : response;
      const schema = definition.content?.['application/json']?.schema;
      assert.ok(schema, `response schema for ${success.template}`);
      try {
        assert.ok(dataBound(schema), 'success schema must bind the payload under data');
        assertSchema(success.body, schema);
      }
      catch (error) { mismatches.push(`${success.method.toUpperCase()} ${success.template}: ${(error as Error).message}`); }
    }
    assert.deepEqual(mismatches, [], `Full HTTP body / OpenAPI mismatch:\n${mismatches.join('\n')}`);

  });

  it('certifies frozen governance, runtime/lifecycle authority preservation, and static FM/SaaS/CR-HM-14 isolation', async () => {
    // Governance baseline untouched since PART 00 (2fcfad9)
    const govDiff = execSync(
      'git diff 2fcfad9..HEAD -- docs/handyman/CR-HM-17_CUSTOMER_CARE_TRANSPORT_GAP_GOVERNANCE.md',
      { encoding: 'utf8' },
    );
    assert.equal(
      govDiff.trim(),
      '',
      'PART 00 governance document must remain unmodified across PART 01–08',
    );

    // Zero new migrations across PART 01–08 (no duplicate lifecycle authority)
    const migrationDiff = execSync(
      'git diff 2fcfad9..HEAD -- src/database/migrations/',
      { encoding: 'utf8' },
    );
    assert.equal(
      migrationDiff.trim(),
      '',
      'CR-HM-17 transport gap must not add or modify database migrations',
    );

    assert.equal(execSync('git diff b87d72f -- src package.json package-lock.json', { encoding: 'utf8' }).trim(), '',
      'certification must not change runtime/dependencies');
    assert.equal(execSync("git diff 2fcfad9..b87d72f -- 'src/modules/handyman-*/*.lifecycle.ts' src/modules/applied-slas src/modules/sla-definitions src/modules/handyman-provider-performance src/modules/handyman-financial-entitlements src/modules/handyman-settlement src/modules/handyman-financial-read src/modules/work-orders src/modules/work-order-sla-register src/modules/asset-warranties src/modules/subscriptions src/modules/entitlements src/modules/due-job-scheduler src/modules/request-idempotency", { encoding: 'utf8' }).trim(), '',
      'frozen lifecycle/SLA/financial/FM/SaaS authorities remain unchanged');

    // Static firewall scan across PART 01–07 transport/service modules
    const transportFiles = [
      'src/modules/handyman-requests/handyman-service-request.service.ts',
      'src/modules/handyman-providers/handyman-provider-availability.service.ts',
      'src/modules/handyman-arrival-results/handyman-arrival-result.service.ts',
      'src/modules/handyman-work-sessions/handyman-work-session.service.ts',
      'src/modules/handyman-material-execution/handyman-material-execution.service.ts',
      'src/modules/handyman-evidence-qc/handyman-evidence-qc.service.ts',
      'src/modules/handyman-bast-api/handyman-bast-api.controller.ts',
      'src/modules/handyman-customer-ledger-api/handyman-customer-ledger-api.controller.ts',
      'src/modules/handyman-service-warranty-api/handyman-service-warranty-api.service.ts',
      'src/modules/handyman-sla-status-api/handyman-sla-status-api.service.ts',
    ];
    for (const rel of transportFiles) {
      const src = await readFile(path.resolve(process.cwd(), rel), 'utf8');
      assert.equal(
        /from ['"].*(work-orders|work-order-sla-register|asset-warranties|handyman-financial-entitlements|handyman-settlement|handyman-financial-read|saas)/i.test(
          src,
        ),
        false,
        `Forbidden import detected in ${rel}`,
      );
      assert.equal(/\b(?:FROM|JOIN)\s+(?:work_orders|work_order_sla_register|asset_warranties|handyman_entitlement_\w+|handyman_settlement_\w+|platform_subscriptions|platform_billing|tenant_invoices)\b/i.test(src),
        false, `forbidden fallback SQL in ${rel}`);
    }
  });
});
