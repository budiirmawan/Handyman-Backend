/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 03B focused validation.
 *
 * QUOTATION REVISION & DP for a manual-origin (unlisted-intake) thread, after
 * inspection and BEFORE customer approval:
 *
 *   - a revision appends a new DRAFT version that carries the predecessor's
 *     immutable LABOR/MATERIAL lines forward verbatim (quantities, UOM, origin
 *     (0489), governed reference snapshot, currency and quoted amounts), so a
 *     revision can no longer silently lose the manual quotation or its totals;
 *   - `carryForwardLineIds` is the authorized selection that decides which
 *     lines survive — removal by omission, never by deletion — while additions
 *     keep using the existing DRAFT line API; smuggling, repeats, foreign
 *     references and use on the catalog lane are refused;
 *   - DP terms are inherited from the relevant previous version instead of
 *     being reset: a percentage policy re-derives its amount against the REVISED
 *     total through the existing issue-time authority (with the existing
 *     rounding rules), while a deliberate fixed dpAmount is preserved verbatim;
 *   - one APPROVED version closes ordinary revisioning (no fork of a consented
 *     quotation, no self-approval by Operations), issue still SUPERSEDES the
 *     previous ISSUED version so approval always binds the latest eligible
 *     version, and the catalog lane behaves exactly as before.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import {
  closePool,
  initDatabase,
  migrateUp,
  withTransaction,
} from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
import {
  handymanDisciplineRepository,
} from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestInspectionService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  decideHandymanQuotation,
  getCurrentHandymanIssuedQuotationVersion,
  getHandymanQuotation,
  getHandymanQuotationVersionTotals,
  issueHandymanQuotationVersion,
  listHandymanQuotationVersionLines,
} from '../src/modules/handyman-quotations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
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
const PORT = 55577;
const DIR = '/tmp/asentra-handyman-quotation-manual-revision-pg';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';
let disciplineIds: Record<string, string> = {};

function db(): Pool {
  if (!pool) throw new Error('Test database pool not initialized');
  return pool;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorMessage(error: unknown): string {
  const e = error as { message?: string; details?: unknown };
  return `${e.message ?? String(error)} ${JSON.stringify(e.details ?? '')}`;
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
  assert.ok(config, 'Manual quotation-line tests require PostgreSQL');
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

function requireDatabase(t: TestContext): boolean {
  if (!pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function createUserWithPermissionsAndBuildings(input: {
  displayName: string;
  permissionCodes: string[];
  buildingIds: string[];
}) {
  const tag = suffix();
  const email = `mr-user-${tag.toLowerCase()}@manual-revision.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName: input.displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  if (input.permissionCodes.length > 0) {
    const role = await roleService.createRole({ code: `MR_${tag}`, name: `Role ${tag}` });
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
 * One realm with two Buildings: `building` is the manual-origin lane's scope,
 * `siblingBuilding` hosts an authorized same-Client actor whose assignment
 * must NOT grant cross-Building quotation rights (BE-02G).
 */
async function createRealmFixture() {
  const tag = suffix();
  const client = await clientService.createClient({ code: `MQCL_${tag}`, name: `Client ${tag}` });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `MQPR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `MQBL_${tag}`,
    name: `Building ${tag}`,
  });
  await db().query(`UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`, [building.id]);
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: property.id,
    code: `MQSB_${tag}`,
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
    code: `MQFL_${tag}`,
    name: 'Floor 1',
    levelNumber: 1,
  });
  const area = await areaService.createArea({ floorId: floor.id, code: `MQAR_${tag}`, name: 'Area 1' });
  const room = await roomService.createRoom({ areaId: area.id, code: `MQRM_${tag}`, name: 'Room 1' });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `MQSP_${tag}`,
    name: 'Unit 101',
  });
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `MQTC_${tag}`, tenantName: `Tenant ${tag}` },
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
  const customerUser = await userService.createUser({
    email: `mq-pic-${tag.toLowerCase()}@tenant.test`,
    displayName: 'Customer PIC',
  });
  await buildingAssignmentService.createAssignment(customerUser.id, { buildingId: building.id });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: `PIC ${tag}`,
      email: `pic-${tag.toLowerCase()}@tenant.test`,
      userId: customerUser.id,
      isPrimary: true,
    },
    adminId,
  );
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `MQSVC_${tag}`,
      name: 'Standard Catalog Service',
      category: 'HANDYMAN',
    },
    adminId,
  );
  const uomId = randomUUID();
  await db().query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Lot', 'lot', 'OTHER')`,
    [uomId, client.id, `MUOM_${tag}`],
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
  const opsReader = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Reader ${tag}`,
    permissionCodes: ['service_request.read'],
    buildingIds: [building.id],
  });
  const foreignOpsWriter = await createUserWithPermissionsAndBuildings({
    displayName: `Sibling Ops Coordinator ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [siblingBuilding.id],
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
    customerUser,
    service,
    uomId,
    careUser,
    opsWriter,
    opsReader,
    foreignOpsWriter,
  };
}

/** Verified Care-backend channel attribution + an untriaged intake case. */
async function insertCaseWithAttribution(
  f: Fixture,
  options: { idempotencyKey: string; description?: string } = { idempotencyKey: 'k' },
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
      options.description ??
        'Customer needs a bespoke 9 m atrium rig; no catalog service covers it.',
      f.careUser.userId,
      options.idempotencyKey,
      'a'.repeat(64),
    ],
  );
  return { caseId, attributionId };
}

/** Operations triage (0487) + formal conversion (0488) through the real lanes. */
async function triageAndConvert(
  f: Fixture,
  caseId: string,
  key: string,
): Promise<{ requestId: string; channelAttributionId: string | null }> {
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
    channelAttributionId: string | null;
    serviceCatalogId: string | null;
    intakeSource: string;
  };
  assert.equal(conversion.intakeSource, 'UNLISTED_TRIAGE');
  assert.equal(conversion.serviceCatalogId, null);
  return {
    requestId: conversion.requestId,
    channelAttributionId: conversion.channelAttributionId,
  };
}

/** A manual-origin request, triaged to inspection and inspected/diagnosed by
 * the existing CR-HM-03 authorities (nothing new is invented here). */
async function quotableManualRequest(
  f: Fixture,
  key: string,
  options: { inspection?: boolean; diagnosis?: 'service' | 'sql' | 'none' } = {},
): Promise<{
  requestId: string;
  caseId: string;
  attributionId: string;
  quoteVersionId: string;
}> {
  const { caseId, attributionId } = await insertCaseWithAttribution(f, {
    idempotencyKey: `case-${key}`,
  });
  const { requestId } = await triageAndConvert(f, caseId, key);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: requestId,
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: 'Bespoke atrium rig needs a site survey before quoting.',
    },
    adminId,
  );
  if (options.inspection !== false) {
    await handymanServiceRequestInspectionService.recordHandymanInspection(
      {
        handymanRequestId: requestId,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Atrium anchor points verified on site; rig feasible.',
      },
      adminId,
    );
  }
  if (options.diagnosis === 'sql') {
    await db().query(
      `INSERT INTO handyman_request_diagnoses
         (id, client_id, handyman_request_id, channel_attribution_id,
          building_id, handyman_discipline_id, discipline_code, diagnosis,
          scope_classification, recommended_service_catalog_id,
          diagnosed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'GENERAL_HANDYMAN',
               'Fabricate and install a one-off telescopic atrium rig.',
               'GENERAL_HANDYMAN', NULL, $7)`,
      [
        randomUUID(),
        f.client.id,
        requestId,
        attributionId,
        f.building.id,
        disciplineIds.GENERAL_HANDYMAN,
        adminId,
      ],
    );
  } else if (options.diagnosis === 'service') {
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: requestId,
        disciplineId: disciplineIds.GENERAL_HANDYMAN,
        diagnosis: 'Fabricate and install a one-off telescopic atrium rig.',
      },
      adminId,
    );
  }
  const bundle = await createHandymanQuotation({ handymanRequestId: requestId }, adminId);
  return {
    requestId,
    caseId,
    attributionId,
    quoteVersionId: bundle.versions[0].id,
  };
}

async function lineTotals(versionId: string) {
  return getHandymanQuotationVersionTotals(versionId, adminId);
}

async function originsOf(versionId: string): Promise<string[]> {
  const rows = await db().query(
    `SELECT origin_kind FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 ORDER BY created_at, id`,
    [versionId],
  );
  return rows.rows.map((r) => r.origin_kind as string);
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
/** The commercial facts a carried line must reproduce exactly. */
function snapshotOf(line: {
  lineType: string;
  description: string;
  quantity: number;
  uomId: string;
  currency: string;
  finalQuotedUnitAmount: number;
  lineTotal: number;
  referenceUnitAmount: number | null;
  sourceItemId: string | null;
  originKind: string;
}) {
  return {
    lineType: line.lineType,
    description: line.description,
    quantity: line.quantity,
    uomId: line.uomId,
    currency: line.currency,
    finalQuotedUnitAmount: line.finalQuotedUnitAmount,
    lineTotal: line.lineTotal,
    referenceUnitAmount: line.referenceUnitAmount,
    sourceItemId: line.sourceItemId,
    originKind: line.originKind,
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

/**
 * A manual-origin thread on the real lanes: triaged intake case -> converted
 * request -> inspection required -> INSPECTED -> diagnosis -> DRAFT quotation
 * (with optional DP terms) -> the given lines. Totals for MANUAL_LINES:
 * labor 1.950.000 + material 1.500.000 = 3.450.000.
 */
async function manualThread(
  f: Fixture,
  key: string,
  options: {
    dp?: Record<string, unknown>;
    lines?: Array<Record<string, unknown>>;
  } = {},
) {
  const { caseId } = await insertCaseWithAttribution(f, {
    idempotencyKey: `case-${key}`,
  });
  const { requestId } = await triageAndConvert(f, caseId, key);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: requestId,
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: 'Bespoke atrium rig needs a site survey before quoting.',
    },
    adminId,
  );
  await handymanServiceRequestInspectionService.recordHandymanInspection(
    {
      handymanRequestId: requestId,
      inspectionResult: 'INSPECTED',
      inspectionNotes: 'Atrium anchor points verified on site; rig feasible.',
    },
    adminId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: requestId,
      disciplineId: disciplineIds.GENERAL_HANDYMAN,
      diagnosis: 'Fabricate and install a one-off telescopic atrium rig.',
    },
    adminId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: requestId, ...(options.dp ?? {}), } as never,
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

/** A catalog-lane thread (unchanged lane: items re-derive its lines). */
async function catalogThread(
  f: Fixture,
  options: { dp?: Record<string, unknown>; withLine?: boolean } = {},
) {
  const attributionId = randomUUID();
  await db().query(
    `INSERT INTO handyman_channel_attributions
       (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
        origin_channel, origin_reference, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'BM_SUPER_APP', $7, $8)`,
    [
      attributionId,
      f.client.id,
      f.company.id,
      f.pic.id,
      f.building.id,
      f.space.id,
      `bm-handoff:${randomUUID()}`,
      f.customerUser.id,
    ],
  );
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      { channelAttributionId: attributionId, serviceCatalogId: f.service.id },
      adminId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis for the catalog revision probe.',
    },
    adminId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId: disciplineIds.GENERAL_HANDYMAN,
      diagnosis: 'Standard catalog work with a governed price.',
    },
    adminId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id, ...(options.dp ?? {}), } as never,
    adminId,
  );
  const versionId = bundle.versions[0].id;
  if (options.withLine !== false) {
    await addHandymanQuotationLine(
      versionId,
      { ...lineBody({ uomId: f.uomId, description: 'Standard catalog labor' }) },
      adminId,
    );
  }
  return { requestId: request.id, quotationId: bundle.quotation.id, versionId };
}

const FUTURE = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

describe('CR-HM-MANUAL-QUOTATION-01 PART 03B — manual quotation revision & DP', () => {
  it('carries every manual line forward verbatim into the new DRAFT without touching the predecessor', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await manualThread(f, 'carry', { lines: MANUAL_LINES });

    const revision = await createHandymanQuotationRevision(
      thread.quotationId,
      adminId,
    );
    assert.equal(revision.versionNumber, 2);
    assert.equal(revision.status, 'DRAFT');

    const before = await listHandymanQuotationVersionLines(thread.versionId, adminId);
    const after = await listHandymanQuotationVersionLines(revision.id, adminId);
    assert.equal(before.length, 3);
    assert.equal(after.length, 3, 'a revision must NOT silently lose manual lines');
    // Line order inside a version is (created_at, id) and same-transaction
    // rows tie on created_at, so the contract is the SET of commercial
    // snapshots - compared here after a stable sort on the description.
    const byDescription = (a: { description: string }, b: { description: string }) =>
      a.description.localeCompare(b.description);
    assert.deepEqual(
      [...after].sort(byDescription).map(snapshotOf),
      [...before].sort(byDescription).map(snapshotOf),
    );
    assert.deepEqual(
      after.map((l) => l.originKind),
      ['MANUAL_ONE_TIME', 'MANUAL_ONE_TIME', 'MANUAL_ONE_TIME'],
      '0489 origin provenance survives the revision',
    );
    for (const carried of after) {
      assert.equal(carried.quotationVersionId, revision.id);
      assert.ok(!before.some((l) => l.id === carried.id), 'copies are new immutable rows');
    }
    const totalsBefore = await lineTotals(thread.versionId);
    const totalsAfter = await lineTotals(revision.id);
    assert.deepEqual(totalsAfter, totalsBefore, 'totals are neither lost nor doubled');
    assert.equal(totalsAfter.total, 3450000);

    // The predecessor stays exactly as it was, and the audit explains the copy.
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotation_lines
            WHERE quotation_version_id = $1`,
          [thread.versionId],
        )
      ).rows[0].n,
      3,
    );
    const event = await db().query(
      `SELECT metadata FROM operational_events
        WHERE event_type = 'HANDYMAN_QUOTATION_VERSION_CREATED'
          AND metadata->>'sourceVersionId' = $1
          AND metadata->>'sourceVersionNumber' = '1'
        ORDER BY created_at DESC LIMIT 1`,
      [thread.versionId],
    );
    const meta = event.rows[0].metadata as Record<string, unknown>;
    assert.equal(meta.sourceVersionNumber, 1);
    assert.equal((meta.carriedForwardLineIds as string[]).length, 3);
    assert.equal(meta.omittedCarryForwardLineCount, 0);
    assert.equal(meta.dpTermsInherited, false, 'this thread declared no DP at all');
    const createdBy = await db().query(
      `SELECT DISTINCT created_by_user_id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1`,
      [revision.id],
    );
    assert.deepEqual(createdBy.rows.map((r) => r.created_by_user_id), [adminId]);
  });

  it('inherits a percentage DP policy and re-derives it against the revised total', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await manualThread(f, 'dp-pct', {
      dp: { dpRequired: true, dpPercentage: 20, dpTermsNotes: '30% on approval is not offered; 20% down.' },
      lines: MANUAL_LINES,
    });
    const v1 = (await getHandymanQuotation(thread.requestId, adminId)).versions[0];
    assert.equal(v1.dpRequired, true);
    assert.equal(v1.dpPercentage, 20);
    assert.equal(v1.dpAmount, null, 'a percentage policy stores no amount at DRAFT');

    const revision = await createHandymanQuotationRevision(
      thread.quotationId,
      adminId,
    );
    assert.equal(revision.dpRequired, true, 'DP must survive a revision');
    assert.equal(revision.dpPercentage, 20);
    assert.equal(revision.dpAmount, null);
    assert.equal(revision.dpTermsNotes, '30% on approval is not offered; 20% down.');

    // The revised scope grows: the DP amount follows the REVISED total, not the
    // predecessor's money (20% of 3.450.000 + 1.000.000 = 890.000).
    await addHandymanQuotationLine(
      revision.id,
      {
        ...lineBody({
          uomId: f.uomId,
          lineType: 'MATERIAL',
          description: 'Additional rigging load test kit',
          quantity: 4,
          finalQuotedUnitAmount: 250000,
        }),
      },
      adminId,
    );
    const issued = await issueHandymanQuotationVersion(
      revision.id,
      { validUntil: FUTURE() },
      adminId,
    );
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.dpPercentage, 20);
    assert.equal(issued.dpAmount, 890000);
    assert.equal((await lineTotals(revision.id)).total, 4450000);
  });

  it('preserves a deliberate fixed DP amount and re-derives only its ratio', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await manualThread(f, 'dp-fixed', {
      dp: { dpRequired: true, dpAmount: 500000, dpTermsNotes: 'Fixed down payment agreed with the tenant.' },
      lines: MANUAL_LINES,
    });
    const issuedV1 = await issueHandymanQuotationVersion(
      thread.versionId,
      { validUntil: FUTURE() },
      adminId,
    );
    assert.equal(issuedV1.dpAmount, 500000);
    assert.equal(issuedV1.dpPercentage, 14.49);

    const revision = await createHandymanQuotationRevision(
      thread.quotationId,
      adminId,
    );
    assert.equal(revision.dpAmount, 500000, 'the fixed policy is carried verbatim');
    assert.equal(
      revision.dpPercentage,
      null,
      'the stale derived ratio is NOT carried: it would contradict the new total',
    );

    await addHandymanQuotationLine(
      revision.id,
      {
        ...lineBody({
          uomId: f.uomId,
          lineType: 'MATERIAL',
          description: 'Additional rigging load test kit',
          quantity: 4,
          finalQuotedUnitAmount: 250000,
        }),
      },
      adminId,
    );
    const issuedV2 = await issueHandymanQuotationVersion(
      revision.id,
      { validUntil: FUTURE() },
      adminId,
    );
    assert.equal(issuedV2.dpAmount, 500000);
    assert.equal(issuedV2.dpPercentage, 11.24);
    assert.equal(issuedV2.status, 'ISSUED');
    // Issuing the replacement supersedes the previous ISSUED version, so the
    // customer can only ever consent the latest eligible one.
    const v1After = await db().query(
      `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
      [thread.versionId],
    );
    assert.equal(v1After.rows[0].status, 'SUPERSEDED');
    assert.equal(
      (await getCurrentHandymanIssuedQuotationVersion(thread.requestId, adminId))?.id,
      revision.id,
    );
  });

  it('removes by omission through the authorized selection and never deletes a line', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await manualThread(f, 'omit', { lines: MANUAL_LINES });
    const prior = await listHandymanQuotationVersionLines(thread.versionId, adminId);

    // Keep only the middle line: the removal mechanism is the snapshot itself.
    const revision = await createHandymanQuotationRevision(
      thread.quotationId,
      adminId,
      undefined,
      { carryForwardLineIds: [prior[1].id] },
    );
    const carried = await listHandymanQuotationVersionLines(revision.id, adminId);
    assert.equal(carried.length, 1);
    assert.deepEqual(snapshotOf(carried[0]), snapshotOf(prior[1]));
    assert.equal(carried[0].originKind, 'MANUAL_ONE_TIME');
    assert.equal((await lineTotals(revision.id)).total, 1500000);
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotation_lines
            WHERE quotation_version_id = $1`,
          [thread.versionId],
        )
      ).rows[0].n,
      3,
      'nothing is deleted from the predecessor version',
    );
    const event = await db().query(
      `SELECT metadata FROM operational_events
        WHERE event_type = 'HANDYMAN_QUOTATION_VERSION_CREATED'
          AND metadata->>'quotationVersionId' = $1
        LIMIT 1`,
      [revision.id],
    );
    assert.equal(
      (event.rows[0].metadata as { omittedCarryForwardLineCount: number })
        .omittedCarryForwardLineCount,
      2,
    );

    // Additions keep using the existing DRAFT line API, and an empty selection
    // legitimately restarts the revision with no lines at all.
    await addHandymanQuotationLine(
      revision.id,
      { ...lineBody({ uomId: f.uomId, description: 'Extra night-shift supervision' }) },
      adminId,
    );
    assert.equal((await listHandymanQuotationVersionLines(revision.id, adminId)).length, 2);
    const fresh = await createHandymanQuotationRevision(
      thread.quotationId,
      adminId,
      undefined,
      { carryForwardLineIds: [] },
    );
    assert.equal(fresh.versionNumber, 3);
    assert.equal((await listHandymanQuotationVersionLines(fresh.id, adminId)).length, 0);
    assert.equal((await lineTotals(fresh.id)).total, 0);
  });

  it('refuses any carry-forward that could lose, duplicate or smuggle lines', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await manualThread(f, 'refuse', { lines: MANUAL_LINES });
    const other = await manualThread(f, 'refuse-other', { lines: [MANUAL_LINES[0]] });
    const prior = await listHandymanQuotationVersionLines(thread.versionId, adminId);
    const otherLines = await listHandymanQuotationVersionLines(other.versionId, adminId);

    const cases: Array<{ label: string; ids: string[]; message: RegExp }> = [
      {
        label: 'foreign line of another thread',
        ids: [otherLines[0].id],
        message: /immediately previous version of this quotation thread/,
      },
      {
        label: 'repeated id',
        ids: [prior[0].id, prior[0].id],
        message: /must not repeat a line/,
      },
    ];
    for (const item of cases) {
      await assert.rejects(
        () =>
          createHandymanQuotationRevision(thread.quotationId, adminId, undefined, {
            carryForwardLineIds: item.ids,
          }),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            'VALIDATION_ERROR',
            item.label,
          );
          assert.match(errorMessage(error), item.message);
          return true;
        },
      );
    }

    // Nothing was created by the refused attempts: a revision is all-or-nothing.
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotation_versions
            WHERE quotation_id = $1`,
          [thread.quotationId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await getHandymanQuotation(thread.requestId, adminId)).versions.length,
      1,
    );

    // Not-a-UUID and catalog-lane use are refused, too (service + HTTP layer).
    await assert.rejects(
      () =>
        createHandymanQuotationRevision(thread.quotationId, adminId, undefined, {
          carryForwardLineIds: ['not-a-uuid'],
        }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    const catalog = await catalogThread(f);
    await assert.rejects(
      () =>
        createHandymanQuotationRevision(catalog.quotationId, adminId, undefined, {
          carryForwardLineIds: [],
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
        assert.match(errorMessage(error), /only valid on a manual-origin/);
        return true;
      },
    );
    const httpBad = await api()
      .post(`${V1}/handyman/quotations/${thread.quotationId}/versions`)
      .set(authHeader(f.opsWriter.token))
      .send({ carryForwardLineIds: ['nope'] });
    assert.equal(httpBad.status, 400, JSON.stringify(httpBad.body));
    assert.equal(httpBad.body.error.code, 'VALIDATION_ERROR');

    // The happy HTTP path: the whitelist carries the selection through.
    const httpOk = await api()
      .post(`${V1}/handyman/quotations/${thread.quotationId}/versions`)
      .set(authHeader(f.opsWriter.token))
      .send({ carryForwardLineIds: [prior[1].id, prior[2].id] });
    assert.equal(httpOk.status, 201, JSON.stringify(httpOk.body));
    const httpLines = await api()
      .get(`${V1}/handyman/quotation-versions/${httpOk.body.data.id}/lines`)
      .set(authHeader(f.opsWriter.token));
    assert.equal(httpLines.status, 200, JSON.stringify(httpLines.body));
    assert.equal(httpLines.body.data.length, 2);
    assert.equal(
      httpLines.body.data.every(
        (line: Record<string, unknown>) => !('originKind' in line),
      ),
      true,
      'the customer-facing line projection stays closed',
    );
  });

  it('closes manual-origin revisioning once a version is APPROVED and refuses self-approval', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await manualThread(f, 'approved', {
      dp: { dpRequired: true, dpPercentage: 25 },
      lines: MANUAL_LINES,
    });
    await issueHandymanQuotationVersion(thread.versionId, { validUntil: FUTURE() }, adminId);

    // Operations may not approve on the tenant's behalf.
    const selfApproval = await api()
      .post(`${V1}/handyman/quotation-versions/${thread.versionId}/decision`)
      .set(authHeader(f.opsWriter.token))
      .set({ 'Idempotency-Key': `k-${randomUUID()}` })
      .send({ decision: 'APPROVE' });
    assert.equal(selfApproval.status, 403, JSON.stringify(selfApproval.body));
    assert.equal(
      selfApproval.body.error.code,
      'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN',
    );
    assert.equal(
      (
        await db().query(
          `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
          [thread.versionId],
        )
      ).rows[0].status,
      'ISSUED',
    );

    // The PIC approves: the thread is now consented.
    const decision = await decideHandymanQuotation(
      thread.versionId,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      f.customerUser.id,
    ) as Awaited<ReturnType<typeof decideHandymanQuotation>> & {
      quotationVersionId: string;
      executionScope: unknown;
    };
    assert.equal(decision.decision, 'APPROVE');
    assert.equal(decision.quotationVersionId, thread.versionId);
    assert.ok(decision.executionScope, 'APPROVE creates the authoritative scope');
    const approvedRow = await db().query(
      `SELECT status, dp_required, dp_percentage, dp_amount
         FROM handyman_quotation_versions WHERE id = $1`,
      [thread.versionId],
    );
    assert.equal(approvedRow.rows[0].status, 'APPROVED');
    assert.equal(
      Number(approvedRow.rows[0].dp_amount),
      862500,
      'approved money terms are the issued ones (25% of 3.450.000)',
    );

    await assert.rejects(
      () => createHandymanQuotationRevision(thread.quotationId, adminId),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          'HANDYMAN_QUOTATION_INVALID_TRANSITION',
        );
        assert.match(errorMessage(error), /Scope Variation/);
        return true;
      },
    );
    const httpFork = await api()
      .post(`${V1}/handyman/quotations/${thread.quotationId}/versions`)
      .set(authHeader(f.opsWriter.token))
      .send({});
    assert.equal(httpFork.status, 400, JSON.stringify(httpFork.body));
    assert.equal(
      httpFork.body.error.code,
      'HANDYMAN_QUOTATION_INVALID_TRANSITION',
    );

    // The approved version and its lines are untouched, and no version was
    // forked: the DP/line state of a consented quotation cannot be rewritten.
    const versions = await getHandymanQuotation(thread.requestId, adminId);
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0].status, 'APPROVED');
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotation_lines
            WHERE quotation_version_id = $1`,
          [thread.versionId],
        )
      ).rows[0].n,
      3,
    );
    await assert.rejects(
      () =>
        addHandymanQuotationLine(
          thread.versionId,
          { ...lineBody({ uomId: f.uomId }) },
          adminId,
        ),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_QUOTATION_VERSION_NOT_DRAFT',
    );
  });

  it('keeps the catalog lane exactly as before: no copied lines, DP still inherited', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const catalog = await catalogThread(f, {
      dp: { dpRequired: true, dpPercentage: 30 },
    });
    const v1Lines = await listHandymanQuotationVersionLines(catalog.versionId, adminId);
    assert.equal(v1Lines.length, 1);
    assert.equal(v1Lines[0].originKind, 'CATALOG');

    const revision = await createHandymanQuotationRevision(
      catalog.quotationId,
      adminId,
    );
    assert.equal(
      (await listHandymanQuotationVersionLines(revision.id, adminId)).length,
      0,
      'the catalog lane re-derives its lines; a revision must not double-count them',
    );
    assert.equal(revision.dpRequired, true);
    assert.equal(revision.dpPercentage, 30);
    assert.equal(revision.dpAmount, null);
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotation_lines
            WHERE quotation_version_id = $1`,
          [catalog.versionId],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      () =>
        issueHandymanQuotationVersion(revision.id, { validUntil: FUTURE() }, adminId),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_QUOTATION_NO_LINES',
    );

    // And the catalog revision can still be priced and issued normally.
    await addHandymanQuotationLine(
      revision.id,
      {
        ...lineBody({
          uomId: f.uomId,
          description: 'Standard catalog labor, revised',
          quantity: 6,
          finalQuotedUnitAmount: 150000,
        }),
      },
      adminId,
    );
    const issued = await issueHandymanQuotationVersion(
      revision.id,
      { validUntil: FUTURE() },
      adminId,
    );
    assert.equal(issued.status, 'ISSUED');
    assert.equal(issued.dpAmount, 270000, '30% of the revised 900.000 total');
    assert.equal((await lineTotals(revision.id)).total, 900000);
    assert.deepEqual(
      await originsOf(revision.id),
      ['CATALOG'],
      'a catalog thread can never carry manual-origin lines',
    );

    // And the LEGITIMATE post-approval pathway stays open on the catalog lane:
    // an approved catalog thread may still be revised (its approved snapshot is
    // untouched, and the revision re-derives from its items instead of cloning).
    const consented = await catalogThread(f);
    await issueHandymanQuotationVersion(
      consented.versionId,
      { validUntil: FUTURE() },
      adminId,
    );
    const approved = await decideHandymanQuotation(
      consented.versionId,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      f.customerUser.id,
    );
    assert.equal(approved.decision, 'APPROVE');
    const postApproval = await createHandymanQuotationRevision(
      consented.quotationId,
      adminId,
    );
    assert.equal(postApproval.versionNumber, 2);
    assert.equal(postApproval.status, 'DRAFT');
    const consentedRow = await db().query(
      `SELECT status, dp_required, dp_percentage, dp_amount
         FROM handyman_quotation_versions WHERE id = $1`,
      [consented.versionId],
    );
    assert.equal(consentedRow.rows[0].status, 'APPROVED');
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotation_lines
            WHERE quotation_version_id = $1`,
          [consented.versionId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await listHandymanQuotationVersionLines(postApproval.id, adminId)).length,
      0,
    );
  });

  it('documents the revision contract and adds no schema change', async (t) => {
    if (!requireDatabase(t)) return;
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8')) as Record<
      string,
      any
    >;
    const op = spec.paths['/handyman/quotations/{quotationId}/versions'].post;
    assert.ok(op['x-error-codes'].includes('HANDYMAN_QUOTATION_INVALID_TRANSITION'));
    const schema =
      op.requestBody.content['application/json'].schema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'carryForwardLineIds',
      'dpAmount',
      'dpPercentage',
      'dpRequired',
      'dpTermsNotes',
    ]);
    assert.equal(schema.properties.carryForwardLineIds.uniqueItems, true);
    assert.match(op.description, /carryForwardLineIds/);
    assert.match(op.description, /APPROVED/);
    assert.ok(!/^.*lines are never copied.*$/m.test(op.summary ?? ''));
    assert.deepEqual(
      Object.keys(
        spec.components.schemas.CreateHandymanQuotationLineRequest.properties,
      ).includes('originKind'),
      true,
    );
    // PART 03B is behavior-only: 0489 is still the newest registered migration.
    const registry = readFileSync('src/database/migrations/index.ts', 'utf8');
    assert.ok(
      /migration0489HandymanQuotationLineManualOrigin,\n\];/.test(registry),
      'no migration may be added by PART 03B',
    );
  });
});
