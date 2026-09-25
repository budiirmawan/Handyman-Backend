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
 * INT-LC-19-BE PART 10 — Procurement & Vendor Settlement OpenAPI Closure.
 *
 * Scope:
 *   - purchase-requests (5 routes)
 *   - purchase-order-readiness (4 routes)
 *   - vendor-selection-readiness (3 routes)
 *   - vendor-service-costs (6 routes)
 *   - vendor-service-reports (5 routes)
 *   - vendor-checklist-bindings (5 routes)
 *   - basic-expenses (6 routes)
 * Total undocumented routes: exact 34.
 *
 * Required proofs:
 *  1. 34/34 documented
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
  // purchase-requests (5)
  'POST /buildings/{buildingId}/purchase-requests': {
    module: 'purchase-requests',
    operationId: 'createPurchaseRequest',
    permission: 'purchase_request.manage',
    summary: 'Create a Purchase Request in a Building',
  },
  'GET /buildings/{buildingId}/purchase-requests': {
    module: 'purchase-requests',
    operationId: 'listBuildingPurchaseRequests',
    permission: 'purchase_request.read',
    summary: 'List Purchase Requests in a Building',
  },
  'GET /purchase-requests/{id}': {
    module: 'purchase-requests',
    operationId: 'getPurchaseRequest',
    permission: 'purchase_request.read',
    summary: 'Get a Purchase Request by ID',
  },
  'PATCH /purchase-requests/{id}': {
    module: 'purchase-requests',
    operationId: 'updatePurchaseRequest',
    permission: 'purchase_request.manage',
    summary: 'Update a Purchase Request',
  },
  'POST /purchase-requests/{id}/cancel': {
    module: 'purchase-requests',
    operationId: 'cancelPurchaseRequest',
    permission: 'purchase_request.manage',
    summary: 'Cancel a Purchase Request',
  },

  // purchase-order-readiness (4)
  'GET /buildings/{buildingId}/po-readiness': {
    module: 'purchase-order-readiness',
    operationId: 'listPOReadinessByBuilding',
    permission: 'po_readiness.read',
    summary: 'List Purchase Order Readiness evaluations for a Building',
  },
  'GET /purchase-requests/{purchaseRequestId}/po-readiness': {
    module: 'purchase-order-readiness',
    operationId: 'listPOReadinessByPurchaseRequest',
    permission: 'po_readiness.read',
    summary: 'List Purchase Order Readiness evaluations for a Purchase Request',
  },
  'GET /service-requests/{serviceRequestId}/po-readiness': {
    module: 'purchase-order-readiness',
    operationId: 'listPOReadinessByServiceRequest',
    permission: 'po_readiness.read',
    summary: 'List Purchase Order Readiness evaluations for a Service Request',
  },
  'GET /vendors/{vendorId}/po-readiness': {
    module: 'purchase-order-readiness',
    operationId: 'listPOReadinessByVendor',
    permission: 'po_readiness.read',
    summary: 'List Purchase Order Readiness evaluations for a Vendor',
  },

  // vendor-selection-readiness (3)
  'GET /purchase-requests/{purchaseRequestId}/vendor-selections': {
    module: 'vendor-selection-readiness',
    operationId: 'listVendorSelectionsByPurchaseRequest',
    permission: 'vendor_selection.read',
    summary: 'List Vendor Selection evaluations for a Purchase Request',
  },
  'GET /service-requests/{serviceRequestId}/vendor-selections': {
    module: 'vendor-selection-readiness',
    operationId: 'listVendorSelectionsByServiceRequest',
    permission: 'vendor_selection.read',
    summary: 'List Vendor Selection evaluations for a Service Request',
  },
  'GET /vendors/{vendorId}/vendor-selections': {
    module: 'vendor-selection-readiness',
    operationId: 'listVendorSelectionsByVendor',
    permission: 'vendor_selection.read',
    summary: 'List Vendor Selection evaluations for a Vendor',
  },

  // vendor-service-costs (6)
  'POST /vendors/{vendorId}/costs': {
    module: 'vendor-service-costs',
    operationId: 'createVendorServiceCost',
    permission: 'vendor_service_cost.manage',
    summary: 'Record a service cost for a Vendor',
  },
  'GET /vendor-service-costs': {
    module: 'vendor-service-costs',
    operationId: 'listVendorServiceCosts',
    permission: 'vendor_service_cost.read',
    summary: 'List vendor service costs',
  },
  'GET /vendor-service-costs/{id}': {
    module: 'vendor-service-costs',
    operationId: 'getVendorServiceCost',
    permission: 'vendor_service_cost.read',
    summary: 'Get a vendor service cost by ID',
  },
  'PATCH /vendor-service-costs/{id}': {
    module: 'vendor-service-costs',
    operationId: 'updateVendorServiceCost',
    permission: 'vendor_service_cost.manage',
    summary: 'Update a draft vendor service cost',
  },
  'POST /vendor-service-costs/{id}/finalize': {
    module: 'vendor-service-costs',
    operationId: 'finalizeVendorServiceCost',
    permission: 'vendor_service_cost.manage',
    summary: 'Finalize a vendor service cost',
  },
  'POST /vendor-service-costs/{id}/cancel': {
    module: 'vendor-service-costs',
    operationId: 'cancelVendorServiceCost',
    permission: 'vendor_service_cost.manage',
    summary: 'Cancel a vendor service cost',
  },

  // vendor-service-reports (5)
  'POST /vendor-service-reports': {
    module: 'vendor-service-reports',
    operationId: 'createVendorServiceReport',
    permission: 'vendor.manage',
    summary: 'Create a Vendor Service Report',
  },
  'GET /vendor-service-reports': {
    module: 'vendor-service-reports',
    operationId: 'listVendorServiceReports',
    permission: 'vendor.read',
    summary: 'List Vendor Service Reports',
  },
  'GET /vendor-service-reports/{reportId}': {
    module: 'vendor-service-reports',
    operationId: 'getVendorServiceReport',
    permission: 'vendor.read',
    summary: 'Get a Vendor Service Report by ID',
  },
  'PATCH /vendor-service-reports/{reportId}': {
    module: 'vendor-service-reports',
    operationId: 'updateVendorServiceReport',
    permission: 'vendor.manage',
    summary: 'Update a draft Vendor Service Report',
  },
  'POST /vendor-service-reports/{reportId}/finalize': {
    module: 'vendor-service-reports',
    operationId: 'finalizeVendorServiceReport',
    permission: 'vendor.manage',
    summary: 'Finalize a Vendor Service Report',
  },

  // vendor-checklist-bindings (5)
  'POST /vendor-checklist-bindings': {
    module: 'vendor-checklist-bindings',
    operationId: 'createVendorChecklistBinding',
    permission: 'vendor.manage',
    summary: 'Create a Vendor Checklist Binding',
  },
  'GET /vendor-checklist-bindings': {
    module: 'vendor-checklist-bindings',
    operationId: 'listVendorChecklistBindings',
    permission: 'vendor.read',
    summary: 'List Vendor Checklist Bindings',
  },
  'GET /vendor-checklist-bindings/{bindingId}': {
    module: 'vendor-checklist-bindings',
    operationId: 'getVendorChecklistBinding',
    permission: 'vendor.read',
    summary: 'Get a Vendor Checklist Binding by ID',
  },
  'POST /vendor-checklist-bindings/{bindingId}/start': {
    module: 'vendor-checklist-bindings',
    operationId: 'startVendorChecklistExecution',
    permission: 'vendor.manage',
    summary: 'Start execution for a Vendor Checklist Binding',
  },
  'GET /vendor-checklist-executions/{executionId}': {
    module: 'vendor-checklist-bindings',
    operationId: 'getVendorChecklistExecutionContext',
    permission: 'vendor.read',
    summary: 'Get execution context for a Vendor Checklist Execution',
  },

  // basic-expenses (6)
  'POST /basic-expenses': {
    module: 'basic-expenses',
    operationId: 'createBasicExpense',
    permission: 'basic_expense.manage',
    summary: 'Create a Basic Expense',
  },
  'GET /basic-expenses': {
    module: 'basic-expenses',
    operationId: 'listBasicExpenses',
    permission: 'basic_expense.read',
    summary: 'List Basic Expenses',
  },
  'GET /basic-expenses/{id}': {
    module: 'basic-expenses',
    operationId: 'getBasicExpense',
    permission: 'basic_expense.read',
    summary: 'Get a Basic Expense by ID',
  },
  'PATCH /basic-expenses/{id}': {
    module: 'basic-expenses',
    operationId: 'updateBasicExpense',
    permission: 'basic_expense.manage',
    summary: 'Update a draft Basic Expense',
  },
  'POST /basic-expenses/{id}/finalize': {
    module: 'basic-expenses',
    operationId: 'finalizeBasicExpense',
    permission: 'basic_expense.manage',
    summary: 'Finalize a Basic Expense',
  },
  'POST /basic-expenses/{id}/cancel': {
    module: 'basic-expenses',
    operationId: 'cancelBasicExpense',
    permission: 'basic_expense.manage',
    summary: 'Cancel a Basic Expense',
  },
};

describe('INT-LC-19-BE PART 10 — Procurement & Vendor Settlement OpenAPI Closure', () => {
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

  // 1. Exactly 34 scoped operations defined in test table
  it('1. exact 34 operations in scoped test table', () => {
    assert.equal(
      Object.keys(SCOPED_OPERATIONS).length,
      34,
      'Scoped operations table must have exactly 34 operations',
    );
  });

  // 2. All 34 scoped operations documented in OpenAPI
  it('2. 34/34 scoped operations documented in OpenAPI', () => {
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
    const scopedPatterns = [
      /^\/buildings\/[^/]+\/purchase-requests$/,
      /^\/purchase-requests\/[^/]+$/,
      /^\/purchase-requests\/[^/]+\/cancel$/,
      /^\/buildings\/[^/]+\/po-readiness$/,
      /^\/purchase-requests\/[^/]+\/po-readiness$/,
      /^\/service-requests\/[^/]+\/po-readiness$/,
      /^\/vendors\/[^/]+\/po-readiness$/,
      /^\/purchase-requests\/[^/]+\/vendor-selections$/,
      /^\/service-requests\/[^/]+\/vendor-selections$/,
      /^\/vendors\/[^/]+\/vendor-selections$/,
      /^\/vendors\/[^/]+\/costs$/,
      /^\/vendor-service-costs$/,
      /^\/vendor-service-costs\/[^/]+$/,
      /^\/vendor-service-costs\/[^/]+\/finalize$/,
      /^\/vendor-service-costs\/[^/]+\/cancel$/,
      /^\/vendor-service-reports$/,
      /^\/vendor-service-reports\/[^/]+$/,
      /^\/vendor-service-reports\/[^/]+\/finalize$/,
      /^\/vendor-checklist-bindings$/,
      /^\/vendor-checklist-bindings\/[^/]+$/,
      /^\/vendor-checklist-bindings\/[^/]+\/start$/,
      /^\/vendor-checklist-executions\/[^/]+$/,
      /^\/basic-expenses$/,
      /^\/basic-expenses\/[^/]+$/,
      /^\/basic-expenses\/[^/]+\/finalize$/,
      /^\/basic-expenses\/[^/]+\/cancel$/,
    ];

    const scopedRuntime = runtime.filter((r) =>
      scopedPatterns.some((pattern) => pattern.test(r.path)),
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

    assert.ok(schemas.PurchaseRequestStatus, 'PurchaseRequestStatus schema must exist');
    assert.ok(schemas.PurchaseRequestPriority, 'PurchaseRequestPriority schema must exist');
    assert.ok(schemas.PublicPurchaseRequest, 'PublicPurchaseRequest schema must exist');
    assert.ok(schemas.CreatePurchaseRequestRequest, 'CreatePurchaseRequestRequest schema must exist');
    assert.ok(schemas.UpdatePurchaseRequestRequest, 'UpdatePurchaseRequestRequest schema must exist');

    assert.ok(schemas.VendorServiceCostStatus, 'VendorServiceCostStatus schema must exist');
    assert.ok(schemas.VendorServiceCostContext, 'VendorServiceCostContext schema must exist');
    assert.ok(schemas.PublicVendorServiceCost, 'PublicVendorServiceCost schema must exist');
    assert.ok(schemas.CreateVendorServiceCostRequest, 'CreateVendorServiceCostRequest schema must exist');
    assert.ok(schemas.UpdateVendorServiceCostRequest, 'UpdateVendorServiceCostRequest schema must exist');

    assert.ok(schemas.ServiceReportStatus, 'ServiceReportStatus schema must exist');
    assert.ok(schemas.PublicVendorServiceReport, 'PublicVendorServiceReport schema must exist');
    assert.ok(schemas.CreateVendorServiceReportRequest, 'CreateVendorServiceReportRequest schema must exist');
    assert.ok(schemas.UpdateVendorServiceReportRequest, 'UpdateVendorServiceReportRequest schema must exist');

    assert.ok(schemas.VendorChecklistBindingStatus, 'VendorChecklistBindingStatus schema must exist');
    assert.ok(schemas.PublicVendorChecklistBinding, 'PublicVendorChecklistBinding schema must exist');
    assert.ok(schemas.CreateVendorChecklistBindingRequest, 'CreateVendorChecklistBindingRequest schema must exist');
    assert.ok(schemas.PublicVendorChecklistExecution, 'PublicVendorChecklistExecution schema must exist');
    assert.ok(schemas.PublicVendorChecklistExecutionContext, 'PublicVendorChecklistExecutionContext schema must exist');

    assert.ok(schemas.BasicExpenseStatus, 'BasicExpenseStatus schema must exist');
    assert.ok(schemas.PublicBasicExpense, 'PublicBasicExpense schema must exist');
    assert.ok(schemas.CreateBasicExpenseRequest, 'CreateBasicExpenseRequest schema must exist');
    assert.ok(schemas.UpdateBasicExpenseRequest, 'UpdateBasicExpenseRequest schema must exist');

    assert.ok(SPEC.components.parameters.VendorServiceCostIdPath, 'VendorServiceCostIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.ServiceReportIdPath, 'ServiceReportIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.VendorChecklistBindingIdPath, 'VendorChecklistBindingIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.VendorChecklistExecutionIdPath, 'VendorChecklistExecutionIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.BasicExpenseIdPath, 'BasicExpenseIdPath parameter must exist');
  });

  // 10. /platform/* untouched (69/69)
  it('10. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
  });

  // Census validation after PART 10
  it('Census validation after PART 10', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

    assert.equal(openapi.length, 1531, 'Total OpenAPI count must be 1,531 (1497 + 34)');
    assert.equal(platformOpenApi.length, 69, 'Platform OpenAPI count must be 69');
    assert.equal(operationalOpenApi.length, 1462, 'Operational OpenAPI count must be 1,462 (1428 + 34)');

    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be 1,617');

    const arithmeticGap = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(arithmeticGap, 155, 'Arithmetic runtime gap must be 155 (1617 - 1462)');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 154, 'Distinct unmapped operational endpoints must be 154');
  });
});
