import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import type { DatabaseConfig } from '../src/config';

/**
 * CR-BE-STAB-01 PART 01 — Corrective Action review-target constraint repair.
 *
 * Focused regression validation only:
 *   - CORRECTIVE_ACTION is accepted by `reviews.review_target`
 *   - every pre-existing review target remains accepted
 *   - an invalid target remains rejected
 *   - the migration ordering applies cleanly on a fresh database
 *
 * A dedicated embedded PostgreSQL instance is started, and a uniquely-named
 * CLEAN database is created (never the shared test DB) so this test proves the
 * full ordered migration set — ending with `0286_add_corrective_action_review_target`
 * — applies from an empty database, then the instance is torn down.
 */

/** Every target the final constraint must accept. */
const EXPECTED_TARGETS = [
  'FORM_INSTANCE',
  'CHECKLIST_EXECUTION',
  'WORK_ORDER',
  'FINDING',
  'VENDOR_WORK',
  'UTILITY_ABNORMAL_CONSUMPTION',
  'PERMIT_APPLICATION',
  'DOCUMENT',
  'DOCUMENT_VERSION',
  'CORRECTIVE_ACTION',
] as const;

const INVALID_TARGET = 'NOT_A_REAL_TARGET';

const PORT = 55480;
const DIR = '/tmp/asentra-stab01-pg';
const MIGRATION_ID = '0286_add_corrective_action_review_target';

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let dbName = '';
let clientId = '';
let reviewerUserId = '';

function safeDbName(): string {
  return `cr_be_stab01_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

before(async () => {
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

  // Create a dedicated clean database on the embedded instance.
  dbName = safeDbName();
  const setup = postgres.getPgClient('postgres', '127.0.0.1');
  await setup.connect();
  await setup.query(`CREATE DATABASE ${dbName}`);
  await setup.end();

  // Apply the FULL ordered migration set on the fresh database.
  const dbConfig: DatabaseConfig = {
    host: '127.0.0.1',
    port: PORT,
    name: dbName,
    user: 'postgres',
    password: '',
    ssl: false,
  };
  pool = await initDatabase(dbConfig);
  const applied = await migrateUp(pool);
  assert.ok(
    applied.includes(MIGRATION_ID),
    `expected ${MIGRATION_ID} to have been applied from a clean database; applied: ${applied.join(', ')}`,
  );

  // Minimal FK fixtures for runtime INSERTs against `reviews`.
  clientId = randomUUID();
  reviewerUserId = randomUUID();
  await pool.query(
    `INSERT INTO clients (id, code, name) VALUES ($1, $2, $3)`,
    [clientId, `C_${randomUUID().slice(0, 8)}`, 'Stab01 Client'],
  );
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`,
    [reviewerUserId, `stab01_${randomUUID()}@example.test`, 'Stab01 Reviewer'],
  );
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
});

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

/** Extracts the CHECK constraint definition text from the live schema. */
async function readReviewTargetConstraint(): Promise<string> {
  const result = await pool!.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'reviews'::regclass
        AND conname = 'review_target'`,
  );
  assert.equal(result.rows.length, 1, 'expected exactly one review_target constraint');
  return result.rows[0].def;
}

async function insertReview(targetType: string): Promise<void> {
  await pool!.query(
    `INSERT INTO reviews (id, client_id, target_type, target_id, reviewer_user_id, status)
     VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
    [randomUUID(), clientId, targetType, randomUUID(), reviewerUserId],
  );
}

describe('CR-BE-STAB-01 PART 01 — review_target constraint repair', () => {
  it('migration ordering applies from a clean database', async (t) => {
    if (!ready(t)) return;
    // migrateUp already succeeded in `before` on the fresh DB; assert the final
    // schema reflects the repaired constraint.
    const def = await readReviewTargetConstraint();
    assert.ok(def.length > 0, `expected a non-empty review_target CHECK: ${def}`);
  });

  it('accepts CORRECTIVE_ACTION', async (t) => {
    if (!ready(t)) return;
    await insertReview('CORRECTIVE_ACTION'); // must not throw
  });

  it('keeps every pre-existing review target accepted', async (t) => {
    if (!ready(t)) return;
    const others = EXPECTED_TARGETS.filter((value) => value !== 'CORRECTIVE_ACTION');
    for (const target of others) {
      await insertReview(target); // must not throw
    }
  });

  it('constraint definition lists every expected target', async (t) => {
    if (!ready(t)) return;
    const def = await readReviewTargetConstraint();
    for (const target of EXPECTED_TARGETS) {
      assert.ok(
        def.includes(`'${target}'`),
        `expected '${target}' to be present in constraint: ${def}`,
      );
    }
  });

  it('rejects an invalid target', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      () => insertReview(INVALID_TARGET),
      (error: unknown) => {
        const value = error as { code?: string } | null;
        // 23514 = check_violation
        assert.equal(value?.code, '23514');
        return true;
      },
    );
  });
});
