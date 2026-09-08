import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { resolveAssetBuildingContext } from '../assets';
import { assignFinding } from '../finding-assignments/finding-assignment.service';
import {
  findingActionService,
  findingService,
  type FindingAction,
  type PublicFinding,
} from '../findings';
import { securityPostRepository } from '../security-posts';
import { patrolRouteRepository } from '../patrol-routes';
import { recordOperationalEvent } from '../operational-events';
import {
  securityFindingAlreadyLinkedError,
  securityFindingBuildingMismatchError,
  securityFindingNotFoundError,
  securityFindingPatrolRouteBuildingMismatchError,
  securityFindingSourceAlreadyLinkedError,
  securityFindingSourceNotFoundError,
  securityFindingStartPostBuildingMismatchError,
} from './security-finding.errors';
import {
  securityFindingRepository,
  type SecurityFindingListRow,
} from './security-finding.repository';
import type {
  CreateSecurityFindingInput,
  PublicSecurityFinding,
  SecurityFindingLinkRecord,
  SecurityFindingListFilters,
} from './security-finding.types';

/**
 * BE-12H — Security Finding Binding service.
 *
 * Creates / links BE-09 Findings from Security operational sources and
 * resolves their Security context. Everything Finding-related stays
 * BE-09: creation (`findingService.createFinding`), classification/
 * severity (`findingService.updateFinding`), source binding remains
 * untouched (the Security link records the Security source on its own
 * row, not on `findings.source_type`), assignment (`assignFinding`),
 * and workflow actions (`findingActionService.resolveAvailableActions`)
 * — the backend remains the sole authority for available actions.
 *
 * The Security `source_type` is intentionally separate from BE-09's
 * `findings.source_type`. We do NOT mutate BE-09's enum or the
 * `findings.source_type` column for the Security binding.
 */
export async function createSecurityFinding(
  input: CreateSecurityFindingInput,
  userId: string,
): Promise<PublicSecurityFinding> {
  const { clientId } = await resolveAssetBuildingContext(input.buildingId);
  await contextAccessService.assertBuildingAccess(userId, input.buildingId);

  // The Security source must exist and resolve to the same Building
  // (which also rejects every cross-Client source).
  const sourceContext = await securityFindingRepository.resolveSourceContext(
    input.sourceType,
    input.sourceId,
  );
  if (!sourceContext) {
    throw securityFindingSourceNotFoundError();
  }
  if (
    sourceContext.buildingId !== input.buildingId ||
    sourceContext.clientId !== clientId
  ) {
    throw securityFindingBuildingMismatchError();
  }

  // Duplicate unintended Security Findings from the same source are
  // rejected up-front. The DB has a UNIQUE backstop (per sourceType +
  // sourceId) but pre-checking lets us surface a clean 409 early.
  const existingForSource = await securityFindingRepository.findBySource(
    input.sourceType,
    input.sourceId,
  );
  if (existingForSource) {
    throw securityFindingSourceAlreadyLinkedError();
  }

  // Optional Security Post and Patrol Route must belong to the Building
  // (cross-Client is also rejected since the Building → Property → Client
  // chain is unique).
  if (input.startSecurityPostId) {
    await assertSecurityPost(
      input.startSecurityPostId,
      input.buildingId,
      clientId,
    );
  }
  if (input.patrolRouteId) {
    await assertPatrolRoute(
      input.patrolRouteId,
      input.buildingId,
      clientId,
    );
  }

  // BE-09 owns Finding creation. The Security link does not write to
  // `findings.source_type` — we keep the Security source on our own
  // link row. The Finding is created in OPEN status with a Security
  // friendly title/description.
  let finding = await findingService.createFinding({
    clientId,
    buildingId: input.buildingId,
    findingNumber: `SEC_${randomUUID().slice(0, 8).toUpperCase()}`,
    title: input.title,
    description: input.description,
    reportedByUserId: userId,
  });

  // BE-09 owns classification / severity validation and history.
  if (input.classificationId || input.severityId) {
    finding = await findingService.updateFinding(
      finding.id,
      {
        ...(input.classificationId
          ? { classificationId: input.classificationId }
          : {}),
        ...(input.severityId ? { severityId: input.severityId } : {}),
      },
      userId,
    );
  }

  // The Security link is the only place that records the Security
  // operational context for this Finding.
  const link = await createLink(
    {
      clientId,
      buildingId: input.buildingId,
      findingId: finding.id,
      startSecurityPostId: input.startSecurityPostId ?? null,
      patrolRouteId: input.patrolRouteId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
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

  // Re-read the authoritative Finding to reflect any BE-09 mutations.
  finding = await findingService.getFindingById(finding.id);

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_FINDING_CREATED',
    entityType: 'SECURITY_FINDING_LINK',
    entityId: link.id,
    actorUserId: userId,
    buildingId: input.buildingId,
    summary: `Security finding created from ${input.sourceType.toLowerCase()}`,
    metadata: {
      findingId: finding.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      startSecurityPostId: input.startSecurityPostId ?? null,
      patrolRouteId: input.patrolRouteId ?? null,
    },
  });

  return resolveSecurityFinding(link, finding, userId);
}

export async function getSecurityFinding(
  id: string,
  userId: string,
): Promise<PublicSecurityFinding> {
  const link = await securityFindingRepository.findById(id);
  if (!link) {
    throw securityFindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, link.buildingId);
  const finding = await findingService.getFindingById(link.findingId);
  return resolveSecurityFinding(link, finding, userId);
}

export async function listSecurityFindings(
  filters: SecurityFindingListFilters,
  userId: string,
): Promise<PublicSecurityFinding[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else if (filters.startSecurityPostId) {
    const post = await securityPostRepository.findById(
      filters.startSecurityPostId,
    );
    if (!post) {
      throw AppError.notFound('Security post not found.');
    }
    await contextAccessService.assertBuildingAccess(userId, post.buildingId);
    buildingIds = [post.buildingId];
  } else if (filters.patrolRouteId) {
    const route = await patrolRouteRepository.findById(filters.patrolRouteId);
    if (!route) {
      throw AppError.notFound('Patrol route not found.');
    }
    await contextAccessService.assertBuildingAccess(userId, route.buildingId);
    buildingIds = [route.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const rows = await securityFindingRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return Promise.all(rows.map((row) => resolveSecurityFindingRow(row, userId)));
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function createLink(
  input: {
    clientId: string;
    buildingId: string;
    findingId: string;
    startSecurityPostId: string | null;
    patrolRouteId: string | null;
    sourceType: CreateSecurityFindingInput['sourceType'];
    sourceId: string;
  },
  userId: string,
): Promise<SecurityFindingLinkRecord> {
  // Pre-check the BE-09 Finding doesn't already have a Security link.
  const existingByFinding = await securityFindingRepository.findByFindingId(
    input.findingId,
  );
  if (existingByFinding) {
    throw securityFindingAlreadyLinkedError();
  }

  try {
    return await securityFindingRepository.create({
      ...input,
      createdByUserId: userId,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'security_finding_links_finding_id_key')) {
      throw securityFindingAlreadyLinkedError();
    }
    if (isUniqueViolation(error, 'security_finding_source_unique')) {
      throw securityFindingSourceAlreadyLinkedError();
    }
    throw error;
  }
}

async function assertSecurityPost(
  securityPostId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const post = await securityPostRepository.findById(securityPostId);
  if (!post) {
    throw AppError.notFound('Security post not found.');
  }
  if (post.buildingId !== buildingId || post.clientId !== clientId) {
    throw securityFindingStartPostBuildingMismatchError();
  }
}

async function assertPatrolRoute(
  patrolRouteId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const route = await patrolRouteRepository.findById(patrolRouteId);
  if (!route) {
    throw AppError.notFound('Patrol route not found.');
  }
  if (route.buildingId !== buildingId || route.clientId !== clientId) {
    throw securityFindingPatrolRouteBuildingMismatchError();
  }
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
): Promise<FindingAction[]> {
  const result = await findingActionService.resolveAvailableActions(
    findingId,
    { userId },
  );
  return result.availableActions;
}

async function resolveSecurityFinding(
  link: SecurityFindingLinkRecord,
  finding: PublicFinding,
  userId: string,
): Promise<PublicSecurityFinding> {
  return {
    id: link.id,
    clientId: link.clientId,
    buildingId: link.buildingId,
    findingId: link.findingId,
    startSecurityPostId: link.startSecurityPostId,
    patrolRouteId: link.patrolRouteId,
    sourceType: link.sourceType,
    sourceId: link.sourceId,
    createdAt: link.createdAt.toISOString(),
    finding,
    availableActions: await resolveAvailableActions(finding.id, userId),
  };
}

async function resolveSecurityFindingRow(
  row: SecurityFindingListRow,
  userId: string,
): Promise<PublicSecurityFinding> {
  const finding: PublicFinding = {
    id: row.f_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingNumber: row.f_finding_number,
    title: row.f_title,
    description: row.f_description,
    classificationId: row.f_classification_id,
    severityId: row.f_severity_id,
    sourceType: null,
    sourceId: null,
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
    startSecurityPostId: row.start_security_post_id,
    patrolRouteId: row.patrol_route_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at.toISOString(),
    finding,
    availableActions: await resolveAvailableActions(row.finding_id, userId),
  };
}

export const securityFindingService = {
  createSecurityFinding,
  getSecurityFinding,
  listSecurityFindings,
};
