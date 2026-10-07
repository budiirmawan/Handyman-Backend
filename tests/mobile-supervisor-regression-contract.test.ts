import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { MOBILE_VERIFICATION_TARGET_TYPES } from '../src/modules/mobile-verification/mobile-verification.types';

/**
 * CR-BE-MOB-03 PART 06 — Cross-Contract Regression & Supervisor Handoff.
 *
 * One suite that re-validates the COMPLETE supervisor mobile backend
 * contract after PART 01–05, together with the CR-BE-MOB-01 / CR-BE-MOB-02
 * surfaces the supervisor workflows depend on. It asserts the exact
 * confirmations the CR must be able to make at handoff:
 *
 *   OpenAPI/runtime parity   — every documented operation is registered,
 *                              unique operationIds, all $refs resolve,
 *                              RBAC + Building-scope metadata on the
 *                              supervisor-published surface, no duplicate
 *                              mobile domain facade;
 *   Supervisor authority     — the entry points a Teknisi supervisor and a
 *                              Cleaning Service supervisor consume are
 *                              published (annotated surfaces carry their
 *                              exact permission + scope; the earlier
 *                              CR-BE-MOB-CONTRACT-01 core surface is
 *                              asserted published);
 *   Lifecycle authorities    — Work Order, Finding/Rework, Engineering
 *                              verification, Housekeeping inspection,
 *                              Security handover and WORK_ORDER mobile
 *                              verification remain intact.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const ROUTES_DIR = resolve(__dirname, '../src/routes');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

type Operation = { path: string; method: string; op: any };

function operations(): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

function normalize(path: string): string {
  return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p').replace(/\{[^}]+\}/g, ':p');
}

function registeredRoutes(): Set<string> {
  const set = new Set<string>();
  const pattern = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.routes.ts')) continue;
      const source = readFileSync(full, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        set.add(`${match[1].toUpperCase()} ${normalize(match[2])}`);
      }
    }
  }
  walk(MODULES_DIR);
  walk(ROUTES_DIR);
  return set;
}

const SEEDED_PERMISSIONS = new Set(
  FOUNDATION_PERMISSIONS.map((permission) => permission.code),
);

const byOperationId = new Map(
  operations().map(({ path, method, op }) => [op.operationId, { path, method, op }]),
);

/** Asserts an operation is published (the core CR-BE-MOB-CONTRACT-01 surface). */
function expectPublished(operationId: string): void {
  const entry = byOperationId.get(operationId);
  assert.ok(entry, `${operationId} must stay published`);
}

/** Asserts an operation is published with the given permission + scope flag. */
function expectOperation(
  operationId: string,
  permission: string,
  scoped: boolean,
): void {
  const entry = byOperationId.get(operationId);
  assert.ok(entry, `${operationId} must stay published`);
  assert.equal(
    entry.op['x-required-permission'],
    permission,
    `${operationId} must require ${permission}`,
  );
  if (scoped) {
    assert.equal(
      entry.op['x-building-scoped'],
      true,
      `${operationId} must be building-scoped`,
    );
  } else {
    assert.notEqual(
      entry.op['x-building-scoped'],
      true,
      `${operationId} must not claim x-building-scoped`,
    );
  }
}

describe('CR-BE-MOB-03 PART 06 — cross-CR regression (supervisor contract)', () => {
  it('OpenAPI/runtime parity — every documented operation is registered', () => {
    const registered = registeredRoutes();
    const phantom: string[] = [];
    for (const { path, method, op } of operations()) {
      const key = `${method.toUpperCase()} ${normalize(path)}`;
      if (!registered.has(key)) phantom.push(`${op.operationId} (${key})`);
    }
    assert.deepEqual(phantom, [], 'no documented operation may be unregistered');
  });

  it('OpenAPI/runtime parity — unique operationIds and resolvable $refs', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const { op } of operations()) {
      if (!op.operationId) continue;
      if (seen.has(op.operationId)) duplicates.push(op.operationId);
      seen.add(op.operationId);
    }
    assert.deepEqual(duplicates, []);
    const known = new Set([
      ...Object.keys(spec.components.schemas ?? {}),
      ...Object.keys(spec.components.responses ?? {}),
      ...Object.keys(spec.components.parameters ?? {}),
    ]);
    const unresolved: string[] = [];
    (function walk(node: unknown): void {
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref') {
            const target = String(value).split('/').pop()!;
            if (!known.has(target)) unresolved.push(String(value));
          } else {
            walk(value);
          }
        }
      }
    })(spec);
    assert.deepEqual(unresolved, []);
  });

  it('no duplicate mobile domain facade exists', () => {
    const facades = Object.keys(spec.paths).filter((p: string) =>
      /\/mobile\/(housekeeping|security|engineering|material|inventory|work-order|patrol|incident|push-send)/.test(
        p,
      ),
    );
    assert.deepEqual(facades, [], 'no mobile-specific domain API may exist');
    // The only mobile-domain-looking endpoints are the legitimate BE-25M/N
    // self-service reads and the verification target route.
    assert.ok(spec.paths['/mobile/current-shift'], 'current-shift is a BE-25M endpoint, not a facade');
    assert.ok(spec.paths['/mobile/my-team'], 'my-team is a BE-25N endpoint, not a facade');
  });

  it('RBAC + Building-scope metadata — any annotated permission is seeded and scope flags are boolean', () => {
    const unknown: string[] = [];
    const badScope: string[] = [];
    for (const { op } of operations()) {
      const code = op['x-required-permission'];
      // processSyncBatch documents a per-resourceType dispatch (BE-25G),
      // not a single permission — a pre-existing descriptive value.
      if (
        code !== undefined &&
        code !== 'per-resourceType (see x-sync-supported-resource-types)' &&
        !SEEDED_PERMISSIONS.has(code)
      ) {
        unknown.push(`${op.operationId} -> ${code}`);
      }
      const scope = op['x-building-scoped'];
      if (scope !== undefined && typeof scope !== 'boolean') {
        badScope.push(`${op.operationId}`);
      }
    }
    assert.deepEqual(unknown, [], 'documented permission must be a seeded code');
    assert.deepEqual(badScope, [], 'x-building-scoped must be a boolean when present');
  });
});

describe('CR-BE-MOB-03 PART 06 — supervisor authority boundaries', () => {
  it('Supervisor Teknisi — engineering + technician + team + verification entry points', () => {
    expectOperation('listTeamWorkOrders', 'work_order.read', true);
    expectOperation('getEngineeringDailyOperations', 'engineering.read', true);
    expectOperation('getEngineeringOverview', 'engineering_overview.read', true);
    expectOperation('getEngineeringReportTechnicalSummary', 'engineering_report.read', true);
    expectOperation('getEngineeringReportFindings', 'engineering_report.read', true);
    expectOperation('getCorrectiveActionVerificationContext', 'corrective_action_verification.read', true);
    expectOperation('submitCorrectiveActionVerification', 'corrective_action_verification.manage', true);
    expectOperation('getWorkforceKpi', 'workforce_kpi.read', true);
    expectOperation('listWorkforceReporting', 'workforce.read', true);
    // Core CR-BE-MOB-CONTRACT-01 surface (published, not re-annotated).
    expectPublished('listBuildingWorkOrders');
    expectPublished('getWorkOrder');
    expectPublished('getWorkOrderVerification');
    expectPublished('submitWorkOrderVerification');
    expectPublished('getMobileVerification');
    expectPublished('submitMobileVerification');
  });

  it('Supervisor Cleaning Service — housekeeping + inspection + evidence + reports', () => {
    expectOperation('listBuildingDailyCleaning', 'daily_cleaning.read', true);
    expectOperation('listTeamDailyCleaning', 'cleaning_assignment.read', true);
    expectOperation('listConsumableRequirements', 'consumable_readiness.read', true);
    expectOperation('listBuildingHousekeepingConsumableBindings', 'consumable_readiness.read', true);
    expectOperation('listHousekeepingComplaintBindings', 'housekeeping_complaint.read', true);
    expectOperation('submitSupervisorInspectionDecision', 'supervisor_inspection.manage', true);
    expectOperation('completeQualityAudit', 'quality_audit.manage', true);
    expectOperation('listHousekeepingEvidence', 'housekeeping_evidence.read', true);
    expectOperation('submitHousekeepingEvidence', 'housekeeping_evidence.manage', true);
    expectOperation('getHousekeepingReportSummary', 'housekeeping_report.read', true);
    expectOperation('getHousekeepingReportSupervisorInspections', 'housekeeping_report.read', true);
    expectOperation('listHousekeepingFindings', 'housekeeping_finding.read', true);
  });

  it('team/member scope — My Team context and team-scoped reads', () => {
    expectOperation('listTeamWorkOrders', 'work_order.read', true);
    expectOperation('listTeamDailyCleaning', 'cleaning_assignment.read', true);
    expectOperation('listWorkforceDailyCleaning', 'cleaning_assignment.read', true);
    expectOperation('listWorkforceDirectReports', 'workforce.read', false);
    expectOperation('getWorkforceCurrentSupervisor', 'workforce.read', false);
    // My Team + Current Shift are auth-only self-service (no permission code).
    const myTeam = byOperationId.get('getMobileMyTeam');
    assert.ok(myTeam, 'getMobileMyTeam must stay published');
    assert.equal(myTeam.op['x-required-permission'], undefined, 'my-team is auth-only self-service');
    expectPublished('listTeamTasks');
    expectPublished('listWorkforceTasks');
  });

  it('accessible Building scope — Building-scoped reads stay scoped', () => {
    // Annotated supervisor reads carry x-building-scoped: true.
    expectOperation('listBuildingDailyCleaning', 'daily_cleaning.read', true);
    expectOperation('getWorkforceKpi', 'workforce_kpi.read', true);
    expectOperation('listWorkforceReporting', 'workforce.read', true);
    expectOperation('getEngineeringDailyOperations', 'engineering.read', true);
    expectOperation('getEngineeringOverview', 'engineering_overview.read', true);
    expectOperation('listTeamWorkOrders', 'work_order.read', true);
    expectOperation('listBuildingHousekeepingConsumableBindings', 'consumable_readiness.read', true);
    // The core CR-BE-MOB-CONTRACT-01 surface is published (isolated at
    // runtime; not re-annotated in this CR).
    expectPublished('listBuildingWorkOrders');
    expectPublished('getWorkOrder');
    expectPublished('listMobileAssignments');
    // Current Shift is auth-only self-service, not claimed as building-scoped.
    expectPublished('getMobileCurrentShift');
  });

  it('authoritative backend IDs — no client-generated id in any published schema', () => {
    const banned = /^(localId|tempId|clientId_local|clientGeneratedId|offlineId|fakeId|mockId)$/;
    const offenders: string[] = [];
    for (const [name, schema] of Object.entries<any>(spec.components.schemas)) {
      for (const property of Object.keys(schema.properties ?? {})) {
        if (banned.test(property)) offenders.push(`${name}.${property}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('CR-BE-MOB-03 PART 06 — lifecycle authorities unchanged', () => {
  it('Work Order lifecycle — create/read/update/complete/verify/close intact', () => {
    // Core surface (published; lifecycle unchanged since CR-BE-MOB-CONTRACT-01).
    for (const id of [
      'createWorkOrder',
      'getWorkOrder',
      'updateWorkOrder',
      'completeWorkOrder',
      'getWorkOrderVerification',
      'submitWorkOrderVerification',
      'closeWorkOrderAfterCanonicalBastReadiness',
      'listWorkOrderActions',
      'getWorkOrderCompletion',
    ]) {
      expectPublished(id);
    }
    // PART 04 team-scoped read + PART 05 WORK_ORDER verification target.
    expectOperation('listTeamWorkOrders', 'work_order.read', true);
    assert.ok(
      (MOBILE_VERIFICATION_TARGET_TYPES as readonly string[]).includes('WORK_ORDER'),
      'WORK_ORDER must be an implemented mobile verification target',
    );
    const param = spec.components.parameters.VerificationTargetTypeParam;
    assert.deepEqual(
      param.schema.enum,
      [...MOBILE_VERIFICATION_TARGET_TYPES],
      'documented /mobile/verification targets must equal the implemented set',
    );
    const resource = spec.components.schemas.MobileVerificationResource;
    assert.ok(resource.required.includes('workOrder'));
    assert.equal(
      resource.properties.workOrder.properties.id.description,
      'Authoritative `work_orders.id`.',
    );
  });

  it('Finding / Rework lifecycle — BE-09 operations intact', () => {
    for (const id of [
      'createFinding',
      'getFinding',
      'updateFinding',
      'listFindings',
      'requestFindingRework',
      'updateFindingReworkNotes',
      'rejectFinding',
      'resubmitFinding',
      'submitFindingVerification',
      'openFindingReview',
      'getFindingAvailableActions',
      'closeFinding',
    ]) {
      expectPublished(id);
    }
    // Housekeeping finding binding (PART 01 annotated surface).
    expectOperation('createHousekeepingFinding', 'housekeeping_finding.manage', true);
  });

  it('Engineering verification — field/reading/verification surface intact', () => {
    for (const [id, perm] of [
      ['startInspectionExecution', 'inspection_binding.manage'],
      ['submitMeterReading', 'meter_reading_binding.manage'],
      ['startLogSheetExecution', 'log_sheet_binding.manage'],
      ['getEngineeringShiftHandover', 'shift_handover.read'],
      ['acknowledgeEngineeringShiftHandover', 'shift_handover.manage'],
      ['getEngineeringReportBreakdowns', 'engineering_report.read'],
      ['getEngineeringReportMaintenance', 'engineering_report.read'],
    ] as const) {
      expectOperation(id, perm, true);
    }
    expectPublished('getWorkOrderVerification');
  });

  it('Housekeeping inspection — bind/start/decision/audit intact', () => {
    for (const [id, perm, scope] of [
      ['startToiletInspectionExecution', 'toilet_inspection.manage', true],
      ['startPublicAreaInspectionExecution', 'public_area_inspection.manage', true],
      ['submitSupervisorInspectionDecision', 'supervisor_inspection.manage', true],
      ['completeQualityAudit', 'quality_audit.manage', true],
      ['createSupervisorInspection', 'supervisor_inspection.manage', true],
    ] as const) {
      expectOperation(id, perm, scope);
    }
  });

  it('Security handover — BE-12G binding + dataset intact', () => {
    for (const [id, perm, scope] of [
      ['createSecurityShiftHandoverBinding', 'security_shift_handover.manage', true],
      ['getSecurityShiftHandoverBinding', 'security_shift_handover.read', true],
      ['listSecurityShiftHandoverDataset', 'security_report.read', true],
      ['listBuildingSecurityShiftHandoverBindings', 'security_shift_handover.read', true],
    ] as const) {
      expectOperation(id, perm, scope);
    }
  });

  it('WORK_ORDER mobile verification — regression of the three original targets', () => {
    const param = spec.components.parameters.VerificationTargetTypeParam;
    const enums = param.schema.enum;
    for (const original of ['CHECKLIST_EXECUTION', 'FORM_INSTANCE', 'FINDING']) {
      assert.ok(enums.includes(original), `${original} must remain a verification target`);
    }
    assert.ok(enums.includes('WORK_ORDER'), 'WORK_ORDER must be a verification target');
    // The mobile verification path still dispatches by target type — unknown
    // ids yield 404 (handled at runtime); the route itself is the one pair.
    const mobileVerificationPaths = Object.keys(spec.paths).filter(
      (p: string) => p.startsWith('/mobile/verification'),
    );
    assert.deepEqual(
      mobileVerificationPaths,
      ['/mobile/verification/{targetType}/{targetId}'],
    );
  });
});
