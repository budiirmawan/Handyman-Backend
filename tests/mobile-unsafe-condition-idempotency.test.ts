import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { assetService } from '../src/modules/assets';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  computeRequestFingerprint,
  parseIdempotencyKeyRequired,
} from '../src/modules/request-idempotency';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { sha256Hex } from '../src/shared/hash';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 03 — automated endpoint idempotency proofs.
 *
 * Closes the PART 02 manual-test gap: every required behaviour of
 * `POST /mobile/assets/{assetId}/unsafe-condition` with the generic
 * `Idempotency-Key` is proven end-to-end (HTTP) against a real database.
 *
 * Proof map (PART 03 checklist):
 *   HEADER          1-6   (missing/blank/malformed/oversized/trimmed/raw-not-stored)
 *   FIRST/REPLAY    7-14  (one mutation, one COMPLETED row, stored 201 replay)
 *   CONFLICT        15-22 (any semantic field change → 409, no leak, no write)
 *   ACTOR/AUTHORITY 23-28 (independent actor namespace, no replay to B,
 *                         authorization failure creates no idempotency row)
 *   ROLLBACK        29-31 (forced business/event failure leaves no record,
 *                         same-key retry after rollback succeeds)
 *   COLLISION       32    (deterministic incident-number UNIQUE collision:
 *                         attempt rolls back claim+rows, outer retry succeeds)
 *   SECURITY        33-34 (fingerprint = exactly the 5 semantic fields;
 *                         raw key absent from response/error/event/audit)
 *
 * Collision injection is TEST-DATABASE ONLY (trigger + sequence on the
 * asentra_test schema). No production code path, flag, or hook is added.
 */

const REPORT_PERMISSION = {
  code: 'asset_failure.report',
  name: 'Report Unsafe Asset Conditions',
};

const OPERATION_KEY = 'reportMobileUnsafeCondition';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const idemKey = () => `raw-key-must-not-leak-${randomUUID()}`;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE request_idempotency_records,
    asset_failure_incidents, operational_incidents,
    finding_escalation_incidents, incidents, asset_history_events, assets,
    equipment_profiles, work_orders, findings, operational_events, buildings,
    properties, users, roles, permissions, clients CASCADE`);
  database = db;

  // Deterministic collision/rollback injection (test DB only).
  //
  // While a config row exists for a client, the FIRST `budget` INSERT
  // attempts for that client fail:
  //   mode 'number_conflict' → 23505 with constraint incidents_number_unique
  //                            (indistinguishable from a real UNIQUE race)
  //   mode 'business_error'  → generic failure during incident create
  //   mode 'event_error'     → generic failure during operational event write
  //
  // `test_idem_collision_seq` is consumed via nextval, which is NOT rolled
  // back with the transaction, so exactly `budget` attempts fail and every
  // later attempt succeeds — deterministic, no races, no production hook.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_idem_collision_config (
      client_id UUID PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('number_conflict','business_error','event_error')),
      budget INTEGER NOT NULL
    )
  `);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS test_idem_collision_seq`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION test_idem_collision_guard()
    RETURNS trigger AS $f$
    DECLARE
      cfg_mode TEXT;
      cfg_budget INTEGER;
      consumed BIGINT;
    BEGIN
      SELECT mode, budget INTO cfg_mode, cfg_budget
        FROM test_idem_collision_config
       WHERE client_id = NEW.client_id;
      IF NOT FOUND OR cfg_budget <= 0 THEN
        RETURN NEW;
      END IF;
      consumed := nextval('test_idem_collision_seq');
      IF consumed > cfg_budget THEN
        RETURN NEW;
      END IF;
      IF cfg_mode = 'number_conflict' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          CONSTRAINT = 'incidents_number_unique',
          MESSAGE = 'forced duplicate key value violates unique constraint "incidents_number_unique" (test injection)';
      END IF;
      RAISE EXCEPTION 'forced business failure (test injection)';
    END;
    $f$ LANGUAGE plpgsql
  `);
  // No WHEN clause (PostgreSQL forbids subqueries there) — the function is a
  // cheap no-op whenever no config row exists for the inserted client.
  await pool.query(`DROP TRIGGER IF EXISTS test_idem_incidents_guard ON incidents`);
  await pool.query(`
    CREATE TRIGGER test_idem_incidents_guard
      BEFORE INSERT ON incidents
      FOR EACH ROW
      EXECUTE FUNCTION test_idem_collision_guard()
  `);
  await pool.query(`DROP TRIGGER IF EXISTS test_idem_events_guard ON operational_events`);
  await pool.query(`
    CREATE TRIGGER test_idem_events_guard
      BEFORE INSERT ON operational_events
      FOR EACH ROW
      EXECUTE FUNCTION test_idem_collision_guard()
  `);
});

after(async () => {
  if (pool) {
    await pool.query(`DROP TRIGGER IF EXISTS test_idem_incidents_guard ON incidents`);
    await pool.query(`DROP TRIGGER IF EXISTS test_idem_events_guard ON operational_events`);
    await pool.query(`DROP FUNCTION IF EXISTS test_idem_collision_guard()`);
    await pool.query(`DROP TABLE IF EXISTS test_idem_collision_config`);
    await pool.query(`DROP SEQUENCE IF EXISTS test_idem_collision_seq`);
    await closePool(pool);
  }
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function ensurePermissionId(code: string, name: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) return existing.id;
  return (await permissionService.createPermission({ code, name })).id;
}

/**
 * Creates an authenticated session whose role carries EXACTLY the given
 * permission codes, and returns both the token and the user id. Local to this
 * suite on purpose: no shared test helper is modified by this CR.
 */
async function sessionWith(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix().toLowerCase();
  const password = 'FieldPass123';
  const user = await userService.createUser({
    email: `idem-field-${tag}@example.com`,
    displayName: 'Field Reporter',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `IDEM_${tag.toUpperCase()}`,
    name: 'Field Reporter',
  });
  for (const permission of codes) {
    const permissionId = await ensurePermissionId(permission.code, permission.name);
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function structure(options: { assignUserId?: string } = {}) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Idempotency Client',
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
  if (options.assignUserId) {
    await buildingAssignmentService.createAssignment(options.assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

async function asset(buildingId: string) {
  return assetService.createAsset({
    buildingId,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller Unit',
  });
}

const report = (
  assetId: string,
  payload: unknown,
  token: string,
  idempotencyKey?: string,
) => {
  const request = api()
    .post(`/api/v1/mobile/assets/${assetId}/unsafe-condition`)
    .set({ Authorization: `Bearer ${token}` });
  if (idempotencyKey !== undefined) {
    request.set('Idempotency-Key', idempotencyKey);
  }
  return request.send(payload as Record<string, unknown>);
};

/** Arm the collision guard: exactly `budget` next insert attempts fail. */
async function armCollision(clientId: string, mode: string, budget = 1) {
  // is_called=false → the next nextval() returns exactly 1, so the first
  // armed attempt is `consumed = 1 <= budget` and fails deterministically.
  await pool!.query(`SELECT setval('test_idem_collision_seq', 1, false)`);
  await pool!.query(
    `INSERT INTO test_idem_collision_config (client_id, mode, budget)
       VALUES ($1, $2, $3)
     ON CONFLICT (client_id) DO UPDATE SET mode = EXCLUDED.mode, budget = EXCLUDED.budget`,
    [clientId, mode, budget],
  );
}

async function disarmCollision(clientId: string) {
  await pool!.query(
    `DELETE FROM test_idem_collision_config WHERE client_id = $1`,
    [clientId],
  );
}

async function idemRowsForKey(key: string) {
  const result = await pool!.query(
    `SELECT * FROM request_idempotency_records
      WHERE operation_key = $1 AND idempotency_key_hash = $2`,
    [OPERATION_KEY, sha256Hex(key)],
  );
  return result.rows as Array<Record<string, any>>;
}

async function countsFor(buildingId: string) {
  const failures = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM asset_failure_incidents afi
       JOIN incidents i ON i.id = afi.incident_id
      WHERE i.building_id = $1`,
    [buildingId],
  );
  const incidents = await pool!.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM incidents WHERE building_id = $1',
    [buildingId],
  );
  const events = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM operational_events
      WHERE building_id = $1 AND event_type = 'ASSET_FAILURE_REPORTED'`,
    [buildingId],
  );
  return {
    assetFailures: Number(failures.rows[0]?.count),
    incidents: Number(incidents.rows[0]?.count),
    events: Number(events.rows[0]?.count),
  };
}

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 03 — Idempotency-Key header', () => {
  it('1. missing key → 400 IDEMPOTENCY_KEY_REQUIRED', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const response = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      reporter.token,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal((await idemRowsForKey('missing')).length, 0);
  });

  it('2. blank key → 400 IDEMPOTENCY_KEY_REQUIRED', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const response = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      reporter.token,
      '   ',
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('3. malformed CR / LF / NUL keys are rejected', async (t) => {
    if (!ready(t)) return;
    // The authoritative rejection is the PART 01 validator: CR, LF and NUL
    // are rejected in the RAW value (interior or surrounding), before any
    // trim, hashing, or persistence. The HTTP transport layer also refuses
    // to transmit any of these characters in a header value (Node rejects
    // them client-side with ERR_INVALID_CHAR), so no CR/LF/NUL key can ever
    // reach a claim through the endpoint — the validator is the defence in
    // depth for any non-HTTP caller of the same code path.
    for (const bad of ['key\rvalue', 'key\nvalue', 'key\0value']) {
      assert.throws(
        () => parseIdempotencyKeyRequired(bad),
        (error: any) =>
          error.statusCode === 400 && error.code === 'VALIDATION_ERROR',
        `CR/LF/NUL must be rejected: ${JSON.stringify(bad)}`,
      );
    }
  });

  it('4. key longer than 200 chars → 400', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const tooLong = 'k'.repeat(201);
    const response = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      reporter.token,
      tooLong,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal((await idemRowsForKey(tooLong)).length, 0);
  });

  it('5. trimmed key succeeds and 6. raw key is never stored', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const raw = `  ${idemKey()}  `; // padded — normalization must trim
    const response = await report(
      equipment.id,
      { title: 'Trimmed key report.' },
      reporter.token,
      raw,
    );
    // 5 — the trimmed key is accepted.
    assert.equal(response.status, 201);

    // 6 — only SHA-256 of the TRIMMED key is stored; the raw (padded) key
    //    appears in no column of the record and in no response byte.
    const trimmed = raw.trim();
    const rows = await idemRowsForKey(trimmed);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idempotency_key_hash, sha256Hex(trimmed));
    assert.equal(rows[0].actor_user_id, reporter.userId);
    assert.equal(rows[0].operation_key, OPERATION_KEY);
    const serializedRow = JSON.stringify(rows[0]);
    assert.ok(!serializedRow.includes(raw), 'raw padded key must not be stored');
    assert.ok(!serializedRow.includes(trimmed), 'normalized raw key must not be stored');
    assert.ok(!JSON.stringify(response.body).includes(raw));
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 03 — first request / replay', () => {
  const payload = {
    title: 'Chiller discharge line loose, spray visible.',
    description: 'Observed during the morning walk-through.',
    failureCategory: 'LEAKAGE',
    occurredAt: '2026-07-01T08:00:00.000Z',
  };

  it('7-14. one mutation, one COMPLETED row, stored 201 replay, zero extra writes', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { client, building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const key = idemKey();

    const first = await report(equipment.id, payload, reporter.token, key);
    assert.equal(first.status, 201);
    const firstData = first.body.data;
    assert.equal(firstData.assetId, equipment.id);
    assert.equal(firstData.clientId, client.id);
    assert.equal(firstData.buildingId, building.id);

    // 7 — exactly one Asset Failure.
    // 8 — exactly one idempotency row, COMPLETED.
    // 9 — stored response_status = 201.
    let rows = await idemRowsForKey(key);
    assert.equal(rows.length, 1, 'exactly one idempotency row');
    assert.equal(rows[0].status, 'COMPLETED');
    assert.equal(rows[0].response_status, 201);
    assert.ok(rows[0].response_body, 'stored response body present');
    assert.ok(rows[0].completed_at, 'completed_at set');

    // 10 — the replay returns 201.
    const replay = await report(equipment.id, payload, reporter.token, key);
    assert.equal(replay.status, 201, 'replay returns the stored 201');

    // 11 — the replay carries the SAME canonical incident/failure identity.
    assert.deepEqual(replay.body.data, firstData);
    assert.equal(replay.body.data.incidentId, firstData.incidentId);
    assert.equal(replay.body.data.incidentNumber, firstData.incidentNumber);
    assert.equal(replay.body.data.assetId, firstData.assetId);

    // 12/13/14 — no second Asset Failure, Incident, or event.
    const after = await countsFor(building.id);
    assert.equal(after.assetFailures, 1, 'no second Asset Failure');
    assert.equal(after.incidents, 1, 'no second Incident');
    assert.equal(after.events, 1, 'no duplicate ASSET_FAILURE_REPORTED event');

    // Still exactly one idempotency row, untouched by the replay.
    rows = await idemRowsForKey(key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'COMPLETED');
    assert.deepEqual(rows[0].response_body, firstData);
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 03 — fingerprint conflict', () => {
  const base = {
    title: 'Base title for conflict proofs.',
    description: 'Base description for conflict proofs.',
    failureCategory: 'ELECTRICAL_FAILURE',
    occurredAt: '2026-07-02T10:15:00.000Z',
  };

  it('15-22. any semantic change → 409, no leak, no business mutation', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const other = await asset(building.id);
    const key = idemKey();

    const first = await report(equipment.id, base, reporter.token, key);
    assert.equal(first.status, 201);
    const firstData = first.body.data;
    const firstBodyJson = JSON.stringify(first.body);

    const conflicts: Array<[string, unknown, string]> = [
      ['title', { ...base, title: 'Changed title.' }, '15'],
      ['description', { ...base, description: 'Changed description.' }, '16'],
      ['failureCategory', { ...base, failureCategory: 'LEAKAGE' }, '17'],
      ['occurredAt', { ...base, occurredAt: '2026-07-02T11:00:00.000Z' }, '18'],
    ];

    for (const [field, changed, item] of conflicts) {
      const response = await report(
        equipment.id,
        changed,
        reporter.token,
        key,
      );
      // 15-18 — each semantic field change conflicts.
      assert.equal(
        response.status,
        409,
        `${item}. changed ${field} must conflict`,
      );
      assert.equal(response.body.error.code, 'IDEMPOTENCY_CONFLICT');
      // 20 — no stored response leaked.
      const conflictJson = JSON.stringify(response.body);
      assert.ok(
        !conflictJson.includes(firstData.incidentId),
        `20. conflict must not leak stored incidentId (${field})`,
      );
      assert.ok(
        !conflictJson.includes(firstData.incidentNumber),
        `20. conflict must not leak stored incidentNumber (${field})`,
      );
      assert.ok(!('data' in response.body), 'conflict carries no data payload');
      // 21 — no raw key leaked.
      assert.ok(!conflictJson.includes(key), '21. conflict must not leak raw key');
    }

    // 19 — changed assetId (different Asset, same Building) conflicts too.
    const changedAsset = await report(
      other.id,
      base,
      reporter.token,
      key,
    );
    assert.equal(changedAsset.status, 409, '19. changed assetId must conflict');
    assert.equal(changedAsset.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.ok(
      !JSON.stringify(changedAsset.body).includes(firstData.incidentId),
      '20. assetId conflict must not leak stored response',
    );

    // 22 — no business mutation on ANY conflict, and the stored row is intact.
    const after = await countsFor(building.id);
    assert.equal(after.assetFailures, 1, '22. no second Asset Failure on conflict');
    assert.equal(after.incidents, 1, '22. no second Incident on conflict');
    assert.equal(after.events, 1, '22. no duplicate event on conflict');
    const rows = await idemRowsForKey(key);
    assert.equal(rows.length, 1, '22. no extra idempotency row on conflict');
    assert.equal(rows[0].status, 'COMPLETED');
    assert.deepEqual(rows[0].response_body, firstData, 'stored result untouched');
    assert.equal(firstBodyJson.includes(firstData.incidentNumber), true);
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 03 — actor / authority', () => {
  it('23-24. different authorized actor + same raw key → independent namespace', async (t) => {
    if (!ready(t)) return;
    const actorA = await sessionWith([REPORT_PERMISSION]);
    const actorB = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: actorA.userId });
    await buildingAssignmentService.createAssignment(actorB.userId, {
      buildingId: building.id,
    });
    const equipment = await asset(building.id);
    const sharedRawKey = idemKey(); // the SAME raw key on both actors
    const payload = { title: 'Shared raw key across actors.' };

    const aFirst = await report(equipment.id, payload, actorA.token, sharedRawKey);
    assert.equal(aFirst.status, 201);

    // 23 — B with the same raw key gets an INDEPENDENT namespace: B's request
    //    creates B's own record instead of replaying A's stored result.
    const bFirst = await report(equipment.id, payload, actorB.token, sharedRawKey);
    assert.equal(bFirst.status, 201, 'B is not blocked by A');
    assert.notEqual(
      bFirst.body.data.incidentId,
      aFirst.body.data.incidentId,
      '23. B must not receive A stored incident',
    );

    // 24 — B replays and still only ever sees B's own result.
    const bReplay = await report(equipment.id, payload, actorB.token, sharedRawKey);
    assert.equal(bReplay.status, 201);
    assert.equal(bReplay.body.data.incidentId, bFirst.body.data.incidentId);
    assert.notEqual(
      bReplay.body.data.incidentId,
      aFirst.body.data.incidentId,
      '24. B never receives A response',
    );

    // Two independent rows (one per actor), both COMPLETED.
    const rows = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM request_idempotency_records
        WHERE operation_key = $1 AND idempotency_key_hash = $2`,
      [OPERATION_KEY, sha256Hex(sharedRawKey)],
    );
    assert.equal(rows.rows[0]?.count, '2');
  });

  it('25. permission failure creates no idempotency row', async (t) => {
    if (!ready(t)) return;
    const nobody = await sessionWith([]);
    const { building } = await structure();
    await buildingAssignmentService.createAssignment(nobody.userId, {
      buildingId: building.id,
    });
    const equipment = await asset(building.id);
    const key = idemKey();

    const response = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      nobody.token,
      key,
    );
    assert.equal(response.status, 403);
    assert.equal((await idemRowsForKey(key)).length, 0, '25. no row on 403');
  });

  it('26. Building-access failure creates no idempotency row', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const foreign = await sessionWith([REPORT_PERMISSION]);
    // foreign has the permission but NO assignment to this Building.
    const key = idemKey();
    const response = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      foreign.token,
      key,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal((await idemRowsForKey(key)).length, 0, '26. no row on building denial');
  });

  it('27. unknown Asset creates no idempotency row', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const key = idemKey();

    const response = await report(
      randomUUID(),
      { title: 'Unsafe condition.' },
      reporter.token,
      key,
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
    assert.equal((await idemRowsForKey(key)).length, 0, '27. no row on 404');
    void building;
  });

  it('28. validation failure creates no idempotency row', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const key = idemKey();

    const response = await report(
      equipment.id,
      { title: '   ' },
      reporter.token,
      key,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal((await idemRowsForKey(key)).length, 0, '28. no row on validation failure');
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 03 — rollback / no poison', () => {
  it('29+31. forced business create failure leaves no record; same-key retry succeeds', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { client, building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const key = idemKey();
    const payload = { title: 'Rollback proof, business failure.' };

    await armCollision(client.id, 'business_error', 1);
    try {
      const failed = await report(equipment.id, payload, reporter.token, key);
      // 29 — the forced failure surfaces as a 500 and nothing remains:
      //      no idempotency row, no incident, no Asset Failure, no event.
      assert.equal(failed.status, 500);
      assert.equal((await idemRowsForKey(key)).length, 0, '29. no idempotency row');
      const after = await countsFor(building.id);
      assert.equal(after.assetFailures, 0, '29. no Asset Failure');
      assert.equal(after.incidents, 0, '29. no Incident');
      assert.equal(after.events, 0, '29. no event');
    } finally {
      await disarmCollision(client.id);
    }

    // 31 — the SAME key + same canonical request now succeeds: the rolled-back
    //      attempt left no poisoned record.
    const retry = await report(equipment.id, payload, reporter.token, key);
    assert.equal(retry.status, 201, '31. same-key retry after rollback succeeds');
    const rows = await idemRowsForKey(key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'COMPLETED');
    const after = await countsFor(building.id);
    assert.equal(after.assetFailures, 1);
    assert.equal(after.incidents, 1);
    assert.equal(after.events, 1);
  });

  it('30. operational-event failure rolls back business + idempotency', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { client, building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const key = idemKey();
    const payload = { title: 'Rollback proof, event failure.' };

    await armCollision(client.id, 'event_error', 1);
    try {
      const failed = await report(equipment.id, payload, reporter.token, key);
      // 30 — the event write and the business writes are ONE transaction:
      //      the event failure rolls back incident, Asset Failure, and claim.
      assert.equal(failed.status, 500);
      assert.equal((await idemRowsForKey(key)).length, 0, '30. no idempotency row');
      const after = await countsFor(building.id);
      assert.equal(after.assetFailures, 0, '30. business rolled back with event');
      assert.equal(after.incidents, 0, '30. incident rolled back with event');
      assert.equal(after.events, 0, '30. no partial event');
    } finally {
      await disarmCollision(client.id);
    }

    // …and the key remains usable (no poison), same as the business-failure proof.
    const retry = await report(equipment.id, payload, reporter.token, key);
    assert.equal(retry.status, 201);
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 03 — incident number collision', () => {
  it('32. deterministic collision: attempt rolls back, outer retry succeeds', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { client, building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const key = idemKey();
    const payload = { title: 'Collision proof report.' };

    // Force the FIRST incident insert to fail exactly like a real UNIQUE
    // race on (client_id, incident_number): SQLSTATE 23505 with the exact
    // constraint name the code detects. The sequence (not rolled back)
    // guarantees the SECOND attempt passes.
    let response: any;
    await armCollision(client.id, 'number_conflict', 1);
    try {
      response = await report(equipment.id, payload, reporter.token, key);
      // The outer retry loop (OUTSIDE the idempotency transaction) generated
      // a new UNC_ number and succeeded — the whole first attempt (claim +
      // incident + specialization + event) rolled back.
      assert.equal(response.status, 201, '32. retry after collision succeeds');
    } finally {
      await disarmCollision(client.id);
    }

    // Exactly ONE of everything: the failed attempt left no residue.
    const after = await countsFor(building.id);
    assert.equal(after.assetFailures, 1, '32. no residue from the failed attempt');
    assert.equal(after.incidents, 1, '32. no residue incident');
    assert.equal(after.events, 1, '32. no residue event');

    const rows = await idemRowsForKey(key);
    assert.equal(rows.length, 1, '32. exactly one idempotency row');
    assert.equal(rows[0].status, 'COMPLETED');
    assert.equal(rows[0].response_status, 201);
    // The stored result IS the successful (second) attempt's result.
    assert.deepEqual(rows[0].response_body, response.body.data);

    // And the key replays normally afterwards.
    const replay = await report(equipment.id, payload, reporter.token, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.incidentId, response.body.data.incidentId);
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 03 — security', () => {
  it('33. fingerprint is exactly the five semantic fields', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const key = idemKey();

    const title = 'Fingerprint field proof.';
    const description = 'Fingerprint field proof description.';
    const failureCategory = 'OVERHEATING';
    const occurredAt = '2026-07-03T12:00:00.000Z';
    const response = await report(
      equipment.id,
      { title, description, failureCategory, occurredAt },
      reporter.token,
      key,
    );
    assert.equal(response.status, 201);

    // The stored fingerprint must equal SHA-256(stableJson) of EXACTLY the
    // five canonical semantic fields — nothing else (no incidentNumber,
    // clientId, buildingId, operationalImpact, failureStatus, reporterUserId).
    const expected = computeRequestFingerprint({
      assetId: equipment.id,
      title,
      description,
      failureCategory,
      occurredAt,
    });
    const rows = await idemRowsForKey(key);
    assert.equal(rows[0].request_fingerprint, expected);
  });

  it('33b. omitted occurredAt normalizes to null and still replays', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const key = idemKey();
    const payload = { title: 'Omitted occurredAt replay proof.' };

    const first = await report(equipment.id, payload, reporter.token, key);
    assert.equal(first.status, 201);
    const replay = await report(equipment.id, payload, reporter.token, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.incidentId, first.body.data.incidentId);

    const expected = computeRequestFingerprint({
      assetId: equipment.id,
      title: payload.title,
      description: null,
      failureCategory: 'OTHER',
      occurredAt: null,
    });
    const rows = await idemRowsForKey(key);
    assert.equal(rows[0].request_fingerprint, expected);
  });

  it('34. raw key absent from response / error / event / audit', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    const rawKey = idemKey(); // distinctive: must appear NOWHERE persisted
    const payload = { title: 'Raw key leak proof.' };

    const ok = await report(equipment.id, payload, reporter.token, rawKey);
    assert.equal(ok.status, 201);

    // Response body.
    assert.ok(!JSON.stringify(ok.body).includes(rawKey), '34. raw key in 201 body');

    // Error bodies: conflict + validation + missing-key.
    const conflict = await report(
      equipment.id,
      { ...payload, title: 'Different title for conflict.' },
      reporter.token,
      rawKey,
    );
    assert.equal(conflict.status, 409);
    assert.ok(!JSON.stringify(conflict.body).includes(rawKey), '34. raw key in 409 body');

    const validation = await report(
      equipment.id,
      { title: '   ' },
      reporter.token,
      `${rawKey}-validation`,
    );
    assert.equal(validation.status, 400);
    assert.ok(!JSON.stringify(validation.body).includes(rawKey), '34. raw key in 400 body');

    const missing = await report(equipment.id, payload, reporter.token);
    assert.equal(missing.status, 400);
    assert.ok(!JSON.stringify(missing.body).includes(rawKey), '34. raw key in 400 body');

    // The operational event (audit trail).
    const events = await pool!.query(
      `SELECT summary, metadata FROM operational_events
        WHERE building_id = $1 AND event_type = 'ASSET_FAILURE_REPORTED'`,
      [building.id],
    );
    assert.equal(events.rowCount, 1);
    for (const event of events.rows) {
      assert.ok(
        !JSON.stringify(event).includes(rawKey),
        '34. raw key in operational event',
      );
    }

    // The audit record itself (every column).
    const rows = await idemRowsForKey(rawKey);
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0]).includes(rawKey), '34. raw key in idempotency record');
    assert.equal(rows[0].idempotency_key_hash, sha256Hex(rawKey));
  });
});
