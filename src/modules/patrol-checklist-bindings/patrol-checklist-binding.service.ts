import { AppError } from '../../shared/errors';
import { resolveAssetBuildingContext } from '../assets';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  patrolChecklistBindingAlreadyExistsError,
  patrolChecklistBindingInactiveError,
  patrolChecklistBindingNotFoundError,
  patrolChecklistExecutionNotFoundError,
  patrolChecklistRouteInactiveError,
  patrolChecklistStartSecurityPostBuildingMismatchError,
  patrolChecklistStartSecurityPostInactiveError,
  patrolChecklistTemplateClientMismatchError,
  patrolChecklistTemplateNotActiveError,
} from './patrol-checklist-binding.errors';
import {
  patrolChecklistBindingRepository,
  type ExecutionContextRow,
  type ExecutionRow,
  type PatrolRouteRow,
  type SecurityPostRow,
} from './patrol-checklist-binding.repository';
import type {
  CreatePatrolChecklistBindingInput,
  PatrolChecklistBindingFilter,
  PatrolChecklistBindingRecord,
  PublicPatrolChecklistBinding,
  PublicPatrolChecklistExecution,
  PublicPatrolChecklistExecutionContext,
  UpdatePatrolChecklistBindingInput,
} from './patrol-checklist-binding.types';

/**
 * BE-12E — Patrol Checklist Binding service.
 *
 * Binds BE-07 Checklist Templates to a Security operational context (a
 * BE-12B Patrol Route plus an optional BE-12A Start Post) and starts
 * executions on the shared BE-07 checklist execution table. Checklist
 * execution lifecycle, measurement, evidence, verification, and findings
 * all remain owned by BE-07 / BE-09 — this service only validates and
 * records the binding and starts a shared execution row.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building              → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building         → 403 BUILDING_ACCESS_DENIED
 *   3. unknown Patrol Route          → 404 PATROL_ROUTE_NOT_FOUND
 *   4. INACTIVE Patrol Route         → 400 PATROL_CHECKLIST_ROUTE_INACTIVE
 *   5. cross-Building Route          → 400 (PATROL_ROUTE_BINDING_BUILDING_MISMATCH via service)
 *   6. unknown template              → 404 NOT_FOUND
 *   7. non-ACTIVE template           → 400 PATROL_CHECKLIST_TEMPLATE_NOT_ACTIVE
 *   8. cross-Client template         → 400 PATROL_CHECKLIST_TEMPLATE_CLIENT_MISMATCH
 *   9. INACTIVE / cross-Building post → 400 PATROL_CHECKLIST_START_SECURITY_POST_*
 *  10. duplicate ACTIVE binding      → 409 PATROL_CHECKLIST_BINDING_ALREADY_EXISTS
 */
export async function createPatrolChecklistBinding(
  input: CreatePatrolChecklistBindingInput,
  userId: string,
): Promise<PublicPatrolChecklistBinding> {
  const { clientId } = await assertBuilding(input.buildingId, userId);

  const route = await patrolChecklistBindingRepository.findPatrolRoute(
    input.patrolRouteId,
  );
  if (!route) {
    throw AppError.notFound('Patrol route not found.');
  }
  if (route.status !== 'ACTIVE') {
    throw patrolChecklistRouteInactiveError();
  }
  if (route.building_id !== input.buildingId) {
    throw AppError.badRequest(
      'Patrol route does not belong to the same building.',
    );
  }
  if (route.client_id !== clientId) {
    throw AppError.badRequest(
      'Patrol route does not belong to the same client as the building.',
    );
  }

  const template = await patrolChecklistBindingRepository.findChecklistTemplate(
    input.checklistTemplateId,
  );
  if (!template) {
    throw AppError.notFound('Checklist template not found.');
  }
  if (template.status !== 'ACTIVE') {
    throw patrolChecklistTemplateNotActiveError();
  }
  if (template.client_id !== clientId) {
    throw patrolChecklistTemplateClientMismatchError();
  }

  if (input.startSecurityPostId) {
    await assertStartSecurityPost(
      input.startSecurityPostId,
      input.buildingId,
    );
  }

  try {
    const record = await patrolChecklistBindingRepository.create({
      clientId,
      buildingId: input.buildingId,
      patrolRouteId: input.patrolRouteId,
      startSecurityPostId: input.startSecurityPostId ?? null,
      checklistTemplateId: input.checklistTemplateId,
      status: input.status ?? 'ACTIVE',
      createdByUserId: userId,
    });
    return toPublicPatrolChecklistBinding(record);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw patrolChecklistBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getPatrolChecklistBinding(
  id: string,
  userId: string,
): Promise<PublicPatrolChecklistBinding> {
  const record = await patrolChecklistBindingRepository.findById(id);
  if (!record) {
    throw patrolChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicPatrolChecklistBinding(record);
}

export async function listPatrolChecklistBindings(
  filters: PatrolChecklistBindingFilter,
  userId: string,
): Promise<PublicPatrolChecklistBinding[]> {
  let records: PatrolChecklistBindingRecord[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      userId,
      filters.buildingId,
    );
    records = await patrolChecklistBindingRepository.list(filters);
  } else if (filters.patrolRouteId) {
    const route = await patrolChecklistBindingRepository.findPatrolRoute(
      filters.patrolRouteId,
    );
    if (!route) {
      throw AppError.notFound('Patrol route not found.');
    }
    await contextAccessService.assertBuildingAccess(userId, route.building_id);
    records = await patrolChecklistBindingRepository.list(filters);
  } else {
    const buildingIds = await contextAccessService.getAccessibleBuildingIds(
      userId,
    );
    records = await patrolChecklistBindingRepository.listByBuildingIds(
      buildingIds,
      filters,
    );
  }

  return records.map(toPublicPatrolChecklistBinding);
}

export async function updatePatrolChecklistBinding(
  id: string,
  input: UpdatePatrolChecklistBindingInput,
  userId: string,
): Promise<PublicPatrolChecklistBinding> {
  const existing = await patrolChecklistBindingRepository.findById(id);
  if (!existing) {
    throw patrolChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (input.startSecurityPostId !== undefined && input.startSecurityPostId) {
    await assertStartSecurityPost(
      input.startSecurityPostId,
      existing.buildingId,
    );
  }

  try {
    const updated = await patrolChecklistBindingRepository.update(id, input);
    if (!updated) {
      throw patrolChecklistBindingNotFoundError();
    }
    return toPublicPatrolChecklistBinding(updated);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw patrolChecklistBindingAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Starts the shared BE-07 checklist execution for an ACTIVE binding. The
 * execution row lives on BE-07's own `checklist_executions` table and keeps
 * all BE-07 lifecycle behaviour (start / responses / complete / cancel).
 */
export async function startPatrolChecklistExecution(
  bindingId: string,
  userId: string,
): Promise<PublicPatrolChecklistExecution> {
  const binding = await patrolChecklistBindingRepository.findById(bindingId);
  if (!binding) {
    throw patrolChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  if (binding.status !== 'ACTIVE') {
    throw patrolChecklistBindingInactiveError();
  }

  const template = await patrolChecklistBindingRepository.findChecklistTemplate(
    binding.checklistTemplateId,
  );
  if (!template) {
    throw AppError.notFound('Checklist template not found.');
  }
  if (template.status !== 'ACTIVE') {
    throw patrolChecklistTemplateNotActiveError();
  }

  const route = await patrolChecklistBindingRepository.findPatrolRoute(
    binding.patrolRouteId,
  );
  if (!route || route.status !== 'ACTIVE') {
    throw patrolChecklistRouteInactiveError();
  }

  const execution = await patrolChecklistBindingRepository.insertExecution({
    bindingId: binding.id,
    clientId: binding.clientId,
    checklistTemplateId: template.id,
  });

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'PATROL_CHECKLIST_EXECUTION_STARTED',
    entityType: 'CHECKLIST_EXECUTION',
    entityId: execution.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Patrol checklist execution started for binding ${binding.id}`,
    metadata: {
      patrolChecklistBindingId: binding.id,
      checklistTemplateId: template.id,
      patrolRouteId: binding.patrolRouteId,
      startSecurityPostId: binding.startSecurityPostId,
    },
  });

  return toPublicPatrolChecklistExecution(execution, binding.id);
}

/** Resolves the Building / Template / Route / Start Post context an execution is tied to. */
export async function resolvePatrolChecklistExecutionContext(
  executionId: string,
  userId: string,
): Promise<PublicPatrolChecklistExecutionContext> {
  const row = await patrolChecklistBindingRepository.findExecutionContext(
    executionId,
  );
  if (!row || !row.patrol_checklist_binding_id || !row.building_id) {
    throw patrolChecklistExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(
    userId,
    row.building_id,
  );

  return {
    execution: {
      id: row.execution_id,
      checklistTemplateId: row.execution_template_id,
      patrolChecklistBindingId: row.patrol_checklist_binding_id,
      status: row.execution_status,
      startedAt: row.execution_started_at
        ? row.execution_started_at.toISOString()
        : null,
      completedAt: row.execution_completed_at
        ? row.execution_completed_at.toISOString()
        : null,
      createdAt: row.execution_created_at.toISOString(),
      updatedAt: row.execution_updated_at.toISOString(),
    },
    building: {
      id: row.building_id,
      code: row.building_code as string,
      name: row.building_name as string,
    },
    template: {
      id: row.template_id as string,
      code: row.template_code as string,
      name: row.template_name as string,
      status: row.template_status as string,
    },
    patrolRoute: {
      id: row.patrol_route_id as string,
      code: row.patrol_route_code as string,
      name: row.patrol_route_name as string,
      status: row.patrol_route_status as string,
    },
    startSecurityPost: {
      id: row.start_security_post_id,
      code: row.start_security_post_code,
      name: row.start_security_post_name,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function assertBuilding(
  buildingId: string,
  userId: string,
): Promise<{ clientId: string }> {
  const context = await resolveAssetBuildingContext(buildingId);
  await contextAccessService.assertBuildingAccess(userId, buildingId);
  if (context.buildingStatus !== 'ACTIVE') {
    throw AppError.badRequest('Building is not active.');
  }
  return { clientId: context.clientId };
}

async function assertStartSecurityPost(
  securityPostId: string,
  buildingId: string,
): Promise<void> {
  const post: SecurityPostRow | null =
    await patrolChecklistBindingRepository.findSecurityPost(securityPostId);
  if (!post) {
    throw AppError.notFound('Security post not found.');
  }
  if (post.building_id !== buildingId) {
    throw patrolChecklistStartSecurityPostBuildingMismatchError();
  }
  if (post.status !== 'ACTIVE') {
    throw patrolChecklistStartSecurityPostInactiveError();
  }
}

function isActiveBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'patrol_checklist_binding_active_unique'
  );
}

export function toPublicPatrolChecklistBinding(
  record: PatrolChecklistBindingRecord,
): PublicPatrolChecklistBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    patrolRouteId: record.patrolRouteId,
    startSecurityPostId: record.startSecurityPostId,
    checklistTemplateId: record.checklistTemplateId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicPatrolChecklistExecution(
  execution: ExecutionRow,
  bindingId: string,
): PublicPatrolChecklistExecution {
  return {
    id: execution.id,
    checklistTemplateId: execution.checklist_template_id,
    patrolChecklistBindingId: bindingId,
    status: execution.status,
    startedAt: execution.started_at
      ? execution.started_at.toISOString()
      : null,
    completedAt: execution.completed_at
      ? execution.completed_at.toISOString()
      : null,
    createdAt: execution.created_at.toISOString(),
    updatedAt: execution.updated_at.toISOString(),
  };
}

// Helper used internally only; the binding record's `patrolRouteId` and
// `startSecurityPostId` are exposed via the public mapper.
type _PatrolRouteRef = PatrolRouteRow;
type _SecurityPostRef = SecurityPostRow;
type _ExecutionContextRef = ExecutionContextRow;

// Suppress unused-type warnings for the internal-only aliases.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _UnusedAliases = _PatrolRouteRef & _SecurityPostRef & _ExecutionContextRef;

export const patrolChecklistBindingService = {
  createPatrolChecklistBinding,
  getPatrolChecklistBinding,
  listPatrolChecklistBindings,
  resolvePatrolChecklistExecutionContext,
  startPatrolChecklistExecution,
  toPublicPatrolChecklistBinding,
  updatePatrolChecklistBinding,
};
