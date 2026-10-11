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

/**
 * RETARGETED BY W03 PART 03E (CR-HM-06/A01 v1.1 §10.4 **S1**, owner-ratified
 * 2026-10-11) — the CR-HM-06 PART 06 decision suite now asserts the S1 contract
 * instead of the pre-amendment staff authority.
 *
 * What changed and why it is not a softening:
 *
 *   - Every test here used to drive the decision engine through a staff
 *     principal, because before A01 that was the only principal with approval
 *     authority. A01 moved that authority to the attested Tenant PIC; §10.4 S1
 *     (ratified) keeps the staff route mounted and refuses a staff decision as a
 *     policy answer. Since `0442` the *database* also refused a `USER` row, so
 *     these tests had been failing on a raw CHECK violation surfacing as
 *     `INTERNAL_SERVER_ERROR`. Asserting that shape any longer would freeze a
 *     500-era behavior into the regression suite, which is why the owner directed
 *     a retarget rather than a leave-red.
 *   - The engine's invariants are NOT dropped. Replay identity, one decision per
 *     version, replay-vs-conflict, atomicity of decision + projection + scope +
 *     journal, REJECT-creates-nothing, and the side-effect census are all
 *     exercised against a live database in
 *     `tests/handyman-pic-portal-decide.test.ts`, i.e. through the only write path
 *     that still exists. What this file keeps is the staff surface's own contract,
 *     which is now: controlled refusal, no state change, no row, no event.
 *   - The fixture work each test does (issue a version, supersede it, expire it,
 *     smuggle a body) is preserved verbatim, because those states still have to be
 *     reachable — the refusal must not depend on the version being decidable.
 */

/** The S1 refusal, asserted as a refusal and as an absence. */
async function assertStaffDecisionRefused(
  run: () => Promise<unknown>,
  versionId: string,
  quotationId: string,
  label: string,
  expectedVersionStatus = 'ISSUED',
): Promise<void> {
  await assert.rejects(
    run(),
    (error: unknown) => {
      const e = error as { statusCode?: number; code?: string; message?: string };
      assert.equal(e.code, 'PERMISSION_DENIED', `${label}: code`);
      assert.equal(e.statusCode, 403, `${label}: status`);
      // The refusal is raised BEFORE the version is read, so no state can be
      // probed through it — which is what makes the same answer correct for a
      // DRAFT, an expired, and a nonexistent version alike.
      assert.match(e.message ?? '', /Tenant PIC authority/, `${label}: message`);
      return true;
    },
    `${label}: a staff principal must be refused inside the error contract`,
  );
  assert.equal(await decisionCount(quotationId), 0, `${label}: no decision row`);
  const journal = await q(
    `SELECT count(*)::int AS n FROM operational_events
      WHERE metadata->>'quotationVersionId' = $1
        AND event_type IN ('HANDYMAN_QUOTATION_APPROVED',
                           'HANDYMAN_QUOTATION_REJECTED')`,
    [versionId],
  );
  assert.equal(journal.rows[0].n, 0, `${label}: nothing journalled`);
  const scopes = await q(
    `SELECT count(*)::int AS n FROM handyman_execution_scopes
      WHERE approved_quotation_version_id = $1`,
    [versionId],
  );
  assert.equal(scopes.rows[0].n, 0, `${label}: no Execution Scope`);
  const versionRow = await q(
    'SELECT status FROM handyman_quotation_versions WHERE id = $1',
    [versionId],
  );
  assert.equal(
    versionRow.rows[0]?.status,
    expectedVersionStatus,
    `${label}: a refusal is not a state change`,
  );
}

describe('CR-HM-06 PART 04 / W03 PART 03E — the staff decision arm is closed, not widened', () => {
  it('1: APPROVE is no longer a staff authority; the version stays presented', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    await assertStaffDecisionRefused(
      () => decideHandymanQuotation(
        f.version.id,
        { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
        adminUserId,
      ),
      f.version.id,
      f.bundle.quotation.id,
      'staff APPROVE',
    );
    // The staff READ seam is untouched (C8): history stays readable, which is how
    // an auditor reconciles a pre-amendment decision after the write door closes.
    await assert.rejects(
      getHandymanQuotationDecision(f.version.id, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_QUOTATION_DECISION_NOT_FOUND',
      'no decision exists — and the read says so, without exposing anything else',
    );
  });

  it('2: REJECT is refused the same way, and cannot leave a REJECTED projection', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    await assertStaffDecisionRefused(
      () => decideHandymanQuotation(
        f.version.id,
        { decision: 'REJECT', idempotencyKey: `k-${randomUUID()}` },
        adminUserId,
      ),
      f.version.id,
      f.bundle.quotation.id,
      'staff REJECT',
    );
  });

  it('3: DRAFT/SUPERSEDED/EXPIRED are refused for the same reason as an ISSUED version', async (t) => {
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
        (e: unknown) => errorCode(e) === 'PERMISSION_DENIED',
        `decide ${status}: policy first, state never`,
      );
      // The state assertions this test used to make are still made — by the
      // lifecycle suite (`handyman-quotation-lifecycle`), which owns presentation
      // state; here they would only re-assert that a refusal wrote nothing.
      assert.equal(await decisionCount(f.bundle.quotation.id), 0);
    }
  });

  it('4: an expired-by-server-time ISSUED version is refused without being read', async (t) => {
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
        (e: unknown) => errorCode(e) === 'PERMISSION_DENIED',
      );
    }
    assert.equal(await decisionCount(f.bundle.quotation.id), 0);
    const row = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(row.rows[0].status, 'ISSUED', 'expiry is projected by its own path, not by a refusal');
  });

  it('5: a smuggled customer context is never read, because nothing is read', async (t) => {
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
    // The whitelist that made smuggling inert (`DecideHandymanQuotationInput`
    // carries only `decision` + `idempotencyKey`) is still the reason a body can
    // never name a tenant — and 03E adds the stronger fact that this arm writes
    // nothing at all, so no context is derived from anything.
    await assertStaffDecisionRefused(
      () => decideHandymanQuotation(f.version.id, smuggled, adminUserId),
      f.version.id,
      f.bundle.quotation.id,
      'smuggled staff APPROVE',
    );
    const lineage = await q(
      `SELECT r.tenant_company_id, r.tenant_pic_id
         FROM handyman_quotations qq
         JOIN handyman_service_requests r ON r.id = qq.handyman_request_id
        WHERE qq.id = $1`,
      [f.bundle.quotation.id],
    );
    assert.equal(
      lineage.rows[0].tenant_company_id,
      f.company.id,
      'the thread keeps the tenant its own lineage gave it',
    );
    assert.equal(lineage.rows[0].tenant_pic_id, f.pic.id);
  });

  it('6: no staff actor is written to the ledger at all, and a NULL PIC stays NULL', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const smuggled = {
      decision: 'APPROVE',
      idempotencyKey: `k-${randomUUID()}`,
      decidedByUserId: randomUUID(),
    } as unknown as Parameters<typeof decideHandymanQuotation>[1];
    await assertStaffDecisionRefused(
      () => decideHandymanQuotation(f.version.id, smuggled, adminUserId),
      f.version.id,
      f.bundle.quotation.id,
      'staff APPROVE with a caller-supplied actor',
    );
    // A request chain without a PIC keeps tenantPicId NULL: the lineage rule this
    // test existed for, asserted where it is actually decided — at intake, not at
    // the ledger. 03E's PIC suite proves the same for a recorded decision, whose
    // `tenant_pic_id` comes from the request row and is never invented.
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
    // A thread with no PIC and no binding has NO approver at all after S1: staff is
    // 403 and no PIC credential exists to decide. That is the ratified controlled
    // standstill (ADD-A BLK-GAP-1), not a hole to code around.
    await assertStaffDecisionRefused(
      () => decideHandymanQuotation(
        v.id, { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
        adminUserId,
      ),
      v.id,
      bundle2.quotation.id,
      'staff APPROVE on a PIC-less thread',
    );
  });

  it('7: replay is decided by the ledger, so a staff replay attempt is simply refused', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const key = `k-${randomUUID()}`;
    for (const attempt of ['first', 'replay']) {
      await assertStaffDecisionRefused(
        () => decideHandymanQuotation(
          f.version.id, { decision: 'APPROVE', idempotencyKey: key },
          adminUserId,
        ),
        f.version.id,
        f.bundle.quotation.id,
        `staff APPROVE ${attempt}`,
      );
    }
    assert.equal(await decisionCount(f.bundle.quotation.id), 0, 'no row, so no replay');
  });

  it('8: the conflict rules survive the close and now live on the PIC arm', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const key = `k-${randomUUID()}`;
    await assertStaffDecisionRefused(
      () => decideHandymanQuotation(
        f.version.id, { decision: 'APPROVE', idempotencyKey: key },
        adminUserId,
      ),
      f.version.id,
      f.bundle.quotation.id,
      'staff APPROVE',
    );
    for (const [decision, label] of [
      ['REJECT', 'same key, conflicting decision'],
      ['APPROVE', 'different key, already-decided version'],
    ] as const) {
      await assert.rejects(
        decideHandymanQuotation(
          f.version.id, { decision, idempotencyKey: `k-${randomUUID()}` },
          adminUserId,
        ),
        (e: unknown) => errorCode(e) === 'PERMISSION_DENIED',
        label,
      );
    }
    assert.equal(await decisionCount(f.bundle.quotation.id), 0);
    const row = await q(
      'SELECT status FROM handyman_quotation_versions WHERE id = $1',
      [f.version.id],
    );
    assert.equal(row.rows[0].status, 'ISSUED');
    // One-decision-per-version, and conflict-vs-replay as a ledger question, are
    // asserted on the arm that can still write:
    // `tests/handyman-pic-portal-decide.test.ts`.
  });

  it('9: a refusal writes nothing, and the ledger still refuses a forged USER row', async (t) => {
    if (!requireDatabase(t)) return;
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
      await tableCount('handyman_quotation_decisions'), before.decisions,
    );
    assert.equal(await tableCount('operational_events'), before.events);
    // The floor under the soft-close, asserted directly: even a caller that skipped
    // the service cannot put a staff actor into the ledger. This is why closing the
    // route (rather than deleting it) is not a hole (§10.4).
    await assert.rejects(
      q(
        `INSERT INTO handyman_quotation_decisions
           (id, client_id, quotation_id, quotation_version_id, decision,
            tenant_company_id, tenant_pic_id, decided_by_user_id,
            decision_actor_type, idempotency_key, request_fingerprint)
         VALUES ($1,$2,$3,$4,'APPROVE',$5,$6,$7,'USER',$8,$9)`,
        [
          randomUUID(), f.client.id, f.bundle.quotation.id, f.version.id,
          f.company.id, f.pic.id, adminUserId, `forged-${randomUUID()}`,
          '0'.repeat(64),
        ],
      ),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          '23514',
          'the ledger guard, not a convention, is what forbids a USER decision',
        );
        return true;
      },
    );
    // And immutability of recorded history is still enforced by the same DB, which
    // is the property PART 04 asserted and 03E must not weaken: a refusal may not
    // become a repair path.
    assert.equal(await decisionCount(f.bundle.quotation.id), 0);
  });

  it('10: the closed arm has zero downstream side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await issuedFixture();
    const before = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      crews: await tableCount('handyman_work_crews'),
      moves: await tableCount('inventory_stock_movements'),
    };
    await assertStaffDecisionRefused(
      () => decideHandymanQuotation(
        f.version.id,
        { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
        adminUserId,
      ),
      f.version.id,
      f.bundle.quotation.id,
      'staff APPROVE',
    );
    const after = {
      vendorQuotations: await tableCount('vendor_quotations'),
      workOrders: await tableCount('work_orders'),
      bast: await tableCount('bast_documents'),
      crews: await tableCount('handyman_work_crews'),
      moves: await tableCount('inventory_stock_movements'),
    };
    assert.deepEqual(after, before);
    const events = await q(
      `SELECT event_type, metadata FROM operational_events
        WHERE metadata->>'quotationVersionId' = $1
          AND event_type IN ('HANDYMAN_QUOTATION_APPROVED',
                             'HANDYMAN_QUOTATION_REJECTED')`,
      [f.version.id],
    );
    assert.equal(events.rows.length, 0);
  });
});
