/**
 * BE-17E — Vendor Selection Readiness domain types.
 *
 * A Vendor Selection Readiness record is a snapshot of whether a candidate
 * BE-06 Vendor is ready to be selected for a Procurement request (BE-17A
 * Purchase Request or BE-17C Service Request). It is NOT a tender / RFQ /
 * bidding platform and carries no scoring or Purchase Order Readiness.
 *
 * The readiness is resolved from BE-06 foundation data at evaluation time:
 * Vendor ACTIVE status, ACTIVE Building relationship, capability / service
 * match, compliance and license/certification expiry, and the request's
 * approval prerequisite (BE-17D).
 */
export const VENDOR_SELECTION_REQUEST_TYPES = [
  'PURCHASE_REQUEST',
  'SERVICE_REQUEST',
] as const;
export type VendorSelectionRequestType =
  (typeof VENDOR_SELECTION_REQUEST_TYPES)[number];

export const VENDOR_SELECTION_READINESS = [
  'READY',
  'NOT_READY',
  'EXPIRED',
  'INELIGIBLE',
] as const;
export type VendorSelectionReadiness =
  (typeof VENDOR_SELECTION_READINESS)[number];

export function isVendorSelectionRequestType(
  value: unknown,
): value is VendorSelectionRequestType {
  return (
    typeof value === 'string' &&
    (VENDOR_SELECTION_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

export function isVendorSelectionReadiness(
  value: unknown,
): value is VendorSelectionReadiness {
  return (
    typeof value === 'string' &&
    (VENDOR_SELECTION_READINESS as readonly string[]).includes(value)
  );
}

/** The resolved individual checks of a readiness evaluation. */
export type VendorSelectionChecks = {
  vendorActive: boolean;
  buildingRelationshipOk: boolean;
  capabilityMatch: boolean;
  complianceOk: boolean;
  licenseOk: boolean;
  approvalOk: boolean;
};

/** Full database record. */
export type VendorSelectionRecord = VendorSelectionChecks & {
  id: string;
  clientId: string;
  buildingId: string;
  requestType: VendorSelectionRequestType;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  vendorId: string;
  serviceType: string;
  /**
   * CR-BE-SVC-01 PART 03 — governed demand identity snapshot at evaluation
   * time (the request's `service_catalog_id`, or NULL for un-governed /
   * purchase requests). Parallels the `serviceType` snapshot.
   */
  serviceCatalogId: string | null;
  readiness: VendorSelectionReadiness;
  notes: string | null;
  evaluatedByUserId: string;
  evaluatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorSelection = Omit<
  VendorSelectionRecord,
  'evaluatedAt' | 'createdAt' | 'updatedAt'
> & {
  requestId: string;
  evaluatedAt: string;
  createdAt: string;
  updatedAt: string;
  vendor?: {
    id: string;
    vendorCode: string;
    vendorName: string;
    status: string;
  } | null;
  purchaseRequest?: {
    id: string;
    requestNumber: string;
    title: string;
    status: string;
  } | null;
  serviceRequest?: {
    id: string;
    title: string;
    serviceType: string;
    status: string;
  } | null;
};

/** Input supplied when evaluating a candidate Vendor. */
export type CreateVendorSelectionInput = {
  requestType: VendorSelectionRequestType;
  requestId: string;
  vendorId: string;
  notes?: string;
};

/** Fully-resolved readiness evaluation ready for persistence. */
export type NewVendorSelection = VendorSelectionChecks & {
  clientId: string;
  buildingId: string;
  requestType: VendorSelectionRequestType;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  vendorId: string;
  serviceType: string;
  /** CR-BE-SVC-01 PART 03 — governed demand identity snapshot. */
  serviceCatalogId: string | null;
  readiness: VendorSelectionReadiness;
  notes: string | null;
  evaluatedByUserId: string;
};

/** List filters for GET /vendors/:vendorId/readiness and request lists. */
export type VendorSelectionFilters = {
  readiness?: VendorSelectionReadiness;
};
