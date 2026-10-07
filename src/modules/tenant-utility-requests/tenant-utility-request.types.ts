import {
  WORK_REQUEST_STATUSES,
  type WorkRequestStatus,
} from '../work-requests';

export const TENANT_UTILITY_REQUEST_STATUSES = WORK_REQUEST_STATUSES;
export type TenantUtilityRequestStatus = WorkRequestStatus;
export const TENANT_UTILITY_REQUEST_ACTIONS = [
  'UPDATE',
  'CANCEL',
  'CREATE_WORK_REQUEST',
  'CREATE_WORK_ORDER',
] as const;
export type TenantUtilityRequestAction =
  (typeof TENANT_UTILITY_REQUEST_ACTIONS)[number];

export type TenantUtilityRequestRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string;
  utilityType: string;
  requestNumber: string;
  requestDetails: string;
  requestedAt: Date;
  status: TenantUtilityRequestStatus;
  notes: string | null;
  workRequestId: string | null;
  workOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantUtilityRequest = Omit<
  TenantUtilityRequestRecord,
  'requestedAt' | 'createdAt' | 'updatedAt'
> & {
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantUtilityRequestInput = {
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string;
  utilityType: string;
  requestNumber: string;
  requestDetails: string;
  notes?: string;
};

export type NewTenantUtilityRequest = Omit<
  CreateTenantUtilityRequestInput,
  'notes'
> & {
  clientId: string;
  notes: string | null;
};

export type UpdateTenantUtilityRequestInput = {
  utilityType?: string;
  requestDetails?: string;
  notes?: string | null;
};

export type TenantUtilityRequestFilters = {
  tenantCompanyId?: string;
  buildingId?: string;
  status?: TenantUtilityRequestStatus;
  utilityType?: string;
};

export type TenantUtilityRequestAvailableActions = {
  utilityRequestId: string;
  state: TenantUtilityRequestStatus;
  availableActions: TenantUtilityRequestAction[];
};

export type CreateUtilityRequestWorkOrderInput = { workOrderNumber: string };
