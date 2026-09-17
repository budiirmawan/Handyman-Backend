import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse } from 'yaml';
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
import { createHandymanWorkCrew } from '../src/modules/handyman-work-crews';
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
import {
  createWorkPermitReadiness,
  updateWorkPermitReadiness,
} from '../src/modules/work-permit-readiness';
import { workforceService } from '../src/modules/workforce';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-05 RUN 3 — focused HTTP/OpenAPI contract tests for the thirteen
 * Handyman Job / assignment / service-visit scheduling endpoints: auth on
 * every route, the three read/manage permission separations, readiness
 * behind the visit READ permission, strict body/query allowlists with
 * protected server-authoritative field rejection, domain errors preserved
 * across the wire (no translation into generic 400s), the visit lifecycle
 * over HTTP (create/second visit/reschedule history/cancel idempotency),
 * temporal crew and shared-worker conflicts surfacing as domain 409s,
 * back-to-back windows allowed, the pure execution-readiness GET (BE-15D
 * passthrough, zero side effects), privacy canaries across every read model,
 * and exact runtime↔OpenAPI parity (operations, permissions, bearerAuth,
 * schema allowlists, no DELETE / schedule-row CRUD / arrival-execution
 * routes). Business-rule depth lives in the Run-1/Run-2 service suites
 * (tests/handyman-job-assignment.test.ts,
 * tests/handyman-service-visit-scheduling.test.ts); here each seam is
 * re-asserted ONCE through the wire to prove thin controller delegation.
 */

const PORT = 55506;
const DIR = '/tmp/asentra-hm05-run3-pg';
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

type ErrorBody = {
  error: { code: string; message?: string; details?: { field: string }[] };
};

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const CUSTOMER_NAME = 'Rina Tenant Contact';
const CUSTOMER_PHONE = '+6281298765005';
const CUSTOMER_EMAIL = 'rina05r3@customer.example.com';

const PERMISSIONS = {
  jobRead: { code: 'handyman_job.read', name: 'Read Handyman Jobs' },
  jobManage: { code: 'handyman_job.manage', name: 'Manage Handyman Jobs' },
  assignmentRead: {
    code: 'handyman_job_assignment.read',
    name: 'Read Handyman Job Assignments',
  },
  assignmentManage: {
    code: 'handyman_job_assignment.manage',
    name: 'Manage Handyman Job Assignments',
  },
  visitRead: {
    code: 'handyman_service_visit.read',
    name: 'Read Handyman Service Visits',
  },
  visitManage: {
    code: 'handyman_service_visit.manage',
    name: 'Manage Handyman Service Visits',
  },
} as const;

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

function detailFields(body: ErrorBody): string[] {
  return (body.error.details ?? []).map((detail) => detail.field);
}

/* ------------------------------------------------------------------ */
/* Route map (exactly the thirteen documented operations)              */
/* ------------------------------------------------------------------ */

const BE05_ROUTES = {
  createJob: '/api/v1/handyman-jobs',
  listJobs: '/api/v1/handyman-jobs',
  jobById: (jobId: string) => `/api/v1/handyman-jobs/${jobId}`,
  assign: (jobId: string) => `/api/v1/handyman-jobs/${jobId}/assignment`,
  reassign: (jobId: string) =>
    `/api/v1/handyman-jobs/${jobId}/assignment/reassign`,
  assignments: (jobId: string) => `/api/v1/handyman-jobs/${jobId}/assignments`,
  createVisit: (jobId: string) => `/api/v1/handyman-jobs/${jobId}/visits`,
  visitsByJob: (jobId: string) => `/api/v1/handyman-jobs/${jobId}/visits`,
  visitById: (visitId: string) => `/api/v1/handyman-service-visits/${visitId}`,
  schedules: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/schedules`,
  reschedule: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/reschedule`,
  cancel: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/cancel`,
  readiness: (visitId: string) =>
    `/api/v1/handyman-service-visits/${visitId}/execution-readiness`,
};

/* ------------------------------------------------------------------ */
/* Fixtures — the full governed chain through an APPROVED request      */
/* (the Run-1/Run-2 idiom; BE-05 surface itself is driven over HTTP)   */
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
      name: 'Http Job Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Http Job Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Http Job Tower',
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
      tenantName: 'Http Job Tenant Company',
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
    email: `pic05r3-${suffix().toLowerCase()}@tenant.example.com`,
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
      email: `pic05r3-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000007',
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
      name: 'Http Job Service',
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
    name: 'Http Job Workforce Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Http Job Workforce Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Http Job Workforce Position',
  });
  return { organization, department, position };
}

type OrgChain = Awaited<ReturnType<typeof createOrgChain>>;

/** EXTERNAL worker (BE-03C profile → BE-06F binding). Distinctive names
 * double as PII canaries for the response assertions. */
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
    vendorName: 'Http Job Vendor',
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
    name: 'Http Job Capability',
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
      crewName: 'Http Job Crew One',
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
    request,
    service,
    quotation: quotation.quotation,
    revision: quotation.revision,
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
    vendorName: `Http Job Vendor ${role}`,
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
    name: `Http Job Capability ${role}`,
    serviceCatalogId: base.service.id,
    vendorBuildingRelationshipId: relationship.id,
  });
  const lead = await createWorker(vendor.id, base.chain, role);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: base.h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: `Http Job Crew ${role}`,
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );
  return { vendor, provider, relationship, crew, lead };
}

/** A second APPROVED request chain on the same client/building/service. */
async function approveSecondRequest(base: JobContext) {
  const request = await createRequest(base.h, base.tenant, 'Second Http Job');
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

/* ------------------------------------------------------------------ */
/* HTTP-level composition helpers (the surface under test)             */
/* ------------------------------------------------------------------ */

type PublicJob = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  handymanQuotationId: string;
  handymanQuotationRevisionId: string;
  workOrderId: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

async function createJobViaHttp(base: JobContext, requestId?: string) {
  const response = await api()
    .post(BE05_ROUTES.createJob)
    .set(auth())
    .send({ handymanRequestId: requestId ?? base.request.id });
  assert.equal(response.status, 201);
  return response.body.data as { job: PublicJob; created: boolean };
}

async function assignViaHttp(
  jobId: string,
  providerId: string,
  crewId: string,
  token = adminToken,
) {
  const response = await api()
    .post(BE05_ROUTES.assign(jobId))
    .set(auth(token))
    .send({ handymanProviderId: providerId, handymanWorkCrewId: crewId });
  assert.equal(response.status, 201);
  return response.body.data as {
    job: PublicJob;
    assignment: { id: string; status: string; handymanWorkCrewId: string };
    vendorAssignmentId: string;
    vendorWorkId: string;
    workOrderStatus: string;
  };
}

/** APPROVED request → job → ACTIVE composition, all over HTTP. */
async function makeAssignedJobViaHttp(base: JobContext) {
  const { job } = await createJobViaHttp(base);
  const assignment = await assignViaHttp(
    job.id,
    base.provider.id,
    base.crew.id,
  );
  return { job, assignment };
}

async function createVisitViaHttp(
  jobId: string,
  window: { plannedStartAt: Date; plannedEndAt: Date },
) {
  const response = await api()
    .post(BE05_ROUTES.createVisit(jobId))
    .set(auth())
    .send({
      plannedStartAt: window.plannedStartAt.toISOString(),
      plannedEndAt: window.plannedEndAt.toISOString(),
    });
  assert.equal(response.status, 201);
  return response.body.data as {
    visit: { id: string; visitSequence: number };
    schedule: { id: string; status: string };
  };
}

/* ------------------------------------------------------------------ */
/* Window + row helpers (the Run-2 idiom)                              */
/* ------------------------------------------------------------------ */

const BASE_DAY = Date.UTC(2026, 9, 5); // 2026-10-05T00:00:00Z

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

async function vendorWorkRow(vendorAssignmentId: string) {
  const result = await requirePool().query(
    `SELECT id, status, started_at FROM vendor_works WHERE vendor_assignment_id = $1`,
    [vendorAssignmentId],
  );
  return result.rows[0] as {
    id: string;
    status: string;
    started_at: Date | null;
  };
}

async function eventsFor(entityId: string) {
  const result = await requirePool().query(
    `SELECT event_type FROM operational_events
     WHERE entity_id = $1 ORDER BY occurred_at ASC`,
    [entityId],
  );
  return result.rows as { event_type: string }[];
}

function assertNoPii(serialized: string): void {
  assert.ok(!serialized.includes(CUSTOMER_NAME), 'customer name leaked');
  assert.ok(!serialized.includes(CUSTOMER_PHONE), 'customer phone leaked');
  assert.ok(!serialized.includes(CUSTOMER_EMAIL), 'customer email leaked');
  assert.ok(!serialized.includes('Zqxf'), 'worker name leaked');
  assert.ok(!serialized.includes('VPC-'), 'vendor personnel code leaked');
}

/* ------------------------------------------------------------------ */
/* 1. Authentication + RBAC                                            */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — authentication and RBAC', () => {
  it('requires authentication on every BE-05 route', async (t) => {
    if (!ready(t)) return;

    const jobId = randomUUID();
    const visitId = randomUUID();
    const unauthenticated: Promise<unknown>[] = [
      api().post(BE05_ROUTES.createJob).send({}),
      api().get(`${BE05_ROUTES.listJobs}?clientId=${randomUUID()}`),
      api().get(BE05_ROUTES.jobById(jobId)),
      api().post(BE05_ROUTES.assign(jobId)).send({}),
      api().post(BE05_ROUTES.reassign(jobId)).send({}),
      api().get(BE05_ROUTES.assignments(jobId)),
      api().post(BE05_ROUTES.createVisit(jobId)).send({}),
      api().get(BE05_ROUTES.visitsByJob(jobId)),
      api().get(BE05_ROUTES.visitById(visitId)),
      api().get(BE05_ROUTES.schedules(visitId)),
      api().post(BE05_ROUTES.reschedule(visitId)).send({}),
      api().post(BE05_ROUTES.cancel(visitId)),
      api().get(BE05_ROUTES.readiness(visitId)),
    ];
    const responses = await Promise.all(unauthenticated);
    assert.equal(responses.length, 13);
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.equal(
        (response.body as ErrorBody).error.code,
        'AUTHENTICATION_REQUIRED',
      );
    }
  });

  it('denies authenticated callers without any BE-05 permission', async (t) => {
    if (!ready(t)) return;

    const plainToken = await createPlainSession();
    const jobId = randomUUID();
    const visitId = randomUUID();
    const responses = await Promise.all([
      api().post(BE05_ROUTES.createJob).set(auth(plainToken)).send({}),
      api()
        .get(`${BE05_ROUTES.listJobs}?clientId=${randomUUID()}`)
        .set(auth(plainToken)),
      api().get(BE05_ROUTES.jobById(jobId)).set(auth(plainToken)),
      api().post(BE05_ROUTES.assign(jobId)).set(auth(plainToken)).send({}),
      api().post(BE05_ROUTES.reassign(jobId)).set(auth(plainToken)).send({}),
      api().get(BE05_ROUTES.assignments(jobId)).set(auth(plainToken)),
      api().post(BE05_ROUTES.createVisit(jobId)).set(auth(plainToken)).send({}),
      api().get(BE05_ROUTES.visitsByJob(jobId)).set(auth(plainToken)),
      api().get(BE05_ROUTES.visitById(visitId)).set(auth(plainToken)),
      api().get(BE05_ROUTES.schedules(visitId)).set(auth(plainToken)),
      api().post(BE05_ROUTES.reschedule(visitId)).set(auth(plainToken)).send({}),
      api().post(BE05_ROUTES.cancel(visitId)).set(auth(plainToken)),
      api().get(BE05_ROUTES.readiness(visitId)).set(auth(plainToken)),
    ]);
    assert.equal(responses.length, 13);
    for (const response of responses) {
      assert.equal(response.status, 403);
      assert.equal(
        (response.body as ErrorBody).error.code,
        'PERMISSION_DENIED',
      );
    }
  });

  it('separates handyman_job.read from handyman_job.manage', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const readToken = await createSessionWithPermissions([PERMISSIONS.jobRead]);
    const manageToken = await createSessionWithPermissions([
      PERMISSIONS.jobManage,
    ]);

    // READ-only: the job mutation is denied at RBAC.
    const readDenied = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth(readToken))
      .send({ handymanRequestId: base.request.id });
    assert.equal(readDenied.status, 403);
    assert.equal(
      (readDenied.body as ErrorBody).error.code,
      'PERMISSION_DENIED',
    );

    // MANAGE-only: both job reads are denied at RBAC.
    for (const denied of await Promise.all([
      api()
        .get(`${BE05_ROUTES.listJobs}?clientId=${base.h.client.id}`)
        .set(auth(manageToken)),
      api().get(BE05_ROUTES.jobById(randomUUID())).set(auth(manageToken)),
    ])) {
      assert.equal(denied.status, 403);
      assert.equal((denied.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }
  });

  it('separates assignment read/manage and visit read/manage', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await createJobViaHttp(base);
    const assignmentManage = await createSessionWithPermissions([
      PERMISSIONS.assignmentManage,
    ]);
    const assignmentRead = await createSessionWithPermissions([
      PERMISSIONS.assignmentRead,
    ]);
    const visitManage = await createSessionWithPermissions([
      PERMISSIONS.visitManage,
    ]);
    const visitRead = await createSessionWithPermissions([
      PERMISSIONS.visitRead,
    ]);

    // ASSIGNMENT: manage token cannot read history; read token cannot assign.
    const historyDenied = await api()
      .get(BE05_ROUTES.assignments(job.id))
      .set(auth(assignmentManage));
    assert.equal(historyDenied.status, 403);
    assert.equal(
      (historyDenied.body as ErrorBody).error.code,
      'PERMISSION_DENIED',
    );
    const assignDenied = await api()
      .post(BE05_ROUTES.assign(job.id))
      .set(auth(assignmentRead))
      .send({
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      });
    assert.equal(assignDenied.status, 403);
    assert.equal(
      (assignDenied.body as ErrorBody).error.code,
      'PERMISSION_DENIED',
    );

    // Complete the composition as admin for the visit leg.
    await assignViaHttp(job.id, base.provider.id, base.crew.id);
    const { visit } = await createVisitViaHttp(job.id, win(0, 9, 10));

    // VISIT: manage token cannot read; read token cannot mutate (all three).
    const visitReadsDenied = await Promise.all([
      api().get(BE05_ROUTES.visitById(visit.id)).set(auth(visitManage)),
      api().get(BE05_ROUTES.schedules(visit.id)).set(auth(visitManage)),
      api().get(BE05_ROUTES.visitsByJob(job.id)).set(auth(visitManage)),
    ]);
    for (const denied of visitReadsDenied) {
      assert.equal(denied.status, 403);
      assert.equal((denied.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }
    const visitMutationsDenied = await Promise.all([
      api()
        .post(BE05_ROUTES.createVisit(job.id))
        .set(auth(visitRead))
        .send({
          plannedStartAt: win(1, 9, 10).plannedStartAt.toISOString(),
          plannedEndAt: win(1, 9, 10).plannedEndAt.toISOString(),
        }),
      api()
        .post(BE05_ROUTES.reschedule(visit.id))
        .set(auth(visitRead))
        .send({
          plannedStartAt: win(1, 9, 10).plannedStartAt.toISOString(),
          plannedEndAt: win(1, 9, 10).plannedEndAt.toISOString(),
        }),
      api().post(BE05_ROUTES.cancel(visit.id)).set(auth(visitRead)),
    ]);
    for (const denied of visitMutationsDenied) {
      assert.equal(denied.status, 403);
      assert.equal((denied.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }
  });

  it('gates execution readiness on handyman_service_visit.read', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await makeAssignedJobViaHttp(base);
    const { visit } = await createVisitViaHttp(job.id, win(0, 9, 10));

    // MANAGE token is NOT sufficient — readiness is a READ.
    const manageToken = await createSessionWithPermissions([
      PERMISSIONS.visitManage,
    ]);
    const manageDenied = await api()
      .get(BE05_ROUTES.readiness(visit.id))
      .set(auth(manageToken));
    assert.equal(manageDenied.status, 403);
    assert.equal(
      (manageDenied.body as ErrorBody).error.code,
      'PERMISSION_DENIED',
    );

    // READ token PASSES the RBAC gate (the scoped user then fails the
    // service-authoritative client data scope — proving the gate itself is
    // `handyman_service_visit.read`, not `.manage`).
    const readToken = await createSessionWithPermissions([
      PERMISSIONS.visitRead,
    ]);
    const scopeDenied = await api()
      .get(BE05_ROUTES.readiness(visit.id))
      .set(auth(readToken));
    assert.equal(scopeDenied.status, 403);
    assert.equal(
      (scopeDenied.body as ErrorBody).error.code,
      'BUILDING_ACCESS_DENIED',
    );

    // Admin (read permission + data scope) gets the assessment.
    const allowed = await api()
      .get(BE05_ROUTES.readiness(visit.id))
      .set(auth());
    assert.equal(allowed.status, 200);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Job HTTP surface                                                 */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — job HTTP', () => {
  it('creates a job from an APPROVED request and replays idempotently', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const response = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth())
      .send({ handymanRequestId: base.request.id });
    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.equal(data.created, true);
    assert.deepEqual(Object.keys(data.job).sort(), [
      'clientId',
      'createdAt',
      'createdByUserId',
      'handymanQuotationId',
      'handymanQuotationRevisionId',
      'handymanRequestId',
      'id',
      'updatedAt',
      'workOrderId',
    ]);
    assert.equal(data.job.clientId, base.h.client.id);
    assert.equal(data.job.handymanRequestId, base.request.id);
    assert.equal(data.job.handymanQuotationId, base.quotation.id);
    assert.equal(data.job.handymanQuotationRevisionId, base.revision.id);
    assert.equal(data.job.createdByUserId, adminUserId);

    // The bound Work Order exists and is OPEN (job creation never assigns).
    const wo = await workOrderRow(data.job.workOrderId);
    assert.equal(wo.status, 'OPEN');
    assert.equal(wo.started_at, null);

    // Idempotent replay returns the SAME job with created: false.
    const replay = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth())
      .send({ handymanRequestId: base.request.id });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.created, false);
    assert.equal(replay.body.data.job.id, data.job.id);

    assertNoPii(JSON.stringify(response.body));
  });

  it('rejects protected-field smuggling and malformed ids on job creation', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const smuggled = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth())
      .send({
        handymanRequestId: base.request.id,
        clientId: base.h.client.id,
        workOrderId: randomUUID(),
        workOrderNumber: 'HMWO-SMUGGLED',
        status: 'IN_PROGRESS',
        buildingId: base.h.building.id,
        spaceId: base.h.space.id,
        handymanProviderId: base.provider.id,
        vendorId: base.vendor.id,
        vendorAssignmentId: randomUUID(),
        vendorWorkId: randomUUID(),
        handymanWorkCrewId: base.crew.id,
        createdByUserId: randomUUID(),
        plannedStartAt: win(0, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 9, 10).plannedEndAt.toISOString(),
        unknownKey: 'x',
      });
    assert.equal(smuggled.status, 400);
    assert.equal(
      (smuggled.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );
    const fields = detailFields(smuggled.body as ErrorBody);
    for (const expected of [
      'clientId',
      'workOrderId',
      'workOrderNumber',
      'status',
      'buildingId',
      'spaceId',
      'handymanProviderId',
      'vendorId',
      'vendorAssignmentId',
      'vendorWorkId',
      'handymanWorkCrewId',
      'createdByUserId',
      'plannedStartAt',
      'plannedEndAt',
      'unknownKey',
    ]) {
      assert.ok(fields.includes(expected), `${expected} must be rejected`);
    }

    const malformed = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth())
      .send({ handymanRequestId: 'not-a-uuid' });
    assert.equal(malformed.status, 400);
    assert.equal(
      (malformed.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );

    const missing = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth())
      .send({});
    assert.equal(missing.status, 400);
    assert.ok(
      detailFields(missing.body as ErrorBody).includes('handymanRequestId'),
    );
  });

  it('preserves domain errors across the wire on job creation', async (t) => {
    if (!ready(t)) return;

    // A SENT-but-not-approved request: domain 409, NOT a generic 400.
    const base = await makeJobContext({ approve: false });
    const notApproved = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth())
      .send({ handymanRequestId: base.request.id });
    assert.equal(notApproved.status, 409);
    assert.equal(
      (notApproved.body as ErrorBody).error.code,
      'HANDYMAN_JOB_REQUEST_NOT_APPROVED',
    );

    // Unknown request: domain 404.
    const unknown = await api()
      .post(BE05_ROUTES.createJob)
      .set(auth())
      .send({ handymanRequestId: randomUUID() });
    assert.equal(unknown.status, 404);
    assert.equal(
      (unknown.body as ErrorBody).error.code,
      'HANDYMAN_REQUEST_NOT_FOUND',
    );
  });

  it('lists and gets jobs with the exact query allowlist', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await createJobViaHttp(base);

    const listed = await api()
      .get(`${BE05_ROUTES.listJobs}?clientId=${base.h.client.id}`)
      .set(auth());
    assert.equal(listed.status, 200);
    const jobs = listed.body.data as PublicJob[];
    assert.ok(jobs.some((row) => row.id === job.id));

    // The EXACT domain filters work; unknown query keys are rejected.
    const byWorkOrder = await api()
      .get(
        `${BE05_ROUTES.listJobs}?clientId=${base.h.client.id}&workOrderId=${job.workOrderId}`,
      )
      .set(auth());
    assert.equal(byWorkOrder.status, 200);
    assert.deepEqual(
      (byWorkOrder.body.data as PublicJob[]).map((row) => row.id),
      [job.id],
    );
    const byRequest = await api()
      .get(
        `${BE05_ROUTES.listJobs}?clientId=${base.h.client.id}&handymanRequestId=${base.request.id}`,
      )
      .set(auth());
    assert.equal(byRequest.status, 200);
    assert.equal((byRequest.body.data as PublicJob[]).length, 1);

    const unknownQuery = await api()
      .get(`${BE05_ROUTES.listJobs}?clientId=${base.h.client.id}&foo=bar`)
      .set(auth());
    assert.equal(unknownQuery.status, 400);
    assert.equal(
      (unknownQuery.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );
    assert.ok(detailFields(unknownQuery.body as ErrorBody).includes('foo'));

    const missingScope = await api().get(BE05_ROUTES.listJobs).set(auth());
    assert.equal(missingScope.status, 400);
    assert.ok(
      detailFields(missingScope.body as ErrorBody).includes('clientId'),
    );

    const fetched = await api().get(BE05_ROUTES.jobById(job.id)).set(auth());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.id, job.id);

    const missingJob = await api()
      .get(BE05_ROUTES.jobById(randomUUID()))
      .set(auth());
    assert.equal(missingJob.status, 404);
    assert.equal(
      (missingJob.body as ErrorBody).error.code,
      'HANDYMAN_JOB_NOT_FOUND',
    );

    assertNoPii(JSON.stringify(listed.body));
  });
});

/* ------------------------------------------------------------------ */
/* 3. Assignment HTTP surface                                          */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — assignment HTTP', () => {
  it('composes the first assignment atomically over HTTP', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await createJobViaHttp(base);
    const response = await api()
      .post(BE05_ROUTES.assign(job.id))
      .set(auth())
      .send({
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      });
    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.deepEqual(Object.keys(data).sort(), [
      'assignment',
      'job',
      'vendorAssignmentId',
      'vendorWorkId',
      'workOrderStatus',
    ]);
    assert.equal(data.assignment.status, 'ACTIVE');
    assert.equal(data.assignment.handymanWorkCrewId, base.crew.id);
    assert.equal(data.workOrderStatus, 'ASSIGNED');

    // The composed BE-15B vendor work exists and is NOT_STARTED (no
    // execution transition is exposed through Handyman routes).
    const vw = await vendorWorkRow(data.vendorAssignmentId);
    assert.equal(vw.id, data.vendorWorkId);
    assert.equal(vw.status, 'NOT_STARTED');
    assert.equal(vw.started_at, null);
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');

    const history = await api()
      .get(BE05_ROUTES.assignments(job.id))
      .set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 1);
    assert.deepEqual(Object.keys(history.body.data[0]).sort(), [
      'assignedAt',
      'assignedByUserId',
      'clientId',
      'createdAt',
      'handymanJobId',
      'handymanWorkCrewId',
      'id',
      'status',
      'supersededAt',
      'supersededByUserId',
      'updatedAt',
      'vendorAssignmentId',
    ]);

    assertNoPii(JSON.stringify(response.body));
    assertNoPii(JSON.stringify(history.body));
  });

  it('rejects protected fields on assignment and reassignment bodies', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await createJobViaHttp(base);
    const smuggled = await api()
      .post(BE05_ROUTES.assign(job.id))
      .set(auth())
      .send({
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
        vendorId: base.vendor.id,
        vendorAssignmentId: randomUUID(),
        vendorWorkId: randomUUID(),
        clientId: base.h.client.id,
        workOrderId: job.workOrderId,
        status: 'SUPERSEDED',
        assignedByUserId: randomUUID(),
        supersededByUserId: randomUUID(),
        assignedAt: new Date().toISOString(),
        effectiveFrom: new Date().toISOString(),
        unknownKey: 'x',
      });
    assert.equal(smuggled.status, 400);
    assert.equal(
      (smuggled.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );
    const fields = detailFields(smuggled.body as ErrorBody);
    for (const expected of [
      'vendorId',
      'vendorAssignmentId',
      'vendorWorkId',
      'clientId',
      'workOrderId',
      'status',
      'assignedByUserId',
      'supersededByUserId',
      'assignedAt',
      'effectiveFrom',
      'unknownKey',
    ]) {
      assert.ok(fields.includes(expected), `${expected} must be rejected`);
    }

    // The reassignment route enforces the IDENTICAL allowlist.
    const reassignSmuggled = await api()
      .post(BE05_ROUTES.reassign(job.id))
      .set(auth())
      .send({
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
        vendorId: base.vendor.id,
      });
    assert.equal(reassignSmuggled.status, 400);
    assert.ok(
      detailFields(reassignSmuggled.body as ErrorBody).includes('vendorId'),
    );

    // The composition itself never happened (job still unassigned).
    const history = await api()
      .get(BE05_ROUTES.assignments(job.id))
      .set(auth());
    assert.equal(history.body.data.length, 0);
  });

  it('reassigns pre-execution over HTTP and preserves append-only history', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJobViaHttp(base);
    const second = await addEligibleProvider(base, 'Reassign');

    const response = await api()
      .post(BE05_ROUTES.reassign(job.id))
      .set(auth())
      .send({
        handymanProviderId: second.provider.id,
        handymanWorkCrewId: second.crew.id,
      });
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.assignment.status, 'ACTIVE');
    assert.equal(data.assignment.handymanWorkCrewId, second.crew.id);
    assert.notEqual(data.assignment.id, assignment.assignment.id);
    assert.equal(data.workOrderStatus, 'ASSIGNED');

    const history = await api()
      .get(BE05_ROUTES.assignments(job.id))
      .set(auth());
    assert.equal(history.status, 200);
    const rows = history.body.data as {
      id: string;
      status: string;
      supersededAt: string | null;
      supersededByUserId: string | null;
      handymanWorkCrewId: string;
    }[];
    assert.equal(rows.length, 2);
    // Newest first: ACTIVE replacement, then the SUPERSEDED original with
    // full attribution — history is never deleted or mutated away.
    assert.equal(rows[0].id, data.assignment.id);
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(rows[1].id, assignment.assignment.id);
    assert.equal(rows[1].status, 'SUPERSEDED');
    assert.equal(rows[1].handymanWorkCrewId, base.crew.id);
    assert.ok(rows[1].supersededAt);
    assert.equal(rows[1].supersededByUserId, adminUserId);
  });

  it('preserves domain assignment errors across the wire', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();

    // Reassignment without an ACTIVE composition: domain 409.
    const { job } = await createJobViaHttp(base);
    const notAssigned = await api()
      .post(BE05_ROUTES.reassign(job.id))
      .set(auth())
      .send({
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      });
    assert.equal(notAssigned.status, 409);
    assert.equal(
      (notAssigned.body as ErrorBody).error.code,
      'HANDYMAN_JOB_NOT_ASSIGNED',
    );

    // Crew of a DIFFERENT provider: the Run-1 domain code survives the wire
    // (not translated into a generic 400 VALIDATION_ERROR).
    const second = await addEligibleProvider(base, 'Mismatch');
    const mismatch = await api()
      .post(BE05_ROUTES.assign(job.id))
      .set(auth())
      .send({
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: second.crew.id,
      });
    assert.equal(mismatch.status, 400);
    assert.equal(
      (mismatch.body as ErrorBody).error.code,
      'HANDYMAN_JOB_CREW_PROVIDER_MISMATCH',
    );

    // Unknown job: domain 404 on the assignment route.
    const unknownJob = await api()
      .post(BE05_ROUTES.assign(randomUUID()))
      .set(auth())
      .send({
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      });
    assert.equal(unknownJob.status, 404);
    assert.equal(
      (unknownJob.body as ErrorBody).error.code,
      'HANDYMAN_JOB_NOT_FOUND',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. Visit + schedule HTTP surface                                    */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — visit and schedule HTTP', () => {
  it('creates visits (multiple per job) and reads them back', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await makeAssignedJobViaHttp(base);

    const first = await api()
      .post(BE05_ROUTES.createVisit(job.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 9, 10).plannedEndAt.toISOString(),
      });
    assert.equal(first.status, 201);
    assert.deepEqual(Object.keys(first.body.data).sort(), [
      'schedule',
      'visit',
    ]);
    assert.deepEqual(Object.keys(first.body.data.visit).sort(), [
      'clientId',
      'createdAt',
      'createdByUserId',
      'handymanJobId',
      'id',
      'updatedAt',
      'visitSequence',
    ]);
    assert.equal(first.body.data.visit.visitSequence, 1);
    assert.equal(first.body.data.visit.handymanJobId, job.id);
    assert.equal(first.body.data.schedule.status, 'ACTIVE');
    assert.equal(
      first.body.data.schedule.plannedStartAt,
      win(0, 9, 10).plannedStartAt.toISOString(),
    );

    // A SECOND visit on the same job: sequences are server-generated.
    const second = await createVisitViaHttp(job.id, win(1, 9, 10));
    assert.equal(second.visit.visitSequence, 2);

    const byJob = await api().get(BE05_ROUTES.visitsByJob(job.id)).set(auth());
    assert.equal(byJob.status, 200);
    const views = byJob.body.data as {
      visit: { id: string; visitSequence: number };
      activeSchedule: { id: string; status: string } | null;
    }[];
    assert.equal(views.length, 2);
    assert.deepEqual(
      views.map((view) => view.visit.visitSequence),
      [1, 2],
    );
    assert.ok(views.every((view) => view.activeSchedule?.status === 'ACTIVE'));

    const byId = await api()
      .get(BE05_ROUTES.visitById(first.body.data.visit.id))
      .set(auth());
    assert.equal(byId.status, 200);
    assert.equal(byId.body.data.visit.id, first.body.data.visit.id);
    assert.equal(byId.body.data.activeSchedule.id, first.body.data.schedule.id);

    const unknownVisit = await api()
      .get(BE05_ROUTES.visitById(randomUUID()))
      .set(auth());
    assert.equal(unknownVisit.status, 404);
    assert.equal(
      (unknownVisit.body as ErrorBody).error.code,
      'HANDYMAN_SERVICE_VISIT_NOT_FOUND',
    );

    assertNoPii(JSON.stringify(byJob.body));
  });

  it('rejects invalid windows and body smuggling on visit creation', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await makeAssignedJobViaHttp(base);

    // end <= start is DOMAIN-owned: 400 with the domain code, not the
    // transport VALIDATION_ERROR.
    const inverted = await api()
      .post(BE05_ROUTES.createVisit(job.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 10, 11).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 9, 10).plannedEndAt.toISOString(),
      });
    assert.equal(inverted.status, 400);
    assert.equal(
      (inverted.body as ErrorBody).error.code,
      'HANDYMAN_SERVICE_VISIT_WINDOW_INVALID',
    );

    // Malformed timestamp SHAPE is transport-owned.
    const malformed = await api()
      .post(BE05_ROUTES.createVisit(job.id))
      .set(auth())
      .send({ plannedStartAt: 'not-a-date', plannedEndAt: 'also-bad' });
    assert.equal(malformed.status, 400);
    assert.equal(
      (malformed.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );
    assert.deepEqual(
      detailFields(malformed.body as ErrorBody).sort(),
      ['plannedEndAt', 'plannedStartAt'],
    );

    // Server-authoritative and out-of-scope execution fields are rejected.
    const smuggled = await api()
      .post(BE05_ROUTES.createVisit(job.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 9, 10).plannedEndAt.toISOString(),
        clientId: base.h.client.id,
        handymanJobId: randomUUID(),
        visitSequence: 99,
        status: 'CANCELLED',
        createdByUserId: randomUUID(),
        arrivalAt: win(0, 9, 10).plannedStartAt.toISOString(),
        checkedInAt: win(0, 9, 10).plannedStartAt.toISOString(),
        gps: '0,0',
        qrCode: 'QR123',
        workSessionId: randomUUID(),
        permitRequirementType: 'HOT_WORK',
        unknownKey: 'x',
      });
    assert.equal(smuggled.status, 400);
    assert.equal(
      (smuggled.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );
    const fields = detailFields(smuggled.body as ErrorBody);
    for (const expected of [
      'clientId',
      'handymanJobId',
      'visitSequence',
      'status',
      'createdByUserId',
      'arrivalAt',
      'checkedInAt',
      'gps',
      'qrCode',
      'workSessionId',
      'permitRequirementType',
      'unknownKey',
    ]) {
      assert.ok(fields.includes(expected), `${expected} must be rejected`);
    }

    // Unassigned job: domain 409 (scheduling requires an ACTIVE composition;
    // the Run-2 owning code is HANDYMAN_JOB_NOT_ASSIGNED — the NOT_SCHEDULABLE
    // code owns the cancelled-window / non-pre-execution states instead).
    const unassignedBase = await makeJobContext();
    const unassigned = await createJobViaHttp(unassignedBase);
    const notAssigned = await api()
      .post(BE05_ROUTES.createVisit(unassigned.job.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 9, 10).plannedEndAt.toISOString(),
      });
    assert.equal(notAssigned.status, 409);
    assert.equal(
      (notAssigned.body as ErrorBody).error.code,
      'HANDYMAN_JOB_NOT_ASSIGNED',
    );
  });

  it('reschedules over HTTP: supersede + new ACTIVE window, history intact', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await makeAssignedJobViaHttp(base);
    const { visit, schedule } = await createVisitViaHttp(job.id, win(0, 9, 10));

    const response = await api()
      .post(BE05_ROUTES.reschedule(visit.id))
      .set(auth())
      .send({
        plannedStartAt: win(1, 13, 15).plannedStartAt.toISOString(),
        plannedEndAt: win(1, 13, 15).plannedEndAt.toISOString(),
      });
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.deepEqual(Object.keys(data).sort(), [
      'schedule',
      'supersededScheduleId',
      'visit',
    ]);
    assert.equal(data.supersededScheduleId, schedule.id);
    assert.equal(data.schedule.status, 'ACTIVE');
    assert.notEqual(data.schedule.id, schedule.id);
    assert.equal(
      data.schedule.plannedStartAt,
      win(1, 13, 15).plannedStartAt.toISOString(),
    );

    // History read: oldest first — the SUPERSEDED window keeps its ORIGINAL
    // planned timestamps byte-intact, with closure attribution.
    const history = await api().get(BE05_ROUTES.schedules(visit.id)).set(auth());
    assert.equal(history.status, 200);
    const rows = history.body.data as {
      id: string;
      status: string;
      plannedStartAt: string;
      plannedEndAt: string;
      supersededAt: string | null;
      supersededByUserId: string | null;
    }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, schedule.id);
    assert.equal(rows[0].status, 'SUPERSEDED');
    assert.equal(rows[0].plannedStartAt, win(0, 9, 10).plannedStartAt.toISOString());
    assert.equal(rows[0].plannedEndAt, win(0, 9, 10).plannedEndAt.toISOString());
    assert.ok(rows[0].supersededAt);
    assert.equal(rows[0].supersededByUserId, adminUserId);
    assert.equal(rows[1].id, data.schedule.id);
    assert.equal(rows[1].status, 'ACTIVE');

    // Reschedule revalidates at time of use: smuggling is still rejected.
    const smuggled = await api()
      .post(BE05_ROUTES.reschedule(visit.id))
      .set(auth())
      .send({
        plannedStartAt: win(2, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(2, 9, 10).plannedEndAt.toISOString(),
        supersededScheduleId: schedule.id,
        visitId: visit.id,
      });
    assert.equal(smuggled.status, 400);
    assert.equal(
      (smuggled.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );

    assertNoPii(JSON.stringify(history.body));
  });

  it('cancels over HTTP: guarded, idempotent, history preserved', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job } = await makeAssignedJobViaHttp(base);
    const { visit, schedule } = await createVisitViaHttp(job.id, win(0, 9, 10));

    const cancelled = await api()
      .post(BE05_ROUTES.cancel(visit.id))
      .set(auth());
    assert.equal(cancelled.status, 200);
    assert.deepEqual(Object.keys(cancelled.body.data).sort(), [
      'alreadyCancelled',
      'cancelledScheduleId',
      'visit',
    ]);
    assert.equal(cancelled.body.data.cancelledScheduleId, schedule.id);
    assert.equal(cancelled.body.data.alreadyCancelled, false);

    // Idempotent replay: no duplicate closure.
    const replay = await api()
      .post(BE05_ROUTES.cancel(visit.id))
      .set(auth());
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.alreadyCancelled, true);
    assert.equal(replay.body.data.cancelledScheduleId, schedule.id);

    const history = await api().get(BE05_ROUTES.schedules(visit.id)).set(auth());
    const rows = history.body.data as {
      id: string;
      status: string;
      cancelledAt: string | null;
      cancelledByUserId: string | null;
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'CANCELLED');
    assert.ok(rows[0].cancelledAt);
    assert.equal(rows[0].cancelledByUserId, adminUserId);

    // The visit view shows no ACTIVE window; reschedule is not schedulable.
    const view = await api().get(BE05_ROUTES.visitById(visit.id)).set(auth());
    assert.equal(view.status, 200);
    assert.equal(view.body.data.activeSchedule, null);
    const afterCancel = await api()
      .post(BE05_ROUTES.reschedule(visit.id))
      .set(auth())
      .send({
        plannedStartAt: win(1, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(1, 9, 10).plannedEndAt.toISOString(),
      });
    assert.equal(afterCancel.status, 409);
    assert.equal(
      (afterCancel.body as ErrorBody).error.code,
      'HANDYMAN_SERVICE_VISIT_NOT_SCHEDULABLE',
    );

    // The cancel command accepts NO business body.
    const smuggled = await api()
      .post(BE05_ROUTES.cancel(visit.id))
      .set(auth())
      .send({ reason: 'customer asked' });
    assert.equal(smuggled.status, 400);
    assert.equal(
      (smuggled.body as ErrorBody).error.code,
      'VALIDATION_ERROR',
    );
    assert.ok(detailFields(smuggled.body as ErrorBody).includes('reason'));
  });
});

/* ------------------------------------------------------------------ */
/* 5. Temporal conflict protection over the wire                       */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — temporal conflicts over HTTP', () => {
  it('preserves the crew conflict as a domain 409; back-to-back allowed', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJobViaHttp(base);

    // A SECOND assigned job on the SAME crew (service-level fixture: the
    // reassignment/second-job chain is Run-1 authority, exercised there).
    const request2 = await approveSecondRequest(base);
    const { job: job2 } = await createJobViaHttp(base, request2.id);
    await assignViaHttp(job2.id, base.provider.id, base.crew.id);

    await createVisitViaHttp(job1.id, win(0, 9, 10));

    // Overlapping window on the same crew, different job → domain 409 code
    // survives the wire untouched.
    const overlap = await api()
      .post(BE05_ROUTES.createVisit(job2.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 9, 10).plannedEndAt.toISOString(),
      });
    assert.equal(overlap.status, 409);
    assert.equal(
      (overlap.body as ErrorBody).error.code,
      'HANDYMAN_SERVICE_VISIT_CREW_CONFLICT',
    );

    // Back-to-back (half-open [start,end)) → allowed.
    const backToBack = await api()
      .post(BE05_ROUTES.createVisit(job2.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 10, 11).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 10, 11).plannedEndAt.toISOString(),
      });
    assert.equal(backToBack.status, 201);
    assert.equal(backToBack.body.data.visit.visitSequence, 1);
  });

  it('preserves the shared-worker conflict as a domain 409', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job: job1 } = await makeAssignedJobViaHttp(base);

    // A second crew under the SAME provider founded by the SAME lead worker
    // (cross-crew membership stays legal — Run-1 proof) and a second job.
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
    const request2 = await approveSecondRequest(base);
    const { job: job2 } = await createJobViaHttp(base, request2.id);
    await assignViaHttp(job2.id, base.provider.id, crew2.id);

    await createVisitViaHttp(job1.id, win(0, 9, 10));

    // Overlap: crews differ but the shared worker is double-booked →
    // WORKER conflict (temporal, not membership-global).
    const overlap = await api()
      .post(BE05_ROUTES.createVisit(job2.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 9, 10).plannedEndAt.toISOString(),
      });
    assert.equal(overlap.status, 409);
    assert.equal(
      (overlap.body as ErrorBody).error.code,
      'HANDYMAN_SERVICE_VISIT_WORKER_CONFLICT',
    );

    // Disjoint window for the SAME shared worker → allowed.
    const disjoint = await api()
      .post(BE05_ROUTES.createVisit(job2.id))
      .set(auth())
      .send({
        plannedStartAt: win(0, 10, 11).plannedStartAt.toISOString(),
        plannedEndAt: win(0, 10, 11).plannedEndAt.toISOString(),
      });
    assert.equal(disjoint.status, 201);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Execution readiness over the wire                                */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — execution readiness HTTP', () => {
  it('returns the factorized assessment as a pure read (zero side effects)', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJobViaHttp(base);
    const { visit } = await createVisitViaHttp(job.id, win(0, 9, 10));

    const eventsBefore = (await eventsFor(assignment.vendorWorkId)).length;
    const response = await api()
      .get(BE05_ROUTES.readiness(visit.id))
      .set(auth());
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.deepEqual(Object.keys(data).sort(), [
      'activeSchedule',
      'checks',
      'handymanJobId',
      'handymanServiceVisitId',
      'permitReadiness',
      'ready',
      'vendorWorkId',
      'workOrderId',
    ]);
    assert.equal(data.ready, true);
    assert.equal(data.handymanServiceVisitId, visit.id);
    assert.equal(data.handymanJobId, job.id);
    assert.equal(data.workOrderId, job.workOrderId);
    assert.equal(data.vendorWorkId, assignment.vendorWorkId);
    assert.deepEqual(data.checks, {
      hasActiveSchedule: true,
      workOrderPreExecution: true,
      hasActiveJobAssignment: true,
      providerChainValid: true,
      crewChainValid: true,
      noScheduleConflict: true,
      permitsReady: true,
    });
    assert.equal(data.activeSchedule.status, 'ACTIVE');

    // Zero permit-readiness rows → the EXISTING BE-15D zero-row semantics.
    assert.equal(data.permitReadiness.readinessStatus, 'NOT_REQUIRED');
    assert.equal(data.permitReadiness.ready, true);
    assert.deepEqual(data.permitReadiness.permits, []);
    assert.equal(data.permitReadiness.vendorWorkId, assignment.vendorWorkId);

    // PURE read: no execution transition, no event side effect.
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');
    assert.equal(wo.started_at, null);
    const vw = await vendorWorkRow(assignment.vendorAssignmentId);
    assert.equal(vw.status, 'NOT_STARTED');
    assert.equal(vw.started_at, null);
    assert.equal(
      (await eventsFor(assignment.vendorWorkId)).length,
      eventsBefore,
    );

    assertNoPii(JSON.stringify(response.body));
  });

  it('passes BE-15D permit gates through unchanged (NOT_READY blocks, READY allows)', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJobViaHttp(base);
    const { visit } = await createVisitViaHttp(job.id, win(0, 9, 10));

    // A PENDING permit row → NOT_READY → not execution-ready.
    const permitRow = await createWorkPermitReadiness(
      {
        vendorWorkId: assignment.vendorWorkId,
        permitRequirementType: 'HOT_WORK',
        permitStatus: 'PENDING',
        createdByUserId: adminUserId,
      },
      adminUserId,
    );
    const blocked = await api()
      .get(BE05_ROUTES.readiness(visit.id))
      .set(auth());
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.data.ready, false);
    assert.equal(blocked.body.data.checks.permitsReady, false);
    assert.equal(
      blocked.body.data.permitReadiness.readinessStatus,
      'NOT_READY',
    );
    assert.equal(blocked.body.data.permitReadiness.permits.length, 1);

    // Flip the SAME row to a valid ISSUED permit through the BE-15D service
    // (its lifecycle authority — never through Handyman) → READY overall.
    await updateWorkPermitReadiness(
      permitRow.id,
      {
        permitStatus: 'ISSUED',
        validFrom: new Date(Date.now() - 86_400_000),
        validUntil: new Date(Date.now() + 86_400_000),
      },
      adminUserId,
    );
    const allowed = await api()
      .get(BE05_ROUTES.readiness(visit.id))
      .set(auth());
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data.ready, true);
    assert.equal(allowed.body.data.checks.permitsReady, true);
    assert.equal(allowed.body.data.permitReadiness.readinessStatus, 'READY');

    // Still a pure read: nothing transitioned.
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');
    const vw = await vendorWorkRow(assignment.vendorAssignmentId);
    assert.equal(vw.status, 'NOT_STARTED');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Privacy across every read model                                  */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — response privacy', () => {
  it('enriches no read model with customer or worker PII', async (t) => {
    if (!ready(t)) return;

    const base = await makeJobContext();
    const { job, assignment } = await makeAssignedJobViaHttp(base);
    const { visit } = await createVisitViaHttp(job.id, win(0, 9, 10));
    await api()
      .post(BE05_ROUTES.reschedule(visit.id))
      .set(auth())
      .send({
        plannedStartAt: win(1, 9, 10).plannedStartAt.toISOString(),
        plannedEndAt: win(1, 9, 10).plannedEndAt.toISOString(),
      });

    const responses = await Promise.all([
      api().get(BE05_ROUTES.jobById(job.id)).set(auth()),
      api().get(`${BE05_ROUTES.listJobs}?clientId=${base.h.client.id}`).set(auth()),
      api().get(BE05_ROUTES.assignments(job.id)).set(auth()),
      api().get(BE05_ROUTES.visitsByJob(job.id)).set(auth()),
      api().get(BE05_ROUTES.visitById(visit.id)).set(auth()),
      api().get(BE05_ROUTES.schedules(visit.id)).set(auth()),
      api().get(BE05_ROUTES.readiness(visit.id)).set(auth()),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assertNoPii(JSON.stringify(response.body));
    }

    // No convenience joins: forbidden PII keys never appear anywhere.
    const serialized = JSON.stringify(
      responses.map((response) => response.body),
    );
    for (const forbidden of [
      'customerName',
      'customerPhone',
      'customerEmail',
      'fullName',
      'vendorPersonnelCode',
      'employeeCode',
      'phone',
      'email',
      'password',
      'token',
      'sessionToken',
    ]) {
      assert.ok(
        !serialized.includes(`"${forbidden}"`),
        `${forbidden} must never appear in BE-05 responses`,
      );
    }
    assert.ok(assignment.vendorWorkId);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Runtime ↔ OpenAPI parity                                         */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 3 — runtime/OpenAPI parity', () => {
  const BE05_TAGS = ['Handyman Jobs', 'Handyman Service Visits'];

  type Spec = {
    paths: Record<
      string,
      Record<
        string,
        {
          'x-required-permission'?: string;
          tags?: string[];
          operationId?: string;
          security?: unknown[];
        }
      >
    >;
    components: {
      schemas: Record<string, { properties?: Record<string, unknown> }>;
    };
  };

  function loadSpec(): Spec {
    return parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as Spec;
  }

  function runtimeOperations(): Record<string, Set<string>> {
    const operations: Record<string, Set<string>> = {};
    for (const file of [
      '../src/modules/handyman-jobs/handyman-job.routes.ts',
      '../src/modules/handyman-jobs/handyman-service-visit.routes.ts',
    ]) {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      for (const match of source.matchAll(
        /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g,
      )) {
        const method = match[1];
        const path = match[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        (operations[path] ??= new Set()).add(method);
      }
    }
    return operations;
  }

  it('documents exactly the BE-05 runtime operation set with permission parity', async (t) => {
    if (!ready(t)) return;

    const spec = loadSpec();
    const runtime = runtimeOperations();

    const documented: Record<string, Set<string>> = {};
    for (const [path, item] of Object.entries(spec.paths)) {
      const methods = Object.keys(item).filter((method) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      );
      const be05 = methods.filter((method) =>
        (item[method].tags ?? []).some((tag) => BE05_TAGS.includes(tag)),
      );
      if (be05.length > 0) {
        assert.equal(
          be05.length,
          methods.length,
          `${path} mixes BE-05 and non-BE-05 operations`,
        );
        documented[path] = new Set(be05);
      }
    }

    // Exact set parity in BOTH directions.
    assert.deepEqual(
      Object.keys(documented).sort(),
      Object.keys(runtime).sort(),
      'documented BE-05 paths must equal the runtime BE-05 paths',
    );
    for (const path of Object.keys(runtime)) {
      assert.deepEqual(
        [...(documented[path] ?? [])].sort(),
        [...runtime[path]].sort(),
        `${path} operations must match exactly`,
      );
    }
    let operationCount = 0;
    for (const methods of Object.values(runtime)) operationCount += methods.size;
    assert.equal(operationCount, 13);

    // x-required-permission parity (the exact §6 mapping) + bearerAuth.
    const expectedPermissions: Record<string, Record<string, string>> = {
      '/handyman-jobs': {
        post: 'handyman_job.manage',
        get: 'handyman_job.read',
      },
      '/handyman-jobs/{jobId}': { get: 'handyman_job.read' },
      '/handyman-jobs/{jobId}/assignment': {
        post: 'handyman_job_assignment.manage',
      },
      '/handyman-jobs/{jobId}/assignment/reassign': {
        post: 'handyman_job_assignment.manage',
      },
      '/handyman-jobs/{jobId}/assignments': {
        get: 'handyman_job_assignment.read',
      },
      '/handyman-jobs/{jobId}/visits': {
        post: 'handyman_service_visit.manage',
        get: 'handyman_service_visit.read',
      },
      '/handyman-service-visits/{visitId}': {
        get: 'handyman_service_visit.read',
      },
      '/handyman-service-visits/{visitId}/schedules': {
        get: 'handyman_service_visit.read',
      },
      '/handyman-service-visits/{visitId}/reschedule': {
        post: 'handyman_service_visit.manage',
      },
      '/handyman-service-visits/{visitId}/cancel': {
        post: 'handyman_service_visit.manage',
      },
      '/handyman-service-visits/{visitId}/execution-readiness': {
        get: 'handyman_service_visit.read',
      },
    };
    assert.deepEqual(
      Object.keys(expectedPermissions).sort(),
      Object.keys(documented).sort(),
    );
    for (const [path, operations] of Object.entries(expectedPermissions)) {
      for (const [method, permission] of Object.entries(operations)) {
        const operation = spec.paths[path][method];
        assert.ok(operation, `${method.toUpperCase()} ${path} must be documented`);
        assert.equal(
          operation['x-required-permission'],
          permission,
          `${method.toUpperCase()} ${path} permission`,
        );
        assert.deepEqual(
          operation.security,
          [{ bearerAuth: [] }],
          `${method.toUpperCase()} ${path} must require bearer authentication`,
        );
      }
    }

    // The runtime route sources wire EXACTLY the six BE-05 permission codes.
    const jobRoutes = readFileSync(
      resolve(__dirname, '../src/modules/handyman-jobs/handyman-job.routes.ts'),
      'utf8',
    );
    const visitRoutes = readFileSync(
      resolve(
        __dirname,
        '../src/modules/handyman-jobs/handyman-service-visit.routes.ts',
      ),
      'utf8',
    );
    const jobWired = (
      jobRoutes.match(/requirePermission\('([^']+)'\)/g) ?? []
    ).map((call) => call.slice("requirePermission('".length, -2));
    const visitWired = (
      visitRoutes.match(/requirePermission\('([^']+)'\)/g) ?? []
    ).map((call) => call.slice("requirePermission('".length, -2));
    const wired = [...jobWired, ...visitWired];
    // EXACTLY the six BE-05 codes — no other permission may be wired.
    assert.deepEqual([...new Set(wired)].sort(), [
      'handyman_job.manage',
      'handyman_job.read',
      'handyman_job_assignment.manage',
      'handyman_job_assignment.read',
      'handyman_service_visit.manage',
      'handyman_service_visit.read',
    ]);
    // One gate per operation: job router 4 literal call sites (2 shared
    // consts each used twice), visit router 2 consts (3 + 4 uses).
    assert.equal(jobWired.length, 4, 'job routes wire exactly 4 gates');
    assert.equal(visitWired.length, 2, 'visit routes wire exactly 2 gates');

    // No DELETE, no PUT/PATCH anywhere on BE-05 paths (runtime + spec), and
    // the schedule-history path is GET-only (no schedule-row CRUD).
    for (const [path, methods] of Object.entries(runtime)) {
      for (const forbidden of ['delete', 'put', 'patch']) {
        assert.ok(
          !methods.has(forbidden),
          `${forbidden.toUpperCase()} ${path} must not exist at runtime`,
        );
      }
    }
    for (const [path, item] of Object.entries(spec.paths)) {
      if (path.includes('handyman-jobs') || path.includes('handyman-service-visits')) {
        assert.equal(item.delete, undefined, `${path} must not document DELETE`);
        assert.equal(item.put, undefined, `${path} must not document PUT`);
        assert.equal(item.patch, undefined, `${path} must not document PATCH`);
      }
    }
    assert.deepEqual(
      [...(runtime['/handyman-service-visits/{visitId}/schedules'] ?? [])],
      ['get'],
    );

    // No arrival / check-in / session / execution-start style routes exist.
    for (const path of Object.keys(spec.paths)) {
      if (!path.includes('handyman')) continue;
      for (const forbidden of [
        'arrival',
        'check-in',
        'checkin',
        'session',
        'attendance',
        'geofence',
        'gps',
        'qr',
        'material',
        'bast',
        'invoice',
      ]) {
        assert.ok(
          !path.toLowerCase().includes(forbidden),
          `forbidden surface ${forbidden} in ${path}`,
        );
      }
    }
    for (const source of [jobRoutes, visitRoutes]) {
      assert.ok(!/router\.delete\(/.test(source), 'no DELETE route');
      assert.ok(
        !/work-orders\/[^']*\//.test(source),
        'no Work Order lifecycle mutation through Handyman routes',
      );
    }
  });

  it('documents strict body allowlists and privacy-safe read models', async (t) => {
    if (!ready(t)) return;

    const spec = loadSpec();
    const schemas = spec.components.schemas;

    const expectedBodyKeys: Record<string, string[]> = {
      CreateHandymanJob: ['handymanRequestId'],
      AssignHandymanJob: ['handymanProviderId', 'handymanWorkCrewId'],
      CreateHandymanServiceVisit: ['plannedEndAt', 'plannedStartAt'],
      RescheduleHandymanServiceVisit: ['plannedEndAt', 'plannedStartAt'],
      HandymanJobCreationResult: ['created', 'job'],
      HandymanJobAssignmentResult: [
        'assignment',
        'job',
        'vendorAssignmentId',
        'vendorWorkId',
        'workOrderStatus',
      ],
      HandymanServiceVisitCreationResult: ['schedule', 'visit'],
      HandymanServiceVisitRescheduleResult: [
        'schedule',
        'supersededScheduleId',
        'visit',
      ],
      HandymanServiceVisitCancellationResult: [
        'alreadyCancelled',
        'cancelledScheduleId',
        'visit',
      ],
      HandymanServiceVisitView: ['activeSchedule', 'visit'],
      HandymanServiceVisitExecutionReadiness: [
        'activeSchedule',
        'checks',
        'handymanJobId',
        'handymanServiceVisitId',
        'permitReadiness',
        'ready',
        'vendorWorkId',
        'workOrderId',
      ],
      HandymanServiceVisitExecutionReadinessChecks: [
        'crewChainValid',
        'hasActiveJobAssignment',
        'hasActiveSchedule',
        'noScheduleConflict',
        'permitsReady',
        'providerChainValid',
        'workOrderPreExecution',
      ],
    };
    for (const [name, keys] of Object.entries(expectedBodyKeys)) {
      assert.ok(schemas[name], `schema ${name} must be documented`);
      assert.deepEqual(
        Object.keys(schemas[name].properties ?? {}).sort(),
        keys,
        `${name} must document exactly the wire allowlist`,
      );
    }

    // Read models expose operational facts only — no customer/worker contact
    // data, credentials, personnel codes or raw event metadata.
    for (const name of [
      'HandymanJob',
      'HandymanJobAssignment',
      'HandymanServiceVisit',
      'HandymanServiceVisitSchedule',
    ]) {
      const keys = Object.keys(schemas[name].properties ?? {});
      for (const forbidden of [
        'customerName',
        'customerPhone',
        'customerEmail',
        'fullName',
        'workerName',
        'phone',
        'email',
        'employeeCode',
        'vendorPersonnelCode',
        'password',
        'token',
        'metadata',
        'notes',
      ]) {
        assert.ok(
          !keys.includes(forbidden),
          `${forbidden} must never be documented on ${name}`,
        );
      }
    }

    // The job read model deliberately has NO lifecycle status (the Work
    // Order owns it), and the schedule model has NO arrival/execution facts.
    assert.ok(
      !Object.keys(schemas.HandymanJob.properties ?? {}).includes('status'),
      'HandymanJob must not document an independent lifecycle status',
    );
    for (const forbidden of ['arrivalAt', 'checkedInAt', 'startedAt', 'gps', 'qrCode']) {
      assert.ok(
        !Object.keys(schemas.HandymanServiceVisitSchedule.properties ?? {}).includes(
          forbidden,
        ),
        `${forbidden} must never be documented on the schedule model`,
      );
    }
  });
});
