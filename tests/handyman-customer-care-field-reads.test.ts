import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import YAML from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { contextAccessService } from '../src/modules/context-access';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import {
  addHandymanCrewMember,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import {
  approveHandymanMaterialExecutionLine,
  estimateHandymanMaterialExecutionLine,
  issueHandymanMaterialExecutionLine,
  purchaseHandymanMaterialExecutionLine,
  returnHandymanMaterialExecutionLine,
  settleHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine,
} from '../src/modules/handyman-material-execution';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  checkInHandymanWorkSession,
  checkOutHandymanWorkSession,
  completeHandymanWorkSession,
  pauseHandymanWorkSession,
  resumeHandymanWorkSession,
  startWorkHandymanWorkSession,
} from '../src/modules/handyman-work-sessions';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const REF = { latitude: -6.2, longitude: 106.816666 };
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55497;
const DIR = '/tmp/asentra-cr-hm-17-part03-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(PORT),
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'asentra_test',
    DB_SSL: 'false',
  });
}

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const adminClient = postgres.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
  }
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE
    handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_work_session_helper_presence,
    handyman_work_session_events,
    handyman_work_sessions,
    handyman_arrival_verification_results,
    handyman_building_geospatial_policies,
    handyman_arrival_location_identifiers,
    handyman_arrival_challenges,
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
    inventory_items,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendors, workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings,
    properties, units_of_measure, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
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
  if (postgres) {
    try {
      await postgres.stop();
    } finally {
      postgres = null;
      await rm(DIR, { recursive: true, force: true });
    }
  }
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

async function insertQuotationMaterialLine(
  quotationVersionId: string,
  clientId: string,
  quantity: number,
  description: string,
): Promise<string> {
  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [clientId],
  );
  const lineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', $3,
               $4::numeric, $5::uuid, 25,
               ROUND($4::numeric * 25, 2), 'IDR', NULL, $6::uuid)`,
    [
      lineId,
      quotationVersionId,
      description,
      quantity,
      uomRow.rows[0].id,
      adminUserId,
    ],
  );
  return lineId;
}

describe('CR-HM-17 GAP PART 03 — Customer Care field reads (arrival, work sessions, material lines)', () => {
  it('1: GET /handyman/execution-scopes/:id/arrival-verification returns scope-keyed status/location facts with zero challenge token or hash', async (t) => {
    if (!requireDatabase(t)) return;

    const f = await baseFixture();
    const crew = await crewFixture(f.realm);
    const assignment = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: f.scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    // Before any terminal arrival evaluation: arrivalVerified=false, results=[]
    const beforeRes = await api()
      .get(
        `${V1}/handyman/execution-scopes/${f.scope.id}/arrival-verification`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(beforeRes.status, 200);
    assert.equal(beforeRes.body.data.executionScopeId, f.scope.id);
    assert.equal(beforeRes.body.data.arrivalVerified, false);
    assert.equal(beforeRes.body.data.latestResult, null);
    assert.deepEqual(beforeRes.body.data.results, []);
    assert.deepEqual(beforeRes.body.data.expectedLocation, {
      buildingId: f.scope.buildingId,
      floorId: f.scope.floorId,
      areaId: f.scope.areaId,
      roomId: f.scope.roomId,
      spaceId: f.scope.spaceId,
    });

    // Configure QR + building geospatial policy and record FAILED then VERIFIED
    await saveHandymanBuildingGeospatialPolicy(
      {
        buildingId: f.scope.buildingId,
        referenceLatitude: REF.latitude,
        referenceLongitude: REF.longitude,
        geofenceRadiusMeters: 100,
        maxAccuracyMeters: 40,
        maxLocationAgeSeconds: 900,
      },
      adminUserId,
    );
    const qr = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.scope.buildingId,
        floorId: f.scope.floorId,
        areaId: f.scope.areaId,
        roomId: f.scope.roomId,
        spaceId: f.scope.spaceId,
      },
      adminUserId,
    );

    const ch1 = await createHandymanArrivalChallenge(
      {
        executionScopeId: f.scope.id,
        assignmentId: assignment.id,
        ttlSeconds: 600,
      },
      crew.leadUser.id,
    );
    await evaluateHandymanArrivalVerification(
      {
        executionScopeId: f.scope.id,
        challengeToken: ch1.token,
        qrOpaqueCode: `wrong-${randomUUID()}`,
        deviceLocation: {
          latitude: REF.latitude,
          longitude: REF.longitude,
          accuracyMeters: 10,
          capturedAt: new Date().toISOString(),
        },
      },
      crew.leadUser.id,
    );

    const ch2 = await createHandymanArrivalChallenge(
      {
        executionScopeId: f.scope.id,
        assignmentId: assignment.id,
        ttlSeconds: 600,
      },
      crew.leadUser.id,
    );
    const verified = await evaluateHandymanArrivalVerification(
      {
        executionScopeId: f.scope.id,
        challengeToken: ch2.token,
        qrOpaqueCode: qr.value,
        deviceLocation: {
          latitude: REF.latitude,
          longitude: REF.longitude,
          accuracyMeters: 8,
          capturedAt: new Date().toISOString(),
        },
      },
      crew.leadUser.id,
    );
    assert.equal(verified.status, 'VERIFIED');

    const afterRes = await api()
      .get(
        `${V1}/handyman/execution-scopes/${f.scope.id}/arrival-verification`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(afterRes.status, 200);
    const data = afterRes.body.data;
    assert.equal(data.executionScopeId, f.scope.id);
    assert.equal(data.arrivalVerified, true);
    assert.equal(data.results.length, 2);
    assert.equal(data.results[0].status, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(data.results[1].status, 'VERIFIED');
    assert.equal(data.latestResult.id, verified.id);
    assert.equal(data.latestResult.status, 'VERIFIED');
    assert.deepEqual(data.latestResult.expectedLocation, {
      buildingId: f.scope.buildingId,
      floorId: f.scope.floorId,
      areaId: f.scope.areaId,
      roomId: f.scope.roomId,
      spaceId: f.scope.spaceId,
    });

    // Zero challenge token or token hash exposure anywhere in payload
    const rawJson = JSON.stringify(data);
    assert.equal(rawJson.includes(ch1.token), false);
    assert.equal(rawJson.includes(ch2.token), false);
    assert.equal(rawJson.toLowerCase().includes('tokenhash'), false);
    assert.equal(rawJson.toLowerCase().includes('token_hash'), false);
    assert.equal(rawJson.toLowerCase().includes('challengetoken'), false);
  });

  it('2: GET /handyman/execution-scopes/:id/work-sessions returns active + CHECKED_OUT sessions, events, helper presence, and presenceSeconds + actualWorkSeconds', async (t) => {
    if (!requireDatabase(t)) return;

    const f = await baseFixture();
    const crew = await crewFixture(f.realm);
    const helperUser = await userService.createUser({
      email: `helper-${randomUUID().slice(0, 6)}@example.com`,
      displayName: 'Crew Helper',
    });
    const helperProfile = await workforceService.createWorkforceProfile({
      organizationId: f.realm.organization.id,
      departmentId: f.realm.department.id,
      positionId: f.realm.position.id,
      employeeCode: `HELP_${randomUUID().slice(0, 6)}`,
      fullName: 'Helper Worker',
      workforceType: 'EXTERNAL',
      userId: helperUser.id,
    });
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: crew.vendor.id,
      workforceProfileId: helperProfile.id,
      vendorPersonnelCode: `VP_${randomUUID().slice(0, 6)}`,
    });
    const helperContext =
      await handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: crew.providerContext.id,
          workforceProfileId: helperProfile.id,
        },
        adminUserId,
      );
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: helperContext.id,
      },
      adminUserId,
    );

    const assignment = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: f.scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    // Record VERIFIED arrival so work sessions can check in
    await saveHandymanBuildingGeospatialPolicy(
      {
        buildingId: f.scope.buildingId,
        referenceLatitude: REF.latitude,
        referenceLongitude: REF.longitude,
        geofenceRadiusMeters: 100,
        maxAccuracyMeters: 40,
        maxLocationAgeSeconds: 900,
      },
      adminUserId,
    );
    const qr = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.scope.buildingId,
        floorId: f.scope.floorId,
        areaId: f.scope.areaId,
        roomId: f.scope.roomId,
        spaceId: f.scope.spaceId,
      },
      adminUserId,
    );
    const ch = await createHandymanArrivalChallenge(
      {
        executionScopeId: f.scope.id,
        assignmentId: assignment.id,
        ttlSeconds: 600,
      },
      crew.leadUser.id,
    );
    await evaluateHandymanArrivalVerification(
      {
        executionScopeId: f.scope.id,
        challengeToken: ch.token,
        qrOpaqueCode: qr.value,
        deviceLocation: {
          latitude: REF.latitude,
          longitude: REF.longitude,
          accuracyMeters: 5,
          capturedAt: new Date().toISOString(),
        },
      },
      crew.leadUser.id,
    );

    // Session 1: CHECK_IN -> START_WORK -> PAUSE -> RESUME -> COMPLETE -> CHECK_OUT
    const s1 = await checkInHandymanWorkSession(
      { executionScopeId: f.scope.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );
    await startWorkHandymanWorkSession(
      { sessionId: s1.session.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );
    await pauseHandymanWorkSession(
      { sessionId: s1.session.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );
    await resumeHandymanWorkSession(
      { sessionId: s1.session.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );
    await completeHandymanWorkSession(
      { sessionId: s1.session.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );
    await checkOutHandymanWorkSession(
      { sessionId: s1.session.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );

    // Session 2: active session (CHECK_IN -> START_WORK)
    const s2 = await checkInHandymanWorkSession(
      { executionScopeId: f.scope.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );
    await startWorkHandymanWorkSession(
      { sessionId: s2.session.id, idempotencyKey: `k-${randomUUID()}` },
      crew.leadUser.id,
    );

    const res = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/work-sessions`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.executionScopeId, f.scope.id);
    assert.equal(data.sessions.length, 2);
    assert.ok(data.activeSession);
    assert.equal(data.activeSession.id, s2.session.id);
    assert.equal(data.activeSession.status, 'IN_PROGRESS');
    assert.equal(data.activeSession.sessionClosed, false);

    const closedSession = data.sessions.find(
      (item: { id: string }) => item.id === s1.session.id,
    );
    assert.ok(closedSession);
    assert.equal(closedSession.status, 'CHECKED_OUT');
    assert.equal(closedSession.sessionClosed, true);
    assert.equal(typeof closedSession.presenceSeconds, 'number');
    assert.equal(typeof closedSession.actualWorkSeconds, 'number');
    assert.ok(closedSession.presenceSeconds >= 0);
    assert.ok(closedSession.actualWorkSeconds >= 0);
    assert.ok(closedSession.presenceSeconds >= closedSession.actualWorkSeconds);
    assert.deepEqual(
      closedSession.events.map((e: { eventType: string }) => e.eventType),
      ['CHECK_IN', 'START_WORK', 'PAUSE', 'RESUME', 'COMPLETE', 'CHECK_OUT'],
    );
    // Helper presence recorded on CHECK_IN and CHECK_OUT
    assert.equal(closedSession.helperPresence.length, 2);
    assert.equal(
      closedSession.helperPresence[0].helperWorkerId,
      helperContext.id,
    );

    // Scope-level aggregates include both sessions
    assert.ok(data.presenceSeconds >= closedSession.presenceSeconds);
    assert.ok(data.actualWorkSeconds >= closedSession.actualWorkSeconds);
  });

  it('3: GET /handyman/execution-scopes/:id/material-lines returns statuses/events and UOM-grouped final-used only', async (t) => {
    if (!requireDatabase(t)) return;

    const f = await baseFixture();
    const crew = await crewFixture(f.realm);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: f.scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );

    // Create 6 MATERIAL quotation lines so we can exercise all 6 governed statuses:
    // ESTIMATED, APPROVED, ISSUED, PURCHASED, USED, FINAL_CHARGE_READY
    const qLineEstimated = await insertQuotationMaterialLine(
      f.scope.approvedQuotationVersionId,
      f.scope.clientId,
      4,
      'Line ESTIMATED',
    );
    const qLineApproved = await insertQuotationMaterialLine(
      f.scope.approvedQuotationVersionId,
      f.scope.clientId,
      5,
      'Line APPROVED',
    );
    const qLineIssued = await insertQuotationMaterialLine(
      f.scope.approvedQuotationVersionId,
      f.scope.clientId,
      6,
      'Line ISSUED',
    );
    const qLinePurchased = await insertQuotationMaterialLine(
      f.scope.approvedQuotationVersionId,
      f.scope.clientId,
      7,
      'Line PURCHASED',
    );
    const qLineUsed = await insertQuotationMaterialLine(
      f.scope.approvedQuotationVersionId,
      f.scope.clientId,
      8,
      'Line USED',
    );
    const qLineSettled = await insertQuotationMaterialLine(
      f.scope.approvedQuotationVersionId,
      f.scope.clientId,
      10,
      'Line FINAL_CHARGE_READY',
    );

    const key = () => `k-${randomUUID()}`;

    // 1. ESTIMATED
    await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLineEstimated,
        estimatedQty: 4,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );

    // 2. APPROVED
    const lApproved = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLineApproved,
        estimatedQty: 5,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await approveHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lApproved.line.id,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );

    // 3. ISSUED
    const lIssued = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLineIssued,
        estimatedQty: 6,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await approveHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lIssued.line.id,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await issueHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lIssued.line.id,
        quantity: 4,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );

    // 4. PURCHASED
    const lPurchased = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLinePurchased,
        estimatedQty: 7,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await approveHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lPurchased.line.id,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await purchaseHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lPurchased.line.id,
        quantity: 5,
        supplierReference: 'SUP-REF-01',
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );

    // 5. USED
    const lUsed = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLineUsed,
        estimatedQty: 8,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await approveHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lUsed.line.id,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await issueHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lUsed.line.id,
        quantity: 6,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await useHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lUsed.line.id,
        quantity: 5,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );

    // 6. FINAL_CHARGE_READY (issued 9, used 7, returned 2 unused => finalUsedQty = 7)
    const lSettled = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLineSettled,
        estimatedQty: 10,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await approveHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lSettled.line.id,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await issueHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lSettled.line.id,
        quantity: 9,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await useHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lSettled.line.id,
        quantity: 7,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await returnHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lSettled.line.id,
        quantity: 2,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );
    await settleHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        lineId: lSettled.line.id,
        idempotencyKey: key(),
      },
      crew.leadUser.id,
    );

    const res = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/material-lines`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.executionScopeId, f.scope.id);
    assert.equal(data.lines.length, 6);
    assert.equal(data.finalUsedByUom.length, 1);
    assert.equal(data.finalUsedByUom[0].quantity, 7);

    const statuses = data.lines.map((l: { status: string }) => l.status).sort();
    assert.deepEqual(
      statuses,
      [
        'APPROVED',
        'ESTIMATED',
        'FINAL_CHARGE_READY',
        'ISSUED',
        'PURCHASED',
        'USED',
      ],
    );

    const settledItem = data.lines.find(
      (l: { id: string }) => l.id === lSettled.line.id,
    );
    assert.ok(settledItem);
    assert.equal(settledItem.estimatedQty, 10);
    assert.equal(settledItem.approvedQty, 10);
    assert.equal(settledItem.issuedQty, 9);
    assert.equal(settledItem.usedQty, 7);
    assert.equal(settledItem.returnedQty, 2);
    assert.equal(settledItem.finalUsedQty, 7);
    assert.deepEqual(
      settledItem.events.map((e: { eventType: string }) => e.eventType),
      ['ESTIMATE', 'APPROVE', 'ISSUE', 'USE', 'RETURN', 'FINAL_CHARGE_READY'],
    );

    // Zero money columns anywhere in the payload
    for (const line of data.lines) {
      for (const forbidden of [
        'price',
        'unitPrice',
        'unitAmount',
        'finalQuotedUnitAmount',
        'lineTotal',
        'subtotal',
        'totalAmount',
        'currency',
        'rate',
        'amount',
        'charge',
      ]) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(line, forbidden),
          false,
          `forbidden money key ${forbidden} on material line`,
        );
      }
    }
  });

  it('4: enforces 401, 403 (permission + canAccessClient), 404, and 400 across all three Customer Care field reads', async (t) => {
    if (!requireDatabase(t)) return;

    const f = await baseFixture();
    const noPermToken = await createPlainSession();
    const readerToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);

    const paths = [
      `${V1}/handyman/execution-scopes/${f.scope.id}/arrival-verification`,
      `${V1}/handyman/execution-scopes/${f.scope.id}/work-sessions`,
      `${V1}/handyman/execution-scopes/${f.scope.id}/material-lines`,
    ];

    // 401 unauthenticated
    for (const p of paths) {
      const res = await api().get(p);
      assert.equal(res.status, 401, `expected 401 on ${p}`);
    }

    // 403 without tenant_company.read
    for (const p of paths) {
      const res = await api()
        .get(p)
        .set('Authorization', `Bearer ${noPermToken}`);
      assert.equal(res.status, 403, `expected 403 on ${p}`);
    }

    // 403 when contextAccessService.canAccessClient denies access
    const originalCanAccessClient = contextAccessService.canAccessClient;
    contextAccessService.canAccessClient = async (
      _userId: string,
      targetClientId: string,
    ) => targetClientId !== f.scope.clientId;
    try {
      for (const p of paths) {
        const res = await api()
          .get(p)
          .set('Authorization', `Bearer ${readerToken}`);
        assert.equal(res.status, 403, `expected 403 on ${p} when client denied`);
        assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
      }
    } finally {
      contextAccessService.canAccessClient = originalCanAccessClient;
    }

    // 404 unknown executionScopeId
    const unknownId = randomUUID();
    for (const suffix of [
      'arrival-verification',
      'work-sessions',
      'material-lines',
    ]) {
      const res = await api()
        .get(`${V1}/handyman/execution-scopes/${unknownId}/${suffix}`)
        .set('Authorization', `Bearer ${readerToken}`);
      assert.equal(res.status, 404);
      assert.equal(
        res.body.error.code,
        'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
      );
    }

    // 400 malformed executionScopeId
    for (const suffix of [
      'arrival-verification',
      'work-sessions',
      'material-lines',
    ]) {
      const res = await api()
        .get(`${V1}/handyman/execution-scopes/not-a-uuid/${suffix}`)
        .set('Authorization', `Bearer ${readerToken}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('5: Lead-command firewall — Customer Care / admin non-Lead actors are rejected with 403 on all field POST commands', async (t) => {
    if (!requireDatabase(t)) return;

    const f = await baseFixture();
    const crew = await crewFixture(f.realm);
    const assignment = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: f.scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminUserId,
    );
    const ch = await createHandymanArrivalChallenge(
      {
        executionScopeId: f.scope.id,
        assignmentId: assignment.id,
        ttlSeconds: 600,
      },
      crew.leadUser.id,
    );
    const qLineId = await insertQuotationMaterialLine(
      f.scope.approvedQuotationVersionId,
      f.scope.clientId,
      5,
      'Firewall Material Line',
    );
    const estimated = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLineId,
        estimatedQty: 5,
        idempotencyKey: `k-${randomUUID()}`,
      },
      crew.leadUser.id,
    );

    // Admin has full RBAC permissions + client access, but is NOT the assigned Crew Lead
    await assert.rejects(
      async () =>
        createHandymanArrivalChallenge(
          { executionScopeId: f.scope.id },
          adminUserId,
        ),
      (err: { statusCode?: number }) => err.statusCode === 403,
    );

    const arrivalPost = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/arrival-verification`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        challengeToken: ch.token,
        qrOpaqueCode: 'any-qr',
        deviceLocation: null,
      });
    assert.equal(arrivalPost.status, 409);
    assert.equal(
      arrivalPost.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_INVALID',
    );

    for (const action of [
      'check-in',
      'start-work',
      'pause',
      'material-run',
      'resume',
      'complete',
      'check-out',
    ]) {
      const wsPost = await api()
        .post(
          `${V1}/handyman/execution-scopes/${f.scope.id}/work-sessions/${action}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ idempotencyKey: `k-${randomUUID()}` });
      assert.equal(
        wsPost.status,
        403,
        `expected 403 on non-Lead work-sessions/${action}`,
      );
    }

    const estPost = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/material-lines/estimate`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: qLineId,
        estimatedQty: 5,
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(estPost.status, 403);

    for (const action of ['approve', 'settle'] as const) {
      const matPost = await api()
        .post(
          `${V1}/handyman/execution-scopes/${f.scope.id}/material-lines/${estimated.line.id}/${action}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ idempotencyKey: `k-${randomUUID()}` });
      assert.equal(
        matPost.status,
        403,
        `expected 403 on non-Lead material-lines/${action}`,
      );
    }

    for (const action of ['issue', 'purchase', 'use', 'return'] as const) {
      const matPost = await api()
        .post(
          `${V1}/handyman/execution-scopes/${f.scope.id}/material-lines/${estimated.line.id}/${action}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          quantity: 1,
          idempotencyKey: `k-${randomUUID()}`,
        });
      assert.equal(
        matPost.status,
        403,
        `expected 403 on non-Lead material-lines/${action}`,
      );
    }
  });

  it('6: OpenAPI documents the three Customer Care field read endpoints and schemas', () => {
    const raw = readFileSync('docs/api/openapi.yaml', 'utf8');
    const doc = YAML.parse(raw);

    const arrivalGet =
      doc.paths?.['/handyman/execution-scopes/{executionScopeId}/arrival-verification']
        ?.get;
    assert.ok(arrivalGet, 'GET arrival-verification path must exist');
    assert.equal(
      arrivalGet.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref,
      '#/components/schemas/HandymanCustomerCareArrivalVerificationProjection',
    );

    const workSessionsGet =
      doc.paths?.['/handyman/execution-scopes/{executionScopeId}/work-sessions']
        ?.get;
    assert.ok(workSessionsGet, 'GET work-sessions path must exist');
    assert.equal(
      workSessionsGet.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref,
      '#/components/schemas/HandymanCustomerCareWorkSessionsProjection',
    );

    const materialLinesGet =
      doc.paths?.[
        '/handyman/execution-scopes/{executionScopeId}/material-lines'
      ]?.get;
    assert.ok(materialLinesGet, 'GET material-lines path must exist');
    assert.equal(
      materialLinesGet.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref,
      '#/components/schemas/HandymanCustomerCareMaterialLinesProjection',
    );

    // PART 08 certification: responses are full SuccessEnvelope bodies;
    // the existing projection contract is bound under data, not at the root.
    for (const operation of [arrivalGet, workSessionsGet, materialLinesGet]) {
      assert.equal(
        operation.responses['200'].content['application/json'].schema.allOf[0].$ref,
        '#/components/schemas/SuccessEnvelope',
      );
    }

    assert.ok(
      doc.components?.schemas?.HandymanCustomerCareArrivalVerificationProjection,
    );
    assert.ok(
      doc.components?.schemas?.HandymanCustomerCareWorkSessionsProjection,
    );
    assert.ok(
      doc.components?.schemas?.HandymanCustomerCareMaterialLinesProjection,
    );
  });
});
