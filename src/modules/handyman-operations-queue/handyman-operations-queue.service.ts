import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  readHandymanRequestStatusVisibility,
  type HandymanStatusVisibilityReadView,
} from '../handyman-sla-status-api';
import { handymanOperationsQueueRepository } from './handyman-operations-queue.repository';
import type { HandymanOperationsQueueQuery } from './handyman-operations-queue.validation';

export type HandymanOperationsQueueItem = {
  /** The authoritative Handyman request id; this is not a Work Order id. */
  handymanRequestId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  createdAt: string;
  executionScopeId: string | null;
  lifecycle: {
    requestStatus: string;
    triageOutcome: string | null;
    diagnosisStatus: string | null;
    referralType: string | null;
    executionScopeStatus: string | null;
  };
  assignment: HandymanStatusVisibilityReadView['stages']['assignment'];
  inspectorAssignment: HandymanStatusVisibilityReadView['stages']['inspectorAssignment'];
  readiness: HandymanStatusVisibilityReadView['stages']['readiness'];
  slaMilestones: HandymanStatusVisibilityReadView['slaMilestones'];
};

export type HandymanOperationsQueuePage = {
  items: HandymanOperationsQueueItem[];
  pagination: {
    limit: number;
    offset: number;
    nextOffset: number | null;
  };
};

/** Minimal authoritative lineage the queue item is keyed by. The queue
 * discovery repository supplies exactly these server-owned columns. */
export type HandymanOperationsQueueRequestRef = {
  id: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  createdAt: string;
};

/**
 * Map only authoritative Handyman identities and the existing status read
 * service's assignment/readiness/SLA facts. There is deliberately no
 * WorkOrder lookup: the current Handyman Request and Work Order records have
 * no authoritative relation.
 */
export function toHandymanOperationsQueueItem(
  request: HandymanOperationsQueueRequestRef,
  visibility: HandymanStatusVisibilityReadView,
): HandymanOperationsQueueItem {
  if (
    visibility.handymanRequestId !== request.id ||
    visibility.clientId !== request.clientId ||
    visibility.buildingId !== request.buildingId
  ) {
    // Fail closed if the status projection ever resolves a different lineage.
    throw buildingAccessDeniedError();
  }

  return {
    handymanRequestId: request.id,
    clientId: request.clientId,
    buildingId: request.buildingId,
    tenantCompanyId: request.tenantCompanyId,
    createdAt: request.createdAt,
    executionScopeId: visibility.executionScopeId,
    lifecycle: {
      requestStatus: visibility.stages.request.status,
      triageOutcome: visibility.stages.request.triageOutcome,
      diagnosisStatus: visibility.stages.request.diagnosisStatus,
      referralType: visibility.stages.request.referralType,
      executionScopeStatus: visibility.stages.executionScope.status,
    },
    assignment: visibility.stages.assignment,
    inspectorAssignment: visibility.stages.inspectorAssignment,
    readiness: visibility.stages.readiness,
    slaMilestones: visibility.slaMilestones,
  };
}

/**
 * CR-HM-OPS-INBOX-BE-01 P0-A — Operations queue discovery.
 *
 * Discovery authority is the genuine Operations scope: the route's existing
 * `tenant_company.read` permission plus the actor's explicit ACTIVE Building
 * assignment under the queried Client (BE-02G exact-Building wall, applied
 * per row inside the repository statement). Operations users are NOT required
 * to be Tenant PICs and never inherit customer occupancy authority — the
 * Customer Care C6 wall remains the authority of the customer-facing Handyman
 * reads and is deliberately untouched.
 *
 * A supplied Building filter is additionally checked against the actor's
 * exact Client + Building assignment before querying, so a same-Client
 * sibling Building is denied (403) exactly like an unknown one; a Client the
 * actor cannot reach through any assigned Building is denied identically.
 * Authorization always precedes exposure — cross-tenant queries return no
 * data. Fan-out is prevented by the repository's one-row-per-request query.
 */
export async function listHandymanOperationsQueue(
  actorUserId: string,
  query: HandymanOperationsQueueQuery,
): Promise<HandymanOperationsQueuePage> {
  const { filters, limit, offset } = query;
  if (!isValidUuid(filters.clientId)) {
    throw AppError.validation('Request query validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  if (filters.buildingId !== undefined) {
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: filters.clientId,
      buildingId: filters.buildingId,
    });
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, filters.clientId))) {
    throw buildingAccessDeniedError();
  }

  const page = await handymanOperationsQueueRepository.listOperationsQueueRequests(
    undefined,
    filters,
    actorUserId,
    { limit, offset },
  );

  const items = await Promise.all(
    page.rows.map(async (request) => {
      const visibility = await readHandymanRequestStatusVisibility(
        actorUserId,
        request.handymanRequestId,
      );
      return toHandymanOperationsQueueItem(
        {
          id: request.handymanRequestId,
          clientId: request.clientId,
          buildingId: request.buildingId,
          tenantCompanyId: request.tenantCompanyId,
          createdAt: request.createdAt.toISOString(),
        },
        visibility,
      );
    }),
  );

  return {
    items,
    pagination: {
      limit,
      offset,
      nextOffset: page.hasMore ? offset + limit : null,
    },
  };
}
