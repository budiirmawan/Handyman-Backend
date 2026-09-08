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
import { parseManagementAssetRegistryComplianceQuery } from '../src/modules/management-asset-registry-compliance';
import { propertyService } from '../src/modules/properties';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 05A focused tests — Asset Registry & Compliance only. */

const PATH = '/api/v1/management/asset-registry-compliance';
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
  const scopeA = await createBuildingScope('A', true);
  const scopeB = await createBuildingScope('B', false);
  const hidden = await createBuildingScope('HIDDEN', false);
  for (const building of [scopeA.building, scopeA.secondBuilding!, scopeB.building]) {
    await buildingAssignmentService.createAssignment(managerUserId, {
      buildingId: building.id,
    });
  }

  const locationA1 = await insertFunctionalLocation(scopeA.building.id, 'A1');
  const locationA2 = await insertFunctionalLocation(scopeA.building.id, 'A2');
  const locationB = await insertFunctionalLocation(scopeB.building.id, 'B');

  const a1 = await insertAsset(scopeA, scopeA.building.id, 'ACTIVE', locationA1);
  const a2 = await insertAsset(scopeA, scopeA.building.id, 'INACTIVE', null);
  const a3 = await insertAsset(
    scopeA,
    scopeA.building.id,
    'UNDER_MAINTENANCE',
    locationA1,
  );
  const a4 = await insertAsset(scopeA, scopeA.building.id, 'RETIRED', locationA2);
  const a5 = await insertAsset(scopeA, scopeA.secondBuilding!.id, 'ACTIVE', null);
  const a6 = await insertAsset(scopeB, scopeB.building.id, 'ACTIVE', locationB);
  const a7 = await insertAsset(scopeB, scopeB.building.id, 'INACTIVE', locationB);
  const hiddenAsset = await insertAsset(hidden, hidden.building.id, 'ACTIVE', null);

  await insertWarranty(a1, 'ACTIVE', dateOffset(-10), dateOffset(100));
  await insertWarranty(a2, 'EXPIRED', dateOffset(-100), dateOffset(-10));
  await insertWarranty(a3, 'INACTIVE', dateOffset(-100), dateOffset(100));
  await insertWarranty(a5, 'ACTIVE', dateOffset(10), dateOffset(100));
  await insertWarranty(a6, 'ACTIVE', dateOffset(-10), dateOffset(100));
  await insertWarranty(hiddenAsset, 'ACTIVE', dateOffset(-10), dateOffset(100));

  await insertCertification(a1, 'LICENCE', 'ACTIVE', dateOffset(-100), dateOffset(10));
  await insertCertification(a1, 'PERPETUAL', 'ACTIVE', dateOffset(-100), null);
  await insertCertification(a2, 'LICENCE', 'EXPIRED', dateOffset(-100), dateOffset(-10));
  await insertCertification(a3, 'LICENCE', 'INACTIVE', dateOffset(-100), dateOffset(-10));
  await insertCertification(a5, 'LICENCE', 'ACTIVE', dateOffset(5), dateOffset(100));
  await insertCertification(a6, 'LICENCE', 'ACTIVE', dateOffset(-100), dateOffset(60));
  await insertCertification(a7, 'LICENCE', 'EXPIRED', dateOffset(-100), dateOffset(-10));
  await insertCertification(
    hiddenAsset,
    'LICENCE',
    'ACTIVE',
    dateOffset(-100),
    dateOffset(5),
  );

  return {
    scopeA,
    scopeB,
    hidden,
    locationA1,
    locationA2,
    locationB,
  };
}

async function createBuildingScope(label: string, withSecond: boolean) {
  const client = await clientService.createClient({
    code: `AH_${label}_${suffix()}`,
    name: `Asset Health Client ${label}`,
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
  const secondBuilding = withSecond
    ? await buildingService.createBuilding({
        propertyId: property.id,
        code: `B2_${label}_${suffix()}`,
        name: `Building ${label} 2`,
      })
    : null;
  return { client, property, building, secondBuilding };
}

type Scope = Awaited<ReturnType<typeof createBuildingScope>>;

async function insertFunctionalLocation(
  buildingId: string,
  label: string,
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO functional_locations (id,building_id,code,name,status)
     VALUES ($1,$2,$3,$4,'ACTIVE')`,
    [id, buildingId, `FL_${label}_${suffix()}`, `Location ${label}`],
  );
  return id;
}

async function insertAsset(
  scope: Scope,
  buildingId: string,
  status: 'ACTIVE' | 'INACTIVE' | 'UNDER_MAINTENANCE' | 'RETIRED',
  functionalLocationId: string | null,
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO assets
       (id,client_id,building_id,functional_location_id,asset_code,asset_name,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      scope.client.id,
      buildingId,
      functionalLocationId,
      `AST_${suffix()}`,
      `${status} Asset`,
      status,
    ],
  );
  return id;
}

async function insertWarranty(
  assetId: string,
  status: 'ACTIVE' | 'EXPIRED' | 'INACTIVE',
  startDate: string,
  endDate: string,
): Promise<void> {
  await pool!.query(
    `INSERT INTO asset_warranties
       (id,asset_id,provider_name,warranty_number,start_date,end_date,status)
     VALUES ($1,$2,'Provider',$3,$4,$5,$6)`,
    [randomUUID(), assetId, `WAR_${suffix()}`, startDate, endDate, status],
  );
}

async function insertCertification(
  assetId: string,
  type: string,
  status: 'ACTIVE' | 'EXPIRED' | 'INACTIVE',
  issueDate: string,
  expiryDate: string | null,
): Promise<void> {
  await pool!.query(
    `INSERT INTO asset_certifications
       (id,asset_id,certification_type,certificate_number,issuing_authority,
        issue_date,expiry_date,status)
     VALUES ($1,$2,$3,$4,'Authority',$5,$6,$7)`,
    [
      randomUUID(),
      assetId,
      type,
      `CERT_${suffix()}`,
      issueDate,
      expiryDate,
      status,
    ],
  );
}

function dateOffset(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

describe('BE-24 PART 05A — Management Asset Registry & Compliance', () => {
  it('documents the endpoint and validates the compliance window', () => {
    const parsed = parseManagementAssetRegistryComplianceQuery({
      expiringWithinDays: '45',
    });
    assert.equal(parsed.expiringWithinDays, 45);
    assert.equal(parseManagementAssetRegistryComplianceQuery({}).expiringWithinDays, 30);

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/asset-registry-compliance']);
    assert.ok(spec.components?.schemas?.ManagementAssetRegistryCompliance);
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

  it('returns authoritative registry, warranty, certification and compliance status', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.totalAssets, 7);
    assert.equal(data.activeAssets, 3);
    assert.equal(data.inactiveAssets, 2);
    assert.deepEqual(data.assetStatus, {
      ACTIVE: 3,
      INACTIVE: 2,
      UNDER_MAINTENANCE: 1,
      RETIRED: 1,
    });
    assert.deepEqual(data.warranties, {
      totalRecords: 5,
      active: 3,
      expired: 1,
      inactive: 1,
      currentlyCoveredAssets: 2,
      assetsWithoutCurrentCoverage: 5,
    });
    assert.deepEqual(data.certifications, {
      totalRecords: 7,
      active: 4,
      expired: 2,
      inactive: 1,
      currentlyEffectiveRecords: 3,
      assetsWithEffectiveCertification: 2,
      assetsWithoutEffectiveCertification: 5,
      expiredComplianceCount: 2,
      expiringComplianceCount: 1,
    });
    assert.equal(data.locations.length, 5);
    assert.equal(
      data.locations.reduce((sum: number, row: any) => sum + row.assetCount, 0),
      7,
    );
  });

  it('returns functional and Building-level location context', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth());
    const locations = response.body.data.data.locations;
    const locationA1 = locations.find(
      (row: any) => row.functionalLocationId === fixture!.locationA1,
    );
    assert.equal(locationA1.locationType, 'FUNCTIONAL_LOCATION');
    assert.equal(locationA1.assetCount, 2);
    assert.equal(locationA1.functionalLocationName, 'Location A1');
    assert.ok(
      locations.some(
        (row: any) =>
          row.locationType === 'BUILDING' && row.functionalLocationId === null,
      ),
    );
  });

  it('supports Client, single, and explicit multi-Building scope', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({ buildingId: f.scopeA.building.id })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.totalAssets, 4);
    assert.deepEqual(single.body.data.data.assetStatus, {
      ACTIVE: 1,
      INACTIVE: 1,
      UNDER_MAINTENANCE: 1,
      RETIRED: 1,
    });
    assert.equal(single.body.data.data.warranties.currentlyCoveredAssets, 1);
    assert.equal(
      single.body.data.data.certifications.currentlyEffectiveRecords,
      2,
    );

    const client = await api()
      .get(PATH)
      .query({ clientId: f.scopeA.client.id })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.totalAssets, 5);
    assert.equal(client.body.data.data.activeAssets, 2);
    assert.equal(client.body.data.data.warranties.currentlyCoveredAssets, 1);

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [
          f.scopeA.building.id,
          f.scopeA.secondBuilding!.id,
          f.scopeB.building.id,
        ],
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.totalAssets, 7);

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies an explicit expiring-compliance window', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({ expiringWithinDays: 90 })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.data.data.certifications.expiringComplianceCount,
      2,
    );
  });

  it('returns a zeroed contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.equal(response.body.data.data.totalAssets, 0);
    assert.deepEqual(response.body.data.data.locations, []);
    assert.equal(response.body.data.data.warranties.totalRecords, 0);
    assert.equal(response.body.data.data.certifications.totalRecords, 0);
  });

  it('rejects invalid scope and compliance-window filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { expiringWithinDays: 366 },
      { expiringWithinDays: -1 },
      { expiringWithinDays: '1.5' },
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
