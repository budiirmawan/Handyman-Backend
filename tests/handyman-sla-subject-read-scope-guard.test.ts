import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { readHandymanSubjectSlaView }
  from '../src/modules/handyman-sla-status-api';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 06H (ULTRA-LIGHT) — focused tests for the SLA
 * SUBJECT READ authorization boundary in
 * handyman-sla-status-api.service.ts: `readHandymanSubjectSlaView`,
 * whose wall was the shared client-level `assertClientReadAccess`
 * (`canAccessClient` on the subject's clientId). It now uses a
 * dedicated `assertSubjectReadAccess` — the established BE-02G
 * exact-Building guard on the authoritative buildingId ALREADY
 * resolved by `findDomainSubjectContext` — in the wall's ORIGINAL
 * position (after the subject 404s, before the projection).
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. All FIVE subject types resolve a trustworthy
 * NOT NULL buildingId: HANDYMAN_SERVICE_REQUEST (the request row,
 * migration 0378), HANDYMAN_EXECUTION_SCOPE (the authoritative scope
 * snapshot, migration 0395), HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT /
 * HANDYMAN_DEFECT_RECORD / HANDYMAN_SERVICE_WARRANTY_CLAIM (a join to
 * the execution scope's building_id). Fail-closed if no buildingId
 * resolves — no invented attribution, no client-level fallback.
 *
 * Denial vocabulary unchanged: 403 BUILDING_ACCESS_DENIED — the
 * previous client-wall thrower is the guard's OWN thrower, so the
 * assert form is byte-identical. Error precedence unchanged (subject
 * 404 precedes the access wall; authorization precedes the
 * projection). SLA calculation, policy/snapshot semantics, response
 * shapes and read-only behavior preserved.
 *
 * Actor contract (verified): a LOCAL Customer Care staff actor
 * (`actorUserId`; route `tenant_company.read`); no BM SSO / customer
 * principal reaches this read. The shared `assertClientReadAccess`
 * helper is RETAINED unchanged for the provider-performance view
 * (already building-scoped via its own `canAccessBuilding` check) and
 * the two status-visibility readers — those are NOT altered by this
 * PART.
 *
 * Preserved: the frozen 9-milestone coordinate map, the applied-SLA
 * projection (null when no SLA is applied), and the view's exact
 * response shape. Unrelated modules untouched.
 *
 * Two focused cases:
 *   1. authorized exact-building reads — a staff actor with an
 *      explicit ACTIVE assignment to the subject's exact Building
 *      reads ALL FIVE subject types;
 *   2. same-client sibling building — a staff actor holding ONLY the
 *      same-Client SIBLING Building is denied 403 on ALL FIVE
 *      subject reads, with no data leakage.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_service_warranty_claim_events,
    handyman_service_warranty_claims,
    handyman_service_warranty_events,
    handyman_service_warranty_coverages, handyman_service_warranties,
    handyman_bast_sign_offs,
    handyman_bast_events, handyman_bast_documents,
    handyman_arrival_verification_results,
    handyman_building_geospatial_policies,
    handyman_arrival_location_identifiers,
    handyman_arrival_challenges,
    handyman_defect_events, handyman_defect_records,
    handyman_qc_run_events, handyman_qc_run_items, handyman_qc_runs,
    handyman_evidence_record_events,
    handyman_evidence_record_files, handyman_evidence_records,
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
    users, roles, permissions, clients, units_of_measure CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: d.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
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

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

/** Asserts the exact BE-02G denial: 403 BUILDING_ACCESS_DENIED. */
async function assertBuildingDenied(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

const SUBJECT_TYPES = [
  'HANDYMAN_SERVICE_REQUEST',
  'HANDYMAN_EXECUTION_SCOPE',
  'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
  'HANDYMAN_DEFECT_RECORD',
  'HANDYMAN_SERVICE_WARRANTY_CLAIM',
] as const;

/**
 * The scope's building is A1. Adds the same-Client SIBLING Building
 * A2, a scope-crew assignment (subject type 3), and direct-INSERT
 * domain rows for the defect (type 4) and warranty-claim (type 5)
 * subjects — the SLA view only resolves each subject's clientId +
 * buildingId, so minimal lawful rows suffice (the repo's own
 * direct-INSERT fixture convention).
 */
async function slaSubjectFixture() {
  const base = await baseFixture();
  assert.ok(base.scope, 'execution scope required');
  const f = { ...base, scope: base.scope };
  const buildingA2 = await buildingService.createBuilding({
    propertyId: f.realm.property.id,
    code: `B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building A2 (same-client sibling)',
  });
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const requestId = (
    await q(
      `SELECT handyman_request_id AS id FROM handyman_execution_scopes
        WHERE id = $1`,
      [f.scope.id],
    )
  ).rows[0].id as string;

  // Type 4 — HANDYMAN_DEFECT_RECORD (direct INSERT, minimal row).
  const defectId = randomUUID();
  await q(
    `INSERT INTO handyman_defect_records
        (id, client_id, execution_scope_id, description, status)
      VALUES ($1, $2, $3, $4, 'OPENED')`,
    [defectId, f.realm.client.id, f.scope.id, 'Fixture defect.'],
  );

  // Type 5 — HANDYMAN_SERVICE_WARRANTY_CLAIM (direct INSERTs in ONE
  // transaction: BAST -> warranty -> BOTH coverages -> claim, all
  // server-shaped columns only; the warranty anchor trigger requires
  // an ACCEPTED BAST with the start boundary equal to the recorded
  // acceptance instant, and the both-coverages law is a DEFERRED
  // constraint trigger checked at COMMIT).
  if (!pool) throw new Error('db pool not initialized');
  const client = await pool.connect();
  const bastId = randomUUID();
  const acceptedAt = new Date();
  const warrantyId = randomUUID();
  const claimId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO handyman_bast_documents
          (id, client_id, execution_scope_id, status, issued_at,
           accepted_at)
        VALUES ($1, $2, $3, 'ACCEPTED', NOW(), $4)`,
      [bastId, f.realm.client.id, f.scope.id, acceptedAt],
    );
    await client.query(
      `INSERT INTO handyman_service_warranties
          (id, client_id, execution_scope_id, bast_id, bast_accepted_at,
           status, starts_at, started_by_user_id)
        VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $5, $6)`,
      [warrantyId, f.realm.client.id, f.scope.id, bastId, acceptedAt,
        adminUserId],
    );
    for (const coverageType of ['WORKMANSHIP', 'MATERIAL']) {
      await client.query(
        `INSERT INTO handyman_service_warranty_coverages
            (id, client_id, warranty_id, execution_scope_id,
             coverage_type)
          VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), f.realm.client.id, warrantyId, f.scope.id,
          coverageType],
      );
    }
    await client.query(
      `INSERT INTO handyman_service_warranty_claims
          (id, client_id, warranty_id, execution_scope_id, bast_id,
           status, claim_note, opened_by_user_id)
        VALUES ($1, $2, $3, $4, $5, 'CLAIM_DRAFT', 'Fixture claim.',
                $6)`,
      [claimId, f.realm.client.id, warrantyId, f.scope.id, bastId,
        adminUserId],
    );
    // The claim requires its intake OPEN event (DB trigger law).
    await client.query(
      `INSERT INTO handyman_service_warranty_claim_events
          (id, client_id, claim_id, warranty_id, execution_scope_id,
           bast_id, event_type, idempotency_key, actor_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8)`,
      [randomUUID(), f.realm.client.id, claimId, warrantyId, f.scope.id,
        bastId, `fixture-open-${randomUUID()}`, adminUserId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    ...f,
    buildingA2,
    subjects: {
      HANDYMAN_SERVICE_REQUEST: requestId,
      HANDYMAN_EXECUTION_SCOPE: f.scope.id,
      HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT: assignment.id,
      HANDYMAN_DEFECT_RECORD: defectId,
      HANDYMAN_SERVICE_WARRANTY_CLAIM: claimId,
    } as Record<(typeof SUBJECT_TYPES)[number], string>,
  };
}

/** A plain local Customer Care staff actor holding ONLY `buildingId`. */
async function staffActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `care-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Care Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

describe('CR-HM-SEC-01 PART 06H — SLA subject read building-scope guard', () => {
  it('1: authorized exact-building reads — staff actor (exact Building) reads ALL FIVE subject types', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await slaSubjectFixture();
    const staff = await staffActor(f.realm.building.id);

    for (const subjectType of SUBJECT_TYPES) {
      const view = await readHandymanSubjectSlaView(
        staff,
        subjectType,
        f.subjects[subjectType],
      );
      assert.equal(view.subjectType, subjectType);
      assert.equal(view.subjectId, f.subjects[subjectType]);
      assert.equal(view.clientId, f.realm.client.id);
      assert.equal(view.buildingId, f.realm.building.id);
      // No SLA applied in the fixture: null projection, milestone
      // clocks null, but the frozen milestone map is present.
      assert.equal(view.appliedSla, null);
      assert.ok(view.milestones.length > 0);
      for (const milestone of view.milestones) {
        assert.equal(milestone.subjectType, subjectType);
        assert.equal(milestone.clock, null);
      }
    }
  });

  it('2: same-client sibling building — ALL FIVE subject reads denied 403 with no data leakage', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await slaSubjectFixture();
    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const sibling = await staffActor(f.buildingA2.id);

    for (const subjectType of SUBJECT_TYPES) {
      await assertBuildingDenied(
        readHandymanSubjectSlaView(
          sibling,
          subjectType,
          f.subjects[subjectType],
        ),
      );
    }

    // The reads are pure: every subject row still resolves (the
    // denial leaked no subject data — only the bounded 403).
    for (const subjectType of SUBJECT_TYPES) {
      const subjectId = f.subjects[subjectType];
      const stillThere = await q(
        `SELECT 1 FROM (
          SELECT id FROM handyman_service_requests WHERE id = $1
          UNION ALL SELECT id FROM handyman_execution_scopes WHERE id = $1
          UNION ALL SELECT id FROM handyman_execution_scope_assignments
            WHERE id = $1
          UNION ALL SELECT id FROM handyman_defect_records WHERE id = $1
          UNION ALL SELECT id FROM handyman_service_warranty_claims
            WHERE id = $1
        ) s LIMIT 1`,
        [subjectId],
      );
      assert.equal(stillThere.rows.length, 1, `${subjectType} row intact`);
    }
  });
});
