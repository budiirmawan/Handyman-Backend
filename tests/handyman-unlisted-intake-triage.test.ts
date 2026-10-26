/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 01 focused validation.
 *
 * Authorized Operations triage over the existing Unlisted Service Intake
 * (0486) plus the manual-quotation-readiness projection (0487):
 * persistence of the immutable decision, the five governed classifications,
 * RBAC + exact Client/Building denial, no-fake-catalog, duplicate/illegal
 * transition prevention, idempotency, concurrency, the DB-level laws and the
 * untouched catalog-request regression.
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
const PORT = 55573;
const DIR = '/tmp/asentra-handyman-unlisted-triage-pg';
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
  assert.ok(config, 'Unlisted intake triage tests require PostgreSQL');
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
  const email = `triage-user-${tag.toLowerCase()}@unlisted-triage.test`;
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

describe('CR-HM-MANUAL-QUOTATION-01 — PART 01 Unlisted Intake Operations Triage', () => {
  it('(1) records the manual-quotation triage decision immutably and preserves complaint, visit preference and internal notes', async () => {
    const f = await createRealmFixture();
    const created = await createUnlistedCase(f, { idempotencyKey: `case-1-${f.tag}` });
    assert.equal(created.status, 'PENDING_TRIAGE');

    const res = await triage(f, created.id, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-1-${f.tag}`,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.replayed, false);
    assert.equal(res.body.data.decision.decision, 'ONE_TIME_MANUAL_QUOTATION_REQUIRED');
    assert.equal(res.body.data.decision.statusAfter, 'TRIAGED_MANUAL_QUOTATION_READY');
    assert.equal(res.body.data.decision.manualQuotationRequired, true);
    assert.equal(res.body.data.decision.triagedByUserId, f.opsWriter.userId);
    assert.equal(res.body.data.decision.manualQuoteQuantity, '1.0000');
    // No price is ever stored by triage.
    assert.equal(
      (res.body.data.decision as Record<string, unknown>).amount,
      undefined,
    );

    const intake = res.body.data.intakeCase;
    assert.equal(intake.status, 'TRIAGED_MANUAL_QUOTATION_READY');
    assert.equal(intake.triageDecisionId, res.body.data.decision.id);
    assert.ok(intake.triagedAt);
    // Preserved intake facts (0486 immutability + this PART does not touch them).
    assert.equal(intake.description, created.description);
    assert.deepEqual(intake.preferredWindow, created.preferredWindow);
    assert.equal(intake.internalNotes.length, 1);
    assert.deepEqual(intake.triageHistory.map((d: { id: string }) => d.id), [
      res.body.data.decision.id,
    ]);

    // Audit trail: the operational event exists and is scope-correct.
    const audit = await db().query(
      `SELECT event_type, client_id, building_id, actor_user_id, metadata
         FROM operational_events
        WHERE entity_type = 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE'
          AND entity_id = $1
          AND event_type = 'HANDYMAN_UNLISTED_SERVICE_INTAKE_TRIAGED'`,
      [created.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].client_id, f.client.id);
    assert.equal(audit.rows[0].building_id, f.building.id);
    assert.equal(audit.rows[0].actor_user_id, f.opsWriter.userId);
    assert.equal(audit.rows[0].metadata.statusAfter, 'TRIAGED_MANUAL_QUOTATION_READY');

    // Read back through the Operations detail + triage history + queue filter.
    const detail = await api()
      .get(`${V1}/handyman/unlisted-intake-cases/${created.id}`)
      .set(authHeader(f.opsReader.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.status, 'TRIAGED_MANUAL_QUOTATION_READY');
    assert.equal(detail.body.data.triage.decision, 'ONE_TIME_MANUAL_QUOTATION_REQUIRED');

    const history = await api()
      .get(triagePath(created.id))
      .set(authHeader(f.opsReader.token));
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);

    const queue = await api()
      .get(`${V1}/handyman/operations/unlisted-intake-cases`)
      .set(authHeader(f.opsReader.token))
      .query({ status: 'TRIAGED_MANUAL_QUOTATION_READY', buildingId: f.building.id });
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    assert.ok(queue.body.data.items.some((i: { id: string }) => i.id === created.id));

    // The 0486 table keeps its exact shape (that is what makes it reversible);
    // the projection anchor lives in the 1:1 state row.
    const caseRow = await db().query(
      `SELECT (
                 SELECT count(*)::int
                   FROM information_schema.columns
                  WHERE table_name = 'handyman_unlisted_service_intake_cases'
                    AND column_name IN ('triage_decision_id', 'triaged_at')
               ) AS case_projection_columns,
               st.triage_decision_id, st.triaged_at, c.updated_at, c.created_at
         FROM handyman_unlisted_service_intake_cases c
         LEFT JOIN handyman_unlisted_intake_triage_state st
           ON st.intake_case_id = c.id
        WHERE c.id = $1`,
      [created.id],
    );
    assert.equal(caseRow.rows[0].case_projection_columns, 0);
    assert.equal(caseRow.rows[0].triage_decision_id, res.body.data.decision.id);
    assert.ok(caseRow.rows[0].triaged_at);
  });

  it('(2) classifies the governed decisions into their single projected status and refuses duplicates', async () => {
    const f = await createRealmFixture();
    const base = {
      justification:
        'Operations reviewed the bespoke requirement against the catalog and price rules before classifying it.',
    };
    const bodies: Record<string, Record<string, unknown>> = {
      MATCH_EXISTING_CATALOG_SERVICE: { catalogServiceId: f.service.id },
      CREATE_CLIENT_CUSTOM_SERVICE: {
        customServiceName: 'Atrium Telescopic Ceiling Rig',
        customServiceNotes: 'Requires engineered anchor points and a night works window.',
      },
      ONE_TIME_MANUAL_QUOTATION_REQUIRED: {
        ...MANUAL_QUOTE_BODY,
        manualQuoteUomId: f.uomId,
      },
      REQUEST_MORE_INFORMATION_OR_INSPECTION: {
        clarificationRequest:
          'Please confirm atrium access, ceiling load limits and whether a scissor lift can enter the lobby.',
      },
      REJECT_UNSUPPORTED: {},
    };

    for (const decision of HANDYMAN_UNLISTED_INTAKE_TRIAGE_DECISIONS) {
      if (decision === 'REQUEST_MORE_INFORMATION_OR_INSPECTION') continue;
      const caseId = (
        await createUnlistedCase(f, { idempotencyKey: `case-2-${decision}-${f.tag}` })
      ).id;
      const res = await triage(f, caseId, {
        decision,
        justification: base.justification,
        ...bodies[decision],
        idempotencyKey: `triage-2-${decision}-${f.tag}`,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(
        res.body.data.intakeCase.status,
        HANDYMAN_UNLISTED_INTAKE_TRIAGE_PROJECTION[decision],
      );
      assert.equal(res.body.data.intakeCase.triageDecisionId, res.body.data.decision.id);
      assert.equal(res.body.data.intakeCase.triage.decision, decision);

      // One effective decision per case: a second triage of ANY kind is 409.
      const again = await triage(f, caseId, {
        decision: 'REJECT_UNSUPPORTED',
        ...base,
        idempotencyKey: `triage-2-again-${decision}-${f.tag}`,
      });
      assert.equal(again.status, 409, JSON.stringify(again.body));
      assert.equal(
        again.body.error.code,
        'HANDYMAN_UNLISTED_INTAKE_TRIAGE_ALREADY_RECORDED',
      );
    }

    // The clarification lane: one round only, then classification.
    const clarifyCaseId = (
      await createUnlistedCase(f, { idempotencyKey: `case-2-clarify-${f.tag}` })
    ).id;
    const clarified = await triage(f, clarifyCaseId, {
      decision: 'REQUEST_MORE_INFORMATION_OR_INSPECTION',
      ...base,
      ...bodies.REQUEST_MORE_INFORMATION_OR_INSPECTION,
      idempotencyKey: `triage-2-clarify-${f.tag}`,
    });
    assert.equal(clarified.status, 201, JSON.stringify(clarified.body));
    assert.equal(clarified.body.data.intakeCase.status, 'AWAITING_INFORMATION');
    assert.equal(clarified.body.data.intakeCase.triageDecisionId, null);
    assert.equal(clarified.body.data.intakeCase.triage, null);
    assert.equal(clarified.body.data.decision.statusAfter, 'AWAITING_INFORMATION');

    const secondClarify = await triage(f, clarifyCaseId, {
      decision: 'REQUEST_MORE_INFORMATION_OR_INSPECTION',
      ...base,
      ...bodies.REQUEST_MORE_INFORMATION_OR_INSPECTION,
      idempotencyKey: `triage-2-clarify2-${f.tag}`,
    });
    assert.equal(secondClarify.status, 409, JSON.stringify(secondClarify.body));

    const classified = await triage(f, clarifyCaseId, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-2-after-clarify-${f.tag}`,
    });
    assert.equal(classified.status, 201, JSON.stringify(classified.body));
    assert.equal(
      classified.body.data.intakeCase.status,
      'TRIAGED_MANUAL_QUOTATION_READY',
    );
    assert.equal(classified.body.data.intakeCase.triageHistory.length, 2);
    assert.equal(
      classified.body.data.intakeCase.triage.decision,
      'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
    );

    // Terminal states never reopen.
    const rejected = await triage(f, clarifyCaseId, {
      decision: 'REJECT_UNSUPPORTED',
      ...base,
      idempotencyKey: `triage-2-late-reject-${f.tag}`,
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  });

  it('(3) enforces Operations-only triage authority: Care mediation, read-only and customer-facing actors are refused', async () => {
    const f = await createRealmFixture({ withTenantPicUser: true });
    const caseId = (await createUnlistedCase(f, { idempotencyKey: `case-3-${f.tag}` })).id;

    // Care actor: may register and annotate an intake, never classify it.
    const careTriage = await triage(
      f,
      caseId,
      { ...MANUAL_QUOTE_BODY, manualQuoteUomId: f.uomId, idempotencyKey: `triage-3-care-${f.tag}` },
      f.careUser.token,
    );
    assert.equal(careTriage.status, 403, JSON.stringify(careTriage.body));

    // Read-only Operations authority: no triage write.
    const readerTriage = await triage(
      f,
      caseId,
      { ...MANUAL_QUOTE_BODY, manualQuoteUomId: f.uomId, idempotencyKey: `triage-3-read-${f.tag}` },
      f.opsReader.token,
    );
    assert.equal(readerTriage.status, 403, JSON.stringify(readerTriage.body));

    // Customer-facing Tenant PIC: refused even though it holds the permission.
    const picTriage = await triage(
      f,
      caseId,
      { ...MANUAL_QUOTE_BODY, manualQuoteUomId: f.uomId, idempotencyKey: `triage-3-pic-${f.tag}` },
      f.picUser!.token,
    );
    assert.equal(picTriage.status, 403, JSON.stringify(picTriage.body));
    assert.equal(picTriage.body.error.code, 'HANDYMAN_UNLISTED_INTAKE_FORBIDDEN');

    // Unauthenticated.
    const anonymous = await api().post(triagePath(caseId)).send({
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-3-anon-${f.tag}`,
    });
    assert.equal(anonymous.status, 401);

    // The case is untouched by every refusal above.
    const readBack = await api()
      .get(`${V1}/handyman/unlisted-intake-cases/${caseId}`)
      .set(authHeader(f.opsReader.token));
    assert.equal(readBack.body.data.status, 'PENDING_TRIAGE');
    assert.equal(readBack.body.data.triage, null);
    assert.equal(readBack.body.data.triageHistory.length, 0);
  });

  it('(4) denies cross-Client and cross-Building triage regardless of the permission held', async () => {
    const f = await createRealmFixture();
    const caseId = (await createUnlistedCase(f, { idempotencyKey: `case-4-${f.tag}` })).id;

    // Ops user assigned only to the SIBLING building of the SAME Client.
    const wrongBuilding = await triage(
      f,
      caseId,
      {
        ...MANUAL_QUOTE_BODY,
        manualQuoteUomId: f.uomId,
        idempotencyKey: `triage-4-sibling-${f.tag}`,
      },
      f.foreignOpsWriter.token,
    );
    assert.equal(wrongBuilding.status, 403, JSON.stringify(wrongBuilding.body));
    assert.equal(wrongBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A different Client cannot even resolve the case.
    const otherRealm = await createRealmFixture();
    const crossClientRead = await api()
      .get(triagePath(caseId))
      .set(authHeader(otherRealm.opsReader.token));
    assert.equal(crossClientRead.status, 403, JSON.stringify(crossClientRead.body));

    const crossClientWrite = await triage(
      f,
      caseId,
      { ...MANUAL_QUOTE_BODY, manualQuoteUomId: f.uomId, idempotencyKey: `triage-4-xclient-${f.tag}` },
      otherRealm.opsWriter.token,
    );
    assert.equal(crossClientWrite.status, 403, JSON.stringify(crossClientWrite.body));

    // Structural scope smuggling is refused, not ignored.
    const smuggled = await triage(f, caseId, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-4-smuggle-${f.tag}`,
      clientId: otherRealm.client.id,
      status: 'TRIAGED_MANUAL_QUOTATION_READY',
    });
    assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));
    assert.equal(smuggled.body.error.code, 'VALIDATION_ERROR');

    // Case still untriaged after every denial.
    const caseRow = await db().query(
      `SELECT c.status,
              (SELECT count(*)::int
                 FROM handyman_unlisted_intake_triage_state st
                WHERE st.intake_case_id = c.id) AS anchors
         FROM handyman_unlisted_service_intake_cases c
        WHERE c.id = $1`,
      [caseId],
    );
    assert.equal(caseRow.rows[0].status, 'PENDING_TRIAGE');
    assert.equal(caseRow.rows[0].anchors, 0);
  });

  it('(5) replays idempotently, conflicts on payload mismatch and serializes concurrent decisions to exactly one', async () => {
    const f = await createRealmFixture();
    const caseId = (await createUnlistedCase(f, { idempotencyKey: `case-5-${f.tag}` })).id;
    const body = {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-5-${f.tag}`,
    };

    const first = await triage(f, caseId, body);
    assert.equal(first.status, 201);
    const replay = await triage(f, caseId, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.decision.id, first.body.data.decision.id);

    // Header/body key mismatch and same-key-different-payload conflict.
    const headerOnly = await triage(
      f,
      caseId,
      { ...MANUAL_QUOTE_BODY, manualQuoteUomId: f.uomId },
      f.opsWriter.token,
      { 'Idempotency-Key': `triage-5-${f.tag}` },
    );
    // Header-only replay of the same key and payload: same decision, 200.
    assert.equal(headerOnly.status, 200, JSON.stringify(headerOnly.body));
    assert.equal(headerOnly.body.data.replayed, true);
    assert.equal(headerOnly.body.data.decision.id, first.body.data.decision.id);

    // A body key that disagrees with the header is a validation refusal.
    const keyMismatch = await triage(
      f,
      caseId,
      {
        ...MANUAL_QUOTE_BODY,
        manualQuoteUomId: f.uomId,
        idempotencyKey: `other-key-${f.tag}`,
      },
      f.opsWriter.token,
      { 'Idempotency-Key': `triage-5-${f.tag}` },
    );
    assert.equal(keyMismatch.status, 400, JSON.stringify(keyMismatch.body));

    const mismatch = await triage(f, caseId, {
      ...body,
      manualQuoteSummary: 'Completely different one-time scope description after the fact.',
    });
    assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
    assert.equal(
      mismatch.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_TRIAGE_IDEMPOTENCY_CONFLICT',
    );

    const decisionCount = await db().query(
      `SELECT count(*)::int AS n FROM handyman_unlisted_intake_triage_decisions WHERE intake_case_id = $1`,
      [caseId],
    );
    assert.equal(decisionCount.rows[0].n, 1);

    // Concurrency: two DIFFERENT keys race; exactly one decision may win.
    const concurrentCaseId = (
      await createUnlistedCase(f, { idempotencyKey: `case-5c-${f.tag}` })
    ).id;
    const [a, b] = await Promise.all([
      triage(f, concurrentCaseId, {
        decision: 'REJECT_UNSUPPORTED',
        justification:
          'Operations determined the request needs structural certification we do not provide at this site.',
        idempotencyKey: `triage-5c-a-${f.tag}`,
      }),
      triage(f, concurrentCaseId, {
        ...MANUAL_QUOTE_BODY,
        manualQuoteUomId: f.uomId,
        idempotencyKey: `triage-5c-b-${f.tag}`,
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));
    const raceCount = await db().query(
      `SELECT count(*)::int AS n FROM handyman_unlisted_intake_triage_decisions WHERE intake_case_id = $1`,
      [concurrentCaseId],
    );
    assert.equal(raceCount.rows[0].n, 1);
  });

  it('(6) never fabricates a catalog entry and never bypasses quotation/customer approval', async () => {
    const f = await createRealmFixture();
    const caseId = (await createUnlistedCase(f, { idempotencyKey: `case-6-${f.tag}` })).id;

    const beforeCount = await db().query(
      `SELECT count(*)::int AS n FROM service_catalog WHERE client_id = $1`,
      [f.client.id],
    );

    const foreignCatalog = await triage(f, caseId, {
      decision: 'MATCH_EXISTING_CATALOG_SERVICE',
      justification:
        'Operations attempted to anchor a catalog service that belongs to a different Client.',
      catalogServiceId: f.foreignServiceId,
      idempotencyKey: `triage-6-foreign-${f.tag}`,
    });
    assert.equal(foreignCatalog.status, 400, JSON.stringify(foreignCatalog.body));
    assert.equal(
      foreignCatalog.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_TRIAGE_CATALOG_SERVICE_INVALID',
    );

    const unknownCatalog = await triage(f, caseId, {
      decision: 'MATCH_EXISTING_CATALOG_SERVICE',
      justification: 'Operations attempted to anchor a nonexistent catalog service entry.',
      catalogServiceId: randomUUID(),
      idempotencyKey: `triage-6-unknown-${f.tag}`,
    });
    assert.equal(unknownCatalog.status, 400);

    // A manual decision must not accept a price or a quotation anchor.
    const withPrice = await triage(f, caseId, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      amount: 2_500_000,
      idempotencyKey: `triage-6-price-${f.tag}`,
    });
    assert.equal(withPrice.status, 400, JSON.stringify(withPrice.body));
    const withQuotation = await triage(f, caseId, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      quotationVersionId: randomUUID(),
      idempotencyKey: `triage-6-quot-${f.tag}`,
    });
    assert.equal(withQuotation.status, 400);
    // serviceCatalogId is rejected with the pointer to the governed field.
    const wrongField = await triage(f, caseId, {
      decision: 'MATCH_EXISTING_CATALOG_SERVICE',
      justification: 'Operations used the intake field name instead of the triage field name.',
      serviceCatalogId: f.service.id,
      idempotencyKey: `triage-6-field-${f.tag}`,
    });
    assert.equal(wrongField.status, 400);
    assert.match(
      JSON.stringify(wrongField.body),
      /use catalogServiceId/,
      'wrong field name must point at the documented triage field',
    );

    // Branch discipline: a manual quantity/UOM may not ride on another decision.
    const strayUom = await triage(f, caseId, {
      decision: 'REJECT_UNSUPPORTED',
      justification:
        'Operations rejected the request and must not smuggle a manual quotation UOM along.',
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-6-stray-${f.tag}`,
    });
    assert.equal(strayUom.status, 400, JSON.stringify(strayUom.body));

    const afterCount = await db().query(
      `SELECT count(*)::int AS n FROM service_catalog WHERE client_id = $1`,
      [f.client.id],
    );
    assert.equal(afterCount.rows[0].n, beforeCount.rows[0].n);
    assert.equal(
      await db()
        .query(`SELECT count(*)::int AS n FROM handyman_quotations WHERE handyman_request_id = $1`, [
          caseId,
        ])
        .then((r) => r.rows[0].n),
      0,
      'triage must never create a quotation',
    );

    // The governed anchor works when the entry genuinely exists.
    const ok = await triage(f, caseId, {
      decision: 'MATCH_EXISTING_CATALOG_SERVICE',
      justification: 'Operations matched the request to the existing governed catalog service.',
      catalogServiceId: f.service.id,
      idempotencyKey: `triage-6-ok-${f.tag}`,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.intakeCase.status, 'TRIAGED_CATALOG_MATCHED');
    assert.equal(ok.body.data.decision.catalogServiceId, f.service.id);
  });

  it('(7) enforces the database laws: authorized projection only, immutable decisions, guarded rollback', async () => {
    const f = await createRealmFixture();

    // An unauthorized status write on a fresh case is refused by the DB.
    const rawCaseId = (
      await createUnlistedCase(f, { idempotencyKey: `case-7-raw-${f.tag}` })
    ).id;
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_unlisted_service_intake_cases
              SET status = 'REJECTED_UNSUPPORTED', updated_at = NOW()
            WHERE id = $1`,
          [rawCaseId],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    const caseId = (await createUnlistedCase(f, { idempotencyKey: `case-7-${f.tag}` })).id;
    const ok = await triage(f, caseId, {
      ...MANUAL_QUOTE_BODY,
      manualQuoteUomId: f.uomId,
      idempotencyKey: `triage-7-${f.tag}`,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const decisionId = ok.body.data.decision.id as string;

    // A triaged status is terminal: neither forward, nor sideways, nor back to
    // the queue.
    for (const status of [
      'REJECTED_UNSUPPORTED',
      'TRIAGED_CATALOG_MATCHED',
      'PENDING_TRIAGE',
    ]) {
      await assert.rejects(
        () =>
          db().query(
            `UPDATE handyman_unlisted_service_intake_cases
                SET status = $2, updated_at = NOW()
              WHERE id = $1`,
            [caseId, status],
          ),
        (err: { code?: string }) => err.code === '23514',
      );
    }

    // The state anchor may only hold THIS case's own effective decision: a
    // foreign (but perfectly valid) decision is refused.
    const otherCaseId = (
      await createUnlistedCase(f, { idempotencyKey: `case-7b-${f.tag}` })
    ).id;
    const other = await triage(f, otherCaseId, {
      decision: 'REJECT_UNSUPPORTED',
      justification:
        'Operations rejected this second case; its decision must never become the anchor of another case.',
      idempotencyKey: `triage-7b-${f.tag}`,
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_unlisted_intake_triage_state
              SET triage_decision_id = $2
            WHERE intake_case_id = $1`,
          [caseId, other.body.data.decision.id as string],
        ),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      () =>
        db().query(
          `DELETE FROM handyman_unlisted_intake_triage_state WHERE intake_case_id = $1`,
          [caseId],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    // Intake facts stay immutable (0486 law untouched by this PART).
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_unlisted_service_intake_cases
              SET description = 'Rewritten complaint' WHERE id = $1`,
          [caseId],
        ),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_unlisted_service_intake_cases
              SET preferred_window_start = NOW() + INTERVAL '3 days' WHERE id = $1`,
          [caseId],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    // Decisions are append-only and one-per-case.
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_unlisted_intake_triage_decisions
              SET justification = 'Rewritten after the fact.' WHERE id = $1`,
          [decisionId],
        ),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      () =>
        db().query(`DELETE FROM handyman_unlisted_intake_triage_decisions WHERE id = $1`, [
          decisionId,
        ]),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_unlisted_intake_triage_decisions (
             id, client_id, building_id, tenant_company_id, intake_case_id,
             decision, status_after, justification, triaged_by_user_id,
             idempotency_key, payload_hash
           ) VALUES ($1, $2, $3, $4, $5, 'REJECT_UNSUPPORTED', 'REJECTED_UNSUPPORTED',
             'Direct second decision attempt on a triaged case.', $6, $7, $8)`,
          [
            randomUUID(),
            f.client.id,
            f.building.id,
            f.company.id,
            caseId,
            f.opsWriter.userId,
            `raw-second-${f.tag}`,
            'c'.repeat(64),
          ],
        ),
      (err: { code?: string }) => err.code === '23514',
      'a raw second effective decision must be refused',
    );

    // A decision that claims another Client is refused by scope parity.
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_unlisted_intake_triage_decisions (
             id, client_id, building_id, tenant_company_id, intake_case_id,
             decision, status_after, justification, triaged_by_user_id,
             idempotency_key, payload_hash
           ) VALUES ($1, $2, $3, $4, $5, 'REJECT_UNSUPPORTED', 'REJECTED_UNSUPPORTED',
             'Cross-client raw decision attempt.', $6, $7, $8)`,
          [
            randomUUID(),
            f.foreignClient.id,
            f.building.id,
            f.company.id,
            otherCaseId,
            f.opsWriter.userId,
            `raw-foreign-${f.tag}`,
            'd'.repeat(64),
          ],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    // 0487 refuses rollback while triage facts exist, and the aborted
    // rollback leaves the audit trail untouched.
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await migration0487HandymanUnlistedIntakeOperationsTriage.down(tx);
        }),
      (err: { code?: string }) => err.code === '23514',
    );
    const stillThere = await db().query(
      `SELECT c.status, st.triage_decision_id
         FROM handyman_unlisted_service_intake_cases c
         LEFT JOIN handyman_unlisted_intake_triage_state st
           ON st.intake_case_id = c.id
        WHERE c.id = $1`,
      [caseId],
    );
    assert.equal(stillThere.rows[0].status, 'TRIAGED_MANUAL_QUOTATION_READY');
    assert.equal(stillThere.rows[0].triage_decision_id, decisionId);
    const decisions = await db().query(
      `SELECT count(*)::int AS n FROM handyman_unlisted_intake_triage_decisions WHERE intake_case_id = $1`,
      [caseId],
    );
    assert.equal(decisions.rows[0].n, 1);
  });

  it('(8) leaves catalog-based intake and the existing triage vocabulary untouched', async () => {
    const f = await createRealmFixture();

    const catReq = await api()
      .post(`${V1}/handyman/care/buildings/${f.building.id}/requests`)
      .set(authHeader(f.careUser.token))
      .set('Idempotency-Key', `reg-cat-req-${f.tag}`)
      .send({
        tenantCompanyId: f.company.id,
        tenantPicId: f.pic.id,
        spaceId: f.space.id,
        serviceCatalogId: f.service.id,
        description: 'Catalog-based request regression check after the triage PART.',
        preferredWindowStart: '2026-11-15T10:00:00+07:00',
        preferredWindowEnd: '2026-11-15T12:00:00+07:00',
      });
    assert.equal(catReq.status, 201, JSON.stringify(catReq.body));
    assert.equal(catReq.body.data.status, 'INTAKE');
    assert.equal(catReq.body.data.serviceCatalogId, f.service.id);

    // An unlisted case can still be registered without any catalog id.
    const unlisted = await createUnlistedCase(f, { idempotencyKey: `case-8-${f.tag}` });
    assert.equal(unlisted.status, 'PENDING_TRIAGE');
    const noCatalogField = await api()
      .get(`${V1}/handyman/unlisted-intake-cases/${unlisted.id}`)
      .set(authHeader(f.opsReader.token));
    assert.equal(noCatalogField.status, 200);
    assert.equal(noCatalogField.body.data.serviceCatalogId, undefined);

    // The intake creation surface still refuses a catalog id.
    const rejected = await api()
      .post(`${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`)
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        requestedServiceName: 'Attempted catalog id at intake',
        description: 'This must be refused at the intake boundary.',
        serviceCatalogId: f.service.id,
        idempotencyKey: `case-8-reject-${f.tag}`,
      });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));

    // The widened status vocabulary is the single source of truth.
    assert.deepEqual(HANDYMAN_UNLISTED_INTAKE_STATUSES, [
      'PENDING_TRIAGE',
      'AWAITING_INFORMATION',
      'TRIAGED_CATALOG_MATCHED',
      'TRIAGED_CLIENT_CUSTOM_SERVICE',
      'TRIAGED_MANUAL_QUOTATION_READY',
      'REJECTED_UNSUPPORTED',
    ]);
  });

  it('(9) documents the triage surface and schemas in OpenAPI', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8')) as Record<string, any>;
    const path = '/handyman/operations/unlisted-intake-cases/{intakeCaseId}/triage-decisions';
    assert.ok(spec.paths[path]?.post, 'OpenAPI must document POST triage decision');
    assert.ok(spec.paths[path]?.get, 'OpenAPI must document GET triage history');
    assert.equal(spec.paths[path].post['x-required-permission'], 'tenant_company.manage');
    for (const code of [
      'HANDYMAN_UNLISTED_INTAKE_TRIAGE_ALREADY_RECORDED',
      'HANDYMAN_UNLISTED_INTAKE_TRIAGE_IDEMPOTENCY_CONFLICT',
      'HANDYMAN_UNLISTED_INTAKE_TRIAGE_CATALOG_SERVICE_INVALID',
      'HANDYMAN_UNLISTED_INTAKE_TRIAGE_UOM_INVALID',
    ]) {
      assert.ok(
        spec.paths[path].post['x-error-codes'].includes(code),
        `OpenAPI must document ${code}`,
      );
    }
    for (const schemaName of [
      'HandymanUnlistedIntakeTriageDecision',
      'CreateHandymanUnlistedIntakeTriageRequest',
      'HandymanUnlistedIntakeTriageMutationResult',
    ]) {
      assert.ok(spec.components.schemas[schemaName], `OpenAPI must document ${schemaName}`);
    }
    assert.deepEqual(
      [...spec.components.schemas.HandymanUnlistedIntakeStatus.enum].sort(),
      [...HANDYMAN_UNLISTED_INTAKE_STATUSES].sort(),
    );
    assert.deepEqual(
      [...spec.components.schemas.HandymanUnlistedIntakeTriageDecision.properties.decision.enum].sort(),
      [...HANDYMAN_UNLISTED_INTAKE_TRIAGE_DECISIONS].sort(),
    );
    const caseProps = spec.components.schemas.HandymanUnlistedIntakeCase.properties;
    for (const key of ['triageDecisionId', 'triagedAt', 'triage', 'triageHistory']) {
      assert.ok(caseProps[key], `HandymanUnlistedIntakeCase must expose ${key}`);
    }
  });
});
