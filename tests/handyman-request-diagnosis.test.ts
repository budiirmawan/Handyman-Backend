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
import type { CreateHandymanDiagnosisInput } from '../src/modules/handyman-requests';
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
 * CR-HM-03 PART 03 — focused tests for diagnosis + F9 scope authority.
 *
 * Ten cases prove: classification is SERVER-DERIVED from
 * discipline.scopeClass (caller can never override); both DIAGNOSIS paths
 * (direct triage / inspected) work; GENERAL → READY_FOR_NEXT_STEP;
 * SPECIALIST → READY_FOR_NEXT_STEP with zero referral/provider side
 * effects; FM_COMMON_BUILDING fails closed to OUT_OF_HANDYMAN_SCOPE /
 * terminal REFERRED with zero FM consequence; the catalogue recommendation
 * requires ACTIVE + same-Client + F9 association; registry discipline must
 * exist + be ACTIVE; atomic record+projection+journal; immutability; and
 * that free-text service_catalog.category is never consulted as authority.
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

async function inspectedDiagnosisFixture() {
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

describe('CR-HM-03 PART 03 — diagnosis + F9 scope authority', () => {
  it('1: GENERAL_HANDYMAN discipline → classification GENERAL_HANDYMAN → READY_FOR_NEXT_STEP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await directDiagnosisFixture();
    const record = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: disciplineIds.GENERAL_HANDYMAN,
          diagnosis: 'Cracked toilet seat hinge; simple fix.',
        },
        adminUserId,
      );
    assert.equal(record.scopeClassification, 'GENERAL_HANDYMAN');
    assert.equal(record.handymanDisciplineId, disciplineIds.GENERAL_HANDYMAN);
    assert.equal(record.disciplineCode, 'GENERAL_HANDYMAN');
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('2: direct-triage DIAGNOSIS path works (GENERAL via SIMPLE_PLUMBING)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await directDiagnosisFixture();
    const record = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: disciplineIds.SIMPLE_PLUMBING,
          diagnosis: 'Leaking P-trap under sink; simple replacement.',
        },
        adminUserId,
      );
    assert.equal(record.scopeClassification, 'GENERAL_HANDYMAN');
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('3: inspected DIAGNOSIS path works (request reached DIAGNOSIS via inspection)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectedDiagnosisFixture();
    const record = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: disciplineIds.MINOR_CIVIL,
          diagnosis: 'Hairline paint crack on wall after inspection.',
        },
        adminUserId,
      );
    assert.equal(record.scopeClassification, 'GENERAL_HANDYMAN');
    const inspections = await q(
      'SELECT count(*)::int AS n FROM handyman_request_inspections WHERE handyman_request_id = $1',
      [f.request.id],
    );
    assert.equal(inspections.rows[0].n, 1);
    const statuses = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(statuses.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('4: ELECTRICAL and AC → SPECIALIST_REQUIRED → READY_FOR_NEXT_STEP (target only)', async (t) => {
    if (!requireDatabase(t)) return;
    for (const code of ['ELECTRICAL', 'AC']) {
      const f = await directDiagnosisFixture();
      const record = await handymanServiceRequestDiagnosisService
        .recordHandymanDiagnosis(
          {
            handymanRequestId: f.request.id,
            disciplineId: disciplineIds[code],
            diagnosis: `${code} fault identified beyond handyman remit.`,
          },
          adminUserId,
        );
      assert.equal(record.scopeClassification, 'SPECIALIST_REQUIRED');
      assert.equal(record.disciplineCode, code);
      const rows = await q(
        'SELECT status FROM handyman_service_requests WHERE id = $1',
        [f.request.id],
      );
      assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
    }
  });

  it('5: FM_COMMON_BUILDING → OUT_OF_HANDYMAN_SCOPE → terminal REFERRED, zero FM consequences', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await directDiagnosisFixture();
    const before = {
      tenant_service_requests: await tableCount('tenant_service_requests'),
      work_requests: await tableCount('work_requests'),
      work_orders: await tableCount('work_orders'),
      vendor_quotations: await tableCount('vendor_quotations'),
    };
    const record = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: disciplineIds.FM_COMMON_BUILDING,
          diagnosis: 'Fault located on building common riser main feed.',
        },
        adminUserId,
      );
    assert.equal(record.scopeClassification, 'OUT_OF_HANDYMAN_SCOPE');
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'REFERRED');
    // F5: a referral never spawns FM/work-order/quotation/provider artifacts
    for (const [name, count] of Object.entries(before)) {
      assert.equal(await tableCount(name), count, `${name} unchanged`);
    }
    // REFERRED is terminal: any further diagnosis is rejected fail-closed
    await assert.rejects(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: disciplineIds.GENERAL_HANDYMAN,
          diagnosis: 'Terminal follow-up attempt.',
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_SERVICE_REQUEST_NOT_IN_DIAGNOSIS',
    );
  });

  it('6: caller cannot override the derived classification', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await directDiagnosisFixture();
    const smuggled = {
      handymanRequestId: f.request.id,
      disciplineId: disciplineIds.ELECTRICAL,
      diagnosis: 'Input tries to force general scope.',
      scopeClassification: 'GENERAL_HANDYMAN',
      scope_class: 'GENERAL_HANDYMAN',
      status: 'READY_FOR_NEXT_STEP',
      diagnosedByUserId: f.linkedUser.id,
    } as unknown as CreateHandymanDiagnosisInput;
    const record = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(smuggled, adminUserId);
    assert.equal(record.scopeClassification, 'SPECIALIST_REQUIRED');
    assert.equal(record.diagnosedByUserId, adminUserId);
    assert.notEqual(record.diagnosedByUserId, f.linkedUser.id);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('7: recommended catalogue anchor must be ACTIVE + same-Client + F9-associated with the discipline', async (t) => {
    if (!requireDatabase(t)) return;
    // (a) valid anchor: entry associated with the SAME discipline. The
    //     free-text category contains an FM hint — proving category text is
    //     never consulted as scope authority.
    const fA = await directDiagnosisFixture();
    const recommended = await serviceEntry(fA.client.id, 'FM_COMMON_LIKE_TEXT');
    await handymanDisciplineService.associateHandymanDisciplineToServiceCatalog(
      {
        serviceCatalogId: recommended.id,
        handymanDisciplineId: disciplineIds.FURNITURE,
      },
      adminUserId,
    );
    const recordA = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: fA.request.id,
          disciplineId: disciplineIds.FURNITURE,
          diagnosis: 'Loose wardrobe hinge.',
          recommendedServiceCatalogId: recommended.id,
        },
        adminUserId,
      );
    assert.equal(recordA?.scopeClassification, 'GENERAL_HANDYMAN');
    assert.equal(recordA?.recommendedServiceCatalogId, recommended.id);

    // (b) not associated → rejected
    const fB = await directDiagnosisFixture();
    const unassociated = await serviceEntry(fB.client.id);
    await assert.rejects(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: fB.request.id,
          disciplineId: disciplineIds.FURNITURE,
          diagnosis: 'Unassociated recommendation attempt.',
          recommendedServiceCatalogId: unassociated.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_DIAGNOSIS_RECOMMENDATION_INVALID',
    );

    // (c) associated with a DIFFERENT discipline → rejected
    const fC = await directDiagnosisFixture();
    const otherDisc = await serviceEntry(fC.client.id);
    await handymanDisciplineService.associateHandymanDisciplineToServiceCatalog(
      {
        serviceCatalogId: otherDisc.id,
        handymanDisciplineId: disciplineIds.ELECTRICAL,
      },
      adminUserId,
    );
    await assert.rejects(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: fC.request.id,
          disciplineId: disciplineIds.FURNITURE,
          diagnosis: 'Wrong-discipline association attempt.',
          recommendedServiceCatalogId: otherDisc.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_DIAGNOSIS_RECOMMENDATION_INVALID',
    );

    // (d) cross-Client → rejected
    const fD = await directDiagnosisFixture();
    const foreign = await attributedFixture();
    const foreignEntry = await serviceEntry(foreign.client.id);
    await handymanDisciplineService.associateHandymanDisciplineToServiceCatalog(
      {
        serviceCatalogId: foreignEntry.id,
        handymanDisciplineId: disciplineIds.FURNITURE,
      },
      adminUserId,
    );
    await assert.rejects(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: fD.request.id,
          disciplineId: disciplineIds.FURNITURE,
          diagnosis: 'Cross-client recommendation attempt.',
          recommendedServiceCatalogId: foreignEntry.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_DIAGNOSIS_RECOMMENDATION_INVALID',
    );

    // (e) INACTIVE → rejected
    const fE = await directDiagnosisFixture();
    const inactiveEntry = await serviceEntry(fE.client.id);
    await handymanDisciplineService.associateHandymanDisciplineToServiceCatalog(
      {
        serviceCatalogId: inactiveEntry.id,
        handymanDisciplineId: disciplineIds.FURNITURE,
      },
      adminUserId,
    );
    await q(
      "UPDATE service_catalog SET status = 'INACTIVE' WHERE id = $1",
      [inactiveEntry.id],
    );
    await assert.rejects(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: fE.request.id,
          disciplineId: disciplineIds.FURNITURE,
          diagnosis: 'Inactive recommendation attempt.',
          recommendedServiceCatalogId: inactiveEntry.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_DIAGNOSIS_RECOMMENDATION_INVALID',
    );
  });

  it('8: invalid or INACTIVE discipline is rejected (F9 authority gate)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await directDiagnosisFixture();
    await assert.rejects(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: randomUUID(),
          diagnosis: 'Unknown discipline attempt.',
        },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_DISCIPLINE_INVALID',
    );
    const inactive = await q(
      `INSERT INTO handyman_disciplines (id, code, name, scope_class, status)
       VALUES ($1, 'RETIRED_DISCIPLINE', 'Retired', 'GENERAL_HANDYMAN', 'INACTIVE')
       RETURNING id`,
      [randomUUID()],
    );
    await assert.rejects(
      handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: inactive.rows[0].id,
          diagnosis: 'Inactive discipline attempt.',
        },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_DISCIPLINE_INVALID',
    );
    // fail-closed: nothing persisted, request still in DIAGNOSIS
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'DIAGNOSIS');
    const diags = await q(
      'SELECT count(*)::int AS n FROM handyman_request_diagnoses WHERE handyman_request_id = $1',
      [f.request.id],
    );
    assert.equal(diags.rows[0].n, 0);
  });

  it('9: diagnosis + status + journal commit atomically; record is append-only', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await directDiagnosisFixture();
    const beforeDiags = await tableCount('handyman_request_diagnoses');
    const beforeEvents = await tableCount('operational_events');
    const record = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: disciplineIds.ELECTRICAL,
          diagnosis: 'Breaker fault; specialist needed.',
        },
        adminUserId,
      );
    assert.equal(await tableCount('handyman_request_diagnoses'), beforeDiags + 1);
    assert.equal(await tableCount('operational_events'), beforeEvents + 1);
    const journal = await q(
      `SELECT event_type, actor_user_id, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1
        ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
      [f.request.id],
    );
    assert.equal(journal.rows[0].event_type, 'HANDYMAN_DIAGNOSIS_RECORDED');
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
    assert.deepEqual(
      journal.rows[0].metadata,
      {
        diagnosisId: record.id,
        disciplineCode: 'ELECTRICAL',
        scopeClassification: 'SPECIALIST_REQUIRED',
      },
    );
    // append-only: trigger refuses UPDATE/DELETE; record reads back intact
    assert.deepEqual(
      Object.keys(handymanServiceRequestDiagnosisService).sort(),
      ['getHandymanRequestDiagnosis', 'recordHandymanDiagnosis'],
    );
    await assert.rejects(
      q(
        "UPDATE handyman_request_diagnoses SET diagnosis = 'tampered' WHERE id = $1",
        [record.id],
      ),
    );
    await assert.rejects(
      q('DELETE FROM handyman_request_diagnoses WHERE id = $1', [record.id]),
    );
    const readBack = await handymanServiceRequestDiagnosisService
      .getHandymanRequestDiagnosis(f.request.id);
    assert.equal(readBack.diagnosis, 'Breaker fault; specialist needed.');
  });

  it('10: no referral/provider/FM/quotation/work-order side effects across all classes', async (t) => {
    if (!requireDatabase(t)) return;
    const tables = [
      'tenant_service_requests',
      'work_requests',
      'work_orders',
      'vendor_quotations',
      'evidence_submissions',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (n) => [n, await tableCount(n)])),
    );
    for (const code of ['SIMPLE_PLUMBING', 'ELECTRICAL', 'FM_COMMON_BUILDING']) {
      const f = await directDiagnosisFixture();
      await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: disciplineIds[code],
          diagnosis: `Side-effect-free ${code} outcome.`,
        },
        adminUserId,
      );
    }
    for (const name of tables) {
      assert.equal(await tableCount(name), before[name], `${name} unchanged`);
    }
  });
});
