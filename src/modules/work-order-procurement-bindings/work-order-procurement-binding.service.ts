import { getPool } from '../../database';
import { contextAccessService } from '../context-access';
import { workOrderRepository } from '../work-orders';
import { purchaseRequestRepository } from '../purchase-requests';
import { materialRequestRepository } from '../material-requests';
import { serviceRequestRepository } from '../service-requests';
import { receivingRepository } from '../receivings';
import { poReadinessRepository } from '../purchase-order-readiness';
import { purchaseOrderRepository } from '../purchase-orders';
import { vendorAssignmentRepository } from '../vendor-assignments';
import { workContractRepository } from '../work-contracts';
import {
  woProcurementAlreadyBoundError,
  woProcurementBuildingMismatchError,
  woProcurementNotFoundError,
  woProcurementPurchaseOrderNotIssuedError,
  woProcurementReceivingInvalidError,
  woProcurementReceivingMismatchError,
  woProcurementRequestInvalidError,
  woProcurementVendorMismatchError,
  woProcurementWorkContractAlreadyBoundError,
  woProcurementWorkContractInvalidError,
  woProcurementWorkContractNotActiveError,
} from './work-order-procurement-binding.errors';
import { workOrderProcurementBindingRepository } from './work-order-procurement-binding.repository';
import type {
  BindWorkContractInput,
  CreateWOProcurementBindingInput,
  LinkReceivingInput,
  NewWorkOrderProcurementBinding,
  PublicWorkOrderProcurementBinding,
  WorkOrderProcurementBindingRecord,
  WOProcurementStatus,
} from './work-order-procurement-binding.types';

function requestId(
  binding: WorkOrderProcurementBindingRecord,
): { purchaseRequestId: string | null; serviceRequestId: string | null } {
  return {
    purchaseRequestId: binding.purchaseRequestId,
    serviceRequestId: binding.serviceRequestId,
  };
}

export function toPublic(
  record: WorkOrderProcurementBindingRecord,
): PublicWorkOrderProcurementBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    workOrderId: record.workOrderId,
    purchaseRequestId: record.purchaseRequestId,
    materialRequestId: record.materialRequestId,
    serviceRequestId: record.serviceRequestId,
    receivingId: record.receivingId,
    workContractId: record.workContractId,
    purchaseOrderId: record.purchaseOrderId,
    vendorId: record.vendorId,
    procurementStatus: record.procurementStatus,
    notes: record.notes,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    workOrder: null,
    purchaseRequest: null,
    materialRequest: null,
    serviceRequest: null,
    receiving: null,
    workContract: null,
    purchaseOrder: null,
  };
}

export function toPublicWithDetails(
  detailed: Record<string, unknown>,
): PublicWorkOrderProcurementBinding {
  const base = toPublic(detailed as unknown as WorkOrderProcurementBindingRecord);
  if (detailed.woNumber) {
    base.workOrder = {
      id: detailed.workOrderId as string,
      workOrderNumber: detailed.woNumber as string,
      title: detailed.woTitle as string,
      status: detailed.woStatus as string,
    };
  }
  if (detailed.prNumber) {
    base.purchaseRequest = {
      id: detailed.purchaseRequestId as string,
      requestNumber: detailed.prNumber as string,
      title: detailed.prTitle as string,
      status: detailed.prStatus as string,
    };
  }
  if (detailed.mrItemId) {
    base.materialRequest = {
      id: detailed.materialRequestId as string,
      itemId: detailed.mrItemId as string,
      quantity: Number(detailed.mrQuantity),
      status: detailed.mrStatus as string,
    };
  }
  if (detailed.srTitle) {
    base.serviceRequest = {
      id: detailed.serviceRequestId as string,
      serviceType: detailed.srServiceType as string,
      title: detailed.srTitle as string,
      status: detailed.srStatus as string,
    };
  }
  if (detailed.rvType) {
    base.receiving = {
      id: detailed.receivingId as string,
      receivingType: detailed.rvType as string,
      status: detailed.rvStatus as string,
    };
  }
  // CR-BE-R2P-01 PART 05 — the bound SPK and its Purchase Order.
  if (detailed.wcNumber) {
    base.workContract = {
      id: detailed.workContractId as string,
      spkNumber: detailed.wcNumber as string,
      title: detailed.wcTitle as string,
      status: detailed.wcStatus as string,
    };
  }
  if (detailed.poNumber) {
    base.purchaseOrder = {
      id: detailed.purchaseOrderId as string,
      poNumber: detailed.poNumber as string,
      status: detailed.poStatus as string,
    };
  }
  return base;
}


// ─── CR-BE-R2P-01 PART 05: SPK → PO / Vendor / WO chain ─────────

/**
 * Resolves and enforces the authoritative execution chain:
 *
 *   Request → selected Vendor → ISSUED PO → ACTIVE SPK → Work Order
 *
 * The SPK reference is the ONLY chain input. Purchase Order, Vendor, Client
 * and Building are all DERIVED from the SPK, so caller-supplied context can
 * never override the authoritative values — a mismatch is rejected here and,
 * as a second line of defence, made unrepresentable by the composite FK
 * `wo_procurement_spk_scope_fk`.
 *
 * Read-only with respect to every other domain: the SPK and PO lifecycles are
 * READ, never written, and no quantity, receiving or BAST state is touched.
 */
async function resolveChainContext(
  workContractId: string,
  workOrder: { id: string; clientId: string; buildingId: string },
): Promise<{ workContractId: string; purchaseOrderId: string; vendorId: string }> {
  const workContract = await workContractRepository.findById(workContractId);
  if (!workContract) throw woProcurementWorkContractInvalidError();

  // Only an ACTIVE mandate authorizes work.
  if (workContract.status !== 'ACTIVE') {
    throw woProcurementWorkContractNotActiveError(workContract.status);
  }

  // The Work Order must live in the SPK's own Client + Building.
  if (
    workContract.clientId !== workOrder.clientId ||
    workContract.buildingId !== workOrder.buildingId
  ) {
    throw woProcurementBuildingMismatchError();
  }

  // The SPK's Purchase Order must still be ISSUED for the chain to hold.
  const purchaseOrder = await purchaseOrderRepository.findById(
    workContract.purchaseOrderId,
  );
  if (!purchaseOrder) throw woProcurementWorkContractInvalidError();
  if (purchaseOrder.status !== 'ISSUED') {
    throw woProcurementPurchaseOrderNotIssuedError(purchaseOrder.status);
  }

  // Defensive: PART 04's composite FK already pins the SPK to its PO's scope.
  if (
    purchaseOrder.clientId !== workContract.clientId ||
    purchaseOrder.buildingId !== workContract.buildingId ||
    purchaseOrder.vendorId !== workContract.vendorId
  ) {
    throw woProcurementBuildingMismatchError();
  }

  // The Vendor actually assigned to the Work Order must be the SPK's Vendor.
  // BE-15A vendor assignment is the authority for who executes a Work Order;
  // this reads it rather than duplicating it.
  const assignment =
    await vendorAssignmentRepository.findActiveByVendorAndWorkOrder(
      workContract.vendorId,
      workOrder.id,
    );
  if (!assignment) throw woProcurementVendorMismatchError();

  return {
    workContractId: workContract.id,
    purchaseOrderId: workContract.purchaseOrderId,
    vendorId: workContract.vendorId,
  };
}

/**
 * Binds a Work Order to a Purchase Request (and optionally a Material or
 * Service Request). The Work Order and the procurement request(s) must all
 * belong to the same Client and Building. A Work Order can be bound to only
 * one procurement request (backend-authoritative).
 */
export async function createBinding(
  input: CreateWOProcurementBindingInput,
  actorUserId: string,
): Promise<PublicWorkOrderProcurementBinding> {
  const workOrder = await workOrderRepository.findById(input.workOrderId);
  if (!workOrder) throw woProcurementRequestInvalidError();

  await contextAccessService.assertBuildingAccess(actorUserId, workOrder.buildingId);

  if (await workOrderProcurementBindingRepository.findByWorkOrderId(workOrder.id)) {
    throw woProcurementAlreadyBoundError();
  }

  const purchaseRequest = await purchaseRequestRepository.findById(
    input.purchaseRequestId,
  );
  if (!purchaseRequest) throw woProcurementRequestInvalidError();
  assertSameScope(
    workOrder.clientId,
    workOrder.buildingId,
    purchaseRequest.clientId,
    purchaseRequest.buildingId,
  );

  let materialRequestId: string | null = null;
  if (input.materialRequestId) {
    const mr = await materialRequestRepository.findById(input.materialRequestId);
    if (!mr) throw woProcurementRequestInvalidError();
    assertSameScope(
      workOrder.clientId,
      workOrder.buildingId,
      mr.clientId,
      mr.buildingId,
    );
    if (mr.purchaseRequestId !== purchaseRequest.id) {
      throw woProcurementRequestInvalidError();
    }
    materialRequestId = mr.id;
  }

  let serviceRequestId: string | null = null;
  if (input.serviceRequestId) {
    const sr = await serviceRequestRepository.findById(input.serviceRequestId);
    if (!sr) throw woProcurementRequestInvalidError();
    assertSameScope(
      workOrder.clientId,
      workOrder.buildingId,
      sr.clientId,
      sr.buildingId,
    );
    if (sr.purchaseRequestId !== purchaseRequest.id) {
      throw woProcurementRequestInvalidError();
    }
    serviceRequestId = sr.id;
  }

  // PART 05 — the SPK chain is optional at create time so the existing
  // request-only binding flow is preserved exactly.
  const chain = input.workContractId
    ? await resolveChainContext(input.workContractId, workOrder)
    : null;

  const newRecord: NewWorkOrderProcurementBinding = {
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    workOrderId: workOrder.id,
    purchaseRequestId: purchaseRequest.id,
    materialRequestId,
    serviceRequestId,
    receivingId: null,
    workContractId: chain?.workContractId ?? null,
    purchaseOrderId: chain?.purchaseOrderId ?? null,
    vendorId: chain?.vendorId ?? null,
    procurementStatus: 'BOUND',
    notes: input.notes?.trim() || null,
    createdByUserId: actorUserId,
  };

  try {
    const record = await workOrderProcurementBindingRepository.create(newRecord);
    const detailed = await workOrderProcurementBindingRepository.findByIdWithDetails(
      record.id,
    );
    return detailed ? toPublicWithDetails(detailed) : toPublic(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw woProcurementAlreadyBoundError();
    throw error;
  }
}

export async function getBinding(
  id: string,
  actorUserId: string,
): Promise<PublicWorkOrderProcurementBinding> {
  const detailed = await workOrderProcurementBindingRepository.findByIdWithDetails(id);
  if (!detailed) throw woProcurementNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    (detailed as unknown as WorkOrderProcurementBindingRecord).buildingId,
  );
  return toPublicWithDetails(detailed);
}

/** Lists the procurement context bound to a Work Order. */
export async function listByWorkOrder(
  workOrderId: string,
  actorUserId: string,
): Promise<PublicWorkOrderProcurementBinding[]> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) throw woProcurementRequestInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, workOrder.buildingId);
  const records = await workOrderProcurementBindingRepository.listByWorkOrderId(
    workOrderId,
  );
  return records.map(toPublic);
}

/**
 * Resolves the procurement readiness status of a binding. A READY PO readiness
 * (BE-17F) for the purchase/service request promotes the binding from BOUND to
 * READY. Backend-authoritative.
 */
export async function resolveReadiness(
  id: string,
  actorUserId: string,
): Promise<PublicWorkOrderProcurementBinding> {
  const record = await workOrderProcurementBindingRepository.findById(id);
  if (!record) throw woProcurementNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);

  const readiness = await poReadinessRepository.findExistingForRequest(
    record.purchaseRequestId,
    record.serviceRequestId,
  );
  const status: WOProcurementStatus = readiness ? 'READY' : 'BOUND';

  const updated =
    await workOrderProcurementBindingRepository.updateStatus(id, status);
  const detailed = await workOrderProcurementBindingRepository.findByIdWithDetails(
    updated!.id,
  );
  return detailed ? toPublicWithDetails(detailed) : toPublic(updated!);
}

/**
 * Links a Receiving record to a binding. The receiving must belong to the same
 * Client / Building and to the binding's request; linking promotes the status
 * to RECEIVED.
 */
export async function linkReceiving(
  id: string,
  input: LinkReceivingInput,
  actorUserId: string,
): Promise<PublicWorkOrderProcurementBinding> {
  const record = await workOrderProcurementBindingRepository.findById(id);
  if (!record) throw woProcurementNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);

  const receiving = await receivingRepository.findById(input.receivingId);
  if (!receiving) throw woProcurementReceivingInvalidError();
  if (
    receiving.clientId !== record.clientId ||
    receiving.buildingId !== record.buildingId
  ) {
    throw woProcurementReceivingMismatchError();
  }
  const bindingRequest = requestId(record);
  if (
    receiving.purchaseRequestId !== bindingRequest.purchaseRequestId ||
    receiving.serviceRequestId !== bindingRequest.serviceRequestId
  ) {
    throw woProcurementReceivingMismatchError();
  }

  const updated = await workOrderProcurementBindingRepository.linkReceiving(
    id,
    receiving.id,
  );
  const detailed = await workOrderProcurementBindingRepository.findByIdWithDetails(
    updated!.id,
  );
  return detailed ? toPublicWithDetails(detailed) : toPublic(updated!);
}

function assertSameScope(
  woClientId: string,
  woBuildingId: string,
  reqClientId: string,
  reqBuildingId: string,
): void {
  if (woClientId !== reqClientId || woBuildingId !== reqBuildingId) {
    throw woProcurementBuildingMismatchError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string };
  return candidate.code === '23505';
}

/**
 * CR-BE-R2P-01 PART 05 — binds an ACTIVE SPK to the EXISTING authoritative
 * procurement binding of a Work Order.
 *
 * This EXTENDS the existing binding row; it does not create a parallel SPK ↔
 * WO binding domain, and the one-binding-per-Work-Order guarantee is
 * untouched. An already-bound binding is never silently overwritten.
 */
export async function bindWorkContract(
  id: string,
  input: BindWorkContractInput,
  actorUserId: string,
): Promise<PublicWorkOrderProcurementBinding> {
  const record = await workOrderProcurementBindingRepository.findById(id);
  if (!record) throw woProcurementNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    record.buildingId,
  );

  if (record.workContractId) {
    throw woProcurementWorkContractAlreadyBoundError();
  }

  const workOrder = await workOrderRepository.findById(record.workOrderId);
  if (!workOrder) throw woProcurementRequestInvalidError();

  const chain = await resolveChainContext(input.workContractId, workOrder);

  const updated = await workOrderProcurementBindingRepository.bindWorkContract(
    id,
    chain,
  );
  // Lost the race: another command bound this row first.
  if (!updated) throw woProcurementWorkContractAlreadyBoundError();

  const detailed =
    await workOrderProcurementBindingRepository.findByIdWithDetails(updated.id);
  return detailed ? toPublicWithDetails(detailed) : toPublic(updated);
}

export const workOrderProcurementBindingService = {
  bindWorkContract,
  createBinding,
  getBinding,
  linkReceiving,
  listByWorkOrder,
  resolveReadiness,
  toPublic,
  toPublicWithDetails,
};
