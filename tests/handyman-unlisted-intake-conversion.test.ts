/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 02 focused validation.
 *
 * Conversion of ONE triaged Unlisted Service Intake case (0487 readiness) into
 * ONE formal manual-origin Service Request (0488): preservation of the verified
 * customer identity, scope, complaint and provenance; exactly-once conversion
 * binding; Operations-only authority with exact Client/Building denial; a
 * formal request WITHOUT any fabricated Service Catalog anchor or channel
 * attribution; and the untouched catalog-request rules.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import {
  closePool,
  initDatabase,
  migrateUp,
  withTransaction,
} from '../src/database';
import { migration0487HandymanUnlistedIntakeOperationsTriage } from '../src/database/migrations/0487_handyman_unlisted_intake_operations_triage';
import { migration0488HandymanUnlistedIntakeFormalRequestConversion } from '../src/database/migrations/0488_handyman_unlisted_intake_formal_request_conversion';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
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
import {
  HANDYMAN_UNLISTED_INTAKE_STATUSES,
  HANDYMAN_UNLISTED_INTAKE_TRIAGE_DECISIONS,
  HANDYMAN_UNLISTED_INTAKE_TRIAGE_PROJECTION,
} from '../src/modules/handyman-unlisted-intake';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const PORT = 55574;
const DIR = '/tmp/asentra-handyman-unlisted-conversion-pg';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';

function db(): Pool {
  if (!pool) throw new Error('Test database pool not initialized');
  return pool;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1',
      DB_PORT: String(PORT),
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'asentra_test',
      DB_SSL: 'false',
    });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const adminClient = postgres.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Unlisted intake conversion tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

async function createUserWithPermissionsAndBuildings(input: {
  displayName: string;
  permissionCodes: string[];
  buildingIds: string[];
}) {
  const tag = suffix();
  const email = `conv-user-${tag.toLowerCase()}@unlisted-conversion.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName: input.displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  if (input.permissionCodes.length > 0) {
    const role = await roleService.createRole({ code: `ROLE_${tag}`, name: `Role ${tag}` });
    for (const code of input.permissionCodes) {
      let perm = await permissionRepository.findByCode(code);
      if (!perm) perm = await permissionService.createPermission({ code, name: code });
      await permissionService.assignPermissionToRole(role.id, perm.id);
    }
    await roleService.assignRoleToUser(user.id, role.id);
  }
  for (const buildingId of input.buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

async function createRealmFixture(options: { withTenantPicUser?: boolean } = {}) {
  const tag = suffix();
  const client = await clientService.createClient({ code: `TRCL_${tag}`, name: `Client ${tag}` });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `TRPR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `TRBL_${tag}`,
    name: `Building ${tag}`,
  });
  await db().query(`UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`, [building.id]);
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: property.id,
    code: `TRSB_${tag}`,
    name: `Sibling Building ${tag}`,
  });
  await db().query(`UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`, [
    siblingBuilding.id,
  ]);
  for (const buildingId of [building.id, siblingBuilding.id]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId });
  }

  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `TRFL_${tag}`,
    name: 'Floor 1',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `TRAR_${tag}`,
    name: 'Area 1',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `TRRM_${tag}`,
    name: 'Room 1',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `TRSP_${tag}`,
    name: 'Unit 101',
  });

  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `TRTC_${tag}`, tenantName: `Tenant ${tag}` },
    adminId,
  );
  await db().query(
    `UPDATE tenant_companies SET verification_status = 'VERIFIED' WHERE id = $1`,
    [company.id],
  );
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminId,
  );

  const picUser = options.withTenantPicUser
    ? await createUserWithPermissionsAndBuildings({
        displayName: `Customer PIC ${tag}`,
        permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
        buildingIds: [building.id],
      })
    : null;
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: `PIC ${tag}`,
      email: `pic-${tag.toLowerCase()}@tenant.test`,
      ...(picUser ? { userId: picUser.userId } : {}),
      isPrimary: true,
    },
    adminId,
  );

  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `TRSVC_${tag}`,
      name: 'Standard Catalog Service',
      category: 'HANDYMAN',
    },
    adminId,
  );
  // A second Client with its OWN catalog service: anchoring it from the first
  // Client's triage must fail, and no new catalog row may ever appear.
  const foreignClient = await clientService.createClient({
    code: `TRFX_${tag}`,
    name: `Foreign Client ${tag}`,
  });
  const foreignServiceId = randomUUID();
  await db().query(
    `INSERT INTO service_catalog (id, client_id, code, name, category, status, created_by_user_id)
     VALUES ($1, $2, $3, 'Foreign Catalog Service', 'HANDYMAN', 'ACTIVE', $4)`,
    [foreignServiceId, foreignClient.id, `FXSVC_${tag}`, adminId],
  );

  const uomId = randomUUID();
  await db().query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Lot', 'lot', 'OTHER')`,
    [uomId, client.id, `TRUOM_${tag}`],
  );

  const careUser = await createUserWithPermissionsAndBuildings({
    displayName: `Care Agent ${tag}`,
    permissionCodes: [HANDYMAN_CARE_BUILDING_PERMISSION],
    buildingIds: [building.id],
  });
  const opsWriter = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Coordinator ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [building.id],
  });
  const opsReader = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Reader ${tag}`,
    permissionCodes: ['service_request.read'],
    buildingIds: [building.id],
  });
  const foreignOpsWriter = await createUserWithPermissionsAndBuildings({
    displayName: `Foreign Ops Coordinator ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [siblingBuilding.id],
  });

  return {
    tag,
    client,
    foreignClient,
    property,
    building,
    siblingBuilding,
    space,
    company,
    pic,
    picUser,
    service,
    foreignServiceId,
    uomId,
    careUser,
    opsWriter,
    opsReader,
    foreignOpsWriter,
  };
}

type Fixture = Awaited<ReturnType<typeof createRealmFixture>>;

async function createUnlistedCase(
  f: Fixture,
  options: { idempotencyKey: string; buildingId?: string } & Record<string, unknown>,
) {
  const buildingId = options.buildingId ?? f.building.id;
  const res = await api()
    .post(`${V1}/handyman/care/buildings/${buildingId}/unlisted-intake-cases`)
    .set(authHeader(f.careUser.token))
    .send({
      tenantCompanyId: f.company.id,
      tenantPicId: f.pic.id,
      spaceId: f.space.id,
      requestedServiceName: 'Custom Telescopic Hall Ceiling Rig',
      description:
        'Customer needs a bespoke rig to service a 9 m atrium ceiling; no catalog service covers it.',
      preferredWindowStart: '2026-11-10T09:00:00+07:00',
      preferredWindowEnd: '2026-11-10T12:00:00+07:00',
      internalNote: 'Care note: lobby must stay open during works.',
      ...options,
      idempotencyKey: options.idempotencyKey,
    });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data as {
    id: string;
    status: string;
    description: string;
    preferredWindow: Record<string, string> | null;
    internalNotes: unknown[];
  };
}

function triagePath(intakeCaseId: string) {
  return `${V1}/handyman/operations/unlisted-intake-cases/${intakeCaseId}/triage-decisions`;
}

async function triage(
  f: Fixture,
  intakeCaseId: string,
  body: Record<string, unknown>,
  token?: string,
  headers: Record<string, string> = {},
) {
  return api()
    .post(triagePath(intakeCaseId))
    .set(authHeader(token ?? f.opsWriter.token))
    .set(headers)
    .send(body);
}

const MANUAL_QUOTE_BODY = {
  decision: 'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
  justification:
    'No catalog service or price rule can express a one-off atrium rig; Operations will quote manually after inspection.',
  manualQuoteSummary:
    'One-time fabrication and install of telescopic ceiling rig for 9 m atrium, including lobby protection.',
  manualQuoteQuantity: 1,
};


function conversionPath(intakeCaseId: string) {
  return `${V1}/handyman/operations/unlisted-intake-cases/${intakeCaseId}/service-request`;
}

async function convert(
  f: Fixture,
  intakeCaseId: string,
  body: Record<string, unknown> | undefined,
  token?: string,
  headers: Record<string, string> = {},
) {
  const req = api()
    .post(conversionPath(intakeCaseId))
    .set(authHeader(token ?? f.opsWriter.token))
    .set(headers);
  return body === undefined ? req.send() : req.send(body);
}

/** Triages a fresh case into manual-quotation readiness and returns both ids. */
async function readyCase(
  f: Fixture,
  key: string,
  triageBody: Record<string, unknown> = MANUAL_QUOTE_BODY,
) {
  const created = await createUnlistedCase(f, { idempotencyKey: `case-${key}` });
  const res = await triage(f, created.id, {
    ...triageBody,
    manualQuoteUomId: f.uomId,
    idempotencyKey: `triage-${key}`,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { caseId: created.id as string, created, triage: res.body.data };
}

/**
 * A case created with a VERIFIED channel attribution (0374/0427) on the Care
 * backend lane: the only way to prove that a real attribution is preserved
 * instead of invented. Provenance is written once, exactly as the 0486 insert
 * guard requires (no Tenant PIC author, scope parity, hashed payload).
 */
async function insertAttribution(
  f: Fixture,
  originReference: string,
): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO handyman_channel_attributions
       (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
        origin_channel, origin_reference, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'CUSTOMER_CARE_BACKEND', $7, $8)`,
    [id, f.client.id, f.company.id, f.pic.id, f.building.id, f.space.id, originReference, f.careUser.userId],
  );
  return id;
}

async function insertCaseWithAttribution(
  f: Fixture,
  options: { idempotencyKey: string; attributionId?: string; description?: string },
) {
  const attributionId = options.attributionId ?? randomUUID();
  if (!options.attributionId) {
    await db().query(
      `INSERT INTO handyman_channel_attributions
         (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
          origin_channel, origin_reference, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'CUSTOMER_CARE_BACKEND', $7, $8)`,
      [
        attributionId,
        f.client.id,
        f.company.id,
        f.pic.id,
        f.building.id,
        f.space.id,
        `EXT-${f.tag}`,
        f.careUser.userId,
      ],
    );
  }
  const caseId = randomUUID();
  await db().query(
    `INSERT INTO handyman_unlisted_service_intake_cases
       (id, client_id, building_id, space_id, tenant_company_id, tenant_pic_id,
        approval_tenant_company_id, cost_responsible_tenant_company_id,
        channel_attribution_id, origin_channel, origin_reference,
        requested_service_name, description, status, created_by_user_id,
        idempotency_key, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CUSTOMER_CARE_BACKEND', $10,
             $11, $12, 'PENDING_TRIAGE', $13, $14, $15)`,
    [
      caseId,
      f.client.id,
      f.building.id,
      f.space.id,
      f.company.id,
      f.pic.id,
      f.company.id,
      f.company.id,
      attributionId,
      `EXT-${f.tag}`,
      'Bespoke atrium ceiling rig',
      options.description ??
        'Customer needs a bespoke atrium rig through a verified Care attribution; no catalog service covers it.',
      f.careUser.userId,
      options.idempotencyKey,
      'a'.repeat(64),
    ],
  );
  return { caseId, attributionId };
}

async function readCase(f: Fixture, intakeCaseId: string) {
  return api()
    .get(`${V1}/handyman/unlisted-intake-cases/${intakeCaseId}`)
    .set(authHeader(f.opsWriter.token));
}

async function requestRow(requestId: string) {
  const res = await db().query(
    `SELECT id, client_id, building_id, space_id, tenant_company_id, tenant_pic_id,
            intake_source, service_catalog_id, service_variant_id,
            channel_attribution_id, unlisted_intake_case_id, origin_channel,
            origin_reference, description, status, created_by_user_id
       FROM handyman_service_requests WHERE id = $1`,
    [requestId],
  );
  return res.rows[0] ?? null;
}
describe('CR-HM-MANUAL-QUOTATION-01 — PART 02 Unlisted Intake → Formal Request', () => {
  it('(1) converts a manual-quotation-ready case into one manual-origin request preserving identity, scope, complaint and provenance', async () => {
    const f = await createRealmFixture();
    const { caseId, created } = await readyCase(f, '1');

    const res = await convert(f, caseId, { idempotencyKey: `conv-1-${f.tag}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.replayed, false);
    const conversion = res.body.data.conversion;
    assert.equal(conversion.intakeCaseId, caseId);
    assert.equal(conversion.intakeSource, 'UNLISTED_TRIAGE');
    assert.equal(conversion.serviceCatalogId, null);
    assert.equal(conversion.serviceVariantId, null);
    assert.equal(conversion.status, 'INTAKE');
    assert.equal(conversion.clientId, f.client.id);
    assert.equal(conversion.buildingId, f.building.id);
    assert.equal(conversion.spaceId, f.space.id);
    assert.equal(conversion.tenantCompanyId, f.company.id);
    assert.equal(conversion.tenantPicId, f.pic.id);
    assert.equal(conversion.originChannel, 'CUSTOMER_CARE_BACKEND');
    assert.equal(conversion.description, created.description);

    const row = await requestRow(conversion.requestId);
    assert.ok(row);
    assert.equal(row.service_catalog_id, null);
    assert.equal(row.service_variant_id, null);
    assert.equal(row.unlisted_intake_case_id, caseId);
    assert.equal(row.description, created.description);
    assert.equal(row.origin_channel, 'CUSTOMER_CARE_BACKEND');
    assert.equal(row.origin_reference, null);
    assert.equal(row.created_by_user_id, f.opsWriter.userId);

    // A VERIFIED attribution recorded on the case is preserved, never invented:
    // the Care lane created one for this intake, so the request must carry it.
    const caseAttribution = await db().query(
      `SELECT channel_attribution_id FROM handyman_unlisted_service_intake_cases WHERE id = $1`,
      [caseId],
    );
    assert.ok(caseAttribution.rows[0].channel_attribution_id);
    assert.equal(
      row.channel_attribution_id,
      caseAttribution.rows[0].channel_attribution_id,
    );
    assert.equal(
      conversion.channelAttributionId,
      caseAttribution.rows[0].channel_attribution_id,
    );

    // Operations readback on the case itself.
    const readback = await readCase(f, caseId);
    assert.equal(readback.status, 200, JSON.stringify(readback.body));
    assert.equal(readback.body.data.convertedRequestId, conversion.requestId);
    assert.ok(readback.body.data.convertedAt);
    assert.equal(readback.body.data.status, 'TRIAGED_MANUAL_QUOTATION_READY');
    assert.equal(
      readback.body.data.triage.decision,
      'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
    );

    // Visit preference and internal notes are untouched, and no commercial
    // fact is invented by the conversion.
    const notes = await db().query(
      `SELECT count(*)::int AS n FROM handyman_internal_notes
        WHERE unlisted_intake_case_id = $1`,
      [caseId],
    );
    assert.equal(notes.rows[0].n, 1);
    const quotations = await db().query(
      `SELECT count(*)::int AS n FROM handyman_quotations WHERE handyman_request_id = $1`,
      [conversion.requestId],
    );
    assert.equal(quotations.rows[0].n, 0);
    const scopes = await db().query(
      `SELECT count(*)::int AS n FROM handyman_execution_scopes WHERE handyman_request_id = $1`,
      [conversion.requestId],
    );
    assert.equal(scopes.rows[0].n, 0);
    const events = await db().query(
      `SELECT event_type, actor_user_id, client_id, building_id, metadata
         FROM operational_events
        WHERE entity_type = 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE' AND entity_id = $1`,
      [caseId],
    );
    assert.deepEqual(
      events.rows.map((r: { event_type: string }) => r.event_type).sort(),
      [
        'HANDYMAN_INTERNAL_NOTE_RECORDED',
        'HANDYMAN_UNLISTED_SERVICE_INTAKE_CONVERTED',
        'HANDYMAN_UNLISTED_SERVICE_INTAKE_CREATED',
        'HANDYMAN_UNLISTED_SERVICE_INTAKE_TRIAGED',
      ].sort(),
    );
    const convertedEvent = events.rows.find(
      (r: { event_type: string }) =>
        r.event_type === 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CONVERTED',
    );
    assert.equal(convertedEvent.actor_user_id, f.opsWriter.userId);
    assert.equal(convertedEvent.client_id, f.client.id);
    assert.equal(convertedEvent.building_id, f.building.id);
    assert.equal(convertedEvent.metadata.serviceCatalogId, null);
    assert.equal(convertedEvent.metadata.handymanRequestId, conversion.requestId);
  });

  it('(2) replays the identical command and refuses any second conversion of the same case', async () => {
    const f = await createRealmFixture();
    const { caseId } = await readyCase(f, '2');
    const first = await convert(f, caseId, { idempotencyKey: `conv-2-${f.tag}` });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const replay = await convert(f, caseId, { idempotencyKey: `conv-2-${f.tag}` });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(
      replay.body.data.conversion.requestId,
      first.body.data.conversion.requestId,
    );

    // Header-only replay of the same key.
    const headerReplay = await convert(f, caseId, undefined, undefined, {
      'Idempotency-Key': `conv-2-${f.tag}`,
    });
    assert.equal(headerReplay.status, 200, JSON.stringify(headerReplay.body));
    assert.equal(headerReplay.body.data.replayed, true);

    // Another key on an already converted case never produces a second request.
    const otherKey = await convert(f, caseId, { idempotencyKey: `conv-2b-${f.tag}` });
    assert.equal(otherKey.status, 409, JSON.stringify(otherKey.body));
    assert.equal(
      otherKey.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_IDEMPOTENCY_CONFLICT',
    );

    const rows = await db().query(
      `SELECT count(*)::int AS n FROM handyman_service_requests WHERE unlisted_intake_case_id = $1`,
      [caseId],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('(3) serializes concurrent conversions to exactly one request', async () => {
    const f = await createRealmFixture();
    const { caseId } = await readyCase(f, '3');
    const key = `conv-3-${f.tag}`;
    const [a, b] = await Promise.all([
      convert(f, caseId, { idempotencyKey: key }),
      convert(f, caseId, { idempotencyKey: key }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);

    const other = await Promise.all([
      convert(f, caseId, { idempotencyKey: `conv-3-x-${f.tag}` }),
      convert(f, caseId, { idempotencyKey: `conv-3-y-${f.tag}` }),
    ]);
    assert.deepEqual(
      other.map((r) => r.status).sort(),
      [409, 409],
    );

    const rows = await db().query(
      `SELECT count(*)::int AS n FROM handyman_service_requests WHERE unlisted_intake_case_id = $1`,
      [caseId],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('(4) enforces Operations-only conversion authority and exact Client/Building scope', async () => {
    const f = await createRealmFixture();
    const { caseId } = await readyCase(f, '4');
    const key = `conv-4-${f.tag}`;

    const asCare = await convert(f, caseId, { idempotencyKey: key }, f.careUser.token);
    assert.equal(asCare.status, 403, JSON.stringify(asCare.body));
    const asReader = await convert(f, caseId, { idempotencyKey: key }, f.opsReader.token);
    assert.equal(asReader.status, 403, JSON.stringify(asReader.body));
    const anonymous = await convert(f, caseId, { idempotencyKey: key }, 'jwt-garbage');
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

    // Care mediation authority may create and annotate, never convert.
    const picRealm = await createRealmFixture({ withTenantPicUser: true });
    const picCase = await readyCase(picRealm, '4pic');
    const asPic = await convert(
      picRealm,
      picCase.caseId,
      { idempotencyKey: `conv-4pic-${picRealm.tag}` },
      picRealm.picUser!.token,
    );
    assert.equal(asPic.status, 403, JSON.stringify(asPic.body));
    assert.equal(asPic.body.error.code, 'HANDYMAN_UNLISTED_INTAKE_FORBIDDEN');

    // A Writer assigned only to a SIBLING Building cannot convert, even with
    // tenant_company.manage on the same Client.
    const asForeign = await convert(
      f,
      caseId,
      { idempotencyKey: key },
      f.foreignOpsWriter.token,
    );
    assert.equal(asForeign.status, 403, JSON.stringify(asForeign.body));
    assert.equal(asForeign.body.error.code, 'BUILDING_ACCESS_DENIED');
    const untouched = await readCase(f, caseId);
    assert.equal(untouched.body.data.convertedRequestId, null);
  });

  it('(5) converts only the manual-quotation-ready branch, and never another outcome', async () => {
    const f = await createRealmFixture();

    const pending = await createUnlistedCase(f, { idempotencyKey: `case-5-pending` });
    const noTriage = await convert(f, pending.id, { idempotencyKey: `conv-5a-${f.tag}` });
    assert.equal(noTriage.status, 409, JSON.stringify(noTriage.body));
    assert.equal(
      noTriage.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_NOT_ELIGIBLE',
    );

    for (const decision of [
      'MATCH_EXISTING_CATALOG_SERVICE',
      'CREATE_CLIENT_CUSTOM_SERVICE',
      'REJECT_UNSUPPORTED',
      'REQUEST_MORE_INFORMATION_OR_INSPECTION',
    ]) {
      const body: Record<string, unknown> =
        decision === 'MATCH_EXISTING_CATALOG_SERVICE'
          ? { catalogServiceId: f.service.id }
          : decision === 'CREATE_CLIENT_CUSTOM_SERVICE'
            ? { customServiceName: 'Atrium Rig Custom Service' }
            : decision === 'REQUEST_MORE_INFORMATION_OR_INSPECTION'
              ? {
                  clarificationRequest:
                    'Confirm atrium headroom, load limits and lift access before classification.',
                }
              : {};
      const created = await createUnlistedCase(f, {
        idempotencyKey: `case-5-${decision}`,
      });
      const triaged = await triage(f, created.id, {
        decision,
        justification:
          'Operations classified this request through a non-manual lane; it must not open a manual quotation request.',
        ...body,
        idempotencyKey: `triage-5-${decision}`,
      });
      assert.equal(triaged.status, 201, JSON.stringify(triaged.body));
      const attempt = await convert(f, created.id, {
        idempotencyKey: `conv-5-${decision}`,
      });
      assert.equal(attempt.status, 409, JSON.stringify(attempt.body));
      assert.equal(
        attempt.body.error.code,
        'HANDYMAN_UNLISTED_INTAKE_CONVERSION_NOT_ELIGIBLE',
      );
    }

    // A clarification round is not readiness: it must be classified first.
    const clar = await createUnlistedCase(f, { idempotencyKey: `case-5-clar` });
    await triage(f, clar.id, {
      decision: 'REQUEST_MORE_INFORMATION_OR_INSPECTION',
      justification:
        'Operations needs the atrium access answer before any quotation lane can be opened.',
      clarificationRequest:
        'Please confirm lobby access hours and ceiling load limits for the atrium.',
      idempotencyKey: `triage-5-clar`,
    });
    const tooEarly = await convert(f, clar.id, { idempotencyKey: `conv-5-clar-${f.tag}` });
    assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body));
  });

  it('(6) fails closed when the verified identity or effective scope has lapsed', async () => {
    const f = await createRealmFixture();
    const a = await readyCase(f, '6a');
    await db().query(`UPDATE tenant_companies SET status = 'INACTIVE' WHERE id = $1`, [
      f.company.id,
    ]);
    const inactive = await convert(f, a.caseId, { idempotencyKey: `conv-6a-${f.tag}` });
    assert.equal(inactive.status, 409, JSON.stringify(inactive.body));
    assert.equal(
      inactive.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_SCOPE_UNVERIFIED',
    );
    await db().query(`UPDATE tenant_companies SET status = 'ACTIVE' WHERE id = $1`, [
      f.company.id,
    ]);
    const recovered = await convert(f, a.caseId, { idempotencyKey: `conv-6a-${f.tag}` });
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));

    // A commercial party that lost VERIFIED status blocks the conversion.
    const f2 = await createRealmFixture();
    const b = await readyCase(f2, '6b');
    await db().query(
      `UPDATE tenant_companies SET verification_status = 'PENDING_VERIFICATION' WHERE id = $1`,
      [f2.company.id],
    );
    const unverified = await convert(f2, b.caseId, { idempotencyKey: `conv-6b-${f2.tag}` });
    assert.equal(unverified.status, 409, JSON.stringify(unverified.body));
    assert.equal(unverified.body.error.code, 'TENANT_VERIFICATION_REQUIRED');

    // A re-pointed PIC (no longer this Tenant's) is refused, never adopted.
    const f3 = await createRealmFixture();
    const c = await readyCase(f3, '6c');
    const otherTenant = await tenantCompanyService.createTenantCompany(
      {
        clientId: f3.client.id,
        tenantCode: `CVTX_${f3.tag}`,
        tenantName: `Other Tenant ${f3.tag}`,
      },
      adminId,
    );
    await db().query(`UPDATE tenant_pics SET tenant_company_id = $2 WHERE id = $1`, [
      f3.pic.id,
      otherTenant.id,
    ]);
    const orphan = await convert(f3, c.caseId, { idempotencyKey: `conv-6c-${f3.tag}` });
    assert.equal(orphan.status, 409, JSON.stringify(orphan.body));
    assert.equal(
      orphan.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_SCOPE_UNVERIFIED',
    );
    const noRequest = await db().query(
      `SELECT count(*)::int AS n FROM handyman_service_requests WHERE unlisted_intake_case_id = $1`,
      [c.caseId],
    );
    assert.equal(noRequest.rows[0].n, 0);
  });

  it('(7) preserves a verified attribution and refuses to borrow a consumed one', async () => {
    const f = await createRealmFixture();

    // Case A owns an unused verified attribution: the conversion keeps it.
    const attributionA = await insertAttribution(f, `EXTA-${f.tag}`);
    const caseA = await insertCaseWithAttribution(f, {
      idempotencyKey: `conv-7-a-${f.tag}`,
      attributionId: attributionA,
    });
    const triagedA = await triage(f, caseA.caseId, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-7-a-${f.tag}`,
    });
    assert.equal(triagedA.status, 201, JSON.stringify(triagedA.body));
    const resA = await convert(f, caseA.caseId, {
      idempotencyKey: `conv-7-run-${f.tag}`,
    });
    assert.equal(resA.status, 201, JSON.stringify(resA.body));
    assert.equal(resA.body.data.conversion.channelAttributionId, attributionA);
    const rowA = await requestRow(resA.body.data.conversion.requestId);
    assert.equal(rowA.channel_attribution_id, attributionA);
    assert.equal(rowA.service_catalog_id, null);

    // Case B shares an attribution ALREADY consumed by another request: the
    // conversion refuses instead of stealing it, and invents nothing.
    const attributionB = await insertAttribution(f, `EXTB-${f.tag}`);
    await db().query(
      `INSERT INTO handyman_service_requests
         (id, client_id, channel_attribution_id, tenant_company_id, building_id,
          service_catalog_id, origin_channel, description, status, intake_source)
       VALUES ($1, $2, $3, $4, $5, $6, 'CUSTOMER_CARE_BACKEND',
         'Catalog request that consumed this attribution first.', 'INTAKE',
         'CATALOG')`,
      [
        randomUUID(),
        f.client.id,
        attributionB,
        f.company.id,
        f.building.id,
        f.service.id,
      ],
    );
    const caseB = await insertCaseWithAttribution(f, {
      idempotencyKey: `conv-7-b-${f.tag}`,
      attributionId: attributionB,
      description:
        'Second unlisted request that arrived under an attribution another request already holds.',
    });
    const triagedB = await triage(f, caseB.caseId, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-7-b-${f.tag}`,
    });
    assert.equal(triagedB.status, 201, JSON.stringify(triagedB.body));
    const conflict = await convert(f, caseB.caseId, {
      idempotencyKey: `conv-7-conflict-${f.tag}`,
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(
      conflict.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_ATTRIBUTION_CONFLICT',
    );
    const noSecond = await db().query(
      `SELECT count(*)::int AS n FROM handyman_service_requests WHERE unlisted_intake_case_id = $1`,
      [caseB.caseId],
    );
    assert.equal(noSecond.rows[0].n, 0);
  });

  it('(8) enforces the 0488 database laws on the conversion binding', async () => {
    const f = await createRealmFixture();
    const { caseId } = await readyCase(f, '8');
    const res = await convert(f, caseId, { idempotencyKey: `conv-8-${f.tag}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const requestId = res.body.data.conversion.requestId as string;

    // No catalog or variant anchor may be attached to a manual-origin request.
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_service_requests SET service_catalog_id = $2 WHERE id = $1`,
          [requestId, f.service.id],
        ),
      (err: { code?: string }) => err.code === '23514',
      'a manual-origin request must never gain a catalog anchor',
    );
    // Its intake provenance and scope are immutable.
    for (const sql of [
      `UPDATE handyman_service_requests SET unlisted_intake_case_id = gen_random_uuid() WHERE id = '${requestId}'`,
      `UPDATE handyman_service_requests SET intake_source = 'CATALOG' WHERE id = '${requestId}'`,
      `UPDATE handyman_service_requests SET channel_attribution_id = $2 WHERE id = $1`,
    ]) {
      await assert.rejects(
        () =>
          db().query(sql, sql.includes('$2') ? [requestId, randomUUID()] : undefined),
        (err: { code?: string }) => err.code === '23514',
      );
    }
    // The status machine stays open (conversion does not freeze the request).
    await db().query(
      `UPDATE handyman_service_requests SET status = 'TRIAGE', updated_at = NOW() WHERE id = $1`,
      [requestId],
    );

    // One case, one request: a second request for the same case is refused.
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_service_requests
             (id, client_id, tenant_company_id, building_id, origin_channel,
              description, status, intake_source, unlisted_intake_case_id)
           VALUES ($1, $2, $3, $4, 'CUSTOMER_CARE_BACKEND',
             'Raw duplicate conversion attempt against the same intake case.',
             'INTAKE', 'UNLISTED_TRIAGE', $5)`,
          [randomUUID(), f.client.id, f.company.id, f.building.id, caseId],
        ),
      (err: { code?: string }) => err.code === '23505' || err.code === '23514',
    );
    // A manual-origin row without intake provenance is refused.
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_service_requests
             (id, client_id, tenant_company_id, building_id, origin_channel,
              description, status, intake_source)
           VALUES ($1, $2, $3, $4, 'CUSTOMER_CARE_BACKEND',
             'Manual-origin request without intake provenance.', 'INTAKE',
             'UNLISTED_TRIAGE')`,
          [randomUUID(), f.client.id, f.company.id, f.building.id],
        ),
      (err: { code?: string }) => err.code === '23514',
    );
    // A catalog row may not drop its catalog anchor or its attribution.
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_service_requests
             (id, client_id, tenant_company_id, building_id, origin_channel,
              description, status, intake_source)
           VALUES ($1, $2, $3, $4, 'BM_SUPER_APP',
             'Catalog row without a catalog anchor must be refused.', 'INTAKE',
             'CATALOG')`,
          [randomUUID(), f.client.id, f.company.id, f.building.id],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    // The conversion binding is write-once on the state anchor.
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_unlisted_intake_triage_state
              SET converted_request_id = $2
            WHERE intake_case_id = $1`,
          [caseId, randomUUID()],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    // 0488 refuses rollback while conversion facts exist (and leaves them
    // intact), and so does 0487 underneath it.
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await migration0488HandymanUnlistedIntakeFormalRequestConversion.down(tx);
        }),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await migration0487HandymanUnlistedIntakeOperationsTriage.down(tx);
        }),
      (err: { code?: string }) => err.code === '23514',
    );
    const stillThere = await requestRow(requestId);
    assert.equal(stillThere.unlisted_intake_case_id, caseId);
    const stateRow = await db().query(
      `SELECT converted_request_id, conversion_idempotency_key, conversion_payload_hash
         FROM handyman_unlisted_intake_triage_state WHERE intake_case_id = $1`,
      [caseId],
    );
    assert.equal(stateRow.rows[0].converted_request_id, requestId);
    assert.equal(stateRow.rows[0].conversion_idempotency_key, `conv-8-${f.tag}`);
    assert.match(stateRow.rows[0].conversion_payload_hash, /^[0-9a-f]{64}$/);
  });

  it('(9) leaves catalog-request rules and the intake contract untouched', async () => {
    const f = await createRealmFixture();
    // A catalog request may not be created without a catalog anchor or without
    // its attribution: the 0488 CHECKs preserve the 0378 law exactly.
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_service_requests
             (id, client_id, tenant_company_id, building_id, service_catalog_id,
              origin_channel, status, intake_source)
           VALUES ($1, $2, $3, $4, $5, 'BM_SUPER_APP', 'INTAKE', 'CATALOG')`,
          [randomUUID(), f.client.id, f.company.id, f.building.id, f.service.id],
        ),
      (err: { code?: string }) => err.code === '23514',
    );
    // A catalog row keeps its 1000-char complaint limit (no blanket widening).
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_service_requests
             (id, client_id, channel_attribution_id, tenant_company_id,
              building_id, service_catalog_id, origin_channel, description,
              status, intake_source)
           VALUES ($1, $2, $3, $4, $5, $6, 'BM_SUPER_APP', $7, 'INTAKE', 'CATALOG')`,
          [
            randomUUID(),
            f.client.id,
            randomUUID(),
            f.company.id,
            f.building.id,
            f.service.id,
            'x'.repeat(1200),
          ],
        ),
      (err: { code?: string }) => err.code === '23514' || err.code === '23503',
    );
    // The unlisted lane carries a longer complaint VERBATIM (case allows 2000,
    // the catalog lane is still capped at 1000) — nothing is truncated.
    const longDescription = `Customer needs a bespoke atrium rig. ${'detail '.repeat(200)}`.trim();
    assert.ok(
      longDescription.length > 1000 && longDescription.length <= 2000,
      String(longDescription.length),
    );
    const longCase = await createUnlistedCase(f, {
      idempotencyKey: `case-9-long-${f.tag}`,
      description: longDescription,
    });
    assert.equal(longCase.description.length, longDescription.length);
    await triage(f, longCase.id, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-9-long-${f.tag}`,
    });
    const longConversion = await convert(f, longCase.id, {
      idempotencyKey: `conv-9-long-${f.tag}`,
    });
    assert.equal(longConversion.status, 201, JSON.stringify(longConversion.body));
    assert.equal(longConversion.body.data.conversion.description, longDescription);

    // Existing intake vocabulary + the widened request status list are intact.
    assert.deepEqual(
      [...HANDYMAN_UNLISTED_INTAKE_STATUSES],
      [
        'PENDING_TRIAGE',
        'AWAITING_INFORMATION',
        'TRIAGED_CATALOG_MATCHED',
        'TRIAGED_CLIENT_CUSTOM_SERVICE',
        'TRIAGED_MANUAL_QUOTATION_READY',
        'REJECTED_UNSUPPORTED',
      ],
    );
    assert.equal(HANDYMAN_UNLISTED_INTAKE_TRIAGE_DECISIONS.length, 5);
    assert.equal(
      HANDYMAN_UNLISTED_INTAKE_TRIAGE_PROJECTION.ONE_TIME_MANUAL_QUOTATION_REQUIRED,
      'TRIAGED_MANUAL_QUOTATION_READY',
    );

    // OpenAPI: the conversion op, its permission and the case readback fields.
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8')) as any;
    const path =
      spec.paths['/handyman/operations/unlisted-intake-cases/{intakeCaseId}/service-request'];
    assert.ok(path?.post, 'conversion path must be documented');
    assert.equal(path.post['x-required-permission'], 'tenant_company.manage');
    assert.equal(path.post['x-building-scoped'], true);
    for (const code of [
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_NOT_ELIGIBLE',
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_IDEMPOTENCY_CONFLICT',
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_SCOPE_UNVERIFIED',
      'HANDYMAN_UNLISTED_INTAKE_CONVERSION_ATTRIBUTION_CONFLICT',
    ]) {
      assert.ok(path.post['x-error-codes'].includes(code), code);
    }
    assert.ok(spec.components.schemas.HandymanUnlistedIntakeRequestConversion);
    assert.ok(spec.components.schemas.HandymanUnlistedIntakeConversionMutationResult);
    assert.ok(spec.components.schemas.CreateHandymanUnlistedIntakeConversionRequest);
    const caseProps = spec.components.schemas.HandymanUnlistedIntakeCase.properties;
    assert.ok(caseProps.convertedRequestId);
    assert.ok(caseProps.convertedAt);
    assert.equal(
      spec.components.schemas.HandymanUnlistedIntakeRequestConversion.properties
        .serviceCatalogId.enum[0],
      null,
    );
  });
});
