/**
 * CR-BE-PRO-02 PART 01 — RFQ Foundation + Typed Demand Lineage.
 *
 * This module owns sourcing demand only. It does not own Vendor Invitations,
 * Quotations, Comparison, Award, Purchase Orders, Budgets, or Commitments.
 */

export const RFQ_SOURCE_MODES = ['MATERIAL', 'SERVICE'] as const;
export type RfqSourceMode = (typeof RFQ_SOURCE_MODES)[number];

export function isRfqSourceMode(value: unknown): value is RfqSourceMode {
  return (
    typeof value === 'string' &&
    (RFQ_SOURCE_MODES as readonly string[]).includes(value)
  );
}

export const RFQ_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'CANCELLED'] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

export function isRfqStatus(value: unknown): value is RfqStatus {
  return (
    typeof value === 'string' &&
    (RFQ_STATUSES as readonly string[]).includes(value)
  );
}

export const RFQ_ACTIONS = ['OPEN', 'CLOSE', 'CANCEL'] as const;
export type RfqAction = (typeof RFQ_ACTIONS)[number];

export const RFQ_CURRENCIES = [
  'IDR',
  'USD',
  'SGD',
  'MYR',
  'AUD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
] as const;
export type RfqCurrency = (typeof RFQ_CURRENCIES)[number];

export function isRfqCurrency(value: unknown): value is RfqCurrency {
  return (
    typeof value === 'string' &&
    (RFQ_CURRENCIES as readonly string[]).includes(value)
  );
}

export type RfqRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  sourceMode: RfqSourceMode;
  rfqNumber: string;
  title: string;
  description: string | null;
  currency: RfqCurrency;
  requiredDate: Date | null;
  responseDeadline: Date | null;
  sourceRequestNumber: string;
  sourceRequestTitle: string;
  sourceRequestStatus: string;
  status: RfqStatus;
  openedAt: Date | null;
  openedByUserId: string | null;
  closedAt: Date | null;
  closedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicRfq = Omit<
  RfqRecord,
  | 'idempotencyKey'
  | 'idempotencyFingerprint'
  | 'requiredDate'
  | 'responseDeadline'
  | 'openedAt'
  | 'closedAt'
  | 'cancelledAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  requiredDate: string | null;
  responseDeadline: string | null;
  openedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RfqLineSourceType = 'MATERIAL_REQUEST' | 'SERVICE_REQUEST';

export type RfqLineRecord = {
  id: string;
  rfqId: string;
  sourceMode: RfqSourceMode;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  lineNumber: number;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  sourceDescription: string;
  sourceItemId: string | null;
  sourceUomId: string | null;
  /**
   * CR-BE-SVC-01 PART 04 — governed SERVICE identity snapshot, derived from
   * the Service Request's `service_catalog_id`. NULL for MATERIAL lines and
   * for SERVICE lines sourced from an un-governed request. SERVICE-only by DB
   * CHECK; never introduces item/UOM/quantity.
   */
  sourceServiceId: string | null;
  quantitySnapshot: number | null;
  sourceRequiredDate: Date | null;
  sourceClaimStatus: 'ACTIVE' | 'RELEASED';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicRfqLine = Omit<
  RfqLineRecord,
  'sourceRequiredDate' | 'sourceClaimStatus' | 'createdAt' | 'updatedAt'
> & {
  sourceRequiredDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRfqInput = {
  purchaseRequestId: string;
  sourceMode: RfqSourceMode;
  rfqNumber: string;
  title: string;
  description?: string | null;
  currency: RfqCurrency;
  requiredDate?: string | null;
  responseDeadline?: string | null;
  idempotencyKey: string;
  /** Optional context assertions; authoritative values come from the PR. */
  clientId?: string;
  buildingId?: string;
};

export type NewRfq = {
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  sourceMode: RfqSourceMode;
  rfqNumber: string;
  title: string;
  description: string | null;
  currency: RfqCurrency;
  requiredDate: Date | null;
  responseDeadline: Date | null;
  sourceRequestNumber: string;
  sourceRequestTitle: string;
  sourceRequestStatus: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
};

export type UpdateRfqInput = {
  title?: string;
  description?: string | null;
  currency?: RfqCurrency;
  requiredDate?: string | null;
  responseDeadline?: string | null;
};

export type CreateRfqLineInput = {
  sourceLineType: RfqLineSourceType;
  sourceLineId: string;
};

export type NewRfqLine = {
  rfqId: string;
  sourceMode: RfqSourceMode;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  lineNumber: number;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  sourceDescription: string;
  sourceItemId: string | null;
  sourceUomId: string | null;
  sourceServiceId: string | null;
  quantitySnapshot: number | null;
  sourceRequiredDate: Date | null;
  sourceClaimStatus: 'ACTIVE' | 'RELEASED';
  createdByUserId: string;
};

export type RfqFilters = {
  sourceMode?: RfqSourceMode;
  status?: RfqStatus;
  buildingId?: string;
  purchaseRequestId?: string;
};

export type RfqAvailableActions = {
  rfqId: string;
  state: RfqStatus;
  availableActions: RfqAction[];
};
