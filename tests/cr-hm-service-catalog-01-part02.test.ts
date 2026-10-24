import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';

import { resetAppConfigCache } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { listHandymanQuotationVersionLines } from '../src/modules/handyman-quotations';
import { importHandymanServiceCatalogStarter } from '../src/modules/handyman-parameterized-catalog';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 02 — Catalog Completeness & Pricing
 * Integrity.
 *
 * Focused acceptance suite, proven against a DISPOSABLE PostgreSQL
 * (embedded, unique port, removed after the run):
 *
 *   B. Variant attribute administration — add, edit, retire; the choice is
 *      validated against the SERVICE it configures; a change never breaks
 *      an existing quotation; RBAC and Client isolation hold.
 *   C. Access complexity pricing — a difficult / high-floor /
 *      special-equipment job is priced ONLY by a governed access price
 *      tier; without that tier the engine fails closed to MANUAL_REVIEW.
 *      No surcharge is ever computed and no fictitious amount is produced.
 *   D. Pricing tier integrity — no rule collision, the right tier is
 *      selected, effective-dated pricing is consistent, the quotation keeps
 *      its price snapshot and nothing is ever charged twice.
 */

const DIR = '/tmp/cr-hm-service-catalog-01-part02-pg';
const PORT = 55631;

const V1 = '/api/v1';
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);

let database: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | null = null;
let pool: Pool;
let adminId = '';
let adminToken = '';
let disciplineId = '';

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
  });
  database = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({
    host: '127.0.0.1',
    port: PORT,
    database: 'asentra_test',
    user: 'postgres',
    password: '',
    ssl: false,
    name: 'asentra_test',
  } as never);
  await migrateUp(pool);

  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline, 'the GENERAL_HANDYMAN discipline must be seeded');
  disciplineId = discipline.id;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (database) await database.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
    rmSync(DIR, { recursive: true, force: true });
    resetAppConfigCache();
  }
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

type Realm = {
  clientId: string;
  buildingId: string;
  spaceId: string;
  picUserId: string;
};

async function realmFixture(label: string): Promise<Realm> {
  const client = await (
    await import('../src/modules/clients')
  ).clientService.createClient({
    code: `C_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${label} Client`,
  });
  const property = await (
    await import('../src/modules/properties')
  ).propertyService.createProperty({
    clientId: client.id,
    code: `P_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Property',
  });
  const building = await (
    await import('../src/modules/buildings')
  ).buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminId, {
    buildingId: building.id,
  });

  const floor = await (
    await import('../src/modules/floors')
  ).floorService.createFloor({
    buildingId: building.id,
    code: `F_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await (
    await import('../src/modules/areas')
  ).areaService.createArea({
    floorId: floor.id,
    code: `A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Area',
  });
  const room = await (
    await import('../src/modules/rooms')
  ).roomService.createRoom({
    areaId: area.id,
    code: `R_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Room',
  });
  const space = await (
    await import('../src/modules/spaces')
  ).spaceService.createSpace({
    roomId: room.id,
    code: `S_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Tenant Space',
  });

  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `TNT_${randomUUID().slice(0, 8).toUpperCase()}`,
      tenantName: 'Tenant Company',
    },
    adminId,
  );
  const picUser = await userService.createUser({
    email: `pic-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant Requester',
      email: 'requester@tenant.example.com',
      userId: picUser.id,
    },
    adminId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: building.id,
      spaceId: space.id,
    },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: building.id,
    },
    adminId,
  );
  await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: picUser.id,
  });

  await q(
    `INSERT INTO client_allowed_transaction_currencies (client_id, currency_code)
     VALUES ($1, 'IDR') ON CONFLICT DO NOTHING`,
    [client.id],
  );

  const starter = await importHandymanServiceCatalogStarter(client.id, adminId);
  assert.equal(starter.services.created, 24);

  return {
    clientId: client.id,
    buildingId: building.id,
    spaceId: space.id,
    picUserId: picUser.id,
  };
}

async function requestFixture(realm: Realm): Promise<string> {
  const attributionId = (
    await q(
      `SELECT id FROM handyman_channel_attributions
        WHERE tenant_company_id = (SELECT id FROM tenant_companies
          WHERE client_id = $1 LIMIT 1)
        ORDER BY created_at DESC LIMIT 1`,
      [realm.clientId],
    )
  ).rows[0]?.id as string;

  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.clientId,
      code: `HM${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Handyman Service',
      category: 'AIR_CONDITIONING',
    },
    adminId,
  );
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
    {
      channelAttributionId: attributionId,
      serviceCatalogId: service.id,
    },
    adminId,
  );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: 'Fixture diagnosis.',
    },
    adminId,
  );
  return request.id;
}

async function serviceIdFor(clientId: string, code: string): Promise<string> {
  const row = await q(
    `SELECT id FROM service_catalog WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  assert.ok(row.rows[0], `starter service ${code} must exist`);
  return row.rows[0].id as string;
}

async function attributeIdFor(
  clientId: string,
  serviceCatalogId: string,
  code: string,
): Promise<string> {
  const row = await q(
    `SELECT id FROM handyman_service_attributes
      WHERE client_id = $1 AND service_catalog_id = $2 AND code = $3`,
    [clientId, serviceCatalogId, code],
  );
  assert.ok(row.rows[0], `attribute ${code} must exist`);
  return row.rows[0].id as string;
}

async function variantIdFor(
  clientId: string,
  serviceCatalogId: string,
): Promise<string> {
  const row = await q(
    `SELECT id FROM handyman_service_variants
      WHERE client_id = $1 AND service_catalog_id = $2
      ORDER BY code ASC LIMIT 1`,
    [clientId, serviceCatalogId],
  );
  assert.ok(row.rows[0], 'the starter creates a default variant per service');
  return row.rows[0].id as string;
}

/** An ACTIVE governed SERVICE price fact — the EXISTING price authority. */
async function servicePrice(
  clientId: string,
  serviceCatalogId: string,
  unitPrice: number,
  options: { priceKey?: string; effectiveFrom?: string } = {},
): Promise<string> {
  const entry = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      buildingId: null,
      sourceMode: 'SERVICE',
      serviceId: serviceCatalogId,
      servicePriceKey: options.priceKey ?? '',
      currency: 'IDR',
      unitPrice,
      effectiveFrom: options.effectiveFrom ?? '2020-01-01T00:00:00.000Z',
      idempotencyKey: `pk-${randomUUID()}`,
    },
    adminId,
  );
  const activated = await priceCatalogEntryService.activatePriceCatalogEntry(
    entry.id,
    adminId,
  );
  return activated.id;
}

async function priceRule(
  serviceCatalogId: string,
  input: {
    ruleCode: string;
    priceCatalogEntryId: string;
    priceBasis?: 'UNIT' | 'POINT' | 'METER' | 'SQM' | 'VISIT';
    attributeSelector?: Record<string, string>;
    minQuantity?: number;
    maxQuantity?: number;
  },
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  const { createHandymanServicePriceRule } = await import(
    '../src/modules/handyman-parameterized-catalog'
  );
  try {
    await createHandymanServicePriceRule(
      serviceCatalogId,
      {
        ruleCode: input.ruleCode,
        priceCatalogEntryId: input.priceCatalogEntryId,
        priceBasis: input.priceBasis ?? 'UNIT',
        ...(input.attributeSelector
          ? { attributeSelector: input.attributeSelector }
          : {}),
        ...(input.minQuantity === undefined
          ? {}
          : { minQuantity: input.minQuantity }),
        ...(input.maxQuantity === undefined
          ? {}
          : { maxQuantity: input.maxQuantity }),
      },
      adminId,
    );
    return { ok: true };
  } catch (error) {
    const err = error as { message?: string; code?: string };
    return { ok: false, message: err.message ?? '', code: err.code ?? '' };
  }
}

async function addItem(
  requestId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await api()
    .post(`${V1}/handyman/requests/${requestId}/items`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body);
  return { status: response.status, body: response.body as Record<string, never> };
}

async function prepareQuotation(
  requestId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await api()
    .post(`${V1}/handyman/requests/${requestId}/quotation/prepare`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body);
  return { status: response.status, body: response.body as Record<string, never> };
}

const AC_ATTRIBUTES = {
  AC_CAPACITY: '1',
  AC_TYPE: 'SPLIT',
  AC_DRIVE_TYPE: 'INVERTER',
};

/* ------------------------------------------------------------------ */
/* B. Variant attribute administration                                 */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 02 — variant attribute administration', () => {
  it('adds, edits and retires a variant choice without destroying its history', async () => {
    const realm = await realmFixture('VariantAdmin');
    const serviceId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const variantId = await variantIdFor(realm.clientId, serviceId);
    const capacityId = await attributeIdFor(
      realm.clientId,
      serviceId,
      'AC_CAPACITY',
    );

    // The starter creates the default variant; it carries NO choice yet.
    const variants = await api()
      .get(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(variants.status, 200);
    const listed = variants.body.data as {
      id: string;
      code: string;
      attributes: unknown[];
    }[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, variantId);
    assert.equal(listed[0].attributes.length, 0);

    // ADD — a numeric attribute takes a numeric choice.
    const created = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ attributeId: capacityId, valueNumber: 1.5 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const choice = created.body.data as {
      id: string;
      valueText: string | null;
      valueNumber: number | null;
      status: string;
      deactivatedAt: string | null;
    };
    assert.equal(choice.valueNumber, 1.5);
    assert.equal(choice.valueText, null);
    assert.equal(choice.status, 'ACTIVE');
    assert.equal(choice.deactivatedAt, null);

    // A second choice for the SAME (variant, attribute) pair is refused —
    // the administration never overwrites a choice silently.
    const duplicate = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ attributeId: capacityId, valueNumber: 2 });
    assert.equal(duplicate.status, 409);
    const stillThere = await q(
      `SELECT value_number FROM handyman_service_variant_attributes WHERE id = $1`,
      [choice.id],
    );
    assert.equal(Number(stillThere.rows[0].value_number), 1.5);

    // EDIT — the value changes, the row identity does not.
    const edited = await api()
      .patch(
        `${V1}/service-catalog/parameterized/variant-attributes/${choice.id}`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ valueNumber: 2 });
    assert.equal(edited.status, 200);
    assert.equal((edited.body.data as { valueNumber: number }).valueNumber, 2);
    assert.equal((edited.body.data as { id: string }).id, choice.id);

    // RETIRE — the row survives, stamped with who retired it and when.
    const retired = await api()
      .patch(
        `${V1}/service-catalog/parameterized/variant-attributes/${choice.id}`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'INACTIVE' });
    assert.equal(retired.status, 200);
    const retiredBody = retired.body.data as {
      status: string;
      deactivatedAt: string | null;
      deactivatedByUserId: string | null;
      valueNumber: number;
    };
    assert.equal(retiredBody.status, 'INACTIVE');
    assert.ok(retiredBody.deactivatedAt, 'the retirement is stamped');
    assert.equal(retiredBody.deactivatedByUserId, adminId);
    assert.equal(retiredBody.valueNumber, 2, 'the value is preserved');

    // The retired choice is filtered out of the ACTIVE view but stays in
    // the history view.
    const activeOnly = await api()
      .get(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes?status=ACTIVE`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(activeOnly.status, 200);
    assert.equal((activeOnly.body.data as unknown[]).length, 0);

    const history = await api()
      .get(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(history.status, 200);
    assert.equal((history.body.data as unknown[]).length, 1);

    // The audit trail records the three governed writes.
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_SERVICE_VARIANT_ATTRIBUTE'
          AND entity_id = $1 ORDER BY created_at ASC`,
      [choice.id],
    );
    const types = events.rows.map((r) => r.event_type as string);
    assert.ok(types.includes('HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_CREATED'));
    assert.ok(types.includes('HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_UPDATED'));
    assert.ok(types.includes('HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_DEACTIVATED'));
  });

  it('validates the choice against the service and the attribute type', async () => {
    const realm = await realmFixture('VariantValidation');
    const serviceId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const otherServiceId = await serviceIdFor(realm.clientId, 'PLUMBING_PIPE_REPAIR');
    const variantId = await variantIdFor(realm.clientId, serviceId);
    const capacityId = await attributeIdFor(
      realm.clientId,
      serviceId,
      'AC_CAPACITY',
    );
    const typeId = await attributeIdFor(realm.clientId, serviceId, 'AC_TYPE');
    const otherAttributeId = await attributeIdFor(
      realm.clientId,
      otherServiceId,
      'PLUMBING_PIPE_MATERIAL',
    );

    // A choice that configures an attribute of ANOTHER service is refused.
    const crossService = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ attributeId: otherAttributeId, valueText: 'LEAK' });
    assert.equal(crossService.status, 400);
    assert.equal(
      (crossService.body.error as { code: string }).code,
      'HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_INVALID',
    );

    // A numeric attribute refuses a text choice.
    const wrongType = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ attributeId: capacityId, valueText: 'one point five' });
    assert.equal(wrongType.status, 400);

    // An ENUM attribute refuses a value outside its allowed values.
    const badEnum = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ attributeId: typeId, valueText: 'NOT_A_TYPE' });
    assert.equal(badEnum.status, 400);

    // A valid ENUM choice is accepted.
    const goodEnum = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ attributeId: typeId, valueText: 'CASSETTE' });
    assert.equal(goodEnum.status, 201, JSON.stringify(goodEnum.body));

    // Nothing was written by the refused attempts.
    const rows = await q(
      `SELECT COUNT(*)::int AS count FROM handyman_service_variant_attributes
        WHERE service_variant_id = $1`,
      [variantId],
    );
    assert.equal(rows.rows[0].count, 1);
  });

  it('keeps the RBAC and the Client isolation of the administration surface', async () => {
    const realm = await realmFixture('VariantScope');
    const serviceId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const variantId = await variantIdFor(realm.clientId, serviceId);
    const capacityId = await attributeIdFor(
      realm.clientId,
      serviceId,
      'AC_CAPACITY',
    );

    // 401 — unauthenticated.
    const anonymous = await api().get(
      `${V1}/service-catalog/parameterized/entries/${serviceId}/variants`,
    );
    assert.equal(anonymous.status, 401);

    // 403 — a caller without the catalogue permission.
    const plain = await createPlainSession();
    const forbidden = await api()
      .get(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants`,
      )
      .set('Authorization', `Bearer ${plain}`);
    assert.equal(forbidden.status, 403);

    const writeForbidden = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${plain}`)
      .send({ attributeId: capacityId, valueNumber: 1 });
    assert.equal(writeForbidden.status, 403);

    // 403 — a caller that holds the permission but has no Client reach.
    const scoped = await createSessionWithPermissions([
      { code: 'service_catalog.read', name: 'Read Service Catalog' },
      { code: 'service_catalog.manage', name: 'Manage Service Catalog' },
    ]);
    const denied = await api()
      .get(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants`,
      )
      .set('Authorization', `Bearer ${scoped}`);
    assert.equal(denied.status, 403, 'no same-Client shortcut');

    // A choice of another Client is not addressable: the variant id of a
    // foreign service never resolves.
    const foreign = await api()
      .get(
        `${V1}/service-catalog/parameterized/entries/${serviceId}/variants/${id()}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(foreign.status, 404);
  });
});

/* ------------------------------------------------------------------ */
/* C. Access complexity pricing                                        */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 02 — access complexity pricing', () => {
  it('refuses to price a difficult job that has no access price tier', async () => {
    const realm = await realmFixture('AccessFailClosed');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const basePrice = await servicePrice(realm.clientId, installId, 750_000);
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: basePrice,
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: AC_ATTRIBUTES,
      accessCondition: 'DIFFICULT',
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'MANUAL_REVIEW');
    assert.equal(prepared.body.data.quotation, null);
    const resolutions = prepared.body.data.resolutions as {
      outcome: string;
      reasonCode: string;
      unitAmount: number | null;
      computedTotal: number | null;
      reasonDetail: string;
    }[];
    assert.equal(resolutions[0].outcome, 'MANUAL_REVIEW');
    assert.equal(resolutions[0].reasonCode, 'PRICE_RULE_NOT_FOUND');
    assert.equal(resolutions[0].unitAmount, null, 'never a fictitious amount');
    assert.equal(resolutions[0].computedTotal, null);
    assert.match(resolutions[0].reasonDetail, /DIFFICULT/);
  });

  it('prices the access tier with its own governed amount and never twice', async () => {
    const realm = await realmFixture('AccessTier');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const basePrice = await servicePrice(realm.clientId, installId, 750_000);
    const highFloorPrice = await servicePrice(
      realm.clientId,
      installId,
      900_000,
      { priceKey: 'AC_INSTALL_HIGH_FLOOR' },
    );
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: basePrice,
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_HIGH_FLOOR',
      priceCatalogEntryId: highFloorPrice,
      attributeSelector: { ACCESS_CONDITION: 'HIGH_FLOOR' },
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: AC_ATTRIBUTES,
      accessCondition: 'STANDARD',
    });
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 2,
      attributeValues: AC_ATTRIBUTES,
      accessCondition: 'HIGH_FLOOR',
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY', JSON.stringify(prepared.body));
    const resolutions = prepared.body.data.resolutions as {
      outcome: string;
      priceCatalogEntryId: string;
      unitAmount: number;
      quantity: number;
      computedTotal: number;
    }[];
    assert.equal(resolutions.length, 2);
    const standard = resolutions.find((r) => r.quantity === 1);
    const highFloor = resolutions.find((r) => r.quantity === 2);
    assert.ok(standard && highFloor);
    assert.equal(standard.priceCatalogEntryId, basePrice);
    assert.equal(standard.unitAmount, 750_000);
    assert.equal(highFloor.priceCatalogEntryId, highFloorPrice);
    assert.equal(highFloor.unitAmount, 900_000);
    // NO DOUBLE CHARGE: the access tier is a COMPLETE governed price, not
    // the standard amount plus an uplift.
    assert.equal(highFloor.computedTotal, 900_000 * 2);
    assert.notEqual(highFloor.computedTotal, 750_000 * 2 + 900_000);
    assert.equal(standard.computedTotal, 750_000);
  });

  it('governs the special-equipment access complexity like any other tier', async () => {
    const realm = await realmFixture('SpecialEquipment');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const basePrice = await servicePrice(realm.clientId, installId, 750_000);
    const specialPrice = await servicePrice(
      realm.clientId,
      installId,
      1_400_000,
      { priceKey: 'AC_INSTALL_SPECIAL_EQUIPMENT' },
    );
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: basePrice,
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_SPECIAL_EQUIPMENT',
      priceCatalogEntryId: specialPrice,
      attributeSelector: { ACCESS_CONDITION: 'SPECIAL_EQUIPMENT' },
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: AC_ATTRIBUTES,
      accessCondition: 'SPECIAL_EQUIPMENT',
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY', JSON.stringify(prepared.body));
    const resolutions = prepared.body.data.resolutions as {
      priceCatalogEntryId: string;
      unitAmount: number;
    }[];
    assert.equal(resolutions[0].priceCatalogEntryId, specialPrice);
    assert.equal(resolutions[0].unitAmount, 1_400_000);
  });

  it('refuses the reserved access key as an item attribute', async () => {
    const realm = await realmFixture('ReservedKey');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const requestId = await requestFixture(realm);
    const created = await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: { ...AC_ATTRIBUTES, ACCESS_CONDITION: 'DIFFICULT' },
    });
    assert.equal(created.status, 400);
  });
});

/* ------------------------------------------------------------------ */
/* D. Pricing tier integrity                                           */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 02 — pricing tier integrity', () => {
  it('refuses an access rule that would consume the plain reference price', async () => {
    const realm = await realmFixture('TierPlain');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const basePrice = await servicePrice(realm.clientId, installId, 750_000);

    const refused = await priceRule(installId, {
      ruleCode: 'AC_INSTALL_DIFFICULT',
      priceCatalogEntryId: basePrice,
      attributeSelector: { ACCESS_CONDITION: 'DIFFICULT' },
    });
    assert.equal(refused.ok, false);
    assert.equal(
      refused.ok === false ? refused.code : '',
      'HANDYMAN_SERVICE_PRICE_RULE_INVALID',
    );
  });

  it('refuses a rule that would consume another rule tier', async () => {
    const realm = await realmFixture('TierForeign');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const inverterPrice = await servicePrice(
      realm.clientId,
      installId,
      950_000,
      { priceKey: 'AC_INSTALL_INVERTER' },
    );

    const refused = await priceRule(installId, {
      ruleCode: 'AC_INSTALL_OTHER',
      priceCatalogEntryId: inverterPrice,
    });
    assert.equal(refused.ok, false);
    assert.equal(
      refused.ok === false ? refused.code : '',
      'HANDYMAN_SERVICE_PRICE_RULE_INVALID',
    );
  });

  it('refuses two equally specific rules for the same selection', async () => {
    const realm = await realmFixture('TierCollision');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const basePrice = await servicePrice(realm.clientId, installId, 750_000);
    const otherPrice = await servicePrice(
      realm.clientId,
      installId,
      780_000,
      { priceKey: 'AC_INSTALL_SECOND' },
    );

    const first = await priceRule(installId, {
      ruleCode: 'AC_INSTALL_FIRST',
      priceCatalogEntryId: basePrice,
      attributeSelector: { AC_TYPE: 'SPLIT' },
    });
    assert.equal(first.ok, true);

    const second = await priceRule(installId, {
      ruleCode: 'AC_INSTALL_SECOND',
      priceCatalogEntryId: otherPrice,
      attributeSelector: { AC_TYPE: 'SPLIT' },
    });
    assert.equal(second.ok, false);
    assert.equal(
      second.ok === false ? second.code : '',
      'HANDYMAN_SERVICE_PRICE_RULE_COLLISION',
    );
  });

  it('fails closed when a price fact drifts out of its tier', async () => {
    const realm = await realmFixture('TierDrift');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const basePrice = await servicePrice(
      realm.clientId,
      installId,
      750_000,
      { priceKey: 'AC_INSTALL_BASE' },
    );
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: basePrice,
    });

    // The price fact is moved into another tier behind the engine's back.
    await q(
      `UPDATE price_catalog_entries SET service_price_key = 'AC_INSTALL_DRIFTED'
        WHERE id = $1`,
      [basePrice],
    );

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: AC_ATTRIBUTES,
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'MANUAL_REVIEW');
    const resolutions = prepared.body.data.resolutions as {
      outcome: string;
      reasonCode: string;
      unitAmount: number | null;
    }[];
    assert.equal(resolutions[0].outcome, 'MANUAL_REVIEW');
    assert.equal(resolutions[0].reasonCode, 'PRICE_TIER_MISMATCH');
    assert.equal(resolutions[0].unitAmount, null);
  });

  it('keeps the quotation snapshot intact when the catalogue changes', async () => {
    const realm = await realmFixture('SnapshotStability');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const variantId = await variantIdFor(realm.clientId, installId);
    const capacityId = await attributeIdFor(
      realm.clientId,
      installId,
      'AC_CAPACITY',
    );
    const basePrice = await servicePrice(realm.clientId, installId, 750_000);
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: basePrice,
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: variantId,
      quantity: 2,
      attributeValues: AC_ATTRIBUTES,
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY', JSON.stringify(prepared.body));
    const quotation = prepared.body.data.quotation as {
      id: string;
      versions: { id: string; versionNumber: number }[];
    };
    const lines = await listHandymanQuotationVersionLines(
      quotation.versions[0].id,
      adminId,
    );
    assert.equal(lines.length, 1);
    assert.equal(Number(lines[0].finalQuotedUnitAmount), 750_000);
    assert.equal(Number(lines[0].lineTotal), 1_500_000);

    // The catalogue changes AFTER the quotation was issued: a variant
    // choice is added and retired, and the price fact is deactivated.
    const created = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${installId}/variants/${variantId}/attributes`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ attributeId: capacityId, valueNumber: 1 });
    assert.equal(created.status, 201);
    const choiceId = (created.body.data as { id: string }).id;
    await api()
      .patch(
        `${V1}/service-catalog/parameterized/variant-attributes/${choiceId}`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'INACTIVE' });
    await priceCatalogEntryService.deactivatePriceCatalogEntry(
      basePrice,
      adminId,
    );

    // The issued quotation is untouched.
    const after = await listHandymanQuotationVersionLines(
      quotation.versions[0].id,
      adminId,
    );
    assert.equal(after.length, 1);
    assert.equal(Number(after[0].finalQuotedUnitAmount), 750_000);
    assert.equal(Number(after[0].lineTotal), 1_500_000);

    // The recorded snapshot is append-only: it still carries the fact that
    // was priced.
    const snapshot = await q(
      `SELECT unit_amount, computed_total, price_catalog_entry_id
         FROM handyman_service_quote_resolutions
        WHERE handyman_request_id = $1 AND outcome = 'PRICED'`,
      [requestId],
    );
    assert.equal(snapshot.rows.length, 1);
    assert.equal(Number(snapshot.rows[0].unit_amount), 750_000);
    assert.equal(Number(snapshot.rows[0].computed_total), 1_500_000);
    assert.equal(snapshot.rows[0].price_catalog_entry_id, basePrice);
  });
});
