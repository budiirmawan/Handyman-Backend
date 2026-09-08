import { AppError } from '../../shared/errors';
import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { shiftHandoverNotFoundError, shiftHandoverRepository } from '../shift-handovers';
import { organizationRepository } from '../organizations';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import type { WorkforceProfileRecord } from '../workforce';
import {
  securityLogbookEntryImmutableError,
  securityLogbookEntryNotFoundError,
  securityLogbookHandoverBuildingMismatchError,
} from './security-logbook.errors';
import { securityLogbookRepository } from './security-logbook.repository';
import type {
  CreateSecurityLogbookEntryInput,
  PublicSecurityLogbookEntry,
  SecurityLogbookListFilters,
  UpdateSecurityLogbookEntryInput,
} from './security-logbook.types';

/**
 * CR-BE-MOB-05 PART 03 — Security Operational Logbook service.
 *
 * Backend-authoritative, Building-scoped Security logbook entries:
 *
 *   authenticated user  → `workforce_profiles.user_id` (BE-03C, unique)
 *   building context    → `contextAccessService.assertBuildingAccess`
 *                         (BE-02F/G — the same authority data isolation uses)
 *   client identity     → derived Building → Property → Client (never
 *                         caller-supplied)
 *   handover reference  → the authoritative `shift_handovers.id` row when
 *                         supplied; must exist (404) and resolve to the SAME
 *                         Building (400 cross-Building rejection). Outgoing /
 *                         incoming Shift IDs are never invented.
 *   timestamps          → database clock only (NOW()); client timestamps are
 *                         never accepted anywhere
 *
 * Lifecycle: OPEN → CLOSED. Updates are allowed only while OPEN; CLOSED is
 * terminal and preserved. List/get assert the entry's Building is in the
 * caller's accessible set — no cross-Building reads.
 *
 * Validation order for create (pinned by tests):
 *   1. missing / invalid fields             → 400 VALIDATION_ERROR
 *   2. no linked Workforce Profile          → 404 WORKFORCE_PROFILE_NOT_FOUND
 *   3. INACTIVE Workforce Profile           → 400 WORKFORCE_PROFILE_INACTIVE
 *   4. unknown / inaccessible Building      → 403 BUILDING_ACCESS_DENIED
 *      (the route's requireBuildingAccess gate blocks before the service
 *      runs, so an unknown Building is never distinguishable — BE-02G never
 *      leaks existence; the service's buildingNotFoundError guards direct
 *      service calls; an INACTIVE Building is never in the accessible set)
 *   5. unknown handover (when supplied)     → 404 SHIFT_HANDOVER_NOT_FOUND
 *   6. cross-Building handover              → 400 SECURITY_LOGBOOK_HANDOVER_BUILDING_MISMATCH
 */

/** The caller's linked ACTIVE Workforce Profile; unknown/inactive is an error. */
async function requireActiveProfile(
  userId: string,
): Promise<WorkforceProfileRecord> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }
  return profile;
}

/**
 * Resolves the optional Shift Handover reference against the authoritative
 * `shift_handovers` row: must exist and belong to the same Building.
 */
async function assertHandoverBinding(
  shiftHandoverId: string | null,
  buildingId: string,
): Promise<string | null> {
  if (!shiftHandoverId) {
    return null;
  }
  const handover = await shiftHandoverRepository.findById(shiftHandoverId);
  if (!handover) {
    throw shiftHandoverNotFoundError();
  }
  if (handover.buildingId !== buildingId) {
    throw securityLogbookHandoverBuildingMismatchError();
  }
  return handover.id;
}

/** Asserts the entry's Building is inside the caller's accessible set. */
async function assertEntryBuildingAccess(
  userId: string,
  buildingId: string,
): Promise<void> {
  await contextAccessService.assertBuildingAccess(userId, buildingId);
}

/** Creates a Building-scoped logbook entry for the authenticated profile. */
export async function createLogbookEntry(
  input: CreateSecurityLogbookEntryInput,
  userId: string,
): Promise<PublicSecurityLogbookEntry> {
  const profile = await requireActiveProfile(userId);

  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await assertEntryBuildingAccess(userId, building.id);

  const { clientId } = await resolveAssetBuildingContext(building.id);
  const handoverId = await assertHandoverBinding(
    input.shiftHandoverId ?? null,
    building.id,
  );

  return securityLogbookRepository.createLogbookEntry({
    clientId,
    buildingId: building.id,
    workforceProfileId: profile.id,
    shiftHandoverId: handoverId,
    category: input.category,
    summary: input.summary,
    detail: input.detail ?? null,
  });
}

/** Lists the Building's entries (newest first), access-asserted. */
export async function listLogbookEntries(
  buildingId: string,
  filters: SecurityLogbookListFilters,
  range: { start: Date | null; end: Date | null },
  userId: string,
): Promise<PublicSecurityLogbookEntry[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await assertEntryBuildingAccess(userId, building.id);

  return securityLogbookRepository.listLogbookEntriesByBuilding(
    building.id,
    filters,
    range,
  );
}

/** Gets one entry; the caller must be able to access its Building. */
export async function getLogbookEntry(
  id: string,
  userId: string,
): Promise<PublicSecurityLogbookEntry> {
  return requireLogbookEntryById(id, userId);
}

/**
 * Updates an OPEN entry (category / summary / detail / status / optional
 * handover binding). CLOSED entries are terminal → 400
 * SECURITY_LOGBOOK_ENTRY_IMMUTABLE. The entry's Building is access-asserted.
 */
export async function updateLogbookEntry(
  id: string,
  input: UpdateSecurityLogbookEntryInput,
  userId: string,
): Promise<PublicSecurityLogbookEntry> {
  const existing = await requireLogbookEntryById(id, userId);

  if (existing.status === 'CLOSED') {
    throw securityLogbookEntryImmutableError();
  }

  let shiftHandoverId: string | null | undefined = input.shiftHandoverId;
  if (shiftHandoverId !== undefined) {
    shiftHandoverId = await assertHandoverBinding(
      shiftHandoverId,
      existing.buildingId,
    );
  }

  const updated = await securityLogbookRepository.updateLogbookEntry(
    existing.id,
    {
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(shiftHandoverId === undefined ? {} : { shiftHandoverId }),
    },
  );
  if (!updated) {
    throw securityLogbookEntryNotFoundError();
  }
  return updated;
}

/** Loads the entry by id and asserts Building access; 404 when unknown. */
async function requireLogbookEntryById(
  id: string,
  userId: string,
): Promise<PublicSecurityLogbookEntry> {
  const entry = await securityLogbookRepository.findByIdJoined(id);
  if (!entry) {
    throw securityLogbookEntryNotFoundError();
  }
  await assertEntryBuildingAccess(userId, entry.buildingId);
  return entry;
}

/** Converts a filter window into the half-open recorded_at range. */
export function logbookRange(filters: SecurityLogbookListFilters): {
  start: Date | null;
  end: Date | null;
} {
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo)
      ? new Date(to.getTime() + 86400000)
      : to;
  }
  return { start, end };
}

export const securityLogbookService = {
  createLogbookEntry,
  getLogbookEntry,
  listLogbookEntries,
  logbookRange,
  updateLogbookEntry,
};
