import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import {
  MOBILE_VERIFICATION_TARGET_TYPES,
} from '../src/modules/mobile-verification/mobile-verification.types';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-03 PART 05 — Work Order mobile verification target (WO-04).
 *
 * Adds WORK_ORDER as a supported target of the existing BE-25J
 * /mobile/verification workflow, delegating to the existing BE-08I
 * verification lifecycle. Documentation-only checks (no database):
 *  - the documented target-type enum equals the implemented constant
 *    (WORK_ORDER included; the original three preserved);
 *  - the WORK_ORDER branch requires the existing `work_order.read` /
 *    `work_order.manage` permissions (RBAC preserved — no new permission);
 *  - the mobile verification path is unchanged (no /mobile/work-order-verification
 *    facade, no duplicate operationId, no new route);
 *  - the resource reference schema carries the authoritative `workOrder`
 *    reference (work_orders.id, workOrderNumber, title, status);
 *  - the documented decision vocabulary stays the shared review vocabulary
 *    (APPROVED / REJECTED / REWORK_REQUIRED);
 *  - no fabricated local id appears in the mobile verification schemas;
 *  - unauthenticated calls are rejected by auth middleware (401, never 404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

describe('CR-BE-MOB-03 PART 05 — Work Order mobile verification target', () => {
  it('accepts WORK_ORDER and preserves the existing target types (documented enum == implemented constant)', () => {
    const param = spec.components.parameters.VerificationTargetTypeParam;
    assert.ok(param, 'VerificationTargetTypeParam must exist');
    const enums = param.schema.enum ?? [];
    assert.deepEqual(
      [...enums].sort(),
      [...MOBILE_VERIFICATION_TARGET_TYPES].sort(),
      'documented target types must equal the implemented MOBILE_VERIFICATION_TARGET_TYPES',
    );
    assert.ok(enums.includes('WORK_ORDER'), 'WORK_ORDER must be a supported target');
    assert.ok(enums.includes('CHECKLIST_EXECUTION'), 'CHECKLIST_EXECUTION preserved');
    assert.ok(enums.includes('FORM_INSTANCE'), 'FORM_INSTANCE preserved');
    assert.ok(enums.includes('FINDING'), 'FINDING preserved');
    // The contract schema must carry the same enum.
    const schemaEnum =
      spec.components.schemas.MobileVerification?.properties?.targetType?.enum ?? [];
    assert.deepEqual(
      [...schemaEnum].sort(),
      [...MOBILE_VERIFICATION_TARGET_TYPES].sort(),
      'MobileVerification.targetType enum must match the implemented constant',
    );
  });

  it('preserves RBAC — the WORK_ORDER branch reuses the existing work_order permissions', () => {
    const seeded = new Set(FOUNDATION_PERMISSIONS.map((p) => p.code));
    // No new permission is introduced: WORK_ORDER read/manage map to the
    // existing BE-08 codes enforced by the Web endpoints.
    assert.ok(seeded.has('work_order.read'), 'work_order.read must be seeded');
    assert.ok(seeded.has('work_order.manage'), 'work_order.manage must be seeded');
    // The three original target permissions stay seeded too.
    assert.ok(seeded.has('review.read'));
    assert.ok(seeded.has('review.manage'));
    assert.ok(seeded.has('finding.read'));
    assert.ok(seeded.has('finding.review'));
  });

  it('reuses the existing /mobile/verification route — no duplicate endpoint, no facade', () => {
    // The only mobile verification paths are the GET+POST pair on the
    // original route; no /mobile/work-order-verification facade exists.
    const mobileVerificationPaths = Object.keys(spec.paths ?? {}).filter((p) =>
      p.startsWith('/mobile/') && p.includes('verification'),
    );
    assert.deepEqual(
      mobileVerificationPaths.sort(),
      ['/mobile/verification/{targetType}/{targetId}'],
      'no /mobile/work-order-verification facade may exist',
    );
    // No duplicate operationId anywhere.
    const allOpIds = new Set<string>();
    const duplicates: string[] = [];
    for (const [p, methods] of Object.entries<any>(spec.paths ?? {})) {
      for (const [m, op] of Object.entries<any>(methods)) {
        if (!op?.operationId) continue;
        if (allOpIds.has(op.operationId)) duplicates.push(`${op.operationId} (${p})`);
        allOpIds.add(op.operationId);
      }
    }
    assert.deepEqual(duplicates, [], 'no duplicate operationId may exist');
  });

  it('carries the authoritative WORK_ORDER resource reference in the contract schema', () => {
    const resource = spec.components.schemas.MobileVerificationResource;
    assert.ok(resource, 'MobileVerificationResource must exist');
    assert.ok(
      resource.required.includes('workOrder'),
      'resource must require the workOrder reference',
    );
    const wo = resource.properties.workOrder;
    assert.equal(wo.type, 'object');
    assert.deepEqual(
      [...(wo.required ?? [])].sort(),
      ['id', 'status', 'title', 'workOrderNumber'].sort(),
    );
    assert.equal(wo.properties.id.description, 'Authoritative `work_orders.id`.');
    // No fabricated local id anywhere in the mobile verification schemas.
    for (const schemaName of [
      'MobileVerification',
      'MobileVerificationResource',
      'MobileVerificationState',
    ]) {
      const text = JSON.stringify(spec.components.schemas[schemaName] ?? {});
      for (const forbidden of ['localId', 'tempId', 'clientGeneratedId']) {
        assert.ok(!text.includes(forbidden), `${schemaName} must not contain ${forbidden}`);
      }
    }
  });

  it('keeps the shared decision vocabulary for the WORK_ORDER submission', () => {
    const post = spec.paths['/mobile/verification/{targetType}/{targetId}'].post;
    const decision = post.requestBody.content['application/json'].schema.properties.decision;
    assert.deepEqual(
      [...(decision.enum ?? [])].sort(),
      ['APPROVED', 'REJECTED', 'REWORK_REQUIRED'].sort(),
      'the decision vocabulary must remain the shared review vocabulary',
    );
    // The verification state schema decision enum matches too.
    const stateDecision =
      spec.components.schemas.MobileVerificationState?.properties?.decision?.enum ?? [];
    assert.deepEqual(
      [...stateDecision].sort(),
      ['APPROVED', 'REJECTED', 'REWORK_REQUIRED'].sort(),
    );
  });

  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const response = await request.get(
      `${API_PREFIX}/mobile/verification/WORK_ORDER/00000000-0000-4000-8000-000000000001`,
    );
    assert.notEqual(response.status, 404, 'must be registered (got 404)');
    assert.equal(response.status, 401, 'must require authentication');
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});
