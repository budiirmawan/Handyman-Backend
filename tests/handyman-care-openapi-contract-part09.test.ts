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
 * CR-HM-BE-CARE-OPENAPI-CONTRACT-01 PART 09 — authoritative Care request
 * response schema.
 *
 * Frontend PART 08 passed isolated real HTTP E2E 33/33 but found that the
 * Backend documented `preferredWindowStart`/`preferredWindowEnd` as REQUIRED
 * fields of `HandymanCustomerCareServiceRequest`. They are not part of that
 * read projection at all — the schema did not even declare them as
 * properties. This suite pins BOTH sides:
 *
 *   STATIC  — the documented read contract equals the runtime projection key
 *             for key, in both directions, and the correction propagated to
 *             every schema that composes it;
 *   PRESERVE— the create-side window, `schedulingReadiness`, readiness
 *             records and the paired-optional intake rule are untouched;
 *   RUNTIME — a real HTTP read of a request created WITH a preferred window
 *             returns no window field, while the same preference is intact
 *             and readable through its own readiness contract, and it is not
 *             an appointment;
 *   COMPAT  — PART 04 structured intake and PART 06 catalogue metadata are
 *             unchanged, and no internal-note surface leaked into the
 *             customer-facing projection.
 */

const DIR = '/tmp/cr-hm-be-openapi-contract-01-part09-pg';
const PORT = 57953;
const V1 = '/api/v1';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const spec = parseYaml(
  readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
) as any;
const schemas = spec.components.schemas;

let database: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | null = null;
let pool: Pool;
let adminUserId = '';
let adminSessionToken = '';
const adminToken = () => adminSessionToken;

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
  adminSessionToken = admin.token;
  await grantPlatformAdmin(admin.userId);
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

/**
 * The customer-facing request read (`customerRequestReadScope`) authorizes
 * exactly two actor classes for a request's building: a holder of the
 * `PLATFORM_ADMIN` role, or the represented Tenant PIC with active
 * context/occupancy. The shared test administrator holds an `ADMIN_*` role, so
 * this suite grants the governed `PLATFORM_ADMIN` role to it rather than
 * weakening the wall.
 */
async function grantPlatformAdmin(userId: string) {
  const existing = await sql(
    `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN' LIMIT 1`,
  );
  const roleId =
    existing.rows[0]?.id ??
    (
      await roleService.createRole({
        code: 'PLATFORM_ADMIN',
        name: 'Platform Administrator',
      })
    ).id;
  for (const code of ['tenant_company.read', 'tenant_company.manage']) {
    let permission = await permissionRepository.findByCode(code);
    if (!permission) {
      permission = await permissionService.createPermission({
        code,
        name: code === 'tenant_company.read'
          ? 'Read Tenant Companies'
          : 'Manage Tenant Companies',
      });
    }
    await permissionService.assignPermissionToRole(roleId, permission.id);
  }
  await roleService.assignRoleToUser(userId, roleId);
}

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

/** Care staff whose only extra permission is `handyman.care.building`. */
async function createCareStaff(buildingId: string) {
  const tag = suffix().toLowerCase();
  const email = `care-p09-${tag}@example.test`;
  const password = `Care-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Building Care Staff',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `CARE_P09_${tag.toUpperCase()}`,
    name: 'Care OpenAPI Contract Part 09',
  });
  const permission = await ensureCarePermission();
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

async function createRealm(label: string) {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `P9C_${tag}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P9P_${tag}`,
    name: `${label} Property`,
  });
  // A non-empty, valid building timezone is a PRECONDITION of persisting an
  // initial Care scheduling preference — the readiness engine refuses to
  // guess one.
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `P9B_${tag}`,
    name: `${label} Building`,
    timezone: 'Asia/Jakarta',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `P9T_${tag}`, tenantName: `${label} Tenant` },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `P9F_${tag}`,
    name: 'Part09 floor',
    levelNumber: 3,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `P9A_${tag}`,
    name: 'Part09 area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `P9R_${tag}`,
    name: 'Part09 room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `P9S_${tag}`,
    name: 'Part09 unit',
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
    email: `p9-pic-${tag.toLowerCase()}@example.test`,
    displayName: 'Part09 Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Part09 Tenant PIC',
      email: picUser.email,
      userId: picUser.id,
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
  const errorService = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `P9SV_${tag}`,
      name: `${label} simple repair`,
      category: 'HANDYMAN',
    },
    adminUserId,
  );

  return {
    clientId: client.id,
    propertyId: property.id,
    buildingId: building.id,
    companyId: company.id,
    picId: pic.id,
    spaceId: space.id,
    acServiceId: acService.rows[0].id as string,
    simpleServiceId: errorService.id,
  };
}

function createRequest(
  token: string,
  buildingId: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(`${V1}/handyman/care/buildings/${buildingId}/requests`)
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send(body as never);
}

// ---------------------------------------------------------------------------
// SCOPE 1 + SCOPE 2 — the contract itself
// ---------------------------------------------------------------------------

describe('PART 09 — authoritative read schema (static)', () => {
  it('1: the Care request read schema is key-exact with the runtime projection', () => {
    // The runtime projection, transcribed from `toCustomerCarePublic` —
    // the single function every list/detail/workspace read goes through.
    const runtimeKeys = [
      'id',
      'clientId',
      'channelAttributionId',
      'tenantCompanyId',
      'tenantPicId',
      'buildingId',
      'spaceId',
      'serviceCatalogId',
      'serviceVariantId',
      'originChannel',
      'originReference',
      'description',
      'status',
      'createdByUserId',
      'createdAt',
      'updatedAt',
      'actorType',
      'careActorId',
      'actorReference',
      'attribution',
      'executionScopeId',
    ];

    const schema = schemas.HandymanCustomerCareServiceRequest;
    assert.ok(schema, 'HandymanCustomerCareServiceRequest must exist');

    // THE DEFECT: both names must be gone from `required`.
    for (const field of ['preferredWindowStart', 'preferredWindowEnd']) {
      assert.equal(
        schema.required.includes(field),
        false,
        `${field} must NOT be a required field of the Care read projection`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(schema.properties, field),
        false,
        `${field} must NOT be documented as a property — no fictional field`,
      );
    }

    // `required` is EXACTLY the runtime projection — no drift in either
    // direction, which is the strongest statement the contract can make.
    assert.deepEqual([...schema.required].sort(), [...runtimeKeys].sort());
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      [...runtimeKeys, 'items'].sort(),
      'properties = runtime projection + the optional detail-only `items`',
    );
    // `items` is present but never required (it is detail/create-only).
    assert.equal(schema.required.includes('items'), false);

    // No property is documented that the projection cannot emit.
    for (const key of Object.keys(schema.properties)) {
      assert.ok(
        runtimeKeys.includes(key) || key === 'items',
        `${key} is documented but never serialized`,
      );
    }

    // The nested provenance object must still match its runtime shape.
    const attribution = schemas.HandymanRequestAttributionProvenance;
    assert.deepEqual([...attribution.required].sort(), [
      'actorReference',
      'actorType',
      'careActorId',
      'createdAt',
      'createdByUserId',
      'id',
      'originChannel',
      'originReference',
    ]);
  });

  it('2: every schema that composes the read projection inherits the correction', () => {
    // `CareWorkspaceRequestDetail` / care workspace page / unlisted intake
    // internal-notes list all `$ref` or `allOf` the same schema, so the fix
    // must reach them without a second edit.
    const detail = schemas.CareWorkspaceRequestDetail;
    assert.ok(detail.allOf, 'CareWorkspaceRequestDetail stays an allOf composition');
    assert.deepEqual(detail.allOf[0], {
      $ref: '#/components/schemas/HandymanCustomerCareServiceRequest',
    });
    assert.deepEqual(detail.allOf[1].required, ['items']);

    const page = schemas.CareWorkspaceRequestPage;
    assert.deepEqual(page.properties.items.items, {
      $ref: '#/components/schemas/HandymanCustomerCareServiceRequest',
    });

    // No schema in the Care request READ family may require a preferred
    // window. (Create/readiness schemas legitimately do — asserted in test 3.)
    const readFamily = Object.keys(schemas).filter((name) =>
      /^HandymanCustomerCareServiceRequest$|^CareWorkspaceRequest(Detail|Page)$|^HandymanRequestAttributionProvenance$/.test(
        name,
      ),
    );
    assert.ok(readFamily.length >= 4);
    // Declarations only: prose that EXPLAINS the distinction is allowed and
    // desirable; a documented field is not.
    for (const name of readFamily) {
      const node = schemas[name];
      const declared = new Set<string>([
        ...(node.required ?? []),
        ...Object.keys(node.properties ?? {}),
      ]);
      for (const branch of node.allOf ?? []) {
        for (const field of branch.required ?? []) declared.add(field);
        for (const field of Object.keys(branch.properties ?? {})) declared.add(field);
      }
      for (const field of ['preferredWindowStart', 'preferredWindowEnd']) {
        assert.equal(
          declared.has(field),
          false,
          `${name} must not declare ${field}`,
        );
      }
    }

    // Cross-check against the real route sources: the same schema is what the
    // Care Building session detail and the Care workspace detail serve.
    const routes = readFileSync(
      resolve(__dirname, '../src/modules/handyman-api/handyman-api.routes.ts'),
      'utf8',
    );
    assert.match(routes, /'\/handyman\/requests\/:handymanRequestId'/);
  });

  it('3: the CREATE and readiness contracts keep the preferred window', () => {
    // The window is a create-side fact. These are the contracts that own it
    // and none of them may be weakened by this correction.

    // (a) Care intake bodies still DECLARE the pair as input.
    const careBody = schemas.HandymanCareRequestCreateBody;
    assert.ok(careBody.properties.preferredWindowStart);
    assert.ok(careBody.properties.preferredWindowEnd);
    assert.equal(
      careBody.required.includes('preferredWindowStart'),
      false,
      'the intake pair stays optional at the body level',
    );

    // (b) The exchange-token Care create keeps the same paired-optional rule.
    const exchangeCreate = schemas.CreateCareHandymanServiceRequest;
    assert.ok(exchangeCreate.properties.preferredWindowStart);
    assert.ok(exchangeCreate.properties.preferredWindowEnd);
    const pairedRule = JSON.stringify(exchangeCreate);
    assert.match(pairedRule, /preferredWindowStart/);
    assert.match(pairedRule, /preferredWindowEnd/);

    // (c) `schedulingReadiness` — the create RESPONSE fact — still REQUIRES
    //     the window. The same instants exist; they simply are not part of
    //     the request read projection.
    const preference = schemas.HandymanCareSchedulingPreference;
    assert.deepEqual([...preference.required].sort(), [
      'id',
      'preferredWindowEnd',
      'preferredWindowStart',
      'status',
      'supersedesReadinessId',
      'timezone',
    ]);

    // (d) The governed readiness record still requires both instants whose
    //     storage columns are NOT NULL.
    const readiness = schemas.HandymanSchedulingReadinessRecord;
    for (const field of ['preferredWindowStart', 'preferredWindowEnd']) {
      assert.ok(
        readiness.required.includes(field),
        `${field} stays required on the readiness record`,
      );
    }

    // (e) A proposal/preference is never a confirmed appointment: the
    //     appointment contract still declares its own confirmed bounds.
    const appointment = Object.keys(schemas).filter((name) =>
      /Appointment/.test(name),
    );
    assert.ok(appointment.length > 0, 'appointment schemas must still exist');
  });

  it('4: the OpenAPI document still parses and every $ref resolves', () => {
    let refs = 0;
    const missing: string[] = [];
    const walk = (value: unknown) => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (key === '$ref' && typeof inner === 'string') {
          refs += 1;
          let cursor: any = spec;
          for (const part of inner.replace(/^#\//, '').split('/')) {
            cursor = cursor?.[part];
          }
          if (cursor === undefined) missing.push(inner);
        } else {
          walk(inner);
        }
      }
    };
    walk(spec);
    assert.ok(refs > 20000, `expected a large reference graph, saw ${refs}`);
    assert.deepEqual(missing, [], 'no unresolved internal reference');
    assert.equal(spec.openapi.startsWith('3.'), true);
  });
});

// ---------------------------------------------------------------------------
// SCOPE 3 — runtime compatibility
// ---------------------------------------------------------------------------

describe('PART 09 — runtime behaviour is unchanged', () => {
  it('5: a Care request read serializes exactly the documented fields and no window', async () => {
    const realm = await createRealm('ReadShape');
    const care = await createCareStaff(realm.buildingId);

    const created = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      serviceCatalogId: realm.simpleServiceId,
      description: 'Part 09 read shape',
    } as never);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    // The AUTHORITATIVE read endpoint for `HandymanCustomerCareServiceRequest`.
    const detail = await api()
      .get(`${V1}/handyman/requests/${requestId}`)
      .set(auth(adminToken()));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const data = detail.body.data;

    const schema = schemas.HandymanCustomerCareServiceRequest;
    assert.deepEqual(
      Object.keys(data).sort(),
      [...schema.required].sort(),
      'the runtime body must be exactly the documented required set',
    );
    for (const field of ['preferredWindowStart', 'preferredWindowEnd']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(data, field),
        false,
        `${field} must not be serialized`,
      );
    }

    // The list projection is the SAME function and the same shape. The list
    // route documents and returns `data` as an ARRAY of this schema.
    const list = await api()
      .get(`${V1}/handyman/requests`)
      .query({ clientId: realm.clientId, buildingId: realm.buildingId })
      .set(auth(adminToken()));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(Array.isArray(list.body.data), true, 'list data is an array');
    const listed = (list.body.data as any[]).find(
      (row) => row.id === requestId,
    );
    assert.ok(listed, 'the created request must appear in the list');
    assert.deepEqual(Object.keys(listed).sort(), [...schema.required].sort());
    assert.deepEqual(listed, data, 'list and detail share one projection');

    // The documented VALUE DOMAIN must admit what the runtime emits: a
    // Backend Care staff intake is written on the CUSTOMER_CARE_BACKEND
    // channel, which the read contract used to document as BM-only.
    for (const [label, node, value] of [
      ['request.originChannel', schema.properties.originChannel, data.originChannel],
      [
        'request.attribution.originChannel',
        schemas.HandymanRequestAttributionProvenance.properties.originChannel,
        data.attribution.originChannel,
      ],
    ] as const) {
      assert.ok(
        (node.enum as string[]).includes(value as string),
        `${label}: documented enum ${JSON.stringify(node.enum)} must admit runtime value ${value}`,
      );
    }
    assert.deepEqual(schema.properties.originChannel.enum, [
      'BM_SUPER_APP',
      'CUSTOMER_CARE_BACKEND',
    ]);
    // The governed domain enum is the source of truth for the values above.
    const originChannels = readFileSync(
      resolve(
        __dirname,
        '../src/modules/handyman-channel-attributions/handyman-channel-attribution.types.ts',
      ),
      'utf8',
    );
    for (const value of schema.properties.originChannel.enum) {
      assert.ok(
        originChannels.includes(`'${value}'`),
        `${value} must be a governed origin channel`,
      );
    }

    // `actorType` is nullable on a Care-staff intake (the acting identity is
    // the staff user, not an external care actor) and the doc says so.
    assert.equal(schema.properties.actorType.nullable, true);
    if (data.actorType !== null) {
      assert.ok(schema.properties.actorType.enum.includes(data.actorType));
    }
  });

  it('6: the preferred window survives intake and stays out of the request projection', async () => {
    const realm = await createRealm('Window');
    const care = await createCareStaff(realm.buildingId);

    const preferredWindowStart = '2027-03-01T02:00:00.000Z';
    const preferredWindowEnd = '2027-03-01T05:00:00.000Z';

    const created = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      serviceCatalogId: realm.simpleServiceId,
      description: 'Part 09 window',
      preferredWindowStart,
      preferredWindowEnd,
    } as never);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const createdData = created.body.data;

    // CREATE contract: the preference is returned as `schedulingReadiness`,
    // with exactly the fields `HandymanCareSchedulingPreference` requires.
    const readiness = createdData.schedulingReadiness;
    assert.ok(readiness, 'the create response must carry schedulingReadiness');
    assert.deepEqual(
      Object.keys(readiness).sort(),
      [...schemas.HandymanCareSchedulingPreference.required].sort(),
    );
    assert.equal(readiness.preferredWindowStart, preferredWindowStart);
    assert.equal(readiness.preferredWindowEnd, preferredWindowEnd);
    assert.equal(readiness.timezone, 'Asia/Jakarta');
    assert.equal(readiness.status, 'ACTIVE');
    assert.equal(readiness.supersedesReadinessId, null);
    // The window is NOT a top-level request field even on create.
    assert.equal(
      Object.prototype.hasOwnProperty.call(createdData, 'preferredWindowStart'),
      false,
    );

    // The preference is persisted as a governed readiness row — the read
    // projection losing it is a CONTRACT fact, not data loss.
    // (`schedulingReadiness` is therefore the create-response key, and the
    // column below is the storage authority for the same instants.)
    const rows = await sql(
      `SELECT preferred_window_start AS "start", preferred_window_end AS "end",
              timezone, status
         FROM handyman_scheduling_readiness
        WHERE handyman_request_id = $1 AND client_id = $2`,
      [createdData.id, realm.clientId],
    );
    assert.equal(rows.rowCount, 1, 'exactly one initial readiness row');
    assert.equal(rows.rows[0].start.toISOString(), preferredWindowStart);
    assert.equal(rows.rows[0].end.toISOString(), preferredWindowEnd);
    assert.equal(rows.rows[0].status, 'ACTIVE');

    // The window is READABLE through its own contract — which is where the
    // Frontend must get it, and where the OpenAPI still requires it.
    const readinessRead = await api()
      .get(`${V1}/handyman/requests/${createdData.id}/scheduling-readiness`)
      .set(auth(adminToken()));
    assert.equal(readinessRead.status, 200, JSON.stringify(readinessRead.body));
    assert.equal(
      readinessRead.body.data.current.preferredWindowStart,
      preferredWindowStart,
    );
    assert.equal(
      readinessRead.body.data.current.preferredWindowEnd,
      preferredWindowEnd,
    );

    // The REQUEST read projection still has no window field.
    const detail = await api()
      .get(`${V1}/handyman/requests/${createdData.id}`)
      .set(auth(adminToken()));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(
      Object.keys(detail.body.data).sort(),
      [...schemas.HandymanCustomerCareServiceRequest.required].sort(),
    );
    for (const field of ['preferredWindowStart', 'preferredWindowEnd']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(detail.body.data, field),
        false,
      );
    }

    // A preference is NOT a confirmed appointment: no appointment row was
    // created by intake, and the request is still INTAKE.
    const appointments = await sql(
      `SELECT count(*)::int AS total FROM handyman_visit_appointments
        WHERE handyman_request_id = $1`,
      [createdData.id],
    );
    assert.equal(appointments.rows[0].total, 0, 'a preference books nothing');
    assert.equal(detail.body.data.status, 'INTAKE');
  });

  it('7: the paired-optional intake rule is preserved (one-sided windows are rejected)', async () => {
    const realm = await createRealm('PairRule');
    const care = await createCareStaff(realm.buildingId);

    // Only a start: refused, exactly as before this correction.
    const onlyStart = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      serviceCatalogId: realm.simpleServiceId,
      description: 'Part 09 one-sided start',
      preferredWindowStart: '2027-04-01T02:00:00.000Z',
    } as never);
    assert.equal(onlyStart.status, 400, JSON.stringify(onlyStart.body));

    // Only an end: refused too.
    const onlyEnd = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      serviceCatalogId: realm.simpleServiceId,
      description: 'Part 09 one-sided end',
      preferredWindowEnd: '2027-04-01T05:00:00.000Z',
    } as never);
    assert.equal(onlyEnd.status, 400, JSON.stringify(onlyEnd.body));

    // Inverted bounds: refused by the governed window rule.
    const inverted = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      serviceCatalogId: realm.simpleServiceId,
      description: 'Part 09 inverted',
      preferredWindowStart: '2027-04-01T05:00:00.000Z',
      preferredWindowEnd: '2027-04-01T02:00:00.000Z',
    } as never);
    assert.equal(inverted.status, 400, JSON.stringify(inverted.body));

    // Omitted entirely: the legacy no-date intake still works, and the
    // response simply has no `schedulingReadiness` key.
    const none = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      serviceCatalogId: realm.simpleServiceId,
      description: 'Part 09 no date',
    } as never);
    assert.equal(none.status, 201, JSON.stringify(none.body));
    assert.equal(
      Object.prototype.hasOwnProperty.call(none.body.data, 'schedulingReadiness'),
      false,
      'legacy no-date responses stay byte-identical',
    );
  });

  it('8: PART 04 structured create/read and PART 06 metadata stay compatible', async () => {
    const realm = await createRealm('Compat');
    const care = await createCareStaff(realm.buildingId);

    // PART 06 — the catalogue metadata read is unaffected.
    const meta = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.buildingId}/catalogue/services/${realm.acServiceId}`,
      )
      .set(auth(care.token));
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    const metaData = meta.body.data;
    assert.deepEqual(Object.keys(metaData).sort(), [
      'applicability',
      'attributes',
      'quantityConstraints',
      'service',
      'unitsOfMeasure',
      'variants',
    ]);
    assert.equal(metaData.applicability.serviceUomApplicability, 'NOT_GOVERNED');
    const variant = metaData.variants[0];
    const uom = metaData.unitsOfMeasure.find(
      (option: { code: string }) => option.code === 'HM_UNIT',
    );

    // PART 04 — structured intake from that metadata, WITH a preferred window
    // so both contracts are exercised on one request.
    const preferredWindowStart = '2027-05-01T01:00:00.000Z';
    const preferredWindowEnd = '2027-05-01T04:00:00.000Z';
    const created = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      preferredWindowStart,
      preferredWindowEnd,
      items: [
        {
          serviceCatalogId: metaData.service.id,
          serviceVariantId: variant.id,
          quantity: 2,
          uomId: uom.id,
          itemDescription: 'Part 09 structured item',
          accessCondition: 'STANDARD',
        },
      ],
    } as never);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const item = created.body.data.items[0];
    assert.equal(item.uomId, uom.id);
    assert.deepEqual(item.inheritedAttributeCodes, variant.inheritedAttributeCodes);
    assert.equal(
      created.body.data.schedulingReadiness.preferredWindowStart,
      preferredWindowStart,
    );

    // The Care Building detail is a SEPARATE, unchanged contract:
    // `{request, items, progress}` with no window anywhere.
    const detail = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.buildingId}/requests/${created.body.data.id}`,
      )
      .set(auth(care.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(Object.keys(detail.body.data).sort(), [
      'items',
      'progress',
      'request',
    ]);
    assert.deepEqual(detail.body.data.items, created.body.data.items);
    const careKeys = allKeys(detail.body.data);
    assert.equal(careKeys.has('preferredWindowStart'), false);
    assert.equal(careKeys.has('preferredWindowEnd'), false);
  });

  it('9: the customer-facing read exposes no internal-note surface', async () => {
    const realm = await createRealm('Notes');
    const care = await createCareStaff(realm.buildingId);

    const created = await createRequest(care.token, realm.buildingId, {
      tenantCompanyId: realm.companyId,
      tenantPicId: realm.picId,
      spaceId: realm.spaceId,
      serviceCatalogId: realm.simpleServiceId,
      description: 'Part 09 notes separation',
      preferredWindowStart: '2027-06-01T01:00:00.000Z',
      preferredWindowEnd: '2027-06-01T03:00:00.000Z',
    } as never);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const detail = await api()
      .get(`${V1}/handyman/requests/${created.body.data.id}`)
      .set(auth(adminToken()));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));

    // Internal Care Notes are Operations-only: no note-shaped key may reach
    // the customer-facing projection, at any depth.
    for (const key of allKeys(detail.body.data)) {
      assert.equal(
        /note/i.test(key),
        false,
        `customer-facing read must not expose a note surface (${key})`,
      );
    }
    const serialized = JSON.stringify(detail.body.data);
    assert.equal(serialized.includes('internalNote'), false);
    assert.equal(serialized.includes('careNote'), false);

    // And the notes live behind their own governed route, not this read.
    const notesRoute = readFileSync(
      resolve(__dirname, '../src/modules/handyman-api/handyman-api.routes.ts'),
      'utf8',
    );
    assert.equal(/internal-notes/.test(notesRoute), false);
  });
});
