import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { floorService } from '../src/modules/floors';
import { importHandymanServiceCatalogStarter } from '../src/modules/handyman-parameterized-catalog';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
import { createAdminUser } from './helpers/access';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 PART 04 — Building-session structured
 * Care parity.
 *
 * Focused HTTP suite against a DISPOSABLE embedded PostgreSQL (unique port,
 * removed after the run) with real authenticated sessions. Proves:
 *
 *   - the LEGACY single-service POST contract is byte-compatible (no item
 *     rows authored, no new response keys);
 *   - a structured `items[]` POST persists through the EXISTING advanced Care
 *     item engine and round-trips through the authorized GET detail;
 *   - mixed legacy + structured selection is rejected;
 *   - quantity precision, variant, UOM and access-condition rules are the
 *     engine's, not a second implementation;
 *   - Building and Client isolation, plus Care staff session provenance;
 *   - idempotent replay, reordering tolerance and conflicting-intent 409;
 *   - a mid-transaction item failure leaves NO orphan request, attribution,
 *     item, party or idempotency record;
 *   - attribute inheritance provenance is materialised and reported;
 *   - INTERNAL_ONLY Care Notes never reach this projection.
 *
 * The BM exchange-token structured intake is deliberately NOT re-implemented
 * here; its own suite (`handyman-care-request-create.test.ts`) is the
 * regression evidence and this suite never calls or alters it.
 */

const DIR = '/tmp/cr-hm-be-care-catalog-structured-01-part04-pg';
const PORT = 57841;
const V1 = '/api/v1';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

let database: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | null = null;
let pool: Pool;
let adminUserId = '';

type Realm = {
  clientId: string;
  propertyId: string;
  buildingId: string;
  companyId: string;
  picId: string;
  picUserId: string;
  spaceId: string;
  /** Plain, attribute-free catalogue service (multi-item partner). */
  simpleServiceId: string;
  /** Starter service that owns the governed AC attribute vocabulary. */
  acServiceId: string;
  acVariantId: string;
  unitUomId: string;
};

before(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error' });
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
  adminUserId = admin.userId;
});

after(async () => {
  try {
    await closePool(getPool()).catch(() => undefined);
    if (database) await database.stop();
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(DIR, { recursive: true, force: true });
  }
});

async function ensureCarePermission() {
  let permission = await permissionRepository.findByCode(
    HANDYMAN_CARE_BUILDING_PERMISSION,
  );
  if (!permission) {
    permission = await permissionService.createPermission({
      code: HANDYMAN_CARE_BUILDING_PERMISSION,
      name: 'Building Customer Care',
    });
  }
  return permission;
}

/** Care staff whose ONLY permission is `handyman.care.building`. */
async function createCareStaff(buildingId: string) {
  const tag = suffix().toLowerCase();
  const email = `care-p04-${tag}@example.test`;
  const password = `Care-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Building Care Staff',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `CARE_P04_${tag.toUpperCase()}`,
    name: 'Building Care Structured Part 04',
  });
  const permission = await ensureCarePermission();
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

async function createRealm(label: string): Promise<Realm> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `P4C_${tag}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P4P_${tag}`,
    name: `${label} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `P4B_${tag}`,
    name: `${label} Building`,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `P4T_${tag}`, tenantName: `${label} Tenant` },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `P4F_${tag}`,
    name: 'Part04 floor',
    levelNumber: 3,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `P4A_${tag}`,
    name: 'Part04 area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `P4R_${tag}`,
    name: 'Part04 room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `P4S_${tag}`,
    name: 'Part04 unit',
  });
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminUserId,
  );
  const picUser = await userService.createUser({
    email: `p4-pic-${tag.toLowerCase()}@example.test`,
    displayName: 'Part04 Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Part04 Tenant PIC',
      email: picUser.email,
      userId: picUser.id,
    },
    adminUserId,
  );

  const simpleService = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `P4SV_${tag}`,
      name: `${label} simple repair`,
      category: 'HANDYMAN',
    },
    adminUserId,
  );

  // The starter owns the governed AC vocabulary + the Client's quantity UOMs.
  await importHandymanServiceCatalogStarter(client.id, adminUserId);
  const acService = await sql(
    `SELECT id FROM service_catalog
      WHERE client_id = $1 AND code = 'AC_INSTALLATION' LIMIT 1`,
    [client.id],
  );
  assert.ok(acService.rows[0], 'the starter must seed AC_INSTALLATION');
  const acServiceId = acService.rows[0].id as string;

  const variantId = randomUUID();
  await sql(
    `INSERT INTO handyman_service_variants
       (id, client_id, service_catalog_id, code, name, status, created_by_user_id)
     VALUES ($1, $2, $3, 'P4_AC_05_NON_INVERTER', 'AC 0.5 PK non-inverter',
             'ACTIVE', $4)`,
    [variantId, client.id, acServiceId, adminUserId],
  );
  const attributeRows = await sql(
    `SELECT id, code FROM handyman_service_attributes
      WHERE client_id = $1 AND service_catalog_id = $2`,
    [client.id, acServiceId],
  );
  const attributeId = (code: string) => {
    const row = attributeRows.rows.find((item) => item.code === code);
    assert.ok(row, `governed attribute ${code} must exist`);
    return row.id as string;
  };
  const configure = async (
    code: string,
    value: { text?: string; number?: number },
  ) => {
    await sql(
      `INSERT INTO handyman_service_variant_attributes
         (id, client_id, service_variant_id, attribute_id, value_text,
          value_number, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)`,
      [
        randomUUID(),
        client.id,
        variantId,
        attributeId(code),
        value.text ?? null,
        value.number ?? null,
        adminUserId,
      ],
    );
  };
  await configure('AC_CAPACITY', { number: 0.5 });
  await configure('AC_TYPE', { text: 'SPLIT' });
  await configure('AC_DRIVE_TYPE', { text: 'NON_INVERTER' });

  const uom = await sql(
    `SELECT id FROM units_of_measure
      WHERE client_id = $1 AND code = 'HM_UNIT' LIMIT 1`,
    [client.id],
  );
  assert.ok(uom.rows[0], 'the starter must seed HM_UNIT');

  return {
    clientId: client.id,
    propertyId: property.id,
    buildingId: building.id,
    companyId: company.id,
    picId: pic.id,
    picUserId: picUser.id,
    spaceId: space.id,
    simpleServiceId: simpleService.id,
    acServiceId,
    acVariantId: variantId,
    unitUomId: uom.rows[0].id as string,
  };
}

function legacyBody(realm: Realm, description = 'Legacy tap leak') {
  return {
    tenantCompanyId: realm.companyId,
    tenantPicId: realm.picId,
    spaceId: realm.spaceId,
    serviceCatalogId: realm.simpleServiceId,
    description,
  };
}

function structuredBody(realm: Realm) {
  return {
    tenantCompanyId: realm.companyId,
    tenantPicId: realm.picId,
    spaceId: realm.spaceId,
    description: 'Two reported services in one intake',
    items: [
      {
        serviceCatalogId: realm.acServiceId,
        serviceVariantId: realm.acVariantId,
        quantity: 2,
        uomId: realm.unitUomId,
        attributeValues: { OBSERVED_CONDITION: 'NOISY_FAN' },
        itemDescription: 'Bedroom unit rattles on start',
        accessCondition: 'HIGH_FLOOR',
      },
      {
        serviceCatalogId: realm.simpleServiceId,
        quantity: 1.25,
        uomId: realm.unitUomId,
        itemDescription: 'Second reported defect',
      },
    ],
  };
}

const postCare = (
  token: string,
  buildingId: string,
  body: unknown,
  idempotencyKey: string,
) =>
  api()
    .post(`${V1}/handyman/care/buildings/${buildingId}/requests`)
    .set(auth(token))
    .set('Idempotency-Key', idempotencyKey)
    .send(body as never);

const getDetail = (token: string, buildingId: string, requestId: string) =>
  api()
    .get(`${V1}/handyman/care/buildings/${buildingId}/requests/${requestId}`)
    .set(auth(token));

const requestRows = async (actorUserId: string) =>
  Number(
    (
      await sql(
        'SELECT count(*)::int AS total FROM handyman_service_requests WHERE created_by_user_id = $1',
        [actorUserId],
      )
    ).rows[0].total,
  );

const itemRows = async (clientId: string) =>
  Number(
    (
      await sql(
        'SELECT count(*)::int AS total FROM handyman_service_request_items WHERE client_id = $1',
        [clientId],
      )
    ).rows[0].total,
  );

describe('PART 04 / 1-2 — legacy compatibility and structured round-trip', () => {
  it('1: legacy single-service POST is byte-compatible and authors no item rows', async () => {
    const realm = await createRealm('Legacy');
    const care = await createCareStaff(realm.buildingId);
    const res = await postCare(
      care.token,
      realm.buildingId,
      legacyBody(realm),
      randomUUID(),
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const created = res.body.data;
    assert.deepEqual(Object.keys(created).sort(), [
      'buildingId',
      'createdAt',
      'description',
      'id',
      'serviceCatalogId',
      'serviceVariantId',
      'spaceId',
      'status',
      'updatedAt',
    ]);
    assert.equal(created.status, 'INTAKE');
    assert.equal(created.serviceCatalogId, realm.simpleServiceId);
    assert.equal(await itemRows(realm.clientId), 0, 'no item rows for legacy');

    const detail = await getDetail(care.token, realm.buildingId, created.id);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    // The pre-existing request + progress contract is untouched.
    assert.equal(detail.body.data.request.status, 'INTAKE');
    assert.deepEqual(detail.body.data.progress, {
      triage: null,
      inspection: null,
      diagnosis: null,
      quotation: null,
      execution: null,
    });
    // `items` is additive and empty for a legacy submission.
    assert.deepEqual(detail.body.data.items, []);
  });

  it('2: structured POST persists through the advanced item engine and round-trips through the authorized GET', async () => {
    const realm = await createRealm('Structured');
    const care = await createCareStaff(realm.buildingId);
    const body = structuredBody(realm);

    const res = await postCare(care.token, realm.buildingId, body, randomUUID());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const created = res.body.data;

    // Parent request keeps its catalogue anchor = the FIRST structured item.
    assert.equal(created.serviceCatalogId, realm.acServiceId);
    assert.equal(created.serviceVariantId, realm.acVariantId);
    assert.equal(created.status, 'INTAKE');
    assert.equal(created.items.length, 2);
    assert.equal(await itemRows(realm.clientId), 2);

    const detail = await getDetail(care.token, realm.buildingId, created.id);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    // One vocabulary: the POST body's items and the GET detail's items are the
    // SAME projection with the SAME values. Order is (createdAt, id) — items
    // authored in one transaction share createdAt, so the id tie-break is the
    // documented deterministic order, not the submission order.
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    assert.deepEqual(
      [...detail.body.data.items].sort(byId),
      [...created.items].sort(byId),
      `POST=${JSON.stringify(created.items)} GET=${JSON.stringify(detail.body.data.items)}`,
    );
    assert.equal(detail.body.data.request.id, created.id);

    // The readback order is deterministic across calls.
    const again = await getDetail(care.token, realm.buildingId, created.id);
    assert.deepEqual(
      again.body.data.items.map((item: { id: string }) => item.id),
      detail.body.data.items.map((item: { id: string }) => item.id),
    );

    const itemsById = new Map(
      detail.body.data.items.map((item: { id: string }) => [item.id, item]),
    );
    const acItem = itemsById.get(
      created.items.find(
        (item: { serviceCatalogId: string }) =>
          item.serviceCatalogId === realm.acServiceId,
      ).id,
    ) as any;
    const simpleItem = itemsById.get(
      created.items.find(
        (item: { serviceCatalogId: string }) =>
          item.serviceCatalogId === realm.simpleServiceId,
      ).id,
    ) as any;
    assert.ok(acItem && simpleItem);

    // Catalogue / variant identity is projected with readable codes.
    assert.equal(acItem.serviceCatalogId, realm.acServiceId);
    assert.equal(acItem.serviceCode, 'AC_INSTALLATION');
    assert.equal(acItem.serviceVariantId, realm.acVariantId);
    assert.equal(acItem.serviceVariantCode, 'P4_AC_05_NON_INVERTER');

    // Quantity preserved exactly (no rounding of the NUMERIC(18,4) value).
    assert.equal(acItem.quantity, 2);
    assert.equal(simpleItem.quantity, 1.25);

    // Reported UOM, resolved from the ACTIVE Client-owned row.
    assert.equal(acItem.uomId, realm.unitUomId);
    assert.equal(acItem.uomCode, 'HM_UNIT');
    assert.equal(acItem.uomSymbol, 'unit');

    // Item description and access condition are the reported facts.
    assert.equal(acItem.itemDescription, 'Bedroom unit rattles on start');
    assert.equal(acItem.accessCondition, 'HIGH_FLOOR');
    assert.equal(simpleItem.accessCondition, 'STANDARD');
    assert.equal(simpleItem.itemDescription, 'Second reported defect');

    // Effective attribute set = variant configuration + reported own fact.
    assert.equal(acItem.attributeValues.AC_CAPACITY, '0.5');
    assert.equal(acItem.attributeValues.AC_TYPE, 'SPLIT');
    assert.equal(acItem.attributeValues.AC_DRIVE_TYPE, 'NON_INVERTER');
    assert.equal(acItem.attributeValues.OBSERVED_CONDITION, 'NOISY_FAN');

    // Provenance: only the variant-supplied codes, stated explicitly.
    assert.deepEqual(acItem.inheritedAttributeValues, {
      AC_CAPACITY: '0.5',
      AC_DRIVE_TYPE: 'NON_INVERTER',
      AC_TYPE: 'SPLIT',
    });
    assert.deepEqual(acItem.inheritedAttributeCodes, [
      'AC_CAPACITY',
      'AC_DRIVE_TYPE',
      'AC_TYPE',
    ]);
    // The reported own fact is NOT claimed as inherited.
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        acItem.inheritedAttributeValues,
        'OBSERVED_CONDITION',
      ),
      false,
    );

    // A variant-less item inherits nothing and is not fabricated a provenance.
    assert.deepEqual(simpleItem.inheritedAttributeValues, {});
    assert.deepEqual(simpleItem.inheritedAttributeCodes, []);
    assert.deepEqual(simpleItem.attributeValues, {});

    assert.equal(acItem.status, 'ACTIVE');
    assert.equal(simpleItem.status, 'ACTIVE');
    assert.ok(acItem.createdAt && acItem.updatedAt);

    // Reported items are NOT approved quotation lines.
    assert.deepEqual(detail.body.data.progress.quotation, null);
  });

  it('3: mixed legacy and structured selection is rejected and persists nothing', async () => {
    const realm = await createRealm('Mixed');
    const care = await createCareStaff(realm.buildingId);
    const base = structuredBody(realm);

    const mixedCatalog = await postCare(
      care.token,
      realm.buildingId,
      { ...base, serviceCatalogId: realm.simpleServiceId },
      randomUUID(),
    );
    assert.equal(mixedCatalog.status, 400, JSON.stringify(mixedCatalog.body));
    assert.equal(mixedCatalog.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      mixedCatalog.body.error.details.some(
        (detail: { field: string }) => detail.field === 'serviceCatalogId',
      ),
    );

    const mixedVariant = await postCare(
      care.token,
      realm.buildingId,
      { ...base, serviceVariantId: realm.acVariantId },
      randomUUID(),
    );
    assert.equal(mixedVariant.status, 400, JSON.stringify(mixedVariant.body));
    assert.equal(mixedVariant.body.error.code, 'VALIDATION_ERROR');

    // Neither selection at all is equally invalid.
    const neither = await postCare(
      care.token,
      realm.buildingId,
      { tenantCompanyId: realm.companyId, spaceId: realm.spaceId },
      randomUUID(),
    );
    assert.equal(neither.status, 400, JSON.stringify(neither.body));
    assert.equal(neither.body.error.code, 'VALIDATION_ERROR');

    // An empty items array is not a structured selection.
    const empty = await postCare(
      care.token,
      realm.buildingId,
      { ...base, items: [] },
      randomUUID(),
    );
    assert.equal(empty.status, 400, JSON.stringify(empty.body));

    // Over the 50-item bound.
    const tooMany = await postCare(
      care.token,
      realm.buildingId,
      {
        ...base,
        items: Array.from({ length: 51 }, () => ({
          serviceCatalogId: realm.simpleServiceId,
          quantity: 1,
        })),
      },
      randomUUID(),
    );
    assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body));

    assert.equal(await requestRows(care.userId), 0);
    assert.equal(await itemRows(realm.clientId), 0);
  });

  it('4: quantity, variant, UOM and attribute rules are the engine\'s rules', async () => {
    const realm = await createRealm('Validation');
    const foreign = await createRealm('Validation foreign');
    const care = await createCareStaff(realm.buildingId);

    const probe = async (items: unknown) => {
      const res = await postCare(
        care.token,
        realm.buildingId,
        {
          tenantCompanyId: realm.companyId,
          tenantPicId: realm.picId,
          spaceId: realm.spaceId,
          items,
        },
        randomUUID(),
      );
      return res;
    };

    // Non-positive quantity is rejected at the edge.
    const zero = await probe([
      { serviceCatalogId: realm.simpleServiceId, quantity: 0 },
    ]);
    assert.equal(zero.status, 400, JSON.stringify(zero.body));
    assert.equal(zero.body.error.code, 'VALIDATION_ERROR');

    // Beyond NUMERIC(18,4) precision is rejected by the engine.
    const tooPrecise = await probe([
      { serviceCatalogId: realm.simpleServiceId, quantity: 0.00001 },
    ]);
    assert.equal(tooPrecise.status, 400, JSON.stringify(tooPrecise.body));
    assert.equal(
      tooPrecise.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );

    // An INACTIVE variant is refused. The FIRST item supplies the parent
    // request's catalogue/variant ANCHOR, so it is judged by the PRE-EXISTING
    // request-intake contract (409 HANDYMAN_SERVICE_VARIANT_NOT_ACTIVE) —
    // identical to the legacy single-service submission and to the
    // exchange-token structured intake. A NON-anchored item's variant is
    // judged by the item engine (400).
    await sql(
      `UPDATE handyman_service_variants SET status = 'INACTIVE' WHERE id = $1`,
      [realm.acVariantId],
    );
    const inactiveAnchoredVariant = await probe([
      {
        serviceCatalogId: realm.acServiceId,
        serviceVariantId: realm.acVariantId,
        quantity: 1,
      },
    ]);
    assert.equal(
      inactiveAnchoredVariant.status,
      409,
      JSON.stringify(inactiveAnchoredVariant.body),
    );
    assert.equal(
      inactiveAnchoredVariant.body.error.code,
      'HANDYMAN_SERVICE_VARIANT_NOT_ACTIVE',
    );

    const inactiveSecondVariant = await probe([
      { serviceCatalogId: realm.simpleServiceId, quantity: 1 },
      {
        serviceCatalogId: realm.acServiceId,
        serviceVariantId: realm.acVariantId,
        quantity: 1,
      },
    ]);
    assert.equal(
      inactiveSecondVariant.status,
      400,
      JSON.stringify(inactiveSecondVariant.body),
    );
    assert.equal(
      inactiveSecondVariant.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );
    await sql(
      `UPDATE handyman_service_variants SET status = 'ACTIVE' WHERE id = $1`,
      [realm.acVariantId],
    );

    // A variant that belongs to a DIFFERENT service is refused.
    const wrongServiceVariant = await probe([
      {
        serviceCatalogId: realm.simpleServiceId,
        serviceVariantId: realm.acVariantId,
        quantity: 1,
      },
    ]);
    assert.equal(wrongServiceVariant.status, 400);

    // An explicit attribute that CONTRADICTS the variant is refused.
    const contradiction = await probe([
      {
        serviceCatalogId: realm.acServiceId,
        serviceVariantId: realm.acVariantId,
        quantity: 1,
        attributeValues: { AC_CAPACITY: '1.5' },
      },
    ]);
    assert.equal(contradiction.status, 400, JSON.stringify(contradiction.body));
    assert.equal(
      contradiction.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );

    // Restating the SAME value the variant configures is accepted.
    const agreeing = await probe([
      {
        serviceCatalogId: realm.acServiceId,
        serviceVariantId: realm.acVariantId,
        quantity: 1,
        attributeValues: { AC_CAPACITY: '0.5' },
      },
    ]);
    assert.equal(agreeing.status, 201, JSON.stringify(agreeing.body));

    // A UOM of ANOTHER Client is refused (Client scope, not existence).
    const foreignUom = await sql(
      `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
      [foreign.clientId],
    );
    const crossUom = await probe([
      {
        serviceCatalogId: realm.simpleServiceId,
        quantity: 1,
        uomId: foreignUom.rows[0].id,
      },
    ]);
    assert.equal(crossUom.status, 400, JSON.stringify(crossUom.body));
    assert.equal(
      crossUom.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );

    // An INACTIVE UOM of the SAME Client is refused.
    const ownUom = await sql(
      `SELECT id FROM units_of_measure
        WHERE client_id = $1 AND code = 'HM_POINT' LIMIT 1`,
      [realm.clientId],
    );
    await sql(
      `UPDATE units_of_measure SET status = 'INACTIVE' WHERE id = $1`,
      [ownUom.rows[0].id],
    );
    const inactiveUom = await probe([
      {
        serviceCatalogId: realm.simpleServiceId,
        quantity: 1,
        uomId: ownUom.rows[0].id,
      },
    ]);
    assert.equal(inactiveUom.status, 400, JSON.stringify(inactiveUom.body));

    // A service of ANOTHER Client is refused. The anchor item is judged by
    // the PRE-EXISTING request-intake contract (the legacy cross-Client
    // answer is 400 HANDYMAN_SERVICE_REQUEST_SCOPE_MISMATCH), every
    // additional item by the item engine (400 ITEM_INVALID).
    const crossServiceAnchor = await probe([
      { serviceCatalogId: foreign.simpleServiceId, quantity: 1 },
    ]);
    assert.equal(
      crossServiceAnchor.status,
      400,
      JSON.stringify(crossServiceAnchor.body),
    );
    assert.equal(
      crossServiceAnchor.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_SCOPE_MISMATCH',
    );
    const crossServiceSecond = await probe([
      { serviceCatalogId: realm.simpleServiceId, quantity: 1 },
      { serviceCatalogId: foreign.simpleServiceId, quantity: 1 },
    ]);
    assert.equal(
      crossServiceSecond.status,
      400,
      JSON.stringify(crossServiceSecond.body),
    );
    assert.equal(
      crossServiceSecond.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );

    // An unknown service id is refused: 404 on the anchor (the legacy
    // SERVICE_CATALOG_NOT_FOUND contract) and 400 on a later item.
    const unknownAnchor = await probe([
      { serviceCatalogId: randomUUID(), quantity: 1 },
    ]);
    assert.equal(unknownAnchor.status, 404, JSON.stringify(unknownAnchor.body));
    assert.equal(unknownAnchor.body.error.code, 'SERVICE_CATALOG_NOT_FOUND');
    const unknownSecond = await probe([
      { serviceCatalogId: realm.simpleServiceId, quantity: 1 },
      { serviceCatalogId: randomUUID(), quantity: 1 },
    ]);
    assert.equal(unknownSecond.status, 400, JSON.stringify(unknownSecond.body));
    assert.equal(
      unknownSecond.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );

    // The reserved ACCESS_CONDITION attribute key is refused.
    const reserved = await probe([
      {
        serviceCatalogId: realm.simpleServiceId,
        quantity: 1,
        attributeValues: { ACCESS_CONDITION: 'HIGH_FLOOR' },
      },
    ]);
    assert.equal(reserved.status, 400, JSON.stringify(reserved.body));
    assert.match(
      String(reserved.body.error.message),
      /ACCESS_CONDITION/,
    );

    // An unsupported access condition is refused at the edge.
    const badAccess = await probe([
      {
        serviceCatalogId: realm.simpleServiceId,
        quantity: 1,
        accessCondition: 'BM_CLEARED',
      },
    ]);
    assert.equal(badAccess.status, 400, JSON.stringify(badAccess.body));
    assert.equal(badAccess.body.error.code, 'VALIDATION_ERROR');

    // Only the one agreeing submission persisted exactly ONE item.
    assert.equal(await itemRows(realm.clientId), 1);
    assert.equal(await itemRows(foreign.clientId), 0);
  });

  it('5: Building and Client isolation on create and on the item readback', async () => {
    const realm = await createRealm('Isolation');
    const care = await createCareStaff(realm.buildingId);
    const created = await postCare(
      care.token,
      realm.buildingId,
      structuredBody(realm),
      randomUUID(),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    // Sibling Building in the SAME Client, staff assigned only to it.
    const sibling = await buildingService.createBuilding({
      propertyId: realm.propertyId,
      code: `P4SIB_${suffix()}`,
      name: 'Sibling building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: sibling.id,
    });
    const siblingCare = await createCareStaff(sibling.id);

    // Staff without an assignment to the exact Building: denied, non-enumerating.
    const deniedSibling = await getDetail(
      siblingCare.token,
      realm.buildingId,
      requestId,
    );
    assert.equal(deniedSibling.status, 403, JSON.stringify(deniedSibling.body));
    assert.equal(
      deniedSibling.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );

    // The sibling Building path with a foreign request id: not found, never a
    // cross-Building item leak.
    const siblingScope = await getDetail(
      siblingCare.token,
      sibling.id,
      requestId,
    );
    assert.equal(siblingScope.status, 404, JSON.stringify(siblingScope.body));
    assert.equal(
      siblingScope.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_NOT_FOUND',
    );

    // Another Client's Care staff: no cross-Client readback either.
    const other = await createRealm('Isolation other');
    const otherCare = await createCareStaff(other.buildingId);
    const crossClient = await getDetail(
      otherCare.token,
      other.buildingId,
      requestId,
    );
    assert.equal(crossClient.status, 404, JSON.stringify(crossClient.body));

    // Cross-Client structured CREATION is refused (foreign tenant scope).
    const crossCreate = await postCare(
      care.token,
      realm.buildingId,
      { ...structuredBody(other), tenantCompanyId: other.companyId },
      randomUUID(),
    );
    assert.equal(crossCreate.status, 403, JSON.stringify(crossCreate.body));
    assert.equal(
      crossCreate.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );
    assert.equal(await itemRows(other.clientId), 0);

    // The authorized readback still returns exactly this request's items.
    const own = await getDetail(care.token, realm.buildingId, requestId);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.items.length, 2);
  });

  it('6: Care staff session is the only actor and its provenance is preserved', async () => {
    const realm = await createRealm('Provenance');
    const care = await createCareStaff(realm.buildingId);

    // No session.
    const anonymous = await api()
      .post(`${V1}/handyman/care/buildings/${realm.buildingId}/requests`)
      .set('Idempotency-Key', randomUUID())
      .send(structuredBody(realm) as never);
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

    // A session without `handyman.care.building`.
    const tag = suffix().toLowerCase();
    const plainEmail = `plain-p04-${tag}@example.test`;
    const plainPassword = `Plain-${tag}!Password1`;
    const plain = await userService.createUser({
      email: plainEmail,
      displayName: 'No Permission',
    });
    await credentialService.createInitialCredential({
      userId: plain.id,
      password: plainPassword,
    });
    await buildingAssignmentService.createAssignment(plain.id, {
      buildingId: realm.buildingId,
    });
    const plainLogin = await api()
      .post(`${V1}/auth/login`)
      .send({ email: plainEmail, password: plainPassword });
    assert.equal(plainLogin.status, 200, JSON.stringify(plainLogin.body));
    const denied = await postCare(
      plainLogin.body.data.sessionToken as string,
      realm.buildingId,
      structuredBody(realm),
      randomUUID(),
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    assert.equal(await requestRows(plain.id), 0);

    // The authorized structured create attributes EVERY layer to the session.
    const created = await postCare(
      care.token,
      realm.buildingId,
      structuredBody(realm),
      randomUUID(),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    const requestRow = (
      await sql(
        `SELECT client_id, building_id, tenant_company_id, tenant_pic_id,
                created_by_user_id, origin_channel, channel_attribution_id
           FROM handyman_service_requests WHERE id = $1`,
        [requestId],
      )
    ).rows[0];
    assert.equal(requestRow.client_id, realm.clientId);
    assert.equal(requestRow.building_id, realm.buildingId);
    assert.equal(requestRow.tenant_company_id, realm.companyId);
    assert.equal(requestRow.tenant_pic_id, realm.picId);
    assert.equal(requestRow.created_by_user_id, care.userId);
    assert.equal(requestRow.origin_channel, 'CUSTOMER_CARE_BACKEND');
    assert.notEqual(requestRow.created_by_user_id, realm.picUserId);

    const attribution = (
      await sql(
        `SELECT created_by_user_id, actor_type, care_actor_id, origin_channel
           FROM handyman_channel_attributions WHERE id = $1`,
        [requestRow.channel_attribution_id],
      )
    ).rows[0];
    assert.equal(attribution.created_by_user_id, care.userId);
    assert.equal(attribution.origin_channel, 'CUSTOMER_CARE_BACKEND');
    // No BM actor is fabricated for a Building-session submission.
    assert.equal(attribution.actor_type, null);
    assert.equal(attribution.care_actor_id, null);

    // Items carry NULL creator by the Care provenance contract (0484); the
    // acting staff session is recorded on the item audit event instead.
    const itemRowsForRequest = (
      await sql(
        `SELECT created_by_user_id, status FROM handyman_service_request_items
          WHERE handyman_request_id = $1 ORDER BY created_at, id`,
        [requestId],
      )
    ).rows;
    assert.equal(itemRowsForRequest.length, 2);
    for (const row of itemRowsForRequest) {
      assert.equal(row.created_by_user_id, null);
      assert.equal(row.status, 'ACTIVE');
    }
    const events = (
      await sql(
        `SELECT metadata FROM operational_events
          WHERE entity_type = 'HANDYMAN_SERVICE_REQUEST' AND entity_id = $1
            AND event_type = 'HANDYMAN_SERVICE_REQUEST_ITEM_ADDED'`,
        [requestId],
      )
    ).rows;
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.metadata.careActorId, care.userId);
    }
  });

  it('7: idempotent replay, order tolerance and conflicting-intent rejection', async () => {
    const realm = await createRealm('Idempotency');
    const care = await createCareStaff(realm.buildingId);
    const key = randomUUID();
    const body = structuredBody(realm);

    const first = await postCare(care.token, realm.buildingId, body, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.items.length, 2);

    const replay = await postCare(care.token, realm.buildingId, body, key);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.deepEqual(replay.body.data.items, first.body.data.items);
    assert.equal(await requestRows(care.userId), 1);
    assert.equal(await itemRows(realm.clientId), 2, 'replay authors no items');

    // An EXPLICIT `accessCondition: STANDARD` is the same intent as omitting
    // it (the engine defaults it), so it must REPLAY, not conflict.
    const explicitDefaultAccess = structuredBody(realm);
    explicitDefaultAccess.items[1].accessCondition = 'STANDARD';
    const reordered = await postCare(
      care.token,
      realm.buildingId,
      explicitDefaultAccess,
      key,
    );
    assert.equal(reordered.status, 201, JSON.stringify(reordered.body));
    assert.equal(reordered.body.data.id, first.body.data.id);

    // An ADDITIONAL item changes the intent -> conflict, no silent append.
    const extraItem = structuredBody(realm);
    extraItem.items.push({
      serviceCatalogId: realm.simpleServiceId,
      quantity: 1,
    });
    const changedItemCount = await postCare(
      care.token,
      realm.buildingId,
      extraItem,
      key,
    );
    assert.equal(
      changedItemCount.status,
      409,
      JSON.stringify(changedItemCount.body),
    );
    assert.equal(changedItemCount.body.error.code, 'IDEMPOTENCY_CONFLICT');

    // Same key, DIFFERENT quantity -> conflict, never a silent overwrite.
    const changedQuantity = structuredBody(realm);
    changedQuantity.items[1].quantity = 9;
    const conflict = await postCare(
      care.token,
      realm.buildingId,
      changedQuantity,
      key,
    );
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

    // Same key, DIFFERENT access condition -> conflict.
    const changedAccess = structuredBody(realm);
    changedAccess.items[0].accessCondition = 'STANDARD';
    const accessConflict = await postCare(
      care.token,
      realm.buildingId,
      changedAccess,
      key,
    );
    assert.equal(accessConflict.status, 409, JSON.stringify(accessConflict.body));

    assert.equal(await requestRows(care.userId), 1);
    assert.equal(await itemRows(realm.clientId), 2);
  });

  it('8: a mid-transaction item failure rolls back request, attribution, party, items and the idempotency claim', async () => {
    const realm = await createRealm('Rollback');
    const foreign = await createRealm('Rollback foreign');
    const care = await createCareStaff(realm.buildingId);
    const foreignUom = await sql(
      `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
      [foreign.clientId],
    );

    // Item 1 is valid and would be inserted BEFORE item 2 fails, so this
    // proves the rollback removes already-written rows, not just the last one.
    const failing = {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      items: [
        { serviceCatalogId: realm.simpleServiceId, quantity: 1 },
        {
          serviceCatalogId: realm.simpleServiceId,
          quantity: 1,
          uomId: foreignUom.rows[0].id,
        },
      ],
    };
    const res = await postCare(care.token, realm.buildingId, failing, randomUUID());
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID');

    assert.equal(await requestRows(care.userId), 0, 'no orphan request');
    assert.equal(await itemRows(realm.clientId), 0, 'no orphan items');
    const attributions = Number(
      (
        await sql(
          'SELECT count(*)::int AS total FROM handyman_channel_attributions WHERE created_by_user_id = $1',
          [care.userId],
        )
      ).rows[0].total,
    );
    assert.equal(attributions, 0, 'no orphan attribution');
    const parties = Number(
      (
        await sql(
          `SELECT count(*)::int AS total FROM handyman_request_parties
            WHERE created_by_user_id = $1`,
          [care.userId],
        )
      ).rows[0].total,
    );
    assert.equal(parties, 0, 'no orphan party designation');
    const claims = Number(
      (
        await sql(
          `SELECT count(*)::int AS total FROM request_idempotency_records
            WHERE actor_user_id = $1 AND operation_key = 'hm.care.request.create'`,
          [care.userId],
        )
      ).rows[0].total,
    );
    assert.equal(claims, 0, 'the idempotency claim rolls back with the work');

    // The SAME key is therefore still usable for the corrected submission.
    const key = randomUUID();
    const bad = await postCare(care.token, realm.buildingId, failing, key);
    assert.equal(bad.status, 400);
    const good = await postCare(
      care.token,
      realm.buildingId,
      {
        tenantCompanyId: realm.companyId,
        spaceId: realm.spaceId,
        items: [{ serviceCatalogId: realm.simpleServiceId, quantity: 1 }],
      },
      key,
    );
    assert.equal(good.status, 201, JSON.stringify(good.body));
    assert.equal(good.body.data.items.length, 1);
  });

  it('11: INTERNAL_ONLY Care Notes never reach the item/detail projection', async () => {
    const realm = await createRealm('Notes');
    const care = await createCareStaff(realm.buildingId);
    const created = await postCare(
      care.token,
      realm.buildingId,
      structuredBody(realm),
      randomUUID(),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    const secret = `internal-only-secret-${randomUUID()}`;
    const note = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.buildingId}/requests/${requestId}/internal-notes`,
      )
      .set(auth(care.token))
      .send({ content: secret, idempotencyKey: randomUUID() });
    assert.equal(note.status, 201, JSON.stringify(note.body));

    // The note really exists and is INTERNAL_ONLY...
    const stored = (
      await sql(
        `SELECT visibility_classification FROM handyman_internal_notes
          WHERE handyman_request_id = $1`,
        [requestId],
      )
    ).rows[0];
    assert.equal(stored.visibility_classification, 'INTERNAL_ONLY');

    // ...and it is NOT disclosed by the request detail projection.
    const detail = await getDetail(care.token, realm.buildingId, requestId);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const serialized = JSON.stringify(detail.body);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('internalNotes'), false);
    assert.equal(serialized.includes('visibilityClassification'), false);
    assert.equal(serialized.includes('INTERNAL_ONLY'), false);
    for (const item of detail.body.data.items) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'notes'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'internalNotes'), false);
    }
  });
});

describe('PART 04 — focused OpenAPI closure', () => {
  const spec = parseYaml(
    readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
  ) as any;
  const gatewayService = readFileSync(
    resolve(
      __dirname,
      '../src/modules/handyman-care-standalone-discovery/handyman-care-tenant-request-gateway.service.ts',
    ),
    'utf8',
  );

  it('documents the structured create body with explicit mutual exclusion', () => {
    const body = spec.components.schemas.HandymanCareRequestCreateBody;
    assert.deepEqual(body.required, ['tenantCompanyId']);
    assert.deepEqual(body.anyOf, [
      { required: ['serviceCatalogId'] },
      { required: ['items'] },
    ]);
    assert.deepEqual(body.if, { required: ['items'] });
    assert.deepEqual(body.then, {
      not: {
        anyOf: [{ required: ['serviceCatalogId'] }, { required: ['serviceVariantId'] }],
      },
    });
    const items = body.properties.items;
    assert.equal(items.type, 'array');
    assert.equal(items.minItems, 1);
    assert.equal(items.maxItems, 50);
    assert.equal(
      items.items.$ref,
      '#/components/schemas/HandymanCareStructuredRequestItemInput',
    );
    const item = spec.components.schemas.HandymanCareStructuredRequestItemInput;
    assert.deepEqual(item.required, ['serviceCatalogId', 'quantity']);
    assert.deepEqual(Object.keys(item.properties).sort(), [
      'accessCondition',
      'attributeValues',
      'itemDescription',
      'quantity',
      'serviceCatalogId',
      'serviceVariantId',
      'uomId',
    ]);
    assert.equal(item.additionalProperties, false);
    assert.equal(item.properties.quantity.multipleOf, 0.0001);
    assert.deepEqual(item.properties.accessCondition.enum, [
      'STANDARD',
      'DIFFICULT',
      'HIGH_FLOOR',
      'RESTRICTED',
      'SPECIAL_EQUIPMENT',
    ]);
  });

  it('documents the item readback on the detail projection', () => {
    const detail = spec.components.schemas.HandymanCareStandaloneRequestDetail;
    assert.deepEqual(detail.required, ['request', 'items', 'progress']);
    assert.equal(
      detail.properties.items.items.$ref,
      '#/components/schemas/HandymanCareStandaloneRequestItem',
    );
    const item = spec.components.schemas.HandymanCareStandaloneRequestItem;
    for (const key of [
      'serviceCatalogId',
      'serviceCode',
      'serviceVariantId',
      'serviceVariantCode',
      'quantity',
      'uomId',
      'uomCode',
      'itemDescription',
      'accessCondition',
      'attributeValues',
      'inheritedAttributeValues',
      'inheritedAttributeCodes',
      'status',
      'createdAt',
      'updatedAt',
    ]) {
      assert.ok(item.properties[key], `item schema must document ${key}`);
    }
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.required.sort(), Object.keys(item.properties).sort());

    const create = spec.paths['/handyman/care/buildings/{buildingId}/requests'].post;
    assert.equal(create['x-required-permission'], 'handyman.care.building');
    assert.ok(create['x-error-codes'].includes('HANDYMAN_SERVICE_REQUEST_ITEM_INVALID'));
    // The legacy request projection is still documented unchanged.
    assert.ok(
      spec.components.schemas.HandymanCareStandaloneRequest,
      'the legacy request schema must remain',
    );
  });

  it('the runtime implementation reuses the advanced item engine and the Building-scoped read', () => {
    assert.match(gatewayService, /addCareHandymanServiceRequestItemInTransaction/);
    assert.match(gatewayService, /listBuildingCareRequestItems/);
    // No second authentication path / BM exchange credential is introduced.
    assert.equal(/exchangeToken/.test(gatewayService), false);
  });
});
