import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import {
  createBuildingConfiguration,
} from '../src/modules/building-configurations';
import { clientService, type PublicClient } from '../src/modules/clients';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { departmentService } from '../src/modules/departments';
import { entitlementService } from '../src/modules/entitlements';
import { floorService } from '../src/modules/floors';
import {
  HANDYMAN_ARRIVAL_VERIFICATION_CONFIGURATION_KEY,
  assignHandymanJobProviderAndCrew,
  cancelHandymanServiceVisitSchedule,
  createHandymanJob,
  createHandymanServiceVisit,
  endHandymanWorkSession,
  getHandymanWorkSessionById,
  listHandymanWorkSessionsByVisit,
  reassignHandymanJobProviderAndCrew,
  recordGpsHandymanVisitArrival,
  recordHandymanVisitPresenceByLead,
  rescheduleHandymanServiceVisit,
  startHandymanWorkSession,
} from '../src/modules/handyman-jobs';
import {
  HANDYMAN_MODULE_CODE,
  designateHandymanProvider,
} from '../src/modules/handyman-providers';
import {
  addHandymanWorkCrewMember,
  createHandymanWorkCrew,
} from '../src/modules/handyman-work-crews';
import {
  selectHandymanRequestService,
  triageHandymanRequest,
} from '../src/modules/handyman-request-governance';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotationApprovalInApp,
  sendHandymanQuotation,
  submitHandymanQuotationRevision,
} from '../src/modules/handyman-quotations';
import { createHandymanRequest } from '../src/modules/handyman-requests';
import { licenseService } from '../src/modules/licenses';
import { moduleConfigurationService } from '../src/modules/module-configurations';
import { moduleRepository, moduleService } from '../src/modules/modules';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { subscriptionService } from '../src/modules/subscriptions';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorService } from '../src/modules/vendors';
import { transitionVendorWorkStatus } from '../src/modules/vendor-work';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { createWorkPermitReadiness } from '../src/modules/work-permit-readiness';
import { transitionWorkOrderStatus } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-06 RUN 3 — ONE focused HTTP integration suite for the field
 * execution contract (§16): authentication + RBAC separation (read /
 * manage / assisted), the GPS arrival wire (strict allowlist, protected
 * fields, server-decided result, convergence, privacy), the ASSISTED
 * arrival override (visit-manage authority, mandatory attributed reason,
 * no coordinates), presence (lead marks the frozen snapshot, arbitrary
 * workers rejected, assisted attribution, operational read view), session
 * start/end over the wire (server timestamps, visible convergence, Case D
 * staying the domain 409, replay-safe end with no side effects), the
 * privacy-safe read models, and exact runtime ↔ OpenAPI parity.
 *
 * Domain depth is NOT re-tested here (Runs 1–2 own it): each seam is
 * exercised once THROUGH THE WIRE. Fixtures consume the governed chain end
 * to end (the BE-05/Run-1/Run-2 idiom): APPROVED request → job → assigned
 * composition → scheduled visit → VERIFIED GPS arrival → frozen presence
 * snapshot → lead PRESENT, before any session start is attempted.
 */

const PORT = 55512;
const DIR = '/tmp/asentra-hm06-run3-pg';
const EM = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';

if (EM) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';
let outsiderUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const CUSTOMER_NAME = 'Rina Tenant Contact';
const CUSTOMER_PHONE = '+6281298765016';
const CUSTOMER_EMAIL = 'rina06r2@customer.example.com';

/** Distinctive policy point — its exact string form doubles as the
 * raw-location canary for read-model/audit assertions. */
const POLICY_LATITUDE = -6.223456;
const POLICY_LONGITUDE = 106.833456;
const POLICY_RADIUS_METERS = 150;

function readyPolicyValue(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    latitude: POLICY_LATITUDE,
    longitude: POLICY_LONGITUDE,
    radiusMeters: POLICY_RADIUS_METERS,
    allowedMethods: ['GPS', 'ASSISTED'],
    ...overrides,
  };
}

/** ~55.6 m north of the policy point (inside the 150 m radius). */
const INSIDE_LATITUDE = POLICY_LATITUDE + 0.0005;

before(async () => {
  if (EM) {
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
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await runSeeds(pool);
  await pool.query(
    `TRUNCATE handyman_work_sessions, handyman_visit_presence,
      handyman_visit_arrivals, handyman_service_visit_schedules,
      handyman_service_visits, handyman_job_assignments, handyman_jobs,
      vendor_works, vendor_assignments, work_permit_readiness, work_orders,
      handyman_work_crew_members, handyman_work_crews, vendor_capabilities,
      vendor_building_relationships, handyman_quotation_approval_links,
      handyman_quotation_approvals, handyman_quotation_lines,
      handyman_quotation_revisions, handyman_quotations,
      handyman_request_triages, handyman_request_services,
      handyman_inspections, handyman_requests, handyman_providers,
      vendor_workforce_bindings, workforce_profiles, vendors,
      supporting_documents, documents, tenant_space_relationships,
      tenant_building_contexts, tenant_pics, tenant_companies,
      price_catalog_entries, inventory_items, units_of_measure,
      operational_events CASCADE`,
  );
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;
  const outsider = await userService.createUser({
    email: `outsider06r3-${suffix().toLowerCase()}@example.com`,
    displayName: 'Outsider User',
  });
  outsiderUserId = outsider.id;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EM) await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

function requirePool(): Pool {
  if (!pool) throw new Error('pool unavailable');
  return pool;
}

async function expectError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const appError = error as { code?: string; statusCode?: number };
    assert.equal(appError.code, code);
    assert.equal(appError.statusCode, statusCode);
    return;
  }
  assert.fail(`Expected error ${code} (${statusCode}) was not thrown`);
}

/** Asserts a raw postgres constraint violation (structural backstops). */
async function expectPgConstraint(
  promise: Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    assert.equal(pgError.code, code);
    assert.equal(pgError.constraint, constraint);
    return;
  }
  assert.fail(`Expected pg ${code}/${constraint} was not raised`);
}

/** Asserts a plpgsql RAISE from the 0357 integrity trigger. */
async function expectIntegrityRaise(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    assert.equal(pgError.code, 'P0001');
    assert.ok(
      (pgError.message ?? '').includes('HANDYMAN_WORK_SESSION_STATE_INVALID'),
      `unexpected raise message: ${pgError.message}`,
    );
    return;
  }
  assert.fail('Expected HANDYMAN_WORK_SESSION_STATE_INVALID raise');
}

/* ------------------------------------------------------------------ */
/* Fixtures — the full governed chain through lead-PRESENT arrival      */
/* ------------------------------------------------------------------ */

async function ensureHandymanModule(): Promise<string> {
  const existing = await moduleRepository.findByCode(HANDYMAN_MODULE_CODE);
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await moduleService.updateModuleStatus(existing.id, { status: 'ACTIVE' });
    }
    return existing.id;
  }
  const created = await moduleService.createModule({
    code: HANDYMAN_MODULE_CODE,
    name: 'Handyman',
  });
  return created.id;
}

async function configureHandymanBuilding(buildingId: string): Promise<void> {
  const configuration =
    await moduleConfigurationService.createBuildingModuleConfiguration(
      buildingId,
      { moduleKey: HANDYMAN_MODULE_CODE, enabled: true },
      adminUserId,
    );
  await activateLatestConfigurationVersion(
    adminToken,
    'MODULE_CONFIGURATION',
    configuration.id,
  );
}

async function createHierarchy(options: { client?: PublicClient } = {}) {
  const client =
    options.client ??
    (await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Session Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Session Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Session Tower',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  await clientMonetaryContextService.setClientMonetaryContext(
    {
      clientId: client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes: ['IDR', 'USD'],
    },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
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
    name: 'Unit Space',
  });
  return { client, property, building, floor, area, room, space };
}

async function makeTenantContext(h: {
  client: { id: string };
  building: { id: string };
  space: { id: string };
}) {
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: h.client.id,
      tenantCode: `TC_${suffix()}`,
      tenantName: 'Session Tenant Company',
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: h.building.id },
    adminUserId,
  );
  const picUser = await userService.createUser({
    email: `pic06r3-${suffix().toLowerCase()}@tenant.example.com`,
    displayName: 'Tenant PIC User',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: h.building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      userId: picUser.id,
      picName: 'Pak Joko PIC',
      email: `pic06r3-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000026',
    },
    adminUserId,
  );
  return { company, pic, picUser };
}

async function createRequest(
  h: { building: { id: string }; space: { id: string } },
  tenant: { company: { id: string }; pic: { id: string } },
  title = 'AC Not Cold',
) {
  return createHandymanRequest(
    {
      buildingId: h.building.id,
      spaceId: h.space.id,
      tenantCompanyId: tenant.company.id,
      tenantPicId: tenant.pic.id,
      customerName: CUSTOMER_NAME,
      customerPhone: CUSTOMER_PHONE,
      customerEmail: CUSTOMER_EMAIL,
      inboundChannel: 'WHATSAPP',
      title,
      description: 'Living room AC blows warm air.',
      priority: 'HIGH',
    },
    adminUserId,
  );
}

async function createService(clientId: string) {
  return serviceCatalogService.createServiceCatalogEntry(
    {
      clientId,
      code: `SVC_${suffix()}`,
      name: 'Session Service',
      category: 'HANDYMAN',
    },
    adminUserId,
  );
}

async function makeServicePrice(
  clientId: string,
  serviceId: string,
  unitPrice: number,
) {
  const created = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      sourceMode: 'SERVICE',
      serviceId,
      currency: 'IDR' as const,
      unitPrice,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      idempotencyKey: `IDEM_${suffix()}_${randomUUID()}`,
    },
    adminUserId,
  );
  return priceCatalogEntryService.activatePriceCatalogEntry(
    created.id,
    adminUserId,
  );
}

async function createOrgChain(clientId: string) {
  const organization = await organizationService.createOrganization({
    clientId,
    code: `ORG_${suffix()}`,
    name: 'Session Workforce Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Session Workforce Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Session Workforce Position',
  });
  return { organization, department, position };
}

type OrgChain = Awaited<ReturnType<typeof createOrgChain>>;

/** EXTERNAL worker (BE-03C profile → BE-06F binding), optionally linked to
 * an authenticated user (only leads ever are). Distinctive names double as
 * PII canaries for the audit assertions. */
async function createWorker(
  vendorId: string,
  chain: OrgChain,
  role: string,
  userId?: string,
) {
  const fullName = `Zqxf ${role} ${suffix()}`;
  const vendorPersonnelCode = `VPC-${role}-${suffix()}`;
  const profile = await workforceService.createWorkforceProfile({
    organizationId: chain.organization.id,
    departmentId: chain.department.id,
    positionId: chain.position.id,
    userId: userId ?? null,
    employeeCode: `WF_${suffix()}`,
    fullName,
    workforceType: 'EXTERNAL',
  });
  const binding = await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode,
  });
  return { profile, binding, fullName, vendorPersonnelCode };
}

/** Full governed chain through APPROVAL + eligible provider + crew
 * (a user-linked LEAD plus seated HELPERs). */
async function makeSessionBase(options: { helpers?: number } = {}) {
  const helperCount = options.helpers ?? 1;
  const h = await createHierarchy();
  const tenant = await makeTenantContext(h);
  const moduleId = await ensureHandymanModule();
  await configureHandymanBuilding(h.building.id);

  const vendor = await vendorService.createVendor({
    clientId: h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Session Vendor',
  });
  const startsAt = new Date(Date.now() - 86_400_000);
  const endsAt = new Date(Date.now() + 365 * 86_400_000);
  const subscription = await subscriptionService.createSubscription({
    clientId: h.client.id,
    code: `ASENTRA-${suffix()}`,
    planCode: 'ENTERPRISE',
    startsAt,
    endsAt,
  });
  await licenseService.createLicense(subscription.id, {
    validFrom: startsAt,
    validUntil: endsAt,
  });
  await entitlementService.createEntitlement(subscription.id, {
    moduleId,
    startsAt,
    endsAt,
  });
  const provider = await designateHandymanProvider(
    { clientId: h.client.id, vendorId: vendor.id },
    adminUserId,
  );
  const relationship = await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: h.building.id,
    effectiveFrom: null,
    effectiveUntil: null,
  });

  const request = await createRequest(h, tenant);
  const service = await createService(h.client.id);
  await triageHandymanRequest(
    { requestId: request.id, path: 'QUOTATION', notes: 'Known scope' },
    adminUserId,
  );
  await selectHandymanRequestService(
    { requestId: request.id, serviceCatalogId: service.id, source: 'TRIAGE' },
    adminUserId,
  );
  await vendorCapabilityService.createVendorCapability({
    vendorId: vendor.id,
    code: `CAP_${suffix()}`,
    name: 'Session Capability',
    serviceCatalogId: service.id,
    vendorBuildingRelationshipId: relationship.id,
  });
  await makeServicePrice(h.client.id, service.id, 150000);
  const quotation = await createHandymanQuotation(
    { requestId: request.id, currency: 'IDR' },
    adminUserId,
  );
  await addHandymanQuotationLine(
    {
      revisionId: quotation.revision.id,
      lineType: 'LABOR',
      serviceCatalogId: service.id,
      unitPrice: 150000,
    },
    adminUserId,
  );
  await submitHandymanQuotationRevision(quotation.revision.id, adminUserId);
  await sendHandymanQuotation(
    {
      quotationId: quotation.quotation.id,
      revisionId: quotation.revision.id,
    },
    adminUserId,
  );
  await decideHandymanQuotationApprovalInApp(
    { quotationId: quotation.quotation.id, decision: 'APPROVED' },
    tenant.picUser.id,
  );

  const chain = await createOrgChain(h.client.id);
  const leadUser = await userService.createUser({
    email: `lead06r3-${suffix().toLowerCase()}@worker.example.com`,
    displayName: 'Lead Worker User',
  });
  const lead = await createWorker(vendor.id, chain, 'LeadOne', leadUser.id);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: 'Session Crew One',
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );
  const helpers: Awaited<ReturnType<typeof createWorker>>[] = [];
  for (let index = 0; index < helperCount; index += 1) {
    const helper = await createWorker(vendor.id, chain, `Helper${index + 1}`);
    await addHandymanWorkCrewMember(
      crew.id,
      {
        vendorWorkforceBindingId: helper.binding.id,
        crewRole: 'HELPER',
      },
      adminUserId,
    );
    helpers.push(helper);
  }

  return {
    h,
    tenant,
    vendor,
    provider,
    relationship,
    request,
    service,
    quotation: quotation.quotation,
    revision: quotation.revision,
    chain,
    leadUser,
    lead,
    helpers,
    crew,
  };
}

type SessionBase = Awaited<ReturnType<typeof makeSessionBase>>;

/** A SECOND fully eligible provider+crew (user-linked lead) on the same
 * client/building/service — reassignment and foreign-lead scenarios. */
async function addEligibleProvider(base: SessionBase, role: string) {
  const vendor = await vendorService.createVendor({
    clientId: base.h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: `Session Vendor ${role}`,
  });
  const provider = await designateHandymanProvider(
    { clientId: base.h.client.id, vendorId: vendor.id },
    adminUserId,
  );
  const relationship = await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: base.h.building.id,
    effectiveFrom: null,
    effectiveUntil: null,
  });
  await vendorCapabilityService.createVendorCapability({
    vendorId: vendor.id,
    code: `CAP_${suffix()}`,
    name: `Session Capability ${role}`,
    serviceCatalogId: base.service.id,
    vendorBuildingRelationshipId: relationship.id,
  });
  const leadUser = await userService.createUser({
    email: `${role.toLowerCase()}06r3-${suffix().toLowerCase()}@worker.example.com`,
    displayName: `Alternate Lead User ${role}`,
  });
  const lead = await createWorker(vendor.id, base.chain, role, leadUser.id);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: base.h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: `Session Crew ${role}`,
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );
  return { vendor, provider, relationship, crew, lead, leadUser };
}

const BASE_DAY = Date.UTC(2026, 9, 12); // 2026-10-12T00:00:00Z

function win(dayOffset: number, startHour: number, endHour: number) {
  return {
    plannedStartAt: new Date(
      BASE_DAY + dayOffset * 86_400_000 + startHour * 3_600_000,
    ),
    plannedEndAt: new Date(
      BASE_DAY + dayOffset * 86_400_000 + endHour * 3_600_000,
    ),
  };
}

/**
 * Job created + provider/crew assigned + first visit scheduled + the
 * ACTIVATED READY arrival policy on the canonical building.
 */
async function makeScheduledVisit(options: { helpers?: number } = {}) {
  const base = await makeSessionBase({ helpers: options.helpers });
  const { job } = await createHandymanJob(
    { handymanRequestId: base.request.id },
    adminUserId,
  );
  const assignment = await assignHandymanJobProviderAndCrew(
    job.id,
    {
      handymanProviderId: base.provider.id,
      handymanWorkCrewId: base.crew.id,
    },
    adminUserId,
  );
  const { visit, schedule } = await createHandymanServiceVisit(
    { handymanJobId: job.id, ...win(0, 9, 10) },
    adminUserId,
  );
  const configuration = await createBuildingConfiguration(
    {
      buildingId: base.h.building.id,
      key: HANDYMAN_ARRIVAL_VERIFICATION_CONFIGURATION_KEY,
      value: readyPolicyValue(),
      status: 'ACTIVE',
    },
    adminUserId,
  );
  const configurationVersionId = await activateLatestConfigurationVersion(
    adminToken,
    'BUILDING_CONFIGURATION',
    configuration.id,
  );

  return {
    ...base,
    job,
    assignment,
    visit,
    schedule,
    configuration,
    configurationVersionId,
  };
}

type ScheduledVisit = Awaited<ReturnType<typeof makeScheduledVisit>>;

function gpsInput(overrides: { idempotencyKey?: string } = {}) {
  return {
    latitude: INSIDE_LATITUDE,
    longitude: POLICY_LONGITUDE,
    accuracyMeters: 12.5,
    occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    idempotencyKey:
      overrides.idempotencyKey ?? `ARR_${suffix()}_${randomUUID()}`,
  };
}

function startInput(overrides: {
  idempotencyKey?: string;
  occurredAt?: string | null;
} = {}) {
  return {
    idempotencyKey:
      overrides.idempotencyKey ?? `WSS_${suffix()}_${randomUUID()}`,
    occurredAt:
      overrides.occurredAt === undefined
        ? new Date(Date.now() - 7_200_000).toISOString()
        : overrides.occurredAt,
  };
}

/** Drives the Run-1 facts a legal start consumes: VERIFIED GPS arrival +
 * frozen presence snapshot + the lead marked PRESENT. */
async function arriveAndPresent(ctx: ScheduledVisit) {
  const arrival = await recordGpsHandymanVisitArrival(
    ctx.visit.id,
    gpsInput(),
    ctx.leadUser.id,
  );
  assert.equal(arrival.arrival.verificationResult, 'VERIFIED');
  await recordHandymanVisitPresenceByLead(
    ctx.visit.id,
    {
      vendorWorkforceBindingId: ctx.lead.binding.id,
      presenceStatus: 'PRESENT',
    },
    ctx.leadUser.id,
  );
  return arrival;
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

type SessionRow = {
  id: string;
  client_id: string;
  visit_id: string;
  vendor_work_id: string;
  handyman_job_assignment_id: string;
  status: string;
  started_at: Date;
  started_by_user_id: string;
  ended_at: Date | null;
  ended_by_user_id: string | null;
  occurred_at: Date | null;
  idempotency_key: string;
  idempotency_fingerprint: string;
  created_at: Date;
  updated_at: Date;
};

async function sessionRows(visitId: string): Promise<SessionRow[]> {
  const result = await requirePool().query<SessionRow>(
    `SELECT * FROM handyman_work_sessions
     WHERE visit_id = $1
     ORDER BY started_at ASC, id ASC`,
    [visitId],
  );
  return result.rows;
}

async function eventsFor(entityId: string) {
  const result = await requirePool().query(
    `SELECT event_type, entity_type, building_id, actor_user_id, metadata,
            summary
     FROM operational_events
     WHERE entity_id = $1
     ORDER BY occurred_at ASC`,
    [entityId],
  );
  return result.rows as {
    event_type: string;
    entity_type: string;
    building_id: string | null;
    actor_user_id: string | null;
    metadata: Record<string, unknown>;
    summary: string;
  }[];
}

async function workOrderRow(workOrderId: string) {
  const result = await requirePool().query(
    `SELECT id, status, started_at FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  return result.rows[0] as {
    id: string;
    status: string;
    started_at: Date | null;
  };
}

async function vendorWorkRow(vendorWorkId: string) {
  const result = await requirePool().query(
    `SELECT id, status, started_at FROM vendor_works WHERE id = $1`,
    [vendorWorkId],
  );
  return result.rows[0] as {
    id: string;
    status: string;
    started_at: Date | null;
  };
}

/** The ACTIVE composition's vendor work (BE-15A row, resolved by SQL). */
async function resolveVendorWorkId(jobId: string): Promise<string> {
  const result = await requirePool().query<{ id: string }>(
    `SELECT vw.id
     FROM vendor_works vw
     JOIN vendor_assignments va ON va.id = vw.vendor_assignment_id
     JOIN handyman_job_assignments hja ON hja.vendor_assignment_id = va.id
     WHERE hja.handyman_job_id = $1 AND hja.status = 'ACTIVE'`,
    [jobId],
  );
  return result.rows[0].id;
}

/** Direct OPEN-session insert (Case A/D worlds: a session whose guarded
 * seam never ran). Bypasses the service deliberately. */
async function insertOpenSessionSql(
  ctx: ScheduledVisit,
  overrides: { startedByUserId?: string; key?: string } = {},
): Promise<string> {
  const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
  const result = await requirePool().query<{ id: string }>(
    `INSERT INTO handyman_work_sessions
       (id, client_id, visit_id, vendor_work_id,
        handyman_job_assignment_id, status, started_by_user_id,
        idempotency_key, idempotency_fingerprint)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'OPEN', $5, $6, $7)
     RETURNING id`,
    [
      ctx.h.client.id,
      ctx.visit.id,
      vendorWorkId,
      ctx.assignment.assignment.id,
      overrides.startedByUserId ?? ctx.leadUser.id,
      overrides.key ?? `SQL_${suffix()}_${randomUUID()}`,
      `sql-${randomUUID()}`,
    ],
  );
  return result.rows[0].id;
}

function assertNoPii(serialized: string): void {
  assert.ok(!serialized.includes(CUSTOMER_NAME), 'customer name leaked');
  assert.ok(!serialized.includes(CUSTOMER_PHONE), 'customer phone leaked');
  assert.ok(!serialized.includes(CUSTOMER_EMAIL), 'customer email leaked');
  assert.ok(!serialized.includes('Zqxf'), 'worker name leaked');
}

function assertNoRawLocation(serialized: string): void {
  assert.ok(
    !serialized.includes(String(POLICY_LATITUDE)),
    'policy latitude leaked',
  );
  assert.ok(
    !serialized.includes(String(POLICY_LONGITUDE)),
    'policy longitude leaked',
  );
  assert.ok(
    !serialized.includes(String(INSIDE_LATITUDE)),
    'claimed latitude leaked',
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* HTTP helpers (Run 3)                                                */
/* ------------------------------------------------------------------ */

const PERM = {
  read: {
    code: 'handyman_work_execution.read',
    name: 'Read Handyman Work Execution',
  },
  manage: {
    code: 'handyman_work_execution.manage',
    name: 'Manage Handyman Work Execution',
  },
  visitManage: {
    code: 'handyman_service_visit.manage',
    name: 'Manage Handyman Service Visits',
  },
} as const;

const R = {
  arrival: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/arrival`,
  arrivalAssisted: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/arrival/assisted`,
  arrivals: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/arrivals`,
  presence: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/presence`,
  presenceAssisted: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/presence/assisted`,
  startSession: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/work-sessions/start`,
  sessions: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/work-sessions`,
  session: (sessionId: string) => `/api/v1/handyman-work-sessions/${sessionId}`,
  endSession: (sessionId: string) =>
    `/api/v1/handyman-work-sessions/${sessionId}/end`,
};

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function errCode(res: { body: any }): string {
  return (res.body?.error?.code ?? '') as string;
}

function detailFields(res: { body: any }): string[] {
  return ((res.body?.error?.details ?? []) as { field: string }[]).map(
    (detail) => detail.field,
  );
}

async function ensurePermissionIdLocal(
  code: string,
  name: string,
): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await permissionRepository.updateStatus(existing.id, 'ACTIVE');
    }
    return existing.id;
  }
  const created = await permissionService.createPermission({ code, name });
  return created.id;
}

/**
 * An authenticated session for an EXISTING user — the field-lead idiom: a
 * worker user gets app credentials plus a scoped RBAC role carrying exactly
 * the given permissions (the field credential is RBAC transport authority
 * only; every data decision stays service-owned).
 */
async function createUserSession(
  user: { id: string; email: string },
  permissions: readonly { code: string; name: string }[],
): Promise<string> {
  const password = 'FieldPass123';
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleService.createRole({
    code: `FIELD_${suffix()}`,
    name: 'Field Execution Role',
  });
  for (const permission of permissions) {
    const permissionId = await ensurePermissionIdLocal(
      permission.code,
      permission.name,
    );
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200, `lead login failed: ${login.text}`);
  return login.body.data.sessionToken as string;
}

const leadPermissions = [PERM.read, PERM.manage];

/** Establishes ONLY the VERIFIED arrival + frozen snapshot (the lead row
 * stays PENDING — presence marking is what the HTTP tests exercise). */
async function arriveOnly(ctx: ScheduledVisit) {
  const arrival = await recordGpsHandymanVisitArrival(
    ctx.visit.id,
    gpsInput(),
    ctx.leadUser.id,
  );
  assert.equal(arrival.arrival.verificationResult, 'VERIFIED');
  return arrival;
}


async function leadTokenFor(ctx: ScheduledVisit): Promise<string> {
  return createUserSession(ctx.leadUser, leadPermissions);
}

/* Exact public wire key sets (privacy contracts — asserted literally). */
const ARRIVAL_KEYS = [
  'assistedReason',
  'buildingConfigurationId',
  'clientId',
  'configurationVersionId',
  'createdAt',
  'failureReason',
  'handymanServiceVisitId',
  'id',
  'occurredAt',
  'receivedAt',
  'recordedByUserId',
  'verificationMethod',
  'verificationResult',
];
const ARRIVAL_RESULT_KEYS = ['arrival', 'converged', 'presence'];
const PRESENCE_ROW_KEYS = [
  'clientId',
  'createdAt',
  'crewRole',
  'handymanJobAssignmentId',
  'handymanServiceVisitId',
  'handymanVisitArrivalId',
  'handymanWorkCrewId',
  'id',
  'presenceStatus',
  'recordedAt',
  'recordedByUserId',
  'recordedVia',
  'updatedAt',
  'vendorWorkforceBindingId',
];
const PRESENCE_VIEW_KEYS = [
  'handymanServiceVisitId',
  'leadPresent',
  'leadVendorWorkforceBindingId',
  'presence',
  'snapshotExists',
];
const SESSION_KEYS = [
  'clientId',
  'createdAt',
  'endedAt',
  'endedByUserId',
  'handymanJobAssignmentId',
  'id',
  'occurredAt',
  'startedAt',
  'startedByUserId',
  'status',
  'updatedAt',
  'vendorWorkId',
  'visitId',
];
const START_RESULT_KEYS = ['converged', 'execution', 'session'];
const EXECUTION_STATE_KEYS = ['vendorWorkStatus', 'workOrderStatus'];
const END_RESULT_KEYS = ['converged', 'session'];

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

/* ------------------------------------------------------------------ */
/* 1. Authentication + RBAC                                            */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-06 RUN 3 — authentication + RBAC', () => {
  it('denies every field-execution route with 401 when unauthenticated', async (t) => {
    if (!ready(t)) return;
    const visitId = randomUUID();
    const sessionId = randomUUID();
    const calls: Promise<{ status: number }>[] = [
      api().post(R.arrival(visitId)).send(gpsInput()),
      api()
        .post(R.arrivalAssisted(visitId))
        .send({ assistedReason: 'x', idempotencyKey: 'k' }),
      api().get(R.arrivals(visitId)),
      api().get(R.presence(visitId)),
      api()
        .post(R.presence(visitId))
        .send({ vendorWorkforceBindingId: randomUUID(), presenceStatus: 'PRESENT' }),
      api()
        .post(R.presenceAssisted(visitId))
        .send({
          vendorWorkforceBindingId: randomUUID(),
          presenceStatus: 'PRESENT',
          assistedReason: 'x',
        }),
      api().post(R.startSession(visitId)).send(startInput()),
      api().get(R.sessions(visitId)),
      api().get(R.session(sessionId)),
      api().post(R.endSession(sessionId)).send({}),
    ];
    for (const call of calls) {
      const res = await call;
      assert.equal(res.status, 401, 'unauthenticated must be denied with 401');
    }
  });

  it('separates read, manage and assisted authority at the RBAC layer (PERMISSION_DENIED)', async (t) => {
    if (!ready(t)) return;
    const readToken = await createSessionWithPermissions([PERM.read]);
    const manageToken = await createSessionWithPermissions([PERM.manage]);
    const plainToken = await createPlainSession();
    const visitId = randomUUID();
    const sessionId = randomUUID();

    // A read credential can never mutate — including the assisted routes.
    const readDenied = [
      api().post(R.arrival(visitId)).set(auth(readToken)).send(gpsInput()),
      api()
        .post(R.presence(visitId))
        .set(auth(readToken))
        .send({ vendorWorkforceBindingId: randomUUID(), presenceStatus: 'PRESENT' }),
      api().post(R.startSession(visitId)).set(auth(readToken)).send(startInput()),
      api().post(R.endSession(sessionId)).set(auth(readToken)).send({}),
      api()
        .post(R.arrivalAssisted(visitId))
        .set(auth(readToken))
        .send({ assistedReason: 'x', idempotencyKey: 'k' }),
      api()
        .post(R.presenceAssisted(visitId))
        .set(auth(readToken))
        .send({
          vendorWorkforceBindingId: randomUUID(),
          presenceStatus: 'PRESENT',
          assistedReason: 'x',
        }),
    ];
    for (const call of readDenied) {
      const res = await call;
      assert.equal(res.status, 403);
      assert.equal(errCode(res), 'PERMISSION_DENIED');
    }

    // A manage credential can never read.
    const manageDeniedReads = [
      api().get(R.arrivals(visitId)).set(auth(manageToken)),
      api().get(R.presence(visitId)).set(auth(manageToken)),
      api().get(R.sessions(visitId)).set(auth(manageToken)),
      api().get(R.session(sessionId)).set(auth(manageToken)),
    ];
    for (const call of manageDeniedReads) {
      const res = await call;
      assert.equal(res.status, 403);
      assert.equal(errCode(res), 'PERMISSION_DENIED');
    }

    // The ASSISTED overrides are NOT reachable with the field execution
    // credential alone — assisted stays on handyman_service_visit.manage.
    for (const call of [
      api()
        .post(R.arrivalAssisted(visitId))
        .set(auth(manageToken))
        .send({ assistedReason: 'x', idempotencyKey: 'k' }),
      api()
        .post(R.presenceAssisted(visitId))
        .set(auth(manageToken))
        .send({
          vendorWorkforceBindingId: randomUUID(),
          presenceStatus: 'PRESENT',
          assistedReason: 'x',
        }),
    ]) {
      const res = await call;
      assert.equal(res.status, 403);
      assert.equal(errCode(res), 'PERMISSION_DENIED');
    }

    // No permissions at all: denied on both a mutation and a read.
    const plainPost = await api()
      .post(R.arrival(visitId))
      .set(auth(plainToken))
      .send(gpsInput());
    assert.equal(plainPost.status, 403);
    assert.equal(errCode(plainPost), 'PERMISSION_DENIED');
    const plainGet = await api().get(R.arrivals(visitId)).set(auth(plainToken));
    assert.equal(plainGet.status, 403);
    assert.equal(errCode(plainGet), 'PERMISSION_DENIED');
  });
});

/* ------------------------------------------------------------------ */
/* 2. GPS arrival over the wire                                        */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-06 RUN 3 — GPS arrival HTTP', () => {
  it('rejects unknown and protected body keys with 400 VALIDATION_ERROR before any domain call', async (t) => {
    if (!ready(t)) return;
    // RBAC-valid credential, random visit: strict transport validation
    // fires first — proof the allowlist is enforced at the edge.
    const manageToken = await createSessionWithPermissions([PERM.manage]);
    const visitId = randomUUID();

    const protectedBody = await api()
      .post(R.arrival(visitId))
      .set(auth(manageToken))
      .send({
        ...gpsInput(),
        verified: true,
        result: 'VERIFIED',
        radiusMeters: 100,
        distanceMeters: 10,
        clientId: randomUUID(),
        recordedByUserId: randomUUID(),
        buildingConfigurationId: randomUUID(),
      });
    assert.equal(protectedBody.status, 400);
    assert.equal(errCode(protectedBody), 'VALIDATION_ERROR');
    const fields = detailFields(protectedBody);
    for (const field of [
      'verified',
      'result',
      'radiusMeters',
      'distanceMeters',
      'clientId',
      'recordedByUserId',
      'buildingConfigurationId',
    ]) {
      assert.ok(fields.includes(field), `${field} must be explicitly rejected`);
    }

    const unknownKey = await api()
      .post(R.arrival(visitId))
      .set(auth(manageToken))
      .send({ ...gpsInput(), note: 'hello' });
    assert.equal(unknownKey.status, 400);
    assert.equal(errCode(unknownKey), 'VALIDATION_ERROR');
    assert.ok(detailFields(unknownKey).includes('note'));

    const missingKey = await api()
      .post(R.arrival(visitId))
      .set(auth(manageToken))
      .send({ latitude: INSIDE_LATITUDE, longitude: POLICY_LONGITUDE });
    assert.equal(missingKey.status, 400);
    assert.equal(errCode(missingKey), 'VALIDATION_ERROR');
    assert.ok(detailFields(missingKey).includes('idempotencyKey'));

    const badShape = await api()
      .post(R.arrival(visitId))
      .set(auth(manageToken))
      .send({
        latitude: 'not-a-number',
        longitude: POLICY_LONGITUDE,
        occurredAt: 'yesterday',
        idempotencyKey: 'k1',
      });
    assert.equal(badShape.status, 400);
    assert.equal(errCode(badShape), 'VALIDATION_ERROR');
    assert.ok(detailFields(badShape).includes('latitude'));
    assert.ok(detailFields(badShape).includes('occurredAt'));
  });

  let ctxA: ScheduledVisit | null = null;
  let leadTokenA = '';

  it('records lead GPS arrivals: the server decides the result, evidence stays server-side, replays converge', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    ctxA = ctx;
    leadTokenA = await leadTokenFor(ctx);

    // Out-of-range claim: preserved as a FAILED attempt (evidence), NOT a
    // transport error — the server is the sole verification authority.
    const failedInput = gpsInput();
    const failed = await api()
      .post(R.arrival(ctx.visit.id))
      .set(auth(leadTokenA))
      .send({ ...failedInput, latitude: 999 });
    assert.equal(failed.status, 201);
    assert.equal(failed.body.data.arrival.verificationResult, 'FAILED');
    assert.equal(failed.body.data.arrival.failureReason, 'INVALID_COORDINATES');
    assert.equal(failed.body.data.arrival.verificationMethod, 'GPS');
    assert.equal(failed.body.data.converged, false);
    assert.deepEqual(failed.body.data.presence, []);
    exactKeys(failed.body.data, ARRIVAL_RESULT_KEYS);
    exactKeys(failed.body.data.arrival, ARRIVAL_KEYS);
    assertNoRawLocation(JSON.stringify(failed.body));

    // Valid claim inside the backend-authoritative radius: VERIFIED by the
    // SERVER, attributed to the authenticated lead, snapshot returned.
    const verifiedInput = gpsInput();
    const verified = await api()
      .post(R.arrival(ctx.visit.id))
      .set(auth(leadTokenA))
      .send(verifiedInput);
    assert.equal(verified.status, 201);
    assert.equal(verified.body.data.arrival.verificationResult, 'VERIFIED');
    assert.equal(verified.body.data.arrival.verificationMethod, 'GPS');
    assert.equal(verified.body.data.arrival.failureReason, null);
    assert.equal(
      verified.body.data.arrival.recordedByUserId,
      ctx.leadUser.id,
    );
    assert.equal(
      verified.body.data.arrival.handymanServiceVisitId,
      ctx.visit.id,
    );
    assert.equal(verified.body.data.arrival.occurredAt, verifiedInput.occurredAt);
    assert.equal(verified.body.data.converged, false);
    // The atomic presence snapshot: the lead + the seated helper, PENDING.
    assert.equal(verified.body.data.presence.length, 2);
    for (const row of verified.body.data.presence) {
      exactKeys(row, PRESENCE_ROW_KEYS);
      assert.equal(row.presenceStatus, 'PENDING');
      assert.equal(row.handymanServiceVisitId, ctx.visit.id);
    }
    assertNoRawLocation(JSON.stringify(verified.body));
    assertNoPii(JSON.stringify(verified.body));

    // Same-key replay converges onto the authoritative fact (200).
    const replay = await api()
      .post(R.arrival(ctx.visit.id))
      .set(auth(leadTokenA))
      .send(verifiedInput);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.converged, true);
    assert.equal(replay.body.data.arrival.id, verified.body.data.arrival.id);

    // Same key with different facts: the owned idempotency conflict (409).
    const conflict = await api()
      .post(R.arrival(ctx.visit.id))
      .set(auth(leadTokenA))
      .send({ ...verifiedInput, accuracyMeters: 30 });
    assert.equal(conflict.status, 409);
    assert.equal(
      errCode(conflict),
      'HANDYMAN_VISIT_ARRIVAL_IDEMPOTENCY_CONFLICT',
    );

    // A non-lead authenticated credential is denied by the DOMAIN lead
    // chain (RBAC passed — data authority never lives in the controller).
    const strangerToken = await createSessionWithPermissions([PERM.manage]);
    const stranger = await api()
      .post(R.arrival(ctx.visit.id))
      .set(auth(strangerToken))
      .send(gpsInput());
    assert.equal(stranger.status, 403);
    assert.equal(errCode(stranger), 'HANDYMAN_VISIT_ARRIVAL_ACTOR_NOT_LEAD');
  });

  it('exposes the arrival history without raw GPS, accuracy, distance or idempotency facts', async (t) => {
    if (!ready(t)) return;
    assert.ok(ctxA && leadTokenA);
    const res = await api()
      .get(R.arrivals(ctxA.visit.id))
      .set(auth(leadTokenA));
    assert.equal(res.status, 200);
    const rows = res.body.data as Record<string, unknown>[];
    assert.equal(rows.length, 2, 'FAILED + VERIFIED attempts, oldest first');
    assert.equal(
      (rows[0] as any).verificationResult,
      'FAILED',
    );
    assert.equal((rows[1] as any).verificationResult, 'VERIFIED');
    for (const row of rows) {
      exactKeys(row, ARRIVAL_KEYS);
      for (const forbidden of [
        'latitude',
        'longitude',
        'accuracyMeters',
        'distanceMeters',
        'idempotencyKey',
        'idempotencyFingerprint',
        'deviceId',
        'evidenceUrl',
      ]) {
        assert.ok(
          !(forbidden in row),
          `${forbidden} must never appear on the arrival read model`,
        );
      }
    }
    assertNoRawLocation(JSON.stringify(res.body));

    // Staff client scope also reads (admin has the building assignment).
    const asAdmin = await api()
      .get(R.arrivals(ctxA.visit.id))
      .set(auth(adminToken));
    assert.equal(asAdmin.status, 200);
    assert.equal((asAdmin.body.data as unknown[]).length, 2);

    // A read-permission credential outside every data scope is denied by
    // the service-owned read scope (403 BUILDING_ACCESS_DENIED — RBAC
    // alone never opens the data).
    const scopedRead = await createSessionWithPermissions([PERM.read]);
    const denied = await api()
      .get(R.arrivals(ctxA.visit.id))
      .set(auth(scopedRead));
    assert.equal(denied.status, 403);
    assert.equal(errCode(denied), 'BUILDING_ACCESS_DENIED');

    // Unknown visit: the owned 404.
    const leadRead = await createSessionWithPermissions(leadPermissions);
    const notFound = await api()
      .get(R.arrivals(randomUUID()))
      .set(auth(leadRead));
    assert.equal(notFound.status, 404);
    assert.equal(errCode(notFound), 'HANDYMAN_SERVICE_VISIT_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ */
/* 3. ASSISTED arrival over the wire                                   */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-06 RUN 3 — ASSISTED arrival HTTP', () => {
  it('records the staff-assisted override with a mandatory attributed reason and no coordinates', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();

    // RBAC-valid visit-manage staff WITHOUT the building data scope: the
    // service-owned client scope still denies (permission ≠ data access).
    const scopedVisitManage = await createSessionWithPermissions([
      PERM.visitManage,
    ]);
    const scopeDenied = await api()
      .post(R.arrivalAssisted(ctx.visit.id))
      .set(auth(scopedVisitManage))
      .send({ assistedReason: 'No signal', idempotencyKey: `A_${suffix()}` });
    assert.equal(scopeDenied.status, 403);
    assert.equal(errCode(scopeDenied), 'BUILDING_ACCESS_DENIED');

    // Empty/missing reason: transport-rejected (mandatory on the wire).
    const emptyReason = await api()
      .post(R.arrivalAssisted(ctx.visit.id))
      .set(auth(adminToken))
      .send({ assistedReason: '   ', idempotencyKey: `A_${suffix()}` });
    assert.equal(emptyReason.status, 400);
    assert.equal(errCode(emptyReason), 'VALIDATION_ERROR');
    assert.ok(detailFields(emptyReason).includes('assistedReason'));

    // Coordinates are structurally rejected — ASSISTED never carries GPS
    // evidence and can never masquerade as a verified fix.
    const withCoords = await api()
      .post(R.arrivalAssisted(ctx.visit.id))
      .set(auth(adminToken))
      .send({
        assistedReason: 'No signal',
        latitude: INSIDE_LATITUDE,
        longitude: POLICY_LONGITUDE,
        idempotencyKey: `A_${suffix()}`,
      });
    assert.equal(withCoords.status, 400);
    assert.equal(errCode(withCoords), 'VALIDATION_ERROR');
    const coordFields = detailFields(withCoords);
    assert.ok(coordFields.includes('latitude'));
    assert.ok(coordFields.includes('longitude'));

    // The valid override: ASSISTED, VERIFIED, reason + real recorder
    // attributed, snapshot created atomically.
    const input = {
      assistedReason: 'Lead phone offline at gate',
      idempotencyKey: `A_${suffix()}_${randomUUID()}`,
    };
    const assisted = await api()
      .post(R.arrivalAssisted(ctx.visit.id))
      .set(auth(adminToken))
      .send(input);
    assert.equal(assisted.status, 201);
    assert.equal(assisted.body.data.arrival.verificationMethod, 'ASSISTED');
    assert.equal(assisted.body.data.arrival.verificationResult, 'VERIFIED');
    assert.equal(
      assisted.body.data.arrival.assistedReason,
      input.assistedReason,
    );
    assert.equal(assisted.body.data.arrival.recordedByUserId, adminUserId);
    assert.equal(assisted.body.data.converged, false);
    assert.equal(assisted.body.data.presence.length, 2);
    exactKeys(assisted.body.data.arrival, ARRIVAL_KEYS);
    assertNoRawLocation(JSON.stringify(assisted.body));

    // Replay converges (200) onto the established fact.
    const replay = await api()
      .post(R.arrivalAssisted(ctx.visit.id))
      .set(auth(adminToken))
      .send(input);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.converged, true);
    assert.equal(
      replay.body.data.arrival.id,
      assisted.body.data.arrival.id,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. Presence over the wire                                           */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-06 RUN 3 — presence HTTP', () => {
  let ctxC: ScheduledVisit | null = null;
  let leadTokenC = '';

  it('marks the frozen snapshot for the lead, rejects arbitrary workers and non-leads', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    ctxC = ctx;
    leadTokenC = await leadTokenFor(ctx);

    // Before the one VERIFIED arrival there is nothing to mark (409) and
    // the read view is an honest empty snapshot (200, never an error).
    const earlyView = await api()
      .get(R.presence(ctx.visit.id))
      .set(auth(leadTokenC));
    assert.equal(earlyView.status, 200);
    exactKeys(earlyView.body.data, PRESENCE_VIEW_KEYS);
    assert.equal(earlyView.body.data.snapshotExists, false);
    assert.equal(earlyView.body.data.leadPresent, false);
    assert.deepEqual(earlyView.body.data.presence, []);

    const earlyMark = await api()
      .post(R.presence(ctx.visit.id))
      .set(auth(leadTokenC))
      .send({
        vendorWorkforceBindingId: ctx.lead.binding.id,
        presenceStatus: 'PRESENT',
      });
    assert.equal(earlyMark.status, 409);
    assert.equal(errCode(earlyMark), 'HANDYMAN_VISIT_PRESENCE_NOT_CAPTURED');

    // Establish the VERIFIED arrival + snapshot (fixture idiom — the
    // arrival wire itself is proven in the GPS/ASSISTED blocks).
    await arriveOnly(ctx);

    // The lead marks a HELPER on their behalf (helpers never authenticate
    // and never need a login): attribution stays the real recorder.
    const helper = ctx.helpers[0];
    const mark = await api()
      .post(R.presence(ctx.visit.id))
      .set(auth(leadTokenC))
      .send({
        vendorWorkforceBindingId: helper.binding.id,
        presenceStatus: 'PRESENT',
      });
    assert.equal(mark.status, 200);
    exactKeys(mark.body.data, PRESENCE_ROW_KEYS);
    assert.equal(mark.body.data.vendorWorkforceBindingId, helper.binding.id);
    assert.equal(mark.body.data.crewRole, 'HELPER');
    assert.equal(mark.body.data.presenceStatus, 'PRESENT');
    assert.equal(mark.body.data.recordedVia, 'LEAD');
    assert.equal(mark.body.data.recordedByUserId, ctx.leadUser.id);
    assert.equal(mark.body.data.handymanServiceVisitId, ctx.visit.id);

    // An arbitrary worker (valid UUID, outside the frozen snapshot — e.g.
    // another provider/crew) is rejected with the owned 404: presence rows
    // are never inserted outside the arrival transaction.
    const arbitrary = await api()
      .post(R.presence(ctx.visit.id))
      .set(auth(leadTokenC))
      .send({
        vendorWorkforceBindingId: randomUUID(),
        presenceStatus: 'PRESENT',
      });
    assert.equal(arbitrary.status, 404);
    assert.equal(
      errCode(arbitrary),
      'HANDYMAN_VISIT_PRESENCE_MEMBER_NOT_FOUND',
    );

    // Transport enum + frozen-role protection.
    const pending = await api()
      .post(R.presence(ctx.visit.id))
      .set(auth(leadTokenC))
      .send({
        vendorWorkforceBindingId: helper.binding.id,
        presenceStatus: 'PENDING',
      });
    assert.equal(pending.status, 400);
    assert.equal(errCode(pending), 'VALIDATION_ERROR');
    assert.ok(detailFields(pending).includes('presenceStatus'));

    const withRole = await api()
      .post(R.presence(ctx.visit.id))
      .set(auth(leadTokenC))
      .send({
        vendorWorkforceBindingId: helper.binding.id,
        presenceStatus: 'PRESENT',
        crewRole: 'LEAD_WORKER',
      });
    assert.equal(withRole.status, 400);
    assert.equal(errCode(withRole), 'VALIDATION_ERROR');
    assert.ok(detailFields(withRole).includes('crewRole'));

    const assistedOnNormal = await api()
      .post(R.presence(ctx.visit.id))
      .set(auth(leadTokenC))
      .send({
        vendorWorkforceBindingId: helper.binding.id,
        presenceStatus: 'PRESENT',
        assistedReason: 'not an assisted route',
      });
    assert.equal(assistedOnNormal.status, 400);
    assert.equal(errCode(assistedOnNormal), 'VALIDATION_ERROR');
    assert.ok(detailFields(assistedOnNormal).includes('assistedReason'));

    // A non-lead field credential (RBAC-valid) is denied by the DOMAIN
    // lead chain — never by the controller.
    const strangerToken = await createSessionWithPermissions([PERM.manage]);
    const stranger = await api()
      .post(R.presence(ctx.visit.id))
      .set(auth(strangerToken))
      .send({
        vendorWorkforceBindingId: helper.binding.id,
        presenceStatus: 'ABSENT',
      });
    assert.equal(stranger.status, 403);
    assert.equal(errCode(stranger), 'HANDYMAN_VISIT_PRESENCE_ACTOR_NOT_LEAD');
  });

  it('records assisted presence via visit.manage with STAFF_ASSISTED attribution and keeps the view operational', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const leadToken = await leadTokenFor(ctx);
    await arriveOnly(ctx);

    // Reason is mandatory on the assisted wire.
    const noReason = await api()
      .post(R.presenceAssisted(ctx.visit.id))
      .set(auth(adminToken))
      .send({
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'ABSENT',
      });
    assert.equal(noReason.status, 400);
    assert.equal(errCode(noReason), 'VALIDATION_ERROR');
    assert.ok(detailFields(noReason).includes('assistedReason'));

    // The field execution credential alone can never reach the override.
    const fieldOnly = await api()
      .post(R.presenceAssisted(ctx.visit.id))
      .set(auth(leadToken))
      .send({
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'ABSENT',
        assistedReason: 'self-attested override',
      });
    assert.equal(fieldOnly.status, 403);
    assert.equal(errCode(fieldOnly), 'PERMISSION_DENIED');

    // Staff-assisted mark: distinguishable path + the REAL recorder.
    const assisted = await api()
      .post(R.presenceAssisted(ctx.visit.id))
      .set(auth(adminToken))
      .send({
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'ABSENT',
        assistedReason: 'Helper called in sick at gate',
      });
    assert.equal(assisted.status, 200);
    exactKeys(assisted.body.data, PRESENCE_ROW_KEYS);
    assert.equal(assisted.body.data.recordedVia, 'STAFF_ASSISTED');
    assert.equal(assisted.body.data.recordedByUserId, adminUserId);
    assert.equal(assisted.body.data.presenceStatus, 'ABSENT');
    // The free-text reason stays off the presence read model.
    assert.ok(!('assistedReason' in assisted.body.data));

    // The read view: operational facts only, evaluation scalars included.
    const view = await api()
      .get(R.presence(ctx.visit.id))
      .set(auth(leadToken));
    assert.equal(view.status, 200);
    exactKeys(view.body.data, PRESENCE_VIEW_KEYS);
    assert.equal(view.body.data.snapshotExists, true);
    assert.equal(view.body.data.leadPresent, false, 'lead row still PENDING');
    assert.equal(view.body.data.presence.length, 2);
    for (const row of view.body.data.presence) {
      exactKeys(row, PRESENCE_ROW_KEYS);
    }
    const serialized = JSON.stringify(view.body);
    assertNoPii(serialized);
    assert.ok(!serialized.includes('Helper called in sick'));
  });
});

/* ------------------------------------------------------------------ */
/* 5. Work session over the wire                                       */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-06 RUN 3 — work session HTTP', () => {
  it('starts the session for the verified present lead, rejects business keys and converges replays', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const leadToken = await leadTokenFor(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);

    // Strict body: every authoritative key is protected (no mass
    // assignment, no caller-supplied lifecycle or financial facts).
    const protectedBody = await api()
      .post(R.startSession(ctx.visit.id))
      .set(auth(leadToken))
      .send({
        idempotencyKey: `W_${suffix()}`,
        workOrderId: ctx.job.workOrderId,
        vendorWorkId,
        status: 'OPEN',
        startedAt: new Date().toISOString(),
        billingRate: 150000,
        clientId: ctx.h.client.id,
      });
    assert.equal(protectedBody.status, 400);
    assert.equal(errCode(protectedBody), 'VALIDATION_ERROR');
    const fields = detailFields(protectedBody);
    for (const field of [
      'workOrderId',
      'vendorWorkId',
      'status',
      'startedAt',
      'billingRate',
      'clientId',
    ]) {
      assert.ok(fields.includes(field), `${field} must be rejected`);
    }

    // The guarded start over the wire: server-resolved facts + the visible
    // convergence (vendor_work IN_PROGRESS BEFORE the work order).
    const before = Date.now();
    const input = startInput();
    const started = await api()
      .post(R.startSession(ctx.visit.id))
      .set(auth(leadToken))
      .send(input);
    assert.equal(started.status, 201);
    exactKeys(started.body.data, START_RESULT_KEYS);
    exactKeys(started.body.data.session, SESSION_KEYS);
    exactKeys(started.body.data.execution, EXECUTION_STATE_KEYS);
    assert.equal(started.body.data.converged, false);
    assert.equal(started.body.data.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(started.body.data.execution.workOrderStatus, 'IN_PROGRESS');
    const session = started.body.data.session;
    assert.equal(session.status, 'OPEN');
    assert.equal(session.visitId, ctx.visit.id);
    assert.equal(session.clientId, ctx.h.client.id);
    assert.equal(session.vendorWorkId, vendorWorkId);
    assert.equal(session.startedByUserId, ctx.leadUser.id);
    assert.equal(session.endedAt, null);
    assert.equal(session.occurredAt, input.occurredAt);
    assert.ok(new Date(session.startedAt).getTime() >= before);
    const startedSerialized = JSON.stringify(started.body);
    assertNoPii(startedSerialized);
    assertNoRawLocation(startedSerialized);

    // Same-key replay converges (200) — no duplicate fact, no duplicate
    // lifecycle transition.
    const replay = await api()
      .post(R.startSession(ctx.visit.id))
      .set(auth(leadToken))
      .send(input);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.converged, true);
    assert.equal(replay.body.data.session.id, session.id);

    // At most ONE OPEN session: a fresh legal start by the SAME lead while
    // the session is OPEN converges onto the recorded OPEN fact (200) and
    // never opens a second window (the Run-2 replay-completes doctrine;
    // the 409 ALREADY_OPEN branch belongs to a DIFFERENT lead over an open
    // window — Run-2 domain depth, not duplicated here).
    const second = await api()
      .post(R.startSession(ctx.visit.id))
      .set(auth(leadToken))
      .send(startInput());
    assert.equal(second.status, 200);
    assert.equal(second.body.data.converged, true);
    assert.equal(second.body.data.session.id, session.id);
    assert.equal((await sessionRows(ctx.visit.id)).length, 1);

    // A non-lead field credential is denied by the domain (RBAC passed).
    const strangerToken = await createSessionWithPermissions([PERM.manage]);
    const stranger = await api()
      .post(R.startSession(ctx.visit.id))
      .set(auth(strangerToken))
      .send(startInput());
    assert.equal(stranger.status, 403);
    assert.equal(errCode(stranger), 'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD');
  });

  it('keeps Case D the domain 409 EXECUTION_STATE_INCONSISTENT on the wire (never flattened)', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const leadToken = await leadTokenFor(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);

    // Split-brain: the work order advanced while its vendor work has not.
    await transitionWorkOrderStatus(ctx.job.workOrderId, {
      status: 'IN_PROGRESS',
    });

    const res = await api()
      .post(R.startSession(ctx.visit.id))
      .set(auth(leadToken))
      .send(startInput());
    assert.equal(res.status, 409);
    assert.equal(
      errCode(res),
      'HANDYMAN_WORK_SESSION_EXECUTION_STATE_INCONSISTENT',
    );
    // Never normalized in either direction, no session fact created.
    assert.equal((await vendorWorkRow(vendorWorkId)).status, 'NOT_STARTED');
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'IN_PROGRESS',
    );
    assert.deepEqual((await sessionRows(ctx.visit.id)).length, 0);
  });

  it('ends the session replay-safe with real attribution, no body authority and no lifecycle side effects', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const leadToken = await leadTokenFor(ctx);
    const started = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);

    // A non-lead credential cannot close the window (domain authority).
    const strangerToken = await createSessionWithPermissions([PERM.manage]);
    const stranger = await api()
      .post(R.endSession(started.session.id))
      .set(auth(strangerToken))
      .send({});
    assert.equal(stranger.status, 403);
    assert.equal(errCode(stranger), 'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD');

    // The end command accepts NO business body.
    const withBody = await api()
      .post(R.endSession(started.session.id))
      .set(auth(leadToken))
      .send({ reason: 'work done', endedAt: new Date().toISOString() });
    assert.equal(withBody.status, 400);
    assert.equal(errCode(withBody), 'VALIDATION_ERROR');
    const fields = detailFields(withBody);
    assert.ok(fields.includes('reason'));
    assert.ok(fields.includes('endedAt'));

    // Lead closes: server-stamped endedAt + the real closing actor.
    const ended = await api()
      .post(R.endSession(started.session.id))
      .set(auth(leadToken))
      .send({});
    assert.equal(ended.status, 200);
    exactKeys(ended.body.data, END_RESULT_KEYS);
    exactKeys(ended.body.data.session, SESSION_KEYS);
    assert.equal(ended.body.data.converged, false);
    assert.equal(ended.body.data.session.status, 'CLOSED');
    assert.equal(ended.body.data.session.endedByUserId, ctx.leadUser.id);
    assert.ok(ended.body.data.session.endedAt !== null);

    // End NEVER completes financials, vendor work or the work order.
    assert.equal((await vendorWorkRow(vendorWorkId)).status, 'IN_PROGRESS');
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'IN_PROGRESS',
    );

    // Replay-safe: converges with the recorded attribution intact.
    const replay = await api()
      .post(R.endSession(started.session.id))
      .set(auth(leadToken))
      .send({});
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.converged, true);
    assert.equal(replay.body.data.session.status, 'CLOSED');
    assert.equal(
      replay.body.data.session.endedAt,
      ended.body.data.session.endedAt,
    );

    // Unknown session: the owned 404 (RBAC-valid credential).
    const notFound = await api()
      .post(R.endSession(randomUUID()))
      .set(auth(leadToken))
      .send({});
    assert.equal(notFound.status, 404);
    assert.equal(errCode(notFound), 'HANDYMAN_WORK_SESSION_NOT_FOUND');
  });

  it('reads sessions behind the field-execution scope with the Run-2 public model only', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const leadToken = await leadTokenFor(ctx);
    const started = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );

    const list = await api()
      .get(R.sessions(ctx.visit.id))
      .set(auth(leadToken));
    assert.equal(list.status, 200);
    const rows = list.body.data as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    exactKeys(rows[0], SESSION_KEYS);
    assert.equal((rows[0] as any).id, started.session.id);
    const serialized = JSON.stringify(list.body);
    assertNoPii(serialized);
    for (const forbidden of [
      'billing',
      'labor',
      'rate',
      'amount',
      'invoice',
      'idempotencyKey',
      'latitude',
      'longitude',
    ]) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden),
        `${forbidden} must never appear on the session read model`,
      );
    }

    const single = await api()
      .get(R.session(started.session.id))
      .set(auth(leadToken));
    assert.equal(single.status, 200);
    exactKeys(single.body.data, SESSION_KEYS);

    // Staff client scope reads; an out-of-scope read credential is denied
    // by the service-owned read scope.
    const asAdmin = await api()
      .get(R.sessions(ctx.visit.id))
      .set(auth(adminToken));
    assert.equal(asAdmin.status, 200);
    assert.equal((asAdmin.body.data as unknown[]).length, 1);

    const scopedRead = await createSessionWithPermissions([PERM.read]);
    const denied = await api()
      .get(R.sessions(ctx.visit.id))
      .set(auth(scopedRead));
    assert.equal(denied.status, 403);
    assert.equal(errCode(denied), 'BUILDING_ACCESS_DENIED');

    const notFound = await api()
      .get(R.session(randomUUID()))
      .set(auth(leadToken));
    assert.equal(notFound.status, 404);
    assert.equal(errCode(notFound), 'HANDYMAN_WORK_SESSION_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ */
/* 6. Runtime ↔ OpenAPI parity                                         */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-06 RUN 3 — runtime/OpenAPI parity', () => {
  const BE06_TAG = 'Handyman Field Execution';

  type SpecOp = {
    'x-required-permission'?: string;
    tags?: string[];
    operationId?: string;
    security?: unknown[];
  };
  type Spec = {
    paths: Record<string, Record<string, SpecOp>>;
    components: {
      schemas: Record<string, { properties?: Record<string, unknown> }>;
    };
  };

  function loadSpec(): Spec {
    return parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as Spec;
  }

  const GATE_CODES: Record<string, string> = {
    executionRead: 'handyman_work_execution.read',
    executionManage: 'handyman_work_execution.manage',
    visitManage: 'handyman_service_visit.manage',
  };

  function runtimeOperations(): Record<
    string,
    Record<string, string>
  > {
    const source = readFileSync(
      resolve(
        __dirname,
        '../src/modules/handyman-jobs/handyman-field-execution.routes.ts',
      ),
      'utf8',
    );
    // Exactly three permission gates may be wired (existing codes only).
    const wired = (source.match(/requirePermission\('([^']+)'\)/g) ?? []).map(
      (call) => call.slice("requirePermission('".length, -2),
    );
    assert.deepEqual([...new Set(wired)].sort(), [
      'handyman_service_visit.manage',
      'handyman_work_execution.manage',
      'handyman_work_execution.read',
    ]);
    assert.equal(wired.length, 3, 'exactly three literal gate call sites');

    const operations: Record<string, Record<string, string>> = {};
    for (const match of source.matchAll(
      /router\.(get|post|put|patch|delete)\(\s*'([^']+)',\s*auth,\s*(\w+),/g,
    )) {
      const [, method, rawPath, gate] = match;
      assert.ok(GATE_CODES[gate], `unknown gate const ${gate}`);
      const path = rawPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      (operations[path] ??= {})[method] = GATE_CODES[gate];
    }
    return operations;
  }

  it('documents exactly the runtime operation set with exact permission parity', async (t) => {
    if (!ready(t)) return;
    const spec = loadSpec();
    const runtime = runtimeOperations();

    const documented: Record<string, Record<string, string>> = {};
    let operationCount = 0;
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          continue;
        }
        if (!(op?.tags ?? []).includes(BE06_TAG)) continue;
        operationCount += 1;
        (documented[path] ??= {})[method] =
          op['x-required-permission'] ?? '';
        // Every operation: bearer auth exactly, and a documented permission.
        assert.deepEqual(op.security, [{ bearerAuth: [] }], `${method} ${path}`);
        assert.ok(
          typeof op['x-required-permission'] === 'string' &&
            op['x-required-permission'].length > 0,
          `${method} ${path} must document x-required-permission`,
        );
        assert.ok(op.operationId, `${method} ${path} needs an operationId`);
      }
    }

    assert.equal(operationCount, 10, 'exactly ten BE-06 operations');
    assert.deepEqual(
      Object.keys(documented).sort(),
      Object.keys(runtime).sort(),
      'spec path set must equal the runtime path set',
    );
    for (const path of Object.keys(runtime)) {
      assert.deepEqual(
        documented[path],
        runtime[path],
        `methods + permissions must match exactly on ${path}`,
      );
    }

    // No DELETE / PUT / PATCH anywhere — runtime or spec (facts are
    // append-only or converged; lifecycle is never directly mutable).
    for (const [path, methods] of Object.entries(runtime)) {
      for (const forbidden of ['delete', 'put', 'patch']) {
        assert.ok(
          !(forbidden in methods),
          `${forbidden.toUpperCase()} ${path} must not exist at runtime`,
        );
      }
    }
    for (const path of Object.keys(documented)) {
      const item = spec.paths[path];
      assert.equal(item.delete, undefined, `${path} must not document DELETE`);
      assert.equal(item.put, undefined, `${path} must not document PUT`);
      assert.equal(item.patch, undefined, `${path} must not document PATCH`);
    }
  });

  it('documents strict body allowlists, privacy-safe read models and no future-scope surface', async (t) => {
    if (!ready(t)) return;
    const spec = loadSpec();
    const schemas = spec.components.schemas;

    const expectedBodyKeys: Record<string, string[]> = {
      RecordGpsHandymanVisitArrival: [
        'accuracyMeters',
        'idempotencyKey',
        'latitude',
        'longitude',
        'occurredAt',
      ],
      RecordAssistedHandymanVisitArrival: [
        'assistedReason',
        'idempotencyKey',
        'occurredAt',
      ],
      RecordHandymanVisitPresence: [
        'presenceStatus',
        'vendorWorkforceBindingId',
      ],
      RecordAssistedHandymanVisitPresence: [
        'assistedReason',
        'presenceStatus',
        'vendorWorkforceBindingId',
      ],
      StartHandymanWorkSession: ['idempotencyKey', 'occurredAt'],
      HandymanVisitArrival: ARRIVAL_KEYS,
      HandymanVisitArrivalCommandResult: ARRIVAL_RESULT_KEYS,
      HandymanVisitPresenceRow: PRESENCE_ROW_KEYS,
      HandymanVisitPresenceReadView: PRESENCE_VIEW_KEYS,
      HandymanWorkSession: SESSION_KEYS,
      HandymanExecutionStartState: EXECUTION_STATE_KEYS,
      HandymanWorkSessionStartResult: START_RESULT_KEYS,
      HandymanWorkSessionEndResult: END_RESULT_KEYS,
    };
    for (const [name, keys] of Object.entries(expectedBodyKeys)) {
      assert.ok(schemas[name], `schema ${name} must be documented`);
      assert.deepEqual(
        Object.keys(schemas[name].properties ?? {}).sort(),
        [...keys].sort(),
        `${name} must document exactly the wire allowlist`,
      );
    }

    // No raw GPS / device / idempotency / financial fact is documented on
    // ANY read model, and the presence row never carries the assisted
    // free-text reason.
    for (const name of [
      'HandymanVisitArrival',
      'HandymanVisitPresenceRow',
      'HandymanVisitPresenceReadView',
      'HandymanWorkSession',
    ]) {
      const keys = Object.keys(schemas[name].properties ?? {});
      for (const forbidden of [
        'latitude',
        'longitude',
        'accuracyMeters',
        'distanceMeters',
        'radiusMeters',
        'idempotencyKey',
        'idempotencyFingerprint',
        'deviceId',
        'deviceToken',
        'evidenceUrl',
        'fullName',
        'phone',
        'email',
        'workerName',
        'vendorPersonnelCode',
        'employeeCode',
        'billingRate',
        'laborAmount',
        'billableHours',
        'duration',
        'invoice',
      ]) {
        assert.ok(
          !keys.includes(forbidden),
          `${forbidden} must never be documented on ${name}`,
        );
      }
    }
    assert.ok(
      !Object.keys(schemas.HandymanVisitPresenceRow.properties ?? {}).includes(
        'assistedReason',
      ),
      'the assisted free-text reason must stay off the presence row model',
    );

    // No future-scope surface exists in the BE-06 paths or schema names.
    const be06Paths = Object.keys(spec.paths).filter((path) =>
      Object.values(spec.paths[path]).some(
        (op) => op && (op.tags ?? []).includes(BE06_TAG),
      ),
    );
    const schemaNames = Object.keys(schemas).filter(
      (name) =>
        name.startsWith('HandymanVisitArrival') ||
        name.startsWith('HandymanVisitPresence') ||
        name.startsWith('HandymanWorkSession') ||
        name.startsWith('RecordGpsHandymanVisitArrival') ||
        name.startsWith('RecordAssistedHandymanVisit') ||
        name.startsWith('RecordHandymanVisitPresence') ||
        name.startsWith('RecordAssistedHandymanVisitPresence') ||
        name.startsWith('StartHandymanWorkSession') ||
        name === 'HandymanExecutionStartState',
    );
    for (const surface of [...be06Paths, ...schemaNames]) {
      for (const forbidden of [
        'qr',
        'material',
        'bast',
        'invoice',
        'payment',
        'warranty',
        'notification',
        'payroll',
        'settlement',
        'attendance',
        'check-in',
        'checkin',
      ]) {
        assert.ok(
          !surface.toLowerCase().includes(forbidden),
          `forbidden future-scope token ${forbidden} in ${surface}`,
        );
      }
    }
  });
});
