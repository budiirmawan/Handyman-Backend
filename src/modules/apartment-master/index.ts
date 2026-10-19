/**
 * CR-HM-MASTER-IND-01 — Indonesian apartment master data.
 *
 * Unit = existing Space master; party = existing individual/legal-entity
 * master; tenancy = existing BE-14C relationship. This module adds only the
 * genuinely missing pieces: Unit-scoped administration reads, effective-dated
 * Owner/Occupant/PIC roles, and request-level approval/cost designations.
 */
export { resolveApartmentBuildingScope } from './apartment-master.scope';
export {
  apartmentUnitService,
  getApartmentUnit,
  listApartmentUnitOccupancies,
  listApartmentUnits,
  updateApartmentUnit,
} from './apartment-unit.service';
export { apartmentUnitRepository } from './unit.repository';
export {
  APARTMENT_UNIT_STATUSES,
  isApartmentUnitStatus,
} from './unit.types';
export type {
  ApartmentUnitFilters,
  ApartmentUnitOccupancyFilters,
  ApartmentUnitOccupancyRecord,
  ApartmentUnitRecord,
  ApartmentUnitStatus,
} from './unit.types';
export {
  UNIT_PARTY_ROLES,
  UNIT_PARTY_ROLE_STATUSES,
  isUnitPartyRole,
  isUnitPartyRoleStatus,
} from './unit-party-role.types';
export type {
  AssignUnitPartyRoleInput,
  EndUnitPartyRoleInput,
  PublicUnitPartyRole,
  UnitPartyRole,
  UnitPartyRoleFilters,
  UnitPartyRoleRecord,
  UnitPartyRoleStatus,
} from './unit-party-role.types';
export { unitPartyRoleRepository } from './unit-party-role.repository';
export {
  assignUnitPartyRole,
  endUnitPartyRole,
  hasCurrentUnitPartyRole,
  listUnitPartyRoles,
  toPublicUnitPartyRole,
  unitPartyRoleService,
} from './unit-party-role.service';
export {
  apartmentUnitFloorMismatchError,
  apartmentUnitNotFoundError,
  unitPartyRoleAlreadyActiveError,
  unitPartyRoleContextMismatchError,
  unitPartyRoleNotFoundError,
  unitPartyRoleUnavailableError,
} from './unit-party-role.errors';
export { createApartmentMasterRouter } from './apartment-master.routes';
