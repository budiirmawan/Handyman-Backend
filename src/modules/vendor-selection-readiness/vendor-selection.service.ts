import { getPool } from '../../database';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { purchaseRequestRepository } from '../purchase-requests';
import { serviceRequestRepository } from '../service-requests';
import { vendorRepository } from '../vendors';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorCapabilityRepository } from '../vendor-capabilities';
import { vendorComplianceDocumentRepository } from '../vendor-compliance-documents';
import { vendorLicenseRepository } from '../vendor-licenses';
import {
  vendorSelectionAlreadyEvaluatedError,
  vendorSelectionNotFoundError,
  vendorSelectionRequestInvalidError,
  vendorSelectionVendorInvalidError,
} from './vendor-selection.errors';
import { vendorSelectionRepository } from './vendor-selection.repository';
import type {
  CreateVendorSelectionInput,
  NewVendorSelection,
  PublicVendorSelection,
  VendorSelectionChecks,
  VendorSelectionFilters,
  VendorSelectionReadiness,
  VendorSelectionRecord,
  VendorSelectionRequestType,
} from './vendor-selection.types';

type RequestContext = {
  clientId: string;
  buildingId: string;
  /** The service/category code to match against Vendor capabilities. */
  serviceType: string;
  /**
   * CR-BE-SVC-01 PART 03 — the request's governed Service Catalog identity
   * (NULL for un-governed / purchase requests). Drives the governed matching
   * rule when the Vendor capability is also governed.
   */
  serviceCatalogId: string | null;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
};

function requestId(record: VendorSelectionRecord): string {
  return (record.purchaseRequestId ?? record.serviceRequestId)!;
}

export function toPublicVendorSelection(
  record: VendorSelectionRecord,
): PublicVendorSelection {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    requestType: record.requestType,
    purchaseRequestId: record.purchaseRequestId,
    serviceRequestId: record.serviceRequestId,
    requestId: requestId(record),
    vendorId: record.vendorId,
    serviceType: record.serviceType,
    serviceCatalogId: record.serviceCatalogId,
    vendorActive: record.vendorActive,
    buildingRelationshipOk: record.buildingRelationshipOk,
    capabilityMatch: record.capabilityMatch,
    complianceOk: record.complianceOk,
    licenseOk: record.licenseOk,
    approvalOk: record.approvalOk,
    readiness: record.readiness,
    notes: record.notes,
    evaluatedByUserId: record.evaluatedByUserId,
    evaluatedAt: record.evaluatedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    vendor: null,
    purchaseRequest: null,
    serviceRequest: null,
  };
}

export function toPublicWithDetails(
  detailed: Record<string, unknown>,
): PublicVendorSelection {
  const base = toPublicVendorSelection(
    detailed as unknown as VendorSelectionRecord,
  );
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
  type: VendorSelectionRequestType,
  id: string,
): Promise<RequestContext> {
  if (type === 'PURCHASE_REQUEST') {
    const pr = await purchaseRequestRepository.findById(id);
    if (!pr) throw vendorSelectionRequestInvalidError();
    return {
      clientId: pr.clientId,
      buildingId: pr.buildingId,
      serviceType: pr.requestType,
      // CR-BE-SVC-01 PART 03 — purchase requests carry no governed service identity.
      serviceCatalogId: null,
      purchaseRequestId: pr.id,
      serviceRequestId: null,
    };
  }
  const sr = await serviceRequestRepository.findById(id);
  if (!sr) throw vendorSelectionRequestInvalidError();
  return {
    clientId: sr.clientId,
    buildingId: sr.buildingId,
    serviceType: sr.serviceType,
    // CR-BE-SVC-01 PART 03 — governed demand identity propagated from the
    // service request's anchor (PART 02).
    serviceCatalogId: sr.serviceCatalogId,
    purchaseRequestId: null,
    serviceRequestId: sr.id,
  };
}

/**
 * Evaluates a candidate Vendor's selection readiness for a request.
 *
 * Individual checks (reusing BE-06 foundation data):
 *  - vendorActive:       Vendor exists and is ACTIVE, in the request's Client.
 *  - buildingRelationshipOk: an ACTIVE Vendor↔Building relationship to the
 *    request's Building (within its effective window, if set).
 *  - capabilityMatch:    the Vendor holds an ACTIVE capability whose code
 *    matches the request's service/category code.
 *  - complianceOk:       no EXPIRED compliance document on the Vendor.
 *  - licenseOk:          no EXPIRED license/certification on the Vendor.
 *  - approvalOk:         if the request has approval bindings (BE-17D), at
 *    least one is APPROVED; a request with none is treated as satisfied.
 *
 * Readiness resolution (simple, not a scoring engine):
 *  - !vendorActive or !buildingRelationshipOk  → INELIGIBLE
 *  - !capabilityMatch or !approvalOk           → NOT_READY
 *  - !complianceOk or !licenseOk               → EXPIRED
 *  - otherwise                                 → READY
 */
export async function createVendorSelection(
  input: CreateVendorSelectionInput,
  actorUserId: string,
): Promise<PublicVendorSelection> {
  const target = await resolveRequest(input.requestType, input.requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);

  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) throw vendorSelectionVendorInvalidError();
  if (vendor.clientId !== target.clientId) {
    throw vendorSelectionVendorInvalidError();
  }

  if (
    await vendorSelectionRepository.findExisting(
      input.vendorId,
      target.purchaseRequestId,
      target.serviceRequestId,
    )
  ) {
    throw vendorSelectionAlreadyEvaluatedError();
  }

  const checks = await resolveChecks(vendor.id, target);
  const readiness = resolveReadiness(checks);

  const newRecord: NewVendorSelection = {
    clientId: target.clientId,
    buildingId: target.buildingId,
    requestType: input.requestType,
    purchaseRequestId: target.purchaseRequestId,
    serviceRequestId: target.serviceRequestId,
    vendorId: vendor.id,
    serviceType: target.serviceType,
    serviceCatalogId: target.serviceCatalogId,
    ...checks,
    readiness,
    notes: input.notes?.trim() || null,
    evaluatedByUserId: actorUserId,
  };

  try {
    const record = await vendorSelectionRepository.create(newRecord);
    const detailed = await vendorSelectionRepository.findByIdWithDetails(record.id);
    return detailed ? toPublicWithDetails(detailed) : toPublicVendorSelection(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw vendorSelectionAlreadyEvaluatedError();
    throw error;
  }
}

/**
 * CR-BE-SVC-01 PART 03 — governed capability matching precedence
 * (governance §7 / PART 03 MATCHING RULE).
 *
 *   - BOTH demand and capability governed (`serviceCatalogId` set on both):
 *     compare the governed identity ONLY — IDs must match; a mismatch is NOT
 *     eligible even when the legacy codes match. No string fallback.
 *   - One-sided or neither governed: normalized code equality (today's
 *     behavior). Governed identity is never invented or auto-linked.
 */
function capabilityMatches(
  cap: { status: string; code: string; serviceCatalogId: string | null },
  target: { serviceType: string; serviceCatalogId: string | null },
): boolean {
  if (cap.status !== 'ACTIVE') {
    return false;
  }
  if (target.serviceCatalogId !== null && cap.serviceCatalogId !== null) {
    // Both governed → identity-only comparison (no legacy fallback).
    return target.serviceCatalogId === cap.serviceCatalogId;
  }
  // One-sided or neither governed → legacy normalized-code equality.
  return cap.code === target.serviceType;
}

async function resolveChecks(
  vendorId: string,
  target: RequestContext,
): Promise<VendorSelectionChecks> {
  const vendor = await vendorRepository.findById(vendorId);
  const vendorActive = !!vendor && vendor.status === 'ACTIVE';

  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendorId,
    target.buildingId,
  );
  const now = new Date();
  const buildingRelationshipOk =
    !!relationship &&
    (!relationship.effectiveFrom || relationship.effectiveFrom <= now) &&
    (!relationship.effectiveUntil || relationship.effectiveUntil >= now);

  const capabilities = await vendorCapabilityRepository.listByVendor(vendorId);
  const capabilityMatch = capabilities.some((cap) =>
    // CR-BE-SVC-01 PART 03 — governed matching precedence (governance §7):
    //   - BOTH demand and capability governed → compare service_catalog_id
    //     ONLY; a mismatch is NOT eligible even when the legacy codes match
    //     (no string fallback). Do not convert a governed mismatch into a
    //     legacy match.
    //   - One-sided or neither governed → normalized code equality (today's
    //     behavior). Governed identity is never invented or auto-linked.
    capabilityMatches(cap, target),
  );

  const complianceDocs =
    await vendorComplianceDocumentRepository.listByVendorId(vendorId);
  const complianceOk = !complianceDocs.some((doc) => doc.status === 'EXPIRED');

  const licenses = await vendorLicenseRepository.listByVendorId(vendorId);
  const licenseOk = !licenses.some((lic) => lic.status === 'EXPIRED');

  const approvalOk = await resolveApprovalPrerequisite(target);

  return {
    vendorActive,
    buildingRelationshipOk,
    capabilityMatch,
    complianceOk,
    licenseOk,
    approvalOk,
  };
}

/**
 * Respects the approval prerequisite where applicable: if the request has any
 * procurement approval bindings, at least one must be APPROVED.
 */
async function resolveApprovalPrerequisite(
  target: RequestContext,
): Promise<boolean> {
  const values: unknown[] = [target.purchaseRequestId, target.serviceRequestId];
  const result = await getPool().query(
    `SELECT status FROM procurement_approval_bindings
     WHERE purchase_request_id IS NOT DISTINCT FROM $1
       AND service_request_id IS NOT DISTINCT FROM $2`,
    values,
  );
  if (result.rows.length === 0) return true;
  return result.rows.some((row) => row.status === 'APPROVED');
}

export function resolveReadiness(
  checks: VendorSelectionChecks,
): VendorSelectionReadiness {
  if (!checks.vendorActive || !checks.buildingRelationshipOk) {
    return 'INELIGIBLE';
  }
  if (!checks.capabilityMatch || !checks.approvalOk) {
    return 'NOT_READY';
  }
  if (!checks.complianceOk || !checks.licenseOk) {
    return 'EXPIRED';
  }
  return 'READY';
}

export async function getVendorSelection(
  id: string,
  actorUserId: string,
): Promise<PublicVendorSelection> {
  const detailed = await vendorSelectionRepository.findByIdWithDetails(id);
  if (!detailed) throw vendorSelectionNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    (detailed as unknown as VendorSelectionRecord).buildingId,
  );
  return toPublicWithDetails(detailed);
}

/**
 * Lists candidate Vendors evaluated for a request (by request id), scoped to
 * the request's Building.
 */
export async function listVendorSelectionsByRequest(
  requestType: VendorSelectionRequestType,
  requestId: string,
  filters: VendorSelectionFilters,
  actorUserId: string,
): Promise<PublicVendorSelection[]> {
  const target = await resolveRequest(requestType, requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);
  const records = await vendorSelectionRepository.listByRequest(
    target.purchaseRequestId,
    target.serviceRequestId,
    target.buildingId,
    filters,
  );
  return records.map(toPublicVendorSelection);
}

/**
 * Lists all readiness evaluations for one Vendor across the caller's
 * accessible Buildings.
 */
export async function listVendorSelectionsByVendor(
  vendorId: string,
  filters: VendorSelectionFilters,
  actorUserId: string,
): Promise<PublicVendorSelection[]> {
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await vendorSelectionRepository.listByVendor(
    vendorId,
    buildingIds,
    filters,
  );
  return records.map(toPublicVendorSelection);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string };
  return candidate.code === '23505';
}

export const vendorSelectionService = {
  createVendorSelection,
  getVendorSelection,
  listVendorSelectionsByRequest,
  listVendorSelectionsByVendor,
  resolveReadiness,
  toPublicVendorSelection,
  toPublicWithDetails,
};
