import { withTransaction } from '../../database';
import { assetNotFoundError, assetRepository } from '../assets';
import type { AssetRecord } from '../assets';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import {
  incidentNumberAlreadyExistsError,
  incidentRepository,
  isIncidentNumberUniqueViolation,
  resolveBuildingContext,
  resolveLocation,
  type IncidentLocationType,
  type ResolvedLocation,
} from '../incidents';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { resolveFunctionalLocationContext } from '../structure-context';
import { userRepository } from '../users';
import {
  assetFailureAssetBuildingMismatchError,
  assetFailureAssetClientMismatchError,
  assetFailureAssetLocationMismatchError,
  assetFailureAssetRetiredError,
  assetFailureInvalidTransitionError,
  assetFailureNotFoundError,
  assetFailureOccurrenceInvalidError,
  assetFailureReporterInvalidError,
  assetFailureTypeMismatchError,
  assetFailureUpdateNotAllowedError,
} from './asset-failure.errors';
import { assetFailureRepository } from './asset-failure.repository';
import {
  assetFailureTransitionActions,
  canTransitionAssetFailureStatus,
  type AssetFailureAction,
  type AssetFailureCompositeRecord,
  type AssetFailureFilters,
  type CreateAssetFailureInput,
  type PublicAssetFailure,
  type UpdateAssetFailureInput,
} from './asset-failure.types';

/**
 * BE-21C — Asset Failure / Defect service.
 *
 * An Asset Failure is a SPECIALIZATION of the BE-21A foundation bound to an
 * existing BE-05 Asset — not a parallel domain and not an asset registry:
 *   - The Incident row is created through BE-21A's repository with
 *     `incidentType` pinned to ASSET_FAILURE — the caller cannot choose it.
 *   - Client derivation, Building access, and BE-04 location validation reuse
 *     BE-21A's exported authorities rather than re-implementing them.
 *   - The Asset is REFERENCED through BE-05's repository. No Asset master data
 *     is copied, and recording a failure never mutates the Asset or drives its
 *     BE-05E lifecycle — that stays a separate, explicitly authorized action.
 *   - Foundation + specialization are written in ONE transaction, so a
 *     half-built Asset Failure can never exist.
 *
 * Status and `availableActions` are resolved by the backend on every read.
 * BE-09 remains authoritative for Finding workflow; the small closed
 * transition table here is deliberately not a generic workflow engine.
 */

/** Occurrence may be backdated but never post-dated. */
function assertOccurrence(occurredAt: Date): void {
  if (occurredAt.getTime() > Date.now()) {
    throw assetFailureOccurrenceInvalidError();
  }
}

/**
 * A reporter other than the actor must be a real, ACTIVE user who can access
 * the Building. Without this, a failure could be attributed to an arbitrary or
 * deactivated account, or used to probe which user ids exist.
 */
async function resolveReporter(
  reportedByUserId: string | undefined,
  actorUserId: string,
  buildingId: string,
): Promise<string> {
  if (!reportedByUserId || reportedByUserId === actorUserId) {
    return actorUserId;
  }
  const reporter = await userRepository.findById(reportedByUserId);
  if (!reporter || reporter.status !== 'ACTIVE') {
    throw assetFailureReporterInvalidError();
  }
  if (!(await contextAccessService.canAccessBuilding(reporter.id, buildingId))) {
    throw assetFailureReporterInvalidError();
  }
  return reporter.id;
}

/**
 * Validates the Incident's own BE-04 location against the Asset's
 * AUTHORITATIVE BE-05C location, when the Asset asserts one.
 *
 * An Asset's Functional Location resolves (via BE-04H) to a full hierarchy
 * chain: Building → Floor → Area → Room → Space → Functional Location. The
 * Incident may be recorded at ANY level of that chain, so the check compares
 * like with like: the Incident's declared level is matched against the SAME
 * level of the Asset's chain.
 *
 * Crucially, validation only applies to levels the Asset actually asserts. An
 * Asset pinned only at Building level (no Functional Location, or one with no
 * Space) is not authoritative about Floors or Rooms, so an Incident may
 * legitimately be more specific than the Asset. Rejecting that would force
 * callers to omit real location detail — the rule is "validate where the Asset
 * is authoritative", not "the Incident must match exactly".
 */
async function assertAssetLocationConsistency(
  asset: AssetRecord,
  location: ResolvedLocation,
): Promise<void> {
  if (!asset.functionalLocationId || !location.locationType) return;

  const context = await resolveFunctionalLocationContext(
    asset.functionalLocationId,
  );

  // The Asset's authoritative id at each hierarchy level, where it has one.
  const authoritative: Record<IncidentLocationType, string | undefined> = {
    FLOOR: context.floor?.id,
    AREA: context.area?.id,
    ROOM: context.room?.id,
    SPACE: context.space?.id,
    FUNCTIONAL_LOCATION: context.functionalLocation?.id,
  };

  const incidentIds: Record<IncidentLocationType, string | null> = {
    FLOOR: location.floorId,
    AREA: location.areaId,
    ROOM: location.roomId,
    SPACE: location.spaceId,
    FUNCTIONAL_LOCATION: location.functionalLocationId,
  };

  const level = location.locationType;
  const assetId = authoritative[level];
  // The Asset says nothing at this granularity — nothing to contradict.
  if (!assetId) return;

  if (assetId !== incidentIds[level]) {
    throw assetFailureAssetLocationMismatchError(
      `The Incident ${level.toLowerCase().replace('_', ' ')} does not match the Asset's authoritative location.`,
    );
  }
}

/**
 * Resolves and validates the BE-05 Asset binding.
 *
 * Order matters and is pinned by tests:
 *   1. unknown Asset            → 404 ASSET_NOT_FOUND
 *   2. different Client         → 400 (tenancy breach, reported distinctly)
 *   3. different Building       → 400
 *   4. RETIRED Asset            → 400
 *
 * The Client check precedes the Building check so a cross-tenant reference is
 * always reported as such, even though a different Client always implies a
 * different Building.
 */
async function resolveAsset(
  assetId: string,
  clientId: string,
  buildingId: string,
): Promise<AssetRecord> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) throw assetNotFoundError();
  if (asset.clientId !== clientId) {
    throw assetFailureAssetClientMismatchError();
  }
  if (asset.buildingId !== buildingId) {
    throw assetFailureAssetBuildingMismatchError();
  }
  // INACTIVE and UNDER_MAINTENANCE Assets may legitimately accrue defects;
  // only a RETIRED (terminal) Asset is closed to new failure records.
  if (asset.status === 'RETIRED') {
    throw assetFailureAssetRetiredError();
  }
  return asset;
}

function resolveLocationId(record: AssetFailureCompositeRecord): string | null {
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
 * Backend-authoritative available actions: state × permission × the BE-21A
 * record lifecycle. A CANCELLED Incident yields no actions at all, so the
 * foundation stays authoritative over the specialization.
 */
function resolveAvailableActions(
  record: AssetFailureCompositeRecord,
  permissions: Set<string>,
): AssetFailureAction[] {
  if (record.incidentStatus !== 'REPORTED') return [];
  if (!permissions.has('asset_failure.manage')) return [];

  return [
    'UPDATE_DETAILS',
    ...assetFailureTransitionActions(record.failureStatus),
  ];
}

export function toPublicAssetFailure(
  record: AssetFailureCompositeRecord,
  availableActions: AssetFailureAction[],
): PublicAssetFailure {
  return {
    id: record.incidentId,
    assetFailureId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    incidentNumber: record.incidentNumber,
    incidentType: 'ASSET_FAILURE',
    title: record.title,
    description: record.description,
    severity: record.severity,
    priority: record.priority,
    incidentStatus: record.incidentStatus,
    failureStatus: record.failureStatus,
    failureCategory: record.failureCategory,
    operationalImpact: record.operationalImpact,
    occurredAt: record.occurredAt.toISOString(),
    statusChangedAt: record.statusChangedAt.toISOString(),
    notes: record.notes,
    locationType: record.locationType,
    locationId: resolveLocationId(record),
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    spaceId: record.spaceId,
    functionalLocationId: record.functionalLocationId,
    reportedByUserId: record.reportedByUserId,
    reportedAt: record.reportedAt.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    // A read-only projection of the live BE-05 registry, never a copy.
    asset: {
      id: record.assetId,
      assetCode: record.assetCode,
      assetName: record.assetName,
      status: record.assetStatus,
      buildingId: record.assetBuildingId,
      functionalLocationId: record.assetFunctionalLocationId,
    },
    availableActions,
  };
}

async function present(
  record: AssetFailureCompositeRecord,
  actorUserId: string,
): Promise<PublicAssetFailure> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return toPublicAssetFailure(
    record,
    resolveAvailableActions(record, permissions),
  );
}

export async function createAssetFailure(
  input: CreateAssetFailureInput,
  actorUserId: string,
): Promise<PublicAssetFailure> {
  // Reuses BE-21A's Client derivation + Building access assertion verbatim.
  const { clientId } = await resolveBuildingContext(
    input.buildingId,
    actorUserId,
  );
  const location = await resolveLocation(
    input.locationType,
    input.locationId,
    input.buildingId,
  );
  const asset = await resolveAsset(input.assetId, clientId, input.buildingId);
  await assertAssetLocationConsistency(asset, location);
  assertOccurrence(input.occurredAt);
  const reportedByUserId = await resolveReporter(
    input.reportedByUserId,
    actorUserId,
    input.buildingId,
  );

  const existing = await incidentRepository.findByClientAndNumber(
    clientId,
    input.incidentNumber,
  );
  if (existing) throw incidentNumberAlreadyExistsError();

  try {
    // Foundation + specialization are atomic: no orphan Incident on failure.
    const incidentId = await withTransaction(async (client) => {
      const incident = await incidentRepository.create(
        {
          clientId,
          buildingId: input.buildingId,
          incidentNumber: input.incidentNumber,
          // BE-21C always pins the discriminator; callers cannot set it.
          incidentType: 'ASSET_FAILURE',
          title: input.title,
          description: input.description ?? null,
          severity: input.severity ?? 'MEDIUM',
          priority: input.priority ?? 'MEDIUM',
          ...location,
          reportedByUserId,
          reportedAt: new Date(),
        },
        client,
      );
      await assetFailureRepository.create(
        {
          incidentId: incident.id,
          assetId: asset.id,
          failureCategory: input.failureCategory,
          occurredAt: input.occurredAt,
          operationalImpact: input.operationalImpact ?? null,
          notes: input.notes ?? null,
          createdByUserId: actorUserId,
        },
        client,
      );
      return incident.id;
    });

    const created = await assetFailureRepository.findByIncidentId(incidentId);
    if (!created) throw assetFailureNotFoundError();

    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      entityType: 'INCIDENT',
      entityId: created.incidentId,
      eventType: 'ASSET_FAILURE_REPORTED',
      actorUserId,
      summary: `Asset Failure ${created.incidentNumber} reported for asset ${created.assetCode}`,
      metadata: {
        incidentNumber: created.incidentNumber,
        assetId: created.assetId,
        assetCode: created.assetCode,
        failureCategory: created.failureCategory,
        operationalImpact: created.operationalImpact,
        severity: created.severity,
        priority: created.priority,
        occurredAt: created.occurredAt.toISOString(),
      },
    });
    return present(created, actorUserId);
  } catch (error) {
    if (isIncidentNumberUniqueViolation(error)) {
      throw incidentNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getAssetFailure(
  incidentId: string,
  actorUserId: string,
): Promise<PublicAssetFailure> {
  const record = await assetFailureRepository.findByIncidentId(incidentId);
  if (!record) throw assetFailureNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return present(record, actorUserId);
}

export async function listAssetFailures(
  filters: AssetFailureFilters,
  actorUserId: string,
): Promise<PublicAssetFailure[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await assetFailureRepository.list(filters, buildingIds);
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return records.map((record) =>
    toPublicAssetFailure(record, resolveAvailableActions(record, permissions)),
  );
}

/**
 * Updates failure details and, where supplied, the foundation metadata —
 * atomically. The BE-21A lifecycle gates the whole operation: once the
 * Incident is CANCELLED nothing may change. The Asset binding is immutable.
 */
export async function updateAssetFailure(
  incidentId: string,
  input: UpdateAssetFailureInput,
  actorUserId: string,
): Promise<PublicAssetFailure> {
  const existing = await assetFailureRepository.findByIncidentId(incidentId);
  if (!existing) throw assetFailureNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.incidentStatus !== 'REPORTED') {
    throw assetFailureUpdateNotAllowedError();
  }
  if (input.occurredAt !== undefined) assertOccurrence(input.occurredAt);

  const nextStatus = input.failureStatus;
  if (
    nextStatus !== undefined &&
    nextStatus !== existing.failureStatus &&
    !canTransitionAssetFailureStatus(existing.failureStatus, nextStatus)
  ) {
    throw assetFailureInvalidTransitionError(existing.failureStatus, nextStatus);
  }

  await withTransaction(async (client) => {
    const foundation = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };
    if (Object.keys(foundation).length > 0) {
      // BE-21A's own guarded update — it refuses anything not REPORTED.
      const updated = await incidentRepository.updateReported(
        incidentId,
        foundation,
        client,
      );
      if (!updated) throw assetFailureUpdateNotAllowedError();
    }

    await assetFailureRepository.update(
      incidentId,
      {
        ...(input.failureCategory !== undefined
          ? { failureCategory: input.failureCategory }
          : {}),
        ...(input.occurredAt !== undefined
          ? { occurredAt: input.occurredAt }
          : {}),
        ...(input.operationalImpact !== undefined
          ? { operationalImpact: input.operationalImpact }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      client,
    );

    if (nextStatus !== undefined && nextStatus !== existing.failureStatus) {
      const moved = await assetFailureRepository.transitionStatus(
        incidentId,
        existing.failureStatus,
        nextStatus,
        client,
      );
      if (!moved) {
        throw assetFailureInvalidTransitionError(
          existing.failureStatus,
          nextStatus,
        );
      }
    }
  });

  const updated = await assetFailureRepository.findByIncidentId(incidentId);
  if (!updated) throw assetFailureNotFoundError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'INCIDENT',
    entityId: updated.incidentId,
    eventType:
      nextStatus !== undefined && nextStatus !== existing.failureStatus
        ? 'ASSET_FAILURE_STATUS_CHANGED'
        : 'ASSET_FAILURE_UPDATED',
    actorUserId,
    summary: `Asset Failure ${updated.incidentNumber} updated`,
    metadata: {
      assetId: updated.assetId,
      fields: Object.keys(input),
      ...(nextStatus !== undefined && nextStatus !== existing.failureStatus
        ? {
            fromFailureStatus: existing.failureStatus,
            toFailureStatus: nextStatus,
          }
        : {}),
    },
  });
  return present(updated, actorUserId);
}

export { assetFailureTypeMismatchError };

export const assetFailureService = {
  createAssetFailure,
  getAssetFailure,
  listAssetFailures,
  toPublicAssetFailure,
  updateAssetFailure,
};
