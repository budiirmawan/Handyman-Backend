import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createTenantBuildingContext } from '../src/modules/tenant-building-contexts';
import { createTenantCompany } from '../src/modules/tenant-companies';
import { createTenantPic } from '../src/modules/tenant-pics';
import {
  parseCreateTenantComplaintBody,
  tenantComplaintRepository,
} from '../src/modules/tenant-complaints';
import {
  INTAKE_CHANNELS,
  isIntakeChannel,
} from '../src/modules/tenant-intake';
import {
  parseCreateTenantServiceRequestBody,
  tenantServiceRequestRepository,
} from '../src/modules/tenant-service-requests';
import { assignSpaceToTenant } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-ASSISTED-INTAKE-01 PART 01 — provenance persistence foundation.
 *
 * Bounded persistence + domain test only. No endpoint, no OpenAPI, no
 * lifecycle/permission/Work Order/Task behavior is exercised here. PART 01
 * adds the canonical provenance columns and repository hydration for BOTH
 * tenant intake domains:
 *
 *   intake_channel     (nullable, EXACT shared vocabulary)
 *   created_by_user_id (nullable, FK to users — internal provenance only)
 *   reporter_name / reporter_phone / reporter_email (nullable, free-text)
 *
 * The existing canonical identity fields (clientId, tenantCompanyId,
 * tenantPicId, buildingId, spaceId) and their semantics are untouched, and
 * the public HTTP validation must NOT accept createdByUserId /
 * created_by_user_id from a request body.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

const DB_PORT = 55520;
const DATA_DIR = '/tmp/asentra-assisted-intake-01-pg';
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
       tenant_companies, work_orders, work_requests, spaces, rooms, areas,
       floors, buildings, properties, users, roles, permissions, clients
       CASCADE`,
  );
  const admin = await createAdminUser();
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

async function fixture() {
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

describe('CR-BE-ASSISTED-INTAKE-01 PART 01 — intake provenance foundation', () => {
  it('exposes the EXACT intake channel vocabulary', () => {
    assert.deepEqual(INTAKE_CHANNELS, [
      'PORTAL', 'MOBILE', 'PHONE', 'WHATSAPP', 'EMAIL', 'WALK_IN',
      'FRONT_DESK', 'OTHER',
    ]);
    assert.equal(isIntakeChannel('WHATSAPP'), true);
    assert.equal(isIntakeChannel('OTHER'), true);
    assert.equal(isIntakeChannel('SMS'), false);
    assert.equal(isIntakeChannel(null), false);
  });

  it('adds nullable provenance columns to tenant_service_requests', async (t) => {
    if (!ready(t)) return;
    const { rows } = await pool!.query(`
      SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
       WHERE table_name = 'tenant_service_requests'
         AND column_name IN ('intake_channel', 'created_by_user_id',
           'reporter_name', 'reporter_phone', 'reporter_email')
    `);
    assert.equal(rows.length, 5, 'all five provenance columns must exist');
    for (const row of rows) {
      assert.equal(row.is_nullable, 'YES', `${row.column_name} must be nullable`);
    }
    const types = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    assert.equal(types.intake_channel, 'text');
    assert.equal(types.created_by_user_id, 'uuid');
    assert.equal(types.reporter_name, 'text');
    assert.equal(types.reporter_phone, 'text');
    assert.equal(types.reporter_email, 'text');
  });

  it('adds nullable provenance columns to tenant_complaints', async (t) => {
    if (!ready(t)) return;
    const { rows } = await pool!.query(`
      SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
       WHERE table_name = 'tenant_complaints'
         AND column_name IN ('intake_channel', 'created_by_user_id',
           'reporter_name', 'reporter_phone', 'reporter_email')
    `);
    assert.equal(rows.length, 5, 'all five provenance columns must exist');
    for (const row of rows) {
      assert.equal(row.is_nullable, 'YES', `${row.column_name} must be nullable`);
    }
    const types = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    assert.equal(types.intake_channel, 'text');
    assert.equal(types.created_by_user_id, 'uuid');
  });

  it('enforces the intake channel vocabulary at rest', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await pool!.query(`
      INSERT INTO tenant_service_requests
        (id, client_id, tenant_company_id, tenant_pic_id, building_id,
         request_number, request_type, title)
      VALUES ($1, $2, $3, $4, $5, $6, 'MAINTENANCE', 'Channel probe')
    `, [randomUUID(), f.client.id, f.company.id, f.pic.id, f.building.id,
      `SR_${suffix()}`]);
    await pool!.query(`
      INSERT INTO tenant_complaints
        (id, client_id, tenant_company_id, tenant_pic_id, building_id,
         complaint_number, complaint_type, title)
      VALUES ($1, $2, $3, $4, $5, $6, 'NOISE', 'Channel probe')
    `, [randomUUID(), f.client.id, f.company.id, f.pic.id, f.building.id,
      `CMP_${suffix()}`]);

    await assert.rejects(
      () => pool!.query(
        `UPDATE tenant_service_requests SET intake_channel = 'SMS'`,
      ),
      /intake_channel/,
    );
    await assert.rejects(
      () => pool!.query(
        `UPDATE tenant_complaints SET intake_channel = 'CARRIER_PIGEON'`,
      ),
      /intake_channel/,
    );
  });

  it('enforces the created_by_user_id FK at rest', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await pool!.query(`
      INSERT INTO tenant_service_requests
        (id, client_id, tenant_company_id, tenant_pic_id, building_id,
         request_number, request_type, title)
      VALUES ($1, $2, $3, $4, $5, $6, 'MAINTENANCE', 'FK probe')
    `, [randomUUID(), f.client.id, f.company.id, f.pic.id, f.building.id,
      `SR_${suffix()}`]);

    await assert.rejects(
      () => pool!.query(
        `UPDATE tenant_service_requests SET created_by_user_id = $1`,
        [randomUUID()],
      ),
      /foreign key constraint/i,
    );
  });

  it('SR repository persists and hydrates full provenance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await tenantServiceRequestRepository.create({
      clientId: f.client.id,
      tenantCompanyId: f.company.id,
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: null,
      intakeChannel: 'WHATSAPP',
      createdByUserId: adminUserId,
      reporterName: 'Walking Reporter',
      reporterPhone: '+62 812 3456 7890',
      reporterEmail: 'reporter@example.com',
      requestNumber: `SR_${suffix()}`,
      requestType: 'MAINTENANCE',
      title: 'AC leaking',
      description: null,
      priority: 'HIGH',
    });

    const loaded = await tenantServiceRequestRepository.findById(created.id);
    assert.ok(loaded);
    assert.equal(loaded.intakeChannel, 'WHATSAPP');
    assert.equal(loaded.createdByUserId, adminUserId);
    assert.equal(loaded.reporterName, 'Walking Reporter');
    assert.equal(loaded.reporterPhone, '+62 812 3456 7890');
    assert.equal(loaded.reporterEmail, 'reporter@example.com');
    assert.equal(loaded.tenantCompanyId, f.company.id);
    assert.equal(loaded.tenantPicId, f.pic.id);
    assert.equal(loaded.buildingId, f.building.id);
    assert.equal(loaded.spaceId, null);
  });

  it('Complaint repository persists and hydrates full provenance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await tenantComplaintRepository.create({
      clientId: f.client.id,
      tenantCompanyId: f.company.id,
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: null,
      intakeChannel: 'PHONE',
      createdByUserId: adminUserId,
      reporterName: 'Phone Reporter',
      reporterPhone: '021 555 0123',
      reporterEmail: null,
      complaintNumber: `CMP_${suffix()}`,
      complaintType: 'NOISE',
      title: 'Loud unit above',
      description: null,
      severity: 'LOW',
    });

    const loaded = await tenantComplaintRepository.findById(created.id);
    assert.ok(loaded);
    assert.equal(loaded.intakeChannel, 'PHONE');
    assert.equal(loaded.createdByUserId, adminUserId);
    assert.equal(loaded.reporterName, 'Phone Reporter');
    assert.equal(loaded.reporterPhone, '021 555 0123');
    assert.equal(loaded.reporterEmail, null);
    assert.equal(loaded.tenantCompanyId, f.company.id);
    assert.equal(loaded.tenantPicId, f.pic.id);
    assert.equal(loaded.buildingId, f.building.id);
  });

  it('legacy rows remain representable with NULL provenance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const [sr, cmp] = await Promise.all([
      tenantServiceRequestRepository.create({
        clientId: f.client.id,
        tenantCompanyId: f.company.id,
        tenantPicId: f.pic.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
        requestNumber: `SR_${suffix()}`,
        requestType: 'MAINTENANCE',
        title: 'Legacy request',
        description: null,
        priority: 'MEDIUM',
      }),
      tenantComplaintRepository.create({
        clientId: f.client.id,
        tenantCompanyId: f.company.id,
        tenantPicId: f.pic.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
        complaintNumber: `CMP_${suffix()}`,
        complaintType: 'NOISE',
        title: 'Legacy complaint',
        description: null,
        severity: 'MEDIUM',
      }),
    ]);
    const loadedSr = await tenantServiceRequestRepository.findById(sr.id);
    const loadedCmp = await tenantComplaintRepository.findById(cmp.id);
    assert.equal(loadedSr?.intakeChannel, null);
    assert.equal(loadedSr?.createdByUserId, null);
    assert.equal(loadedSr?.reporterName, null);
    assert.equal(loadedSr?.reporterPhone, null);
    assert.equal(loadedSr?.reporterEmail, null);
    assert.equal(loadedCmp?.intakeChannel, null);
    assert.equal(loadedCmp?.createdByUserId, null);
    assert.equal(loadedCmp?.reporterName, null);
    assert.equal(loadedCmp?.reporterPhone, null);
    assert.equal(loadedCmp?.reporterEmail, null);
  });

  it('preserves the canonical SR identity fields unchanged', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await tenantServiceRequestRepository.create({
      clientId: f.client.id,
      tenantCompanyId: f.company.id,
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
      requestNumber: `SR_${suffix()}`,
      requestType: 'PLUMBING',
      title: 'Leak',
      description: null,
      priority: 'MEDIUM',
    });
    assert.equal(created.clientId, f.client.id);
    assert.equal(created.tenantCompanyId, f.company.id);
    assert.equal(created.tenantPicId, f.pic.id);
    assert.equal(created.buildingId, f.building.id);
    assert.equal(created.spaceId, f.space.id);
  });

  it('public HTTP validation does not accept createdByUserId as the actor', () => {
    const spoilBody = {
      createdByUserId: randomUUID(),
      created_by_user_id: randomUUID(),
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      requestNumber: 'SR_SPOOF_01',
      requestType: 'MAINTENANCE',
      title: 'Spoof probe',
    };
    const parsed = parseCreateTenantServiceRequestBody(spoilBody);
    assert.ok(!('createdByUserId' in parsed), 'createdByUserId must not be accepted');
    assert.ok(!('created_by_user_id' in parsed), 'created_by_user_id must not be accepted');
    assert.equal(parsed.requestNumber, 'SR_SPOOF_01');

    const complaintParsed = parseCreateTenantComplaintBody({
      createdByUserId: randomUUID(),
      created_by_user_id: randomUUID(),
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      complaintNumber: 'CMP_SPOOF_01',
      complaintType: 'NOISE',
      title: 'Spoof probe',
    });
    assert.ok(!('createdByUserId' in complaintParsed));
    assert.ok(!('created_by_user_id' in complaintParsed));
    assert.equal(complaintParsed.complaintNumber, 'CMP_SPOOF_01');
  });

  it('rollback (migrateDown) removes the provenance columns from both tables', async (t) => {
    if (!ready(t)) return;
    const before = await pool!.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'tenant_service_requests' AND column_name = 'intake_channel'
    `);
    assert.equal(before.rowCount, 1);

    const rolledBackId = await migrateDown(pool);
    assert.equal(rolledBackId, '0359_add_tenant_intake_provenance');

    for (const [table, column] of [
      ['tenant_service_requests', 'intake_channel'],
      ['tenant_service_requests', 'created_by_user_id'],
      ['tenant_service_requests', 'reporter_email'],
      ['tenant_complaints', 'intake_channel'],
      ['tenant_complaints', 'created_by_user_id'],
      ['tenant_complaints', 'reporter_email'],
    ] as const) {
      const after = await pool!.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [table, column],
      );
      assert.equal(after.rowCount, 0, `${table}.${column} must be removed by down()`);
    }

    const fk = await pool!.query(`
      SELECT 1 FROM pg_constraint
       WHERE conname IN (
         'tenant_service_requests_created_by_user_id_fkey',
         'tenant_complaints_created_by_user_id_fkey'
       )
    `);
    assert.equal(fk.rowCount, 0, 'both FKs must be removed by down()');

    // Restore the migration so the suite state remains fully migrated.
    await migrateUp(pool);
  });

  it('a real user id is an acceptable createdByUserId (internal provenance only)', async (t) => {
    if (!ready(t)) return;
    const user = await userService.createUser({
      email: `intake-actor-${suffix().toLowerCase()}@example.com`,
      displayName: 'Intake Actor',
    });
    const f = await fixture();
    const created = await tenantServiceRequestRepository.create({
      clientId: f.client.id,
      tenantCompanyId: f.company.id,
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: null,
      intakeChannel: 'OTHER',
      createdByUserId: user.id,
      requestNumber: `SR_${suffix()}`,
      requestType: 'OTHER',
      title: 'Actor provenance',
      description: null,
      priority: 'MEDIUM',
    });
    const loaded = await tenantServiceRequestRepository.findById(created.id);
    assert.equal(loaded?.createdByUserId, user.id);
  });
});
