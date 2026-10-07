import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  handymanCareActorService,
  grantCareActorProperty,
  revokeCareActorProperty,
  resolveActiveCareActorPropertyScope,
} from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55525;
const DIR = '/tmp/asentra-care-property-scope-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
    DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false',
  });
}

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let administratorUserId = '';
let clientId = '';
let propertyId = '';
let buildingId = '';
let siblingBuildingId = '';
let otherClientId = '';
let otherPropertyId = '';
let otherBuildingId = '';
let careActorId = '';
let integrationId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  if (!config) return;
  database = config;
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  administratorUserId = admin.userId;
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Care Client' });
  clientId = client.id;
  const property = await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Care Property' });
  propertyId = property.id;
  const building = await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Building A' });
  buildingId = building.id;
  siblingBuildingId = (await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Building B' })).id;
  await buildingAssignmentService.createAssignment(administratorUserId, { buildingId });
  const otherClient = await clientService.createClient({ code: `C_${suffix()}`, name: 'Other Client' });
  otherClientId = otherClient.id;
  const otherProperty = await propertyService.createProperty({ clientId: otherClientId, code: `P_${suffix()}`, name: 'Other Property' });
  otherPropertyId = otherProperty.id;
  otherBuildingId = (await buildingService.createBuilding({ propertyId: otherPropertyId, code: `B_${suffix()}`, name: 'Other Building' })).id;
  integrationId = (await handoffRuntimeRepository.createIntegration({
    integrationCode: `BM_CARE_${suffix()}`, displayName: 'BM care',
  })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  careActorId = (await handymanCareActorService.createCareActor({
    integrationId, actorReference: `CARE_${suffix()}`, displayName: 'Care operator',
  })).id;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('PostgreSQL unavailable'); return false; }
  return true;
}
function db(): Pool { if (!pool) throw new Error('Test database unavailable'); return pool; }
const scope = () => resolveActiveCareActorPropertyScope({ careActorId, buildingId, clientId });

describe('Customer Care property scope authority — PART 02', () => {
  it('fails closed without explicit grant; rejects foreign Client, absent actor and unassigned grantor', async (t) => {
    if (!ready(t)) return;
    assert.equal(await scope(), null);
    await assert.rejects(grantCareActorProperty({ careActorId, propertyId, clientId: otherClientId }, administratorUserId));
    await assert.rejects(grantCareActorProperty({ careActorId: randomUUID(), propertyId, clientId }, administratorUserId));
    await assert.rejects(grantCareActorProperty({ careActorId, propertyId: otherPropertyId, clientId: otherClientId }, administratorUserId));
    const outsider = await userService.createUser({ email: `${suffix()}@test.invalid`, displayName: 'Outsider' });
    await assert.rejects(grantCareActorProperty({ careActorId, propertyId, clientId }, outsider.id));
    assert.equal((await db().query('SELECT COUNT(*)::int AS n FROM handyman_care_property_grants')).rows[0].n, 0);
  });

  it('grants across one property, not a Client/foreign building; journals atomically', async (t) => {
    if (!ready(t)) return;
    const granted = await grantCareActorProperty({ careActorId, propertyId, clientId }, administratorUserId);
    assert.equal(granted.status, 'ACTIVE');
    assert.equal(granted.grantedByUserId, administratorUserId);
    assert.equal(granted.revokedByUserId, null);
    assert.equal((await scope())?.id, granted.id);
    assert.equal((await resolveActiveCareActorPropertyScope({ careActorId, buildingId: siblingBuildingId, clientId }))?.id, granted.id);
    assert.equal(await resolveActiveCareActorPropertyScope({ careActorId, buildingId, clientId: otherClientId }), null);
    assert.equal(await resolveActiveCareActorPropertyScope({ careActorId, buildingId: otherBuildingId, clientId: otherClientId }), null);
    await assert.rejects(grantCareActorProperty({ careActorId, propertyId, clientId }, administratorUserId), (e: any) => e.statusCode === 409);
    const events = await db().query('SELECT event_type, actor_user_id, client_id FROM operational_events WHERE entity_id = $1', [granted.id]);
    assert.equal(events.rows.length, 1);
    assert.deepEqual(events.rows[0], { event_type: 'HANDYMAN_CARE_PROPERTY_GRANT_CREATED', actor_user_id: administratorUserId, client_id: clientId });
  });

  it('denies inactive actor/integration/property/building/Client even if grant exists', async (t) => {
    if (!ready(t)) return;
    const cases: [string, string][] = [
      ['handyman_handoff_care_actors', careActorId],
      ['handyman_handoff_integrations', integrationId],
      ['properties', propertyId], ['buildings', buildingId], ['clients', clientId],
    ];
    for (const [table, id] of cases) {
      await db().query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      assert.equal(await scope(), null, table);
      await db().query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]);
      assert.ok(await scope(), table);
    }
    await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'NONE' });
    assert.equal(await scope(), null);
    await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  });

  it('revokes with provenance, denies replay and permits a new grant without rewriting history', async (t) => {
    if (!ready(t)) return;
    const revoked = await revokeCareActorProperty({ careActorId, propertyId, clientId }, administratorUserId);
    assert.equal(revoked.status, 'REVOKED');
    assert.equal(revoked.revokedByUserId, administratorUserId);
    assert.ok(revoked.revokedAt);
    assert.equal(await scope(), null);
    await assert.rejects(revokeCareActorProperty({ careActorId, propertyId, clientId }, administratorUserId));
    await assert.rejects(db().query('DELETE FROM handyman_care_property_grants WHERE id = $1', [revoked.id]));
    const events = await db().query('SELECT event_type FROM operational_events WHERE entity_id = $1 ORDER BY occurred_at', [revoked.id]);
    assert.equal(events.rows.length, 2);
    assert.deepEqual(new Set(events.rows.map((e) => e.event_type)), new Set(['HANDYMAN_CARE_PROPERTY_GRANT_CREATED', 'HANDYMAN_CARE_PROPERTY_GRANT_REVOKED']));
    const next = await grantCareActorProperty({ careActorId, propertyId, clientId }, administratorUserId);
    assert.notEqual(next.id, revoked.id);
    assert.equal((await scope())?.id, next.id);
    const history = await db().query('SELECT status FROM handyman_care_property_grants WHERE care_actor_id = $1 ORDER BY granted_at', [careActorId]);
    assert.deepEqual(new Set(history.rows.map((r) => r.status)), new Set(['ACTIVE', 'REVOKED']));
  });
});
