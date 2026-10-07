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
import { handoffContextResolver } from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 PART 02 — focused tests for the trusted handoff context resolver.
 * Resolver-level only: asserts canonical resolution, concealment semantics,
 * and that resolution performs no persistence side effects.
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
    tenant_service_requests, tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies, spaces, rooms,
    areas, floors, buildings, properties, users, roles, permissions, clients
    CASCADE`);
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

async function makeCompany(clientId: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  return tenantCompanyService.createTenantCompany({
    clientId,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
    status,
  }, userId);
}

async function makePic(
  companyId: string,
  options: { status?: 'ACTIVE' | 'INACTIVE'; linkUserInBuildingId?: string } = {},
) {
  let linkedUserId: string | undefined;
  if (options.linkUserInBuildingId) {
    // tenant-pic governance requires the linked user to belong to the
    // company's client context — assign the user to the client building.
    const user = await userService.createUser({
      email: `customer-${suffix().toLowerCase()}@example.com`,
      displayName: 'Customer Person',
    });
    await buildingAssignmentService.createAssignment(user.id, {
      buildingId: options.linkUserInBuildingId,
    });
    linkedUserId = user.id;
  }
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: companyId,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    ...(linkedUserId ? { userId: linkedUserId } : {}),
    ...(options.status ? { status: options.status } : {}),
  }, userId);
  return { pic, linkedUserId: linkedUserId ?? null };
}

/** Fully-valid fixture: company + ACTIVE context + ACTIVE space relationship. */
async function trustedFixture(options: { client?: PublicClient } = {}) {
  const h = await hierarchy(options);
  const company = await makeCompany(h.client.id);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: h.building.id,
    spaceId: h.space.id,
  }, userId);
  const context = await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: h.building.id,
  }, userId);
  return { ...h, company, context };
}

async function tableCount(name: string): Promise<number> {
  assert.ok(pool);
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

describe('CR-HM-01 PART 02 — Trusted Handoff Context Resolver', () => {
  it('resolves a valid company + building to canonical context', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const resolved = await handoffContextResolver.resolveHandoffContext({
      tenantCompanyId: f.company.id,
      buildingId: f.building.id,
    });
    assert.equal(resolved.clientId, f.client.id);
    assert.equal(resolved.tenantCompanyId, f.company.id);
    assert.equal(resolved.buildingId, f.building.id);
    assert.equal(resolved.tenantBuildingContextId, f.context.id);
    assert.equal(resolved.tenantPicId, null);
    assert.equal(resolved.spaceId, null);
    assert.equal(resolved.tenantSpaceRelationshipId, null);
    assert.equal(resolved.resolvedUserId, null);
  });

  it('resolves a valid company + building + unit/space', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const resolved = await handoffContextResolver.resolveHandoffContext({
      tenantCompanyId: f.company.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
    });
    assert.equal(resolved.spaceId, f.space.id);
    assert.ok(resolved.tenantSpaceRelationshipId);
  });

  it('resolves a valid PIC relationship, including linked local user', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const { pic, linkedUserId } = await makePic(f.company.id, {
      linkUserInBuildingId: f.building.id,
    });
    const resolved = await handoffContextResolver.resolveHandoffContext({
      tenantCompanyId: f.company.id,
      buildingId: f.building.id,
      tenantPicId: pic.id,
    });
    assert.equal(resolved.tenantPicId, pic.id);
    assert.equal(resolved.resolvedUserId, linkedUserId);
    // PIC without a linked user resolves to null linkage, still valid
    const { pic: unlinked } = await makePic(f.company.id);
    const resolvedUnlinked = await handoffContextResolver.resolveHandoffContext({
      tenantCompanyId: f.company.id,
      buildingId: f.building.id,
      tenantPicId: unlinked.id,
    });
    assert.equal(resolvedUnlinked.tenantPicId, unlinked.id);
    assert.equal(resolvedUnlinked.resolvedUserId, null);
  });

  it('rejects an inactive tenant company', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const inactive = await makeCompany(f.client.id, 'INACTIVE');
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: inactive.id,
        buildingId: f.building.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_CONTEXT_INVALID',
    );
  });

  it('rejects cross-client company/building mismatch without leak', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const other = await hierarchy({
      client: await clientService.createClient({
        code: `C_${suffix()}`,
        name: 'Foreign Client',
      }),
    });
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f.company.id,
        buildingId: other.building.id,
      }),
      (error: unknown) => {
        const e = error as { code?: string; message?: string };
        return (
          e.code === 'HANDYMAN_HANDOFF_CONTEXT_INVALID' &&
          !/Foreign/.test(e.message ?? '')
        );
      },
    );
  });

  it('rejects missing or inactive tenant-building relationships', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    // missing: space relationship exists but no tenant-building context was
    // ever created for this building
    const other = await hierarchy({ client: f.client });
    await tenantSpaceService.assignSpaceToTenant({
      tenantCompanyId: f.company.id,
      buildingId: other.building.id,
      spaceId: other.space.id,
    }, userId);
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f.company.id,
        buildingId: other.building.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_CONTEXT_INVALID',
    );
    // inactive context
    const h2 = await hierarchy({ client: f.client });
    await tenantSpaceService.assignSpaceToTenant({
      tenantCompanyId: f.company.id,
      buildingId: h2.building.id,
      spaceId: h2.space.id,
    }, userId);
    await tenantBuildingContextService.createTenantBuildingContext({
      tenantCompanyId: f.company.id,
      buildingId: h2.building.id,
      status: 'INACTIVE',
    }, userId);
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f.company.id,
        buildingId: h2.building.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_CONTEXT_INVALID',
    );
  });

  it('rejects foreign or inactive PICs', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const g = await trustedFixture();
    const { pic: foreignPic } = await makePic(g.company.id);
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        tenantPicId: foreignPic.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_REQUESTER_INVALID',
    );
    const { pic: inactivePic } = await makePic(f.company.id, { status: 'INACTIVE' });
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        tenantPicId: inactivePic.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_REQUESTER_INVALID',
    );
  });

  it('rejects missing or inactive tenant-space relationships', async (t) => {
    if (!ready(t)) return;
    // missing: full context exists, relationship row removed afterwards
    const f2 = await trustedFixture();
    await pool!.query(
      `DELETE FROM tenant_space_relationships
        WHERE tenant_company_id = $1 AND space_id = $2`,
      [f2.company.id, f2.space.id],
    );
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f2.company.id,
        buildingId: f2.building.id,
        spaceId: f2.space.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_SPACE_MISMATCH',
    );
    // inactive relationship
    const f3 = await trustedFixture();
    const relUpdate = await pool!.query(
      `UPDATE tenant_space_relationships SET status = 'INACTIVE'
        WHERE tenant_company_id = $1 AND space_id = $2 RETURNING id`,
      [f3.company.id, f3.space.id],
    );
    assert.ok(relUpdate.rows[0]?.id);
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f3.company.id,
        buildingId: f3.building.id,
        spaceId: f3.space.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_SPACE_MISMATCH',
    );
  });

  it('rejects a space that physically belongs to another building', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    // second same-client building with FULL valid context + relationship of
    // its own, then claim it while supplying the space from f.building.
    const h2 = await hierarchy({ client: f.client });
    await tenantSpaceService.assignSpaceToTenant({
      tenantCompanyId: f.company.id,
      buildingId: h2.building.id,
      spaceId: h2.space.id,
    }, userId);
    await tenantBuildingContextService.createTenantBuildingContext({
      tenantCompanyId: f.company.id,
      buildingId: h2.building.id,
    }, userId);
    await assert.rejects(
      handoffContextResolver.resolveHandoffContext({
        tenantCompanyId: f.company.id,
        buildingId: h2.building.id,
        spaceId: f.space.id,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_SPACE_MISMATCH',
    );
  });

  it('performs no persistence side effects (no attribution/session/request)', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const { pic, linkedUserId } = await makePic(f.company.id, {
      linkUserInBuildingId: f.building.id,
    });
    assert.ok(linkedUserId);
    const before = {
      attributions: await tableCount('handyman_channel_attributions'),
      sessions: await tableCount('user_sessions'),
      requests: await tableCount('tenant_service_requests'),
      contexts: await tableCount('tenant_building_contexts'),
    };
    await handoffContextResolver.resolveHandoffContext({
      tenantCompanyId: f.company.id,
      tenantPicId: pic.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
    });
    const afterSnapshot = {
      attributions: await tableCount('handyman_channel_attributions'),
      sessions: await tableCount('user_sessions'),
      requests: await tableCount('tenant_service_requests'),
      contexts: await tableCount('tenant_building_contexts'),
    };
    assert.deepEqual(afterSnapshot, before);
  });
});
