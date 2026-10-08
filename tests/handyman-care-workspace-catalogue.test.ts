import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { handymanCareActorService, grantCareActorProperty, revokeCareActorProperty } from '../src/modules/handyman-care-actors';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { readCareWorkspaceCatalogue } from '../src/modules/handyman-care-workspace/care-workspace-catalogue.service';
import { handymanCareCatalogueRepository } from '../src/modules/handyman-catalog/handyman-care-catalogue.repository';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { handymanServiceVariantService, handymanCommonMaterialProfileService } from '../src/modules/handyman-catalog';
import { inventoryItemService } from '../src/modules/inventory-items';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { priceCatalogEntryService, priceCatalogLookupService } from '../src/modules/price-catalog-entries';
import { priceCatalogEntryRepository } from '../src/modules/price-catalog-entries/price-catalog-entry.repository';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName,
  consumeHandoffExchange } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, revokeCareWorkspaceSession,
  signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-catalogue-pg';
const PORT = 55534;
const SECRET = 'workspace-admission-test-integration-secret';
let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string;
let actorId: string;
let integrationId: string;
let envKey: string;
let userToken: string;
let adminId: string;
let token: string;
let otherActorId: string;
let otherToken: string;
let clientId: string;
let otherClientId: string;
let props: string[] = [];
let buildings: string[][] = [];
let denied: string;
let foreign: string;
let services: string[] = [];
let variants: string[] = [];
let foreignService: string;
let profileId: string;
let variantProfileId: string;
let otherProfileId: string;
let itemId: string;
let uomId: string;
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const path = '/api/v1/handyman/care/properties';
const cataloguePath = (propertyId = props[0]) => `${path}/${propertyId}/catalogue`;
const servicesPath = (propertyId = props[0]) => `${cataloguePath(propertyId)}/services`;
const profilesPath = (propertyId = props[0]) => `${cataloguePath(propertyId)}/material-profiles`;
const detailPath = (id = profileId, propertyId = props[0]) => `${profilesPath(propertyId)}/${id}`;
const pricing = () => ({ buildingId: buildings[0][0], currency: 'IDR' });
const get = (url = servicesPath(), credential = token) => api().get(url).set('Authorization', `Bearer ${credential}`);
const unauthorized = (error: any) => error.statusCode === 401 &&
  error.code === 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED';

before(async () => {
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
      DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Focused scope-read tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);
  code = `WS_${randomUUID().slice(0, 8).toUpperCase()}`;
  integrationId = (await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Workspace BM' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  actorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'care-operator', displayName: 'Care' })).id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;
  const admin = await createAdminUser();
  userToken = admin.token;
  adminId = admin.userId;
  clientId = (await clientService.createClient({ code: `C_${suffix()}`, name: 'Scope client' })).id;
  otherClientId = (await clientService.createClient({ code: `C_${suffix()}`, name: 'Other client' })).id;
  for (let i = 0; i < 3; i++) {
    const cid = i === 2 ? otherClientId : clientId;
    const p = await propertyService.createProperty({ clientId: cid, code: `P_${suffix()}`, name: 'Granted' });
    props.push(p.id);
    const ids: string[] = [];
    for (let j = 0; j < 3; j++) {
      const b = await buildingService.createBuilding({ propertyId: p.id, code: `B_${suffix()}`, name: 'Scope building' });
      ids.push(b.id);
      await buildingAssignmentService.createAssignment(adminId, { buildingId: b.id });
    }
    buildings.push(ids);
    await grantCareActorProperty({ careActorId: actorId, propertyId: p.id, clientId: cid }, adminId);
  }
  await pool.query("UPDATE buildings SET status = 'INACTIVE' WHERE id = $1", [buildings[0][2]]);
  denied = (await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Not granted same client' })).id;
  foreign = (await propertyService.createProperty({ clientId: otherClientId, code: `P_${suffix()}`, name: 'Not granted other client' })).id;
  otherActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'other-care', displayName: 'Other care' })).id;
  for (const name of ['Alpha Service', 'Literal %_ Service', 'Inactive Service']) {
    const service = await serviceCatalogService.createServiceCatalogEntry({ clientId, code: `S_${suffix()}`, name, category: 'CARE' }, adminId);
    services.push(service.id);
  }
  for (let i = 0; i < 3; i++) {
    variants.push((await handymanServiceVariantService.createHandymanServiceVariant({ serviceCatalogId: services[0], code: `V_${suffix()}`, name: `Variant ${i}` }, adminId)).id);
  }
  foreignService = (await serviceCatalogService.createServiceCatalogEntry({ clientId: otherClientId, code: `S_${suffix()}`, name: 'Foreign', category: 'CARE' }, adminId)).id;
  uomId = randomUUID();
  await pool.query(`INSERT INTO units_of_measure (id, client_id, code, name, symbol, category) VALUES ($1,$2,$3,'Meter','m','LENGTH')`, [uomId, clientId, `U_${suffix()}`]);
  itemId = (await inventoryItemService.createInventoryItem({ clientId, code: `I_${suffix()}`, name: 'Pipe', itemType: 'MATERIAL', uomId }, adminId)).id;
  const base = { inventoryItemId: itemId, commonality: 'COMMON' as const, customerMaterialOption: 'CUSTOMER_CHOICE' as const, typicalQuantity: 2.5 };
  profileId = (await handymanCommonMaterialProfileService.createHandymanCommonMaterialProfile({ ...base, serviceCatalogId: services[0] }, adminId)).id;
  variantProfileId = (await handymanCommonMaterialProfileService.createHandymanCommonMaterialProfile({ ...base, serviceCatalogId: services[0], serviceVariantId: variants[0] }, adminId)).id;
  otherProfileId = (await handymanCommonMaterialProfileService.createHandymanCommonMaterialProfile({ ...base, serviceCatalogId: services[1] }, adminId)).id;
  await pool.query("UPDATE handyman_service_variants SET status = 'INACTIVE' WHERE id = $1", [variants[2]]);
  await serviceCatalogService.deactivateServiceCatalogEntry(services[2], adminId);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR', 'SGD'] }, adminId);
  for (const [buildingId, amount] of [[null, 25000], [buildings[0][0], 30000]] as [string | null, number][]) {
    const entry = await priceCatalogEntryService.createPriceCatalogEntry({ clientId, buildingId, sourceMode: 'MATERIAL', itemId, uomId,
      currency: 'IDR', unitPrice: amount, effectiveFrom: new Date(Date.now() - 86400000).toISOString(), idempotencyKey: randomUUID() }, adminId);
    await priceCatalogEntryService.activatePriceCatalogEntry(entry.id, adminId);
  }

});
beforeEach(async () => {
  clearLoginRateLimits();
  token = (await admit()).workspaceToken;
  otherToken = (await admit(assertion({ actor: { type: 'CUSTOMER_CARE', actorReference: 'other-care' } }))).workspaceToken;
});
after(async () => {
  if (envKey) delete process.env[envKey];
  clearLoginRateLimits();
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});

function assertion(overrides: Partial<CareWorkspaceAssertion> = {}): CareWorkspaceAssertion {
  return { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care-operator' }, ...overrides };
}
async function admit(a = assertion()) { return admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET)); }

describe('Care property catalogue reads', () => {
  it('projects only ACTIVE same-Client services and ACTIVE child variants, including services without variants', async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual((await get(servicesPath() + '/')).body.data.items, response.body.data.items);
    assert.deepEqual(response.body.data.items.map((s: any) => s.id), services.slice(0, 2).sort());
    const first = response.body.data.items.find((s: any) => s.id === services[0]);
    assert.deepEqual(Object.keys(first).sort(), ['category', 'code', 'description', 'id', 'name', 'variants']);
    assert.deepEqual(first.variants.map((v: any) => v.id), variants.slice(0, 2).sort());
    for (const variant of first.variants) assert.deepEqual(Object.keys(variant).sort(), ['code', 'description', 'id', 'name']);
    assert.deepEqual(response.body.data.items.find((s: any) => s.id === services[1]).variants, []);
    assert.ok(!JSON.stringify(response.body).includes(adminId));
    const sibling = await get(servicesPath(props[1]));
    assert.deepEqual(sibling.body.data.items, response.body.data.items);
    assert.deepEqual((await get(servicesPath(props[2]))).body.data.items.map((s: any) => s.id), [foreignService]);
  });

  it('supports bounded literal service search and deterministic session/scope/filter-bound pagination', async () => {
    assert.deepEqual((await get().query({ q: '  aLPHa  ' })).body.data.items.map((s: any) => s.id), [services[0]]);
    assert.deepEqual((await get().query({ q: '%_' })).body.data.items.map((s: any) => s.id), [services[1]]);
    assert.deepEqual((await get().query({ q: '.*' })).body.data.items, []);
    const first = await get().query({ limit: '1' });
    const cursor = first.body.data.nextCursor;
    const next = await get().query({ limit: '1', cursor });
    assert.deepEqual([first.body.data.items[0].id, next.body.data.items[0].id], services.slice(0, 2).sort());
    assert.equal(next.body.data.nextCursor, null);
    for (const query of [{ limit: '2', cursor }, { limit: '1', cursor, q: 'Alpha' }, { limit: '1', cursor, buildingId: buildings[0][0] }, { limit: '1', cursor: 'A' + cursor.slice(1) }]) assert.equal((await get().query(query)).status, 400);
    assert.equal((await get(servicesPath(props[1])).query({ limit: '1', cursor })).status, 400);
    assert.equal((await get(profilesPath()).query({ limit: '1', cursor })).status, 400);
    assert.equal((await get(servicesPath(), (await admit()).workspaceToken).query({ limit: '1', cursor })).status, 400);
  });

  it('filters material profiles through active parent service/variant/item and minimizes their projection', async () => {
    const response = await get(profilesPath());
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items.map((p: any) => p.id), [profileId, variantProfileId, otherProfileId].sort());
    assert.deepEqual(Object.keys(response.body.data.items[0]).sort(), ['id', 'serviceCatalogId', 'serviceVariantId', 'inventoryItemId', 'specification', 'compatibility', 'typicalQuantity', 'commonality', 'customerMaterialOption', 'item'].sort());
    assert.deepEqual((await get(profilesPath()).query({ serviceVariantId: variants[0] })).body.data.items.map((p: any) => p.id), [variantProfileId]);
    assert.equal((await get(profilesPath()).query({ serviceCatalogId: services[1], serviceVariantId: variants[0] })).status, 404);
    assert.equal((await get(profilesPath()).query({ serviceCatalogId: foreignService })).status, 404);
    const first = await get(profilesPath()).query({ limit: '1' });
    assert.equal((await get(profilesPath()).query({ limit: '1', cursor: first.body.data.nextCursor })).status, 200);
    for (const [table, id] of [['service_catalog', services[0]], ['handyman_service_variants', variants[0]], ['inventory_items', itemId], ['handyman_common_material_profiles', variantProfileId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try {
        const list = await get(profilesPath());
        assert.equal(list.status, 200);
        assert.ok(!list.body.data.items.some((p: any) => p.id === variantProfileId));
        assert.equal((await get(detailPath(variantProfileId))).status, 404);
      } finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
  });

  it('reuses the governed material price resolver and its precedence, with no price copied into profiles', async () => {
    const priced = await get(detailPath()).query(pricing());
    assert.equal(priced.status, 200);
    assert.equal(priced.body.data.referencePrice.unitPrice, 30000);
    assert.equal(priced.body.data.referencePrice.scopeTier, 'BUILDING');
    const legacy = await handymanCommonMaterialProfileService.describeHandymanCommonMaterialProfile(profileId, adminId, pricing() as any);
    assert.deepEqual(priced.body.data.referencePrice, legacy.referencePrice);
    const clientWide = await get(detailPath()).query({ buildingId: buildings[0][1], currency: 'IDR' });
    assert.equal(clientWide.body.data.referencePrice.unitPrice, 25000);
    assert.equal(clientWide.body.data.referencePrice.scopeTier, 'CLIENT_WIDE');
    assert.equal((await get(detailPath())).body.data.referencePrice, null);
    assert.equal((await get(detailPath()).query({ buildingId: buildings[0][0] })).body.data.referencePrice, null);
    assert.equal((await get(detailPath()).query({ ...pricing(), currency: 'SGD' })).body.data.referencePrice, null);
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'handyman_common_material_profiles'");
    assert.ok(!columns.rows.some(r => /price|currency/.test(r.column_name)));
    await assert.rejects(priceCatalogLookupService.lookupPriceCatalogEntry({ sourceMode: 'MATERIAL', itemId, uomId, ...pricing(), asOf: new Date().toISOString() } as any, randomUUID()));
  });

  it('preserves price authority window/UOM/ambiguity failure semantics and never borrows a User for ambiguity audit', async () => {
    const original = priceCatalogEntryRepository.listResolutionCandidates;
    priceCatalogEntryRepository.listResolutionCandidates = async (...args) => {
      const rows = await original(...args);
      const buildingRow = rows.find(r => r.buildingId === buildings[0][0])!;
      return [buildingRow, buildingRow];
    };
    try {
      const ambiguous = await get(detailPath()).query(pricing());
      assert.equal(ambiguous.status, 200);
      assert.equal(ambiguous.body.data.referencePrice, null);
      const event = await pool.query("SELECT actor_user_id FROM operational_events WHERE event_type = 'PRICE_CATALOG_AMBIGUITY_REJECTED' ORDER BY occurred_at DESC LIMIT 1");
      assert.equal(event.rows[0].actor_user_id, null);
    } finally { priceCatalogEntryRepository.listResolutionCandidates = original; }
    await pool.query('UPDATE inventory_items SET uom_id = NULL WHERE id = $1', [itemId]);
    try { assert.equal((await get(detailPath()).query(pricing())).body.data.referencePrice, null); }
    finally { await pool.query('UPDATE inventory_items SET uom_id = $1 WHERE id = $2', [uomId, itemId]); }
    // The existing half-open resolver is reused, not reimplemented by care transport.
    const past = await priceCatalogLookupService.lookupPriceCatalogEntry({ sourceMode: 'MATERIAL', itemId, uomId,
      ...pricing(), asOf: '2000-01-01T00:00:00Z' } as any, adminId);
    assert.equal(past.resolution, 'NO_REFERENCE_PRICE');
  });

  it('rejects foreign/inactive buildings, wrong-service variants and out-of-scope profiles uniformly', async () => {
    for (const buildingId of [buildings[1][0], buildings[0][2], randomUUID()]) {
      assert.equal((await get(detailPath()).query({ buildingId, currency: 'IDR' })).status, 404);
      assert.equal((await get().query({ buildingId })).status, 404);
    }
    assert.equal((await get(detailPath(otherProfileId)).query({ serviceVariantId: variants[0] })).status, 404);
    assert.equal((await get(detailPath()).query({ serviceVariantId: variants[2] })).status, 404);
    assert.equal((await get(detailPath(profileId, props[2]))).status, 404);
    assert.equal((await get(detailPath(randomUUID()))).status, 404);
  });

  it('denies revoked grants and revalidates grant/session after reference-price lookup before release', async () => {
    const page = await get().query({ limit: '1' });
    await revokeCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
    try {
      assert.equal((await get().query({ limit: '1', cursor: page.body.data.nextCursor })).status, 404);
      assert.equal((await get(profilesPath())).status, 404);
      assert.equal((await get(detailPath()).query(pricing())).status, 404);
    } finally { await grantCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId); }
    const original = priceCatalogEntryRepository.listResolutionCandidates;
    priceCatalogEntryRepository.listResolutionCandidates = async (...args) => {
      const rows = await original(...args);
      await revokeCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
      return rows;
    };
    try { assert.equal((await get(detailPath()).query(pricing())).status, 404); }
    finally {
      priceCatalogEntryRepository.listResolutionCandidates = original;
      await grantCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
    }
  });

  it('requires live care credentials and active property/Client, never accepting caller actor/Client authority', async () => {
    const revoked = (await admit()).workspaceToken;
    await revokeCareWorkspaceSession(revoked);
    const expired = 'hcw_' + 'C'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`, [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    for (const url of [servicesPath(), profilesPath(), detailPath()]) {
      assert.equal((await api().get(url)).status, 401);
      for (const credential of [expired, revoked, userToken, 'exchange-token']) assert.equal((await get(url, credential)).status, 401);
      assert.equal((await get(url, otherToken)).status, 404);
    }
    for (const id of [denied, foreign, randomUUID()]) assert.equal((await get(servicesPath(id))).status, 404);
    for (const [table, id] of [['properties', props[0]], ['clients', clientId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 404); }
      finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
  });

  it('revalidates active actor/integration/capability and fails closed on storage or projection-time revocation', async () => {
    for (const [table, id, change, reset] of [
      ['handyman_handoff_care_actors', actorId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "actor_capability = 'NONE'", "actor_capability = 'CUSTOMER_CARE'"],
    ]) {
      token = (await admit()).workspaceToken;
      await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 401); }
      finally { await pool.query(`UPDATE ${table} SET ${reset} WHERE id = $1`, [id]); }
      assert.equal((await get()).status, 401);
    }
    token = (await admit()).workspaceToken;
    const original = handymanCareCatalogueRepository.readCatalogue;
    handymanCareCatalogueRepository.readCatalogue = async (...args) => { await revokeCareWorkspaceSession(token); return original(...args); };
    try { assert.equal((await get()).status, 401); }
    finally { handymanCareCatalogueRepository.readCatalogue = original; }
    token = (await admit()).workspaceToken;
    handymanCareCatalogueRepository.readCatalogue = async () => { throw new Error('catalogue storage unavailable'); };
    try { await assert.rejects(readCareWorkspaceCatalogue(token, props[0], 'services', {}), /catalogue storage unavailable/); }
    finally { handymanCareCatalogueRepository.readCatalogue = original; }
  });

  it('validates bounded queries and denies mutation, financial inputs and create-exchange substitution', async () => {
    for (const query of [{ limit: '0' }, { limit: '101' }, { q: '' }, { q: ' ' }, { q: 'x'.repeat(101) },
      { q: ['a', 'b'] }, { q: '\0' }, { clientId }, { careActorId: actorId }, { tenantCompanyId: randomUUID() }, { price: '1' },
      { status: 'INACTIVE' }, { cursor: 'bad' }, { buildingId: 'bad' }]) assert.equal((await get().query(query)).status, 400);
    assert.equal((await get(profilesPath()).query({ q: 'unsupported' })).status, 400);
    assert.equal((await get(detailPath()).query({ currency: 'IDR' })).status, 400);
    assert.equal((await get(detailPath()).query({ ...pricing(), currency: 'XXX' })).status, 400);
    assert.equal((await get(detailPath()).query({ ...pricing(), asOf: '2000-01-01' })).status, 400);
    assert.equal((await get().send({ clientId })).status, 400);
    assert.equal((await get(servicesPath('bad'))).status, 400);
    for (const url of [servicesPath(), profilesPath(), detailPath()]) assert.equal((await api().post(url).set('Authorization', `Bearer ${token}`).send({})).status, 404);
    await assert.rejects(consumeHandoffExchange(token));
    assert.equal((await get(`/api/v1/handyman/catalogue/services?clientId=${clientId}`, userToken)).status, 200);
    assert.equal((await get(`/api/v1/handyman/catalogue/services?clientId=${clientId}`)).status, 401);
  });

  it('documents only catalogue GET families with workspace authority and read-only reference-price semantics', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    for (const suffix of ['services', 'material-profiles', 'material-profiles/{profileId}']) {
      const route = spec.paths[`/handyman/care/properties/{propertyId}/catalogue/${suffix}`];
      assert.deepEqual(Object.keys(route), ['get']);
      assert.deepEqual(route.get.security, [{ careWorkspaceSession: [] }]);
    }
    assert.equal(spec.components.schemas.CareCatalogueService.additionalProperties, false);
    assert.equal(spec.components.schemas.CareCatalogueProfile.additionalProperties, false);
    assert.equal(spec.components.schemas.CareCatalogueProfileDetail.properties.referencePrice.nullable, true);
  });
});
