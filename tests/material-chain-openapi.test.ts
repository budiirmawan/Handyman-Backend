import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { ERROR_CODES } from '../src/shared/errors';

/**
 * CR-BE-MAT-01 PART 07 — Material Chain OpenAPI contract validation.
 * Documentation-only checks (no database):
 *  - the spec parses,
 *  - every documented material-chain route exists in the backend router
 *    sources (no invented endpoints),
 *  - every registered route of the CR-BE-MAT-01 modules is documented
 *    (no undocumented CR endpoint remains),
 *  - schemas expose the implemented DTO fields (quantity/UOM/cost/chain
 *    references),
 *  - the deterministic error codes introduced by this CR are documented and
 *    really exist in the shared error registry.
 */

const spec = parse(
  readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
) as any;

/** OpenAPI path → Express path. */
function toExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/** All (method, path) pairs registered by a module's *.routes.ts file. */
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

const CR_MODULES = [
  'material-requests',
  'procurement-approvals',
  'receivings',
  'inventory-stock-movements',
  'inventory-stock-balances',
  'inventory-work-order-material-usages',
  'inventory-material-reservations',
];

const DOCUMENTED_CHAIN_PATHS: Record<string, string[]> = {
  '/purchase-requests/{purchaseRequestId}/material-requests': ['post', 'get'],
  '/buildings/{buildingId}/material-requests': ['get'],
  '/items/{itemId}/material-requests': ['get'],
  '/material-requests/{id}': ['get', 'patch'],
  '/material-requests/{id}/cancel': ['post'],
  '/procurement-approvals': ['post'],
  '/procurement-approvals/pending': ['get'],
  '/procurement-approvals/{id}': ['get'],
  '/procurement-approvals/{id}/available-actions': ['get'],
  '/procurement-approvals/{id}/approve': ['post'],
  '/procurement-approvals/{id}/reject': ['post'],
  '/receivings': ['post'],
  '/receivings/{id}': ['get', 'patch'],
  '/receivings/{id}/finalize': ['post'],
  '/buildings/{buildingId}/receivings': ['get'],
  '/purchase-requests/{purchaseRequestId}/receivings': ['get'],
  '/service-requests/{serviceRequestId}/receivings': ['get'],
  '/vendors/{vendorId}/receivings': ['get'],
  '/warehouses/{warehouseId}/stock-movements': ['post', 'get'],
  '/clients/{clientId}/stock-movements': ['post', 'get'],
  '/buildings/{buildingId}/stock-movements': ['get'],
  '/stock-movements/{id}': ['get'],
  '/warehouses/{warehouseId}/stock-balances': ['post', 'get'],
  '/clients/{clientId}/stock-balances': ['post', 'get'],
  '/buildings/{buildingId}/stock-balances': ['get'],
  '/stock-balances/{id}': ['get'],
  '/work-orders/{workOrderId}/material-usages': ['post', 'get'],
  '/work-orders/{workOrderId}/material-cost-summary': ['get'],
  '/buildings/{buildingId}/work-order-material-usages': ['get'],
  '/clients/{clientId}/work-order-material-usages': ['get'],
  '/work-order-material-usages/{id}': ['get'],
  '/material-requests/{materialRequestId}/reservations': ['post', 'get'],
  '/material-reservations/{id}': ['get'],
  '/material-reservations/{id}/release': ['post'],
  '/material-reservations/{id}/cancel': ['post'],
};

describe('OpenAPI parses and documents the material chain', () => {
  it('parses and exposes every material-chain path + method', () => {
    assert.equal(spec.openapi, '3.0.3');
    for (const [path, methods] of Object.entries(DOCUMENTED_CHAIN_PATHS)) {
      assert.ok(spec.paths[path], `missing path ${path}`);
      for (const method of methods) {
        assert.ok(spec.paths[path][method], `missing ${method} ${path}`);
        const op = spec.paths[path][method];
        assert.ok(op.security, `missing security on ${method} ${path}`);
        assert.match(
          String(op.description ?? op.summary),
          /./,
          `missing description on ${method} ${path}`,
        );
      }
    }
  });

  it('documents only routes that actually exist (no invented endpoints)', () => {
    const registered = new Set<string>();
    for (const moduleDir of CR_MODULES) {
      for (const route of registeredRoutes(moduleDir)) registered.add(route);
    }
    for (const [path, methods] of Object.entries(DOCUMENTED_CHAIN_PATHS)) {
      for (const method of methods) {
        assert.ok(
          registered.has(`${method} ${toExpress(path)}`),
          `documented ${method} ${path} is not a registered backend route`,
        );
      }
    }
  });

  it('leaves no registered CR-BE-MAT-01 module route undocumented', () => {
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(DOCUMENTED_CHAIN_PATHS)) {
      for (const method of methods) documented.add(`${method} ${toExpress(path)}`);
    }
    for (const moduleDir of CR_MODULES) {
      for (const route of registeredRoutes(moduleDir)) {
        assert.ok(documented.has(route), `undocumented route: ${route}`);
      }
    }
  });
});

describe('schemas match the implemented DTOs', () => {
  const schemas = spec.components.schemas;

  it('exposes the material-chain schemas', () => {
    for (const name of [
      'MaterialRequest',
      'MaterialRequestCreateRequest',
      'MaterialRequestUpdateRequest',
      'MaterialRequestStatus',
      'ProcurementApproval',
      'ProcurementApprovalCreateRequest',
      'ProcurementApprovalDecisionRequest',
      'ProcurementApprovalAvailableActions',
      'Receiving',
      'ReceivingCreateRequest',
      'ReceivingUpdateRequest',
      'StockMovement',
      'StockMovementCreateRequest',
      'StockBalance',
      'StockBalanceInitializeRequest',
      'WorkOrderMaterialUsage',
      'WorkOrderMaterialUsageCreateRequest',
      'WorkOrderMaterialCostSummary',
      'MaterialReservation',
      'MaterialReservationCreateRequest',
      'MaterialReservationStatus',
    ]) {
      assert.ok(schemas[name], `missing schema ${name}`);
    }
  });

  it('carries the quantity / approved-quantity / remaining fields (PART 01–02)', () => {
    const properties = schemas.MaterialRequest.properties;
    for (const field of [
      'quantity',
      'approvedQuantity',
      'approvedAt',
      'approvedByUserId',
      'receivedQuantity',
      'remainingQuantity',
      'uomId',
      'purchaseRequestId',
      'status',
    ]) {
      assert.ok(properties[field], `MaterialRequest.${field}`);
    }
    assert.deepEqual(schemas.MaterialRequestStatus.enum, [
      'OPEN',
      'APPROVED',
      'CANCELLED',
    ]);
    assert.ok(
      schemas.ProcurementApprovalDecisionRequest.properties.approvedQuantity,
    );
  });

  it('carries the chain references and UOM snapshots (PART 01/03/04/06)', () => {
    const receiving = schemas.Receiving.properties;
    for (const field of ['materialRequestId', 'stockMovementId', 'uomId', 'quantity']) {
      assert.ok(receiving[field], `Receiving.${field}`);
    }
    const movement = schemas.StockMovement.properties;
    for (const field of [
      'movementType',
      'quantity',
      'uomId',
      'source',
      'reference',
      'resultingQuantityOnHand',
      'resultingAvailableQuantity',
    ]) {
      assert.ok(movement[field], `StockMovement.${field}`);
    }
    const balance = schemas.StockBalance.properties;
    for (const field of ['quantityOnHand', 'reservedQuantity', 'availableQuantity']) {
      assert.ok(balance[field], `StockBalance.${field}`);
    }
  });

  it('carries the operational cost snapshot and summary fields (PART 05–06)', () => {
    const usage = schemas.WorkOrderMaterialUsage.properties;
    for (const field of [
      'quantity',
      'uomId',
      'unitCost',
      'totalCost',
      'currency',
      'costSource',
      'costReference',
      'stockMovementId',
      'workOrderId',
      'materialRequestId',
      'reservationId',
    ]) {
      assert.ok(usage[field], `WorkOrderMaterialUsage.${field}`);
    }
    const summary = schemas.WorkOrderMaterialCostSummary.properties;
    for (const field of [
      'workOrderId',
      'usageCount',
      'costedUsageCount',
      'totalMaterialCost',
      'byCurrency',
    ]) {
      assert.ok(summary[field], `WorkOrderMaterialCostSummary.${field}`);
    }
  });

  it('carries the reservation allocation and lifecycle fields (PART 01–02)', () => {
    const reservation = schemas.MaterialReservation.properties;
    for (const field of [
      'materialRequestId',
      'warehouseId',
      'itemId',
      'uomId',
      'reservedQuantity',
      'status',
      'createdByUserId',
      'releasedByUserId',
      'cancelledByUserId',
      'consumedByUserId',
      'createdAt',
      'releasedAt',
      'cancelledAt',
      'consumedAt',
      'consumedQuantity',
      'remainingQuantity',
    ]) {
      assert.ok(reservation[field], `MaterialReservation.${field}`);
    }
    assert.deepEqual(schemas.MaterialReservationStatus.enum, [
      'ACTIVE',
      'RELEASED',
      'CANCELLED',
      'CONSUMED',
    ]);
  });
});

describe('final reservation and controlled issue contract', () => {
  it('documents the implemented authority and lifecycle semantics', () => {
    const schemas = spec.components.schemas;
    const createReservation =
      spec.paths['/material-requests/{materialRequestId}/reservations'].post;
    const reservationSchema = schemas.MaterialReservation;
    assert.equal(createReservation['x-required-permission'], 'inventory_stock.manage');
    assert.equal(createReservation['x-building-scoped'], true);
    assert.match(String(createReservation.description), /APPROVED/);
    assert.match(String(createReservation.description), /available stock/);
    assert.match(String(reservationSchema.description), /Partial consumption remains ACTIVE/);
    assert.match(String(reservationSchema.description), /full consumption.*CONSUMED/i);
    assert.deepEqual(schemas.MaterialReservationStatus.enum, [
      'ACTIVE',
      'RELEASED',
      'CANCELLED',
      'CONSUMED',
    ]);

    const issue = spec.paths['/work-orders/{workOrderId}/material-usages'].post;
    assert.equal(issue['x-required-permission'], 'inventory_stock.manage');
    assert.equal(issue['x-building-scoped'], true);
    assert.match(String(issue.description), /procurement binding/i);
    assert.match(String(issue.description), /APPROVED Material Request/i);
    assert.match(String(issue.description), /cumulative controlled issues/i);
    assert.match(String(issue.description), /receiving quantity is not used/i);
    assert.match(String(issue.description), /reservationId/);
    for (const path of [
      '/work-orders/{workOrderId}/material-usages',
      '/buildings/{buildingId}/work-order-material-usages',
      '/clients/{clientId}/work-order-material-usages',
    ]) {
      const listOperation = spec.paths[path].get;
      const queryNames = (listOperation.parameters ?? [])
        .filter((parameter: Record<string, unknown>) => parameter.in === 'query')
        .map((parameter: Record<string, unknown>) => parameter.name);
      assert.ok(queryNames.includes('materialRequestId'), `${path} must expose materialRequestId filter`);
      assert.ok(queryNames.includes('reservationId'), `${path} must expose reservationId filter`);
    }

    const cancelMaterialRequest = spec.paths['/material-requests/{id}/cancel'].post;
    assert.ok(cancelMaterialRequest.responses['409']);
    assert.match(
      String(cancelMaterialRequest.responses['409'].description),
      /MATERIAL_REQUEST_ACTIVE_RESERVATION/,
    );

    const genericStockOut = spec.paths['/warehouses/{warehouseId}/stock-movements'].post;
    assert.match(String(genericStockOut.responses['409'].description), /WORK_ORDER_BYPASS/);
  });
});

describe('deterministic error contract', () => {
  it('documents every CR-BE-MAT-01 error code, and each code really exists', () => {
    const raw = readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8');
    for (const code of [
      // PART 01
      'RECEIVING_OVER_RECEIPT',
      'RECEIVING_MATERIAL_REQUEST_INVALID',
      'RECEIVING_MATERIAL_REQUEST_ITEM_MISMATCH',
      'RECEIVING_MATERIAL_REQUEST_SCOPE_MISMATCH',
      // PART 01 — reservation foundation
      'INVENTORY_MATERIAL_RESERVATION_NOT_FOUND',
      'INVENTORY_MATERIAL_RESERVATION_INVALID_QUANTITY',
      'INVENTORY_MATERIAL_RESERVATION_DEMAND_NOT_APPROVED',
      'INVENTORY_MATERIAL_RESERVATION_DEMAND_EXCEEDED',
      'INVENTORY_MATERIAL_RESERVATION_INSUFFICIENT_STOCK',
      'INVENTORY_MATERIAL_RESERVATION_CLIENT_MISMATCH',
      'INVENTORY_MATERIAL_RESERVATION_BUILDING_MISMATCH',
      'INVENTORY_MATERIAL_RESERVATION_ITEM_MISMATCH',
      'INVENTORY_MATERIAL_RESERVATION_WAREHOUSE_MISMATCH',
      'INVENTORY_MATERIAL_RESERVATION_UOM_INCOMPATIBLE',
      'INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE',
      'INVENTORY_MATERIAL_RESERVATION_ALLOCATION_EXCEEDED',
      // PART 02 — demand-linked issue
      'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_REQUIRED',
      'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_INVALID',
      'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_NOT_APPROVED',
      'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED',
      'INVENTORY_WO_MATERIAL_USAGE_RESERVATION_MISMATCH',
      // Approved quantity compatibility
      'MATERIAL_REQUEST_APPROVED_QUANTITY_INVALID',
      'MATERIAL_REQUEST_APPROVED_QUANTITY_EXCEEDS_REQUESTED',
      'PROCUREMENT_APPROVAL_APPROVED_QUANTITY_NOT_APPLICABLE',
      'MATERIAL_REQUEST_NOT_OPEN',
      // PART 03
      'INVENTORY_STOCK_BALANCE_INIT_ACTOR_REQUIRED',
      'INVENTORY_STOCK_MOVEMENT_INSUFFICIENT_STOCK',
      'INVENTORY_STOCK_MOVEMENT_WORK_ORDER_BYPASS',
      // PART 03 — lifecycle coordination
      'MATERIAL_REQUEST_ACTIVE_RESERVATION',
      // PART 04
      'RECEIVING_UOM_INCOMPATIBLE',
      // PART 05
      'WO_MATERIAL_USAGE_INVALID_UNIT_COST',
      // PART 06
      'WO_MATERIAL_USAGE_WORK_ORDER_STATE_INVALID',
      'WO_MATERIAL_USAGE_UOM_INCOMPATIBLE',
      'WO_MATERIAL_USAGE_DUPLICATE_REFERENCE',
      'INVENTORY_WO_MATERIAL_USAGE_INSUFFICIENT_STOCK',
      'INVENTORY_WO_MATERIAL_USAGE_CLIENT_MISMATCH',
      'INVENTORY_WO_MATERIAL_USAGE_BUILDING_MISMATCH',
    ]) {
      assert.ok(raw.includes(code), `error code not documented: ${code}`);
      assert.ok(
        Object.values(ERROR_CODES).includes(code as any),
        `documented code missing from ERROR_CODES: ${code}`,
      );
    }
  });
});
