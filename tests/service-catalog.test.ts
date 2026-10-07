import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SVC-01 PART 01 — Service Catalog Foundation.
 *
 * Deliberately excludes Service Request integration (PART 02), Vendor
 * capability linking (PART 03), RFQ/quotation/PO lineage snapshots (PART 04),
 * PRICE-01 SERVICE price widening (PART 05), OpenAPI (PART 06), demand/price/
 * quantity/UOM behavior, SERVICE pricing, schedulers, and backfill of the
 * existing free-text `service_type`.
 *
 * Covered here: migration/model shape, code uniqueness + normalization, code
 * immutability, lifecycle/deactivation retention, Client isolation,
 * permissions/seed wiring, and operational-event audit.
 */

const DB_PORT = 55501;
const DATA_DIR = '/tmp/asentra-svc01-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
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

  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE service_catalog, operational_events, buildings, properties,
      clients, users, roles, permissions CASCADE
  `);

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EMBEDDED_DATABASE) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  pg = null;
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function auth(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();

async function fixture(assignUserId: string | null = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Service Catalog Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Service Catalog Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Service Catalog Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

type Body = Record<string, unknown>;

function entryBody(
  fixtureData: Awaited<ReturnType<typeof fixture>>,
  overrides: Body = {},
): Body {
  return {
    clientId: fixtureData.client.id,
    code: `SVC_${suffix()}`,
    name: 'Daily Cleaning',
    category: 'HOUSEKEEPING',
    ...overrides,
  };
}

async function createEntry(body: Body, token = adminToken) {
  return api()
    .post('/api/v1/service-catalog/entries')
    .set(auth(token))
    .send(body);
}

async function deactivateEntry(id: string, token = adminToken) {
  return api()
    .post(`/api/v1/service-catalog/entries/${id}/deactivate`)
    .set(auth(token))
    .send({});
}

async function eventCount(eventType: string, entityId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM operational_events
      WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('CR-BE-SVC-01 PART 01 — create + model shape', () => {
  it('creates an ACTIVE entry and normalizes the code to uppercase', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(
      entryBody(fx, { code: 'daily_cleaning', name: 'Daily Cleaning' }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.code, 'DAILY_CLEANING');
    assert.equal(created.body.data.category, 'HOUSEKEEPING');
    assert.equal(created.body.data.description, null);
    assert.equal(created.body.data.clientId, fx.client.id);
    assert.ok(created.body.data.id);
    assert.ok(created.body.data.createdAt);
  });

  it('rejects an invalid code grammar at the service layer', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const bad = await createEntry(entryBody(fx, { code: '1bad' }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

    const tooShort = await createEntry(entryBody(fx, { code: 'A' }));
    assert.equal(tooShort.status, 400);

    const lowercase = await createEntry(entryBody(fx, { code: 'cleaning!' }));
    assert.equal(lowercase.status, 400);
  });

  it('enforces the schema CHECK constraints directly (code grammar + status)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const clientId = fx.client.id;

    // Invalid code (lowercase) rejected by the DB CHECK even bypassing the API.
    await assert.rejects(
      pool!.query(
        `INSERT INTO service_catalog
           (id, client_id, code, name, category, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)`,
        [randomUUID(), clientId, 'lowercase', 'X', 'CAT', adminUserId],
      ),
    );

    // Invalid status rejected by the DB CHECK.
    await assert.rejects(
      pool!.query(
        `INSERT INTO service_catalog
           (id, client_id, code, name, category, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'BOGUS', $6)`,
        [randomUUID(), clientId, 'VALID_CODE', 'X', 'CAT', adminUserId],
      ),
    );

    // Blank name rejected.
    await assert.rejects(
      pool!.query(
        `INSERT INTO service_catalog
           (id, client_id, code, name, category, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)`,
        [randomUUID(), clientId, 'VALID_CODE2', '   ', 'CAT', adminUserId],
      ),
    );
  });

  it('rejects an unknown / inactive Client', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();

    const unknown = await createEntry({
      code: 'SVC_X',
      name: 'X',
      category: 'CAT',
      clientId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'CLIENT_NOT_FOUND');

    // Deactivate the client, then attempt to create against it.
    await pool!.query(`UPDATE clients SET status = 'INACTIVE' WHERE id = $1`, [
      fx.client.id,
    ]);
    const inactiveClient = await createEntry(entryBody(fx));
    assert.equal(inactiveClient.status, 400);
    assert.equal(inactiveClient.body.error.code, 'CLIENT_INACTIVE');
  });
});

describe('CR-BE-SVC-01 PART 01 — uniqueness + immutability + updates', () => {
  it('rejects a duplicate code within one Client but allows it across Clients', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const first = await createEntry(entryBody(fx, { code: 'SHARED_CODE' }));
    assert.equal(first.status, 201);

    const dup = await createEntry(
      entryBody(fx, { code: 'shared_code', name: 'Other' }),
    );
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'SERVICE_CATALOG_CODE_ALREADY_EXISTS');

    // Same code is fine under a different Client.
    const fx2 = await fixture();
    const other = await createEntry(entryBody(fx2, { code: 'SHARED_CODE' }));
    assert.equal(other.status, 201);
    assert.equal(other.body.data.code, 'SHARED_CODE');
  });

  it('treats code as immutable (PATCH with code is a governed rejection)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'IMMUTABLE_1' }));
    const id = created.body.data.id;

    const attempt = await api()
      .patch(`/api/v1/service-catalog/entries/${id}`)
      .set(auth())
      .send({ code: 'CHANGED' });
    assert.equal(attempt.status, 400);
    assert.equal(attempt.body.error.code, 'VALIDATION_ERROR');
  });

  it('updates editable non-identity fields (name / description / category)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(
      entryBody(fx, { code: 'EDIT_1', description: 'orig' }),
    );
    const id = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/service-catalog/entries/${id}`)
      .set(auth())
      .send({ name: 'Deep Cleaning', category: 'SANITATION', description: null });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Deep Cleaning');
    assert.equal(updated.body.data.category, 'SANITATION');
    assert.equal(updated.body.data.description, null);
    // Code and identity preserved.
    assert.equal(updated.body.data.code, 'EDIT_1');
    assert.equal(updated.body.data.clientId, fx.client.id);
  });
});

describe('CR-BE-SVC-01 PART 01 — lifecycle / deactivation retention', () => {
  it('deactivates an ACTIVE entry terminally and retains it for history', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'DEACT_1' }));
    const id = created.body.data.id;

    const deactivated = await deactivateEntry(id);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.code, 'DEACT_1');

    // Retained and still readable by an in-scope caller.
    const read = await api()
      .get(`/api/v1/service-catalog/entries/${id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, 'INACTIVE');

    // Re-deactivation is a governed 409 (terminal; no reactivation lane in v1).
    const again = await deactivateEntry(id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'SERVICE_CATALOG_NOT_ACTIVE');
  });

  it('rejects update/deactivate of a missing entry with 404', async (t) => {
    if (!requireDatabase(t)) return;
    await fixture();
    const missing = randomUUID();

    const patch = await api()
      .patch(`/api/v1/service-catalog/entries/${missing}`)
      .set(auth())
      .send({ name: 'X' });
    assert.equal(patch.status, 404);

    const deact = await deactivateEntry(missing);
    assert.equal(deact.status, 404);
  });
});

describe('CR-BE-SVC-01 PART 01 — permissions + isolation', () => {
  it('enforces service_catalog.read / .manage on every route', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx));
    const id = created.body.data.id;

    const plain = await createPlainSession();
    const noPermCreate = await createEntry(entryBody(fx), plain);
    assert.equal(noPermCreate.status, 403);
    const noPermList = await api()
      .get('/api/v1/service-catalog/entries')
      .set(auth(plain));
    assert.equal(noPermList.status, 403);
    const noPermGet = await api()
      .get(`/api/v1/service-catalog/entries/${id}`)
      .set(auth(plain));
    assert.equal(noPermGet.status, 403);

    const reader = await createSessionWithPermissions([
      { code: 'service_catalog.read', name: 'Read Service Catalog Entries' },
    ]);
    const readerCanNotCreate = await createEntry(entryBody(fx), reader);
    assert.equal(readerCanNotCreate.status, 403);
    const readerCanNotDeactivate = await deactivateEntry(id, reader);
    assert.equal(readerCanNotDeactivate.status, 403);

    const unauthenticated = await api().get('/api/v1/service-catalog/entries');
    assert.equal(unauthenticated.status, 401);
  });

  it('never leaks entries across Client scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'ISOLATED_1' }));
    const id = created.body.data.id;

    // An authorized steward with permissions but no building assignments sees
    // nothing and cannot read or write another Client's catalog.
    const outsider = await createSessionWithPermissions([
      { code: 'service_catalog.read', name: 'Read Service Catalog Entries' },
      { code: 'service_catalog.manage', name: 'Manage Service Catalog Entries' },
    ]);

    const list = await api()
      .get(`/api/v1/service-catalog/entries?clientId=${fx.client.id}`)
      .set(auth(outsider));
    assert.equal(list.status, 200);
    assert.equal(Array.isArray(list.body.data), true);
    assert.equal(list.body.data.length, 0);

    const get = await api()
      .get(`/api/v1/service-catalog/entries/${id}`)
      .set(auth(outsider));
    assert.equal(get.status, 403);

    const createDenied = await createEntry(entryBody(fx, { code: 'DENIED_1' }), outsider);
    assert.equal(createDenied.status, 403);

    // The assigned admin sees the entry and can filter deterministically.
    const own = await api()
      .get(`/api/v1/service-catalog/entries?clientId=${fx.client.id}`)
      .set(auth());
    assert.equal(own.status, 200);
    assert.ok(own.body.data.length >= 1);
    assert.ok(
      own.body.data.some((e: { code: string }) => e.code === 'ISOLATED_1'),
    );
  });

  it('registers service_catalog codes and grants them to PLATFORM_ADMIN', async (t) => {
    if (!requireDatabase(t)) return;

    await runSeeds(pool!);
    await runSeeds(pool!);

    const codes = await pool!.query<{ code: string }>(
      `SELECT code FROM permissions
        WHERE code IN ('service_catalog.read', 'service_catalog.manage')`,
    );
    assert.equal(codes.rowCount, 2);

    const granted = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM role_permission_assignments rpa
         JOIN roles r ON r.id = rpa.role_id
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE r.code = 'PLATFORM_ADMIN'
          AND p.code IN ('service_catalog.read', 'service_catalog.manage')
          AND rpa.status = 'ACTIVE'`,
    );
    assert.equal(granted.rows[0]?.count, '2');
  });
});

describe('CR-BE-SVC-01 PART 01 — operational-event audit', () => {
  it('records CREATED / UPDATED / DEACTIVATED events transaction-atomically', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'AUDIT_1' }));
    const id = created.body.data.id as string;

    assert.equal(await eventCount('SERVICE_CATALOG_ENTRY_CREATED', id), 1);

    const updated = await api()
      .patch(`/api/v1/service-catalog/entries/${id}`)
      .set(auth())
      .send({ name: 'Audit Renamed' });
    assert.equal(updated.status, 200);
    assert.equal(await eventCount('SERVICE_CATALOG_ENTRY_UPDATED', id), 1);

    const deactivated = await deactivateEntry(id);
    assert.equal(deactivated.status, 200);
    assert.equal(await eventCount('SERVICE_CATALOG_ENTRY_DEACTIVATED', id), 1);

    // Entity type / metadata present on the events.
    const ev = await pool!.query<{
      entity_type: string;
      metadata: { code?: string };
    }>(
      `SELECT entity_type, metadata FROM operational_events
        WHERE entity_id = $1 AND event_type = 'SERVICE_CATALOG_ENTRY_CREATED'`,
      [id],
    );
    assert.equal(ev.rows[0]?.entity_type, 'SERVICE_CATALOG_ENTRY');
    assert.equal(ev.rows[0]?.metadata.code, 'AUDIT_1');
  });
});
