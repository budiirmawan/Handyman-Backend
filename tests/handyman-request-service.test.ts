import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  cancelHandymanRequest,
  createHandymanRequest,
  getHandymanRequestById,
  listHandymanRequests,
  validateCreateHandymanRequestInput,
} from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextRepository } from '../src/modules/tenant-building-contexts';
import { tenantCompanyRepository } from '../src/modules/tenant-companies';
import { tenantPicRepository } from '../src/modules/tenant-pics';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55472;
const DIR = '/tmp/asentra-hm-run2-pg';
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
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

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
  await runSeeds(pool);
  await pool.query(`TRUNCATE handyman_requests, tenant_service_requests, tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies, work_orders,
    work_requests, spaces, rooms, areas, floors, buildings, properties,
    operational_events, user_building_assignments CASCADE`);
  const admin = await createAdminUser();
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

async function createHierarchy(options: { client?: PublicClient; assignUserId?: string } = {}) {
  const client =
    options.client ??
    (await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Owner Client',
    }));
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
  if (options.assignUserId) {
    await buildingAssignmentService.createAssignment(options.assignUserId, {
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

describe('CR-HM-BE-01 RUN 2: Handyman Request Service Authority & Lifecycle', () => {
  it('creates handyman request with authoritative actor, client identity, and server-generated request number', async (t) => {
    if (!ready(t)) return;

    const h = await createHierarchy({ assignUserId: adminUserId });

    const created = await createHandymanRequest(
      {
        buildingId: h.building.id,
        spaceId: h.space.id,
        customerName: 'Ahmad Resident',
        customerPhone: '+6281234567890',
        customerEmail: 'ahmad@resident.example.com',
        inboundChannel: 'WHATSAPP',
        title: 'AC Leaking Water',
        description: 'Water dripping from indoor split unit in master bedroom.',
        priority: 'HIGH',
      },
      adminUserId,
    );

    assert.ok(created.id);
    assert.equal(created.clientId, h.client.id);
    assert.equal(created.buildingId, h.building.id);
    assert.equal(created.spaceId, h.space.id);
    assert.equal(created.createdByUserId, adminUserId);
    assert.equal(created.customerName, 'Ahmad Resident');
    assert.equal(created.customerPhone, '+6281234567890');
    assert.equal(created.customerEmail, 'ahmad@resident.example.com');
    assert.equal(created.inboundChannel, 'WHATSAPP');
    assert.equal(created.operationalSurface, 'BM_SUPER_APP');
    assert.equal(created.status, 'SUBMITTED');
    assert.equal(created.priority, 'HIGH');
    assert.match(created.requestNumber, /^HMR-\d{4}-\d{6}$/);

    // Audit verification: verify HANDYMAN_REQUEST_CREATED event recorded in operational_events
    const events = await pool!.query<{
      event_type: string;
      actor_user_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_user_id, metadata
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_REQUEST' AND entity_id = $1`,
      [created.id],
    );

    assert.equal(events.rows.length, 1);
    const event = events.rows[0];
    assert.equal(event.event_type, 'HANDYMAN_REQUEST_CREATED');
    assert.equal(event.actor_user_id, adminUserId);
    assert.equal(event.metadata.requestNumber, created.requestNumber);
    assert.equal(event.metadata.inboundChannel, 'WHATSAPP');
    assert.equal(event.metadata.priority, 'HIGH');

    // Customer PII MUST NOT be present in audit metadata
    assert.equal(event.metadata.customerName, undefined);
    assert.equal(event.metadata.customerPhone, undefined);
    assert.equal(event.metadata.customerEmail, undefined);
  });

  it('rejects creation if actor does not have building access', async (t) => {
    if (!ready(t)) return;

    // Hierarchy with no assignment to outsider
    const h = await createHierarchy();
    const outsider = await createAdminUser();

    await assert.rejects(
      async () => {
        await createHandymanRequest(
          {
            buildingId: h.building.id,
            spaceId: h.space.id,
            customerName: 'Budi Test',
            inboundChannel: 'PHONE',
            title: 'Light bulb broken',
          },
          outsider.userId,
        );
      },
      (err: any) => {
        assert.equal(err.code, 'BUILDING_ACCESS_DENIED');
        return true;
      },
    );
  });

  it('rejects client-provided requestNumber in validation', async (t) => {
    if (!ready(t)) return;

    const h = await createHierarchy({ assignUserId: adminUserId });

    assert.throws(
      () => {
        validateCreateHandymanRequestInput({
          buildingId: h.building.id,
          spaceId: h.space.id,
          customerName: 'Test Resident',
          inboundChannel: 'WALK_IN',
          title: 'Fix Door Hinge',
          requestNumber: 'HMR-CUSTOM-999',
        });
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        const requestNumberError = err.details?.find(
          (d: any) => d.field === 'requestNumber',
        );
        assert.ok(requestNumberError);
        return true;
      },
    );
  });

  it('enforces Space -> Building integrity and rejects cross-building space', async (t) => {
    if (!ready(t)) return;

    const h1 = await createHierarchy({ assignUserId: adminUserId });
    const h2 = await createHierarchy({ assignUserId: adminUserId });

    // Attempt to create request in building 1 with space from building 2
    await assert.rejects(
      async () => {
        await createHandymanRequest(
          {
            buildingId: h1.building.id,
            spaceId: h2.space.id, // cross-building space!
            customerName: 'Cross Space User',
            inboundChannel: 'PHONE',
            title: 'Water pipe leaking',
          },
          adminUserId,
        );
      },
      (err: any) => {
        assert.equal(err.code, 'HANDYMAN_REQUEST_SPACE_MISMATCH');
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it('validates optional tenant company and PIC relationships when provided', async (t) => {
    if (!ready(t)) return;

    const h1 = await createHierarchy({ assignUserId: adminUserId });
    const h2 = await createHierarchy({ assignUserId: adminUserId });

    // Create a tenant company in client 1
    const company1 = await tenantCompanyRepository.create({
      clientId: h1.client.id,
      tenantCode: `TC_${suffix()}`,
      tenantName: 'PT Tenant Satu',
    });

    // Create an active tenant building context for building 1
    await tenantBuildingContextRepository.create({
      tenantCompanyId: company1.id,
      buildingId: h1.building.id,
      status: 'ACTIVE',
      effectiveFrom: null,
      effectiveUntil: null,
    });

    // Create PIC for company 1
    const pic1 = await tenantPicRepository.create({
      tenantCompanyId: company1.id,
      userId: null,
      picName: 'PIC Satu',
      email: 'pic1@tenant.example.com',
      phone: '+628111111111',
      roleTitle: 'Manager',
      isPrimary: true,
      status: 'ACTIVE',
    });

    // 1. Valid company + valid PIC associated with building: succeeds
    const validRequest = await createHandymanRequest(
      {
        buildingId: h1.building.id,
        spaceId: h1.space.id,
        tenantCompanyId: company1.id,
        tenantPicId: pic1.id,
        customerName: 'Ahmad Employee',
        inboundChannel: 'WHATSAPP',
        title: 'Office desk electrical outlet spark',
      },
      adminUserId,
    );
    assert.equal(validRequest.tenantCompanyId, company1.id);
    assert.equal(validRequest.tenantPicId, pic1.id);

    // 2. Tenant company not associated with building 2: rejects
    await assert.rejects(
      async () => {
        await createHandymanRequest(
          {
            buildingId: h2.building.id,
            spaceId: h2.space.id,
            tenantCompanyId: company1.id, // company1 has no context in building 2
            customerName: 'Test User',
            inboundChannel: 'WHATSAPP',
            title: 'AC maintenance',
          },
          adminUserId,
        );
      },
      (err: any) => {
        assert.equal(err.code, 'HANDYMAN_REQUEST_TENANT_COMPANY_MISMATCH');
        return true;
      },
    );

    // 3. PIC provided without tenant company: rejects
    await assert.rejects(
      async () => {
        await createHandymanRequest(
          {
            buildingId: h1.building.id,
            spaceId: h1.space.id,
            tenantPicId: pic1.id, // no tenantCompanyId!
            customerName: 'Test User',
            inboundChannel: 'WHATSAPP',
            title: 'AC maintenance',
          },
          adminUserId,
        );
      },
      (err: any) => {
        assert.equal(err.code, 'HANDYMAN_REQUEST_TENANT_PIC_MISMATCH');
        return true;
      },
    );

    // 4. PIC belonging to another company: rejects
    const company2 = await tenantCompanyRepository.create({
      clientId: h1.client.id,
      tenantCode: `TC_${suffix()}`,
      tenantName: 'PT Tenant Dua',
    });
    await tenantBuildingContextRepository.create({
      tenantCompanyId: company2.id,
      buildingId: h1.building.id,
      status: 'ACTIVE',
      effectiveFrom: null,
      effectiveUntil: null,
    });

    await assert.rejects(
      async () => {
        await createHandymanRequest(
          {
            buildingId: h1.building.id,
            spaceId: h1.space.id,
            tenantCompanyId: company2.id,
            tenantPicId: pic1.id, // pic1 belongs to company1, not company2!
            customerName: 'Test User',
            inboundChannel: 'WHATSAPP',
            title: 'AC maintenance',
          },
          adminUserId,
        );
      },
      (err: any) => {
        assert.equal(err.code, 'HANDYMAN_REQUEST_TENANT_PIC_MISMATCH');
        return true;
      },
    );
  });

  it('allocates concurrency-safe, sequential request numbers within client', async (t) => {
    if (!ready(t)) return;

    const h = await createHierarchy({ assignUserId: adminUserId });

    // Submit 5 concurrent requests
    const promises = Array.from({ length: 5 }, (_, i) =>
      createHandymanRequest(
        {
          buildingId: h.building.id,
          spaceId: h.space.id,
          customerName: `Customer Concurrent ${i}`,
          inboundChannel: 'PHONE',
          title: `Concurrent task ${i}`,
        },
        adminUserId,
      ),
    );

    const results = await Promise.all(promises);
    const requestNumbers = results.map((r) => r.requestNumber);

    // Assert all 5 request numbers are unique
    const uniqueNumbers = new Set(requestNumbers);
    assert.equal(uniqueNumbers.size, 5);

    // Assert numbers are sequentially formatted
    const year = new Date().getUTCFullYear();
    for (const num of requestNumbers) {
      assert.match(num, new RegExp(`^HMR-${year}-\\d{6}$`));
    }
  });

  it('idempotency replay returns existing record without duplicate row or audit event', async (t) => {
    if (!ready(t)) return;

    const h = await createHierarchy({ assignUserId: adminUserId });
    const idempotencyKey = `hmr-idem-${randomUUID()}`;

    const payload = {
      buildingId: h.building.id,
      spaceId: h.space.id,
      customerName: 'Idempotency Tester',
      customerPhone: '+6281987654321',
      inboundChannel: 'WHATSAPP' as const,
      title: 'Water filter replacement',
      description: 'Replace standard cartridge in kitchen.',
      priority: 'MEDIUM' as const,
      idempotencyKey,
    };

    // First call: creates record
    const first = await createHandymanRequest(payload, adminUserId);
    assert.ok(first.id);

    // Second call: safe replay
    const second = await createHandymanRequest(payload, adminUserId);
    assert.equal(second.id, first.id);
    assert.equal(second.requestNumber, first.requestNumber);

    // Verify exactly one row in DB for this idempotency key
    const dbRows = await pool!.query(
      `SELECT count(*)::int AS count FROM handyman_requests WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.equal(dbRows.rows[0].count, 1);

    // Verify exactly one audit event created
    const eventRows = await pool!.query(
      `SELECT count(*)::int AS count FROM operational_events WHERE entity_id = $1`,
      [first.id],
    );
    assert.equal(eventRows.rows[0].count, 1);
  });

  it('idempotency conflict throws 409 when payload differs for the same idempotency key', async (t) => {
    if (!ready(t)) return;

    const h = await createHierarchy({ assignUserId: adminUserId });
    const idempotencyKey = `hmr-conflict-${randomUUID()}`;

    // First call
    await createHandymanRequest(
      {
        buildingId: h.building.id,
        spaceId: h.space.id,
        customerName: 'User Conflict',
        inboundChannel: 'WHATSAPP',
        title: 'Original Title',
        idempotencyKey,
      },
      adminUserId,
    );

    // Second call with DIFFERENT title
    await assert.rejects(
      async () => {
        await createHandymanRequest(
          {
            buildingId: h.building.id,
            spaceId: h.space.id,
            customerName: 'User Conflict',
            inboundChannel: 'WHATSAPP',
            title: 'Modified Different Title', // modified payload!
            idempotencyKey,
          },
          adminUserId,
        );
      },
      (err: any) => {
        assert.equal(err.code, 'HANDYMAN_REQUEST_IDEMPOTENCY_CONFLICT');
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it('enforces building access scoping on get and list operations', async (t) => {
    if (!ready(t)) return;

    const h1 = await createHierarchy({ assignUserId: adminUserId });
    const h2 = await createHierarchy(); // adminUserId is NOT assigned to h2.building

    const outsider = await createAdminUser(); // outsider has no building assignments yet
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: h2.building.id,
    });

    const req1 = await createHandymanRequest(
      {
        buildingId: h1.building.id,
        spaceId: h1.space.id,
        customerName: 'Resident Building 1',
        inboundChannel: 'PHONE',
        title: 'B1 Job',
      },
      adminUserId,
    );

    // Admin can get req1
    const retrieved = await getHandymanRequestById(req1.id, adminUserId);
    assert.equal(retrieved.id, req1.id);

    // Outsider (assigned only to B2) cannot get req1 (in B1)
    await assert.rejects(
      async () => {
        await getHandymanRequestById(req1.id, outsider.userId);
      },
      (err: any) => {
        assert.equal(err.code, 'BUILDING_ACCESS_DENIED');
        return true;
      },
    );

    // Non-existent ID throws HANDYMAN_REQUEST_NOT_FOUND
    await assert.rejects(
      async () => {
        await getHandymanRequestById(randomUUID(), adminUserId);
      },
      (err: any) => {
        assert.equal(err.code, 'HANDYMAN_REQUEST_NOT_FOUND');
        assert.equal(err.statusCode, 404);
        return true;
      },
    );

    // List for adminUserId sees req1
    const adminList = await listHandymanRequests({}, adminUserId);
    assert.ok(adminList.some((r) => r.id === req1.id));

    // List for outsider sees 0 items (since req1 is in B1)
    const outsiderList = await listHandymanRequests({}, outsider.userId);
    assert.ok(!outsiderList.some((r) => r.id === req1.id));

    // Explicit filter for building that caller has no access to throws BUILDING_ACCESS_DENIED
    await assert.rejects(
      async () => {
        await listHandymanRequests({ buildingId: h1.building.id }, outsider.userId);
      },
      (err: any) => {
        assert.equal(err.code, 'BUILDING_ACCESS_DENIED');
        return true;
      },
    );
  });

  it('cancellation lifecycle: transitions SUBMITTED to CANCELLED and records audit event', async (t) => {
    if (!ready(t)) return;

    const h = await createHierarchy({ assignUserId: adminUserId });

    const created = await createHandymanRequest(
      {
        buildingId: h.building.id,
        spaceId: h.space.id,
        customerName: 'Cancel Test Resident',
        inboundChannel: 'WALK_IN',
        title: 'Fix Balcony Railing',
      },
      adminUserId,
    );

    assert.equal(created.status, 'SUBMITTED');

    // Cancel request
    const cancelled = await cancelHandymanRequest(created.id, adminUserId);
    assert.equal(cancelled.id, created.id);
    assert.equal(cancelled.status, 'CANCELLED');

    // Audit verification: HANDYMAN_REQUEST_CANCELLED recorded
    const cancelEvents = await pool!.query<{
      event_type: string;
      actor_user_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_user_id, metadata
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_CANCELLED'`,
      [created.id],
    );

    assert.equal(cancelEvents.rows.length, 1);
    assert.equal(cancelEvents.rows[0].metadata.previousStatus, 'SUBMITTED');
    assert.equal(cancelEvents.rows[0].metadata.newStatus, 'CANCELLED');

    // Trying to cancel again throws HANDYMAN_REQUEST_ALREADY_CANCELLED (409)
    await assert.rejects(
      async () => {
        await cancelHandymanRequest(created.id, adminUserId);
      },
      (err: any) => {
        assert.equal(err.code, 'HANDYMAN_REQUEST_ALREADY_CANCELLED');
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // Total cancel events remains 1
    const finalEvents = await pool!.query(
      `SELECT count(*)::int AS count
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_CANCELLED'`,
      [created.id],
    );
    assert.equal(finalEvents.rows[0].count, 1);
  });

  it('concurrent cancellation commands produce exactly one transition and one audit event', async (t) => {
    if (!ready(t)) return;

    const h = await createHierarchy({ assignUserId: adminUserId });

    const created = await createHandymanRequest(
      {
        buildingId: h.building.id,
        spaceId: h.space.id,
        customerName: 'Concurrent Cancel Resident',
        inboundChannel: 'PHONE',
        title: 'Race two concurrent cancels',
      },
      adminUserId,
    );

    // Two cancellation commands racing on the same SUBMITTED request.
    const outcomes = await Promise.allSettled([
      cancelHandymanRequest(created.id, adminUserId),
      cancelHandymanRequest(created.id, adminUserId),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one command must win');
    assert.equal(rejected.length, 1, 'exactly one command must lose');

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string }>)
      .value;
    assert.equal(winner.status, 'CANCELLED');

    const loserError = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string;
      statusCode?: number;
    };
    assert.equal(loserError.code, 'HANDYMAN_REQUEST_ALREADY_CANCELLED');
    assert.equal(loserError.statusCode, 409);

    // Only the command that actually performed SUBMITTED -> CANCELLED may
    // emit the HANDYMAN_REQUEST_CANCELLED audit event.
    const events = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_CANCELLED'`,
      [created.id],
    );
    assert.equal(events.rows[0].count, 1);

    // A later sequential command is still a governed 409 with no new event.
    await assert.rejects(
      async () => cancelHandymanRequest(created.id, adminUserId),
      (err: { code?: string; statusCode?: number }) =>
        err.code === 'HANDYMAN_REQUEST_ALREADY_CANCELLED' &&
        err.statusCode === 409,
    );
    const finalEvents = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_REQUEST' AND entity_id = $1 AND event_type = 'HANDYMAN_REQUEST_CANCELLED'`,
      [created.id],
    );
    assert.equal(finalEvents.rows[0].count, 1);
  });
});
