import type { WorkOrderPriority } from '../work-orders';

export const TENANT_SERVICE_REQUEST_STATUSES = [
  'OPEN',
  'CANCELLED',
  'CONVERTED',
] as const;
export type TenantServiceRequestStatus =
  (typeof TENANT_SERVICE_REQUEST_STATUSES)[number];

export function isTenantServiceRequestStatus(
  value: unknown,
): value is TenantServiceRequestStatus {
  return typeof value === 'string' &&
    (TENANT_SERVICE_REQUEST_STATUSES as readonly string[]).includes(value);
}

export const TENANT_SERVICE_REQUEST_ACTIONS = [
  'UPDATE',
  'CANCEL',
  'CREATE_WORK_REQUEST',
  'CREATE_WORK_ORDER',
] as const;
export type TenantServiceRequestAction =
  (typeof TENANT_SERVICE_REQUEST_ACTIONS)[number];

export type TenantServiceRequestRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string | null;
  requestNumber: string;
  requestType: string;
  title: string;
  description: string | null;
  priority: WorkOrderPriority;
  status: TenantServiceRequestStatus;
  requestedAt: Date;
  workRequestId: string | null;
  workOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantServiceRequest = Omit<
  TenantServiceRequestRecord,
  'requestedAt' | 'createdAt' | 'updatedAt'
> & {
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantServiceRequestInput = {
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId?: string;
  requestNumber: string;
  requestType: string;
  title: string;
  description?: string;
  priority?: WorkOrderPriority;
};

export type NewTenantServiceRequest = {
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string | null;
  requestNumber: string;
  requestType: string;
  title: string;
  description: string | null;
  priority: WorkOrderPriority;
};

export type UpdateTenantServiceRequestInput = {
  requestType?: string;
  title?: string;
  description?: string | null;
  priority?: WorkOrderPriority;
};

export type TenantServiceRequestFilters = {
  status?: TenantServiceRequestStatus;
  requestType?: string;
  tenantCompanyId?: string;
  buildingId?: string;
};

export type TenantServiceRequestAvailableActions = {
  serviceRequestId: string;
  state: TenantServiceRequestStatus;
  availableActions: TenantServiceRequestAction[];
};

export type CreateServiceRequestWorkOrderInput = {
  workOrderNumber: string;
};
