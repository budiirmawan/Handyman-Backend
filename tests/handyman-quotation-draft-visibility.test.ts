/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 03D focused validation: CUSTOMER DRAFT
 * VISIBILITY GUARD.
 *
 * A quotation version becomes the customer's commercial offer only when it is
 * ISSUED. These cases prove the new law on the real quotation reads
 * (`listHandymanQuotationVersionLines` / `getHandymanQuotationVersionTotals`,
 * one of them also through the HTTP contract) without touching anything else:
 *
 *   - this thread's CUSTOMER side (an active User linked to an active Tenant
 *     PIC of the quotation's tenant company) can not read the lines or derived
 *     prices of an un-issued DRAFT — including a PART 03B revision that is
 *     still in flight — and not even by addressing the version id directly;
 *     the answer is the ordinary 404 HANDYMAN_QUOTATION_VERSION_NOT_FOUND, so
 *     a DRAFT is indistinguishable from an unknown id (no status oracle);
 *   - ISSUED, SUPERSEDED and APPROVED versions stay fully readable to the
 *     customer (issued visibility + legitimate historical reads);
 *   - authorized Operations authors keep reading the DRAFT they are pricing,
 *     and a PIC of ANOTHER tenant company is not this thread's customer;
 *   - the Building-scope guard still runs first, so an out-of-scope actor gets
 *     the existing 403 for a DRAFT exactly as for an ISSUED version;
 *   - consent, approval, RBAC and every response schema are unchanged.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { floorService } from '../src/modules/floors';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestService,
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  decideHandymanQuotation,
  getHandymanQuotationVersionTotals,
  issueHandymanQuotationVersion,
  listHandymanQuotationVersionLines,
} from '../src/modules/handyman-quotations';
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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const PORT = 55580;
const DIR = '/tmp/asentra-handyman-quotation-draft-visibility-pg';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const FUTURE = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';
const disciplineIds: Record<string, string> = {};

function db(): Pool {
  if (!pool) throw new Error('Test database pool not initialized');
  return pool;
}

async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db().query<T>(sql, params);
  return result.rows;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function requireDatabase(t: TestContext): boolean {
  if (!pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
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
  assert.ok(config, 'Draft-visibility tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
  for (const code of ['GENERAL_HANDYMAN', 'MINOR_CIVIL']) {
    const discipline = await handymanDisciplineRepository.findDisciplineByCode(
      undefined,
      code,
    );
    if (!discipline) throw new Error(`Discipline seed missing: ${code}`);
    disciplineIds[code] = discipline.id;
  }
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

/** A user with the given permissions, Building access, and a live session. */
async function createUser(displayName: string, buildingIds: string[]) {
  const tag = suffix();
  const email = `dv-${tag.toLowerCase()}@draft-visibility.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: `DV_${tag}`, name: `Role ${tag}` });
  for (const code of ['tenant_company.read', 'tenant_company.manage']) {
    let perm = await permissionRepository.findByCode(code);
    if (!perm) perm = await permissionService.createPermission({ code, name: code });
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

type Fixture = Awaited<ReturnType<typeof createRealmFixture>>;

async function createRealmFixture() {
  const tag = suffix();
  const client = await clientService.createClient({ code: `DVCL_${tag}`, name: `Client ${tag}` });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `DVPR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `DVBL_${tag}`,
    name: `Building ${tag}`,
  });
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: property.id,
    code: `DVSB_${tag}`,
    name: `Sibling Building ${tag}`,
  });
  for (const buildingId of [building.id, siblingBuilding.id]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId });
  }
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `DVFL_${tag}`,
    name: 'Floor 1',
    levelNumber: 1,
  });
  const area = await areaService.createArea({ floorId: floor.id, code: `DVAR_${tag}`, name: 'Area 1' });
  const room = await roomService.createRoom({ areaId: area.id, code: `DVRM_${tag}`, name: 'Room 1' });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `DVSP_${tag}`,
    name: 'Unit 101',
  });
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `DVTC_${tag}`, tenantName: `Tenant ${tag}` },
    adminId,
  );
  await q(`UPDATE tenant_companies SET verification_status = 'VERIFIED' WHERE id = $1`, [company.id]);
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminId,
  );

  // This thread's customer: the ACTIVE Tenant PIC's own platform user.
  const customer = await createUser(`Customer PIC ${tag}`, [building.id]);
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: `PIC ${tag}`,
      email: `pic-${tag.toLowerCase()}@tenant.test`,
      userId: customer.userId,
      isPrimary: true,
    },
    adminId,
  );
  // Another tenant company of the same Client, whose PIC also holds this
  // Building: NOT this thread's customer side.
  const otherCompany = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `DVTO_${tag}`, tenantName: `Other Tenant ${tag}` },
    adminId,
  );
  await q(`UPDATE tenant_companies SET verification_status = 'VERIFIED' WHERE id = $1`, [
    otherCompany.id,
  ]);
  const otherPicUser = await createUser(`Other Tenant PIC ${tag}`, [building.id]);
  await tenantPicService.createTenantPic(
    {
      tenantCompanyId: otherCompany.id,
      picName: `Other PIC ${tag}`,
      email: `other-${tag.toLowerCase()}@tenant.test`,
      userId: otherPicUser.userId,
      isPrimary: true,
    },
    adminId,
  );

  const operations = await createUser(`Operations ${tag}`, [building.id]);
  const siblingCustomer = await createUser(`Sibling Customer ${tag}`, [siblingBuilding.id]);

  const service = await serviceCatalogService.createServiceCatalogEntry(
    { clientId: client.id, code: `DVSVC_${tag}`, name: 'Draft visibility service', category: 'HANDYMAN' },
    adminId,
  );
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Lot', 'lot', 'OTHER')`,
    [uomId, client.id, `DVUOM_${tag}`],
  );
  return {
    tag,
    client,
    building,
    siblingBuilding,
    space,
    company,
    otherCompany,
    pic,
    customer,
    otherPicUser,
    operations,
    siblingCustomer,
    service,
    uomId,
  };
}

/** A quotable thread (catalog lane: the law is lane-independent) with one
 * LABOR line at 10 x 150.000 = 1.500.000 and one MATERIAL at 600.000. */
async function quotationThread(f: Fixture) {
  const attributionId = randomUUID();
  await q(
    `INSERT INTO handyman_channel_attributions
       (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
        origin_channel, origin_reference, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'BM_SUPER_APP', $7, $8)`,
    [
      attributionId,
      f.client.id,
      f.company.id,
      f.pic.id,
      f.building.id,
      f.space.id,
      `dv:${randomUUID()}`,
      f.customer.userId,
    ],
  );
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
    { channelAttributionId: attributionId, serviceCatalogId: f.service.id },
    adminId,
  );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Priced from the governed catalog.',
    },
    adminId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId: disciplineIds.GENERAL_HANDYMAN,
      diagnosis: 'Standard catalog work.',
    },
    adminId,
  );
  const bundle = await createHandymanQuotation({ handymanRequestId: request.id }, adminId);
  const versionId = bundle.versions[0].id;
  await addHandymanQuotationLine(
    versionId,
    {
      lineType: 'LABOR',
      description: 'Catalog labor',
      quantity: 10,
      uomId: f.uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 150000,
    },
    adminId,
  );
  await addHandymanQuotationLine(
    versionId,
    {
      lineType: 'MATERIAL',
      description: 'Catalog material',
      quantity: 2,
      uomId: f.uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 300000,
    },
    adminId,
  );
  return { requestId: request.id, quotationId: bundle.quotation.id, versionId };
}

describe('CR-HM-MANUAL-QUOTATION-01 PART 03D — customer DRAFT visibility guard', () => {
  it('hides an un-issued DRAFT (including an in-flight revision) from the customer, by id and over HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await quotationThread(f);

    await assert.rejects(
      () => listHandymanQuotationVersionLines(thread.versionId, f.customer.userId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_QUOTATION_VERSION_NOT_FOUND',
      'a DRAFT is not the customer\'s quotation yet',
    );
    await assert.rejects(
      () => getHandymanQuotationVersionTotals(thread.versionId, f.customer.userId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_QUOTATION_VERSION_NOT_FOUND',
      'nor are its derived prices',
    );

    // The same answer through the real HTTP contract: 404, and nothing of the
    // line payload or the amounts is serialized.
    const httpLines = await api()
      .get(`${V1}/handyman/quotation-versions/${thread.versionId}/lines`)
      .set({ Authorization: `Bearer ${f.customer.token}` });
    assert.equal(httpLines.status, 404, JSON.stringify(httpLines.body));
    assert.equal(httpLines.body.error.code, 'HANDYMAN_QUOTATION_VERSION_NOT_FOUND');
    assert.equal(httpLines.body.data, undefined);
    const httpTotals = await api()
      .get(`${V1}/handyman/quotation-versions/${thread.versionId}/totals`)
      .set({ Authorization: `Bearer ${f.customer.token}` });
    assert.equal(httpTotals.status, 404);
    assert.equal(
      JSON.stringify(httpTotals.body).includes('150000'),
      false,
      'no DRAFT price may leak in the refusal',
    );

    // A PART 03B revision in flight is a DRAFT too: invisible, while the
    // presented ISSUED version stays exactly what it was.
    await issueHandymanQuotationVersion(thread.versionId, { validUntil: FUTURE() }, adminId);
    const revision = await createHandymanQuotationRevision(thread.quotationId, adminId);
    await addHandymanQuotationLine(
      revision.id,
      {
        lineType: 'MATERIAL',
        description: 'Extra material under revision',
        quantity: 1,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 600000,
      },
      adminId,
    );
    await assert.rejects(
      () => listHandymanQuotationVersionLines(revision.id, f.customer.userId),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_QUOTATION_VERSION_NOT_FOUND',
      'an un-issued revision is not customer-visible',
    );
    const stillVisible = await listHandymanQuotationVersionLines(
      thread.versionId,
      f.customer.userId,
    );
    assert.equal(stillVisible.length, 2, 'the presented version is unaffected');
  });

  it('keeps ISSUED, SUPERSEDED and APPROVED versions readable to the customer', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await quotationThread(f);
    const issued = await issueHandymanQuotationVersion(
      thread.versionId,
      { validUntil: FUTURE() },
      adminId,
    );
    assert.equal(issued.status, 'ISSUED');
    const lines = await listHandymanQuotationVersionLines(thread.versionId, f.customer.userId);
    assert.deepEqual(
      lines.map((line) => [line.lineType, line.quantity, line.lineTotal]),
      [
        ['LABOR', 10, 1500000],
        ['MATERIAL', 2, 600000],
      ],
    );
    assert.deepEqual(await getHandymanQuotationVersionTotals(thread.versionId, f.customer.userId), {
      laborSubtotal: 1500000,
      materialSubtotal: 600000,
      total: 2100000,
      currency: 'IDR',
      lineCount: 2,
    });

    // The revision is issued: its predecessor becomes SUPERSEDED history, which
    // the customer must still be able to read (legitimate historical read). On
    // this catalog lane the revision re-derives its own lines (PART 03B law),
    // so it is authored with one line before issuance.
    const revision = await createHandymanQuotationRevision(thread.quotationId, adminId);
    await addHandymanQuotationLine(
      revision.id,
      {
        lineType: 'MATERIAL',
        description: 'Revised material scope',
        quantity: 3,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100000,
      },
      adminId,
    );
    const issuedV2 = await issueHandymanQuotationVersion(
      revision.id,
      { validUntil: FUTURE() },
      adminId,
    );
    assert.equal(issuedV2.status, 'ISSUED');
    assert.equal(
      (await listHandymanQuotationVersionLines(thread.versionId, f.customer.userId)).length,
      2,
      'a superseded version stays readable',
    );
    assert.deepEqual(await getHandymanQuotationVersionTotals(revision.id, f.customer.userId), {
      laborSubtotal: 0,
      materialSubtotal: 300000,
      total: 300000,
      currency: 'IDR',
      lineCount: 1,
    });

    // APPROVED: still readable (the record the customer consented to).
    const decision = await decideHandymanQuotation(
      revision.id,
      { decision: 'APPROVE', idempotencyKey: `dv-${randomUUID()}` },
      f.customer.userId,
    );
    assert.equal(decision.decision, 'APPROVE');
    assert.equal(
      (await q<{ status: string }>(
        `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
        [revision.id],
      ))[0].status,
      'APPROVED',
    );
    assert.deepEqual(await getHandymanQuotationVersionTotals(revision.id, f.customer.userId), {
      laborSubtotal: 0,
      materialSubtotal: 300000,
      total: 300000,
      currency: 'IDR',
      lineCount: 1,
    });
  });

  it('leaves authorized Operations access (and non-customers) untouched', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await quotationThread(f);

    // The author of the DRAFT keeps reading it: pricing work is uninterrupted.
    const opsLines = await listHandymanQuotationVersionLines(thread.versionId, f.operations.userId);
    assert.equal(opsLines.length, 2);
    assert.equal(
      (await getHandymanQuotationVersionTotals(thread.versionId, f.operations.userId)).total,
      2100000,
    );
    assert.equal((await listHandymanQuotationVersionLines(thread.versionId, adminId)).length, 2);
    // and keeps writing it.
    const added = await addHandymanQuotationLine(
      thread.versionId,
      {
        lineType: 'MATERIAL',
        description: 'Operations-added material',
        quantity: 1,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 50000,
      },
      f.operations.userId,
    );
    assert.equal(added.quotationVersionId, thread.versionId);

    // A Tenant PIC of ANOTHER tenant company is not this thread's customer
    // side, so the guard does not treat them as one.
    assert.equal(
      (await listHandymanQuotationVersionLines(thread.versionId, f.otherPicUser.userId)).length,
      3,
    );

    // Over HTTP the Operations session still gets the DRAFT lines, with the
    // same frozen response shape.
    const res = await api()
      .get(`${V1}/handyman/quotation-versions/${thread.versionId}/lines`)
      .set({ Authorization: `Bearer ${f.operations.token}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      Object.keys(res.body.data[0]).sort(),
      [
        'createdAt',
        'currency',
        'description',
        'finalQuotedUnitAmount',
        'id',
        'lineTotal',
        'lineType',
        'quantity',
        'quotationVersionId',
        'updatedAt',
        'uomId',
      ].sort(),
      'the response schema is unchanged',
    );
  });

  it('keeps the Building-scope guard first: an out-of-scope actor learns nothing about any status', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await quotationThread(f);
    const denialOf = async (versionId: string, actorUserId: string) =>
      await listHandymanQuotationVersionLines(versionId, actorUserId).then(
        () => 'ALLOWED',
        (error: unknown) => errorCode(error),
      );
    // A DRAFT: the out-of-scope actor is refused by the Building guard exactly
    // as before (403, never the 404 the customer-side law answers), so the new
    // law gives nobody a status oracle and leaks no existence signal.
    assert.equal(
      await denialOf(thread.versionId, f.siblingCustomer.userId),
      'BUILDING_ACCESS_DENIED',
      'cross-Building actor: the Building guard runs first',
    );
    assert.equal(
      await denialOf(thread.versionId, f.customer.userId),
      'HANDYMAN_QUOTATION_VERSION_NOT_FOUND',
      'this thread\'s customer: the DRAFT is hidden behind the ordinary 404',
    );
    // And once ISSUED, the same ordering still denies the out-of-scope actor
    // with 403 BUILDING_ACCESS_DENIED rather than a status-sensitive answer.
    await issueHandymanQuotationVersion(thread.versionId, { validUntil: FUTURE() }, adminId);
    assert.equal(
      await getHandymanQuotationVersionTotals(thread.versionId, f.siblingCustomer.userId).then(
        () => 'ALLOWED',
        (error: unknown) => errorCode(error),
      ),
      'BUILDING_ACCESS_DENIED',
      'an ISSUED version is no more discoverable cross-Building than a DRAFT',
    );
    assert.equal(
      await denialOf(thread.versionId, f.siblingCustomer.userId),
      'BUILDING_ACCESS_DENIED',
    );
    assert.deepEqual(await getHandymanQuotationVersionTotals(thread.versionId, f.customer.userId), {
      laborSubtotal: 1500000,
      materialSubtotal: 600000,
      total: 2100000,
      currency: 'IDR',
      lineCount: 2,
    });
  });
});
