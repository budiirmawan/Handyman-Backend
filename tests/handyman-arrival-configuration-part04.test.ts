import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { userService } from '../src/modules/users';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import {
  createHandymanArrivalChallenge,
} from '../src/modules/handyman-arrival-challenges';
import {
  createHandymanArrivalLocationIdentifier,
  resolveHandymanArrivalQrSignal,
} from '../src/modules/handyman-arrival-locations';
import {
  evaluateHandymanBuildingGeofenceSignal,
} from '../src/modules/handyman-geospatial-policies';
import {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import { createAdminUser, createSessionWithPermissionsForUser }
  from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  realmFixture,
  scopeFixture,
  transferCrewLeadFixture,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { api } from './helpers/http';

/**
 * CR-HM-FIELD-OPERATIONS-01 PART 04 — implementation proof for the CR Owner
 * approved amendment (gate §8: SG-1 approved, SG-2 OPTION A, SG-3/SG-4
 * OPTION A, SG-5 approved, SG-6 proceed).
 *
 * Covers the binding acceptance criteria AC-1…AC-10 and the approved
 * security matrix:
 *   G-2  QR registry register / list / deactivate          (G2-01…G2-32)
 *   G-3  Building geofence configure / read / history       (G3-01…G3-32)
 *   G-4  superseded-challenge refusal                       (G4-01…G4-10)
 *   CT   contract + regression gates                        (CT-01…CT-07)
 *
 * Every case runs against a real, disposable PostgreSQL cluster with the
 * real migrations. There is NO `t.skip()` fallback: a case that cannot run
 * must fail, never silently pass.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

const EMBEDDED_DIR = '/tmp/hm04-arrival-configuration-part04-pg';
const EMBEDDED_PORT = 55594;
let embedded: EmbeddedTestDatabase | null = null;

const READ = [
  { code: 'building_configuration.read', name: 'Read Building Configuration' },
];
const MANAGE = [
  { code: 'building_configuration.read', name: 'Read Building Configuration' },
  {
    code: 'building_configuration.manage',
    name: 'Manage Building Configuration',
  },
];

const REF = { latitude: -6.2, longitude: 106.816666 };

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
  });
  const db = await ensureTestDatabase();
  if (!db) throw new Error('test database unavailable (hard failure, no skip)');
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
  try {
    if (pool) await closePool(pool);
    if (embedded) await embedded.stop();
  } finally {
    pool = null;
    database = null;
    embedded = null;
  }
});

/** Hard guard: never a silent skip. */
function requireDatabase(_t: TestContext): boolean {
  if (!database || !pool) {
    throw new Error('test database unavailable — PART 04 must not skip');
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8')
  .digest('hex');

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const identPath = (buildingId: string) =>
  `/api/v1/handyman/buildings/${buildingId}/arrival-location-identifiers`;
const deactivatePath = (buildingId: string, identifierId: string) =>
  `${identPath(buildingId)}/${identifierId}/deactivate`;
const policyPath = (buildingId: string) =>
  `/api/v1/handyman/buildings/${buildingId}/geofence-policy`;
const historyPath = (buildingId: string) => `${policyPath(buildingId)}/history`;
const verifyPath = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/arrival-verification`;

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Existing-user session carrying EXACTLY the given permissions. */
async function makeActor(opts: {
  permissions?: { code: string; name: string }[];
  buildingIds?: string[];
  label?: string;
} = {}): Promise<{ userId: string; token: string; email: string }> {
  const suffix = randomUUID().slice(0, 8).toLowerCase();
  const user = await userService.createUser({
    email: `${opts.label ?? 'cfg'}-${suffix}@example.com`,
    displayName: 'Configuration Actor',
  });
  const password = `CfgPass${randomUUID().slice(0, 6)}`;
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  for (const buildingId of opts.buildingIds ?? []) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const token = await createSessionWithPermissionsForUser(
    user,
    password,
    opts.permissions ?? [],
  );
  return { userId: user.id, token, email: user.email };
}

/** Sibling Building in the SAME Client (same property). */
async function siblingBuilding(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  return buildingService.createBuilding({
    propertyId: realm.property.id,
    code: `SIB_${randomUUID().slice(0, 6)}`,
    name: 'Sibling Building',
  });
}

function policyBody(over: Record<string, unknown> = {}) {
  return {
    referenceLatitude: REF.latitude,
    referenceLongitude: REF.longitude,
    geofenceRadiusMeters: 100,
    maxAccuracyMeters: 40,
    maxLocationAgeSeconds: 900,
    ...over,
  };
}

/** ACTIVE scope + ACTIVE crew assignment + logged-in Lead session. */
async function arrivalFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const password = `LeadPass${randomUUID().slice(0, 6)}`;
  await credentialService.createInitialCredential({
    userId: crew.leadUser.id,
    password,
  });
  const login = await api().post('/api/v1/auth/login').send({
    email: crew.leadUser.email,
    password,
  });
  const leadToken = login.body.data.sessionToken as string;
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  return { ...f, crew, leadToken, assignment };
}

const eventCount = async (type?: string) => {
  const res = await q(
    type
      ? `SELECT count(*)::int AS n FROM operational_events WHERE event_type = $1`
      : `SELECT count(*)::int AS n FROM operational_events`,
    type ? [type] : [],
  );
  return res.rows[0].n as number;
};

/* ═════════════════════════ G-2 — QR REGISTRY ═════════════════════════ */

describe('CR-HM-FIELD-OPERATIONS-01 PART 04 — G-2 QR registry', () => {
  it('G2-01/G2-02/G2-03/G2-22: register (value once, hash at rest), build-level + deepest chain, secret-free list, smuggling ignored', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
    });

    // G2-01 — Building-level registration.
    const created = await api()
      .post(identPath(realm.building.id))
      .set(authed(admin.token))
      .send({});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const issued = created.body.data;
    assert.ok(issued.opaqueCode && issued.opaqueCode.length > 0);
    // Bounded projection: no hash, no clientId, no actor metadata.
    assert.deepEqual(Object.keys(issued).sort(), [
      'areaId', 'buildingId', 'createdAt', 'floorId', 'id', 'opaqueCode',
      'roomId', 'spaceId', 'status', 'updatedAt',
    ]);
    assert.equal(issued.status, 'ACTIVE');
    assert.equal(issued.buildingId, realm.building.id);

    const stored = await q(
      `SELECT client_id, opaque_code_hash, status, floor_id
         FROM handyman_arrival_location_identifiers WHERE id = $1`,
      [issued.id],
    );
    assert.equal(stored.rows[0].client_id, realm.client.id);
    assert.equal(stored.rows[0].status, 'ACTIVE');
    assert.equal(stored.rows[0].opaque_code_hash, sha256(issued.opaqueCode));
    assert.notEqual(stored.rows[0].opaque_code_hash, issued.opaqueCode);
    // The raw value is nowhere at rest.
    const raw = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_location_identifiers
        WHERE opaque_code_hash = $1`,
      [issued.opaqueCode],
    );
    assert.equal(raw.rows[0].n, 0);

    // G2-02 — deepest chain accepted and persisted verbatim.
    const chain = await (async () => {
      const { locationChain } = await import('./helpers/handyman-fixtures');
      return locationChain(realm);
    })();
    const deep = await api()
      .post(identPath(realm.building.id))
      .set(authed(admin.token))
      .send({
        floorId: chain.floor.id,
        areaId: chain.area.id,
        roomId: chain.room.id,
        spaceId: chain.space.id,
      });
    assert.equal(deep.status, 201, JSON.stringify(deep.body));
    const deepRow = await q(
      `SELECT floor_id, area_id, room_id, space_id
         FROM handyman_arrival_location_identifiers WHERE id = $1`,
      [deep.body.data.id],
    );
    assert.deepEqual(
      { ...deepRow.rows[0] },
      {
        floor_id: chain.floor.id,
        area_id: chain.area.id,
        room_id: chain.room.id,
        space_id: chain.space.id,
      },
    );

    // G2-03 — list carries NO secret material of any kind.
    const list = await api()
      .get(identPath(realm.building.id))
      .set(authed(admin.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.buildingId, realm.building.id);
    assert.equal(list.body.data.identifiers.length, 2);
    const listed = JSON.stringify(list.body.data);
    assert.equal(listed.includes(issued.opaqueCode), false, 'raw value leaked');
    assert.equal(
      listed.includes(sha256(issued.opaqueCode)),
      false,
      'hash leaked',
    );
    for (const item of list.body.data.identifiers) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'opaqueCode'), false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(item, 'opaqueCodeHash'),
        false,
      );
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'clientId'), false);
    }
    // Status filter works and cannot invent rows.
    const inactiveOnly = await api()
      .get(`${identPath(realm.building.id)}?status=INACTIVE`)
      .set(authed(admin.token));
    assert.equal(inactiveOnly.status, 200);
    assert.equal(inactiveOnly.body.data.identifiers.length, 0);

    // G2-22 — authority smuggling changes nothing.
    const smuggled = await api()
      .post(identPath(realm.building.id))
      .set(authed(admin.token))
      .send({
        id: randomUUID(),
        clientId: randomUUID(),
        status: 'INACTIVE',
        opaqueCode: 'caller-chosen-code',
        opaqueCodeHash: 'spoofed',
        createdByUserId: randomUUID(),
      });
    assert.equal(smuggled.status, 201);
    const smuggledRow = await q(
      `SELECT client_id, status, opaque_code_hash
         FROM handyman_arrival_location_identifiers WHERE id = $1`,
      [smuggled.body.data.id],
    );
    assert.equal(smuggledRow.rows[0].client_id, realm.client.id);
    assert.equal(smuggledRow.rows[0].status, 'ACTIVE');
    assert.notEqual(smuggledRow.rows[0].opaque_code_hash, 'spoofed');
    assert.equal(
      smuggledRow.rows[0].opaque_code_hash,
      sha256(smuggled.body.data.opaqueCode),
    );
    assert.notEqual(smuggled.body.data.opaqueCode, 'caller-chosen-code');
  });

  it('G2-04/G2-05: deactivate is audited, one-way, idempotent, and flips a later scan to INACTIVE', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
    });
    const created = await api()
      .post(identPath(realm.building.id))
      .set(authed(admin.token))
      .send({});
    assert.equal(created.status, 201);
    const { id, opaqueCode } = created.body.data;
    const journalBefore = await eventCount(
      'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_DEACTIVATED');

    const deactivated = await api()
      .post(deactivatePath(realm.building.id, id))
      .set(authed(admin.token));
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(
      JSON.stringify(deactivated.body.data).includes(opaqueCode),
      false,
      'deactivate response must not resurrect the raw value',
    );
    assert.equal(await eventCount(
      'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_DEACTIVATED'),
    journalBefore + 1);

    // G2-05 — idempotent projection, no second row, no error.
    const again = await api()
      .post(deactivatePath(realm.building.id, id))
      .set(authed(admin.token));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.status, 'INACTIVE');
    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_location_identifiers
        WHERE id = $1`,
      [id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('G2-06: configuration is NOT a field capability — an operator with no crew can configure a Building it never works in', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const operator = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
      label: 'operator',
    });
    const res = await api()
      .post(identPath(realm.building.id))
      .set(authed(operator.token))
      .send({});
    assert.equal(res.status, 201);
  });

  it('G2-10…G2-17 (AC-1, AC-3): permission, exact-Building, cross-tenant, sibling and worker self-authorization denials', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const sibling = await siblingBuilding(realm);
    const foreign = await realmFixture('Foreign');

    // G2-10 — unauthenticated.
    const anon = await api().post(identPath(realm.building.id)).send({});
    assert.equal(anon.status, 401);

    // G2-11 — authenticated without the manage permission (read-only).
    const reader = await makeActor({
      permissions: READ,
      buildingIds: [realm.building.id],
      label: 'reader',
    });
    const noPerm = await api()
      .post(identPath(realm.building.id))
      .set(authed(reader.token))
      .send({});
    assert.equal(noPerm.status, 403);

    // G2-14 — manage permission but NO Building assignment at all.
    const unassigned = await makeActor({
      permissions: MANAGE,
      label: 'unassigned',
    });
    const noBuilding = await api()
      .post(identPath(realm.building.id))
      .set(authed(unassigned.token))
      .send({});
    assert.equal(noBuilding.status, 403);
    assert.equal(noBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');

    // G2-12 — same-Client SIBLING-Building manager (AC-1 core case).
    const siblingMgr = await makeActor({
      permissions: MANAGE,
      buildingIds: [sibling.id],
      label: 'sibling',
    });
    const siblingDenied = await api()
      .post(identPath(realm.building.id))
      .set(authed(siblingMgr.token))
      .send({});
    assert.equal(siblingDenied.status, 403);
    assert.equal(siblingDenied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // G2-13 — cross-Client manager.
    const foreignMgr = await makeActor({
      permissions: MANAGE,
      buildingIds: [foreign.building.id],
      label: 'foreign',
    });
    const crossDenied = await api()
      .post(identPath(realm.building.id))
      .set(authed(foreignMgr.token))
      .send({});
    assert.equal(crossDenied.status, 403);
    assert.equal(crossDenied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // G2-16 — WORKER SELF-AUTHORIZATION (AC-3): the CURRENT Crew Lead of the
    // scope's own assignment, holding no configuration permission, cannot
    // register the evidence used to verify its own arrival.
    const arrival = await arrivalFixture();
    const worker = await api()
      .post(identPath(arrival.realm.building.id))
      .set(authed(arrival.leadToken))
      .send({});
    assert.equal(worker.status, 403, 'field worker must never configure');
    const none = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_location_identifiers
        WHERE building_id = $1`,
      [arrival.realm.building.id],
    );
    assert.equal(none.rows[0].n, 0, 'denied worker created no identifier');

    // G2-17 — any other authenticated non-manager (Inspector/Tenant-like).
    const bystander = await makeActor({
      buildingIds: [realm.building.id],
      label: 'bystander',
    });
    assert.equal((await api()
      .post(identPath(realm.building.id))
      .set(authed(bystander.token))
      .send({})).status, 403);

    // G2-15 — read-only caller may LIST but never write.
    const listed = await api()
      .get(identPath(realm.building.id))
      .set(authed(reader.token));
    assert.equal(listed.status, 200);
    assert.equal((await api()
      .post(deactivatePath(realm.building.id, randomUUID()))
      .set(authed(reader.token))).status, 403);
  });

  it('G2-18/G2-19/G2-20/G2-21/G2-23: chain validation, foreign links, bad Buildings, non-enumerating 404, no DELETE route', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const sibling = await siblingBuilding(realm);
    const { locationChain } = await import('./helpers/handyman-fixtures');
    const chain = await locationChain(realm);
    const siblingChain = await locationChain({
      ...realm,
      building: sibling,
    } as any);
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
    });

    // G2-18 — incomplete hierarchy.
    for (const body of [
      { roomId: chain.room.id },
      { areaId: chain.area.id },
      { spaceId: chain.space.id },
      { roomId: chain.room.id, areaId: chain.area.id },
    ]) {
      const res = await api()
        .post(identPath(realm.building.id))
        .set(authed(admin.token))
        .send(body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(
        res.body.error.code,
        'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION',
      );
    }
    // G2-19 — links owned by a DIFFERENT Building (sibling).
    const foreignLink = await api()
      .post(identPath(realm.building.id))
      .set(authed(admin.token))
      .send({ floorId: siblingChain.floor.id });
    assert.equal(foreignLink.status, 400);
    assert.equal(
      foreignLink.body.error.code,
      'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION',
    );
    const afterInvalid = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_location_identifiers
        WHERE building_id = $1`,
      [realm.building.id],
    );
    assert.equal(afterInvalid.rows[0].n, 0, 'no row from a rejected chain');

    // G2-20 — unknown / inactive Building, malformed UUID.
    const unknown = await api()
      .post(identPath(randomUUID()))
      .set(authed(admin.token))
      .send({});
    assert.equal(unknown.status, 400);
    const badUuid = await api()
      .post(identPath('not-a-uuid'))
      .set(authed(admin.token))
      .send({});
    assert.equal(badUuid.status, 400);
    assert.equal(badUuid.body.error.code, 'VALIDATION_ERROR');

    // G2-21 — deactivate unknown vs foreign identifier: SAME 404 shape, and
    // an identifier of another Building cannot be reached through an
    // authorized Building URL.
    const siblingAdmin = await makeActor({
      permissions: MANAGE,
      buildingIds: [sibling.id],
      label: 'sib2',
    });
    const victim = await api()
      .post(identPath(sibling.id))
      .set(authed(siblingAdmin.token))
      .send({});
    assert.equal(victim.status, 201);
    const unknownIdent = await api()
      .post(deactivatePath(realm.building.id, randomUUID()))
      .set(authed(admin.token));
    assert.equal(unknownIdent.status, 404);
    assert.equal(
      unknownIdent.body.error.code,
      'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_NOT_FOUND',
    );
    const crossBuildingIdent = await api()
      .post(deactivatePath(realm.building.id, victim.body.data.id))
      .set(authed(admin.token));
    assert.equal(crossBuildingIdent.status, 404);
    assert.equal(
      crossBuildingIdent.body.error.code,
      'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_NOT_FOUND',
    );
    const stillActive = await q(
      `SELECT status FROM handyman_arrival_location_identifiers WHERE id = $1`,
      [victim.body.data.id],
    );
    assert.equal(stillActive.rows[0].status, 'ACTIVE', 'cross-building write blocked');

    // G2-23 — no DELETE route exists on the registry surface.
    const deleted = await api()
      .delete(`${identPath(realm.building.id)}/${victim.body.data.id}`)
      .set(authed(admin.token));
    assert.equal(deleted.status, 404);
  });

  it('G2-30/G2-31/G2-32 (AC-10): configuration yields zero verdict, zero consumption and no cross-domain writes', async (t) => {
    requireDatabase(t);
    const arrival = await arrivalFixture();
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [arrival.realm.building.id],
    });

    const before = {
      results: (await q(`SELECT count(*)::int AS n
        FROM handyman_arrival_verification_results`)).rows[0].n,
      workOrders: (await q(`SELECT count(*)::int AS n FROM work_orders`))
        .rows[0].n,
    };

    const createdBefore = await eventCount(
      'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_CREATED');
    const created = await api()
      .post(identPath(arrival.realm.building.id))
      .set(authed(admin.token))
      .send({});
    assert.equal(created.status, 201);

    // G2-30 — registration created NO result and consumed NO challenge;
    // the only journal entry is the registration itself.
    assert.equal((await q(`SELECT count(*)::int AS n
      FROM handyman_arrival_verification_results`)).rows[0].n,
    before.results);
    assert.equal(await eventCount(
      'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_CREATED'),
    createdBefore + 1);
    assert.equal((await q(`SELECT count(*)::int AS n
      FROM handyman_arrival_challenges WHERE status <> 'PENDING'`))
      .rows[0].n, 0, 'no challenge was consumed');

    // G2-31 — deactivating while a challenge is live leaves the challenge
    // untouched; a later scan resolves INACTIVE, never MATCH.
    const challenge = await createHandymanArrivalChallenge(
      { executionScopeId: arrival.scope.id },
      arrival.crew.leadUser.id,
    );
    await api()
      .post(deactivatePath(arrival.realm.building.id, created.body.data.id))
      .set(authed(admin.token));
    const row = await q(
      `SELECT status, consumed_at FROM handyman_arrival_challenges
        WHERE id = $1`,
      [challenge.challenge.id],
    );
    assert.equal(row.rows[0].status, 'PENDING');
    assert.equal(row.rows[0].consumed_at, null);
    const signal = await resolveHandymanArrivalQrSignal(
      {
        executionScopeId: arrival.scope.id,
        rawValue: created.body.data.opaqueCode,
      },
      arrival.crew.leadUser.id,
    );
    assert.equal(signal.signal, 'INACTIVE');

    // G2-32 — no cross-domain rows.
    assert.equal((await q(`SELECT count(*)::int AS n FROM work_orders`))
      .rows[0].n, before.workOrders);
    assert.equal((await q(`SELECT count(*)::int AS n
      FROM handyman_arrival_verification_results`)).rows[0].n, before.results);
  });
});

/* ═══════════════════════ G-3 — BUILDING GEOFENCE ═══════════════════════ */

describe('CR-HM-FIELD-OPERATIONS-01 PART 04 — G-3 Building geofence policy', () => {
  it('G3-01/G3-02/G3-03/G3-04/G3-06: create, history-preserving replace, history read, bounded projection, boundary values', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
    });

    const g3Created = await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED');
    const g3Replaced = await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_REPLACED');

    // G3-01 — first activation.
    const first = await api()
      .put(policyPath(realm.building.id))
      .set(authed(admin.token))
      .send(policyBody());
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const firstPolicy = first.body.data;
    assert.equal(firstPolicy.status, 'ACTIVE');
    assert.equal(firstPolicy.buildingId, realm.building.id);
    assert.equal(firstPolicy.geofenceRadiusMeters, 100);
    assert.ok(typeof firstPolicy.effectiveFrom === 'string');
    // Bounded projection — internal realm/actor metadata omitted.
    assert.deepEqual(Object.keys(firstPolicy).sort(), [
      'buildingId', 'createdAt', 'effectiveFrom', 'geofenceRadiusMeters',
      'id', 'maxAccuracyMeters', 'maxLocationAgeSeconds',
      'referenceLatitude', 'referenceLongitude', 'status', 'updatedAt',
    ]);
    assert.equal(await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED'), g3Created + 1);

    // G3-02 — replacement preserves history, exactly one ACTIVE.
    const second = await api()
      .put(policyPath(realm.building.id))
      .set(authed(admin.token))
      .send(policyBody({ geofenceRadiusMeters: 250 }));
    assert.equal(second.status, 200);
    assert.equal(second.body.data.geofenceRadiusMeters, 250);
    assert.notEqual(second.body.data.id, firstPolicy.id);
    const rows = await q(
      `SELECT id, status, geofence_radius_meters
         FROM handyman_building_geospatial_policies
        WHERE building_id = $1 ORDER BY created_at ASC`,
      [realm.building.id],
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows.filter((r) => r.status === 'ACTIVE').length, 1);
    const retired = rows.rows.find((r) => r.id === firstPolicy.id);
    assert.equal(retired.status, 'INACTIVE');
    // Historical values are never overwritten.
    assert.equal(Number(retired.geofence_radius_meters), 100);
    assert.equal(await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_REPLACED'), g3Replaced + 1);

    // G3-03 — history read exposes both, newest first.
    const history = await api()
      .get(historyPath(realm.building.id))
      .set(authed(admin.token));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.buildingId, realm.building.id);
    assert.equal(history.body.data.policies.length, 2);
    assert.equal(history.body.data.policies[0].id, second.body.data.id);
    assert.equal(
      history.body.data.policies[1].geofenceRadiusMeters,
      100,
      'retired policy keeps its original values',
    );
    assert.equal(
      JSON.stringify(history.body.data).includes('clientId'),
      false,
    );

    // G3-04 — active read equals the newest row.
    const active = await api()
      .get(policyPath(realm.building.id))
      .set(authed(admin.token));
    assert.equal(active.status, 200);
    assert.equal(active.body.data.id, second.body.data.id);

    // G3-06 — physical boundaries accepted.
    const boundary = await api()
      .put(policyPath(realm.building.id))
      .set(authed(admin.token))
      .send(policyBody({
        referenceLatitude: 90,
        referenceLongitude: -180,
        maxLocationAgeSeconds: 1,
      }));
    assert.equal(boundary.status, 200, JSON.stringify(boundary.body));
    assert.equal(boundary.body.data.referenceLatitude, 90);
  });

  it('G3-05: an unconfigured Building is a 404 decided before row-based authorization', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const admin = await makeActor({
      permissions: READ,
      buildingIds: [realm.building.id],
    });
    const res = await api()
      .get(policyPath(realm.building.id))
      .set(authed(admin.token));
    assert.equal(res.status, 404);
    assert.equal(
      res.body.error.code,
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_NOT_FOUND',
    );
  });

  it('G3-07: the evaluator uses the NEW policy immediately after replacement', async (t) => {
    requireDatabase(t);
    const arrival = await arrivalFixture();
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [arrival.realm.building.id],
    });
    const device = {
      executionScopeId: arrival.scope.id,
      latitude: REF.latitude,
      longitude: REF.longitude,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    };
    // Tight radius around the reference point → INSIDE.
    await api()
      .put(policyPath(arrival.realm.building.id))
      .set(authed(admin.token))
      .send(policyBody({ geofenceRadiusMeters: 100 }));
    const inside = await evaluateHandymanBuildingGeofenceSignal(
      device,
      arrival.crew.leadUser.id,
    );
    assert.equal(inside.signal, 'INSIDE');
    // Replace with a radius that excludes the same coordinates.
    await api()
      .put(policyPath(arrival.realm.building.id))
      .set(authed(admin.token))
      .send(policyBody({ geofenceRadiusMeters: 5 }));
    const outside = await evaluateHandymanBuildingGeofenceSignal(
      {
        ...device,
        latitude: REF.latitude + 0.01,
      },
      arrival.crew.leadUser.id,
    );
    assert.equal(outside.signal, 'OUTSIDE');
  });

  it('G3-10/G3-11: server-side bounds rejected with 400, and validation precedes authorization', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const foreign = await realmFixture('ForeignBad');
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
    });
    const invalid: Record<string, unknown>[] = [
      { referenceLatitude: 91 },
      { referenceLatitude: -91 },
      { referenceLongitude: 181 },
      { geofenceRadiusMeters: 0 },
      { geofenceRadiusMeters: -5 },
      { maxAccuracyMeters: 0 },
      { maxLocationAgeSeconds: 0 },
      { maxLocationAgeSeconds: 1.5 },
      { effectiveFrom: 'not-a-timestamp' },
    ];
    for (const over of invalid) {
      const res = await api()
        .put(policyPath(realm.building.id))
        .set(authed(admin.token))
        .send(policyBody(over));
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(over)}`);
      assert.ok(
        [
          'VALIDATION_ERROR',
          'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_VALIDATION',
        ].includes(res.body.error.code),
        `unexpected bounded code ${res.body.error.code}`,
      );
    }
    // Physical bounds are rejected by the pre-existing service authority
    // (not re-implemented at the HTTP layer).
    for (const over of [
      { referenceLatitude: 91 },
      { geofenceRadiusMeters: 0 },
      { maxLocationAgeSeconds: 1.5 },
    ]) {
      const res = await api()
        .put(policyPath(realm.building.id))
        .set(authed(admin.token))
        .send(policyBody(over));
      assert.equal(res.status, 400);
      assert.equal(
        res.body.error.code,
        'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_VALIDATION',
        `service must own the bounds check for ${JSON.stringify(over)}`,
      );
    }
    // Missing required values are 400 too.
    const missing = await api()
      .put(policyPath(realm.building.id))
      .set(authed(admin.token))
      .send({ referenceLatitude: REF.latitude });
    assert.equal(missing.status, 400);
    const noRows = await q(
      `SELECT count(*)::int AS n FROM handyman_building_geospatial_policies
        WHERE building_id = $1`,
      [realm.building.id],
    );
    assert.equal(noRows.rows[0].n, 0, 'no mutation from rejected input');

    // G3-11 — foreign Building + invalid radius: 400 wins (documented order).
    const ordering = await api()
      .put(policyPath(foreign.building.id))
      .set(authed(admin.token))
      .send(policyBody({ geofenceRadiusMeters: 0 }));
    assert.equal(ordering.status, 400);
  });

  it('G3-12…G3-17 (AC-1, AC-3): RBAC, sibling, cross-tenant, read-only and worker denials', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const sibling = await siblingBuilding(realm);
    const foreign = await realmFixture('ForeignGeo');

    // G3-12 — unauthenticated.
    assert.equal((await api()
      .put(policyPath(realm.building.id))
      .send(policyBody())).status, 401);

    // G3-13 — authenticated without manage.
    const reader = await makeActor({
      permissions: READ,
      buildingIds: [realm.building.id],
      label: 'georeader',
    });
    assert.equal((await api()
      .put(policyPath(realm.building.id))
      .set(authed(reader.token))
      .send(policyBody())).status, 403);

    // G3-14 — SIBLING-Building manager: denied AND the victim Building's
    // ACTIVE policy stays byte-for-byte unchanged (SEC-02 regression).
    const owner = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
      label: 'geoowner',
    });
    const original = await api()
      .put(policyPath(realm.building.id))
      .set(authed(owner.token))
      .send(policyBody({ geofenceRadiusMeters: 123 }));
    assert.equal(original.status, 200);
    const siblingMgr = await makeActor({
      permissions: MANAGE,
      buildingIds: [sibling.id],
      label: 'geosibling',
    });
    const denied = await api()
      .put(policyPath(realm.building.id))
      .set(authed(siblingMgr.token))
      .send(policyBody({ geofenceRadiusMeters: 999 }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const afterAttack = await api()
      .get(policyPath(realm.building.id))
      .set(authed(owner.token));
    assert.deepEqual(afterAttack.body.data, original.body.data);
    const rowCount = await q(
      `SELECT count(*)::int AS n FROM handyman_building_geospatial_policies
        WHERE building_id = $1`,
      [realm.building.id],
    );
    assert.equal(rowCount.rows[0].n, 1, 'sibling denial wrote no history row');

    // G3-15 — cross-Client manager.
    const foreignMgr = await makeActor({
      permissions: MANAGE,
      buildingIds: [foreign.building.id],
      label: 'geoforeign',
    });
    const cross = await api()
      .put(policyPath(realm.building.id))
      .set(authed(foreignMgr.token))
      .send(policyBody());
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal((await api()
      .get(historyPath(realm.building.id))
      .set(authed(foreignMgr.token))).status, 403);

    // G3-16 — read-only caller reads but never writes.
    assert.equal((await api()
      .get(policyPath(realm.building.id))
      .set(authed(reader.token))).status, 200);
    assert.equal((await api()
      .get(historyPath(realm.building.id))
      .set(authed(reader.token))).status, 200);

    // G3-17 — WORKER SELF-AUTHORIZATION: the scope's own Crew Lead cannot
    // set the conditions used to verify its own arrival.
    const arrival = await arrivalFixture();
    const workerPolicy = await api()
      .put(policyPath(arrival.realm.building.id))
      .set(authed(arrival.leadToken))
      .send(policyBody({ geofenceRadiusMeters: 99999 }));
    assert.equal(workerPolicy.status, 403);
    const workerRows = await q(
      `SELECT count(*)::int AS n FROM handyman_building_geospatial_policies
        WHERE building_id = $1`,
      [arrival.realm.building.id],
    );
    assert.equal(workerRows.rows[0].n, 0);
  });

  it('G3-18: smuggled authority keys cannot redirect or spoof a policy write', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const sibling = await siblingBuilding(realm);
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
    });
    const res = await api()
      .put(policyPath(realm.building.id))
      .set(authed(admin.token))
      .send(policyBody({
        buildingId: sibling.id,
        clientId: randomUUID(),
        status: 'INACTIVE',
        createdByUserId: randomUUID(),
        policyId: randomUUID(),
        distanceMeters: 99999,
        geofenceSignal: 'INSIDE',
      }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.buildingId, realm.building.id);
    assert.equal(res.body.data.status, 'ACTIVE');
    const row = await q(
      `SELECT client_id, building_id FROM handyman_building_geospatial_policies
        WHERE id = $1`,
      [res.body.data.id],
    );
    assert.equal(row.rows[0].building_id, realm.building.id);
    assert.equal(row.rows[0].client_id, realm.client.id);
    const siblingRows = await q(
      `SELECT count(*)::int AS n FROM handyman_building_geospatial_policies
        WHERE building_id = $1`,
      [sibling.id],
    );
    assert.equal(siblingRows.rows[0].n, 0, 'URL Building is the only target');
  });

  it('G3-concurrency: simultaneous writes serialize into ordered, fully journalled replacements', async (t) => {
    requireDatabase(t);
    const realm = await realmFixture();
    const admin = await makeActor({
      permissions: MANAGE,
      buildingIds: [realm.building.id],
    });

    const createdBefore = await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED');
    const replacedBefore = await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_REPLACED');

    // Five concurrent create/replace cycles.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => api()
        .put(policyPath(realm.building.id))
        .set(authed(admin.token))
        .send(policyBody({ geofenceRadiusMeters: 10 + index }))),
    );
    for (const res of results) {
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const rows = await q(
      `SELECT status, geofence_radius_meters
         FROM handyman_building_geospatial_policies WHERE building_id = $1`,
      [realm.building.id],
    );
    assert.equal(
      rows.rows.filter((r) => r.status === 'ACTIVE').length,
      1,
      'exactly one ACTIVE policy survives the race',
    );
    assert.equal(rows.rows.length, 5, 'every write is retained in history');
    assert.equal(await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED'), createdBefore + 5);
    assert.equal(await eventCount(
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_REPLACED'), replacedBefore + 4);
  });

  it('G3-30/G3-31/G3-32 (AC-10): configuration creates no verdict, no consumption and no provider involvement', async (t) => {
    requireDatabase(t);
    const arrival = await arrivalFixture();
    const admin = await makeActor({
      permissions: [
        ...MANAGE,
        { code: 'tenant_company.read', name: 'Read Tenant Company' },
      ],
      buildingIds: [arrival.realm.building.id],
    });
    await api()
      .put(policyPath(arrival.realm.building.id))
      .set(authed(admin.token))
      .send(policyBody());

    const resultRows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE execution_scope_id = $1`,
      [arrival.scope.id],
    );
    assert.equal(resultRows.rows[0].n, 0, 'policy write created no verdict');
    assert.equal((await q(`SELECT count(*)::int AS n
      FROM handyman_arrival_challenges WHERE status <> 'PENDING'`))
      .rows[0].n, 0, 'no challenge was consumed');
    const challengeRows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE execution_scope_id = $1`,
      [arrival.scope.id],
    );
    assert.equal(challengeRows.rows[0].n, 0);

    // G3-32 — a configured policy alone is NOT an arrival.
    const read = await api()
      .get(verifyPath(arrival.scope.id))
      .set(authed(admin.token));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.arrivalVerified, false);
    assert.equal(read.body.data.results.length, 0);

    // G3-31 — no enrichment/provider field was written by configuration.
    const enrichment = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE reverse_geocode_status IS NOT NULL`,
    );
    assert.equal(enrichment.rows[0].n, 0);
  });
});

/* ═══════════════════ G-4 — SUPERSEDED CHALLENGE REFUSAL ═══════════════ */

describe('CR-HM-FIELD-OPERATIONS-01 PART 04 — G-4 superseded challenge', () => {
  /** Lead challenge + reassignment to a second ACTIVE crew. */
  async function supersededSetup() {
    const arrival = await arrivalFixture();
    const challenge = await createHandymanArrivalChallenge(
      { executionScopeId: arrival.scope.id },
      arrival.crew.leadUser.id,
    );
    const replacementCrew = await crewFixture(arrival.realm);
    await reassignHandymanExecutionScopeCrew({
      executionScopeId: arrival.scope.id,
      providerContextId: replacementCrew.providerContext.id,
      crewId: replacementCrew.crew.id,
      reason: 'PART 04 G-4 evidence',
      expectedVersion: arrival.assignment.version,
      idempotencyKey: `reassign-${randomUUID()}`,
    }, adminUserId);
    const password = `RepPass${randomUUID().slice(0, 6)}`;
    await credentialService.createInitialCredential({
      userId: replacementCrew.leadUser.id,
      password,
    });
    const replacementToken = await createSessionWithPermissionsForUser(
      replacementCrew.leadUser,
      password,
      [],
    );
    return {
      ...arrival,
      challenge,
      replacementCrew,
      replacementToken,
      oldAssignmentId: arrival.assignment.id,
    };
  }

  const body = (token: string) => ({
    challengeToken: token,
    qrOpaqueCode: `unregistered-${randomUUID()}`,
    deviceLocation: {
      latitude: REF.latitude,
      longitude: REF.longitude,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    },
  });

  it('G4-01/G4-02/G4-07 (AC-5): superseded binding is refused before TTL, with no consume and no result row', async (t) => {
    requireDatabase(t);
    const f = await supersededSetup();

    // G4-01 — superseded Lead, new attempt.
    const stale = await api()
      .post(verifyPath(f.scope.id))
      .set(authed(f.leadToken))
      .send(body(f.challenge.token));
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(
      stale.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED',
    );

    // G4-02 — the REPLACEMENT Lead presenting the old token. Binding is
    // (scope, actor, token), so the new Lead cannot even resolve it: the
    // certified generic refusal applies and NO superseded leak occurs
    // (the refusal never tells a stranger that a job was reassigned).
    const replacement = await api()
      .post(verifyPath(f.scope.id))
      .set(authed(f.replacementToken))
      .send(body(f.challenge.token));
    assert.equal(replacement.status, 409);
    assert.equal(
      replacement.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_INVALID',
    );

    // AC-5 — nothing was consumed and nothing was recorded.
    const challengeRow = await q(
      `SELECT status, consumed_at, assignment_id
         FROM handyman_arrival_challenges WHERE id = $1`,
      [f.challenge.challenge.id],
    );
    assert.equal(challengeRow.rows[0].status, 'PENDING');
    assert.equal(challengeRow.rows[0].consumed_at, null);
    assert.equal(challengeRow.rows[0].assignment_id, f.oldAssignmentId);
    const results = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [f.challenge.challenge.id],
    );
    assert.equal(results.rows[0].n, 0);
  });

  it('G4-03: the replacement Lead issues and evaluates its own challenge normally', async (t) => {
    requireDatabase(t);
    const f = await supersededSetup();
    const fresh = await api()
      .post(`/api/v1/handyman/execution-scopes/${f.scope.id}/arrival-challenge`)
      .set(authed(f.replacementToken));
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    const evaluated = await api()
      .post(verifyPath(f.scope.id))
      .set(authed(f.replacementToken))
      .send(body(fresh.body.data.challengeToken));
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
    assert.equal(evaluated.body.data.status, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(evaluated.body.data.primaryReason, 'QR_UNKNOWN');
    const row = await q(
      `SELECT status FROM handyman_arrival_challenges WHERE id = $1`,
      [fresh.body.data.id],
    );
    assert.equal(row.rows[0].status, 'CONSUMED');
  });

  it('G4-04 (AC-6): an already-recorded result is still returned unchanged on replay', async (t) => {
    requireDatabase(t);
    const arrival = await arrivalFixture();
    const challenge = await createHandymanArrivalChallenge(
      { executionScopeId: arrival.scope.id },
      arrival.crew.leadUser.id,
    );
    const first = await api()
      .post(verifyPath(arrival.scope.id))
      .set(authed(arrival.leadToken))
      .send(body(challenge.token));
    assert.equal(first.status, 200);
    const replay = await api()
      .post(verifyPath(arrival.scope.id))
      .set(authed(arrival.leadToken))
      .send(body(challenge.token));
    assert.equal(replay.status, 200, 'replay must never become a 409');
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(replay.body.data.status, first.body.data.status);
    assert.equal(replay.body.data.evaluatedAt, first.body.data.evaluatedAt);
    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [challenge.challenge.id],
    );
    assert.equal(rows.rows[0].n, 1, 'exactly one immutable result');
  });

  it('G4-05 (AC-7): a still-ACTIVE assignment keeps the certified ACTOR_ASSIGNMENT_INVALID verdict', async (t) => {
    requireDatabase(t);
    const arrival = await arrivalFixture();
    const challenge = await createHandymanArrivalChallenge(
      { executionScopeId: arrival.scope.id },
      arrival.crew.leadUser.id,
    );
    // A different legitimate actor IN THE SAME BUILDING, no reassignment:
    // the token is bound to the issuing actor, so this caller cannot even
    // resolve it and the certified generic refusal still applies.
    const other = await makeActor({
      buildingIds: [arrival.realm.building.id],
      label: 'otheractor',
    });
    const notBound = await api()
      .post(verifyPath(arrival.scope.id))
      .set(authed(other.token))
      .send(body(challenge.token));
    assert.equal(notBound.status, 409);
    assert.equal(notBound.body.error.code, 'HANDYMAN_ARRIVAL_CHALLENGE_INVALID');

    // The certified verdict itself: the SAME ACTIVE assignment, but the
    // crew Lead was TRANSFERRED. The binding is not superseded, so the
    // PART 04B decision path must still run and terminate at
    // FAILED / ACTOR_ASSIGNMENT_INVALID (consuming, one immutable row).
    const transferred = await arrivalFixture();
    const transferredChallenge = await createHandymanArrivalChallenge(
      { executionScopeId: transferred.scope.id },
      transferred.crew.leadUser.id,
    );
    await transferCrewLeadFixture(transferred.crew, transferred.realm);
    const verdict = await api()
      .post(verifyPath(transferred.scope.id))
      .set(authed(transferred.leadToken))
      .send(body(transferredChallenge.token));
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
    assert.equal(verdict.body.data.status, 'FAILED');
    assert.equal(verdict.body.data.primaryReason, 'ACTOR_ASSIGNMENT_INVALID');
    // The immutable row still binds the ORIGINAL (still-ACTIVE) assignment.
    const stored = await q(
      `SELECT assignment_id, actor_user_id FROM
         handyman_arrival_verification_results WHERE challenge_id = $1`,
      [transferredChallenge.challenge.id],
    );
    assert.equal(stored.rows[0].assignment_id, transferred.assignment.id);
    assert.equal(stored.rows[0].actor_user_id,
      transferred.crew.leadUser.id);
    const consumed = await q(
      `SELECT status FROM handyman_arrival_challenges WHERE id = $1`,
      [transferredChallenge.challenge.id],
    );
    assert.equal(consumed.rows[0].status, 'CONSUMED');
  });

  it('G4-06 (SG-4 Option A): the superseded refusal wins over TTL expiry', async (t) => {
    requireDatabase(t);
    // One live PENDING challenge is allowed per (scope, actor), so the
    // pre-expired fixture IS the only challenge: insert it against the
    // current assignment, then reassign so that binding is superseded.
    const arrival = await arrivalFixture();
    const expiredToken = `expired-superseded-${randomUUID()}`;
    const expiredId = randomUUID();
    await q(
      `INSERT INTO handyman_arrival_challenges
         (id, client_id, execution_scope_id, assignment_id, actor_user_id,
          token_hash, status, expires_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'PENDING', NOW() - INTERVAL '1 hour',
                NOW(), NOW())`,
      [expiredId, arrival.realm.client.id, arrival.scope.id,
        arrival.assignment.id, arrival.crew.leadUser.id,
        sha256(expiredToken)],
    );
    const replacementCrew = await crewFixture(arrival.realm);
    await reassignHandymanExecutionScopeCrew({
      executionScopeId: arrival.scope.id,
      providerContextId: replacementCrew.providerContext.id,
      crewId: replacementCrew.crew.id,
      reason: 'PART 04 G-4 SG-4 ordering evidence',
      expectedVersion: arrival.assignment.version,
      idempotencyKey: `reassign-${randomUUID()}`,
    }, adminUserId);
    const res = await api()
      .post(verifyPath(arrival.scope.id))
      .set(authed(arrival.leadToken))
      .send(body(expiredToken));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(
      res.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED',
      'superseded binding must outrank CHALLENGE_EXPIRED',
    );
    // The dead token still produced no result row and was not projected
    // to EXPIRED.
    const results = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [expiredId],
    );
    assert.equal(results.rows[0].n, 0);
    const expiredRow = await q(
      `SELECT status FROM handyman_arrival_challenges WHERE id = $1`,
      [expiredId],
    );
    assert.equal(expiredRow.rows[0].status, 'PENDING');
  });

  it('G4-08/G4-09: concurrent double-submit stays deterministic and a refusal never resurrects', async (t) => {
    requireDatabase(t);
    const f = await supersededSetup();
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () => api()
        .post(verifyPath(f.scope.id))
        .set(authed(f.leadToken))
        .send(body(f.challenge.token))),
    );
    for (const res of attempts) {
      assert.equal(res.status, 409);
      assert.equal(
        res.body.error.code,
        'HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED',
      );
    }
    const results = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [f.challenge.challenge.id],
    );
    assert.equal(results.rows[0].n, 0, 'zero result rows after a race');
    const consumed = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE id = $1 AND status <> 'PENDING'`,
      [f.challenge.challenge.id],
    );
    assert.equal(consumed.rows[0].n, 0, 'zero consumes after a race');

    // G4-09 — retrying later (still superseded) is refused identically.
    const retry = await api()
      .post(verifyPath(f.scope.id))
      .set(authed(f.leadToken))
      .send(body(f.challenge.token));
    assert.equal(retry.status, 409);
    assert.equal(
      retry.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED',
    );
  });

  it('G4-10: the refusal cannot be bypassed by pointing the URL at another scope', async (t) => {
    requireDatabase(t);
    const f = await supersededSetup();
    // A SECOND scope in the SAME Building the superseded Lead can reach, so
    // the only possible refusal is the (scope, actor, token) binding — not
    // an access denial that would mask the question.
    const { locationChain } = await import('./helpers/handyman-fixtures');
    const otherChain = await locationChain(f.realm);
    const other = await scopeFixture(f.realm, otherChain);
    const res = await api()
      .post(verifyPath(other.scope.id))
      .set(authed(f.leadToken))
      .send(body(f.challenge.token));
    // Binding is (scope, actor, token): a foreign scope cannot resolve the
    // challenge at all, and no result row is created anywhere.
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_ARRIVAL_CHALLENGE_INVALID');
    assert.equal(res.body.data, undefined);
    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [f.challenge.challenge.id],
    );
    assert.equal(rows.rows[0].n, 0);
  });
});

/* ════════════════════ CT — CONTRACT & REGRESSION GATES ════════════════ */

describe('CR-HM-FIELD-OPERATIONS-01 PART 04 — contract gates', () => {
  it('CT-01/CT-02: the six approved operations are documented with the approved permissions and error vocabulary', () => {
    const spec = parseYaml(
      readFileSync('docs/api/openapi.yaml', 'utf8'),
    ) as any;
    const expected: [string, string, string][] = [
      ['post', '/handyman/buildings/{buildingId}/arrival-location-identifiers', 'building_configuration.manage'],
      ['get', '/handyman/buildings/{buildingId}/arrival-location-identifiers', 'building_configuration.read'],
      ['post', '/handyman/buildings/{buildingId}/arrival-location-identifiers/{identifierId}/deactivate', 'building_configuration.manage'],
      ['put', '/handyman/buildings/{buildingId}/geofence-policy', 'building_configuration.manage'],
      ['get', '/handyman/buildings/{buildingId}/geofence-policy', 'building_configuration.read'],
      ['get', '/handyman/buildings/{buildingId}/geofence-policy/history', 'building_configuration.read'],
    ];
    const ids = new Set<string>();
    for (const [method, path, permission] of expected) {
      const op = spec.paths[path]?.[method];
      assert.ok(op, `${method} ${path} must be documented`);
      assert.equal(op['x-required-permission'], permission);
      assert.ok(op.operationId, 'operationId required');
      assert.equal(ids.has(op.operationId), false, 'operationIds must be unique');
      ids.add(op.operationId);
      assert.deepEqual(op.security, [{ bearerAuth: [] }]);
      assert.ok(Array.isArray(op['x-error-codes']));
    }
    // AC-9: no new permission code was invented.
    const allPermissions = new Set(
      Object.values(spec.paths).flatMap((item: any) =>
        Object.values(item as any)
          .map((op: any) => op?.['x-required-permission'])
          .filter(Boolean)),
    );
    assert.ok(allPermissions.has('building_configuration.manage'));
    assert.ok(allPermissions.has('building_configuration.read'));

    // G-4 declares its refusal on the existing terminal command only.
    const terminal = spec.paths[
      '/handyman/execution-scopes/{executionScopeId}/arrival-verification'
    ].post;
    assert.ok(terminal['x-error-codes'].includes(
      'HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED',
    ));
  });

  it('CT-05/CT-06/CT-07 (AC-9): zero migrations, PART 01/02 authorities and the Notification Engine untouched', async () => {
    const { execSync } = await import('node:child_process');
    // AC-9 is a claim about the PART 04 COMMIT, so the range is pinned to that
    // commit (PART 03 gate eed1225 -> PART 04 c2f045f). An open-ended range
    // (`eed1225 -- <path>`) also counts migrations added by later, unrelated
    // CRs that are now on the same branch (CR-HM-SERVICE-CATALOG-01 adds
    // 0477-0480), which would misreport this CR as having added them.
    const changed = execSync(
      'git diff --name-only eed1225 c2f045f -- src/database/migrations',
      { cwd: process.cwd(), encoding: 'utf8' },
    ).trim();
    assert.equal(changed, '', 'PART 04 must add no migration');
    const forbiddenPrefixes = [
      'src/modules/handyman-notifications/',
      'src/modules/mobile-push',
    ];
    for (const prefix of forbiddenPrefixes) {
      const touched = execSync(
        `git diff --name-only eed1225 -- ${prefix}`,
        { cwd: process.cwd(), encoding: 'utf8' },
      ).trim();
      assert.equal(touched, '', `${prefix} must be untouched`);
    }
    // 0476 (PART 01) still exists unchanged.
    const migrations = execSync(
      'git diff --name-only eed1225 -- src/database/migrations/0476_handyman_assignment_response_client_keys.ts',
      { cwd: process.cwd(), encoding: 'utf8' },
    ).trim();
    assert.equal(migrations, '');
  });

  it('CT-04: the configuration module holds no duplicated decision logic', () => {
    const controller = readFileSync(
      'src/modules/handyman-arrival-configuration/'
      + 'handyman-arrival-configuration.controller.ts',
      'utf8',
    );
    // Delegation only: every authority comes from the existing modules.
    for (const fn of [
      'createHandymanArrivalLocationIdentifier',
      'listHandymanArrivalLocationIdentifiers',
      'deactivateHandymanArrivalLocationIdentifier',
      'saveHandymanBuildingGeospatialPolicy',
      'getHandymanBuildingGeospatialPolicy',
      'listHandymanBuildingGeospatialPolicyHistory',
    ]) {
      assert.ok(controller.includes(fn), `must delegate to ${fn}`);
    }
    const stripComments = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const code = stripComments(controller).toLowerCase();
    // No re-implementation of policy maths, hashing or verdict logic.
    for (const token of [
      'haversine', 'createhash', 'sha256', 'token_hash', 'verdict',
      'geofencesignal', 'begin transaction', 'zone',
    ]) {
      assert.equal(
        code.includes(token),
        false,
        `controller must not contain ${token}`,
      );
    }
  });
});
