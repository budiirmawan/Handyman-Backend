import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { migrations } from '../src/database/migrations';
import { areaService } from '../src/modules/areas';
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
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';
import { migration0437HandymanQuotationApprovalBindings } from '../src/database/migrations/0437_handyman_quotation_approval_bindings';
import { migration0438HandymanQuotationDecisionActorIdentity } from '../src/database/migrations/0438_handyman_quotation_decision_actor_identity';
import { migration0439HandymanExecutionScopeActorIdentity } from '../src/database/migrations/0439_handyman_execution_scope_actor_identity';

/**
 * W03 PART 03B — focused tests for the quotation PIC approval SCHEMA
 * foundation (migrations 0437 / 0438 / 0439).
 *
 * Schema and guard tests, not behaviour tests: no route or projection is
 * involved, except where one test deliberately drives the real staff decide
 * service to pin the documented controlled standstill. Coverage follows the
 * PART exit list: fresh apply, rerun, empty rollback, populated rollback
 * refusal, legacy preservation, invalid actor, invalid binding, concurrent
 * uniqueness — plus the invariants the frozen contract relies on (existing
 * immutability intact, zero backfill, one decision ledger).
 *
 * Threads are built through the real services so lineage, occupancy and
 * quotation state are server-derived; every write under test is raw SQL inside
 * a transaction that is always rolled back, so the DB stays migrated and
 * unpopulated for the next test.
 *
 * Runs against `embedded-postgres` when ASENTRA_USE_EMBEDDED_POSTGRES=true and
 * skips otherwise, matching the repo's DB-test convention.
 */

const DB_PORT = 55497;
const DATA_DIR = '/tmp/asentra-w03-03b-pg';
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
const SCOPE_TABLE = 'handyman_execution_scopes';
const DECISION_TRIGGER = 'handyman_quotation_decision_no_write';
const IMMUTABLE_DECISION = 'Handyman quotation decisions are immutable authoritative facts.';

type TestContext = { skip: (message?: string) => void };
type Runner = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type Values = Record<string, unknown>;
type DbError = Error & { code?: string; constraint?: string };

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const fingerprint = (payload: string) =>
  createHash('sha256').update(payload).digest('hex');

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

const q: Runner = (text, params = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

function assertRefusal(
  failure: DbError | null,
  expected: string,
  extra: { code?: string; constraint?: string } = {},
): void {
  assert.ok(failure, `expected a refusal mentioning "${expected}"`);
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(failure!.message, new RegExp(escaped), failure!.message);
  if (extra.code) assert.equal(failure!.code, extra.code);
  if (extra.constraint) assert.equal(failure!.constraint, extra.constraint);
}

async function expectRefusal(
  run: () => Promise<unknown>,
  expected: string,
  extra: { code?: string; constraint?: string } = {},
): Promise<void> {
  let failure: DbError | null = null;
  try {
    await run();
  } catch (error) {
    failure = error as DbError;
  }
  assertRefusal(failure, expected, extra);
}

/**
 * Expect a refusal INSIDE an open transaction. The savepoint keeps the rest of
 * the transaction usable, so one test can assert several guard refusals in a
 * row without PostgreSQL turning the later statements into 25P02 noise.
 */
async function expectRefusalTx(
  run: Runner,
  work: () => Promise<unknown>,
  expected: string,
  extra: { code?: string; constraint?: string } = {},
): Promise<void> {
  const savepoint = `refusal_${randomUUID().replace(/-/g, '')}`;
  await run(`SAVEPOINT ${savepoint}`);
  let failure: DbError | null = null;
  try {
    await work();
  } catch (error) {
    failure = error as DbError;
  }
  await run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  assertRefusal(failure, expected, extra);
}

/** Runs work inside a transaction that is always rolled back. */
async function inRollbackTx<T>(
  work: (client: PoolClient, run: Runner) => Promise<T>,
): Promise<T> {
  if (!pool) throw new Error('database pool is not initialized');
  const client = await pool.connect();
  const run: Runner = (text, params = []) => client.query(text, params);
  try {
    await client.query('BEGIN');
    const result = await work(client, run);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Thread = {
  clientId: string;
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
};

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

async function staffUser(): Promise<string> {
  const created = await userService.createUser({
    email: `staff-${suffix().toLowerCase()}@example.com`,
    displayName: '03B Staff',
  });
  return created.id as string;
}

/**
 * A quotable thread: client -> building -> location -> tenant + occupancy ->
 * attribution -> request -> triage -> diagnosis -> quotation thread (one
 * version, optionally ISSUED with a line). It stops before any decision: this
 * PART ships no service-level approval path.
 */
async function buildThread(
  options: { issue?: boolean; withLineagePic?: boolean } = {},
): Promise<Thread> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `C03B${tag}`,
    name: `03B Client ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P03B${tag}`,
    name: '03B Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B03B${tag}`,
    name: '03B Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F03B${tag}`,
    name: '03B Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A03B${tag}`,
    name: '03B Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R03B${tag}`,
    name: '03B Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S03B${tag}`,
    name: '03B Space',
  });
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `T03B${tag}`,
      tenantName: `03B Tenant ${tag}`,
    },
    adminUserId,
  );
  // Order matters: the building context service requires an ACTIVE tenant
  // space relationship in the building before it will create the context.
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
  // The approver candidate. Unlinked by default: a PIC without a local user
  // account is a legitimate approver (frozen decision 2).
  const picId = await createPic(company.id);
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
      name: '03B Service',
      category: 'FM_HINT_TEXT',
    },
    adminUserId,
  );
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
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
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({
    handymanRequestId: request.id,
    disciplineId,
    diagnosis: '03B fixture diagnosis.',
  }, adminUserId);
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
    await addHandymanQuotationLine(versionId, {
      lineType: 'LABOR',
      description: 'Hours',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 100,
    }, adminUserId);
    await issueHandymanQuotationVersion(versionId, {
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }, adminUserId);
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
    spaceId: space.id,
    occupancyId,
    spaceAuthorityId,
    attributionId: attribution.id,
    requestId: request.id,
    quotationId: bundle.quotation.id,
    versionId,
    lineagePicId: (requestRow.rows[0].tenant_pic_id as string | null) ?? null,
    picId,
  };
}

async function insertRow(
  run: Runner,
  table: string,
  values: Values,
): Promise<string> {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const result = await run(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${placeholders.join(', ')}) RETURNING id`,
    columns.map((column) => values[column]),
  );
  return result.rows[0].id as string;
}

async function insertBinding(
  run: Runner,
  thread: Thread,
  overrides: Values = {},
): Promise<string> {
  return insertRow(run, BINDING_TABLE, {
    id: randomUUID(),
    quotation_id: thread.quotationId,
    handyman_request_id: thread.requestId,
    client_id: thread.clientId,
    tenant_company_id: thread.tenantCompanyId,
    building_id: thread.buildingId,
    space_id: thread.spaceId,
    tenant_pic_id: thread.picId,
    binding_version: 1,
    supersedes_binding_id: null,
    effective_until: null,
    occupancy_authority_id: thread.occupancyId,
    space_authority_id: thread.spaceAuthorityId,
    granted_by_user_id: adminUserId,
    ...overrides,
  });
}

async function insertDecision(
  run: Runner,
  thread: Thread,
  bindingId: string | null,
  overrides: Values = {},
): Promise<string> {
  return insertRow(run, DECISION_TABLE, {
    id: randomUUID(),
    client_id: thread.clientId,
    quotation_id: thread.quotationId,
    quotation_version_id: thread.versionId,
    decision: 'APPROVE',
    tenant_company_id: thread.tenantCompanyId,
    tenant_pic_id: thread.lineagePicId,
    decided_by_user_id: null,
    idempotency_key: `k-${randomUUID()}`,
    request_fingerprint: fingerprint(`${thread.versionId}APPROVE`),
    decision_actor_type: 'TENANT_PIC',
    decided_by_tenant_pic_id: thread.picId,
    approval_binding_id: bindingId,
    ...overrides,
  });
}

async function insertScope(
  run: Runner,
  thread: Thread,
  decisionId: string,
  overrides: Values = {},
): Promise<string> {
  return insertRow(run, SCOPE_TABLE, {
    id: randomUUID(),
    client_id: thread.clientId,
    handyman_request_id: thread.requestId,
    channel_attribution_id: thread.attributionId,
    quotation_id: thread.quotationId,
    approved_quotation_version_id: thread.versionId,
    quotation_decision_id: decisionId,
    tenant_company_id: thread.tenantCompanyId,
    tenant_pic_id: thread.picId,
    building_id: thread.buildingId,
    space_id: thread.spaceId,
    created_by_user_id: null,
    created_by_actor_type: 'TENANT_PIC',
    created_by_tenant_pic_id: thread.picId,
    ...overrides,
  });
}

async function revokeBinding(
  run: Runner,
  bindingId: string,
  revokedBy?: string,
): Promise<void> {
  await run(
    `UPDATE ${BINDING_TABLE}
        SET status = 'REVOKED', revoked_by_user_id = $2, revoked_at = NOW()
      WHERE id = $1`,
    [bindingId, revokedBy ?? adminUserId],
  );
}

/** Binds and approves in one transaction, then hands the ids to `assertOn`. */
async function bindAndApprove(
  thread: Thread,
  work: (context: { bindingId: string; decisionId: string; run: Runner }) => Promise<void>,
): Promise<void> {
  await inRollbackTx(async (_client, run) => {
    const bindingId = await insertBinding(run, thread);
    const decisionId = await insertDecision(run, thread, bindingId);
    await work({ bindingId, decisionId, run });
  });
}

describe('W03 PART 03B — quotation PIC approval schema foundation', () => {
  it('applies from scratch with the ratified shape (fresh)', async (t) => {
    if (!requireDatabase(t)) return;
    const columns = await q(
      `SELECT table_name, column_name, is_nullable, data_type, column_default
         FROM information_schema.columns
        WHERE table_name IN ($1, 'handyman_quotation_decisions',
                             'handyman_execution_scopes')`,
      [BINDING_TABLE],
    );
    const present = new Set(
      columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    for (const column of [
      'id', 'quotation_id', 'handyman_request_id', 'client_id',
      'tenant_company_id', 'building_id', 'space_id', 'tenant_pic_id',
      'binding_version', 'supersedes_binding_id', 'status', 'effective_from',
      'effective_until', 'occupancy_authority_id', 'space_authority_id',
      'granted_by_user_id', 'granted_at', 'revoked_by_user_id', 'revoked_at',
      'created_at', 'updated_at',
    ]) {
      assert.ok(present.has(`${BINDING_TABLE}.${column}`), `missing ${column}`);
    }
    // A01 6.1 / 7.1 actor identity on both ledgers. The session column is
    // deferred together with the session table it must reference (a
    // documented deviation, see the PART record).
    for (const column of [
      'decision_actor_type', 'decided_by_tenant_pic_id', 'approval_binding_id',
    ]) {
      assert.ok(
        present.has(`${DECISION_TABLE}.${column}`),
        `decision ledger missing ${column}`,
      );
    }
    assert.ok(present.has('handyman_quotation_decisions.decided_by_pic_session_id') === false);
    assert.ok(present.has('handyman_execution_scopes.created_by_pic_session_id') === false);
    for (const column of ['created_by_actor_type', 'created_by_tenant_pic_id']) {
      assert.ok(
        present.has(`${SCOPE_TABLE}.${column}`),
        `scope ledger missing ${column}`,
      );
    }
    const isNullable = (table: string, column: string) =>
      columns.rows.find(
        (row) => row.table_name === table && row.column_name === column,
      ).is_nullable;
    assert.equal(isNullable(DECISION_TABLE, 'decided_by_user_id'), 'YES');
    assert.equal(isNullable(SCOPE_TABLE, 'created_by_user_id'), 'YES');
    // Zero-backfill mechanism: a constant default IS the backfill.
    for (const [table, column] of [
      [DECISION_TABLE, 'decision_actor_type'],
      [SCOPE_TABLE, 'created_by_actor_type'],
    ] as const) {
      const row = columns.rows.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      assert.equal(row.column_default, "'USER'::text");
      assert.equal(row.is_nullable, 'NO');
    }

    const constraints = await q(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('handyman_quotation_approval_bindings_status_check',
          'handyman_quotation_approval_bindings_version_check',
          'handyman_quotation_approval_bindings_window_check',
          'handyman_quotation_approval_bindings_revoke_check',
          'handyman_quotation_approval_bindings_space_check',
          'handyman_quotation_approval_bindings_request_scope_fk',
          'handyman_quotation_approval_bindings_supersedes_fk',
          'handyman_quotation_decisions_actor_identity_check',
          'handyman_quotation_decisions_binding_check',
          'handyman_execution_scopes_actor_identity_check')`,
    );
    const names = new Set(constraints.rows.map((row) => row.conname));
    for (const name of [
      'handyman_quotation_approval_bindings_status_check',
      'handyman_quotation_approval_bindings_version_check',
      'handyman_quotation_approval_bindings_window_check',
      'handyman_quotation_approval_bindings_revoke_check',
      'handyman_quotation_approval_bindings_space_check',
      'handyman_quotation_approval_bindings_request_scope_fk',
      'handyman_quotation_approval_bindings_supersedes_fk',
      'handyman_quotation_decisions_actor_identity_check',
      'handyman_quotation_decisions_binding_check',
      'handyman_execution_scopes_actor_identity_check',
    ]) {
      assert.ok(names.has(name), `missing constraint ${name}`);
    }

    const indexes = await q(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`,
      [BINDING_TABLE],
    );
    const oneActive = indexes.rows.find(
      (row) => row.indexname === 'handyman_quotation_approval_bindings_one_active',
    );
    assert.ok(oneActive, 'one-ACTIVE partial unique index is required');
    assert.match(oneActive.indexdef, /UNIQUE/i);
    assert.match(oneActive.indexdef, /WHERE \(status = 'ACTIVE'/);
    for (const index of [
      'handyman_quotation_approval_bindings_one_per_version',
      'handyman_quotation_approval_bindings_pic_idx',
    ]) {
      assert.ok(
        indexes.rows.some((row) => row.indexname === index),
        `missing index ${index}`,
      );
    }

    // The whole point of 0438: the guard must now see INSERT (A01 6.2).
    for (const [table, trigger] of [
      [DECISION_TABLE, DECISION_TRIGGER],
      [BINDING_TABLE, 'handyman_quotation_approval_binding_guard'],
    ] as const) {
      const events = await q(
        `SELECT DISTINCT event_manipulation FROM information_schema.triggers
          WHERE event_object_table = $1 AND trigger_name = $2
            AND action_timing = 'BEFORE'`,
        [table, trigger],
      );
      assert.deepEqual(
        events.rows.map((row) => row.event_manipulation).sort(),
        ['DELETE', 'INSERT', 'UPDATE'],
        `${trigger} must guard INSERT as well as UPDATE and DELETE`,
      );
    }

    // Migration order is contractual: the ledger FK may not precede the table
    // it references, and the scope widening lands last.
    const ids = migrations.map((migration) => migration.id);
    const at = (id: string) => ids.indexOf(id);
    assert.ok(
      at('0437_handyman_quotation_approval_bindings') <
        at('0438_handyman_quotation_decision_actor_identity'),
      'the bindings table must exist before approval_binding_id references it',
    );
    assert.ok(
      at('0438_handyman_quotation_decision_actor_identity') <
        at('0439_handyman_execution_scope_actor_identity'),
    );
    // The PART's ordering claim is CONSECUTIVENESS, not "which id is the tip":
    // W03 PART 03B2 legitimately adds 0440 on top, and M6 is precisely the
    // rule that nothing unrelated may ride between these three.
    assert.equal(
      at('0438_handyman_quotation_decision_actor_identity'),
      at('0437_handyman_quotation_approval_bindings') + 1,
      'no unrelated migration may ride between 0437 and 0438',
    );
    assert.equal(
      at('0439_handyman_execution_scope_actor_identity'),
      at('0438_handyman_quotation_decision_actor_identity') + 1,
      'no unrelated migration may ride between 0438 and 0439',
    );
    assert.equal(
      at('0440_handyman_quotation_approval_binding_permission'),
      at('0439_handyman_execution_scope_actor_identity') + 1,
      '03B2\'s permission migration must land directly after this PART',
    );
  });

  it('is rerun-safe and re-entrant', async (t) => {
    if (!requireDatabase(t)) return;
    assert.deepEqual(
      await migrateUp(pool!),
      [],
      'a second migrateUp must apply nothing',
    );
    const duplicates = await q(
      `SELECT id FROM schema_migrations WHERE id LIKE '0437%'
        GROUP BY id HAVING count(*) > 1`,
    );
    assert.deepEqual(duplicates.rows, []);
    // up() is written so a partially applied retry completes without conflict.
    await inRollbackTx(async (client, run) => {
      await migration0437HandymanQuotationApprovalBindings.up(client);
      await migration0438HandymanQuotationDecisionActorIdentity.up(client);
      await migration0439HandymanExecutionScopeActorIdentity.up(client);
      const stillThere = await run(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'handyman_quotation_decisions'
            AND column_name = 'decision_actor_type'`,
      );
      assert.equal(stillThere.rows[0].n, 1);
      const guards = await run(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgname = $1 AND NOT tgisinternal`,
        [DECISION_TRIGGER],
      );
      assert.equal(guards.rows[0].n, 1, 'the trigger must not be duplicated');
    });
    const single = await q(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name = $1`,
      [BINDING_TABLE],
    );
    assert.equal(single.rows[0].n, 1);
  });

  it('rolls back while empty, then restores forward', async (t) => {
    if (!requireDatabase(t)) return;
    // Declared before any PIC-attributed row exists: this is the empty-state
    // path an operator would actually take.
    // LIFO first peels 0440 (W03 PART 03B2's catalogue row) off the top, which
    // doubles as evidence for that migration's own down(): an UNASSIGNED code is
    // removed with its migration and comes back on the way up.
    const revertedPermission = await migrateDown(pool!);
    assert.equal(
      revertedPermission,
      '0440_handyman_quotation_approval_binding_permission',
    );
    const orphan = await q(
      `SELECT count(*)::int AS n FROM permissions
        WHERE code = 'handyman.quotation.approval.binding.manage'`,
    );
    assert.equal(orphan.rows[0].n, 0, 'an unassigned code is removed with 0440');

    const reverted = await migrateDown(pool!);
    assert.equal(reverted, '0439_handyman_execution_scope_actor_identity');
    const gone = await q(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'handyman_execution_scopes'
          AND column_name = 'created_by_user_id'`,
    );
    assert.equal(gone.rows.length, 1);
    assert.equal(gone.rows[0].is_nullable, 'NO', 'down restores the NOT NULL');
    const removed = await q(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'handyman_execution_scopes'
          AND column_name = 'created_by_actor_type'`,
    );
    assert.equal(removed.rows[0].n, 0);
    assert.deepEqual(
      await migrateUp(pool!),
      [
        '0439_handyman_execution_scope_actor_identity',
        '0440_handyman_quotation_approval_binding_permission',
      ],
      'the re-apply must be exactly the two migrations that were reverted, in order',
    );
    const restoredPermission = await q(
      `SELECT count(*)::int AS n FROM permissions
        WHERE code = 'handyman.quotation.approval.binding.manage'`,
    );
    assert.equal(restoredPermission.rows[0].n, 1, '0440 re-applies exactly one row');
    // 0438 and 0437 roll back too while unpopulated (rolled back again so the
    // remaining tests keep a fully migrated schema).
    await inRollbackTx(async (client, run) => {
      await migration0438HandymanQuotationDecisionActorIdentity.down(client);
      await migration0437HandymanQuotationApprovalBindings.down(client);
      const tables = await run(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_name = $1`,
        [BINDING_TABLE],
      );
      assert.equal(tables.rows[0].n, 0, 'empty rollback drops the table');
      const legacyGuard = await run(
        `SELECT count(*)::int AS n FROM information_schema.triggers
          WHERE trigger_name = $1 AND event_manipulation = 'INSERT'`,
        [DECISION_TRIGGER],
      );
      assert.equal(
        legacyGuard.rows[0].n,
        0,
        'down returns the ledger guard to its 0394 timing',
      );
    });
    const restored = await q(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name = $1`,
      [BINDING_TABLE],
    );
    assert.equal(restored.rows[0].n, 1, 'ROLLBACK restores the dropped objects');
  });

  it('preserves historical USER decisions and never rewrites them', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    // A row shaped exactly like a pre-amendment record: only the 0394 columns.
    // Every historical row looks like this after the ALTER, because the
    // constant column default is the backfill (A01 6.1, decision A8) - so this
    // is a faithful reproduction of history, not an approximation of it.
    const legacy = await inRollbackTx(async (client, run) => {
      // The new guard refuses staff-class INSERTs, so the legacy shape is
      // produced by momentarily removing the guard - never by UPDATE-ing an
      // existing row. The DISABLE is transactional and vanishes with ROLLBACK.
      await client.query(
        `ALTER TABLE ${DECISION_TABLE} DISABLE TRIGGER ${DECISION_TRIGGER}`,
      );
      await run(
        `INSERT INTO ${DECISION_TABLE}
           (id, client_id, quotation_id, quotation_version_id, decision,
            tenant_company_id, tenant_pic_id, decided_by_user_id,
            idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, 'APPROVE', $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          thread.clientId,
          thread.quotationId,
          thread.versionId,
          thread.tenantCompanyId,
          thread.lineagePicId,
          adminUserId,
          `legacy-${randomUUID()}`,
          fingerprint('legacy'),
        ],
      );
      const row = await run(
        `SELECT decision_actor_type, decided_by_user_id, decided_by_tenant_pic_id,
                approval_binding_id
           FROM ${DECISION_TABLE} WHERE quotation_version_id = $1`,
        [thread.versionId],
      );
      // Put the guard back, then prove history is still frozen: the 0394
      // trigger keeps its message and its SQLSTATE after 0438 rewrote it, and
      // UPDATE is exactly the statement a backfill would have needed.
      await client.query(
        `ALTER TABLE ${DECISION_TABLE} ENABLE TRIGGER ${DECISION_TRIGGER}`,
      );
      await expectRefusalTx(
        run,
        () => run(
          `UPDATE ${DECISION_TABLE} SET decision = 'REJECT'
            WHERE quotation_version_id = $1`,
          [thread.versionId],
        ),
        IMMUTABLE_DECISION,
        { code: 'P0001' },
      );
      await expectRefusalTx(
        run,
        () => run(
          `DELETE FROM ${DECISION_TABLE} WHERE quotation_version_id = $1`,
          [thread.versionId],
        ),
        IMMUTABLE_DECISION,
        { code: 'P0001' },
      );
      return row.rows[0] as Record<string, unknown>;
    });
    assert.equal(legacy.decision_actor_type, 'USER');
    assert.equal(legacy.decided_by_user_id, adminUserId);
    assert.equal(legacy.decided_by_tenant_pic_id, null);
    assert.equal(legacy.approval_binding_id, null);
    // No backfill statement may exist in either ledger migration.
    for (const migration of [
      migration0438HandymanQuotationDecisionActorIdentity,
      migration0439HandymanExecutionScopeActorIdentity,
    ]) {
      const source = migration.up.toString();
      assert.doesNotMatch(source, /UPDATE\s+handyman_/, `${migration.id} must not UPDATE a ledger`);
      assert.doesNotMatch(source, /DELETE\s+FROM\s+handyman_/, `${migration.id} must not delete history`);
      assert.doesNotMatch(source, /TRUNCATE/i, `${migration.id} must not truncate`);
    }
  });

  it('blocks every new non-PIC decision at the ledger (prospective-only ban)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    for (const decision of ['APPROVE', 'REJECT'] as const) {
      await expectRefusal(
        () => inRollbackTx((_client, run) =>
          insertDecision(run, thread, null, {
            decision,
            decision_actor_type: 'USER',
            decided_by_user_id: adminUserId,
            decided_by_tenant_pic_id: null,
          })),
        'Only an attested Tenant PIC may decide a Handyman quotation.',
        { code: '23514' },
      );
    }
    // A third identity namespace may not be smuggled through the column.
    await expectRefusal(
      () => inRollbackTx((_client, run) =>
        insertDecision(run, thread, null, {
          decision_actor_type: 'CARE_ACTOR',
          decided_by_user_id: adminUserId,
          decided_by_tenant_pic_id: null,
        })),
      'Only an attested Tenant PIC may decide a Handyman quotation.',
    );
    // The live staff route is unchanged in this PART, so the refusal the
    // tenant-facing path now hits comes from the DB floor. This is the
    // controlled standstill recorded in the PART document - no fallback, and
    // no fallback test either: it is asserted as a fact.
    const issued = await buildThread({ issue: true });
    await expectRefusal(
      () => decideHandymanQuotation(issued.versionId, {
        decision: 'APPROVE',
        idempotencyKey: `standstill-${randomUUID()}`,
      }, adminUserId),
      'Only an attested Tenant PIC may decide a Handyman quotation.',
    );
    const residue = await q(
      `SELECT count(*)::int AS n FROM ${DECISION_TABLE}
        WHERE quotation_version_id = $1`,
      [issued.versionId],
    );
    assert.equal(residue.rows[0].n, 0, 'a refused decision leaves no residue');
    const version = await q(
      `SELECT status FROM handyman_quotation_versions WHERE id = $1`,
      [issued.versionId],
    );
    assert.equal(version.rows[0].status, 'ISSUED', 'the presentation is unchanged');
  });

  it('refuses an incoherent actor row even with the guard out of the way', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true });
    // A PIC decision that also names a user: exactly-one identity is the rule
    // that must refuse it.
    await expectRefusal(
      () => inRollbackTx(async (client, run) => {
        await client.query(
          `ALTER TABLE ${DECISION_TABLE} DISABLE TRIGGER ${DECISION_TRIGGER}`,
        );
        await insertDecision(run, thread, null, {
          decided_by_user_id: adminUserId,
        });
      }),
      'handyman_quotation_decisions_actor_identity_check',
      {
        code: '23514',
        constraint: 'handyman_quotation_decisions_actor_identity_check',
      },
    );
    // A USER-class row that names a binding (R-1.3, with a real binding so the
    // CHECK is unambiguously what refuses, not the foreign key).
    await expectRefusal(
      () => inRollbackTx(async (client, run) => {
        const bindingId = await insertBinding(run, thread);
        await client.query(
          `ALTER TABLE ${DECISION_TABLE} DISABLE TRIGGER ${DECISION_TRIGGER}`,
        );
        await insertDecision(run, thread, bindingId, {
          decision_actor_type: 'USER',
          decided_by_user_id: adminUserId,
          decided_by_tenant_pic_id: null,
        });
      }),
      'handyman_quotation_decisions_binding_check',
      {
        code: '23514',
        constraint: 'handyman_quotation_decisions_binding_check',
      },
    );
    // Scope ledger: the CHECK stands on its own, and it is the ONLY scope-side
    // rule in this PART (the TENANT_PIC-only creation guard is 03F's step), so
    // a coherent-but-for-actor-type row would otherwise have been accepted.
    await expectRefusal(
      () => bindAndApprove(thread, async ({ decisionId, run }) => {
        await insertScope(run, thread, decisionId, {
          created_by_user_id: adminUserId,
          created_by_actor_type: 'TENANT_PIC',
        });
      }),
      'handyman_execution_scopes_actor_identity_check',
      { constraint: 'handyman_execution_scopes_actor_identity_check' },
    );
  });

  it('enforces binding eligibility (B1-B5, MC0, snapshot coherence, R-1.2)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ withLineagePic: true });
    assert.ok(thread.lineagePicId, 'fixture must carry an attested lineage PIC');
    const bound = await inRollbackTx(async (_client, run) => {
      const id = await insertBinding(run, thread);
      const row = await run(
        `SELECT status, binding_version, granted_by_user_id, tenant_pic_id,
                revoked_by_user_id, revoked_at, supersedes_binding_id,
                (effective_until IS NULL) AS open_ended
           FROM ${BINDING_TABLE} WHERE id = $1`,
        [id],
      );
      return row.rows[0] as Record<string, unknown>;
    });
    assert.deepEqual(bound, {
      status: 'ACTIVE',
      binding_version: 1,
      granted_by_user_id: adminUserId,
      tenant_pic_id: thread.lineagePicId,
      revoked_by_user_id: null,
      revoked_at: null,
      supersedes_binding_id: null,
      open_ended: true,
    });

    // The refusal matrix runs against a thread with NO attested PIC, so each
    // rule under test is the one that fires (R-1.2 is asserted separately on
    // the attested thread above).
    const plain = await buildThread();
    const foreign = await buildThread();
    const matrix: Array<[string, Values, string]> = [
      ['B1', {
        tenant_pic_id: await createPic(plain.tenantCompanyId, { status: 'INACTIVE' }),
      }, 'requires an ACTIVE Tenant PIC'],
      ['B2', { tenant_pic_id: foreign.picId }, 'own tenant (B2)'],
      ['MC0', {
        tenant_pic_id: await createPic(plain.tenantCompanyId, { userId: adminUserId }),
      }, 'linked to themselves (MC1)'],
      ['B3', { occupancy_authority_id: foreign.occupancyId }, 'occupancy authority'],
      ['B4', { space_authority_id: foreign.spaceAuthorityId }, 'space authority (B4)'],
      ['B11', { tenant_company_id: foreign.tenantCompanyId }, 'must equal the request lineage'],
      ['B11', { handyman_request_id: foreign.requestId }, "must name its own thread and that thread's request"],
      ['B14', { binding_version: 7 }, "one greater than the thread's highest (B14)"],
      ['B14', { supersedes_binding_id: randomUUID() }, 'supersedes nothing'],
    ];
    for (const [rule, overrides, message] of matrix) {
      await expectRefusal(
        () => inRollbackTx((_client, run) => insertBinding(run, plain, overrides)),
        message,
        { code: '23514' },
      );
      assert.ok(rule, 'every matrix row names its rule');
    }
    // R-1.2: on an attested thread, no binding may name a different PIC.
    const rival = await createPic(thread.tenantCompanyId);
    await expectRefusal(
      () => inRollbackTx((_client, run) =>
        insertBinding(run, thread, { tenant_pic_id: rival })),
      'may not contradict the PIC already attested on the request (R-1.2)',
    );
  });

  it('keeps the binding lifecycle append-only (revoke, pin, freeze)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    // History: never deleted, and the only permitted UPDATE is the revoke.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const id = await insertBinding(run, thread);
        await run(`DELETE FROM ${BINDING_TABLE} WHERE id = $1`, [id]);
      }),
      'are history: never deleted',
    );
    // Every column except the revoke triple is frozen, including a write that
    // would change nothing (status -> 'ACTIVE'): the transition itself is the
    // only permitted UPDATE.
    const mutations: Array<{ sql: string; params: (id: string) => unknown[] }> = [
      {
        sql: `UPDATE ${BINDING_TABLE} SET tenant_pic_id = $1 WHERE id = $2`,
        params: (id) => [randomUUID(), id],
      },
      {
        sql: `UPDATE ${BINDING_TABLE} SET granted_by_user_id = $1 WHERE id = $2`,
        params: (id) => [randomUUID(), id],
      },
      {
        sql: `UPDATE ${BINDING_TABLE} SET status = 'ACTIVE' WHERE id = $1`,
        params: (id) => [id],
      },
      {
        sql: `UPDATE ${BINDING_TABLE} SET binding_version = 5 WHERE id = $1`,
        params: (id) => [id],
      },
      {
        sql: `UPDATE ${BINDING_TABLE}
                  SET effective_until = NOW() + interval '1 hour' WHERE id = $1`,
        params: (id) => [id],
      },
    ];
    for (const mutation of mutations) {
      await expectRefusal(
        () => inRollbackTx(async (_client, run) => {
          const id = await insertBinding(run, thread);
          await run(mutation.sql, mutation.params(id));
        }),
        'allow only ACTIVE -> REVOKED',
        { code: '23514' },
      );
    }
    // B14/B15: reassignment = revoke the prior row, then insert the successor.
    const rebind = await inRollbackTx(async (_client, run) => {
      const first = await insertBinding(run, thread);
      await revokeBinding(run, first);
      const successor = await createPic(thread.tenantCompanyId);
      const second = await insertBinding(run, thread, {
        binding_version: 2,
        supersedes_binding_id: first,
        tenant_pic_id: successor,
      });
      const active = await run(
        `SELECT count(*)::int AS n FROM ${BINDING_TABLE}
          WHERE quotation_id = $1 AND status = 'ACTIVE'`,
        [thread.quotationId],
      );
      const chain = await run(
        `SELECT supersedes_binding_id FROM ${BINDING_TABLE} WHERE id = $1`,
        [second],
      );
      return {
        activeCount: active.rows[0].n as number,
        first,
        supersedes: chain.rows[0].supersedes_binding_id as string,
      };
    });
    assert.equal(rebind.activeCount, 1, 'exactly one ACTIVE binding per thread');
    assert.equal(
      rebind.supersedes,
      rebind.first,
      'the successor names the row it replaces: an explicit chain, never an overwrite',
    );
    // A re-binding that skips the revoked row it must name is refused.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const first = await insertBinding(run, thread);
        await revokeBinding(run, first);
        await insertBinding(run, thread, { binding_version: 2 });
      }),
      'must name the binding row it replaces (B14)',
    );
    // B13 floor: while a version is ISSUED and undecided, the approver cannot
    // be swapped - but a revoke is always allowed (B15: safety outranks pin).
    const presented = await buildThread({ issue: true });
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const first = await insertBinding(run, presented);
        await revokeBinding(run, first);
        await insertBinding(run, presented, {
          binding_version: 2,
          supersedes_binding_id: first,
        });
      }),
      'pinned while a quotation version is presented (B13)',
    );
    await inRollbackTx(async (_client, run) => {
      const first = await insertBinding(run, presented);
      await revokeBinding(run, first);
      const status = await run(
        `SELECT status FROM ${BINDING_TABLE} WHERE id = $1`,
        [first],
      );
      assert.equal(status.rows[0].status, 'REVOKED', 'B15 outranks the pin');
    });
    // The one-ACTIVE index is the floor under the trigger, not the trigger:
    // with the guard disabled, the index still refuses a second live binding.
    await expectRefusal(
      () => inRollbackTx(async (client, run) => {
        await insertBinding(run, thread);
        await client.query(
          `ALTER TABLE ${BINDING_TABLE} DISABLE TRIGGER
             handyman_quotation_approval_binding_guard`,
        );
        await insertBinding(run, thread, { binding_version: 9 });
      }),
      'handyman_quotation_approval_bindings_one_active',
      { code: '23505' },
    );
  });

  it('freezes a decided thread and leaves existing immutability intact (B18)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true });
    await bindAndApprove(thread, async ({ bindingId, run }) => {
      await expectRefusalTx(
        run,
        () => insertBinding(run, thread, { binding_version: 2 }),
        'freeze once the thread has a decision (B18)',
      );
      await expectRefusalTx(
        run,
        () => revokeBinding(run, bindingId),
        'freeze once the thread has a decision (B18)',
      );
    });
    // The parent immutability triggers are untouched by this PART: an actual
    // change to an anchor column still raises, exactly as it did before.
    const plain = await buildThread();
    const stranger = await buildThread();
    await expectRefusal(
      () => q(
        `UPDATE handyman_quotations SET handyman_request_id = $2 WHERE id = $1`,
        [plain.quotationId, stranger.requestId],
      ),
      'Handyman quotation identity facts are immutable',
    );
    await expectRefusal(
      () => q(`DELETE FROM handyman_quotations WHERE id = $1`, [plain.quotationId]),
      'Handyman quotation roots are never deleted',
    );
    await expectRefusal(
      () => q(
        `UPDATE handyman_quotation_versions SET version_number = 9 WHERE id = $1`,
        [plain.versionId],
      ),
      'Handyman quotation version facts are immutable',
    );
    await bindAndApprove(thread, async ({ decisionId, run }) => {
      // The 0395 scope guard is untouched, so the three new scope columns are
      // immutable by inheritance: an UPDATE raises on its own way, and the
      // scope row itself is still writable only through an INSERT (the
      // TENANT_PIC-only creation guard is 03F's ratified step).
      const scopeId = await insertScope(run, thread, decisionId);
      await expectRefusal(
        () => run(
          `UPDATE ${SCOPE_TABLE} SET status = 'AUTHORIZED' WHERE id = $1`,
          [scopeId],
        ),
        'Handyman execution scopes are immutable authority records',
      );
    });
  });

  it('authorises a PIC decision only through a live, coherent binding', async (t) => {
    if (!requireDatabase(t)) return;
    // The F-06 remedy, proven at the schema level: a request with NO lineage
    // PIC gains an approver through an audited binding, and that approver's
    // decision is recordable.
    const thread = await buildThread({ issue: true });
    assert.equal(thread.lineagePicId, null);
    const approved = await inRollbackTx(async (_client, run) => {
      const bindingId = await insertBinding(run, thread);
      const decisionId = await insertDecision(run, thread, bindingId);
      const row = await run(
        `SELECT decision_actor_type, decided_by_tenant_pic_id, approval_binding_id,
                decided_by_user_id, tenant_pic_id
           FROM ${DECISION_TABLE} WHERE id = $1`,
        [decisionId],
      );
      return { bindingId, actor: row.rows[0] as Record<string, unknown> };
    });
    assert.deepEqual(approved.actor, {
      decision_actor_type: 'TENANT_PIC',
      decided_by_tenant_pic_id: thread.picId,
      approval_binding_id: approved.bindingId,
      decided_by_user_id: null,
      tenant_pic_id: null,
    });
    // B16/R-1.1: a revoked binding never authorizes anything.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const bindingId = await insertBinding(run, thread);
        await revokeBinding(run, bindingId);
        await insertDecision(run, thread, bindingId);
      }),
      'must name the PIC its approval binding confers',
    );
    // Borrowing another thread's binding.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const other = await buildThread();
        const bindingId = await insertBinding(run, other);
        await insertDecision(run, thread, bindingId);
      }),
      'may not borrow a binding from another quotation thread',
    );
    // The signer must be exactly the bound PIC.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const bindingId = await insertBinding(run, thread);
        await insertDecision(run, thread, bindingId, {
          decided_by_tenant_pic_id: await createPic(thread.tenantCompanyId),
        });
      }),
      'must name the PIC its approval binding confers',
    );
    // The attributed tenant must agree with the PIC's own tenant.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const bindingId = await insertBinding(run, thread);
        const other = await buildThread();
        await insertDecision(run, thread, bindingId, {
          tenant_company_id: other.tenantCompanyId,
        });
      }),
      'must be ACTIVE and belong to the attributed tenant',
    );
    // MC1': a PIC linked to the thread author may not self-approve (the
    // granter half of the maker set is refused earlier, at the binding write).
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const linked = await createPic(thread.tenantCompanyId, { userId: adminUserId });
        const granter = await staffUser();
        const bindingId = await insertBinding(run, thread, {
          tenant_pic_id: linked,
          granted_by_user_id: granter,
        });
        await insertDecision(run, thread, bindingId, {
          decided_by_tenant_pic_id: linked,
        });
      }),
      'may not self-approve',
    );
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const granter = await staffUser();
        const linked = await createPic(thread.tenantCompanyId, { userId: granter });
        await insertBinding(run, thread, {
          tenant_pic_id: linked,
          granted_by_user_id: granter,
        });
      }),
      'linked to themselves (MC1)',
    );
    // MC4': fail-closed. Occupancy turnover after binding kills the decision
    // rather than falling back to the binding's snapshot.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const bindingId = await insertBinding(run, thread);
        await run(
          `UPDATE tenant_building_contexts SET status = 'INACTIVE' WHERE id = $1`,
          [thread.occupancyId],
        );
        await insertDecision(run, thread, bindingId);
      }),
      'requires current occupancy authority',
    );
    // tenant_pic_id keeps its lineage meaning and may not be repurposed.
    await expectRefusal(
      () => inRollbackTx(async (_client, run) => {
        const bindingId = await insertBinding(run, thread);
        await insertDecision(run, thread, bindingId, {
          tenant_pic_id: thread.occupancyId,
        });
      }),
      'it may not disagree with the signing PIC',
    );
  });

  it('lets a scope reference a PIC decision without a second ledger (E2)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true });
    const chain = await bindAndApproveCapture(thread);
    assert.equal(chain.bindingId, chain.expectedBindingId);
    assert.equal(chain.picId, thread.picId);
  });

  it('keeps exactly one ACTIVE binding per thread under concurrent writers', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    const values = {
      // Each writer invents its own id: the point is that the thread-level
      // invariants, not a primary-key accident, decide the race.
      id: randomUUID(),
      quotation_id: thread.quotationId,
      handyman_request_id: thread.requestId,
      client_id: thread.clientId,
      tenant_company_id: thread.tenantCompanyId,
      building_id: thread.buildingId,
      space_id: thread.spaceId,
      tenant_pic_id: thread.picId,
      binding_version: 1,
      supersedes_binding_id: null,
      effective_until: null,
      occupancy_authority_id: thread.occupancyId,
      space_authority_id: thread.spaceAuthorityId,
      granted_by_user_id: adminUserId,
    };
    const columns = Object.keys(values);
    const sql = `INSERT INTO ${BINDING_TABLE} (${columns.join(', ')})
      VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`;
    const params = columns.map((column) => values[column as keyof typeof values]);
    const rivalParams = [...params];
    rivalParams[0] = randomUUID();
    const a = await pool!.connect();
    const b = await pool!.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(sql, params);
      // B's guard cannot see A's uncommitted row, so both compute version 1 and
      // the unique indexes are what settle it.
      const loser = b.query(sql, rivalParams).catch((error: DbError) => error);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await a.query('COMMIT');
      const failure = (await loser) as DbError;
      assert.ok(failure instanceof Error, 'the second writer must not commit');
      assert.equal(failure.code, '23505');
      await b.query('ROLLBACK');
      const active = await q(
        `SELECT count(*)::int AS n FROM ${BINDING_TABLE}
          WHERE quotation_id = $1 AND status = 'ACTIVE'`,
        [thread.quotationId],
      );
      assert.equal(active.rows[0].n, 1, 'exactly one writer won');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it('refuses to roll back a populated ledger (forward-fix only)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true });
    // 0437 refuses once any binding row exists.
    await expectRefusal(
      () => inRollbackTx(async (client, run) => {
        await insertBinding(run, thread);
        await migration0437HandymanQuotationApprovalBindings.down(client);
      }),
      'Rollback refused: handyman_quotation_approval_bindings is populated',
    );
    // 0438 refuses once a PIC-attributed decision exists, and 0439 refuses once
    // a PIC-attributed scope exists.
    for (const [migration, message] of [
      [
        migration0438HandymanQuotationDecisionActorIdentity,
        'Rollback refused: handyman_quotation_decisions carries PIC-attributed',
      ],
      [
        migration0439HandymanExecutionScopeActorIdentity,
        'Rollback refused: handyman_execution_scopes carries PIC-attributed rows',
      ],
    ] as const) {
      await expectRefusal(
        () => inRollbackTx(async (client, run) => {
          const bindingId = await insertBinding(run, thread);
          const decisionId = await insertDecision(run, thread, bindingId);
          if (migration === migration0439HandymanExecutionScopeActorIdentity) {
            await insertScope(run, thread, decisionId);
          }
          await migration.down(client);
        }),
        message,
      );
    }
    const survived = await q(
      `SELECT count(*)::int AS n FROM ${BINDING_TABLE}
        WHERE quotation_id = $1`,
      [thread.quotationId],
    );
    assert.equal(survived.rows[0].n, 0, 'every refused rollback rolls back too');
    const decisions = await q(
      `SELECT count(*)::int AS n FROM ${DECISION_TABLE}`,
    );
    assert.equal(decisions.rows[0].n, 0);
  });
});

/**
 * Approval + scope in one transaction: proves the scope reaches its authority
 * through the decision row (one hop), so no scope-side binding column - and no
 * second ledger - is needed (ADD-A 5, A01 E2).
 */
async function bindAndApproveCapture(
  thread: Thread,
): Promise<{ bindingId: string; expectedBindingId: string; picId: string }> {
  return inRollbackTx(async (_client, run) => {
    const bindingId = await insertBinding(run, thread);
    const decisionId = await insertDecision(run, thread, bindingId);
    const scopeId = await insertScope(run, thread, decisionId);
    const chain = await run(
      `SELECT b.id AS binding_id, b.tenant_pic_id AS pic_id,
              s.id IS NOT NULL AS scope_present
         FROM ${SCOPE_TABLE} s
         JOIN ${DECISION_TABLE} d ON d.id = s.quotation_decision_id
         JOIN ${BINDING_TABLE} b ON b.id = d.approval_binding_id
        WHERE s.id = $1`,
      [scopeId],
    );
    assert.equal(chain.rows.length, 1, 'the chain must resolve in one join');
    assert.equal(chain.rows[0].scope_present, true);
    return {
      bindingId: chain.rows[0].binding_id as string,
      expectedBindingId: bindingId,
      picId: chain.rows[0].pic_id as string,
    };
  });
}
