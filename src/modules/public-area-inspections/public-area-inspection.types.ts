/**
 * BE-11F — Public Area Inspection domain types.
 *
 * Links a Public Cleaning Area / location to a BE-07 Checklist Template under
 * a Building context. Executions stay shared BE-07 checklist executions.
 */

export const PUBLIC_AREA_INSPECTION_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type PublicAreaInspectionStatus =
  (typeof PUBLIC_AREA_INSPECTION_STATUSES)[number];

export function isPublicAreaInspectionStatus(
  value: unknown,
): value is PublicAreaInspectionStatus {
  return (
    typeof value === 'string' &&
    (PUBLIC_AREA_INSPECTION_STATUSES as readonly string[]).includes(value)
  );
}

export type PublicAreaInspectionBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  checklistTemplateId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  functionalLocationId: string | null;
  description: string | null;
  status: PublicAreaInspectionStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPublicAreaInspectionBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  checklistTemplateId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  functionalLocationId: string | null;
  description: string | null;
  status: PublicAreaInspectionStatus;
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
  floor?: {
    id: string;
    code: string;
    name: string;
  } | null;
  area?: {
    id: string;
    code: string;
    name: string;
  } | null;
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

export type CreatePublicAreaInspectionBindingInput = {
  cleaningAreaId: string;
  checklistTemplateId: string;
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  functionalLocationId?: string | null;
  description?: string | null;
  status?: PublicAreaInspectionStatus;
  createdByUserId: string;
};

export type UpdatePublicAreaInspectionBindingInput = {
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  functionalLocationId?: string | null;
  description?: string | null;
  status?: PublicAreaInspectionStatus;
};

export type PublicAreaInspectionBindingFilter = {
  buildingId?: string;
  cleaningAreaId?: string;
  status?: PublicAreaInspectionStatus;
};

export type PublicPublicAreaInspectionExecution = {
  id: string;
  checklistTemplateId: string;
  publicAreaInspectionBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicPublicAreaInspectionExecutionContext = {
  execution: PublicPublicAreaInspectionExecution;
  publicAreaInspectionBinding: PublicPublicAreaInspectionBinding;
};
