/**
 * R06 PART 03B — Checklist Latest Response Writer Authority.
 *
 * Static source-level assertions (always run) prove the schema, write
 * authority, and separation invariants. Live-DB cases prove latest-writer
 * persistence and are CI-required (skipped when no local PostgreSQL test
 * database is available — no DB is installed here).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { saveChecklistResponses } from '../src/modules/checklist-executions';
import { ensureTestDatabase } from './helpers/postgres';

const MIGRATION =
  'src/database/migrations/0345_add_checklist_response_last_responded_by_user_id.ts';
const MIGRATION_INDEX = 'src/database/migrations/index.ts';
const SVC = 'src/modules/checklist-executions/checklist-execution.service.ts';
const ROUTES = 'src/modules/checklist-executions/checklist-execution.routes.ts';
const MOBILE_SVC = 'src/modules/mobile-checklist/mobile-checklist.service.ts';
const SUMMARY_TYPES =
  'src/modules/checklist-execution-summary/checklist-execution-summary.types.ts';
const SUMMARY_REPO =
  'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts';
const OPENAPI = 'docs/api/openapi.yaml';

describe('R06 PART 03B — latest response writer (static, no DB)', () => {
  const mig = readFileSync(MIGRATION, 'utf8');
  const migIndex = readFileSync(MIGRATION_INDEX, 'utf8');
  const svc = readFileSync(SVC, 'utf8');
  const routes = readFileSync(ROUTES, 'utf8');
  const mobileSvc = readFileSync(MOBILE_SVC, 'utf8');
  const summaryTypes = readFileSync(SUMMARY_TYPES, 'utf8');
  const summaryRepo = readFileSync(SUMMARY_REPO, 'utf8');
  const oapi = readFileSync(OPENAPI, 'utf8');

  const saveBlock =
    svc.split('export async function saveChecklistResponses')[1]?.split(
      'export async function startChecklistExecution',
    )[0] ?? '';

  it('1. migration adds last_responded_by_user_id', () => {
    assert.ok(mig.includes('ADD COLUMN last_responded_by_user_id UUID'));
  });

  it('2. nullable for historical rows', () => {
    assert.ok(!mig.includes('last_responded_by_user_id UUID NOT NULL'));
  });

  it('3. FK references users(id)', () => {
    assert.ok(mig.includes('REFERENCES users (id)'));
    assert.ok(mig.includes('checklist_item_responses_last_responded_by_user_id_fkey'));
  });

  it('4. no backfill', () => {
    assert.ok(!mig.includes('UPDATE checklist_item_responses'));
    assert.ok(!mig.includes('INSERT INTO checklist_item_responses'));
  });

  it('5. initial normal (non-SELECT) write stores current userId', () => {
    assert.ok(saveBlock.includes('is_na, na_notes, last_responded_by_user_id)'));
    assert.ok(saveBlock.includes('false, NULL, $7)'));
    // Each of the three branches binds the authenticated userId as the actor.
    assert.equal(saveBlock.split('userId,').length - 1, 3);
  });

  it('6. every DO UPDATE branch replaces actor with latest writer', () => {
    const occurrences = svc.split('last_responded_by_user_id = EXCLUDED.last_responded_by_user_id').length - 1;
    assert.equal(occurrences, 3, 'all three branches must overwrite the actor on conflict');
  });

  it('7. SELECT successful insert stores current userId', () => {
    assert.ok(saveBlock.includes('false, NULL, $8'));
  });

  it('8. SELECT successful overwrite updates latest actor', () => {
    // Same-statement ON CONFLICT ... DO UPDATE SET actor = EXCLUDED.actor.
    assert.ok(saveBlock.includes('last_responded_by_user_id = EXCLUDED.last_responded_by_user_id'));
  });

  it('9. SELECT membership remains same-statement predicate (no check-then-write)', () => {
    assert.ok(saveBlock.includes('WHERE EXISTS'));
    assert.ok(saveBlock.includes('FROM checklist_item_options'));
    assert.ok(saveBlock.includes('code = $7'));
    assert.ok(saveBlock.includes("status = 'ACTIVE'"));
    // No follow-up UPDATE is performed after the INSERT..SELECT.
    assert.ok(!saveBlock.includes('UPDATE checklist_item_responses'));
  });

  it('10. N/A write stores current userId', () => {
    assert.ok(saveBlock.includes('true, $5, $6)'));
    const naBlock = saveBlock.split('EXPLICIT N/A RESPONSE PATH')[1] ?? '';
    assert.ok(naBlock.includes('userId,'));
  });

  it('11–13. N/A transitions write latest actor (same DO UPDATE)', () => {
    // N/A→NORMAL, NORMAL→N/A, N/A→N/A all flow through the upsert whose
    // DO UPDATE sets last_responded_by_user_id = EXCLUDED.last_responded_by_user_id.
    const occurrences = saveBlock.split('last_responded_by_user_id = EXCLUDED.last_responded_by_user_id').length - 1;
    assert.ok(occurrences >= 3, 'all branches overwrite the actor');
  });

  it('14. failed validation throws before any actor write', () => {
    const reject = svc.indexOf('Response value does not match item type.');
    const firstInsert = svc.indexOf('INSERT INTO checklist_item_responses');
    assert.ok(reject !== -1 && firstInsert !== -1 && reject < firstInsert);
  });

  it('15. batch is not request-wide atomic (earlier item keeps its actor)', () => {
    assert.ok(!saveBlock.includes('BEGIN'));
    assert.ok(!saveBlock.includes('COMMIT'));
    assert.ok(!saveBlock.includes('withTransaction'));
    assert.ok(!saveBlock.includes('connect()'));
  });

  it('16. generic REST and mobile still use the same service', () => {
    assert.ok(routes.includes('saveChecklistResponses'));
    assert.ok(mobileSvc.includes('saveChecklistResponses'));
  });

  it('17. no actor request-body field accepted', () => {
    for (const forbidden of [
      'lastRespondedByUserId',
      'respondedByUserId',
      'updatedByUserId',
      'actorUserId',
      'entry.userId',
    ]) {
      assert.ok(!svc.includes(forbidden), `unexpected body actor field ${forbidden}`);
    }
  });

  it('18. no first-responder/history model added', () => {
    assert.ok(!mig.includes('created_by_user_id'));
    assert.ok(!mig.includes('first_responded'));
    assert.ok(!mig.includes('response_history'));
  });

  it('19. assignment snapshot untouched', () => {
    assert.ok(!saveBlock.includes('assignee_type'));
    assert.ok(!saveBlock.includes('assigned_workforce_profile_id'));
    assert.ok(!saveBlock.includes('assigned_team_id'));
  });

  it('20. completion actor untouched', () => {
    assert.ok(!saveBlock.includes('completed_by_user_id'));
  });

  it('21. verifier untouched', () => {
    assert.ok(!mig.includes('reviews'));
    assert.ok(summaryRepo.includes('r.reviewer_user_id'));
  });

  it('22. Reporting projection unchanged', () => {
    assert.ok(!summaryTypes.includes('lastRespondedByUserId'));
    assert.ok(!summaryRepo.includes('last_responded_by_user_id'));
  });

  it('23. form engine response actor is PART 04B scope (not PART 03B)', () => {
    // PART 03B's migration scoped the writer column to checklist_item_responses;
    // R06 PART 04B separately adds form_responses.last_responded_by_user_id.
    assert.ok(!mig.includes('form_responses'));
  });

  it('24. migration registered and OpenAPI exposes nullable field', () => {
    assert.ok(migIndex.includes('migration0345AddChecklistResponseLastRespondedByUserId'));
    assert.ok(oapi.includes('last_responded_by_user_id:'));
  });
});

describe('R06 PART 03B — latest response writer (live DB, CI-required)', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;

  let clientId = '';
  let buildingId = '';
  let userA = '';
  let userB = '';
  let templateId = '';
  let itemBool = '';
  let itemSelect = '';
  let itemNa = '';
  let itemNumber = '';

  const suffix = () => randomUUID().slice(0, 8).toUpperCase();
  const q = (text: string, params: unknown[] = []) => {
    if (!pool) throw new Error('database pool is not initialized');
    return pool.query(text, params);
  };
  const insertRow = async (
    table: string,
    values: Record<string, unknown>,
  ): Promise<string> => {
    const rowId = randomUUID();
    const entries = Object.entries(values);
    const columns = entries.map(([c]) => c).join(', ');
    const placeholders = entries.map((_, i) => `$${i + 2}`).join(', ');
    await q(`INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`, [
      rowId,
      ...entries.map(([, v]) => v),
    ]);
    return rowId;
  };

  before(async () => {
    const db = await ensureTestDatabase();
    if (!db) return;
    database = db;
    pool = await initDatabase(db);
    await migrateUp(pool);
    await q(
      `TRUNCATE
         checklist_item_responses, checklist_item_options, checklist_items,
         checklist_executions, checklist_templates, user_building_assignments,
         buildings, properties, users, clients
       CASCADE`,
    );

    clientId = await insertRow('clients', { code: `C_${suffix()}`, name: 'Client' });
    const propertyId = await insertRow('properties', {
      client_id: clientId,
      code: `P_${suffix()}`,
      name: 'Property',
    });
    buildingId = await insertRow('buildings', {
      property_id: propertyId,
      code: `B_${suffix()}`,
      name: 'Building',
    });

    userA = await insertRow('users', {
      email: `a_${suffix().toLowerCase()}@example.test`,
      display_name: 'User A',
    });
    userB = await insertRow('users', {
      email: `b_${suffix().toLowerCase()}@example.test`,
      display_name: 'User B',
    });
    await insertRow('user_building_assignments', {
      user_id: userA,
      building_id: buildingId,
      status: 'ACTIVE',
    });
    await insertRow('user_building_assignments', {
      user_id: userB,
      building_id: buildingId,
      status: 'ACTIVE',
    });

    templateId = await insertRow('checklist_templates', {
      client_id: clientId,
      code: `TPL_${suffix()}`,
      name: 'Template',
      status: 'ACTIVE',
    });
    itemBool = await insertRow('checklist_items', {
      checklist_template_id: templateId,
      code: 'BOOL',
      label: 'Bool',
      item_type: 'BOOLEAN',
      required: false,
      display_order: 0,
      status: 'ACTIVE',
    });
    itemSelect = await insertRow('checklist_items', {
      checklist_template_id: templateId,
      code: 'SEL',
      label: 'Select',
      item_type: 'SELECT',
      required: false,
      display_order: 1,
      status: 'ACTIVE',
    });
    await insertRow('checklist_item_options', {
      checklist_item_id: itemSelect,
      code: 'OK',
      label: 'Ok',
      display_order: 0,
      status: 'ACTIVE',
    });
    itemNa = await insertRow('checklist_items', {
      checklist_template_id: templateId,
      code: 'NA',
      label: 'NA',
      item_type: 'BOOLEAN',
      required: false,
      display_order: 2,
      status: 'ACTIVE',
      is_na_allowed: true,
      na_requires_note: false,
    });
    itemNumber = await insertRow('checklist_items', {
      checklist_template_id: templateId,
      code: 'NUM',
      label: 'Number',
      item_type: 'NUMBER',
      required: false,
      display_order: 3,
      status: 'ACTIVE',
    });
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

  const newExecution = async (): Promise<string> =>
    insertRow('checklist_executions', {
      client_id: clientId,
      checklist_template_id: templateId,
      status: 'DRAFT',
    });

  const actorOf = async (
    executionId: string,
    itemId: string,
  ): Promise<string | null> => {
    const r = await q(
      'SELECT last_responded_by_user_id FROM checklist_item_responses WHERE checklist_execution_id = $1 AND checklist_item_id = $2',
      [executionId, itemId],
    );
    return r.rows[0]?.last_responded_by_user_id ?? null;
  };

  it('initial normal write stores current userId', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemBool, value: true }]);
    assert.equal(await actorOf(exec, itemBool), userA);
  });

  it('normal overwrite by different user replaces actor with latest user', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemBool, value: true }]);
    await saveChecklistResponses(exec, userB, [{ itemId: itemBool, value: false }]);
    assert.equal(await actorOf(exec, itemBool), userB);
  });

  it('SELECT successful insert stores userId; invalid option does NOT change actor', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemSelect, value: 'OK' }]);
    assert.equal(await actorOf(exec, itemSelect), userA);
    await assert.rejects(
      () => saveChecklistResponses(exec, userB, [{ itemId: itemSelect, value: 'NOPE' }]),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Selected option is not valid for this item.'),
    );
    assert.equal(await actorOf(exec, itemSelect), userA);
  });

  it('N/A write stores current userId', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemNa, isNa: true, naNotes: 'n/a' }]);
    assert.equal(await actorOf(exec, itemNa), userA);
  });

  it('N/A → NORMAL changes actor to latest writer', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemNa, isNa: true }]);
    await saveChecklistResponses(exec, userB, [{ itemId: itemNa, value: true }]);
    assert.equal(await actorOf(exec, itemNa), userB);
  });

  it('NORMAL → N/A changes actor to latest writer', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemNa, value: true }]);
    await saveChecklistResponses(exec, userB, [{ itemId: itemNa, isNa: true }]);
    assert.equal(await actorOf(exec, itemNa), userB);
  });

  it('N/A → N/A successful mutation updates latest actor', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemNa, isNa: true, naNotes: 'first' }]);
    await saveChecklistResponses(exec, userB, [{ itemId: itemNa, isNa: true, naNotes: 'second' }]);
    assert.equal(await actorOf(exec, itemNa), userB);
  });

  it('failed validation does NOT change actor', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await saveChecklistResponses(exec, userA, [{ itemId: itemBool, value: true }]);
    await assert.rejects(
      () => saveChecklistResponses(exec, userB, [{ itemId: itemBool, value: 'bad' }]),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Response value does not match item type.'),
    );
    assert.equal(await actorOf(exec, itemBool), userA);
  });

  it('successful earlier batch item retains its actor if later item fails', async (t) => {
    if (!ready(t)) return;
    const exec = await newExecution();
    await assert.rejects(
      () =>
        saveChecklistResponses(exec, userA, [
          { itemId: itemBool, value: true },
          { itemId: itemNumber, value: 'bad' },
        ]),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Response value does not match item type.'),
    );
    assert.equal(await actorOf(exec, itemBool), userA);
    assert.equal(await actorOf(exec, itemNumber), null);
  });
});
