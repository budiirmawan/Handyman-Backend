/**
 * BE-02D — Property domain types.
 *
 * A Property is the commercial/property grouping owned by a Client (Client →
 * Property). It is the parent context for future Buildings (BE-02E). Property
 * is NOT a Building, Floor, Area, Room, Organization, or Tenant.
 */
export const PROPERTY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

export function isPropertyStatus(value: unknown): value is PropertyStatus {
  return (
    typeof value === 'string' &&
    (PROPERTY_STATUSES as readonly string[]).includes(value)
  );
}

export type PropertyRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: PropertyStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicProperty = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: PropertyStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
};

export type CreatePropertyInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  status?: PropertyStatus;
  addressLine?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  countryCode?: string;
};

/** Fully-resolved property data ready for persistence. */
export type NewProperty = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: PropertyStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
};

export type UpdatePropertyStatusInput = {
  status: PropertyStatus;
};
