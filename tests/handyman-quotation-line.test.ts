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
 * CR-HM-06 PART 02 — focused tests for quotation commercial snapshot
 * lines (FROZEN Decision Freeze F4/F5).
 *
 * Ten cases prove: LABOR and MATERIAL lines add to DRAFT versions;
 * lineTotal is server-calculated; subtotals/total derive from
 * immutable lines; one currency per version is enforced; invalid
 * quantity/amounts are rejected; MATERIAL reference prices snapshot
 * at creation and never change with the source; lines cannot be
 * updated or deleted; caller lineage/lineTotal smuggling is ignored;
 * and there are zero inventory/FM/payment/approval/execution-scope
 * side effects.
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
async function lineFixture() {
  const f = await diagnosedFixture();
  const bundle = await createHandymanQuotation(
    { handymanRequestId: f.request.id },
    adminUserId,
  );
  return { ...f, bundle, version: bundle.versions[0] };
}

describe('CR-HM-06 PART 02 — quotation commercial snapshot lines', () => {
  it('1: add LABOR line to DRAFT version', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const line = await addHandymanQuotationLine(
      f.version.id,
      {
        lineType: 'LABOR',
        description: 'Plumber labor',
        quantity: 2,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 150_000,
      },
      adminUserId,
    );
    assert.equal(line.lineType, 'LABOR');
    assert.equal(line.description, 'Plumber labor');
    assert.equal(line.quantity, 2);
    assert.equal(line.finalQuotedUnitAmount, 150_000);
    assert.equal(line.currency, 'IDR');
    assert.equal(line.sourceItemId, null);
    assert.equal(line.referenceUnitAmount, null);
    assert.equal(line.quotationVersionId, f.version.id);
    assert.equal(line.createdByUserId, adminUserId);
  });

  it('2: add MATERIAL line to DRAFT version (no price authority → null reference)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const item = await insertMaterialItem(f.client.id, uomId);
    const line = await addHandymanQuotationLine(
      f.version.id,
      {
        lineType: 'MATERIAL',
        description: 'Copper pipe per meter',
        quantity: 3,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 80_000,
        sourceItemId: item.id,
      },
      adminUserId,
    );
    assert.equal(line.lineType, 'MATERIAL');
    assert.equal(line.sourceItemId, item.id);
    assert.equal(line.referenceUnitAmount, null);
  });

  it('3: lineTotal calculated server-side', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const line = await addHandymanQuotationLine(
      f.version.id,
      {
        lineType: 'LABOR',
        description: 'Fractional hours',
        quantity: 2.5,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100.5,
      },
      adminUserId,
    );
    assert.equal(line.lineTotal, 251.25); // 2.5 × 100.50
    const row = await q(
      'SELECT line_total::float AS t FROM handyman_quotation_lines WHERE id = $1',
      [line.id],
    );
    assert.equal(row.rows[0].t, 251.25);
  });

  it('4: labor/material subtotals + total correct', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const item = await insertMaterialItem(f.client.id, uomId);
    await addHandymanQuotationLine(f.version.id, {
      lineType: 'LABOR', description: 'L1', quantity: 2, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 100,
    }, adminUserId);
    await addHandymanQuotationLine(f.version.id, {
      lineType: 'LABOR', description: 'L2', quantity: 1, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 50,
    }, adminUserId);
    await addHandymanQuotationLine(f.version.id, {
      lineType: 'MATERIAL', description: 'M1', quantity: 4, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 25, sourceItemId: item.id,
    }, adminUserId);
    const totals = await getHandymanQuotationVersionTotals(
      f.version.id, adminUserId,
    );
    assert.equal(totals.laborSubtotal, 250);
    assert.equal(totals.materialSubtotal, 100);
    assert.equal(totals.total, 350);
    assert.equal(totals.currency, 'IDR');
    assert.equal(totals.lineCount, 3);
    const lines = await listHandymanQuotationVersionLines(
      f.version.id, adminUserId,
    );
    assert.equal(lines.length, 3);
  });

  it('5: single-currency rule enforced', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    await addHandymanQuotationLine(f.version.id, {
      lineType: 'LABOR', description: 'L1', quantity: 1, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 100,
    }, adminUserId);
    await assert.rejects(
      addHandymanQuotationLine(f.version.id, {
        lineType: 'LABOR', description: 'L2', quantity: 1, uomId,
        currency: 'USD', finalQuotedUnitAmount: 100,
      }, adminUserId),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_CURRENCY_MISMATCH',
    );
    // Earlier version threads are independent: a fresh revision is free
    // of lines and starts its own currency decision.
    const v2 = await createHandymanQuotationRevision(
      f.bundle.quotation.id, adminUserId,
    );
    const linesV2 = await listHandymanQuotationVersionLines(
      v2.id, adminUserId,
    );
    assert.equal(linesV2.length, 0); // PART 02: no revision copy invented
  });

  it('6: invalid quantity/negative amounts rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const base = {
      lineType: 'LABOR' as const, description: 'X', quantity: 1,
      uomId, currency: 'IDR' as const, finalQuotedUnitAmount: 1,
    };
    for (const bad of [
      { ...base, quantity: 0 },
      { ...base, quantity: -2 },
      { ...base, finalQuotedUnitAmount: -1 },
      { ...base, lineType: 'SERVICE' as never },
      { ...base, currency: 'XXX' as never },
      { ...base, description: '' },
      { ...base, sourceItemId: randomUUID() },
    ]) {
      await assert.rejects(
        addHandymanQuotationLine(f.version.id, bad, adminUserId),
        (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_LINE_INVALID',
        JSON.stringify(bad),
      );
    }
  });

  it('7: material reference amount snapshotted; unchanged after source change', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const item = await insertMaterialItem(f.client.id, uomId);
    await clientMonetaryContextService.setClientMonetaryContext(
      {
        clientId: f.client.id,
        baseCurrencyCode: 'IDR',
        defaultTransactionCurrencyCode: 'IDR',
        allowedCurrencyCodes: ['IDR'],
      },
      adminUserId,
    );
    const entry = await insertActivePriceEntry(
      f.client.id, item.id, uomId, 25_000,
    );
    const line = await addHandymanQuotationLine(f.version.id, {
      lineType: 'MATERIAL', description: 'Copper pipe', quantity: 2,
      uomId, currency: 'IDR', finalQuotedUnitAmount: 30_000,
      sourceItemId: item.id,
    }, adminUserId);
    assert.equal(line.referenceUnitAmount, 25_000);
    // Change the governed source price → immutable line never moves.
    await priceCatalogEntryService.deactivatePriceCatalogEntry(
      entry.id, adminUserId,
    );
    await insertActivePriceEntry(f.client.id, item.id, uomId, 99_000);
    const after = await listHandymanQuotationVersionLines(
      f.version.id, adminUserId,
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].referenceUnitAmount, 25_000);
    assert.equal(after[0].finalQuotedUnitAmount, 30_000);
  });

  it('8: line UPDATE/DELETE rejected (DB backstop)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const line = await addHandymanQuotationLine(f.version.id, {
      lineType: 'LABOR', description: 'L1', quantity: 1, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 1,
    }, adminUserId);
    await assert.rejects(
      q('UPDATE handyman_quotation_lines SET line_total = 0 WHERE id = $1',
        [line.id]),
    );
    await assert.rejects(
      q('DELETE FROM handyman_quotation_lines WHERE id = $1', [line.id]),
    );
    const intact = await q(
      'SELECT line_total FROM handyman_quotation_lines WHERE id = $1',
      [line.id],
    );
    assert.equal(Number(intact.rows[0].line_total), 1);
  });

  it('9: caller lineage/lineTotal smuggling cannot override authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const otherClient = await clientService.createClient({
      code: `X_${suffix()}`, name: 'Foreign',
    });
    const smuggled = {
      lineType: 'LABOR',
      description: 'L1',
      quantity: 2,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
      quotationId: randomUUID(),
      quotationVersionId: randomUUID(),
      clientId: otherClient.id,
      lineTotal: 999_999,
      referenceUnitAmount: 1,
      buildingId: randomUUID(),
      tenantCompanyId: randomUUID(),
    } as unknown as Parameters<typeof addHandymanQuotationLine>[1];
    const line = await addHandymanQuotationLine(
      f.version.id, smuggled, adminUserId,
    );
    assert.equal(line.quotationVersionId, f.version.id);
    assert.equal(line.lineTotal, 200);
    assert.equal(line.referenceUnitAmount, null);
    assert.equal('clientId' in line, false);
  });

  it('10: zero inventory/FM/payment/approval/execution-scope side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const uomId = await insertUom(f.client.id);
    const item = await insertMaterialItem(f.client.id, uomId);
    const before = {
      inventoryItems: await tableCount('inventory_items'),
      movements: await tableCount('inventory_stock_movements'),
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
    };
    await addHandymanQuotationLine(f.version.id, {
      lineType: 'MATERIAL', description: 'Pipe', quantity: 1, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 10, sourceItemId: item.id,
    }, adminUserId);
    const after = {
      inventoryItems: await tableCount('inventory_items'),
      movements: await tableCount('inventory_stock_movements'),
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
    };
    assert.deepEqual(after, before);
    // No approval/execution-scope tables exist or were created either.
    const tables = await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND (table_name LIKE '%execution_scope%'
            OR table_name LIKE '%quotation_approval%')`,
    );
    assert.equal(tables.rows.length, 0);
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_QUOTATION_VERSION'
          AND metadata->>'quotationVersionId' = $1`,
      [f.version.id],
    );
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].event_type, 'HANDYMAN_QUOTATION_LINE_ADDED');
  });
});
