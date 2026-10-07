/**
 * BE-18A — Meter Master domain types.
 *
 * BE-18 is authoritative for Meter / Utility master data. A Meter is a
 * physical measuring device installed in exactly one Building
 * (Client → Property → Building → Meter); `clientId` is always derived by the
 * service through Building → Property → Client, never taken from the caller.
 *
 * Reuse, never duplicate:
 *   - Building / Space / Functional Location stay BE-04 masters — referenced
 *     by id only.
 *   - `uomId` reuses the BE-07 `units_of_measure` foundation (same Client +
 *     ACTIVE).
 *
 * `utilityType` is DATA (ELECTRICITY / WATER / GAS) — no behavior branching
 * here; type-specific rules arrive with BE-18B. Main/Sub meter (BE-18C),
 * Tenant meter (BE-18D), readings (BE-18E) and consumption (BE-18G) are NOT
 * part of BE-18A. Billing / accounting never lives in BE-18.
 */

export const UTILITY_METER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type UtilityMeterStatus = (typeof UTILITY_METER_STATUSES)[number];

export function isUtilityMeterStatus(value: unknown): value is UtilityMeterStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_METER_STATUSES as readonly string[]).includes(value)
  );
}

export const UTILITY_METER_PURPOSES = [
  'TENANT', 'BUILDING', 'COMMON_AREA', 'ENERGY_SOURCE',
] as const;
export type UtilityMeterPurpose = (typeof UTILITY_METER_PURPOSES)[number];
export const isUtilityMeterPurpose = (value: unknown): value is UtilityMeterPurpose =>
  typeof value === 'string' &&
  (UTILITY_METER_PURPOSES as readonly string[]).includes(value);

export const UTILITY_TYPES = ['ELECTRICITY', 'WATER', 'GAS'] as const;
export type UtilityType = (typeof UTILITY_TYPES)[number];

export function isUtilityType(value: unknown): value is UtilityType {
  return (
    typeof value === 'string' &&
    (UTILITY_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type UtilityMeterRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  functionalLocationId: string | null;
  code: string;
  name: string;
  utilityType: UtilityType;
  purpose: UtilityMeterPurpose;
  uomId: string;
  serialNumber: string | null;
  status: UtilityMeterStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityMeter = {
  id: string;
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  functionalLocationId: string | null;
  code: string;
  name: string;
  utilityType: UtilityType;
  purpose: UtilityMeterPurpose;
  uomId: string;
  serialNumber: string | null;
  status: UtilityMeterStatus;
  createdAt: string;
  updatedAt: string;
  /** Optional resolved BE-07 UOM context when available. */
  uom?: {
    id: string;
    code: string;
    name: string;
    symbol: string;
  } | null;
};

/** Input accepted by POST /buildings/:buildingId/utility-meters. */
export type CreateUtilityMeterInput = {
  buildingId: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  purpose?: UtilityMeterPurpose;
  uomId: string;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  serialNumber?: string | null;
  status?: UtilityMeterStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewUtilityMeter = {
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  functionalLocationId: string | null;
  code: string;
  name: string;
  utilityType: UtilityType;
  purpose: UtilityMeterPurpose;
  uomId: string;
  serialNumber: string | null;
  status: UtilityMeterStatus;
};

/** Partial update input (PATCH /utility/meters/:id). */
export type UpdateUtilityMeterInput = {
  name?: string;
  utilityType?: UtilityType;
  uomId?: string;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  serialNumber?: string | null;
  status?: UtilityMeterStatus;
};

/** Status-only update input (PATCH /utility/meters/:id/status). */
export type UpdateUtilityMeterStatusInput = {
  status: UtilityMeterStatus;
};

/** List / search filters. */
export type UtilityMeterFilters = {
  status?: UtilityMeterStatus;
  utilityType?: UtilityType;
  uomId?: string;
  spaceId?: string;
  functionalLocationId?: string;
  /** Case-insensitive match against code, name, or serial number. */
  search?: string;
};
