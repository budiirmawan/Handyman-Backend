import type { UtilityType } from '../utility-meters';

export const UTILITY_TARIFF_TYPES = ['ELECTRICITY', 'WATER'] as const;
export type UtilityTariffType = (typeof UTILITY_TARIFF_TYPES)[number];
export const isUtilityTariffType = (value: unknown): value is UtilityTariffType =>
  typeof value === 'string' &&
  (UTILITY_TARIFF_TYPES as readonly string[]).includes(value);

export const UTILITY_TARIFF_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type UtilityTariffStatus = (typeof UTILITY_TARIFF_STATUSES)[number];
export const isUtilityTariffStatus = (value: unknown): value is UtilityTariffStatus =>
  typeof value === 'string' &&
  (UTILITY_TARIFF_STATUSES as readonly string[]).includes(value);

export type UtilityTariffRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  utilityType: UtilityTariffType;
  currency: string;
  uomId: string;
  ratePerUom: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  status: UtilityTariffStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicUtilityTariff = Omit<
  UtilityTariffRecord,
  'ratePerUom' | 'effectiveFrom' | 'effectiveUntil' | 'createdAt' | 'updatedAt'
> & {
  ratePerUom: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateUtilityTariffInput = {
  buildingId: string;
  utilityType: UtilityTariffType;
  currency: string;
  uomId: string;
  /** Plain decimal string; multiplication remains NUMERIC inside PostgreSQL. */
  ratePerUom: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  status: UtilityTariffStatus;
};

export type UtilityTariffFilters = {
  utilityType?: UtilityType;
  status?: UtilityTariffStatus;
};
