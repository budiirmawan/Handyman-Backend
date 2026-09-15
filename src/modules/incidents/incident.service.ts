import { areaRepository, areaNotFoundError } from '../areas';
import { buildingRepository, buildingNotFoundError } from '../buildings';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { floorRepository, floorNotFoundError } from '../floors';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import { propertyRepository, propertyNotFoundError } from '../properties';
import { roomRepository, roomNotFoundError } from '../rooms';
import { spaceRepository, spaceNotFoundError } from '../spaces';
import {
  incidentBuildingInactiveError,
  incidentCancelNotAllowedError,
  incidentLocationInactiveError,
  incidentLocationMismatchError,
  incidentNotFoundError,
  incidentNumberAlreadyExistsError,
  incidentUpdateNotAllowedError,
} from './incident.errors';
import { incidentRepository } from './incident.repository';
import type {
  CreateIncidentInput,
  IncidentFilters,
  IncidentLocationType,
  IncidentRecord,
  NewIncident,
  PublicIncident,
  UpdateIncidentInput,
} from './incident.types';

/**
 * BE-21A — shared Incident foundation service.
 *
 * ONE foundation for OPERATIONAL, ASSET_FAILURE, and FINDING_ESCALATION
 * incidents. The discriminator selects the kind; it does NOT select a
 * different engine. BE-21C and BE-21D will attach their Asset and BE-09
 * Finding bindings to these same records.
 *
 * BE-09 stays authoritative for Finding and workflow behaviour: nothing here
 * reads, writes, or mirrors Finding state.
 *
 * Isolation invariants enforced here:
 *   - `clientId` is DERIVED (Building → Property → Client), never accepted.
 *   - Every read and write asserts Building access for the actor.
 *   - Listing is scoped to accessible Buildings in SQL.
 *   - Any optional BE-04 location must resolve back to the same Building.
 *
 * Validation order (pinned by focused tests):
 *   1. unknown Building              → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building         → 403 BUILDING_ACCESS_DENIED
 *   3. INACTIVE Building             → 400 INCIDENT_BUILDING_INACTIVE
 *   4. unknown location reference    → 404 <LOCATION>_NOT_FOUND
 *   5. cross-Building location       → 400 INCIDENT_LOCATION_MISMATCH
 *   6. INACTIVE location             → 400 INCIDENT_LOCATION_INACTIVE
 *   7. duplicate number for Client   → 409 INCIDENT_NUMBER_ALREADY_EXISTS
 */

export function toPublicIncident(record: IncidentRecord): PublicIncident {
  return {
    ...record,
    locationId: resolveLocationId(record),
    reportedAt: record.reportedAt.toISOString(),
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    closedAt: record.closedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Projects the single populated BE-04 reference implied by `locationType`. */
function resolveLocationId(record: IncidentRecord): string | null {
  switch (record.locationType) {
    case 'FLOOR':
      return record.floorId;
    case 'AREA':
      return record.areaId;
    case 'ROOM':
      return record.roomId;
    case 'SPACE':
      return record.spaceId;
    case 'FUNCTIONAL_LOCATION':
      return record.functionalLocationId;
    default:
      return null;
  }
}

/**
 * Derives the owning Client through Building → Property → Client (BE-02).
 *
 * Exported so BE-21 specializations (BE-21B onward) reuse this exact
 * derivation and access assertion instead of re-implementing tenancy rules.
 */
export async function resolveBuildingContext(
  buildingId: string,
  actorUserId: string,
): Promise<{ clientId: string }> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) throw buildingNotFoundError();

  // Access is asserted before any further detail is revealed.
  await contextAccessService.assertBuildingAccess(actorUserId, building.id);

  if (building.status !== 'ACTIVE') throw incidentBuildingInactiveError();

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) throw propertyNotFoundError();
  return { clientId: property.clientId };
}

export type ResolvedLocation = {
  locationType: IncidentLocationType | null;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
};

const NO_LOCATION: ResolvedLocation = {
  locationType: null,
  floorId: null,
  areaId: null,
  roomId: null,
  spaceId: null,
  functionalLocationId: null,
};

/**
 * Validates the optional BE-04 location refinement and places the id in the
 * correct typed column. The location must belong to the Incident's Building —
 * this is what stops an accessible Building being used to attach an incident
 * to another Building's structure.
 *
 * Exported so BE-21 specializations reuse the same location authority.
 */
export async function resolveLocation(
  locationType: IncidentLocationType | null | undefined,
  locationId: string | null | undefined,
  buildingId: string,
): Promise<ResolvedLocation> {
  if (!locationType || !locationId) return NO_LOCATION;

  switch (locationType) {
    case 'FLOOR': {
      const floor = await floorRepository.findById(locationId);
      if (!floor) throw floorNotFoundError();
      if (floor.buildingId !== buildingId) {
        throw incidentLocationMismatchError(
          'The referenced floor does not belong to this building.',
        );
      }
      assertActiveLocation(floor.status);
      return { ...NO_LOCATION, locationType, floorId: floor.id };
    }
    case 'AREA': {
      const area = await areaRepository.findById(locationId);
      if (!area) throw areaNotFoundError();
      const floor = await floorRepository.findById(area.floorId);
      if (!floor || floor.buildingId !== buildingId) {
        throw incidentLocationMismatchError(
          'The referenced area does not belong to this building.',
        );
      }
      assertActiveLocation(area.status);
      return { ...NO_LOCATION, locationType, areaId: area.id };
    }
    case 'ROOM': {
      const room = await roomRepository.findById(locationId);
      if (!room) throw roomNotFoundError();
      const area = await areaRepository.findById(room.areaId);
      const floor = area ? await floorRepository.findById(area.floorId) : null;
      if (!floor || floor.buildingId !== buildingId) {
        throw incidentLocationMismatchError(
          'The referenced room does not belong to this building.',
        );
      }
      assertActiveLocation(room.status);
      return { ...NO_LOCATION, locationType, roomId: room.id };
    }
    case 'SPACE': {
      const space = await spaceRepository.findById(locationId);
      if (!space) throw spaceNotFoundError();
      const room = await roomRepository.findById(space.roomId);
      const area = room ? await areaRepository.findById(room.areaId) : null;
      const floor = area ? await floorRepository.findById(area.floorId) : null;
      if (!floor || floor.buildingId !== buildingId) {
        throw incidentLocationMismatchError(
          'The referenced space does not belong to this building.',
        );
      }
      assertActiveLocation(space.status);
      return { ...NO_LOCATION, locationType, spaceId: space.id };
    }
    case 'FUNCTIONAL_LOCATION': {
      const location = await functionalLocationRepository.findById(locationId);
      if (!location) throw functionalLocationNotFoundError();
      if (location.buildingId !== buildingId) {
        throw incidentLocationMismatchError(
          'The referenced functional location does not belong to this building.',
        );
      }
      assertActiveLocation(location.status);
      return {
        ...NO_LOCATION,
        locationType,
        functionalLocationId: location.id,
      };
    }
  }
}

function assertActiveLocation(status: string): void {
  if (status !== 'ACTIVE') throw incidentLocationInactiveError();
}

/** Shared with BE-21 specializations so the 409 contract stays identical. */
export function isIncidentNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'incidents_number_unique'
  );
}

export async function createIncident(
  input: CreateIncidentInput,
  actorUserId: string,
): Promise<PublicIncident> {
  const { clientId } = await resolveBuildingContext(
    input.buildingId,
    actorUserId,
  );
  const location = await resolveLocation(
    input.locationType,
    input.locationId,
    input.buildingId,
  );

  if (
    await incidentRepository.findByClientAndNumber(
      clientId,
      input.incidentNumber,
    )
  ) {
    throw incidentNumberAlreadyExistsError();
  }

  const newIncident: NewIncident = {
    clientId,
    buildingId: input.buildingId,
    incidentNumber: input.incidentNumber,
    incidentType: input.incidentType,
    title: input.title,
    description: input.description ?? null,
    severity: input.severity ?? 'MEDIUM',
    priority: input.priority ?? 'MEDIUM',
    ...location,
    reportedByUserId: actorUserId,
    reportedAt: input.reportedAt ?? new Date(),
  };

  try {
    const created = await incidentRepository.create(newIncident);
    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      entityType: 'INCIDENT',
      entityId: created.id,
      eventType: 'INCIDENT_REPORTED',
      actorUserId,
      summary: `Incident ${created.incidentNumber} reported`,
      metadata: {
        incidentNumber: created.incidentNumber,
        incidentType: created.incidentType,
        severity: created.severity,
        priority: created.priority,
        locationType: created.locationType,
      },
    });
    return toPublicIncident(created);
  } catch (error) {
    // The unique index is the final authority — it also covers the race
    // between the pre-check above and this INSERT.
    if (isIncidentNumberUniqueViolation(error)) {
      throw incidentNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getIncident(
  id: string,
  actorUserId: string,
): Promise<PublicIncident> {
  const record = await incidentRepository.findById(id);
  if (!record) throw incidentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublicIncident(record);
}

export async function listIncidents(
  filters: IncidentFilters,
  actorUserId: string,
): Promise<PublicIncident[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await incidentRepository.list(filters, buildingIds)).map(
    toPublicIncident,
  );
}

export async function updateIncident(
  id: string,
  input: UpdateIncidentInput,
  actorUserId: string,
): Promise<PublicIncident> {
  const existing = await incidentRepository.findById(id);
  if (!existing) throw incidentNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.status !== 'REPORTED') throw incidentUpdateNotAllowedError();

  const updated = await incidentRepository.updateReported(id, input);
  if (!updated) throw incidentUpdateNotAllowedError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'INCIDENT',
    entityId: updated.id,
    eventType: 'INCIDENT_UPDATED',
    actorUserId,
    summary: `Incident ${updated.incidentNumber} metadata updated`,
    metadata: { fields: Object.keys(input) },
  });
  return toPublicIncident(updated);
}

export async function cancelIncident(
  id: string,
  actorUserId: string,
): Promise<PublicIncident> {
  const existing = await incidentRepository.findById(id);
  if (!existing) throw incidentNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.status !== 'REPORTED') throw incidentCancelNotAllowedError();

  const cancelled = await incidentRepository.cancelReported(id, actorUserId);
  if (!cancelled) throw incidentCancelNotAllowedError();

  await recordOperationalEvent({
    clientId: cancelled.clientId,
    buildingId: cancelled.buildingId,
    entityType: 'INCIDENT',
    entityId: cancelled.id,
    eventType: 'INCIDENT_CANCELLED',
    actorUserId,
    summary: `Incident ${cancelled.incidentNumber} cancelled`,
    metadata: { previousStatus: existing.status },
  });
  return toPublicIncident(cancelled);
}

export const incidentService = {
  cancelIncident,
  createIncident,
  getIncident,
  listIncidents,
  toPublicIncident,
  updateIncident,
};
