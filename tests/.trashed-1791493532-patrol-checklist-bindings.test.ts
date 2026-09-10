import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { findingService } from '../src/modules/findings';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       patrol_checklist_bindings,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       evidence_submissions, evidence_requirements,
       finding_rework_cycles, reviews, finding_assignments, findings,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       schedule_definitions, schedule_recurrence,
       floors, areas, rooms, spaces, functional_locations,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Patrol client',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });

  const startPostA = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({
        code: `SP_${suffix()}`,
        name: 'Start Post A',
        postType: 'LOBBY',
      })
  ).body.data;
  const startPostB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({
        code: `SP_${suffix()}`,
        name: 'Start Post B',
        postType: 'GATE',
      })
  ).body.data;
  const startPostInactive = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({
        code: `SP_${suffix()}`,
        name: 'Inactive Post',
        postType: 'STANDBY',
      })
  ).body.data;
  await api()
    .patch(`/api/v1/security/posts/${startPostInactive.id}`)
    .set(auth())
    .send({ status: 'INACTIVE' });

  const routeA = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `PR_${suffix()}`,
        name: 'Route A',
        startSecurityPostId: startPostA.id,
      })
  ).body.data;
  // Add one route point so the route is boundable.
  await api()
    .post(`/api/v1/security/patrol-routes/${routeA.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  const routeInactiveA = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `PR_${suffix()}`,
        name: 'Route Inactive A',
      })
  ).body.data;
  await api()
    .patch(`/api/v1/security/patrol-routes/${routeInactiveA.id}`)
    .set(auth())
    .send({ status: 'INACTIVE' });

  const routeB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `PR_${suffix()}`,
        name: 'Route B',
        startSecurityPostId: startPostB.id,
      })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeB.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  // BE-07 ACTIVE Checklist Template (client A)
  const tplActive = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
      .set(auth())
      .send({ code: `CHK_${suffix()}`, name: 'Active Template' })
  ).body.data;
  await api()
    .patch(`/api/v1/checklist-templates/${tplActive.id}`)
    .set(auth())
    .send({ status: 'ACTIVE' });

  const tplDraft = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
      .set(auth())
      .send({ code: `CHK_${suffix()}`, name: 'Draft Template' })
  ).body.data;

  // Cross-client template (client C)
  const tplC = (
    await api()
      .post(`/api/v1/clients/${clientC.id}/checklist-templates`)
      .set(auth())
      .send({ code: `CHK_${suffix()}`, name: 'Other-client Template' })
  ).body.data;
  await api()
    .patch(`/api/v1/checklist-templates/${tplC.id}`)
    .set(auth())
    .send({ status: 'ACTIVE' });

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    startPostA,
    startPostB,
    startPostInactive,
    routeA,
    routeInactiveA,
    routeB,
    tplActive,
    tplDraft,
    tplC,
  };
}

async function bind(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post('/api/v1/security/patrol-checklist-bindings')
    .set(auth(token))
    .send(body);
}

describe('BE-12E patrol checklist binding', () => {
  it('binds a checklist template to a patrol route + start post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
      startSecurityPostId: f.startPostA.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const binding = response.body.data;

    assert.equal(binding.buildingId, f.buildingA.id);
    assert.equal(binding.clientId, f.clientA.id);
    assert.equal(binding.patrolRouteId, f.routeA.id);
    assert.equal(binding.checklistTemplateId, f.tplActive.id);
    assert.equal(binding.startSecurityPostId, f.startPostA.id);
    assert.equal(binding.status, 'ACTIVE');

    const byId = await api()
      .get(`/api/v1/security/patrol-checklist-bindings/${binding.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, binding.id);

    const byRoute = await api()
      .get('/api/v1/security/patrol-checklist-bindings')
      .query({ patrolRouteId: f.routeA.id })
      .set(auth());
    assert.equal(byRoute.status, 200, JSON.stringify(byRoute.body));
    assert.ok(
      byRoute.body.data.some((b: { id: string }) => b.id === binding.id),
    );

    const all = await api()
      .get('/api/v1/security/patrol-checklist-bindings')
      .set(auth());
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(all.body.data.some((b: { id: string }) => b.id === binding.id));
  });

  it('binds a checklist template without a start post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.startSecurityPostId, null);
  });

  it('rejects unknown building, route, template, and inactive ones', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknownBuilding = await bind({
      buildingId: randomUUID(),
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');

    const unknownRoute = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: randomUUID(),
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(unknownRoute.status, 404);

    const inactiveRoute = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeInactiveA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(inactiveRoute.status, 400);
    assert.equal(
      inactiveRoute.body.error.code,
      'PATROL_CHECKLIST_ROUTE_INACTIVE',
    );

    const unknownTemplate = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: randomUUID(),
    });
    assert.equal(unknownTemplate.status, 404);

    const draftTemplate = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplDraft.id,
    });
    assert.equal(draftTemplate.status, 400);
    assert.equal(
      draftTemplate.body.error.code,
      'PATROL_CHECKLIST_TEMPLATE_NOT_ACTIVE',
    );
  });

  it('rejects cross-building route references', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeB.id, // route belongs to building B
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'BAD_REQUEST',
    );
  });

  it('rejects cross-client templates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplC.id, // belongs to client C
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_CHECKLIST_TEMPLATE_CLIENT_MISMATCH',
    );
  });

  it('rejects cross-building or inactive start security post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const crossBuilding = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
      startSecurityPostId: f.startPostB.id,
    });
    assert.equal(crossBuilding.status, 400);
    assert.equal(
      crossBuilding.body.error.code,
      'PATROL_CHECKLIST_START_SECURITY_POST_BUILDING_MISMATCH',
    );

    const inactive = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
      startSecurityPostId: f.startPostInactive.id,
    });
    assert.equal(inactive.status, 400);
    assert.equal(
      inactive.body.error.code,
      'PATROL_CHECKLIST_START_SECURITY_POST_INACTIVE',
    );
  });

  it('prevents duplicate active bindings and allows re-binding after deactivation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'PATROL_CHECKLIST_BINDING_ALREADY_EXISTS',
    );

    const deactivated = await api()
      .patch(
        `/api/v1/security/patrol-checklist-bindings/${first.body.data.id}`,
      )
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const rebound = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(rebound.status, 201, JSON.stringify(rebound.body));
  });

  it('starts the shared BE-07 checklist execution from a binding', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
      startSecurityPostId: f.startPostA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(
        `/api/v1/security/patrol-checklist-bindings/${binding.body.data.id}/start`,
      )
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const execution = started.body.data;
    assert.equal(execution.checklistTemplateId, f.tplActive.id);
    assert.equal(execution.patrolChecklistBindingId, binding.body.data.id);
    assert.equal(execution.status, 'DRAFT');

    // The execution is a first-class BE-07 record: the shared checklist
    // execution endpoint reads and drives it without any binding logic.
    const shared = await api()
      .get(`/api/v1/checklist-executions/${execution.id}`)
      .set(auth());
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.id, execution.id);

    const startedShared = await api()
      .post(`/api/v1/checklist-executions/${execution.id}/start`)
      .set(auth());
    assert.equal(startedShared.status, 200, JSON.stringify(startedShared.body));
    assert.equal(startedShared.body.data.status, 'IN_PROGRESS');

    // INACTIVE bindings cannot start executions.
    const deactivated = await api()
      .patch(
        `/api/v1/security/patrol-checklist-bindings/${binding.body.data.id}`,
      )
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    const rejected = await api()
      .post(
        `/api/v1/security/patrol-checklist-bindings/${binding.body.data.id}/start`,
      )
      .set(auth());
    assert.equal(rejected.status, 400);
    assert.equal(
      rejected.body.error.code,
      'PATROL_CHECKLIST_BINDING_INACTIVE',
    );
  });

  it('resolves the execution context to the correct building, route, and post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
      startSecurityPostId: f.startPostA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(
        `/api/v1/security/patrol-checklist-bindings/${binding.body.data.id}/start`,
      )
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const context = await api()
      .get(`/api/v1/security/patrol-checklist-executions/${executionId}`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    const data = context.body.data;

    assert.equal(data.execution.id, executionId);
    assert.equal(data.building.id, f.buildingA.id);
    assert.equal(data.building.code, f.buildingA.code);
    assert.equal(data.template.id, f.tplActive.id);
    assert.equal(data.template.code, f.tplActive.code);
    assert.equal(data.patrolRoute.id, f.routeA.id);
    assert.equal(data.patrolRoute.code, f.routeA.code);
    assert.equal(data.startSecurityPost.id, f.startPostA.id);
    assert.equal(data.startSecurityPost.code, f.startPostA.code);

    // Unknown or plain BE-07 executions carry no patrol context.
    const unknown = await api()
      .get(`/api/v1/security/patrol-checklist-executions/${randomUUID()}`)
      .set(auth());
    assert.equal(unknown.status, 404);
    assert.equal(
      unknown.body.error.code,
      'PATROL_CHECKLIST_EXECUTION_NOT_FOUND',
    );

    const plain = (
      await api()
        .post(`/api/v1/checklist-templates/${f.tplActive.id}/executions`)
        .set(auth())
    ).body.data;
    const plainContext = await api()
      .get(`/api/v1/security/patrol-checklist-executions/${plain.id}`)
      .set(auth());
    assert.equal(plainContext.status, 404);
    assert.equal(
      plainContext.body.error.code,
      'PATROL_CHECKLIST_EXECUTION_NOT_FOUND',
    );
  });

  it('keeps BE-07 evidence reusable and routes findings through BE-09', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(
        `/api/v1/security/patrol-checklist-bindings/${binding.body.data.id}/start`,
      )
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    // BE-07 evidence requirements still target the shared template untouched.
    const evidence = await api()
      .post('/api/v1/evidence-requirements')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: f.tplActive.id,
        evidenceType: 'PHOTO',
        required: true,
      });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));

    // BE-09 owns the finding → checklist execution binding.
    const finding = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Patrol checklist finding',
      reportedByUserId: managerUserId,
    });
    const sourceResponse = await api()
      .patch(`/api/v1/findings/${finding.id}/source`)
      .set(auth())
      .send({ sourceType: 'CHECKLIST_EXECUTION', sourceId: executionId });
    assert.equal(sourceResponse.status, 200, JSON.stringify(sourceResponse.body));

    const source = await api()
      .get(`/api/v1/findings/${finding.id}/source`)
      .set(auth());
    assert.equal(source.status, 200, JSON.stringify(source.body));
    assert.equal(source.body.data.sourceType, 'CHECKLIST_EXECUTION');
    assert.equal(source.body.data.sourceId, executionId);
    assert.equal(source.body.data.context.referenceType, 'CHECKLIST_TEMPLATE');
    assert.equal(source.body.data.context.referenceId, f.tplActive.id);

    // Backend-authoritative available actions stay BE-09's.
    const actions = await api()
      .get(`/api/v1/findings/${finding.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.state, 'OPEN');
  });

  it('enforces RBAC on every patrol checklist endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const binding = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const bindingId = binding.body.data.id as string;

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post('/api/v1/security/patrol-checklist-bindings')
      .send({
        buildingId: f.buildingA.id,
        patrolRouteId: f.routeA.id,
        checklistTemplateId: f.tplActive.id,
      });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await bind(
      {
        buildingId: f.buildingA.id,
        patrolRouteId: f.routeA.id,
        checklistTemplateId: f.tplActive.id,
      },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/security/patrol-checklist-bindings')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/security/patrol-checklist-bindings/${bindingId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenStart = await api()
      .post(`/api/v1/security/patrol-checklist-bindings/${bindingId}/start`)
      .set(auth(plainToken));
    assert.equal(forbiddenStart.status, 403);
    assert.equal(forbiddenStart.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bindingA = await bind({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(bindingA.status, 201, JSON.stringify(bindingA.body));
    const bindingB = await bind({
      buildingId: f.buildingB.id,
      patrolRouteId: f.routeB.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(bindingB.status, 201, JSON.stringify(bindingB.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await bind(
      {
        buildingId: f.buildingA.id,
        patrolRouteId: f.routeA.id,
        checklistTemplateId: f.tplActive.id,
      },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(
        `/api/v1/security/patrol-checklist-bindings/${bindingA.body.data.id}`,
      )
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get('/api/v1/security/patrol-checklist-bindings')
      .query({ buildingId: f.buildingA.id })
      .set(auth(bOnly.token));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // An unfiltered list is scoped to the caller's accessible buildings.
    const scopedList = await api()
      .get('/api/v1/security/patrol-checklist-bindings')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    assert.deepEqual(
      scopedList.body.data.map((b: { id: string }) => b.id),
      [bindingB.body.data.id],
    );
  });
});

// Suppress unused-import warning: `Fixture` is only declared for type docs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _FixtureUnused = Fixture;
