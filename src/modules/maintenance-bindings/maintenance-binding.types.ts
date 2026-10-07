/**
 * BE-10G — Maintenance Operational Binding domain types.
 *
 * The minimal binding that associates a BE-05 Asset / Equipment with a
 * maintenance context and references a shared BE-07 Schedule / generated
 * Task and an optional BE-08 Work Order. Scheduler, Task, Work Order,
 * Checklist, Evidence, Assignment, Finding, and Verification remain owned by
 * BE-07 / BE-08 / BE-09 — no Engineering maintenance engine exists here.
 */

export const MAINTENANCE_BINDING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type MaintenanceBindingStatus =
  (typeof MAINTENANCE_BINDING_STATUSES)[number];

export function isMaintenanceBindingStatus(
  value: unknown,
): value is MaintenanceBindingStatus {
  return (
    typeof value === 'string' &&
    (MAINTENANCE_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

export const MAINTENANCE_TYPES = [
  'PREVENTIVE',
  'PREDICTIVE',
  'CONDITION_BASED',
  'CALIBRATION',
] as const;

export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export function isMaintenanceType(value: unknown): value is MaintenanceType {
  return (
    typeof value === 'string' &&
    (MAINTENANCE_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type MaintenanceBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  functionalLocationId: string | null;
  scheduleDefinitionId: string | null;
  workOrderId: string | null;
  name: string;
  maintenanceType: MaintenanceType;
  description: string | null;
  status: MaintenanceBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** The linked BE-07 Schedule projected from its authoritative record. */
export type MaintenanceScheduleState = {
  id: string;
  code: string;
  name: string;
  targetType: string;
  targetId: string;
  timezone: string;
  status: string;
} | null;

/** The linked BE-08 Work Order status projected (never stored). */
export type MaintenanceWorkOrderState = {
  id: string;
  workOrderNumber: string;
  title: string;
  status: string;
} | null;

/** Linked BE-07 generated tasks, newest first. */
export type MaintenanceTaskState = {
  id: string;
  occurrenceAt: string;
  status: string;
};

/** Safe public representation exposed through the API. */
export type PublicMaintenanceBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  functionalLocationId: string | null;
  name: string;
  maintenanceType: MaintenanceType;
  description: string | null;
  status: MaintenanceBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  /** Current operational context derived from the linked shared records. */
  schedule: MaintenanceScheduleState;
  workOrder: MaintenanceWorkOrderState;
  tasks: MaintenanceTaskState[];
};

export type CreateMaintenanceBindingInput = {
  assetId: string;
  name: string;
  maintenanceType: MaintenanceType;
  description?: string;
  functionalLocationId?: string | null;
  status?: MaintenanceBindingStatus;
  createdByUserId: string;
};

export type UpdateMaintenanceBindingInput = {
  name?: string;
  maintenanceType?: MaintenanceType;
  description?: string | null;
  functionalLocationId?: string | null;
  status?: MaintenanceBindingStatus;
};

/** Link an existing BE-07 schedule or create one through the shared engine. */
export type LinkMaintenanceScheduleInput = {
  /** Link an existing schedule definition instead of creating one. */
  scheduleDefinitionId?: string;
  /** Create a new shared schedule: */
  targetType?: string;
  targetId?: string;
  code?: string;
  name?: string;
  startAt?: string;
  timezone?: string;
};

export type LinkMaintenanceTaskInput = {
  taskId: string;
};

export type LinkMaintenanceWorkOrderInput = {
  workOrderId?: string;
  title?: string;
};
