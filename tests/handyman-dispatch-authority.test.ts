import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
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
import { handymanDispatchService } from '../src/modules/handyman-dispatch';
import { handymanInspectorAssignmentService } from '../src/modules/handyman-inspector-assignments';
import { handymanIdentityProjectionService } from '../src/modules/handyman-identity-projection';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
import {
  handymanServiceRequestService,
  recordHandymanDiagnosis,
  recordHandymanRequestTriage,
} from '../src/modules/handyman-requests';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  handymanExecutionScopeRepository,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { checkInHandymanWorkSession } from '../src/modules/handyman-work-sessions';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';

const PORT = 55480;
const DIR = '/tmp/asentra-dispatch-pg';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.ASENTRA_USE_EMBEDDED_POSTGRES = 'true';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = String(PORT);
process.env.DB_NAME = 'asentra_test';
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'postgres';
process.env.DB_SSL = 'false';

let pgServer: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function q(text: string, params: unknown[] = []) {
  if (!pool) throw new Error('pool not initialized');
  return pool.query(text, params);
}

async function setupRealm() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Dispatch Client',
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
    timezone: 'Asia/Jakarta',
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
    name: 'Pos',
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
    name: 'Space',
  });
  const tenant = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `T_${suffix()}`,
      tenantName: 'Tenant',
    },
    adminUserId,
  );
  return {
    client,
    property,
    building,
    organization,
    department,
    position,
    floor,
    area,
    room,
    space,
    tenant,
  };
}

async function setupInspectorUser(
  realm: Awaited<ReturnType<typeof setupRealm>>,
) {
  const user = await userService.createUser({
    email: `insp-${suffix().toLowerCase()}@example.com`,
    displayName: 'Inspector',
  });
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: realm.building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `VI_${suffix()}`,
    vendorName: 'Inspector Vendor',
  });
  const pc = await handymanProviderContextService.createHandymanProviderContext(
    { vendorId: vendor.id },
    adminUserId,
  );
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `I_${suffix()}`,
    fullName: 'Inspector Person',
    workforceType: 'EXTERNAL',
    userId: user.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VB_${suffix()}`,
  });
  const wc = await handymanWorkerContextService.createHandymanWorkerContext(
    { handymanProviderContextId: pc.id, workforceProfileId: profile.id },
    adminUserId,
  );
  // Place workforce at the test building (required eligibility predicate).
  await q(
    `INSERT INTO workforce_building_assignments
       (id, workforce_profile_id, building_id, status,
        effective_from, effective_until)
     VALUES ($1,$2,$3,'ACTIVE',NULL,NULL)`,
    [randomUUID(), profile.id, realm.building.id],
  );
  return { user, vendor, providerContext: pc, profile, workerContext: wc };
}

async function setupCrew(
  realm: Awaited<ReturnType<typeof setupRealm>>,
): Promise<{
  vendor: { id: string };
  providerContext: { id: string };
  crew: { id: string };
  leadUser: { id: string };
  workerContext: { id: string };
}> {
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Vendor',
  });
  const providerContext =
    await handymanProviderContextService.createHandymanProviderContext(
      { vendorId: vendor.id },
      adminUserId,
    );
  const leadUser = await userService.createUser({
    email: `lead-${suffix().toLowerCase()}@example.com`,
    displayName: 'Lead',
  });
  await buildingAssignmentService.createAssignment(leadUser.id, {
    buildingId: realm.building.id,
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `L_${suffix()}`,
    fullName: 'Lead Worker',
    workforceType: 'EXTERNAL',
    userId: leadUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VB_${suffix()}`,
  });
  const workerContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  // Place lead workforce at the test building (eligibility requirement).
  await q(
    `INSERT INTO workforce_building_assignments
       (id, workforce_profile_id, building_id, status,
        effective_from, effective_until)
     VALUES ($1,$2,$3,'ACTIVE',NULL,NULL)`,
    [randomUUID(), profile.id, realm.building.id],
  );
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `CR_${suffix()}`,
      name: 'Crew',
      leadWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  return {
    vendor,
    providerContext,
    crew: bundle.crew,
    leadUser,
    workerContext,
  };
}

async function setupRequest(
  realm: Awaited<ReturnType<typeof setupRealm>>,
  opts?: { spaceId?: string },
): Promise<{ requestId: string; picUserId: string }> {
  // Create a fresh space hierarchy per request so parallel fixtures do not
  // collide on tenant-space bindings.
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
    name: 'Space',
  });
  const spaceId = opts?.spaceId ?? space.id;

  // A tenant customer to own the request.
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: realm.tenant.id,
    picName: 'Tenant Requester',
    email: `requester-${suffix().toLowerCase()}@tenant.example.com`,
    userId: linkedUser.id,
  }, adminUserId);
  // assignSpaceToTenant enforces one-active per space; assign our fresh space.
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: realm.tenant.id,
    buildingId: realm.building.id,
    spaceId,
  }, adminUserId).catch(() => undefined); // idempotent across tests
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: realm.tenant.id,
    buildingId: realm.building.id,
  }, adminUserId).catch(() => undefined);
  const attribution = await createChannelAttribution({
    tenantCompanyId: realm.tenant.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId,
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
    .createHandymanServiceRequest({
      channelAttributionId: attribution.id,
      serviceCatalogId: service.id,
    }, adminUserId);
  await recordHandymanRequestTriage({
    handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS',
    triageNote: 'Direct to diagnosis.',
  }, adminUserId);
  await recordHandymanDiagnosis({
    handymanRequestId: request.id,
    disciplineId,
    diagnosis: 'Dispatch authority test diagnosis.',
  }, adminUserId);
  return { requestId: request.id, picUserId: linkedUser.id };
}

async function setupProposedInspectionVisit(
  requestId: string,
  inspectorUserId: string,
): Promise<string> {
  const res = await q(
    `INSERT INTO handyman_visit_appointments (
       id, client_id, handyman_request_id, tenant_company_id, building_id,
       kind, resource_type, resource_id, start_at, end_at, timezone,
       state, created_by_user_id, tenant_choice_evidence_ref
     )
     SELECT $1, r.client_id, r.id, r.tenant_company_id, r.building_id,
       'INSPECTION','INSPECTOR_USER',$2,NOW() + INTERVAL '1 hour',
       NOW() + INTERVAL '2 hours', COALESCE(b.timezone,'UTC'),
       'PROPOSED', $3, 'seed-choice'
       FROM handyman_service_requests r
       JOIN buildings b ON b.id = r.building_id
      WHERE r.id = $4
     RETURNING id`,
    [randomUUID(), inspectorUserId, adminUserId, requestId],
  );
  return res.rows[0].id as string;
}

async function setupApprovedScope(
  realm: Awaited<ReturnType<typeof setupRealm>>,
  requestId: string,
  picUserId: string,
): Promise<string> {
  const bundle = await createHandymanQuotation(
    { handymanRequestId: requestId },
    adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR',
    description: 'Repair work',
    quantity: 1,
    uomId,
    currency: 'IDR',
    finalQuotedUnitAmount: 100,
  }, adminUserId);
  await issueHandymanQuotationVersion(version.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, adminUserId);
  // CR-HM-18: the tenant decision authority requires the ACTIVE Tenant PIC
  // user of the request, so the approval is recorded by that PIC.
  const picUser = (
    await q(
      `SELECT tp.user_id
         FROM handyman_service_requests r
         JOIN handyman_channel_attributions a
           ON a.id = r.channel_attribution_id
         JOIN tenant_pics tp ON tp.id = a.tenant_pic_id
        WHERE r.id = $1 AND tp.status = 'ACTIVE'`,
      [requestId],
    )
  ).rows[0]?.user_id as string | undefined;
  const decision = await decideHandymanQuotation(version.id, {
    decision: 'APPROVE',
    idempotencyKey: `k-${randomUUID()}`,
  }, picUser ?? adminUserId);
  return decision.executionScope!.id;
}

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pgServer = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  await pgServer.initialise();
  await pgServer.start();
  const adminClient = pgServer.getPgClient('postgres', '127.0.0.1');
  await adminClient.connect();
  await adminClient.query('CREATE DATABASE asentra_test').catch(() => undefined);
  await adminClient.end();

  pool = await initDatabase({
    host: '127.0.0.1',
    port: PORT,
    name: 'asentra_test',
    user: 'postgres',
    password: 'postgres',
    ssl: false,
  });
  await migrateUp(pool);

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discRes = await q(
    `SELECT id FROM handyman_disciplines WHERE code='GENERAL_HANDYMAN' LIMIT 1`,
  );
  disciplineId = discRes.rows[0].id;
  database = {
    host: '127.0.0.1',
    port: PORT,
    name: 'asentra_test',
    user: 'postgres',
    password: 'postgres',
    ssl: false,
  };
});

after(async () => {
  if (pool) await closePool(pool);
  if (pgServer) await pgServer.stop();
  await rm(DIR, { recursive: true, force: true });
  pool = null;
  pgServer = null;
});

function requireDb(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

describe('CR-HM-OPS-DISPATCH-02 — Inspector / Crew / Dispatch authority', () => {
  it('P0-A: eligible inspector assignment and reassignment', async (t) => {
    if (!requireDb(t)) return;
    const realm = await setupRealm();
    const inspector = await setupInspectorUser(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const visitId = await setupProposedInspectionVisit(requestId, inspector.user.id);

    // list eligible includes the seeded inspector
    const eligible =
      await handymanInspectorAssignmentService.listEligibleInspectorsForVisit(
        visitId,
        adminUserId,
      );
    assert.ok(eligible.some((e) => e.userId === inspector.user.id));

    // assign initial
    const assigned = await handymanInspectorAssignmentService.assignInspectorToVisit(
      { visitAppointmentId: visitId, inspectorUserId: inspector.user.id },
      adminUserId,
    );
    assert.equal(assigned.status, 'ACTIVE');
    assert.equal(assigned.version, 1);

    // duplicate assignment is rejected
    await assert.rejects(
      () =>
        handymanInspectorAssignmentService.assignInspectorToVisit(
          { visitAppointmentId: visitId, inspectorUserId: inspector.user.id },
          adminUserId,
        ),
      (err: Error) => errorCode(err) === 'HANDYMAN_INSPECTOR_ASSIGNMENT_CONFLICT',
    );

    // reassign requires reason + expected version
    const otherInsp = await setupInspectorUser(realm);
    const reassigned =
      await handymanInspectorAssignmentService.reassignInspectorForVisit(
        {
          visitAppointmentId: visitId,
          inspectorUserId: otherInsp.user.id,
          expectedVersion: assigned.version,
          reason: 'Original inspector unavailable',
        },
        adminUserId,
      );
    assert.equal(reassigned.inspectorUserId, otherInsp.user.id);
    // Each new assignment row starts at version 1 (independent version chain).
    assert.equal(reassigned.version, 1);
    assert.equal(reassigned.supersedesAssignmentId, assigned.id);

    // stale version against the NEW active assignment is rejected
    await assert.rejects(
      () =>
        handymanInspectorAssignmentService.reassignInspectorForVisit(
          {
            visitAppointmentId: visitId,
            inspectorUserId: inspector.user.id,
            expectedVersion: reassigned.version + 5,
            reason: 'Race condition test',
          },
          adminUserId,
        ),
      (err: Error) =>
        errorCode(err) === 'HANDYMAN_INSPECTOR_ASSIGNMENT_VERSION_CONFLICT',
    );
  });

  it('P0-A: cross-building inspector is rejected', async (t) => {
    if (!requireDb(t)) return;
    const realmA = await setupRealm();
    const realmB = await setupRealm();
    // Inspector is only placed at realmA's building.
    const inspector = await setupInspectorUser(realmA);
    const { requestId, picUserId } = await setupRequest(realmB);
    const visitId = await setupProposedInspectionVisit(
      requestId,
      // place PROPOSED visit against a ghost id from realmB building;
      // the ineligible inspector is realmA's.
      randomUUID(),
    );
    await assert.rejects(
      () =>
        handymanInspectorAssignmentService.assignInspectorToVisit(
          { visitAppointmentId: visitId, inspectorUserId: inspector.user.id },
          adminUserId,
        ),
      (err: Error) =>
        errorCode(err) === 'HANDYMAN_INSPECTOR_ASSIGNMENT_INELIGIBLE',
    );
  });

  it('P0-B: execution reassignment requires version/reason and blocks active session', async (t) => {
    if (!requireDb(t)) return;
    const realm = await setupRealm();
    const crew1 = await setupCrew(realm);
    const crew2 = await setupCrew(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const scopeId = await setupApprovedScope(realm, requestId, picUserId);

    const initial = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeId,
        providerContextId: crew1.providerContext.id,
        crewId: crew1.crew.id,
      },
      adminUserId,
    );
    assert.equal(initial.status, 'ACTIVE');

    // Reassign with bad version → 409
    await assert.rejects(
      () =>
        reassignHandymanExecutionScopeCrew(
          {
            executionScopeId: scopeId,
            providerContextId: crew2.providerContext.id,
            crewId: crew2.crew.id,
            expectedVersion: initial.version + 99,
            reason: 'should fail',
          },
          adminUserId,
        ),
      (err: Error) =>
        errorCode(err) === 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_VERSION_CONFLICT',
    );

    // Reassign with correct version succeeds.
    const reassigned = await reassignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeId,
        providerContextId: crew2.providerContext.id,
        crewId: crew2.crew.id,
        expectedVersion: initial.version,
        reason: 'Crew unavailable',
      },
      adminUserId,
    );
    assert.equal(reassigned.handymanCrewId, crew2.crew.id);

    // history entry persisted
    const hist = await q(
      `SELECT action, reason FROM handyman_execution_scope_assignment_history
        WHERE execution_scope_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [scopeId],
    );
    assert.equal(hist.rows[0].action, 'REASSIGNED');
    assert.equal(hist.rows[0].reason, 'Crew unavailable');
  });

  it('P0-C: dispatch readiness evaluates correctly and release requires all gates', async (t) => {
    if (!requireDb(t)) return;
    const realm = await setupRealm();
    const crew = await setupCrew(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const scopeId = await setupApprovedScope(realm, requestId, picUserId);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeId,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );
    const readiness =
      await handymanDispatchService.evaluateDispatchReadiness(
        scopeId,
        adminUserId,
      );
    assert.equal(readiness.ready, false, 'No CONFIRMED appointment → not ready');
    assert.ok(readiness.failures.some((f) => /CONFIRMED/.test(f)));

    // release without appointment is rejected
    await assert.rejects(
      () =>
        handymanDispatchService.releaseHandymanDispatch(
          { executionScopeId: scopeId },
          adminUserId,
        ),
      (err: Error) => errorCode(err) === 'HANDYMAN_DISPATCH_NOT_READY',
    );

    // Create a CONFIRMED EXECUTION appointment for the crew, bypassing
    // lifecycle triggers via ALTER TABLE DISABLE TRIGGER (test-only) to
    // isolate readiness/release logic from the tenant-slot-confirmation flow.
    const apptId = randomUUID();
    const startAt = new Date(Date.now() + 2 * 3600_000);
    const endAt = new Date(Date.now() + 4 * 3600_000);
    await q(
      `ALTER TABLE handyman_visit_appointments
         DISABLE TRIGGER ALL`);
    await q(
      `INSERT INTO handyman_visit_appointments
         (id, client_id, handyman_request_id, execution_scope_id,
          tenant_company_id, building_id, kind, resource_type, resource_id,
          start_at, end_at, timezone, state, confirmed_by_user_id, confirmed_at,
          created_by_user_id, tenant_choice_evidence_ref, version)
       SELECT $1, es.client_id, es.handyman_request_id, es.id,
         es.tenant_company_id, es.building_id, 'EXECUTION','CREW',$2,
         $3, $4, COALESCE(b.timezone,'UTC'),'CONFIRMED',$5,NOW(),$5,'seed',1
         FROM handyman_execution_scopes es
         JOIN buildings b ON b.id = es.building_id
        WHERE es.id = $6`,
      [apptId, crew.crew.id, startAt, endAt, adminUserId, scopeId],
    );
    await q(
      `ALTER TABLE handyman_visit_appointments
         ENABLE TRIGGER ALL`);
    await q(
      `INSERT INTO handyman_visit_capacity_reservations
         (id, appointment_id, client_id, resource_type, resource_id,
          start_at, end_at, active)
       SELECT $1, $2, client_id, 'CREW', $3, $4, $5, TRUE
         FROM handyman_visit_appointments WHERE id = $2`,
      [randomUUID(), apptId, crew.crew.id, startAt, endAt],
    );

    const ready2 =
      await handymanDispatchService.evaluateDispatchReadiness(
        scopeId,
        adminUserId,
      );
    assert.equal(ready2.ready, true, 'With CONFIRMED appointment → ready');
    assert.deepEqual(ready2.failures, []);

    // release succeeds
    const rel = await handymanDispatchService.releaseHandymanDispatch(
      { executionScopeId: scopeId, appointmentId: apptId },
      adminUserId,
    );
    assert.equal(rel.status, 'RELEASED');
    assert.equal(rel.executionScopeId, scopeId);
    assert.equal(rel.appointmentId, apptId);

    // duplicate release is rejected
    await assert.rejects(
      () =>
        handymanDispatchService.releaseHandymanDispatch(
          { executionScopeId: scopeId },
          adminUserId,
        ),
      (err: Error) => errorCode(err) === 'HANDYMAN_DISPATCH_RELEASE_CONFLICT',
    );
  });

  it('P0-D: canonical identity projection reports seams', async (t) => {
    if (!requireDb(t)) return;
    const realm = await setupRealm();
    const { requestId, picUserId } = await setupRequest(realm);
    const proj =
      await handymanIdentityProjectionService.projectHandymanCanonicalIdentity(
        requestId,
        adminUserId,
      );
    assert.ok(proj.serviceRequest);
    assert.ok(proj.missingSeams.includes('INSPECTION_VISIT'));
    assert.ok(proj.missingSeams.includes('EXECUTION_SCOPE'));
  });

  it('P0-E: check-in requires dispatch release (not-released gate)', async (t) => {
    if (!requireDb(t)) return;
    const realm = await setupRealm();
    const crew = await setupCrew(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const scopeId = await setupApprovedScope(realm, requestId, picUserId);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeId,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );
    // Without a RELEASED dispatch row, check-in must be rejected even though
    // crew is assigned. The dispatch gate fires before arrival checks.
    await assert.rejects(
      () =>
        checkInHandymanWorkSession(
          {
            executionScopeId: scopeId,
            idempotencyKey: `k-${randomUUID()}`,
          },
          crew.leadUser.id,
        ),
      (err: Error) =>
        errorCode(err) === 'HANDYMAN_WORK_SESSION_DISPATCH_NOT_RELEASED',
    );
  });

  async function seedConfirmedCrewAppointment(
    scopeId: string,
    crew: { crew: { id: string } },
  ): Promise<string> {
    const apptId = randomUUID();
    const startAt = new Date(Date.now() + 2 * 3600_000);
    const endAt = new Date(Date.now() + 4 * 3600_000);
    await q(
      `ALTER TABLE handyman_visit_appointments DISABLE TRIGGER ALL`);
    await q(
      `INSERT INTO handyman_visit_appointments
         (id, client_id, handyman_request_id, execution_scope_id,
          tenant_company_id, building_id, kind, resource_type, resource_id,
          start_at, end_at, timezone, state, confirmed_by_user_id, confirmed_at,
          created_by_user_id, tenant_choice_evidence_ref, version)
       SELECT $1, es.client_id, es.handyman_request_id, es.id,
         es.tenant_company_id, es.building_id, 'EXECUTION','CREW',$2,
         $3, $4, COALESCE(b.timezone,'UTC'),'CONFIRMED',$5,NOW(),$5,'seed',1
         FROM handyman_execution_scopes es
         JOIN buildings b ON b.id = es.building_id
        WHERE es.id = $6`,
      [apptId, crew.crew.id, startAt, endAt, adminUserId, scopeId],
    );
    await q(
      `ALTER TABLE handyman_visit_appointments ENABLE TRIGGER ALL`);
    await q(
      `INSERT INTO handyman_visit_capacity_reservations
         (id, appointment_id, client_id, resource_type, resource_id,
          start_at, end_at, active)
       SELECT $1, $2, client_id, 'CREW', $3, $4, $5, TRUE
         FROM handyman_visit_appointments WHERE id = $2`,
      [randomUUID(), apptId, crew.crew.id, startAt, endAt],
    );
    return apptId;
  }

  it('P0-B: reassignment supersedes any existing dispatch release', async (t) => {
    if (!requireDb(t)) return;
    const realm = await setupRealm();
    const crew1 = await setupCrew(realm);
    const crew2 = await setupCrew(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const scopeId = await setupApprovedScope(realm, requestId, picUserId);
    const initial = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeId,
        providerContextId: crew1.providerContext.id,
        crewId: crew1.crew.id,
      },
      adminUserId,
    );
    const apptId = await seedConfirmedCrewAppointment(scopeId, crew1);
    const rel = await handymanDispatchService.releaseHandymanDispatch(
      { executionScopeId: scopeId, appointmentId: apptId },
      adminUserId,
    );
    assert.equal(rel.status, 'RELEASED');

    // Reassigning the crew must supersede the release; the prior PIC
    // must no longer see the job as actionable.
    const reassigned = await reassignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeId,
        providerContextId: crew2.providerContext.id,
        crewId: crew2.crew.id,
        expectedVersion: initial.version,
        reason: 'Crew unavailable',
      },
      adminUserId,
    );
    assert.equal(reassigned.status, 'ACTIVE');

    const supersededRows = await q(
      `SELECT status FROM handyman_dispatch_releases WHERE id = $1`,
      [rel.id],
    );
    assert.equal(supersededRows.rows[0].status, 'SUPERSEDED');

    // A new release is required before the new crew can act.
    await assert.rejects(
      () =>
        handymanDispatchService.releaseHandymanDispatch(
          { executionScopeId: scopeId, appointmentId: apptId },
          adminUserId,
        ),
      (err: Error) => errorCode(err) === 'HANDYMAN_DISPATCH_NOT_READY',
    );
  });

  it('P0-C: concurrent duplicate release is safely serialized', async (t) => {
    if (!requireDb(t)) return;
    // Defense-in-depth: the partial unique index on ACTIVE releases and
    // the FOR UPDATE lock on scope guarantee only one release commits.
    const realm = await setupRealm();
    const crew = await setupCrew(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const scopeId = await setupApprovedScope(realm, requestId, picUserId);
    await assignHandymanExecutionScopeCrew(
      { executionScopeId: scopeId, providerContextId: crew.providerContext.id, crewId: crew.crew.id },
      adminUserId,
    );
    const apptId = await seedConfirmedCrewAppointment(scopeId, crew);
    const results = await Promise.allSettled([
      handymanDispatchService.releaseHandymanDispatch(
        { executionScopeId: scopeId, appointmentId: apptId }, adminUserId),
      handymanDispatchService.releaseHandymanDispatch(
        { executionScopeId: scopeId, appointmentId: apptId }, adminUserId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one release must commit');
    assert.equal(rejected.length, 1, 'exactly one release must conflict');
    const err = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    assert.ok(
      err.code === 'HANDYMAN_DISPATCH_RELEASE_CONFLICT'
        || err.code === '23505',
      `expected conflict code, got ${err.code}`,
    );
  });

  it('P0-A: revoke inspector removes visit authority and version-conflicts stale', async (t) => {
    if (!requireDb(t)) return;
    const realm = await setupRealm();
    const inspector = await setupInspectorUser(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const visitId = await setupProposedInspectionVisit(requestId, inspector.user.id);
    const assigned = await handymanInspectorAssignmentService.assignInspectorToVisit(
      { visitAppointmentId: visitId, inspectorUserId: inspector.user.id },
      adminUserId,
    );
    // stale version rejection
    await assert.rejects(
      () =>
        handymanInspectorAssignmentService.revokeInspectorAssignment(
          visitId, assigned.version + 5, 'wrong', adminUserId),
      (err: Error) => errorCode(err) === 'HANDYMAN_INSPECTOR_ASSIGNMENT_VERSION_CONFLICT',
    );
    const revoked = await handymanInspectorAssignmentService.revokeInspectorAssignment(
      visitId, assigned.version, 'No-show', adminUserId,
    );
    assert.equal(revoked.status, 'REVOKED');
  });

  it('P0-E: active work session blocks reassignment', async (t) => {
    if (!requireDb(t)) return;
    // A work session can only begin after arrival verification + check-in;
    // test the repository guard directly.
    const realm = await setupRealm();
    const crew1 = await setupCrew(realm);
    const crew2 = await setupCrew(realm);
    const { requestId, picUserId } = await setupRequest(realm);
    const scopeId = await setupApprovedScope(realm, requestId, picUserId);
    const initial = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeId,
        providerContextId: crew1.providerContext.id,
        crewId: crew1.crew.id,
      },
      adminUserId,
    );
    // Synthesize an active work session to trigger the block.
    await q(
      `INSERT INTO handyman_work_sessions (id, client_id, execution_scope_id,
          assignment_id, lead_worker_id, lead_user_id, status)
       SELECT $1, $2, $3, $4, $5, $6, 'CHECKED_IN'`,
      [
        randomUUID(),
        realm.client.id,
        scopeId,
        initial.id,
        crew1.workerContext.id,
        crew1.leadUser.id,
      ],
    );
    await assert.rejects(
      () =>
        reassignHandymanExecutionScopeCrew(
          {
            executionScopeId: scopeId,
            providerContextId: crew2.providerContext.id,
            crewId: crew2.crew.id,
            expectedVersion: initial.version,
            reason: 'Should be blocked',
          },
          adminUserId,
        ),
      (err: Error) =>
        errorCode(err) === 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_ACTIVE_SESSION_BLOCK',
    );
  });
});
