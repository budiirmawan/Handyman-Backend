import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { handymanCommonMaterialProfileService } from '../src/modules/handyman-catalog';
import { handymanServiceVariantService } from '../src/modules/handyman-catalog';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { propertyService } from '../src/modules/properties';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-02 PART 02 — focused tests for the Handyman Common Material
 * Profile (bounded discovery association on top of the existing
 * service-catalog / handyman variant / inventory-item masters).
 * Domain/service level only; no HTTP in this PART. Each case builds its own
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
    TRUNCATE handyman_common_material_profiles, handyman_service_variants,
      service_catalog, price_catalog_entries, inventory_items,
      units_of_measure, operational_events, buildings, properties, clients,
      users, roles, permissions CASCADE
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

async function fixture() {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Handyman Material Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Handyman Material Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Handyman Material Test Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  return { client, property, building };
}

async function serviceEntry(clientId: string) {
  return serviceCatalogService.createServiceCatalogEntry({
    clientId,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
}

async function item(clientId: string, uomId?: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `MAT_${suffix()}`,
    name: 'Pipe Fitting',
    itemType: 'MATERIAL',
    ...(uomId ? { uomId } : {}),
  }, adminUserId);
}

async function insertUom(clientId: string): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  return id;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

const BASE_PROFILE = {
  specification: 'PVC schedule 40',
  compatibility: 'Compatible with 20mm conduits',
  typicalQuantity: 2.5,
  commonality: 'COMMON' as const,
  customerMaterialOption: 'CUSTOMER_CHOICE' as const,
};

describe('CR-HM-02 PART 02 — handyman common material profile', () => {
  it('1: creates a service-level common material profile', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    const material = await item(f.client.id);
    const profile = await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId);
    assert.ok(profile.id);
    assert.equal(profile.clientId, f.client.id); // derived, never supplied
    assert.equal(profile.serviceCatalogId, service.id);
    assert.equal(profile.serviceVariantId, null);
    assert.equal(profile.inventoryItemId, material.id);
    assert.equal(profile.specification, 'PVC schedule 40');
    assert.equal(profile.compatibility, 'Compatible with 20mm conduits');
    assert.equal(profile.typicalQuantity, 2.5);
    assert.equal(profile.commonality, 'COMMON');
    assert.equal(profile.customerMaterialOption, 'CUSTOMER_CHOICE');
    assert.equal(profile.status, 'ACTIVE');
    assert.equal(profile.createdByUserId, adminUserId);
  });

  it('2: creates a variant-specific profile alongside a service-level one', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    const variant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service.id,
        code: 'STD-FIX',
        name: 'Standard Fix',
      }, adminUserId);
    const material = await item(f.client.id);
    const serviceLevel = await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId);
    assert.equal(serviceLevel.serviceVariantId, null);
    const variantLevel = await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        serviceVariantId: variant.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
        typicalQuantity: 1,
      }, adminUserId);
    assert.equal(variantLevel.serviceVariantId, variant.id);
    assert.equal(variantLevel.clientId, f.client.id);
  });

  it('3: rejects a variant belonging to another service', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const serviceA = await serviceEntry(f.client.id);
    const serviceB = await serviceEntry(f.client.id);
    const variantOfB = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: serviceB.id,
        code: 'B-ONLY',
        name: 'B-only variant',
      }, adminUserId);
    const material = await item(f.client.id);
    await assert.rejects(
      handymanCommonMaterialProfileService.createHandymanCommonMaterialProfile({
        serviceCatalogId: serviceA.id,
        serviceVariantId: variantOfB.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_COMMON_MATERIAL_PROFILE_SCOPE_MISMATCH',
    );
  });

  it('4: rejects cross-client material', async (t) => {
    if (!requireDatabase(t)) return;
    const a = await fixture();
    const b = await fixture();
    const serviceA = await serviceEntry(a.client.id);
    const materialOfB = await inventoryItemService.createInventoryItem({
      clientId: b.client.id,
      code: `MAT_${suffix()}`,
      name: 'Other Client Material',
      itemType: 'MATERIAL',
    }, adminUserId);
    await assert.rejects(
      handymanCommonMaterialProfileService.createHandymanCommonMaterialProfile({
        serviceCatalogId: serviceA.id,
        inventoryItemId: materialOfB.id,
        ...BASE_PROFILE,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_COMMON_MATERIAL_PROFILE_SCOPE_MISMATCH',
    );
  });

  it('5: rejects the duplicate association at its level', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    const material = await item(f.client.id);
    await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId);
    await assert.rejects(
      handymanCommonMaterialProfileService.createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_COMMON_MATERIAL_PROFILE_ALREADY_EXISTS',
    );
    // the same material is still attachable to a VARIANT of the service
    // (different association identity), proving level-scoped uniqueness
    const variant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service.id, code: 'LVL-01', name: 'Level one',
      }, adminUserId);
    const variantLevel = await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        serviceVariantId: variant.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId);
    assert.ok(variantLevel.id);
  });

  it('6: rejects an inactive authoritative reference', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const service = await serviceEntry(f.client.id);
    const material = await item(f.client.id);
    await inventoryItemService.updateInventoryItemStatus(
      material.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await assert.rejects(
      handymanCommonMaterialProfileService.createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) ===
          'HANDYMAN_COMMON_MATERIAL_PROFILE_REFERENCE_INACTIVE',
    );
  });

  it('7: scoped read/list returns only the correct client/service/variant metadata', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const other = await fixture();
    const service1 = await serviceEntry(f.client.id);
    const service2 = await serviceEntry(f.client.id);
    const variant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service1.id, code: 'V-MET', name: 'Meta variant',
      }, adminUserId);
    const mat1 = await item(f.client.id);
    const mat2 = await item(f.client.id);
    const matOther = await item(other.client.id);
    await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service1.id, inventoryItemId: mat1.id, ...BASE_PROFILE,
      }, adminUserId);
    await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service1.id,
        serviceVariantId: variant.id,
        inventoryItemId: mat2.id,
        ...BASE_PROFILE,
        commonality: 'OCCASIONAL',
      }, adminUserId);
    await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service2.id, inventoryItemId: mat2.id, ...BASE_PROFILE,
        commonality: 'RARE',
      }, adminUserId);
    const otherService = await serviceCatalogService.createServiceCatalogEntry({
      clientId: other.client.id,
      code: `HM${suffix()}`,
      name: 'Other Service',
      category: 'HANDYMAN',
    }, adminUserId);
    await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: otherService.id,
        inventoryItemId: matOther.id,
        ...BASE_PROFILE,
      }, adminUserId);

    const clientScope = await handymanCommonMaterialProfileService
      .listHandymanCommonMaterialProfiles(
        { clientId: f.client.id }, adminUserId,
      );
    assert.equal(clientScope.length, 3);
    for (const p of clientScope) {
      assert.equal(p.clientId, f.client.id);
    }
    const svcOnly = await handymanCommonMaterialProfileService
      .listHandymanCommonMaterialProfiles(
        { clientId: f.client.id, serviceCatalogId: service2.id }, adminUserId,
      );
    assert.equal(svcOnly.length, 1);
    assert.equal(svcOnly[0].commonality, 'RARE');
    const variantOnly = await handymanCommonMaterialProfileService
      .listHandymanCommonMaterialProfiles(
        { clientId: f.client.id, serviceVariantId: variant.id }, adminUserId,
      );
    assert.equal(variantOnly.length, 1);
    assert.equal(variantOnly[0].commonality, 'OCCASIONAL');
    assert.equal(variantOnly[0].serviceVariantId, variant.id);
    assert.equal(variantOnly[0].specification, 'PVC schedule 40');
    assert.equal(variantOnly[0].customerMaterialOption, 'CUSTOMER_CHOICE');
  });

  it('8: reference price composes from the price-catalog lookup and is never persisted', async (t) => {
    if (!requireDatabase(t) || !pool) return;
    const f = await fixture();
    const uomId = await insertUom(f.client.id);
    const service = await serviceEntry(f.client.id);
    const material = await inventoryItemService.createInventoryItem({
      clientId: f.client.id,
      code: `MAT_${suffix()}`,
      name: 'Copper Pipe',
      itemType: 'MATERIAL',
      uomId,
    }, adminUserId);
    const profile = await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        inventoryItemId: material.id,
        ...BASE_PROFILE,
      }, adminUserId);

    // governed Client monetary context (per-client currency policy gate)
    await clientMonetaryContextService.setClientMonetaryContext({
      clientId: f.client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes: ['IDR', 'SGD'],
    }, adminUserId);

    // governed price authority: DRAFT → ACTIVE client-wide IDR reference
    const entry = await priceCatalogEntryService.createPriceCatalogEntry({
      clientId: f.client.id,
      sourceMode: 'MATERIAL',
      itemId: material.id,
      uomId,
      currency: 'IDR',
      unitPrice: 25000,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
    }, adminUserId);
    await priceCatalogEntryService.activatePriceCatalogEntry(
      entry.id,
      adminUserId,
    );

    const priced = await handymanCommonMaterialProfileService
      .describeHandymanCommonMaterialProfile(profile.id, adminUserId, {
        buildingId: f.building.id,
        currency: 'IDR',
      });
    assert.ok(priced.referencePrice);
    assert.equal(priced.referencePrice.unitPrice, 25000);
    assert.equal(priced.referencePrice.currency, 'IDR');
    assert.equal(priced.referencePrice.scopeTier, 'CLIENT_WIDE');

    // no applicable price for a different currency → fail-closed null
    const unpriced = await handymanCommonMaterialProfileService
      .describeHandymanCommonMaterialProfile(profile.id, adminUserId, {
        buildingId: f.building.id,
        currency: 'SGD',
      });
    assert.equal(unpriced.referencePrice, null);

    // structural: the profile table holds NO price columns (no copying)
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_common_material_profiles'`,
    );
    for (const row of cols.rows) {
      assert.ok(
        !/price/i.test(row.column_name),
        `unexpected price column ${row.column_name}`,
      );
    }
  });
});
