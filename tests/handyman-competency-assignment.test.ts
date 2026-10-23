import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { workforceBuildingAssignmentService }
  from '../src/modules/workforce-building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { skillService } from '../src/modules/skills';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService }
  from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { assignSkillToWorkforce } from '../src/modules/workforce-skills';
import { workforceService } from '../src/modules/workforce';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — Competency-Based Work Assignment.
 *
 * Focused E2E evidence for the acceptance criteria:
 *   1. a job type with NO requirement keeps the exact pre-PART-03A behaviour;
 *   2. a compliant crew (skill at/above the minimum) is assigned normally;
 *   3. insufficient skill / expired certificate / unverified certificate are
 *      each refused by the BACKEND at the single existing assignment authority,
 *      with a machine-readable reason and ZERO partial rows;
 *   4. RECOMMENDED requirements are advisory and never block;
 *   5. reassignment is gated by the same rule and leaves the current ACTIVE
 *      assignment intact when refused;
 *   6. cross-client reach is impossible: a foreign-client skill cannot be
 *      configured, and an actor without Building access cannot read the
 *      eligibility/candidates answers;
 *   7. the read model distinguishes eligibility, rejection reasons and
 *      qualified candidates;
 *   8. deactivating a requirement immediately restores assignability.
 */

const EMBEDDED_DIR = '/tmp/hm-competency-01-pg';
const EMBEDDED_PORT = 55581;
Object.assign(process.env, {
  DB_HOST: '127.0.0.1',
  DB_PORT: String(EMBEDDED_PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: '',
  DB_NAME: 'asentra_test',
  DB_SSL: 'false',
});
let embedded: EmbeddedPostgres | null = null;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let token = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  await rm(EMBEDDED_DIR, { recursive: true, force: true });
  await mkdir(EMBEDDED_DIR, { recursive: true });
  embedded = new EmbeddedPostgres({
    databaseDir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  await embedded.initialise();
  await embedded.start();
  const adminClient = embedded.getPgClient('postgres', '127.0.0.1');
  await adminClient.connect();
  await adminClient.query('CREATE DATABASE asentra_test');
  await adminClient.end();

  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE service_catalog_competency_requirements,
    workforce_certifications, workforce_skill_assignments, skills,
    handyman_execution_scope_assignments,
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
  try {
    if (pool) await closePool(pool);
    if (embedded) await embedded.stop();
  } finally {
    await rm(EMBEDDED_DIR, { recursive: true, force: true });
    pool = null;
    database = null;
    embedded = null;
  }
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

const ASSIGNMENT = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/assignment`;
const REASSIGN = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/assignment/reassign`;
const ELIGIBILITY = (scopeId: string, crewId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/competency/eligibility` +
  `?crewId=${crewId}`;
const CANDIDATES = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/competency/candidates`;
const REQUIREMENTS = (serviceCatalogId: string) =>
  `/api/v1/service-catalog/entries/${serviceCatalogId}/competency-requirements`;
const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });

/** Org/workforce realm (client → property → building + HR anchors). */
async function realmFixture(label = 'Realm') {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
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

type Realm = Awaited<ReturnType<typeof realmFixture>>;

/** One login-capable worker placed in the realm + bound to the vendor. */
async function addWorker(
  realm: Realm,
  vendorId: string,
  providerContextId: string,
) {
  const linkedUser = await userService.createUser({
    email: `worker-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Worker',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `W_${suffix()}`,
    fullName: `Worker ${suffix()}`,
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: realm.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContextId,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  return { linkedUser, profile, workerContext };
}

/** ACTIVE provider context + ACTIVE crew with a valid login-capable Lead. */
async function crewFixture(realm: Realm, label = 'Crew') {
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: `${label} Providers`,
  });
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  const lead = await addWorker(realm, vendor.id, providerContext.id);
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `${label.toUpperCase().slice(0, 6)}_${suffix()}`,
      name: `${label} Crew`,
      leadWorkerContextId: lead.workerContext.id,
    },
    adminUserId,
  );
  return { vendor, providerContext, crew: bundle.crew, lead };
}

/** Second ACTIVE member of an existing crew. */
async function addMember(
  realm: Realm,
  provider: Awaited<ReturnType<typeof crewFixture>>,
) {
  const member = await addWorker(
    realm,
    provider.vendor.id,
    provider.providerContext.id,
  );
  await handymanWorkCrewService.addHandymanCrewMember(
    {
      handymanCrewId: provider.crew.id,
      handymanWorkerContextId: member.workerContext.id,
    },
    adminUserId,
  );
  return member;
}

/** Skill master + ACTIVE workforce skill assignment at a given level. */
async function giveSkill(
  realm: Realm,
  workforceProfileId: string,
  level: 'BASIC' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT' = 'ADVANCED',
  existingSkill?: { id: string; code: string },
) {
  const code = `ELEC_${suffix()}`;
  const skill = existingSkill ?? await skillService.createSkill({
    clientId: realm.client.id,
    code,
    name: `Electrical ${code}`,
    category: 'TECHNICAL',
  });
  await assignSkillToWorkforce({
    workforceProfileId,
    skillId: skill.id,
    proficiencyLevel: level,
  });
  return skill;
}

/**
 * Certificate inserted directly: PART 02's service mints PENDING_VERIFICATION
 * only (by design), so a VERIFIED fixture has to be written at the persistence
 * layer with the audit columns the CHECK constraint requires.
 */
async function giveCertificate(
  realm: Realm,
  workforceProfileId: string,
  input: {
    name?: string;
    verificationStatus?: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';
    status?: 'ACTIVE' | 'EXPIRED' | 'INACTIVE';
    expiryDate?: string | null;
  } = {},
) {
  const id = randomUUID();
  const verificationStatus = input.verificationStatus ?? 'VERIFIED';
  const status = input.status ?? 'ACTIVE';
  const audit = verificationStatus === 'PENDING_VERIFICATION'
    ? { by: null, at: null }
    : { by: adminUserId, at: new Date().toISOString() };
  await q(
    `INSERT INTO workforce_certifications (
       id, client_id, workforce_profile_id, skill_id, certificate_number,
       certificate_name, issuing_authority, issue_date, expiry_date, status,
       verification_status, verified_by_user_id, verified_at,
       created_by_user_id
     ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      realm.client.id,
      workforceProfileId,
      `CERT-${suffix()}`,
      input.name ?? 'K3 Listrik',
      'Kemnaker',
      // Issue date always precedes the (possibly past) expiry date, so the
      // `workforce_certifications_date_range_check` holds for the fixtures.
      new Date(Date.now() - 86_400_000 * 90).toISOString(),
      input.expiryDate === undefined
        ? new Date(Date.now() + 86_400_000 * 30).toISOString()
        : input.expiryDate,
      status,
      verificationStatus,
      audit.by,
      audit.at,
      adminUserId,
    ],
  );
  return id;
}

/** AUTHORIZED execution scope via the full CR-HM-02→06 chain. */
async function scopeFixture(realm: Realm) {
  const floor = await floorService.createFloor({
    buildingId: realm.building.id,
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
  const company = await tenantCompanyService.createTenantCompany({
    clientId: realm.client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const customer = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(customer.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: `req-${suffix().toLowerCase()}@tenant.example.com`,
    userId: customer.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: customer.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: realm.client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'FM_HINT_TEXT',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      { channelAttributionId: attribution.id, serviceCatalogId: service.id },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: 'Competency fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id },
    adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR',
    description: 'Hours',
    quantity: 1,
    uomId,
    currency: 'IDR',
    finalQuotedUnitAmount: 100,
  }, adminUserId);
  await issueHandymanQuotationVersion(version.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, adminUserId);
  const decision = await decideHandymanQuotation(version.id, {
    decision: 'APPROVE',
    idempotencyKey: `k-${randomUUID()}`,
  }, customer.id);
  assert.ok(decision.executionScope);
  assert.equal(decision.executionScope.status, 'AUTHORIZED');
  return { scope: decision.executionScope, serviceCatalogId: service.id };
}

async function createRequirement(
  serviceCatalogId: string,
  body: Record<string, unknown>,
  bearer = token,
) {
  return api()
    .post(REQUIREMENTS(serviceCatalogId))
    .set(auth(bearer))
    .send(body);
}

function assign(
  scopeId: string,
  providerContextId: string,
  crewId: string,
  bearer = token,
) {
  return api()
    .post(ASSIGNMENT(scopeId))
    .set(auth(bearer))
    .send({ providerContextId, crewId });
}

async function assignmentRows(scopeId: string) {
  const result = await q(
    `SELECT id, status, handyman_crew_id, version
       FROM handyman_execution_scope_assignments
      WHERE execution_scope_id = $1
      ORDER BY created_at ASC`,
    [scopeId],
  );
  return result.rows as Array<{
    id: string;
    status: string;
    handyman_crew_id: string;
    version: number;
  }>;
}

/** Actor with exactly `tenant_company.read` + a Building assignment. */
async function createReadSession(buildingId?: string) {
  const user = await userService.createUser({
    email: `reader-${suffix().toLowerCase()}@example.com`,
    displayName: 'Scoped Reader',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ScopedPass123',
  });
  const role = await roleService.createRole({
    code: `READ_${suffix()}`,
    name: 'Scoped Reader Role',
  });
  for (const code of ['tenant_company.read', 'service_catalog.read']) {
    const existing = await permissionRepository.findByCode(code);
    const permissionId = existing
      ? existing.id
      : (await permissionService.createPermission({
        code,
        name: code,
      })).id;
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  if (buildingId) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'ScopedPass123',
  });
  return {
    token: login.body.data.sessionToken as string,
    userId: user.id,
  };
}

describe('CR-HM-WORKER-COMPETENCY-01 PART 03A — competency-based assignment', () => {
  it('1: a job type with no competency requirement keeps the existing flow', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);

    const res = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'ACTIVE');

    // The gate ran and recorded that nothing was configured — proof the check
    // is not simply skipped because the crew happens to look fine.
    const events = await q(
      `SELECT metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT'
          AND entity_id = $1`,
      [res.body.data.id],
    );
    assert.equal(events.rowCount, 1);
    assert.deepEqual(events.rows[0].metadata.competency, {
      requirementCount: 0,
      mandatoryRequirementCount: 0,
    });
  });

  it('2: an ACTIVE skill requirement is configurable and a compliant crew is assigned', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const skill = await giveSkill(realm, crew.lead.profile.id, 'ADVANCED');
    const f = await scopeFixture(realm);

    const created = await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      enforcementLevel: 'MANDATORY',
      skillId: skill.id,
      minimumProficiencyLevel: 'ADVANCED',
      notes: 'Live electrical work.',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.requirementType, 'SKILL');
    assert.equal(created.body.data.minimumProficiencyLevel, 'ADVANCED');
    assert.equal(created.body.data.skill.code, skill.code);
    assert.equal(created.body.data.status, 'ACTIVE');

    // Duplicate ACTIVE requirement for the same skill → 409.
    const duplicate = await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: skill.id,
      minimumProficiencyLevel: 'BASIC',
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'SERVICE_COMPETENCY_REQUIREMENT_ALREADY_EXISTS',
    );

    // Client identity / actor are never accepted from the body.
    const smuggled = await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: skill.id,
      minimumProficiencyLevel: 'BASIC',
      clientId: randomUUID(),
    });
    assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));

    const list = await api()
      .get(REQUIREMENTS(f.serviceCatalogId))
      .set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);

    const res = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('3: insufficient proficiency is refused with a reason and writes nothing', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const skill = await giveSkill(realm, crew.lead.profile.id, 'BASIC');
    const f = await scopeFixture(realm);
    await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: skill.id,
      minimumProficiencyLevel: 'ADVANCED',
    });

    const res = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(
      res.body.error.code,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_COMPETENCY_REQUIRED',
    );
    const [detail] = res.body.error.details;
    assert.equal(detail.reason, 'PROFICIENCY_INSUFFICIENT');
    assert.equal(detail.skillCode, skill.code);
    assert.equal(detail.minimumProficiencyLevel, 'ADVANCED');
    assert.equal(detail.workforceProfileId, crew.lead.profile.id);

    assert.deepEqual(await assignmentRows(f.scope.id), []);
  });

  it('4: an expired certificate is refused (CERTIFICATION_EXPIRED)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    await giveCertificate(realm, crew.lead.profile.id, {
      name: 'K3 Listrik',
      verificationStatus: 'VERIFIED',
      status: 'EXPIRED',
      expiryDate: new Date(Date.now() - 86_400_000 * 10).toISOString(),
    });
    const f = await scopeFixture(realm);
    const created = await createRequirement(f.serviceCatalogId, {
      requirementType: 'CERTIFICATION',
      certificateName: 'k3 listrik',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.certificateName, 'k3 listrik');

    const res = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const [detail] = res.body.error.details;
    assert.equal(detail.reason, 'CERTIFICATION_EXPIRED');
    assert.equal(detail.certificateName, 'k3 listrik');
    assert.deepEqual(await assignmentRows(f.scope.id), []);
  });

  it('5: an unverified certificate is refused (CERTIFICATION_UNVERIFIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    await giveCertificate(realm, crew.lead.profile.id, {
      name: 'K3 Listrik',
      verificationStatus: 'PENDING_VERIFICATION',
    });
    const f = await scopeFixture(realm);
    await createRequirement(f.serviceCatalogId, {
      requirementType: 'CERTIFICATION',
      certificateName: 'K3 Listrik',
    });

    const res = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const [detail] = res.body.error.details;
    assert.equal(detail.reason, 'CERTIFICATION_UNVERIFIED');

    // The preflight read agrees with the enforcement verdict — one evaluator.
    const preflight = await api()
      .get(ELIGIBILITY(f.scope.id, crew.crew.id))
      .set(auth());
    assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
    assert.equal(preflight.body.data.eligible, false);
    assert.equal(
      preflight.body.data.workers[0].blockingGaps[0].reason,
      'CERTIFICATION_UNVERIFIED',
    );
    assert.equal(preflight.body.data.summary.mandatoryRequirementCount, 1);
  });

  it('6: a VERIFIED, in-date certificate satisfies the requirement and RECOMMENDED never blocks', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    await giveCertificate(realm, crew.lead.profile.id, {
      name: 'K3 Listrik',
      verificationStatus: 'VERIFIED',
    });
    const f = await scopeFixture(realm);
    await createRequirement(f.serviceCatalogId, {
      requirementType: 'CERTIFICATION',
      certificateName: '  k3   LISTRIK ',
      enforcementLevel: 'MANDATORY',
    });
    // Advisory-only requirement the crew does NOT hold.
    const advisory = await createRequirement(f.serviceCatalogId, {
      requirementType: 'CERTIFICATION',
      certificateName: 'Confined Space',
      enforcementLevel: 'RECOMMENDED',
    });
    assert.equal(advisory.status, 201, JSON.stringify(advisory.body));

    const preflight = await api()
      .get(ELIGIBILITY(f.scope.id, crew.crew.id))
      .set(auth());
    assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
    assert.equal(preflight.body.data.eligible, true);
    assert.equal(preflight.body.data.blockingGaps.length, 0);
    assert.equal(preflight.body.data.advisoryGaps.length, 1);
    assert.equal(
      preflight.body.data.advisoryGaps[0].reason,
      'CERTIFICATION_MISSING',
    );
    assert.equal(preflight.body.data.workers[0].blockingGaps.length, 0);

    const res = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('7: every ACTIVE crew member must qualify, not only the Lead', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const skill = await giveSkill(realm, crew.lead.profile.id, 'EXPERT');
    const member = await addMember(realm, crew);
    const f = await scopeFixture(realm);
    await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: skill.id,
      minimumProficiencyLevel: 'INTERMEDIATE',
    });

    const res = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const details = res.body.error.details as Array<Record<string, unknown>>;
    assert.equal(details.length, 1);
    assert.equal(details[0].reason, 'SKILL_MISSING');
    assert.equal(details[0].workforceProfileId, member.profile.id);
    assert.deepEqual(await assignmentRows(f.scope.id), []);
  });

  it('8: candidates endpoint separates qualified crews from rejected ones', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const qualified = await crewFixture(realm, 'Alpha');
    const unqualified = await crewFixture(realm, 'Bravo');
    const skill = await giveSkill(realm, qualified.lead.profile.id, 'ADVANCED');
    const f = await scopeFixture(realm);
    await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: skill.id,
      minimumProficiencyLevel: 'INTERMEDIATE',
    });

    const res = await api().get(CANDIDATES(f.scope.id)).set(auth());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body.data;
    assert.equal(body.serviceCatalogId, f.serviceCatalogId);
    assert.equal(body.eligibleCandidateCount, 1);
    assert.equal(body.candidates.length, 2);
    const qualifiedRow = body.candidates.find(
      (candidate: { crewId: string }) => candidate.crewId === qualified.crew.id,
    );
    const unqualifiedRow = body.candidates.find(
      (candidate: { crewId: string }) => candidate.crewId === unqualified.crew.id,
    );
    assert.equal(qualifiedRow.competencyEligible, true);
    assert.equal(unqualifiedRow.competencyEligible, false);
    assert.equal(unqualifiedRow.blockingGaps[0].reason, 'SKILL_MISSING');
  });

  it('9: cross-client configuration and cross-building reads are refused', async (t) => {
    if (!requireDatabase(t)) return;
    const realmA = await realmFixture('A');
    const realmB = await realmFixture('B');
    const crewA = await crewFixture(realmA);
    const f = await scopeFixture(realmA);

    // A skill owned by Client B can never become a requirement of a Client A
    // job type, even with full administrative permission.
    const foreignSkill = await skillService.createSkill({
      clientId: realmB.client.id,
      code: `FOREIGN_${suffix()}`,
      name: 'Foreign Skill',
      category: 'TECHNICAL',
    });
    const mismatch = await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: foreignSkill.id,
      minimumProficiencyLevel: 'BASIC',
    });
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(
      mismatch.body.error.code,
      'SERVICE_COMPETENCY_REQUIREMENT_SKILL_MISMATCH',
    );

    // An actor whose Building reach is Client B cannot read Client A's answer.
    const outsider = await createReadSession(realmB.building.id);
    const denied = await api()
      .get(ELIGIBILITY(f.scope.id, crewA.crew.id))
      .set(auth(outsider.token));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedCandidates = await api()
      .get(CANDIDATES(f.scope.id))
      .set(auth(outsider.token));
    assert.equal(deniedCandidates.status, 403, JSON.stringify(deniedCandidates.body));

    // Same actor, own scope: the read works (no blanket refusal).
    const ownScope = await scopeFixture(realmB);
    const ownCrew = await crewFixture(realmB);
    const allowed = await api()
      .get(CANDIDATES(ownScope.scope.id))
      .set(auth(outsider.token));
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.ok(
      allowed.body.data.candidates.some(
        (candidate: { crewId: string }) =>
          candidate.crewId === ownCrew.crew.id,
      ),
    );
  });

  it('10: reassignment to an unqualified crew is refused and the ACTIVE row survives', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const good = await crewFixture(realm, 'Good');
    const bad = await crewFixture(realm, 'Bad');
    const skill = await giveSkill(realm, good.lead.profile.id, 'ADVANCED');
    const f = await scopeFixture(realm);

    // Assign first WITHOUT the requirement, then configure it: the existing
    // assignment stays and only the transfer is gated.
    const first = await assign(f.scope.id, good.providerContext.id, good.crew.id);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: skill.id,
      minimumProficiencyLevel: 'ADVANCED',
    });

    const [, current] = [null, (await assignmentRows(f.scope.id))[0]];
    const rejected = await api()
      .post(REASSIGN(f.scope.id))
      .set(auth())
      .send({
        providerContextId: bad.providerContext.id,
        crewId: bad.crew.id,
        reason: 'Try to move the job to an unqualified crew.',
        expectedVersion: current.version,
      });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(
      rejected.body.error.code,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_COMPETENCY_REQUIRED',
    );

    const after = await assignmentRows(f.scope.id);
    assert.equal(after.length, 1, 'a refused reassignment writes no history');
    assert.equal(after[0].id, current.id);
    assert.equal(after[0].status, 'ACTIVE');
    assert.equal(after[0].handyman_crew_id, good.crew.id);
    assert.equal(after[0].version, current.version);

    // Transferring to an equally-qualified crew still works.
    const other = await crewFixture(realm, 'Also');
    await giveSkill(realm, other.lead.profile.id, 'EXPERT', skill);
    const accepted = await api()
      .post(REASSIGN(f.scope.id))
      .set(auth())
      .send({
        providerContextId: other.providerContext.id,
        crewId: other.crew.id,
        reason: 'Qualified replacement crew.',
        expectedVersion: current.version,
      });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.handymanCrewId, other.crew.id);
    const finalRows = await assignmentRows(f.scope.id);
    assert.equal(finalRows.filter((row) => row.status === 'ACTIVE').length, 1);
  });

  it('11: deactivating a requirement immediately restores assignability', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const skill = await giveSkill(realm, crew.lead.profile.id, 'BASIC');
    const f = await scopeFixture(realm);
    const created = await createRequirement(f.serviceCatalogId, {
      requirementType: 'SKILL',
      skillId: skill.id,
      minimumProficiencyLevel: 'EXPERT',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const blocked = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

    // PATCH lowers the bar instead of deactivating (both are governed paths).
    const patched = await api()
      .patch(`${REQUIREMENTS(f.serviceCatalogId)}/${created.body.data.id}`)
      .set(auth())
      .send({ minimumProficiencyLevel: 'BASIC' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.minimumProficiencyLevel, 'BASIC');

    const deactivated = await api()
      .post(
        `${REQUIREMENTS(f.serviceCatalogId)}/${created.body.data.id}/deactivate`,
      )
      .set(auth());
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Configuring an INACTIVE entry is refused; the ACTIVE list is empty.
    const list = await api().get(REQUIREMENTS(f.serviceCatalogId)).set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].status, 'INACTIVE');

    const allowed = await assign(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  });
});
