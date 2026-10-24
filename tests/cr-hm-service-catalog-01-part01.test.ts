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
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Parameterized Catalog Backend.
 *
 * Focused acceptance suite. Every mandatory scenario of the CR is proven
 * against a DISPOSABLE PostgreSQL (embedded, unique port, removed after
 * the run):
 *
 *   1. mixed AC capacity in ONE Service Request (several sizes at once);
 *   2. inverter / non-inverter selection through the attribute selector;
 *   3. quantity tiers (narrower band wins);
 *   4. unknown attributes -> inspection, never a price;
 *   5. fixed vs inspection-first commercial posture;
 *   6. quotation revision after an inspection + the EXISTING customer
 *      approval;
 *   7. price snapshot (the recorded fact never moves);
 *   8. duplicate starter import (idempotent, never overwriting);
 *   9. missing pricing -> manual review, never a price;
 *  10. 401 / 403 (unauthenticated, no permission, wrong building);
 *  11. cross-client isolation.
 */

const DIR = '/tmp/cr-hm-service-catalog-01-part01-pg';
const PORT = 55621;

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

/**
 * A Client with a Building, a tenant scope, a channel attribution and the
 * 24-service starter catalogue imported.
 */
async function realmFixture(label: string): Promise<Realm> {
  const client = await (await import('../src/modules/clients')).clientService.createClient({
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
  const attribution = await createChannelAttribution({
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
  assert.equal(starter.services.created, 24, 'the starter imports 24 services');
  assert.equal(starter.categories.created, 8, 'the starter imports 8 categories');

  return {
    clientId: client.id,
    buildingId: building.id,
    spaceId: space.id,
    picUserId: picUser.id,
    ...({ attributionId: attribution.id } as Record<string, never>),
  } as Realm;
}

/** A triaged + diagnosed Handyman Service Request (quotation-ready). */
async function requestFixture(
  realm: Realm,
  options: { withInspection?: boolean } = {},
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
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Two split units inspected.',
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

/** The `service_catalog` id of a starter service code. */
async function serviceIdFor(
  clientId: string,
  code: string,
): Promise<string> {
  const row = await q(
    `SELECT id FROM service_catalog WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  assert.ok(row.rows[0], `starter service ${code} must exist`);
  return row.rows[0].id as string;
}

/**
 * An ACTIVE governed SERVICE price for one catalogue service — the EXISTING
 * price authority, not a new one.
 */
async function servicePrice(
  clientId: string,
  serviceCatalogId: string,
  unitPrice: number,
  options: {
    buildingId?: string | null;
    effectiveFrom?: string;
    /** CR-HM-SERVICE-CATALOG-01 — the catalogue PRICE TIER of the fact. */
    priceKey?: string;
  } = {},
): Promise<string> {
  const entry = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      buildingId: options.buildingId ?? null,
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

/** A price rule through the ADMIN SERVICE (the governed write path). */
async function priceRule(
  clientId: string,
  serviceCatalogId: string,
  input: {
    ruleCode: string;
    priceCatalogEntryId: string;
    priceBasis: 'UNIT' | 'POINT' | 'METER' | 'SQM' | 'VISIT';
    attributeSelector?: Record<string, string>;
    minQuantity?: number;
    maxQuantity?: number;
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
      priceBasis: input.priceBasis,
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
}

/** Add a mixed request item through the HTTP surface. */
async function addItem(
  requestId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await api()
    .post(`${V1}/handyman/requests/${requestId}/items`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body);
  return {
    status: response.status,
    body: response.body as Record<string, never>,
  };
}

async function prepareQuotation(
  requestId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await api()
    .post(`${V1}/handyman/requests/${requestId}/quotation/prepare`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body);
  return {
    status: response.status,
    body: response.body as Record<string, never>,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Starter import: idempotent, never overwriting                    */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — starter import', () => {
  it('imports 24 services in 8 categories and is idempotent without overwriting', async () => {
    const realm = await realmFixture('Starter');
    const serviceId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');

    // Rename the imported service: a later import must NOT overwrite it.
    await q(
      `UPDATE service_catalog SET name = 'Locally renamed AC' WHERE id = $1`,
      [serviceId],
    );

    const second = await importHandymanServiceCatalogStarter(
      realm.clientId,
      adminId,
    );
    assert.equal(second.services.created, 0, 'no service is created twice');
    assert.equal(second.services.skipped, 24, 'every service is skipped');
    assert.equal(second.categories.created, 0);
    assert.equal(second.attributes.created, 0);
    assert.equal(second.commercialProfiles.created, 0);
    assert.equal(second.unitsOfMeasure.created, 0);

    const renamed = await q(
      `SELECT name FROM service_catalog WHERE id = $1`,
      [serviceId],
    );
    assert.equal(
      renamed.rows[0].name,
      'Locally renamed AC',
      'the import never overwrites existing data',
    );

    // The audit fact exists exactly once per import run.
    const events = await q(
      `SELECT COUNT(*)::int AS count FROM operational_events
        WHERE event_type = 'HANDYMAN_SERVICE_CATALOG_STARTER_IMPORTED'
          AND client_id = $1`,
      [realm.clientId],
    );
    assert.equal(events.rows[0].count, 2, 'one audit event per import run');

    // The five quantity UOMs of the price bases exist for the Client.
    const uoms = await q(
      `SELECT code FROM units_of_measure WHERE client_id = $1
         AND code IN ('HM_UNIT','HM_POINT','HM_METER','HM_SQM','HM_VISIT')`,
      [realm.clientId],
    );
    assert.equal(uoms.rows.length, 5);

    // The five price bases are all representable.
    const bases = await q(
      `SELECT DISTINCT price_basis FROM handyman_service_price_rules
        WHERE client_id = $1`,
      [realm.clientId],
    );
    assert.equal(bases.rows.length, 0, 'the starter carries NO price rule');
  });
});

/* ------------------------------------------------------------------ */
/* 2/3/5. Mixed AC, inverter selection, fixed vs inspection-first      */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — mixed AC quotation', () => {
  it('quotes several AC sizes AND types in ONE request', async () => {
    const realm = await realmFixture('Mixed');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const priceEntry = await servicePrice(realm.clientId, installId, 750_000);
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: priceEntry,
      priceBasis: 'UNIT',
    });
    // CR-HM-SERVICE-CATALOG-01 PART 02 — a non-standard access complexity
    // is priced by its OWN governed tier; the standard rule can never
    // price a high-floor or a difficult job.
    const highFloorPrice = await servicePrice(realm.clientId, installId, 900_000, {
      priceKey: 'AC_INSTALL_HIGH_FLOOR',
    });
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_HIGH_FLOOR',
      priceCatalogEntryId: highFloorPrice,
      priceBasis: 'UNIT',
      attributeSelector: { ACCESS_CONDITION: 'HIGH_FLOOR' },
    });
    const difficultPrice = await servicePrice(realm.clientId, installId, 1_050_000, {
      priceKey: 'AC_INSTALL_DIFFICULT',
    });
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_DIFFICULT',
      priceCatalogEntryId: difficultPrice,
      priceBasis: 'UNIT',
      attributeSelector: { ACCESS_CONDITION: 'DIFFICULT' },
    });

    const requestId = await requestFixture(realm);

    // 0.5 PK split, 1.5 PK split, 2 PK cassette — one request.
    const items = [
      {
        serviceCatalogId: installId,
        quantity: 1,
        attributeValues: {
          AC_CAPACITY: '0.5',
          AC_TYPE: 'SPLIT',
          AC_DRIVE_TYPE: 'NON_INVERTER',
        },
        accessCondition: 'STANDARD',
      },
      {
        serviceCatalogId: installId,
        quantity: 2,
        attributeValues: {
          AC_CAPACITY: '1.5',
          AC_TYPE: 'SPLIT',
          AC_DRIVE_TYPE: 'INVERTER',
        },
        accessCondition: 'HIGH_FLOOR',
      },
      {
        serviceCatalogId: installId,
        quantity: 1,
        attributeValues: {
          AC_CAPACITY: '2',
          AC_TYPE: 'CASSETTE',
          AC_DRIVE_TYPE: 'INVERTER',
        },
        accessCondition: 'DIFFICULT',
      },
    ];
    for (const item of items) {
      const created = await addItem(requestId, item);
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }

    const listed = await api()
      .get(`${V1}/handyman/requests/${requestId}/items`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(listed.status, 200);
    assert.equal((listed.body.data as unknown[]).length, 3);

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.data.status, 'READY');
    assert.equal((prepared.body.data.resolutions as unknown[]).length, 3);

    // The quotation is the EXISTING quotation thread (version 1, DRAFT).
    const quotation = prepared.body.data.quotation as {
      id: string;
      versions: { id: string; versionNumber: number; status: string }[];
    };
    assert.equal(quotation.versions.length, 1);
    assert.equal(quotation.versions[0].versionNumber, 1);
    assert.equal(quotation.versions[0].status, 'DRAFT');

    const lines = await listHandymanQuotationVersionLines(
      quotation.versions[0].id,
      adminId,
    );
    assert.equal(lines.length, 3, 'one line per request item');
    const quantities = lines.map((l) => Number(l.quantity)).sort((a, b) => a - b);
    assert.deepEqual(quantities, [1, 1, 2]);
    for (const line of lines) {
      assert.equal(line.currency, 'IDR');
    }
    // Each line carries the governed amount of ITS access tier: the
    // standard job, the high-floor job and the difficult job are priced by
    // three DIFFERENT facts, and no amount is added to another.
    const unitAmounts = lines
      .map((l) => Number(l.finalQuotedUnitAmount))
      .sort((a, b) => a - b);
    assert.deepEqual(unitAmounts, [750_000, 900_000, 1_050_000]);
    const totals = lines
      .map((l) => Number(l.lineTotal))
      .sort((a, b) => a - b);
    assert.deepEqual(totals, [750_000, 1_050_000, 1_800_000]);

    // The snapshot carries the governed price fact and the computed total.
    const resolutions = prepared.body.data.resolutions as {
      outcome: string;
      reasonCode: string;
      unitAmount: number;
      quantity: number;
      computedTotal: number;
      priceBasis: string;
      priceCatalogEntryId: string;
    }[];
    const pricedFacts = new Set([
      priceEntry,
      highFloorPrice,
      difficultPrice,
    ]);
    for (const resolution of resolutions) {
      assert.equal(resolution.outcome, 'PRICED');
      assert.equal(resolution.reasonCode, 'PRICE_RESOLVED');
      assert.ok(
        pricedFacts.has(resolution.priceCatalogEntryId),
        'every line is priced by a governed fact of its own tier',
      );
      assert.equal(resolution.priceBasis, 'UNIT');
      assert.equal(resolution.computedTotal, resolution.unitAmount * resolution.quantity);
    }
    assert.equal(new Set(resolutions.map((r) => r.priceCatalogEntryId)).size, 3);
  });

  it('selects the inverter price only for inverter units', async () => {
    const realm = await realmFixture('Inverter');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const basePrice = await servicePrice(realm.clientId, installId, 750_000);
    const inverterPrice = await servicePrice(realm.clientId, installId, 950_000, {
      priceKey: 'AC_INSTALL_INVERTER',
    });
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: basePrice,
      priceBasis: 'UNIT',
    });
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_INVERTER',
      priceCatalogEntryId: inverterPrice,
      priceBasis: 'UNIT',
      attributeSelector: { AC_DRIVE_TYPE: 'INVERTER' },
    });

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
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: {
        AC_CAPACITY: '1',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'NON_INVERTER',
      },
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY');
    const resolutions = prepared.body.data.resolutions as {
      unitAmount: number;
      priceCatalogEntryId: string;
    }[];
    const amounts = resolutions.map((r) => r.unitAmount).sort((a, b) => a - b);
    assert.deepEqual(amounts, [750_000, 950_000]);
    assert.ok(
      resolutions.some((r) => r.priceCatalogEntryId === inverterPrice),
      'the inverter rule wins for an inverter unit',
    );
  });

  it('honours the quantity tier (the narrower band wins)', async () => {
    const realm = await realmFixture('Tiers');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const singlePrice = await servicePrice(realm.clientId, installId, 750_000);
    const bulkPrice = await servicePrice(realm.clientId, installId, 700_000, {
      priceKey: 'AC_INSTALL_BULK',
    });
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: singlePrice,
      priceBasis: 'UNIT',
    });
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BULK',
      priceCatalogEntryId: bulkPrice,
      priceBasis: 'UNIT',
      minQuantity: 3,
    });

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
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 5,
      attributeValues: {
        AC_CAPACITY: '1',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'INVERTER',
      },
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY');
    const resolutions = prepared.body.data.resolutions as {
      quantity: number;
      unitAmount: number;
    }[];
    const one = resolutions.find((r) => r.quantity === 1);
    const five = resolutions.find((r) => r.quantity === 5);
    assert.equal(one?.unitAmount, 750_000, 'the base rule prices one unit');
    assert.equal(five?.unitAmount, 700_000, 'the bulk band prices five units');
  });

  it('routes an INSPECTION_FIRST service to inspection instead of a price', async () => {
    const realm = await realmFixture('InspectionFirst');
    const diagnosisId = await serviceIdFor(realm.clientId, 'ELECTRICAL_DIAGNOSIS');
    const priceEntry = await servicePrice(realm.clientId, diagnosisId, 150_000);
    await priceRule(realm.clientId, diagnosisId, {
      ruleCode: 'ELEC_DIAGNOSIS_BASE',
      priceCatalogEntryId: priceEntry,
      priceBasis: 'VISIT',
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: diagnosisId,
      quantity: 1,
      attributeValues: { ELECTRICAL_DIAGNOSIS_SYMPTOM: 'NO_POWER' },
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'INSPECTION_REQUIRED');
    assert.equal(prepared.body.data.quotation, null, 'NO quotation is created');
    const resolutions = prepared.body.data.resolutions as {
      outcome: string;
      reasonCode: string;
      unitAmount: number | null;
    }[];
    assert.equal(resolutions[0].reasonCode, 'PRICING_MODE_INSPECTION_FIRST');
    assert.equal(resolutions[0].unitAmount, null, 'NO amount is fabricated');

    const quotations = await q(
      `SELECT COUNT(*)::int AS count FROM handyman_quotations
        WHERE handyman_request_id = $1`,
      [requestId],
    );
    assert.equal(quotations.rows[0].count, 0, 'no quotation thread is created');
  });
});

/* ------------------------------------------------------------------ */
/* 4/9. Unknown attributes and missing pricing                         */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — fail-closed pricing', () => {
  it('refuses to price an unknown attribute and demands an inspection', async () => {
    const realm = await realmFixture('UnknownAttribute');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const priceEntry = await servicePrice(realm.clientId, installId, 750_000);
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: priceEntry,
      priceBasis: 'UNIT',
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: {
        AC_CAPACITY: '1',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'INVERTER',
        AC_UNDECLARED_THING: 'whatever the customer said',
      },
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'INSPECTION_REQUIRED');
    assert.equal(prepared.body.data.quotation, null);
    const resolutions = prepared.body.data.resolutions as {
      reasonCode: string;
      unitAmount: number | null;
      computedTotal: number | null;
    }[];
    assert.equal(resolutions[0].reasonCode, 'ATTRIBUTE_UNKNOWN');
    assert.equal(resolutions[0].unitAmount, null);
    assert.equal(resolutions[0].computedTotal, null);
  });

  it('reports a missing required attribute', async () => {
    const realm = await realmFixture('MissingAttribute');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const priceEntry = await servicePrice(realm.clientId, installId, 750_000);
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: priceEntry,
      priceBasis: 'UNIT',
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 1,
      attributeValues: { AC_TYPE: 'SPLIT' },
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'INSPECTION_REQUIRED');
    const resolutions = prepared.body.data.resolutions as {
      reasonCode: string;
    }[];
    assert.equal(resolutions[0].reasonCode, 'ATTRIBUTE_MISSING');
  });

  it('reports a service that has no price rule as manual review', async () => {
    const realm = await realmFixture('MissingPricing');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
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
    assert.equal(prepared.body.data.status, 'MANUAL_REVIEW');
    assert.equal(prepared.body.data.quotation, null);
    const resolutions = prepared.body.data.resolutions as {
      reasonCode: string;
      unitAmount: number | null;
    }[];
    assert.equal(resolutions[0].reasonCode, 'PRICE_RULE_NOT_FOUND');
    assert.equal(resolutions[0].unitAmount, null);
  });

  it('reports a price fact that is not effective at the requested date', async () => {
    const realm = await realmFixture('EffectiveWindow');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const priceEntry = await servicePrice(realm.clientId, installId, 750_000, {
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: priceEntry,
      priceBasis: 'UNIT',
    });

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

    const prepared = await prepareQuotation(requestId, {
      effectiveDate: '2019-01-01T00:00:00.000Z',
    });
    assert.equal(prepared.body.data.status, 'INSPECTION_REQUIRED');
    const resolutions = prepared.body.data.resolutions as {
      reasonCode: string;
    }[];
    assert.equal(resolutions[0].reasonCode, 'PRICE_NOT_AVAILABLE');
  });
});

/* ------------------------------------------------------------------ */
/* 6/7. Revision after inspection, approval and the price snapshot     */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — revision and snapshot', () => {
  it('revises after an inspection and keeps the customer approval authority', async () => {
    const realm = await realmFixture('Revision');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const priceEntry = await servicePrice(realm.clientId, installId, 750_000);
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: priceEntry,
      priceBasis: 'UNIT',
    });

    const requestId = await requestFixture(realm, { withInspection: true });
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
    assert.equal(prepared.body.data.status, 'READY');
    const first = prepared.body.data.quotationVersion as {
      id: string;
      versionNumber: number;
    };
    assert.equal(first.versionNumber, 1);

    // The inspection changed the scope: one more unit.
    const patched = await api()
      .patch(`${V1}/handyman/requests/${requestId}/items`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(patched.status, 404, 'the collection route is not a patch route');

    const itemId = (
      await q(
        `SELECT id FROM handyman_service_request_items WHERE handyman_request_id = $1`,
        [requestId],
      )
    ).rows[0].id as string;
    const updated = await api()
      .patch(`${V1}/handyman/requests/${requestId}/items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ quantity: 3 });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    // The revision is the EXISTING revision authority (version 2, DRAFT).
    const revision = await api()
      .post(`${V1}/handyman/requests/${requestId}/quotation/revision`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        issue: true,
      });
    assert.equal(revision.status, 200, JSON.stringify(revision.body));
    assert.equal(revision.body.data.status, 'READY');
    const revised = revision.body.data.quotationVersion as {
      id: string;
      versionNumber: number;
      status: string;
    };
    assert.equal(revised.versionNumber, 2);
    assert.equal(revised.status, 'ISSUED');

    const revisedLines = await listHandymanQuotationVersionLines(
      revised.id,
      adminId,
    );
    assert.equal(revisedLines.length, 1);
    assert.equal(Number(revisedLines[0].quantity), 3);
    assert.equal(Number(revisedLines[0].finalQuotedUnitAmount), 750_000);

    // The FIRST version is untouched (immutable, DB-enforced).
    const firstLines = await listHandymanQuotationVersionLines(first.id, adminId);
    assert.equal(Number(firstLines[0].quantity), 1);

    // The customer approval is the EXISTING decision authority.
    const decision = await decideHandymanQuotation(
      revised.id,
      { decision: 'APPROVE', idempotencyKey: `idem-${randomUUID()}` },
      realm.picUserId,
    );
    assert.ok(decision, 'the customer approval is recorded');

    // The snapshot history records BOTH resolutions, append-only.
    const history = await api()
      .get(`${V1}/handyman/requests/${requestId}/price-resolution`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(history.status, 200);
    const resolutions = history.body.data as {
      quantity: number;
      computedTotal: number;
      quotationVersionId: string | null;
    }[];
    assert.equal(resolutions.length, 2);
    const quantities = resolutions.map((r) => r.quantity).sort((a, b) => a - b);
    assert.deepEqual(quantities, [1, 3]);
  });

  it('keeps the recorded price snapshot immutable when the rule changes', async () => {
    const realm = await realmFixture('Snapshot');
    const installId = await serviceIdFor(realm.clientId, 'AC_INSTALLATION');
    const firstPrice = await servicePrice(realm.clientId, installId, 750_000);
    await priceRule(realm.clientId, installId, {
      ruleCode: 'AC_INSTALL_BASE',
      priceCatalogEntryId: firstPrice,
      priceBasis: 'UNIT',
    });

    const requestId = await requestFixture(realm);
    await addItem(requestId, {
      serviceCatalogId: installId,
      quantity: 2,
      attributeValues: {
        AC_CAPACITY: '1',
        AC_TYPE: 'SPLIT',
        AC_DRIVE_TYPE: 'INVERTER',
      },
    });

    const prepared = await prepareQuotation(requestId);
    assert.equal(prepared.body.data.status, 'READY');
    const resolution = (prepared.body.data.resolutions as {
      unitAmount: number;
      computedTotal: number;
    }[])[0];
    assert.equal(resolution.unitAmount, 750_000);
    assert.equal(resolution.computedTotal, 1_500_000);

    // A NEW price fact for the same service + a re-pointed rule. The new
    // fact fills the rule's own catalogue price tier, so both facts may be
    // ACTIVE at the same instant.
    const secondPrice = await servicePrice(realm.clientId, installId, 999_000, {
      priceKey: 'AC_INSTALL_BASE',
    });
    await q(
      `UPDATE handyman_service_price_rules
          SET price_catalog_entry_id = $1, updated_at = NOW()
        WHERE client_id = $2 AND rule_code = 'AC_INSTALL_BASE'`,
      [secondPrice, realm.clientId],
    );

    // The snapshot does not move.
    const history = await api()
      .get(`${V1}/handyman/requests/${requestId}/price-resolution`)
      .set('Authorization', `Bearer ${adminToken}`);
    const recorded = (history.body.data as {
      unitAmount: number;
      computedTotal: number;
    }[])[0];
    assert.equal(recorded.unitAmount, 750_000);
    assert.equal(recorded.computedTotal, 1_500_000);

    // The append-only guard holds: a snapshot row cannot be rewritten.
    const rowId = (
      await q(
        `SELECT id FROM handyman_service_quote_resolutions
          WHERE handyman_request_id = $1 LIMIT 1`,
        [requestId],
      )
    ).rows[0].id as string;
    await assert.rejects(
      () =>
        q(
          `UPDATE handyman_service_quote_resolutions SET unit_amount = 1 WHERE id = $1`,
          [rowId],
        ),
      'the price snapshot is append-only',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 10/11. RBAC, building scope and client isolation                    */
/* ------------------------------------------------------------------ */

describe('CR-HM-SERVICE-CATALOG-01 PART 01 — scope and RBAC', () => {
  it('rejects unauthenticated and unpermitted callers', async () => {
    const realm = await realmFixture('Rbac');
    const requestId = await requestFixture(realm);

    const anonymous = await api().get(
      `${V1}/service-catalog/parameterized/services?clientId=${realm.clientId}`,
    );
    assert.equal(anonymous.status, 401);

    const plain = await (
      await import('./helpers/access')
    ).createPlainSession();
    const forbidden = await api()
      .get(`${V1}/service-catalog/parameterized/services?clientId=${realm.clientId}`)
      .set('Authorization', `Bearer ${plain}`);
    assert.equal(forbidden.status, 403);

    const writeForbidden = await api()
      .post(`${V1}/handyman/requests/${requestId}/items`)
      .set('Authorization', `Bearer ${plain}`)
      .send({ serviceCatalogId: id(), quantity: 1 });
    assert.equal(writeForbidden.status, 403);
  });

  it('denies a caller that has no assignment to the request building', async () => {
    const realm = await realmFixture('BuildingScope');
    const requestId = await requestFixture(realm);

    const scoped = await (
      await import('./helpers/access')
    ).createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
      { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
    ]);
    const denied = await api()
      .get(`${V1}/handyman/requests/${requestId}/items`)
      .set('Authorization', `Bearer ${scoped}`);
    assert.equal(denied.status, 403, 'no same-Client shortcut');
  });

  it('isolates two Clients from each other', async () => {
    const realmA = await realmFixture('ClientA');
    const realmB = await realmFixture('ClientB');

    const a = await api()
      .get(`${V1}/service-catalog/parameterized/services?clientId=${realmA.clientId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(a.status, 200);
    assert.equal((a.body.data as unknown[]).length, 24);

    const b = await api()
      .get(`${V1}/service-catalog/parameterized/services?clientId=${realmB.clientId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(b.status, 200);
    const aIds = new Set(
      (a.body.data as { serviceCatalogId: string }[]).map((s) => s.serviceCatalogId),
    );
    for (const entry of b.body.data as { serviceCatalogId: string }[]) {
      assert.ok(
        !aIds.has(entry.serviceCatalogId),
        'no service of one Client leaks into the other',
      );
    }

    // A price rule of Client A cannot be pointed at Client B's service.
    const serviceB = await serviceIdFor(realmB.clientId, 'AC_INSTALLATION');
    const priceA = await servicePrice(
      realmA.clientId,
      await serviceIdFor(realmA.clientId, 'AC_INSTALLATION'),
      750_000,
    );
    const response = await api()
      .post(
        `${V1}/service-catalog/parameterized/entries/${serviceB}/price-rules`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ruleCode: 'CROSS_CLIENT',
        priceCatalogEntryId: priceA,
        priceBasis: 'UNIT',
      });
    assert.equal(response.status, 400, 'cross-client pricing is refused');
  });

  it('serves the admin catalogue projection over HTTP', async () => {
    const realm = await realmFixture('AdminApi');
    const categories = await api()
      .get(
        `${V1}/service-catalog/parameterized/categories?clientId=${realm.clientId}`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(categories.status, 200);
    assert.equal((categories.body.data as unknown[]).length, 8);

    const filtered = await api()
      .get(
        `${V1}/service-catalog/parameterized/services?clientId=${realm.clientId}&category=AIR_CONDITIONING`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(filtered.status, 200);
    assert.equal((filtered.body.data as unknown[]).length, 3);

    // An unknown body field is refused (bounded transport).
    const rejected = await api()
      .post(`${V1}/service-catalog/parameterized/starter-import`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: realm.clientId, surprise: true });
    assert.equal(rejected.status, 400);
  });
});
