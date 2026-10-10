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
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  adjustHandymanCustomerLedger,
  listHandymanLedgerCorrections,
  refundHandymanCustomerPayment,
  reverseHandymanCustomerPayment,
  reverseHandymanPaymentAllocation,
  summarizeHandymanLedgerCorrections,
} from '../src/modules/handyman-customer-ledger-corrections';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
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
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 06F-2 (ULTRA-LIGHT) — focused tests for the
 * LEDGER CORRECTION authorization boundary: `authorityPreamble` in
 * handyman-ledger-correction.service.ts, shared by exactly SIX call
 * sites (confirmed — no other callers): the correction WRITES
 * `refundHandymanCustomerPayment`, `reverseHandymanPaymentAllocation`,
 * `reverseHandymanCustomerPayment`, `adjustHandymanCustomerLedger`,
 * and the correction list/summary READS
 * `listHandymanLedgerCorrections` /
 * `summarizeHandymanLedgerCorrections`.
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The execution scope row carries the
 * authoritative server-derived `building_id` snapshot (migration
 * 0395), and the preamble loads that scope, so the client-level
 * canAccessClient wall is replaced by the BE-02G exact-Building check
 * on `scope.buildingId`, in the wall's original position.
 *
 * Implementation note (same as PART 06E-1/06E-2/06F-1): the BE-02G
 * guard's predicate (`canAccessBuildingScopedResource`) is applied
 * directly so the module's denial vocabulary is preserved EXACTLY —
 * a denial stays 403 HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED, as
 * asserted by the existing correction suites for foreign actors.
 * Error precedence is unchanged: scope 404 precedes the access wall.
 *
 * Actor contract (verified): one uniform local-staff actor for all
 * six call sites — they share the verified preamble; no caller has a
 * different actor or authorization contract. No BM SSO / customer
 * principal reaches this module.
 *
 * Preserved: correction eligibility (sources must belong to THIS
 * ledger transaction — never leaked; reversals negate the source
 * fact's OWN amount), amount/currency invariants (canonical positive
 * decimals in the transaction's own currency; adjustments bounded by
 * the line/transaction charge), append-only ledger behavior (facts
 * are never rewritten), approval/state gates, audit, per-key
 * idempotent replay (a key is spent once, on the matching intent),
 * and transaction/locking boundaries (the transaction row lock
 * serializes every correction of one ledger). No financial
 * calculations changed; no new correction operations introduced.
 * Payments, transactions, allocations, ledger reads, warranty,
 * arrival, and unrelated modules are NOT touched.
 *
 * Two focused cases:
 *   1. authorized correction + list/read — a staff actor with an
 *      explicit ACTIVE assignment to the scope's exact Building posts
 *      a transaction-scoped ADJUSTMENT (idempotent replay) and reads
 *      the correction list + derived summary;
 *   2. same-client sibling building — a staff actor holding ONLY the
 *      same-Client SIBLING Building is denied 403 on EACH exposed
 *      operation (refund, both reversals, adjustment, list, summary)
 *      with ZERO mutation and no read leak.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_ledger_corrections,
    handyman_payment_allocations,
    handyman_customer_payment_events,
    handyman_customer_payments,
    handyman_charge_line_bases,
    handyman_charge_lines, handyman_customer_transaction_events,
    handyman_customer_transactions,
    handyman_evidence_record_events,
    handyman_evidence_record_files, handyman_evidence_records,
    handyman_qc_run_events, handyman_qc_run_items, handyman_qc_runs,
    handyman_defect_events, handyman_defect_records,
    handyman_bast_sign_offs, handyman_bast_events,
    handyman_bast_documents,
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendors, workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients, units_of_measure CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  disciplineId = d.id;
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

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

/**
 * Asserts the module's exact BE-02G denial vocabulary:
 * 403 HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED.
 */
async function assertCorrectionDenied(
  promise: Promise<unknown>,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(
      errorCode(error),
      'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED',
    );
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

const correctionRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_ledger_corrections c
        JOIN handyman_customer_transactions t
          ON t.id = c.transaction_id
        WHERE t.execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0].n as number;

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * scope's building, A2 = the same-client sibling) + HR anchors.
 */
async function realmFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA1 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A1 (scope building)',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1.id,
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Worker Position',
  });
  return {
    client, property, buildingA1, buildingA2, organization, department,
    position,
  };
}

/** AUTHORIZED execution scope (building = A1) via the full CR-HM-02→06 chain. */
async function scopeFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  const floor = await floorService.createFloor({
    buildingId: realm.buildingA1.id,
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
    clientId: realm.client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.buildingA1.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: realm.client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'FM_HINT_TEXT',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
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
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: 'PART 06F-2 fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id },
    adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'Hours', quantity: 1, uomId,
    currency: 'IDR', finalQuotedUnitAmount: 100,
  }, adminUserId);
  await issueHandymanQuotationVersion(version.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, adminUserId);
  const decision = await decideHandymanQuotation(version.id, {
    decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
  }, adminUserId);
  const scope = decision.executionScope!;
  assert.equal(scope.status, 'AUTHORIZED');
  assert.equal(scope.buildingId, realm.buildingA1.id);
  return { scope };
}

/**
 * A plain local staff actor (finance command model) holding an
 * explicit ACTIVE building assignment to `buildingId` — no crew, no
 * Lead role, no customer identity.
 */
async function staffActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `finance-${suffix().toLowerCase()}@example.com`,
    displayName: 'Finance Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

/** The scope's approved-version LABOR snapshot line (the charge basis). */
async function laborLineId(scope: { approvedQuotationVersionId: string }) {
  const result = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
    [scope.approvedQuotationVersionId],
  );
  assert.equal(result.rows.length, 1, 'LABOR snapshot line required');
  return result.rows[0].id as string;
}

/** Minimal ledger: open transaction + one LABOR charge line (100.00). */
async function ledgerWithCharge(scopeId: string, lineId: string, staff: string) {
  await openHandymanCustomerTransaction({
    executionScopeId: scopeId,
    idempotencyKey: `open-${randomUUID()}`,
  }, staff);
  const composed = await composeHandymanChargeLine({
    executionScopeId: scopeId,
    quotationLineId: lineId,
    idempotencyKey: `line-${randomUUID()}`,
  }, staff);
  return composed.chargeLine.id;
}

describe('CR-HM-SEC-01 PART 06F-2 — ledger correction building-scope guard', () => {
  it('1: authorized correction + list/read — staff actor (exact Building) posts an ADJUSTMENT and reads list + summary', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const lineId = await laborLineId(scope);
    const chargeLineId = await ledgerWithCharge(scope.id, lineId, staff);

    // ADJUSTMENT — line-scoped, reasoned delta (append-only).
    const adjustKey = `adj-${randomUUID()}`;
    const adjusted = await adjustHandymanCustomerLedger({
      executionScopeId: scope.id,
      chargeLineId,
      amount: '10.00',
      reason: 'Approved scope reduction.',
      idempotencyKey: adjustKey,
    }, staff);
    assert.equal(adjusted.replayed, false);
    assert.equal(adjusted.correction.correctionKind, 'ADJUSTMENT');
    assert.equal(adjusted.correction.sourceKind, 'CHARGE_LINE');
    assert.equal(adjusted.correction.sourceChargeLineId, chargeLineId);
    assert.equal(adjusted.correction.amount, '10.00');
    assert.equal(adjusted.correction.currency, 'IDR');
    assert.equal(adjusted.correction.reason, 'Approved scope reduction.');

    // Per-key idempotent replay converges on the SAME fact.
    const replayed = await adjustHandymanCustomerLedger({
      executionScopeId: scope.id,
      chargeLineId,
      amount: '10.00',
      reason: 'Approved scope reduction.',
      idempotencyKey: adjustKey,
    }, staff);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.correction.id, adjusted.correction.id);

    // LIST — the bounded correction read.
    const listed = await listHandymanLedgerCorrections(scope.id, staff);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, adjusted.correction.id);
    assert.equal(listed[0].correctionKind, 'ADJUSTMENT');

    // SUMMARY — derived net view over posted facts.
    const summary = await summarizeHandymanLedgerCorrections(
      scope.id, staff,
    );
    assert.equal(summary.currency, 'IDR');
    assert.equal(summary.totals.adjusted, '10.00');
    assert.equal(summary.totals.refunded, '0.00');
    assert.equal(summary.chargeLines.length, 1);
    assert.equal(summary.chargeLines[0].adjusted, '10.00');

    // Exact persistence: exactly one append-only correction fact.
    assert.equal(await correctionRows(scope.id), 1);
  });

  it('2: same-client sibling building — EACH exposed operation denied 403 with ZERO mutation and no read leak', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const lineId = await laborLineId(scope);
    await ledgerWithCharge(scope.id, lineId, staff);
    // Seed a lawful correction so the denial is provably the access
    // wall, not an empty projection.
    await adjustHandymanCustomerLedger({
      executionScopeId: scope.id,
      amount: '10.00',
      reason: 'Seeded adjustment.',
      idempotencyKey: `seed-${randomUUID()}`,
    }, staff);
    assert.equal(await correctionRows(scope.id), 1);

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor). The guard fires in the preamble BEFORE any source
    // resolution, so unknown source IDs are never even evaluated.
    const siblingStaff = await staffActor(realm.buildingA2.id);

    // REFUND — denied, no correction insertion.
    await assertCorrectionDenied(refundHandymanCustomerPayment({
      executionScopeId: scope.id,
      paymentId: randomUUID(),
      amount: '5.00',
      reason: 'Sibling refund attempt.',
      idempotencyKey: `denied-refund-${randomUUID()}`,
    }, siblingStaff));

    // REVERSE_ALLOCATION — denied, no correction insertion.
    await assertCorrectionDenied(reverseHandymanPaymentAllocation({
      executionScopeId: scope.id,
      allocationId: randomUUID(),
      reason: 'Sibling reversal attempt.',
      idempotencyKey: `denied-revalloc-${randomUUID()}`,
    }, siblingStaff));

    // REVERSE_PAYMENT — denied, no correction insertion.
    await assertCorrectionDenied(reverseHandymanCustomerPayment({
      executionScopeId: scope.id,
      paymentId: randomUUID(),
      reason: 'Sibling reversal attempt.',
      idempotencyKey: `denied-revpay-${randomUUID()}`,
    }, siblingStaff));

    // ADJUSTMENT — denied, no correction insertion.
    await assertCorrectionDenied(adjustHandymanCustomerLedger({
      executionScopeId: scope.id,
      amount: '5.00',
      reason: 'Sibling adjustment attempt.',
      idempotencyKey: `denied-adj-${randomUUID()}`,
    }, siblingStaff));

    // LIST — denied, no content leak.
    await assertCorrectionDenied(
      listHandymanLedgerCorrections(scope.id, siblingStaff),
    );

    // SUMMARY — denied, no content leak.
    await assertCorrectionDenied(
      summarizeHandymanLedgerCorrections(scope.id, siblingStaff),
    );

    // Zero mutation: exactly the seeded correction fact remains.
    assert.equal(await correctionRows(scope.id), 1);
  });
});
