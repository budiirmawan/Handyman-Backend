export const SERVICE_CHARGE_READINESS_STATUSES = [
  'READY', 'NOT_READY', 'INCOMPLETE',
] as const;
export type ServiceChargeReadinessStatus =
  (typeof SERVICE_CHARGE_READINESS_STATUSES)[number];
export const isServiceChargeReadinessStatus = (
  value: unknown,
): value is ServiceChargeReadinessStatus =>
  typeof value === 'string' &&
  (SERVICE_CHARGE_READINESS_STATUSES as readonly string[]).includes(value);

export type ServiceChargeReadinessRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  serviceChargeType: string;
  chargeBasis: string | null;
  tenantChargeId: string | null;
  effectiveFrom: string;
  effectiveTo: string;
  readinessStatus: ServiceChargeReadinessStatus;
  notes: string | null;
  evaluatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};
export type PublicServiceChargeReadiness = Omit<
  ServiceChargeReadinessRecord, 'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type CreateServiceChargeReadinessInput = {
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string;
  serviceChargeType: string;
  chargeBasis?: string | null;
  tenantChargeId?: string | null;
  effectiveFrom: string;
  effectiveTo: string;
  readinessStatus?: ServiceChargeReadinessStatus;
  notes?: string;
};
export type NewServiceChargeReadiness = Omit<
  CreateServiceChargeReadinessInput,
  'chargeBasis' | 'tenantChargeId' | 'readinessStatus' | 'notes'
> & {
  clientId: string;
  chargeBasis: string | null;
  tenantChargeId: string | null;
  readinessStatus: ServiceChargeReadinessStatus;
  notes: string | null;
  evaluatedByUserId: string;
};
export type UpdateServiceChargeReadinessInput = {
  serviceChargeType?: string;
  chargeBasis?: string | null;
  tenantChargeId?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string;
  readinessStatus?: ServiceChargeReadinessStatus;
  notes?: string | null;
};
export type ServiceChargeReadinessFilters = {
  tenantCompanyId?: string;
  buildingId?: string;
  status?: ServiceChargeReadinessStatus;
  periodFrom?: string;
  periodTo?: string;
};
