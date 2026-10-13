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
import {
  canAccessBuildingScopedResource,
  contextAccessService,
} from '../src/modules/context-access';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { createHandymanQuotation } from '../src/modules/handyman-quotations';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 01 — focused tests for the reusable BE-02G
 * building-scoped resource guard (`assertBuildingScopedResourceAccess`)
 * as applied to Handyman QUOTATION CREATION first
 * (`POST /handyman/requests/:handymanRequestId/quotation` /
 * `createHandymanQuotation`).
 *
 * Authority established before coding (see the PART 01 decision report):
 *   - BE-02G (`docs/data-isolation.md`) is the sole user data-scope
 *     authority: access = authentication + permission + explicit ACTIVE
 *     `user_building_assignment` to the EXACT Building. "No same-Client
 *     shortcut."
 *   - `user_building_assignments` (migration 0019) is the only user
 *     data-scope grant; assignment never implies sibling/global access.
 *   - Roles carry RBAC capabilities only (no scope dimension); there is
 *     NO user↔client assignment; even the PLATFORM_ADMIN operational
 *     exception stays inside its assigned Buildings. NO existing
 *     role/scope contract grants any local User client-wide data access,
 *     so `canAccessClient` (a derived reachability convenience reserved
 *     for Client-scoped-only tables) was never client-wide privilege.
 *   - The parent `handyman_service_requests` row is building-scoped
 *     (`building_id UUID NOT NULL`, server-derived).
 *
 * Therefore quotation creation now requires the actor's explicit ACTIVE
 * assignment to the REQUEST'S OWN Building. Four focused cases:
 *   1. authorized building (explicit assignment to the request's
 *      building) → allowed;
 *   2. same-client SIBLING building (assignment only to a sibling
 *      building of the same client/property) → 403, zero mutation —
 *      the exact same-client shortcut BE-02G forbids;
 *   3. no-client access (assignment under a DIFFERENT client, and an
 *      actor with the manage permission but ZERO assignments) → 403,
 *      zero mutation;
 *   4. explicitly authorized client-wide reach — the only policy-
 *      supported shape: explicit ACTIVE assignments to EVERY building of
 *      the client → allowed (no client-wide privilege is inferred from
 *      any single assignment, and none is invented).
 *
 * Scope discipline: ONLY quotation creation is guarded in this PART;
 * revision/read/line/lifecycle/decision/execution-scope paths keep their
 * existing client-level wall and are listed as remaining affected
 * endpoints in the decision report.
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
  await pool.query(`TRUNCATE handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
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

const quotationRows = async (requestId: string): Promise<number> =>
  (
    await q(
      'SELECT count(*)::int AS n FROM handyman_quotations WHERE handyman_request_id = $1',
      [requestId],
    )
  ).rows[0].n as number;

const versionRows = async (requestId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n
         FROM handyman_quotation_versions v
         JOIN handyman_quotations q ON q.id = v.quotation_id
        WHERE q.handyman_request_id = $1`,
      [requestId],
    )
  ).rows[0].n as number;

const quotationEventRows = async (requestId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE metadata->>'handymanRequestId' = $1`,
      [requestId],
    )
  ).rows[0].n as number;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * request's building, A2 = the same-client sibling), plus a second
 * client with one building for the no-client case.
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
    name: 'Building A1 (request building)',
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
  return {
    client,
    property,
    buildingA1,
    buildingA2,
    otherClient,
    otherProperty,
    otherBuilding,
  };
}

/** Tenant context + immutable attribution + request at building A1. */
async function requestFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: realm.buildingA1.id,
  });
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
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Tenant Company',
    },
    adminUserId,
  );
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.buildingA1.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant Requester',
      email: 'requester@tenant.example.com',
      userId: linkedUser.id,
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
      spaceId: space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM${suffix()}`,
      name: 'Handyman Service',
      category: 'FM_HINT_TEXT',
    },
    adminUserId,
  );
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
      diagnosis: 'Fixture diagnosis for scope-guard tests.',
    },
    adminUserId,
  );
  return { attribution, service, request };
}

/**
 * Authenticated actor holding exactly `tenant_company.manage` (the
 * quotation route's mutation permission) plus the given explicit ACTIVE
 * building assignments. Returns the session token AND the user id (the
 * shared helper only returns the token; the guard needs the id to hold
 * assignments).
 */
async function createScopedActor(
  buildingIds: readonly string[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `guard-${tag.toLowerCase()}@example.com`,
    displayName: 'Scope Guard Actor',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `GUARD_${tag}`,
    name: 'Quotation Manage Actor',
  });
  // Reuse the seeded permission when present (createPermission rejects
  // duplicate codes); the admin bootstrap in `before` already ensured it.
  const existingPermission = await permissionRepository.findByCode(
    'tenant_company.manage',
  );
  const permission =
    existingPermission ??
    (await permissionService.createPermission({
      code: 'tenant_company.manage',
      name: 'Manage Tenant Companies',
    }));
  await permissionService.assignPermissionToRole(role.id, permission.id);
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

const CREATE = (requestId: string) =>
  `/api/v1/handyman/requests/${requestId}/quotation`;

describe('CR-HM-SEC-01 PART 01 — quotation creation building-scope guard', () => {
  it('1: authorized building — explicit assignment to the request building is allowed', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([realm.buildingA1.id]);

    // Reusable guard predicate: the request's own building satisfies it.
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );

    // Service layer: creation succeeds, version 1 DRAFT.
    const bundle = await createHandymanQuotation(
      { handymanRequestId: request.id },
      actor.userId,
    );
    assert.equal(bundle.quotation.handymanRequestId, request.id);
    assert.equal(bundle.quotation.clientId, realm.client.id);
    assert.equal(bundle.quotation.createdByUserId, actor.userId);
    assert.equal(bundle.versions.length, 1);
    assert.equal(bundle.versions[0].versionNumber, 1);
    assert.equal(bundle.versions[0].status, 'DRAFT');
    assert.equal(await quotationRows(request.id), 1);
    assert.equal(await versionRows(request.id), 1);
    assert.equal(await quotationEventRows(request.id), 1);

    // HTTP layer: 201 on the mutation route (fresh request in a fresh
    // realm; the actor is explicitly assigned to that realm's building).
    const realm2 = await realmFixture();
    const second = await requestFixture(realm2);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: realm2.buildingA1.id,
    });
    const res = await api()
      .post(CREATE(second.request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send({});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.quotation.handymanRequestId, second.request.id);
    assert.equal(res.body.data.versions[0].status, 'DRAFT');
  });

  it('2: same-client sibling building denied — 403 and zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    // Assignment ONLY to the sibling building of the SAME client/property:
    // the exact same-client shortcut BE-02G forbids.
    const actor = await createScopedActor([realm.buildingA2.id]);

    // The old client-level wall passed here; the guard must not.
    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      true,
    );
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
    );

    const before = {
      quotations: await quotationRows(request.id),
      versions: await versionRows(request.id),
      events: await quotationEventRows(request.id),
    };
    assert.deepEqual(before, { quotations: 0, versions: 0, events: 0 });

    // Service layer: 403 BUILDING_ACCESS_DENIED.
    await assert.rejects(
      createHandymanQuotation({ handymanRequestId: request.id }, actor.userId),
      (error: unknown) => {
        assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
        assert.equal(errorStatus(error), 403);
        return true;
      },
    );

    // HTTP layer: 403 with the controlled code.
    const res = await api()
      .post(CREATE(request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send({});
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');

    // No mutation on denial.
    assert.equal(await quotationRows(request.id), 0);
    assert.equal(await versionRows(request.id), 0);
    assert.equal(await quotationEventRows(request.id), 0);
  });

  it('3: no-client access denied — other-client assignment and zero assignments both 403, zero mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);

    // (a) Explicit assignment under a DIFFERENT client.
    const otherClientActor = await createScopedActor([realm.otherBuilding.id]);
    assert.equal(
      await contextAccessService.canAccessClient(
        otherClientActor.userId,
        realm.client.id,
      ),
      false,
    );
    await assert.rejects(
      createHandymanQuotation(
        { handymanRequestId: request.id },
        otherClientActor.userId,
      ),
      (error: unknown) => {
        assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
        assert.equal(errorStatus(error), 403);
        return true;
      },
    );
    const resOther = await api()
      .post(CREATE(request.id))
      .set('Authorization', `Bearer ${otherClientActor.token}`)
      .send({});
    assert.equal(resOther.status, 403, JSON.stringify(resOther.body));
    assert.equal(resOther.body.error.code, 'BUILDING_ACCESS_DENIED');

    // (b) The manage permission alone (ZERO assignments) is NOT data scope.
    const permissionOnlyActor = await createScopedActor([]);
    await assert.rejects(
      createHandymanQuotation(
        { handymanRequestId: request.id },
        permissionOnlyActor.userId,
      ),
      (error: unknown) => {
        assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
        assert.equal(errorStatus(error), 403);
        return true;
      },
    );
    const resNone = await api()
      .post(CREATE(request.id))
      .set('Authorization', `Bearer ${permissionOnlyActor.token}`)
      .send({});
    assert.equal(resNone.status, 403, JSON.stringify(resNone.body));
    assert.equal(resNone.body.error.code, 'BUILDING_ACCESS_DENIED');

    // No mutation on either denial.
    assert.equal(await quotationRows(request.id), 0);
    assert.equal(await versionRows(request.id), 0);
    assert.equal(await quotationEventRows(request.id), 0);
  });

  it('4: explicitly authorized client-wide reach preserved — explicit assignments to every client building allowed', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    // The ONLY policy-supported shape of client-wide reach: an explicit
    // ACTIVE assignment to EVERY building of the client. No role/scope
    // contract grants client-wide access independent of per-building
    // assignments, so nothing broader is preserved or invented.
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
    // A single sibling assignment alone still must NOT satisfy the guard.
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.otherBuilding.id,
      }),
      false,
    );

    const bundle = await createHandymanQuotation(
      { handymanRequestId: request.id },
      actor.userId,
    );
    assert.equal(bundle.quotation.handymanRequestId, request.id);
    assert.equal(bundle.versions[0].versionNumber, 1);
    assert.equal(bundle.versions[0].status, 'DRAFT');

    const realm2 = await realmFixture();
    const second = await requestFixture(realm2);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: realm2.buildingA1.id,
    });
    const res = await api()
      .post(CREATE(second.request.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send({});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await quotationRows(second.request.id), 1);
  });
});
