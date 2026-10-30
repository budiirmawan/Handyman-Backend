/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 03A focused validation.
 *
 * A formal `UNLISTED_TRIAGE` (manual-origin, 0488) Service Request is quoted
 * through the EXISTING quotation thread/version/line APIs — no parallel
 * quotation engine, no fabricated Service Catalog anchor:
 *
 *   - multiple LABOR + MATERIAL one-time lines on one DRAFT version, with
 *     server-derived totals and one quotation thread per request;
 *   - `assertHandymanQuotationInspectionReady` decides readiness from verified
 *     intake/triage provenance instead of a nullable catalog id, mandates the
 *     inspection on the manual lane, and FAILS CLOSED when no authoritative
 *     exemption exists (the very function the issue and customer-approval
 *     commands call, so all three money points are covered by one gate);
 *   - `origin_kind` (0489) provenance is server-derived, mixed origins are
 *     lawful only under an existing governed MANUAL_REVIEW resolution, and
 *     neither the service nor the database accepts a CATALOG claim or a
 *     smuggled catalog reference on the manual lane;
 *   - Client/Building scope, DRAFT-only edits and issued-version immutability
 *     stay exactly as before, and every pre-existing (catalog-lane) row keeps
 *     `CATALOG` origin.
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
import { migration0489HandymanQuotationLineManualOrigin } from '../src/database/migrations/0489_handyman_quotation_line_manual_origin';
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
  getHandymanQuotationVersionTotals,
  issueHandymanQuotationVersion,
  listHandymanQuotationVersionLines,
} from '../src/modules/handyman-quotations';
import { assertHandymanQuotationInspectionReady } from '../src/modules/handyman-quotations/handyman-quotation-inspection';
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
const PORT = 55575;
const DIR = '/tmp/asentra-handyman-quotation-manual-lines-pg';
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
  return (error as { message?: string }).message ?? String(error);
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
  const email = `mq-user-${tag.toLowerCase()}@manual-quotation.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName: input.displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  if (input.permissionCodes.length > 0) {
    const role = await roleService.createRole({ code: `MQ_${tag}`, name: `Role ${tag}` });
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
      `EXT-${f.tag}`,
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
      `EXT-${f.tag}`,
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

describe('CR-HM-MANUAL-QUOTATION-01 PART 03A — manual quotation lines', () => {
  it('quotes a manual-origin request through the existing thread/line APIs with several one-time lines', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const { requestId, quoteVersionId } = await quotableManualRequest(f, 'multi', {
      diagnosis: 'service',
    });

    await addHandymanQuotationLine(
      quoteVersionId,
      { ...lineBody({ uomId: f.uomId }), description: 'Atrium rig install labor' },
      adminId,
    );
    await addHandymanQuotationLine(
      quoteVersionId,
      {
        ...lineBody({
          uomId: f.uomId,
          lineType: 'MATERIAL',
          description: 'Structural steel and rigging hardware',
          quantity: 2,
          finalQuotedUnitAmount: 750000,
        }),
      },
      adminId,
    );
    await addHandymanQuotationLine(
      quoteVersionId,
      {
        ...lineBody({
          uomId: f.uomId,
          description: 'Lobby protection and after-hours access supervision',
          quantity: 0.5,
          finalQuotedUnitAmount: 900000,
        }),
      },
      adminId,
    );

    const lines = await listHandymanQuotationVersionLines(quoteVersionId, adminId);
    assert.equal(lines.length, 3, 'a manual-origin request supports MULTIPLE lines');
    assert.deepEqual(
      lines.map((l) => l.originKind),
      ['MANUAL_ONE_TIME', 'MANUAL_ONE_TIME', 'MANUAL_ONE_TIME'],
    );
    const totals = await lineTotals(quoteVersionId);
    assert.equal(totals.laborSubtotal, 10 * 150000 + 0.5 * 900000);
    assert.equal(totals.materialSubtotal, 2 * 750000);
    assert.equal(totals.total, totals.laborSubtotal + totals.materialSubtotal);
    assert.equal(totals.currency, 'IDR');
    assert.equal(totals.lineCount, 3);

    // One quotation THREAD per request (not one line per request), and no
    // fabricated catalog anchor anywhere on the lane.
    const threads = await db().query(
      `SELECT count(*)::int AS n FROM handyman_quotations WHERE handyman_request_id = $1`,
      [requestId],
    );
    assert.equal(threads.rows[0].n, 1);
    await assert.rejects(
      () => createHandymanQuotation({ handymanRequestId: requestId }, adminId),
      (error) => errorCode(error) === 'HANDYMAN_QUOTATION_ALREADY_EXISTS',
    );
    const requestRow = await db().query(
      `SELECT service_catalog_id, service_variant_id, intake_source,
              unlisted_intake_case_id
         FROM handyman_service_requests WHERE id = $1`,
      [requestId],
    );
    assert.equal(requestRow.rows[0].service_catalog_id, null);
    assert.equal(requestRow.rows[0].service_variant_id, null);
    assert.equal(requestRow.rows[0].intake_source, 'UNLISTED_TRIAGE');
    const items = await db().query(
      `SELECT count(*)::int AS n FROM handyman_service_request_items
        WHERE handyman_request_id = $1`,
      [requestId],
    );
    assert.equal(items.rows[0].n, 0, 'no catalog request item is invented');
  });

  it('mandates the inspection on the manual lane and opens only once an INSPECTED record exists', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const { caseId, attributionId } = await insertCaseWithAttribution(f, {
      idempotencyKey: 'gate-1',
    });
    const { requestId } = await triageAndConvert(f, caseId, 'gate-1');
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: requestId,
        triageDisposition: 'INSPECTION_REQUIRED',
        triageNote: 'Site survey required before a one-time quotation.',
      },
      adminId,
    );
    // Diagnosis authority exists (SQL-simulated so the inspection is the ONLY
    // missing fact); quoting must still be refused.
    await db().query(
      `INSERT INTO handyman_request_diagnoses
         (id, client_id, handyman_request_id, channel_attribution_id,
          building_id, handyman_discipline_id, discipline_code, diagnosis,
          scope_classification, recommended_service_catalog_id,
          diagnosed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'GENERAL_HANDYMAN',
               'One-time atrium rig after survey.', 'GENERAL_HANDYMAN', NULL, $7)`,
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
    await assert.rejects(
      () => createHandymanQuotation({ handymanRequestId: requestId }, adminId),
      (error) => {
        assert.equal(errorCode(error), 'VALIDATION_ERROR');
        assert.match(errorMessage(error), /completed inspection is required/i);
        return true;
      },
    );
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotations WHERE handyman_request_id = $1`,
          [requestId],
        )
      ).rows[0].n,
      0,
      'a refused gate must not leave a quotation thread behind',
    );

    // NOT_INSPECTABLE never stands in for a completed visit: the row is
    // UNIQUE per request, so it is asserted by the same refusal below.
    await handymanServiceRequestInspectionService.recordHandymanInspection(
      {
        handymanRequestId: requestId,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Atrium anchor points verified on site.',
      },
      adminId,
    );
    const bundle = await createHandymanQuotation({ handymanRequestId: requestId }, adminId);
    const line = await addHandymanQuotationLine(
      bundle.versions[0].id,
      { ...lineBody({ uomId: f.uomId }) },
      adminId,
    );
    assert.equal(line.originKind, 'MANUAL_ONE_TIME');
  });

  it('fails closed without an authoritative exemption even when inspected, and never bypasses', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    // A manual-origin request whose bound intake case was NEVER triaged: the
    // row satisfies 0488's law (manual origin + case binding) but no
    // authoritative MANUAL_QUOTATION_READY exemption exists for it.
    const { caseId, attributionId } = await insertCaseWithAttribution(f, {
      idempotencyKey: 'orphan-1',
    });
    const requestId = randomUUID();
    await db().query(
      `INSERT INTO handyman_service_requests
         (id, client_id, channel_attribution_id, tenant_company_id, tenant_pic_id,
          building_id, space_id, service_catalog_id, service_variant_id,
          origin_channel, origin_reference, description, status,
          created_by_user_id, intake_source, unlisted_intake_case_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, 'CUSTOMER_CARE_BACKEND',
               $8, 'Untriaged manual-origin request used to prove the fail-closed gate.',
               'INTAKE', $9, 'UNLISTED_TRIAGE', $10)`,
      [
        requestId,
        f.client.id,
        attributionId,
        f.company.id,
        f.pic.id,
        f.building.id,
        f.space.id,
        `EXT-${f.tag}`,
        adminId,
        caseId,
      ],
    );
    await db().query(
      `INSERT INTO handyman_request_inspections
         (id, client_id, handyman_request_id, channel_attribution_id,
          building_id, inspection_result, inspection_notes, inspected_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'INSPECTED',
               'Inspection exists, yet no verified triage exemption does.', $6)`,
      [randomUUID(), f.client.id, requestId, attributionId, f.building.id, adminId],
    );
    await db().query(
      `INSERT INTO handyman_request_diagnoses
         (id, client_id, handyman_request_id, channel_attribution_id,
          building_id, handyman_discipline_id, discipline_code, diagnosis,
          scope_classification, recommended_service_catalog_id,
          diagnosed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'GENERAL_HANDYMAN',
               'One-time atrium rig.', 'GENERAL_HANDYMAN', NULL, $7)`,
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

    await assert.rejects(
      () => createHandymanQuotation({ handymanRequestId: requestId }, adminId),
      (error) => {
        assert.equal(errorCode(error), 'VALIDATION_ERROR');
        assert.match(errorMessage(error), /verified unlisted-intake triage provenance/i);
        return true;
      },
    );
    // The SAME gate protects issue and customer approval: calling it directly
    // proves the money points refuse rather than silently bypass.
    await withTransaction(async (tx) => {
      await assert.rejects(
        () => assertHandymanQuotationInspectionReady(tx as never, requestId),
        (error) => {
          assert.match(errorMessage(error), /provenance/i);
          return true;
        },
      );
    });
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_quotations WHERE handyman_request_id = $1`,
          [requestId],
        )
      ).rows[0].n,
      0,
    );
  });

  it('refuses any fabricated catalog origin or catalog reference on the manual lane', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const { quoteVersionId } = await quotableManualRequest(f, 'smuggle', {
      diagnosis: 'service',
    });

    await assert.rejects(
      () =>
        addHandymanQuotationLine(
          quoteVersionId,
          { ...lineBody({ uomId: f.uomId }), originKind: 'CATALOG' },
          adminId,
        ),
      (error) => {
        assert.equal(errorCode(error), 'HANDYMAN_QUOTATION_LINE_INVALID');
        assert.match(errorMessage(error), /no Service Catalog anchor/i);
        return true;
      },
    );

    // HTTP: an unknown enum value is a 400, and a smuggled catalog reference is
    // structurally dropped (never stored, never turned into a fake anchor).
    const bad = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .set(authHeader(f.opsWriter.token))
      .send(lineBody({ uomId: f.uomId, originKind: 'GOVERNED_PRICE' }));
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

    const smuggled = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .set(authHeader(f.opsWriter.token))
      .send(
        lineBody({
          uomId: f.uomId,
          originKind: 'CATALOG',
          serviceCatalogId: f.service.id,
          lineTotal: 1,
          status: 'APPROVED',
        }),
      );
    assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));

    const ok = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .set(authHeader(f.opsWriter.token))
      .send(
        lineBody({
          uomId: f.uomId,
          lineType: 'MATERIAL',
          description: 'Atrium rig deck panels',
          serviceCatalogId: f.service.id,
          createdByUserId: adminId,
        }),
      );
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(
      ok.body.data.originKind,
      undefined,
      'origin provenance stays out of the customer-facing projection',
    );
    const stored = await db().query(
      `SELECT origin_kind, source_item_id FROM handyman_quotation_lines WHERE id = $1`,
      [ok.body.data.id as string],
    );
    assert.equal(stored.rows[0].origin_kind, 'MANUAL_ONE_TIME');
    assert.equal(stored.rows[0].source_item_id, null);

    // Database law (0489): even a direct write cannot label a manual-origin
    // line as CATALOG.
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_quotation_lines
             (id, quotation_version_id, line_type, description, quantity,
              uom_id, reference_unit_amount, final_quoted_unit_amount,
              line_total, currency, source_item_id, origin_kind,
              created_by_user_id, created_at, updated_at)
           VALUES ($1, $2, 'LABOR', 'Smuggled catalog-origin line', 1, $3, NULL,
                   100, 100, 'IDR', NULL, 'CATALOG', $4, now(), now())`,
          [randomUUID(), quoteVersionId, f.uomId, adminId],
        ),
      (error) => {
        assert.match(errorMessage(error), /never be recorded as CATALOG origin/i);
        return true;
      },
    );
  });

  it('allows mixed origins on the catalog lane only under a governed MANUAL_REVIEW resolution', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
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
        triageNote: 'Direct to diagnosis for the mixed-origin test.',
      },
      adminId,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: request.id,
        disciplineId: disciplineIds.GENERAL_HANDYMAN,
        diagnosis: 'Catalog service plus one deferred bespoke element.',
      },
      adminId,
    );
    const bundle = await createHandymanQuotation(
      { handymanRequestId: request.id },
      adminId,
    );
    const versionId = bundle.versions[0].id;

    const labor = await addHandymanQuotationLine(
      versionId,
      { ...lineBody({ uomId: f.uomId, description: 'Standard catalog labor' }) },
      adminId,
    );
    assert.equal(labor.originKind, 'CATALOG', 'the existing lane keeps its label');

    // An ungrounded manual claim is refused — and nothing is invented to
    // satisfy it.
    await assert.rejects(
      () =>
        addHandymanQuotationLine(
          versionId,
          {
            ...lineBody({
              uomId: f.uomId,
              description: 'Bespoke element deferred by pricing',
              originKind: 'MANUAL_ONE_TIME',
            }),
          },
          adminId,
        ),
      (error) => {
        assert.equal(errorCode(error), 'HANDYMAN_QUOTATION_LINE_INVALID');
        assert.match(errorMessage(error), /MANUAL_REVIEW quote resolution/i);
        return true;
      },
    );
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_service_quote_resolutions
            WHERE handyman_request_id = $1`,
          [request.id],
        )
      ).rows[0].n,
      0,
      'the refusal must not create a quote resolution',
    );

    // The pricing authority (existing 0477 contract, never an amount) defers
    // one item: from now on a manual line is lawful next to the catalog line.
    await db().query(
      `INSERT INTO handyman_service_quote_resolutions
         (id, client_id, handyman_request_id, request_item_id, outcome,
          reason_code, reason_detail, resolved_by_user_id)
       VALUES ($1, $2, $3, NULL, 'MANUAL_REVIEW', 'BESPOKE_SCOPE_ELEMENT',
               'Pricing authority deferred the atrium rig element to a manual
                one-time quotation.', $4)`,
      [randomUUID(), f.client.id, request.id, adminId],
    );
    const manual = await addHandymanQuotationLine(
      versionId,
      {
        ...lineBody({
          uomId: f.uomId,
          lineType: 'MATERIAL',
          description: 'One-time atrium rig panel set',
          quantity: 3,
          finalQuotedUnitAmount: 250000,
          originKind: 'MANUAL_ONE_TIME',
        }),
      },
      adminId,
    );
    assert.equal(manual.originKind, 'MANUAL_ONE_TIME');
    assert.deepEqual(await originsOf(versionId), ['CATALOG', 'MANUAL_ONE_TIME']);
    const totals = await lineTotals(versionId);
    assert.equal(totals.laborSubtotal, 1500000);
    assert.equal(totals.materialSubtotal, 750000);
    assert.equal(totals.total, 2250000);
    assert.equal(
      (
        await db().query(
          `SELECT count(*)::int AS n FROM handyman_service_quote_resolutions
            WHERE handyman_request_id = $1 AND outcome = 'MANUAL_REVIEW'
            AND unit_amount IS NULL AND computed_total IS NULL`,
          [request.id],
        )
      ).rows[0].n,
      1,
      'the governed MANUAL_REVIEW fact is reused as-is: no invented amount',
    );
  });

  it('keeps Client/Building scope and assignment authority closed on manual lines', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const { quoteVersionId } = await quotableManualRequest(f, 'scope', {
      diagnosis: 'service',
    });

    const anonymous = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .send(lineBody({ uomId: f.uomId }));
    assert.equal(anonymous.status, 401);

    const noPermission = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .set(authHeader(f.opsReader.token))
      .send(lineBody({ uomId: f.uomId }));
    assert.equal(noPermission.status, 403, JSON.stringify(noPermission.body));

    // Same Client, different Building: an assignment elsewhere in the Client is
    // NOT a client-wide privilege.
    const crossBuilding = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .set(authHeader(f.foreignOpsWriter.token))
      .send(lineBody({ uomId: f.uomId }));
    assert.equal(crossBuilding.status, 403, JSON.stringify(crossBuilding.body));

    // A UOM owned by another Client is refused even for an authorized actor.
    const foreignClient = await clientService.createClient({
      code: `MQFX_${f.tag}`,
      name: `Foreign Client ${f.tag}`,
    });
    const foreignUom = randomUUID();
    await db().query(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, 'FXUOM', 'Foreign lot', 'lot', 'OTHER')`,
      [foreignUom, foreignClient.id],
    );
    const foreignUomRes = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .set(authHeader(f.opsWriter.token))
      .send(lineBody({ uomId: foreignUom }));
    assert.equal(foreignUomRes.status, 400, JSON.stringify(foreignUomRes.body));

    assert.deepEqual(await originsOf(quoteVersionId), []);
    const authorized = await api()
      .post(`${V1}/handyman/quotation-versions/${quoteVersionId}/lines`)
      .set(authHeader(f.opsWriter.token))
      .send(lineBody({ uomId: f.uomId }));
    assert.equal(authorized.status, 201, JSON.stringify(authorized.body));
    assert.deepEqual(await originsOf(quoteVersionId), ['MANUAL_ONE_TIME']);
  });

  it('preserves DRAFT-only edits, issue-time gating and issued-line immutability', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const { quoteVersionId } = await quotableManualRequest(f, 'issue', {
      diagnosis: 'service',
    });
    await addHandymanQuotationLine(
      quoteVersionId,
      { ...lineBody({ uomId: f.uomId }) },
      adminId,
    );
    const before = await lineTotals(quoteVersionId);
    assert.equal(before.lineCount, 1);

    // The second currency is refused on a version that already fixed IDR.
    await assert.rejects(
      () =>
        addHandymanQuotationLine(
          quoteVersionId,
          {
            ...lineBody({ uomId: f.uomId, description: 'Imported rig parts' }),
            currency: 'USD',
          },
          adminId,
        ),
      (error) => errorCode(error) === 'HANDYMAN_QUOTATION_CURRENCY_MISMATCH',
    );

    const issued = await issueHandymanQuotationVersion(
      quoteVersionId,
      { validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() },
      adminId,
    );
    assert.equal(issued.status, 'ISSUED');

    await assert.rejects(
      () =>
        addHandymanQuotationLine(
          quoteVersionId,
          { ...lineBody({ uomId: f.uomId, description: 'Late extra labor' }) },
          adminId,
        ),
      (error) => errorCode(error) === 'HANDYMAN_QUOTATION_VERSION_NOT_DRAFT',
    );
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_quotation_lines SET final_quoted_unit_amount = 1
            WHERE quotation_version_id = $1`,
          [quoteVersionId],
        ),
      (error) => {
        assert.match(errorMessage(error), /immutable/i);
        return true;
      },
    );
    await assert.rejects(
      () =>
        db().query(`DELETE FROM handyman_quotation_lines WHERE quotation_version_id = $1`, [
          quoteVersionId,
        ]),
      (error) => {
        assert.match(errorMessage(error), /immutable/i);
        return true;
      },
    );
    assert.deepEqual(await originsOf(quoteVersionId), ['MANUAL_ONE_TIME']);
    assert.deepEqual(await lineTotals(quoteVersionId), before);
  });

  it('keeps the catalog lane byte-for-byte compatible and 0489 reversible only when unused', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();

    // 0489 column + constraint + trigger exist, with CATALOG as the default.
    const column = await db().query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'handyman_quotation_lines' AND column_name = 'origin_kind'`,
    );
    assert.equal(column.rows[0].is_nullable, 'NO');
    assert.match(String(column.rows[0].column_default), /'CATALOG'/);
    const constraint = await db().query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'handyman_quotation_lines_origin_kind_check'`,
    );
    assert.equal(
      constraint.rows[0].def,
      "CHECK ((origin_kind = ANY (ARRAY['CATALOG'::text, 'MANUAL_ONE_TIME'::text])))",
    );
    const trigger = await db().query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_handyman_quotation_line_guard_origin'`,
    );
    assert.equal(trigger.rows.length, 1);

    // Existing catalog-lane rows: origin defaults to CATALOG and the lane is
    // untouched (raw insert exactly as pre-0489 code would have written it).
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
    const catalogRequest = await handymanServiceRequestService
      .createHandymanServiceRequest(
        { channelAttributionId: attributionId, serviceCatalogId: f.service.id },
        adminId,
      );
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: catalogRequest.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Catalog regression probe.',
      },
      adminId,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: catalogRequest.id,
        disciplineId: disciplineIds.GENERAL_HANDYMAN,
        diagnosis: 'Standard catalog work.',
      },
      adminId,
    );
    const bundle = await createHandymanQuotation(
      { handymanRequestId: catalogRequest.id },
      adminId,
    );
    const versionId = bundle.versions[0].id;
    const legacyLineId = randomUUID();
    await db().query(
      `INSERT INTO handyman_quotation_lines
         (id, quotation_version_id, line_type, description, quantity, uom_id,
          reference_unit_amount, final_quoted_unit_amount, line_total, currency,
          source_item_id, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, 'LABOR', 'Legacy catalog labor line', 4, $3, NULL, 100000,
               400000, 'IDR', NULL, $4, now(), now())`,
      [legacyLineId, versionId, f.uomId, adminId],
    );
    const legacy = await db().query(
      `SELECT origin_kind, line_total FROM handyman_quotation_lines WHERE id = $1`,
      [legacyLineId],
    );
    assert.equal(legacy.rows[0].origin_kind, 'CATALOG');
    assert.equal(Number(legacy.rows[0].line_total), 400000);
    const serviceLine = await addHandymanQuotationLine(
      versionId,
      { ...lineBody({ uomId: f.uomId, description: 'Catalog labor' }) },
      adminId,
    );
    assert.equal(serviceLine.originKind, 'CATALOG');
    assert.deepEqual(await originsOf(versionId), ['CATALOG', 'CATALOG']);
    const totals = await lineTotals(versionId);
    assert.equal(totals.total, 400000 + 1500000);
    assert.equal(totals.lineCount, 2);

    // Reversibility: 0489 down() is refused while a MANUAL_ONE_TIME line
    // exists, and only that (applied inside a rolled-back transaction).
    const manual = await quotableManualRequest(f, 'rev-1', { diagnosis: 'service' });
    await addHandymanQuotationLine(
      manual.quoteVersionId,
      { ...lineBody({ uomId: f.uomId }) },
      adminId,
    );
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await migration0489HandymanQuotationLineManualOrigin.down(tx as never);
        }),
      (error) => {
        assert.match(errorMessage(error), /cannot be reverted/i);
        return true;
      },
    );
    assert.equal((await originsOf(manual.quoteVersionId))[0], 'MANUAL_ONE_TIME');

    // And once the lane carries no manual-origin fact, down() removes exactly
    // what 0489 added and up() restores it — exercised inside one transaction
    // that is rolled back, so no schema or data change survives the probe.
    const ROLLBACK_SENTINEL = '0489-reversal-probe-rollback';
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await tx.query('TRUNCATE handyman_quotation_lines CASCADE');
          await migration0489HandymanQuotationLineManualOrigin.down(tx as never);
          const gone = await tx.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'handyman_quotation_lines'
                AND column_name = 'origin_kind'`,
          );
          assert.equal(gone.rowCount, 0, 'down() must remove the origin column');
          const triggerGone = await tx.query(
            `SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_handyman_quotation_line_guard_origin'`,
          );
          assert.equal(
            triggerGone.rowCount,
            0,
            'down() must remove the 0489 origin law',
          );
          await migration0489HandymanQuotationLineManualOrigin.up(tx as never);
          const restored = await tx.query(
            `SELECT origin_kind FROM handyman_quotation_lines LIMIT 0`,
          );
          assert.equal(restored.rowCount, 0);
          const law = await tx.query(
            `SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_handyman_quotation_line_guard_origin'`,
          );
          assert.equal(law.rowCount, 1, 'up() must restore the origin law');
          throw new Error(ROLLBACK_SENTINEL);
        }),
      (error) => errorMessage(error).includes(ROLLBACK_SENTINEL),
    );
    const stillThere = await db().query(
      `SELECT origin_kind FROM handyman_quotation_lines
        WHERE quotation_version_id = $1`,
      [manual.quoteVersionId],
    );
    assert.deepEqual(
      stillThere.rows.map((r) => r.origin_kind),
      ['MANUAL_ONE_TIME'],
      'the probe transaction must not survive',
    );
  });

  it('documents the origin contract without widening the customer projection', async (t) => {
    if (!requireDatabase(t)) return;
    const spec = parseYaml(
      readFileSync('docs/api/openapi.yaml', 'utf8'),
    ) as Record<string, any>;
    const create = spec.components.schemas.CreateHandymanQuotationLineRequest;
    assert.deepEqual(create.properties.originKind.enum, ['CATALOG', 'MANUAL_ONE_TIME']);
    assert.ok(
      !create.required.includes('originKind'),
      'originKind stays optional: the catalog lane never has to declare it',
    );
    const customer = spec.components.schemas.HandymanQuotationLineCustomerProjection;
    assert.equal(customer.additionalProperties, false);
    assert.ok(!('originKind' in customer.properties));
    assert.ok(!customer.required.includes('originKind'));
    const op = spec.paths['/handyman/quotation-versions/{quotationVersionId}/lines'].post;
    assert.ok(op['x-error-codes'].includes('HANDYMAN_QUOTATION_LINE_INVALID'));
    assert.match(op.description, /MANUAL_ONE_TIME/);
    const createOp = spec.paths['/handyman/requests/{handymanRequestId}/quotation'].post;
    assert.match(createOp.description, /TRIAGED_MANUAL_QUOTATION_READY/);
    assert.ok(createOp['x-error-codes'].includes('VALIDATION_ERROR'));

    // Migration registry: 0489 is registered exactly once, after 0488.
    const registry = readFileSync('src/database/migrations/index.ts', 'utf8');
    assert.equal(
      registry.match(/migration0489HandymanQuotationLineManualOrigin/g)?.length,
      2,
    );
    assert.ok(
      registry.indexOf('migration0488HandymanUnlistedIntakeFormalRequestConversion') <
        registry.indexOf('migration0489HandymanQuotationLineManualOrigin'),
    );
    assert.equal(
      /0489[\s\S]{0,400}?handyman_quotation_lines[\s\S]{0,400}?origin_kind/.test(
        readFileSync(
          'src/database/migrations/0489_handyman_quotation_line_manual_origin.ts',
          'utf8',
        ),
      ),
      true,
    );
  });
});
