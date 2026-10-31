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
 * CR-HM-BE-CARE-CATALOG-METADATA-01 PART 06 — authorized Building-session
 * catalogue metadata.
 *
 * Focused HTTP suite against a DISPOSABLE embedded PostgreSQL (unique port,
 * removed after the run) with real authenticated sessions. Proves:
 *
 *   - an authorized Care staff session reads the metadata of ONE ACTIVE
 *     service of its own Building's Client;
 *   - technical attributes carry data type, allowed options, constraints and
 *     a DERIVED variant applicability;
 *   - ACTIVE variants expose exactly the attribute values they inherit;
 *   - ACTIVE Client-owned UOM options carry stable ids and display labels;
 *   - INACTIVE services, INACTIVE variants and INACTIVE UOMs stay unavailable;
 *   - no cross-Client service, no cross-Building authority and no
 *     permission-less session can read metadata;
 *   - NO commercial field (pricing mode, price rule, price catalogue
 *     reference, basis, amount, currency) is exposed;
 *   - the SAME metadata drives the PART 04 structured create and readback
 *     unchanged (inheritance provenance agrees cross-endpoint).
 */

const DIR = '/tmp/cr-hm-be-care-catalog-metadata-01-part06-pg';
const PORT = 57943;
const V1 = '/api/v1';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let database: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | null = null;
let pool: Pool;
let adminUserId = '';

type Realm = {
  clientId: string;
  propertyId: string;
  buildingId: string;
  companyId: string;
  picId: string;
  spaceId: string;
  acServiceId: string;
  acVariantId: string;
  simpleServiceId: string;
};

const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

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
  const email = `care-p06-${tag}@example.test`;
  const password = `Care-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Building Care Staff',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `CARE_P06_${tag.toUpperCase()}`,
    name: 'Building Care Metadata Part 06',
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
    code: `P6C_${tag}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P6P_${tag}`,
    name: `${label} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `P6B_${tag}`,
    name: `${label} Building`,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `P6T_${tag}`, tenantName: `${label} Tenant` },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `P6F_${tag}`,
    name: 'Part06 floor',
    levelNumber: 2,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `P6A_${tag}`,
    name: 'Part06 area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `P6R_${tag}`,
    name: 'Part06 room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `P6S_${tag}`,
    name: 'Part06 unit',
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
    email: `p6-pic-${tag.toLowerCase()}@example.test`,
    displayName: 'Part06 Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Part06 Tenant PIC',
      email: picUser.email,
      userId: picUser.id,
    },
    adminUserId,
  );

  const simpleService = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `P6SV_${tag}`,
      name: `${label} simple repair`,
      category: 'HANDYMAN',
    },
    adminUserId,
  );

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
     VALUES ($1, $2, $3, 'P6_AC_05_NON_INVERTER', 'AC 0.5 PK non-inverter',
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

  return {
    clientId: client.id,
    propertyId: property.id,
    buildingId: building.id,
    companyId: company.id,
    picId: pic.id,
    spaceId: space.id,
    acServiceId,
    acVariantId: variantId,
    simpleServiceId: simpleService.id,
  };
}

const getMetadata = (
  token: string,
  buildingId: string,
  serviceCatalogId: string,
) =>
  api()
    .get(
      `${V1}/handyman/care/buildings/${buildingId}/catalogue/services/${serviceCatalogId}`,
    )
    .set(auth(token));

/** Every object key reachable in a JSON value. */
function allKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, acc);
    return acc;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    acc.add(key);
    allKeys(inner, acc);
  }
  return acc;
}

describe('PART 06 — authorized Building-session catalogue metadata', () => {
  it('1: an authorized Care staff session reads one ACTIVE service with dynamic technical attributes', async () => {
    const realm = await createRealm('Metadata');
    const care = await createCareStaff(realm.buildingId);

    const res = await getMetadata(care.token, realm.buildingId, realm.acServiceId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;

    assert.equal(data.service.id, realm.acServiceId);
    assert.equal(data.service.code, 'AC_INSTALLATION');
    assert.equal(data.service.status, 'ACTIVE');
    assert.equal(typeof data.service.name, 'string');
    // The Client is never serialized: scope is proven server-side.
    assert.equal(Object.prototype.hasOwnProperty.call(data.service, 'clientId'), false);

    // Dynamic attribute definitions, ordered by the governed sortOrder.
    assert.deepEqual(
      data.attributes.map((attribute: { code: string }) => attribute.code),
      ['AC_CAPACITY', 'AC_TYPE', 'AC_DRIVE_TYPE'],
    );
    const [capacity, type, drive] = data.attributes.map((a: unknown) => a) as any[];

    assert.equal(capacity.dataType, 'NUMBER');
    assert.equal(capacity.unit, 'PK');
    assert.equal(capacity.required, true);
    assert.equal(capacity.allowFreeValue, true);
    assert.equal(capacity.sortOrder, 10);
    assert.equal(capacity.status, 'ACTIVE');
    assert.ok(Array.isArray(capacity.allowedValues));
    assert.deepEqual(capacity.allowedValues[0], { code: '0.5', label: '0.5 PK' });
    assert.equal(capacity.allowedValues.length, 11);

    assert.equal(type.dataType, 'ENUM');
    assert.equal(type.required, true);
    assert.equal(type.allowFreeValue, false);
    assert.deepEqual(
      type.allowedValues.map((option: { code: string }) => option.code),
      ['SPLIT', 'CASSETTE', 'STANDING', 'DUCTED'],
    );
    assert.deepEqual(type.allowedValues[0], { code: 'SPLIT', label: 'Split' });

    assert.equal(drive.dataType, 'ENUM');
    assert.equal(drive.sortOrder, 30);
    assert.deepEqual(
      drive.allowedValues.map((option: { code: string }) => option.code),
      ['INVERTER', 'NON_INVERTER'],
    );

    // Derived variant applicability: the ACTIVE variant configures all three.
    for (const attribute of data.attributes) {
      assert.equal(attribute.variantApplicable, true);
    }

    // A service without governed attributes reports an empty list, not a guess.
    const simple = await getMetadata(
      care.token,
      realm.buildingId,
      realm.simpleServiceId,
    );
    assert.equal(simple.status, 200, JSON.stringify(simple.body));
    assert.deepEqual(simple.body.data.attributes, []);
    assert.deepEqual(simple.body.data.variants, []);
  });

  it('2: ACTIVE variants expose exactly the attribute values they inherit', async () => {
    const realm = await createRealm('Inheritance');
    const care = await createCareStaff(realm.buildingId);

    // A second ACTIVE variant that configures NOTHING: it inherits nothing.
    const bareVariantId = randomUUID();
    await sql(
      `INSERT INTO handyman_service_variants
         (id, client_id, service_catalog_id, code, name, status, created_by_user_id)
       VALUES ($1, $2, $3, 'P6_AC_BARE', 'AC bare', 'ACTIVE', $4)`,
      [bareVariantId, realm.clientId, realm.acServiceId, adminUserId],
    );

    const res = await getMetadata(care.token, realm.buildingId, realm.acServiceId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const variants = res.body.data.variants as any[];

    // ACTIVE-only, ordered deterministically by code. `STANDARD` is the
    // starter's own default variant — every ACTIVE variant is listed, and
    // only real variants are listed.
    assert.deepEqual(
      variants.map((variant) => variant.code),
      ['P6_AC_05_NON_INVERTER', 'P6_AC_BARE', 'STANDARD'],
    );

    const configured = variants.find(
      (variant) => variant.id === realm.acVariantId,
    );
    assert.deepEqual(configured.inheritedAttributeCodes, [
      'AC_CAPACITY',
      'AC_DRIVE_TYPE',
      'AC_TYPE',
    ]);
    assert.deepEqual(
      configured.inheritedAttributeValues.map((value: { code: string }) => value.code),
      ['AC_CAPACITY', 'AC_TYPE', 'AC_DRIVE_TYPE'],
    );
    const capacityValue = configured.inheritedAttributeValues.find(
      (value: { code: string }) => value.code === 'AC_CAPACITY',
    );
    assert.equal(capacityValue.attributeId, capacityValue.attributeId.toLowerCase());
    assert.equal(capacityValue.valueNumber, 0.5);
    assert.equal(capacityValue.value, '0.5');
    assert.equal(capacityValue.dataType, 'NUMBER');
    assert.equal(capacityValue.unit, 'PK');
    const typeValue = configured.inheritedAttributeValues.find(
      (value: { code: string }) => value.code === 'AC_TYPE',
    );
    assert.equal(typeValue.valueText, 'SPLIT');
    assert.equal(typeValue.value, 'SPLIT');
    assert.equal(typeValue.valueNumber, null);

    const bare = variants.find((variant) => variant.id === bareVariantId);
    assert.deepEqual(bare.inheritedAttributeValues, []);
    assert.deepEqual(bare.inheritedAttributeCodes, []);
  });

  it('3: ACTIVE Client-owned UOM options carry stable identifiers and display labels', async () => {
    const realm = await createRealm('Uom');
    const care = await createCareStaff(realm.buildingId);

    const res = await getMetadata(care.token, realm.buildingId, realm.acServiceId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const uoms = res.body.data.unitsOfMeasure as any[];
    assert.ok(uoms.length > 0, 'the starter must seed Client UOMs');

    // Every reported option is a REAL ACTIVE Client-owned row.
    const rows = await sql(
      `SELECT id, code, status FROM units_of_measure WHERE client_id = $1`,
      [realm.clientId],
    );
    const activeIds = new Set(
      rows.rows.filter((row) => row.status === 'ACTIVE').map((row) => row.id),
    );
    for (const uom of uoms) {
      assert.ok(activeIds.has(uom.id), `UOM ${uom.code} must be ACTIVE and own`);
      assert.equal(typeof uom.code, 'string');
      assert.equal(uom.displayLabel, `${uom.name} (${uom.symbol})`);
    }
    assert.deepEqual(
      uoms.map((uom) => uom.code).sort(),
      rows.rows
        .filter((row) => row.status === 'ACTIVE')
        .map((row) => row.code)
        .sort(),
    );

    const unit = uoms.find((uom) => uom.code === 'HM_UNIT');
    assert.ok(unit);
    assert.equal(unit.name, 'Unit');
    assert.equal(unit.symbol, 'unit');
    assert.equal(unit.displayLabel, 'Unit (unit)');

    // An INACTIVE UOM disappears from the options...
    await sql(
      `UPDATE units_of_measure SET status = 'INACTIVE'
        WHERE client_id = $1 AND code = 'HM_POINT'`,
      [realm.clientId],
    );
    const after = await getMetadata(care.token, realm.buildingId, realm.acServiceId);
    const afterCodes = (after.body.data.unitsOfMeasure as any[]).map(
      (uom) => uom.code,
    );
    assert.equal(afterCodes.includes('HM_POINT'), false);
    // ...and the applicability statement says WHY there is no per-service list.
    assert.equal(after.body.data.applicability.uomScope, 'CLIENT');
    assert.equal(
      after.body.data.applicability.serviceUomApplicability,
      'NOT_GOVERNED',
    );
  });

  it('4: INACTIVE services and INACTIVE variants stay unavailable', async () => {
    const realm = await createRealm('Inactive');
    const care = await createCareStaff(realm.buildingId);

    // An INACTIVE variant is not selectable, so it is not reported.
    await sql(
      `UPDATE handyman_service_variants SET status = 'INACTIVE' WHERE id = $1`,
      [realm.acVariantId],
    );
    const hiddenVariant = await getMetadata(
      care.token,
      realm.buildingId,
      realm.acServiceId,
    );
    assert.equal(hiddenVariant.status, 200, JSON.stringify(hiddenVariant.body));
    const survivorIds = (hiddenVariant.body.data.variants as any[]).map(
      (variant) => variant.id,
    );
    assert.equal(survivorIds.includes(realm.acVariantId), false);
    // Only the starter's own value-less default variant remains, so no
    // attribute definition is variant-applicable any more.
    assert.deepEqual(
      (hiddenVariant.body.data.variants as any[]).map((v) => v.code),
      ['STANDARD'],
    );
    for (const attribute of hiddenVariant.body.data.attributes) {
      assert.equal(attribute.variantApplicable, false);
    }
    await sql(
      `UPDATE handyman_service_variants SET status = 'ACTIVE' WHERE id = $1`,
      [realm.acVariantId],
    );

    // An INACTIVE attribute definition is retired from the vocabulary.
    await sql(
      `UPDATE handyman_service_attributes SET status = 'INACTIVE'
        WHERE client_id = $1 AND code = 'AC_TYPE'`,
      [realm.clientId],
    );
    const retired = await getMetadata(care.token, realm.buildingId, realm.acServiceId);
    assert.deepEqual(
      (retired.body.data.attributes as any[]).map((a) => a.code),
      ['AC_CAPACITY', 'AC_DRIVE_TYPE'],
    );
    await sql(
      `UPDATE handyman_service_attributes SET status = 'ACTIVE'
        WHERE client_id = $1 AND code = 'AC_TYPE'`,
      [realm.clientId],
    );

    // An INACTIVE service is not readable at all: the create engine would
    // refuse it, so metadata must not advertise it.
    await sql(
      `UPDATE service_catalog SET status = 'INACTIVE' WHERE id = $1`,
      [realm.acServiceId],
    );
    const inactiveService = await getMetadata(
      care.token,
      realm.buildingId,
      realm.acServiceId,
    );
    assert.equal(inactiveService.status, 404, JSON.stringify(inactiveService.body));
    assert.equal(
      inactiveService.body.error.code,
      'SERVICE_CATALOG_NOT_FOUND',
    );
    // The list endpoint agrees: it never advertises the inactive service.
    const list = await api()
      .get(`${V1}/handyman/care/buildings/${realm.buildingId}/catalogue/services`)
      .set(auth(care.token));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(
      list.body.data.some(
        (entry: { service: { id: string } }) => entry.service.id === realm.acServiceId,
      ),
      false,
    );
  });

  it('5: cross-Client and cross-Building reads are rejected without enumerating', async () => {
    const realm = await createRealm('Isolation');
    const foreign = await createRealm('Isolation foreign');
    const care = await createCareStaff(realm.buildingId);

    // A service of ANOTHER Client through the authorized Building: the same
    // 404 an absent id produces, never an existence oracle.
    const crossClient = await getMetadata(
      care.token,
      realm.buildingId,
      foreign.acServiceId,
    );
    assert.equal(crossClient.status, 404, JSON.stringify(crossClient.body));
    assert.equal(crossClient.body.error.code, 'SERVICE_CATALOG_NOT_FOUND');

    const unknown = await getMetadata(
      care.token,
      realm.buildingId,
      randomUUID(),
    );
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'SERVICE_CATALOG_NOT_FOUND');
    // ...byte-identical error shape, so the two are indistinguishable.
    assert.equal(
      JSON.stringify(Object.keys(crossClient.body.error).sort()),
      JSON.stringify(Object.keys(unknown.body.error).sort()),
    );

    // A sibling Building in the SAME Client: staff assigned only to the
    // sibling is not authorized for THIS Building.
    const sibling = await buildingService.createBuilding({
      propertyId: realm.propertyId,
      code: `P6SIB_${suffix()}`,
      name: 'Sibling building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: sibling.id,
    });
    const siblingCare = await createCareStaff(sibling.id);
    const denied = await getMetadata(
      siblingCare.token,
      realm.buildingId,
      realm.acServiceId,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    // The catalogue itself is CLIENT-scoped (not Building-scoped): the sibling
    // staff legitimately reads the same Client's service through its OWN
    // Building, and still cannot see the foreign Client's service there.
    const viaSibling = await getMetadata(
      siblingCare.token,
      sibling.id,
      realm.acServiceId,
    );
    assert.equal(viaSibling.status, 200, JSON.stringify(viaSibling.body));
    const foreignViaSibling = await getMetadata(
      siblingCare.token,
      sibling.id,
      foreign.acServiceId,
    );
    assert.equal(foreignViaSibling.status, 404);

    // Another Client's Care staff cannot read this service through its Building.
    const foreignCare = await createCareStaff(foreign.buildingId);
    const otherClient = await getMetadata(
      foreignCare.token,
      foreign.buildingId,
      realm.acServiceId,
    );
    assert.equal(otherClient.status, 404, JSON.stringify(otherClient.body));
  });

  it('6: a session without the Care Building permission is rejected', async () => {
    const realm = await createRealm('Permission');
    const tag = suffix().toLowerCase();
    const email = `plain-p06-${tag}@example.test`;
    const password = `Plain-${tag}!Password1`;
    const plain = await userService.createUser({
      email,
      displayName: 'No Permission',
    });
    await credentialService.createInitialCredential({
      userId: plain.id,
      password,
    });
    await buildingAssignmentService.createAssignment(plain.id, {
      buildingId: realm.buildingId,
    });
    const login = await api()
      .post(`${V1}/auth/login`)
      .send({ email, password });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const denied = await getMetadata(
      login.body.data.sessionToken as string,
      realm.buildingId,
      realm.acServiceId,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const anonymous = await api().get(
      `${V1}/handyman/care/buildings/${realm.buildingId}/catalogue/services/${realm.acServiceId}`,
    );
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

    // Malformed ids are rejected structurally, before any lookup.
    const care = await createCareStaff(realm.buildingId);
    const malformed = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.buildingId}/catalogue/services/not-a-uuid`,
      )
      .set(auth(care.token));
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));

    // Unknown query keys and a body are refused, like every Care read.
    const withQuery = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.buildingId}/catalogue/services/${realm.acServiceId}?clientId=${realm.clientId}`,
      )
      .set(auth(care.token));
    assert.equal(withQuery.status, 400, JSON.stringify(withQuery.body));
  });

  it('7: no commercial field is exposed by the metadata projection', async () => {
    const realm = await createRealm('Commercial');
    const care = await createCareStaff(realm.buildingId);

    const res = await getMetadata(care.token, realm.buildingId, realm.acServiceId);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // The starter DOES create a commercial profile and the pricing policy;
    // neither may leave this projection.
    const profileCount = await sql(
      `SELECT count(*)::int AS total FROM handyman_service_commercial_profiles
        WHERE client_id = $1 AND service_catalog_id = $2`,
      [realm.clientId, realm.acServiceId],
    );
    assert.ok(profileCount.rows[0].total > 0, 'a commercial profile must exist');

    const keys = allKeys(res.body.data);
    for (const forbidden of [
      'pricingMode',
      'commercialProfile',
      'priceRules',
      'priceRuleId',
      'ruleCode',
      'priceCatalogEntryId',
      'priceBasis',
      'attributeSelector',
      'currency',
      'amount',
      'unitAmount',
      'computedTotal',
      'clientId',
    ]) {
      assert.equal(
        keys.has(forbidden),
        false,
        `metadata must not expose ${forbidden}`,
      );
    }

    // Quantity constraints carry BOUNDS ONLY.
    for (const constraint of res.body.data.quantityConstraints) {
      assert.deepEqual(
        Object.keys(constraint).sort(),
        ['maximum', 'minimum', 'serviceVariantId'],
      );
      assert.equal(typeof constraint.serviceVariantId, 'object');
    }

    // The raw price basis token never appears anywhere in the payload.
    const serialized = JSON.stringify(res.body.data);
    assert.equal(serialized.includes('priceBasis'), false);
    assert.equal(serialized.includes('pricingMode'), false);
    assert.equal(serialized.includes('price_catalog'), false);
  });

  it('8: the metadata contract feeds the unchanged PART 04 structured create and readback', async () => {
    const realm = await createRealm('CreateCompat');
    const care = await createCareStaff(realm.buildingId);

    const meta = await getMetadata(
      care.token,
      realm.buildingId,
      realm.acServiceId,
    );
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    const data = meta.body.data;

    // Build the create body ENTIRELY from the metadata contract.
    const variant = data.variants[0];
    const uom = data.unitsOfMeasure.find(
      (option: { code: string }) => option.code === 'HM_UNIT',
    );
    assert.ok(variant && uom);

    const created = await api()
      .post(`${V1}/handyman/care/buildings/${realm.buildingId}/requests`)
      .set(auth(care.token))
      .set('Idempotency-Key', randomUUID())
      .send({
        tenantCompanyId: realm.companyId,
        tenantPicId: realm.picId,
        spaceId: realm.spaceId,
        items: [
          {
            serviceCatalogId: data.service.id,
            serviceVariantId: variant.id,
            quantity: 2,
            uomId: uom.id,
            itemDescription: 'Metadata-driven structured item',
            accessCondition: 'STANDARD',
          },
        ],
      } as never);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const item = created.body.data.items[0];

    // Cross-endpoint agreement: the UOM id the metadata advertised is the
    // UOM the item reports, and the inheritance provenance the variant
    // advertised is exactly what the item materialised.
    assert.equal(item.uomId, uom.id);
    assert.equal(item.serviceVariantId, variant.id);
    assert.equal(item.quantity, 2);
    assert.deepEqual(
      item.inheritedAttributeCodes,
      variant.inheritedAttributeCodes,
    );
    for (const inherited of variant.inheritedAttributeValues) {
      assert.equal(
        item.attributeValues[inherited.code],
        inherited.value,
        `attribute ${inherited.code} must inherit ${inherited.value}`,
      );
    }

    // The GET detail keeps the same agreement, and its shape is unchanged.
    const detail = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.buildingId}/requests/${created.body.data.id}`,
      )
      .set(auth(care.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(
      Object.keys(detail.body.data).sort(),
      ['items', 'progress', 'request'],
    );
    assert.deepEqual(detail.body.data.items, created.body.data.items);
  });
});

describe('PART 06 — focused OpenAPI closure', () => {
  const spec = parseYaml(
    readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
  ) as any;
  const routes = readFileSync(
    resolve(
      __dirname,
      '../src/modules/handyman-care-standalone-discovery/handyman-care-standalone-discovery.routes.ts',
    ),
    'utf8',
  );

  it('documents the Building-session catalogue metadata read', () => {
    const path =
      '/handyman/care/buildings/{buildingId}/catalogue/services/{serviceCatalogId}';
    const op = spec.paths[path]?.get;
    assert.ok(op, `missing OpenAPI operation GET ${path}`);
    assert.equal(op.operationId, 'getBuildingCareCatalogueServiceMetadata');
    assert.equal(op['x-required-permission'], 'handyman.care.building');
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    for (const status of ['200', '400', '401', '403', '404']) {
      assert.ok(op.responses[status], `missing ${status} response`);
    }
    assert.ok(op['x-error-codes'].includes('SERVICE_CATALOG_NOT_FOUND'));
    assert.ok(op['x-error-codes'].includes('HANDYMAN_CARE_AUTHORITY_DENIED'));

    const schema = spec.components.schemas.HandymanCareCatalogueServiceMetadata;
    assert.ok(schema, 'missing metadata schema');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      [...schema.required].sort(),
      ['applicability', 'attributes', 'quantityConstraints', 'service', 'unitsOfMeasure', 'variants'],
    );

    const attribute = spec.components.schemas.HandymanCareCatalogueAttribute;
    for (const key of [
      'dataType',
      'unit',
      'required',
      'allowFreeValue',
      'allowedValues',
      'sortOrder',
      'status',
      'variantApplicable',
    ]) {
      assert.ok(attribute.properties[key], `attribute schema must document ${key}`);
    }
    assert.deepEqual(attribute.properties.dataType.enum, [
      'NUMBER',
      'TEXT',
      'ENUM',
      'BOOLEAN',
    ]);

    const uom = spec.components.schemas.HandymanCareCatalogueUomOption;
    for (const key of ['id', 'code', 'name', 'symbol', 'category', 'displayLabel']) {
      assert.ok(uom.properties[key], `UOM schema must document ${key}`);
    }

    // No commercial FIELD is documented anywhere in the metadata contract.
    // (Prose that explicitly STATES the absence is allowed and desirable, so
    // this asserts over declared property names only.)
    const documentedKeys = new Set<string>();
    for (const name of Object.keys(spec.components.schemas).filter((key) =>
      key.startsWith('HandymanCareCatalogue'),
    )) {
      for (const key of allKeys(spec.components.schemas[name])) {
        documentedKeys.add(key);
      }
    }
    for (const forbidden of [
      'pricingMode',
      'commercialProfile',
      'priceRules',
      'ruleCode',
      'priceCatalogEntryId',
      'priceBasis',
      'currency',
      'amount',
      'unitAmount',
      'clientId',
    ]) {
      assert.equal(
        documentedKeys.has(forbidden),
        false,
        `the metadata contract must not document ${forbidden}`,
      );
    }

    // Runtime cross-checks: the route really exists and reuses Care authority.
    assert.match(
      routes,
      /\/handyman\/care\/buildings\/:buildingId\/catalogue\/services\/:serviceCatalogId/,
    );
    assert.match(routes, /HANDYMAN_CARE_BUILDING_PERMISSION/);
  });
});
