import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18E — Meter Reading domain types.
 *
 * BE-18 is authoritative for Meter Reading data. A reading is a measured
 * value on an existing BE-18A Meter, expressed in an existing BE-07 unit of
 * measure, at a point in time, attributed to the user who recorded it.
 *
 * BE-10C integration: the engineering meter-reading workflow (Asset + BE-07
 * form field, executed as a BE-07 Form Instance) keeps its own store. When an
 * engineering round yields a utility reading, the reading LINKS back to that
 * context via `meterReadingBindingId` / `formInstanceId` rather than the two
 * stores each claiming to be the record of the same measurement.
 *
 * Readings are append-only — there is no update or delete input type in this
 * module, by design. A correction is a new reading, so a posted reading can
 * never be silently overwritten and the chronological history stays intact.
 *
 * Consumption / deltas (BE-18G) and Reading Evidence (BE-18F) are out of
 * scope: this module measures, it does not calculate or attach evidence.
 */

/** Where the reading came from. */
export const UTILITY_METER_READING_SOURCES = [
  'MANUAL',
  'ENGINEERING',
  'IMPORT',
  'SYSTEM',
] as const;
export type UtilityMeterReadingSource =
  (typeof UTILITY_METER_READING_SOURCES)[number];

export function isUtilityMeterReadingSource(
  value: unknown,
): value is UtilityMeterReadingSource {
  return (
    typeof value === 'string' &&
    (UTILITY_METER_READING_SOURCES as readonly string[]).includes(value)
  );
}

/** Whether the value was actually read or estimated. */
export const UTILITY_METER_READING_TYPES = ['ACTUAL', 'ESTIMATED'] as const;
export type UtilityMeterReadingType =
  (typeof UTILITY_METER_READING_TYPES)[number];

export function isUtilityMeterReadingType(
  value: unknown,
): value is UtilityMeterReadingType {
  return (
    typeof value === 'string' &&
    (UTILITY_METER_READING_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Full database record.
 *
 * `readingValue` is kept as the raw NUMERIC string from PostgreSQL so no
 * precision is lost in transit; the public shape exposes a number.
 */
export type UtilityMeterReadingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  uomId: string;
  readingValue: string;
  readingAt: Date;
  source: UtilityMeterReadingSource;
  readingType: UtilityMeterReadingType;
  notes: string | null;
  recordedByUserId: string;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  meterReadingBindingId: string | null;
  formInstanceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Identifying Meter context denormalised into a reading response. */
export type ReadingMeterSummary = {
  id: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  uomId: string;
  buildingId: string;
  status: string;
};

/** Resolved BE-07 UOM context. */
export type ReadingUomSummary = {
  id: string;
  code: string;
  name: string;
  symbol: string;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityMeterReading = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  uomId: string;
  readingValue: number;
  readingAt: string;
  source: UtilityMeterReadingSource;
  readingType: UtilityMeterReadingType;
  notes: string | null;
  recordedByUserId: string;
  /** BE-18D tenant context as it stood when the reading was taken. */
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  /** BE-10C engineering context this reading came from, when applicable. */
  meterReadingBindingId: string | null;
  formInstanceId: string | null;
  createdAt: string;
  updatedAt: string;
  meter?: ReadingMeterSummary | null;
  uom?: ReadingUomSummary | null;
};

/** Input accepted by POST /utility/meters/:id/readings. */
export type RecordUtilityMeterReadingInput = {
  meterId: string;
  readingValue: number;
  readingAt: Date;
  recordedByUserId: string;
  /** Defaults to the Meter's own UOM when omitted. */
  uomId?: string;
  source?: UtilityMeterReadingSource;
  readingType?: UtilityMeterReadingType;
  notes?: string | null;
  /**
   * Optional expected tenant. When supplied it is checked against the Meter's
   * live BE-18D assignment; it never overrides it.
   */
  tenantCompanyId?: string;
  /** Optional BE-10C linkage — never a second source of truth. */
  meterReadingBindingId?: string | null;
  formInstanceId?: string | null;
};

/** Fully-resolved data ready for persistence. */
export type NewUtilityMeterReading = {
  clientId: string;
  buildingId: string;
  meterId: string;
  uomId: string;
  readingValue: number;
  readingAt: Date;
  source: UtilityMeterReadingSource;
  readingType: UtilityMeterReadingType;
  notes: string | null;
  recordedByUserId: string;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  meterReadingBindingId: string | null;
  formInstanceId: string | null;
};

/** Filters shared by the reading list endpoints. */
export type UtilityMeterReadingFilters = {
  meterId?: string;
  tenantCompanyId?: string;
  source?: UtilityMeterReadingSource;
  readingType?: UtilityMeterReadingType;
  /** Inclusive lower / upper bounds on `reading_at`. */
  from?: Date;
  to?: Date;
  limit?: number;
};
