import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55492;
const DIR = '/tmp/asentra-hm-run3-pg';
const EM = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';

if (EM) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const HANDYMAN_CREATE = {
  code: 'handyman_request.create',
  name: 'Create Handyman Request',
};
const HANDYMAN_READ = {
  code: 'handyman_request.read',
  name: 'Read Handyman Requests',
};
const HANDYMAN_MANAGE = {
  code: 'handyman_request.manage',
  name: 'Manage Handyman Requests',
};

before(async () => {
  if (EM) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
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
  await pool.query(
    `TRUNCATE handyman_requests, operational_events, user_building_assignments,
      users, roles, permissions, role_permission_assignments,
      user_role_assignments, clients, properties, buildings, floors, areas,
      rooms, spaces CASCADE`,
  );
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
    if (EM) await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createHierarchy(options: {
  client?: PublicClient;
  assignUserId?: string | null;
} = {}) {
  const client =
    options.client ??
    (await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'HTTP Owner Client',
    }));
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'HTTP Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'HTTP Building',
  });
  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Unit Space',
  });
  return { client, property, building, floor, area, room, space };
}

function createBody(spaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    spaceId,
    customerName: 'Ahmad Resident',
    customerPhone: '+6281234567890',
    customerEmail: 'ahmad@resident.example.com',
    inboundChannel: 'WHATSAPP',
    title: 'AC Leaking Water',
    description: 'Water dripping from the indoor split unit.',
    priority: 'HIGH',
    ...overrides,
  };
}

/** Resolves the user id behind a session token (for Building assignment setup). */
async function sessionUserId(token: string): Promise<string> {
  const me = await api().get('/api/v1/auth/me').set(authHeaders(token));
  assert.equal(me.status, 200, JSON.stringify(me.body));
  return me.body.data.user.id as string;
}

const PUBLIC_HANDYMAN_REQUEST_KEYS = [
  'id',
  'clientId',
  'buildingId',
  'spaceId',
  'tenantCompanyId',
  'tenantPicId',
  'customerName',
  'customerPhone',
  'customerEmail',
  'createdByUserId',
  'operationalSurface',
  'inboundChannel',
  'requestNumber',
  'title',
  'description',
  'priority',
  'status',
  'idempotencyKey',
  'requestedAt',
  'createdAt',
  'updatedAt',
].sort();

describe('CR-HM-BE-01 RUN 3: Handyman Request HTTP contract', () => {
  it('rejects unauthenticated and permissionless calls', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();

    const unauth = await api().post(
      `/api/v1/buildings/${h.building.id}/handyman-requests`,
    );
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();

    const deniedCreate = await api()
      .post(`/api/v1/buildings/${h.building.id}/handyman-requests`)
      .set(authHeaders(plainToken))
      .send(createBody(h.space.id));
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'PERMISSION_DENIED');

    const deniedList = await api()
      .get(`/api/v1/buildings/${h.building.id}/handyman-requests`)
      .set(authHeaders(plainToken));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'PERMISSION_DENIED');

    const deniedDetail = await api()
      .get(`/api/v1/handyman-requests/${randomUUID()}`)
      .set(authHeaders(plainToken));
    assert.equal(deniedDetail.status, 403);
    assert.equal(deniedDetail.body.error.code, 'PERMISSION_DENIED');

    const deniedCancel = await api()
      .post(`/api/v1/handyman-requests/${randomUUID()}/cancel`)
      .set(authHeaders(plainToken));
    assert.equal(deniedCancel.status, 403);
    assert.equal(deniedCancel.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces handyman_request.create / read / manage granularity', async (t) => {
    if (!ready(t)) return;

    // create-only: may submit, may not read or manage.
    const createOnly = await createSessionWithPermissions([HANDYMAN_CREATE]);
    const hCreate = await createHierarchy({
      assignUserId: await sessionUserId(createOnly),
    });

    const created = await api()
      .post(`/api/v1/buildings/${hCreate.building.id}/handyman-requests`)
      .set(authHeaders(createOnly))
      .send(createBody(hCreate.space.id));
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const createOnlyList = await api()
      .get(`/api/v1/buildings/${hCreate.building.id}/handyman-requests`)
      .set(authHeaders(createOnly));
    assert.equal(createOnlyList.status, 403);
    assert.equal(createOnlyList.body.error.code, 'PERMISSION_DENIED');

    const createOnlyDetail = await api()
      .get(`/api/v1/handyman-requests/${created.body.data.id}`)
      .set(authHeaders(createOnly));
    assert.equal(createOnlyDetail.status, 403);
    assert.equal(createOnlyDetail.body.error.code, 'PERMISSION_DENIED');

    const createOnlyCancel = await api()
      .post(`/api/v1/handyman-requests/${created.body.data.id}/cancel`)
      .set(authHeaders(createOnly));
    assert.equal(createOnlyCancel.status, 403);
    assert.equal(createOnlyCancel.body.error.code, 'PERMISSION_DENIED');

    // read-only: with Building access it may read, but never create or manage.
    const readOnly = await createSessionWithPermissions([HANDYMAN_READ]);
    await buildingAssignmentService.createAssignment(
      await sessionUserId(readOnly),
      { buildingId: hCreate.building.id },
    );

    const readDetail = await api()
      .get(`/api/v1/handyman-requests/${created.body.data.id}`)
      .set(authHeaders(readOnly));
    assert.equal(readDetail.status, 200, JSON.stringify(readDetail.body));

    const readDeniedCreate = await api()
      .post(`/api/v1/buildings/${hCreate.building.id}/handyman-requests`)
      .set(authHeaders(readOnly))
      .send(createBody(hCreate.space.id));
    assert.equal(readDeniedCreate.status, 403);
    assert.equal(readDeniedCreate.body.error.code, 'PERMISSION_DENIED');

    const readDeniedCancel = await api()
      .post(`/api/v1/handyman-requests/${created.body.data.id}/cancel`)
      .set(authHeaders(readOnly));
    assert.equal(readDeniedCancel.status, 403);
    assert.equal(readDeniedCancel.body.error.code, 'PERMISSION_DENIED');

    // manage-only: with Building access it may cancel, but never create or read.
    const manageOnly = await createSessionWithPermissions([HANDYMAN_MANAGE]);
    await buildingAssignmentService.createAssignment(
      await sessionUserId(manageOnly),
      { buildingId: hCreate.building.id },
    );

    const manageDeniedCreate = await api()
      .post(`/api/v1/buildings/${hCreate.building.id}/handyman-requests`)
      .set(authHeaders(manageOnly))
      .send(createBody(hCreate.space.id));
    assert.equal(manageDeniedCreate.status, 403);
    assert.equal(manageDeniedCreate.body.error.code, 'PERMISSION_DENIED');

    const manageDeniedList = await api()
      .get(`/api/v1/buildings/${hCreate.building.id}/handyman-requests`)
      .set(authHeaders(manageOnly));
    assert.equal(manageDeniedList.status, 403);
    assert.equal(manageDeniedList.body.error.code, 'PERMISSION_DENIED');

    const manageCancel = await api()
      .post(`/api/v1/handyman-requests/${created.body.data.id}/cancel`)
      .set(authHeaders(manageOnly));
    assert.equal(manageCancel.status, 200, JSON.stringify(manageCancel.body));
    assert.equal(manageCancel.body.data.status, 'CANCELLED');
  });

  it('creates a handyman request with 201, authoritative fields, and no fingerprint exposure', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();

    const response = await api()
      .post(`/api/v1/buildings/${h.building.id}/handyman-requests`)
      .set(authHeaders())
      .send(createBody(h.space.id));

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_HANDYMAN_REQUEST_KEYS,
    );

    const data = response.body.data;
    assert.equal(data.buildingId, h.building.id);
    assert.equal(data.spaceId, h.space.id);
    assert.equal(data.clientId, h.client.id);
    assert.equal(data.createdByUserId, adminUserId);
    assert.equal(data.customerName, 'Ahmad Resident');
    assert.equal(data.customerPhone, '+6281234567890');
    assert.equal(data.customerEmail, 'ahmad@resident.example.com');
    assert.equal(data.inboundChannel, 'WHATSAPP');
    assert.equal(data.operationalSurface, 'BM_SUPER_APP');
    assert.equal(data.status, 'SUBMITTED');
    assert.equal(data.priority, 'HIGH');
    assert.equal(data.tenantCompanyId, null);
    assert.equal(data.tenantPicId, null);
    assert.equal(data.idempotencyKey, null);
    assert.match(data.requestNumber, /^HMR-\d{4}-\d{6}$/);
  });

  it('rejects protected authority fields in the create body', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const url = `/api/v1/buildings/${h.building.id}/handyman-requests`;

    const protectedFields: [string, unknown][] = [
      ['clientId', randomUUID()],
      ['createdByUserId', randomUUID()],
      ['requestNumber', 'HMR-2026-000001'],
      ['status', 'CANCELLED'],
      ['operationalSurface', 'BM_SUPER_APP'],
      ['idempotencyKey', ' smuggled-body-key '],
      ['idempotencyFingerprint', 'deadbeef'],
      ['requestedAt', '2026-01-01T00:00:00.000Z'],
      ['buildingId', randomUUID()],
      ['totallyUnknownField', 'no'],
    ];

    for (const [field, value] of protectedFields) {
      const response = await api()
        .post(url)
        .set(authHeaders())
        .send(createBody(h.space.id, { [field]: value }));
      assert.equal(response.status, 400, `${field} must be rejected`);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      const details = response.body.error.details as { field: string }[];
      assert.ok(
        details.some((d) => d.field === field),
        `${field} must be named in the validation details`,
      );
    }
  });

  it('replays the Idempotency-Key and conflicts on a different payload', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const url = `/api/v1/buildings/${h.building.id}/handyman-requests`;
    const key = `IDEM_${suffix()}`;

    const created = await api()
      .post(url)
      .set(authHeaders())
      .set('Idempotency-Key', key)
      .send(createBody(h.space.id));
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const replay = await api()
      .post(url)
      .set(authHeaders())
      .set('Idempotency-Key', key)
      .send(createBody(h.space.id));
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, created.body.data.id);
    assert.equal(replay.body.data.requestNumber, created.body.data.requestNumber);

    const conflict = await api()
      .post(url)
      .set(authHeaders())
      .set('Idempotency-Key', key)
      .send(createBody(h.space.id, { title: 'Different intent' }));
    assert.equal(conflict.status, 409);
    assert.equal(
      conflict.body.error.code,
      'HANDYMAN_REQUEST_IDEMPOTENCY_CONFLICT',
    );
  });

  it('enforces the 200-character Idempotency-Key limit with a governed validation error', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();
    const url = `/api/v1/buildings/${h.building.id}/handyman-requests`;

    // Exactly 200 characters is accepted (DB authority: 1..200 after trim).
    const exact = 'K'.repeat(200);
    const accepted = await api()
      .post(url)
      .set(authHeaders())
      .set('Idempotency-Key', exact)
      .send(createBody(h.space.id));
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.idempotencyKey, exact);

    // 201 characters is a governed 400 VALIDATION_ERROR, never a DB-driven 500.
    const tooLong = 'K'.repeat(201);
    const rejected = await api()
      .post(url)
      .set(authHeaders())
      .set('Idempotency-Key', tooLong)
      .send(createBody(h.space.id));
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
    const details = rejected.body.error.details as { field: string }[];
    assert.ok(
      details.some((d) => d.field === 'idempotencyKey'),
      'idempotencyKey must be named in the validation details',
    );

    const replayRejected = await api()
      .post(url)
      .set(authHeaders())
      .set('Idempotency-Key', tooLong)
      .send(createBody(h.space.id));
    assert.equal(replayRejected.status, 400);
    assert.equal(replayRejected.body.error.code, 'VALIDATION_ERROR');
  });

  it('lists building-scoped handyman requests only', async (t) => {
    if (!ready(t)) return;
    const hA = await createHierarchy();
    const hB = await createHierarchy();

    const inA = await api()
      .post(`/api/v1/buildings/${hA.building.id}/handyman-requests`)
      .set(authHeaders())
      .send(createBody(hA.space.id));
    assert.equal(inA.status, 201);
    const inB = await api()
      .post(`/api/v1/buildings/${hB.building.id}/handyman-requests`)
      .set(authHeaders())
      .send(createBody(hB.space.id));
    assert.equal(inB.status, 201);

    const listA = await api()
      .get(`/api/v1/buildings/${hA.building.id}/handyman-requests`)
      .set(authHeaders());
    assert.equal(listA.status, 200);
    assert.ok(Array.isArray(listA.body.data));
    const listedIds = listA.body.data.map((r: { id: string }) => r.id);
    assert.ok(listedIds.includes(inA.body.data.id));
    assert.ok(!listedIds.includes(inB.body.data.id));

    // A space from another building cannot leak building B content into A.
    const crossSpace = await api()
      .post(`/api/v1/buildings/${hA.building.id}/handyman-requests`)
      .set(authHeaders())
      .send(createBody(hB.space.id));
    assert.equal(crossSpace.status, 400);
    assert.equal(crossSpace.body.error.code, 'HANDYMAN_REQUEST_SPACE_MISMATCH');

    // Outsider without building assignment is isolated.
    const outsider = await createAdminUser();
    const outsiderList = await api()
      .get(`/api/v1/buildings/${hA.building.id}/handyman-requests`)
      .set(authHeaders(outsider.token));
    assert.equal(outsiderList.status, 403);
    assert.equal(outsiderList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Already-supported filters and pagination stay available.
    const filtered = await api()
      .get(`/api/v1/buildings/${hA.building.id}/handyman-requests`)
      .query({ status: 'SUBMITTED', inboundChannel: 'WHATSAPP', limit: 10, offset: 0 })
      .set(authHeaders());
    assert.equal(filtered.status, 200);
    assert.ok(
      filtered.body.data.every(
        (r: { status: string; inboundChannel: string }) =>
          r.status === 'SUBMITTED' && r.inboundChannel === 'WHATSAPP',
      ),
    );
    const badFilter = await api()
      .get(`/api/v1/buildings/${hA.building.id}/handyman-requests`)
      .query({ status: 'NOSUCH' })
      .set(authHeaders());
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces building access on detail', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();

    const created = await api()
      .post(`/api/v1/buildings/${h.building.id}/handyman-requests`)
      .set(authHeaders())
      .send(createBody(h.space.id));
    assert.equal(created.status, 201);

    const detail = await api()
      .get(`/api/v1/handyman-requests/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, created.body.data.id);
    assert.deepEqual(
      Object.keys(detail.body.data).sort(),
      PUBLIC_HANDYMAN_REQUEST_KEYS,
    );

    const outsider = await createAdminUser();
    const denied = await api()
      .get(`/api/v1/handyman-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const unknown = await api()
      .get(`/api/v1/handyman-requests/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'HANDYMAN_REQUEST_NOT_FOUND');

    const malformed = await api()
      .get('/api/v1/handyman-requests/not-a-uuid')
      .set(authHeaders());
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });

  it('cancels a submitted request and rejects repeated cancellation', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();

    const created = await api()
      .post(`/api/v1/buildings/${h.building.id}/handyman-requests`)
      .set(authHeaders())
      .send(createBody(h.space.id));
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;

    const cancelled = await api()
      .post(`/api/v1/handyman-requests/${id}/cancel`)
      .set(authHeaders());
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.equal(cancelled.body.data.id, id);

    const repeated = await api()
      .post(`/api/v1/handyman-requests/${id}/cancel`)
      .set(authHeaders());
    assert.equal(repeated.status, 409);
    assert.equal(
      repeated.body.error.code,
      'HANDYMAN_REQUEST_ALREADY_CANCELLED',
    );

    const detail = await api()
      .get(`/api/v1/handyman-requests/${id}`)
      .set(authHeaders());
    assert.equal(detail.body.data.status, 'CANCELLED');

    const outsider = await createAdminUser();
    const outsiderCancel = await api()
      .post(`/api/v1/handyman-requests/${id}/cancel`)
      .set(authHeaders(outsider.token));
    assert.equal(outsiderCancel.status, 403);
    assert.equal(outsiderCancel.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('lets exactly one of two concurrent cancel commands succeed with a single audit event', async (t) => {
    if (!ready(t)) return;
    const h = await createHierarchy();

    const created = await api()
      .post(`/api/v1/buildings/${h.building.id}/handyman-requests`)
      .set(authHeaders())
      .send(createBody(h.space.id));
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;

    // Two cancellation commands racing through the HTTP surface.
    const [first, second] = await Promise.all([
      api().post(`/api/v1/handyman-requests/${id}/cancel`).set(authHeaders()),
      api().post(`/api/v1/handyman-requests/${id}/cancel`).set(authHeaders()),
    ]);

    assert.deepEqual(
      [first.status, second.status].sort(),
      [200, 409],
      'exactly one command must win the transition',
    );
    const loser = first.status === 409 ? first : second;
    assert.equal(
      loser.body.error.code,
      'HANDYMAN_REQUEST_ALREADY_CANCELLED',
    );

    // Only the winning command emitted the audit event.
    const events = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_CANCELLED'`,
      [id],
    );
    assert.equal(events.rows[0].count, 1);
  });

  it('keeps runtime ↔ OpenAPI parity for exactly the four endpoints', async () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, { operationId?: string; 'x-required-permission'?: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    const routesSource = readFileSync(
      resolve(__dirname, '../src/modules/handyman-requests/handyman-request.routes.ts'),
      'utf8',
    );

    // CR-HM-BE-02 Run 3: narrowed from 'handyman' to 'handyman-requests' so
    // this exact-set assertion keeps covering the four CR-HM-BE-01 endpoints
    // only; the Handyman Provider paths added by CR-HM-BE-02 are asserted by
    // tests/handyman-provider-http.test.ts.
    // CR-HM-BE-03 Run 4: narrowed to the EXACT CR-HM-BE-01 path set — the
    // governance/commerce contracts add sub-paths under
    // /handyman-requests/{handymanRequestId} (triages, services,
    // inspections, quotations), which are asserted (bidirectionally, against
    // the runtime route registrations) by tests/handyman-commerce-http.test.ts.
    const be01Paths = new Set([
      '/buildings/{buildingId}/handyman-requests',
      '/handyman-requests/{handymanRequestId}',
      '/handyman-requests/{handymanRequestId}/cancel',
    ]);
    const handymanPaths = Object.keys(spec.paths).filter((p) => be01Paths.has(p));
    assert.deepEqual(handymanPaths.sort(), [
      '/buildings/{buildingId}/handyman-requests',
      '/handyman-requests/{handymanRequestId}',
      '/handyman-requests/{handymanRequestId}/cancel',
    ].sort());

    const expected: Record<string, Record<string, string>> = {
      '/buildings/{buildingId}/handyman-requests': {
        post: 'handyman_request.create',
        get: 'handyman_request.read',
      },
      '/handyman-requests/{handymanRequestId}': {
        get: 'handyman_request.read',
      },
      '/handyman-requests/{handymanRequestId}/cancel': {
        post: 'handyman_request.manage',
      },
    };
    for (const [path, operations] of Object.entries(expected)) {
      for (const [method, permission] of Object.entries(operations)) {
        const operation = spec.paths[path][method];
        assert.ok(operation, `missing OpenAPI ${method.toUpperCase()} ${path}`);
        assert.equal(
          operation['x-required-permission'],
          permission,
          `${method.toUpperCase()} ${path} permission`,
        );
        assert.match(
          routesSource,
          new RegExp(`requirePermission\\('${permission}'\\)`),
        );
      }
    }

    assert.ok(spec.components.schemas.HandymanRequest);
    assert.ok(spec.components.schemas.CreateHandymanRequest);
    assert.ok(
      !JSON.stringify(spec.components.schemas.HandymanRequest).includes(
        'idempotencyFingerprint',
      ),
      'the internal idempotency fingerprint must not be documented',
    );
  });
});
