import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18D — Tenant Meter domain types.
 *
 * A "tenant meter" is NOT a separate master. It is an existing BE-18A Meter
 * that is currently assigned to an existing BE-14A Tenant Company at an
 * existing BE-04 Space:
 *
 *   Meter → assignment → Tenant Company @ Space
 *
 * This module owns only that assignment. Meter identity stays in BE-18A,
 * tenancy of a Space stays in BE-14C, and the Main/Sub hierarchy stays in
 * BE-18C — none of them are duplicated or re-derived here.
 *
 * The assignment carries its own lifecycle — `status` plus an optional
 * effective window — so a tenant change supersedes the previous row instead
 * of overwriting it, preserving assignment history.
 *
 * BE-18B utility configuration remains opt-in and is never consulted here.
 * Meter Reading (BE-18E) and consumption (BE-18G) are out of scope: this
 * assignment computes and measures nothing.
 */

export const UTILITY_METER_TENANT_ASSIGNMENT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type UtilityMeterTenantAssignmentStatus =
  (typeof UTILITY_METER_TENANT_ASSIGNMENT_STATUSES)[number];

export function isUtilityMeterTenantAssignmentStatus(
  value: unknown,
): value is UtilityMeterTenantAssignmentStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_METER_TENANT_ASSIGNMENT_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/** Full database record. */
export type UtilityMeterTenantAssignmentRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  tenantCompanyId: string;
  spaceId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: UtilityMeterTenantAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Identifying Meter context denormalised into an assignment response. */
export type TenantAssignmentMeterSummary = {
  id: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  uomId: string;
  buildingId: string;
  status: string;
};

/** Identifying Tenant Company context denormalised into a response. */
export type TenantAssignmentTenantSummary = {
  id: string;
  tenantCode: string;
  tenantName: string;
  status: string;
};

/** Identifying Space context denormalised into a response. */
export type TenantAssignmentSpaceSummary = {
  id: string;
  code: string;
  name: string;
  status: string;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityMeterTenantAssignment = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  tenantCompanyId: string;
  spaceId: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  status: UtilityMeterTenantAssignmentStatus;
  createdAt: string;
  updatedAt: string;
  /** Resolved reference context, when loaded. */
  meter?: TenantAssignmentMeterSummary | null;
  tenantCompany?: TenantAssignmentTenantSummary | null;
  space?: TenantAssignmentSpaceSummary | null;
};

/** Input accepted by POST /utility/meters/:id/tenant-assignments. */
export type AssignMeterToTenantInput = {
  meterId: string;
  tenantCompanyId: string;
  spaceId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterTenantAssignmentStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewUtilityMeterTenantAssignment = {
  clientId: string;
  buildingId: string;
  meterId: string;
  tenantCompanyId: string;
  spaceId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: UtilityMeterTenantAssignmentStatus;
};

/**
 * Partial update input (PATCH /utility/meter-tenant-assignments/:id).
 *
 * The Meter, Tenant and Space are immutable on an existing assignment:
 * re-assigning a Meter is a new assignment, so the previous one stays in
 * history rather than being rewritten.
 */
export type UpdateUtilityMeterTenantAssignmentInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterTenantAssignmentStatus;
};

/** Filters for assignment listings. */
export type UtilityMeterTenantAssignmentFilters = {
  status?: UtilityMeterTenantAssignmentStatus;
};
