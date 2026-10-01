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
  type PublicHandymanCareActor,
} from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 AMENDMENT 01 PART 07 — focused tests for the Customer Care actor
 * persistence/domain foundation (governance amendment §5/§9).
 *
 * Scope: additivity/backward compatibility of the actor-capability scope,
 * the integration-scoped actor registry, the ACTIVE/INACTIVE lifecycle, and
 * the structural separation of actor identity from tenant PIC/local user.
 * No resolver, runtime, attribution, OpenAPI or session/RBAC behavior is
 * exercised here — those belong to PARTs 08–12.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55487;
const DIR = '/tmp/asentra-part07-pg';
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
    handyman_handoff_exchanges, handyman_handoff_assertions,
    handyman_handoff_integrations, user_sessions, user_role_assignments,
    users, roles, permissions, clients CASCADE`);
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
    t.skip('PART 07 PostgreSQL unavailable');
    return false;
  }
  return true;
}

async function legacyIntegration(): Promise<string> {
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode: `BM_LEGACY_${suffix()}`,
    displayName: 'Legacy BM integration',
  });
  return integration.id;
}

async function careIntegration(): Promise<string> {
  const integrationId = await legacyIntegration();
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId,
    capability: 'CUSTOMER_CARE',
  });
  return integrationId;
}

async function registerActor(integrationId: string): Promise<PublicHandymanCareActor> {
  return handymanCareActorService.createCareActor({
    integrationId,
    actorReference: `CC_${suffix()}`,
    displayName: 'Customer Care Agent',
  });
}

async function count(table: string): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number.parseInt(result.rows[0].count, 10);
}

function getPool(): Pool {
  if (!pool) throw new Error('PART 07 test pool is not initialised.');
  return pool;
}

describe('CR-HM-01 A01 PART 07 — Customer Care actor persistence', () => {
  it('migrates additively: legacy integrations keep actor capability NONE', async (t) => {
    if (!ready(t)) return;
    const integrationId = await legacyIntegration();

    const scope = await handymanCareActorService.getIntegrationActorScope(integrationId);
    assert.equal(scope.actorCapability, 'NONE');
    assert.equal(scope.status, 'ACTIVE');

    const column = await getPool().query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'handyman_handoff_integrations'
          AND column_name = 'actor_capability'`,
    );
    assert.equal(column.rowCount, 1);
    assert.equal(column.rows[0].column_default, `'NONE'::text`);
  });

  it('grants the Customer Care capability explicitly and rejects unknown values', async (t) => {
    if (!ready(t)) return;
    const integrationId = await legacyIntegration();

    const granted = await handymanCareActorService.setIntegrationActorCapability({
      integrationId,
      capability: 'CUSTOMER_CARE',
    });
    assert.equal(granted.actorCapability, 'CUSTOMER_CARE');

    const reread = await handymanCareActorService.getIntegrationActorScope(integrationId);
    assert.equal(reread.actorCapability, 'CUSTOMER_CARE');

    const revoked = await handymanCareActorService.setIntegrationActorCapability({
      integrationId,
      capability: 'NONE',
    });
    assert.equal(revoked.actorCapability, 'NONE');

    await assert.rejects(
      handymanCareActorService.setIntegrationActorCapability({
        integrationId,
        capability: 'ADMIN' as never,
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  });

  it('registers a Customer Care actor inside a capable integration', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();
    const actor = await registerActor(integrationId);

    assert.equal(actor.integrationId, integrationId);
    assert.equal(actor.status, 'ACTIVE');
    assert.equal(actor.displayName, 'Customer Care Agent');
    assert.match(actor.actorReference, /^CC_[0-9A-F]{8}$/);
    assert.equal(new Date(actor.createdAt).toISOString(), actor.createdAt);
    assert.equal(new Date(actor.updatedAt).toISOString(), actor.updatedAt);

    const stored = await handymanCareActorService.getCareActor(actor.id);
    assert.equal(stored.id, actor.id);
    assert.equal(stored.actorReference, actor.actorReference);
  });

  it('requires an ACTIVE integration holding the Customer Care capability', async (t) => {
    if (!ready(t)) return;
    const incapable = await legacyIntegration();
    await assert.rejects(
      handymanCareActorService.createCareActor({
        integrationId: incapable,
        actorReference: `CC_${suffix()}`,
        displayName: 'Customer Care Agent',
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_CARE_ACTOR_INTEGRATION_INVALID',
    );

    await assert.rejects(
      handymanCareActorService.createCareActor({
        integrationId: randomUUID(),
        actorReference: `CC_${suffix()}`,
        displayName: 'Customer Care Agent',
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_CARE_ACTOR_INTEGRATION_NOT_FOUND',
    );

    const inactive = await careIntegration();
    await getPool().query(
      `UPDATE handyman_handoff_integrations SET status = 'INACTIVE' WHERE id = $1`,
      [inactive],
    );
    await assert.rejects(
      handymanCareActorService.createCareActor({
        integrationId: inactive,
        actorReference: `CC_${suffix()}`,
        displayName: 'Customer Care Agent',
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_CARE_ACTOR_INTEGRATION_INVALID',
    );
  });

  it('scopes actor references per integration (attestation scope)', async (t) => {
    if (!ready(t)) return;
    const integrationA = await careIntegration();
    const integrationB = await careIntegration();
    const actorReference = `CC_${suffix()}`;

    const actorA = await handymanCareActorService.createCareActor({
      integrationId: integrationA,
      actorReference,
      displayName: 'Agent A',
    });
    const actorB = await handymanCareActorService.createCareActor({
      integrationId: integrationB,
      actorReference,
      displayName: 'Agent B',
    });

    assert.notEqual(actorA.id, actorB.id);
    assert.equal(actorA.integrationId, integrationA);
    assert.equal(actorB.integrationId, integrationB);
  });

  it('rejects a duplicate actor reference within one integration', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();
    const actor = await registerActor(integrationId);

    await assert.rejects(
      handymanCareActorService.createCareActor({
        integrationId,
        actorReference: actor.actorReference,
        displayName: 'Duplicate attempt',
      }),
      (error: unknown) =>
        (error as { code?: string; statusCode?: number }).code ===
          'HANDYMAN_CARE_ACTOR_REFERENCE_CONFLICT' &&
        (error as { statusCode?: number }).statusCode === 409,
    );
  });

  it('keeps the reference reserved while an actor is INACTIVE', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();
    const actor = await registerActor(integrationId);
    await handymanCareActorService.deactivateCareActor(actor.id);

    await assert.rejects(
      handymanCareActorService.createCareActor({
        integrationId,
        actorReference: actor.actorReference,
        displayName: 'Re-registration attempt',
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_CARE_ACTOR_REFERENCE_CONFLICT',
    );
  });

  it('validates actor reference and display name', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();

    for (const input of [
      { actorReference: '   ', displayName: 'Agent' },
      { actorReference: 'x'.repeat(129), displayName: 'Agent' },
      { actorReference: `CC_${suffix()}`, displayName: '   ' },
      { actorReference: `CC_${suffix()}`, displayName: 'x'.repeat(161) },
    ]) {
      await assert.rejects(
        handymanCareActorService.createCareActor({ integrationId, ...input }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
      );
    }
  });

  it('supports the ACTIVE/INACTIVE lifecycle and exposes no delete surface', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();
    const actor = await registerActor(integrationId);

    const deactivated = await handymanCareActorService.deactivateCareActor(actor.id);
    assert.equal(deactivated.status, 'INACTIVE');
    assert.ok(
      new Date(deactivated.updatedAt).getTime() >= new Date(actor.updatedAt).getTime(),
    );
    assert.equal(
      await handymanCareActorRepository.findActiveByIntegrationAndReference(
        integrationId,
        actor.actorReference,
      ),
      null,
    );

    const reactivated = await handymanCareActorService.activateCareActor(actor.id);
    assert.equal(reactivated.status, 'ACTIVE');
    const resolvable =
      await handymanCareActorRepository.findActiveByIntegrationAndReference(
        integrationId,
        actor.actorReference,
      );
    assert.equal(resolvable?.id, actor.id);

    await assert.rejects(
      handymanCareActorService.getCareActor(randomUUID()),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_CARE_ACTOR_NOT_FOUND',
    );

    const forbidden = /delete|remove|destroy|purge/i;
    for (const key of Object.keys(handymanCareActorRepository)) {
      assert.doesNotMatch(key, forbidden);
    }
    for (const key of Object.keys(handymanCareActorService)) {
      assert.doesNotMatch(key, forbidden);
    }
  });

  it('keeps actor identity structurally separate from user/tenant identity', async (t) => {
    if (!ready(t)) return;
    const columns = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_handoff_care_actors'
        ORDER BY ordinal_position`,
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.deepEqual(names, [
      'id',
      'integration_id',
      'actor_reference',
      'display_name',
      'status',
      'created_at',
      'updated_at',
    ]);
    for (const name of names) {
      assert.doesNotMatch(name, /user|tenant|pic|session|role|permission/i);
    }

    const foreignKeys = await getPool().query<{ referenced: string }>(
      `SELECT confrelid::regclass::text AS referenced
         FROM pg_constraint
        WHERE conrelid = 'handyman_handoff_care_actors'::regclass
          AND contype = 'f'`,
    );
    assert.deepEqual(
      foreignKeys.rows.map((row) => row.referenced),
      ['handyman_handoff_integrations'],
    );
  });

  it('creates no local user, session or RBAC row', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();
    const actor = await registerActor(integrationId);
    await handymanCareActorService.deactivateCareActor(actor.id);
    await handymanCareActorService.activateCareActor(actor.id);

    assert.equal(await count('users'), 0);
    assert.equal(await count('user_sessions'), 0);
    assert.equal(await count('user_role_assignments'), 0);
    assert.equal(await count('tenant_pics'), 0);
  });

  it('enforces registry constraints at the storage layer', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();

    await assert.rejects(
      getPool().query(
        `INSERT INTO handyman_handoff_care_actors
           (id, integration_id, actor_reference, display_name, status)
         VALUES ($1,$2,$3,$4,'SUSPENDED')`,
        [randomUUID(), integrationId, `CC_${suffix()}`, 'Invalid status'],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    await assert.rejects(
      getPool().query(
        `INSERT INTO handyman_handoff_care_actors
           (id, integration_id, actor_reference, display_name)
         VALUES ($1,$2,$3,$4)`,
        [randomUUID(), randomUUID(), `CC_${suffix()}`, 'Unknown integration'],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );

    await assert.rejects(
      getPool().query(
        `UPDATE handyman_handoff_integrations
            SET actor_capability = 'SUPERVISOR' WHERE id = $1`,
        [integrationId],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
  });

  it('exposes an ACTIVE-only registry read primitive for PART 08', async (t) => {
    if (!ready(t)) return;
    const integrationId = await careIntegration();
    const otherIntegration = await careIntegration();
    const actor = await registerActor(integrationId);

    const found = await handymanCareActorRepository.findActiveByIntegrationAndReference(
      integrationId,
      actor.actorReference,
    );
    assert.equal(found?.id, actor.id);
    assert.equal(found?.status, 'ACTIVE');

    assert.equal(
      await handymanCareActorRepository.findActiveByIntegrationAndReference(
        otherIntegration,
        actor.actorReference,
      ),
      null,
    );

    await handymanCareActorService.deactivateCareActor(actor.id);
    assert.equal(
      await handymanCareActorRepository.findActiveByIntegrationAndReference(
        integrationId,
        actor.actorReference,
      ),
      null,
    );
  });
});
