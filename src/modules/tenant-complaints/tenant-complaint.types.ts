import type { FindingAction } from '../findings';
import type { IntakeChannel } from '../tenant-intake';
import type { WorkOrderPriority } from '../work-orders';

export const TENANT_COMPLAINT_STATUSES = [
  'OPEN',
  'CANCELLED',
  'ESCALATED',
] as const;
export type TenantComplaintStatus = (typeof TENANT_COMPLAINT_STATUSES)[number];
export function isTenantComplaintStatus(value: unknown): value is TenantComplaintStatus {
  return typeof value === 'string' &&
    (TENANT_COMPLAINT_STATUSES as readonly string[]).includes(value);
}

export const TENANT_COMPLAINT_INTAKE_ACTIONS = [
  'UPDATE',
  'CANCEL',
  'CREATE_FINDING',
] as const;
export type TenantComplaintIntakeAction =
  (typeof TENANT_COMPLAINT_INTAKE_ACTIONS)[number];
export type TenantComplaintAction =
  | TenantComplaintIntakeAction
  | FindingAction
  | 'CREATE_WORK_ORDER';

export type TenantComplaintRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string | null;
  intakeChannel: IntakeChannel | null;
  createdByUserId: string | null;
  reporterName: string | null;
  reporterPhone: string | null;
  reporterEmail: string | null;
  complaintNumber: string;
  complaintType: string;
  title: string;
  description: string | null;
  severity: WorkOrderPriority;
  status: TenantComplaintStatus;
  reportedAt: Date;
  findingId: string | null;
  workOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantComplaint = Omit<
  TenantComplaintRecord,
  'reportedAt' | 'createdAt' | 'updatedAt'
> & {
  reportedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantComplaintInput = {
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId?: string;
  intakeChannel?: IntakeChannel;
  reporterName?: string;
  reporterPhone?: string;
  reporterEmail?: string;
  complaintNumber: string;
  complaintType: string;
  title: string;
  description?: string;
  severity?: WorkOrderPriority;
};

export type NewTenantComplaint = {
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  spaceId: string | null;
  intakeChannel?: IntakeChannel | null;
  createdByUserId?: string | null;
  reporterName?: string | null;
  reporterPhone?: string | null;
  reporterEmail?: string | null;
  complaintNumber: string;
  complaintType: string;
  title: string;
  description: string | null;
  severity: WorkOrderPriority;
};

export type UpdateTenantComplaintInput = {
  complaintType?: string;
  title?: string;
  description?: string | null;
  severity?: WorkOrderPriority;
};

export type TenantComplaintFilters = {
  tenantCompanyId?: string;
  buildingId?: string;
  status?: TenantComplaintStatus;
  complaintType?: string;
};

export type TenantComplaintAvailableActions = {
  complaintId: string;
  state: TenantComplaintStatus;
  findingId: string | null;
  availableActions: TenantComplaintAction[];
};

export type CreateComplaintWorkOrderInput = { workOrderNumber: string };
