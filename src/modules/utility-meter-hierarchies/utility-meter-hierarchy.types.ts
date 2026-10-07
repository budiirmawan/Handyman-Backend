import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18C — Main / Sub Meter hierarchy domain types.
 *
 * Records which BE-18A Meter feeds which other BE-18A Meter:
 *
 *   Main Meter → relationship → Sub Meter
 *
 * Both sides are existing `utility_meters` records (BE-18A stays the Meter
 * master); this module owns only the relationship between them. The
 * relationship carries its own lifecycle — `status` plus an optional
 * effective window — so a re-bind supersedes the previous row instead of
 * overwriting it, preserving hierarchy history.
 *
 * BE-18B utility configuration remains opt-in and is NOT required here: the
 * compatibility rule this part enforces is between the two Meters' own
 * `utilityType` values.
 *
 * Tenant Meter (BE-18D), readings (BE-18E) and consumption (BE-18G) are not
 * part of BE-18C. This relationship computes nothing — it never aggregates,
 * nets, or allocates any value.
 */

export const UTILITY_METER_HIERARCHY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type UtilityMeterHierarchyStatus =
  (typeof UTILITY_METER_HIERARCHY_STATUSES)[number];

export function isUtilityMeterHierarchyStatus(
  value: unknown,
): value is UtilityMeterHierarchyStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_METER_HIERARCHY_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type UtilityMeterHierarchyRecord = {
  id: string;
  clientId: string;
  mainMeterId: string;
  subMeterId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: UtilityMeterHierarchyStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Identifying Meter context denormalised into a relationship response. */
export type HierarchyMeterSummary = {
  id: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  buildingId: string;
  status: string;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityMeterHierarchy = {
  id: string;
  clientId: string;
  mainMeterId: string;
  subMeterId: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  status: UtilityMeterHierarchyStatus;
  createdAt: string;
  updatedAt: string;
  /** Resolved BE-18A Meter context, when loaded. */
  mainMeter?: HierarchyMeterSummary | null;
  subMeter?: HierarchyMeterSummary | null;
};

/** Input accepted by POST /utility/meters/:id/sub-meters. */
export type BindSubMeterInput = {
  mainMeterId: string;
  subMeterId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterHierarchyStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewUtilityMeterHierarchy = {
  clientId: string;
  mainMeterId: string;
  subMeterId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: UtilityMeterHierarchyStatus;
};

/**
 * Partial update input (PATCH /utility/meter-hierarchies/:id).
 *
 * The two Meters are immutable on an existing relationship: re-pointing a Sub
 * Meter at a different Main Meter is a new relationship, so the previous one
 * stays in history rather than being rewritten.
 */
export type UpdateUtilityMeterHierarchyInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterHierarchyStatus;
};

/** Filters for hierarchy listings. */
export type UtilityMeterHierarchyFilters = {
  status?: UtilityMeterHierarchyStatus;
};
