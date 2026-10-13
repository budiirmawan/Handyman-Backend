import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  getHandymanRequestDiagnosis,
  getHandymanRequestInspection,
  getHandymanRequestTriage,
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
  expireHandymanQuotationVersion,
  getCurrentHandymanIssuedQuotationVersion,
  getHandymanExecutionScopeByQuotationVersion,
  getHandymanQuotation,
  getHandymanQuotationDecision,
  getHandymanQuotationVersionTotals,
  issueHandymanQuotationVersion,
  listHandymanQuotationVersionLines,
  supersedeHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { roleRepository, roleService } from '../src/modules/roles';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 02 — focused tests for the BE-02G building-scope
 * guard applied to the remaining in-scope Handyman request + quotation
 * resource boundaries:
 *
 *   Request module — read (detail), triage / inspection / diagnosis
 *   commands AND their resource-read helpers.
 *   Quotation module — revision, read, lines (add/list), totals, issue,
 *   expire, supersede, decision (decide/read), the presented read, and
 *   the execution-scope read (its resource-read helper).
 *
 * Authority (established in PART 01, unchanged): BE-02G — a scoped
 * resource requires the actor's explicit ACTIVE `user_building_assignment`
 * to its exact Building. Quotation rows carry no building_id, so the
 * thread's building is TRACED from the parent request
 * (`assertQuotationThreadBuildingAccess`); request rows and execution
 * scopes carry their own authoritative building_id.
 *
 * Focused dimensions per the PART brief: same-building access allowed;
 * same-client SIBLING building denied (403 BUILDING_ACCESS_DENIED, zero
 * mutation); permission-only actor (RBAC without any assignment) denied;
 * and the customer-care read surface keeps its 403 / no-existence-leak
 * semantics (the C6 per-row SQL wall is unchanged).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients, units_of_measure CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  disciplineId = d.id;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const HM = '/api/v1/handyman';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const countFor = async (table: string, requestId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM ${table} WHERE handyman_request_id = $1`,
      [requestId],
    )
  ).rows[0].n as number;

const triageRows = (requestId: string) =>
  countFor('handyman_request_triage_decisions', requestId);
const inspectionRows = (requestId: string) =>
  countFor('handyman_request_inspections', requestId);
const diagnosisRows = (requestId: string) =>
  countFor('handyman_request_diagnoses', requestId);

const versionCount = async (quotationId: string): Promise<number> =>
  (
    await q(
      'SELECT count(*)::int AS n FROM handyman_quotation_versions WHERE quotation_id = $1',
      [quotationId],
    )
  ).rows[0].n as number;

const lineRows = async (versionId: string): Promise<number> =>
  (
    await q(
      'SELECT count(*)::int AS n FROM handyman_quotation_lines WHERE quotation_version_id = $1',
      [versionId],
    )
  ).rows[0].n as number;

const decisionRows = async (versionId: string): Promise<number> =>
  (
    await q(
      'SELECT count(*)::int AS n FROM handyman_quotation_decisions WHERE quotation_version_id = $1',
      [versionId],
    )
  ).rows[0].n as number;

const scopeRows = async (versionId: string): Promise<number> =>
  (
    await q(
      'SELECT count(*)::int AS n FROM handyman_execution_scopes WHERE approved_quotation_version_id = $1',
      [versionId],
    )
  ).rows[0].n as number;

const quotationEventRows = async (requestId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE metadata->>'handymanRequestId' = $1`,
      [requestId],
    )
  ).rows[0].n as number;

const requestStatus = async (requestId: string): Promise<string> =>
  (
    await q('SELECT status FROM handyman_service_requests WHERE id = $1', [
      requestId,
    ])
  ).rows[0].status as string;

const versionStatus = async (versionId: string): Promise<string> =>
  (
    await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [versionId],
    )
  ).rows[0].status as string;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

/** Asserts the exact BE-02G denial: 403 BUILDING_ACCESS_DENIED. */
async function assertBuildingDenied(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * request's building, A2 = the same-client sibling), plus a second
 * client with one building for the no-client case.
 */
async function realmFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA1 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A1 (request building)',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
  });
  const otherClient = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other Client',
  });
  const otherProperty = await propertyService.createProperty({
    clientId: otherClient.id,
    code: `P_${suffix()}`,
    name: 'Other Property',
  });
  const otherBuilding = await buildingService.createBuilding({
    propertyId: otherProperty.id,
    code: `B_${suffix()}`,
    name: 'Other Building (other client)',
  });
  return {
    client,
    property,
    buildingA1,
    buildingA2,
    otherClient,
    otherProperty,
    otherBuilding,
  };
}

/** Tenant context + immutable attribution + request at building A1. */
async function requestFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: realm.buildingA1.id,
  });
  const floor = await floorService.createFloor({
    buildingId: realm.buildingA1.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Tenant Company',
    },
    adminUserId,
  );
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.buildingA1.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant Requester',
      email: 'requester@tenant.example.com',
      userId: linkedUser.id,
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
      spaceId: space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM${suffix()}`,
      name: 'Handyman Service',
      category: 'FM_HINT_TEXT',
    },
    adminUserId,
  );
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  return { attribution, service, request, company, pic, linkedUser };
}

/**
 * Authenticated actor holding `tenant_company.read` +
 * `tenant_company.manage` (the request/quotation route permissions)
 * plus the given explicit ACTIVE building assignments. Returns the
 * session token AND the user id (the guard needs the id to hold
 * assignments).
 */
async function createScopedActor(
  buildingIds: readonly string[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `guard2-${tag.toLowerCase()}@example.com`,
    displayName: 'PART 02 Scope Guard Actor',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `GUARD2_${tag}`,
    name: 'Request/Quotation Actor',
  });
  for (const code of ['tenant_company.read', 'tenant_company.manage'] as const) {
    const existing = await permissionRepository.findByCode(code);
    const permission =
      existing ??
      (await permissionService.createPermission({
        code,
        name: code,
      }));
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }

  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

/**
 * Customer-care READ actor: additionally holds the PLATFORM_ADMIN role
 * code, which the C6 represented-customer SQL wall accepts for
 * historical reads inside the actor's assigned Building.
 */
async function createCareReadActor(
  buildingIds: readonly string[],
): Promise<{ token: string; userId: string }> {
  const actor = await createScopedActor(buildingIds);
  const opsRole =
    (await roleRepository.findByCode('PLATFORM_ADMIN')) ??
    (await roleService.createRole({
      code: 'PLATFORM_ADMIN',
      name: 'Platform Administrator',
    }));
  await roleService.assignRoleToUser(actor.userId, opsRole.id);
  return actor;
}

/** Request triaged by the admin into DIAGNOSIS (quotation-eligible). */
async function diagnosedFixture() {
  const realm = await realmFixture();
  const f = await requestFixture(realm);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: f.request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: f.request.id,
      disciplineId,
      diagnosis: 'Fixture diagnosis for PART 02 scope-guard tests.',
    },
    adminUserId,
  );
  return { realm, ...f };
}

/** Diagnosed request + quotation thread (version 1 DRAFT) by the admin. */
async function quotationFixture() {
  const f = await diagnosedFixture();
  const bundle = await createHandymanQuotation(
    { handymanRequestId: f.request.id },
    adminUserId,
  );
  return { ...f, bundle, version: bundle.versions[0] };
}

/** Quotation thread + one LABOR line (DRAFT, ready to issue). */
async function lineFixture() {
  const f = await quotationFixture();
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, f.realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(
    f.version.id,
    {
      lineType: 'LABOR',
      description: 'Hours',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
    },
    adminUserId,
  );
  return { ...f, uomId };
}

/** Quotation thread + line + ISSUED version (future validUntil). */
async function issuedFixture() {
  const f = await lineFixture();
  const issued = await issueHandymanQuotationVersion(
    f.version.id,
    { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
    adminUserId,
  );
  return { ...f, issued };
}

/** Diagnosed request + quotation thread (version 1 DRAFT) in a given realm. */
async function quotationFixtureForRealm(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const f = await requestFixture(realm);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: f.request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Fixture triage.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: f.request.id,
      disciplineId,
      diagnosis: 'Fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: f.request.id },
    adminUserId,
  );
  return { realm, ...f, bundle, version: bundle.versions[0] };
}

/** Quotation thread + one line + ISSUED version in a given realm. */
async function issuedFixtureForRealm(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const f = await quotationFixtureForRealm(realm);
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(
    f.version.id,
    {
      lineType: 'LABOR',
      description: 'Hours',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
    },
    adminUserId,
  );
  const issued = await issueHandymanQuotationVersion(
    f.version.id,
    { validUntil: FUTURE() },
    adminUserId,
  );
  return { ...f, issued };
}

describe('CR-HM-SEC-01 PART 02 — request + quotation building-scope guard', () => {
  it('1: triage command — same building allowed; sibling and permission-only denied with zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);

    // Positive: explicit assignment to the request's building.
    const same = await createScopedActor([realm.buildingA1.id]);
    const triage = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: request.id,
          triageDisposition: 'DIAGNOSIS',
          triageNote: 'Same-building actor.',
        },
        same.userId,
      );
    assert.equal(triage.handymanRequestId, request.id);
    assert.equal(await triageRows(request.id), 1);
    // F1 projection: status exactly = recorded disposition.
    assert.equal(await requestStatus(request.id), 'DIAGNOSIS');

    // HTTP: 201 on the mutation route.
    const realm2 = await realmFixture();
    const second = await requestFixture(realm2);
    await buildingAssignmentService.createAssignment(same.userId, {
      buildingId: realm2.buildingA1.id,
    });
    const res = await api()
      .post(`${HM}/requests/${second.request.id}/triage`)
      .set(auth(same.token))
      .send({ disposition: 'DIAGNOSIS', note: 'HTTP same-building.' });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // Negative: same-client SIBLING building only.
    const realm3 = await realmFixture();
    const third = await requestFixture(realm3);
    const sibling = await createScopedActor([realm3.buildingA2.id]);
    const before = await quotationEventRows(third.request.id);
    await assertBuildingDenied(
      handymanServiceRequestTriageService.recordHandymanRequestTriage(
        {
          handymanRequestId: third.request.id,
          triageDisposition: 'DIAGNOSIS',
          triageNote: 'Sibling actor.',
        },
        sibling.userId,
      ),
    );
    const resSibling = await api()
      .post(`${HM}/requests/${third.request.id}/triage`)
      .set(auth(sibling.token))
      .send({ disposition: 'DIAGNOSIS', note: 'HTTP sibling.' });
    assert.equal(resSibling.status, 403, JSON.stringify(resSibling.body));
    assert.equal(resSibling.body.error.code, 'BUILDING_ACCESS_DENIED');
    // No mutation on denial.
    assert.equal(await triageRows(third.request.id), 0);
    assert.equal(await requestStatus(third.request.id), 'INTAKE');
    assert.equal(await quotationEventRows(third.request.id), before);

    // Negative: permission-only actor (RBAC without any assignment).
    const realm4 = await realmFixture();
    const fourth = await requestFixture(realm4);
    const permOnly = await createScopedActor([]);
    await assertBuildingDenied(
      handymanServiceRequestTriageService.recordHandymanRequestTriage(
        {
          handymanRequestId: fourth.request.id,
          triageDisposition: 'DIAGNOSIS',
          triageNote: 'Permission-only actor.',
        },
        permOnly.userId,
      ),
    );
    assert.equal(await triageRows(fourth.request.id), 0);
    assert.equal(await requestStatus(fourth.request.id), 'INTAKE');
  });

  it('2: inspection and diagnosis commands — same building allowed; sibling denied with zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    // Inspection path: request triaged to INSPECTION_REQUIRED by the admin.
    const realm = await realmFixture();
    const f = await requestFixture(realm);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: f.request.id,
        triageDisposition: 'INSPECTION_REQUIRED',
        triageNote: 'Needs site inspection.',
      },
      adminUserId,
    );
    const sibling = await createScopedActor([realm.buildingA2.id]);
    await assertBuildingDenied(
      handymanServiceRequestInspectionService.recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Sibling actor.',
        },
        sibling.userId,
      ),
    );
    assert.equal(await inspectionRows(f.request.id), 0);
    assert.equal(await requestStatus(f.request.id), 'INSPECTION_REQUIRED');

    const same = await createScopedActor([realm.buildingA1.id]);
    const inspection = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Same-building actor.',
        },
        same.userId,
      );
    assert.equal(inspection.handymanRequestId, f.request.id);
    assert.equal(await inspectionRows(f.request.id), 1);
    assert.equal(await requestStatus(f.request.id), 'DIAGNOSIS');

    // Diagnosis path: the same request is now DIAGNOSIS.
    const sibling2 = await createScopedActor([realm.buildingA2.id]);
    await assertBuildingDenied(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId,
          diagnosis: 'Sibling actor.',
        },
        sibling2.userId,
      ),
    );
    assert.equal(await diagnosisRows(f.request.id), 0);
    assert.equal(await requestStatus(f.request.id), 'DIAGNOSIS');

    const same2 = await createScopedActor([realm.buildingA1.id]);
    const diagnosis = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId,
          diagnosis: 'Same-building actor.',
        },
        same2.userId,
      );
    assert.equal(diagnosis.handymanRequestId, f.request.id);
    assert.equal(await diagnosisRows(f.request.id), 1);
    assert.equal(await requestStatus(f.request.id), 'READY_FOR_NEXT_STEP');
  });

  it('3: stage resource-read helpers — same building allowed; sibling denied', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();
    const same = await createScopedActor([f.realm.buildingA1.id]);
    const sibling = await createScopedActor([f.realm.buildingA2.id]);

    const triage = await getHandymanRequestTriage(f.request.id, same.userId);
    assert.equal(triage.handymanRequestId, f.request.id);
    await assertBuildingDenied(
      getHandymanRequestTriage(f.request.id, sibling.userId),
    );

    const diagnosis = await getHandymanRequestDiagnosis(
      f.request.id,
      same.userId,
    );
    assert.equal(diagnosis.handymanRequestId, f.request.id);
    await assertBuildingDenied(
      getHandymanRequestDiagnosis(f.request.id, sibling.userId),
    );

    // Inspection read helper on an INSPECTION_REQUIRED-state request.
    const realm2 = await realmFixture();
    const f2 = await requestFixture(realm2);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: f2.request.id,
        triageDisposition: 'INSPECTION_REQUIRED',
        triageNote: 'Needs inspection.',
      },
      adminUserId,
    );
    await handymanServiceRequestInspectionService.recordHandymanInspection(
      {
        handymanRequestId: f2.request.id,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Admin inspection.',
      },
      adminUserId,
    );
    const same2 = await createScopedActor([realm2.buildingA1.id]);
    const sibling2 = await createScopedActor([realm2.buildingA2.id]);
    const inspection = await getHandymanRequestInspection(
      f2.request.id,
      same2.userId,
    );
    assert.equal(inspection.handymanRequestId, f2.request.id);
    await assertBuildingDenied(
      getHandymanRequestInspection(f2.request.id, sibling2.userId),
    );
  });

  it('4: request detail read — same building allowed; sibling and permission-only denied (403, no leak); list keeps per-row wall', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture();

    // Positive: PLATFORM_ADMIN explicitly assigned to the request building
    // passes both the building-scope guard and the C6 SQL wall.
    const same = await createCareReadActor([f.realm.buildingA1.id]);
    const detail = await handymanServiceRequestService
      .getHandymanServiceRequestDetail(f.request.id, same.userId);
    assert.equal(detail.id, f.request.id);
    const res = await api()
      .get(`${HM}/requests/${f.request.id}`)
      .set(auth(same.token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.id, f.request.id);

    // Negative: same-client sibling building — 403, no existence leak.
    const sibling = await createCareReadActor([f.realm.buildingA2.id]);
    await assertBuildingDenied(
      handymanServiceRequestService.getHandymanServiceRequestDetail(
        f.request.id,
        sibling.userId,
      ),
    );
    const resSibling = await api()
      .get(`${HM}/requests/${f.request.id}`)
      .set(auth(sibling.token));
    assert.equal(resSibling.status, 403, JSON.stringify(resSibling.body));
    assert.equal(resSibling.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Negative: permission-only actor — 403.
    const permOnly = await createCareReadActor([]);
    await assertBuildingDenied(
      handymanServiceRequestService.getHandymanServiceRequestDetail(
        f.request.id,
        permOnly.userId,
      ),
    );

    // List (unchanged collection read): the per-row C6 SQL wall stays the
    // building-scoped authority — a sibling actor gets NO rows (empty,
    // not 403/404: the established no-leak posture), the same-building
    // actor sees the row.
    const listed = await handymanServiceRequestService
      .listHandymanServiceRequests(
        { clientId: f.realm.client.id },
        same.userId,
      );
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, f.request.id);
    const listedSibling = await handymanServiceRequestService
      .listHandymanServiceRequests(
        { clientId: f.realm.client.id },
        sibling.userId,
      );
    assert.equal(listedSibling.length, 0);
  });

  it('5: quotation revision + read — same building allowed; sibling denied with zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await quotationFixture();

    // Positive: revision appends version 2 DRAFT.
    const same = await createScopedActor([f.realm.buildingA1.id]);
    const revision = await createHandymanQuotationRevision(
      f.bundle.quotation.id,
      same.userId,
    );
    assert.equal(revision.versionNumber, 2);
    assert.equal(revision.status, 'DRAFT');
    assert.equal(await versionCount(f.bundle.quotation.id), 2);

    const read = await getHandymanQuotation(f.request.id, same.userId);
    assert.equal(read.quotation.id, f.bundle.quotation.id);
    assert.equal(read.versions.length, 2);

    // HTTP: 201 on the revision route.
    const res = await api()
      .post(`${HM}/quotations/${f.bundle.quotation.id}/versions`)
      .set(auth(same.token))
      .send({});
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // Negative: sibling building — revision AND read denied, no mutation.
    const siblingRealm = await realmFixture();
    const sf = await quotationFixtureForRealm(siblingRealm);
    const sibling = await createScopedActor([siblingRealm.buildingA2.id]);
    const eventsBefore = await quotationEventRows(sf.request.id);
    await assertBuildingDenied(
      createHandymanQuotationRevision(sf.bundle.quotation.id, sibling.userId),
    );
    await assertBuildingDenied(
      getHandymanQuotation(sf.request.id, sibling.userId),
    );
    const resRead = await api()
      .get(`${HM}/requests/${sf.request.id}/quotation`)
      .set(auth(sibling.token));
    assert.equal(resRead.status, 403, JSON.stringify(resRead.body));
    assert.equal(resRead.body.error.code, 'BUILDING_ACCESS_DENIED');
    // No mutation on denial.
    assert.equal(await versionCount(sf.bundle.quotation.id), 1);
    assert.equal(await quotationEventRows(sf.request.id), eventsBefore);
  });

  it('6: quotation lines + totals — same building allowed; sibling denied with zero lines', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await quotationFixture();
    const same = await createScopedActor([f.realm.buildingA1.id]);
    const sibling = await createScopedActor([f.realm.buildingA2.id]);

    // Negative first: sibling cannot add a line, list lines, or read totals.
    await assertBuildingDenied(
      addHandymanQuotationLine(
        f.version.id,
        {
          lineType: 'LABOR',
          description: 'Sibling line',
          quantity: 1,
          uomId: randomUUID(),
          currency: 'IDR',
          finalQuotedUnitAmount: 100,
        },
        sibling.userId,
      ),
    );
    await assertBuildingDenied(
      listHandymanQuotationVersionLines(f.version.id, sibling.userId),
    );
    await assertBuildingDenied(
      getHandymanQuotationVersionTotals(f.version.id, sibling.userId),
    );
    assert.equal(await lineRows(f.version.id), 0);

    // Positive: same-building actor adds a line, lists it, reads totals.
    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uomId, f.realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
    );
    const line = await addHandymanQuotationLine(
      f.version.id,
      {
        lineType: 'LABOR',
        description: 'Hours',
        quantity: 2,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      },
      same.userId,
    );
    assert.equal(line.quotationVersionId, f.version.id);
    const lines = await listHandymanQuotationVersionLines(
      f.version.id,
      same.userId,
    );
    assert.equal(lines.length, 1);
    const totals = await getHandymanQuotationVersionTotals(
      f.version.id,
      same.userId,
    );
    assert.equal(totals.total, 200);
    assert.equal(totals.lineCount, 1);
  });

  it('7: issue / expire / supersede — same building allowed; sibling denied with zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    // Issue: sibling denied (version stays DRAFT, no events); the
    // same-building actor issues over HTTP (201).
    const f = await lineFixture();
    const sibling = await createScopedActor([f.realm.buildingA2.id]);
    const eventsBefore = await quotationEventRows(f.request.id);
    await assertBuildingDenied(
      issueHandymanQuotationVersion(
        f.version.id,
        { validUntil: FUTURE() },
        sibling.userId,
      ),
    );
    assert.equal(await versionStatus(f.version.id), 'DRAFT');
    assert.equal(await quotationEventRows(f.request.id), eventsBefore);

    const same = await createScopedActor([f.realm.buildingA1.id]);
    const resIssue = await api()
      .post(`${HM}/quotation-versions/${f.version.id}/issue`)
      .set(auth(same.token))
      .send({ validUntil: FUTURE() });
    assert.equal(resIssue.status, 200, JSON.stringify(resIssue.body));
    assert.equal(await versionStatus(f.version.id), 'ISSUED');

    // Expire: sibling denied (stays ISSUED); same-building expires.
    const realm2 = await realmFixture();
    const f2 = await issuedFixtureForRealm(realm2);
    // Make the version expirable server-side (caller timestamp is never
    // authority — same convention as the lifecycle suite).
    await q(
      `UPDATE handyman_quotation_versions
          SET valid_until = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [f2.version.id],
    );
    const sibling2 = await createScopedActor([realm2.buildingA2.id]);
    await assertBuildingDenied(
      expireHandymanQuotationVersion(f2.version.id, sibling2.userId),
    );
    assert.equal(await versionStatus(f2.version.id), 'ISSUED');
    const same2 = await createScopedActor([realm2.buildingA1.id]);
    const expired = await expireHandymanQuotationVersion(
      f2.version.id,
      same2.userId,
    );
    assert.equal(expired.status, 'EXPIRED');

    // Supersede: sibling denied (stays ISSUED); same-building supersedes.
    const realm3 = await realmFixture();
    const f3 = await issuedFixtureForRealm(realm3);
    const sibling3 = await createScopedActor([realm3.buildingA2.id]);
    await assertBuildingDenied(
      supersedeHandymanQuotationVersion(f3.version.id, sibling3.userId),
    );
    assert.equal(await versionStatus(f3.version.id), 'ISSUED');
    const same3 = await createScopedActor([realm3.buildingA1.id]);
    const superseded = await supersedeHandymanQuotationVersion(
      f3.version.id,
      same3.userId,
    );
    assert.equal(superseded.status, 'SUPERSEDED');
  });

  it('8: decision (decide + read) — same building allowed; sibling and permission-only denied with zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const same = await createScopedActor([f.realm.buildingA1.id]);

    // Positive: the same-building actor decides over HTTP (201) — REJECT
    // creates no execution scope.
    const resDecide = await api()
      .post(`${HM}/quotation-versions/${f.version.id}/decision`)
      .set(auth(same.token))
      .set('Idempotency-Key', `http-${randomUUID()}`)
      .send({ decision: 'REJECT' });
    assert.equal(resDecide.status, 201, JSON.stringify(resDecide.body));
    assert.equal(await decisionRows(f.version.id), 1);
    assert.equal(await scopeRows(f.version.id), 0);

    const read = await getHandymanQuotationDecision(f.version.id, same.userId);
    assert.equal(read.decision, 'REJECT');

    // Negative: sibling and permission-only actors can neither decide nor
    // read the decision (403, no content leak); nothing mutates.
    const sibling = await createScopedActor([f.realm.buildingA2.id]);
    const permOnly = await createScopedActor([]);
    const eventsBefore = await quotationEventRows(f.request.id);
    await assertBuildingDenied(
      decideHandymanQuotation(
        f.version.id,
        { decision: 'APPROVE', idempotencyKey: `sib-${randomUUID()}` },
        sibling.userId,
      ),
    );
    await assertBuildingDenied(
      decideHandymanQuotation(
        f.version.id,
        { decision: 'APPROVE', idempotencyKey: `perm-${randomUUID()}` },
        permOnly.userId,
      ),
    );
    await assertBuildingDenied(
      getHandymanQuotationDecision(f.version.id, sibling.userId),
    );
    await assertBuildingDenied(
      getHandymanQuotationDecision(f.version.id, permOnly.userId),
    );
    // No mutation on denial: still exactly the one REJECT decision, no
    // scope, no new events.
    assert.equal(await decisionRows(f.version.id), 1);
    assert.equal(await scopeRows(f.version.id), 0);
    assert.equal(await quotationEventRows(f.request.id), eventsBefore);
  });

  it('9: execution-scope read + presented read — same building allowed; sibling denied', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const same = await createScopedActor([f.realm.buildingA1.id]);

    // Positive: presented read while the version is ISSUED (APPROVE later
    // transitions ISSUED -> APPROVED, leaving no ISSUED version).
    const presented = await getCurrentHandymanIssuedQuotationVersion(
      f.request.id,
      same.userId,
    );
    assert.ok(presented);
    assert.equal(presented?.id, f.version.id);

    // APPROVE by the same-building actor creates the execution scope.
    const approved = await decideHandymanQuotation(
      f.version.id,
      { decision: 'APPROVE', idempotencyKey: `appr-${randomUUID()}` },
      same.userId,
    );
    assert.ok(approved.executionScope);
    assert.equal(await scopeRows(f.version.id), 1);

    // Positive: execution-scope read (the scope carries its own
    // authoritative building_id location snapshot).
    const scope = await getHandymanExecutionScopeByQuotationVersion(
      f.version.id,
      same.userId,
    );
    assert.equal(scope.buildingId, f.realm.buildingA1.id);
    assert.equal(scope.clientId, f.realm.client.id);

    // Negative: sibling actor denied on both reads (403, no leak).
    const sibling = await createScopedActor([f.realm.buildingA2.id]);
    await assertBuildingDenied(
      getCurrentHandymanIssuedQuotationVersion(f.request.id, sibling.userId),
    );
    await assertBuildingDenied(
      getHandymanExecutionScopeByQuotationVersion(f.version.id, sibling.userId),
    );
    const resPresented = await api()
      .get(`${HM}/requests/${f.request.id}/quotation/presented`)
      .set(auth(sibling.token));
    assert.equal(resPresented.status, 403, JSON.stringify(resPresented.body));
    assert.equal(resPresented.body.error.code, 'BUILDING_ACCESS_DENIED');
    const resScope = await api()
      .get(`${HM}/quotation-versions/${f.version.id}/execution-scope`)
      .set(auth(sibling.token));
    assert.equal(resScope.status, 403, JSON.stringify(resScope.body));
    assert.equal(resScope.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
