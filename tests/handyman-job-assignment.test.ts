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
  createHandymanJob,
  assignHandymanJobProviderAndCrew,
  getHandymanJobById,
  listHandymanJobAssignments,
  listHandymanJobs,
  reassignHandymanJobProviderAndCrew,
} from '../src/modules/handyman-jobs';
import {
  selectHandymanRequestService,
  triageHandymanRequest,
} from '../src/modules/handyman-request-governance';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  decideHandymanQuotationApprovalInApp,
  sendHandymanQuotation,
  submitHandymanQuotationRevision,
} from '../src/modules/handyman-quotations';
import { createHandymanRequest } from '../src/modules/handyman-requests';
import {
  createHandymanWorkCrew,
  listHandymanWorkCrewMembers,
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
import { vendorWorkService } from '../src/modules/vendor-work';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { transitionWorkOrderStatus } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-05 RUN 1 — focused service-level suite for the Handyman execution
 * binding + the ONE governed provider/crew assignment composition.
 *
 * Fixtures consume the EXISTING foundations end to end (the CR-HM-BE-03
 * approval chain + the CR-HM-BE-04 crew chain + BE-02/BE-06D/BE-06E provider
 * eligibility): hierarchy → tenant → request → triage → selection →
 * quotation → priced revision → send → APPROVED decision → job → work order
 * → vendor assignment + vendor work + crew composition.
 *
 * Proven here (CR-HM-BE-05 §15): business-identity idempotency and
 * concurrency of job creation, exact approved-revision binding (stale
 * revisions rejected), work-order building identity with NO synthesized
 * asset/functional location, full time-of-use provider/vendor/relationship/
 * capability/crew/lead/worker validation, all-or-nothing composition (never
 * an orphan vendor assignment without its crew binding), BE-15B resolution
 * at NOT_STARTED without lifecycle advancement, the guarded OPEN→ASSIGNED
 * seam, exactly-one-ACTIVE composition, pre-execution-only reassignment with
 * preserved append-only history, and — explicitly — that a worker holding an
 * ACTIVE membership in ANOTHER crew is NOT rejected in Run 1 (no temporal
 * conflict model; carried to Run 2).
 */

const PORT = 55502;
const DIR = '/tmp/asentra-hm05-run1-pg';
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
const CUSTOMER_PHONE = '+6281298765002';
const CUSTOMER_EMAIL = 'rina05@customer.example.com';

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
    `TRUNCATE handyman_job_assignments, handyman_jobs, vendor_works,
      vendor_assignments, work_orders, handyman_work_crew_members,
      handyman_work_crews, vendor_capabilities, vendor_building_relationships,
      handyman_quotation_approval_links, handyman_quotation_approvals,
      handyman_quotation_lines, handyman_quotation_revisions,
      handyman_quotations, handyman_request_triages, handyman_request_services,
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
    email: `outsider05-${suffix().toLowerCase()}@example.com`,
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
/* Fixtures — the full governed chain, consumed through real services   */
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

/**
 * Handyman enablement (BE-02 A): the effective projection needs BOTH the
 * commercial entitlement (created in makeJobContext) AND an enabled building
 * module configuration. Configuration writes capture DRAFT versions
 * (BE-27N/O publish-gated doctrine), so the fixture validates/publishes/
 * activates the captured version — the exact BE-02 suite idiom.
 */
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
      name: 'Handyman Job Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Handyman Job Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Handyman Job Tower',
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

type Hierarchy = Awaited<ReturnType<typeof createHierarchy>>;

async function makeTenantContext(h: {
  client: { id: string };
  building: { id: string };
  space: { id: string };
}) {
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: h.client.id,
      tenantCode: `TC_${suffix()}`,
      tenantName: 'Handyman Job Tenant Company',
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
    email: `pic05-${suffix().toLowerCase()}@tenant.example.com`,
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
      email: `pic05-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000005',
    },
    adminUserId,
  );
  return { company, pic, picUser };
}

async function createRequest(
  h: { building: { id: string }; space: { id: string } },
  tenant: { company: { id: string }; pic: { id: string } },
  title = 'Water Heater Broken',
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
      description: 'No hot water in the master bathroom.',
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
      name: 'Handyman Job Service',
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
    name: 'Job Workforce Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Job Workforce Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Job Workforce Position',
  });
  return { organization, department, position };
}

type OrgChain = Awaited<ReturnType<typeof createOrgChain>>;

/** EXTERNAL worker through the EXISTING personnel authority (BE-03C profile
 * → BE-06F binding). Distinctive names double as PII canaries. */
async function createWorker(
  vendorId: string,
  chain: OrgChain,
  role: string,
) {
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

/**
 * Full governed chain through APPROVAL + an eligible provider + crew:
 * hierarchy → tenant → vendor/commerce stack → designation → BE-06D
 * relationship → request → triage → selection → BE-06E capability →
 * quotation → priced LABOR line → SUBMITTED revision → SENT → IN_APP
 * APPROVED → org chain → EXTERNAL lead worker → ACTIVE crew.
 */
async function makeJobContext(options: { approve?: boolean } = {}) {
  const approve = options.approve ?? true;
  const h = await createHierarchy();
  const tenant = await makeTenantContext(h);
  const moduleId = await ensureHandymanModule();
  await configureHandymanBuilding(h.building.id);

  const vendor = await vendorService.createVendor({
    clientId: h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Handyman Job Vendor',
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
    name: 'Handyman Job Capability',
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
  let approval = null as null | Awaited<
    ReturnType<typeof decideHandymanQuotationApprovalInApp>
  >;
  if (approve) {
    approval = await decideHandymanQuotationApprovalInApp(
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
      crewName: 'Job Crew One',
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
    sent,
    approval,
    chain,
    lead,
    crew,
  };
}

type JobContext = Awaited<ReturnType<typeof makeJobContext>>;

/** A SECOND fully eligible provider+crew on the same client/building/service
 * (a valid reassignment/alternate target). */
async function addEligibleProvider(base: JobContext, role: string) {
  const vendor = await vendorService.createVendor({
    clientId: base.h.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: `Handyman Job Vendor ${role}`,
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
    name: `Handyman Job Capability ${role}`,
    serviceCatalogId: base.service.id,
    vendorBuildingRelationshipId: relationship.id,
  });
  const lead = await createWorker(vendor.id, base.chain, role);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: base.h.client.id,
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: `Job Crew ${role}`,
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );
  return { vendor, provider, relationship, crew, lead };
}

/** An extra ACTIVE crew under the SAME provider (same-vendor reassignment). */
async function addCrewForProvider(base: JobContext, role: string) {
  const lead = await createWorker(base.vendor.id, base.chain, role);
  const { crew } = await createHandymanWorkCrew(
    {
      clientId: base.h.client.id,
      handymanProviderId: base.provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: `Job Crew ${role}`,
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );
  return { crew, lead };
}

/** A second APPROVED request chain on the same client/building/vendor/
 * provider/service (for multi-job scenarios). */
async function approveSecondRequest(base: JobContext) {
  const request = await createRequest(base.h, base.tenant, 'Second Fixture Job');
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
/* Raw inspection helpers (structural assertions)                      */
/* ------------------------------------------------------------------ */

type WorkOrderRow = {
  id: string;
  client_id: string;
  building_id: string;
  work_order_number: string;
  work_type: string;
  status: string;
  title: string;
  description: string | null;
  asset_id: string | null;
  functional_location_id: string | null;
};

async function workOrderRow(workOrderId: string): Promise<WorkOrderRow> {
  const result = await requirePool().query<WorkOrderRow>(
    `SELECT id, client_id, building_id, work_order_number, work_type, status,
            title, description, asset_id, functional_location_id
     FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  assert.ok(result.rows[0], 'work order row must exist');
  return result.rows[0];
}

type VendorAssignmentRow = {
  id: string;
  vendor_id: string;
  work_order_id: string;
  building_id: string;
  status: string;
};

async function vendorAssignmentRows(
  workOrderId: string,
): Promise<VendorAssignmentRow[]> {
  const result = await requirePool().query<VendorAssignmentRow>(
    `SELECT id, vendor_id, work_order_id, building_id, status
     FROM vendor_assignments WHERE work_order_id = $1
     ORDER BY created_at ASC`,
    [workOrderId],
  );
  return result.rows;
}

async function vendorWorkRows(
  vendorAssignmentId: string,
): Promise<{ id: string; status: string; started_at: Date | null }[]> {
  const result = await requirePool().query(
    `SELECT id, status, started_at FROM vendor_works
     WHERE vendor_assignment_id = $1`,
    [vendorAssignmentId],
  );
  return result.rows;
}

type CompositionRow = {
  id: string;
  vendor_assignment_id: string;
  handyman_work_crew_id: string;
  status: string;
  assigned_by_user_id: string;
  superseded_at: Date | null;
  superseded_by_user_id: string | null;
};

async function compositionRows(jobId: string): Promise<CompositionRow[]> {
  const result = await requirePool().query<CompositionRow>(
    `SELECT id, vendor_assignment_id, handyman_work_crew_id, status,
            assigned_by_user_id, superseded_at, superseded_by_user_id
     FROM handyman_job_assignments WHERE handyman_job_id = $1
     ORDER BY created_at ASC`,
    [jobId],
  );
  return result.rows;
}

async function countJobs(requestId: string): Promise<number> {
  const result = await requirePool().query(
    'SELECT count(*)::int AS n FROM handyman_jobs WHERE handyman_request_id = $1',
    [requestId],
  );
  return result.rows[0].n as number;
}

async function countWorkOrdersByNumber(
  clientId: string,
  workOrderNumber: string,
): Promise<number> {
  const result = await requirePool().query(
    'SELECT count(*)::int AS n FROM work_orders WHERE client_id = $1 AND work_order_number = $2',
    [clientId, workOrderNumber],
  );
  return result.rows[0].n as number;
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
  const serialized = JSON.stringify(
    events.map((event) => ({ ...event, metadata: event.metadata })),
  );
  assert.ok(!serialized.includes(CUSTOMER_NAME), 'customer name leaked');
  assert.ok(!serialized.includes(CUSTOMER_PHONE), 'customer phone leaked');
  assert.ok(!serialized.includes(CUSTOMER_EMAIL), 'customer email leaked');
  assert.ok(!serialized.includes('Zqxf'), 'worker name leaked');
}

async function createJobFor(base: JobContext) {
  const result = await createHandymanJob(
    { handymanRequestId: base.request.id },
    adminUserId,
  );
  return result;
}

/* ------------------------------------------------------------------ */
/* 1. Job creation from the approved commercial authority              */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 1: job creation from the approved authority', () => {
  it('creates the thin job + work order with exact approved bindings', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();

    const result = await createJobFor(base);
    assert.equal(result.created, true);
    const job = result.job;
    assert.equal(job.clientId, base.h.client.id);
    assert.equal(job.handymanRequestId, base.request.id);
    assert.equal(job.handymanQuotationId, base.quotation.id);
    // The EXACT approved revision: quotation.sentRevisionId, which the
    // APPROVED approval decision bound (no stale revision can slip in —
    // the composite FK makes foreign revisions structurally impossible).
    assert.equal(job.handymanQuotationRevisionId, base.sent.quotation.sentRevisionId);
    assert.equal(job.handymanQuotationRevisionId, base.revision.id);
    assert.equal(job.createdByUserId, adminUserId);

    // The work order: derived deterministic number, HANDYMAN type, the
    // request's canonical building/client, OPEN via BE-08, and NO
    // synthesized asset/functional location or copied free text.
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.work_order_number, `HMWO-${base.request.requestNumber}`);
    assert.equal(wo.work_type, 'HANDYMAN');
    assert.equal(wo.client_id, base.request.clientId);
    assert.equal(wo.building_id, base.request.buildingId);
    assert.equal(wo.status, 'OPEN');
    assert.equal(wo.asset_id, null);
    assert.equal(wo.functional_location_id, null);
    assert.equal(wo.title, `Handyman job ${base.request.requestNumber}`);
    assert.equal(wo.description, null);

    // Structural identities: one job per request, one WO per job.
    assert.equal(await countJobs(base.request.id), 1);
    assert.equal(
      await countWorkOrdersByNumber(base.h.client.id, wo.work_order_number),
      1,
    );

    // Audit: ids-only events on both entities; WORK_ORDER_CREATED comes from
    // the EXISTING BE-08 authority; no PII anywhere.
    const jobEvents = await eventsFor(job.id);
    const created = jobEvents.filter(
      (event) => event.event_type === 'HANDYMAN_JOB_CREATED',
    );
    assert.equal(created.length, 1);
    assert.equal(created[0].entity_type, 'HANDYMAN_JOB');
    assert.deepEqual(created[0].metadata, {
      handymanRequestId: base.request.id,
      handymanQuotationId: base.quotation.id,
      handymanQuotationRevisionId: base.revision.id,
      workOrderId: job.workOrderId,
    });
    const woEvents = await eventsFor(job.workOrderId);
    assert.equal(
      woEvents.filter((event) => event.event_type === 'WORK_ORDER_CREATED')
        .length,
      1,
    );
    assertNoPii([...jobEvents, ...woEvents]);
  });

  it('is idempotent at business identity: a replay converges with no writes', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();

    const first = await createJobFor(base);
    const second = await createJobFor(base);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(second.job.workOrderId, first.job.workOrderId);
    assert.equal(await countJobs(base.request.id), 1);
    assert.equal(
      await countWorkOrdersByNumber(
        base.h.client.id,
        `HMWO-${base.request.requestNumber}`,
      ),
      1,
    );
    const jobEvents = await eventsFor(first.job.id);
    assert.equal(
      jobEvents.filter((event) => event.event_type === 'HANDYMAN_JOB_CREATED')
        .length,
      1,
    );
  });

  it('elects exactly one winner under concurrent creation', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();

    const results = await Promise.allSettled([
      createHandymanJob({ handymanRequestId: base.request.id }, adminUserId),
      createHandymanJob({ handymanRequestId: base.request.id }, adminUserId),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled');
    const first = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createHandymanJob>>>).value;
    const second = (results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof createHandymanJob>>>).value;
    assert.equal(first.job.id, second.job.id);
    assert.equal(await countJobs(base.request.id), 1);
    assert.equal(
      await countWorkOrdersByNumber(
        base.h.client.id,
        `HMWO-${base.request.requestNumber}`,
      ),
      1,
    );
    const jobEvents = await eventsFor(first.job.id);
    assert.equal(
      jobEvents.filter((event) => event.event_type === 'HANDYMAN_JOB_CREATED')
        .length,
      1,
    );
  });

  it('rejects a request that is not APPROVED and creates nothing', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext({ approve: false });

    await expectError(
      createHandymanJob({ handymanRequestId: base.request.id }, adminUserId),
      'HANDYMAN_JOB_REQUEST_NOT_APPROVED',
      409,
    );
    assert.equal(await countJobs(base.request.id), 0);
    assert.equal(
      await countWorkOrdersByNumber(
        base.h.client.id,
        `HMWO-${base.request.requestNumber}`,
      ),
      0,
    );
  });

  it('rejects an unknown request and denies outsiders', async (t) => {
    if (!ready(t)) return;
    await expectError(
      createHandymanJob({ handymanRequestId: randomUUID() }, adminUserId),
      'HANDYMAN_REQUEST_NOT_FOUND',
      404,
    );
    const base = await makeJobContext();
    await expectError(
      createHandymanJob({ handymanRequestId: base.request.id }, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    assert.equal(await countJobs(base.request.id), 0);
  });

  it('binds the exact NEW approved revision after a reject/re-quote loop', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext({ approve: false });

    // Reject the first sent revision through the existing IN_APP authority.
    await decideHandymanQuotationApprovalInApp(
      { quotationId: base.quotation.id, decision: 'REJECTED', notes: 'Over budget' },
      base.tenant.picUser.id,
    );
    // Re-quote under the SAME quotation identity: new revision → line →
    // submit → send → APPROVED.
    const rev2 = await createHandymanQuotationRevision(
      { quotationId: base.quotation.id, notes: 'Reduced scope offer' },
      adminUserId,
    );
    await addHandymanQuotationLine(
      {
        revisionId: rev2.id,
        lineType: 'LABOR',
        serviceCatalogId: base.service.id,
        unitPrice: 150000,
      },
      adminUserId,
    );
    await submitHandymanQuotationRevision(rev2.id, adminUserId);
    await sendHandymanQuotation(
      { quotationId: base.quotation.id, revisionId: rev2.id },
      adminUserId,
    );
    await decideHandymanQuotationApprovalInApp(
      { quotationId: base.quotation.id, decision: 'APPROVED' },
      base.tenant.picUser.id,
    );

    const result = await createJobFor(base);
    assert.equal(result.created, true);
    // The job binds revision 2 — the stale rejected revision 1 can never be
    // the binding (and the composite FK forbids cross-quotation revisions).
    assert.equal(result.job.handymanQuotationRevisionId, rev2.id);
    assert.notEqual(result.job.handymanQuotationRevisionId, base.revision.id);
    assert.equal(result.job.handymanQuotationId, base.quotation.id);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The ONE governed assignment composition                          */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 1: governed provider + crew assignment', () => {
  it('composes vendor assignment + NOT_STARTED vendor work + ACTIVE binding and converges the work order to ASSIGNED', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);

    const result = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );

    // Composition row: ACTIVE, attributed, no supersede fields.
    assert.equal(result.assignment.status, 'ACTIVE');
    assert.equal(result.assignment.handymanJobId, job.id);
    assert.equal(result.assignment.handymanWorkCrewId, base.crew.id);
    assert.equal(result.assignment.assignedByUserId, adminUserId);
    assert.equal(result.assignment.supersededAt, null);
    assert.equal(result.assignment.supersededByUserId, null);
    assert.equal(result.workOrderStatus, 'ASSIGNED');

    // The EXISTING BE-15A row (no second assignment table) — ACTIVE, on the
    // job's work order and building.
    const vaRows = await vendorAssignmentRows(job.workOrderId);
    assert.equal(vaRows.length, 1);
    assert.equal(vaRows[0].id, result.vendorAssignmentId);
    assert.equal(vaRows[0].vendor_id, base.vendor.id);
    assert.equal(vaRows[0].work_order_id, job.workOrderId);
    assert.equal(vaRows[0].building_id, base.h.building.id);
    assert.equal(vaRows[0].status, 'ACTIVE');

    // The EXISTING BE-15B context resolved at NOT_STARTED — the lifecycle is
    // NOT advanced by this module.
    const vwRows = await vendorWorkRows(result.vendorAssignmentId);
    assert.equal(vwRows.length, 1);
    assert.equal(vwRows[0].id, result.vendorWorkId);
    assert.equal(vwRows[0].status, 'NOT_STARTED');
    assert.equal(vwRows[0].started_at, null);

    // The work order moved OPEN→ASSIGNED through the existing guarded
    // transition only.
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');
    assert.ok(wo.building_id === base.request.buildingId);

    // Exactly one ACTIVE composition.
    const rows = await compositionRows(job.id);
    assert.equal(rows.length, 1);
    assert.equal(rows.filter((row) => row.status === 'ACTIVE').length, 1);

    // Parity events: BE-15A/BE-15B operational shapes + the Handyman event,
    // all ids-only.
    const vaEvents = await eventsFor(result.vendorAssignmentId);
    assert.equal(
      vaEvents.filter((event) => event.event_type === 'VENDOR_ASSIGNMENT_CREATED').length,
      1,
    );
    const vwEvents = await eventsFor(result.vendorWorkId);
    assert.equal(
      vwEvents.filter((event) => event.event_type === 'VENDOR_WORK_CREATED').length,
      1,
    );
    const jobEvents = await eventsFor(job.id);
    const assigned = jobEvents.filter(
      (event) => event.event_type === 'HANDYMAN_JOB_ASSIGNED',
    );
    assert.equal(assigned.length, 1);
    assert.deepEqual(assigned[0].metadata, {
      handymanJobAssignmentId: result.assignment.id,
      vendorAssignmentId: result.vendorAssignmentId,
      vendorWorkId: result.vendorWorkId,
      handymanProviderId: base.provider.id,
      vendorId: base.vendor.id,
      handymanWorkCrewId: base.crew.id,
    });
    assertNoPii([...vaEvents, ...vwEvents, ...jobEvents]);
  });

  it('replays the same target idempotently with no duplicate rows', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const first = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const replay = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    assert.equal(replay.assignment.id, first.assignment.id);
    assert.equal(replay.vendorAssignmentId, first.vendorAssignmentId);
    assert.equal(replay.vendorWorkId, first.vendorWorkId);
    assert.equal(replay.workOrderStatus, 'ASSIGNED');
    assert.equal((await compositionRows(job.id)).length, 1);
    assert.equal((await vendorAssignmentRows(job.workOrderId)).length, 1);
    assert.equal((await vendorWorkRows(first.vendorAssignmentId)).length, 1);
  });

  it('rejects a different target while an ACTIVE composition exists', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const second = await addEligibleProvider(base, 'LeadTwo');
    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: second.provider.id,
          handymanWorkCrewId: second.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_JOB_ALREADY_ASSIGNED',
      409,
    );
    const rows = await compositionRows(job.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(rows[0].handyman_work_crew_id, base.crew.id);
  });

  it('revalidates the designation at time of use (INACTIVE provider rejected)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    await updateHandymanProviderStatus(
      base.provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: base.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_STATUS_INVALID',
      400,
    );
    // Nothing was composed.
    assert.equal((await compositionRows(job.id)).length, 0);
    assert.equal((await vendorAssignmentRows(job.workOrderId)).length, 0);
  });

  it('revalidates the vendor at time of use (INACTIVE vendor rejected)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    await vendorService.updateVendorStatus(base.vendor.id, {
      status: 'INACTIVE',
    });
    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: base.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        adminUserId,
      ),
      'VENDOR_INACTIVE',
      400,
    );
    assert.equal((await compositionRows(job.id)).length, 0);
    assert.equal((await vendorAssignmentRows(job.workOrderId)).length, 0);
  });

  it('requires the ACTIVE vendor-building relationship and leaves NO orphan rows on failure', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    // Provider with designation + crew but NO BE-06D relationship.
    const vendor = await vendorService.createVendor({
      clientId: base.h.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Unrelated Vendor',
    });
    const provider = await designateHandymanProvider(
      { clientId: base.h.client.id, vendorId: vendor.id },
      adminUserId,
    );
    const lead = await createWorker(vendor.id, base.chain, 'LeadNoRel');
    const { crew } = await createHandymanWorkCrew(
      {
        clientId: base.h.client.id,
        handymanProviderId: provider.id,
        crewCode: `CREW_${suffix()}`,
        crewName: 'No Relationship Crew',
        leadWorkerBindingId: lead.binding.id,
      },
      adminUserId,
    );

    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        { handymanProviderId: provider.id, handymanWorkCrewId: crew.id },
        adminUserId,
      ),
      'VENDOR_ASSIGNMENT_BUILDING_MISMATCH',
      400,
    );
    // No orphan provider assignment, vendor work, or composition survived.
    assert.equal((await vendorAssignmentRows(job.workOrderId)).length, 0);
    assert.equal((await compositionRows(job.id)).length, 0);
  });

  it('requires eligibility for EVERY ACTIVE request service (capability gap rejected)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    // Provider WITH relationship but WITHOUT the service capability.
    const vendor = await vendorService.createVendor({
      clientId: base.h.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Uncapable Vendor',
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
    assert.ok(relationship.id);
    const lead = await createWorker(vendor.id, base.chain, 'LeadNoCap');
    const { crew } = await createHandymanWorkCrew(
      {
        clientId: base.h.client.id,
        handymanProviderId: provider.id,
        crewCode: `CREW_${suffix()}`,
        crewName: 'No Capability Crew',
        leadWorkerBindingId: lead.binding.id,
      },
      adminUserId,
    );

    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        { handymanProviderId: provider.id, handymanWorkCrewId: crew.id },
        adminUserId,
      ),
      'HANDYMAN_JOB_PROVIDER_SERVICE_NOT_ELIGIBLE',
      409,
    );
    assert.equal((await vendorAssignmentRows(job.workOrderId)).length, 0);
    assert.equal((await compositionRows(job.id)).length, 0);
  });

  it('rejects a crew of a DIFFERENT provider and an INACTIVE crew', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const second = await addEligibleProvider(base, 'LeadAlt');

    // Crew belongs to base.provider, command names second.provider.
    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: second.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_JOB_CREW_PROVIDER_MISMATCH',
      400,
    );

    // INACTIVE crew of the right provider.
    await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: base.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
      400,
    );
    assert.equal((await compositionRows(job.id)).length, 0);
    assert.equal((await vendorAssignmentRows(job.workOrderId)).length, 0);
  });

  it('denies outsiders and unknown jobs', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    await expectError(
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: base.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      assignHandymanJobProviderAndCrew(
        randomUUID(),
        {
          handymanProviderId: base.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_JOB_NOT_FOUND',
      404,
    );
    assert.equal((await compositionRows(job.id)).length, 0);
  });

  it('elects exactly one winner under concurrent assignment (no orphan rows)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const second = await addEligibleProvider(base, 'LeadRace');

    const results = await Promise.allSettled([
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: base.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        adminUserId,
      ),
      assignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: second.provider.id,
          handymanWorkCrewId: second.crew.id,
        },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof assignHandymanJobProviderAndCrew>>>[];
    const rejected = results.filter(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      (rejected[0].reason as { code?: string }).code,
      'HANDYMAN_JOB_ALREADY_ASSIGNED',
    );

    // Exactly one ACTIVE composition and exactly one BE-15A/BE-15B pair —
    // the loser's transaction rolled back completely (no orphan assignment
    // without a crew binding ever survived).
    const rows = await compositionRows(job.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(rows[0].id, fulfilled[0].value.assignment.id);
    const vaRows = await vendorAssignmentRows(job.workOrderId);
    assert.equal(vaRows.length, 1);
    assert.equal(vaRows[0].id, fulfilled[0].value.vendorAssignmentId);
    assert.equal((await vendorWorkRows(vaRows[0].id)).length, 1);
    const wo = await workOrderRow(job.workOrderId);
    assert.equal(wo.status, 'ASSIGNED');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Reassignment, history, and the execution gates                   */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 1: reassignment + execution gates', () => {
  it('rejects reassignment before any assignment exists', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    await expectError(
      reassignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: base.provider.id,
          handymanWorkCrewId: base.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_JOB_NOT_ASSIGNED',
      409,
    );
  });

  it('supersedes with attribution, deactivates the old assignment, retains history and old vendor work', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const first = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const second = await addEligibleProvider(base, 'LeadReassign');

    const result = await reassignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: second.provider.id,
        handymanWorkCrewId: second.crew.id,
      },
      adminUserId,
    );
    assert.equal(result.assignment.status, 'ACTIVE');
    assert.notEqual(result.assignment.id, first.assignment.id);
    assert.equal(result.workOrderStatus, 'ASSIGNED');

    // Append-only history: the old composition is SUPERSEDED with full
    // attribution — never deleted, never rewritten.
    const rows = await compositionRows(job.id);
    assert.equal(rows.length, 2);
    const oldRow = rows.find((row) => row.id === first.assignment.id)!;
    const newRow = rows.find((row) => row.id === result.assignment.id)!;
    assert.equal(oldRow.status, 'SUPERSEDED');
    assert.ok(oldRow.superseded_at instanceof Date);
    assert.equal(oldRow.superseded_by_user_id, adminUserId);
    assert.equal(oldRow.vendor_assignment_id, first.vendorAssignmentId);
    assert.equal(newRow.status, 'ACTIVE');
    assert.equal(newRow.superseded_at, null);
    assert.equal(rows.filter((row) => row.status === 'ACTIVE').length, 1);

    // BE-15A: old assignment INACTIVE (deactivated, never deleted), new one
    // ACTIVE. BE-15B: the old vendor work is RETAINED untouched at
    // NOT_STARTED; the new one is NOT_STARTED.
    const vaRows = await vendorAssignmentRows(job.workOrderId);
    assert.equal(vaRows.length, 2);
    const oldVa = vaRows.find((row) => row.id === first.vendorAssignmentId)!;
    const newVa = vaRows.find((row) => row.id === result.vendorAssignmentId)!;
    assert.equal(oldVa.status, 'INACTIVE');
    assert.equal(oldVa.vendor_id, base.vendor.id);
    assert.equal(newVa.status, 'ACTIVE');
    assert.equal(newVa.vendor_id, second.vendor.id);
    const oldVw = await vendorWorkRows(first.vendorAssignmentId);
    assert.equal(oldVw.length, 1);
    assert.equal(oldVw[0].status, 'NOT_STARTED');
    assert.equal(oldVw[0].id, first.vendorWorkId);
    const newVw = await vendorWorkRows(result.vendorAssignmentId);
    assert.equal(newVw.length, 1);
    assert.equal(newVw[0].status, 'NOT_STARTED');

    // Parity + Handyman events, ids-only.
    const vaEvents = await eventsFor(result.vendorAssignmentId);
    const reassigned = vaEvents.filter(
      (event) => event.event_type === 'VENDOR_ASSIGNMENT_REASSIGNED',
    );
    assert.equal(reassigned.length, 1);
    assert.equal(reassigned[0].metadata.previousAssignmentId, first.vendorAssignmentId);
    const jobEvents = await eventsFor(job.id);
    const jobReassigned = jobEvents.filter(
      (event) => event.event_type === 'HANDYMAN_JOB_REASSIGNED',
    );
    assert.equal(jobReassigned.length, 1);
    assert.equal(
      jobReassigned[0].metadata.previousHandymanJobAssignmentId,
      first.assignment.id,
    );
    assert.equal(
      jobReassigned[0].metadata.previousHandymanWorkCrewId,
      base.crew.id,
    );
    assertNoPii([...vaEvents, ...jobEvents]);
  });

  it('replays the same reassignment target idempotently', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const second = await addEligibleProvider(base, 'LeadReplay');
    await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const first = await reassignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: second.provider.id,
        handymanWorkCrewId: second.crew.id,
      },
      adminUserId,
    );
    const replay = await reassignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: second.provider.id,
        handymanWorkCrewId: second.crew.id,
      },
      adminUserId,
    );
    assert.equal(replay.assignment.id, first.assignment.id);
    assert.equal((await compositionRows(job.id)).length, 2);
    assert.equal((await vendorAssignmentRows(job.workOrderId)).length, 2);
  });

  it('supports same-vendor crew rotation under the partial unique authority', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const extra = await addCrewForProvider(base, 'LeadSameVendor');

    const result = await reassignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: extra.crew.id,
      },
      adminUserId,
    );
    assert.equal(result.assignment.handymanWorkCrewId, extra.crew.id);
    // Old INACTIVE first, new ACTIVE — inside ONE transaction, so the
    // (vendor, work order) ACTIVE partial unique never saw two actives.
    const vaRows = await vendorAssignmentRows(job.workOrderId);
    assert.equal(vaRows.length, 2);
    assert.equal(
      vaRows.filter((row) => row.status === 'ACTIVE').length,
      1,
    );
    assert.equal(
      vaRows.filter((row) => row.vendor_id === base.vendor.id).length,
      2,
    );
  });

  it('rejects reassignment once the work order left the pre-execution window', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const first = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const second = await addEligibleProvider(base, 'LeadLate');
    // Execution starts through the EXISTING BE-08 guarded transition.
    await transitionWorkOrderStatus(job.workOrderId, { status: 'IN_PROGRESS' });

    await expectError(
      reassignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: second.provider.id,
          handymanWorkCrewId: second.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_JOB_NOT_ASSIGNABLE',
      409,
    );
    // The composition is untouched.
    const rows = await compositionRows(job.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, first.assignment.id);
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(
      (await vendorAssignmentRows(job.workOrderId)).filter(
        (row) => row.status === 'ACTIVE',
      ).length,
      1,
    );
  });

  it('rejects reassignment once the vendor work left NOT_STARTED (lifecycle untouched by BE-05)', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const first = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const second = await addEligibleProvider(base, 'LeadStarted');
    // Execution starts through the EXISTING BE-15B guarded transition while
    // the work order stays ASSIGNED.
    await vendorWorkService.transitionVendorWorkStatus(first.vendorWorkId, {
      status: 'IN_PROGRESS',
    });

    await expectError(
      reassignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: second.provider.id,
          handymanWorkCrewId: second.crew.id,
        },
        adminUserId,
      ),
      'HANDYMAN_JOB_NOT_ASSIGNABLE',
      409,
    );
    const rows = await compositionRows(job.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ACTIVE');
    // Idempotent replay of the ORIGINAL target still reports current truth
    // without touching the started execution.
    const replay = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    assert.equal(replay.assignment.id, first.assignment.id);
    const vw = await vendorWorkRows(first.vendorAssignmentId);
    assert.equal(vw[0].status, 'IN_PROGRESS');
  });

  it('elects exactly one winner under concurrent reassignment', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const second = await addEligibleProvider(base, 'LeadRaceA');
    const third = await addEligibleProvider(base, 'LeadRaceB');

    const results = await Promise.allSettled([
      reassignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: second.provider.id,
          handymanWorkCrewId: second.crew.id,
        },
        adminUserId,
      ),
      reassignHandymanJobProviderAndCrew(
        job.id,
        {
          handymanProviderId: third.provider.id,
          handymanWorkCrewId: third.crew.id,
        },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof reassignHandymanJobProviderAndCrew>>>[];
    const rejected = results.filter(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      (rejected[0].reason as { code?: string }).code,
      'HANDYMAN_JOB_ASSIGNMENT_STATE_INVALID',
    );

    // History: original SUPERSEDED once + exactly one new ACTIVE — the
    // loser's rows never survived (guarded supersede + rollback).
    const rows = await compositionRows(job.id);
    assert.equal(rows.length, 2);
    assert.equal(
      rows.filter((row) => row.status === 'SUPERSEDED').length,
      1,
    );
    assert.equal(rows.filter((row) => row.status === 'ACTIVE').length, 1);
    assert.equal(
      rows.find((row) => row.status === 'ACTIVE')!.id,
      fulfilled[0].value.assignment.id,
    );
    const vaRows = await vendorAssignmentRows(job.workOrderId);
    assert.equal(
      vaRows.filter((row) => row.status === 'ACTIVE').length,
      1,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. Temporal worker conflict is EXPLICITLY not rejected in Run 1     */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 1: no temporal worker-conflict rejection (explicit proof)', () => {
  it('accepts a worker who is ACTIVE in another crew on another assigned job', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();

    // Job 1: provider + crew 1 (lead worker W).
    const { job: job1 } = await createJobFor(base);
    await assignHandymanJobProviderAndCrew(
      job1.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );

    // Crew 2 under the SAME provider, founded with the SAME lead worker W —
    // CR-HM-BE-04 allows cross-crew membership (its uniqueness is per crew),
    // and CR-HM-BE-05 Run 1 MUST NOT add a temporal rejection on top.
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

    // Job 2: a second APPROVED request chain on the same building/vendor.
    const request2 = await approveSecondRequest(base);
    const { job: job2 } = await createHandymanJob(
      { handymanRequestId: request2.id },
      adminUserId,
    );

    // The assignment SUCCEEDS even though worker W is the ACTIVE lead of
    // crew 1 on job 1 in the same building at the same time: Run 1 has no
    // temporal worker-conflict model (carried to Run 2 as P3).
    const result = await assignHandymanJobProviderAndCrew(
      job2.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: crew2.id,
      },
      adminUserId,
    );
    assert.equal(result.assignment.status, 'ACTIVE');
    assert.equal(result.workOrderStatus, 'ASSIGNED');

    // Both compositions are ACTIVE simultaneously; the shared worker holds
    // two ACTIVE memberships and no rule rejected either.
    const members1 = await listHandymanWorkCrewMembers(
      base.crew.id,
      adminUserId,
      { status: 'ACTIVE' },
    );
    const members2 = await listHandymanWorkCrewMembers(
      crew2.id,
      adminUserId,
      { status: 'ACTIVE' },
    );
    assert.equal(
      members1.filter(
        (member) => member.vendorWorkforceBindingId === base.lead.binding.id,
      ).length,
      1,
    );
    assert.equal(
      members2.filter(
        (member) => member.vendorWorkforceBindingId === base.lead.binding.id,
      ).length,
      1,
    );
    assert.equal(
      (await compositionRows(job1.id)).filter((row) => row.status === 'ACTIVE')
        .length,
      1,
    );
    assert.equal(
      (await compositionRows(job2.id)).filter((row) => row.status === 'ACTIVE')
        .length,
      1,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. Reads                                                            */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-05 RUN 1: reads', () => {
  it('serves job reads and append-only assignment history behind the client data scope', async (t) => {
    if (!ready(t)) return;
    const base = await makeJobContext();
    const { job } = await createJobFor(base);
    const first = await assignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: base.provider.id,
        handymanWorkCrewId: base.crew.id,
      },
      adminUserId,
    );
    const second = await addEligibleProvider(base, 'LeadReads');
    await reassignHandymanJobProviderAndCrew(
      job.id,
      {
        handymanProviderId: second.provider.id,
        handymanWorkCrewId: second.crew.id,
      },
      adminUserId,
    );

    const fetched = await getHandymanJobById(job.id, adminUserId);
    assert.equal(fetched.id, job.id);
    assert.equal(fetched.handymanQuotationRevisionId, base.revision.id);

    const listed = await listHandymanJobs(base.h.client.id, adminUserId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, job.id);

    const history = await listHandymanJobAssignments(job.id, adminUserId);
    assert.equal(history.length, 2);
    assert.equal(
      history.filter((row) => row.status === 'ACTIVE').length,
      1,
    );
    const superseded = history.find((row) => row.id === first.assignment.id)!;
    assert.equal(superseded.status, 'SUPERSEDED');
    assert.ok(superseded.supersededAt);
    assert.equal(superseded.supersededByUserId, adminUserId);

    await expectError(
      getHandymanJobById(job.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanJobs(base.h.client.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanJobAssignments(job.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanJobById(randomUUID(), adminUserId),
      'HANDYMAN_JOB_NOT_FOUND',
      404,
    );
  });
});
