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
import { credentialService } from '../src/modules/auth';
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import {
  createChannelAttribution,
} from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService }
  from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-00D-2B — minimal RUNTIME integration proof for the Handyman chain
 * Request → Quotation → Issue → Decision → Assignment, driven through the
 * real HTTP routes (app → router → controller → service → repository →
 * SQL/migration). Six cases: happy path, forbidden actor (RBAC + Client
 * realm), cross-tenant/cross-property, invalid state, duplicate decision,
 * duplicate assignment. Fixtures are per-case; no production code changes.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let token = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendors, workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  token = admin.token;
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

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const HM = '/api/v1/handyman';
const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });
const errCode = (res: { body: { error?: { code?: string } } }) =>
  res.body.error?.code;
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

/** Session whose user identity is known (actor = session, never body). */
async function manageSessionWithUser() {
  const sfx = suffix().toLowerCase();
  const user = await userService.createUser({
    email: `chain-mgr-${sfx}@example.com`,
    displayName: 'Chain Manager',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ChainPass123',
  });
  const role = await roleService.createRole({
    code: `CHAIN_${suffix()}`,
    name: 'Chain Manager Role',
  });
  const existing = await permissionRepository.findByCode(
    'tenant_company.manage',
  );
  const permissionId = existing
    ? existing.id
    : (await permissionService.createPermission({
      code: 'tenant_company.manage',
      name: 'Manage Tenant Companies',
    })).id;
  await permissionService.assignPermissionToRole(role.id, permissionId);
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'ChainPass123',
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

/** Client → Property → Building (+ HR anchors) with admin realm access. */
async function realm(label: string) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: `${label} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: `${label} Building`,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Worker Position',
  });
  return { client, property, building, organization, department, position };
}

/** floor → area → room → space inside one building. */
async function spaceIn(buildingId: string) {
  const floor = await floorService.createFloor({
    buildingId,
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
  return spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
}

/**
 * Chain fixture up to a CHANNEL ATTRIBUTION (the Request lineage source):
 * tenant company + PIC + space linked to building, BM_SUPER_APP attribution,
 * active service in the same Client, and a Client-scoped UOM.
 */
async function requestFixture() {
  const r = await realm('Owner');
  const space = await spaceIn(r.building.id);
  const company = await tenantCompanyService.createTenantCompany({
    clientId: r.client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: r.building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: r.building.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: r.building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: r.building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: r.client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'FM_HINT_TEXT',
  }, adminUserId);
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, r.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  return { ...r, space, company, pic, linkedUser, attribution, service, uomId };
}

/** Crew with an ACTIVE, login-capable Lead (assignment prerequisite). */
async function crewFixture(f: Awaited<ReturnType<typeof requestFixture>>) {
  const vendor = await vendorService.createVendor({
    clientId: f.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Field Providers',
  });
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  const leadUser = await userService.createUser({
    email: `lead-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Lead',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: f.organization.id,
    departmentId: f.department.id,
    positionId: f.position.id,
    employeeCode: `LEAD_${suffix()}`,
    fullName: 'Lead Worker',
    workforceType: 'EXTERNAL',
    userId: leadUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `CREW_${suffix()}`,
      name: 'Field Crew',
      leadWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  return { providerContextId: providerContext.id, crewId: bundle.crew.id };
}

/** Request intake through HTTP (actor = bearer session). */
async function intakeHttp(
  f: Awaited<ReturnType<typeof requestFixture>>,
  bearer = token,
) {
  return api().post(`${HM}/requests`).set(auth(bearer)).send({
    channelAttributionId: f.attribution.id,
    serviceCatalogId: f.service.id,
  });
}

/** Intake → triage(DIAGNOSIS) → diagnosis, all through HTTP. */
async function diagnosedRequestHttp(
  f: Awaited<ReturnType<typeof requestFixture>>,
): Promise<string> {
  const intake = await intakeHttp(f);
  assert.equal(intake.status, 201, JSON.stringify(intake.body));
  const requestId = intake.body.data.id as string;
  const triage = await api()
    .post(`${HM}/requests/${requestId}/triage`)
    .set(auth())
    .send({ disposition: 'DIAGNOSIS', note: 'Direct to diagnosis.' });
  assert.equal(triage.status, 201, JSON.stringify(triage.body));
  const diagnosis = await api()
    .post(`${HM}/requests/${requestId}/diagnosis`)
    .set(auth())
    .send({ disciplineId, diagnosis: 'Chain runtime diagnosis.' });
  assert.equal(diagnosis.status, 201, JSON.stringify(diagnosis.body));
  return requestId;
}

/** Quotation v1 → LABOR line → ISSUED (HTTP). Returns ids. */
async function issuedQuotationHttp(
  f: Awaited<ReturnType<typeof requestFixture>>,
  requestId: string,
) {
  const created = await api()
    .post(`${HM}/requests/${requestId}/quotation`)
    .set(auth());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const versionId = created.body.data.versions[0].id as string;
  const line = await api()
    .post(`${HM}/quotation-versions/${versionId}/lines`)
    .set(auth())
    .send({
      lineType: 'LABOR',
      description: 'Labor hours',
      quantity: 1,
      uomId: f.uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const issued = await api()
    .post(`${HM}/quotation-versions/${versionId}/issue`)
    .set(auth())
    .send({ validUntil: FUTURE() });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.data.status, 'ISSUED');
  return {
    quotationId: created.body.data.quotation.id as string,
    versionId,
  };
}

/** Customer APPROVE through HTTP with an Idempotency-Key. */
async function approveHttp(versionId: string, key: string, bearer = token) {
  return api()
    .post(`${HM}/quotation-versions/${versionId}/decision`)
    .set(auth(bearer))
    .set('Idempotency-Key', key)
    .send({ decision: 'APPROVE' });
}

describe('CR-HM-00D-2B — Handyman Request→Quotation→Issue→Decision→Assignment runtime', () => {
  it('1: happy path — full HTTP chain produces AUTHORIZED scope and ACTIVE assignment', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const requestId = await diagnosedRequestHttp(f);
    const { versionId, quotationId } = await issuedQuotationHttp(f, requestId);

    const decision = await approveHttp(versionId, `k-${randomUUID()}`);
    assert.equal(decision.status, 201, JSON.stringify(decision.body));
    assert.equal(decision.body.data.decision, 'APPROVE');
    const scope = decision.body.data.executionScope;
    assert.ok(scope?.id, 'APPROVE must return the authoritative scope');
    assert.equal(scope.status, 'AUTHORIZED');
    assert.equal(scope.handymanRequestId, requestId);
    assert.equal(scope.quotationId, quotationId);
    assert.equal(scope.approvedQuotationVersionId, versionId);
    assert.equal(scope.buildingId, f.building.id);
    assert.equal(scope.spaceId, f.space.id);

    const crew = await crewFixture(f);
    const assigned = await api()
      .post(`${HM}/execution-scopes/${scope.id}/assignment`)
      .set(auth())
      .send({
        providerContextId: crew.providerContextId,
        crewId: crew.crewId,
      });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.status, 'ACTIVE');
    assert.equal(assigned.body.data.executionScopeId, scope.id);
    assert.equal(assigned.body.data.handymanCrewId, crew.crewId);

    const versions = await q(
      `SELECT status FROM handyman_quotation_versions
        WHERE quotation_id = $1 ORDER BY version_number`,
      [quotationId],
    );
    assert.deepEqual(versions.rows.map((r: { status: string }) => r.status),
      ['APPROVED']);
    const activeRows = await q(
      `SELECT count(*)::int AS n FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 AND status = 'ACTIVE'`,
      [scope.id],
    );
    assert.equal(activeRows.rows[0].n, 1);
  });

  it('2: forbidden actor — read-only RBAC is 403 and a manage user without Client realm is denied on the chain', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const requestId = await diagnosedRequestHttp(f);
    const { versionId } = await issuedQuotationHttp(f, requestId);

    // RBAC: a read-only session cannot mutate (tenant_company.manage gate).
    const readOnly = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    const rbac = await api()
      .post(`${HM}/requests/${requestId}/quotation`)
      .set(auth(readOnly));
    assert.equal(rbac.status, 403);

    // Realm: manage permission but NO building assignment under the Client.
    const outsider = await manageSessionWithUser();
    const intake = await intakeHttp(f, outsider.token);
    assert.equal(intake.status, 403, JSON.stringify(intake.body));
    assert.equal(errCode(intake), 'BUILDING_ACCESS_DENIED');
    const quote = await api()
      .post(`${HM}/requests/${requestId}/quotation`)
      .set(auth(outsider.token));
    assert.equal(quote.status, 403);
    assert.equal(errCode(quote), 'BUILDING_ACCESS_DENIED');
    const decision = await approveHttp(versionId, `k-${randomUUID()}`,
      outsider.token);
    assert.equal(decision.status, 403);
    assert.equal(errCode(decision), 'BUILDING_ACCESS_DENIED');

    // Denied actor left no decision and no scope behind.
    const rows = await q(
      `SELECT
         (SELECT count(*)::int FROM handyman_quotation_decisions
           WHERE quotation_version_id = $1) AS decisions,
         (SELECT count(*)::int FROM handyman_execution_scopes
           WHERE approved_quotation_version_id = $1) AS scopes`,
      [versionId],
    );
    assert.equal(rows.rows[0].decisions, 0);
    assert.equal(rows.rows[0].scopes, 0);
  });

  it('3: cross-property/cross-tenant — other-Client actor is denied and a space from another building cannot bind the Request lineage', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const requestId = await diagnosedRequestHttp(f);
    const { versionId } = await issuedQuotationHttp(f, requestId);

    // Other Client/Property actor: holds manage + an ACTIVE assignment, but
    // only under a different Client. Must not act on this Client's chain.
    const other = await realm('Foreign');
    const foreign = await manageSessionWithUser();
    await buildingAssignmentService.createAssignment(foreign.userId, {
      buildingId: other.building.id,
    });
    const intake = await intakeHttp(f, foreign.token);
    assert.equal(intake.status, 403, JSON.stringify(intake.body));
    assert.equal(errCode(intake), 'BUILDING_ACCESS_DENIED');
    const decision = await approveHttp(versionId, `k-${randomUUID()}`,
      foreign.token);
    assert.equal(decision.status, 403);
    assert.equal(errCode(decision), 'BUILDING_ACCESS_DENIED');

    // Lineage cannot cross buildings: attribution claims building A but the
    // space belongs to (and is tenant-linked only in) building B.
    const propertyB = await propertyService.createProperty({
      clientId: f.client.id,
      code: `P_${suffix()}`,
      name: 'Sibling Property',
    });
    const buildingB = await buildingService.createBuilding({
      propertyId: propertyB.id,
      code: `B_${suffix()}`,
      name: 'Sibling Building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: buildingB.id,
    });
    const spaceB = await spaceIn(buildingB.id);
    await tenantSpaceService.assignSpaceToTenant({
      tenantCompanyId: f.company.id,
      buildingId: buildingB.id,
      spaceId: spaceB.id,
    }, adminUserId);
    await tenantBuildingContextService.createTenantBuildingContext({
      tenantCompanyId: f.company.id,
      buildingId: buildingB.id,
    }, adminUserId);
    await assert.rejects(
      createChannelAttribution({
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        tenantPicId: f.pic.id,
        spaceId: spaceB.id,
        originChannel: 'BM_SUPER_APP',
        originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
        createdByUserId: f.linkedUser.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code
          === 'HANDYMAN_CHANNEL_ATTRIBUTION_SPACE_MISMATCH',
    );
  });

  it('4: invalid state — decision on an unissued DRAFT and assignment before approval are rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const requestId = await diagnosedRequestHttp(f);
    const created = await api()
      .post(`${HM}/requests/${requestId}/quotation`)
      .set(auth());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const draftId = created.body.data.versions[0].id as string;

    const early = await approveHttp(draftId, `k-${randomUUID()}`);
    assert.equal(early.status, 400, JSON.stringify(early.body));
    assert.equal(errCode(early), 'HANDYMAN_QUOTATION_INVALID_TRANSITION');

    const noScope = await api()
      .post(`${HM}/execution-scopes/${randomUUID()}/assignment`)
      .set(auth())
      .send({ providerContextId: randomUUID(), crewId: randomUUID() });
    assert.equal(noScope.status, 404);
    assert.equal(errCode(noScope), 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');

    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_quotation_decisions
        WHERE quotation_version_id = $1`,
      [draftId],
    );
    assert.equal(rows.rows[0].n, 0);
  });

  it('5: duplicate decision — same-key replay returns the original decision and scope; conflicting decision is 409', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const requestId = await diagnosedRequestHttp(f);
    const { versionId } = await issuedQuotationHttp(f, requestId);
    const key = `k-${randomUUID()}`;

    const first = await approveHttp(versionId, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const replay = await approveHttp(versionId, key);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(replay.body.data.executionScope.id,
      first.body.data.executionScope.id);

    const conflicting = await api()
      .post(`${HM}/quotation-versions/${versionId}/decision`)
      .set(auth())
      .set('Idempotency-Key', key)
      .send({ decision: 'REJECT' });
    assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
    assert.equal(errCode(conflicting), 'HANDYMAN_QUOTATION_DECISION_CONFLICT');

    const second = await approveHttp(versionId, `k-${randomUUID()}`);
    assert.equal(second.status, 409);
    assert.equal(errCode(second), 'HANDYMAN_QUOTATION_DECISION_CONFLICT');

    const counts = await q(
      `SELECT
         (SELECT count(*)::int FROM handyman_quotation_decisions
           WHERE quotation_version_id = $1) AS decisions,
         (SELECT count(*)::int FROM handyman_execution_scopes
           WHERE approved_quotation_version_id = $1) AS scopes`,
      [versionId],
    );
    assert.equal(counts.rows[0].decisions, 1);
    assert.equal(counts.rows[0].scopes, 1);
  });

  it('6: duplicate assignment — a second assignment while ACTIVE exists is 409 and leaves one ACTIVE row', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const requestId = await diagnosedRequestHttp(f);
    const { versionId } = await issuedQuotationHttp(f, requestId);
    const approved = await approveHttp(versionId, `k-${randomUUID()}`);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const scopeId = approved.body.data.executionScope.id as string;
    const crew = await crewFixture(f);
    const body = {
      providerContextId: crew.providerContextId,
      crewId: crew.crewId,
    };

    const first = await api()
      .post(`${HM}/execution-scopes/${scopeId}/assignment`)
      .set(auth()).send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await api()
      .post(`${HM}/execution-scopes/${scopeId}/assignment`)
      .set(auth()).send(body);
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(errCode(duplicate),
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONFLICT');

    const rows = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'ACTIVE')::int AS active
         FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1`,
      [scopeId],
    );
    assert.equal(rows.rows[0].total, 1);
    assert.equal(rows.rows[0].active, 1);
  });
});
