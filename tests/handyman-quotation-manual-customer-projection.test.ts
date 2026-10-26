/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 03C focused validation.
 *
 * CUSTOMER QUOTATION PROJECTION & NOTIFICATION for an issued MANUAL-ORIGIN
 * (unlisted-intake) quotation REVISION. Nothing here invents a projection, a
 * consent engine or a delivery stack: every assertion runs through the
 * EXISTING customer quotation surface (`GET /handyman/requests/:id/
 * quotation[/presented]`, `GET /handyman/quotation-versions/:id/
 * lines|totals|decision|execution-scope`,
 * `POST /handyman/quotation-versions/:id/decision`) and the EXISTING
 * transactional-outbox notification producer
 * (`HANDYMAN_QUOTATION_ISSUED` / `_SUPERSEDED` / `_EXPIRED` → BE-26E in-app +
 * the durable outbound ledger).
 *
 * What is proven:
 *   - the authorized customer reads the CORRECT ISSUED version of a revised
 *     manual thread (the revision once issued, never the superseded
 *     predecessor and never an un-issued DRAFT), with its LABOR/MATERIAL
 *     lines, quantity, UOM reference, unit amounts, line totals, derived
 *     totals, DP terms and validity;
 *   - `MANUAL_ONE_TIME` provenance, governed reference snapshots, source
 *     items, actor ids and the internal triage/inspection/diagnosis text stay
 *     server-side: the customer payload is exactly the frozen allow-list;
 *   - a SUPERSEDED (or DRAFT) version can never be approved, the approval
 *     binds the revised version's money and DP, and the decision keeps its
 *     replay/conflict semantics for the PIC-personal actor;
 *   - Client/Building isolation is preserved on every read and on the
 *     decision;
 *   - notification happens for the SUCCESSFUL issuance only, once per
 *     occurrence, replay-safe, tenant-scoped, and a missing notification
 *     configuration never fails the quotation command.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import {
  closePool,
  initDatabase,
  migrateUp,
} from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestInspectionService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  HANDYMAN_DOMAIN_NOTIFICATION_FACTS,
  emitHandymanDomainNotificationIntent,
} from '../src/modules/handyman-notifications';
import { createNotificationTemplate } from '../src/modules/notification-templates';
import { notificationSubscriptionRepository } from '../src/modules/notification-subscriptions';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const PORT = 55579;
const DIR = '/tmp/asentra-handyman-quotation-manual-customer-pg';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

/** Internal strings that must NEVER reach a customer quotation payload. */
const INTERNAL_TRIAGE_NOTE =
  'Bespoke atrium rig needs a site survey before quoting.';
const INTERNAL_INSPECTION_NOTE =
  'Atrium anchor points verified on site; rig feasible.';
const INTERNAL_DIAGNOSIS =
  'Fabricate and install a one-off telescopic atrium rig.';

/** The frozen customer allow-lists of the quotation HTTP contract. */
const CUSTOMER_LINE_KEYS = [
  'createdAt',
  'currency',
  'description',
  'finalQuotedUnitAmount',
  'id',
  'lineTotal',
  'lineType',
  'quantity',
  'quotationVersionId',
  'uomId',
  'updatedAt',
];
const CUSTOMER_VERSION_KEYS = [
  'createdAt',
  'dpAmount',
  'dpPercentage',
  'dpRequired',
  'dpTermsNotes',
  'id',
  'quotationId',
  'status',
  'updatedAt',
  'validUntil',
  'versionNumber',
];
const CUSTOMER_DECISION_KEYS = [
  'clientId',
  'createdAt',
  'decidedAt',
  'decision',
  'id',
  'idempotencyKey',
  'quotationId',
  'quotationVersionId',
  'tenantCompanyId',
  'tenantPicId',
  'updatedAt',
];
/** Keys the customer reads must never carry (internal provenance/identity). */
const FORBIDDEN_KEYS = [
  'originKind',
  'referenceUnitAmount',
  'sourceItemId',
  'createdByUserId',
  'decidedByUserId',
  'decidedByCareActorId',
  'commercialConsentId',
  'requestFingerprint',
];

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';
const disciplineIds: Record<string, string> = {};

function db(): Pool {
  if (!pool) throw new Error('Test database pool not initialized');
  return pool;
}

async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db().query<T>(sql, params);
  return result.rows;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const auth = authHeader;

function requireDatabase(t: TestContext): boolean {
  if (!pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1',
      DB_PORT: String(PORT),
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'asentra_test',
      DB_SSL: 'false',
    });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const adminClient = postgres.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Manual customer-projection tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
  for (const code of ['GENERAL_HANDYMAN', 'MINOR_CIVIL']) {
    const discipline = await handymanDisciplineRepository.findDisciplineByCode(
      undefined,
      code,
    );
    if (!discipline) throw new Error(`Discipline seed missing: ${code}`);
    disciplineIds[code] = discipline.id;
  }
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

/** A user with the given permissions, Building access and a live session. */
async function createUserWithPermissionsAndBuildings(input: {
  displayName: string;
  permissionCodes: string[];
  buildingIds: string[];
}) {
  const tag = suffix();
  const email = `cp-user-${tag.toLowerCase()}@manual-customer.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName: input.displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  if (input.permissionCodes.length > 0) {
    const role = await roleService.createRole({ code: `CP_${tag}`, name: `Role ${tag}` });
    for (const code of input.permissionCodes) {
      let perm = await permissionRepository.findByCode(code);
      if (!perm) perm = await permissionService.createPermission({ code, name: code });
      await permissionService.assignPermissionToRole(role.id, perm.id);
    }
    await roleService.assignRoleToUser(user.id, role.id);
  }
  for (const buildingId of input.buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

type Fixture = Awaited<ReturnType<typeof createRealmFixture>>;

/**
 * One realm; `customer` is the ACTIVE Tenant PIC with its own platform session
 * (the customer's real authority shape: `tenant_company.read`/`manage` + exact
 * Building access + PIC linkage), `siblingCustomer` is permissioned but bound to
 * ANOTHER Building of the same Client, and `foreignCustomer` holds the
 * permissions with NO Building assignment.
 */
async function createRealmFixture() {
  const tag = suffix();
  const client = await clientService.createClient({ code: `CPCL_${tag}`, name: `Client ${tag}` });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `CPPR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `CPBL_${tag}`,
    name: `Building ${tag}`,
  });
  await db().query(`UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`, [building.id]);
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: property.id,
    code: `EPSB_${tag}`,
    name: `Sibling Building ${tag}`,
  });
  await db().query(`UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`, [
    siblingBuilding.id,
  ]);
  for (const buildingId of [building.id, siblingBuilding.id]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId });
  }
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `CPFL_${tag}`,
    name: 'Floor 1',
    levelNumber: 1,
  });
  const area = await areaService.createArea({ floorId: floor.id, code: `CPAR_${tag}`, name: 'Area 1' });
  const room = await roomService.createRoom({ areaId: area.id, code: `CPRM_${tag}`, name: 'Room 1' });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `CPSP_${tag}`,
    name: 'Unit 101',
  });
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `CPTC_${tag}`, tenantName: `Tenant ${tag}` },
    adminId,
  );
  await db().query(
    `UPDATE tenant_companies SET verification_status = 'VERIFIED' WHERE id = $1`,
    [company.id],
  );
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminId,
  );

  const customer = await createUserWithPermissionsAndBuildings({
    displayName: `Customer PIC ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [building.id],
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: `PIC ${tag}`,
      email: `pic-${tag.toLowerCase()}@tenant.test`,
      userId: customer.userId,
      isPrimary: true,
    },
    adminId,
  );
  const siblingCustomer = await createUserWithPermissionsAndBuildings({
    displayName: `Sibling Building Customer ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [siblingBuilding.id],
  });
  const foreignCustomer = await createUserWithPermissionsAndBuildings({
    displayName: `Foreign Customer ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [],
  });

  const uomId = randomUUID();
  await db().query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Lot', 'lot', 'OTHER')`,
    [uomId, client.id, `CPUOM_${tag}`],
  );
  const careUser = await createUserWithPermissionsAndBuildings({
    displayName: `Care Agent ${tag}`,
    permissionCodes: [HANDYMAN_CARE_BUILDING_PERMISSION],
    buildingIds: [building.id],
  });
  const opsWriter = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Coordinator ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [building.id],
  });

  return {
    tag,
    client,
    property,
    building,
    siblingBuilding,
    space,
    company,
    pic,
    customer,
    siblingCustomer,
    foreignCustomer,
    careUser,
    opsWriter,
    uomId,
  };
}

/** Verified Care-backend channel attribution + an untriaged intake case. */
async function insertCaseWithAttribution(
  f: Fixture,
  options: { idempotencyKey: string } = { idempotencyKey: 'k' },
) {
  const attributionId = randomUUID();
  // One verified Care attribution per case: (client, origin_channel,
  // origin_reference) is unique, so each thread needs its own reference.
  const originReference = `EXT-${f.tag}-${suffix()}`;
  await db().query(
    `INSERT INTO handyman_channel_attributions
       (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
        origin_channel, origin_reference, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'CUSTOMER_CARE_BACKEND', $7, $8)`,
    [
      attributionId,
      f.client.id,
      f.company.id,
      f.pic.id,
      f.building.id,
      f.space.id,
      originReference,
      f.careUser.userId,
    ],
  );
  const caseId = randomUUID();
  await db().query(
    `INSERT INTO handyman_unlisted_service_intake_cases
       (id, client_id, building_id, space_id, tenant_company_id, tenant_pic_id,
        approval_tenant_company_id, cost_responsible_tenant_company_id,
        channel_attribution_id, origin_channel, origin_reference,
        requested_service_name, description, status, created_by_user_id,
        idempotency_key, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CUSTOMER_CARE_BACKEND', $10,
             $11, $12, 'PENDING_TRIAGE', $13, $14, $15)`,
    [
      caseId,
      f.client.id,
      f.building.id,
      f.space.id,
      f.company.id,
      f.pic.id,
      f.company.id,
      f.company.id,
      attributionId,
      originReference,
      'Bespoke atrium ceiling rig',
      'Customer needs a bespoke 9 m atrium rig; no catalog service covers it.',
      f.careUser.userId,
      options.idempotencyKey,
      'a'.repeat(64),
    ],
  );
  return { caseId, attributionId };
}

/** Operations triage (0487) + formal conversion (0488) through the real lanes. */
async function triageAndConvert(f: Fixture, caseId: string, key: string) {
  const triageRes = await api()
    .post(`${V1}/handyman/operations/unlisted-intake-cases/${caseId}/triage-decisions`)
    .set(authHeader(f.opsWriter.token))
    .send({
      decision: 'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
      justification:
        'No catalog service or price rule can express a one-off atrium rig; Operations will quote manually after inspection.',
      manualQuoteSummary:
        'One-time fabrication and install of a telescopic ceiling rig for a 9 m atrium.',
      manualQuoteQuantity: 1,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-${key}`,
    });
  assert.equal(triageRes.status, 201, JSON.stringify(triageRes.body));
  const convertRes = await api()
    .post(`${V1}/handyman/operations/unlisted-intake-cases/${caseId}/service-request`)
    .set(authHeader(f.opsWriter.token))
    .send({ idempotencyKey: `conv-${key}` });
  assert.equal(convertRes.status, 201, JSON.stringify(convertRes.body));
  const conversion = convertRes.body.data.conversion as {
    requestId: string;
    intakeSource: string;
    serviceCatalogId: string | null;
  };
  assert.equal(conversion.intakeSource, 'UNLISTED_TRIAGE');
  assert.equal(conversion.serviceCatalogId, null);
  return { requestId: conversion.requestId };
}

function lineBody(overrides: Record<string, unknown> = {}) {
  return {
    lineType: 'LABOR',
    description: 'Telescopic atrium rig fabrication and install labor',
    quantity: 10,
    uomId: '',
    currency: 'IDR',
    finalQuotedUnitAmount: 150000,
    ...overrides,
  };
}

const MANUAL_LINES: Array<Record<string, unknown>> = [
  {
    lineType: 'LABOR',
    description: 'Atrium rig design, fabrication and install labor',
    quantity: 10,
    finalQuotedUnitAmount: 150000,
  },
  {
    lineType: 'MATERIAL',
    description: 'Structural steel, rigging hardware and deck panels',
    quantity: 2,
    finalQuotedUnitAmount: 750000,
  },
  {
    lineType: 'LABOR',
    description: 'Lobby protection and after-hours access supervision',
    quantity: 0.5,
    finalQuotedUnitAmount: 900000,
  },
];

/** The extra line a PART 03B revision adds: 4 x 250.000 = 1.000.000. */
const EXTRA_LINE = {
  lineType: 'MATERIAL',
  description: 'Additional rigging load test kit',
  quantity: 4,
  finalQuotedUnitAmount: 250000,
};

/**
 * A manual-origin thread on the real lanes: intake case -> Operations triage ->
 * converted request -> INSPECTION_REQUIRED -> INSPECTED -> diagnosis -> DRAFT
 * quotation v1 (with the given DP policy) -> the given lines. MANUAL_LINES
 * total 3.450.000 (labor 1.950.000 + material 1.500.000).
 */
async function manualThread(
  f: Fixture,
  key: string,
  options: { dp?: Record<string, unknown>; lines?: Array<Record<string, unknown>> } = {},
) {
  const { caseId } = await insertCaseWithAttribution(f, { idempotencyKey: `case-${key}` });
  const { requestId } = await triageAndConvert(f, caseId, key);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: requestId,
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: INTERNAL_TRIAGE_NOTE,
    },
    adminId,
  );
  await handymanServiceRequestInspectionService.recordHandymanInspection(
    {
      handymanRequestId: requestId,
      inspectionResult: 'INSPECTED',
      inspectionNotes: INTERNAL_INSPECTION_NOTE,
    },
    adminId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: requestId,
      disciplineId: disciplineIds.GENERAL_HANDYMAN,
      diagnosis: INTERNAL_DIAGNOSIS,
    },
    adminId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: requestId, ...(options.dp ?? {}) } as never,
    adminId,
  );
  const versionId = bundle.versions[0].id;
  for (const line of options.lines ?? []) {
    await addHandymanQuotationLine(
      versionId,
      { ...lineBody({ uomId: f.uomId }), ...line } as never,
      adminId,
    );
  }
  return {
    requestId,
    caseId,
    quotationId: bundle.quotation.id,
    versionId,
    bundle,
  };
}

/** A manual thread whose v1 is ISSUED and whose revision (v2) carries the
 * predecessor's lines and adds one more — then is ISSUED as well, superseding
 * v1. Returns every id the projection assertions need. */
async function issuedRevisionThread(f: Fixture, key: string, options: { issueV2?: boolean } = {}) {
  const thread = await manualThread(f, key, {
    dp: { dpRequired: true, dpPercentage: 20, dpTermsNotes: '20% down payment before fabrication.' },
    lines: MANUAL_LINES,
  });
  const issuedV1 = await issueHandymanQuotationVersion(
    thread.versionId,
    { validUntil: FUTURE() },
    adminId,
  );
  const revision = await createHandymanQuotationRevision(thread.quotationId, adminId);
  await addHandymanQuotationLine(
    revision.id,
    { ...lineBody({ uomId: f.uomId, ...EXTRA_LINE }) } as never,
    adminId,
  );
  let issuedV2: typeof revision | null = null;
  if (options.issueV2 !== false) {
    issuedV2 = await issueHandymanQuotationVersion(
      revision.id,
      { validUntil: FUTURE() },
      adminId,
    );
  }
  return { ...thread, issuedV1, revision, issuedV2 };
}

const FUTURE = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const QUOTATION = (requestId: string) => `${V1}/handyman/requests/${requestId}/quotation`;
const VERSION = (versionId: string) => `${V1}/handyman/quotation-versions/${versionId}`;

/** The notification CONFIG the reused chains need: one subscription + template
 * per (Client, event). Nothing is invented beyond the existing BE-26 seams. */
async function subscribe(params: {
  clientId: string;
  eventType: string;
  recipientUserId: string;
  channel: 'IN_APP' | 'EMAIL';
}) {
  const template = await createNotificationTemplate({
    key: `TPL_${suffix()}`,
    type: params.eventType,
    channel: params.channel,
    subject: `Kuotasi {{quotationId}}`,
    body: `Kuotasi {{quotationId}} telah diterbitkan untuk keputusan pelanggan.`,
  });
  await notificationSubscriptionRepository.create({
    key: `SUB_${suffix()}`,
    eventType: params.eventType,
    templateKey: template.key,
    recipientRule: { specs: [{ kind: 'USER', userId: params.recipientUserId }] },
    clientId: params.clientId,
  });
  return template;
}

async function inAppRows(entityId: string, eventType?: string) {
  return q<{
    id: string;
    client_id: string;
    recipient_user_id: string;
    source_event_type: string;
    source_entity_type: string;
    source_entity_id: string;
  }>(
    `SELECT id, client_id, recipient_user_id, source_event_type,
            source_entity_type, source_entity_id
       FROM notifications
      WHERE source_entity_id = $1
        AND ($2::text IS NULL OR source_event_type = $2)
      ORDER BY created_at ASC`,
    [entityId, eventType ?? null],
  );
}

async function ledgerRows(entityId: string, channel: string) {
  return q<{
    id: string;
    client_id: string;
    channel: string;
    source_event_type: string;
    idempotency_key: string;
  }>(
    `SELECT id, client_id, channel, source_event_type, idempotency_key
       FROM notification_outbound_deliveries
      WHERE source_entity_id = $1 AND channel = $2
      ORDER BY created_at ASC`,
    [entityId, channel],
  );
}

function assertNoInternalLeak(payload: unknown, label: string) {
  const text = JSON.stringify(payload);
  for (const key of FORBIDDEN_KEYS) {
    assert.ok(!text.includes(`"${key}"`), `${label} must not expose ${key}`);
  }
  for (const internal of [INTERNAL_TRIAGE_NOTE, INTERNAL_INSPECTION_NOTE, INTERNAL_DIAGNOSIS]) {
    assert.ok(!text.includes(internal), `${label} must not expose internal ${internal.slice(0, 24)}…`);
  }
}

describe('CR-HM-MANUAL-QUOTATION-01 PART 03C — customer quotation projection & notification', () => {
  it('the customer-presented read tracks the ISSUED revision, never the superseded predecessor or an un-issued DRAFT', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const f1 = await issuedRevisionThread(f, 'presented', { issueV2: false });

    // While v2 is still a DRAFT the customer keeps seeing v1: an un-issued
    // revision is never presented, and no DRAFT money is exposed as current.
    const duringDraft = await api()
      .get(`${QUOTATION(f1.requestId)}/presented`)
      .set(auth(f.customer.token));
    assert.equal(duringDraft.status, 200, JSON.stringify(duringDraft.body));
    assert.equal(duringDraft.body.data.id, f1.issuedV1.id);
    assert.equal(duringDraft.body.data.versionNumber, 1);
    assert.deepEqual(Object.keys(duringDraft.body.data).sort(), CUSTOMER_VERSION_KEYS);
    // v1 was issued with the 20% policy on a 3.450.000 total.
    assert.equal(duringDraft.body.data.dpRequired, true);
    assert.equal(duringDraft.body.data.dpPercentage, 20);
    assert.equal(duringDraft.body.data.dpAmount, 690000);
    assert.equal(duringDraft.body.data.dpTermsNotes, '20% down payment before fabrication.');
    assert.equal(
      new Date(duringDraft.body.data.validUntil).getTime() > Date.now(),
      true,
      'validity must be readable by the customer',
    );
    assertNoInternalLeak(duringDraft.body, 'the presented read (DRAFT in flight)');

    const f2 = await issuedRevisionThread(f, 'presented2');
    assert.ok(f2.issuedV2);
    const afterIssue = await api()
      .get(`${QUOTATION(f2.requestId)}/presented`)
      .set(auth(f.customer.token));
    assert.equal(afterIssue.status, 200, JSON.stringify(afterIssue.body));
    assert.equal(
      afterIssue.body.data.id,
      f2.issuedV2!.id,
      'the revised ISSUED version is now THE quotation the customer sees',
    );
    assert.equal(afterIssue.body.data.versionNumber, 2);
    // The DP the customer sees follows the REVISED total (20% of 4.450.000).
    assert.equal(afterIssue.body.data.dpPercentage, 20);
    assert.equal(afterIssue.body.data.dpAmount, 890000);
    assert.deepEqual(Object.keys(afterIssue.body.data).sort(), CUSTOMER_VERSION_KEYS);
    assertNoInternalLeak(afterIssue.body, 'the presented read (issued revision)');

    // The thread read still lists both versions with their true statuses, so the
    // superseded predecessor is visible as history and NEVER as the current one.
    const bundle = await api()
      .get(QUOTATION(f2.requestId))
      .set(auth(f.customer.token));
    assert.equal(bundle.status, 200, JSON.stringify(bundle.body));
    const byNumber = new Map(
      (bundle.body.data.versions as Array<{ versionNumber: number; status: string }>).map(
        (v) => [v.versionNumber, v.status],
      ),
    );
    assert.equal(byNumber.get(1), 'SUPERSEDED');
    assert.equal(byNumber.get(2), 'ISSUED');
    assertNoInternalLeak(bundle.body, 'the quotation thread read');
  });

  it('the customer line and totals reads expose every carried manual line and no internal provenance', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const f2 = await issuedRevisionThread(f, 'lines');
    assert.ok(f2.issuedV2);

    const linesRes = await api()
      .get(`${VERSION(f2.revision.id)}/lines`)
      .set(auth(f.customer.token));
    assert.equal(linesRes.status, 200, JSON.stringify(linesRes.body));
    const lines = linesRes.body.data as Array<Record<string, unknown>>;
    // 3 carried + 1 added: nothing lost, nothing duplicated by the revision.
    assert.equal(lines.length, 4);
    for (const line of lines) {
      assert.deepEqual(
        Object.keys(line).sort(),
        CUSTOMER_LINE_KEYS,
        'the customer line payload is exactly the frozen allow-list',
      );
    }
    const described = new Map(
      lines.map((line) => [String(line.description), line] as const),
    );
    for (const expected of MANUAL_LINES) {
      const carried = described.get(String(expected.description));
      assert.ok(carried, `carried line "${expected.description}" must be readable`);
      assert.equal(carried!.quantity, expected.quantity, 'quantity survives the revision');
      assert.equal(carried!.uomId, f.uomId, 'the UOM reference survives the revision');
      assert.equal(carried!.lineType, expected.lineType);
      assert.equal(
        carried!.finalQuotedUnitAmount,
        expected.finalQuotedUnitAmount,
        'the quoted unit amount survives the revision',
      );
      assert.equal(carried!.currency, 'IDR');
      assert.equal(
        Number(carried!.lineTotal),
        Number(expected.quantity) * Number(expected.finalQuotedUnitAmount),
        'lineTotal stays the server-derived product',
      );
    }
    const added = described.get(String(EXTRA_LINE.description));
    assert.ok(added, 'the added line is customer-visible on the same snapshot');
    assert.equal(added!.quantity, EXTRA_LINE.quantity);
    assertNoInternalLeak(linesRes.body, 'the customer line read');

    const totalsRes = await api()
      .get(`${VERSION(f2.revision.id)}/totals`)
      .set(auth(f.customer.token));
    assert.equal(totalsRes.status, 200, JSON.stringify(totalsRes.body));
    assert.deepEqual(totalsRes.body.data, {
      laborSubtotal: 1950000,
      materialSubtotal: 2500000,
      total: 4450000,
      currency: 'IDR',
      lineCount: 4,
    });
    // The customer's own arithmetic must close: the presented total is the sum
    // of the presented line totals (no silent gap between line and total).
    const sum = lines.reduce((acc, line) => acc + Number(line.lineTotal), 0);
    assert.equal(sum, totalsRes.body.data.total);
    // The superseded predecessor keeps its own snapshot (3 lines, 3.450.000).
    const priorTotals = await api()
      .get(`${VERSION(f2.versionId)}/totals`)
      .set(auth(f.customer.token));
    assert.equal(priorTotals.body.data.total, 3450000);
    assert.equal(priorTotals.body.data.lineCount, 3);
  });

  it('a DRAFT revision and a superseded version can never be approved as the current quotation', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const f2 = await issuedRevisionThread(f, 'no-stale-approval', { issueV2: false });

    const draftApproval = await api()
      .post(`${VERSION(f2.revision.id)}/decision`)
      .set(auth(f.customer.token))
      .set('Idempotency-Key', `draft-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(draftApproval.status, 400, JSON.stringify(draftApproval.body));
    assert.equal(
      draftApproval.body.error.code,
      'HANDYMAN_QUOTATION_INVALID_TRANSITION',
      'only an ISSUED version is decidable',
    );

    // Issuing v2 supersedes v1 — v1 can then never be approved as current.
    await issueHandymanQuotationVersion(f2.revision.id, { validUntil: FUTURE() }, adminId);
    const staleApproval = await api()
      .post(`${VERSION(f2.versionId)}/decision`)
      .set(auth(f.customer.token))
      .set('Idempotency-Key', `stale-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(staleApproval.status, 400, JSON.stringify(staleApproval.body));
    assert.equal(
      staleApproval.body.error.code,
      'HANDYMAN_QUOTATION_INVALID_TRANSITION',
      'a SUPERSEDED version is not a current quotation',
    );
    const decisionRows = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM handyman_quotation_decisions
        WHERE quotation_version_id IN ($1, $2)`,
      [f2.versionId, f2.revision.id],
    );
    assert.equal(decisionRows[0].n, '0', 'a refused decision leaves no receipt behind');
    const statusRows = await q<{ status: string }>(
      `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
      [f2.versionId],
    );
    assert.equal(statusRows[0].status, 'SUPERSEDED', 'the refusal did not mutate the version');

    // A never-issued thread presents NOTHING.
    const unissued = await manualThread(f, 'unissued', { lines: MANUAL_LINES });
    const presented = await api()
      .get(`${QUOTATION(unissued.requestId)}/presented`)
      .set(auth(f.customer.token));
    assert.equal(presented.status, 200, JSON.stringify(presented.body));
    assert.equal(presented.body.data, null, 'a DRAFT is never customer-presentable');
  });

  it('the approval binds the revised version and its DP, stays idempotent, and refuses a conflicting replay', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const f2 = await issuedRevisionThread(f, 'approval');
    assert.ok(f2.issuedV2);
    const key = `approve-${randomUUID()}`;

    const approved = await api()
      .post(`${VERSION(f2.revision.id)}/decision`)
      .set(auth(f.customer.token))
      .set('Idempotency-Key', key)
      .send({ decision: 'APPROVE' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.decision, 'APPROVE');
    assert.equal(
      approved.body.data.quotationVersionId,
      f2.revision.id,
      'the consent binds the REVISED version, not the predecessor',
    );
    assert.equal(
      approved.body.data.executionScope.approvedQuotationVersionId,
      f2.revision.id,
    );
    // The money the customer consented to is the revised total + inherited DP.
    const versionRow = await q<{
      status: string;
      dp_percentage: string;
      dp_amount: string;
    }>(
      `SELECT status, dp_percentage::text AS dp_percentage, dp_amount::text AS dp_amount
         FROM handyman_quotation_versions WHERE id = $1`,
      [f2.revision.id],
    );
    assert.equal(versionRow[0].status, 'APPROVED');
    assert.equal(versionRow[0].dp_percentage, '20.00');
    assert.equal(versionRow[0].dp_amount, '890000.00');

    // Replay with the SAME key returns the original receipt, adds nothing.
    const replay = await api()
      .post(`${VERSION(f2.revision.id)}/decision`)
      .set(auth(f.customer.token))
      .set('Idempotency-Key', key)
      .send({ decision: 'APPROVE' });
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, approved.body.data.id);
    const afterReplay = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM handyman_quotation_decisions WHERE quotation_version_id = $1`,
      [f2.revision.id],
    );
    assert.equal(afterReplay[0].n, '1', 'one authoritative decision per version, ever');

    // A different key on an already-decided version is a conflict, never a
    // second consent.
    const conflict = await api()
      .post(`${VERSION(f2.revision.id)}/decision`)
      .set(auth(f.customer.token))
      .set('Idempotency-Key', `other-${randomUUID()}`)
      .send({ decision: 'REJECT' });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');

    // The customer decision read is the internal-identity-free projection,
    // while the approved scope read stays bounded to the approved version.
    const decisionRead = await api()
      .get(`${VERSION(f2.revision.id)}/decision`)
      .set(auth(f.customer.token));
    assert.equal(decisionRead.status, 200, JSON.stringify(decisionRead.body));
    assert.deepEqual(
      Object.keys(decisionRead.body.data).sort(),
      CUSTOMER_DECISION_KEYS,
      'the decision read carries the receipt, not internal actor identity',
    );
    assertNoInternalLeak(decisionRead.body, 'the customer decision read');
    const scopeRead = await api()
      .get(`${VERSION(f2.revision.id)}/execution-scope`)
      .set(auth(f.customer.token));
    assert.equal(scopeRead.status, 200, JSON.stringify(scopeRead.body));
    assert.equal(scopeRead.body.data.approvedQuotationVersionId, f2.revision.id);
    assert.equal(scopeRead.body.data.status, 'AUTHORIZED');
    // The predecessor stays SUPERSEDED forever: an approval never forked it.
    const priorRow = await q<{ status: string }>(
      `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
      [f2.versionId],
    );
    assert.equal(priorRow[0].status, 'SUPERSEDED');
  });

  it('customer quotation reads and decisions stay Building- and Client-isolated', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const f2 = await issuedRevisionThread(f, 'isolation');
    for (const intruder of [f.siblingCustomer, f.foreignCustomer]) {
      const presented = await api()
        .get(`${QUOTATION(f2.requestId)}/presented`)
        .set(auth(intruder.token));
      assert.equal(presented.status, 403, `${intruder.userId} must not read the thread`);
      assert.equal(presented.body.error.code, 'BUILDING_ACCESS_DENIED');
      assert.equal(presented.body.data, undefined, 'no version may leak');

      const lines = await api()
        .get(`${VERSION(f2.revision.id)}/lines`)
        .set(auth(intruder.token));
      assert.equal(lines.status, 403);
      assert.equal(lines.body.error.code, 'BUILDING_ACCESS_DENIED');
      assert.equal(lines.body.data, undefined, 'no line may leak');

      const totals = await api()
        .get(`${VERSION(f2.revision.id)}/totals`)
        .set(auth(intruder.token));
      assert.equal(totals.status, 403);
      assert.equal(totals.body.data, undefined, 'no total may leak');

      const hijack = await api()
        .post(`${VERSION(f2.revision.id)}/decision`)
        .set(auth(intruder.token))
        .set('Idempotency-Key', `hijack-${randomUUID()}`)
        .send({ decision: 'APPROVE' });
      assert.equal(hijack.status, 403, JSON.stringify(hijack.body));
      // The Building trace runs FIRST, so an out-of-scope actor is refused
      // exactly like an unknown thread (no existence leak, no PIC probing).
      assert.equal(hijack.body.error.code, 'BUILDING_ACCESS_DENIED');
    }
    const receiptsBefore = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM handyman_quotation_decisions WHERE quotation_version_id = $1`,
      [f2.revision.id],
    );
    assert.equal(receiptsBefore[0].n, '0', 'a denied decision writes nothing');
    // An actor INSIDE the Building who is not the request's Tenant PIC still
    // cannot consent on the customer's behalf: no delegation record exists.
    const nonPic = await api()
      .post(`${VERSION(f2.revision.id)}/decision`)
      .set(auth(f.opsWriter.token))
      .set('Idempotency-Key', `nonpic-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(nonPic.status, 403, JSON.stringify(nonPic.body));
    assert.equal(
      nonPic.body.error.code,
      'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN',
      'only the designated Tenant PIC of the request may decide',
    );
    const receipts = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM handyman_quotation_decisions WHERE quotation_version_id = $1`,
      [f2.revision.id],
    );
    assert.equal(receipts[0].n, '0');
  });

  it('issuance of a manual revision notifies once per occurrence, tenant-scoped and replay-safe', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    await subscribe({
      clientId: f.client.id,
      eventType: 'HANDYMAN_QUOTATION_ISSUED',
      recipientUserId: f.customer.userId,
      channel: 'IN_APP',
    });
    await subscribe({
      clientId: f.client.id,
      eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
      recipientUserId: f.customer.userId,
      channel: 'IN_APP',
    });

    const thread = await manualThread(f, 'notify', {
      dp: { dpRequired: true, dpPercentage: 20 },
      lines: MANUAL_LINES,
    });
    // A DRAFT alone notifies nobody: the notification REACTS to issuance.
    assert.equal((await inAppRows(thread.versionId)).length, 0);

    await issueHandymanQuotationVersion(thread.versionId, { validUntil: FUTURE() }, adminId);
    const firstRound = await inAppRows(thread.versionId, 'HANDYMAN_QUOTATION_ISSUED');
    assert.equal(firstRound.length, 1, 'one in-app record for one issuance');
    assert.equal(firstRound[0].source_entity_type, 'HANDYMAN_QUOTATION_VERSION');
    assert.equal(firstRound[0].client_id, f.client.id, 'the tenant of the FACT');
    assert.equal(firstRound[0].recipient_user_id, f.customer.userId);
    // No outbound channel is subscribed here, so the reused chains write no
    // durable intent: the quotation lane invents no delivery of its own.
    assert.equal((await ledgerRows(thread.versionId, 'EMAIL')).length, 0);

    // The revision, once issued, notifies for ITS OWN occurrence and the
    // superseded predecessor gets its own supersession notice.
    const revision = await createHandymanQuotationRevision(thread.quotationId, adminId);
    await addHandymanQuotationLine(
      revision.id,
      { ...lineBody({ uomId: f.uomId, ...EXTRA_LINE }) } as never,
      adminId,
    );
    await issueHandymanQuotationVersion(revision.id, { validUntil: FUTURE() }, adminId);
    assert.equal(
      (await inAppRows(revision.id, 'HANDYMAN_QUOTATION_ISSUED')).length,
      1,
      'the revised ISSUED version is notified as its own occurrence',
    );
    assert.equal(
      (await inAppRows(thread.versionId, 'HANDYMAN_QUOTATION_ISSUED')).length,
      1,
      'the predecessor is not re-notified',
    );
    assert.equal(
      (await inAppRows(thread.versionId, 'HANDYMAN_QUOTATION_SUPERSEDED')).length,
      1,
      'the supersession is notified on the SUPERSEDED version',
    );

    // The safe replay a customer-facing lane actually faces: re-issuing an
    // already-issued version is refused by the state machine, so no second
    // notification can be produced for the same fact.
    await assert.rejects(
      () => issueHandymanQuotationVersion(thread.versionId, { validUntil: FUTURE() }, adminId),
    );
    assert.equal(
      (await inAppRows(thread.versionId, 'HANDYMAN_QUOTATION_ISSUED')).length,
      1,
      'no notification without a successfully issued quotation',
    );

    // Durable-intent replay: with an outbound channel subscribed, the ledger is
    // keyed by (event, occurrence, channel, recipient, template), so a producer
    // re-running for an occurrence that already produced its intent creates
    // NOTHING new — the reused idempotent seam returns the existing row.
    await subscribe({
      clientId: f.client.id,
      eventType: 'HANDYMAN_QUOTATION_ISSUED',
      recipientUserId: f.customer.userId,
      channel: 'EMAIL',
    });
    const second = await manualThread(f, 'notify2', { lines: MANUAL_LINES });
    await issueHandymanQuotationVersion(second.versionId, { validUntil: FUTURE() }, adminId);
    const ledgerBefore = await ledgerRows(second.versionId, 'EMAIL');
    assert.equal(ledgerBefore.length, 1, 'one durable outbound intent per issuance');
    const replay = await emitHandymanDomainNotificationIntent(
      {
        eventType: 'HANDYMAN_QUOTATION_ISSUED',
        clientId: f.client.id,
        entityId: second.versionId,
        variables: { quotationId: second.quotationId, quotationVersionId: second.versionId },
      },
      {},
    );
    assert.equal(replay.emitted, true);
    assert.equal(replay.outbound?.deliveriesCreated, 0, 'a replayed intent inserts nothing');
    assert.equal(replay.outbound?.duplicatesSuppressed, 1, 'and is observable as suppressed');
    const ledgerAfter = await ledgerRows(second.versionId, 'EMAIL');
    assert.equal(ledgerAfter.length, 1);
    assert.equal(ledgerAfter[0].idempotency_key, ledgerBefore[0].idempotency_key);
  });

  it('a missing notification configuration never fails the issuance, and no delivery engine is invented', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    // NO subscription and NO template for this Client: the reused chains simply
    // resolve zero recipients. The quotation fact still commits, un-notified.
    const thread = await manualThread(f, 'unconfigured', { lines: MANUAL_LINES });
    const issued = await issueHandymanQuotationVersion(
      thread.versionId,
      { validUntil: FUTURE() },
      adminId,
    );
    assert.equal(issued.status, 'ISSUED');
    assert.equal((await inAppRows(thread.versionId)).length, 0);
    assert.equal((await ledgerRows(thread.versionId, 'EMAIL')).length, 0);
    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM operational_events
            WHERE entity_id = $1 AND event_type = 'HANDYMAN_QUOTATION_ISSUED'`,
          [thread.versionId],
        )
      )[0].n,
      '1',
      'the operational journal of the issuance is independent of delivery',
    );

    // The exact GAP this PART must not close by building anything: the produced
    // quotation vocabulary is issuance / supersession / expiry ONLY. There is no
    // approved/rejected notification event, so the customer's DECISION outcome
    // reaches Operations through the operational journal and the commercial
    // inbox, never through a notification. And no email/WhatsApp provider is
    // wired here: the outbound ledger is an intent owned by the reused chain.
    const producedEvents = Object.keys(HANDYMAN_DOMAIN_NOTIFICATION_FACTS);
    assert.deepEqual(
      producedEvents.filter((event) => event.startsWith('HANDYMAN_QUOTATION_')),
      ['HANDYMAN_QUOTATION_ISSUED', 'HANDYMAN_QUOTATION_SUPERSEDED', 'HANDYMAN_QUOTATION_EXPIRED'],
    );
    const decisionNotifications = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications
        WHERE source_event_type IN ('HANDYMAN_QUOTATION_APPROVED', 'HANDYMAN_QUOTATION_REJECTED')`,
    );
    assert.equal(decisionNotifications[0].n, '0');
  });
});
