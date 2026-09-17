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
import { createAdminUser } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-06 RUN 2 — focused service-level suite for the work session +
 * guarded execution start authority (§16):
 * start preconditions, field authority (lead only), session facts (one
 * OPEN, server time, frozen snapshot, structural canaries), guarded seam
 * convergence (vendor work before work order; replay Cases A/B/C/D),
 * idempotency + concurrency, races (cancel/reschedule/reassignment/
 * presence mutation), replay-safe end with the §13 dual authorization
 * rule, the Run-3 read model, and the privacy/financial boundary.
 *
 * Fixtures consume the governed chain end to end (the BE-05/Run-1 idiom):
 * APPROVED request → job → assigned composition → scheduled visit →
 * VERIFIED GPS arrival → frozen presence snapshot → lead PRESENT, before
 * any session start is attempted.
 */

const PORT = 55510;
const DIR = '/tmp/asentra-hm06-run2-pg';
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
    email: `outsider06r2-${suffix().toLowerCase()}@example.com`,
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
    email: `pic06r2-${suffix().toLowerCase()}@tenant.example.com`,
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
      email: `pic06r2-contact-${suffix().toLowerCase()}@tenant.example.com`,
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
    email: `lead06r2-${suffix().toLowerCase()}@worker.example.com`,
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
    email: `${role.toLowerCase()}06r2-${suffix().toLowerCase()}@worker.example.com`,
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

describe('CR-HM-BE-06 RUN 2: work session + guarded execution start', () => {
  it('opens the session for the verified present lead and advances vendor work then the work order through their owning services', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const before = Date.now();
    const input = startInput();
    const result = await startHandymanWorkSession(
      ctx.visit.id,
      input,
      ctx.leadUser.id,
    );

    assert.equal(result.converged, false);
    assert.equal(result.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(result.execution.workOrderStatus, 'IN_PROGRESS');
    const s = result.session;
    assert.equal(s.status, 'OPEN');
    assert.equal(s.visitId, ctx.visit.id);
    assert.equal(s.clientId, ctx.h.client.id);
    assert.equal(s.vendorWorkId, vendorWorkId);
    assert.equal(
      s.handymanJobAssignmentId,
      ctx.assignment.assignment.id,
    );
    assert.equal(s.startedByUserId, ctx.leadUser.id);
    assert.equal(s.endedAt, null);
    assert.equal(s.endedByUserId, null);
    // Client-claimed occurredAt retained as evidence; startedAt is server
    // time (>= test start) — the claim is never lifecycle authority.
    assert.equal(s.occurredAt, input.occurredAt);
    assert.ok(new Date(s.startedAt).getTime() >= before);
    assert.ok(
      new Date(s.occurredAt!).getTime() < new Date(s.startedAt).getTime(),
    );

    const rows = await sessionRows(ctx.visit.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'OPEN');
    assert.equal(rows[0].ended_at, null);
    assert.equal(rows[0].ended_by_user_id, null);
    assert.equal(rows[0].idempotency_key, input.idempotencyKey);

    // Lifecycle: vendor work advanced (BE-15B stamped started_at), then the
    // work order — the work order is never ahead of its vendor work.
    const vw = await vendorWorkRow(vendorWorkId);
    assert.equal(vw.status, 'IN_PROGRESS');
    assert.ok(vw.started_at !== null);
    const wo = await workOrderRow(ctx.job.workOrderId);
    assert.equal(wo.status, 'IN_PROGRESS');

    // Events: exactly one session-start audit + one owning lifecycle event
    // per side — no duplicated vendor/WO lifecycle events from Handyman.
    const sessionEvents = await eventsFor(s.id);
    assert.equal(sessionEvents.length, 1);
    assert.equal(
      sessionEvents[0].event_type,
      'HANDYMAN_WORK_SESSION_STARTED',
    );
    assert.equal(sessionEvents[0].entity_type, 'HANDYMAN_WORK_SESSION');
    assert.equal(sessionEvents[0].building_id, ctx.h.building.id);
    assert.equal(sessionEvents[0].actor_user_id, ctx.leadUser.id);
    const md = sessionEvents[0].metadata;
    assert.equal(md.handymanServiceVisitId, ctx.visit.id);
    assert.equal(md.vendorWorkId, vendorWorkId);
    assert.equal(
      md.handymanJobAssignmentId,
      ctx.assignment.assignment.id,
    );
    assert.equal(md.status, 'OPEN');
    const vwEvents = (await eventsFor(vendorWorkId)).filter(
      (event) => event.event_type === 'VENDOR_WORK_STATUS_CHANGED',
    );
    assert.equal(vwEvents.length, 1);
    // The work order carries TWO owned status events: OPEN->ASSIGNED from
    // the BE-05 job-creation seam and ASSIGNED->IN_PROGRESS from the start
    // seam. Exactly one of each — no Handyman-duplicated lifecycle events.
    const woStatusEvents = (await eventsFor(ctx.job.workOrderId)).filter(
      (event) => event.event_type === 'WORK_ORDER_STATUS_CHANGED',
    );
    assert.equal(woStatusEvents.length, 2);
    const woStartEvent = woStatusEvents.filter(
      (event) => (event.metadata as { to?: string }).to === 'IN_PROGRESS',
    );
    assert.equal(woStartEvent.length, 1);
    assert.deepEqual(woStartEvent[0].metadata, {
      from: 'ASSIGNED',
      to: 'IN_PROGRESS',
    });

    // Privacy: the session audit + public session carry ids/status/time
    // only — no PII, no raw GPS.
    assertNoPii(JSON.stringify(sessionEvents));
    assertNoRawLocation(JSON.stringify(sessionEvents));
    assertNoPii(JSON.stringify(s));
    assertNoRawLocation(JSON.stringify(s));
  });

  it('refuses to start without the verified arrival, the present frozen lead, or the ACTIVE schedule — recording nothing', async (t) => {
    if (!ready(t)) return;
    // (a) No arrival at all.
    const bare = await makeScheduledVisit();
    const bareVendorWorkId = await resolveVendorWorkId(bare.job.id);
    await expectError(
      startHandymanWorkSession(bare.visit.id, startInput(), bare.leadUser.id),
      'HANDYMAN_WORK_SESSION_ARRIVAL_REQUIRED',
      409,
    );
    assert.equal((await sessionRows(bare.visit.id)).length, 0);
    assert.equal(
      (await vendorWorkRow(bareVendorWorkId)).status,
      'NOT_STARTED',
    );
    assert.equal(
      (await workOrderRow(bare.job.workOrderId)).status,
      'ASSIGNED',
    );

    // (b) VERIFIED arrival but the frozen lead is still PENDING.
    await recordGpsHandymanVisitArrival(
      bare.visit.id,
      gpsInput(),
      bare.leadUser.id,
    );
    await expectError(
      startHandymanWorkSession(bare.visit.id, startInput(), bare.leadUser.id),
      'HANDYMAN_WORK_SESSION_LEAD_NOT_PRESENT',
      409,
    );

    // (c) Presence mutated to ABSENT (the start-vs-presence race lands
    // here: the visit-row lock serializes marks against the start tx).
    await recordHandymanVisitPresenceByLead(
      bare.visit.id,
      {
        vendorWorkforceBindingId: bare.lead.binding.id,
        presenceStatus: 'ABSENT',
      },
      bare.leadUser.id,
    );
    await expectError(
      startHandymanWorkSession(bare.visit.id, startInput(), bare.leadUser.id),
      'HANDYMAN_WORK_SESSION_LEAD_NOT_PRESENT',
      409,
    );
    assert.equal((await sessionRows(bare.visit.id)).length, 0);
    assert.equal(
      (await vendorWorkRow(bareVendorWorkId)).status,
      'NOT_STARTED',
    );

    // (d) The ACTIVE schedule was cancelled.
    const cancelled = await makeScheduledVisit();
    await arriveAndPresent(cancelled);
    await cancelHandymanServiceVisitSchedule(
      cancelled.visit.id,
      adminUserId,
    );
    await expectError(
      startHandymanWorkSession(
        cancelled.visit.id,
        startInput(),
        cancelled.leadUser.id,
      ),
      'HANDYMAN_SERVICE_VISIT_NOT_SCHEDULABLE',
      409,
    );
    assert.equal((await sessionRows(cancelled.visit.id)).length, 0);

    // (e) A rescheduled visit still starts under the NEW ACTIVE window.
    const rescheduled = await makeScheduledVisit();
    await arriveAndPresent(rescheduled);
    await rescheduleHandymanServiceVisit(
      rescheduled.visit.id,
      win(1, 9, 10),
      adminUserId,
    );
    const result = await startHandymanWorkSession(
      rescheduled.visit.id,
      startInput(),
      rescheduled.leadUser.id,
    );
    assert.equal(result.converged, false);
    assert.equal(result.session.status, 'OPEN');
    assert.equal(result.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(result.execution.workOrderStatus, 'IN_PROGRESS');
  });

  it('authorizes only the governing lead: helpers, foreign leads, staff and outsiders are 403 with nothing recorded', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);

    // Seated HELPER with an authenticated user — helpers are informational,
    // never start authority.
    const helperUser = await userService.createUser({
      email: `helper06r2-${suffix().toLowerCase()}@worker.example.com`,
      displayName: 'Helper User',
    });
    const helperWorker = await createWorker(
      ctx.vendor.id,
      ctx.chain,
      'HelperAuth',
      helperUser.id,
    );
    await addHandymanWorkCrewMember(
      ctx.crew.id,
      {
        vendorWorkforceBindingId: helperWorker.binding.id,
        crewRole: 'HELPER',
      },
      adminUserId,
    );
    await expectError(
      startHandymanWorkSession(ctx.visit.id, startInput(), helperUser.id),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );

    // Foreign provider's LEAD — valid chain, wrong crew.
    const alt = await addEligibleProvider(ctx, 'AltA');
    await expectError(
      startHandymanWorkSession(ctx.visit.id, startInput(), alt.leadUser.id),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );

    // Staff admin — no assisted-staff start path exists (none invented).
    await expectError(
      startHandymanWorkSession(ctx.visit.id, startInput(), adminUserId),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );
    // Outsider.
    await expectError(
      startHandymanWorkSession(ctx.visit.id, startInput(), outsiderUserId),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );

    assert.equal((await sessionRows(ctx.visit.id)).length, 0);
    assert.equal((await vendorWorkRow(vendorWorkId)).status, 'NOT_STARTED');
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'ASSIGNED',
    );
  });

  it('consumes the BE-05 readiness authority: a NOT_READY permit blocks the start with the failed check named', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    await createWorkPermitReadiness(
      {
        vendorWorkId,
        permitRequirementType: 'SITE_WORK_PERMIT',
        permitStatus: 'PENDING',
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    let message = '';
    try {
      await startHandymanWorkSession(
        ctx.visit.id,
        startInput(),
        ctx.leadUser.id,
      );
      assert.fail('expected HANDYMAN_WORK_SESSION_EXECUTION_NOT_READY');
    } catch (error) {
      const appError = error as {
        code?: string;
        statusCode?: number;
        message?: string;
      };
      assert.equal(
        appError.code,
        'HANDYMAN_WORK_SESSION_EXECUTION_NOT_READY',
      );
      assert.equal(appError.statusCode, 409);
      message = appError.message ?? '';
    }
    // The failure names readiness CHECKS only — booleans, never PII.
    assert.ok(message.includes('permitsReady'), message);
    assertNoPii(message);
    assert.equal((await sessionRows(ctx.visit.id)).length, 0);
    assert.equal((await vendorWorkRow(vendorWorkId)).status, 'NOT_STARTED');
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'ASSIGNED',
    );
  });

  it('holds the structural invariants: exact fact columns, one OPEN per visit, closure integrity and frozen start facts', async (t) => {
    if (!ready(t)) return;
    const columns = await requirePool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'handyman_work_sessions'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'id',
        'client_id',
        'visit_id',
        'vendor_work_id',
        'handyman_job_assignment_id',
        'status',
        'started_at',
        'started_by_user_id',
        'ended_at',
        'ended_by_user_id',
        'occurred_at',
        'idempotency_key',
        'idempotency_fingerprint',
        'created_at',
        'updated_at',
      ],
    );

    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const started = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    const sessionId = started.session.id;

    // A second OPEN session for the same visit is structurally impossible.
    await expectPgConstraint(
      insertOpenSessionSql(ctx),
      '23505',
      'handyman_work_sessions_visit_one_open_unique',
    );

    // OPEN rows must not carry closure facts.
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions
         SET ended_at = NOW(), ended_by_user_id = started_by_user_id
         WHERE id = $1`,
        [sessionId],
      ),
    );
    // CLOSED requires attribution and ended_at > started_at.
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions SET status = 'CLOSED' WHERE id = $1`,
        [sessionId],
      ),
    );
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions
         SET status = 'CLOSED', ended_at = started_at,
             ended_by_user_id = started_by_user_id
         WHERE id = $1`,
        [sessionId],
      ),
    );
    // Start facts are frozen (server time, evidence claim, key).
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions
         SET started_at = started_at + interval '1 hour' WHERE id = $1`,
        [sessionId],
      ),
    );
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions
         SET occurred_at = NOW() WHERE id = $1`,
        [sessionId],
      ),
    );
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions
         SET idempotency_key = idempotency_key || 'x' WHERE id = $1`,
        [sessionId],
      ),
    );

    // CLOSED history is immutable — no reopen, no re-attribution, no delete
    // surface anywhere in the module.
    const ended = await endHandymanWorkSession(sessionId, ctx.leadUser.id);
    assert.equal(ended.session.status, 'CLOSED');
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions SET ended_at = NOW() WHERE id = $1`,
        [sessionId],
      ),
    );
    await expectIntegrityRaise(
      requirePool().query(
        `UPDATE handyman_work_sessions
         SET status = 'OPEN', ended_at = NULL, ended_by_user_id = NULL
         WHERE id = $1`,
        [sessionId],
      ),
    );
  });

  it('supports sequential sessions: CLOSED history retained and a later legal start opens a NEW session with the seam converged', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const first = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    await endHandymanWorkSession(first.session.id, ctx.leadUser.id);

    // The end auto-completed NOTHING: execution stays exactly where the
    // start seam legitimately brought it.
    assert.equal(
      (await vendorWorkRow(vendorWorkId)).status,
      'IN_PROGRESS',
    );
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'IN_PROGRESS',
    );

    const second = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    assert.equal(second.converged, false);
    assert.notEqual(second.session.id, first.session.id);
    assert.equal(second.session.vendorWorkId, vendorWorkId);
    assert.equal(
      second.session.handymanJobAssignmentId,
      ctx.assignment.assignment.id,
    );

    const rows = await sessionRows(ctx.visit.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'CLOSED');
    assert.equal(rows[1].status, 'OPEN');

    // Seam no-op on the second start: still exactly one owning lifecycle
    // event per side.
    const vwEvents = (await eventsFor(vendorWorkId)).filter(
      (event) => event.event_type === 'VENDOR_WORK_STATUS_CHANGED',
    );
    assert.equal(vwEvents.length, 1);
    const woEvents = (await eventsFor(ctx.job.workOrderId)).filter(
      (event) =>
        event.event_type === 'WORK_ORDER_STATUS_CHANGED' &&
        (event.metadata as { to?: string }).to === 'IN_PROGRESS',
    );
    assert.equal(woEvents.length, 1);
  });

  it('replays the same key onto the recorded fact, rejects different facts and never opens a second OPEN session', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const input = startInput();
    const first = await startHandymanWorkSession(
      ctx.visit.id,
      input,
      ctx.leadUser.id,
    );

    // Same key + same facts → converged onto the recorded session, seam
    // stays converged, no duplicate session/lifecycle events.
    const replay = await startHandymanWorkSession(
      ctx.visit.id,
      { ...input },
      ctx.leadUser.id,
    );
    assert.equal(replay.converged, true);
    assert.equal(replay.session.id, first.session.id);
    assert.equal(replay.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(replay.execution.workOrderStatus, 'IN_PROGRESS');
    assert.equal((await sessionRows(ctx.visit.id)).length, 1);
    assert.equal((await eventsFor(first.session.id)).length, 1);
    assert.equal(
      (await eventsFor(vendorWorkId)).filter(
        (event) => event.event_type === 'VENDOR_WORK_STATUS_CHANGED',
      ).length,
      1,
    );

    // Same key + materially different facts → 409.
    await expectError(
      startHandymanWorkSession(
        ctx.visit.id,
        {
          idempotencyKey: input.idempotencyKey,
          occurredAt: new Date().toISOString(),
        },
        ctx.leadUser.id,
      ),
      'HANDYMAN_WORK_SESSION_IDEMPOTENCY_CONFLICT',
      409,
    );

    // Different key while an OPEN session exists → converge onto it; NEVER
    // a second OPEN.
    const other = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    assert.equal(other.converged, true);
    assert.equal(other.session.id, first.session.id);
    assert.equal((await sessionRows(ctx.visit.id)).length, 1);

    // Input discipline.
    await expectError(
      startHandymanWorkSession(
        ctx.visit.id,
        { idempotencyKey: '   ' },
        ctx.leadUser.id,
      ),
      'HANDYMAN_WORK_SESSION_IDEMPOTENCY_KEY_REQUIRED',
      400,
    );
    await expectError(
      startHandymanWorkSession(
        ctx.visit.id,
        { idempotencyKey: `WSS_${suffix()}`, occurredAt: 'not-a-date' },
        ctx.leadUser.id,
      ),
      'HANDYMAN_WORK_SESSION_EVIDENCE_INVALID',
      400,
    );
  });

  it('serializes concurrent duplicate starts into ONE session (same key and different keys)', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const input = startInput();
    const [a, b] = await Promise.all([
      startHandymanWorkSession(ctx.visit.id, { ...input }, ctx.leadUser.id),
      startHandymanWorkSession(ctx.visit.id, { ...input }, ctx.leadUser.id),
    ]);
    assert.equal(a.session.id, b.session.id);
    assert.equal(
      [a.converged, b.converged].filter((converged) => !converged).length,
      1,
    );
    assert.equal((await sessionRows(ctx.visit.id)).length, 1);
    assert.equal((await eventsFor(a.session.id)).length, 1);
    assert.equal(a.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(b.execution.workOrderStatus, 'IN_PROGRESS');

    // Different keys concurrently → still exactly ONE OPEN session.
    const ctx2 = await makeScheduledVisit();
    await arriveAndPresent(ctx2);
    const [c, d] = await Promise.all([
      startHandymanWorkSession(ctx2.visit.id, startInput(), ctx2.leadUser.id),
      startHandymanWorkSession(ctx2.visit.id, startInput(), ctx2.leadUser.id),
    ]);
    assert.equal(c.session.id, d.session.id);
    assert.equal(
      [c.converged, d.converged].filter((converged) => !converged).length,
      1,
    );
    assert.equal((await sessionRows(ctx2.visit.id)).length, 1);
  });

  it('Case A: replaying against an OPEN session with vendor work NOT_STARTED advances vendor work then the work order', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const sqlSessionId = await insertOpenSessionSql(ctx);

    const result = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    assert.equal(result.converged, true);
    assert.equal(result.session.id, sqlSessionId);
    assert.equal(result.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(result.execution.workOrderStatus, 'IN_PROGRESS');
    assert.equal((await sessionRows(ctx.visit.id)).length, 1);
    // The converging command fabricates no session audit of its own; the
    // owners' lifecycle events fire exactly once.
    assert.equal((await eventsFor(sqlSessionId)).length, 0);
    assert.equal(
      (await eventsFor(vendorWorkId)).filter(
        (event) => event.event_type === 'VENDOR_WORK_STATUS_CHANGED',
      ).length,
      1,
    );
    assert.equal(
      (await eventsFor(ctx.job.workOrderId)).filter(
        (event) =>
          event.event_type === 'WORK_ORDER_STATUS_CHANGED' &&
          (event.metadata as { to?: string }).to === 'IN_PROGRESS',
      ).length,
      1,
    );
  });

  it('Case B: vendor work IN_PROGRESS over work order ASSIGNED advances only the work order', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    await transitionVendorWorkStatus(vendorWorkId, { status: 'IN_PROGRESS' });

    const result = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    assert.equal(result.converged, false);
    assert.equal(result.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(result.execution.workOrderStatus, 'IN_PROGRESS');
    // Only the manual vendor transition exists; the seam added exactly the
    // work-order transition.
    assert.equal(
      (await eventsFor(vendorWorkId)).filter(
        (event) => event.event_type === 'VENDOR_WORK_STATUS_CHANGED',
      ).length,
      1,
    );
    const woEvents = (await eventsFor(ctx.job.workOrderId)).filter(
      (event) =>
        event.event_type === 'WORK_ORDER_STATUS_CHANGED' &&
        (event.metadata as { to?: string }).to === 'IN_PROGRESS',
    );
    assert.equal(woEvents.length, 1);
    assert.deepEqual(woEvents[0].metadata, {
      from: 'ASSIGNED',
      to: 'IN_PROGRESS',
    });
  });

  it('Case C: both sides already IN_PROGRESS converges with no additional lifecycle events', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    await transitionVendorWorkStatus(vendorWorkId, { status: 'IN_PROGRESS' });
    await transitionWorkOrderStatus(ctx.job.workOrderId, {
      status: 'IN_PROGRESS',
    });
    const vwEventsBefore = (await eventsFor(vendorWorkId)).length;
    const woEventsBefore = (await eventsFor(ctx.job.workOrderId)).length;

    const result = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    assert.equal(result.converged, false);
    assert.equal(result.session.status, 'OPEN');
    assert.equal(result.execution.vendorWorkStatus, 'IN_PROGRESS');
    assert.equal(result.execution.workOrderStatus, 'IN_PROGRESS');
    // Seam no-op: the owning lifecycle event counts are unchanged.
    assert.equal((await eventsFor(vendorWorkId)).length, vwEventsBefore);
    assert.equal((await eventsFor(ctx.job.workOrderId)).length, woEventsBefore);
  });

  it('Case D: work order IN_PROGRESS over vendor work NOT_STARTED fails with the owned inconsistency error and never normalizes', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    await transitionWorkOrderStatus(ctx.job.workOrderId, {
      status: 'IN_PROGRESS',
    });

    // Fresh start against the split-brain state: explicit owned failure.
    await expectError(
      startHandymanWorkSession(ctx.visit.id, startInput(), ctx.leadUser.id),
      'HANDYMAN_WORK_SESSION_EXECUTION_STATE_INCONSISTENT',
      409,
    );
    assert.equal((await sessionRows(ctx.visit.id)).length, 0);
    // Never silently normalized in either direction.
    assert.equal((await vendorWorkRow(vendorWorkId)).status, 'NOT_STARTED');
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'IN_PROGRESS',
    );

    // Converging replay over the same split-brain also refuses (and adds no
    // second session).
    const ctx2 = await makeScheduledVisit();
    await arriveAndPresent(ctx2);
    await insertOpenSessionSql(ctx2);
    await transitionWorkOrderStatus(ctx2.job.workOrderId, {
      status: 'IN_PROGRESS',
    });
    await expectError(
      startHandymanWorkSession(ctx2.visit.id, startInput(), ctx2.leadUser.id),
      'HANDYMAN_WORK_SESSION_EXECUTION_STATE_INCONSISTENT',
      409,
    );
    assert.equal((await sessionRows(ctx2.visit.id)).length, 1);
  });

  it('reassignment before start: the frozen lead fact stands, the OLD lead loses authority and the NEW composition is snapshotted', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const oldVendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const alt = await addEligibleProvider(ctx, 'AltB');
    const reassigned = await reassignHandymanJobProviderAndCrew(
      ctx.job.id,
      {
        handymanProviderId: alt.provider.id,
        handymanWorkCrewId: alt.crew.id,
      },
      adminUserId,
    );

    // The old crew's lead no longer holds current-crew start authority.
    await expectError(
      startHandymanWorkSession(ctx.visit.id, startInput(), ctx.leadUser.id),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );

    // The new crew's lead starts: the frozen arrival/presence facts are
    // consumed as-is (never rebuilt), current chain revalidated.
    const result = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      alt.leadUser.id,
    );
    assert.equal(result.converged, false);
    assert.equal(
      result.session.handymanJobAssignmentId,
      reassigned.assignment.id,
    );
    const newVendorWorkId = await resolveVendorWorkId(ctx.job.id);
    assert.notEqual(newVendorWorkId, oldVendorWorkId);
    assert.equal(result.session.vendorWorkId, newVendorWorkId);
    // Historical authority: the superseded vendor work is untouched.
    assert.equal(
      (await vendorWorkRow(oldVendorWorkId)).status,
      'NOT_STARTED',
    );
    assert.equal(
      (await vendorWorkRow(newVendorWorkId)).status,
      'IN_PROGRESS',
    );
    assert.equal(result.execution.workOrderStatus, 'IN_PROGRESS');
  });

  it('closes the session with server time and the real actor, replay-safe, completing nothing downstream', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const started = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );

    const beforeEnd = Date.now();
    const ended = await endHandymanWorkSession(
      started.session.id,
      ctx.leadUser.id,
    );
    assert.equal(ended.converged, false);
    assert.equal(ended.session.status, 'CLOSED');
    assert.equal(ended.session.endedByUserId, ctx.leadUser.id);
    assert.ok(ended.session.endedAt !== null);
    assert.ok(new Date(ended.session.endedAt!).getTime() >= beforeEnd);
    assert.ok(
      new Date(ended.session.endedAt!).getTime() >
        new Date(ended.session.startedAt).getTime(),
    );

    // Replay-safe: the recorded closure converges with attribution intact.
    const replay = await endHandymanWorkSession(
      started.session.id,
      ctx.leadUser.id,
    );
    assert.equal(replay.converged, true);
    assert.equal(replay.session.endedAt, ended.session.endedAt);
    assert.equal(replay.session.endedByUserId, ctx.leadUser.id);

    // Nothing downstream auto-completed: vendor work, work order, QC, BAST,
    // invoices, payroll and settlements are untouched by the end.
    assert.equal(
      (await vendorWorkRow(vendorWorkId)).status,
      'IN_PROGRESS',
    );
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'IN_PROGRESS',
    );
    assert.equal(
      (await eventsFor(vendorWorkId)).filter(
        (event) => event.event_type === 'VENDOR_WORK_STATUS_CHANGED',
      ).length,
      1,
    );
    assert.equal(
      (await eventsFor(ctx.job.workOrderId)).filter(
        (event) =>
          event.event_type === 'WORK_ORDER_STATUS_CHANGED' &&
          (event.metadata as { to?: string }).to === 'IN_PROGRESS',
      ).length,
      1,
    );

    // Exactly one END audit: ids/status/time only, real actor recorded.
    const events = await eventsFor(started.session.id);
    assert.equal(events.length, 2);
    assert.equal(events[1].event_type, 'HANDYMAN_WORK_SESSION_ENDED');
    assert.equal(events[1].entity_type, 'HANDYMAN_WORK_SESSION');
    assert.equal(events[1].actor_user_id, ctx.leadUser.id);
    assert.equal(events[1].metadata.status, 'CLOSED');
    assert.equal(events[1].metadata.vendorWorkId, vendorWorkId);
    assertNoPii(JSON.stringify(events));
    assertNoRawLocation(JSON.stringify(events));

    // History retained.
    assert.equal((await sessionRows(ctx.visit.id)).length, 1);
  });

  it('§13 dual end authority: start-context lead OR current-composition lead; helpers, foreign actors and staff are refused', async (t) => {
    if (!ready(t)) return;
    // Scenario 1 — reassignment between open and close: the START-CONTEXT
    // lead closes (Case A world: the seam never ran, WO still ASSIGNED, so
    // the pre-execution reassignment is legal).
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const originalVendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const sqlSessionId = await insertOpenSessionSql(ctx);
    const altC = await addEligibleProvider(ctx, 'AltC');
    const altD = await addEligibleProvider(ctx, 'AltD');
    await reassignHandymanJobProviderAndCrew(
      ctx.job.id,
      {
        handymanProviderId: altC.provider.id,
        handymanWorkCrewId: altC.crew.id,
      },
      adminUserId,
    );
    // A never-involved foreign lead is refused.
    await expectError(
      endHandymanWorkSession(sqlSessionId, altD.leadUser.id),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );
    // No staff close path was invented.
    await expectError(
      endHandymanWorkSession(sqlSessionId, adminUserId),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );
    await expectError(
      endHandymanWorkSession(sqlSessionId, outsiderUserId),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );
    // The start-context crew's lead closes.
    const closedA = await endHandymanWorkSession(
      sqlSessionId,
      ctx.leadUser.id,
    );
    assert.equal(closedA.session.status, 'CLOSED');
    assert.equal(closedA.session.endedByUserId, ctx.leadUser.id);
    // Historical authority: the session kept its ORIGINAL snapshot through
    // the reassignment, and the closure audit carries those same ids.
    assert.equal(closedA.session.vendorWorkId, originalVendorWorkId);
    assert.equal(
      closedA.session.handymanJobAssignmentId,
      ctx.assignment.assignment.id,
    );
    const endEvents = (await eventsFor(sqlSessionId)).filter(
      (event) => event.event_type === 'HANDYMAN_WORK_SESSION_ENDED',
    );
    assert.equal(endEvents.length, 1);
    assert.equal(endEvents[0].metadata.vendorWorkId, originalVendorWorkId);
    assert.equal(
      endEvents[0].metadata.handymanJobAssignmentId,
      ctx.assignment.assignment.id,
    );

    // Scenario 2 — the CURRENT composition crew's lead closes an open
    // window that predates the reassignment.
    const ctx2 = await makeScheduledVisit();
    await arriveAndPresent(ctx2);
    const sql2 = await insertOpenSessionSql(ctx2);
    const altE = await addEligibleProvider(ctx2, 'AltE');
    await reassignHandymanJobProviderAndCrew(
      ctx2.job.id,
      {
        handymanProviderId: altE.provider.id,
        handymanWorkCrewId: altE.crew.id,
      },
      adminUserId,
    );
    const closedB = await endHandymanWorkSession(sql2, altE.leadUser.id);
    assert.equal(closedB.session.status, 'CLOSED');
    assert.equal(closedB.session.endedByUserId, altE.leadUser.id);

    // Scenario 3 — a seated helper of the very same crew can never close.
    const ctx3 = await makeScheduledVisit();
    await arriveAndPresent(ctx3);
    const started3 = await startHandymanWorkSession(
      ctx3.visit.id,
      startInput(),
      ctx3.leadUser.id,
    );
    const helperUser = await userService.createUser({
      email: `helperend06r2-${suffix().toLowerCase()}@worker.example.com`,
      displayName: 'Helper End User',
    });
    const helperWorker = await createWorker(
      ctx3.vendor.id,
      ctx3.chain,
      'HelperEnd',
      helperUser.id,
    );
    await addHandymanWorkCrewMember(
      ctx3.crew.id,
      {
        vendorWorkforceBindingId: helperWorker.binding.id,
        crewRole: 'HELPER',
      },
      adminUserId,
    );
    await expectError(
      endHandymanWorkSession(started3.session.id, helperUser.id),
      'HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD',
      403,
    );
    const rows3 = await sessionRows(ctx3.visit.id);
    assert.equal(rows3[0].status, 'OPEN');
    assert.equal(rows3[0].ended_by_user_id, null);

    // Unknown session.
    await expectError(
      endHandymanWorkSession(randomUUID(), ctx3.leadUser.id),
      'HANDYMAN_WORK_SESSION_NOT_FOUND',
      404,
    );
  });

  it('read model: staff client scope or governing field actors only; ids/status/timestamps; oldest-first history', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const first = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    await endHandymanWorkSession(first.session.id, ctx.leadUser.id);
    const second = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );

    // Staff (client scope) sees the full oldest-first history.
    const staffList = await listHandymanWorkSessionsByVisit(
      ctx.visit.id,
      adminUserId,
    );
    assert.equal(staffList.length, 2);
    assert.equal(staffList[0].id, first.session.id);
    assert.equal(staffList[0].status, 'CLOSED');
    assert.equal(staffList[1].id, second.session.id);
    assert.equal(staffList[1].status, 'OPEN');
    const one = await getHandymanWorkSessionById(
      first.session.id,
      adminUserId,
    );
    assert.equal(one.id, first.session.id);
    assert.equal(one.vendorWorkId, first.session.vendorWorkId);
    assert.equal(one.startedByUserId, ctx.leadUser.id);

    // The field actor that started the sessions reads them.
    const leadList = await listHandymanWorkSessionsByVisit(
      ctx.visit.id,
      ctx.leadUser.id,
    );
    assert.equal(leadList.length, 2);

    // Foreign field leads and outsiders are denied (BE-02G idiom).
    const alt = await addEligibleProvider(ctx, 'AltR');
    await expectError(
      listHandymanWorkSessionsByVisit(ctx.visit.id, alt.leadUser.id),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanWorkSessionById(first.session.id, alt.leadUser.id),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanWorkSessionsByVisit(ctx.visit.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanWorkSessionById(randomUUID(), adminUserId),
      'HANDYMAN_WORK_SESSION_NOT_FOUND',
      404,
    );

    // Privacy: no PII and no raw GPS anywhere in the read model.
    assertNoPii(JSON.stringify(staffList));
    assertNoRawLocation(JSON.stringify(staffList));
  });

  it('stays inside its boundary: no attendance, QC, BAST, invoice or permit facts are created and no completion happens', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeScheduledVisit();
    await arriveAndPresent(ctx);
    const vendorWorkId = await resolveVendorWorkId(ctx.job.id);
    const started = await startHandymanWorkSession(
      ctx.visit.id,
      startInput(),
      ctx.leadUser.id,
    );
    await endHandymanWorkSession(started.session.id, ctx.leadUser.id);

    // Work sessions are NOT attendance and never touch HR/financial chains.
    const attendance = await requirePool().query(
      `SELECT COUNT(*)::int AS n FROM attendance_records`,
    );
    assert.equal(attendance.rows[0].n, 0);
    const invoices = await requirePool().query(
      `SELECT COUNT(*)::int AS n FROM vendor_invoices`,
    );
    assert.equal(invoices.rows[0].n, 0);
    const basts = await requirePool().query(
      `SELECT COUNT(*)::int AS n FROM bast_documents`,
    );
    assert.equal(basts.rows[0].n, 0);
    const quality = await requirePool().query(
      `SELECT COUNT(*)::int AS n FROM quality_audits`,
    );
    assert.equal(quality.rows[0].n, 0);
    const permits = await requirePool().query(
      `SELECT COUNT(*)::int AS n FROM work_permit_readiness
       WHERE vendor_work_id = $1`,
      [vendorWorkId],
    );
    assert.equal(permits.rows[0].n, 0);

    // Execution stayed exactly at IN_PROGRESS/IN_PROGRESS — no completion,
    // no cancellation, nothing beyond the seam's two owned transitions.
    assert.equal(
      (await vendorWorkRow(vendorWorkId)).status,
      'IN_PROGRESS',
    );
    assert.equal(
      (await workOrderRow(ctx.job.workOrderId)).status,
      'IN_PROGRESS',
    );
    const allowed = new Set([
      'HANDYMAN_WORK_SESSION_STARTED',
      'HANDYMAN_WORK_SESSION_ENDED',
      'VENDOR_WORK_CREATED',
      'VENDOR_WORK_STATUS_CHANGED',
      'WORK_ORDER_STATUS_CHANGED',
      'WORK_ORDER_CREATED',
    ]);
    for (const entityId of [
      started.session.id,
      vendorWorkId,
      ctx.job.workOrderId,
    ]) {
      for (const event of await eventsFor(entityId)) {
        assert.ok(
          allowed.has(event.event_type),
          `unexpected event ${event.event_type}`,
        );
      }
    }
  });
});
