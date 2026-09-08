import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  credentialService,
  getEffectiveUserContext,
} from '../src/modules/auth';
import { clientService } from '../src/modules/clients';
import { subscriptionService } from '../src/modules/subscriptions';
import { licenseService } from '../src/modules/licenses';
import { moduleService } from '../src/modules/modules';
import {
  entitlementRepository,
  entitlementService,
} from '../src/modules/entitlements';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { contextAccessService } from '../src/modules/context-access';
import { userService } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, subscriptions, licenses, modules,
       module_entitlements, properties, buildings, user_building_assignments,
       organizations, departments, teams, positions, workforce_profiles,
       workforce_building_assignments, external_workforce_links
     CASCADE`,
  );
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

const STARTS = '2026-01-01T00:00:00.000Z';
const ENDS = '2027-01-01T00:00:00.000Z';

async function createUserWithSession() {
  const user = await userService.createUser({
    email: `eff-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Effective Context User',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'EffPass123',
  });
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'EffPass123',
  });
  return { user, token: login.body.data.sessionToken as string };
}

async function createCommercialClientWithModule(moduleCode: string) {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Commercial Client',
  });
  const subscription = await subscriptionService.createSubscription({
    clientId: client.id,
    code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
    planCode: 'ENTERPRISE',
    startsAt: new Date(STARTS),
    endsAt: new Date(ENDS),
  });
  await licenseService.createLicense(subscription.id, {
    validFrom: new Date(STARTS),
    validUntil: new Date(ENDS),
  });
  const uniqueCode = `${moduleCode}_${randomUUID().slice(0, 8).toUpperCase()}`;
  const module = await moduleService.createModule({
    code: uniqueCode,
    name: moduleCode,
  });
  await entitlementService.createEntitlement(subscription.id, {
    moduleId: module.id,
    startsAt: new Date(STARTS),
    endsAt: new Date(ENDS),
  });
  return { client, subscription, module, moduleCode: uniqueCode };
}

async function createPropertyWithBuilding(clientId: string, code: string) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${code}`,
    name: `Property ${code}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${code}`,
    name: `Building ${code}`,
  });
  return { property, building };
}

describe('effective user context (BE-02H)', () => {
  it('returns client, property, building, and active entitlement for a single building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client, moduleCode } = await createCommercialClientWithModule('ENGINEERING');
    const { property, building } = await createPropertyWithBuilding(client.id, 'A');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });

    const context = await getEffectiveUserContext(user.id);

    assert.equal(context.context.clients.length, 1);
    assert.equal(context.context.clients[0].id, client.id);
    assert.equal(context.context.clients[0].properties[0].id, property.id);
    assert.equal(context.context.clients[0].properties[0].buildings[0].id, building.id);
    assert.deepEqual(context.entitlements, [{ moduleCode, status: 'ACTIVE' }]);
  });

  it('returns multiple buildings without duplicates', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client } = await createCommercialClientWithModule('HOUSEKEEPING');
    const { building: bA } = await createPropertyWithBuilding(client.id, 'A');
    const { building: bB } = await createPropertyWithBuilding(client.id, 'B');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: bA.id });
    await buildingAssignmentService.createAssignment(user.id, { buildingId: bB.id });

    const context = await getEffectiveUserContext(user.id);
    const buildingIds = context.context.clients
      .flatMap((c) => c.properties)
      .flatMap((p) => p.buildings)
      .map((b) => b.id)
      .sort();
    assert.deepEqual(buildingIds, [bA.id, bB.id].sort());
  });

  it('does not leak a sibling building under the same property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client } = await createCommercialClientWithModule('SECURITY');
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP_SIB_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Sibling Property',
    });
    const bA1 = await buildingService.createBuilding({ propertyId: property.id, code: 'A1', name: 'A1' });
    const bA2 = await buildingService.createBuilding({ propertyId: property.id, code: 'A2', name: 'A2' });
    await buildingAssignmentService.createAssignment(user.id, { buildingId: bA1.id });

    const context = await getEffectiveUserContext(user.id);
    const buildingIds = context.context.clients
      .flatMap((c) => c.properties)
      .flatMap((p) => p.buildings)
      .map((b) => b.id);
    assert.deepEqual(buildingIds, [bA1.id]);
    assert.ok(!buildingIds.includes(bA2.id));
  });

  it('returns only explicitly reachable hierarchy across multiple clients', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const clientA = await createCommercialClientWithModule('ENGINEERING');
    const clientB = await createCommercialClientWithModule('HOUSEKEEPING');
    const { building: bA } = await createPropertyWithBuilding(clientA.client.id, 'A');
    const { building: bB } = await createPropertyWithBuilding(clientB.client.id, 'B');
    const { building: bA2 } = await createPropertyWithBuilding(clientA.client.id, 'A2');

    await buildingAssignmentService.createAssignment(user.id, { buildingId: bA.id });
    await buildingAssignmentService.createAssignment(user.id, { buildingId: bB.id });

    const context = await getEffectiveUserContext(user.id);
    const clientCodes = context.context.clients.map((c) => c.code);
    assert.ok(clientCodes.includes(clientA.client.code));
    assert.ok(clientCodes.includes(clientB.client.code));
    const buildingIds = context.context.clients
      .flatMap((c) => c.properties)
      .flatMap((p) => p.buildings)
      .map((b) => b.id);
    assert.ok(buildingIds.includes(bA.id));
    assert.ok(buildingIds.includes(bB.id));
    // Unassigned sibling under clientA must not appear.
    assert.ok(!buildingIds.includes(bA2.id));
  });

  it('excludes an inactive assignment from context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client, moduleCode } = await createCommercialClientWithModule('ENGINEERING');
    const { building } = await createPropertyWithBuilding(client.id, 'A');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });
    await buildingAssignmentService.deactivateAssignment(user.id, building.id);

    const context = await getEffectiveUserContext(user.id);
    assert.equal(context.context.clients.length, 0);
  });

  it('excludes an inactive building even with an active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client, moduleCode } = await createCommercialClientWithModule('ENGINEERING');
    const { building } = await createPropertyWithBuilding(client.id, 'A');
    // Create an active assignment first, then make the building inactive.
    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });
    await pool!.query(`UPDATE buildings SET status = 'INACTIVE' WHERE id = $1`, [building.id]);

    const context = await getEffectiveUserContext(user.id);
    assert.equal(context.context.clients.length, 0);
  });

  it('omits entitlement when the subscription is not effective', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client, subscription } = await createCommercialClientWithModule('ENGINEERING');
    const { building } = await createPropertyWithBuilding(client.id, 'A');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });
    await subscriptionService.updateSubscriptionStatus(subscription.id, { status: 'SUSPENDED' });

    const context = await getEffectiveUserContext(user.id);
    assert.equal(context.context.clients.length, 1);
    assert.deepEqual(context.entitlements, []);
  });

  it('omits an inactive entitlement', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client, subscription } = await createCommercialClientWithModule('REPORTING');
    const { building } = await createPropertyWithBuilding(client.id, 'A');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });
    const entitlements = await entitlementRepository.findBySubscriptionId(subscription.id);
    for (const e of entitlements) {
      await pool!.query(
        `UPDATE module_entitlements SET status = 'REVOKED' WHERE id = $1`,
        [e.id],
      );
    }

    const context = await getEffectiveUserContext(user.id);
    assert.equal(context.context.clients.length, 1);
    assert.deepEqual(context.entitlements, []);
  });

  it('keeps permission vs entitlement separate', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user, token } = await createUserWithSession();
    const { client, moduleCode } = await createCommercialClientWithModule('ENGINEERING');
    const { building } = await createPropertyWithBuilding(client.id, 'A');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });

    // User has building context + entitlement, but no roles/permissions.
    const me = await api().get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data.access.permissions, []);
    assert.deepEqual(me.body.data.entitlements, [
      { moduleCode, status: 'ACTIVE' },
    ]);
  });

  it('returns empty context for a zero-building user (still authenticates)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { token } = await createUserWithSession();
    const me = await api().get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data.context.clients, []);
    assert.deepEqual(me.body.data.entitlements, []);
  });

  it('is consistent with BE-02G building access for every returned building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client, moduleCode } = await createCommercialClientWithModule('ENGINEERING');
    const { building: bA } = await createPropertyWithBuilding(client.id, 'A');
    const { building: bB } = await createPropertyWithBuilding(client.id, 'B');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: bA.id });

    const context = await getEffectiveUserContext(user.id);
    const buildingIds = context.context.clients
      .flatMap((c) => c.properties)
      .flatMap((p) => p.buildings)
      .map((b) => b.id);
    assert.deepEqual(buildingIds, [bA.id]);

    // Every returned building is allowed by BE-02G.
    for (const id of buildingIds) {
      assert.equal(await contextAccessService.canAccessBuilding(user.id, id), true);
    }
    // A representative inaccessible building is denied.
    assert.equal(await contextAccessService.canAccessBuilding(user.id, bB.id), false);
  });

  it('is consistent with BE-02C effective entitlement resolver', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { user } = await createUserWithSession();
    const { client, subscription } = await createCommercialClientWithModule('ENGINEERING');
    const { building } = await createPropertyWithBuilding(client.id, 'A');
    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });

    const context = await getEffectiveUserContext(user.id);
    const authoritative = await entitlementService.resolveEffectiveEntitlements(subscription.id);
    assert.deepEqual(
      context.entitlements.map((e) => e.moduleCode),
      authoritative.map((m) => m.code),
    );
  });
});
