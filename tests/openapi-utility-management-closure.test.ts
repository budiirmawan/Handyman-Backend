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
 * INT-LC-19-BE PART 12 — Utility Management OpenAPI Closure.
 *
 * Documents the 56 previously undocumented Utility Management routes.
 * None of these routes implement Idempotency-Key or optimistic concurrency.
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
  'GET /clients/{clientId}/utility-meters': {
    module: 'utility-meters',
    operationId: 'listClientUtilityMeters',
    permission: 'utility_meter.read',
  },
  'PATCH /utility/meters/{id}/status': {
    module: 'utility-meters',
    operationId: 'updateUtilityMeterStatus',
    permission: 'utility_meter.manage',
  },
  'GET /utility/meters/{id}/main-meter': {
    module: 'utility-meter-hierarchies',
    operationId: 'getUtilityMainMeter',
    permission: 'utility_meter.read',
  },
  'GET /utility/meters/{id}/main-meter-history': {
    module: 'utility-meter-hierarchies',
    operationId: 'listUtilityMainMeterHistory',
    permission: 'utility_meter.read',
  },
  'GET /utility/meter-hierarchies/{id}': {
    module: 'utility-meter-hierarchies',
    operationId: 'getUtilityMeterHierarchy',
    permission: 'utility_meter.read',
  },
  'PATCH /utility/meter-hierarchies/{id}': {
    module: 'utility-meter-hierarchies',
    operationId: 'updateUtilityMeterHierarchy',
    permission: 'utility_meter.manage',
  },
  'PATCH /utility/meter-hierarchies/{id}/end': {
    module: 'utility-meter-hierarchies',
    operationId: 'endUtilityMeterHierarchy',
    permission: 'utility_meter.manage',
  },
  'GET /utility/meters/{id}/tenant-assignments': {
    module: 'utility-meter-tenants',
    operationId: 'listUtilityMeterTenantAssignments',
    permission: 'utility_meter.read',
  },
  'POST /utility/meters/{id}/tenant-assignments': {
    module: 'utility-meter-tenants',
    operationId: 'assignUtilityMeterTenant',
    permission: 'utility_meter.manage',
  },
  'GET /utility/meters/{id}/tenant': {
    module: 'utility-meter-tenants',
    operationId: 'getUtilityMeterCurrentTenant',
    permission: 'utility_meter.read',
  },
  'GET /tenant-companies/{tenantCompanyId}/utility-meters': {
    module: 'utility-meter-tenants',
    operationId: 'listTenantCompanyUtilityMeters',
    permission: 'utility_meter.read',
  },
  'GET /spaces/{spaceId}/utility-meters': {
    module: 'utility-meter-tenants',
    operationId: 'listSpaceUtilityMeters',
    permission: 'utility_meter.read',
  },
  'GET /utility/meter-tenant-assignments/{id}': {
    module: 'utility-meter-tenants',
    operationId: 'getUtilityMeterTenantAssignment',
    permission: 'utility_meter.read',
  },
  'PATCH /utility/meter-tenant-assignments/{id}': {
    module: 'utility-meter-tenants',
    operationId: 'updateUtilityMeterTenantAssignment',
    permission: 'utility_meter.manage',
  },
  'PATCH /utility/meter-tenant-assignments/{id}/end': {
    module: 'utility-meter-tenants',
    operationId: 'endUtilityMeterTenantAssignment',
    permission: 'utility_meter.manage',
  },
  'GET /utility/meters/{id}/readings/latest': {
    module: 'utility-meter-readings',
    operationId: 'getLatestUtilityMeterReading',
    permission: 'utility_meter.read',
  },
  'GET /buildings/{buildingId}/meter-readings': {
    module: 'utility-meter-readings',
    operationId: 'listBuildingUtilityMeterReadings',
    permission: 'utility_meter.read',
  },
  'GET /tenant-companies/{tenantCompanyId}/meter-readings': {
    module: 'utility-meter-readings',
    operationId: 'listTenantUtilityMeterReadings',
    permission: 'utility_meter.read',
  },
  'GET /utility/meter-readings/{id}/evidence-requirements': {
    module: 'utility-meter-reading-evidence',
    operationId: 'listUtilityMeterReadingEvidenceRequirements',
    permission: 'utility_meter.read',
  },
  'GET /utility/meter-reading-evidence': {
    module: 'utility-meter-reading-evidence',
    operationId: 'listFilteredUtilityMeterReadingEvidence',
    permission: 'utility_meter.read',
  },
  'GET /utility/meter-reading-evidence/{evidenceId}': {
    module: 'utility-meter-reading-evidence',
    operationId: 'getUtilityMeterReadingEvidence',
    permission: 'utility_meter.read',
  },
  'PATCH /utility/meter-reading-evidence/{evidenceId}': {
    module: 'utility-meter-reading-evidence',
    operationId: 'removeUtilityMeterReadingEvidence',
    permission: 'utility_meter.manage',
  },
  'GET /utility/meters/{id}/consumptions/latest': {
    module: 'utility-meter-consumptions',
    operationId: 'getLatestUtilityMeterConsumption',
    permission: 'utility_meter.read',
  },
  'GET /buildings/{buildingId}/meter-consumptions': {
    module: 'utility-meter-consumptions',
    operationId: 'listBuildingUtilityMeterConsumptions',
    permission: 'utility_meter.read',
  },
  'GET /tenant-companies/{tenantCompanyId}/meter-consumptions': {
    module: 'utility-meter-consumptions',
    operationId: 'listTenantUtilityMeterConsumptions',
    permission: 'utility_meter.read',
  },
  'POST /clients/{clientId}/utility-calculation-bases': {
    module: 'utility-calculations',
    operationId: 'createUtilityCalculationBasis',
    permission: 'utility_meter.manage',
  },
  'GET /clients/{clientId}/utility-calculation-bases': {
    module: 'utility-calculations',
    operationId: 'listUtilityCalculationBases',
    permission: 'utility_meter.read',
  },
  'POST /utility/calculations/{id}/recalculate': {
    module: 'utility-calculations',
    operationId: 'recalculateUtilityCalculation',
    permission: 'utility_meter.manage',
  },
  'GET /utility/meters/{id}/calculations': {
    module: 'utility-calculations',
    operationId: 'listMeterUtilityCalculations',
    permission: 'utility_meter.read',
  },
  'GET /buildings/{buildingId}/utility-calculations': {
    module: 'utility-calculations',
    operationId: 'listBuildingUtilityCalculations',
    permission: 'utility_meter.read',
  },
  'GET /tenant-companies/{tenantCompanyId}/utility-calculations': {
    module: 'utility-calculations',
    operationId: 'listTenantUtilityCalculations',
    permission: 'utility_meter.read',
  },
  'POST /clients/{clientId}/utility-abnormality-rules': {
    module: 'utility-abnormal-consumptions',
    operationId: 'createUtilityAbnormalityRule',
    permission: 'utility_meter.manage',
  },
  'GET /clients/{clientId}/utility-abnormality-rules': {
    module: 'utility-abnormal-consumptions',
    operationId: 'listUtilityAbnormalityRules',
    permission: 'utility_meter.read',
  },
  'POST /utility/consumptions/{id}/abnormality-evaluations': {
    module: 'utility-abnormal-consumptions',
    operationId: 'evaluateUtilityConsumptionAbnormality',
    permission: 'utility_meter.manage',
  },
  'GET /utility/consumptions/{id}/abnormal-consumptions': {
    module: 'utility-abnormal-consumptions',
    operationId: 'listConsumptionAbnormalConsumptions',
    permission: 'utility_meter.read',
  },
  'POST /utility/abnormal-consumptions/{id}/resolve': {
    module: 'utility-abnormal-consumptions',
    operationId: 'resolveUtilityAbnormalConsumption',
    permission: 'utility_meter.manage',
  },
  'POST /utility/abnormal-consumptions/{id}/finding': {
    module: 'utility-abnormal-consumptions',
    operationId: 'linkUtilityAbnormalConsumptionFinding',
    permission: 'utility_meter.manage',
  },
  'GET /utility/abnormal-consumptions/{id}': {
    module: 'utility-abnormal-consumptions',
    operationId: 'getUtilityAbnormalConsumption',
    permission: 'utility_meter.read',
  },
  'GET /utility/meters/{id}/abnormal-consumptions': {
    module: 'utility-abnormal-consumptions',
    operationId: 'listMeterAbnormalConsumptions',
    permission: 'utility_meter.read',
  },
  'GET /buildings/{buildingId}/abnormal-consumptions': {
    module: 'utility-abnormal-consumptions',
    operationId: 'listBuildingAbnormalConsumptions',
    permission: 'utility_meter.read',
  },
  'GET /tenant-companies/{tenantCompanyId}/abnormal-consumptions': {
    module: 'utility-abnormal-consumptions',
    operationId: 'listTenantAbnormalConsumptions',
    permission: 'utility_meter.read',
  },
  'GET /utility/abnormal-consumptions/{id}/verification': {
    module: 'utility-verification',
    operationId: 'getUtilityVerification',
    permission: 'utility_meter.read',
  },
  'POST /utility/abnormal-consumptions/{id}/verification': {
    module: 'utility-verification',
    operationId: 'submitUtilityVerification',
    permission: 'utility_meter.manage',
  },
  'GET /utility/abnormal-consumptions/{id}/verification/latest': {
    module: 'utility-verification',
    operationId: 'getLatestUtilityVerification',
    permission: 'utility_meter.read',
  },
  'GET /utility/abnormal-consumptions/{id}/verifications': {
    module: 'utility-verification',
    operationId: 'listUtilityVerifications',
    permission: 'utility_meter.read',
  },
  'POST /utility/abnormal-consumptions/{id}/verification/open': {
    module: 'utility-verification',
    operationId: 'openUtilityVerification',
    permission: 'utility_meter.manage',
  },
  'GET /utility/aggregations/summary': {
    module: 'utility-aggregations',
    operationId: 'getUtilityAggregationSummary',
    permission: 'utility_meter.read',
  },
  'GET /utility/aggregations/consumption': {
    module: 'utility-aggregations',
    operationId: 'aggregateUtilityConsumption',
    permission: 'utility_meter.read',
  },
  'GET /utility/aggregations/abnormal': {
    module: 'utility-aggregations',
    operationId: 'getUtilityAbnormalAggregation',
    permission: 'utility_meter.read',
  },
  'GET /utility/aggregations/verification-approval': {
    module: 'utility-aggregations',
    operationId: 'getUtilityVerificationApprovalAggregation',
    permission: 'utility_meter.read',
  },
  'GET /utility/reports/kpi': {
    module: 'utility-kpi',
    operationId: 'getUtilityKpi',
    permission: 'utility_kpi.read',
  },
  'GET /utility/meters/{id}/usage-history/latest': {
    module: 'utility-usage-history',
    operationId: 'getLatestUtilityUsageHistory',
    permission: 'utility_meter.read',
  },
  'GET /utility/meters/{id}/usage-history': {
    module: 'utility-usage-history',
    operationId: 'getUtilityMeterUsageHistory',
    permission: 'utility_meter.read',
  },
  'GET /buildings/{buildingId}/usage-history': {
    module: 'utility-usage-history',
    operationId: 'getBuildingUtilityUsageHistory',
    permission: 'utility_meter.read',
  },
  'GET /tenant-companies/{tenantCompanyId}/usage-history': {
    module: 'utility-usage-history',
    operationId: 'getTenantUtilityUsageHistory',
    permission: 'utility_meter.read',
  },
  'GET /utility/usage-history': {
    module: 'utility-usage-history',
    operationId: 'resolveUtilityUsageHistory',
    permission: 'utility_meter.read',
  },
};

describe('INT-LC-19-BE PART 12 — Utility Management OpenAPI Closure', () => {
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

  it('1. exact 56 operations in scoped test table', () => {
    assert.equal(Object.keys(SCOPED_OPERATIONS).length, 56);
  });

  it('2. 56/56 scoped operations documented in OpenAPI', () => {
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
    const requiredSchemas = [
      'UpdateUtilityMeterStatusRequest',
      'PublicUtilityMeterTenantAssignment',
      'AssignUtilityMeterTenantRequest',
      'UtilityMeterReadingEvidenceRequirement',
      'PublicUtilityCalculationBasis',
      'CreateUtilityCalculationBasisRequest',
      'PublicUtilityAbnormalityRule',
      'CreateUtilityAbnormalityRuleRequest',
      'PublicUtilityAbnormalConsumption',
      'UtilityAbnormalityEvaluation',
      'ResolveUtilityAbnormalConsumptionRequest',
      'LinkUtilityAbnormalConsumptionFindingRequest',
      'PublicUtilityVerification',
      'UtilityVerificationState',
      'OpenUtilityVerificationRequest',
      'SubmitUtilityVerificationRequest',
      'UtilityAggregationSummary',
      'UtilityAggregationBucket',
      'UtilityAbnormalSummary',
      'UtilityVerificationApprovalSummary',
      'PublicUtilityKpi',
      'PublicUtilityUsageHistory',
      'PublicUtilityUsageHistoryEntry',
    ];
    for (const name of requiredSchemas) {
      assert.ok(schemas[name], `${name} schema must exist`);
    }
    assert.deepEqual(schemas.UtilityMeterTenantAssignmentStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.UtilityCalculationBasisStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.UtilityAbnormalityType.enum, [
      'HIGH_USAGE',
      'LOW_USAGE',
      'ZERO_USAGE',
      'NEGATIVE_OR_INVALID',
      'SUDDEN_CHANGE',
    ]);
    assert.deepEqual(schemas.UtilityAbnormalityComparisonMode.enum, ['ABSOLUTE', 'PERCENT_OF_BASELINE']);
    assert.deepEqual(schemas.UtilityAbnormalConsumptionStatus.enum, ['OPEN', 'RESOLVED', 'DISMISSED']);
    assert.deepEqual(schemas.UtilityVerificationDecision.enum, ['APPROVED', 'REJECTED', 'REWORK_REQUIRED']);
    assert.deepEqual(schemas.UtilityVerificationStatus.enum, ['PENDING', 'COMPLETED']);
    assert.deepEqual(schemas.UtilityAggregationMeterScope.enum, ['EXCLUDE_SUB_METERS', 'ALL_METERS']);
    assert.deepEqual(schemas.UtilityAggregationGrouping.enum, [
      'UTILITY_TYPE',
      'METER',
      'BUILDING',
      'TENANT',
      'PERIOD',
    ]);
    assert.deepEqual(schemas.UtilityKpiInterval.enum, ['DAY', 'MONTH', 'YEAR']);
    assert.ok(schemas.CreateUtilityCalculationBasisRequest.required.includes('rateValue'));
    assert.ok(schemas.ResolveUtilityAbnormalConsumptionRequest.required.includes('status'));
    assert.ok(schemas.SubmitUtilityVerificationRequest.required.includes('decision'));
    assert.ok(schemas.PublicUtilityKpi.required.includes('electricity'));
    assert.equal(schemas.PublicUtilityAbnormalConsumption.properties.availableActions.type, 'array');
  });

  it('10. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    assert.equal(platformRuntime.length, 69);
    assert.equal(platformOpenApi.length, 69);
  });

  it('Census validation after PART 12', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));
    assert.equal(openapi.length, 1654, 'Total OpenAPI count must be 1,654 (1598 + 56)');
    assert.equal(platformOpenApi.length, 69);
    assert.equal(operationalOpenApi.length, 1585, 'Operational OpenAPI count must be 1,585 (1529 + 56)');
    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617);
    assert.equal(inScopeOperational.length - operationalOpenApi.length, 32);
    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 31);
  });
});
