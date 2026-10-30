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
  recordHandymanInspection,
} from '../src/modules/handyman-requests';
import {
  decideHandymanQuotation,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  addHandymanQuotationLine,
  issueHandymanQuotationVersion,
  listHandymanQuotationVersionLines,
} from '../src/modules/handyman-quotations';
import { importHandymanServiceCatalogStarter } from '../src/modules/handyman-parameterized-catalog';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 03 — Variant Selection -> Request Items ->
 * Initial Quotation.
 *
 * The focused E2E contract suite, proven against a DISPOSABLE PostgreSQL
 * (embedded, unique port, removed after the run):
 *
 *   1. AC 0.5 PK non-inverter x 2;
 *   2. AC 1.5 PK inverter x 1;
 *   3. both AC kinds in ONE request;
 *   4. different variants select the matching price tier;
 *   5. quantity and UOM survive the quotation unchanged;
 *   6. an UNKNOWN size / unknown attribute reaches inspection or manual
 *      review — never a price;
 *   7. an inactive variant and a cross-Client variant are refused;
 *   8. an attribute change after the inspection drives a quotation
 *      REVISION through the existing lifecycle;
 *   9. an approved quotation does not change because the catalogue changed;
 *  10. no double charge and no automatic approval.
 */

const DIR = '/tmp/cr-hm-service-catalog-01-part03-pg';
const PORT = 55641;

const V1 = '/api/v1';
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);
const VALID_UNTIL = () => new Date(Date.now() + 86_400_000).toISOString();

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

async function requestFixture(
  realm: Realm,
  options: { withInspection?: boolean; inspectionResult?: 'INSPECTED' | 'NOT_INSPECTABLE'; serviceCatalogId?: string } = {},
): Promise<string> {
  const attributionId = (
    await q(
      `SELECT id FROM handyman_channel_attributions
        WHERE tenant_company_id = (SELECT id FROM tenant_companies
          WHERE client_id = $1 LIMIT 1)
        ORDER BY created_at DESC LIMIT 1`,
      [realm.clientId],
    )
  ).rows[0]?.id as string;

  const service = options.serviceCatalogId ? { id: options.serviceCatalogId } : await serviceCatalogService.createServiceCatalogEntry(
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

  if (options.withInspection) {
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: request.id,
        triageDisposition: 'INSPECTION_REQUIRED',
        triageNote: 'Needs a site inspection.',
      },
      adminId,
    );
    await recordHandymanInspection(
      {
        handymanRequestId: request.id,
        inspectionResult: options.inspectionResult ?? 'INSPECTED',
        inspectionNotes: 'Recorded site inspection outcome.',
      },
      adminId,
    );
  } else {
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: request.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Direct to diagnosis.',
      },
      adminId,
    );
  }

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

/** A NEW service variant of one service (the starter only creates STANDARD). */
async function createVariant(
  clientId: string,
  serviceCatalogId: string,
  code: string,
): Promise<string> {
  const row = await q(
    `INSERT INTO handyman_service_variants
       (id, client_id, service_catalog_id, code, name, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
     RETURNING id`,
    [id(), clientId, serviceCatalogId, code, code, adminId],
  );
  return row.rows[0].id as string;
}

/**
 * A variant that configures the WHOLE governed AC vocabulary of the
 * service, so the item it authors carries every REQUIRED attribute.
 */
async function createAcVariant(
  clientId: string,
  serviceCatalogId: string,
  code: string,
  values: { capacity: number; type: string; drive: string },
): Promise<string> {
  const variantId = await createVariant(clientId, serviceCatalogId, code);
  await configureVariant(
    clientId,
    variantId,
    await attributeIdFor(clientId, serviceCatalogId, 'AC_CAPACITY'),
    { number: values.capacity },
  );
  await configureVariant(
    clientId,
    variantId,
    await attributeIdFor(clientId, serviceCatalogId, 'AC_TYPE'),
    { text: values.type },
  );
  await configureVariant(
    clientId,
    variantId,
    await attributeIdFor(clientId, serviceCatalogId, 'AC_DRIVE_TYPE'),
    { text: values.drive },
  );
  return variantId;
}

/** Configure one attribute choice on a variant (the admin write path). */
async function configureVariant(
  clientId: string,
  serviceVariantId: string,
  attributeId: string,
  value: { text?: string; number?: number },
): Promise<void> {
  await q(
    `INSERT INTO handyman_service_variant_attributes
       (id, client_id, service_variant_id, attribute_id, value_text, value_number,
        status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)`,
    [
      id(),
      clientId,
      serviceVariantId,
      attributeId,
      value.text ?? null,
      value.number ?? null,
      adminId,
    ],
  );
}

/** An ACTIVE governed SERVICE price fact — the EXISTING price authority. */
async function servicePrice(
  clientId: string,
  serviceCatalogId: string,
  unitPrice: number,
  options: { priceKey?: string } = {},
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
      effectiveFrom: '2020-01-01T00:00:00.000Z',
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
    serviceVariantId?: string;
    attributeSelector?: Record<string, string>;
  },
): Promise<void> {
  const { createHandymanServicePriceRule } = await import(
    '../src/modules/handyman-parameterized-catalog'
  );
  await createHandymanServicePriceRule(
    serviceCatalogId,
    {
      ruleCode: input.ruleCode,
      priceCatalogEntryId: input.priceCatalogEntryId,
      priceBasis: input.priceBasis ?? 'UNIT',
      ...(input.serviceVariantId
        ? { serviceVariantId: input.serviceVariantId }
        : {}),
      ...(input.attributeSelector
        ? { attributeSelector: input.attributeSelector }
        : {}),
    },
    adminId,
  );
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

async function patchItem(
  requestId: string,
  itemId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await api()
    .patch(`${V1}/handyman/requests/${requestId}/items/${itemId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body);
  return { status: response.status, body: response.body as Record<string, never> };
}

async function prepareQuotation(
  requestId: string,
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await api()
    .post(`${V1}/handyman/requests/${requestId}/quotation/prepare`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});
  return { status: response.status, body: response.body as Record<string, never> };
}

async function reviseQuotation(
  requestId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await api()
    .post(`${V1}/handyman/requests/${requestId}/quotation/revision`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body);
  return { status: response.status, body: response.body as Record<string, never> };
}

type Resolution = {
  outcome: string;
  reasonCode: string;
  priceCatalogEntryId: string | null;
  currency: string | null;
  unitAmount: number | null;
  quantity: number | null;
  priceBasis: string | null;
  computedTotal: number | null;
  requestItemId: string | null;
};

type ItemView = {
  id: string;
  quantity: number;
  attributeValues: Record<string, string>;
  inheritedAttributeValues: Record<string, string>;
  accessCondition: string;
};

type QuotationVersion = {
  id: string;
  versionNumber: number;
  status: string;
};

/* ------------------------------------------------------------------ */
/* 1/2/3/4/5/10. Variant selection -> item -> tier -> quotation        */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 03 — variant selection to quotation', () => {
  it('inherits the variant configuration and prices the matching tier', async () => {
    const realm = await realmFixture('VariantInherit');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const capacityId = await attributeIdFor(
      realm.clientId,
      installId,
      'AC_CAPACITY',
    );
    const typeId = await attributeIdFor(realm.clientId, installId, 'AC_TYPE');
    const driveId = await attributeIdFor(
      realm.clientId,
      installId,
      'AC_DRIVE_TYPE',
    );

    // Two catalogue variants: 0.5 PK non-inverter and 1.5 PK inverter.
    const smallVariant = await createVariant(
      realm.clientId,
      installId,
      'AC_05_NON_INVERTER',
    );
    await configureVariant(realm.clientId, smallVariant, capacityId, {
      number: 0.5,
    });
    await configureVariant(realm.clientId, smallVariant, typeId, {
      text: 'SPLIT',
    });
    await configureVariant(realm.clientId, smallVariant, driveId, {
      text: 'NON_INVERTER',
    });

    const bigVariant = await createVariant(
      realm.clientId,
      installId,
      'AC_15_INVERTER',
    );
    await configureVariant(realm.clientId, bigVariant, capacityId, {
      number: 1.5,
    });
    await configureVariant(realm.clientId, bigVariant, typeId, {
      text: 'SPLIT',
    });
    await configureVariant(realm.clientId, bigVariant, driveId, {
      text: 'INVERTER',
    });

    // The price tiers of the two variants (each fact carries its own tier).
    const smallPrice = await servicePrice(realm.clientId, installId, 650_000, {
      priceKey: 'AC_INSTALL_05_NON_INVERTER',
    });
    const bigPrice = await servicePrice(realm.clientId, installId, 900_000, {
      priceKey: 'AC_INSTALL_15_INVERTER',
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_05_NON_INVERTER',
      priceCatalogEntryId: smallPrice,
      serviceVariantId: smallVariant,
      attributeSelector: {
        AC_CAPACITY: '0.5',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'NON_INVERTER',
      },
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_15_INVERTER',
      priceCatalogEntryId: bigPrice,
      serviceVariantId: bigVariant,
      attributeSelector: {
        AC_CAPACITY: '1.5',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'INVERTER',
      },
    });

    const requestId = await requestFixture(realm);

    // 1. AC 0.5 PK non-inverter x 2.
    const small = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: smallVariant,
      quantity: 2,
    });
    assert.equal(small.status, 201, JSON.stringify(small.body));
    const smallItem = small.body.data as ItemView;
    // The variant's configuration is INHERITED, deterministically.
    assert.deepEqual(smallItem.attributeValues, {
      AC_CAPACITY: '0.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'NON_INVERTER',
    });
    assert.deepEqual(smallItem.inheritedAttributeValues, {
      AC_CAPACITY: '0.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'NON_INVERTER',
    });

    // 2. AC 1.5 PK inverter x 1.
    const big = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: bigVariant,
      quantity: 1,
    });
    assert.equal(big.status, 201, JSON.stringify(big.body));
    const bigItem = big.body.data as ItemView;
    assert.deepEqual(bigItem.attributeValues, {
      AC_CAPACITY: '1.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
    });
    assert.deepEqual(bigItem.inheritedAttributeValues, {
      AC_CAPACITY: '1.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
    });

    // 3. Both AC kinds in ONE request.
    const listed = await api()
      .get(`${V1}/handyman/requests/${requestId}/items`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(listed.status, 200);
    assert.equal((listed.body.data as unknown[]).length, 2);

    // 4. The initial quotation selects the MATCHING tier per variant.
    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY', JSON.stringify(prepared.body));
    const resolutions = prepared.body.data.resolutions as Resolution[];
    assert.equal(resolutions.length, 2);
    const byFact = new Map(
      resolutions.map((r) => [r.priceCatalogEntryId, r]),
    );
    assert.ok(byFact.has(smallPrice));
    assert.ok(byFact.has(bigPrice));
    const smallResolution = byFact.get(smallPrice);
    const bigResolution = byFact.get(bigPrice);
    assert.equal(smallResolution?.quantity, 2);
    assert.equal(smallResolution?.unitAmount, 650_000);
    assert.equal(smallResolution?.computedTotal, 1_300_000);
    assert.equal(bigResolution?.quantity, 1);
    assert.equal(bigResolution?.unitAmount, 900_000);
    assert.equal(bigResolution?.computedTotal, 900_000);

    // 10. NO DOUBLE CHARGE: every total is unit x quantity of exactly ONE
    // governed fact, and every item is priced exactly once.
    for (const resolution of resolutions) {
      assert.equal(
        resolution.computedTotal,
        (resolution.unitAmount ?? 0) * resolution.quantity,
      );
      assert.ok((resolution.unitAmount ?? 0) > 0, 'never a zero amount');
    }
    const totals = resolutions.map((r) => r.computedTotal).sort((a, b) => a - b);
    assert.deepEqual(totals, [900_000, 1_300_000]);
    const perItem = await q(
      `SELECT request_item_id, COUNT(*)::int AS count
         FROM handyman_service_quote_resolutions
        WHERE handyman_request_id = $1 AND outcome = 'PRICED'
        GROUP BY request_item_id`,
      [requestId],
    );
    assert.equal(perItem.rows.length, 2);
    for (const row of perItem.rows) assert.equal(row.count, 1);

    // 5. The quantity and the UOM survive the quotation unchanged.
    const version = prepared.body.data.quotationVersion as QuotationVersion;
    assert.equal(version.versionNumber, 1);
    assert.equal(version.status, 'DRAFT');
    const lines = await listHandymanQuotationVersionLines(version.id, adminId);
    assert.equal(lines.length, 2);
    const quantities = lines.map((l) => Number(l.quantity)).sort((a, b) => a - b);
    assert.deepEqual(quantities, [1, 2]);
    const uomIds = new Set(lines.map((l) => l.uomId));
    assert.equal(uomIds.size, 1, 'one UOM for one price basis');
    for (const line of lines) {
      assert.equal(line.currency, 'IDR');
      assert.equal(
        Number(line.finalQuotedUnitAmount),
        Number(line.lineTotal) / Number(line.quantity),
      );
    }
    // The snapshot records WHICH variant produced the values.
    const descriptions = lines.map((l) => l.description);
    assert.ok(
      descriptions.some((d) => d.includes('AC_05_NON_INVERTER')),
      'the line records the selected variant',
    );
    assert.ok(descriptions.some((d) => d.includes('AC_15_INVERTER')));
  });

  it('refuses an explicit attribute that contradicts the selected variant', async () => {
    const realm = await realmFixture('VariantConflict');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const capacityId = await attributeIdFor(
      realm.clientId,
      installId,
      'AC_CAPACITY',
    );
    const variantId = await createVariant(
      realm.clientId,
      installId,
      'AC_15_INVERTER',
    );
    await configureVariant(realm.clientId, variantId, capacityId, {
      number: 1.5,
    });

    const requestId = await requestFixture(realm);
    const contradiction = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: variantId,
      quantity: 1,
      attributeValues: { AC_CAPACITY: '2' },
    });
    assert.equal(contradiction.status, 400);
    assert.equal(
      (contradiction.body.error as { code: string }).code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );
    assert.match(
      (contradiction.body.error as { message: string }).message,
      /AC_CAPACITY/,
    );

    // The item was NOT created — a refused contradiction leaves no trace.
    const items = await q(
      `SELECT COUNT(*)::int AS count FROM handyman_service_request_items
        WHERE handyman_request_id = $1`,
      [requestId],
    );
    assert.equal(items.rows[0].count, 0);

    // The SAME value as the variant is accepted (no contradiction).
    const agreeing = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: variantId,
      quantity: 1,
      attributeValues: { AC_CAPACITY: '1.5' },
    });
    assert.equal(agreeing.status, 201, JSON.stringify(agreeing.body));
  });

  it('refuses an inactive variant and a variant of another Client', async () => {
    const realmA = await realmFixture('VariantScopeA');
    const realmB = await realmFixture('VariantScopeB');
    const installA = await serviceIdFor(realmA.clientId, 'AC_INSTALLATION');
    const installB = await serviceIdFor(realmB.clientId, 'AC_INSTALLATION');

    const foreignVariant = await createVariant(
      realmB.clientId,
      installB,
      'AC_FOREIGN',
    );
    const inactiveVariant = await createVariant(
      realmA.clientId,
      installA,
      'AC_RETIRED',
    );
    await q(
      `UPDATE handyman_service_variants SET status = 'INACTIVE' WHERE id = $1`,
      [inactiveVariant],
    );

    const requestA = await requestFixture(realmA);

    // A variant of ANOTHER Client is refused.
    const crossClient = await addItem(requestA, {
      serviceCatalogId: installA,
      serviceVariantId: foreignVariant,
      quantity: 1,
    });
    assert.equal(crossClient.status, 400);

    // An INACTIVE variant is not available for a new request.
    const inactive = await addItem(requestA, {
      serviceCatalogId: installA,
      serviceVariantId: inactiveVariant,
      quantity: 1,
    });
    assert.equal(inactive.status, 400);
    assert.match(
      (inactive.body.error as { message: string }).message,
      /not ACTIVE/,
    );

    const items = await q(
      `SELECT COUNT(*)::int AS count FROM handyman_service_request_items
        WHERE handyman_request_id = $1`,
      [requestA],
    );
    assert.equal(items.rows[0].count, 0);
  });

  it('routes an UNKNOWN size and an unknown attribute to manual review, never a price', async () => {
    const realm = await realmFixture('VariantUnknown');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');

    // A variant whose size is valid but has NO governed price tier.
    const untieredVariant = await createAcVariant(
      realm.clientId,
      installId,
      'AC_03_UNTIERED',
      { capacity: 3, type: 'SPLIT', drive: 'INVERTER' },
    );

    const knownPrice = await servicePrice(realm.clientId, installId, 650_000, {
      priceKey: 'AC_INSTALL_05_NON_INVERTER',
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_05_NON_INVERTER',
      priceCatalogEntryId: knownPrice,
      attributeSelector: { AC_CAPACITY: '0.5' },
    });

    const requestId = await requestFixture(realm);

    // A priced item ...
    const priced = await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: {
        AC_CAPACITY: '0.5',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'INVERTER',
      },
    });
    assert.equal(priced.status, 201, JSON.stringify(priced.body));

    // ... an UNKNOWN (unconfigured) size ...
    const unknown = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: untieredVariant,
      quantity: 1,
    });
    assert.equal(unknown.status, 201, JSON.stringify(unknown.body));

    // ... and an unknown attribute code.
    const unknownAttribute = await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: { AC_ODD_SIZE: '3' },
    });
    assert.equal(unknownAttribute.status, 201);

    // The unknown facts reach the engine, which refuses to price them:
    // the unknown ATTRIBUTE demands an inspection, the untiered size
    // demands a manual review. Neither produces an amount.
    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'INSPECTION_REQUIRED');
    assert.equal(prepared.body.data.quotation, null, 'no partial quotation');
    const resolutions = prepared.body.data.resolutions as Resolution[];
    assert.equal(resolutions.length, 3);
    const pricedOne = resolutions.find((r) => r.outcome === 'PRICED');
    assert.equal(pricedOne?.unitAmount, 650_000);
    const refused = resolutions.filter((r) => r.outcome !== 'PRICED');
    assert.equal(refused.length, 2);
    for (const resolution of refused) {
      assert.equal(resolution.unitAmount, null, 'never a fictitious amount');
      assert.equal(resolution.computedTotal, null);
      assert.equal(resolution.priceCatalogEntryId, null);
    }
    const reasons = refused.map((r) => r.reasonCode).sort();
    assert.deepEqual(reasons, ['ATTRIBUTE_UNKNOWN', 'PRICE_RULE_NOT_FOUND']);
    const outcomes = refused.map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ['INSPECTION_REQUIRED', 'MANUAL_REVIEW']);
  });
});

/* ------------------------------------------------------------------ */
/* The variant lifecycle on an EXISTING item                          */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 03 — variant lifecycle on an item', () => {
  it('re-applies the configuration when the variant is re-selected', async () => {
    const realm = await realmFixture('VariantReselect');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const firstVariant = await createAcVariant(
      realm.clientId,
      installId,
      'AC_05_NON_INVERTER',
      { capacity: 0.5, type: 'SPLIT', drive: 'NON_INVERTER' },
    );
    const secondVariant = await createAcVariant(
      realm.clientId,
      installId,
      'AC_15_INVERTER',
      { capacity: 1.5, type: 'SPLIT', drive: 'INVERTER' },
    );

    const requestId = await requestFixture(realm);
    const item = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: firstVariant,
      quantity: 1,
    });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    const itemId = (item.body.data as ItemView).id;
    assert.equal(
      (item.body.data as ItemView).attributeValues.AC_CAPACITY,
      '0.5',
    );

    // Re-selecting the other variant re-applies ITS configuration.
    const reselected = await patchItem(requestId, itemId, {
      serviceVariantId: secondVariant,
    });
    assert.equal(reselected.status, 200, JSON.stringify(reselected.body));
    const reselectedItem = reselected.body.data as ItemView;
    assert.deepEqual(reselectedItem.attributeValues, {
      AC_CAPACITY: '1.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
    });
    assert.deepEqual(reselectedItem.inheritedAttributeValues, {
      AC_CAPACITY: '1.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
    });

    // A re-selection that CONTRADICTS the new variant is refused and the
    // item keeps the values it had.
    const contradiction = await patchItem(requestId, itemId, {
      serviceVariantId: firstVariant,
      attributeValues: { AC_CAPACITY: '1.5' },
    });
    assert.equal(contradiction.status, 400);
    assert.match(
      (contradiction.body.error as { message: string }).message,
      /AC_CAPACITY/,
    );
    const unchanged = await api()
      .get(`${V1}/handyman/requests/${requestId}/items`)
      .set('Authorization', `Bearer ${adminToken}`);
    const stillThere = (unchanged.body.data as ItemView[])[0];
    assert.equal(stillThere.attributeValues.AC_CAPACITY, '1.5');
  });

  it('drops the inherited values when the variant is detached', async () => {
    const realm = await realmFixture('VariantDetach');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const variantId = await createAcVariant(
      realm.clientId,
      installId,
      'AC_05_NON_INVERTER',
      { capacity: 0.5, type: 'SPLIT', drive: 'NON_INVERTER' },
    );

    const requestId = await requestFixture(realm);
    const item = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: variantId,
      quantity: 1,
      attributeValues: { AC_TYPE: 'SPLIT' },
    });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    const itemId = (item.body.data as ItemView).id;

    const detached = await patchItem(requestId, itemId, {
      serviceVariantId: null,
    });
    assert.equal(detached.status, 200, JSON.stringify(detached.body));
    const detachedItem = detached.body.data as ItemView;
    assert.deepEqual(detachedItem.inheritedAttributeValues, {});
    assert.deepEqual(
      detachedItem.attributeValues,
      { AC_TYPE: 'SPLIT' },
      'only the item\'s own values survive the detach',
    );
  });

  it('never inherits a RETIRED variant choice', async () => {
    const realm = await realmFixture('VariantRetiredChoice');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const capacityId = await attributeIdFor(
      realm.clientId,
      installId,
      'AC_CAPACITY',
    );
    const variantId = await createVariant(
      realm.clientId,
      installId,
      'AC_05_NON_INVERTER',
    );
    await configureVariant(realm.clientId, variantId, capacityId, {
      number: 0.5,
    });
    await configureVariant(
      realm.clientId,
      variantId,
      await attributeIdFor(realm.clientId, installId, 'AC_TYPE'),
      { text: 'SPLIT' },
    );
    // The TYPE choice is retired (the PART 02 lifecycle).
    await q(
      `UPDATE handyman_service_variant_attributes
          SET status = 'INACTIVE', deactivated_at = NOW(),
              deactivated_by_user_id = $3
        WHERE service_variant_id = $1 AND attribute_id = $2`,
      [
        variantId,
        await attributeIdFor(realm.clientId, installId, 'AC_TYPE'),
        adminId,
      ],
    );

    const requestId = await requestFixture(realm);
    const item = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: variantId,
      quantity: 1,
    });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    const created = item.body.data as ItemView;
    assert.deepEqual(created.attributeValues, { AC_CAPACITY: '0.5' });
    assert.deepEqual(created.inheritedAttributeValues, { AC_CAPACITY: '0.5' });
  });
});

/* ------------------------------------------------------------------ */
/* 8/9/10. Inspection, revision, approval                             */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 03 — inspection, revision, approval', () => {
  it('drives a quotation REVISION when the inspected attribute changes', async () => {
    const realm = await realmFixture('VariantRevision');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const capacityId = await attributeIdFor(
      realm.clientId,
      installId,
      'AC_CAPACITY',
    );
    // The variant configures the size and the compressor; the TYPE is the
    // item's own fact.
    const variantId = await createVariant(
      realm.clientId,
      installId,
      'AC_05_NON_INVERTER',
    );
    await configureVariant(realm.clientId, variantId, capacityId, {
      number: 0.5,
    });
    await configureVariant(
      realm.clientId,
      variantId,
      await attributeIdFor(realm.clientId, installId, 'AC_DRIVE_TYPE'),
      { text: 'INVERTER' },
    );

    const smallPrice = await servicePrice(realm.clientId, installId, 650_000, {
      priceKey: 'AC_INSTALL_05_NON_INVERTER',
    });
    const bigPrice = await servicePrice(realm.clientId, installId, 900_000, {
      priceKey: 'AC_INSTALL_15_INVERTER',
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_05_NON_INVERTER',
      priceCatalogEntryId: smallPrice,
      attributeSelector: { AC_CAPACITY: '0.5' },
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_15_INVERTER',
      priceCatalogEntryId: bigPrice,
      attributeSelector: { AC_CAPACITY: '1.5' },
    });

    const requestId = await requestFixture(realm, { withInspection: true });
    const item = await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: variantId,
      quantity: 1,
      attributeValues: { AC_TYPE: 'SPLIT' },
    });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    const itemId = (item.body.data as ItemView).id;

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY', JSON.stringify(prepared.body));
    const firstVersion = prepared.body.data.quotationVersion as QuotationVersion;
    assert.equal(firstVersion.versionNumber, 1);
    const firstLines = await listHandymanQuotationVersionLines(
      firstVersion.id,
      adminId,
    );
    assert.equal(Number(firstLines[0].finalQuotedUnitAmount), 650_000);

    // The inspection found a 1.5 PK unit: the item is CORRECTED.
    const corrected = await patchItem(requestId, itemId, {
      attributeValues: { AC_CAPACITY: '1.5' },
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
    const correctedItem = corrected.body.data as ItemView;
    assert.equal(correctedItem.attributeValues.AC_CAPACITY, '1.5');
    assert.equal(
      correctedItem.inheritedAttributeValues.AC_CAPACITY,
      undefined,
      'a corrected value leaves the inherited set',
    );
    // The correction MERGES over the item's own values — the own value
    // stated at intake is not lost.
    assert.equal(correctedItem.attributeValues.AC_TYPE, 'SPLIT');
    assert.equal(
      correctedItem.inheritedAttributeValues.AC_DRIVE_TYPE,
      'INVERTER',
      'an untouched inherited value stays inherited',
    );

    // The correction drives a REVISION through the existing lifecycle.
    const revised = await reviseQuotation(requestId, {
      validUntil: VALID_UNTIL(),
      issue: true,
    });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.data.status, 'READY');
    const revisionVersion = revised.body.data.quotationVersion as QuotationVersion;
    assert.equal(revisionVersion.versionNumber, 2);
    assert.equal(revisionVersion.status, 'ISSUED');
    const secondLines = await listHandymanQuotationVersionLines(
      revisionVersion.id,
      adminId,
    );
    assert.equal(Number(secondLines[0].finalQuotedUnitAmount), 900_000);
    assert.equal(Number(secondLines[0].lineTotal), 900_000);
    assert.equal(Number(secondLines[0].quantity), 1, 'the quantity is unchanged');

    // The FIRST version is untouched — a revision never edits an issued
    // version.
    const firstLinesAgain = await listHandymanQuotationVersionLines(
      firstVersion.id,
      adminId,
    );
    assert.equal(Number(firstLinesAgain[0].finalQuotedUnitAmount), 650_000);

    // 10. NO AUTOMATIC APPROVAL: the revised version is issued, but no
    // customer decision exists yet.
    const decisions = await q(
      `SELECT COUNT(*)::int AS count FROM handyman_quotation_decisions
        WHERE quotation_version_id = $1`,
      [revisionVersion.id],
    );
    assert.equal(decisions.rows[0].count, 0);

    // The customer approval still decides it (the EXISTING authority).
    const decision = await decideHandymanQuotation(
      revisionVersion.id,
      { decision: 'APPROVE', idempotencyKey: `idem-${randomUUID()}` },
      realm.picUserId,
    );
    assert.ok(decision, 'the customer approval is recorded');
  });

  it('leaves an approved quotation untouched when the catalogue changes', async () => {
    const realm = await realmFixture('VariantApproved');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const capacityId = await attributeIdFor(
      realm.clientId,
      installId,
      'AC_CAPACITY',
    );
    const variantId = await createAcVariant(
      realm.clientId,
      installId,
      'AC_05_NON_INVERTER',
      { capacity: 0.5, type: 'SPLIT', drive: 'INVERTER' },
    );
    const smallPrice = await servicePrice(realm.clientId, installId, 650_000, {
      priceKey: 'AC_INSTALL_05_NON_INVERTER',
    });
    await priceRule(installId, {
      ruleCode: 'AC_INSTALL_05_NON_INVERTER',
      priceCatalogEntryId: smallPrice,
      attributeSelector: { AC_CAPACITY: '0.5' },
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      serviceVariantId: variantId,
      quantity: 2,
    });
    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY', JSON.stringify(prepared.body));
    const version = prepared.body.data.quotationVersion as QuotationVersion;

    // The EXISTING lifecycle issues and the customer approves the version.
    const issued = await issueHandymanQuotationVersion(
      version.id,
      { validUntil: VALID_UNTIL() },
      adminId,
    );
    assert.equal(issued.status, 'ISSUED');
    const decision = await decideHandymanQuotation(
      version.id,
      { decision: 'APPROVE', idempotencyKey: `idem-${randomUUID()}` },
      realm.picUserId,
    );
    assert.ok(decision, 'the customer approval is recorded');

    // The catalogue changes AFTER the approval: the variant is re-pointed
    // at another size and the price fact is deactivated.
    await q(
      `UPDATE handyman_service_variant_attributes
          SET value_number = 2, updated_at = NOW()
        WHERE service_variant_id = $1 AND attribute_id = $2`,
      [variantId, capacityId],
    );
    await priceCatalogEntryService.deactivatePriceCatalogEntry(
      smallPrice,
      adminId,
    );

    // The approved quotation and its line are UNCHANGED.
    const lines = await listHandymanQuotationVersionLines(version.id, adminId);
    assert.equal(lines.length, 1);
    assert.equal(Number(lines[0].finalQuotedUnitAmount), 650_000);
    assert.equal(Number(lines[0].lineTotal), 1_300_000);
    assert.equal(Number(lines[0].quantity), 2);

    // The recorded price snapshot is append-only and still carries the
    // fact that was priced.
    const snapshot = await q(
      `SELECT unit_amount, computed_total, price_catalog_entry_id
         FROM handyman_service_quote_resolutions
        WHERE handyman_request_id = $1 AND outcome = 'PRICED'`,
      [requestId],
    );
    assert.equal(snapshot.rows.length, 1);
    assert.equal(Number(snapshot.rows[0].unit_amount), 650_000);
    assert.equal(Number(snapshot.rows[0].computed_total), 1_300_000);
    assert.equal(snapshot.rows[0].price_catalog_entry_id, smallPrice);

    // The ITEM is not rewritten by the catalogue change either.
    const itemRow = await q(
      `SELECT attribute_values, inherited_attribute_values
         FROM handyman_service_request_items
        WHERE handyman_request_id = $1`,
      [requestId],
    );
    assert.equal(itemRow.rows.length, 1);
    assert.deepEqual(itemRow.rows[0].attribute_values, {
      AC_CAPACITY: '0.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
    });
    assert.deepEqual(itemRow.rows[0].inherited_attribute_values, {
      AC_CAPACITY: '0.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
    });
  });

  it('never produces a zero price', async () => {
    const realm = await realmFixture('VariantZero');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');

    // The price authority itself refuses a zero amount ...
    const refused = await api()
      .post(`${V1}/price-catalog/entries`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: realm.clientId,
        sourceMode: 'SERVICE',
        serviceId: installId,
        servicePriceKey: 'AC_INSTALL_ZERO',
        currency: 'IDR',
        unitPrice: 0,
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        idempotencyKey: `pk-${randomUUID()}`,
      });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));

    // ... and the DATABASE refuses it as well (defence in depth): the
    // governed price fact can never carry a zero amount.
    const constraint = await q(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'price_catalog_entries_unit_price_check'`,
    );
    assert.equal(constraint.rows.length, 1);
    assert.match(
      constraint.rows[0].definition,
      /unit_price > \(0\)::numeric/,
      'the governed price fact can never carry a zero amount',
    );

    // A governed quotation therefore never carries a zero line.
    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: {
        AC_CAPACITY: '1',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'INVERTER',
      },
    });
    const prepared = await prepareQuotation(requestId);
    // No price fact exists at all -> the engine fails closed.
    assert.equal(prepared.body.data.status, 'MANUAL_REVIEW');
    assert.equal(prepared.body.data.quotation, null);
    const resolutions = prepared.body.data.resolutions as Resolution[];
    assert.equal(resolutions[0].reasonCode, 'PRICE_RULE_NOT_FOUND');
    assert.equal(resolutions[0].unitAmount, null);
    assert.equal(resolutions[0].computedTotal, null);
  });
});

// E2E CATALOG & INSPECTION PART02 — reuse the real PR60 fixtures/engines.
describe('E2E PART02 — inspection-first cannot be bypassed through manual quotations', () => {
  const needsInspection = (error: unknown) => {
    assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
    assert.match((error as Error).message, /inspection/i);
    return true;
  };
  async function manualLine(realm: Realm, versionId: string, type: 'LABOR' | 'MATERIAL' = 'LABOR', amount = 100) {
    const uomId = (await q('SELECT id FROM units_of_measure WHERE client_id=$1 LIMIT 1', [realm.clientId])).rows[0].id;
    return addHandymanQuotationLine(versionId, { lineType: type, description: `Inspected ${type} scope`,
      quantity: 1, uomId, currency: 'IDR', finalQuotedUnitAmount: amount }, adminId);
  }
  for (const mode of ['FIXED', 'ESTIMATED']) it(`${mode} supports a final quotation without any inspection`, async () => {
    const realm = await realmFixture(`P02${mode}`);
    const serviceCatalogId = (await q(`SELECT service_catalog_id FROM handyman_service_commercial_profiles
      WHERE client_id=$1 AND pricing_mode=$2 ORDER BY service_catalog_id LIMIT 1`, [realm.clientId, mode])).rows[0].service_catalog_id;
    const requestId = await requestFixture(realm, { serviceCatalogId });
    const quote = await createHandymanQuotation({ handymanRequestId: requestId }, adminId);
    await manualLine(realm, quote.versions[0].id);
    await issueHandymanQuotationVersion(quote.versions[0].id, { validUntil: VALID_UNTIL() }, adminId);
    assert.equal((await decideHandymanQuotation(quote.versions[0].id, { decision: 'APPROVE', idempotencyKey: id() }, realm.picUserId)).decision, 'APPROVE');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_request_inspections WHERE handyman_request_id=$1', [requestId])).rows[0].n, 0);
  });
  it('requires a completed inspection for the primary INSPECTION_FIRST service even without catalog items', async () => {
    const realm = await realmFixture('P02Primary');
    const serviceCatalogId = await serviceIdFor(realm.clientId, 'ELECTRICAL_DIAGNOSIS');
    const requestId = await requestFixture(realm, { serviceCatalogId });
    await assert.rejects(createHandymanQuotation({ handymanRequestId: requestId }, adminId), needsInspection);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotations WHERE handyman_request_id=$1', [requestId])).rows[0].n, 0);
    // A malformed legacy row cannot borrow another Building's inspection.
    // The original FK binds request + Client, not the inspection Building.
    const other = await realmFixture('P02ForeignInspection');
    await q(`INSERT INTO handyman_request_inspections
      (id,client_id,handyman_request_id,channel_attribution_id,building_id,inspection_result,inspection_notes,inspected_by_user_id)
      SELECT $2,client_id,id,channel_attribution_id,$3,'INSPECTED','Wrong Building — must not unlock quoting',$4
      FROM handyman_service_requests WHERE id=$1`, [requestId, id(), other.buildingId, adminId]);
    await assert.rejects(createHandymanQuotation({ handymanRequestId: requestId }, adminId), needsInspection);
  });
  it('requires inspection for an INSPECTION_FIRST service in mixed active items, not just the primary service', async () => {
    const realm = await realmFixture('P02Mixed'), requestId = await requestFixture(realm);
    assert.equal((await addItem(requestId, { serviceCatalogId: await serviceIdFor(realm.clientId, 'LOCK_ACCESS_INTERCOM'), quantity: 1 })).status, 201);
    await assert.rejects(createHandymanQuotation({ handymanRequestId: requestId }, adminId), needsInspection);
  });
  it('NOT_INSPECTABLE is not a completed inspection and cannot authorize a final inspection-first quote', async () => {
    const realm = await realmFixture('P02Unavailable');
    const requestId = await requestFixture(realm, { serviceCatalogId: await serviceIdFor(realm.clientId, 'ELECTRICAL_DIAGNOSIS'),
      withInspection: true, inspectionResult: 'NOT_INSPECTABLE' });
    await assert.rejects(createHandymanQuotation({ handymanRequestId: requestId }, adminId), needsInspection);
  });
  it('rechecks the catalog requirement at issuance when items changed after draft preparation', async () => {
    const realm = await realmFixture('P02Issue'), requestId = await requestFixture(realm);
    const draft = await createHandymanQuotation({ handymanRequestId: requestId }, adminId);
    await manualLine(realm, draft.versions[0].id);
    assert.equal((await addItem(requestId, { serviceCatalogId: await serviceIdFor(realm.clientId, 'ELECTRICAL_DIAGNOSIS'), quantity: 1 })).status, 201);
    await assert.rejects(issueHandymanQuotationVersion(draft.versions[0].id, { validUntil: VALID_UNTIL() }, adminId), needsInspection);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [draft.versions[0].id])).rows[0].status, 'DRAFT');
  });
  it('rechecks before a new customer approval but preserves rejection and exact historical replay', async () => {
    const realm = await realmFixture('P02Decision'), requestId = await requestFixture(realm);
    const draft = await createHandymanQuotation({ handymanRequestId: requestId }, adminId);
    await manualLine(realm, draft.versions[0].id);
    await issueHandymanQuotationVersion(draft.versions[0].id, { validUntil: VALID_UNTIL() }, adminId);
    assert.equal((await addItem(requestId, { serviceCatalogId: await serviceIdFor(realm.clientId, 'ELECTRICAL_DIAGNOSIS'), quantity: 1 })).status, 201);
    await assert.rejects(decideHandymanQuotation(draft.versions[0].id, { decision: 'APPROVE', idempotencyKey: id() }, realm.picUserId), needsInspection);
    const input = { decision: 'REJECT' as const, idempotencyKey: id() };
    const rejected = await decideHandymanQuotation(draft.versions[0].id, input, realm.picUserId);
    assert.equal((await decideHandymanQuotation(draft.versions[0].id, input, realm.picUserId)).id, rejected.id);
  });
  it('completed inspection-first pricing hands off to manual quotation, never a guessed price or another inspection', async () => {
    const realm = await realmFixture('P02ManualHandoff');
    const serviceCatalogId = await serviceIdFor(realm.clientId, 'ELECTRICAL_DIAGNOSIS');
    const requestId = await requestFixture(realm, { serviceCatalogId, withInspection: true });
    assert.equal((await addItem(requestId, { serviceCatalogId, quantity: 1,
      attributeValues: { ELECTRICAL_DIAGNOSIS_SYMPTOM: 'NO_POWER' } })).status, 201);
    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.data.status, 'MANUAL_REVIEW');
    assert.equal(prepared.body.data.quotation, null);
    assert.equal(prepared.body.data.resolutions[0].unitAmount, null);
    assert.match(prepared.body.data.resolutions[0].reasonDetail, /Inspection completed/);
  });
  it('the catalog post-inspection revision lane rejects NOT_INSPECTABLE without appending versions', async () => {
    const realm = await realmFixture('P02NoRevision');
    const requestId = await requestFixture(realm, { withInspection: true, inspectionResult: 'NOT_INSPECTABLE' });
    const quote = await createHandymanQuotation({ handymanRequestId: requestId }, adminId);
    const revised = await reviseQuotation(requestId);
    assert.equal(revised.status, 400, JSON.stringify(revised.body));
    assert.match(revised.body.error.message, /INSPECTED/);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_versions WHERE quotation_id=$1', [quote.quotation.id])).rows[0].n, 1);
  });
  it('after INSPECTED uses the existing manual labor/material revision and explicit customer approval', async () => {
    const realm = await realmFixture('P02Inspected');
    const serviceCatalogId = await serviceIdFor(realm.clientId, 'ELECTRICAL_DIAGNOSIS');
    const requestId = await requestFixture(realm, { serviceCatalogId, withInspection: true });
    const first = await createHandymanQuotation({ handymanRequestId: requestId }, adminId);
    await manualLine(realm, first.versions[0].id);
    await issueHandymanQuotationVersion(first.versions[0].id, { validUntil: VALID_UNTIL() }, adminId);
    const revision = await createHandymanQuotationRevision(first.quotation.id, adminId);
    await manualLine(realm, revision.id, 'LABOR', 150);
    await manualLine(realm, revision.id, 'MATERIAL', 50);
    await issueHandymanQuotationVersion(revision.id, { validUntil: VALID_UNTIL() }, adminId);
    const history = await q('SELECT id,status FROM handyman_quotation_versions WHERE quotation_id=$1 ORDER BY version_number', [first.quotation.id]);
    assert.deepEqual(history.rows.map(r=>r.status), ['SUPERSEDED', 'ISSUED']);
    assert.equal(Number((await listHandymanQuotationVersionLines(first.versions[0].id, adminId))[0].lineTotal), 100);
    assert.equal((await listHandymanQuotationVersionLines(revision.id, adminId)).reduce((n,l)=>n+Number(l.lineTotal),0), 200);
    await assert.rejects(decideHandymanQuotation(first.versions[0].id, { decision: 'APPROVE', idempotencyKey: id() }, realm.picUserId));
    assert.equal((await decideHandymanQuotation(revision.id, { decision: 'APPROVE', idempotencyKey: id() }, realm.picUserId)).decision, 'APPROVE');
  });
});
