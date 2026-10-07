import type { PermitApplicationStatus } from '../permit-applications/permit-application.types';

export const PERMIT_WORK_LOCATION_TYPES = [
  'BUILDING',
  'FLOOR',
  'AREA',
  'ROOM',
  'FUNCTIONAL_LOCATION',
] as const;

export type PermitWorkLocationType =
  (typeof PERMIT_WORK_LOCATION_TYPES)[number];

export function isPermitWorkLocationType(
  value: unknown,
): value is PermitWorkLocationType {
  return typeof value === 'string' &&
    (PERMIT_WORK_LOCATION_TYPES as readonly string[]).includes(value);
}

export type PermitWorkContextRecord = {
  id: string;
  permitApplicationId: string;
  permitId: string;
  permitReference: string;
  clientId: string;
  buildingId: string;
  applicationStatus: PermitApplicationStatus;
  locationType: PermitWorkLocationType | null;
  locationId: string | null;
  locationCode: string | null;
  locationName: string | null;
  buildingLocationId: string | null;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  functionalLocationId: string | null;
  workType: string | null;
  workDescription: string;
  workDescriptionOverride: string | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  accessRestrictionNotes: string | null;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermitWorkContext = Omit<
  PermitWorkContextRecord,
  'plannedStartAt' | 'plannedEndAt' | 'createdAt' | 'updatedAt'
> & {
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResolvedPermitWorkLocation = {
  locationType: PermitWorkLocationType;
  locationId: string;
  buildingLocationId: string | null;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  functionalLocationId: string | null;
};

export type AssignPermitWorkLocationInput = {
  locationType: PermitWorkLocationType;
  locationId: string;
  plannedStartAt: Date;
  plannedEndAt: Date;
  accessRestrictionNotes?: string | null;
  workDescription?: string | null;
};

export type AssignPermitWorkTypeInput = {
  workType: string;
  workDescription?: string | null;
};

export type UpdatePermitWorkContextInput = {
  locationType?: PermitWorkLocationType;
  locationId?: string;
  workType?: string;
  workDescription?: string | null;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  accessRestrictionNotes?: string | null;
};

export type PersistPermitWorkContext = {
  permitApplicationId: string;
  location: ResolvedPermitWorkLocation | null;
  workType: string | null;
  workDescription: string | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  accessRestrictionNotes: string | null;
  actorUserId: string;
};

export type PermitWorkContextFilters = {
  buildingId?: string;
  locationType?: PermitWorkLocationType;
  locationId?: string;
  workType?: string;
};
