import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import {
  STARTER_PACK_CATEGORIES,
  STARTER_PACK_SERVICES,
  starterPackCategoryCodes,
} from '../src/modules/service-catalog-master';
import {
  parseAvailabilityGrantBody,
  parseCreateServiceCategoryBody,
  parseServiceCatalogReadQuery,
} from '../src/modules/service-catalog-master/service-catalog-master.validation';
import {
  createAdminUser,
  createPlainSession,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter.
 *
 * Database-free: frozen starter pack shape, validation grammar, migration
 * registration, route + OpenAPI registration.
 *
 * Database-gated (skip when asentra_test is unavailable): governed starter
 * import idempotency/duplicate codes/concurrency, category CRUD + lifecycle,
 * availability grants, cross-Client isolation, 401/403.
 *
 * Deliberately excludes frontend, payment/BM-fee authority, and any price
 * defaulting (pricing is composed from the existing SERVICE price catalog).
 */

const DB_PORT = 55507;
const DATA_DIR = '/tmp/asentra-scm-pg';
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
    TRUNCATE service_catalog, service_catalog_availability, service_category,
      operational_events, request_idempotency_records, buildings,
      properties, clients, users, roles, permissions CASCADE
  `);

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
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pg = null;
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
    name: 'Starter Pack Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Starter Pack Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Starter Pack Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function importStarterPack(
  clientId: string,
  token = adminToken,
  idempotencyKey = randomUUID(),
) {
  return api()
    .post('/api/v1/service-catalog/starter-pack/import')
    .set(auth(token))
    .set('Idempotency-Key', idempotencyKey)
    .send({ clientId });
}

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — frozen starter pack (database-free)', () => {
  it('defines the frozen 8 categories / 24 services of the Indonesian pack', () => {
    assert.equal(STARTER_PACK_CATEGORIES.length, 8);
    assert.equal(STARTER_PACK_SERVICES.length, 24);
    assert.deepEqual(starterPackCategoryCodes(), [
      'AC_VENTILASI',
      'LISTRIK',
      'PLUMBING',
      'SANITASI',
      'PINTU_KUNCI',
      'INTERIOR',
      'FURNITURE',
      'GENERAL_MAINTENANCE',
    ]);
    assert.equal(
      new Set(STARTER_PACK_CATEGORIES.map((c) => c.code)).size,
      8,
      'category codes must be unique',
    );
  });

  it('covers all 24 required services across the 8 categories', () => {
    const codes = STARTER_PACK_SERVICES.map((s) => s.code);
    assert.equal(codes.length, 24);
    assert.equal(new Set(codes).size, 24, 'service codes must be unique');
    assert.deepEqual(codes, [
      'CUCI_AC_SPLIT',
      'PERBAIKAN_AC_TIDAK_DINGIN',
      'PEMERIKSAAN_KEBOCORAN_AC',
      'PERBAIKAN_STOPKONTAK_SAKLAR',
      'PEMASANGAN_LAMPU',
      'PEMERIKSAAN_MCB_TRIP',
      'PERBAIKAN_KERAN_BOCOR',
      'PERBAIKAN_PIPA_BOCOR',
      'SALURAN_AIR_TERSUMBAT',
      'PERBAIKAN_KLOSET',
      'PERBAIKAN_SHOWER',
      'PERBAIKAN_WASTAFEL',
      'PERBAIKAN_KUNCI_PINTU',
      'PENYETUAIAN_ENGSEL_PINTU',
      'PENGGANTIAN_HANDLE',
      'PERBAIKAN_PLAFON',
      'PERBAIKAN_DINDING',
      'PENGECATAN_MINOR',
      'PERBAIKAN_LEMARI_KABINET',
      'PERBAIKAN_LACI_ENGSEL',
      'PEMASANGAN_RAK',
      'INSPEKSI_KERUSAKAN_UNIT',
      'PERBAIKAN_MINOR_UMUM',
      'KUNJUNGAN_DIAGNOSIS_TEKNISI',
    ]);
    for (const service of STARTER_PACK_SERVICES) {
      assert.ok(
        starterPackCategoryCodes().includes(service.categoryCode),
        `${service.code} references a known category`,
      );
    }
  });

  it('imports no price — the pack is identity only', () => {
    const serialized = JSON.stringify([
      ...STARTER_PACK_CATEGORIES,
      ...STARTER_PACK_SERVICES,
    ]);
    assert.ok(!serialized.includes('unitPrice'));
    assert.ok(!serialized.includes('price'));
    assert.ok(!serialized.includes('nominal'));
  });

  it('validates the category and availability grammars at the parser layer', () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const category = parseCreateServiceCategoryBody({
      clientId: uuid,
      code: 'ac_ventilasi',
      name: 'AC & Ventilasi',
    });
    assert.equal(category.code, 'AC_VENTILASI');

    const thrownDetails = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        return JSON.stringify((error as any)?.details ?? error);
      }
      return '';
    };

    assert.match(
      thrownDetails(() =>
        parseCreateServiceCategoryBody({ clientId: 'x', code: 'ac', name: 'x' }),
      ),
      /clientId/,
    );
    assert.match(
      thrownDetails(() =>
        parseCreateServiceCategoryBody({ clientId: uuid, code: 'a', name: 'x' }),
      ),
      /code/,
    );
    assert.match(
      thrownDetails(() => parseAvailabilityGrantBody({ buildingId: 'not-a-uuid' })),
      /buildingId/,
    );

    const read = parseServiceCatalogReadQuery({
      clientId: uuid,
      buildingId: '22222222-2222-2222-2222-222222222222',
      currency: 'IDR',
    });
    assert.equal(read.currency, 'IDR');
    assert.equal(read.buildingId, '22222222-2222-2222-2222-222222222222');
    assert.match(
      thrownDetails(() => parseServiceCatalogReadQuery({ currency: 'XXX' })),
      /currency/,
    );
  });

  it('registers migration 0473 last in the migrations array', () => {
    const source = readFileSync(
      'src/database/migrations/index.ts',
      'utf8',
    );
    assert.match(source, /migration0473ServiceCatalogStarter/);
    const arrayStart = source.indexOf(
      'export const migrations: readonly Migration[] = [',
    );
    const arrayBody = source.slice(arrayStart);
    const lastIndex = arrayBody.lastIndexOf('migration0473ServiceCatalogStarter');
    assert.ok(lastIndex > 0, '0473 must be present');
    assert.equal(
      arrayBody
        .slice(lastIndex)
        .replace(/[,\s;\]\n]/g, '')
        .length,
      'migration0473ServiceCatalogStarter'.length,
      '0473 must be the last migration',
    );
  });

  it('mounts the Service Catalog Starter router in the central registry', () => {
    const source = readFileSync('src/routes/index.ts', 'utf8');
    assert.match(source, /createServiceCatalogMasterRouter\(\)/);
    const routesSource = readFileSync(
      'src/modules/service-catalog-master/service-catalog-master.routes.ts',
      'utf8',
    );
    for (const path of [
      '/service-catalog/catalog',
      '/service-catalog/service-categories',
      '/service-catalog/service-categories/:id/deactivate',
      '/service-catalog/entries/:serviceCatalogId/availability',
      '/service-catalog/entries/:serviceCatalogId/category',
      '/service-catalog/starter-pack/import',
    ]) {
      assert.ok(routesSource.includes(path), `route ${path} registered`);
    }
    assert.match(routesSource, /service_catalog\.read/);
    assert.match(routesSource, /service_catalog\.manage/);
  });
});

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — OpenAPI documentation', () => {
  it('documents the starter surface with the permission boundary', async () => {
    const spec = parse(readFileSync('docs/api/openapi.yaml', 'utf8')) as any;
    const expectations: [string, string, string][] = [
      ['/service-catalog/catalog', 'get', 'service_catalog.read'],
      ['/service-catalog/service-categories', 'get', 'service_catalog.read'],
      ['/service-catalog/service-categories', 'post', 'service_catalog.manage'],
      ['/service-catalog/service-categories/{id}', 'get', 'service_catalog.read'],
      ['/service-catalog/service-categories/{id}', 'patch', 'service_catalog.manage'],
      [
        '/service-catalog/service-categories/{id}/deactivate',
        'post',
        'service_catalog.manage',
      ],
      [
        '/service-catalog/entries/{serviceCatalogId}/availability',
        'get',
        'service_catalog.read',
      ],
      [
        '/service-catalog/entries/{serviceCatalogId}/availability',
        'post',
        'service_catalog.manage',
      ],
      [
        '/service-catalog/entries/{serviceCatalogId}/category',
        'post',
        'service_catalog.manage',
      ],
      ['/service-catalog/starter-pack/import', 'post', 'service_catalog.manage'],
    ];
    for (const [path, method, permission] of expectations) {
      const operation = spec.paths[path]?.[method];
      assert.ok(operation, `${method} ${path} is documented`);
      assert.ok(operation.operationId, `${method} ${path} has an operationId`);
      assert.equal(
        operation['x-required-permission'],
        permission,
        `${method} ${path} permission`,
      );
    }
    assert.ok(spec.components.schemas.ServiceCategory);
    assert.ok(spec.components.schemas.ServiceCatalogReadModel);
    assert.ok(spec.components.schemas.StarterPackImportResult);
  });
});

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — starter import (governed)', () => {
  it('imports the frozen pack as ACTIVE, STARTER_PACK rows', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const response = await importStarterPack(fx.client.id);
    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.equal(data.categoriesCreated, 8);
    assert.equal(data.servicesCreated, 24);
    assert.equal(data.totalCategories, 8);
    assert.equal(data.totalServices, 24);
    assert.equal(data.replayed, false);

    const categories = await api()
      .get('/api/v1/service-catalog/service-categories')
      .query({ clientId: fx.client.id })
      .set(auth());
    assert.equal(categories.status, 200);
    assert.equal(categories.body.data.length, 8);
    assert.equal(
      categories.body.data.filter((c: any) => c.status === 'ACTIVE').length,
      8,
    );

    const read = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fx.client.id })
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.services.length, 24);
    assert.equal(read.body.data.categories.length, 8);
    for (const service of read.body.data.services) {
      assert.equal(service.source, 'STARTER_PACK');
      assert.equal(service.status, 'ACTIVE');
      assert.equal(service.referencePrice, null, 'no price is composed without scope');
    }
  });

  it('is idempotent: the same Idempotency-Key replays and creates nothing new', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const key = randomUUID();
    const first = await importStarterPack(fx.client.id, adminToken, key);
    assert.equal(first.status, 201);
    assert.equal(first.body.data.replayed, false);

    const second = await importStarterPack(fx.client.id, adminToken, key);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.replayed, true);
    // A replay returns the recorded summary — the guarantee is no new rows.
    assert.equal(second.body.data.categoriesCreated, 8);
    assert.equal(second.body.data.servicesCreated, 24);

    const read = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fx.client.id })
      .set(auth());
    assert.equal(read.body.data.services.length, 24);
    assert.equal(read.body.data.categories.length, 8);
  });

  it('protects against duplicate codes across separate imports', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const first = await importStarterPack(fx.client.id);
    assert.equal(first.body.data.servicesCreated, 24);
    // A second, key-distinct import must create nothing and skip everything.
    const second = await importStarterPack(fx.client.id);
    assert.equal(second.status, 201);
    assert.equal(second.body.data.replayed, false);
    assert.equal(second.body.data.categoriesCreated, 0);
    assert.equal(second.body.data.categoriesSkipped, 8);
    assert.equal(second.body.data.servicesCreated, 0);
    assert.equal(second.body.data.servicesSkipped, 24);
  });

  it('keeps concurrent imports safe (no duplicate codes, both succeed)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const [a, b] = await Promise.all([
      importStarterPack(fx.client.id),
      importStarterPack(fx.client.id),
    ]);
    assert.ok([a.status, b.status].includes(201));
    const created =
      Number(a.body.data.servicesCreated) + Number(b.body.data.servicesCreated);
    const skipped =
      Number(a.body.data.servicesSkipped) + Number(b.body.data.servicesSkipped);
    assert.equal(created, 24, 'the pack is created exactly once across races');
    assert.equal(skipped, 24);
  });

  it('rejects the import for an out-of-reach Client without leaking existence', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const other = await fixture(null); // no assignment for the admin
    const response = await importStarterPack(other.client.id);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The reachable Client is unaffected.
    const read = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fx.client.id })
      .set(auth());
    assert.equal(read.status, 200);
  });

  it('requires the Idempotency-Key header', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const response = await api()
      .post('/api/v1/service-catalog/starter-pack/import')
      .set(auth())
      .send({ clientId: fx.client.id });
    assert.equal(response.status, 400);
  });

  it('audits the import with an operational event', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    await importStarterPack(fx.client.id);
    const result = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM operational_events
        WHERE event_type = $1 AND entity_id = $2`,
      ['SERVICE_CATALOG_STARTER_PACK_IMPORTED', fx.client.id],
    );
    assert.equal(Number(result.rows[0]?.count ?? '0'), 1);
  });
});

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — category CRUD + lifecycle', () => {
  it('creates, reads, edits and deactivates a category', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await api()
      .post('/api/v1/service-catalog/service-categories')
      .set(auth())
      .send({
        clientId: fx.client.id,
        code: 'cat_test',
        name: 'Test Category',
        description: 'desc',
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.code, 'CAT_TEST');
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.source, 'MANUAL');
    const id = created.body.data.id;

    const read = await api()
      .get(`/api/v1/service-catalog/service-categories/${id}`)
      .set(auth());
    assert.equal(read.status, 200);

    const updated = await api()
      .patch(`/api/v1/service-catalog/service-categories/${id}`)
      .set(auth())
      .send({ name: 'Renamed' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Renamed');
    assert.equal(updated.body.data.code, 'CAT_TEST', 'code is immutable');

    const deactivated = await api()
      .post(`/api/v1/service-catalog/service-categories/${id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const again = await api()
      .post(`/api/v1/service-catalog/service-categories/${id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(again.status, 409);
  });

  it('rejects a duplicate category code within the same Client', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const body = {
      clientId: fx.client.id,
      code: 'DUP_CAT',
      name: 'Dup',
    };
    const first = await api()
      .post('/api/v1/service-catalog/service-categories')
      .set(auth())
      .send(body);
    assert.equal(first.status, 201);

    const second = await api()
      .post('/api/v1/service-catalog/service-categories')
      .set(auth())
      .send(body);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'SERVICE_CATEGORY_CODE_ALREADY_EXISTS');
  });

  it('refuses to deactivate a category that still has ACTIVE services', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    await importStarterPack(fx.client.id);
    const categories = await api()
      .get('/api/v1/service-catalog/service-categories')
      .query({ clientId: fx.client.id })
      .set(auth());
    const category = categories.body.data[0];
    const response = await api()
      .post(`/api/v1/service-catalog/service-categories/${category.id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'SERVICE_CATEGORY_IN_USE');
  });
});

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — availability + linking', () => {
  it('grants, lists and revokes building availability', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    await importStarterPack(fx.client.id);
    const items = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fx.client.id })
      .set(auth());
    const service = items.body.data.services[0];
    assert.equal(service.availabilityScope, 'CLIENT_WIDE');
    assert.equal(service.availableInBuilding, null);

    const grant = await api()
      .post(`/api/v1/service-catalog/entries/${service.id}/availability`)
      .set(auth())
      .send({ buildingId: fx.building.id });
    assert.equal(grant.status, 201);
    const availabilityId = grant.body.data.id;
    assert.equal(grant.body.data.status, 'ACTIVE');

    const duplicate = await api()
      .post(`/api/v1/service-catalog/entries/${service.id}/availability`)
      .set(auth())
      .send({ buildingId: fx.building.id });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'SERVICE_CATALOG_AVAILABILITY_ALREADY_EXISTS',
    );

    const listed = await api()
      .get(`/api/v1/service-catalog/entries/${service.id}/availability`)
      .set(auth());
    assert.equal(listed.body.data.length, 1);

    const scoped = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fx.client.id, buildingId: fx.building.id })
      .set(auth());
    const scopedItem = scoped.body.data.services.find(
      (s: any) => s.id === service.id,
    );
    assert.equal(scopedItem.availabilityScope, 'BUILDING_SCOPED');
    assert.equal(scopedItem.availableInBuilding, true);

    const revoked = await api()
      .post(
        `/api/v1/service-catalog/entries/${service.id}/availability/${availabilityId}/deactivate`,
      )
      .set(auth())
      .send({});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.status, 'INACTIVE');
  });

  it('links a Service Item to a governed Service Category', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    await importStarterPack(fx.client.id);
    const categories = await api()
      .get('/api/v1/service-catalog/service-categories')
      .query({ clientId: fx.client.id })
      .set(auth());
    const category = categories.body.data.find(
      (c: any) => c.code === 'AC_VENTILASI',
    );

    const manual = await api()
      .post('/api/v1/service-catalog/entries')
      .set(auth())
      .send({
        clientId: fx.client.id,
        code: `SVC_LINK_${suffix()}`,
        name: 'Link Me',
        category: 'LEGACY',
      });
    assert.equal(manual.status, 201);

    const linked = await api()
      .post(`/api/v1/service-catalog/entries/${manual.body.data.id}/category`)
      .set(auth())
      .send({ serviceCategoryId: category.id });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.data.categoryId, category.id);
    assert.equal(linked.body.data.categoryCode, 'AC_VENTILASI');
    assert.equal(linked.body.data.categoryName, 'AC & Ventilasi');
    assert.equal(linked.body.data.name, 'Link Me');
  });
});

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — access control', () => {
  it('returns 401 without a token and 403 without the permission', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();

    const unauth = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fx.client.id });
    assert.equal(unauth.status, 401);

    const plainToken = await createPlainSession();
    const forbidden = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fx.client.id })
      .set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates catalog reads across Clients (no existence oracle)', async (t) => {
    if (!requireDatabase(t)) return;
    const fxA = await fixture();
    await importStarterPack(fxA.client.id);
    const fxB = await fixture();

    const read = await api()
      .get('/api/v1/service-catalog/catalog')
      .query({ clientId: fxB.client.id })
      .set(auth());
    // The caller cannot reach Client B: an empty model, no leak.
    assert.equal(read.status, 200);
    assert.equal(read.body.data.services.length, 0);
    assert.equal(read.body.data.categories.length, 0);
  });
});
