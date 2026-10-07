import { getPool } from '../../database';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { purchaseRequestRepository } from '../purchase-requests';
import { serviceRequestRepository } from '../service-requests';
import { materialRequestRepository } from '../material-requests';
import { vendorRepository } from '../vendors';
import { vendorSelectionRepository } from '../vendor-selection-readiness';
import {
  poReadinessAlreadyExistsError,
  poReadinessNotFoundError,
  poReadinessNotOpenError,
  poReadinessRequestInvalidError,
  poReadinessVendorInvalidError,
} from './purchase-order-readiness.errors';
import { poReadinessRepository } from './purchase-order-readiness.repository';
import type {
  CreatePOReadinessInput,
  NewPOReadiness,
  POReadinessChecks,
  POReadinessFilters,
  POReadinessRecord,
  POReadinessRequestType,
  POReadinessStatus,
  PublicPOReadiness,
  UpdatePOReadinessInput,
} from './purchase-order-readiness.types';

type RequestContext = {
  clientId: string;
  buildingId: string;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
};

function requestId(record: POReadinessRecord): string {
  return (record.purchaseRequestId ?? record.serviceRequestId)!;
}

export function toPublicPOReadiness(record: POReadinessRecord): PublicPOReadiness {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    requestType: record.requestType,
    purchaseRequestId: record.purchaseRequestId,
    serviceRequestId: record.serviceRequestId,
    requestId: requestId(record),
    vendorId: record.vendorId,
    materialContextOk: record.materialContextOk,
    serviceContextOk: record.serviceContextOk,
    approvalOk: record.approvalOk,
    vendorOk: record.vendorOk,
    readiness: record.readiness,
    requiredDate: record.requiredDate ? record.requiredDate.toISOString() : null,
    notes: record.notes,
    preparedByUserId: record.preparedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    vendor: null,
    purchaseRequest: null,
    serviceRequest: null,
  };
}

export function toPublicWithDetails(
  detailed: Record<string, unknown>,
): PublicPOReadiness {
  const base = toPublicPOReadiness(detailed as unknown as POReadinessRecord);
  if (detailed.vendorCode) {
    base.vendor = {
      id: detailed.vendorId as string,
      vendorCode: detailed.vendorCode as string,
      vendorName: detailed.vendorName as string,
      status: detailed.vendorStatus as string,
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
  if (detailed.srTitle) {
    base.serviceRequest = {
      id: detailed.serviceRequestId as string,
      title: detailed.srTitle as string,
      serviceType: (detailed.srServiceType as string) ?? (detailed.serviceType as string),
      status: detailed.srStatus as string,
    };
  }
  return base;
}

async function resolveRequest(
  type: POReadinessRequestType,
  id: string,
): Promise<RequestContext> {
  if (type === 'PURCHASE_REQUEST') {
    const pr = await purchaseRequestRepository.findById(id);
    if (!pr) throw poReadinessRequestInvalidError();
    return {
      clientId: pr.clientId,
      buildingId: pr.buildingId,
      purchaseRequestId: pr.id,
      serviceRequestId: null,
    };
  }
  const sr = await serviceRequestRepository.findById(id);
  if (!sr) throw poReadinessRequestInvalidError();
  return {
    clientId: sr.clientId,
    buildingId: sr.buildingId,
    purchaseRequestId: null,
    serviceRequestId: sr.id,
  };
}

/**
 * Evaluates PO readiness for an approved request + selected Vendor.
 *
 * Checks (reusing existing foundations):
 *  - approvalOk:   the request must have an APPROVED procurement approval
 *                  binding (BE-17D). PO readiness only applies to an approved
 *                  request, so an unapproved (or approval-pending) request is
 *                  blocked.
 *  - vendorOk:     a Vendor Selection Readiness (BE-17E) for this request and
 *                  vendor resolves to READY, and the vendor belongs to the
 *                  request's Client.
 *  - materialContextOk: for a Purchase Request, at least one OPEN Material
 *                  Request exists (BE-17B).
 *  - serviceContextOk: for a Service Request, the request itself is the
 *                  service context (BE-17C) — inherently satisfied.
 *
 * Readiness resolution:
 *  - !approvalOk            → BLOCKED
 *  - !vendorOk              → NOT_READY
 *  - material/service context invalid → NOT_READY
 *  - otherwise              → READY
 */
export async function createPOReadiness(
  input: CreatePOReadinessInput,
  actorUserId: string,
): Promise<PublicPOReadiness> {
  const target = await resolveRequest(input.requestType, input.requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);

  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) throw poReadinessVendorInvalidError();
  if (vendor.clientId !== target.clientId) throw poReadinessVendorInvalidError();

  if (
    await poReadinessRepository.findExisting(
      input.vendorId,
      target.purchaseRequestId,
      target.serviceRequestId,
    )
  ) {
    throw poReadinessAlreadyExistsError();
  }

  const checks = await resolveChecks(input.vendorId, target);
  const readiness = resolveReadiness(checks);

  const newRecord: NewPOReadiness = {
    clientId: target.clientId,
    buildingId: target.buildingId,
    requestType: input.requestType,
    purchaseRequestId: target.purchaseRequestId,
    serviceRequestId: target.serviceRequestId,
    vendorId: vendor.id,
    ...checks,
    readiness,
    requiredDate: input.requiredDate ? new Date(input.requiredDate) : null,
    notes: input.notes?.trim() || null,
    preparedByUserId: actorUserId,
  };

  try {
    const record = await poReadinessRepository.create(newRecord);
    const detailed = await poReadinessRepository.findByIdWithDetails(record.id);
    return detailed ? toPublicWithDetails(detailed) : toPublicPOReadiness(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw poReadinessAlreadyExistsError();
    throw error;
  }
}

async function resolveChecks(
  vendorId: string,
  target: RequestContext,
): Promise<POReadinessChecks> {
  const approvalOk = await resolveApprovalOk(target);
  const vendorOk = await resolveVendorOk(vendorId, target);

  let materialContextOk = true;
  let serviceContextOk = true;
  if (target.purchaseRequestId) {
    const materialRequests = await materialRequestRepository.listByPurchaseRequest(
      target.purchaseRequestId,
      {},
    );
    // CR-BE-MAT-01 PART 02: approval promotes lines OPEN → APPROVED, so a
    // valid material context is any non-cancelled line (OPEN or APPROVED).
    materialContextOk = materialRequests.some(
      (materialRequest) => materialRequest.status !== 'CANCELLED',
    );
  } else {
    serviceContextOk = true;
  }

  return { approvalOk, vendorOk, materialContextOk, serviceContextOk };
}

/** Approved only when at least one procurement approval binding is APPROVED. */
async function resolveApprovalOk(target: RequestContext): Promise<boolean> {
  const values: unknown[] = [target.purchaseRequestId, target.serviceRequestId];
  const result = await getPool().query(
    `SELECT status FROM procurement_approval_bindings
     WHERE purchase_request_id IS NOT DISTINCT FROM $1
       AND service_request_id IS NOT DISTINCT FROM $2`,
    values,
  );
  return result.rows.some((row) => row.status === 'APPROVED');
}

/** Vendor is OK when its Vendor Selection Readiness for this request is READY. */
async function resolveVendorOk(
  vendorId: string,
  target: RequestContext,
): Promise<boolean> {
  const selection = await vendorSelectionRepository.findExisting(
    vendorId,
    target.purchaseRequestId,
    target.serviceRequestId,
  );
  return !!selection && selection.readiness === 'READY';
}

export function resolveReadiness(
  checks: POReadinessChecks,
): POReadinessStatus {
  if (!checks.approvalOk) return 'BLOCKED';
  if (!checks.vendorOk) return 'NOT_READY';
  if (!checks.materialContextOk || !checks.serviceContextOk) return 'NOT_READY';
  return 'READY';
}

export async function getPOReadiness(
  id: string,
  actorUserId: string,
): Promise<PublicPOReadiness> {
  const detailed = await poReadinessRepository.findByIdWithDetails(id);
  if (!detailed) throw poReadinessNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    (detailed as unknown as POReadinessRecord).buildingId,
  );
  return toPublicWithDetails(detailed);
}

export async function listPOReadinessByRequest(
  requestType: POReadinessRequestType,
  requestId: string,
  filters: POReadinessFilters,
  actorUserId: string,
): Promise<PublicPOReadiness[]> {
  const target = await resolveRequest(requestType, requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);
  const records = await poReadinessRepository.listByRequest(
    target.purchaseRequestId,
    target.serviceRequestId,
    target.buildingId,
    filters,
  );
  return records.map(toPublicPOReadiness);
}

export async function listPOReadinessByVendor(
  vendorId: string,
  filters: POReadinessFilters,
  actorUserId: string,
): Promise<PublicPOReadiness[]> {
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await poReadinessRepository.listByVendor(
    vendorId,
    buildingIds,
    filters,
  );
  return records.map(toPublicPOReadiness);
}

export async function listPOReadinessByBuilding(
  buildingId: string,
  filters: POReadinessFilters,
  actorUserId: string,
): Promise<PublicPOReadiness[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  const records = await poReadinessRepository.listByBuilding(buildingId, filters);
  return records.map(toPublicPOReadiness);
}

/**
 * Updates an existing PO readiness's required date / notes where allowed
 * (only a READY record is mutable at this PART; a BLOCKED/NOT_READY record is
 * re-evaluated via a fresh create/update rather than silently edited).
 */
export async function updatePOReadiness(
  id: string,
  input: UpdatePOReadinessInput,
  actorUserId: string,
): Promise<PublicPOReadiness> {
  const existing = await poReadinessRepository.findById(id);
  if (!existing) throw poReadinessNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  if (existing.readiness !== 'READY') throw poReadinessNotOpenError();

  const updated = await poReadinessRepository.update(id, {
    ...(input.requiredDate === undefined ? {} : { requiredDate: input.requiredDate }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  });
  return toPublicPOReadiness(updated as POReadinessRecord);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string };
  return candidate.code === '23505';
}

export const poReadinessService = {
  createPOReadiness,
  getPOReadiness,
  listPOReadinessByBuilding,
  listPOReadinessByRequest,
  listPOReadinessByVendor,
  resolveReadiness,
  toPublicPOReadiness,
  toPublicWithDetails,
  updatePOReadiness,
};
