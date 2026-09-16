import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { floorService } from '../src/modules/floors';
import {
  createHandymanRequest,
  getHandymanRequestById,
} from '../src/modules/handyman-requests';
import {
  selectHandymanRequestService,
  supersedeHandymanRequestServiceSelection,
  triageHandymanRequest,
} from '../src/modules/handyman-request-governance';
import * as handymanQuotationModule from '../src/modules/handyman-quotations';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  decideHandymanQuotationApprovalInApp,
  getHandymanQuotation,
  getHandymanQuotationApproval,
  getHandymanQuotationApprovalLink,
  handymanQuotationApprovalRepository,
  handymanQuotationApprovalService,
  issueHandymanQuotationApprovalLink,
  listHandymanQuotationApprovalLinks,
  listHandymanQuotationApprovals,
  recordHandymanQuotationApprovalAssistedDecision,
  revokeHandymanQuotationApprovalLink,
  sendHandymanQuotation,
  submitHandymanQuotationRevision,
  withdrawHandymanQuotation,
} from '../src/modules/handyman-quotations';
import { consumeApprovalLinkTokenInternal } from '../src/modules/handyman-quotations/handyman-quotation-approval-link.service';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { supportingDocumentService } from '../src/modules/supporting-documents';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-03 RUN 3 — focused tests for the customer approval authority:
 * send-composed PENDING approvals bound to the exact sent revision, IN_APP
 * decisions by the authorized tenant PIC, ASSISTED staff recording with
 * explicit approved-for separation, once-only guarded decisions with
 * atomic downstream quotation/request transitions, the post-rejection
 * same-identity re-quote loop with a fresh approval, secure-link
 * persistence/readiness (hash-only single-use tokens, NO public decision
 * surface), evidence attachment through the existing supporting-documents
 * foundation, and the audit/PII conventions.
 */

const PORT = 55484;
const DIR = '/tmp/asentra-hm03-run3-pg';
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
let outsiderUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const CUSTOMER_NAME = 'Rina Tenant Contact';
const CUSTOMER_PHONE = '+6281298765001';
const CUSTOMER_EMAIL = 'rina@customer.example.com';

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
  adminUserId = admin.userId;
  const outsider = await userService.createUser({
    email: `outsider-${suffix().toLowerCase()}@example.com`,
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

async function createHierarchy(options: { client?: PublicClient } = {}) {
  const client =
    options.client ??
    (await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Approval Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Approval Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Approval Tower',
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

/** Governed tenant foundation: company + ACTIVE building context + PIC linked
 * to a dedicated user (the CR-HM-BE-03 IN_APP authorization chain). */
async function makeTenantContext(h: {
  client: { id: string };
  building: { id: string };
  space: { id: string };
}) {
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: h.client.id,
      tenantCode: `TC_${suffix()}`,
      tenantName: 'Approval Tenant Company',
    },
    adminUserId,
  );
  // The tenant foundation requires an ACTIVE space relationship in the
  // building before an ACTIVE building context can exist.
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
    email: `pic-${suffix().toLowerCase()}@tenant.example.com`,
    displayName: 'Tenant PIC User',
  });
  // The PIC user needs client access to be linkable (tenant foundation rule).
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: h.building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      userId: picUser.id,
      picName: 'Pak Joko PIC',
      email: `pic-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000001',
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
      name: 'Approval Service',
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

/**
 * Full governed chain through SEND: hierarchy → tenant context → request →
 * selection → QUOTATION triage → quotation → priced LABOR line → SUBMITTED
 * revision → SENT (which composes the PENDING approval).
 */
async function makeSentContext(options: { withTenant?: boolean } = {}) {
  const withTenant = options.withTenant ?? true;
  const h = await createHierarchy();
  const tenant = withTenant ? await makeTenantContext(h) : null;
  const request = await createRequest(
    h,
    tenant ? { company: tenant.company, pic: tenant.pic } : undefined,
  );
  const service = await createService(h.client.id);
  await triageHandymanRequest(
    { requestId: request.id, path: 'QUOTATION', notes: 'Known scope' },
    adminUserId,
  );
  const selection = await selectHandymanRequestService(
    { requestId: request.id, serviceCatalogId: service.id, source: 'TRIAGE' },
    adminUserId,
  );
  const quotation = await createHandymanQuotation(
    { requestId: request.id, currency: 'IDR' },
    adminUserId,
  );
  await makeServicePrice(h.client.id, service.id, 150000);
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
    { quotationId: quotation.quotation.id, revisionId: quotation.revision.id },
    adminUserId,
  );
  return { h, tenant, request, service, selection, quotation, sent };
}

async function requestStatus(requestId: string): Promise<string> {
  const record = await getHandymanRequestById(requestId, adminUserId);
  return record.status;
}

async function eventsFor(entityId: string) {
  const result = await pool!.query(
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

describe('CR-HM-BE-03 RUN 3 — approval creation via governed send', () => {
  it('creates exactly one PENDING approval bound to the exact sent revision', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    assert.equal(ctx.sent.approval.status, 'PENDING');
    assert.equal(ctx.sent.approval.quotationId, ctx.sent.quotation.id);
    assert.equal(ctx.sent.approval.quotationRevisionId, ctx.sent.quotation.sentRevisionId);
    assert.equal(ctx.sent.approval.method, null);
    assert.equal(ctx.sent.approval.approvedForType, null);
    assert.equal(ctx.sent.approval.recordedByUserId, null);
    assert.equal(ctx.sent.approval.decidedAt, null);
    assert.equal(ctx.sent.approval.decisionNotes, null);
    assert.equal(ctx.sent.approval.createdByUserId, adminUserId);

    const rows = await pool!.query(
      'SELECT count(*)::int AS n FROM handyman_quotation_approvals WHERE quotation_id = $1',
      [ctx.sent.quotation.id],
    );
    assert.equal(rows.rows[0].n, 1);

    const events = await eventsFor(ctx.sent.approval.id);
    assert.equal(
      events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_APPROVAL_CREATED').length,
      1,
    );
  });

  it('has no approval before send and none for non-sent revisions', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const tenant = await makeTenantContext(h);
    const request = await createRequest(h, tenant);
    const service = await createService(h.client.id);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);
    await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: service.id, source: 'TRIAGE' },
      adminUserId,
    );
    const quotation = await createHandymanQuotation(
      { requestId: request.id, currency: 'IDR' },
      adminUserId,
    );
    // DRAFT quotation with a DRAFT revision: no approval surface exists.
    const approvals = await listHandymanQuotationApprovals(
      quotation.quotation.id,
      adminUserId,
    );
    assert.equal(approvals.length, 0);
    // Deciding before send fails closed.
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: quotation.quotation.id, decision: 'APPROVED' },
        tenant.picUser.id,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID',
      409,
    );

    // Structural proof: an approval for a FOREIGN revision is impossible
    // (composite FK binds approval → revision → same quotation). The foreign
    // revision comes from an UNSENT quotation so no PENDING-approval unique
    // index can mask the FK violation.
    const foreignHierarchy = await createHierarchy();
    const foreignRequest = await createRequest(foreignHierarchy);
    await triageHandymanRequest(
      { requestId: foreignRequest.id, path: 'QUOTATION' },
      adminUserId,
    );
    const foreignQuotation = await createHandymanQuotation(
      { requestId: foreignRequest.id, currency: 'IDR' },
      adminUserId,
    );
    await assert.rejects(
      handymanQuotationApprovalRepository.createPending({
        quotationId: quotation.quotation.id,
        quotationRevisionId: foreignQuotation.revision.id,
        clientId: h.client.id,
        buildingId: h.building.id,
        createdByUserId: adminUserId,
      }),
      (error: { code?: string }) => error.code === '23503',
    );
  });

  it('enforces one PENDING approval per revision and per quotation', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    // Structural: a second PENDING row for the same revision is impossible.
    await assert.rejects(
      handymanQuotationApprovalRepository.createPending({
        quotationId: ctx.sent.quotation.id,
        quotationRevisionId: ctx.sent.revision.id,
        clientId: ctx.h.client.id,
        buildingId: ctx.h.building.id,
        createdByUserId: adminUserId,
      }),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23505' &&
        error.constraint === 'handyman_quotation_approvals_one_pending_per_revision',
    );

    // Service-level across the send cycle: withdraw expires the PENDING
    // approval; the re-sent revision gets a new one; exactly one PENDING
    // exists at any time.
    await withdrawHandymanQuotation(ctx.sent.quotation.id, adminUserId);
    let pending = await pool!.query(
      `SELECT count(*)::int AS n FROM handyman_quotation_approvals
       WHERE quotation_id = $1 AND status = 'PENDING'`,
      [ctx.sent.quotation.id],
    );
    assert.equal(pending.rows[0].n, 0);
    const expired = await pool!.query(
      `SELECT status, method, approved_for_type FROM handyman_quotation_approvals
       WHERE id = $1`,
      [ctx.sent.approval.id],
    );
    assert.equal(expired.rows[0].status, 'EXPIRED');
    assert.equal(expired.rows[0].method, null);
    assert.equal(expired.rows[0].approved_for_type, null);

    const rev2 = await createHandymanQuotationRevision(
      { quotationId: ctx.sent.quotation.id },
      adminUserId,
    );
    await addHandymanQuotationLine(
      {
        revisionId: rev2.id,
        lineType: 'OTHER',
        description: 'Post-withdrawal line',
        unitPrice: 20000,
      },
      adminUserId,
    );
    await submitHandymanQuotationRevision(rev2.id, adminUserId);
    const resent = await sendHandymanQuotation(
      { quotationId: ctx.sent.quotation.id, revisionId: rev2.id },
      adminUserId,
    );
    assert.equal(resent.approval.quotationRevisionId, rev2.id);
    pending = await pool!.query(
      `SELECT count(*)::int AS n FROM handyman_quotation_approvals
       WHERE quotation_id = $1 AND status = 'PENDING'`,
      [ctx.sent.quotation.id],
    );
    assert.equal(pending.rows[0].n, 1);
  });
});

describe('CR-HM-BE-03 RUN 3 — IN_APP tenant PIC decisions', () => {
  it('approves through the linked tenant PIC with atomic downstream transitions', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const result = await decideHandymanQuotationApprovalInApp(
      { quotationId: ctx.sent.quotation.id, decision: 'APPROVED', notes: '  Agreed to proceed  ' },
      ctx.tenant!.picUser.id,
    );

    // Approval evidence.
    assert.equal(result.approval.status, 'APPROVED');
    assert.equal(result.approval.method, 'IN_APP');
    assert.equal(result.approval.approvedForType, 'TENANT_PIC');
    assert.equal(result.approval.approvedForTenantPicId, ctx.tenant!.pic.id);
    assert.equal(result.approval.approvedForTenantCompanyId, ctx.tenant!.company.id);
    assert.equal(result.approval.approvedForName, 'Pak Joko PIC');
    assert.equal(result.approval.recordedByUserId, null);
    assert.equal(result.approval.decisionNotes, 'Agreed to proceed');
    assert.ok(result.approval.decidedAt);
    // Quotation + request transitions.
    assert.equal(result.quotation.status, 'APPROVED');
    assert.equal(result.quotation.sentRevisionId, ctx.sent.revision.id);
    assert.equal(result.requestStatus, 'APPROVED');
    assert.equal(await requestStatus(ctx.request.id), 'APPROVED');

    const events = await eventsFor(result.approval.id);
    const approved = events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_APPROVED');
    assert.equal(approved.length, 1);
    assert.equal(approved[0].metadata.method, 'IN_APP');
    assert.equal(approved[0].metadata.approvedForType, 'TENANT_PIC');
    assert.equal(approved[0].metadata.requestStatus, 'APPROVED');

    // Decide-once: the decision can never be repeated or reversed.
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'REJECTED' },
        ctx.tenant!.picUser.id,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID',
      409,
    );
    const stored = await getHandymanQuotationApproval(result.approval.id, adminUserId);
    assert.equal(stored.status, 'APPROVED');
  });

  it('rejects through the linked tenant PIC and moves the request to QUOTATION_REJECTED', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const result = await decideHandymanQuotationApprovalInApp(
      { quotationId: ctx.sent.quotation.id, decision: 'REJECTED', notes: 'Price too high' },
      ctx.tenant!.picUser.id,
    );
    assert.equal(result.approval.status, 'REJECTED');
    assert.equal(result.approval.method, 'IN_APP');
    assert.equal(result.quotation.status, 'REJECTED');
    assert.equal(result.requestStatus, 'QUOTATION_REJECTED');
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_REJECTED');

    const events = await eventsFor(result.approval.id);
    assert.equal(
      events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_REJECTED').length,
      1,
    );

    // Decide-once on the rejected approval too.
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
        ctx.tenant!.picUser.id,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID',
      409,
    );
  });

  it('rejects wrong PIC, wrong tenant company, and unlinked actors', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    // Unlinked staff actor (admin has building access but is NOT the PIC).
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED',
      403,
    );
    // Fully external user.
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
        outsiderUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED',
      403,
    );
    // A DIFFERENT (also linked) PIC of the same company is still the wrong PIC.
    const otherPicUser = await userService.createUser({
      email: `pic2-${suffix().toLowerCase()}@tenant.example.com`,
      displayName: 'Second PIC User',
    });
    await buildingAssignmentService.createAssignment(otherPicUser.id, {
      buildingId: ctx.h.building.id,
    });
    await tenantPicService.createTenantPic(
      {
        tenantCompanyId: ctx.tenant!.company.id,
        userId: otherPicUser.id,
        picName: 'Bu Sri Second PIC',
      },
      adminUserId,
    );
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
        otherPicUser.id,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED',
      403,
    );
    // A PIC of ANOTHER tenant company (wrong tenant company link).
    const otherCompany = await tenantCompanyService.createTenantCompany(
      {
        clientId: ctx.h.client.id,
        tenantCode: `TC2_${suffix()}`,
        tenantName: 'Other Tenant Company',
      },
      adminUserId,
    );
    const otherCompanyPicUser = await userService.createUser({
      email: `pic3-${suffix().toLowerCase()}@tenant.example.com`,
      displayName: 'Other Company PIC User',
    });
    await buildingAssignmentService.createAssignment(otherCompanyPicUser.id, {
      buildingId: ctx.h.building.id,
    });
    await tenantPicService.createTenantPic(
      {
        tenantCompanyId: otherCompany.id,
        userId: otherCompanyPicUser.id,
        picName: 'Other Company PIC',
      },
      adminUserId,
    );
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
        otherCompanyPicUser.id,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED',
      403,
    );

    // Nothing moved.
    const stored = await getHandymanQuotation(ctx.sent.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, 'SENT');
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_PENDING');
  });

  it('derives actor identity from the session parameter only and ignores smuggled authority fields', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    // Smuggled approvedFor / recordedBy fields are NOT part of the IN_APP
    // input contract and never influence the resolved authority.
    const smuggled = {
      quotationId: ctx.sent.quotation.id,
      decision: 'APPROVED' as const,
      approvedFor: { type: 'CUSTOMER' },
      recordedByUserId: adminUserId,
    };
    const result = await decideHandymanQuotationApprovalInApp(
      smuggled,
      ctx.tenant!.picUser.id,
    );
    assert.equal(result.approval.approvedForType, 'TENANT_PIC');
    assert.equal(result.approval.approvedForTenantPicId, ctx.tenant!.pic.id);
    assert.equal(result.approval.recordedByUserId, null);

    // A request WITHOUT a tenant PIC has no IN_APP channel at all.
    const noTenant = await makeSentContext({ withTenant: false });
    await expectError(
      decideHandymanQuotationApprovalInApp(
        { quotationId: noTenant.sent.quotation.id, decision: 'APPROVED' },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED',
      403,
    );
  });
});

describe('CR-HM-BE-03 RUN 3 — ASSISTED staff recording', () => {
  it('records an out-of-band TENANT_COMPANY approval with separated approved-for/recorded-by', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const result = await recordHandymanQuotationApprovalAssistedDecision(
      {
        quotationId: ctx.sent.quotation.id,
        decision: 'APPROVED',
        approvedFor: { type: 'TENANT_COMPANY', tenantCompanyId: ctx.tenant!.company.id },
        notes: 'Tenant approved via WhatsApp call with finance director',
      },
      adminUserId,
    );

    assert.equal(result.approval.status, 'APPROVED');
    assert.equal(result.approval.method, 'ASSISTED');
    assert.equal(result.approval.approvedForType, 'TENANT_COMPANY');
    assert.equal(result.approval.approvedForTenantCompanyId, ctx.tenant!.company.id);
    assert.equal(result.approval.approvedForName, 'Approval Tenant Company');
    // RECORDED BY is preserved SEPARATELY: staff recorded, company decided.
    assert.equal(result.approval.recordedByUserId, adminUserId);
    assert.notEqual(result.approval.recordedByUserId, result.approval.approvedForTenantCompanyId);
    assert.equal(result.approval.decisionNotes, 'Tenant approved via WhatsApp call with finance director');
    assert.equal(result.quotation.status, 'APPROVED');
    assert.equal(result.requestStatus, 'APPROVED');
    assert.equal(await requestStatus(ctx.request.id), 'APPROVED');

    const events = await eventsFor(result.approval.id);
    const approved = events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_APPROVED');
    assert.equal(approved.length, 1);
    assert.equal(approved[0].metadata.method, 'ASSISTED');
    assert.equal(approved[0].metadata.recordedByUserId, adminUserId);
  });

  it('requires explicit approved-for identification and mandatory notes', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    // Missing approvedFor entirely — staff NEVER silently becomes the party.
    await expectError(
      recordHandymanQuotationApprovalAssistedDecision(
        {
          quotationId: ctx.sent.quotation.id,
          decision: 'APPROVED',
          notes: 'Some note',
        } as never,
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_FOR_INVALID',
      400,
    );
    // Missing notes.
    await expectError(
      recordHandymanQuotationApprovalAssistedDecision(
        {
          quotationId: ctx.sent.quotation.id,
          decision: 'APPROVED',
          approvedFor: { type: 'CUSTOMER' },
          notes: '',
        } as never,
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOTES_REQUIRED',
      400,
    );
    await expectError(
      recordHandymanQuotationApprovalAssistedDecision(
        {
          quotationId: ctx.sent.quotation.id,
          decision: 'APPROVED',
          approvedFor: { type: 'CUSTOMER' },
        } as never,
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOTES_REQUIRED',
      400,
    );
    // Nothing moved.
    const stored = await getHandymanQuotation(ctx.sent.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, 'SENT');
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_PENDING');
  });

  it('validates the approved-for identity against the request context', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    // TENANT_PIC that is not the request's PIC.
    const otherPicUser = await userService.createUser({
      email: `pic9-${suffix().toLowerCase()}@tenant.example.com`,
      displayName: 'Unrelated PIC User',
    });
    await buildingAssignmentService.createAssignment(otherPicUser.id, {
      buildingId: ctx.h.building.id,
    });
    const otherPic = await tenantPicService.createTenantPic(
      {
        tenantCompanyId: ctx.tenant!.company.id,
        userId: otherPicUser.id,
        picName: 'Unrelated PIC',
      },
      adminUserId,
    );
    await expectError(
      recordHandymanQuotationApprovalAssistedDecision(
        {
          quotationId: ctx.sent.quotation.id,
          decision: 'APPROVED',
          approvedFor: { type: 'TENANT_PIC', tenantPicId: otherPic.id },
          notes: 'Should fail — wrong PIC identity',
        },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_FOR_INVALID',
      400,
    );

    // TENANT_COMPANY that is not the request's company.
    const otherCompany = await tenantCompanyService.createTenantCompany(
      { clientId: ctx.h.client.id, tenantCode: `TC8_${suffix()}`, tenantName: 'Other Co' },
      adminUserId,
    );
    await expectError(
      recordHandymanQuotationApprovalAssistedDecision(
        {
          quotationId: ctx.sent.quotation.id,
          decision: 'APPROVED',
          approvedFor: { type: 'TENANT_COMPANY', tenantCompanyId: otherCompany.id },
          notes: 'Should fail — wrong company identity',
        },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_FOR_INVALID',
      400,
    );

    // The request's own TENANT_PIC is valid and snapshots the PIC identity.
    const result = await recordHandymanQuotationApprovalAssistedDecision(
      {
        quotationId: ctx.sent.quotation.id,
        decision: 'REJECTED',
        approvedFor: { type: 'TENANT_PIC', tenantPicId: ctx.tenant!.pic.id },
        notes: 'PIC declined the offer by phone on behalf of the tenant',
      },
      adminUserId,
    );
    assert.equal(result.approval.approvedForType, 'TENANT_PIC');
    assert.equal(result.approval.approvedForTenantPicId, ctx.tenant!.pic.id);
    assert.equal(result.approval.approvedForName, 'Pak Joko PIC');
    assert.equal(result.approval.recordedByUserId, adminUserId);
    assert.equal(result.quotation.status, 'REJECTED');
    assert.equal(result.requestStatus, 'QUOTATION_REJECTED');
  });

  it('snapshots the CUSTOMER party from the request and requires staff building access', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext({ withTenant: false });

    // Outsider staff cannot record.
    await expectError(
      recordHandymanQuotationApprovalAssistedDecision(
        {
          quotationId: ctx.sent.quotation.id,
          decision: 'APPROVED',
          approvedFor: { type: 'CUSTOMER' },
          notes: 'Outsider attempt',
        },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );

    const result = await recordHandymanQuotationApprovalAssistedDecision(
      {
        quotationId: ctx.sent.quotation.id,
        decision: 'APPROVED',
        approvedFor: { type: 'CUSTOMER' },
        notes: 'Customer approved in person at the front desk',
      },
      adminUserId,
    );
    assert.equal(result.approval.approvedForType, 'CUSTOMER');
    assert.equal(result.approval.approvedForCustomerName, CUSTOMER_NAME);
    assert.equal(result.approval.approvedForCustomerPhone, CUSTOMER_PHONE);
    assert.equal(result.approval.approvedForCustomerEmail, CUSTOMER_EMAIL);
    assert.equal(result.approval.approvedForName, CUSTOMER_NAME);
    // Staff recorded; staff is NEVER the approved-for party.
    assert.equal(result.approval.recordedByUserId, adminUserId);
    assert.equal(result.approval.approvedForTenantPicId, null);
    assert.equal(result.approval.approvedForTenantCompanyId, null);
  });

  it('resolves an ASSISTED vs IN_APP race to a single winning decision', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const results = await Promise.allSettled([
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
        ctx.tenant!.picUser.id,
      ),
      recordHandymanQuotationApprovalAssistedDecision(
        {
          quotationId: ctx.sent.quotation.id,
          decision: 'REJECTED',
          approvedFor: { type: 'CUSTOMER' },
          notes: 'Racing assisted rejection',
        },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1);
    const rejection = (
      results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    ).reason as { code?: string; statusCode?: number };
    assert.ok(
      [
        'HANDYMAN_QUOTATION_APPROVAL_NOT_PENDING',
        'HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID',
      ].includes(rejection.code ?? ''),
      `unexpected race rejection code ${rejection.code}`,
    );
    assert.equal(rejection.statusCode, 409);

    // Exactly one decided approval, one decision event, consistent envelope.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{
      approval: { status: string };
      quotation: { status: string };
      requestStatus: string;
    }>).value;
    const stored = await getHandymanQuotation(ctx.sent.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, winner.quotation.status);
    assert.equal(await requestStatus(ctx.request.id), winner.requestStatus);
    const decisionEvents = await pool!.query(
      `SELECT count(*)::int AS n FROM operational_events
       WHERE entity_id = $1 AND event_type IN (
         'HANDYMAN_QUOTATION_APPROVED', 'HANDYMAN_QUOTATION_REJECTED')`,
      [ctx.sent.approval.id],
    );
    assert.equal(decisionEvents.rows[0].n, 1);
    assert.ok(['APPROVED', 'REJECTED'].includes(winner.approval.status));
  });

  it('resolves concurrent IN_APP decisions to one winner', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const results = await Promise.allSettled([
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
        ctx.tenant!.picUser.id,
      ),
      decideHandymanQuotationApprovalInApp(
        { quotationId: ctx.sent.quotation.id, decision: 'REJECTED' },
        ctx.tenant!.picUser.id,
      ),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejection = (
      results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    ).reason as { code?: string };
    assert.ok(
      [
        'HANDYMAN_QUOTATION_APPROVAL_NOT_PENDING',
        'HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID',
      ].includes(rejection.code ?? ''),
      `unexpected race rejection code ${rejection.code}`,
    );
    const decided = await pool!.query(
      'SELECT status FROM handyman_quotation_approvals WHERE id = $1',
      [ctx.sent.approval.id],
    );
    assert.ok(['APPROVED', 'REJECTED'].includes(decided.rows[0].status));
  });
});

describe('CR-HM-BE-03 RUN 3 — re-quote loop after rejection', () => {
  it('reopens the SAME quotation after rejection and issues a fresh approval', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const rejected = await decideHandymanQuotationApprovalInApp(
      { quotationId: ctx.sent.quotation.id, decision: 'REJECTED', notes: 'Over budget' },
      ctx.tenant!.picUser.id,
    );
    assert.equal(rejected.quotation.status, 'REJECTED');
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_REJECTED');

    // Minimum governed reopen transition: opening the next DRAFT revision
    // under the SAME quotation returns the request to the authoring phase.
    const rev2 = await createHandymanQuotationRevision(
      { quotationId: ctx.sent.quotation.id, notes: 'Reduced scope offer' },
      adminUserId,
    );
    assert.equal(rev2.revisionNumber, 2);
    assert.equal(rev2.status, 'DRAFT');
    assert.equal(await requestStatus(ctx.request.id), 'TRIAGED');

    await addHandymanQuotationLine(
      {
        revisionId: rev2.id,
        lineType: 'LABOR',
        serviceCatalogId: ctx.service.id,
        unitPrice: 150000,
      },
      adminUserId,
    );
    await submitHandymanQuotationRevision(rev2.id, adminUserId);
    const resent = await sendHandymanQuotation(
      { quotationId: ctx.sent.quotation.id, revisionId: rev2.id },
      adminUserId,
    );
    assert.equal(resent.quotation.id, ctx.sent.quotation.id);
    assert.equal(resent.quotation.status, 'SENT');
    assert.equal(resent.quotation.sentRevisionId, rev2.id);
    // A NEW PENDING approval for the new exact revision.
    assert.equal(resent.approval.status, 'PENDING');
    assert.equal(resent.approval.quotationRevisionId, rev2.id);
    assert.notEqual(resent.approval.id, ctx.sent.approval.id);
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_PENDING');

    // The old approval is immutable history — never overwritten.
    const oldApproval = await getHandymanQuotationApproval(ctx.sent.approval.id, adminUserId);
    assert.equal(oldApproval.status, 'REJECTED');
    assert.equal(oldApproval.method, 'IN_APP');
    assert.equal(oldApproval.decisionNotes, 'Over budget');
    assert.equal(oldApproval.approvedForTenantPicId, ctx.tenant!.pic.id);
    assert.equal(oldApproval.decidedAt, rejected.approval.decidedAt);

    const approvals = await listHandymanQuotationApprovals(ctx.sent.quotation.id, adminUserId);
    assert.equal(approvals.length, 2);

    // The new approval decides normally and closes the loop.
    const approved = await decideHandymanQuotationApprovalInApp(
      { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
      ctx.tenant!.picUser.id,
    );
    assert.equal(approved.quotation.status, 'APPROVED');
    assert.equal(await requestStatus(ctx.request.id), 'APPROVED');

    // One identity throughout.
    const rows = await pool!.query(
      'SELECT count(*)::int AS n FROM handyman_quotations WHERE request_id = $1',
      [ctx.request.id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('treats an APPROVED quotation as final', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    await decideHandymanQuotationApprovalInApp(
      { quotationId: ctx.sent.quotation.id, decision: 'APPROVED' },
      ctx.tenant!.picUser.id,
    );
    await expectError(
      createHandymanQuotationRevision({ quotationId: ctx.sent.quotation.id }, adminUserId),
      'HANDYMAN_QUOTATION_STATE_INVALID',
      409,
    );
    await expectError(
      withdrawHandymanQuotation(ctx.sent.quotation.id, adminUserId),
      'HANDYMAN_QUOTATION_STATE_INVALID',
      409,
    );
  });
});

describe('CR-HM-BE-03 RUN 3 — secure-link readiness only', () => {
  const futureExpiry = () => new Date(Date.now() + 3600_000).toISOString();

  it('issues a hash-only single-use link and returns the raw token exactly once', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const issued = await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'Pak Joko PIC',
        recipientPhone: '+6281200000001',
        recipientEmail: `link-${suffix().toLowerCase()}@tenant.example.com`,
        expiresAt: futureExpiry(),
      },
      adminUserId,
    );

    // Raw token: 256-bit crypto random, URL-safe, no resource identifiers.
    assert.match(issued.rawToken, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!issued.rawToken.includes(ctx.sent.quotation.id));
    assert.ok(!issued.rawToken.includes(ctx.request.id));

    // Hash-only storage: SHA-256 hex persisted, raw token nowhere in the row.
    const row = (
      await pool!.query('SELECT * FROM handyman_quotation_approval_links WHERE id = $1', [
        issued.link.id,
      ])
    ).rows[0] as Record<string, unknown>;
    const expectedHash = createHash('sha256').update(issued.rawToken).digest('hex');
    assert.equal(row.token_hash, expectedHash);
    for (const [column, value] of Object.entries(row)) {
      assert.ok(
        !(typeof value === 'string' && value.includes(issued.rawToken)),
        `raw token leaked into column ${column}`,
      );
    }
    assert.equal(row.max_uses, 1);
    assert.equal(row.uses_count, 0);
    assert.equal(row.status, 'ACTIVE');
    assert.ok(row.expires_at);
    // Recipient/contact snapshot on the row (never in events).
    assert.equal(row.recipient_name, 'Pak Joko PIC');

    // The public shape never discloses the hash — on ANY read surface.
    assert.ok(!('tokenHash' in issued.link));
    const read = await getHandymanQuotationApprovalLink(issued.link.id, adminUserId);
    assert.ok(!('tokenHash' in read));
    const listed = await listHandymanQuotationApprovalLinks(
      ctx.sent.quotation.id,
      adminUserId,
    );
    assert.equal(listed.length, 1);
    for (const publicLink of [read, ...listed]) {
      const serialized = JSON.stringify(publicLink);
      assert.ok(!serialized.includes(issued.rawToken));
      assert.ok(!serialized.includes(expectedHash));
    }

    // Event carries link identity only — no token, no hash, no recipient PII.
    const events = await eventsFor(issued.link.id);
    const issuedEvents = events.filter(
      (e) => e.event_type === 'HANDYMAN_QUOTATION_APPROVAL_LINK_ISSUED',
    );
    assert.equal(issuedEvents.length, 1);
    const serializedEvent = JSON.stringify(issuedEvents[0]);
    assert.ok(!serializedEvent.includes(issued.rawToken));
    assert.ok(!serializedEvent.includes(expectedHash));
    assert.ok(!serializedEvent.includes('Pak Joko PIC'));
    assert.ok(!serializedEvent.includes('+6281200000001'));
  });

  it('guards issuance state, duplicates, expiry input, and staff access', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    // Outsider staff cannot issue.
    await expectError(
      issueHandymanQuotationApprovalLink(
        {
          approvalId: ctx.sent.approval.id,
          recipientName: 'Outsider Recipient',
          expiresAt: futureExpiry(),
        },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    // expiresAt is required and must be in the future.
    await expectError(
      issueHandymanQuotationApprovalLink(
        {
          approvalId: ctx.sent.approval.id,
          recipientName: 'Recipient',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
        adminUserId,
      ),
      'VALIDATION_ERROR',
      400,
    );

    // One ACTIVE link per approval.
    await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'First Recipient',
        expiresAt: futureExpiry(),
      },
      adminUserId,
    );
    await expectError(
      issueHandymanQuotationApprovalLink(
        {
          approvalId: ctx.sent.approval.id,
          recipientName: 'Second Recipient',
          expiresAt: futureExpiry(),
        },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_LINK_ALREADY_ACTIVE',
      409,
    );

    // No issuance once the quotation left SENT (withdraw) or approval decided.
    await withdrawHandymanQuotation(ctx.sent.quotation.id, adminUserId);
    await expectError(
      issueHandymanQuotationApprovalLink(
        {
          approvalId: ctx.sent.approval.id,
          recipientName: 'Too Late Recipient',
          expiresAt: futureExpiry(),
        },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID',
      409,
    );
    await expectError(
      issueHandymanQuotationApprovalLink(
        { approvalId: randomUUID(), recipientName: 'Nobody', expiresAt: futureExpiry() },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_APPROVAL_NOT_FOUND',
      404,
    );
  });

  it('revokes guarded, allows re-issue after revoke, and never double-revokes', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const issued = await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'Revocable Recipient',
        expiresAt: futureExpiry(),
      },
      adminUserId,
    );

    const revoked = await revokeHandymanQuotationApprovalLink(issued.link.id, adminUserId);
    assert.equal(revoked.status, 'REVOKED');
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revokedByUserId, adminUserId);

    await expectError(
      revokeHandymanQuotationApprovalLink(issued.link.id, adminUserId),
      'HANDYMAN_QUOTATION_APPROVAL_LINK_STATE_INVALID',
      409,
    );
    await expectError(
      revokeHandymanQuotationApprovalLink(randomUUID(), adminUserId),
      'HANDYMAN_QUOTATION_APPROVAL_LINK_NOT_FOUND',
      404,
    );

    // A revoked link's token no longer consumes; re-issue creates a new ACTIVE.
    assert.equal(await consumeApprovalLinkTokenInternal(issued.rawToken), null);
    const reissued = await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'Replacement Recipient',
        expiresAt: futureExpiry(),
      },
      adminUserId,
    );
    assert.equal(reissued.link.status, 'ACTIVE');
    assert.notEqual(reissued.rawToken, issued.rawToken);

    const events = await eventsFor(issued.link.id);
    assert.equal(
      events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_APPROVAL_LINK_REVOKED').length,
      1,
    );
  });

  it('consumes single-use atomically, expires lapsed links, and never decides approvals', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const issued = await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'Consuming Recipient',
        expiresAt: futureExpiry(),
      },
      adminUserId,
    );

    // Atomic single-use consumption (INTERNAL readiness primitive).
    const consumed = await consumeApprovalLinkTokenInternal(issued.rawToken);
    assert.ok(consumed);
    assert.equal(consumed.linkId, issued.link.id);
    assert.equal(consumed.approvalId, ctx.sent.approval.id);
    const usedRow = (
      await pool!.query('SELECT status, uses_count, used_at FROM handyman_quotation_approval_links WHERE id = $1', [
        issued.link.id,
      ])
    ).rows[0];
    assert.equal(usedRow.status, 'USED');
    assert.equal(usedRow.uses_count, 1);
    assert.ok(usedRow.used_at);
    // Second consumption fails (max_uses = 1).
    assert.equal(await consumeApprovalLinkTokenInternal(issued.rawToken), null);
    // Consumption is NOT a decision: the approval stays PENDING and the
    // quotation stays SENT.
    const approval = await getHandymanQuotationApproval(ctx.sent.approval.id, adminUserId);
    assert.equal(approval.status, 'PENDING');
    const stored = await getHandymanQuotation(ctx.sent.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, 'SENT');

    // Lapsed links fail closed and are marked EXPIRED lazily.
    const lapsed = await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'Lapsed Recipient',
        expiresAt: futureExpiry(),
      },
      adminUserId,
    ).catch(async (error) => {
      // Previous link is USED (not ACTIVE) so issuance is allowed; this catch
      // only guards unexpected failures.
      throw error;
    });
    await pool!.query(
      `UPDATE handyman_quotation_approval_links SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [lapsed.link.id],
    );
    assert.equal(await consumeApprovalLinkTokenInternal(lapsed.rawToken), null);
    const lapsedRow = (
      await pool!.query('SELECT status FROM handyman_quotation_approval_links WHERE id = $1', [
        lapsed.link.id,
      ])
    ).rows[0];
    assert.equal(lapsedRow.status, 'EXPIRED');
  });

  it('keeps SECURE_LINK decisions unreachable at runtime and structurally', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    // Module surface: no consumption primitive, no token decision function,
    // no router/anonymous surface exported from CR03.
    const exported = Object.keys(handymanQuotationModule);
    assert.ok(!exported.includes('consumeApprovalLinkTokenInternal'));
    for (const name of exported) {
      assert.ok(
        !/decide.*(token|link)|secureLink.*decide|resolveApprovalToken/i.test(name),
        `unexpected token-decision export ${name}`,
      );
      assert.ok(!/Router$/.test(name), `unexpected router export ${name}`);
    }
    assert.deepEqual(Object.keys(handymanQuotationApprovalService).sort(), [
      'decideHandymanQuotationApprovalInApp',
      'getHandymanQuotationApproval',
      'listHandymanQuotationApprovals',
      'recordHandymanQuotationApprovalAssistedDecision',
    ]);

    // Structural: the migration-0352 decided-state CHECK rejects a
    // SECURE_LINK decision even via raw SQL.
    await assert.rejects(
      pool!.query(
        `UPDATE handyman_quotation_approvals
         SET status = 'APPROVED', method = 'SECURE_LINK', decided_at = NOW(),
             approved_for_type = 'CUSTOMER', approved_for_customer_name = 'X'
         WHERE id = $1`,
        [ctx.sent.approval.id],
      ),
      (error: { code?: string }) => error.code === '23514',
    );

    // The approval is untouched and still decidable through governed channels.
    const approval = await getHandymanQuotationApproval(ctx.sent.approval.id, adminUserId);
    assert.equal(approval.status, 'PENDING');
  });

  it('binds approval evidence through the existing supporting-documents foundation', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();

    const doc = await supportingDocumentService.createSupportingDocument(
      {
        clientId: ctx.h.client.id,
        buildingId: ctx.h.building.id,
        contextType: 'TENANT',
        sourceType: 'TENANT_COMPANY',
        sourceId: ctx.tenant!.company.id,
        title: 'Tenant approval screenshot',
        fileReference: `uploads/approval-evidence-${suffix()}.pdf`,
        documentNumber: `DOC_${suffix()}`,
        documentType: 'APPROVAL_EVIDENCE',
        parentType: 'HANDYMAN_QUOTATION_APPROVAL',
        parentId: ctx.sent.approval.id,
      },
      adminUserId,
    );
    assert.equal(doc.parentType, 'HANDYMAN_QUOTATION_APPROVAL');
    assert.equal(doc.parentId, ctx.sent.approval.id);

    const listed = await supportingDocumentService.listSupportingDocuments(
      {
        parentType: 'HANDYMAN_QUOTATION_APPROVAL',
        parentId: ctx.sent.approval.id,
        clientId: ctx.h.client.id,
        buildingId: ctx.h.building.id,
      },
      adminUserId,
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, doc.id);
  });
});

describe('CR-HM-BE-03 RUN 3 — access and audit hygiene', () => {
  it('enforces building access on approval read surfaces', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const issued = await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'Access Recipient',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      adminUserId,
    );

    await expectError(
      getHandymanQuotationApproval(ctx.sent.approval.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanQuotationApprovals(ctx.sent.quotation.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanQuotationApprovalLink(issued.link.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanQuotationApprovalLinks(ctx.sent.quotation.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      revokeHandymanQuotationApprovalLink(issued.link.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );

    // Authorized staff reads succeed.
    const approval = await getHandymanQuotationApproval(ctx.sent.approval.id, adminUserId);
    assert.equal(approval.id, ctx.sent.approval.id);
  });

  it('keeps PII, tokens, hashes, and notes out of approval/link event payloads', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeSentContext();
    const issued = await issueHandymanQuotationApprovalLink(
      {
        approvalId: ctx.sent.approval.id,
        recipientName: 'Audit Recipient',
        recipientPhone: '+6289998887776',
        recipientEmail: `audit-${suffix().toLowerCase()}@tenant.example.com`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      adminUserId,
    );
    const decision = await recordHandymanQuotationApprovalAssistedDecision(
      {
        quotationId: ctx.sent.quotation.id,
        decision: 'APPROVED',
        approvedFor: { type: 'CUSTOMER' },
        notes: `Approved by phone; contact ${CUSTOMER_PHONE} — sensitive detail`,
      },
      adminUserId,
    );
    await revokeHandymanQuotationApprovalLink(issued.link.id, adminUserId);

    const result = await pool!.query(
      `SELECT event_type, metadata, summary FROM operational_events
       WHERE entity_type IN (
         'HANDYMAN_QUOTATION_APPROVAL', 'HANDYMAN_QUOTATION_APPROVAL_LINK')`,
    );
    assert.ok(result.rowCount! >= 4);
    const forbidden = [
      CUSTOMER_NAME,
      CUSTOMER_PHONE,
      CUSTOMER_EMAIL,
      'Pak Joko PIC',
      'Audit Recipient',
      '+6289998887776',
      issued.rawToken,
      createHash('sha256').update(issued.rawToken).digest('hex'),
      'sensitive detail',
    ];
    for (const row of result.rows as {
      event_type: string;
      metadata: Record<string, unknown>;
      summary: string;
    }[]) {
      const serialized = `${JSON.stringify(row.metadata ?? {})} ${row.summary}`;
      for (const banned of forbidden) {
        assert.ok(
          !serialized.includes(banned),
          `${row.event_type} payload leaks forbidden content: ${banned}`,
        );
      }
      const keys = Object.keys(row.metadata ?? {});
      for (const banned of [
        'customerName', 'customerPhone', 'customerEmail',
        'recipientName', 'recipientPhone', 'recipientEmail',
        'token', 'rawToken', 'tokenHash', 'decisionNotes', 'notes',
      ]) {
        assert.ok(!keys.includes(banned), `${row.event_type} metadata leaks ${banned}`);
      }
    }
    assert.equal(decision.approval.status, 'APPROVED');
  });
});
