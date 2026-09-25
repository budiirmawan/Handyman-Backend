import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  ASSET_OPERATIONAL_STATE_IN_SERVICE,
  ASSET_OPERATIONAL_STATE_TRANSITIONS,
} from '../src/modules/asset-operational-state';
import { assetService } from '../src/modules/assets';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { equipmentProfileService } from '../src/modules/equipment-profiles';
import { MOBILE_EVIDENCE_EXECUTION_TYPES } from '../src/modules/evidence/mobile-evidence.types';
import { resolveMobileQr } from '../src/modules/mobile-qr-resolution';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 03 — governed RETURN_TO_SERVICE.
 *
 * Proves the return-to-service command is a GOVERNED operation rather than a
 * state assignment: its own dedicated permission, its own safety-risk
 * clearance gate over the canonical BE-21C failure records, its own approval
 * record naming the executing actor, the PART-02 compare-and-set token, and ONE
 * transaction in which the state change and its audit entry commit together or
 * not at all.
 *
 * It also proves the boundaries: the generic PATCH still cannot reach
 * `IN_SERVICE`; the command never mutates `assets.status`,
 * `equipment_profiles.status`, an Asset Failure, a Work Order, or a Finding;
 * there is no mobile command, no mobile action token, and no idempotency key —
 * and a replayed request cannot perform a second transition.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const ROUTES_DIR = resolve(__dirname, '../src/routes');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

const RETURN_PATH = '/assets/{assetId}/operational-state/return-to-service';
const STATE_PATH = '/assets/{assetId}/operational-state';

const READ_PERMISSION = { code: 'asset.read', name: 'Read Assets' };
const MANAGE_PERMISSION = {
  code: 'asset_operational_state.manage',
  name: 'Manage Asset Operational State',
};
const RETURN_PERMISSION = {
  code: 'asset_operational_state.return_to_service',
  name: 'Return Asset to Service',
};
const ASSET_MANAGE_PERMISSION = { code: 'asset.manage', name: 'Manage Assets' };
const EQUIPMENT_MANAGE_PERMISSION = {
  code: 'equipment_profile.manage',
  name: 'Manage Equipment Profiles',
};
const HISTORY_READ_PERMISSION = {
  code: 'asset_history.read',
  name: 'Read Asset History',
};
const FAILURE_REPORT_PERMISSION = {
  code: 'asset_failure.report',
  name: 'Report Unsafe Asset Conditions',
};
const FAILURE_MANAGE_PERMISSION = {
  code: 'asset_failure.manage',
  name: 'Manage Asset Failures',
};

/** The three legitimate sources. Peers: no ordering is asserted anywhere. */
const SOURCE_STATES = ['OUT_OF_SERVICE', 'ISOLATED', 'SHUT_DOWN'] as const;

const PAST = '2026-08-01T09:30:00.000Z';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE asset_failure_incidents, operational_incidents,
    incidents, asset_history_events, asset_identifiers, assets,
    equipment_profiles, work_orders, findings, operational_events, buildings,
    properties, users, roles, permissions, clients CASCADE`);
  const admin = await sessionWith([
    READ_PERMISSION,
    MANAGE_PERMISSION,
    RETURN_PERMISSION,
    ASSET_MANAGE_PERMISSION,
    EQUIPMENT_MANAGE_PERMISSION,
    HISTORY_READ_PERMISSION,
    FAILURE_REPORT_PERMISSION,
    FAILURE_MANAGE_PERMISSION,
  ]);
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
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

/** Authenticated session whose role carries EXACTLY the given codes. */
async function sessionWith(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix().toLowerCase();
  const password = 'ReturnToServicePass123';
  const user = await userService.createUser({
    email: `rts-${tag}@example.com`,
    displayName: 'Return To Service User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `RTS_${tag.toUpperCase()}`,
    name: 'Return To Service Role',
  });
  for (const permission of codes) {
    const permissionId = await ensurePermissionId(
      permission.code,
      permission.name,
    );
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function structure(options: { assignUserId?: string | null } = {}) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Return To Service Client',
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
  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function createAsset(buildingId: string, overrides: object = {}) {
  return assetService.createAsset({
    buildingId,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller Unit',
    ...overrides,
  });
}

/** A fresh Asset in a Building the admin can reach. */
async function fixture(overrides: object = {}) {
  const { building } = await structure();
  return { building, asset: await createAsset(building.id, overrides) };
}

/** Raw authoritative row — the only thing that proves what was persisted. */
async function row(assetId: string) {
  const result = await pool!.query<{
    operational_state: string;
    operational_state_version: number;
    operational_state_changed_at: Date | null;
    operational_state_changed_by_user_id: string | null;
    operational_state_reason: string | null;
    status: string;
    previous_status: string | null;
    status_changed_at: Date | null;
    status_reason: string | null;
    updated_at: Date;
  }>(
    `SELECT operational_state, operational_state_version,
            operational_state_changed_at, operational_state_changed_by_user_id,
            operational_state_reason, status, previous_status, status_changed_at,
            status_reason, updated_at
       FROM assets WHERE id = $1`,
    [assetId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!;
}

const getState = (assetId: string, token = adminToken) =>
  api()
    .get(`/api/v1/assets/${assetId}/operational-state`)
    .set({ Authorization: `Bearer ${token}` });

const patchState = (
  assetId: string,
  payload: unknown,
  token = adminToken,
) =>
  api()
    .patch(`/api/v1/assets/${assetId}/operational-state`)
    .set({ Authorization: `Bearer ${token}` })
    .send(payload as Record<string, unknown>);

const returnToService = (
  assetId: string,
  payload: unknown,
  token = adminToken,
) =>
  api()
    .post(`/api/v1/assets/${assetId}/operational-state/return-to-service`)
    .set({ Authorization: `Bearer ${token}` })
    .send(payload as Record<string, unknown>);

/** Moves the Asset into a non-service state through the PART 02 command. */
async function park(
  assetId: string,
  state: string = 'OUT_OF_SERVICE',
  reason = 'Removed from service for inspection.',
  token = adminToken,
) {
  const current = await getState(assetId, token);
  const response = await patchState(
    assetId,
    { state, reason, expectedVersion: current.body.data.version },
    token,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data as { operationalState: string; version: number };
}

async function historyEvents(assetId: string, eventType: string) {
  const result = await pool!.query<{
    actor_user_id: string | null;
    summary: string;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT actor_user_id, summary, metadata, created_at
       FROM asset_history_events
      WHERE asset_id = $1 AND event_type = $2
      ORDER BY created_at`,
    [assetId, eventType],
  );
  return result.rows;
}

/** Every registered METHOD+PATH found in the route modules. */
function registeredRoutes(): string[] {
  const re = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const out: string[] = [];
  function walk(dir: string): string[] {
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) files.push(...walk(path));
      else if (name.endsWith('.routes.ts')) files.push(path);
    }
    return files;
  }
  for (const file of [...walk(MODULES_DIR), ...walk(ROUTES_DIR)]) {
    const src = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      out.push(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }
  return out;
}

/** Content digest of a whole table — insert/update/delete all move it. */
async function tableDigest(table: 'work_orders' | 'findings'): Promise<string> {
  const result = await pool!.query<{ digest: string | null }>(
    `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
       FROM ${table} t`,
  );
  return result.rows[0]?.digest ?? '';
}

async function createFailure(
  buildingId: string,
  assetId: string,
  overrides: Record<string, unknown> = {},
  token = adminToken,
) {
  const response = await api()
    .post('/api/v1/asset-failures')
    .set({ Authorization: `Bearer ${token}` })
    .send({
      buildingId,
      assetId,
      incidentNumber: `AF_${suffix()}`,
      title: 'Chiller compressor failure',
      failureCategory: 'MECHANICAL_FAILURE',
      occurredAt: PAST,
      ...overrides,
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data as { id: string; failureStatus: string };
}

async function setFailureStatus(
  incidentId: string,
  failureStatus: string,
  token = adminToken,
) {
  const response = await api()
    .patch(`/api/v1/asset-failures/${incidentId}`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ failureStatus });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data as { failureStatus: string };
}

async function failureRow(incidentId: string) {
  const result = await pool!.query<{
    failure_status: string;
    operational_impact: string | null;
    asset_id: string;
    incident_status: string;
    updated_at: Date;
  }>(
    `SELECT af.failure_status, af.operational_impact, af.asset_id,
            i.status AS incident_status, af.updated_at
       FROM asset_failure_incidents af
       JOIN incidents i ON i.id = af.incident_id
      WHERE af.incident_id = $1`,
    [incidentId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!;
}

async function historyRead(assetId: string, token = adminToken) {
  return api()
    .get(`/api/v1/assets/${assetId}/history`)
    .set({ Authorization: `Bearer ${token}` });
}

describe('CR-BE-RN10-SAFE-EQUIPMENT-01 PART 03 — governed return to service', () => {
  describe('1-5. every legitimate source state returns to service', () => {
    for (const source of SOURCE_STATES) {
      it(`returns a ${source} asset to IN_SERVICE`, async (t) => {
        if (!ready(t)) return;

        const { asset } = await fixture();
        const parked = await park(asset.id, source);
        assert.equal(parked.operationalState, source);

        const response = await returnToService(asset.id, {
          reason: 'Hazard cleared and equipment verified.',
          expectedVersion: parked.version,
        });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        const data = response.body.data;
        assert.equal(data.assetId, asset.id);
        assert.equal(data.operationalState, 'IN_SERVICE');
        assert.equal(data.version, parked.version + 1);
        assert.equal(data.changedByUserId, adminUserId);
        assert.equal(data.reason, 'Hazard cleared and equipment verified.');
        // 5 — the read model reports the PART 02 IN_SERVICE targets.
        assert.deepEqual(data.allowedTransitions, [
          'OUT_OF_SERVICE',
          'ISOLATED',
          'SHUT_DOWN',
        ]);
        // The response is the canonical operational-state read model, not a
        // bespoke return-to-service shape and not an action vocabulary.
        assert.deepEqual(Object.keys(data).sort(), [
          'allowedTransitions',
          'assetId',
          'assetStatus',
          'changedAt',
          'changedByUserId',
          'operationalState',
          'reason',
          'version',
        ]);
        assert.equal('availableActions' in data, false);

        const persisted = await row(asset.id);
        assert.equal(persisted.operational_state, 'IN_SERVICE');
        assert.equal(persisted.operational_state_version, parked.version + 1);
      });
    }

    it('4. reads back as IN_SERVICE with the three non-service transitions', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'ISOLATED');
      await returnToService(asset.id, {
        reason: 'Isolation lifted.',
        expectedVersion: parked.version,
      });

      const read = await getState(asset.id);
      assert.equal(read.status, 200);
      assert.equal(read.body.data.operationalState, 'IN_SERVICE');
      assert.deepEqual(read.body.data.allowedTransitions, [
        'OUT_OF_SERVICE',
        'ISOLATED',
        'SHUT_DOWN',
      ]);
      assert.equal(read.body.data.assetStatus, 'ACTIVE');
    });
  });

  describe('6-8. invalid source and lifecycle terminality', () => {
    it('6. refuses an already in-service asset deterministically', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const before = await row(asset.id);

      const response = await returnToService(asset.id, {
        reason: 'Already running.',
        expectedVersion: 1,
      });

      assert.equal(response.status, 409);
      assert.equal(
        response.body.error.code,
        'ASSET_OPERATIONAL_STATE_ALREADY_IN_SERVICE',
      );
      // No silent success: nothing was written, no event invented.
      assert.deepEqual(await row(asset.id), before);
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE')).length,
        0,
      );
    });

    it('7. refuses a RETIRED asset and never reactivates it', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'OUT_OF_SERVICE', 'Failing bearing.');
      const retired = await api()
        .patch(`/api/v1/assets/${asset.id}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: 'RETIRED', reason: 'End of life.' });
      assert.equal(retired.status, 200);
      const before = await row(asset.id);

      const response = await returnToService(asset.id, {
        reason: 'Trying to revive a retired asset.',
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'ASSET_OPERATIONAL_STATE_RETIRED');
      // Operational state is never a way around lifecycle terminality.
      assert.deepEqual(await row(asset.id), before);
      assert.equal((await row(asset.id)).status, 'RETIRED');
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE')).length,
        0,
      );
    });

    it('8. keeps the generic PATCH refusing IN_SERVICE', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'SHUT_DOWN');

      // Refused at request validation...
      const validation = await patchState(asset.id, {
        state: 'IN_SERVICE',
        reason: 'Shortcut attempt.',
        expectedVersion: parked.version,
      });
      assert.equal(validation.status, 400);
      assert.equal(validation.body.error.code, 'VALIDATION_ERROR');
      assert.equal(validation.body.error.details[0].field, 'state');

      // ...and in the state machine: no edge returns to IN_SERVICE.
      for (const state of [
        ...SOURCE_STATES,
        'IN_SERVICE' as const,
      ]) {
        assert.equal(
          ASSET_OPERATIONAL_STATE_TRANSITIONS[state].includes(
            ASSET_OPERATIONAL_STATE_IN_SERVICE,
          ),
          false,
          `${state} must not reach IN_SERVICE through the transition table`,
        );
      }

      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state, 'SHUT_DOWN');
      assert.equal(persisted.operational_state_version, parked.version);
    });
  });

  describe('9-16. the request body is a strict allowlist', () => {
    it('9-12. requires a non-blank, bounded, trimmed reason', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id);
      const version = parked.version;

      const missing = await returnToService(asset.id, {
        expectedVersion: version,
      });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error.details[0].field, 'reason');
      assert.match(missing.body.error.details[0].message, /required/);

      const blank = await returnToService(asset.id, {
        reason: '   ',
        expectedVersion: version,
      });
      assert.equal(blank.status, 400);
      assert.match(blank.body.error.details[0].message, /blank/);

      const notAString = await returnToService(asset.id, {
        reason: 42,
        expectedVersion: version,
      });
      assert.equal(notAString.status, 400);
      assert.equal(notAString.body.error.details[0].field, 'reason');

      const tooLong = await returnToService(asset.id, {
        reason: 'x'.repeat(1001),
        expectedVersion: version,
      });
      assert.equal(tooLong.status, 400);
      assert.match(tooLong.body.error.details[0].message, /1000/);

      // None of the refusals wrote anything.
      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state, 'OUT_OF_SERVICE');
      assert.equal(persisted.operational_state_version, version);

      // The accepted boundary is exactly 1000 characters, trimmed.
      const accepted = await returnToService(asset.id, {
        reason: `  ${'y'.repeat(1000)}  `,
        expectedVersion: version,
      });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.data.reason.length, 1000);
    });

    it('13-14. requires expectedVersion to be an integer >= 1', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await park(asset.id);

      for (const [label, value] of [
        ['missing', undefined],
        ['null', null],
        ['string', '2'],
        ['fractional', 1.5],
        ['zero', 0],
        ['negative', -3],
      ] as const) {
        const body: Record<string, unknown> = { reason: 'Attempt.' };
        if (value !== undefined) body.expectedVersion = value;
        const response = await returnToService(asset.id, body);
        assert.equal(response.status, 400, `${label} must be refused`);
        assert.equal(response.body.error.code, 'VALIDATION_ERROR');
        assert.equal(response.body.error.details[0].field, 'expectedVersion');
      }

      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state_version, 2);
    });

    it('15. rejects every authority / spoof key with its own explanation', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await park(asset.id);

      const spoofed: Record<string, unknown> = {
        state: 'IN_SERVICE',
        operationalState: 'IN_SERVICE',
        toState: 'IN_SERVICE',
        fromState: 'ISOLATED',
        version: 99,
        operationalStateVersion: 99,
        changedByUserId: randomUUID(),
        changedAt: '2020-01-01T00:00:00.000Z',
        approvedByUserId: randomUUID(),
        approvedAt: '2020-01-01T00:00:00.000Z',
        approvalMode: 'TWO_PERSON',
        reviewerUserId: randomUUID(),
        approverUserId: randomUUID(),
        approvalStatus: 'APPROVED',
        safetyRiskGate: 'CLEAR',
        assetId: randomUUID(),
        clientId: randomUUID(),
        buildingId: randomUUID(),
        status: 'ACTIVE',
        assetStatus: 'ACTIVE',
        previousStatus: 'INACTIVE',
        equipmentStatus: 'ACTIVE',
        failureStatus: 'RESOLVED',
        operationalImpact: 'NONE',
        incidentId: randomUUID(),
      };

      for (const key of Object.keys(spoofed)) {
        const response = await returnToService(asset.id, {
          reason: 'Spoof attempt.',
          expectedVersion: 2,
          [key]: spoofed[key],
        });
        assert.equal(response.status, 400, `${key} must be refused`);
        assert.equal(response.body.error.code, 'VALIDATION_ERROR');
        assert.equal(response.body.error.details[0].field, key);
        assert.ok(
          String(response.body.error.details[0].message).length > 0,
          `${key} must be explained`,
        );
      }

      // The approval identity is never client-supplied: the row still holds the
      // PART-02 actor and the state is untouched.
      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state, 'OUT_OF_SERVICE');
      assert.equal(persisted.operational_state_version, 2);
      assert.equal(persisted.operational_state_changed_by_user_id, adminUserId);
    });

    it('16. rejects an unknown key instead of ignoring it', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await park(asset.id);

      const response = await returnToService(asset.id, {
        reason: 'With a stray key.',
        expectedVersion: 2,
        qrCode: 'QR123',
      });

      assert.equal(response.status, 400);
      assert.equal(response.body.error.details[0].field, 'qrCode');
      assert.match(
        String(response.body.error.details[0].message),
        /not accepted by this command/,
      );
    });
  });

  describe('17-22. authority and Building scope', () => {
    it('17. authorizes the return with the dedicated permission', async (t) => {
      if (!ready(t)) return;

      const { building } = await structure();
      const clerk = await sessionWith([READ_PERMISSION, RETURN_PERMISSION]);
      await buildingAssignmentService.createAssignment(clerk.userId, {
        buildingId: building.id,
      });

      const asset = await createAsset(building.id);
      const parked = await park(asset.id, 'OUT_OF_SERVICE', 'Parked.', adminToken);

      const response = await returnToService(
        asset.id,
        { reason: 'Cleared.', expectedVersion: parked.version },
        clerk.token,
      );

      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.operationalState, 'IN_SERVICE');
      // The executing actor IS the recorded authorizing user.
      assert.equal(response.body.data.changedByUserId, clerk.userId);
      const event = (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE'))[0]!;
      assert.equal(event.actor_user_id, clerk.userId);
      assert.equal(
        (event.metadata as { approvedByUserId: string }).approvedByUserId,
        clerk.userId,
      );
    });

    for (const [label, permissions] of [
      ['asset_operational_state.manage', [READ_PERMISSION, MANAGE_PERMISSION]],
      ['asset.manage', [READ_PERMISSION, ASSET_MANAGE_PERMISSION]],
      ['asset_failure.report', [READ_PERMISSION, FAILURE_REPORT_PERMISSION]],
      ['asset_failure.manage', [READ_PERMISSION, FAILURE_MANAGE_PERMISSION]],
    ] as const) {
      it(`18-21. ${label} alone does not authorize the return`, async (t) => {
        if (!ready(t)) return;

        const { building } = await structure();
        const operator = await sessionWith([...permissions]);
        await buildingAssignmentService.createAssignment(operator.userId, {
          buildingId: building.id,
        });
        const asset = await createAsset(building.id);
        const parked = await park(asset.id, 'ISOLATED', 'Parked.');
        const before = await row(asset.id);

        const response = await returnToService(
          asset.id,
          { reason: 'Unauthorized attempt.', expectedVersion: parked.version },
          operator.token,
        );

        assert.equal(response.status, 403, label);
        assert.equal(response.body.error.code, 'PERMISSION_DENIED');
        assert.deepEqual(await row(asset.id), before);
        assert.equal(
          (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE')).length,
          0,
        );
      });
    }

    it('22. denies a caller without access to the Asset Building', async (t) => {
      if (!ready(t)) return;

      const { building: other } = await structure();
      const outsider = await sessionWith([READ_PERMISSION, RETURN_PERMISSION]);
      await buildingAssignmentService.createAssignment(outsider.userId, {
        buildingId: other.id,
      });

      const { asset } = await fixture();
      const parked = await park(asset.id, 'SHUT_DOWN', 'Parked.');
      const before = await row(asset.id);

      const response = await returnToService(
        asset.id,
        { reason: 'Cross-building attempt.', expectedVersion: parked.version },
        outsider.token,
      );

      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
      assert.deepEqual(await row(asset.id), before);
    });

    it('requires authentication before anything else', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const response = await api()
        .post(`/api/v1/assets/${asset.id}/operational-state/return-to-service`)
        .send({ reason: 'Anonymous.', expectedVersion: 1 });

      assert.equal(response.status, 401);
    });

    it('returns 404 for an unknown asset before evaluating access', async (t) => {
      if (!ready(t)) return;

      const response = await returnToService(randomUUID(), {
        reason: 'Unknown asset.',
        expectedVersion: 1,
      });

      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
    });
  });

  describe('23-31. the safety-risk clearance gate', () => {
    it('23/25/26/27. one unresolved SAFETY_RISK failure blocks, with an exact count and no leaked details', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const parked = await park(asset.id);
      const failure = await createFailure(building.id, asset.id, {
        title: 'Burned cable insulation in the control panel',
        operationalImpact: 'SAFETY_RISK',
        description: 'Smoke smell reported by the night shift.',
      });
      const before = await row(asset.id);

      const response = await returnToService(asset.id, {
        reason: 'Attempting to clear a hazard that is still open.',
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 409);
      assert.equal(
        response.body.error.code,
        'ASSET_OPERATIONAL_STATE_UNRESOLVED_SAFETY_RISK',
      );
      assert.equal(response.body.error.conflict.blockingCount, 1);
      assert.deepEqual(response.body.error.conflict.guidance, {
        action: 'resolve_asset_failures',
        resource: 'asset-failures',
        operation: 'PATCH /asset-failures/{incidentId}',
        permission: 'asset_failure.manage',
      });

      // 27 — only a count and a canonical path; never the records themselves.
      const serialized = JSON.stringify(response.body);
      for (const leaked of [
        failure.id,
        'Burned cable insulation in the control panel',
        'Smoke smell reported by the night shift.',
        'MECHANICAL_FAILURE',
      ]) {
        assert.equal(
          serialized.includes(leaked),
          false,
          `the gate must not leak ${leaked}`,
        );
      }

      // Nothing was written: the failure still blocks, the state is unchanged.
      assert.deepEqual(await row(asset.id), before);
      assert.equal((await failureRow(failure.id)).failure_status, 'OPEN');
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE')).length,
        0,
      );
    });

    it('24. counts every unresolved SAFETY_RISK failure on the same asset', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const parked = await park(asset.id);
      const first = await createFailure(building.id, asset.id, {
        operationalImpact: 'SAFETY_RISK',
      });
      await createFailure(building.id, asset.id, {
        operationalImpact: 'SAFETY_RISK',
      });
      const other = await createFailure(building.id, asset.id, {
        operationalImpact: 'SAFETY_RISK',
      });
      // The third one is resolved: it must not be counted.
      await setFailureStatus(other.id, 'RESOLVED');

      const response = await returnToService(asset.id, {
        reason: 'Two hazards still open.',
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.conflict.blockingCount, 2);
      assert.equal((await failureRow(first.id)).failure_status, 'OPEN');
    });

    it('28. allows the return once the SAFETY_RISK failure is resolved', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const parked = await park(asset.id);
      const failure = await createFailure(building.id, asset.id, {
        operationalImpact: 'SAFETY_RISK',
      });
      await setFailureStatus(failure.id, 'IN_PROGRESS');
      await setFailureStatus(failure.id, 'RESOLVED');

      const response = await returnToService(asset.id, {
        reason: 'Hazard repaired and verified.',
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.operationalState, 'IN_SERVICE');
      // Resolving the hazard is the operator's act: the command did not do it,
      // and the record keeps its resolved status.
      assert.equal((await failureRow(failure.id)).failure_status, 'RESOLVED');
    });

    it('29. blocks again when a resolved SAFETY_RISK failure is reopened', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const parked = await park(asset.id);
      const failure = await createFailure(building.id, asset.id, {
        operationalImpact: 'SAFETY_RISK',
      });
      await setFailureStatus(failure.id, 'RESOLVED');
      // Canonical reopen: RESOLVED → IN_PROGRESS.
      await setFailureStatus(failure.id, 'IN_PROGRESS');

      const response = await returnToService(asset.id, {
        reason: 'Reopened hazard.',
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 409);
      assert.equal(
        response.body.error.code,
        'ASSET_OPERATIONAL_STATE_UNRESOLVED_SAFETY_RISK',
      );
      assert.equal(response.body.error.conflict.blockingCount, 1);
    });

    it('30. a non-SAFETY_RISK failure never blocks the return', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const parked = await park(asset.id);
      for (const impact of ['NONE', 'DEGRADED', 'PARTIAL_OUTAGE', 'FULL_OUTAGE']) {
        await createFailure(building.id, asset.id, { operationalImpact: impact });
      }
      // Even an OPEN failure with no impact recorded is not a safety risk.
      await createFailure(building.id, asset.id);

      const response = await returnToService(asset.id, {
        reason: 'No safety risk recorded.',
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 200, JSON.stringify(response.body));
    });

    it('blocks only on failures of the SAME asset', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const neighbour = await createAsset(building.id);
      const parked = await park(asset.id);
      await createFailure(building.id, neighbour.id, {
        operationalImpact: 'SAFETY_RISK',
      });

      const response = await returnToService(asset.id, {
        reason: "Another asset's hazard is not this asset's gate.",
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 200, JSON.stringify(response.body));
    });

    it('31. allows the return when the asset has no failure history at all', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'OUT_OF_SERVICE');

      const response = await returnToService(asset.id, {
        reason: 'No failures were ever recorded.',
        expectedVersion: parked.version,
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.data.operationalState, 'IN_SERVICE');
    });
  });

  describe('32-37. the command has no side effects on the other axes', () => {
    it('32. a blocked return does not mutate the Asset Failure', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const parked = await park(asset.id);
      const failure = await createFailure(building.id, asset.id, {
        operationalImpact: 'SAFETY_RISK',
      });
      const before = await failureRow(failure.id);

      const response = await returnToService(asset.id, {
        reason: 'Blocked.',
        expectedVersion: parked.version,
      });
      assert.equal(response.status, 409);

      assert.deepEqual(await failureRow(failure.id), before);
    });

    it('33. a successful return leaves every failure record exactly as it was', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const parked = await park(asset.id);
      const open = await createFailure(building.id, asset.id, {
        operationalImpact: 'FULL_OUTAGE',
      });
      const resolved = await createFailure(building.id, asset.id, {
        operationalImpact: 'SAFETY_RISK',
      });
      await setFailureStatus(resolved.id, 'RESOLVED');
      const beforeOpen = await failureRow(open.id);
      const beforeResolved = await failureRow(resolved.id);
      const countBefore = await pool!.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM asset_failure_incidents',
      );

      const response = await returnToService(asset.id, {
        reason: 'Hazards cleared by the operator, not by this command.',
        expectedVersion: parked.version,
      });
      assert.equal(response.status, 200);

      // No auto-resolution, no re-opening, no new record.
      assert.deepEqual(await failureRow(open.id), beforeOpen);
      assert.deepEqual(await failureRow(resolved.id), beforeResolved);
      const countAfter = await pool!.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM asset_failure_incidents',
      );
      assert.equal(countAfter.rows[0]!.total, countBefore.rows[0]!.total);
    });

    it('34. never changes the master lifecycle status', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'SHUT_DOWN');
      const before = await row(asset.id);

      const response = await returnToService(asset.id, {
        reason: 'Back in service; lifecycle is a different axis.',
        expectedVersion: parked.version,
      });
      assert.equal(response.status, 200);

      const after = await row(asset.id);
      assert.equal(after.status, before.status);
      assert.equal(after.status, 'ACTIVE');
      assert.equal(after.previous_status, before.previous_status);
      assert.equal(after.status_changed_at, before.status_changed_at);
      assert.equal(after.status_reason, before.status_reason);
      // The response reports the lifecycle too, unchanged.
      assert.equal(response.body.data.assetStatus, 'ACTIVE');
    });

    it('35. never changes the equipment profile status', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const profile = await equipmentProfileService.createEquipmentProfile({
        assetId: asset.id,
        equipmentCode: `EQ_${suffix()}`,
        equipmentName: 'Chiller Profile',
      });
      const parked = await park(asset.id);

      const response = await returnToService(asset.id, {
        reason: 'Returning does not re-commission equipment records.',
        expectedVersion: parked.version,
      });
      assert.equal(response.status, 200);

      const stored = await pool!.query<{
        status: string;
        updated_at: Date;
      }>('SELECT status, updated_at FROM equipment_profiles WHERE id = $1', [
        profile.id,
      ]);
      assert.equal(stored.rows[0]?.status, 'ACTIVE');
      assert.equal(stored.rows[0]?.status, profile.status);

      // PART 03 added no operational-state axis to the equipment profile.
      const columns = await pool!.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'equipment_profiles'`,
      );
      assert.equal(
        columns.rows.some((entry) => entry.column_name.startsWith('operational')),
        false,
      );
    });

    it('36-37. never creates or mutates a Work Order or a Finding', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id);
      const workOrdersBefore = await tableDigest('work_orders');
      const findingsBefore = await tableDigest('findings');

      const response = await returnToService(asset.id, {
        reason: 'No follow-up work is created by returning to service.',
        expectedVersion: parked.version,
      });
      assert.equal(response.status, 200);

      assert.equal(await tableDigest('work_orders'), workOrdersBefore);
      assert.equal(await tableDigest('findings'), findingsBefore);
    });
  });

  describe('38-42. compare-and-set and replay', () => {
    it('38-39. refuses a stale version with the exact PART 02 reload guidance', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'OUT_OF_SERVICE');
      assert.equal(parked.version, 2);
      const before = await row(asset.id);

      // The caller read version 1 (IN_SERVICE) and the world moved on.
      const response = await returnToService(asset.id, {
        reason: 'Acting on a stale read.',
        expectedVersion: 1,
      });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'ASSET_OPERATIONAL_STATE_CONFLICT');
      assert.deepEqual(response.body.error.conflict, {
        code: 'ASSET_OPERATIONAL_STATE_CONFLICT',
        expectedVersion: 1,
        current: { operationalState: 'OUT_OF_SERVICE', version: 2 },
        guidance: {
          action: 'reload',
          reloadEndpoint: 'getAssetOperationalState',
        },
      });
      assert.deepEqual(await row(asset.id), before);
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE')).length,
        0,
      );

      // Reloading is enough: the corrected version succeeds.
      const retried = await returnToService(asset.id, {
        reason: 'Retrying after reload.',
        expectedVersion: 2,
      });
      assert.equal(retried.status, 200);
      assert.equal(retried.body.data.version, 3);
    });

    it('40. increments the version exactly once, in the same write', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'ISOLATED');

      const response = await returnToService(asset.id, {
        reason: 'Single increment.',
        expectedVersion: parked.version,
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.version, parked.version + 1);

      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state_version, parked.version + 1);
      // The read model and the row agree — the version is not derived twice.
      const read = await getState(asset.id);
      assert.equal(read.body.data.version, persisted.operational_state_version);

      const events = await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE');
      assert.equal(events.length, 1);
      assert.equal(
        (events[0]!.metadata as { version: number }).version,
        persisted.operational_state_version,
      );
    });

    it('41-42. a replayed request can never perform a second transition', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'SHUT_DOWN');
      const oldVersion = parked.version;

      const first = await returnToService(asset.id, {
        reason: 'First and only return.',
        expectedVersion: oldVersion,
      });
      assert.equal(first.status, 200);
      const afterFirst = await row(asset.id);

      // The SAME request, byte for byte — the classic duplicate.
      const replay = await returnToService(asset.id, {
        reason: 'First and only return.',
        expectedVersion: oldVersion,
      });
      assert.equal(replay.status, 409);
      assert.equal(
        replay.body.error.code,
        'ASSET_OPERATIONAL_STATE_ALREADY_IN_SERVICE',
      );

      // A caller that reloads and tries again meets the same terminal answer.
      const retry = await returnToService(asset.id, {
        reason: 'Trying again after reload.',
        expectedVersion: afterFirst.operational_state_version,
      });
      assert.equal(retry.status, 409);
      assert.equal(
        retry.body.error.code,
        'ASSET_OPERATIONAL_STATE_ALREADY_IN_SERVICE',
      );

      // Exactly one mutation, exactly one audit entry, no second version bump.
      assert.deepEqual(await row(asset.id), afterFirst);
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE')).length,
        1,
      );
    });
  });

  describe('43-46. actor, timing and reason are server-derived facts', () => {
    it('43/44/45. persists the session actor, a server timestamp and the trimmed reason', async (t) => {
      if (!ready(t)) return;

      const { building } = await structure();
      const clerk = await sessionWith([READ_PERMISSION, RETURN_PERMISSION]);
      await buildingAssignmentService.createAssignment(clerk.userId, {
        buildingId: building.id,
      });
      const asset = await createAsset(building.id);
      const parked = await park(asset.id, 'OUT_OF_SERVICE', 'Parked.', adminToken);
      const before = Date.now();

      const response = await returnToService(
        asset.id,
        {
          reason: '   Hazard cleared; guard reinstalled.   ',
          expectedVersion: parked.version,
        },
        clerk.token,
      );
      assert.equal(response.status, 200);
      const after = Date.now();

      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state_changed_by_user_id, clerk.userId);
      assert.equal(
        persisted.operational_state_reason,
        'Hazard cleared; guard reinstalled.',
      );
      assert.ok(persisted.operational_state_changed_at);
      const changedAt = persisted.operational_state_changed_at!.getTime();
      assert.ok(changedAt >= before - 1000 && changedAt <= after + 1000);
      assert.equal(
        response.body.data.changedAt,
        persisted.operational_state_changed_at!.toISOString(),
      );
      // The actor is the session user, not the caller who parked the asset.
      assert.notEqual(clerk.userId, adminUserId);
    });

    it('46. never accepts an approver or reviewer identity from the body', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id);
      const impostor = randomUUID();

      for (const key of [
        'approvedByUserId',
        'reviewerUserId',
        'approverUserId',
        'approvalStatus',
        'approvalMode',
        'approvedAt',
      ]) {
        const response = await returnToService(asset.id, {
          reason: 'Reviewer spoof.',
          expectedVersion: parked.version,
          [key]: key === 'approvedAt' ? '2020-01-01T00:00:00.000Z' : impostor,
        });
        assert.equal(response.status, 400, key);
        assert.equal(response.body.error.details[0].field, key);
      }

      // The real command records the ACTOR as the authorizing user.
      const accepted = await returnToService(asset.id, {
        reason: 'Authorized by the actor.',
        expectedVersion: parked.version,
      });
      assert.equal(accepted.status, 200);

      const event = (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE'))[0]!;
      const metadata = event.metadata as Record<string, unknown>;
      assert.equal(metadata.approvedByUserId, adminUserId);
      assert.notEqual(metadata.approvedByUserId, impostor);
      assert.equal(metadata.approvalMode, 'DIRECT_PRIVILEGED_COMMAND');
    });
  });

  describe('47-50. the audit entry is authoritative and transactional', () => {
    it('47/48/49. writes exactly one ASSET_RETURNED_TO_SERVICE event with the approval facts', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'OUT_OF_SERVICE', 'Leaking valve.');
      const operationalEventsBefore = (
        await historyEvents(asset.id, 'ASSET_OPERATIONAL_STATE_CHANGED')
      ).length;

      const response = await returnToService(asset.id, {
        reason: 'Valve replaced and pressure-tested.',
        expectedVersion: parked.version,
      });
      assert.equal(response.status, 200);

      const events = await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE');
      assert.equal(events.length, 1);
      const event = events[0]!;
      const persisted = await row(asset.id);

      assert.equal(event.actor_user_id, adminUserId);
      assert.match(event.summary, /returned to service from OUT_OF_SERVICE/);
      assert.deepEqual(event.metadata, {
        fromState: 'OUT_OF_SERVICE',
        toState: 'IN_SERVICE',
        reason: 'Valve replaced and pressure-tested.',
        version: persisted.operational_state_version,
        assetStatus: 'ACTIVE',
        approvalMode: 'DIRECT_PRIVILEGED_COMMAND',
        approvedByUserId: adminUserId,
        approvedAt: persisted.operational_state_changed_at!.toISOString(),
        safetyRiskGate: 'CLEAR',
      });

      // It is the EXISTING append-only Asset history, not a parallel engine.
      const history = await historyRead(asset.id);
      assert.equal(history.status, 200);
      const entry = history.body.data.find(
        (item: { eventType: string }) =>
          item.eventType === 'ASSET_RETURNED_TO_SERVICE',
      );
      assert.ok(entry, 'the event must be readable through BE-05I');
      assert.equal(entry.actorUserId, adminUserId);

      // PART 01/02 history is untouched: the operational transition that parked
      // the asset is still exactly one event of its own type.
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_OPERATIONAL_STATE_CHANGED'))
          .length,
        operationalEventsBefore,
      );
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_STATUS_CHANGED')).length,
        0,
      );
    });

    it('50. rolls the state change back when the audit row cannot be written', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const parked = await park(asset.id, 'ISOLATED', 'Locked out.');
      const before = await row(asset.id);

      // The exact precedent from the Asset history suite: make the history
      // table unavailable, then exercise a command whose audit is fail-loud.
      await pool!.query('ALTER TABLE asset_history_events RENAME TO tmp_history');
      let status = 0;
      try {
        const response = await returnToService(asset.id, {
          reason: 'This must not half-apply.',
          expectedVersion: parked.version,
        });
        status = response.status;
      } finally {
        await pool!.query(
          'ALTER TABLE tmp_history RENAME TO asset_history_events',
        );
      }

      assert.ok(
        status >= 500,
        `the request must fail when its audit entry cannot be written (got ${status})`,
      );

      // The state change rolled back with it: no version bump, no reason, no
      // actor, no timestamp — the four facts are all-or-nothing.
      assert.deepEqual(await row(asset.id), before);
      assert.equal((await row(asset.id)).operational_state, 'ISOLATED');
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_RETURNED_TO_SERVICE')).length,
        0,
      );

      // And the command still works once the audit path is healthy again.
      const retried = await returnToService(asset.id, {
        reason: 'Audit restored.',
        expectedVersion: parked.version,
      });
      assert.equal(retried.status, 200);
      assert.equal(retried.body.data.operationalState, 'IN_SERVICE');
    });
  });

  describe('51-54. the contract boundary stays closed', () => {
    it('51. exposes no mobile return-to-service route', () => {
      const forbidden = /return[-_ ]?to[-_ ]?service|restore|reactivate/i;
      const routes = registeredRoutes();

      // The governed command is registered exactly once, and it is NOT mobile.
      assert.deepEqual(
        routes.filter((route) => route.includes('return-to-service')).sort(),
        ['POST /assets/:assetId/operational-state/return-to-service'],
      );
      assert.equal(
        routes.some((route) => route.startsWith('POST /mobile/') && forbidden.test(route)),
        false,
      );
      for (const route of routes) {
        if (!/asset|equipment/.test(route)) continue;
        if (route === 'POST /assets/:assetId/operational-state/return-to-service') {
          continue;
        }
        assert.equal(
          forbidden.test(route),
          false,
          `${route} must not exist: return to service is one governed command`,
        );
      }
    });

    it('52. issues no RETURN_TO_SERVICE mobile availableAction token', async (t) => {
      const operationalStateExports = Object.keys(
        await import('../src/modules/asset-operational-state'),
      );
      assert.equal(
        operationalStateExports.some((name) => /ACTION/i.test(name)),
        false,
      );

      if (!ready(t)) return;

      const { building } = await structure();
      const asset = await createAsset(building.id);
      await park(asset.id, 'OUT_OF_SERVICE');

      const qr = `QR${suffix()}`;
      await pool!.query(
        `INSERT INTO asset_identifiers
           (id, asset_id, identifier_type, identifier_value, status)
         VALUES ($1, $2, 'QR', $3, 'ACTIVE')`,
        [randomUUID(), asset.id, qr],
      );

      const resolution = await resolveMobileQr(qr, adminUserId);
      assert.deepEqual(resolution.available.actions, [
        'VIEW_DETAILS',
        'START_FINDING',
      ]);
      const serialized = JSON.stringify(resolution);
      for (const token of ['RETURN_TO_SERVICE', 'IN_SERVICE', 'return-to-service']) {
        assert.equal(
          serialized.includes(token),
          false,
          `mobile resolution must not advertise ${token}`,
        );
      }
    });

    it('53. added no operational-state axis to equipment_profiles', () => {
      // The command's only persisted effects are the four Asset columns PART 02
      // owns; no equipment-side state machine was introduced with it.
      const sources = [
        resolve(__dirname, '../src/modules/equipment-profiles'),
        resolve(__dirname, '../src/modules/asset-operational-state'),
      ];
      for (const dir of sources) {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.types.ts')) continue;
          const src = readFileSync(join(dir, name), 'utf8');
          if (dir.endsWith('equipment-profiles')) {
            assert.equal(
              /operational_state|operationalState/.test(src),
              false,
              `${name} must not carry an operational-state axis`,
            );
          }
        }
      }
    });

    it('introduces no Idempotency-Key contract', () => {
      const operation = spec.paths[RETURN_PATH].post;
      // The command carries NO idempotency header: its duplicate protection is
      // the expectedVersion CAS plus the deterministic already-in-service
      // answer, and neither the request schema nor the parameters describe an
      // idempotency token.
      assert.deepEqual(operation.parameters, [
        { $ref: '#/components/parameters/AssetIdPath' },
      ]);
      const request = spec.components.schemas.ReturnAssetToServiceRequest;
      assert.deepEqual(Object.keys(request.properties).sort(), [
        'expectedVersion',
        'reason',
      ]);
      // No header, parameter or body member carries such a token (the prose
      // that documents its absence is not a contract).
      assert.equal(
        (operation.parameters ?? []).some((parameter: any) =>
          /idempotenc/i.test(JSON.stringify(parameter)),
        ),
        false,
      );
      assert.equal(
        Object.keys(request.properties).some((key) => /idempotenc/i.test(key)),
        false,
      );

      // The replay answer is documented instead.
      assert.match(
        `${operation.description} ${operation.responses['409'].description}`,
        /ALREADY_IN_SERVICE/,
      );
      assert.match(operation.description, /NO IDEMPOTENCY KEY/);
    });

    it('54. widened no evidence contract', () => {
      // The evidence parent kinds are unchanged: no asset / operational-state
      // parent was added for this command.
      for (const kind of MOBILE_EVIDENCE_EXECUTION_TYPES) {
        assert.equal(
          /ASSET|OPERATIONAL|RETURN|SERVICE/.test(kind),
          false,
          `${kind} must not be an evidence parent`,
        );
      }
      const request = spec.components.schemas.ReturnAssetToServiceRequest;
      assert.equal('evidence' in request.properties, false);
      assert.equal('evidenceIds' in request.properties, false);
    });
  });

  describe('55-63. the OpenAPI contract of the command', () => {
    it('55-58. documents the POST as a strict two-field command', () => {
      const path = spec.paths[RETURN_PATH];
      assert.ok(path, `${RETURN_PATH} must be documented`);
      const operation = path.post;

      assert.equal(operation.operationId, 'returnAssetToService'); // 56
      assert.deepEqual(operation.security, [{ bearerAuth: [] }]);

      const request = spec.components.schemas.ReturnAssetToServiceRequest;
      assert.deepEqual(request.required, ['reason', 'expectedVersion']); // 58
      assert.equal(request.additionalProperties, false); // 57
      assert.equal(request.properties.reason.type, 'string');
      assert.equal(request.properties.reason.maxLength, 1000);
      assert.equal(request.properties.expectedVersion.type, 'integer');
      assert.equal(request.properties.expectedVersion.minimum, 1);
      // No state member: the target is the command, never caller input.
      assert.equal('state' in request.properties, false);
      assert.equal('operationalState' in request.properties, false);

      assert.equal(
        operation.requestBody.content['application/json'].schema.$ref,
        '#/components/schemas/ReturnAssetToServiceRequest',
      ); // 55
    });

    it('59-60. names the exact permission and the Building scope', () => {
      const operation = spec.paths[RETURN_PATH].post;
      const description = `${operation.description} ${operation.summary}`;
      assert.match(description, /`asset_operational_state\.return_to_service`/);
      assert.match(description, /Building access/);
      // The insufficient authorities are called out rather than implied.
      for (const code of [
        'asset_operational_state.manage',
        'asset.manage',
        'asset_failure.report',
        'asset_failure.manage',
      ]) {
        assert.match(description, new RegExp(code.replace('.', '\\.')));
      }
      assert.match(description, /DIRECT_PRIVILEGED_COMMAND/);
    });

    it('61-62. documents the canonical response and every deterministic refusal', () => {
      const operation = spec.paths[RETURN_PATH].post;
      assert.equal(
        operation.responses['200'].content['application/json'].schema.allOf[1]
          .properties.data.$ref,
        '#/components/schemas/AssetOperationalStateView',
      ); // 61

      const described = JSON.stringify(operation);
      for (const code of [
        'ASSET_OPERATIONAL_STATE_ALREADY_IN_SERVICE', // 62
        'ASSET_OPERATIONAL_STATE_RETIRED',
        'ASSET_OPERATIONAL_STATE_UNRESOLVED_SAFETY_RISK',
        'ASSET_OPERATIONAL_STATE_CONFLICT',
        'ASSET_NOT_FOUND',
        'BUILDING_ACCESS_DENIED',
      ]) {
        assert.ok(described.includes(code), `${code} must be documented`);
      }
      assert.match(operation.description, /blockingCount/);

      // The generic PATCH is documented as still unable to target IN_SERVICE.
      const patch = spec.paths[STATE_PATH].patch;
      assert.match(patch.description, /IN_SERVICE/);
      assert.match(patch.description, /return-to-service/);
      assert.match(patch.description, /400/);
    });

    it('63. resolves every $ref introduced by the operation', () => {
      const refs: string[] = [];
      JSON.stringify(spec.paths[RETURN_PATH], (_key, value) => {
        if (_key === '$ref') refs.push(value as string);
        return value;
      });
      assert.ok(refs.length > 0);
      for (const ref of new Set(refs)) {
        let cursor: any = spec;
        for (const part of ref.replace(/^#\//, '').split('/')) {
          cursor = cursor?.[part];
        }
        assert.ok(cursor, `${ref} must resolve`);
      }
    });

    it('publishes no mobile return-to-service operation', () => {
      for (const [path, operations] of Object.entries(spec.paths)) {
        if (!path.startsWith('/mobile/')) continue;
        for (const operation of Object.values(
          operations as Record<string, any>,
        )) {
          assert.equal(
            /return[-_ ]?to[-_ ]?service/i.test(String(operation.operationId)),
            false,
            `${path} must not be a mobile return-to-service command`,
          );
        }
      }
    });
  });
});
