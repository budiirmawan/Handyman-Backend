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
  ASSET_OPERATIONAL_STATES,
  ASSET_OPERATIONAL_STATE_MUTATION_TARGETS,
  ASSET_OPERATIONAL_STATE_TRANSITIONS,
  assetOperationalStateService,
} from '../src/modules/asset-operational-state';
import { assetService } from '../src/modules/assets';
import { ASSET_FAILURE_ACTIONS } from '../src/modules/asset-failures';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { equipmentProfileService } from '../src/modules/equipment-profiles';
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
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — Asset operational state.
 *
 * Proves the operational-state axis is a SECOND, INDEPENDENT axis on the
 * authoritative Asset row: its own vocabulary, its own compare-and-set
 * version, its own history event, its own dedicated management permission, and
 * no effect whatsoever on `assets.status`, `equipment_profiles.status`,
 * Findings, or Work Orders. Also proves the boundaries — no
 * RETURN_TO_SERVICE contract, no mobile mutation endpoint, no RN-10 action
 * token — are ABSENT rather than merely undiscovered.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const ROUTES_DIR = resolve(__dirname, '../src/routes');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

const READ_PERMISSION = { code: 'asset.read', name: 'Read Assets' };
const MANAGE_PERMISSION = {
  code: 'asset_operational_state.manage',
  name: 'Manage Asset Operational State',
};
const REPORT_PERMISSION = {
  code: 'asset_failure.report',
  name: 'Report Unsafe Asset Conditions',
};
const OPERATIONAL_PATH = '/assets/{assetId}/operational-state';

/** Vocabulary that must never leak into the operational-state contract. */
const FORBIDDEN_STATE_TOKENS = [
  'OUT_OF_SERVICE',
  'ISOLATED',
  'SHUT_DOWN',
] as const;

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
    finding_escalation_incidents, incidents, asset_history_events,
    asset_identifiers, assets, equipment_profiles, work_orders, findings,
    operational_events, buildings, properties, users, roles, permissions,
    clients CASCADE`);
  const admin = await sessionWith([
    READ_PERMISSION,
    MANAGE_PERMISSION,
    { code: 'asset.manage', name: 'Manage Assets' },
    { code: 'equipment_profile.manage', name: 'Manage Equipment Profiles' },
    { code: 'asset_history.read', name: 'Read Asset History' },
    REPORT_PERMISSION,
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
  const password = 'OperationalPass123';
  const user = await userService.createUser({
    email: `ops-${tag}@example.com`,
    displayName: 'Operational State User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `OPS_${tag.toUpperCase()}`,
    name: 'Operational State Role',
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
    name: 'Operational State Client',
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

async function transition(
  assetId: string,
  state: string,
  reason = 'Equipment must not be used.',
  token = adminToken,
) {
  const current = await getState(assetId, token);
  const response = await patchState(
    assetId,
    { state, reason, expectedVersion: current.body.data.version },
    token,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
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

describe('CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — asset operational state', () => {
  describe('1-2. initial state and canonical read', () => {
    it('defaults every existing asset to IN_SERVICE at version 1, unmutated', async (t) => {
      if (!ready(t)) return;

      // 1 — the migration's default, not an application-level fiction: read
      // the authoritative column straight after creation.
      const { asset } = await fixture();
      const persisted = await row(asset.id);

      assert.equal(persisted.operational_state, 'IN_SERVICE');
      assert.equal(persisted.operational_state_version, 1);
      // Never transitioned: no actor, no timestamp, no reason.
      assert.equal(persisted.operational_state_changed_at, null);
      assert.equal(persisted.operational_state_changed_by_user_id, null);
      assert.equal(persisted.operational_state_reason, null);
    });

    it('reads the canonical state, version and derived transitions', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const response = await getState(asset.id);

      assert.equal(response.status, 200);
      const data = response.body.data;
      assert.equal(data.assetId, asset.id);
      assert.equal(data.operationalState, 'IN_SERVICE');
      assert.equal(data.version, 1);
      assert.equal(data.changedAt, null);
      assert.equal(data.changedByUserId, null);
      assert.equal(data.reason, null);
      // 2 — the read is explicable: the master lifecycle is reported alongside,
      // and is a DIFFERENT axis.
      assert.equal(data.assetStatus, 'ACTIVE');
      assert.deepEqual(data.allowedTransitions, [
        'OUT_OF_SERVICE',
        'ISOLATED',
        'SHUT_DOWN',
      ]);
      // The read model is not the mobile action vocabulary.
      assert.equal('availableActions' in data, false);
    });

    it('does not widen the BE-05A asset read model', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const assetRead = await api()
        .get(`/api/v1/assets/${asset.id}`)
        .set({ Authorization: `Bearer ${adminToken}` });

      assert.equal(assetRead.status, 200);
      // The operational axis has its own read; the Asset registry response is
      // unchanged, so BE-05A consumers are untouched by PART 02.
      assert.equal('operationalState' in assetRead.body.data, false);
      assert.equal('operationalStateVersion' in assetRead.body.data, false);
    });
  });

  describe('3-6. permitted transitions', () => {
    for (const state of FORBIDDEN_STATE_TOKENS) {
      it(`allows IN_SERVICE → ${state}`, async (t) => {
        if (!ready(t)) return;

        const { asset } = await fixture();
        const data = await transition(asset.id, state);

        assert.equal(data.operationalState, state);
        assert.equal(data.version, 2);
        assert.equal(data.changedByUserId, adminUserId);
        assert.equal(data.reason, 'Equipment must not be used.');
        const persisted = await row(asset.id);
        assert.equal(persisted.operational_state, state);
        assert.equal(persisted.operational_state_version, 2);
      });
    }

    it('allows movement between DIFFERENT non-service states, in any direction', async (t) => {
      if (!ready(t)) return;

      // OUT_OF_SERVICE → ISOLATED → SHUT_DOWN → OUT_OF_SERVICE → ISOLATED.
      const { asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE');
      assert.equal((await transition(asset.id, 'ISOLATED')).operationalState, 'ISOLATED');
      assert.equal((await transition(asset.id, 'SHUT_DOWN')).operationalState, 'SHUT_DOWN');
      assert.equal((await transition(asset.id, 'OUT_OF_SERVICE')).operationalState, 'OUT_OF_SERVICE');

      const final = await transition(asset.id, 'ISOLATED');
      assert.equal(final.operationalState, 'ISOLATED');
      // Five transitions, five increments: no ordering is imposed between the
      // peers, and no path was "more severe" than another.
      assert.equal(final.version, 6);

      // The peers are rank-free in the table itself.
      assert.deepEqual(ASSET_OPERATIONAL_STATE_TRANSITIONS.OUT_OF_SERVICE, [
        'ISOLATED',
        'SHUT_DOWN',
      ]);
      assert.deepEqual(ASSET_OPERATIONAL_STATE_TRANSITIONS.ISOLATED, [
        'OUT_OF_SERVICE',
        'SHUT_DOWN',
      ]);
      assert.deepEqual(ASSET_OPERATIONAL_STATE_TRANSITIONS.SHUT_DOWN, [
        'OUT_OF_SERVICE',
        'ISOLATED',
      ]);
    });

    it('reports the other non-service states as allowed once non-service', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await transition(asset.id, 'SHUT_DOWN');
      const response = await getState(asset.id);
      assert.deepEqual(response.body.data.allowedTransitions, [
        'OUT_OF_SERVICE',
        'ISOLATED',
      ]);
    });
  });

  describe('7-8. refusals: same state, and return to service', () => {
    it('rejects a same-state write deterministically without side effects', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await transition(asset.id, 'ISOLATED');
      const before = await row(asset.id);

      const response = await patchState(asset.id, {
        state: 'ISOLATED',
        reason: 'Trying the same state again.',
        expectedVersion: before.operational_state_version,
      });

      assert.equal(response.status, 409);
      assert.equal(
        response.body.error.code,
        'ASSET_OPERATIONAL_STATE_UNCHANGED',
      );

      const after = await row(asset.id);
      assert.deepEqual(after, before);
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_OPERATIONAL_STATE_CHANGED'))
          .length,
        1,
      );
    });

    it('never accepts IN_SERVICE as a mutation target', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE');
      const before = await row(asset.id);

      // (a) The DTO refuses it outright: IN_SERVICE is not a legal target.
      const response = await patchState(asset.id, {
        state: 'IN_SERVICE',
        reason: 'Put it back in service.',
        expectedVersion: before.operational_state_version,
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.details[0].field, 'state');
      assert.match(response.body.error.details[0].message, /IN_SERVICE/);

      // (b) And the state machine refuses it too, even if the DTO is bypassed —
      // a return-to-service attempt can never succeed through this command.
      const orphaned = await fixture();
      await transition(orphaned.asset.id, 'OUT_OF_SERVICE');
      await assert.rejects(
        () =>
          assetOperationalStateService.transitionAssetOperationalState(
            orphaned.asset.id,
            {
              state: 'IN_SERVICE' as never,
              reason: 'Bypassing the DTO.',
              expectedVersion: 2,
            },
            adminUserId,
          ),
        (error: { code?: string }) => {
          assert.equal(
            error.code,
            'ASSET_OPERATIONAL_STATE_TRANSITION_NOT_ALLOWED',
          );
          return true;
        },
      );

      const after = await row(asset.id);
      assert.deepEqual(after, before);
    });

    it('keeps IN_SERVICE out of the transition table entirely', () => {
      for (const state of ASSET_OPERATIONAL_STATES) {
        assert.equal(
          ASSET_OPERATIONAL_STATE_TRANSITIONS[state].includes('IN_SERVICE'),
          false,
          `${state} must not transition to IN_SERVICE in PART 02`,
        );
      }
      assert.deepEqual(
        ASSET_OPERATIONAL_STATE_MUTATION_TARGETS,
        ['OUT_OF_SERVICE', 'ISOLATED', 'SHUT_DOWN'],
      );
    });
  });

  describe('9-10. request body is a strict allowlist', () => {
    it('requires a non-blank reason', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const current = (await getState(asset.id)).body.data.version;

      for (const payload of [
        { state: 'ISOLATED', expectedVersion: current },
        { state: 'ISOLATED', reason: '', expectedVersion: current },
        { state: 'ISOLATED', reason: '   ', expectedVersion: current },
        { state: 'ISOLATED', reason: 7, expectedVersion: current },
        { state: 'ISOLATED', reason: 'x'.repeat(1001), expectedVersion: current },
      ]) {
        const response = await patchState(asset.id, payload);
        assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.equal(
          response.body.error.details.some(
            (detail: { field: string }) => detail.field === 'reason',
          ),
          true,
        );
      }

      // Nothing was written by any of the refusals.
      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state, 'IN_SERVICE');
      assert.equal(persisted.operational_state_version, 1);
    });

    it('requires expectedVersion', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();

      for (const payload of [
        { state: 'ISOLATED', reason: 'No version.' },
        { state: 'ISOLATED', reason: 'Null version.', expectedVersion: null },
        { state: 'ISOLATED', reason: 'String version.', expectedVersion: '1' },
        { state: 'ISOLATED', reason: 'Fractional.', expectedVersion: 1.5 },
        { state: 'ISOLATED', reason: 'Zero.', expectedVersion: 0 },
      ]) {
        const response = await patchState(asset.id, payload);
        assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.equal(
          response.body.error.details.some(
            (detail: { field: string }) => detail.field === 'expectedVersion',
          ),
          true,
        );
      }

      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state_version, 1);
    });

    it('rejects unknown keys and every server-derived authority field', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const spoofed: Record<string, unknown>[] = [
        { assetId: randomUUID() },
        { clientId: randomUUID() },
        { buildingId: randomUUID() },
        { actorUserId: randomUUID() },
        { changedByUserId: randomUUID() },
        { changedAt: new Date().toISOString() },
        { version: 99 },
        { operationalStateVersion: 99 },
        { status: 'RETIRED' },
        { assetStatus: 'RETIRED' },
        { previousStatus: 'ACTIVE' },
        { equipmentStatus: 'INACTIVE' },
        { id: randomUUID() },
        { nonsense: true },
      ];

      for (const extra of spoofed) {
        const response = await patchState(asset.id, {
          state: 'ISOLATED',
          reason: 'Spoof attempt.',
          expectedVersion: 1,
          ...extra,
        });
        assert.equal(response.status, 400, JSON.stringify(response.body));
        const field = Object.keys(extra)[0]!;
        assert.equal(
          response.body.error.details.some(
            (detail: { field: string }) => detail.field === field,
          ),
          true,
          `expected ${field} to be reported as rejected`,
        );
      }

      const persisted = await row(asset.id);
      assert.equal(persisted.status, 'ACTIVE');
      assert.equal(persisted.operational_state, 'IN_SERVICE');
      assert.equal(persisted.operational_state_version, 1);
    });
  });

  describe('11-14. versioning, persisted facts and history', () => {
    it('rejects a stale version with a deterministic conflict and no overwrite', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      // The caller reads version 1...
      const stolen = await transition(asset.id, 'OUT_OF_SERVICE');
      assert.equal(stolen.version, 2);
      // ...so the first reader is now stale.
      const response = await patchState(asset.id, {
        state: 'ISOLATED',
        reason: 'Acting on a stale read.',
        expectedVersion: 1,
      });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'ASSET_OPERATIONAL_STATE_CONFLICT');
      // The conflict is diagnosable without guessing: the caller is told what
      // it expected, what is current, and how to recover.
      assert.deepEqual(response.body.error.conflict, {
        code: 'ASSET_OPERATIONAL_STATE_CONFLICT',
        expectedVersion: 1,
        current: { operationalState: 'OUT_OF_SERVICE', version: 2 },
        guidance: {
          action: 'reload',
          reloadEndpoint: 'getAssetOperationalState',
        },
      });

      const persisted = await row(asset.id);
      // The newer state was NOT silently overwritten.
      assert.equal(persisted.operational_state, 'OUT_OF_SERVICE');
      assert.equal(persisted.operational_state_version, 2);
      assert.equal(persisted.operational_state_reason, 'Equipment must not be used.');

      // Reloading is enough to proceed: the conflict is retryable.
      const retried = await patchState(asset.id, {
        state: 'ISOLATED',
        reason: 'Retrying after reload.',
        expectedVersion: 2,
      });
      assert.equal(retried.status, 200);
      assert.equal(retried.body.data.version, 3);
    });

    it('increments the version exactly once per success', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const first = await transition(asset.id, 'OUT_OF_SERVICE');
      assert.equal(first.version, 2);
      const second = await transition(asset.id, 'ISOLATED');
      assert.equal(second.version, 3);
      const third = await transition(asset.id, 'SHUT_DOWN');
      assert.equal(third.version, 4);

      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state_version, 4);

      const events = await historyEvents(
        asset.id,
        'ASSET_OPERATIONAL_STATE_CHANGED',
      );
      assert.equal(events.length, 3);
      assert.deepEqual(
        events.map((event) => (event.metadata as { version: number }).version),
        [2, 3, 4],
      );
    });

    it('persists the actor, timestamp and trimmed reason of the transition', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const before = Date.now();
      const data = await transition(
        asset.id,
        'SHUT_DOWN',
        '   Gas leak isolated at the main valve.   ',
      );

      assert.equal(data.changedByUserId, adminUserId);
      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state_changed_by_user_id, adminUserId);
      assert.equal(
        persisted.operational_state_reason,
        'Gas leak isolated at the main valve.',
      );
      assert.ok(persisted.operational_state_changed_at);
      assert.ok(persisted.operational_state_changed_at!.getTime() >= before - 1000);
      assert.equal(
        data.changedAt,
        persisted.operational_state_changed_at!.toISOString(),
      );
      assert.equal(data.reason, 'Gas leak isolated at the main valve.');
    });

    it('records the change in the existing Asset history', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await transition(asset.id, 'ISOLATED', 'Locked out the pump.');

      const events = await historyEvents(
        asset.id,
        'ASSET_OPERATIONAL_STATE_CHANGED',
      );
      assert.equal(events.length, 1);
      const event = events[0]!;
      assert.equal(event.actor_user_id, adminUserId);
      assert.deepEqual(event.metadata, {
        fromState: 'IN_SERVICE',
        toState: 'ISOLATED',
        reason: 'Locked out the pump.',
        version: 2,
        assetStatus: 'ACTIVE',
      });
      assert.match(event.summary, /IN_SERVICE to ISOLATED/);

      // It is the EXISTING append-only Asset history — readable through the
      // BE-05I surface, with no parallel audit engine.
      const history = await api()
        .get(`/api/v1/assets/${asset.id}/history`)
        .set({ Authorization: `Bearer ${adminToken}` });
      assert.equal(history.status, 200);
      const types = history.body.data.map(
        (entry: { eventType: string }) => entry.eventType,
      );
      assert.equal(types.includes('ASSET_OPERATIONAL_STATE_CHANGED'), true);

      // The lifecycle event type is untouched by an operational transition.
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_STATUS_CHANGED')).length,
        0,
      );
    });
  });

  describe('15-16. the other axes do not move', () => {
    it('never changes the master lifecycle status', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const before = await row(asset.id);

      await transition(asset.id, 'OUT_OF_SERVICE');
      await transition(asset.id, 'ISOLATED');

      const after = await row(asset.id);
      assert.equal(after.status, before.status);
      assert.equal(after.previous_status, before.previous_status);
      assert.equal(after.status_changed_at, before.status_changed_at);
      assert.equal(after.status_reason, before.status_reason);
      assert.equal(after.status, 'ACTIVE');

      // And the reverse: a lifecycle transition does not touch the operational
      // axis, so the two axes are genuinely independent.
      const operationalBefore = await row(asset.id);
      const statusChange = await api()
        .patch(`/api/v1/assets/${asset.id}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: 'UNDER_MAINTENANCE', reason: 'Planned service.' });
      assert.equal(statusChange.status, 200);

      const operationalAfter = await row(asset.id);
      assert.equal(
        operationalAfter.operational_state,
        operationalBefore.operational_state,
      );
      assert.equal(
        operationalAfter.operational_state_version,
        operationalBefore.operational_state_version,
      );
      assert.equal(operationalAfter.status, 'UNDER_MAINTENANCE');
      // Both axes hold simultaneously and legitimately disagree.
      assert.equal(operationalAfter.operational_state, 'ISOLATED');
    });

    it('never changes the equipment profile status', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const profile = await equipmentProfileService.createEquipmentProfile({
        assetId: asset.id,
        equipmentCode: `EQ_${suffix()}`,
        equipmentName: 'Chiller Profile',
      });

      await transition(asset.id, 'OUT_OF_SERVICE');
      await transition(asset.id, 'SHUT_DOWN');

      const stored = await pool!.query<{ status: string }>(
        `SELECT status FROM equipment_profiles WHERE id = $1`,
        [profile.id],
      );
      assert.equal(stored.rows[0]?.status, 'ACTIVE');
      assert.equal(
        stored.rows[0]?.status,
        profile.status,
      );

      // The operational state is not a column of the equipment profile, and the
      // equipment profile carries no operational-state axis of its own.
      const columns = await pool!.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'equipment_profiles'`,
      );
      const names = columns.rows.map((entry) => entry.column_name);
      assert.equal(
        names.some((name) => name.startsWith('operational')),
        false,
      );
    });
  });

  describe('17. master-lifecycle terminality', () => {
    it('refuses to mutate a RETIRED asset but still reads it', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE', 'Failing bearing.');

      const retired = await api()
        .patch(`/api/v1/assets/${asset.id}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: 'RETIRED', reason: 'End of life.' });
      assert.equal(retired.status, 200);

      // Reads still succeed: retirement closes mutation, not visibility.
      const read = await getState(asset.id);
      assert.equal(read.status, 200);
      assert.equal(read.body.data.operationalState, 'OUT_OF_SERVICE');
      assert.equal(read.body.data.assetStatus, 'RETIRED');
      assert.equal(read.body.data.version, 2);
      assert.deepEqual(read.body.data.allowedTransitions, []);

      // Every mutation target is refused.
      for (const state of FORBIDDEN_STATE_TOKENS) {
        const response = await patchState(asset.id, {
          state,
          reason: 'Trying to move a retired asset.',
          expectedVersion: 2,
        });
        assert.equal(response.status, 409);
        assert.equal(
          response.body.error.code,
          'ASSET_OPERATIONAL_STATE_RETIRED',
        );
      }
      // Including an attempt to return it to service.
      const revive = await patchState(asset.id, {
        state: 'IN_SERVICE',
        reason: 'Reactivating.',
        expectedVersion: 2,
      });
      assert.equal(revive.status, 400);

      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state, 'OUT_OF_SERVICE');
      assert.equal(persisted.operational_state_version, 2);
      assert.equal(persisted.status, 'RETIRED');
    });
  });

  describe('18. PART 01 separation', () => {
    it('never changes operational state when a mobile unsafe condition is reported', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await transition(asset.id, 'ISOLATED', 'Exposed wiring.');

      const before = await row(asset.id);
      const eventsBefore = (
        await historyEvents(asset.id, 'ASSET_OPERATIONAL_STATE_CHANGED')
      ).length;

      const report = await api()
        .post(`/api/v1/mobile/assets/${asset.id}/unsafe-condition`)
        .set({
          Authorization: `Bearer ${adminToken}`,
          // CR-BE-IDEMPOTENCY-CORE-01 PART 02: the command requires the
          // generic Idempotency-Key header.
          'Idempotency-Key': randomUUID(),
        })
        .send({ title: 'Water pooling under the electrical panel.' });
      assert.equal(report.status, 201);

      const after = await row(asset.id);
      // Byte-for-byte identical: the safety report records a hazard, it does
      // not decide the equipment's operational state.
      assert.deepEqual(after, before);
      assert.equal(
        (await historyEvents(asset.id, 'ASSET_OPERATIONAL_STATE_CHANGED'))
          .length,
        eventsBefore,
      );
    });
  });

  describe('19-21. authority and Building scope', () => {
    it('refuses PATCH without asset_operational_state.manage', async (t) => {
      if (!ready(t)) return;

      const { building } = await structure();
      const reader = await sessionWith([READ_PERMISSION]);
      await buildingAssignmentService.createAssignment(reader.userId, {
        buildingId: building.id,
      });
      const asset = await createAsset(building.id);

      const response = await patchState(
        asset.id,
        {
          state: 'OUT_OF_SERVICE',
          reason: 'No authority.',
          expectedVersion: 1,
        },
        reader.token,
      );

      assert.equal(response.status, 403);
      const persisted = await row(asset.id);
      assert.equal(persisted.operational_state, 'IN_SERVICE');
      assert.equal(persisted.operational_state_version, 1);

      // Reading is authorized by asset.read alone.
      const read = await getState(asset.id, reader.token);
      assert.equal(read.status, 200);
      assert.equal(read.body.data.operationalState, 'IN_SERVICE');
    });

    it('refuses an unauthenticated caller', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const response = await api().get(
        `/api/v1/assets/${asset.id}/operational-state`,
      );
      assert.equal(response.status, 401);
    });

    it('denies cross-Building read and mutation even with both permissions', async (t) => {
      if (!ready(t)) return;

      // The caller is assigned to a DIFFERENT Building than the asset's.
      const { building: other } = await structure();
      const outsider = await sessionWith([READ_PERMISSION, MANAGE_PERMISSION]);
      await buildingAssignmentService.createAssignment(outsider.userId, {
        buildingId: other.id,
      });

      const { asset } = await fixture();
      const before = await row(asset.id);

      const read = await getState(asset.id, outsider.token);
      assert.equal(read.status, 403);
      assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

      const write = await patchState(
        asset.id,
        {
          state: 'OUT_OF_SERVICE',
          reason: 'Cross-building attempt.',
          expectedVersion: 1,
        },
        outsider.token,
      );
      assert.equal(write.status, 403);
      assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');

      assert.deepEqual(await row(asset.id), before);
    });

    it('returns 404 before anything else for an unknown asset', async (t) => {
      if (!ready(t)) return;

      const unknown = randomUUID();
      const read = await getState(unknown);
      assert.equal(read.status, 404);
      assert.equal(read.body.error.code, 'ASSET_NOT_FOUND');

      const write = await patchState(unknown, {
        state: 'OUT_OF_SERVICE',
        reason: 'Unknown asset.',
        expectedVersion: 1,
      });
      assert.equal(write.status, 404);
      assert.equal(write.body.error.code, 'ASSET_NOT_FOUND');
    });
  });

  describe('22. the enum is closed at the database', () => {
    it('refuses an operational state outside the four canonical values', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      await assert.rejects(
        () =>
          pool!.query(
            `UPDATE assets SET operational_state = 'DECOMMISSIONED' WHERE id = $1`,
            [asset.id],
          ),
        /assets_operational_state_check/,
      );
      await assert.rejects(
        () =>
          pool!.query(
            `UPDATE assets SET operational_state_version = 0 WHERE id = $1`,
            [asset.id],
          ),
        /assets_operational_state_version_check/,
      );
    });
  });

  describe('23-25. the contract surface of the boundary', () => {
    it('documents and resolves both operations', () => {
      const path = spec.paths[OPERATIONAL_PATH];
      assert.ok(path, `${OPERATIONAL_PATH} must be documented`);

      // GET — read authority, Building scope, the read model.
      assert.equal(path.get.operationId, 'getAssetOperationalState');
      assert.deepEqual(path.get.security, [{ bearerAuth: [] }]);
      assert.match(path.get.description, /`asset\.read`/);
      assert.match(path.get.description, /Building access/);
      assert.equal(
        path.get.responses['200'].content['application/json'].schema.allOf[1]
          .properties.data.$ref,
        '#/components/schemas/AssetOperationalStateView',
      );

      // PATCH — dedicated management authority, explicit body, conflict codes.
      assert.equal(path.patch.operationId, 'transitionAssetOperationalState');
      assert.deepEqual(path.patch.security, [{ bearerAuth: [] }]);
      assert.match(path.patch.description, /`asset_operational_state\.manage`/);
      assert.match(path.patch.description, /Building access/);
      assert.equal(
        path.patch.requestBody.content['application/json'].schema.$ref,
        '#/components/schemas/TransitionAssetOperationalStateRequest',
      );
      for (const code of [
        'ASSET_OPERATIONAL_STATE_UNCHANGED',
        'ASSET_OPERATIONAL_STATE_TRANSITION_NOT_ALLOWED',
        'ASSET_OPERATIONAL_STATE_RETIRED',
        'ASSET_OPERATIONAL_STATE_CONFLICT',
        'ASSET_NOT_FOUND',
        'BUILDING_ACCESS_DENIED',
      ]) {
        assert.match(
          `${path.patch.description} ${path.patch.responses['409'].description}`,
          new RegExp(code),
        );
      }

      // The enum: four states, three targets, no IN_SERVICE target.
      assert.deepEqual(spec.components.schemas.AssetOperationalState.enum, [
        ...ASSET_OPERATIONAL_STATES,
      ]);
      assert.deepEqual(
        spec.components.schemas.AssetOperationalStateMutationTarget.enum,
        [...ASSET_OPERATIONAL_STATE_MUTATION_TARGETS],
      );
      const request =
        spec.components.schemas.TransitionAssetOperationalStateRequest;
      assert.deepEqual(request.required, ['state', 'reason', 'expectedVersion']);
      assert.equal(request.additionalProperties, false);

      // Every $ref under the two operations resolves.
      const refs: string[] = [];
      JSON.stringify(path, (_key, value) => {
        if (_key === '$ref') refs.push(value as string);
        return value;
      });
      for (const ref of new Set(refs)) {
        let cursor: any = spec;
        for (const part of ref.replace(/^#\//, '').split('/')) {
          cursor = cursor?.[part];
        }
        assert.ok(cursor, `${ref} must resolve`);
      }
    });

    it('publishes exactly one return-to-service contract, and only as the PART 03 command', () => {
      const forbidden = /return[-_ ]?to[-_ ]?service|restore|reactivate/i;
      const relevant = (path: string): boolean =>
        /asset|equipment/.test(path);
      // PART 03 adds the governed return-to-service command, and this test is
      // its negative space: that ONE operation exists and nothing else may.
      // (Other domains have their own, unrelated lifecycle verbs — e.g.
      // `POST /users/{userId}/reactivate` is user account administration and is
      // deliberately not this boundary.)
      const GOVERNED_PATH =
        '/assets/{assetId}/operational-state/return-to-service';
      const GOVERNED_ROUTE =
        'POST /assets/:assetId/operational-state/return-to-service';

      // Documented paths and operationIds.
      for (const [path, operations] of Object.entries(spec.paths)) {
        if (!relevant(path)) continue;
        for (const [method, operation] of Object.entries(
          operations as Record<string, any>,
        )) {
          const isGoverned =
            path === GOVERNED_PATH &&
            method === 'post' &&
            operation.operationId === 'returnAssetToService';
          if (isGoverned) continue;
          assert.equal(
            forbidden.test(String(operation.operationId)),
            false,
            `${method.toUpperCase()} ${path} must not be a return-to-service operation`,
          );
          assert.equal(
            forbidden.test(String(path)),
            false,
            `${method.toUpperCase()} ${path} must not exist`,
          );
        }
      }

      // Registered route paths.
      for (const route of registeredRoutes()) {
        if (!relevant(route)) continue;
        if (route === GOVERNED_ROUTE) continue;
        assert.equal(forbidden.test(route), false, `${route} must not exist`);
      }

      // The read model never advertises IN_SERVICE as reachable: the governed
      // command is not an edge in the PART 02 state machine.
      for (const state of ASSET_OPERATIONAL_STATES) {
        assert.equal(
          ASSET_OPERATIONAL_STATE_TRANSITIONS[state].includes('IN_SERVICE'),
          false,
        );
      }
    });

    it('exposes no mobile mutation endpoint and no RN-10 action token', async (t) => {
      // Registered route paths: the operational-state surface is exactly the
      // three canonical operations — PART 02's read and management command,
      // plus the PART 03 governed return-to-service command — and, from
      // PART 04 (CR-BE-RN10-SAFE-EQUIPMENT-01), the mobile operational-state
      // READ. The §15 reservation is now fulfilled by its owner: PART 04
      // publishes the mobile read/authority surface, and the mobile half of
      // the surface stays READ ONLY — no POST / PATCH / PUT / DELETE route
      // may exist on any mobile operational-state path. The RN-10 mutations
      // remain the two canonical /assets commands above.
      const operational = registeredRoutes().filter((route) =>
        route.includes('operational-state'),
      );
      assert.deepEqual(operational.sort(), [
        'GET /assets/:assetId/operational-state',
        'GET /mobile/assets/:assetId/operational-state',
        'PATCH /assets/:assetId/operational-state',
        'POST /assets/:assetId/operational-state/return-to-service',
      ]);
      const mobileOperational = operational.filter((route) =>
        route.includes('/mobile/'),
      );
      assert.deepEqual(mobileOperational, [
        'GET /mobile/assets/:assetId/operational-state',
      ]);
      assert.equal(
        mobileOperational.some((route) => !route.startsWith('GET ')),
        false,
        'the mobile operational-state surface is read-only',
      );
      assert.equal(
        registeredRoutes().some((route) => route.startsWith('POST /mobile/')),
        true,
        'the PART 01 mobile surface must still be registered',
      );

      // No action vocabulary exists for RN-10: the module exports none, and the
      // vocabularies mobile DOES consume carry no operational-state token.
      const operationalStateExports = Object.keys(
        await import('../src/modules/asset-operational-state'),
      );
      assert.equal(
        operationalStateExports.some((name) => /ACTION/i.test(name)),
        false,
      );
      assert.equal(
        ASSET_FAILURE_ACTIONS.some((action) =>
          /SERVICE|ISOLAT|SHUT_?DOWN/.test(action),
        ),
        false,
      );

      if (!ready(t)) return;

      // Runtime proof: resolving an Asset by QR — the mobile entry point that
      // would carry such a token — still offers only its existing read-model
      // hints, and the operational state is not one of them.
      const { building } = await structure();
      const asset = await createAsset(building.id);
      await transition(asset.id, 'OUT_OF_SERVICE');

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
      for (const token of FORBIDDEN_STATE_TOKENS) {
        assert.equal(
          JSON.stringify(resolution).includes(token),
          false,
          `mobile QR resolution must not leak ${token}`,
        );
      }
    });
  });
});
