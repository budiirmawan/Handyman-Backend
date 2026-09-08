/**
 * BE-11J — Consumable Readiness domain types.
 *
 * Operational readiness check for Housekeeping cleaning consumables.
 */

export const CONSUMABLE_REQUIREMENT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type ConsumableRequirementStatus =
  (typeof CONSUMABLE_REQUIREMENT_STATUSES)[number];

export const READINESS_STATUSES = [
  'READY',
  'LOW',
  'NOT_READY',
  'UNKNOWN',
] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export function isConsumableRequirementStatus(
  value: unknown,
): value is ConsumableRequirementStatus {
  return (
    typeof value === 'string' &&
    (CONSUMABLE_REQUIREMENT_STATUSES as readonly string[]).includes(value)
  );
}

export function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return (
    typeof value === 'string' &&
    (READINESS_STATUSES as readonly string[]).includes(value)
  );
}

export type ConsumableRequirementRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  code: string;
  name: string;
  requiredQuantity: number;
  unit: string;
  status: ConsumableRequirementStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type ConsumableReadinessRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  requirementId: string;
  operationalDate: string;
  readinessStatus: ReadinessStatus;
  availableQuantity: number | null;
  checkedByUserId: string;
  checkedAt: Date;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicConsumableRequirement = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  code: string;
  name: string;
  requiredQuantity: number;
  unit: string;
  status: ConsumableRequirementStatus;
  createdAt: string;
  updatedAt: string;
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
  currentReadiness?: {
    readinessStatus: ReadinessStatus;
    availableQuantity: number | null;
    checkedAt: string;
  } | null;
};

export type PublicConsumableReadiness = {
  id: string;
  clientId: string;
  buildingId: string;
  requirementId: string;
  operationalDate: string;
  readinessStatus: ReadinessStatus;
  availableQuantity: number | null;
  checkedByUserId: string;
  checkedAt: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  requirement?: {
    id: string;
    code: string;
    name: string;
    requiredQuantity: number;
    unit: string;
  };
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
  } | null;
};

export type CreateConsumableRequirementInput = {
  buildingId: string;
  cleaningAreaId?: string | null;
  code: string;
  name: string;
  requiredQuantity?: number;
  unit: string;
  status?: ConsumableRequirementStatus;
};

export type UpdateConsumableRequirementInput = {
  name?: string;
  cleaningAreaId?: string | null;
  requiredQuantity?: number;
  unit?: string;
  status?: ConsumableRequirementStatus;
};

export type RecordConsumableReadinessInput = {
  requirementId: string;
  operationalDate?: string;
  readinessStatus: ReadinessStatus;
  availableQuantity?: number | null;
  notes?: string | null;
  checkedByUserId: string;
};

export type ConsumableRequirementFilter = {
  buildingId?: string;
  cleaningAreaId?: string;
  status?: ConsumableRequirementStatus;
};

export type ConsumableReadinessFilter = {
  buildingId?: string;
  cleaningAreaId?: string;
  readinessStatus?: ReadinessStatus;
  date?: string;
};
