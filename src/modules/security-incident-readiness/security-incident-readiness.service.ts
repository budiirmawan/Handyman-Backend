import { AppError } from '../../shared/errors';
import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { departmentRepository } from '../departments';
import { organizationRepository } from '../organizations';
import {
  teamInactiveError,
  teamNotFoundError,
  teamRepository,
} from '../teams';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import { securityPostNotFoundError, securityPostRepository } from '../security-posts';
import {
  securityIncidentReadinessAlreadyExistsError,
  securityIncidentReadinessNotFoundError,
  securityIncidentReadinessSecurityPostBuildingMismatchError,
  securityIncidentReadinessSecurityPostInactiveError,
  securityIncidentReadinessWorkforceBuildingMismatchError,
  securityIncidentReadinessWorkforceInactiveError,
} from './security-incident-readiness.errors';
import { securityIncidentReadinessRepository } from './security-incident-readiness.repository';
import type {
  CreateSecurityIncidentReadinessInput,
  PublicSecurityIncidentReadiness,
  SecurityIncidentReadinessEvaluation,
  SecurityIncidentReadinessListFilters,
  SecurityIncidentReadinessRecord,
  SecurityIncidentReadinessStatus,
  UpdateSecurityIncidentReadinessInput,
} from './security-incident-readiness.types';

/**
 * BE-12I — Security Incident Readiness service.
 *
 * Configuration-only layer that records whether a Building (or Building
 * × Security Post) is operationally prepared to report a particular
 * category of incident. No incident records, no workflow, no SLA, no
 * dispatch / notification logic — the actual incident engine is out of
 * scope for this PART.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                    → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building               → 403 BUILDING_ACCESS_DENIED
 *   3. unknown / cross-Building / INACTIVE
 *      Security Post                       → 404 / 400 / 400
 *   4. unknown / INACTIVE Team             → 404 / 400
 *   5. cross-Client Team                   → 400 (Team → Department →
 *      Organization → Client)
 *   6. unknown / INACTIVE Workforce        → 404 / 400
 *   7. cross-Client Workforce              → 400 (Workforce →
 *      Organization → Client)
 *   8. Workforce with no active Building
 *      assignment for this Building        → 400
 *   9. duplicate ACTIVE (post, category)   → 409 ALREADY_EXISTS
 */
export async function createSecurityIncidentReadiness(
  input: CreateSecurityIncidentReadinessInput,
  userId: string,
): Promise<PublicSecurityIncidentReadiness> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, input.buildingId);

  const { clientId } = await resolveAssetBuildingContext(input.buildingId);

  if (input.securityPostId) {
    await assertSecurityPost(
      input.securityPostId,
      input.buildingId,
      clientId,
    );
  }
  if (input.responsibleTeamId) {
    await assertTeam(input.responsibleTeamId, clientId);
  }
  if (input.responsibleWorkforceId) {
    await assertWorkforce(
      input.responsibleWorkforceId,
      input.buildingId,
      clientId,
    );
  }

  const activeForPostAndCategory =
    await securityIncidentReadinessRepository.findActiveByPostAndCategory(
      input.buildingId,
      input.securityPostId ?? null,
      input.category,
    );
  if (activeForPostAndCategory) {
    throw securityIncidentReadinessAlreadyExistsError();
  }

  let record: SecurityIncidentReadinessRecord;
  try {
    record = await securityIncidentReadinessRepository.create({
      ...input,
      clientId,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'security_incident_readiness_active_post_category')) {
      throw securityIncidentReadinessAlreadyExistsError();
    }
    throw error;
  }
  return toPublicSecurityIncidentReadiness(record);
}

export async function getSecurityIncidentReadiness(
  id: string,
  userId: string,
): Promise<PublicSecurityIncidentReadiness> {
  const record = await securityIncidentReadinessRepository.findById(id);
  if (!record) {
    throw securityIncidentReadinessNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicSecurityIncidentReadiness(record);
}

export async function listSecurityIncidentReadiness(
  filters: SecurityIncidentReadinessListFilters,
  userId: string,
): Promise<PublicSecurityIncidentReadiness[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else if (filters.securityPostId) {
    const post = await securityPostRepository.findById(filters.securityPostId);
    if (!post) {
      throw securityPostNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, post.buildingId);
    buildingIds = [post.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await securityIncidentReadinessRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return Promise.all(
    records.map((record) =>
      toPublicSecurityIncidentReadiness(record),
    ),
  );
}

export async function updateSecurityIncidentReadiness(
  id: string,
  input: UpdateSecurityIncidentReadinessInput,
  userId: string,
): Promise<PublicSecurityIncidentReadiness> {
  const existing = await securityIncidentReadinessRepository.findById(id);
  if (!existing) {
    throw securityIncidentReadinessNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const { clientId } = await resolveAssetBuildingContext(existing.buildingId);

  if (input.securityPostId !== undefined && input.securityPostId) {
    await assertSecurityPost(
      input.securityPostId,
      existing.buildingId,
      clientId,
    );
  }
  if (input.responsibleTeamId !== undefined && input.responsibleTeamId) {
    await assertTeam(input.responsibleTeamId, clientId);
  }
  if (
    input.responsibleWorkforceId !== undefined &&
    input.responsibleWorkforceId
  ) {
    await assertWorkforce(
      input.responsibleWorkforceId,
      existing.buildingId,
      clientId,
    );
  }

  if (
    input.status === 'ACTIVE' &&
    existing.status !== 'ACTIVE'
  ) {
    const targetCategory = input.category ?? existing.category;
    const targetPost =
      input.securityPostId !== undefined
        ? input.securityPostId
        : existing.securityPostId;
    const stillActive =
      await securityIncidentReadinessRepository.findActiveByPostAndCategory(
        existing.buildingId,
        targetPost,
        targetCategory,
      );
    if (stillActive && stillActive.id !== id) {
      throw securityIncidentReadinessAlreadyExistsError();
    }
  }

  const updated = await securityIncidentReadinessRepository.update(id, input);
  if (!updated) {
    throw securityIncidentReadinessNotFoundError();
  }
  return toPublicSecurityIncidentReadiness(updated);
}

/**
 * Deterministic readiness evaluation. The reported readiness_status
 * (what the operator wrote) is downgraded when any of the supporting
 * references are INACTIVE or missing the required context. The result
 * is intentional: a row that says READY but points at an INACTIVE post
 * is, in fact, NOT_READY.
 */
export async function evaluateSecurityIncidentReadiness(
  id: string,
  userId: string,
): Promise<SecurityIncidentReadinessEvaluation> {
  const record = await securityIncidentReadinessRepository.findById(id);
  if (!record) {
    throw securityIncidentReadinessNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return evaluateRecord(record);
}

async function assertSecurityPost(
  securityPostId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const post = await securityPostRepository.findById(securityPostId);
  if (!post) {
    throw securityPostNotFoundError();
  }
  if (post.buildingId !== buildingId || post.clientId !== clientId) {
    throw securityIncidentReadinessSecurityPostBuildingMismatchError();
  }
  if (post.status !== 'ACTIVE') {
    throw securityIncidentReadinessSecurityPostInactiveError();
  }
}

async function assertTeam(teamId: string, clientId: string): Promise<void> {
  const team = await teamRepository.findById(teamId);
  if (!team) {
    throw teamNotFoundError();
  }
  if (team.status !== 'ACTIVE') {
    throw teamInactiveError();
  }
  const department = await departmentRepository.findById(team.departmentId);
  if (!department) {
    throw teamNotFoundError();
  }
  const organization = await organizationRepository.findById(
    department.organizationId,
  );
  if (!organization) {
    throw teamNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw securityIncidentReadinessNotFoundError();
  }
}

async function assertWorkforce(
  workforceProfileId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw securityIncidentReadinessNotFoundError();
  }
  const assignment =
    await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
      workforceProfileId,
      buildingId,
    );
  if (!assignment) {
    throw securityIncidentReadinessWorkforceBuildingMismatchError();
  }
}

async function evaluateRecord(
  record: SecurityIncidentReadinessRecord,
): Promise<SecurityIncidentReadinessEvaluation> {
  const reasons: string[] = [];
  if (record.status !== 'ACTIVE') {
    reasons.push('Readiness row is INACTIVE.');
  }

  if (record.securityPostId) {
    const post = await securityPostRepository.findById(record.securityPostId);
    if (!post) {
      reasons.push('Referenced security post no longer exists.');
    } else if (post.buildingId !== record.buildingId) {
      reasons.push('Referenced security post is in a different building.');
    } else if (post.status !== 'ACTIVE') {
      reasons.push('Referenced security post is INACTIVE.');
    }
  }

  if (record.responsibleTeamId) {
    const team = await teamRepository.findById(record.responsibleTeamId);
    if (!team) {
      reasons.push('Referenced responsible team no longer exists.');
    } else if (team.status !== 'ACTIVE') {
      reasons.push('Referenced responsible team is INACTIVE.');
    }
  }

  if (record.responsibleWorkforceId) {
    const profile = await workforceRepository.findById(
      record.responsibleWorkforceId,
    );
    if (!profile) {
      reasons.push('Referenced responsible workforce no longer exists.');
    } else if (profile.status !== 'ACTIVE') {
      reasons.push('Referenced responsible workforce is INACTIVE.');
    } else {
      const assignment =
        await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
          record.responsibleWorkforceId,
          record.buildingId,
        );
      if (!assignment) {
        reasons.push('Referenced responsible workforce has no active building assignment.');
      }
    }
  }

  const effectiveStatus = computeEffectiveStatus(
    record.readinessStatus,
    reasons,
  );

  return {
    readinessId: record.id,
    buildingId: record.buildingId,
    securityPostId: record.securityPostId,
    category: record.category,
    reportedStatus: record.readinessStatus,
    effectiveStatus,
    reasons,
  };
}

function computeEffectiveStatus(
  reported: SecurityIncidentReadinessStatus,
  reasons: string[],
): SecurityIncidentReadinessStatus {
  if (reasons.length === 0) {
    return reported;
  }
  // Any reason downgrades the row by at least one level.
  // A second concurrent reason downgrades a second level so a READY
  // row with two or more inactive references ends up NOT_READY.
  if (reported === 'READY') {
    return reasons.length >= 2 ? 'NOT_READY' : 'PARTIAL';
  }
  if (reported === 'PARTIAL') {
    return 'NOT_READY';
  }
  return 'NOT_READY';
}

function isUniqueViolation(
  error: unknown,
  constraint: string,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

async function toPublicSecurityIncidentReadiness(
  record: SecurityIncidentReadinessRecord,
): Promise<PublicSecurityIncidentReadiness> {
  const evaluation = await evaluateRecord(record);
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    securityPostId: record.securityPostId,
    category: record.category,
    readinessStatus: record.readinessStatus,
    status: record.status,
    responsibleTeamId: record.responsibleTeamId,
    responsibleWorkforceId: record.responsibleWorkforceId,
    escalationContact: record.escalationContact,
    reportingInstructions: record.reportingInstructions,
    evidenceRequirementId: record.evidenceRequirementId,
    notes: record.notes,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    effectiveReadiness: evaluation.effectiveStatus,
    effectiveReasons: evaluation.reasons,
  };
}

// Suppress unused-import warning for AppError — AppError is the base
// type for all thrown errors, but is not called directly here.
void AppError;

export const securityIncidentReadinessService = {
  createSecurityIncidentReadiness,
  evaluateSecurityIncidentReadiness,
  getSecurityIncidentReadiness,
  listSecurityIncidentReadiness,
  updateSecurityIncidentReadiness,
};
