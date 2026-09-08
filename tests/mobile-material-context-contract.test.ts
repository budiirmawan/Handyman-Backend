import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-01 PART 04 — Work Order material context + verification
 * composition OpenAPI contract.
 *
 * Documentation-only checks (no database):
 *  - the newly published BE-16A/B/H reference reads exist in a route file and
 *    carry their exact permission + Building scope;
 *  - the routes deliberately left unpublished in those modules are pinned, so
 *    the exclusion cannot rot silently;
 *  - the Work Order material *composition* it relies on is genuinely already
 *    published (usage / issue visibility, stock ledger + availability,
 *    approved-quantity chain, cost summary, Work Order verification);
 *  - the quantity vocabulary stays distinct (required vs approved vs issued);
 *  - `/mobile/verification` still exposes exactly the backend's three target
 *    types — WORK_ORDER is documented as MISSING, never invented;
 *  - unauthenticated calls are rejected by auth middleware (401, never 404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

function toExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/** Collapses param names so `:id` and `{itemId}` compare equal. */
function canonical(route: string): string {
  return route.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');
}

function registeredRoutes(moduleDir: string): Set<string> {
  const dir = resolve(__dirname, '../src/modules', moduleDir);
  const routes = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.routes.ts')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    const pattern = /router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      routes.add(`${match[1]} ${match[2]}`);
    }
  }
  return routes;
}

/** BE-16 master-data modules touched by PART 04 (reads published only). */
const MASTER_MODULES = [
  'inventory-items',
  'inventory-warehouses',
  'inventory-asset-spare-parts',
];

/** PART 04 published surface — existing BE-16A/B/H read routes only. */
const DOCUMENTED_MASTER_PATHS: Record<string, string[]> = {
  '/clients/{clientId}/inventory-items': ['get'],
  '/inventory-items/{itemId}': ['get'],
  '/buildings/{buildingId}/warehouses': ['get'],
  '/clients/{clientId}/warehouses': ['get'],
  '/warehouses/{warehouseId}': ['get'],
  '/assets/{assetId}/spare-parts': ['get'],
  '/inventory-items/{itemId}/asset-bindings': ['get'],
  '/asset-spare-parts/{id}': ['get'],
};

const EXPECTED_PERMISSIONS: Record<string, string> = {
  listClientInventoryItems: 'inventory_item.read',
  getInventoryItem: 'inventory_item.read',
  listBuildingWarehouses: 'inventory_warehouse.read',
  listClientWarehouses: 'inventory_warehouse.read',
  getWarehouse: 'inventory_warehouse.read',
  listAssetSpareParts: 'asset.read',
  listInventoryItemAssetBindings: 'inventory_item.read',
  getAssetSparePart: 'asset.read',
};

/**
 * Master-data WRITE routes deliberately left unpublished: administration of
 * the item / warehouse / spare-part masters is not mobile field execution.
 * Pinned so the exclusion is explicit rather than accidental.
 */
const DELIBERATELY_UNPUBLISHED = [
  'post /clients/:clientId/inventory-items',
  'patch /inventory-items/:id',
  'patch /inventory-items/:id/status',
  'post /buildings/:buildingId/warehouses',
  'patch /warehouses/:id',
  'patch /warehouses/:id/status',
  'post /assets/:assetId/spare-parts',
  'patch /asset-spare-parts/:id',
];

/**
 * The already-published Work Order material + verification composition PART 04
 * builds on. These are NOT re-published by PART 04 — the test asserts they are
 * present so the composition it documents cannot silently break.
 */
const COMPOSITION_OPERATIONS: Record<string, string> = {
  // material usage / issue visibility (BE-16I + CR-BE-MAT-01)
  recordWorkOrderMaterialUsage: 'POST /work-orders/{workOrderId}/material-usages',
  listWorkOrderMaterialUsages: 'GET /work-orders/{workOrderId}/material-usages',
  getWorkOrderMaterialUsage: 'GET /work-order-material-usages/{id}',
  getWorkOrderMaterialCostSummary:
    'GET /work-orders/{workOrderId}/material-cost-summary',
  // availability / authoritative ledger (BE-16C/D)
  listWarehouseStockBalances: 'GET /warehouses/{warehouseId}/stock-balances',
  listWarehouseStockMovements: 'GET /warehouses/{warehouseId}/stock-movements',
  // approved quantity chain (BE-17B + CR-BE-MAT-01 PART 02)
  getMaterialRequest: 'GET /material-requests/{id}',
  listWorkOrderProcurementBindings:
    'GET /work-orders/{workOrderId}/procurement-bindings',
  // Work Order verification composition (BE-08I over the BE-07 review primitive)
  getWorkOrderVerification: 'GET /work-orders/{workOrderId}/verification',
  submitWorkOrderVerification: 'POST /work-orders/{workOrderId}/verification',
  getWorkOrderCompletion: 'GET /work-orders/{workOrderId}/completion',
};

function documentedOperationIds(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, any>)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (op?.operationId) {
        map.set(op.operationId, `${method.toUpperCase()} ${path}`);
      }
    }
  }
  return map;
}

describe('CR-BE-MOB-01 PART 04 — Work Order material context OpenAPI contract', () => {
  it('declares the Inventory Master tag and every PART 04 path + method', () => {
    assert.ok(
      (spec.tags ?? []).some(
        (t: { name: string }) => t.name === 'Inventory Master',
      ),
      'Inventory Master tag required',
    );
    for (const [path, methods] of Object.entries(DOCUMENTED_MASTER_PATHS)) {
      assert.ok(spec.paths[path], `missing path ${path}`);
      for (const method of methods) {
        const op = spec.paths[path][method];
        assert.ok(op, `missing ${method} ${path}`);
        assert.ok(op.operationId, `missing operationId on ${method} ${path}`);
        assert.ok(op.security, `missing security on ${method} ${path}`);
        assert.match(
          String(op.description ?? op.summary),
          /./,
          `missing description on ${method} ${path}`,
        );
        assert.ok(
          (op.tags ?? []).includes('Inventory Master'),
          `${method} ${path} must be tagged Inventory Master`,
        );
      }
    }
  });

  it('publishes the expected stable operationIds', () => {
    const found = new Set<string>();
    for (const [path, methods] of Object.entries(DOCUMENTED_MASTER_PATHS)) {
      for (const method of methods) {
        found.add(spec.paths[path][method].operationId);
      }
    }
    assert.deepEqual(
      [...found].sort(),
      Object.keys(EXPECTED_PERMISSIONS).sort(),
    );
  });

  it('documents only routes that exist in the BE-16 master modules', () => {
    const registered = new Set<string>();
    for (const moduleDir of MASTER_MODULES) {
      for (const route of registeredRoutes(moduleDir)) {
        registered.add(canonical(route));
      }
    }
    for (const [path, methods] of Object.entries(DOCUMENTED_MASTER_PATHS)) {
      for (const method of methods) {
        assert.ok(
          registered.has(canonical(`${method} ${toExpress(path)}`)),
          `documented ${method} ${path} is not a registered backend route`,
        );
      }
    }
  });

  it('accounts for every BE-16 master route as published or explicitly excluded', () => {
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(DOCUMENTED_MASTER_PATHS)) {
      for (const method of methods) {
        documented.add(canonical(`${method} ${toExpress(path)}`));
      }
    }
    const excluded = new Set(DELIBERATELY_UNPUBLISHED.map(canonical));
    const registered: string[] = [];
    for (const moduleDir of MASTER_MODULES) {
      for (const route of registeredRoutes(moduleDir)) registered.push(route);
    }
    for (const route of registered) {
      const key = canonical(route);
      assert.ok(
        documented.has(key) || excluded.has(key),
        `route ${route} is neither published nor pinned as excluded`,
      );
    }
    // The exclusion list must not name routes that no longer exist.
    const registeredCanonical = new Set(registered.map(canonical));
    for (const route of excluded) {
      assert.ok(
        registeredCanonical.has(route),
        `excluded route ${route} is no longer registered`,
      );
    }
  });

  it('records the exact RBAC permission and Building scope per operation', () => {
    for (const [path, methods] of Object.entries(DOCUMENTED_MASTER_PATHS)) {
      for (const method of methods) {
        const op = spec.paths[path][method];
        assert.equal(
          op['x-required-permission'],
          EXPECTED_PERMISSIONS[op.operationId],
          `wrong x-required-permission on ${op.operationId}`,
        );
        assert.equal(
          op['x-building-scoped'],
          true,
          `${op.operationId} must record tenant / Building isolation`,
        );
        assert.ok(
          (op.security ?? []).some(
            (s: Record<string, unknown>) => 'bearerAuth' in s,
          ),
          `${op.operationId} must require bearer auth`,
        );
        assert.ok(
          op.responses?.['401'] && op.responses?.['403'],
          `${op.operationId} must document 401 + 403`,
        );
      }
    }
  });
});

describe('Work Order material + verification composition stays published', () => {
  const documented = documentedOperationIds();

  it('keeps every composed operation published at its expected path', () => {
    for (const [operationId, expected] of Object.entries(
      COMPOSITION_OPERATIONS,
    )) {
      assert.ok(
        documented.has(operationId),
        `composed operation ${operationId} is no longer published`,
      );
      assert.equal(
        documented.get(operationId),
        expected,
        `${operationId} moved away from ${expected}`,
      );
    }
  });

  it('exposes issued quantity, cost and ledger linkage on material usage', () => {
    const usage = spec.components.schemas.WorkOrderMaterialUsage.properties;
    for (const field of [
      'workOrderId',
      'warehouseId',
      'itemId',
      'quantity',
      'uomId',
      'unitCost',
      'totalCost',
      'currency',
      'stockMovementId',
      'usedByUserId',
      'usedAt',
      'resultingQuantityOnHand',
      'resultingAvailableQuantity',
    ]) {
      assert.ok(usage[field], `WorkOrderMaterialUsage.${field} missing`);
    }
  });

  it('exposes the approved-quantity context on material requests', () => {
    const mr = spec.components.schemas.MaterialRequest.properties;
    for (const field of [
      'quantity',
      'approvedQuantity',
      'approvedAt',
      'approvedByUserId',
      'receivedQuantity',
      'remainingQuantity',
    ]) {
      assert.ok(mr[field], `MaterialRequest.${field} missing`);
    }
  });

  it('exposes availability on the stock balance schema', () => {
    const balance = spec.components.schemas.StockBalance.properties;
    for (const field of [
      'warehouseId',
      'itemId',
      'quantityOnHand',
      'reservedQuantity',
      'availableQuantity',
    ]) {
      assert.ok(balance[field], `StockBalance.${field} missing`);
    }
    assert.deepEqual(
      spec.components.schemas.StockMovement.properties.movementType.enum ?? [
        'STOCK_IN',
        'STOCK_OUT',
      ],
      ['STOCK_IN', 'STOCK_OUT'],
    );
  });

  it('keeps the three quantity concepts distinct', () => {
    const schemas = spec.components.schemas;
    // planning reference (BE-16H)
    assert.ok(schemas.AssetSparePart.properties.requiredQuantity);
    // approved (BE-17B / CR-BE-MAT-01 PART 02)
    assert.ok(schemas.MaterialRequest.properties.approvedQuantity);
    // issued (BE-16I)
    assert.ok(schemas.WorkOrderMaterialUsage.properties.quantity);
    assert.match(
      String(schemas.AssetSparePart.description),
      /NOT an approved quantity/i,
    );
  });

  it('exposes the Work Order verification decision surface', () => {
    const verification = spec.components.schemas.WorkOrderVerification;
    for (const field of [
      'workOrderId',
      'reviewerUserId',
      'decision',
      'notes',
      'reviewedAt',
      'status',
    ]) {
      assert.ok(
        verification.properties[field],
        `WorkOrderVerification.${field} missing`,
      );
    }
  });
});

describe('PART 04 invents no verification target, engine or id (reconciled by CR-BE-MOB-03 PART 05)', () => {
  it('keeps /mobile/verification at exactly the backend target types', () => {
    const backend = readFileSync(
      resolve(
        __dirname,
        '../src/modules/mobile-verification/mobile-verification.types.ts',
      ),
      'utf8',
    );
    const block = /MOBILE_VERIFICATION_TARGET_TYPES\s*=\s*\[([^\]]+)\]/.exec(
      backend,
    );
    assert.ok(block, 'backend target-type constant not found');
    const implemented = [...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    const documentedEnum =
      spec.components.parameters.VerificationTargetTypeParam.schema.enum;
    assert.deepEqual(
      documentedEnum,
      implemented,
      'documented /mobile/verification targets must equal the implemented set',
    );
    // CR-BE-MOB-03 PART 05 closed WO-04: WORK_ORDER is now a supported
    // target of the existing BE-25J workflow (delegating to the BE-08I
    // verification lifecycle). The enum-equality assertion above is the
    // remaining guard — no target may be advertised before it is
    // implemented, and none may be implemented without being advertised.
    assert.ok(
      documentedEnum.includes('WORK_ORDER'),
      'WORK_ORDER must be advertised on /mobile/verification (implemented by CR-BE-MOB-03 PART 05)',
    );
  });

  it('adds no mobile-specific material or inventory facade', () => {
    const invented = Object.keys(spec.paths).filter((p: string) =>
      /\/mobile\/(material|inventory|work-order)/.test(p),
    );
    assert.deepEqual(invented, []);
    const inventedSchemas = Object.keys(spec.components.schemas).filter(
      (n: string) => /^(MobileMaterial|MobileInventory|MaterialIssue)/.test(n),
    );
    assert.deepEqual(inventedSchemas, []);
  });

  it('preserves the authoritative master enums', () => {
    const schemas = spec.components.schemas;
    assert.deepEqual(schemas.InventoryItemType.enum, [
      'SPARE_PART',
      'MATERIAL',
      'CONSUMABLE',
    ]);
    assert.deepEqual(schemas.InventoryItemStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.InventoryWarehouseStatus.enum, [
      'ACTIVE',
      'INACTIVE',
    ]);
    assert.deepEqual(schemas.AssetSparePartStatus.enum, ['ACTIVE', 'INACTIVE']);
  });
});

describe('Inventory Master documented routes are registered (no invented endpoints)', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const id = '00000000-0000-4000-8000-000000000001';
    const samples = [
      `/clients/${id}/inventory-items`,
      `/inventory-items/${id}`,
      `/buildings/${id}/warehouses`,
      `/clients/${id}/warehouses`,
      `/warehouses/${id}`,
      `/assets/${id}/spare-parts`,
      `/inventory-items/${id}/asset-bindings`,
      `/asset-spare-parts/${id}`,
    ];

    for (const path of samples) {
      const response = await request.get(`${API_PREFIX}${path}`);
      assert.notEqual(
        response.status,
        404,
        `GET ${path} is documented but not registered (got 404)`,
      );
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
