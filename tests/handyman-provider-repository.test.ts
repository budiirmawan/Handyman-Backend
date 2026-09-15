import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp, runSeeds } from '../src/database';
import { clientService } from '../src/modules/clients';
import { handymanProviderRepository } from '../src/modules/handyman-providers';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55474;
const DIR = '/tmp/asentra-hm02-run1-repo-pg';
const EM = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';

if (EM) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let db: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function ok(t: TestContext): boolean {
  if (!db || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

before(async () => {
  if (EM) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const config = await ensureTestDatabase();
  if (!config) return;
  db = config;
  pool = await initDatabase(config);
  await migrateUp(pool);
  await runSeeds(pool);

  const admin = await createAdminUser();
  adminUserId = admin.userId;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EM) await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
  db = null;
});

async function createFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Provider Designation Client',
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Handyman Vendor',
  });
  return { client, vendor };
}

describe('CR-HM-BE-02 RUN 1 — Handyman Provider Migration', () => {
  it('creates handyman_providers with the one-ACTIVE-per-pair partial unique index', async (t) => {
    if (!ok(t)) return;

    const checkTable = await pool!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'handyman_providers'
       ) AS exists`,
    );
    assert.equal(checkTable.rows[0].exists, true);

    const indexResult = await pool!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE indexname = 'handyman_providers_one_active_per_client_vendor'`,
    );
    assert.equal(indexResult.rows.length, 1);
    assert.match(indexResult.rows[0].indexdef, /UNIQUE/i);
    assert.match(indexResult.rows[0].indexdef, /status = 'ACTIVE'/);

    const checkConstraint = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname = 'handyman_providers_status_check'`,
    );
    assert.equal(checkConstraint.rows.length, 1);
  });

  it('bootstraps handyman_provider permissions granted to PLATFORM_ADMIN', async (t) => {
    if (!ok(t)) return;

    const permissions = await pool!.query<{ code: string }>(
      `SELECT code FROM permissions
       WHERE code IN ('handyman_provider.read', 'handyman_provider.manage')
         AND status = 'ACTIVE'
       ORDER BY code ASC`,
    );
    assert.deepEqual(
      permissions.rows.map((row) => row.code),
      ['handyman_provider.manage', 'handyman_provider.read'],
    );

    const assignments = await pool!.query<{ code: string }>(
      `SELECT p.code
       FROM role_permission_assignments rpa
       JOIN roles r ON r.id = rpa.role_id
       JOIN permissions p ON p.id = rpa.permission_id
       WHERE r.code = 'PLATFORM_ADMIN'
         AND p.code IN ('handyman_provider.read', 'handyman_provider.manage')
         AND rpa.status = 'ACTIVE'
       ORDER BY p.code ASC`,
    );
    assert.equal(assignments.rows.length, 2);
  });

  it('verifies downgrade and re-migration cycle', async (t) => {
    if (!ok(t)) return;

    // Roll back any later migrations stacked above 0349 by future CRs, then
    // down 0349 itself
    let downResult = await migrateDown(pool!);
    while (
      downResult !== null &&
      downResult !== '0349_create_handyman_providers'
    ) {
      downResult = await migrateDown(pool!);
    }
    assert.equal(downResult, '0349_create_handyman_providers');

    // Table should not exist
    const checkTable = await pool!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'handyman_providers'
       ) AS exists`,
    );
    assert.equal(checkTable.rows[0].exists, false);

    // Permissions are preserved on downgrade per Asentra migration convention
    const preservedPermissions = await pool!.query<{ code: string }>(
      `SELECT code FROM permissions
       WHERE code IN ('handyman_provider.read', 'handyman_provider.manage')`,
    );
    assert.equal(preservedPermissions.rows.length, 2);

    // Re-up
    const upResult = await migrateUp(pool!);
    assert.ok(upResult.includes('0349_create_handyman_providers'));

    const checkTableAgain = await pool!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'handyman_providers'
       ) AS exists`,
    );
    assert.equal(checkTableAgain.rows[0].exists, true);
  });
});

describe('CR-HM-BE-02 RUN 1 — Handyman Provider Repository', () => {
  it('creates an ACTIVE designation row with actor attribution and reads it back', async (t) => {
    if (!ok(t)) return;

    const { client, vendor } = await createFixture();

    const created = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: vendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });

    assert.ok(created.id);
    assert.equal(created.clientId, client.id);
    assert.equal(created.vendorId, vendor.id);
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.createdByUserId, adminUserId);
    assert.ok(created.createdAt instanceof Date);
    assert.ok(created.updatedAt instanceof Date);

    const found = await handymanProviderRepository.findById(created.id);
    assert.deepEqual(found, created);
  });

  it('resolves the ACTIVE designation per client+vendor pair only', async (t) => {
    if (!ok(t)) return;

    const { client, vendor } = await createFixture();

    assert.equal(
      await handymanProviderRepository.findActiveByClientAndVendor(
        client.id,
        vendor.id,
      ),
      null,
    );

    const created = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: vendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });

    const active = await handymanProviderRepository.findActiveByClientAndVendor(
      client.id,
      vendor.id,
    );
    assert.equal(active?.id, created.id);

    // A different vendor of the same client is a different pair
    assert.equal(
      await handymanProviderRepository.findActiveByClientAndVendor(
        client.id,
        randomUUID(),
      ),
      null,
    );

    await handymanProviderRepository.updateStatusFrom(
      created.id,
      'ACTIVE',
      'INACTIVE',
    );
    assert.equal(
      await handymanProviderRepository.findActiveByClientAndVendor(
        client.id,
        vendor.id,
      ),
      null,
    );
  });

  it('rejects a second ACTIVE designation for the same pair at the database level', async (t) => {
    if (!ok(t)) return;

    const { client, vendor } = await createFixture();

    await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: vendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });

    const err = await handymanProviderRepository
      .create({
        clientId: client.id,
        vendorId: vendor.id,
        status: 'ACTIVE',
        createdByUserId: adminUserId,
      })
      .catch((error) => error as { code?: string; constraint?: string });

    assert.equal(err.code, '23505');
    assert.equal(
      err.constraint,
      'handyman_providers_one_active_per_client_vendor',
    );
  });

  it('preserves designation history: deactivated rows accumulate per pair', async (t) => {
    if (!ok(t)) return;

    const { client, vendor } = await createFixture();

    const first = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: vendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });
    const deactivatedFirst = await handymanProviderRepository.updateStatusFrom(
      first.id,
      'ACTIVE',
      'INACTIVE',
    );
    assert.equal(deactivatedFirst?.status, 'INACTIVE');

    // A new designation for the same pair is allowed while none is ACTIVE
    const second = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: vendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });
    assert.notEqual(second.id, first.id);

    const all = await handymanProviderRepository.listByClient(client.id);
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((row) => row.id),
      [first.id, second.id],
    );

    const activeOnly = await handymanProviderRepository.listByClient(client.id, {
      status: 'ACTIVE',
    });
    assert.deepEqual(
      activeOnly.map((row) => row.id),
      [second.id],
    );

    const inactiveOnly = await handymanProviderRepository.listByClient(
      client.id,
      { status: 'INACTIVE' },
    );
    assert.deepEqual(
      inactiveOnly.map((row) => row.id),
      [first.id],
    );
  });

  it('guards lifecycle transitions with the expected status', async (t) => {
    if (!ok(t)) return;

    const { client, vendor } = await createFixture();
    const created = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: vendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });

    // Wrong expected status → guard fails, row unchanged
    assert.equal(
      await handymanProviderRepository.updateStatusFrom(
        created.id,
        'INACTIVE',
        'ACTIVE',
      ),
      null,
    );

    // Unknown row → guard fails
    assert.equal(
      await handymanProviderRepository.updateStatusFrom(
        randomUUID(),
        'ACTIVE',
        'INACTIVE',
      ),
      null,
    );

    // Correct guard → transition applies and updated_at advances
    const deactivated = await handymanProviderRepository.updateStatusFrom(
      created.id,
      'ACTIVE',
      'INACTIVE',
    );
    assert.equal(deactivated?.status, 'INACTIVE');
    assert.ok(deactivated!.updatedAt.getTime() >= created.updatedAt.getTime());

    const reactivated = await handymanProviderRepository.updateStatusFrom(
      created.id,
      'INACTIVE',
      'ACTIVE',
    );
    assert.equal(reactivated?.status, 'ACTIVE');
  });

  it('lists designations per client in creation order', async (t) => {
    if (!ok(t)) return;

    const { client, vendor } = await createFixture();
    const secondVendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Second Handyman Vendor',
    });
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const otherVendor = await vendorService.createVendor({
      clientId: otherClient.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Other Vendor',
    });

    const first = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: vendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });
    const second = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: secondVendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });
    await handymanProviderRepository.create({
      clientId: otherClient.id,
      vendorId: otherVendor.id,
      status: 'ACTIVE',
      createdByUserId: adminUserId,
    });

    const listed = await handymanProviderRepository.listByClient(client.id);
    assert.deepEqual(
      listed.map((row) => row.id),
      [first.id, second.id],
    );
  });
});
