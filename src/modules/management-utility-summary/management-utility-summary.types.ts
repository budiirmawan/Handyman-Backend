import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';
import type {
  PublicUtilityAbnormalKpi,
  PublicUtilityConsumptionKpi,
  PublicUtilityTrendPoint,
  PublicUtilityVerificationKpi,
  UtilityKpiInterval,
} from '../utility-kpi';
import type { UtilityType } from '../utility-meters';

export type ManagementUtilitySummaryQuery = {
  scope: ManagementReadScopeFilters;
  interval: UtilityKpiInterval;
  includeSubMeters: boolean;
};

export type ManagementUtilitySummaryFilters = {
  interval: UtilityKpiInterval;
  includeSubMeters: boolean;
};

export type ManagementTenantUtilityRow = {
  buildingId: string;
  tenantCompanyId: string;
  tenantName: string | null;
  utilityType: UtilityType;
  totalConsumption: number;
  consumptionCount: number;
  meterCount: number;
  uomId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

export type ManagementUtilitySummaryData = {
  electricity: PublicUtilityConsumptionKpi;
  water: PublicUtilityConsumptionKpi;
  gas: PublicUtilityConsumptionKpi;
  abnormalConsumption: PublicUtilityAbnormalKpi;
  /** BE-23I verification of abnormal-consumption readings. */
  verifiedReadingSummary: PublicUtilityVerificationKpi;
  tenantUtility: ManagementTenantUtilityRow[];
  /** Latest two BE-23I trend buckets; no alternate comparison arithmetic. */
  periodComparison: {
    interval: UtilityKpiInterval;
    previous: PublicUtilityTrendPoint | null;
    current: PublicUtilityTrendPoint | null;
  };
};

export type PublicManagementUtilitySummary = ManagementReadModelContract<
  ManagementUtilitySummaryData,
  ManagementUtilitySummaryFilters
>;

/** CR-BE-UTL-01 PART 16 — one Building, one exact reporting period. */
export type BuildingUtilityOperationalSummaryQuery = {
  buildingId: string;
  periodStart: Date;
  periodEnd: Date;
};
export type BuildingUtilityReconciliationSummary = {
  reconciliationId: string;
  utilityType: 'ELECTRICITY' | 'WATER';
  periodStart: string;
  periodEnd: string;
  sourceConsumption: number;
  tenantConsumption: number;
  commonAreaConsumption: number;
  unallocatedConsumption: number;
  reconciliationPercentage: number | null;
  performanceMetric: 'IKE' | 'IKA';
  performanceValue: number;
  applicableAreaSqm: number;
  consumptionUomId: string;
  performanceUom: 'kWh/m²' | 'm³/m²';
  calculatedAt: string;
};
export type BuildingMeterOperationalSummary = {
  totalActiveMeters: number;
  byPurpose: {
    TENANT: number;
    BUILDING: number;
    COMMON_AREA: number;
    ENERGY_SOURCE: number;
  };
  readingDue: {
    due: number;
    overdue: number;
    completed: number;
    cancelled: number;
  };
};
export type BuildingUtilityExceptionSummary = {
  total: number;
  byType: Record<string, number>;
  bySeverity: { LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
  byStatus: { OPEN: number; UNDER_REVIEW: number; RESOLVED: number; CANCELLED: number };
};
export type BuildingUtilityBillingReadinessSummary = {
  calculationsAwaitingApproval: number;
  approvedCalculations: number;
  rejectedCalculations: number;
  utilityBillsCreated: number;
  invoiceReadyUtilityBills: number;
};
export type PublicBuildingUtilityOperationalSummary = {
  clientId: string;
  buildingId: string;
  reportingPeriod: { start: string; end: string };
  reconciliations: BuildingUtilityReconciliationSummary[];
  meters: BuildingMeterOperationalSummary;
  exceptions: BuildingUtilityExceptionSummary;
  billingReadiness: BuildingUtilityBillingReadinessSummary;
  asOf: string;
};
