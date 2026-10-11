import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { getAppConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import {
  admitCareWorkspace,
  resolveCareWorkspacePrincipal,
  signCareWorkspaceAssertion,
  type CareWorkspaceAssertion,
} from '../src/modules/handyman-care-workspace/care-workspace.service';
import {
  PIC_WORKSPACE_MAX_TTL_SECONDS,
  PIC_WORKSPACE_PURPOSE,
  admitPicWorkspace,
  readPicWorkspaceSession,
  resolvePicWorkspacePrincipal,
  revokePicWorkspaceSession,
  signPicWorkspaceAssertion,
  type PicWorkspaceAssertion,
} from '../src/modules/handyman-pic-session';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * W03 PART 03C — bounded, BM-attested Tenant PIC session and secure handoff
 * (CR-HM-06/A01 §4–§5 rules 1–22, migrations `0441`/`0442`).
 *
 * A01 §13 gives this PART a list of attacks as its exit gate, so the file is
 * organised by attack rather than by endpoint: replay, window,
 * expiry-after-lock-wait, cross-tenant, revoked PIC mid-session,
 * malformed/unknown keys, credential-kind separation, token-hash never echoed.
 * The PART order adds cross-building, expired token, and token-type confusion,
 * plus the isolated audience / namespace / TTL / hash-only-persistence / revoke
 * and PII-free audit claims.
 *
 * No quotation, decision, or binding thread is built here — rule 13 says the
 * credential does not scope a request, so a thread fixture would prove nothing
 * about admission while making a security failure ambiguous to read. The one
 * ledger-side case (0442) works at the CHECK level for the same reason.
 *
 * Everything is measured against a LIVE server: this suite boots its own
 * embedded PostgreSQL (55560) and `t.skip`s rather than pretending, exactly
 * like the care-workspace admission suite it mirrors.
 */

const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const DATA_DIR = '/tmp/asentra-w03-03c-pg';
const DB_PORT = 55560;
const SECRET = 'pic-session-handoff-integration-secret-0441';
const CARE_SECRET = 'care-workspace-secret-seen-by-the-pic-route-0441';
const UNAUTHORIZED = 'HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED';
const SESSION_TABLE = 'handyman_pic_workspace_sessions';

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
/** The only integration allowed to mint a PIC session in this suite. */
let integrationCode = '';
let integrationId = '';
/** A care-capable integration, used solely for kind/purpose separation. */
let careCode = '';
let careIntegrationId = '';
let careActorReference = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};
const tokenHashOf = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');
/** Second-precision UTC — the only shape rule 4 accepts. */
const iso = (offsetSeconds: number) =>
  new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoAt = (epochMs: number) =>
  new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

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
  adminUserId = (await createAdminUser()).userId;

  integrationCode = `PICT_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode,
    displayName: '03C PIC attesting integration',
  });
  integrationId = integration.id;
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId,
    capability: 'TENANT_PIC',
  });
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = SECRET;

  careCode = `CARET_${suffix()}`;
  const care = await handoffRuntimeRepository.createIntegration({
    integrationCode: careCode,
    displayName: '03C care integration (separation control)',
  });
  careIntegrationId = care.id;
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: care.id,
    capability: 'CUSTOMER_CARE',
  });
  careActorReference = `care-03c-${suffix()}`;
  await handymanCareActorService.createCareActor({
    integrationId: care.id,
    actorReference: careActorReference,
    displayName: '03C Care Actor',
  });
  process.env[handoffIntegrationSecretEnvName(careCode)] = CARE_SECRET;
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

/** The throttle is process-global and keyed per address, and this suite
 * deliberately produces failures: without this, a refusal in one case would
 * turn an unrelated later case into a 429. */
beforeEach(() => {
  clearLoginRateLimits();
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures — one fresh tenant/PIC per case, so a revocation is never shared
// ---------------------------------------------------------------------------

type Fixture = {
  clientId: string;
  tenantCompanyId: string;
  /** A sibling company under the SAME client: a real foreign tenant. */
  otherTenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  occupancyId: string;
  picId: string;
  otherTenantPicId: string;
};

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

async function fixture(): Promise<Fixture> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `S03C${tag}`,
    name: `03C Client ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P03C${tag}`,
    name: '03C Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B03C${tag}`,
    name: '03C Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F03C${tag}`,
    name: '03C Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A03C${tag}`,
    name: '03C Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R03C${tag}`,
    name: '03C Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S03C${tag}`,
    name: '03C Space',
  });
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `T03C${tag}`, tenantName: `03C Tenant ${tag}` },
    adminUserId,
  );
  const otherCompany = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `X03C${tag}`, tenantName: `03C Sibling ${tag}` },
    adminUserId,
  );
  // Space relationship first, then the building context (the order 03B2 measured).
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
  return {
    clientId: client.id,
    tenantCompanyId: company.id,
    otherTenantCompanyId: otherCompany.id,
    buildingId: building.id,
    spaceId: space.id,
    occupancyId,
    picId: await createPic(company.id),
    otherTenantPicId: await createPic(otherCompany.id),
  };
}

// ---------------------------------------------------------------------------
// Assertion and request builders
// ---------------------------------------------------------------------------

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

function sign(assertionValue: PicWorkspaceAssertion, secret = SECRET): string {
  return signPicWorkspaceAssertion(assertionValue, secret);
}

/**
 * `signature === null` means "send no signature header at all", which `??`
 * would otherwise silently replace with a valid one — a mistake that would
 * have turned the T2 case below into a success.
 */
const admission = (body: unknown, signature?: string | null) => {
  const request = api().post('/api/v1/handyman/pic/session');
  if (signature !== null) {
    request.set(
      'x-hub-signature-256',
      signature ?? sign(body as PicWorkspaceAssertion),
    );
  }
  return request.send(body as Record<string, unknown>);
};

/** Mass-failure cases must not spend the shared per-address throttle budget. */
const unthrottled = async <T>(work: () => Promise<T>): Promise<T> => {
  clearLoginRateLimits();
  const result = await work();
  clearLoginRateLimits();
  return result;
};

const introspect = (token: string) =>
  api().get('/api/v1/handyman/pic/session').set('authorization', `Bearer ${token}`);

const logout = (token: string) =>
  api().delete('/api/v1/handyman/pic/session').set('authorization', `Bearer ${token}`);

function assertUniform401(response: { status: number; body: any }, label: string): void {
  assert.equal(
    response.status,
    401,
    `${label}: got ${response.status} ${JSON.stringify(response.body)}`,
  );
  assert.equal(response.body?.error?.code, UNAUTHORIZED, `${label}: wrong code`);
  // Rules 2 and 14: a refusal carries no reason detail and never a credential.
  const wire = JSON.stringify(response.body ?? {});
  assert.ok(!wire.includes('hpw_'), `${label}: must not echo a token`);
  assert.ok(!/[0-9a-f]{64}/.test(wire), `${label}: must not echo a hash`);
  assert.ok(!/assertion|representation|tenantPicId/i.test(wire),
    `${label}: must not name the reason or echo the payload`);
}

async function admit(fx: Fixture, over: Record<string, unknown> = {}): Promise<string> {
  const response = await admission(
    assertion({
      tenantCompanyId: fx.tenantCompanyId,
      buildingId: fx.buildingId,
      tenantPicId: fx.picId,
      spaceId: fx.spaceId,
    }, over),
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.workspaceToken as string;
}

/** `now()` to the second, so a millisecond truncation can never move a bound. */
const secondFloor = (epochMs: number) => Math.floor(epochMs / 1000) * 1000;

async function sessionIdOf(token: string): Promise<string> {
  const row = await q(`SELECT id FROM ${SESSION_TABLE} WHERE token_hash = $1`, [
    tokenHashOf(token),
  ]);
  assert.equal(row.rows.length, 1, 'one session per token hash');
  return row.rows[0].id as string;
}

// ---------------------------------------------------------------------------
// A. Admission contract (rules 1–8)
// ---------------------------------------------------------------------------

describe('W03 PART 03C — admission of a bounded PIC session', () => {
  it('mints exactly the contracted shape and persists a hash, not a token', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const sessionsBefore = await q('SELECT count(*)::int AS n FROM user_sessions');
    const response = await admission(
      assertion({
        tenantCompanyId: fx.tenantCompanyId,
        buildingId: fx.buildingId,
        tenantPicId: fx.picId,
      }),
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.headers['cache-control'], 'no-store');
    // Rule 1: `201 { workspaceToken, expiresAt }` — nothing more, nothing less.
    assert.deepEqual(Object.keys(response.body.data).sort(), ['expiresAt', 'workspaceToken']);
    const token = response.body.data.workspaceToken as string;
    assert.match(token, /^hpw_[A-Za-z0-9_-]{43}$/, 'rule 14 token shape');

    const rows = await q(
      `SELECT token_hash, tenant_company_id, tenant_pic_id, building_id, space_id,
              tenant_building_context_id, integration_id, assertion_id,
              created_at, expires_at, revoked_at
         FROM ${SESSION_TABLE} ORDER BY created_at DESC LIMIT 1`,
    );
    const row = rows.rows[0] as Record<string, unknown>;
    assert.equal(row.token_hash, tokenHashOf(token), 'hash-only persistence');
    assert.notEqual(row.token_hash, token);
    assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
    // Rule 11 and item 5: every stored identity is the RESOLVED one, and the
    // context ids came from Handyman's masters, not from the payload.
    assert.equal(row.tenant_company_id, fx.tenantCompanyId);
    assert.equal(row.tenant_pic_id, fx.picId);
    assert.equal(row.building_id, fx.buildingId);
    assert.equal(row.space_id, null, 'an unclaimed space stays NULL, never invented');
    assert.equal(row.tenant_building_context_id, fx.occupancyId);
    assert.equal(row.integration_id, integrationId);
    assert.equal(row.revoked_at, null);
    // Rule 15: the window is bounded by the contract, not by a claim.
    const life =
      ((row.expires_at as Date).getTime() - (row.created_at as Date).getTime()) / 1000;
    assert.ok(life > 0 && life <= PIC_WORKSPACE_MAX_TTL_SECONDS, `ttl ${life}s`);

    // A PIC session is not a user session (A2): no users row is created, no
    // user_sessions row is created, and no column exists to hold either.
    assert.deepEqual(
      (
        await q(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = $1 ORDER BY column_name`,
          [SESSION_TABLE],
        )
      ).rows.map(r => r.column_name),
      [
        'assertion_id', 'building_id', 'created_at', 'expires_at', 'id',
        'integration_id', 'revoked_at', 'space_id',
        'tenant_building_context_id', 'tenant_company_id', 'tenant_pic_id',
        'token_hash',
      ],
      'the session row carries exactly rule 10\u2019s column set',
    );
    const sessionsAfter = await q('SELECT count(*)::int AS n FROM user_sessions');
    assert.equal(
      sessionsAfter.rows[0].n,
      sessionsBefore.rows[0].n,
      'admission must not create a local session (A2)',
    );
    assert.ok(!JSON.stringify(response.body).includes(String(row.token_hash)));
    assert.deepEqual(Object.keys(response.body).sort(), ['data', 'meta', 'success']);
  });

  it('derives decide-versus-read capability from the credential itself', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const deciding = await admit(fx);
    const readOnly = await admit(fx, {
      representation: { tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId },
    });
    const decidingView = await introspect(deciding);
    const readOnlyView = await introspect(readOnly);
    assert.equal(decidingView.status, 200);
    assert.equal(decidingView.body.data.canDecide, true);
    assert.equal(readOnlyView.status, 200, 'rule 3: a read-capable session is a real session');
    assert.equal(readOnlyView.body.data.canDecide, false);
    assert.equal(readOnlyView.body.data.tenantPicId, null);
    assert.deepEqual(Object.keys(readOnlyView.body.data).sort(), [
      'buildingId', 'canDecide', 'expiresAt', 'issuedAt', 'sessionId',
      'spaceId', 'tenantCompanyId', 'tenantPicId',
    ]);
    assert.ok(!JSON.stringify(readOnlyView.body).includes(readOnly), 'no token in introspection');
    // And the admission that produced it stored the same fact.
    const stored = await q(
      `SELECT tenant_pic_id IS NULL AS picless FROM ${SESSION_TABLE} WHERE token_hash = $1`,
      [tokenHashOf(readOnly)],
    );
    assert.equal(stored.rows[0].picless, true);
  });

  it('refuses query parameters on admission and context fields on logout', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const signed = assertion({ tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId });
    const withQuery = await api()
      .post('/api/v1/handyman/pic/session?tenantCompanyId=' + fx.tenantCompanyId)
      .set('x-hub-signature-256', sign(signed))
      .send(signed as any);
    assert.equal(withQuery.status, 400, 'rule 8');
    assert.equal(withQuery.body.error.code, 'VALIDATION_ERROR');
    const token = await admit(fx);
    const logoutWithQuery = await api()
      .delete('/api/v1/handyman/pic/session?tenantCompanyId=' + fx.tenantCompanyId)
      .set('authorization', `Bearer ${token}`);
    assert.equal(logoutWithQuery.status, 400);
    assert.equal(logoutWithQuery.body.error.code, 'VALIDATION_ERROR');
    assert.equal((await logout(token)).status, 204);
  });
});

// ---------------------------------------------------------------------------
// B. Structural refusal: vocabulary, purpose isolation, window, signature,
//    capability — every one of them the SAME 401
// ---------------------------------------------------------------------------

describe('W03 PART 03C — uniform structural refusal', () => {
  it('refuses any deviation from the exact assertion vocabulary', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const repr = { tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId };
    const cases: Array<[string, PicWorkspaceAssertion, string]> = [
      ['unknown top-level key', assertion(repr, { role: 'APPROVER' }), 'T1'],
      ['missing purpose', (({ purpose: _p, ...rest }) => rest)(assertion(repr)) as any, 'rule 2'],
      ['requestId inside the representation', assertion({ ...repr, requestId: randomUUID() }), 'rule 13'],
      ['caller-supplied clientId', assertion({ ...repr, clientId: fx.clientId }), 'T1'],
      ['a care actor block instead of a representation',
        assertion(repr, { actor: { type: 'CUSTOMER_CARE', actorReference: 'x' } }), 'D4'],
      ['empty assertionId', assertion(repr, { assertionId: '' }), 'rule 2'],
      ['padded assertionId', assertion(repr, { assertionId: ` ${randomUUID()} ` }), 'sign the exact bytes'],
      ['offset timestamp', assertion(repr, { issuedAt: '2026-10-11T10:00:00+07:00' }), 'rule 4'],
      ['epoch digits', assertion(repr, { expiresAt: String(Date.now()) }), 'rule 4'],
      ['non-uuid representation id', assertion({ tenantCompanyId: 'tenant-1', buildingId: fx.buildingId }), 'rule 3'],
      ['representation is a string', assertion('nope' as any), 'rule 3'],
      ['purpose of another workspace', assertion(repr, { purpose: 'HANDYMAN_CARE_WORKSPACE' }), 'rule 2'],
    ];
    for (const [label, body, why] of cases) {
      await unthrottled(async () => {
        assertUniform401(await admission(body, sign(assertion(repr))), `${label} (${why})`);
      });
    }
    const rows = await q(
      `SELECT count(*)::int AS n FROM ${SESSION_TABLE} WHERE tenant_company_id = $1`,
      [fx.tenantCompanyId],
    );
    assert.equal(rows.rows[0].n, 0, 'a refused admission persists nothing');
  });

  it('isolates purpose: a care assertion never mints a PIC session, nor the reverse', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const careAssertion = {
      purpose: 'HANDYMAN_CARE_WORKSPACE',
      integrationCode: careCode,
      assertionId: randomUUID(),
      issuedAt: iso(-2),
      expiresAt: iso(120),
      actor: { type: 'CUSTOMER_CARE', actorReference: careActorReference },
    } as unknown as CareWorkspaceAssertion;
    // A correctly signed care assertion (right keys, right secret, right
    // integration) presented at the PIC endpoint: refused, not reinterpreted.
    assertUniform401(
      await admission(careAssertion as any, signCareWorkspaceAssertion(careAssertion, CARE_SECRET)),
      'care assertion at the PIC route',
    );
    // Same payload with the PIC purpose: the code inside the assertion selects
    // which secret may have signed it, so this fails on signature and never
    // reaches the resolver.
    const repurposed = { ...careAssertion, purpose: PIC_WORKSPACE_PURPOSE } as unknown as PicWorkspaceAssertion;
    assertUniform401(await admission(repurposed, sign(repurposed, CARE_SECRET)),
      'PIC purpose signed with the care secret');
    // And the care route refuses a PIC-shaped assertion (bidirectional, rule 2).
    const picShaped = assertion({ tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId });
    const atCare = await api()
      .post('/api/v1/handyman/care/session')
      .set('x-hub-signature-256', sign(picShaped))
      .send({ ...picShaped, purpose: 'HANDYMAN_CARE_WORKSPACE' });
    assert.equal(atCare.status, 401, 'rule 2: purpose isolation is bidirectional');
    assert.equal(atCare.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    // Rule 21: the PIC capability buys no care-side authority either.
    await assert.rejects(
      () => admitCareWorkspace(
        { ...careAssertion, integrationCode: integrationCode,
          assertionId: randomUUID() } as unknown as CareWorkspaceAssertion,
        signCareWorkspaceAssertion(
          { ...careAssertion, integrationCode, assertionId: 'x' } as unknown as CareWorkspaceAssertion,
          SECRET,
        ),
      ),
      (error: any) => error.statusCode === 401 &&
        error.code === 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED',
      'a TENANT_PIC integration cannot attest a care actor',
    );
  });

  it('refuses forged, tampered, absent and malformed signatures identically', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const repr = {
      tenantCompanyId: fx.tenantCompanyId,
      buildingId: fx.buildingId,
      tenantPicId: fx.picId,
    };
    const honest = assertion(repr);
    assertUniform401(await admission(honest, sign(honest, 'the-wrong-secret-entirely')), 'forged secret (T2)');
    // The signature covers the canonical payload, so any swap after signing is
    // a signature failure — including the two that would matter most.
    assertUniform401(
      await admission({ ...honest, representation: { ...repr, tenantPicId: fx.otherTenantPicId } }, sign(honest)),
      'swapped PIC after signing (T1)',
    );
    assertUniform401(
      await admission(
        { ...honest, representation: { ...repr, tenantCompanyId: fx.otherTenantCompanyId } },
        sign(honest),
      ),
      'swapped tenant after signing (T7)',
    );
    assertUniform401(await admission(honest, null), 'no signature header (T2)');
    assertUniform401(await admission(honest, 'sha256=' + '0'.repeat(63)), 'malformed header');
    assertUniform401(await admission(honest, 'not-a-signature-at-all'), 'garbage header');
    // The untouched payload of the same shape works, so none of the refusals
    // above can be explained away by a broken fixture.
    assert.equal((await admission(honest, sign(honest))).status, 201);
  });

  it('enforces the assertion window, the future-issue rule, and the 300s cap', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const repr = { tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['expired', { issuedAt: iso(-400), expiresAt: iso(-60) }],
      ['future-issued', { issuedAt: iso(120), expiresAt: iso(220) }],
      ['window over 300s', { issuedAt: iso(-301), expiresAt: iso(60) }],
      ['inverted window', { issuedAt: iso(60), expiresAt: iso(-60) }],
      ['equal instants', { issuedAt: iso(0), expiresAt: iso(0) }],
      ['expires exactly now', { issuedAt: iso(-100), expiresAt: isoAt(secondFloor(Date.now())) }],
    ];
    for (const [label, over] of cases) {
      const body = assertion(repr, over);
      await unthrottled(async () => {
        assertUniform401(await admission(body, sign(body)), `rule 4: ${label}`);
      });
    }
    // Exactly at the cap is inside the contract (`<= 300s`), which keeps the
    // boundary a measured fact instead of an off-by-one assumption.
    const base = secondFloor(Date.now() - 299_000);
    const edge = assertion(repr, { issuedAt: isoAt(base), expiresAt: isoAt(base + 300_000) });
    assert.equal((await admission(edge, sign(edge))).status, 201);
    const overCap = assertion(repr, { issuedAt: isoAt(base), expiresAt: isoAt(base + 301_000) });
    assertUniform401(await admission(overCap, sign(overCap)), 'rule 4: window 301s');
  });

  it('requires an ACTIVE integration that holds the TENANT_PIC capability', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const repr = {
      tenantCompanyId: fx.tenantCompanyId,
      buildingId: fx.buildingId,
      tenantPicId: fx.picId,
    };
    const viaCare = assertion(repr, { integrationCode: careCode });
    assertUniform401(await admission(viaCare, sign(viaCare, CARE_SECRET)), 'CUSTOMER_CARE integration');
    const legacyCode = `LEGT_${suffix()}`;
    await handoffRuntimeRepository.createIntegration({
      integrationCode: legacyCode,
      displayName: '03C legacy integration',
    });
    process.env[handoffIntegrationSecretEnvName(legacyCode)] = SECRET;
    const viaLegacy = assertion(repr, { integrationCode: legacyCode });
    assertUniform401(await admission(viaLegacy, sign(viaLegacy)), 'NONE capability');
    const unknown = assertion(repr, { integrationCode: `NOPE_${suffix()}` });
    assertUniform401(await admission(unknown, sign(unknown)), 'unknown integration code');

    const token = await admit(fx);
    assert.equal((await introspect(token)).status, 200);
    await q(
      `UPDATE handyman_handoff_integrations SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`,
      [integrationId],
    );
    try {
      assertUniform401(await introspect(token), 'inactive integration');
    } finally {
      await q(
        `UPDATE handyman_handoff_integrations SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`,
        [integrationId],
      );
    }
    // Rule 18: re-activating never resurrects the credential the transition killed.
    assertUniform401(await introspect(token), 'no resurrection after reactivation');
    const counts = await q(
      `SELECT count(*)::int AS n FROM handyman_handoff_integrations WHERE actor_capability = 'TENANT_PIC'`,
    );
    assert.equal(counts.rows[0].n, 1, 'exactly one PIC-capable integration exists here');
  });
});

// ---------------------------------------------------------------------------
// C. Replay (rule 16 / T4) and persistence uniqueness
// ---------------------------------------------------------------------------

describe('W03 PART 03C — replay protection', () => {
  it('mints one session per assertion and collapses a duplicate into the 401', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const body = assertion({
      tenantCompanyId: fx.tenantCompanyId,
      buildingId: fx.buildingId,
      tenantPicId: fx.picId,
    });
    assert.equal((await admission(body, sign(body))).status, 201);
    assertUniform401(await admission(body, sign(body)), 'replayed assertion (T4)');
    assertUniform401(await admission(body, sign(body)), 'still replayed');
    const mine = await q(
      `SELECT count(*)::int AS n FROM ${SESSION_TABLE} WHERE tenant_company_id = $1`,
      [fx.tenantCompanyId],
    );
    assert.equal(mine.rows[0].n, 1, 'a replay mints nothing');
    // A fresh assertionId for the same context is a legitimate new admission:
    // the tombstone is per (integration, assertion), not per principal.
    const fresh = { ...body, assertionId: randomUUID() };
    assert.equal((await admission(fresh, sign(fresh as any))).status, 201);
    const after = await q(
      `SELECT count(*)::int AS n FROM ${SESSION_TABLE} WHERE tenant_company_id = $1`,
      [fx.tenantCompanyId],
    );
    assert.equal(after.rows[0].n, 2);
    // Rule 12/16: two admissions of the same assertion under a DIFFERENT
    // integration are different keys (the tombstone is integration-scoped), and
    // an assertion the other integration never saw is refused on capability,
    // not on replay.
    const viaCare = { ...body, integrationCode: careCode };
    assertUniform401(await admission(viaCare, sign(viaCare, SECRET)),
      'the same assertionId under another integration is refused for capability');
  });

  it('enforces hash uniqueness and the immutable assertion tombstone', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const token = await admit(fx);
    const hash = tokenHashOf(token);
    await assert.rejects(
      () => q(
        `INSERT INTO ${SESSION_TABLE}
           (id, integration_id, tenant_company_id, tenant_pic_id, building_id,
            space_id, tenant_building_context_id, assertion_id, token_hash,
            created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8, now(), now() + interval '60 seconds')`,
        [randomUUID(), integrationId, fx.tenantCompanyId, fx.picId, fx.buildingId,
          fx.occupancyId, randomUUID(), hash],
      ),
      /duplicate key value|unique constraint/i,
      'one hash identifies exactly one session',
    );
    const row = await q(
      `SELECT tenant_building_context_id AS occupancy, revoked_at FROM ${SESSION_TABLE} WHERE token_hash = $1`,
      [hash],
    );
    assert.equal(row.rows[0].occupancy, fx.occupancyId, 'the first session is untouched');
    // The tombstone cannot be erased for reuse: DELETE is refused by the guard.
    await assert.rejects(
      () => q(`DELETE FROM ${SESSION_TABLE} WHERE token_hash = $1`, [hash]),
      /cannot be deleted|23514/,
      'R8: replay history survives',
    );
  });
});

// ---------------------------------------------------------------------------
// D. Per-call authority (rule 17)
// ---------------------------------------------------------------------------

describe('W03 PART 03C — every call re-checks authority', () => {
  it('refuses a foreign-tenant PIC, an unoccupied building, and an unrelated space', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    assertUniform401(
      await admission(
        assertion({
          tenantCompanyId: fx.tenantCompanyId,
          buildingId: fx.buildingId,
          tenantPicId: fx.otherTenantPicId,
        }),
      ),
      'cross-tenant PIC (T7)',
    );
    const propertyId = (
      await q(`SELECT property_id AS p FROM buildings WHERE id = $1`, [fx.buildingId])
    ).rows[0].p as string;
    const otherBuilding = await buildingService.createBuilding({
      propertyId,
      code: `B03CY${suffix()}`,
      name: '03C Other Building',
    });
    assertUniform401(
      await admission(
        assertion({
          tenantCompanyId: fx.tenantCompanyId,
          buildingId: otherBuilding.id,
          tenantPicId: fx.picId,
        }),
      ),
      'cross-building: no context for that building',
    );
    const spaceInOtherBuilding = await (async () => {
      const floor = await floorService.createFloor({
        buildingId: otherBuilding.id, code: `F03CY${suffix()}`, name: '03C B2 Floor', levelNumber: 1,
      });
      const area = await areaService.createArea({ floorId: floor.id, code: `A03CY${suffix()}`, name: '03C B2 Area' });
      const room = await roomService.createRoom({ areaId: area.id, code: `R03CY${suffix()}`, name: '03C B2 Room' });
      return spaceService.createSpace({ roomId: room.id, code: `S03CY${suffix()}`, name: '03C B2 Space' });
    })();
    assertUniform401(
      await admission(
        assertion({
          tenantCompanyId: fx.tenantCompanyId,
          buildingId: fx.buildingId,
          spaceId: spaceInOtherBuilding.id,
        }),
      ),
      'space outside the claimed building (CR-HM-07 lineage)',
    );
    // A foreign building's id that does not exist at all: same uniform answer.
    assertUniform401(
      await admission(assertion({ tenantCompanyId: fx.tenantCompanyId, buildingId: randomUUID() })),
      'unknown building',
    );
    const persisted = await q(
      `SELECT count(*)::int AS n FROM ${SESSION_TABLE} WHERE tenant_company_id = $1`,
      [fx.tenantCompanyId],
    );
    assert.equal(persisted.rows[0].n, 0, 'every refusal above persisted nothing');
  });

  it('drops a live session on every authority transition named by rule 18', async (t) => {
    if (!requireDatabase(t)) return;
    // Third element: whether the credential is still RESOLVABLE afterwards.
    // Deactivation, re-parenting and suspension remove the rows the lookup
    // joins through, so even a courtesy logout is refused; a changed user link
    // leaves the credential resolvable, so logout stays idempotent while USE is
    // refused. The distinction is deliberate, not incidental: revocation must
    // never mean "the token secretly still works".
    const probes: Array<[string, (fx: Fixture) => Promise<void>, boolean]> = [
      ['PIC deactivated', async fx => {
        await q(`UPDATE tenant_pics SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [fx.picId]);
      }, false],
      ['PIC re-parented to another tenant (B2)', async fx => {
        await q(
          `UPDATE tenant_pics SET tenant_company_id = $2, updated_at = NOW() WHERE id = $1`,
          [fx.picId, fx.otherTenantCompanyId],
        );
      }, false],
      ['PIC user link changed (MC1\u2032 reads exactly that column)', async fx => {
        const other = await userService.createUser({
          email: `pic-link-${suffix().toLowerCase()}@example.com`,
          displayName: '03C new link',
        });
        await q(`UPDATE tenant_pics SET user_id = $2, updated_at = NOW() WHERE id = $1`, [fx.picId, other.id]);
      }, true],
      ['tenant suspended', async fx => {
        await q(
          `UPDATE tenant_companies SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`,
          [fx.tenantCompanyId],
        );
      }, false],
    ];
    for (const [label, mutate, resolvable] of probes) {
      const fx = await fixture();
      const token = await admit(fx);
      assert.equal((await introspect(token)).status, 200, `${label}: live before the transition`);
      await mutate(fx);
      assertUniform401(await introspect(token), `${label}: service path refuses use`);
      const revoked = await q(
        `SELECT revoked_at IS NOT NULL AS revoked FROM ${SESSION_TABLE} WHERE token_hash = $1`,
        [tokenHashOf(token)],
      );
      assert.equal(revoked.rows[0].revoked, true, `${label}: the trigger revoked the row`);
      if (resolvable) {
        await revokePicWorkspaceSession(token);
        const stillOnce = await q(
          `SELECT revoked_at IS NOT NULL AS revoked FROM ${SESSION_TABLE} WHERE token_hash = $1`,
          [tokenHashOf(token)],
        );
        assert.equal(stillOnce.rows[0].revoked, true, `${label}: still exactly one revocation`);
      } else {
        await assert.rejects(
          () => revokePicWorkspaceSession(token),
          (error: any) => error.statusCode === 401 && error.code === UNAUTHORIZED,
          `${label}: a removed authority takes the logout path with it`,
        );
      }
      // A second use after the transition is refused no matter which shape the
      // logout took — the credential never comes back.
      assertUniform401(await introspect(token), `${label}: still refused after logout`);
    }
  });

  it('drops a live session when occupancy lapses with nothing to trigger on', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const token = await admit(fx);
    // The context row stays ACTIVE and its status never changes: only its
    // effective window closes, so no revocation trigger fires at all. Rule 17's
    // re-resolution is the mechanism that catches this.
    await q(
      `UPDATE tenant_building_contexts SET effective_until = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [fx.occupancyId],
    );
    assertUniform401(await introspect(token), 'lapsed occupancy, no trigger');
    const notRevoked = await q(
      `SELECT revoked_at FROM ${SESSION_TABLE} WHERE token_hash = $1`,
      [tokenHashOf(token)],
    );
    assert.equal(notRevoked.rows[0].revoked_at, null,
      'nothing revoked the row: the per-call check did the work');

    // A space narrowing that closes the same way is caught too, and the space
    // id survives the session that legitimately carries it.
    const fx2 = await fixture();
    const withSpace = await admit(fx2);
    const view = await introspect(withSpace);
    assert.equal(view.status, 200);
    assert.equal(view.body.data.spaceId, fx2.spaceId);
    await q(
      `UPDATE tenant_space_relationships SET status = 'INACTIVE', updated_at = NOW()
        WHERE tenant_company_id = $1 AND building_id = $2 AND space_id = $3`,
      [fx2.tenantCompanyId, fx2.buildingId, fx2.spaceId],
    );
    assertUniform401(await introspect(withSpace), 'space relationship closed mid-session');
  });

  it('never authorizes a token that expired while it waited on a row lock', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const client = await pool!.connect();
    const previous = process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
    // The TTL is a deployment knob (rule 15), so a 1-second session is legal —
    // which is what makes "expired during the wait" reachable in a test.
    process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = '1';
    try {
      const token = await admit(fx);
      assert.equal((await introspect(token)).status, 200);
      await client.query('BEGIN');
      await client.query(
        `SELECT id FROM ${SESSION_TABLE} WHERE token_hash = $1 FOR UPDATE`,
        [tokenHashOf(token)],
      );
      const pending = resolvePicWorkspacePrincipal(token);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      await client.query('COMMIT');
      let failure: { statusCode?: number; code?: string } | null = null;
      try {
        await pending;
        assert.fail('a credential that expired during a lock wait must not authorize');
      } catch (error) {
        failure = error as { statusCode?: number; code?: string };
      }
      assert.equal(failure!.statusCode, 401, 'rule 17 last sentence');
      assert.equal(failure!.code, UNAUTHORIZED);
    } finally {
      if (previous === undefined) delete process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
      else process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = previous;
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('clamps the deployment TTL knob and accepts no per-request TTL claim', async (t) => {
    if (!requireDatabase(t)) return;
    const previous = process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
    try {
      process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = '86400';
      const fx = await fixture();
      const response = await admission(
        assertion({
          tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId, tenantPicId: fx.picId,
        }),
      );
      assert.equal(response.status, 201);
      const life = await q(
        `SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) AS secs FROM ${SESSION_TABLE}
          ORDER BY created_at DESC LIMIT 1`,
      );
      const seconds = Number(life.rows[0].secs);
      assert.ok(seconds > 0 && seconds <= PIC_WORKSPACE_MAX_TTL_SECONDS,
        `a knob above the ceiling must be clamped, got ${seconds}s`);
      const asking = assertion({
        tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId, ttlSeconds: 999_999,
      });
      assertUniform401(await admission(asking, sign(asking)), 'ttlSeconds is not vocabulary');
    } finally {
      if (previous === undefined) delete process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
      else process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// E. Credential-kind separation (T6, rule 19)
// ---------------------------------------------------------------------------

describe('W03 PART 03C — no fallback between credential kinds', () => {
  it('refuses a care token at the PIC route, a PIC token at the care route, and any local bearer', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const picToken = await admit(fx);
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
    assert.ok((careAdmitted as { workspaceToken: string }).workspaceToken.startsWith('hcw_'));

    assertUniform401(
      await introspect((careAdmitted as { workspaceToken: string }).workspaceToken),
      'an hcw_ token at the PIC router',
    );
    await assert.rejects(
      () => resolveCareWorkspacePrincipal(picToken),
      (error: any) => error.statusCode === 401 &&
        error.code === 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED',
      'a PIC token must never resolve as a care principal',
    );
    // Identical header syntax does not make a staff bearer a PIC credential:
    // no `authenticationMiddleware` participates in this surface (A1/A2).
    const staff = await createAdminUser();
    assertUniform401(await introspect(staff.token), 'staff bearer at the PIC router');
    assertUniform401(
      await api()
        .get('/api/v1/handyman/pic/session')
        .set('authorization', `Basic ${Buffer.from('x:y').toString('base64')}`),
      'non-Bearer scheme',
    );
    assertUniform401(await introspect(picToken.slice(0, -1)), 'mutilated token');
    assertUniform401(await introspect(picToken + 'x'), 'padded token');
    // And no PIC-side traffic ever touched the care store, or vice versa.
    const careRows = await q(
      `SELECT count(*)::int AS n FROM handyman_care_workspace_sessions WHERE integration_id = $1`,
      [careIntegrationId],
    );
    assert.equal(careRows.rows[0].n, 1, 'exactly the one legitimate care admission');
    const picRows = await q(
      `SELECT count(*)::int AS n FROM ${SESSION_TABLE} WHERE tenant_company_id = $1`,
      [fx.tenantCompanyId],
    );
    assert.equal(picRows.rows[0].n, 1, 'exactly the one legitimate PIC admission');
  });

  it('keeps the surface credential-only: no business route, no staff middleware, no shared table', async () => {
    const dir = join(process.cwd(), 'src', 'modules', 'handyman-pic-session');
    const sources = [
      'pic-workspace-session.routes.ts',
      'pic-workspace-session.service.ts',
      'pic-workspace-session.repository.ts',
      'index.ts',
    ].map(file => readFileSync(join(dir, file), 'utf8'));
    // Prose is allowed to NAME the things this module must not call — the
    // comments explain why they are absent. Scan the code, not the argument.
    const all = sources
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    for (const forbidden of [
      'authenticationMiddleware',
      'requirePermission',
      'user_sessions',
      'auth/session',
      'resolveSessionContext',
      'handyman_handoff_exchanges',
      'handyman_care_workspace_sessions',
      'handyman_quotation_decisions',
      'handyman_execution_scopes',
      'handyman_quotation_approval_bindings',
    ]) {
      assert.ok(
        !all.includes(forbidden),
        `the PIC credential module must not touch ${forbidden} (A2/A7/rule 19)`,
      );
    }
    // Release safety: no decision endpoint may exist in this PART, and no
    // binding surface either.
    for (const path of [
      '/api/v1/handyman/pic/quotation-versions/x/decision',
      '/api/v1/handyman/pic/requests/' + randomUUID(),
      '/api/v1/handyman/pic/quotations/' + randomUUID() + '/approval-binding',
    ]) {
      assert.equal((await api().post(path).send({})).status, 404, `${path} must not exist yet`);
    }
    for (const verb of ['put', 'patch'] as const) {
      const response = await (api() as any)[verb]('/api/v1/handyman/pic/session').send({});
      assert.equal(response.status, 404, `only POST/GET/DELETE are contracted (${verb})`);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Revocation (rule 18)
// ---------------------------------------------------------------------------

describe('W03 PART 03C — revocation', () => {
  it('logs out idempotently while unexpired, journals once, and never revives', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const token = await admit(fx);
    const sessionId = await sessionIdOf(token);
    assert.equal((await logout(token)).status, 204);
    assertUniform401(await introspect(token), 'a revoked credential cannot be used');
    // Rule 18: the second logout of the SAME still-unexpired revoked token is
    // idempotent — "already revoked" is not a new authority, and it must not
    // produce a second write or a second journal event either.
    assert.equal((await logout(token)).status, 204);
    await revokePicWorkspaceSession(token);
    const events = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE entity_type = 'HANDYMAN_PIC_WORKSPACE_SESSION'
          AND entity_id = $1 AND event_type = $2`,
      [sessionId, 'HANDYMAN_PIC_WORKSPACE_SESSION_REVOKED'],
    );
    assert.equal(events.rows[0].n, 1, 'one revocation, one journal row');
    const row = await q(
      `SELECT revoked_at FROM ${SESSION_TABLE} WHERE id = $1`,
      [sessionId],
    );
    assert.ok(row.rows[0].revoked_at instanceof Date);
    await assert.rejects(
      () => readPicWorkspaceSession(token),
      (error: any) => error.statusCode === 401,
      'revoked, not resurrected',
    );
  });

  it('refuses an expired credential at logout rather than granting 204', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const previous = process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
    process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = '1';
    try {
      const token = await admit(fx);
      await new Promise(resolve => setTimeout(resolve, 1_400));
      // "Idempotent for an UNEXPIRED revoked token" (rule 18) means an expired
      // one gets the uniform 401 — the 204 is a courtesy for a credential that
      // is still meaningful, not a way to probe which tokens existed.
      assertUniform401(await logout(token), 'expired credential: logout is refused');
      assertUniform401(await introspect(token), 'expired credential: use is refused');
      await assert.rejects(
        () => revokePicWorkspaceSession(token),
        (error: any) => error.statusCode === 401 && error.code === UNAUTHORIZED,
        'the service path refuses too, not only the router',
      );
      // Expiry is not revocation: the row is untouched, which is what keeps the
      // two facts separately auditable.
      const row = await q(
        `SELECT revoked_at IS NULL AS unrevealed FROM ${SESSION_TABLE} WHERE token_hash = $1`,
        [tokenHashOf(token)],
      );
      assert.equal(row.rows[0].unrevealed, true);
    } finally {
      if (previous === undefined) delete process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS;
      else process.env.HANDYMAN_PIC_WORKSPACE_TTL_SECONDS = previous;
    }
  });

  it('refuses a logout that carries context fields, and one with no bearer', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const token = await admit(fx);
    const withBody = await api()
      .delete('/api/v1/handyman/pic/session')
      .set('authorization', `Bearer ${token}`)
      .send({ tenantCompanyId: fx.tenantCompanyId });
    assert.equal(withBody.status, 400);
    assert.equal(withBody.body.error.code, 'VALIDATION_ERROR');
    assert.equal((await logout(token)).status, 204);
    assert.equal((await api().delete('/api/v1/handyman/pic/session')).status, 401);
    assert.equal(
      (await api().delete('/api/v1/handyman/pic/session').set('authorization', 'Bearer nope')).status,
      401,
    );
  });
});

// ---------------------------------------------------------------------------
// G. Throttle (rule 7) and audit (item 9)
// ---------------------------------------------------------------------------

describe('W03 PART 03C — throttle and audit trail', () => {
  it('throttles failures in its own namespace, resets on success, and does not charge a 429', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const { loginRateLimitMaxAttempts } = getAppConfig().security;
    const good = assertion({ tenantCompanyId: fx.tenantCompanyId, buildingId: fx.buildingId });
    for (let i = 0; i < loginRateLimitMaxAttempts; i += 1) {
      assertUniform401(await admission(good, sign(good, 'wrong')), `failure ${i + 1}`);
    }
    const limited = await admission(good, sign(good));
    assert.equal(limited.status, 429, 'the failure budget is spent');
    assert.match(String(limited.headers['retry-after']), /^\d+$/, 'Retry-After present');
    // The 429 itself was not charged to the key: clearing it (as a success
    // would) restores admission immediately.
    clearLoginRateLimits();
    assert.equal((await admission(good, sign(good))).status, 201);
    // Isolated namespace: hammering PIC admission must not lock out care
    // admission — the two share the convention, never the counter.
    for (let i = 0; i < loginRateLimitMaxAttempts + 2; i += 1) {
      await admission(good, sign(good, 'wrong'));
    }
    const careAttempt = await api()
      .post('/api/v1/handyman/care/session')
      .set('x-hub-signature-256', 'sha256=' + '1'.repeat(64))
      .send({});
    assert.equal(careAttempt.status, 401, 'the care namespace stayed live');
  });

  it('journals admission and revocation with ids only — no PII, no credential', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const token = await admit(fx);
    const sessionId = await sessionIdOf(token);
    await revokePicWorkspaceSession(token);
    const rows = await q(
      `SELECT event_type, entity_type, entity_id, actor_user_id, client_id,
              building_id, summary, metadata::text AS metadata
         FROM operational_events
        WHERE entity_type = 'HANDYMAN_PIC_WORKSPACE_SESSION' AND entity_id = $1
        ORDER BY created_at`,
      [sessionId],
    );
    assert.equal(rows.rows.length, 2, 'one admission, one revocation');
    const admitted = rows.rows[0] as Record<string, unknown>;
    assert.equal(admitted.event_type, 'HANDYMAN_PIC_WORKSPACE_SESSION_ADMITTED');
    assert.equal(rows.rows[1].event_type, 'HANDYMAN_PIC_WORKSPACE_SESSION_REVOKED');
    // A2: a PIC has no local user, and the journal must not invent one.
    assert.equal(admitted.actor_user_id, null);
    assert.equal(rows.rows[1].actor_user_id, null);
    assert.equal(admitted.client_id, fx.clientId);
    assert.equal(admitted.building_id, fx.buildingId);
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const metadataKeys = Object.keys(JSON.parse(String(row.metadata))).sort();
      const expectedKeys = [
        'buildingId', 'canDecide', 'expiresAt', 'integrationId', 'sessionId',
        'spaceId', 'tenantCompanyId', 'tenantPicId',
      ];
      assert.deepEqual(
        metadataKeys,
        row === admitted ? expectedKeys : [...expectedKeys, 'revokedAt'].sort(),
        'the journal carries ids and the window only, plus revokedAt on the revocation',
      );
      const blob = `${row.summary} ${row.metadata}`;
      assert.ok(!blob.includes(token), 'token never journalled');
      assert.ok(!blob.includes(tokenHashOf(token)), 'hash never journalled');
      for (const banned of ['pic_name', 'email', 'phone', 'password', 'secret', 'name', 'token']) {
        assert.ok(!new RegExp(`"${banned}"`).test(String(row.metadata)), `no ${banned} key`);
      }
      assert.ok(!/PIC [0-9A-F]{8}/.test(String(row.summary)), 'no PIC display name in the summary');
    }
  });
});

// ---------------------------------------------------------------------------
// H. The database floor (0441 guard, capability widening, 0442 ledger clauses)
// ---------------------------------------------------------------------------

describe('W03 PART 03C — the database floor', () => {
  it('permits exactly the first revocation and refuses renewal, re-issuing, and deletion', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const token = await admit(fx);
    const id = await sessionIdOf(token);
    for (const [label, sql, params] of [
      ['renewal (no sliding expiry is representable)',
        `UPDATE ${SESSION_TABLE} SET expires_at = expires_at + interval '60 seconds' WHERE id = $1`, [id]],
      ['re-issuing the token', `UPDATE ${SESSION_TABLE} SET token_hash = repeat('0',64) WHERE id = $1`, [id]],
      ['promoting a read-only session into a deciding one',
        `UPDATE ${SESSION_TABLE} SET tenant_pic_id = $2 WHERE id = $1`, [id, fx.picId]],
      ['widening the tenant or the building',
        `UPDATE ${SESSION_TABLE} SET tenant_company_id = $2 WHERE id = $1`, [id, fx.otherTenantCompanyId]],
      ['erasing history', `DELETE FROM ${SESSION_TABLE} WHERE id = $1`, [id]],
      ['expiry cleanup', `DELETE FROM ${SESSION_TABLE} WHERE expires_at < now()`, []],
      ['tombstone cleanup', `DELETE FROM ${SESSION_TABLE} WHERE true`, []],
    ] as const) {
      await assert.rejects(
        () => q(sql, [...params]),
        /Only PIC workspace revocation is permitted|cannot be deleted/,
        `${label} must be refused by the guard`,
      );
    }
    // The one legal write, then its permanent consequence.
    assert.equal((await logout(token)).status, 204);
    for (const sql of [
      `UPDATE ${SESSION_TABLE} SET revoked_at = NULL WHERE id = $1`,
      `UPDATE ${SESSION_TABLE} SET revoked_at = now() WHERE id = $1`,
    ]) {
      await assert.rejects(
        () => q(sql, [id]),
        /Only PIC workspace revocation is permitted/,
        'revocation is one-way and one-time',
      );
    }
    // Rule 15 as a CHECK, not a convention: no window outside
    // `created_at < expires_at <= created_at + 15 minutes` is storable, no
    // matter who tries to write it.
    for (const [label, expires] of [
      ['16 minutes', "now() + interval '16 minutes'"],
      ['zero length', 'now()'],
      ['negative', "now() - interval '1 second'"],
    ] as const) {
      await assert.rejects(
        () => q(
          `INSERT INTO ${SESSION_TABLE}
             (id, integration_id, tenant_company_id, tenant_pic_id, building_id,
              space_id, tenant_building_context_id, assertion_id, token_hash,
              created_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8, now(), ${expires})`,
          [randomUUID(), integrationId, fx.tenantCompanyId, fx.picId, fx.buildingId,
            fx.occupancyId, randomUUID(), tokenHashOf(randomUUID())],
        ),
        /violates check constraint|23514/,
        `rule 15 window: ${label}`,
      );
    }
    await assert.rejects(
      () => q(
        `INSERT INTO ${SESSION_TABLE}
           (id, integration_id, tenant_company_id, tenant_pic_id, building_id,
            space_id, tenant_building_context_id, assertion_id, token_hash,
            created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,'deadbeef', now(), now() + interval '60 seconds')`,
        [randomUUID(), integrationId, fx.tenantCompanyId, fx.picId, fx.buildingId,
          fx.occupancyId, randomUUID()],
      ),
      /violates check constraint|23514/,
      'a token_hash that is not sha256 hex64 is not storable',
    );
  });

  it('treats TENANT_PIC as an attestation right and nothing else', async (t) => {
    if (!requireDatabase(t)) return;
    const definition = await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'handyman_handoff_integrations_actor_capability_check'`,
    );
    assert.ok(definition.rows[0].def.includes('TENANT_PIC'), 'rule 20 widening applied');
    assert.ok(definition.rows[0].def.includes('NONE'), 'legacy values preserved');
    await assert.rejects(
      () => q(
        `UPDATE handyman_handoff_integrations SET actor_capability = 'PLATFORM_ADMIN' WHERE id = $1`,
        [integrationId],
      ),
      /violates check constraint|23514/,
      'no vocabulary beyond the three is representable',
    );
    // Rule 21: the capability is an ATTESTATION RIGHT only. A care actor row
    // can be provisioned under any integration (the registry is operational),
    // but a TENANT_PIC integration can never USE one: `resolveActor` demands
    // 'CUSTOMER_CARE', which is exactly the property that keeps the widening
    // from becoming a cross-kind grant.
    await assert.rejects(
      () => handymanCareActorService.createCareActor({
        integrationId,
        actorReference: `pic-side-${suffix()}`,
        displayName: 'registered under the PIC integration',
      }),
      /CUSTOMER_CARE|capability/i,
      'the care registry itself refuses a TENANT_PIC integration (rule 21)',
    );
    const careViaPicIntegration = {
      purpose: 'HANDYMAN_CARE_WORKSPACE',
      integrationCode,
      assertionId: randomUUID(),
      issuedAt: iso(-2),
      expiresAt: iso(120),
      actor: { type: 'CUSTOMER_CARE', actorReference: careActorReference },
    } as unknown as CareWorkspaceAssertion;
    let careFailure: { statusCode?: number; code?: string } | null = null;
    try {
      await admitCareWorkspace(
        careViaPicIntegration,
        signCareWorkspaceAssertion(careViaPicIntegration, SECRET),
      );
      assert.fail('a care session must not be mintable via a TENANT_PIC integration');
    } catch (error) {
      careFailure = error as { statusCode?: number; code?: string };
    }
    assert.ok(careFailure, 'a care session must not be mintable via a TENANT_PIC integration');
    assert.equal(careFailure!.statusCode, 401);
    assert.equal(careFailure!.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    // And even a correctly signed care assertion naming this integration is
    // refused at the capability gate: the right to attest a PIC buys nothing
    // on the care side. No session was ever minted there.
    const careSessions = await q(
      `SELECT count(*)::int AS n FROM handyman_care_workspace_sessions WHERE integration_id = $1`,
      [integrationId],
    );
    assert.equal(careSessions.rows[0].n, 0, 'the PIC integration minted no care session');
  });

  it('closes 03B deviation D1: the ledger now demands the credential it was told to record', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const token = await admit(fx);
    const sessionId = await sessionIdOf(token);
    const columns = `(id, client_id, quotation_id, quotation_version_id, decision,
        tenant_company_id, tenant_pic_id, decided_by_user_id, idempotency_key,
        request_fingerprint, decision_actor_type, decided_by_tenant_pic_id,
        approval_binding_id, decided_by_pic_session_id)`;
    // CHECK constraints are evaluated before FK triggers, so an
    // otherwise-impossible thread id still reaches the CHECK — but the ledger's
    // own INSERT guard fires first, so the guard is disabled INSIDE the
    // transaction and the transaction is rolled back. The rollback restoring the
    // guard is then PROVED, not assumed (the trap this suite names for itself).
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE handyman_quotation_decisions DISABLE TRIGGER handyman_quotation_decision_no_write',
      );
      let attempt = 0;
      for (const [label, actorClass, picId, decidedByUser, session, binding, expected] of [
        ['a USER row carrying a PIC session', 'USER', null, randomUUID(), sessionId, null,
          /handyman_quotation_decisions_actor_identity_check/],
        ['a TENANT_PIC row with no session', 'TENANT_PIC', fx.picId, null, null, null,
          /handyman_quotation_decisions_actor_identity_check/],
        ['a USER row naming a signing PIC', 'USER', fx.picId, randomUUID(), null, null,
          /handyman_quotation_decisions_actor_identity_check/],
        ['a PIC row with a session but no binding', 'TENANT_PIC', fx.picId, null, sessionId, null,
          /handyman_quotation_decisions_binding_check/],
      ] as const) {
        attempt += 1;
        const savepoint = `sp_${attempt}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        await assert.rejects(
          () => client.query(
            `INSERT INTO handyman_quotation_decisions
               ${columns}
             VALUES ($1,$2,$3,$4,'APPROVE',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [randomUUID(), fx.clientId, randomUUID(), randomUUID(), fx.tenantCompanyId,
              picId, decidedByUser, `k-${randomUUID()}`, 'a'.repeat(64), actorClass,
              picId, binding, session],
          ),
          expected,
          `${label} must be refused by the re-created CHECK`,
        );
        // Abort only this attempt: a constraint failure poisons the enclosing
        // transaction, so without the savepoint the SECOND case would be
        // "passed" by a 25P02 message instead of by the CHECK under test.
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // The guard is live again: a USER-class insert is refused by the TRIGGER's
    // own message, which is only reachable if 0438's INSERT coverage survived.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_quotation_decisions
           (id, client_id, quotation_id, quotation_version_id, decision,
            tenant_company_id, decided_by_user_id, idempotency_key,
            request_fingerprint, decision_actor_type)
         VALUES ($1,$2,$3,$4,'APPROVE',$5,$6,$7,$8,'USER')`,
        [randomUUID(), fx.clientId, randomUUID(), randomUUID(), fx.tenantCompanyId,
          randomUUID(), `k-${randomUUID()}`, 'b'.repeat(64)],
      ),
      /Only an attested Tenant PIC may decide/,
      '0438\u2019s INSERT guard must still refuse after the rolled-back experiment',
    );
    // The session columns are real FKs, not bare UUIDs — proved at the catalog
    // level, because no legal PIC decision row can be produced without a full
    // thread, which 03E exercises end-to-end.
    for (const [table, column] of [
      ['handyman_quotation_decisions', 'decided_by_pic_session_id'],
      ['handyman_execution_scopes', 'created_by_pic_session_id'],
    ] as const) {
      const fk = await q(
        `SELECT confrelid::regclass::text AS target
           FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'f'
            AND conkey = (SELECT ARRAY[a.attnum] FROM pg_attribute a
                           WHERE a.attrelid = $1::regclass AND a.attname = $2)`,
        [table, column],
      );
      assert.deepEqual(fk.rows.map(r => r.target), [SESSION_TABLE],
        `${table}.${column} must reference the session store`);
    }
  });
});
