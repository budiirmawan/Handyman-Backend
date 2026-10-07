import type { OperationalBudgetCurrency } from './operational-finance.types';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Operational Commitment ledger model.
 *
 * Amounts are exchanged as strings at the repository boundary so all ledger
 * arithmetic happens in SQL `NUMERIC` (never in JavaScript floating point).
 * Only the public projection converts to `number` for JSON.
 */

export const OPERATIONAL_COMMITMENT_STATUSES = [
  'COMMITTED',
  'PARTIALLY_ACTUALIZED',
  'ACTUALIZED',
  'RELEASED',
  'CANCELLED',
] as const;

export type OperationalCommitmentStatus =
  (typeof OPERATIONAL_COMMITMENT_STATUSES)[number];

/** Statuses that still consume budget and may still transition. */
export const OPEN_OPERATIONAL_COMMITMENT_STATUSES: readonly OperationalCommitmentStatus[] =
  ['COMMITTED', 'PARTIALLY_ACTUALIZED'];

/**
 * `MANUAL` is the only origin reachable from the PART 02 service layer. The
 * Purchase Order origins exist so PART 03/04 cannot introduce a second
 * commitment authority.
 */
export const OPERATIONAL_COMMITMENT_ORIGINS = [
  'MANUAL',
  'PO_LINE',
  'PO_HEADER',
] as const;

export type OperationalCommitmentOrigin =
  (typeof OPERATIONAL_COMMITMENT_ORIGINS)[number];

export const OPERATIONAL_COMMITMENT_ENTRY_TYPES = [
  'CREATE',
  'ADJUST_INCREASE',
  'ADJUST_DECREASE',
  'ACTUALIZE',
  'ACTUALIZE_REVERSAL',
  'RELEASE',
  'CANCEL',
  'OVERRIDE',
] as const;

export type OperationalCommitmentEntryType =
  (typeof OPERATIONAL_COMMITMENT_ENTRY_TYPES)[number];

export function isOperationalCommitmentStatus(
  value: unknown,
): value is OperationalCommitmentStatus {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_COMMITMENT_STATUSES as readonly string[]).includes(value)
  );
}

export type OperationalCommitmentRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  budgetId: string;
  budgetCategoryId: string;
  origin: OperationalCommitmentOrigin;
  sourceType: 'PURCHASE_ORDER' | 'PO_LINE' | null;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  workOrderId: string | null;
  vendorId: string | null;
  materialRequestId: string | null;
  currency: OperationalBudgetCurrency;
  committedAmount: string;
  actualizedAmount: string;
  releasedAmount: string;
  openAmount: string;
  status: OperationalCommitmentStatus;
  title: string;
  reason: string | null;
  overspendOverrideReason: string | null;
  overspendOverrideByUserId: string | null;
  overspendOverrideAt: Date | null;
  idempotencyKey: string;
  createdByUserId: string;
  closedAt: Date | null;
  closedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicOperationalCommitment = {
  id: string;
  clientId: string;
  buildingId: string;
  budgetId: string;
  budgetCategoryId: string;
  origin: OperationalCommitmentOrigin;
  sourceType: 'PURCHASE_ORDER' | 'PO_LINE' | null;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  workOrderId: string | null;
  vendorId: string | null;
  materialRequestId: string | null;
  currency: OperationalBudgetCurrency;
  committedAmount: number;
  actualizedAmount: number;
  releasedAmount: number;
  openAmount: number;
  status: OperationalCommitmentStatus;
  title: string;
  reason: string | null;
  overspendOverride: {
    reason: string;
    byUserId: string;
    at: string;
  } | null;
  idempotencyKey: string;
  createdByUserId: string;
  closedAt: string | null;
  closedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OperationalCommitmentEntryRecord = {
  id: string;
  commitmentId: string;
  entryType: OperationalCommitmentEntryType;
  signedAmount: string;
  currency: OperationalBudgetCurrency;
  sourceBindingId: string | null;
  idempotencyKey: string;
  reason: string | null;
  actorUserId: string;
  requestId: string | null;
  occurredAt: Date;
  createdAt: Date;
};

export type PublicOperationalCommitmentEntry = Omit<
  OperationalCommitmentEntryRecord,
  'signedAmount' | 'occurredAt' | 'createdAt'
> & {
  signedAmount: number;
  occurredAt: string;
  createdAt: string;
};

export type PublicOperationalCommitmentDetail = PublicOperationalCommitment & {
  entries: PublicOperationalCommitmentEntry[];
};

/**
 * Manual/estimated commitment input. There is deliberately no source-derived
 * creation input in PART 02: a priced authority (PO line) is wired by later
 * PARTs through the same repository primitive.
 */
export type CreateOperationalCommitmentInput = {
  budgetCategoryId: string;
  title: string;
  amount: number;
  currency: OperationalBudgetCurrency;
  reason: string;
  idempotencyKey: string;
  workOrderId?: string | null;
  vendorId?: string | null;
  materialRequestId?: string | null;
  overspendOverrideReason?: string | null;
};

/**
 * CR-BE-COMM-VAR-01 PART 03 — PO-line commitment input.
 *
 * Amount, currency, scope, vendor and Material Request lineage are DERIVED
 * from the authoritative ISSUED Purchase Order line. The caller supplies only
 * the explicit cost category and an idempotency key.
 */
export type CreatePoLineCommitmentInput = {
  purchaseOrderLineId: string;
  budgetCategoryId: string;
  idempotencyKey: string;
  overspendOverrideReason?: string | null;
};

export type AdjustOperationalCommitmentInput = {
  amount: number;
  reason: string;
  idempotencyKey: string;
  overspendOverrideReason?: string | null;
};

export type CloseOperationalCommitmentInput = {
  reason: string;
  idempotencyKey: string;
};

export type OperationalCommitmentFilters = {
  budgetCategoryId?: string;
  status?: OperationalCommitmentStatus;
  origin?: OperationalCommitmentOrigin;
  workOrderId?: string;
  vendorId?: string;
};

/**
 * PART 02 internal actualization primitive. It is intentionally NOT reachable
 * over HTTP: actual cost is recognised by an authoritative source transaction
 * in PART 03/04, never by an arbitrary financial mutation endpoint.
 */
export type ActualizeOperationalCommitmentInput = {
  amount: number;
  sourceBindingId?: string | null;
  reason?: string | null;
  idempotencyKey: string;
  actorUserId: string;
};

/** Locked, in-transaction view of a budget's consumption. */
export type OperationalBudgetConsumption = {
  budgetPlannedAmount: string;
  budgetConsumedAmount: string;
  budgetAvailableAmount: string;
  categoryPlannedAmount: string;
  categoryConsumedAmount: string;
  categoryAvailableAmount: string;
};
