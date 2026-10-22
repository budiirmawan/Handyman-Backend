import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService, sessionService } from '../src/modules/auth';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanCrewMember,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { skillService } from '../src/modules/skills';
import { userService } from '../src/modules/users';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { workforceSkillService } from '../src/modules/workforce-skills';
import { createAdminUser } from './helpers/access';
import {
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';

/**
 * CR-HM-WORKER-PROFILE-FIX-01 — schema-compatibility regression suite.
 *
 * The production incident was HTTP 500 on
 * GET /api/v1/handyman/field/me/profile because CORE_WORKER_SELECT
 * referenced columns that the canonical migrations never create
 * (handyman_worker_contexts.worker_code,
 * handyman_provider_contexts.provider_code,
 * workforce_profiles.client_id/email/phone/employment_type).
 *
 * This suite deliberately does NOT hand-write a "close enough" schema: it
 * applies the REAL migration registry (`migrateUp`) to a disposable
 * PostgreSQL cluster, builds fixtures through the real domain services, and
 * then exercises the HTTP surface. Any future column drift fails here with a
 * SQL error instead of reaching production.
 */

const EMBEDDED_DIR = '/tmp/hm-worker-profile-schema-pg';
const EMBEDDED_PORT = 55641;
const HM = '/api/v1/handyman';

let embedded: EmbeddedTestDatabase | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';
let disciplineId = '';
let leadUserId = '';
let leadToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = leadToken) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
  });
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    'TRUNCATE clients, users, roles, permissions CASCADE',
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  disciplineId = discipline.id;
  initHandymanFixtures({
    adminUserId,
    disciplineId,
    query: async (text: string, params: unknown[] = []) => {
      if (!pool) throw new Error('database pool is not initialized');
      return pool.query(text, params);
    },
  });

  database = db;
});

after(async () => {
  if (pool) await closePool(pool).catch(() => undefined);
  pool = null;
  database = null;
  if (embedded) await embedded.stop();
  embedded = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const sql = async <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query<T>(text, params);
};

describe('CR-HM-WORKER-PROFILE-FIX-01: worker profile over the canonical schema', () => {
  // Realm + provider + crew + scope + skills + certification fixtures.
  let realm: Awaited<ReturnType<typeof realmFixture>>;
  let crew: Awaited<ReturnType<typeof crewFixture>>;
  let scope: { id: string };
  let helperWorkerContextId = '';
  let helperUserId = '';
  let helperToken = '';
  let skillCode = '';
  let unassignedUserId = '';

  before(async () => {
    if (!database || !pool) return;

    realm = await realmFixture('Schema');
    const chain = await locationChain(realm);
    crew = await crewFixture(realm);
    const scopeFixtureResult = await scopeFixture(realm, chain);
    scope = scopeFixtureResult.scope;

    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    // Skills: one effective assignment with a validity window.
    skillCode = `SKL_${suffix()}`;
    const skill = await skillService.createSkill({
      clientId: realm.client.id,
      code: skillCode,
      name: 'Commercial Plumbing & Piping',
      category: 'TECHNICAL',
    });
    await workforceSkillService.assignSkillToWorkforce({
      workforceProfileId: crew.profile.id,
      skillId: skill.id,
      proficiencyLevel: 'EXPERT',
      validFrom: new Date('2025-01-01T00:00:00Z'),
      validUntil: new Date('2028-12-31T23:59:59Z'),
    });

    // A second skill assignment that has expired: the validity window must
    // still be projected (with isExpired), while the effective list excludes it.
    const expiredSkill = await skillService.createSkill({
      clientId: realm.client.id,
      code: `SKL_OLD_${suffix()}`,
      name: 'Legacy Valve Repair',
      category: 'TECHNICAL',
    });
    await workforceSkillService.assignSkillToWorkforce({
      workforceProfileId: crew.profile.id,
      skillId: expiredSkill.id,
      proficiencyLevel: 'BASIC',
      validFrom: new Date('2020-01-01T00:00:00Z'),
      validUntil: new Date('2021-01-01T00:00:00Z'),
    });

    // A corrupted cross-client assignment (never creatable through services)
    // must NOT leak into the projection: the skill master is client-scoped.
    const otherRealm = await realmFixture('Other');
    const foreignSkill = await skillService.createSkill({
      clientId: otherRealm.client.id,
      code: `SKL_FOREIGN_${suffix()}`,
      name: 'Foreign Client Skill',
      category: 'SPECIALIST',
    });
    await sql(
      `INSERT INTO workforce_skill_assignments
         (id, workforce_profile_id, skill_id, proficiency_level, status)
       VALUES ($1, $2, $3, 'EXPERT', 'ACTIVE')`,
      [randomUUID(), crew.profile.id, foreignSkill.id],
    );

    // Provider certification (vendor-scoped authority).
    await vendorLicenseService.createVendorLicense({
      vendorId: crew.vendor.id,
      recordType: 'CERTIFICATION',
      name: 'IUJK & K3 Contractor License',
      number: `LIC-${suffix()}`,
      issuingAuthority: 'Kemnaker RI',
      issueDate: new Date('2025-01-01T00:00:00Z'),
      expiryDate: new Date('2028-01-01T00:00:00Z'),
      status: 'ACTIVE',
    });

    // Helper crew member: real login, no skills, no certification of its own.
    const helperUser = await userService.createUser({
      email: `helper-${suffix().toLowerCase()}@example.com`,
      displayName: 'Helper Worker',
    });
    helperUserId = helperUser.id;
    const helperProfile = await workforceService.createWorkforceProfile({
      organizationId: realm.organization.id,
      departmentId: realm.department.id,
      positionId: realm.position.id,
      employeeCode: `HLP_${suffix()}`,
      fullName: 'Helper Worker',
      workforceType: 'EXTERNAL',
      userId: helperUser.id,
    });
    await assignBuildingToWorkforce({
      workforceProfileId: helperProfile.id,
      buildingId: realm.building.id,
    });
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: crew.vendor.id,
      workforceProfileId: helperProfile.id,
      vendorPersonnelCode: `VP_${suffix()}`,
    });
    const helperContext = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: crew.providerContext.id,
          workforceProfileId: helperProfile.id,
        },
        adminUserId,
      );
    helperWorkerContextId = helperContext.id;
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: helperContext.id,
      },
      adminUserId,
    );
    await buildingAssignmentService.createAssignment(helperUser.id, {
      buildingId: realm.building.id,
    });

    // A third worker: a real login with no Handyman worker context at all —
    // the PLATFORM_ADMIN-style "no worker context" shape must be a bounded
    // 404, never a 500.
    const unassignedUser = await userService.createUser({
      email: `noworker-${suffix().toLowerCase()}@example.com`,
      displayName: 'No Worker Context',
    });
    unassignedUserId = unassignedUser.id;

    // A closed work session on the crew's assignment (real 0401 constraints).
    const assignment = await sql<{ id: string }>(
      `SELECT id FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 AND handyman_crew_id = $2
          AND status = 'ACTIVE'
        LIMIT 1`,
      [scope.id, crew.crew.id],
    );
    await sql(
      `INSERT INTO handyman_work_sessions
         (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
          lead_user_id, status, checked_in_at, completed_at, checked_out_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_OUT', NOW(), NOW(), NOW())`,
      [
        randomUUID(),
        realm.client.id,
        scope.id,
        assignment.rows[0]!.id,
        crew.workerContext.id,
        crew.leadUser.id,
      ],
    );

    // Worker logins are real credential-backed sessions (resolveSessionContext
    // rejects a session whose account has no credential).
    leadUserId = crew.leadUser.id;
    for (const workerId of [leadUserId, helperUserId, unassignedUserId]) {
      await credentialService.createInitialCredential({
        userId: workerId,
        password: 'WorkerPass123',
      });
    }
    leadToken = (await sessionService.createSessionForUser(leadUserId))
      .sessionToken;
    helperToken = (await sessionService.createSessionForUser(helperUserId))
      .sessionToken;
  });

  it('GET /handyman/field/me/profile returns 200 against the migrated schema', async (t) => {
    if (!ready(t)) return;
    const res = await api()
      .get(`${HM}/field/me/profile`)
      .set(auth());
    assert.equal(
      res.status,
      200,
      `expected 200, received ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const profile = res.body.data.profile;
    const identity = profile.workerIdentity;

    // Identity — every value resolvable from a real column.
    assert.equal(identity.userId, leadUserId);
    assert.equal(identity.workerContextId, crew.workerContext.id);
    assert.equal(identity.workforceProfileId, crew.profile.id);
    assert.equal(identity.employeeCode, crew.profile.employeeCode);
    assert.equal(identity.fullName, 'Lead Worker');
    assert.equal(identity.email, crew.leadUser.email);
    assert.equal(identity.workforceType, 'EXTERNAL');
    // Derived from workforce_type; the profile models no employment_type.
    assert.equal(identity.employmentType, 'VENDOR');
    assert.equal(identity.workerStatus, 'ACTIVE');
    assert.ok(typeof identity.workerCode === 'string');
    assert.ok(identity.workerCode.length > 0);

    // Provider association — providerCode is the vendor registry code.
    const provider = profile.providerAssociation;
    assert.equal(provider.clientId, realm.client.id);
    assert.equal(provider.providerContextId, crew.providerContext.id);
    assert.equal(provider.providerCode, crew.vendor.vendorCode);
    assert.equal(provider.vendorId, crew.vendor.id);
    assert.equal(provider.organizationId, realm.organization.id);
    assert.equal(provider.organizationCode, realm.organization.code);
    assert.equal(provider.organizationName, 'Org');
    assert.equal(provider.bindingStatus, 'ACTIVE');
    assert.ok(provider.bindingEffectiveFrom === null ||
      typeof provider.bindingEffectiveFrom === 'string');

    // Roles / crew / buildings.
    const context = profile.roleAndAssignmentContext;
    assert.deepEqual(context.authorizedRoles, [
      'PIC_PEKERJAAN',
      'CREW_MEMBER',
    ]);
    assert.equal(context.crewMemberships.length, 1);
    assert.equal(context.crewMemberships[0].crewId, crew.crew.id);
    assert.equal(context.crewMemberships[0].crewCode, crew.crew.code);
    assert.equal(context.crewMemberships[0].isCrewLead, true);
    assert.equal(context.crewMemberships[0].buildingId, null);
    assert.ok(typeof context.crewMemberships[0].joinedAt === 'string');
    assert.equal(context.buildingAssignments.length, 1);
    assert.equal(
      context.buildingAssignments[0].buildingId,
      realm.building.id,
    );
    assert.equal(context.buildingAssignments[0].buildingCode, realm.building.code);
    assert.equal(context.buildingAssignments[0].propertyId, realm.property.id);
    assert.equal(context.buildingAssignments[0].status, 'ACTIVE');
    assert.equal(context.buildingAssignments[0].isPrimary, true);

    // Skills — effective + validity windows, cross-client row excluded.
    const skills = profile.skillsAndCategories;
    assert.deepEqual(skills.serviceCategories, ['TECHNICAL']);
    assert.deepEqual(
      skills.effectiveSkills.map((s: { code: string }) => s.code),
      [skillCode],
    );
    const windows = profile.certificationsAndExpiry.skillValidityWindows;
    assert.equal(windows.length, 2);
    assert.ok(
      windows.every((w: { skillCode: string }) =>
        w.skillCode === skillCode || w.skillCode.startsWith('SKL_OLD_'),
      ),
    );
    assert.ok(windows.some((w: { isExpired: boolean }) => w.isExpired === true));

    // Certifications — optional, provider-scoped.
    assert.equal(
      profile.certificationsAndExpiry.individualCertificateNumberModeled,
      false,
    );
    assert.equal(
      profile.certificationsAndExpiry.providerLicensesAndCertifications.length,
      1,
    );
    const license =
      profile.certificationsAndExpiry.providerLicensesAndCertifications[0];
    assert.equal(license.recordType, 'CERTIFICATION');
    assert.equal(license.expiryDate, '2028-01-01T00:00:00.000Z');

    // Work history — no invented commercial fields.
    const history = profile.workHistorySummary;
    assert.equal(history.assignedExecutionScopesCount, 1);
    assert.equal(history.completedWorkSessionsCount, 1);
    assert.equal(history.activeWorkSessionsCount, 0);
    assert.equal(history.recentWorkOrders.length, 1);
    const workOrder = history.recentWorkOrders[0];
    assert.equal(workOrder.executionScopeId, scope.id);
    assert.equal(workOrder.buildingId, realm.building.id);
    assert.equal(workOrder.roleInJob, 'PIC_PEKERJAAN');
    assert.ok(typeof workOrder.requestCode === 'string');
    assert.ok(workOrder.requestCode.length > 0);
    assert.ok(typeof workOrder.title === 'string');
    assert.ok(!JSON.stringify(history).includes('approvedTotalAmount'));
  });

  it('projects valid empty skills/certifications instead of failing', async (t) => {
    if (!ready(t)) return;
    const res = await api()
      .get(`${HM}/field/me/profile`)
      .set(auth(helperToken));
    assert.equal(
      res.status,
      200,
      `expected 200, received ${res.status}: ${JSON.stringify(res.body)}`,
    );
    const profile = res.body.data.profile;
    assert.deepEqual(profile.skillsAndCategories.effectiveSkills, []);
    assert.deepEqual(
      profile.certificationsAndExpiry.skillValidityWindows,
      [],
    );
    // The provider certification is still projected for a worker with no
    // personal skill records: certification is optional, not required.
    assert.equal(
      profile.certificationsAndExpiry.providerLicensesAndCertifications.length,
      1,
    );
    assert.deepEqual(profile.roleAndAssignmentContext.authorizedRoles, [
      'CREW_MEMBER',
    ]);
  });

  it('returns 404 for an authenticated actor with no worker context (never 500)', async (t) => {
    if (!ready(t)) return;
    const noWorkerToken = (
      await sessionService.createSessionForUser(unassignedUserId)
    ).sessionToken;
    const res = await api()
      .get(`${HM}/field/me/profile`)
      .set(auth(noWorkerToken));
    assert.equal(
      res.status,
      404,
      `expected 404, received ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.equal(res.body.error.code, 'HANDYMAN_WORKER_PROFILE_NOT_FOUND');
  });

  it('returns 404 for a PLATFORM_ADMIN without any worker context', async (t) => {
    if (!ready(t)) return;
    const res = await api()
      .get(`${HM}/field/me/profile`)
      .set(auth(adminToken));
    assert.equal(
      res.status,
      404,
      `expected 404, received ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.equal(res.body.error.code, 'HANDYMAN_WORKER_PROFILE_NOT_FOUND');
  });

  it('keeps crew-lead scoping and bounded denial on the by-context route', async (t) => {
    if (!ready(t)) return;

    // Crew lead may read the helper's profile.
    const leadReadsHelper = await api()
      .get(`${HM}/field/workers/${helperWorkerContextId}/profile`)
      .set(auth());
    assert.equal(
      leadReadsHelper.status,
      200,
      `expected 200, received ${leadReadsHelper.status}: ${JSON.stringify(leadReadsHelper.body)}`,
    );
    assert.equal(
      leadReadsHelper.body.data.profile.workerIdentity.userId,
      helperUserId,
    );

    // The helper is not a lead: a peer's profile stays forbidden.
    const helperReadsLead = await api()
      .get(`${HM}/field/workers/${crew.workerContext.id}/profile`)
      .set(auth(helperToken));
    assert.equal(helperReadsLead.status, 403);
    assert.equal(
      helperReadsLead.body.error.code,
      'HANDYMAN_WORKER_PROFILE_FORBIDDEN',
    );

    // An unknown worker context is a bounded 404 (no enumeration, no 500).
    const unknown = await api()
      .get(`${HM}/field/workers/${randomUUID()}/profile`)
      .set(auth());
    assert.equal(unknown.status, 404);
    assert.equal(
      unknown.body.error.code,
      'HANDYMAN_WORKER_PROFILE_NOT_FOUND',
    );

    // A malformed identifier is a controlled 400 validation error.
    const malformed = await api()
      .get(`${HM}/field/workers/not-a-uuid/profile`)
      .set(auth());
    assert.equal(malformed.status, 400);
  });
});
