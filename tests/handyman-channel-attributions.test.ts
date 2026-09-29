import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  handymanChannelAttributionService,
} from '../src/modules/handyman-channel-attributions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 PART 01 — focused tests for the immutable Handyman Channel
 * Attribution domain/persistence foundation. Domain/service level only;
 * no HTTP surface exists in this PART.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_channel_attributions,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  userId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
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

async function hierarchy(options: { client?: PublicClient } = {}) {
  const client = options.client ?? await clientService.createClient({
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
  await buildingAssignmentService.createAssignment(userId, {
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
  return { client, property, building, room, space };
}

async function trustedFixture(options: { client?: PublicClient } = {}) {
  const h = await hierarchy(options);
  const company = await tenantCompanyService.createTenantCompany({
    clientId: h.client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, userId);
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
  }, userId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: h.building.id,
    spaceId: h.space.id,
  }, userId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: h.building.id,
  }, userId);
  return { ...h, company, pic };
}

function fullInput(f: Awaited<ReturnType<typeof trustedFixture>>) {
  return {
    tenantCompanyId: f.company.id,
    tenantPicId: f.pic.id,
    buildingId: f.building.id,
    spaceId: f.space.id,
    originChannel: 'BM_SUPER_APP' as const,
    originReference: `BMREF-${suffix()}`,
    createdByUserId: userId,
  };
}

describe('CR-HM-01 PART 01 — Channel Attribution foundation', () => {
  it('creates attribution from trusted server-side context (full)', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const created = await handymanChannelAttributionService
      .createChannelAttribution(fullInput(f));
    assert.ok(created.id);
    // tenant-isolation root is DERIVED from the company, never from input
    assert.equal(created.clientId, f.client.id);
    assert.equal(created.tenantCompanyId, f.company.id);
    assert.equal(created.tenantPicId, f.pic.id);
    assert.equal(created.buildingId, f.building.id);
    assert.equal(created.spaceId, f.space.id);
    assert.equal(created.originChannel, 'BM_SUPER_APP');
    assert.ok(created.originReference?.startsWith('BMREF-'));
    assert.equal(created.createdByUserId, userId);
    assert.ok(created.createdAt);
    // append-only shape: no updatedAt lifecycle field ever exists
    assert.equal('updatedAt' in created, false);
    const fetched = await handymanChannelAttributionService
      .getChannelAttribution(created.id);
    assert.equal(fetched.id, created.id);
  });

  it('creates attribution with minimal context (pic/space/reference optional)', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const created = await handymanChannelAttributionService
      .createChannelAttribution({
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        originChannel: 'BM_SUPER_APP',
      });
    assert.equal(created.tenantPicId, null);
    assert.equal(created.spaceId, null);
    assert.equal(created.originReference, null);
    assert.equal(created.createdByUserId, null);
  });

  it('rejects an unrecognized origin channel', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        originChannel: 'WHATSAPP' as never,
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  });

  it('rejects a blank origin reference', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        originReference: '   ',
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  });

  it('enforces tenant isolation: building from another client is rejected', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const other = await hierarchy({
      client: await clientService.createClient({
        code: `C_${suffix()}`,
        name: 'Other Client',
      }),
    });
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput({ ...f, building: other.building }),
        originChannel: 'BM_SUPER_APP',
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_CONTEXT_INVALID',
    );
  });

  it('rejects an inactive tenant company', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const inactiveCompany = await tenantCompanyService.createTenantCompany({
      clientId: f.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Inactive Tenant',
      status: 'INACTIVE',
    }, userId);
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        tenantCompanyId: inactiveCompany.id,
        tenantPicId: undefined,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_CONTEXT_INVALID',
    );
  });

  it('rejects a missing active tenant building context', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const other = await hierarchy({ client: f.client });
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        buildingId: other.building.id,
        tenantPicId: undefined,
        spaceId: undefined,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_CONTEXT_INVALID',
    );
  });

  it('rejects a PIC that does not belong to the tenant company', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const g = await trustedFixture();
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        tenantPicId: g.pic.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_REQUESTER_INVALID',
    );
  });

  it('rejects an inactive PIC', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const inactivePic = await tenantPicService.createTenantPic({
      tenantCompanyId: f.company.id,
      picName: 'Inactive PIC',
      status: 'INACTIVE',
    }, userId);
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        tenantPicId: inactivePic.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_REQUESTER_INVALID',
    );
  });

  it('rejects a space without an active tenant-space relationship', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const unrelated = await hierarchy({ client: f.client });
    // Reuse the company context on f.building but point to a space that has
    // no tenant relationship in that building.
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        spaceId: unrelated.space.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_SPACE_MISMATCH',
    );
  });

  it('rejects an unknown createdByUserId', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(f),
        createdByUserId: randomUUID(),
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  });

  it('prevents duplicate/conflicting binding of one origin reference', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const reference = `BMREF-${suffix()}`;
    await handymanChannelAttributionService.createChannelAttribution({
      ...fullInput(f),
      originReference: reference,
    });
    // even pointing the same external reference at another trusted context
    // must conflict: one origin reference binds at most one attribution
    const g = await trustedFixture();
    await assert.rejects(
      handymanChannelAttributionService.createChannelAttribution({
        ...fullInput(g),
        originReference: reference,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_CONFLICT',
    );
  });

  it('enforces append-only immutability at the storage layer', async (t) => {
    if (!ready(t) || !pool) return;
    const f = await trustedFixture();
    const created = await handymanChannelAttributionService
      .createChannelAttribution(fullInput(f));
    await assert.rejects(
      pool.query(
        `UPDATE handyman_channel_attributions
           SET origin_reference = 'MUTATED' WHERE id = $1`,
        [created.id],
      ),
      (error: unknown) => {
        const candidate = error as { code?: string; message?: string };
        return (
          candidate.code === '23514' &&
          (candidate.message ?? '').includes('append-only')
        );
      },
    );
    await assert.rejects(
      pool.query(
        `DELETE FROM handyman_channel_attributions WHERE id = $1`,
        [created.id],
      ),
      (error: unknown) =>
        (error as { code?: string }).code === '23514',
    );
    const afterRows = await pool.query(
      `SELECT origin_reference FROM handyman_channel_attributions
         WHERE id = $1`,
      [created.id],
    );
    assert.equal(afterRows.rowCount, 1);
    assert.equal(afterRows.rows[0].origin_reference, created.originReference);
  });
});
