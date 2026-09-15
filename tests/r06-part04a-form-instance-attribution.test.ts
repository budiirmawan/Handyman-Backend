/**
 * R06 PART 04A — Form Instance Completion Actor + Assignment Snapshot.
 *
 * Mirrors the closed checklist attribution authority onto `form_instances`
 * with EXACT semantic parity. Static source-level assertions (always run)
 * prove the schema, write authority, and separation invariants. Live-DB cases
 * prove persistence and are CI-required (skipped when no local PostgreSQL test
 * database is available — no DB is installed here).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  createFormInstance,
  finishFormInstance,
} from '../src/modules/form-instances';
import { openFormInstanceForTask } from '../src/modules/mobile-form-instances';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const MIGRATION =
  'src/database/migrations/0346_add_form_instance_attribution_snapshot.ts';
const MIGRATION_INDEX = 'src/database/migrations/index.ts';
const SVC = 'src/modules/form-instances/form-instance.service.ts';
const MOBILE_SVC = 'src/modules/mobile-form-instances/mobile-form-instance.service.ts';
const ROUTES = 'src/modules/form-instances/form-instance.routes.ts';
const CONTROLLER =
  'src/modules/mobile-form-instances/mobile-form-instance.controller.ts';
const TASK_AUTH = 'src/modules/mobile-task-authority/task-assignment-authority.ts';
const METER_REPO =
  'src/modules/meter-reading-bindings/meter-reading-binding.repository.ts';
const LOG_REPO =
  'src/modules/log-sheet-bindings/log-sheet-binding.repository.ts';
const CHECKLIST_SVC = 'src/modules/checklist-executions/checklist-execution.service.ts';
const REVIEWS_MIGRATION = 'src/database/migrations/0074_create_reviews.ts';
const SUMMARY_TYPES =
  'src/modules/checklist-execution-summary/checklist-execution-summary.types.ts';
const SUMMARY_REPO =
  'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts';
const OPENAPI = 'docs/api/openapi.yaml';

describe('R06 PART 04A — form instance attribution (static, no DB)', () => {
  const mig = readFileSync(MIGRATION, 'utf8');
  const migIndex = readFileSync(MIGRATION_INDEX, 'utf8');
  const svc = readFileSync(SVC, 'utf8');
  const mobileSvc = readFileSync(MOBILE_SVC, 'utf8');
  const routes = readFileSync(ROUTES, 'utf8');
  const controller = readFileSync(CONTROLLER, 'utf8');
  const taskAuth = readFileSync(TASK_AUTH, 'utf8');
  const meterRepo = readFileSync(METER_REPO, 'utf8');
  const logRepo = readFileSync(LOG_REPO, 'utf8');
  const checklistSvc = readFileSync(CHECKLIST_SVC, 'utf8');
  const reviewsMig = readFileSync(REVIEWS_MIGRATION, 'utf8');
  const summaryTypes = readFileSync(SUMMARY_TYPES, 'utf8');
  const summaryRepo = readFileSync(SUMMARY_REPO, 'utf8');
  const oapi = readFileSync(OPENAPI, 'utf8');

  const finishBlock = svc.split('export async function finishFormInstance')[1] ?? '';
  const createBoundBlock =
    svc.split('export async function createTaskBoundFormInstance')[1]?.split(
      'export async function startFormInstance',
    )[0] ?? '';
  const createGenericBlock =
    svc.split('export async function createFormInstance')[1]?.split(
      'export async function createTaskBoundFormInstance',
    )[0] ?? '';

  it('1. migration adds all five nullable columns', () => {
    for (const col of [
      'completed_by_user_id',
      'assignee_type',
      'assigned_workforce_profile_id',
      'assigned_team_id',
      'assignment_snapshot_at',
    ]) {
      assert.match(mig, new RegExp(`ADD COLUMN ${col}`));
    }
    assert.doesNotMatch(mig, /completed_by_user_id UUID NOT NULL/);
    assert.doesNotMatch(mig, /assignee_type TEXT NOT NULL/);
    assert.doesNotMatch(mig, /assigned_workforce_profile_id UUID NOT NULL/);
    assert.doesNotMatch(mig, /assigned_team_id UUID NOT NULL/);
    assert.doesNotMatch(mig, /assignment_snapshot_at TIMESTAMPTZ NOT NULL/);
  });

  it('2. completed_by_user_id FK → users(id)', () => {
    assert.match(mig, /completed_by_user_id\) REFERENCES users \(id\)/);
  });

  it('3. workforce FK → workforce_profiles(id)', () => {
    assert.match(mig, /assigned_workforce_profile_id\) REFERENCES workforce_profiles \(id\)/);
  });

  it('4. team FK → teams(id)', () => {
    assert.match(mig, /assigned_team_id\) REFERENCES teams \(id\)/);
  });

  it('5. no task_assignment_id FK', () => {
    assert.doesNotMatch(mig, /REFERENCES task_assignments|task_assignment_id/);
  });

  it('6. no backfill', () => {
    assert.doesNotMatch(mig, /UPDATE form_instances/);
    assert.doesNotMatch(mig, /INSERT INTO form_instances/);
  });

  it('7. CHECK accepts the all-null state', () => {
    assert.match(
      mig,
      /assignee_type IS NULL[\s\S]*assigned_workforce_profile_id IS NULL[\s\S]*assigned_team_id IS NULL[\s\S]*assignment_snapshot_at IS NULL/,
    );
  });

  it('8. CHECK accepts WORKFORCE state', () => {
    assert.match(
      mig,
      /assignee_type = 'WORKFORCE'[\s\S]*assigned_workforce_profile_id IS NOT NULL[\s\S]*assigned_team_id IS NULL[\s\S]*assignment_snapshot_at IS NOT NULL/,
    );
  });

  it('9. CHECK accepts TEAM state', () => {
    assert.match(
      mig,
      /assignee_type = 'TEAM'[\s\S]*assigned_team_id IS NOT NULL[\s\S]*assigned_workforce_profile_id IS NULL[\s\S]*assignment_snapshot_at IS NOT NULL/,
    );
  });

  it('10. mixed workforce+team state rejected structurally (mutually exclusive branches)', () => {
    assert.match(mig, /form_instances_assignee_snapshot_check/);
    // WORKFORCE branch forces assigned_team_id IS NULL; TEAM branch forces
    // assigned_workforce_profile_id IS NULL — a mixed row matches neither.
    assert.ok(
      mig.includes("assignee_type = 'WORKFORCE'") &&
        mig.includes("assigned_team_id IS NULL"),
    );
    assert.ok(
      mig.includes("assignee_type = 'TEAM'") &&
        mig.includes("assigned_workforce_profile_id IS NULL"),
    );
  });

  it('11. successful COMPLETE stores authenticated userId (same UPDATE)', () => {
    assert.match(finishBlock, /completed_by_user_id = \$2/);
    assert.match(finishBlock, /completed_at = NOW\(\)/);
  });

  it('12. CANCEL does not store a completion actor', () => {
    const afterComplete = finishBlock.split('completed_by_user_id = $2')[1] ?? '';
    assert.ok(afterComplete.length > 0, 'cancel branch missing');
    assert.doesNotMatch(afterComplete, /completed_by_user_id/);
  });

  it('13. repeated/terminal completion cannot overwrite the actor (guard first)', () => {
    const guardIdx = finishBlock.indexOf('Instance is already terminal.');
    const writeIdx = finishBlock.indexOf('completed_by_user_id = $2');
    assert.ok(guardIdx !== -1 && writeIdx !== -1 && guardIdx < writeIdx);
  });

  it('14. failed completion (missing required) does not write actor', () => {
    const missingIdx = finishBlock.indexOf('Required fields are missing.');
    const writeIdx = finishBlock.indexOf('completed_by_user_id = $2');
    assert.ok(missingIdx !== -1 && writeIdx !== -1 && missingIdx < writeIdx);
  });

  it('15. task-bound creation snapshots assignment facts in the same INSERT', () => {
    assert.match(mobileSvc, /resolveActiveTaskAssignment\(task\.id\)/);
    assert.match(
      svc,
      /INSERT INTO form_instances[\s\S]*assignee_type, assigned_workforce_profile_id, assigned_team_id,[\s\S]*assignment_snapshot_at/,
    );
    assert.ok(svc.includes('assignment?.assigneeType ?? null'));
    assert.ok(svc.includes('assignment?.workforceProfileId ?? null'));
    assert.ok(svc.includes('assignment?.teamId ?? null'));
  });

  it('16. resolver returns raw ACTIVE assignment facts verbatim (TEAM snapshot source)', () => {
    assert.match(taskAuth, /assigneeType: 'WORKFORCE' \| 'TEAM'/);
    assert.match(taskAuth, /SELECT assignee_type, workforce_profile_id, team_id/);
    assert.match(taskAuth, /workforceProfileId: row\.workforce_profile_id/);
    assert.match(taskAuth, /teamId: row\.team_id/);
  });

  it('17. TEAM start user is never persisted as workforce assignee', () => {
    assert.doesNotMatch(createBoundBlock, /findByUserId/);
    assert.ok(createBoundBlock.includes('assignment?.workforceProfileId ?? null'));
    assert.ok(createBoundBlock.includes('assignment?.teamId ?? null'));
  });

  it('18. existing instance reuse returns BEFORE snapshot resolution (no refresh)', () => {
    const reuseIdx = mobileSvc.indexOf('assertBoundInstanceConsistent(row, task);');
    const resolveIdx = mobileSvc.indexOf('resolveActiveTaskAssignment(task.id)');
    assert.ok(reuseIdx !== -1 && resolveIdx !== -1 && reuseIdx < resolveIdx);
  });

  it('19. reassignment cannot rewrite the snapshot (no UPDATE sets snapshot columns)', () => {
    for (const block of [
      svc.split('export async function startFormInstance')[1]?.split(
        'export async function saveFormResponses',
      )[0] ?? '',
      finishBlock,
    ]) {
      assert.doesNotMatch(block, /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
    }
  });

  it('20. generic creation leaves snapshot NULL', () => {
    assert.doesNotMatch(
      createGenericBlock,
      /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at|completed_by_user_id/,
    );
  });

  it('21. meter-bound creation leaves snapshot NULL', () => {
    const meterInsert =
      meterRepo.split('INSERT INTO form_instances')[1]?.split('RETURNING')[0] ?? '';
    assert.ok(meterInsert.length > 0, 'meter INSERT not found');
    assert.doesNotMatch(
      meterInsert,
      /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at|completed_by_user_id/,
    );
  });

  it('22. log-sheet-bound creation leaves snapshot NULL', () => {
    const logInsert =
      logRepo.split('INSERT INTO form_instances')[1]?.split('RETURNING')[0] ?? '';
    assert.ok(logInsert.length > 0, 'log-sheet INSERT not found');
    assert.doesNotMatch(
      logInsert,
      /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at|completed_by_user_id/,
    );
  });

  it('23. no executor_* field introduced', () => {
    assert.doesNotMatch(mig, /executor_/);
    assert.doesNotMatch(svc, /executor_workforce_profile_id|executed_by|performed_by/);
    assert.doesNotMatch(mobileSvc, /executor_workforce_profile_id|executed_by|performed_by/);
  });

  it('24. no form response actor introduced by the PART 04A migration (form_responses untouched)', () => {
    // PART 04A scoped attribution to form_instances; R06 PART 04B separately
    // adds form_responses.last_responded_by_user_id via saveFormResponses.
    assert.doesNotMatch(mig, /form_responses|last_responded_by_user_id/);
  });

  it('25. checklist engine untouched', () => {
    assert.doesNotMatch(mig, /ALTER TABLE checklist_executions|REFERENCES checklist/);
    assert.doesNotMatch(svc, /from '\.\.\/checklist/);
    assert.doesNotMatch(mobileSvc, /from '\.\.\/checklist/);
    assert.match(checklistSvc, /completed_by_user_id = \$2/);
  });

  it('26. Reporting projection untouched', () => {
    assert.doesNotMatch(summaryTypes, /completedByUserId|assigneeType|assignedWorkforceProfileId|assignedTeamId|assignmentSnapshotAt/);
    assert.doesNotMatch(summaryRepo, /completed_by_user_id|assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
  });

  it('27. verifier unchanged (reviews.reviewer_user_id)', () => {
    assert.match(reviewsMig, /reviewer_user_id UUID NOT NULL REFERENCES users\s*\(id\)/);
    assert.doesNotMatch(mig, /reviewer_user_id|reviews/);
  });

  it('28. migration registered; read DTOs + OpenAPI expose nullable fields', () => {
    assert.match(migIndex, /migration0346AddFormInstanceAttributionSnapshot/);
    assert.ok(routes.includes('completedByUserId: row.completed_by_user_id ?? null'));
    assert.ok(routes.includes('assignmentSnapshotAt: row.assignment_snapshot_at ?? null'));
    assert.ok(controller.includes('completedByUserId: row.completed_by_user_id ?? null'));
    assert.ok(controller.includes('assignmentSnapshotAt: row.assignment_snapshot_at ?? null'));
    const mfiBlock =
      oapi.split('MobileFormInstanceOpenReference:')[1]?.split(
        'FormInstanceResponseWrite:',
      )[0] ?? '';
    for (const field of [
      'completedByUserId:',
      'assigneeType:',
      'assignedWorkforceProfileId:',
      'assignedTeamId:',
      'assignmentSnapshotAt:',
    ]) {
      assert.ok(mfiBlock.includes(field), `OpenAPI missing ${field}`);
    }
  });
});

describe('R06 PART 04A — form instance attribution (live DB, CI-required)', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;

  const TZ = 'Asia/Jakarta';
  const ON_SHIFT = new Date('2026-08-20T02:00:00Z'); // 09:00 Jakarta (07–15 window)

  let adminUserId = '';
  let workerUserId = '';
  let workerProfileId = '';

  let clientId = '';
  let buildingId = '';
  let teamId = '';
  let publishedVersionId = '';
  let requiredVersionId = '';
  let workforceTaskId = '';
  let teamTaskId = '';

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

  const seedFormVersion = async (
    required: boolean,
  ): Promise<{ versionId: string; fieldId: string }> => {
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
    const versionId = await insertRow('form_template_versions', {
      form_template_id: templateId,
      version_number: 1,
      status: 'PUBLISHED',
      published_at: '2026-08-01T00:00:00Z',
    });
    const sectionId = await insertRow('form_template_version_sections', {
      version_id: versionId,
      section_id: randomUUID(),
      code: `SEC_${suffix()}`,
      title: 'Section',
      display_order: 0,
      status: 'ACTIVE',
    });
    const fieldId = await insertRow('form_template_version_fields', {
      version_section_id: sectionId,
      field_id: randomUUID(),
      code: `FLD_${suffix()}`,
      label: 'Field',
      field_type: 'TEXT',
      required,
      display_order: 0,
      status: 'ACTIVE',
    });
    return { versionId, fieldId };
  };

  const createGeneratedTask = async (
    targetId: string,
    assigneeType: 'WORKFORCE' | 'TEAM',
    profileId: string | null,
    team: string | null,
  ): Promise<string> => {
    const scheduleId = await insertRow('schedule_definitions', {
      client_id: clientId,
      code: `SD_${suffix()}`,
      name: 'Form schedule',
      target_type: 'FORM_VERSION',
      target_id: targetId,
      building_id: buildingId,
      start_at: '2026-08-01T00:00:00Z',
      timezone: TZ,
      status: 'ACTIVE',
    });
    const taskId = await insertRow('generated_tasks', {
      client_id: clientId,
      schedule_definition_id: scheduleId,
      occurrence_at: '2026-08-05T01:00:00Z',
      target_type: 'FORM_VERSION',
      target_id: targetId,
      building_id: buildingId,
      status: 'OPEN',
    });
    await insertRow('task_assignments', {
      task_id: taskId,
      assignee_type: assigneeType,
      workforce_profile_id: profileId,
      team_id: team,
      assigned_by_user_id: adminUserId,
      status: 'ACTIVE',
    });
    return taskId;
  };

  before(async () => {
    const db = await ensureTestDatabase();
    if (!db) return;
    database = db;
    pool = await initDatabase(db);
    await migrateUp(pool);
    await q(
      `TRUNCATE
         form_responses, form_instances,
         form_template_version_fields, form_template_version_sections,
         form_template_versions, form_fields, form_sections, form_templates,
         source_forms, task_assignments, generated_tasks, schedule_definitions,
         workforce_shift_assignments, shifts, workforce_profiles, teams,
         positions, departments, organizations, user_building_assignments,
         buildings, properties, users, clients
       CASCADE`,
    );

    const admin = await createAdminUser();
    adminUserId = admin.userId;

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
      timezone: TZ,
    });
    await insertRow('user_building_assignments', {
      user_id: adminUserId,
      building_id: buildingId,
      status: 'ACTIVE',
    });

    const orgId = await insertRow('organizations', {
      client_id: clientId,
      code: `O_${suffix()}`,
      name: 'Org',
    });
    const deptId = await insertRow('departments', {
      organization_id: orgId,
      code: `D_${suffix()}`,
      name: 'Dept',
    });
    const positionId = await insertRow('positions', {
      organization_id: orgId,
      code: `POS_${suffix()}`,
      name: 'Field Worker',
    });
    teamId = await insertRow('teams', {
      department_id: deptId,
      code: `T_${suffix()}`,
      name: 'Team',
    });

    workerUserId = await insertRow('users', {
      email: `w_${suffix().toLowerCase()}@example.test`,
      display_name: 'Worker',
    });
    await insertRow('user_building_assignments', {
      user_id: workerUserId,
      building_id: buildingId,
      status: 'ACTIVE',
    });
    workerProfileId = await insertRow('workforce_profiles', {
      organization_id: orgId,
      department_id: deptId,
      team_id: teamId,
      position_id: positionId,
      user_id: workerUserId,
      employee_code: `WF_${suffix()}`,
      full_name: 'Worker',
    });

    const shiftId = await insertRow('shifts', {
      client_id: clientId,
      building_id: buildingId,
      code: `S_${suffix()}`,
      name: 'Morning',
      start_time: '07:00:00',
      end_time: '15:00:00',
    });
    await insertRow('workforce_shift_assignments', {
      workforce_profile_id: workerProfileId,
      shift_id: shiftId,
      status: 'ACTIVE',
    });

    publishedVersionId = (await seedFormVersion(false)).versionId;
    requiredVersionId = (await seedFormVersion(true)).versionId;

    workforceTaskId = await createGeneratedTask(
      publishedVersionId,
      'WORKFORCE',
      workerProfileId,
      null,
    );
    teamTaskId = await createGeneratedTask(
      publishedVersionId,
      'TEAM',
      null,
      teamId,
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

  const snapshotOf = async (
    instanceId: string,
  ): Promise<{
    assigneeType: string | null;
    workforce: string | null;
    team: string | null;
    snapshotAt: Date | null;
  }> => {
    const r = await q(
      `SELECT assignee_type, assigned_workforce_profile_id, assigned_team_id, assignment_snapshot_at
         FROM form_instances WHERE id = $1`,
      [instanceId],
    );
    const row = r.rows[0];
    return {
      assigneeType: row.assignee_type,
      workforce: row.assigned_workforce_profile_id,
      team: row.assigned_team_id,
      snapshotAt: row.assignment_snapshot_at,
    };
  };

  const completedByOf = async (instanceId: string): Promise<string | null> => {
    const r = await q(
      'SELECT completed_by_user_id FROM form_instances WHERE id = $1',
      [instanceId],
    );
    return r.rows[0]?.completed_by_user_id ?? null;
  };

  it('columns exist, are nullable with NULL default, FKs resolve, CHECK present', async (t) => {
    if (!ready(t)) return;
    for (const col of [
      'completed_by_user_id',
      'assignee_type',
      'assigned_workforce_profile_id',
      'assigned_team_id',
      'assignment_snapshot_at',
    ]) {
      const r = await q(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'form_instances' AND column_name = $1`,
        [col],
      );
      assert.equal(r.rowCount, 1, `${col} missing`);
      assert.equal(r.rows[0].is_nullable, 'YES', `${col} not nullable`);
      assert.equal(r.rows[0].column_default, null, `${col} must default NULL`);
    }
    const fk = await q(
      `SELECT ccu.table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'form_instances'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.column_name = 'id'`,
    );
    const fkTables = fk.rows.map((r: { table_name: string }) => r.table_name);
    assert.ok(fkTables.includes('users'));
    assert.ok(fkTables.includes('workforce_profiles'));
    assert.ok(fkTables.includes('teams'));
    const chk = await q(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'form_instances'
          AND constraint_name = 'form_instances_assignee_snapshot_check'`,
    );
    assert.equal(chk.rowCount, 1);
  });

  it('CHECK rejects a mixed workforce+team state', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      () =>
        insertRow('form_instances', {
          client_id: clientId,
          form_template_version_id: publishedVersionId,
          assignee_type: 'WORKFORCE',
          assigned_workforce_profile_id: null,
          assigned_team_id: teamId,
          assignment_snapshot_at: new Date(),
        }),
      (err: unknown) => (err as { code?: string }).code === '23514',
    );
  });

  it('successful COMPLETE stores the authenticated userId', async (t) => {
    if (!ready(t)) return;
    const instanceId = await insertRow('form_instances', {
      client_id: clientId,
      form_template_version_id: publishedVersionId,
      status: 'DRAFT',
    });
    const row = await finishFormInstance(instanceId, workerUserId, 'complete');
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.completed_by_user_id, workerUserId);
    assert.equal(await completedByOf(instanceId), workerUserId);
  });

  it('CANCEL does not store a completion actor', async (t) => {
    if (!ready(t)) return;
    const instanceId = await insertRow('form_instances', {
      client_id: clientId,
      form_template_version_id: publishedVersionId,
      status: 'DRAFT',
    });
    const row = await finishFormInstance(instanceId, workerUserId, 'cancel');
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.completed_by_user_id ?? null, null);
    assert.equal(await completedByOf(instanceId), null);
  });

  it('repeated/terminal completion cannot overwrite the original actor', async (t) => {
    if (!ready(t)) return;
    const instanceId = await insertRow('form_instances', {
      client_id: clientId,
      form_template_version_id: publishedVersionId,
      status: 'DRAFT',
    });
    await finishFormInstance(instanceId, workerUserId, 'complete');
    await assert.rejects(
      () => finishFormInstance(instanceId, adminUserId, 'complete'),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Instance is already terminal.'),
    );
    assert.equal(await completedByOf(instanceId), workerUserId);
  });

  it('failed completion (missing required) does not write actor', async (t) => {
    if (!ready(t)) return;
    const instanceId = await insertRow('form_instances', {
      client_id: clientId,
      form_template_version_id: requiredVersionId,
      status: 'DRAFT',
    });
    await assert.rejects(
      () => finishFormInstance(instanceId, workerUserId, 'complete'),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Required fields are missing.'),
    );
    assert.equal(await completedByOf(instanceId), null);
  });

  it('new WORKFORCE task-bound instance snapshots WORKFORCE facts', async (t) => {
    if (!ready(t)) return;
    const row = await openFormInstanceForTask(workforceTaskId, workerUserId, ON_SHIFT);
    assert.equal(row.assignee_type, 'WORKFORCE');
    assert.equal(row.assigned_workforce_profile_id, workerProfileId);
    assert.equal(row.assigned_team_id ?? null, null);
    assert.ok(row.assignment_snapshot_at instanceof Date);
  });

  it('new TEAM task-bound instance snapshots TEAM facts (start user NOT workforce)', async (t) => {
    if (!ready(t)) return;
    const row = await openFormInstanceForTask(teamTaskId, workerUserId, ON_SHIFT);
    assert.equal(row.assignee_type, 'TEAM');
    assert.equal(row.assigned_team_id, teamId);
    assert.equal(
      row.assigned_workforce_profile_id ?? null,
      null,
      'team start user must not become workforce assignee',
    );
    assert.ok(row.assignment_snapshot_at instanceof Date);
  });

  it('existing instance reuse does NOT refresh snapshot after reassignment', async (t) => {
    if (!ready(t)) return;
    const first = await openFormInstanceForTask(workforceTaskId, workerUserId, ON_SHIFT);
    assert.equal(first.assignee_type, 'WORKFORCE');
    assert.equal(first.assigned_workforce_profile_id, workerProfileId);

    // Reassign the task to a TEAM (deactivate + insert new ACTIVE row).
    await q(`UPDATE task_assignments SET status = 'INACTIVE', updated_at = NOW()
             WHERE task_id = $1 AND status = 'ACTIVE'`, [workforceTaskId]);
    await insertRow('task_assignments', {
      task_id: workforceTaskId,
      assignee_type: 'TEAM',
      workforce_profile_id: null,
      team_id: teamId,
      assigned_by_user_id: adminUserId,
      status: 'ACTIVE',
    });

    const second = await openFormInstanceForTask(workforceTaskId, workerUserId, ON_SHIFT);
    assert.equal(second.id, first.id, 'same instance reused');
    assert.equal(second.assignee_type, 'WORKFORCE', 'snapshot must NOT be refreshed');
    assert.equal(second.assigned_workforce_profile_id, workerProfileId);
    assert.equal(second.assigned_team_id ?? null, null);
  });

  it('generic creation leaves snapshot NULL', async (t) => {
    if (!ready(t)) return;
    const created = await createFormInstance(publishedVersionId, adminUserId);
    const snap = await snapshotOf(created.id);
    assert.equal(snap.assigneeType, null);
    assert.equal(snap.workforce, null);
    assert.equal(snap.team, null);
    assert.equal(snap.snapshotAt, null);
    assert.equal(created.completed_by_user_id ?? null, null);
  });

  it('domain-bound-style creation (snapshot columns omitted) leaves snapshot NULL', async (t) => {
    if (!ready(t)) return;
    // meter/log-sheet repositories INSERT with only (id, client_id,
    // form_template_version_id, <binding_id>) — snapshot columns omitted.
    const instanceId = await insertRow('form_instances', {
      client_id: clientId,
      form_template_version_id: publishedVersionId,
      status: 'DRAFT',
    });
    const snap = await snapshotOf(instanceId);
    assert.equal(snap.assigneeType, null);
    assert.equal(snap.workforce, null);
    assert.equal(snap.team, null);
    assert.equal(snap.snapshotAt, null);
    assert.equal(await completedByOf(instanceId), null);
  });
});
