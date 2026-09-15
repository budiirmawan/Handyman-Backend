/**
 * BE-10E — Engineering Checklist Binding domain types.
 *
 * The minimal binding that associates a BE-07 Checklist Template with an
 * Engineering operational context: a Building plus an optional BE-05 Asset
 * and/or BE-04 Functional Location target inside that Building. Executions
 * stay BE-07 checklist executions — no Engineering checklist engine exists
 * here.
 */

export const ENGINEERING_CHECKLIST_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type EngineeringChecklistBindingStatus =
  (typeof ENGINEERING_CHECKLIST_BINDING_STATUSES)[number];

export function isEngineeringChecklistBindingStatus(
  value: unknown,
): value is EngineeringChecklistBindingStatus {
  return (
    typeof value === 'string' &&
    (ENGINEERING_CHECKLIST_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type EngineeringChecklistBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  checklistTemplateId: string;
  assetId: string | null;
  functionalLocationId: string | null;
  status: EngineeringChecklistBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicEngineeringChecklistBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  checklistTemplateId: string;
  assetId: string | null;
  functionalLocationId: string | null;
  status: EngineeringChecklistBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateEngineeringChecklistBindingInput = {
  buildingId: string;
  checklistTemplateId: string;
  assetId?: string | null;
  functionalLocationId?: string | null;
  status?: EngineeringChecklistBindingStatus;
  createdByUserId: string;
};

export type UpdateEngineeringChecklistBindingInput = {
  assetId?: string | null;
  functionalLocationId?: string | null;
  status?: EngineeringChecklistBindingStatus;
};

/** The shared BE-07 execution, as started from an engineering checklist binding. */
export type PublicEngineeringChecklistExecution = {
  id: string;
  checklistTemplateId: string;
  engineeringChecklistBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Resolved context for a checklist execution that was started from an
 * engineering checklist binding: the authoritative Building / Template plus
 * the bound Asset / Functional Location targets. Derived from the binding —
 * never stored a second time.
 */
export type PublicEngineeringChecklistExecutionContext = {
  execution: PublicEngineeringChecklistExecution;
  building: {
    id: string;
    code: string;
    name: string;
  };
  template: {
    id: string;
    code: string;
    name: string;
    status: string;
  };
  asset: {
    id: string;
    assetCode: string;
    assetName: string;
    status: string;
  } | null;
  functionalLocation: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
};
