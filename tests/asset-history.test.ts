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
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { functionalLocationService } from '../src/modules/functional-locations';
import {
  isSensitiveMetadataKey,
  sanitizeHistoryMetadata,
} from '../src/modules/asset-history';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05I — Asset History foundation focused tests.
 *
 * Covers only the append-oriented master-data history across the BE-05
 * domains. PM, breakdown, work order, checklist execution, meter reading,
 * and finding/verification history belong to later Waves — the final suite
 * asserts BE-05I introduced none of them.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, clients, properties, buildings, floors, areas,
      rooms, spaces, functional_locations, assets, asset_categories,
      asset_types, equipment_profiles, asset_warranties,
      asset_certifications, asset_identifiers, asset_history_events CASCADE`,
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

async function createBuildingFixture() {
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
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  return { client, property, building };
}

async function createAssetFixture() {
  const fixture = await createBuildingFixture();
  const asset = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/assets`)
    .set(authHeaders())
    .send({
      assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
      assetName: 'Test Asset',
    });
  assert.equal(asset.status, 201);
  return { ...fixture, asset: asset.body.data };
}

async function history(assetId: string, query = '', token = adminToken) {
  return api()
    .get(`/api/v1/assets/${assetId}/history${query}`)
    .set(authHeaders(token));
}

function eventTypes(body: { data: { eventType: string }[] }): string[] {
  return body.data.map((event) => event.eventType);
}

describe('metadata sanitizer', () => {
  it('recognises sensitive key names', () => {
    for (const key of [
      'password',
      'passphrase',
      'secret',
      'sessionToken',
      'authorization',
      'apiKey',
      'credential',
      'cookie',
      'privateKey',
      'passwordHash',
    ]) {
      assert.equal(isSensitiveMetadataKey(key), true, key);
    }

    for (const key of ['assetCode', 'status', 'buildingId', 'from', 'to']) {
      assert.equal(isSensitiveMetadataKey(key), false, key);
    }
  });

  it('strips sensitive keys recursively', () => {
    const sanitized = sanitizeHistoryMetadata({
      assetCode: 'AST-1',
      password: 'hunter2',
      nested: {
        token: 'abc',
        keep: 'value',
        deeper: { authorization: 'Bearer xyz', ok: 1 },
      },
      list: [{ secret: 's', fine: true }],
    });

    const serialized = JSON.stringify(sanitized);
    for (const leaked of ['hunter2', 'abc', 'Bearer xyz', '"secret"']) {
      assert.equal(serialized.includes(leaked), false);
    }
    assert.equal(sanitized.assetCode, 'AST-1');
    assert.deepEqual(sanitized.nested, { keep: 'value', deeper: { ok: 1 } });
  });

  it('caps oversized strings', () => {
    const sanitized = sanitizeHistoryMetadata({ note: 'x'.repeat(5000) });
    assert.ok(String(sanitized.note).length < 600);
  });
});

describe('asset creation history', () => {
  it('records an ASSET_CREATED event with the actor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await history(asset.id);

    assert.equal(response.status, 200);
    assert.deepEqual(eventTypes(response.body), ['ASSET_CREATED']);
    const event = response.body.data[0];
    assert.equal(event.assetId, asset.id);
    assert.equal(event.actorUserId, adminUserId);
    assert.match(event.summary, /registered/);
    assert.equal(event.metadata.assetCode, asset.assetCode);
    assert.ok(event.createdAt);
  });

  it('exposes pagination metadata', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await history(asset.id);

    assert.equal(response.body.meta.total, 1);
    assert.equal(response.body.meta.limit, 50);
    assert.equal(response.body.meta.offset, 0);
  });
});

describe('asset master data and classification history', () => {
  it('records an ASSET_UPDATED event with before/after values', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const updated = await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({ assetName: 'Renamed Asset', manufacturer: 'Daikin' });
    assert.equal(updated.status, 200);

    const response = await history(asset.id, '?eventType=ASSET_UPDATED');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);

    const event = response.body.data[0];
    assert.deepEqual(event.metadata.assetName, {
      from: 'Test Asset',
      to: 'Renamed Asset',
    });
    assert.deepEqual(event.metadata.manufacturer, {
      from: null,
      to: 'Daikin',
    });
  });

  it('records a classification change as its own event', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    const category = await api()
      .post(`/api/v1/clients/${fixture.client.id}/asset-categories`)
      .set(authHeaders())
      .send({ code: 'HVAC', name: 'HVAC' });
    const type = await api()
      .post(`/api/v1/asset-categories/${category.body.data.id}/types`)
      .set(authHeaders())
      .send({ code: 'AHU', name: 'Air Handling Unit' });

    const updated = await api()
      .patch(`/api/v1/assets/${fixture.asset.id}`)
      .set(authHeaders())
      .send({
        assetCategoryId: category.body.data.id,
        assetTypeId: type.body.data.id,
      });
    assert.equal(updated.status, 200);

    const response = await history(
      fixture.asset.id,
      '?eventType=ASSET_CLASSIFICATION_CHANGED',
    );
    assert.equal(response.body.data.length, 1);
    assert.equal(
      response.body.data[0].metadata.assetCategoryId.to,
      category.body.data.id,
    );
  });
});

describe('location change history', () => {
  it('records an ASSET_LOCATION_CHANGED event on binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    const floor = await floorService.createFloor({
      buildingId: fixture.building.id,
      code: `L${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Level 1',
      levelNumber: 1,
    });
    const area = await areaService.createArea({
      floorId: floor.id,
      code: `AREA_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Zone',
    });
    const room = await roomService.createRoom({
      areaId: area.id,
      code: `ROOM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Room',
    });
    const space = await spaceService.createSpace({
      roomId: room.id,
      code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Space',
    });
    const location =
      await functionalLocationService.createFunctionalLocation({
        buildingId: fixture.building.id,
        spaceId: space.id,
        code: `FL_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Position',
      });

    const bound = await api()
      .patch(`/api/v1/assets/${fixture.asset.id}/location`)
      .set(authHeaders())
      .send({ functionalLocationId: location.id });
    assert.equal(bound.status, 200);

    const response = await history(
      fixture.asset.id,
      '?eventType=ASSET_LOCATION_CHANGED',
    );
    assert.equal(response.body.data.length, 1);
    assert.deepEqual(response.body.data[0].metadata, {
      from: null,
      to: location.id,
    });
  });
});

describe('lifecycle status history', () => {
  it('records an ASSET_STATUS_CHANGED event with the reason', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const changed = await api()
      .patch(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders())
      .send({ status: 'UNDER_MAINTENANCE', reason: 'Quarterly overhaul' });
    assert.equal(changed.status, 200);

    const response = await history(asset.id, '?eventType=ASSET_STATUS_CHANGED');
    assert.equal(response.body.data.length, 1);
    const event = response.body.data[0];
    assert.equal(event.metadata.from, 'ACTIVE');
    assert.equal(event.metadata.to, 'UNDER_MAINTENANCE');
    assert.equal(event.metadata.reason, 'Quarterly overhaul');
  });

  it('records a status change made through the general update too', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await history(asset.id, '?eventType=ASSET_STATUS_CHANGED');
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].metadata.to, 'INACTIVE');
  });
});

describe('equipment profile, warranty, certification, identifier history', () => {
  it('records equipment profile events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await api()
      .post(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ equipmentCode: 'EQP-1', equipmentName: 'Unit' });
    await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ equipmentName: 'Renamed Unit' });

    const response = await history(asset.id);
    const types = eventTypes(response.body);
    assert.ok(types.includes('EQUIPMENT_PROFILE_CREATED'));
    assert.ok(types.includes('EQUIPMENT_PROFILE_UPDATED'));
  });

  it('records warranty events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await api()
      .post(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders())
      .send({
        providerName: 'Provider',
        warrantyNumber: 'WTY-1',
        startDate: dateOffset(-10),
        endDate: dateOffset(300),
      });
    await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${created.body.data.id}`)
      .set(authHeaders())
      .send({ providerName: 'New Provider' });

    const response = await history(asset.id);
    const types = eventTypes(response.body);
    assert.ok(types.includes('WARRANTY_CREATED'));
    assert.ok(types.includes('WARRANTY_UPDATED'));
  });

  it('records certification events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await api()
      .post(`/api/v1/assets/${asset.id}/certifications`)
      .set(authHeaders())
      .send({
        certificationType: 'STATUTORY_PERMIT',
        certificateNumber: 'CERT-1',
        issuingAuthority: 'Authority',
        issueDate: dateOffset(-10),
        expiryDate: dateOffset(300),
      });
    await api()
      .patch(
        `/api/v1/assets/${asset.id}/certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ notes: 'Re-inspected' });

    const response = await history(asset.id);
    const types = eventTypes(response.body);
    assert.ok(types.includes('CERTIFICATION_CREATED'));
    assert.ok(types.includes('CERTIFICATION_UPDATED'));
  });

  it('records identifier events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await api()
      .post(`/api/v1/assets/${asset.id}/identifiers`)
      .set(authHeaders())
      .send({ identifierType: 'QR' });
    await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await history(asset.id);
    const types = eventTypes(response.body);
    assert.ok(types.includes('IDENTIFIER_CREATED'));
    assert.ok(types.includes('IDENTIFIER_UPDATED'));
    const retired = response.body.data.find(
      (event: { eventType: string }) => event.eventType === 'IDENTIFIER_UPDATED',
    );
    assert.match(retired.summary, /retired/);
  });
});

describe('chronological retrieval', () => {
  it('returns events newest first across all domains', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({ assetName: 'Second Event' });
    await api()
      .patch(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await history(asset.id);
    assert.equal(response.status, 200);
    assert.deepEqual(eventTypes(response.body), [
      'ASSET_STATUS_CHANGED',
      'ASSET_UPDATED',
      'ASSET_CREATED',
    ]);

    const timestamps = response.body.data.map((event: { createdAt: string }) =>
      Date.parse(event.createdAt),
    );
    for (let index = 1; index < timestamps.length; index += 1) {
      assert.ok(timestamps[index - 1] >= timestamps[index]);
    }
  });

  it('scopes history to the requested asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    await api()
      .patch(`/api/v1/assets/${second.asset.id}`)
      .set(authHeaders())
      .send({ assetName: 'Other Asset Changed' });

    const response = await history(first.asset.id);
    assert.deepEqual(eventTypes(response.body), ['ASSET_CREATED']);
    for (const event of response.body.data) {
      assert.equal(event.assetId, first.asset.id);
    }
  });

  it('paginates with limit and offset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({ assetName: 'Change One' });
    await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({ assetName: 'Change Two' });

    const firstPage = await history(asset.id, '?limit=2&offset=0');
    assert.equal(firstPage.body.data.length, 2);
    assert.equal(firstPage.body.meta.total, 3);

    const secondPage = await history(asset.id, '?limit=2&offset=2');
    assert.equal(secondPage.body.data.length, 1);
    assert.deepEqual(eventTypes(secondPage.body), ['ASSET_CREATED']);
  });

  it('rejects an invalid pagination or event type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();

    const badLimit = await history(asset.id, '?limit=0');
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.body.error.code, 'VALIDATION_ERROR');

    const badType = await history(asset.id, '?eventType=NOT_A_TYPE');
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await history(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('history contains no sensitive data', () => {
  it('never stores passwords, credentials, tokens, or auth headers', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();

    // Exercise every integrated domain, deliberately trying to smuggle
    // secrets in through free-text and unexpected body fields.
    await api()
      .patch(`/api/v1/assets/${asset.id}`)
      .set(authHeaders())
      .send({
        assetName: 'Audited Asset',
        password: 'hunter2',
        sessionToken: 'tok_secret_value',
        authorization: `Bearer ${adminToken}`,
      });
    await api()
      .patch(`/api/v1/assets/${asset.id}/status`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    await api()
      .post(`/api/v1/assets/${asset.id}/identifiers`)
      .set(authHeaders())
      .send({ identifierType: 'QR' });

    const rows = await pool!.query<{ metadata: unknown; summary: string }>(
      `SELECT metadata, summary FROM asset_history_events WHERE asset_id = $1`,
      [asset.id],
    );
    assert.ok(rows.rows.length >= 3);

    const serialized = JSON.stringify(rows.rows);
    for (const secret of [
      'hunter2',
      'tok_secret_value',
      adminToken,
      'Bearer ',
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `history leaked: ${secret}`,
      );
    }
    for (const key of [
      'password',
      'sessionToken',
      'authorization',
      'credential',
    ]) {
      assert.equal(serialized.includes(key), false, `history leaked key ${key}`);
    }
  });
});

describe('history RBAC and client / building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/assets/${randomUUID()}/history`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without history permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { asset } = await createAssetFixture();

    const response = await history(asset.id, '', plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies history across the client / building boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    // Full permissions, different Client, no assignment to this Building.
    const outsider = await createAdminUser();

    const response = await history(asset.id, '', outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('exposes no write endpoints for history', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();

    const create = await api()
      .post(`/api/v1/assets/${asset.id}/history`)
      .set(authHeaders())
      .send({ eventType: 'ASSET_UPDATED', summary: 'forged' });
    assert.equal(create.status, 404);

    const remove = await api()
      .delete(`/api/v1/assets/${asset.id}/history`)
      .set(authHeaders());
    assert.equal(remove.status, 404);
  });
});

describe('history resilience and boundary', () => {
  it('does not roll back the domain operation when history fails', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();

    // Break history writes, then perform a real update.
    await pool!.query('ALTER TABLE asset_history_events RENAME TO tmp_history');
    try {
      const response = await api()
        .patch(`/api/v1/assets/${asset.id}`)
        .set(authHeaders())
        .send({ assetName: 'Survives History Failure' });

      // Best-effort history: the asset change still succeeds.
      assert.equal(response.status, 200);
      assert.equal(response.body.data.assetName, 'Survives History Failure');
    } finally {
      await pool!.query(
        'ALTER TABLE tmp_history RENAME TO asset_history_events',
      );
    }
  });

  it('creates no PM, breakdown, work order, checklist, or meter tables', async (t) => {
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
      'maintenance_timeline',
      'breakdowns',
      // `work_orders` is owned by BE-08B (now present by design).
      'work_order_history',
      'checklists',
      // `checklist_executions` is owned by BE-07 (now present by design).
      'meter_readings',
      // `findings` is owned by BE-09 (now present by design).
      'verifications',
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `${forbidden} must not exist in BE-05I`,
      );
    }
  });

  it('keeps the asset_history_events columns append-oriented', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'asset_history_events'
       ORDER BY column_name`,
    );
    const names = columns.rows.map((row) => row.column_name);

    assert.deepEqual(names, [
      'actor_user_id',
      'asset_id',
      'created_at',
      'event_type',
      'id',
      'metadata',
      'summary',
    ]);
    // No `updated_at`: history entries are never edited.
    assert.equal(names.includes('updated_at'), false);
  });
});
