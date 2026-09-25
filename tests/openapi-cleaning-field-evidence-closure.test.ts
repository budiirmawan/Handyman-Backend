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
 * INT-LC-19-BE PART 05 — Cleaning + Housekeeping + Field Evidence OpenAPI Closure.
 *
 * Scope:
 *   - cleaning-areas (4 routes)
 *   - cleaning-schedule-bindings (4 routes)
 *   - finding verification/rework evidence routes (6 routes)
 * Total: exact 14 routes.
 *
 * Required proofs:
 *  1. 14/14 documented
 *  2. scoped gap 0
 *  3. no speculative routes
 *  4. unique operationIds
 *  5. broken refs 0
 *  6. permission/scope/schema parity
 *  7. canonical 401 where authenticated
 *  8. /platform/* untouched (69/69)
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

function normalizePath(p: string): string {
  return p
    .replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
    .replace(/\{([a-zA-Z0-9_]+)\}/g, '{p}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
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
      const full = (prefix + layer.route.path) || '/';
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

function extractAllRuntimeRoutes(): Array<{ method: string; path: string; canon: string }> {
  const app: Express = createApp();
  const routes = walkRouter((app as any).router.stack);
  return routes.map((r) => ({
    method: r.method,
    path: r.path,
    canon: normalizePath(r.path),
  }));
}

function extractOpenApiOperations(): Array<{
  method: string;
  path: string;
  canon: string;
  operationId?: string;
  responses?: Record<string, any>;
  security?: any[];
  permission?: string;
  buildingScoped?: boolean;
}> {
  const out: Array<{
    method: string;
    path: string;
    canon: string;
    operationId?: string;
    responses?: Record<string, any>;
    security?: any[];
    permission?: string;
    buildingScoped?: boolean;
  }> = [];
  const paths = (SPEC.paths as Record<string, Record<string, any>>) ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({
        method: method.toUpperCase(),
        path,
        canon: normalizePath(path),
        operationId: op.operationId,
        responses: op.responses,
        security: op.security,
        permission: op['x-required-permission'],
        buildingScoped: op['x-building-scoped'],
      });
    }
  }
  return out;
}

const SCOPED_OPERATIONS: Record<string, {
  method: string;
  path: string;
  operationId: string;
  permission: string;
  module: string;
}> = {
  // cleaning-areas (4)
  'POST /buildings/{buildingId}/cleaning-areas': {
    method: 'POST',
    path: '/buildings/{buildingId}/cleaning-areas',
    operationId: 'createCleaningArea',
    permission: 'cleaning_area.manage',
    module: 'cleaning-areas',
  },
  'GET /buildings/{buildingId}/cleaning-areas': {
    method: 'GET',
    path: '/buildings/{buildingId}/cleaning-areas',
    operationId: 'listBuildingCleaningAreas',
    permission: 'cleaning_area.read',
    module: 'cleaning-areas',
  },
  'GET /housekeeping/cleaning-areas/{id}': {
    method: 'GET',
    path: '/housekeeping/cleaning-areas/{id}',
    operationId: 'getCleaningArea',
    permission: 'cleaning_area.read',
    module: 'cleaning-areas',
  },
  'PATCH /housekeeping/cleaning-areas/{id}': {
    method: 'PATCH',
    path: '/housekeeping/cleaning-areas/{id}',
    operationId: 'updateCleaningArea',
    permission: 'cleaning_area.manage',
    module: 'cleaning-areas',
  },

  // cleaning-schedule-bindings (4)
  'POST /housekeeping/cleaning-areas/{id}/schedule-bindings': {
    method: 'POST',
    path: '/housekeeping/cleaning-areas/{id}/schedule-bindings',
    operationId: 'createCleaningScheduleBinding',
    permission: 'cleaning_schedule.manage',
    module: 'cleaning-schedule-bindings',
  },
  'GET /housekeeping/cleaning-areas/{id}/schedule-bindings': {
    method: 'GET',
    path: '/housekeeping/cleaning-areas/{id}/schedule-bindings',
    operationId: 'listAreaCleaningScheduleBindings',
    permission: 'cleaning_schedule.read',
    module: 'cleaning-schedule-bindings',
  },
  'GET /housekeeping/cleaning-schedule-bindings/{id}': {
    method: 'GET',
    path: '/housekeeping/cleaning-schedule-bindings/{id}',
    operationId: 'getCleaningScheduleBinding',
    permission: 'cleaning_schedule.read',
    module: 'cleaning-schedule-bindings',
  },
  'PATCH /housekeeping/cleaning-schedule-bindings/{id}': {
    method: 'PATCH',
    path: '/housekeeping/cleaning-schedule-bindings/{id}',
    operationId: 'updateCleaningScheduleBinding',
    permission: 'cleaning_schedule.manage',
    module: 'cleaning-schedule-bindings',
  },

  // finding verification/rework evidence (6)
  'GET /findings/{findingId}/evidence/{evidenceId}': {
    method: 'GET',
    path: '/findings/{findingId}/evidence/{evidenceId}',
    operationId: 'getFindingEvidence',
    permission: 'evidence.read',
    module: 'finding-evidence',
  },
  'PATCH /findings/{findingId}/evidence/{evidenceId}': {
    method: 'PATCH',
    path: '/findings/{findingId}/evidence/{evidenceId}',
    operationId: 'removeFindingEvidence',
    permission: 'evidence.manage',
    module: 'finding-evidence',
  },
  'GET /findings/{findingId}/rework/{reworkId}/evidence/{evidenceId}': {
    method: 'GET',
    path: '/findings/{findingId}/rework/{reworkId}/evidence/{evidenceId}',
    operationId: 'getFindingReworkEvidence',
    permission: 'evidence.read',
    module: 'finding-rework-evidence',
  },
  'PATCH /findings/{findingId}/rework/{reworkId}/evidence/{evidenceId}': {
    method: 'PATCH',
    path: '/findings/{findingId}/rework/{reworkId}/evidence/{evidenceId}',
    operationId: 'removeFindingReworkEvidence',
    permission: 'evidence.manage',
    module: 'finding-rework-evidence',
  },
  'GET /findings/{findingId}/verification/{verificationId}/evidence/{evidenceId}': {
    method: 'GET',
    path: '/findings/{findingId}/verification/{verificationId}/evidence/{evidenceId}',
    operationId: 'getFindingVerificationEvidence',
    permission: 'evidence.read',
    module: 'finding-verification-evidence',
  },
  'PATCH /findings/{findingId}/verification/{verificationId}/evidence/{evidenceId}': {
    method: 'PATCH',
    path: '/findings/{findingId}/verification/{verificationId}/evidence/{evidenceId}',
    operationId: 'removeFindingVerificationEvidence',
    permission: 'finding.review',
    module: 'finding-verification-evidence',
  },
};

describe('OpenAPI Cleaning + Housekeeping + Field Evidence Closure (INT-LC-19-BE PART 05)', () => {
  const runtime = extractAllRuntimeRoutes();
  const openapi = extractOpenApiOperations();

  // 1. 14/14 documented
  it('1. exact 14 scoped routes documented', () => {
    assert.equal(
      Object.keys(SCOPED_OPERATIONS).length,
      14,
      'SCOPED_OPERATIONS dictionary must contain exactly 14 routes',
    );

    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, `Operation ${key} must exist in OpenAPI`);
      assert.equal(
        op.operationId,
        expected.operationId,
        `Operation ${key} must have operationId ${expected.operationId}`,
      );
    }
  });

  // 2. Scoped gap = 0
  it('2. PART 05 scoped gap = 0 (14/14 scoped routes documented)', () => {
    const isScoped = (rPath: string) => {
      if (rPath === '/buildings/:buildingId/cleaning-areas' || rPath === '/housekeeping/cleaning-areas/:id') return true;
      if (rPath === '/housekeeping/cleaning-areas/:id/schedule-bindings' || rPath === '/housekeeping/cleaning-schedule-bindings/:id') return true;
      if (rPath === '/findings/:findingId/evidence/:evidenceId') return true;
      if (rPath === '/findings/:findingId/rework/:reworkId/evidence/:evidenceId') return true;
      if (rPath === '/findings/:findingId/verification/:verificationId/evidence/:evidenceId') return true;
      return false;
    };

    const scopedRuntime = runtime.filter((r) => isScoped(r.path));
    assert.equal(scopedRuntime.length, 14, 'Scoped runtime route count must be exactly 14');

    const openapiCanon = new Set(openapi.map((o) => `${o.method} ${o.canon}`));
    const missing = scopedRuntime.filter((r) => !openapiCanon.has(`${r.method} ${r.canon}`));
    assert.deepEqual(missing, [], 'Zero scoped runtime routes should remain undocumented');
  });

  // 3. No speculative scoped OpenAPI route
  it('3. no speculative scoped OpenAPI route', () => {
    const isScopedPath = (p: string) => {
      if (p === '/buildings/{buildingId}/cleaning-areas' || p === '/housekeeping/cleaning-areas/{id}') return true;
      if (p === '/housekeeping/cleaning-areas/{id}/schedule-bindings' || p === '/housekeeping/cleaning-schedule-bindings/{id}') return true;
      if (p === '/findings/{findingId}/evidence/{evidenceId}') return true;
      if (p === '/findings/{findingId}/rework/{reworkId}/evidence/{evidenceId}') return true;
      if (p === '/findings/{findingId}/verification/{verificationId}/evidence/{evidenceId}') return true;
      return false;
    };

    const scopedOpenApi = openapi.filter((o) => isScopedPath(o.path));
    assert.equal(scopedOpenApi.length, 14, 'Exact 14 scoped OpenAPI operations must exist');

    const runtimeCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));
    for (const op of scopedOpenApi) {
      assert.ok(
        runtimeCanon.has(`${op.method} ${op.canon}`),
        `Documented operation ${op.method} ${op.path} must exist in runtime`,
      );
    }
  });

  // 4. All 14 have unique operationId
  it('4. all 14 have unique operationId', () => {
    const seen = new Set<string>();
    for (const op of Object.values(SCOPED_OPERATIONS)) {
      assert.ok(!seen.has(op.operationId), `Duplicate scoped operationId: ${op.operationId}`);
      seen.add(op.operationId);
    }
    assert.equal(seen.size, 14, 'Must have 14 unique scoped operationIds');
  });

  // 5. Global duplicate operationIds = 0
  it('5. duplicate operationIds globally = 0', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const op of openapi) {
      if (!op.operationId) continue;
      if (seen.has(op.operationId)) {
        duplicates.push(`${op.operationId} (${seen.get(op.operationId)} vs ${op.method} ${op.path})`);
      }
      seen.set(op.operationId, `${op.method} ${op.path}`);
    }
    assert.deepEqual(duplicates, [], 'Zero duplicate operationIds allowed across document');
  });

  // 6. Broken local refs = 0
  it('6. broken local $refs = 0', () => {
    const components = (SPEC.components as Record<string, Record<string, unknown>>) ?? {};
    const buckets: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(components)) {
      buckets[k] = new Set(Object.keys(v ?? {}));
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

  // 8. Scope parity exact
  it('8. building/data-scope parity exact', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    // cleaning routes carry x-building-scoped: true
    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      if (expected.module.startsWith('cleaning')) {
        const op = openapiByMethodPath.get(key);
        assert.ok(op, `Must locate ${key}`);
        assert.equal(
          op.buildingScoped,
          true,
          `Cleaning operation ${key} must declare x-building-scoped: true`,
        );
      }
    }
  });

  // 9. Canonical 401 where authenticated
  it('9. canonical 401 present where authenticated', () => {
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

  // 10. Request and response schema parity
  it('10. request/response schema parity', () => {
    const schemas = SPEC.components.schemas;
    assert.ok(schemas.CleaningAreaStatus, 'CleaningAreaStatus schema must exist');
    assert.ok(schemas.CleaningAreaType, 'CleaningAreaType schema must exist');
    assert.ok(schemas.CreateCleaningAreaRequest, 'CreateCleaningAreaRequest schema must exist');
    assert.ok(schemas.UpdateCleaningAreaRequest, 'UpdateCleaningAreaRequest schema must exist');
    assert.ok(schemas.PublicCleaningArea, 'PublicCleaningArea schema must exist');
    assert.ok(schemas.CleaningScheduleBindingStatus, 'CleaningScheduleBindingStatus schema must exist');
    assert.ok(schemas.CreateCleaningScheduleBindingRequest, 'CreateCleaningScheduleBindingRequest schema must exist');
    assert.ok(schemas.UpdateCleaningScheduleBindingRequest, 'UpdateCleaningScheduleBindingRequest schema must exist');
    assert.ok(schemas.PublicCleaningScheduleBinding, 'PublicCleaningScheduleBinding schema must exist');

    assert.ok(SPEC.components.parameters.CleaningScheduleBindingIdPath, 'CleaningScheduleBindingIdPath parameter must exist');
  });

  // 11. /platform/* untouched (69/69)
  it('11. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter((r) => r.path.startsWith('/platform') || r.path === '/platform');
    const platformOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
  });

  // Census validation after PART 05
  it('Census validation after PART 05', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

    assert.equal(openapi.length, 1405, 'Total OpenAPI count must be 1,405');
    assert.equal(platformOpenApi.length, 69, 'Platform OpenAPI count must be 69');
    assert.equal(operationalOpenApi.length, 1336, 'Operational OpenAPI count must be 1,336');

    const inScopeOperational = runtime.filter((r) => !r.path.startsWith('/platform') && r.path !== '/');
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be 1,617');

    const arithmeticGap = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(arithmeticGap, 281, 'Arithmetic runtime gap must be 281 (1617 - 1336)');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 280, 'Distinct unmapped operational endpoints must be 280');
  });
});
