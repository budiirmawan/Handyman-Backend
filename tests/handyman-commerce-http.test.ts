import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { floorService } from '../src/modules/floors';
import {
  createHandymanRequest,
  getHandymanRequestById,
} from '../src/modules/handyman-requests';
import {
  selectHandymanRequestService,
  triageHandymanRequest,
} from '../src/modules/handyman-request-governance';
import * as handymanQuotationModule from '../src/modules/handyman-quotations';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  sendHandymanQuotation,
  submitHandymanQuotationRevision,
} from '../src/modules/handyman-quotations';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { propertyService } from '../src/modules/properties';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-03 RUN 4 — focused HTTP/OpenAPI contract tests for the commerce
 * and approval transport layer: auth on every CR03 route, the minimum-correct
 * permission gates, strict body allowlists (server-derived authority can
 * never be caller-authoritative), triage / request-service / inspection
 * governance over the wire, the full quotation lifecycle (create → lines →
 * submit → send → withdraw → re-quote loop), IN_APP tenant-PIC decisions
 * (authentication-only route, no smuggled authority), ASSISTED staff
 * recording (approved-for / recorded-by separation), secure-link staff
 * readiness (raw token exactly once, hash never exposed, no public
 * resolve/decide/consume surface), and exact runtime↔OpenAPI parity.
 * Business-rule depth lives in the Run 1–3 service suites; here each rule is
 * re-asserted once through the wire to prove thin controller delegation.
 */

const PORT = 55496;
const DIR = '/tmp/asentra-hm03-run4-pg';
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
  success: boolean;
  error: { code: string; message: string; details?: { field: string; message: string }[] };
};

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const CUSTOMER_NAME = 'Rina Tenant Contact';
const CUSTOMER_PHONE = '+6281298765002';
const CUSTOMER_EMAIL = 'rina.http@customer.example.com';

// Permission code constants (the CR03 governed set — no invented roles).
const REQUEST_READ = { code: 'handyman_request.read', name: 'Read Handyman Requests' };
const TRIAGE_MANAGE = { code: 'handyman_triage.manage', name: 'Triage Handyman Requests' };
const SERVICE_MANAGE = {
  code: 'handyman_request_service.manage',
  name: 'Manage Handyman Request Services',
};
const INSPECTION_MANAGE = {
  code: 'handyman_inspection.manage',
  name: 'Manage Handyman Inspections',
};
const QUOTATION_READ = { code: 'handyman_quotation.read', name: 'Read Handyman Quotations' };
const QUOTATION_MANAGE = { code: 'handyman_quotation.manage', name: 'Manage Handyman Quotations' };
const QUOTATION_SEND = { code: 'handyman_quotation.send', name: 'Send Handyman Quotations' };
const APPROVAL_RECORD = {
  code: 'handyman_quotation_approval.record',
  name: 'Record Handyman Quotation Approval Decisions',
};
const LINK_MANAGE = {
  code: 'handyman_quotation_approval_link.manage',
  name: 'Manage Handyman Quotation Approval Links',
};

const FULL_STACK = [
  REQUEST_READ,
  TRIAGE_MANAGE,
  SERVICE_MANAGE,
  INSPECTION_MANAGE,
  QUOTATION_READ,
  QUOTATION_MANAGE,
  QUOTATION_SEND,
  APPROVAL_RECORD,
  LINK_MANAGE,
];

let fullStackToken = '';
let readToken = '';
let manageToken = '';
let plainToken = '';

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
    `TRUNCATE handyman_quotation_approval_links, handyman_quotation_approvals,
      handyman_quotation_lines, handyman_quotation_revisions,
      handyman_quotations, handyman_request_triages, handyman_request_services,
      handyman_inspections, handyman_requests, handyman_providers,
      supporting_documents, documents, tenant_space_relationships,
      tenant_building_contexts, tenant_pics,
      tenant_companies, price_catalog_entries, inventory_items,
      units_of_measure, operational_events CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  fullStackToken = await createSessionWithPermissions(FULL_STACK);
  readToken = await createSessionWithPermissions([REQUEST_READ, QUOTATION_READ]);
  manageToken = await createSessionWithPermissions([
    TRIAGE_MANAGE,
    SERVICE_MANAGE,
    INSPECTION_MANAGE,
    QUOTATION_MANAGE,
    QUOTATION_SEND,
    APPROVAL_RECORD,
    LINK_MANAGE,
  ]);
  plainToken = await createPlainSession();
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

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function err(response: { body: unknown }): ErrorBody {
  return response.body as ErrorBody;
}

function fieldMessages(response: { body: unknown }): Record<string, string> {
  const details = err(response).error.details ?? [];
  const out: Record<string, string> = {};
  for (const detail of details) out[detail.field] = detail.message;
  return out;
}

/** Logs a session in for an existing user (tenant PICs carry no RBAC
 * permissions — the IN_APP channel is identity/context-governed). */
async function loginTokenFor(userId: string, email: string): Promise<string> {
  const password = 'TenantPass123';
  await credentialService.createInitialCredential({ userId, password });
  const login = await api().post('/api/v1/auth/login').send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}

/** A staff user ASSIGNED to the building carrying exactly the CR03
 * permission set (seeded codes) — the governed happy-path actor. */
async function assignedStaffToken(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `staff-${suffix().toLowerCase()}@example.com`,
    displayName: 'Assigned Handyman Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const role = await roleService.createRole({
    code: `STAFF_${suffix()}`,
    name: 'Assigned Handyman Staff Role',
  });
  for (const permission of FULL_STACK) {
    const existing = await permissionRepository.findByCode(permission.code);
    assert.ok(existing, `permission ${permission.code} must be seeded`);
    await permissionService.assignPermissionToRole(role.id, existing.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  return loginTokenFor(user.id, user.email);
}

// ---------------------------------------------------------------------------
// Fixtures — governed foundation through the existing services; the HTTP
// layer under test consumes these contexts.
// ---------------------------------------------------------------------------

async function createHierarchy(options: { client?: PublicClient } = {}) {
  const client =
    options.client ??
    (await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Commerce HTTP Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Commerce HTTP Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Commerce HTTP Tower',
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
      tenantName: 'Commerce HTTP Tenant',
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
    email: `pic-http-${suffix().toLowerCase()}@tenant.example.com`,
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
      email: `pic-http-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000002',
    },
    adminUserId,
  );
  return { company, pic, picUser };
}

async function createRequest(
  h: { building: { id: string }; space: { id: string } },
  tenant?: { company: { id: string }; pic: { id: string } },
) {
  return createHandymanRequest(
    {
      buildingId: h.building.id,
      spaceId: h.space.id,
      tenantCompanyId: tenant?.company.id ?? null,
      tenantPicId: tenant?.pic.id ?? null,
      customerName: CUSTOMER_NAME,
      customerPhone: CUSTOMER_PHONE,
      customerEmail: CUSTOMER_EMAIL,
      inboundChannel: 'WHATSAPP',
      title: 'Water Heater Broken',
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
      name: 'Commerce HTTP Service',
      category: 'HANDYMAN',
    },
    adminUserId,
  );
}

async function makeServicePrice(clientId: string, serviceId: string, unitPrice: number) {
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
  return priceCatalogEntryService.activatePriceCatalogEntry(created.id, adminUserId);
}

async function makeUom(clientId: string) {
  const id = randomUUID();
  const code = `EA${suffix()}`.slice(0, 12);
  await pool!.query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, code, 'Each', 'ea', 'COUNT'],
  );
  return { id, code };
}

async function makeItem(clientId: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `ITEM_${suffix()}`,
    name: 'Quoted material',
    itemType: 'MATERIAL',
  });
}

async function makeMaterialPrice(
  clientId: string,
  itemId: string,
  uomId: string,
  unitPrice: number,
) {
  const created = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      sourceMode: 'MATERIAL',
      itemId,
      uomId,
      currency: 'IDR' as const,
      unitPrice,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      idempotencyKey: `IDEM_${suffix()}_${randomUUID()}`,
    },
    adminUserId,
  );
  return priceCatalogEntryService.activatePriceCatalogEntry(created.id, adminUserId);
}

async function requestStatus(requestId: string): Promise<string> {
  const record = await getHandymanRequestById(requestId, adminUserId);
  return record.status;
}

/** TRIAGED request with one ACTIVE service selection + priced LABOR
 * quotation chain helpers (HTTP-driven where under test). */
async function makeTriagedContext(options: { withTenant?: boolean } = {}) {
  const withTenant = options.withTenant ?? true;
  const h = await createHierarchy();
  const tenant = withTenant ? await makeTenantContext(h) : null;
  const request = await createRequest(
    h,
    tenant ? { company: tenant.company, pic: tenant.pic } : undefined,
  );
  const service = await createService(h.client.id);
  await makeServicePrice(h.client.id, service.id, 150000);
  await triageHandymanRequest(
    { requestId: request.id, path: 'QUOTATION', notes: 'Known scope' },
    adminUserId,
  );
  const selection = await selectHandymanRequestService(
    { requestId: request.id, serviceCatalogId: service.id, source: 'TRIAGE' },
    adminUserId,
  );
  return { h, tenant, request, service, selection };
}

/** Full governed chain through SEND (service-composed fixture): used by the
 * approval/link tests where the HTTP surface under test starts after send. */
async function makeSentContext(options: { withTenant?: boolean } = {}) {
  const base = await makeTriagedContext(options);
  const quotation = await createHandymanQuotation(
    { requestId: base.request.id, currency: 'IDR' },
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
  const sent = await sendHandymanQuotation(
    { quotationId: quotation.quotation.id, revisionId: quotation.revision.id },
    adminUserId,
  );
  return { ...base, quotation, sent };
}

/** Every CR03 runtime operation (method + path template) for sweeps. */
const CR03_OPERATIONS: { method: 'get' | 'post' | 'patch' | 'delete'; path: string; body?: unknown }[] =
  [
    { method: 'post', path: '/handyman-requests/{id}/triages', body: { path: 'QUOTATION' } },
    { method: 'get', path: '/handyman-requests/{id}/triages' },
    { method: 'get', path: '/handyman-request-triages/{id}' },
    {
      method: 'post',
      path: '/handyman-requests/{id}/services',
      body: { serviceCatalogId: '{id}', source: 'TRIAGE' },
    },
    { method: 'get', path: '/handyman-requests/{id}/services' },
    { method: 'get', path: '/handyman-request-services/{id}' },
    { method: 'post', path: '/handyman-request-services/{id}/supersede' },
    { method: 'post', path: '/handyman-requests/{id}/inspections', body: {} },
    { method: 'get', path: '/handyman-requests/{id}/inspections' },
    { method: 'get', path: '/handyman-inspections/{id}' },
    {
      method: 'post',
      path: '/handyman-inspections/{id}/complete',
      body: { diagnosis: 'Broken element', scopeNotes: 'Replace element' },
    },
    { method: 'post', path: '/handyman-inspections/{id}/cancel' },
    { method: 'post', path: '/handyman-requests/{id}/quotations', body: { currency: 'IDR' } },
    { method: 'get', path: '/handyman-requests/{id}/quotations' },
    { method: 'get', path: '/handyman-quotations/{id}' },
    { method: 'post', path: '/handyman-quotations/{id}/send', body: { revisionId: '{id}' } },
    { method: 'post', path: '/handyman-quotations/{id}/withdraw' },
    { method: 'post', path: '/handyman-quotations/{id}/revisions', body: {} },
    { method: 'get', path: '/handyman-quotations/{id}/revisions' },
    { method: 'get', path: '/handyman-quotation-revisions/{id}' },
    { method: 'post', path: '/handyman-quotation-revisions/{id}/submit' },
    {
      method: 'post',
      path: '/handyman-quotation-revisions/{id}/lines',
      body: { lineType: 'OTHER', unitPrice: 1000, description: 'x' },
    },
    { method: 'get', path: '/handyman-quotation-revisions/{id}/lines' },
    { method: 'patch', path: '/handyman-quotation-lines/{id}', body: { unitPrice: 1000 } },
    { method: 'delete', path: '/handyman-quotation-lines/{id}' },
    { method: 'get', path: '/handyman-quotations/{id}/approvals' },
    { method: 'get', path: '/handyman-quotation-approvals/{id}' },
    {
      method: 'post',
      path: '/handyman-quotations/{id}/approvals/in-app-decision',
      body: { decision: 'APPROVED' },
    },
    {
      method: 'post',
      path: '/handyman-quotations/{id}/approvals/assisted-decision',
      body: { decision: 'APPROVED', approvedFor: { type: 'CUSTOMER' }, notes: 'Phone approval' },
    },
    {
      method: 'post',
      path: '/handyman-quotation-approvals/{id}/links',
      body: { recipientName: 'Rina', expiresAt: '2027-01-01T00:00:00.000Z' },
    },
    { method: 'get', path: '/handyman-quotations/{id}/approval-links' },
    { method: 'get', path: '/handyman-quotation-approval-links/{id}' },
    { method: 'post', path: '/handyman-quotation-approval-links/{id}/revoke' },
  ];

function fillPath(template: string): string {
  return `/api/v1${template.replace(/\{id\}/g, () => randomUUID())}`;
}

function fillBody(body: unknown): unknown {
  if (typeof body === 'string') return body === '{id}' ? randomUUID() : body;
  if (Array.isArray(body)) return body.map(fillBody);
  if (body && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) out[key] = fillBody(value);
    return out;
  }
  return body;
}

type SupertestCall = {
  set: (headers: Record<string, string>) => SupertestCall;
  send: (body: object) => SupertestCall;
  then: Promise<any>['then'];
};

async function callOperation(
  operation: { method: string; path: string; body?: unknown },
  token?: string,
): Promise<{ status: number; body: any }> {
  const url = fillPath(operation.path);
  const agent = api() as unknown as Record<string, (url: string) => SupertestCall>;
  let req = agent[operation.method](url);
  if (token) req = req.set(authHeaders(token));
  if (operation.body !== undefined) req = req.send(fillBody(operation.body) as object);
  return req as unknown as Promise<{ status: number; body: any }>;
}

describe('CR-HM-BE-03 RUN 4 — authentication and RBAC', () => {
  it('requires authentication on every CR03 operation', async (t) => {
    if (!ready(t)) return;
    for (const operation of CR03_OPERATIONS) {
      const response = await callOperation(operation);
      assert.equal(
        response.status,
        401,
        `${operation.method.toUpperCase()} ${operation.path} must require authentication`,
      );
      assert.equal(err(response).error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('denies every mutation to a read-only session', async (t) => {
    if (!ready(t)) return;
    const mutations = CR03_OPERATIONS.filter((operation) => operation.method !== 'get');
    for (const operation of mutations) {
      if (operation.path.endsWith('/approvals/in-app-decision')) continue; // no permission gate by design
      const response = await callOperation(operation, readToken);
      assert.equal(
        response.status,
        403,
        `${operation.method.toUpperCase()} ${operation.path} must deny a read-only session`,
      );
      assert.equal(err(response).error.code, 'PERMISSION_DENIED');
    }
  });

  it('denies every read to a manage-only session', async (t) => {
    if (!ready(t)) return;
    const reads = CR03_OPERATIONS.filter((operation) => operation.method === 'get');
    for (const operation of reads) {
      // approval-link reads are gated by link.manage, which this session holds.
      if (operation.path.includes('approval-links') || operation.path.endsWith('/links')) {
        continue;
      }
      const response = await callOperation(operation, manageToken);
      assert.equal(
        response.status,
        403,
        `${operation.method.toUpperCase()} ${operation.path} must deny a manage-only session`,
      );
      assert.equal(err(response).error.code, 'PERMISSION_DENIED');
    }
    // Link metadata reads are gated by their own permission and reachable.
    const linkRead = await callOperation(
      { method: 'get', path: '/handyman-quotations/{id}/approval-links' },
      manageToken,
    );
    assert.notEqual(err(linkRead).error.code, 'PERMISSION_DENIED');
  });

  it('gates the IN_APP route by identity authority only — never by a staff permission', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    // A plain authenticated session (no permissions at all) passes the route
    // gate and is rejected ONLY by the service identity/context authority.
    const response = await api()
      .post(`/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals/in-app-decision`)
      .set(authHeaders(plainToken))
      .send({ decision: 'APPROVED' });
    assert.equal(response.status, 403);
    assert.equal(err(response).error.code, 'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED');
    // The PENDING approval is untouched.
    const approvals = await api()
      .get(`/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals`)
      .set(authHeaders(adminToken));
    assert.equal(approvals.body.data[0].status, 'PENDING');
  });

  it('enforces client/building access on governed reads for permissioned outsiders', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeTriagedContext();
    const quotation = await createHandymanQuotation(
      { requestId: ctx.request.id, currency: 'IDR' },
      adminUserId,
    );
    const outsiderToken = await createSessionWithPermissions([REQUEST_READ, QUOTATION_READ]);
    const denied = await api()
      .get(`/api/v1/handyman-quotations/${quotation.quotation.id}`)
      .set(authHeaders(outsiderToken));
    assert.equal(denied.status, 403);
    assert.equal(err(denied).error.code, 'BUILDING_ACCESS_DENIED');
    const deniedTriageRead = await api()
      .get(`/api/v1/handyman-requests/${ctx.request.id}/triages`)
      .set(authHeaders(outsiderToken));
    assert.equal(deniedTriageRead.status, 403);
  });
});

describe('CR-HM-BE-03 RUN 4 — triage and request-service HTTP', () => {
  it('triages, re-triages with append-only history, and reads through the wire', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const fullStackToken = await assignedStaffToken(h.building.id);

    const triaged = await api()
      .post(`/api/v1/handyman-requests/${request.id}/triages`)
      .set(authHeaders(fullStackToken))
      .send({ path: 'QUOTATION', notes: 'Known scope' });
    assert.equal(triaged.status, 201, JSON.stringify(triaged.body));
    assert.equal(triaged.body.data.path, 'QUOTATION');
    assert.equal(triaged.body.data.status, 'ACTIVE');
    assert.equal(triaged.body.data.requestId, request.id);
    assert.equal(await requestStatus(request.id), 'TRIAGED');

    // Re-triage onto the INSPECTION path supersedes the prior ACTIVE row.
    const retriaged = await api()
      .post(`/api/v1/handyman-requests/${request.id}/triages`)
      .set(authHeaders(fullStackToken))
      .send({ path: 'INSPECTION' });
    assert.equal(retriaged.status, 201, JSON.stringify(retriaged.body));
    assert.equal(retriaged.body.data.path, 'INSPECTION');
    assert.equal(await requestStatus(request.id), 'INSPECTION_REQUIRED');

    const history = await api()
      .get(`/api/v1/handyman-requests/${request.id}/triages`)
      .set(authHeaders(fullStackToken));
    assert.equal(history.status, 200);
    const rows = history.body.data as { id: string; status: string; path: string }[];
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.status === 'ACTIVE').length, 1);
    const superseded = rows.find((row) => row.status === 'SUPERSEDED');
    assert.ok(superseded);
    assert.equal(superseded.path, 'QUOTATION');

    const single = await api()
      .get(`/api/v1/handyman-request-triages/${superseded.id}`)
      .set(authHeaders(fullStackToken));
    assert.equal(single.status, 200);
    assert.equal(single.body.data.id, superseded.id);
  });

  it('rejects smuggled authority and unknown fields on triage', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const fullStackToken = await assignedStaffToken(h.building.id);
    const url = `/api/v1/handyman-requests/${request.id}/triages`;

    const smuggledRequest = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ path: 'QUOTATION', requestId: randomUUID() });
    assert.equal(smuggledRequest.status, 400);
    assert.equal(err(smuggledRequest).error.code, 'VALIDATION_ERROR');
    assert.match(fieldMessages(smuggledRequest).requestId, /comes from the route/);

    const smuggledStatus = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ path: 'QUOTATION', status: 'SUPERSEDED', triagedByUserId: randomUUID() });
    assert.equal(smuggledStatus.status, 400);
    const messages = fieldMessages(smuggledStatus);
    assert.match(messages.status, /server-managed/);
    assert.match(messages.triagedByUserId, /authenticated actor/);

    const unknown = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ path: 'QUOTATION', classification: 'AC repair' });
    assert.equal(unknown.status, 400);
    assert.match(fieldMessages(unknown).classification, /not allowed/);

    const badPath = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ path: 'MAYBE' });
    assert.equal(badPath.status, 400);
    assert.match(fieldMessages(badPath).path, /QUOTATION, INSPECTION/);

    // Nothing was recorded.
    const history = await api()
      .get(url)
      .set(authHeaders(fullStackToken));
    assert.deepEqual(history.body.data, []);
  });

  it('selects multiple distinct ACTIVE services, supersedes, and blocks free-text classification', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const fullStackToken = await assignedStaffToken(h.building.id);
    const serviceA = await createService(h.client.id);
    const serviceB = await createService(h.client.id);
    await triageHandymanRequest(
      { requestId: request.id, path: 'QUOTATION' },
      adminUserId,
    );

    const url = `/api/v1/handyman-requests/${request.id}/services`;
    const first = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ serviceCatalogId: serviceA.id, source: 'TRIAGE' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.status, 'ACTIVE');
    assert.equal(first.body.data.serviceCatalogId, serviceA.id);

    // Multiple ACTIVE distinct services per request are preserved.
    const second = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ serviceCatalogId: serviceB.id, source: 'TRIAGE' });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // Re-selecting an already-ACTIVE identical service conflicts.
    const duplicate = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ serviceCatalogId: serviceA.id, source: 'TRIAGE' });
    assert.equal(duplicate.status, 409);
    assert.equal(err(duplicate).error.code, 'HANDYMAN_REQUEST_SERVICE_ALREADY_ACTIVE');

    const listed = await api().get(url).set(authHeaders(fullStackToken));
    assert.equal(listed.status, 200);
    assert.equal((listed.body.data as unknown[]).length, 2);
    const activeOnly = await api().get(`${url}?status=ACTIVE`).set(authHeaders(fullStackToken));
    assert.equal((activeOnly.body.data as unknown[]).length, 2);
    const badFilter = await api().get(`${url}?status=MAYBE`).set(authHeaders(fullStackToken));
    assert.equal(badFilter.status, 400);
    const unknownQuery = await api().get(`${url}?buildingId=${randomUUID()}`).set(authHeaders(fullStackToken));
    assert.equal(unknownQuery.status, 400);

    // Free-text-to-service classification is not exposed.
    const freeText = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ serviceCatalogId: serviceA.id, source: 'TRIAGE', description: 'fix the AC' });
    assert.equal(freeText.status, 400);
    assert.match(fieldMessages(freeText).description, /not exposed/);

    // Source-phase governance: INSPECTION source before any inspection.
    const badSource = await api()
      .post(url)
      .set(authHeaders(fullStackToken))
      .send({ serviceCatalogId: serviceA.id, source: 'INSPECTION' });
    assert.equal(badSource.status, 409);
    assert.equal(err(badSource).error.code, 'HANDYMAN_REQUEST_SERVICE_SOURCE_INVALID');

    // Supersede one selection; history stays readable.
    const superseded = await api()
      .post(`/api/v1/handyman-request-services/${first.body.data.id}/supersede`)
      .set(authHeaders(fullStackToken));
    assert.equal(superseded.status, 200, JSON.stringify(superseded.body));
    assert.equal(superseded.body.data.status, 'SUPERSEDED');
    const afterSupersede = await api()
      .get(`${url}?status=ACTIVE`)
      .set(authHeaders(fullStackToken));
    assert.equal((afterSupersede.body.data as unknown[]).length, 1);
    const singleRead = await api()
      .get(`/api/v1/handyman-request-services/${first.body.data.id}`)
      .set(authHeaders(fullStackToken));
    assert.equal(singleRead.status, 200);
    assert.equal(singleRead.body.data.status, 'SUPERSEDED');
  });

  it('opens, completes and cancels inspections through the wire', async (t) => {
    if (!ready(t)) return;
    // Complete flow.
    const h = await createHierarchy();
    const request = await createRequest(h);
    const fullStackToken = await assignedStaffToken(h.building.id);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    assert.equal(await requestStatus(request.id), 'INSPECTION_REQUIRED');

    const openUrl = `/api/v1/handyman-requests/${request.id}/inspections`;
    const opened = await api()
      .post(openUrl)
      .set(authHeaders(fullStackToken))
      .send({});
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.data.status, 'OPEN');
    assert.equal(opened.body.data.spaceId, h.space.id);

    const duplicateOpen = await api()
      .post(openUrl)
      .set(authHeaders(fullStackToken))
      .send({});
    assert.equal(duplicateOpen.status, 409);
    assert.equal(err(duplicateOpen).error.code, 'HANDYMAN_INSPECTION_ALREADY_OPEN');

    // Outcome facts are recorded on completion; binding/scope fields are immutable.
    const badComplete = await api()
      .post(`/api/v1/handyman-inspections/${opened.body.data.id}/complete`)
      .set(authHeaders(fullStackToken))
      .send({ diagnosis: 'Broken element', scopeNotes: 'Replace', checklistExecutionId: randomUUID() });
    assert.equal(badComplete.status, 400);
    assert.match(fieldMessages(badComplete).checklistExecutionId, /immutable/);

    const missingNotes = await api()
      .post(`/api/v1/handyman-inspections/${opened.body.data.id}/complete`)
      .set(authHeaders(fullStackToken))
      .send({ diagnosis: 'Broken element' });
    assert.equal(missingNotes.status, 400);
    assert.match(fieldMessages(missingNotes).scopeNotes, /required/);

    const completed = await api()
      .post(`/api/v1/handyman-inspections/${opened.body.data.id}/complete`)
      .set(authHeaders(fullStackToken))
      .send({ diagnosis: 'Broken heating element', scopeNotes: 'Replace the element and test' });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.equal(completed.body.data.diagnosis, 'Broken heating element');
    assert.equal(await requestStatus(request.id), 'INSPECTION_COMPLETED');

    const completedAgain = await api()
      .post(`/api/v1/handyman-inspections/${opened.body.data.id}/complete`)
      .set(authHeaders(fullStackToken))
      .send({ diagnosis: 'x', scopeNotes: 'y' });
    assert.equal(completedAgain.status, 409);
    assert.equal(err(completedAgain).error.code, 'HANDYMAN_INSPECTION_STATE_INVALID');

    // INSPECTION-source selection is governed after completion.
    const service = await createService(h.client.id);
    const inspectionSelection = await api()
      .post(`/api/v1/handyman-requests/${request.id}/services`)
      .set(authHeaders(fullStackToken))
      .send({ serviceCatalogId: service.id, source: 'INSPECTION' });
    assert.equal(inspectionSelection.status, 201, JSON.stringify(inspectionSelection.body));

    // Cancel flow in a fresh context.
    const h2 = await createHierarchy();
    const request2 = await createRequest(h2);
    const fullStackToken2 = await assignedStaffToken(h2.building.id);
    await triageHandymanRequest({ requestId: request2.id, path: 'INSPECTION' }, adminUserId);
    const opened2 = await api()
      .post(`/api/v1/handyman-requests/${request2.id}/inspections`)
      .set(authHeaders(fullStackToken2))
      .send({});
    assert.equal(opened2.status, 201);
    const cancelled = await api()
      .post(`/api/v1/handyman-inspections/${opened2.body.data.id}/cancel`)
      .set(authHeaders(fullStackToken2));
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    const cancelAgain = await api()
      .post(`/api/v1/handyman-inspections/${opened2.body.data.id}/cancel`)
      .set(authHeaders(fullStackToken2));
    assert.equal(cancelAgain.status, 409);

    const listed = await api()
      .get(`/api/v1/handyman-requests/${request2.id}/inspections`)
      .set(authHeaders(fullStackToken2));
    assert.equal((listed.body.data as unknown[]).length, 1);
    const single = await api()
      .get(`/api/v1/handyman-inspections/${opened2.body.data.id}`)
      .set(authHeaders(fullStackToken2));
    assert.equal(single.status, 200);
    assert.equal(single.body.data.status, 'CANCELLED');
  });
});

describe('CR-HM-BE-03 RUN 4 — quotation commerce HTTP', () => {
  it('creates, authors lines, submits, sends and reads the full governed chain', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeTriagedContext();
    const requestId = ctx.request.id;
    const fullStackToken = await assignedStaffToken(ctx.h.building.id);

    const idempotencyKey = `HTTP_${suffix()}`;
    const created = await api()
      .post(`/api/v1/handyman-requests/${requestId}/quotations`)
      .set(authHeaders(fullStackToken))
      .set('Idempotency-Key', idempotencyKey)
      .send({ currency: 'IDR' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.quotation.status, 'DRAFT');
    assert.equal(created.body.data.quotation.currency, 'IDR');
    assert.equal(created.body.data.revision.revisionNumber, 1);
    assert.equal(created.body.data.revision.status, 'DRAFT');
    assert.equal(created.body.data.replayed, false);
    assert.equal(created.body.data.quotation.customerName, CUSTOMER_NAME);
    // The internal idempotency fingerprint is never exposed.
    assert.ok(!JSON.stringify(created.body).toLowerCase().includes('fingerprint'));

    // Idempotent replay through the header returns the original result.
    const replay = await api()
      .post(`/api/v1/handyman-requests/${requestId}/quotations`)
      .set(authHeaders(fullStackToken))
      .set('Idempotency-Key', idempotencyKey)
      .send({ currency: 'IDR' });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.quotation.id, created.body.data.quotation.id);
    assert.equal(replay.body.data.replayed, true);

    // Same key with a different payload conflicts (client-scoped key).
    const conflict = await api()
      .post(`/api/v1/handyman-requests/${requestId}/quotations`)
      .set(authHeaders(fullStackToken))
      .set('Idempotency-Key', idempotencyKey)
      .send({ currency: 'USD' });
    assert.equal(conflict.status, 409);
    assert.equal(err(conflict).error.code, 'HANDYMAN_QUOTATION_IDEMPOTENCY_CONFLICT');

    const quotationId = created.body.data.quotation.id;
    const revisionId = created.body.data.revision.id;

    // LABOR line priced from the governed catalog lookup (MATCHED snapshot).
    const labor = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/lines`)
      .set(authHeaders(fullStackToken))
      .send({
        lineType: 'LABOR',
        serviceCatalogId: ctx.service.id,
        unitPrice: 150000,
      });
    assert.equal(labor.status, 201, JSON.stringify(labor.body));
    assert.equal(labor.body.data.lineType, 'LABOR');
    assert.equal(labor.body.data.lineTotal, 150000);
    assert.equal(labor.body.data.referenceResolution, 'MATCHED');
    assert.ok(labor.body.data.referencePriceEntryId);

    // MATERIAL line with quantity, item + UOM and reference price.
    const uom = await makeUom(ctx.h.client.id);
    const item = await makeItem(ctx.h.client.id);
    await makeMaterialPrice(ctx.h.client.id, item.id, uom.id, 12500);
    const material = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/lines`)
      .set(authHeaders(fullStackToken))
      .send({
        lineType: 'MATERIAL',
        inventoryItemId: item.id,
        uomId: uom.id,
        quantity: 2,
        unitPrice: 12500,
      });
    assert.equal(material.status, 201, JSON.stringify(material.body));
    assert.equal(material.body.data.lineTotal, 25000);

    // Governed deviation rule: deviating from a MATCHED reference requires a note.
    const deviated = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/lines`)
      .set(authHeaders(fullStackToken))
      .send({
        lineType: 'LABOR',
        serviceCatalogId: ctx.service.id,
        unitPrice: 175000,
      });
    assert.equal(deviated.status, 400);
    assert.equal(err(deviated).error.code, 'HANDYMAN_QUOTATION_PRICE_DEVIATION_NOTE_REQUIRED');

    // Update mutable commercial facts only.
    const updated = await api()
      .patch(`/api/v1/handyman-quotation-lines/${material.body.data.id}`)
      .set(authHeaders(fullStackToken))
      .send({ quantity: 3, deviationNote: 'Customer requested a spare' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.quantity, 3);
    assert.equal(updated.body.data.lineTotal, 37500);

    const emptyUpdate = await api()
      .patch(`/api/v1/handyman-quotation-lines/${material.body.data.id}`)
      .set(authHeaders(fullStackToken))
      .send({});
    assert.equal(emptyUpdate.status, 400);

    // Lines read + revision totals are server-derived.
    const lines = await api()
      .get(`/api/v1/handyman-quotation-revisions/${revisionId}/lines`)
      .set(authHeaders(fullStackToken));
    assert.equal(lines.status, 200);
    assert.equal((lines.body.data as unknown[]).length, 2);
    const revisionRead = await api()
      .get(`/api/v1/handyman-quotation-revisions/${revisionId}`)
      .set(authHeaders(fullStackToken));
    assert.equal(revisionRead.status, 200);
    assert.deepEqual(revisionRead.body.data.totals, {
      laborTotal: 150000,
      materialTotal: 37500,
      otherTotal: 0,
      grandTotal: 187500,
    });

    // Submit, then the governed send of the exact revision.
    const submitted = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/submit`)
      .set(authHeaders(fullStackToken));
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.revision.status, 'SUBMITTED');
    assert.deepEqual(submitted.body.data.supersededRevisionIds, []);

    const sent = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/send`)
      .set(authHeaders(fullStackToken))
      .send({ revisionId });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.quotation.status, 'SENT');
    assert.equal(sent.body.data.quotation.sentRevisionId, revisionId);
    assert.equal(sent.body.data.approval.status, 'PENDING');
    assert.equal(sent.body.data.approval.quotationRevisionId, revisionId);
    assert.equal(await requestStatus(requestId), 'QUOTATION_PENDING');

    // Detail + list reads.
    const detail = await api()
      .get(`/api/v1/handyman-quotations/${quotationId}`)
      .set(authHeaders(fullStackToken));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.quotation.id, quotationId);
    assert.equal((detail.body.data.revisions as unknown[]).length, 1);
    const listByRequest = await api()
      .get(`/api/v1/handyman-requests/${requestId}/quotations`)
      .set(authHeaders(fullStackToken));
    assert.equal(listByRequest.status, 200);
    assert.equal((listByRequest.body.data as unknown[]).length, 1);
    const revisions = await api()
      .get(`/api/v1/handyman-quotations/${quotationId}/revisions`)
      .set(authHeaders(fullStackToken));
    assert.equal(revisions.status, 200);
    assert.equal((revisions.body.data as unknown[]).length, 1);
  });

  it('never accepts derived totals or server-managed authority through the wire', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeTriagedContext();
    const requestId = ctx.request.id;
    const fullStackToken = await assignedStaffToken(ctx.h.building.id);

    const create = await api()
      .post(`/api/v1/handyman-requests/${requestId}/quotations`)
      .set(authHeaders(fullStackToken))
      .send({
        currency: 'IDR',
        quotationNumber: 'HQ-FORGED-1',
        customerName: 'Someone Else',
        status: 'SENT',
        requestId: randomUUID(),
        idempotencyKey: 'BODY_KEY',
      });
    assert.equal(create.status, 400);
    assert.equal(err(create).error.code, 'VALIDATION_ERROR');
    const createMessages = fieldMessages(create);
    assert.match(createMessages.quotationNumber, /server-generated/);
    assert.match(createMessages.customerName, /derived from the governed request/);
    assert.match(createMessages.status, /server-managed/);
    assert.match(createMessages.requestId, /comes from the route/);
    assert.match(createMessages.idempotencyKey, /Idempotency-Key header/);

    const quotation = await createHandymanQuotation(
      { requestId, currency: 'IDR' },
      adminUserId,
    );
    const revisionId = quotation.revision.id;
    const quotationId = quotation.quotation.id;

    const badCurrency = await api()
      .post(`/api/v1/handyman-requests/${requestId}/quotations`)
      .set(authHeaders(fullStackToken))
      .send({ currency: 'XXX' });
    assert.equal(badCurrency.status, 400);
    assert.match(fieldMessages(badCurrency).currency, /must be one of/);

    const revision = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/revisions`)
      .set(authHeaders(fullStackToken))
      .send({ revisionNumber: 99, totals: { grandTotal: 1 }, notes: 'Round two' });
    assert.equal(revision.status, 400);
    const revisionMessages = fieldMessages(revision);
    assert.match(revisionMessages.revisionNumber, /server-assigned/);
    assert.match(revisionMessages.totals, /derived from stored lines/);

    const line = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/lines`)
      .set(authHeaders(fullStackToken))
      .send({
        lineType: 'OTHER',
        description: 'Manual work',
        unitPrice: 50000,
        lineTotal: 1,
        lineNumber: 42,
        referenceUnitPrice: 1,
        currency: 'USD',
        discount: 10,
      });
    assert.equal(line.status, 400);
    const lineMessages = fieldMessages(line);
    assert.match(lineMessages.lineTotal, /derived/);
    assert.match(lineMessages.lineNumber, /server-assigned/);
    assert.match(lineMessages.referenceUnitPrice, /governed lookup/);
    assert.match(lineMessages.currency, /fixed by the quotation envelope/);
    assert.match(lineMessages.discount, /No discount surface/);

    const send = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/send`)
      .set(authHeaders(fullStackToken))
      .send({ revisionId, sentRevisionId: revisionId, sentAt: '2026-01-01T00:00:00.000Z', approvalId: randomUUID() });
    assert.equal(send.status, 400);
    const sendMessages = fieldMessages(send);
    assert.match(sendMessages.sentRevisionId, /server-managed/);
    assert.match(sendMessages.approvalId, /governed send transaction/);

    const foreignSend = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/send`)
      .set(authHeaders(fullStackToken))
      .send({ revisionId: randomUUID() });
    assert.equal(foreignSend.status, 409);
    assert.equal(err(foreignSend).error.code, 'HANDYMAN_QUOTATION_SEND_REVISION_INVALID');
  });

  it('keeps submitted revisions immutable and enforces submit guards through the wire', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeTriagedContext();
    const fullStackToken = await assignedStaffToken(ctx.h.building.id);
    const quotation = await createHandymanQuotation(
      { requestId: ctx.request.id, currency: 'IDR' },
      adminUserId,
    );
    const revisionId = quotation.revision.id;

    // Submit without lines fails.
    const emptySubmit = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/submit`)
      .set(authHeaders(fullStackToken));
    assert.equal(emptySubmit.status, 409);
    assert.equal(err(emptySubmit).error.code, 'HANDYMAN_QUOTATION_LINES_REQUIRED');

    const lineResponse = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/lines`)
      .set(authHeaders(fullStackToken))
      .send({ lineType: 'OTHER', description: 'Manual', unitPrice: 50000 });
    assert.equal(lineResponse.status, 201, JSON.stringify(lineResponse.body));
    const lineId = lineResponse.body.data.id;

    const submitted = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/submit`)
      .set(authHeaders(fullStackToken));
    assert.equal(submitted.status, 200);

    // The SUBMITTED revision and its lines are immutable over HTTP.
    const addAfterSubmit = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/lines`)
      .set(authHeaders(fullStackToken))
      .send({ lineType: 'OTHER', description: 'Late line', unitPrice: 1000 });
    assert.equal(addAfterSubmit.status, 409);
    assert.equal(err(addAfterSubmit).error.code, 'HANDYMAN_QUOTATION_REVISION_STATE_INVALID');

    const updateAfterSubmit = await api()
      .patch(`/api/v1/handyman-quotation-lines/${lineId}`)
      .set(authHeaders(fullStackToken))
      .send({ unitPrice: 1 });
    assert.equal(updateAfterSubmit.status, 409);

    const removeAfterSubmit = await api()
      .delete(`/api/v1/handyman-quotation-lines/${lineId}`)
      .set(authHeaders(fullStackToken));
    assert.equal(removeAfterSubmit.status, 409);

    const submitTwice = await api()
      .post(`/api/v1/handyman-quotation-revisions/${revisionId}/submit`)
      .set(authHeaders(fullStackToken));
    assert.equal(submitTwice.status, 409);

    // The next revision supersedes the submitted one; history is preserved.
    const nextRevision = await api()
      .post(`/api/v1/handyman-quotations/${quotation.quotation.id}/revisions`)
      .set(authHeaders(fullStackToken))
      .send({ notes: 'Customer asked for a spare part' });
    assert.equal(nextRevision.status, 201, JSON.stringify(nextRevision.body));
    assert.equal(nextRevision.body.data.revisionNumber, 2);
    assert.equal(nextRevision.body.data.status, 'DRAFT');

    const secondDraft = await api()
      .post(`/api/v1/handyman-quotations/${quotation.quotation.id}/revisions`)
      .set(authHeaders(fullStackToken))
      .send({});
    assert.equal(secondDraft.status, 409);
    assert.equal(err(secondDraft).error.code, 'HANDYMAN_QUOTATION_REVISION_DRAFT_EXISTS');

    const lineOnRev2 = await api()
      .post(`/api/v1/handyman-quotation-revisions/${nextRevision.body.data.id}/lines`)
      .set(authHeaders(fullStackToken))
      .send({ lineType: 'OTHER', description: 'Manual', unitPrice: 60000 });
    assert.equal(lineOnRev2.status, 201);
    const submitted2 = await api()
      .post(`/api/v1/handyman-quotation-revisions/${nextRevision.body.data.id}/submit`)
      .set(authHeaders(fullStackToken));
    assert.equal(submitted2.status, 200);
    assert.deepEqual(submitted2.body.data.supersededRevisionIds, [revisionId]);

    const history = await api()
      .get(`/api/v1/handyman-quotations/${quotation.quotation.id}/revisions`)
      .set(authHeaders(fullStackToken));
    const rows = history.body.data as { id: string; status: string }[];
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === revisionId)?.status, 'SUPERSEDED');
  });

  it('withdraws a SENT quotation, expires its PENDING approval, and blocks re-withdraw', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const quotationId = ctx.sent.quotation.id;
    const fullStackToken = await assignedStaffToken(ctx.h.building.id);

    const withdrawn = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/withdraw`)
      .set(authHeaders(fullStackToken));
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.data.status, 'WITHDRAWN');

    const approvals = await api()
      .get(`/api/v1/handyman-quotations/${quotationId}/approvals`)
      .set(authHeaders(fullStackToken));
    assert.equal(approvals.status, 200);
    assert.equal(approvals.body.data[0].status, 'EXPIRED');
    assert.equal(approvals.body.data[0].method, null);

    const again = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/withdraw`)
      .set(authHeaders(fullStackToken));
    assert.equal(again.status, 409);
    assert.equal(err(again).error.code, 'HANDYMAN_QUOTATION_STATE_INVALID');
  });
});

describe('CR-HM-BE-03 RUN 4 — IN_APP decision HTTP', () => {
  it('accepts the decision of the linked tenant PIC with atomic downstream transitions', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const picToken = await loginTokenFor(ctx.tenant!.picUser.id, ctx.tenant!.picUser.email);
    const quotationId = ctx.sent.quotation.id;

    const approved = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/approvals/in-app-decision`)
      .set(authHeaders(picToken))
      .send({ decision: 'APPROVED', notes: 'Agreed on WhatsApp' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const decision = approved.body.data;
    assert.equal(decision.approval.status, 'APPROVED');
    assert.equal(decision.approval.method, 'IN_APP');
    assert.equal(decision.approval.approvedForType, 'TENANT_PIC');
    assert.equal(decision.approval.approvedForTenantPicId, ctx.tenant!.pic.id);
    assert.equal(decision.approval.approvedForName, 'Pak Joko PIC');
    assert.equal(decision.approval.recordedByUserId, null);
    assert.equal(decision.approval.decisionNotes, 'Agreed on WhatsApp');
    assert.equal(decision.quotation.status, 'APPROVED');
    assert.equal(decision.requestStatus, 'APPROVED');
    assert.equal(await requestStatus(ctx.request.id), 'APPROVED');

    // Once-only through the wire.
    const again = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/approvals/in-app-decision`)
      .set(authHeaders(picToken))
      .send({ decision: 'REJECTED' });
    assert.equal(again.status, 409);
    assert.ok(
      ['HANDYMAN_QUOTATION_APPROVAL_NOT_PENDING', 'HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID'].includes(
        err(again).error.code,
      ),
    );
  });

  it('rejects wrong, unlinked and staff actors with the service identity authority', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const url = `/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals/in-app-decision`;

    // Fully-permissioned staff (even admin) is NOT the customer.
    const staff = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({ decision: 'APPROVED' });
    assert.equal(staff.status, 403);
    assert.equal(err(staff).error.code, 'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED');

    // A plain authenticated outsider is rejected by the same authority.
    const outsider = await api()
      .post(url)
      .set(authHeaders(plainToken))
      .send({ decision: 'APPROVED' });
    assert.equal(outsider.status, 403);
    assert.equal(err(outsider).error.code, 'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED');

    // A SECOND PIC of the same tenant company (not the request's PIC).
    const otherUser = await userService.createUser({
      email: `pic2-${suffix().toLowerCase()}@tenant.example.com`,
      displayName: 'Second PIC User',
    });
    await buildingAssignmentService.createAssignment(otherUser.id, {
      buildingId: ctx.h.building.id,
    });
    await tenantPicService.createTenantPic(
      {
        tenantCompanyId: ctx.tenant!.company.id,
        userId: otherUser.id,
        picName: 'Bu Sari Second PIC',
      },
      adminUserId,
    );
    const otherPicToken = await loginTokenFor(otherUser.id, otherUser.email);
    const wrongPic = await api()
      .post(url)
      .set(authHeaders(otherPicToken))
      .send({ decision: 'APPROVED' });
    assert.equal(wrongPic.status, 403);
    assert.equal(err(wrongPic).error.code, 'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED');

    // The approval is still PENDING and undecided.
    const approvals = await api()
      .get(`/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals`)
      .set(authHeaders(adminToken));
    assert.equal(approvals.body.data[0].status, 'PENDING');
  });

  it('rejects smuggled approved-for / recorded-by authority at the edge', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const picToken = await loginTokenFor(ctx.tenant!.picUser.id, ctx.tenant!.picUser.email);
    const url = `/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals/in-app-decision`;

    const smuggled = await api()
      .post(url)
      .set(authHeaders(picToken))
      .send({
        decision: 'APPROVED',
        approvedFor: { type: 'CUSTOMER' },
        recordedByUserId: adminUserId,
        method: 'ASSISTED',
      });
    assert.equal(smuggled.status, 400);
    assert.equal(err(smuggled).error.code, 'VALIDATION_ERROR');
    const messages = fieldMessages(smuggled);
    assert.match(messages.approvedFor, /cannot be submitted/);
    assert.match(messages.recordedByUserId, /cannot be submitted/);
    assert.match(messages.method, /derived from the endpoint/);

    // The rejected request recorded nothing.
    const approvals = await api()
      .get(`/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals`)
      .set(authHeaders(adminToken));
    assert.equal(approvals.body.data[0].status, 'PENDING');
    assert.equal(approvals.body.data[0].method, null);

    const badDecision = await api()
      .post(url)
      .set(authHeaders(picToken))
      .send({ decision: 'MAYBE' });
    assert.equal(badDecision.status, 400);
    assert.match(fieldMessages(badDecision).decision, /APPROVED, REJECTED/);
  });
});

describe('CR-HM-BE-03 RUN 4 — ASSISTED decision HTTP', () => {
  it('records an out-of-band decision with approved-for / recorded-by separation', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const staff = await createSessionWithPermissions([QUOTATION_READ, APPROVAL_RECORD]);
    // The admin (assigned to the building) is the recording staff actor for
    // the happy path; the scoped session proves the governed access gate.
    const url = `/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals/assisted-decision`;
    const recorded = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({
        decision: 'APPROVED',
        approvedFor: { type: 'TENANT_COMPANY', tenantCompanyId: ctx.tenant!.company.id },
        notes: 'Customer approved by phone call, verified with the building manager.',
      });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    const decision = recorded.body.data;
    assert.equal(decision.approval.status, 'APPROVED');
    assert.equal(decision.approval.method, 'ASSISTED');
    assert.equal(decision.approval.approvedForType, 'TENANT_COMPANY');
    assert.equal(decision.approval.approvedForTenantCompanyId, ctx.tenant!.company.id);
    assert.equal(decision.approval.approvedForName, 'Commerce HTTP Tenant');
    assert.equal(decision.approval.recordedByUserId, adminUserId);
    assert.equal(decision.quotation.status, 'APPROVED');
    assert.equal(decision.requestStatus, 'APPROVED');

    // The scoped staff session WITHOUT building access is denied by the service.
    const ctx2 = await makeSentContext();
    const denied = await api()
      .post(`/api/v1/handyman-quotations/${ctx2.sent.quotation.id}/approvals/assisted-decision`)
      .set(authHeaders(staff))
      .send({
        decision: 'APPROVED',
        approvedFor: { type: 'CUSTOMER' },
        notes: 'Phone approval',
      });
    assert.equal(denied.status, 403);
    assert.equal(err(denied).error.code, 'BUILDING_ACCESS_DENIED');

    // A manage-only session (no approval.record) is denied at the route gate.
    const noRecord = await createSessionWithPermissions([QUOTATION_READ, QUOTATION_MANAGE]);
    const gated = await api()
      .post(url)
      .set(authHeaders(noRecord))
      .send({ decision: 'APPROVED', approvedFor: { type: 'CUSTOMER' }, notes: 'x' });
    assert.equal(gated.status, 403);
    assert.equal(err(gated).error.code, 'PERMISSION_DENIED');
  });

  it('enforces mandatory notes, explicit approved-for and request-context validation', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const url = `/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals/assisted-decision`;

    const missingNotes = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({ decision: 'APPROVED', approvedFor: { type: 'CUSTOMER' } });
    assert.equal(missingNotes.status, 400);
    assert.equal(err(missingNotes).error.code, 'VALIDATION_ERROR');
    assert.match(fieldMessages(missingNotes).notes, /mandatory/);

    const emptyNotes = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({ decision: 'APPROVED', approvedFor: { type: 'CUSTOMER' }, notes: '   ' });
    assert.equal(emptyNotes.status, 400);

    const missingApprovedFor = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({ decision: 'APPROVED', notes: 'Phone approval' });
    assert.equal(missingApprovedFor.status, 400);
    assert.match(fieldMessages(missingApprovedFor).approvedFor, /explicitly identify/);

    const smuggledRecorder = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({
        decision: 'APPROVED',
        approvedFor: { type: 'CUSTOMER' },
        notes: 'Phone approval',
        recordedByUserId: ctx.tenant!.picUser.id,
      });
    assert.equal(smuggledRecorder.status, 400);
    assert.match(fieldMessages(smuggledRecorder).recordedByUserId, /derived only from the authenticated session/);

    // A tenant company from a DIFFERENT client is not valid approved-for identity.
    const foreignHierarchy = await createHierarchy();
    const foreignCompany = await tenantCompanyService.createTenantCompany(
      {
        clientId: foreignHierarchy.client.id,
        tenantCode: `TC_${suffix()}`,
        tenantName: 'Foreign Tenant',
      },
      adminUserId,
    );
    const wrongCompany = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({
        decision: 'APPROVED',
        approvedFor: { type: 'TENANT_COMPANY', tenantCompanyId: foreignCompany.id },
        notes: 'Phone approval',
      });
    assert.equal(wrongCompany.status, 400);
    assert.equal(err(wrongCompany).error.code, 'HANDYMAN_QUOTATION_APPROVAL_FOR_INVALID');

    const wrongPic = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({
        decision: 'REJECTED',
        approvedFor: { type: 'TENANT_PIC', tenantPicId: randomUUID() },
        notes: 'Phone rejection',
      });
    assert.equal(wrongPic.status, 400);
    assert.equal(err(wrongPic).error.code, 'HANDYMAN_QUOTATION_APPROVAL_FOR_INVALID');

    // The approval remains PENDING and undecided after all rejections.
    const approvals = await api()
      .get(`/api/v1/handyman-quotations/${ctx.sent.quotation.id}/approvals`)
      .set(authHeaders(adminToken));
    assert.equal(approvals.body.data[0].status, 'PENDING');

    // CUSTOMER approved-for takes its snapshot from the request, never the caller.
    const customer = await api()
      .post(url)
      .set(authHeaders(adminToken))
      .send({ decision: 'REJECTED', approvedFor: { type: 'CUSTOMER' }, notes: 'Customer declined by phone.' });
    assert.equal(customer.status, 200, JSON.stringify(customer.body));
    assert.equal(customer.body.data.approval.approvedForType, 'CUSTOMER');
    assert.equal(customer.body.data.approval.approvedForCustomerName, CUSTOMER_NAME);
    assert.equal(customer.body.data.approval.approvedForCustomerPhone, CUSTOMER_PHONE);
    assert.equal(customer.body.data.approval.recordedByUserId, adminUserId);
    assert.equal(customer.body.data.quotation.status, 'REJECTED');
    assert.equal(customer.body.data.requestStatus, 'QUOTATION_REJECTED');
  });
});

describe('CR-HM-BE-03 RUN 4 — re-quote loop and secure-link readiness HTTP', () => {
  it('runs the rejection → reopen → re-send → fresh approval loop over HTTP', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const quotationId = ctx.sent.quotation.id;
    const picToken = await loginTokenFor(ctx.tenant!.picUser.id, ctx.tenant!.picUser.email);

    const rejected = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/approvals/in-app-decision`)
      .set(authHeaders(picToken))
      .send({ decision: 'REJECTED', notes: 'Too expensive' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.quotation.status, 'REJECTED');
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_REJECTED');
    const firstApprovalId = rejected.body.data.approval.id;

    // Governed reopen: the SAME quotation opens its next DRAFT revision and
    // the request returns to its authoring phase.
    const reopened = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/revisions`)
      .set(authHeaders(adminToken))
      .send({ notes: 'Discounted round' });
    assert.equal(reopened.status, 201, JSON.stringify(reopened.body));
    assert.equal(reopened.body.data.revisionNumber, 2);
    assert.equal(await requestStatus(ctx.request.id), 'TRIAGED');

    const line = await api()
      .post(`/api/v1/handyman-quotation-revisions/${reopened.body.data.id}/lines`)
      .set(authHeaders(adminToken))
      .send({
        lineType: 'LABOR',
        serviceCatalogId: ctx.service.id,
        unitPrice: 135000,
        deviationNote: 'Loyalty discount agreed with operations',
      });
    assert.equal(line.status, 201, JSON.stringify(line.body));

    const submitted = await api()
      .post(`/api/v1/handyman-quotation-revisions/${reopened.body.data.id}/submit`)
      .set(authHeaders(adminToken));
    assert.equal(submitted.status, 200);

    const resent = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/send`)
      .set(authHeaders(adminToken))
      .send({ revisionId: reopened.body.data.id });
    assert.equal(resent.status, 200, JSON.stringify(resent.body));
    assert.equal(resent.body.data.quotation.status, 'SENT');
    assert.equal(resent.body.data.quotation.sentRevisionId, reopened.body.data.id);
    assert.equal(resent.body.data.approval.status, 'PENDING');
    assert.notEqual(resent.body.data.approval.id, firstApprovalId);

    // The rejected approval is immutable history; the new one is PENDING.
    const approvals = await api()
      .get(`/api/v1/handyman-quotations/${quotationId}/approvals`)
      .set(authHeaders(adminToken));
    const rows = approvals.body.data as { id: string; status: string; quotationRevisionId: string }[];
    assert.equal(rows.length, 2);
    const old = rows.find((row) => row.id === firstApprovalId);
    assert.ok(old);
    assert.equal(old.status, 'REJECTED');
    assert.equal(old.quotationRevisionId, ctx.sent.revision.id);

    // The linked PIC approves the new revision.
    const finalDecision = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/approvals/in-app-decision`)
      .set(authHeaders(picToken))
      .send({ decision: 'APPROVED' });
    assert.equal(finalDecision.status, 200);
    assert.equal(finalDecision.body.data.quotation.status, 'APPROVED');
    assert.equal(await requestStatus(ctx.request.id), 'APPROVED');

    // APPROVED is final — no further revisions or sends.
    const afterApproval = await api()
      .post(`/api/v1/handyman-quotations/${quotationId}/revisions`)
      .set(authHeaders(adminToken))
      .send({});
    assert.equal(afterApproval.status, 409);
  });

  it('issues the raw token exactly once and never exposes hashes on read surfaces', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const approvalId = ctx.sent.approval.id;
    const quotationId = ctx.sent.quotation.id;
    // A scoped session holding link.manage but WITHOUT building access —
    // the service access gate must still deny it.
    const unassignedLinkToken = await createSessionWithPermissions([QUOTATION_READ, LINK_MANAGE]);

    const issued = await api()
      .post(`/api/v1/handyman-quotation-approvals/${approvalId}/links`)
      .set(authHeaders(adminToken))
      .send({
        recipientName: 'Rina Tenant Contact',
        recipientPhone: CUSTOMER_PHONE,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const rawToken = issued.body.data.rawToken as string;
    assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.body.data.link.status, 'ACTIVE');
    assert.equal(issued.body.data.link.maxUses, 1);
    assert.equal(issued.body.data.link.usesCount, 0);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    assert.ok(!JSON.stringify(issued.body.data.link).includes(tokenHash));
    assert.ok(!JSON.stringify(issued.body.data.link).includes(rawToken));

    // One ACTIVE link per approval.
    const duplicate = await api()
      .post(`/api/v1/handyman-quotation-approvals/${approvalId}/links`)
      .set(authHeaders(adminToken))
      .send({ recipientName: 'Rina', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(duplicate.status, 409);
    assert.equal(err(duplicate).error.code, 'HANDYMAN_QUOTATION_APPROVAL_LINK_ALREADY_ACTIVE');

    // Past expiry rejected.
    await api()
      .post(`/api/v1/handyman-quotation-approval-links/${issued.body.data.link.id}/revoke`)
      .set(authHeaders(adminToken));
    const pastExpiry = await api()
      .post(`/api/v1/handyman-quotation-approvals/${approvalId}/links`)
      .set(authHeaders(adminToken))
      .send({ recipientName: 'Rina', expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(pastExpiry.status, 400);

    // Token/hash internals cannot be smuggled into issuance.
    const smuggled = await api()
      .post(`/api/v1/handyman-quotation-approvals/${approvalId}/links`)
      .set(authHeaders(adminToken))
      .send({
        recipientName: 'Rina',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        token: 'forged-token',
        maxUses: 5,
      });
    assert.equal(smuggled.status, 400);
    const messages = fieldMessages(smuggled);
    assert.match(messages.token, /generated server-side/);
    assert.match(messages.maxUses, /fixed at 1/);

    // Re-issue after revoke produces a fresh token.
    const reissued = await api()
      .post(`/api/v1/handyman-quotation-approvals/${approvalId}/links`)
      .set(authHeaders(adminToken))
      .send({ recipientName: 'Rina', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(reissued.status, 201);
    assert.notEqual(reissued.body.data.rawToken, rawToken);
    const linkId = reissued.body.data.link.id as string;

    // Permissioned but unassigned staff are denied by the governed access gate.
    const deniedLinkRead = await api()
      .get(`/api/v1/handyman-quotation-approval-links/${linkId}`)
      .set(authHeaders(unassignedLinkToken));
    assert.equal(deniedLinkRead.status, 403);
    assert.equal(err(deniedLinkRead).error.code, 'BUILDING_ACCESS_DENIED');

    // Metadata reads never expose the token or its hash.
    const single = await api()
      .get(`/api/v1/handyman-quotation-approval-links/${linkId}`)
      .set(authHeaders(adminToken));
    assert.equal(single.status, 200);
    const listed = await api()
      .get(`/api/v1/handyman-quotations/${quotationId}/approval-links`)
      .set(authHeaders(adminToken));
    assert.equal(listed.status, 200);
    assert.equal((listed.body.data as unknown[]).length, 2);
    const secondHash = createHash('sha256')
      .update(reissued.body.data.rawToken as string)
      .digest('hex');
    for (const body of [JSON.stringify(single.body), JSON.stringify(listed.body)]) {
      assert.ok(!body.includes(secondHash));
      assert.ok(!body.includes(reissued.body.data.rawToken));
      assert.ok(!body.toLowerCase().includes('tokenhash'));
    }

    // Revoke is guarded; double revoke conflicts.
    const revoked = await api()
      .post(`/api/v1/handyman-quotation-approval-links/${linkId}/revoke`)
      .set(authHeaders(adminToken));
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.status, 'REVOKED');
    const again = await api()
      .post(`/api/v1/handyman-quotation-approval-links/${linkId}/revoke`)
      .set(authHeaders(adminToken));
    assert.equal(again.status, 409);
    assert.equal(err(again).error.code, 'HANDYMAN_QUOTATION_APPROVAL_LINK_STATE_INVALID');

    // The stored hash matches the raw token exactly once issued.
    const stored = await pool!.query(
      'SELECT token_hash FROM handyman_quotation_approval_links WHERE id = $1',
      [linkId],
    );
    assert.equal(stored.rows[0].token_hash, secondHash);
  });

  it('exposes no public resolve/decide/consume route and no anonymous approval surface', async (t) => {
    if (!ready(t)) return;
    const id = randomUUID();
    const anonymousCandidates = [
      ['post', `/api/v1/handyman-quotation-approval-links/resolve`],
      ['post', `/api/v1/handyman-quotation-approvals/resolve`],
      ['get', `/api/v1/handyman-quotation-approval-links/${id}/token`],
      ['post', `/api/v1/handyman-quotation-approval-links/${id}/consume`],
      ['post', `/api/v1/handyman-quotations/${id}/approvals/decide`],
      ['get', `/api/v1/handyman-quotations/${id}/approvals/decide`],
      ['post', `/api/v1/handyman-approvals/${id}/decide`],
      ['get', `/api/v1/handyman-approval-links/${id}`],
    ] as const;
    const agent = api() as unknown as Record<string, (url: string) => SupertestCall>;
    for (const [method, url] of anonymousCandidates) {
      const anon = (await agent[method](url)) as unknown as { status: number };
      assert.equal(anon.status, 404, `${method.toUpperCase()} ${url} must not exist`);
      const authed = (await agent[method](url).set(authHeaders(adminToken))) as unknown as {
        status: number;
      };
      assert.equal(authed.status, 404, `${method.toUpperCase()} ${url} must not exist even for admins`);
    }

    // The internal consumption primitive is not part of the module surface.
    assert.ok(
      !('consumeApprovalLinkTokenInternal' in handymanQuotationModule),
      'consumeApprovalLinkTokenInternal must not be exported from the module index',
    );

    // No route registration carries a token/resolve/consume/public segment.
    const approvalRoutes = readFileSync(
      resolve(__dirname, '../src/modules/handyman-quotations/handyman-quotation-approval.routes.ts'),
      'utf8',
    );
    const registeredPaths = [
      ...approvalRoutes.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g),
    ].map((match) => match[1]);
    assert.ok(registeredPaths.length >= 8);
    for (const path of registeredPaths) {
      assert.ok(
        !/token|resolve|consume|public|anonymous/i.test(path),
        `route ${path} must not exist`,
      );
    }
  });
});

describe('CR-HM-BE-03 RUN 4 — runtime/OpenAPI parity', () => {
  const CR03_TAGS = new Set([
    'Handyman Request Governance',
    'Handyman Quotations',
    'Handyman Quotation Approvals',
  ]);

  type Spec = {
    paths: Record<
      string,
      Record<string, { 'x-required-permission'?: string; tags?: string[]; operationId?: string }>
    >;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };

  function loadSpec(): Spec {
    return parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as Spec;
  }

  function runtimeOperations(): Record<string, Set<string>> {
    const files = [
      '../src/modules/handyman-request-governance/handyman-request-governance.routes.ts',
      '../src/modules/handyman-quotations/handyman-quotation.routes.ts',
      '../src/modules/handyman-quotations/handyman-quotation-approval.routes.ts',
    ];
    const operations: Record<string, Set<string>> = {};
    for (const file of files) {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
        const method = match[1];
        const path = match[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        (operations[path] ??= new Set()).add(method);
      }
    }
    return operations;
  }

  it('documents exactly the CR03 runtime operation set with permission parity', async (t) => {
    if (!ready(t)) return;
    const spec = loadSpec();
    const runtime = runtimeOperations();

    const documented: Record<string, Set<string>> = {};
    for (const [path, item] of Object.entries(spec.paths)) {
      const methods = Object.keys(item).filter((method) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      );
      const cr03 = methods.filter((method) =>
        (item[method].tags ?? []).some((tag) => CR03_TAGS.has(tag)),
      );
      if (cr03.length > 0) {
        assert.equal(
          cr03.length,
          methods.length,
          `${path} mixes CR03 and non-CR03 operations`,
        );
        documented[path] = new Set(cr03);
      }
    }

    // Exact set parity in BOTH directions: no undocumented CR03 route and no
    // documented-but-unimplemented CR03 route.
    assert.deepEqual(
      Object.keys(documented).sort(),
      Object.keys(runtime).sort(),
      'documented CR03 paths must equal the runtime CR03 paths',
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
    assert.equal(operationCount, 33);

    // x-required-permission parity (minimum correct permission per operation;
    // the IN_APP decision is authenticated-only and must carry NO permission).
    const expectedPermissions: Record<string, Record<string, string | null>> = {
      '/handyman-requests/{handymanRequestId}/triages': {
        post: 'handyman_triage.manage',
        get: 'handyman_request.read',
      },
      '/handyman-request-triages/{triageId}': { get: 'handyman_request.read' },
      '/handyman-requests/{handymanRequestId}/services': {
        post: 'handyman_request_service.manage',
        get: 'handyman_request.read',
      },
      '/handyman-request-services/{selectionId}': { get: 'handyman_request.read' },
      '/handyman-request-services/{selectionId}/supersede': {
        post: 'handyman_request_service.manage',
      },
      '/handyman-requests/{handymanRequestId}/inspections': {
        post: 'handyman_inspection.manage',
        get: 'handyman_request.read',
      },
      '/handyman-inspections/{inspectionId}': { get: 'handyman_request.read' },
      '/handyman-inspections/{inspectionId}/complete': { post: 'handyman_inspection.manage' },
      '/handyman-inspections/{inspectionId}/cancel': { post: 'handyman_inspection.manage' },
      '/handyman-requests/{handymanRequestId}/quotations': {
        post: 'handyman_quotation.manage',
        get: 'handyman_quotation.read',
      },
      '/handyman-quotations/{quotationId}': { get: 'handyman_quotation.read' },
      '/handyman-quotations/{quotationId}/send': { post: 'handyman_quotation.send' },
      '/handyman-quotations/{quotationId}/withdraw': { post: 'handyman_quotation.manage' },
      '/handyman-quotations/{quotationId}/revisions': {
        post: 'handyman_quotation.manage',
        get: 'handyman_quotation.read',
      },
      '/handyman-quotation-revisions/{revisionId}': { get: 'handyman_quotation.read' },
      '/handyman-quotation-revisions/{revisionId}/submit': { post: 'handyman_quotation.manage' },
      '/handyman-quotation-revisions/{revisionId}/lines': {
        post: 'handyman_quotation.manage',
        get: 'handyman_quotation.read',
      },
      '/handyman-quotation-lines/{lineId}': {
        patch: 'handyman_quotation.manage',
        delete: 'handyman_quotation.manage',
      },
      '/handyman-quotations/{quotationId}/approvals': { get: 'handyman_quotation.read' },
      '/handyman-quotation-approvals/{approvalId}': { get: 'handyman_quotation.read' },
      '/handyman-quotations/{quotationId}/approvals/in-app-decision': { post: null },
      '/handyman-quotations/{quotationId}/approvals/assisted-decision': {
        post: 'handyman_quotation_approval.record',
      },
      '/handyman-quotation-approvals/{approvalId}/links': {
        post: 'handyman_quotation_approval_link.manage',
      },
      '/handyman-quotations/{quotationId}/approval-links': {
        get: 'handyman_quotation_approval_link.manage',
      },
      '/handyman-quotation-approval-links/{linkId}': {
        get: 'handyman_quotation_approval_link.manage',
      },
      '/handyman-quotation-approval-links/{linkId}/revoke': {
        post: 'handyman_quotation_approval_link.manage',
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
        if (permission === null) {
          assert.equal(
            operation['x-required-permission'],
            undefined,
            `${method.toUpperCase()} ${path} must be authentication-only`,
          );
        } else {
          assert.equal(
            operation['x-required-permission'],
            permission,
            `${method.toUpperCase()} ${path} permission`,
          );
        }
      }
    }

    // The runtime route sources wire exactly these permission codes.
    const allRoutesSource = [
      '../src/modules/handyman-request-governance/handyman-request-governance.routes.ts',
      '../src/modules/handyman-quotations/handyman-quotation.routes.ts',
      '../src/modules/handyman-quotations/handyman-quotation-approval.routes.ts',
    ]
      .map((file) => readFileSync(resolve(__dirname, file), 'utf8'))
      .join('\n');
    for (const code of [
      'handyman_request.read',
      'handyman_triage.manage',
      'handyman_request_service.manage',
      'handyman_inspection.manage',
      'handyman_quotation.read',
      'handyman_quotation.manage',
      'handyman_quotation.send',
      'handyman_quotation_approval.record',
      'handyman_quotation_approval_link.manage',
    ]) {
      assert.ok(
        allRoutesSource.includes(`requirePermission('${code}')`),
        `runtime must gate with ${code}`,
      );
    }
    // The IN_APP route carries authentication but NO permission middleware.
    const approvalRoutes = readFileSync(
      resolve(__dirname, '../src/modules/handyman-quotations/handyman-quotation-approval.routes.ts'),
      'utf8',
    );
    const inAppBlock = approvalRoutes.split('in-app-decision')[1].split(');')[0];
    assert.ok(!inAppBlock.includes('requirePermission'));
  });

  it('documents strict body allowlists, hash-free link models and the SECURE_LINK deferral', async (t) => {
    if (!ready(t)) return;
    const spec = loadSpec();
    const schemas = spec.components.schemas;

    const expectedBodyKeys: Record<string, string[]> = {
      TriageHandymanRequest: ['notes', 'path'],
      SelectHandymanRequestService: ['serviceCatalogId', 'source'],
      OpenHandymanInspection: ['checklistExecutionId'],
      CompleteHandymanInspection: ['diagnosis', 'scopeNotes'],
      CreateHandymanQuotation: ['currency'],
      CreateHandymanQuotationRevision: ['notes', 'validUntil'],
      AddHandymanQuotationLine: [
        'description',
        'deviationNote',
        'inventoryItemId',
        'lineType',
        'quantity',
        'serviceCatalogId',
        'unitPrice',
        'uomId',
      ],
      UpdateHandymanQuotationLine: ['description', 'deviationNote', 'quantity', 'unitPrice'],
      SendHandymanQuotation: ['revisionId'],
      DecideHandymanQuotationApprovalInApp: ['decision', 'notes'],
      RecordHandymanQuotationApprovalAssisted: ['approvedFor', 'decision', 'notes'],
      IssueHandymanQuotationApprovalLink: [
        'expiresAt',
        'recipientEmail',
        'recipientName',
        'recipientPhone',
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

    // Read models that must never carry token/hash internals.
    const linkKeys = Object.keys(schemas.HandymanQuotationApprovalLink.properties ?? {});
    for (const forbidden of ['token', 'rawToken', 'tokenHash']) {
      assert.ok(!linkKeys.includes(forbidden), `${forbidden} must never be documented on the link read model`);
    }
    assert.deepEqual(
      Object.keys(schemas.IssueHandymanQuotationApprovalLinkResult.properties ?? {}).sort(),
      ['link', 'rawToken'],
    );
    assert.deepEqual(
      Object.keys(schemas.HandymanQuotationApprovalDecisionResult.properties ?? {}).sort(),
      ['approval', 'quotation', 'requestStatus'],
    );
    assert.deepEqual(Object.keys(schemas.HandymanQuotationTotals.properties ?? {}).sort(), [
      'grandTotal',
      'laborTotal',
      'materialTotal',
      'otherTotal',
    ]);
    // The approval read model preserves the approved-for / recorded-by split.
    const approvalKeys = Object.keys(schemas.HandymanQuotationApproval.properties ?? {});
    for (const required of [
      'approvedForType',
      'approvedForTenantCompanyId',
      'approvedForTenantPicId',
      'approvedForName',
      'approvedForCustomerName',
      'recordedByUserId',
      'method',
      'decisionNotes',
    ]) {
      assert.ok(approvalKeys.includes(required), `approval schema must document ${required}`);
    }

    // The SECURE_LINK public-surface deferral is explicitly documented.
    const specText = readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8');
    assert.ok(specText.includes('NOT available in CR-HM-BE-03'));
    assert.ok(specText.includes('deferred pending'));
    assert.ok(specText.includes('exactly once') || specText.includes('EXACTLY ONCE'));
  });
});
