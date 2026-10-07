/**
 * BE-15A — Vendor Assignment domain types.
 *
 * Binds an existing BE-06A Vendor to an existing BE-08B Work Order within a
 * Building. The Vendor master and the Work Order are referenced — never
 * duplicated — so this module carries only the assignment record itself:
 * vendor reference, work/work-order reference, Building context, assignment
 * status, assigning user, assigned-at, and optional notes.
 *
 * The assignment lifecycle is ACTIVE → INACTIVE (deactivation, never delete);
 * reassign deactivates the current assignment and creates a fresh ACTIVE one.
 */
export const VENDOR_ASSIGNMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type VendorAssignmentStatus =
  (typeof VENDOR_ASSIGNMENT_STATUSES)[number];

export function isVendorAssignmentStatus(
  value: unknown,
): value is VendorAssignmentStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorAssignmentRecord = {
  id: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  status: VendorAssignmentStatus;
  notes: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorAssignment = {
  id: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  status: VendorAssignmentStatus;
  notes: string | null;
  assignedByUserId: string;
  assignedAt: string;
};

/** Input for assigning a Vendor to a Work Order. */
export type AssignVendorAssignmentInput = {
  vendorId: string;
  workOrderId: string;
  notes?: string;
  assignedByUserId: string;
};

/** Fully-resolved assignment data ready for persistence. */
export type NewVendorAssignment = {
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  notes: string | null;
  assignedByUserId: string;
};

/** List filters for GET /vendor-assignments. */
export type VendorAssignmentFilters = {
  vendorId?: string;
  workOrderId?: string;
  buildingId?: string;
};
