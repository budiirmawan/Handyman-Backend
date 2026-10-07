import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  createManagementReadModelContract,
  managementReadPeriodRange,
  parseManagementReadScopeQuery,
  type PublicManagementReadScopeContext,
} from '../src/modules/management-read-scope';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 01 focused tests — scope/contract foundation only. */

const PATH = '/api/v1/management/read-scope';
const MANAGEMENT_PERMISSION = {
  code: 'management_read_model.read',
  name: 'Read Management and Owner Read Models',
} as const;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';
let plainToken = '';
let noAssignmentToken = '';
let fixtures: Awaited<ReturnType<typeof seedScope>> | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE buildings, properties, user_building_assignments,
       user_role_assignments, role_permission_assignments,
       user_sessions, user_credentials, users, roles, permissions, clients
     CASCADE`,
  );

  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  plainToken = await createPlainSession();
  noAssignmentToken = await createSessionWithPermissions([
    MANAGEMENT_PERMISSION,
  ]);
  fixtures = await seedScope();
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool || !fixtures) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function seedScope() {
  const clientA = await clientService.createClient({
    code: `MGA_${suffix()}`,
    name: 'Management Client A',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `PA_${suffix()}`,
    name: 'Property A',
  });
  const buildingA1 = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `A1_${suffix()}`,
    name: 'Building A1',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `A2_${suffix()}`,
    name: 'Building A2',
  });

  const clientB = await clientService.createClient({
    code: `MGB_${suffix()}`,
    name: 'Management Client B',
  });
  const propertyB = await propertyService.createProperty({
    clientId: clientB.id,
    code: `PB_${suffix()}`,
    name: 'Property B',
  });
  const buildingB1 = await buildingService.createBuilding({
    propertyId: propertyB.id,
    code: `B1_${suffix()}`,
    name: 'Building B1',
  });
  const inaccessibleBuilding = await buildingService.createBuilding({
    propertyId: propertyB.id,
    code: `BX_${suffix()}`,
    name: 'Inaccessible Building',
  });

  for (const building of [buildingA1, buildingA2, buildingB1]) {
    await buildingAssignmentService.createAssignment(managerUserId, {
      buildingId: building.id,
    });
  }

  return {
    clientA,
    clientB,
    buildingA1,
    buildingA2,
    buildingB1,
    inaccessibleBuilding,
  };
}

function ids(value: string[]): string[] {
  return [...value].sort();
}

describe('BE-24 PART 01 — Management read-scope contract', () => {
  it('registers the additive read permission and authoritative OpenAPI path', () => {
    assert.ok(
      FOUNDATION_PERMISSIONS.some(
        (permission) => permission.code === MANAGEMENT_PERMISSION.code,
      ),
    );
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/read-scope']);
    assert.ok(spec.components?.schemas?.ManagementReadScopeContext);
    assert.ok(spec.components?.schemas?.ManagementReadModelContract);
  });

  it('uses BE-23-compatible UTC date windows and the shared model builder', () => {
    const filters = parseManagementReadScopeQuery({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
      buildingIds: `${randomUUID()},${randomUUID()}`,
    });
    const range = managementReadPeriodRange(filters);
    assert.equal(range.start?.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(range.end?.toISOString(), '2026-08-18T00:00:00.000Z');

    const context: PublicManagementReadScopeContext = {
      scope: {
        mode: 'ALL_ACCESSIBLE',
        clientId: null,
        clientIds: [],
        buildingIds: [],
        clients: [],
      },
      period: {
        dateFrom: null,
        dateTo: null,
        timeBasis: 'UTC',
        dateToMode: 'NONE',
      },
      filters: { clientId: null, buildingId: null, buildingIds: [] },
      asOf: '2026-08-17T00:00:00.000Z',
    };
    assert.deepEqual(
      createManagementReadModelContract(context, { status: 'OPEN' }, { total: 0 }),
      {
        scope: context.scope,
        period: context.period,
        filters: {
          clientId: null,
          buildingId: null,
          buildingIds: [],
          status: 'OPEN',
        },
        asOf: context.asOf,
        data: { total: 0 },
      },
    );
  });

  it('requires authentication and the dedicated read permission', async (t) => {
    if (!ready(t)) return;

    const unauthenticated = await api().get(PATH);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await api().get(PATH).set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns all and Client-narrowed accessible Building contexts', async (t) => {
    if (!ready(t)) return;
    const f = fixtures!;

    const all = await api().get(PATH).set(auth());
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.success, true);
    assert.deepEqual(all.body.meta, {});
    assert.equal(all.body.data.scope.mode, 'ALL_ACCESSIBLE');
    assert.deepEqual(
      ids(all.body.data.scope.buildingIds),
      ids([f.buildingA1.id, f.buildingA2.id, f.buildingB1.id]),
    );
    assert.deepEqual(ids(all.body.data.scope.clientIds), ids([f.clientA.id, f.clientB.id]));

    const client = await api()
      .get(PATH)
      .query({ clientId: f.clientA.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.scope.clientId, f.clientA.id);
    assert.deepEqual(
      ids(client.body.data.scope.buildingIds),
      ids([f.buildingA1.id, f.buildingA2.id]),
    );
    assert.deepEqual(client.body.data.scope.clientIds, [f.clientA.id]);
  });

  it('supports single and explicit multi-Building scope', async (t) => {
    if (!ready(t)) return;
    const f = fixtures!;

    const single = await api()
      .get(PATH)
      .query({
        buildingId: f.buildingA1.id,
        dateFrom: '2026-08-01',
        dateTo: '2026-08-17',
      })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.deepEqual(single.body.data.scope.buildingIds, [f.buildingA1.id]);
    assert.deepEqual(single.body.data.period, {
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
      timeBasis: 'UTC',
      dateToMode: 'INCLUSIVE_DAY',
    });

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [f.buildingA2.id, f.buildingB1.id, f.buildingA2.id],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.deepEqual(
      ids(multi.body.data.scope.buildingIds),
      ids([f.buildingA2.id, f.buildingB1.id]),
    );
    assert.deepEqual(
      multi.body.data.filters.buildingIds,
      [f.buildingA2.id, f.buildingB1.id],
    );
  });

  it('default-denies inaccessible and Client-mismatched scope', async (t) => {
    if (!ready(t)) return;
    const f = fixtures!;

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.inaccessibleBuilding.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    const mismatch = await api()
      .get(PATH)
      .query({ clientId: f.clientA.id, buildingIds: f.buildingB1.id })
      .set(auth());
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns a well-formed empty context for a permitted user with no Buildings', async (t) => {
    if (!ready(t)) return;

    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.scope.mode, 'ALL_ACCESSIBLE');
    assert.deepEqual(response.body.data.scope.clientIds, []);
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.scope.clients, []);
  });

  it('rejects conflicting, malformed, and incompatible filters', async (t) => {
    if (!ready(t)) return;
    const f = fixtures!;

    const cases = [
      { buildingId: f.buildingA1.id, buildingIds: f.buildingA2.id },
      { clientId: 'not-a-uuid' },
      { buildingIds: `${f.buildingA1.id},not-a-uuid` },
      { dateFrom: '2026-08-18', dateTo: '2026-08-17' },
      { dateFrom: '2026-02-30' },
    ];

    for (const query of cases) {
      const response = await api().get(PATH).query(query).set(auth());
      assert.equal(response.status, 400, JSON.stringify({ query, body: response.body }));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });
});
