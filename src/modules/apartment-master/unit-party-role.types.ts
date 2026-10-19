/**
 * CR-HM-MASTER-IND-01 — effective-dated Unit party roles.
 *
 * A Unit party role records WHO a party (individual or legal entity from the
 * existing `tenant_companies` party master) is to ONE Unit:
 *
 *   OWNER    — ownership
 *   OCCUPANT — resides/uses the Unit
 *   PIC      — designated contact for the Unit
 *
 * TENANCY is deliberately absent: `tenant_space_relationships` (BE-14C) is
 * the single authoritative occupancy relationship and already carries its own
 * effective window and ACTIVE-per-Unit uniqueness. Duplicating TENANT here
 * would create a second occupancy truth.
 *
 * Every role row is effective-dated and is never deleted: ending a role sets
 * `status = INACTIVE` and closes `effectiveUntil`, so Owner/Occupant/PIC
 * history survives tenant and ownership changes.
 */
export const UNIT_PARTY_ROLES = ['OWNER', 'OCCUPANT', 'PIC'] as const;
export type UnitPartyRole = (typeof UNIT_PARTY_ROLES)[number];

export function isUnitPartyRole(value: unknown): value is UnitPartyRole {
  return (
    typeof value === 'string' &&
    (UNIT_PARTY_ROLES as readonly string[]).includes(value)
  );
}

export const UNIT_PARTY_ROLE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type UnitPartyRoleStatus = (typeof UNIT_PARTY_ROLE_STATUSES)[number];

export function isUnitPartyRoleStatus(
  value: unknown,
): value is UnitPartyRoleStatus {
  return (
    typeof value === 'string' &&
    (UNIT_PARTY_ROLE_STATUSES as readonly string[]).includes(value)
  );
}

export type UnitPartyRoleRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  unitId: string;
  tenantCompanyId: string;
  tenantCode: string;
  tenantName: string;
  partyKind: string;
  partyRole: UnitPartyRole;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  status: UnitPartyRoleStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicUnitPartyRole = Omit<
  UnitPartyRoleRecord,
  'createdAt' | 'updatedAt' | 'effectiveFrom' | 'effectiveUntil'
> & {
  effectiveFrom: string;
  effectiveUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AssignUnitPartyRoleInput = {
  buildingId: string;
  unitId: string;
  tenantCompanyId: string;
  partyRole: UnitPartyRole;
  effectiveFrom?: Date;
  effectiveUntil?: Date | null;
};

export type NewUnitPartyRole = {
  clientId: string;
  buildingId: string;
  unitId: string;
  tenantCompanyId: string;
  partyRole: UnitPartyRole;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  createdByUserId: string;
};

export type UnitPartyRoleFilters = {
  partyRole?: UnitPartyRole;
  status?: UnitPartyRoleStatus;
};

export type EndUnitPartyRoleInput = {
  effectiveUntil?: Date;
};
