import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-18L — Tenant Approval Binding focused validation.
 *
 * Covers only this PART: binding a Tenant utility charge (a BE-18I
 * calculation attributed to a BE-14A Tenant Company) to the existing BE-14H
 * approval primitive — valid approval, valid rejection, invalid Tenant /
 * Meter context, unauthorized approver, duplicate and final decision
 * protection, available_actions consistency, RBAC, and Client / Building
 * isolation.
 *
 * Utility Aggregation (BE-18M) is deliberately never exercised.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
// Privileged setup user always assigned to the fixture Building, used to seed
// Client-scoped fixture data (e.g. UOM) even when the actor under test is
// deliberately left unassigned to the Building.
let setupToken = '';
let setupUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE tenant_approval_bindings, tenant_utility_requests,
       tenant_complaints, tenant_service_requests, tenant_building_contexts,
       reviews, utility_abnormal_consumptions, utility_abnormality_rules,
       utility_bills, utility_bill_history,
       utility_calculations, utility_calculation_bases,
       utility_meter_consumptions, evidence_submissions,
       evidence_requirements, utility_meter_readings,
       utility_meter_tenant_assignments, utility_meter_hierarchies,
       utility_type_uoms, utility_type_configurations, utility_meters,
       units_of_measure, tenant_space_relationships, tenant_pics,
       tenant_companies, functional_locations, spaces, rooms, areas, floors,
       user_building_assignments, buildings, properties, users, roles,
       permissions, role_permission_assignments, user_role_assignments,
       clients CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const setup = await createAdminUser();
  setupToken = setup.token;
  setupUserId = setup.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

async function createUom(clientId: string) {
  // Client-scoped UOM access is derived from Building assignments; seed it with
  // the setup user that is always assigned to the fixture Building.
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth(setupToken))
    .send({
      code: `UOM_${suffix()}`,
      name: 'Measurement unit',
      symbol: 'kWh',
      category: 'ENERGY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

/** Client → Property → Building → Floor → Area → Room → Space (BE-04 chain). */
async function createStructure(options: { assignUserId?: string | null } = {}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Utility Client',
  });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, setupUserId);
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Utility Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Utility Building',
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `FL_${suffix()}`,
    name: 'Ground floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AR_${suffix()}`,
    name: 'Retail area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RM_${suffix()}`,
    name: 'Unit room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${suffix()}`,
    name: 'Tenant unit',
  });

  // The setup user is always assigned so shared fixture data can be seeded.
  await buildingAssignmentService.createAssignment(setupUserId, {
    buildingId: building.id,
  });

  // The actor under test is assigned only when requested.
  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const uomId = await createUom(client.id);
  return { client, property, building, floor, area, room, space, uomId };
}

type Fixture = Awaited<ReturnType<typeof createStructure>>;

/**
 * Builds a FINALIZED BE-18I calculation attributed to a Tenant Company — the
 * approvable Tenant utility context every test starts from.
 */
async function createTenantCalculation(
  fixture: Fixture,
  options: { finalize?: boolean } = {},
) {
  const meterResponse = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Utility meter',
      utilityType: 'ELECTRICITY',
      // PART 11: only TENANT-purpose meters may enter Tenant approval.
      purpose: 'TENANT',
      uomId: fixture.uomId,
    });
  assert.equal(meterResponse.status, 201, JSON.stringify(meterResponse.body));
  const meter = meterResponse.body.data as { id: string };

  const tenantResponse = await api()
    .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
    .set(auth())
    .send({ tenantCode: `TEN_${suffix()}`, tenantName: 'Tenant Co' });
  assert.equal(tenantResponse.status, 201, JSON.stringify(tenantResponse.body));
  const tenantCompany = tenantResponse.body.data as { id: string };

  // BE-14C lease: BE-18D only assigns a Meter to a Tenant that holds the Space.
  const leased = await api()
    .post(`/api/v1/tenant-companies/${tenantCompany.id}/spaces`)
    .set(auth())
    .send({ buildingId: fixture.building.id, spaceId: fixture.space.id });
  assert.equal(leased.status, 201, JSON.stringify(leased.body));

  const assigned = await api()
    .post(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
    .set(auth())
    .send({ tenantCompanyId: tenantCompany.id, spaceId: fixture.space.id });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

  const iso = (m: number) => new Date(Date.UTC(2026, m, 1)).toISOString();
  const first = await api()
    .post(`/api/v1/utility/meters/${meter.id}/readings`)
    .set(auth())
    .send({ readingValue: 0, readingAt: iso(0) });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await api()
    .post(`/api/v1/utility/meters/${meter.id}/readings`)
    .set(auth())
    .send({ readingValue: 150, readingAt: iso(1) });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const consumption = await api()
    .post(`/api/v1/utility/meters/${meter.id}/consumptions`)
    .set(auth())
    .send({ currentReadingId: second.body.data.id });
  assert.equal(consumption.status, 201, JSON.stringify(consumption.body));

  // PART 10: governed Building tariff (rate 2 → 150 consumed × 2 = 300).
  const tariff = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/utility-tariffs`)
    .set(auth())
    .send({
      utilityType: 'ELECTRICITY',
      currency: 'IDR',
      uomId: fixture.uomId,
      ratePerUom: '2',
      effectiveFrom: '2025-01-01T00:00:00.000Z',
    });
  assert.equal(tariff.status, 201, JSON.stringify(tariff.body));

  const calculation = await api()
    .post(`/api/v1/utility/consumptions/${consumption.body.data.id}/calculations`)
    .set(auth())
    .send({});
  assert.equal(calculation.status, 201, JSON.stringify(calculation.body));
  assert.equal(calculation.body.data.tenantCompanyId, tenantCompany.id);
  assert.equal(calculation.body.data.tariffId, tariff.body.data.id);

  const calculationId = calculation.body.data.id as string;

  if (options.finalize !== false) {
    const finalized = await api()
      .post(`/api/v1/utility/calculations/${calculationId}/finalize`)
      .set(auth())
      .send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.data.status, 'FINALIZED');
  }

  return { meter, tenantCompany, calculationId };
}

const APPROVAL_TYPE = 'TENANT_UTILITY_CHARGE';

async function bind(
  calculationId: string,
  approverUserId: string,
  token = adminToken,
  approvalType = APPROVAL_TYPE,
) {
  return api()
    .post('/api/v1/tenant-approvals')
    .set(auth(token))
    .send({
      requestType: 'UTILITY_CALCULATION',
      requestId: calculationId,
      approvalType,
      approverUserId,
    });
}

const contextUrl = (id: string) =>
  `/api/v1/utility/calculations/${id}/tenant-approvals`;

describe('BE-18L tenant approval binding — valid approval', () => {
  it('approves a finalized Tenant utility charge on the BE-14H engine', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId, tenantCompany, meter } =
      await createTenantCalculation(fixture);

    const created = await bind(calculationId, adminUserId);

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const binding = created.body.data;
    assert.equal(binding.requestType, 'UTILITY_CALCULATION');
    assert.equal(binding.utilityCalculationId, calculationId);
    assert.equal(binding.requestId, calculationId);
    assert.equal(binding.approvalType, APPROVAL_TYPE);
    assert.equal(binding.approverUserId, adminUserId);
    assert.equal(binding.status, 'PENDING');
    assert.equal(binding.decidedAt, null);
    assert.equal(binding.decisionNotes, null);
    // Tenant / Building context is resolved from the calculation, not supplied.
    assert.equal(binding.tenantCompanyId, tenantCompany.id);
    assert.equal(binding.buildingId, fixture.building.id);
    assert.equal(binding.clientId, fixture.client.id);

    const approved = await api()
      .post(`/api/v1/tenant-approvals/${binding.id}/approve`)
      .set(auth())
      .send({ decisionNotes: 'Charge agreed with the tenant.' });

    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'APPROVED');
    assert.equal(
      approved.body.data.decisionNotes,
      'Charge agreed with the tenant.',
    );
    assert.ok(approved.body.data.decidedAt, 'decided_at must be stamped');

    // Approving records a judgement; it never edits the charge itself.
    const calculation = await api()
      .get(`/api/v1/utility/calculations/${calculationId}`)
      .set(auth());
    assert.equal(calculation.body.data.status, 'FINALIZED');
    assert.equal(calculation.body.data.meterId, meter.id);
  });

  it('stores the binding on the BE-14H table, not a new one', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId, tenantCompany } =
      await createTenantCalculation(fixture);

    const created = await bind(calculationId, adminUserId);
    await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({});

    const rows = await pool!.query(
      `SELECT request_type, utility_calculation_id, service_request_id,
              complaint_id, utility_request_id, status, decided_at,
              tenant_company_id, building_id
       FROM tenant_approval_bindings WHERE utility_calculation_id = $1`,
      [calculationId],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].request_type, 'UTILITY_CALCULATION');
    assert.equal(rows.rows[0].status, 'APPROVED');
    assert.ok(rows.rows[0].decided_at);
    assert.equal(rows.rows[0].tenant_company_id, tenantCompany.id);
    assert.equal(rows.rows[0].building_id, fixture.building.id);
    // Exactly one target reference is set.
    assert.equal(rows.rows[0].service_request_id, null);
    assert.equal(rows.rows[0].complaint_id, null);
    assert.equal(rows.rows[0].utility_request_id, null);
  });

  it('resolves the approval context for a Tenant utility charge', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId, tenantCompany } =
      await createTenantCalculation(fixture);

    const before = await api().get(contextUrl(calculationId)).set(auth());
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.data.approvable, true);
    assert.equal(before.body.data.tenantCompanyId, tenantCompany.id);
    assert.equal(before.body.data.buildingId, fixture.building.id);
    assert.deepEqual(before.body.data.approvals, []);
    assert.deepEqual(before.body.data.pendingApprovals, []);

    const created = await bind(calculationId, adminUserId);
    const after = await api().get(contextUrl(calculationId)).set(auth());
    assert.equal(after.body.data.approvals.length, 1);
    assert.equal(after.body.data.pendingApprovals.length, 1);
    assert.equal(after.body.data.pendingApprovals[0].id, created.body.data.id);
  });

  it('lists the binding among pending approvals', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);

    const pending = await api()
      .get(`/api/v1/tenant-approvals/pending?utilityCalculationId=${calculationId}`)
      .set(auth());

    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.data.length, 1);
    assert.equal(pending.body.data[0].id, created.body.data.id);
    assert.equal(pending.body.data[0].requestType, 'UTILITY_CALCULATION');

    // Once decided it leaves the pending queue.
    await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({});
    const after = await api()
      .get(`/api/v1/tenant-approvals/pending?utilityCalculationId=${calculationId}`)
      .set(auth());
    assert.equal(after.body.data.length, 0);
  });
});

describe('BE-18L tenant approval binding — valid rejection', () => {
  it('rejects a Tenant utility charge with notes', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);

    const rejected = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/reject`)
      .set(auth())
      .send({ decisionNotes: 'Tenant disputes the meter reading.' });

    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.status, 'REJECTED');
    assert.equal(
      rejected.body.data.decisionNotes,
      'Tenant disputes the meter reading.',
    );
    assert.ok(rejected.body.data.decidedAt);

    // The underlying charge is untouched by the rejection.
    const calculation = await api()
      .get(`/api/v1/utility/calculations/${calculationId}`)
      .set(auth());
    assert.equal(calculation.body.data.status, 'FINALIZED');
  });

  it('requires notes when rejecting', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);

    const response = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/reject`)
      .set(auth())
      .send({});

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18L tenant approval binding — invalid tenant or meter context', () => {
  it('rejects a binding against an unknown calculation', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await bind(randomUUID(), adminUserId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_APPROVAL_REQUEST_INVALID');
  });

  it('refuses a calculation not attributed to any Tenant', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    // Strip the Tenant attribution: a landlord-side charge has no approver.
    await pool!.query(
      `UPDATE utility_calculations
       SET tenant_company_id = NULL, tenant_assignment_id = NULL
       WHERE id = $1`,
      [calculationId],
    );

    const response = await bind(calculationId, adminUserId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_APPROVAL_CONTEXT_MISMATCH');
  });

  it('refuses a calculation whose Meter has moved to another building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const otherFixture = await createStructure();

    await pool!.query(
      'UPDATE utility_calculations SET building_id = $2 WHERE id = $1',
      [calculationId, otherFixture.building.id],
    );

    const response = await bind(calculationId, adminUserId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_APPROVAL_CONTEXT_MISMATCH');
  });

  it('refuses a Tenant Company belonging to another Client', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const otherFixture = await createStructure();

    const foreignTenant = await api()
      .post(`/api/v1/clients/${otherFixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TEN_${suffix()}`, tenantName: 'Foreign Tenant' });
    assert.equal(foreignTenant.status, 201, JSON.stringify(foreignTenant.body));

    await pool!.query(
      'UPDATE utility_calculations SET tenant_company_id = $2 WHERE id = $1',
      [calculationId, foreignTenant.body.data.id],
    );

    const response = await bind(calculationId, adminUserId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_APPROVAL_CONTEXT_MISMATCH');
  });

  it('refuses to bind a charge that is not final yet', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    // DRAFT: the figure can still change, so there is nothing to approve.
    const { calculationId } = await createTenantCalculation(fixture, {
      finalize: false,
    });

    const response = await bind(calculationId, adminUserId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_APPROVAL_REQUEST_INVALID');

    const context = await api().get(contextUrl(calculationId)).set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.data.approvable, false);
  });
});

describe('BE-18L tenant approval binding — unauthorized approver', () => {
  it('refuses an approver without access to the Building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    // Full RBAC, but no assignment to this Building.
    const outsider = await createAdminUser();

    const response = await bind(calculationId, outsider.userId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_APPROVAL_APPROVER_INVALID');

    const rows = await pool!.query(
      'SELECT id FROM tenant_approval_bindings WHERE utility_calculation_id = $1',
      [calculationId],
    );
    assert.equal(rows.rowCount, 0);
  });

  it('refuses a decision from anyone but the assigned approver', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    const approver = await createAdminUser();
    await buildingAssignmentService.createAssignment(approver.userId, {
      buildingId: fixture.building.id,
    });

    const created = await bind(calculationId, approver.userId);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // The creator is not the approver of record and may not decide.
    const denied = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({});
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(
      denied.body.error.code,
      'TENANT_APPROVAL_UNAUTHORIZED_APPROVER',
    );

    // The approver of record still can.
    const allowed = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth(approver.token))
      .send({});
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.status, 'APPROVED');
  });
});

describe('BE-18L tenant approval binding — duplicate and final decision protected', () => {
  it('refuses a duplicate pending binding', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    const first = await bind(calculationId, adminUserId);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await bind(calculationId, adminUserId);

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error.code, 'TENANT_APPROVAL_ALREADY_PENDING');
  });

  it('never silently overwrites a final decision', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);
    const approvalId = created.body.data.id;

    const approved = await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/approve`)
      .set(auth())
      .send({ decisionNotes: 'Agreed.' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const reversal = await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/reject`)
      .set(auth())
      .send({ decisionNotes: 'Changed my mind.' });
    assert.equal(reversal.status, 409, JSON.stringify(reversal.body));
    assert.equal(reversal.body.error.code, 'TENANT_APPROVAL_ALREADY_DECIDED');

    const repeat = await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/approve`)
      .set(auth())
      .send({});
    assert.equal(repeat.status, 409, JSON.stringify(repeat.body));

    // The original decision stands, unaltered.
    const current = await api()
      .get(`/api/v1/tenant-approvals/${approvalId}`)
      .set(auth());
    assert.equal(current.body.data.status, 'APPROVED');
    assert.equal(current.body.data.decisionNotes, 'Agreed.');
  });

  it('keeps concurrent decisions from both landing', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);
    const approvalId = created.body.data.id;

    const [a, b] = await Promise.all([
      api()
        .post(`/api/v1/tenant-approvals/${approvalId}/approve`)
        .set(auth())
        .send({}),
      api()
        .post(`/api/v1/tenant-approvals/${approvalId}/reject`)
        .set(auth())
        .send({ decisionNotes: 'Disputed.' }),
    ]);

    assert.deepEqual([a.status, b.status].sort(), [200, 409]);

    const rows = await pool!.query(
      `SELECT status FROM tenant_approval_bindings
       WHERE utility_calculation_id = $1`,
      [calculationId],
    );
    assert.equal(rows.rowCount, 1);
    assert.notEqual(rows.rows[0].status, 'PENDING');
  });

  it('allows a fresh binding after a rejection', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    const first = await bind(calculationId, adminUserId);
    await api()
      .post(`/api/v1/tenant-approvals/${first.body.data.id}/reject`)
      .set(auth())
      .send({ decisionNotes: 'Rejected pending re-read.' });

    const second = await bind(calculationId, adminUserId);
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // Both decisions survive as history; the first is not overwritten.
    const context = await api().get(contextUrl(calculationId)).set(auth());
    assert.equal(context.body.data.approvals.length, 2);
    assert.deepEqual(
      context.body.data.approvals.map((a: { status: string }) => a.status),
      ['REJECTED', 'PENDING'],
    );
  });
});

describe('BE-18L tenant approval binding — available actions consistency', () => {
  it('offers APPROVE and REJECT only to the approver while PENDING', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    const approver = await createAdminUser();
    await buildingAssignmentService.createAssignment(approver.userId, {
      buildingId: fixture.building.id,
    });
    const created = await bind(calculationId, approver.userId);
    const approvalId = created.body.data.id;

    const forApprover = await api()
      .get(`/api/v1/tenant-approvals/${approvalId}/available-actions`)
      .set(auth(approver.token));
    assert.equal(forApprover.status, 200, JSON.stringify(forApprover.body));
    assert.equal(forApprover.body.data.state, 'PENDING');
    assert.deepEqual(forApprover.body.data.availableActions, [
      'APPROVE',
      'REJECT',
    ]);

    // Backend-authoritative: a non-approver is offered nothing.
    const forOther = await api()
      .get(`/api/v1/tenant-approvals/${approvalId}/available-actions`)
      .set(auth());
    assert.deepEqual(forOther.body.data.availableActions, []);
  });

  it('offers no actions once the decision is final', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);
    const approvalId = created.body.data.id;

    await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/approve`)
      .set(auth())
      .send({});

    const actions = await api()
      .get(`/api/v1/tenant-approvals/${approvalId}/available-actions`)
      .set(auth());

    assert.equal(actions.body.data.state, 'APPROVED');
    assert.deepEqual(actions.body.data.availableActions, []);
  });

  it('keeps approval actions available while the binding itself is PENDING', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = bind(calculationId, adminUserId);
    const approvalId = (await created).body.data.id;

    // For UTILITY_CALCULATION bindings, available actions are gated by the
    // binding's own PENDING state, the approver/permission/Building checks,
    // AND the current eligibility of the underlying calculation (CR-BE-UTL-02).
    // While the calculation stays FINALIZED the actions remain available.
    const actions = await api()
      .get(`/api/v1/tenant-approvals/${approvalId}/available-actions`)
      .set(auth());
    assert.equal(actions.body.data.state, 'PENDING');
    assert.deepEqual(actions.body.data.availableActions, ['APPROVE', 'REJECT']);

    // A decision is therefore accepted for the assigned approver, consistent
    // with the actions advertised above.
    const decided = await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/approve`)
      .set(auth())
      .send({});
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.data.status, 'APPROVED');
  });
});

describe('CR-BE-UTL-02 — superseded calculation approval guard', () => {
  it('withdraws APPROVE/REJECT once the calculation is SUPERSEDED and refuses a decision', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    const created = await bind(calculationId, adminUserId);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const approvalId = created.body.data.id;
    assert.equal(created.body.data.status, 'PENDING');

    // The public API refuses to supersede a FINALIZED calculation, so the
    // out-of-band status change is reproduced directly — the exact invariant
    // a PENDING binding may face. The finalized stamps must be cleared too,
    // otherwise the utility_calculations_finalized_check constraint rejects
    // a non-FINALIZED row carrying finalization stamps.
    const superseded = await pool!.query(
      `UPDATE utility_calculations
          SET status = 'SUPERSEDED',
              finalized_at = NULL,
              finalized_by_user_id = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING status`,
      [calculationId],
    );
    assert.equal(superseded.rows[0].status, 'SUPERSEDED');

    const calculation = await api()
      .get(`/api/v1/utility/calculations/${calculationId}`)
      .set(auth());
    assert.equal(calculation.body.data.status, 'SUPERSEDED');

    // A. Available actions are withdrawn while the binding stays PENDING.
    const actions = await api()
      .get(`/api/v1/tenant-approvals/${approvalId}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.equal(actions.body.data.state, 'PENDING');
    assert.deepEqual(actions.body.data.availableActions, []);

    // The approval context surface agrees: the same calculation is no longer
    // approvable, and the PENDING binding is still visible in its history.
    const context = await api()
      .get(contextUrl(calculationId))
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.data.approvable, false);
    assert.equal(context.body.data.pendingApprovals.length, 1);

    // B. The decision path refuses both actions for the assigned approver.
    const approved = await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/approve`)
      .set(auth())
      .send({ decisionNotes: 'Must never be recorded.' });
    assert.equal(approved.status, 403, JSON.stringify(approved.body));
    assert.equal(approved.body.error.code, 'TENANT_APPROVAL_ACTION_NOT_ALLOWED');

    const rejected = await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/reject`)
      .set(auth())
      .send({ decisionNotes: 'Must never be recorded.' });
    assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'TENANT_APPROVAL_ACTION_NOT_ALLOWED');

    // C. The binding and its history are preserved: still PENDING, undecided,
    // with no decision metadata recorded anywhere.
    const rows = await pool!.query(
      `SELECT status, decided_at, decision_notes
         FROM tenant_approval_bindings
        WHERE id = $1`,
      [approvalId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, 'PENDING');
    assert.equal(rows.rows[0].decided_at, null);
    assert.equal(rows.rows[0].decision_notes, null);
  });

  it('keeps APPROVE/REJECT available while the calculation is still FINALIZED', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);

    const created = await bind(calculationId, adminUserId);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const approvalId = created.body.data.id;

    // Positive control for the same guard: the eligibility re-resolution is
    // what withholds actions, so a still-eligible calculation must keep them.
    const actions = await api()
      .get(`/api/v1/tenant-approvals/${approvalId}/available-actions`)
      .set(auth());
    assert.equal(actions.body.data.state, 'PENDING');
    assert.deepEqual(actions.body.data.availableActions, ['APPROVE', 'REJECT']);

    const decided = await api()
      .post(`/api/v1/tenant-approvals/${approvalId}/approve`)
      .set(auth())
      .send({});
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.data.status, 'APPROVED');
  });
});

describe('BE-18L tenant approval binding — RBAC', () => {
  it('requires authentication on every binding endpoint', async (t) => {
    if (!requireDatabase(t)) return;
    const id = randomUUID();

    for (const response of [
      await api().post('/api/v1/tenant-approvals').send({}),
      await api().get(contextUrl(id)),
      await api().get(`/api/v1/tenant-approvals/${id}`),
      await api().get('/api/v1/tenant-approvals/pending'),
      await api().get(`/api/v1/tenant-approvals/${id}/available-actions`),
      await api().post(`/api/v1/tenant-approvals/${id}/approve`).send({}),
      await api().post(`/api/v1/tenant-approvals/${id}/reject`).send({}),
    ]) {
      assert.equal(response.status, 401, JSON.stringify(response.body));
    }
  });

  it('denies a session without the tenant permissions', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);
    const plainToken = await createPlainSession();

    const context = await api().get(contextUrl(calculationId)).set(auth(plainToken));
    assert.equal(context.status, 403, JSON.stringify(context.body));

    const bound = await bind(calculationId, adminUserId, plainToken);
    assert.equal(bound.status, 403, JSON.stringify(bound.body));

    const approved = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth(plainToken))
      .send({});
    assert.equal(approved.status, 403, JSON.stringify(approved.body));
  });
});

describe('BE-18L tenant approval binding — client and building isolation', () => {
  it('denies binding and reading across buildings', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    const created = await bind(calculationId, adminUserId);

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const context = await api()
      .get(contextUrl(calculationId))
      .set(auth(outsider.token));
    assert.equal(context.status, 403, JSON.stringify(context.body));
    assert.equal(context.body.error.code, 'BUILDING_ACCESS_DENIED');

    const fetched = await api()
      .get(`/api/v1/tenant-approvals/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));

    const bound = await bind(calculationId, outsider.userId, outsider.token);
    assert.equal(bound.status, 403, JSON.stringify(bound.body));

    const approved = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth(outsider.token))
      .send({});
    assert.equal(approved.status, 403, JSON.stringify(approved.body));

    // Nothing was decided on the way out.
    const rows = await pool!.query(
      `SELECT status FROM tenant_approval_bindings
       WHERE utility_calculation_id = $1`,
      [calculationId],
    );
    assert.equal(rows.rows[0].status, 'PENDING');
  });

  it('scopes the pending queue to accessible buildings only', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { calculationId } = await createTenantCalculation(fixture);
    await bind(calculationId, adminUserId);

    // An admin assigned to a different Building sees none of it.
    const otherAdmin = await createAdminUser();
    const otherFixture = await createStructure({
      assignUserId: otherAdmin.userId,
    });

    const theirs = await api()
      .get('/api/v1/tenant-approvals/pending')
      .set(auth(otherAdmin.token));
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(
      theirs.body.data.filter(
        (item: { utilityCalculationId: string | null }) =>
          item.utilityCalculationId === calculationId,
      ).length,
      0,
    );

    const mine = await api()
      .get(`/api/v1/tenant-approvals/pending?utilityCalculationId=${calculationId}`)
      .set(auth());
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0].clientId, fixture.client.id);
    assert.notEqual(mine.body.data[0].clientId, otherFixture.client.id);
  });
});
