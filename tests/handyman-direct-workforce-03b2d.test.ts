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
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { readMyHandymanFieldFeed }
  from '../src/modules/handyman-field-feed/handyman-field-feed.service';
import {
  createDirectHandymanProviderContext,
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
  getHandymanExecutionScopeAssignment,
  reassignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import { readHandymanWorkerProfileByContextId }
  from '../src/modules/handyman-worker-profile/handyman-worker-profile.service';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { createCompetencyRequirement }
  from '../src/modules/service-competency-requirements/service-competency-requirement.service';
import { skillService } from '../src/modules/skills';
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
import { assignBuildingToWorkforce }
  from '../src/modules/workforce-building-assignments';
import { assignSkillToWorkforce } from '../src/modules/workforce-skills';
import { parseProviderContextCreateRequest }
  from '../src/modules/handyman-provider-api/handyman-provider-api.validation';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2D — DIRECT HANDYMAN WORKFORCE.
 *
 * BUSINESS MODEL. Handyman is a direct service provider. Customer Care and
 * Operations are part of Handyman's own organisation, and the field workers are
 * Handyman's own personnel whether they are permanent (INTERNAL), contract
 * (CONTRACT) or freelance (FREELANCE). Freelance status is a labour
 * relationship, NOT a company: Operations must be able to register and assign a
 * freelancer without inventing a vendor.
 *
 * BEFORE 03B2D the assignment path was vendor-rooted in three places:
 *   1. `handyman_provider_contexts.vendor_id` was NOT NULL + UNIQUE, so the only
 *      provider pool was a vendor's;
 *   2. `createHandymanWorkerContext` demanded an ACTIVE
 *      `vendor_workforce_bindings` row for that vendor;
 *   3. `findEligibleHandymanWorker` required `workforce_type='EXTERNAL'` AND the
 *      same vendor binding, which structurally excluded permanent and contract
 *      staff from crew assignment.
 *
 * AFTER 03B2D a provider context is VENDOR (legacy, byte-for-byte unchanged) or
 * DIRECT (Handyman's own pool, no vendor), and admission is decided by WHO OWNS
 * THE WORKER (the provider kind) instead of by the person's workforce type. The
 * assignment authority itself is untouched: same service, same lock, same
 * one-ACTIVE invariant, same history table, same competency evaluator, same
 * decision ledger.
 *
 * This suite runs on a disposable PostgreSQL and covers the PART C list.
 */
describe('PART 03B2D — direct Handyman workforce', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;
  let embedded: EmbeddedTestDatabase | null = null;
  let adminUserId = '';
  let disciplineId = '';

  const EMBEDDED_DIR = '/tmp/hm-direct-03b2d-pg';
  const EMBEDDED_PORT = 55665;

  const suffix = () => randomUUID().slice(0, 8).toUpperCase();

  const q = async (text: string, params: unknown[] = []) => {
    if (!pool) throw new Error('database pool is not initialized');
    return pool.query(text, params);
  };

  function ready(t: TestContext): boolean {
    if (!database || !pool) {
      t.skip('PostgreSQL test database is unavailable');
      return false;
    }
    return true;
  }

  before(async () => {
    embedded = await startEmbeddedTestDatabase({
      dir: EMBEDDED_DIR,
      port: EMBEDDED_PORT,
    });
    const db = await ensureTestDatabase();
    if (!db) return;

    pool = await initDatabase(db);
    await migrateUp(pool);

    const admin = await createAdminUser();
    adminUserId = admin.userId;

    const discipline = await handymanDisciplineRepository.findDisciplineByCode(
      undefined,
      'GENERAL_HANDYMAN',
    );
    if (!discipline) throw new Error('GENERAL_HANDYMAN seed missing');
    disciplineId = discipline.id;

    database = db;
  });

  after(async () => {
    try {
      if (pool) await closePool(pool);
      if (embedded) await embedded.stop();
    } finally {
      pool = null;
      database = null;
      embedded = null;
    }
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  type Realm = {
    clientId: string;
    buildingId: string;
    organizationId: string;
    departmentId: string;
    positionId: string;
  };

  async function realm(label = 'Realm'): Promise<Realm> {
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
      name: 'Field Worker',
    });
    return {
      clientId: client.id,
      buildingId: building.id,
      organizationId: organization.id,
      departmentId: department.id,
      positionId: position.id,
    };
  }

  /**
   * One Handyman-managed field worker. Deliberately NO vendor, NO vendor
   * binding and NO vendor-typed workforce: this is Operations' own staff.
   */
  async function directWorker(
    r: Realm,
    workforceType: 'INTERNAL' | 'CONTRACT' | 'FREELANCE',
    options: { login?: boolean; placement?: boolean; label?: string } = {},
  ) {
    const login = options.login ?? true;
    const user = login
      ? await userService.createUser({
          email: `worker-${suffix().toLowerCase()}@example.com`,
          displayName: `Worker ${suffix()}`,
        })
      : null;
    const profile = await workforceService.createWorkforceProfile({
      organizationId: r.organizationId,
      departmentId: r.departmentId,
      positionId: r.positionId,
      employeeCode: `W_${suffix()}`,
      fullName: `${options.label ?? 'Worker'} ${suffix()}`,
      workforceType,
      ...(user ? { userId: user.id } : {}),
    });
    if (options.placement !== false) {
      await assignBuildingToWorkforce({
        workforceProfileId: profile.id,
        buildingId: r.buildingId,
      });
    }
    if (user) {
      await buildingAssignmentService.createAssignment(user.id, {
        buildingId: r.buildingId,
      });
    }
    return { user, profile };
  }

  /** The Client's DIRECT pool (created once per realm) or a legacy VENDOR pool. */
  async function directPool(r: Realm) {
    const existing =
      await handymanProviderContextService.getDirectHandymanProviderContext(
        r.clientId,
        adminUserId,
      ).catch(() => null);
    if (existing) return existing;
    return createDirectHandymanProviderContext(
      { clientId: r.clientId },
      adminUserId,
    );
  }

  async function vendorPool(r: Realm) {
    const vendor = await vendorService.createVendor({
      clientId: r.clientId,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Legacy Subcontractor',
    });
    const providerContext = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
    return { vendor, providerContext };
  }

  /** ACTIVE crew in the DIRECT pool with a login-capable Lead. */
  async function directCrew(
    r: Realm,
    workforceType: 'INTERNAL' | 'CONTRACT' | 'FREELANCE',
    label = 'Crew',
  ) {
    const providerContext = await directPool(r);
    const lead = await directWorker(r, workforceType, { label: 'Lead' });
    const workerContext = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: providerContext.id,
          workforceProfileId: lead.profile.id,
        },
        adminUserId,
      );
    const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
      {
        handymanProviderContextId: providerContext.id,
        code: `${label.toUpperCase().slice(0, 4)}_${suffix()}`,
        name: `${label} Crew`,
        leadWorkerContextId: workerContext.id,
      },
      adminUserId,
    );
    return {
      providerContext,
      crew: bundle.crew,
      lead: { ...lead, workerContext },
    };
  }

  async function addMember(
    r: Realm,
    crew: { providerContext: { id: string }; crew: { id: string } },
    workforceType: 'INTERNAL' | 'CONTRACT' | 'FREELANCE' = 'FREELANCE',
  ) {
    const member = await directWorker(r, workforceType, { label: 'Member' });
    const workerContext = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: crew.providerContext.id,
          workforceProfileId: member.profile.id,
        },
        adminUserId,
      );
    await handymanWorkCrewService.addHandymanCrewMember(
      { handymanCrewId: crew.crew.id, handymanWorkerContextId: workerContext.id },
      adminUserId,
    );
    return { ...member, workerContext };
  }

  /** AUTHORIZED execution scope via the full CR-HM-02 → CR-HM-06 chain. */
  async function scopeFixture(r: Realm) {
    const floor = await floorService.createFloor({
      buildingId: r.buildingId,
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
    const company = await tenantCompanyService.createTenantCompany(
      {
        clientId: r.clientId,
        tenantCode: `TNT_${suffix()}`,
        tenantName: 'Tenant Company',
      },
      adminUserId,
    );
    const customer = await userService.createUser({
      email: `customer-${suffix().toLowerCase()}@example.com`,
      displayName: 'Customer Person',
    });
    await buildingAssignmentService.createAssignment(customer.id, {
      buildingId: r.buildingId,
    });
    const pic = await tenantPicService.createTenantPic(
      {
        tenantCompanyId: company.id,
        picName: 'Tenant Requester',
        email: `req-${suffix().toLowerCase()}@tenant.example.com`,
        userId: customer.id,
      },
      adminUserId,
    );
    await tenantSpaceService.assignSpaceToTenant(
      { tenantCompanyId: company.id, buildingId: r.buildingId, spaceId: space.id },
      adminUserId,
    );
    await tenantBuildingContextService.createTenantBuildingContext(
      { tenantCompanyId: company.id, buildingId: r.buildingId },
      adminUserId,
    );
    const attribution = await createChannelAttribution({
      tenantCompanyId: company.id,
      buildingId: r.buildingId,
      tenantPicId: pic.id,
      spaceId: space.id,
      originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
      createdByUserId: customer.id,
    });
    const service = await serviceCatalogService.createServiceCatalogEntry(
      {
        clientId: r.clientId,
        code: `HM${suffix()}`,
        name: 'Handyman Service',
        category: 'FM_HINT_TEXT',
      },
      adminUserId,
    );
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest(
        { channelAttributionId: attribution.id, serviceCatalogId: service.id },
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
        diagnosis: 'PART 03B2D fixture diagnosis.',
      },
      adminUserId,
    );
    const bundle = await createHandymanQuotation(
      { handymanRequestId: request.id },
      adminUserId,
    );
    const version = bundle.versions[0];
    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uomId, r.clientId, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
    );
    await addHandymanQuotationLine(
      version.id,
      {
        lineType: 'LABOR',
        description: 'Hours',
        quantity: 1,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      },
      adminUserId,
    );
    await issueHandymanQuotationVersion(
      version.id,
      { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
      adminUserId,
    );
    const decision = await decideHandymanQuotation(
      version.id,
      { decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}` },
      customer.id,
    );
    assert.ok(decision.executionScope);
    assert.equal(decision.executionScope.status, 'AUTHORIZED');
    return { scope: decision.executionScope, serviceCatalogId: service.id };
  }

  async function assignmentRows(scopeId: string) {
    const result = await q(
      `SELECT id, status, handyman_crew_id, version
         FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1
        ORDER BY created_at ASC`,
      [scopeId],
    );
    return result.rows as Array<{
      id: string;
      status: string;
      handyman_crew_id: string;
      version: number;
    }>;
  }

  async function historyRows(scopeId: string) {
    const result = await q(
      `SELECT action, from_crew_id, to_crew_id
         FROM handyman_execution_scope_assignment_history
        WHERE execution_scope_id = $1
        ORDER BY created_at ASC`,
      [scopeId],
    );
    return result.rows as Array<{
      action: string;
      from_crew_id: string | null;
      to_crew_id: string;
    }>;
  }

  async function decisionRows(assignmentId: string) {
    const result = await q(
      `SELECT action, handyman_crew_id, enforcement_level, satisfied
         FROM handyman_assignment_competency_evaluations
        WHERE assignment_id = $1`,
      [assignmentId],
    );
    return result.rows as Array<{
      action: string;
      handyman_crew_id: string;
      enforcement_level: string;
      satisfied: boolean;
    }>;
  }

  async function vendorCount(): Promise<number> {
    const result = await q('SELECT count(*)::int AS n FROM vendors');
    return result.rows[0].n as number;
  }

  // -------------------------------------------------------------------------
  // D1 — the direct pool exists without any vendor
  // -------------------------------------------------------------------------

  describe('D1 — direct workforce pool and worker registration', () => {
    it('creates a DIRECT provider context with no vendor row', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Direct');
      const before = await vendorCount();

      const providerContext = await createDirectHandymanProviderContext(
        { clientId: r.clientId },
        adminUserId,
      );

      assert.equal(providerContext.providerType, 'DIRECT');
      assert.equal(providerContext.vendorId, null);
      assert.equal(providerContext.status, 'ACTIVE');
      assert.equal(providerContext.clientId, r.clientId);
      assert.equal(
        await vendorCount(),
        before,
        'no vendor may be fabricated for a freelance/permanent worker',
      );
    });

    it('rejects a second DIRECT pool for the same Client (409 authority)', async (t) => {
      if (!ready(t)) return;
      const r = await realm('DirectDup');
      await createDirectHandymanProviderContext({ clientId: r.clientId }, adminUserId);
      await assert.rejects(
        () =>
          createDirectHandymanProviderContext(
            { clientId: r.clientId },
            adminUserId,
          ),
        (error: unknown) =>
          (error as { code?: string }).code ===
          'HANDYMAN_PROVIDER_CONTEXT_ALREADY_EXISTS',
      );
    });

    it('registers permanent, contract and freelance workers without a binding', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Types');
      const providerContext = await directPool(r);

      for (const workforceType of ['INTERNAL', 'CONTRACT', 'FREELANCE'] as const) {
        const worker = await directWorker(r, workforceType);
        const workerContext = await handymanWorkerContextService
          .createHandymanWorkerContext(
            {
              handymanProviderContextId: providerContext.id,
              workforceProfileId: worker.profile.id,
            },
            adminUserId,
          );
        assert.equal(workerContext.status, 'ACTIVE');
        assert.equal(workerContext.workforceProfileId, worker.profile.id);
      }

      const bindings = await q(
        `SELECT count(*)::int AS n FROM vendor_workforce_bindings
          WHERE workforce_profile_id IN (
            SELECT id FROM workforce_profiles
             WHERE organization_id IN (
               SELECT id FROM organizations WHERE client_id = $1
             )
          )`,
        [r.clientId],
      );
      assert.equal(bindings.rows[0].n, 0, 'direct staff needs no vendor binding');
    });

    it('keeps the legacy VENDOR path strict: no binding, no worker context', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Legacy');
      const vendor = await vendorPool(r);
      const worker = await directWorker(r, 'EXTERNAL');

      await assert.rejects(
        () =>
          handymanWorkerContextService.createHandymanWorkerContext(
            {
              handymanProviderContextId: vendor.providerContext.id,
              workforceProfileId: worker.profile.id,
            },
            adminUserId,
          ),
        (error: unknown) =>
          (error as { code?: string }).code ===
          'HANDYMAN_WORKFORCE_BINDING_REQUIRED',
        'a real vendor still requires its binding',
      );

      await vendorWorkforceService.createVendorWorkforceBinding({
        vendorId: vendor.vendor.id,
        workforceProfileId: worker.profile.id,
        vendorPersonnelCode: `VP_${suffix()}`,
      });
      const workerContext = await handymanWorkerContextService
        .createHandymanWorkerContext(
          {
            handymanProviderContextId: vendor.providerContext.id,
            workforceProfileId: worker.profile.id,
          },
          adminUserId,
        );
      assert.equal(workerContext.status, 'ACTIVE');
    });
  });

  // -------------------------------------------------------------------------
  // D2 — direct assignment through the existing authority
  // -------------------------------------------------------------------------

  describe('D2 — Operations assigns its own workers directly', () => {
    it('assigns a PERMANENT (INTERNAL) worker crew to a work order', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Permanent');
      const crew = await directCrew(r, 'INTERNAL');
      const f = await scopeFixture(r);

      const created = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );

      assert.equal(created.status, 'ACTIVE');
      assert.equal(created.clientId, r.clientId);
      assert.equal(created.handymanProviderContextId, crew.providerContext.id);
      assert.equal(created.handymanCrewId, crew.crew.id);

      const rows = await assignmentRows(f.scope.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'ACTIVE');
    });

    it('assigns a FREELANCE worker crew without any company vendor', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Freelance');
      const before = await vendorCount();
      const crew = await directCrew(r, 'FREELANCE');
      const f = await scopeFixture(r);

      const created = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );

      assert.equal(created.status, 'ACTIVE');
      assert.equal(
        await vendorCount(),
        before,
        'assigning a freelancer must not create a vendor',
      );
      const provider = await handymanProviderContextService
        .getDirectHandymanProviderContext(r.clientId, adminUserId);
      assert.equal(provider.providerType, 'DIRECT');
      assert.equal(provider.vendorId, null);
    });

    it('assigns a multi-worker crew (Lead + members) in one ACTIVE assignment', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Crew');
      const crew = await directCrew(r, 'INTERNAL', 'Team');
      const memberA = await addMember(r, crew, 'CONTRACT');
      const memberB = await addMember(r, crew, 'FREELANCE');
      const f = await scopeFixture(r);

      const created = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );
      assert.equal(created.status, 'ACTIVE');

      const members = await q(
        `SELECT count(*)::int AS n FROM handyman_crew_memberships
          WHERE handyman_crew_id = $1 AND status = 'ACTIVE'`,
        [crew.crew.id],
      );
      assert.equal(members.rows[0].n, 3);
      for (const member of [memberA, memberB]) {
        assert.equal(member.workerContext.status, 'ACTIVE');
      }
    });

    it('delivers the assignment to the worker Mobile field feed', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Mobile');
      const crew = await directCrew(r, 'FREELANCE');
      const f = await scopeFixture(r);
      await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );

      const feed = await readMyHandymanFieldFeed(crew.lead.user!.id);
      const job = feed.jobs.find(
        (item: { executionScopeId: string }) =>
          item.executionScopeId === f.scope.id,
      );
      assert.ok(job, 'the direct crew Lead must see the assigned work order');
      assert.equal(job.crewId, crew.crew.id);
    });

    it('projects a direct worker profile (providerType DIRECT, no vendor)', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Profile');
      const crew = await directCrew(r, 'FREELANCE');

      const profile = await readHandymanWorkerProfileByContextId(
        adminUserId,
        crew.lead.workerContext.id,
      );
      assert.equal(profile.providerAssociation.providerType, 'DIRECT');
      assert.equal(profile.providerAssociation.vendorId, null);
      assert.equal(profile.providerAssociation.providerCode, null);
      assert.equal(profile.workerIdentity.employmentType, 'FREELANCE');
      assert.equal(profile.workerIdentity.workforceType, 'FREELANCE');
    });
  });

  // -------------------------------------------------------------------------
  // D3 — competency rules unchanged (MANDATORY blocks, RECOMMENDED warns)
  // -------------------------------------------------------------------------

  describe('D3 — competency evaluator reused unchanged', () => {
    it('admits a multi-skill worker across job types', async (t) => {
      if (!ready(t)) return;
      const r = await realm('MultiSkill');
      const crew = await directCrew(r, 'INTERNAL', 'Multi');

      const plumbing = await skillService.createSkill({
        clientId: r.clientId,
        code: `PLUMB_${suffix()}`,
        name: 'Plumbing',
        category: 'TECHNICAL',
      });
      const electrical = await skillService.createSkill({
        clientId: r.clientId,
        code: `ELEC_${suffix()}`,
        name: 'Electrical',
        category: 'TECHNICAL',
      });
      for (const skill of [plumbing, electrical]) {
        await assignSkillToWorkforce({
          workforceProfileId: crew.lead.profile.id,
          skillId: skill.id,
          proficiencyLevel: 'ADVANCED',
        });
      }

      const f = await scopeFixture(r);
      const created = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );

      // A job type with no configured requirement produces no ledger rows:
      // there is nothing to explain. Both trades still belong to the worker.
      assert.equal((await decisionRows(created.id)).length, 0);
      assert.deepEqual(
        (
          await q(
            `SELECT count(*)::int AS n FROM workforce_skill_assignments
              WHERE workforce_profile_id = $1 AND status = 'ACTIVE'`,
            [crew.lead.profile.id],
          )
        ).rows[0].n,
        2,
        'both trades stay assigned to the same worker',
      );
    });

    it('blocks an unmet MANDATORY requirement (nothing written)', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Mandatory');
      const crew = await directCrew(r, 'FREELANCE', 'Mand');
      const f = await scopeFixture(r);

      const safety = await skillService.createSkill({
        clientId: r.clientId,
        code: `K3_${suffix()}`,
        name: 'K3 Electrical Safety',
        category: 'SAFETY',
      });
      await createCompetencyRequirement(
        f.serviceCatalogId,
        {
          clientId: r.clientId,
          serviceCatalogId: f.serviceCatalogId,
          tradeCategoryId: null,
          requirementType: 'CERTIFICATION',
          enforcementLevel: 'MANDATORY',
          skillId: safety.id,
          minimumProficiencyLevel: null,
          certificateName: `K3-${suffix()}`,
          notes: null,
          createdByUserId: adminUserId,
        },
        adminUserId,
      );

      await assert.rejects(
        () =>
          assignHandymanExecutionScopeCrew(
            {
              executionScopeId: f.scope.id,
              providerContextId: crew.providerContext.id,
              crewId: crew.crew.id,
            },
            adminUserId,
          ),
        (error: unknown) =>
          (error as { code?: string }).code ===
          'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_COMPETENCY_REQUIRED',
      );
      assert.equal((await assignmentRows(f.scope.id)).length, 0);
      assert.equal((await historyRows(f.scope.id)).length, 0);
    });

    it('warns instead of refusing for an unmet RECOMMENDED requirement', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Recommended');
      const crew = await directCrew(r, 'CONTRACT', 'Rec');
      const f = await scopeFixture(r);

      const skill = await skillService.createSkill({
        clientId: r.clientId,
        code: `ADV_${suffix()}`,
        name: 'Advanced Finishing',
        category: 'TECHNICAL',
      });
      await createCompetencyRequirement(
        f.serviceCatalogId,
        {
          clientId: r.clientId,
          serviceCatalogId: f.serviceCatalogId,
          tradeCategoryId: null,
          requirementType: 'SKILL',
          enforcementLevel: 'RECOMMENDED',
          skillId: skill.id,
          minimumProficiencyLevel: 'EXPERT',
          certificateName: null,
          notes: null,
          createdByUserId: adminUserId,
        },
        adminUserId,
      );

      const created = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );
      const decisions = await decisionRows(created.id);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].enforcement_level, 'RECOMMENDED');
      assert.equal(
        decisions[0].satisfied,
        false,
        'the gap is recorded as unmet so it can be surfaced as a warning',
      );
      assert.equal(
        created.status,
        'ACTIVE',
        'a recommended gap is advisory, never a refusal',
      );
    });
  });

  // -------------------------------------------------------------------------
  // D4 — replacement, inactive worker, isolation, rollback
  // -------------------------------------------------------------------------

  describe('D4 — replacement, status and isolation', () => {
    it('replaces a worker crew and keeps the history + ledger', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Replace');
      const first = await directCrew(r, 'FREELANCE', 'First');
      const second = await directCrew(r, 'INTERNAL', 'Second');
      const f = await scopeFixture(r);
      // One advisory requirement, so every assignment/reassignment names the
      // requirement set it was validated against instead of leaving the
      // ledger empty.
      const skill = await skillService.createSkill({
        clientId: r.clientId,
        code: `LEDGER_${suffix()}`,
        name: 'Ledger Evidence Skill',
        category: 'TECHNICAL',
      });
      await createCompetencyRequirement(
        f.serviceCatalogId,
        {
          clientId: r.clientId,
          serviceCatalogId: f.serviceCatalogId,
          tradeCategoryId: null,
          requirementType: 'SKILL',
          enforcementLevel: 'RECOMMENDED',
          skillId: skill.id,
          minimumProficiencyLevel: 'EXPERT',
          certificateName: null,
          notes: null,
          createdByUserId: adminUserId,
        },
        adminUserId,
      );

      const original = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: first.providerContext.id,
          crewId: first.crew.id,
        },
        adminUserId,
      );
      const replaced = await reassignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: second.providerContext.id,
          crewId: second.crew.id,
          expectedVersion: original.version,
          reason: 'Worker rotated to the permanent crew.',
          idempotencyKey: `re-${randomUUID()}`,
        },
        adminUserId,
      );

      assert.equal(replaced.status, 'ACTIVE');
      assert.equal(replaced.handymanCrewId, second.crew.id);
      assert.equal(replaced.supersedesAssignmentId, original.id);

      const rows = await assignmentRows(f.scope.id);
      assert.equal(rows.filter((row) => row.status === 'ACTIVE').length, 1);
      assert.equal(rows.filter((row) => row.status === 'SUPERSEDED').length, 1);

      const history = await historyRows(f.scope.id);
      assert.deepEqual(
        history.map((row) => row.action),
        ['ASSIGNED', 'REASSIGNED'],
      );
      assert.equal(history[1].from_crew_id, first.crew.id);
      assert.equal(history[1].to_crew_id, second.crew.id);

      const originalDecisions = await decisionRows(original.id);
      const replacedDecisions = await decisionRows(replaced.id);
      assert.equal(originalDecisions.length, 1);
      assert.equal(originalDecisions[0].action, 'ASSIGNED');
      assert.equal(replacedDecisions.length, 1);
      assert.equal(replacedDecisions[0].action, 'REASSIGNED');
      assert.equal(replacedDecisions[0].handyman_crew_id, second.crew.id);
    });

    it('refuses an INACTIVE worker of the direct pool', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Inactive');
      const crew = await directCrew(r, 'FREELANCE', 'Inactive');
      const f = await scopeFixture(r);
      await handymanWorkerContextService.setHandymanWorkerContextStatus(
        crew.lead.workerContext.id,
        'INACTIVE',
        adminUserId,
      );

      await assert.rejects(
        () =>
          assignHandymanExecutionScopeCrew(
            {
              executionScopeId: f.scope.id,
              providerContextId: crew.providerContext.id,
              crewId: crew.crew.id,
            },
            adminUserId,
          ),
        (error: unknown) =>
          [
            // The crew Lead chain is validated first: an INACTIVE worker
            // context can no longer be the current Lead.
            'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_LEAD_INVALID',
            'HANDYMAN_CREW_LEAD_INVALID',
            'HANDYMAN_WORKFORCE_BINDING_REQUIRED',
          ].includes((error as { code?: string }).code ?? ''),
        'an INACTIVE direct worker must never be assignable',
      );
      assert.equal((await assignmentRows(f.scope.id)).length, 0);
    });

    it('refuses a worker without Building placement', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Placement');
      const providerContext = await directPool(r);
      const worker = await directWorker(r, 'FREELANCE', { placement: false });
      const workerContext = await handymanWorkerContextService
        .createHandymanWorkerContext(
          {
            handymanProviderContextId: providerContext.id,
            workforceProfileId: worker.profile.id,
          },
          adminUserId,
        );
      const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
        {
          handymanProviderContextId: providerContext.id,
          code: `NOPL_${suffix()}`,
          name: 'Unplaced Crew',
          leadWorkerContextId: workerContext.id,
        },
        adminUserId,
      );
      const f = await scopeFixture(r);

      await assert.rejects(
        () =>
          assignHandymanExecutionScopeCrew(
            {
              executionScopeId: f.scope.id,
              providerContextId: providerContext.id,
              crewId: bundle.crew.id,
            },
            adminUserId,
          ),
        (error: unknown) =>
          (error as { code?: string }).code ===
          'HANDYMAN_WORKFORCE_BINDING_REQUIRED',
      );
    });

    it('keeps Client isolation: another Client’s direct pool is refused', async (t) => {
      if (!ready(t)) return;
      const realmA = await realm('A');
      const realmB = await realm('B');
      const crewA = await directCrew(realmA, 'INTERNAL', 'IsolA');
      const fB = await scopeFixture(realmB);

      await assert.rejects(
        () =>
          assignHandymanExecutionScopeCrew(
            {
              executionScopeId: fB.scope.id,
              providerContextId: crewA.providerContext.id,
              crewId: crewA.crew.id,
            },
            adminUserId,
          ),
        (error: unknown) =>
          (error as { code?: string }).code ===
          'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_MISMATCH',
      );
      assert.equal((await assignmentRows(fB.scope.id)).length, 0);
    });

    it('rolls back completely when the new target is invalid', async (t) => {
      if (!ready(t)) return;
      const r = await realm('Rollback');
      const crew = await directCrew(r, 'FREELANCE', 'Roll');
      const f = await scopeFixture(r);
      const original = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        adminUserId,
      );

      await assert.rejects(
        () =>
          reassignHandymanExecutionScopeCrew(
            {
              executionScopeId: f.scope.id,
              providerContextId: crew.providerContext.id,
              crewId: randomUUID(),
              expectedVersion: original.version,
              reason: 'Broken target.',
              idempotencyKey: `re-${randomUUID()}`,
            },
            adminUserId,
          ),
      );

      const rows = await assignmentRows(f.scope.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'ACTIVE');
      assert.equal(rows[0].version, original.version);
      assert.deepEqual(
        (await historyRows(f.scope.id)).map((row) => row.action),
        ['ASSIGNED'],
      );
      const current = await getHandymanExecutionScopeAssignment(
        f.scope.id,
        adminUserId,
      );
      assert.equal(current?.id, original.id);
    });

    it('still accepts a legacy VENDOR crew end to end', async (t) => {
      if (!ready(t)) return;
      const r = await realm('LegacyCrew');
      const vendor = await vendorPool(r);
      const lead = await directWorker(r, 'EXTERNAL');
      await vendorWorkforceService.createVendorWorkforceBinding({
        vendorId: vendor.vendor.id,
        workforceProfileId: lead.profile.id,
        vendorPersonnelCode: `VP_${suffix()}`,
      });
      const workerContext = await handymanWorkerContextService
        .createHandymanWorkerContext(
          {
            handymanProviderContextId: vendor.providerContext.id,
            workforceProfileId: lead.profile.id,
          },
          adminUserId,
        );
      const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
        {
          handymanProviderContextId: vendor.providerContext.id,
          code: `LEG_${suffix()}`,
          name: 'Legacy Crew',
          leadWorkerContextId: workerContext.id,
        },
        adminUserId,
      );
      const f = await scopeFixture(r);

      const created = await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: vendor.providerContext.id,
          crewId: bundle.crew.id,
        },
        adminUserId,
      );
      assert.equal(created.status, 'ACTIVE');
      assert.equal(created.handymanCrewId, bundle.crew.id);
    });
  });

  // -------------------------------------------------------------------------
  // D5 — API boundary: exactly one owner, never a fabricated vendor
  // -------------------------------------------------------------------------

  describe('D5 — provider context create body', () => {
    it('accepts exactly one owner reference', () => {
      const id = randomUUID();
      assert.deepEqual(parseProviderContextCreateRequest({ vendorId: id }), {
        kind: 'VENDOR',
        vendorId: id,
      });
      assert.deepEqual(parseProviderContextCreateRequest({ clientId: id }), {
        kind: 'DIRECT',
        clientId: id,
      });
    });

    it('refuses both, neither and a malformed reference', () => {
      const id = randomUUID();
      for (const body of [
        { vendorId: id, clientId: id },
        {},
        { vendorId: 'not-a-uuid' },
        null,
      ]) {
        assert.throws(
          () => parseProviderContextCreateRequest(body),
          (error: unknown) =>
            (error as { code?: string }).code === 'VALIDATION_ERROR',
          `body ${JSON.stringify(body)} must be refused`,
        );
      }
    });
  });
});
