import { getPool } from '../../database';
import { contextAccessService } from '../context-access';
import { inventoryItemRepository } from '../inventory-items';
import { materialRequestRepository } from '../material-requests';
import { recordOperationalEvent } from '../operational-events';
import { serviceRequestRepository } from '../service-requests';
import {
  purchaseOrderLineDuplicateError,
  purchaseOrderLineNotDraftError,
  purchaseOrderLineNotFoundError,
  purchaseOrderLinePriceInvalidError,
  purchaseOrderLineRequestInvalidError,
  purchaseOrderLineRequestMismatchError,
  purchaseOrderLineRfqDerivedImmutableError,
  purchaseOrderLineUomIncompatibleError,
} from './purchase-order-line.errors';
import { purchaseOrderLineRepository } from './purchase-order-line.repository';
import {
  deriveLineAmount,
  type AddPurchaseOrderLineInput,
  type NewPurchaseOrderLine,
  type PublicPurchaseOrderLine,
  type PurchaseOrderLineRecord,
  type RemovePurchaseOrderLineResult,
  type UpdatePurchaseOrderLineInput,
} from './purchase-order-line.types';
import { purchaseOrderNotFoundError } from './purchase-order.errors';
import { purchaseOrderRepository } from './purchase-order.repository';
import { isRfqDerivedPurchaseOrder } from '../rfq-po-conversions/rfq-po-provenance.repository';
import type { PurchaseOrderRecord } from './purchase-order.types';

function toPublic(record: PurchaseOrderLineRecord): PublicPurchaseOrderLine {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

/** Loads the parent Purchase Order and asserts BE-02G Building access. */
async function loadAccessiblePurchaseOrder(
  purchaseOrderId: string,
  actorUserId: string,
): Promise<PurchaseOrderRecord> {
  const record = await purchaseOrderRepository.findById(purchaseOrderId);
  if (!record) throw purchaseOrderNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    record.buildingId,
  );
  return record;
}

/** Loads a line together with its parent PO, asserting access once. */
async function loadAccessibleLine(
  id: string,
  actorUserId: string,
): Promise<{ line: PurchaseOrderLineRecord; purchaseOrder: PurchaseOrderRecord }> {
  const line = await purchaseOrderLineRepository.findById(id);
  if (!line) throw purchaseOrderLineNotFoundError();
  const purchaseOrder = await loadAccessiblePurchaseOrder(
    line.purchaseOrderId,
    actorUserId,
  );
  return { line, purchaseOrder };
}

type ResolvedRequestLine = Omit<
  NewPurchaseOrderLine,
  | 'purchaseOrderId'
  | 'clientId'
  | 'buildingId'
  | 'lineNumber'
  | 'unitPrice'
  | 'lineAmount'
  | 'notes'
  | 'createdByUserId'
>;

/**
 * Resolves and validates the originating MATERIAL REQUEST line.
 *
 * Integrity enforced here:
 *  - the line exists and is committable (OPEN or APPROVED; CANCELLED never is)
 *  - it belongs to the SAME Purchase Request as the Purchase Order, so the
 *    PO ↔ request chain cannot be crossed
 *  - Client and Building match the Purchase Order exactly (BE-02 isolation)
 *  - the UOM snapshot is taken with no conversion (mirrors the receiving rule)
 *
 * QUANTITY AUTHORITY: `approvedQuantity ?? quantity` is READ from
 * `material_requests` and frozen onto the line. Nothing is written back and
 * no ordered/received/remaining ledger is created — the Material Request
 * remains the single quantity authority.
 */
async function resolveMaterialRequestLine(
  purchaseOrder: PurchaseOrderRecord,
  requestLineId: string,
): Promise<ResolvedRequestLine> {
  const line = await materialRequestRepository.findById(requestLineId);
  if (!line) throw purchaseOrderLineRequestInvalidError();

  // A cancelled line is never committable.
  if (line.status !== 'OPEN' && line.status !== 'APPROVED') {
    throw purchaseOrderLineRequestInvalidError();
  }

  // The PO commits against a Purchase Request; a Service-Request PO cannot
  // carry material lines.
  if (!purchaseOrder.purchaseRequestId) {
    throw purchaseOrderLineRequestMismatchError();
  }
  if (line.purchaseRequestId !== purchaseOrder.purchaseRequestId) {
    throw purchaseOrderLineRequestMismatchError();
  }
  if (
    line.clientId !== purchaseOrder.clientId ||
    line.buildingId !== purchaseOrder.buildingId
  ) {
    throw purchaseOrderLineRequestMismatchError();
  }

  const item = await inventoryItemRepository.findById(line.itemId);
  if (!item) throw purchaseOrderLineRequestInvalidError();
  if (item.clientId !== purchaseOrder.clientId) {
    throw purchaseOrderLineRequestMismatchError();
  }

  // UOM snapshot with no conversion authority: when the line and the item
  // both carry a UOM they must agree. A legacy line without one falls back
  // to the item's UOM.
  const itemUomId = item.uomId ?? null;
  if (line.uomId && itemUomId && line.uomId !== itemUomId) {
    throw purchaseOrderLineUomIncompatibleError();
  }
  const uomId = line.uomId ?? itemUomId;

  // Frozen READ of the authoritative quantity — never a new ledger.
  const quantitySnapshot = Number(line.approvedQuantity ?? line.quantity);
  if (!Number.isFinite(quantitySnapshot) || quantitySnapshot <= 0) {
    throw purchaseOrderLineRequestInvalidError();
  }

  return {
    requestLineType: 'MATERIAL_REQUEST',
    materialRequestId: line.id,
    serviceRequestId: null,
    itemId: item.id,
    uomId,
    sourceServiceId: null,
    description: item.name,
    quantitySnapshot,
  };
}

/**
 * Resolves and validates the originating SERVICE REQUEST.
 *
 * BE-17C carries no quantity and no item, so a service line snapshots
 * neither — the committed unit price IS the line amount.
 */
async function resolveServiceRequestLine(
  purchaseOrder: PurchaseOrderRecord,
  requestLineId: string,
): Promise<ResolvedRequestLine> {
  const request = await serviceRequestRepository.findById(requestLineId);
  if (!request) throw purchaseOrderLineRequestInvalidError();
  if (request.status !== 'OPEN') {
    throw purchaseOrderLineRequestInvalidError();
  }

  // The service line must be the PO's own committed Service Request, or a
  // service line belonging to the PO's Purchase Request.
  const matchesServiceRequestPo =
    purchaseOrder.serviceRequestId !== null &&
    purchaseOrder.serviceRequestId === request.id;
  const matchesPurchaseRequestPo =
    purchaseOrder.purchaseRequestId !== null &&
    purchaseOrder.purchaseRequestId === request.purchaseRequestId;
  if (!matchesServiceRequestPo && !matchesPurchaseRequestPo) {
    throw purchaseOrderLineRequestMismatchError();
  }

  if (
    request.clientId !== purchaseOrder.clientId ||
    request.buildingId !== purchaseOrder.buildingId
  ) {
    throw purchaseOrderLineRequestMismatchError();
  }

  return {
    requestLineType: 'SERVICE_REQUEST',
    materialRequestId: null,
    serviceRequestId: request.id,
    itemId: null,
    uomId: null,
    // CR-BE-SVC-01 PART 04 — governed SERVICE identity propagated from the
    // Service Request (PART 02) and frozen on the committed PO line.
    sourceServiceId: request.serviceCatalogId,
    description: request.title,
    quantitySnapshot: null,
  };
}

/**
 * Commits one PO Line against an originating MR/SR line.
 *
 * Lines may only be added while the Purchase Order is DRAFT — once issuance
 * exists (PART 03) a committed order is immutable.
 */
export async function addPurchaseOrderLine(
  purchaseOrderId: string,
  input: AddPurchaseOrderLineInput,
  actorUserId: string,
): Promise<PublicPurchaseOrderLine> {
  const purchaseOrder = await loadAccessiblePurchaseOrder(
    purchaseOrderId,
    actorUserId,
  );
  if (purchaseOrder.status !== 'DRAFT') {
    throw purchaseOrderLineNotDraftError();
  }
  if (await isRfqDerivedPurchaseOrder(purchaseOrder.id)) {
    throw purchaseOrderLineRfqDerivedImmutableError();
  }

  if (
    typeof input.unitPrice !== 'number' ||
    !Number.isFinite(input.unitPrice) ||
    input.unitPrice < 0
  ) {
    throw purchaseOrderLinePriceInvalidError();
  }

  const resolved =
    input.requestLineType === 'MATERIAL_REQUEST'
      ? await resolveMaterialRequestLine(purchaseOrder, input.requestLineId)
      : await resolveServiceRequestLine(purchaseOrder, input.requestLineId);

  // Duplicate-linkage protection across live Purchase Orders. The per-PO
  // unique constraints only guard within one PO, so a request line committed
  // on another non-CANCELLED PO is rejected here.
  const existing =
    await purchaseOrderLineRepository.findLiveCommitmentForRequestLine(
      resolved.materialRequestId,
      resolved.serviceRequestId,
    );
  if (existing) throw purchaseOrderLineDuplicateError();

  const lineAmount = deriveLineAmount(
    resolved.quantitySnapshot,
    input.unitPrice,
  );

  const pool = getPool();
  const client = await pool.connect();
  let record: PurchaseOrderLineRecord;
  try {
    await client.query('BEGIN');
    record = await purchaseOrderLineRepository.createWithClient(client, {
      purchaseOrderId: purchaseOrder.id,
      clientId: purchaseOrder.clientId,
      buildingId: purchaseOrder.buildingId,
      ...resolved,
      description: input.description?.trim() || resolved.description,
      unitPrice: input.unitPrice,
      lineAmount,
      notes: input.notes?.trim() || null,
      createdByUserId: actorUserId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUniqueViolation(error)) throw purchaseOrderLineDuplicateError();
    throw error;
  } finally {
    client.release();
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'PURCHASE_ORDER_LINE_ADDED',
    entityType: 'PURCHASE_ORDER_LINE',
    entityId: record.id,
    actorUserId,
    summary: `Purchase Order ${purchaseOrder.poNumber} line ${record.lineNumber} committed.`,
    metadata: {
      purchaseOrderId: purchaseOrder.id,
      requestLineType: record.requestLineType,
      materialRequestId: record.materialRequestId,
      serviceRequestId: record.serviceRequestId,
      quantitySnapshot: record.quantitySnapshot,
      unitPrice: record.unitPrice,
      lineAmount: record.lineAmount,
    },
  });

  return toPublic(record);
}

export async function listPurchaseOrderLines(
  purchaseOrderId: string,
  actorUserId: string,
): Promise<PublicPurchaseOrderLine[]> {
  await loadAccessiblePurchaseOrder(purchaseOrderId, actorUserId);
  const records =
    await purchaseOrderLineRepository.listByPurchaseOrder(purchaseOrderId);
  return records.map(toPublic);
}

export async function getPurchaseOrderLine(
  id: string,
  actorUserId: string,
): Promise<PublicPurchaseOrderLine> {
  const { line } = await loadAccessibleLine(id, actorUserId);
  return toPublic(line);
}

/**
 * Updates the commercial terms of a line on a DRAFT Purchase Order.
 *
 * The request linkage and the derived snapshots (item, UOM, quantity) are
 * immutable — the line amount re-derives from the FROZEN quantity snapshot,
 * so editing can never turn the snapshot into a competing quantity authority.
 */
export async function updatePurchaseOrderLine(
  id: string,
  input: UpdatePurchaseOrderLineInput,
  actorUserId: string,
): Promise<PublicPurchaseOrderLine> {
  const { purchaseOrder } = await loadAccessibleLine(id, actorUserId);
  if (purchaseOrder.status !== 'DRAFT') {
    throw purchaseOrderLineNotDraftError();
  }
  if (await isRfqDerivedPurchaseOrder(purchaseOrder.id)) {
    throw purchaseOrderLineRfqDerivedImmutableError();
  }

  if (input.unitPrice !== undefined) {
    if (
      typeof input.unitPrice !== 'number' ||
      !Number.isFinite(input.unitPrice) ||
      input.unitPrice < 0
    ) {
      throw purchaseOrderLinePriceInvalidError();
    }
  }

  const updated = await purchaseOrderLineRepository.update(
    id,
    input,
    actorUserId,
  );
  if (!updated) throw purchaseOrderLineNotFoundError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    eventType: 'PURCHASE_ORDER_LINE_UPDATED',
    entityType: 'PURCHASE_ORDER_LINE',
    entityId: updated.id,
    actorUserId,
    summary: `Purchase Order ${purchaseOrder.poNumber} line ${updated.lineNumber} updated.`,
    metadata: {
      purchaseOrderId: purchaseOrder.id,
      fields: Object.keys(input),
      unitPrice: updated.unitPrice,
      lineAmount: updated.lineAmount,
    },
  });

  return toPublic(updated);
}

/** Removes a line from a DRAFT Purchase Order, releasing its request line. */
export async function removePurchaseOrderLine(
  id: string,
  actorUserId: string,
): Promise<RemovePurchaseOrderLineResult> {
  const { line, purchaseOrder } = await loadAccessibleLine(id, actorUserId);
  if (purchaseOrder.status !== 'DRAFT') {
    throw purchaseOrderLineNotDraftError();
  }
  if (await isRfqDerivedPurchaseOrder(purchaseOrder.id)) {
    throw purchaseOrderLineRfqDerivedImmutableError();
  }

  const removed = await purchaseOrderLineRepository.remove(id);
  if (!removed) throw purchaseOrderLineNotFoundError();

  await recordOperationalEvent({
    clientId: removed.clientId,
    buildingId: removed.buildingId,
    eventType: 'PURCHASE_ORDER_LINE_REMOVED',
    entityType: 'PURCHASE_ORDER_LINE',
    entityId: removed.id,
    actorUserId,
    summary: `Purchase Order ${purchaseOrder.poNumber} line ${removed.lineNumber} removed.`,
    metadata: {
      purchaseOrderId: purchaseOrder.id,
      requestLineType: removed.requestLineType,
      materialRequestId: removed.materialRequestId,
      serviceRequestId: removed.serviceRequestId,
    },
  });

  return {
    removed: true,
    purchaseOrderId: line.purchaseOrderId,
    lineNumber: removed.lineNumber,
  };
}

export const purchaseOrderLineService = {
  addPurchaseOrderLine,
  getPurchaseOrderLine,
  listPurchaseOrderLines,
  removePurchaseOrderLine,
  updatePurchaseOrderLine,
};
