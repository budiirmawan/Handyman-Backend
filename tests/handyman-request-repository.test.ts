import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp, runSeeds } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  handymanRequestRepository,
  type HandymanRequestRecord,
} from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55470;
const DIR = '/tmp/asentra-hm-run1-pg';
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
let db: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function ok(t: TestContext): boolean {
  if (!db || !pool) {
    t.skip('database unavailable');
    return false;
  }
  return true;
}

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

  const config = await ensureTestDatabase();
  if (!config) return;
  db = config;
  pool = await initDatabase(config);
  await migrateUp(pool);
  await runSeeds(pool);

  const admin = await createAdminUser();
  adminUserId = admin.userId;
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
  db = null;
});

async function createHierarchy(options: { client?: PublicClient } = {}) {
  const client =
    options.client ??
    (await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Handyman Client',
    }));

  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Handyman Property',
  });

  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Handyman Tower',
  });

  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${suffix()}`,
    name: 'Floor 1',
    levelNumber: 1,
  });

  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Residential Area',
  });

  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Residential Corridor',
  });

  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `U_${suffix()}`,
    name: 'Unit 101',
  });

  return { client, property, building, floor, area, room, space };
}

describe('CR-HM-BE-01 RUN 1 — Migration & Permissions', () => {
  it('applies migration 0348, verifies permissions and PLATFORM_ADMIN grants', async (t) => {
    if (!ok(t)) return;

    const permissions = await pool!.query<{ code: string; name: string }>(
      `SELECT code, name FROM permissions
       WHERE code IN ('handyman_request.create', 'handyman_request.read', 'handyman_request.manage')
       ORDER BY code ASC`,
    );

    assert.equal(permissions.rows.length, 3);
    assert.deepEqual(
      permissions.rows.map((p) => p.code),
      ['handyman_request.create', 'handyman_request.manage', 'handyman_request.read'],
    );

    // Assert PLATFORM_ADMIN holds these permissions
    const assignments = await pool!.query<{ code: string }>(
      `SELECT p.code
       FROM role_permission_assignments rpa
       JOIN roles r ON r.id = rpa.role_id
       JOIN permissions p ON p.id = rpa.permission_id
       WHERE r.code = 'PLATFORM_ADMIN'
         AND p.code IN ('handyman_request.create', 'handyman_request.read', 'handyman_request.manage')
         AND rpa.status = 'ACTIVE'
       ORDER BY p.code ASC`,
    );

    assert.equal(assignments.rows.length, 3);
  });

  it('verifies downgrade and re-migration cycle', async (t) => {
    if (!ok(t)) return;

    // Down 0348
    const downResult = await migrateDown(pool!);
    assert.equal(downResult, '0348_create_handyman_requests');

    // Table should not exist
    const checkTable = await pool!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'handyman_requests'
       ) AS exists`,
    );
    assert.equal(checkTable.rows[0].exists, false);

    // Re-up
    const upResult = await migrateUp(pool!);
    assert.ok(upResult.includes('0348_create_handyman_requests'));

    const checkTableAgain = await pool!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'handyman_requests'
       ) AS exists`,
    );
    assert.equal(checkTableAgain.rows[0].exists, true);
  });
});

describe('CR-HM-BE-01 RUN 1 — Handyman Request Repository', () => {
  it('creates a handyman request with customer snapshot and actor attribution', async (t) => {
    if (!ok(t)) return;

    const h = await createHierarchy();
    const reqNum = `HMR_${suffix()}`;

    const { record, created } = await handymanRequestRepository.create({
      clientId: h.client.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: 'Jane Resident',
      customerPhone: '+6281234567890',
      customerEmail: 'jane@example.com',
      createdByUserId: adminUserId,
      operationalSurface: 'BM_SUPER_APP',
      inboundChannel: 'WHATSAPP',
      requestNumber: reqNum,
      title: 'Water leak under kitchen sink',
      description: 'Persistent dripping sound and wet cabinet base.',
      priority: 'HIGH',
    });

    assert.equal(created, true);
    assert.ok(record.id);
    assert.equal(record.clientId, h.client.id);
    assert.equal(record.buildingId, h.building.id);
    assert.equal(record.spaceId, h.space.id);
    assert.equal(record.customerName, 'Jane Resident');
    assert.equal(record.customerPhone, '+6281234567890');
    assert.equal(record.customerEmail, 'jane@example.com');
    assert.equal(record.createdByUserId, adminUserId);
    assert.equal(record.operationalSurface, 'BM_SUPER_APP');
    assert.equal(record.inboundChannel, 'WHATSAPP');
    assert.equal(record.requestNumber, reqNum);
    assert.equal(record.title, 'Water leak under kitchen sink');
    assert.equal(record.priority, 'HIGH');
    assert.equal(record.status, 'SUBMITTED');
    assert.ok(record.requestedAt instanceof Date);
    assert.ok(record.createdAt instanceof Date);
    assert.ok(record.updatedAt instanceof Date);
  });

  it('supports optional tenant company and PIC relationships', async (t) => {
    if (!ok(t)) return;

    const h = await createHierarchy();
    const company = await tenantCompanyService.createTenantCompany(
      {
        clientId: h.client.id,
        tenantCode: `TC_${suffix()}`,
        tenantName: 'Apartment Leasing Corp',
      },
      adminUserId,
    );
    const pic = await tenantPicService.createTenantPic(
      {
        tenantCompanyId: company.id,
        picName: 'PIC Officer',
      },
      adminUserId,
    );

    const { record } = await handymanRequestRepository.create({
      clientId: h.client.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
      tenantCompanyId: company.id,
      tenantPicId: pic.id,
      customerName: 'Resident via Tenant Company',
      createdByUserId: adminUserId,
      inboundChannel: 'PHONE',
      requestNumber: `HMR_${suffix()}`,
      title: 'Electrical outlet sparking',
    });

    assert.equal(record.tenantCompanyId, company.id);
    assert.equal(record.tenantPicId, pic.id);
    assert.equal(record.inboundChannel, 'PHONE');
  });

  it('retrieves by id and by request number', async (t) => {
    if (!ok(t)) return;

    const h = await createHierarchy();
    const reqNum = `HMR_${suffix()}`;

    const { record: created } = await handymanRequestRepository.create({
      clientId: h.client.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: 'Walk-in Resident',
      createdByUserId: adminUserId,
      inboundChannel: 'WALK_IN',
      requestNumber: reqNum,
      title: 'Door lock loose',
    });

    const byId = await handymanRequestRepository.findById(created.id);
    assert.ok(byId);
    assert.equal(byId.id, created.id);
    assert.equal(byId.requestNumber, reqNum);

    const byNumber = await handymanRequestRepository.findByRequestNumber(h.client.id, reqNum);
    assert.ok(byNumber);
    assert.equal(byNumber.id, created.id);

    const missing = await handymanRequestRepository.findById(randomUUID());
    assert.equal(missing, null);
  });

  it('handles idempotency replay and prevents duplicate creation', async (t) => {
    if (!ok(t)) return;

    const h = await createHierarchy();
    const idempotencyKey = `idem-${suffix()}`;
    const fingerprint = 'a'.repeat(64);
    const reqNum = `HMR_${suffix()}`;

    const first = await handymanRequestRepository.create({
      clientId: h.client.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: 'Repeat Caller',
      createdByUserId: adminUserId,
      inboundChannel: 'OTHER',
      requestNumber: reqNum,
      title: 'Lighting ballast hum',
      idempotencyKey,
      idempotencyFingerprint: fingerprint,
    });
    assert.equal(first.created, true);

    const replay = await handymanRequestRepository.create({
      clientId: h.client.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: 'Repeat Caller',
      createdByUserId: adminUserId,
      inboundChannel: 'OTHER',
      requestNumber: `HMR_DIFFERENT_${suffix()}`,
      title: 'Lighting ballast hum',
      idempotencyKey,
      idempotencyFingerprint: fingerprint,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.requestNumber, reqNum);

    const byKey = await handymanRequestRepository.findByIdempotencyKey(h.client.id, idempotencyKey);
    assert.ok(byKey);
    assert.equal(byKey.id, first.record.id);
  });

  it('enforces database check constraints and uniqueness', async (t) => {
    if (!ok(t)) return;

    const h = await createHierarchy();
    const reqNum = `HMR_${suffix()}`;

    await handymanRequestRepository.create({
      clientId: h.client.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: 'Constraint Check',
      createdByUserId: adminUserId,
      inboundChannel: 'PHONE',
      requestNumber: reqNum,
      title: 'Initial request',
    });

    // 1. Duplicate request number for same client
    await assert.rejects(
      async () => {
        await handymanRequestRepository.create({
          clientId: h.client.id,
          buildingId: h.building.id,
          spaceId: h.space.id,
          customerName: 'Duplicate Number',
          createdByUserId: adminUserId,
          inboundChannel: 'PHONE',
          requestNumber: reqNum,
          title: 'Duplicate number request',
        });
      },
      (err: any) => err.code === '23505',
    );

    // 2. Invalid operational surface
    await assert.rejects(
      async () => {
        await pool!.query(
          `INSERT INTO handyman_requests
             (id, client_id, building_id, space_id, customer_name, created_by_user_id,
              operational_surface, inbound_channel, request_number, title, priority, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            randomUUID(),
            h.client.id,
            h.building.id,
            h.space.id,
            'Name',
            adminUserId,
            'INVALID_SURFACE',
            'WHATSAPP',
            `NUM_${suffix()}`,
            'Title',
            'MEDIUM',
            'SUBMITTED',
          ],
        );
      },
      (err: any) => err.code === '23514',
    );

    // 3. Invalid inbound channel
    await assert.rejects(
      async () => {
        await pool!.query(
          `INSERT INTO handyman_requests
             (id, client_id, building_id, space_id, customer_name, created_by_user_id,
              operational_surface, inbound_channel, request_number, title, priority, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            randomUUID(),
            h.client.id,
            h.building.id,
            h.space.id,
            'Name',
            adminUserId,
            'BM_SUPER_APP',
            'TELEGRAM',
            `NUM_${suffix()}`,
            'Title',
            'MEDIUM',
            'SUBMITTED',
          ],
        );
      },
      (err: any) => err.code === '23514',
    );

    // 4. Invalid status
    await assert.rejects(
      async () => {
        await pool!.query(
          `INSERT INTO handyman_requests
             (id, client_id, building_id, space_id, customer_name, created_by_user_id,
              operational_surface, inbound_channel, request_number, title, priority, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            randomUUID(),
            h.client.id,
            h.building.id,
            h.space.id,
            'Name',
            adminUserId,
            'BM_SUPER_APP',
            'WHATSAPP',
            `NUM_${suffix()}`,
            'Title',
            'MEDIUM',
            'IN_PROGRESS', // Later lifecycle status forbidden in CR-HM-BE-01
          ],
        );
      },
      (err: any) => err.code === '23514',
    );
  });

  it('lists requests with multiple query filters and accessible buildings', async (t) => {
    if (!ok(t)) return;

    const h1 = await createHierarchy();
    const h2 = await createHierarchy({ client: h1.client });

    const req1 = (
      await handymanRequestRepository.create({
        clientId: h1.client.id,
        buildingId: h1.building.id,
        spaceId: h1.space.id,
        customerName: 'Alice Search',
        createdByUserId: adminUserId,
        inboundChannel: 'WHATSAPP',
        requestNumber: `HMR_A_${suffix()}`,
        title: 'Filter test 1',
        priority: 'LOW',
      })
    ).record;

    const req2 = (
      await handymanRequestRepository.create({
        clientId: h1.client.id,
        buildingId: h2.building.id,
        spaceId: h2.space.id,
        customerName: 'Bob Search',
        createdByUserId: adminUserId,
        inboundChannel: 'PHONE',
        requestNumber: `HMR_B_${suffix()}`,
        title: 'Filter test 2',
        priority: 'HIGH',
      })
    ).record;

    // Filter by building
    const b1List = await handymanRequestRepository.list({ buildingId: h1.building.id });
    assert.ok(b1List.some((r) => r.id === req1.id));
    assert.ok(!b1List.some((r) => r.id === req2.id));

    // Filter by inbound channel
    const whatsappList = await handymanRequestRepository.list({ inboundChannel: 'WHATSAPP' });
    assert.ok(whatsappList.some((r) => r.id === req1.id));
    assert.ok(!whatsappList.some((r) => r.id === req2.id));

    // Filter by accessible buildings
    const scopedList = await handymanRequestRepository.list({}, [h2.building.id]);
    assert.ok(!scopedList.some((r) => r.id === req1.id));
    assert.ok(scopedList.some((r) => r.id === req2.id));

    // Empty accessible buildings
    const emptyList = await handymanRequestRepository.list({}, []);
    assert.equal(emptyList.length, 0);

    // Search filter
    const searchList = await handymanRequestRepository.list({ search: 'Alice' });
    assert.ok(searchList.some((r) => r.id === req1.id));
  });

  it('updates status from SUBMITTED to CANCELLED', async (t) => {
    if (!ok(t)) return;

    const h = await createHierarchy();
    const { record } = await handymanRequestRepository.create({
      clientId: h.client.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: 'To Cancel',
      createdByUserId: adminUserId,
      inboundChannel: 'WALK_IN',
      requestNumber: `HMR_${suffix()}`,
      title: 'Request to cancel',
    });

    assert.equal(record.status, 'SUBMITTED');

    const updated = await handymanRequestRepository.updateStatus(record.id, 'CANCELLED');
    assert.ok(updated);
    assert.equal(updated.status, 'CANCELLED');
    assert.ok(updated.updatedAt.getTime() >= record.updatedAt.getTime());
  });
});
