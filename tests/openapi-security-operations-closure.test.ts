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
 * INT-LC-19-BE PART 06 — Security Operations, Keys & Lost-Found OpenAPI Closure.
 *
 * Scope:
 *   - security-keys (9 routes)
 *   - security-lost-found (9 routes)
 *   - security-incident-readiness (4 routes)
 *   - security-reports (8 routes; GET /security/reports/shift-handovers was already documented)
 *   - security-patrol-kpi (1 route)
 *   - security-finding-incident-kpi (1 route)
 * Total undocumented routes: exact 32.
 *
 * Required proofs:
 *  1. 32/32 documented
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
    buildingScoped?: boolean;
  }
> = {
  // security-keys (9)
  'POST /security/keys': {
    module: 'security-keys',
    operationId: 'createSecurityKey',
    permission: 'security_key.manage',
    summary: 'Create a security key',
    buildingScoped: true,
  },
  'GET /security/keys': {
    module: 'security-keys',
    operationId: 'listSecurityKeys',
    permission: 'security_key.read',
    summary: 'List security keys',
    buildingScoped: true,
  },
  'GET /security/keys/{id}': {
    module: 'security-keys',
    operationId: 'getSecurityKey',
    permission: 'security_key.read',
    summary: 'Get a security key by ID',
    buildingScoped: true,
  },
  'PATCH /security/keys/{id}': {
    module: 'security-keys',
    operationId: 'updateSecurityKey',
    permission: 'security_key.manage',
    summary: 'Update a security key',
    buildingScoped: true,
  },
  'POST /security/keys/{id}/issue': {
    module: 'security-keys',
    operationId: 'issueSecurityKey',
    permission: 'security_key.manage',
    summary: 'Issue a security key',
    buildingScoped: true,
  },
  'POST /security/keys/{id}/return': {
    module: 'security-keys',
    operationId: 'returnSecurityKey',
    permission: 'security_key.manage',
    summary: 'Return a security key',
    buildingScoped: true,
  },
  'POST /security/keys/{id}/mark-lost': {
    module: 'security-keys',
    operationId: 'markSecurityKeyLost',
    permission: 'security_key.manage',
    summary: 'Mark a security key as lost',
    buildingScoped: true,
  },
  'GET /security/keys/{id}/custody': {
    module: 'security-keys',
    operationId: 'getSecurityKeyCurrentCustody',
    permission: 'security_key.read',
    summary: 'Get active custody records of a security key',
    buildingScoped: true,
  },
  'GET /security/keys/{id}/history': {
    module: 'security-keys',
    operationId: 'listSecurityKeyCustodyHistory',
    permission: 'security_key.read',
    summary: 'Get custody history of a security key',
    buildingScoped: true,
  },

  // security-lost-found (9)
  'POST /security/lost-found': {
    module: 'security-lost-found',
    operationId: 'createSecurityLostFound',
    permission: 'security_lost_found.manage',
    summary: 'Report a lost or found item',
    buildingScoped: true,
  },
  'GET /security/lost-found': {
    module: 'security-lost-found',
    operationId: 'listSecurityLostFound',
    permission: 'security_lost_found.read',
    summary: 'List lost and found items',
    buildingScoped: true,
  },
  'GET /security/lost-found/{id}': {
    module: 'security-lost-found',
    operationId: 'getSecurityLostFound',
    permission: 'security_lost_found.read',
    summary: 'Get a lost or found item by ID',
    buildingScoped: true,
  },
  'PATCH /security/lost-found/{id}': {
    module: 'security-lost-found',
    operationId: 'updateSecurityLostFound',
    permission: 'security_lost_found.manage',
    summary: 'Update a lost or found item',
    buildingScoped: true,
  },
  'POST /security/lost-found/{id}/custody': {
    module: 'security-lost-found',
    operationId: 'placeSecurityLostFoundCustody',
    permission: 'security_lost_found.manage',
    summary: 'Place a lost or found item into custody',
    buildingScoped: true,
  },
  'POST /security/lost-found/{id}/claim': {
    module: 'security-lost-found',
    operationId: 'registerSecurityLostFoundClaim',
    permission: 'security_lost_found.manage',
    summary: 'Register a claim for a lost or found item',
    buildingScoped: true,
  },
  'POST /security/lost-found/{id}/return': {
    module: 'security-lost-found',
    operationId: 'returnSecurityLostFound',
    permission: 'security_lost_found.manage',
    summary: 'Return a lost or found item to owner',
    buildingScoped: true,
  },
  'POST /security/lost-found/{id}/close': {
    module: 'security-lost-found',
    operationId: 'closeSecurityLostFound',
    permission: 'security_lost_found.manage',
    summary: 'Close or dispose a lost or found item',
    buildingScoped: true,
  },
  'GET /security/lost-found/{id}/history': {
    module: 'security-lost-found',
    operationId: 'getSecurityLostFoundHistory',
    permission: 'security_lost_found.read',
    summary: 'Get lifecycle history of a lost or found item',
    buildingScoped: true,
  },

  // security-incident-readiness (4)
  'POST /security/incident-readiness': {
    module: 'security-incident-readiness',
    operationId: 'createSecurityIncidentReadiness',
    permission: 'security_incident_readiness.manage',
    summary: 'Create a security incident readiness record',
    buildingScoped: true,
  },
  'GET /security/incident-readiness': {
    module: 'security-incident-readiness',
    operationId: 'listSecurityIncidentReadiness',
    permission: 'security_incident_readiness.read',
    summary: 'List security incident readiness records',
    buildingScoped: true,
  },
  'GET /security/incident-readiness/{id}': {
    module: 'security-incident-readiness',
    operationId: 'getSecurityIncidentReadiness',
    permission: 'security_incident_readiness.read',
    summary: 'Get a security incident readiness record by ID',
    buildingScoped: true,
  },
  'PATCH /security/incident-readiness/{id}': {
    module: 'security-incident-readiness',
    operationId: 'updateSecurityIncidentReadiness',
    permission: 'security_incident_readiness.manage',
    summary: 'Update a security incident readiness record',
    buildingScoped: true,
  },

  // security-reports (8)
  'GET /security/reports/summary': {
    module: 'security-reports',
    operationId: 'getSecuritySummaryReport',
    permission: 'security_report.read',
    summary: 'Security operations high-level summary report',
    buildingScoped: true,
  },
  'GET /security/reports/patrols': {
    module: 'security-reports',
    operationId: 'getSecurityPatrolDataset',
    permission: 'security_report.read',
    summary: 'Security patrol reporting dataset',
    buildingScoped: true,
  },
  'GET /security/reports/security-posts': {
    module: 'security-reports',
    operationId: 'getSecurityPostDataset',
    permission: 'security_report.read',
    summary: 'Security post reporting dataset',
    buildingScoped: true,
  },
  'GET /security/reports/findings': {
    module: 'security-reports',
    operationId: 'getSecurityFindingDataset',
    permission: 'security_report.read',
    summary: 'Security finding reporting dataset',
    buildingScoped: true,
  },
  'GET /security/reports/incident-readiness': {
    module: 'security-reports',
    operationId: 'getSecurityIncidentReadinessDataset',
    permission: 'security_report.read',
    summary: 'Security incident readiness reporting dataset',
    buildingScoped: true,
  },
  'GET /security/reports/visitor-bindings': {
    module: 'security-reports',
    operationId: 'getSecurityVisitorBindingDataset',
    permission: 'security_report.read',
    summary: 'Security visitor binding reporting dataset',
    buildingScoped: true,
  },
  'GET /security/reports/keys': {
    module: 'security-reports',
    operationId: 'getSecurityKeyControlDataset',
    permission: 'security_report.read',
    summary: 'Security key control reporting dataset',
    buildingScoped: true,
  },
  'GET /security/reports/lost-found': {
    module: 'security-reports',
    operationId: 'getSecurityLostFoundDataset',
    permission: 'security_report.read',
    summary: 'Security lost and found reporting dataset',
    buildingScoped: true,
  },

  // security-patrol-kpi (1)
  'GET /security/reports/patrol-kpi': {
    module: 'security-patrol-kpi',
    operationId: 'getSecurityPatrolKpi',
    permission: 'security_patrol_kpi.read',
    summary: 'Security patrol KPI projection',
    buildingScoped: true,
  },

  // security-finding-incident-kpi (1)
  'GET /security/reports/finding-incident-kpi': {
    module: 'security-finding-incident-kpi',
    operationId: 'getSecurityFindingIncidentKpi',
    permission: 'security_finding_incident_kpi.read',
    summary: 'Security finding, incident, and handover KPI projection',
    buildingScoped: true,
  },
};

describe('INT-LC-19-BE PART 06 — Security Operations, Keys & Lost-Found OpenAPI Closure', () => {
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
    buildingScoped?: boolean;
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
          buildingScoped: op['x-building-scoped'],
          responses: op.responses,
        });
      }
    }
  }

  // 1. Exactly 32 scoped operations defined in test table
  it('1. exact 32 operations in scoped test table', () => {
    assert.equal(
      Object.keys(SCOPED_OPERATIONS).length,
      32,
      'Scoped operations table must have exactly 32 operations',
    );
  });

  // 2. All 32 scoped operations documented in OpenAPI
  it('2. 32/32 scoped operations documented in OpenAPI', () => {
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
    const scopedRuntimePrefixes = [
      '/security/keys',
      '/security/lost-found',
      '/security/incident-readiness',
      '/security/reports',
    ];

    const scopedRuntime = runtime.filter((r) =>
      scopedRuntimePrefixes.some((prefix) => r.path.startsWith(prefix)),
    );

    // Verify all scoped runtime routes are documented
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

  // 6. Zero broken $refs in the entire OpenAPI document
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

  // 8. Scope parity exact
  it('8. building/data-scope parity exact', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      if (expected.buildingScoped) {
        const op = openapiByMethodPath.get(key);
        assert.ok(op, `Must locate ${key}`);
        assert.equal(
          op.buildingScoped,
          true,
          `Scoped operation ${key} must declare x-building-scoped: true`,
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

    // security-keys
    assert.ok(schemas.SecurityKeyType, 'SecurityKeyType schema must exist');
    assert.ok(schemas.SecurityKeyStatus, 'SecurityKeyStatus schema must exist');
    assert.ok(schemas.SecurityKeyCustodyStatus, 'SecurityKeyCustodyStatus schema must exist');
    assert.ok(schemas.SecurityKey, 'SecurityKey schema must exist');
    assert.ok(schemas.SecurityKeyCustody, 'SecurityKeyCustody schema must exist');
    assert.ok(schemas.CreateSecurityKeyRequest, 'CreateSecurityKeyRequest schema must exist');
    assert.ok(schemas.UpdateSecurityKeyRequest, 'UpdateSecurityKeyRequest schema must exist');
    assert.ok(schemas.IssueSecurityKeyRequest, 'IssueSecurityKeyRequest schema must exist');
    assert.ok(schemas.ReturnSecurityKeyRequest, 'ReturnSecurityKeyRequest schema must exist');
    assert.ok(schemas.MarkSecurityKeyLostRequest, 'MarkSecurityKeyLostRequest schema must exist');

    // security-lost-found
    assert.ok(schemas.SecurityLostFoundType, 'SecurityLostFoundType schema must exist');
    assert.ok(schemas.SecurityLostFoundStatus, 'SecurityLostFoundStatus schema must exist');
    assert.ok(schemas.SecurityLostFoundClaimStatus, 'SecurityLostFoundClaimStatus schema must exist');
    assert.ok(schemas.SecurityLostFoundItem, 'SecurityLostFoundItem schema must exist');
    assert.ok(schemas.SecurityLostFoundCustody, 'SecurityLostFoundCustody schema must exist');
    assert.ok(schemas.SecurityLostFoundClaim, 'SecurityLostFoundClaim schema must exist');
    assert.ok(schemas.SecurityLostFoundReturn, 'SecurityLostFoundReturn schema must exist');
    assert.ok(schemas.SecurityLostFoundHistory, 'SecurityLostFoundHistory schema must exist');
    assert.ok(schemas.CreateSecurityLostFoundRequest, 'CreateSecurityLostFoundRequest schema must exist');
    assert.ok(schemas.UpdateSecurityLostFoundRequest, 'UpdateSecurityLostFoundRequest schema must exist');
    assert.ok(schemas.PlaceSecurityLostFoundCustodyRequest, 'PlaceSecurityLostFoundCustodyRequest schema must exist');
    assert.ok(schemas.RegisterSecurityLostFoundClaimRequest, 'RegisterSecurityLostFoundClaimRequest schema must exist');
    assert.ok(schemas.ReturnSecurityLostFoundRequest, 'ReturnSecurityLostFoundRequest schema must exist');
    assert.ok(schemas.CloseSecurityLostFoundRequest, 'CloseSecurityLostFoundRequest schema must exist');

    // security-incident-readiness
    assert.ok(schemas.SecurityIncidentReadinessCategory, 'SecurityIncidentReadinessCategory schema must exist');
    assert.ok(schemas.SecurityIncidentReadinessStatus, 'SecurityIncidentReadinessStatus schema must exist');
    assert.ok(schemas.SecurityIncidentReadiness, 'SecurityIncidentReadiness schema must exist');
    assert.ok(schemas.CreateSecurityIncidentReadinessRequest, 'CreateSecurityIncidentReadinessRequest schema must exist');
    assert.ok(schemas.UpdateSecurityIncidentReadinessRequest, 'UpdateSecurityIncidentReadinessRequest schema must exist');

    // security-reports
    assert.ok(schemas.SecuritySummaryReport, 'SecuritySummaryReport schema must exist');
    assert.ok(schemas.SecurityPatrolDatasetRow, 'SecurityPatrolDatasetRow schema must exist');
    assert.ok(schemas.SecurityPostDatasetRow, 'SecurityPostDatasetRow schema must exist');
    assert.ok(schemas.SecurityFindingDatasetRow, 'SecurityFindingDatasetRow schema must exist');
    assert.ok(schemas.SecurityIncidentReadinessDatasetRow, 'SecurityIncidentReadinessDatasetRow schema must exist');
    assert.ok(schemas.SecurityVisitorBindingDatasetRow, 'SecurityVisitorBindingDatasetRow schema must exist');
    assert.ok(schemas.SecurityKeyControlDatasetRow, 'SecurityKeyControlDatasetRow schema must exist');
    assert.ok(schemas.SecurityLostFoundDatasetRow, 'SecurityLostFoundDatasetRow schema must exist');

    // KPI schemas
    assert.ok(schemas.PublicSecurityPatrolKpi, 'PublicSecurityPatrolKpi schema must exist');
    assert.ok(schemas.PublicKpiStatusCount, 'PublicKpiStatusCount schema must exist');
    assert.ok(schemas.PublicSecurityFindingKpi, 'PublicSecurityFindingKpi schema must exist');
    assert.ok(schemas.PublicSecurityIncidentKpi, 'PublicSecurityIncidentKpi schema must exist');
    assert.ok(schemas.PublicSecurityHandoverKpi, 'PublicSecurityHandoverKpi schema must exist');
    assert.ok(schemas.PublicSecurityFindingIncidentKpi, 'PublicSecurityFindingIncidentKpi schema must exist');

    // Pagination
    assert.ok(schemas.SecurityPaginationMeta, 'SecurityPaginationMeta schema must exist');

    // Parameters
    assert.ok(SPEC.components.parameters.SecurityKeyIdPath, 'SecurityKeyIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.SecurityLostFoundIdPath, 'SecurityLostFoundIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.SecurityIncidentReadinessIdPath, 'SecurityIncidentReadinessIdPath parameter must exist');
  });

  // 11. /platform/* untouched (69/69)
  it('11. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
  });

  // Census validation after PART 06
  it('Census validation after PART 06', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

    assert.equal(openapi.length, 1437, 'Total OpenAPI count must be 1,437 (1405 + 32)');
    assert.equal(platformOpenApi.length, 69, 'Platform OpenAPI count must be 69');
    assert.equal(operationalOpenApi.length, 1368, 'Operational OpenAPI count must be 1,368 (1336 + 32)');

    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be 1,617');

    const arithmeticGap = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(arithmeticGap, 249, 'Arithmetic runtime gap must be 249 (1617 - 1368)');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 248, 'Distinct unmapped operational endpoints must be 248');
  });
});
