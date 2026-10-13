import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-MOBILE-ASSIGN-UUID-01 — PostgreSQL 16 mobile assignment UUID aggregate
 * compatibility (focused regression tests).
 *
 * Base defect (pre-existing at `edf26c8`, CR-BE-RN19-SAFETY-INSPECTION-01):
 * `GET /api/v1/mobile/assignments` 500s on PostgreSQL 16 with
 * `function min(uuid) does not exist` — `MIN(sib_row.id)` aggregates a uuid,
 * and PostgreSQL has no `min(uuid)`. The failure is at parse time.
 *
 * Intended aggregate semantics (unchanged by the fix):
 *   - 0 ACTIVE safety-inspection bindings → `safetyInspectionBindingId: null`
 *   - exactly 1 ACTIVE binding           → its id is exposed
 *   - >1 ACTIVE bindings                 → 409 SAFETY_INSPECTION_BINDING_AMBIGUOUS
 *   - non-ACTIVE bindings never count
 *   - only ACTIVE bindings of the task's own schedule definition are considered
 *     (strict company/property scope via the feed's accessible Building set)
 *
 * Fix under test: `MIN(sib_row.id::text)::uuid` (the codebase's established
 * pattern, cf. operational-variance.repository.ts). Deterministic: MIN over a
 * single-element set is that element; the CASE cardinality guard keeps 0 and
 * >1 at NULL (the >1 case is rejected before the value is used).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let adminToken = '';
let adminUserId = '';
let adminProfileId = '';
let noPermToken = '';
let emptyToken = '';
let emptyProfileId = '';

let clientA = '';
let buildingA = '';
let clientB = '';
let buildingB = '';
let sd1 = '';
let task1 = '';
let sd2 = '';
let task2 = '';

const id = () => randomUUID();

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(`INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`, [
    rowId,
    ...entries.map(([, value]) => value),
  ]);
  return rowId;
}

async function createClientHierarchy(prefix: string): Promise<{
  clientId: string;
  buildingId: string;
}> {
  const client = await clientService.createClient({
    code: `${prefix}_CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `${prefix}_PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `${prefix}_BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Building`,
  });
  return { clientId: client.id, buildingId: building.id };
}

async function createProfile(
  clientId: string,
  userId: string,
  prefix: string,
): Promise<string> {
  const organizationId = await insertRow('organizations', {
    client_id: clientId,
    code: `${prefix}_ORG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Org`,
    status: 'ACTIVE',
  });
  const departmentId = await insertRow('departments', {
    organization_id: organizationId,
    code: `${prefix}_DEPT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Dept`,
    status: 'ACTIVE',
  });
  const teamId = await insertRow('teams', {
    department_id: departmentId,
    code: `${prefix}_TEAM_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Team`,
    status: 'ACTIVE',
  });
  const positionId = await insertRow('positions', {
    organization_id: organizationId,
    code: `${prefix}_POS_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Position`,
    status: 'ACTIVE',
  });
  return insertRow('workforce_profiles', {
    organization_id: organizationId,
    department_id: departmentId,
    team_id: teamId,
    position_id: positionId,
    user_id: userId,
    employee_code: `${prefix}_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: `${prefix} Worker`,
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });
}

async function createTaskWithSchedule(
  clientId: string,
  buildingId: string,
  day: number,
): Promise<{ scheduleId: string; taskId: string }> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'UUID Fix Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: id(),
    building_id: buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  const taskId = await insertRow('generated_tasks', {
    client_id: clientId,
    schedule_definition_id: scheduleId,
    occurrence_at: `2026-08-0${day}T01:00:00Z`,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: scheduleId,
    building_id: buildingId,
    status: 'OPEN',
  });
  return { scheduleId, taskId };
}

async function assignTask(
  taskIdValue: string,
  profileId: string,
  assignedBy: string,
): Promise<void> {
  await insertRow('task_assignments', {
    task_id: taskIdValue,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: assignedBy,
    status: 'ACTIVE',
  });
}

async function addBinding(
  scheduleDefinitionId: string,
  clientId: string,
  buildingId: string,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<string> {
  return insertRow('safety_inspection_bindings', {
    client_id: clientId,
    building_id: buildingId,
    schedule_definition_id: scheduleDefinitionId,
    status,
  });
}

async function createUserWithPermissions(
  codes: { code: string; name: string }[],
  emailPrefix: string,
): Promise<{ token: string; userId: string }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const password = 'UuidFixPass123';
  const user = await userService.createUser({
    email: `${emailPrefix}-${suffix.toLowerCase()}@example.com`,
    displayName: 'UUID Fix User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${emailPrefix.toUpperCase()}_${suffix}`,
    name: 'UUID Fix Role',
  });
  for (const code of codes) {
    let permission = await permissionRepository.findByCode(code.code);
    if (!permission) {
      permission = await permissionService.createPermission(code);
    }
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

function getFeed(token: string, query = '') {
  return api()
    .get(`/api/v1/mobile/assignments${query}`)
    .set('Authorization', `Bearer ${token}`);
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, organizations, departments, teams, positions,
      workforce_profiles, schedule_definitions, generated_tasks,
      task_assignments, work_orders, work_order_assignments,
      safety_inspection_bindings
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await createClientHierarchy('U01_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });
  const b = await createClientHierarchy('U01_B');
  clientB = b.clientId;
  buildingB = b.buildingId;

  adminProfileId = await createProfile(clientA, adminUserId, 'U01');
  const t1 = await createTaskWithSchedule(clientA, buildingA, 1);
  sd1 = t1.scheduleId;
  task1 = t1.taskId;
  await assignTask(task1, adminProfileId, adminUserId);

  // Cross-company task (client B) assigned to the same profile — must stay
  // invisible; its schedule carries an ACTIVE binding so any scope leak would
  // surface as a marker mismatch rather than a silent empty row.
  const t2 = await createTaskWithSchedule(clientB, buildingB, 2);
  sd2 = t2.scheduleId;
  task2 = t2.taskId;
  await assignTask(task2, adminProfileId, adminUserId);
  await addBinding(sd2, clientB, buildingB, 'ACTIVE');

  // Empty-case user: permissions but no assignments at all.
  const empty = await createUserWithPermissions(
    [
      { code: 'task.read', name: 'Read Tasks' },
      { code: 'work_order.read', name: 'Read Work Orders' },
    ],
    'u01empty',
  );
  emptyToken = empty.token;
  emptyProfileId = await createProfile(clientA, empty.userId, 'U01E');

  // User missing the required permissions.
  const noPerm = await createUserWithPermissions([], 'u01noperm');
  noPermToken = noPerm.token;
});

after(async () => {
  if (pool && database) {
    await closePool(pool);
  }
});

describe('CR-HM-MOBILE-ASSIGN-UUID-01 — min(uuid) regression', () => {
  it('reproduces the PostgreSQL 16 parse error for MIN(uuid) and shows the fixed form preserves the guard semantics', async () => {
    // Reproduction: the base expression cannot even plan on PostgreSQL 16.
    await assert.rejects(
      q('SELECT MIN(id) FROM safety_inspection_bindings'),
      (error: Error) => {
        assert.match(error.message, /function min\(uuid\) does not exist/);
        return true;
      },
      'MIN(uuid) must fail on PostgreSQL 16 — this is the reproduced base defect',
    );

    // The fixed form parses and preserves the cardinality-guard semantics
    // (NULL / the id / NULL) for 0 / 1 / 2-row sets, tested as pure expression
    // semantics over a VALUES set (deterministic: MIN of one element is that
    // element; ordering only matters for >1 rows, where the guard projects NULL).
    // 0 rows
    let projected = await q(
      `SELECT COUNT(*)::INTEGER AS n,
              CASE WHEN COUNT(*) = 1 THEN MIN(x::text)::uuid ELSE NULL END AS projected_id
         FROM (SELECT NULL::uuid AS x WHERE false) AS t`,
    );
    assert.deepEqual(
      { n: projected.rows[0].n, projected_id: projected.rows[0].projected_id },
      { n: 0, projected_id: null },
      'zero rows must project NULL',
    );
    // 1 row
    const one = id();
    projected = await q(
      `SELECT COUNT(*)::INTEGER AS n,
              CASE WHEN COUNT(*) = 1 THEN MIN(x::text)::uuid ELSE NULL END AS projected_id
         FROM (VALUES ($1::uuid)) AS t(x)`,
      [one],
    );
    assert.deepEqual(
      { n: projected.rows[0].n, projected_id: projected.rows[0].projected_id },
      { n: 1, projected_id: one },
      'a single-element set must project its id (MIN of one element is that element)',
    );
    // 2 rows
    projected = await q(
      `SELECT COUNT(*)::INTEGER AS n,
              CASE WHEN COUNT(*) = 1 THEN MIN(x::text)::uuid ELSE NULL END AS projected_id
         FROM (VALUES ($1::uuid), ($2::uuid)) AS t(x)`,
      [one, id()],
    );
    assert.deepEqual(
      { n: projected.rows[0].n, projected_id: projected.rows[0].projected_id },
      { n: 2, projected_id: null },
      'a two-element set must project NULL (guard keeps the id hidden)',
    );

    // Real-table behavior: INACTIVE bindings never count, and the data-level
    // guard (partial unique) makes >1 ACTIVE bindings unreachable — the
    // 409 SAFETY_INSPECTION_BINDING_AMBIGUOUS path is defense-in-depth above it.
    await addBinding(sd1, clientA, buildingA, 'INACTIVE');
    const onlyBinding = await addBinding(sd1, clientA, buildingA, 'ACTIVE');
    let rows = await q<{ n: string; projected_id: string | null }>(
      `SELECT COUNT(*)::INTEGER AS n,
              CASE WHEN COUNT(*) = 1 THEN MIN(id::text)::uuid ELSE NULL END AS projected_id
         FROM safety_inspection_bindings
        WHERE schedule_definition_id = $1 AND status = 'ACTIVE'`,
      [sd1],
    );
    assert.deepEqual(
      { n: rows.rows[0].n, projected_id: rows.rows[0].projected_id },
      { n: 1, projected_id: onlyBinding },
      'exactly one ACTIVE binding (plus an INACTIVE one) must project the ACTIVE id',
    );
    await assert.rejects(
      addBinding(sd1, clientA, buildingA, 'ACTIVE'),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, '23505');
        assert.match(
          error.message,
          /safety_inspection_bindings_schedule_active_unique/,
        );
        return true;
      },
      'a second ACTIVE binding per schedule definition must be rejected by the partial unique guard',
    );
  });

  it('GET /api/v1/mobile/assignments returns 200 (was 500) and exposes the binding marker per cardinality', async () => {
    // Reset sd1 to zero bindings → 200 + null marker (the pre-fix code 500'd
    // on every request before reaching this shape).
    await q(`DELETE FROM safety_inspection_bindings WHERE schedule_definition_id = $1`, [sd1]);
    let response = await getFeed(adminToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    let items = response.body.data as any[];
    let item = items.find((entry) => entry.reference.taskId === task1);
    assert.ok(item, 'task 1 must be in the feed');
    assert.equal(item.type, 'TASK');
    assert.equal(
      item.reference.safetyInspectionBindingId,
      null,
      'zero ACTIVE bindings → null marker',
    );

    // Exactly one ACTIVE binding → 200 + its id exposed; INACTIVE ignored.
    const binding = await addBinding(sd1, clientA, buildingA, 'ACTIVE');
    await addBinding(sd1, clientA, buildingA, 'INACTIVE');
    response = await getFeed(adminToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    items = response.body.data as any[];
    item = items.find((entry) => entry.reference.taskId === task1);
    assert.ok(item);
    assert.equal(
      item.reference.safetyInspectionBindingId,
      binding,
      'exactly one ACTIVE binding → its id is exposed (INACTIVE binding ignored)',
    );

    // Actual API response sample (shape is part of the preserved contract).
    assert.equal(typeof item.reference.taskId, 'string');
    assert.equal(item.reference.workOrderId, null);
    assert.ok(Array.isArray(item.availableActions));
    console.log('[sample] GET /api/v1/mobile/assignments item:', JSON.stringify(item));

    // Remove the ACTIVE binding → 200 + null marker again.
    await q(
      `DELETE FROM safety_inspection_bindings
        WHERE schedule_definition_id = $1 AND status = 'ACTIVE'`,
      [sd1],
    );
    response = await getFeed(adminToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    item = (response.body.data as any[]).find(
      (entry) => entry.reference.taskId === task1,
    );
    assert.ok(item);
    assert.equal(item.reference.safetyInspectionBindingId, null);
  });

  it('keeps company/property isolation: cross-company tasks and their bindings never leak or break the feed', async () => {
    // task2 (client B) has 2 ACTIVE bindings on its schedule. The admin's feed
    // must remain 200 and must not contain the cross-company task at all.
    const response = await getFeed(adminToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const items = response.body.data as any[];
    assert.ok(
      !items.some((entry) => entry.reference.taskId === task2),
      'cross-company task must not appear in the feed',
    );
    assert.ok(items.some((entry) => entry.reference.taskId === task1));
  });

  it('returns an empty feed for a scoped user with no assignments', async () => {
    assert.ok(emptyProfileId);
    const response = await getFeed(emptyToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data, []);
  });

  it('supports pagination and the shift projection contract', async () => {
    const paged = await getFeed(adminToken, '?page=1&pageSize=1');
    assert.equal(paged.status, 200, JSON.stringify(paged.body));
    assert.equal((paged.body.data as any[]).length, 1);

    const shifted = await getFeed(adminToken, '?shift=current');
    assert.equal(shifted.status, 200, JSON.stringify(shifted.body));
    assert.ok(Array.isArray(shifted.body.data));

    const invalidShift = await getFeed(adminToken, '?shift=tomorrow');
    assert.equal(invalidShift.status, 400, JSON.stringify(invalidShift.body));
  });

  it('enforces RBAC on the feed', async () => {
    const anonymous = await api().get('/api/v1/mobile/assignments');
    assert.equal(anonymous.status, 401);

    const forbidden = await getFeed(noPermToken);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  });
});
