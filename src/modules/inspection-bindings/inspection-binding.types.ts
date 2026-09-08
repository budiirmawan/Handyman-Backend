/**
 * BE-10B — Equipment Inspection Binding domain types.
 *
 * The minimal binding that associates a BE-05 Asset / Equipment with a BE-07
 * Checklist Template under a Building context. Executions stay BE-07 checklist
 * executions — the binding only records the association plus an optional
 * BE-04 Functional Location refinement. No inspection engine, no duplicated
 * Asset / Checklist / Evidence / Verification data.
 */

export const INSPECTION_BINDING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type InspectionBindingStatus =
  (typeof INSPECTION_BINDING_STATUSES)[number];

export function isInspectionBindingStatus(
  value: unknown,
): value is InspectionBindingStatus {
  return (
    typeof value === 'string' &&
    (INSPECTION_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type InspectionBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  checklistTemplateId: string;
  functionalLocationId: string | null;
  status: InspectionBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicInspectionBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  checklistTemplateId: string;
  functionalLocationId: string | null;
  status: InspectionBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateInspectionBindingInput = {
  assetId: string;
  checklistTemplateId: string;
  functionalLocationId?: string | null;
  status?: InspectionBindingStatus;
  createdByUserId: string;
};

export type UpdateInspectionBindingInput = {
  functionalLocationId?: string | null;
  status?: InspectionBindingStatus;
};

/** The shared BE-07 execution, as started from an inspection binding. */
export type PublicInspectionExecution = {
  id: string;
  checklistTemplateId: string;
  inspectionBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Resolved context for a checklist execution that was started from an
 * inspection binding: the authoritative Asset / Building / Functional
 * Location the execution is tied to. Derived from the binding — never stored
 * a second time.
 */
export type PublicInspectionExecutionContext = {
  execution: PublicInspectionExecution;
  asset: {
    id: string;
    assetCode: string;
    assetName: string;
    status: string;
  };
  building: {
    id: string;
    code: string;
    name: string;
  };
  functionalLocation: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
};
