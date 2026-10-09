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
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestReferralService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import type { CreateHandymanReferralInput } from '../src/modules/handyman-requests';
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
 * CR-HM-03 PART 04 — focused tests for the Handyman referral record.
 *
 * Ten cases prove: eligibility/type/target derive ONLY from the PART 03
 * diagnosis (caller can never override); ELECTRICAL/AC stay targets only;
 * FM_COMMON_BUILDING yields the OUT_OF_SCOPE boundary referral with zero
 * FM consequence; request state is preserved (READY_FOR_NEXT_STEP /
 * terminal REFERRED); duplicate/race → 409; atomic referral+journal;
 * immutability; and zero provider/crew/work-order/quotation side effects.
 */

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
  await pool.query(`TRUNCATE handyman_request_referrals,
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

async function serviceEntry(clientId: string) {
  return serviceCatalogService.createServiceCatalogEntry({
    clientId,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
}

/** Request carried to the diagnosis outcome for `disciplineCode`. */
async function diagnosedFixture(disciplineCode: string) {
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
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  const diagnosis = await handymanServiceRequestDiagnosisService
    .recordHandymanDiagnosis(
      {
        handymanRequestId: request.id,
        disciplineId: disciplineIds[disciplineCode],
        diagnosis: `Diagnosed as ${disciplineCode}.`,
      },
      adminUserId,
    );
  const rows = await q(
    'SELECT status FROM handyman_service_requests WHERE id = $1',
    [request.id],
  );
  return { ...f, service, request, diagnosis, status: rows.rows[0].status as string };
}

describe('CR-HM-03 PART 04 — referral record', () => {
  it('1: SPECIALIST_REQUIRED diagnosis → SPECIALIST referral (type derived, state preserved)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('ELECTRICAL');
    assert.equal(f.status, 'READY_FOR_NEXT_STEP');
    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        {
          handymanRequestId: f.request.id,
          referralNote: 'Certified electrician must handle breaker fault.',
        },
        adminUserId,
      );
    assert.equal(referral.referralType, 'SPECIALIST');
    assert.equal(referral.handymanDiagnosisId, f.diagnosis.id);
    assert.equal(referral.referredByUserId, adminUserId);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('2: ELECTRICAL target derived correctly', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('ELECTRICAL');
    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        { handymanRequestId: f.request.id, referralNote: 'Electrical specialist.' },
        adminUserId,
      );
    assert.equal(referral.handymanDisciplineId, disciplineIds.ELECTRICAL);
    assert.equal(referral.disciplineCode, 'ELECTRICAL');
    assert.equal(
      referral.handymanDisciplineId,
      f.diagnosis.handymanDisciplineId,
    );
  });

  it('3: AC target derived correctly', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('AC');
    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        { handymanRequestId: f.request.id, referralNote: 'AC specialist needed.' },
        adminUserId,
      );
    assert.equal(referral.referralType, 'SPECIALIST');
    assert.equal(referral.handymanDisciplineId, disciplineIds.AC);
    assert.equal(referral.disciplineCode, 'AC');
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('4: OUT_OF_HANDYMAN_SCOPE → OUT_OF_SCOPE referral, request stays REFERRED', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('FM_COMMON_BUILDING');
    assert.equal(f.status, 'REFERRED');
    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        {
          handymanRequestId: f.request.id,
          referralNote: 'Common-building riser fault; FM scope.',
        },
        adminUserId,
      );
    assert.equal(referral.referralType, 'OUT_OF_SCOPE');
    assert.equal(referral.handymanDisciplineId, disciplineIds.FM_COMMON_BUILDING);
    assert.equal(referral.disciplineCode, 'FM_COMMON_BUILDING');
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'REFERRED');
  });

  it('5: GENERAL_HANDYMAN diagnosis is not referral-eligible', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('SIMPLE_PLUMBING');
    const before = await tableCount('handyman_request_referrals');
    await assert.rejects(
      handymanServiceRequestReferralService.recordHandymanReferral(
        { handymanRequestId: f.request.id, referralNote: 'Not eligible.' },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_REFERRAL_NOT_ELIGIBLE',
    );
    assert.equal(await tableCount('handyman_request_referrals'), before);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('6: caller cannot override referralType / target / context / actor', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('ELECTRICAL');
    const other = await attributedFixture();
    const smuggled = {
      handymanRequestId: f.request.id,
      referralNote: 'Smuggled referral fields must be ignored.',
      referralType: 'OUT_OF_SCOPE',
      handymanDisciplineId: disciplineIds.FM_COMMON_BUILDING,
      disciplineCode: 'FM_COMMON_BUILDING',
      clientId: other.client.id,
      buildingId: other.building.id,
      channelAttributionId: other.attribution.id,
      referredByUserId: f.linkedUser.id,
    } as unknown as CreateHandymanReferralInput;
    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(smuggled, adminUserId);
    assert.equal(referral.referralType, 'SPECIALIST');
    assert.equal(referral.handymanDisciplineId, disciplineIds.ELECTRICAL);
    assert.equal(referral.disciplineCode, 'ELECTRICAL');
    assert.equal(referral.clientId, f.client.id);
    assert.equal(referral.buildingId, f.building.id);
    assert.equal(referral.channelAttributionId, f.attribution.id);
    assert.equal(referral.referredByUserId, adminUserId);
    assert.notEqual(referral.referredByUserId, f.linkedUser.id);
  });

  it('7: duplicate referral is rejected with the race-safe 409 contract', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('AC');
    await handymanServiceRequestReferralService.recordHandymanReferral(
      { handymanRequestId: f.request.id, referralNote: 'First referral.' },
      adminUserId,
    );
    const before = await tableCount('handyman_request_referrals');
    await assert.rejects(
      handymanServiceRequestReferralService.recordHandymanReferral(
        { handymanRequestId: f.request.id, referralNote: 'Second must conflict.' },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SERVICE_REQUEST_ALREADY_REFERRED',
    );
    assert.equal(await tableCount('handyman_request_referrals'), before);
  });

  it('8: referral + journal commit atomically with derived metadata only', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('ELECTRICAL');
    const beforeRef = await tableCount('handyman_request_referrals');
    const beforeEvents = await tableCount('operational_events');
    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        { handymanRequestId: f.request.id, referralNote: 'Atomic referral.' },
        adminUserId,
      );
    assert.equal(await tableCount('handyman_request_referrals'), beforeRef + 1);
    assert.equal(await tableCount('operational_events'), beforeEvents + 1);
    const journal = await q(
      `SELECT event_type, actor_user_id, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1
        ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
      [f.request.id],
    );
    assert.equal(journal.rows[0].event_type, 'HANDYMAN_REFERRAL_CREATED');
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
    assert.deepEqual(journal.rows[0].metadata, {
      referralId: referral.id,
      diagnosisId: f.diagnosis.id,
      referralType: 'SPECIALIST',
      disciplineCode: 'ELECTRICAL',
    });
    const rows = await q(
      'SELECT status, updated_at FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('9: referral record is append-only — UPDATE/DELETE are refused', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosedFixture('AC');
    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        { handymanRequestId: f.request.id, referralNote: 'Immutable referral.' },
        adminUserId,
      );
    assert.deepEqual(
      Object.keys(handymanServiceRequestReferralService).sort(),
      ['getHandymanRequestReferral', 'recordHandymanReferral'],
    );
    await assert.rejects(
      q(
        "UPDATE handyman_request_referrals SET referral_note = 'tampered' WHERE id = $1",
        [referral.id],
      ),
    );
    await assert.rejects(
      q('DELETE FROM handyman_request_referrals WHERE id = $1', [referral.id]),
    );
    const readBack = await handymanServiceRequestReferralService
      .getHandymanRequestReferral(f.request.id, adminUserId);
    assert.equal(readBack.referralNote, 'Immutable referral.');
  });

  it('10: zero provider/vendor-assignment/FM/work-order/quotation side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const tables = [
      'tenant_service_requests',
      'work_requests',
      'work_orders',
      'vendor_quotations',
      'evidence_submissions',
      'workforce_skill_assignments',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (n) => [n, await tableCount(n)])),
    );
    for (const code of ['ELECTRICAL', 'FM_COMMON_BUILDING']) {
      const f = await diagnosedFixture(code);
      await handymanServiceRequestReferralService.recordHandymanReferral(
        { handymanRequestId: f.request.id, referralNote: `${code} handoff.` },
        adminUserId,
      );
    }
    for (const name of tables) {
      assert.equal(await tableCount(name), before[name], `${name} unchanged`);
    }
  });
});
