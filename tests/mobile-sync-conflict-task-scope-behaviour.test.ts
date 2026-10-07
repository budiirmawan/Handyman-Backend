import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { AppError } from '../src/shared/errors';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { loadCurrentResourceState } from '../src/modules/mobile-sync/mobile-sync-conflict';
import type { MobileSyncRequestItem } from '../src/modules/mobile-sync/mobile-sync.types';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * STRAND-ADJ-01 FIX-01 — behavioural proof for the TASK_EXECUTION conflict scope.
 *
 * The companion structural test (mobile-sync-conflict-task-scope.test.ts) pins
 * WHICH loader the conflict probe uses. This test pins what that wiring is
 * FOR, against real rows, because the security property cannot be observed
 * from source text:
 *
 *   B. an actor whose accessible Building set does not contain the task's
 *      Building gets a fail-closed refusal BEFORE any current state exists,
 *      and the refusal carries no `current` payload;
 *   A/control. the SAME task id resolves normally for the actor who does own
 *      that Building — so B is scope, not an accidental total outage;
 *   C. an unknown task id keeps the canonical NOT_FOUND.
 *
 * Called at service level on purpose: `loadCurrentResourceState` IS the
 * conflict-probe read path, so this exercises it without RBAC/token ceremony
 * and without a batch harness. It also isolates the real regression risk —
 * the pre-fix path never called the actor at all, so no permission could have
 * masked it.
 */

const DB_PORT = 55462;
const DATA_DIR = '/tmp/asentra-fix01-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let scopedUserId = '';
let foreignUserId = '';
let accessibleTaskId = '';
let sealedTaskId = '';

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
  const rowId = randomUUID();
  const entries = Object.entries(values);
  const columns = entries.map(([c]) => c).join(', ');
  const placeholders = entries.map((_, i) => `$${i + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, v]) => v)],
  );
  return rowId;
}

async function makeClientHierarchy(prefix: string): Promise<{
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

/** A BE-07 generated task in an explicit Client/Building context. */
async function makeTask(
  clientId: string,
  buildingId: string | null,
  day: number,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_F1_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'FIX-01 Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: randomUUID(),
    building_id: buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientId,
    schedule_definition_id: scheduleId,
    occurrence_at: `2026-08-${String(day).padStart(2, '0')}T01:00:00Z`,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: scheduleId,
    building_id: buildingId,
    status: 'OPEN',
  });
}

function probe(resourceId: string): MobileSyncRequestItem {
  return {
    operationId: `fix01-${randomUUID().slice(0, 8)}`,
    resourceType: 'TASK_EXECUTION',
    resourceId,
    operation: 'START',
    clientTimestamp: '2026-08-09T00:00:00.000Z',
    data: { baseVersion: '2026-08-01T00:00:00.000Z' },
  };
}

async function captureRejection(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof AppError, 'expected an AppError from the authority');
    return error;
  }
  throw new Error('expected the probe to fail closed, but it resolved');
}

before(async () => {
  if (EMBEDDED_DATABASE) {
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await q(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, schedule_definitions, generated_tasks,
      task_assignments CASCADE`,
  );

  // Actor A — owns the Building that carries `accessibleTaskId`.
  const owner = await createAdminUser();
  scopedUserId = owner.userId;
  const mine = await makeClientHierarchy('FIX01_A');
  await buildingAssignmentService.createAssignment(scopedUserId, {
    buildingId: mine.buildingId,
  });
  accessibleTaskId = await makeTask(mine.clientId, mine.buildingId, 1);

  // Foreign actor — a real user with NO Building assignment, so its
  // accessible Building/Client sets are empty by construction (not by stub).
  foreignUserId = (await createAdminUser()).userId;

  // Target the fix: a task in a DIFFERENT client/building, reached by id only.
  const theirs = await makeClientHierarchy('FIX01_B');
  sealedTaskId = await makeTask(theirs.clientId, theirs.buildingId, 2);
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    database = null;
  }
});

/**
 * Resolved at RUN time, not at describe() time: the pool only exists after the
 * before-hook has run, so a flag computed while the file was loading would be
 * permanently false and would skip every test green. Absent a database these
 * tests FAIL loudly rather than skip quietly.
 */
function requireDatabase(): void {
  if (!pool) {
    throw new Error(
      'FIX-01 behavioural proof requires an isolated test database ' +
        '(set ASENTRA_USE_EMBEDDED_POSTGRES=true). Refusing to report a vacuous pass.',
    );
  }
}

describe('FIX-01 — TASK_EXECUTION conflict probe enforces BE-02G scope', () => {
  it('B: refuses an out-of-scope actor before any current payload exists', async () => {
    requireDatabase();
    const error = await captureRejection(() =>
      loadCurrentResourceState(probe(sealedTaskId), foreignUserId),
    );
    assert.equal(error.code, 'BUILDING_ACCESS_DENIED', 'B.1 fail closed on scope');
    assert.equal(error.statusCode, 403, 'B.2 the refusal is an authorization answer');
    // B.3 — the payload the defect disclosed must not ride along with a refusal.
    const refusal = error as unknown as Record<string, unknown>;
    assert.equal(refusal.conflict, undefined, 'B.3 no conflict payload on a refusal');
    assert.equal(refusal.current, undefined, 'B.4 no `current` task state on a refusal');
  });

  it('A/control: the same task resolves for the actor who owns that Building', async () => {
    requireDatabase();
    const state = await loadCurrentResourceState(
      probe(accessibleTaskId),
      scopedUserId,
    );
    assert.ok(state, 'A.1 the accessible probe still returns server state');
    const current = state!.current as Record<string, unknown>;
    assert.equal(current.id, accessibleTaskId, 'A.2 same canonical payload identity');
    assert.equal(current.status, 'OPEN', 'A.3 payload semantics unchanged');
    assert.equal(typeof current.updatedAt, 'string', 'A.4 payload shape unchanged');
    // A.5 the version used for baseVersion comparison is still the row's own
    // updated_at — the conflict protocol is untouched by the scope fix.
    const row = await q(
      'SELECT updated_at FROM generated_tasks WHERE id = $1',
      [accessibleTaskId],
    );
    assert.equal(
      state!.updatedAt,
      new Date(row.rows[0].updated_at).toISOString(),
      'A.5 updatedAt remains the authoritative generated_tasks.updated_at',
    );
  });

  it('C: an unknown task id keeps the canonical NOT_FOUND', async () => {
    requireDatabase();
    const error = await captureRejection(() =>
      loadCurrentResourceState(probe(randomUUID()), scopedUserId),
    );
    assert.equal(error.code, 'NOT_FOUND', 'C.1 unknown id is NOT_FOUND');
    assert.equal(error.message, 'Task not found.', 'C.2 canonical message preserved');
  });
});
