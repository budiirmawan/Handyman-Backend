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
import { clientService, type PublicClient } from '../src/modules/clients';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { departmentService } from '../src/modules/departments';
import { entitlementService } from '../src/modules/entitlements';
import { floorService } from '../src/modules/floors';
import {
  HANDYMAN_MODULE_CODE,
  designateHandymanProvider,
  updateHandymanProviderStatus,
} from '../src/modules/handyman-providers';
import {
  assignHandymanJobProviderAndCrew,
  createHandymanJob,
  createHandymanServiceVisit,
  cancelHandymanServiceVisitSchedule,
  assessHandymanServiceVisitExecutionReadiness,
  getHandymanServiceVisitById,
  getHandymanServiceVisitScheduleById,
  listHandymanServiceVisitSchedules,
  listHandymanServiceVisitsByJob,
  reassignHandymanJobProviderAndCrew,
  rescheduleHandymanServiceVisit,
} from '../src/modules/handyman-jobs';
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
import { createWorkPermitReadiness } from '../src/modules/work-permit-readiness';
import { transitionWorkOrderStatus } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-05 RUN 2 — focused service-level suite for service visit
 * identity, versioned schedule windows, schedule-time revalidation, temporal
 * crew/worker conflict protection, and the EXISTING BE-15D permit-readiness
 * integration behind the execution-ready gate.
 *
 * Fixtures consume the governed chain end to end (the Run-1 idiom): every
 * scenario starts from a real APPROVED request → job → assigned composition
 * before any visit exists.
 */

const PORT = 55504;
const DIR = '/tmp/asentra-hm05-run2-pg';
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
const CUSTOMER_PHONE = '+6281298765003';
const CUSTOMER_EMAIL = 'rina05r2@customer.example.com';

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
    `TRUNCATE handyman_service_visit_schedules, handyman_service_visits,
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
    email: `outsider05r2-${suffix().toLowerCase()}@example.com`,
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

/* ------------------------------------------------------------------ */
/* Fixtures — the full governed chain through an ASSIGNED job          */
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
      name: 'Visit Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Visit Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Visit Tower',
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
      tenantName: 'Visit Tenant Company',
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
    email: `pic05r2-${suffix().toLowerCase()}@tenant.example.com`,
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
      email: `pic05r2-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000006',
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
      name: 'Visit Service',
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
    name: 'Visit Workforce Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Visit Workforce Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Visit Workforce Position',
  });
  return { organization, department, position };
}

type OrgChain = Awaited<ReturnType<typeof createOrgChain>>;

/** EXTERNAL worker (BE-03C profile → BE-06F binding). Distinctive names
 * double as PII canaries for the audit assertions. */
async function createWorker(vendorId: string, chain: OrgChain, role: string) {
  const fullName = `Zqxf ${role} ${suffix()}`;
  const vendorPersonnelCode = `VPC-${role}-${suffix()}`;
  const profile = await workforceService.createWorkforceProfile({
    organizationId: chain.organization.id,
    departmentId: chain.department.id,
    positionId: chain.position.id,
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

/** Full governed chain through APPROVAL + eligible provider + crew. */
async function makeJobContext(options: { approve?: boolean } = {}) {
  const approve = options.approve ?? true;
  const h = await createHierarchy();
  const tenant = await makeTenantContext(h);
  const moduleId = await ensureHandymanModule();
  await configureHandymanBuilding(h.building.id);

  const vendor = await vendorService.createVendor({
    clientId: h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Visit Vendor',
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
  const capability = await vendorCapabilityService.createVendorCapability({
    vendorId: vendor.id,
    code: `CAP_${suffix()}`,
    name: 'Visit Capability',
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
  const sent = await sendHandymanQuotation(
    {
      quotationId: quotation.quotation.id,
      revisionId: quotation.revision.id,
    },
    adminUserId,
  );
  if (approve) {
    await decideHandymanQuotationApprovalInApp(
      { quotationId: quotation.quotation.id, decision: 'APPROVED' },
      tenant.picUser.id,
    );
  }

  const chain = await createOrgChain(h.client.id);
  const lead = await createWorker(vendor.id, chain, 'LeadOne');
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: 'Visit Crew One',
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );

  return {
    h,
    tenant,
    vendor,
    provider,
    relationship,
    capability,
    request,
    service,
    quotation: quotation.quotation,
    revision: quotation.revision,
    sent,
    chain,
    lead,
    crew,
  };
}

type JobContext = Awaited<ReturnType<typeof makeJobContext>>;

/** A SECOND fully eligible provider+crew on the same client/building/service. */
async function addEligibleProvider(base: JobContext, role: string) {
  const vendor = await vendorService.createVendor({
    clientId: base.h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: `Visit Vendor ${role}`,
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
    name: `Visit Capability ${role}`,
    serviceCatalogId: base.service.id,
    vendorBuildingRelationshipId: relationship.id,
  });
  const lead = await createWorker(vendor.id, base.chain, role);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: base.h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: `Visit Crew ${role}`,
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );
  return { vendor, provider, relationship, crew, lead };
}

/** A second APPROVED request chain on the same client/building/vendor/
 * provider/service. */
async function approveSecondRequest(base: JobContext) {
  const request = await createRequest(base.h, base.tenant, 'Second Visit Job');
  await triageHandymanRequest(
    { requestId: request.id, path: 'QUOTATION', notes: 'Known scope' },
    adminUserId,
  );
  await selectHandymanRequestService(
    { requestId: request.id, serviceCatalogId: base.service.id, source: 'TRIAGE' },
    adminUserId,
  );
  const quotation = await createHandymanQuotation(
    { requestId: request.id, currency: 'IDR' },
    adminUserId,
  );
  await addHandymanQuotationLine(
    {
      revisionId: quotation.revision.id,
      lineType: 'LABOR',
      serviceCatalogId: base.service.id,
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
    base.tenant.picUser.id,
  );
  return request;
}

/** Job created + provider/crew assigned (the Run-1 precondition of every
 * Run-2 command). */
async function makeAssignedJob(base: JobContext) {
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
  return { job, assignment };
}

/** A SECOND assigned job on the same context; target defaults to the same
 * provider+crew (shared-crew scenarios) or an alternate eligible pair. */
async function makeSecondAssignedJob(
  base: JobContext,
  target?: { providerId: string; crewId: string },
) {
  const request2 = await approveSecondRequest(base);
  const { job } = await createHandymanJob(
    { handymanRequestId: request2.id },
    adminUserId,
  );
  const assignment = await assignHandymanJobProviderAndCrew(
    job.id,
    {
      handymanProviderId: target?.providerId ?? base.provider.id,
      handymanWorkCrewId: target?.crewId ?? base.crew.id,
    },
    adminUserId,
  );
  return { job, assignment, request: request2 };
}

/* ------------------------------------------------------------------ */
/* Window + row helpers                                                */
/* ------------------------------------------------------------------ */

const BASE_DAY = Date.UTC(2026, 9, 5); // 2026-10-05T00:00:00Z

function win(dayOffset: number, startHour: number, endHour: number) {
  return {
    plannedStartAt: new Date(BASE_DAY + dayOffset * 86_400_000 + startHour * 3_600_000),
    plannedEndAt: new Date(BASE_DAY + dayOffset * 86_400_000 + endHour * 3_600_000),
  };
}

type ScheduleRow = {
  id: string;
  status: string;
  planned_start_at: Date;
  planned_end_at: Date;
  superseded_at: Date | null;
  superseded_by_user_id: string | null;
  cancelled_at: Date | null;
  cancelled_by_user_id: string | null;
};

async function scheduleRows(visitId: string): Promise<ScheduleRow[]> {
  const result = await requirePool().query<ScheduleRow>(
    `SELECT id, status, planned_start_at, planned_end_at, superseded_at,
            superseded_by_user_id, cancelled_at, cancelled_by_user_id
     FROM handyman_service_visit_schedules
     WHERE handyman_service_visit_id = $1
     ORDER BY created_at ASC`,
    [visitId],
  );
  return result.rows;
}

async function visitRows(jobId: string): Promise<{ id: string; visit_sequence: number }[]> {
  const result = await requirePool().query(
    `SELECT id, visit_sequence FROM handyman_service_visits
     WHERE handyman_job_id = $1 ORDER BY visit_sequence ASC`,
    [jobId],
  );
  return result.rows;
}

async function workOrderRow(workOrderId: string) {
  const result = await requirePool().query(
    `SELECT id, status, started_at FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  return result.rows[0] as { id: string; status: string; started_at: Date | null };
}

async function vendorWorkRow(vendorAssignmentId: string) {
  const result = await requirePool().query(
    `SELECT id, status, started_at FROM vendor_works WHERE vendor_assignment_id = $1`,
    [vendorAssignmentId],
  );
  return result.rows[0] as { id: string; status: string; started_at: Date | null };
}

async function eventsFor(entityId: string) {
  const result = await requirePool().query(
    `SELECT event_type, entity_type, metadata, summary
     FROM operational_events
     WHERE entity_id = $1
     ORDER BY occurred_at ASC`,
    [entityId],
  );
  return result.rows as {
    event_type: string;
    entity_type: string;
    metadata: Record<string, unknown>;
    summary: string;
  }[];
}

function assertNoPii(events: Awaited<ReturnType<typeof eventsFor>>): void {
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(CUSTOMER_NAME), 'customer name leaked');
  assert.ok(!serialized.includes(CUSTOMER_PHONE), 'customer phone leaked');
  assert.ok(!serialized.includes(CUSTOMER_EMAIL), 'customer email leaked');
  assert.ok(!serialized.includes('Zqxf'), 'worker name leaked');
}

/* ------------------------------------------------------------------ */
/* 1. Visit identity + versioned schedule windows                      */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 2: visit + schedule authority', () => {
  it('creates the first visit with its first ACTIVE window atomically', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJob(base);
    const window = win(0, 9, 10);

    const result = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...window },
      adminUserId,
    );

    assert.equal(result.visit.handymanJobId, job.id);
    assert.equal(result.visit.clientId, base.h.client.id);
    assert.equal(result.visit.visitSequence, 1);
    assert.equal(result.visit.createdByUserId, adminUserId);
    assert.equal(result.schedule.status, 'ACTIVE');
    assert.equal(result.schedule.handymanServiceVisitId, result.visit.id);
    assert.equal(result.schedule.plannedStartAt, window.plannedStartAt.toISOString());
    assert.equal(result.schedule.plannedEndAt, window.plannedEndAt.toISOString());
    assert.equal(result.schedule.supersededAt, null);
    assert.equal(result.schedule.cancelledAt, null);

    // Audit: IDs/sequence/window/status only — no PII.
    const events = await eventsFor(result.visit.id);
    const scheduled = events.filter(
      (event) => event.event_type === 'HANDYMAN_SERVICE_VISIT_SCHEDULED',
    );
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].entity_type, 'HANDYMAN_SERVICE_VISIT');
    assert.equal(scheduled[0].metadata.handymanJobId, job.id);
    assert.equal(scheduled[0].metadata.visitSequence, 1);
    assert.equal(
      scheduled[0].metadata.handymanServiceVisitScheduleId,
      result.schedule.id,
    );
    assert.equal(scheduled[0].metadata.plannedStartAt, window.plannedStartAt.toISOString());
    assert.equal(scheduled[0].metadata.plannedEndAt, window.plannedEndAt.toISOString());
    assertNoPii(events);

    // BOUNDARY: the work order stays ASSIGNED, the vendor work stays
    // NOT_STARTED — scheduling never touches execution.
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');
    assert.equal(wo.started_at, null);
    const vw = await vendorWorkRow(assignment.vendorAssignmentId);
    assert.equal(vw.status, 'NOT_STARTED');
    assert.equal(vw.started_at, null);
  });

  it('rejects invalid windows and unassigned/non-pre-execution jobs', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);

    // end <= start (structural CHECK + service validation).
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 10, 9) },
        adminUserId,
      ),
      'HANDYMAN_SERVICE_VISIT_WINDOW_INVALID',
      400,
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 10, 10) },
        adminUserId,
      ),
      'HANDYMAN_SERVICE_VISIT_WINDOW_INVALID',
      400,
    );
    assert.equal((await visitRows(job.id)).length, 0);

    // Job without an ACTIVE composition.
    const request2 = await approveSecondRequest(base);
    const { job: job2 } = await createHandymanJob(
      { handymanRequestId: request2.id },
      adminUserId,
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job2.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_JOB_NOT_ASSIGNED',
      409,
    );

    // Work order past the pre-execution window.
    await transitionWorkOrderStatus(job.workOrderId, { status: 'IN_PROGRESS' });
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_JOB_NOT_ASSIGNABLE',
      409,
    );

    // Outsiders and unknown jobs.
    const request3 = await approveSecondRequest(base);
    const { job: job3 } = await createHandymanJob(
      { handymanRequestId: request3.id },
      adminUserId,
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job3.id, ...win(0, 9, 10) },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: randomUUID(), ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_JOB_NOT_FOUND',
      404,
    );
  });

  it('sequences multiple visits per job, server-side, race-safe', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);

    const first = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );
    assert.equal(first.visit.visitSequence, 1);

    // Concurrent creation: the job-row lock serializes max+1; sequences are
    // unique and dense.
    const results = await Promise.allSettled([
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(1, 9, 10) },
        adminUserId,
      ),
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(2, 9, 10) },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof createHandymanServiceVisit>>>[];
    assert.equal(fulfilled.length, 2);
    const sequences = [first.visit.visitSequence, ...fulfilled.map((r) => r.value.visit.visitSequence)].sort();
    assert.deepEqual(sequences, [1, 2, 3]);

    const rows = await visitRows(job.id);
    assert.equal(rows.length, 3);
    // Each visit keeps its OWN independent ACTIVE window (exactly one per
    // visit; same-job visits do not conflict temporally — one composition).
    for (const row of rows) {
      const schedules = await scheduleRows(row.id);
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0].status, 'ACTIVE');
    }
  });

  it('reschedules versionally: the old window is superseded untouched', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    const original = win(0, 9, 10);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...original },
      adminUserId,
    );
    const next = win(1, 13, 15);

    const result = await rescheduleHandymanServiceVisit(
      created.visit.id,
      next,
      adminUserId,
    );
    assert.equal(result.visit.id, created.visit.id);
    assert.equal(result.supersededScheduleId, created.schedule.id);
    assert.equal(result.schedule.status, 'ACTIVE');
    assert.notEqual(result.schedule.id, created.schedule.id);
    assert.equal(result.schedule.plannedStartAt, next.plannedStartAt.toISOString());
    assert.equal(result.schedule.plannedEndAt, next.plannedEndAt.toISOString());

    const rows = await scheduleRows(created.visit.id);
    assert.equal(rows.length, 2);
    const old = rows.find((row) => row.id === created.schedule.id)!;
    const fresh = rows.find((row) => row.id === result.schedule.id)!;
    // The old TIME WINDOW was never mutated — only closure attribution.
    assert.equal(old.status, 'SUPERSEDED');
    assert.equal(old.planned_start_at.toISOString(), original.plannedStartAt.toISOString());
    assert.equal(old.planned_end_at.toISOString(), original.plannedEndAt.toISOString());
    assert.ok(old.superseded_at instanceof Date);
    assert.equal(old.superseded_by_user_id, adminUserId);
    assert.equal(old.cancelled_at, null);
    assert.equal(fresh.status, 'ACTIVE');
    assert.equal(
      rows.filter((row) => row.status === 'ACTIVE').length,
      1,
    );

    const events = await eventsFor(created.visit.id);
    const rescheduled = events.filter(
      (event) => event.event_type === 'HANDYMAN_SERVICE_VISIT_RESCHEDULED',
    );
    assert.equal(rescheduled.length, 1);
    assert.equal(
      rescheduled[0].metadata.previousHandymanServiceVisitScheduleId,
      created.schedule.id,
    );
    assert.equal(
      rescheduled[0].metadata.handymanServiceVisitScheduleId,
      result.schedule.id,
    );
    assert.equal(
      rescheduled[0].metadata.previousPlannedStartAt,
      original.plannedStartAt.toISOString(),
    );
    assertNoPii(events);

    // Rescheduling a visit whose window was cancelled is guarded.
    await cancelHandymanServiceVisitSchedule(created.visit.id, adminUserId);
    await expectError(
      rescheduleHandymanServiceVisit(created.visit.id, win(3, 9, 10), adminUserId),
      'HANDYMAN_SERVICE_VISIT_NOT_SCHEDULABLE',
      409,
    );
    await expectError(
      rescheduleHandymanServiceVisit(randomUUID(), win(3, 9, 10), adminUserId),
      'HANDYMAN_SERVICE_VISIT_NOT_FOUND',
      404,
    );
  });

  it('cancels the ACTIVE window, retains history, and replays idempotently', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    const original = win(0, 9, 10);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...original },
      adminUserId,
    );

    const cancelled = await cancelHandymanServiceVisitSchedule(
      created.visit.id,
      adminUserId,
    );
    assert.equal(cancelled.alreadyCancelled, false);
    assert.equal(cancelled.cancelledScheduleId, created.schedule.id);
    assert.equal(cancelled.visit.id, created.visit.id);

    // Visit identity + history retained; closure attributed; window columns
    // untouched.
    const rows = await scheduleRows(created.visit.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'CANCELLED');
    assert.ok(rows[0].cancelled_at instanceof Date);
    assert.equal(rows[0].cancelled_by_user_id, adminUserId);
    assert.equal(rows[0].superseded_at, null);
    assert.equal(rows[0].planned_start_at.toISOString(), original.plannedStartAt.toISOString());
    const view = await getHandymanServiceVisitById(created.visit.id, adminUserId);
    assert.equal(view.activeSchedule, null);

    const events = await eventsFor(created.visit.id);
    const cancelEvents = events.filter(
      (event) => event.event_type === 'HANDYMAN_SERVICE_VISIT_SCHEDULE_CANCELLED',
    );
    assert.equal(cancelEvents.length, 1);
    assert.equal(
      cancelEvents[0].metadata.handymanServiceVisitScheduleId,
      created.schedule.id,
    );
    assertNoPii(events);

    // Replay converges onto the closed evidence — no second event.
    const replay = await cancelHandymanServiceVisitSchedule(
      created.visit.id,
      adminUserId,
    );
    assert.equal(replay.alreadyCancelled, true);
    assert.equal(replay.cancelledScheduleId, created.schedule.id);
    const eventsAfter = await eventsFor(created.visit.id);
    assert.equal(
      eventsAfter.filter(
        (event) => event.event_type === 'HANDYMAN_SERVICE_VISIT_SCHEDULE_CANCELLED',
      ).length,
      1,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. Schedule-time revalidation (TIME OF USE)                         */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 2: schedule-time revalidation', () => {
  it('rejects an INACTIVE provider designation', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    await updateHandymanProviderStatus(
      base.provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_STATUS_INVALID',
      400,
    );
    assert.equal((await visitRows(job.id)).length, 0);
  });

  it('rejects an INACTIVE vendor', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    await vendorService.updateVendorStatus(base.vendor.id, { status: 'INACTIVE' });
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'VENDOR_INACTIVE',
      400,
    );
    assert.equal((await visitRows(job.id)).length, 0);
  });

  it('rejects a lost vendor-building relationship', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    await vendorBuildingService.updateVendorBuildingRelationship(
      base.vendor.id,
      base.h.building.id,
      { status: 'INACTIVE' },
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'VENDOR_ASSIGNMENT_BUILDING_MISMATCH',
      400,
    );
    assert.equal((await visitRows(job.id)).length, 0);
  });

  it('rejects a lost service capability (eligibility gap)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    await vendorCapabilityService.updateVendorCapabilityStatus(
      base.capability.id,
      { status: 'INACTIVE' },
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_JOB_PROVIDER_SERVICE_NOT_ELIGIBLE',
      409,
    );
    assert.equal((await visitRows(job.id)).length, 0);
  });

  it('rejects an INACTIVE crew and a broken worker chain', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);

    // INACTIVE crew.
    await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
      400,
    );
    await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'ACTIVE' },
      adminUserId,
    );

    // Lead worker binding INACTIVE → the CR04 worker chain fails closed.
    await vendorWorkforceService.updateVendorWorkforceBinding(
      base.vendor.id,
      base.lead.profile.id,
      { status: 'INACTIVE' },
    );
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_WORKER_BINDING_INACTIVE',
      409,
    );
    assert.equal((await visitRows(job.id)).length, 0);
  });

  it('revalidates on RESCHEDULE too (time of use, not time of creation)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );
    await updateHandymanProviderStatus(
      base.provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      rescheduleHandymanServiceVisit(created.visit.id, win(1, 9, 10), adminUserId),
      'HANDYMAN_PROVIDER_STATUS_INVALID',
      400,
    );
    // The ACTIVE window is untouched by the rejected reschedule.
    const rows = await scheduleRows(created.visit.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ACTIVE');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Temporal crew + worker conflict protection                       */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 2: temporal conflict protection', () => {
  it('rejects an overlapping window for the SAME crew on another job', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJob(base);
    const second = await makeSecondAssignedJob(base); // SAME crew
    await createHandymanServiceVisit(
      { handymanJobId: job1.id, ...win(0, 9, 10) },
      adminUserId,
    );

    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: second.job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_SERVICE_VISIT_CREW_CONFLICT',
      409,
    );
    // Partial overlap is also rejected; nothing was created.
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: second.job.id, ...win(0, 9, 11) }, // 09:30–10:30-style partial via 9-11
        adminUserId,
      ),
      'HANDYMAN_SERVICE_VISIT_CREW_CONFLICT',
      409,
    );
    assert.equal((await visitRows(second.job.id)).length, 0);
  });

  it('allows back-to-back windows (half-open semantics) and same-job overlap', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJob(base);
    const second = await makeSecondAssignedJob(base); // SAME crew
    await createHandymanServiceVisit(
      { handymanJobId: job1.id, ...win(0, 9, 10) },
      adminUserId,
    );

    // 10:00–11:00 does NOT overlap 09:00–10:00 (half-open '[)').
    const backToBack = await createHandymanServiceVisit(
      { handymanJobId: second.job.id, ...win(0, 10, 11) },
      adminUserId,
    );
    assert.equal(backToBack.visit.visitSequence, 1);

    // Same-job visits share the ONE composition — not "another" assignment —
    // so an overlapping second visit on job1 is allowed.
    const sameJob = await createHandymanServiceVisit(
      { handymanJobId: job1.id, ...win(0, 9, 10) },
      adminUserId,
    );
    assert.equal(sameJob.visit.visitSequence, 2);
  });

  it('rejects a shared WORKER across different crews only on temporal overlap', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJob(base);

    // A second crew under the SAME provider founded by the SAME lead worker
    // (cross-crew membership stays legal — Run 1 proof) and a second job
    // assigned to it.
    const { crew: crew2 } = await createHandymanWorkCrew(
      {
        clientId: base.h.client.id,
        handymanProviderId: base.provider.id,
        crewCode: `CREW_${suffix()}`,
        crewName: 'Shared Worker Crew',
        leadWorkerBindingId: base.lead.binding.id,
      },
      adminUserId,
    );
    const second = await makeSecondAssignedJob(base, {
      providerId: base.provider.id,
      crewId: crew2.id,
    });

    await createHandymanServiceVisit(
      { handymanJobId: job1.id, ...win(0, 9, 10) },
      adminUserId,
    );

    // Overlapping window: crews differ, but the shared worker is
    // double-booked → WORKER conflict (not a membership rejection).
    await expectError(
      createHandymanServiceVisit(
        { handymanJobId: second.job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      'HANDYMAN_SERVICE_VISIT_WORKER_CONFLICT',
      409,
    );
    assert.equal((await visitRows(second.job.id)).length, 0);

    // Non-overlapping window for the SAME shared worker: allowed — the
    // conflict is temporal, never membership-global.
    const ok = await createHandymanServiceVisit(
      { handymanJobId: second.job.id, ...win(0, 10, 11) },
      adminUserId,
    );
    assert.equal(ok.visit.visitSequence, 1);
  });

  it('ignores SUPERSEDED and CANCELLED windows and its own replaced schedule', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJob(base);
    const second = await makeSecondAssignedJob(base); // SAME crew

    const created = await createHandymanServiceVisit(
      { handymanJobId: job1.id, ...win(0, 9, 10) },
      adminUserId,
    );

    // Self-reschedule overlapping its OWN old window: allowed (the schedule
    // being replaced is excluded).
    const rescheduled = await rescheduleHandymanServiceVisit(
      created.visit.id,
      win(0, 9, 11), // overlaps 09:00–10:00 partially
      adminUserId,
    );
    assert.equal(rescheduled.schedule.status, 'ACTIVE');

    // The SUPERSEDED 09:00–10:00 window is invisible to conflict scans:
    // job2 may take 09:00–09:30... which still overlaps the NEW window, so
    // pick a slot that only overlapped the SUPERSEDED one: none exists here
    // (new window is a superset) — instead supersede again to a disjoint
    // window, then claim the freed original slot from job2.
    await rescheduleHandymanServiceVisit(created.visit.id, win(5, 9, 10), adminUserId);
    const freedSlot = await createHandymanServiceVisit(
      { handymanJobId: second.job.id, ...win(0, 9, 11) },
      adminUserId,
    );
    assert.equal(freedSlot.visit.visitSequence, 1);

    // Cancel job2's window; job1 can then re-enter the same slot even though
    // a CANCELLED row still holds it (cancellation frees the window).
    await cancelHandymanServiceVisitSchedule(freedSlot.visit.id, adminUserId);
    const reclaimed = await createHandymanServiceVisit(
      { handymanJobId: job1.id, ...win(0, 9, 11) },
      adminUserId,
    );
    assert.equal(reclaimed.visit.visitSequence, 2);
    const freedRows = await scheduleRows(freedSlot.visit.id);
    assert.equal(freedRows.length, 1);
    assert.equal(freedRows[0].status, 'CANCELLED');
  });

  it('elects one winner when concurrent commands propose overlapping windows', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJob(base);
    const second = await makeSecondAssignedJob(base); // SAME crew

    const results = await Promise.allSettled([
      createHandymanServiceVisit(
        { handymanJobId: job1.id, ...win(0, 9, 10) },
        adminUserId,
      ),
      createHandymanServiceVisit(
        { handymanJobId: second.job.id, ...win(0, 9, 10) },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      (rejected[0].reason as { code?: string }).code,
      'HANDYMAN_SERVICE_VISIT_CREW_CONFLICT',
    );
    // Exactly one ACTIVE window exists across both jobs.
    const rows1 = await visitRows(job1.id);
    const rows2 = await visitRows(second.job.id);
    assert.equal(rows1.length + rows2.length, 1);
  });

  it('elects one winner under concurrent reschedules (stale command 409)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );

    const results = await Promise.allSettled([
      rescheduleHandymanServiceVisit(created.visit.id, win(1, 9, 10), adminUserId),
      rescheduleHandymanServiceVisit(created.visit.id, win(2, 9, 10), adminUserId),
    ]);
    const fulfilled = results.filter(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof rescheduleHandymanServiceVisit>>>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      (rejected[0].reason as { code?: string }).code,
      'HANDYMAN_SERVICE_VISIT_SCHEDULE_STATE_INVALID',
    );

    const rows = await scheduleRows(created.visit.id);
    assert.equal(rows.length, 2);
    assert.equal(
      rows.filter((row) => row.status === 'ACTIVE').length,
      1,
    );
    assert.equal(
      rows.find((row) => row.status === 'ACTIVE')!.id,
      fulfilled[0].value.schedule.id,
    );
    assert.equal(rows.find((row) => row.status === 'SUPERSEDED')!.id, created.schedule.id);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Permit readiness (BE-15D reuse) + execution-ready gate           */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 2: permit readiness + execution-ready gate', () => {
  it('resolves the EXISTING vendor work; zero readiness rows keep BE-15D NOT_REQUIRED semantics', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJob(base);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );

    const readiness = await assessHandymanServiceVisitExecutionReadiness(
      created.visit.id,
      adminUserId,
    );
    assert.equal(readiness.vendorWorkId, assignment.vendorWorkId);
    assert.equal(readiness.workOrderId, job.workOrderId);
    assert.equal(readiness.permitReadiness.readinessStatus, 'NOT_REQUIRED');
    assert.deepEqual(readiness.permitReadiness.permits, []);
    assert.equal(readiness.permitReadiness.ready, true);
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.checks, {
      hasActiveSchedule: true,
      workOrderPreExecution: true,
      hasActiveJobAssignment: true,
      providerChainValid: true,
      crewChainValid: true,
      noScheduleConflict: true,
      permitsReady: true,
    });
    assert.equal(readiness.activeSchedule?.id, created.schedule.id);

    // A pure READ: no execution transition, no vendor work start, no event.
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');
    assert.equal(wo.started_at, null);
    const vw = await vendorWorkRow(assignment.vendorAssignmentId);
    assert.equal(vw.status, 'NOT_STARTED');
    const vwEvents = await eventsFor(assignment.vendorWorkId);
    assert.equal(
      vwEvents.filter((event) => event.event_type !== 'VENDOR_WORK_CREATED')
        .length,
      0,
    );
    const visitEvents = await eventsFor(created.visit.id);
    assert.equal(
      visitEvents.filter((event) =>
        event.event_type.startsWith('HANDYMAN_SERVICE_VISIT_READY'),
      ).length,
      0,
    );
  });

  it('READY and NOT_REQUIRED requirements allow ready; NOT_READY and EXPIRED block', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJob(base);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );
    const now = Date.now();

    // READY: ISSUED permit with a validity window spanning now.
    await createWorkPermitReadiness(
      {
        vendorWorkId: assignment.vendorWorkId,
        permitRequirementType: 'HOT_WORK',
        permitReference: `PERMIT-${suffix()}`,
        permitStatus: 'ISSUED',
        validFrom: new Date(now - 86_400_000),
        validUntil: new Date(now + 86_400_000),
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    // NOT_REQUIRED row alongside READY → aggregate READY.
    await createWorkPermitReadiness(
      {
        vendorWorkId: assignment.vendorWorkId,
        permitRequirementType: 'NOT_REQUIRED',
        permitStatus: 'PENDING',
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    let readiness = await assessHandymanServiceVisitExecutionReadiness(
      created.visit.id,
      adminUserId,
    );
    assert.equal(readiness.permitReadiness.readinessStatus, 'READY');
    assert.equal(readiness.permitReadiness.ready, true);
    assert.equal(readiness.checks.permitsReady, true);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.permitReadiness.permits.length, 2);

    // NOT_READY: a PENDING requirement blocks.
    await createWorkPermitReadiness(
      {
        vendorWorkId: assignment.vendorWorkId,
        permitRequirementType: 'WORKING_AT_HEIGHT',
        permitStatus: 'PENDING',
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    readiness = await assessHandymanServiceVisitExecutionReadiness(
      created.visit.id,
      adminUserId,
    );
    assert.equal(readiness.permitReadiness.readinessStatus, 'NOT_READY');
    assert.equal(readiness.checks.permitsReady, false);
    assert.equal(readiness.ready, false);

    // EXPIRED: time-aware re-derivation (ISSUED but valid_until in the past).
    await createWorkPermitReadiness(
      {
        vendorWorkId: assignment.vendorWorkId,
        permitRequirementType: 'CONFINED_SPACE',
        permitStatus: 'ISSUED',
        validFrom: new Date(now - 2 * 86_400_000),
        validUntil: new Date(now - 3_600_000),
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    readiness = await assessHandymanServiceVisitExecutionReadiness(
      created.visit.id,
      adminUserId,
    );
    assert.equal(readiness.permitReadiness.readinessStatus, 'EXPIRED');
    assert.equal(readiness.ready, false);
    const expiredPermit = readiness.permitReadiness.permits.find(
      (permit) => permit.permitRequirementType === 'CONFINED_SPACE',
    )!;
    assert.equal(expiredPermit.readinessStatus, 'EXPIRED');

    // Still no execution side effects anywhere.
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');
    const vw = await vendorWorkRow(assignment.vendorAssignmentId);
    assert.equal(vw.status, 'NOT_STARTED');
  });

  it('blocks readiness on missing schedule, execution start, broken chains, and post-hoc conflicts', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJob(base);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );

    // No ACTIVE schedule (cancelled) → not ready.
    await cancelHandymanServiceVisitSchedule(created.visit.id, adminUserId);
    let readiness = await assessHandymanServiceVisitExecutionReadiness(
      created.visit.id,
      adminUserId,
    );
    assert.equal(readiness.checks.hasActiveSchedule, false);
    assert.equal(readiness.ready, false);
    // Restore a live window for the remaining scenarios.
    const restored = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );

    // Provider chain broken → providerChainValid false, ready false (the
    // crew aggregate itself remains internally valid — the designation is
    // the provider chain's gate).
    await updateHandymanProviderStatus(
      base.provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    readiness = await assessHandymanServiceVisitExecutionReadiness(
      restored.visit.id,
      adminUserId,
    );
    assert.equal(readiness.checks.providerChainValid, false);
    assert.equal(readiness.ready, false);
    await updateHandymanProviderStatus(
      base.provider.id,
      { status: 'ACTIVE' },
      adminUserId,
    );
    readiness = await assessHandymanServiceVisitExecutionReadiness(
      restored.visit.id,
      adminUserId,
    );
    assert.equal(readiness.checks.providerChainValid, true);
    assert.equal(readiness.checks.crewChainValid, true);
    assert.equal(readiness.ready, true);

    // Work order past pre-execution → workOrderPreExecution false.
    await transitionWorkOrderStatus(job.workOrderId, { status: 'IN_PROGRESS' });
    readiness = await assessHandymanServiceVisitExecutionReadiness(
      restored.visit.id,
      adminUserId,
    );
    assert.equal(readiness.checks.workOrderPreExecution, false);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.permitReadiness.ready, true); // BE-15D untouched
    const vw = await vendorWorkRow(assignment.vendorAssignmentId);
    assert.equal(vw.status, 'NOT_STARTED');
  });

  it('sees a post-hoc crew conflict created by a legal Run-1 reassignment', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJob(base);
    const second = await addEligibleProvider(base, 'LeadSwap');
    const { job: job2 } = await makeSecondAssignedJob(base, {
      providerId: second.provider.id,
      crewId: second.crew.id,
    });

    // Both windows are legal at write time: different crews, disjoint
    // workers, identical slots.
    const visit1 = await createHandymanServiceVisit(
      { handymanJobId: job1.id, ...win(0, 9, 10) },
      adminUserId,
    );
    await createHandymanServiceVisit(
      { handymanJobId: job2.id, ...win(0, 9, 10) },
      adminUserId,
    );
    let readiness = await assessHandymanServiceVisitExecutionReadiness(
      visit1.visit.id,
      adminUserId,
    );
    assert.equal(readiness.checks.noScheduleConflict, true);
    assert.equal(readiness.ready, true);

    // Run-1 reassignment has NO temporal check (by design): moving job2 onto
    // job1's crew is legal, and the conflict becomes visible through the
    // readiness assessment — state authority stays clean, nothing was
    // mirrored or rewritten.
    await reassignHandymanJobProviderAndCrew(
      job2.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    readiness = await assessHandymanServiceVisitExecutionReadiness(
      visit1.visit.id,
      adminUserId,
    );
    assert.equal(readiness.checks.noScheduleConflict, false);
    assert.equal(readiness.ready, false);
    // The schedules themselves were never touched by the reassignment.
    const rows = await scheduleRows(visit1.visit.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ACTIVE');
  });

  it('denies readiness assessment and reads to outsiders', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    const created = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );
    await expectError(
      assessHandymanServiceVisitExecutionReadiness(created.visit.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanServiceVisitById(created.visit.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanServiceVisitsByJob(job.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanServiceVisitSchedules(created.visit.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      cancelHandymanServiceVisitSchedule(created.visit.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanServiceVisitById(randomUUID(), adminUserId),
      'HANDYMAN_SERVICE_VISIT_NOT_FOUND',
      404,
    );
    await expectError(
      getHandymanServiceVisitScheduleById(randomUUID(), adminUserId),
      'HANDYMAN_SERVICE_VISIT_SCHEDULE_NOT_FOUND',
      404,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. Reads                                                            */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 2: reads', () => {
  it('serves visits in sequence order with active windows and full history', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await makeAssignedJob(base);
    const first = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(0, 9, 10) },
      adminUserId,
    );
    await rescheduleHandymanServiceVisit(first.visit.id, win(1, 9, 10), adminUserId);
    const second = await createHandymanServiceVisit(
      { handymanJobId: job.id, ...win(2, 9, 10) },
      adminUserId,
    );

    const visits = await listHandymanServiceVisitsByJob(job.id, adminUserId);
    assert.equal(visits.length, 2);
    assert.deepEqual(
      visits.map((view) => view.visit.visitSequence),
      [1, 2],
    );
    assert.equal(visits[0].activeSchedule?.plannedStartAt, win(1, 9, 10).plannedStartAt.toISOString());
    assert.equal(visits[1].activeSchedule?.id, second.schedule.id);

    const history = await listHandymanServiceVisitSchedules(
      first.visit.id,
      adminUserId,
    );
    assert.equal(history.length, 2);
    assert.equal(
      history.filter((row) => row.status === 'SUPERSEDED').length,
      1,
    );
    assert.equal(
      history.filter((row) => row.status === 'ACTIVE').length,
      1,
    );

    const one = await getHandymanServiceVisitScheduleById(
      first.schedule.id,
      adminUserId,
    );
    assert.equal(one.status, 'SUPERSEDED');
    assert.ok(one.supersededAt);
    assert.equal(one.supersededByUserId, adminUserId);

    const view = await getHandymanServiceVisitById(first.visit.id, adminUserId);
    assert.equal(view.visit.id, first.visit.id);
    assert.ok(view.activeSchedule);
    await expectError(
      listHandymanServiceVisitsByJob(randomUUID(), adminUserId),
      'HANDYMAN_JOB_NOT_FOUND',
      404,
    );
  });
});
