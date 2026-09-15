/**
 * BE-04G — Functional Location domain types.
 *
 * A Functional Location is an OPERATIONAL LOCATION REFERENCE anchored to the
 * digital building structure: always one Building, optionally pinned to a
 * Space (Building → Floor → Area/Zone → Room → Space → Functional Location)
 * for finer physical context. Client ownership is derived authoritatively
 * through Functional Location → Building → Property → Client.
 *
 * It is NOT an Asset, Equipment, Asset hierarchy, Work Order, Checklist, or
 * Task — and it carries NO Asset binding (deferred beyond BE-04). It merely
 * gives operational domains a stable location reference.
 */
export const FUNCTIONAL_LOCATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type FunctionalLocationStatus =
  (typeof FUNCTIONAL_LOCATION_STATUSES)[number];

export function isFunctionalLocationStatus(
  value: unknown,
): value is FunctionalLocationStatus {
  return (
    typeof value === 'string' &&
    (FUNCTIONAL_LOCATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type FunctionalLocationRecord = {
  id: string;
  buildingId: string;
  /** Optional finer physical placement. NULL = Building-level reference. */
  spaceId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: FunctionalLocationStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicFunctionalLocation = {
  id: string;
  buildingId: string;
  spaceId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: FunctionalLocationStatus;
};

/** Input supplied by the API consumer when creating a Functional Location. */
export type CreateFunctionalLocationInput = {
  buildingId: string;
  spaceId?: string;
  code: string;
  name: string;
  description?: string;
  status?: FunctionalLocationStatus;
};

/** Fully-resolved functional location data ready for persistence. */
export type NewFunctionalLocation = {
  buildingId: string;
  spaceId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: FunctionalLocationStatus;
};

/** Partial update input (PATCH /functional-locations/:id). */
export type UpdateFunctionalLocationInput = {
  name?: string;
  description?: string;
  status?: FunctionalLocationStatus;
  /** A Space id re-pins the reference; null clears it to Building level. */
  spaceId?: string | null;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateFunctionalLocationStatusInput = {
  status: FunctionalLocationStatus;
};
