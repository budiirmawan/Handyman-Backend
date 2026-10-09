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
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { floorService } from '../src/modules/floors';
import {
  getHandymanRequestReferral,
  recordHandymanReferral,
} from '../src/modules/handyman-requests';
import {
  handymanServiceRequestDiagnosisService,
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
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 06J (ULTRA-LIGHT) — focused tests for the REFERRAL
 * READ/WRITE authorization boundary in
 * handyman-request-referral.service.ts: `recordHandymanReferral`
 * (WRITE; route POST /handyman/requests/:id/referral, `manage`) and
 * `getHandymanRequestReferral` (READ; route GET
 * /handyman/requests/:id/referral, `read`). Both serve LOCAL staff
 * actors (`req.auth.userId` from local sessions); no BM SSO / customer
 * principal reaches either command.
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. Both walls now enforce the established
 * BE-02G guard on the persisted request's authoritative
 * {clientId, buildingId} (the request row carries the
 * server-derived building_id, migration 0378), replacing the
 * client-level canAccessClient shortcuts in each wall's ORIGINAL
 * position: the WRITE wall after the request lock/404, before
 * eligibility, the uniqueness pre-check and mutation; the READ wall
 * after the request 404, before the referral lookup.
 *
 * PART 07C-2F (audit 07C-1, class C): the READ's actor is now
 * MANDATORY — the actor-less bypass is removed; every read enforces
 * the BE-02G exact-building authorization against the persisted
 * request's authoritative {clientId, buildingId}, failing closed for
 * a missing/invalid actor at validation. The HTTP contract is
 * unchanged (the controller already passes req.auth.userId).
 *
 * Denial vocabulary unchanged: 403 BUILDING_ACCESS_DENIED — the
 * previous client-wall thrower is the guard's OWN thrower, so the
 * assert form is byte-identical. Error precedence unchanged
 * (request 404 precedes the access wall). Referral eligibility (the
 * immutable diagnosis classification is the ONLY source), the
 * derived referral type, uniqueness (one referral per request),
 * idempotency/uniqueness-violation mapping, the FROZEN F6 audit
 * journal, transaction boundaries, and response shapes are
 * preserved. Request intake/list/detail, SLA, warranty, finance, and
 * unrelated modules are NOT touched.
 *
 * Two focused cases:
 *   1. authorized exact-building referral WRITE + READ — a local
 *      staff actor with an explicit ACTIVE assignment to the
 *      request's exact Building records the referral and reads it
 *      back; the one-referral-per-request uniqueness is preserved;
 *   2. same-client sibling building — a staff actor holding ONLY the
 *      same-Client SIBLING Building is denied 403 on BOTH commands
 *      (including the duplicate/replay-shaped write) with ZERO
 *      mutation and no referral data leakage.
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
  await pool.query(`TRUNCATE handyman_request_referrals,
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
 * request's building, A2 = the same-client sibling) + the minimal
 * referral-eligible chain: attribution context, service entry,
 * request, triage -> DIAGNOSIS, and a SPECIALIST-scope diagnosis
 * (ELECTRICAL — referral-eligible classification SPECIALIST_REQUIRED,
 * request status READY_FOR_NEXT_STEP).
 */
async function referralFixture() {
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
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest({
      channelAttributionId: attribution.id,
      serviceCatalogId: service.id,
    }, adminUserId);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  const specialist = await handymanDisciplineRepository
    .findDisciplineByCode(undefined, 'ELECTRICAL');
  if (!specialist) throw new Error('ELECTRICAL discipline seed missing');
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId: specialist.id,
      diagnosis: 'Specialist electrical work required.',
    },
    adminUserId,
  );
  return { client, buildingA1, buildingA2, request };
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

const referralRows = async (requestId: string) => {
  const result = await q(
    `SELECT id, referral_type, building_id, referred_by_user_id
      FROM handyman_request_referrals WHERE handyman_request_id = $1`,
    [requestId],
  );
  return result.rows as Array<{
    id: string;
    referral_type: string;
    building_id: string;
    referred_by_user_id: string;
  }>;
};

describe('CR-HM-SEC-01 PART 06J — referral read/write building-scope guard', () => {
  it('1: authorized exact-building referral WRITE + READ — staff actor (exact Building) records and reads back; uniqueness preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await referralFixture();
    const staff = await staffActor(f.buildingA1.id);

    // WRITE — the derived referral handoff fact.
    const recorded = await recordHandymanReferral({
      handymanRequestId: f.request.id,
      referralNote: 'Refer to electrical specialist.',
    }, staff);
    assert.equal(recorded.handymanRequestId, f.request.id);
    assert.equal(recorded.clientId, f.client.id);
    assert.equal(recorded.buildingId, f.buildingA1.id);
    assert.equal(recorded.referralType, 'SPECIALIST');
    assert.equal(recorded.disciplineCode, 'ELECTRICAL');
    assert.equal(recorded.referredByUserId, staff);

    // READ — the bounded immutable record.
    const read = await getHandymanRequestReferral(f.request.id, staff);
    assert.equal(read.id, recorded.id);
    assert.equal(read.referralType, 'SPECIALIST');
    assert.equal(read.referralNote, 'Refer to electrical specialist.');

    // Uniqueness: a second referral for the SAME request is the
    // bounded already-referred conflict (never a second record).
    await assert.rejects(
      recordHandymanReferral({
        handymanRequestId: f.request.id,
        referralNote: 'Duplicate referral attempt.',
      }, staff),
      (error: unknown) => {
        assert.equal(
          errorCode(error),
          'HANDYMAN_SERVICE_REQUEST_ALREADY_REFERRED',
        );
        return true;
      },
    );

    // Exact persistence: exactly one referral row.
    const rows = await referralRows(f.request.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, recorded.id);
    assert.equal(rows[0].building_id, f.buildingA1.id);
  });

  it('2: same-client sibling building — WRITE and READ denied 403 (incl. duplicate/replay-shaped write) with ZERO mutation and no leak', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await referralFixture();
    const staff = await staffActor(f.buildingA1.id);
    // Seed a lawful referral so the denial is provably the access
    // wall, not an empty record.
    const seeded = await recordHandymanReferral({
      handymanRequestId: f.request.id,
      referralNote: 'Seeded referral.',
    }, staff);
    assert.equal(seeded.referralType, 'SPECIALIST');

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const sibling = await staffActor(f.buildingA2.id);

    // WRITE — denied after the request lock/404, before eligibility,
    // the uniqueness pre-check and mutation.
    await assertBuildingDenied(recordHandymanReferral({
      handymanRequestId: f.request.id,
      referralNote: 'Sibling referral attempt.',
    }, sibling));

    // DUPLICATE/REPLAY-shaped write — still denied 403 at the wall:
    // the uniqueness already-referred path is never reached.
    await assertBuildingDenied(recordHandymanReferral({
      handymanRequestId: f.request.id,
      referralNote: 'Sibling duplicate attempt.',
    }, sibling));

    // READ — denied after the request 404, before the referral
    // lookup (no referral data leaks).
    await assertBuildingDenied(
      getHandymanRequestReferral(f.request.id, sibling),
    );

    // Zero mutation: exactly the seeded referral row, unchanged.
    const rows = await referralRows(f.request.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, seeded.id);
    assert.equal(rows[0].referred_by_user_id, staff);
  });

  it('3: missing/invalid actor — denied at validation with ZERO data leakage (actor is mandatory, no bypass)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await referralFixture();
    const staff = await staffActor(f.buildingA1.id);
    // Seed a lawful referral so the denial is provably the actor
    // requirement, not an empty record.
    const seeded = await recordHandymanReferral({
      handymanRequestId: f.request.id,
      referralNote: 'Seeded referral.',
    }, staff);

    // PART 07C-2F (audit 07C-1, class C): the actor is MANDATORY.
    // A missing/invalid actor fails closed at validation — before the
    // request lookup and before any referral data is returned.
    await assert.rejects(
      getHandymanRequestReferral(f.request.id, ''),
      (error: unknown) => {
        assert.equal(errorCode(error), 'VALIDATION_ERROR');
        assert.equal(errorStatus(error), 400);
        return true;
      },
    );
    await assert.rejects(
      getHandymanRequestReferral(f.request.id, 'not-a-uuid'),
      (error: unknown) => {
        assert.equal(errorCode(error), 'VALIDATION_ERROR');
        assert.equal(errorStatus(error), 400);
        return true;
      },
    );

    // Zero data leakage: the seeded referral row is intact and no
    // referral data was returned through either denial.
    const rows = await referralRows(f.request.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, seeded.id);

    // Route-compatible actor usage still works (the controller's
    // exact call shape: requestId + req.auth.userId).
    const read = await getHandymanRequestReferral(f.request.id, staff);
    assert.equal(read.id, seeded.id);
    assert.equal(read.referralNote, 'Seeded referral.');
  });
});
