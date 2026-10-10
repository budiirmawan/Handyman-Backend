import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-03 PART 05A — focused HTTP/OpenAPI tests for the Handyman
 * lifecycle surface (triaged/inspected/diagnosed/referred records).
 *
 * Ten cases prove the 8-operation surface works end to end, RBAC split
 * (manage for mutations / read for reads), smuggled actor/context keys can
 * never become authority, derived classification and referral type/target
 * are never caller-controlled, and the documented OpenAPI surface matches
 * the runtime contract exactly.
 */

const HM = '/api/v1/handyman/requests';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';
// W02 PART 04A: POST triage requires handyman.operations.request.triage (not granted to admin).
let triageToken = '';
let triageUserId = '';
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
  token = admin.token;
  adminUserId = admin.userId;
  triageToken = await createSessionWithPermissions([
    { code: 'handyman.operations.request.triage', name: 'Triage Handyman Operations Requests' },
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);
  triageUserId = (await pool!.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'scoped-%' ORDER BY created_at DESC LIMIT 1`,
  )).rows[0].id;
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

const auth = () => ({ Authorization: `Bearer ${token}` });
const triageAuth = () => ({ Authorization: `Bearer ${triageToken}` });

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

async function requestFixture() {
  const f = await attributedFixture();
  // Operations triage operator needs the Building assignment (building scope).
  await buildingAssignmentService.createAssignment(triageUserId, { buildingId: f.building.id }, adminUserId);
  const service = await serviceEntry(f.client.id);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  return { ...f, service, request };
}

/** Request carried through triage (+inspection) to DIAGNOSIS state. */
async function diagnosisStateFixture(opts: { viaInspection?: boolean } = {}) {
  const f = await requestFixture();
  if (opts.viaInspection) {
    await api().post(`${HM}/${f.request.id}/triage`).set(triageAuth()).send({
      disposition: 'INSPECTION_REQUIRED',
      note: 'Site check needed.',
    });
    await api().post(`${HM}/${f.request.id}/inspection`).set(auth()).send({
      result: 'INSPECTED',
      notes: 'Inspected on site.',
    });
  } else {
    await api().post(`${HM}/${f.request.id}/triage`).set(triageAuth()).send({
      disposition: 'DIAGNOSIS',
      note: 'Direct to diagnosis.',
    });
  }
  const rows = await q(
    'SELECT status FROM handyman_service_requests WHERE id = $1',
    [f.request.id],
  );
  assert.equal(rows.rows[0].status, 'DIAGNOSIS');
  return f;
}

async function postDiagnosisStep(requestId: string, disciplineId: string) {
  return api().post(`${HM}/${requestId}/diagnosis`).set(auth()).send({
    disciplineId,
    diagnosis: 'Determined on review of the fault.',
  });
}

describe('CR-HM-03 PART 05A — HTTP + OpenAPI lifecycle surface', () => {
  it('1: POST /triage + GET /triage (201 + 200, canonical errors)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const res = await api().post(`${HM}/${f.request.id}/triage`)
      .set(triageAuth())
      .send({ disposition: 'INSPECTION_REQUIRED', note: 'Needs site visit.' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.handymanRequestId, f.request.id);
    assert.equal(res.body.data.triageDisposition, 'INSPECTION_REQUIRED');
    assert.equal(res.body.data.actorUserId, triageUserId);
    assert.equal(res.body.data.clientId, f.client.id);

    const read = await api().get(`${HM}/${f.request.id}/triage`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, res.body.data.id);

    // repeat → 400: the PART 01 source-state gate (NOT_INTAKE) fires
    // before the duplicate pre-check on sequential attempts
    const wrongState = await api().post(`${HM}/${f.request.id}/triage`)
      .set(triageAuth())
      .send({ disposition: 'DIAGNOSIS', note: 'Second triage attempt.' });
    assert.equal(wrongState.status, 400);
    assert.equal(
      wrongState.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_NOT_INTAKE',
    );
    // non-uuid path → 400
    const badId = await api().get(`${HM}/not-a-uuid/triage`).set(auth());
    assert.equal(badId.status, 400);
    // unknown request → 404
    const missing = await api().post(`${HM}/${randomUUID()}/triage`)
      .set(triageAuth())
      .send({ disposition: 'DIAGNOSIS', note: 'No such request.' });
    assert.equal(missing.status, 404);
  });

  it('2: POST /inspection + GET /inspection (INSPECTION_REQUIRED → DIAGNOSIS)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    await api().post(`${HM}/${f.request.id}/triage`).set(triageAuth()).send({
      disposition: 'INSPECTION_REQUIRED',
      note: 'Site check needed.',
    });
    const res = await api().post(`${HM}/${f.request.id}/inspection`)
      .set(auth())
      .send({ result: 'INSPECTED', notes: 'Pipe joint cracked.' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.inspectionResult, 'INSPECTED');
    assert.equal(res.body.data.inspectedByUserId, adminUserId);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'DIAGNOSIS');
    const read = await api().get(`${HM}/${f.request.id}/inspection`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, res.body.data.id);
    // evidence freeze stays: POSTing an intensity token never appears in record
    assert.deepEqual(
      Object.keys(res.body.data).sort(),
      ['buildingId', 'channelAttributionId', 'clientId', 'handymanRequestId',
       'id', 'inspectedAt', 'inspectedByUserId', 'inspectionNotes',
       'inspectionResult'],
    );
  });

  it('3: POST /diagnosis + GET /diagnosis (discipline anchor; derived SPECIALIST)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosisStateFixture();
    const res = await postDiagnosisStep(f.request.id, disciplineIds.ELECTRICAL);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.scopeClassification, 'SPECIALIST_REQUIRED');
    assert.equal(res.body.data.disciplineCode, 'ELECTRICAL');
    assert.equal(res.body.data.diagnosedByUserId, adminUserId);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
    const read = await api().get(`${HM}/${f.request.id}/diagnosis`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, res.body.data.id);
  });

  it('4: POST /referral + GET /referral (FM boundary → OUT_OF_SCOPE; state stays REFERRED)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosisStateFixture({ viaInspection: true });
    await postDiagnosisStep(f.request.id, disciplineIds.FM_COMMON_BUILDING);
    const res = await api().post(`${HM}/${f.request.id}/referral`)
      .set(auth())
      .send({ note: 'Common riser fault; out of Handyman scope.' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.referralType, 'OUT_OF_SCOPE');
    assert.equal(res.body.data.disciplineCode, 'FM_COMMON_BUILDING');
    assert.equal(res.body.data.referredByUserId, adminUserId);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'REFERRED');
    const read = await api().get(`${HM}/${f.request.id}/referral`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, res.body.data.id);
  });

  it('5: mutations require manage authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const plain = await createPlainSession();
    const readOnly = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    // W02 PART 04A: PLATFORM_ADMIN holds tenant_company.manage but is NOT granted triage.
    const adminTriage = await api().post(`${HM}/${f.request.id}/triage`)
      .set(auth())
      .send({ disposition: 'DIAGNOSIS', note: 'Admin without triage authority.' });
    assert.equal(adminTriage.status, 403, JSON.stringify(adminTriage.body));
    const anonTriage = await api().post(`${HM}/${f.request.id}/triage`)
      .send({ disposition: 'DIAGNOSIS', note: 'No auth.' });
    assert.equal(anonTriage.status, 401);
    const plainTriage = await api().post(`${HM}/${f.request.id}/triage`)
      .set({ Authorization: `Bearer ${plain}` })
      .send({ disposition: 'DIAGNOSIS', note: 'No roles.' });
    assert.equal(plainTriage.status, 403);
    const readOnlyTriage = await api().post(`${HM}/${f.request.id}/triage`)
      .set({ Authorization: `Bearer ${readOnly}` })
      .send({ disposition: 'DIAGNOSIS', note: 'Read only attempt.' });
    assert.equal(readOnlyTriage.status, 403);
    const preRows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(preRows.rows[0].status, 'INTAKE');
  });

  it('6: reads require read authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    await api().post(`${HM}/${f.request.id}/triage`).set(triageAuth())
      .send({ disposition: 'DIAGNOSIS', note: 'For read test.' });
    const anon = await api().get(`${HM}/${f.request.id}/triage`);
    assert.equal(anon.status, 401);
    const plain = await api()
      .get(`${HM}/${f.request.id}/triage`)
      .set({ Authorization: `Bearer ${await createPlainSession()}` });
    assert.equal(plain.status, 403);
    const ok = await api().get(`${HM}/${f.request.id}/triage`).set(auth());
    assert.equal(ok.status, 200);
  });

  it('7: body actor/context smuggling can never become authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const other = await attributedFixture();
    const res = await api().post(`${HM}/${f.request.id}/triage`)
      .set(triageAuth())
      .send({
        disposition: 'DIAGNOSIS',
        note: 'Smuggled authority keys must be ignored.',
        actorUserId: f.linkedUser.id,
        triagedByUserId: f.linkedUser.id,
        clientId: other.client.id,
        buildingId: other.building.id,
        spaceId: other.space.id,
        tenantCompanyId: other.company.id,
        channelAttributionId: other.attribution.id,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.actorUserId, triageUserId);
    assert.notEqual(res.body.data.actorUserId, f.linkedUser.id);
    assert.equal(res.body.data.clientId, f.client.id);
    assert.equal(res.body.data.buildingId, f.building.id);
    assert.equal(res.body.data.channelAttributionId, f.attribution.id);
  });

  it('8: diagnosis classification cannot be caller-controlled', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosisStateFixture();
    const res = await api().post(`${HM}/${f.request.id}/diagnosis`)
      .set(auth())
      .send({
        disciplineId: disciplineIds.ELECTRICAL,
        diagnosis: 'Caller tries to force general scope.',
        scopeClassification: 'GENERAL_HANDYMAN',
        scope_class: 'GENERAL_HANDYMAN',
        status: 'READY_FOR_NEXT_STEP',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.scopeClassification, 'SPECIALIST_REQUIRED');
    assert.equal(res.body.data.disciplineCode, 'ELECTRICAL');
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('9: referral type/target cannot be caller-controlled', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await diagnosisStateFixture();
    await postDiagnosisStep(f.request.id, disciplineIds.AC);
    const res = await api().post(`${HM}/${f.request.id}/referral`)
      .set(auth())
      .send({
        note: 'Caller tries to hijack the referral edges.',
        referralType: 'OUT_OF_SCOPE',
        targetDisciplineId: disciplineIds.FM_COMMON_BUILDING,
        disciplineCode: 'FM_COMMON_BUILDING',
        referredByUserId: f.linkedUser.id,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.referralType, 'SPECIALIST');
    assert.equal(res.body.data.handymanDisciplineId, disciplineIds.AC);
    assert.equal(res.body.data.disciplineCode, 'AC');
    assert.equal(res.body.data.referredByUserId, adminUserId);
  });

  it('10: OpenAPI contains the CR-HM-03 4-step operations (8 ops) and only verified later-CR lifecycle paths', async (t) => {
    if (!requireDatabase(t)) return;
    const doc = parseYaml(readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    )) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const lifecycles = [
      'triage',
      'inspection',
      'diagnosis',
      'referral',
    ] as const;
    const operationIds: string[] = [];
    for (const step of lifecycles) {
      const path = `/handyman/requests/{handymanRequestId}/${step}`;
      const ops = doc.paths[path];
      assert.ok(ops, `missing path ${path}`);
      assert.deepEqual(
        Object.keys(ops).filter((k) => k === 'get' || k === 'post').sort(),
        ['get', 'post'],
        `${path} must expose exactly GET + POST operations`,
      );
      operationIds.push(
        String(ops.post.operationId),
        String(ops.get.operationId),
      );
    }
    // exactly 8 operations, matching the runtime controller names
    assert.deepEqual(operationIds.sort(), [
      'getHandymanRequestDiagnosis',
      'getHandymanRequestInspection',
      'getHandymanRequestReferral',
      'getHandymanRequestTriage',
      'recordHandymanDiagnosis',
      'recordHandymanInspection',
      'recordHandymanReferral',
      'recordHandymanRequestTriage',
    ]);
    // W01 PART 03: no UNDOCUMENTED lifecycle endpoints. The set below is the
    // verified CR-owned surface (each path has a matching route in
    // src/modules/handyman-*-api). CR-HM-03 owns the four lifecycle steps;
    // readiness (CR-HM-05/06/07) and quotation (CR-HM-08) are later CRs.
    const lifecyclePaths = Object.keys(doc.paths).filter((p) =>
      p.startsWith('/handyman/requests/{handymanRequestId}/') &&
      p !== '/handyman/requests/{handymanRequestId}/intake-evidence',
    );
    assert.deepEqual(
      lifecyclePaths.sort(),
      [
        ...lifecycles.map((step) => `/handyman/requests/{handymanRequestId}/${step}`),
        '/handyman/requests/{handymanRequestId}/scheduling-readiness',
        '/handyman/requests/{handymanRequestId}/scheduling-readiness/history',
        '/handyman/requests/{handymanRequestId}/unit-access-readiness',
        '/handyman/requests/{handymanRequestId}/unit-access-readiness/history',
        '/handyman/requests/{handymanRequestId}/permit-readiness',
        '/handyman/requests/{handymanRequestId}/permit-readiness/history',
        '/handyman/requests/{handymanRequestId}/quotation',
        '/handyman/requests/{handymanRequestId}/quotation/presented',
      ].sort(),
    );
    // caller-authoritative fields must not exist in request schemas
    const schemas = doc.components.schemas;
    for (const [name, keys] of [
      ['RecordHandymanTriageRequest', ['disposition', 'note']],
      ['RecordHandymanInspectionRequest', ['result', 'notes']],
      [
        'RecordHandymanDiagnosisRequest',
        ['disciplineId', 'diagnosis', 'recommendedServiceCatalogId'],
      ],
      ['RecordHandymanReferralRequest', ['note']],
    ] as const) {
      assert.ok(schemas[name], `missing request schema ${name}`);
      assert.deepEqual(
        Object.keys(
          (schemas[name].properties as Record<string, unknown>) ?? {},
        ).sort(),
        [...keys].sort(),
        `${name} properties`,
      );
    }
    assert.match(
      String(schemas.HandymanScopeClassification?.description ?? ''),
      /derived/i,
    );
    assert.match(
      String(schemas.HandymanReferralType?.description ?? ''),
      /derived/i,
    );
  });
});
