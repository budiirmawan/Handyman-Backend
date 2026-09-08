import type { PermitValidityStatus } from '../permit-validities/permit-validity.types';

export const PERMIT_WORKER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PermitWorkerStatus = (typeof PERMIT_WORKER_STATUSES)[number];

export function isPermitWorkerStatus(value: unknown): value is PermitWorkerStatus {
  return typeof value === 'string' &&
    (PERMIT_WORKER_STATUSES as readonly string[]).includes(value);
}

export type PermitWorkerRecord = {
  id: string;
  permitApplicationId: string;
  permitId: string;
  permitReference: string;
  clientId: string;
  buildingId: string;
  contractorContextType: string;
  contractorContextId: string;
  contractorVendorId: string;
  vendorWorkforceBindingId: string;
  workforceProfileId: string;
  workerName: string;
  employeeCode: string;
  vendorPersonnelCode: string;
  workforceType: string;
  workforceStatus: string;
  vendorWorkforceStatus: string;
  vendorWorkforceEffectiveFrom: Date | null;
  vendorWorkforceEffectiveUntil: Date | null;
  roleTrade: string;
  status: PermitWorkerStatus;
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

export type PublicPermitWorker = Omit<
  PermitWorkerRecord,
  | 'vendorWorkforceEffectiveFrom'
  | 'vendorWorkforceEffectiveUntil'
  | 'validFrom'
  | 'validUntil'
  | 'deactivatedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  workerPersonReference: string;
  identificationReference: string;
  eligibleForActiveWork: boolean;
  vendorWorkforceEffectiveFrom: string | null;
  vendorWorkforceEffectiveUntil: string | null;
  validFrom: string;
  validUntil: string;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AddPermitWorkerInput = {
  permitApplicationId: string;
  buildingId: string;
  workforceProfileId: string;
  vendorWorkforceBindingId?: string;
  roleTrade: string;
  validFrom?: Date;
  validUntil?: Date;
  notes?: string | null;
};

export type NewPermitWorker = {
  permitApplicationId: string;
  vendorWorkforceBindingId: string;
  roleTrade: string;
  validFrom: Date;
  validUntil: Date;
  notes: string | null;
  actorUserId: string;
};

export type UpdatePermitWorkerInput = {
  roleTrade?: string;
  validFrom?: Date;
  validUntil?: Date;
  notes?: string | null;
};

export type PermitWorkerFilters = {
  permitId?: string;
  permitApplicationId?: string;
  buildingId?: string;
  contractorContextType?: string;
  contractorContextId?: string;
  contractorVendorId?: string;
  workforceProfileId?: string;
  status?: PermitWorkerStatus;
};

export type PermitActiveWorkerList = {
  permitId: string;
  permitReference: string;
  buildingId: string;
  contractorContextType: string;
  contractorVendorId: string;
  validityStatus: PermitValidityStatus | null;
  active: boolean;
  workerCount: number;
  workers: PublicPermitWorker[];
};
