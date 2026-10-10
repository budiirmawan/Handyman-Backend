import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  BIND_HANDYMAN_QUOTATION_APPROVAL_BINDING_OPERATION_KEY,
  HANDYMAN_QUOTATION_APPROVAL_BINDING_MANAGE_PERMISSION,
  bindHandymanQuotationApprovalBinding,
  getHandymanQuotationApprovalBinding,
  revokeHandymanQuotationApprovalBinding,
} from '../src/modules/handyman-quotation-approval-bindings';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';

/**
 * W03 PART 03B2 — focused RUNTIME tests for the Tenant PIC approval-binding
 * surface (schema floor `0437`/`0438` exists; this PART is the service, the
 * three staff routes, the dedicated permission, and the audit trail).
 *
 * What each case is for, in the PART's own words: eligible, invalid,
 * cross-tenant, PIC revoked, self-binding, replay, concurrent bind/rebind —
 * plus the four runtime facts a schema-only PART cannot prove: the refusal
 * ENVELOPE (uniform 404, 403 denial, 409 conflict — never a raw 23514
 * rendered as 500), the IDEMPOTENCY substrate's success-only law (a refused
 * bind leaves no claim, so the same key works once corrected), the
 * STRUCTURAL-IGNORE of smuggled body keys (B11), and the AUDIT trail being
 * id-only (no PII in the ledger projection, no PII in the journal).
 *
 * Every write goes through the real service (never raw SQL) except the two
 * fixtures that no service can produce yet — a decision row on the thread
 * (B18) and a closed occupancy (B15) — because the ledger itself refuses every
 * new decision until 03C (the documented controlled standstill) and there is
 * no "expire the occupancy" service call in this slice.
 *
 * Threads are built through the real services so lineage, occupancy and
 * quotation state are server-derived, and the staff actor holds the exact
 * BE-02G Building assignment its own thread needs. Runs against
 * `embedded-postgres` when ASENTRA_USE_EMBEDDED_POSTGRES=true and skips
 * otherwise, matching the repo's DB-test convention.
 */

const DB_PORT = 55498;
const DATA_DIR = '/tmp/asentra-w03-03b2-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

const BINDING_TABLE = 'handyman_quotation_approval_bindings';
const DECISION_TABLE = 'handyman_quotation_decisions';
const BINDING_CODE = 'handyman.quotation.approval.binding.manage';
const ROUTES_PATH = resolve(
  __dirname,
  '../src/modules/handyman-quotations-api/handyman-quotations-api.routes.ts',
);

type TestContext = { skip: (message?: string) => void };
type Values = Record<string, unknown>;
type AppErrorLike = {
  statusCode?: number;
  code?: string;
  message?: string;
  details?: { field?: string; message?: string }[];
};

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const bootstrap = pg.getPgClient('postgres', '127.0.0.1');
    await bootstrap.connect();
    await bootstrap.query('CREATE DATABASE asentra_test');
    await bootstrap.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('F9 discipline seed missing');
  disciplineId = discipline.id;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
  if (pg) {
    await pg.stop();
    pg = null;
  }
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

/** A rejection with a specific HTTP contract, or a hard failure. */
async function expectRejection(
  work: Promise<unknown>,
  expected: { statusCode: number; code?: string; message?: string },
): Promise<AppErrorLike> {
  let failure: AppErrorLike | null = null;
  try {
    await work;
  } catch (error) {
    failure = error as AppErrorLike;
  }
  assert.ok(failure, `expected a rejection with HTTP ${expected.statusCode}`);
  assert.equal(
    failure!.statusCode,
    expected.statusCode,
    `unexpected status: ${failure!.statusCode} ${failure!.message}`,
  );
  if (expected.code) assert.equal(failure!.code, expected.code);
  if (expected.message) assert.match(String(failure!.message), new RegExp(expected.message));
  return failure!;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Staff = { token: string; userId: string };

/**
 * A staff principal whose role carries EXACTLY the given permission codes,
 * plus its own session token. No inheritance, no PLATFORM_ADMIN shortcut: the
 * codes are the whole grant, which is what makes the RBAC cases meaningful.
 */
async function createStaff(codes: readonly string[]): Promise<Staff> {
  const password = 'StaffPass123';
  const user = await userService.createUser({
    email: `staff-03b2-${suffix().toLowerCase()}@example.com`,
    displayName: '03B2 Staff',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleService.createRole({
    code: `S03B2_${suffix()}`,
    name: '03B2 Staff Role',
  });
  for (const code of codes) {
    const existing = await permissionRepository.findByCode(code);
    const permissionId = existing
      ? existing.id
      : (await permissionService.createPermission({ code, name: code })).id;
    await permissionService.assignPermissionToRole(role.id, permissionId as string);
  }
  await roleService.assignRoleToUser(user.id, role.id as string);
  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { token: login.body.data.sessionToken as string, userId: user.id as string };
}

async function createPic(
  tenantCompanyId: string,
  options: { status?: string; userId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO tenant_pics
       (id, tenant_company_id, user_id, pic_name, email, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      tenantCompanyId,
      options.userId ?? null,
      `PIC ${suffix()}`,
      `pic-${suffix().toLowerCase()}@tenant.example.com`,
      options.status ?? 'ACTIVE',
    ],
  );
  return id;
}

type Thread = {
  clientId: string;
  /** A DIFFERENT tenant company under the same Client (B2's failure shape). */
  siblingTenantCompanyId: string;
  buildingId: string;
  tenantCompanyId: string;
  spaceId: string;
  occupancyId: string;
  spaceAuthorityId: string;
  attributionId: string;
  requestId: string;
  quotationId: string;
  versionId: string;
  lineagePicId: string | null;
  picId: string;
  staff: Staff;
  /** A second, ACTIVE PIC of the SAME tenant (the re-bind target). */
  otherPicId: string;
  /** An ACTIVE PIC of a DIFFERENT tenant (the cross-tenant target). */
  foreignPicId: string;
};

/**
 * A quotable thread whose STAFF actor is a dedicated principal holding the
 * exact-Building BE-02G assignment plus both write permissions, built through
 * the real services (occupancy first, then context — that order is required).
 */
async function buildThread(
  options: {
    issue?: boolean;
    withLineagePic?: boolean;
    /** Grant the dedicated binding code (default true). */
    bindingCode?: boolean;
    /** Skip the building assignment (proves the BE-02G wall). */
    withoutBuildingAccess?: boolean;
  } = {},
): Promise<Thread> {
  const tag = suffix();
  const codes = ['tenant_company.manage', 'tenant_company.read'];
  if (options.bindingCode !== false) codes.push(BINDING_CODE);
  const staff = await createStaff(codes);

  const client = await clientService.createClient({
    code: `C03C${tag}`,
    name: `03B2 Client ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P03C${tag}`,
    name: '03B2 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B03C${tag}`,
    name: '03B2 Building',
  });
  if (!options.withoutBuildingAccess) {
    await buildingAssignmentService.createAssignment(staff.userId, {
      buildingId: building.id,
    });
  }
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F03C${tag}`,
    name: '03B2 Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A03C${tag}`,
    name: '03B2 Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R03C${tag}`,
    name: '03B2 Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S03C${tag}`,
    name: '03B2 Space',
  });
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `T03C${tag}`,
      tenantName: `03B2 Tenant ${tag}`,
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminUserId,
  );
  const occupancyId = (
    await q(
      `SELECT id FROM tenant_building_contexts
        WHERE tenant_company_id = $1 AND building_id = $2`,
      [company.id, building.id],
    )
  ).rows[0].id as string;
  const spaceAuthorityId = (
    await q(
      `SELECT id FROM tenant_space_relationships
        WHERE tenant_company_id = $1 AND building_id = $2 AND space_id = $3`,
      [company.id, building.id, space.id],
    )
  ).rows[0].id as string;
  const picId = await createPic(company.id);
  const otherPicId = await createPic(company.id);
  // A REAL second tenant company under the same Client, so "cross-tenant PIC"
  // is a genuine foreign key value and not an invented one — and it isolates
  // exactly the rule B2 adds on top of Client reachability: same Client,
  // different tenant, still refused.
  const foreignCompany = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `FT03C${tag}`,
      tenantName: `03B2 Foreign Tenant ${tag}`,
    },
    adminUserId,
  );
  const foreignPicId = await createPic(foreignCompany.id);

  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    ...(options.withLineagePic ? { tenantPicId: picId } : {}),
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: adminUserId,
  });
  const catalog = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `HM${tag}`,
      name: '03B2 Service',
      category: 'FM_HINT_TEXT',
    },
    adminUserId,
  );
  const request =
    await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: attribution.id, serviceCatalogId: catalog.id },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    { handymanRequestId: request.id, disciplineId, diagnosis: '03B2 fixture diagnosis.' },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id },
    adminUserId,
  );
  const versionId = bundle.versions[0].id as string;
  if (options.issue) {
    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uomId, client.id, `M${suffix()}`, 'Meter', 'm', 'LENGTH'],
    );
    await addHandymanQuotationLine(
      versionId,
      {
        lineType: 'LABOR',
        description: 'Hours',
        quantity: 1,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      },
      adminUserId,
    );
    await issueHandymanQuotationVersion(
      versionId,
      { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
      adminUserId,
    );
  }
  const requestRow = await q(
    `SELECT tenant_pic_id, space_id, building_id, tenant_company_id, client_id
       FROM handyman_service_requests WHERE id = $1`,
    [request.id],
  );
  assert.equal(requestRow.rows[0].client_id, client.id);
  assert.equal(requestRow.rows[0].building_id, building.id);

  return {
    clientId: client.id,
    buildingId: building.id,
    tenantCompanyId: company.id,
    siblingTenantCompanyId: foreignCompany.id,
    spaceId: space.id,
    occupancyId,
    spaceAuthorityId,
    attributionId: attribution.id,
    requestId: request.id,
    quotationId: bundle.quotation.id,
    versionId,
    lineagePicId: (requestRow.rows[0].tenant_pic_id as string | null) ?? null,
    picId,
    otherPicId,
    foreignPicId,
    staff,
  };
}

const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();

const bind = (
  thread: Thread,
  overrides: Record<string, unknown> = {},
) =>
  bindHandymanQuotationApprovalBinding(
    {
      quotationId: thread.quotationId,
      tenantPicId: thread.picId,
      idempotencyKey: `bind-${randomUUID()}`,
      ...overrides,
    },
    thread.staff.userId,
  );

const revoke = (
  thread: Thread,
  overrides: Record<string, unknown> = {},
) =>
  revokeHandymanQuotationApprovalBinding(
    {
      quotationId: thread.quotationId,
      reason: 'Approver left the tenant.',
      idempotencyKey: `revoke-${randomUUID()}`,
      ...overrides,
    },
    thread.staff.userId,
  );

async function bindingRows(quotationId: string): Promise<Values[]> {
  const result = await q(
    `SELECT id, binding_version, status, tenant_pic_id, client_id,
            tenant_company_id, building_id, space_id, supersedes_binding_id,
            effective_from, effective_until, occupancy_authority_id,
            space_authority_id, granted_by_user_id, revoked_by_user_id,
            revoked_at, created_at
       FROM ${BINDING_TABLE}
      WHERE quotation_id = $1
      ORDER BY binding_version`,
    [quotationId],
  );
  return result.rows as Values[];
}

async function journalRows(quotationId: string): Promise<Values[]> {
  const result = await q(
    `SELECT event_type, entity_type, entity_id, actor_user_id, summary, metadata
       FROM operational_events
      WHERE entity_type = 'HANDYMAN_QUOTATION_APPROVAL_BINDING'
        AND metadata->>'quotationId' = $1
      ORDER BY occurred_at`,
    [quotationId],
  );
  return result.rows as Values[];
}

/** A decided thread: the binding ledger is frozen (B18) and no service can
 *  produce that state yet, so the decision row is planted as raw SQL. */
async function plantDecision(thread: Thread, bindingId: string): Promise<void> {
  await q(
    `INSERT INTO ${DECISION_TABLE}
       (id, client_id, quotation_id, quotation_version_id, decision,
        tenant_company_id, tenant_pic_id, decided_by_user_id,
        idempotency_key, request_fingerprint, decision_actor_type,
        decided_by_tenant_pic_id, approval_binding_id)
     VALUES ($1,$2,$3,$4,'APPROVE',$5,$6,NULL,$7,$8,'TENANT_PIC',$9,$10)`,
    [
      randomUUID(),
      thread.clientId,
      thread.quotationId,
      thread.versionId,
      thread.tenantCompanyId,
      thread.lineagePicId,
      `k-${randomUUID()}`,
      'a'.repeat(64),
      thread.picId,
      bindingId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Runtime behaviour
// ---------------------------------------------------------------------------

describe('W03 PART 03B2 — quotation PIC approval-binding runtime', () => {
  it('binds an eligible PIC with server-derived lineage and an id-only audit trail', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    const { status, data } = await bind(thread, {
      effectiveUntil: FUTURE(),
      note: 'Occupancy transferred to this approver.',
    });
    assert.equal(status, 201);
    assert.equal(data.replayed, false);
    assert.equal(data.alreadyBound, false);
    assert.equal(data.binding.status, 'ACTIVE');
    assert.equal(data.binding.bindingVersion, 1);
    assert.equal(data.binding.supersedesBindingId, null);
    assert.equal(data.binding.tenantPicId, thread.picId);
    assert.equal(data.binding.grantedByUserId, thread.staff.userId);
    assert.equal(data.binding.revokedAt, null);

    const [row] = await bindingRows(thread.quotationId);
    // B11: every snapshot column equals the REQUEST's lineage, so nothing the
    // caller could have smuggled ever reached the row.
    assert.equal(row.client_id, thread.clientId);
    assert.equal(row.tenant_company_id, thread.tenantCompanyId);
    assert.equal(row.building_id, thread.buildingId);
    assert.equal(row.space_id, thread.spaceId);
    assert.equal(row.occupancy_authority_id, thread.occupancyId);
    assert.equal(row.space_authority_id, thread.spaceAuthorityId);
    assert.ok(row.effective_until);
    // A new binding is never born revoked.
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.revoked_by_user_id, null);

    // Audit: exactly one journal row, identities only.
    const events = await journalRows(thread.quotationId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event_type, 'HANDYMAN_QUOTATION_APPROVAL_BOUND');
    assert.equal(events[0]!.entity_type, 'HANDYMAN_QUOTATION_APPROVAL_BINDING');
    assert.equal(events[0]!.entity_id, row.id);
    assert.equal(events[0]!.actor_user_id, thread.staff.userId);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    assert.equal(metadata.tenantPicId, thread.picId);
    assert.equal(metadata.bindingVersion, 1);
    assert.equal(metadata.note, 'Occupancy transferred to this approver.');
    // NO PII anywhere in the journal row or the ledger projection, and no
    // e-mail/name/phone key even in principle.
    const serialized = JSON.stringify({ metadata, binding: data.binding });
    assert.ok(!/"(picName|email|phone|roleTitle)"/.test(serialized), serialized);
    assert.ok(!serialized.includes('@tenant.example.com'), serialized);
    // The ledger itself has no narrative column at all (0428 idiom).
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1`,
      [BINDING_TABLE],
    );
    assert.ok(
      !columns.rows.some((c: Values) =>
        ['note', 'reason', 'revoked_reason', 'idempotency_key'].includes(
          String(c.column_name),
        ),
      ),
      'the ledger stays a pure authority record; narrative is the audit seam',
    );

    // The bounded read agrees with the row.
    const read = await getHandymanQuotationApprovalBinding({
      quotationId: thread.quotationId,
      actorUserId: thread.staff.userId,
    });
    assert.equal(read.binding!.id, row.id);
    const approval = read.approvalStatus;
    assert.equal(approval.bindingStatus, 'ACTIVE');
    assert.equal(approval.bindingId, row.id);
    assert.equal(approval.bindingVersion, 1);
    assert.equal(approval.tenantPicId, thread.picId);
    // `pg` hands back a real Date for timestamptz: compare through the Date,
    // because String(Date) drops milliseconds and would truncate the window.
    assert.equal(approval.effectiveUntil, (row.effective_until as Date).toISOString());
    assert.equal(approval.occupancyStatus, 'ACTIVE');
    assert.equal(approval.spaceStatus, 'ACTIVE');
    assert.equal(approval.picStatus, 'ACTIVE');
    assert.equal(approval.pinned, false);
    assert.equal(approval.frozen, false);
    assert.equal(approval.eligibleForApproval, true);
    // The read carries ids only — the PIC's name/e-mail are unreachable here.
    assert.ok(!('picName' in approval) && !('email' in approval));
    assert.ok(!Object.keys(approval).some((key) => /name|email|phone/i.test(key)));
    assert.equal(read.history.length, 1);
  });

  it('refuses an unknown, inactive, or foreign PIC with ONE uniform 404', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    // The fixture is meaningful only if the cross-tenant PIC really belongs to
    // another tenant company (same Client, so Client reachability is NOT what
    // the refusal is about — B2 is).
    assert.notEqual(thread.siblingTenantCompanyId, thread.tenantCompanyId);
    const uniform = { statusCode: 404, code: 'HANDYMAN_QUOTATION_NOT_FOUND' };
    const unknown = { tenantPicId: randomUUID() };
    const foreign = { tenantPicId: thread.foreignPicId };
    const inactivePic = await createPic(thread.tenantCompanyId, { status: 'INACTIVE' });

    const a = await expectRejection(bind(thread, unknown), uniform);
    const b = await expectRejection(bind(thread, foreign), uniform);
    const c = await expectRejection(bind(thread, { tenantPicId: inactivePic }), uniform);
    // Non-enumerating is testable only by byte-comparison: every refusal the
    // caller can observe is identical, so no probe distinguishes them.
    assert.equal(JSON.stringify(a.message), JSON.stringify(b.message));
    assert.equal(JSON.stringify(b.message), JSON.stringify(c.message));

    // Malformed input is a 400 BEFORE any authority question is asked.
    await expectRejection(
      bind(thread, { tenantPicId: 'not-a-uuid' }),
      { statusCode: 400 },
    );
    await expectRejection(
      bind(thread, { effectiveUntil: 'yesterday' }),
      { statusCode: 400 },
    );
    // Nothing was written by ANY of the refusals.
    assert.deepEqual(await bindingRows(thread.quotationId), []);
    assert.deepEqual(await journalRows(thread.quotationId), []);
  });

  it('keeps a caller out of a thread it is not assigned to, and a manage-holder out of a binding', async (t) => {
    if (!requireDatabase(t)) return;
    // (a) no BE-02G Building assignment at all → 403, no existence leak.
    const unassigned = await buildThread({ withoutBuildingAccess: true });
    // The fixture skips only the STAFF assignment; the service actor here is
    // that unassigned principal, so the wall is what fails.
    await expectRejection(
      bindHandymanQuotationApprovalBinding(
        {
          quotationId: unassigned.quotationId,
          tenantPicId: unassigned.picId,
          idempotencyKey: `bind-${randomUUID()}`,
        },
        unassigned.staff.userId,
      ),
      { statusCode: 403, code: 'BUILDING_ACCESS_DENIED' },
    );
    assert.deepEqual(await bindingRows(unassigned.quotationId), []);

    // (b) `tenant_company.manage` alone is NOT binding authority (B8 stays,
    // the dedicated code narrows the surface — never the other way round).
    const manageOnly = await buildThread({ bindingCode: false });
    const denied = await api()
      .post(`/api/v1/handyman/quotations/${manageOnly.quotationId}/approval-binding`)
      .set({ Authorization: `Bearer ${manageOnly.staff.token}` })
      .set('Idempotency-Key', randomUUID())
      .send({ tenantPicId: manageOnly.picId });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(await bindingRows(manageOnly.quotationId), []);
    // The read is NOT gated by the new code (C21: `tenant_company.read`).
    const read = await api()
      .get(`/api/v1/handyman/quotations/${manageOnly.quotationId}/approval-binding`)
      .set({ Authorization: `Bearer ${manageOnly.staff.token}` });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.approvalStatus.bindingStatus, 'NONE');
    assert.equal(read.body.data.approvalStatus.eligibleForApproval, false);

    // (c) an unauthenticated caller is 401 before any of that.
    const anonymous = await api()
      .post(`/api/v1/handyman/quotations/${manageOnly.quotationId}/approval-binding`)
      .set('Idempotency-Key', randomUUID())
      .send({ tenantPicId: manageOnly.picId });
    assert.equal(anonymous.status, 401);
  });

  it('refuses self-binding (MC1′) while leaving a PIC-less account bindable', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    // A PIC LINKED TO THE GRANTER: exactly the loop MC1′ closes. (`tenant_pics`
    // allows one linked user per company, so this ONE row carries both halves of
    // the proof: refused for its own linked user, bindable for another granter.)
    const selfPic = await createPic(thread.tenantCompanyId, {
      userId: thread.staff.userId,
    });
    await expectRejection(
      bind(thread, { tenantPicId: selfPic }),
      { statusCode: 403, code: 'PERMISSION_DENIED' },
    );
    assert.deepEqual(await bindingRows(thread.quotationId), []);
    // MC4′: a PIC with NO users link is a legitimate approver — the unlinked
    // fixture PIC must still bind, or "fail-closed" would have become
    // "fail-unapprovable".
    const ok = await bind(thread);
    assert.equal(ok.status, 201);
    assert.equal(ok.data.binding.tenantPicId, thread.picId);
    // The refusal is GRANTER-relative, never "this PIC is a person". A PIC
    // linked to a DIFFERENT user is equally bindable by a different granter,
    // and because nothing is presented the re-binding supersedes the live row
    // (B13/B14) instead of failing.
    const otherStaff = await createStaff([
      'tenant_company.manage',
      'tenant_company.read',
      BINDING_CODE,
    ]);
    await buildingAssignmentService.createAssignment(otherStaff.userId, {
      buildingId: thread.buildingId,
    });
    // Same PIC, different granter: legal (the rule is overlap, not "the PIC is
    // a person"). Same granter as the PIC's own link: refused by MC1′ above.
    const rebind = await bindHandymanQuotationApprovalBinding(
      {
        quotationId: thread.quotationId,
        tenantPicId: selfPic,
        idempotencyKey: `bind-${randomUUID()}`,
      },
      otherStaff.userId,
    );
    assert.equal(rebind.status, 201);
    assert.equal(rebind.data.binding.bindingVersion, 2);
    const rows = await bindingRows(thread.quotationId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.supersedes_binding_id, rows[0]!.id);
    assert.equal(rows[0]!.status, 'REVOKED');
    assert.equal(rows[1]!.status, 'ACTIVE');
    assert.equal(rows[0]!.revoked_by_user_id, otherStaff.userId);
  });

  it('honours R-1.2, the B13 pin, and the B18 freeze', async (t) => {
    if (!requireDatabase(t)) return;

    // R-1.2: a BM-attested lineage PIC may never be swapped.
    const attested = await buildThread({ withLineagePic: true });
    assert.equal(attested.lineagePicId, attested.picId);
    await expectRejection(
      bind(attested, { tenantPicId: attested.otherPicId }),
      { statusCode: 409, code: 'CONFLICT' },
    );
    // Naming the SAME PIC the lineage attests is the one legal bind.
    const aligned = await bind(attested, { tenantPicId: attested.lineagePicId! });
    assert.equal(aligned.status, 201);

    // B13: a presented, undecided version pins the binding — reassignment is
    // refused, and the refusal is a 409 with the reason, not a silent no-op.
    const presented = await buildThread({ issue: true });
    await bind(presented);
    await expectRejection(
      bind(presented, { tenantPicId: presented.otherPicId }),
      { statusCode: 409, code: 'CONFLICT', message: 'pinned while a quotation version is presented' },
    );
    const afterPin = await bindingRows(presented.quotationId);
    assert.equal(afterPin.length, 1);
    assert.equal(afterPin[0]!.status, 'ACTIVE');

    // B15 outranks B13 for safety: revoking under a live presentation works.
    const revokeUnderPin = await revoke(presented);
    assert.equal(revokeUnderPin.status, 200);
    assert.equal(revokeUnderPin.data.binding.status, 'REVOKED');
    // ...and the read now says the presented version has NO eligible approver
    // (B16: fail closed, never fall back to the stale snapshot).
    const readUnderPin = await getHandymanQuotationApprovalBinding({
      quotationId: presented.quotationId,
      actorUserId: presented.staff.userId,
    });
    assert.equal(readUnderPin.approvalStatus.bindingStatus, 'REVOKED');
    assert.equal(readUnderPin.approvalStatus.eligibleForApproval, false);
    assert.equal(readUnderPin.approvalStatus.pinned, true);

    // B18: once any decision exists, the thread is write-proof — for a new
    // binding AND for a revocation (the authorization context of a decided
    // quotation is frozen forever; B15 cannot outrank it because after a
    // decision there is no live effect left to protect).
    const decided = await buildThread({ issue: true });
    const first = await bind(decided);
    await plantDecision(decided, first.data.binding.id);
    await expectRejection(
      bind(decided, { tenantPicId: decided.otherPicId }),
      { statusCode: 409, code: 'HANDYMAN_QUOTATION_DECISION_CONFLICT' },
    );
    await expectRejection(
      revoke(decided),
      { statusCode: 409, code: 'HANDYMAN_QUOTATION_DECISION_CONFLICT' },
    );
    const afterFreeze = await bindingRows(decided.quotationId);
    assert.equal(afterFreeze.length, 1);
    assert.equal(afterFreeze[0]!.status, 'ACTIVE');
    const frozenRead = await getHandymanQuotationApprovalBinding({
      quotationId: decided.quotationId,
      actorUserId: decided.staff.userId,
    });
    assert.equal(frozenRead.approvalStatus.frozen, true);
    // History stays readable (B18: frozen, never rewritten or hidden).
    assert.equal(frozenRead.binding!.id, first.data.binding.id);
  });

  it('replays an identical Idempotency-Key and conflicts on a different body', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    const key = `idem-${randomUUID()}`;
    const first = await bind(thread, {
      idempotencyKey: key,
      note: 'Original intent.',
    });
    assert.equal(first.status, 201);
    const replay = await bind(thread, {
      idempotencyKey: key,
      note: 'Original intent.',
    });
    // Same key + same fingerprint ⇒ the ORIGINAL stored success, nothing new.
    assert.equal(replay.status, 201);
    assert.equal(replay.data.replayed, true);
    assert.equal(replay.data.binding.id, first.data.binding.id);
    assert.deepEqual(replay.data.binding, first.data.binding);
    assert.equal((await bindingRows(thread.quotationId)).length, 1);
    // The replay is not a new journal row either.
    assert.equal((await journalRows(thread.quotationId)).length, 1);

    // Same key + DIFFERENT body ⇒ 409, and the second body is never applied.
    const conflict = await expectRejection(
      bind(thread, { idempotencyKey: key, tenantPicId: thread.otherPicId }),
      { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.ok(String(conflict.message).includes(BIND_HANDYMAN_QUOTATION_APPROVAL_BINDING_OPERATION_KEY));
    const rows = await bindingRows(thread.quotationId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant_pic_id, thread.picId);

    // Bind and revoke are separate operations: reusing one key across the two
    // commands does not collide (per-operation namespace).
    const sharedKey = `cross-${randomUUID()}`;
    const bound = await bind(thread, { idempotencyKey: sharedKey });
    assert.equal(bound.data.replayed, false);
    const revoked = await revoke(thread, { idempotencyKey: sharedKey });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.alreadyRevoked, false);

    // A refused write leaves NO claim behind (success-only law), so the same
    // key succeeds once the request is corrected — the idempotency layer can
    // never poison a thread with a failed attempt.
    const retryKey = `retry-${randomUUID()}`;
    await expectRejection(
      bind(thread, { idempotencyKey: retryKey, tenantPicId: randomUUID() }),
      { statusCode: 404 },
    );
    const retried = await bind(thread, {
      idempotencyKey: retryKey,
      tenantPicId: thread.otherPicId,
    });
    assert.equal(retried.status, 201);
    assert.equal(retried.data.replayed, false);
    // ...and the revocation above was real, so this is a fresh version.
    assert.ok(retried.data.binding.bindingVersion >= 2);
  });

  it('revokes with its own body, is idempotent, and stays allowed when the basis dies', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    await bind(thread, { effectiveUntil: FUTURE() });

    // Revoke REQUIRES its own reason — not "just an idempotency key".
    await expectRejection(
      revoke(thread, { reason: '   ' }),
      { statusCode: 400, code: 'VALIDATION_ERROR' },
    );
    // A cutoff may only TIGHTEN, never defer the end of authority.
    await expectRejection(
      revoke(thread, { effectiveUntil: new Date(Date.now() + 600_000).toISOString() }),
      { statusCode: 400 },
    );
    assert.equal((await bindingRows(thread.quotationId))[0]!.status, 'ACTIVE');

    // The stated cutoff has to be a moment the binding was actually live:
    // `effectiveFrom` itself is the tightest legal instant and never races the
    // clock (a "60 s ago" value would precede the grant and be refused).
    const grantedWindow = await getHandymanQuotationApprovalBinding({
      quotationId: thread.quotationId,
      actorUserId: thread.staff.userId,
    });
    const revoked = await revoke(thread, {
      reason: 'Approver suspended by tenant.',
      effectiveUntil: grantedWindow.approvalStatus.effectiveFrom!,
    });
    assert.equal(revoked.status, 200);
    const [row] = await bindingRows(thread.quotationId);
    assert.equal(row.status, 'REVOKED');
    assert.equal(row.revoked_by_user_id, thread.staff.userId);
    assert.ok(row.revoked_at);
    // The window column was NEVER touched (B14: revoke is the only mutation).
    assert.ok(row.effective_until);
    assert.ok(
      (row.effective_until as Date).getTime() > Date.now(),
      'a stated revoke cutoff must not rewrite the granted window',
    );
    // `authorityEndsAt` is the effective end: the revocation came first, so the
    // DB-derived `revoked_at` wins over a window that is still open.
    assert.equal(
      new Date(String(revoked.data.binding.authorityEndsAt)).getTime(),
      (row.revoked_at as Date).getTime(),
    );
    const events = await journalRows(thread.quotationId);
    const revokeEvent = events.find(
      (e) => e.event_type === 'HANDYMAN_QUOTATION_APPROVAL_BINDING_REVOKED',
    );
    assert.ok(revokeEvent, 'revocation must be journaled');
    const metadata = revokeEvent!.metadata as Record<string, unknown>;
    assert.equal(metadata.reason, 'Approver suspended by tenant.');
    // The stated cutoff is journal-recorded verbatim — it is narrative, not a
    // ledger column, which is exactly why it can never rewrite history.
    assert.equal(
      metadata.statedEffectiveUntil,
      grantedWindow.approvalStatus.effectiveFrom,
    );
    assert.ok(!('picName' in metadata) && !('email' in metadata));

    // Idempotent in effect: a second revoke restates the history, writes
    // nothing, and adds no journal row.
    const before = await bindingRows(thread.quotationId);
    const again = await revoke(thread, { reason: 'Retried by another operator.' });
    assert.equal(again.status, 200);
    assert.equal(again.data.alreadyRevoked, true);
    assert.equal(again.data.binding.id, before[0]!.id);
    assert.deepEqual(await bindingRows(thread.quotationId), before);

    // A never-bound thread answers the uniform 404 rather than a 204 "ok".
    const neverBound = await buildThread();
    await expectRejection(revoke(neverBound), {
      statusCode: 404,
      code: 'HANDYMAN_QUOTATION_NOT_FOUND',
    });

    // B15: a binding whose OCCUPANCY BASIS DIED afterwards must still be
    // revocable, even though no new binding could be created on that thread.
    const staleBasis = await buildThread();
    await bind(staleBasis);
    await q(
      `UPDATE tenant_building_contexts SET status = 'INACTIVE' WHERE id = $1`,
      [staleBasis.occupancyId],
    );
    await expectRejection(bind(staleBasis, { tenantPicId: staleBasis.otherPicId }), {
      statusCode: 404,
    });
    const rescue = await revoke(staleBasis);
    assert.equal(rescue.status, 200, 'revocation must never be blocked by a dead basis');
    assert.equal(rescue.data.binding.status, 'REVOKED');
    const degraded = await getHandymanQuotationApprovalBinding({
      quotationId: staleBasis.quotationId,
      actorUserId: staleBasis.staff.userId,
    });
    // The read re-resolves the basis LIVE (B16/B17): the snapshot ids are
    // evidence, so a closed occupancy is reported as closed, not as ACTIVE.
    assert.equal(degraded.approvalStatus.occupancyStatus, 'INACTIVE');
    assert.equal(degraded.approvalStatus.eligibleForApproval, false);
  });

  it('serializes concurrent binds into one live binding per thread', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    const contenders = await Promise.allSettled([
      bind(thread, { tenantPicId: thread.picId }),
      bind(thread, { tenantPicId: thread.otherPicId }),
    ]);
    const succeeded = contenders.filter((c) => c.status === 'fulfilled');
    const failed = contenders.filter((c) => c.status === 'rejected');
    // Exactly one live row, whatever the interleaving: `_one_active` plus the
    // thread lock make "two ACTIVE bindings" unrepresentable, and the loser
    // gets a 409 envelope rather than a 500.
    const rows = await bindingRows(thread.quotationId);
    const active = rows.filter((r) => r.status === 'ACTIVE');
    assert.equal(active.length, 1);
    assert.ok(succeeded.length >= 1, 'at least one contender must commit');
    for (const rejection of failed) {
      const error = (rejection as PromiseRejectedResult).reason as AppErrorLike;
      assert.ok(
        error.statusCode === 409 || error.statusCode === 404,
        `unexpected concurrent refusal: ${error.statusCode} ${error.message}`,
      );
    }
    // The committed winner is readable and eligible.
    const read = await getHandymanQuotationApprovalBinding({
      quotationId: thread.quotationId,
      actorUserId: thread.staff.userId,
    });
    assert.equal(read.approvalStatus.bindingId, active[0]!.id);
    assert.equal(read.approvalStatus.eligibleForApproval, true);
  });

  it('mounts the three staff routes with the ratified permission chain', async (t) => {
    if (!requireDatabase(t)) return;
    const source = readFileSync(ROUTES_PATH, 'utf8').replace(/\s+/g, ' ');
    for (const literal of [
      "router.post( bindingPath, auth, manage, approvalBindingManage, postHandymanQuotationApprovalBindingHandler,",
      "router.post( `${bindingPath}/revoke`, auth, manage, approvalBindingManage, postHandymanQuotationApprovalBindingRevokeHandler,",
      "router.get( bindingPath, auth, read, getHandymanQuotationApprovalBindingHandler,",
    ]) {
      assert.ok(source.includes(literal), `route chain must contain: ${literal}`);
    }
    assert.match(
      source,
      /requirePermission\(\s*'handyman\.quotation\.approval\.binding\.manage'/,
      'the dedicated code must be a literal the registry gate can scan',
    );
    assert.equal(HANDYMAN_QUOTATION_APPROVAL_BINDING_MANAGE_PERMISSION, BINDING_CODE);
    assert.ok(
      !/router\.delete\([^)]*approval-binding/.test(source),
      'no DELETE surface for the same fact (journey §8: no duplicate route)',
    );

    // Catalogue + policy, both directions.
    const entries = FOUNDATION_PERMISSIONS.filter((p) => p.code === BINDING_CODE);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, 'Manage Handyman Quotation Approval Bindings');
    assert.equal(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(BINDING_CODE), true);
    // The seeded PLATFORM_ADMIN role must not inherit it (0440 inserts the
    // catalogue row only; UNASSIGNED_BY_DEFAULT keeps the grant empty). Test
    // roles created above are excluded by role code, so this reads the seed.
    const inherited = await q(
      `SELECT COUNT(*)::int AS count
         FROM role_permission_assignments rpa
         JOIN permissions p ON p.id = rpa.permission_id
         JOIN roles r ON r.id = rpa.role_id
        WHERE p.code = $1
          AND r.code = 'PLATFORM_ADMIN'`,
      [BINDING_CODE],
    );
    assert.equal(inherited.rows[0].count, 0, 'no default role may hold it');
    const catalogueRows = await q(
      `SELECT COUNT(*)::int AS count FROM permissions WHERE code = $1`,
      [BINDING_CODE],
    );
    assert.equal(catalogueRows.rows[0].count, 1, 'exactly one catalogue row');
    const migration = await q(
      `SELECT COUNT(*)::int AS applied FROM schema_migrations
        WHERE id = '0440_handyman_quotation_approval_binding_permission'`,
    );
    assert.equal(migration.rows[0].applied, 1, '0440 must be applied by migrateUp');
  });

  it('serves bind, revoke and read over HTTP and structurally ignores smuggled keys', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    const base = `/api/v1/handyman/quotations/${thread.quotationId}/approval-binding`;
    const header = { Authorization: `Bearer ${thread.staff.token}` };

    const created = await api()
      .post(base)
      .set(header)
      .set('Idempotency-Key', randomUUID())
      .send({
        tenantPicId: thread.picId,
        effectiveUntil: FUTURE(),
        note: 'Bound over HTTP.',
        // B11 smuggling set: every one of these is structurally ignored.
        clientId: thread.foreignPicId,
        tenantCompanyId: thread.tenantCompanyId,
        buildingId: randomUUID(),
        spaceId: randomUUID(),
        bindingVersion: 99,
        status: 'REVOKED',
        supersedesBindingId: randomUUID(),
        occupancyAuthorityId: randomUUID(),
        spaceAuthorityId: randomUUID(),
        grantedByUserId: randomUUID(),
        decidedByTenantPicId: randomUUID(),
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.replayed, false);
    assert.equal(created.body.data.binding.bindingVersion, 1);
    assert.equal(created.body.data.binding.status, 'ACTIVE');
    const row = (await bindingRows(thread.quotationId))[0]!;
    assert.equal(row.tenant_company_id, thread.tenantCompanyId);
    assert.equal(row.building_id, thread.buildingId);
    assert.equal(row.space_id, thread.spaceId);
    assert.equal(row.occupancy_authority_id, thread.occupancyId);
    assert.equal(row.space_authority_id, thread.spaceAuthorityId);
    assert.equal(row.granted_by_user_id, thread.staff.userId);
    assert.ok(!('picName' in (created.body.data.binding as Values)));
    assert.ok(!('email' in (created.body.data.binding as Values)));

    const read = await api().get(base).set(header);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.binding.id, row.id);
    assert.equal(read.body.data.approvalStatus.occupancyStatus, 'ACTIVE');
    assert.equal(read.body.data.approvalStatus.eligibleForApproval, true);
    assert.equal(read.body.data.history.length, 1);

    const revoked = await api()
      .post(`${base}/revoke`)
      .set(header)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Revoked over HTTP.', status: 'ACTIVE' });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.binding.status, 'REVOKED');
    assert.equal(revoked.body.data.alreadyRevoked, false);

    const missingReason = await api()
      .post(`${base}/revoke`)
      .set(header)
      .set('Idempotency-Key', randomUUID())
      .send({});
    assert.equal(missingReason.status, 400, JSON.stringify(missingReason.body));
    assert.equal(missingReason.body.error.details[0].field, 'reason');

    const noKey = await api()
      .post(base)
      .set(header)
      .send({ tenantPicId: thread.otherPicId });
    assert.equal(noKey.status, 400, 'Idempotency-Key is required for a bind');

    // An unknown thread is 404 with the same uniform message, and never 500.
    const stranger = await api()
      .get(`/api/v1/handyman/quotations/${randomUUID()}/approval-binding`)
      .set(header);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.error.code, 'HANDYMAN_QUOTATION_NOT_FOUND');
  });
});
