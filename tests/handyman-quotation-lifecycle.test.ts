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
 * CR-HM-06 PART 03 — focused tests for quotation version lifecycle
 * (FROZEN Decision Freeze F2/F3/F4): DRAFT->ISSUED gates, expiry,
 * atomic replacement supersession, current-presented read, and zero
 * approval/execution-scope/payment/BAST/FM side effects.
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
async function lineFixture(withLine = true) {
  const f = await diagnosedFixture();
  const bundle = await createHandymanQuotation(
    { handymanRequestId: f.request.id },
    adminUserId,
  );
  const version = bundle.versions[0];
  let uomId = '';
  if (withLine) {
    uomId = await insertUom(f.client.id);
    await addHandymanQuotationLine(version.id, {
      lineType: 'LABOR', description: 'L1', quantity: 2, uomId,
      currency: 'IDR', finalQuotedUnitAmount: 100,
    }, adminUserId);
  }
  return { ...f, bundle, version, uomId };
}

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

describe('CR-HM-06 PART 03 — quotation lifecycle', () => {
  it('1: DRAFT with lines + future validUntil → ISSUED', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const issued = await issueHandymanQuotationVersion(
      f.version.id, { validUntil: FUTURE() }, adminUserId,
    );
    assert.equal(issued.status, 'ISSUED');
    assert.ok(issued.validUntil);
    assert.notEqual(issued.createdAt, issued.updatedAt) // updated_at moved
      || assert.ok(true);
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE metadata->>'quotationVersionId' = $1
          AND event_type = 'HANDYMAN_QUOTATION_ISSUED'`,
      [f.version.id],
    );
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0] === undefined, false);
  });

  it('2: DRAFT without lines cannot issue', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture(false);
    await assert.rejects(
      issueHandymanQuotationVersion(
        f.version.id, { validUntil: FUTURE() }, adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_NO_LINES',
    );
  });

  it('3: invalid/past validUntil cannot issue', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    await assert.rejects(
      issueHandymanQuotationVersion(
        f.version.id, { validUntil: 'not-a-date' }, adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_VALIDITY_INVALID',
    );
    await assert.rejects(
      issueHandymanQuotationVersion(
        f.version.id,
        { validUntil: new Date(Date.now() - 1000).toISOString() },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_VALIDITY_INVALID',
    );
    const row = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(row.rows[0].status, 'DRAFT');
  });

  it('4: ISSUED cannot mutate immutable commercial/version facts', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    await issueHandymanQuotationVersion(
      f.version.id, { validUntil: FUTURE() }, adminUserId,
    );
    await assert.rejects(
      q('UPDATE handyman_quotation_versions SET version_number = 42 WHERE id = $1',
        [f.version.id]),
    );
    await assert.rejects(
      q('DELETE FROM handyman_quotation_versions WHERE id = $1',
        [f.version.id]),
    );
    await assert.rejects(
      q(`UPDATE handyman_quotation_lines SET final_quoted_unit_amount = 1
          WHERE quotation_version_id = $1`, [f.version.id]),
    );
    await assert.rejects(
      addHandymanQuotationLine(f.version.id, {
        lineType: 'LABOR', description: 'Nope', quantity: 1,
        uomId: f.uomId, currency: 'IDR', finalQuotedUnitAmount: 1,
      }, adminUserId),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_VERSION_NOT_DRAFT',
    );
  });

  it('5: ISSUED expires only at/after server-authoritative validUntil', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    await issueHandymanQuotationVersion(
      f.version.id, { validUntil: FUTURE() }, adminUserId,
    );
    await assert.rejects(
      expireHandymanQuotationVersion(f.version.id, adminUserId),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_NOT_EXPIRABLE',
    );
    // Caller timestamp is never authority: move only the server-side row.
    await q(
      `UPDATE handyman_quotation_versions
          SET valid_until = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [f.version.id],
    );
    const before = await tableCount('handyman_quotation_versions');
    const expired = await expireHandymanQuotationVersion(
      f.version.id, adminUserId,
    );
    assert.equal(expired.status, 'EXPIRED');
    assert.equal(await tableCount('handyman_quotation_versions'), before);
    // Expiry is terminal for PART 03: cannot re-issue.
    await assert.rejects(
      issueHandymanQuotationVersion(
        f.version.id, { validUntil: FUTURE() }, adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_QUOTATION_INVALID_TRANSITION',
    );
  });

  it('6: new DRAFT revision does not alter previous ISSUED version', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    const validUntil = FUTURE();
    await issueHandymanQuotationVersion(
      f.version.id, { validUntil }, adminUserId,
    );
    const before = await q(
      `SELECT id, version_number, status, valid_until, created_by_user_id
         FROM handyman_quotation_versions WHERE id = $1`,
      [f.version.id],
    );
    const v2 = await createHandymanQuotationRevision(
      f.bundle.quotation.id, adminUserId,
    );
    assert.equal(v2.status, 'DRAFT');
    const linesV1 = await listHandymanQuotationVersionLines(
      f.version.id, adminUserId,
    );
    assert.equal(linesV1.length, 1);
    const v1After = await q(
      `SELECT id, version_number, status, valid_until, created_by_user_id
         FROM handyman_quotation_versions WHERE id = $1`,
      [f.version.id],
    );
    assert.deepEqual(v1After.rows, before.rows);
    const current = await getCurrentHandymanIssuedQuotationVersion(
      f.request.id, adminUserId,
    );
    assert.equal(current?.id, f.version.id);
  });

  it('7: issuing replacement atomically SUPERSEDES previous ISSUED', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    await issueHandymanQuotationVersion(
      f.version.id, { validUntil: FUTURE() }, adminUserId,
    );
    const v2 = await createHandymanQuotationRevision(
      f.bundle.quotation.id, adminUserId,
    );
    await addHandymanQuotationLine(v2.id, {
      lineType: 'MATERIAL', description: 'M1', quantity: 1,
      uomId: f.uomId, currency: 'IDR', finalQuotedUnitAmount: 50,
    }, adminUserId);
    const issued2 = await issueHandymanQuotationVersion(
      v2.id, { validUntil: FUTURE() }, adminUserId,
    );
    assert.equal(issued2.status, 'ISSUED');
    const states = await q(
      `SELECT id, status FROM handyman_quotation_versions
        WHERE quotation_id = $1 ORDER BY version_number`,
      [f.bundle.quotation.id],
    );
    assert.deepEqual(
      states.rows.map((r) => [r.id, r.status]),
      [[f.version.id, 'SUPERSEDED'], [v2.id, 'ISSUED']],
    );
    // Immutable v1 facts (incl. lines) byte-semantically intact.
    const v1lines = await q(
      `SELECT line_type, quantity, final_quoted_unit_amount, line_total
         FROM handyman_quotation_lines WHERE quotation_version_id = $1`,
      [f.version.id],
    );
    assert.equal(v1lines.rows.length, 1);
    assert.equal(Number(v1lines.rows[0].line_total), 200);
    const eventTypes = await q(
      `SELECT event_type FROM operational_events
        WHERE metadata->>'quotationId' = $1
          AND event_type IN ('HANDYMAN_QUOTATION_SUPERSEDED',
                             'HANDYMAN_QUOTATION_ISSUED')`,
      [f.bundle.quotation.id],
    );
    const byCount = eventTypes.rows.reduce(
      (acc, r) => ({ ...acc, [r.event_type]: (acc[r.event_type] ?? 0) + 1 }),
      {} as Record<string, number>,
    );
    assert.equal(byCount['HANDYMAN_QUOTATION_ISSUED'], 2);
    assert.equal(byCount['HANDYMAN_QUOTATION_SUPERSEDED'], 1);
  });

  it('8: APPROVED/REJECTED/EXPIRED cannot be superseded by PART 03', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    await issueHandymanQuotationVersion(
      f.version.id, { validUntil: FUTURE() }, adminUserId,
    );
    // Seed the vocabulary-only states directly (projection columns).
    for (const seed of ['APPROVED', 'EXPIRED', 'REJECTED'] as const) {
      await q(`UPDATE handyman_quotation_versions SET status = $2
                WHERE id = $1`, [f.version.id, seed]);
      await assert.rejects(
        supersedeHandymanQuotationVersion(f.version.id, adminUserId),
        (e: unknown) =>
          errorCode(e) === 'HANDYMAN_QUOTATION_INVALID_TRANSITION',
        `supersede ${seed}`,
      );
      await assert.rejects(
        expireHandymanQuotationVersion(f.version.id, adminUserId),
        (e: unknown) =>
          errorCode(e) === 'HANDYMAN_QUOTATION_INVALID_TRANSITION',
        `expire ${seed}`,
      );
    }
    // Issuing a replacement never rewrites an APPROVED row.
    await q(`UPDATE handyman_quotation_versions SET status = 'APPROVED'
              WHERE id = $1`, [f.version.id]);
    const v2 = await createHandymanQuotationRevision(
      f.bundle.quotation.id, adminUserId,
    );
    await addHandymanQuotationLine(v2.id, {
      lineType: 'LABOR', description: 'L2', quantity: 1,
      uomId: f.uomId, currency: 'IDR', finalQuotedUnitAmount: 5,
    }, adminUserId);
    await issueHandymanQuotationVersion(
      v2.id, { validUntil: FUTURE() }, adminUserId,
    );
    const v1 = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(v1.rows[0].status, 'APPROVED');
  });

  it('9: current-presented read resolves exactly current ISSUED version', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    // DRAFT is never customer-presentable.
    assert.equal(
      await getCurrentHandymanIssuedQuotationVersion(
        f.request.id, adminUserId,
      ),
      null,
    );
    await issueHandymanQuotationVersion(
      f.version.id, { validUntil: FUTURE() }, adminUserId,
    );
    let current = await getCurrentHandymanIssuedQuotationVersion(
      f.request.id, adminUserId,
    );
    assert.equal(current?.id, f.version.id);
    // Replacement → exactly the new ISSUED version (single partial index).
    const v2 = await createHandymanQuotationRevision(
      f.bundle.quotation.id, adminUserId,
    );
    await addHandymanQuotationLine(v2.id, {
      lineType: 'LABOR', description: 'L2', quantity: 1,
      uomId: f.uomId, currency: 'IDR', finalQuotedUnitAmount: 7,
    }, adminUserId);
    await issueHandymanQuotationVersion(
      v2.id, { validUntil: FUTURE() }, adminUserId,
    );
    current = await getCurrentHandymanIssuedQuotationVersion(
      f.request.id, adminUserId,
    );
    assert.equal(current?.id, v2.id);
    const issuedCount = await q(
      `SELECT count(*)::int AS n FROM handyman_quotation_versions
        WHERE quotation_id = $1 AND status = 'ISSUED'`,
      [f.bundle.quotation.id],
    );
    assert.equal(issuedCount.rows[0].n, 1);
    // Expiry of the current version → nothing customer-presentable.
    await q(
      `UPDATE handyman_quotation_versions
          SET valid_until = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [v2.id],
    );
    await expireHandymanQuotationVersion(v2.id, adminUserId);
    current = await getCurrentHandymanIssuedQuotationVersion(
      f.request.id, adminUserId,
    );
    assert.equal(current, null);
  });

  it('10: zero approval/execution-scope/payment/BAST/FM side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineFixture();
    // Approval/execution-scope rows are owned by PART 04/05 (their
    // tables legitimately exist); lifecycle operations must never
    // create or mutate them. Scoped row counts are version-bound.
    const scopedRowCount = async (table: string, column: string,
      ids: string[]) => {
      const r = await q(
        `SELECT count(*)::int AS n FROM ${table}
          WHERE ${column} = ANY($1::uuid[])`,
        [ids],
      );
      return r.rows[0].n as number;
    };
    const before = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      moves: await tableCount('inventory_stock_movements'),
      executionScopes: await scopedRowCount(
        'handyman_execution_scopes', 'approved_quotation_version_id',
        [f.version.id],
      ),
      decisions: await scopedRowCount(
        'handyman_quotation_decisions', 'quotation_version_id',
        [f.version.id],
      ),
    };
    assert.equal(before.executionScopes, 0);
    assert.equal(before.decisions, 0);
    await issueHandymanQuotationVersion(
      f.version.id, { validUntil: FUTURE() }, adminUserId,
    );
    const v2 = await createHandymanQuotationRevision(
      f.bundle.quotation.id, adminUserId,
    );
    await addHandymanQuotationLine(v2.id, {
      lineType: 'LABOR', description: 'L2', quantity: 1,
      uomId: f.uomId, currency: 'IDR', finalQuotedUnitAmount: 3,
    }, adminUserId);
    await supersedeHandymanQuotationVersion(f.version.id, adminUserId);
    const after = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      moves: await tableCount('inventory_stock_movements'),
    };
    assert.deepEqual(after, {
      vendorQuotations: before.vendorQuotations,
      workOrders: before.workOrders,
      bast: before.bast,
      moves: before.moves,
    });
    // Neither lifecycle step created approval/scope rows for any
    // version of this quotation thread (v1 + replacement v2).
    const bothVersions = [f.version.id, v2.id];
    assert.equal(await scopedRowCount(
      'handyman_execution_scopes', 'approved_quotation_version_id',
      bothVersions,
    ), 0);
    assert.equal(await scopedRowCount(
      'handyman_quotation_decisions', 'quotation_version_id',
      bothVersions,
    ), 0);
    // Journal rows carry no approval/scope/payment vocabulary.
    const events = await q(
      `SELECT event_type, entity_type, metadata
         FROM operational_events WHERE metadata->>'quotationId' = $1`,
      [f.bundle.quotation.id],
    );
    for (const row of events.rows) {
      assert.ok(String(row.event_type).startsWith('HANDYMAN_QUOTATION_'));
      for (const k of Object.keys(row.metadata as object)) {
        assert.ok(
          !/approval|executionscope|payment|bast|workorder|vendor/i.test(k),
          `forbidden journal key ${k}`,
        );
      }
    }
  });
});
