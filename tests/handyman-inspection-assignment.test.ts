import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
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
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-INSPECTION-01 PART A — focused pre-quotation Field inspection
 * assignment tests.
 *
 * Scope: the 0445 assignment fact and its authority boundary only — the
 * dedicated assignment permission (never a default grant), the exact-Building
 * guard, target eligibility (ACTIVE + report permission + Building access),
 * the INSPECTION_REQUIRED-only path, one ACTIVE assignment per request, the
 * reason-bound supersession chain, database immutability, and the single
 * writer for the in-scope physical inspection (assigned Field only; the legacy
 * `tenant_company.manage` route is closed).
 *
 * Out of scope here (frozen and untouched): quotation, PIC approval,
 * Execution Scope / CR-HM-04 assignment, evidence, referral, request statuses.
 */

const DIR = '/tmp/handyman-inspection-assignment-pg';
const PORT = 55570;
const HM = '/api/v1/handyman/requests';

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let database: DatabaseConfig | null = null;

let adminUserId = '';
let adminToken = '';
let opsUserId = '';
let opsToken = '';
let fieldUserId = '';
let fieldToken = '';
let otherFieldUserId = '';
let otherFieldToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1',
      DB_PORT: String(PORT),
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'asentra_test',
      DB_SSL: 'false',
    });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const db = await ensureTestDatabase();
  assert.ok(db, 'Inspection assignment tests require PostgreSQL');
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_request_inspection_assignments,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_service_variants, service_catalog, operational_events,
    tenant_service_requests, tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies,
    spaces, rooms, areas, floors, buildings, properties, users, roles,
    permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;
  const ops = await scopedUser([
    { code: 'handyman.operations.inspection.assign', name: 'Assign Field Inspectors to Handyman Requests' },
    { code: 'handyman.operations.request.read', name: 'Read Handyman Operations Request Queue' },
  ]);
  opsUserId = ops.userId;
  opsToken = ops.token;
  const field = await scopedUser([
    { code: 'handyman.field.inspection.report.submit', name: 'Submit Handyman Field Inspection Reports' },
  ]);
  fieldUserId = field.userId;
  fieldToken = field.token;
  const otherField = await scopedUser([
    { code: 'handyman.field.inspection.report.submit', name: 'Submit Handyman Field Inspection Reports' },
  ]);
  otherFieldUserId = otherField.userId;
  otherFieldToken = otherField.token;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
  if (postgres) await postgres.stop().catch(() => undefined);
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const opsAuth = () => auth(opsToken);
const fieldAuth = () => auth(fieldToken);

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

/** Client → property → building → tenant attribution + INTAKE request. */
async function inspectionRequestFixture() {
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
  // Building scope for the Operations assigner, the Field users and an
  // out-of-scope peer. The last one deliberately stays unassigned.
  for (const userId of [opsUserId, fieldUserId, otherFieldUserId]) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building, company, request };
}

/**
 * Triage the request on the requested disposition. The triage service is
 * used directly (its own authority is a separate, already-covered subject);
 * this suite asserts only the assignment surface.
 */
async function triage(
  requestId: string,
  disposition: 'INSPECTION_REQUIRED' | 'DIAGNOSIS',
) {
  return handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: requestId,
      triageDisposition: disposition,
      triageNote: `Fixture triage: ${disposition}.`,
    },
    adminUserId,
  );
}

async function inspectableRequest() {
  const fixture = await inspectionRequestFixture();
  await triage(fixture.request.id, 'INSPECTION_REQUIRED');
  return fixture;
}

async function assign(
  requestId: string,
  assignedFieldUserId: string,
  reassignmentReason?: string,
  token = opsToken,
) {
  return api().post(`${HM}/${requestId}/inspection-assignment`)
    .set(auth(token))
    .send({
      assignedFieldUserId,
      ...(reassignmentReason ? { reassignmentReason } : {}),
    });
}

describe('CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment', () => {
  it('1: assignment requires the dedicated Operations permission (no default grant)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectableRequest();
    // PLATFORM_ADMIN holds tenant_company.manage/read but not the new code.
    const denied = await assign(f.request.id, fieldUserId, undefined, adminToken);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    // The Field report authority is not the assignment authority either.
    const fieldDenied = await assign(f.request.id, fieldUserId, undefined, fieldToken);
    assert.equal(fieldDenied.status, 403, JSON.stringify(fieldDenied.body));
    // Nothing was persisted by the refusals.
    const rows = await q(
      'SELECT count(*)::int AS count FROM handyman_request_inspection_assignments WHERE handyman_request_id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].count, 0);
  });

  it('2: Operations assigns the Field inspector; read returns current + history', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectableRequest();
    const res = await assign(f.request.id, fieldUserId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.changed, true);
    assert.equal(res.body.data.current.handymanRequestId, f.request.id);
    assert.equal(res.body.data.current.clientId, f.client.id);
    assert.equal(res.body.data.current.assignedFieldUserId, fieldUserId);
    assert.equal(res.body.data.current.assignedByUserId, opsUserId);
    assert.equal(res.body.data.current.status, 'ACTIVE');
    assert.equal(res.body.data.current.supersedesAssignmentId, null);
    assert.equal(res.body.data.current.supersessionReason, null);
    assert.equal(res.body.data.history.length, 1);

    const read = await api()
      .get(`${HM}/${f.request.id}/inspection-assignment`)
      .set(opsAuth());
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.current.id, res.body.data.current.id);
    assert.equal(read.body.data.history.length, 1);

    // F6 journal row is history, never the authority; report payload absent.
    const event = await q(
      `SELECT event_type, actor_user_id, metadata
         FROM operational_events
        WHERE entity_id = $1 AND event_type = 'HANDYMAN_INSPECTION_ASSIGNED'`,
      [f.request.id],
    );
    assert.equal(event.rows.length, 1);
    assert.equal(event.rows[0].actor_user_id, opsUserId);
    assert.equal(event.rows[0].metadata.assignedFieldUserId, fieldUserId);
    assert.equal(event.rows[0].metadata.assignmentId, res.body.data.current.id);

    // Unauthenticated read is refused.
    const anonymous = await api()
      .get(`${HM}/${f.request.id}/inspection-assignment`);
    assert.equal(anonymous.status, 401);
  });

  it('3: target eligibility — inactive user, no report permission, wrong Building', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectableRequest();

    // No report-submission permission (Operations token holder as target).
    const noPermission = await assign(f.request.id, opsUserId);
    assert.equal(noPermission.status, 400, JSON.stringify(noPermission.body));
    assert.equal(
      noPermission.body.error.code,
      'HANDYMAN_INSPECTION_ASSIGNMENT_TARGET_INVALID',
    );

    // Wrong Building: a Field user with the permission but no assignment here.
    const outsider = await scopedUser([
      { code: 'handyman.field.inspection.report.submit', name: 'Submit Handyman Field Inspection Reports' },
    ]);
    const wrongBuilding = await assign(f.request.id, outsider.userId);
    assert.equal(wrongBuilding.status, 400, JSON.stringify(wrongBuilding.body));

    // Inactive user.
    await q(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [fieldUserId]);
    const inactive = await assign(f.request.id, fieldUserId);
    assert.equal(inactive.status, 400, JSON.stringify(inactive.body));
    await q(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [fieldUserId]);

    // None of the refusals persisted an assignment.
    const rows = await q(
      'SELECT count(*)::int AS count FROM handyman_request_inspection_assignments WHERE handyman_request_id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].count, 0);
  });

  it('4: assignment is bound to the INSPECTION_REQUIRED path and exact Building scope', async (t) => {
    if (!requireDatabase(t)) return;
    // Direct-to-diagnosis request: never eligible for a Field assignment.
    const direct = await inspectionRequestFixture();
    const triaged = await triage(direct.request.id, 'DIAGNOSIS');
    assert.equal(triaged.triageDisposition, 'DIAGNOSIS');
    const notEligible = await assign(direct.request.id, fieldUserId);
    assert.equal(notEligible.status, 400, JSON.stringify(notEligible.body));
    assert.equal(
      notEligible.body.error.code,
      'HANDYMAN_INSPECTION_ASSIGNMENT_NOT_ELIGIBLE',
    );

    // Assigner from another Building under the same Client: 403, and the
    // behaviour matches a nonexistent request (no existence leak).
    const f = await inspectableRequest();
    const other = await inspectionRequestFixture();
    const outsider = await scopedUser([
      { code: 'handyman.operations.inspection.assign', name: 'Assign Field Inspectors to Handyman Requests' },
    ]);
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: other.building.id,
    });
    const denied = await assign(f.request.id, fieldUserId, undefined, outsider.token);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const missing = await assign(randomUUID(), fieldUserId);
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
  });

  it('5: reassignment keeps the predecessor, demands a reason and links the chain', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectableRequest();
    const first = await assign(f.request.id, fieldUserId);
    assert.equal(first.status, 201);

    // Different target without a reason → 400, predecessor untouched.
    const noReason = await assign(f.request.id, otherFieldUserId);
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.equal(
      noReason.body.error.code,
      'HANDYMAN_INSPECTION_REASSIGNMENT_REASON_REQUIRED',
    );
    let rows = await q(
      `SELECT status, assigned_field_user_id
         FROM handyman_request_inspection_assignments
        WHERE handyman_request_id = $1`,
      [f.request.id],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, 'ACTIVE');

    // Same target replay: no new fact, 200.
    const replay = await assign(f.request.id, fieldUserId);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.changed, false);
    rows = await q(
      'SELECT count(*)::int AS count FROM handyman_request_inspection_assignments WHERE handyman_request_id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].count, 1);

    // Reasoned reassignment: predecessor SUPERSEDED with the reason recorded
    // and both chain directions persisted; exactly one ACTIVE remains.
    const reassigned = await assign(
      f.request.id,
      otherFieldUserId,
      'Original inspector unavailable.',
    );
    assert.equal(reassigned.status, 201, JSON.stringify(reassigned.body));
    assert.equal(reassigned.body.data.history.length, 2);
    const [oldRow, newRow] = reassigned.body.data.history;
    assert.equal(oldRow.id, first.body.data.current.id);
    assert.equal(oldRow.status, 'SUPERSEDED');
    assert.equal(oldRow.assignedFieldUserId, fieldUserId);
    assert.equal(oldRow.supersessionReason, 'Original inspector unavailable.');
    assert.equal(oldRow.supersededByAssignmentId, newRow.id);
    assert.ok(oldRow.supersededAt);
    assert.equal(newRow.status, 'ACTIVE');
    assert.equal(newRow.assignedFieldUserId, otherFieldUserId);
    assert.equal(newRow.supersedesAssignmentId, oldRow.id);

    const active = await q(
      `SELECT count(*)::int AS count
         FROM handyman_request_inspection_assignments
        WHERE handyman_request_id = $1 AND status = 'ACTIVE'`,
      [f.request.id],
    );
    assert.equal(active.rows[0].count, 1);
  });

  it('6: the in-scope physical inspection is written by the assigned Field user only', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectableRequest();
    const body = { result: 'INSPECTED', notes: 'Pipe joint cracked.' };

    // Legacy generic manage authority no longer writes an in-scope inspection.
    const legacy = await api().post(`${HM}/${f.request.id}/inspection`)
      .set(auth(adminToken)).send(body);
    assert.equal(legacy.status, 403, JSON.stringify(legacy.body));

    // A Field user with the authority but no assignment for this request.
    const unassigned = await api().post(`${HM}/${f.request.id}/inspection`)
      .set(fieldAuth()).send(body);
    assert.equal(unassigned.status, 409, JSON.stringify(unassigned.body));
    assert.equal(
      unassigned.body.error.code,
      'HANDYMAN_INSPECTION_ASSIGNMENT_REQUIRED',
    );

    // Assigned, but a DIFFERENT Field user acts.
    const assigned = await assign(f.request.id, fieldUserId);
    assert.equal(assigned.status, 201);
    const wrongField = await api().post(`${HM}/${f.request.id}/inspection`)
      .set(otherFieldToken ? auth(otherFieldToken) : fieldAuth()).send(body);
    assert.equal(wrongField.status, 403, JSON.stringify(wrongField.body));
    assert.equal(
      wrongField.body.error.code,
      'HANDYMAN_INSPECTION_FIELD_DENIED',
    );

    // The assigned Field user records the 0381 fact; the request projects to
    // DIAGNOSIS exactly as before and the record carries that actor.
    const recorded = await api().post(`${HM}/${f.request.id}/inspection`)
      .set(fieldAuth()).send(body);
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    assert.equal(recorded.body.data.inspectedByUserId, fieldUserId);
    const status = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(status.rows[0].status, 'DIAGNOSIS');
  });

  it('7: the assignment fact is immutable in the database', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await inspectableRequest();
    const first = await assign(f.request.id, fieldUserId);
    const assignmentId = first.body.data.current.id as string;

    // Immutable columns cannot be rewritten while the row is ACTIVE.
    await assert.rejects(
      q(
        `UPDATE handyman_request_inspection_assignments
            SET assigned_field_user_id = $2
          WHERE id = $1`,
        [assignmentId, otherFieldUserId],
      ),
      /append-only|supersession/i,
    );
    // Deletion is refused for every actor.
    await assert.rejects(
      q(
        'DELETE FROM handyman_request_inspection_assignments WHERE id = $1',
        [assignmentId],
      ),
      /append-only/i,
    );
    // A superseded row cannot be resurrected or edited.
    await assign(f.request.id, otherFieldUserId, 'Handover to the standby lead.');
    await assert.rejects(
      q(
        `UPDATE handyman_request_inspection_assignments
            SET status = 'ACTIVE', superseded_at = NULL,
                superseded_by_assignment_id = NULL, supersession_reason = NULL
          WHERE id = $1`,
        [assignmentId],
      ),
      /immutable|supersession/i,
    );
  });
});
