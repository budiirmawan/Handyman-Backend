/**
 * CR-BE-RN19-SAFETY-INSPECTION-01 — configuration-only Safety Inspection
 * binding. Checklist execution, evidence, findings, and task lifecycle remain
 * owned by the existing generic contracts.
 */

export const SAFETY_INSPECTION_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type SafetyInspectionBindingStatus =
  (typeof SAFETY_INSPECTION_BINDING_STATUSES)[number];

export function isSafetyInspectionBindingStatus(
  value: unknown,
): value is SafetyInspectionBindingStatus {
  return (
    typeof value === 'string' &&
    (SAFETY_INSPECTION_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

export type SafetyInspectionBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  scheduleDefinitionId: string;
  status: SafetyInspectionBindingStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSafetyInspectionBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  scheduleDefinitionId: string;
  status: SafetyInspectionBindingStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateSafetyInspectionBindingInput = {
  scheduleDefinitionId: string;
  status?: SafetyInspectionBindingStatus;
};

export type UpdateSafetyInspectionBindingInput = {
  status: SafetyInspectionBindingStatus;
};
