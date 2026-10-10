import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { sessionService } from '../src/modules/auth/session.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import {
  admitCareWorkspace, revokeCareWorkspaceSession, signCareWorkspaceAssertion,
  type CareWorkspaceAssertion,
} from '../src/modules/handyman-care-workspace/care-workspace.service';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextRepository } from '../src/modules/tenant-building-contexts';
import { tenantCompanyRepository } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceRepository } from '../src/modules/tenant-spaces';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * W02 PART 03 — Reporter identity, contact & request provenance (runtime).
 *
 * Covers, through the real Customer Care path (workspace admission,
 * create-exchange, `POST /handyman/requests/care`) and the Operations queue:
 *   - valid reporter/contactPerson, missing optional contact, no-contact
 *     backward compatibility;
 *   - invalid input (400, no echo, exchange NOT consumed);
 *   - replay and concurrent use of one exchange (one snapshot, ever);
 *   - revoked Customer Care workspace session (no exchange, no snapshot);
 *   - cross-client / cross-building isolation of the snapshot;
 *   - Customer Care C6 reads never expose the snapshot;
 *   - PIC approval authority isolation (reporter/contact data grants nothing);
 *   - append-only snapshot (UPDATE/DELETE blocked).
 */

const CARE = '/api/v1/handyman/care/properties';
const CREATE = '/api/v1/handyman/requests/care';
const QUEUE = '/api/v1/handyman/operations/requests';
const GENERIC = '/api/v1/handyman/requests';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55547;
const DIR = '/tmp/handyman-request-reporter-contact-pg';
const SECRET = 'reporter-contact-test-integration-secret';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const OPS = [{ code: 'handyman.operations.request.read', name: 'Read Handyman Operations Request Queue' }];
const READ = [{ code: 'tenant_company.read', name: 'Read Tenant Companies' }];

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
let buildingB: string;
let spaceA: string;
let spaceB: string;
let tenantA: string;
let tenantB: string;
let serviceA: string;
let serviceB: string;
let opsA: { token: string; userId: string };
let opsB: { token: string; userId: string };
let picReader: { token: string; userId: string };
let noAccess: { token: string; userId: string };
let picEmail: string;

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
    actor: { type: 'CUSTOMER_CARE', actorReference: 'intake-agent-w03' }, ...overrides,
  };
}
async function admit() {
  const a = assertion();
  return admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET));
}

/** Issues one single-use exchange for a tenant/building through the care workspace. */
async function issue(token: string, property: string, tenantCompanyId: string, buildingId: string, spaceId?: string) {
  const response = await api().post(`${CARE}/${property}/create-exchanges`)
    .set('Authorization', `Bearer ${token}`)
    .send({ tenantCompanyId, buildingId, ...(spaceId ? { spaceId } : {}) });
  return response;
}

/** Submits the care POST with an exchange token and an arbitrary body. */
const submit = (exchangeToken: string, serviceCatalogId: string, extra: Record<string, unknown> = {}) =>
  api().post(CREATE).send({ exchangeToken, serviceCatalogId, ...extra });

async function fresh(tenant: 'A' | 'B'): Promise<string> {
  const issued = tenant === 'A'
    ? await issue(careToken, propA, tenantA, buildingA, spaceA)
    : await issue(careToken, propB, tenantB, buildingB, spaceB);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body.data.exchangeToken as string;
}

const list = (credential: string) => api().get(QUEUE).set('Authorization', `Bearer ${credential}`);
const detail = (credential: string, id: string) =>
  api().get(`${QUEUE}/${id}`).set('Authorization', `Bearer ${credential}`);
const generic = (credential: string) => api().get(GENERIC).set('Authorization', `Bearer ${credential}`)
  .query({ clientId: clientA, tenantCompanyId: tenantA });

async function contactRows(requestId?: string): Promise<number> {
  const result = requestId
    ? await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM handyman_service_request_contacts WHERE handyman_request_id = $1', [requestId])
    : await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM handyman_service_request_contacts');
  return result.rows[0].n;
}
async function baseline() {
  const r = await pool.query(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM tenant_pics) AS pics,
    (SELECT count(*)::int FROM user_building_assignments) AS assignments,
    (SELECT count(*)::int FROM user_role_assignments) AS roles,
    (SELECT count(*)::int FROM handyman_service_requests) AS requests,
    (SELECT count(*)::int FROM handyman_service_request_contacts) AS contacts`);
  return r.rows[0] as Record<string, number>;
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
  assert.ok(config, 'Reporter/contact tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);

  code = `RPC_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Reporter BM' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  const careActor = await handymanCareActorService.createCareActor({
    integrationId: integration.id, actorReference: 'intake-agent-w03', displayName: 'Care',
  });
  careActorId = careActor.id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;

  adminId = (await createAdminUser()).userId;
  clientA = (await clientService.createClient({ code: `RA_${suffix()}`, name: 'Reporter client A' })).id;
  clientB = (await clientService.createClient({ code: `RB_${suffix()}`, name: 'Reporter client B' })).id;

  propA = (await propertyService.createProperty({ clientId: clientA, code: `P_${suffix()}`, name: 'Property A' })).id;
  propB = (await propertyService.createProperty({ clientId: clientB, code: `P_${suffix()}`, name: 'Property B' })).id;
  buildingA = (await buildingService.createBuilding({ propertyId: propA, code: `B_${suffix()}`, name: 'Building A' })).id;
  buildingB = (await buildingService.createBuilding({ propertyId: propB, code: `B_${suffix()}`, name: 'Building B' })).id;
  for (const b of [buildingA, buildingB]) {
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
  await link(tenantB, buildingB, spaceB);

  opsA = await operator(OPS, [buildingA]);
  opsB = await operator(OPS, [buildingB]);
  // Reader with C6 permission and a tenant PIC link for tenant A, but no
  // Operations permission. Its email is the one used as a "contact" below.
  picReader = await operator(READ, [buildingA]);
  picEmail = `pic-${picReader.userId.slice(0, 8)}@tenant-a.example.com`;
  await tenantPicService.createTenantPic({
    tenantCompanyId: tenantA, picName: 'Tenant A PIC', email: picEmail, userId: picReader.userId,
  }, adminId);
  noAccess = await operator([{ code: 'checklist.read', name: 'Read Checklists' }], []);

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

describe('W02 PART 03 — reporter identity, contact and provenance', () => {
  it('records a valid reporter and contact person as a provenance-stamped snapshot', async () => {
    const exchange = await fresh('A');
    const response = await submit(exchange, serviceA, {
      description: 'Leaking pipe',
      reporter: { name: '  Siti Rahma ', phone: '+62 812-3456-78', email: 'SITI@Example.COM' },
      contactPerson: { name: 'Budi Gudang', phone: '0812 9999 000' },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const requestId = response.body.data.id as string;
    assert.equal(await contactRows(requestId), 1);

    const row = (await pool.query(
      `SELECT c.*, r.channel_attribution_id AS req_attr, r.tenant_pic_id AS req_pic, a.tenant_pic_id AS attr_pic
         FROM handyman_service_request_contacts c
         JOIN handyman_service_requests r ON r.id = c.handyman_request_id
         JOIN handyman_channel_attributions a ON a.id = c.channel_attribution_id
        WHERE c.handyman_request_id = $1`, [requestId])).rows[0];
    assert.equal(row.reporter_name, 'Siti Rahma');
    assert.equal(row.reporter_phone, '+62812345678');
    assert.equal(row.reporter_email, 'siti@example.com');
    assert.equal(row.contact_person_name, 'Budi Gudang');
    assert.equal(row.contact_person_phone, '08129999000');
    assert.equal(row.contact_person_email, null);
    assert.equal(row.captured_by_care_actor_id, careActorId);
    assert.equal(row.req_attr, row.channel_attribution_id);
    assert.ok(row.captured_at instanceof Date);
    // Snapshot never changes the request's authority fields.
    assert.equal(row.req_pic, row.attr_pic);
  });

  it('keeps the optional contact absent without failing, and keeps no-reporter intake backward compatible', async () => {
    const minimal = await fresh('A');
    const withName = await submit(minimal, serviceA, { reporter: { name: 'Dewi' } });
    assert.equal(withName.status, 201, JSON.stringify(withName.body));
    const requestId = withName.body.data.id as string;
    const readback = await detail(opsA.token, requestId);
    assert.equal(readback.status, 200);
    assert.deepEqual(readback.body.data.contact.reporter, { name: 'Dewi', phone: null, email: null });
    assert.equal(readback.body.data.contact.contactPerson, null);

    const legacy = await fresh('A');
    const plain = await submit(legacy, serviceA, { description: 'No contact recorded' });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    assert.equal(await contactRows(plain.body.data.id), 0);
    const legacyRead = await detail(opsA.token, plain.body.data.id);
    assert.equal(legacyRead.body.data.contact, null);
  });

  it('rejects invalid reporter/contact input with 400, never echoes the value, and does not consume the exchange', async () => {
    const exchange = await fresh('A');
    const before0 = await baseline();
    const invalid: [string, Record<string, unknown>][] = [
      ['reporter missing name', { reporter: { phone: '+628111111' } }],
      ['empty reporter name', { reporter: { name: '   ' } }],
      ['reporter name over 120', { reporter: { name: 'N'.repeat(121) } }],
      ['reporter name with control char', { reporter: { name: 'Bad\u0007Name' } }],
      ['reporter phone not numeric SECRETPHONE', { reporter: { name: 'X', phone: 'SECRETPHONE' } }],
      ['reporter phone too short', { reporter: { name: 'X', phone: '12345' } }],
      ['reporter phone too long', { reporter: { name: 'X', phone: '1'.repeat(16) } }],
      ['reporter email invalid', { reporter: { name: 'X', email: 'not-an-email' } }],
      ['reporter email over 254', { reporter: { name: 'X', email: `${'a'.repeat(250)}@b.co` } }],
      ['reporter unexpected field', { reporter: { name: 'X', role: 'PIC' } }],
      ['reporter as string', { reporter: 'Siti' }],
      ['contactPerson without reporter', { contactPerson: { name: 'Y', phone: '+628222222' } }],
      ['contactPerson without phone or email', { reporter: { name: 'X' }, contactPerson: { name: 'Y' } }],
      ['contactPerson unexpected field', { reporter: { name: 'X' }, contactPerson: { name: 'Y', phone: '+628222222', tenantPicId: randomUUID() } }],
      ['top-level tenantPicId (arbitrary PIC ID)', { reporter: { name: 'X' }, tenantPicId: randomUUID() }],
      ['reporter userId (identity injection)', { reporter: { name: 'X', userId: randomUUID() } }],
    ];
    for (const [label, body] of invalid) {
      const response = await submit(exchange, serviceA, body);
      assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
      const raw = JSON.stringify(response.body);
      assert.ok(!raw.includes('SECRETPHONE'), `${label}: value must not be echoed`);
      assert.ok(!raw.includes('not-an-email'), `${label}: value must not be echoed`);
    }
    const after0 = await baseline();
    assert.equal(after0.requests, before0.requests, 'no request on invalid input');
    assert.equal(after0.contacts, before0.contacts, 'no snapshot on invalid input');
    assert.equal(after0.pics, before0.pics);
    assert.equal(after0.users, before0.users);

    // The exchange was never consumed by the rejected attempts.
    const ok = await submit(exchange, serviceA, { reporter: { name: 'Valid After Errors' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(await contactRows(ok.body.data.id), 1);
  });

  it('replays of one exchange create nothing new and never overwrite the snapshot', async () => {
    const exchange = await fresh('A');
    const first = await submit(exchange, serviceA, { reporter: { name: 'Original Reporter', phone: '+628333333' } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const before0 = await baseline();
    const replay = await submit(exchange, serviceA, { reporter: { name: 'Forged Reporter', phone: '+628444444' } });
    assert.equal(replay.status, 401, JSON.stringify(replay.body));
    const after0 = await baseline();
    assert.equal(after0.requests, before0.requests);
    assert.equal(after0.contacts, before0.contacts);
    const row = (await pool.query('SELECT reporter_name FROM handyman_service_request_contacts WHERE handyman_request_id = $1',
      [first.body.data.id])).rows[0];
    assert.equal(row.reporter_name, 'Original Reporter');
  });

  it('allows at most one snapshot for simultaneous uses of one exchange', async () => {
    const exchange = await fresh('A');
    const body = { reporter: { name: 'Race Reporter' } };
    const results = await Promise.all([submit(exchange, serviceA, body), submit(exchange, serviceA, body)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 401]);
    const created = results.find((r) => r.status === 201)!;
    assert.equal(await contactRows(created.body.data.id), 1);
  });

  it('a revoked Customer Care workspace session cannot issue an exchange, so no request or snapshot appears', async () => {
    const session = (await admit()).workspaceToken;
    await revokeCareWorkspaceSession(session);
    const before0 = await baseline();
    const issued = await issue(session, propA, tenantA, buildingA, spaceA);
    assert.equal(issued.status, 401, JSON.stringify(issued.body));
    const after0 = await baseline();
    assert.equal(after0.requests, before0.requests);
    assert.equal(after0.contacts, before0.contacts);
  });

  it('Operations queue reads the snapshot for triage; cross-client and cross-building operators get nothing', async () => {
    const exchange = await fresh('A');
    const created = await submit(exchange, serviceA, {
      reporter: { name: 'Triage Reporter', phone: '+628555555', email: 'triage@example.com' },
      contactPerson: { name: 'Site Contact', email: 'site@example.com' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const page = await list(opsA.token);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const item = page.body.data.items.find((i: { id: string }) => i.id === id);
    assert.ok(item, 'in-scope request appears in the queue');
    assert.deepEqual(item.contact.reporter, { name: 'Triage Reporter', phone: '+628555555', email: 'triage@example.com' });
    assert.deepEqual(item.contact.contactPerson, { name: 'Site Contact', phone: null, email: 'site@example.com' });
    assert.ok(typeof item.contact.capturedAt === 'string');

    const single = await detail(opsA.token, id);
    assert.equal(single.status, 200);
    assert.deepEqual(single.body.data.contact, item.contact, 'list and detail are parity-identical');

    // Operator in another Building of a different Client: no list row, same 404 on detail.
    const otherList = await list(opsB.token);
    assert.equal(otherList.status, 200);
    assert.ok(!otherList.body.data.items.some((i: { id: string }) => i.id === id));
    const otherDetail = await detail(opsB.token, id);
    assert.equal(otherDetail.status, 404);
    assert.ok(!JSON.stringify(otherDetail.body).includes('Triage Reporter'));

    // No Building assignment: denied outright.
    assert.equal((await list(noAccess.token)).status, 403);
    assert.equal((await detail(noAccess.token, id)).status, 403);
  });

  it('Customer Care C6 reads never expose the snapshot, even to the represented tenant PIC', async () => {
    const exchange = await fresh('A');
    const created = await submit(exchange, serviceA, {
      reporter: { name: 'C6 Hidden Reporter', phone: '+628666666', email: 'c6hidden@example.com' },
      contactPerson: { name: 'C6 Hidden Contact', phone: '+628777777' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const response = await generic(picReader.token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const raw = JSON.stringify(response.body);
    // Non-vacuous: the same request IS visible on C6 (the wall admits it), but its snapshot is not.
    assert.ok(raw.includes(created.body.data.id), 'request is visible on the C6 wall');
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) { keys.add(k); walk(v); }
      }
    };
    walk(response.body);
    for (const key of ['reporter', 'contact', 'contactPerson', 'contactCapturedAt', 'capturedAt']) {
      assert.ok(!keys.has(key), `C6 read must not expose key ${key}`);
    }
    for (const forbidden of ['C6 Hidden Reporter', 'c6hidden@example.com', 'C6 Hidden Contact', '+628666666', '+628777777']) {
      assert.ok(!raw.includes(forbidden), `C6 read must not contain the snapshot value ${forbidden}`);
    }
    // And the PIC-linked reader without the Operations permission stays out of the queue.
    assert.equal((await list(picReader.token)).status, 403);
  });

  it('PIC approval authority is isolated: a reporter or contact matching a PIC grants nothing', async () => {
    const pics = (await pool.query('SELECT id, user_id, email FROM tenant_pics ORDER BY id')).rows;
    const roles = (await pool.query('SELECT user_id, role_id FROM user_role_assignments WHERE user_id = $1', [picReader.userId])).rows;
    const assigned = (await pool.query('SELECT building_id FROM user_building_assignments WHERE user_id = $1 ORDER BY building_id', [picReader.userId])).rows;
    const before0 = await baseline();

    const exchange = await fresh('A');
    const created = await submit(exchange, serviceA, {
      reporter: { name: 'Pic Look-alike', email: picEmail },
      contactPerson: { name: 'Pic Look-alike Contact', email: picEmail },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const after0 = await baseline();
    assert.equal(after0.pics, before0.pics, 'no PIC row created from a contact');
    assert.equal(after0.users, before0.users, 'no User created from a contact');
    assert.deepEqual((await pool.query('SELECT id, user_id, email FROM tenant_pics ORDER BY id')).rows, pics);
    assert.deepEqual((await pool.query('SELECT user_id, role_id FROM user_role_assignments WHERE user_id = $1', [picReader.userId])).rows, roles);
    assert.deepEqual((await pool.query('SELECT building_id FROM user_building_assignments WHERE user_id = $1 ORDER BY building_id', [picReader.userId])).rows, assigned);

    // The snapshot never becomes the request's PIC: tenant_pic_id still comes from the attribution only.
    const reqPic = (await pool.query('SELECT tenant_pic_id FROM handyman_service_requests WHERE id = $1', [created.body.data.id])).rows[0].tenant_pic_id;
    const attrPic = (await pool.query(
      'SELECT a.tenant_pic_id FROM handyman_channel_attributions a JOIN handyman_service_requests r ON r.channel_attribution_id = a.id WHERE r.id = $1',
      [created.body.data.id])).rows[0].tenant_pic_id;
    assert.equal(reqPic, attrPic);

    // The look-alike still cannot read the queue and cannot read the snapshot.
    assert.equal((await list(picReader.token)).status, 403);
    const opsView = await detail(opsA.token, created.body.data.id);
    assert.equal(opsView.status, 200);
    assert.equal(opsView.body.data.contact.reporter.email, picEmail);
  });

  it('the snapshot is append-only: UPDATE and DELETE are rejected at the database', async () => {
    const exchange = await fresh('A');
    const created = await submit(exchange, serviceA, { reporter: { name: 'Immutable Reporter' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await assert.rejects(
      pool.query(`UPDATE handyman_service_request_contacts SET reporter_name = 'Changed' WHERE handyman_request_id = $1`, [created.body.data.id]),
      /append-only/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM handyman_service_request_contacts WHERE handyman_request_id = $1`, [created.body.data.id]),
      /append-only/,
    );
  });

  it('the database CHECK constraints reject malformed rows even if the service were bypassed', async () => {
    const exchange = await fresh('A');
    const created = await submit(exchange, serviceA, { reporter: { name: 'Constraint Probe' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const attr = (await pool.query('SELECT channel_attribution_id FROM handyman_service_requests WHERE id = $1', [created.body.data.id])).rows[0];
    // A second row for the same request is rejected by the UNIQUE constraint.
    await assert.rejects(
      pool.query(
        `INSERT INTO handyman_service_request_contacts
           (id, handyman_request_id, channel_attribution_id, reporter_name, captured_by_care_actor_id)
         VALUES ($1, $2, $3, 'Dup', $4)`,
        [randomUUID(), created.body.data.id, attr.channel_attribution_id, careActorId],
      ),
      /duplicate key|unique/i,
    );
    // Contact person with neither phone nor email is rejected.
    const other = await fresh('A');
    const second = await submit(other, serviceA, { reporter: { name: 'Second' } });
    await assert.rejects(
      pool.query(
        `INSERT INTO handyman_service_request_contacts
           (id, handyman_request_id, channel_attribution_id, reporter_name, contact_person_name, captured_by_care_actor_id)
         VALUES ($1, $2, $3, 'R', 'Only name', $4)`,
        [randomUUID(), second.body.data.id, (await pool.query('SELECT channel_attribution_id FROM handyman_service_requests WHERE id = $1', [second.body.data.id])).rows[0].channel_attribution_id, careActorId],
      ),
      /handyman_request_contacts_person_complete_check/,
    );
  });
});
