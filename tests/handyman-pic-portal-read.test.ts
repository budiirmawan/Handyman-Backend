import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { handymanCareActorService } from '../src/modules/handyman-care-actors';
import {
  handoffIntegrationSecretEnvName,
  handoffRuntimeRepository,
} from '../src/modules/handyman-handoff';
import {
  admitCareWorkspace,
  signCareWorkspaceAssertion,
  type CareWorkspaceAssertion,
} from '../src/modules/handyman-care-workspace/care-workspace.service';
import {
  PIC_WORKSPACE_PURPOSE,
  admitPicWorkspace,
  signPicWorkspaceAssertion,
  revokePicWorkspaceSession,
  type PicWorkspaceAssertion,
} from '../src/modules/handyman-pic-session';
import {
  PIC_PORTAL_ELIGIBILITY_CODES,
  PIC_PORTAL_ELIGIBILITY_MESSAGES,
  evaluatePicApprovalEligibility,
  type PicPortalEligibilityCode,
  type PicPortalEligibilityInput,
} from '../src/modules/handyman-pic-portal';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * W03 PART 03D — the bounded PIC portal read: what a Tenant PIC may see of its
 * own ISSUED quotation, and whether it could decide it right now
 * (CR-HM-06/A01 §9 + §13 `03D`, ADD-A B1–B5/B12–B17/C22; migrations 0441/0442
 * from 03C supply the credential and the ledger's session column).
 *
 * A01 §13 gives this PART a three-item exit gate, and the file is organised
 * around it:
 *
 *   - **404-uniformity** — a thread that is not the caller's is answered exactly
 *     like a thread that does not exist, with the same body and by the same
 *     statement (`credential scoping`, `wrong PIC and own-decision`);
 *   - **minimization** — the projection carries no staff metadata, no lineage
 *     provenance, no replay internals and no person data (`the payload is the
 *     contract`), and reasons name no identifiers (`non-sensitive by
 *     construction`);
 *   - **no-C6-reuse** — the new predicate never touches `user_building_assignments`
 *     or a tenant-company grant (`the read is authorized by the credential`).
 *
 * The PART order adds the rest: session ACTIVE/expiry/revocation, binding
 * ACTIVE/window, quotation expiry, maker-checker, revalidation after the row
 * lock, and the six named negatives (cross-tenant, cross-building, wrong PIC,
 * revoked session, expired binding, identity mismatch). Release safety is
 * asserted too: B12 stays un-enabled and the staff decide path is still refused
 * by the ledger — this PART must not look like a cutover.
 *
 * Everything runs against a LIVE app over a LIVE server: this suite boots its own
 * embedded PostgreSQL (55561) and `t.skip`s rather than pretending.
 */

const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const DATA_DIR = '/tmp/asentra-w03-03d-pg';
const DB_PORT = 55561;
const SECRET = 'pic-portal-read-integration-secret-0443';
const CARE_SECRET = 'care-secret-that-the-portal-must-never-accept-0443';
const UNAUTHORIZED = 'HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED';
const NOT_FOUND = 'HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND';
const SESSION_TABLE = 'handyman_pic_workspace_sessions';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
/** A REAL staff bearer token, used only to prove it buys nothing here. */
let adminToken = '';
let integrationCode = '';
let careCode = '';
let careActorReference = '';
let disciplineId = '';

beforeEach(() => clearLoginRateLimits());

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};
const tokenHashOf = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');
const iso = (offsetSeconds: number) =>
  new Date(Date.now() + offsetSeconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

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
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1',
      DB_PORT: String(DB_PORT),
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'asentra_test',
      DB_SSL: 'false',
    });
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
  adminToken = admin.token;

  integrationCode = `P03D_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode,
    displayName: '03D PIC attesting integration',
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: integration.id,
    capability: 'TENANT_PIC',
  });
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = SECRET;

  careCode = `C03D_${suffix()}`;
  const care = await handoffRuntimeRepository.createIntegration({
    integrationCode: careCode,
    displayName: '03D care integration (confusion control)',
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: care.id,
    capability: 'CUSTOMER_CARE',
  });
  careActorReference = `care-03d-${suffix()}`;
  await handymanCareActorService.createCareActor({
    integrationId: care.id,
    actorReference: careActorReference,
    displayName: '03D care actor',
  });
  process.env[handoffIntegrationSecretEnvName(careCode)] = CARE_SECRET;

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createPic(
  tenantCompanyId: string,
  options: { status?: string; userId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO tenant_pics
       (id, tenant_company_id, user_id, pic_name, email, status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
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

async function createSpaceIn(buildingId: string, clientKey: string) {
  const floor = await floorService.createFloor({
    buildingId,
    code: `F${clientKey}`,
    name: '03D Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A${clientKey}`,
    name: '03D Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R${clientKey}`,
    name: '03D Room',
  });
  return spaceService.createSpace({
    roomId: room.id,
    code: `S${clientKey}`,
    name: '03D Space',
  });
}

type ThreadOptions = {
  /** Price + present a version (B12 is NOT enabled, so this needs no binding). */
  issue?: boolean;
  /** An ACTIVE, effective approval binding for `picId`, inserted before issue. */
  bind?: boolean;
  /** `effective_until` of that binding, in seconds from now. */
  bindingUntilSeconds?: number;
  /** The BM lineage names the PIC on the request itself. */
  withLineagePic?: boolean;
  /** Bind/attest a DIFFERENT PIC of the same tenant than the request lineage. */
  bindRival?: boolean;
  /** Link the thread's PIC to this user (MC1′: the author side). */
  picUserId?: string;
  /** Second space in the same building, so the thread sits elsewhere. */
  secondSpace?: boolean;
  /** A second building for the same client/tenant: same tenant, other site. */
  secondBuilding?: boolean;
};

type Thread = {
  clientId: string;
  propertyId: string;
  buildingId: string;
  otherBuildingId: string | null;
  tenantCompanyId: string;
  spaceId: string;
  secondSpaceId: string | null;
  occupancyId: string;
  spaceAuthorityId: string;
  otherOccupancyId: string | null;
  attributionId: string;
  requestId: string;
  otherRequestId: string | null;
  quotationId: string;
  versionId: string;
  picId: string;
  rivalPicId: string | null;
  lineagePicId: string | null;
  bindingId: string | null;
  catalogId: string;
};

/**
 * A complete thread, built the way the master data forces it to be built:
 * attribution → request → triage → diagnosis → quotation → line → issue. Nothing
 * here is a shortcut around a guard: `insertBinding` writes the same row the
 * staff service would, because 03D reads the binding and must not own its write
 * path (that is B8's staff surface).
 */
async function buildThread(options: ThreadOptions = {}): Promise<Thread> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `S03D${tag}`,
    name: `03D Client ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P03D${tag}`,
    name: '03D Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B03D${tag}`,
    name: '03D Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const space = await createSpaceIn(building.id, `${tag}A`);
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `T03D${tag}`, tenantName: `03D Tenant ${tag}` },
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
  const spaceAuthority = async (buildingKey: string, spaceKey: string) => {
    const row = await q(
      `SELECT id FROM tenant_space_relationships
        WHERE tenant_company_id = $1 AND building_id = $2 AND space_id = $3`,
      [company.id, buildingKey, spaceKey],
    );
    assert.equal(row.rows.length, 1, 'the fixture assigned this space to the tenant');
    return row.rows[0].id as string;
  };
  let spaceAuthorityId = await spaceAuthority(building.id, space.id);

  // B4: a binding on a spaced request must name the CURRENT space authority of
  // that very space, so the id travels with the target the thread lands on.
  let secondSpaceAuthorityId: string | null = null;
  let secondSpaceId: string | null = null;
  let otherBuildingId: string | null = null;
  let otherOccupancyId: string | null = null;
  let targetSpaceId = space.id;
  let targetBuildingId = building.id;

  if (options.secondSpace) {
    const second = await createSpaceIn(building.id, `${tag}B`);
    await tenantSpaceService.assignSpaceToTenant(
      { tenantCompanyId: company.id, buildingId: building.id, spaceId: second.id },
      adminUserId,
    );
    secondSpaceId = second.id;
    secondSpaceAuthorityId = await spaceAuthority(building.id, second.id);
    targetSpaceId = second.id;
  }
  if (options.secondBuilding) {
    const other = await buildingService.createBuilding({
      propertyId: property.id,
      code: `X03D${tag}`,
      name: '03D Other Building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: other.id,
    });
    const otherSpace = await createSpaceIn(other.id, `${tag}C`);
    await tenantSpaceService.assignSpaceToTenant(
      { tenantCompanyId: company.id, buildingId: other.id, spaceId: otherSpace.id },
      adminUserId,
    );
    await tenantBuildingContextService.createTenantBuildingContext(
      { tenantCompanyId: company.id, buildingId: other.id },
      adminUserId,
    );
    otherOccupancyId = (
      await q(
        `SELECT id FROM tenant_building_contexts
          WHERE tenant_company_id = $1 AND building_id = $2`,
        [company.id, other.id],
      )
    ).rows[0].id as string;
    spaceAuthorityId = await spaceAuthority(other.id, otherSpace.id);
    otherBuildingId = other.id;
    targetBuildingId = other.id;
    targetSpaceId = otherSpace.id;
  }

  const picId = await createPic(company.id, {
    ...(options.picUserId ? { userId: options.picUserId } : {}),
  });
  const rivalPicId = options.bindRival
    ? await createPic(company.id)
    : null;

  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: targetBuildingId,
    ...(options.withLineagePic ? { tenantPicId: picId } : {}),
    spaceId: targetSpaceId,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: adminUserId,
  });
  const catalog = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `HM${tag}`,
      name: '03D Service',
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
      triageNote: '03D fixture triage.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: '03D fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id },
    adminUserId,
  );
  const versionId = bundle.versions[0].id as string;

  let bindingId: string | null = null;
  if (options.bind) {
    bindingId = randomUUID();
    await q(
      `INSERT INTO handyman_quotation_approval_bindings
         (id, quotation_id, handyman_request_id, client_id, tenant_company_id,
          building_id, space_id, tenant_pic_id, binding_version,
          supersedes_binding_id, status, effective_from, effective_until,
          occupancy_authority_id, space_authority_id, granted_by_user_id,
          granted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,NULL,'ACTIVE',NOW(),$9,$10,$11,$12,NOW())`,
      [
        bindingId,
        bundle.quotation.id,
        request.id,
        client.id,
        company.id,
        targetBuildingId,
        targetSpaceId,
        rivalPicId ?? picId,
        options.bindingUntilSeconds === undefined
          ? null
          : new Date(Date.now() + options.bindingUntilSeconds * 1000),
        options.secondBuilding ? otherOccupancyId : occupancyId,
        secondSpaceAuthorityId ?? spaceAuthorityId,
        adminUserId,
      ],
    );
  }

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
        description: 'Handy hours',
        quantity: 2,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 150_000,
      },
      adminUserId,
    );
    await issueHandymanQuotationVersion(versionId, {
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }, adminUserId);
  }

  const requestRow = await q(
    `SELECT tenant_pic_id, space_id, building_id, tenant_company_id, client_id
       FROM handyman_service_requests WHERE id = $1`,
    [request.id],
  );
  assert.equal(requestRow.rows[0].building_id, targetBuildingId);

  let otherRequestId: string | null = null;
  if (options.secondSpace && otherOccupancyId === null) {
    // A sibling thread in the FIRST space of the same building, so a
    // space-narrowed credential can be shown to exclude it.
    const otherAttribution = await createChannelAttribution({
      tenantCompanyId: company.id,
      buildingId: building.id,
      spaceId: space.id,
      originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
      createdByUserId: adminUserId,
    });
    const other = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: otherAttribution.id, serviceCatalogId: catalog.id },
      adminUserId,
    );
    otherRequestId = other.id;
  }

  return {
    clientId: client.id,
    propertyId: property.id,
    buildingId: building.id,
    otherBuildingId,
    tenantCompanyId: company.id,
    spaceId: space.id,
    secondSpaceId,
    occupancyId,
    spaceAuthorityId,
    otherOccupancyId,
    attributionId: attribution.id,
    requestId: request.id,
    otherRequestId,
    quotationId: bundle.quotation.id,
    versionId,
    picId,
    rivalPicId,
    lineagePicId: (requestRow.rows[0].tenant_pic_id as string | null) ?? null,
    bindingId,
    catalogId: catalog.id,
  };
}

/** Another tenant, same client, same fixture shape — the cross-tenant control. */
async function buildForeignThread(): Promise<Thread> {
  return buildThread({ issue: true });
}

function assertion(
  representation: Record<string, unknown>,
  over: Record<string, unknown> = {},
): PicWorkspaceAssertion {
  return {
    purpose: PIC_WORKSPACE_PURPOSE,
    integrationCode,
    assertionId: randomUUID(),
    issuedAt: iso(-2),
    expiresAt: iso(120),
    representation,
    ...over,
  } as PicWorkspaceAssertion;
}

/**
 * A caller that wants to WITHDRAW a claim must drop the key. `stableJson` —
 * what both the test and the server canonicalize with — renders an explicit
 * `undefined` as the literal `null`, while `JSON.stringify` on the wire removes
 * the key entirely; leaving the key in place would therefore sign a body that
 * is not the body being sent, and 03C would (correctly) answer 401.
 */
const prune = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, claim]) => claim !== undefined),
  ) as T;

/** Admission is 03C's; this suite only ever uses it, never re-implements it. */
async function admit(
  thread: Thread,
  over: Record<string, unknown> = {},
): Promise<string> {
  // `spaceId: undefined` is how a caller drops the space claim: JSON.stringify
  // removes the key, so the signed representation stays within 03C's exact set.

  const body = assertion(
    prune({
      tenantCompanyId: thread.tenantCompanyId,
      buildingId: thread.buildingId,
      tenantPicId: thread.picId,
      ...(thread.secondSpaceId ? {} : { spaceId: thread.spaceId }),
      ...over,
    }),
  );
  const response = await api()
    .post('/api/v1/handyman/pic/session')
    .set('x-hub-signature-256', signPicWorkspaceAssertion(body, SECRET))
    .send(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.workspaceToken as string;
}

async function sessionIdOf(token: string): Promise<string> {
  const row = await q(`SELECT id FROM ${SESSION_TABLE} WHERE token_hash = $1`, [
    tokenHashOf(token),
  ]);
  assert.equal(row.rows.length, 1, 'one session per token hash');
  return row.rows[0].id as string;
}

const requestPath = (id: string) => `/api/v1/handyman/pic/requests/${id}`;
const eligibilityPath = (id: string) =>
  `/api/v1/handyman/pic/requests/${id}/approval-eligibility`;
const decisionPath = (versionId: string) =>
  `/api/v1/handyman/pic/quotation-versions/${versionId}/decision`;

const read = (token: string, path: string) =>
  api().get(path).set('authorization', `Bearer ${token}`);

/** Two refusals must be indistinguishable, envelope included. */
function assertUniform404(response: { status: number; body: any }, label: string): void {
  assert.equal(response.status, 404, `${label}: got ${response.status} ${JSON.stringify(response.body)}`);
  assert.equal(response.body.success, false, label);
  assert.equal(response.body.error.code, NOT_FOUND, label);
  assert.equal(
    response.body.error.message,
    'Resource not found for this PIC session.',
    `${label}: the 404 must not explain itself`,
  );
}

/** Plants a legal, guard-satisfying PIC decision (03E is not shipped yet). */
async function plantDecision(
  thread: Thread,
  options: { picId?: string; sessionId?: string; bindingId?: string | null } = {},
): Promise<string> {
  const picId = options.picId ?? thread.picId;
  const bindingId = options.bindingId === undefined ? thread.bindingId : options.bindingId;
  const sessionId =
    options.sessionId ?? (await sessionIdOf(await admit(thread)));
  await q(
    `INSERT INTO handyman_quotation_decisions
       (id, client_id, quotation_id, quotation_version_id, decision,
        tenant_company_id, tenant_pic_id, decided_by_user_id,
        idempotency_key, request_fingerprint, decision_actor_type,
        decided_by_tenant_pic_id, approval_binding_id,
        decided_by_pic_session_id, decided_at)
     VALUES ($1,$2,$3,$4,'APPROVE',$5,NULL,NULL,$6,$7,'TENANT_PIC',$8,$9,$10,NOW())`,
    [
      randomUUID(),
      thread.clientId,
      thread.quotationId,
      thread.versionId,
      thread.tenantCompanyId,
      `k-${randomUUID()}`,
      'a'.repeat(64),
      picId,
      bindingId,
      sessionId,
    ],
  );
  return sessionId;
}

async function codes(token: string, path: string): Promise<PicPortalEligibilityCode[]> {
  const response = await read(token, path);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return (response.body.data.reasons as Array<{ code: PicPortalEligibilityCode }>).map(
    reason => reason.code,
  );
}

// ---------------------------------------------------------------------------
// A. The payload is the contract (item 3, item 10)
// ---------------------------------------------------------------------------

describe('W03 PART 03D — the bounded quotation read', () => {
  it('returns the thread, the presented version, its lines and derived totals', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const response = await read(token, requestPath(thread.requestId));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.handymanRequestId, thread.requestId);
    assert.equal(data.tenantCompanyId, thread.tenantCompanyId);
    assert.equal(data.buildingId, thread.buildingId);
    assert.equal(data.spaceId, thread.spaceId);
    assert.equal(data.serviceCatalogId, thread.catalogId);
    assert.ok('description' in data, 'the request note is part of the contract');
    // Only the ISSUED version is described, and only once: no revision thread.
    assert.equal(Object.keys(data.quotation).length, 2);
    assert.equal(data.quotation.quotationId, thread.quotationId);
    const version = data.quotation.presentedVersion;
    assert.equal(version.quotationVersionId, thread.versionId);
    assert.equal(version.versionNumber, 1);
    assert.equal(version.status, 'ISSUED');
    assert.equal(version.lines.length, 1);
    assert.deepEqual(version.lines[0], {
      id: version.lines[0].id,
      lineType: 'LABOR',
      description: 'Handy hours',
      quantity: 2,
      uomId: version.lines[0].uomId,
      finalQuotedUnitAmount: 150000,
      lineTotal: 300000,
      currency: 'IDR',
    });
    assert.deepEqual(version.totals, {
      laborSubtotal: 300000,
      materialSubtotal: 0,
      total: 300000,
      currency: 'IDR',
      lineCount: 1,
    });
    assert.equal(data.decision, null);
    assert.equal(data.approvalBinding.approvalBindingId, thread.bindingId);
    assert.equal(data.approvalBinding.status, 'ACTIVE');
    assert.equal(data.approvalBinding.tenantPicId, thread.picId);
    assert.equal(data.approvalBinding.grantedByUserId, adminUserId);
    assert.deepEqual(Object.keys(data.session).sort(), [
      'canDecide', 'expiresAt', 'sessionId',
    ]);
    assert.equal(data.session.canDecide, true);
    assert.equal(response.headers['cache-control'], 'no-store');
    // Staff metadata and internal audit are absent, structurally: the keys that
    // would carry them do not exist in the payload at all.
    const wire = JSON.stringify(response.body);
    for (const forbidden of [
      'createdByUserId', 'originChannel', 'originReference', 'channelAttributionId',
      'idempotencyKey', 'requestFingerprint', 'occupancyAuthorityId',
      'spaceAuthorityId', 'supersedesBindingId', 'revokedByUserId', 'versions',
      'picName', 'email', 'phone', 'referenceUnitAmount', 'sourceItemId',
      thread.attributionId, 'user_sessions',
    ]) {
      assert.ok(
        !wire.includes(forbidden),
        `the portal projection must not carry "${forbidden}"`,
      );
    }
    // The credential itself is never echoed either — only the session id.
    assert.ok(!wire.includes('hpw_') && !wire.includes(token), 'no token material');
  });

  it('reads a thread with no presented version instead of inventing a 404', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread();
    const token = await admit(thread);
    const response = await read(token, requestPath(thread.requestId));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.quotation.presentedVersion, null);
    assert.equal(response.body.data.decision, null);
    const eligibility = await read(token, eligibilityPath(thread.requestId));
    assert.equal(eligibility.status, 200);
    assert.equal(eligibility.body.data.quotationVersionId, null);
    assert.ok(
      (eligibility.body.data.reasons as Array<{ code: string }>).some(
        reason => reason.code === 'VERSION_NOT_ISSUED',
      ),
      'an unissued thread is explained, not hidden',
    );
  });

  it('answers 400 for a malformed id and rejects query or body on all three reads', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    for (const path of [
      requestPath('not-a-uuid'),
      eligibilityPath('nope'),
      decisionPath('null'),
    ]) {
      const response = await read(token, path);
      assert.equal(response.status, 400, `${path}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
    // Rule 13: no input may widen or shift what the credential already scoped.
    const polluted = await api()
      .get(requestPath(thread.requestId))
      .query({ tenantCompanyId: thread.tenantCompanyId, buildingId: thread.buildingId })
      .set('authorization', `Bearer ${token}`);
    assert.equal(polluted.status, 400);
    const withBody = await api()
      .get(requestPath(thread.requestId))
      .set('authorization', `Bearer ${token}`)
      .send({ tenantCompanyId: thread.tenantCompanyId });
    assert.equal(withBody.status, 400);
    assert.equal(withBody.body.error.code, 'VALIDATION_ERROR');
    const stillFine = await read(token, requestPath(thread.requestId));
    assert.equal(stillFine.status, 200, 'a refused request changed nothing');
  });

  it('reports the request status without ever gating on it (B7)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const before = await read(token, requestPath(thread.requestId));
    assert.equal(before.status, 200);
    const status = before.body.data.requestStatus;
    // Whatever intake state this thread is in, the read and the eligibility
    // report do not consult it: B7 forbids inventing a request-status gate.
    await q(`UPDATE handyman_service_requests SET status = 'INTAKE' WHERE id = $1`, [
      thread.requestId,
    ]);
    const after = await read(token, requestPath(thread.requestId));
    assert.equal(after.status, 200);
    assert.notEqual(after.body.data.requestStatus, status);
    const eligibility = await read(token, eligibilityPath(thread.requestId));
    assert.equal(eligibility.status, 200);
    assert.equal(eligibility.body.data.eligible, true, JSON.stringify(eligibility.body.data.reasons));
  });
});

// ---------------------------------------------------------------------------
// B. 404-uniformity: the credential scopes, the lineage decides (items 4, 9)
// ---------------------------------------------------------------------------

describe('W03 PART 03D — 404 uniformity against every thread that is not mine', () => {
  it('cannot tell another tenant\'s thread from one that does not exist', async (t) => {
    if (!requireDatabase(t)) return;
    const mine = await buildThread({ issue: true, bind: true });
    const theirs = await buildForeignThread();
    const token = await admit(mine);
    const foreign = await read(token, requestPath(theirs.requestId));
    const unknown = await read(token, requestPath(randomUUID()));
    assertUniform404(foreign, 'cross-tenant');
    assertUniform404(unknown, 'unknown id');
    const strip = (body: any) => ({ ...body, error: { ...body.error, requestId: undefined } });
    assert.deepEqual(
      strip(foreign.body),
      strip(unknown.body),
      'the two refusals are the same bytes apart from the correlation id',
    );
    // The eligibility read of the same foreign thread is equally silent.
    assertUniform404(await read(token, eligibilityPath(theirs.requestId)), 'cross-tenant eligibility');
    assertUniform404(await read(token, decisionPath(theirs.versionId)), 'cross-tenant version');
    // And nothing in the failure reveals the foreign thread's shape.
    assert.ok(!JSON.stringify(foreign.body).includes(theirs.quotationId));
    assert.ok(!JSON.stringify(foreign.body).includes(theirs.tenantCompanyId));
  });

  it('cannot read the same tenant\'s other building', async (t) => {
    if (!requireDatabase(t)) return;
    // One tenant, two buildings, two threads. A PIC session is minted per
    // tenant-BUILDING context (rule 12), so the sibling building is out of
    // reach even though the tenant grant would cover it — that is the whole
    // point of occupancy-derived authority.
    const thread = await buildThread({ issue: true, bind: true, secondBuilding: true });
    const tokenForFirst = await admit(thread, {});
    // The thread lives in the SECOND building, so this credential cannot see it.
    assertUniform404(
      await read(tokenForFirst, requestPath(thread.requestId)),
      'cross-building',
    );
    // Admitted against the building the thread actually lives in (and with no
    // space claim, because the space above belongs to the FIRST building), it
    // can: the sibling thread is not foreign, only mis-credentialled.
    const tokenForSecond = await admit(thread, {
      buildingId: thread.otherBuildingId,
      spaceId: undefined,
    });
    const ok = await read(tokenForSecond, requestPath(thread.requestId));
    // NOTE: `resolveHandoffContext` re-resolves (tenant, building) — the second
    // admission only succeeds because the tenant occupies that building too.
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.buildingId, thread.otherBuildingId);
  });

  it('honours a space-narrowed credential and a space-free one differently', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({
      issue: true,
      bind: true,
      secondSpace: true,
    });
    assert.ok(thread.otherRequestId, 'fixture builds a sibling thread in space A');
    const narrowed = await admit(thread, { spaceId: thread.secondSpaceId! });
    assert.equal(
      (await read(narrowed, requestPath(thread.requestId))).status,
      200,
      'the thread in the claimed space is readable',
    );
    assertUniform404(
      await read(narrowed, requestPath(thread.otherRequestId!)),
      'thread in another space of the same building',
    );
    const wide = await admit(thread, {});
    assert.equal((await read(wide, requestPath(thread.otherRequestId!))).status, 200);
  });

  it('refuses a wrong-PIC thread\'s decision while still reading the thread', async (t) => {
    if (!requireDatabase(t)) return;
    // The request names no PIC, so the binding is free to confer a RIVAL PIC of
    // the same tenant. (It is not free to contradict a named one: 0438's R-1.2
    // floor refuses that write outright, asserted at the end of this test.)
    // The tenant is still entitled to see its own thread, so the read answers
    // 200 — but the caller may not decide, and may not read the other PIC's
    // decision either.
    const thread = await buildThread({
      issue: true,
      bind: true,
      bindRival: true,
    });
    const token = await admit(thread);
    const rivalSession = await sessionIdOf(await admit(thread, { tenantPicId: thread.rivalPicId! }));
    await plantDecision(thread, {
      picId: thread.rivalPicId!,
      sessionId: rivalSession,
    });

    const response = await read(token, requestPath(thread.requestId));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.decision.decidedByCaller, false);
    assert.equal(response.body.data.decision.decidedByTenantPicId, thread.rivalPicId);

    // Own-decision read: not mine to read, so it does not exist.
    assertUniform404(
      await read(token, decisionPath(thread.versionId)),
      'another PIC\'s decision',
    );
    assertUniform404(
      await read(token, decisionPath(randomUUID())),
      'unknown version',
    );

    const eligibility = await read(token, eligibilityPath(thread.requestId));
    const reasons = (eligibility.body.data.reasons as Array<{ code: string }>).map(
      reason => reason.code,
    );
    assert.ok(reasons.includes('BINDING_TARGET_DIFFERS'), JSON.stringify(reasons));
    assert.ok(reasons.includes('ALREADY_DECIDED'), JSON.stringify(reasons));
    assert.equal(
      eligibility.body.data.binding.approvalBindingId,
      thread.bindingId,
      'the eligibility answer names the binding it evaluated',
    );
    assert.equal(
      response.body.data.approvalBinding.tenantPicId,
      thread.rivalPicId,
      'the read reports who the binding really confers',
    );
    assert.equal(eligibility.body.data.decisionRecorded, true);
    assert.equal(eligibility.body.data.lineageMatchesCaller, true);

    // The rival, for whom the decision IS its own, reads it.
    const rivalToken = await admit(thread, { tenantPicId: thread.rivalPicId! });
    const own = await read(rivalToken, decisionPath(thread.versionId));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.decidedByCaller, true);
    assert.equal(own.body.data.decision, 'APPROVE');
    // For the rival, the thread is now decided and ineligible — and the only
    // reason left is the one that matters.
    assert.deepEqual(
      await codes(rivalToken, eligibilityPath(thread.requestId)),
      ['ALREADY_DECIDED'],
    );

    // And the state this test had to build around is unreachable by write: a
    // binding may not contradict an attested PIC, so "wrong PIC" can never be
    // created on a threaded-with-lineage request in the first place (R-1.2).
    const lineage = await buildThread({ issue: true, withLineagePic: true });
    const contradiction = await createPic(lineage.tenantCompanyId);
    await assert.rejects(
      () =>
        q(
          `INSERT INTO handyman_quotation_approval_bindings
             (id, quotation_id, handyman_request_id, client_id, tenant_company_id,
              building_id, space_id, tenant_pic_id, binding_version,
              supersedes_binding_id, status, effective_from, effective_until,
              occupancy_authority_id, space_authority_id, granted_by_user_id,
              granted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,NULL,'ACTIVE',NOW(),NULL,$9,$10,$11,NOW())`,
          [
            randomUUID(),
            lineage.quotationId,
            lineage.requestId,
            lineage.clientId,
            lineage.tenantCompanyId,
            lineage.buildingId,
            lineage.spaceId,
            contradiction,
            lineage.occupancyId,
            lineage.spaceAuthorityId,
            adminUserId,
          ],
        ),
      /contradict the PIC already attested on the request/,
      'the write itself is refused, not just the decision',
    );
  });

  it('gives a read-capable credential no decision to call its own', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const signer = await admit(thread);
    await plantDecision(thread, { sessionId: await sessionIdOf(signer) });
    // The deciding PIC reads its own row back, verbatim.
    const own = await read(signer, decisionPath(thread.versionId));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.decidedByCaller, true);
    assert.equal(own.body.data.decidedByTenantPicId, thread.picId);
    assert.ok(
      !('decidedByUserId' in own.body.data),
      'no staff identity in a PIC decision, not even a null placeholder',
    );

    // A read-capable credential of the SAME tenant has no identity for the
    // decision to match, so the answer is the uniform 404 and not "forbidden".
    const readOnly = await admit(thread, { tenantPicId: undefined });
    assertUniform404(
      await read(readOnly, decisionPath(thread.versionId)),
      'read-capable credential',
    );
    assert.equal((await read(readOnly, requestPath(thread.requestId))).status, 200);
    const eligibility = await read(readOnly, eligibilityPath(thread.requestId));
    // Fixed order, from two independent facts, in one read-only answer.
    assert.deepEqual(
      (eligibility.body.data.reasons as Array<{ code: string }>).map(r => r.code),
      ['SESSION_READ_ONLY', 'ALREADY_DECIDED'],
    );
    assert.equal(eligibility.body.data.canDecide, false);
    assert.equal(eligibility.body.data.decisionRecorded, true);
    // A version the caller cannot resolve at all is the same 404.
    assertUniform404(
      await read(signer, decisionPath(randomUUID())),
      'unknown version',
    );
  });
});

// ---------------------------------------------------------------------------
// C. The credential's own state (items 2, 7)
// ---------------------------------------------------------------------------

describe('W03 PART 03D — the credential is re-checked on every read', () => {
  it('loses all three reads at once when the session is revoked', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    // Path 3 answers only when this credential has signed a decision, so plant
    // one first; otherwise the loop below would be asserting a 200 that 03D
    // never promises.
    await plantDecision(thread, { sessionId: await sessionIdOf(token) });
    for (const path of [
      requestPath(thread.requestId),
      eligibilityPath(thread.requestId),
      decisionPath(thread.versionId),
    ]) {
      assert.equal((await read(token, path)).status, 200, path);
    }
    await revokePicWorkspaceSession(token);
    for (const path of [
      requestPath(thread.requestId),
      eligibilityPath(thread.requestId),
      decisionPath(thread.versionId),
    ]) {
      const response = await read(token, path);
      assert.equal(response.status, 401, `${path}: revoked credential still worked`);
      assert.equal(response.body.error.code, UNAUTHORIZED);
    }
    // A revocation is a credential failure, never a 404 in disguise.
    const foreign = await read(token, requestPath(randomUUID()));
    assert.equal(foreign.status, 401, 'authentication precedes existence');
  });

  it('expires against the database clock, including while blocked on a lock', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const previous = process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
    process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = '2';
    const client = await pool!.connect();
    try {
      const shortLived = await admit(thread);
      await client.query('BEGIN');
      // Take the very lock the read wants, so the read waits with a live
      // credential and an expiry that arrives while it waits.
      await client.query(
        `SELECT 1 FROM handyman_quotation_versions WHERE id = $1 FOR UPDATE`,
        [thread.versionId],
      );
      const waiting = read(shortLived, requestPath(thread.requestId));
      await sleep(2_600);
      await client.query('COMMIT');
      const response = await waiting;
      assert.equal(
        response.status,
        401,
        'a credential that expired during a lock wait must not authorize a read',
      );
      assert.equal(response.body.error.code, UNAUTHORIZED);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      if (previous === undefined) {
        delete process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
      } else {
        process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = previous;
      }
    }
  });

  it('refuses a care token, a staff bearer and a foreign PIC token alike', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const careBody = {
      purpose: 'HANDYMAN_CARE_WORKSPACE',
      integrationCode: careCode,
      assertionId: randomUUID(),
      issuedAt: iso(-2),
      expiresAt: iso(120),
      actor: { type: 'CUSTOMER_CARE', actorReference: careActorReference },
    } as unknown as CareWorkspaceAssertion;
    const careAdmitted = await admitCareWorkspace(
      careBody,
      signCareWorkspaceAssertion(careBody, CARE_SECRET),
    );
    const careToken = (careAdmitted as { workspaceToken: string }).workspaceToken;
    assert.ok(careToken.startsWith('hcw_'));
    // A real staff session, with the real grants the portal refuses to use.
    assert.ok(adminToken.length > 10);
    // A PIC credential minted for a different tenant, same shape, valid signing.
    const foreign = await buildForeignThread();
    const foreignToken = await admit(foreign);

    for (const [label, token] of [
      ['care token', careToken],
      ['staff bearer', adminToken],
      ['garbage', 'hpw_' + 'x'.repeat(43)],
    ] as const) {
      const response = await read(token, requestPath(thread.requestId));
      assert.equal(response.status, 401, `${label}: got ${response.status}`);
      assert.equal(response.body.error.code, UNAUTHORIZED, label);
      assert.ok(
        !JSON.stringify(response.body).includes('user_sessions'),
        `${label}: no hint of a fallback`,
      );
    }
    // A live PIC credential belonging to ANOTHER tenant is a real session: it
    // authenticates, and then is told nothing. 404 here is the non-enumerating
    // answer, and it must not be downgraded to 401 just because the tenant
    // differs.
    assertUniform404(
      await read(foreignToken, requestPath(thread.requestId)),
      "another tenant's PIC token",
    );
    assertUniform404(
      await read(foreignToken, eligibilityPath(thread.requestId)),
      "another tenant's PIC token, eligibility",
    );
    // No `authorization` header at all is the same refusal, not a 400.
    const anonymous = await api().get(requestPath(thread.requestId));
    assert.equal(anonymous.status, 401);
  });

  it('drops the read the moment the authority that minted it lapses', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    assert.equal((await read(token, requestPath(thread.requestId))).status, 200);
    await q(`UPDATE tenant_pics SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [
      thread.picId,
    ]);
    const after = await read(token, requestPath(thread.requestId));
    assert.equal(after.status, 401, JSON.stringify(after.body));
    assert.equal(after.body.error.code, UNAUTHORIZED);
    // Which is why no eligibility reason can ever name a lapsed PIC: the
    // credential is gone before a reason is computed. Fail-closed, not reported.
  });
});

// ---------------------------------------------------------------------------
// D. Eligibility, as the ledger will enforce it (items 6, 7)
// ---------------------------------------------------------------------------

describe('W03 PART 03D — read-only approval eligibility', () => {
  it('reports an eligible thread as eligible, and never as a reservation', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const response = await read(token, eligibilityPath(thread.requestId));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.eligible, true, JSON.stringify(data.reasons));
    assert.deepEqual(data.reasons, []);
    assert.equal(data.canDecide, true);
    assert.equal(data.versionStatus, 'ISSUED');
    assert.equal(data.decisionRecorded, false);
    assert.equal(data.lineageMatchesCaller, true);
    assert.equal(data.quotationVersionId, thread.versionId);
    assert.equal(data.binding.approvalBindingId, thread.bindingId);
    // The contract sentence a frontend must read before wiring a button.
    assert.equal(data.guaranteesDecision, false);
    assert.match(data.validUntil as string, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(response.headers['cache-control'], 'no-store');
    // No identifier of anyone: the payload is ids of the caller's own thread
    // plus codes; no user ids appear except the granter id the binding read is
    // contracted to expose.
    const serialized = JSON.stringify(data.reasons);
    assert.ok(!UUID_PATTERN.test(serialized), 'reasons carry no ids');
  });

  it('explains a missing binding, a revoked binding and a lapsed window', async (t) => {
    if (!requireDatabase(t)) return;
    // No binding at all (B12 is not enabled, so such a thread exists in practice).
    const unbound = await buildThread({ issue: true });
    const unboundToken = await admit(unbound);
    assert.deepEqual(
      await codes(unboundToken, eligibilityPath(unbound.requestId)),
      ['NO_ACTIVE_APPROVAL_BINDING'],
    );

    // Revoked: the same code, and no detail about who revoked it or when.
    const revoked = await buildThread({ issue: true, bind: true });
    const revokedToken = await admit(revoked);
    await q(
      `UPDATE handyman_quotation_approval_bindings
          SET status = 'REVOKED', revoked_at = NOW(), revoked_by_user_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [revoked.bindingId, adminUserId],
    );
    const revokedResponse = await read(revokedToken, eligibilityPath(revoked.requestId));
    assert.deepEqual(
      (revokedResponse.body.data.reasons as Array<{ code: string }>).map(r => r.code),
      ['NO_ACTIVE_APPROVAL_BINDING'],
    );
    assert.equal(revokedResponse.body.data.binding, null);
    // The thread itself remains readable: revoking authority is not deleting
    // the commercial fact that was presented.
    assert.equal((await read(revokedToken, requestPath(revoked.requestId))).status, 200);

    // A binding whose window lapses while the version is still presented:
    // a distinct code, because "in force once" is a different state to fix.
    const lapsed = await buildThread({
      issue: true,
      bind: true,
      bindingUntilSeconds: 2,
    });
    const lapsedToken = await admit(lapsed);
    assert.deepEqual(await codes(lapsedToken, eligibilityPath(lapsed.requestId)), []);
    await sleep(2_600);
    assert.deepEqual(
      await codes(lapsedToken, eligibilityPath(lapsed.requestId)),
      ['BINDING_WINDOW_LAPSED'],
    );
  });

  it('reports an expired presentation and a recorded decision', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    assert.deepEqual(await codes(token, eligibilityPath(thread.requestId)), []);
    await q(
      `UPDATE handyman_quotation_versions
          SET valid_until = NOW() - interval '60 seconds', updated_at = NOW()
        WHERE id = $1`,
      [thread.versionId],
    );
    assert.deepEqual(
      await codes(token, eligibilityPath(thread.requestId)),
      ['VERSION_EXPIRED'],
    );

    const decided = await buildThread({ issue: true, bind: true });
    const decidedToken = await admit(decided);
    await plantDecision(decided, { sessionId: await sessionIdOf(decidedToken) });
    const reasons = await codes(decidedToken, eligibilityPath(decided.requestId));
    assert.deepEqual(reasons, ['ALREADY_DECIDED']);
    const eligibility = await read(decidedToken, eligibilityPath(decided.requestId));
    assert.equal(eligibility.body.data.decisionRecorded, true);
    // A decided thread is frozen (B18): the read still shows the fact, and the
    // decision is the caller's own to read exactly now.
    const own = await read(decidedToken, decisionPath(decided.versionId));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.decidedByCaller, true);
    assert.equal(own.body.data.decisionActorType, 'TENANT_PIC');
    assert.equal(own.body.data.approvalBindingId, decided.bindingId);
    assert.ok(own.body.data.decidedByPicSessionId, 'the ledger records the credential');
    assert.equal(
      own.body.data.decidedByPicSessionId,
      await sessionIdOf(decidedToken),
    );
  });

  it('sees a maker-checker conflict that the ledger would refuse (MC1′)', async (t) => {
    if (!requireDatabase(t)) return;
    // The thread's authoring user is linked to the prospective approver: M ∩ C
    // is non-empty, and this is the ONLY way the two id namespaces can meet.
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    assert.deepEqual(await codes(token, eligibilityPath(thread.requestId)), []);
    await q(
      `UPDATE tenant_pics SET user_id = $2, updated_at = NOW() WHERE id = $1`,
      [thread.picId, adminUserId],
    );
    // The link change revokes live sessions (rule 18), so the caller must be
    // re-admitted — and the fresh credential still sees the conflict.
    const fresh = await admit(thread);
    const reasons = await codes(fresh, eligibilityPath(thread.requestId));
    assert.deepEqual(reasons, ['MAKER_CHECKER_CONFLICT']);
    const detail = await read(fresh, eligibilityPath(thread.requestId));
    // ...without saying who: the message must not name the author.
    assert.ok(!JSON.stringify(detail.body.data).includes(adminUserId), JSON.stringify(detail.body.data));
    // The unlinked case is the MC4 residual, and it is NOT a refusal: the ledger
    // cannot prove distinctness from a NULL, and neither can this read.
    await q(`UPDATE tenant_pics SET user_id = NULL, updated_at = NOW() WHERE id = $1`, [
      thread.picId,
    ]);
    const unlinked = await admit(thread);
    assert.deepEqual(await codes(unlinked, eligibilityPath(thread.requestId)), []);
  });

  it('reports an inactive client without pretending the read is unauthorized', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    await q(`UPDATE clients SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [
      thread.clientId,
    ]);
    const response = await read(token, eligibilityPath(thread.requestId));
    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body.data.reasons as Array<{ code: string }>).map(r => r.code),
      ['TENANT_OR_CLIENT_NOT_ACTIVE'],
    );
    assert.equal((await read(token, requestPath(thread.requestId))).status, 200);
    await q(`UPDATE clients SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [
      thread.clientId,
    ]);
    assert.deepEqual(await codes(token, eligibilityPath(thread.requestId)), []);
  });

  it('refuses to be a lease: no write, no state, second call answers again', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const sessionsBefore = await q(`SELECT count(*)::int AS n FROM ${SESSION_TABLE}`);
    const journalBefore = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE event_type LIKE 'HANDYMAN_PIC_%'`,
    );
    const first = await read(token, eligibilityPath(thread.requestId));
    const second = await read(token, eligibilityPath(thread.requestId));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const { evaluatedAt: at1, ...stable1 } = first.body.data;
    const { evaluatedAt: at2, ...stable2 } = second.body.data;
    assert.deepEqual(stable1, stable2, 'the same facts answer the same way');
    assert.notEqual(at1, at2, 'and neither answer is cached');
    const sessionsAfter = await q(`SELECT count(*)::int AS n FROM ${SESSION_TABLE}`);
    assert.equal(sessionsAfter.rows[0].n, sessionsBefore.rows[0].n, 'no session side effect');
    const journalAfter = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE event_type LIKE 'HANDYMAN_PIC_%'`,
    );
    assert.deepEqual(journalAfter.rows[0].n, journalBefore.rows[0].n, 'a read journals nothing');
    // And an eligibility report that said "eligible" does not survive the facts
    // changing: it was never a claim about the future.
    await q(
      `UPDATE handyman_quotation_approval_bindings SET status = 'REVOKED',
              revoked_at = NOW(), revoked_by_user_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [thread.bindingId, adminUserId],
    );
    const third = await read(token, eligibilityPath(thread.requestId));
    assert.equal(third.body.data.eligible, false);
  });
});

// ---------------------------------------------------------------------------
// E. The pure predicate, so the matrix is exhaustive without a database
// ---------------------------------------------------------------------------

describe('W03 PART 03D — the eligibility predicate itself', () => {
  const now = new Date('2026-10-11T00:00:00.000Z');
  const ok = (over: Partial<PicPortalEligibilityInput> = {}): PicPortalEligibilityInput => ({
    now,
    canDecide: true,
    callerPicId: 'pic-1',
    callerPicUserId: null,
    lineageRequestPicId: null,
    tenantStatus: 'ACTIVE',
    clientStatus: 'ACTIVE',
    occupancyStatus: 'ACTIVE',
    binding: {
      tenantPicId: 'pic-1',
      grantedByUserId: 'staff-9',
      effectiveFrom: new Date(now.getTime() - 60_000),
      effectiveUntil: null,
    },
    version: {
      status: 'ISSUED',
      validUntil: new Date(now.getTime() + 600_000),
      decisionRecorded: false,
      rootAuthorUserId: 'staff-1',
      versionAuthorUserId: 'staff-1',
    },
    ...over,
  });

  it('accepts exactly one coherent fact-set and refuses each break', () => {
    assert.deepEqual(evaluatePicApprovalEligibility(ok()), []);
    const cases: Array<[string, Partial<PicPortalEligibilityInput>, PicPortalEligibilityCode]> = [
      ['read-only credential', { canDecide: false, callerPicId: null }, 'SESSION_READ_ONLY'],
      ['read-only credential, other PIC bound', {
        canDecide: false,
        callerPicId: null,
        binding: {
          tenantPicId: 'pic-2',
          grantedByUserId: 'staff-9',
          effectiveFrom: null,
          effectiveUntil: null,
        },
        lineageRequestPicId: 'pic-3',
      }, 'SESSION_READ_ONLY'],
      ['no binding', { binding: null }, 'NO_ACTIVE_APPROVAL_BINDING'],
      ['window ended', {
        binding: {
          tenantPicId: 'pic-1',
          grantedByUserId: 'staff-9',
          effectiveFrom: new Date(now.getTime() - 60_000),
          effectiveUntil: new Date(now.getTime() - 1),
        },
      }, 'BINDING_WINDOW_LAPSED'],
      ['window not started', {
        binding: {
          tenantPicId: 'pic-1',
          grantedByUserId: 'staff-9',
          effectiveFrom: new Date(now.getTime() + 60_000),
          effectiveUntil: null,
        },
      }, 'BINDING_WINDOW_LAPSED'],
      ['bound to another PIC', {
        binding: {
          tenantPicId: 'pic-2',
          grantedByUserId: 'staff-9',
          effectiveFrom: new Date(now.getTime() - 60_000),
          effectiveUntil: null,
        },
      }, 'BINDING_TARGET_DIFFERS'],
      ['lineage names another PIC', { lineageRequestPicId: 'pic-2' }, 'LINEAGE_PIC_DIFFERS'],
      ['client inactive', { clientStatus: 'INACTIVE' }, 'TENANT_OR_CLIENT_NOT_ACTIVE'],
      ['tenant missing', { tenantStatus: null }, 'TENANT_OR_CLIENT_NOT_ACTIVE'],
      ['occupancy lapsed', { occupancyStatus: 'EXPIRED' }, 'OCCUPANCY_NOT_CURRENT'],
      ['occupancy row gone', { occupancyStatus: 'MISSING' }, 'OCCUPANCY_NOT_CURRENT'],
      ['no version', { version: null }, 'VERSION_NOT_ISSUED'],
      ['version superseded', {
        version: {
          status: 'SUPERSEDED',
          validUntil: new Date(now.getTime() + 600_000),
          decisionRecorded: false,
          rootAuthorUserId: 'staff-1',
          versionAuthorUserId: 'staff-1',
        },
      }, 'VERSION_NOT_ISSUED'],
      ['no validity window', {
        version: {
          status: 'ISSUED',
          validUntil: null,
          decisionRecorded: false,
          rootAuthorUserId: 'staff-1',
          versionAuthorUserId: 'staff-1',
        },
      }, 'VERSION_VALID_UNTIL_MISSING'],
      ['past its window', {
        version: {
          status: 'ISSUED',
          validUntil: new Date(now.getTime()),
          decisionRecorded: false,
          rootAuthorUserId: 'staff-1',
          versionAuthorUserId: 'staff-1',
        },
      }, 'VERSION_EXPIRED'],
      ['already decided', {
        version: {
          status: 'ISSUED',
          validUntil: new Date(now.getTime() + 600_000),
          decisionRecorded: true,
          rootAuthorUserId: 'staff-1',
          versionAuthorUserId: 'staff-1',
        },
      }, 'ALREADY_DECIDED'],
      ['approver wrote the root', { callerPicUserId: 'staff-1' }, 'MAKER_CHECKER_CONFLICT'],
      ['approver wrote the version', {
        callerPicUserId: 'staff-2',
        version: {
          status: 'ISSUED',
          validUntil: new Date(now.getTime() + 600_000),
          decisionRecorded: false,
          rootAuthorUserId: 'staff-1',
          versionAuthorUserId: 'staff-2',
        },
      }, 'MAKER_CHECKER_CONFLICT'],
      ['approver granted the binding', {
        callerPicUserId: 'staff-9',
      }, 'MAKER_CHECKER_CONFLICT'],
    ];
    for (const [label, over, expected] of cases) {
      const reasons = evaluatePicApprovalEligibility(ok(over));
      assert.ok(reasons.includes(expected), `${label}: got ${JSON.stringify(reasons)}`);
      if (expected === 'SESSION_READ_ONLY' && reasons.length > 1 && label.includes('other PIC')) {
        assert.deepEqual(
          reasons,
          ['SESSION_READ_ONLY'],
          'no comparison against a NULL identity is reported',
        );
      }
    }
  });

  it('is deterministic, complete, and refuses to name a person', () => {
    const all = new Set<PicPortalEligibilityCode>(
      PIC_PORTAL_ELIGIBILITY_CODES,
    );
    assert.equal(
      all.size,
      Object.keys(PIC_PORTAL_ELIGIBILITY_MESSAGES).length,
      'every code has one message and every message has a code',
    );
    // Every code is reachable, or it should not be in the contract.
    const reachable = new Set<PicPortalEligibilityCode>();
    const inputs: Array<Partial<PicPortalEligibilityInput>> = [
      { canDecide: false, callerPicId: null },
      { binding: null },
      {
        binding: {
          tenantPicId: 'pic-1',
          grantedByUserId: 'staff-9',
          effectiveFrom: null,
          effectiveUntil: new Date('2020-01-01T00:00:00.000Z'),
        },
      },
      {
        binding: {
          tenantPicId: 'pic-2',
          grantedByUserId: 'staff-9',
          effectiveFrom: null,
          effectiveUntil: null,
        },
      },
      { lineageRequestPicId: 'other' },
      { clientStatus: null },
      { occupancyStatus: 'INACTIVE' },
      { version: null },
      {
        version: {
          status: 'DRAFT', validUntil: null, decisionRecorded: false,
          rootAuthorUserId: 'a', versionAuthorUserId: 'a',
        },
      },
      {
        version: {
          status: 'ISSUED',
          validUntil: new Date('2020-01-01T00:00:00.000Z'),
          decisionRecorded: false,
          rootAuthorUserId: 'a',
          versionAuthorUserId: 'a',
        },
      },
      {
        version: {
          status: 'ISSUED',
          validUntil: new Date('2020-01-01T00:00:00.000Z'),
          decisionRecorded: true,
          rootAuthorUserId: 'a',
          versionAuthorUserId: 'a',
        },
      },
      { callerPicUserId: 'staff-1' },
    ];
    for (const over of inputs) {
      for (const code of evaluatePicApprovalEligibility(ok(over))) reachable.add(code);
    }
    assert.deepEqual(
      [...all].sort(),
      [...reachable].sort(),
      `unreachable codes: ${[...all].filter(c => !reachable.has(c)).join(', ')}`,
    );
    // Order is part of the contract: credential first, thread state last-but-one,
    // maker-checker absolutely last.
    const everything = evaluatePicApprovalEligibility(
      ok({
        canDecide: false,
        callerPicId: null,
        binding: null,
        lineageRequestPicId: 'someone-else',
        tenantStatus: 'INACTIVE',
        occupancyStatus: 'MISSING',
        version: null,
      }),
    );
    assert.deepEqual(everything, [
      'SESSION_READ_ONLY', 'NO_ACTIVE_APPROVAL_BINDING',
      'TENANT_OR_CLIENT_NOT_ACTIVE', 'OCCUPANCY_NOT_CURRENT', 'VERSION_NOT_ISSUED',
    ]);
    // A read-only caller is never told the binding "differs": it has no
    // identity to differ from, and `SESSION_READ_ONLY` is the whole answer.
    assert.deepEqual(
      evaluatePicApprovalEligibility(
        ok({ canDecide: false, callerPicId: null, lineageRequestPicId: 'someone-else' }),
      ),
      ['SESSION_READ_ONLY'],
    );
    for (const [code, message] of Object.entries(PIC_PORTAL_ELIGIBILITY_MESSAGES)) {
      assert.ok(message.length > 20, `${code} has an empty sentence`);
      // No identifiers, no amounts, no contact-shaped text.
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message) &&
          !/@/.test(message) &&
          !/Rp|IDR|USD|\d{3,}/.test(message),
        `${code} leaks a detail it should not: ${message}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// F. Structure: what this surface is NOT (items 1, 5, 12, release safety)
// ---------------------------------------------------------------------------

describe('W03 PART 03D — the read is authorized by the credential, not by a grant', () => {
  const moduleDir = join(process.cwd(), 'src/modules/handyman-pic-portal');
  const sources = () =>
    ['pic-portal.routes.ts', 'pic-portal.service.ts', 'pic-portal.repository.ts']
      .map(file => readFileSync(join(moduleDir, file), 'utf8'))
      // Comments may name what the code must not call; the gate reads code.
      .map(text =>
        text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
          .join('\n'),
      )
      .join('\n');

  it('references neither the staff building predicate nor any tenant grant (no-C6-reuse)', () => {
    const code = sources();
    for (const forbidden of [
      'user_building_assignments',
      'assertBuildingScopedResourceAccess',
      'buildingAccessDeniedError',
      'tenant_company.read',
      'tenant_company.manage',
      'requirePermission',
      'authenticationMiddleware',
      'req.auth',
      'buildingAssignment',
      'getHandymanQuotation(',
      'listHandymanQuotationVersionLines',
      'getHandymanQuotationVersionTotals',
      'getHandymanQuotationDecision',
      'getCurrentHandymanIssuedQuotationVersion',
      'resolveSessionContext',
      'user_sessions',
      'handyman_care_workspace_sessions',
      'handyman_handoff_exchanges',
    ]) {
      assert.ok(
        !code.includes(forbidden),
        `03D must not reach for "${forbidden}" — that is the staff/C6 or care surface`,
      );
    }
    // And the C6 helper it refuses to use is still what the staff path uses, so
    // this PART has not quietly moved the staff door instead of opening its own.
    const staffAccess = readFileSync(
      join(process.cwd(), 'src/modules/handyman-quotations/handyman-quotation-access.ts'),
      'utf8',
    );
    assert.match(staffAccess, /assertBuildingScopedResourceAccess/);
  });

  it('ships exactly three GETs, no mutation, and no decide path', () => {
    const code = sources();
    assert.equal((code.match(/router\.get\(/g) ?? []).length, 3);
    for (const verb of ['router.post(', 'router.put(', 'router.patch(', 'router.delete(']) {
      assert.ok(!code.includes(verb), `03D must not register ${verb}`);
    }
    assert.match(code, /\/handyman\/pic\/requests\/:handymanRequestId/);
    assert.match(code, /\/handyman\/pic\/requests\/:handymanRequestId\/approval-eligibility/);
    assert.match(code, /\/handyman\/pic\/quotation-versions\/:quotationVersionId\/decision/);
    // The handlers pass `req.body` to the bearer reader only, to reject it; they
    // never read a field out of it, and no decision write is reachable here.
    assert.ok(!/req\.body\.[A-Za-z]/.test(code), 'a request body must never be a source of input');
    for (const write of [
      'decideHandymanQuotation',
      'recordHandymanQuotationDecision',
      'issueHandymanQuotationVersion',
      'revokeHandymanQuotationApprovalBinding',
    ]) {
      assert.ok(!code.includes(write), `03D must not call ${write}`);
    }
    // The reads are SELECT-only over the ledgers they touch.
    const repository = readFileSync(join(moduleDir, 'pic-portal.repository.ts'), 'utf8');
    for (const write of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+handyman_/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
    ]) {
      assert.ok(!write.test(repository), `the portal repository must never write ${write}`);
    }
    assert.ok(!/handyman_execution_scopes/.test(repository), 'no Execution Scope read');
  });

  it('leaves the staff decide path exactly as closed as it was (B12 OFF, no fallback)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    await assert.rejects(
      () => decideHandymanQuotation(thread.versionId, {
        decision: 'APPROVE',
        idempotencyKey: `03d-${randomUUID()}`,
      }, adminUserId),
      (error: unknown) => {
        const message = (error as Error).message ?? '';
        assert.match(
          message,
          /Only an attested Tenant PIC may decide a Handyman quotation\./,
        );
        return true;
      },
      'a staff principal must still be refused by the ledger floor',
    );
    // And 03D did not add a way around it: no route on this surface can decide.
    const attempted = await api()
      .post(requestPath(thread.requestId))
      .set('authorization', `Bearer ${await admit(thread)}`)
      .send({ decision: 'APPROVE' });
    assert.ok(attempted.status === 404 || attempted.status === 405, String(attempted.status));
  });

  it('keeps the ledger and Execution Scope untouched by the read', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const before = await q(
      `SELECT (SELECT count(*) FROM handyman_quotation_decisions)::int AS decisions,
              (SELECT count(*) FROM handyman_execution_scopes)::int AS scopes,
              (SELECT count(*) FROM handyman_quotation_approval_bindings)::int AS bindings,
              (SELECT count(*) FROM ${SESSION_TABLE})::int AS sessions`,
    );
    await read(token, requestPath(thread.requestId));
    await read(token, eligibilityPath(thread.requestId));
    await read(token, decisionPath(thread.versionId));
    const after = await q(
      `SELECT (SELECT count(*) FROM handyman_quotation_decisions)::int AS decisions,
              (SELECT count(*) FROM handyman_execution_scopes)::int AS scopes,
              (SELECT count(*) FROM handyman_quotation_approval_bindings)::int AS bindings,
              (SELECT count(*) FROM ${SESSION_TABLE})::int AS sessions`,
    );
    assert.deepEqual(after.rows[0], before.rows[0], 'three reads moved nothing');
    assert.equal(after.rows[0].decisions, before.rows[0].decisions);
  });
});
