import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18I — Utility Calculation domain types.
 *
 * A calculation turns an authoritative BE-18G consumption into a value:
 *
 *   calculated amount = consumption value x applied rate
 *
 * The consumption value is never copied onto the calculation row — it is read
 * from BE-18G at calculation time and referenced by `consumptionId`
 * thereafter. BE-18E readings are two hops away and never touched here.
 *
 * The applied rate IS snapshotted. A basis is versioned reference data that
 * can be superseded; a finalized result must stay explainable after the basis
 * behind it changes, so the rate actually used is frozen onto the row.
 *
 * Out of scope, deliberately: invoicing, tax, payment, accounting, and
 * Abnormal Consumption (BE-18J). Billing never lives in BE-18.
 */

export const UTILITY_CALCULATION_STATUSES = [
  'DRAFT',
  'FINALIZED',
  'SUPERSEDED',
] as const;

export type UtilityCalculationStatus =
  (typeof UTILITY_CALCULATION_STATUSES)[number];

export function isUtilityCalculationStatus(
  value: unknown,
): value is UtilityCalculationStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_CALCULATION_STATUSES as readonly string[]).includes(value)
  );
}

export const UTILITY_CALCULATION_BASIS_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type UtilityCalculationBasisStatus =
  (typeof UTILITY_CALCULATION_BASIS_STATUSES)[number];

export function isUtilityCalculationBasisStatus(
  value: unknown,
): value is UtilityCalculationBasisStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_CALCULATION_BASIS_STATUSES as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------
 * Calculation basis — lightweight, data-driven rate reference
 * ---------------------------------------------------------------------- */

/** Full basis record. */
export type UtilityCalculationBasisRecord = {
  id: string;
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description: string | null;
  uomId: string | null;
  /** Raw NUMERIC string from PostgreSQL so no precision is lost in transit. */
  rateValue: string;
  rateLabel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: UtilityCalculationBasisStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation of a basis. */
export type PublicUtilityCalculationBasis = {
  id: string;
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description: string | null;
  uomId: string | null;
  rateValue: number;
  rateLabel: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: UtilityCalculationBasisStatus;
  createdAt: string;
  updatedAt: string;
};

/** Input accepted by POST /clients/:clientId/utility-calculation-bases. */
export type CreateUtilityCalculationBasisInput = {
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description?: string | null;
  uomId?: string | null;
  rateValue: number;
  rateLabel?: string | null;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status?: UtilityCalculationBasisStatus;
};

/** Fully-resolved basis ready for persistence. */
export type NewUtilityCalculationBasis = {
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description: string | null;
  uomId: string | null;
  rateValue: number;
  rateLabel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: UtilityCalculationBasisStatus;
};

/** Filters for the client-scoped basis list. */
export type UtilityCalculationBasisFilters = {
  utilityType?: UtilityType;
  status?: UtilityCalculationBasisStatus;
};

/* -------------------------------------------------------------------------
 * Calculation
 * ---------------------------------------------------------------------- */

/** Full calculation record. */
export type UtilityCalculationRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  utilityType: UtilityType;
  consumptionId: string;
  calculationBasisId: string | null;
  /** Immutable source quantity and tariff facts used for this charge. */
  consumptionQuantity: string;
  tariffId: string | null;
  tariffRate: string | null;
  currency: string | null;
  /** Raw NUMERIC strings from PostgreSQL so no precision is lost in transit. */
  appliedRateValue: string;
  calculatedAmount: string;
  uomId: string;
  periodStart: Date;
  periodEnd: Date;
  status: UtilityCalculationStatus;
  calculatedAt: Date;
  calculatedByUserId: string | null;
  finalizedAt: Date | null;
  finalizedByUserId: string | null;
  supersedesCalculationId: string | null;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Identifying Meter context denormalised into a calculation response. */
export type CalculationMeterSummary = {
  id: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  uomId: string;
  buildingId: string;
  status: string;
};

/** Resolved BE-07 UOM context. */
export type CalculationUomSummary = {
  id: string;
  code: string;
  name: string;
  symbol: string;
};

/**
 * Read-through view of the source consumption. Resolved from BE-18G at query
 * time so the calculation row itself never holds a copy of the value.
 */
export type CalculationConsumptionSummary = {
  id: string;
  consumptionValue: number;
  uomId: string;
  periodStart: string;
  periodEnd: string;
  meterId: string;
  tenantCompanyId: string | null;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityCalculation = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  utilityType: UtilityType;
  consumptionId: string;
  calculationBasisId: string | null;
  consumptionQuantity: number;
  tariffId: string | null;
  tariffRate: number | null;
  currency: string | null;
  appliedRateValue: number;
  calculatedAmount: number;
  uomId: string;
  periodStart: string;
  periodEnd: string;
  status: UtilityCalculationStatus;
  calculatedAt: string;
  calculatedByUserId: string | null;
  finalizedAt: string | null;
  finalizedByUserId: string | null;
  /** Points at the result this one replaced, preserving the audit chain. */
  supersedesCalculationId: string | null;
  /** BE-18D tenant context as it stood across the period. */
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  meter?: CalculationMeterSummary | null;
  uom?: CalculationUomSummary | null;
  consumption?: CalculationConsumptionSummary | null;
  basis?: PublicUtilityCalculationBasis | null;
};

/** Input accepted by POST /utility/consumptions/:id/calculations. */
export type CalculateUtilityValueInput = {
  consumptionId: string;
  /**
   * Optional explicit basis. When omitted, the ACTIVE basis whose effective
   * window covers the consumption period is resolved for the Client and
   * utility type.
   */
  calculationBasisId?: string;
  calculatedByUserId?: string;
  notes?: string | null;
};

/** Input accepted by POST /utility/calculations/:id/recalculate. */
export type RecalculateUtilityValueInput = {
  calculationId: string;
  calculationBasisId?: string;
  calculatedByUserId?: string;
  notes?: string | null;
};

/** Fully-resolved data ready for persistence. */
export type NewUtilityCalculation = {
  clientId: string;
  buildingId: string;
  meterId: string;
  utilityType: UtilityType;
  consumptionId: string;
  calculationBasisId: string | null;
  consumptionQuantity: string;
  tariffId: string | null;
  tariffRate: string | null;
  currency: string | null;
  appliedRateValue: string;
  uomId: string;
  periodStart: Date;
  periodEnd: Date;
  status: UtilityCalculationStatus;
  calculatedByUserId: string | null;
  supersedesCalculationId: string | null;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
};

/** Filters shared by the calculation list endpoints. */
export type UtilityCalculationFilters = {
  meterId?: string;
  tenantCompanyId?: string;
  buildingId?: string;
  status?: UtilityCalculationStatus;
  utilityType?: UtilityType;
  /** Inclusive bounds applied to the calculation period. */
  from?: Date;
  to?: Date;
  limit?: number;
};

/** Scope anchor for a list query — always one authoritative column. */
export type UtilityCalculationScope = {
  column: 'meter_id' | 'building_id' | 'tenant_company_id' | 'client_id';
  value: string;
};
