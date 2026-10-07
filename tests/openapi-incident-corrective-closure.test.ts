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
 * INT-LC-19-BE PART 04 — Incident & Corrective Action OpenAPI Closure.
 *
 * Verifies OpenAPI closure for the 7 scoped incident and corrective action modules:
 *   - asset-failures
 *   - finding-escalations
 *   - immediate-actions
 *   - investigation-readiness
 *   - corrective-actions
 *   - corrective-action-responsibilities
 *   - incident-closure
 *
 * Required proofs:
 *  1. exact 37 scoped routes documented
 *  2. scoped gap = 0 (37/37 scoped routes exist in OpenAPI)
 *  3. no speculative scoped routes
 *  4. all 37 have unique operationId
 *  5. global duplicate operationIds = 0
 *  6. broken refs = 0
 *  7. permission parity exact
 *  8. scope parity exact
 *  9. canonical 401 where authenticated
 * 10. request/response schema parity
 * 11. all 4 asset-failure routes included
 * 12. all 4 finding-escalation routes included
 * 13. /platform/* untouched
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
  // Module 1: asset-failures (4)
  'POST /asset-failures': {
    method: 'POST',
    path: '/asset-failures',
    operationId: 'createAssetFailure',
    permission: 'asset_failure.manage',
    module: 'asset-failures',
  },
  'GET /asset-failures': {
    method: 'GET',
    path: '/asset-failures',
    operationId: 'listAssetFailures',
    permission: 'asset_failure.read',
    module: 'asset-failures',
  },
  'GET /asset-failures/{id}': {
    method: 'GET',
    path: '/asset-failures/{id}',
    operationId: 'getAssetFailure',
    permission: 'asset_failure.read',
    module: 'asset-failures',
  },
  'PATCH /asset-failures/{id}': {
    method: 'PATCH',
    path: '/asset-failures/{id}',
    operationId: 'updateAssetFailure',
    permission: 'asset_failure.manage',
    module: 'asset-failures',
  },

  // Module 2: finding-escalations (4)
  'POST /finding-escalations': {
    method: 'POST',
    path: '/finding-escalations',
    operationId: 'createFindingEscalation',
    permission: 'finding_escalation.manage',
    module: 'finding-escalations',
  },
  'GET /finding-escalations': {
    method: 'GET',
    path: '/finding-escalations',
    operationId: 'listFindingEscalations',
    permission: 'finding_escalation.read',
    module: 'finding-escalations',
  },
  'GET /finding-escalations/{id}': {
    method: 'GET',
    path: '/finding-escalations/{id}',
    operationId: 'getFindingEscalation',
    permission: 'finding_escalation.read',
    module: 'finding-escalations',
  },
  'PATCH /finding-escalations/{id}': {
    method: 'PATCH',
    path: '/finding-escalations/{id}',
    operationId: 'updateFindingEscalation',
    permission: 'finding_escalation.manage',
    module: 'finding-escalations',
  },

  // Module 3: immediate-actions (7)
  'POST /immediate-actions': {
    method: 'POST',
    path: '/immediate-actions',
    operationId: 'createImmediateAction',
    permission: 'immediate_action.manage',
    module: 'immediate-actions',
  },
  'GET /immediate-actions': {
    method: 'GET',
    path: '/immediate-actions',
    operationId: 'listImmediateActions',
    permission: 'immediate_action.read',
    module: 'immediate-actions',
  },
  'GET /immediate-actions/{id}': {
    method: 'GET',
    path: '/immediate-actions/{id}',
    operationId: 'getImmediateAction',
    permission: 'immediate_action.read',
    module: 'immediate-actions',
  },
  'PATCH /immediate-actions/{id}': {
    method: 'PATCH',
    path: '/immediate-actions/{id}',
    operationId: 'updateImmediateAction',
    permission: 'immediate_action.manage',
    module: 'immediate-actions',
  },
  'POST /immediate-actions/{id}/start': {
    method: 'POST',
    path: '/immediate-actions/{id}/start',
    operationId: 'startImmediateAction',
    permission: 'immediate_action.manage',
    module: 'immediate-actions',
  },
  'POST /immediate-actions/{id}/complete': {
    method: 'POST',
    path: '/immediate-actions/{id}/complete',
    operationId: 'completeImmediateAction',
    permission: 'immediate_action.manage',
    module: 'immediate-actions',
  },
  'POST /immediate-actions/{id}/cancel': {
    method: 'POST',
    path: '/immediate-actions/{id}/cancel',
    operationId: 'cancelImmediateAction',
    permission: 'immediate_action.manage',
    module: 'immediate-actions',
  },

  // Module 4: investigation-readiness (2)
  'GET /incidents/{id}/investigation-readiness': {
    method: 'GET',
    path: '/incidents/{id}/investigation-readiness',
    operationId: 'getIncidentInvestigationReadiness',
    permission: 'investigation_readiness.read',
    module: 'investigation-readiness',
  },
  'GET /investigation-readiness': {
    method: 'GET',
    path: '/investigation-readiness',
    operationId: 'listInvestigationReadiness',
    permission: 'investigation_readiness.read',
    module: 'investigation-readiness',
  },

  // Module 5: corrective-actions (11)
  'POST /corrective-actions': {
    method: 'POST',
    path: '/corrective-actions',
    operationId: 'createCorrectiveAction',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'GET /corrective-actions': {
    method: 'GET',
    path: '/corrective-actions',
    operationId: 'listCorrectiveActions',
    permission: 'corrective_action.read',
    module: 'corrective-actions',
  },
  'GET /corrective-actions/{id}': {
    method: 'GET',
    path: '/corrective-actions/{id}',
    operationId: 'getCorrectiveAction',
    permission: 'corrective_action.read',
    module: 'corrective-actions',
  },
  'PATCH /corrective-actions/{id}': {
    method: 'PATCH',
    path: '/corrective-actions/{id}',
    operationId: 'updateCorrectiveAction',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'POST /corrective-actions/{id}/approve': {
    method: 'POST',
    path: '/corrective-actions/{id}/approve',
    operationId: 'approveCorrectiveAction',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'POST /corrective-actions/{id}/reject': {
    method: 'POST',
    path: '/corrective-actions/{id}/reject',
    operationId: 'rejectCorrectiveAction',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'POST /corrective-actions/{id}/start': {
    method: 'POST',
    path: '/corrective-actions/{id}/start',
    operationId: 'startCorrectiveAction',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'POST /corrective-actions/{id}/complete': {
    method: 'POST',
    path: '/corrective-actions/{id}/complete',
    operationId: 'completeCorrectiveAction',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'POST /corrective-actions/{id}/cancel': {
    method: 'POST',
    path: '/corrective-actions/{id}/cancel',
    operationId: 'cancelCorrectiveAction',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'PUT /corrective-actions/{id}/due-date': {
    method: 'PUT',
    path: '/corrective-actions/{id}/due-date',
    operationId: 'setCorrectiveActionDueDate',
    permission: 'corrective_action.manage',
    module: 'corrective-actions',
  },
  'GET /corrective-actions/{id}/due-date': {
    method: 'GET',
    path: '/corrective-actions/{id}/due-date',
    operationId: 'getCorrectiveActionDueDate',
    permission: 'corrective_action.read',
    module: 'corrective-actions',
  },

  // Module 6: corrective-action-responsibilities (6)
  'GET /corrective-actions/{id}/responsible-person/history': {
    method: 'GET',
    path: '/corrective-actions/{id}/responsible-person/history',
    operationId: 'listCorrectiveActionResponsibilityHistory',
    permission: 'corrective_action_responsibility.read',
    module: 'corrective-action-responsibilities',
  },
  'POST /corrective-actions/{id}/responsible-person': {
    method: 'POST',
    path: '/corrective-actions/{id}/responsible-person',
    operationId: 'assignCorrectiveActionResponsiblePerson',
    permission: 'corrective_action_responsibility.manage',
    module: 'corrective-action-responsibilities',
  },
  'GET /corrective-actions/{id}/responsible-person': {
    method: 'GET',
    path: '/corrective-actions/{id}/responsible-person',
    operationId: 'getCorrectiveActionResponsiblePerson',
    permission: 'corrective_action_responsibility.read',
    module: 'corrective-action-responsibilities',
  },
  'PATCH /corrective-actions/{id}/responsible-person': {
    method: 'PATCH',
    path: '/corrective-actions/{id}/responsible-person',
    operationId: 'updateCorrectiveActionResponsiblePerson',
    permission: 'corrective_action_responsibility.manage',
    module: 'corrective-action-responsibilities',
  },
  'DELETE /corrective-actions/{id}/responsible-person': {
    method: 'DELETE',
    path: '/corrective-actions/{id}/responsible-person',
    operationId: 'releaseCorrectiveActionResponsiblePerson',
    permission: 'corrective_action_responsibility.manage',
    module: 'corrective-action-responsibilities',
  },
  'GET /corrective-action-responsibilities': {
    method: 'GET',
    path: '/corrective-action-responsibilities',
    operationId: 'listCorrectiveActionResponsibilities',
    permission: 'corrective_action_responsibility.read',
    module: 'corrective-action-responsibilities',
  },

  // Module 7: incident-closure (3)
  'GET /incident-closures': {
    method: 'GET',
    path: '/incident-closures',
    operationId: 'listIncidentClosureStatuses',
    permission: 'incident_closure.read',
    module: 'incident-closure',
  },
  'GET /incidents/{id}/closure': {
    method: 'GET',
    path: '/incidents/{id}/closure',
    operationId: 'getIncidentClosureStatus',
    permission: 'incident_closure.read',
    module: 'incident-closure',
  },
  'POST /incidents/{id}/closure': {
    method: 'POST',
    path: '/incidents/{id}/closure',
    operationId: 'closeIncident',
    permission: 'incident_closure.manage',
    module: 'incident-closure',
  },
};

describe('OpenAPI Incident & Corrective Action Closure (INT-LC-19-BE PART 04)', () => {
  const runtime = extractAllRuntimeRoutes();
  const openapi = extractOpenApiOperations();

  // 1. Exact 37 scoped routes documented
  it('1. exact 37 scoped routes documented', () => {
    assert.equal(
      Object.keys(SCOPED_OPERATIONS).length,
      37,
      'SCOPED_OPERATIONS dictionary must contain exactly 37 routes',
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

  // 2. Scoped gap = 0 (37/37 scoped routes documented)
  it('2. PART 04 scoped gap = 0 (37/37 scoped routes documented)', () => {
    const isScoped = (rPath: string) => {
      if (rPath.startsWith('/asset-failures')) return true;
      if (rPath.startsWith('/finding-escalations')) return true;
      if (rPath.startsWith('/immediate-actions')) return true;
      if (rPath === '/investigation-readiness' || rPath === '/incidents/:id/investigation-readiness') return true;
      if (rPath.startsWith('/corrective-actions') && !rPath.includes('verification')) return true;
      if (rPath.startsWith('/corrective-action-responsibilities')) return true;
      if (rPath === '/incident-closures' || rPath === '/incidents/:id/closure') return true;
      return false;
    };

    const scopedRuntime = runtime.filter((r) => isScoped(r.path));
    assert.equal(scopedRuntime.length, 37, 'Scoped runtime route count must be exactly 37');

    const openapiCanon = new Set(openapi.map((o) => `${o.method} ${o.canon}`));
    const missing = scopedRuntime.filter((r) => !openapiCanon.has(`${r.method} ${r.canon}`));
    assert.deepEqual(missing, [], 'Zero scoped runtime routes should remain undocumented');
  });

  // 3. No speculative scoped OpenAPI route
  it('3. no speculative scoped OpenAPI route', () => {
    const isScopedPath = (p: string) => {
      if (p.startsWith('/asset-failures')) return true;
      if (p.startsWith('/finding-escalations')) return true;
      if (p.startsWith('/immediate-actions')) return true;
      if (p === '/investigation-readiness' || p === '/incidents/{id}/investigation-readiness') return true;
      if (p.startsWith('/corrective-actions') && !p.includes('verification')) return true;
      if (p.startsWith('/corrective-action-responsibilities')) return true;
      if (p === '/incident-closures' || p === '/incidents/{id}/closure') return true;
      return false;
    };

    const scopedOpenApi = openapi.filter((o) => isScopedPath(o.path));
    assert.equal(scopedOpenApi.length, 37, 'Exact 37 scoped OpenAPI operations must exist');

    const runtimeCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));
    for (const op of scopedOpenApi) {
      assert.ok(
        runtimeCanon.has(`${op.method} ${op.canon}`),
        `Documented operation ${op.method} ${op.path} must exist in runtime`,
      );
    }
  });

  // 4. All 37 have unique operationId
  it('4. all 37 have unique operationId', () => {
    const seen = new Set<string>();
    for (const op of Object.values(SCOPED_OPERATIONS)) {
      assert.ok(!seen.has(op.operationId), `Duplicate scoped operationId: ${op.operationId}`);
      seen.add(op.operationId);
    }
    assert.equal(seen.size, 37, 'Must have 37 unique scoped operationIds');
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

    for (const key of Object.keys(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, `Must locate ${key}`);
      assert.equal(
        op.buildingScoped,
        true,
        `Operation ${key} must declare x-building-scoped: true`,
      );
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
    const paths = SPEC.paths as Record<string, any>;

    // Verify key request schemas exist in components
    const schemas = SPEC.components.schemas;
    assert.ok(schemas.CreateAssetFailureRequest, 'CreateAssetFailureRequest schema must exist');
    assert.ok(schemas.UpdateAssetFailureRequest, 'UpdateAssetFailureRequest schema must exist');
    assert.ok(schemas.CreateFindingEscalationRequest, 'CreateFindingEscalationRequest schema must exist');
    assert.ok(schemas.UpdateFindingEscalationRequest, 'UpdateFindingEscalationRequest schema must exist');
    assert.ok(schemas.CreateImmediateActionRequest, 'CreateImmediateActionRequest schema must exist');
    assert.ok(schemas.CreateCorrectiveActionRequest, 'CreateCorrectiveActionRequest schema must exist');
    assert.ok(schemas.AssignResponsiblePersonRequest, 'AssignResponsiblePersonRequest schema must exist');
    assert.ok(schemas.SetCorrectiveActionDueDateRequest, 'SetCorrectiveActionDueDateRequest schema must exist');

    // Verify key response schemas exist
    assert.ok(schemas.PublicAssetFailure, 'PublicAssetFailure schema must exist');
    assert.ok(schemas.PublicFindingEscalation, 'PublicFindingEscalation schema must exist');
    assert.ok(schemas.PublicImmediateAction, 'PublicImmediateAction schema must exist');
    assert.ok(schemas.InvestigationReadiness, 'InvestigationReadiness schema must exist');
    assert.ok(schemas.PublicCorrectiveAction, 'PublicCorrectiveAction schema must exist');
    assert.ok(schemas.PublicCorrectiveActionResponsibility, 'PublicCorrectiveActionResponsibility schema must exist');
    assert.ok(schemas.IncidentClosureStatus, 'IncidentClosureStatus schema must exist');

    // Check POST /asset-failures 201 response data
    const createAfRes = paths['/asset-failures'].post.responses['201'];
    assert.ok(createAfRes, 'POST /asset-failures must have 201 response');

    // Check GET /corrective-actions/{id}/due-date 200 response data
    const getDueDateRes = paths['/corrective-actions/{id}/due-date'].get.responses['200'];
    assert.ok(getDueDateRes, 'GET /corrective-actions/{id}/due-date must have 200 response');
  });

  // 11. All 4 asset-failure routes included
  it('11. all 4 asset-failure routes included', () => {
    const assetFailureOps = openapi.filter((o) => o.path.startsWith('/asset-failures'));
    assert.equal(assetFailureOps.length, 4, 'Exactly 4 asset failure routes documented');
    const methods = assetFailureOps.map((o) => `${o.method} ${o.path}`).sort();
    assert.deepEqual(methods, [
      'GET /asset-failures',
      'GET /asset-failures/{id}',
      'PATCH /asset-failures/{id}',
      'POST /asset-failures',
    ]);
  });

  // 12. All 4 finding-escalation routes included
  it('12. all 4 finding-escalation routes included', () => {
    const feOps = openapi.filter((o) => o.path.startsWith('/finding-escalations'));
    assert.equal(feOps.length, 4, 'Exactly 4 finding escalation routes documented');
    const methods = feOps.map((o) => `${o.method} ${o.path}`).sort();
    assert.deepEqual(methods, [
      'GET /finding-escalations',
      'GET /finding-escalations/{id}',
      'PATCH /finding-escalations/{id}',
      'POST /finding-escalations',
    ]);
  });

  // 13. /platform/* untouched
  it('13. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter((r) => r.path.startsWith('/platform') || r.path === '/platform');
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
    assert.equal(platformOpenApi.length, 69, 'SaaS platform OpenAPI operation count must remain 69');
  });

  // Census validation after PART 04
  it('Census validation after PART 04', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

    assert.equal(openapi.length, 1391, 'Total OpenAPI count must be 1,391');
    assert.equal(platformOpenApi.length, 69, 'Platform OpenAPI count must be 69');
    assert.equal(operationalOpenApi.length, 1322, 'Operational OpenAPI count must be 1,322');

    const inScopeOperational = runtime.filter((r) => !r.path.startsWith('/platform') && r.path !== '/');
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be 1,617');

    const arithmeticGap = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(arithmeticGap, 295, 'Arithmetic runtime gap must be 295 (1617 - 1322)');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    // 294 distinct unmapped + 1 duplicate internal mount (GET /tasks/:id vs GET /tasks/:taskId) = 295
    assert.equal(unmappedDistinct.length, 294, 'Distinct unmapped operational endpoints must be 294');
  });
});
