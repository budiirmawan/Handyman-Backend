import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';

import { resetAppConfigCache } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { floorService } from '../src/modules/floors';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
import {
  addHandymanServiceRequestItem,
  importHandymanServiceCatalogStarter,
  listHandymanServiceRequestItems,
  resolveHandymanRequestItemPrice,
  updateHandymanServiceRequestItem,
} from '../src/modules/handyman-parameterized-catalog';
import { createAdminUser } from './helpers/access';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 PART 01 — structured Service Catalog
 * intake for the Building-scoped Customer Care create gateway.
 *
 * Focused E2E contract suite against a DISPOSABLE embedded PostgreSQL:
 *
 *   1. authorized Care structured create (multi-item, variant inheritance,
 *      reported UOM, per-item note, access condition) with authoritative
 *      persisted readback and provenance;
 *   2. quantity / UOM validation (precision grammar, unknown / cross-
 *      Client / inactive UOM, bounded item count);
 *   3. variant and technical-attribute validation (wrong-service variant,
 *      inactive variant, no-silent-contradiction);
 *   4. ambiguous mixed legacy+structured payload rejection;
 *   5. legacy single-service Care compatibility (unchanged projection,
 *      zero items);
 *   6. Tenant/Building isolation (non-enumerating Care denial);
 *   7. idempotent replay without duplication + 409 on a different item
 *      set + no poisoned claim after a failed structured attempt;
 *   8. inspection-first preservation (no quotation, no price resolution,
 *      INTAKE state);
 *   9. BM/Operations structured-item engine regression through the
 *      EXISTING `POST /handyman/requests/{id}/items` service lane.
 */

const DIR = '/tmp/cr-hm-be-care-catalog-structured-01-pg';
const PORT = 57891;

const V1 = '/api/v1';
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let database: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | null = null;
let pool: Pool;
let adminUserId = '';

type Realm = {
  clientId: string;
  buildingId: string;
  spaceId: string;
  companyId: string;
  picId: string;
  installationServiceId: string;
  maintenanceServiceId: string;
  variantId: string;
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
    if (pool) await closePool(pool);
    if (database) await database.stop();
  } finally {
    resetAppConfigCache();
    rmSync(DIR, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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
  const email = `care-${tag}@example.test`;
  const password = `Care-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Building Care Staff',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `CARE_CAT_${tag.toUpperCase()}`,
    name: 'Building Care Catalogue',
  });
  const permission = await ensureCarePermission();
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

/** Full tenant realm + parameterized starter catalogue + AC variant. */
async function createRealm(name: string): Promise<Realm> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `CATS_${tag}`,
    name: `${name} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `CATP_${tag}`,
    name: `${name} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `CATB_${tag}`,
    name: `${name} Building`,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `CATT_${tag}`,
      tenantName: `${name} Tenant`,
    },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `CATF_${tag}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `CATA_${tag}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `CATR_${tag}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `CATS_${tag}`,
    name: 'Unit',
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
    email: `cat-pic-${tag.toLowerCase()}@example.test`,
    displayName: 'Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant PIC',
      email: picUser.email,
      userId: picUser.id,
    },
    adminUserId,
  );

  const starter = await importHandymanServiceCatalogStarter(
    client.id,
    adminUserId,
  );
  assert.equal(starter.services.created, 24);

  const serviceId = async (code: string) => {
    const row = await q(
      `SELECT id FROM service_catalog WHERE client_id = $1 AND code = $2`,
      [client.id, code],
    );
    assert.ok(row.rows[0], `starter service ${code} must exist`);
    return row.rows[0].id as string;
  };
  const installationServiceId = await serviceId('AC_INSTALLATION');
  const maintenanceServiceId = await serviceId('AC_MAINTENANCE');

  // A governed variant configuring the AC vocabulary of the installation
  // service (the PART 03 inheritance fixture idiom).
  const variantRow = await q(
    `INSERT INTO handyman_service_variants
       (id, client_id, service_catalog_id, code, name, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
     RETURNING id`,
    [id(), client.id, installationServiceId, `AC_15PK_${tag}`, '1.5 PK inverter', adminUserId],
  );
  const variantId = variantRow.rows[0].id as string;
  const attributeId = async (code: string) => {
    const row = await q(
      `SELECT id FROM handyman_service_attributes
        WHERE client_id = $1 AND service_catalog_id = $2 AND code = $3`,
      [client.id, installationServiceId, code],
    );
    assert.ok(row.rows[0], `attribute ${code} must exist`);
    return row.rows[0].id as string;
  };
  const configure = async (attribute: string, text: string | null, number: number | null) => {
    await q(
      `INSERT INTO handyman_service_variant_attributes
         (id, client_id, service_variant_id, attribute_id, value_text,
          value_number, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)`,
      [id(), client.id, variantId, attribute, text, number, adminUserId],
    );
  };
  await configure(await attributeId('AC_CAPACITY'), null, 1.5);
  await configure(await attributeId('AC_TYPE'), 'SPLIT', null);
  await configure(await attributeId('AC_DRIVE_TYPE'), 'INVERTER', null);

  const uom = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 AND code = 'HM_UNIT'`,
    [client.id],
  );
  assert.ok(uom.rows[0], 'the starter import must create the HM_UNIT UOM');

  return {
    clientId: client.id,
    buildingId: building.id,
    spaceId: space.id,
    companyId: company.id,
    picId: pic.id,
    installationServiceId,
    maintenanceServiceId,
    variantId,
    unitUomId: uom.rows[0].id as string,
  };
}

const postGateway = (
  token: string,
  buildingId: string,
  body: unknown,
  idempotencyKey?: string,
) => {
  const req = api()
    .post(`${V1}/handyman/care/buildings/${buildingId}/requests`)
    .set(auth(token));
  if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
};

const detailPath = (buildingId: string, requestId: string) =>
  `${V1}/handyman/care/buildings/${buildingId}/requests/${requestId}`;

function structuredBody(realm: Realm, overrides: Record<string, unknown> = {}) {
  return {
    tenantCompanyId: realm.companyId,
    tenantPicId: realm.picId,
    spaceId: realm.spaceId,
    description: 'Two AC problems reported by the tenant',
    items: [
      {
        serviceCatalogId: realm.installationServiceId,
        serviceVariantId: realm.variantId,
        quantity: 2,
        uomId: realm.unitUomId,
        attributeValues: { AC_EXISTING_UNIT: 'NO' },
        itemDescription: 'Install one unit in the bedroom',
        accessCondition: 'HIGH_FLOOR',
      },
      {
        serviceCatalogId: realm.maintenanceServiceId,
        quantity: 1.5,
        attributeValues: { REPORTED_SYMPTOM: 'weak cooling' },
      },
    ],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Contract                                                            */
/* ------------------------------------------------------------------ */

describe('CR-HM-BE-CARE-CATALOG-STRUCTURED-01 PART 01 structured Care intake', () => {
  it('1: authorized Care structured create persists mixed items with provenance and authoritative readback', async () => {
    const realm = await createRealm('Structured main');
    const care = await createCareStaff(realm.buildingId);
    const key = randomUUID();

    const res = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm),
      key,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const created = res.body.data;
    // The canonical 201 projection is UNCHANGED (legacy shape); the anchor
    // service/variant is the FIRST structured item.
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
    assert.equal(created.serviceCatalogId, realm.installationServiceId);
    assert.equal(created.serviceVariantId, realm.variantId);

    // Authoritative readback: persisted items, quantities, UOM, notes,
    // effective attributes and the inherited provenance.
    const detail = await api()
      .get(detailPath(realm.buildingId, created.id))
      .set(auth(care.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const items = detail.body.data.items as Record<string, any>[];
    assert.equal(items.length, 2);

    const install = items.find(
      (item) => item.serviceCatalogId === realm.installationServiceId,
    )!;
    assert.equal(install.quantity, 2);
    assert.equal(install.uomId, realm.unitUomId);
    assert.equal(install.itemDescription, 'Install one unit in the bedroom');
    assert.equal(install.accessCondition, 'HIGH_FLOOR');
    assert.equal(install.serviceVariantId, realm.variantId);
    // Effective set = variant values + own value; provenance = variant part.
    assert.deepEqual(install.attributeValues, {
      AC_CAPACITY: '1.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
      AC_EXISTING_UNIT: 'NO',
    });
    assert.deepEqual(install.inheritedAttributeValues, {
      AC_CAPACITY: '1.5',
      AC_TYPE: 'SPLIT',
      AC_DRIVE_TYPE: 'INVERTER',
    });

    const maintenance = items.find(
      (item) => item.serviceCatalogId === realm.maintenanceServiceId,
    )!;
    assert.equal(maintenance.quantity, 1.5);
    assert.equal(maintenance.uomId, null);
    assert.equal(maintenance.itemDescription, null);
    assert.equal(maintenance.accessCondition, 'STANDARD');
    assert.deepEqual(maintenance.attributeValues, {
      REPORTED_SYMPTOM: 'weak cooling',
    });
    assert.deepEqual(maintenance.inheritedAttributeValues, {});

    // Nothing was silently dropped: both rows exist with their quantities.
    const rows = await q(
      `SELECT quantity::text AS quantity, uom_id, item_description
         FROM handyman_service_request_items
        WHERE handyman_request_id = $1 ORDER BY created_at ASC, id ASC`,
      [created.id],
    );
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(
      rows.rows.map((row) => row.quantity).sort(),
      ['1.5000', '2.0000'],
    );
  });

  it('2: inspection-first is preserved — no quotation and no price resolution exists after a structured create', async () => {
    const realm = await createRealm('Structured inspection-first');
    const care = await createCareStaff(realm.buildingId);
    const res = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm),
      randomUUID(),
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'INTAKE');

    const quotations = await q(
      `SELECT id FROM handyman_quotations WHERE handyman_request_id = $1`,
      [res.body.data.id],
    );
    assert.equal(quotations.rowCount, 0);
    const resolutions = await q(
      `SELECT id FROM handyman_service_quote_resolutions WHERE handyman_request_id = $1`,
      [res.body.data.id],
    );
    assert.equal(resolutions.rowCount, 0);
  });

  it('3: required technical attributes stay missing (never fabricated) and the existing price validator routes the item to inspection', async () => {
    const realm = await createRealm('Structured required attributes');
    const care = await createCareStaff(realm.buildingId);
    const res = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.installationServiceId,
            quantity: 1,
            // Required technical attributes are not guessed at intake;
            // the existing quote resolver owns this semantic check.
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const persisted = await listHandymanServiceRequestItems(
      res.body.data.id,
      care.userId,
      'ACTIVE',
    );
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0].attributeValues, {});
    assert.deepEqual(persisted[0].inheritedAttributeValues, {});

    const resolution = await resolveHandymanRequestItemPrice(
      persisted[0] as never,
      {
        clientId: realm.clientId,
        buildingId: realm.buildingId,
        effectiveAt: new Date(),
      },
    );
    assert.equal(resolution.outcome, 'INSPECTION_REQUIRED');
    assert.equal(resolution.reasonCode, 'ATTRIBUTE_MISSING');
    assert.match(resolution.reasonDetail ?? '', /Required attribute/);
  });

  it('4: ambiguous mixed legacy + structured payload is rejected', async () => {
    const realm = await createRealm('Structured mixed');
    const care = await createCareStaff(realm.buildingId);
    const res = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, { serviceCatalogId: realm.maintenanceServiceId }),
      randomUUID(),
    );
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.match(JSON.stringify(res.body.error), /Ambiguous/);

    // Explicit null is not an escape hatch back to legacy and must not
    // silently discard a structured array or technical attributes.
    const nullItems = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, { items: null }),
      randomUUID(),
    );
    assert.equal(nullItems.status, 400, JSON.stringify(nullItems.body));
    const nullAttributes = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1,
            attributeValues: null,
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(
      nullAttributes.status,
      400,
      JSON.stringify(nullAttributes.body),
    );
    const blankItemDescription = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1,
            itemDescription: '   ',
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(
      blankItemDescription.status,
      400,
      JSON.stringify(blankItemDescription.body),
    );
  });

  it('5: legacy single-service Care create is unchanged and carries zero structured items', async () => {
    const realm = await createRealm('Structured legacy');
    const care = await createCareStaff(realm.buildingId);
    const res = await postGateway(
      care.token,
      realm.buildingId,
      {
        tenantCompanyId: realm.companyId,
        tenantPicId: realm.picId,
        spaceId: realm.spaceId,
        serviceCatalogId: realm.maintenanceServiceId,
        description: 'Legacy tap leak',
      },
      randomUUID(),
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.serviceCatalogId, realm.maintenanceServiceId);
    assert.equal(res.body.data.serviceVariantId, null);

    const detail = await api()
      .get(detailPath(realm.buildingId, res.body.data.id))
      .set(auth(care.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(detail.body.data.items, []);
  });

  it('6: quantity grammar is validated at the edge (zero, negative and >4 decimal places rejected)', async () => {
    const realm = await createRealm('Structured quantity');
    const care = await createCareStaff(realm.buildingId);
    for (const quantity of [0, -1, 1.23456, 1e-5, 1e14]) {
      const res = await postGateway(
        care.token,
        realm.buildingId,
        structuredBody(realm, {
          items: [
            { serviceCatalogId: realm.maintenanceServiceId, quantity },
          ],
        }),
        randomUUID(),
      );
      assert.equal(res.status, 400, `${quantity}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('7: reported UOM must be an ACTIVE units_of_measure master of the server-derived Client', async () => {
    const realm = await createRealm('Structured uom');
    const care = await createCareStaff(realm.buildingId);

    // Unknown / foreign UUID.
    const unknown = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1,
            uomId: id(),
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));

    // Cross-Client UOM.
    const other = await createRealm('Structured uom foreign');
    const foreign = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1,
            uomId: other.unitUomId,
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(foreign.status, 400, JSON.stringify(foreign.body));

    // Retired (INACTIVE) UOM of the same Client.
    const inactiveId = id();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category, status)
       VALUES ($1, $2, $3, 'Retired unit', 'u', 'COUNT', 'INACTIVE')`,
      [inactiveId, realm.clientId, `RETIRED_${suffix()}`],
    );
    const inactive = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1,
            uomId: inactiveId,
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(inactive.status, 400, JSON.stringify(inactive.body));
  });

  it('8: variant applicability and technical-attribute contradictions are refused', async () => {
    const realm = await createRealm('Structured variant');
    const care = await createCareStaff(realm.buildingId);

    // A variant of ANOTHER service of the same Client.
    const wrongServiceVariant = await q(
      `INSERT INTO handyman_service_variants
         (id, client_id, service_catalog_id, code, name, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
       RETURNING id`,
      [
        id(),
        realm.clientId,
        realm.maintenanceServiceId,
        `WRONG_${suffix()}`,
        'Wrong service variant',
        adminUserId,
      ],
    );
    const wrong = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.installationServiceId,
            quantity: 1,
            serviceVariantId: wrongServiceVariant.rows[0].id,
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));

    // An INACTIVE variant of the right service.
    const inactiveVariantId = id();
    await q(
      `INSERT INTO handyman_service_variants
         (id, client_id, service_catalog_id, code, name, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'INACTIVE', $6)`,
      [
        inactiveVariantId,
        realm.clientId,
        realm.installationServiceId,
        `INACT_${suffix()}`,
        'Retired variant',
        adminUserId,
      ],
    );
    const inactive = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.installationServiceId,
            quantity: 1,
            serviceVariantId: inactiveVariantId,
          },
        ],
      }),
      randomUUID(),
    );
    // The canonical request's frozen single-service anchor validates its
    // selected variant before the item engine (the existing authority code
    // uses 409 for an inactive request variant).
    assert.equal(inactive.status, 409, JSON.stringify(inactive.body));
    assert.equal(
      inactive.body.error.code,
      'HANDYMAN_SERVICE_VARIANT_NOT_ACTIVE',
    );

    // No silent contradiction: the variant configures AC_CAPACITY=1.5.
    const contradiction = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.installationServiceId,
            serviceVariantId: realm.variantId,
            quantity: 1,
            attributeValues: { AC_CAPACITY: '9.9' },
          },
        ],
      }),
      randomUUID(),
    );
    assert.equal(contradiction.status, 400, JSON.stringify(contradiction.body));
    assert.equal(
      contradiction.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
    );
  });

  it('9: an oversized multi-item payload is rejected at the edge', async () => {
    const realm = await createRealm('Structured bound');
    const care = await createCareStaff(realm.buildingId);
    const items = Array.from({ length: 51 }, () => ({
      serviceCatalogId: realm.maintenanceServiceId,
      quantity: 1,
    }));
    const res = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, { items }),
      randomUUID(),
    );
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('10: Tenant/Building isolation — foreign Building staff and foreign Tenants are non-enumerably denied', async () => {
    const realmA = await createRealm('Structured isolation A');
    const realmB = await createRealm('Structured isolation B');
    const careA = await createCareStaff(realmA.buildingId);
    const careB = await createCareStaff(realmB.buildingId);

    // Realm-B staff may not create in Realm-A's Building.
    const foreignBuilding = await postGateway(
      careB.token,
      realmA.buildingId,
      structuredBody(realmA),
      randomUUID(),
    );
    assert.equal(foreignBuilding.status, 403);
    assert.equal(
      foreignBuilding.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );

    const ownRequest = await postGateway(
      careA.token,
      realmA.buildingId,
      structuredBody(realmA),
      randomUUID(),
    );
    assert.equal(ownRequest.status, 201, JSON.stringify(ownRequest.body));
    const foreignDetail = await api()
      .get(detailPath(realmA.buildingId, ownRequest.body.data.id))
      .set(auth(careB.token));
    assert.equal(foreignDetail.status, 403, JSON.stringify(foreignDetail.body));
    assert.equal(
      foreignDetail.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );

    // Realm-A staff may not represent a Tenant of another Building/Client.
    const foreignTenant = await postGateway(
      careA.token,
      realmA.buildingId,
      structuredBody(realmA, { tenantCompanyId: realmB.companyId }),
      randomUUID(),
    );
    assert.equal(foreignTenant.status, 403);
    assert.equal(foreignTenant.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    // The same wall holds for structured items that reference a foreign
    // Client's catalogue service.
    const foreignService = await postGateway(
      careA.token,
      realmA.buildingId,
      structuredBody(realmA, {
        items: [
          { serviceCatalogId: realmB.maintenanceServiceId, quantity: 1 },
        ],
      }),
      randomUUID(),
    );
    assert.equal(foreignService.status, 400, JSON.stringify(foreignService.body));
  });

  it('11: idempotent replay returns the stored body without duplicating items; a different item set is 409', async () => {
    const realm = await createRealm('Structured idempotency');
    const care = await createCareStaff(realm.buildingId);
    const key = randomUUID();
    const body = structuredBody(realm);

    const first = await postGateway(care.token, realm.buildingId, body, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const replay = await postGateway(care.token, realm.buildingId, body, key);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body);

    const rows = await q(
      `SELECT COUNT(*)::int AS count FROM handyman_service_request_items
        WHERE handyman_request_id = $1`,
      [first.body.data.id],
    );
    assert.equal(rows.rows[0].count, 2);

    // Same key, different submission -> 409, never a silent replay.
    const different = structuredBody(realm);
    (different.items as Record<string, unknown>[])[1].quantity = 3;
    const conflict = await postGateway(
      care.token,
      realm.buildingId,
      different,
      key,
    );
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('12: a failed structured attempt leaves no poisoned idempotency claim', async () => {
    const realm = await createRealm('Structured claim rollback');
    const care = await createCareStaff(realm.buildingId);
    const key = randomUUID();

    const failed = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm, {
        items: [
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1,
            uomId: id(), // unknown UOM — fails inside the claim transaction
          },
        ],
      }),
      key,
    );
    assert.equal(failed.status, 400, JSON.stringify(failed.body));

    // The claim rolled back with the business writes: the SAME key with a
    // corrected submission must succeed and persist exactly one request.
    const corrected = await postGateway(
      care.token,
      realm.buildingId,
      structuredBody(realm),
      key,
    );
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
    const items = await q(
      `SELECT COUNT(*)::int AS count FROM handyman_service_request_items
        WHERE handyman_request_id = $1`,
      [corrected.body.data.id],
    );
    assert.equal(items.rows[0].count, 2);
  });

  it('13: the EXISTING BM/Operations structured-item engine lane keeps working with the extended fields (regression)', async () => {
    const realm = await createRealm('Structured engine regression');
    const care = await createCareStaff(realm.buildingId);

    // A legacy Care create (the frozen single-service seam) — the same
    // request an Operations/BM exchange flow would receive.
    const created = await postGateway(
      care.token,
      realm.buildingId,
      {
        tenantCompanyId: realm.companyId,
        spaceId: realm.spaceId,
        serviceCatalogId: realm.maintenanceServiceId,
        description: 'Engine regression request',
      },
      randomUUID(),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    // The EXISTING engine entry keeps its signature and now persists the
    // reported UOM + per-item note.
    const added = await addHandymanServiceRequestItem(
      requestId,
      {
        serviceCatalogId: realm.maintenanceServiceId,
        quantity: 3,
        uomId: realm.unitUomId,
        itemDescription: 'Operations-added item',
        attributeValues: { REPORTED_SYMPTOM: 'noise' },
        accessCondition: 'RESTRICTED',
      },
      care.userId,
    );
    assert.equal(added.quantity, 3);
    assert.equal(added.uomId, realm.unitUomId);
    assert.equal(added.itemDescription, 'Operations-added item');
    assert.equal(added.accessCondition, 'RESTRICTED');

    // The reserved access-condition key wall is unchanged.
    await assert.rejects(
      () =>
        addHandymanServiceRequestItem(
          requestId,
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1,
            attributeValues: { ACCESS_CONDITION: 'STANDARD' },
          },
          care.userId,
        ),
      /reserved key/,
    );

    // The quantity grammar applies to the existing lane as well.
    await assert.rejects(
      () =>
        addHandymanServiceRequestItem(
          requestId,
          {
            serviceCatalogId: realm.maintenanceServiceId,
            quantity: 1.23456,
          },
          care.userId,
        ),
      /decimal places/,
    );

    // The governed correction lane can restate or clear the new fields.
    const updated = await updateHandymanServiceRequestItem(
      requestId,
      added.id,
      { itemDescription: 'Corrected note', uomId: null },
      care.userId,
    );
    assert.equal(updated.itemDescription, 'Corrected note');
    assert.equal(updated.uomId, null);

    const listed = await listHandymanServiceRequestItems(
      requestId,
      care.userId,
      'ACTIVE',
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, added.id);
  });
});
