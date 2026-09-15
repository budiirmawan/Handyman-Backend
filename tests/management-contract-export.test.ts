import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  parseReportingExportQuery,
  REPORTING_EXPORT_DATASETS,
} from '../src/modules/reporting-export';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 10 focused contract/export completion and final-review tests. */

const EXPORT_PATH = '/api/v1/reports/export';
const COMMAND_PATH = '/api/v1/management/operations-command-center';
const MANAGEMENT_DATASET = 'MANAGEMENT_OPERATIONS_COMMAND_CENTER';
const MANAGEMENT_PERMISSION = {
  code: 'management_read_model.read',
  name: 'Read Management and Owner Read Models',
} as const;
const EXPORT_PERMISSION = {
  code: 'reporting_export.read',
  name: 'Read Reporting Export Datasets',
} as const;

const MANAGEMENT_PATHS = [
  '/management/read-scope',
  '/management/daily-operations',
  '/management/work-order-summary',
  '/management/pending-approvals',
  '/management/critical-findings',
  '/management/workforce-summary',
  '/management/vendor-summary',
  '/management/tenant-service-summary',
  '/management/asset-registry-compliance',
  '/management/asset-reliability-work',
  '/management/utility-summary',
  '/management/financial-summary',
  '/management/operational-kpi',
  '/management/building-performance',
  '/management/portfolio-overview',
  '/management/operations-command-center',
] as const;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
let reportingOnlyToken = '';
let emptyScopeToken = '';
let fixture: Awaited<ReturnType<typeof seed>> | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles, permissions CASCADE');

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  reportingOnlyToken = await createSessionWithPermissions([EXPORT_PERMISSION]);
  emptyScopeToken = await createSessionWithPermissions([
    EXPORT_PERMISSION,
    MANAGEMENT_PERMISSION,
  ]);
  fixture = await seed();
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool || !fixture) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const query = () => ({
  dataset: MANAGEMENT_DATASET,
  date: '2026-08-17',
  dateFrom: '2026-08-01',
  dateTo: '2026-08-17',
  graceMinutes: 0,
  overdueAfterDays: 30,
  expiringWithinDays: 30,
  interval: 'MONTH',
});

async function seed() {
  const scopeA = await createScope('A');
  const scopeB = await createScope('B');
  const hidden = await createScope('HIDDEN');
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: scopeA.building.id,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: scopeB.building.id,
  });
  await insertWorkOrder(scopeA, 'OPEN');
  await insertWorkOrder(scopeB, 'CLOSED');
  await pool!.query(
    `INSERT INTO assets (id,client_id,building_id,asset_code,asset_name,status)
     VALUES ($1,$2,$3,$4,'Export Asset','ACTIVE')`,
    [
      randomUUID(),
      scopeA.client.id,
      scopeA.building.id,
      `AST_${suffix()}`,
    ],
  );
  return { scopeA, scopeB, hidden };
}

async function createScope(label: string) {
  const client = await clientService.createClient({
    code: `EXP_${label}_${suffix()}`,
    name: `Export Client ${label}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${label}_${suffix()}`,
    name: `Property ${label}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${label}_${suffix()}`,
    name: `Building ${label}`,
  });
  return { client, property, building };
}

type Scope = Awaited<ReturnType<typeof createScope>>;

async function insertWorkOrder(
  scope: Scope,
  status: 'OPEN' | 'CLOSED',
): Promise<void> {
  const at = '2026-08-10T08:00:00.000Z';
  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,status,
        created_by_user_id,completed_at,closed_at,created_at)
     VALUES ($1,$2,$3,$4,'Export Work','GENERAL',$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      scope.client.id,
      scope.building.id,
      `WO_${suffix()}`,
      status,
      adminUserId,
      status === 'CLOSED' ? at : null,
      status === 'CLOSED' ? at : null,
      at,
    ],
  );
}

async function getExport(
  params: Record<string, unknown>,
  token = adminToken,
) {
  return api().get(EXPORT_PATH).query(params).set(auth(token));
}

describe('BE-24 PART 10 — contract/export completion', () => {
  it('locks every BE-24 endpoint and schema in OpenAPI', () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as {
      paths: Record<string, any>;
      components: { schemas: Record<string, any> };
    };

    assert.equal(spec.paths['/reports/export'].get.operationId, 'getReportingExport');
    assert.ok(spec.components.schemas.ReportingExport);
    assert.ok(spec.components.schemas.ManagementOperationsCommandCenter);

    for (const path of MANAGEMENT_PATHS) {
      const operation = spec.paths[path]?.get;
      assert.ok(operation, `${path} must be documented`);
      assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
      for (const status of ['200', '400', '401', '403']) {
        assert.ok(operation.responses[status], `${path} must document ${status}`);
      }
    }

    const schemas = spec.components.schemas;
    const missingRefs: string[] = [];
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (typeof object.$ref === 'string') {
        const prefix = '#/components/schemas/';
        if (object.$ref.startsWith(prefix)) {
          const name = object.$ref.slice(prefix.length);
          if (!schemas[name]) missingRefs.push(object.$ref);
        }
      }
      for (const child of Object.values(object)) inspect(child);
    };
    inspect(spec);
    assert.deepEqual(missingRefs, []);

    const portfolioParameters = spec.paths['/management/portfolio-overview'].get
      .parameters as Array<{ name: string }>;
    assert.ok(portfolioParameters.some(({ name }) => name === 'buildingId'));
    assert.ok(portfolioParameters.some(({ name }) => name === 'buildingIds'));
  });

  it('registers the Management Command Center export dataset', () => {
    assert.ok(REPORTING_EXPORT_DATASETS.includes(MANAGEMENT_DATASET));
    const parsed = parseReportingExportQuery({
      ...query(),
      buildingIds: ['00000000-0000-4000-8000-000000000001'],
    });
    assert.equal(parsed.dataset, MANAGEMENT_DATASET);
    assert.deepEqual(parsed.passThrough.buildingIds, [
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('exports exact Command Center values and structured Building rows', async (t) => {
    if (!ready(t)) return;
    const [exported, command] = await Promise.all([
      getExport(query()),
      api()
        .get(COMMAND_PATH)
        .query({ ...query(), dataset: undefined })
        .set(auth()),
    ]);
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(command.status, 200, JSON.stringify(command.body));

    const result = exported.body.data;
    const source = command.body.data;
    assert.equal(result.metadata.dataset, MANAGEMENT_DATASET);
    assert.equal(
      result.metadata.datasetLabel,
      'Management Operations Command Center',
    );
    assert.deepEqual(result.metadata.buildingScope, source.scope.buildingIds);
    assert.deepEqual(result.metadata.period, {
      dateFrom: source.period.dateFrom,
      dateTo: source.period.dateTo,
    });
    assert.equal(result.metadata.filters.operationalDate, '2026-08-17');
    assert.equal(result.metadata.filters.overdueAfterDays, 30);

    const value = (key: string) =>
      result.kpis.find((entry: { key: string }) => entry.key === key).value;
    assert.equal(value('workOrdersTotal'), source.data.workOrderSummary.total);
    assert.equal(value('assetsTotal'), 1);
    assert.equal(
      value('operationalCompletionRate'),
      source.data.operationalKpi.completionRate,
    );
    assert.equal(
      value('portfolioBuildingCount'),
      source.data.portfolioContext.buildingCount,
    );
    assert.equal(
      value('portfolioCompletionRate'),
      source.data.portfolioContext.operational.completionRate,
    );

    const buildings = result.tables.find(
      (table: { key: string }) => table.key === 'buildingPerformance',
    );
    assert.equal(buildings.rowCount, 2);
    assert.deepEqual(
      buildings.rows.map((row: { buildingId: string }) => row.buildingId).sort(),
      source.data.buildingPerformance
        .map((row: { buildingId: string }) => row.buildingId)
        .sort(),
    );
    for (const table of result.tables) {
      const columnKeys = table.columns.map((column: { key: string }) => column.key);
      assert.equal(table.rowCount, table.rows.length);
      for (const row of table.rows) {
        assert.deepEqual(Object.keys(row).sort(), [...columnKeys].sort());
      }
    }
  });

  it('preserves Client-partitioned finance and single/multi-Building scope', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const single = await getExport({
      ...query(),
      buildingId: f.scopeA.building.id,
    });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.metadata.buildingId, f.scopeA.building.id);
    assert.deepEqual(single.body.data.metadata.buildingScope, [
      f.scopeA.building.id,
    ]);
    const singleFinance = single.body.data.tables.find(
      (table: { key: string }) => table.key === 'clientFinancialSummary',
    );
    assert.equal(singleFinance.rowCount, 1);
    assert.equal(singleFinance.rows[0].clientId, f.scopeA.client.id);

    const multi = await getExport({
      ...query(),
      buildingIds: [f.scopeA.building.id, f.scopeB.building.id],
    });
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.metadata.buildingId, null);
    assert.equal(multi.body.data.metadata.buildingScope.length, 2);
    const multiFinance = multi.body.data.tables.find(
      (table: { key: string }) => table.key === 'clientFinancialSummary',
    );
    assert.equal(multiFinance.rowCount, 2);
  });

  it('requires export and Management permissions and preserves scope denial', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const missingManagement = await getExport(query(), reportingOnlyToken);
    assert.equal(missingManagement.status, 403);
    assert.equal(missingManagement.body.error.code, 'PERMISSION_DENIED');

    const inaccessible = await getExport({
      ...query(),
      buildingId: f.hidden.building.id,
    });
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    const empty = await getExport(query(), emptyScopeToken);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.data.metadata.buildingScope, []);
    const buildings = empty.body.data.tables.find(
      (table: { key: string }) => table.key === 'buildingPerformance',
    );
    assert.equal(buildings.rowCount, 0);
    assert.deepEqual(buildings.rows, []);
  });

  it('returns JSON only with no chart or file-rendering contract', async (t) => {
    if (!ready(t)) return;
    const response = await getExport(query());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.headers['content-disposition'], undefined);
    const serialized = JSON.stringify(response.body.data).toLowerCase();
    for (const forbidden of ['chart', 'series', 'axis', 'pdf', 'xlsx', 'base64']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  });
});
