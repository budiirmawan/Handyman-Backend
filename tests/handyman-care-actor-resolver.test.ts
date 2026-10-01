import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  handymanCareActorRepository,
  handymanCareActorService,
  resolveCareActorClaim,
  type PublicHandymanCareActor,
  type ResolvedCareActorProvenance,
} from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 AMENDMENT 01 PART 08 — focused tests for the attested Customer
 * Care actor resolver (governance amendment §3.3/§4).
 *
 * Scope: structural validation of the untrusted actor block, integration
 * ACTIVE + CUSTOMER_CARE capability enforcement, integration-scoped ACTIVE
 * registry resolution, non-enumerating fail-closed semantics, authoritative
 * provenance output, and absence of side effects (no user/PIC resolution, no
 * session/RBAC, no attribution, no exchange). No assertion/exchange wiring is
 * exercised — that is PART 09.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55488;
const DIR = '/tmp/asentra-part08-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(PORT),
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'asentra_test',
    DB_SSL: 'false',
  });
}

const ASSERTION_INVALID = 'HANDYMAN_HANDOFF_ASSERTION_INVALID';
const ASSERTION_INVALID_MESSAGE = 'Invalid or expired handoff assertion.';

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED) {
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
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  if (!config) return;
  database = config;
  pool = await initDatabase(config);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_handoff_care_actors,
    handyman_channel_attributions, handyman_handoff_exchanges,
    handyman_handoff_assertions, handyman_handoff_integrations,
    user_sessions, user_role_assignments, users, roles, permissions,
    clients CASCADE`);
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('PART 08 PostgreSQL unavailable');
    return false;
  }
  return true;
}

function getPool(): Pool {
  if (!pool) throw new Error('PART 08 test pool is not initialised.');
  return pool;
}

type Failure = { code?: string; message?: string; statusCode?: number };

async function captureFailure(run: () => Promise<unknown>): Promise<Failure> {
  let captured: Failure | null = null;
  try {
    await run();
  } catch (error) {
    captured = error as Failure;
  }
  assert.ok(captured, 'expected the resolver to fail closed');
  return captured;
}

function assertAssertionInvalid(failure: Failure): void {
  assert.equal(failure.code, ASSERTION_INVALID);
  assert.equal(failure.message, ASSERTION_INVALID_MESSAGE);
  assert.equal(failure.statusCode, 401);
}

async function legacyIntegration(): Promise<{ id: string; code: string }> {
  const code = `BM_LEGACY_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode: code,
    displayName: 'Legacy BM integration',
  });
  return { id: integration.id, code: integration.integrationCode };
}

async function careIntegration(): Promise<{ id: string; code: string }> {
  const integration = await legacyIntegration();
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: integration.id,
    capability: 'CUSTOMER_CARE',
  });
  return integration;
}

async function registerActor(integrationId: string): Promise<PublicHandymanCareActor> {
  return handymanCareActorService.createCareActor({
    integrationId,
    actorReference: `CC_${suffix()}`,
    displayName: 'Customer Care Agent',
  });
}

function claimOf(actor: PublicHandymanCareActor) {
  return { type: 'CUSTOMER_CARE' as const, actorReference: actor.actorReference };
}

async function count(table: string): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number.parseInt(result.rows[0].count, 10);
}

describe('CR-HM-01 A01 PART 08 — attested Customer Care actor resolver', () => {
  it('resolves an ACTIVE capability-scoped registration to authoritative provenance', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();
    const actor = await registerActor(integration.id);

    const resolved = await resolveCareActorClaim({
      integrationCode: integration.code,
      actorClaim: claimOf(actor),
    });

    assert.deepEqual(Object.keys(resolved).sort(), [
      'actorReference',
      'actorType',
      'careActorId',
      'integrationCode',
      'integrationId',
    ]);
    assert.equal(resolved.careActorId, actor.id);
    assert.equal(resolved.actorType, 'CUSTOMER_CARE');
    assert.equal(resolved.integrationId, integration.id);
    assert.equal(resolved.integrationCode, integration.code);
    assert.equal(resolved.actorReference, actor.actorReference);
    assert.ok(Object.isFrozen(resolved));
  });

  it('fails closed for an unknown integration code', async (t) => {
    if (!ready(t)) return;
    const actor = await registerActor((await careIntegration()).id);

    assertAssertionInvalid(
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: `BM_UNKNOWN_${suffix()}`,
          actorClaim: claimOf(actor),
        }),
      ),
    );
  });

  it('fails closed for an INACTIVE integration', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();
    const actor = await registerActor(integration.id);
    await getPool().query(
      `UPDATE handyman_handoff_integrations SET status = 'INACTIVE' WHERE id = $1`,
      [integration.id],
    );

    assertAssertionInvalid(
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: claimOf(actor),
        }),
      ),
    );
  });

  it('fails closed for an integration without the CUSTOMER_CARE capability', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();
    const actor = await registerActor(integration.id);
    await handymanCareActorService.setIntegrationActorCapability({
      integrationId: integration.id,
      capability: 'NONE',
    });

    assertAssertionInvalid(
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: claimOf(actor),
        }),
      ),
    );
  });

  it('fails closed for an unknown actor reference', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();

    assertAssertionInvalid(
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: { type: 'CUSTOMER_CARE', actorReference: `CC_${suffix()}` },
        }),
      ),
    );
  });

  it('fails closed for an INACTIVE registry row and recovers on reactivation', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();
    const actor = await registerActor(integration.id);
    await handymanCareActorService.deactivateCareActor(actor.id);

    assertAssertionInvalid(
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: claimOf(actor),
        }),
      ),
    );

    await handymanCareActorService.activateCareActor(actor.id);
    const resolved = await resolveCareActorClaim({
      integrationCode: integration.code,
      actorClaim: claimOf(actor),
    });
    assert.equal(resolved.careActorId, actor.id);
  });

  it('fails closed when the actor belongs to a DIFFERENT integration', async (t) => {
    if (!ready(t)) return;
    const integrationA = await careIntegration();
    const integrationB = await careIntegration();
    const actor = await registerActor(integrationA.id);

    // Same reference is legitimately registered under both integrations: the
    // resolution must bind to the attesting integration, never cross over.
    const otherActor = await handymanCareActorService.createCareActor({
      integrationId: integrationB.id,
      actorReference: actor.actorReference,
      displayName: 'Agent B',
    });

    const resolvedA = await resolveCareActorClaim({
      integrationCode: integrationA.code,
      actorClaim: claimOf(actor),
    });
    const resolvedB = await resolveCareActorClaim({
      integrationCode: integrationB.code,
      actorClaim: claimOf(otherActor),
    });
    assert.equal(resolvedA.careActorId, actor.id);
    assert.equal(resolvedB.careActorId, otherActor.id);
    assert.notEqual(resolvedA.careActorId, resolvedB.careActorId);

    // A reference that exists ONLY on integration A cannot be resolved
    // through integration B.
    const soloActor = await handymanCareActorService.createCareActor({
      integrationId: integrationA.id,
      actorReference: `CC_SOLO_${suffix()}`,
      displayName: 'Solo Agent',
    });
    assertAssertionInvalid(
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integrationB.code,
          actorClaim: claimOf(soloActor),
        }),
      ),
    );
  });

  it('fails closed for every structural defect in the actor block', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();
    const actor = await registerActor(integration.id);
    const defectiveClaims: unknown[] = [
      undefined,
      null,
      'CUSTOMER_CARE',
      42,
      [],
      {},
      { actorReference: actor.actorReference },
      { type: 'CUSTOMER_CARE' },
      { type: 'ADMIN', actorReference: actor.actorReference },
      { type: 'customer_care', actorReference: actor.actorReference },
      { type: 'CUSTOMER_CARE', actorReference: 42 },
      { type: 'CUSTOMER_CARE', actorReference: '   ' },
      { type: 'CUSTOMER_CARE', actorReference: 'x'.repeat(129) },
      {
        type: 'CUSTOMER_CARE',
        actorReference: actor.actorReference,
        capability: 'CUSTOMER_CARE',
      },
      { type: 'CUSTOMER_CARE', actorReference: actor.actorReference, careActorId: actor.id },
    ];

    for (const actorClaim of defectiveClaims) {
      assertAssertionInvalid(
        await captureFailure(() =>
          resolveCareActorClaim({ integrationCode: integration.code, actorClaim }),
        ),
      );
    }
  });

  it('is non-enumerating: every failure mode is byte-identical', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();
    const other = await careIntegration();
    const actor = await registerActor(integration.id);
    const inactive = await registerActor(integration.id);
    await handymanCareActorService.deactivateCareActor(inactive.id);

    const failures: Failure[] = [
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: `BM_UNKNOWN_${suffix()}`,
          actorClaim: claimOf(actor),
        }),
      ),
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: other.code,
          actorClaim: claimOf(actor),
        }),
      ),
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: { type: 'CUSTOMER_CARE', actorReference: `CC_${suffix()}` },
        }),
      ),
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: claimOf(inactive),
        }),
      ),
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: { type: 'SUPERVISOR', actorReference: actor.actorReference },
        }),
      ),
      await captureFailure(() =>
        resolveCareActorClaim({
          integrationCode: integration.code,
          actorClaim: undefined,
        }),
      ),
    ];

    const fingerprints = new Set(
      failures.map((failure) =>
        JSON.stringify({
          code: failure.code,
          message: failure.message,
          statusCode: failure.statusCode,
        }),
      ),
    );
    assert.equal(fingerprints.size, 1);
    for (const failure of failures) assertAssertionInvalid(failure);
  });

  it('never resolves to a local user or Tenant PIC and writes nothing', async (t) => {
    if (!ready(t)) return;
    const integration = await careIntegration();
    const actor = await registerActor(integration.id);
    const before = await handymanCareActorRepository.findById(actor.id);
    const tables = [
      'users',
      'user_sessions',
      'user_role_assignments',
      'tenant_pics',
      'tenant_companies',
      'handyman_channel_attributions',
      'handyman_handoff_exchanges',
      'handyman_handoff_assertions',
    ];
    const countsBefore = await Promise.all(tables.map((table) => count(table)));

    const resolved = await resolveCareActorClaim({
      integrationCode: integration.code,
      actorClaim: claimOf(actor),
    });
    assert.equal(resolved.careActorId, actor.id);

    const countsAfter = await Promise.all(tables.map((table) => count(table)));
    assert.deepEqual(countsAfter, countsBefore);
    assert.equal(countsAfter[0], 0); // no local user exists or was created
    assert.equal(countsAfter[3], 0); // no Tenant PIC exists or was created
    assert.equal(countsAfter[6], 0); // no exchange created

    const after = await handymanCareActorRepository.findById(actor.id);
    assert.deepEqual(after, before);
  });
});
