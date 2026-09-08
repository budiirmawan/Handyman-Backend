import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';
import {
  MOBILE_SYNC_OPERATIONS,
  MOBILE_SYNC_RESOURCE_TYPES,
} from '../src/modules/mobile-sync/mobile-sync.types';
import {
  OPERATIONS_BY_TYPE,
  PUBLISHED_OPERATION_BY_TYPE,
} from '../src/modules/mobile-sync/mobile-sync.service';

/**
 * CR-BE-MOB-01 PART 06 — sync resource-kind extension.
 *
 * Guards, for SUPPORTED kinds:
 *  - the documented enum equals the implemented MOBILE_SYNC_RESOURCE_TYPES;
 *  - every kind maps to a stable, PUBLISHED operationId and to the same
 *    permission its REST route enforces;
 *  - every kind is wired end-to-end (permission + allowed operations +
 *    dispatcher + reload endpoint) — no half-registered kind;
 *  - no new operation verb was introduced.
 *
 * Guards, for UNSUPPORTED kinds:
 *  - they are absent from the implemented constant AND the documented enum,
 *    so an offline record with no authoritative backend write can never be
 *    advertised as syncable;
 *  - each is documented with a status + reason + an existing operation to use
 *    instead;
 *  - no generic catch-all kind, no evidence-byte queue.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;
const syncOp = spec.paths['/mobile/sync'].post;
const itemSchema = spec.components.schemas.MobileSyncOperationItem;

function readSource(relative: string): string {
  return readFileSync(resolve(__dirname, '..', relative), 'utf8');
}

function publishedOperationIds(): Set<string> {
  const ids = new Set<string>();
  for (const item of Object.values<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (op?.operationId) ids.add(op.operationId);
    }
  }
  return ids;
}

/** Kinds BE-25G shipped with; PART 06 must not alter their behaviour. */
const PRE_EXISTING_KINDS = [
  'TASK_EXECUTION',
  'CHECKLIST_RESPONSES',
  'EVIDENCE_SUBMISSION',
  'TASK_ASSIGNMENT',
];

/** Kinds added by PART 06 over already-published authoritative writes. */
const PART_06_KINDS = ['PATROL_EXECUTION', 'PATROL_POINT_VISIT', 'METER_READING'];

describe('CR-BE-MOB-01 PART 06 — supported sync resource kinds', () => {
  it('preserves the BE-25G kinds and their operations exactly', () => {
    for (const kind of PRE_EXISTING_KINDS) {
      assert.ok(
        (MOBILE_SYNC_RESOURCE_TYPES as readonly string[]).includes(kind),
        `${kind} must remain supported`,
      );
    }
    assert.deepEqual(OPERATIONS_BY_TYPE.TASK_EXECUTION, [
      'START',
      'COMPLETE',
      'CANCEL',
    ]);
    assert.deepEqual(OPERATIONS_BY_TYPE.CHECKLIST_RESPONSES, ['SAVE']);
    assert.deepEqual(OPERATIONS_BY_TYPE.EVIDENCE_SUBMISSION, ['SUBMIT']);
    assert.deepEqual(OPERATIONS_BY_TYPE.TASK_ASSIGNMENT, ['UPDATE']);
  });

  it('adds exactly the PART 06 kinds', () => {
    assert.deepEqual(
      [...MOBILE_SYNC_RESOURCE_TYPES],
      [...PRE_EXISTING_KINDS, ...PART_06_KINDS],
    );
    assert.deepEqual(OPERATIONS_BY_TYPE.PATROL_EXECUTION, ['START', 'COMPLETE']);
    assert.deepEqual(OPERATIONS_BY_TYPE.PATROL_POINT_VISIT, ['SUBMIT']);
    assert.deepEqual(OPERATIONS_BY_TYPE.METER_READING, ['SUBMIT']);
  });

  it('introduces no new operation verb', () => {
    assert.deepEqual(
      [...MOBILE_SYNC_OPERATIONS],
      ['START', 'COMPLETE', 'CANCEL', 'SAVE', 'SUBMIT', 'UPDATE'],
    );
    for (const operations of Object.values(OPERATIONS_BY_TYPE)) {
      for (const operation of operations) {
        assert.ok(
          (MOBILE_SYNC_OPERATIONS as readonly string[]).includes(operation),
          `${operation} is not a declared sync verb`,
        );
      }
    }
    assert.deepEqual(
      itemSchema.properties.operation.enum,
      [...MOBILE_SYNC_OPERATIONS],
    );
  });

  it('documents exactly the implemented resource kinds', () => {
    assert.deepEqual(
      itemSchema.properties.resourceType.enum,
      [...MOBILE_SYNC_RESOURCE_TYPES],
      'the documented enum must equal the implemented constant',
    );
    assert.deepEqual(
      syncOp['x-sync-supported-resource-types'].map((e: any) => e.resourceType),
      [...MOBILE_SYNC_RESOURCE_TYPES],
    );
  });

  it('maps every kind to a published, stable operationId', () => {
    const published = publishedOperationIds();
    for (const entry of syncOp['x-sync-supported-resource-types']) {
      const kind = entry.resourceType as keyof typeof OPERATIONS_BY_TYPE;
      assert.deepEqual(
        entry.operations,
        [...OPERATIONS_BY_TYPE[kind]],
        `${kind}: documented operations differ from the dispatcher`,
      );
      const implementedIds = Object.values(PUBLISHED_OPERATION_BY_TYPE[kind]);
      assert.deepEqual(
        entry.operationIds,
        implementedIds,
        `${kind}: documented operationIds differ from the implementation map`,
      );
      for (const operationId of entry.operationIds) {
        assert.ok(
          published.has(operationId),
          `${kind} points at unpublished operationId ${operationId}`,
        );
      }
      assert.equal(
        Object.keys(PUBLISHED_OPERATION_BY_TYPE[kind]).sort().join(','),
        [...OPERATIONS_BY_TYPE[kind]].sort().join(','),
        `${kind}: every allowed operation needs a published operationId`,
      );
    }
  });

  it('enforces the same RBAC permission as the published REST route', () => {
    const service = readSource('src/modules/mobile-sync/mobile-sync.service.ts');
    const documented = new Map<string, string>(
      syncOp['x-sync-supported-resource-types'].map((e: any) => [
        e.resourceType,
        e.permission,
      ]),
    );
    // The dispatcher's REQUIRED_PERMISSION block must agree with the docs.
    const block = /REQUIRED_PERMISSION[^=]*=\s*\{([\s\S]*?)\n\};/.exec(service);
    assert.ok(block, 'REQUIRED_PERMISSION map not found');
    for (const [kind, permission] of documented) {
      assert.match(
        block[1],
        new RegExp(`${kind}:\\s*'${permission.replace('.', '\\.')}'`),
        `${kind} must require ${permission} in the sync dispatcher`,
      );
    }
    // Spot-check against the routes that own each PART 06 kind.
    assert.match(
      readSource('src/modules/patrol-executions/patrol-execution.routes.ts'),
      /requirePermission\('patrol_execution\.manage'\)/,
    );
    assert.match(
      readSource(
        'src/modules/meter-reading-bindings/meter-reading-binding.routes.ts',
      ),
      /requirePermission\('meter_reading_binding\.manage'\)/,
    );
  });

  it('wires every kind end-to-end (permission, dispatcher, reload target)', () => {
    const service = readSource('src/modules/mobile-sync/mobile-sync.service.ts');
    const conflict = readSource('src/modules/mobile-sync/mobile-sync-conflict.ts');
    for (const kind of MOBILE_SYNC_RESOURCE_TYPES) {
      assert.match(
        service,
        new RegExp(`case '${kind}':`),
        `${kind} has no dispatcher case`,
      );
      assert.match(
        conflict,
        new RegExp(`${kind}:`),
        `${kind} has no reload endpoint entry`,
      );
      assert.match(
        conflict,
        new RegExp(`case '${kind}':`),
        `${kind} has no conflict-detection case`,
      );
    }
  });

  it('delegates PART 06 kinds to the existing domain services', () => {
    const service = readSource('src/modules/mobile-sync/mobile-sync.service.ts');
    for (const call of [
      'patrolExecutionService.startPatrolExecution',
      'patrolExecutionService.completePatrolExecution',
      'patrolExecutionService.recordPatrolPointVisit',
      'meterReadingBindingService.submitMeterReading',
    ]) {
      assert.ok(
        service.includes(call),
        `sync must delegate to the existing service ${call}`,
      );
    }
    // No new engine: the sync module must not query the domain tables itself.
    assert.ok(
      !/INSERT\s+INTO\s+(patrol_point_visits|form_responses)/i.test(service),
      'sync must not write domain tables directly',
    );
  });

  it('requires an authoritative payload id for the new kinds', () => {
    const controller = readSource(
      'src/modules/mobile-sync/mobile-sync.controller.ts',
    );
    // The checkpoint is an authoritative BE-12B point id, never fabricated.
    assert.match(controller, /data\.patrolRoutePointId must be a valid UUID/);
    // A meter reading must carry a finite value; UOM/range stay backend-owned.
    assert.match(controller, /data\.value must be a finite number/);
    assert.ok(
      !/uomId|minimumValue|maximumValue/.test(controller),
      'the client must not supply UOM or measurement range',
    );
  });

  it('keeps clientTimestamp required and server time authoritative', () => {
    assert.ok(itemSchema.required.includes('clientTimestamp'));
    assert.ok(
      spec.components.schemas.MobileSyncResultItem.required.includes(
        'serverTimestamp',
      ),
    );
    assert.match(
      readSource('src/modules/mobile-sync/mobile-sync.controller.ts'),
      /clientTimestamp must be an ISO-8601 timestamp string/,
    );
  });
});

describe('CR-BE-MOB-01 PART 06 — unsupported kinds stay local', () => {
  const unsupported = syncOp['x-sync-unsupported-resource-types'];

  it('never advertises a kind the backend cannot execute', () => {
    for (const entry of unsupported) {
      assert.ok(
        !(MOBILE_SYNC_RESOURCE_TYPES as readonly string[]).includes(
          entry.resourceType,
        ),
        `${entry.resourceType} must not be implemented as a sync kind`,
      );
      assert.ok(
        !itemSchema.properties.resourceType.enum.includes(entry.resourceType),
        `${entry.resourceType} must not appear in the documented enum`,
      );
    }
  });

  it('documents a status, reason and existing alternative for each', () => {
    const published = publishedOperationIds();
    assert.ok(unsupported.length >= 5);
    for (const entry of unsupported) {
      assert.ok(
        ['MISSING', 'NOT_REQUIRED'].includes(entry.status),
        `${entry.resourceType} needs an explicit status`,
      );
      assert.ok(
        typeof entry.reason === 'string' && entry.reason.length > 30,
        `${entry.resourceType} needs a documented reason`,
      );
      assert.ok(
        Array.isArray(entry.useInstead) && entry.useInstead.length > 0,
        `${entry.resourceType} must name the online operation to use instead`,
      );
      for (const operationId of entry.useInstead) {
        assert.ok(
          published.has(operationId),
          `${entry.resourceType} points at unpublished ${operationId}`,
        );
      }
    }
  });

  it('rejects create-shaped and catch-all kinds', () => {
    const names = unsupported.map((e: any) => e.resourceType);
    for (const expected of [
      'WORK_ORDER_ACTION',
      'WORK_ORDER_MATERIAL_USAGE',
      'INCIDENT',
      'SECURITY_FINDING',
      'SUPERVISOR_DECISION',
      'EVIDENCE_BYTES',
    ]) {
      assert.ok(names.includes(expected), `${expected} must be documented`);
    }
    for (const forbidden of ['GENERIC', 'ANY', 'CUSTOM', 'OTHER']) {
      assert.ok(
        !(MOBILE_SYNC_RESOURCE_TYPES as readonly string[]).includes(forbidden),
        'no generic catch-all sync kind may exist',
      );
    }
  });

  it('keeps evidence bytes out of the sync contract', () => {
    const evidenceBytes = unsupported.find(
      (e: any) => e.resourceType === 'EVIDENCE_BYTES',
    );
    assert.equal(evidenceBytes.status, 'NOT_REQUIRED');
    assert.match(
      String(itemSchema.properties.data.description),
      /Evidence BYTES are never carried here/,
    );
  });
});

describe('PART 06 preserves the sync envelope and its guarantees', () => {
  it('keeps one batch endpoint with idempotency and conflict handling', () => {
    const syncPaths = Object.keys(spec.paths).filter((p: string) =>
      p.startsWith('/mobile/sync'),
    );
    assert.deepEqual(syncPaths, ['/mobile/sync']);
    assert.equal(syncOp.operationId, 'processSyncBatch');
    assert.equal(spec.components.schemas.MobileSyncBatchRequest.properties.operations.maxItems, 100);
    const service = readSource('src/modules/mobile-sync/mobile-sync.service.ts');
    assert.ok(service.includes('findStoredOperation'), 'BE-25H idempotency preserved');
    assert.ok(service.includes('detectConflict'), 'BE-25I conflict handling preserved');
    assert.ok(
      service.includes('resolvePermissionsForUser'),
      'per-batch RBAC resolution preserved',
    );
  });

  it('requires authentication for the batch endpoint', async () => {
    const response = await api()
      .post(`${API_PREFIX}/mobile/sync`)
      .send({ operations: [] });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});
