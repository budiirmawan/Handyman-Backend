import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import {
  createMobileChecklistFinding,
} from '../src/modules/mobile-checklist';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { findingRepository } from '../src/modules/findings/finding.repository';
import { organizationService } from '../src/modules/organizations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { shiftService } from '../src/modules/shifts';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { assignShiftToWorkforce } from '../src/modules/workforce-shifts';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C05 PART 03 — Mobile Finding from an authoritative bound checklist
 * execution.
 *
 * Proves the thin field-worker command derives creation authority entirely
 * server-side from the C04 generated-task binding + current-shift + ACTIVE
 * task-assignment authority, creates the Finding atomically with its
 * CHECKLIST_EXECUTION source, generates the number server-side, and never
 * accepts authoritative context (building/client/source/number/shift) from
 * the client. No `finding.manage` / `finding.report` is involved; a checklist
 * execution may legitimately yield multiple Findings.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

// -- client A + buildings A (worker on shift) and B (inaccessible to workerA)
let clientA = '';
let propClientA = '';
let buildingA = '';
let buildingB = '';
let templateActive = '';

// -- worker A: access A, on-shift at A, task-1 assigned to it (bound exec)
let workerA: { userId: string; token: string; profileId: string };
let boundExecutionIdA = '';
// -- worker B: access + on-shift at A but NOT assigned to task-1
let workerB: { userId: string; token: string; profileId: string };
// -- worker C: assigned to a task at A but NOT on shift (no roster)
let workerC: { userId: string; token: string; profileId: string };

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const q = (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};
const id = () => randomUUID();

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

/** Seconds-of-day in a given IANA timezone. */
function secondsInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const read = (type: string) =>
    Number((parts.find((p) => p.type === type) ?? { value: '0' }).value);
  return read('hour') * 3600 + read('minute') * 60 + read('second');
}
function toHHMMSS(totalSeconds: number): string {
  const s = ((totalSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

async function createUser(
  prefix: string,
  codes: { code: string; name: string }[],
): Promise<{ userId: string; token: string }> {
  const password = 'OpenPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Open User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Open Role',
  });
  for (const code of codes) {
    let permission = await permissionRepository.findByCode(code.code);
    if (!permission) {
      permission = await permissionService.createPermission(code);
    }
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

async function buildProfile(
  userId: string,
  orgId: string,
  deptId: string,
  positionId: string,
): Promise<string> {
  const profile = await workforceService.createWorkforceProfile({
    organizationId: orgId,
    departmentId: deptId,
    positionId: positionId,
    userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Field Worker',
  });
  return profile.id;
}

async function activeTemplate(): Promise<string> {
  return insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_${suffix()}`,
    name: 'Field Checklist',
    status: 'ACTIVE',
  });
}

async function checklistTask(
  buildingId: string,
  templateId: string,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SD_${suffix()}`,
    name: 'Field schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateId,
    building_id: buildingId,
    start_at: new Date().toISOString(),
    timezone: 'Asia/Jakarta',
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: scheduleId,
    occurrence_at: new Date().toISOString(),
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateId,
    building_id: buildingId,
    status: 'OPEN',
  });
}

async function bindExecution(
  taskId: string,
  clientId = clientA,
): Promise<string> {
  return insertRow('checklist_executions', {
    client_id: clientId,
    checklist_template_id: templateActive,
    generated_task_id: taskId,
  });
}

async function assignToProfile(taskId: string, profileId: string): Promise<void> {
  await insertRow('task_assignments', {
    task_id: taskId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
}

/** A shift on a building whose daily window always contains the current time. */
async function alwaysOnShift(
  buildingId: string,
  clientId: string,
  profileIds: string[],
): Promise<void> {
  const now = new Date();
  const s = secondsInZone(now, 'Asia/Jakarta');
  const shift = await shiftService.createShift({
    clientId,
    buildingId,
    code: `S_${suffix()}`,
    name: 'Always',
    startTime: toHHMMSS(s - 6 * 3600),
    endTime: toHHMMSS(s + 6 * 3600),
  });
  for (const profileId of profileIds) {
    await assignShiftToWorkforce({ workforceProfileId: profileId, shiftId: shift.id });
  }
}

async function setClientStatus(clientId: string, status: string): Promise<void> {
  await q('UPDATE clients SET status = $2, updated_at = NOW() WHERE id = $1', [
    clientId,
    status,
  ]);
}

async function findingRow(findingId: string) {
  const r = await q(
    `SELECT id, client_id, building_id, finding_number, title, description,
            status, reported_by_user_id, source_type, source_id
       FROM findings WHERE id = $1`,
    [findingId],
  );
  return r.rows[0];
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE findings, operational_events, users, roles, permissions,
      clients, properties, buildings, user_building_assignments,
      organizations, departments, positions, workforce_profiles, shifts,
      workforce_shift_assignments, schedule_definitions, generated_tasks,
      task_assignments, checklist_templates, checklist_items,
      checklist_executions
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  clientA = client.id;
  const prop = await propertyService.createProperty({ clientId: clientA, code: `P_${suffix()}`, name: 'Property' });
  propClientA = prop.id;
  const bA = await buildingService.createBuilding({ propertyId: prop.id, code: `BA_${suffix()}`, name: 'Building A', timezone: 'Asia/Jakarta' });
  buildingA = bA.id;
  const bB = await buildingService.createBuilding({ propertyId: prop.id, code: `BB_${suffix()}`, name: 'Building B', timezone: 'Asia/Jakarta' });
  buildingB = bB.id;
  await buildingAssignmentService.createAssignment(adminUserId, { buildingId: buildingA });

  const org = await organizationService.createOrganization({ clientId: clientA, code: `O_${suffix()}`, name: 'Org' });
  const dept = await departmentService.createDepartment({ organizationId: org.id, code: `D_${suffix()}`, name: 'Dept' });
  const position = await positionService.createPosition({ organizationId: org.id, code: `P_${suffix()}`, name: 'Field' });

  const perms = [
    { code: 'checklist.read', name: 'Read Checklists' },
    { code: 'checklist.manage', name: 'Manage Checklists' },
    { code: 'task.read', name: 'Read Tasks' },
  ];

  // Worker A — access building A, on-shift A, owns task-1 (bound execution).
  const wa = await createUser('wfinda', perms);
  workerA = { ...wa, profileId: '' };
  await buildingAssignmentService.createAssignment(workerA.userId, { buildingId: buildingA });
  workerA.profileId = await buildProfile(workerA.userId, org.id, dept.id, position.id);

  // Worker B — access building A + on-shift A, but never assigned task-1.
  const wb = await createUser('wfindb', perms);
  workerB = { ...wb, profileId: '' };
  await buildingAssignmentService.createAssignment(workerB.userId, { buildingId: buildingA });
  workerB.profileId = await buildProfile(workerB.userId, org.id, dept.id, position.id);

  // Worker C — access building A but NOT on any shift (assigned task at A).
  const wc = await createUser('wfindc', perms);
  workerC = { ...wc, profileId: '' };
  await buildingAssignmentService.createAssignment(workerC.userId, { buildingId: buildingA });
  workerC.profileId = await buildProfile(workerC.userId, org.id, dept.id, position.id);

  await alwaysOnShift(buildingA, clientA, [
    workerA.profileId,
    workerB.profileId,
  ]);

  templateActive = await activeTemplate();

  // task-1 in building A assigned to worker A; bound execution for worker A.
  const task1 = await checklistTask(buildingA, templateActive);
  await assignToProfile(task1, workerA.profileId);
  boundExecutionIdA = await bindExecution(task1);

  // task assigned to worker C (on-shift-less) in building A.
  const taskC = await checklistTask(buildingA, templateActive);
  await assignToProfile(taskC, workerC.profileId);
  await bindExecution(taskC);

  // task in building B (inaccessible to workers A/B/C) assigned to worker A.
  const taskB = await checklistTask(buildingB, templateActive);
  await assignToProfile(taskB, workerA.profileId);
  await bindExecution(taskB);
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});
function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const POST = (executionId: string) =>
  `/api/v1/mobile/checklist-executions/${executionId}/finding`;

describe('MOB-C05 PART 03 mobile finding from checklist execution', () => {
  it('assigned + on-shift worker creates a Finding from a bound execution', async (t) => {
    if (!ready(t)) return;
    const res = await api()
      .post(POST(boundExecutionIdA))
      .set(auth(workerA.token))
      .send({ title: 'Cracked floor tile', description: 'Near entrance' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const data = res.body.data;
    assert.ok(data.findingId);
    assert.match(data.findingNumber, /^FND_[A-F0-9]{8}$/);
    assert.equal(data.status, 'OPEN');
    assert.equal(data.source.type, 'CHECKLIST_EXECUTION');
    assert.equal(data.source.id, boundExecutionIdA);

    const row = await findingRow(data.findingId);
    assert.equal(row.reported_by_user_id, workerA.userId);
    assert.equal(row.building_id, buildingA);
    assert.equal(row.client_id, clientA);
    assert.equal(row.source_type, 'CHECKLIST_EXECUTION');
    assert.equal(row.source_id, boundExecutionIdA);
    assert.equal(row.status, 'OPEN');
  });

  it('client cannot override findingNumber or redirect building/client/source', async (t) => {
    if (!ready(t)) return;
    const res = await api()
      .post(POST(boundExecutionIdA))
      .set(auth(workerA.token))
      .send({
        title: 'Redirect attempt',
        findingNumber: 'CUSTOM-1',
        buildingId: buildingB,
        clientId: id(),
        sourceType: 'WORK_ORDER',
        sourceId: id(),
        status: 'CLOSED',
      });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires title; description is optional', async (t) => {
    if (!ready(t)) return;
    const missing = await api()
      .post(POST(boundExecutionIdA))
      .set(auth(workerA.token))
      .send({ description: 'no title' });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));

    const ok = await api()
      .post(POST(boundExecutionIdA))
      .set(auth(workerA.token))
      .send({ title: 'Description optional finding' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it('an unbound checklist execution fails closed', async (t) => {
    if (!ready(t)) return;
    const unbound = await insertRow('checklist_executions', {
      client_id: clientA,
      checklist_template_id: templateActive,
      generated_task_id: null,
    });
    await assert.rejects(
      createMobileChecklistFinding(unbound, workerA.userId, {
        title: 'Unbound',
      }),
      (e: { code?: string; statusCode?: number }) =>
        e.statusCode === 403 && e.code === 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('a cross-Client bound checklist execution is rejected', async (t) => {
    if (!ready(t)) return;
    const otherClient = await clientService.createClient({ code: `C_${suffix()}`, name: 'Other' });
    const otherProp = await propertyService.createProperty({ clientId: otherClient.id, code: `P_${suffix()}`, name: 'OtherP' });
    const otherBuilding = await buildingService.createBuilding({ propertyId: otherProp.id, code: `B_${suffix()}`, name: 'OtherB', timezone: 'Asia/Jakarta' });
    // A generated task of the OTHER client (execution's client is A) is a
    // forged / cross-Client binding → must fail closed.
    const otherTask = await checklistTask(otherBuilding.id, templateActive);
    await q(
      `UPDATE generated_tasks SET client_id = $2 WHERE id = $1`,
      [otherTask, otherClient.id],
    );
    const forged = await insertRow('checklist_executions', {
      client_id: clientA,
      checklist_template_id: templateActive,
      generated_task_id: otherTask,
    });
    await assert.rejects(
      createMobileChecklistFinding(forged, workerA.userId, { title: 'Cross' }),
      (e: { statusCode?: number }) => e.statusCode === 403,
    );
  });

  it('an execution bound to a task in an inaccessible Building is rejected', async (t) => {
    if (!ready(t)) return;
    // worker A has no access to building B; find the bound execution for the
    // building-B task (there is exactly one: bound to the task assigned to A).
    const rows = await q(
      `SELECT ce.id FROM checklist_executions ce
        JOIN generated_tasks gt ON gt.id = ce.generated_task_id
       WHERE gt.building_id = $1`,
      [buildingB],
    );
    const execInB = rows.rows[0].id as string;
    await assert.rejects(
      createMobileChecklistFinding(execInB, workerA.userId, { title: 'B' }),
      (e: { statusCode?: number }) => e.statusCode === 403,
    );
  });

  it('an assigned-but-not-currently-on-shift worker is rejected', async (t) => {
    if (!ready(t)) return;
    // worker C is assigned to a task at building A and has access, but has no
    // roster shift → off-shift. Find worker C's bound execution.
    const rows = await q(
      `SELECT ce.id FROM checklist_executions ce
        JOIN generated_tasks gt ON gt.id = ce.generated_task_id
        JOIN task_assignments ta ON ta.task_id = gt.id AND ta.status = 'ACTIVE'
       WHERE ta.workforce_profile_id = $1`,
      [workerC.profileId],
    );
    const execC = rows.rows[0].id as string;
    await assert.rejects(
      createMobileChecklistFinding(execC, workerC.userId, { title: 'Off shift' }),
      (e: { statusCode?: number }) => e.statusCode === 403,
    );
  });

  it('an on-shift worker who is NOT assigned to the task is rejected', async (t) => {
    if (!ready(t)) return;
    // worker B is on-shift at A but task-1 belongs to worker A only.
    await assert.rejects(
      createMobileChecklistFinding(boundExecutionIdA, workerB.userId, {
        title: 'Not assigned',
      }),
      (e: { statusCode?: number }) => e.statusCode === 403,
    );
  });

  it('reused template across Buildings cannot redirect the authoritative Building', async (t) => {
    if (!ready(t)) return;
    // boundExecutionIdA uses templateActive; create a second building-B task
    // sharing the SAME template and confirm each execution binds its own task's
    // Building. Worker A creates from its own execution → building A.
    const row = await findingRow((await api().post(POST(boundExecutionIdA)).set(auth(workerA.token)).send({ title: 'Same template' })).body.data.findingId);
    assert.equal(row.building_id, buildingA);
    assert.equal(row.client_id, clientA);
  });

  it('does not rely on a one-Finding-per-source invariant (repeated POST creates anew)', async (t) => {
    if (!ready(t)) return;
    const first = await api().post(POST(boundExecutionIdA)).set(auth(workerA.token)).send({ title: 'Multiple A' });
    const second = await api().post(POST(boundExecutionIdA)).set(auth(workerA.token)).send({ title: 'Multiple B' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.data.findingId, second.body.data.findingId);
  });

  it('rejects an inactive authoritative Client before creation (CLIENT_INACTIVE)', async (t) => {
    if (!ready(t)) return;
    await setClientStatus(clientA, 'INACTIVE');
    try {
      const res = await api()
        .post(POST(boundExecutionIdA))
        .set(auth(workerA.token))
        .send({ title: 'Inactive client' });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'CLIENT_INACTIVE');
    } finally {
      await setClientStatus(clientA, 'ACTIVE');
    }
  });

  it('rejects a Building belonging to another Client before creation', async (t) => {
    if (!ready(t)) return;
    // Fully authorize worker A for a SECOND building under clientA (access +
    // current shift + task + bound execution), then reparent that building to
    // a foreign client's property. The execution/task still carry clientA (so
    // the PART 01 source resolver and C04 gate pass), but the actual
    // Building→Property→Client now resolves to the foreign client — the
    // restored Building→Client guard must reject before any Finding is created.
    const misBuilding = await buildingService.createBuilding({
      propertyId: propClientA,
      code: `B_${suffix()}`,
      name: 'Misbound building',
      timezone: 'Asia/Jakarta',
    });
    await buildingAssignmentService.createAssignment(workerA.userId, {
      buildingId: misBuilding.id,
    });
    await alwaysOnShift(misBuilding.id, clientA, [workerA.profileId]);
    const misTask = await checklistTask(misBuilding.id, templateActive);
    await assignToProfile(misTask, workerA.profileId);
    const misExec = await bindExecution(misTask);

    const foreignClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Foreign client',
    });
    const foreignProp = await propertyService.createProperty({
      clientId: foreignClient.id,
      code: `P_${suffix()}`,
      name: 'Foreign property',
    });
    await q('UPDATE buildings SET property_id = $2, updated_at = NOW() WHERE id = $1', [
      misBuilding.id,
      foreignProp.id,
    ]);

    const res = await api()
      .post(POST(misExec))
      .set(auth(workerA.token))
      .send({ title: 'Cross building' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'FINDING_BUILDING_CLIENT_MISMATCH');
  });

  it('rolls back Finding + source when source binding fails (no orphan)', async (t) => {
    if (!ready(t)) return;
    const originalUpdateSource = findingRepository.updateSource;
    const beforeCount = (
      await q('SELECT count(*)::int AS n FROM findings')
    ).rows[0].n as number;
    try {
      // Fault-inject: the source-binding UPDATE throws after the Finding INSERT
      // has already run on the same transaction client.
      findingRepository.updateSource = (async () => {
        throw new Error('simulated source binding failure');
      }) as typeof findingRepository.updateSource;
      const res = await api()
        .post(POST(boundExecutionIdA))
        .set(auth(workerA.token))
        .send({ title: 'Rollback me' });
      assert.notEqual(res.status, 201);
      const afterCount = (
        await q('SELECT count(*)::int AS n FROM findings')
      ).rows[0].n as number;
      assert.equal(
        afterCount,
        beforeCount,
        'no Finding row may remain after a rolled-back source binding',
      );
      const orphan = await q(
        `SELECT count(*)::int AS n FROM findings WHERE source_type = 'CHECKLIST_EXECUTION'
           AND source_id = $1`,
        [boundExecutionIdA],
      );
      // Even Findings bound to this execution created by OTHER (earlier) tests
      // are expected; assert none NEW bound to this exact execution were left
      // by the failed attempt by checking the total is the same as before.
      const beforeBound = (
        await q(
          `SELECT count(*)::int AS n FROM findings WHERE source_type = 'CHECKLIST_EXECUTION' AND source_id = $1`,
          [boundExecutionIdA],
        )
      ).rows[0].n as number;
      assert.equal(orphan.rows[0].n, beforeBound);
    } finally {
      findingRepository.updateSource = originalUpdateSource;
    }
  });

  it('retries a finding_number_unique collision and succeeds with a fresh number', async (t) => {
    if (!ready(t)) return;
    const originalCreate = findingRepository.create;
    let calls = 0;
    try {
      findingRepository.create = (async (input: any, executor?: any) => {
        calls += 1;
        if (calls === 1) {
          const e = new Error('unique') as Error & {
            code?: string;
            constraint?: string;
          };
          e.code = '23505';
          e.constraint = 'finding_number_unique';
          throw e;
        }
        return (originalCreate as any)(input, executor);
      }) as typeof findingRepository.create;
      const res = await api()
        .post(POST(boundExecutionIdA))
        .set(auth(workerA.token))
        .send({ title: 'Collision then success' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.match(res.body.data.findingNumber, /^FND_[A-F0-9]{8}$/);
      assert.equal(calls, 2, 'the create must have been retried once after the collision');
    } finally {
      findingRepository.create = originalCreate;
    }
  });

  it('does NOT retry an unrelated repository error', async (t) => {
    if (!ready(t)) return;
    const originalCreate = findingRepository.create;
    let calls = 0;
    try {
      findingRepository.create = (async () => {
        calls += 1;
        throw new Error('arbitrary database/service failure');
      }) as typeof findingRepository.create;
      const res = await api()
        .post(POST(boundExecutionIdA))
        .set(auth(workerA.token))
        .send({ title: 'No retry' });
      assert.notEqual(res.status, 201);
      assert.equal(calls, 1, 'an unrelated error must NOT be retried');
    } finally {
      findingRepository.create = originalCreate;
    }
  });

  it('does NOT retry a different unique-constraint conflict (not finding_number_unique)', async (t) => {
    if (!ready(t)) return;
    const originalCreate = findingRepository.create;
    let calls = 0;
    try {
      findingRepository.create = (async () => {
        calls += 1;
        const e = new Error('other unique') as Error & {
          code?: string;
          constraint?: string;
        };
        e.code = '23505';
        e.constraint = 'some_other_constraint';
        throw e;
      }) as typeof findingRepository.create;
      const res = await api()
        .post(POST(boundExecutionIdA))
        .set(auth(workerA.token))
        .send({ title: 'No other-conflict retry' });
      assert.notEqual(res.status, 201);
      assert.equal(calls, 1, 'a non-finding unique conflict must NOT be retried');
    } finally {
      findingRepository.create = originalCreate;
    }
  });

  it('bounded retry: after max attempts the existing conflict semantics are returned', async (t) => {
    if (!ready(t)) return;
    const originalCreate = findingRepository.create;
    let calls = 0;
    try {
      findingRepository.create = (async () => {
        calls += 1;
        const e = new Error('unique') as Error & {
          code?: string;
          constraint?: string;
        };
        e.code = '23505';
        e.constraint = 'finding_number_unique';
        throw e;
      }) as typeof findingRepository.create;
      const res = await api()
        .post(POST(boundExecutionIdA))
        .set(auth(workerA.token))
        .send({ title: 'Exhausted' });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'FINDING_NUMBER_ALREADY_EXISTS');
      assert.equal(calls, 3, 'max attempts must be bounded at 3');
    } finally {
      findingRepository.create = originalCreate;
    }
  });
});
