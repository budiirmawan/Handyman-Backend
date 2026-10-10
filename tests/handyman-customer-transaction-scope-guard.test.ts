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
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
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
 * CR-HM-SEC-01 PART 06E-1 (ULTRA-LIGHT) — focused tests for the
 * CUSTOMER TRANSACTION ledger-write authorization boundary:
 * `authorityPreamble` in handyman-customer-transaction.service.ts,
 * shared by exactly TWO commands (confirmed — no other callers):
 * `openHandymanCustomerTransaction` and `composeHandymanChargeLine`.
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The execution scope row carries the
 * authoritative server-derived `building_id` snapshot (migration
 * 0395), and the preamble loads that scope, so the client-level
 * canAccessClient wall is replaced by the BE-02G exact-Building check
 * on `scope.buildingId`.
 *
 * Implementation note: the BE-02G guard's predicate
 * (`canAccessBuildingScopedResource`) is applied directly so the
 * module's denial vocabulary is preserved EXACTLY — a denial stays
 * 403 HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED, as asserted by the
 * existing transaction/charge-composition suites for foreign actors.
 * Error precedence is unchanged: scope 404 precedes the access wall.
 *
 * Actor contract (verified): both commands are in-process (the module
 * is ZERO-HTTP by governance); the actor is a LOCAL staff user —
 * caller-supplied customer/actor identity is never authority, and no
 * BM SSO / customer principal reaches this module.
 *
 * Preserved: financial admission gates (one transaction per scope,
 * charge line only against the anchored approved quotation version,
 * one charge line per quotation line), transaction/charge-line rules
 * (server-derived currency/amounts, LABOR/MATERIAL separation), state
 * transitions, audit event chain, single-transaction behavior, and
 * per-key idempotent replay. Payments, allocations, ledger
 * corrections, ledger reads, warranty, arrival, and other modules are
 * NOT touched by this PART.
 *
 * Two focused cases:
 *   1. authorized exact-building transaction/charge-line operations
 *      — a staff actor with an explicit ACTIVE assignment to the
 *      scope's exact Building opens the ledger transaction (with an
 *      idempotent replay) and composes the LABOR charge line;
 *   2. same-client sibling building — a staff actor holding ONLY the
 *      same-Client SIBLING Building is denied 403 on BOTH commands
 *      with ZERO mutation (no transaction, no charge line, no event).
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
  await pool.query(`TRUNCATE handyman_charge_line_bases,
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
async function assertTransactionDenied(
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

const transactionRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_customer_transactions
        WHERE execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0].n as number;

const chargeLineRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_charge_lines cl
        JOIN handyman_customer_transactions t
          ON t.id = cl.transaction_id
        WHERE t.execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0].n as number;

const eventTypes = async (scopeId: string): Promise<string[]> => {
  const result = await q(
    `SELECT e.event_type FROM handyman_customer_transaction_events e
      JOIN handyman_customer_transactions t
        ON t.id = e.transaction_id
      WHERE t.execution_scope_id = $1 ORDER BY e.occurred_at, e.id`,
    [scopeId],
  );
  return result.rows.map((row) => row.event_type as string);
};

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
      diagnosis: 'PART 06E-1 fixture diagnosis.',
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

describe('CR-HM-SEC-01 PART 06E-1 — customer transaction writes building-scope guard', () => {
  it('1: authorized exact-building transaction/charge-line operations — staff actor (exact Building) opens the ledger and composes the LABOR charge line', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const lineId = await laborLineId(scope);

    // OPEN_TRANSACTION — single immutable ledger anchor + audit event.
    const openKey = `open-${randomUUID()}`;
    const opened = await openHandymanCustomerTransaction({
      executionScopeId: scope.id,
      idempotencyKey: openKey,
    }, staff);
    assert.equal(opened.replayed, false);
    assert.equal(opened.transaction.executionScopeId, scope.id);
    assert.equal(opened.transaction.currency, 'IDR');
    assert.equal(opened.event.eventType, 'OPEN_TRANSACTION');

    // Per-key idempotent replay returns the SAME transaction + event.
    const replayed = await openHandymanCustomerTransaction({
      executionScopeId: scope.id,
      idempotencyKey: openKey,
    }, staff);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.transaction.id, opened.transaction.id);
    assert.equal(replayed.event.id, opened.event.id);

    // POST_CHARGE_LINE — server-composed from the approved snapshot.
    const lineKey = `line-${randomUUID()}`;
    const composed = await composeHandymanChargeLine({
      executionScopeId: scope.id,
      quotationLineId: lineId,
      idempotencyKey: lineKey,
    }, staff);
    assert.equal(composed.replayed, false);
    assert.equal(composed.transaction.id, opened.transaction.id);
    assert.equal(composed.chargeLine.quotationLineId, lineId);
    assert.equal(composed.basis.compositionKind, 'LABOR_APPROVED_SNAPSHOT');
    assert.equal(composed.event.eventType, 'POST_CHARGE_LINE');

    // Per-key idempotent replay returns the SAME charge line + event.
    const lineReplay = await composeHandymanChargeLine({
      executionScopeId: scope.id,
      quotationLineId: lineId,
      idempotencyKey: lineKey,
    }, staff);
    assert.equal(lineReplay.replayed, true);
    assert.equal(lineReplay.chargeLine.id, composed.chargeLine.id);
    assert.equal(lineReplay.event.id, composed.event.id);

    // Exact persistence: 1 transaction, 1 charge line,
    // OPEN_TRANSACTION + POST_CHARGE_LINE audit chain.
    assert.equal(await transactionRows(scope.id), 1);
    assert.equal(await chargeLineRows(scope.id), 1);
    assert.deepEqual(await eventTypes(scope.id),
      ['OPEN_TRANSACTION', 'POST_CHARGE_LINE']);
  });

  it('2: same-client sibling building — BOTH commands denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const lineId = await laborLineId(scope);
    // Seed a lawful open ledger so the denial is provably the access
    // wall, not an empty projection.
    await openHandymanCustomerTransaction({
      executionScopeId: scope.id,
      idempotencyKey: `seed-${randomUUID()}`,
    }, staff);
    assert.equal(await transactionRows(scope.id), 1);

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const siblingStaff = await staffActor(realm.buildingA2.id);

    // OPEN_TRANSACTION — denied (a NEW key would be a 409 conflict on
    // the existing anchor; the guard must fire first with the module's
    // 403 vocabulary, leaking nothing).
    await assertTransactionDenied(openHandymanCustomerTransaction({
      executionScopeId: scope.id,
      idempotencyKey: `denied-open-${randomUUID()}`,
    }, siblingStaff));

    // POST_CHARGE_LINE — denied.
    await assertTransactionDenied(composeHandymanChargeLine({
      executionScopeId: scope.id,
      quotationLineId: lineId,
      idempotencyKey: `denied-line-${randomUUID()}`,
    }, siblingStaff));

    // Zero mutation: still exactly the seeded anchor, no charge line,
    // no additional events.
    assert.equal(await transactionRows(scope.id), 1);
    assert.equal(await chargeLineRows(scope.id), 0);
    assert.deepEqual(await eventTypes(scope.id), ['OPEN_TRANSACTION']);
  });
});
