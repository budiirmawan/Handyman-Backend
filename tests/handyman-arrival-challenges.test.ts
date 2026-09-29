import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  assignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import {
  createHandymanArrivalChallenge,
  consumeHandymanArrivalChallenge,
  HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS,
} from '../src/modules/handyman-arrival-challenges';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService }
  from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-07 Arrival Verification PART 01 — server-authoritative
 * arrival CHALLENGE foundation (FROZEN governance §F). Ten cases
 * prove: Lead-only gated PENDING issuance, hash-at-rest token
 * material, frozen server 120s TTL, one-live-PENDING cardinality
 * under concurrency, fail-closed single-use consumption with
 * server-clock expiry projection, and ZERO QR/GPS/geofence/
 * arrival-result/work-session/FM side effects. CONSUMED is token
 * consumption ONLY — never an arrival VERIFIED result.
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
  await pool.query(`TRUNCATE handyman_arrival_challenges,
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
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

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** Org/workforce realm (client → property → building + HR anchors). */
async function realmFixture(label = 'Realm') {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: `${label} Client`,
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
  return { client, property, building, organization, department,
    position };
}

/** Active provider context + ACTIVE crew (valid login-capable Lead). */
async function crewFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Field Providers',
  });
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `lead-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Lead',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `LEAD_${suffix()}`,
    fullName: 'Lead Worker',
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `CREW_${suffix()}`,
      name: 'Field Crew',
      leadWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  // Lead actor must hold Client context access (existing model).
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  return {
    vendor, providerContext, leadUser: linkedUser, leadProfile: profile,
    workerContext, crew: bundle.crew,
  };
}

/** A second login-linked ACTIVE member + worker context in a crew. */
async function addLinkedMember(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  provider: Awaited<ReturnType<typeof crewFixture>>,
) {
  const linkedUser = await userService.createUser({
    email: `member-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Member',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `MEM_${suffix()}`,
    fullName: 'Crew Member Worker',
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: provider.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: provider.providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  await handymanWorkCrewService.addHandymanCrewMember(
    {
      handymanCrewId: provider.crew.id,
      handymanWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  // Non-Lead actor holds Client access (isolates the Lead gate).
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  return { linkedUser, profile, workerContext };
}

/** AUTHORIZED execution scope via the full CR-HM-02→06 chain. */
async function scopeFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
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
    name: 'Tenant Space',
  });
  const company = await tenantCompanyService.createTenantCompany({
    clientId: realm.client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
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
      diagnosis: 'PART 01 fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id }, adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'Hours', quantity: 1, uomId,
    currency: 'IDR', finalQuotedUnitAmount: 100,
  }, adminUserId);
  await issueHandymanQuotationVersion(version.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, adminUserId);
  const decision = await decideHandymanQuotation(version.id, {
    decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
  }, adminUserId);
  const scope = decision.executionScope!;
  assert.equal(scope.status, 'AUTHORIZED');
  return { scope };
}

/** Realm + ACTIVE assignment of the crew to the AUTHORIZED scope. */
async function assignedFixture() {
  const realm = await realmFixture();
  const crew = await crewFixture(realm);
  const f = await scopeFixture(realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  assert.equal(assignment.status, 'ACTIVE');
  return { realm, crew, scope: f.scope, assignment };
}

/** Challenge row read by id (raw material introspection only). */
async function challengeRow(id: string) {
  const r = await q(
    `SELECT * FROM handyman_arrival_challenges WHERE id = $1`,
    [id],
  );
  return r.rows[0] as Record<string, unknown>;
}

/** Audit events for one challenge id (audit-only evidence). */
async function challengeEvents(challengeId: string) {
  const r = await q(
    `SELECT event_type FROM operational_events
      WHERE entity_type = 'HANDYMAN_ARRIVAL_CHALLENGE'
        AND entity_id = $1 ORDER BY created_at, id`,
    [challengeId],
  );
  return r.rows.map((x: { event_type: string }) => x.event_type);
}

describe('CR-HM-07 PART 01 — arrival challenge foundation', () => {
  it('1: authoritative assigned Lead creates exactly one PENDING challenge', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const res = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.crew.leadUser.id,
    );
    assert.ok(res.challenge.id);
    assert.equal(res.challenge.status, 'PENDING');
    assert.equal(res.challenge.clientId, f.realm.client.id);
    assert.equal(res.challenge.executionScopeId, f.scope.id);
    assert.equal(res.challenge.assignmentId, f.assignment.id);
    assert.equal(res.challenge.actorUserId, f.crew.leadUser.id);
    assert.equal(res.challenge.consumedAt, null);
    const row = await challengeRow(res.challenge.id);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.assignment_id, f.assignment.id);
    assert.equal(row.actor_user_id, f.crew.leadUser.id);
    assert.deepEqual(
      await challengeEvents(res.challenge.id),
      ['ARRIVAL_CHALLENGE_CREATED'],
    );
  });

  it('2: raw token returned once, NEVER persisted; stored hash differs', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const res = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.crew.leadUser.id,
    );
    assert.ok(res.token.length >= 43, 'base64url 32-byte token');
    const row = await challengeRow(res.challenge.id);
    assert.notEqual(row.token_hash, res.token,
      'raw token must never be persisted');
    assert.equal(
      row.token_hash,
      createHash('sha256').update(res.token, 'utf8').digest('hex'),
      'hash-at-rest per existing session-token convention',
    );
    // No raw-token column exists anywhere on the record.
    const raw = JSON.stringify(row);
    assert.equal(raw.includes(res.token), false);
    // Public boundary never carries token material.
    const pub = JSON.stringify(res.challenge);
    assert.equal(pub.includes(res.token), false);
    assert.equal('tokenHash' in res.challenge, false);
    // Journal never carries token material.
    const events = await q(
      `SELECT metadata FROM operational_events
        WHERE entity_id = $1`,
      [res.challenge.id],
    );
    assert.equal(JSON.stringify(events.rows).includes(res.token), false);
  });

  it('3: expiry is exactly the frozen server-controlled 120s-class TTL', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const res = await createHandymanArrivalChallenge(
      {
        executionScopeId: f.scope.id,
        // Caller-supplied time/TTL attempts are structurally ignored.
        expiresAt: '2999-01-01T00:00:00.000Z',
        ttlSeconds: 99999,
      } as unknown as { executionScopeId: string },
      f.crew.leadUser.id,
    );
    const created = new Date(res.challenge.createdAt).getTime();
    const expires = new Date(res.challenge.expiresAt).getTime();
    const ttlMs = expires - created;
    assert.ok(
      Math.abs(ttlMs - HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS * 1000)
        < 2_000,
      `TTL must be ~120s server clock (got ${ttlMs}ms)`,
    );
    assert.equal(
      res.challenge.expiresAt.startsWith('2999-'), false,
      'caller time must never win',
    );
    assert.equal(res.challenge.status, 'PENDING');
  });

  it('4: non-Lead identities (helper/member/admin) can never create', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    // ACTIVE crew member WITH Client access but NOT the Lead.
    const member = await addLinkedMember(f.realm, f.crew);
    await assert.rejects(
      () => createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id },
        member.linkedUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED',
    );
    // Privileged operator WITH Client access but NOT the Lead.
    await assert.rejects(
      () => createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED',
    );
    // A live assignment Lead change flips authority instantly: the
    // OLD Lead can no longer create; the NEW Lead can.
    await handymanWorkCrewService.designateHandymanCrewLead(
      {
        handymanCrewId: f.crew.crew.id,
        handymanWorkerContextId: member.workerContext.id,
      },
      adminUserId,
    );
    await assert.rejects(
      () => createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id },
        f.crew.leadUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED',
    );
    const res = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      member.linkedUser.id,
    );
    assert.equal(res.challenge.actorUserId, member.linkedUser.id);
  });

  it('5: no assignment / invalid Lead chain fails closed', async (t) => {
    if (!requireDatabase(t)) return;
    // AUTHORIZED scope with NO assignment at all.
    const realmA = await realmFixture('NoAssign');
    const f = await scopeFixture(realmA);
    const crew = await crewFixture(realmA);
    await assert.rejects(
      () => createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id },
        crew.leadUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED',
    );
    // Assigned, then Lead validity chain broken (crew deactivated).
    const g = await assignedFixture();
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      g.crew.crew.id, 'INACTIVE', adminUserId,
    );
    await assert.rejects(
      () => createHandymanArrivalChallenge(
        { executionScopeId: g.scope.id },
        g.crew.leadUser.id,
      ),
      (e: unknown) =>
        ['HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_INACTIVE',
          'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_LEAD_INVALID',
        ].includes(errorCode(e) ?? ''),
    );
    // Unknown scope fails closed as not-found (existing authority).
    await assert.rejects(
      () => createHandymanArrivalChallenge(
        { executionScopeId: randomUUID() },
        g.crew.leadUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );
  });

  it('6: caller authority/time/status/location smuggling is ignored', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const res = await createHandymanArrivalChallenge(
      {
        executionScopeId: f.scope.id,
        workerId: randomUUID(),
        crewId: randomUUID(),
        leadUserId: adminUserId,
        clientId: randomUUID(),
        assignmentId: randomUUID(),
        expectedLocation: { buildingId: randomUUID() },
        status: 'CONSUMED',
        expiresAt: '2999-01-01T00:00:00.000Z',
        ttlSeconds: 1,
        createdAt: '2001-01-01T00:00:00.000Z',
      } as unknown as { executionScopeId: string },
      f.crew.leadUser.id,
    );
    assert.equal(res.challenge.status, 'PENDING');
    assert.equal(res.challenge.clientId, f.realm.client.id);
    assert.equal(res.challenge.assignmentId, f.assignment.id);
    assert.equal(res.challenge.actorUserId, f.crew.leadUser.id);
    assert.equal(res.challenge.consumedAt, null);
    const pub = JSON.stringify(res.challenge);
    for (const forbidden of [
      'workerId', 'leadUserId', 'expectedLocation', 'buildingId',
      'ttlSeconds',
    ]) {
      assert.equal(pub.includes(forbidden), false,
        `forbidden caller/shadow field echoed: ${forbidden}`);
    }
    const row = await challengeRow(res.challenge.id);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.client_id, f.realm.client.id);
    assert.equal(row.assignment_id, f.assignment.id);
  });

  it('7: concurrent creation cannot produce >1 live PENDING challenge', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const attempts = await Promise.allSettled([
      createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id }, f.crew.leadUser.id,
      ),
      createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id }, f.crew.leadUser.id,
      ),
      createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id }, f.crew.leadUser.id,
      ),
    ]);
    const fulfilled = attempts.filter((x) => x.status === 'fulfilled');
    const rejected = attempts.filter((x) => x.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one creator may win');
    for (const r of rejected) {
      assert.equal(
        (r as PromiseRejectedResult).reason &&
          errorCode((r as PromiseRejectedResult).reason),
        'HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT',
      );
    }
    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE execution_scope_id = $1 AND actor_user_id = $2
          AND status = 'PENDING'`,
      [f.scope.id, f.crew.leadUser.id],
    );
    assert.equal(rows.rows[0].n, 1, 'at most one live PENDING');
    // Any further attempt keeps the ONE deterministic behavior.
    await assert.rejects(
      () => createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id }, f.crew.leadUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT',
    );
    const rows2 = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE execution_scope_id = $1 AND actor_user_id = $2
          AND status = 'PENDING'`,
      [f.scope.id, f.crew.leadUser.id],
    );
    assert.equal(rows2.rows[0].n, 1);
  });

  it('8: correct token consumes exactly once (CONSUMED + server consumedAt)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const created = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.crew.leadUser.id,
    );
    const consumed = await consumeHandymanArrivalChallenge(
      { challengeId: created.challenge.id, token: created.token },
      f.crew.leadUser.id,
    );
    assert.equal(consumed.id, created.challenge.id);
    assert.equal(consumed.status, 'CONSUMED');
    assert.ok(consumed.consumedAt, 'server-side consumedAt set');
    assert.ok(
      Math.abs(
        new Date(consumed.consumedAt!).getTime() - Date.now(),
      ) < 15_000,
      'consumedAt is server clock',
    );
    assert.deepEqual(
      await challengeEvents(created.challenge.id),
      ['ARRIVAL_CHALLENGE_CREATED', 'ARRIVAL_CHALLENGE_CONSUMED'],
    );
    const row = await challengeRow(created.challenge.id);
    assert.equal(row.status, 'CONSUMED');
    assert.notEqual(row.consumed_at, null);
  });

  it('9: wrong/replayed/expired token fails closed; expiry projected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const created = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.crew.leadUser.id,
    );
    // Wrong token: fail closed, row stays live PENDING, zero journal.
    await assert.rejects(
      () => consumeHandymanArrivalChallenge(
        { challengeId: created.challenge.id, token: 'wrong-token' },
        f.crew.leadUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_INVALID',
    );
    let row = await challengeRow(created.challenge.id);
    assert.equal(row.status, 'PENDING');
    assert.deepEqual(
      await challengeEvents(created.challenge.id),
      ['ARRIVAL_CHALLENGE_CREATED'],
    );
    // Replay after a successful consume: fail closed.
    await consumeHandymanArrivalChallenge(
      { challengeId: created.challenge.id, token: created.token },
      f.crew.leadUser.id,
    );
    await assert.rejects(
      () => consumeHandymanArrivalChallenge(
        { challengeId: created.challenge.id, token: created.token },
        f.crew.leadUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_INVALID',
    );
    // Expired challenge: pre-expired PENDING fixture row (server-time
    // past); consume projects EXPIRED + fails closed + journals.
    const expiredToken = `fixture-${randomUUID()}`;
    const expiredHash = createHash('sha256')
      .update(expiredToken, 'utf8').digest('hex');
    const expiredId = randomUUID();
    await q(
      `INSERT INTO handyman_arrival_challenges
         (id, client_id, execution_scope_id, assignment_id,
          actor_user_id, token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING',
               NOW() - INTERVAL '1 second')`,
      [expiredId, f.realm.client.id, f.scope.id, f.assignment.id,
        f.crew.leadUser.id, expiredHash],
    );
    await assert.rejects(
      () => consumeHandymanArrivalChallenge(
        { challengeId: expiredId, token: expiredToken },
        f.crew.leadUser.id,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_CHALLENGE_INVALID',
    );
    row = await challengeRow(expiredId);
    assert.equal(row.status, 'EXPIRED', 'server projection applied');
    assert.equal(row.consumed_at, null);
    assert.deepEqual(
      await challengeEvents(expiredId),
      ['ARRIVAL_CHALLENGE_EXPIRED'],
    );
    // Creation over an expired stale row: projected EXPIRED before the
    // new PENDING insert; exactly one live challenge results.
    const renewed = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.crew.leadUser.id,
    );
    assert.equal(renewed.challenge.status, 'PENDING');
    assert.notEqual(renewed.challenge.id, expiredId);
    const live = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE execution_scope_id = $1 AND actor_user_id = $2
          AND status = 'PENDING'`,
      [f.scope.id, f.crew.leadUser.id],
    );
    assert.equal(live.rows[0].n, 1);
  });

  it('10: ZERO QR/GPS/geofence/arrival-result/work-session/FM side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await assignedFixture();
    const created = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.crew.leadUser.id,
    );
    await consumeHandymanArrivalChallenge(
      { challengeId: created.challenge.id, token: created.token },
      f.crew.leadUser.id,
    );
    // No downstream/FM table gained a row anywhere.
    for (const table of [
      'handyman_scheduling_readiness',
      'handyman_unit_access_readiness',
      'work_orders',
      'vendor_quotations',
      'bast_documents',
    ]) {
      const r = await q(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(r.rows[0].n, 0, `${table} must stay empty`);
    }
    // Journal vocabulary is bounded to the three challenge events.
    const vocab = await q(
      `SELECT DISTINCT event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_ARRIVAL_CHALLENGE'`,
    );
    const legal = new Set([
      'ARRIVAL_CHALLENGE_CREATED',
      'ARRIVAL_CHALLENGE_CONSUMED',
      'ARRIVAL_CHALLENGE_EXPIRED',
    ]);
    for (const r of vocab.rows as { event_type: string }[]) {
      assert.ok(legal.has(r.event_type),
        `journal vocabulary breach: ${r.event_type}`);
    }
    assert.ok(vocab.rows.length > 0);
    // The challenge table carries NO QR/location/geofence/result/
    // session/schedule semantics (schema-level firewall).
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_arrival_challenges'`,
    );
    const names = cols.rows
      .map((c: { column_name: string }) => c.column_name);
    assert.deepEqual(names.sort(), [
      'actor_user_id',
      'assignment_id',
      'client_id',
      'consumed_at',
      'created_at',
      'execution_scope_id',
      'expires_at',
      'id',
      'status',
      'token_hash',
      'updated_at',
    ]);
    for (const n of names) {
      assert.equal(
        /qr|gps|geofence|location|verdict|result|session|schedule|attendance|payment|bast|work_order/i
          .test(n),
        false,
        `forbidden semantic column leaked: ${n}`,
      );
    }
    // PENDING -> CONSUMED was the ONLY lifecycle movement on this
    // scope (no assignment mutation, no scope mutation).
    const scope = await q(
      `SELECT status FROM handyman_execution_scopes WHERE id = $1`,
      [f.scope.id],
    );
    assert.equal(scope.rows[0].status, 'AUTHORIZED');
    const assignment = await q(
      `SELECT status FROM handyman_execution_scope_assignments
        WHERE id = $1`,
      [f.assignment.id],
    );
    assert.equal(assignment.rows[0].status, 'ACTIVE');
  });
});
