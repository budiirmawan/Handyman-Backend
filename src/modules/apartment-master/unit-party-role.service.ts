import { AppError } from '../../shared/errors';
import type { PaginationParams } from '../../shared/pagination';
import { resolveApartmentBuildingScope } from './apartment-master.scope';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import {
  apartmentUnitNotFoundError,
  unitPartyRoleAlreadyActiveError,
  unitPartyRoleContextMismatchError,
  unitPartyRoleNotFoundError,
  unitPartyRoleUnavailableError,
} from './unit-party-role.errors';
import { unitPartyRoleRepository } from './unit-party-role.repository';
import type {
  AssignUnitPartyRoleInput,
  PublicUnitPartyRole,
  UnitPartyRoleFilters,
  UnitPartyRoleRecord,
} from './unit-party-role.types';
import { apartmentUnitRepository } from './unit.repository';

/**
 * CR-HM-MASTER-IND-01 — effective-dated Unit party role service.
 *
 * AUTHORITY CHAIN (fail-closed, server-derived):
 *   1. Building scope from the existing BE-02 assignment rule
 *      (`resolveApartmentBuildingScope`) — the caller never supplies a Client;
 *   2. the Unit must resolve through the full Space → Room → Area → Floor →
 *      Building → Property chain inside that Client and Building;
 *   3. the party must exist in the SAME Client (a foreign-Client party is
 *      reported exactly like an unknown one) and be ACTIVE;
 *   4. an ACTIVE role requires an ACTIVE Unit;
 *   5. one currently-effective assignment per (Unit, role, party) — end the
 *      existing one instead of stacking duplicates.
 *
 * Nothing is deleted: ending a role closes its effective window and preserves
 * the historical row.
 */

const ACTIVE_ROLE_UNIQUE = 'unit_party_roles_active_party_unique';

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === ACTIVE_ROLE_UNIQUE
  );
}

/** A trigger-raised context violation (23514) is a scope/consistency denial. */
function isContextViolation(error: unknown): boolean {
  const candidate = error as { code?: string };
  return candidate?.code === '23514';
}

export function toPublicUnitPartyRole(
  record: UnitPartyRoleRecord,
): PublicUnitPartyRole {
  return {
    ...record,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveUntil: record.effectiveUntil?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertEffectiveWindow(from: Date, until: Date | null): void {
  if (until !== null && until.getTime() <= from.getTime()) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'effectiveUntil',
        message: 'effectiveUntil must be after effectiveFrom.',
      },
    ]);
  }
}

export async function assignUnitPartyRole(
  input: AssignUnitPartyRoleInput & { actorUserId: string },
): Promise<PublicUnitPartyRole> {
  const scope = await resolveApartmentBuildingScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
  });

  const unit = await apartmentUnitRepository.findUnit({
    clientId: scope.clientId,
    buildingId: scope.buildingId,
    unitId: input.unitId,
  });
  if (!unit || unit.clientId !== scope.clientId) {
    throw apartmentUnitNotFoundError();
  }

  const party = await tenantCompanyRepository.findById(input.tenantCompanyId);
  // Unknown party and foreign-Client party collapse into the same 404: the
  // response never confirms that a party id exists in another Client.
  if (!party || party.clientId !== scope.clientId) {
    throw tenantCompanyNotFoundError();
  }
  if (unit.status !== 'ACTIVE' || party.status !== 'ACTIVE') {
    throw unitPartyRoleUnavailableError();
  }

  const effectiveFrom = input.effectiveFrom ?? new Date();
  const effectiveUntil = input.effectiveUntil ?? null;
  assertEffectiveWindow(effectiveFrom, effectiveUntil);

  const existing = await unitPartyRoleRepository.findActiveByUnitRoleParty({
    clientId: scope.clientId,
    unitId: unit.id,
    partyRole: input.partyRole,
    tenantCompanyId: party.id,
  });
  if (existing) throw unitPartyRoleAlreadyActiveError();

  try {
    const created = await unitPartyRoleRepository.insert({
      clientId: scope.clientId,
      buildingId: scope.buildingId,
      unitId: unit.id,
      tenantCompanyId: party.id,
      partyRole: input.partyRole,
      effectiveFrom,
      effectiveUntil,
      createdByUserId: input.actorUserId,
    });
    return toPublicUnitPartyRole(created);
  } catch (error) {
    if (isUniqueViolation(error)) throw unitPartyRoleAlreadyActiveError();
    if (isContextViolation(error)) throw unitPartyRoleContextMismatchError();
    throw error;
  }
}

export async function listUnitPartyRoles(input: {
  actorUserId: string;
  buildingId: string;
  unitId: string;
  filters: UnitPartyRoleFilters;
  page: PaginationParams;
}): Promise<{ items: PublicUnitPartyRole[]; total: number }> {
  const scope = await resolveApartmentBuildingScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
  });
  const unit = await apartmentUnitRepository.findUnit({
    clientId: scope.clientId,
    buildingId: scope.buildingId,
    unitId: input.unitId,
  });
  if (!unit || unit.clientId !== scope.clientId) {
    throw apartmentUnitNotFoundError();
  }
  const result = await unitPartyRoleRepository.listByUnit({
    clientId: scope.clientId,
    buildingId: scope.buildingId,
    unitId: unit.id,
    filters: input.filters,
    limit: input.page.limit,
    offset: input.page.offset,
  });
  return { items: result.items.map(toPublicUnitPartyRole), total: result.total };
}

/**
 * Ends a Unit party role: closes the effective window and marks it INACTIVE.
 * Idempotent — an already-ended role is returned unchanged. The row is never
 * deleted, so ownership/occupancy history survives.
 */
export async function endUnitPartyRole(input: {
  actorUserId: string;
  unitPartyRoleId: string;
  effectiveUntil?: Date;
}): Promise<PublicUnitPartyRole> {
  const role = await unitPartyRoleRepository.findById(input.unitPartyRoleId);
  if (!role) throw unitPartyRoleNotFoundError();

  const scope = await resolveApartmentBuildingScope({
    actorUserId: input.actorUserId,
    buildingId: role.buildingId,
  });
  if (scope.clientId !== role.clientId) throw unitPartyRoleNotFoundError();

  if (role.status === 'INACTIVE') return toPublicUnitPartyRole(role);

  const effectiveUntil = input.effectiveUntil ?? new Date();
  if (effectiveUntil.getTime() < role.effectiveFrom.getTime()) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'effectiveUntil',
        message: 'effectiveUntil must not be before effectiveFrom.',
      },
    ]);
  }

  const updated = await unitPartyRoleRepository.end(role.id, effectiveUntil);
  if (!updated) throw unitPartyRoleNotFoundError();
  return toPublicUnitPartyRole(updated);
}

/**
 * Server-side eligibility helper used by the Customer Care gateway: is this
 * party a currently-effective Owner/Occupant/PIC of this Unit? Returns false
 * for any mismatch (wrong Client/Building/Unit, inactive, expired) — never an
 * existence oracle.
 */
export async function hasCurrentUnitPartyRole(input: {
  clientId: string;
  buildingId: string;
  unitId: string;
  tenantCompanyId: string;
}): Promise<boolean> {
  const rows = await unitPartyRoleRepository.listByUnit({
    clientId: input.clientId,
    buildingId: input.buildingId,
    unitId: input.unitId,
    filters: { status: 'ACTIVE' },
    limit: 200,
    offset: 0,
  });
  const now = Date.now();
  return rows.items.some(
    (row) =>
      row.tenantCompanyId === input.tenantCompanyId &&
      row.effectiveFrom.getTime() <= now &&
      (row.effectiveUntil === null || row.effectiveUntil.getTime() >= now),
  );
}

export const unitPartyRoleService = {
  assignUnitPartyRole,
  endUnitPartyRole,
  hasCurrentUnitPartyRole,
  listUnitPartyRoles,
};
