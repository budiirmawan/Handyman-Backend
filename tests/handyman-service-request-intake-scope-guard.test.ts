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
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  createHandymanServiceRequest,
} from '../src/modules/handyman-requests';
import { floorService } from '../src/modules/floors';
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
 * CR-HM-SEC-01 PART 06I (ULTRA-LIGHT) — focused tests for the INTAKE
 * REQUEST CREATE authorization boundary in
 * handyman-service-request.service.ts: `createHandymanServiceRequest`
 * — the LOCAL-USER create path (route POST /handyman/requests behind
 * local-session `auth` + `manage`; `req.auth.userId`). The BM Customer
 * Care exchange-token intake (`createCareHandymanServiceRequest`, route
 * POST /handyman/requests/care, no local-User middleware by contract)
 * is a SEPARATE function and is NOT in scope.
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The wall now enforces the established BE-02G
 * guard on the attribution's authoritative SERVER-RESOLVED
 * client/building pair (the attribution snapshot is the sole
 * authority; the create input never carries a buildingId —
 * caller-supplied context keys are ignored by contract), replacing
 * the client-level canAccessClient shortcut in the wall's ORIGINAL
 * position: after the attribution 404, before validation, the
 * one-request-per-attribution uniqueness check and insertion.
 *
 * Denial vocabulary unchanged: 403 BUILDING_ACCESS_DENIED — the
 * previous client-wall thrower is the guard's OWN thrower, so the
 * assert form is byte-identical. Error precedence unchanged
 * (attribution 404 precedes the access wall). Valid
 * customer/occupancy rules (attribution creation), request
 * lifecycle, audit, the immutable snapshot, and the
 * one-request-per-attribution uniqueness behavior are preserved.
 *
 * Actor contract (verified): LOCAL staff (local-User bearer session);
 * no BM SSO / customer principal reaches this create — those go
 * through the separate exchange-token care intake.
 *
 * Preserved and NOT touched: `createCareHandymanServiceRequest`
 * (exchange-token care intake), the bounded request LIST (legitimate
 * client-wide operation with the SQL per-row read-scope wall), the
 * already building-guarded detail read, and unrelated modules.
 *
 * Two focused cases:
 *   1. authorized exact-building staff create — a local staff actor
 *      with an explicit ACTIVE assignment to the attribution's exact
 *      Building creates the request (immutable snapshot), and the
 *      one-per-attribution uniqueness behavior is preserved;
 *   2. same-client sibling building — a staff actor holding ONLY the
 *      same-Client SIBLING Building is denied 403 on create AND on
 *      the uniqueness "replay" (the wall precedes the uniqueness
 *      check), with ZERO mutation.
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
  await pool.query(`TRUNCATE handyman_service_requests,
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

/** Asserts the exact BE-02G denial: 403 BUILDING_ACCESS_DENIED. */
async function assertBuildingDenied(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * attribution's building, A2 = the same-client sibling), a location
 * chain, and the minimal attribution context: tenant company, linked
 * customer user + PIC, space occupancy, building context, an
 * attribution on A1, and an ACTIVE client-scoped service entry.
 */
async function intakeFixture() {
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
    name: 'Building A1 (attribution building)',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1.id,
  });
  const floor = await floorService.createFloor({
    buildingId: buildingA1.id,
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
    buildingId: buildingA1.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: buildingA1.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: buildingA1.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: buildingA1.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'FM_HINT_TEXT',
  }, adminUserId);
  return {
    client, buildingA1, buildingA2, attribution, service,
  };
}

/** A plain local staff actor holding ONLY `buildingId`. */
async function staffActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `staff-${suffix().toLowerCase()}@example.com`,
    displayName: 'Local Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

const requestRows = async (attributionId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_service_requests
        WHERE channel_attribution_id = $1`,
      [attributionId],
    )
  ).rows[0].n as number;

describe('CR-HM-SEC-01 PART 06I — intake request create building-scope guard', () => {
  it('1: authorized exact-building staff create — immutable snapshot + one-per-attribution uniqueness preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await intakeFixture();
    const staff = await staffActor(f.buildingA1.id);

    // CREATE — the attribution snapshot is the sole authority.
    const created = await createHandymanServiceRequest({
      channelAttributionId: f.attribution.id,
      serviceCatalogId: f.service.id,
    }, staff);
    assert.equal(created.clientId, f.client.id);
    assert.equal(created.buildingId, f.buildingA1.id);
    assert.equal(created.channelAttributionId, f.attribution.id);
    assert.equal(created.serviceCatalogId, f.service.id);
    assert.equal(created.originChannel, 'BM_SUPER_APP');

    // One request per immutable attribution: a second create with the
    // SAME attribution is the bounded already-exists conflict (never a
    // second request) — uniqueness behavior preserved.
    await assert.rejects(
      createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: f.service.id,
      }, staff),
      (error: unknown) => {
        assert.equal(
          errorCode(error),
          'HANDYMAN_SERVICE_REQUEST_ALREADY_EXISTS',
        );
        return true;
      },
    );

    // Exact persistence: exactly one request for the attribution.
    assert.equal(await requestRows(f.attribution.id), 1);
  });

  it('2: same-client sibling building — create AND uniqueness-replay denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await intakeFixture();
    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const sibling = await staffActor(f.buildingA2.id);

    // CREATE — denied after the attribution 404, before validation,
    // the uniqueness check and insertion.
    await assertBuildingDenied(createHandymanServiceRequest({
      channelAttributionId: f.attribution.id,
      serviceCatalogId: f.service.id,
    }, sibling));

    // REPLAY-shaped denial: even a duplicate create with the SAME
    // attribution is denied 403 at the wall — the uniqueness
    // already-exists path is never reached, and no mutation occurs.
    await assertBuildingDenied(createHandymanServiceRequest({
      channelAttributionId: f.attribution.id,
      serviceCatalogId: f.service.id,
    }, sibling));

    // Zero mutation: no request row exists for the attribution.
    assert.equal(await requestRows(f.attribution.id), 0);
  });
});
