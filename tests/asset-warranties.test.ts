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
import { isCurrentlyCovered } from '../src/modules/asset-warranties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05F — Asset Warranty focused tests.
 *
 * Covers only commercial / service coverage records attached to an Asset.
 * Certification, QR / identifier, full Asset History, work order, PM,
 * breakdown, vendor contract workflow, and warranty claim workflow belong to
 * later PARTs or Waves — the final suite asserts BE-05F introduced none of
 * them.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

/** Calendar-date helpers relative to today, so tests never go stale. */
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
    `TRUNCATE users, roles, clients, properties, buildings, assets,
      equipment_profiles, asset_warranties CASCADE`,
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

async function createAssetVia(buildingId: string, overrides?: object) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/assets`)
    .set(authHeaders())
    .send({
      assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
      assetName: 'Test Asset',
      ...overrides,
    });
}

async function createAssetFixture() {
  const fixture = await createBuildingFixture();
  const asset = await createAssetVia(fixture.building.id);
  assert.equal(asset.status, 201);
  return { ...fixture, asset: asset.body.data };
}

function createWarrantyVia(
  assetId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/assets/${assetId}/warranties`)
    .set(authHeaders(token))
    .send({
      providerName: 'Daikin Service',
      warrantyNumber: `WTY-${randomUUID().slice(0, 8).toUpperCase()}`,
      startDate: dateOffset(-30),
      endDate: dateOffset(335),
      ...overrides,
    });
}

/**
 * Seeds a historical (already-closed) warranty directly, bypassing the API's
 * "cannot create ACTIVE coverage in the past" rule — the point is to have
 * genuine history to list.
 */
async function seedExpiredWarranty(assetId: string, overrides?: object) {
  return createWarrantyVia(assetId, {
    startDate: dateOffset(-800),
    endDate: dateOffset(-400),
    status: 'EXPIRED',
    ...overrides,
  });
}

const PUBLIC_WARRANTY_KEYS = [
  'assetId',
  'coverageDescription',
  'endDate',
  'id',
  'isCurrentlyCovered',
  'providerName',
  'startDate',
  'status',
  'warrantyNumber',
];

describe('coverage helper', () => {
  it('reports coverage only for an active record inside its window', () => {
    const base = { startDate: '2024-01-01', endDate: '2024-12-31' } as const;
    assert.equal(
      isCurrentlyCovered({ ...base, status: 'ACTIVE' }, '2024-06-01'),
      true,
    );
    // Boundaries are inclusive.
    assert.equal(
      isCurrentlyCovered({ ...base, status: 'ACTIVE' }, '2024-01-01'),
      true,
    );
    assert.equal(
      isCurrentlyCovered({ ...base, status: 'ACTIVE' }, '2024-12-31'),
      true,
    );
    assert.equal(
      isCurrentlyCovered({ ...base, status: 'ACTIVE' }, '2025-01-01'),
      false,
    );
    assert.equal(
      isCurrentlyCovered({ ...base, status: 'EXPIRED' }, '2024-06-01'),
      false,
    );
    assert.equal(
      isCurrentlyCovered({ ...base, status: 'INACTIVE' }, '2024-06-01'),
      false,
    );
  });
});

describe('create warranty', () => {
  it('registers coverage for an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id, {
      providerName: 'Daikin Service',
      warrantyNumber: 'WTY-0001',
      coverageDescription: 'Parts and labour, on-site',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_WARRANTY_KEYS,
    );
    assert.equal(response.body.data.assetId, asset.id);
    assert.equal(response.body.data.warrantyNumber, 'WTY-0001');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.isCurrentlyCovered, true);
    // Calendar dates stay calendar dates.
    assert.match(response.body.data.startDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('defaults the optional coverage description to null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.coverageDescription, null);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createWarrantyVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });

  it('rejects a missing provider or number', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .post(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders())
      .send({ startDate: dateOffset(0), endDate: dateOffset(30) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('invalid date range', () => {
  it('rejects an end date before the start date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id, {
      startDate: dateOffset(100),
      endDate: dateOffset(10),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a malformed date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id, {
      startDate: '01/01/2024',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an impossible calendar date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id, {
      startDate: '2023-02-29',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('accepts a single-day coverage window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const day = dateOffset(0);
    const response = await createWarrantyVia(asset.id, {
      startDate: day,
      endDate: day,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.isCurrentlyCovered, true);
  });
});

describe('duplicate / conflicting active warranty', () => {
  it('rejects a second active warranty for the same asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const first = await createWarrantyVia(asset.id);
    assert.equal(first.status, 201);

    const second = await createWarrantyVia(asset.id, {
      startDate: dateOffset(400),
      endDate: dateOffset(700),
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'ASSET_WARRANTY_ACTIVE_EXISTS');
  });

  it('rejects an overlapping coverage window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredWarranty(asset.id, {
      startDate: dateOffset(-800),
      endDate: dateOffset(-400),
    });

    // New EXPIRED record overlapping the seeded one.
    const response = await createWarrantyVia(asset.id, {
      startDate: dateOffset(-500),
      endDate: dateOffset(-450),
      status: 'EXPIRED',
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ASSET_WARRANTY_OVERLAP');
  });

  it('rejects a duplicate warranty number on the same asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createWarrantyVia(asset.id, { warrantyNumber: 'WTY-SAME' });

    const response = await createWarrantyVia(asset.id, {
      warrantyNumber: 'WTY-SAME',
      startDate: dateOffset(-800),
      endDate: dateOffset(-400),
      status: 'EXPIRED',
    });

    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'ASSET_WARRANTY_NUMBER_ALREADY_EXISTS',
    );
  });

  it('allows the same warranty number on a different asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();

    const a = await createWarrantyVia(first.asset.id, {
      warrantyNumber: 'WTY-SHARED',
    });
    const b = await createWarrantyVia(second.asset.id, {
      warrantyNumber: 'WTY-SHARED',
    });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  it('allows several historical records alongside one active', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const older = await seedExpiredWarranty(asset.id, {
      startDate: dateOffset(-1200),
      endDate: dateOffset(-900),
    });
    const newer = await seedExpiredWarranty(asset.id, {
      startDate: dateOffset(-800),
      endDate: dateOffset(-400),
    });
    const active = await createWarrantyVia(asset.id);

    assert.equal(older.status, 201);
    assert.equal(newer.status, 201);
    assert.equal(active.status, 201);
  });
});

describe('ACTIVE / EXPIRED handling', () => {
  it('refuses ACTIVE coverage whose end date has passed', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id, {
      startDate: dateOffset(-800),
      endDate: dateOffset(-400),
      status: 'ACTIVE',
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_WARRANTY_STATUS_DATE_MISMATCH',
    );
  });

  it('refuses EXPIRED coverage whose end date has not passed', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id, {
      startDate: dateOffset(-10),
      endDate: dateOffset(300),
      status: 'EXPIRED',
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_WARRANTY_STATUS_DATE_MISMATCH',
    );
  });

  it('marks a not-yet-started active warranty as not currently covered', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createWarrantyVia(asset.id, {
      startDate: dateOffset(30),
      endDate: dateOffset(400),
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.status, 'ACTIVE');
    // Coverage begins in the future, so today it is not covered.
    assert.equal(response.body.data.isCurrentlyCovered, false);
  });

  it('frees the active slot once coverage is expired', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const first = await createWarrantyVia(asset.id, {
      startDate: dateOffset(-30),
      endDate: dateOffset(30),
    });
    assert.equal(first.status, 201);

    // Close the old coverage, then register the renewal.
    const closed = await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${first.body.data.id}`)
      .set(authHeaders())
      .send({ endDate: dateOffset(-1), status: 'EXPIRED' });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.data.status, 'EXPIRED');

    const renewal = await createWarrantyVia(asset.id, {
      startDate: dateOffset(0),
      endDate: dateOffset(365),
    });
    assert.equal(renewal.status, 201);
    assert.equal(renewal.body.data.isCurrentlyCovered, true);
  });
});

describe('get current warranty', () => {
  it('returns the active coverage of an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredWarranty(asset.id);
    const active = await createWarrantyVia(asset.id, {
      warrantyNumber: 'WTY-CURRENT',
    });

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/warranty`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, active.body.data.id);
    assert.equal(response.body.data.warrantyNumber, 'WTY-CURRENT');
  });

  it('returns 404 when the asset has no active coverage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredWarranty(asset.id);

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/warranty`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_WARRANTY_NOT_FOUND');
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}/warranty`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('list warranty history', () => {
  it('lists all coverage of an asset, newest first', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredWarranty(asset.id, {
      warrantyNumber: 'WTY-OLD',
      startDate: dateOffset(-1200),
      endDate: dateOffset(-900),
    });
    await seedExpiredWarranty(asset.id, {
      warrantyNumber: 'WTY-MID',
      startDate: dateOffset(-800),
      endDate: dateOffset(-400),
    });
    await createWarrantyVia(asset.id, { warrantyNumber: 'WTY-NOW' });

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((w: { warrantyNumber: string }) => w.warrantyNumber),
      ['WTY-NOW', 'WTY-MID', 'WTY-OLD'],
    );
  });

  it('scopes the history to the requested asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    await createWarrantyVia(first.asset.id, { warrantyNumber: 'WTY-MINE' });
    await createWarrantyVia(second.asset.id, { warrantyNumber: 'WTY-THEIRS' });

    const response = await api()
      .get(`/api/v1/assets/${first.asset.id}/warranties`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((w: { warrantyNumber: string }) => w.warrantyNumber),
      ['WTY-MINE'],
    );
  });

  it('filters the history by status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredWarranty(asset.id, { warrantyNumber: 'WTY-PAST' });
    await createWarrantyVia(asset.id, { warrantyNumber: 'WTY-LIVE' });

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/warranties?status=EXPIRED`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((w: { warrantyNumber: string }) => w.warrantyNumber),
      ['WTY-PAST'],
    );
  });

  it('returns an empty history for an asset without coverage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .get(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });
});

describe('update warranty', () => {
  it('updates coverage fields', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createWarrantyVia(asset.id, {
      warrantyNumber: 'WTY-UPD',
    });

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        providerName: 'Updated Provider',
        coverageDescription: 'Parts only',
        endDate: dateOffset(500),
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.providerName, 'Updated Provider');
    assert.equal(response.body.data.coverageDescription, 'Parts only');
    assert.equal(response.body.data.endDate, dateOffset(500));
    // assetId stays immutable.
    assert.equal(response.body.data.assetId, asset.id);
  });

  it('rejects an update producing an invalid date range', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createWarrantyVia(asset.id, {
      startDate: dateOffset(-30),
      endDate: dateOffset(300),
    });

    // Merged result would end before it starts.
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${created.body.data.id}`)
      .set(authHeaders())
      .send({ startDate: dateOffset(400) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects reactivating a record when another active exists', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const past = await seedExpiredWarranty(asset.id, {
      startDate: dateOffset(-800),
      endDate: dateOffset(-400),
    });
    await createWarrantyVia(asset.id);

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${past.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE', endDate: dateOffset(200) });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ASSET_WARRANTY_ACTIVE_EXISTS');
  });

  it('supersedes coverage by marking it inactive without deleting', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createWarrantyVia(asset.id);

    const superseded = await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(superseded.status, 200);
    assert.equal(superseded.body.data.status, 'INACTIVE');
    assert.equal(superseded.body.data.isCurrentlyCovered, false);

    // Retained as history, and the active slot is free again.
    const history = await api()
      .get(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders());
    assert.equal(history.body.data.length, 1);

    const replacement = await createWarrantyVia(asset.id);
    assert.equal(replacement.status, 201);
  });

  it('returns 404 for an unknown warranty', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${randomUUID()}`)
      .set(authHeaders())
      .send({ providerName: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_WARRANTY_NOT_FOUND');
  });

  it('refuses to reach a warranty through the wrong asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    const created = await createWarrantyVia(first.asset.id);

    const response = await api()
      .patch(
        `/api/v1/assets/${second.asset.id}/warranties/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ providerName: 'Wrong Asset' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_WARRANTY_NOT_FOUND');
  });
});

describe('warranty RBAC and client / building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/assets/${randomUUID()}/warranties`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without warranty permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { asset } = await createAssetFixture();

    const read = await api()
      .get(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await createWarrantyVia(asset.id, undefined, plainToken);
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies access across the client / building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createWarrantyVia(asset.id);
    assert.equal(created.status, 201);

    // Full permissions, different Client, no assignment to this Building.
    const outsider = await createAdminUser();

    const list = await api()
      .get(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders(outsider.token));
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');

    const current = await api()
      .get(`/api/v1/assets/${asset.id}/warranty`)
      .set(authHeaders(outsider.token));
    assert.equal(current.status, 403);
    assert.equal(current.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/assets/${asset.id}/warranties/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ providerName: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-05F boundary', () => {
  it('creates no certification, QR, history, work order, PM, breakdown, vendor, or claim tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    // `asset_certifications` is owned by BE-05G and therefore not listed.
    for (const forbidden of [
      'certifications',
      // `asset_identifiers` is owned by BE-05H.
      'asset_qr_codes',
      'asset_history',
      // `asset_history_events` is owned by BE-05I.
      // `work_orders` is owned by BE-08B (now present by design).
      'preventive_maintenances',
      'maintenance_plans',
      'breakdowns',
      'vendor_contracts',
      'warranty_claims',
      'asset_warranty_claims',
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `${forbidden} must not exist in BE-05F`,
      );
    }
  });

  it('keeps the asset_warranties columns to the agreed model', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'asset_warranties'
       ORDER BY column_name`,
    );

    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'asset_id',
        'coverage_description',
        'created_at',
        'end_date',
        'id',
        'provider_name',
        'start_date',
        'status',
        'updated_at',
        'warranty_number',
      ],
    );
  });

  it('does not duplicate asset ownership or add vendor/claim references', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'asset_warranties'`,
    );
    const names = columns.rows.map((row) => row.column_name);

    for (const forbidden of [
      'client_id',
      'building_id',
      'vendor_id',
      'contract_id',
      'claim_id',
      'work_order_id',
    ]) {
      assert.equal(names.includes(forbidden), false);
    }
  });

  it('enforces the date range at the database level', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await assert.rejects(
      pool!.query(
        `INSERT INTO asset_warranties
           (id, asset_id, provider_name, warranty_number, start_date, end_date, status)
         VALUES ($1, $2, 'Direct', 'WTY-DIRECT', '2025-12-31', '2025-01-01', 'INACTIVE')`,
        [randomUUID(), asset.id],
      ),
      /asset_warranties_date_range_check/,
    );
  });

  it('leaves asset lifecycle and equipment profile untouched', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await api()
      .post(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ equipmentCode: 'EQP-WTY', equipmentName: 'Covered Equipment' });

    const before = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    await createWarrantyVia(asset.id);

    const after = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    // Registering coverage triggers no lifecycle or equipment side effects.
    assert.deepEqual(after.body.data, before.body.data);
    assert.equal(after.body.data.status, 'ACTIVE');

    const profile = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders());
    assert.equal(profile.body.data.status, 'ACTIVE');
  });
});
