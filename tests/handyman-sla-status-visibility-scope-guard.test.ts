import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  readHandymanExecutionScopeStatusVisibility,
  readHandymanRequestStatusVisibility,
} from '../src/modules/handyman-sla-status-api';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 06H-2 (ULTRA-LIGHT) — focused tests for the SLA
 * STATUS VISIBILITY READ authorization boundary in
 * handyman-sla-status-api.service.ts (PART 07A audit finding 1):
 * `readHandymanRequestStatusVisibility` (route GET
 * /handyman/requests/:id/status-visibility, `read`) and
 * `readHandymanExecutionScopeStatusVisibility` (route GET
 * /handyman/execution-scopes/:id/status-visibility, `read`). Both
 * walls — previously the shared client-level `assertClientReadAccess`
 * — now use the existing BE-02G `assertSubjectReadAccess` helper
 * (added in PART 06H) on the authoritative buildingId ALREADY
 * selected from the request/scope row, in each wall's ORIGINAL
 * position (after the resource 404, before any sensitive
 * projection).
 *
 * Authority (established in PART 01, audited in PART 07A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The request row carries the server-derived
 * building_id (migration 0378) and the scope row the authoritative
 * scope snapshot (migration 0395).
 *
 * Denial vocabulary unchanged: 403 BUILDING_ACCESS_DENIED — the
 * previous client-wall thrower is the guard's OWN thrower, so the
 * assert form is byte-identical. Error precedence unchanged
 * (resource 404 precedes the access wall). Projection/response
 * shapes, SLA/status semantics and read-only behavior preserved.
 *
 * Actor contract (verified): LOCAL Customer Care staff
 * (`actorUserId`; route `tenant_company.read`); no BM SSO / customer
 * principal reaches these reads.
 *
 * NOT altered: `readHandymanSubjectSlaView` (06H), the
 * provider-performance view (contractual, keeps the shared
 * `assertClientReadAccess` + its own `canAccessBuilding` check),
 * request lifecycle, and unrelated modules.
 *
 * Two focused cases:
 *   1. authorized exact-building staff READ — a staff actor with an
 *      explicit ACTIVE assignment to the request/scope's exact
 *      Building reads BOTH status-visibility views;
 *   2. same-client sibling building — a staff actor holding ONLY the
 *      same-Client SIBLING Building receives 403 on BOTH reads, with
 *      no data leakage.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_service_requests,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
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

/**
 * The scope's building is A1. Adds the same-Client SIBLING Building
 * A2 alongside the shared base fixture (realm + chain + AUTHORIZED
 * scope + its intake request).
 */
async function visibilityFixture() {
  const base = await baseFixture();
  assert.ok(base.scope, 'execution scope required');
  const f = { ...base, scope: base.scope };
  const buildingA2 = await buildingService.createBuilding({
    propertyId: f.realm.property.id,
    code: `B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building A2 (same-client sibling)',
  });
  const requestId = (
    await q(
      `SELECT handyman_request_id AS id FROM handyman_execution_scopes
        WHERE id = $1`,
      [f.scope.id],
    )
  ).rows[0].id as string;
  return { ...f, buildingA2, requestId };
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

describe('CR-HM-SEC-01 PART 06H-2 — SLA status-visibility read building-scope guard', () => {
  it('1: authorized exact-building staff READ — both status-visibility views return the composed projection', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await visibilityFixture();
    const staff = await staffActor(f.realm.building.id);

    // REQUEST-anchored visibility view.
    const byRequest = await readHandymanRequestStatusVisibility(
      staff,
      f.requestId,
    );
    assert.equal(byRequest.anchorType, 'HANDYMAN_SERVICE_REQUEST');
    assert.equal(byRequest.clientId, f.realm.client.id);
    assert.equal(byRequest.buildingId, f.realm.building.id);
    assert.equal(byRequest.handymanRequestId, f.requestId);
    assert.equal(byRequest.executionScopeId, f.scope.id);
    assert.equal(byRequest.stages.request.requestId, f.requestId);
    assert.ok(Array.isArray(byRequest.slaMilestones));

    // SCOPE-anchored visibility view.
    const byScope = await readHandymanExecutionScopeStatusVisibility(
      staff,
      f.scope.id,
    );
    assert.equal(byScope.anchorType, 'HANDYMAN_EXECUTION_SCOPE');
    assert.equal(byScope.clientId, f.realm.client.id);
    assert.equal(byScope.buildingId, f.realm.building.id);
    assert.equal(byScope.handymanRequestId, f.requestId);
    assert.equal(byScope.executionScopeId, f.scope.id);
    assert.equal(byScope.stages.request.requestId, f.requestId);
    assert.ok(Array.isArray(byScope.slaMilestones));
  });

  it('2: same-client sibling building — BOTH reads denied 403 with no data leakage', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await visibilityFixture();
    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const sibling = await staffActor(f.buildingA2.id);

    // REQUEST-anchored read — denied after the request 404, before
    // any sensitive projection.
    await assertBuildingDenied(
      readHandymanRequestStatusVisibility(sibling, f.requestId),
    );

    // SCOPE-anchored read — denied after the scope 404, before any
    // sensitive projection.
    await assertBuildingDenied(
      readHandymanExecutionScopeStatusVisibility(sibling, f.scope.id),
    );

    // The reads are pure: both rows still resolve (the denial leaked
    // no stage/status data — only the bounded 403).
    const requestStillThere = await q(
      `SELECT 1 FROM handyman_service_requests WHERE id = $1`,
      [f.requestId],
    );
    assert.equal(requestStillThere.rows.length, 1);
    const scopeStillThere = await q(
      `SELECT 1 FROM handyman_execution_scopes WHERE id = $1`,
      [f.scope.id],
    );
    assert.equal(scopeStillThere.rows.length, 1);
  });
});
