import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import {
  createHandymanPermitReadiness,
  createHandymanSchedulingReadiness,
  createHandymanUnitAccessReadiness,
} from '../src/modules/handyman-scheduling';
import {
  addHandymanCrewMember,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
import {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import { permissionService } from '../src/modules/permissions';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser, createPlainSession } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { parseHandymanLeadAssignedScopesPagination, parseHandymanLeadExecutionScopeId }
  from '../src/modules/handyman-lead-assigned-scopes-api/handyman-lead-assigned-scopes-api.validation';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const LEAD_READS = `${V1}/handyman/lead/assigned-scopes`;
const WINDOW_START = '2030-01-05T09:00:00.000Z';
const WINDOW_END = '2030-01-05T13:00:00.000Z';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_permit_readiness,
    handyman_unit_access_readiness, handyman_scheduling_readiness,
    handyman_execution_scope_assignments, handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships, handyman_work_crews,
    handyman_worker_contexts, handyman_provider_contexts,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics, vendors,
    workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await (await import(
    '../src/modules/handyman-disciplines'
  )).handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('test database is not initialized');
      return pool.query(text, params);
    },
  });
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function loginAs(user: { id: string; email: string }): Promise<string> {
  const password = `LeadPass-${randomUUID().slice(0, 10)}`;
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const login = await api().post(`${V1}/auth/login`).send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}

async function assignToCrew(
  scopeId: string,
  crew: Awaited<ReturnType<typeof crewFixture>>,
) {
  return assignHandymanExecutionScopeCrew({
    executionScopeId: scopeId,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
}

async function addLinkedHelper(
  realm: Awaited<ReturnType<typeof baseFixture>>['realm'],
  crew: Awaited<ReturnType<typeof crewFixture>>,
) {
  const user = await userService.createUser({
    email: `helper-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Helper',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `HELP_${suffix()}`,
    fullName: 'Helper Worker',
    workforceType: 'EXTERNAL',
    userId: user.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: crew.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext({
      handymanProviderContextId: crew.providerContext.id,
      workforceProfileId: profile.id,
    }, adminUserId);
  await addHandymanCrewMember({
    handymanCrewId: crew.crew.id,
    handymanWorkerContextId: workerContext.id,
  }, adminUserId);
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: realm.building.id,
  });
  return { user, workerContext, token: await loginAs(user) };
}

describe('CR-HM-18 BE03 — Lead assigned-scope reads', () => {
  it('accepts only frozen pagination and execution-scope identifier inputs', () => {
    const query = (value: Record<string, unknown>) => value as never;
    assert.deepEqual(
      parseHandymanLeadAssignedScopesPagination(query({})),
      { page: 1, pageSize: 50 },
    );
    assert.deepEqual(
      parseHandymanLeadAssignedScopesPagination(
        query({ page: '2', pageSize: '100' }),
      ),
      { page: 2, pageSize: 100 },
    );
    assert.throws(() => parseHandymanLeadAssignedScopesPagination(
      query({ clientId: randomUUID() }),
    ));
    assert.throws(() => parseHandymanLeadAssignedScopesPagination(
      query({ pageSize: '101' }),
    ));
    const id = randomUUID();
    assert.equal(parseHandymanLeadExecutionScopeId(id.toUpperCase()), id);
    assert.throws(() => parseHandymanLeadExecutionScopeId('not-a-uuid'));
  });

  it('returns only current assigned scopes with the frozen field-safe DTO/readiness', async (t) => {
    if (!requireDatabase(t)) return;

    const first = await baseFixture();
    const second = await scopeFixture(
      first.realm,
      await locationChain(first.realm),
    );
    const unassigned = await scopeFixture(
      first.realm,
      await locationChain(first.realm),
    );
    const crew = await crewFixture(first.realm);
    await assignToCrew(first.scope.id, crew);
    await assignToCrew(second.scope.id, crew);
    const token = await loginAs(crew.leadUser);

    // Lead reads do not use tenant_company.read. The real authenticated Lead
    // session has no RBAC role/permission grant.
    const permissions = await permissionService.resolvePermissionsForUser(
      crew.leadUser.id,
    );
    assert.equal(permissions.includes('tenant_company.read'), false);

    await q('UPDATE buildings SET timezone = $1 WHERE id = $2', [
      'Asia/Jakarta', first.realm.building.id,
    ]);
    await createHandymanSchedulingReadiness({
      handymanRequestId: first.scope.handymanRequestId,
      preferredWindowStart: WINDOW_START,
      preferredWindowEnd: WINDOW_END,
    }, adminUserId);
    const accessNote = 'PRIVATE ACCESS AUTHORIZATION NOTE';
    await createHandymanUnitAccessReadiness({
      handymanRequestId: first.scope.handymanRequestId,
      accessWindowStart: WINDOW_START,
      accessWindowEnd: WINDOW_END,
      authorizationNote: accessNote,
    }, adminUserId);
    const permitNote = 'PRIVATE PERMIT AUTHORIZATION NOTE';
    await createHandymanPermitReadiness({
      handymanRequestId: first.scope.handymanRequestId,
      permitType: 'UNIT',
      validFrom: WINDOW_START,
      validUntil: WINDOW_END,
      authorizationNote: permitNote,
    }, adminUserId);

    const listed = await api().get(LEAD_READS).set(auth(token));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.meta, {
      page: 1,
      pageSize: 50,
      total: 2,
      totalPages: 1,
    });
    assert.equal(listed.body.data.length, 2);
    assert.deepEqual(
      listed.body.data.find((row: { executionScopeId: string }) =>
        row.executionScopeId === first.scope.id).preferredWindow,
      {
        preferredWindowStart: WINDOW_START,
        preferredWindowEnd: WINDOW_END,
        timezone: 'Asia/Jakarta',
      },
    );
    assert.equal(
      listed.body.data.some((row: { executionScopeId: string }) =>
        row.executionScopeId === unassigned.scope.id),
      false,
    );
    const expectedOrder = [...listed.body.data]
      .sort((a: { assignedAt: string; executionScopeId: string },
        b: { assignedAt: string; executionScopeId: string }) =>
        b.assignedAt.localeCompare(a.assignedAt)
        || a.executionScopeId.localeCompare(b.executionScopeId))
      .map((row: { executionScopeId: string }) => row.executionScopeId);
    assert.deepEqual(
      listed.body.data.map((row: { executionScopeId: string }) =>
        row.executionScopeId),
      expectedOrder,
    );
    for (const card of listed.body.data) {
      assert.deepEqual(Object.keys(card).sort(), [
        'assignmentId', 'assignmentStatus', 'assignedAt',
        'executionScopeId', 'location', 'preferredWindow',
        'scopeStatus', 'serviceLabel',
      ].sort());
      assert.equal(card.assignmentStatus, 'ACTIVE');
      assert.equal(card.scopeStatus, 'AUTHORIZED');
    }

    const page1 = await api().get(LEAD_READS)
      .query({ page: 1, pageSize: 1 })
      .set(auth(token));
    const page2 = await api().get(LEAD_READS)
      .query({ page: 2, pageSize: 1 })
      .set(auth(token));
    assert.equal(page1.status, 200);
    assert.equal(page2.status, 200);
    assert.equal(page1.body.meta.total, 2);
    assert.equal(page1.body.meta.totalPages, 2);
    assert.equal(page2.body.meta.page, 2);
    assert.notEqual(
      page1.body.data[0].executionScopeId,
      page2.body.data[0].executionScopeId,
    );

    const detail = await api().get(
      `${LEAD_READS}/${first.scope.id}`,
    ).set(auth(token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const scope = detail.body.data;
    assert.deepEqual(Object.keys(scope).sort(), [
      'assignmentId', 'assignmentStatus', 'assignedAt',
      'executionScopeId', 'location', 'readiness', 'scopeStatus',
      'serviceLabel', 'workItems',
    ].sort());
    assert.equal(scope.executionScopeId, first.scope.id);
    assert.equal(scope.assignmentStatus, 'ACTIVE');
    assert.equal(scope.scopeStatus, 'AUTHORIZED');
    assert.equal(scope.serviceLabel, 'Handyman Service');
    assert.equal(
      scope.location.buildingLabel,
      `Building ${first.realm.building.code}`,
    );
    assert.equal(scope.location.floorLabel, `Floor ${first.chain.floor.levelNumber}`);
    assert.equal(scope.location.areaLabel, `Area ${first.chain.area.code}`);
    assert.equal(scope.location.roomLabel, `Room ${first.chain.room.code}`);
    assert.equal(scope.location.spaceLabel, `Space ${first.chain.space.code}`);
    assert.deepEqual(scope.workItems, [{
      lineType: 'LABOR',
      description: 'Labor work item',
      quantity: 1,
      unitLabel: 'Meter',
    }]);
    assert.deepEqual(scope.readiness, {
      scheduling: {
        status: 'ACTIVE',
        preferredWindowStart: WINDOW_START,
        preferredWindowEnd: WINDOW_END,
        timezone: 'Asia/Jakarta',
      },
      unitAccess: {
        status: 'ACTIVE',
        accessWindowStart: WINDOW_START,
        accessWindowEnd: WINDOW_END,
      },
      permitReadiness: [{
        permitType: 'UNIT',
        status: 'ACTIVE',
        validFrom: WINDOW_START,
        validUntil: WINDOW_END,
      }],
    });
    assert.deepEqual(Object.keys(scope.workItems[0]).sort(), [
      'description', 'lineType', 'quantity', 'unitLabel',
    ].sort());
    assert.equal(JSON.stringify(scope).includes(accessNote), false);
    assert.equal(JSON.stringify(scope).includes(permitNote), false);
    assert.equal(JSON.stringify(scope).includes('finalQuotedUnitAmount'), false);
    assert.equal(JSON.stringify(scope).includes('tenantCompanyId'), false);

    const missingReadiness = await api().get(
      `${LEAD_READS}/${second.scope.id}`,
    ).set(auth(token));
    assert.equal(missingReadiness.status, 200);
    assert.deepEqual(missingReadiness.body.data.readiness, {
      scheduling: null,
      unitAccess: null,
      permitReadiness: [],
    });

    const unknownFilter = await api().get(LEAD_READS)
      .query({ clientId: first.realm.client.id })
      .set(auth(token));
    assert.equal(unknownFilter.status, 400);
    const excessivePageSize = await api().get(LEAD_READS)
      .query({ pageSize: 101 })
      .set(auth(token));
    assert.equal(excessivePageSize.status, 400);
    const unassignedDetail = await api().get(
      `${LEAD_READS}/${unassigned.scope.id}`,
    ).set(auth(token));
    assert.equal(unassignedDetail.status, 404);
  });

  it('issues a minimal one-time arrival challenge only to the authorized current Lead', async (t) => {
    if (!requireDatabase(t)) return;

    const first = await baseFixture();
    const unassigned = await scopeFixture(
      first.realm,
      await locationChain(first.realm),
    );
    const foreignRealm = await realmFixture();
    const foreign = await scopeFixture(
      foreignRealm,
      await locationChain(foreignRealm),
    );
    const crew = await crewFixture(first.realm);
    const assignment = await assignToCrew(first.scope.id, crew);
    const leadToken = await loginAs(crew.leadUser);
    const challengePath = `${LEAD_READS}/${first.scope.id}/arrival-challenge`;

    const unauthenticated = await api().post(challengePath).send({});
    assert.equal(unauthenticated.status, 401);
    const smuggledBody = await api().post(challengePath)
      .set(auth(leadToken))
      .send({ clientId: first.realm.client.id });
    assert.equal(smuggledBody.status, 400);

    const issued = await api().post(challengePath)
      .set(auth(leadToken))
      .send({});
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(issued.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(issued.body.data).sort(), [
      'challengeId',
      'challengeToken',
      'executionScopeId',
      'expiresAt',
    ].sort());
    assert.equal(issued.body.data.executionScopeId, first.scope.id);
    assert.equal(typeof issued.body.data.challengeToken, 'string');
    assert.ok(issued.body.data.challengeToken.length >= 43);
    assert.ok(Number.isFinite(Date.parse(issued.body.data.expiresAt)));

    const stored = await q(
      `SELECT client_id, execution_scope_id, assignment_id, actor_user_id,
              token_hash, status,
              EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl_seconds
         FROM handyman_arrival_challenges
        WHERE id = $1`,
      [issued.body.data.challengeId],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].client_id, first.realm.client.id);
    assert.equal(stored.rows[0].execution_scope_id, first.scope.id);
    assert.equal(stored.rows[0].assignment_id, assignment.id);
    assert.equal(stored.rows[0].actor_user_id, crew.leadUser.id);
    assert.equal(stored.rows[0].status, 'PENDING');
    assert.equal(Number(stored.rows[0].ttl_seconds), 120);
    assert.equal(
      stored.rows[0].token_hash,
      createHash('sha256')
        .update(issued.body.data.challengeToken, 'utf8')
        .digest('hex'),
    );

    const duplicate = await api().post(challengePath)
      .set(auth(leadToken))
      .send({});
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT',
    );

    const helper = await addLinkedHelper(first.realm, crew);
    const helperBeforeDesignation = await api().post(challengePath)
      .set(auth(helper.token))
      .send({});
    assert.equal(helperBeforeDesignation.status, 403);
    await handymanWorkCrewService.designateHandymanCrewLead({
      handymanCrewId: crew.crew.id,
      handymanWorkerContextId: helper.workerContext.id,
    }, adminUserId);
    const formerLead = await api().post(challengePath)
      .set(auth(leadToken))
      .send({});
    assert.equal(formerLead.status, 403);

    const noAssignment = await api().post(
      `${LEAD_READS}/${unassigned.scope.id}/arrival-challenge`,
    ).set(auth(helper.token)).send({});
    assert.equal(noAssignment.status, 403);
    const noClientAccess = await api().post(
      `${LEAD_READS}/${foreign.scope.id}/arrival-challenge`,
    ).set(auth(helper.token)).send({});
    assert.equal(noClientAccess.status, 403);
  });

  it('omits unlabelled and customer/tenant/PIC personal names from field projections', async (t) => {
    if (!requireDatabase(t)) return;

    const realm = await realmFixture();
    const unlabelledName = 'Rina Wijaya';
    const customerName = 'Budi Santoso';
    const tenantName = 'Siti Rahma';
    const picName = 'Dimas Putra';
    const chain = await locationChain(realm, {
      floorName: unlabelledName,
      areaName: `Customer: ${customerName}`,
      roomName: `Tenant: ${tenantName}`,
      spaceName: `PIC: ${picName}`,
    });
    const workDescription = [
      `Inspect for ${unlabelledName}`,
      `Customer: ${customerName}`,
      `Tenant: ${tenantName}`,
      `PIC: ${picName}`,
    ].join('; ');
    const { scope } = await scopeFixture(realm, chain, workDescription);
    const crew = await crewFixture(realm);
    await assignToCrew(scope.id, crew);
    const token = await loginAs(crew.leadUser);

    const detail = await api().get(`${LEAD_READS}/${scope.id}`)
      .set(auth(token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const listed = await api().get(LEAD_READS).set(auth(token));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const serialized = JSON.stringify({
      detail: detail.body.data,
      list: listed.body.data,
    });
    assert.equal(serialized.includes(workDescription), false);
    for (const personalName of [
      unlabelledName,
      customerName,
      tenantName,
      picName,
    ]) {
      assert.equal(serialized.includes(personalName), false);
    }
    assert.equal(serialized.includes('Customer:'), false);
    assert.equal(serialized.includes('Tenant:'), false);
    assert.equal(serialized.includes('PIC:'), false);
    const expectedLocation = {
      buildingLabel: `Building ${realm.building.code}`,
      floorLabel: `Floor ${chain.floor.levelNumber}`,
      areaLabel: `Area ${chain.area.code}`,
      roomLabel: `Room ${chain.room.code}`,
      spaceLabel: `Space ${chain.space.code}`,
    };
    assert.deepEqual(detail.body.data.location, expectedLocation);
    assert.deepEqual(listed.body.data[0].location, expectedLocation);
    assert.deepEqual(detail.body.data.workItems, [{
      lineType: 'LABOR',
      description: 'Labor work item',
      quantity: 1,
      unitLabel: 'Meter',
    }]);
  });

  it('isolates assigned-scope reads across Clients for a current Lead', async (t) => {
    if (!requireDatabase(t)) return;

    const local = await baseFixture();
    const foreignRealm = await realmFixture();
    const foreignChain = await locationChain(foreignRealm);
    const foreign = await scopeFixture(foreignRealm, foreignChain);
    const localCrew = await crewFixture(local.realm);
    const foreignCrew = await crewFixture(foreignRealm);
    await assignToCrew(local.scope.id, localCrew);
    await assignToCrew(foreign.scope.id, foreignCrew);
    const localLeadToken = await loginAs(localCrew.leadUser);

    const listed = await api().get(LEAD_READS).set(auth(localLeadToken));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.data.map((row: { executionScopeId: string }) =>
        row.executionScopeId),
      [local.scope.id],
    );
    assert.equal(listed.body.meta.total, 1);
    const foreignDetail = await api().get(
      `${LEAD_READS}/${foreign.scope.id}`,
    ).set(auth(localLeadToken));
    assert.equal(foreignDetail.status, 404);
  });

  it('requires the authenticated current Lead chain and Client access on each read', async (t) => {
    if (!requireDatabase(t)) return;

    const f = await baseFixture();
    const firstCrew = await crewFixture(f.realm);
    await assignToCrew(f.scope.id, firstCrew);
    const firstLeadToken = await loginAs(firstCrew.leadUser);

    const unauthenticated = await api().get(LEAD_READS);
    assert.equal(unauthenticated.status, 401);
    const outsiderToken = await createPlainSession();
    const outsiderList = await api().get(LEAD_READS)
      .set(auth(outsiderToken));
    assert.equal(outsiderList.status, 200);
    assert.deepEqual(outsiderList.body.data, []);
    const outsiderDetail = await api().get(
      `${LEAD_READS}/${f.scope.id}`,
    ).set(auth(outsiderToken));
    assert.equal(outsiderDetail.status, 404);

    const malformedId = await api().get(`${LEAD_READS}/not-a-uuid`)
      .set(auth(firstLeadToken));
    assert.equal(malformedId.status, 400);
    const helper = await addLinkedHelper(f.realm, firstCrew);
    const helperList = await api().get(LEAD_READS)
      .set(auth(helper.token));
    assert.equal(helperList.status, 200);
    assert.deepEqual(helperList.body.data, []);
    const helperDetail = await api().get(
      `${LEAD_READS}/${f.scope.id}`,
    ).set(auth(helper.token));
    assert.equal(helperDetail.status, 404);

    // A current CR-HM-04 Lead designation change is reflected immediately;
    // the former designated Lead loses the read and the new Lead gains it.
    await handymanWorkCrewService.designateHandymanCrewLead({
      handymanCrewId: firstCrew.crew.id,
      handymanWorkerContextId: helper.workerContext.id,
    }, adminUserId);
    const designatedHelperDetail = await api().get(
      `${LEAD_READS}/${f.scope.id}`,
    ).set(auth(helper.token));
    assert.equal(designatedHelperDetail.status, 200);
    const helperCurrentList = await api().get(LEAD_READS)
      .set(auth(helper.token));
    assert.equal(helperCurrentList.status, 200);
    assert.equal(helperCurrentList.body.meta.total, 1);
    const formerDesignatedLead = await api().get(
      `${LEAD_READS}/${f.scope.id}`,
    ).set(auth(firstLeadToken));
    assert.equal(formerDesignatedLead.status, 404);
    const formerDesignatedList = await api().get(LEAD_READS)
      .set(auth(firstLeadToken));
    assert.deepEqual(formerDesignatedList.body.data, []);

    const nextCrew = await crewFixture(f.realm);
    await reassignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: nextCrew.providerContext.id,
      crewId: nextCrew.crew.id,
    }, adminUserId);
    const formerLeadDetail = await api().get(
      `${LEAD_READS}/${f.scope.id}`,
    ).set(auth(firstLeadToken));
    assert.equal(formerLeadDetail.status, 404);
    const formerLeadList = await api().get(LEAD_READS)
      .set(auth(firstLeadToken));
    assert.equal(formerLeadList.status, 200);
    assert.deepEqual(formerLeadList.body.data, []);

    const nextLeadToken = await loginAs(nextCrew.leadUser);
    const currentLeadDetail = await api().get(
      `${LEAD_READS}/${f.scope.id}`,
    ).set(auth(nextLeadToken));
    assert.equal(currentLeadDetail.status, 200);

    await buildingAssignmentService.deactivateAssignment(
      nextCrew.leadUser.id,
      f.realm.building.id,
    );
    const denied = await api().get(
      `${LEAD_READS}/${f.scope.id}`,
    ).set(auth(nextLeadToken));
    assert.equal(denied.status, 403);
    const noAccessibleClient = await api().get(LEAD_READS)
      .set(auth(nextLeadToken));
    assert.equal(noAccessibleClient.status, 200);
    assert.deepEqual(noAccessibleClient.body.data, []);
    assert.equal(noAccessibleClient.body.meta.total, 0);
  });

  it('publishes the current Lead GET operations and material progress DTO in OpenAPI', () => {
    const document = YAML.parse(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const list = document.paths['/handyman/lead/assigned-scopes'];
    const detail = document.paths[
      '/handyman/lead/assigned-scopes/{executionScopeId}'
    ];
    const materialProgress = document.paths[
      '/handyman/lead/assigned-scopes/{executionScopeId}/material-progress'
    ];
    assert.deepEqual(Object.keys(list), ['get']);
    assert.deepEqual(Object.keys(detail), ['get']);
    assert.deepEqual(Object.keys(materialProgress), ['get']);
    assert.equal(list.get.operationId, 'listHandymanLeadAssignedScopes');
    assert.equal(detail.get.operationId, 'getHandymanLeadAssignedScope');
    assert.equal(materialProgress.get.operationId,
      'getHandymanLeadMaterialProgress');
    assert.deepEqual(
      list.get.parameters.map((parameter: { name: string }) => parameter.name),
      ['page', 'pageSize'],
    );
    assert.equal(list.get.security[0].bearerAuth.length, 0);
    assert.equal(detail.get.security[0].bearerAuth.length, 0);
    assert.equal(materialProgress.get.security[0].bearerAuth.length, 0);
    assert.equal(
      materialProgress.get.responses['200'].content['application/json']
        .schema.allOf[1].properties.data.$ref,
      '#/components/schemas/HandymanLeadMaterialProgress',
    );
    const progressSchema = document.components.schemas
      .HandymanLeadMaterialProgress;
    assert.deepEqual(progressSchema.required,
      ['executionScopeId', 'lines', 'finalUsedByUom']);
    const lineSchema = document.components.schemas
      .HandymanLeadMaterialProgressLine;
    assert.ok(lineSchema.required.includes('uom'));
    assert.ok(lineSchema.required.includes('finalUsedQty'));
  });

  it('publishes the frozen authenticated arrival-challenge operation in OpenAPI', () => {
    const document = YAML.parse(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const path = document.paths[
      '/handyman/lead/assigned-scopes/{executionScopeId}/arrival-challenge'
    ];
    assert.deepEqual(Object.keys(path), ['post']);
    assert.equal(path.post.operationId, 'createHandymanLeadArrivalChallenge');
    assert.equal(path.post.requestBody, undefined);
    assert.deepEqual(
      path.post.parameters.map((parameter: { name: string }) => parameter.name),
      ['executionScopeId'],
    );
    assert.equal(path.post.security[0].bearerAuth.length, 0);
    assert.deepEqual(
      path.post.responses['201'].headers['Cache-Control'].schema.enum,
      ['no-store'],
    );
    const challengeData = document.components.schemas
      .HandymanLeadArrivalChallengeIssueData;
    assert.equal(challengeData.additionalProperties, false);
    assert.deepEqual(challengeData.required, [
      'challengeId',
      'executionScopeId',
      'challengeToken',
      'expiresAt',
    ]);
    assert.deepEqual(Object.keys(challengeData.properties).sort(), [
      'challengeId',
      'executionScopeId',
      'challengeToken',
      'expiresAt',
    ].sort());
  });
});
