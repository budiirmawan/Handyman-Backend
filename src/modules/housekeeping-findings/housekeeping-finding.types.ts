/**
 * BE-11H — Housekeeping Finding domain types.
 *
 * Binds Housekeeping operational issues (from Daily Cleaning, Toilet Inspection,
 * Public Area Inspection, or Supervisor Inspection) to BE-09 Findings.
 */

export const HOUSEKEEPING_FINDING_SOURCE_TYPES = [
  'DAILY_CLEANING',
  'TOILET_INSPECTION',
  'PUBLIC_AREA_INSPECTION',
  'SUPERVISOR_INSPECTION',
] as const;
export type HousekeepingFindingSourceType =
  (typeof HOUSEKEEPING_FINDING_SOURCE_TYPES)[number];

export function isHousekeepingFindingSourceType(
  value: unknown,
): value is HousekeepingFindingSourceType {
  return (
    typeof value === 'string' &&
    (HOUSEKEEPING_FINDING_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

export type HousekeepingFindingLinkRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  findingId: string;
  cleaningAreaId: string;
  sourceType: HousekeepingFindingSourceType;
  sourceId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  functionalLocationId: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHousekeepingFinding = {
  id: string;
  clientId: string;
  buildingId: string;
  findingId: string;
  cleaningAreaId: string;
  sourceType: HousekeepingFindingSourceType;
  sourceId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  functionalLocationId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  finding: {
    id: string;
    findingNumber: string;
    title: string;
    description: string | null;
    status: string;
    state?: string;
    reportedByUserId: string;
    reportedAt: string;
  };
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
    cleaningAreaType: string;
    status: string;
  };
  availableActions?: readonly string[];
};

export type CreateHousekeepingFindingInput = {
  buildingId: string;
  cleaningAreaId: string;
  sourceType: HousekeepingFindingSourceType;
  sourceId: string;
  title: string;
  description?: string | null;
  findingNumber?: string;
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  functionalLocationId?: string | null;
  notes?: string | null;
  responsiblePartyType?: 'INTERNAL_WORKFORCE' | 'EXTERNAL_VENDOR' | 'TEAM';
  responsiblePartyId?: string;
  vendorId?: string;
};

export type HousekeepingFindingFilter = {
  buildingId?: string;
  cleaningAreaId?: string;
  sourceType?: HousekeepingFindingSourceType;
  status?: string;
};
