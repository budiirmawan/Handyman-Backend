/**
 * R06 PART 01 — Checklist Completion Actor Authority.
 *
 * Static source-level assertions (always run) prove the schema, write
 * authority, read contract, and separation invariants. Live-DB cases prove
 * persistence behavior and are CI-required (skipped when no local PostgreSQL
 * test database is available — no DB is installed here).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { finishChecklistExecution } from '../src/modules/checklist-executions';
import { ensureTestDatabase } from './helpers/postgres';

const MIGRATION =
  'src/database/migrations/0343_add_checklist_execution_completed_by_user_id.ts';
const MIGRATION_INDEX = 'src/database/migrations/index.ts';
const SERVICE = 'src/modules/checklist-executions/checklist-execution.service.ts';
const ROUTES = 'src/modules/checklist-executions/checklist-execution.routes.ts';
const SUMMARY_TYPES =
  'src/modules/checklist-execution-summary/checklist-execution-summary.types.ts';
const SUMMARY_REPO =
  'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts';
const FORM_SERVICE = 'src/modules/form-instances/form-instance.service.ts';
const OPENAPI = 'docs/api/openapi.yaml';

describe('R06 PART 01 — completion actor (static, no DB)', () => {
  const mig = readFileSync(MIGRATION, 'utf8');
  const migIndex = readFileSync(MIGRATION_INDEX, 'utf8');
  const svc = readFileSync(SERVICE, 'utf8');
  const routes = readFileSync(ROUTES, 'utf8');
  const summaryTypes = readFileSync(SUMMARY_TYPES, 'utf8');
  const summaryRepo = readFileSync(SUMMARY_REPO, 'utf8');
  const formSvc = readFileSync(FORM_SERVICE, 'utf8');
  const oapi = readFileSync(OPENAPI, 'utf8');

  it('1. migration adds completed_by_user_id to checklist_executions', () => {
    assert.match(mig, /ALTER TABLE checklist_executions/);
    assert.match(mig, /ADD COLUMN completed_by_user_id UUID/);
  });

  it('2. column is nullable for historical compatibility', () => {
    assert.doesNotMatch(mig, /completed_by_user_id UUID NOT NULL/);
    assert.match(svc, /completed_by_user_id: string \| null;/);
  });

  it('3. column FK references users(id)', () => {
    assert.match(mig, /REFERENCES users \(id\)/);
    assert.match(mig, /checklist_executions_completed_by_user_id_fkey/);
  });

  it('4. no backfill — migration performs no data writes', () => {
    assert.doesNotMatch(mig, /UPDATE checklist_executions/);
    assert.doesNotMatch(mig, /INSERT INTO checklist_executions/);
  });

  it('5. finish command persists authenticated userId', () => {
    assert.match(svc, /completed_by_user_id = \$2/);
    assert.match(svc, /\[target, userId, execution\.id\]/);
  });

  it('6. request body cannot supply completion actor (auth userId wins)', () => {
    // The REST finish handler derives the actor from the authenticated session
    // only; it never reads a body-supplied actor field.
    const finishHandler = routes.split('async function finish(')[1]?.split('}catch')[0] ?? '';
    assert.ok(finishHandler, 'finish handler not found');
    assert.match(finishHandler, /q\.auth\.userId/);
    assert.doesNotMatch(finishHandler, /body/);
    // The service signature takes no body at all.
    assert.match(
      svc,
      /export async function finishChecklistExecution\(\s*executionId: string,\s*userId: string,\s*action: 'complete' \| 'cancel',/,
    );
  });

  it('7. failed completion cannot write actor (missing-required throws before UPDATE)', () => {
    const missing = svc.indexOf("'Required checklist items are missing.'");
    const actorWrite = svc.indexOf('completed_by_user_id = $2');
    assert.ok(missing !== -1, 'missing-required rejection not found');
    assert.ok(actorWrite !== -1, 'actor write not found');
    assert.ok(missing < actorWrite, 'completion validation must precede the actor write');
  });

  it('8. existing terminal lifecycle rejection preserved (repeat completion rejected)', () => {
    const terminal = svc.indexOf("'Execution is already terminal.'");
    const actorWrite = svc.indexOf('completed_by_user_id = $2');
    assert.ok(terminal !== -1, 'terminal rejection not found');
    assert.ok(terminal < actorWrite, 'terminal rejection must precede any actor write');
  });

  it('9. verifier remains separate (no reviews change)', () => {
    assert.doesNotMatch(mig, /ALTER TABLE reviews|CREATE TABLE reviews|INSERT INTO reviews|UPDATE reviews/);
    assert.match(summaryRepo, /r\.reviewer_user_id/);
  });

  it('10. generated_tasks.completed_by_user_id is not used as execution actor', () => {
    assert.doesNotMatch(svc, /generated_tasks\.completed_by_user_id/);
  });

  it('11. no Reporting projection modified (summary contract untouched)', () => {
    assert.doesNotMatch(summaryTypes, /completedByUserId/);
    assert.doesNotMatch(summaryRepo, /completed_by_user_id|completedByUserId/);
  });

  it('12. no form engine modified', () => {
    assert.doesNotMatch(formSvc, /completed_by_user_id/);
  });

  it('13. migration registered and OpenAPI ChecklistExecution exposes nullable field', () => {
    assert.match(migIndex, /migration0343AddChecklistExecutionCompletedByUserId/);
    assert.match(oapi, /completedByUserId:/);
  });
});

describe('R06 PART 01 — completion actor (live DB, CI-required)', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;

  const clientId = randomUUID();
  const propertyId = randomUUID();
  const buildingId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();

  before(async () => {
    const db = await ensureTestDatabase();
    if (!db) return;
    database = db;
    pool = await initDatabase(db);
    await migrateUp(pool);
    await pool.query(
      `TRUNCATE
         checklist_item_responses, checklist_items, checklist_executions,
         checklist_templates, user_building_assignments,
         buildings, properties, users, clients
       CASCADE`,
    );
    await pool.query(
      `INSERT INTO clients (id, code, name) VALUES ($1, 'R06C', 'R06 Client')`,
      [clientId],
    );
    await pool.query(
      `INSERT INTO properties (id, client_id, code, name) VALUES ($1, $2, 'R06P', 'R06 Property')`,
      [propertyId, clientId],
    );
    await pool.query(
      `INSERT INTO buildings (id, property_id, code, name) VALUES ($1, $2, 'R06B', 'R06 Building')`,
      [buildingId, propertyId],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1, 'r06a@example.test', 'R06 Actor'), ($2, 'r06b@example.test', 'R06 Other')`,
      [userId, otherUserId],
    );
    // ACTIVE building assignment so the actor's accessible-Client scope resolves.
    await pool.query(
      `INSERT INTO user_building_assignments (id, user_id, building_id, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [randomUUID(), userId, buildingId],
    );
  });

  after(async () => {
    if (pool) await closePool(pool);
  });

  function ready(t: TestContext): boolean {
    if (!pool) {
      t.skip('test database unavailable (CI-required case)');
      return false;
    }
    return true;
  }

  async function seedExecution(requiredItem: boolean): Promise<string> {
    const templateId = randomUUID();
    const executionId = randomUUID();
    await pool!.query(
      `INSERT INTO checklist_templates (id, client_id, code, name, status)
       VALUES ($1, $2, $3, 'T', 'ACTIVE')`,
      [templateId, clientId, `R06T_${randomUUID().slice(0, 8)}`],
    );
    if (requiredItem) {
      await pool!.query(
        `INSERT INTO checklist_items (id, checklist_template_id, code, label, item_type, required, display_order, status)
         VALUES ($1, $2, 'I1', 'Item', 'CHECK', TRUE, 0, 'ACTIVE')`,
        [randomUUID(), templateId],
      );
    }
    await pool!.query(
      `INSERT INTO checklist_executions (id, client_id, checklist_template_id, status)
       VALUES ($1, $2, $3, 'DRAFT')`,
      [executionId, clientId, templateId],
    );
    return executionId;
  }

  it('column exists, is nullable, and FKs users (no backfill on historical rows)', async (t) => {
    if (!ready(t)) return;
    const col = await pool!.query(
      `SELECT is_nullable, data_type
         FROM information_schema.columns
        WHERE table_name = 'checklist_executions' AND column_name = 'completed_by_user_id'`,
    );
    assert.equal(col.rowCount, 1);
    assert.equal(col.rows[0].is_nullable, 'YES');
    assert.equal(col.rows[0].data_type, 'uuid');

    const fk = await pool!.query(
      `SELECT 1
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'checklist_executions'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'users'
          AND ccu.column_name = 'id'`,
    );
    assert.ok(fk.rowCount && fk.rowCount > 0, 'FK to users(id) missing');

    // Historical rows remain NULL (no backfill).
    const executionId = await seedExecution(false);
    const row = await pool!.query(
      `SELECT completed_by_user_id FROM checklist_executions WHERE id = $1`,
      [executionId],
    );
    assert.equal(row.rows[0].completed_by_user_id, null);
  });

  it('finish persists authenticated userId as the completion actor', async (t) => {
    if (!ready(t)) return;
    const executionId = await seedExecution(false);
    const row = await finishChecklistExecution(executionId, userId, 'complete');
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.completed_by_user_id, userId);
    assert.ok(row.completed_at instanceof Date);
  });

  it('failed completion (missing required item) does not write actor', async (t) => {
    if (!ready(t)) return;
    const executionId = await seedExecution(true);
    await assert.rejects(
      () => finishChecklistExecution(executionId, userId, 'complete'),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes('Required checklist items are missing.'),
    );
    const row = await pool!.query(
      `SELECT status, completed_at, completed_by_user_id
         FROM checklist_executions WHERE id = $1`,
      [executionId],
    );
    assert.equal(row.rows[0].status, 'DRAFT');
    assert.equal(row.rows[0].completed_at, null);
    assert.equal(row.rows[0].completed_by_user_id, null);
  });

  it('repeat completion is rejected and cannot overwrite the original actor', async (t) => {
    if (!ready(t)) return;
    const executionId = await seedExecution(false);
    await finishChecklistExecution(executionId, userId, 'complete');
    await assert.rejects(
      () => finishChecklistExecution(executionId, otherUserId, 'complete'),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Execution is already terminal.'),
    );
    const row = await pool!.query(
      `SELECT completed_by_user_id FROM checklist_executions WHERE id = $1`,
      [executionId],
    );
    assert.equal(row.rows[0].completed_by_user_id, userId);
  });

  it('cancel leaves completed_by_user_id NULL (no completion actor)', async (t) => {
    if (!ready(t)) return;
    const executionId = await seedExecution(false);
    const row = await finishChecklistExecution(executionId, userId, 'cancel');
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.completed_by_user_id, null);
  });
});
