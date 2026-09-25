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
import { assetService } from '../src/modules/assets';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { equipmentProfileService } from '../src/modules/equipment-profiles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — field-reported unsafe condition.
 *
 * Proves the mobile command records an UNSAFE CONDITION as a canonical BE-21C
 * Asset Failure with `operationalImpact = SAFETY_RISK` and `failureStatus =
 * OPEN`, derives every authority field server-side, rejects attempts to assert
 * authority from the body, enforces Building isolation and the dedicated
 * `asset_failure.report` permission, and has NO effect on Asset lifecycle,
 * Equipment status, Work Orders or Findings.
 *
 * CR-BE-IDEMPOTENCY-CORE-01 PART 02/03 note: the command now REQUIRES the
 * generic `Idempotency-Key` header, so every request that must reach the
 * service sends a unique key. The idempotency contract itself (replay,
 * conflict, isolation, rollback) is proven by
 * `tests/mobile-unsafe-condition-idempotency.test.ts`.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const testSpec = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

const REPORT_PERMISSION = {
  code: 'asset_failure.report',
  name: 'Report Unsafe Asset Conditions',
};

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE asset_failure_incidents, operational_incidents,
    finding_escalation_incidents, incidents, asset_history_events, assets,
    equipment_profiles, work_orders, findings, operational_events, buildings,
    properties, users, roles, permissions, clients CASCADE`);
  database = db;
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

async function ensurePermissionId(code: string, name: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) return existing.id;
  return (await permissionService.createPermission({ code, name })).id;
}

/**
 * Creates an authenticated session whose role carries EXACTLY the given
 * permission codes, and returns both the token and the user id (so the caller
 * can be granted Building access). Local to this suite on purpose: no shared
 * test helper is modified by this PART.
 */
async function sessionWith(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix().toLowerCase();
  const password = 'FieldPass123';
  const user = await userService.createUser({
    email: `field-${tag}@example.com`,
    displayName: 'Field Reporter',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `FIELD_${tag.toUpperCase()}`,
    name: 'Field Reporter',
  });
  for (const permission of codes) {
    const permissionId = await ensurePermissionId(permission.code, permission.name);
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function structure(options: { assignUserId?: string } = {}) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Unsafe Condition Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  if (options.assignUserId) {
    await buildingAssignmentService.createAssignment(options.assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

async function asset(buildingId: string, overrides: Record<string, unknown> = {}) {
  return assetService.createAsset({
    buildingId,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller Unit',
    ...overrides,
  });
}

const report = (
  assetId: string,
  payload: unknown,
  value: string,
  idempotencyKey?: string,
) => {
  const request = api()
    .post(`/api/v1/mobile/assets/${assetId}/unsafe-condition`)
    .set({ Authorization: `Bearer ${value}` });
  if (idempotencyKey !== undefined) {
    request.set('Idempotency-Key', idempotencyKey);
  }
  return request.send(payload as Record<string, unknown>);
};

/** Every key must be unique per logical report: reusing a key is a replay. */
const key = () => randomUUID();

describe('CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — mobile unsafe condition report', () => {
  it('records a field report as a canonical BE-21C Asset Failure', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { client, building } = await structure({
      assignUserId: reporter.userId,
    });
    const equipment = await asset(building.id);

    const response = await report(
      equipment.id,
      { title: 'Exposed live wiring beside the control panel door.' },
      reporter.token,
      key(),
    );

    assert.equal(response.status, 201);
    const data = response.body.data;

    // 2/3/4 — it IS an Asset Failure, SAFETY_RISK, OPEN.
    assert.equal(data.operationalImpact, 'SAFETY_RISK');
    assert.equal(data.failureStatus, 'OPEN');
    assert.equal(data.incidentStatus, 'REPORTED');
    // 5 — the Asset comes from the path.
    assert.equal(data.assetId, equipment.id);
    // 6 — Client and Building are the Asset's canonical context.
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    // 7 — the reporting actor is the session's user.
    assert.equal(data.reportedByUserId, reporter.userId);
    // Server-generated identity.
    assert.match(data.incidentNumber, /^UNC_[0-9A-F]{8}$/);

    // The record really is BE-21C's, reachable through BE-21C's own read.
    const stored = await pool!.query<{
      operational_impact: string;
      failure_status: string;
      asset_id: string;
      failure_category: string;
    }>(
      `SELECT afi.operational_impact, afi.failure_status, afi.asset_id,
              afi.failure_category
         FROM asset_failure_incidents afi
        WHERE afi.incident_id = $1`,
      [data.incidentId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0]?.operational_impact, 'SAFETY_RISK');
    assert.equal(stored.rows[0]?.failure_status, 'OPEN');
    assert.equal(stored.rows[0]?.asset_id, equipment.id);
    assert.equal(stored.rows[0]?.failure_category, 'OTHER');

    const incident = await pool!.query<{ incident_type: string }>(
      'SELECT incident_type FROM incidents WHERE id = $1',
      [data.incidentId],
    );
    assert.equal(incident.rows[0]?.incident_type, 'ASSET_FAILURE');

    // The canonical read pointer resolves to the record.
    assert.deepEqual(data.canonicalRead, {
      operationId: 'getAssetFailure',
      path: `/asset-failures/${data.incidentId}`,
    });
  });

  it('accepts the optional narrative / observation fields', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const response = await report(
      equipment.id,
      {
        title: 'Water ingress into the electrical cabinet.',
        description: 'Standing water visible at the base of the panel.',
        failureCategory: 'LEAKAGE',
        occurredAt: '2026-08-01T09:30:00.000Z',
      },
      reporter.token,
      key(),
    );

    assert.equal(response.status, 201);
    assert.equal(response.body.data.failureCategory, 'LEAKAGE');
    assert.equal(response.body.data.occurredAt, '2026-08-01T09:30:00.000Z');
  });

  it('rejects a report with no narrative', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const missing = await report(equipment.id, {}, reporter.token);
    assert.equal(missing.status, 400);

    const blank = await report(equipment.id, { title: '   ' }, reporter.token);
    assert.equal(blank.status, 400);

    const tooLong = await report(
      equipment.id,
      { title: 'x'.repeat(201) },
      reporter.token,
    );
    assert.equal(tooLong.status, 400);
  });

  it('rejects every body attempt to assert authority', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { client, building } = await structure({
      assignUserId: reporter.userId,
    });
    const equipment = await asset(building.id);
    const other = await asset(building.id);

    // 8 — management / authority fields are refused, with their own message.
    const derived: Record<string, unknown> = {
      assetId: other.id,
      clientId: client.id,
      buildingId: building.id,
      incidentNumber: 'AF_INJECTED',
      incidentType: 'OPERATIONAL',
      operationalImpact: 'FULL_OUTAGE',
      failureStatus: 'RESOLVED',
      status: 'CLOSED',
      incidentStatus: 'CLOSED',
      reportedByUserId: reporter.userId,
      createdByUserId: reporter.userId,
      severity: 'CRITICAL',
      priority: 'CRITICAL',
      locationType: 'ROOM',
      locationId: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    for (const [field, value] of Object.entries(derived)) {
      const response = await report(
        equipment.id,
        { title: 'Unsafe condition.', [field]: value },
        reporter.token,
      );
      assert.equal(
        response.status,
        400,
        `body field ${field} must be rejected`,
      );
      assert.equal(response.body.error.details[0].field, field);
    }

    // Unknown keys are refused too — the DTO is an allowlist.
    const unknown = await report(
      equipment.id,
      { title: 'Unsafe condition.', unsafe: true },
      reporter.token,
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.details[0].field, 'unsafe');

    // Nothing was recorded by any of the rejected attempts.
    const count = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM asset_failure_incidents afi
         JOIN incidents i ON i.id = afi.incident_id
        WHERE i.building_id = $1`,
      [building.id],
    );
    assert.equal(count.rows[0]?.count, '0');
  });

  it('honours the Asset lifecycle rules it inherits (RETIRED)', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    const admin = await pool!.query<{ id: string }>(
      'SELECT id FROM users WHERE id = $1',
      [reporter.userId],
    );
    assert.equal(admin.rowCount, 1);

    // Drive the Asset to RETIRED through the authoritative lifecycle path.
    await assetService.updateAssetStatus(equipment.id, { status: 'INACTIVE' });
    await assetService.updateAssetStatus(equipment.id, { status: 'RETIRED' });

    const response = await report(
      equipment.id,
      { title: 'Unsafe condition on a retired asset.' },
      reporter.token,
      key(),
    );
    // BE-21C owns this rule: a RETIRED Asset accepts no new failure records.
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_FAILURE_ASSET_RETIRED');
  });

  it('fails closed for an unknown Asset and for an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    // 9 — unknown Asset: the canonical BE-05 not-found error.
    const unknown = await report(
      randomUUID(),
      { title: 'Unsafe condition.' },
      reporter.token,
      key(),
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'ASSET_NOT_FOUND');

    // 10 — a Building the caller is not assigned to yields no report.
    const foreignReporter = await sessionWith([REPORT_PERMISSION]);
    const denied = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      foreignReporter.token,
      key(),
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const count = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM asset_failure_incidents afi
         JOIN incidents i ON i.id = afi.incident_id
        WHERE i.building_id = $1`,
      [building.id],
    );
    assert.equal(count.rows[0]?.count, '0');
  });

  it('requires asset_failure.report and does NOT require asset_failure.manage', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const equipment = await asset(building.id);

    // 11 — no permission at all is forbidden.
    const anonymous = await sessionWith([]);
    await buildingAssignmentService.createAssignment(anonymous.userId, {
      buildingId: building.id,
    });
    const denied = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      anonymous.token,
    );
    assert.equal(denied.status, 403);

    // 11b — holding MANAGEMENT authority is not field-report authority.
    const manager = await sessionWith([
      { code: 'asset_failure.read', name: 'Read Asset Failures' },
      { code: 'asset_failure.manage', name: 'Manage Asset Failures' },
      { code: 'asset.read', name: 'Read Assets' },
    ]);
    await buildingAssignmentService.createAssignment(manager.userId, {
      buildingId: building.id,
    });
    const manageOnly = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      manager.token,
    );
    assert.equal(manageOnly.status, 403);

    // 12 — the dedicated report code alone is sufficient.
    const reporter = await sessionWith([REPORT_PERMISSION]);
    await buildingAssignmentService.createAssignment(reporter.userId, {
      buildingId: building.id,
    });
    const allowed = await report(
      equipment.id,
      { title: 'Unsafe condition.' },
      reporter.token,
      key(),
    );
    assert.equal(allowed.status, 201);
  });

  it('leaves Asset, Equipment, Work Order and Finding state untouched', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);
    await equipmentProfileService.createEquipmentProfile({
      assetId: equipment.id,
      equipmentCode: `EQ_${suffix()}`,
      equipmentName: 'Chiller Technical Sheet',
    });

    const beforeAsset = await assetService.getAssetById(equipment.id);
    const beforeAssetRow = await pool!.query<{
      status: string;
      previous_status: string | null;
      status_reason: string | null;
      status_changed_at: Date | null;
      updated_at: Date;
    }>(
      `SELECT status, previous_status, status_reason, status_changed_at, updated_at
         FROM assets WHERE id = $1`,
      [equipment.id],
    );
    const beforeProfile = await equipmentProfileService.getEquipmentProfileByAssetId(
      equipment.id,
    );
    const beforeProfileRow = await pool!.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM equipment_profiles WHERE asset_id = $1',
      [equipment.id],
    );

    const response = await report(
      equipment.id,
      { title: 'Unsafe condition observed during inspection.' },
      reporter.token,
      key(),
    );
    assert.equal(response.status, 201);

    // 13 — Asset lifecycle byte/value unchanged.
    const afterAsset = await assetService.getAssetById(equipment.id);
    assert.equal(afterAsset.status, beforeAsset.status);
    assert.equal(afterAsset.previousStatus, beforeAsset.previousStatus);
    assert.equal(afterAsset.statusReason, beforeAsset.statusReason);
    assert.equal(afterAsset.statusChangedAt, beforeAsset.statusChangedAt);

    // …and the underlying Asset ROW was not written at all: no status_changed_at
    // bump, and no updated_at bump.
    const afterAssetRow = await pool!.query<{
      status: string;
      previous_status: string | null;
      status_reason: string | null;
      status_changed_at: Date | null;
      updated_at: Date;
    }>(
      `SELECT status, previous_status, status_reason, status_changed_at, updated_at
         FROM assets WHERE id = $1`,
      [equipment.id],
    );
    assert.deepEqual(afterAssetRow.rows[0], beforeAssetRow.rows[0]);

    // 14 — Equipment status unchanged, and the row was not written at all.
    const afterProfile = await equipmentProfileService.getEquipmentProfileByAssetId(
      equipment.id,
    );
    assert.equal(afterProfile.status, beforeProfile.status);
    assert.equal(afterProfile.status, 'ACTIVE');
    const afterProfileRow = await pool!.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM equipment_profiles WHERE asset_id = $1',
      [equipment.id],
    );
    assert.deepEqual(afterProfileRow.rows[0], beforeProfileRow.rows[0]);

    // 15 — no Work Order and no Finding was created or transitioned.
    const workOrderTouched = await pool!.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM work_orders',
    );
    assert.equal(workOrderTouched.rows[0]?.count, '0');
    const findings = await pool!.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM findings',
    );
    assert.equal(findings.rows[0]?.count, '0');

    // The report wrote NO lifecycle history of its own either.
    const assetHistory = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM asset_history_events
        WHERE asset_id = $1 AND event_type = 'ASSET_STATUS_CHANGED'`,
      [equipment.id],
    );
    assert.equal(assetHistory.rows[0]?.count, '0');
  });

  it('keeps repeated reports distinct when the Idempotency-Keys differ', async (t) => {
    if (!ready(t)) return;
    const reporter = await sessionWith([REPORT_PERMISSION]);
    const { building } = await structure({ assignUserId: reporter.userId });
    const equipment = await asset(building.id);

    // 16 — two legitimate reports with DISTINCT idempotency keys are two
    // distinct records. (CR-BE-IDEMPOTENCY-CORE-01 PART 02: the same key with
    // the same canonical request replays the stored result, and the same key
    // with a DIFFERENT canonical request conflicts 409 — proven in
    // tests/mobile-unsafe-condition-idempotency.test.ts.)
    const first = await report(
      equipment.id,
      { title: 'Unsafe condition, first observation.' },
      reporter.token,
      key(),
    );
    const second = await report(
      equipment.id,
      { title: 'Unsafe condition, second observation.' },
      reporter.token,
      key(),
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.data.incidentId, second.body.data.incidentId);
    assert.notEqual(
      first.body.data.incidentNumber,
      second.body.data.incidentNumber,
    );

    const count = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM asset_failure_incidents afi
         JOIN incidents i ON i.id = afi.incident_id
        WHERE i.building_id = $1 AND afi.asset_id = $2`,
      [building.id, equipment.id],
    );
    assert.equal(count.rows[0]?.count, '2');
  });

  it('introduces no OUT_OF_SERVICE / ISOLATED / SHUT_DOWN / RETURN_TO_SERVICE contract', async (t) => {
    if (!ready(t)) return;
    // 18 — the PART adds no equipment-state machine of any kind.
    //
    // This asserts on the CONTRACT SURFACE, not on prose: the module's own
    // doc comments legitimately STATE the absence of these concepts (that is
    // how the boundary is recorded), so scanning raw source for the words
    // would fail on its own documentation. What must be provably absent is
    // any EXECUTABLE form of them: an exported vocabulary member, a route
    // path, or a documented enum value.
    const forbidden = [
      'OUT_OF_SERVICE',
      'out-of-service',
      'out_of_service',
      'ISOLATED',
      'isolated',
      'SHUT_DOWN',
      'SHUTDOWN',
      'shutdown',
      'RETURN_TO_SERVICE',
      'return-to-service',
      'return_to_service',
    ];

    // (a) No exported vocabulary member introduces one.
    const moduleExports = await import(
      '../src/modules/mobile-unsafe-condition'
    );
    const exportedValues: unknown[] = [];
    for (const value of Object.values(moduleExports)) {
      if (typeof value === 'string') exportedValues.push(value);
      else if (Array.isArray(value)) exportedValues.push(...value);
      else if (value && typeof value === 'object') {
        exportedValues.push(...Object.entries(value).flat());
      }
    }
    const vocabulary = exportedValues.filter(
      (value): value is string => typeof value === 'string',
    );
    for (const token of forbidden) {
      assert.equal(
        vocabulary.some((value) => value.includes(token)),
        false,
        `module exports must not introduce ${token}`,
      );
    }

    // (b) No route path introduces one, anywhere in the backend.
    const routeSource = readFileSync(
      resolve(
        __dirname,
        '../src/modules/mobile-unsafe-condition/mobile-unsafe-condition.routes.ts',
      ),
      'utf8',
    );
    const registeredPaths = [
      ...routeSource.matchAll(/\.(?:get|post|put|patch|delete)\s*\(\s*'([^']+)'/g),
    ].map((match) => match[1] as string);
    assert.deepEqual(
      registeredPaths,
      ['/mobile/assets/:assetId/unsafe-condition'],
      'this PART must register exactly one route',
    );
    for (const token of forbidden) {
      assert.equal(
        registeredPaths.some((path) => path.includes(token)),
        false,
        `no route path may introduce ${token}`,
      );
    }

    // (c) No documented enum value introduces one.
    const operation =
      testSpec.paths['/mobile/assets/{assetId}/unsafe-condition'].post;
    const enumValues: unknown[] = [];
    const collectEnums = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'enum' && Array.isArray(value)) enumValues.push(...value);
        else collectEnums(value);
      }
    };
    collectEnums(operation);
    collectEnums(testSpec.components.schemas.MobileUnsafeConditionRequest);
    collectEnums(testSpec.components.schemas.MobileUnsafeConditionReported);
    const documented = enumValues.filter(
      (value): value is string => typeof value === 'string',
    );
    assert.ok(documented.length > 0, 'the command must document its enums');
    for (const token of forbidden) {
      assert.equal(
        documented.some((value) => value.includes(token)),
        false,
        `no documented value may introduce ${token}`,
      );
    }

    // (d) No documented MOBILE path introduces one (the mobile contract must
    // never be where a state machine lives). PART 02/03 add the operational
    // state machine to the non-mobile Asset surface — this PART adds none of it
    // to the mobile namespace, and the ONLY non-mobile path allowed to carry a
    // return-to-service token is the PART 03 governed command.
    const GOVERNED_RETURN_PATH =
      '/assets/{assetId}/operational-state/return-to-service';
    for (const [path, operations] of Object.entries(testSpec.paths ?? {})) {
      if (path === GOVERNED_RETURN_PATH) {
        assert.equal(
          (operations as Record<string, any>).post?.operationId,
          'returnAssetToService',
          'the return-to-service path is the governed PART 03 command',
        );
        continue;
      }
      for (const token of forbidden) {
        assert.equal(
          path.includes(token),
          false,
          `no documented path may introduce ${token}`,
        );
      }
      if (path.startsWith('/mobile/')) {
        for (const token of forbidden) {
          assert.equal(
            path.includes(token),
            false,
            `no mobile path may introduce ${token}`,
          );
        }
      }
    }
  });

  it('is documented in OpenAPI and resolves', async () => {
    // 17 — path, operationId, strict request schema, response schema,
    // bearer security, permission, and Building-scoped semantics.
    const operation =
      testSpec.paths['/mobile/assets/{assetId}/unsafe-condition']?.post;
    assert.ok(operation, 'the unsafe-condition path must be documented');
    assert.equal(operation.operationId, 'reportMobileUnsafeCondition');
    assert.deepEqual(operation.tags, ['Mobile Execution']);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.equal(operation['x-required-permission'], 'asset_failure.report');
    assert.equal(operation['x-building-scoped'], true);

    // The documented permission is a REAL seeded code.
    const seeded = new Set(FOUNDATION_PERMISSIONS.map((p) => p.code));
    assert.ok(
      seeded.has(operation['x-required-permission']),
      'x-required-permission must be a seeded permission code',
    );

    // The Asset id is the path parameter, the REQUIRED generic
    // Idempotency-Key header (CR-BE-IDEMPOTENCY-CORE-01 PART 02), and the
    // request is strict.
    assert.deepEqual(operation.parameters, [
      { $ref: '#/components/parameters/AssetIdPath' },
      { $ref: '#/components/parameters/RequestIdempotencyKeyHeader' },
    ]);
    assert.equal(
      operation.requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/MobileUnsafeConditionRequest',
    );
    const request = testSpec.components.schemas.MobileUnsafeConditionRequest;
    assert.equal(request.additionalProperties, false);
    assert.deepEqual(request.required, ['title']);
    assert.deepEqual(Object.keys(request.properties).sort(), [
      'description',
      'failureCategory',
      'occurredAt',
      'title',
    ]);

    const responseSchema =
      operation.responses['201'].content['application/json'].schema.allOf[1]
        .properties.data.$ref;
    assert.equal(
      responseSchema,
      '#/components/schemas/MobileUnsafeConditionReported',
    );
    const response = testSpec.components.schemas.MobileUnsafeConditionReported;
    assert.deepEqual(response.properties.operationalImpact.enum, [
      'SAFETY_RISK',
    ]);

    // Every $ref used by this operation resolves.
    const known = new Set([
      ...Object.keys(testSpec.components.schemas ?? {}),
      ...Object.keys(testSpec.components.responses ?? {}),
      ...Object.keys(testSpec.components.parameters ?? {}),
    ]);
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value);
        else walk(value);
      }
    };
    walk(operation);
    for (const ref of refs) {
      const name = ref.split('/').pop() as string;
      assert.ok(known.has(name), `unresolved $ref ${ref}`);
    }
  });

  it('does not widen the evidence contract', async (t) => {
    if (!ready(t)) return;
    // §10 — Asset Failure is NOT an established evidence parent in PART 01.
    const evidenceTypes = readFileSync(
      resolve(__dirname, '../src/modules/evidence/mobile-evidence.types.ts'),
      'utf8',
    );
    assert.equal(
      evidenceTypes.includes('ASSET_FAILURE'),
      false,
      'PART 01 must not add Asset Failure as an evidence parent',
    );
  });
});
