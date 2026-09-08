import type { PermitValidityStatus } from '../permit-validities/permit-validity.types';

export const PERMIT_WORK_STATUSES = ['READY', 'IN_PROGRESS', 'CLOSED', 'CANCELLED'] as const;
export type PermitWorkStatus = (typeof PERMIT_WORK_STATUSES)[number];
export const PERMIT_WORK_ACTIONS = ['START', 'CLOSE'] as const;
export type PermitWorkAction = (typeof PERMIT_WORK_ACTIONS)[number];

export type PermitWorkLifecycleRecord = {
  id: string;
  permitApplicationId: string;
  permitId: string;
  permitReference: string;
  clientId: string;
  buildingId: string;
  contractorContextType: string;
  contractorVendorId: string;
  status: PermitWorkStatus;
  startedAt: Date | null;
  startedByUserId: string | null;
  startNotes: string | null;
  closedAt: Date | null;
  closedByUserId: string | null;
  closeNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermitWorkLifecycle = Omit<
  PermitWorkLifecycleRecord,
  'startedAt' | 'closedAt' | 'createdAt' | 'updatedAt'
> & {
  startedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PermitWorkStatusView = {
  lifecycleId: string | null;
  permitId: string;
  permitApplicationId: string;
  permitReference: string;
  buildingId: string;
  contractorContextType: string;
  contractorVendorId: string;
  status: PermitWorkStatus;
  startedAt: string | null;
  startedByUserId: string | null;
  startNotes: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
  closeNotes: string | null;
  availableActions: PermitWorkAction[];
};

export type PermitWorkStartReadiness = {
  permitId: string;
  permitApplicationId: string;
  permitReference: string;
  buildingId: string;
  contractorContextType: string;
  contractorVendorId: string;
  workStatus: PermitWorkStatus;
  ready: boolean;
  approvalReady: boolean;
  validityStatus: PermitValidityStatus | null;
  safetyReady: boolean;
  safetyReadinessStatus: string;
  workerListReady: boolean;
  activeWorkerCount: number;
  configuredWorkerCount: number;
  equipmentRequired: boolean;
  equipmentReady: boolean;
  activeEquipmentCount: number;
  configuredEquipmentCount: number;
  evidenceConfigured: boolean;
  evidenceReady: boolean;
  blockers: string[];
  availableActions: PermitWorkAction[];
};

export type PermitWorkNotesInput = { notes?: string | null };

export type PermitWorkFilters = {
  buildingId?: string;
  contractorContextType?: string;
  contractorVendorId?: string;
  status?: 'IN_PROGRESS' | 'CLOSED';
};
