import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import {
  ASSET_STATUS_TRANSITIONS,
  isAllowedAssetStatusTransition,
  isTerminalAssetStatus,
} from '../src/modules/assets';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05E — Asset lifecycle / status focused tests.
 *
 * Covers only the controlled lifecycle state machine
 * (ACTIVE / INACTIVE / UNDER_MAINTENANCE / RETIRED) as master state data.
 * PM, breakdown, work order, checklist, warranty, certification, QR, and the
 * full Asset History table belong to later PARTs or Waves — the final suite
 * asserts BE-05E introduced none of them.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, clients, properties, buildings, assets,
      equipment_profiles CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createBuildingFixture(options?: {
  assignUserId?: string | null;
}) {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  return { client, property, building };
}

async function createAsset(overrides?: object) {
  const fixture = await createBuildingFixture();
  const created = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/assets`)
    .set(authHeaders())
    .send({
      assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
      assetName: 'Test Asset',
      ...overrides,
    });
  assert.equal(created.status, 201);
  return { ...fixture, asset: created.body.data };
}

function changeStatus(
  assetId: string,
  status: string,
  extra?: object,
  token = adminToken,
) {
  return api()
    .patch(`/api/v1/assets/${assetId}/status`)
    .set(authHeaders(token))
    .send({ status, ...extra });
}

/** Drives an asset to a given lifecycle state through legal transitions. */
async function assetInStatus(status: string) {
  const fixture = await createAsset();
  const id = fixture.asset.id;

  if (status === 'ACTIVE') {
    return fixture;
  }
  if (status === 'INACTIVE' || status === 'UNDER_MAINTENANCE') {
    assert.equal((await changeStatus(id, status)).status, 200);
    return fixture;
  }
  if (status === 'RETIRED') {
    assert.equal((await changeStatus(id, 'RETIRED')).status, 200);
    return fixture;
  }
  throw new Error(`unsupported status ${status}`);
}

describe('lifecycle transition table', () => {
  it('defines the explicit allowed transitions', () => {
    assert.deepEqual(ASSET_STATUS_TRANSITIONS.ACTIVE, [
      'INACTIVE',
      'UNDER_MAINTENANCE',
      'RETIRED',
    ]);
    assert.deepEqual(ASSET_STATUS_TRANSITIONS.INACTIVE, ['ACTIVE', 'RETIRED']);
    assert.deepEqual(ASSET_STATUS_TRANSITIONS.UNDER_MAINTENANCE, [
      'ACTIVE',
      'INACTIVE',
    ]);
    // RETIRED is terminal: no automatic reactivation.
    assert.deepEqual(ASSET_STATUS_TRANSITIONS.RETIRED, []);
  });

  it('answers transition questions consistently', () => {
    assert.equal(isAllowedAssetStatusTransition('ACTIVE', 'INACTIVE'), true);
    assert.equal(
      isAllowedAssetStatusTransition('UNDER_MAINTENANCE', 'RETIRED'),
      false,
    );
    assert.equal(isAllowedAssetStatusTransition('RETIRED', 'ACTIVE'), false);
    assert.equal(isTerminalAssetStatus('RETIRED'), true);
    assert.equal(isTerminalAssetStatus('ACTIVE'), false);
  });
});

describe('get asset lifecycle status', () => {
  it('returns the current state and available transitions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await api()
      .get(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetId, asset.id);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.previousStatus, null);
    assert.equal(response.body.data.statusChangedAt, null);
    assert.deepEqual(response.body.data.allowedTransitions, [
      'INACTIVE',
      'UNDER_MAINTENANCE',
      'RETIRED',
    ]);
    assert.equal(response.body.data.isTerminal, false);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}/status`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('valid status transitions', () => {
  it('moves ACTIVE → INACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await changeStatus(asset.id, 'INACTIVE');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'INACTIVE');
    assert.equal(response.body.data.lifecycle.previousStatus, 'ACTIVE');
    assert.deepEqual(response.body.data.lifecycle.allowedTransitions, [
      'ACTIVE',
      'RETIRED',
    ]);
  });

  it('moves INACTIVE → ACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('INACTIVE');
    const response = await changeStatus(asset.id, 'ACTIVE');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'ACTIVE');
    assert.equal(response.body.data.lifecycle.previousStatus, 'INACTIVE');
  });

  it('moves ACTIVE → UNDER_MAINTENANCE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await changeStatus(asset.id, 'UNDER_MAINTENANCE');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'UNDER_MAINTENANCE');
    assert.deepEqual(response.body.data.lifecycle.allowedTransitions, [
      'ACTIVE',
      'INACTIVE',
    ]);
  });

  it('moves UNDER_MAINTENANCE → ACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('UNDER_MAINTENANCE');
    const response = await changeStatus(asset.id, 'ACTIVE');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'ACTIVE');
    assert.equal(
      response.body.data.lifecycle.previousStatus,
      'UNDER_MAINTENANCE',
    );
  });

  it('moves UNDER_MAINTENANCE → INACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('UNDER_MAINTENANCE');
    const response = await changeStatus(asset.id, 'INACTIVE');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'INACTIVE');
  });

  it('treats re-applying the current status as a no-op', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await changeStatus(asset.id, 'ACTIVE');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'ACTIVE');
    // No spurious transition was recorded.
    assert.equal(response.body.data.lifecycle.previousStatus, null);
  });
});

describe('registration status guard', () => {
  it('refuses to register an asset directly as RETIRED', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/assets`)
      .set(authHeaders())
      .send({
        assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
        assetName: 'Born Retired',
        status: 'RETIRED',
      });

    // A terminal starting state would create a permanently frozen asset
    // that never passed through the lifecycle.
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('refuses to register an asset directly as UNDER_MAINTENANCE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/assets`)
      .set(authHeaders())
      .send({
        assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
        assetName: 'Born In Maintenance',
        status: 'UNDER_MAINTENANCE',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('still allows registering as ACTIVE or INACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingFixture();
    for (const status of ['ACTIVE', 'INACTIVE']) {
      const response = await api()
        .post(`/api/v1/buildings/${fixture.building.id}/assets`)
        .set(authHeaders())
        .send({
          assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
          assetName: `Born ${status}`,
          status,
        });
      assert.equal(response.status, 201);
      assert.equal(response.body.data.status, status);
    }
  });
});

describe('invalid status and transitions', () => {
  it('rejects an unsupported status value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await changeStatus(asset.id, 'DISPOSED');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a missing status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders())
      .send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects INACTIVE → UNDER_MAINTENANCE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('INACTIVE');
    const response = await changeStatus(asset.id, 'UNDER_MAINTENANCE');

    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'ASSET_STATUS_TRANSITION_NOT_ALLOWED',
    );
  });

  it('rejects UNDER_MAINTENANCE → RETIRED', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('UNDER_MAINTENANCE');
    const response = await changeStatus(asset.id, 'RETIRED');

    // Retirement must be a deliberate decision from a settled state.
    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'ASSET_STATUS_TRANSITION_NOT_ALLOWED',
    );
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await changeStatus(randomUUID(), 'INACTIVE');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('retirement behavior', () => {
  it('retires an ACTIVE asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await changeStatus(asset.id, 'RETIRED', {
      reason: 'End of service life',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'RETIRED');
    assert.equal(response.body.data.lifecycle.isTerminal, true);
    assert.deepEqual(response.body.data.lifecycle.allowedTransitions, []);
    assert.equal(
      response.body.data.lifecycle.statusReason,
      'End of service life',
    );
  });

  it('retires an INACTIVE asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('INACTIVE');
    const response = await changeStatus(asset.id, 'RETIRED');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.status, 'RETIRED');
  });

  it('refuses any reactivation of a retired asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('RETIRED');

    for (const target of ['ACTIVE', 'INACTIVE', 'UNDER_MAINTENANCE']) {
      const response = await changeStatus(asset.id, target);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'ASSET_RETIRED');
    }
  });

  it('keeps the retired asset and its equipment profile readable', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const profile = await api()
      .post(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ equipmentCode: 'EQP-RET', equipmentName: 'Retiring Equipment' });
    assert.equal(profile.status, 201);

    await changeStatus(asset.id, 'RETIRED');

    // Retirement is not a delete, and it does not rewrite the BE-05D sheet.
    const readAsset = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());
    assert.equal(readAsset.status, 200);
    assert.equal(readAsset.body.data.status, 'RETIRED');

    const readProfile = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders());
    assert.equal(readProfile.status, 200);
    assert.deepEqual(readProfile.body.data, profile.body.data);
  });
});

describe('history readiness', () => {
  it('preserves previous status, timestamp, and reason on transition', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await changeStatus(asset.id, 'UNDER_MAINTENANCE', {
      reason: 'Quarterly overhaul',
    });

    assert.equal(response.status, 200);
    const lifecycle = response.body.data.lifecycle;
    assert.equal(lifecycle.previousStatus, 'ACTIVE');
    assert.equal(lifecycle.statusReason, 'Quarterly overhaul');
    assert.ok(lifecycle.statusChangedAt);
    assert.ok(!Number.isNaN(Date.parse(lifecycle.statusChangedAt)));
  });

  it('tracks the most recent transition across several moves', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    await changeStatus(asset.id, 'UNDER_MAINTENANCE', { reason: 'first' });
    await changeStatus(asset.id, 'ACTIVE', { reason: 'second' });
    const response = await changeStatus(asset.id, 'INACTIVE', {
      reason: 'third',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.lifecycle.previousStatus, 'ACTIVE');
    assert.equal(response.body.data.lifecycle.statusReason, 'third');
  });

  it('records transitions made through the general asset update too', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'INACTIVE');
    assert.equal(response.body.data.previousStatus, 'ACTIVE');
    assert.ok(response.body.data.statusChangedAt);
  });

  it('enforces the same transition rules on the general asset update', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await assetInStatus('RETIRED');
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });

    // No side door around the lifecycle table.
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ASSET_RETIRED');
  });
});

describe('lifecycle RBAC and client / building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const read = await api().get(`/api/v1/assets/${randomUUID()}/status`);
    assert.equal(read.status, 401);

    const write = await api()
      .patch(`/api/v1/assets/${randomUUID()}/status`)
      .send({ status: 'INACTIVE' });
    assert.equal(write.status, 401);
  });

  it('denies a user without asset permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { asset } = await createAsset();

    const read = await api()
      .get(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await changeStatus(
      asset.id,
      'INACTIVE',
      undefined,
      plainToken,
    );
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies lifecycle routes across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    // Full permissions, different Client, no assignment to this Building.
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await changeStatus(
      asset.id,
      'RETIRED',
      undefined,
      outsider.token,
    );
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The isolation failure must not have changed any state.
    const check = await api()
      .get(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders());
    assert.equal(check.body.data.status, 'ACTIVE');
  });
});

describe('BE-05E boundary', () => {
  it('creates no PM, breakdown, work order, checklist, warranty, certification, QR, or history tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    for (const forbidden of [
      'preventive_maintenances',
      'maintenance_plans',
      'maintenance_schedules',
      'breakdowns',
      // `work_orders` is owned by BE-08B (now present by design).
      // `checklist_executions` is owned by BE-07 (now present by design).
      'checklists',
      // `asset_warranties` is owned by BE-05F and therefore not listed here.
      'warranties',
      // `asset_certifications` is owned by BE-05G.
      'certifications',
      // `asset_identifiers` is owned by BE-05H.
      'asset_qr_codes',
      // Full Asset History is BE-05I: BE-05E only keeps the last transition
      // on the asset row itself.
      'asset_history',
      // `asset_history_events` is owned by BE-05I.
      'asset_status_transitions',
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `${forbidden} must not exist in BE-05E`,
      );
    }
  });

  it('adds only the lifecycle traceability columns to assets', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'assets'
       ORDER BY column_name`,
    );

    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'asset_category_id',
        'asset_code',
        'asset_name',
        'asset_type_id',
        'building_id',
        'client_id',
        'created_at',
        'description',
        'functional_location_id',
        'id',
        'manufacturer',
        'model',
        // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — the asset operational-state
        // axis (RN-10), a separate axis from the BE-05E lifecycle below.
        'operational_state',
        'operational_state_changed_at',
        'operational_state_changed_by_user_id',
        'operational_state_reason',
        'operational_state_version',
        'previous_status',
        'serial_number',
        'status',
        'status_changed_at',
        'status_reason',
        'updated_at',
      ],
    );
  });

  it('enforces the lifecycle domain at the database level', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    await assert.rejects(
      pool!.query(`UPDATE assets SET status = 'DISPOSED' WHERE id = $1`, [
        asset.id,
      ]),
      /assets_status_check/,
    );
  });

  it('does not touch the equipment profile when status changes', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAsset();
    await api()
      .post(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({
        equipmentCode: 'EQP-LIFECYCLE',
        equipmentName: 'Stable Equipment',
        status: 'ACTIVE',
      });

    await changeStatus(asset.id, 'UNDER_MAINTENANCE');

    const profile = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders());

    // Lifecycle is asset state only; it triggers no equipment side effects.
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.status, 'ACTIVE');
  });
});
