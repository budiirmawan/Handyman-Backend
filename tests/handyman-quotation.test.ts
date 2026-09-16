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
import { floorService } from '../src/modules/floors';
import {
  cancelHandymanRequest,
  createHandymanRequest,
  getHandymanRequestById,
} from '../src/modules/handyman-requests';
import {
  completeHandymanInspection,
  openHandymanInspection,
  selectHandymanRequestService,
  supersedeHandymanRequestServiceSelection,
  triageHandymanRequest,
} from '../src/modules/handyman-request-governance';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  getHandymanQuotation,
  listHandymanQuotationLines,
  listHandymanQuotationRevisions,
  listHandymanQuotationsByRequest,
  removeHandymanQuotationLine,
  sendHandymanQuotation,
  submitHandymanQuotationRevision,
  updateHandymanQuotationLine,
  withdrawHandymanQuotation,
} from '../src/modules/handyman-quotations';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-03 RUN 2 — focused tests for the customer quotation authority:
 * governed creation from the request lifecycle, server-generated numbering,
 * BE-01 idempotency, immutable revision loop (DRAFT → SUBMITTED →
 * SUPERSEDED), discriminated LABOR/MATERIAL/OTHER lines bound to governed
 * foundations, UNCHANGED reference-price resolution with fail-closed
 * semantics and the deviation-note rule, derived totals, exact-revision SEND
 * binding with request lifecycle movement, the minimum WITHDRAW transition,
 * and the same-identity re-quote loop. Stops BEFORE customer approval.
 */

const PORT = 55482;
const DIR = '/tmp/asentra-hm03-run2-pg';
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

const CUSTOMER_NAME = 'Siti Building Manager';
const CUSTOMER_PHONE = '+6281198765432';
const CUSTOMER_EMAIL = 'siti@tenant.example.com';
const DIAGNOSIS_TEXT = 'Refrigerant leak at the flare connection';

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
    `TRUNCATE handyman_quotation_lines, handyman_quotation_revisions,
      handyman_quotations, handyman_request_triages, handyman_request_services,
      handyman_inspections, handyman_requests, handyman_providers,
      price_catalog_entries, inventory_items, units_of_measure,
      operational_events CASCADE`,
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
      name: 'Quotation Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Quotation Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Quotation Tower',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  // CR-BE-CUR-02 command-currency authority: price catalog entries (and thus
  // reference-price lookups) require the client's allowed currency set. Set
  // after the building assignment so client access resolves.
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

async function createRequest(h: { building: { id: string }; space: { id: string } }) {
  return createHandymanRequest(
    {
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: CUSTOMER_NAME,
      customerPhone: CUSTOMER_PHONE,
      customerEmail: CUSTOMER_EMAIL,
      inboundChannel: 'WHATSAPP',
      title: 'AC Not Cooling',
      description: 'Warm air from the indoor split unit.',
      priority: 'HIGH',
    },
    adminUserId,
  );
}

async function createService(clientId: string, category = 'HANDYMAN') {
  return serviceCatalogService.createServiceCatalogEntry(
    {
      clientId,
      code: `SVC_${suffix()}`,
      name: 'Quotation Service',
      category,
    },
    adminUserId,
  );
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

/** CLIENT_WIDE ACTIVE SERVICE reference price for a catalog service. */
async function makeServicePrice(
  clientId: string,
  serviceId: string,
  unitPrice: number,
  currency = 'IDR',
) {
  const created = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      sourceMode: 'SERVICE',
      serviceId,
      currency: currency as 'IDR',
      unitPrice,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      idempotencyKey: `IDEM_${suffix()}_${randomUUID()}`,
    },
    adminUserId,
  );
  return priceCatalogEntryService.activatePriceCatalogEntry(created.id, adminUserId);
}

/** CLIENT_WIDE ACTIVE MATERIAL reference price for an item+UOM. */
async function makeMaterialPrice(
  clientId: string,
  itemId: string,
  uomId: string,
  unitPrice: number,
  currency = 'IDR',
) {
  const created = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      sourceMode: 'MATERIAL',
      itemId,
      uomId,
      currency: currency as 'IDR',
      unitPrice,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      idempotencyKey: `IDEM_${suffix()}_${randomUUID()}`,
    },
    adminUserId,
  );
  return priceCatalogEntryService.activatePriceCatalogEntry(created.id, adminUserId);
}

/**
 * Full governed chain: hierarchy → request → ACTIVE selection (TRIAGE
 * source) → QUOTATION triage → quotation envelope + DRAFT revision 1.
 */
async function makeQuotableContext(options: { currency?: 'IDR' | 'USD' } = {}) {
  const h = await createHierarchy();
  const request = await createRequest(h);
  const service = await createService(h.client.id);
  await triageHandymanRequest(
    { requestId: request.id, path: 'QUOTATION', notes: 'Known scope' },
    adminUserId,
  );
  const selection = await selectHandymanRequestService(
    { requestId: request.id, serviceCatalogId: service.id, source: 'TRIAGE' },
    adminUserId,
  );
  const created = await createHandymanQuotation(
    { requestId: request.id, currency: options.currency ?? 'IDR' },
    adminUserId,
  );
  return { ...created, h, request, service, selection };
}

/** Adds a governed LABOR line priced at the CLIENT_WIDE reference. */
async function addPricedLaborLine(
  ctx: { revision: { id: string }; h: { client: { id: string } }; service: { id: string } },
  unitPrice = 150000,
) {
  await makeServicePrice(ctx.h.client.id, ctx.service.id, unitPrice);
  return addHandymanQuotationLine(
    {
      revisionId: ctx.revision.id,
      lineType: 'LABOR',
      serviceCatalogId: ctx.service.id,
      unitPrice,
    },
    adminUserId,
  );
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

describe('CR-HM-BE-03 RUN 2 — quotation envelope authority', () => {
  it('creates a quotation from a TRIAGED request with derived scope and a frozen snapshot', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();

    assert.equal(ctx.replayed, false);
    assert.equal(ctx.quotation.requestId, ctx.request.id);
    assert.equal(ctx.quotation.clientId, ctx.h.client.id);
    assert.equal(ctx.quotation.buildingId, ctx.h.building.id);
    assert.equal(ctx.quotation.currency, 'IDR');
    assert.equal(ctx.quotation.status, 'DRAFT');
    assert.match(ctx.quotation.quotationNumber, /^HMQ-\d{4}-\d{6}$/);
    assert.equal(ctx.quotation.sentRevisionId, null);
    assert.equal(ctx.quotation.sentAt, null);
    // Frozen tenant/customer snapshot taken from the request, not the caller.
    assert.equal(ctx.quotation.customerName, CUSTOMER_NAME);
    assert.equal(ctx.quotation.customerPhone, CUSTOMER_PHONE);
    assert.equal(ctx.quotation.customerEmail, CUSTOMER_EMAIL);
    assert.equal(ctx.quotation.tenantCompanyId, ctx.request.tenantCompanyId ?? null);
    assert.equal(ctx.quotation.createdByUserId, adminUserId);
    // Revision 1 (DRAFT) is created with the envelope.
    assert.equal(ctx.revision.revisionNumber, 1);
    assert.equal(ctx.revision.status, 'DRAFT');
    assert.deepEqual(ctx.revision.totals, {
      laborTotal: 0, materialTotal: 0, otherTotal: 0, grandTotal: 0,
    });
    // Creating the envelope does not move the request lifecycle.
    assert.equal(await requestStatus(ctx.request.id), 'TRIAGED');

    const events = await eventsFor(ctx.quotation.id);
    const created = events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_CREATED');
    assert.equal(created.length, 1);
    assert.equal(created[0].entity_type, 'HANDYMAN_QUOTATION');
    assert.equal(created[0].metadata.quotationNumber, ctx.quotation.quotationNumber);
    assert.equal(created[0].metadata.revisionNumber, 1);
  });

  it('rejects creation from ungoverned request lifecycle states', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);

    // SUBMITTED (never triaged) — no ACTIVE triage decision exists.
    await expectError(
      createHandymanQuotation({ requestId: request.id, currency: 'IDR' }, adminUserId),
      'HANDYMAN_QUOTATION_NOT_ALLOWED',
      409,
    );

    // CANCELLED is structurally excluded.
    const h2 = await createHierarchy();
    const cancelledRequest = await createRequest(h2);
    await cancelHandymanRequest(cancelledRequest.id, adminUserId);
    await expectError(
      createHandymanQuotation({ requestId: cancelledRequest.id, currency: 'IDR' }, adminUserId),
      'HANDYMAN_QUOTATION_NOT_ALLOWED',
      409,
    );

    // INSPECTION_REQUIRED (inspection not completed) is excluded.
    const h3 = await createHierarchy();
    const inspectionRequest = await createRequest(h3);
    await triageHandymanRequest(
      { requestId: inspectionRequest.id, path: 'INSPECTION' },
      adminUserId,
    );
    assert.equal(await requestStatus(inspectionRequest.id), 'INSPECTION_REQUIRED');
    await expectError(
      createHandymanQuotation({ requestId: inspectionRequest.id, currency: 'IDR' }, adminUserId),
      'HANDYMAN_QUOTATION_NOT_ALLOWED',
      409,
    );
  });

  it('creates a quotation from INSPECTION_COMPLETED', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const inspection = await openHandymanInspection({ requestId: request.id }, adminUserId);
    await completeHandymanInspection(
      inspection.id,
      { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Repair the flare connection' },
      adminUserId,
    );
    assert.equal(await requestStatus(request.id), 'INSPECTION_COMPLETED');

    const created = await createHandymanQuotation(
      { requestId: request.id, currency: 'IDR' },
      adminUserId,
    );
    assert.equal(created.quotation.status, 'DRAFT');
    assert.equal(created.revision.revisionNumber, 1);
  });

  it('rejects unknown requests and outsider actors', async (t) => {
    if (!ready(t)) return;
    await expectError(
      createHandymanQuotation({ requestId: randomUUID(), currency: 'IDR' }, adminUserId),
      'HANDYMAN_REQUEST_NOT_FOUND',
      404,
    );

    const ctx = await makeQuotableContext();
    await expectError(
      createHandymanQuotation({ requestId: ctx.request.id, currency: 'IDR' }, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanQuotation(ctx.quotation.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      sendHandymanQuotation(
        { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanQuotation(randomUUID(), adminUserId),
      'HANDYMAN_QUOTATION_NOT_FOUND',
      404,
    );
  });

  it('generates sequential per-client quotation numbers', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request1 = await createRequest(h);
    const service = await createService(h.client.id);
    await triageHandymanRequest({ requestId: request1.id, path: 'QUOTATION' }, adminUserId);
    await selectHandymanRequestService(
      { requestId: request1.id, serviceCatalogId: service.id, source: 'TRIAGE' },
      adminUserId,
    );
    const q1 = await createHandymanQuotation({ requestId: request1.id, currency: 'IDR' }, adminUserId);

    // Second request under the SAME client/building: sequence continues.
    const request2 = await createRequest(h);
    await triageHandymanRequest({ requestId: request2.id, path: 'QUOTATION' }, adminUserId);
    const q2 = await createHandymanQuotation({ requestId: request2.id, currency: 'IDR' }, adminUserId);

    const year = new Date().getUTCFullYear();
    assert.equal(q1.quotation.quotationNumber, `HMQ-${year}-000001`);
    assert.equal(q2.quotation.quotationNumber, `HMQ-${year}-000002`);

    // A different client restarts its own sequence.
    const other = await makeQuotableContext();
    assert.equal(other.quotation.quotationNumber, `HMQ-${year}-000001`);
  });

  it('replays idempotent creations and conflicts on key reuse with different facts', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);
    const key = `IDEM_${suffix()}`;

    const first = await createHandymanQuotation(
      { requestId: request.id, currency: 'IDR', idempotencyKey: key },
      adminUserId,
    );
    assert.equal(first.replayed, false);

    // Same key + same command facts → replay of the stored envelope, no
    // second quotation, no second revision, no second event.
    const replay = await createHandymanQuotation(
      { requestId: request.id, currency: 'IDR', idempotencyKey: key },
      adminUserId,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.quotation.id, first.quotation.id);
    assert.equal(replay.revision.id, first.revision.id);

    const stored = await pool!.query(
      'SELECT count(*)::int AS n FROM handyman_quotations WHERE request_id = $1',
      [request.id],
    );
    assert.equal(stored.rows[0].n, 1);
    const revisions = await pool!.query(
      'SELECT count(*)::int AS n FROM handyman_quotation_revisions WHERE quotation_id = $1',
      [first.quotation.id],
    );
    assert.equal(revisions.rows[0].n, 1);
    const events = await eventsFor(first.quotation.id);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_CREATED').length, 1);

    // Same key (client-scoped) + DIFFERENT command facts → conflict, nothing
    // stored. The second command targets another request of the SAME client.
    const request2 = await createRequest(h);
    await triageHandymanRequest({ requestId: request2.id, path: 'QUOTATION' }, adminUserId);
    await expectError(
      createHandymanQuotation(
        { requestId: request2.id, currency: 'IDR', idempotencyKey: key },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_IDEMPOTENCY_CONFLICT',
      409,
    );
    const afterConflict = await pool!.query(
      'SELECT count(*)::int AS n FROM handyman_quotations WHERE request_id = $1',
      [request2.id],
    );
    assert.equal(afterConflict.rows[0].n, 0);
  });

  it('validates the currency against the governed price-catalog set', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await expectError(
      createHandymanQuotation(
        { requestId: ctx.request.id, currency: 'XXX' as 'IDR' },
        adminUserId,
      ),
      'VALIDATION_ERROR',
      400,
    );
  });

  it('lists quotations by request for authorized actors only', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    const listed = await listHandymanQuotationsByRequest(ctx.request.id, adminUserId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, ctx.quotation.id);
    await expectError(
      listHandymanQuotationsByRequest(ctx.request.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
  });
});

describe('CR-HM-BE-03 RUN 2 — revision authority', () => {
  it('allows at most one DRAFT revision per quotation', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    // Revision 1 is already DRAFT.
    await expectError(
      createHandymanQuotationRevision({ quotationId: ctx.quotation.id }, adminUserId),
      'HANDYMAN_QUOTATION_REVISION_DRAFT_EXISTS',
      409,
    );
  });

  it('requires at least one governed line before submit', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await expectError(
      submitHandymanQuotationRevision(ctx.revision.id, adminUserId),
      'HANDYMAN_QUOTATION_LINES_REQUIRED',
      409,
    );
    // The revision stays DRAFT after the rejected submit.
    const stored = await getHandymanQuotation(ctx.quotation.id, adminUserId);
    assert.equal(stored.revisions[0].status, 'DRAFT');
  });

  it('submits a revision with lines and freezes its facts', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);

    const submitted = await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);
    assert.equal(submitted.revision.status, 'SUBMITTED');
    assert.equal(submitted.revision.revisionNumber, 1);
    assert.ok(!Number.isNaN(Date.parse(submitted.revision.submittedAt!)));
    assert.equal(submitted.revision.submittedByUserId, adminUserId);
    assert.deepEqual(submitted.revision.totals, {
      laborTotal: 150000, materialTotal: 0, otherTotal: 0, grandTotal: 150000,
    });
    assert.deepEqual(submitted.supersededRevisionIds, []);

    // SUBMITTED facts are immutable: no further line authoring.
    await expectError(
      addHandymanQuotationLine(
        {
          revisionId: ctx.revision.id,
          lineType: 'OTHER',
          description: 'Late addition',
          unitPrice: 1000,
        },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_REVISION_STATE_INVALID',
      409,
    );
    const lines = await listHandymanQuotationLines(ctx.revision.id, adminUserId);
    await expectError(
      updateHandymanQuotationLine(lines[0].id, { unitPrice: 1 }, adminUserId),
      'HANDYMAN_QUOTATION_REVISION_STATE_INVALID',
      409,
    );
    await expectError(
      removeHandymanQuotationLine(lines[0].id, adminUserId),
      'HANDYMAN_QUOTATION_REVISION_STATE_INVALID',
      409,
    );

    const events = await eventsFor(ctx.revision.id);
    assert.equal(
      events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_REVISION_SUBMITTED').length,
      1,
    );
  });

  it('supersedes the prior SUBMITTED revision instead of mutating it', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    const rev1 = await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);

    // Envelope still DRAFT (never sent): a corrective revision is allowed.
    const rev2 = await createHandymanQuotationRevision(
      { quotationId: ctx.quotation.id, notes: '  Revised commercial position  ' },
      adminUserId,
    );
    assert.equal(rev2.revisionNumber, 2);
    assert.equal(rev2.status, 'DRAFT');
    assert.equal(rev2.notes, 'Revised commercial position');

    await addHandymanQuotationLine(
      {
        revisionId: rev2.id,
        lineType: 'OTHER',
        description: 'Parking coordination fee',
        unitPrice: 25000,
      },
      adminUserId,
    );
    const submitted2 = await submitHandymanQuotationRevision(rev2.id, adminUserId);
    assert.deepEqual(submitted2.supersededRevisionIds, [rev1.revision.id]);
    assert.deepEqual(submitted2.revision.totals, {
      laborTotal: 0, materialTotal: 0, otherTotal: 25000, grandTotal: 25000,
    });

    // History preserved: rev1 keeps its SUBMITTED facts and is now SUPERSEDED.
    const revisions = await listHandymanQuotationRevisions(ctx.quotation.id, adminUserId);
    assert.equal(revisions.length, 2);
    const storedRev1 = revisions.find((r) => r.id === rev1.revision.id)!;
    assert.equal(storedRev1.status, 'SUPERSEDED');
    assert.ok(!Number.isNaN(Date.parse(storedRev1.supersededAt!)));
    assert.equal(storedRev1.submittedByUserId, adminUserId);
    assert.deepEqual(storedRev1.totals, {
      laborTotal: 150000, materialTotal: 0, otherTotal: 0, grandTotal: 150000,
    });
    const rev1Lines = await listHandymanQuotationLines(rev1.revision.id, adminUserId);
    assert.equal(rev1Lines.length, 1);
    assert.equal(rev1Lines[0].unitPrice, 150000);
  });

  it('rejects opening revisions on a SENT quotation and rejects unknown revisions', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);
    await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
      adminUserId,
    );

    await expectError(
      createHandymanQuotationRevision({ quotationId: ctx.quotation.id }, adminUserId),
      'HANDYMAN_QUOTATION_STATE_INVALID',
      409,
    );
    await expectError(
      submitHandymanQuotationRevision(randomUUID(), adminUserId),
      'HANDYMAN_QUOTATION_REVISION_NOT_FOUND',
      404,
    );
    // Outsider on a known revision.
    await expectError(
      submitHandymanQuotationRevision(ctx.revision.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
  });
});

describe('CR-HM-BE-03 RUN 2 — line authority and pricing', () => {
  it('adds a LABOR line bound to an ACTIVE governed selection with reference provenance', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    const line = await addPricedLaborLine(ctx, 150000);

    assert.equal(line.lineType, 'LABOR');
    assert.equal(line.lineNumber, 1);
    assert.equal(line.serviceCatalogId, ctx.service.id);
    assert.equal(line.subjectCode, ctx.service.code);
    assert.equal(line.subjectName, ctx.service.name);
    assert.equal(line.quantity, null);
    assert.equal(line.unitPrice, 150000);
    assert.equal(line.lineTotal, 150000);
    assert.equal(line.referenceResolution, 'MATCHED');
    assert.equal(line.referenceUnitPrice, 150000);
    assert.equal(line.referenceScopeTier, 'CLIENT_WIDE');
    assert.ok(line.referencePriceEntryId);
    assert.ok(line.referenceAsOf);
    assert.equal(line.deviationNote, null);

    const revision = await listHandymanQuotationRevisions(ctx.quotation.id, adminUserId);
    assert.deepEqual(revision[0].totals, {
      laborTotal: 150000, materialTotal: 0, otherTotal: 0, grandTotal: 150000,
    });
  });

  it('rejects LABOR lines without an ACTIVE governed selection', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();

    // Never-selected ACTIVE catalog service.
    const other = await createService(ctx.h.client.id);
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'LABOR', serviceCatalogId: other.id, unitPrice: 100000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_SERVICE_NOT_SELECTED',
      409,
    );

    // SUPERSEDED selection no longer carries authority.
    await supersedeHandymanRequestServiceSelection(ctx.selection.id, adminUserId);
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'LABOR', serviceCatalogId: ctx.service.id, unitPrice: 100000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_SERVICE_NOT_SELECTED',
      409,
    );

    // Missing subject / quantity invention / free-text parsing never happens.
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'LABOR', unitPrice: 100000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );
    const reselected = await selectHandymanRequestService(
      { requestId: ctx.request.id, serviceCatalogId: ctx.service.id, source: 'TRIAGE' },
      adminUserId,
    );
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'LABOR', serviceCatalogId: ctx.service.id, quantity: 3, unitPrice: 100000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );
    assert.ok(reselected.id);
  });

  it('fails closed when the LABOR catalog entry was terminally deactivated', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await serviceCatalogService.deactivateServiceCatalogEntry(ctx.service.id, adminUserId);
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'LABOR', serviceCatalogId: ctx.service.id, unitPrice: 100000 },
        adminUserId,
      ),
      'SERVICE_CATALOG_NOT_ACTIVE',
      409,
    );
  });

  it('adds MATERIAL lines with item/UOM snapshots and derived line totals', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    const item = await makeItem(ctx.h.client.id);
    const uom = await makeUom(ctx.h.client.id);
    await makeMaterialPrice(ctx.h.client.id, item.id, uom.id, 12500);

    const line = await addHandymanQuotationLine(
      {
        revisionId: ctx.revision.id,
        lineType: 'MATERIAL',
        inventoryItemId: item.id,
        uomId: uom.id,
        quantity: 4,
        unitPrice: 12500,
      },
      adminUserId,
    );
    assert.equal(line.lineType, 'MATERIAL');
    assert.equal(line.subjectCode, item.code);
    assert.equal(line.subjectName, item.name);
    assert.equal(line.uomCode, uom.code);
    assert.equal(line.quantity, 4);
    assert.equal(line.lineTotal, 50000);
    assert.equal(line.referenceResolution, 'MATCHED');
    assert.equal(line.referenceUnitPrice, 12500);

    const revisions = await listHandymanQuotationRevisions(ctx.quotation.id, adminUserId);
    assert.deepEqual(revisions[0].totals, {
      laborTotal: 0, materialTotal: 50000, otherTotal: 0, grandTotal: 50000,
    });
  });

  it('validates MATERIAL line subjects and quantities', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    const item = await makeItem(ctx.h.client.id);
    const uom = await makeUom(ctx.h.client.id);

    // Missing quantity / non-positive quantity.
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'MATERIAL', inventoryItemId: item.id, uomId: uom.id, unitPrice: 1000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'MATERIAL', inventoryItemId: item.id, uomId: uom.id, quantity: 0, unitPrice: 1000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );

    // Unknown item → foundation 404 (no existence leak for other clients).
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'MATERIAL', inventoryItemId: randomUUID(), uomId: uom.id, quantity: 1, unitPrice: 1000, deviationNote: 'No reference price yet' },
        adminUserId,
      ),
      'INVENTORY_ITEM_NOT_FOUND',
      404,
    );

    // Cross-client item is treated as not found.
    const other = await createHierarchy();
    const otherItem = await makeItem(other.client.id);
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'MATERIAL', inventoryItemId: otherItem.id, uomId: uom.id, quantity: 1, unitPrice: 1000, deviationNote: 'Manual' },
        adminUserId,
      ),
      'INVENTORY_ITEM_NOT_FOUND',
      404,
    );

    // Unknown UOM.
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'MATERIAL', inventoryItemId: item.id, uomId: randomUUID(), quantity: 1, unitPrice: 1000, deviationNote: 'Manual' },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );

    // INACTIVE item fails closed.
    await pool!.query(`UPDATE inventory_items SET status = 'INACTIVE' WHERE id = $1`, [item.id]);
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'MATERIAL', inventoryItemId: item.id, uomId: uom.id, quantity: 1, unitPrice: 1000, deviationNote: 'Manual' },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );
  });

  it('requires a governed description for OTHER lines and keeps provenance empty', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();

    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'OTHER', unitPrice: 50000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'OTHER', description: 'Mobilization', quantity: 2, unitPrice: 50000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_INVALID',
      400,
    );

    const line = await addHandymanQuotationLine(
      { revisionId: ctx.revision.id, lineType: 'OTHER', description: '  Mobilization and demobilization  ', unitPrice: 50000 },
      adminUserId,
    );
    assert.equal(line.description, 'Mobilization and demobilization');
    assert.equal(line.lineTotal, 50000);
    assert.equal(line.referenceResolution, null);
    assert.equal(line.referencePriceEntryId, null);
    assert.equal(line.referenceUnitPrice, null);
    assert.equal(line.serviceCatalogId, null);
    assert.equal(line.inventoryItemId, null);
  });

  it('keeps derived totals per line type and never accepts caller totals', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    const item = await makeItem(ctx.h.client.id);
    const uom = await makeUom(ctx.h.client.id);
    await addHandymanQuotationLine(
      {
        revisionId: ctx.revision.id,
        lineType: 'MATERIAL',
        inventoryItemId: item.id,
        uomId: uom.id,
        quantity: 2.5,
        unitPrice: 10000.5,
        deviationNote: 'No reference entry for this UOM',
      },
      adminUserId,
    );
    await addHandymanQuotationLine(
      { revisionId: ctx.revision.id, lineType: 'OTHER', description: 'Permit coordination', unitPrice: 75000.25 },
      adminUserId,
    );

    const revisions = await listHandymanQuotationRevisions(ctx.quotation.id, adminUserId);
    assert.deepEqual(revisions[0].totals, {
      laborTotal: 150000,
      materialTotal: 25001.25,
      otherTotal: 75000.25,
      grandTotal: 250001.5,
    });
  });

  it('enforces the deviation-note rule against the MATCHED reference', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await makeServicePrice(ctx.h.client.id, ctx.service.id, 150000);

    // Authored price deviates from the reference without a note → 400.
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'LABOR', serviceCatalogId: ctx.service.id, unitPrice: 175000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_PRICE_DEVIATION_NOTE_REQUIRED',
      400,
    );

    // With a note the deviation is stored with full provenance.
    const line = await addHandymanQuotationLine(
      {
        revisionId: ctx.revision.id,
        lineType: 'LABOR',
        serviceCatalogId: ctx.service.id,
        unitPrice: 175000,
        deviationNote: 'After-hours surcharge agreed with BM',
      },
      adminUserId,
    );
    assert.equal(line.unitPrice, 175000);
    assert.equal(line.referenceResolution, 'MATCHED');
    assert.equal(line.referenceUnitPrice, 150000);
    assert.equal(line.deviationNote, 'After-hours surcharge agreed with BM');
  });

  it('requires a note for manual pricing under NO_REFERENCE_PRICE', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    // No price entry exists for this service.
    await expectError(
      addHandymanQuotationLine(
        { revisionId: ctx.revision.id, lineType: 'LABOR', serviceCatalogId: ctx.service.id, unitPrice: 200000 },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_PRICE_DEVIATION_NOTE_REQUIRED',
      400,
    );

    const line = await addHandymanQuotationLine(
      {
        revisionId: ctx.revision.id,
        lineType: 'LABOR',
        serviceCatalogId: ctx.service.id,
        unitPrice: 200000,
        deviationNote: 'No catalog reference; BM-approved manual rate',
      },
      adminUserId,
    );
    assert.equal(line.referenceResolution, 'NO_REFERENCE_PRICE');
    assert.equal(line.referencePriceEntryId, null);
    assert.equal(line.referenceScopeTier, null);
    assert.equal(line.referenceUnitPrice, null);
    assert.ok(line.referenceAsOf);
    assert.equal(line.deviationNote, 'No catalog reference; BM-approved manual rate');
  });

  it('fails closed on UOM_INCOMPATIBLE and CURRENCY_INCOMPATIBLE lookups', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    const item = await makeItem(ctx.h.client.id);
    const uomA = await makeUom(ctx.h.client.id);
    const uomB = await makeUom(ctx.h.client.id);
    await makeMaterialPrice(ctx.h.client.id, item.id, uomA.id, 9000);

    // Reference exists for UOM A only; quoting UOM B fails closed (no
    // conversion exists or is inferred).
    await expectError(
      addHandymanQuotationLine(
        {
          revisionId: ctx.revision.id,
          lineType: 'MATERIAL',
          inventoryItemId: item.id,
          uomId: uomB.id,
          quantity: 1,
          unitPrice: 9000,
          deviationNote: 'Should fail closed before the note matters',
        },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_PRICE_UNRESOLVED',
      409,
    );

    // Currency mismatch on a SERVICE subject fails closed (no FX exists).
    await makeServicePrice(ctx.h.client.id, ctx.service.id, 150000, 'IDR');
    const usd = await createHandymanQuotation(
      { requestId: ctx.request.id, currency: 'USD' },
      adminUserId,
    );
    await expectError(
      addHandymanQuotationLine(
        {
          revisionId: usd.revision.id,
          lineType: 'LABOR',
          serviceCatalogId: ctx.service.id,
          unitPrice: 10,
          deviationNote: 'Should fail closed before the note matters',
        },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_PRICE_UNRESOLVED',
      409,
    );
  });

  it('re-runs governed pricing on updates and protects subjects', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    const line = await addPricedLaborLine(ctx, 150000);

    // Moving away from the reference without a note fails closed.
    await expectError(
      updateHandymanQuotationLine(line.id, { unitPrice: 160000 }, adminUserId),
      'HANDYMAN_QUOTATION_PRICE_DEVIATION_NOTE_REQUIRED',
      400,
    );
    const updated = await updateHandymanQuotationLine(
      line.id,
      { unitPrice: 160000, deviationNote: 'Weekend schedule premium' },
      adminUserId,
    );
    assert.equal(updated.unitPrice, 160000);
    assert.equal(updated.lineTotal, 160000);
    assert.equal(updated.referenceResolution, 'MATCHED');
    assert.equal(updated.referenceUnitPrice, 150000);
    assert.equal(updated.deviationNote, 'Weekend schedule premium');
    // Subject identity is immutable through updates.
    assert.equal(updated.serviceCatalogId, ctx.service.id);
    assert.equal(updated.lineNumber, 1);

    // Back to the exact reference clears the deviation requirement.
    const restored = await updateHandymanQuotationLine(
      line.id,
      { unitPrice: 150000, deviationNote: null },
      adminUserId,
    );
    assert.equal(restored.unitPrice, 150000);
    assert.equal(restored.deviationNote, null);

    // MATERIAL quantity updates recompute the GENERATED total.
    const item = await makeItem(ctx.h.client.id);
    const uom = await makeUom(ctx.h.client.id);
    const material = await addHandymanQuotationLine(
      {
        revisionId: ctx.revision.id,
        lineType: 'MATERIAL',
        inventoryItemId: item.id,
        uomId: uom.id,
        quantity: 2,
        unitPrice: 5000,
        deviationNote: 'No reference entry yet',
      },
      adminUserId,
    );
    assert.equal(material.lineTotal, 10000);
    const requantitied = await updateHandymanQuotationLine(
      material.id,
      { quantity: 7.25 },
      adminUserId,
    );
    assert.equal(requantitied.quantity, 7.25);
    assert.equal(requantitied.lineTotal, 36250);

    // Removal only affects draft working data.
    const removed = await removeHandymanQuotationLine(material.id, adminUserId);
    assert.equal(removed.removed, true);
    const lines = await listHandymanQuotationLines(ctx.revision.id, adminUserId);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, line.id);

    await expectError(
      updateHandymanQuotationLine(randomUUID(), { unitPrice: 1 }, adminUserId),
      'HANDYMAN_QUOTATION_LINE_NOT_FOUND',
      404,
    );
  });

  it('rejects line authoring while the quotation is SENT', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);
    await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
      adminUserId,
    );
    // The sent revision is SUBMITTED (immutability already covered); withdraw
    // first, then a NEW DRAFT revision is the only authoring surface.
    await withdrawHandymanQuotation(ctx.quotation.id, adminUserId);
    const rev2 = await createHandymanQuotationRevision(
      { quotationId: ctx.quotation.id },
      adminUserId,
    );
    const line = await addHandymanQuotationLine(
      {
        revisionId: rev2.id,
        lineType: 'OTHER',
        description: 'Post-withdrawal adjustment',
        unitPrice: 10000,
      },
      adminUserId,
    );
    assert.equal(line.lineNumber, 1);
  });
});

describe('CR-HM-BE-03 RUN 2 — send binding and lifecycle', () => {
  it('sends the exact SUBMITTED revision and moves the request to QUOTATION_PENDING', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    const submitted = await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);

    const sent = await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: submitted.revision.id },
      adminUserId,
    );
    assert.equal(sent.quotation.status, 'SENT');
    assert.equal(sent.quotation.sentRevisionId, submitted.revision.id);
    assert.ok(!Number.isNaN(Date.parse(sent.quotation.sentAt!)));
    assert.equal(sent.revision.revisionNumber, 1);
    assert.deepEqual(sent.revision.totals, {
      laborTotal: 150000, materialTotal: 0, otherTotal: 0, grandTotal: 150000,
    });
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_PENDING');

    const events = await eventsFor(ctx.quotation.id);
    const sentEvents = events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_SENT');
    assert.equal(sentEvents.length, 1);
    assert.equal(sentEvents[0].entity_type, 'HANDYMAN_QUOTATION');
    assert.equal(sentEvents[0].metadata.revisionId, submitted.revision.id);
    assert.equal(sentEvents[0].metadata.revisionNumber, 1);
    assert.equal(sentEvents[0].metadata.requestNumber, ctx.request.requestNumber);

    // Sent facts are immutable: a second send is rejected.
    await expectError(
      sendHandymanQuotation(
        { quotationId: ctx.quotation.id, revisionId: submitted.revision.id },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_STATE_INVALID',
      409,
    );
  });

  it('rejects sending anything but a SUBMITTED revision of the same quotation', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);

    // DRAFT revision cannot be sent.
    await expectError(
      sendHandymanQuotation(
        { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_SEND_REVISION_INVALID',
      409,
    );

    // A SUBMITTED revision of ANOTHER quotation cannot be bound.
    const other = await makeQuotableContext();
    await addPricedLaborLine(other, 100000);
    const otherSubmitted = await submitHandymanQuotationRevision(other.revision.id, adminUserId);
    await expectError(
      sendHandymanQuotation(
        { quotationId: ctx.quotation.id, revisionId: otherSubmitted.revision.id },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_SEND_REVISION_INVALID',
      409,
    );
    // The foreign send attempt did not mutate either quotation.
    const stored = await getHandymanQuotation(ctx.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, 'DRAFT');
    assert.equal(stored.quotation.sentRevisionId, null);
  });

  it('blocks a second SENT quotation while the request is already QUOTATION_PENDING', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    // Second envelope created while the request was still TRIAGED.
    const second = await createHandymanQuotation(
      { requestId: ctx.request.id, currency: 'IDR' },
      adminUserId,
    );
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);
    await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
      adminUserId,
    );
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_PENDING');

    await addHandymanQuotationLine(
      {
        revisionId: second.revision.id,
        lineType: 'OTHER',
        description: 'Competing offer line',
        unitPrice: 10000,
      },
      adminUserId,
    );
    await submitHandymanQuotationRevision(second.revision.id, adminUserId);
    // The request already left the quotable states — the send fails closed
    // and the second envelope cannot become SENT.
    await expectError(
      sendHandymanQuotation(
        { quotationId: second.quotation.id, revisionId: second.revision.id },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_NOT_ALLOWED',
      409,
    );
    const stored = await getHandymanQuotation(second.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, 'DRAFT');
  });

  it('re-validates LABOR authority at send time against governed selections', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);

    // The selection loses authority between authoring and send.
    await supersedeHandymanRequestServiceSelection(ctx.selection.id, adminUserId);

    await expectError(
      sendHandymanQuotation(
        { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
        adminUserId,
      ),
      'HANDYMAN_QUOTATION_LINE_SERVICE_NOT_SELECTED',
      409,
    );
    // Nothing moved: the quotation stays DRAFT and the request stays TRIAGED.
    const stored = await getHandymanQuotation(ctx.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, 'DRAFT');
    assert.equal(stored.quotation.sentRevisionId, null);
    assert.equal(await requestStatus(ctx.request.id), 'TRIAGED');
  });

  it('sends on the inspection path after a completed inspection', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const service = await createService(h.client.id);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const inspection = await openHandymanInspection({ requestId: request.id }, adminUserId);
    await completeHandymanInspection(
      inspection.id,
      { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Replace the capacitor' },
      adminUserId,
    );
    await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: service.id, source: 'INSPECTION' },
      adminUserId,
    );

    const created = await createHandymanQuotation(
      { requestId: request.id, currency: 'IDR' },
      adminUserId,
    );
    await addHandymanQuotationLine(
      {
        revisionId: created.revision.id,
        lineType: 'LABOR',
        serviceCatalogId: service.id,
        unitPrice: 250000,
        deviationNote: 'No catalog reference for this service yet',
      },
      adminUserId,
    );
    await submitHandymanQuotationRevision(created.revision.id, adminUserId);
    const sent = await sendHandymanQuotation(
      { quotationId: created.quotation.id, revisionId: created.revision.id },
      adminUserId,
    );
    assert.equal(sent.quotation.status, 'SENT');
    assert.equal(await requestStatus(request.id), 'QUOTATION_PENDING');
  });

  it('withdraws a SENT quotation, retains sent facts, and returns the request', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);
    const sent = await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
      adminUserId,
    );

    // Withdrawal is only governed from SENT.
    const withdrawn = await withdrawHandymanQuotation(ctx.quotation.id, adminUserId);
    assert.equal(withdrawn.status, 'WITHDRAWN');
    assert.ok(!Number.isNaN(Date.parse(withdrawn.withdrawnAt!)));
    // The last-sent facts are retained as history.
    assert.equal(withdrawn.sentRevisionId, sent.quotation.sentRevisionId);
    assert.equal(withdrawn.sentAt, sent.quotation.sentAt);
    assert.equal(await requestStatus(ctx.request.id), 'TRIAGED');

    const events = await eventsFor(ctx.quotation.id);
    const withdrawnEvents = events.filter(
      (e) => e.event_type === 'HANDYMAN_QUOTATION_WITHDRAWN',
    );
    assert.equal(withdrawnEvents.length, 1);
    assert.equal(withdrawnEvents[0].metadata.sentRevisionId, sent.quotation.sentRevisionId);

    await expectError(
      withdrawHandymanQuotation(ctx.quotation.id, adminUserId),
      'HANDYMAN_QUOTATION_STATE_INVALID',
      409,
    );
    await expectError(
      withdrawHandymanQuotation(randomUUID(), adminUserId),
      'HANDYMAN_QUOTATION_NOT_FOUND',
      404,
    );
  });

  it('returns an inspection-path request to INSPECTION_COMPLETED on withdraw', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const service = await createService(h.client.id);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const inspection = await openHandymanInspection({ requestId: request.id }, adminUserId);
    await completeHandymanInspection(
      inspection.id,
      { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Seal the drain line' },
      adminUserId,
    );
    await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: service.id, source: 'INSPECTION' },
      adminUserId,
    );
    const created = await createHandymanQuotation(
      { requestId: request.id, currency: 'IDR' },
      adminUserId,
    );
    await addHandymanQuotationLine(
      {
        revisionId: created.revision.id,
        lineType: 'LABOR',
        serviceCatalogId: service.id,
        unitPrice: 120000,
        deviationNote: 'Manual rate — no reference entry',
      },
      adminUserId,
    );
    await submitHandymanQuotationRevision(created.revision.id, adminUserId);
    await sendHandymanQuotation(
      { quotationId: created.quotation.id, revisionId: created.revision.id },
      adminUserId,
    );
    await withdrawHandymanQuotation(created.quotation.id, adminUserId);
    assert.equal(await requestStatus(request.id), 'INSPECTION_COMPLETED');
  });

  it('runs the full re-quote loop under ONE quotation identity', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);
    await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
      adminUserId,
    );
    await withdrawHandymanQuotation(ctx.quotation.id, adminUserId);

    // New DRAFT revision under the SAME identity (no second quotation).
    const rev2 = await createHandymanQuotationRevision(
      { quotationId: ctx.quotation.id, notes: 'Customer asked for a revised offer' },
      adminUserId,
    );
    assert.equal(rev2.revisionNumber, 2);
    await addHandymanQuotationLine(
      {
        revisionId: rev2.id,
        lineType: 'LABOR',
        serviceCatalogId: ctx.service.id,
        unitPrice: 140000,
        deviationNote: 'Goodwill reduction from the 150000 reference',
      },
      adminUserId,
    );
    const submitted2 = await submitHandymanQuotationRevision(rev2.id, adminUserId);
    // The previously SENT (now historical) revision 1 was SUPERSEDED by
    // submit-time supersede only if it was still SUBMITTED; after send it
    // stays SUBMITTED history — supersede targets SUBMITTED rows.
    assert.deepEqual(submitted2.supersededRevisionIds, [ctx.revision.id]);

    const resent = await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: rev2.id },
      adminUserId,
    );
    assert.equal(resent.quotation.id, ctx.quotation.id);
    assert.equal(resent.quotation.quotationNumber, ctx.quotation.quotationNumber);
    assert.equal(resent.quotation.status, 'SENT');
    assert.equal(resent.quotation.sentRevisionId, rev2.id);
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_PENDING');

    // Full history is preserved and readable.
    const revisions = await listHandymanQuotationRevisions(ctx.quotation.id, adminUserId);
    assert.equal(revisions.length, 2);
    assert.equal(revisions.find((r) => r.revisionNumber === 1)!.status, 'SUPERSEDED');
    assert.equal(revisions.find((r) => r.revisionNumber === 2)!.status, 'SUBMITTED');

    const stored = await pool!.query(
      'SELECT count(*)::int AS n FROM handyman_quotations WHERE request_id = $1',
      [ctx.request.id],
    );
    assert.equal(stored.rows[0].n, 1);

    const events = await eventsFor(ctx.quotation.id);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_SENT').length, 2);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_WITHDRAWN').length, 1);
  });
});

describe('CR-HM-BE-03 RUN 2 — concurrency and audit', () => {
  it('resolves concurrent submits of one DRAFT revision to a single winner', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);

    const results = await Promise.allSettled([
      submitHandymanQuotationRevision(ctx.revision.id, adminUserId),
      submitHandymanQuotationRevision(ctx.revision.id, adminUserId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const rejection = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string;
      statusCode?: number;
    };
    assert.equal(rejection.code, 'HANDYMAN_QUOTATION_REVISION_STATE_INVALID');
    assert.equal(rejection.statusCode, 409);

    const stored = await pool!.query(
      `SELECT count(*)::int AS n FROM handyman_quotation_revisions
       WHERE id = $1 AND status = 'SUBMITTED'`,
      [ctx.revision.id],
    );
    assert.equal(stored.rows[0].n, 1);
    const events = await eventsFor(ctx.revision.id);
    assert.equal(
      events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_REVISION_SUBMITTED').length,
      1,
    );
  });

  it('resolves concurrent sends to one binding and one request transition', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);

    const results = await Promise.allSettled([
      sendHandymanQuotation(
        { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
        adminUserId,
      ),
      sendHandymanQuotation(
        { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1);
    const rejection = (
      results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    ).reason as { code?: string; statusCode?: number };
    assert.ok(
      ['HANDYMAN_QUOTATION_STATE_INVALID', 'HANDYMAN_REQUEST_STATUS_INVALID'].includes(
        rejection.code ?? '',
      ),
      `unexpected concurrent-send rejection code ${rejection.code}`,
    );
    assert.equal(rejection.statusCode, 409);

    const stored = await getHandymanQuotation(ctx.quotation.id, adminUserId);
    assert.equal(stored.quotation.status, 'SENT');
    assert.equal(stored.quotation.sentRevisionId, ctx.revision.id);
    assert.equal(await requestStatus(ctx.request.id), 'QUOTATION_PENDING');
    const events = await eventsFor(ctx.quotation.id);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_QUOTATION_SENT').length, 1);
  });

  it('collapses concurrent duplicate creations under one idempotency key', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);
    const key = `IDEM_${suffix()}`;

    const results = await Promise.allSettled([
      createHandymanQuotation(
        { requestId: request.id, currency: 'IDR', idempotencyKey: key },
        adminUserId,
      ),
      createHandymanQuotation(
        { requestId: request.id, currency: 'IDR', idempotencyKey: key },
        adminUserId,
      ),
    ]);
    const fulfilled = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createHandymanQuotation>>> =>
        r.status === 'fulfilled')
      .map((r) => r.value);
    // Either both resolve to the SAME envelope (winner + replay) or exactly
    // one wins; in both cases exactly one row exists.
    const stored = await pool!.query(
      'SELECT id FROM handyman_quotations WHERE request_id = $1',
      [request.id],
    );
    assert.equal(stored.rowCount, 1);
    for (const value of fulfilled) {
      assert.equal(value.quotation.id, stored.rows[0].id);
    }
    assert.ok(fulfilled.length >= 1);
  });

  it('records quotation events without customer PII', async (t) => {
    if (!ready(t)) return;
    const ctx = await makeQuotableContext();
    await addPricedLaborLine(ctx, 150000);
    await submitHandymanQuotationRevision(ctx.revision.id, adminUserId);
    await sendHandymanQuotation(
      { quotationId: ctx.quotation.id, revisionId: ctx.revision.id },
      adminUserId,
    );

    const result = await pool!.query(
      `SELECT event_type, metadata, summary FROM operational_events
       WHERE entity_type IN (
         'HANDYMAN_QUOTATION', 'HANDYMAN_QUOTATION_REVISION', 'HANDYMAN_QUOTATION_LINE'
       )`,
    );
    assert.ok(result.rowCount! >= 4);
    for (const row of result.rows as {
      event_type: string;
      metadata: Record<string, unknown>;
      summary: string;
    }[]) {
      const keys = Object.keys(row.metadata ?? {});
      for (const banned of ['customerName', 'customerPhone', 'customerEmail']) {
        assert.ok(!keys.includes(banned), `${row.event_type} metadata leaks ${banned}`);
      }
      assert.ok(!row.summary.includes(CUSTOMER_PHONE));
      assert.ok(!row.summary.includes(CUSTOMER_EMAIL));
      assert.ok(!row.summary.includes(CUSTOMER_NAME));
    }
  });
});
