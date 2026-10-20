/**
 * CR-HM-MASTER-IND-01 — Apartment Unit master read model.
 *
 * A Unit IS the existing `spaces` row (migration 0041) inside the existing
 * physical hierarchy Building → Floor → Area → Room → Space. The repository
 * deliberately introduces NO second physical master: `spaces` is the
 * authoritative Unit identity, and every Unit read here is keyed by the
 * Server-derived (clientId, buildingId) pair.
 */
export const APARTMENT_UNIT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ApartmentUnitStatus = (typeof APARTMENT_UNIT_STATUSES)[number];

export function isApartmentUnitStatus(
  value: unknown,
): value is ApartmentUnitStatus {
  return (
    typeof value === 'string' &&
    (APARTMENT_UNIT_STATUSES as readonly string[]).includes(value)
  );
}

export type ApartmentUnitRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ApartmentUnitStatus;
  areaSqm: number | null;
  clientId: string;
  buildingId: string;
  buildingCode: string;
  floorId: string;
  floorCode: string;
  floorName: string;
  levelNumber: number;
  roomId: string;
  roomCode: string;
  areaId: string;
  areaCode: string;
};

export type ApartmentUnitFilters = {
  floorId?: string;
  status?: ApartmentUnitStatus;
  search?: string;
};

/** Effective-dated occupancy history row for one Unit. */
export type ApartmentUnitOccupancyRecord = {
  id: string;
  tenantCompanyId: string;
  tenantCode: string;
  tenantName: string;
  partyKind: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  /** True when this row is the currently-effective occupancy. */
  current: boolean;
};

export type ApartmentUnitOccupancyFilters = {
  status?: 'ACTIVE' | 'INACTIVE';
};

export type ApartmentUnitPage = { limit: number; offset: number };
