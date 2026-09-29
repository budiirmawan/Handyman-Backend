import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import {
  consumeHandymanArrivalChallenge,
  createHandymanArrivalChallenge,
} from '../src/modules/handyman-arrival-challenges';
import {
  createHandymanArrivalLocationIdentifier,
  deactivateHandymanArrivalLocationIdentifier,
} from '../src/modules/handyman-arrival-locations';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { saveHandymanBuildingGeospatialPolicy }
  from '../src/modules/handyman-geospatial-policies';
import {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import { createAdminUser, createPlainSession } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  locationChain,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';
import { api } from './helpers/http';

/**
 * CR-HM-07 PART 04C — terminal arrival verification HTTP/OpenAPI
 * exposure over the PART 04B evaluator. Ten cases prove: positive
 * VERIFIED round-trip; schema rejections; authority-shaped body keys
 * provably ignored; terminal FAILED/MANUAL/EXPIRED as normal 200
 * evaluation responses (never HTTP failures); bounded error mapping
 * (401/403/404/400/409); replay identity; OpenAPI contract parity;
 * and ZERO decision logic/API.CO.ID/work-session/FM surfaces in the
 * route. The route is a thin shell — PART 04B remains the authority.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_arrival_verification_results,
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
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendors, workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN');
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

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8')
  .digest('hex');
const REF = { latitude: -6.2, longitude: 106.816666 };

function policyInput(buildingId: string, over: Record<string, unknown> = {}) {
  return {
    buildingId,
    referenceLatitude: REF.latitude,
    referenceLongitude: REF.longitude,
    geofenceRadiusMeters: 100,
    maxAccuracyMeters: 40,
    maxLocationAgeSeconds: 900,
    ...over,
  };
}

function goodDevice(over: Record<string, unknown> = {}) {
  return {
    latitude: REF.latitude,
    longitude: REF.longitude,
    accuracyMeters: 10,
    capturedAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * Led and credential-wired: the Crew Lead gets a Bearer session token
 * (authenticated user only — no role/perms; eligibility = 04B).
 */
async function authorityFixture(opts: {
  withPolicy?: boolean;
  withMatchingQr?: boolean;
  withChallenge?: boolean;
} = {}) {
  const { withPolicy = true, withMatchingQr = true,
    withChallenge = true } = opts;
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  // Crew Lead real session (login + building/client access already
  // covered by handyman fixtures).
  const password = `LeadPass${randomUUID().slice(0, 6)}`;
  await credentialService.createInitialCredential({
    userId: crew.leadUser.id,
    password,
  });
  const login = await api().post('/api/v1/auth/login').send({
    email: crew.leadUser.email,
    password,
  });
  const token = login.body.data.sessionToken as string;
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const created = withChallenge
    ? await createHandymanArrivalChallenge(
        { executionScopeId: f.scope.id }, crew.leadUser.id)
    : null;
  let policy: { id: string } | null = null;
  if (withPolicy) {
    policy = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id), adminUserId);
  }
  let matchingQr: { value: string; identifierId: string } | null = null;
  if (withMatchingQr) {
    const reg = await createHandymanArrivalLocationIdentifier({
      buildingId: f.realm.building.id,
      floorId: f.chain.floor.id,
      areaId: f.chain.area.id,
      roomId: f.chain.room.id,
      spaceId: f.chain.space.id,
    }, adminUserId);
    matchingQr = { value: reg.value, identifierId: reg.identifier.id };
  }
  return {
    ...f, crew, token, assignmentId: assignment.id,
    challenge: created?.challenge ?? null,
    challengeToken: created?.token ?? '',
    actorUserId: crew.leadUser.id, policy, matchingQr,
  };
}

const pathFor = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/arrival-verification`;

function validBody(f: Awaited<ReturnType<typeof authorityFixture>>,
  over: Record<string, unknown> = {}) {
  return {
    challengeToken: f.challengeToken,
    qrOpaqueCode: f.matchingQr!.value,
    deviceLocation: goodDevice(),
    ...over,
  };
}

describe('CR-HM-07 PART 04C — arrival verification HTTP surface', () => {
  it('1: authenticated positive request => 200 VERIFIED', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const res = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f));
    assert.equal(res.status, 200);
    const d = res.body.data;
    assert.equal(d.status, 'VERIFIED');
    assert.equal(d.primaryReason, 'ALL_POSITIVE_EVIDENCE');
    assert.equal(d.qrSignal, 'MATCH');
    assert.equal(d.geofenceSignal, 'INSIDE');
    assert.ok(d.id && d.challengeId && d.executionScopeId);
    assert.ok(typeof d.evaluatedAt === 'string');
    // Bounded response keys only (no hidden ids / secrets / provider payloads).
    assert.deepEqual(Object.keys(d).sort(), [
      'challengeId', 'distanceMeters', 'evaluatedAt',
      'executionScopeId', 'geofenceSignal', 'id', 'primaryReason',
      'qrSignal', 'status',
    ]);
    // Challenge consumed exactly once.
    const ch = await q(
      `SELECT status, consumed_at FROM handyman_arrival_challenges
        WHERE id = $1`,
      [f.challenge.id]);
    assert.equal(ch.rows[0].status, 'CONSUMED');
    assert.ok(ch.rows[0].consumed_at !== null);
  });

  it('2: schema rejects missing/invalid required fields', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const cases: unknown[] = [
      {}, // empty
      { challengeToken: f.challengeToken }, // missing qr
      { qrOpaqueCode: f.matchingQr!.value }, // missing token
      { challengeToken: '', qrOpaqueCode: 'x' }, // empty token
      { challengeToken: 'x', qrOpaqueCode: '' }, // empty qr
      validBody(f, { deviceLocation: 'not-object' }),
      validBody(f, {
        deviceLocation: { latitude: -6.2, longitude: 106.8 },
      }), // missing accuracy/capturedAt
      validBody(f, {
        deviceLocation: { ...goodDevice(), accuracyMeters: 'high' },
      }),
      validBody(f, {
        deviceLocation: { ...goodDevice(), capturedAt: 'nope' },
      }),
    ];
    for (const body of cases) {
      const res = await api()
        .post(pathFor(f.scope.id))
        .set('Authorization', `Bearer ${f.token}`)
        .send(body);
      assert.equal(res.status, 400,
        `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    // invalid UUID path param
    const res = await api()
      .post(pathFor('not-a-uuid'))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f));
    assert.equal(res.status, 400);
    // Challenge NOT consumed by any rejected request.
    const ch = await q(
      `SELECT status FROM handyman_arrival_challenges WHERE id = $1`,
      [f.challenge.id]);
    assert.equal(ch.rows[0].status, 'PENDING');
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [f.challenge.id]);
    assert.equal(count.rows[0].n, 0);
  });

  it('3: authority-shaped body keys CANNOT influence the result', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const res = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        ...validBody(f),
        // Smuggled authority/derived/secret-shaped keys:
        actorUserId: randomUUID(),
        workerId: randomUUID(),
        crewId: randomUUID(),
        assignmentId: randomUUID(),
        clientId: randomUUID(),
        expectedBuildingId: randomUUID(),
        policyId: randomUUID(),
        distanceMeters: 99999,
        geofenceSignal: 'OUTSIDE',
        status: 'FAILED',
        primaryReason: 'QR_MISMATCH',
        tokenHash: 'spoofed',
        rawProviderPayload: { foo: 'bar' },
      });
    assert.equal(res.status, 200);
    const d = res.body.data;
    assert.equal(d.status, 'VERIFIED',
      'authority-shaped smuggle must not win');
    assert.equal(d.primaryReason, 'ALL_POSITIVE_EVIDENCE');
    assert.equal(d.geofenceSignal, 'INSIDE');
    assert.equal(d.qrSignal, 'MATCH');
    assert.deepEqual(Object.keys(d).sort(), [
      'challengeId', 'distanceMeters', 'evaluatedAt',
      'executionScopeId', 'geofenceSignal', 'id', 'primaryReason',
      'qrSignal', 'status',
    ], 'response stays bounded regardless of smuggle');
    assert.equal(JSON.stringify(d).includes('spoofed'), false);
  });

  it('4: terminal FAILED returns as normal 200 evaluation response', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const siblingChain = await locationChain(f.realm);
    const sibQr = await createHandymanArrivalLocationIdentifier({
      buildingId: f.realm.building.id,
      floorId: siblingChain.floor.id,
      areaId: siblingChain.area.id,
      roomId: siblingChain.room.id,
      spaceId: siblingChain.space.id,
    }, adminUserId);
    const res = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f, { qrOpaqueCode: sibQr.value }));
    assert.equal(res.status, 200,
      'FAILED is a successful evaluation response, never an HTTP error');
    assert.equal(res.body.data.status, 'FAILED');
    assert.equal(res.body.data.primaryReason, 'QR_MISMATCH');
    assert.equal(res.body.data.qrSignal, 'MISMATCH');
    assert.equal(res.headers['x-request-id'] !== undefined, true);
  });

  it('5: MANUAL_REVIEW_REQUIRED returns normally', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await deactivateHandymanArrivalLocationIdentifier(
      f.matchingQr!.identifierId, adminUserId);
    const res = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(res.body.data.primaryReason, 'QR_INACTIVE');
    // Also no-device case -> MANUAL (no active policy? policy exists)
    const f2 = await authorityFixture();
    const res2 = await api()
      .post(pathFor(f2.scope.id))
      .set('Authorization', `Bearer ${f2.token}`)
      .send({ challengeToken: f2.challengeToken,
        qrOpaqueCode: f2.matchingQr!.value });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.data.status, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(res2.body.data.primaryReason, 'GEOFENCE_UNAVAILABLE');
  });

  it('6: EXPIRED returns normally as 200', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture({ withChallenge: false });
    const expiredToken = `expired-${randomUUID()}`;
    const expiredId = randomUUID();
    await q(
      `INSERT INTO handyman_arrival_challenges
         (id, client_id, execution_scope_id, assignment_id, actor_user_id,
          token_hash, status, expires_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'PENDING', $7, NOW(), NOW())`,
      [expiredId, f.realm.client.id, f.scope.id, f.assignmentId,
        f.actorUserId, sha256(expiredToken),
        new Date(Date.now() - 60_000)],
    );
    const res = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f, { challengeToken: expiredToken }));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'EXPIRED');
    assert.equal(res.body.data.primaryReason, 'CHALLENGE_EXPIRED');
    assert.equal(res.body.data.qrSignal, 'MATCH');
  });

  it('7: bounded error mapping for challenge/scope/identity failures', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    // Invalid token binding => 409 conflict-family bounded domain error
    const badToken = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f, { challengeToken: `wrong-${randomUUID()}` }));
    assert.equal(badToken.status, 409);
    assert.equal(badToken.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_INVALID');
    // Unknown scope => 404 (or 403 realm) bounded domain shape.
    const unknownScope = await api()
      .post(pathFor(randomUUID()))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f));
    assert.ok([403, 404].includes(unknownScope.status));
    // UNAUTHENTICATED => 401.
    const noAuth = await api()
      .post(pathFor(f.scope.id))
      .send(validBody(f));
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.error.code, 'AUTHENTICATION_REQUIRED');
    // Realm firewall: an authenticated user WITHOUT client access (no
    // building assignment / no role) => 403.
    const outsiderToken = await createPlainSession();
    const outsider = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send(validBody(f));
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.error.code, 'BUILDING_ACCESS_DENIED');
    // All rejections leave zero results and challenge PENDING
    // (per challenge, isolation-safe across suite siblings).
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [f.challenge.id]);
    assert.equal(count.rows[0].n, 0);
    const ch = await q(
      `SELECT status FROM handyman_arrival_challenges WHERE id = $1`,
      [f.challenge.id]);
    assert.equal(ch.rows[0].status, 'PENDING');
  });

  it('8: replay over HTTP returns the same single result', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const first = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f));
    assert.equal(first.status, 200);
    const again = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(again.body.data.status, first.body.data.status);
    assert.equal(again.body.data.primaryReason,
      first.body.data.primaryReason);
    assert.equal(again.body.data.evaluatedAt,
      first.body.data.evaluatedAt);
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [f.challenge.id]);
    assert.equal(count.rows[0].n, 1,
      'replay never creates a second result');
  });

  it('9: OpenAPI path/request/response/status/reason parity with route', async (t) => {
    if (!requireDatabase(t)) return;
    const yaml = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const path = yaml.paths[
      '/handyman/execution-scopes/{executionScopeId}/arrival-verification'
    ];
    assert.ok(path, 'path must exist in OpenAPI');
    const postOp = path.post;
    assert.ok(postOp, 'POST op must exist');
    assert.equal(postOp.requestBody.content['application/json'].schema
      .$ref, '#/components/schemas/HandymanArrivalVerificationRequest');
    assert.equal(postOp.responses['200'].content['application/json']
      .schema.$ref,
      '#/components/schemas/HandymanArrivalVerificationResult');
    const reqSchema = yaml.components.schemas
      .HandymanArrivalVerificationRequest;
    assert.deepEqual(reqSchema.required.sort(), ['challengeToken', 'qrOpaqueCode']);
    assert.deepEqual(Object.keys(reqSchema.properties).sort(), [
      'challengeToken', 'deviceLocation', 'qrOpaqueCode',
    ], 'bounded request keys only');
    assert.deepEqual(Object.keys(reqSchema.properties.deviceLocation
      .properties).sort(),
      ['accuracyMeters', 'capturedAt', 'latitude', 'longitude']);
    const resSchema = yaml.components.schemas
      .HandymanArrivalVerificationResult;
    assert.deepEqual(resSchema.properties.status.enum.sort(), [
      'EXPIRED', 'FAILED', 'MANUAL_REVIEW_REQUIRED', 'VERIFIED',
    ]);
    assert.deepEqual(resSchema.properties.primaryReason.enum.sort(), [
      'ACTOR_ASSIGNMENT_INVALID', 'ALL_POSITIVE_EVIDENCE',
      'CHALLENGE_EXPIRED', 'GEOFENCE_OUTSIDE', 'GEOFENCE_UNAVAILABLE',
      'LOW_ACCURACY', 'NO_GEOSPATIAL_POLICY', 'QR_INACTIVE',
      'QR_MISMATCH', 'QR_UNKNOWN',
    ]);
    assert.ok(resSchema.properties.qrSignal.enum.includes('MATCH'));
    // Error responses documented boundedly.
    for (const code of ['400', '401', '403', '404', '409']) {
      assert.ok(postOp.responses[code], `response ${code} must exist`);
    }
    // Path-level structural enforcement: descriptions may LEGALLY
    // document negatives; schema/property/operation surfaces must not.
    const structural = JSON.stringify({
      tags: postOp.tags,
      operationId: postOp.operationId,
      parameters: postOp.parameters,
      responses: Object.keys(postOp.responses),
      reqProps: Object.keys(reqSchema.properties),
      resProps: Object.keys(resSchema.properties),
    });
    for (const forbidden of ['api.co.id', 'reverse-geocode', 'work-order',
      'attendance', 'bast', 'work-session', 'check-in']) {
      assert.equal(structural.toLowerCase().includes(forbidden), false,
        `forbidden surface indexed: ${forbidden}`);
    }
  });

  it('10: route carries zero duplicated decision/API.CO.ID/work-session/FM code', async (t) => {
    if (!requireDatabase(t)) return;
    // Zero imports of evaluators/geospatial/challenges/locationproviders.
    const controller = readFileSync(
      'src/modules/handyman-arrival-verification-api/handyman-arrival-verification-api.controller.ts', 'utf8');
    const routes = readFileSync(
      'src/modules/handyman-arrival-verification-api/handyman-arrival-verification-api.routes.ts', 'utf8');
    for (const forbidden of [
      'handyman-arrival-challenges', 'handyman-arrival-locations',
      'handyman-geospatial-policies', 'location-enrichment',
      'handyman-arrival-results/handyman-arrival-result.service',
    ]) {
      assert.equal(controller.includes(`from '../${forbidden}'`), false,
        `controller must not import ${forbidden}`);
    }
    assert.equal(controller.includes('evaluateHandymanArrivalVerification'),
      true, 'controller delegates to the 04B evaluator only');
    const stripComments = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const controllerCode = stripComments(controller).toLowerCase();
    const routesCode = stripComments(routes).toLowerCase();
    for (const token of ['reverse-geocode', 'api.co.id', 'work-order',
      'bast', 'attendance', 'work-session']) {
      assert.equal(controllerCode.includes(token), false,
        `zero ${token} in controller code`);
      assert.equal(routesCode.includes(token), false,
        `zero ${token} in routes code`);
    }
    // Response shape bounded: module's ArrivalVerificationResponse
    // exposes EXACTLY the OpenAPI fields (parity over behavior t1).
    const f = await authorityFixture();
    const res = await api()
      .post(pathFor(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send(validBody(f));
    assert.deepEqual(Object.keys(res.body.data).sort(), [
      'challengeId', 'distanceMeters', 'evaluatedAt',
      'executionScopeId', 'geofenceSignal', 'id', 'primaryReason',
      'qrSignal', 'status',
    ]);
    // Forbidden tables stay empty.
    for (const table of [
      'handyman_scheduling_readiness',
      'handyman_unit_access_readiness',
      'work_orders', 'bast_documents',
      'handyman_service_outcomes', 'attendance_records',
    ]) {
      const r = await q(`SELECT count(*)::int AS n FROM ${table}`)
        .catch(() => ({ rows: [{ n: 0 }] }));
      assert.equal(r.rows[0].n, 0, `${table} must stay empty`);
    }
  });
});
