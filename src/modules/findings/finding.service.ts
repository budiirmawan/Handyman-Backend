import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  findingClassificationClientMismatchError,
  findingClassificationInactiveError,
  findingClassificationNotFoundError,
  findingClassificationRepository,
} from '../finding-classifications';
import {
  findingSeverityClientMismatchError,
  findingSeverityInactiveError,
  findingSeverityNotFoundError,
  findingSeverityRepository,
} from '../finding-severities';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { resolveBuildingClientId } from '../shifts';
import { userNotFoundError, userRepository } from '../users';
import { recordFindingEvent } from '../finding-history/finding-history.service';
import {
  findingBuildingClientMismatchError,
  findingNotFoundError,
  findingNotOpenError,
  findingNumberAlreadyExistsError,
} from './finding.errors';
import { findingRepository } from './finding.repository';
import type {
  CreateFindingInput,
  FindingFilters,
  FindingRecord,
  NewFinding,
  PublicFinding,
  UpdateFindingInput,
} from './finding.types';

export function toPublicFinding(record: FindingRecord): PublicFinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    findingNumber: record.findingNumber,
    title: record.title,
    description: record.description,
    classificationId: record.classificationId,
    severityId: record.severityId,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    status: record.status,
    stateChangedAt: record.stateChangedAt.toISOString(),
    reportedByUserId: record.reportedByUserId,
    reportedAt: record.reportedAt.toISOString(),
    closedAt: record.closedAt?.toISOString() ?? null,
    closedByUserId: record.closedByUserId,
    closureNotes: record.closureNotes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function createFinding(
  input: CreateFindingInput,
): Promise<PublicFinding> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) throw clientNotFoundError();
  if (client.status !== 'ACTIVE') throw clientInactiveError();

  const buildingClientId = await resolveBuildingClientId(input.buildingId);
  if (buildingClientId !== input.clientId) {
    throw findingBuildingClientMismatchError();
  }

  const reporter = await userRepository.findById(input.reportedByUserId);
  if (!reporter) throw userNotFoundError();

  const existing = await findingRepository.findByNumberForClient(
    input.clientId,
    input.findingNumber,
  );
  if (existing) throw findingNumberAlreadyExistsError();

  const finding: NewFinding = {
    clientId: input.clientId,
    buildingId: input.buildingId,
    findingNumber: input.findingNumber,
    title: input.title,
    description: input.description?.trim() || null,
    reportedByUserId: input.reportedByUserId,
  };

  try {
    const record = await findingRepository.create(finding);
    await recordFindingEvent({
      findingId: record.id,
      clientId: record.clientId,
      buildingId: record.buildingId,
      eventType: 'FINDING_CREATED',
      actorUserId: input.reportedByUserId,
      summary: 'Finding created',
      metadata: { findingNumber: record.findingNumber },
    });
    return toPublicFinding(record);
  } catch (error) {
    if (isFindingNumberUniqueViolation(error)) {
      throw findingNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getFindingById(id: string): Promise<PublicFinding> {
  const record = await findingRepository.findById(id);
  if (!record) throw findingNotFoundError();
  return toPublicFinding(record);
}

export async function listFindingsByBuilding(
  buildingId: string,
  filters: FindingFilters,
): Promise<PublicFinding[]> {
  if (!(await buildingRepository.findById(buildingId))) {
    throw buildingNotFoundError();
  }
  return (await findingRepository.listByBuilding(buildingId, filters)).map(
    toPublicFinding,
  );
}

export async function updateFinding(
  id: string,
  input: UpdateFindingInput,
  actorUserId?: string,
): Promise<PublicFinding> {
  const existing = await findingRepository.findById(id);
  if (!existing) throw findingNotFoundError();
  if (existing.status !== 'OPEN') throw findingNotOpenError();

  if (input.classificationId) {
    const classification = await findingClassificationRepository.findById(
      input.classificationId,
    );
    if (!classification) throw findingClassificationNotFoundError();
    if (classification.clientId !== existing.clientId) {
      throw findingClassificationClientMismatchError();
    }
    if (classification.status !== 'ACTIVE') {
      throw findingClassificationInactiveError();
    }
  }
  if (input.severityId) {
    const severity = await findingSeverityRepository.findById(input.severityId);
    if (!severity) throw findingSeverityNotFoundError();
    if (severity.clientId !== existing.clientId) {
      throw findingSeverityClientMismatchError();
    }
    if (severity.status !== 'ACTIVE') throw findingSeverityInactiveError();
  }

  const updated = (await findingRepository.update(id, input)) as FindingRecord;
  if (
    input.classificationId !== undefined &&
    input.classificationId !== existing.classificationId
  ) {
    await recordFindingEvent({
      findingId: existing.id,
      clientId: existing.clientId,
      buildingId: existing.buildingId,
      eventType: 'FINDING_CLASSIFICATION_CHANGED',
      actorUserId,
      summary: 'Finding classification changed',
      metadata: {
        fromClassificationId: existing.classificationId,
        toClassificationId: updated.classificationId,
      },
    });
  }
  if (input.severityId !== undefined && input.severityId !== existing.severityId) {
    await recordFindingEvent({
      findingId: existing.id,
      clientId: existing.clientId,
      buildingId: existing.buildingId,
      eventType: 'FINDING_SEVERITY_CHANGED',
      actorUserId,
      summary: 'Finding severity changed',
      metadata: {
        fromSeverityId: existing.severityId,
        toSeverityId: updated.severityId,
      },
    });
  }
  return toPublicFinding(updated);
}

export async function cancelFinding(
  id: string,
  actorUserId?: string,
): Promise<PublicFinding> {
  const existing = await findingRepository.findById(id);
  if (!existing) throw findingNotFoundError();
  if (existing.status !== 'OPEN') throw findingNotOpenError();
  const updated = (await findingRepository.updateStatus(
    id,
    'CANCELLED',
  )) as FindingRecord;
  await recordFindingEvent({
    findingId: existing.id,
    clientId: existing.clientId,
    buildingId: existing.buildingId,
    eventType: 'FINDING_CANCELLED',
    actorUserId,
    summary: 'Finding cancelled',
    metadata: { fromState: existing.status, toState: 'CANCELLED' },
  });
  return toPublicFinding(updated);
}

function isFindingNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'finding_number_unique';
}

export const findingService = {
  cancelFinding,
  createFinding,
  getFindingById,
  listFindingsByBuilding,
  toPublicFinding,
  updateFinding,
};
