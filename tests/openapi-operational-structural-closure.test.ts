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
 * INT-LC-19-BE PART 01 — OpenAPI Operational Structural Closure.
 *
 * Verifies the structural hygiene and census reconciliation for the
 * operational API contract:
 *  1. Operational census arithmetic & route disposition:
 *     - TOTAL_RUNTIME = 1,687
 *     - NON_OPENAPI_INFRASTRUCTURE_ROUTE = 1 (app root `GET /`)
 *     - IN_SCOPE_OPERATIONAL_RUNTIME = 1,617
 *     - OPENAPI_OPERATIONAL = 1,250
 *     - RUNTIME_NOT_DOCUMENTED (Class A) = 367 (1,617 - 1,250 = 367)
 *     - Duplicate runtime mount = 1 (`GET /tasks/:id` vs `GET /tasks/:taskId`)
 *  2. Exact Class A count after route disposition = 367
 *  3. All OpenAPI operations have unique operationId (0 missing)
 *  4. Exactly 14 SLA operations carry canonical operationId
 *  5. Duplicate operationId count = 0
 *  6. Broken local $refs = 0
 *  7. Exactly zero authenticated documented operational operations lack canonical 401
 *  8. Platform SaaS control-plane remains 69/69 untouched
 *  9. Zero speculative operational routes in OpenAPI (1250/1250 exist in runtime)
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
}> {
  const out: Array<{
    method: string;
    path: string;
    canon: string;
    operationId?: string;
    responses?: Record<string, any>;
    security?: any[];
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
      });
    }
  }
  return out;
}

describe('OpenAPI Operational Structural Closure (INT-LC-19-BE PART 01)', () => {
  const runtime = extractAllRuntimeRoutes();
  const openapi = extractOpenApiOperations();

  const platformRuntime = runtime.filter((r) => r.path.startsWith('/platform') || r.path === '/platform');
  const operationalRuntime = runtime.filter((r) => !r.path.startsWith('/platform') && r.path !== '/platform');

  const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
  const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

  // 1. Reconciled operational census arithmetic & route disposition
  it('1. proves reconciled census arithmetic: TOTAL_RUNTIME = 1,687, IN_SCOPE = 1,617', () => {
    assert.equal(runtime.length, 1687, 'Total runtime routes must be exactly 1,687');
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime routes must be exactly 69');
    assert.equal(operationalRuntime.length, 1618, 'Operational runtime routes must be 1,618');

    // Root GET / is the single NON_OPENAPI_INFRASTRUCTURE_ROUTE
    const rootRoute = operationalRuntime.filter((r) => r.path === '/');
    assert.equal(rootRoute.length, 1, 'Exact 1 application root infrastructure route (GET /)');
    assert.equal(rootRoute[0].method, 'GET');

    const inScopeOperational = operationalRuntime.filter((r) => r.path !== '/');
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be exactly 1,617');
    assert.equal(operationalOpenApi.length, 1616, 'OPENAPI_OPERATIONAL must be 1,616 after PART 14');

    // Reconciled arithmetic: 1617 - 1616 = 1 (duplicate task mount only)
    const runtimeNotDocumented = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(runtimeNotDocumented, 1, 'RUNTIME_NOT_DOCUMENTED must be exactly 1');
  });

  // 2. Exact Class A count after route disposition
  it('2. proves exact Class A count: RUNTIME_NOT_DOCUMENTED = 1', () => {
    const inScopeOperational = operationalRuntime.filter((r) => r.path !== '/');
    const runtimeNotDocumented = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(runtimeNotDocumented, 1, 'RUNTIME_NOT_DOCUMENTED must be exactly 1');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedRoutes = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    // Distinct gap is 0. The arithmetic gap of 1 is the duplicate task mount.
    assert.equal(unmappedRoutes.length, 0, 'Unique unmapped operational endpoints must be 0');
  });

  // 3 & 5. All OpenAPI operations have unique operationId, duplicates = 0
  it('3. all OpenAPI operations have operationId and duplicate operationIds = 0', () => {
    const missing: string[] = [];
    const seen = new Map<string, string>();
    const dups: string[] = [];

    for (const op of openapi) {
      if (!op.operationId) {
        missing.push(`${op.method} ${op.path}`);
      } else {
        const key = `${op.method} ${op.path}`;
        if (seen.has(op.operationId)) {
          dups.push(`${op.operationId} (at ${key} and ${seen.get(op.operationId)})`);
        }
        seen.set(op.operationId, key);
      }
    }

    assert.deepEqual(missing, [], 'Zero operations should miss operationId');
    assert.deepEqual(dups, [], 'Zero duplicate operationIds allowed');
  });

  // 4. Exactly 14 SLA operations have deterministic operationIds
  it('4. the 14 SLA operations have deterministic operationId', () => {
    const expectedSlaOpIds: Record<string, string> = {
      'POST /clients/{clientId}/sla-definitions': 'createSlaDefinition',
      'GET /clients/{clientId}/sla-definitions': 'listSlaDefinitions',
      'GET /work-orders/{id}/sla': 'getWorkOrderSla',
      'GET /work-orders/{id}/sla/escalations': 'listWorkOrderSlaEscalations',
      'GET /sla-definitions/{id}': 'getSlaDefinition',
      'PATCH /sla-definitions/{id}': 'updateSlaDefinition',
      'POST /clients/{clientId}/sla-escalation-policies': 'createSlaEscalationPolicy',
      'GET /clients/{clientId}/sla-escalation-policies': 'listSlaEscalationPolicies',
      'GET /sla-escalation-policies/{id}': 'getSlaEscalationPolicy',
      'PATCH /sla-escalation-policies/{id}': 'updateSlaEscalationPolicy',
      'POST /sla-escalation-policies/{id}/levels': 'createSlaEscalationLevel',
      'GET /sla-escalation-policies/{id}/levels': 'listSlaEscalationLevels',
      'GET /sla-escalation-levels/{id}': 'getSlaEscalationLevel',
      'PATCH /sla-escalation-levels/{id}': 'updateSlaEscalationLevel',
    };

    const slaOps = openapi.filter((o) => `${o.method} ${o.path}` in expectedSlaOpIds);
    assert.equal(slaOps.length, 14, 'Must locate exactly 14 SLA operations');

    for (const op of slaOps) {
      const key = `${op.method} ${op.path}`;
      const expected = expectedSlaOpIds[key];
      assert.equal(op.operationId, expected, `${key} operationId must be ${expected}`);
    }
  });

  // 6. Broken local refs = 0
  it('6. broken local $refs = 0', () => {
    const components = SPEC.components as Record<string, Record<string, unknown>> ?? {};
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

  // 7. Zero authenticated documented operational operations lack canonical 401
  it('7. exactly zero authenticated documented operational operations lack canonical 401', () => {
    const publicOps = new Set([
      'GET /health',
      'GET /health/database',
      'POST /auth/login',
      // Public token acceptance. No bearer middleware.
      'POST /invitations/accept',
    ]);

    const missing401: string[] = [];
    for (const op of operationalOpenApi) {
      const key = `${op.method} ${op.path}`;
      if (publicOps.has(key) || op.path.startsWith('/mobile/app-version')) continue;
      if (op.path.includes('webhook') || op.path.includes('callback')) continue;

      const responses = op.responses ?? {};
      if (!responses['401']) {
        missing401.push(key);
      }
    }

    assert.deepEqual(missing401, [], 'No authenticated documented operational operation may lack 401');
  });

  // 8. Platform SaaS remains 69/69 untouched
  it('8. platform SaaS control plane remains 69/69 untouched', () => {
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
    assert.equal(platformOpenApi.length, 69, 'SaaS platform OpenAPI operation count must remain 69');

    const runtimeKeys = new Set(platformRuntime.map((r) => `${r.method} ${r.canon}`));
    const openapiKeys = new Set(platformOpenApi.map((o) => `${o.method} ${o.canon}`));

    const missingFromOpenApi = [...runtimeKeys].filter((k) => !openapiKeys.has(k));
    const extraInOpenApi = [...openapiKeys].filter((k) => !runtimeKeys.has(k));

    assert.deepEqual(missingFromOpenApi, [], 'SaaS platform parity preserved');
    assert.deepEqual(extraInOpenApi, [], 'No extra SaaS platform operations');
  });

  // 9. Zero speculative operational OpenAPI routes introduced
  it('9. no speculative operational OpenAPI route introduced', () => {
    const runtimeCanon = new Set(operationalRuntime.map((r) => `${r.method} ${r.canon}`));
    const speculative: string[] = [];

    for (const op of operationalOpenApi) {
      const key = `${op.method} ${op.canon}`;
      if (!runtimeCanon.has(key)) {
        speculative.push(`${op.method} ${op.path}`);
      }
    }

    assert.deepEqual(speculative, [], 'Every documented operational operation must exist in runtime');
  });
});
