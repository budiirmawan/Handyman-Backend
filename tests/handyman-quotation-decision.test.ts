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
 * CR-HM-06 PART 04 — focused tests for version-bound customer
 * decision (FROZEN Decision Freeze F6/F7/F8): eligibility against the
 * exact current ISSUED version, server-derived customer context,
 * replay-safe idempotency, atomic immutable decision + projection,
 * and zero execution-scope/payment/BAST/FM/crew/scheduling effects.
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

/** Decision count scoped to one quotation thread (shared DB safe). */
async function decisionCount(quotationId: string): Promise<number> {
  const r = await q(
    `SELECT count(*)::int AS n FROM handyman_quotation_decisions
      WHERE quotation_id = $1`,
    [quotationId],
  );
  return r.rows[0].n as number;
}

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

describe('CR-HM-06 PART 04 — quotation customer decision', () => {
  it('1: current ISSUED exact version can APPROVE', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const decision = await decideHandymanQuotation(
      f.version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    assert.equal(decision.decision, 'APPROVE');
    assert.equal(decision.quotationVersionId, f.version.id);
    assert.equal(decision.clientId, f.client.id);
    const versionRow = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(versionRow.rows[0].status, 'APPROVED');
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE metadata->>'quotationVersionId' = $1
          AND event_type = 'HANDYMAN_QUOTATION_APPROVED'`,
      [f.version.id],
    );
    assert.equal(events.rows.length, 1);
    // PART 05 final semantics: APPROVE atomically created the scope.
    const scope = await getHandymanExecutionScopeByQuotationVersion(
      f.version.id, adminUserId,
    );
    assert.equal(scope.status, 'AUTHORIZED');
    assert.equal(scope.approvedQuotationVersionId, f.version.id);
    assert.equal(scope.quotationDecisionId, decision.id);
    assert.equal(decision.executionScope?.id, scope.id);
  });

  it('2: current ISSUED exact version can REJECT', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const decision = await decideHandymanQuotation(
      f.version.id,
      { decision: 'REJECT', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    assert.equal(decision.decision, 'REJECT');
    const versionRow = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(versionRow.rows[0].status, 'REJECTED');
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE metadata->>'quotationVersionId' = $1
          AND event_type = 'HANDYMAN_QUOTATION_REJECTED'`,
      [f.version.id],
    );
    assert.equal(events.rows.length, 1);
  });

  it('3: DRAFT/SUPERSEDED/EXPIRED cannot be decided', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const v2 = await createHandymanQuotationRevision(
      f.bundle.quotation.id, adminUserId,
    );
    for (const status of ['DRAFT', 'SUPERSEDED', 'EXPIRED'] as const) {
      await q(`UPDATE handyman_quotation_versions SET status = $2
                WHERE id = $1`, [v2.id, status]);
      await assert.rejects(
        decideHandymanQuotation(
          v2.id,
          { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
          adminUserId,
        ),
        (e: unknown) =>
          errorCode(e) === 'HANDYMAN_QUOTATION_INVALID_TRANSITION',
        `decide ${status}`,
      );
    }
    assert.equal(await decisionCount(f.bundle.quotation.id), 0);
  });

  it('4: expired-by-server-time ISSUED cannot be approved/rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    await q(`UPDATE handyman_quotation_versions
                SET valid_until = NOW() - INTERVAL '1 hour'
              WHERE id = $1`, [f.version.id]);
    for (const decision of ['APPROVE', 'REJECT'] as const) {
      await assert.rejects(
        decideHandymanQuotation(
          f.version.id,
          { decision, idempotencyKey: `k-${randomUUID()}` },
          adminUserId,
        ),
        (e: unknown) =>
          errorCode(e) === 'HANDYMAN_QUOTATION_INVALID_TRANSITION',
      );
    }
    assert.equal(await decisionCount(f.bundle.quotation.id), 0);
    const row = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(row.rows[0].status, 'ISSUED');
  });

  it('5: customer context derived server-side; smuggling cannot override', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const otherCompany = await tenantCompanyService.createTenantCompany(
      { clientId: f.client.id, tenantCode: `T_${suffix()}`,
        tenantName: 'Other' },
      adminUserId,
    );
    const smuggled = {
      decision: 'APPROVE',
      idempotencyKey: `k-${randomUUID()}`,
      clientId: randomUUID(),
      tenantCompanyId: otherCompany.id,
      tenantPicId: null,
      buildingId: randomUUID(),
      status: 'APPROVED',
    } as unknown as Parameters<typeof decideHandymanQuotation>[1];
    const decision = await decideHandymanQuotation(
      f.version.id, smuggled, adminUserId,
    );
    assert.equal(decision.tenantCompanyId, f.company.id);
    assert.equal(decision.tenantPicId, f.pic.id);
    assert.equal(decision.clientId, f.client.id);
  });

  it('6: actor derived from authenticated local user; NULL PIC never fabricated', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const smuggled = {
      decision: 'APPROVE',
      idempotencyKey: `k-${randomUUID()}`,
      decidedByUserId: randomUUID(),
    } as unknown as Parameters<typeof decideHandymanQuotation>[1];
    const decision = await decideHandymanQuotation(
      f.version.id, smuggled, adminUserId,
    );
    assert.equal(decision.decidedByUserId, adminUserId);
    // A request chain without a PIC keeps tenantPicId NULL (lineage
    // NULL is never fabricated into an identity).
    const g = await attributedFixture();
    const attributionNoPic = await createChannelAttribution({
      tenantCompanyId: g.company.id,
      buildingId: g.building.id,
      spaceId: g.space.id,
      originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
      createdByUserId: g.linkedUser.id,
    });
    const service2 = await serviceEntry(g.client.id);
    const request2 = await handymanServiceRequestService
      .createHandymanServiceRequest(
        {
          channelAttributionId: attributionNoPic.id,
          serviceCatalogId: service2.id,
        },
        adminUserId,
      );
    assert.equal(request2.tenantPicId, null);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: request2.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Direct to diagnosis.',
      },
      adminUserId,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: request2.id,
        disciplineId: disciplineIds.GENERAL_HANDYMAN,
        diagnosis: 'No-PIC fixture diagnosis.',
      },
      adminUserId,
    );
    const bundle2 = await createHandymanQuotation(
      { handymanRequestId: request2.id }, adminUserId,
    );
    const v = bundle2.versions[0];
    const uomId2 = await insertUom(g.client.id);
    await addHandymanQuotationLine(v.id, {
      lineType: 'LABOR', description: 'L1', quantity: 1, uomId: uomId2,
      currency: 'IDR', finalQuotedUnitAmount: 100,
    }, adminUserId);
    await issueHandymanQuotationVersion(
      v.id, { validUntil: FUTURE() }, adminUserId,
    );
    const decision2 = await decideHandymanQuotation(
      v.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    assert.equal(decision2.tenantPicId, null);
    assert.equal(decision2.tenantCompanyId, g.company.id);
  });

  it('7: same idempotency key + same fingerprint replays same decision', async (t) => {
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
    assert.equal(replay.decision, 'APPROVE');
    assert.equal(await decisionCount(f.bundle.quotation.id), 1);
    const eventCount = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE metadata->>'quotationVersionId' = $1
          AND event_type = 'HANDYMAN_QUOTATION_APPROVED'`,
      [f.version.id],
    );
    assert.equal(eventCount.rows[0].n, 1);
  });

  it('8: conflicting replay / second different decision rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const key = `k-${randomUUID()}`;
    await decideHandymanQuotation(
      f.version.id, { decision: 'APPROVE', idempotencyKey: key },
      adminUserId,
    );
    // Same key + conflicting decision.
    await assert.rejects(
      decideHandymanQuotation(
        f.version.id, { decision: 'REJECT', idempotencyKey: key },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_DECISION_CONFLICT',
    );
    // Different key + decided version.
    await assert.rejects(
      decideHandymanQuotation(
        f.version.id,
        { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_DECISION_CONFLICT',
    );
    assert.equal(await decisionCount(f.bundle.quotation.id), 1);
    const row = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(row.rows[0].status, 'APPROVED');
  });

  it('9: APPROVE/REJECT transition + immutable decision are atomic', async (t) => {
    if (!requireDatabase(t)) return;
    // Failure path atomicity: conflicting decision writes NOTHING.
    const f = await issuedFixture();
    await q(`UPDATE handyman_quotation_versions SET status = 'SUPERSEDED'
              WHERE id = $1`, [f.version.id]);
    const before = {
      decisions: await tableCount('handyman_quotation_decisions'),
      events: await tableCount('operational_events'),
    };
    await assert.rejects(
      decideHandymanQuotation(
        f.version.id,
        { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
        adminUserId,
      ),
    );
    assert.equal(
      await tableCount('handyman_quotation_decisions'), before.decisions);
    assert.equal(await tableCount('operational_events'), before.events);
    // Success path: decision + projection appear together.
    const ok = await decideHandymanQuotation(
      (await issuedFixture()).version.id,
      { decision: 'REJECT', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    const joined = await q(
      `SELECT d.decision, v.status
         FROM handyman_quotation_decisions d
         JOIN handyman_quotation_versions v
           ON v.id = d.quotation_version_id
        WHERE d.id = $1`,
      [ok.id],
    );
    assert.deepEqual(
      [joined.rows[0].decision, joined.rows[0].status],
      ['REJECT', 'REJECTED'],
    );
    // Decision is immutable (DB backstop).
    await assert.rejects(
      q(`UPDATE handyman_quotation_decisions SET decision = 'APPROVE'
          WHERE id = $1`, [ok.id]),
    );
    await assert.rejects(
      q('DELETE FROM handyman_quotation_decisions WHERE id = $1', [ok.id]),
    );
    const read = await getHandymanQuotationDecision(
      ok.quotationVersionId, adminUserId,
    );
    assert.equal(read.decision, 'REJECT');
  });

  it('10: zero execution-scope/payment/BAST/FM/crew/scheduling side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const before = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      crews: await tableCount('handyman_work_crews'),
      moves: await tableCount('inventory_stock_movements'),
    };
    await decideHandymanQuotation(
      f.version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      adminUserId,
    );
    const after = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      crews: await tableCount('handyman_work_crews'),
      moves: await tableCount('inventory_stock_movements'),
    };
    assert.deepEqual(after, before);
    const scopeCount = await q(
      `SELECT count(*)::int AS n FROM handyman_execution_scopes
        WHERE approved_quotation_version_id = $1`,
      [f.version.id],
    );
    assert.equal(scopeCount.rows[0].n, 1);
    const events = await q(
      `SELECT event_type, metadata FROM operational_events
        WHERE metadata->>'quotationVersionId' = $1
          AND event_type IN ('HANDYMAN_QUOTATION_APPROVED',
                             'HANDYMAN_QUOTATION_REJECTED')`,
      [f.version.id],
    );
    assert.equal(events.rows.length, 1);
    for (const k of Object.keys(events.rows[0].metadata as object)) {
      assert.ok(
        !/executionscope|payment|bast|workorder|crew|schedul/i.test(k),
        `forbidden journal key ${k}`,
      );
    }
  });
});
