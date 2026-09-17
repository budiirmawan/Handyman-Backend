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
  updateBuildingConfiguration,
} from '../src/modules/building-configurations';
import { clientService, type PublicClient } from '../src/modules/clients';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { departmentService } from '../src/modules/departments';
import { entitlementService } from '../src/modules/entitlements';
import { floorService } from '../src/modules/floors';
import {
  HANDYMAN_ARRIVAL_VERIFICATION_CONFIGURATION_KEY,
  evaluateHandymanVisitExecutionPresence,
  recordAssistedHandymanVisitArrival,
  recordAssistedHandymanVisitPresence,
  recordGpsHandymanVisitArrival,
  recordHandymanVisitPresenceByLead,
} from '../src/modules/handyman-jobs';
import {
  assignHandymanJobProviderAndCrew,
  createHandymanJob,
  createHandymanServiceVisit,
  cancelHandymanServiceVisitSchedule,
  reassignHandymanJobProviderAndCrew,
} from '../src/modules/handyman-jobs';
import {
  HANDYMAN_MODULE_CODE,
  designateHandymanProvider,
} from '../src/modules/handyman-providers';
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
import {
  addHandymanWorkCrewMember,
  createHandymanWorkCrew,
  updateHandymanWorkCrewStatus,
} from '../src/modules/handyman-work-crews';
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
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { transitionWorkOrderStatus } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-06 RUN 1 — focused service-level suite for the arrival,
 * location-verification and crew-presence authority:
 * append-only attempts, server-owned GPS decisions against the ACTIVATED
 * building arrival policy (fail-closed, provenance-exact), the assisted
 * override, command-time revalidation, the atomic crew presence snapshot,
 * governed presence marking (lead field path + staff-assisted path), the
 * pure execution-start presence evaluation, client-scoped idempotency and
 * the structural concurrency backstops.
 *
 * Fixtures consume the governed chain end to end (the BE-05 idiom): every
 * scenario starts from a real APPROVED request → job → assigned composition
 * → scheduled visit before any arrival exists.
 */

const PORT = 55508;
const DIR = '/tmp/asentra-hm06-run1-pg';
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
const CUSTOMER_PHONE = '+6281298765006';
const CUSTOMER_EMAIL = 'rina06r1@customer.example.com';

/** Distinctive policy point — its exact string form doubles as the
 * raw-location canary for read-model/audit assertions. */
const POLICY_LATITUDE = -6.213456;
const POLICY_LONGITUDE = 106.823456;
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
/** ~556 m north of the policy point (outside the 150 m radius). */
const OUTSIDE_LATITUDE = POLICY_LATITUDE + 0.005;

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
    `TRUNCATE handyman_visit_presence, handyman_visit_arrivals,
      handyman_service_visit_schedules, handyman_service_visits,
      handyman_job_assignments, handyman_jobs, vendor_works,
      vendor_assignments, work_permit_readiness, work_orders,
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
    email: `outsider06r1-${suffix().toLowerCase()}@example.com`,
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

/* ------------------------------------------------------------------ */
/* Fixtures — the full governed chain through a SCHEDULED visit        */
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
      name: 'Arrival Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Arrival Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Arrival Tower',
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
      tenantName: 'Arrival Tenant Company',
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
    email: `pic06r1-${suffix().toLowerCase()}@tenant.example.com`,
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
      email: `pic06r1-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000016',
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
      name: 'Arrival Service',
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
    name: 'Arrival Workforce Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Arrival Workforce Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Arrival Workforce Position',
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
async function makeArrivalBase(options: { helpers?: number } = {}) {
  const helperCount = options.helpers ?? 1;
  const h = await createHierarchy();
  const tenant = await makeTenantContext(h);
  const moduleId = await ensureHandymanModule();
  await configureHandymanBuilding(h.building.id);

  const vendor = await vendorService.createVendor({
    clientId: h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Arrival Vendor',
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
    name: 'Arrival Capability',
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
    email: `lead06r1-${suffix().toLowerCase()}@worker.example.com`,
    displayName: 'Lead Worker User',
  });
  const lead = await createWorker(vendor.id, chain, 'LeadOne', leadUser.id);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: 'Arrival Crew One',
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

type ArrivalBase = Awaited<ReturnType<typeof makeArrivalBase>>;

/** A SECOND fully eligible provider+crew (user-linked lead) on the same
 * client/building/service — reassignment and foreign-lead scenarios. */
async function addEligibleProvider(base: ArrivalBase, role: string) {
  const vendor = await vendorService.createVendor({
    clientId: base.h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: `Arrival Vendor ${role}`,
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
    name: `Arrival Capability ${role}`,
    serviceCatalogId: base.service.id,
    vendorBuildingRelationshipId: relationship.id,
  });
  const leadUser = await userService.createUser({
    email: `${role.toLowerCase()}06r1-${suffix().toLowerCase()}@worker.example.com`,
    displayName: `Alternate Lead User ${role}`,
  });
  const lead = await createWorker(vendor.id, base.chain, role, leadUser.id);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: base.h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: `Arrival Crew ${role}`,
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
 * Job created + provider/crew assigned + first visit scheduled, plus (by
 * default) the ACTIVATED READY arrival policy on the canonical building.
 */
async function makeScheduledVisit(options: {
  policy?: Record<string, unknown> | null;
  policyStatus?: 'ACTIVE' | 'INACTIVE';
  activatePolicy?: boolean;
  helpers?: number;
} = {}) {
  const base = await makeArrivalBase({ helpers: options.helpers });
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

  let configuration: { id: string } | null = null;
  let configurationVersionId: string | null = null;
  const policyValue =
    options.policy === undefined ? readyPolicyValue() : options.policy;
  if (policyValue) {
    configuration = await createBuildingConfiguration(
      {
        buildingId: base.h.building.id,
        key: HANDYMAN_ARRIVAL_VERIFICATION_CONFIGURATION_KEY,
        value: policyValue,
        status: options.policyStatus ?? 'ACTIVE',
      },
      adminUserId,
    );
    if (options.activatePolicy ?? true) {
      configurationVersionId = await activateLatestConfigurationVersion(
        adminToken,
        'BUILDING_CONFIGURATION',
        configuration.id,
      );
    }
  }

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

function gpsInput(overrides: {
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number | null;
  occurredAt?: string | null;
  idempotencyKey?: string;
} = {}) {
  return {
    latitude: overrides.latitude ?? INSIDE_LATITUDE,
    longitude: overrides.longitude ?? POLICY_LONGITUDE,
    accuracyMeters:
      overrides.accuracyMeters === undefined ? 12.5 : overrides.accuracyMeters,
    occurredAt:
      overrides.occurredAt === undefined
        ? new Date(Date.now() - 3_600_000).toISOString()
        : overrides.occurredAt,
    idempotencyKey:
      overrides.idempotencyKey ?? `ARR_${suffix()}_${randomUUID()}`,
  };
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

type ArrivalRow = {
  id: string;
  client_id: string;
  handyman_service_visit_id: string;
  verification_method: string;
  verification_result: string;
  received_at: Date;
  occurred_at: Date | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  distance_meters: number | null;
  building_configuration_id: string | null;
  configuration_version_id: string | null;
  assisted_reason: string | null;
  failure_reason: string | null;
  recorded_by_user_id: string;
  idempotency_key: string;
};

async function arrivalRows(visitId: string): Promise<ArrivalRow[]> {
  const result = await requirePool().query<ArrivalRow>(
    `SELECT * FROM handyman_visit_arrivals
     WHERE handyman_service_visit_id = $1
     ORDER BY created_at ASC, id ASC`,
    [visitId],
  );
  return result.rows;
}

type PresenceRow = {
  id: string;
  client_id: string;
  handyman_service_visit_id: string;
  handyman_visit_arrival_id: string;
  handyman_job_assignment_id: string;
  handyman_work_crew_id: string;
  vendor_workforce_binding_id: string;
  crew_role: string;
  presence_status: string;
  recorded_via: string | null;
  recorded_by_user_id: string | null;
  recorded_at: Date | null;
  assisted_reason: string | null;
};

async function presenceRows(visitId: string): Promise<PresenceRow[]> {
  const result = await requirePool().query<PresenceRow>(
    `SELECT * FROM handyman_visit_presence
     WHERE handyman_service_visit_id = $1
     ORDER BY crew_role ASC, vendor_workforce_binding_id ASC`,
    [visitId],
  );
  return result.rows;
}

async function eventsFor(entityId: string) {
  const result = await requirePool().query(
    `SELECT event_type, entity_type, building_id, metadata, summary
     FROM operational_events
     WHERE entity_id = $1
     ORDER BY occurred_at ASC`,
    [entityId],
  );
  return result.rows as {
    event_type: string;
    entity_type: string;
    building_id: string | null;
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

/** Drives one VERIFIED GPS arrival (the shared starting fact of the
 * presence scenarios). */
async function arriveVerified(ctx: ScheduledVisit) {
  const startedAt = Date.now();
  const input = gpsInput();
  const result = await recordGpsHandymanVisitArrival(
    ctx.visit.id,
    input,
    ctx.leadUser.id,
  );
  assert.equal(result.converged, false);
  assert.equal(result.arrival.verificationResult, 'VERIFIED');
  return { result, input, startedAt };
}

/* ------------------------------------------------------------------ */
/* 1. VERIFIED GPS arrival + atomic presence snapshot                  */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-06 RUN 1: arrival + location verification + crew presence', () => {
  it('records a VERIFIED GPS arrival with the server-owned decision, exact policy provenance and the atomic crew presence snapshot', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const { result, input, startedAt } = await arriveVerified(ctx);

    // Public result: server facts only, decided by the backend.
    assert.equal(result.arrival.verificationMethod, 'GPS');
    assert.equal(result.arrival.verificationResult, 'VERIFIED');
    assert.equal(result.arrival.failureReason, null);
    assert.equal(result.arrival.recordedByUserId, ctx.leadUser.id);
    assert.equal(result.arrival.handymanServiceVisitId, ctx.visit.id);
    assert.equal(result.arrival.clientId, ctx.h.client.id);
    // Exact policy provenance pinned on the attempt.
    assert.equal(
      result.arrival.buildingConfigurationId,
      ctx.configuration?.id,
    );
    assert.equal(
      result.arrival.configurationVersionId,
      ctx.configurationVersionId,
    );
    // Client-claimed occurredAt retained as evidence; receivedAt is
    // server-authoritative (>= test start).
    assert.equal(result.arrival.occurredAt, input.occurredAt);
    assert.ok(new Date(result.arrival.receivedAt).getTime() >= startedAt);

    // The evidence row stores the raw claim + the server-computed distance.
    const rows = await arrivalRows(ctx.visit.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].latitude, input.latitude);
    assert.equal(rows[0].longitude, input.longitude);
    assert.equal(rows[0].accuracy_meters, 12.5);
    assert.ok(rows[0].distance_meters !== null);
    assert.ok(rows[0].distance_meters! > 0);
    assert.ok(rows[0].distance_meters! <= POLICY_RADIUS_METERS);
    assert.equal(rows[0].assisted_reason, null);

    // The presence snapshot was created in the SAME transaction: one row
    // per ACTIVE composition member, IDs/roles only, all PENDING.
    assert.equal(result.presence.length, 2);
    const presence = await presenceRows(ctx.visit.id);
    assert.equal(presence.length, 2);
    const leadRow = presence.find((row) => row.crew_role === 'LEAD_WORKER');
    const helperRow = presence.find((row) => row.crew_role === 'HELPER');
    assert.ok(leadRow && helperRow);
    assert.equal(leadRow.vendor_workforce_binding_id, ctx.lead.binding.id);
    assert.equal(
      helperRow.vendor_workforce_binding_id,
      ctx.helpers[0].binding.id,
    );
    for (const row of presence) {
      assert.equal(row.handyman_visit_arrival_id, result.arrival.id);
      assert.equal(row.handyman_job_assignment_id, ctx.assignment.assignment.id);
      assert.equal(row.handyman_work_crew_id, ctx.crew.id);
      assert.equal(row.client_id, ctx.h.client.id);
      assert.equal(row.presence_status, 'PENDING');
      assert.equal(row.recorded_via, null);
      assert.equal(row.recorded_by_user_id, null);
      assert.equal(row.recorded_at, null);
      assert.equal(row.assisted_reason, null);
    }

    // Audit: one event, IDs + decision facts only.
    const events = await eventsFor(result.arrival.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'HANDYMAN_VISIT_ARRIVAL_RECORDED');
    assert.equal(events[0].entity_type, 'HANDYMAN_VISIT_ARRIVAL');
    assert.equal(events[0].building_id, ctx.h.building.id);
    assert.equal(events[0].metadata.verificationResult, 'VERIFIED');
    assert.equal(events[0].metadata.verificationMethod, 'GPS');
    assert.equal(
      events[0].metadata.configurationVersionId,
      ctx.configurationVersionId,
    );
    assertNoPii(JSON.stringify(events));
    assertNoRawLocation(JSON.stringify(events));

    // Privacy canaries: the public read model carries no raw GPS evidence.
    const serialized = JSON.stringify(result);
    assertNoRawLocation(serialized);
    assertNoPii(serialized);
    assert.ok(!serialized.includes('12.5'), 'accuracy leaked into read model');
    assert.ok(
      !serialized.includes(String(rows[0].distance_meters)),
      'distance leaked into read model',
    );
  });

  it('records an out-of-radius GPS attempt as FAILED history without a snapshot, and a later inside-radius attempt verifies (append-only)', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();

    const failed = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput({ latitude: OUTSIDE_LATITUDE }),
      ctx.leadUser.id,
    );
    assert.equal(failed.converged, false);
    assert.equal(failed.arrival.verificationResult, 'FAILED');
    assert.equal(failed.arrival.failureReason, 'DISTANCE_EXCEEDED');
    assert.equal(failed.presence.length, 0);
    // Provenance of the evaluated policy is pinned even on FAILED.
    assert.equal(
      failed.arrival.buildingConfigurationId,
      ctx.configuration?.id,
    );
    assert.equal(
      failed.arrival.configurationVersionId,
      ctx.configurationVersionId,
    );
    assert.equal((await presenceRows(ctx.visit.id)).length, 0);
    const failedRow = (await arrivalRows(ctx.visit.id))[0];
    assert.ok(failedRow.distance_meters! > POLICY_RADIUS_METERS);
    const failedEvents = await eventsFor(failed.arrival.id);
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0].metadata.verificationResult, 'FAILED');
    assert.equal(failedEvents[0].metadata.failureReason, 'DISTANCE_EXCEEDED');
    assertNoRawLocation(JSON.stringify(failedEvents));

    // A NEW key records a NEW attempt (history is never suppressed).
    const verified = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput(),
      ctx.leadUser.id,
    );
    assert.equal(verified.arrival.verificationResult, 'VERIFIED');
    const rows = await arrivalRows(ctx.visit.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, failed.arrival.id);
    assert.equal(rows[0].verification_result, 'FAILED');
    assert.equal(rows[1].id, verified.arrival.id);
    assert.equal(rows[1].verification_result, 'VERIFIED');
    // The FAILED row was never rewritten.
    assert.equal(rows[0].distance_meters, failedRow.distance_meters);
    assert.equal((await presenceRows(ctx.visit.id)).length, 2);
  });

  it('fails GPS verification closed on every policy defect: absent, inactive record, unactivated version, invalid schema, disabled, GPS not allowed', async (t) => {
    if (!ready(t)) return;

    // (a) No configuration row at all — NO magic/default radius exists.
    const absent = await makeScheduledVisit({ policy: null });
    const absentResult = await recordGpsHandymanVisitArrival(
      absent.visit.id,
      gpsInput(),
      absent.leadUser.id,
    );
    assert.equal(absentResult.arrival.verificationResult, 'FAILED');
    assert.equal(
      absentResult.arrival.failureReason,
      'ARRIVAL_POLICY_UNAVAILABLE',
    );
    assert.equal(absentResult.arrival.buildingConfigurationId, null);
    assert.equal(absentResult.arrival.configurationVersionId, null);
    assert.equal((await presenceRows(absent.visit.id)).length, 0);

    // (b) The record exists but is INACTIVE (availability fail-closed).
    const inactive = await makeScheduledVisit({
      policyStatus: 'INACTIVE',
      activatePolicy: false,
    });
    const inactiveResult = await recordGpsHandymanVisitArrival(
      inactive.visit.id,
      gpsInput(),
      inactive.leadUser.id,
    );
    assert.equal(inactiveResult.arrival.verificationResult, 'FAILED');
    assert.equal(
      inactiveResult.arrival.failureReason,
      'ARRIVAL_POLICY_UNAVAILABLE',
    );
    assert.equal(
      inactiveResult.arrival.buildingConfigurationId,
      inactive.configuration?.id,
    );
    assert.equal(inactiveResult.arrival.configurationVersionId, null);

    // (c)→(f) One context driven through the version lifecycle: DRAFT-only
    // (unavailable), then activated-but-invalid, disabled, GPS-not-allowed.
    const lifecycle = await makeScheduledVisit({ activatePolicy: false });
    const draftResult = await recordGpsHandymanVisitArrival(
      lifecycle.visit.id,
      gpsInput(),
      lifecycle.leadUser.id,
    );
    assert.equal(draftResult.arrival.verificationResult, 'FAILED');
    assert.equal(
      draftResult.arrival.failureReason,
      'ARRIVAL_POLICY_UNAVAILABLE',
    );

    // Activate the READY policy, then supersede it through governed updates
    // (each update captures a new DRAFT version; activation supersedes the
    // previous ACTIVE one — the BE-27N/O lifecycle).
    const configId = lifecycle.configuration!.id;
    const updateAndActivate = async (value: Record<string, unknown>) => {
      await updateBuildingConfiguration(configId, { value }, adminUserId);
      return activateLatestConfigurationVersion(
        adminToken,
        'BUILDING_CONFIGURATION',
        configId,
      );
    };

    const invalidVersionId = await updateAndActivate(
      readyPolicyValue({ radiusMeters: 0 }),
    );
    const invalidResult = await recordGpsHandymanVisitArrival(
      lifecycle.visit.id,
      gpsInput(),
      lifecycle.leadUser.id,
    );
    assert.equal(invalidResult.arrival.verificationResult, 'FAILED');
    assert.equal(invalidResult.arrival.failureReason, 'ARRIVAL_POLICY_INVALID');
    assert.equal(invalidResult.arrival.buildingConfigurationId, configId);
    assert.equal(invalidResult.arrival.configurationVersionId, invalidVersionId);

    const disabledVersionId = await updateAndActivate(
      readyPolicyValue({ enabled: false }),
    );
    const disabledResult = await recordGpsHandymanVisitArrival(
      lifecycle.visit.id,
      gpsInput(),
      lifecycle.leadUser.id,
    );
    assert.equal(disabledResult.arrival.verificationResult, 'FAILED');
    assert.equal(disabledResult.arrival.failureReason, 'GPS_NOT_ENABLED');
    assert.equal(disabledResult.arrival.configurationVersionId, disabledVersionId);

    const methodsVersionId = await updateAndActivate(
      readyPolicyValue({ allowedMethods: ['ASSISTED'] }),
    );
    const methodsResult = await recordGpsHandymanVisitArrival(
      lifecycle.visit.id,
      gpsInput(),
      lifecycle.leadUser.id,
    );
    assert.equal(methodsResult.arrival.verificationResult, 'FAILED');
    assert.equal(methodsResult.arrival.failureReason, 'GPS_METHOD_NOT_ALLOWED');
    assert.equal(methodsResult.arrival.configurationVersionId, methodsVersionId);

    // All attempts accumulated as append-only FAILED history; no snapshot
    // ever appeared; the disabled policy still allows the ASSISTED override
    // (ASSISTED is the governed fallback, never policy-gated).
    const rows = await arrivalRows(lifecycle.visit.id);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.verification_result === 'FAILED'));
    assert.equal((await presenceRows(lifecycle.visit.id)).length, 0);
    const assisted = await recordAssistedHandymanVisitArrival(
      lifecycle.visit.id,
      {
        assistedReason: 'Building arrival policy disabled; site security confirmed the crew on location.',
        idempotencyKey: `ARR_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(assisted.arrival.verificationResult, 'VERIFIED');
    assert.equal(assisted.arrival.verificationMethod, 'ASSISTED');
    // The ASSISTED VERIFIED arrival snapshotted the crew (lead + 1 helper).
    assert.equal((await presenceRows(lifecycle.visit.id)).length, 2);
  });

  it('stores honest evidence for invalid GPS claims as FAILED attempts (out-of-range, non-finite, bad accuracy)', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();

    // Finite but out-of-range latitude: stored EXACTLY as claimed.
    const outOfRange = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput({ latitude: 999 }),
      ctx.leadUser.id,
    );
    assert.equal(outOfRange.arrival.verificationResult, 'FAILED');
    assert.equal(outOfRange.arrival.failureReason, 'INVALID_COORDINATES');

    // Non-finite claim: unrepresentable, stored as null with the reason.
    const nonFinite = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput({ latitude: Number.NaN }),
      ctx.leadUser.id,
    );
    assert.equal(nonFinite.arrival.verificationResult, 'FAILED');
    assert.equal(nonFinite.arrival.failureReason, 'INVALID_COORDINATES');

    // Non-positive accuracy with valid coordinates.
    const badAccuracy = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput({ accuracyMeters: -5 }),
      ctx.leadUser.id,
    );
    assert.equal(badAccuracy.arrival.verificationResult, 'FAILED');
    assert.equal(badAccuracy.arrival.failureReason, 'INVALID_ACCURACY');

    const rows = await arrivalRows(ctx.visit.id);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].latitude, 999); // raw claim retained as evidence
    assert.equal(rows[0].longitude, POLICY_LONGITUDE);
    assert.equal(rows[1].latitude, null);
    assert.equal(rows[1].longitude, POLICY_LONGITUDE);
    assert.equal(rows[2].latitude, INSIDE_LATITUDE);
    assert.equal(rows[2].accuracy_meters, null);
    assert.equal(rows[2].distance_meters, null);
    // Policy provenance recorded: the policy WAS resolved and consulted.
    for (const row of rows) {
      assert.equal(row.building_configuration_id, ctx.configuration?.id);
      assert.equal(row.configuration_version_id, ctx.configurationVersionId);
    }
    assert.equal((await presenceRows(ctx.visit.id)).length, 0);
  });

  it('converges every later arrival command onto the one VERIFIED arrival and backstops it structurally', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const { result } = await arriveVerified(ctx);

    // Another would-be-VERIFIED GPS command (new key): converges, no new row.
    const second = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput(),
      ctx.leadUser.id,
    );
    assert.equal(second.converged, true);
    assert.equal(second.arrival.id, result.arrival.id);
    assert.equal(second.presence.length, 2);

    // A would-be-FAILED GPS command (new key): also converges — no junk
    // attempts are appended after the fact is established.
    const third = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput({ latitude: OUTSIDE_LATITUDE }),
      ctx.leadUser.id,
    );
    assert.equal(third.converged, true);
    assert.equal(third.arrival.id, result.arrival.id);
    assert.equal(third.arrival.verificationMethod, 'GPS');

    // An ASSISTED command converges too — never a second VERIFIED arrival,
    // and the original method stays GPS.
    const assisted = await recordAssistedHandymanVisitArrival(
      ctx.visit.id,
      {
        assistedReason: 'Duplicate submission from the site supervisor.',
        idempotencyKey: `ARR_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(assisted.converged, true);
    assert.equal(assisted.arrival.id, result.arrival.id);

    const rows = await arrivalRows(ctx.visit.id);
    assert.equal(rows.length, 1);
    assert.equal(
      rows.filter((row) => row.verification_result === 'VERIFIED').length,
      1,
    );

    // Structural backstop: a second VERIFIED row is impossible even for a
    // raw writer bypassing the service.
    await expectPgConstraint(
      requirePool().query(
        `INSERT INTO handyman_visit_arrivals
           (id, client_id, handyman_service_visit_id, verification_method,
            verification_result, received_at, latitude, longitude,
            distance_meters, building_configuration_id,
            configuration_version_id, recorded_by_user_id, idempotency_key,
            idempotency_fingerprint)
         VALUES ($1, $2, $3, 'GPS', 'VERIFIED', NOW(), $4, $5, 10, $6, $7, $8, $9, 'fp')`,
        [
          randomUUID(),
          ctx.h.client.id,
          ctx.visit.id,
          INSIDE_LATITUDE,
          POLICY_LONGITUDE,
          ctx.configuration?.id,
          ctx.configurationVersionId,
          adminUserId,
          `RAW_${suffix()}`,
        ],
      ),
      '23505',
      'handyman_visit_arrivals_one_verified_per_visit',
    );
  });

  it('enforces client-scoped idempotency: replay converges, different facts conflict, a new key records new history, keys never collide across clients', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const key = `ARR_SHARED_${suffix()}`;
    const input = gpsInput({ latitude: OUTSIDE_LATITUDE, idempotencyKey: key });

    const first = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      input,
      ctx.leadUser.id,
    );
    assert.equal(first.arrival.verificationResult, 'FAILED');
    assert.equal(first.converged, false);

    // Replay with the same key + same facts: the ORIGINAL attempt.
    const replay = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      { ...input },
      ctx.leadUser.id,
    );
    assert.equal(replay.converged, true);
    assert.equal(replay.arrival.id, first.arrival.id);
    assert.equal((await arrivalRows(ctx.visit.id)).length, 1);

    // Same key, materially different coordinates: idempotency conflict.
    await expectError(
      recordGpsHandymanVisitArrival(
        ctx.visit.id,
        { ...input, latitude: INSIDE_LATITUDE },
        ctx.leadUser.id,
      ),
      'HANDYMAN_VISIT_ARRIVAL_IDEMPOTENCY_CONFLICT',
      409,
    );

    // Same key against another visit of the same job: conflict.
    const secondVisit = await createHandymanServiceVisit(
      { handymanJobId: ctx.job.id, ...win(1, 9, 10) },
      adminUserId,
    );
    await expectError(
      recordGpsHandymanVisitArrival(
        secondVisit.visit.id,
        { ...input },
        ctx.leadUser.id,
      ),
      'HANDYMAN_VISIT_ARRIVAL_IDEMPOTENCY_CONFLICT',
      409,
    );
    assert.equal((await arrivalRows(ctx.visit.id)).length, 1);

    // A NEW key records a NEW attempt (FAILED history is never suppressed).
    const next = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput({ latitude: OUTSIDE_LATITUDE }),
      ctx.leadUser.id,
    );
    assert.equal(next.converged, false);
    assert.notEqual(next.arrival.id, first.arrival.id);
    assert.equal((await arrivalRows(ctx.visit.id)).length, 2);

    // Missing/empty key is rejected before anything is recorded.
    await expectError(
      recordGpsHandymanVisitArrival(
        ctx.visit.id,
        { ...gpsInput(), idempotencyKey: '  ' },
        ctx.leadUser.id,
      ),
      'HANDYMAN_VISIT_ARRIVAL_IDEMPOTENCY_KEY_REQUIRED',
      400,
    );

    // The SAME key under a DIFFERENT client is a different scope entirely.
    const other = await makeScheduledVisit();
    const otherResult = await recordGpsHandymanVisitArrival(
      other.visit.id,
      gpsInput({ idempotencyKey: key }),
      other.leadUser.id,
    );
    assert.equal(otherResult.converged, false);
    assert.equal(otherResult.arrival.verificationResult, 'VERIFIED');
    assert.equal((await arrivalRows(other.visit.id)).length, 1);
  });

  it('records ASSISTED arrival as a provenance-bearing override and never rewrites prior FAILED GPS history', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const reason = `Handphone petugas rusak di lokasi ${suffix()}`;

    // A FAILED GPS attempt first — history must show BOTH facts.
    const failed = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput({ latitude: OUTSIDE_LATITUDE }),
      ctx.leadUser.id,
    );
    assert.equal(failed.arrival.verificationResult, 'FAILED');

    const assistedKey = `ARR_${suffix()}`;
    const assistedOccurredAt = new Date(Date.now() - 1_800_000).toISOString();
    const assisted = await recordAssistedHandymanVisitArrival(
      ctx.visit.id,
      {
        assistedReason: reason,
        occurredAt: assistedOccurredAt,
        idempotencyKey: assistedKey,
      },
      adminUserId,
    );
    assert.equal(assisted.converged, false);
    assert.equal(assisted.arrival.verificationMethod, 'ASSISTED');
    assert.equal(assisted.arrival.verificationResult, 'VERIFIED');
    assert.equal(assisted.arrival.recordedByUserId, adminUserId);
    assert.equal(assisted.arrival.assistedReason, reason);

    const rows = await arrivalRows(ctx.visit.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, failed.arrival.id); // never rewritten
    assert.equal(rows[0].verification_result, 'FAILED');
    const assistedRow = rows[1];
    // NEVER fake GPS: no fabricated coordinates, accuracy, distance or
    // policy provenance on an ASSISTED row.
    assert.equal(assistedRow.latitude, null);
    assert.equal(assistedRow.longitude, null);
    assert.equal(assistedRow.accuracy_meters, null);
    assert.equal(assistedRow.distance_meters, null);
    assert.equal(assistedRow.building_configuration_id, null);
    assert.equal(assistedRow.configuration_version_id, null);
    assert.equal(assistedRow.assisted_reason, reason);

    // The snapshot was created from the ASSISTED VERIFIED arrival.
    assert.equal(assisted.presence.length, 2);
    const presence = await presenceRows(ctx.visit.id);
    assert.equal(presence.length, 2);
    assert.ok(
      presence.every((row) => row.handyman_visit_arrival_id === assistedRow.id),
    );

    // Same key + same facts: the replay converges onto the original row.
    const replay = await recordAssistedHandymanVisitArrival(
      ctx.visit.id,
      {
        assistedReason: reason,
        occurredAt: assistedOccurredAt,
        idempotencyKey: assistedKey,
      },
      adminUserId,
    );
    assert.equal(replay.converged, true);
    assert.equal(replay.arrival.id, assistedRow.id);
    // A NEW assisted command (new key) converges onto the VERIFIED fact.
    const fresh = await recordAssistedHandymanVisitArrival(
      ctx.visit.id,
      { assistedReason: 'Second supervisor note.', idempotencyKey: `ARR_${suffix()}` },
      adminUserId,
    );
    assert.equal(fresh.converged, true);
    assert.equal(fresh.arrival.id, assistedRow.id);

    // Missing/empty reason: rejected, nothing recorded.
    await expectError(
      recordAssistedHandymanVisitArrival(
        ctx.visit.id,
        { assistedReason: '   ', idempotencyKey: `ARR_${suffix()}` },
        adminUserId,
      ),
      'HANDYMAN_VISIT_ARRIVAL_ASSISTED_REASON_REQUIRED',
      400,
    );
    assert.equal((await arrivalRows(ctx.visit.id)).length, 2);

    // Audit carries the assisted fact WITHOUT the free-text reason.
    const events = await eventsFor(assistedRow.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'HANDYMAN_VISIT_ARRIVAL_RECORDED');
    assert.ok(events[0].summary.includes('assisted'));
    assert.equal(events[0].metadata.verificationMethod, 'ASSISTED');
    const serializedEvents = JSON.stringify(events);
    assert.ok(!serializedEvents.includes(reason), 'assisted reason in audit');
    assertNoPii(serializedEvents);
  });

  it('revalidates arrival preconditions at command time and records nothing when a guard fails', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();

    // Unknown visit.
    await expectError(
      recordGpsHandymanVisitArrival(
        randomUUID(),
        gpsInput(),
        ctx.leadUser.id,
      ),
      'HANDYMAN_SERVICE_VISIT_NOT_FOUND',
      404,
    );

    // Cancelled visit (no ACTIVE schedule window).
    await cancelHandymanServiceVisitSchedule(ctx.visit.id, adminUserId);
    await expectError(
      recordGpsHandymanVisitArrival(
        ctx.visit.id,
        gpsInput(),
        ctx.leadUser.id,
      ),
      'HANDYMAN_SERVICE_VISIT_NOT_SCHEDULABLE',
      409,
    );
    await expectError(
      recordAssistedHandymanVisitArrival(
        ctx.visit.id,
        { assistedReason: 'Site confirmed.', idempotencyKey: `ARR_${suffix()}` },
        adminUserId,
      ),
      'HANDYMAN_SERVICE_VISIT_NOT_SCHEDULABLE',
      409,
    );
    assert.equal((await arrivalRows(ctx.visit.id)).length, 0);

    // Deactivated crew breaks the crew chain — nothing recorded.
    const second = await makeScheduledVisit();
    await updateHandymanWorkCrewStatus(
      second.crew.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      recordGpsHandymanVisitArrival(
        second.visit.id,
        gpsInput(),
        second.leadUser.id,
      ),
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
      400,
    );
    assert.equal((await arrivalRows(second.visit.id)).length, 0);

    // Staff recorder without client access (the BE-05 access idiom).
    const third = await makeScheduledVisit();
    await expectError(
      recordAssistedHandymanVisitArrival(
        third.visit.id,
        { assistedReason: 'Site confirmed.', idempotencyKey: `ARR_${suffix()}` },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    assert.equal((await arrivalRows(third.visit.id)).length, 0);
  });

  it('arrives against an IN_PROGRESS work order without touching any execution state (arrival is not execution start)', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await transitionWorkOrderStatus(ctx.job.workOrderId, {
      status: 'IN_PROGRESS',
    });

    const result = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput(),
      ctx.leadUser.id,
    );
    assert.equal(result.arrival.verificationResult, 'VERIFIED');

    // Arrival neither started nor transitioned anything.
    const workOrder = await workOrderRow(ctx.job.workOrderId);
    assert.equal(workOrder.status, 'IN_PROGRESS');
    const vendorWork = await vendorWorkRow(ctx.assignment.vendorWorkId);
    assert.equal(vendorWork.status, 'NOT_STARTED');
    assert.equal(vendorWork.started_at, null);
  });

  it('authorizes the GPS field path only through the governed lead chain', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit({ helpers: 2 });

    // A plain user with no workforce profile.
    const plainUser = await userService.createUser({
      email: `plain06r1-${suffix().toLowerCase()}@example.com`,
      displayName: 'Plain User',
    });
    await expectError(
      recordGpsHandymanVisitArrival(ctx.visit.id, gpsInput(), plainUser.id),
      'HANDYMAN_VISIT_ARRIVAL_ACTOR_NOT_LEAD',
      403,
    );

    // The staff admin is NOT a lead worker — GPS field action is denied
    // (staff must use the ASSISTED override).
    await expectError(
      recordGpsHandymanVisitArrival(ctx.visit.id, gpsInput(), adminUserId),
      'HANDYMAN_VISIT_ARRIVAL_ACTOR_NOT_LEAD',
      403,
    );

    // A user linked to a HELPER profile is not the lead.
    const helperUser = await userService.createUser({
      email: `helper06r1-${suffix().toLowerCase()}@worker.example.com`,
      displayName: 'Helper User',
    });
    const helperProfile = await workforceService.createWorkforceProfile({
      organizationId: ctx.chain.organization.id,
      departmentId: ctx.chain.department.id,
      positionId: ctx.chain.position.id,
      userId: helperUser.id,
      employeeCode: `WF_${suffix()}`,
      fullName: `Zqxf HelperLinked ${suffix()}`,
      workforceType: 'EXTERNAL',
    });
    const helperBinding =
      await vendorWorkforceService.createVendorWorkforceBinding({
        vendorId: ctx.vendor.id,
        workforceProfileId: helperProfile.id,
        vendorPersonnelCode: `VPC-HLP-${suffix()}`,
      });
    await addHandymanWorkCrewMember(
      ctx.crew.id,
      {
        vendorWorkforceBindingId: helperBinding.id,
        crewRole: 'HELPER',
      },
      adminUserId,
    );
    await expectError(
      recordGpsHandymanVisitArrival(ctx.visit.id, gpsInput(), helperUser.id),
      'HANDYMAN_VISIT_ARRIVAL_ACTOR_NOT_LEAD',
      403,
    );

    // The lead of ANOTHER eligible crew (foreign composition).
    const alt = await addEligibleProvider(ctx, 'AltLead');
    await expectError(
      recordGpsHandymanVisitArrival(ctx.visit.id, gpsInput(), alt.leadUser.id),
      'HANDYMAN_VISIT_ARRIVAL_ACTOR_NOT_LEAD',
      403,
    );

    // Nothing was recorded by any rejected actor.
    assert.equal((await arrivalRows(ctx.visit.id)).length, 0);

    // The real lead succeeds — and the snapshot covers every ACTIVE member
    // of the composition at arrival time (lead + 3 helpers).
    const result = await recordGpsHandymanVisitArrival(
      ctx.visit.id,
      gpsInput(),
      ctx.leadUser.id,
    );
    assert.equal(result.arrival.verificationResult, 'VERIFIED');
    assert.equal(result.presence.length, 4);
    const roles = result.presence.map((row) => row.crewRole);
    assert.equal(roles.filter((role) => role === 'LEAD_WORKER').length, 1);
    assert.equal(roles.filter((role) => role === 'HELPER').length, 3);
  });

  it('marks presence only for snapshot members through the lead field path', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const { result } = await arriveVerified(ctx);

    // Before/without a snapshot another visit cannot be marked.
    const bare = await makeScheduledVisit();
    await expectError(
      recordHandymanVisitPresenceByLead(
        bare.visit.id,
        {
          vendorWorkforceBindingId: bare.lead.binding.id,
          presenceStatus: 'PRESENT',
        },
        bare.leadUser.id,
      ),
      'HANDYMAN_VISIT_PRESENCE_NOT_CAPTURED',
      409,
    );

    // Invalid mark value.
    await expectError(
      recordHandymanVisitPresenceByLead(
        ctx.visit.id,
        {
          vendorWorkforceBindingId: ctx.lead.binding.id,
          presenceStatus: 'MAYBE' as never,
        },
        ctx.leadUser.id,
      ),
      'HANDYMAN_VISIT_PRESENCE_STATUS_INVALID',
      400,
    );

    // The lead marks themselves PRESENT.
    const leadMark = await recordHandymanVisitPresenceByLead(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.lead.binding.id,
        presenceStatus: 'PRESENT',
      },
      ctx.leadUser.id,
    );
    assert.equal(leadMark.presenceStatus, 'PRESENT');
    assert.equal(leadMark.recordedVia, 'LEAD');
    assert.equal(leadMark.recordedByUserId, ctx.leadUser.id);
    assert.ok(leadMark.recordedAt !== null);
    assert.equal(leadMark.crewRole, 'LEAD_WORKER');
    assert.equal(leadMark.handymanVisitArrivalId, result.arrival.id);

    // The lead marks the helper ABSENT, then corrects to PRESENT
    // (last-writer-wins with full attribution).
    await recordHandymanVisitPresenceByLead(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'ABSENT',
      },
      ctx.leadUser.id,
    );
    const corrected = await recordHandymanVisitPresenceByLead(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'PRESENT',
      },
      ctx.leadUser.id,
    );
    assert.equal(corrected.presenceStatus, 'PRESENT');
    assert.equal(corrected.recordedVia, 'LEAD');

    // A non-lead actor is rejected on the lead path.
    const plainUser = await userService.createUser({
      email: `plain2-06r1-${suffix().toLowerCase()}@example.com`,
      displayName: 'Plain User Two',
    });
    await expectError(
      recordHandymanVisitPresenceByLead(
        ctx.visit.id,
        {
          vendorWorkforceBindingId: ctx.helpers[0].binding.id,
          presenceStatus: 'ABSENT',
        },
        plainUser.id,
      ),
      'HANDYMAN_VISIT_PRESENCE_ACTOR_NOT_LEAD',
      403,
    );

    // An arbitrary binding (same vendor, never on the composition) cannot
    // be inserted into the snapshot.
    const stranger = await createWorker(ctx.vendor.id, ctx.chain, 'Stranger');
    await expectError(
      recordHandymanVisitPresenceByLead(
        ctx.visit.id,
        {
          vendorWorkforceBindingId: stranger.binding.id,
          presenceStatus: 'PRESENT',
        },
        ctx.leadUser.id,
      ),
      'HANDYMAN_VISIT_PRESENCE_MEMBER_NOT_FOUND',
      404,
    );
    assert.equal((await presenceRows(ctx.visit.id)).length, 2);

    // Audit: IDs, role, status and path only.
    const events = await eventsFor(leadMark.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'HANDYMAN_VISIT_PRESENCE_RECORDED');
    assert.equal(events[0].entity_type, 'HANDYMAN_VISIT_PRESENCE');
    assert.equal(events[0].metadata.vendorWorkforceBindingId, ctx.lead.binding.id);
    assert.equal(events[0].metadata.presenceStatus, 'PRESENT');
    assert.equal(events[0].metadata.recordedVia, 'LEAD');
    assertNoPii(JSON.stringify(events));
  });

  it('supports staff-assisted presence with a mandatory reason and real attribution (never a lead impersonation)', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveVerified(ctx);
    const reason = `Helper dikonfirmasi hadir oleh BM ${suffix()}`;

    // Missing reason is rejected and changes nothing.
    await expectError(
      recordAssistedHandymanVisitPresence(
        ctx.visit.id,
        {
          vendorWorkforceBindingId: ctx.helpers[0].binding.id,
          presenceStatus: 'PRESENT',
          assistedReason: ' ',
        },
        adminUserId,
      ),
      'HANDYMAN_VISIT_PRESENCE_ASSISTED_REASON_REQUIRED',
      400,
    );

    // Outsider staff: the BE-05 access idiom rejects before any mark.
    await expectError(
      recordAssistedHandymanVisitPresence(
        ctx.visit.id,
        {
          vendorWorkforceBindingId: ctx.helpers[0].binding.id,
          presenceStatus: 'PRESENT',
          assistedReason: reason,
        },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );

    const marked = await recordAssistedHandymanVisitPresence(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'PRESENT',
        assistedReason: reason,
      },
      adminUserId,
    );
    assert.equal(marked.presenceStatus, 'PRESENT');
    assert.equal(marked.recordedVia, 'STAFF_ASSISTED');
    // The REAL recorder is attributed — the lead is never impersonated.
    assert.equal(marked.recordedByUserId, adminUserId);
    assert.notEqual(marked.recordedByUserId, ctx.leadUser.id);
    // The free-text reason stays on the record, off the read model.
    const row = (await presenceRows(ctx.visit.id)).find(
      (candidate) =>
        candidate.vendor_workforce_binding_id === ctx.helpers[0].binding.id,
    );
    assert.equal(row?.assisted_reason, reason);
    assert.ok(!JSON.stringify(marked).includes(reason));

    // Arbitrary bindings are rejected on the assisted path too.
    const stranger = await createWorker(ctx.vendor.id, ctx.chain, 'Stranger2');
    await expectError(
      recordAssistedHandymanVisitPresence(
        ctx.visit.id,
        {
          vendorWorkforceBindingId: stranger.binding.id,
          presenceStatus: 'PRESENT',
          assistedReason: reason,
        },
        adminUserId,
      ),
      'HANDYMAN_VISIT_PRESENCE_MEMBER_NOT_FOUND',
      404,
    );
    assert.equal((await presenceRows(ctx.visit.id)).length, 2);
  });

  it('freezes the snapshot against later crew composition changes', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const { result } = await arriveVerified(ctx);
    const before = await presenceRows(ctx.visit.id);

    // Reassign the job to a different eligible provider+crew (legal
    // pre-execution) — the snapshot must not move.
    const alt = await addEligibleProvider(ctx, 'NewLead');
    await reassignHandymanJobProviderAndCrew(
      ctx.job.id,
      {
        handymanProviderId: alt.provider.id,
        handymanWorkCrewId: alt.crew.id,
      },
      adminUserId,
    );
    const after = await presenceRows(ctx.visit.id);
    assert.deepEqual(
      after.map((row) => [
        row.id,
        row.vendor_workforce_binding_id,
        row.crew_role,
        row.handyman_job_assignment_id,
        row.handyman_work_crew_id,
        row.handyman_visit_arrival_id,
      ]),
      before.map((row) => [
        row.id,
        row.vendor_workforce_binding_id,
        row.crew_role,
        row.handyman_job_assignment_id,
        row.handyman_work_crew_id,
        row.handyman_visit_arrival_id,
      ]),
    );
    assert.equal(
      after[0].handyman_job_assignment_id,
      ctx.assignment.assignment.id,
    );

    // The ORIGINAL snapshot lead can still mark (the snapshot governs).
    const marked = await recordHandymanVisitPresenceByLead(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.lead.binding.id,
        presenceStatus: 'PRESENT',
      },
      ctx.leadUser.id,
    );
    assert.equal(marked.presenceStatus, 'PRESENT');

    // The NEW crew's lead resolves nowhere in this visit's snapshot.
    await expectError(
      recordHandymanVisitPresenceByLead(
        ctx.visit.id,
        {
          vendorWorkforceBindingId: ctx.lead.binding.id,
          presenceStatus: 'ABSENT',
        },
        alt.leadUser.id,
      ),
      'HANDYMAN_VISIT_PRESENCE_ACTOR_NOT_LEAD',
      403,
    );
    void result;
  });

  it('evaluates the minimum execution-start presence rule as a pure read (the Run-2 gate input)', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();

    // No arrival yet: no snapshot, gate closed.
    const bare = await evaluateHandymanVisitExecutionPresence(ctx.visit.id);
    assert.equal(bare.snapshotExists, false);
    assert.equal(bare.leadPresent, false);
    assert.equal(bare.leadVendorWorkforceBindingId, null);
    assert.deepEqual(bare.members, []);

    await arriveVerified(ctx);
    const pending = await evaluateHandymanVisitExecutionPresence(ctx.visit.id);
    assert.equal(pending.snapshotExists, true);
    assert.equal(pending.leadPresent, false); // lead still PENDING
    assert.equal(
      pending.leadVendorWorkforceBindingId,
      ctx.lead.binding.id,
    );

    // Helper states never gate: mark the helper ABSENT — still closed on
    // the lead alone; then the lead PRESENT — open regardless of helper.
    await recordHandymanVisitPresenceByLead(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'ABSENT',
      },
      ctx.leadUser.id,
    );
    const helperAbsent = await evaluateHandymanVisitExecutionPresence(
      ctx.visit.id,
    );
    assert.equal(helperAbsent.leadPresent, false);
    await recordHandymanVisitPresenceByLead(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.lead.binding.id,
        presenceStatus: 'PRESENT',
      },
      ctx.leadUser.id,
    );
    const open = await evaluateHandymanVisitExecutionPresence(ctx.visit.id);
    assert.equal(open.leadPresent, true);
    const states = Object.fromEntries(
      open.members.map((member) => [
        member.vendorWorkforceBindingId,
        member.presenceStatus,
      ]),
    );
    assert.equal(states[ctx.lead.binding.id], 'PRESENT');
    assert.equal(states[ctx.helpers[0].binding.id], 'ABSENT');

    // Pure read: the evaluation itself audits nothing.
    const before = await requirePool().query(
      'SELECT COUNT(*)::int AS count FROM operational_events',
    );
    await evaluateHandymanVisitExecutionPresence(ctx.visit.id);
    const after = await requirePool().query(
      'SELECT COUNT(*)::int AS count FROM operational_events',
    );
    assert.equal(after.rows[0].count, before.rows[0].count);
  });

  it('keeps worker/customer PII and raw location evidence out of the presence read model and table shape', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const { result } = await arriveVerified(ctx);
    const marked = await recordAssistedHandymanVisitPresence(
      ctx.visit.id,
      {
        vendorWorkforceBindingId: ctx.helpers[0].binding.id,
        presenceStatus: 'PRESENT',
        assistedReason: `Dikonfirmasi teknisi gedung ${suffix()}`,
      },
      adminUserId,
    );

    // Structural canary: the presence table has EXACTLY the governed
    // columns — no name/contact/profile/user columns for workers.
    const columns = await requirePool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'handyman_visit_presence'
       ORDER BY column_name ASC`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'assisted_reason',
        'client_id',
        'created_at',
        'crew_role',
        'handyman_job_assignment_id',
        'handyman_service_visit_id',
        'handyman_visit_arrival_id',
        'handyman_work_crew_id',
        'id',
        'presence_status',
        'recorded_at',
        'recorded_by_user_id',
        'recorded_via',
        'updated_at',
        'vendor_workforce_binding_id',
      ],
    );

    // Read-model canaries across every public surface produced.
    const serialized = JSON.stringify([result, marked]);
    assertNoPii(serialized);
    assertNoRawLocation(serialized);
    assert.ok(!serialized.includes('12.5'), 'accuracy leaked');
  });

  it('enforces the structural backstops: one snapshot member per binding, one lead row per visit, and the ASSISTED no-fake-GPS shape', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    const { result } = await arriveVerified(ctx);
    const snapshot = await presenceRows(ctx.visit.id);
    const leadRow = snapshot.find((row) => row.crew_role === 'LEAD_WORKER')!;

    // Duplicate (visit, binding) snapshot member.
    await expectPgConstraint(
      requirePool().query(
        `INSERT INTO handyman_visit_presence
           (id, client_id, handyman_service_visit_id, handyman_visit_arrival_id,
            handyman_job_assignment_id, handyman_work_crew_id,
            vendor_workforce_binding_id, crew_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'HELPER')`,
        [
          randomUUID(),
          ctx.h.client.id,
          ctx.visit.id,
          result.arrival.id,
          ctx.assignment.assignment.id,
          ctx.crew.id,
          leadRow.vendor_workforce_binding_id,
        ],
      ),
      '23505',
      'handyman_visit_presence_visit_binding_unique',
    );

    // A second LEAD_WORKER row on the same visit — through a binding NOT
    // already in the snapshot, so the one-lead partial index (not the
    // visit+binding unique) is the constraint under test.
    const stranger = await createWorker(ctx.vendor.id, ctx.chain, 'Stranger3');
    await expectPgConstraint(
      requirePool().query(
        `INSERT INTO handyman_visit_presence
           (id, client_id, handyman_service_visit_id, handyman_visit_arrival_id,
            handyman_job_assignment_id, handyman_work_crew_id,
            vendor_workforce_binding_id, crew_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'LEAD_WORKER')`,
        [
          randomUUID(),
          ctx.h.client.id,
          ctx.visit.id,
          result.arrival.id,
          ctx.assignment.assignment.id,
          ctx.crew.id,
          stranger.binding.id,
        ],
      ),
      '23505',
      'handyman_visit_presence_one_lead_per_visit',
    );

    // ASSISTED with fabricated coordinates: rejected by the shape CHECK.
    await expectPgConstraint(
      requirePool().query(
        `INSERT INTO handyman_visit_arrivals
           (id, client_id, handyman_service_visit_id, verification_method,
            verification_result, received_at, latitude, longitude,
            assisted_reason, recorded_by_user_id, idempotency_key,
            idempotency_fingerprint)
         VALUES ($1, $2, $3, 'ASSISTED', 'VERIFIED', NOW(), $4, $5,
                 'fabricated', $6, $7, 'fp')`,
        [
          randomUUID(),
          ctx.h.client.id,
          ctx.visit.id,
          INSIDE_LATITUDE,
          POLICY_LONGITUDE,
          adminUserId,
          `RAW2_${suffix()}`,
        ],
      ),
      '23514',
      'handyman_visit_arrivals_assisted_shape_check',
    );

    // A FAILED row without an owned reason: rejected.
    await expectPgConstraint(
      requirePool().query(
        `INSERT INTO handyman_visit_arrivals
           (id, client_id, handyman_service_visit_id, verification_method,
            verification_result, received_at, recorded_by_user_id,
            idempotency_key, idempotency_fingerprint)
         VALUES ($1, $2, $3, 'GPS', 'FAILED', NOW(), $4, $5, 'fp')`,
        [
          randomUUID(),
          ctx.h.client.id,
          ctx.visit.id,
          adminUserId,
          `RAW3_${suffix()}`,
        ],
      ),
      '23514',
      'handyman_visit_arrivals_failed_reason_required_check',
    );
    assert.equal((await presenceRows(ctx.visit.id)).length, 2);
    assert.equal((await arrivalRows(ctx.visit.id)).length, 1);
  });
});
