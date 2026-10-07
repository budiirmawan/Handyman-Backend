import type { PermitValidityStatus } from '../permit-validities/permit-validity.types';

export const PERMIT_EQUIPMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PermitEquipmentStatus = (typeof PERMIT_EQUIPMENT_STATUSES)[number];

export function isPermitEquipmentStatus(
  value: unknown,
): value is PermitEquipmentStatus {
  return typeof value === 'string' &&
    (PERMIT_EQUIPMENT_STATUSES as readonly string[]).includes(value);
}

export type PermitEquipmentRecord = {
  id: string;
  permitApplicationId: string;
  permitId: string;
  permitReference: string;
  clientId: string;
  buildingId: string;
  contractorContextType: string;
  contractorContextId: string;
  contractorVendorId: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  assetStatus: string;
  assetTypeId: string | null;
  assetTypeCode: string | null;
  assetTypeName: string | null;
  equipmentProfileId: string | null;
  equipmentCode: string | null;
  equipmentName: string;
  equipmentProfileStatus: string | null;
  equipmentType: string;
  assetIdentifierId: string | null;
  identifierType: string | null;
  identifierReference: string;
  identifierStatus: string | null;
  assetCertificationId: string | null;
  certificationType: string | null;
  certificationReference: string | null;
  certificationStatus: string | null;
  certificationIssueDate: Date | null;
  certificationExpiryDate: Date | null;
  inspectionBindingId: string | null;
  inspectionBindingStatus: string | null;
  inspectionExecutionId: string | null;
  inspectionStatus: string | null;
  status: PermitEquipmentStatus;
  validFrom: Date;
  validUntil: Date;
  permitValidityStatus: PermitValidityStatus | null;
  notes: string | null;
  createdByUserId: string;
  updatedByUserId: string;
  deactivatedAt: Date | null;
  deactivatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermitEquipment = Omit<
  PermitEquipmentRecord,
  | 'certificationIssueDate'
  | 'certificationExpiryDate'
  | 'validFrom'
  | 'validUntil'
  | 'deactivatedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  equipmentAssetReference: string;
  eligibleForActiveWork: boolean;
  certificationCurrentlyValid: boolean | null;
  inspectionCurrentlyValid: boolean | null;
  certificationIssueDate: string | null;
  certificationExpiryDate: string | null;
  validFrom: string;
  validUntil: string;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AddPermitEquipmentInput = {
  permitApplicationId: string;
  buildingId: string;
  contractorContextType: 'TENANT_CONTRACTOR' | 'VENDOR_CONTRACTOR';
  contractorContextId: string;
  assetId: string;
  equipmentProfileId?: string;
  assetIdentifierId?: string;
  assetCertificationId?: string;
  inspectionBindingId?: string;
  inspectionExecutionId?: string;
  validFrom?: Date;
  validUntil?: Date;
  notes?: string | null;
};

export type NewPermitEquipment = {
  permitApplicationId: string;
  assetId: string;
  equipmentProfileId: string | null;
  assetIdentifierId: string | null;
  assetCertificationId: string | null;
  inspectionBindingId: string | null;
  inspectionExecutionId: string | null;
  validFrom: Date;
  validUntil: Date;
  notes: string | null;
  actorUserId: string;
};

export type UpdatePermitEquipmentInput = {
  assetIdentifierId?: string | null;
  assetCertificationId?: string | null;
  inspectionBindingId?: string | null;
  inspectionExecutionId?: string | null;
  validFrom?: Date;
  validUntil?: Date;
  notes?: string | null;
};

export type PermitEquipmentFilters = {
  permitId?: string;
  permitApplicationId?: string;
  buildingId?: string;
  contractorContextType?: string;
  contractorContextId?: string;
  contractorVendorId?: string;
  assetId?: string;
  status?: PermitEquipmentStatus;
};

export type PermitActiveEquipmentList = {
  permitId: string;
  permitReference: string;
  buildingId: string;
  contractorContextType: string;
  contractorVendorId: string;
  validityStatus: PermitValidityStatus | null;
  active: boolean;
  equipmentCount: number;
  equipment: PublicPermitEquipment[];
};
