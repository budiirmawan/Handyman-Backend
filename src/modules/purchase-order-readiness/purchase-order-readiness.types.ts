/**
 * BE-17F — Purchase Order Readiness domain types.
 *
 * A Purchase Order Readiness snapshot records whether an approved Procurement
 * request (BE-17A Purchase Request or BE-17C Service Request) with a selected
 * Vendor (BE-17E) is ready to become a Purchase Order. This is PO readiness
 * ONLY — not a full Purchase Order / ERP engine, and no invoice, payment, tax,
 * accounting, or 3-way matching.
 *
 * Readiness is resolved from existing foundations at evaluation time:
 * approved approval binding (BE-17D), READY Vendor Selection Readiness
 * (BE-17E), and a valid material/service context (BE-17B/BE-17C).
 */
export const PO_READINESS_REQUEST_TYPES = [
  'PURCHASE_REQUEST',
  'SERVICE_REQUEST',
] as const;
export type POReadinessRequestType = (typeof PO_READINESS_REQUEST_TYPES)[number];

export const PO_READINESS_STATUSES = ['READY', 'NOT_READY', 'BLOCKED'] as const;
export type POReadinessStatus = (typeof PO_READINESS_STATUSES)[number];

export function isPOReadinessRequestType(
  value: unknown,
): value is POReadinessRequestType {
  return (
    typeof value === 'string' &&
    (PO_READINESS_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

export function isPOReadinessStatus(value: unknown): value is POReadinessStatus {
  return (
    typeof value === 'string' &&
    (PO_READINESS_STATUSES as readonly string[]).includes(value)
  );
}

/** The resolved individual checks of a PO readiness evaluation. */
export type POReadinessChecks = {
  approvalOk: boolean;
  vendorOk: boolean;
  materialContextOk: boolean;
  serviceContextOk: boolean;
};

/** Full database record. */
export type POReadinessRecord = POReadinessChecks & {
  id: string;
  clientId: string;
  buildingId: string;
  requestType: POReadinessRequestType;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  vendorId: string;
  readiness: POReadinessStatus;
  requiredDate: Date | null;
  notes: string | null;
  preparedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicPOReadiness = Omit<
  POReadinessRecord,
  'requiredDate' | 'createdAt' | 'updatedAt'
> & {
  requestId: string;
  requiredDate: string | null;
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

/** Input supplied when evaluating PO readiness. */
export type CreatePOReadinessInput = {
  requestType: POReadinessRequestType;
  requestId: string;
  vendorId: string;
  requiredDate?: string | null;
  notes?: string;
};

/** Fully-resolved readiness evaluation ready for persistence. */
export type NewPOReadiness = POReadinessChecks & {
  clientId: string;
  buildingId: string;
  requestType: POReadinessRequestType;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  vendorId: string;
  readiness: POReadinessStatus;
  requiredDate: Date | null;
  notes: string | null;
  preparedByUserId: string;
};

/** Partial update input (PATCH /po-readiness/:id). */
export type UpdatePOReadinessInput = {
  requiredDate?: string | null;
  notes?: string | null;
};

/** List filters. */
export type POReadinessFilters = {
  readiness?: POReadinessStatus;
};
