import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import {
  assetNotFoundError,
  assetRepository,
  resolveAssetBuildingContext,
} from '../assets';
import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  findingActionService,
  findingService,
  findingSourceService,
  type PublicFinding,
} from '../findings';
import { assignFinding } from '../finding-assignments/finding-assignment.service';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import {
  engineeringFindingAlreadyLinkedError,
  engineeringFindingAssetBuildingMismatchError,
  engineeringFindingBuildingMismatchError,
  engineeringFindingLocationBuildingMismatchError,
  engineeringFindingNotFoundError,
  engineeringFindingSourceAlreadyLinkedError,
  engineeringFindingSourceNoBuildingError,
} from './engineering-finding.errors';
import {
  engineeringFindingRepository,
  type EngineeringFindingListRow,
} from './engineering-finding.repository';
import {
  type CreateEngineeringFindingInput,
  type EngineeringFindingLinkRecord,
  type EngineeringFindingListFilters,
  type PublicEngineeringFinding,
} from './engineering-finding.types';

/**
 * BE-10H — Engineering Finding Binding service.
 *
 * Creates / links BE-09 Findings from Engineering operational sources and
 * resolves their Engineering context. Everything Finding-related stays
 * BE-09: creation (`findingService.createFinding`), classification/severity
 * (`findingService.updateFinding`), source binding
 * (`findingSourceService.updateFindingSource`), assignment (`assignFinding`),
 * and workflow actions (`findingActionService.resolveAvailableActions`) —
 * the backend remains the sole authority for available actions.
 */
export async function createEngineeringFinding(
  input: CreateEngineeringFindingInput,
  userId: string,
): Promise<PublicEngineeringFinding> {
  const building = await buildingService.getBuildingById(input.buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  const { clientId } = await resolveAssetBuildingContext(building.id);

  if (input.findingId) {
    return linkExistingFinding(input, clientId, userId);
  }

  // Engineering source validation: the source must exist and resolve to the
  // same Building (which also rejects every cross-Client source).
  if (input.sourceType && input.sourceId) {
    await assertEngineeringSource(
      input.sourceType,
      input.sourceId,
      building.id,
      clientId,
    );
  }

  const assetId = await assertAssetContext(input.assetId ?? null, building.id);
  const functionalLocationId = await assertLocationContext(
    input.functionalLocationId ?? null,
    building.id,
  );

  let finding = await findingService.createFinding({
    clientId,
    buildingId: building.id,
    findingNumber: `ENG_${randomUUID().slice(0, 8).toUpperCase()}`,
    title: input.title as string,
    description: input.description,
    reportedByUserId: userId,
  });

  // BE-09 owns classification / severity validation and history.
  if (input.classificationId || input.severityId) {
    finding = await findingService.updateFinding(
      finding.id,
      {
        ...(input.classificationId ? { classificationId: input.classificationId } : {}),
        ...(input.severityId ? { severityId: input.severityId } : {}),
      },
      userId,
    );
  }

  // BE-09 owns the source binding (with its own client/building assertions).
  if (input.sourceType && input.sourceId) {
    await findingSourceService.updateFindingSource(
      finding.id,
      { sourceType: input.sourceType, sourceId: input.sourceId },
      userId,
    );
  }

  const link = await createLink(
    {
      clientId,
      buildingId: building.id,
      findingId: finding.id,
      assetId,
      functionalLocationId,
      operationType: input.operationType,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
    },
    userId,
  );

  // BE-09 owns assignment (workforce / team / vendor).
  if (input.assigneeType) {
    await assignFinding({
      findingId: finding.id,
      assigneeType: input.assigneeType,
      workforceProfileId: input.workforceProfileId,
      teamId: input.teamId,
      vendorId: input.vendorId,
      assignedByUserId: userId,
    });
  }

  // The authoritative finding reflects all BE-09 mutations applied above.
  finding = await findingService.getFindingById(finding.id);

  await recordOperationalEvent({
    clientId,
    eventType: 'ENGINEERING_FINDING_CREATED',
    entityType: 'ENGINEERING_FINDING_LINK',
    entityId: link.id,
    actorUserId: userId,
    buildingId: building.id,
    summary: `Engineering finding created for ${input.operationType.toLowerCase()}`,
    metadata: {
      findingId: finding.id,
      operationType: input.operationType,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      assetId,
    },
  });

  return resolveEngineeringFinding(link, finding, userId);
}

export async function getEngineeringFinding(
  id: string,
  userId: string,
): Promise<PublicEngineeringFinding> {
  const link = await engineeringFindingRepository.findById(id);
  if (!link) {
    throw engineeringFindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, link.buildingId);
  const finding = await findingService.getFindingById(link.findingId);
  return resolveEngineeringFinding(link, finding, userId);
}

export async function listEngineeringFindings(
  filters: EngineeringFindingListFilters,
  userId: string,
): Promise<PublicEngineeringFinding[]> {
  let buildingIds: string[];
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else if (filters.assetId) {
    const asset = await assetRepository.findById(filters.assetId);
    if (!asset) {
      throw assetNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
    buildingIds = [asset.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const rows = await engineeringFindingRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return Promise.all(rows.map((row) => resolveEngineeringFindingRow(row, userId)));
}

/** Links an existing BE-09 Finding (created through BE-09's own flow). */
async function linkExistingFinding(
  input: CreateEngineeringFindingInput,
  clientId: string,
  userId: string,
): Promise<PublicEngineeringFinding> {
  const finding = await findingService.getFindingById(input.findingId as string);
  if (finding.buildingId !== input.buildingId || finding.clientId !== clientId) {
    throw engineeringFindingBuildingMismatchError();
  }

  const existingLink = await engineeringFindingRepository.findByFindingId(
    finding.id,
  );
  if (existingLink) {
    throw engineeringFindingAlreadyLinkedError();
  }

  const assetId = await assertAssetContext(input.assetId ?? null, finding.buildingId);
  const functionalLocationId = await assertLocationContext(
    input.functionalLocationId ?? null,
    finding.buildingId,
  );

  const link = await createLink(
    {
      clientId,
      buildingId: finding.buildingId,
      findingId: finding.id,
      assetId,
      functionalLocationId,
      operationType: input.operationType,
      sourceType: finding.sourceType ?? null,
      sourceId: finding.sourceId ?? null,
    },
    userId,
  );

  await recordOperationalEvent({
    clientId,
    eventType: 'ENGINEERING_FINDING_LINKED',
    entityType: 'ENGINEERING_FINDING_LINK',
    entityId: link.id,
    actorUserId: userId,
    buildingId: finding.buildingId,
    summary: `Engineering finding context linked to finding ${finding.findingNumber}`,
    metadata: { findingId: finding.id, operationType: input.operationType },
  });

  return resolveEngineeringFinding(link, finding, userId);
}

async function createLink(
  input: {
    clientId: string;
    buildingId: string;
    findingId: string;
    assetId: string | null;
    functionalLocationId: string | null;
    operationType: CreateEngineeringFindingInput['operationType'];
    sourceType: NonNullable<CreateEngineeringFindingInput['sourceType']> | null;
    sourceId: string | null;
  },
  userId: string,
): Promise<EngineeringFindingLinkRecord> {
  try {
    return await engineeringFindingRepository.create({
      ...input,
      createdByUserId: userId,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'engineering_finding_source_unique')) {
      throw engineeringFindingSourceAlreadyLinkedError();
    }
    if (isUniqueViolation(error, 'engineering_finding_links_finding_id_key')) {
      throw engineeringFindingAlreadyLinkedError();
    }
    throw error;
  }
}

/**
 * The Engineering source must exist (through BE-07/BE-08 records) and
 * resolve to the requested Building / Client. Plain BE-07 executions with no
 * Engineering binding resolve no Building and are rejected.
 */
async function assertEngineeringSource(
  sourceType: CreateEngineeringFindingInput['sourceType'],
  sourceId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const context = await engineeringFindingRepository.resolveSourceContext(
    sourceType as NonNullable<typeof sourceType>,
    sourceId,
  );
  if (!context) {
    throw AppError.notFound('Engineering source not found.');
  }
  if (context.buildingId === null) {
    throw engineeringFindingSourceNoBuildingError();
  }
  if (context.buildingId !== buildingId || context.clientId !== clientId) {
    throw engineeringFindingBuildingMismatchError();
  }

  const existing = await engineeringFindingRepository.findBySource(
    sourceType as NonNullable<typeof sourceType>,
    sourceId,
  );
  if (existing) {
    throw engineeringFindingSourceAlreadyLinkedError();
  }
}

/** The Asset context must belong to the Finding's Building. */
async function assertAssetContext(
  assetId: string | null,
  buildingId: string,
): Promise<string | null> {
  if (assetId === null) {
    return null;
  }
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  if (asset.buildingId !== buildingId) {
    throw engineeringFindingAssetBuildingMismatchError();
  }
  return asset.id;
}

/** The Functional Location context must belong to the Finding's Building. */
async function assertLocationContext(
  functionalLocationId: string | null,
  buildingId: string,
): Promise<string | null> {
  if (functionalLocationId === null) {
    return null;
  }
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) {
    throw functionalLocationNotFoundError();
  }
  if (location.buildingId !== buildingId) {
    throw engineeringFindingLocationBuildingMismatchError();
  }
  return location.id;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

/** BE-09 backend-authoritative available actions for the Finding. */
async function resolveAvailableActions(
  findingId: string,
  userId: string,
): Promise<import('../findings').FindingAction[]> {
  const result = await findingActionService.resolveAvailableActions(
    findingId,
    { userId },
  );
  return result.availableActions;
}

async function resolveEngineeringFinding(
  link: EngineeringFindingLinkRecord,
  finding: PublicFinding,
  userId: string,
): Promise<PublicEngineeringFinding> {
  return {
    id: link.id,
    clientId: link.clientId,
    buildingId: link.buildingId,
    findingId: link.findingId,
    assetId: link.assetId,
    functionalLocationId: link.functionalLocationId,
    operationType: link.operationType,
    sourceType: link.sourceType,
    sourceId: link.sourceId,
    createdAt: link.createdAt.toISOString(),
    finding,
    availableActions: await resolveAvailableActions(finding.id, userId),
  };
}

async function resolveEngineeringFindingRow(
  row: EngineeringFindingListRow,
  userId: string,
): Promise<PublicEngineeringFinding> {
  const finding: PublicFinding = {
    id: row.f_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingNumber: row.f_finding_number,
    title: row.f_title,
    description: row.f_description,
    classificationId: row.f_classification_id,
    severityId: row.f_severity_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.f_status as PublicFinding['status'],
    stateChangedAt: row.f_state_changed_at.toISOString(),
    reportedByUserId: row.f_reported_by_user_id,
    reportedAt: row.f_reported_at.toISOString(),
    closedAt: row.f_closed_at ? row.f_closed_at.toISOString() : null,
    closedByUserId: row.f_closed_by_user_id,
    closureNotes: row.f_closure_notes,
    createdAt: row.f_created_at.toISOString(),
    updatedAt: row.f_updated_at.toISOString(),
  };
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingId: row.finding_id,
    assetId: row.asset_id,
    functionalLocationId: row.functional_location_id,
    operationType: row.operation_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at.toISOString(),
    finding,
    availableActions: await resolveAvailableActions(row.finding_id, userId),
  };
}

export const engineeringFindingService = {
  createEngineeringFinding,
  getEngineeringFinding,
  listEngineeringFindings,
};
