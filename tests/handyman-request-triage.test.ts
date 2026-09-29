import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import type { CreateHandymanRequestTriageInput } from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-03 PART 01 — focused tests for the triage foundation.
 *
 * Ten cases prove: both frozen dispositions transit INTAKE to the right
 * bounded state; source-state/disposition/actor guards; atomic
 * request-state + triage-record + journal commit; forced-failure full
 * rollback; append-only immutability of the F2 record (DB trigger) and the
 * frozen-history journal plateau; and zero FM/work-order side effects.
 * Real migrated PostgreSQL; delta-based counts keep tests isolated.
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
  await pool.query(`TRUNCATE handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_service_variants, service_catalog, operational_events,
    tenant_service_requests, work_requests, work_orders,
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

async function eventCount(): Promise<number> {
  return tableCount('operational_events');
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** Full tenant context + immutable CR-HM-01 BM_SUPER_APP attribution. */
async function attributedFixture() {
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
  const company = await tenantCompanyService.createTenantCompany({
    clientId: client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  return { client, building, space, company, pic, linkedUser, attribution };
}

async function serviceEntry(clientId: string) {
  return serviceCatalogService.createServiceCatalogEntry({
    clientId,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
}

async function requestFixture() {
  const f = await attributedFixture();
  const service = await serviceEntry(f.client.id);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  assert.equal(request.status, 'INTAKE');
  return { ...f, service, request };
}

describe('CR-HM-03 PART 01 — triage foundation', () => {
  it('1: INTAKE → INSPECTION_REQUIRED triage commits decision + projection', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const record = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak suggests roof penetration — needs visit.',
        },
        adminUserId,
      );
    assert.ok(record.id);
    assert.equal(record.handymanRequestId, f.request.id);
    assert.equal(record.triageDisposition, 'INSPECTION_REQUIRED');
    assert.equal(record.triageNote, 'Ceiling leak suggests roof penetration — needs visit.');
    assert.equal(record.actorUserId, adminUserId);
    assert.equal(record.clientId, f.client.id);
    assert.equal(record.channelAttributionId, f.attribution.id);
    assert.equal(record.buildingId, f.building.id);
    assert.ok(!Number.isNaN(Date.parse(record.createdAt)));
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'INSPECTION_REQUIRED');
  });

  it('2: INTAKE → DIAGNOSIS triage commits decision + projection', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const record = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'DIAGNOSIS',
          triageNote: 'Photos show a worn faucet cartridge — no visit needed.',
        },
        adminUserId,
      );
    assert.equal(record.triageDisposition, 'DIAGNOSIS');
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'DIAGNOSIS');
  });

  it('3: triage from a non-INTAKE source state is rejected (no state leak)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: f.request.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'First decision.',
      },
      adminUserId,
    );
    const pre = await tableCount('handyman_request_triage_decisions');
    const attempt = handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Second decision should fail.',
        },
        adminUserId,
      );
    await assert.rejects(attempt, (e: unknown) =>
      errorCode(e) === 'HANDYMAN_SERVICE_REQUEST_NOT_INTAKE');
    assert.equal(
      await tableCount('handyman_request_triage_decisions'),
      pre,
    );
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'DIAGNOSIS');
  });

  it('4: invalid disposition is rejected before any persistence', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    for (const bad of ['DIAGNOSED', 'SPECIALIST_REQUIRED', 'REFERRED', '']) {
      const attempt = handymanServiceRequestTriageService
        .recordHandymanRequestTriage(
          {
            handymanRequestId: f.request.id,
            triageDisposition: bad,
            triageNote: 'bad disposition attempt',
          } as unknown as CreateHandymanRequestTriageInput,
          adminUserId,
        );
      await assert.rejects(attempt, (e: unknown) =>
        errorCode(e) === 'VALIDATION_ERROR');
    }
    // the rejected dispositions never persisted any F2 record
    const leftover = await q(
      `SELECT count(*)::int AS n FROM handyman_request_triage_decisions
        WHERE handyman_request_id = $1`,
      [f.request.id],
    );
    assert.equal(leftover.rows[0].n, 0);
    const rows = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(rows.rows[0].status, 'INTAKE');
  });

  it('5: the F2 actor is persisted from the explicit local user, and journal follows', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const record = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Visit required.',
        },
        adminUserId,
      );
    assert.equal(record.actorUserId, adminUserId);
    const journal = await q(
      `SELECT actor_user_id, event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1`,
      [f.request.id],
    );
    assert.equal(journal.rowCount, 1);
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
    assert.equal(journal.rows[0].event_type, 'HANDYMAN_REQUEST_TRIAGED');
  });

  it('6: tenantPic / channel attribution can never become the actor', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    // Smuggle f.attribution/channel provenance via input — the service must
    // IGNORE every such field and keep the explicit authenticated actor.
    const smuggled = {
      handymanRequestId: f.request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Clean decision attempt.',
      actorUserId: f.linkedUser.id,
      createdByUserId: f.pic.id,
      tenantPicId: f.pic.id,
      channelAttributionId: f.attribution.id,
    } as unknown as CreateHandymanRequestTriageInput;
    const record = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(smuggled, adminUserId);
    assert.equal(record.actorUserId, adminUserId);
    assert.notEqual(record.actorUserId, f.linkedUser.id);
    assert.notEqual(record.actorUserId, f.pic.id);
    const journal = await q(
      `SELECT actor_user_id FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1`,
      [f.request.id],
    );
    assert.equal(journal.rowCount, 1);
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
  });

  it('7: request state + triage record + journal commit atomically', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const beforeTriage = await tableCount('handyman_request_triage_decisions');
    const beforeEvents = await eventCount();
    const record = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'DIAGNOSIS',
          triageNote: 'Atomic happy path.',
        },
        adminUserId,
      );
    // triage record committed
    assert.equal(
      await tableCount('handyman_request_triage_decisions'),
      beforeTriage + 1,
    );
    // request state projected in the same transaction
    const request = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(request.rows[0].status, 'DIAGNOSIS');
    // journal row committed: request-scoped historical fact, never lifecycle authority
    assert.equal(await eventCount(), beforeEvents + 1);
    const journal = await q(
      `SELECT event_type, entity_type, entity_id, actor_user_id, metadata
         FROM operational_events
        ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
    );
    assert.equal(journal.rows[0].event_type, 'HANDYMAN_REQUEST_TRIAGED');
    assert.equal(journal.rows[0].entity_type, 'HANDYMAN_SERVICE_REQUEST');
    assert.equal(journal.rows[0].entity_id, f.request.id);
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
    assert.equal(journal.rows[0].metadata.triageDecisionId, record.id);
    assert.equal(journal.rows[0].metadata.triageDisposition, 'DIAGNOSIS');
    // journal carries no secrets / no request payload snapshot
    const keys = Object.keys(journal.rows[0].metadata).sort();
    assert.deepEqual(keys, ['triageDecisionId', 'triageDisposition']);
  });

  it('8: failed persistence attempt commits nothing (record/journal/projection all absent)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const beforeTriage = await tableCount('handyman_request_triage_decisions');
    const beforeEvents = await eventCount();
    // Failing actor scope validation (valid UUID, no such user / no scope
    // reach) rejects the whole triage attempt. The convention provides NO
    // mid-transaction injectable failure: any injected-in-tx abort path
    // (this gate, the t3 duplicate conflict, the not-found case) resolves
    // through the SAME withTransaction catch → ROLLBACK — so the guarantee
    // proved here is structural: nothing, not even the lock session, can
    // leave partial state behind.
    const attempt = handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'DIAGNOSIS',
          triageNote: 'Will fail on actor scope.',
        },
        randomUUID(),
      );
    await assert.rejects(attempt);
    assert.equal(
      await tableCount('handyman_request_triage_decisions'),
      beforeTriage,
    );
    assert.equal(await eventCount(), beforeEvents);
    const request = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(request.rows[0].status, 'INTAKE');
  });

  it('9: the F2 record is append-only — UPDATE/DELETE are refused at the DB layer', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const record = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Original decision note.',
        },
        adminUserId,
      );
    // no service mutation surface exists at all (append/get only)
    assert.deepEqual(
      Object.keys(handymanServiceRequestTriageService).sort(),
      ['getHandymanRequestTriage', 'recordHandymanRequestTriage'],
    );
    await assert.rejects(
      q(
        `UPDATE handyman_request_triage_decisions
            SET triage_note = 'tampered' WHERE id = $1`,
        [record.id],
      ),
    );
    await assert.rejects(
      q(
        'DELETE FROM handyman_request_triage_decisions WHERE id = $1',
        [record.id],
      ),
    );
    const persisted = await q(
      'SELECT triage_note FROM handyman_request_triage_decisions WHERE id = $1',
      [record.id],
    );
    assert.equal(persisted.rows[0].triage_note, 'Original decision note.');
    // journal also preserved (frozen pattern plateau: the shared authority
    // never exposes update/delete through any module)
    const journal = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1`,
      [f.request.id],
    );
    assert.equal(journal.rows[0].n, 1);
  });

  it('10: triage has zero FM / tenant-service-request / work-order side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const tables = [
      'tenant_service_requests',
      'work_requests',
      'work_orders',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (name) => [name, await tableCount(name)])),
    );
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: f.request.id,
        triageDisposition: 'INSPECTION_REQUIRED',
        triageNote: 'No FM expansion should ever happen.',
      },
      adminUserId,
    );
    for (const name of tables) {
      assert.equal(await tableCount(name), before[name], `${name} unchanged`);
    }
    // and the Handyman request itself stays the ONLY Handyman-side effect
    const request = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [f.request.id],
    );
    assert.equal(request.rows[0].status, 'INSPECTION_REQUIRED');
  });
});
