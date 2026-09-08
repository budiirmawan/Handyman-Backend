/**
 * BE-11L — Housekeeping Complaint Binding domain types.
 *
 * Minimal Housekeeping operational binding connecting customer complaints / service requests
 * to Housekeeping operations without inventing a generic complaint platform.
 */

export const HOUSEKEEPING_COMPLAINT_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HousekeepingComplaintBindingStatus =
  (typeof HOUSEKEEPING_COMPLAINT_BINDING_STATUSES)[number];

export const HOUSEKEEPING_COMPLAINT_SOURCE_TYPES = [
  'DAILY_CLEANING',
  'TOILET_INSPECTION',
  'PUBLIC_AREA_INSPECTION',
  'SUPERVISOR_INSPECTION',
  'CLEANING_AREA',
] as const;
export type HousekeepingComplaintSourceType =
  (typeof HOUSEKEEPING_COMPLAINT_SOURCE_TYPES)[number];

export function isHousekeepingComplaintBindingStatus(
  value: unknown,
): value is HousekeepingComplaintBindingStatus {
  return (
    typeof value === 'string' &&
    (HOUSEKEEPING_COMPLAINT_BINDING_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

export function isHousekeepingComplaintSourceType(
  value: unknown,
): value is HousekeepingComplaintSourceType {
  return (
    typeof value === 'string' &&
    (HOUSEKEEPING_COMPLAINT_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

export type HousekeepingComplaintBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  complaintReference: string;
  workRequestId: string | null;
  cleaningAreaId: string | null;
  housekeepingSourceType: HousekeepingComplaintSourceType | null;
  housekeepingSourceId: string | null;
  findingId: string | null;
  description: string | null;
  status: HousekeepingComplaintBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHousekeepingComplaintBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  complaintReference: string;
  workRequestId: string | null;
  cleaningAreaId: string | null;
  housekeepingSourceType: HousekeepingComplaintSourceType | null;
  housekeepingSourceId: string | null;
  findingId: string | null;
  description: string | null;
  status: HousekeepingComplaintBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
  finding?: {
    id: string;
    findingNumber: string;
    title: string;
    status: string;
  } | null;
  workRequest?: {
    id: string;
    requestNumber: string;
    title: string;
    status: string;
  } | null;
};

export type CreateHousekeepingComplaintBindingInput = {
  buildingId: string;
  complaintReference: string;
  workRequestId?: string | null;
  cleaningAreaId?: string | null;
  housekeepingSourceType?: HousekeepingComplaintSourceType | null;
  housekeepingSourceId?: string | null;
  findingId?: string | null;
  description?: string | null;
  status?: HousekeepingComplaintBindingStatus;
  createdByUserId: string;
};

export type UpdateHousekeepingComplaintBindingInput = {
  description?: string | null;
  findingId?: string | null;
  status?: HousekeepingComplaintBindingStatus;
};

export type HousekeepingComplaintBindingFilter = {
  complaintReference?: string;
  buildingId?: string;
  cleaningAreaId?: string;
  findingId?: string;
  workRequestId?: string;
  status?: HousekeepingComplaintBindingStatus;
};
