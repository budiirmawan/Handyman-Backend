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
import {
  handymanDisciplineRepository,
} from '../src/modules/handyman-disciplines';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
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
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-04 Execution Scope Assignment Activation PART A — DB-level
 * persistence/invariant tests ONLY (FROZEN governance activation doc
 * §1–§8). Ten cases prove migration 0396: FK wiring to
 * scope/provider/crew authorities, client consistency, one-ACTIVE
 * uniqueness, supersession history shape, self-supersede block,
 * identity/provenance immutability (delete + update guards), and a
 * zero downstream/Lead-snapshot column surface. NO service/repository
 * exists in PART A (PART B owns semantics), so assertions are direct
 * SQL against the migrated table.
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
  await pool.query(`TRUNCATE handyman_execution_scope_assignments,
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
    users, roles, permissions, clients CASCADE`);
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

/** Org/workforce realm (client → property → building + HR anchors). */
async function realmFixture(label = 'Realm') {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: `${label} Client`,
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
  return { client, property, building, organization, department,
    position };
}

/** Active provider context + crew under the realm's client. */
async function crewFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Field Providers',
  });
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `lead-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Lead',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `LEAD_${suffix()}`,
    fullName: 'Lead Worker',
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `CREW_${suffix()}`,
      name: 'Field Crew',
      leadWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  return { vendor, providerContext, workerContext, crew: bundle.crew };
}

/** AUTHORIZED execution scope via the full CR-HM-02→06 chain. */
async function scopeFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const floor = await floorService.createFloor({
    buildingId: realm.building.id,
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
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
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
      diagnosis: 'Part A fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id }, adminUserId,
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
  return { scope, company, attribution, request, version };
}

/** Direct persisted insert mirroring the frozen model. */
async function insertAssignment(
  scopeId: string,
  providerContextId: string,
  crewId: string,
  clientId: string,
  overrides: Partial<{
    status: string;
    supersedesAssignmentId: string | null;
  }> = {},
) {
  const id = randomUUID();
  await q(
    `INSERT INTO handyman_execution_scope_assignments
       (id, client_id, execution_scope_id,
        handyman_provider_context_id, handyman_crew_id, status,
        assigned_by_user_id, supersedes_assignment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id, clientId, scopeId, providerContextId, crewId,
      overrides.status ?? 'ACTIVE',
      adminUserId, overrides.supersedesAssignmentId ?? null,
    ],
  );
  return id;
}

describe('CR-HM-04 activation PART A — assignment persistence', () => {
  it('1: valid ACTIVE assignment persists with frozen model fields', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const id = await insertAssignment(
      f.scope.id, crew.providerContext.id, crew.crew.id, realm.client.id,
    );
    const row = await q(
      `SELECT * FROM handyman_execution_scope_assignments
        WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows.length, 1);
    const r = row.rows[0];
    assert.equal(r.client_id, realm.client.id);
    assert.equal(r.execution_scope_id, f.scope.id);
    assert.equal(r.handyman_provider_context_id, crew.providerContext.id);
    assert.equal(r.handyman_crew_id, crew.crew.id);
    assert.equal(r.status, 'ACTIVE');
    assert.equal(r.assigned_by_user_id, adminUserId);
    assert.equal(r.supersedes_assignment_id, null);
    assert.ok(r.assigned_at);
    assert.ok(r.created_at);
    assert.ok(r.updated_at);
  });

  it('2: invalid execution scope rejected (FK)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    await assert.rejects(
      () => insertAssignment(
        randomUUID(), crew.providerContext.id, crew.crew.id,
        realm.client.id,
      ),
      (e: unknown) => errorCode(e) === '23503',
    );
  });

  it('3: cross-client scope/provider/crew binding rejected (consistency)', async (t) => {
    if (!requireDatabase(t)) return;
    const realmA = await realmFixture('A');
    const realmB = await realmFixture('B');
    const crewA = await crewFixture(realmA);
    const fB = await scopeFixture(realmB);
    // Scope belongs to client B; provider/crew/client_id claim client A.
    await assert.rejects(
      () => insertAssignment(
        fB.scope.id, crewA.providerContext.id, crewA.crew.id,
        realmA.client.id,
      ),
      (e: unknown) => /cross-client|client_id must match/i.test(
        String((e as { message?: string }).message),
      ),
    );
    const n = await q(
      `SELECT count(*)::int AS n FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1
           OR handyman_provider_context_id = $2`,
      [fB.scope.id, crewA.providerContext.id],
    );
    assert.equal(n.rows[0].n, 0);
  });

  it('4: invalid provider context rejected (FK)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    await assert.rejects(
      () => insertAssignment(
        f.scope.id, randomUUID(), crew.crew.id, realm.client.id,
      ),
      (e: unknown) => errorCode(e) === '23503',
    );
  });

  it('5: invalid crew rejected (FK)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    await assert.rejects(
      () => insertAssignment(
        f.scope.id, crew.providerContext.id, randomUUID(),
        realm.client.id,
      ),
      (e: unknown) => errorCode(e) === '23503',
    );
  });

  it('6: second ACTIVE assignment for the same scope rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    await insertAssignment(
      f.scope.id, crew.providerContext.id, crew.crew.id, realm.client.id,
    );
    await assert.rejects(
      () => insertAssignment(
        f.scope.id, crew.providerContext.id, crew.crew.id,
        realm.client.id,
      ),
      (e: unknown) => errorCode(e) === '23505',
    );
    const n = await q(
      `SELECT count(*)::int AS n FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1`,
      [f.scope.id],
    );
    assert.equal(n.rows[0].n, 1);
  });

  it('7: valid supersession history shape (supersede old ACTIVE, insert new ACTIVE)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crewA = await crewFixture(realm);
    const crewB = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const a1 = await insertAssignment(
      f.scope.id, crewA.providerContext.id, crewA.crew.id,
      realm.client.id,
    );
    // The sole permitted status transition (PART B semantics preview
    // at DB level only): ACTIVE -> SUPERSEDED.
    await q(
      `UPDATE handyman_execution_scope_assignments
          SET status = 'SUPERSEDED' WHERE id = $1`,
      [a1],
    );
    const a2 = await insertAssignment(
      f.scope.id, crewB.providerContext.id, crewB.crew.id,
      realm.client.id,
      { supersedesAssignmentId: a1 },
    );
    const rows = await q(
      `SELECT id, status, supersedes_assignment_id
         FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 ORDER BY created_at`,
      [f.scope.id],
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0].status, 'SUPERSEDED');
    assert.equal(rows.rows[1].status, 'ACTIVE');
    assert.equal(rows.rows[1].supersedes_assignment_id, a1);
    const active = await q(
      `SELECT count(*)::int AS n FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 AND status = 'ACTIVE'`,
      [f.scope.id],
    );
    assert.equal(active.rows[0].n, 1);
    assert.ok(a2);
  });

  it('8: self-supersede rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const id = randomUUID();
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_execution_scope_assignments
           (id, client_id, execution_scope_id,
            handyman_provider_context_id, handyman_crew_id, status,
            assigned_by_user_id, supersedes_assignment_id)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $1)`,
        [
          id, realm.client.id, f.scope.id, crew.providerContext.id,
          crew.crew.id, adminUserId,
        ],
      ),
      (e: unknown) => errorCode(e) === '23514',
    );
  });

  it('9: identity/provenance immutable; delete forbidden; only ACTIVE->SUPERSEDED allowed', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const id = await insertAssignment(
      f.scope.id, crew.providerContext.id, crew.crew.id, realm.client.id,
    );
    // DELETE is always forbidden.
    await assert.rejects(
      () => q(
        `DELETE FROM handyman_execution_scope_assignments WHERE id = $1`,
        [id],
      ),
      (e: unknown) => /immutable/i.test(
        String((e as { message?: string }).message),
      ),
    );
    // Provenance/identity columns cannot be updated.
    for (const stmt of [
      `UPDATE handyman_execution_scope_assignments
         SET handyman_crew_id = gen_random_uuid() WHERE id = '${id}'`,
      `UPDATE handyman_execution_scope_assignments
         SET execution_scope_id = gen_random_uuid() WHERE id = '${id}'`,
      `UPDATE handyman_execution_scope_assignments
         SET assigned_by_user_id = gen_random_uuid() WHERE id = '${id}'`,
      `UPDATE handyman_execution_scope_assignments
         SET supersedes_assignment_id = NULL WHERE id = '${id}'`,
      `UPDATE handyman_execution_scope_assignments
         SET status = 'INACTIVE' WHERE id = '${id}'`,
    ]) {
      await assert.rejects(
        () => q(stmt),
        (e: unknown) => /immutable|violates check constraint/i.test(
          String((e as { message?: string }).message),
        ),
        stmt.split('\n')[1].trim(),
      );
    }
    // Row untouched.
    const still = await q(
      `SELECT status, handyman_crew_id FROM handyman_execution_scope_assignments
        WHERE id = $1`,
      [id],
    );
    assert.equal(still.rows[0].status, 'ACTIVE');
    assert.equal(still.rows[0].handyman_crew_id, crew.crew.id);
    // The one permitted transition works exactly once.
    await q(
      `UPDATE handyman_execution_scope_assignments
          SET status = 'SUPERSEDED' WHERE id = $1`,
      [id],
    );
    // SUPERSEDED rows are fully sealed afterwards.
    await assert.rejects(
      () => q(
        `UPDATE handyman_execution_scope_assignments
            SET status = 'ACTIVE' WHERE id = $1`,
        [id],
      ),
      (e: unknown) => /immutable/i.test(
        String((e as { message?: string }).message),
      ),
    );
  });

  it('10: zero Lead-snapshot / downstream / FM columns in the schema', async (t) => {
    if (!requireDatabase(t)) return;
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'handyman_execution_scope_assignments'
        ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r: { column_name: string }) =>
      r.column_name);
    const allowed = [
      'id', 'client_id', 'execution_scope_id',
      'handyman_provider_context_id', 'handyman_crew_id', 'status',
      'assigned_by_user_id', 'assigned_at',
      'supersedes_assignment_id', 'created_at', 'updated_at',
    ];
    assert.deepEqual([...names].sort(), [...allowed].sort());
    const forbidden = /lead|worker|qr|geofence|arriv|schedul|window|session|check-?in|checkin|work_?order|workorder|fm_|payout|payment|bast|attendance/i;
    for (const name of names) {
      assert.ok(!forbidden.test(name), `forbidden column: ${name}`);
    }
  });
});
