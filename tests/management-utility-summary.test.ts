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
import { parseManagementUtilitySummaryQuery } from '../src/modules/management-utility-summary';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 06A focused tests — Utility Summary only. */

const PATH = '/api/v1/management/utility-summary';
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
let fixture: Awaited<ReturnType<typeof seed>> | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles, permissions CASCADE');

  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  plainToken = await createPlainSession();
  noAssignmentToken = await createSessionWithPermissions([
    MANAGEMENT_PERMISSION,
  ]);
  fixture = await seed();
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
  if (!database || !pool || !fixture) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function seed() {
  const scopeA = await createBuildingScope('A');
  const scopeB = await createBuildingScope('B');
  const hidden = await createBuildingScope('HIDDEN');
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: scopeA.building.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: scopeB.building.id,
  });

  const tenantA = await insertTenant(scopeA.client.id, 'A');
  const tenantB = await insertTenant(scopeB.client.id, 'B');
  const tenantHidden = await insertTenant(hidden.client.id, 'H');
  const uomA = await insertUom(scopeA.client.id, 'A');
  const uomB = await insertUom(scopeB.client.id, 'B');
  const uomHidden = await insertUom(hidden.client.id, 'H');

  const electricityA = await insertMeter(scopeA, uomA, 'ELECTRICITY');
  const waterA = await insertMeter(scopeA, uomA, 'WATER');
  const electricityB = await insertMeter(scopeB, uomB, 'ELECTRICITY');
  const waterB = await insertMeter(scopeB, uomB, 'WATER');
  const gasB = await insertMeter(scopeB, uomB, 'GAS');
  const electricityHidden = await insertMeter(hidden, uomHidden, 'ELECTRICITY');

  const aElectricityJan = await insertConsumption(
    scopeA,
    electricityA,
    uomA,
    tenantA,
    100,
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
  );
  const aElectricityFeb = await insertConsumption(
    scopeA,
    electricityA,
    uomA,
    tenantA,
    150,
    '2026-02-01T00:00:00.000Z',
    '2026-03-01T00:00:00.000Z',
  );
  await insertConsumption(
    scopeA,
    waterA,
    uomA,
    tenantA,
    50,
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
  );
  await insertConsumption(
    scopeB,
    electricityB,
    uomB,
    tenantB,
    200,
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
  );
  const bWater = await insertConsumption(
    scopeB,
    waterB,
    uomB,
    tenantB,
    70,
    '2026-02-01T00:00:00.000Z',
    '2026-03-01T00:00:00.000Z',
  );
  await insertConsumption(
    scopeB,
    gasB,
    uomB,
    tenantB,
    30,
    '2026-02-01T00:00:00.000Z',
    '2026-03-01T00:00:00.000Z',
  );
  await insertConsumption(
    hidden,
    electricityHidden,
    uomHidden,
    tenantHidden,
    500,
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
  );

  await insertAbnormality(
    scopeA,
    electricityA,
    uomA,
    tenantA,
    aElectricityFeb,
    'ELECTRICITY',
    'OPEN',
    true,
  );
  await insertAbnormality(
    scopeB,
    waterB,
    uomB,
    tenantB,
    bWater,
    'WATER',
    'RESOLVED',
    false,
  );

  return {
    scopeA,
    scopeB,
    hidden,
    tenantA,
    tenantB,
    aElectricityJan,
  };
}

async function createBuildingScope(label: string) {
  const client = await clientService.createClient({
    code: `UT_${label}_${suffix()}`,
    name: `Utility Client ${label}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${label}_${suffix()}`,
    name: `Property ${label}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${label}_${suffix()}`,
    name: `Building ${label}`,
  });
  return { client, property, building };
}

type Scope = Awaited<ReturnType<typeof createBuildingScope>>;

async function insertTenant(clientId: string, label: string): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO tenant_companies (id,client_id,tenant_code,tenant_name)
     VALUES ($1,$2,$3,$4)`,
    [id, clientId, `TEN_${label}_${suffix()}`, `Tenant ${label}`],
  );
  return id;
}

async function insertUom(clientId: string, label: string): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO units_of_measure
       (id,client_id,code,name,symbol,category,status)
     VALUES ($1,$2,$3,'Utility Unit',$4,'UTILITY','ACTIVE')`,
    [id, clientId, `UOM_${label}_${suffix()}`, label],
  );
  return id;
}

async function insertMeter(
  scope: Scope,
  uomId: string,
  utilityType: 'ELECTRICITY' | 'WATER' | 'GAS',
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO utility_meters
       (id,client_id,building_id,code,name,utility_type,uom_id,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE')`,
    [
      id,
      scope.client.id,
      scope.building.id,
      `MTR_${suffix()}`,
      `${utilityType} Meter`,
      utilityType,
      uomId,
    ],
  );
  return id;
}

async function ensureReading(
  scope: Scope,
  meterId: string,
  uomId: string,
  tenantCompanyId: string,
  readingAt: string,
  readingValue: number,
): Promise<string> {
  const existing = await pool!.query<{ id: string }>(
    `SELECT id FROM utility_meter_readings
      WHERE meter_id = $1 AND reading_at = $2`,
    [meterId, readingAt],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const id = randomUUID();
  await pool!.query(
    `INSERT INTO utility_meter_readings
       (id,client_id,building_id,meter_id,uom_id,reading_value,reading_at,
        recorded_by_user_id,tenant_company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      scope.client.id,
      scope.building.id,
      meterId,
      uomId,
      readingValue,
      readingAt,
      managerUserId,
      tenantCompanyId,
    ],
  );
  return id;
}

async function insertConsumption(
  scope: Scope,
  meterId: string,
  uomId: string,
  tenantCompanyId: string,
  value: number,
  periodStart: string,
  periodEnd: string,
): Promise<string> {
  const previousReadingId = await ensureReading(
    scope,
    meterId,
    uomId,
    tenantCompanyId,
    periodStart,
    0,
  );
  const currentReadingId = await ensureReading(
    scope,
    meterId,
    uomId,
    tenantCompanyId,
    periodEnd,
    value,
  );
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO utility_meter_consumptions
       (id,client_id,building_id,meter_id,previous_reading_id,current_reading_id,
        uom_id,consumption_value,period_start,period_end,
        calculated_by_user_id,tenant_company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      scope.client.id,
      scope.building.id,
      meterId,
      previousReadingId,
      currentReadingId,
      uomId,
      value,
      periodStart,
      periodEnd,
      managerUserId,
      tenantCompanyId,
    ],
  );
  return id;
}

async function insertAbnormality(
  scope: Scope,
  meterId: string,
  uomId: string,
  tenantCompanyId: string,
  consumptionId: string,
  utilityType: 'ELECTRICITY' | 'WATER' | 'GAS',
  status: 'OPEN' | 'RESOLVED',
  approved: boolean,
): Promise<void> {
  const id = randomUUID();
  const periodStart = '2026-02-01T00:00:00.000Z';
  const periodEnd = '2026-03-01T00:00:00.000Z';
  await pool!.query(
    `INSERT INTO utility_abnormal_consumptions
       (id,client_id,building_id,meter_id,utility_type,consumption_id,
        abnormality_type,comparison_mode,detected_value,uom_id,
        period_start,period_end,status,resolved_at,tenant_company_id)
     VALUES ($1,$2,$3,$4,$5,$6,'HIGH_USAGE','ABSOLUTE',100,$7,
             $8,$9,$10,$11,$12)`,
    [
      id,
      scope.client.id,
      scope.building.id,
      meterId,
      utilityType,
      consumptionId,
      uomId,
      periodStart,
      periodEnd,
      status,
      status === 'RESOLVED' ? periodEnd : null,
      tenantCompanyId,
    ],
  );
  if (approved) {
    await pool!.query(
      `INSERT INTO reviews
         (id,client_id,target_type,target_id,reviewer_user_id,decision,status,
          reviewed_at,created_at)
       VALUES ($1,$2,'UTILITY_ABNORMAL_CONSUMPTION',$3,$4,'APPROVED',
               'COMPLETED',$5,$5)`,
      [randomUUID(), scope.client.id, id, managerUserId, periodEnd],
    );
  }
}

describe('BE-24 PART 06A — Management Utility Summary', () => {
  it('documents the endpoint and delegates PART 01 / BE-23I filters', () => {
    const parsed = parseManagementUtilitySummaryQuery({
      dateFrom: '2026-01-01',
      dateTo: '2026-03-01',
      interval: 'MONTH',
      includeSubMeters: 'true',
    });
    assert.equal(parsed.scope.dateFrom, '2026-01-01');
    assert.equal(parsed.scope.dateTo, '2026-03-01');
    assert.equal(parsed.interval, 'MONTH');
    assert.equal(parsed.includeSubMeters, true);

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/utility-summary']);
    assert.ok(spec.components?.schemas?.ManagementUtilitySummary);
  });

  it('enforces authentication and management-read RBAC', async (t) => {
    if (!ready(t)) return;
    const unauthenticated = await api().get(PATH);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await api().get(PATH).set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns authoritative Utility KPI values and Tenant grouped consumption', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.electricity.totalConsumption, 450);
    assert.equal(data.electricity.consumptionCount, 3);
    assert.equal(data.electricity.meterCount, 2);
    assert.equal(data.water.totalConsumption, 120);
    assert.equal(data.water.consumptionCount, 2);
    assert.equal(data.gas.totalConsumption, 30);
    assert.equal(data.gas.consumptionCount, 1);
    assert.deepEqual(data.abnormalConsumption, {
      total: 2,
      open: 1,
      resolved: 1,
      dismissed: 0,
      byType: { HIGH_USAGE: 2 },
    });
    assert.deepEqual(data.verifiedReadingSummary, {
      verified: 1,
      pending: 0,
      rejected: 0,
      reworkRequired: 0,
      unverified: 1,
    });
    assert.equal(data.tenantUtility.length, 5);
    assert.equal(
      data.tenantUtility.reduce(
        (sum: number, row: any) => sum + row.totalConsumption,
        0,
      ),
      600,
    );
    assert.deepEqual(data.periodComparison, {
      interval: 'MONTH',
      previous: {
        intervalStart: '2026-02-01T00:00:00.000Z',
        totalConsumption: 350,
        consumptionCount: 3,
        meterCount: 3,
      },
      current: {
        intervalStart: '2026-03-01T00:00:00.000Z',
        totalConsumption: 250,
        consumptionCount: 3,
        meterCount: 3,
      },
    });
  });

  it('supports Client, single, and explicit multi-Building scope without leakage', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.electricity.totalConsumption, 250);
    assert.equal(single.body.data.data.water.totalConsumption, 50);
    assert.equal(single.body.data.data.gas.totalConsumption, 0);
    assert.equal(single.body.data.data.tenantUtility.length, 2);
    assert.equal(single.body.data.data.abnormalConsumption.total, 1);

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeB.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.electricity.totalConsumption, 200);
    assert.equal(client.body.data.data.water.totalConsumption, 70);
    assert.equal(client.body.data.data.gas.totalConsumption, 30);
    assert.equal(client.body.data.data.tenantUtility.length, 3);

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [f.scopeA.building.id, f.scopeB.building.id],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.electricity.totalConsumption, 450);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies BE-23I period and comparison semantics without recalculation', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({
        dateFrom: '2026-01-01',
        dateTo: '2026-02-01',
        interval: 'MONTH',
      })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.electricity.totalConsumption, 300);
    assert.equal(data.water.totalConsumption, 50);
    assert.equal(data.gas.totalConsumption, 0);
    assert.equal(data.tenantUtility.length, 3);
    assert.equal(data.periodComparison.previous, null);
    assert.equal(data.periodComparison.current.totalConsumption, 350);
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.equal(response.body.data.data.electricity.totalConsumption, 0);
    assert.equal(response.body.data.data.water.totalConsumption, 0);
    assert.equal(response.body.data.data.gas.totalConsumption, 0);
    assert.equal(response.body.data.data.abnormalConsumption.total, 0);
    assert.deepEqual(response.body.data.data.tenantUtility, []);
    assert.deepEqual(response.body.data.data.periodComparison, {
      interval: 'MONTH',
      previous: null,
      current: null,
    });
  });

  it('rejects invalid scope, period and Utility filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { interval: 'WEEK' },
      { includeSubMeters: 'maybe' },
      { dateFrom: '2026-03-01', dateTo: '2026-01-01' },
      { dateFrom: '2026-02-30' },
      {
        buildingId: f.scopeA.building.id,
        buildingIds: f.scopeB.building.id,
      },
    ];
    for (const query of cases) {
      const response = await api().get(PATH).query(query).set(auth());
      assert.equal(response.status, 400, JSON.stringify({ query, body: response.body }));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });
});
