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
import {
  createChannelAttribution,
  handymanChannelAttributionRepository,
} from '../src/modules/handyman-channel-attributions';
import { handymanServiceVariantService } from '../src/modules/handyman-catalog';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import type { CreateHandymanServiceRequestInput } from '../src/modules/handyman-requests';
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
 * CR-HM-02 PART 03 — focused tests for attribution-bound Handyman request
 * intake (sibling Handyman-owned entity per frozen D3). Domain/service
 * level only; no HTTP in this PART. Each case builds its own attribution
 * fixture (the real CR-HM-01 attribution authority) so tests stay isolated.
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
  await pool.query(`TRUNCATE handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    service_catalog, operational_events, tenant_service_requests,
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
    t.skip('local PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

async function tableCount(name: string): Promise<number> {
  assert.ok(pool);
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
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

describe('CR-HM-02 PART 03 — attribution-bound handyman request intake', () => {
  it('1: valid attribution → Handyman request in INTAKE state', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const variant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service.id, code: 'STD-FIX', name: 'Standard Fix',
      }, adminUserId);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
        serviceVariantId: variant.id,
        description: 'Leaking kitchen pipe needs repair.',
      }, adminUserId);
    assert.ok(request.id);
    assert.equal(request.status, 'INTAKE');
    assert.equal(request.channelAttributionId, f.attribution.id);
    assert.equal(request.serviceCatalogId, service.id);
    assert.equal(request.serviceVariantId, variant.id);
    assert.equal(request.description, 'Leaking kitchen pipe needs repair.');
    assert.equal(request.originChannel, 'BM_SUPER_APP');
    assert.equal(request.originReference, f.attribution.originReference);
    assert.equal(request.createdByUserId, f.linkedUser.id);
    assert.ok(!Number.isNaN(Date.parse(request.createdAt)));
    // one request per immutable attribution, ever
    await assert.rejects(
      handymanServiceRequestService.createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_SERVICE_REQUEST_ALREADY_EXISTS',
    );
  });

  it('2: request context exactly matches the attribution snapshot', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
        description: 'Context snapshot check',
      }, adminUserId);
    assert.equal(request.clientId, f.attribution.clientId);
    assert.equal(request.tenantCompanyId, f.attribution.tenantCompanyId);
    assert.equal(request.tenantPicId, f.attribution.tenantPicId);
    assert.equal(request.buildingId, f.attribution.buildingId);
    assert.equal(request.spaceId, f.attribution.spaceId);
    assert.equal(request.spaceId, f.space.id); // preserved exactly
    assert.equal(request.originChannel, f.attribution.originChannel);
    assert.equal(request.originReference, f.attribution.originReference);
    assert.equal(request.createdByUserId, f.attribution.createdByUserId);
  });

  it('3: caller cannot override authoritative context fields', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const other = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    // deliberate smuggling attempt: conflicting context keys in input
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
        tenantCompanyId: other.company.id,
        buildingId: other.building.id,
        spaceId: null,
        originChannel: 'PORTAL',
        clientId: other.client.id,
      } as unknown as CreateHandymanServiceRequestInput, adminUserId);
    assert.equal(request.tenantCompanyId, f.company.id);
    assert.equal(request.buildingId, f.building.id);
    assert.equal(request.spaceId, f.space.id);
    assert.equal(request.clientId, f.client.id);
    assert.equal(request.originChannel, 'BM_SUPER_APP');
  });

  it('4: cross-client service is rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const other = await attributedFixture();
    const foreignService = await serviceEntry(other.client.id);
    await assert.rejects(
      handymanServiceRequestService.createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: foreignService.id,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_SERVICE_REQUEST_SCOPE_MISMATCH',
    );
  });

  it('5: a variant from another service is rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const serviceA = await serviceEntry(f.client.id);
    const serviceB = await serviceEntry(f.client.id);
    const variantOfB = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: serviceB.id, code: 'B-ONLY', name: 'B only',
      }, adminUserId);
    await assert.rejects(
      handymanServiceRequestService.createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: serviceA.id,
        serviceVariantId: variantOfB.id,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_SERVICE_REQUEST_SCOPE_MISMATCH',
    );
  });

  it('6: inactive service or variant references are rejected', async (t) => {
    if (!requireDatabase(t) || !pool) return;
    const f = await attributedFixture();
    const inactiveService = await serviceEntry(f.client.id);
    await serviceCatalogService.deactivateServiceCatalogEntry(
      inactiveService.id,
      adminUserId,
    );
    await assert.rejects(
      handymanServiceRequestService.createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: inactiveService.id,
      }, adminUserId),
      (error: unknown) => errorCode(error) === 'SERVICE_CATALOG_NOT_ACTIVE',
    );
    const service = await serviceEntry(f.client.id);
    const variant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service.id, code: 'INACT-V', name: 'Inactive v',
      }, adminUserId);
    await pool.query(
      `UPDATE handyman_service_variants
          SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`,
      [variant.id],
    );
    await assert.rejects(
      handymanServiceRequestService.createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
        serviceVariantId: variant.id,
      }, adminUserId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_SERVICE_VARIANT_NOT_ACTIVE',
    );
  });

  it('7: request creation never mutates the channel attribution', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const before1 = await handymanChannelAttributionRepository.findById(
      f.attribution.id,
    );
    const service = await serviceEntry(f.client.id);
    await handymanServiceRequestService.createHandymanServiceRequest({
      channelAttributionId: f.attribution.id,
      serviceCatalogId: service.id,
      description: 'No attribution mutation expected.',
    }, adminUserId);
    const after1 = await handymanChannelAttributionRepository.findById(
      f.attribution.id,
    );
    assert.ok(before1 && after1);
    assert.deepEqual(after1, before1);
  });

  it('8: never creates FM tenant_service_requests rows', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const before1 = await tableCount('tenant_service_requests');
    const handymanBefore = await tableCount('handyman_service_requests');
    const service = await serviceEntry(f.client.id);
    await handymanServiceRequestService.createHandymanServiceRequest({
      channelAttributionId: f.attribution.id,
      serviceCatalogId: service.id,
    }, adminUserId);
    assert.equal(await tableCount('tenant_service_requests'), before1);
    // and exactly one additional Handyman request was created
    assert.equal(
      await tableCount('handyman_service_requests'),
      handymanBefore + 1,
    );
  });
});
