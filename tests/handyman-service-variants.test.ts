import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { handymanServiceVariantService } from '../src/modules/handyman-catalog';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { propertyService } from '../src/modules/properties';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-02 PART 01 — focused tests for the Handyman Service Variant
 * foundation on top of the existing service-catalog master. Domain/service
 * level only; no HTTP surface exists in this PART. Each case builds its own
 * fixture so tests stay isolated in the shared database.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE handyman_service_variants, service_catalog,
      operational_events, buildings, properties, clients, users, roles,
      permissions CASCADE
  `);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

async function fixture(assignUserId: string | null = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Handyman Variant Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Handyman Variant Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Handyman Variant Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function serviceEntry(clientId: string, overrides: Record<string, unknown> = {}) {
  return serviceCatalogService.createServiceCatalogEntry({
    clientId,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
    ...overrides,
  }, adminUserId);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('CR-HM-02 PART 01 — handyman service variant foundation', () => {
  it('1: creates a variant against an ACTIVE service entry', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    const variant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service.id,
        code: ' std-fix ',
        name: 'Standard Fix',
        description: 'Baseline standard fix presentation.',
      }, adminUserId);
    assert.ok(variant.id);
    assert.equal(variant.serviceCatalogId, service.id);
    // tenant isolation root is derived from the parent, never the caller
    assert.equal(variant.clientId, f.client.id);
    assert.equal(variant.code, 'STD-FIX');
    assert.equal(variant.name, 'Standard Fix');
    assert.equal(variant.description, 'Baseline standard fix presentation.');
    assert.equal(variant.status, 'ACTIVE');
    assert.equal(variant.createdByUserId, adminUserId);
    assert.ok(!Number.isNaN(Date.parse(variant.createdAt)));
  });

  it('2: tenant/client isolation — reads stay inside the client scope', async (t) => {
    if (!requireDatabase(t)) return;
    const a = await fixture();
    const b = await fixture();
    const serviceA = await serviceEntry(a.client.id);
    const serviceB = await serviceEntry(b.client.id);
    await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: serviceA.id,
      code: 'FIX-A',
      name: 'Fix A',
    }, adminUserId);
    await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: serviceB.id,
      code: 'FIX-B',
      name: 'Fix B',
    }, adminUserId);
    const listA = await handymanServiceVariantService
      .listHandymanServiceVariants({ clientId: a.client.id }, adminUserId);
    assert.equal(listA.length, 1);
    assert.equal(listA[0].clientId, a.client.id);
    assert.equal(listA[0].code, 'FIX-A');
    // a cross-client service id structurally yields an empty, never a leak
    const cross = await handymanServiceVariantService
      .listHandymanServiceVariants(
        { clientId: a.client.id, serviceCatalogId: serviceB.id },
        adminUserId,
      );
    assert.equal(cross.length, 0);
  });

  it('3: invalid or foreign service reference is rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    const before = (await handymanServiceVariantService
      .listHandymanServiceVariants({ clientId: f.client.id }, adminUserId))
      .length;
    // well-formed but unknown reference → NOT_FOUND, nothing created
    await assert.rejects(
      handymanServiceVariantService.createHandymanServiceVariant({
        serviceCatalogId: randomUUID(),
        code: 'NOPE-01',
        name: 'Nope',
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'SERVICE_CATALOG_NOT_FOUND',
    );
    // malformed reference → validation failure, nothing created
    await assert.rejects(
      handymanServiceVariantService.createHandymanServiceVariant({
        serviceCatalogId: 'not-a-real-id',
        code: 'NOPE-02',
        name: 'Nope',
      }, adminUserId),
      (error: unknown) => errorCode(error) === 'VALIDATION_ERROR',
    );
    assert.equal(
      (await handymanServiceVariantService
        .listHandymanServiceVariants({ clientId: f.client.id }, adminUserId))
        .length,
      before,
    );
    // a still-valid service id remains the only attachable reference
    assert.ok(service.id);
  });

  it('4: duplicate variant identity is rejected per service', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: service.id,
      code: 'DUP-01',
      name: 'First',
    }, adminUserId);
    await assert.rejects(
      handymanServiceVariantService.createHandymanServiceVariant({
        serviceCatalogId: service.id,
        code: ' dup-01 ',
        name: 'Second with same code',
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_SERVICE_VARIANT_CODE_ALREADY_EXISTS',
    );
    // same code under a DIFFERENT service is a distinct identity — allowed
    const other = await serviceEntry(f.client.id);
    const ok = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: other.id,
        code: 'DUP-01',
        name: 'Same code, other service',
      }, adminUserId);
    assert.equal(ok.code, 'DUP-01');
    assert.equal(ok.serviceCatalogId, other.id);
  });

  it('5: inactive service master rejects new variants (reference-master idiom)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    await serviceCatalogService.deactivateServiceCatalogEntry(
      service.id,
      adminUserId,
    );
    await assert.rejects(
      handymanServiceVariantService.createHandymanServiceVariant({
        serviceCatalogId: service.id,
        code: 'INACT-1',
        name: 'Inactive master attempt',
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'SERVICE_CATALOG_NOT_ACTIVE',
    );
  });

  it('6: read/list foundation returns only the correct client/service scope', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const svc1 = await serviceEntry(f.client.id);
    const svc2 = await serviceEntry(f.client.id);
    await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: svc1.id, code: 'S1-AAA', name: 'S1 A',
    }, adminUserId);
    await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: svc1.id, code: 'S1-BBB', name: 'S1 B',
    }, adminUserId);
    await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: svc2.id, code: 'S2-CCC', name: 'S2 C',
    }, adminUserId);
    const all = await handymanServiceVariantService
      .listHandymanServiceVariants({ clientId: f.client.id }, adminUserId);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((v) => v.code), ['S1-AAA', 'S1-BBB', 'S2-CCC']);
    const onlySvc1 = await handymanServiceVariantService
      .listHandymanServiceVariants(
        { clientId: f.client.id, serviceCatalogId: svc1.id },
        adminUserId,
      );
    assert.deepEqual(onlySvc1.map((v) => v.code), ['S1-AAA', 'S1-BBB']);
    const activeOnly = await handymanServiceVariantService
      .listHandymanServiceVariants(
        { clientId: f.client.id, status: 'ACTIVE' },
        adminUserId,
      );
    assert.equal(activeOnly.length, 3);
    for (const v of activeOnly) {
      assert.equal(v.clientId, f.client.id);
      assert.equal(v.status, 'ACTIVE');
    }
  });
});
