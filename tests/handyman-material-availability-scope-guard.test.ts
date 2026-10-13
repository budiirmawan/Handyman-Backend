import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Response } from 'supertest';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  assertBuildingScopedResourceAccess,
  canAccessBuildingScopedResource,
  contextAccessService,
} from '../src/modules/context-access';
import { departmentService } from '../src/modules/departments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  estimateHandymanMaterialExecutionLine,
  getHandymanMaterialLinesCustomerCareView,
} from '../src/modules/handyman-material-execution';
import { listHandymanProviderAvailability } from '../src/modules/handyman-providers';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { createAdminUser } from './helpers/access';
import {
  crewFixture,
  initHandymanFixtures,
  locationChain,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-02 PART 04 — focused tests for the BE-02G exact-Building
 * authorization guards applied to two Handyman read projections
 * (PART 00A frozen decisions D3 and D4):
 *
 *   D3  getHandymanMaterialLinesCustomerCareView
 *       (GET /handyman/execution-scopes/:id/material-lines,
 *        src/modules/handyman-material-execution/
 *        handyman-material-execution.service.ts)
 *   D4  listHandymanProviderAvailability, executionScopeId path ONLY
 *       (GET /handyman/provider-availability?executionScopeId=...,
 *        src/modules/handyman-providers/
 *        handyman-provider-availability.service.ts)
 *
 * Authority (CR-HM-SEC-02 PART 00 audit, findings B-3 and B-4):
 *   - BE-02G (`docs/data-isolation.md`): access = authentication +
 *     permission + explicit ACTIVE `user_building_assignment` to the
 *     EXACT Building. "No same-Client shortcut."
 *   - The parent `handyman_execution_scopes` row is building-scoped
 *     (`building_id UUID NOT NULL`, migration 0395) and is already
 *     loaded by both operations — the authoritative building.
 *   - The previous walls were the client-level `canAccessClient`
 *     shortcut: an actor assigned only to a same-Client SIBLING
 *     building could read the Customer Care material lines + events of
 *     the scope's building and could read provider/crew occupancy
 *     identifiers through the executionScopeId availability query.
 *
 * Preserved: 404-before-403 (scope not found), authorization before
 * material/event projection and before occupancy projection, the
 * response contracts, Customer Care authority separation (the care
 * read never requires Crew Lead identity), Lead enforcement on
 * material commands, and the contractual clientId-only availability
 * path (client-level authorization verbatim — D4 must NOT leak the
 * building requirement onto it).
 *
 * Eight focused cases:
 *   A. authorized exact-building actor — both paths succeed
 *      (service + HTTP);
 *   B. same-client sibling actor — denied 403, zero projection (no
 *      material lines, no events, no occupancy identifiers);
 *   C. permission-only and cross-client actors — denied;
 *   D. actor assigned to BOTH client buildings — allowed;
 *   E. provider availability clientId-only path — contractual
 *      client-level behavior retained (sibling allowed WITHOUT any
 *      request-building assignment);
 *   F. Customer Care reads remain Lead-free; material commands and
 *      Crew Lead enforcement unchanged;
 *   G. regression detection — the OLD client-level wall passes for
 *      the sibling actor while the guard denies;
 *   H. 404 precedence (unknown scope before any denial) and zero
 *      projection keys on denial.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_work_session_helper_presence,
    handyman_work_session_events, handyman_work_sessions,
    handyman_execution_scope_assignments, handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships, handyman_work_crews,
    handyman_worker_contexts, handyman_provider_contexts,
    handyman_request_referrals, handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_handoff_care_actors, handyman_handoff_integrations,
    handyman_service_variants, handyman_discipline_service_associations,
    service_catalog, vendor_workforce_bindings, vendor_capabilities,
    vendor_pics, vendor_categories, vendors, workforce_profiles,
    organizations, attendance_records, operational_events,
    tenant_service_requests, work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    units_of_measure, users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
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

function assertBuildingDenied(error: unknown): boolean {
  assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
  assert.equal(errorStatus(error), 403);
  return true;
}

function assertScopeNotFound(error: unknown): boolean {
  assert.equal(errorCode(error), 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');
  assert.equal(errorStatus(error), 404);
  return true;
}

function assertDenied403(res: Response, label: string): void {
  assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, 'BUILDING_ACCESS_DENIED', label);
  assert.equal(res.body?.data, undefined, label);
}

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * execution scope's building, A2 = the same-client sibling), plus a
 * second client with one building for the cross-client case, and the
 * org/department/position chain the shared crew fixture needs.
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
  const otherClient = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other Client',
  });
  const otherProperty = await propertyService.createProperty({
    clientId: otherClient.id,
    code: `P_${suffix()}`,
    name: 'Other Property',
  });
  const otherBuilding = await buildingService.createBuilding({
    propertyId: otherProperty.id,
    code: `B_${suffix()}`,
    name: 'Other Building (other client)',
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
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1.id,
  });
  return {
    client,
    property,
    buildingA1,
    buildingA2,
    otherClient,
    otherProperty,
    otherBuilding,
    organization,
    department,
    position,
  };
}

/** The shared fixture helpers expect a single-building realm site. */
function siteOf(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  building: { id: string },
) {
  return {
    client: realm.client,
    property: realm.property,
    building,
    organization: realm.organization,
    department: realm.department,
    position: realm.position,
  };
}

/** AUTHORIZED execution scope at the given building (full CR-HM-06 chain). */
async function scopeAt(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  building: { id: string },
) {
  const site = siteOf(realm, building);
  const chain = await locationChain(site);
  const f = await scopeFixture(site, chain);
  assert.equal(f.scope.clientId, realm.client.id);
  assert.equal(f.scope.buildingId, building.id);
  return { scope: f.scope, chain };
}

/** Vendor + ACTIVE provider context + assignable crew with a real Lead. */
function crewAt(realm: Awaited<ReturnType<typeof realmFixture>>) {
  return crewFixture(siteOf(realm, realm.buildingA1));
}

/** ACTIVE crew assignment on the scope — the occupancy identifier source. */
async function assignCrew(
  scope: { id: string },
  crew: Awaited<ReturnType<typeof crewAt>>,
) {
  await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    adminUserId,
  );
  const row = (
    await q(
      `SELECT id FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 AND status = 'ACTIVE'`,
      [scope.id],
    )
  ).rows[0] as { id: string };
  return row.id;
}

/**
 * One FINAL_CHARGE_READY material execution line (quantity-consistent:
 * issued 6, used 5, returned 1 → final used 4) plus one ESTIMATE event,
 * so the Customer Care projection has real lines/events to protect.
 */
async function materialLineWithEvent(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  scope: { id: string; approvedQuotationVersionId: string },
) {
  const quotationLine = (
    await q(
      `SELECT id FROM handyman_quotation_lines
        WHERE quotation_version_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [scope.approvedQuotationVersionId],
    )
  ).rows[0] as { id: string };
  const lineId = randomUUID();
  await q(
    `INSERT INTO handyman_material_execution_lines
       (id, client_id, execution_scope_id, quotation_version_id,
        quotation_line_id, status, acquisition_mode, estimated_qty,
        approved_qty, issued_qty, purchased_qty, used_qty, returned_qty)
     VALUES ($1, $2, $3, $4, $5, 'FINAL_CHARGE_READY', 'ISSUED',
             6, 6, 6, 0, 5, 1)`,
    [lineId, realm.client.id, scope.id, scope.approvedQuotationVersionId,
      quotationLine.id],
  );
  const eventId = randomUUID();
  await q(
    `INSERT INTO handyman_material_execution_events
       (id, client_id, line_id, execution_scope_id, event_type,
        idempotency_key, actor_user_id)
     VALUES ($1, $2, $3, $4, 'ESTIMATE', $5, $6)`,
    [eventId, realm.client.id, lineId, scope.id, `k-${randomUUID()}`,
      adminUserId],
  );
  return { lineId, eventId };
}

/**
 * Authenticated actor holding exactly the given permission codes (the
 * read routes use `tenant_company.read`) plus the given explicit ACTIVE
 * building assignments.
 */
async function createScopedActor(
  buildingIds: readonly string[],
  permissions: readonly string[] = ['tenant_company.read'],
): Promise<{ token: string; userId: string }> {
  const tag = suffix();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `guard-${tag.toLowerCase()}@example.com`,
    displayName: 'Material/Availability Scope Guard Actor',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `GUARD_${tag}`,
    name: 'Material/Availability Scope Guard Actor',
  });
  for (const code of permissions) {
    const existing = await permissionRepository.findByCode(code);
    const permission =
      existing ??
      (await permissionService.createPermission({ code, name: code }));
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }

  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

/** Real Bearer session for the Crew Lead user of a crew fixture. */
async function leadSession(crew: Awaited<ReturnType<typeof crewAt>>) {
  const password = `LeadPass${randomUUID().slice(0, 6)}`;
  await credentialService.createInitialCredential({
    userId: crew.leadUser.id,
    password,
  });
  const login = await api().post('/api/v1/auth/login').send({
    email: crew.leadUser.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}

const careViewUrl = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/material-lines`;
const AVAILABILITY_URL = '/api/v1/handyman/provider-availability';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('CR-HM-SEC-02 PART 04 — material lines care view + provider availability exact-building scope guards', () => {
  it('A: authorized exact-building actor — both paths succeed (service + HTTP)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    const crew = await crewAt(realm);
    await assignCrew(scope, crew);
    const { lineId, eventId } = await materialLineWithEvent(realm, scope);
    const actor = await createScopedActor([realm.buildingA1.id]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );

    // D3 — service layer: the care view returns the line + event.
    const projection = await getHandymanMaterialLinesCustomerCareView(
      scope.id,
      actor.userId,
    );
    assert.equal(projection.executionScopeId, scope.id);
    assert.equal(projection.lines.length, 1);
    assert.equal(projection.lines[0].line.id, lineId);
    assert.equal(projection.lines[0].line.status, 'FINAL_CHARGE_READY');
    assert.equal(projection.lines[0].events.length, 1);
    assert.equal(projection.lines[0].events[0].id, eventId);
    assert.equal(projection.lines[0].finalUsedQty, 4);
    assert.equal(projection.totalFinalUsedQty, 4);

    // D3 — HTTP layer: 200 with the full projection.
    const careHttp = await api()
      .get(careViewUrl(scope.id))
      .set(bearer(actor.token));
    assert.equal(careHttp.status, 200, JSON.stringify(careHttp.body));
    assert.equal(careHttp.body.data.executionScopeId, scope.id);
    assert.equal(careHttp.body.data.lines.length, 1);
    assert.equal(careHttp.body.data.lines[0].id, lineId);
    assert.equal(careHttp.body.data.lines[0].events.length, 1);
    assert.equal(careHttp.body.data.lines[0].events[0].id, eventId);
    assert.equal(careHttp.body.data.lines[0].finalUsedQty, 4);
    assert.equal(careHttp.body.data.totalFinalUsedQty, 4);

    // D4 — service layer: the executionScopeId availability query
    // projects the crew occupancy identifiers.
    const items = await listHandymanProviderAvailability(
      { executionScopeId: scope.id },
      actor.userId,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].crews.length, 1);
    assert.equal(items[0].crews[0].id, crew.crew.id);
    assert.equal(items[0].crews[0].hasActiveAssignment, true);
    assert.ok(
      items[0].crews[0].occupancy.activeExecutionScopeIds.includes(scope.id),
    );

    // D4 — HTTP layer: 200 with the same projection.
    const availHttp = await api()
      .get(AVAILABILITY_URL)
      .query({ executionScopeId: scope.id })
      .set(bearer(actor.token));
    assert.equal(availHttp.status, 200, JSON.stringify(availHttp.body));
    assert.equal(availHttp.body.data.length, 1);
    assert.equal(availHttp.body.data[0].crews.length, 1);
    assert.ok(
      availHttp.body.data[0].crews[0].occupancy.activeExecutionScopeIds
        .includes(scope.id),
    );
  });

  it('B: same-client sibling actor — denied 403 with zero projection (service + HTTP)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    const crew = await crewAt(realm);
    const assignmentId = await assignCrew(scope, crew);
    const { lineId, eventId } = await materialLineWithEvent(realm, scope);

    // Assignment ONLY to the sibling building of the SAME client: the
    // exact same-client shortcut BE-02G forbids.
    const sibling = await createScopedActor([realm.buildingA2.id]);
    assert.equal(
      await contextAccessService.canAccessClient(sibling.userId, realm.client.id),
      true,
    );

    // D3 — service layer: denied.
    await assert.rejects(
      getHandymanMaterialLinesCustomerCareView(scope.id, sibling.userId),
      assertBuildingDenied,
    );
    // D3 — HTTP layer: 403, and ZERO projection — no lines, no events,
    // no identifiers anywhere in the response.
    const careHttp = await api()
      .get(careViewUrl(scope.id))
      .set(bearer(sibling.token));
    assertDenied403(careHttp, 'sibling care view');
    assert.ok(!careHttp.text.includes(lineId), 'no material line may leak');
    assert.ok(!careHttp.text.includes(eventId), 'no event may leak');
    assert.equal(careHttp.body.lines, undefined);

    // D4 — service layer: denied.
    await assert.rejects(
      listHandymanProviderAvailability(
        { executionScopeId: scope.id },
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    // D4 — HTTP layer: 403, and ZERO occupancy identifiers.
    const availHttp = await api()
      .get(AVAILABILITY_URL)
      .query({ executionScopeId: scope.id })
      .set(bearer(sibling.token));
    assertDenied403(availHttp, 'sibling availability');
    assert.ok(
      !availHttp.text.includes(assignmentId),
      'no occupancy identifier may leak',
    );
    assert.ok(!availHttp.text.includes(crew.crew.id), 'no crew id may leak');
  });

  it('C: permission-only and cross-client actors — denied on both paths', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    await crewAt(realm);

    // Permission-only actor: read permission, ZERO assignments.
    const permissionOnly = await createScopedActor([]);
    assert.equal(
      await contextAccessService.canAccessClient(
        permissionOnly.userId,
        realm.client.id,
      ),
      false,
    );
    await assert.rejects(
      getHandymanMaterialLinesCustomerCareView(scope.id, permissionOnly.userId),
      assertBuildingDenied,
    );
    await assert.rejects(
      listHandymanProviderAvailability(
        { executionScopeId: scope.id },
        permissionOnly.userId,
      ),
      assertBuildingDenied,
    );
    const careDenied = await api()
      .get(careViewUrl(scope.id))
      .set(bearer(permissionOnly.token));
    assertDenied403(careDenied, 'permission-only care view');
    const availDenied = await api()
      .get(AVAILABILITY_URL)
      .query({ executionScopeId: scope.id })
      .set(bearer(permissionOnly.token));
    assertDenied403(availDenied, 'permission-only availability');

    // Cross-client actor: assigned only to the other client's building.
    const crossClient = await createScopedActor([realm.otherBuilding.id]);
    assert.equal(
      await contextAccessService.canAccessClient(
        crossClient.userId,
        realm.client.id,
      ),
      false,
    );
    await assert.rejects(
      getHandymanMaterialLinesCustomerCareView(scope.id, crossClient.userId),
      assertBuildingDenied,
    );
    await assert.rejects(
      listHandymanProviderAvailability(
        { executionScopeId: scope.id },
        crossClient.userId,
      ),
      assertBuildingDenied,
    );
    const careDeniedCross = await api()
      .get(careViewUrl(scope.id))
      .set(bearer(crossClient.token));
    assertDenied403(careDeniedCross, 'cross-client care view');
    const availDeniedCross = await api()
      .get(AVAILABILITY_URL)
      .query({ executionScopeId: scope.id })
      .set(bearer(crossClient.token));
    assertDenied403(availDeniedCross, 'cross-client availability');
  });

  it('D: actor explicitly assigned to BOTH client buildings — allowed (the only policy-supported client-wide reach)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    const crew = await crewAt(realm);
    await assignCrew(scope, crew);
    const { lineId } = await materialLineWithEvent(realm, scope);
    const actor = await createScopedActor([
      realm.buildingA1.id,
      realm.buildingA2.id,
    ]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );
    // A single FOREIGN-building assignment does not satisfy the guard.
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.otherBuilding.id,
      }),
      false,
    );

    const projection = await getHandymanMaterialLinesCustomerCareView(
      scope.id,
      actor.userId,
    );
    assert.equal(projection.lines.length, 1);
    assert.equal(projection.lines[0].line.id, lineId);
    const items = await listHandymanProviderAvailability(
      { executionScopeId: scope.id },
      actor.userId,
    );
    assert.equal(items.length, 1);

    const careHttp = await api()
      .get(careViewUrl(scope.id))
      .set(bearer(actor.token));
    assert.equal(careHttp.status, 200, JSON.stringify(careHttp.body));
    const availHttp = await api()
      .get(AVAILABILITY_URL)
      .query({ executionScopeId: scope.id })
      .set(bearer(actor.token));
    assert.equal(availHttp.status, 200, JSON.stringify(availHttp.body));
  });

  it('E: provider availability clientId-only path — contractual client-level behavior retained', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    const crew = await crewAt(realm);
    await assignCrew(scope, crew);

    // The SAME sibling actor that D4 denies on the executionScopeId
    // path holds NO assignment to the scope's building at all — yet
    // the contractual clientId-only query stays client-scoped and
    // succeeds (D4 must not leak the building requirement onto it).
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Service layer: client-level resolution unchanged.
    const items = await listHandymanProviderAvailability(
      { clientId: realm.client.id },
      sibling.userId,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].crews.length, 1);
    assert.equal(items[0].crews[0].id, crew.crew.id);

    // HTTP layer: 200 with the client-wide projection.
    const availHttp = await api()
      .get(AVAILABILITY_URL)
      .query({ clientId: realm.client.id })
      .set(bearer(sibling.token));
    assert.equal(availHttp.status, 200, JSON.stringify(availHttp.body));
    assert.equal(availHttp.body.data.length, 1);
    assert.equal(availHttp.body.data[0].crews.length, 1);

    // Contrast pin: the SAME actor on the executionScopeId path is
    // denied — the carve-out is exactly the scope-resolving query.
    await assert.rejects(
      listHandymanProviderAvailability(
        { executionScopeId: scope.id },
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    const denied = await api()
      .get(AVAILABILITY_URL)
      .query({ executionScopeId: scope.id })
      .set(bearer(sibling.token));
    assertDenied403(denied, 'sibling availability (executionScopeId)');
  });

  it('F: Customer Care reads remain Lead-free; material commands and Crew Lead enforcement unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    const crew = await crewAt(realm);
    await assignCrew(scope, crew);
    const { lineId } = await materialLineWithEvent(realm, scope);

    // A MATERIAL quotation line on the APPROVED version for the
    // estimate command (the care-view line above uses the LABOR line).
    const uomRow = (
      await q(
        `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
        [realm.client.id],
      )
    ).rows[0] as { id: string };
    const materialQuotationLineId = randomUUID();
    await q(
      `INSERT INTO handyman_quotation_lines
         (id, quotation_version_id, line_type, description, quantity,
          uom_id, final_quoted_unit_amount, line_total, currency,
          source_item_id, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Sealant cartridge',
               $3::numeric, $4::uuid, 30,
               ROUND($3::numeric * 30, 2), 'IDR', NULL, $5::uuid)`,
      [materialQuotationLineId, scope.approvedQuotationVersionId, 6,
        uomRow.id, adminUserId],
    );

    // The exact-building Customer Care actor is NOT the Crew Lead,
    // holds no Lead binding — and the read still succeeds: the D3
    // guard preserves Customer Care authority separation (Lead-free).
    const careActor = await createScopedActor([realm.buildingA1.id]);
    assert.notEqual(careActor.userId, crew.leadUser.id);
    const projection = await getHandymanMaterialLinesCustomerCareView(
      scope.id,
      careActor.userId,
    );
    assert.equal(projection.lines.length, 1);
    assert.equal(projection.lines[0].line.id, lineId);

    // Material commands: Lead enforcement UNCHANGED — the authorized
    // NON-Lead actor is refused by the Lead preamble (service + HTTP).
    await assert.rejects(
      estimateHandymanMaterialExecutionLine(
        {
          executionScopeId: scope.id,
          quotationVersionId: scope.approvedQuotationVersionId,
          quotationLineId: materialQuotationLineId,
          estimatedQty: 6,
          idempotencyKey: `k-${randomUUID()}`,
        },
        careActor.userId,
      ),
      (error: unknown) => {
        assert.equal(
          errorCode(error),
          'HANDYMAN_MATERIAL_EXECUTION_NOT_AUTHORIZED',
        );
        assert.equal(errorStatus(error), 403);
        return true;
      },
    );
    const deniedEstimate = await api()
      .post(careViewUrl(scope.id) + '/estimate')
      .set(bearer(careActor.token))
      .send({
        quotationVersionId: scope.approvedQuotationVersionId,
        quotationLineId: materialQuotationLineId,
        estimatedQty: 6,
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(deniedEstimate.status, 403, JSON.stringify(deniedEstimate.body));
    assert.equal(
      deniedEstimate.body?.error?.code,
      'HANDYMAN_MATERIAL_EXECUTION_NOT_AUTHORIZED',
    );

    // The CURRENT Crew Lead (real session, ACTIVE assignment at the
    // scope's building) still commands: ESTIMATE succeeds — the D3/D4
    // read guards did not disturb the command authority.
    const leadToken = await leadSession(crew);
    const estimate = await api()
      .post(careViewUrl(scope.id) + '/estimate')
      .set(bearer(leadToken))
      .send({
        quotationVersionId: scope.approvedQuotationVersionId,
        quotationLineId: materialQuotationLineId,
        estimatedQty: 6,
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
    assert.equal(estimate.body.data.line.status, 'ESTIMATED');
    assert.equal(estimate.body.data.line.approvedQty, 6);
  });

  it('G: regression detection — the old client-only wall passes for the sibling, the guard denies', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    await crewAt(realm);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Vulnerability-detection pin: with the guards reverted to the OLD
    // client-level `canAccessClient` walls (the pre-D3/D4 posture), the
    // sibling actor would be WRONGLY ALLOWED and cases A/B/E would
    // fail. The pin proves the suite detects the vulnerability rather
    // than passing vacuously.
    assert.equal(
      await contextAccessService.canAccessClient(
        sibling.userId,
        realm.client.id,
      ),
      true,
      'old client-level wall must pass for the sibling actor (regression pin)',
    );
    // Service-level pin of the production mechanism: the guard itself
    // rejects the sibling for the scope's building.
    await assert.rejects(
      assertBuildingScopedResourceAccess(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      assertBuildingDenied,
    );
    assert.equal(
      await canAccessBuildingScopedResource(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
      'BE-02G guard must deny the sibling actor',
    );

    // Both D3 and D4 deny the sibling at the service layer.
    await assert.rejects(
      getHandymanMaterialLinesCustomerCareView(scope.id, sibling.userId),
      assertBuildingDenied,
    );
    await assert.rejects(
      listHandymanProviderAvailability(
        { executionScopeId: scope.id },
        sibling.userId,
      ),
      assertBuildingDenied,
    );
  });

  it('H: 404 precedence (unknown scope before any denial) and zero projection keys on denial', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeAt(realm, realm.buildingA1);
    const { lineId, eventId } = await materialLineWithEvent(realm, scope);
    const actor = await createScopedActor([realm.buildingA1.id]);
    const unknownScopeId = randomUUID();

    // 404 BEFORE 403 on both paths: a well-formed but unknown scope id
    // is a not-found for an otherwise-authorized actor — the D3/D4
    // guards sit after the scope load, exactly like the old walls.
    await assert.rejects(
      getHandymanMaterialLinesCustomerCareView(unknownScopeId, actor.userId),
      assertScopeNotFound,
    );
    await assert.rejects(
      listHandymanProviderAvailability(
        { executionScopeId: unknownScopeId },
        actor.userId,
      ),
      assertScopeNotFound,
    );
    const care404 = await api()
      .get(careViewUrl(unknownScopeId))
      .set(bearer(actor.token));
    assert.equal(care404.status, 404, JSON.stringify(care404.body));
    assert.equal(
      care404.body?.error?.code,
      'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );
    const avail404 = await api()
      .get(AVAILABILITY_URL)
      .query({ executionScopeId: unknownScopeId })
      .set(bearer(actor.token));
    assert.equal(avail404.status, 404, JSON.stringify(avail404.body));
    assert.equal(
      avail404.body?.error?.code,
      'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );

    // Zero projection keys on denial: the sibling's denied care-view
    // response carries no projection payload at all, while the
    // authorized actor on the SAME scope receives the full projection
    // (the denial is scope, not data absence).
    const sibling = await createScopedActor([realm.buildingA2.id]);
    const denied = await api()
      .get(careViewUrl(scope.id))
      .set(bearer(sibling.token));
    assertDenied403(denied, 'sibling care view');
    assert.equal(denied.body.lines, undefined);
    assert.equal(denied.body.totalFinalUsedQty, undefined);
    assert.ok(!denied.text.includes(lineId));
    assert.ok(!denied.text.includes(eventId));

    const allowed = await api()
      .get(careViewUrl(scope.id))
      .set(bearer(actor.token));
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.lines.length, 1);
    assert.equal(allowed.body.data.lines[0].id, lineId);
  });
});
