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
 * INT-LC-19-BE PART 09 — Warehouse & Inventory Control OpenAPI Closure.
 *
 * Scope:
 *   - inventory-warehouses (3 routes)
 *   - inventory-items (3 routes)
 *   - inventory-minimum-stocks (7 routes)
 *   - inventory-stock-adjustments (6 routes)
 *   - inventory-stock-transfers (6 routes)
 * Total undocumented routes: exact 25.
 *
 * Required proofs:
 *  1. 25/25 documented
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
  // inventory-warehouses (3)
  'POST /buildings/{buildingId}/warehouses': {
    module: 'inventory-warehouses',
    operationId: 'createWarehouse',
    permission: 'inventory_warehouse.manage',
    summary: 'Create a Warehouse in a Building',
  },
  'PATCH /warehouses/{warehouseId}': {
    module: 'inventory-warehouses',
    operationId: 'updateWarehouse',
    permission: 'inventory_warehouse.manage',
    summary: 'Update a Warehouse',
  },
  'PATCH /warehouses/{warehouseId}/status': {
    module: 'inventory-warehouses',
    operationId: 'updateWarehouseStatus',
    permission: 'inventory_warehouse.manage',
    summary: 'Update Warehouse status',
  },

  // inventory-items (3)
  'POST /clients/{clientId}/inventory-items': {
    module: 'inventory-items',
    operationId: 'createInventoryItem',
    permission: 'inventory_item.manage',
    summary: 'Create an Inventory Item for a Client',
  },
  'PATCH /inventory-items/{itemId}': {
    module: 'inventory-items',
    operationId: 'updateInventoryItem',
    permission: 'inventory_item.manage',
    summary: 'Update an Inventory Item',
  },
  'PATCH /inventory-items/{itemId}/status': {
    module: 'inventory-items',
    operationId: 'updateInventoryItemStatus',
    permission: 'inventory_item.manage',
    summary: 'Update Inventory Item status',
  },

  // inventory-minimum-stocks (7)
  'POST /warehouses/{warehouseId}/minimum-stocks': {
    module: 'inventory-minimum-stocks',
    operationId: 'setWarehouseMinimumStock',
    permission: 'inventory_stock.manage',
    summary: 'Set minimum stock threshold for a warehouse',
  },
  'POST /clients/{clientId}/minimum-stocks': {
    module: 'inventory-minimum-stocks',
    operationId: 'setClientMinimumStock',
    permission: 'inventory_stock.manage',
    summary: 'Set minimum stock threshold for a client',
  },
  'PATCH /minimum-stocks/{id}': {
    module: 'inventory-minimum-stocks',
    operationId: 'updateMinimumStock',
    permission: 'inventory_stock.manage',
    summary: 'Update minimum stock threshold',
  },
  'GET /warehouses/{warehouseId}/minimum-stocks': {
    module: 'inventory-minimum-stocks',
    operationId: 'listWarehouseMinimumStocks',
    permission: 'inventory_stock.read',
    summary: 'List minimum stock thresholds for a warehouse',
  },
  'GET /buildings/{buildingId}/minimum-stocks': {
    module: 'inventory-minimum-stocks',
    operationId: 'listBuildingMinimumStocks',
    permission: 'inventory_stock.read',
    summary: 'List minimum stock thresholds for a building',
  },
  'GET /clients/{clientId}/minimum-stocks': {
    module: 'inventory-minimum-stocks',
    operationId: 'listClientMinimumStocks',
    permission: 'inventory_stock.read',
    summary: 'List minimum stock thresholds for a client',
  },
  'GET /minimum-stocks/{id}': {
    module: 'inventory-minimum-stocks',
    operationId: 'getMinimumStock',
    permission: 'inventory_stock.read',
    summary: 'Get minimum stock threshold by ID',
  },

  // inventory-stock-adjustments (6)
  'POST /warehouses/{warehouseId}/adjustments': {
    module: 'inventory-stock-adjustments',
    operationId: 'postWarehouseAdjustment',
    permission: 'inventory_stock.manage',
    summary: 'Post stock adjustment for a warehouse',
  },
  'POST /clients/{clientId}/adjustments': {
    module: 'inventory-stock-adjustments',
    operationId: 'postClientAdjustment',
    permission: 'inventory_stock.manage',
    summary: 'Post stock adjustment for a client',
  },
  'GET /warehouses/{warehouseId}/adjustments': {
    module: 'inventory-stock-adjustments',
    operationId: 'listWarehouseAdjustments',
    permission: 'inventory_stock.read',
    summary: 'List stock adjustments for a warehouse',
  },
  'GET /buildings/{buildingId}/adjustments': {
    module: 'inventory-stock-adjustments',
    operationId: 'listBuildingAdjustments',
    permission: 'inventory_stock.read',
    summary: 'List stock adjustments for a building',
  },
  'GET /clients/{clientId}/adjustments': {
    module: 'inventory-stock-adjustments',
    operationId: 'listClientAdjustments',
    permission: 'inventory_stock.read',
    summary: 'List stock adjustments for a client',
  },
  'GET /adjustments/{id}': {
    module: 'inventory-stock-adjustments',
    operationId: 'getAdjustment',
    permission: 'inventory_stock.read',
    summary: 'Get stock adjustment by ID',
  },

  // inventory-stock-transfers (6)
  'POST /stock-transfers': {
    module: 'inventory-stock-transfers',
    operationId: 'createStockTransfer',
    permission: 'inventory_stock.manage',
    summary: 'Create a stock transfer',
  },
  'POST /clients/{clientId}/stock-transfers': {
    module: 'inventory-stock-transfers',
    operationId: 'createClientStockTransfer',
    permission: 'inventory_stock.manage',
    summary: 'Create a stock transfer for a client',
  },
  'GET /stock-transfers': {
    module: 'inventory-stock-transfers',
    operationId: 'listStockTransfers',
    permission: 'inventory_stock.read',
    summary: 'List stock transfers',
  },
  'GET /clients/{clientId}/stock-transfers': {
    module: 'inventory-stock-transfers',
    operationId: 'listClientStockTransfers',
    permission: 'inventory_stock.read',
    summary: 'List stock transfers for a client',
  },
  'GET /warehouses/{warehouseId}/stock-transfers': {
    module: 'inventory-stock-transfers',
    operationId: 'listWarehouseStockTransfers',
    permission: 'inventory_stock.read',
    summary: 'List stock transfers for a warehouse',
  },
  'GET /stock-transfers/{id}': {
    module: 'inventory-stock-transfers',
    operationId: 'getStockTransfer',
    permission: 'inventory_stock.read',
    summary: 'Get stock transfer by ID',
  },
};

describe('INT-LC-19-BE PART 09 — Warehouse & Inventory Control OpenAPI Closure', () => {
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

  // 1. Exactly 25 scoped operations defined in test table
  it('1. exact 25 operations in scoped test table', () => {
    assert.equal(
      Object.keys(SCOPED_OPERATIONS).length,
      25,
      'Scoped operations table must have exactly 25 operations',
    );
  });

  // 2. All 25 scoped operations documented in OpenAPI
  it('2. 25/25 scoped operations documented in OpenAPI', () => {
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
      /^\/buildings\/[^/]+\/warehouses$/,
      /^\/warehouses\/[^/]+$/,
      /^\/warehouses\/[^/]+\/status$/,
      /^\/clients\/[^/]+\/inventory-items$/,
      /^\/inventory-items\/[^/]+$/,
      /^\/inventory-items\/[^/]+\/status$/,
      /^\/warehouses\/[^/]+\/minimum-stocks$/,
      /^\/clients\/[^/]+\/minimum-stocks$/,
      /^\/buildings\/[^/]+\/minimum-stocks$/,
      /^\/minimum-stocks\/[^/]+$/,
      /^\/warehouses\/[^/]+\/adjustments$/,
      /^\/clients\/[^/]+\/adjustments$/,
      /^\/buildings\/[^/]+\/adjustments$/,
      /^\/adjustments\/[^/]+$/,
      /^\/stock-transfers$/,
      /^\/clients\/[^/]+\/stock-transfers$/,
      /^\/warehouses\/[^/]+\/stock-transfers$/,
      /^\/stock-transfers\/[^/]+$/,
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

    assert.ok(schemas.CreateWarehouseRequest, 'CreateWarehouseRequest schema must exist');
    assert.ok(schemas.UpdateWarehouseRequest, 'UpdateWarehouseRequest schema must exist');
    assert.ok(schemas.UpdateWarehouseStatusRequest, 'UpdateWarehouseStatusRequest schema must exist');
    assert.ok(schemas.CreateInventoryItemRequest, 'CreateInventoryItemRequest schema must exist');
    assert.ok(schemas.UpdateInventoryItemRequest, 'UpdateInventoryItemRequest schema must exist');
    assert.ok(schemas.UpdateInventoryItemStatusRequest, 'UpdateInventoryItemStatusRequest schema must exist');
    assert.ok(schemas.MinimumStockStatus, 'MinimumStockStatus schema must exist');
    assert.ok(schemas.StockReadiness, 'StockReadiness schema must exist');
    assert.ok(schemas.PublicMinimumStock, 'PublicMinimumStock schema must exist');
    assert.ok(schemas.SetWarehouseMinimumStockRequest, 'SetWarehouseMinimumStockRequest schema must exist');
    assert.ok(schemas.SetClientMinimumStockRequest, 'SetClientMinimumStockRequest schema must exist');
    assert.ok(schemas.UpdateMinimumStockRequest, 'UpdateMinimumStockRequest schema must exist');
    assert.ok(schemas.AdjustmentType, 'AdjustmentType schema must exist');
    assert.ok(schemas.PublicStockAdjustment, 'PublicStockAdjustment schema must exist');
    assert.ok(schemas.PostWarehouseAdjustmentRequest, 'PostWarehouseAdjustmentRequest schema must exist');
    assert.ok(schemas.PostClientAdjustmentRequest, 'PostClientAdjustmentRequest schema must exist');
    assert.ok(schemas.TransferStatus, 'TransferStatus schema must exist');
    assert.ok(schemas.PublicStockTransfer, 'PublicStockTransfer schema must exist');
    assert.ok(schemas.CreateStockTransferRequest, 'CreateStockTransferRequest schema must exist');

    assert.ok(SPEC.components.parameters.MinimumStockIdPath, 'MinimumStockIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.StockAdjustmentIdPath, 'StockAdjustmentIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.StockTransferIdPath, 'StockTransferIdPath parameter must exist');
  });

  // 10. /platform/* untouched (69/69)
  it('10. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
  });

  // Census validation after PART 09
  it('Census validation after PART 09', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

    assert.equal(openapi.length, 1497, 'Total OpenAPI count must be 1,497 (1472 + 25)');
    assert.equal(platformOpenApi.length, 69, 'Platform OpenAPI count must be 69');
    assert.equal(operationalOpenApi.length, 1428, 'Operational OpenAPI count must be 1,428 (1403 + 25)');

    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be 1,617');

    const arithmeticGap = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(arithmeticGap, 189, 'Arithmetic runtime gap must be 189 (1617 - 1428)');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 188, 'Distinct unmapped operational endpoints must be 188');
  });
});
