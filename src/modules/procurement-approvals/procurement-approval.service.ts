import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleBuildingIds,
} from '../context-access';
import { getPool } from '../../database';
import { permissionService } from '../permissions';
import { purchaseRequestRepository } from '../purchase-requests';
import { materialRequestRepository } from '../material-requests';
import { serviceRequestRepository } from '../service-requests';
import { rfqRepository } from '../rfqs';
import { rfqRecommendationRepository } from '../rfq-recommendations/rfq-recommendation.repository';
import { recordOperationalEvent } from '../operational-events';
import { userRepository } from '../users';
import {
  materialRequestApprovedQuantityExceedsRequestedError,
  materialRequestApprovedQuantityInvalidError,
  procurementApprovalActionNotAllowedError,
  procurementApprovalAlreadyDecidedError,
  procurementApprovalAlreadyPendingError,
  procurementApprovalApprovedQuantityNotApplicableError,
  procurementApprovalApproverInvalidError,
  procurementApprovalNotFoundError,
  procurementApprovalRequestInvalidError,
  procurementApprovalUnauthorizedApproverError,
} from './procurement-approval.errors';
import { procurementApprovalRepository } from './procurement-approval.repository';
import {
  PROCUREMENT_APPROVAL_ACTIONS,
  type CreateProcurementApprovalInput,
  type NewProcurementApproval,
  type ProcurementApprovalAction,
  type ProcurementApprovalAvailableActions,
  type ProcurementApprovalDecisionInput,
  type ProcurementApprovalPendingFilters,
  type ProcurementApprovalRecord,
  type ProcurementApprovalRequestType,
  type PublicProcurementApproval,
} from './procurement-approval.types';

type RequestContext = {
  clientId: string;
  buildingId: string;
  status: string;
};

function requestId(record: ProcurementApprovalRecord): string {
  return (
    record.purchaseRequestId ??
    record.materialRequestId ??
    record.serviceRequestId ??
    record.rfqId!
  );
}

function toPublic(record: ProcurementApprovalRecord): PublicProcurementApproval {
  return {
    ...record,
    requestId: requestId(record),
    decidedAt: record.decidedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function resolveRequest(
  type: ProcurementApprovalRequestType,
  id: string,
): Promise<RequestContext> {
  if (type === 'RFQ') {
    const record = await rfqRepository.findById(id);
    if (!record) throw procurementApprovalRequestInvalidError();
    return { clientId: record.clientId, buildingId: record.buildingId, status: record.status };
  }
  const record =
    type === 'PURCHASE_REQUEST'
      ? await purchaseRequestRepository.findById(id)
      : type === 'MATERIAL_REQUEST'
        ? await materialRequestRepository.findById(id)
        : await serviceRequestRepository.findById(id);
  if (!record) throw procurementApprovalRequestInvalidError();
  return {
    clientId: record.clientId,
    buildingId: record.buildingId,
    status: record.status,
  };
}

/** Reuses the effective-permission authority to decide who may approve. */
async function canApprove(
  userId: string,
  buildingId: string,
): Promise<boolean> {
  const user = await userRepository.findById(userId);
  if (!user || user.status !== 'ACTIVE') return false;
  if (!(await contextAccessService.canAccessBuilding(userId, buildingId))) {
    return false;
  }
  return (
    await permissionService.resolvePermissionsForUser(userId)
  ).includes('procurement_approval.manage');
}

export async function createProcurementApproval(
  input: CreateProcurementApprovalInput,
  actorUserId: string,
): Promise<PublicProcurementApproval> {
  const target = await resolveRequest(input.requestType, input.requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);
  let recommendationId: string | null = null;
  if (input.requestType === 'RFQ') {
    if (target.status !== 'CLOSED' || input.approvalType !== 'RFQ_AWARD' || !input.recommendationId) {
      throw procurementApprovalRequestInvalidError();
    }
    const recommendation = await rfqRecommendationRepository.findRecommendationById(input.recommendationId);
    if (!recommendation || recommendation.rfqId !== input.requestId
      || recommendation.clientId !== target.clientId || recommendation.buildingId !== target.buildingId
      || recommendation.status !== 'PENDING_APPROVAL') {
      throw procurementApprovalRequestInvalidError();
    }
    recommendationId = recommendation.id;
  } else if (target.status !== 'OPEN') {
    throw procurementApprovalRequestInvalidError();
  }
  if (!(await canApprove(input.approverUserId, target.buildingId))) {
    throw procurementApprovalApproverInvalidError();
  }
  if (await procurementApprovalRepository.findPendingDuplicate(input)) {
    throw procurementApprovalAlreadyPendingError();
  }

  const record: NewProcurementApproval = {
    clientId: target.clientId,
    buildingId: target.buildingId,
    requestType: input.requestType,
    purchaseRequestId:
      input.requestType === 'PURCHASE_REQUEST' ? input.requestId : null,
    materialRequestId:
      input.requestType === 'MATERIAL_REQUEST' ? input.requestId : null,
    serviceRequestId:
      input.requestType === 'SERVICE_REQUEST' ? input.requestId : null,
    rfqId: input.requestType === 'RFQ' ? input.requestId : null,
    recommendationId,
    approvalType: input.approvalType,
    approverUserId: input.approverUserId,
    createdByUserId: actorUserId,
  };
  try {
    const created = await procurementApprovalRepository.create(record);
    if (created.requestType === 'RFQ') {
      await recordOperationalEvent({
        clientId: created.clientId,
        buildingId: created.buildingId,
        eventType: 'RFQ_APPROVAL_SUBMITTED',
        entityType: 'PROCUREMENT_APPROVAL',
        entityId: created.id,
        actorUserId,
        summary: 'RFQ award approval binding submitted.',
        metadata: {
          rfqId: created.rfqId,
          recommendationId: created.recommendationId,
          approvalType: created.approvalType,
          approverUserId: created.approverUserId,
        },
      });
    }
    return toPublic(created);
  } catch (error) {
    if (isPendingUnique(error)) throw procurementApprovalAlreadyPendingError();
    throw error;
  }
}

export async function getProcurementApproval(
  id: string,
  actorUserId: string,
): Promise<PublicProcurementApproval> {
  const record = await procurementApprovalRepository.findById(id);
  if (!record) throw procurementApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}

export async function listPendingProcurementApprovals(
  filters: ProcurementApprovalPendingFilters,
  actorUserId: string,
): Promise<PublicProcurementApproval[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await procurementApprovalRepository.listPending(filters, buildingIds)
  ).map(toPublic);
}

export async function approveProcurementApproval(
  id: string,
  input: ProcurementApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicProcurementApproval> {
  return decide(id, 'APPROVED', input, actorUserId, 'APPROVE');
}

export async function rejectProcurementApproval(
  id: string,
  input: ProcurementApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicProcurementApproval> {
  return decide(id, 'REJECTED', input, actorUserId, 'REJECT');
}

async function decide(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  input: ProcurementApprovalDecisionInput,
  actorUserId: string,
  action: ProcurementApprovalAction,
): Promise<PublicProcurementApproval> {
  const notes = input.decisionNotes ?? null;
  const record = await procurementApprovalRepository.findById(id);
  if (!record) throw procurementApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  if (record.status !== 'PENDING') throw procurementApprovalAlreadyDecidedError();
  if (record.approverUserId !== actorUserId) {
    throw procurementApprovalUnauthorizedApproverError();
  }
  if (!(await resolveAllowedActions(record, actorUserId)).has(action)) {
    throw procurementApprovalActionNotAllowedError(action);
  }

  // CR-BE-MAT-01 PART 02 — approved quantity rules. An explicit approved
  // quantity only applies when APPROVING a MATERIAL_REQUEST binding; it must
  // be > 0 and must not exceed the requested line quantity (no existing
  // business rule permits over-approval). All checks run BEFORE any mutation.
  let explicitApprovedQuantity: number | null = null;
  if (input.approvedQuantity !== undefined) {
    if (status !== 'APPROVED' || record.requestType !== 'MATERIAL_REQUEST') {
      throw procurementApprovalApprovedQuantityNotApplicableError();
    }
    if (
      typeof input.approvedQuantity !== 'number' ||
      !Number.isFinite(input.approvedQuantity) ||
      input.approvedQuantity <= 0
    ) {
      throw materialRequestApprovedQuantityInvalidError();
    }
    const line = await materialRequestRepository.findById(
      record.materialRequestId!,
    );
    if (!line) throw procurementApprovalRequestInvalidError();
    if (input.approvedQuantity > line.quantity) {
      throw materialRequestApprovedQuantityExceedsRequestedError();
    }
    explicitApprovedQuantity = input.approvedQuantity;
  }

  // Decision + Material Request approval application commit atomically:
  // an APPROVED decision establishes the approved quantity used downstream
  // (default approved = requested when not explicitly changed).
  const pool = getPool();
  const client = await pool.connect();
  let updated: Awaited<ReturnType<typeof procurementApprovalRepository.decideWithClient>>;
  try {
    await client.query('BEGIN');
    updated = await procurementApprovalRepository.decideWithClient(
      client,
      id,
      status,
      notes,
    );
    if (!updated) throw procurementApprovalAlreadyDecidedError();

    if (updated.requestType === 'RFQ') {
      const recommendation = await rfqRecommendationRepository.updateRecommendationStatusWithClient(
        client,
        updated.recommendationId!,
        'PENDING_APPROVAL',
        status === 'APPROVED' ? 'APPROVED' : 'REJECTED',
      );
      if (!recommendation) throw procurementApprovalActionNotAllowedError(action);
      await recordOperationalEvent({
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: 'RFQ_APPROVAL_DECIDED',
        entityType: 'PROCUREMENT_APPROVAL',
        entityId: updated.id,
        actorUserId,
        summary: `RFQ award approval ${status.toLowerCase()}.`,
        metadata: {
          rfqId: updated.rfqId,
          recommendationId: updated.recommendationId,
          approvalId: updated.id,
          decision: status,
        },
      }, client);
    }

    if (status === 'APPROVED') {
      if (updated.requestType === 'MATERIAL_REQUEST') {
        await materialRequestRepository.approve(
          client,
          updated.materialRequestId!,
          explicitApprovedQuantity,
          actorUserId,
        );
      } else if (updated.requestType === 'PURCHASE_REQUEST') {
        // A request-level approval does not explicitly change quantities:
        // every still-OPEN line defaults to approved = requested. Already
        // APPROVED lines keep their approved quantity (freeze preserved).
        await materialRequestRepository.approveAllOpenByPurchaseRequest(
          client,
          updated.purchaseRequestId!,
          actorUserId,
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return toPublic(updated);
}

export async function resolveProcurementApprovalAvailableActions(
  id: string,
  actorUserId: string,
): Promise<ProcurementApprovalAvailableActions> {
  const record = await procurementApprovalRepository.findById(id);
  if (!record) throw procurementApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  const allowed = await resolveAllowedActions(record, actorUserId);
  return {
    approvalId: record.id,
    state: record.status,
    availableActions: PROCUREMENT_APPROVAL_ACTIONS.filter((action) =>
      allowed.has(action),
    ),
  };
}

/**
 * Reuses the authoritative available-actions pattern: only the assigned
 * approver who still holds the capability and whose request is still OPEN may
 * decide.
 */
async function resolveAllowedActions(
  record: ProcurementApprovalRecord,
  actorUserId: string,
): Promise<Set<ProcurementApprovalAction>> {
  const allowed = new Set<ProcurementApprovalAction>();
  if (record.status !== 'PENDING' || record.approverUserId !== actorUserId) {
    return allowed;
  }
  if (!(await canApprove(actorUserId, record.buildingId))) return allowed;
  const target = await resolveRequest(record.requestType, requestId(record));
  if (record.requestType === 'RFQ') {
    if (target.status !== 'CLOSED' || record.approvalType !== 'RFQ_AWARD' || !record.recommendationId) return allowed;
    const recommendation = await rfqRecommendationRepository.findRecommendationById(record.recommendationId);
    if (!recommendation || recommendation.rfqId !== record.rfqId || recommendation.status !== 'PENDING_APPROVAL') return allowed;
  } else if (target.status !== 'OPEN') {
    return allowed;
  }
  allowed.add('APPROVE');
  allowed.add('REJECT');
  return allowed;
}

function isPendingUnique(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint?.startsWith('procurement_approval_') === true &&
    candidate.constraint.endsWith('_pending_unique')
  );
}

export const procurementApprovalService = {
  approveProcurementApproval,
  createProcurementApproval,
  getProcurementApproval,
  listPendingProcurementApprovals,
  rejectProcurementApproval,
  resolveProcurementApprovalAvailableActions,
};
