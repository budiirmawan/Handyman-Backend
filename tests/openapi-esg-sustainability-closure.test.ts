import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Express } from 'express';

process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_META_APP_SECRET = 'test-secret';
process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = 'test-token';

import { createApp } from '../src/app';

/**
 * INT-LC-19-BE PART 13 — ESG & Sustainability OpenAPI Closure.
 *
 * Documents the 16 previously undocumented ESG routes.
 * None implement Idempotency-Key or optimistic concurrency.
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
    handle?: { stack?: unknown[] };
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
  { module: string; operationId: string; permission: string }
> = {
  'POST /esg/metric-definitions': {
    module: 'esg-metric-definitions',
    operationId: 'createEsgMetricDefinition',
    permission: 'esg.manage',
  },
  'GET /esg/metric-definitions': {
    module: 'esg-metric-definitions',
    operationId: 'listEsgMetricDefinitions',
    permission: 'esg.read',
  },
  'GET /esg/metric-definitions/{id}': {
    module: 'esg-metric-definitions',
    operationId: 'getEsgMetricDefinition',
    permission: 'esg.read',
  },
  'PATCH /esg/metric-definitions/{id}': {
    module: 'esg-metric-definitions',
    operationId: 'updateEsgMetricDefinition',
    permission: 'esg.manage',
  },
  'POST /esg/metric-definitions/{id}/deactivate': {
    module: 'esg-metric-definitions',
    operationId: 'deactivateEsgMetricDefinition',
    permission: 'esg.manage',
  },
  'POST /esg/metric-values': {
    module: 'esg-metric-values',
    operationId: 'createEsgMetricValue',
    permission: 'esg.manage',
  },
  'GET /esg/metric-values': {
    module: 'esg-metric-values',
    operationId: 'listEsgMetricValues',
    permission: 'esg.read',
  },
  'GET /esg/metric-values/{id}': {
    module: 'esg-metric-values',
    operationId: 'getEsgMetricValue',
    permission: 'esg.read',
  },
  'PATCH /esg/metric-values/{id}': {
    module: 'esg-metric-values',
    operationId: 'updateEsgMetricValue',
    permission: 'esg.manage',
  },
  'POST /esg/waste-records': {
    module: 'esg-waste-records',
    operationId: 'createEsgWasteRecord',
    permission: 'esg.manage',
  },
  'GET /esg/waste-records': {
    module: 'esg-waste-records',
    operationId: 'listEsgWasteRecords',
    permission: 'esg.read',
  },
  'GET /esg/waste-records/{id}': {
    module: 'esg-waste-records',
    operationId: 'getEsgWasteRecord',
    permission: 'esg.read',
  },
  'PATCH /esg/waste-records/{id}': {
    module: 'esg-waste-records',
    operationId: 'updateEsgWasteRecord',
    permission: 'esg.manage',
  },
  'POST /esg/waste-records/{id}/deactivate': {
    module: 'esg-waste-records',
    operationId: 'deactivateEsgWasteRecord',
    permission: 'esg.manage',
  },
  'GET /esg/kpi': {
    module: 'esg-read-models',
    operationId: 'getEsgKpi',
    permission: 'esg.read',
  },
  'GET /management/esg-summary': {
    module: 'esg-read-models',
    operationId: 'getManagementEsgSummary',
    permission: 'esg.read',
  },
};

describe('INT-LC-19-BE PART 13 — ESG & Sustainability OpenAPI Closure', () => {
  const app = createApp() as Express;
  const runtime = walkRouter((app as any).router?.stack).map((r) => ({
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
    parameters?: any[];
    errorCodes?: string[];
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
          parameters: [
            ...((methods as Record<string, any>).parameters ?? []),
            ...(op.parameters ?? []),
          ],
          errorCodes: op['x-error-codes'],
        });
      }
    }
  }

  it('1. exact 16 operations in scoped test table', () => {
    assert.equal(Object.keys(SCOPED_OPERATIONS).length, 16);
  });

  it('2. 16/16 scoped operations documented in OpenAPI', () => {
    const openapiByMethodPath = new Map(openapi.map((op) => [`${op.method} ${op.path}`, op]));
    const missing: string[] = [];
    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      if (!op) missing.push(key);
      else assert.equal(op.operationId, expected.operationId, key);
    }
    assert.deepEqual(missing, []);
  });

  it('3. scoped runtime gap is 0', () => {
    const runtimeByMethodCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));
    const missing = Object.keys(SCOPED_OPERATIONS).filter((key) => {
      const [method, path] = key.split(' ');
      return !runtimeByMethodCanon.has(`${method} ${normalizePath(path)}`);
    });
    assert.deepEqual(missing, []);
  });

  it('4. no speculative routes in OpenAPI for scoped operations', () => {
    const runtimeByMethodCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));
    for (const key of Object.keys(SCOPED_OPERATIONS)) {
      const [method, path] = key.split(' ');
      assert.ok(
        runtimeByMethodCanon.has(`${method} ${normalizePath(path)}`),
        `OpenAPI route ${key} must exist in runtime`,
      );
    }
  });

  it('5. unique operationIds across the entire OpenAPI document', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const op of openapi) {
      if (!op.operationId) continue;
      const here = `${op.method} ${op.path}`;
      if (seen.has(op.operationId)) {
        duplicates.push(`${op.operationId} (${here} and ${seen.get(op.operationId)})`);
      } else {
        seen.set(op.operationId, here);
      }
    }
    assert.deepEqual(duplicates, []);
  });

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
      if (typeof o.$ref === 'string' && o.$ref.startsWith('#/components/')) {
        const parts = o.$ref.slice(2).split('/');
        const bucket = parts[1];
        const tail = decodeURIComponent(parts.slice(2).join('/'));
        if (!buckets[bucket]?.has(tail)) broken.push(o.$ref);
      }
      for (const v of Object.values(o)) walk(v);
    }
    walk(SPEC);
    assert.deepEqual(broken, []);
  });

  it('7. permission parity exact', () => {
    const openapiByMethodPath = new Map(openapi.map((op) => [`${op.method} ${op.path}`, op]));
    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, key);
      assert.equal(op.permission, expected.permission, key);
    }
  });

  it('8. canonical 401 present where authenticated and no idempotency or OCC', () => {
    const openapiByMethodPath = new Map(openapi.map((op) => [`${op.method} ${op.path}`, op]));
    for (const key of Object.keys(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, key);
      assert.ok(op.responses?.['401'], `${key} must expose canonical 401`);
      assert.ok(
        op.errorCodes?.includes('AUTHENTICATION_REQUIRED'),
        `${key} must document AUTHENTICATION_REQUIRED`,
      );
      assert.ok(
        op.errorCodes?.includes('PERMISSION_DENIED'),
        `${key} must document PERMISSION_DENIED`,
      );
      const paramNames = (op.parameters ?? []).map((parameter) => {
        if (parameter && typeof parameter === 'object' && '$ref' in parameter) return String(parameter.$ref);
        return String(parameter?.name ?? '');
      });
      assert.equal(
        paramNames.some((name) => /idempotency|if-match|expectedupdatedat|expected-version/i.test(name)),
        false,
        `${key} must not invent idempotency or OCC parameters`,
      );
    }
  });

  it('9. request/response schema parity', () => {
    const schemas = SPEC.components.schemas;
    for (const name of [
      'PublicEsgMetricDefinition',
      'CreateEsgMetricDefinitionRequest',
      'UpdateEsgMetricDefinitionRequest',
      'PublicEsgMetricValue',
      'CreateEsgMetricValueRequest',
      'UpdateEsgMetricValueRequest',
      'PublicEsgWasteRecord',
      'CreateEsgWasteRecordRequest',
      'UpdateEsgWasteRecordRequest',
      'EsgReadModel',
    ]) {
      assert.ok(schemas[name], `${name} schema must exist`);
    }
    assert.deepEqual(schemas.EsgMetricCategory.enum, ['ENERGY', 'WATER', 'WASTE', 'EMISSIONS', 'OTHER']);
    assert.deepEqual(schemas.EsgCalculationMethod.enum, ['CALCULATED', 'MANUAL', 'HYBRID']);
    assert.deepEqual(schemas.EsgMetricStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.EsgPeriodType.enum, ['DAILY', 'MONTHLY', 'QUARTERLY', 'YEARLY']);
    assert.deepEqual(schemas.EsgSourceType.enum, [
      'UTILITY_CONSUMPTION',
      'WASTE_RECORD',
      'MANUAL_ENTRY',
      'IMPORT',
      'SYSTEM',
    ]);
    assert.deepEqual(schemas.EsgDataQuality.enum, ['ACTUAL', 'ESTIMATED', 'MISSING']);
    assert.deepEqual(schemas.EsgVerificationStatus.enum, ['PENDING', 'VERIFIED', 'REJECTED', 'NOT_REQUIRED']);
    assert.deepEqual(schemas.EsgWasteType.enum, [
      'GENERAL',
      'ORGANIC',
      'RECYCLABLE',
      'HAZARDOUS',
      'E_WASTE',
      'CONSTRUCTION',
      'OTHER',
    ]);
    assert.deepEqual(schemas.EsgDisposalMethod.enum, [
      'LANDFILL',
      'RECYCLED',
      'COMPOSTED',
      'INCINERATED',
      'REUSED',
      'DONATED',
      'OTHER',
    ]);
    assert.deepEqual(schemas.EsgWasteSourceType.enum, ['MANUAL', 'IMPORT', 'SYSTEM']);
    assert.deepEqual(schemas.EsgWasteStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.ok(schemas.CreateEsgMetricDefinitionRequest.required.includes('code'));
    assert.ok(schemas.CreateEsgMetricValueRequest.required.includes('periodStart'));
    assert.ok(schemas.CreateEsgWasteRecordRequest.required.includes('quantity'));
    assert.equal(schemas.EsgReadModel.properties.provenance.type, 'string');
    assert.equal(schemas.PublicEsgMetricValue.properties.value.nullable, true);
  });

  it('10. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    assert.equal(platformRuntime.length, 69);
    assert.equal(platformOpenApi.length, 69);
  });

  it('Census validation after PART 13', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));
    assert.equal(openapi.length, 1670, 'Total OpenAPI count must be 1,670 (1654 + 16)');
    assert.equal(platformOpenApi.length, 69);
    assert.equal(operationalOpenApi.length, 1601, 'Operational OpenAPI count must be 1,601 (1585 + 16)');
    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617);
    assert.equal(inScopeOperational.length - operationalOpenApi.length, 16);
    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 15);
  });
});
