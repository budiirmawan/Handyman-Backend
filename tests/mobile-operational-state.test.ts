import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
import { assetService } from '../src/modules/assets';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { equipmentProfileService } from '../src/modules/equipment-profiles';
import { findingClassificationService } from '../src/modules/finding-classifications';
import { findingService } from '../src/modules/findings';
import { findingSeverityService } from '../src/modules/finding-severities';
import { resolveMobileQr } from '../src/modules/mobile-qr-resolution';
import { MOBILE_ASSET_OPERATIONAL_ACTIONS } from '../src/modules/mobile-operational-state';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — mobile RN-10 operational-state
 * authority.
 *
 * Proves the new mobile READ publishes the canonical PART 02 operational-
 * state view field for field, resolves a CALLER-SPECIFIC `availableActions`
 * snapshot from the closed five-token vocabulary off authoritative facts
 * only, and never becomes a write path: the canonical mutations keep
 * revalidating permission, transition, version (CAS), lifecycle terminality
 * and the PART 03 safety gate on every call. Also proves the boundaries —
 * no mobile mutation endpoint, no RN-10 token in QR, no heuristic
 * (Work Order / workType / Finding / status-string / QR) controlling the
 * tokens — are enforced rather than merely assumed.
 *
 * Idempotency is NOT re-proven here: the PART 01 unsafe-report command keeps
 * its CR-BE-IDEMPOTENCY-CORE-01 contract, pinned by
 * `tests/request-idempotency.test.ts` and
 * `tests/mobile-unsafe-condition-idempotency.test.ts`, which this CR runs
 * unchanged.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const ROUTES_DIR = resolve(__dirname, '../src/routes');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

const MOBILE_PATH = '/mobile/assets/{assetId}/operational-state';
const MOBILE_ROUTE = 'GET /mobile/assets/:assetId/operational-state';
const OPERATION_ID = 'getMobileAssetOperationalState';

const READ_PERMISSION = {
  code: 'asset_operational_state.read',
  name: 'Read Mobile Asset Operational State',
};
const ASSET_READ_PERMISSION = { code: 'asset.read', name: 'Read Assets' };
const ASSET_MANAGE_PERMISSION = {
  code: 'asset.manage',
  name: 'Manage Assets',
};
const MANAGE_PERMISSION = {
  code: 'asset_operational_state.manage',
  name: 'Manage Asset Operational State',
};
const RETURN_PERMISSION = {
  code: 'asset_operational_state.return_to_service',
  name: 'Return Asset to Service',
};
const REPORT_PERMISSION = {
  code: 'asset_failure.report',
  name: 'Report Unsafe Asset Conditions',
};
const FAILURE_MANAGE_PERMISSION = {
  code: 'asset_failure.manage',
  name: 'Manage Asset Failures',
};
const EQUIPMENT_MANAGE_PERMISSION = {
  code: 'equipment_profile.manage',
  name: 'Manage Equipment Profiles',
};
const WORK_ORDER_MANAGE_PERMISSION = {
  code: 'work_order.manage',
  name: 'Manage Work Orders',
};
const FINDING_MANAGE_PERMISSION = {
  code: 'finding.manage',
  name: 'Manage Findings',
};

/** The five tokens — and nothing else — may ever appear in the response. */
const ALL_ACTIONS = MOBILE_ASSET_OPERATIONAL_ACTIONS as readonly string[];
const MARK_TOKENS = ['MARK_OUT_OF_SERVICE', 'MARK_ISOLATED', 'MARK_SHUT_DOWN'] as const;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE asset_failure_incidents, operational_incidents,
    finding_escalation_incidents, incidents, asset_history_events,
    asset_identifiers, assets, equipment_profiles, work_orders, findings,
    finding_severities, finding_classifications, operational_events,
    buildings, properties, users, roles, permissions, clients CASCADE`);
  const admin = await sessionWith([
    READ_PERMISSION,
    ASSET_READ_PERMISSION,
    ASSET_MANAGE_PERMISSION,
    MANAGE_PERMISSION,
    RETURN_PERMISSION,
    REPORT_PERMISSION,
    FAILURE_MANAGE_PERMISSION,
    EQUIPMENT_MANAGE_PERMISSION,
    WORK_ORDER_MANAGE_PERMISSION,
    FINDING_MANAGE_PERMISSION,
  ]);
  adminToken = admin.token;
  adminUserId = admin.userId;
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

/** Authenticated session whose role carries EXACTLY the given codes. */
async function sessionWith(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix().toLowerCase();
  const password = 'FieldPass123';
  const user = await userService.createUser({
    email: `rn10-${tag}@example.com`,
    displayName: 'RN10 Field User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `RN10_${tag.toUpperCase()}`,
    name: 'RN10 Field User',
  });
  for (const permission of codes) {
    const permissionId = await ensurePermissionId(
      permission.code,
      permission.name,
    );
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function structure(options: { assignUserId?: string | null } = {}) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'RN10 Mobile State Client',
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
  // Default: the admin session can reach the Building (it holds the
  // canonical mutation permissions; the tests under audit build their own
  // narrow sessions explicitly).
  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function createAsset(
  buildingId: string,
  overrides: Partial<Parameters<typeof assetService.createAsset>[0]> = {},
) {
  return assetService.createAsset({
    buildingId,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller Unit',
    ...overrides,
  });
}

/** A fresh Asset in a Building the admin can reach. */
async function fixture(overrides: object = {}) {
  const { building } = await structure();
  return { building, asset: await createAsset(building.id, overrides) };
}

const mobileState = (assetId: string, token: string) =>
  api()
    .get(`/api/v1/mobile/assets/${assetId}/operational-state`)
    .set({ Authorization: `Bearer ${token}` });

const canonicalState = (assetId: string, token: string) =>
  api()
    .get(`/api/v1/assets/${assetId}/operational-state`)
    .set({ Authorization: `Bearer ${token}` });

async function transition(
  assetId: string,
  state: string,
  reason = 'Equipment must not be used.',
  token = adminToken,
) {
  const current = await canonicalState(assetId, token);
  assert.equal(current.status, 200, JSON.stringify(current.body));
  const response = await api()
    .patch(`/api/v1/assets/${assetId}/operational-state`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ state, reason, expectedVersion: current.body.data.version });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

async function retireAsset(assetId: string, token = adminToken) {
  const response = await api()
    .patch(`/api/v1/assets/${assetId}/status`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ status: 'RETIRED', reason: 'End of life.' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

async function createFailure(
  buildingId: string,
  assetId: string,
  overrides: Record<string, unknown> = {},
  token = adminToken,
) {
  const response = await api()
    .post('/api/v1/asset-failures')
    .set({ Authorization: `Bearer ${token}` })
    .send({
      buildingId,
      assetId,
      incidentNumber: `AF_${suffix()}`,
      title: 'Chiller compressor failure',
      failureCategory: 'MECHANICAL_FAILURE',
      occurredAt: PAST,
      ...overrides,
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data as { id: string; failureStatus: string };
}

async function setFailureStatus(
  incidentId: string,
  failureStatus: string,
  token = adminToken,
) {
  const response = await api()
    .patch(`/api/v1/asset-failures/${incidentId}`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ failureStatus });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data as { failureStatus: string };
}

async function createWorkOrder(
  client: { id: string },
  buildingId: string,
  workType: string,
  token = adminToken,
) {
  const response = await api()
    .post(`/api/v1/buildings/${buildingId}/work-orders`)
    .set({ Authorization: `Bearer ${token}` })
    .send({
      clientId: client.id,
      buildingId,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Chiller inspection',
      workType,
      createdByUserId: adminUserId,
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data as { id: string };
}

async function setWorkOrderPriority(
  workOrderId: string,
  priority: string,
  token = adminToken,
) {
  const response = await api()
    .patch(`/api/v1/work-orders/${workOrderId}/priority`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ priority });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

/** Every registered METHOD+PATH found in the route modules. */
function registeredRoutes(): string[] {
  const re = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const out: string[] = [];
  function walk(dir: string): string[] {
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) files.push(...walk(path));
      else if (name.endsWith('.routes.ts')) files.push(path);
    }
    return files;
  }
  for (const file of [...walk(MODULES_DIR), ...walk(ROUTES_DIR)]) {
    const src = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      out.push(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }
  return out;
}

/** The caller-specific token list from a successful mobile read. */
async function actionsFor(assetId: string, token: string): Promise<string[]> {
  const response = await mobileState(assetId, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.availableActions as string[];
}

/** Registers a QR identifier on the Asset and resolves it (BE-25F seam). */
async function registerAndResolveQr(assetId: string): Promise<unknown> {
  const qr = `QR${suffix()}`;
  await pool!.query(
    `INSERT INTO asset_identifiers
       (id, asset_id, identifier_type, identifier_value, status)
     VALUES ($1, $2, 'QR', $3, 'ACTIVE')`,
    [randomUUID(), assetId, qr],
  );
  return resolveMobileQr(qr, adminUserId);
}

describe('CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — mobile operational state', () => {
  describe('1-3. the mobile read and its authority', () => {
    it('1. a caller with asset_operational_state.read reads within Building scope', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const reader = await sessionWith([READ_PERMISSION]);
      await buildingAssignmentService.createAssignment(reader.userId, {
        buildingId: building.id,
      });

      const response = await mobileState(asset.id, reader.token);

      assert.equal(response.status, 200, JSON.stringify(response.body));
      const data = response.body.data;
      assert.equal(data.assetId, asset.id);
      assert.ok(Array.isArray(data.availableActions));
    });

    it('2. without the read permission the route is forbidden', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const outsider = await sessionWith([]);

      const response = await mobileState(asset.id, outsider.token);

      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    });

    it('3. a cross-Building caller is denied (403, not a disclosure)', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const reader = await sessionWith([READ_PERMISSION]);
      // A Building the reader CAN reach — access to one Building must not
      // expand to another. (assignUserId: null keeps admin off this one.)
      const { building: other } = await structure({ assignUserId: null });
      await buildingAssignmentService.createAssignment(reader.userId, {
        buildingId: other.id,
      });

      const response = await mobileState(asset.id, reader.token);

      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
      assert.ok(building.id !== other.id);
    });
  });

  describe('4-5. the response reuses the canonical PART 02 view', () => {
    it('4. state, version, actor, timestamp, reason and allowedTransitions match the canonical read exactly', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE', 'Vibration beyond limit.');

      const reader = await sessionWith([READ_PERMISSION, ASSET_READ_PERMISSION]);
      await buildingAssignmentService.createAssignment(reader.userId, {
        buildingId: building.id,
      });

      const mobile = await mobileState(asset.id, reader.token);
      const canonical = await canonicalState(asset.id, reader.token);

      assert.equal(mobile.status, 200, JSON.stringify(mobile.body));
      assert.equal(canonical.status, 200, JSON.stringify(canonical.body));

      const canonicalFields = {
        assetId: canonical.body.data.assetId,
        assetStatus: canonical.body.data.assetStatus,
        operationalState: canonical.body.data.operationalState,
        version: canonical.body.data.version,
        changedAt: canonical.body.data.changedAt,
        changedByUserId: canonical.body.data.changedByUserId,
        reason: canonical.body.data.reason,
        allowedTransitions: canonical.body.data.allowedTransitions,
      };
      const mobileFields = {
        assetId: mobile.body.data.assetId,
        assetStatus: mobile.body.data.assetStatus,
        operationalState: mobile.body.data.operationalState,
        version: mobile.body.data.version,
        changedAt: mobile.body.data.changedAt,
        changedByUserId: mobile.body.data.changedByUserId,
        reason: mobile.body.data.reason,
        allowedTransitions: mobile.body.data.allowedTransitions,
      };
      assert.deepEqual(mobileFields, canonicalFields);
      // The mobile surface adds exactly ONE field.
      assert.deepEqual(Object.keys(mobile.body.data).sort(), [
        'allowedTransitions',
        'assetId',
        'assetStatus',
        'availableActions',
        'changedAt',
        'changedByUserId',
        'operationalState',
        'reason',
        'version',
      ]);
    });

    it('5. assetStatus is exactly the canonical master-lifecycle status', async (t) => {
      if (!ready(t)) return;

      const reader = await sessionWith([READ_PERMISSION, ASSET_READ_PERMISSION]);
      const { building, asset } = await fixture();
      await buildingAssignmentService.createAssignment(reader.userId, {
        buildingId: building.id,
      });

      const before = await mobileState(asset.id, reader.token);
      assert.equal(before.body.data.assetStatus, 'ACTIVE');

      await retireAsset(asset.id);
      const after = await mobileState(asset.id, reader.token);
      assert.equal(after.status, 200);
      assert.equal(after.body.data.assetStatus, 'RETIRED');
      // Terminality closes the operational axis, not visibility.
      assert.deepEqual(after.body.data.allowedTransitions, []);
    });
  });

  describe('6-9. REPORT_UNSAFE_CONDITION authority', () => {
    it('6. appears with asset_failure.report', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const reporter = await sessionWith([READ_PERMISSION, REPORT_PERMISSION]);
      await buildingAssignmentService.createAssignment(reporter.userId, {
        buildingId: building.id,
      });

      const actions = await actionsFor(asset.id, reporter.token);

      assert.ok(actions.includes('REPORT_UNSAFE_CONDITION'));
      for (const token of MARK_TOKENS) assert.ok(!actions.includes(token));
    });

    it('7. is absent without asset_failure.report', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const reader = await sessionWith([READ_PERMISSION]);
      await buildingAssignmentService.createAssignment(reader.userId, {
        buildingId: building.id,
      });

      const actions = await actionsFor(asset.id, reader.token);
      assert.equal(actions.includes('REPORT_UNSAFE_CONDITION'), false);
    });

    it('8. asset_operational_state.manage does not imply REPORT_UNSAFE_CONDITION', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      const manager = await sessionWith([READ_PERMISSION, MANAGE_PERMISSION]);
      await buildingAssignmentService.createAssignment(manager.userId, {
        buildingId: building.id,
      });

      const actions = await actionsFor(asset.id, manager.token);
      assert.equal(actions.includes('REPORT_UNSAFE_CONDITION'), false);
    });

    it('9. asset_failure.report does not imply any MARK_* action', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE');
      const reporter = await sessionWith([READ_PERMISSION, REPORT_PERMISSION]);
      await buildingAssignmentService.createAssignment(reporter.userId, {
        buildingId: building.id,
      });

      const actions = await actionsFor(asset.id, reporter.token);
      for (const token of MARK_TOKENS) {
        assert.equal(actions.includes(token), false, `${token} leaked`);
      }
    });
  });

  describe('10-16. MARK_* map the canonical allowedTransitions exactly', () => {
    const cases: Array<{
      state: string;
      expectedMarks: string[];
    }> = [
      {
        state: 'IN_SERVICE',
        expectedMarks: ['MARK_OUT_OF_SERVICE', 'MARK_ISOLATED', 'MARK_SHUT_DOWN'],
      },
      { state: 'OUT_OF_SERVICE', expectedMarks: ['MARK_ISOLATED', 'MARK_SHUT_DOWN'] },
      {
        state: 'ISOLATED',
        expectedMarks: ['MARK_OUT_OF_SERVICE', 'MARK_SHUT_DOWN'],
      },
      {
        state: 'SHUT_DOWN',
        expectedMarks: ['MARK_OUT_OF_SERVICE', 'MARK_ISOLATED'],
      },
    ];

    for (const [index, { state, expectedMarks }] of cases.entries()) {
      it(`${10 + index}. ${state} + manage → ${expectedMarks.join(', ')}`, async (t) => {
        if (!ready(t)) return;

        const { building, asset } = await fixture();
        if (state !== 'IN_SERVICE') await transition(asset.id, state);
        const manager = await sessionWith([READ_PERMISSION, MANAGE_PERMISSION]);
        await buildingAssignmentService.createAssignment(manager.userId, {
          buildingId: building.id,
        });

        const actions = await actionsFor(asset.id, manager.token);

        for (const token of expectedMarks) {
          assert.ok(actions.includes(token), `${token} missing`);
        }
        for (const token of MARK_TOKENS) {
          if (!expectedMarks.includes(token)) {
            assert.ok(!actions.includes(token), `${token} must not appear`);
          }
        }
        // The deterministic response order mirrors the vocabulary order.
        const markOrder = (['MARK_OUT_OF_SERVICE', 'MARK_ISOLATED', 'MARK_SHUT_DOWN'] as const)
          .filter((token) => expectedMarks.includes(token));
        assert.deepEqual(
          actions.filter((token) => token.startsWith('MARK_')),
          markOrder,
        );
      });
    }

    it('14. without manage there are no MARK_* actions', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE');
      const reader = await sessionWith([READ_PERMISSION]);
      await buildingAssignmentService.createAssignment(reader.userId, {
        buildingId: building.id,
      });

      const actions = await actionsFor(asset.id, reader.token);
      for (const token of MARK_TOKENS) {
        assert.equal(actions.includes(token), false);
      }
    });

    it('15. a RETIRED asset offers no MARK_* actions', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      await retireAsset(asset.id);
      const manager = await sessionWith([READ_PERMISSION, MANAGE_PERMISSION]);
      await buildingAssignmentService.createAssignment(manager.userId, {
        buildingId: building.id,
      });

      const response = await mobileState(asset.id, manager.token);
      assert.equal(response.status, 200);
      const actions = response.body.data.availableActions as string[];
      for (const token of MARK_TOKENS) {
        assert.equal(actions.includes(token), false, `${token} leaked`);
      }
    });

    it('16. no severity ordering exists among the non-service states', async (t) => {
      if (!ready(t)) return;

      // From EACH non-service state the other TWO are offered and the
      // current one is not — the three states are peers.
      const nonService = ['OUT_OF_SERVICE', 'ISOLATED', 'SHUT_DOWN'] as const;
      for (const source of nonService) {
        const { building, asset } = await fixture();
        await transition(asset.id, source);
        const manager = await sessionWith([READ_PERMISSION, MANAGE_PERMISSION]);
        await buildingAssignmentService.createAssignment(manager.userId, {
          buildingId: building.id,
        });

        const actions = new Set(await actionsFor(asset.id, manager.token));

        for (const target of nonService) {
          const token = `MARK_${target}`;
          if (target === source) {
            assert.ok(!actions.has(token), `${source}: ${token} leaked`);
          } else {
            assert.ok(actions.has(token), `${source}: ${token} missing`);
          }
        }
      }
    });
  });

  describe('17-24. RETURN_TO_SERVICE authority', () => {
    async function returnedFrom(
      state: string,
      codes: readonly { code: string; name: string }[],
      withFailure?: (buildingId: string, assetId: string) => Promise<void>,
    ): Promise<string[]> {
      const { building, asset } = await fixture();
      if (state !== 'IN_SERVICE') await transition(asset.id, state);
      if (withFailure) await withFailure(building.id, asset.id);
      const caller = await sessionWith(codes);
      await buildingAssignmentService.createAssignment(caller.userId, {
        buildingId: building.id,
      });
      return actionsFor(asset.id, caller.token);
    }

    it('17. non-service + return permission + safety clear → present', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom('OUT_OF_SERVICE', [
        READ_PERMISSION,
        RETURN_PERMISSION,
      ]);
      assert.ok(actions.includes('RETURN_TO_SERVICE'));
    });

    it('18. IN_SERVICE → absent', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom('IN_SERVICE', [
        READ_PERMISSION,
        RETURN_PERMISSION,
      ]);
      assert.equal(actions.includes('RETURN_TO_SERVICE'), false);
    });

    it('19. RETIRED → absent', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      await retireAsset(asset.id);
      const caller = await sessionWith([READ_PERMISSION, RETURN_PERMISSION]);
      await buildingAssignmentService.createAssignment(caller.userId, {
        buildingId: building.id,
      });

      const actions = await actionsFor(asset.id, caller.token);
      assert.equal(actions.includes('RETURN_TO_SERVICE'), false);
    });

    it('20. an unresolved SAFETY_RISK blocks the token', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom(
        'OUT_OF_SERVICE',
        [READ_PERMISSION, RETURN_PERMISSION],
        async (buildingId, assetId) => {
          await createFailure(buildingId, assetId, {
            operationalImpact: 'SAFETY_RISK',
          });
        },
      );
      assert.equal(actions.includes('RETURN_TO_SERVICE'), false);
    });

    it('21. a resolved SAFETY_RISK does not block the token', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom(
        'OUT_OF_SERVICE',
        [READ_PERMISSION, RETURN_PERMISSION],
        async (buildingId, assetId) => {
          const failure = await createFailure(buildingId, assetId, {
            operationalImpact: 'SAFETY_RISK',
          });
          await setFailureStatus(failure.id, 'IN_PROGRESS');
          await setFailureStatus(failure.id, 'RESOLVED');
        },
      );
      assert.ok(actions.includes('RETURN_TO_SERVICE'));
    });

    it('22. a reopened SAFETY_RISK blocks the token again', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom(
        'OUT_OF_SERVICE',
        [READ_PERMISSION, RETURN_PERMISSION],
        async (buildingId, assetId) => {
          const failure = await createFailure(buildingId, assetId, {
            operationalImpact: 'SAFETY_RISK',
          });
          await setFailureStatus(failure.id, 'RESOLVED');
          // Canonical reopen: RESOLVED → IN_PROGRESS.
          await setFailureStatus(failure.id, 'IN_PROGRESS');
        },
      );
      assert.equal(actions.includes('RETURN_TO_SERVICE'), false);
    });

    it('23. manage alone does not imply RETURN_TO_SERVICE', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom('OUT_OF_SERVICE', [
        READ_PERMISSION,
        MANAGE_PERMISSION,
      ]);
      assert.equal(actions.includes('RETURN_TO_SERVICE'), false);
    });

    it('24. the return permission alone implies no MARK_* action', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom('OUT_OF_SERVICE', [
        READ_PERMISSION,
        RETURN_PERMISSION,
      ]);
      for (const token of MARK_TOKENS) {
        assert.equal(actions.includes(token), false, `${token} leaked`);
      }
    });

    it('a non-SAFETY_RISK failure never blocks RETURN_TO_SERVICE', async (t) => {
      if (!ready(t)) return;

      const actions = await returnedFrom(
        'ISOLATED',
        [READ_PERMISSION, RETURN_PERMISSION],
        async (buildingId, assetId) => {
          await createFailure(buildingId, assetId, {
            operationalImpact: 'DEGRADED',
          });
        },
      );
      assert.ok(actions.includes('RETURN_TO_SERVICE'));
    });
  });

  describe('25-30. no heuristic controls the RN-10 tokens', () => {
    const FULL_CODES = [
      READ_PERMISSION,
      REPORT_PERMISSION,
      MANAGE_PERMISSION,
      RETURN_PERMISSION,
    ] as const;

    async function fixtureWithFullCaller() {
      const { client, building, asset } = await fullFixture();
      const caller = await sessionWith(FULL_CODES);
      await buildingAssignmentService.createAssignment(caller.userId, {
        buildingId: building.id,
      });
      return { client, building, asset, caller };
    }

    async function fullFixture() {
      const { client, building } = await structure();
      const asset = await createAsset(building.id);
      return { client, building, asset };
    }

    it('25. a CRITICAL work-order priority does not change the actions', async (t) => {
      if (!ready(t)) return;

      const { client, building, asset, caller } = await fixtureWithFullCaller();
      await transition(asset.id, 'OUT_OF_SERVICE');

      const before = await actionsFor(asset.id, caller.token);
      const workOrder = await createWorkOrder(client, building.id, 'INSPECTION');
      await setWorkOrderPriority(workOrder.id, 'CRITICAL');
      const after = await actionsFor(asset.id, caller.token);

      assert.deepEqual(after, before);
    });

    it('26. the work-order workType does not change the actions', async (t) => {
      if (!ready(t)) return;

      const { client, building, asset, caller } = await fixtureWithFullCaller();
      await transition(asset.id, 'OUT_OF_SERVICE');

      const before = await actionsFor(asset.id, caller.token);
      await createWorkOrder(client, building.id, 'BREAKDOWN_REPAIR');
      await createWorkOrder(client, building.id, 'PREVENTIVE');
      const after = await actionsFor(asset.id, caller.token);

      assert.deepEqual(after, before);
    });

    it('27. lifecycle / equipment status strings beyond terminality do not change the actions', async (t) => {
      if (!ready(t)) return;

      // Equipment-profile presentation status.
      const equipment = await fixtureWithFullCaller();
      await transition(equipment.asset.id, 'OUT_OF_SERVICE');
      await equipmentProfileService.createEquipmentProfile({
        assetId: equipment.asset.id,
        equipmentCode: `EQ_${suffix()}`,
        equipmentName: 'Chiller',
        status: 'INACTIVE',
      } as Parameters<typeof equipmentProfileService.createEquipmentProfile>[0]);
      const withInactiveEquipment = await actionsFor(
        equipment.asset.id,
        equipment.caller.token,
      );
      assert.ok(withInactiveEquipment.includes('MARK_ISOLATED'));

      // Non-terminal master lifecycle: INACTIVE is not terminality, so the
      // operational axis stays open and the actions do not move. (The
      // lifecycle move itself is `asset.manage` authority — admin performs
      // it; only the RESULTING presentation string is under test.)
      const lifecycle = await fixtureWithFullCaller();
      await transition(lifecycle.asset.id, 'OUT_OF_SERVICE');
      const lifecycleMove = await api()
        .patch(`/api/v1/assets/${lifecycle.asset.id}/status`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ status: 'INACTIVE', reason: 'Seasonal shutdown.' });
      assert.equal(lifecycleMove.status, 200, JSON.stringify(lifecycleMove.body));
      const withInactiveAsset = await actionsFor(
        lifecycle.asset.id,
        lifecycle.caller.token,
      );
      assert.deepEqual(withInactiveAsset, withInactiveEquipment);
    });

    it('28. a Finding severity does not change the actions', async (t) => {
      if (!ready(t)) return;

      const { client, building, asset, caller } = await fixtureWithFullCaller();
      await transition(asset.id, 'OUT_OF_SERVICE');

      const before = await actionsFor(asset.id, caller.token);
      const finding = await findingService.createFinding({
        clientId: client.id,
        buildingId: building.id,
        findingNumber: `F_${suffix()}`,
        title: 'Chiller anomaly',
        reportedByUserId: adminUserId,
      });
      const severity = await findingSeverityService.createFindingSeverity({
        clientId: client.id,
        code: `SEV_${suffix()}`,
        name: 'Severity A',
        rank: 1,
      });
      await findingService.updateFinding(finding.id, { severityId: severity.id });
      const after = await actionsFor(asset.id, caller.token);

      assert.deepEqual(after, before);
    });

    it('29. a Finding classification does not change the actions', async (t) => {
      if (!ready(t)) return;

      const { client, building, asset, caller } = await fixtureWithFullCaller();
      await transition(asset.id, 'OUT_OF_SERVICE');

      const before = await actionsFor(asset.id, caller.token);
      const finding = await findingService.createFinding({
        clientId: client.id,
        buildingId: building.id,
        findingNumber: `F_${suffix()}`,
        title: 'Chiller anomaly',
        reportedByUserId: adminUserId,
      });
      const classification =
        await findingClassificationService.createFindingClassification({
          clientId: client.id,
          code: `CLS_${suffix()}`,
          name: 'Classification A',
        });
      await findingService.updateFinding(finding.id, {
        classificationId: classification.id,
      });
      const after = await actionsFor(asset.id, caller.token);

      assert.deepEqual(after, before);
    });

    it('30. a QR registration / resolution never changes the actions', async (t) => {
      if (!ready(t)) return;

      const { asset, caller } = await fixtureWithFullCaller();
      await transition(asset.id, 'OUT_OF_SERVICE');

      const before = await actionsFor(asset.id, caller.token);
      const resolution = await registerAndResolveQr(asset.id);
      const after = await actionsFor(asset.id, caller.token);

      assert.deepEqual(after, before);
      // And the QR surface itself carries no RN-10 token.
      assert.ok(JSON.stringify(resolution).includes('VIEW_DETAILS'));
      for (const token of ALL_ACTIONS) {
        assert.equal(
          JSON.stringify(resolution).includes(token),
          false,
          `QR resolution must not carry ${token}`,
        );
      }
    });

    it('the resolver module reads only its closed fact inputs', () => {
      // Static boundary: the PART 04 module may not open a channel to Work
      // Orders, Findings, QR, or equipment profiles. Its inter-module
      // imports are exactly the four authoritative seams it documents.
      const dir = resolve(
        MODULES_DIR,
        'mobile-operational-state',
      );
      const allowed = new Set([
        // The four authoritative fact seams — plus the shared auth/error
        // infrastructure the controller uses to report an unauthenticated
        // caller. Nothing else: no Work Order, Finding, QR, or
        // equipment-profile channel exists in the module.
        'auth',
        'asset-failures',
        'asset-operational-state',
        'assets',
        'context-access',
        'permissions',
      ]);
      // Single-level `../module` imports only (deeper `../../shared/...`
      // imports are shared infrastructure, not domain seams).
      const importRe = /from '\.\.\/([^/'\n]+)'/g;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue;
        const src = readFileSync(join(dir, name), 'utf8');
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(src)) !== null) {
          const module = match[1];
          assert.ok(
            allowed.has(module),
            `mobile-operational-state/${name} imports ../${module}: the resolver's inputs are closed`,
          );
        }
      }
    });
  });

  describe('31-35. tokens are a snapshot; commands revalidate', () => {
    it('31. a stale MARK_* snapshot cannot move state: the CAS revalidates', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE');

      const manager = await sessionWith([READ_PERMISSION, MANAGE_PERMISSION]);
      await buildingAssignmentService.createAssignment(manager.userId, {
        buildingId: building.id,
      });

      // The caller reads the snapshot — MARK_ISOLATED is offered.
      const snapshot = await mobileState(asset.id, manager.token);
      assert.equal(snapshot.status, 200);
      assert.ok(
        (snapshot.body.data.availableActions as string[]).includes(
          'MARK_ISOLATED',
        ),
      );
      const staleVersion = snapshot.body.data.version;

      // Another caller moves the Asset first (OUT_OF_SERVICE → ISOLATED).
      await transition(asset.id, 'ISOLATED', 'Condensate leak.');

      // The stale snapshot must not act as authority: a transition the
      // snapshot described (SHUT_DOWN was offered from OUT_OF_SERVICE),
      // replayed with the snapshot's version, fails the CAS — the state
      // and version the guarded UPDATE matches no longer hold.
      const stale = await api()
        .patch(`/api/v1/assets/${asset.id}/operational-state`)
        .set({ Authorization: `Bearer ${manager.token}` })
        .send({
          state: 'SHUT_DOWN',
          reason: 'From a stale snapshot.',
          expectedVersion: staleVersion,
        });
      assert.equal(stale.status, 409);
      assert.equal(
        stale.body.error.code,
        'ASSET_OPERATIONAL_STATE_CONFLICT',
      );
      // The conflict carries the CURRENT facts, so the caller reloads.
      assert.equal(
        stale.body.error.conflict?.current?.operationalState,
        'ISOLATED',
      );
      assert.equal(
        stale.body.error.conflict?.expectedVersion,
        staleVersion,
      );

      // And a correctly re-read snapshot still works — the mobile client
      // reloads its own view, and authority is revalidated, not remembered.
      const current = await mobileState(asset.id, manager.token);
      assert.equal(current.status, 200);
      // The re-read snapshot reflects the new state — the tokens moved with
      // it (ISOLATED now offers MARK_OUT_OF_SERVICE / MARK_SHUT_DOWN).
      assert.deepEqual(
        (current.body.data.availableActions as string[]).filter((token) =>
          token.startsWith('MARK_'),
        ),
        ['MARK_OUT_OF_SERVICE', 'MARK_SHUT_DOWN'],
      );
      const fresh = await api()
        .patch(`/api/v1/assets/${asset.id}/operational-state`)
        .set({ Authorization: `Bearer ${manager.token}` })
        .send({
          state: 'SHUT_DOWN',
          reason: 'From a fresh read.',
          expectedVersion: current.body.data.version,
        });
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    });

    it('32. a stale RETURN_TO_SERVICE snapshot cannot clear a new SAFETY_RISK', async (t) => {
      if (!ready(t)) return;

      const { building, asset } = await fixture();
      await transition(asset.id, 'OUT_OF_SERVICE');

      const authority = await sessionWith([
        READ_PERMISSION,
        RETURN_PERMISSION,
      ]);
      await buildingAssignmentService.createAssignment(authority.userId, {
        buildingId: building.id,
      });

      // The snapshot says the return is available.
      const snapshot = await mobileState(asset.id, authority.token);
      assert.ok(
        (snapshot.body.data.availableActions as string[]).includes(
          'RETURN_TO_SERVICE',
        ),
      );
      const version = snapshot.body.data.version;

      // A field reporter then records an unresolved SAFETY_RISK.
      const reporter = await sessionWith([REPORT_PERMISSION]);
      await buildingAssignmentService.createAssignment(reporter.userId, {
        buildingId: building.id,
      });
      const report = await api()
        .post(`/api/v1/mobile/assets/${asset.id}/unsafe-condition`)
        .set({ Authorization: `Bearer ${reporter.token}` })
        .set({ 'Idempotency-Key': `rk-${randomUUID()}` })
        .send({
          title: 'Sparking at the manifold',
          description: 'Visible arcing.',
          failureCategory: 'ELECTRICAL_FAILURE',
        });
      assert.equal(report.status, 201, JSON.stringify(report.body));

      // The governed command still blocks: the gate revalidates.
      const blocked = await api()
        .post(`/api/v1/assets/${asset.id}/operational-state/return-to-service`)
        .set({ Authorization: `Bearer ${authority.token}` })
        .send({ reason: 'Thought the hazard was cleared.', expectedVersion: version });
      assert.equal(blocked.status, 409);
      assert.equal(
        blocked.body.error.code,
        'ASSET_OPERATIONAL_STATE_UNRESOLVED_SAFETY_RISK',
      );

      // The state did not move: still OUT_OF_SERVICE at the same version.
      const after = await canonicalState(asset.id, adminToken);
      assert.equal(after.body.data.operationalState, 'OUT_OF_SERVICE');
      assert.equal(after.body.data.version, version);
    });

    it('34. the generic PATCH still cannot target IN_SERVICE', async (t) => {
      if (!ready(t)) return;

      const { asset } = await fixture();
      const response = await api()
        .patch(`/api/v1/assets/${asset.id}/operational-state`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({
          state: 'IN_SERVICE',
          reason: 'I am putting it back.',
          expectedVersion: 1,
        });
      assert.equal(response.status, 400);
      assert.equal(
        response.body.error.details
          ?.some(
            (detail: { field?: string }) =>
              detail?.field === 'state' &&
              /IN_SERVICE|return-to-service/i.test(String(detail.message)),
          ) ??
          /IN_SERVICE|return-to-service/i.test(JSON.stringify(response.body)),
        true,
      );
    });

    it('35. no duplicate mobile mutation route exists', () => {
      const routes = registeredRoutes();

      // The mobile operational-state surface is exactly the one GET.
      assert.deepEqual(
        routes.filter((route) => route.includes('/mobile/') && route.includes('operational-state')),
        [MOBILE_ROUTE],
      );
      // No mobile out-of-service / isolate / shutdown / return-to-service
      // command exists anywhere in the backend.
      const mobileMutations = routes.filter(
        (route) =>
          route.startsWith('POST /mobile/') ||
          route.startsWith('PATCH /mobile/') ||
          route.startsWith('PUT /mobile/') ||
          route.startsWith('DELETE /mobile/'),
      );
      const forbidden =
        /operational-state|out[-_]?of[-_]?service|isolate|shutdown|return[-_]?to[-_]?service/i;
      for (const route of mobileMutations) {
        assert.equal(
          forbidden.test(route),
          false,
          `${route} must not exist: RN-10 mutations are canonical on /assets`,
        );
      }
    });
  });

  describe('40-46. the OpenAPI contract', () => {
    it('40. the mobile read route is registered and not a 404', async () => {
      assert.ok(
        registeredRoutes().includes(MOBILE_ROUTE),
        'route must be registered in the router',
      );

      const probe = await api().get(
        `/api/v1/mobile/assets/${randomUUID()}/operational-state`,
      );
      // Authenticated callers reach the handler; anonymous probes are
      // refused by authentication — never a 404 fall-through.
      assert.equal(probe.status, 401);
      assert.equal(probe.body.error.code, 'AUTHENTICATION_REQUIRED');
    });

    it('41. the operationId is unique', () => {
      // Uniqueness over every DEFINED operationId. (A small number of
      // pre-existing SLA-domain operations in the baseline lack an
      // operationId; that historical debt is out of scope for this PART and
      // is reported separately — it is not introduced here.)
      const seen = new Map<string, string>();
      for (const [path, operations] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(
          operations as Record<string, any>,
        )) {
          if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
          const id = operation.operationId as string | undefined;
          if (id === undefined) continue;
          if (seen.has(id)) {
            assert.fail(
              `duplicate operationId ${id}: ${seen.get(id)} and ${path}`,
            );
          }
          seen.set(id, path);
        }
      }
      assert.equal(seen.get(OPERATION_ID), MOBILE_PATH);
    });

    it('42. the availableActions schema contains exactly the five tokens', () => {
      const schema = spec.components?.schemas?.MobileAssetOperationalAction;
      assert.ok(schema, 'MobileAssetOperationalAction schema required');
      assert.deepEqual(
        [...(schema.enum as string[])].sort(),
        [...ALL_ACTIONS].sort(),
      );

      const view = spec.components?.schemas?.MobileAssetOperationalStateView;
      assert.ok(view, 'MobileAssetOperationalStateView schema required');
      assert.ok(view.allOf, 'the view extends the canonical PART 02 model');
    });

    it('43. no RN-10 mutation token appears in the QR vocabulary', async (t) => {
      // Runtime: the QR resolution offers only its own pre-PART-04 actions.
      if (ready(t)) {
        const { asset } = await fixture();
        const resolution = await registerAndResolveQr(asset.id);
        const actions = (resolution as { available: { actions: string[] } })
          .available.actions;
        for (const token of ALL_ACTIONS) {
          assert.ok(
            !actions.includes(token),
            `QR actions must not include ${token}`,
          );
        }
      }

      // Contract: the QR documented operations never reference the RN-10
      // action schema.
      for (const [path, operations] of Object.entries(spec.paths)) {
        if (!/qr|resolve/.test(path)) continue;
        const text = JSON.stringify(operations);
        for (const token of ALL_ACTIONS) {
          assert.equal(
            text.includes(token),
            false,
            `${path} must not carry the RN-10 token ${token}`,
          );
        }
      }
    });

    it('44. no new mobile mutation route is documented', () => {
      for (const [path, operations] of Object.entries(spec.paths)) {
        if (!path.startsWith('/mobile/')) continue;
        for (const [method, operation] of Object.entries(
          operations as Record<string, any>,
        )) {
          const mutating = ['post', 'patch', 'put', 'delete'].includes(method);
          const rn10 =
            /operational-state|out[-_]?of[-_]?service|isolate|shutdown|return[-_]?to[-_]?service/i;
          if (mutating) {
            assert.equal(
              rn10.test(path),
              false,
              `${method.toUpperCase()} ${path} must not be documented`,
            );
            assert.equal(
              rn10.test(String(operation.operationId)),
              false,
              `operationId ${operation.operationId} must not be documented`,
            );
          }
          // The one documented mobile operational-state operation is a read.
          if (rn10.test(path)) {
            assert.equal(method, 'get', `${path} may only be a GET`);
          }
        }
      }
    });

    it('45. every ref introduced by the operation and its schemas resolves', () => {
      const refs: string[] = [];
      JSON.stringify(
        {
          path: spec.paths[MOBILE_PATH],
          schemas: {
            MobileAssetOperationalAction:
              spec.components?.schemas?.MobileAssetOperationalAction,
            MobileAssetOperationalStateView:
              spec.components?.schemas?.MobileAssetOperationalStateView,
          },
        },
        (_key, value) => {
          if (_key === '$ref') refs.push(value as string);
          return value;
        },
      );
      assert.ok(refs.length > 0, 'the operation must reference schemas');
      for (const ref of new Set(refs)) {
        let cursor: any = spec;
        for (const part of ref.replace(/^#\//, '').split('/')) {
          cursor = cursor?.[part];
        }
        assert.ok(cursor, `${ref} must resolve`);
      }
    });

    it('46. the unsafe-report idempotency contract remains intact', () => {
      const operation =
        spec.paths?.['/mobile/assets/{assetId}/unsafe-condition']?.post;
      assert.ok(operation, 'the PART 01 mobile report must stay documented');
      assert.equal(operation.operationId, 'reportMobileUnsafeCondition');
      assert.equal(operation['x-required-permission'], 'asset_failure.report');
      const parameters = (operation.parameters as any[]) ?? [];
      const headerRef = parameters.find(
        (parameter) =>
          String(parameter.$ref ?? '').includes('RequestIdempotencyKeyHeader'),
      );
      assert.ok(
        headerRef,
        'the Idempotency-Key header parameter must remain documented',
      );
      assert.match(String(operation.description), /Idempotency-Key/);
    });
  });

  describe('47. the permission seed', () => {
    it('asset_operational_state.read is seeded and granted by the PLATFORM_ADMIN convention', () => {
      const entry = FOUNDATION_PERMISSIONS.find(
        (permission) => permission.code === 'asset_operational_state.read',
      );
      assert.ok(
        entry,
        'asset_operational_state.read must be in FOUNDATION_PERMISSIONS',
      );
      assert.ok(entry.name.length > 0);
      // Not the exceptional authority class: the foundation seed grants it
      // to PLATFORM_ADMIN, and application roles take it from policy.
      assert.equal(
        UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('asset_operational_state.read'),
        false,
      );
    });
  });
});
