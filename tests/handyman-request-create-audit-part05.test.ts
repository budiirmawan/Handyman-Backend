import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import {
  admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion,
} from '../src/modules/handyman-care-workspace/care-workspace.service';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextRepository } from '../src/modules/tenant-building-contexts';
import { tenantCompanyRepository } from '../src/modules/tenant-companies';
import { tenantSpaceRepository } from '../src/modules/tenant-spaces';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { handymanChannelAttributionService } from '../src/modules/handyman-channel-attributions';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { registerIntegrationWebhookSubscriptionProbe } from '../src/modules/integration-webhook-endpoints';
import { resetIntegrationOutboxSubscriptionProbe } from '../src/modules/integration-outbox';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * W02 PART 05 — Request create audit & notification handoff (focused).
 * Setup is copied from the frozen PART 04 journey fixture (no shared helper).
 * Covers: create audit event (atomic, identities only, no PII/tokens), failed
 * create and rollback with fault injection, exchange replay, concurrency,
 * attribution + actor audit, and the BLOCKED_BY_POLICY notification handoff.
 */

const CARE = '/api/v1/handyman/care/properties';
const CREATE = '/api/v1/handyman/requests/care';
const QUEUE = '/api/v1/handyman/operations/requests';
const HM = '/api/v1/handyman/requests';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55549;
const DIR = '/tmp/handyman-intake-triage-journey-pg';
const SECRET = 'intake-triage-journey-test-integration-secret';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const OPS = [{ code: 'handyman.operations.request.read', name: 'Read Handyman Operations Request Queue' }];
// W02 PART 04A: Operations triage authority is its own permission, not tenant_company.manage.
const TRIAGE = [
  { code: 'handyman.operations.request.triage', name: 'Triage Handyman Operations Requests' },
  { code: 'tenant_company.read', name: 'Read Tenant Companies' },
];
const TRIAGE_ONLY = [{ code: 'handyman.operations.request.triage', name: 'Triage Handyman Operations Requests' }];
const MANAGE_ONLY = [
  { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
  { code: 'tenant_company.read', name: 'Read Tenant Companies' },
];

let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string;
let envKey: string;
let careActorId: string;
let adminId: string;
let careToken = '';
let clientA: string;
let clientB: string;
let propA: string;
let propB: string;
let buildingA: string;
let buildingA2: string;
let buildingB: string;
let spaceA: string;
let spaceA2: string;
let spaceB: string;
let tenantA: string;
let tenantB: string;
let serviceA: string;
let serviceB: string;
let queueA: { token: string; userId: string };
let triageA: { token: string; userId: string };
let triageA2: { token: string; userId: string };
let opsOnlyA: { token: string; userId: string };
let queueA2: { token: string; userId: string };
let queueB: { token: string; userId: string };
let noAssign: { token: string; userId: string };
let revocable: { token: string; userId: string };

/** One assertion object is signed and admitted; never two different ones. */
async function admit() {
  const a = assertion();
  return admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET));
}

async function operator(codes: { code: string; name: string }[], buildingIds: string[]) {
  const token = await createSessionWithPermissions(codes);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'scoped-%' ORDER BY created_at DESC LIMIT 1`,
  );
  const userId = rows[0].id;
  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(userId, { buildingId }, adminId);
  }
  return { token, userId };
}

function assertion(overrides: Partial<CareWorkspaceAssertion> = {}): CareWorkspaceAssertion {
  return {
    purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'intake-agent-w04' }, ...overrides,
  };
}

/** Full Customer Care leg: create-exchange for tenant + unit, then the care POST. */
async function intake(
  tenant: 'A' | 'A2' | 'B',
  body: Record<string, unknown> = {},
): Promise<{ status: number; id: string; body: any }> {
  const config = tenant === 'B'
    ? { property: propB, tenantCompanyId: tenantB, buildingId: buildingB, spaceId: spaceB, serviceId: serviceB }
    : { property: propA, tenantCompanyId: tenantA, buildingId: tenant === 'A' ? buildingA : buildingA2,
        spaceId: tenant === 'A' ? spaceA : spaceA2, serviceId: serviceA };
  const issued = await api().post(`${CARE}/${config.property}/create-exchanges`)
    .set('Authorization', `Bearer ${careToken}`)
    .send({ tenantCompanyId: config.tenantCompanyId, buildingId: config.buildingId, spaceId: config.spaceId });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const created = await api().post(CREATE).send({
    exchangeToken: issued.body.data.exchangeToken,
    serviceCatalogId: config.serviceId,
    description: 'Journey intake',
    ...body,
  });
  return { status: created.status, id: created.body?.data?.id ?? '', body: created.body };
}

const triage = (credential: string, id: string, payload: Record<string, unknown>) =>
  api().post(`${HM}/${id}/triage`).set('Authorization', `Bearer ${credential}`).send(payload);
const triageRead = (credential: string, id: string) =>
  api().get(`${HM}/${id}/triage`).set('Authorization', `Bearer ${credential}`);
const list = (credential: string, query: Record<string, unknown> = {}) =>
  api().get(QUEUE).set('Authorization', `Bearer ${credential}`).query({ limit: 100, ...query });
const detail = (credential: string, id: string) =>
  api().get(`${QUEUE}/${id}`).set('Authorization', `Bearer ${credential}`);

const GOOD_REPORTER = { reporter: { name: 'Journey Reporter', phone: '+628111222333', email: 'journey@example.com' } };
const decision = { disposition: 'INSPECTION_REQUIRED', note: 'Site inspection needed before quotation' };

async function state(id: string) {
  const r = await pool.query(
    `SELECT r.status,
            (SELECT count(*)::int FROM handyman_request_triage_decisions t WHERE t.handyman_request_id = r.id) AS triage
       FROM handyman_service_requests r WHERE r.id = $1`,
    [id],
  );
  return r.rows[0] as { status: string; triage: number };
}
async function triageEvents(id: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM operational_events WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_TRIAGED'`,
    [id],
  );
  return r.rows[0].n;
}

before(async () => {
  if (EMBEDDED) {
    Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
      DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
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
  assert.ok(config, 'Intake→triage journey requires PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);

  code = `IJT_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Journey BM' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  careActorId = (await handymanCareActorService.createCareActor({
    integrationId: integration.id, actorReference: 'intake-agent-w04', displayName: 'Care',
  })).id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;

  adminId = (await createAdminUser()).userId;
  clientA = (await clientService.createClient({ code: `JA_${suffix()}`, name: 'Journey client A' })).id;
  clientB = (await clientService.createClient({ code: `JB_${suffix()}`, name: 'Journey client B' })).id;
  propA = (await propertyService.createProperty({ clientId: clientA, code: `P_${suffix()}`, name: 'Property A' })).id;
  propB = (await propertyService.createProperty({ clientId: clientB, code: `P_${suffix()}`, name: 'Property B' })).id;
  buildingA = (await buildingService.createBuilding({ propertyId: propA, code: `B_${suffix()}`, name: 'Building A' })).id;
  buildingA2 = (await buildingService.createBuilding({ propertyId: propA, code: `B_${suffix()}`, name: 'Building A2' })).id;
  buildingB = (await buildingService.createBuilding({ propertyId: propB, code: `B_${suffix()}`, name: 'Building B' })).id;
  for (const b of [buildingA, buildingA2, buildingB]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId: b }, adminId);
  }
  await grantCareActorProperty({ careActorId, propertyId: propA, clientId: clientA }, adminId);
  await grantCareActorProperty({ careActorId, propertyId: propB, clientId: clientB }, adminId);

  const unit = async (buildingId: string) => {
    const floor = await floorService.createFloor({ buildingId, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
    const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
    const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
    return (await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Unit' })).id;
  };
  spaceA = await unit(buildingA);
  spaceA2 = await unit(buildingA2);
  spaceB = await unit(buildingB);

  serviceA = (await serviceCatalogService.createServiceCatalogEntry({
    clientId: clientA, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN',
  }, adminId)).id;
  serviceB = (await serviceCatalogService.createServiceCatalogEntry({
    clientId: clientB, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN',
  }, adminId)).id;

  tenantA = (await tenantCompanyRepository.create({ clientId: clientA, tenantCode: `T_${suffix()}`, tenantName: 'Tenant A', email: 'billing-a@example.com' })).id;
  tenantB = (await tenantCompanyRepository.create({ clientId: clientB, tenantCode: `T_${suffix()}`, tenantName: 'Tenant B', email: 'billing-b@example.com' })).id;
  const link = (tc: string, b: string, s: string) => Promise.all([
    tenantBuildingContextRepository.create({ tenantCompanyId: tc, buildingId: b, status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null }),
    tenantSpaceRepository.create({ tenantCompanyId: tc, buildingId: b, spaceId: s, status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null }),
  ]);
  await link(tenantA, buildingA, spaceA);
  await link(tenantA, buildingA2, spaceA2);
  await link(tenantB, buildingB, spaceB);

  queueA = await operator(OPS, [buildingA]);
  triageA = await operator(TRIAGE, [buildingA]);
  triageA2 = await operator(TRIAGE, [buildingA2]);
  opsOnlyA = await operator(OPS, [buildingA]);
  queueA2 = await operator(OPS, [buildingA2]);
  queueB = await operator(OPS, [buildingB]);
  noAssign = await operator(OPS, []);
  revocable = await operator([...TRIAGE, ...OPS], [buildingA]);

  careToken = (await admit()).workspaceToken;
});

beforeEach(() => {
  clearLoginRateLimits();
});

after(async () => {
  if (envKey) delete process.env[envKey];
  clearLoginRateLimits();
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});


/** Intake that also returns the exchange token and the request id (used for replay and audit). */
async function intakeWithToken(
  tenant: 'A' | 'A2' | 'B',
  body: Record<string, unknown> = {},
): Promise<{ status: number; id: string; exchangeToken: string; body: any }> {
  const config = tenant === 'B'
    ? { property: propB, tenantCompanyId: tenantB, buildingId: buildingB, spaceId: spaceB, serviceId: serviceB }
    : { property: propA, tenantCompanyId: tenantA, buildingId: tenant === 'A' ? buildingA : buildingA2,
        spaceId: tenant === 'A' ? spaceA : spaceA2, serviceId: serviceA };
  const issued = await api().post(`${CARE}/${config.property}/create-exchanges`)
    .set('Authorization', `Bearer ${careToken}`)
    .send({ tenantCompanyId: config.tenantCompanyId, buildingId: config.buildingId, spaceId: config.spaceId });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const exchangeToken: string = issued.body.data.exchangeToken;
  const created = await api().post(CREATE).send({
    exchangeToken,
    serviceCatalogId: config.serviceId,
    description: 'Audit intake',
    ...body,
  });
  return { status: created.status, id: created.body?.data?.id ?? '', exchangeToken, body: created.body };
}

const SENSITIVE_REPORTER = {
  reporter: { name: 'Sensitive Reporter Name', phone: '+628555000111', email: 'secret.reporter@example.com' },
  contactPerson: { name: 'Sensitive Contact Name', phone: '+628555000222' },
};

/** Operational events for one request id (HANDYMAN_REQUEST_CREATED only). */
async function createdEvents(requestId: string) {
  const r = await pool.query(
    `SELECT * FROM operational_events
      WHERE event_type = 'HANDYMAN_REQUEST_CREATED' AND entity_id = $1`,
    [requestId],
  );
  return r.rows;
}

async function requestRow(id: string) {
  const r = await pool.query(
    `SELECT id, client_id, building_id, channel_attribution_id, tenant_company_id, status
       FROM handyman_service_requests WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function attributionRow(id: string) {
  const r = await pool.query(
    `SELECT id, actor_type, care_actor_id, created_by_user_id FROM handyman_channel_attributions WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

/** Fault switch: while the table has a row, any HANDYMAN_REQUEST_CREATED insert raises. */
async function installFaultSwitch() {
  await pool.query(`CREATE TABLE IF NOT EXISTS w05_fault_switch (id INT PRIMARY KEY)`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION w05_fault_fn() RETURNS trigger AS $$
    BEGIN
      IF NEW.event_type = 'HANDYMAN_REQUEST_CREATED'
         AND EXISTS (SELECT 1 FROM w05_fault_switch) THEN
        RAISE EXCEPTION 'W05 injected audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS w05_fault_trg ON operational_events`);
  await pool.query(`CREATE TRIGGER w05_fault_trg BEFORE INSERT ON operational_events
    FOR EACH ROW EXECUTE FUNCTION w05_fault_fn()`);
}

async function setFault(on: boolean) {
  if (on) await pool.query(`INSERT INTO w05_fault_switch (id) VALUES (1) ON CONFLICT DO NOTHING`);
  else await pool.query(`DELETE FROM w05_fault_switch`);
}

async function removeFaultSwitch() {
  await pool.query(`DROP TRIGGER IF EXISTS w05_fault_trg ON operational_events`);
  await pool.query(`DROP FUNCTION IF EXISTS w05_fault_fn()`);
  await pool.query(`DROP TABLE IF EXISTS w05_fault_switch`);
}

describe('W02 PART 05 — request create audit & notification handoff', () => {
  before(async () => {
    await installFaultSwitch();
  });

  after(async () => {
    await removeFaultSwitch();
  });

  it('A1 successful create writes exactly one HANDYMAN_REQUEST_CREATED event with request, tenant, building, attribution and actor-type identities', async () => {
    const f = await intakeWithToken('A');
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const req = await requestRow(f.id);
    const events = await createdEvents(f.id);
    assert.equal(events.length, 1, 'exactly one create event');
    const ev = events[0];
    assert.equal(ev.entity_type, 'HANDYMAN_SERVICE_REQUEST');
    assert.equal(ev.entity_id, f.id);
    assert.equal(ev.client_id, req.client_id);
    assert.equal(ev.building_id, req.building_id, 'building from the immutable attribution snapshot');
    assert.equal(ev.actor_user_id, null, 'Care path has no User actor');
    assert.equal(ev.metadata.channelAttributionId, req.channel_attribution_id);
    assert.equal(ev.metadata.tenantCompanyId, req.tenant_company_id);
    const attr = await attributionRow(req.channel_attribution_id);
    assert.equal(ev.metadata.actorType, attr.actor_type);
    assert.equal(ev.metadata.careActorId, attr.care_actor_id);
    assert.equal(ev.metadata.careActorId == null, false, 'care actor identity recorded');
    assert.ok(ev.occurred_at instanceof Date && !Number.isNaN(ev.occurred_at.getTime()), 'timestamp present');
    assert.equal(ev.source, 'HTTP', 'HTTP correlation is authoritative');
    assert.ok(ev.request_id, 'request id correlation present');
  });

  it('A2 event carries no reporter, contact, phone, email, token or assertion data (identities only)', async () => {
    const f = await intakeWithToken('A', SENSITIVE_REPORTER);
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const [ev] = await createdEvents(f.id);
    const serialized = JSON.stringify(ev);
    for (const forbidden of [
      'Sensitive Reporter Name', 'Sensitive Contact Name', '+628555000111', '+628555000222',
      'secret.reporter@example.com', f.exchangeToken, 'assertion', 'exchangeToken', 'workspaceToken',
    ]) {
      assert.ok(!serialized.includes(forbidden), `event must not contain ${forbidden}`);
    }
    // the reporter snapshot itself still exists in its own (PART 03) store
    const contact = await pool.query(
      `SELECT count(*)::int AS n FROM handyman_service_request_contacts WHERE handyman_request_id = $1`,
      [f.id],
    );
    assert.equal(contact.rows[0].n, 1, 'contact stays in its own store, not in the audit event');
  });

  it('A3 notification handoff is BLOCKED_BY_POLICY: no intent, no delivery row, no delivery claimed', async () => {
    const before = await pool.query(
      `SELECT (SELECT count(*) FROM notification_outbound_deliveries)::int AS outbound,
              (SELECT count(*) FROM notifications)::int AS inapp`,
    );
    const f = await intakeWithToken('A');
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const [ev] = await createdEvents(f.id);
    assert.deepEqual(ev.metadata.notificationHandoff, {
      status: 'BLOCKED_BY_POLICY',
      reason: 'RECIPIENT_CHANNEL_POLICY_NOT_DEFINED',
    });
    const after = await pool.query(
      `SELECT (SELECT count(*) FROM notification_outbound_deliveries)::int AS outbound,
              (SELECT count(*) FROM notifications)::int AS inapp`,
    );
    assert.deepEqual(after.rows[0], before.rows[0], 'no notification intent or delivery was created');
    // Integration fan-out is dark by default: no outbox row is created for the event.
    const outbox = await pool.query(
      `SELECT count(*)::int AS n FROM integration_outbox_events WHERE entity_id = $1`,
      [f.id],
    );
    assert.equal(outbox.rows[0].n, 0);
  });

  it('A4 the Operations queue shows the created request in INTAKE (create event does not change lifecycle)', async () => {
    const f = await intakeWithToken('A');
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const row = await requestRow(f.id);
    assert.equal(row.status, 'INTAKE');
  });

  it('B1 failed create (unknown service) writes no event and no request, and does not consume the exchange', async () => {
    const issued = await api().post(`${CARE}/${propA}/create-exchanges`)
      .set('Authorization', `Bearer ${careToken}`)
      .send({ tenantCompanyId: tenantA, buildingId: buildingA, spaceId: spaceA });
    assert.equal(issued.status, 201);
    const exchange = issued.body.data.exchangeToken;
    const eventCount = async () => (await pool.query(
      `SELECT count(*)::int AS n FROM operational_events WHERE event_type = 'HANDYMAN_REQUEST_CREATED'`,
    )).rows[0].n as number;
    const eventsBefore = await eventCount();
    const reqCountBefore = (await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`)).rows[0].n;
    const failedAttempt = await api().post(CREATE).send({
      exchangeToken: exchange,
      serviceCatalogId: randomUUID(),
      description: 'Unknown service',
    });
    assert.ok(failedAttempt.status >= 400);
    assert.equal(await eventCount(), eventsBefore, 'failed create writes no event');
    assert.equal(
      (await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`)).rows[0].n,
      reqCountBefore,
      'failed create writes no request',
    );
    // exchange was not consumed: the valid retry with the same token still succeeds once
    const retry = await api().post(CREATE).send({
      exchangeToken: exchange,
      serviceCatalogId: serviceA,
      description: 'Retry after failed validation',
    });
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal((await createdEvents(retry.body.data.id)).length, 1);
  });

  it('B2 rollback: an audit insert failure rolls back the request, attribution and exchange together; retry then creates exactly one request and one event', async () => {
    const issued = await api().post(`${CARE}/${propA}/create-exchanges`)
      .set('Authorization', `Bearer ${careToken}`)
      .send({ tenantCompanyId: tenantA, buildingId: buildingA, spaceId: spaceA });
    assert.equal(issued.status, 201);
    const exchange = issued.body.data.exchangeToken;

    const reqBefore = await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`);
    const attrBefore = await pool.query(`SELECT count(*)::int AS n FROM handyman_channel_attributions`);

    await setFault(true);
    try {
      const failed = await api().post(CREATE).send({
        exchangeToken: exchange,
        serviceCatalogId: serviceA,
        description: 'Injected audit failure',
        ...SENSITIVE_REPORTER,
      });
      assert.ok(failed.status >= 500, `audit failure must fail the create: ${failed.status} ${JSON.stringify(failed.body)}`);
    } finally {
      await setFault(false);
    }

    const attrAfter = await pool.query(`SELECT count(*)::int AS n FROM handyman_channel_attributions`);
    assert.equal(attrAfter.rows[0].n, attrBefore.rows[0].n, 'no attribution left behind');
    const reqAfter = await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`);
    assert.equal(reqAfter.rows[0].n, reqBefore.rows[0].n, 'no request left behind');
    const orphan = await pool.query(
      `SELECT count(*)::int AS n FROM handyman_service_request_contacts c
        WHERE NOT EXISTS (SELECT 1 FROM handyman_service_requests r WHERE r.id = c.handyman_request_id)`,
    );
    assert.equal(orphan.rows[0].n, 0, 'no orphan reporter contact');

    // exchange was not consumed by the rolled-back attempt: retry succeeds once
    const retry = await api().post(CREATE).send({
      exchangeToken: exchange,
      serviceCatalogId: serviceA,
      description: 'Retry after rollback',
    });
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    const events = await createdEvents(retry.body.data.id);
    assert.equal(events.length, 1);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM handyman_service_requests WHERE channel_attribution_id = $1`,
      [(await requestRow(retry.body.data.id)).channel_attribution_id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('C1 replay of a consumed exchange creates no second request and no second event', async () => {
    const f = await intakeWithToken('A', SENSITIVE_REPORTER);
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const replay = await api().post(CREATE).send({
      exchangeToken: f.exchangeToken,
      serviceCatalogId: serviceA,
      description: 'Replay',
      ...SENSITIVE_REPORTER,
    });
    assert.equal(replay.status, 401, JSON.stringify(replay.body));
    const req = await requestRow(f.id);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM handyman_service_requests WHERE channel_attribution_id = $1`,
      [req.channel_attribution_id],
    );
    assert.equal(rows.rows[0].n, 1);
    assert.equal((await createdEvents(f.id)).length, 1, 'replay produces no duplicate event');
    const contacts = await pool.query(
      `SELECT count(*)::int AS n FROM handyman_service_request_contacts WHERE handyman_request_id = $1`,
      [f.id],
    );
    assert.equal(contacts.rows[0].n, 1);
  });

  it('C2 concurrent creates with one exchange: exactly one request and one event', async () => {
    const issued = await api().post(`${CARE}/${propA}/create-exchanges`)
      .set('Authorization', `Bearer ${careToken}`)
      .send({ tenantCompanyId: tenantA, buildingId: buildingA, spaceId: spaceA });
    assert.equal(issued.status, 201);
    const exchange = issued.body.data.exchangeToken;
    const attempts = await Promise.all(
      [0, 1, 2].map(() => api().post(CREATE).send({
        exchangeToken: exchange,
        serviceCatalogId: serviceA,
        description: 'Concurrent create',
      })),
    );
    const winners = attempts.filter((r) => r.status === 201);
    assert.equal(winners.length, 1, JSON.stringify(attempts.map((r) => r.status)));
    const id = winners[0].body.data.id;
    assert.equal((await createdEvents(id)).length, 1, 'one event for the single created request');
    const total = await pool.query(
      `SELECT count(*)::int AS n FROM handyman_service_requests WHERE id = $1`, [id],
    );
    assert.equal(total.rows[0].n, 1);
  });

  it('D1 credential-like keys are rejected at the HTTP boundary: no request, no event, exchange not consumed', async () => {
    const issued = await api().post(`${CARE}/${propA}/create-exchanges`)
      .set('Authorization', `Bearer ${careToken}`)
      .send({ tenantCompanyId: tenantA, buildingId: buildingA, spaceId: spaceA });
    assert.equal(issued.status, 201);
    const exchange = issued.body.data.exchangeToken;
    const eventsBefore = (await pool.query(
      `SELECT count(*)::int AS n FROM operational_events WHERE event_type = 'HANDYMAN_REQUEST_CREATED'`,
    )).rows[0].n;
    const smuggled = await api().post(CREATE).send({
      exchangeToken: exchange,
      serviceCatalogId: serviceA,
      description: 'Smuggled keys',
      token: 'x-secret',
      accessToken: 'y-secret',
      assertion: 'z-secret',
    });
    assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));
    assert.equal(
      (await pool.query(
        `SELECT count(*)::int AS n FROM operational_events WHERE event_type = 'HANDYMAN_REQUEST_CREATED'`,
      )).rows[0].n,
      eventsBefore,
    );
    const retry = await api().post(CREATE).send({
      exchangeToken: exchange,
      serviceCatalogId: serviceA,
      description: 'Clean retry',
    });
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
  });

  it('D2 audit seam scrubs credential keys from event metadata before persistence', async () => {
    const { recordHandymanEvent } = await import('../src/modules/handyman-audit');
    const entityId = randomUUID();
    const record = await recordHandymanEvent(
      {
        eventType: 'HANDYMAN_REQUEST_CREATED',
        entityType: 'HANDYMAN_SERVICE_REQUEST',
        entityId,
        clientId: clientA,
        summary: 'Seam scrub probe.',
        metadata: {
          token: 'x-secret', accessToken: 'y-secret', assertion: 'z-secret',
          authorization: 'Bearer q', channelAttributionId: entityId,
        },
      },
      pool,
    );
    const serialized = JSON.stringify(record.metadata);
    assert.ok(!serialized.includes('x-secret'));
    assert.ok(!serialized.includes('y-secret'));
    assert.ok(!serialized.includes('Bearer q'));
    assert.equal(record.metadata.channelAttributionId, entityId, 'non-sensitive keys are kept');
  });

  it('E1 outbox: with an ACTIVE subscribed endpoint, one marker per create event; payload carries identities only; replay adds no marker', async () => {
    process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
    registerIntegrationWebhookSubscriptionProbe();
    try {
      await pool.query(
        `INSERT INTO integration_webhook_endpoints
           (id, client_id, building_id, name, url, event_types, status, signing_secret, timeout_ms)
         VALUES ($1, $2, NULL, 'W05 receiver', 'https://receiver.example.com/w05', $3, 'ACTIVE', 'whsec_w05_probe', 5000)`,
        [randomUUID(), clientA, ['HANDYMAN_REQUEST_CREATED']],
      );
      const f = await intakeWithToken('A', SENSITIVE_REPORTER);
      assert.equal(f.status, 201, JSON.stringify(f.body));
      const [ev] = await createdEvents(f.id);
      const markers = await pool.query(
        `SELECT operational_event_id, entity_type, entity_id, payload FROM integration_outbox_events WHERE entity_id = $1`,
        [f.id],
      );
      assert.equal(markers.rows.length, 1, 'one outbox marker for the one create event');
      assert.equal(markers.rows[0].operational_event_id, ev.id);
      assert.equal(markers.rows[0].entity_type, 'HANDYMAN_SERVICE_REQUEST');
      const payload: string = markers.rows[0].payload;
      for (const forbidden of [
        'Sensitive Reporter Name', 'Sensitive Contact Name', '+628555000111', '+628555000222',
        'secret.reporter@example.com', f.exchangeToken, 'assertion', 'exchangeToken', 'workspaceToken',
      ]) {
        assert.ok(!payload.includes(forbidden), `outbox payload must not contain ${forbidden}`);
      }
      assert.equal(JSON.parse(payload).metadata.notificationHandoff.status, 'BLOCKED_BY_POLICY');

      const replay = await api().post(CREATE).send({
        exchangeToken: f.exchangeToken, serviceCatalogId: serviceA, description: 'Replay',
      });
      assert.equal(replay.status, 401);
      const after = await pool.query(
        `SELECT count(*)::int AS n FROM integration_outbox_events WHERE entity_id = $1`, [f.id],
      );
      assert.equal(after.rows[0].n, 1, 'replay adds no outbox marker');
    } finally {
      delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
      resetIntegrationOutboxSubscriptionProbe();
      await pool.query(`DELETE FROM integration_webhook_endpoints WHERE name = 'W05 receiver'`);
    }
  });

  // ---- Local-user create path (createHandymanServiceRequest) --------------
  async function localAttribution(userId: string): Promise<string> {
    const attr = await handymanChannelAttributionService.createChannelAttribution({
      tenantCompanyId: tenantA,
      buildingId: buildingA,
      spaceId: spaceA,
      originChannel: 'BM_SUPER_APP',
      originReference: `W05-LOCAL-${randomUUID().slice(0, 8)}`,
      createdByUserId: userId,
    });
    return attr.id;
  }

  it('F1 local-user create: request and HANDYMAN_REQUEST_CREATED commit together, actor is the User, no Care actor fields', async () => {
    const local = await operator(TRIAGE_ONLY, [buildingA]);
    const attrId = await localAttribution(local.userId);
    const created = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: attrId, serviceCatalogId: serviceA, description: 'Local create' },
      local.userId,
    );
    const events = await createdEvents(created.id);
    assert.equal(events.length, 1, 'exactly one create event for the local-user request');
    assert.equal(events[0].actor_user_id, local.userId, 'the acting User is recorded');
    assert.equal(events[0].metadata.channelAttributionId, attrId);
    assert.equal(events[0].metadata.careActorId, null);
    assert.equal(events[0].building_id, buildingA);
    assert.equal(events[0].metadata.notificationHandoff.status, 'BLOCKED_BY_POLICY');
  });

  it('F2 local-user rollback: audit failure leaves no request and no event; retry creates exactly one', async () => {
    const local = await operator(TRIAGE_ONLY, [buildingA]);
    const attrId = await localAttribution(local.userId);
    const reqBefore = (await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`)).rows[0].n;
    const evBefore = (await pool.query(
      `SELECT count(*)::int AS n FROM operational_events WHERE event_type = 'HANDYMAN_REQUEST_CREATED'`)).rows[0].n;
    await setFault(true);
    try {
      await assert.rejects(handymanServiceRequestService.createHandymanServiceRequest(
        { channelAttributionId: attrId, serviceCatalogId: serviceA, description: 'Injected' },
        local.userId,
      ));
    } finally {
      await setFault(false);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`)).rows[0].n, reqBefore);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM operational_events WHERE event_type = 'HANDYMAN_REQUEST_CREATED'`)).rows[0].n, evBefore);
    const retry = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: attrId, serviceCatalogId: serviceA, description: 'Retry' },
      local.userId,
    );
    assert.equal((await createdEvents(retry.id)).length, 1);
  });

  it('F3 local-user without Building assignment is denied before any write: no request, no event', async () => {
    const outsider = await operator(TRIAGE_ONLY, []);
    const attrId = await localAttribution(outsider.userId);
    const reqBefore = (await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`)).rows[0].n;
    await assert.rejects(handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: attrId, serviceCatalogId: serviceA, description: 'Denied' },
      outsider.userId,
    ));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_service_requests`)).rows[0].n, reqBefore);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM operational_events WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND actor_user_id = $1`,
      [outsider.userId])).rows[0].n, 0);
  });
});
