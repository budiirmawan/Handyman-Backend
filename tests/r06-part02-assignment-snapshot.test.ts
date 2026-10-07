/**
 * R06 PART 02 — Checklist Assignment Snapshot Authority.
 *
 * Static source-level assertions (always run) prove the schema, write
 * authority, and separation invariants. Live-DB cases prove snapshot
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
import {
  finishChecklistExecution,
} from '../src/modules/checklist-executions';
import { openChecklistExecutionForTask } from '../src/modules/mobile-checklist';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';

const MIGRATION =
  'src/database/migrations/0344_add_checklist_execution_assignment_snapshot.ts';
const MIGRATION_INDEX = 'src/database/migrations/index.ts';
const TASK_AUTH = 'src/modules/mobile-task-authority/task-assignment-authority.ts';
const MOBILE_SVC = 'src/modules/mobile-checklist/mobile-checklist.service.ts';
const SVC = 'src/modules/checklist-executions/checklist-execution.service.ts';
const ROUTES = 'src/modules/checklist-executions/checklist-execution.routes.ts';
const SUMMARY_TYPES =
  'src/modules/checklist-execution-summary/checklist-execution-summary.types.ts';
const SUMMARY_REPO =
  'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts';
const FORM_SERVICE = 'src/modules/form-instances/form-instance.service.ts';
const OPENAPI = 'docs/api/openapi.yaml';

const DOMAIN_REPOS = [
  'src/modules/engineering-checklist-bindings/engineering-checklist-binding.repository.ts',
  'src/modules/inspection-bindings/inspection-binding.repository.ts',
  'src/modules/patrol-checklist-bindings/patrol-checklist-binding.repository.ts',
  'src/modules/public-area-inspections/public-area-inspection.repository.ts',
  'src/modules/toilet-inspections/toilet-inspection.repository.ts',
  'src/modules/vendor-checklist-bindings/vendor-checklist-binding.repository.ts',
];

describe('R06 PART 02 — assignment snapshot (static, no DB)', () => {
  const mig = readFileSync(MIGRATION, 'utf8');
  const migIndex = readFileSync(MIGRATION_INDEX, 'utf8');
  const taskAuth = readFileSync(TASK_AUTH, 'utf8');
  const mobileSvc = readFileSync(MOBILE_SVC, 'utf8');
  const svc = readFileSync(SVC, 'utf8');
  const routes = readFileSync(ROUTES, 'utf8');
  const summaryTypes = readFileSync(SUMMARY_TYPES, 'utf8');
  const summaryRepo = readFileSync(SUMMARY_REPO, 'utf8');
  const formSvc = readFileSync(FORM_SERVICE, 'utf8');
  const oapi = readFileSync(OPENAPI, 'utf8');
  const domainRepos = DOMAIN_REPOS.map((p) => readFileSync(p, 'utf8'));

  it('1. migration adds all four nullable columns', () => {
    for (const col of [
      'assignee_type',
      'assigned_workforce_profile_id',
      'assigned_team_id',
      'assignment_snapshot_at',
    ]) {
      assert.match(mig, new RegExp(`ADD COLUMN ${col}`));
    }
    assert.doesNotMatch(mig, /assignee_type TEXT NOT NULL/);
    assert.doesNotMatch(mig, /assigned_workforce_profile_id UUID NOT NULL/);
    assert.doesNotMatch(mig, /assigned_team_id UUID NOT NULL/);
    assert.doesNotMatch(mig, /assignment_snapshot_at TIMESTAMPTZ NOT NULL/);
  });

  it('2. valid WORKFORCE invariant (workforce set, team null, snapshot set)', () => {
    assert.match(
      mig,
      /assignee_type = 'WORKFORCE'[\s\S]*assigned_workforce_profile_id IS NOT NULL[\s\S]*assigned_team_id IS NULL[\s\S]*assignment_snapshot_at IS NOT NULL/,
    );
  });

  it('3. valid TEAM invariant (team set, workforce null, snapshot set)', () => {
    assert.match(
      mig,
      /assignee_type = 'TEAM'[\s\S]*assigned_team_id IS NOT NULL[\s\S]*assigned_workforce_profile_id IS NULL[\s\S]*assignment_snapshot_at IS NOT NULL/,
    );
  });

  it('4. mixed workforce+team rejected structurally (single CHECK constraint)', () => {
    assert.match(mig, /checklist_executions_assignee_snapshot_check/);
    // No-assignment branch requires ALL four NULL.
    assert.match(
      mig,
      /assignee_type IS NULL[\s\S]*assigned_workforce_profile_id IS NULL[\s\S]*assigned_team_id IS NULL[\s\S]*assignment_snapshot_at IS NULL/,
    );
  });

  it('5. FKs point to workforce_profiles and teams', () => {
    assert.match(mig, /assigned_workforce_profile_id\) REFERENCES workforce_profiles \(id\)/);
    assert.match(mig, /assigned_team_id\) REFERENCES teams \(id\)/);
  });

  it('6. no task_assignment_id FK added', () => {
    assert.doesNotMatch(mig, /REFERENCES task_assignments|task_assignment_id/);
  });

  it('7. no backfill (no data writes)', () => {
    assert.doesNotMatch(mig, /UPDATE checklist_executions/);
    assert.doesNotMatch(mig, /INSERT INTO checklist_executions/);
  });

  it('8. task-bound creation resolves ACTIVE assignment facts and snapshots them', () => {
    assert.match(mobileSvc, /resolveActiveTaskAssignment\(task\.id\)/);
    assert.match(
      mobileSvc,
      /INSERT INTO checklist_executions[\s\S]*assignee_type, assigned_workforce_profile_id, assigned_team_id,[\s\S]*assignment_snapshot_at/,
    );
    assert.ok(mobileSvc.includes('assignment?.assigneeType ?? null'));
    assert.ok(mobileSvc.includes('assignment?.workforceProfileId ?? null'));
    assert.ok(mobileSvc.includes('assignment?.teamId ?? null'));
  });

  it('9. TEAM snapshot persists the team only (no workforce derivation)', () => {
    // The resolver returns the raw ACTIVE assignment facts verbatim.
    assert.match(taskAuth, /assigneeType: 'WORKFORCE' \| 'TEAM'/);
    assert.match(taskAuth, /SELECT assignee_type, workforce_profile_id, team_id/);
    assert.match(taskAuth, /workforceProfileId: row\.workforce_profile_id/);
    assert.match(taskAuth, /teamId: row\.team_id/);
  });

  it('10. TEAM start user is not persisted as workforce assignee (snapshot never from auth user)', () => {
    // The snapshot INSERT derives every value from the resolved assignment —
    // never from the authenticated user / their workforce profile.
    const insertBlock =
      mobileSvc
        .split('resolveActiveTaskAssignment(task.id)')[1]
        ?.split('} catch (error) {')[0] ?? '';
    assert.ok(insertBlock, 'snapshot block not found');
    assert.doesNotMatch(insertBlock, /userId|findByUserId/);
    assert.ok(insertBlock.includes('assignment?.workforceProfileId ?? null'));
    assert.ok(insertBlock.includes('assignment?.teamId ?? null'));
  });

  it('11. existing execution reuse returns BEFORE snapshot resolution (no refresh)', () => {
    const reuseIndex = mobileSvc.indexOf('return existing.rows[0];');
    const resolveIndex = mobileSvc.indexOf('resolveActiveTaskAssignment(task.id)');
    assert.ok(reuseIndex !== -1, 'reuse return not found');
    assert.ok(resolveIndex !== -1, 'snapshot resolution not found');
    assert.ok(
      reuseIndex < resolveIndex,
      'existing-execution reuse must precede snapshot resolution (no refresh)',
    );
  });

  it('12. reassignment cannot mutate the execution snapshot (no snapshot UPDATE anywhere)', () => {
    for (const src of [mobileSvc, svc, routes]) {
      assert.doesNotMatch(src, /SET[\s\S]*assignee_type/);
      assert.doesNotMatch(src, /SET[\s\S]*assigned_workforce_profile_id/);
      assert.doesNotMatch(src, /SET[\s\S]*assigned_team_id/);
      assert.doesNotMatch(src, /SET[\s\S]*assignment_snapshot_at/);
    }
  });

  it('13. generic REST creation leaves snapshot NULL (no snapshot columns)', () => {
    const createHandler = routes.split('async function create(')[1]?.split('}catch')[0] ?? '';
    assert.ok(createHandler, 'create handler not found');
    assert.doesNotMatch(createHandler, /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
  });

  it('14. domain-bound creation leaves snapshot NULL', () => {
    for (const repo of domainRepos) {
      assert.doesNotMatch(repo, /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
    }
  });

  it('15. completion does not rewrite the snapshot', () => {
    // finishChecklistExecution UPDATE touches status/completed_at/completed_by_user_id only.
    const finishBlock = svc.split('export async function finishChecklistExecution')[1];
    assert.match(finishBlock, /completed_by_user_id = \$2/);
    assert.doesNotMatch(finishBlock, /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
  });

  it('16. Reporting projection unchanged', () => {
    assert.doesNotMatch(summaryTypes, /assigneeType|assignedWorkforceProfileId|assignedTeamId|assignmentSnapshotAt/);
    assert.doesNotMatch(summaryRepo, /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
  });

  it('17. no form engine change', () => {
    assert.doesNotMatch(formSvc, /assignee_type|assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
  });

  it('18. no vendor executor modeling', () => {
    const vendorSvc = readFileSync(
      'src/modules/vendor-checklist-bindings/vendor-checklist-binding.service.ts',
      'utf8',
    );
    assert.doesNotMatch(vendorSvc, /assigned_workforce_profile_id|assigned_team_id|assignment_snapshot_at/);
  });

  it('19. no executor_* field introduced', () => {
    assert.doesNotMatch(mig, /executor_/);
    assert.doesNotMatch(mobileSvc, /executor_workforce_profile_id|executed_by|performed_by/);
    assert.doesNotMatch(svc, /executor_workforce_profile_id|executed_by|performed_by/);
  });

  it('20. migration registered and OpenAPI ChecklistExecution exposes nullable fields', () => {
    assert.match(migIndex, /migration0344AddChecklistExecutionAssignmentSnapshot/);
    assert.match(oapi, /assigneeType:/);
    assert.match(oapi, /assignedWorkforceProfileId:/);
    assert.match(oapi, /assignedTeamId:/);
    assert.match(oapi, /assignmentSnapshotAt:/);
  });
});

describe('R06 PART 02 — assignment snapshot (live DB, CI-required)', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;

  const TZ = 'Asia/Jakarta';
  const ON_SHIFT = new Date('2026-08-20T02:00:00Z'); // 09:00 Jakarta (07–15 window)

  let adminUserId = '';
  let adminToken = '';
  let workerUserId = '';
  let workerProfileId = '';
  let teamWorkerUserId = '';
  let teamWorkerProfileId = '';

  let clientId = '';
  let buildingId = '';
  let templateId = '';
  let teamId = '';
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

  before(async () => {
    const db = await ensureTestDatabase();
    if (!db) return;
    database = db;
    pool = await initDatabase(db);
    await migrateUp(pool);
    await q(
      `TRUNCATE
         checklist_item_responses, checklist_items, checklist_executions,
         checklist_templates, task_assignments, generated_tasks,
         schedule_definitions, workforce_shift_assignments, shifts,
         workforce_profiles, teams, positions, departments, organizations,
         user_building_assignments, buildings, properties, users, clients
       CASCADE`,
    );

    const admin = await createAdminUser();
    adminUserId = admin.userId;
    adminToken = admin.token;

    // Spine.
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

    // Workers: one unteamed, one teamed. Both on shift at the building.
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
      team_id: null,
      position_id: positionId,
      user_id: workerUserId,
      employee_code: `WF_${suffix()}`,
      full_name: 'Worker',
    });

    teamWorkerUserId = await insertRow('users', {
      email: `tw_${suffix().toLowerCase()}@example.test`,
      display_name: 'Team Worker',
    });
    await insertRow('user_building_assignments', {
      user_id: teamWorkerUserId,
      building_id: buildingId,
      status: 'ACTIVE',
    });
    teamWorkerProfileId = await insertRow('workforce_profiles', {
      organization_id: orgId,
      department_id: deptId,
      team_id: teamId,
      position_id: positionId,
      user_id: teamWorkerUserId,
      employee_code: `WF_${suffix()}`,
      full_name: 'Team Worker',
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
    await insertRow('workforce_shift_assignments', {
      workforce_profile_id: teamWorkerProfileId,
      shift_id: shiftId,
      status: 'ACTIVE',
    });

    // Template with no required items → COMPLETE succeeds without responses.
    templateId = await insertRow('checklist_templates', {
      client_id: clientId,
      code: `TPL_${suffix()}`,
      name: 'Template',
      status: 'ACTIVE',
    });

    // Task with WORKFORCE assignment; task with TEAM assignment.
    workforceTaskId = await insertRow('generated_tasks', {
      client_id: clientId,
      schedule_definition_id: await insertRow('schedule_definitions', {
        client_id: clientId,
        code: `SD_${suffix()}`,
        name: 'Schedule',
        target_type: 'CHECKLIST_TEMPLATE',
        target_id: templateId,
        building_id: buildingId,
        start_at: '2026-08-01T00:00:00Z',
        timezone: TZ,
        status: 'ACTIVE',
      }),
      occurrence_at: '2026-08-05T01:00:00Z',
      target_type: 'CHECKLIST_TEMPLATE',
      target_id: templateId,
      building_id: buildingId,
      status: 'OPEN',
    });
    await insertRow('task_assignments', {
      task_id: workforceTaskId,
      assignee_type: 'WORKFORCE',
      workforce_profile_id: workerProfileId,
      team_id: null,
      assigned_by_user_id: adminUserId,
      status: 'ACTIVE',
    });

    teamTaskId = await insertRow('generated_tasks', {
      client_id: clientId,
      schedule_definition_id: await insertRow('schedule_definitions', {
        client_id: clientId,
        code: `SD_${suffix()}`,
        name: 'Schedule',
        target_type: 'CHECKLIST_TEMPLATE',
        target_id: templateId,
        building_id: buildingId,
        start_at: '2026-08-01T00:00:00Z',
        timezone: TZ,
        status: 'ACTIVE',
      }),
      occurrence_at: '2026-08-05T02:00:00Z',
      target_type: 'CHECKLIST_TEMPLATE',
      target_id: templateId,
      building_id: buildingId,
      status: 'OPEN',
    });
    await insertRow('task_assignments', {
      task_id: teamTaskId,
      assignee_type: 'TEAM',
      workforce_profile_id: null,
      team_id: teamId,
      assigned_by_user_id: adminUserId,
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

  it('columns exist, are nullable, FKs resolve, and CHECK is present', async (t) => {
    if (!ready(t)) return;
    for (const col of [
      'assignee_type',
      'assigned_workforce_profile_id',
      'assigned_team_id',
      'assignment_snapshot_at',
    ]) {
      const r = await q(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'checklist_executions' AND column_name = $1`,
        [col],
      );
      assert.equal(r.rowCount, 1, `${col} missing`);
      assert.equal(r.rows[0].is_nullable, 'YES', `${col} not nullable`);
    }
    const fk = await q(
      `SELECT ccu.table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'checklist_executions'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.column_name = 'id'`,
    );
    const fkTables = fk.rows.map((r: { table_name: string }) => r.table_name);
    assert.ok(fkTables.includes('workforce_profiles'));
    assert.ok(fkTables.includes('teams'));
    const chk = await q(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'checklist_executions'
          AND constraint_name = 'checklist_executions_assignee_snapshot_check'`,
    );
    assert.equal(chk.rowCount, 1);
  });

  it('new WORKFORCE task-bound execution snapshots WORKFORCE facts', async (t) => {
    if (!ready(t)) return;
    const row = await openChecklistExecutionForTask(workforceTaskId, workerUserId, ON_SHIFT);
    assert.equal(row.assignee_type, 'WORKFORCE');
    assert.equal(row.assigned_workforce_profile_id, workerProfileId);
    assert.equal(row.assigned_team_id, null);
    assert.ok(row.assignment_snapshot_at instanceof Date);
  });

  it('new TEAM task-bound execution snapshots TEAM facts (starter NOT workforce assignee)', async (t) => {
    if (!ready(t)) return;
    const row = await openChecklistExecutionForTask(teamTaskId, teamWorkerUserId, ON_SHIFT);
    assert.equal(row.assignee_type, 'TEAM');
    assert.equal(row.assigned_team_id, teamId);
    assert.equal(row.assigned_workforce_profile_id, null, 'team start user must not become workforce assignee');
    assert.ok(row.assignment_snapshot_at instanceof Date);
  });

  it('existing execution reuse does NOT refresh snapshot after reassignment', async (t) => {
    if (!ready(t)) return;
    const first = await openChecklistExecutionForTask(workforceTaskId, workerUserId, ON_SHIFT);
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

    const second = await openChecklistExecutionForTask(workforceTaskId, workerUserId, ON_SHIFT);
    assert.equal(second.id, first.id, 'same execution reused');
    assert.equal(second.assignee_type, 'WORKFORCE', 'snapshot must NOT be refreshed');
    assert.equal(second.assigned_workforce_profile_id, workerProfileId);
    assert.equal(second.assigned_team_id, null);
  });

  it('completion does not rewrite the snapshot', async (t) => {
    if (!ready(t)) return;
    const row = await openChecklistExecutionForTask(teamTaskId, teamWorkerUserId, ON_SHIFT);
    const finished = await finishChecklistExecution(row.id, teamWorkerUserId, 'complete');
    assert.equal(finished.status, 'COMPLETED');
    const persisted = await q(
      `SELECT assignee_type, assigned_team_id, assigned_workforce_profile_id, assignment_snapshot_at
         FROM checklist_executions WHERE id = $1`,
      [row.id],
    );
    assert.equal(persisted.rows[0].assignee_type, 'TEAM');
    assert.equal(persisted.rows[0].assigned_team_id, teamId);
    assert.equal(persisted.rows[0].assigned_workforce_profile_id, null);
  });

  it('generic REST creation leaves snapshot NULL', async (t) => {
    if (!ready(t)) return;
    const created = await api()
      .post(`/api/v1/checklist-templates/${templateId}/executions`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const persisted = await q(
      `SELECT assignee_type, assigned_workforce_profile_id, assigned_team_id, assignment_snapshot_at
         FROM checklist_executions WHERE id = $1`,
      [created.body.data.id],
    );
    assert.equal(persisted.rows[0].assignee_type, null);
    assert.equal(persisted.rows[0].assigned_workforce_profile_id, null);
    assert.equal(persisted.rows[0].assigned_team_id, null);
    assert.equal(persisted.rows[0].assignment_snapshot_at, null);
  });

  it('domain-bound creation leaves snapshot NULL', async (t) => {
    if (!ready(t)) return;
    // A domain-bound execution is inserted with only its base columns.
    const executionId = await insertRow('checklist_executions', {
      client_id: clientId,
      checklist_template_id: templateId,
      status: 'DRAFT',
    });
    const persisted = await q(
      `SELECT assignee_type, assigned_workforce_profile_id, assigned_team_id, assignment_snapshot_at
         FROM checklist_executions WHERE id = $1`,
      [executionId],
    );
    assert.equal(persisted.rows[0].assignee_type, null);
    assert.equal(persisted.rows[0].assigned_workforce_profile_id, null);
    assert.equal(persisted.rows[0].assigned_team_id, null);
    assert.equal(persisted.rows[0].assignment_snapshot_at, null);
  });
});
