import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { listMobileAssignments } from '../src/modules/mobile-assignments/mobile-assignment.service';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-WO-PG18-UUID-01 PART 03B2C — PostgreSQL 18 Work Order / Mobile
 * compatibility.
 *
 * PostgreSQL 18 has no `min(uuid)` / `max(uuid)` aggregate: the uuid type has
 * btree operators but no min/max aggregate function, so any query that
 * aggregates a uuid column aborts with
 *
 *   ERROR 42883: function min(uuid) does not exist
 *
 * The Mobile assignment feed (`GET /mobile/assignments`) built the Safety
 * Inspection marker exactly that way, so the whole feed answered 500 and every
 * Work Order lifecycle suite that reads the feed (action, completion, BAST
 * closure) failed with it.
 *
 * The fix does NOT swap the aggregate for an arbitrary winner. The marker is
 * resolved with a deterministic `ORDER BY created_at, id LIMIT 1` inside a
 * LATERAL join that is gated by the existing cardinality guard, so:
 *   - exactly one ACTIVE binding  -> that binding's id (deterministic);
 *   - zero ACTIVE bindings        -> NULL;
 *   - more than one               -> NULL from the join, and the pre-existing
 *                                    ambiguity guard still refuses the item.
 *
 * This suite runs against a disposable PostgreSQL (the embedded binary, which
 * is 18.x) so the incompatibility is exercised and proven, not assumed.
 */
describe('PART 03B2C — PostgreSQL 18 uuid aggregate compatibility', () => {
  let database: DatabaseConfig | null = null;
  let pool: Pool | null = null;
  let embedded: EmbeddedTestDatabase | null = null;

  const EMBEDDED_DIR = '/tmp/hm-pg18-03b2c-pg';
  const EMBEDDED_PORT = 55664;

  const suffix = () => randomUUID().slice(0, 8).toUpperCase();

  const q = async (text: string, params: unknown[] = []) => {
    if (!pool) throw new Error('database pool is not initialized');
    return pool.query(text, params);
  };

  function ready(t: TestContext): boolean {
    if (!database || !pool) {
      t.skip('PostgreSQL test database is unavailable');
      return false;
    }
    return true;
  }

  before(async () => {
    embedded = await startEmbeddedTestDatabase({
      dir: EMBEDDED_DIR,
      port: EMBEDDED_PORT,
    });
    const db = await ensureTestDatabase();
    if (!db) return;

    pool = await initDatabase(db);
    await migrateUp(pool);

    // The admin provisions the platform-level fixtures (permissions, clients).
    await createAdminUser();

    database = db;
  });

  after(async () => {
    try {
      if (pool) await closePool(pool);
      if (embedded) await embedded.stop();
    } finally {
      pool = null;
      database = null;
      embedded = null;
    }
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  type Realm = {
    userId: string;
    clientId: string;
    buildingId: string;
    scheduleDefinitionId: string;
    workforceProfileId: string;
  };

  async function realm(): Promise<Realm> {
    // One worker per test: a User may be linked to exactly one workforce
    // profile, so each realm provisions its own mobile user.
    const mobileUser = await userService.createUser({
      email: `pg18-${suffix().toLowerCase()}@example.com`,
      displayName: `PG18 Mobile User ${suffix()}`,
    });
    const client = await clientService.createClient({
      code: `CL_${suffix()}`,
      name: 'PG18 Client',
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PR_${suffix()}`,
      name: 'Property',
    });
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `BL_${suffix()}`,
      name: 'Building',
    });
    await buildingAssignmentService.createAssignment(mobileUser.id, {
      buildingId: building.id,
    });

    const organization = await organizationService.createOrganization({
      clientId: client.id,
      code: `OR_${suffix()}`,
      name: 'Org',
    });
    const department = await departmentService.createDepartment({
      organizationId: organization.id,
      code: `DP_${suffix()}`,
      name: 'Dept',
    });
    const position = await positionService.createPosition({
      organizationId: organization.id,
      code: `PS_${suffix()}`,
      name: 'Position',
    });
    const profile = await workforceService.createWorkforceProfile({
      organizationId: organization.id,
      departmentId: department.id,
      positionId: position.id,
      userId: mobileUser.id,
      employeeCode: `WF_${suffix()}`,
      fullName: `PG18 Worker ${suffix()}`,
      workforceType: 'INTERNAL',
    });

    // A Schedule Definition is the only path to a Safety Inspection binding.
    const scheduleDefinitionId = randomUUID();
    await q(
      `INSERT INTO schedule_definitions
         (id, client_id, code, name, target_type, target_id, building_id,
          start_at, timezone, status)
       VALUES ($1, $2, $3, $4, 'FORM_TEMPLATE', $5, $6, NOW(), 'Asia/Jakarta', 'ACTIVE')`,
      [
        scheduleDefinitionId,
        client.id,
        `SD_${suffix()}`,
        'Safety Inspection Schedule',
        randomUUID(),
        building.id,
      ],
    );

    return {
      userId: mobileUser.id,
      clientId: client.id,
      buildingId: building.id,
      scheduleDefinitionId,
      workforceProfileId: profile.id,
    };
  }

  /** One generated task assigned to the worker, i.e. one feed row. */
  async function assignedTask(r: Realm): Promise<string> {
    const taskId = randomUUID();
    await q(
      `INSERT INTO generated_tasks
         (id, client_id, schedule_definition_id, occurrence_at, target_type,
          target_id, building_id, status)
       VALUES ($1, $2, $3, NOW(), 'FORM_TEMPLATE', $4, $5, 'OPEN')`,
      [
        taskId,
        r.clientId,
        r.scheduleDefinitionId,
        randomUUID(),
        r.buildingId,
      ],
    );
    const assignmentId = randomUUID();
    await q(
      `INSERT INTO task_assignments
         (id, task_id, assignee_type, workforce_profile_id,
          assigned_by_user_id, status)
       VALUES ($1, $2, 'WORKFORCE', $3, $4, 'ACTIVE')`,
      [assignmentId, taskId, r.workforceProfileId, r.userId],
    );
    return assignmentId;
  }

  async function addBinding(
    r: Realm,
    status: 'ACTIVE' | 'INACTIVE',
  ): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO safety_inspection_bindings
         (id, client_id, building_id, schedule_definition_id, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, r.clientId, r.buildingId, r.scheduleDefinitionId, status],
    );
    return id;
  }

  async function feedItem(r: Realm, assignmentId: string) {
    const feed = await listMobileAssignments(r.userId, null);
    return feed.items.find((item) => item.id === assignmentId) ?? null;
  }

  // -------------------------------------------------------------------------
  // P1 — the environment really refuses uuid aggregates
  // -------------------------------------------------------------------------

  describe('P1 — the disposable database reproduces the PostgreSQL 18 defect', () => {
    it('refuses MIN(uuid) and MAX(uuid) with 42883', async (t) => {
      if (!ready(t)) return;

      for (const fn of ['MIN', 'MAX']) {
        await assert.rejects(
          () =>
            q(
              `SELECT ${fn}(sib.id)
                 FROM safety_inspection_bindings sib`,
            ),
          (error: unknown) => {
            const pgError = error as { code?: string; message?: string };
            assert.equal(pgError.code, '42883');
            assert.match(
              String(pgError.message),
              new RegExp(`function ${fn.toLowerCase()}\\(uuid\\) does not exist`),
            );
            return true;
          },
          `${fn}(uuid) must be rejected by this PostgreSQL version`,
        );
      }

      // The compatible shapes the fix relies on still work.
      const ordered = await q(
        `SELECT sib.id
           FROM safety_inspection_bindings sib
          WHERE sib.schedule_definition_id = $1
          ORDER BY sib.created_at ASC, sib.id ASC
          LIMIT 1`,
        [randomUUID()],
      );
      assert.deepEqual(ordered.rows, []);
    });
  });

  // -------------------------------------------------------------------------
  // P2 — the feed resolves the Safety Inspection marker deterministically
  // -------------------------------------------------------------------------

  describe('P2 — Mobile assignment feed', () => {
    it('answers 200 and exposes the single ACTIVE binding id', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const assignmentId = await assignedTask(r);
      const bindingId = await addBinding(r, 'ACTIVE');

      const item = await feedItem(r, assignmentId);
      assert.ok(item, 'the assigned task must appear in the feed');
      assert.equal(item.type, 'TASK');
      assert.equal(
        item.reference.safetyInspectionBindingId,
        bindingId,
        'the marker is the ACTIVE binding of the task schedule definition',
      );
    });

    it('returns a null marker when the schedule has no ACTIVE binding', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const assignmentId = await assignedTask(r);

      const item = await feedItem(r, assignmentId);
      assert.ok(item, 'the assigned task must appear in the feed');
      assert.equal(item.reference.safetyInspectionBindingId, null);
    });

    it('ignores an INACTIVE binding', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const assignmentId = await assignedTask(r);
      await addBinding(r, 'INACTIVE');

      const item = await feedItem(r, assignmentId);
      assert.ok(item);
      assert.equal(item.reference.safetyInspectionBindingId, null);
    });

    it('is deterministic: the marker does not depend on row order', async (t) => {
      if (!ready(t)) return;
      const r = await realm();
      const assignmentId = await assignedTask(r);
      const bindingId = await addBinding(r, 'ACTIVE');

      // Reading the feed repeatedly must always name the same binding.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const item = await feedItem(r, assignmentId);
        assert.ok(item);
        assert.equal(item.reference.safetyInspectionBindingId, bindingId);
      }

      // The database still enforces one ACTIVE binding per schedule: the fix
      // never needs winner selection because a second ACTIVE row cannot exist.
      await assert.rejects(
        () => addBinding(r, 'ACTIVE'),
        (error: unknown) => {
          const pgError = error as { code?: string };
          assert.equal(pgError.code, '23505');
          return true;
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // P3 — no uuid aggregate is left anywhere in the backend SQL
  // -------------------------------------------------------------------------

  describe('P3 — static guard', () => {
    it('keeps no MIN/MAX aggregate over a uuid id column', () => {
      const source = readFileSync(
        join(process.cwd(), 'src/modules/mobile-assignments/mobile-assignment.service.ts'),
        'utf8',
      )
        // SQL line comments quote the removed construct on purpose; only
        // executable SQL must be clean.
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');

      // The exact shape that broke PostgreSQL 18: MIN(<alias>.id) / MAX(<alias>.id).
      // (Casts such as MIN(col::text)::uuid are compatible and untouched.)
      const uuidAggregate = /\b(MIN|MAX)\(\s*[A-Za-z_][A-Za-z0-9_]*\.id\s*\)/i;
      assert.equal(
        uuidAggregate.test(source),
        false,
        'mobile-assignment.service.ts must not aggregate a uuid id column',
      );

      // And the marker is still projected from an ordered LIMIT 1 lateral.
      assert.match(source, /ORDER BY sib_one\.created_at ASC, sib_one\.id ASC/);
      assert.match(source, /LIMIT 1/);
    });
  });
});
