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
  isCurrentlyEffective,
  isValidCertificationType,
  normalizeCertificationType,
} from '../src/modules/asset-certifications';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05G — Asset Certification focused tests.
 *
 * Covers only statutory / technical / inspection / compliance certification
 * records attached to an Asset. Inspection execution, renewal workflow,
 * document repository, QR / identifier, full Asset History, PM, breakdown,
 * and work order belong to later PARTs or Waves — the final suite asserts
 * BE-05G implemented none of them.
 *
 * The certification types used below (STATUTORY_PERMIT, LOAD_TEST, …) are
 * DATA supplied by the test, never hardcoded application behavior.
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
      equipment_profiles, asset_warranties, asset_certifications CASCADE`,
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

function createCertificationVia(
  assetId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/assets/${assetId}/certifications`)
    .set(authHeaders(token))
    .send({
      certificationType: 'STATUTORY_PERMIT',
      certificateNumber: `CERT-${randomUUID().slice(0, 8).toUpperCase()}`,
      issuingAuthority: 'Ministry of Manpower',
      issueDate: dateOffset(-30),
      expiryDate: dateOffset(335),
      ...overrides,
    });
}

/** A closed, historical certification — genuine history to list. */
function seedExpiredCertification(assetId: string, overrides?: object) {
  return createCertificationVia(assetId, {
    issueDate: dateOffset(-800),
    expiryDate: dateOffset(-400),
    status: 'EXPIRED',
    ...overrides,
  });
}

const PUBLIC_CERTIFICATION_KEYS = [
  'assetId',
  'certificateNumber',
  'certificationType',
  'expiryDate',
  'id',
  'isCurrentlyEffective',
  'issueDate',
  'issuingAuthority',
  'notes',
  'status',
];

describe('certification helpers', () => {
  it('normalizes and validates certification types', () => {
    assert.equal(
      normalizeCertificationType('  load-test '),
      'LOAD-TEST',
    );
    assert.equal(isValidCertificationType('STATUTORY_PERMIT'), true);
    assert.equal(isValidCertificationType('1PERMIT'), false);
    assert.equal(isValidCertificationType('P'), false);
  });

  it('reports effectiveness only for an active record inside its window', () => {
    const base = { issueDate: '2024-01-01', expiryDate: '2024-12-31' } as const;
    assert.equal(
      isCurrentlyEffective({ ...base, status: 'ACTIVE' }, '2024-06-01'),
      true,
    );
    // Boundaries are inclusive.
    assert.equal(
      isCurrentlyEffective({ ...base, status: 'ACTIVE' }, '2024-12-31'),
      true,
    );
    assert.equal(
      isCurrentlyEffective({ ...base, status: 'ACTIVE' }, '2025-01-01'),
      false,
    );
    // Not yet issued.
    assert.equal(
      isCurrentlyEffective({ ...base, status: 'ACTIVE' }, '2023-12-31'),
      false,
    );
    assert.equal(
      isCurrentlyEffective({ ...base, status: 'EXPIRED' }, '2024-06-01'),
      false,
    );
    // A perpetual certification never lapses.
    assert.equal(
      isCurrentlyEffective(
        { issueDate: '2024-01-01', expiryDate: null, status: 'ACTIVE' },
        '2099-01-01',
      ),
      true,
    );
  });
});

describe('create certification', () => {
  it('registers a certification for an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createCertificationVia(asset.id, {
      certificationType: 'statutory_permit',
      certificateNumber: 'CERT-0001',
      issuingAuthority: 'Ministry of Manpower',
      notes: 'Annual operating permit',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_CERTIFICATION_KEYS,
    );
    assert.equal(response.body.data.assetId, asset.id);
    assert.equal(response.body.data.certificationType, 'STATUTORY_PERMIT');
    assert.equal(response.body.data.certificateNumber, 'CERT-0001');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.isCurrentlyEffective, true);
    assert.match(response.body.data.issueDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('supports a perpetual certification without expiry', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createCertificationVia(asset.id, {
      expiryDate: undefined,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.expiryDate, null);
    assert.equal(response.body.data.isCurrentlyEffective, true);
  });

  it('defaults notes to null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createCertificationVia(asset.id);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.notes, null);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createCertificationVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });

  it('rejects a missing authority or malformed type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();

    const missingAuthority = await api()
      .post(`/api/v1/assets/${asset.id}/certifications`)
      .set(authHeaders())
      .send({
        certificationType: 'LOAD_TEST',
        certificateNumber: 'CERT-X',
        issueDate: dateOffset(0),
      });
    assert.equal(missingAuthority.status, 400);
    assert.equal(missingAuthority.body.error.code, 'VALIDATION_ERROR');

    const badType = await createCertificationVia(asset.id, {
      certificationType: '1BAD',
    });
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('invalid date range', () => {
  it('rejects an expiry before the issue date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createCertificationVia(asset.id, {
      issueDate: dateOffset(100),
      expiryDate: dateOffset(10),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects malformed and impossible dates', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();

    const malformed = await createCertificationVia(asset.id, {
      issueDate: '01/01/2024',
    });
    assert.equal(malformed.status, 400);

    const impossible = await createCertificationVia(asset.id, {
      issueDate: '2023-02-29',
    });
    assert.equal(impossible.status, 400);
    assert.equal(impossible.body.error.code, 'VALIDATION_ERROR');
  });

  it('accepts a single-day validity window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const day = dateOffset(0);
    const response = await createCertificationVia(asset.id, {
      issueDate: day,
      expiryDate: day,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.isCurrentlyEffective, true);
  });
});

describe('duplicate / conflicting active certification', () => {
  it('rejects a second active certification of the same type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const first = await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
    });
    assert.equal(first.status, 201);

    const second = await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
      issueDate: dateOffset(400),
      expiryDate: dateOffset(700),
    });

    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'ASSET_CERTIFICATION_ACTIVE_EXISTS',
    );
  });

  it('allows concurrent active certifications of different types', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const permit = await createCertificationVia(asset.id, {
      certificationType: 'STATUTORY_PERMIT',
    });
    const loadTest = await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
    });
    const fire = await createCertificationVia(asset.id, {
      certificationType: 'FIRE_SAFETY',
    });

    assert.equal(permit.status, 201);
    assert.equal(loadTest.status, 201);
    assert.equal(fire.status, 201);
  });

  it('rejects an overlapping window within the same type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredCertification(asset.id, {
      certificationType: 'LOAD_TEST',
      issueDate: dateOffset(-800),
      expiryDate: dateOffset(-400),
    });

    const response = await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
      issueDate: dateOffset(-500),
      expiryDate: dateOffset(-450),
      status: 'EXPIRED',
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ASSET_CERTIFICATION_OVERLAP');
  });

  it('allows an overlapping window across different types', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredCertification(asset.id, {
      certificationType: 'LOAD_TEST',
      issueDate: dateOffset(-800),
      expiryDate: dateOffset(-400),
    });

    const response = await createCertificationVia(asset.id, {
      certificationType: 'FIRE_SAFETY',
      issueDate: dateOffset(-700),
      expiryDate: dateOffset(-500),
      status: 'EXPIRED',
    });

    assert.equal(response.status, 201);
  });

  it('rejects a duplicate certificate number on the same asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createCertificationVia(asset.id, {
      certificateNumber: 'CERT-SAME',
    });

    const response = await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
      certificateNumber: 'CERT-SAME',
    });

    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'ASSET_CERTIFICATION_NUMBER_ALREADY_EXISTS',
    );
  });

  it('allows the same certificate number on a different asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();

    const a = await createCertificationVia(first.asset.id, {
      certificateNumber: 'CERT-SHARED',
    });
    const b = await createCertificationVia(second.asset.id, {
      certificateNumber: 'CERT-SHARED',
    });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });
});

describe('ACTIVE / EXPIRED handling', () => {
  it('refuses ACTIVE certification whose expiry has passed', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createCertificationVia(asset.id, {
      issueDate: dateOffset(-800),
      expiryDate: dateOffset(-400),
      status: 'ACTIVE',
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_CERTIFICATION_STATUS_DATE_MISMATCH',
    );
  });

  it('refuses EXPIRED certification whose expiry has not passed', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createCertificationVia(asset.id, {
      issueDate: dateOffset(-10),
      expiryDate: dateOffset(300),
      status: 'EXPIRED',
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_CERTIFICATION_STATUS_DATE_MISMATCH',
    );
  });

  it('refuses EXPIRED for a perpetual certification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createCertificationVia(asset.id, {
      expiryDate: undefined,
      status: 'EXPIRED',
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_CERTIFICATION_STATUS_DATE_MISMATCH',
    );
  });

  it('frees the active slot for the type once expired', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const first = await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
      issueDate: dateOffset(-30),
      expiryDate: dateOffset(30),
    });
    assert.equal(first.status, 201);

    const closed = await api()
      .patch(
        `/api/v1/assets/${asset.id}/certifications/${first.body.data.id}`,
      )
      .set(authHeaders())
      .send({ expiryDate: dateOffset(-1), status: 'EXPIRED' });
    assert.equal(closed.status, 200);

    const renewal = await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
      issueDate: dateOffset(0),
      expiryDate: dateOffset(365),
    });
    assert.equal(renewal.status, 201);
    assert.equal(renewal.body.data.isCurrentlyEffective, true);
  });
});

describe('list certifications', () => {
  it('lists the full history, newest issue first', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredCertification(asset.id, {
      certificateNumber: 'CERT-OLD',
      issueDate: dateOffset(-1200),
      expiryDate: dateOffset(-900),
    });
    await seedExpiredCertification(asset.id, {
      certificateNumber: 'CERT-MID',
      issueDate: dateOffset(-800),
      expiryDate: dateOffset(-400),
    });
    await createCertificationVia(asset.id, { certificateNumber: 'CERT-NOW' });

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/certifications`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map(
        (c: { certificateNumber: string }) => c.certificateNumber,
      ),
      ['CERT-NOW', 'CERT-MID', 'CERT-OLD'],
    );
  });

  it('scopes the history to the requested asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    await createCertificationVia(first.asset.id, {
      certificateNumber: 'CERT-MINE',
    });
    await createCertificationVia(second.asset.id, {
      certificateNumber: 'CERT-THEIRS',
    });

    const response = await api()
      .get(`/api/v1/assets/${first.asset.id}/certifications`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map(
        (c: { certificateNumber: string }) => c.certificateNumber,
      ),
      ['CERT-MINE'],
    );
  });

  it('filters by status and by type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredCertification(asset.id, {
      certificationType: 'LOAD_TEST',
      certificateNumber: 'CERT-PAST',
    });
    await createCertificationVia(asset.id, {
      certificationType: 'FIRE_SAFETY',
      certificateNumber: 'CERT-LIVE',
    });

    const byStatus = await api()
      .get(`/api/v1/assets/${asset.id}/certifications?status=EXPIRED`)
      .set(authHeaders());
    assert.deepEqual(
      byStatus.body.data.map(
        (c: { certificateNumber: string }) => c.certificateNumber,
      ),
      ['CERT-PAST'],
    );

    const byType = await api()
      .get(`/api/v1/assets/${asset.id}/certifications?type=FIRE_SAFETY`)
      .set(authHeaders());
    assert.deepEqual(
      byType.body.data.map(
        (c: { certificateNumber: string }) => c.certificateNumber,
      ),
      ['CERT-LIVE'],
    );
  });

  it('returns an empty history for an asset without certifications', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .get(`/api/v1/assets/${asset.id}/certifications`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}/certifications`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('current / effective certifications', () => {
  it('returns every effective certification, one per type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredCertification(asset.id, {
      certificationType: 'OLD_PERMIT',
      certificateNumber: 'CERT-GONE',
    });
    await createCertificationVia(asset.id, {
      certificationType: 'STATUTORY_PERMIT',
      certificateNumber: 'CERT-A',
    });
    await createCertificationVia(asset.id, {
      certificationType: 'LOAD_TEST',
      certificateNumber: 'CERT-B',
    });

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/certifications/current`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map(
        (c: { certificationType: string }) => c.certificationType,
      ),
      ['LOAD_TEST', 'STATUTORY_PERMIT'],
    );
    for (const cert of response.body.data) {
      assert.equal(cert.isCurrentlyEffective, true);
    }
  });

  it('excludes an active certification that is not yet in force', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const future = await createCertificationVia(asset.id, {
      issueDate: dateOffset(30),
      expiryDate: dateOffset(400),
    });
    assert.equal(future.status, 201);
    assert.equal(future.body.data.status, 'ACTIVE');
    assert.equal(future.body.data.isCurrentlyEffective, false);

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/certifications/current`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns an empty list when nothing is effective', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await seedExpiredCertification(asset.id);

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/certifications/current`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}/certifications/current`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('update certification', () => {
  it('updates certification fields', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createCertificationVia(asset.id, {
      certificateNumber: 'CERT-UPD',
    });

    const response = await api()
      .patch(
        `/api/v1/assets/${asset.id}/certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({
        issuingAuthority: 'Updated Authority',
        notes: 'Re-inspected',
        expiryDate: dateOffset(500),
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.issuingAuthority, 'Updated Authority');
    assert.equal(response.body.data.notes, 'Re-inspected');
    assert.equal(response.body.data.expiryDate, dateOffset(500));
    assert.equal(response.body.data.assetId, asset.id);
  });

  it('makes a certification perpetual with an explicit null expiry', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createCertificationVia(asset.id);

    const response = await api()
      .patch(
        `/api/v1/assets/${asset.id}/certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ expiryDate: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.expiryDate, null);
    assert.equal(response.body.data.isCurrentlyEffective, true);
  });

  it('rejects an update producing an invalid date range', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createCertificationVia(asset.id, {
      issueDate: dateOffset(-30),
      expiryDate: dateOffset(300),
    });

    const response = await api()
      .patch(
        `/api/v1/assets/${asset.id}/certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ issueDate: dateOffset(400) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects reactivating when another active of the type exists', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const past = await seedExpiredCertification(asset.id, {
      certificationType: 'LOAD_TEST',
      issueDate: dateOffset(-800),
      expiryDate: dateOffset(-400),
    });
    await createCertificationVia(asset.id, { certificationType: 'LOAD_TEST' });

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/certifications/${past.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE', expiryDate: dateOffset(200) });

    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'ASSET_CERTIFICATION_ACTIVE_EXISTS',
    );
  });

  it('supersedes a certificate without deleting it', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createCertificationVia(asset.id);

    const superseded = await api()
      .patch(
        `/api/v1/assets/${asset.id}/certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(superseded.status, 200);
    assert.equal(superseded.body.data.status, 'INACTIVE');
    assert.equal(superseded.body.data.isCurrentlyEffective, false);

    // Retained as history, and the active slot for the type is free again.
    const history = await api()
      .get(`/api/v1/assets/${asset.id}/certifications`)
      .set(authHeaders());
    assert.equal(history.body.data.length, 1);

    const replacement = await createCertificationVia(asset.id);
    assert.equal(replacement.status, 201);
  });

  it('returns 404 for an unknown certification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/certifications/${randomUUID()}`)
      .set(authHeaders())
      .send({ issuingAuthority: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_CERTIFICATION_NOT_FOUND');
  });

  it('refuses to reach a certification through the wrong asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    const created = await createCertificationVia(first.asset.id);

    const response = await api()
      .patch(
        `/api/v1/assets/${second.asset.id}/certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ issuingAuthority: 'Wrong Asset' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_CERTIFICATION_NOT_FOUND');
  });
});

describe('certification RBAC and client / building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/assets/${randomUUID()}/certifications`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without certification permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { asset } = await createAssetFixture();

    const read = await api()
      .get(`/api/v1/assets/${asset.id}/certifications`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await createCertificationVia(
      asset.id,
      undefined,
      plainToken,
    );
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies access across the client / building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createCertificationVia(asset.id);
    assert.equal(created.status, 201);

    // Full permissions, different Client, no assignment to this Building.
    const outsider = await createAdminUser();

    const list = await api()
      .get(`/api/v1/assets/${asset.id}/certifications`)
      .set(authHeaders(outsider.token));
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');

    const current = await api()
      .get(`/api/v1/assets/${asset.id}/certifications/current`)
      .set(authHeaders(outsider.token));
    assert.equal(current.status, 403);
    assert.equal(current.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(
        `/api/v1/assets/${asset.id}/certifications/${created.body.data.id}`,
      )
      .set(authHeaders(outsider.token))
      .send({ issuingAuthority: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-05G boundary', () => {
  it('creates no inspection, renewal, document, QR, history, PM, breakdown, or work order tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    for (const forbidden of [
      'inspections',
      'inspection_executions',
      'certification_renewals',
      // `documents` / `document_versions` are owned by BE-22 Document Control
      // (the canonical contract) and legitimately exist — BE-05G must NOT
      // assert their absence.
      'document_repository',
      'asset_documents',
      // `asset_identifiers` is owned by BE-05H.
      'asset_qr_codes',
      'asset_history',
      // `asset_history_events` is owned by BE-05I.
      'preventive_maintenances',
      'maintenance_plans',
      'breakdowns',
      // `work_orders` is owned by BE-08B (now present by design).
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `${forbidden} must not exist in BE-05G`,
      );
    }
  });

  it('keeps the asset_certifications columns to the agreed model', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'asset_certifications'
       ORDER BY column_name`,
    );

    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'asset_id',
        'certificate_number',
        'certification_type',
        'created_at',
        'expiry_date',
        'id',
        'issue_date',
        'issuing_authority',
        'notes',
        'status',
        'updated_at',
      ],
    );
  });

  it('does not duplicate asset ownership or add inspection/document references', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'asset_certifications'`,
    );
    const names = columns.rows.map((row) => row.column_name);

    for (const forbidden of [
      'client_id',
      'building_id',
      'inspection_id',
      'document_id',
      'file_path',
      'work_order_id',
      'renewal_id',
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
        `INSERT INTO asset_certifications
           (id, asset_id, certification_type, certificate_number,
            issuing_authority, issue_date, expiry_date, status)
         VALUES ($1, $2, 'DIRECT', 'CERT-DIRECT', 'Authority',
                 '2025-12-31', '2025-01-01', 'INACTIVE')`,
        [randomUUID(), asset.id],
      ),
      /asset_certifications_date_range_check/,
    );
  });

  it('leaves asset lifecycle, equipment profile, and warranty untouched', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await api()
      .post(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ equipmentCode: 'EQP-CERT', equipmentName: 'Certified Equipment' });
    await api()
      .post(`/api/v1/assets/${asset.id}/warranties`)
      .set(authHeaders())
      .send({
        providerName: 'Provider',
        warrantyNumber: 'WTY-CERT',
        startDate: dateOffset(-10),
        endDate: dateOffset(300),
      });

    const before = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    await createCertificationVia(asset.id);

    const after = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    // Registering certification triggers no side effects elsewhere.
    assert.deepEqual(after.body.data, before.body.data);
    assert.equal(after.body.data.status, 'ACTIVE');

    const warranty = await api()
      .get(`/api/v1/assets/${asset.id}/warranty`)
      .set(authHeaders());
    assert.equal(warranty.body.data.status, 'ACTIVE');
  });
});
