import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { serviceCatalogRepository, serviceCatalogNotFoundError } from '../service-catalog';
import { skillNotFoundError, skillRepository } from '../skills';
import {
  competencyRequirementAlreadyExistsError,
  competencyRequirementInvalidStateError,
  competencyRequirementNotFoundError,
  competencyRequirementServiceInactiveError,
  competencyRequirementSkillMismatchError,
} from './service-competency-requirement.errors';
import { serviceCompetencyRequirementRepository } from './service-competency-requirement.repository';
import type {
  CompetencyRequirementChanges,
  CompetencyRequirementRecord,
  ListCompetencyRequirementsFilter,
  NewCompetencyRequirement,
  PublicCompetencyRequirement,
} from './service-competency-requirement.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — competency requirement commands/reads.
 *
 * Governance:
 *   1. Requirements are OPTIONAL. Nothing here creates one implicitly, and no
 *      default requirement set is seeded. A job type with no rows keeps the
 *      pre-PART-03A assignment behaviour exactly.
 *   2. Client isolation: the catalog entry is the authority for `clientId`; the
 *      caller must be able to reach that Client through their own Building
 *      assignments (`contextAccessService`, the same rule the rest of the
 *      catalog uses). A broad permission never widens Client reach.
 *   3. The requirement's skill must belong to the same Client as the entry, and
 *      the database trigger (0463) enforces the same rule structurally.
 *   4. Deactivation is terminal for enforcement but keeps the row: assignments
 *      that were validated against it stay explainable.
 */

function toPublic(
  record: CompetencyRequirementRecord,
): PublicCompetencyRequirement {
  return {
    id: record.id,
    clientId: record.clientId,
    serviceCatalogId: record.serviceCatalogId,
    requirementType: record.requirementType,
    enforcementLevel: record.enforcementLevel,
    skillId: record.skillId,
    skill: record.skill,
    minimumProficiencyLevel: record.minimumProficiencyLevel,
    certificateName: record.certificateName,
    notes: record.notes,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : String(record.createdAt),
    updatedAt:
      record.updatedAt instanceof Date
        ? record.updatedAt.toISOString()
        : String(record.updatedAt),
  };
}

export function toPublicCompetencyRequirement(
  record: CompetencyRequirementRecord,
): PublicCompetencyRequirement {
  return toPublic(record);
}

async function requireEntry(serviceCatalogId: string) {
  const entry = await serviceCatalogRepository.findById(undefined, serviceCatalogId);
  if (!entry) throw serviceCatalogNotFoundError();
  return entry;
}

async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
  return;
}

function metadata(
  record: CompetencyRequirementRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    serviceCatalogId: record.serviceCatalogId,
    requirementType: record.requirementType,
    enforcementLevel: record.enforcementLevel,
    skillId: record.skillId,
    minimumProficiencyLevel: record.minimumProficiencyLevel,
    certificateName: record.certificateName,
    status: record.status,
    clientId: record.clientId,
    ...extra,
  };
}

export async function createCompetencyRequirement(
  serviceCatalogId: string,
  input: NewCompetencyRequirement,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const entry = await requireEntry(serviceCatalogId);
  await assertClientAccess(actorUserId, entry.clientId);

  if (entry.status !== 'ACTIVE') {
    throw competencyRequirementServiceInactiveError();
  }

  if (input.skillId) {
    const skill = await skillRepository.findById(input.skillId);
    if (!skill) throw skillNotFoundError();
    if (skill.clientId !== entry.clientId) {
      throw competencyRequirementSkillMismatchError();
    }
  }

  const duplicate =
    input.requirementType === 'SKILL'
      ? await serviceCompetencyRequirementRepository.findActiveSkillRequirement(
          undefined,
          { serviceCatalogId, skillId: input.skillId as string },
        )
      : await serviceCompetencyRequirementRepository
          .findActiveCertificationRequirement(undefined, {
            serviceCatalogId,
            certificateName: input.certificateName as string,
          });
  if (duplicate) throw competencyRequirementAlreadyExistsError();

  return withTransaction(async (tx) => {
    const created = await serviceCompetencyRequirementRepository.insertRequirement(
      tx,
      { ...input, clientId: entry.clientId, serviceCatalogId },
    );
    await recordOperationalEvent(
      {
        clientId: created.clientId,
        eventType: 'SERVICE_COMPETENCY_REQUIREMENT_CREATED',
        entityType: 'SERVICE_COMPETENCY_REQUIREMENT',
        entityId: created.id,
        actorUserId,
        summary:
          `Competency requirement (${created.requirementType}, ` +
          `${created.enforcementLevel}) added to service catalog entry ` +
          `${entry.code}.`,
        metadata: metadata(created),
      },
      tx,
    );
    return toPublic(created);
  });
}

export async function listCompetencyRequirements(
  serviceCatalogId: string,
  filter: ListCompetencyRequirementsFilter,
  actorUserId: string,
): Promise<PublicCompetencyRequirement[]> {
  const entry = await requireEntry(serviceCatalogId);
  await assertClientAccess(actorUserId, entry.clientId);
  const records =
    await serviceCompetencyRequirementRepository.listByServiceCatalog(
      undefined,
      { clientId: entry.clientId, serviceCatalogId },
      filter,
    );
  return records.map(toPublic);
}

export async function getCompetencyRequirement(
  serviceCatalogId: string,
  requirementId: string,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const entry = await requireEntry(serviceCatalogId);
  await assertClientAccess(actorUserId, entry.clientId);
  const record = await serviceCompetencyRequirementRepository.findScopedById(
    undefined,
    { id: requirementId, serviceCatalogId, clientId: entry.clientId },
  );
  if (!record) throw competencyRequirementNotFoundError();
  return toPublic(record);
}

export async function updateCompetencyRequirement(
  serviceCatalogId: string,
  requirementId: string,
  changes: CompetencyRequirementChanges,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const entry = await requireEntry(serviceCatalogId);
  await assertClientAccess(actorUserId, entry.clientId);
  const existing = await serviceCompetencyRequirementRepository.findScopedById(
    undefined,
    { id: requirementId, serviceCatalogId, clientId: entry.clientId },
  );
  if (!existing) throw competencyRequirementNotFoundError();
  if (existing.status !== 'ACTIVE') {
    throw competencyRequirementInvalidStateError(
      'An INACTIVE competency requirement can no longer be modified.',
    );
  }

  return withTransaction(async (tx) => {
    const updated = await serviceCompetencyRequirementRepository.updateRequirement(
      tx,
      requirementId,
      changes,
    );
    if (!updated) throw competencyRequirementNotFoundError();
    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        eventType: 'SERVICE_COMPETENCY_REQUIREMENT_UPDATED',
        entityType: 'SERVICE_COMPETENCY_REQUIREMENT',
        entityId: updated.id,
        actorUserId,
        summary:
          `Competency requirement updated on service catalog entry ${entry.code}.`,
        metadata: metadata(updated, { changedFields: Object.keys(changes) }),
      },
      tx,
    );
    return toPublic(updated);
  });
}

export async function deactivateCompetencyRequirement(
  serviceCatalogId: string,
  requirementId: string,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const entry = await requireEntry(serviceCatalogId);
  await assertClientAccess(actorUserId, entry.clientId);
  const existing = await serviceCompetencyRequirementRepository.findScopedById(
    undefined,
    { id: requirementId, serviceCatalogId, clientId: entry.clientId },
  );
  if (!existing) throw competencyRequirementNotFoundError();
  if (existing.status !== 'ACTIVE') {
    throw competencyRequirementInvalidStateError(
      'The competency requirement is already INACTIVE.',
    );
  }

  return withTransaction(async (tx) => {
    const deactivated =
      await serviceCompetencyRequirementRepository.deactivateRequirement(
        tx,
        requirementId,
      );
    if (!deactivated) {
      throw competencyRequirementInvalidStateError(
        'The competency requirement is already INACTIVE.',
      );
    }
    await recordOperationalEvent(
      {
        clientId: deactivated.clientId,
        eventType: 'SERVICE_COMPETENCY_REQUIREMENT_DEACTIVATED',
        entityType: 'SERVICE_COMPETENCY_REQUIREMENT',
        entityId: deactivated.id,
        actorUserId,
        summary:
          `Competency requirement deactivated on service catalog entry ` +
          `${entry.code}; it no longer applies to new assignments.`,
        metadata: metadata(deactivated),
      },
      tx,
    );
    return toPublic(deactivated);
  });
}

export const serviceCompetencyRequirementService = {
  createCompetencyRequirement,
  deactivateCompetencyRequirement,
  getCompetencyRequirement,
  listCompetencyRequirements,
  updateCompetencyRequirement,
};
