import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { handymanProviderContextService } from '../src/modules/handyman-providers';
import type { CreateHandymanProviderContextInput } from '../src/modules/handyman-providers';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-04 PART 01 — focused tests for the Handyman Provider Context
 * (FROZEN F1/F8/F9/F10).
 *
 * Ten cases prove: bounded context creation under the vendor authority
 * (clientId derived server-side), one-context-per-vendor uniqueness,
 * cross-client rejection, the bounded ACTIVE ⇄ INACTIVE lifecycle with
 * history preserved, anti-smuggle actor authentication, atomic
 * create/status-change + journal, and zero mutation of the vendor master
 * / FM / SaaS / assignment surfaces.
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
  await pool.query(`TRUNCATE handyman_provider_contexts,
    handyman_request_referrals, handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_service_variants, handyman_discipline_service_associations,
    service_catalog, vendor_workforce_bindings, vendor_capabilities,
    vendor_pics, vendor_categories, vendors,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
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
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

async function tableCount(name: string): Promise<number> {
  const result = await q(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** Client + assigned building access (admin realm) + a valid vendor. */
async function clientWithRealm() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  return { client, property, building };
}

async function vendorFixture() {
  const realm = await clientWithRealm();
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Acme Providers',
  });
  return { ...realm, vendor };
}

describe('CR-HM-04 PART 01 — Handyman provider context', () => {
  it('1: valid vendor → ACTIVE Handyman provider context', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const context = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: f.vendor.id }, adminUserId);
    assert.ok(context.id);
    assert.equal(context.vendorId, f.vendor.id);
    assert.equal(context.clientId, f.client.id);
    assert.equal(context.status, 'ACTIVE');
    assert.equal(context.createdByUserId, adminUserId);
    assert.ok(!Number.isNaN(Date.parse(context.createdAt)));
    assert.deepEqual(Object.keys(context).sort(), [
      'clientId', 'createdAt', 'createdByUserId', 'id', 'status',
      'updatedAt', 'vendorId',
    ]);
  });

  it('2: clientId + scope authority is derived server-side from the vendor master', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const foreign = await clientWithRealm();
    const smuggled = {
      vendorId: f.vendor.id,
      clientId: foreign.client.id,
      vendorName: 'Do not duplicate me',
      email: 'not-copied@vendor.example.com',
    } as unknown as CreateHandymanProviderContextInput;
    const context = await handymanProviderContextService
      .createHandymanProviderContext(smuggled, adminUserId);
    assert.equal(context.clientId, f.client.id);
    assert.equal(context.vendorId, f.vendor.id);
    const rows = await q(
      `SELECT client_id, vendor_id, status FROM handyman_provider_contexts
        WHERE id = $1`,
      [context.id],
    );
    assert.equal(rows.rows[0].client_id, f.client.id);
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_provider_contexts'`,
    );
    assert.deepEqual(
      cols.rows.map((r: { column_name: string }) => r.column_name).sort(),
      ['client_id', 'created_at', 'created_by_user_id', 'id', 'status',
       'updated_at', 'vendor_id'],
      'context carries no vendor identity/contact/compliance duplication',
    );
  });

  it('3: duplicate provider context is rejected (race-safe 409)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    await handymanProviderContextService.createHandymanProviderContext(
      { vendorId: f.vendor.id }, adminUserId);
    const before = await tableCount('handyman_provider_contexts');
    await assert.rejects(
      handymanProviderContextService.createHandymanProviderContext(
        { vendorId: f.vendor.id }, adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_PROVIDER_CONTEXT_ALREADY_EXISTS',
    );
    assert.equal(await tableCount('handyman_provider_contexts'), before);
  });

  it('4: inaccessible/cross-client vendor is rejected (403)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    await clientWithRealm();
    // outsider admin: full RBAC but assigned only to a foreign building
    const outsider = await createAdminUser();
    const outsiderRealm = await clientWithRealm();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: outsiderRealm.building.id,
    });
    const before = await tableCount('handyman_provider_contexts');
    await assert.rejects(
      handymanProviderContextService.createHandymanProviderContext(
        { vendorId: f.vendor.id }, outsider.userId),
      (e: unknown) => errorCode(e) === 'BUILDING_ACCESS_DENIED',
    );
    assert.equal(await tableCount('handyman_provider_contexts'), before);
  });

  it('5: ACTIVE → INACTIVE (state preserved, history journaled)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const created = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: f.vendor.id }, adminUserId);
    const updated = await handymanProviderContextService
      .setHandymanProviderContextStatus(created.id, 'INACTIVE', adminUserId);
    assert.equal(updated.status, 'INACTIVE');
    assert.equal(updated.createdByUserId, created.createdByUserId);
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
    const journal = await q(
      `SELECT event_type, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_PROVIDER_CONTEXT' AND entity_id = $1
        ORDER BY occurred_at ASC, created_at ASC`,
      [created.id],
    );
    assert.deepEqual(
      journal.rows.map((r: { event_type: string }) => r.event_type),
      [
        'HANDYMAN_PROVIDER_CONTEXT_CREATED',
        'HANDYMAN_PROVIDER_CONTEXT_STATUS_CHANGED',
      ],
    );
    assert.deepEqual(journal.rows[1].metadata, {
      providerContextId: created.id,
      vendorId: f.vendor.id,
      fromStatus: 'ACTIVE',
      toStatus: 'INACTIVE',
    });
  });

  it('6: INACTIVE → ACTIVE reactivation works', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const created = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: f.vendor.id }, adminUserId);
    await handymanProviderContextService
      .setHandymanProviderContextStatus(created.id, 'INACTIVE', adminUserId);
    const back = await handymanProviderContextService
      .setHandymanProviderContextStatus(created.id, 'ACTIVE', adminUserId);
    assert.equal(back.status, 'ACTIVE');
  });

  it('7: invalid status vocabulary and same-state transitions are rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const created = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: f.vendor.id }, adminUserId);
    await assert.rejects(
      handymanProviderContextService.setHandymanProviderContextStatus(
        created.id, 'SUSPENDED', adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_PROVIDER_CONTEXT_INVALID_STATUS',
    );
    await assert.rejects(
      handymanProviderContextService.setHandymanProviderContextStatus(
        created.id, 'ACTIVE', adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_PROVIDER_CONTEXT_INVALID_STATUS',
    );
    // no delete surface exists
    assert.deepEqual(
      Object.keys(handymanProviderContextService).sort(),
      [
        'createHandymanProviderContext',
        'getHandymanProviderContextByVendor',
        'setHandymanProviderContextStatus',
      ],
    );
  });

  it('8: actor can never be smuggled from vendor/PIC/context keys', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const smuggled = {
      vendorId: f.vendor.id,
      createdByUserId: randomUUID(),
      actorUserId: randomUUID(),
      vendorPicId: randomUUID(),
      tenantPicId: randomUUID(),
      channelAttributionId: randomUUID(),
    } as unknown as CreateHandymanProviderContextInput;
    const context = await handymanProviderContextService
      .createHandymanProviderContext(smuggled, adminUserId);
    assert.equal(context.createdByUserId, adminUserId);
    const journal = await q(
      `SELECT actor_user_id FROM operational_events
        WHERE entity_id = $1
          AND event_type = 'HANDYMAN_PROVIDER_CONTEXT_CREATED'`,
      [context.id],
    );
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
  });

  it('9: create/state change + journal are atomic (failure leaves zero partial commits)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const beforeCtx = await tableCount('handyman_provider_contexts');
    const beforeEv = await tableCount('operational_events');
    const created = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: f.vendor.id }, adminUserId);
    assert.equal(await tableCount('handyman_provider_contexts'), beforeCtx + 1);
    assert.equal(await tableCount('operational_events'), beforeEv + 1);
    // forced failure: status change for a nonexistent context actor realm
    await assert.rejects(
      handymanProviderContextService.setHandymanProviderContextStatus(
        created.id, 'INACTIVE', randomUUID()),
    );
    assert.equal(await tableCount('operational_events'), beforeEv + 1);
    const rows = await q(
      'SELECT status FROM handyman_provider_contexts WHERE id = $1',
      [created.id],
    );
    assert.equal(rows.rows[0].status, 'ACTIVE');
  });

  it('10: vendor master / FM / SaaS / assignment rows unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await vendorFixture();
    const vendorRowBefore = await q(
      'SELECT vendor_code, vendor_name, status, updated_at FROM vendors WHERE id = $1',
      [f.vendor.id],
    );
    const before = {
      vendor_pics: await tableCount('vendor_pics'),
      vendor_capabilities: await tableCount('vendor_capabilities'),
      vendor_workforce_bindings: await tableCount('vendor_workforce_bindings'),
      work_order_assignments: await tableCount('work_order_assignments'),
      tenant_service_requests: await tableCount('tenant_service_requests'),
    };
    const created = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: f.vendor.id }, adminUserId);
    await handymanProviderContextService
      .setHandymanProviderContextStatus(created.id, 'INACTIVE', adminUserId);
    await handymanProviderContextService
      .setHandymanProviderContextStatus(created.id, 'ACTIVE', adminUserId);
    for (const [name, count] of Object.entries(before)) {
      assert.equal(await tableCount(name), count, `${name} unchanged`);
    }
    const vendorRowAfter = await q(
      'SELECT vendor_code, vendor_name, status, updated_at FROM vendors WHERE id = $1',
      [f.vendor.id],
    );
    assert.deepEqual(vendorRowAfter.rows[0], vendorRowBefore.rows[0]);
  });
});
