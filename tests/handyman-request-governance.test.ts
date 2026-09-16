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
import { floorService } from '../src/modules/floors';
import {
  cancelHandymanRequest,
  createHandymanRequest,
  getHandymanRequestById,
} from '../src/modules/handyman-requests';
import {
  cancelHandymanInspection,
  completeHandymanInspection,
  getHandymanInspection,
  getHandymanRequestService,
  getHandymanRequestTriage,
  HANDYMAN_TRIAGE_PATHS,
  handymanRequestTriageRepository,
  listHandymanInspections,
  listHandymanRequestServices,
  listHandymanRequestTriages,
  openHandymanInspection,
  selectHandymanRequestService,
  supersedeHandymanRequestServiceSelection,
  triageHandymanRequest,
} from '../src/modules/handyman-request-governance';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-03 RUN 1 — focused repository/service tests for the request
 * governance foundation: append-only triage history, governed request↔service
 * selection, and the thin inspection aggregate. Also re-asserts the untouched
 * CR-HM-BE-01 cancellation semantics (SUBMITTED → CANCELLED only) and the
 * audit/PII conventions on operational events.
 */

const PORT = 55480;
const DIR = '/tmp/asentra-hm03-run1-pg';
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

const CUSTOMER_NAME = 'Ahmad Resident';
const CUSTOMER_PHONE = '+6281234567890';
const CUSTOMER_EMAIL = 'ahmad@resident.example.com';
const DIAGNOSIS_TEXT = 'Condensation buildup on the evaporator coil';

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
    `TRUNCATE handyman_request_triages, handyman_request_services,
      handyman_inspections, handyman_requests, handyman_providers,
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
      name: 'Governance Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Governance Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Governance Tower',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
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
      title: 'AC Leaking Water',
      description: 'Water dripping from the indoor split unit.',
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
      name: 'Governance Service',
      category,
    },
    adminUserId,
  );
}

async function createChecklistExecution(
  clientId: string,
  status: 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' = 'DRAFT',
): Promise<string> {
  const templateId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_templates (id, client_id, code, name, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')`,
    [templateId, clientId, `CT_${suffix()}`, 'Handyman Inspection Checklist'],
  );
  const executionId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_executions (id, client_id, checklist_template_id, status)
     VALUES ($1, $2, $3, $4)`,
    [executionId, clientId, templateId, status],
  );
  return executionId;
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

describe('CR-HM-BE-03 RUN 1 — triage history authority', () => {
  it('triages a SUBMITTED request onto the QUOTATION path', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);

    const triage = await triageHandymanRequest(
      { requestId: request.id, path: 'QUOTATION', notes: '  Known simple scope  ' },
      adminUserId,
    );
    assert.equal(triage.requestId, request.id);
    assert.equal(triage.clientId, h.client.id);
    assert.equal(triage.buildingId, h.building.id);
    assert.equal(triage.path, 'QUOTATION');
    assert.equal(triage.notes, 'Known simple scope');
    assert.equal(triage.status, 'ACTIVE');
    assert.equal(triage.triagedByUserId, adminUserId);
    assert.ok(!Number.isNaN(Date.parse(triage.triagedAt)));
    assert.equal(triage.supersededAt, null);

    assert.equal(await requestStatus(request.id), 'TRIAGED');

    const events = await eventsFor(request.id);
    const triaged = events.filter((e) => e.event_type === 'HANDYMAN_REQUEST_TRIAGED');
    assert.equal(triaged.length, 1);
    assert.equal(triaged[0].entity_type, 'HANDYMAN_REQUEST');
    assert.equal(triaged[0].metadata.path, 'QUOTATION');
    assert.equal(triaged[0].metadata.triageId, triage.id);
    assert.equal(triaged[0].metadata.previousStatus, 'SUBMITTED');
    assert.equal(triaged[0].metadata.newStatus, 'TRIAGED');
  });

  it('triages onto the INSPECTION path and moves the request to INSPECTION_REQUIRED', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);

    const triage = await triageHandymanRequest(
      { requestId: request.id, path: 'INSPECTION', notes: 'Uncertain scope' },
      adminUserId,
    );
    assert.equal(triage.path, 'INSPECTION');
    assert.equal(triage.status, 'ACTIVE');
    assert.equal(await requestStatus(request.id), 'INSPECTION_REQUIRED');
  });

  it('rejects a first triage of a non-SUBMITTED request', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    // CR-HM-BE-01 cancellation semantics remain SUBMITTED → CANCELLED only.
    const cancelled = await cancelHandymanRequest(request.id, adminUserId);
    assert.equal(cancelled.status, 'CANCELLED');

    await expectError(
      triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId),
      'HANDYMAN_REQUEST_STATUS_INVALID',
      400,
    );
  });

  it('rejects triage of an unknown request with 404', async (t) => {
    if (!ready(t)) return;
    await expectError(
      triageHandymanRequest({ requestId: randomUUID(), path: 'QUOTATION' }, adminUserId),
      'HANDYMAN_REQUEST_NOT_FOUND',
      404,
    );
  });

  it('preserves history on re-triage and supersedes TRIAGE-source selections', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const svc1 = await createService(h.client.id);
    const svc2 = await createService(h.client.id);

    const first = await triageHandymanRequest(
      { requestId: request.id, path: 'QUOTATION' },
      adminUserId,
    );
    const sel1 = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc1.id, source: 'TRIAGE' },
      adminUserId,
    );
    await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc2.id, source: 'TRIAGE' },
      adminUserId,
    );

    const second = await triageHandymanRequest(
      { requestId: request.id, path: 'INSPECTION', notes: 'Scope turned uncertain' },
      adminUserId,
    );

    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'ACTIVE');
    assert.equal(second.path, 'INSPECTION');
    assert.equal(await requestStatus(request.id), 'INSPECTION_REQUIRED');

    const history = await listHandymanRequestTriages(request.id, adminUserId);
    assert.equal(history.length, 2);
    const superseded = history.find((row) => row.id === first.id);
    assert.equal(superseded?.status, 'SUPERSEDED');
    assert.ok(superseded?.supersededAt);
    assert.equal(superseded?.supersededByUserId, adminUserId);
    const active = history.filter((row) => row.status === 'ACTIVE');
    assert.equal(active.length, 1);
    assert.equal(active[0].id, second.id);

    // TRIAGE-source selections were superseded with the prior decision.
    const selections = await listHandymanRequestServices(request.id, adminUserId);
    assert.equal(selections.length, 2);
    assert.ok(selections.every((row) => row.status === 'SUPERSEDED'));
    const sel1Row = await getHandymanRequestService(sel1.id, adminUserId);
    assert.equal(sel1Row.status, 'SUPERSEDED');
    assert.equal(sel1Row.supersededByUserId, adminUserId);

    const events = await eventsFor(request.id);
    const retriaged = events.filter((e) => e.event_type === 'HANDYMAN_REQUEST_RETRIAGED');
    assert.equal(retriaged.length, 1);
    assert.equal(retriaged[0].metadata.previousTriageId, first.id);
    assert.equal(retriaged[0].metadata.newStatus, 'INSPECTION_REQUIRED');
    assert.deepEqual(
      (retriaged[0].metadata.supersededSelectionIds as string[]).sort(),
      [sel1.id, selections.find((r) => r.id !== sel1.id)!.id].sort(),
    );
  });

  it('blocks re-triage onto QUOTATION while an inspection is OPEN', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    await openHandymanInspection({ requestId: request.id }, adminUserId);

    await expectError(
      triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId),
      'HANDYMAN_INSPECTION_ALREADY_OPEN',
      409,
    );

    // Re-triage staying on the INSPECTION path remains allowed.
    const retriage = await triageHandymanRequest(
      { requestId: request.id, path: 'INSPECTION', notes: 'Re-scoped' },
      adminUserId,
    );
    assert.equal(retriage.status, 'ACTIVE');
    assert.equal(await requestStatus(request.id), 'INSPECTION_REQUIRED');
  });

  it('allows re-triage from INSPECTION_COMPLETED back onto QUOTATION', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const inspection = await openHandymanInspection({ requestId: request.id }, adminUserId);
    await completeHandymanInspection(
      inspection.id,
      { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Replace drain pipe and reseal' },
      adminUserId,
    );
    assert.equal(await requestStatus(request.id), 'INSPECTION_COMPLETED');

    const retriage = await triageHandymanRequest(
      { requestId: request.id, path: 'QUOTATION' },
      adminUserId,
    );
    assert.equal(retriage.path, 'QUOTATION');
    assert.equal(await requestStatus(request.id), 'TRIAGED');
  });

  it('keeps exactly one ACTIVE triage under concurrent first-triage commands', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);

    const results = await Promise.allSettled([
      triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId),
      triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'at least one triage command must succeed');

    const history = await listHandymanRequestTriages(request.id, adminUserId);
    const active = history.filter((row) => row.status === 'ACTIVE');
    assert.equal(active.length, 1, 'the one-ACTIVE-per-request invariant must hold');
    const status = await requestStatus(request.id);
    assert.ok(['TRIAGED', 'INSPECTION_REQUIRED'].includes(status));
    assert.equal(status, active[0].path === 'QUOTATION' ? 'TRIAGED' : 'INSPECTION_REQUIRED');
  });

  it('supports governed triage reads with building access enforcement', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const triage = await triageHandymanRequest(
      { requestId: request.id, path: 'QUOTATION' },
      adminUserId,
    );

    const fetched = await getHandymanRequestTriage(triage.id, adminUserId);
    assert.equal(fetched.id, triage.id);

    await expectError(
      getHandymanRequestTriage(triage.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanRequestTriages(request.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(getHandymanRequestTriage(randomUUID(), adminUserId), 'HANDYMAN_TRIAGE_NOT_FOUND', 404);
  });
});

describe('CR-HM-BE-03 RUN 1 — governed service selection', () => {
  it('allows multiple distinct ACTIVE services and rejects duplicates', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);
    const svc1 = await createService(h.client.id);
    const svc2 = await createService(h.client.id);

    const sel1 = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc1.id, source: 'TRIAGE' },
      adminUserId,
    );
    const sel2 = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc2.id, source: 'TRIAGE' },
      adminUserId,
    );
    assert.equal(sel1.status, 'ACTIVE');
    assert.equal(sel2.status, 'ACTIVE');
    assert.equal(sel1.source, 'TRIAGE');
    assert.equal(sel1.selectedByUserId, adminUserId);
    assert.equal(sel1.clientId, h.client.id);
    assert.equal(sel1.buildingId, h.building.id);

    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc1.id, source: 'TRIAGE' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_SERVICE_ALREADY_ACTIVE',
      409,
    );

    const events = await eventsFor(sel1.id);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_REQUEST_SERVICE_SELECTED').length, 1);
  });

  it('supersedes a selection and allows re-selection with preserved history', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);
    const svc = await createService(h.client.id);
    const first = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
      adminUserId,
    );

    const superseded = await supersedeHandymanRequestServiceSelection(first.id, adminUserId);
    assert.equal(superseded.status, 'SUPERSEDED');
    assert.ok(superseded.supersededAt);
    assert.equal(superseded.supersededByUserId, adminUserId);

    await expectError(
      supersedeHandymanRequestServiceSelection(first.id, adminUserId),
      'HANDYMAN_REQUEST_SERVICE_STATE_INVALID',
      409,
    );

    const second = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
      adminUserId,
    );
    assert.equal(second.status, 'ACTIVE');
    assert.notEqual(second.id, first.id);

    const history = await listHandymanRequestServices(request.id, adminUserId);
    assert.equal(history.length, 2);
    const activeOnly = await listHandymanRequestServices(request.id, adminUserId, {
      status: 'ACTIVE',
    });
    assert.deepEqual(activeOnly.map((row) => row.id), [second.id]);
  });

  it('enforces TRIAGE vs INSPECTION source guards', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    const svc = await createService(h.client.id);

    // No triage yet.
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_TRIAGE_NOT_ALLOWED',
      409,
    );

    // INSPECTION path: TRIAGE-source is invalid; INSPECTION-source requires
    // a completed inspection.
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_SERVICE_SOURCE_INVALID',
      409,
    );
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc.id, source: 'INSPECTION' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_SERVICE_SOURCE_INVALID',
      409,
    );

    const inspection = await openHandymanInspection({ requestId: request.id }, adminUserId);
    await completeHandymanInspection(
      inspection.id,
      { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Reroute drainage' },
      adminUserId,
    );

    // After completion the INSPECTION source is valid; TRIAGE source is not.
    const selection = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc.id, source: 'INSPECTION' },
      adminUserId,
    );
    assert.equal(selection.source, 'INSPECTION');
    assert.equal(selection.status, 'ACTIVE');
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: (await createService(h.client.id)).id, source: 'TRIAGE' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_SERVICE_SOURCE_INVALID',
      409,
    );
  });

  it('rejects unknown, inactive, wrong-client, and non-HANDYMAN services', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);

    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: randomUUID(), source: 'TRIAGE' },
        adminUserId,
      ),
      'SERVICE_CATALOG_NOT_FOUND',
      404,
    );

    const deactivated = await createService(h.client.id);
    await serviceCatalogService.deactivateServiceCatalogEntry(deactivated.id, adminUserId);
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: deactivated.id, source: 'TRIAGE' },
        adminUserId,
      ),
      'SERVICE_CATALOG_NOT_ACTIVE',
      409,
    );

    const otherClient = await createHierarchy();
    const foreign = await createService(otherClient.client.id);
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: foreign.id, source: 'TRIAGE' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_SERVICE_CLIENT_MISMATCH',
      400,
    );

    const mep = await createService(h.client.id, 'MEP');
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: mep.id, source: 'TRIAGE' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_SERVICE_NOT_HANDYMAN',
      400,
    );

    // The centralized category convention normalizes case/whitespace.
    const normalized = await createService(h.client.id, ' handyman ');
    const ok = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: normalized.id, source: 'TRIAGE' },
      adminUserId,
    );
    assert.equal(ok.status, 'ACTIVE');
  });

  it('translates the partial unique index under concurrent duplicate selection', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);
    const svc = await createService(h.client.id);

    const results = await Promise.allSettled([
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
        adminUserId,
      ),
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    assert.equal(reason.code, 'HANDYMAN_REQUEST_SERVICE_ALREADY_ACTIVE');

    const active = await listHandymanRequestServices(request.id, adminUserId, {
      status: 'ACTIVE',
    });
    assert.equal(active.length, 1);
  });

  it('enforces building access on selection commands and reads', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'QUOTATION' }, adminUserId);
    const svc = await createService(h.client.id);
    const selection = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
      adminUserId,
    );

    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc.id, source: 'TRIAGE' },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      supersedeHandymanRequestServiceSelection(selection.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanRequestService(selection.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanRequestServices(request.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanRequestService(randomUUID(), adminUserId),
      'HANDYMAN_REQUEST_SERVICE_NOT_FOUND',
      404,
    );
  });
});

describe('CR-HM-BE-03 RUN 1 — inspection authority', () => {
  it('opens inspections only on the governed INSPECTION path', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();

    // Untriaged SUBMITTED request.
    const plain = await createRequest(h);
    await expectError(
      openHandymanInspection({ requestId: plain.id }, adminUserId),
      'HANDYMAN_INSPECTION_NOT_ALLOWED',
      409,
    );

    // QUOTATION-path request.
    const quoted = await createRequest(h);
    await triageHandymanRequest({ requestId: quoted.id, path: 'QUOTATION' }, adminUserId);
    await expectError(
      openHandymanInspection({ requestId: quoted.id }, adminUserId),
      'HANDYMAN_INSPECTION_NOT_ALLOWED',
      409,
    );

    // INSPECTION-path request.
    const inspected = await createRequest(h);
    await triageHandymanRequest(
      { requestId: inspected.id, path: 'INSPECTION' },
      adminUserId,
    );
    const opened = await openHandymanInspection({ requestId: inspected.id }, adminUserId);
    assert.equal(opened.status, 'OPEN');
    assert.equal(opened.requestId, inspected.id);
    assert.equal(opened.clientId, h.client.id);
    assert.equal(opened.buildingId, h.building.id);
    assert.equal(opened.spaceId, h.space.id);
    assert.equal(opened.openedByUserId, adminUserId);
    assert.equal(opened.diagnosis, null);
    assert.equal(opened.inspectedByUserId, null);

    const events = await eventsFor(opened.id);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_INSPECTION_OPENED').length, 1);
  });

  it('rejects a duplicate OPEN inspection', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    await openHandymanInspection({ requestId: request.id }, adminUserId);

    await expectError(
      openHandymanInspection({ requestId: request.id }, adminUserId),
      'HANDYMAN_INSPECTION_ALREADY_OPEN',
      409,
    );
  });

  it('validates the optional checklist binding through the existing engine', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);

    const executionId = await createChecklistExecution(h.client.id);
    const opened = await openHandymanInspection(
      { requestId: request.id, checklistExecutionId: executionId },
      adminUserId,
    );
    assert.equal(opened.checklistExecutionId, executionId);
    await completeHandymanInspection(
      opened.id,
      { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Seal the pipe joint' },
      adminUserId,
    );

    // Wrong-client execution.
    const other = await createHierarchy();
    const otherRequest = await createRequest(other);
    await triageHandymanRequest(
      { requestId: otherRequest.id, path: 'INSPECTION' },
      adminUserId,
    );
    await expectError(
      openHandymanInspection(
        { requestId: otherRequest.id, checklistExecutionId: executionId },
        adminUserId,
      ),
      'HANDYMAN_INSPECTION_CHECKLIST_INVALID',
      400,
    );

    // Cancelled execution.
    const cancelledExecution = await createChecklistExecution(h.client.id, 'CANCELLED');
    const second = await createRequest(h);
    await triageHandymanRequest(
      { requestId: second.id, path: 'INSPECTION' },
      adminUserId,
    );
    await expectError(
      openHandymanInspection(
        { requestId: second.id, checklistExecutionId: cancelledExecution },
        adminUserId,
      ),
      'HANDYMAN_INSPECTION_CHECKLIST_INVALID',
      400,
    );

    // Unknown execution → the engine's governed 404.
    await expectError(
      openHandymanInspection(
        { requestId: second.id, checklistExecutionId: randomUUID() },
        adminUserId,
      ),
      'NOT_FOUND',
      404,
    );
  });

  it('requires diagnosis and scope notes, completes guarded, and freezes COMPLETED rows', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const opened = await openHandymanInspection({ requestId: request.id }, adminUserId);

    await expectError(
      completeHandymanInspection(opened.id, { diagnosis: '   ', scopeNotes: '' }, adminUserId),
      'VALIDATION_ERROR',
      400,
    );

    const completed = await completeHandymanInspection(
      opened.id,
      { diagnosis: `  ${DIAGNOSIS_TEXT}  `, scopeNotes: 'Replace the drain pipe' },
      adminUserId,
    );
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.diagnosis, DIAGNOSIS_TEXT);
    assert.equal(completed.scopeNotes, 'Replace the drain pipe');
    assert.equal(completed.inspectedByUserId, adminUserId);
    assert.ok(completed.inspectedAt);
    assert.equal(await requestStatus(request.id), 'INSPECTION_COMPLETED');

    // COMPLETED is immutable.
    await expectError(
      completeHandymanInspection(
        opened.id,
        { diagnosis: 'Another diagnosis', scopeNotes: 'Another scope' },
        adminUserId,
      ),
      'HANDYMAN_INSPECTION_STATE_INVALID',
      409,
    );
    await expectError(
      cancelHandymanInspection(opened.id, adminUserId),
      'HANDYMAN_INSPECTION_STATE_INVALID',
      409,
    );

    const events = await eventsFor(opened.id);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_INSPECTION_COMPLETED').length, 1);
  });

  it('cancels an OPEN inspection and keeps the request INSPECTION_REQUIRED', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const opened = await openHandymanInspection({ requestId: request.id }, adminUserId);

    const cancelled = await cancelHandymanInspection(opened.id, adminUserId);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(await requestStatus(request.id), 'INSPECTION_REQUIRED');

    // No completed inspection → INSPECTION-source selections stay invalid.
    const svc = await createService(h.client.id);
    await expectError(
      selectHandymanRequestService(
        { requestId: request.id, serviceCatalogId: svc.id, source: 'INSPECTION' },
        adminUserId,
      ),
      'HANDYMAN_REQUEST_SERVICE_SOURCE_INVALID',
      409,
    );

    // A fresh inspection can be opened after cancellation.
    const reopened = await openHandymanInspection({ requestId: request.id }, adminUserId);
    assert.equal(reopened.status, 'OPEN');
    const list = await listHandymanInspections(request.id, adminUserId);
    assert.equal(list.length, 2);
  });

  it('guards concurrent completion exactly once', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const opened = await openHandymanInspection({ requestId: request.id }, adminUserId);

    const results = await Promise.allSettled([
      completeHandymanInspection(
        opened.id,
        { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Scope A' },
        adminUserId,
      ),
      completeHandymanInspection(
        opened.id,
        { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Scope B' },
        adminUserId,
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    assert.equal(reason.code, 'HANDYMAN_INSPECTION_STATE_INVALID');

    assert.equal(await requestStatus(request.id), 'INSPECTION_COMPLETED');
    const stored = await getHandymanInspection(opened.id, adminUserId);
    assert.equal(stored.status, 'COMPLETED');
    const events = await eventsFor(opened.id);
    assert.equal(events.filter((e) => e.event_type === 'HANDYMAN_INSPECTION_COMPLETED').length, 1);
  });

  it('enforces building access on inspection commands and reads', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const opened = await openHandymanInspection({ requestId: request.id }, adminUserId);

    await expectError(
      openHandymanInspection({ requestId: request.id }, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      completeHandymanInspection(
        opened.id,
        { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Scope' },
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(cancelHandymanInspection(opened.id, outsiderUserId), 'BUILDING_ACCESS_DENIED', 403);
    await expectError(getHandymanInspection(opened.id, outsiderUserId), 'BUILDING_ACCESS_DENIED', 403);
    await expectError(listHandymanInspections(request.id, outsiderUserId), 'BUILDING_ACCESS_DENIED', 403);
    await expectError(getHandymanInspection(randomUUID(), adminUserId), 'HANDYMAN_INSPECTION_NOT_FOUND', 404);
  });
});

describe('CR-HM-BE-03 RUN 1 — audit conventions', () => {
  it('records governed events without PII in metadata', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const request = await createRequest(h);
    await triageHandymanRequest({ requestId: request.id, path: 'INSPECTION' }, adminUserId);
    const opened = await openHandymanInspection({ requestId: request.id }, adminUserId);
    await completeHandymanInspection(
      opened.id,
      { diagnosis: DIAGNOSIS_TEXT, scopeNotes: 'Replace the drain pipe' },
      adminUserId,
    );
    const svc = await createService(h.client.id);
    const selection = await selectHandymanRequestService(
      { requestId: request.id, serviceCatalogId: svc.id, source: 'INSPECTION' },
      adminUserId,
    );
    await supersedeHandymanRequestServiceSelection(selection.id, adminUserId);

    const result = await pool!.query(
      `SELECT event_type, metadata FROM operational_events WHERE client_id = $1`,
      [h.client.id],
    );
    const types = result.rows.map((row: { event_type: string }) => row.event_type);
    for (const expected of [
      'HANDYMAN_REQUEST_TRIAGED',
      'HANDYMAN_INSPECTION_OPENED',
      'HANDYMAN_INSPECTION_COMPLETED',
      'HANDYMAN_REQUEST_SERVICE_SELECTED',
      'HANDYMAN_REQUEST_SERVICE_SUPERSEDED',
    ]) {
      assert.ok(types.includes(expected), `expected event ${expected}`);
    }
    const serialized = JSON.stringify(result.rows.map((row: { metadata: unknown }) => row.metadata));
    assert.ok(!serialized.includes(CUSTOMER_NAME), 'customer name must not appear in metadata');
    assert.ok(!serialized.includes(CUSTOMER_PHONE), 'customer phone must not appear in metadata');
    assert.ok(!serialized.includes(CUSTOMER_EMAIL), 'customer email must not appear in metadata');
    assert.ok(!serialized.includes(DIAGNOSIS_TEXT), 'diagnosis text must not appear in metadata');
  });

  it('exposes the governed path convention', () => {
    assert.deepEqual([...HANDYMAN_TRIAGE_PATHS], ['QUOTATION', 'INSPECTION']);
    // Repository surface exists for guarded history operations.
    assert.equal(typeof handymanRequestTriageRepository.supersedeActive, 'function');
  });
});
