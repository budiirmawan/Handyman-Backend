import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import type { Pool } from 'pg';

import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';

/**
 * BA-02 — Price Catalog create must use the governed Client currency command
 * contract without translating unexpected infrastructure failures into 400.
 *
 * Every scenario uses a disposable PostgreSQL cluster and the real HTTP route.
 */
const DIR = '/tmp/asentra-ba02-price-currency-pg';
const PORT = 55731;
const PATH = '/api/v1/price-catalog/entries';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

let database: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  database = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({
    host: '127.0.0.1',
    port: PORT,
    database: 'asentra_test',
    user: 'postgres',
    password: '',
    ssl: false,
    name: 'asentra_test',
  } as never);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
});

after(async () => {
  try {
    mock.restoreAll();
    if (pool) await closePool(pool);
    if (database) await database.stop();
  } finally {
    pool = null;
    database = null;
    resetAppConfigCache();
  }
});

function db(): Pool {
  if (!pool) throw new Error('BA-02 disposable database is unavailable');
  return pool;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type Body = Record<string, unknown>;

async function structure(assignAdmin = true) {
  const client = await clientService.createClient({
    code: `BA02CLI_${suffix()}`,
    name: 'BA-02 Currency Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `BA02PROP_${suffix()}`,
    name: 'BA-02 Currency Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BA02BLDG_${suffix()}`,
    name: 'BA-02 Currency Building',
  });
  if (assignAdmin) {
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
  }
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `BA02ITEM_${suffix()}`,
    name: 'BA-02 Reference Material',
    itemType: 'MATERIAL',
  });
  const uomId = randomUUID();
  await db().query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Each', 'ea', 'COUNT')`,
    [uomId, client.id, `U${suffix()}`.slice(0, 12)],
  );
  return { client, property, building, item, uom: { id: uomId } };
}

async function fixture(allowedCurrencyCodes: string[] = ['IDR', 'USD']) {
  const fx = await structure();
  await clientMonetaryContextService.setClientMonetaryContext(
    {
      clientId: fx.client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes,
    },
    adminUserId,
  );
  return fx;
}

function entryBody(
  fx: Awaited<ReturnType<typeof structure>>,
  overrides: Body = {},
): Body {
  return {
    clientId: fx.client.id,
    itemId: fx.item.id,
    uomId: fx.uom.id,
    currency: 'IDR',
    unitPrice: 1250.5,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function createEntry(body: Body, token: string | null = adminToken) {
  let request = api()
    .post(PATH)
    .set('Idempotency-Key', `BA02_${suffix()}_${randomUUID()}`);
  if (token) request = request.set(auth(token));
  return request.send(body);
}

async function persistence(clientId: string) {
  const result = await db().query<{
    prices: string;
    events: string;
    outbox: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM price_catalog_entries WHERE client_id = $1) AS prices,
       (SELECT COUNT(*) FROM operational_events WHERE client_id = $1) AS events,
       (SELECT COUNT(*) FROM integration_outbox_events WHERE client_id = $1) AS outbox`,
    [clientId],
  );
  const row = result.rows[0];
  return {
    prices: Number(row.prices),
    events: Number(row.events),
    outbox: Number(row.outbox),
  };
}

describe('BA-02 — Price Catalog Client currency validation', () => {
  it('preserves creation with an ACTIVE currency allowed for the Client', async () => {
    const fx = await fixture(['IDR', 'USD']);
    const before = await persistence(fx.client.id);

    const response = await createEntry(entryBody(fx, { currency: 'USD' }));

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.currency, 'USD');
    assert.equal(response.body.data.status, 'DRAFT');
    const after = await persistence(fx.client.id);
    assert.equal(after.prices, before.prices + 1);
    assert.equal(after.events, before.events + 1);
  });

  it('returns CLIENT_CURRENCY_NOT_ALLOWED and persists nothing when USD is ACTIVE but disallowed', async () => {
    const target = await fixture(['IDR']);
    // Another Client may use USD; that permission must never widen this Client.
    await fixture(['IDR', 'USD']);
    const global = await db().query<{ status: string }>(
      `SELECT status FROM currencies WHERE code = 'USD'`,
    );
    assert.equal(global.rows[0]?.status, 'ACTIVE');
    const before = await persistence(target.client.id);

    const response = await createEntry(entryBody(target, { currency: 'USD' }));
    const after = await persistence(target.client.id);

    // Assert rollback first so the failing-first reproduction also records it.
    assert.deepEqual(after, before);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'CLIENT_CURRENCY_NOT_ALLOWED');
  });

  it('preserves governed rejection for an INACTIVE supported currency with no writes', async () => {
    const fx = await fixture(['IDR', 'JPY']);
    const before = await persistence(fx.client.id);
    let response: Awaited<ReturnType<typeof createEntry>>;
    let after: Awaited<ReturnType<typeof persistence>>;
    await db().query(`UPDATE currencies SET status = 'INACTIVE' WHERE code = 'JPY'`);
    try {
      response = await createEntry(entryBody(fx, { currency: 'JPY' }));
      after = await persistence(fx.client.id);
    } finally {
      await db().query(`UPDATE currencies SET status = 'ACTIVE' WHERE code = 'JPY'`);
    }

    assert.deepEqual(after, before);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'CURRENCY_INACTIVE_OR_UNKNOWN');
  });

  it('preserves validation rejection for an unknown currency code with no writes', async () => {
    const fx = await fixture(['IDR']);
    const before = await persistence(fx.client.id);

    const response = await createEntry(entryBody(fx, { currency: 'THB' }));
    const after = await persistence(fx.client.id);

    assert.deepEqual(after, before);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('preserves authentication, permission, and cross-Client denial without writes', async () => {
    const own = await fixture(['IDR', 'USD']);
    const other = await structure(false);
    const plain = await createPlainSession();
    const outsider = await createSessionWithPermissions([
      { code: 'price_catalog.manage', name: 'Manage Price Catalog Entries' },
    ]);
    const ownBefore = await persistence(own.client.id);
    const otherBefore = await persistence(other.client.id);

    const unauthenticated = await createEntry(entryBody(own), null);
    const noPermission = await createEntry(entryBody(own), plain);
    const noScope = await createEntry(entryBody(own), outsider);
    const crossClient = await createEntry(entryBody(other));

    assert.deepEqual(await persistence(own.client.id), ownBefore);
    assert.deepEqual(await persistence(other.client.id), otherBefore);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(noPermission.status, 403);
    assert.equal(noPermission.body.error.code, 'PERMISSION_DENIED');
    assert.equal(noScope.status, 403);
    assert.equal(noScope.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(crossClient.status, 403);
    assert.equal(crossClient.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('keeps an unexpected currency-authority database failure as HTTP 500 with no writes', async () => {
    const fx = await fixture(['IDR', 'USD']);
    const before = await persistence(fx.client.id);
    const failure = new Error('BA-02 injected currency lookup outage');
    const originalQuery = db().query;
    const implementation = (async (...args: unknown[]) => {
      const candidate = args[0];
      const sql =
        typeof candidate === 'string'
          ? candidate
          : typeof candidate === 'object' && candidate !== null && 'text' in candidate
            ? String((candidate as { text?: unknown }).text ?? '')
            : '';
      if (
        sql.includes('SELECT EXISTS(SELECT 1 FROM currencies') &&
        sql.includes('client_allowed_transaction_currencies')
      ) {
        throw failure;
      }
      return Reflect.apply(originalQuery, db(), args);
    }) as Pool['query'];
    const queryMock = mock.method(db(), 'query', implementation);

    let response: Awaited<ReturnType<typeof createEntry>>;
    try {
      response = await createEntry(entryBody(fx, { currency: 'USD' }));
    } finally {
      queryMock.mock.restore();
    }
    const after = await persistence(fx.client.id);

    assert.deepEqual(after, before);
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
  });
});
