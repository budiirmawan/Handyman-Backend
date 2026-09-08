/**
 * BE-10F — Breakdown / Corrective Binding domain types.
 *
 * The minimal binding that associates a BE-05 Asset / Equipment with a
 * breakdown/corrective event and an optional corrective BE-08 Work Order.
 * The Work Order lifecycle, assignments, verification, and any Finding
 * workflow remain owned by BE-08 / BE-09 — this module only records the
 * breakdown event and links it.
 */

export const BREAKDOWN_BINDING_STATUSES = ['OPEN', 'CLOSED'] as const;

export type BreakdownBindingStatus = (typeof BREAKDOWN_BINDING_STATUSES)[number];

export function isBreakdownBindingStatus(
  value: unknown,
): value is BreakdownBindingStatus {
  return (
    typeof value === 'string' &&
    (BREAKDOWN_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type BreakdownBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  functionalLocationId: string | null;
  workOrderId: string | null;
  category: string;
  description: string;
  reportedByUserId: string;
  reportedAt: Date;
  status: BreakdownBindingStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** The corrective Work Order status projected from BE-08 (never stored). */
export type BreakdownCorrectiveState = {
  workOrderId: string;
  workOrderNumber: string;
  title: string;
  /** Current BE-08 authoritative status of the corrective Work Order. */
  status: string;
} | null;

/** Safe public representation exposed through the API. */
export type PublicBreakdownBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  functionalLocationId: string | null;
  category: string;
  description: string;
  reportedByUserId: string;
  reportedAt: string;
  status: BreakdownBindingStatus;
  createdAt: string;
  updatedAt: string;
  /** Current corrective status derived from the linked BE-08 Work Order. */
  corrective: BreakdownCorrectiveState;
};

export type CreateBreakdownInput = {
  assetId: string;
  category: string;
  description: string;
  functionalLocationId?: string | null;
  reportedAt?: string;
  reportedByUserId: string;
};

export type LinkCorrectiveWorkOrderInput = {
  /** Link an existing Work Order instead of creating a new one. */
  workOrderId?: string;
  /** Title for a newly created corrective Work Order. */
  title?: string;
};
