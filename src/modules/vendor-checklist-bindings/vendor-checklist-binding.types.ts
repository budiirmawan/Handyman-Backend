/**
 * BE-15C — Vendor Checklist Binding domain types.
 *
 * The minimal binding that associates a BE-07 Checklist Template with a
 * Vendor operational context: a BE-15B Vendor Work (which references the
 * BE-06 Vendor master and the BE-08 Work Order). Executions stay BE-07's
 * `checklist_executions` rows — no Vendor checklist engine exists here.
 */
export const VENDOR_CHECKLIST_BINDING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type VendorChecklistBindingStatus =
  (typeof VENDOR_CHECKLIST_BINDING_STATUSES)[number];

export function isVendorChecklistBindingStatus(
  value: unknown,
): value is VendorChecklistBindingStatus {
  return (
    typeof value === 'string' &&
    (VENDOR_CHECKLIST_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorChecklistBindingRecord = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  checklistTemplateId: string;
  checklistExecutionId: string | null;
  buildingId: string;
  workOrderId: string;
  status: VendorChecklistBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorChecklistBinding = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  checklistTemplateId: string;
  checklistExecutionId: string | null;
  buildingId: string;
  workOrderId: string;
  status: VendorChecklistBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Input for creating a Vendor Checklist binding. */
export type CreateVendorChecklistBindingInput = {
  vendorWorkId: string;
  checklistTemplateId: string;
  createdByUserId: string;
};

/** Fully-resolved binding data ready for persistence. */
export type NewVendorChecklistBinding = {
  clientId: string;
  vendorWorkId: string;
  checklistTemplateId: string;
  buildingId: string;
  workOrderId: string;
  createdByUserId: string;
};

/** List filters for GET /vendor-checklist-bindings. */
export type VendorChecklistBindingFilters = {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
};

/** The shared BE-07 execution, as started from a vendor checklist binding. */
export type PublicVendorChecklistExecution = {
  id: string;
  checklistTemplateId: string;
  vendorChecklistBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Resolved context for a checklist execution that was started from a vendor
 * checklist binding: the authoritative Vendor Work / Building / Work Order /
 * Template. Derived from the binding — never stored a second time.
 */
export type PublicVendorChecklistExecutionContext = {
  execution: PublicVendorChecklistExecution;
  vendorWork: {
    id: string;
    vendorId: string;
    status: string;
  };
  building: {
    id: string;
    code: string;
    name: string;
  };
  workOrder: {
    id: string;
    workOrderNumber: string;
    status: string;
  };
  template: {
    id: string;
    code: string;
    name: string;
    status: string;
  };
};
