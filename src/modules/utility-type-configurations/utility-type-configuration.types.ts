import {
  UTILITY_TYPES,
  isUtilityType,
  type UtilityType,
} from '../utility-meters/utility-meter.types';

/**
 * BE-18B — Electricity / Water / Gas configuration domain types.
 *
 * The supported utility types themselves are reused verbatim from BE-18A
 * (`UTILITY_TYPES`) so there is exactly one definition of ELECTRICITY /
 * WATER / GAS in the backend — BE-18B never re-declares them.
 *
 * A configuration is per (Client, utility type) reference data: display
 * metadata, optional reading precision, lifecycle status, and the set of
 * BE-07 UOMs allowed for that utility type. There is no separate utility
 * engine — BE-18A's Meter Master simply validates against this data.
 */

export { UTILITY_TYPES, isUtilityType };
export type { UtilityType };

export const UTILITY_TYPE_CONFIGURATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type UtilityTypeConfigurationStatus =
  (typeof UTILITY_TYPE_CONFIGURATION_STATUSES)[number];

export function isUtilityTypeConfigurationStatus(
  value: unknown,
): value is UtilityTypeConfigurationStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_TYPE_CONFIGURATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Full configuration record. */
export type UtilityTypeConfigurationRecord = {
  id: string;
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description: string | null;
  decimalPrecision: number | null;
  status: UtilityTypeConfigurationStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Full allowed-UOM mapping record. */
export type UtilityTypeUomRecord = {
  id: string;
  utilityTypeConfigurationId: string;
  uomId: string;
  isDefault: boolean;
  status: UtilityTypeConfigurationStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** A resolved allowed UOM, enriched with its BE-07 UOM context. */
export type PublicUtilityTypeUom = {
  id: string;
  utilityTypeConfigurationId: string;
  uomId: string;
  isDefault: boolean;
  status: UtilityTypeConfigurationStatus;
  createdAt: string;
  updatedAt: string;
  uom: {
    id: string;
    code: string;
    name: string;
    symbol: string;
    status: string;
  } | null;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityTypeConfiguration = {
  id: string;
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description: string | null;
  decimalPrecision: number | null;
  status: UtilityTypeConfigurationStatus;
  createdAt: string;
  updatedAt: string;
  /** Allowed BE-07 UOMs for this utility type. */
  allowedUoms: PublicUtilityTypeUom[];
  /** Convenience pointer to the ACTIVE default mapping, when configured. */
  defaultUomId: string | null;
};

/** POST /clients/:clientId/utility-type-configurations */
export type CreateUtilityTypeConfigurationInput = {
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description?: string | null;
  decimalPrecision?: number | null;
  status?: UtilityTypeConfigurationStatus;
  /** Optional initial allowed-UOM mapping. */
  uomIds?: string[];
  defaultUomId?: string | null;
};

/** Fully-resolved configuration ready for persistence. */
export type NewUtilityTypeConfiguration = {
  clientId: string;
  utilityType: UtilityType;
  name: string;
  description: string | null;
  decimalPrecision: number | null;
  status: UtilityTypeConfigurationStatus;
};

/** PATCH /utility/type-configurations/:id */
export type UpdateUtilityTypeConfigurationInput = {
  name?: string;
  description?: string | null;
  decimalPrecision?: number | null;
  status?: UtilityTypeConfigurationStatus;
};

/** PATCH /utility/type-configurations/:id/status */
export type UpdateUtilityTypeConfigurationStatusInput = {
  status: UtilityTypeConfigurationStatus;
};

/** POST /utility/type-configurations/:id/uoms */
export type AddUtilityTypeUomInput = {
  uomId: string;
  isDefault?: boolean;
};

/** PATCH /utility/type-configurations/:id/uoms/:uomId */
export type UpdateUtilityTypeUomInput = {
  isDefault?: boolean;
  status?: UtilityTypeConfigurationStatus;
};

/** Filters for the client-scoped configuration list. */
export type UtilityTypeConfigurationFilters = {
  utilityType?: UtilityType;
  status?: UtilityTypeConfigurationStatus;
};
