/**
 * BE-02E — Building domain types.
 *
 * A Building is a physical building/facility managed within a Property
 * (Property → Building). Client ownership is derived authoritatively through
 * Building → Property → Client. Building is NOT a Property, Floor, Area, Room,
 * Organization, or Tenant.
 */
export const BUILDING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type BuildingStatus = (typeof BUILDING_STATUSES)[number];

export function isBuildingStatus(value: unknown): value is BuildingStatus {
  return (
    typeof value === 'string' &&
    (BUILDING_STATUSES as readonly string[]).includes(value)
  );
}

export type BuildingRecord = {
  id: string;
  propertyId: string;
  /** Optional Campus grouping (BE-04B). NULL = plain Property → Building. */
  campusId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: BuildingStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicBuilding = {
  id: string;
  propertyId: string;
  campusId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: BuildingStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
  timezone: string | null;
};

export type CreateBuildingInput = {
  propertyId: string;
  code: string;
  name: string;
  description?: string;
  status?: BuildingStatus;
  addressLine?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  countryCode?: string;
  timezone?: string;
};

/** Fully-resolved building data ready for persistence. */
export type NewBuilding = {
  propertyId: string;
  code: string;
  name: string;
  description: string | null;
  status: BuildingStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
  timezone: string | null;
};

export type UpdateBuildingStatusInput = {
  status: BuildingStatus;
};
