import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
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
  handymanRequestInspectionAssignmentService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';

/**
 * CR-HM-INSPECTION-01 PART B — focused versioned Field report + Operations
 * review tests (shared PostgreSQL instance; no embedded bootstrap here so the
 * suite can run beside the other Handyman fixtures).
 *
 * Scope: immutable versioning and the review decision only — dedicated
 * permissions, single writer, 0381 linkage, server-derived F9 classification,
 * technical-quantity estimates (no price vocabulary), pending/returned/
 * accepted chain rules, reviewer separation, one decision per version, one
 * accepted version per request, exact Building scope, database immutability
 * and the fact that no request status is invented.
 */

const HM = '/api/v1/handyman/requests';

let pool: Pool | null = null;
let database: DatabaseConfig | null = null;

let adminUserId = '';
let adminToken = '';
let opsUserId = '';
let opsToken = '';
let fieldUserId = '';
let fieldToken = '';
let reviewerUserId = '';
let reviewerToken = '';
let uomId = '';
let disciplineId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const config = await ensureDatabase();
  assert.ok(config, 'Inspection report tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_request_inspection_report_reviews,
    handyman_request_inspection_report_estimates,
    handyman_request_inspection_reports,
    handyman_request_inspection_assignments,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_service_variants, service_catalog, units_of_measure,
    operational_events, tenant_service_requests,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;
  const ops = await scopedUser([
    { code: 'handyman.operations.inspection.assign', name: 'Assign Field Inspectors' },
    { code: 'handyman.operations.request.read', name: 'Read Operations Queue' },
  ]);
  opsUserId = ops.userId;
  opsToken = ops.token;
  const field = await scopedUser([
    { code: 'handyman.field.inspection.report.submit', name: 'Submit Field Reports' },
  ]);
  fieldUserId = field.userId;
  fieldToken = field.token;
  const reviewer = await scopedUser([
    { code: 'handyman.operations.inspection.report.review', name: 'Review Field Reports' },
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);
  reviewerUserId = reviewer.userId;
  reviewerToken = reviewer.token;
  const discipline = await handymanDisciplineRepository
    .findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  if (!discipline) throw new Error('F9 discipline seed missing');
  disciplineId = discipline.id;
  database = config;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

async function ensureDatabase(): Promise<DatabaseConfig | null> {
  const module = await import('./helpers/postgres');
  return module.ensureTestDatabase();
}

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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const fieldAuth = () => auth(fieldToken);
const reviewAuth = () => auth(reviewerToken);

/** Local user with exactly the given codes (no default grant exists). */
async function scopedUser(
  codes: readonly { code: string; name: string }[],
): Promise<{ userId: string; token: string }> {
  const id = suffix();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `scoped-${id.toLowerCase()}@example.com`,
    displayName: 'Scoped User',
  });
  const { credentialService } = await import('../src/modules/auth');
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `SCOPED_${id}`,
    name: 'Scoped Role',
  });
  for (const permission of codes) {
    const existing = await permissionRepository.findByCode(permission.code);
    const permissionId = existing
      ? existing.id
      : (await permissionService.createPermission({
        code: permission.code,
        name: permission.name,
        status: 'ACTIVE',
      })).id;
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

/**
 * Full fixture: realm, tenant attribution, INSPECTION_REQUIRED request,
 * assignment for the Field user, the recorded 0381 inspection and a
 * Client-scoped unit of measure.
 */
async function inspectionReadyFixture(
  options: { inspector?: { token: string; userId: string } } = {},
) {
  const inspector = options.inspector ?? { token: fieldToken, userId: fieldUserId };
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
  // Admin realm scope is required from the first tenant-context write on.
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
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  // Building scope for the fixture actors (the reviewer gets it too).
  for (const userId of [
    ...new Set([fieldUserId, reviewerUserId, inspector.userId]),
  ]) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    }, adminUserId);
  }
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: 'Site check needed.',
    },
    adminUserId,
  );
  await handymanRequestInspectionAssignmentService
    .assignHandymanInspectionField(
      { handymanRequestId: request.id, assignedFieldUserId: inspector.userId },
      adminUserId,
    );
  const inspection = await api()
    .post(`${HM}/${request.id}/inspection`)
    .set(auth(inspector.token))
    .send({ result: 'INSPECTED', notes: 'Inspected on site.' });
  assert.equal(inspection.status, 201, JSON.stringify(inspection.body));
  const uom = await q(
    `INSERT INTO units_of_measure
       (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Hours', 'h', 'TIME')
     RETURNING id`,
    [randomUUID(), client.id, `UOM_${suffix()}`],
  );
  return {
    client,
    building,
    company,
    request,
    inspectionId: inspection.body.data.id as string,
    uomId: uom.rows[0].id as string,
  };
}

function reportBody(
  fixture: { uomId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    disciplineId,
    technicalFindings: 'Cracked pipe joint under the sink trap.',
    proposedDiagnosis: 'Replace the joint and seal the trap.',
    estimates: [
      {
        lineType: 'LABOR',
        description: 'Plumber hours',
        quantity: 2,
        uomId: fixture.uomId,
      },
      {
        lineType: 'MATERIAL',
        description: 'PVC joint',
        quantity: 1,
        uomId: fixture.uomId,
      },
    ],
    ...overrides,
  };
}

async function submitReport(
  requestId: string,
  body: unknown,
  token = fieldToken,
) {
  return api()
    .post(`${HM}/${requestId}/inspection-reports`)
    .set(auth(token))
    .send(body);
}

async function reviewReport(
  requestId: string,
  reportId: string,
  body: unknown,
  token = reviewerToken,
) {
  return api()
    .post(`${HM}/${requestId}/inspection-reports/${reportId}/review`)
    .set(auth(token))
    .send(body);
}

describe('CR-HM-INSPECTION-01 PART B — versioned Field reports + Operations review', () => {
  it('1: submission requires the dedicated Field authority and the active assignment', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    // tenant_company.manage (admin) is not the Field authority.
    const denied = await submitReport(
      f.request.id,
      reportBody(f),
      adminToken,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    // A different Field user with the authority but no assignment is denied.
    const other = await scopedUser([
      { code: 'handyman.field.inspection.report.submit', name: 'Submit Field Reports' },
    ]);
    await buildingAssignmentService.createAssignment(
      other.userId,
      { buildingId: f.building.id },
      adminUserId,
    );
    const unassigned = await submitReport(f.request.id, reportBody(f), other.token);
    assert.equal(unassigned.status, 403, JSON.stringify(unassigned.body));
    assert.equal(unassigned.body.error.code, 'HANDYMAN_INSPECTION_FIELD_DENIED');
    assert.equal(await reportCount(f.request.id), 0);
  });

  it('2: version 1 links the 0381 inspection + assignment with server-derived scope and quantity lines', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    const res = await submitReport(f.request.id, {
      ...reportBody(f),
      // smuggled authority/context: must never become input
      versionNumber: 9,
      clientId: randomUUID(),
      buildingId: randomUUID(),
      submittedByUserId: randomUUID(),
      scopeClassification: 'OUT_OF_HANDYMAN_SCOPE',
      status: 'ACCEPTED',
      unitPrice: 1000,
      currency: 'IDR',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const report = res.body.data;
    assert.equal(report.handymanRequestInspectionId, f.inspectionId);
    assert.equal(report.versionNumber, 1);
    assert.equal(report.supersedesReportId, null);
    assert.equal(report.submittedByUserId, fieldUserId);
    assert.equal(report.clientId, f.client.id);
    assert.equal(report.scopeClassification, 'GENERAL_HANDYMAN');
    assert.equal(report.status, 'PENDING_REVIEW');
    assert.equal(report.review, null);
    assert.equal(report.estimates.length, 2);
    assert.deepEqual(
      report.estimates.map((line: { lineType: string }) => line.lineType).sort(),
      ['LABOR', 'MATERIAL'],
    );
    // No commercial vocabulary exists in the persisted or returned model.
    const keys = Object.keys(report).sort();
    for (const forbidden of [
      'unitPrice', 'finalQuotedUnitAmount', 'currency', 'lineTotal',
      'amount', 'tax',
    ]) {
      assert.ok(!keys.includes(forbidden), `${forbidden} must not exist`);
    }
    assert.deepEqual(
      Object.keys(report.estimates[0]).sort(),
      ['clientId', 'createdAt', 'description', 'id', 'lineType', 'quantity',
       'reportId', 'uomId'],
    );
    // FROZEN F1: no request status is written by report submission.
    const status = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(status.rows[0].status, 'DIAGNOSIS');
    // F6 journal row is audit-only.
    const event = await q(
      `SELECT metadata FROM operational_events
        WHERE entity_id = $1 AND event_type = 'HANDYMAN_INSPECTION_REPORT_SUBMITTED'`,
      [f.request.id],
    );
    assert.equal(event.rows.length, 1);
    assert.equal(event.rows[0].metadata.versionNumber, 1);
    assert.ok(!('clientId' in event.rows[0].metadata));
  });

  it('3: estimate lines are bounded to technical quantities and real units', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    // Malformed lines are refused at the HTTP boundary (400) and the
    // well-formed-but-unknown unit of measure is refused by the service with
    // the report-specific code (no state is written in either case).
    for (const bad of [
      { lineType: 'PRICE', description: 'x', quantity: 1, uomId: f.uomId },
      { lineType: 'LABOR', description: 'x', quantity: 0, uomId: f.uomId },
      { lineType: 'LABOR', description: 'x', quantity: -3, uomId: f.uomId },
      { lineType: 'LABOR', description: '', quantity: 1, uomId: f.uomId },
    ]) {
      const res = await submitReport(f.request.id, {
        ...reportBody(f),
        estimates: [bad],
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    }
    const unknownUom = await submitReport(f.request.id, {
      ...reportBody(f),
      estimates: [
        { lineType: 'LABOR', description: 'x', quantity: 1, uomId: randomUUID() },
      ],
    });
    assert.equal(unknownUom.status, 400, JSON.stringify(unknownUom.body));
    assert.equal(
      unknownUom.body.error.code,
      'HANDYMAN_INSPECTION_REPORT_ESTIMATE_INVALID',
    );
    // A unit of measure from another Client is not acceptable either.
    const other = await inspectionReadyFixture();
    const crossClient = await submitReport(f.request.id, {
      ...reportBody(f),
      estimates: [
        { lineType: 'LABOR', description: 'x', quantity: 1, uomId: other.uomId },
      ],
    });
    assert.equal(crossClient.status, 400, JSON.stringify(crossClient.body));
    assert.equal(await reportCount(f.request.id), 0);
  });

  it('4: a pending version blocks a replacement; a returned version opens the correction chain', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    const v1 = await submitReport(f.request.id, reportBody(f));
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    const v1Id = v1.body.data.id as string;

    // Pending version: a second submission is refused (no replacement).
    const pending = await submitReport(f.request.id, reportBody(f));
    assert.equal(pending.status, 409, JSON.stringify(pending.body));
    assert.equal(
      pending.body.error.code,
      'HANDYMAN_INSPECTION_REPORT_PENDING_REVIEW',
    );

    // RETURNED requires a reason.
    const noReason = await reviewReport(f.request.id, v1Id, {
      decision: 'RETURNED',
    });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.equal(
      noReason.body.error.code,
      'HANDYMAN_INSPECTION_REPORT_RETURN_REASON_REQUIRED',
    );

    const returned = await reviewReport(f.request.id, v1Id, {
      decision: 'RETURNED',
      returnReason: 'Attach the ceiling void measurement.',
    });
    assert.equal(returned.status, 201, JSON.stringify(returned.body));
    assert.equal(returned.body.data.status, 'RETURNED');
    assert.equal(
      returned.body.data.review.returnReason,
      'Attach the ceiling void measurement.',
    );

    // The returned version is superseded by a NEW version that links back.
    const v2 = await submitReport(f.request.id, {
      ...reportBody(f),
      technicalFindings: 'Cracked pipe joint; ceiling void measured at 40cm.',
    });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    assert.equal(v2.body.data.versionNumber, 2);
    assert.equal(v2.body.data.supersedesReportId, v1Id);

    // v1 keeps its own decision and body forever.
    const v1Read = await api()
      .get(`${HM}/${f.request.id}/inspection-reports/${v1Id}`)
      .set(fieldAuth());
    assert.equal(v1Read.status, 200, JSON.stringify(v1Read.body));
    assert.equal(v1Read.body.data.status, 'RETURNED');
    assert.equal(
      v1Read.body.data.technicalFindings,
      'Cracked pipe joint under the sink trap.',
    );
    assert.equal(v1Read.body.data.review.decision, 'RETURNED');

    // Accepting v2 closes the chain.
    const accepted = await reviewReport(f.request.id, v2.body.data.id, {
      decision: 'ACCEPTED',
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.status, 'ACCEPTED');

    const afterAccept = await submitReport(f.request.id, reportBody(f));
    assert.equal(afterAccept.status, 409, JSON.stringify(afterAccept.body));
    assert.equal(
      afterAccept.body.error.code,
      'HANDYMAN_INSPECTION_REPORT_ALREADY_ACCEPTED',
    );
  });

  it('5: reviewer separation, one decision per version and one accepted version per request', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    const v1 = await submitReport(f.request.id, reportBody(f));
    const v1Id = v1.body.data.id as string;

    // The submitting Field user cannot review their own version.
    const selfReview = await reviewReport(
      f.request.id,
      v1Id,
      { decision: 'ACCEPTED' },
      fieldToken,
    );
    // (403 either because the Field user lacks the review authority or
    // because self-review is refused; assert the denial, not the reason.)
    assert.equal(selfReview.status, 403, JSON.stringify(selfReview.body));

    // A reviewer token held by the submitter is refused as self-review.
    // A user holding BOTH authorities (a real provisioning mistake) is the
    // hardest self-review case: assignment target and reviewer in one person.
    const reviewerIdentity = await scopedUser([
      { code: 'handyman.operations.inspection.report.review', name: 'Review Field Reports' },
      { code: 'handyman.field.inspection.report.submit', name: 'Submit Field Reports' },
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    await buildingAssignmentService.createAssignment(
      reviewerIdentity.userId,
      { buildingId: f.building.id },
      adminUserId,
    );
    // Reassign the request to that user, then let them submit and try to review.
    // The hardest case is a user who is BOTH the recorded inspector and a
    // reviewer: the same person still cannot decide on their own version.
    const second = await inspectionReadyFixture({ inspector: reviewerIdentity });
    const selfSubmission = await submitReport(
      second.request.id,
      reportBody(second),
      reviewerIdentity.token,
    );
    assert.equal(selfSubmission.status, 201, JSON.stringify(selfSubmission.body));
    const selfDecision = await reviewReport(
      second.request.id,
      selfSubmission.body.data.id,
      { decision: 'ACCEPTED' },
      reviewerIdentity.token,
    );
    assert.equal(selfDecision.status, 403, JSON.stringify(selfDecision.body));
    assert.equal(
      selfDecision.body.error.code,
      'HANDYMAN_INSPECTION_REPORT_SELF_REVIEW_DENIED',
    );

    // The database refuses the same violation even if the service is bypassed.
    await assert.rejects(
      q(
        `INSERT INTO handyman_request_inspection_report_reviews
           (id, client_id, handyman_request_id, building_id, report_id,
            report_submitted_by_user_id, decision, reviewed_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $5, 'ACCEPTED', $5)`,
        [
          randomUUID(),
          second.client.id,
          second.request.id,
          second.building.id,
          selfSubmission.body.data.id,
        ],
      ),
      /separation|check/i,
    );

    // One decision per version, then one accepted version per request.
    const accepted = await reviewReport(f.request.id, v1Id, {
      decision: 'ACCEPTED',
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const secondDecision = await reviewReport(f.request.id, v1Id, {
      decision: 'RETURNED',
      returnReason: 'Changed my mind.',
    });
    assert.equal(secondDecision.status, 409, JSON.stringify(secondDecision.body));
    assert.equal(
      secondDecision.body.error.code,
      'HANDYMAN_INSPECTION_REPORT_ALREADY_REVIEWED',
    );
  });

  it('6: review authority is dedicated, scoped and limited to the latest version', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    const v1 = await submitReport(f.request.id, reportBody(f));
    const v1Id = v1.body.data.id as string;

    // manage/assign authorities are not the review authority.
    const adminDenied = await reviewReport(
      f.request.id,
      v1Id,
      { decision: 'ACCEPTED' },
      adminToken,
    );
    assert.equal(adminDenied.status, 403, JSON.stringify(adminDenied.body));
    const opsDenied = await reviewReport(
      f.request.id,
      v1Id,
      { decision: 'ACCEPTED' },
      opsToken,
    );
    assert.equal(opsDenied.status, 403, JSON.stringify(opsDenied.body));

    // A reviewer without access to the request's exact Building is denied.
    const outsider = await scopedUser([
      { code: 'handyman.operations.inspection.report.review', name: 'Review Field Reports' },
    ]);
    const scoped = await reviewReport(
      f.request.id,
      v1Id,
      { decision: 'ACCEPTED' },
      outsider.token,
    );
    assert.equal(scoped.status, 403, JSON.stringify(scoped.body));
    assert.equal(scoped.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Unknown report ids are a bounded 404.
    const missing = await reviewReport(f.request.id, randomUUID(), {
      decision: 'ACCEPTED',
    });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));

    // Only the latest version may be decided: a superseded version is refused.
    await reviewReport(f.request.id, v1Id, {
      decision: 'RETURNED',
      returnReason: 'Redo the measurement.',
    });
    const v2 = await submitReport(f.request.id, reportBody(f));
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    const staleReview = await reviewReport(f.request.id, v1Id, {
      decision: 'ACCEPTED',
    });
    assert.equal(staleReview.status, 409, JSON.stringify(staleReview.body));
    assert.equal(
      staleReview.body.error.code,
      'HANDYMAN_INSPECTION_REPORT_NOT_LATEST',
    );
  });

  it('7: report, estimate and review rows are immutable in the database', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    const v1 = await submitReport(f.request.id, reportBody(f));
    const reportId = v1.body.data.id as string;
    await reviewReport(f.request.id, reportId, { decision: 'ACCEPTED' });
    const reviewId = (
      await q(
        'SELECT id FROM handyman_request_inspection_report_reviews WHERE report_id = $1',
        [reportId],
      )
    ).rows[0].id as string;
    const estimateId = (
      await q(
        'SELECT id FROM handyman_request_inspection_report_estimates WHERE report_id = $1 LIMIT 1',
        [reportId],
      )
    ).rows[0].id as string;

    for (const [sql, params] of [
      [`UPDATE handyman_request_inspection_reports SET version_number = 7 WHERE id = $1`, [reportId]],
      [`DELETE FROM handyman_request_inspection_reports WHERE id = $1`, [reportId]],
      [`UPDATE handyman_request_inspection_report_estimates SET quantity = 99 WHERE id = $1`, [estimateId]],
      [`DELETE FROM handyman_request_inspection_report_estimates WHERE id = $1`, [estimateId]],
      [`UPDATE handyman_request_inspection_report_reviews SET decision = 'RETURNED' WHERE id = $1`, [reviewId]],
      [`DELETE FROM handyman_request_inspection_report_reviews WHERE id = $1`, [reviewId]],
    ] as const) {
      await assert.rejects(q(sql as string, [...params]), /append-only/i);
    }
  });

  it('8: reads are building-scoped and expose the whole version thread', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectionReadyFixture();
    const v1 = await submitReport(f.request.id, reportBody(f));
    const thread = await api()
      .get(`${HM}/${f.request.id}/inspection-reports`)
      .set(reviewAuth());
    assert.equal(thread.status, 200, JSON.stringify(thread.body));
    assert.equal(thread.body.data.reports.length, 1);
    assert.equal(thread.body.data.reports[0].id, v1.body.data.id);

    const stranger = await scopedUser([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    const denied = await api()
      .get(`${HM}/${f.request.id}/inspection-reports`)
      .set(auth(stranger.token));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const anonymous = await api()
      .get(`${HM}/${f.request.id}/inspection-reports`);
    assert.equal(anonymous.status, 401);
  });
});

async function reportCount(handymanRequestId: string): Promise<number> {
  const rows = await q(
    `SELECT count(*)::int AS count
       FROM handyman_request_inspection_reports
      WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return rows.rows[0].count as number;
}
