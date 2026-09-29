import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  handymanDisciplineRepository,
  handymanDisciplineService,
} from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestInspectionService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';

import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  addHandymanQuotationLine,
  decideHandymanQuotation,
  getHandymanExecutionScopeByQuotationVersion,
  getHandymanQuotationDecision,
  expireHandymanQuotationVersion,
  getCurrentHandymanIssuedQuotationVersion,
  issueHandymanQuotationVersion,
  supersedeHandymanQuotationVersion,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  getHandymanQuotation,
  getHandymanQuotationVersionTotals,
  listHandymanQuotationVersionLines,
} from '../src/modules/handyman-quotations';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-06 PART 05 — focused tests for approved Execution Scope
 * creation (FROZEN Decision Freeze F8/F9/F10/F11/F12): APPROVE-only
 * atomic scope creation, server-derived lineage/location snapshot,
 * one-scope-per-approved-version, replay safety, full transactional
 * rollback on scope failure, and zero FM/crew/schedule/arrival/
 * payment/BAST side effects.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keepRef = () => ({ handymanServiceRequestInspectionService });

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineIds: Record<string, string> = {};
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_service_variants, handyman_discipline_service_associations,
    service_catalog, evidence_submissions, operational_events,
    tenant_service_requests, work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  for (const code of [
    'SIMPLE_PLUMBING', 'FURNITURE', 'MINOR_CIVIL', 'GENERAL_HANDYMAN',
    'ELECTRICAL', 'AC', 'FM_COMMON_BUILDING',
  ]) {
    const d = await handymanDisciplineRepository.findDisciplineByCode(undefined, code);
    if (!d) throw new Error(`F9 discipline seed missing: ${code}`);
    disciplineIds[code] = d.id;
  }
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

async function tableCount(name: string): Promise<number> {
  const result = await q(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** Full tenant context + immutable CR-HM-01 BM_SUPER_APP attribution. */
async function attributedFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
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
    name: 'Tenant Space',
  });
  const company = await tenantCompanyService.createTenantCompany({
    clientId: client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  return { client, building, space, company, pic, linkedUser, attribution };
}

async function serviceEntry(clientId: string, category = 'FM_HINT_TEXT') {
  return serviceCatalogService.createServiceCatalogEntry({
    clientId,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category,
  }, adminUserId);
}

async function requestInDiagnosis(fixture: Awaited<ReturnType<typeof attributedFixture>>) {
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: fixture.attribution.id,
        serviceCatalogId: fixture.service.id,
      },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  return request;
}

async function directDiagnosisFixture() {
  const f = await attributedFixture();
  const service = await serviceEntry(f.client.id);
  const request = await requestInDiagnosis({ ...f, service });
  return { ...f, service, request };
}

type _Unused = typeof handymanServiceRequestInspectionService;
async function _inspectedDiagnosisFixture() {
  const f = await attributedFixture();
  const service = await serviceEntry(f.client.id);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: 'Needs site inspection.',
    },
    adminUserId,
  );
  await handymanServiceRequestInspectionService.recordHandymanInspection(
    {
      handymanRequestId: request.id,
      inspectionResult: 'INSPECTED',
      inspectionNotes: 'Inspected on site.',
    },
    adminUserId,
  );
  const after = await q(
    'SELECT status FROM handyman_service_requests WHERE id = $1',
    [request.id],
  );
  assert.equal(after.rows[0].status, 'DIAGNOSIS');
  return { ...f, service, request };
}

/** Full chain: request + diagnosis recorded -> READY_FOR_NEXT_STEP. */
async function diagnosedFixture(code: 'GENERAL_HANDYMAN' | 'FM_COMMON_BUILDING' =
  'GENERAL_HANDYMAN') {
  const f = await directDiagnosisFixture();
  const testDiagnosis = await handymanServiceRequestDiagnosisService
    .recordHandymanDiagnosis(
      {
        handymanRequestId: f.request.id,
        disciplineId: disciplineIds[code],
        diagnosis: 'Fixture diagnosis for quotation tests.',
      },
      adminUserId,
    );
  return { ...f, diagnosis: testDiagnosis };
}

/** units_of_measure master row (existing master, client-scoped). */
async function insertUom(clientId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  return id;
}

/** Client-material inventory item with a UOM (existing master). */
async function insertMaterialItem(clientId: string, uomId: string) {
  return inventoryItemService.createInventoryItem(
    {
      clientId,
      code: `ITM_${suffix()}`,
      name: 'Copper Pipe',
      itemType: 'MATERIAL',
      uomId,
    },
    adminUserId,
  );
}

/** Governed ACTIVE price-catalog entry (existing authority). */
async function insertActivePriceEntry(
  clientId: string,
  itemId: string,
  uomId: string,
  unitPrice: number,
) {
  const entry = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      sourceMode: 'MATERIAL',
      itemId,
      uomId,
      currency: 'IDR',
      unitPrice,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    adminUserId,
  );
  await priceCatalogEntryService.activatePriceCatalogEntry(
    entry.id,
    adminUserId,
  );
  return entry;
}
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

async function issuedFixture() {
  const f = await diagnosedFixture();
  const bundle = await createHandymanQuotation(
    { handymanRequestId: f.request.id }, adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = await insertUom(f.client.id);
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'L1', quantity: 2, uomId,
    currency: 'IDR', finalQuotedUnitAmount: 100,
  }, adminUserId);
  await issueHandymanQuotationVersion(
    version.id, { validUntil: FUTURE() }, adminUserId,
  );
  return { ...f, bundle, version, uomId };
}

/** Scope count scoped to one quotation version (shared DB safe). */
async function scopeCount(versionId: string): Promise<number> {
  const r = await q(
    `SELECT count(*)::int AS n FROM handyman_execution_scopes
      WHERE approved_quotation_version_id = $1`,
    [versionId],
  );
  return r.rows[0].n as number;
}

/** Issued chain rooted at a building-only attribution (no space). */
async function spacelessIssuedFixture() {
  const f = await attributedFixture();
  const attributionNoSpace = await createChannelAttribution({
    tenantCompanyId: f.company.id,
    buildingId: f.building.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: f.linkedUser.id,
  });
  const service = await serviceEntry(f.client.id);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attributionNoSpace.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  assert.equal(request.spaceId, null);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId: disciplineIds.GENERAL_HANDYMAN,
      diagnosis: 'Spaceless fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id }, adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = await insertUom(f.client.id);
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'L1', quantity: 1, uomId,
    currency: 'IDR', finalQuotedUnitAmount: 50,
  }, adminUserId);
  await issueHandymanQuotationVersion(
    version.id, { validUntil: FUTURE() }, adminUserId,
  );
  return { ...f, request, bundle, version };
}

describe('CR-HM-06 PART 05 — approved execution scope', () => {
  it('1: APPROVE creates exactly one AUTHORIZED execution scope', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const decision = await decideHandymanQuotation(
      f.version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    const scope = decision.executionScope;
    assert.ok(scope);
    assert.equal(scope.status, 'AUTHORIZED');
    assert.equal(await scopeCount(f.version.id), 1);
    const event = await q(
      `SELECT event_type, entity_type FROM operational_events
        WHERE metadata->>'executionScopeId' = $1`,
      [scope.id],
    );
    assert.equal(event.rows.length, 1);
    assert.equal(event.rows[0].event_type,
      'HANDYMAN_EXECUTION_SCOPE_CREATED');
    assert.equal(event.rows[0].entity_type, 'HANDYMAN_EXECUTION_SCOPE');
  });

  it('2: scope lineage matches exact approved quotation/version/decision/request', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const decision = await decideHandymanQuotation(
      f.version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    const scope = decision.executionScope!;
    assert.equal(scope.clientId, f.client.id);
    assert.equal(scope.handymanRequestId, f.request.id);
    assert.equal(scope.channelAttributionId, f.attribution.id);
    assert.equal(scope.quotationId, f.bundle.quotation.id);
    assert.equal(scope.approvedQuotationVersionId, f.version.id);
    assert.equal(scope.quotationDecisionId, decision.id);
    assert.equal(scope.createdByUserId, adminUserId);
  });

  it('3: customer + location snapshot server-derived', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const decision = await decideHandymanQuotation(
      f.version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    const scope = decision.executionScope!;
    assert.equal(scope.tenantCompanyId, f.company.id);
    assert.equal(scope.tenantPicId, f.pic.id);
    assert.equal(scope.buildingId, f.building.id);
    assert.equal(scope.spaceId, f.space.id);
    // Frozen chain: floor/area/room resolved server-side (non-null).
    assert.ok(scope.floorId);
    assert.ok(scope.areaId);
    assert.ok(scope.roomId);
    const read = await getHandymanExecutionScopeByQuotationVersion(
      f.version.id, adminUserId,
    );
    assert.equal(read.id, scope.id);
    assert.equal(read.tenantCompanyId, f.company.id);
  });

  it('4: NULL tenantPic remains NULL', async (t) => {
    if (!requireDatabase(t)) return;
    const g = await attributedFixture();
    const attributionNoPic = await createChannelAttribution({
      tenantCompanyId: g.company.id,
      buildingId: g.building.id,
      spaceId: g.space.id,
      originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
      createdByUserId: g.linkedUser.id,
    });
    const service = await serviceEntry(g.client.id);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest(
        {
          channelAttributionId: attributionNoPic.id,
          serviceCatalogId: service.id,
        },
        adminUserId,
      );
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: request.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Direct.',
      },
      adminUserId,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: request.id,
        disciplineId: disciplineIds.GENERAL_HANDYMAN,
        diagnosis: 'No-PIC scope test.',
      },
      adminUserId,
    );
    const bundle = await createHandymanQuotation(
      { handymanRequestId: request.id }, adminUserId,
    );
    const version = bundle.versions[0];
    const uomId = await insertUom(g.client.id);
    await addHandymanQuotationLine(version.id, {
      lineType: 'LABOR', description: 'L1', quantity: 1, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 10,
    }, adminUserId);
    await issueHandymanQuotationVersion(
      version.id, { validUntil: FUTURE() }, adminUserId,
    );
    const decision = await decideHandymanQuotation(
      version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    assert.equal(decision.executionScope?.tenantPicId, null);
  });

  it('5: REJECT creates zero execution scope', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const decision = await decideHandymanQuotation(
      f.version.id,
      { decision: 'REJECT', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    assert.equal(decision.executionScope, null);
    assert.equal(await scopeCount(f.version.id), 0);
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE event_type = 'HANDYMAN_EXECUTION_SCOPE_CREATED'
          AND metadata->>'quotationVersionId' = $1`,
      [f.version.id],
    );
    assert.equal(events.rows.length, 0);
  });

  it('6: non-approved quotation version cannot create scope directly', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    for (const status of ['DRAFT', 'SUPERSEDED', 'EXPIRED'] as const) {
      await q(`UPDATE handyman_quotation_versions SET status = $2
                WHERE id = $1`, [f.version.id, status]);
      await assert.rejects(
        decideHandymanQuotation(
          f.version.id,
          { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
          adminUserId,
        ),
        (e: unknown) =>
          errorCode(e) === 'HANDYMAN_QUOTATION_INVALID_TRANSITION',
      );
    }
    assert.equal(await scopeCount(f.version.id), 0);
    // Direct scope read against an unapproved version → 404.
    await assert.rejects(
      getHandymanExecutionScopeByQuotationVersion(
        f.version.id, adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );
  });

  it('7: same APPROVE replay returns same decision + same scope, no duplicate', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const key = `k-${randomUUID()}`;
    const first = await decideHandymanQuotation(
      f.version.id, { decision: 'APPROVE', idempotencyKey: key },
      adminUserId,
    );
    const replay = await decideHandymanQuotation(
      f.version.id, { decision: 'APPROVE', idempotencyKey: key },
      adminUserId,
    );
    assert.equal(replay.id, first.id);
    assert.equal(
      replay.executionScope?.id, first.executionScope?.id,
    );
    assert.equal(await scopeCount(f.version.id), 1);
    const events = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE event_type = 'HANDYMAN_EXECUTION_SCOPE_CREATED'
          AND metadata->>'quotationVersionId' = $1`,
      [f.version.id],
    );
    assert.equal(events.rows[0].n, 1);
  });

  it('8: conflicting/concurrent scope creation cannot violate one-scope-per-version', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const results = await Promise.allSettled(
      [0, 1].map((i) =>
        decideHandymanQuotation(
          f.version.id,
          {
            decision: 'APPROVE',
            idempotencyKey: `k-${randomUUID()}-c${i}`,
          },
          adminUserId,
        ),
      ),
    );
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(
      errorCode((losers[0] as PromiseRejectedResult).reason),
      'HANDYMAN_QUOTATION_DECISION_CONFLICT',
    );
    assert.equal(await scopeCount(f.version.id), 1);
    // One-scope invariant is DB-enforced for direct duplicates too.
    await assert.rejects(
      q(`INSERT INTO handyman_execution_scopes (
           id, client_id, handyman_request_id, channel_attribution_id,
           quotation_id, approved_quotation_version_id,
           quotation_decision_id, tenant_company_id, tenant_pic_id,
           building_id, floor_id, area_id, room_id, space_id,
           created_by_user_id
         ) SELECT $1, client_id, handyman_request_id,
                  channel_attribution_id, quotation_id,
                  approved_quotation_version_id, quotation_decision_id,
                  tenant_company_id, tenant_pic_id, building_id,
                  floor_id, area_id, room_id, space_id, created_by_user_id
             FROM handyman_execution_scopes
            WHERE approved_quotation_version_id = $2`,
      [randomUUID(), f.version.id]),
    );
  });

  it('9: forced scope-creation failure rolls back decision + APPROVED status + events + scope', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await spacelessIssuedFixture();
    const before = {
      decisions: await tableCount('handyman_quotation_decisions'),
      scopes: await tableCount('handyman_execution_scopes'),
      events: await tableCount('operational_events'),
    };
    await assert.rejects(
      decideHandymanQuotation(
        f.version.id,
        { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_EXECUTION_SCOPE_LOCATION_INCONSISTENT',
    );
    assert.equal(
      await tableCount('handyman_quotation_decisions'), before.decisions);
    assert.equal(
      await tableCount('handyman_execution_scopes'), before.scopes);
    assert.equal(await tableCount('operational_events'), before.events);
    const row = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(row.rows[0].status, 'ISSUED');
  });

  it('10: zero FM work_order/crew/schedule/arrival/payment/BAST side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const before = {
      workOrders: await tableCount('work_orders'),
      vendorQuotations: await tableCount('vendor_quotations'),
      bast: await tableCount('bast_documents'),
      crews: await tableCount('handyman_work_crews'),
      moves: await tableCount('inventory_stock_movements'),
    };
    const decision = await decideHandymanQuotation(
      f.version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    const after = {
      workOrders: await tableCount('work_orders'),
      vendorQuotations: await tableCount('vendor_quotations'),
      bast: await tableCount('bast_documents'),
      crews: await tableCount('handyman_work_crews'),
      moves: await tableCount('inventory_stock_movements'),
    };
    assert.deepEqual(after, before);
    // Scope row: no FM/binding/arrival/payment columns ever.
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_execution_scopes'`,
    );
    for (const row of cols.rows) {
      assert.ok(
        !/work_?order|vendor|crew|provider|schedul|arrival|qr|geofence|payment|bast|session/i.test(
          String(row.column_name),
        ),
        `forbidden scope column ${row.column_name}`,
      );
    }
    // Oracle: scope is exactly what PART 04 decision + PART 02/03 says.
    const scope = await getHandymanExecutionScopeByQuotationVersion(
      f.version.id, adminUserId,
    );
    assert.equal(scope.id, decision.executionScope?.id);
    assert.equal(scope.quotationDecisionId, decision.id);
  });
});
