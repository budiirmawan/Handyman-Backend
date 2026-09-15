/**
 * R06 PART 04B — Form Response Latest Writer Authority.
 *
 * Mirrors checklist R06 PART 03B onto `form_responses` with EXACT semantic
 * parity. Static source-level assertions (always run) prove the schema, write
 * authority, and separation invariants. Live-DB cases prove persistence and
 * are CI-required (skipped when no local PostgreSQL test database is
 * available — no DB is installed here).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { saveFormResponses } from '../src/modules/form-instances';
import { ensureTestDatabase } from './helpers/postgres';

const MIGRATION =
  'src/database/migrations/0347_add_form_response_last_responded_by_user_id.ts';
const MIGRATION_INDEX = 'src/database/migrations/index.ts';
const SVC = 'src/modules/form-instances/form-instance.service.ts';
const ROUTES = 'src/modules/form-instances/form-instance.routes.ts';
const MOBILE_SVC = 'src/modules/mobile-form-instances/mobile-form-instance.service.ts';
const CONTROLLER =
  'src/modules/mobile-form-instances/mobile-form-instance.controller.ts';
const CHECKLIST_SVC = 'src/modules/checklist-executions/checklist-execution.service.ts';
const SUMMARY_TYPES =
  'src/modules/checklist-execution-summary/checklist-execution-summary.types.ts';
const SUMMARY_REPO =
  'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts';
const OPENAPI = 'docs/api/openapi.yaml';

describe('R06 PART 04B — form response writer (static, no DB)', () => {
  const mig = readFileSync(MIGRATION, 'utf8');
  const migIndex = readFileSync(MIGRATION_INDEX, 'utf8');
  const svc = readFileSync(SVC, 'utf8');
  const routes = readFileSync(ROUTES, 'utf8');
  const mobileSvc = readFileSync(MOBILE_SVC, 'utf8');
  const controller = readFileSync(CONTROLLER, 'utf8');
  const checklistSvc = readFileSync(CHECKLIST_SVC, 'utf8');
  const summaryTypes = readFileSync(SUMMARY_TYPES, 'utf8');
  const summaryRepo = readFileSync(SUMMARY_REPO, 'utf8');
  const oapi = readFileSync(OPENAPI, 'utf8');

  const saveBlock =
    svc.split('export async function saveFormResponses')[1]?.split(
      'export async function finishFormInstance',
    )[0] ?? '';

  it('1. migration adds form_responses.last_responded_by_user_id', () => {
    assert.ok(mig.includes('ADD COLUMN last_responded_by_user_id UUID'));
  });

  it('2. field nullable', () => {
    assert.ok(!mig.includes('last_responded_by_user_id UUID NOT NULL'));
  });

  it('3. FK → users(id)', () => {
    assert.match(mig, /last_responded_by_user_id\) REFERENCES users \(id\)/);
    assert.ok(mig.includes('form_responses_last_responded_by_user_id_fkey'));
  });

  it('4. no backfill', () => {
    assert.ok(!mig.includes('UPDATE form_responses'));
    assert.ok(!mig.includes('INSERT INTO form_responses'));
  });

  it('5. initial form response insert stores current userId', () => {
    assert.ok(saveBlock.includes('value, last_responded_by_user_id)'));
    assert.ok(saveBlock.includes('VALUES ($1, $2, $3, $4, $5)'));
    assert.ok(saveBlock.includes('JSON.stringify(entry.value), userId'));
  });

  it('6-7. overwrite replaces actor with the latest writer (EXCLUDED = current userId)', () => {
    assert.ok(
      saveBlock.includes(
        'last_responded_by_user_id = EXCLUDED.last_responded_by_user_id',
      ),
    );
  });

  it('8. occurrence identity is independent (COALESCE(occurrence_id) in conflict key)', () => {
    assert.ok(
      saveBlock.includes(
        "(COALESCE(occurrence_id, '00000000-0000-0000-0000-000000000000'))",
      ),
    );
    // The INSERT never sets occurrence_id, so actor belongs to the exact
    // (instance, field, coalesced occurrence) row identity — never cross-occurrence.
    assert.ok(!saveBlock.includes('occurrence_id, last_responded_by_user_id'));
  });

  it('9. successful overwrite updates actor in the SAME upsert (no second UPDATE)', () => {
    assert.ok(saveBlock.includes('ON CONFLICT'));
    assert.ok(!saveBlock.includes('UPDATE form_responses'));
  });

  it('10. failed validation does not change actor (throws before the upsert)', () => {
    const rejectIdx = svc.indexOf('Response value does not match field type.');
    const insertIdx = svc.indexOf('INSERT INTO form_responses');
    assert.ok(rejectIdx !== -1 && insertIdx !== -1 && rejectIdx < insertIdx);
    const terminalIdx = svc.indexOf('Terminal instances cannot be modified.');
    assert.ok(terminalIdx !== -1 && terminalIdx < insertIdx);
  });

  it('11. failed database mutation cannot separately update actor (no separate write)', () => {
    assert.ok(!saveBlock.includes('UPDATE form_responses'));
    assert.equal(saveBlock.split('last_responded_by_user_id = EXCLUDED.last_responded_by_user_id').length - 1, 1);
  });

  it('12. generic REST uses authenticated userId', () => {
    assert.ok(routes.includes('saveFormResponses(p(req.params.id), req.auth.userId, req.body)'));
  });

  it('13. mobile uses authenticated userId', () => {
    assert.match(controller, /saveMobileFormResponses\(/);
    assert.match(controller, /req\.auth\.userId/);
  });

  it('14. both delegate to the same authoritative response service', () => {
    assert.match(routes, /saveFormResponses\(/);
    assert.match(mobileSvc, /saveFormResponses\(instanceId, userId, body\)/);
  });

  it('15. no actor request-body field accepted', () => {
    for (const forbidden of [
      'entry.userId',
      'entry.actorUserId',
      'entry.respondedByUserId',
      'entry.lastRespondedByUserId',
      'entry.updatedByUserId',
    ]) {
      assert.ok(!svc.includes(forbidden), `unexpected body actor field ${forbidden}`);
    }
  });

  it('16. no first-responder field', () => {
    assert.ok(!mig.includes('first_responded'));
    assert.ok(!mig.includes('created_by_user_id'));
  });

  it('17. no response history table/event added', () => {
    assert.ok(!mig.includes('CREATE TABLE'));
    assert.ok(!mig.includes('response_history'));
    assert.ok(!mig.includes('event_log'));
  });

  it('18. form instance attribution from PART 04A untouched', () => {
    assert.ok(!mig.includes('form_instances'));
    assert.ok(svc.includes('completed_by_user_id = $2'));
    assert.ok(svc.includes('assignment_snapshot_at'));
  });

  it('19. checklist engine untouched', () => {
    assert.ok(!mig.includes('checklist_item_responses'));
    assert.ok(!mig.includes('ALTER TABLE checklist'));
    assert.match(checklistSvc, /checklist_item_responses/);
  });

  it('20. verifier untouched', () => {
    assert.ok(!mig.includes('reviews'));
    assert.ok(summaryRepo.includes('verification_reviewer_user_id'));
  });

  it('21. Reporting untouched', () => {
    assert.ok(!summaryTypes.includes('lastRespondedByUserId'));
    assert.ok(!summaryRepo.includes('last_responded_by_user_id'));
  });

  it('22. OpenAPI request schemas untouched (no response read schema added)', () => {
    const writeBlock =
      oapi.split('FormInstanceResponseWrite:')[1]?.split(
        'CreateMobileChecklistFindingRequest:',
      )[0] ?? '';
    assert.ok(writeBlock.length > 0, 'request schema block not found');
    assert.ok(!writeBlock.includes('lastRespondedByUserId'));
    assert.ok(!writeBlock.includes('last_responded_by_user_id'));
  });

  it('23. no executor_* field introduced', () => {
    assert.ok(!mig.includes('executor_'));
    assert.ok(!svc.includes('executor_workforce_profile_id|executed_by|performed_by'));
  });

  it('24. read path unchanged (raw r.* projection flows the new column); migration registered', () => {
    assert.match(routes, /SELECT r\.\*, f\.code, f\.field_type, f\.required/);
    assert.ok(migIndex.includes('migration0347AddFormResponseLastRespondedByUserId'));
  });
});

describe('R06 PART 04B — form response writer (live DB, CI-required)', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;

  let clientId = '';
  let buildingId = '';
  let userA = '';
  let userB = '';
  let versionId = '';
  let sectionId = '';
  let textFieldId = '';
  let numberFieldId = '';
  let instanceId = '';

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
         form_responses, form_instance_occurrences, form_repeatable_groups,
         form_instances, form_template_version_fields,
         form_template_version_sections, form_template_versions, form_fields,
         form_sections, form_templates, source_forms, user_building_assignments,
         buildings, properties, users, clients
       CASCADE`,
    );

    clientId = await insertRow('clients', {
      code: `C_${suffix()}`,
      name: 'Client',
    });
    const propertyId = await insertRow('properties', {
      client_id: clientId,
      code: `P_${suffix()}`,
      name: 'Property',
    });
    buildingId = await insertRow('buildings', {
      property_id: propertyId,
      code: `B_${suffix()}`,
      name: 'Building',
      timezone: 'Asia/Jakarta',
    });

    userA = await insertRow('users', {
      email: `a_${suffix().toLowerCase()}@example.test`,
      display_name: 'User A',
    });
    userB = await insertRow('users', {
      email: `b_${suffix().toLowerCase()}@example.test`,
      display_name: 'User B',
    });
    for (const userId of [userA, userB]) {
      await insertRow('user_building_assignments', {
        user_id: userId,
        building_id: buildingId,
        status: 'ACTIVE',
      });
    }

    const sourceId = await insertRow('source_forms', {
      client_id: clientId,
      code: `SRC_${suffix()}`,
      name: 'Source',
      source_type: 'INTERNAL',
      status: 'ACTIVE',
    });
    const templateId = await insertRow('form_templates', {
      source_form_id: sourceId,
      client_id: clientId,
      code: `TPL_${suffix()}`,
      name: 'Form template',
      status: 'ACTIVE',
    });
    versionId = await insertRow('form_template_versions', {
      form_template_id: templateId,
      version_number: 1,
      status: 'PUBLISHED',
      published_at: '2026-08-01T00:00:00Z',
    });
    sectionId = await insertRow('form_template_version_sections', {
      version_id: versionId,
      section_id: randomUUID(),
      code: `SEC_${suffix()}`,
      title: 'Section',
      display_order: 0,
      status: 'ACTIVE',
    });
    textFieldId = await insertRow('form_template_version_fields', {
      version_section_id: sectionId,
      field_id: randomUUID(),
      code: `TXT_${suffix()}`,
      label: 'Text',
      field_type: 'TEXT',
      required: false,
      display_order: 0,
      status: 'ACTIVE',
    });
    numberFieldId = await insertRow('form_template_version_fields', {
      version_section_id: sectionId,
      field_id: randomUUID(),
      code: `NUM_${suffix()}`,
      label: 'Number',
      field_type: 'NUMBER',
      required: false,
      display_order: 1,
      status: 'ACTIVE',
    });

    instanceId = await insertRow('form_instances', {
      client_id: clientId,
      form_template_version_id: versionId,
      status: 'DRAFT',
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

  const actorOf = async (fieldId: string): Promise<string | null> => {
    const r = await q(
      'SELECT last_responded_by_user_id FROM form_responses WHERE form_instance_id = $1 AND version_field_id = $2',
      [instanceId, fieldId],
    );
    return r.rows[0]?.last_responded_by_user_id ?? null;
  };

  it('initial form response insert stores current userId', async (t) => {
    if (!ready(t)) return;
    await saveFormResponses(instanceId, userA, {
      fieldId: textFieldId,
      value: 'first',
    });
    assert.equal(await actorOf(textFieldId), userA);
  });

  it('same response overwritten by same user keeps that latest user', async (t) => {
    if (!ready(t)) return;
    await saveFormResponses(instanceId, userA, {
      fieldId: textFieldId,
      value: 'again-a',
    });
    assert.equal(await actorOf(textFieldId), userA);
  });

  it('same response overwritten by different user changes actor', async (t) => {
    if (!ready(t)) return;
    await saveFormResponses(instanceId, userA, {
      fieldId: textFieldId,
      value: 'a',
    });
    await saveFormResponses(instanceId, userB, {
      fieldId: textFieldId,
      value: 'b',
    });
    assert.equal(await actorOf(textFieldId), userB);
  });

  it('failed validation does not change actor', async (t) => {
    if (!ready(t)) return;
    await saveFormResponses(instanceId, userA, {
      fieldId: numberFieldId,
      value: 42,
    });
    assert.equal(await actorOf(numberFieldId), userA);
    await assert.rejects(
      () => saveFormResponses(instanceId, userB, { fieldId: numberFieldId, value: 'bad' }),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Response value does not match field type.'),
    );
    assert.equal(await actorOf(numberFieldId), userA);
  });

  it('earlier successful batch item persists with its actor before a later failure', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      () =>
        saveFormResponses(instanceId, userA, [
          { fieldId: textFieldId, value: 'ok' },
          { fieldId: numberFieldId, value: 'bad' },
        ]),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Response value does not match field type.'),
    );
    assert.equal(await actorOf(textFieldId), userA);
  });

  it('occurrence 1 actor is independent from occurrence 2 actor', async (t) => {
    if (!ready(t)) return;
    const groupId = await insertRow('form_repeatable_groups', {
      version_id: versionId,
      version_section_id: sectionId,
      min_occurrences: 0,
    });
    const occ1 = await insertRow('form_instance_occurrences', {
      form_instance_id: instanceId,
      repeatable_group_id: groupId,
      occurrence_index: 0,
    });
    const occ2 = await insertRow('form_instance_occurrences', {
      form_instance_id: instanceId,
      repeatable_group_id: groupId,
      occurrence_index: 1,
    });
    await insertRow('form_responses', {
      form_instance_id: instanceId,
      version_field_id: textFieldId,
      occurrence_id: occ1,
      last_responded_by_user_id: userA,
    });
    await insertRow('form_responses', {
      form_instance_id: instanceId,
      version_field_id: textFieldId,
      occurrence_id: occ2,
      last_responded_by_user_id: userB,
    });
    const r = await q(
      `SELECT occurrence_id, last_responded_by_user_id
         FROM form_responses
        WHERE form_instance_id = $1 AND version_field_id = $2
        ORDER BY occurrence_id`,
      [instanceId, textFieldId],
    );
    const rows = r.rows as { occurrence_id: string; last_responded_by_user_id: string }[];
    assert.equal(rows.length, 2);
    const byOcc = new Map(rows.map((row) => [row.occurrence_id, row.last_responded_by_user_id]));
    assert.equal(byOcc.get(occ1), userA);
    assert.equal(byOcc.get(occ2), userB);
  });
});
