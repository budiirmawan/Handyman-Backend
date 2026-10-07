import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Express } from 'express';

// Enable WhatsApp callback router in environment before createApp() so full runtime is mounted
process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_META_APP_SECRET = 'test-secret';
process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = 'test-token';

import { createApp } from '../src/app';

/**
 * INT-LC-19-BE PART 08 — Schedules & Task Recurrence OpenAPI Closure.
 *
 * Scope:
 *   - schedules (4 routes)
 *   - schedule recurrence (4 routes)
 *   - task generation (1 route)
 * Total undocumented routes: exact 9.
 *
 * Required proofs:
 *  1. 9/9 documented
 *  2. Scoped gap 0
 *  3. No speculative routes
 *  4. Unique operationIds
 *  5. Broken refs 0
 *  6. Permission/scope/schema parity
 *  7. Canonical 401 where authenticated
 *  8. /platform/* untouched (69/69)
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

function normalizePath(p: string): string {
  return (
    p
      .replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
      .replace(/\{([a-zA-Z0-9_]+)\}/g, '{p}')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '') || '/'
  );
}

function walkRouter(
  stack: unknown,
  prefix = '',
): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const s = stack as Array<{
    route?: { path?: string; methods?: Record<string, unknown> };
    handle?: { stack?: unknown[]; regexp?: { source?: string } };
    matchers?: Array<(input: string) => boolean | object>;
  }>;
  for (const layer of s ?? []) {
    if (layer.route?.path) {
      const full = prefix + layer.route.path || '/';
      for (const m of Object.keys(layer.route.methods ?? {})) {
        if (m === '_all') continue;
        out.push({ method: m.toUpperCase(), path: full });
      }
    } else if (layer.handle?.stack) {
      let layerPrefix = prefix;
      if (layer.matchers?.[0]?.('/webhooks/notifications/whatsapp')) {
        layerPrefix = '/webhooks/notifications/whatsapp';
      }
      out.push(...walkRouter(layer.handle.stack, layerPrefix));
    }
  }
  return out;
}

const SCOPED_OPERATIONS: Record<
  string,
  {
    module: string;
    operationId: string;
    permission: string;
    summary: string;
  }
> = {
  // schedule.routes.ts (4)
  'POST /schedules': {
    module: 'schedules',
    operationId: 'createSchedule',
    permission: 'schedule.manage',
    summary: 'Create a schedule definition',
  },
  'GET /schedules': {
    module: 'schedules',
    operationId: 'listSchedules',
    permission: 'schedule.read',
    summary: 'List schedule definitions',
  },
  'GET /schedules/{id}': {
    module: 'schedules',
    operationId: 'getSchedule',
    permission: 'schedule.read',
    summary: 'Get a schedule definition by ID',
  },
  'PATCH /schedules/{id}': {
    module: 'schedules',
    operationId: 'updateSchedule',
    permission: 'schedule.manage',
    summary: 'Update a schedule definition',
  },

  // recurrence.routes.ts (4)
  'POST /schedules/{scheduleId}/recurrence': {
    module: 'schedules',
    operationId: 'createScheduleRecurrence',
    permission: 'schedule.manage',
    summary: 'Create or configure schedule recurrence',
  },
  'GET /schedules/{scheduleId}/recurrence': {
    module: 'schedules',
    operationId: 'getScheduleRecurrence',
    permission: 'schedule.read',
    summary: 'Get recurrence configuration for a schedule',
  },
  'PATCH /schedules/{scheduleId}/recurrence': {
    module: 'schedules',
    operationId: 'updateScheduleRecurrence',
    permission: 'schedule.manage',
    summary: 'Update recurrence configuration for a schedule',
  },
  'GET /schedules/{scheduleId}/occurrences': {
    module: 'schedules',
    operationId: 'previewScheduleOccurrences',
    permission: 'schedule.read',
    summary: 'Preview occurrence dates for a schedule',
  },

  // task.routes.ts (1 generation route)
  'POST /schedules/{scheduleId}/generate-tasks': {
    module: 'tasks',
    operationId: 'generateTasksForSchedule',
    permission: 'task.manage',
    summary: 'Generate tasks for a schedule',
  },
};

describe('INT-LC-19-BE PART 08 — Schedules & Task Recurrence OpenAPI Closure', () => {
  const app = createApp() as Express;
  const runtime = walkRouter(app.router?.stack).map((r) => ({
    ...r,
    canon: normalizePath(r.path),
  }));

  const openapi: Array<{
    method: string;
    path: string;
    canon: string;
    operationId?: string;
    permission?: string;
    responses?: Record<string, any>;
  }> = [];

  for (const [p, methods] of Object.entries(SPEC.paths ?? {})) {
    for (const [m, op] of Object.entries(methods as Record<string, any>)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(m)) {
        openapi.push({
          method: m.toUpperCase(),
          path: p,
          canon: normalizePath(p),
          operationId: op.operationId,
          permission: op['x-required-permission'],
          responses: op.responses,
        });
      }
    }
  }

  // 1. Exactly 9 scoped operations defined in test table
  it('1. exact 9 operations in scoped test table', () => {
    assert.equal(
      Object.keys(SCOPED_OPERATIONS).length,
      9,
      'Scoped operations table must have exactly 9 operations',
    );
  });

  // 2. All 9 scoped operations documented in OpenAPI
  it('2. 9/9 scoped operations documented in OpenAPI', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    const missing: string[] = [];
    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      if (!op) {
        missing.push(key);
      } else {
        assert.equal(
          op.operationId,
          expected.operationId,
          `OperationId mismatch on ${key}: expected ${expected.operationId}, got ${op.operationId}`,
        );
      }
    }

    assert.deepEqual(missing, [], `Missing operations in OpenAPI: ${missing.join(', ')}`);
  });

  // 3. Scoped runtime routes match OpenAPI routes (scoped gap 0)
  it('3. scoped runtime gap is 0', () => {
    const scopedRuntime = runtime.filter((r) => r.path.startsWith('/schedules'));

    assert.equal(
      scopedRuntime.length,
      9,
      'Exact 9 runtime routes under /schedules must exist',
    );

    const openapiByMethodCanon = new Set(openapi.map((o) => `${o.method} ${o.canon}`));
    const unmappedScoped = scopedRuntime.filter(
      (r) => !openapiByMethodCanon.has(`${r.method} ${r.canon}`),
    );

    assert.deepEqual(
      unmappedScoped,
      [],
      `All scoped runtime routes must be documented: ${JSON.stringify(unmappedScoped)}`,
    );
  });

  // 4. No speculative routes in scoped modules
  it('4. no speculative routes in OpenAPI for scoped modules', () => {
    const runtimeByMethodCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));

    for (const [key] of Object.entries(SCOPED_OPERATIONS)) {
      const [method, path] = key.split(' ');
      const canon = normalizePath(path);
      assert.ok(
        runtimeByMethodCanon.has(`${method} ${canon}`),
        `OpenAPI route ${key} must exist in runtime (no speculative routes)`,
      );
    }
  });

  // 5. Unique operationIds across entire OpenAPI spec
  it('5. unique operationIds across the entire OpenAPI document', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const op of openapi) {
      if (!op.operationId) continue;
      if (seen.has(op.operationId)) {
        duplicates.push(
          `${op.operationId} (at ${op.method} ${op.path} and ${seen.get(op.operationId)})`,
        );
      } else {
        seen.set(op.operationId, `${op.method} ${op.path}`);
      }
    }

    assert.deepEqual(duplicates, [], `Duplicate operationIds found: ${duplicates.join(', ')}`);
  });

  // 6. Zero broken $refs in openapi.yaml
  it('6. zero broken $refs in openapi.yaml', () => {
    const buckets: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(SPEC.components ?? {})) {
      buckets[k] = new Set(Object.keys((v as Record<string, unknown>) ?? {}));
    }

    const broken: string[] = [];
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const o = node as Record<string, unknown>;
      if (typeof o['$ref'] === 'string') {
        const ref = o['$ref'];
        if (ref.startsWith('#/components/')) {
          const parts = ref.slice(2).split('/');
          const bucket = parts[1];
          const tail = parts.slice(2).join('/');
          if (!buckets[bucket]?.has(tail)) broken.push(ref);
        }
      }
      for (const v of Object.values(o)) walk(v);
    }
    walk(SPEC);
    assert.deepEqual(broken, [], 'Zero broken $refs allowed');
  });

  // 7. Permission parity exact
  it('7. permission parity exact', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, `Must locate ${key}`);
      assert.equal(
        op.permission,
        expected.permission,
        `Permission mismatch on ${key}: expected ${expected.permission}, got ${op.permission}`,
      );
    }
  });

  // 8. Canonical 401 where authenticated
  it('8. canonical 401 present where authenticated', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    for (const key of Object.keys(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, `Must locate ${key}`);
      assert.ok(op.responses?.['401'], `Operation ${key} must expose canonical 401 response`);
    }
  });

  // 9. Request and response schema parity
  it('9. request/response schema parity', () => {
    const schemas = SPEC.components.schemas;

    assert.ok(schemas.ScheduleTargetType, 'ScheduleTargetType schema must exist');
    assert.ok(schemas.ScheduleDefinitionStatus, 'ScheduleDefinitionStatus schema must exist');
    assert.ok(schemas.ScheduleDefinition, 'ScheduleDefinition schema must exist');
    assert.ok(schemas.CreateScheduleDefinitionRequest, 'CreateScheduleDefinitionRequest schema must exist');
    assert.ok(schemas.UpdateScheduleDefinitionRequest, 'UpdateScheduleDefinitionRequest schema must exist');
    assert.ok(schemas.RecurrenceFrequency, 'RecurrenceFrequency schema must exist');
    assert.ok(schemas.RecurrenceStatus, 'RecurrenceStatus schema must exist');
    assert.ok(schemas.ScheduleRecurrence, 'ScheduleRecurrence schema must exist');
    assert.ok(schemas.SaveScheduleRecurrenceRequest, 'SaveScheduleRecurrenceRequest schema must exist');
    assert.ok(schemas.GenerateTasksRequest, 'GenerateTasksRequest schema must exist');
    assert.ok(schemas.GeneratedTaskRecord, 'GeneratedTaskRecord schema must exist');

    assert.ok(SPEC.components.parameters.ScheduleIdPathParam, 'ScheduleIdPathParam parameter must exist');
    assert.ok(SPEC.components.parameters.ScheduleDefinitionIdPathParam, 'ScheduleDefinitionIdPathParam parameter must exist');
  });

  // 10. /platform/* untouched (69/69)
  it('10. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
  });

  // Census validation after PART 08
  it('Census validation after PART 08', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

    assert.equal(openapi.length, 1472, 'Total OpenAPI count must be 1,472 (1463 + 9)');
    assert.equal(platformOpenApi.length, 69, 'Platform OpenAPI count must be 69');
    assert.equal(operationalOpenApi.length, 1403, 'Operational OpenAPI count must be 1,403 (1394 + 9)');

    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be 1,617');

    const arithmeticGap = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(arithmeticGap, 214, 'Arithmetic runtime gap must be 214 (1617 - 1403)');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 213, 'Distinct unmapped operational endpoints must be 213');
  });
});
