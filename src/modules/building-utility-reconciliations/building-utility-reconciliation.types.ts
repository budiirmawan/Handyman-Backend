export const BUILDING_RECONCILIATION_TYPES = ['ELECTRICITY', 'WATER'] as const;
export type BuildingReconciliationUtilityType = (typeof BUILDING_RECONCILIATION_TYPES)[number];
export const isBuildingReconciliationUtilityType = (value: unknown): value is BuildingReconciliationUtilityType =>
  typeof value === 'string' && (BUILDING_RECONCILIATION_TYPES as readonly string[]).includes(value);
export type BuildingPerformanceMetric = 'IKE' | 'IKA';

export type BuildingUtilityReconciliationRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  utilityType: BuildingReconciliationUtilityType;
  periodStart: Date;
  periodEnd: Date;
  uomId: string;
  sourceConsumptionIds: string[];
  tenantConsumptionIds: string[];
  commonAreaConsumptionIds: string[];
  sourceConsumption: string;
  tenantConsumption: string;
  commonAreaConsumption: string;
  unallocatedConsumption: string;
  reconciliationPercentage: string | null;
  applicableAreaSqm: string;
  performanceMetric: BuildingPerformanceMetric;
  performanceValue: string;
  calculatedAt: Date;
  calculatedByUserId: string;
  createdAt: Date;
};

export type PublicBuildingUtilityReconciliation = Omit<
  BuildingUtilityReconciliationRecord,
  'periodStart' | 'periodEnd' | 'sourceConsumption' | 'tenantConsumption' |
  'commonAreaConsumption' | 'unallocatedConsumption' |
  'reconciliationPercentage' | 'applicableAreaSqm' | 'performanceValue' |
  'calculatedAt' | 'createdAt'
> & {
  periodStart: string;
  periodEnd: string;
  sourceConsumption: number;
  tenantConsumption: number;
  commonAreaConsumption: number;
  unallocatedConsumption: number;
  reconciliationPercentage: number | null;
  applicableAreaSqm: number;
  performanceValue: number;
  /** Presentation UOM for the persisted performance value. */
  performanceUom: 'kWh/m²' | 'm³/m²';
  calculatedAt: string;
  createdAt: string;
};

export type CreateBuildingUtilityReconciliationInput = {
  buildingId: string;
  utilityType: BuildingReconciliationUtilityType;
  periodStart: Date;
  periodEnd: Date;
};

export type ConsumptionAggregation = {
  clientId: string;
  uomIds: string[];
  sourceConsumptionIds: string[];
  tenantConsumptionIds: string[];
  commonAreaConsumptionIds: string[];
  sourceConsumption: string;
  tenantConsumption: string;
  commonAreaConsumption: string;
};

export type NewBuildingUtilityReconciliation = ConsumptionAggregation & {
  buildingId: string;
  utilityType: BuildingReconciliationUtilityType;
  periodStart: Date;
  periodEnd: Date;
  uomId: string;
  applicableAreaSqm: string;
  performanceMetric: BuildingPerformanceMetric;
  calculatedByUserId: string;
};
