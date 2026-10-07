/**
 * BE-15B — Vendor Work domain types.
 *
 * The operational execution of a BE-15A Vendor Assignment against a BE-08
 * Work Order. No separate work engine is created: the record references the
 * assignment (which references the Vendor master and the Work Order) and
 * carries only the vendor-work lifecycle — work status, started/completed
 * timestamps, and notes.
 *
 * The lifecycle is explicit and backend-authoritative:
 *
 *   NOT_STARTED → IN_PROGRESS → ON_HOLD → COMPLETED
 *                     ↑_____________|
 *
 * `started_at` is set the first time work leaves NOT_STARTED; `completed_at`
 * is set exactly when work reaches COMPLETED (which is terminal for BE-15B —
 * rework belongs to BE-15J).
 */
export const VENDOR_WORK_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
] as const;

export type VendorWorkStatus = (typeof VENDOR_WORK_STATUSES)[number];

export function isVendorWorkStatus(value: unknown): value is VendorWorkStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_WORK_STATUSES as readonly string[]).includes(value)
  );
}

export const VENDOR_WORK_TRANSITIONS: Record<
  VendorWorkStatus,
  readonly VendorWorkStatus[]
> = {
  NOT_STARTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS'],
  COMPLETED: [],
};

export function canTransitionVendorWorkStatus(
  from: VendorWorkStatus,
  to: VendorWorkStatus,
): boolean {
  return (VENDOR_WORK_TRANSITIONS[from] as readonly VendorWorkStatus[]).includes(
    to,
  );
}

/** Full database record. */
export type VendorWorkRecord = {
  id: string;
  vendorAssignmentId: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  status: VendorWorkStatus;
  notes: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorWork = {
  id: string;
  vendorAssignmentId: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  status: VendorWorkStatus;
  notes: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

/** Input for resolving (creating or fetching) a Vendor Work context. */
export type ResolveVendorWorkInput = {
  notes?: string;
};

/** Fully-resolved work data ready for persistence. */
export type NewVendorWork = {
  vendorAssignmentId: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  notes: string | null;
};

/** Status transition input (PATCH /vendor-works/:id/status). */
export type UpdateVendorWorkStatusInput = {
  status: VendorWorkStatus;
  notes?: string;
};

/** List filters for GET /vendor-works. */
export type VendorWorkFilters = {
  vendorId?: string;
  buildingId?: string;
  status?: VendorWorkStatus;
};
