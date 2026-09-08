import { getPool } from '../../database';
import { assertActiveAllowedCurrency } from '../client-monetary-contexts';
import { contextAccessService } from '../context-access';
import { materialRequestRepository } from '../material-requests';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { poReadinessRepository } from '../purchase-order-readiness';
import { serviceRequestRepository } from '../service-requests';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorRepository } from '../vendors';
import { purchaseOrderLineRepository } from './purchase-order-line.repository';
import { isRfqDerivedPurchaseOrder } from '../rfq-po-conversions/rfq-po-provenance.repository';
import {
  purchaseOrderCancelNotAllowedError,
  purchaseOrderContextInvalidError,
  purchaseOrderNoLinesError,
  purchaseOrderNotDraftError,
  purchaseOrderNotFoundError,
  purchaseOrderNotIssuableError,
  purchaseOrderNotIssuableStateError,
  purchaseOrderNumberExistsError,
  purchaseOrderReadinessAlreadyCommittedError,
  purchaseOrderReadinessInvalidError,
  purchaseOrderReadinessNotReadyError,
  purchaseOrderRfqDerivedImmutableError,
  purchaseOrderVendorInvalidError,
} from './purchase-order.errors';
import { purchaseOrderRepository } from './purchase-order.repository';
import type {
  CreatePurchaseOrderInput,
  IssuePurchaseOrderInput,
  NewPurchaseOrder,
  PublicPurchaseOrder,
  PurchaseOrderAvailableActions,
  PurchaseOrderFilters,
  PurchaseOrderIssueBlocker,
  PurchaseOrderIssueReadinessResult,
  PurchaseOrderRecord,
  UpdatePurchaseOrderInput,
} from './purchase-order.types';

function toPublic(record: PurchaseOrderRecord): PublicPurchaseOrder {
  return {
    ...record,
    issuedAt: record.issuedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== '23505'
  ) {
    return false;
  }
  if (!constraint) return true;
  return (
    'constraint' in error &&
    typeof error.constraint === 'string' &&
    error.constraint === constraint
  );
}

/**
 * Loads a Purchase Order and asserts BE-02G Building access for the actor.
 * Every by-id read/command funnels through here, so isolation is enforced
 * once rather than per handler.
 */
async function loadAccessible(
  id: string,
  actorUserId: string,
): Promise<PurchaseOrderRecord> {
  const record = await purchaseOrderRepository.findById(id);
  if (!record) throw purchaseOrderNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    record.buildingId,
  );
  return record;
}

/**
 * Frozen decision 1 — PO Readiness is the PRECONDITION for commitment.
 *
 * Resolves the qualifying BE-17F readiness and derives the whole commitment
 * context from it: Client, Building, Vendor and the request reference. The
 * caller supplies only `poReadinessId`, so it cannot widen its own scope or
 * commit a Vendor that was never selected for the request.
 *
 * This function evaluates NOTHING — it reads the authoritative readiness
 * verdict. No second readiness authority is created.
 */
async function resolveCommitmentContext(
  poReadinessId: string,
  actorUserId: string,
): Promise<{
  clientId: string;
  buildingId: string;
  vendorId: string;
  requestType: NewPurchaseOrder['requestType'];
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
}> {
  const readiness = await poReadinessRepository.findById(poReadinessId);
  if (!readiness) throw purchaseOrderReadinessInvalidError();

  // Isolation before any further disclosure.
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    readiness.buildingId,
  );

  // READY means "may commit". Anything else cannot be committed.
  if (readiness.readiness !== 'READY') {
    throw purchaseOrderReadinessNotReadyError(readiness.readiness);
  }

  // The readiness row itself guarantees exactly one request reference
  // (po_readiness_request_reference_check). Defend against drift anyway.
  const hasPurchaseRequest = readiness.purchaseRequestId !== null;
  const hasServiceRequest = readiness.serviceRequestId !== null;
  if (hasPurchaseRequest === hasServiceRequest) {
    throw purchaseOrderContextInvalidError();
  }
  if (
    (readiness.requestType === 'PURCHASE_REQUEST' && !hasPurchaseRequest) ||
    (readiness.requestType === 'SERVICE_REQUEST' && !hasServiceRequest)
  ) {
    throw purchaseOrderContextInvalidError();
  }

  return {
    clientId: readiness.clientId,
    buildingId: readiness.buildingId,
    vendorId: readiness.vendorId,
    requestType: readiness.requestType,
    purchaseRequestId: readiness.purchaseRequestId,
    serviceRequestId: readiness.serviceRequestId,
  };
}

/**
 * Confirms the committed Vendor is still ACTIVE and still holds an ACTIVE
 * relationship to the commitment's Building at commit time. Readiness is a
 * snapshot; a Vendor may have been deactivated since it was evaluated.
 */
async function assertVendorCommittable(
  vendorId: string,
  clientId: string,
  buildingId: string,
): Promise<void> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) throw purchaseOrderVendorInvalidError();
  if (vendor.status !== 'ACTIVE') throw purchaseOrderVendorInvalidError();
  if (vendor.clientId !== clientId) throw purchaseOrderVendorInvalidError();

  const relationship =
    await vendorBuildingRepository.findActiveByVendorAndBuilding(
      vendorId,
      buildingId,
    );
  if (!relationship) throw purchaseOrderVendorInvalidError();
}

/**
 * Commits a Purchase Order against a READY PO Readiness.
 *
 * The PO is created as DRAFT. Issuance (DRAFT → ISSUED) and approval
 * readiness are PART 03; PO Lines are PART 02 — this command records the
 * commitment header only and creates no quantity ledger.
 */
export async function createPurchaseOrder(
  input: CreatePurchaseOrderInput,
  actorUserId: string,
): Promise<PublicPurchaseOrder> {
  const context = await resolveCommitmentContext(
    input.poReadinessId,
    actorUserId,
  );

  await assertActiveAllowedCurrency(context.clientId, input.currency);

  await assertVendorCommittable(
    context.vendorId,
    context.clientId,
    context.buildingId,
  );

  // One live commitment per qualifying readiness (fail fast; the partial
  // unique index is the ultimate authority).
  const existing = await purchaseOrderRepository.findActiveByReadiness(
    input.poReadinessId,
  );
  if (existing) throw purchaseOrderReadinessAlreadyCommittedError();

  const newPurchaseOrder: NewPurchaseOrder = {
    clientId: context.clientId,
    buildingId: context.buildingId,
    poNumber: input.poNumber,
    poDate: input.poDate,
    vendorId: context.vendorId,
    requestType: context.requestType,
    purchaseRequestId: context.purchaseRequestId,
    serviceRequestId: context.serviceRequestId,
    poReadinessId: input.poReadinessId,
    currency: input.currency,
    status: 'DRAFT',
    vendorReference: input.vendorReference?.trim() || null,
    requiredDate: input.requiredDate ?? null,
    notes: input.notes?.trim() || null,
    createdByUserId: actorUserId,
  };

  let record: PurchaseOrderRecord;
  try {
    record = await purchaseOrderRepository.create(newPurchaseOrder);
  } catch (error) {
    if (
      isUniqueViolation(error, 'purchase_orders_readiness_active_unique')
    ) {
      throw purchaseOrderReadinessAlreadyCommittedError();
    }
    if (isUniqueViolation(error)) throw purchaseOrderNumberExistsError();
    throw error;
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'PURCHASE_ORDER_CREATED',
    entityType: 'PURCHASE_ORDER',
    entityId: record.id,
    actorUserId,
    summary: `Purchase Order ${record.poNumber} created as draft.`,
    metadata: {
      vendorId: record.vendorId,
      poReadinessId: record.poReadinessId,
      requestType: record.requestType,
      purchaseRequestId: record.purchaseRequestId,
      serviceRequestId: record.serviceRequestId,
      currency: record.currency,
      status: record.status,
    },
  });

  return toPublic(record);
}

export async function getPurchaseOrder(
  id: string,
  actorUserId: string,
): Promise<PublicPurchaseOrder> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listPurchaseOrders(
  filters: PurchaseOrderFilters,
  actorUserId: string,
): Promise<PublicPurchaseOrder[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds =
    await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const records = await purchaseOrderRepository.list(filters, buildingIds);
  return records.map(toPublic);
}

/**
 * Updates a DRAFT Purchase Order. Identity, commitment context and derived
 * scope are immutable (enforced in validation); only commercial detail may
 * change before issuance.
 */
export async function updatePurchaseOrder(
  id: string,
  input: UpdatePurchaseOrderInput,
  actorUserId: string,
): Promise<PublicPurchaseOrder> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status !== 'DRAFT') throw purchaseOrderNotDraftError();
  if (await isRfqDerivedPurchaseOrder(id)) throw purchaseOrderRfqDerivedImmutableError();

  const updated = await purchaseOrderRepository.update(id, input, actorUserId);
  if (!updated) throw purchaseOrderNotDraftError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    eventType: 'PURCHASE_ORDER_UPDATED',
    entityType: 'PURCHASE_ORDER',
    entityId: updated.id,
    actorUserId,
    summary: `Purchase Order ${updated.poNumber} updated.`,
    metadata: { status: updated.status, fields: Object.keys(input) },
  });

  return toPublic(updated);
}

/**
 * Cancels a DRAFT Purchase Order (terminal). Cancelling releases the
 * qualifying readiness so a corrected commitment can be raised against it.
 * ISSUED commitments are not cancellable by the current API.
 */
export async function cancelPurchaseOrder(
  id: string,
  actorUserId: string,
): Promise<PublicPurchaseOrder> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status !== 'DRAFT') throw purchaseOrderCancelNotAllowedError();
  if (await isRfqDerivedPurchaseOrder(id)) throw purchaseOrderRfqDerivedImmutableError();

  const cancelled = await purchaseOrderRepository.cancel(id, actorUserId);
  if (!cancelled) throw purchaseOrderCancelNotAllowedError();

  await recordOperationalEvent({
    clientId: cancelled.clientId,
    buildingId: cancelled.buildingId,
    eventType: 'PURCHASE_ORDER_CANCELLED',
    entityType: 'PURCHASE_ORDER',
    entityId: cancelled.id,
    actorUserId,
    summary: `Purchase Order ${cancelled.poNumber} cancelled.`,
    metadata: {
      previousStatus: current.status,
      poReadinessId: cancelled.poReadinessId,
    },
  });

  return toPublic(cancelled);
}

// ─── PART 03: Issue / Status / Approval Readiness ───────────────

/**
 * Resolves the deterministic issue-readiness of a Purchase Order.
 *
 * PURE READ-ONLY — evaluating mutates nothing.
 *
 * NO SECOND READINESS AUTHORITY: the `PO_READINESS_NOT_READY` blocker simply
 * reports BE-17F's own verdict verbatim. This function never recomputes,
 * overrides or persists a readiness decision; BE-17F stays the sole
 * readiness authority and a hard precondition for issuance.
 *
 * MR/SR stay the quantity authority: request lines are only READ to confirm
 * they are still valid and in scope. No quantity is compared, recomputed,
 * reserved or written, and no receiving/inventory/over-receipt rule is
 * touched.
 */
async function evaluateIssueReadiness(
  purchaseOrder: PurchaseOrderRecord,
): Promise<{
  blockers: PurchaseOrderIssueBlocker[];
  poReadiness: string | null;
  lineCount: number;
}> {
  const blockers: PurchaseOrderIssueBlocker[] = [];

  // 1. Deterministic lifecycle: only DRAFT is issuable.
  if (purchaseOrder.status !== 'DRAFT') {
    blockers.push('PO_NOT_DRAFT');
  }

  // 2. BE-17F readiness — precondition, verdict read verbatim.
  const readiness = await poReadinessRepository.findById(
    purchaseOrder.poReadinessId,
  );
  let poReadinessVerdict: string | null = null;
  if (!readiness) {
    blockers.push('PO_READINESS_INVALID');
  } else {
    poReadinessVerdict = readiness.readiness;
    if (readiness.readiness !== 'READY') {
      blockers.push('PO_READINESS_NOT_READY');
    }
    // The readiness must still describe this exact commitment.
    if (
      readiness.clientId !== purchaseOrder.clientId ||
      readiness.buildingId !== purchaseOrder.buildingId ||
      readiness.vendorId !== purchaseOrder.vendorId
    ) {
      blockers.push('SCOPE_INCONSISTENT');
    }
    if (
      readiness.purchaseRequestId !== purchaseOrder.purchaseRequestId ||
      readiness.serviceRequestId !== purchaseOrder.serviceRequestId
    ) {
      blockers.push('REQUEST_LINKAGE_INVALID');
    }
  }

  // 3. The PO's own request linkage must be internally consistent.
  const hasPurchaseRequest = purchaseOrder.purchaseRequestId !== null;
  const hasServiceRequest = purchaseOrder.serviceRequestId !== null;
  if (hasPurchaseRequest === hasServiceRequest) {
    blockers.push('REQUEST_LINKAGE_INVALID');
  } else if (
    (purchaseOrder.requestType === 'PURCHASE_REQUEST' && !hasPurchaseRequest) ||
    (purchaseOrder.requestType === 'SERVICE_REQUEST' && !hasServiceRequest)
  ) {
    blockers.push('REQUEST_LINKAGE_INVALID');
  }

  // 4. Vendor must still be committable at issuance time.
  try {
    await assertVendorCommittable(
      purchaseOrder.vendorId,
      purchaseOrder.clientId,
      purchaseOrder.buildingId,
    );
  } catch {
    blockers.push('VENDOR_NOT_COMMITTABLE');
  }

  // 5. An empty commitment is never issuable (PART 02 lines).
  const lines = await purchaseOrderLineRepository.listByPurchaseOrder(
    purchaseOrder.id,
  );
  if (lines.length === 0) {
    blockers.push('NO_PURCHASE_ORDER_LINES');
  }

  // 6. Every committed line must still reference a valid, live request line
  //    in the PO's own scope. READ-ONLY: no quantity is evaluated.
  for (const line of lines) {
    if (
      line.clientId !== purchaseOrder.clientId ||
      line.buildingId !== purchaseOrder.buildingId
    ) {
      if (!blockers.includes('SCOPE_INCONSISTENT')) {
        blockers.push('SCOPE_INCONSISTENT');
      }
      continue;
    }

    if (line.materialRequestId) {
      const requestLine = await materialRequestRepository.findById(
        line.materialRequestId,
      );
      // Mirrors PART 02 `resolveMaterialRequestLine`: a cancelled line is
      // never committable, and it must still belong to this PO's Purchase
      // Request and scope. Quantity is deliberately NOT re-evaluated —
      // MR/SR remains the quantity authority.
      const usable =
        requestLine !== null &&
        (requestLine.status === 'OPEN' || requestLine.status === 'APPROVED') &&
        purchaseOrder.purchaseRequestId !== null &&
        requestLine.purchaseRequestId === purchaseOrder.purchaseRequestId &&
        requestLine.clientId === purchaseOrder.clientId &&
        requestLine.buildingId === purchaseOrder.buildingId;
      if (!usable && !blockers.includes('REQUEST_LINE_INVALID')) {
        blockers.push('REQUEST_LINE_INVALID');
      }
      continue;
    }

    if (line.serviceRequestId) {
      const request = await serviceRequestRepository.findById(
        line.serviceRequestId,
      );
      // Mirrors PART 02 `resolveServiceRequestLine`: the service line is
      // either the PO's own committed Service Request, or a service line
      // belonging to the PO's Purchase Request. Both sides are null-guarded
      // so a null === null comparison can never pass as a match.
      const matchesServiceRequestPo =
        request !== null &&
        purchaseOrder.serviceRequestId !== null &&
        purchaseOrder.serviceRequestId === request.id;
      const matchesPurchaseRequestPo =
        request !== null &&
        purchaseOrder.purchaseRequestId !== null &&
        purchaseOrder.purchaseRequestId === request.purchaseRequestId;
      const inScope =
        request !== null &&
        request.status === 'OPEN' &&
        request.clientId === purchaseOrder.clientId &&
        request.buildingId === purchaseOrder.buildingId &&
        (matchesServiceRequestPo || matchesPurchaseRequestPo);
      if (!inScope && !blockers.includes('REQUEST_LINE_INVALID')) {
        blockers.push('REQUEST_LINE_INVALID');
      }
    }
  }

  return { blockers, poReadiness: poReadinessVerdict, lineCount: lines.length };
}

async function canManagePurchaseOrders(actorUserId: string): Promise<boolean> {
  const permissions =
    await permissionService.resolvePermissionsForUser(actorUserId);
  return permissions.includes('purchase_order.manage');
}

/**
 * Read-only issue-readiness projection for a Purchase Order.
 *
 * `availableActions` follows the established caller-specific convention:
 * upper-case command tokens, filtered by both current business authority and
 * the existing `purchase_order.manage` permission. The endpoint itself still
 * requires only `purchase_order.read`, so a read-only caller receives `[]`.
 */
export async function getPurchaseOrderIssueReadiness(
  id: string,
  actorUserId: string,
): Promise<PurchaseOrderIssueReadinessResult> {
  const purchaseOrder = await loadAccessible(id, actorUserId);
  const { blockers, poReadiness, lineCount } =
    await evaluateIssueReadiness(purchaseOrder);
  const issuable = blockers.length === 0;
  const canManage = await canManagePurchaseOrders(actorUserId);

  return {
    purchaseOrderId: purchaseOrder.id,
    status: purchaseOrder.status,
    issuable,
    poReadiness,
    lineCount,
    blockers,
    availableActions: issuable && canManage ? ['ISSUE'] : [],
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * CR-BE-R2P-CONTRACT-01 PART 01 — backend-authoritative PO actions.
 *
 * Mirrors only commands that already exist. CANCEL is available only from
 * DRAFT because that is the current command behavior. ISSUE reuses the same
 * deterministic readiness evaluator as the issue command. No PO transition
 * is added or changed here.
 */
export async function resolvePurchaseOrderAvailableActions(
  id: string,
  actorUserId: string,
): Promise<PurchaseOrderAvailableActions> {
  const purchaseOrder = await loadAccessible(id, actorUserId);
  const availableActions: PurchaseOrderAvailableActions['availableActions'] =
    [];

  if (
    purchaseOrder.status === 'DRAFT' &&
    (await canManagePurchaseOrders(actorUserId))
  ) {
    const { blockers } = await evaluateIssueReadiness(purchaseOrder);
    if (blockers.length === 0) availableActions.push('ISSUE');
    availableActions.push('CANCEL');
  }

  return {
    purchaseOrderId: purchaseOrder.id,
    state: purchaseOrder.status,
    availableActions,
  };
}

/**
 * Issues a Purchase Order: DRAFT → ISSUED.
 *
 * Preconditions (all deterministic, all from existing authorities):
 *   - the PO is DRAFT (invalid/repeated issuance is rejected)
 *   - BE-17F PO Readiness is READY — precondition only, verdict read verbatim
 *   - the PO has at least one line (no empty commitment)
 *   - request linkage, vendor and Client/Building scope are consistent
 *
 * The state transition is guarded by `status = 'DRAFT'` inside the UPDATE and
 * the row is locked FOR UPDATE first, so two concurrent issue commands cannot
 * both succeed. Failure is non-mutating.
 *
 * Issuance records only `issued_at` / `issued_by_user_id` — the minimum
 * metadata for safe issuance. No quantity, receiving, inventory or
 * over-receipt state is created or changed.
 */
export async function issuePurchaseOrder(
  id: string,
  input: IssuePurchaseOrderInput,
  actorUserId: string,
): Promise<PublicPurchaseOrder> {
  const current = await loadAccessible(id, actorUserId);

  // Fail fast with a precise lifecycle error before readiness evaluation, so
  // a repeated issuance reports the transition problem rather than a blocker
  // list.
  if (current.status !== 'DRAFT') {
    throw purchaseOrderNotIssuableStateError(current.status);
  }

  const pool = getPool();
  const client = await pool.connect();
  let record: PurchaseOrderRecord;
  try {
    await client.query('BEGIN');

    // Lock the commitment so the readiness verdict, the line-count guard and
    // the transition all decide against a stable row.
    const locked = await purchaseOrderRepository.findByIdForUpdate(client, id);
    if (!locked) throw purchaseOrderNotFoundError();
    if (locked.status !== 'DRAFT') {
      throw purchaseOrderNotIssuableStateError(locked.status);
    }

    const { blockers } = await evaluateIssueReadiness(locked);
    if (blockers.length > 0) {
      // Surface the single most actionable cause with its own error code
      // where one exists; otherwise report the full deterministic blocker set.
      if (
        blockers.length === 1 &&
        blockers[0] === 'NO_PURCHASE_ORDER_LINES'
      ) {
        throw purchaseOrderNoLinesError();
      }
      throw purchaseOrderNotIssuableError(blockers);
    }

    const issued = await purchaseOrderRepository.issueWithClient(
      client,
      id,
      actorUserId,
    );
    if (!issued) throw purchaseOrderNotIssuableStateError(locked.status);
    record = issued;

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'PURCHASE_ORDER_ISSUED',
    entityType: 'PURCHASE_ORDER',
    entityId: record.id,
    actorUserId,
    summary: `Purchase Order ${record.poNumber} issued to the Vendor.`,
    metadata: {
      vendorId: record.vendorId,
      poReadinessId: record.poReadinessId,
      requestType: record.requestType,
      purchaseRequestId: record.purchaseRequestId,
      serviceRequestId: record.serviceRequestId,
      issuedAt: record.issuedAt?.toISOString() ?? null,
      ...(input.notes ? { notes: input.notes } : {}),
    },
  });

  return toPublic(record);
}

export const purchaseOrderService = {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  getPurchaseOrderIssueReadiness,
  issuePurchaseOrder,
  listPurchaseOrders,
  resolvePurchaseOrderAvailableActions,
  updatePurchaseOrder,
};
