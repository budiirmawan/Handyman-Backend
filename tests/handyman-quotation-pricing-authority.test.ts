/**
 * Only an explicitly authorized Handyman Operations actor may create, modify,
 * price, revise and issue a quotation. A customer / Tenant PIC may NEVER touch
 * quotation items, quantities, prices, discounts, DP or commercial terms —
 * including on a DRAFT — and holding `tenant_company.manage` does not change
 * that (the tenant side carries the same vocabulary; the service decides WHO
 * may write commercial content). A dual-role actor fails closed toward the
 * customer. These cases exercise the new service-level authority through the
 * real lanes and confirm what must stay untouched: authorized Operations
 * authoring, the customer's own APPROVE/REJECT on an ISSUED version (which
 * Operations can never perform on the customer's behalf), Client/Building
 * isolation, idempotency and the existing lifecycle.
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
  expireHandymanQuotationVersion,
  getHandymanQuotationVersionTotals,
  issueHandymanQuotationVersion,
  listHandymanQuotationVersionLines,
  supersedeHandymanQuotationVersion,
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
const PORT = 55582;
const DIR = '/tmp/asentra-handyman-quotation-pricing-authority-pg';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const FUTURE = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';
let adminToken = '';
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
  assert.ok(config, 'Pricing-authority tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;
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
async function createUser(
  displayName: string,
  buildingIds: string[],
  permissionCodes: string[] = ['tenant_company.read', 'tenant_company.manage'],
) {
  const tag = suffix();
  const email = `pa-${tag.toLowerCase()}@pricing-authority.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: `PA_${tag}`, name: `Role ${tag}` });
  for (const code of permissionCodes) {
    let perm = await permissionRepository.findByCode(code);
    if (!perm) perm = await permissionService.createPermission({ code, name: code });
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  if (permissionCodes.length > 0) await roleService.assignRoleToUser(user.id, role.id);
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
  // A same-Building actor WITHOUT the commercial write grant (fail-closed probe).
  const readerOnly = await createUser(`Reader Only ${tag}`, [building.id], ['tenant_company.read']);

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
    readerOnly,
    siblingCustomer,
    service,
    uomId,
  };
}

/**
 * A quotable thread (catalog lane: the pricing-authority law is
 * lane-independent) with one LABOR line at 10 x 150.000 = 1.500.000 and one
 * MATERIAL at 2 x 300.000 = 600.000. With `withQuotation: false` only the
 * diagnosed REQUEST is prepared, so a caller can test who may CREATE the
 * quotation at all.
 */
async function quotationThread(
  f: Fixture,
  options: { withQuotation?: boolean } = {},
) {
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
  if (options.withQuotation === false) {
    return { requestId: request.id, quotationId: '', versionId: '' };
  }
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


async function denialCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return 'ALLOWED';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function rowCount(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) t`, params))[0].n);
}

const LINE_INPUT = {
  lineType: 'MATERIAL',
  description: 'Customer-authored line that must never exist',
  quantity: 1,
  finalQuotedUnitAmount: 1,
};

describe('CR-HM-MANUAL-QUOTATION-01 PART 03E — Operations-only pricing authority', () => {
  it('the thread\'s customer can not create, price, revise, issue or expire a quotation - even with tenant_company.manage', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    assert.ok(
      (
        await permissionRepository.listActivePermissionCodesForUser(f.customer.userId)
      ).includes('tenant_company.manage'),
      'the customer actor really holds the tenant-side manage vocabulary',
    );

    // Creation itself.
    const raw = await quotationThread(f, { withQuotation: false });
    assert.equal(
      await denialCode(() =>
        createHandymanQuotation({ handymanRequestId: raw.requestId }, f.customer.userId),
      ),
      'PERMISSION_DENIED',
      'the customer may not open a quotation thread',
    );
    assert.equal(
      await rowCount('SELECT 1 FROM handyman_quotations WHERE handyman_request_id = $1', [raw.requestId]),
      0,
      'a refused creation writes no quotation thread',
    );

    // Items, prices, DP, revision and presentation on the DRAFT the customer
    // is watching - the frozen rule does not care that a DRAFT is unwritten.
    const thread = await quotationThread(f);
    const linesBefore = await rowCount(
      'SELECT 1 FROM handyman_quotation_lines WHERE quotation_version_id = $1',
      [thread.versionId],
    );
    const customerAttempts = [
      [
        'add a line',
        () =>
          addHandymanQuotationLine(
            thread.versionId,
            { ...LINE_INPUT, uomId: f.uomId, currency: 'IDR' } as never,
            f.customer.userId,
          ),
      ],
      ['revise', () => createHandymanQuotationRevision(thread.quotationId, f.customer.userId)],
      [
        'price or set DP by issuing',
        () =>
          issueHandymanQuotationVersion(
            thread.versionId,
            { validUntil: FUTURE(), dpRequired: true, dpPercentage: 1 },
            f.customer.userId,
          ),
      ],
      [
        'expire the quote',
        () => expireHandymanQuotationVersion(thread.versionId, f.customer.userId),
      ],
      [
        'withdraw the quote',
        () => supersedeHandymanQuotationVersion(thread.versionId, f.customer.userId),
      ],
    ] as const;
    for (const [label, run] of customerAttempts) {
      assert.equal(
        await denialCode(run),
        'PERMISSION_DENIED',
        `the customer may not ${label}`,
      );
    }
    assert.equal(
      await rowCount('SELECT 1 FROM handyman_quotation_lines WHERE quotation_version_id = $1', [
        thread.versionId,
      ]),
      linesBefore,
      'no line was written by a refused mutation',
    );
    assert.equal(
      await rowCount('SELECT 1 FROM handyman_quotation_versions WHERE quotation_id = $1', [
        thread.quotationId,
      ]),
      1,
      'no DRAFT fork by a refused revision',
    );
    assert.equal(
      (
        await q<{ status: string }>(
          `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
          [thread.versionId],
        )
      )[0].status,
      'DRAFT',
      'a refused issue / expire / supersede changed no lifecycle state',
    );

    // The same answers through the real HTTP contract - route RBAC alone is
    // not the law here, because this actor DOES hold tenant_company.manage.
    const httpLine = await api()
      .post(`${V1}/handyman/quotation-versions/${thread.versionId}/lines`)
      .set({ Authorization: `Bearer ${f.customer.token}` })
      .send({ ...LINE_INPUT, uomId: f.uomId, currency: 'IDR' });
    assert.equal(httpLine.status, 403, JSON.stringify(httpLine.body));
    assert.equal(httpLine.body.error.code, 'PERMISSION_DENIED');
    const httpRevision = await api()
      .post(`${V1}/handyman/quotations/${thread.quotationId}/versions`)
      .set({ Authorization: `Bearer ${f.customer.token}` })
      .set('Idempotency-Key', `rev-${randomUUID()}`)
      .send({ dpRequired: true, dpPercentage: 5 });
    assert.equal(httpRevision.status, 403, JSON.stringify(httpRevision.body));
    assert.equal(httpRevision.body.error.code, 'PERMISSION_DENIED');
    const httpIssue = await api()
      .post(`${V1}/handyman/quotation-versions/${thread.versionId}/issue`)
      .set({ Authorization: `Bearer ${f.customer.token}` })
      .send({ validUntil: FUTURE() });
    assert.equal(httpIssue.status, 403, JSON.stringify(httpIssue.body));
    assert.equal(httpIssue.body.error.code, 'PERMISSION_DENIED');
    assert.equal(
      (
        await q<{ status: string }>(
          `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
          [thread.versionId],
        )
      )[0].status,
      'DRAFT',
      'the HTTP refusals wrote nothing either',
    );

    // Fail-closed for any actor without the Operations write grant, even one
    // with legitimate Building access.
    assert.equal(
      await denialCode(() =>
        addHandymanQuotationLine(
          thread.versionId,
          { ...LINE_INPUT, uomId: f.uomId, currency: 'IDR' } as never,
          f.readerOnly.userId,
        ),
      ),
      'PERMISSION_DENIED',
      'Building access alone never prices a quotation',
    );
  });

  it('an authorized Operations actor keeps the whole commercial workflow', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const raw = await quotationThread(f, { withQuotation: false });
    const bundle = await createHandymanQuotation(
      { handymanRequestId: raw.requestId },
      f.operations.userId,
    );
    const versionId = bundle.versions[0].id;
    const added = await addHandymanQuotationLine(
      versionId,
      {
        lineType: 'MATERIAL',
        description: 'Operations-priced material',
        quantity: 3,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 250000,
      },
      f.operations.userId,
    );
    assert.equal(Number(added.lineTotal), 750000);
    const issuedV1 = await issueHandymanQuotationVersion(
      versionId,
      { validUntil: FUTURE(), dpRequired: true, dpPercentage: 25 },
      f.operations.userId,
    );
    assert.equal(issuedV1.status, 'ISSUED');
    assert.equal(Number(issuedV1.dpAmount), 187500, 'DP re-derived from the total');

    const revision = await createHandymanQuotationRevision(
      bundle.quotation.id,
      f.operations.userId,
      { dpRequired: true, dpPercentage: 30 },
    );
    assert.equal(revision.versionNumber, 2);
    assert.equal(revision.status, 'DRAFT');
    // Catalog-lane revisions re-derive lines from request items; this thread
    // has none, so Operations prices the revision explicitly before issuing it.
    await addHandymanQuotationLine(
      revision.id,
      {
        lineType: 'LABOR',
        description: 'Operations re-priced labor',
        quantity: 4,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 200000,
      },
      f.operations.userId,
    );
    const issuedV2 = await issueHandymanQuotationVersion(
      revision.id,
      { validUntil: FUTURE() },
      f.operations.userId,
    );
    assert.equal(issuedV2.status, 'ISSUED');
    assert.equal(
      Number((await q<{ amount: string }>(
        `SELECT dp_amount AS amount FROM handyman_quotation_versions WHERE id = $1`,
        [revision.id],
      ))[0].amount),
      240000,
      'the revision DP percentage is inherited at issue',
    );
    assert.deepEqual(
      (
        await q<{ status: string }>(
          `SELECT status FROM handyman_quotation_versions WHERE quotation_id = $1 ORDER BY version_number`,
          [bundle.quotation.id],
        )
      ).map((row) => row.status),
      ['SUPERSEDED', 'ISSUED'],
      'the lifecycle the customer can not drive still behaves exactly as before',
    );
    assert.equal(
      (await listHandymanQuotationVersionLines(versionId, f.operations.userId)).length,
      1,
      'the author keeps reading what it priced',
    );
    // Expiry stays reachable for Operations once the window has really passed
    // (this law is about WHO may act, never about when the clock allows it).
    await q(`UPDATE handyman_quotation_versions SET valid_until = now() - interval '1 day' WHERE id = $1`, [
      revision.id,
    ]);
    const expired = await expireHandymanQuotationVersion(revision.id, f.operations.userId);
    assert.equal(expired.status, 'EXPIRED');

    const httpRevision = await api()
      .post(`${V1}/handyman/quotations/${bundle.quotation.id}/versions`)
      .set({ Authorization: `Bearer ${f.operations.token}` })
      .set('Idempotency-Key', `ops-rev-${randomUUID()}`)
      .send({ dpRequired: true, dpPercentage: 40 });
    assert.equal(httpRevision.status, 201, JSON.stringify(httpRevision.body));
    assert.equal(httpRevision.body.data.dpPercentage, 40);
    const httpLine = await api()
      .post(`${V1}/handyman/quotation-versions/${httpRevision.body.data.id}/lines`)
      .set({ Authorization: `Bearer ${f.operations.token}` })
      .send({
        lineType: 'LABOR',
        description: 'Operations over HTTP',
        quantity: 1,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100000,
      });
    assert.equal(httpLine.status, 201, JSON.stringify(httpLine.body));
  });

  it('Operations can withdraw an ISSUED version (supersede stays reachable)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await quotationThread(f);
    await issueHandymanQuotationVersion(thread.versionId, { validUntil: FUTURE() }, f.operations.userId);
    const withdrawn = await supersedeHandymanQuotationVersion(
      thread.versionId,
      f.operations.userId,
    );
    assert.equal(withdrawn.status, 'SUPERSEDED');
  });

  it('the exclusion is exactly this thread\'s customer side', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await quotationThread(f);
    // A Tenant PIC of ANOTHER tenant company in the same Building is not this
    // thread's customer side, so Operations-style authoring stays available.
    assert.equal(
      await denialCode(() =>
        addHandymanQuotationLine(
          thread.versionId,
          { ...LINE_INPUT, uomId: f.uomId, currency: 'IDR' } as never,
          f.otherPicUser.userId,
        ),
      ),
      'ALLOWED',
      'another tenant\'s PIC is not this thread\'s customer',
    );
    // And the thread's own customer stays refused on the same row.
    assert.equal(
      await denialCode(() =>
        addHandymanQuotationLine(
          thread.versionId,
          { ...LINE_INPUT, uomId: f.uomId, currency: 'IDR' } as never,
          f.customer.userId,
        ),
      ),
      'PERMISSION_DENIED',
    );
    // A PIC relink moves the exclusion with the authority: the moment a user
    // is no longer this company\'s active PIC they are not customer-side here.
    const exCustomer = f.customer.userId;
    await q(`UPDATE tenant_pics SET status = 'INACTIVE', is_primary = false WHERE id = $1`, [f.pic.id]);
    assert.equal(
      await denialCode(() =>
        addHandymanQuotationLine(
          thread.versionId,
          { ...LINE_INPUT, uomId: f.uomId, currency: 'IDR' } as never,
          exCustomer,
        ),
      ),
      'ALLOWED',
      'the exclusion follows the ACTIVE PIC linkage, never a stale identity',
    );
  });

  it('the customer decision stays the customer\'s, and Operations can not decide for them', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const thread = await quotationThread(f);
    await issueHandymanQuotationVersion(thread.versionId, { validUntil: FUTURE() }, f.operations.userId);

    const approved = await api()
      .post(`${V1}/handyman/quotation-versions/${thread.versionId}/decision`)
      .set({ Authorization: `Bearer ${f.customer.token}` })
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.decision, 'APPROVE');
    assert.equal(approved.body.data.quotationVersionId, thread.versionId);
    assert.equal(approved.body.data.executionScope.approvedQuotationVersionId, thread.versionId);
    // Idempotent replay of the customer's own decision is untouched by this law.
    const replay = await api()
      .post(`${V1}/handyman/quotation-versions/${thread.versionId}/decision`)
      .set({ Authorization: `Bearer ${f.customer.token}` })
      .set('Idempotency-Key', approved.body.data.idempotencyKey)
      .send({ decision: 'APPROVE' });
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, approved.body.data.id);
    assert.equal(
      await rowCount('SELECT 1 FROM handyman_quotation_decisions WHERE quotation_version_id = $1', [
        thread.versionId,
      ]),
      1,
    );

    // No Operations impersonation of consent, at either end of the surface.
    for (const actor of [f.operations, undefined]) {
      const attempted = await api()
        .post(`${V1}/handyman/quotation-versions/${thread.versionId}/decision`)
        .set(
          actor ? { Authorization: `Bearer ${actor.token}` } : { Authorization: `Bearer ${adminToken}` },
        )
        .set('Idempotency-Key', `ops-${randomUUID()}`)
        .send({ decision: 'APPROVE' });
      assert.equal(attempted.status, 403, JSON.stringify(attempted.body));
      assert.equal(
        attempted.body.error.code,
        'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN',
        `${actor ? 'operations' : 'admin'} may not decide for the customer`,
      );
    }
    assert.equal(
      await rowCount('SELECT 1 FROM handyman_quotation_decisions WHERE quotation_version_id = $1', [
        thread.versionId,
      ]),
      1,
    );
  });

  it('keeps the Building guard first: an out-of-scope actor still gets the realm denial', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const raw = await quotationThread(f, { withQuotation: false });
    const thread = await quotationThread(f);
    assert.equal(
      await denialCode(() =>
        createHandymanQuotation({ handymanRequestId: raw.requestId }, f.siblingCustomer.userId),
      ),
      'BUILDING_ACCESS_DENIED',
      'the realm answer is unchanged for out-of-scope actors',
    );
    assert.equal(
      await denialCode(() =>
        addHandymanQuotationLine(
          thread.versionId,
          { ...LINE_INPUT, uomId: f.uomId, currency: 'IDR' } as never,
          f.siblingCustomer.userId,
        ),
      ),
      'BUILDING_ACCESS_DENIED',
    );
    assert.equal(
      await denialCode(() =>
        createHandymanQuotationRevision(thread.quotationId, f.siblingCustomer.userId),
      ),
      'BUILDING_ACCESS_DENIED',
    );
    assert.equal(
      await rowCount('SELECT 1 FROM handyman_quotation_versions WHERE quotation_id = $1', [
        thread.quotationId,
      ]),
      1,
      'a realm denial writes nothing',
    );
  });
});
