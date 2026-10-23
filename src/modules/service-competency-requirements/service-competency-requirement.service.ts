import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { serviceCatalogRepository, serviceCatalogNotFoundError } from '../service-catalog';
import { skillNotFoundError, skillRepository } from '../skills';
// Direct imports: the trade registry's service imports the Work Order
// assignment types, so its module index must not be pulled in here.
import { workOrderTradeCategoryNotFoundError } from '../work-order-trade-categories/work-order-trade-category.errors';
import { workOrderTradeCategoryRepository } from '../work-order-trade-categories/work-order-trade-category.repository';
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
  CompetencyRequirementTarget,
  ListCompetencyRequirementsFilter,
  NewCompetencyRequirement,
  PublicCompetencyRequirement,
} from './service-competency-requirement.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A/03B2A — competency requirement
 * commands/reads.
 *
 * ONE model, TWO targets (since 0465):
 *   - a Service Catalog entry — the Handyman "job type" (PART 03A);
 *   - a Work Order TRADE CATEGORY — the multi-trade Work Order path
 *     (PART 03B2A), which deliberately does NOT require a Service Catalog.
 *
 * Governance:
 *   1. Requirements are OPTIONAL. Nothing here creates one implicitly, and no
 *      default requirement set is seeded — so a trade category (or job type)
 *      with no rows keeps the pre-CR assignment behaviour exactly.
 *   2. Client isolation: the work is always scoped to ONE Client, and the
 *      caller must be able to reach that Client through their own Building
 *      assignments (`contextAccessService`). A catalogue entry supplies that
 *      Client; a trade category is a platform-wide registry, so the Client is
 *      supplied explicitly AND verified against the caller's reach — a broad
 *      permission never widens it.
 *   3. The requirement's skill must belong to the same Client as the target,
 *      and the database trigger enforces the same rule structurally.
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
    tradeCategoryId: record.tradeCategoryId,
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

/**
 * Everything the requirement commands need to know about the target: where the
 * rows are keyed, which Client owns them, and how they are described in the
 * audit event.
 */
type RequirementTargetContext = {
  target: CompetencyRequirementTarget;
  clientId: string;
  label: string;
  targetKind: 'SERVICE_CATALOG' | 'TRADE_CATEGORY';
  active: boolean;
};

async function catalogContext(
  serviceCatalogId: string,
  actorUserId: string,
): Promise<RequirementTargetContext> {
  const entry = await serviceCatalogRepository.findById(undefined, serviceCatalogId);
  if (!entry) throw serviceCatalogNotFoundError();
  await assertClientAccess(actorUserId, entry.clientId);
  return {
    target: { kind: 'SERVICE_CATALOG', serviceCatalogId },
    clientId: entry.clientId,
    label: entry.code,
    targetKind: 'SERVICE_CATALOG',
    active: entry.status === 'ACTIVE',
  };
}

async function tradeCategoryContext(
  tradeCategoryId: string,
  clientId: string,
  actorUserId: string,
): Promise<RequirementTargetContext> {
  const category = await workOrderTradeCategoryRepository.findById(
    undefined,
    tradeCategoryId,
  );
  if (!category) throw workOrderTradeCategoryNotFoundError();
  await assertClientAccess(actorUserId, clientId);
  return {
    target: { kind: 'TRADE_CATEGORY', tradeCategoryId },
    clientId,
    label: category.code,
    targetKind: 'TRADE_CATEGORY',
    active: category.status === 'ACTIVE',
  };
}

async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function metadata(
  record: CompetencyRequirementRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    serviceCatalogId: record.serviceCatalogId,
    tradeCategoryId: record.tradeCategoryId,
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

function describeTarget(context: RequirementTargetContext): string {
  return context.targetKind === 'SERVICE_CATALOG'
    ? `service catalog entry ${context.label}`
    : `work order trade category ${context.label}`;
}

async function createForTarget(
  context: RequirementTargetContext,
  input: NewCompetencyRequirement,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  if (!context.active) throw competencyRequirementServiceInactiveError();

  if (input.skillId) {
    const skill = await skillRepository.findById(input.skillId);
    if (!skill) throw skillNotFoundError();
    if (skill.clientId !== context.clientId) {
      throw competencyRequirementSkillMismatchError();
    }
  }

  const duplicate =
    input.requirementType === 'SKILL'
      ? await serviceCompetencyRequirementRepository.findActiveSkillRequirement(
          undefined,
          { target: context.target, skillId: input.skillId as string },
        )
      : await serviceCompetencyRequirementRepository
          .findActiveCertificationRequirement(undefined, {
            target: context.target,
            certificateName: input.certificateName as string,
          });
  if (duplicate) throw competencyRequirementAlreadyExistsError();

  return withTransaction(async (tx) => {
    const created = await serviceCompetencyRequirementRepository.insertRequirement(
      tx,
      {
        ...input,
        clientId: context.clientId,
        serviceCatalogId:
          context.target.kind === 'SERVICE_CATALOG'
            ? context.target.serviceCatalogId
            : null,
        tradeCategoryId:
          context.target.kind === 'TRADE_CATEGORY'
            ? context.target.tradeCategoryId
            : null,
      },
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
          `${created.enforcementLevel}) added to ${describeTarget(context)}.`,
        metadata: metadata(created, { targetKind: context.targetKind }),
      },
      tx,
    );
    return toPublic(created);
  });
}

async function listForTarget(
  context: RequirementTargetContext,
  filter: ListCompetencyRequirementsFilter,
): Promise<PublicCompetencyRequirement[]> {
  const records = await serviceCompetencyRequirementRepository.listByTarget(
    undefined,
    { clientId: context.clientId, target: context.target },
    filter,
  );
  return records.map(toPublic);
}

async function getForTarget(
  context: RequirementTargetContext,
  requirementId: string,
): Promise<PublicCompetencyRequirement> {
  const record = await serviceCompetencyRequirementRepository.findScopedById(
    undefined,
    {
      id: requirementId,
      clientId: context.clientId,
      target: context.target,
    },
  );
  if (!record) throw competencyRequirementNotFoundError();
  return toPublic(record);
}

async function updateForTarget(
  context: RequirementTargetContext,
  requirementId: string,
  changes: CompetencyRequirementChanges,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const existing = await serviceCompetencyRequirementRepository.findScopedById(
    undefined,
    {
      id: requirementId,
      clientId: context.clientId,
      target: context.target,
    },
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
        summary: `Competency requirement updated on ${describeTarget(context)}.`,
        metadata: metadata(updated, {
          targetKind: context.targetKind,
          changedFields: Object.keys(changes),
        }),
      },
      tx,
    );
    return toPublic(updated);
  });
}

async function deactivateForTarget(
  context: RequirementTargetContext,
  requirementId: string,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const existing = await serviceCompetencyRequirementRepository.findScopedById(
    undefined,
    {
      id: requirementId,
      clientId: context.clientId,
      target: context.target,
    },
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
          `Competency requirement deactivated on ${describeTarget(context)}; ` +
          'it no longer applies to new assignments.',
        metadata: metadata(deactivated, { targetKind: context.targetKind }),
      },
      tx,
    );
    return toPublic(deactivated);
  });
}

// ---------------------------------------------------------------- PART 03A API

export async function createCompetencyRequirement(
  serviceCatalogId: string,
  input: NewCompetencyRequirement,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await catalogContext(serviceCatalogId, actorUserId);
  return createForTarget(context, input, actorUserId);
}

export async function listCompetencyRequirements(
  serviceCatalogId: string,
  filter: ListCompetencyRequirementsFilter,
  actorUserId: string,
): Promise<PublicCompetencyRequirement[]> {
  const context = await catalogContext(serviceCatalogId, actorUserId);
  return listForTarget(context, filter);
}

export async function getCompetencyRequirement(
  serviceCatalogId: string,
  requirementId: string,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await catalogContext(serviceCatalogId, actorUserId);
  return getForTarget(context, requirementId);
}

export async function updateCompetencyRequirement(
  serviceCatalogId: string,
  requirementId: string,
  changes: CompetencyRequirementChanges,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await catalogContext(serviceCatalogId, actorUserId);
  return updateForTarget(context, requirementId, changes, actorUserId);
}

export async function deactivateCompetencyRequirement(
  serviceCatalogId: string,
  requirementId: string,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await catalogContext(serviceCatalogId, actorUserId);
  return deactivateForTarget(context, requirementId, actorUserId);
}

// ------------------------------------------------------------- PART 03B2A API

/**
 * Requirements for a multi-trade Work Order category, scoped to ONE Client.
 *
 * The Client is explicit because the registry is platform-wide; it is verified
 * against the caller's own Building reach, so passing another Client's id is a
 * 403 (`BUILDING_ACCESS_DENIED`), never a cross-tenant read or write.
 */
export async function createTradeCategoryCompetencyRequirement(
  tradeCategoryId: string,
  clientId: string,
  input: NewCompetencyRequirement,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await tradeCategoryContext(
    tradeCategoryId,
    clientId,
    actorUserId,
  );
  return createForTarget(context, input, actorUserId);
}

export async function listTradeCategoryCompetencyRequirements(
  tradeCategoryId: string,
  clientId: string,
  filter: ListCompetencyRequirementsFilter,
  actorUserId: string,
): Promise<PublicCompetencyRequirement[]> {
  const context = await tradeCategoryContext(
    tradeCategoryId,
    clientId,
    actorUserId,
  );
  return listForTarget(context, filter);
}

export async function getTradeCategoryCompetencyRequirement(
  tradeCategoryId: string,
  clientId: string,
  requirementId: string,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await tradeCategoryContext(
    tradeCategoryId,
    clientId,
    actorUserId,
  );
  return getForTarget(context, requirementId);
}

export async function updateTradeCategoryCompetencyRequirement(
  tradeCategoryId: string,
  clientId: string,
  requirementId: string,
  changes: CompetencyRequirementChanges,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await tradeCategoryContext(
    tradeCategoryId,
    clientId,
    actorUserId,
  );
  return updateForTarget(context, requirementId, changes, actorUserId);
}

export async function deactivateTradeCategoryCompetencyRequirement(
  tradeCategoryId: string,
  clientId: string,
  requirementId: string,
  actorUserId: string,
): Promise<PublicCompetencyRequirement> {
  const context = await tradeCategoryContext(
    tradeCategoryId,
    clientId,
    actorUserId,
  );
  return deactivateForTarget(context, requirementId, actorUserId);
}

export const serviceCompetencyRequirementService = {
  createCompetencyRequirement,
  deactivateCompetencyRequirement,
  getCompetencyRequirement,
  listCompetencyRequirements,
  updateCompetencyRequirement,
};

export const tradeCategoryCompetencyRequirementService = {
  createTradeCategoryCompetencyRequirement,
  deactivateTradeCategoryCompetencyRequirement,
  getTradeCategoryCompetencyRequirement,
  listTradeCategoryCompetencyRequirements,
  updateTradeCategoryCompetencyRequirement,
};
