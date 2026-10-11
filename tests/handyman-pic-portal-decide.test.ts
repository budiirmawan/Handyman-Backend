import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parse as yamlLoad } from 'yaml';
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
import { handymanExecutionScopeRepository } from '../src/modules/handyman-quotations/handyman-execution-scope.repository';
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
 * W03 PART 03E — Tenant PIC quotation decision authority (CR-HM-06/A01 v1.1
 * §6.2/§9/§13 `03E`, §8 MC1′–MC3, §10.3 C1/C2/C4/C5/C12/C13/C15, ADD-A B11/B16/
 * B17/B18/R-1.1; migrations 0438/0439/0441/0442 from 03A/03C supply the ledger
 * actor columns and the session link, so this PART writes NO migration).
 *
 * The owner ratified BLK-4 as **S1** on 2026-10-11: customer-only approval
 * authority. So this file tests two things at once, and both halves are the
 * contract —
 *
 *   - the PIC arm: APPROVE and REJECT recorded by an authenticated Tenant PIC
 *     into the EXISTING ledger, with the binding, the PIC and the credential as
 *     recorded facts, an Execution Scope created by the same APPROVE branch that
 *     always created it, and refusals for every way the authority can fail (wrong
 *     PIC, no binding, lapsed window, read-only credential, revoked session,
 *     maker-checker, foreign thread, replay by a stranger, a second decision, a
 *     concurrent double submit);
 *   - the staff arm: closed with a controlled 403 plus `Deprecation`/`Link`,
 *     never a 500 and never a silent success — and history untouched, because a
 *     `USER` row that already exists is evidence, not a bug to backfill.
 *
 * Everything runs against a LIVE app over a LIVE server: this suite boots its own
 * embedded PostgreSQL (55562) and `t.skip`s rather than pretending. Release safety
 * is asserted structurally as well as behaviourally: the B12 ISSUE gate stays OFF
 * (a thread can be issued with no binding at all — the fixtures rely on it),
 * nothing auto-binds, no second ledger appears, `C6` is not widened, and the
 * portal never writes SQL of its own.
 */

const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const DATA_DIR = '/tmp/asentra-w03-03e-pg';
const DB_PORT = 55562;
const SECRET = 'pic-portal-decide-integration-secret-0444';
const CARE_SECRET = 'care-secret-that-the-pic-must-never-accept-0444';
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

  integrationCode = `P03E_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode,
    displayName: '03E PIC attesting integration',
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: integration.id,
    capability: 'TENANT_PIC',
  });
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = SECRET;

  careCode = `C03E_${suffix()}`;
  const care = await handoffRuntimeRepository.createIntegration({
    integrationCode: careCode,
    displayName: '03E care integration (confusion control)',
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: care.id,
    capability: 'CUSTOMER_CARE',
  });
  careActorReference = `care-03e-${suffix()}`;
  await handymanCareActorService.createCareActor({
    integrationId: care.id,
    actorReference: careActorReference,
    displayName: '03E care actor',
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
    name: '03E Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A${clientKey}`,
    name: '03E Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R${clientKey}`,
    name: '03E Room',
  });
  return spaceService.createSpace({
    roomId: room.id,
    code: `S${clientKey}`,
    name: '03E Space',
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
 * staff service would, because 03E reads the binding and must not own its write
 * path (that is B8's staff surface).
 */
async function buildThread(options: ThreadOptions = {}): Promise<Thread> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `S03D${tag}`,
    name: `03E Client ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P03D${tag}`,
    name: '03E Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B03D${tag}`,
    name: '03E Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const space = await createSpaceIn(building.id, `${tag}A`);
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `T03D${tag}`, tenantName: `03E Tenant ${tag}` },
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
      name: '03E Other Building',
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
      name: '03E Service',
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
      triageNote: '03E fixture triage.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: '03E fixture diagnosis.',
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
// The write itself: what a decision looks like from the outside, and what the
// ledger, the scope table and the journal actually contain.
// ---------------------------------------------------------------------------

const staffPath = (versionId: string) =>
  `/api/v1/handyman/quotation-versions/${versionId}/decision`;

const decide = (
  token: string,
  versionId: string,
  body: unknown,
  idempotencyKey?: string,
) => {
  const request = api()
    .post(decisionPath(versionId))
    .set('authorization', `Bearer ${token}`);
  if (idempotencyKey !== undefined) request.set('Idempotency-Key', idempotencyKey);
  return request.send(body as never);
};

const ledgerRowOf = async (versionId: string) =>
  (
    await q(
      `SELECT id, decision, decision_actor_type, decided_by_user_id,
              decided_by_tenant_pic_id, decided_by_pic_session_id,
              approval_binding_id, tenant_company_id, tenant_pic_id,
              idempotency_key, request_fingerprint, decided_at
         FROM handyman_quotation_decisions WHERE quotation_version_id = $1`,
      [versionId],
    )
  ).rows[0] as Record<string, string | null> | undefined;

const scopeRowOf = async (versionId: string) =>
  (
    await q(
      `SELECT id, status, created_by_user_id, created_by_actor_type,
              created_by_tenant_pic_id, created_by_pic_session_id,
              tenant_company_id, tenant_pic_id, quotation_decision_id,
              building_id, space_id
         FROM handyman_execution_scopes WHERE approved_quotation_version_id = $1`,
      [versionId],
    )
  ).rows[0] as Record<string, string | null> | undefined;

const versionStatusOf = async (versionId: string) =>
  (
    await q(`SELECT status FROM handyman_quotation_versions WHERE id = $1`, [versionId])
  ).rows[0]?.status as string | undefined;

/**
 * Journal probe, filtered to the event types THIS PART writes. A version row
 * accumulates events over its life (`…LINE_ADDED`, `…VERSION_ISSUED`), so an
 * unfiltered count would measure the fixture rather than the decision.
 */
const eventsOf = async (
  entityId: string,
  entityType: string,
  eventTypes: string[],
) =>
  (
    await q(
      `SELECT event_type, actor_user_id, metadata::text AS metadata
         FROM operational_events
        WHERE entity_type = $1 AND entity_id = $2
          AND event_type = ANY($3::text[])
        ORDER BY created_at, id`,
      [entityType, entityId, eventTypes],
    )
  ).rows as Array<{ event_type: string; actor_user_id: string | null; metadata: string }>;

const counts = async () =>
  (
    await q(
      `SELECT (SELECT count(*) FROM handyman_quotation_decisions)::int AS decisions,
              (SELECT count(*) FROM handyman_execution_scopes)::int AS scopes,
              (SELECT count(*) FROM handyman_quotation_approval_bindings)::int AS bindings`,
    )
  ).rows[0] as { decisions: number; scopes: number; bindings: number };

/** Observe the real PostgreSQL wait, rather than guessing when HTTP reached it. */
async function waitForDecisionLock(blockerPid: number, queryFragment: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const waiting = await q(
      `SELECT 1 FROM pg_stat_activity
        WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
      [blockerPid, `%${queryFragment}%`],
    );
    if (waiting.rowCount) return;
    await sleep(10);
  } while (Date.now() < deadline);
  assert.fail(`decision did not reach the expected lock: ${queryFragment}`);
}

async function assertNoDecisionEffects(thread: Thread): Promise<void> {
  assert.equal(await ledgerRowOf(thread.versionId), undefined);
  assert.equal(await scopeRowOf(thread.versionId), undefined);
  assert.equal(await versionStatusOf(thread.versionId), 'ISSUED');
  const events = await q(
    `SELECT event_type FROM operational_events
      WHERE metadata->>'quotationVersionId' = $1
        AND event_type IN ('HANDYMAN_QUOTATION_APPROVED',
                           'HANDYMAN_QUOTATION_REJECTED', 'HANDYMAN_EXECUTION_SCOPE_CREATED')`,
    [thread.versionId],
  );
  assert.equal(events.rowCount, 0, 'a refusal leaves no decision or scope journal');
}

describe('W03 PART 03E — the Tenant PIC decision write', () => {
  it('records an APPROVE as a TENANT_PIC decision and creates the scope in the same transaction', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true, withLineagePic: true });
    const token = await admit(thread);
    const sessionId = await sessionIdOf(token);

    const response = await decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-approve-${randomUUID()}`);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data as {
      decision: Record<string, unknown>;
      executionScope: Record<string, unknown> | null;
    };
    assert.equal(data.decision.decision, 'APPROVE');
    assert.equal(data.decision.decisionActorType, 'TENANT_PIC');
    assert.equal(data.decision.decidedByTenantPicId, thread.picId);
    assert.equal(data.decision.decidedByPicSessionId, sessionId);
    assert.equal(data.decision.approvalBindingId, thread.bindingId);
    assert.equal(data.decision.decidedByCaller, true);
    // §9: a PIC-facing decision view has no `decidedByUserId` key at all — not a
    // null placeholder, because a key that can only ever be null here invites a
    // consumer to go looking for the staff actor that does not exist.
    assert.ok(!('decidedByUserId' in data.decision), JSON.stringify(data.decision));
    assert.ok(data.executionScope, 'APPROVE returns the scope it created');
    assert.equal(data.executionScope!.status, 'AUTHORIZED');
    assert.equal(data.executionScope!.approvedQuotationVersionId, thread.versionId);
    assert.equal(data.executionScope!.buildingId, thread.buildingId);
    assert.equal(data.executionScope!.spaceId, thread.spaceId);
    // F9/C16 minimization on the write response: the approval half and the staff
    // provenance are absent, not null.
    for (const forbidden of [
      'createdByUserId',
      'tenantCompanyId',
      'tenantPicId',
      'channelAttributionId',
      'quotationDecisionId',
      'createdByActorType',
    ]) {
      assert.ok(!(forbidden in data.executionScope!), `no ${forbidden} on a PIC scope view`);
    }

    const ledger = await ledgerRowOf(thread.versionId);
    assert.ok(ledger);
    assert.equal(ledger.decision_actor_type, 'TENANT_PIC');
    assert.equal(ledger.decided_by_user_id, null, 'no staff user is invented for a PIC decision');
    assert.equal(ledger.decided_by_tenant_pic_id, thread.picId);
    assert.equal(ledger.decided_by_pic_session_id, sessionId);
    assert.equal(ledger.approval_binding_id, thread.bindingId);
    assert.equal(ledger.tenant_company_id, thread.tenantCompanyId);
    assert.equal(ledger.tenant_pic_id, thread.lineagePicId ?? thread.picId);

    const scope = await scopeRowOf(thread.versionId);
    assert.ok(scope, 'APPROVE created the Execution Scope');
    assert.equal(scope!.created_by_actor_type, 'TENANT_PIC');
    assert.equal(scope!.created_by_user_id, null, 'E1: a PIC approval fabricates no staff creator');
    assert.equal(scope!.created_by_tenant_pic_id, ledger!.decided_by_tenant_pic_id, 'E2');
    assert.equal(scope!.created_by_pic_session_id, sessionId);
    assert.equal(scope!.quotation_decision_id, ledger!.id);
    assert.equal(scope!.tenant_company_id, thread.tenantCompanyId);
    assert.equal(scope!.building_id, thread.buildingId, 'the location snapshot still holds');
    assert.equal(await versionStatusOf(thread.versionId), 'APPROVED');

    // C12: the journal keeps the event names, loses the imaginary staff actor, and
    // gains the actor facts in metadata instead.
    const events = await eventsOf(thread.versionId, 'HANDYMAN_QUOTATION_VERSION', [
      'HANDYMAN_QUOTATION_APPROVED',
      'HANDYMAN_QUOTATION_REJECTED',
    ]);
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.equal(events[0].event_type, 'HANDYMAN_QUOTATION_APPROVED');
    assert.equal(events[0].actor_user_id, null);
    const metadata = JSON.parse(events[0].metadata) as Record<string, string>;
    assert.equal(metadata.decisionActorType, 'TENANT_PIC');
    assert.equal(metadata.decidedByTenantPicId, thread.picId);
    assert.equal(metadata.sessionId, sessionId);
    assert.equal(metadata.approvalBindingId, thread.bindingId);
    const scopeEvents = await eventsOf(String(scope!.id), 'HANDYMAN_EXECUTION_SCOPE', [
      'HANDYMAN_EXECUTION_SCOPE_CREATED',
    ]);
    assert.equal(scopeEvents.length, 1);
    assert.equal(scopeEvents[0].event_type, 'HANDYMAN_EXECUTION_SCOPE_CREATED');
    assert.equal(scopeEvents[0].actor_user_id, null);
  });

  it('records a REJECT and creates nothing downstream (E5)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const response = await decide(token, thread.versionId, { decision: 'REJECT' }, `03e-reject-${randomUUID()}`);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.decision.decision, 'REJECT');
    assert.equal(response.body.data.executionScope, null);
    assert.equal(await scopeRowOf(thread.versionId), undefined, 'a REJECT never authorizes work');
    assert.equal(await versionStatusOf(thread.versionId), 'REJECTED');
    const ledger = await ledgerRowOf(thread.versionId);
    assert.equal(ledger!.decision_actor_type, 'TENANT_PIC');
    const events = await eventsOf(thread.versionId, 'HANDYMAN_QUOTATION_VERSION', [
      'HANDYMAN_QUOTATION_APPROVED',
      'HANDYMAN_QUOTATION_REJECTED',
    ]);
    assert.deepEqual(events.map(e => e.event_type), ['HANDYMAN_QUOTATION_REJECTED']);
    assert.equal(events[0].actor_user_id, null);
  });

  it("replays the caller's own key and decision without writing a second row", async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const key = `03e-replay-${randomUUID()}`;
    const first = await decide(token, thread.versionId, { decision: 'APPROVE' }, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const ledger = await ledgerRowOf(thread.versionId);
    const before = await counts();

    // A retry after a lost response, and a retry from a SECOND credential of the
    // same PIC: both must return the ORIGINAL facts, including the session that
    // recorded it — replay is not a rewrite.
    const replay = await decide(token, thread.versionId, { decision: 'APPROVE' }, key);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.deepEqual(replay.body.data, first.body.data, 'a replay is byte-identical');
    const otherSessionToken = await admit(thread);
    assert.notEqual(otherSessionToken, token, 'the fixture really has two credentials');
    const crossCredential = await decide(
      otherSessionToken,
      thread.versionId,
      { decision: 'APPROVE' },
      key,
    );
    assert.equal(crossCredential.status, 201, JSON.stringify(crossCredential.body));
    assert.equal(
      crossCredential.body.data.decision.decidedByPicSessionId,
      await sessionIdOf(token),
      'the replay reports who originally decided, never the retrying session',
    );

    const after = await counts();
    assert.deepEqual(after, before, 'a replay writes nothing');
    assert.deepEqual(await ledgerRowOf(thread.versionId), ledger);
    assert.equal(
      (await eventsOf(thread.versionId, 'HANDYMAN_QUOTATION_VERSION', ['HANDYMAN_QUOTATION_APPROVED']))
        .length,
      1,
      'a replay journals nothing a second time',
    );
    // B18: the thread is frozen once decided, so no further binding act is even
    // possible — the ledger and the binding table therefore agree forever.
    assert.equal((await scopeRowOf(thread.versionId))!.status, 'AUTHORIZED');
  });

  it('refuses another PIC of the same tenant a replay that is not theirs (C2)', async (t) => {
    if (!requireDatabase(t)) return;
    // The binding confers `picId`; a second ACTIVE PIC of the same tenant exists so
    // the replay attempt can come from a real, admissible principal that shares
    // the tenant, the building and the space — everything except the authority.
    const thread = await buildThread({ issue: true, bind: true });
    const rivalPicId = await createPic(thread.tenantCompanyId);
    const token = await admit(thread);
    const key = `03e-c2-${randomUUID()}`;
    assert.equal((await decide(token, thread.versionId, { decision: 'APPROVE' }, key)).status, 201);
    const before = await ledgerRowOf(thread.versionId);

    // The rival shares the tenant, the building and the credential shape; only the
    // binding distinguishes them, and the binding names the first PIC. Even with
    // the right key and the right decision — i.e. with everything a naive replay
    // check would compare — this is not the rival's row to read back.
    const rivalToken = await admit(thread, { tenantPicId: rivalPicId });
    const stolen = await decide(rivalToken, thread.versionId, { decision: 'APPROVE' }, key);
    assert.equal(stolen.status, 409, JSON.stringify(stolen.body));
    assert.equal(stolen.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
    assert.ok(
      !JSON.stringify(stolen.body).includes(before!.decided_by_tenant_pic_id ?? '—'),
      'the refusal must not echo who really decided',
    );
    assert.deepEqual(await ledgerRowOf(thread.versionId), before, 'a refused replay changes nothing');
  });

  it('refuses a second different decision on the same version', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    assert.equal(
      (await decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-a-${randomUUID()}`)).status,
      201,
    );
    const flip = await decide(token, thread.versionId, { decision: 'REJECT' }, `03e-b-${randomUUID()}`);
    assert.equal(flip.status, 409, JSON.stringify(flip.body));
    assert.equal(flip.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
    assert.equal((await ledgerRowOf(thread.versionId))!.decision, 'APPROVE');
    assert.equal(await versionStatusOf(thread.versionId), 'APPROVED', 'the projection is not re-decided');
  });

  it("refuses a version that is not this credential's thread, uniformly and silently", async (t) => {
    if (!requireDatabase(t)) return;
    const mine = await buildThread({ issue: true, bind: true });
    const theirs = await buildForeignThread();
    const token = await admit(mine);
    const before = await counts();

    // A valid version of ANOTHER tenant, addressed with a valid credential: the
    // same uniform 404 the reads give, so a decide POST cannot enumerate threads.
    const foreign = await decide(token, theirs.versionId, { decision: 'APPROVE' }, `03e-x-${randomUUID()}`);
    assertUniform404(foreign, 'a foreign tenant version');
    const unknown = await decide(token, randomUUID(), { decision: 'APPROVE' }, `03e-x-${randomUUID()}`);
    assertUniform404(unknown, 'an unknown version id');
    assert.deepEqual(await ledgerRowOf(theirs.versionId), undefined, 'nothing was written to their thread');
    assert.deepEqual(await counts(), before, 'a refusal writes nothing anywhere');
  });

  it('refuses the PIC a binding does not confer, and says so on the eligibility read', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true, bindRival: true });
    // The binding in this fixture names the RIVAL; the caller is `picId`.
    const token = await admit(thread);
    const response = await decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-wrong-${randomUUID()}`);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
    assert.ok(!JSON.stringify(response.body).includes(thread.rivalPicId!), 'no naming of the real approver');
    const eligibility = (await read(token, eligibilityPath(thread.requestId))).body.data;
    assert.equal(eligibility.eligible, false);
    assert.ok(
      eligibility.reasons.some((r: { code: string }) => r.code === 'BINDING_TARGET_DIFFERS'),
      JSON.stringify(eligibility.reasons),
    );
    assert.equal(await ledgerRowOf(thread.versionId), undefined);
    // ...while the PIC the binding DOES confer decides without ceremony.
    const rivalToken = await admit(thread, { tenantPicId: thread.rivalPicId! });
    assert.equal(
      (await decide(rivalToken, thread.versionId, { decision: 'APPROVE' }, `03e-right-${randomUUID()}`)).status,
      201,
    );
    assert.equal((await ledgerRowOf(thread.versionId))!.decided_by_tenant_pic_id, thread.rivalPicId);
  });

  it('stands still when no binding confers anyone: PIC 409, staff 403, no fallback', async (t) => {
    if (!requireDatabase(t)) return;
    // The fixture issues WITHOUT a binding, which is itself the proof that the
    // B12 ISSUE gate is still OFF in this PART (release safety).
    const thread = await buildThread({ issue: true });
    const token = await admit(thread);
    const before = await counts();
    const pic = await decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-nobind-${randomUUID()}`);
    assert.equal(pic.status, 409, JSON.stringify(pic.body));
    const staff = await api()
      .post(staffPath(thread.versionId))
      .set('authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `03e-nobind-staff-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(staff.status, 403, JSON.stringify(staff.body));
    assert.deepEqual(await counts(), before, 'an unbound thread stays undecided');
    assert.equal(await versionStatusOf(thread.versionId), 'ISSUED');
  });

  it('refuses a binding whose window has lapsed', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true, bindingUntilSeconds: 1 });
    const token = await admit(thread);
    await sleep(1_500);
    const response = await decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-late-${randomUUID()}`);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
    assert.equal(await ledgerRowOf(thread.versionId), undefined);
    assert.equal(await versionStatusOf(thread.versionId), 'ISSUED');
  });

  for (const expiring of ['binding', 'version'] as const) {
    it(`rechecks the ${expiring} clock after a binding-lock wait`, async (t) => {
      if (!requireDatabase(t)) return;
      const thread = await buildThread({
        issue: true, bind: true,
        ...(expiring === 'binding' ? { bindingUntilSeconds: 3 } : {}),
      });
      if (expiring === 'version') {
        await q(`UPDATE handyman_quotation_versions
                   SET valid_until = clock_timestamp() + interval '3 seconds' WHERE id = $1`,
                [thread.versionId]);
      }
      const token = await admit(thread);
      const blocker = await pool!.connect();
      let pending: Promise<Awaited<ReturnType<typeof decide>>> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT 1 FROM handyman_quotation_approval_bindings
                              WHERE id = $1 FOR UPDATE`, [thread.bindingId]);
        const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
        pending = decide(token, thread.versionId, { decision: 'APPROVE' }, randomUUID())
          .timeout(10_000).then(response => response);
        await waitForDecisionLock(pid, 'FOR SHARE OF b');
        // The decision passed preflight while effective, then waited past expiry.
        const table = expiring === 'binding'
          ? 'handyman_quotation_approval_bindings' : 'handyman_quotation_versions';
        const column = expiring === 'binding' ? 'effective_until' : 'valid_until';
        const id = expiring === 'binding' ? thread.bindingId : thread.versionId;
        const live = await blocker.query(`SELECT ${column} > clock_timestamp() AS live
                                           FROM ${table} WHERE id = $1`, [id]);
        assert.equal(live.rows[0].live, true, 'fixture must reach the lock before expiry');
        await blocker.query(`SELECT pg_sleep(GREATEST(0,
          EXTRACT(EPOCH FROM (${column} - clock_timestamp()))) + 0.05)
          FROM ${table} WHERE id = $1`, [id]);
        await blocker.query('COMMIT');
        const response = await pending;
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
        await assertNoDecisionEffects(thread);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
      }
    });
  }

  it('timestamps a successful decision after the binding-lock wait, not at transaction start', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const blocker = await pool!.connect();
    let pending: Promise<Awaited<ReturnType<typeof decide>>> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM handyman_quotation_approval_bindings
                            WHERE id = $1 FOR UPDATE`, [thread.bindingId]);
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      pending = decide(token, thread.versionId, { decision: 'APPROVE' }, randomUUID())
        .timeout(10_000).then(response => response);
      await waitForDecisionLock(pid, 'FOR SHARE OF b');
      const { rows: [{ releasedAt }] } = await blocker.query('SELECT clock_timestamp() AS "releasedAt"');
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.ok(Date.parse(response.body.data.decision.decidedAt) >= releasedAt.getTime(),
                'decided_at must describe the actual decision, not a stale pre-wait instant');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });

  it('rechecks the request space even when the credential is building-wide (B4/B16)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread, { spaceId: undefined });
    await q("UPDATE tenant_space_relationships SET status = 'INACTIVE' WHERE id = $1",
            [thread.spaceAuthorityId]);
    const response = await decide(token, thread.versionId, { decision: 'APPROVE' }, randomUUID());
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
    await assertNoDecisionEffects(thread);
  });

  it('refuses a read-only credential with the conflict, not a permission 403', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const readOnly = await admit(thread, { tenantPicId: undefined });
    const response = await decide(readOnly, thread.versionId, { decision: 'APPROVE' }, `03e-readonly-${randomUUID()}`);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(await ledgerRowOf(thread.versionId), undefined);
    // And the reason is legible where reasons are allowed:
    const eligibility = (await read(readOnly, eligibilityPath(thread.requestId))).body.data;
    assert.equal(eligibility.canDecide, false);
    assert.ok(
      eligibility.reasons.some((r: { code: string }) => r.code === 'SESSION_READ_ONLY'),
      JSON.stringify(eligibility.reasons),
    );
  });

  it('refuses a credential revoked before the decision lands', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const logout = await api()
      .delete('/api/v1/handyman/pic/session')
      .set('authorization', `Bearer ${token}`);
    assert.equal(logout.status, 204);
    const response = await decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-revoked-${randomUUID()}`);
    assert.equal(response.status, 401, JSON.stringify(response.body));
    assert.equal(response.body.error.code, UNAUTHORIZED);
    assert.equal(await ledgerRowOf(thread.versionId), undefined, 'a revoked credential decides nothing');
  });

  it('locks tenant authority before the session and serializes revocation (R7)', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const blocker = await pool!.connect();
    let pending: Promise<Awaited<ReturnType<typeof decide>>> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query("SET LOCAL lock_timeout = '3s'");
      await blocker.query('SELECT 1 FROM tenant_companies WHERE id = $1 FOR UPDATE',
                          [thread.tenantCompanyId]);
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      pending = decide(token, thread.versionId, { decision: 'APPROVE' }, randomUUID())
        .timeout(10_000).then(response => response);
      await waitForDecisionLock(pid, 'FROM handyman_pic_workspace_sessions s');
      // This trigger needs the session row. Session-first would form a cycle.
      await blocker.query("UPDATE tenant_companies SET status = 'INACTIVE' WHERE id = $1",
                          [thread.tenantCompanyId]);
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 401, JSON.stringify(response.body));
      assert.equal(response.body.error.code, UNAUTHORIZED);
      await assertNoDecisionEffects(thread);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });

  it('rolls back all decision effects when the session expires during a version-lock wait', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const priorTtl = process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
    let token: string;
    try {
      process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = '3';
      token = await admit(thread);
    } finally {
      if (priorTtl === undefined) delete process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
      else process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = priorTtl;
    }
    const sessionId = await sessionIdOf(token);
    const blocker = await pool!.connect();
    let pending: Promise<Awaited<ReturnType<typeof decide>>> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM handyman_quotation_versions WHERE id = $1 FOR UPDATE',
                          [thread.versionId]);
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      pending = decide(token, thread.versionId, { decision: 'APPROVE' }, randomUUID())
        .timeout(10_000).then(response => response);
      await waitForDecisionLock(pid, 'FOR UPDATE OF v');
      await blocker.query(`SELECT pg_sleep(GREATEST(0,
        EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))) + 0.05)
        FROM handyman_pic_workspace_sessions WHERE id = $1`, [sessionId]);
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 401, JSON.stringify(response.body));
      assert.equal(response.body.error.code, UNAUTHORIZED);
      await assertNoDecisionEffects(thread);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });

  it('rolls back ledger, scope and lifecycle together on a scope failure, then safely retries', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const key = randomUUID();
    const original = handymanExecutionScopeRepository.insertScope;
    const injected = t.mock.method(handymanExecutionScopeRepository, 'insertScope',
      async (...args: Parameters<typeof original>) => {
        await original(...args);
        throw new Error('03E injected failure after scope insert');
      });
    const failed = await decide(token, thread.versionId, { decision: 'APPROVE' }, key);
    injected.mock.restore();
    assert.equal(injected.mock.callCount(), 1, 'failure occurs after the ledger and scope inserts');
    assert.equal(failed.status, 500, 'infrastructure failure is not disguised as authorization');
    await assertNoDecisionEffects(thread);
    const retry = await decide(token, thread.versionId, { decision: 'APPROVE' }, key);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal((await scopeRowOf(thread.versionId))!.quotation_decision_id,
                 (await ledgerRowOf(thread.versionId))!.id);
  });

  it("refuses self-approval by the thread's own author (MC1′)", async (t) => {
    if (!requireDatabase(t)) return;
    // The PIC is linked to the very staff user who created the quotation and issued
    // the version. The link is made AFTER the binding row exists on purpose: `0437`
    // refuses a binding granted by a user to a PIC linked to that same user, so the
    // fixture cannot start in this state — and that is the point of MC1', which is
    // why the ledger must be the one to refuse it at decision time. Admission then
    // happens after the link, because 03C revokes a credential when its PIC's user
    // link moves, and a 401 would prove nothing about maker-checker.
    const thread = await buildThread({ issue: true, bind: true });
    await q(`UPDATE tenant_pics SET user_id = $2 WHERE id = $1`, [
      thread.picId,
      adminUserId,
    ]);
    const token = await admit(thread);
    const response = await decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-mc-${randomUUID()}`);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
    assert.equal(await ledgerRowOf(thread.versionId), undefined);
    const eligibility = (await read(token, eligibilityPath(thread.requestId))).body.data;
    assert.ok(
      eligibility.reasons.some((r: { code: string }) => r.code === 'MAKER_CHECKER_CONFLICT'),
      JSON.stringify(eligibility.reasons),
    );
    // An unlinked PIC of the same shape is NOT refused on a proof that does not
    // exist (MC4's residual), which is what makes the check above a rule rather
    // than an accident of this fixture.
    const control = await buildThread({ issue: true, bind: true });
    const controlToken = await admit(control);
    assert.equal(
      (await decide(controlToken, control.versionId, { decision: 'APPROVE' }, `03e-mc-ok-${randomUUID()}`)).status,
      201,
    );
  });

  it('accepts exactly {decision} plus the idempotency header', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const key = `03e-body-${randomUUID()}`;
    const extra = await decide(token, thread.versionId, { decision: 'APPROVE', tenantCompanyId: thread.tenantCompanyId }, key);
    assert.equal(extra.status, 400, JSON.stringify(extra.body));
    assert.equal(extra.body.error.code, 'VALIDATION_ERROR');
    const context = await api()
      .post(`${decisionPath(thread.versionId)}?tenantCompanyId=${thread.tenantCompanyId}`)
      .set('authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ decision: 'APPROVE' });
    assert.equal(context.status, 400, JSON.stringify(context.body));
    const badDecision = await decide(token, thread.versionId, { decision: 'MAYBE' }, key);
    assert.equal(badDecision.status, 400);
    assert.equal(
      (badDecision.body.error.details as Array<{ field: string }>).some(d => d.field === 'decision'),
      true,
      JSON.stringify(badDecision.body),
    );
    const noKey = await decide(token, thread.versionId, { decision: 'APPROVE' });
    assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
    assert.ok(
      (noKey.body.error.details as Array<{ field: string }>).some(d => d.field === 'idempotencyKey'),
      JSON.stringify(noKey.body),
    );
    const blankKey = await decide(token, thread.versionId, { decision: 'APPROVE' }, '   ');
    assert.equal(blankKey.status, 400);
    assert.equal(await ledgerRowOf(thread.versionId), undefined, 'no refusal may write a decision');
  });

  it('is safe under concurrency: one decision row per version, whoever wins', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const token = await admit(thread);
    const otherSession = await admit(thread);

    // Two different decisions, submitted simultaneously from two credentials of the
    // same PIC: exactly one wins, the other is a conflict, and the loser is a 409
    // rather than a lock timeout (the version is locked once, through the
    // credential predicate, so no SHARE→UPDATE upgrade deadlock is reachable).
    const [a, b] = await Promise.all([
      decide(token, thread.versionId, { decision: 'APPROVE' }, `03e-race-a-${randomUUID()}`),
      decide(otherSession, thread.versionId, { decision: 'REJECT' }, `03e-race-b-${randomUUID()}`),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));
    const ledger = await ledgerRowOf(thread.versionId);
    assert.ok(ledger);
    assert.equal(
      ledger!.decision,
      a.status === 201 ? 'APPROVE' : 'REJECT',
      'the recorded decision is the one that won the lock',
    );
    assert.equal((await q(`SELECT count(*)::int AS n FROM handyman_quotation_decisions WHERE quotation_version_id = $1`, [thread.versionId])).rows[0].n, 1);

    // The same double-submitted key, twice simultaneously, is a retry rather than a
    // conflict — and it must be settled by the version lock, not by a deadlock. A
    // fresh thread, because the version above is decided by now and a different
    // decision on it would be a legitimate conflict.
    const twin = await buildThread({ issue: true, bind: true });
    const twinToken = await admit(twin);
    const same = `03e-race-same-${randomUUID()}`;
    const [c, d] = await Promise.all([
      decide(twinToken, twin.versionId, { decision: 'APPROVE' }, same),
      decide(twinToken, twin.versionId, { decision: 'APPROVE' }, same),
    ]);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual(c.body.data, d.body.data, 'a racing retry returns the same facts');
    assert.equal(
      (await q(`SELECT count(*)::int AS n FROM handyman_quotation_decisions WHERE quotation_version_id = $1`, [twin.versionId])).rows[0].n,
      1,
      'one decision row, one scope row',
    );
    assert.equal(
      (await q(`SELECT count(*)::int AS n FROM handyman_execution_scopes WHERE approved_quotation_version_id = $1`, [twin.versionId])).rows[0].n,
      1,
    );
  });

  it('keeps the staff decide path a controlled 403 with a successor, never a 500', async (t) => {
    if (!requireDatabase(t)) return;
    const thread = await buildThread({ issue: true, bind: true });
    const before = await counts();
    const response = await api()
      .post(staffPath(thread.versionId))
      .set('authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `03e-staff-${randomUUID()}`)
      .send({ decision: 'APPROVE' });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.equal(response.headers['deprecation'], 'true');
    const link = String(response.headers['link'] ?? '');
    assert.ok(link.includes('rel="successor-version"'), link);
    assert.ok(link.includes(`/handyman/pic/quotation-versions/${thread.versionId}/decision`), link);
    // Owner decision (2026-10-11): no `Sunset` date is advertised, because removal
    // is pinned to a BM rollout promise the codebase cannot make on its own.
    assert.equal(response.headers['sunset'], undefined, 'no sunset date may be invented here');
    assert.deepEqual(await counts(), before, 'the closed path writes nothing on the way out');
    assert.equal(await ledgerRowOf(thread.versionId), undefined);
    // The refusal is raised before any read, so it cannot be used to probe a
    // version that does not exist, a version belonging to another tenant, or an
    // expired one — every answer is the same 403.
    for (const version of [randomUUID(), thread.versionId]) {
      const probe = await api()
        .post(staffPath(version))
        .set('authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', `03e-staff-${randomUUID()}`)
        .send({ decision: 'APPROVE' });
      assert.equal(probe.status, 403, JSON.stringify(probe.body));
    }
    // A historical USER decision stays readable on the staff surface (C8) even
    // though no new one can be recorded.
    const history = await api()
      .get(staffPath(thread.versionId))
      .set('authorization', `Bearer ${adminToken}`);
    assert.equal(history.status, 404, 'no decision yet — and the read is still open, not 403');
  });

  it('leaves the pre-amendment historical shape untouched', async (t) => {
    if (!requireDatabase(t)) return;
    // No 03E code path can write a `USER` row any more, and nothing rewrites the
    // rows that already exist: assert the columns stay exactly as 0438 left them.
    const columns = await q(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'handyman_quotation_decisions'
          AND column_name IN ('decision_actor_type','decided_by_user_id',
                              'decided_by_tenant_pic_id','decided_by_pic_session_id',
                              'approval_binding_id')`,
    );
    const byName = new Map(columns.rows.map(r => [r.column_name as string, r.is_nullable as string]));
    assert.equal(byName.size, 5, JSON.stringify(columns.rows));
    assert.equal(byName.get('decided_by_user_id'), 'YES', '03E adds no NOT NULL tightening');
    assert.equal(byName.get('decision_actor_type'), 'NO');
    const defaults = await q(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'handyman_quotation_decisions' AND column_name = 'decision_actor_type'`,
    );
    assert.match(String(defaults.rows[0].column_default ?? ''), /USER/, 'legacy rows keep their class by default');
  });
});

// ---------------------------------------------------------------------------
// Structure: the claims that must stay true without a database, because they are
// about how the code is arranged (03E items 9, 13 and the release-safety list).
// ---------------------------------------------------------------------------

describe('W03 PART 03E — one authority, no bypass (static census)', () => {
  const quotationsDir = join(process.cwd(), 'src/modules/handyman-quotations');
  const portalDir = join(process.cwd(), 'src/modules/handyman-pic-portal');
  const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');

  it('funnels every decision and scope write through exactly one call site', () => {
    const engine = read(quotationsDir, 'handyman-quotation-decision.service.ts');
    assert.equal((code(engine).match(/await handymanQuotationDecisionRepository\.insertDecision\(/g) ?? []).length, 1);
    assert.equal((code(engine).match(/await handymanExecutionScopeRepository\.insertScope\(/g) ?? []).length, 1);
    // E1: the scope insert lives inside the APPROVE branch of the same engine, and
    // nowhere else in the repository — so "only an APPROVE creates a scope" is a
    // fact about the code, not a promise to review.
    const callers = [
      'handyman-quotation-decision.service.ts',
      'handyman-quotation-lifecycle.service.ts',
      'handyman-quotation.service.ts',
      'handyman-execution-scope.service.ts',
    ].map(file => code(read(quotationsDir, file)).match(/insertScope\(/g)?.length ?? 0);
    assert.deepEqual(callers.slice(1).map(n => n), [0, 0, 0], 'no second scope creator');
    assert.equal(callers[0], 1);
    for (const file of ['pic-portal-decide.service.ts', 'pic-portal.service.ts', 'pic-portal.repository.ts']) {
      const portal = code(read(portalDir, file));
      for (const forbidden of ['insertScope', 'insertDecision', 'UPDATE handyman_', 'INSERT INTO']) {
        assert.ok(!portal.includes(forbidden), `the portal must not perform ${forbidden}`);
      }
    }
  });

  it('keeps the ledger and scope repositories INSERT-only', () => {
    for (const file of ['handyman-quotation-decision.repository.ts', 'handyman-execution-scope.repository.ts']) {
      const text = code(read(quotationsDir, file));
      // `FOR UPDATE` is allowed and required — it is the version-scoped row lock
      // that makes one decision per version true under concurrency. A WRITE is not:
      // an immutable ledger may only ever gain rows, so the census names the shapes
      // that would silently rewrite history.
      assert.ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(text), `${file} must never UPDATE a row`);
      assert.ok(!/\bDELETE\s+FROM\b/i.test(text), `${file} must never DELETE`);
      assert.ok(!/ON CONFLICT/i.test(text), `${file} must not upsert over history`);
      assert.ok(!/\bTRUNCATE\b/i.test(text));
      assert.ok(!/RETURNING\s+\*/i.test(text), `${file} must project explicit columns`);
    }
    assert.equal(
      (code(read(quotationsDir, 'handyman-quotation-decision.repository.ts')).match(/FOR UPDATE/g) ?? []).length,
      1,
      'exactly one locking read: the per-version decision lock',
    );
    assert.equal(
      (code(read(quotationsDir, 'handyman-execution-scope.repository.ts')).match(/FOR (UPDATE|SHARE)/g) ?? []).length,
      0,
      'the scope repository locks nothing; the decision engine owns the serialization',
    );
  });

  it('takes no row lock on the actor tables inside the decide path (R7)', () => {
    // The seam pre-locks integration/tenant authority BEFORE the workspace session.
    // Business work must not introduce NEW actor-table locks after that point;
    // the revocation triggers acquire authority → session, never the reverse.
    const assertNoActorLocks = (text: string, label: string) => {
      for (const statement of text.split(';')) {
        for (const table of ['tenant_pics', 'tenant_companies']) {
          // String.raw preserves regex escapes; an ordinary template turns \b
          // into backspace and drops \s, making the census silently match nothing.
          const alias = new RegExp(String.raw`\b${table}\s+(?!ON\b)([a-z_]+)\b`, 'i').exec(statement)?.[1];
          if (!new RegExp(String.raw`\b${table}\b`, 'i').test(statement)) continue;
          for (const lock of statement.matchAll(/FOR\s+(?:(?:NO\s+KEY\s+)?UPDATE|(?:KEY\s+)?SHARE)(?:\s+OF\s+([a-z_][a-z_0-9]*(?:\s*,\s*[a-z_][a-z_0-9]*)*))?/gi)) {
            const names = lock[1]?.split(',').map(x => x.trim()) ?? null;
            assert.ok(
              names !== null && !names.some(n => n === alias || n === table),
              `${label} locks ${table} (${lock[0].trim()}) — the seam order would be inverted`,
            );
          }
        }
      }
    };
    // Prove the census detects bare locks, aliases, and a forbidden second OF target.
    for (const sql of [
      'SELECT p.id FROM tenant_pics p FOR UPDATE',
      'SELECT p.id FROM tenant_pics p FOR SHARE OF p',
      'SELECT p.id FROM tenant_pics p JOIN bindings b ON true FOR SHARE OF b, p',
      'SELECT tc.id FROM tenant_companies tc FOR NO KEY UPDATE OF tc',
    ]) assert.throws(() => assertNoActorLocks(sql, 'probe'), /seam order would be inverted/);
    assertNoActorLocks('SELECT p.id FROM tenant_pics p JOIN bindings b ON true FOR SHARE OF b', 'allowed');
    for (const file of [
      [quotationsDir, 'handyman-quotation-decision.service.ts'],
      [portalDir, 'pic-portal-decide.service.ts'],
    ]) assertNoActorLocks(code(read(...file)), file[1]);
    // Including the helper the authority check borrows.
    const bindingsRepo = read(
      process.cwd(),
      'src/modules/handyman-quotation-approval-bindings/handyman-quotation-approval-binding.repository.ts',
    );
    const facts = bindingsRepo.slice(
      bindingsRepo.indexOf('export async function findTenantPicFacts'),
      bindingsRepo.indexOf('export async function findLiveOccupancyAuthorityId'),
    );
    assert.ok(
      facts.length > 100
        && !/FOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)/i.test(facts)
        && !/pg_advisory/i.test(facts),
      'findTenantPicFacts must stay a plain SELECT',
    );
    // And the version lock is taken ONCE, exclusively, through the credential
    // predicate — the shape that makes a SHARE→UPDATE upgrade deadlock unreachable.
    const portal = code(read(portalDir, 'pic-portal-decide.service.ts'));
    assert.match(portal, /findVersionForCredential\([\s\S]{0,400}lock: 'update'/);
  });

  it('closes the staff arm before it touches anything, and keeps the read open', () => {
    const engine = read(quotationsDir, 'handyman-quotation-decision.service.ts');
    const staff = engine.slice(
      engine.indexOf('export async function decideHandymanQuotation'),
      engine.indexOf('/** Exact read of the immutable decision'),
    );
    assert.ok(staff.length > 200, 'the staff operation still exists (route kept, C10)');
    assert.match(staff, /throw staffApprovalForbiddenError\(\);/);
    assert.ok(!staff.includes('withTransaction'), 'the closed path opens no transaction');
    assert.ok(!/await (repo|tx|handyman)/.test(staff), 'and performs no I/O at all');
    const getBlock = engine.slice(engine.indexOf('export async function getHandymanQuotationDecision'));
    assert.match(getBlock, /findDecisionByVersion/);
    // The refusal is in the error contract, not a raw guard error: 403 for the
    // staff policy answer, and one conflict code for every state conflict.
    const errors = read(process.cwd(), 'src/shared/errors.ts');
    assert.ok(errors.includes('PERMISSION_DENIED'));
    assert.ok(errors.includes('HANDYMAN_QUOTATION_DECISION_CONFLICT'));
    assert.ok(!/PIC_.*DECISION|DECISION_.*FORBIDDEN/i.test(errors), 'no new decide-specific code (C15)');
  });

  it('keeps the actor vocabulary exactly USER and TENANT_PIC', () => {
    const types = read(quotationsDir, 'handyman-quotation-decision.types.ts');
    assert.match(types, /HANDYMAN_QUOTATION_DECISION_ACTOR_TYPES = \[\s*'USER',\s*'TENANT_PIC',?\s*\]/);
    assert.ok(!/SYSTEM/.test(code(types)), 'SYSTEM never enters the ledger vocabulary (A01 §10.2)');
    const scopeTypes = read(quotationsDir, 'handyman-execution-scope.types.ts');
    assert.match(scopeTypes, /HANDYMAN_EXECUTION_SCOPE_ACTOR_TYPES = \[\s*'USER',\s*'TENANT_PIC',?\s*\]/);
    // C7: a credential id is stored but never projected; the omission is in the type.
    const publicBlock = scopeTypes.slice(scopeTypes.indexOf('export type PublicHandymanExecutionScope'));
    assert.ok(
      publicBlock.slice(0, 600).includes("'createdByPicSessionId'"),
      'the public scope projection omits the session id by type',
    );
  });

  it('publishes the widened contract and the closed staff path in OpenAPI', () => {
    // `any` on purpose: this is a structural census of a document whose shape is
    // what is under test, and typing each level of it would only prove that the
    // test and the yaml agree about paths, which is the thing being asserted.
    const doc = yamlLoad(read(process.cwd(), 'docs/api/openapi.yaml')) as any;
    const pic = doc.paths['/handyman/pic/quotation-versions/{quotationVersionId}/decision'];
    assert.ok(pic.get && pic.post, 'the PIC path is one GET plus one POST');
    assert.equal(pic.post.operationId, 'submitPicQuotationDecision');
    const responses = pic.post.responses as Record<string, unknown>;
    assert.deepEqual(Object.keys(responses).sort(), ['201', '400', '401', '404', '409']);
    assert.ok(!('403' in responses), 'the PIC surface has no permission class (MC3)');
    assert.equal(
      JSON.stringify((pic.post.parameters as Array<Record<string, any>>).find(p => p.name === 'Idempotency-Key')?.required),
      'true',
    );
    const body = doc.components.schemas.PicPortalDecisionBody;
    assert.deepEqual(body.required, ['decision']);
    assert.equal(body.additionalProperties, false);
    assert.deepEqual(body.properties.decision.enum, ['APPROVE', 'REJECT']);
    const scope = doc.components.schemas.PicPortalExecutionScope;
    assert.equal(scope.additionalProperties, false);
    assert.ok(!('createdByUserId' in scope.properties) && !('tenantCompanyId' in scope.properties));
    for (const field of ['decisionActorType', 'decidedByTenantPicId', 'decidedByPicSessionId', 'approvalBindingId']) {
      assert.ok(doc.components.schemas.HandymanQuotationDecisionRecord.properties[field], field);
    }
    assert.equal(doc.components.schemas.HandymanQuotationDecisionRecord.properties.decidedByUserId.nullable, true);
    assert.deepEqual(doc.components.schemas.HandymanQuotationDecisionRecord.properties.decisionActorType.enum, ['USER', 'TENANT_PIC']);
    for (const field of ['createdByActorType', 'createdByTenantPicId']) {
      assert.ok(doc.components.schemas.HandymanExecutionScopeRecord.properties[field], field);
    }
    assert.equal(doc.components.schemas.HandymanExecutionScopeRecord.properties.createdByUserId.nullable, true);
    assert.ok(!('createdByPicSessionId' in doc.components.schemas.HandymanExecutionScopeRecord.properties));
    const staffPost = doc.paths['/handyman/quotation-versions/{quotationVersionId}/decision'].post;
    assert.equal(staffPost.deprecated, true, 'the closed staff write is marked deprecated');
    const responsesForSunset = staffPost.responses as Record<string, { headers?: Record<string, unknown> }>;
    for (const [status, response] of Object.entries(responsesForSunset)) {
      assert.ok(
        !Object.keys(response.headers ?? {}).some(name => name.toLowerCase() === 'sunset'),
        `no Sunset date may be advertised on ${status} (owner decision 2026-10-11)`,
      );
    }
    const forbidden = staffPost.responses['403'] as { headers?: Record<string, unknown> };
    assert.ok(forbidden.headers?.Deprecation && forbidden.headers?.Link, '403 advertises the successor');
  });

  it('holds the release-safety list: no gate, no auto-bind, no second ledger, no C6 widening', () => {
    const src = [
      'handyman-quotation-decision.service.ts',
      'handyman-quotation-decision.repository.ts',
      'handyman-quotation-lifecycle.service.ts',
      'handyman-execution-scope.service.ts',
    ].map(file => read(quotationsDir, file)).join('\n');
    const portal = ['pic-portal-decide.service.ts', 'pic-portal.repository.ts', 'pic-portal.routes.ts']
      .map(file => read(portalDir, file))
      .join('\n');
    assert.ok(!/handyman_quotation_pic_approval_gate|ENABLE_PIC_APPROVAL/i.test(src + portal), 'B12 stays OFF');
    assert.ok(!/INSERT INTO handyman_quotation_approval_bindings/i.test(src + portal), 'no auto-binding');
    assert.ok(!/handyman_quotation_pic_decisions|pic_quotation_decisions/i.test(src + portal), 'no second ledger');
    assert.ok(!/assertQuotationThreadBuildingAccess[\s\S]{0,80}TENANT_PIC/i.test(src), 'C6 is not widened to a PIC');
    assert.ok(!/PRODUCTION_DEPLOY|deploy/i.test(portal));
  });
});
