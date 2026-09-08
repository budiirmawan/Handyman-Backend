/**
 * BE-04F — Space domain types.
 *
 * A Space is a smaller identifiable physical/operational subdivision inside
 * exactly one Room (Building → Floor → Area/Zone → Room → Space), e.g. a
 * workstation cluster, a counter, a rack bay. Client ownership is derived
 * authoritatively through Space → Room → Area → Floor → Building → Property
 * → Client.
 *
 * A Space is NOT a Functional Location, Asset, or Equipment — Functional
 * Location arrives in BE-04G; Assets/Equipment are out of BE-04 scope.
 */
export const SPACE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type SpaceStatus = (typeof SPACE_STATUSES)[number];

export function isSpaceStatus(value: unknown): value is SpaceStatus {
  return (
    typeof value === 'string' &&
    (SPACE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type SpaceRecord = {
  id: string;
  roomId: string;
  code: string;
  name: string;
  description: string | null;
  areaSqm: string | null;
  status: SpaceStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicSpace = {
  id: string;
  roomId: string;
  code: string;
  name: string;
  description: string | null;
  areaSqm: number | null;
  status: SpaceStatus;
};

/** Input supplied by the API consumer when creating a Space. */
export type CreateSpaceInput = {
  roomId: string;
  code: string;
  name: string;
  description?: string;
  areaSqm?: number | null;
  status?: SpaceStatus;
};

/** Fully-resolved space data ready for persistence. */
export type NewSpace = {
  roomId: string;
  code: string;
  name: string;
  description: string | null;
  areaSqm: number | null;
  status: SpaceStatus;
};

/** Partial update input (PATCH /spaces/:id). */
export type UpdateSpaceInput = {
  name?: string;
  description?: string;
  areaSqm?: number | null;
  status?: SpaceStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateSpaceStatusInput = {
  status: SpaceStatus;
};
