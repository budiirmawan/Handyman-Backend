/**
 * BE-04B — Campus domain types.
 *
 * A Campus is an OPTIONAL higher grouping of Buildings inside one Property
 * (Property → Campus → Building where applicable). Properties without
 * campuses keep the plain Property → Building chain — a Building never
 * requires a Campus. Client ownership is derived authoritatively through
 * Campus → Property → Client.
 *
 * A Campus is NOT a Property, Building, Floor, Area, Room, Space, Functional
 * Location, Asset, or Equipment — those belong to other PARTs (or are out of
 * BE-04 scope entirely).
 */
export const CAMPUS_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type CampusStatus = (typeof CAMPUS_STATUSES)[number];

export function isCampusStatus(value: unknown): value is CampusStatus {
  return (
    typeof value === 'string' &&
    (CAMPUS_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type CampusRecord = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string | null;
  status: CampusStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicCampus = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string | null;
  status: CampusStatus;
};

/** Input supplied by the API consumer when creating a Campus. */
export type CreateCampusInput = {
  propertyId: string;
  code: string;
  name: string;
  description?: string;
  status?: CampusStatus;
};

/** Fully-resolved campus data ready for persistence. */
export type NewCampus = {
  propertyId: string;
  code: string;
  name: string;
  description: string | null;
  status: CampusStatus;
};

/** Partial update input (PATCH /campuses/:id). */
export type UpdateCampusInput = {
  name?: string;
  description?: string;
  status?: CampusStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateCampusStatusInput = {
  status: CampusStatus;
};

/**
 * Building ↔ Campus association input. `campusId: null` detaches the Building
 * from its Campus (back to the plain Property → Building chain).
 */
export type SetBuildingCampusInput = {
  campusId: string | null;
};
