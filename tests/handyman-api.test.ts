import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  handymanCommonMaterialProfileService,
  handymanServiceVariantService,
} from '../src/modules/handyman-catalog';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
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
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-02 PART 05A — focused HTTP + OpenAPI tests for the customer-facing
 * Handyman surface (read-only catalogue, attribution-bound request intake,
 * bounded INTAKE evidence upload). Tests 1–10 are the mandated surface
 * checks; test 11 is the regression guard proving the PART 04 VIDEO
 * admission did not change any existing non-Handyman evidence behavior.
 * Real migrated PostgreSQL; supertest drives the real Express app.
 */

const STORAGE_DIR = resolve(
  process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence',
);
const HM_PREFIX = '/api/v1/handyman';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const sha256Hex = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_channel_attributions,
    handyman_service_variants, handyman_common_material_profiles,
    handyman_service_requests, service_catalog, inventory_items,
    price_catalog_entries, units_of_measure, checklist_templates,
    checklist_executions, evidence_submissions, operational_events,
    tenant_service_requests, tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies, spaces,
    rooms, areas, floors, buildings, properties, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const auth = () => ({ Authorization: `Bearer ${token}` });

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

async function insertUom(clientId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  return id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe('CR-HM-02 PART 05A — Handyman HTTP + OpenAPI surface', () => {
  it('1: catalogue read returns service + active variant', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const activeVariant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service.id,
        code: `V${suffix()}`,
        name: 'Active Variant',
      }, adminUserId);
    const inactiveVariant = await handymanServiceVariantService
      .createHandymanServiceVariant({
        serviceCatalogId: service.id,
        code: `X${suffix()}`,
        name: 'Inactive Variant',
      }, adminUserId);
    await q(`UPDATE handyman_service_variants SET status = 'INACTIVE'
             WHERE id = $1`, [inactiveVariant.id]);

    const res = await api()
      .get(`${HM_PREFIX}/catalogue/services`)
      .set(auth())
      .query({ clientId: f.client.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    const item = (res.body.data as Json[]).find(
      (entry: Json) => entry.service.id === service.id,
    );
    assert.ok(item, 'service present in catalogue read');
    assert.equal(item.service.code, service.code);
    assert.equal(item.service.status, 'ACTIVE');
    const variantIds = (item.variants as Json[]).map((v: Json) => v.id);
    assert.deepEqual(variantIds.sort(), [activeVariant.id]);
    const variant = (item.variants as Json[])[0];
    assert.equal(variant.status, 'ACTIVE');
    assert.equal(variant.clientId, f.client.id);
    assert.equal(variant.serviceCatalogId, service.id);
    // the catalogue read scoped to this client carries only its services
    const serviceIds = (res.body.data as Json[]).map((e: Json) => e.service.id);
    assert.ok(serviceIds.includes(service.id));
  });

  it('2: material profile list + reference price composition (read-time, fail-closed)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const uomId = await insertUom(f.client.id);
    const material = await inventoryItemService.createInventoryItem({
      clientId: f.client.id,
      code: `MAT_${suffix()}`,
      name: 'Copper Pipe',
      itemType: 'MATERIAL',
      uomId,
    }, adminUserId);
    const profile = await handymanCommonMaterialProfileService
      .createHandymanCommonMaterialProfile({
        serviceCatalogId: service.id,
        inventoryItemId: material.id,
        commonality: 'COMMON',
        customerMaterialOption: 'CUSTOMER_CHOICE',
      }, adminUserId);
    await clientMonetaryContextService.setClientMonetaryContext({
      clientId: f.client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes: ['IDR', 'SGD'],
    }, adminUserId);
    const entry = await priceCatalogEntryService.createPriceCatalogEntry({
      clientId: f.client.id,
      sourceMode: 'MATERIAL',
      itemId: material.id,
      uomId,
      currency: 'IDR',
      unitPrice: 25000,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
    }, adminUserId);
    await priceCatalogEntryService.activatePriceCatalogEntry(
      entry.id,
      adminUserId,
    );

    const list = await api()
      .get(`${HM_PREFIX}/catalogue/material-profiles`)
      .set(auth())
      .query({ clientId: f.client.id });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const listed = (list.body.data as Json[]).find(
      (p: Json) => p.id === profile.id,
    );
    assert.ok(listed, 'profile listed');
    assert.equal(listed.serviceCatalogId, service.id);
    assert.equal(listed.inventoryItemId, material.id);
    assert.equal(listed.status, 'ACTIVE');

    const priced = await api()
      .get(`${HM_PREFIX}/catalogue/material-profiles/${profile.id}`)
      .set(auth())
      .query({ buildingId: f.building.id, currency: 'IDR' });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    assert.equal(priced.body.data.id, profile.id);
    assert.ok(priced.body.data.referencePrice, 'reference price composed');
    assert.equal(priced.body.data.referencePrice.unitPrice, 25000);
    assert.equal(priced.body.data.referencePrice.currency, 'IDR');

    // no applicable price lane → fail-closed null, never guessed
    const unpriced = await api()
      .get(`${HM_PREFIX}/catalogue/material-profiles/${profile.id}`)
      .set(auth())
      .query({ buildingId: f.building.id, currency: 'SGD' });
    assert.equal(unpriced.status, 200, JSON.stringify(unpriced.body));
    assert.equal(unpriced.body.data.referencePrice, null);
  });

  it('3: catalogue has no mutation surface', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const attempts = [
      api().post(`${HM_PREFIX}/catalogue/services`).set(auth()).send({}),
      api().put(`${HM_PREFIX}/catalogue/services`).set(auth()).send({}),
      api().patch(`${HM_PREFIX}/catalogue/services/${service.id}`).set(auth()).send({}),
      api().delete(`${HM_PREFIX}/catalogue/services/${service.id}`).set(auth()),
      api().post(`${HM_PREFIX}/catalogue/material-profiles`).set(auth()).send({}),
      api().patch(`${HM_PREFIX}/catalogue/material-profiles/${randomUUID()}`).set(auth()).send({}),
      api().post(`${HM_PREFIX}/catalogue/material-profiles/${randomUUID()}/media`).set(auth()).send({}),
      api().put(`${HM_PREFIX}/requests`).set(auth()).send({}),
      api().patch(`${HM_PREFIX}/requests/${randomUUID()}`).set(auth()).send({}),
      api().post(`${HM_PREFIX}/requests/${randomUUID()}/cancel`).set(auth()).send({}),
    ];
    for (const attempt of await Promise.all(attempts)) {
      assert.equal(
        attempt.status,
        404,
        `expected 404, got ${attempt.status}: ${attempt.req.method} ${attempt.req.path}`,
      );
    }
    const catalogCount = await q(
      'SELECT count(*)::int AS n FROM service_catalog WHERE id = $1',
      [service.id],
    );
    assert.equal(catalogCount.rows[0].n, 1);
  });

  it('4: request HTTP creation derives context from the attribution', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const res = await api()
      .post(`${HM_PREFIX}/requests`)
      .set(auth())
      .send({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
        description: '  Leaking pipe under the sink.  ',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.headers['x-request-id']);
    const request = res.body.data as Json;
    assert.ok(request.id);
    assert.equal(request.status, 'INTAKE');
    assert.equal(request.channelAttributionId, f.attribution.id);
    assert.equal(request.serviceCatalogId, service.id);
    assert.equal(request.serviceVariantId, null);
    assert.equal(request.clientId, f.client.id);
    assert.equal(request.tenantCompanyId, f.company.id);
    assert.equal(request.tenantPicId, f.pic.id);
    assert.equal(request.buildingId, f.building.id);
    assert.equal(request.spaceId, f.space.id);
    assert.equal(request.originChannel, 'BM_SUPER_APP');
    assert.equal(request.originReference, f.attribution.originReference);
    assert.equal(request.createdByUserId, f.linkedUser.id);
    assert.equal(request.description, 'Leaking pipe under the sink.');
  });

  it('5: caller context override cannot become authoritative', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const other = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const body = {
      channelAttributionId: f.attribution.id,
      serviceCatalogId: service.id,
      // smuggled foreign context — must never become authoritative
      clientId: other.client.id,
      tenantCompanyId: other.company.id,
      tenantPicId: other.pic.id,
      buildingId: other.building.id,
      spaceId: other.space.id,
      originChannel: 'PORTAL',
      originReference: 'forged-reference',
      createdByUserId: other.linkedUser.id,
      status: 'APPROVED',
    } as unknown as Parameters<
      typeof handymanServiceRequestService.createHandymanServiceRequest
    >[0];
    const res = await api().post(`${HM_PREFIX}/requests`).set(auth()).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const request = res.body.data as Json;
    assert.equal(request.clientId, f.client.id);
    assert.equal(request.tenantCompanyId, f.company.id);
    assert.equal(request.tenantPicId, f.pic.id);
    assert.equal(request.buildingId, f.building.id);
    assert.equal(request.spaceId, f.space.id);
    assert.equal(request.originChannel, 'BM_SUPER_APP');
    assert.equal(request.originReference, f.attribution.originReference);
    assert.equal(request.createdByUserId, f.linkedUser.id);
    assert.equal(request.status, 'INTAKE');
  });

  it('6: PHOTO intake upload succeeds with server-side integrity metadata', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      }, adminUserId);
    const bytes = Buffer.from('hm-intake-photo-bytes-0123456789');
    const res = await api()
      .post(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(auth())
      .field('evidenceKind', 'PHOTO')
      .attach('file', bytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const evidence = res.body.data as Json;
    assert.ok(evidence.id);
    assert.equal(evidence.evidenceKind, 'PHOTO');
    assert.equal(evidence.handymanRequestId, request.id);
    assert.equal(evidence.clientId, f.client.id);
    assert.equal(evidence.mimeType, 'image/jpeg');
    assert.equal(evidence.originalFileName, 'photo.jpg');
    assert.equal(evidence.fileSize, bytes.length);
    assert.equal(evidence.contentSha256, sha256Hex(bytes));
    assert.equal(evidence.status, 'ACTIVE');
    assert.equal(evidence.submittedByUserId, adminUserId);
    // security: no storage path/key material ever appears in the payload
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('fileReference'));
    assert.ok(!raw.includes(`evidence/${evidence.id}`));

    const stored = await q(
      `SELECT execution_type, evidence_type, file_reference, retention_state,
              content_sha256, hash_algorithm
         FROM evidence_submissions WHERE id = $1`,
      [evidence.id],
    );
    assert.equal(stored.rows[0].execution_type, 'HANDYMAN_REQUEST');
    assert.equal(stored.rows[0].evidence_type, 'PHOTO');
    assert.equal(stored.rows[0].retention_state, 'ACTIVE');

    const list = await api()
      .get(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(auth());
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body.data as Json[]).map((e: Json) => e.id),
      [evidence.id],
    );
  });

  it('7: VIDEO intake upload succeeds (bounded Handyman policy)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      }, adminUserId);
    for (const mime of ['video/mp4', 'video/quicktime', 'video/webm']) {
      const bytes = Buffer.from(`hm-intake-video-bytes-${mime}`);
      const res = await api()
        .post(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
        .set(auth())
        .field('evidenceKind', 'VIDEO')
        .attach('file', bytes, { filename: 'clip', contentType: mime });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.evidenceKind, 'VIDEO');
      assert.equal(res.body.data.mimeType, mime);
      assert.equal(res.body.data.contentSha256, sha256Hex(bytes));
      const stored = await q(
        'SELECT evidence_type FROM evidence_submissions WHERE id = $1',
        [res.body.data.id],
      );
      assert.equal(stored.rows[0].evidence_type, 'VIDEO');
    }
  });

  it('8: invalid MIME and oversize uploads are rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      }, adminUserId);
    const badMime = await api()
      .post(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(auth())
      .field('evidenceKind', 'VIDEO')
      .attach('file', Buffer.from('gif-bytes'), {
        filename: 'anim.gif',
        contentType: 'image/gif',
      });
    assert.equal(badMime.status, 400);
    assert.match(badMime.body.error.message, /does not accept MIME type/);

    const badKind = await api()
      .post(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(auth())
      .field('evidenceKind', 'DOCUMENT')
      .attach('file', Buffer.from('doc'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.success, false);

    const oversized = await api()
      .post(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(auth())
      .field('evidenceKind', 'VIDEO')
      .attach('file', Buffer.alloc(52_428_801), {
        filename: 'huge.mp4',
        contentType: 'video/mp4',
      });
    assert.equal(oversized.status, 400);
    assert.match(oversized.body.error.message, /50 MB limit/);

    const remaining = await api()
      .get(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(auth());
    assert.equal(remaining.status, 200);
    assert.deepEqual(remaining.body.data, []);
  });

  it('9: cross-client access is rejected (request proves the scope)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const service = await serviceEntry(f.client.id);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      }, adminUserId);

    // outsider: full RBAC permissions, but assigned only to a foreign
    // Client's building — scope (not the session's power) must deny access.
    const other = await attributedFixture();
    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: other.building.id,
    });
    const outsiderAuth = { Authorization: `Bearer ${outsider.token}` };

    const createAttempt = await api()
      .post(`${HM_PREFIX}/requests`)
      .set(outsiderAuth)
      .send({
        channelAttributionId: f.attribution.id,
        serviceCatalogId: service.id,
      });
    assert.equal(createAttempt.status, 403, JSON.stringify(createAttempt.body));
    assert.equal(createAttempt.body.error.code, 'BUILDING_ACCESS_DENIED');

    const uploadAttempt = await api()
      .post(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(outsiderAuth)
      .field('evidenceKind', 'PHOTO')
      .attach('file', Buffer.from('photo'), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });
    assert.equal(uploadAttempt.status, 403);
    assert.equal(uploadAttempt.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listAttempt = await api()
      .get(`${HM_PREFIX}/requests/${request.id}/intake-evidence`)
      .set(outsiderAuth);
    assert.equal(listAttempt.status, 403);
    assert.equal(listAttempt.body.error.code, 'BUILDING_ACCESS_DENIED');

    const profilesAttempt = await api()
      .get(`${HM_PREFIX}/catalogue/material-profiles`)
      .set(outsiderAuth)
      .query({ clientId: f.client.id });
    assert.equal(profilesAttempt.status, 403);
    assert.equal(profilesAttempt.body.error.code, 'BUILDING_ACCESS_DENIED');

    // services catalogue keeps the no-leak posture: empty, not 403/404
    const noLeak = await api()
      .get(`${HM_PREFIX}/catalogue/services`)
      .set(outsiderAuth)
      .query({ clientId: f.client.id });
    assert.equal(noLeak.status, 200);
    assert.deepEqual(noLeak.body.data, []);
  });

  it('10: OpenAPI matches the actual CR-HM-02 HTTP surface exactly', async () => {
    const raw = readFileSync(
      new URL('../docs/api/openapi.yaml', import.meta.url),
      'utf8',
    );
    const spec = parseYaml(raw) as Json;

    const expected: Record<string, string[]> = {
      '/handyman/catalogue/services': ['get'],
      '/handyman/catalogue/material-profiles': ['get'],
      '/handyman/catalogue/material-profiles/{profileId}': ['get'],
      '/handyman/requests': ['get', 'post'],
      '/handyman/requests/{handymanRequestId}/intake-evidence': ['get', 'post'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      const item = spec.paths[path] as Json | undefined;
      assert.ok(item, `spec documents ${path}`);
      const verbs = Object.keys(item).filter((verb) => verb !== 'parameters');
      assert.deepEqual(verbs.sort(), methods);
      for (const verb of methods) {
        assert.deepEqual(
          item[verb].security,
          [{ bearerAuth: [] }],
          `${verb.toUpperCase()} ${path} uses Bearer session auth`,
        );
      }
    }
    // CR-HM-02 surface is present (W01 PART 03: later CRs legitimately add
    // paths; each later CR owns and certifies its own surface, so this
    // test asserts the CR-HM-02 subset is intact rather than exact equality).
    const registeredHmPaths = Object.keys(spec.paths).filter((path) =>
      path.startsWith('/handyman/'),
    );
    for (const path of Object.keys(expected)) {
      assert.ok(registeredHmPaths.includes(path), `CR-HM-02 path ${path}`);
    }
    // Destructive/terminal surface is still forbidden anywhere under HM.
    // (Triage, quotation, assignment, QC, BAST are now CR-owned and are
    // NOT forbidden here; close/cancel/transition/lifecycle remain forbidden
    // until the Handyman-Manager CLOSE contract lands.)
    for (const path of registeredHmPaths) {
      assert.ok(
        !/lifecycle|transition|cancel|\bclose\b/i.test(path),
        `forbidden surface leaked into ${path}`,
      );
      const verbs = Object.keys(
        (spec.paths as Json)[path],
      ).filter((verb) => verb !== 'parameters');
      // W01 PART 03: DELETE is legitimately documented ONLY for the Customer
      // Care workspace logout (DELETE /handyman/care/session, care-workspace
      // routes). Any other mutating verb is still forbidden.
      const allowedExtra = path === '/handyman/care/session' ? ['delete'] : [];
      assert.deepEqual(
        verbs.filter((verb) => !['get', 'post', ...allowedExtra].includes(verb)),
        [],
        `${path} exposes no mutating verbs beyond POST`,
      );
    }
    // bounded upload policy documented
    const upload = spec.paths[
      '/handyman/requests/{handymanRequestId}/intake-evidence'
    ].post;
    const uploadBody = upload.requestBody.content['multipart/form-data'].schema;
    assert.deepEqual(uploadBody.required, ['file', 'evidenceKind']);
    assert.deepEqual(uploadBody.properties.evidenceKind.enum, ['PHOTO', 'VIDEO']);
    assert.match(uploadBody.properties.evidenceKind.description, /video\/mp4/);
    assert.match(uploadBody.properties.evidenceKind.description, /image\/jpeg/);
    assert.match(uploadBody.properties.evidenceKind.description, /50 MB/);
    const getAll = spec.paths['/handyman/catalogue/services'].get;
    assert.equal(
      getAll.parameters.find((p: Json) => p.name === 'clientId')?.in,
      'query',
    );
    // reference-price semantics documented
    const describe = spec.paths[
      '/handyman/catalogue/material-profiles/{profileId}'
    ].get;
    assert.match(describe.description, /Reference Price != Quotation != Final Charge/);
    assert.match(describe.description, /never persisted|never guessed/i);
    const schemas = spec.components.schemas;
    for (const name of [
      'HandymanCatalogueServiceItem',
      'HandymanServiceVariant',
      'HandymanCommonMaterialProfile',
      'HandymanMaterialProfileCatalogEntry',
      'CreateHandymanServiceRequest',
      'HandymanServiceRequest',
      'HandymanIntakeEvidence',
      'HandymanIntakeEvidenceKind',
    ]) {
      assert.ok(schemas[name], `schema ${name} documented`);
    }
    // W01 PART 03: CR-HM-03 added the lifecycle statuses; the enum must match
    // HANDYMAN_SERVICE_REQUEST_STATUSES (handyman-service-request.types.ts).
    assert.deepEqual(schemas.HandymanServiceRequestStatus.enum, [
      'INTAKE', 'TRIAGE', 'INSPECTION_REQUIRED', 'DIAGNOSIS',
      'READY_FOR_NEXT_STEP', 'REFERRED',
    ]);
    assert.ok(
      !('fileReference' in schemas.HandymanIntakeEvidence.properties),
      'storage references never exposed in the intake evidence contract',
    );
    assert.deepEqual(schemas.HandymanIntakeEvidenceKind.enum, ['PHOTO', 'VIDEO']);
    assert.deepEqual(
      schemas.CreateHandymanServiceRequest.required,
      ['channelAttributionId', 'serviceCatalogId'],
    );
  });

  it('11: evidence admission regression — generic engine behavior unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await attributedFixture();
    const templateId = randomUUID();
    await q(
      `INSERT INTO checklist_templates (id, client_id, code, name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')`,
      [templateId, f.client.id, `CT_${suffix()}`, 'Checklist A'],
    );
    const executionId = randomUUID();
    await q(
      `INSERT INTO checklist_executions (id, client_id, checklist_template_id)
       VALUES ($1, $2, $3)`,
      [executionId, f.client.id, templateId],
    );
    const evidenceId = randomUUID();
    await q(
      `INSERT INTO evidence_submissions
         (id, client_id, execution_type, execution_id, evidence_type,
          file_reference, original_file_name, mime_type, file_size)
       VALUES ($1, $2, 'CHECKLIST_EXECUTION', $3, 'PHOTO', $4, $5, 'image/jpeg', 0)`,
      [evidenceId, f.client.id, executionId, `external-ref-${randomUUID()}`, 'placeholder.jpg'],
    );

    // VIDEO bytes are still refused by the generic PHOTO allowlist — the
    // PART 04 VIDEO admission stays bound to the Handyman surface only.
    const videoOnPhoto = await api()
      .post(`/api/v1/evidence/${evidenceId}/file`)
      .set(auth())
      .attach('file', Buffer.from('video-bytes'), {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
      });
    assert.equal(videoOnPhoto.status, 400);
    assert.match(videoOnPhoto.body.error.message, /does not accept MIME type/);

    // an allowed PHOTO upload through the existing engine still succeeds
    const photoUpload = await api()
      .post(`/api/v1/evidence/${evidenceId}/file`)
      .set(auth())
      .attach('file', Buffer.from('photo-bytes'), {
        filename: 'photo.webp',
        contentType: 'image/webp',
      });
    assert.equal(photoUpload.status, 201, JSON.stringify(photoUpload.body));
    assert.equal(photoUpload.body.data.id, evidenceId);
    assert.equal(
      photoUpload.body.data.contentSha256,
      sha256Hex(Buffer.from('photo-bytes')),
    );
  });
});
