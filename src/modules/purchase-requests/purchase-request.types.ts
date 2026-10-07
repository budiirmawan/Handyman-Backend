/**
 * BE-17A — Purchase Request domain types.
 *
 * A Purchase Request is a lightweight operational procurement intake record.
 * It captures intake and basic state only: request number, requester
 * reference, Building context, request type, title/description, required date,
 * priority, status, and requested_at. It carries NO approval, vendor
 * selection, purchase order, receiving, or payment/accounting concerns —
 * those arrive in later BE-17 PARTs.
 *
 * `request_type` is a data-driven code string (never a hardcoded
 * MATERIAL/SERVICE model). `priority` mirrors the BE-08 Work Order set.
 * `requested_at` is set by the backend at creation, never supplied by the
 * client.
 */
export const PURCHASE_REQUEST_STATUSES = ['OPEN', 'CANCELLED'] as const;

export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];

export function isPurchaseRequestStatus(
  value: unknown,
): value is PurchaseRequestStatus {
  return (
    typeof value === 'string' &&
    (PURCHASE_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

export const PURCHASE_REQUEST_PRIORITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type PurchaseRequestPriority =
  (typeof PURCHASE_REQUEST_PRIORITIES)[number];

export function isPurchaseRequestPriority(
  value: unknown,
): value is PurchaseRequestPriority {
  return (
    typeof value === 'string' &&
    (PURCHASE_REQUEST_PRIORITIES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type PurchaseRequestRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  requestNumber: string;
  requesterReference: string | null;
  requestType: string;
  title: string;
  description: string | null;
  requiredDate: Date | null;
  priority: PurchaseRequestPriority;
  status: PurchaseRequestStatus;
  requestedByUserId: string;
  requestedAt: Date;
  /**
   * CR-BE-RN11-MATERIAL-FIELD-01 PART 00 — Work Order source of a field
   * procurement parent. NULL for every management / historical Purchase
   * Request; set only by the internal Work-Order field parent helper. At most
   * one Purchase Request per Work Order (partial unique index). Internal in
   * PART 00 — not exposed on PublicPurchaseRequest.
   */
  workOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicPurchaseRequest = {
  id: string;
  clientId: string;
  buildingId: string;
  requestNumber: string;
  requesterReference: string | null;
  requestType: string;
  title: string;
  description: string | null;
  requiredDate: string | null;
  priority: PurchaseRequestPriority;
  status: PurchaseRequestStatus;
  requestedByUserId: string;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
};

/** Input supplied by the API consumer when creating a Purchase Request. */
export type CreatePurchaseRequestInput = {
  clientId: string;
  buildingId: string;
  requestNumber: string;
  requesterReference?: string;
  requestType: string;
  title: string;
  description?: string;
  requiredDate?: string | null;
  priority?: PurchaseRequestPriority;
  requestedByUserId: string;
};

/** Fully-resolved Purchase Request data ready for persistence. */
export type NewPurchaseRequest = {
  clientId: string;
  buildingId: string;
  requestNumber: string;
  requesterReference: string | null;
  requestType: string;
  title: string;
  description: string | null;
  requiredDate: Date | null;
  priority: PurchaseRequestPriority;
  requestedByUserId: string;
  /** PART 00 — internal only; management create never sets it. */
  workOrderId?: string | null;
};

/** Partial update input (PATCH /purchase-requests/:id). */
export type UpdatePurchaseRequestInput = {
  requesterReference?: string | null;
  requestType?: string;
  title?: string;
  description?: string | null;
  requiredDate?: string | null;
  priority?: PurchaseRequestPriority;
};

/** List filters for GET /buildings/:buildingId/purchase-requests. */
export type PurchaseRequestFilters = {
  status?: PurchaseRequestStatus;
  requestType?: string;
  requesterUserId?: string;
  priority?: PurchaseRequestPriority;
};
