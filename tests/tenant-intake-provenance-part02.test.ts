import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createTenantBuildingContext } from '../src/modules/tenant-building-contexts';
import {
  parseCreateTenantComplaintBody,
  parseUpdateTenantComplaintBody,
} from '../src/modules/tenant-complaints';
import { createTenantCompany } from '../src/modules/tenant-companies';
import { INTAKE_CHANNELS } from '../src/modules/tenant-intake';
import { createTenantPic } from '../src/modules/tenant-pics';
import {
  parseCreateTenantServiceRequestBody,
  parseUpdateTenantServiceRequestBody,
} from '../src/modules/tenant-service-requests';
import { assignSpaceToTenant } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-ASSISTED-INTAKE-01 PART 02 — CREATE CONTRACT & SERVER-DERIVED ACTOR
 * ACTIVATION.
 *
 * Activates assisted-intake provenance on the two existing create APIs:
 *
 *   POST /tenant-companies/{tenantCompanyId}/service-requests
 *   POST /tenant-companies/{tenantCompanyId}/complaints
 *
 * Provenance contract under test:
 *   - `intakeChannel`   optional, canonical 8-value vocabulary, omitted→NULL;
 *   - reporterName / reporterPhone / reporterEmail optional+nullable contacts;
 *   - `createdByUserId` server-derived from the authenticated session and
 *     NEVER accepted from the request body (spoof-resistant).
 *
 * Acceptance coverage (directive A–X):
 *   A assisted create accepts the channel            B exact 8-value enforcement
 *   C authenticated actor persisted as creator       D canonical identity
 *   E reporter persistence & null                    F spoof resistance
 *   G omitted channel persists NULL                  H self-service compatibility
 *   I create/read returns provenance                 J no default channel guess
 *   K+O create schema hides createdByUserId          L PATCH unchanged (immutability)
 *   M permission remains `tenant_company.manage`     N downstream lifecycle unchanged
 *
 * This test exercises the public HTTP contract plus the validation parsers; it
 * performs NO migration, permission-registry or lifecycle change itself.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

const DB_PORT = 55521;
const DATA_DIR = '/tmp/asentra-assisted-intake-02-pg';
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
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

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
  await pool.query(
    `TRUNCATE tenant_service_requests, tenant_complaints,
       tenant_building_contexts, tenant_space_relationships, tenant_pics,
       tenant_companies, findings, work_orders, work_requests, spaces, rooms,
       areas, floors, buildings, properties, users, roles, permissions,
       clients CASCADE`,
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
    if (EMBEDDED_DATABASE) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  pg = null;
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const auth = (value = adminToken) => ({ Authorization: `Bearer ${value}` });

/** Full tenant intake fixture created through the services (identity only). */
async function fixture(assignUserIds: string[] = [adminUserId]) {
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
  for (const assignUserId of assignUserIds) {
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
    name: 'Tenant Space',
  });
  const company = await createTenantCompany(
    { clientId: client.id, tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' },
    adminUserId,
  );
  const pic = await createTenantPic(
    { tenantCompanyId: company.id, picName: 'Tenant Requester' },
    adminUserId,
  );
  await assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id },
    adminUserId,
  );
  await createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminUserId,
  );
  return { client, building, space, company, pic };
}

async function createServiceRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
  withToken = adminToken,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/service-requests`)
    .set(auth(withToken))
    .send({
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
      requestNumber: `SR_${suffix()}`,
      requestType: 'MAINTENANCE',
      title: 'Assisted intake request',
      ...overrides,
    });
}

async function createComplaint(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
  withToken = adminToken,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/complaints`)
    .set(auth(withToken))
    .send({
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
      complaintNumber: `CMP_${suffix()}`,
      complaintType: 'FACILITY_QUALITY',
      title: 'Assisted intake complaint',
      ...overrides,
    });
}

/** Provision a user + role (exact code/name/permissions) and log in. */
async function provisionUser(
  roleCode: string,
  roleName: string,
  permissionCodes: { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const s = suffix();
  const password = 'Provision123';
  const user = await userService.createUser({
    email: `prov-${s.toLowerCase()}@example.com`,
    displayName: roleName,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: roleCode, name: roleName });
  for (const permission of permissionCodes) {
    let permissionId = (await permissionRepository.findByCode(permission.code))?.id;
    if (!permissionId) {
      permissionId = (await permissionService.createPermission({
        code: permission.code,
        name: permission.name,
      })).id;
    }
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

describe('CR-BE-ASSISTED-INTAKE-01 PART 02 — create contract & server-derived actor', () => {
  it('enforces the EXACT 8-channel vocabulary and never defaults a channel (B/G/J)', () => {
    // Every canonical value is accepted (and trimmed/upper-cased) by both parsers.
    for (const channel of INTAKE_CHANNELS) {
      const parsed = parseCreateTenantServiceRequestBody({
        tenantPicId: randomUUID(),
        buildingId: randomUUID(),
        requestNumber: 'SR_VOCAB_1',
        requestType: 'MAINTENANCE',
        title: 'Vocabulary probe',
        intakeChannel: channel,
      });
      assert.equal(parsed.intakeChannel, channel);
      const complaint = parseCreateTenantComplaintBody({
        tenantPicId: randomUUID(),
        buildingId: randomUUID(),
        complaintNumber: 'CMP_VOCAB_1',
        complaintType: 'FACILITY_QUALITY',
        title: 'Vocabulary probe',
        intakeChannel: channel,
      });
      assert.equal(complaint.intakeChannel, channel);
    }

    // Whitespace + lowercase normalize to the canonical value.
    assert.equal(
      parseCreateTenantServiceRequestBody({
        tenantPicId: randomUUID(),
        buildingId: randomUUID(),
        requestNumber: 'SR_VOCAB_2',
        requestType: 'MAINTENANCE',
        title: 'Vocabulary probe',
        intakeChannel: ' walk_in ',
      }).intakeChannel,
      'WALK_IN',
    );

    // Anything outside the 8 values is rejected, never coerced or defaulted.
    const detailForIntakeChannel = (error: unknown): boolean =>
      Array.isArray((error as { details?: unknown }).details) &&
      ((error as { details: Array<{ field?: string }> }).details.some(
        (d) => d.field === 'intakeChannel',
      ));
    assert.throws(
      () => parseCreateTenantServiceRequestBody({
        tenantPicId: randomUUID(),
        buildingId: randomUUID(),
        requestNumber: 'SR_VOCAB_3',
        requestType: 'MAINTENANCE',
        title: 'Vocabulary probe',
        intakeChannel: 'SMS',
      }),
      detailForIntakeChannel,
    );
    assert.throws(
      () => parseCreateTenantComplaintBody({
        tenantPicId: randomUUID(),
        buildingId: randomUUID(),
        complaintNumber: 'CMP_VOCAB_2',
        complaintType: 'FACILITY_QUALITY',
        title: 'Vocabulary probe',
        intakeChannel: 'CARRIER_PIGEON',
      }),
      detailForIntakeChannel,
    );
    assert.throws(
      () => parseCreateTenantServiceRequestBody({
        tenantPicId: randomUUID(),
        buildingId: randomUUID(),
        requestNumber: 'SR_VOCAB_4',
        requestType: 'MAINTENANCE',
        title: 'Vocabulary probe',
        intakeChannel: 42,
      }),
      detailForIntakeChannel,
    );

    // Omission is NOT a default: the parsed input simply has no intakeChannel.
    const omitted = parseCreateTenantServiceRequestBody({
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      requestNumber: 'SR_VOCAB_5',
      requestType: 'MAINTENANCE',
      title: 'Vocabulary probe',
    });
    assert.equal('intakeChannel' in omitted, false);
    const omittedComplaint = parseCreateTenantComplaintBody({
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      complaintNumber: 'CMP_VOCAB_3',
      complaintType: 'FACILITY_QUALITY',
      title: 'Vocabulary probe',
    });
    assert.equal('intakeChannel' in omittedComplaint, false);
  });

  it('create schema does NOT accept createdByUserId / actor overrides (C/K/O)', () => {
    const spoofKeys = {
      createdByUserId: randomUUID(),
      created_by_user_id: randomUUID(),
      actorUserId: randomUUID(),
      createdBy: randomUUID(),
      enteredBy: randomUUID(),
      role: 'admin',
    };
    const parsed = parseCreateTenantServiceRequestBody({
      ...spoofKeys,
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      requestNumber: 'SR_SPOOF_02',
      requestType: 'MAINTENANCE',
      title: 'Spoof probe',
    });
    for (const key of Object.keys(spoofKeys)) {
      assert.ok(!(key in parsed), `${key} must not be accepted from the body`);
    }
    const complaint = parseCreateTenantComplaintBody({
      ...spoofKeys,
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      complaintNumber: 'CMP_SPOOF_02',
      complaintType: 'FACILITY_QUALITY',
      title: 'Spoof probe',
    });
    for (const key of Object.keys(spoofKeys)) {
      assert.ok(!(key in complaint), `${key} must not be accepted from the body`);
    }
  });

  it('PATCH schemas are unchanged and cannot edit provenance (L/immutability)', () => {
    // Provenance fields are create-time snapshots: update parsers must not read
    // intakeChannel / reporter* / createdBy*, so a PATCH body cannot change them.
    const sr = parseUpdateTenantServiceRequestBody({
      title: 'New title',
      intakeChannel: 'PHONE',
      reporterName: 'Edited Reporter',
      createdByUserId: randomUUID(),
    });
    assert.equal(sr.title, 'New title');
    assert.ok(!('intakeChannel' in sr));
    assert.ok(!('reporterName' in sr));
    assert.ok(!('createdByUserId' in sr));

    const cmp = parseUpdateTenantComplaintBody({
      title: 'New complaint title',
      intakeChannel: 'EMAIL',
      reporterEmail: 'edited@example.com',
      createdByUserId: randomUUID(),
    });
    assert.equal(cmp.title, 'New complaint title');
    assert.ok(!('intakeChannel' in cmp));
    assert.ok(!('reporterEmail' in cmp));
    assert.ok(!('createdByUserId' in cmp));
  });

  it('assisted create persists channel + reporter contacts and returns them (A/E/I)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const created = await createServiceRequest(f, {
      intakeChannel: 'WALK_IN',
      reporterName: 'Walk-in Reporter',
      reporterPhone: '+62 812 3456 7890',
      reporterEmail: 'WALKIN@EXAMPLE.COM',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const data = created.body.data;
    assert.equal(data.intakeChannel, 'WALK_IN');
    assert.equal(data.reporterName, 'Walk-in Reporter');
    assert.equal(data.reporterPhone, '+62 812 3456 7890');
    assert.equal(data.reporterEmail, 'walkin@example.com');
    assert.equal(data.createdByUserId, adminUserId);

    // Create response and GET read both surface the persisted provenance.
    const read = await api()
      .get(`/api/v1/tenant-service-requests/${data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.intakeChannel, 'WALK_IN');
    assert.equal(read.body.data.reporterName, 'Walk-in Reporter');
    assert.equal(read.body.data.createdByUserId, adminUserId);

    const complaint = await createComplaint(f, {
      intakeChannel: 'WHATSAPP',
      reporterName: 'WhatsApp Reporter',
      reporterPhone: '0812-0000-1111',
      reporterEmail: null,
    });
    assert.equal(complaint.status, 201, JSON.stringify(complaint.body));
    assert.equal(complaint.body.data.intakeChannel, 'WHATSAPP');
    assert.equal(complaint.body.data.reporterName, 'WhatsApp Reporter');
    assert.equal(complaint.body.data.reporterPhone, '0812-0000-1111');
    assert.equal(complaint.body.data.reporterEmail, null);
    assert.equal(complaint.body.data.createdByUserId, adminUserId);

    const complaintRead = await api()
      .get(`/api/v1/tenant-complaints/${complaint.body.data.id}`)
      .set(auth());
    assert.equal(complaintRead.body.data.intakeChannel, 'WHATSAPP');
  });

  it('omitted provenance persists NULL for the reporter fields and channel (G)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createServiceRequest(f, {
      intakeChannel: null,
      reporterName: null,
      reporterPhone: null,
      reporterEmail: null,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.intakeChannel, null);
    assert.equal(created.body.data.reporterName, null);
    assert.equal(created.body.data.reporterPhone, null);
    assert.equal(created.body.data.reporterEmail, null);
  });

  it('self-service payloads without new fields stay compatible (H)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createServiceRequest(f, {
      requestType: 'MAINTENANCE',
      title: 'Legacy self-service request',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.intakeChannel, null);
    assert.equal(created.body.data.createdByUserId, adminUserId);
    assert.equal(created.body.data.reporterName, null);

    const complaint = await createComplaint(f, {
      complaintType: 'FACILITY_QUALITY',
      title: 'Legacy self-service complaint',
    });
    assert.equal(complaint.status, 201, JSON.stringify(complaint.body));
    assert.equal(complaint.body.data.intakeChannel, null);
    assert.equal(complaint.body.data.createdByUserId, adminUserId);
  });

  it('rejects an out-of-vocabulary intakeChannel over HTTP (B)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const bad = await createServiceRequest(f, { intakeChannel: 'SMS' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
    const badComplaint = await createComplaint(f, { intakeChannel: 'TEXT_MESSAGE' });
    assert.equal(badComplaint.status, 400, JSON.stringify(badComplaint.body));
    assert.equal(badComplaint.body.error.code, 'VALIDATION_ERROR');
  });

  it('persists the authenticated actor and ignores a spoofed creator (C/F)', async (t) => {
    if (!ready(t)) return;
    const actor = await createAdminUser();
    const f = await fixture([adminUserId, actor.userId]);
    const spoofed = randomUUID();

    const created = await createServiceRequest(f, {
      createdByUserId: spoofed,
      created_by_user_id: spoofed,
      actorUserId: spoofed,
      createdBy: spoofed,
      enteredBy: spoofed,
      role: 'superadmin',
      intakeChannel: 'PHONE',
    }, actor.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.createdByUserId, actor.userId);
    assert.notEqual(created.body.data.createdByUserId, spoofed);

    const complaint = await createComplaint(f, {
      createdByUserId: spoofed,
      created_by_user_id: spoofed,
      actorUserId: spoofed,
      createdBy: spoofed,
      intakeChannel: 'EMAIL',
    }, actor.token);
    assert.equal(complaint.status, 201, JSON.stringify(complaint.body));
    assert.equal(complaint.body.data.createdByUserId, actor.userId);
    assert.notEqual(complaint.body.data.createdByUserId, spoofed);

    // Prove the database row (not just the response) carries the actor.
    const { rows } = await pool!.query(
      `SELECT created_by_user_id FROM tenant_service_requests
        WHERE id = $1`,
      [created.body.data.id],
    );
    assert.equal(rows[0].created_by_user_id, actor.userId);
  });

  it('preserves the canonical identity and authority (D)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const spoofedClient = randomUUID();
    const created = await createServiceRequest(f, {
      clientId: spoofedClient,
      intakeChannel: 'FRONT_DESK',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const data = created.body.data;
    // clientId is derived from the Tenant Company, never from the body.
    assert.equal(data.clientId, f.client.id);
    assert.notEqual(data.clientId, spoofedClient);
    assert.equal(data.tenantCompanyId, f.company.id);
    assert.equal(data.tenantPicId, f.pic.id);
    assert.equal(data.buildingId, f.building.id);
    assert.equal(data.spaceId, f.space.id);

    const complaint = await createComplaint(f, { intakeChannel: 'OTHER' });
    assert.equal(complaint.status, 201, JSON.stringify(complaint.body));
    assert.equal(complaint.body.data.clientId, f.client.id);
    assert.equal(complaint.body.data.tenantCompanyId, f.company.id);
    assert.equal(complaint.body.data.tenantPicId, f.pic.id);
    assert.equal(complaint.body.data.buildingId, f.building.id);
  });

  it('authority stays permission-based (tenant_company.manage), never role-name (M)', async (t) => {
    if (!ready(t)) return;
    // A user with a TENANT-LOOKALIKE role code but no manage permission is denied.
    const tenantSounding = await provisionUser(
      `TENANT_LIKE_${suffix()}`,
      'TenantSounding Clerk',
      [{ code: 'tenant_company.read', name: 'Read Tenant Companies' }],
    );
    // A user with an entirely generic role name carrying the manage permission succeeds.
    const genericManager = await provisionUser(
      `CLERK_${suffix()}`,
      'Ordinary Clerk',
      [
        { code: 'tenant_company.read', name: 'Read Tenant Companies' },
        { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
      ],
    );

    const f = await fixture([adminUserId, genericManager.userId]);
    const denied = await createServiceRequest(f, {}, tenantSounding.token);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const allowed = await createServiceRequest(
      f,
      { intakeChannel: 'MOBILE', requestNumber: `SR_PM_${suffix()}` },
      genericManager.token,
    );
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.createdByUserId, genericManager.userId);
  });

  it('downstream lifecycle/WO/Task binding is unchanged by provenance (N)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createServiceRequest(f, {
      intakeChannel: 'EMAIL',
      reporterEmail: 'lifecycle@example.com',
      requestNumber: `SR_LC_${suffix()}`,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;

    const workRequestBinding = await api()
      .post(`/api/v1/tenant-service-requests/${id}/work-request`)
      .set(auth());
    assert.equal(workRequestBinding.status, 201, JSON.stringify(workRequestBinding.body));
    assert.equal(workRequestBinding.body.data.status, 'CONVERTED');
    assert.ok(workRequestBinding.body.data.workRequestId);

    const workOrderBinding = await api()
      .post(`/api/v1/tenant-service-requests/${id}/work-order`)
      .set(auth())
      .send({ workOrderNumber: `WO_${suffix()}` });
    assert.equal(workOrderBinding.status, 201, JSON.stringify(workOrderBinding.body));
    assert.ok(workOrderBinding.body.data.workOrderId);

    // Provenance is preserved through the conversion and remains creator-bound.
    const reread = await api()
      .get(`/api/v1/tenant-service-requests/${id}`)
      .set(auth());
    assert.equal(reread.body.data.intakeChannel, 'EMAIL');
    assert.equal(reread.body.data.reporterEmail, 'lifecycle@example.com');
    assert.equal(reread.body.data.createdByUserId, adminUserId);
  });
});
