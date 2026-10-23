import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { skillService } from '../src/modules/skills';
import { teamService } from '../src/modules/teams';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { assignSkillToWorkforce } from '../src/modules/workforce-skills';
import { workforceCertificationService } from '../src/modules/workforce-certifications';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2B — MULTI-SKILL WORKER business rule.
 *
 * Handyman is NOT "one worker = one trade". A worker carries skills and
 * certificates across several trades (an AC technician may also hold plumbing
 * and minor-electrical credentials, and may be dispatched to any of them).
 * Nothing in the platform may derive a worker's allowed trades from the trade
 * of their certificate or of their first skill.
 *
 * The rule this suite locks in:
 *   1/2/3  A worker keeps many skills and certificates and can be assigned
 *          across trades.
 *   4/5    A missing certificate for a trade is NOT itself a refusal; a job
 *          with no MANDATORY requirement stays assignable.
 *   6      An unmet RECOMMENDED requirement is a WARNING on the response,
 *          never a refusal.
 *   7      Only an explicitly configured MANDATORY requirement blocks.
 *   8      A certificate of another category never substitutes a specific
 *          MANDATORY certificate.
 *   9      A safety/regulation certificate cannot be bypassed.
 *   10     No hardcoded "worker trade must equal Work Order trade" rule.
 *   11     Operations keeps the decision; the backend only validates the
 *          mandatory requirements, inside the existing assignment lifecycle.
 */
describe('PART 03B2B — multi-skill worker', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;
  let embedded: EmbeddedTestDatabase | null = null;
  let adminToken = '';
  let adminUserId = '';

  const EMBEDDED_DIR = '/tmp/hm-multiskill-03b2b-pg';
  const EMBEDDED_PORT = 55663;

  const suffix = () => randomUUID().slice(0, 8).toUpperCase();
  const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

  const FUTURE_DATE = '2030-12-31T00:00:00.000Z';
  const ISSUE_DATE = '2025-01-01T00:00:00.000Z';

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
    // Fresh cluster per run (startEmbeddedTestDatabase clears the data
    // directory), so no TRUNCATE is needed — and truncating `users` would
    // cascade away the platform-level trade registry seeded by 0465.

    const admin = await createAdminUser();
    adminToken = admin.token;
    adminUserId = admin.userId;

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
    client: { id: string };
    building: { id: string };
    organization: { id: string };
    department: { id: string };
    position: { id: string };
  };

  async function realm(): Promise<Realm> {
    const client = await clientService.createClient({
      code: `CL_${suffix()}`,
      name: 'Multi-skill Client',
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PR_${suffix()}`,
      name: 'Property',
    });
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `BL_${suffix()}`,
      name: 'Building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
    const organization = await organizationService.createOrganization({
      clientId: client.id,
      code: `OR_${suffix()}`,
      name: 'Org',
    });
    const department = await departmentService.createDepartment({
      organizationId: organization.id,
      code: `DP_${suffix()}`,
      name: 'Dept',
    });
    const position = await positionService.createPosition({
      organizationId: organization.id,
      code: `PS_${suffix()}`,
      name: 'Position',
    });
    return { client, building, organization, department, position };
  }

  async function worker(r: Realm, teamId?: string) {
    const profile = await workforceService.createWorkforceProfile({
      organizationId: r.organization.id,
      departmentId: r.department.id,
      positionId: r.position.id,
      ...(teamId ? { teamId } : {}),
      employeeCode: `WF_${suffix()}`,
      fullName: `Worker ${suffix()}`,
      workforceType: 'INTERNAL',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: profile.id,
      buildingId: r.building.id,
    });
    return profile;
  }

  async function workOrder(r: Realm, workType: string) {
    return workOrderService.createWorkOrder({
      clientId: r.client.id,
      buildingId: r.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Multi-skill job',
      description: 'Job dispatched by Operations.',
      workType,
      createdByUserId: adminUserId,
    });
  }

  async function tradeCategoryId(code: string): Promise<string> {
    const result = await q(
      'SELECT id FROM work_order_trade_categories WHERE code = $1',
      [code],
    );
    assert.ok(result.rows[0], `seeded trade category ${code} is missing`);
    return result.rows[0].id as string;
  }

  async function classify(workOrderId: string, tradeCategoryIdValue: string) {
    const response = await api()
      .patch(`/api/v1/work-orders/${workOrderId}/classification`)
      .set(auth())
      .send({ tradeCategoryId: tradeCategoryIdValue });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response;
  }

  async function assign(workOrderId: string, body: Record<string, unknown>) {
    return api()
      .post(`/api/v1/work-orders/${workOrderId}/assignments`)
      .set(auth())
      .send(body);
  }

  async function addRequirement(
    categoryId: string,
    clientId: string,
    body: Record<string, unknown>,
  ) {
    const response = await api()
      .post(
        `/api/v1/work-order-trade-categories/${categoryId}/competency-requirements?clientId=${clientId}`,
      )
      .set(auth())
      .send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response;
  }

  async function decisionRows(workOrderId: string) {
    const result = await q(
      `SELECT action, assignee_type, workforce_profile_id, requirement_type,
              enforcement_level, satisfied, reason, skill_code, certificate_name
         FROM work_order_assignment_competency_decisions
        WHERE work_order_id = $1
        ORDER BY evaluated_at ASC, id ASC`,
      [workOrderId],
    );
    return result.rows;
  }

  async function assignmentRows(workOrderId: string) {
    const result = await q(
      'SELECT id, status FROM work_order_assignments WHERE work_order_id = $1',
      [workOrderId],
    );
    return result.rows;
  }

  async function historyRows(workOrderId: string) {
    const result = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'WORK_ORDER' AND entity_id = $1`,
      [workOrderId],
    );
    return result.rows;
  }

  const certificationActor = (userId: string) => ({
    id: userId,
    permissions: new Set([
      'workforce_certification.read',
      'workforce_certification.manage',
      'workforce_certification.verify',
    ]),
  });

  /** Gives a worker one certificate — the platform never limits how many. */
  async function giveCertificate(
    workforceProfileId: string,
    certificateName: string,
    options: { skillId?: string } = {},
  ): Promise<string> {
    const created = await workforceCertificationService.createWorkforceCertification(
      workforceProfileId,
      {
        ...(options.skillId ? { skillId: options.skillId } : {}),
        certificateNumber: `CERT-${suffix()}`,
        certificateName,
        issuingAuthority: 'Kementerian Ketenagakerjaan RI',
        issueDate: ISSUE_DATE,
        expiryDate: FUTURE_DATE,
      },
      certificationActor(adminUserId),
    );
    await workforceCertificationService.verifyWorkforceCertification(
      workforceProfileId,
      created.id,
      { verificationStatus: 'VERIFIED' },
      certificationActor(adminUserId),
    );
    return created.id;
  }

  async function giveSkill(
    workforceProfileId: string,
    skillId: string,
    proficiencyLevel: 'BASIC' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT',
  ) {
    await assignSkillToWorkforce({
      workforceProfileId,
      skillId,
      proficiencyLevel,
    });
  }

  async function newSkill(r: Realm, label: string) {
    return skillService.createSkill({
      clientId: r.client.id,
      code: `SK_${label}_${suffix()}`,
      name: `${label} skill`,
      category: 'TECHNICAL',
    });
  }

  // -------------------------------------------------------------------------
  // B1 — AC-certified worker → electrical minor, no mandatory requirement
  // -------------------------------------------------------------------------

  describe('B1 — AC-certified worker on an electrical-minor job', () => {
    it('is ALLOWED when the trade has no mandatory requirement', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');

      const acSkill = await newSkill(r, 'AC');
      const tech = await worker(r);
      await giveSkill(tech.id, acSkill.id, 'ADVANCED');
      const acCert = await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });

      const wo = await workOrder(r, 'ELECTRICAL_SOCKET_DEAD');
      await classify(wo.id, electrical);

      const response = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.workforceProfileId, tech.id);

      // The decision is a fact, not an opinion: no requirement, no ledger row.
      assert.equal((await assignmentRows(wo.id)).length, 1);
      assert.equal((await decisionRows(wo.id)).length, 0);
      assert.equal(response.body.data.competency.satisfied, true);
      assert.equal(response.body.data.competency.mandatoryRequirementCount, 0);
      assert.deepEqual(response.body.data.competency.advisory, []);

      // Multi-skill identity is preserved: the AC certificate still exists and
      // was never narrowed by the electrical assignment.
      const certificates = await q(
        `SELECT id, certificate_name FROM workforce_certifications
          WHERE workforce_profile_id = $1`,
        [tech.id],
      );
      assert.equal(certificates.rows.length, 1);
      assert.equal(certificates.rows[0].id, acCert);
      assert.equal(certificates.rows[0].certificate_name, 'Sertifikat Teknisi AC');
    });
  });

  // -------------------------------------------------------------------------
  // B2 — AC-certified worker → plumbing, no mandatory requirement
  // -------------------------------------------------------------------------

  describe('B2 — AC-certified worker on a plumbing job', () => {
    it('is ALLOWED when the trade has no mandatory requirement', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const plumbing = await tradeCategoryId('PLUMBING');

      const acSkill = await newSkill(r, 'AC');
      const tech = await worker(r);
      await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });

      const wo = await workOrder(r, 'PLUMBING_LEAK');
      await classify(wo.id, plumbing);

      const response = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal((await decisionRows(wo.id)).length, 0);
      assert.equal(response.body.data.competency.tradeCategoryCode, 'PLUMBING');
    });

    it('is ALLOWED even when another worker in the same Client holds the plumbing certificate', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const plumbing = await tradeCategoryId('PLUMBING');

      // A colleague's plumbing credential must never be required of this
      // worker, and must never be borrowed as if it were theirs.
      const colleague = await worker(r);
      await giveCertificate(colleague.id, 'Sertifikat Plumbing');

      const wo = await workOrder(r, 'PLUMBING_LEAK');
      await classify(wo.id, plumbing);

      const acSkill = await newSkill(r, 'AC');
      const tech = await worker(r);
      await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });

      const response = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
    });
  });

  // -------------------------------------------------------------------------
  // B3 — unmet RECOMMENDED requirement = ALLOWED + WARNING
  // -------------------------------------------------------------------------

  describe('B3 — recommended skill not yet met', () => {
    it('is ALLOWED and returns a warning instead of a refusal', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');
      const electricalSkill = await newSkill(r, 'ELEC');

      await addRequirement(electrical, r.client.id, {
        requirementType: 'SKILL',
        enforcementLevel: 'RECOMMENDED',
        skillId: electricalSkill.id,
        minimumProficiencyLevel: 'INTERMEDIATE',
      });

      const acSkill = await newSkill(r, 'AC');
      const tech = await worker(r);
      await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });

      const wo = await workOrder(r, 'ELECTRICAL_SOCKET_DEAD');
      await classify(wo.id, electrical);

      const response = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));

      const competency = response.body.data.competency;
      assert.equal(competency.satisfied, true);
      assert.equal(competency.mandatoryRequirementCount, 0);
      assert.equal(competency.advisory.length, 1, JSON.stringify(competency));
      assert.equal(competency.advisory[0].workforceProfileId, tech.id);
      assert.equal(competency.advisory[0].skillCode, electricalSkill.code);
      assert.equal(competency.advisory[0].reason, 'SKILL_MISSING');
      assert.equal(competency.advisory[0].requirementType, 'SKILL');

      // The warning is durable and readable, not just a transient response.
      const rows = await decisionRows(wo.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].enforcement_level, 'RECOMMENDED');
      assert.equal(rows[0].satisfied, false);
      assert.equal(rows[0].reason, 'SKILL_MISSING');

      const history = await api()
        .get(`/api/v1/work-orders/${wo.id}/assignments/competency-decisions`)
        .set(auth());
      assert.equal(history.status, 200, JSON.stringify(history.body));
      assert.equal(history.body.data.length, 1);
      assert.equal(history.body.data[0].enforcementLevel, 'RECOMMENDED');
      assert.equal(history.body.data[0].satisfied, false);

      const events = await historyRows(wo.id);
      assert.ok(
        events.some((row) => row.event_type === 'WORK_ORDER_ASSIGNED'),
        'an allowed assignment still records its lifecycle event',
      );
    });
  });

  // -------------------------------------------------------------------------
  // B4 — unmet MANDATORY certification = DENIED
  // -------------------------------------------------------------------------

  describe('B4 — mandatory electrical certification not met', () => {
    it('is DENIED and leaves no assignment, ledger row or history event', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');

      await addRequirement(electrical, r.client.id, {
        requirementType: 'CERTIFICATION',
        enforcementLevel: 'MANDATORY',
        certificateName: 'Sertifikat Kompetensi Kelistrikan',
      });

      const acSkill = await newSkill(r, 'AC');
      const tech = await worker(r);
      await giveSkill(tech.id, acSkill.id, 'EXPERT');
      await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });

      const wo = await workOrder(r, 'ELECTRICAL_SOCKET_DEAD');
      await classify(wo.id, electrical);

      const denied = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(denied.status, 409, JSON.stringify(denied.body));
      assert.equal(
        denied.body.error.code,
        'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED',
      );
      assert.equal(
        denied.body.error.details[0].certificateName,
        'Sertifikat Kompetensi Kelistrikan',
      );
      assert.equal(
        denied.body.error.details[0].reason,
        'CERTIFICATION_MISSING',
      );
      assert.equal(denied.body.error.details[0].workforceProfileId, tech.id);

      // Rollback proof: no assignment, no ledger row, no assignment event.
      // (The Work Order still has its creation/classification events.)
      assert.equal((await assignmentRows(wo.id)).length, 0);
      assert.equal((await decisionRows(wo.id)).length, 0);
      const events = (await historyRows(wo.id)).map((row) => row.event_type);
      assert.ok(!events.includes('WORK_ORDER_ASSIGNED'));
      assert.ok(!events.includes('WORK_ORDER_REASSIGNED'));
    });
  });

  // -------------------------------------------------------------------------
  // B5 — multi-skilled worker satisfies every mandatory requirement
  // -------------------------------------------------------------------------

  describe('B5 — multi-skilled worker', () => {
    it('is ALLOWED when every mandatory requirement is met', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');
      const plumbingSkill = await newSkill(r, 'PLUMB');

      await addRequirement(electrical, r.client.id, {
        requirementType: 'CERTIFICATION',
        enforcementLevel: 'MANDATORY',
        certificateName: 'Sertifikat Kompetensi Kelistrikan',
      });
      await addRequirement(electrical, r.client.id, {
        requirementType: 'SKILL',
        enforcementLevel: 'MANDATORY',
        skillId: plumbingSkill.id,
        minimumProficiencyLevel: 'INTERMEDIATE',
      });

      const acSkill = await newSkill(r, 'AC');
      const multi = await worker(r);
      // One worker, three trades' worth of credentials.
      await giveCertificate(multi.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });
      await giveCertificate(multi.id, 'Sertifikat Kompetensi Kelistrikan');
      await giveSkill(multi.id, plumbingSkill.id, 'ADVANCED');

      const wo = await workOrder(r, 'ELECTRICAL_SOCKET_DEAD');
      await classify(wo.id, electrical);

      const response = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: multi.id,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.competency.satisfied, true);
      assert.equal(response.body.data.competency.mandatoryRequirementCount, 2);
      assert.deepEqual(response.body.data.competency.advisory, []);

      const rows = await decisionRows(wo.id);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.satisfied === true));
    });
  });

  // -------------------------------------------------------------------------
  // B6 — a certificate of another category is not a substitute
  // -------------------------------------------------------------------------

  describe('B6 — cross-category certificate', () => {
    it('does not substitute the specific mandatory certificate', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');
      const electricalSkill = await newSkill(r, 'ELEC');

      await addRequirement(electrical, r.client.id, {
        requirementType: 'CERTIFICATION',
        enforcementLevel: 'MANDATORY',
        certificateName: 'Sertifikat Kompetensi Kelistrikan',
      });

      // Holds the electrical skill at the top level plus an unrelated, valid
      // and VERIFIED certificate — still not the certificate the job requires.
      const tech = await worker(r);
      await giveSkill(tech.id, electricalSkill.id, 'EXPERT');
      await giveCertificate(tech.id, 'Sertifikat Teknisi AC');

      const wo = await workOrder(r, 'ELECTRICAL_SOCKET_DEAD');
      await classify(wo.id, electrical);

      const denied = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(denied.status, 409, JSON.stringify(denied.body));
      assert.equal(
        denied.body.error.details[0].reason,
        'CERTIFICATION_MISSING',
      );
      assert.equal(
        denied.body.error.details[0].certificateName,
        'Sertifikat Kompetensi Kelistrikan',
      );
      assert.equal((await decisionRows(wo.id)).length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // B7 — a safety/regulation certificate cannot be bypassed
  // -------------------------------------------------------------------------

  describe('B7 — safety requirement cannot be bypassed', () => {
    it('refuses smuggled override fields and keeps the mandatory gate', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');

      // The regulation-driven requirement is expressed exactly like any other
      // MANDATORY requirement — there is no separate "soft" mode to exploit.
      const requirement = await addRequirement(electrical, r.client.id, {
        requirementType: 'CERTIFICATION',
        enforcementLevel: 'MANDATORY',
        certificateName: 'Sertifikat K3 Kelistrikan',
        notes: 'Kewajiban keselamatan kerja (regulasi), tidak dapat dikecualikan.',
      });
      assert.equal(requirement.body.data.enforcementLevel, 'MANDATORY');

      const acSkill = await newSkill(r, 'AC');
      const tech = await worker(r);
      await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });

      const wo = await workOrder(r, 'ELECTRICAL_PANEL');
      await classify(wo.id, electrical);

      // Smuggling a bypass flag changes nothing: the gate reads requirements
      // from the database, never from the request.
      const bypassAttempt = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
        bypassCompetency: true,
        enforceCompetency: false,
        competencyOverride: { approverUserId: adminUserId },
        ignoreMandatoryRequirements: true,
      });
      assert.equal(bypassAttempt.status, 409, JSON.stringify(bypassAttempt.body));
      assert.equal(
        bypassAttempt.body.error.code,
        'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED',
      );
      assert.equal((await assignmentRows(wo.id)).length, 0);

      // The only way through is the certificate itself.
      await giveCertificate(tech.id, 'Sertifikat K3 Kelistrikan');
      const allowed = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    });
  });

  // -------------------------------------------------------------------------
  // B8 — no hardcoded "worker trade equals Work Order trade" rule
  // -------------------------------------------------------------------------

  describe('B8 — the gate is requirement-driven, not trade-driven', () => {
    it('assigns an AC worker to plumbing when the plumbing skill requirement is met', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const plumbing = await tradeCategoryId('PLUMBING');
      const plumbingSkill = await newSkill(r, 'PLUMB');

      await addRequirement(plumbing, r.client.id, {
        requirementType: 'SKILL',
        enforcementLevel: 'MANDATORY',
        skillId: plumbingSkill.id,
        minimumProficiencyLevel: 'BASIC',
      });

      const acSkill = await newSkill(r, 'AC');
      const tech = await worker(r);
      await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });
      // The very same worker also holds the plumbing skill — no trade change
      // and no new certificate is needed for the platform to allow this.
      await giveSkill(tech.id, plumbingSkill.id, 'INTERMEDIATE');

      const wo = await workOrder(r, 'PLUMBING_LEAK');
      await classify(wo.id, plumbing);

      const allowed = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: tech.id,
      });
      assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

      // Proof the refusal earlier was about the requirement, not the trade:
      // the SAME trade, a worker without the plumbing skill, is refused.
      const other = await worker(r);
      await giveCertificate(other.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });
      const second = await workOrder(r, 'PLUMBING_LEAK');
      await classify(second.id, plumbing);
      const denied = await assign(second.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: other.id,
      });
      assert.equal(denied.status, 409, JSON.stringify(denied.body));
      assert.equal(denied.body.error.details[0].reason, 'SKILL_MISSING');
      assert.equal(denied.body.error.details[0].skillCode, plumbingSkill.code);
    });
  });

  // -------------------------------------------------------------------------
  // B9 — a multi-skill team keeps the crew rule, warnings stay per member
  // -------------------------------------------------------------------------

  describe('B9 — team of multi-skill workers', () => {
    it('is allowed without requirements and warns per member for RECOMMENDED gaps', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');
      const electricalSkill = await newSkill(r, 'ELEC');

      await addRequirement(electrical, r.client.id, {
        requirementType: 'SKILL',
        enforcementLevel: 'RECOMMENDED',
        skillId: electricalSkill.id,
        minimumProficiencyLevel: 'BASIC',
      });

      const team = await teamService.createTeam({
        departmentId: r.department.id,
        code: `TM_${suffix()}`,
        name: 'Electrical Team',
      });
      const acSkill = await newSkill(r, 'AC');
      const first = await worker(r, team.id);
      const second = await worker(r, team.id);
      await giveCertificate(first.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });
      await giveCertificate(second.id, 'Sertifikat Teknisi AC', {
        skillId: acSkill.id,
      });

      const wo = await workOrder(r, 'ELECTRICAL_SOCKET_DEAD');
      await classify(wo.id, electrical);

      const response = await assign(wo.id, {
        assigneeType: 'TEAM',
        teamId: team.id,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.competency.rule, 'ALL');
      assert.equal(response.body.data.competency.advisory.length, 2);
      const warned = response.body.data.competency.advisory.map(
        (warning: { workforceProfileId: string }) => warning.workforceProfileId,
      );
      assert.deepEqual(warned.sort(), [first.id, second.id].sort());
    });
  });

  // -------------------------------------------------------------------------
  // B10 — the existing lifecycle and decision history stay intact
  // -------------------------------------------------------------------------

  describe('B10 — lifecycle and decision history preserved', () => {
    it('keeps assignment, reassignment and the ledger readable', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const electrical = await tradeCategoryId('ELECTRICAL_MINOR');

      const wo = await workOrder(r, 'ELECTRICAL_SOCKET_DEAD');
      await classify(wo.id, electrical);

      const acSkill = await newSkill(r, 'AC');
      const first = await worker(r);
      const second = await worker(r);
      for (const tech of [first, second]) {
        await giveCertificate(tech.id, 'Sertifikat Teknisi AC', {
          skillId: acSkill.id,
        });
      }

      const assigned = await assign(wo.id, {
        assigneeType: 'WORKFORCE',
        workforceProfileId: first.id,
      });
      assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

      const current = await api()
        .get(`/api/v1/work-orders/${wo.id}/assignments/current`)
        .set(auth());
      assert.equal(current.status, 200);
      assert.equal(current.body.data.workforceProfileId, first.id);
      // Plain reads carry no decision payload.
      assert.equal(current.body.data.competency, undefined);

      const reassigned = await api()
        .patch(
          `/api/v1/work-orders/${wo.id}/assignments/${assigned.body.data.id}`,
        )
        .set(auth())
        .send({ assigneeType: 'WORKFORCE', workforceProfileId: second.id });
      assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
      assert.equal(reassigned.body.data.workforceProfileId, second.id);

      const assignments = await assignmentRows(wo.id);
      assert.equal(assignments.length, 2);
      assert.equal(
        assignments.filter((row) => row.status === 'ACTIVE').length,
        1,
      );

      const events = await historyRows(wo.id);
      assert.equal(
        events.filter((row) => row.event_type === 'WORK_ORDER_ASSIGNED').length,
        1,
      );
      assert.equal(
        events.filter((row) => row.event_type === 'WORK_ORDER_REASSIGNED')
          .length,
        1,
      );

      // No requirement on this trade: the ledger stays empty, and the history
      // endpoint answers an empty page rather than failing.
      const history = await api()
        .get(`/api/v1/work-orders/${wo.id}/assignments/competency-decisions`)
        .set(auth());
      assert.equal(history.status, 200, JSON.stringify(history.body));
      assert.deepEqual(history.body.data, []);
      assert.deepEqual(history.body.meta, {});
    });
  });
});
