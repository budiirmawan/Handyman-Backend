/**
 * BE-11E — Toilet Inspection domain types.
 *
 * Links a Toilet Cleaning Area / location to a BE-07 Checklist Template under
 * a Building context. Executions stay shared BE-07 checklist executions.
 */

export const TOILET_INSPECTION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ToiletInspectionStatus =
  (typeof TOILET_INSPECTION_STATUSES)[number];

export function isToiletInspectionStatus(
  value: unknown,
): value is ToiletInspectionStatus {
  return (
    typeof value === 'string' &&
    (TOILET_INSPECTION_STATUSES as readonly string[]).includes(value)
  );
}

export type ToiletInspectionBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  checklistTemplateId: string;
  roomId: string | null;
  functionalLocationId: string | null;
  description: string | null;
  status: ToiletInspectionStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicToiletInspectionBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  checklistTemplateId: string;
  roomId: string | null;
  functionalLocationId: string | null;
  description: string | null;
  status: ToiletInspectionStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
    cleaningAreaType: string;
    status: string;
  };
  checklistTemplate?: {
    id: string;
    code: string;
    name: string;
    status: string;
  };
  room?: {
    id: string;
    code: string;
    name: string;
  } | null;
  functionalLocation?: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
};

export type CreateToiletInspectionBindingInput = {
  cleaningAreaId: string;
  checklistTemplateId: string;
  roomId?: string | null;
  functionalLocationId?: string | null;
  description?: string | null;
  status?: ToiletInspectionStatus;
  createdByUserId: string;
};

export type UpdateToiletInspectionBindingInput = {
  roomId?: string | null;
  functionalLocationId?: string | null;
  description?: string | null;
  status?: ToiletInspectionStatus;
};

export type ToiletInspectionBindingFilter = {
  buildingId?: string;
  cleaningAreaId?: string;
  status?: ToiletInspectionStatus;
};

export type PublicToiletInspectionExecution = {
  id: string;
  checklistTemplateId: string;
  toiletInspectionBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicToiletInspectionExecutionContext = {
  execution: PublicToiletInspectionExecution;
  toiletInspectionBinding: PublicToiletInspectionBinding;
};
