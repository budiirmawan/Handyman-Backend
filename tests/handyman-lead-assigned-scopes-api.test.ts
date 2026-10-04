import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
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
    assert.equal(scope.location.buildingLabel, 'Building');
    assert.equal(scope.location.floorLabel, 'Floor');
    assert.equal(scope.location.areaLabel, 'Area');
    assert.equal(scope.location.roomLabel, 'Room');
    assert.equal(scope.location.spaceLabel, 'Tenant Space');
    assert.deepEqual(scope.workItems, [{
      lineType: 'LABOR',
      description: 'Hours',
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

  it('publishes exactly the two frozen GET operations in OpenAPI', () => {
    const document = YAML.parse(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const list = document.paths['/handyman/lead/assigned-scopes'];
    const detail = document.paths[
      '/handyman/lead/assigned-scopes/{executionScopeId}'
    ];
    assert.deepEqual(Object.keys(list), ['get']);
    assert.deepEqual(Object.keys(detail), ['get']);
    assert.equal(list.get.operationId, 'listHandymanLeadAssignedScopes');
    assert.equal(detail.get.operationId, 'getHandymanLeadAssignedScope');
    assert.deepEqual(
      list.get.parameters.map((parameter: { name: string }) => parameter.name),
      ['page', 'pageSize'],
    );
    assert.equal(list.get.security[0].bearerAuth.length, 0);
    assert.equal(detail.get.security[0].bearerAuth.length, 0);
  });
});
