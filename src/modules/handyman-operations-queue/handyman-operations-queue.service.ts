import { buildingAccessDeniedError } from '../context-access';
import {
  handymanServiceRequestService,
  type PublicHandymanCustomerCareServiceRequest,
} from '../handyman-requests';
import {
  readHandymanRequestStatusVisibility,
  type HandymanStatusVisibilityReadView,
} from '../handyman-sla-status-api';
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

/**
 * Map only authoritative Handyman identities and the existing status read
 * service's assignment/readiness/SLA facts. There is deliberately no
 * WorkOrder lookup: the current Handyman Request and Work Order records have
 * no authoritative relation.
 */
export function toHandymanOperationsQueueItem(
  request: PublicHandymanCustomerCareServiceRequest,
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
    readiness: visibility.stages.readiness,
    slaMilestones: visibility.slaMilestones,
  };
}

/** Read-only, bounded Handyman queue. Both source list and per-item detail
 * reuse existing tenant_company.read authority and exact scope guards. */
export async function listHandymanOperationsQueue(
  actorUserId: string,
  query: HandymanOperationsQueueQuery,
): Promise<HandymanOperationsQueuePage> {
  const page = await handymanServiceRequestService.listHandymanServiceRequestsPage(
    query.filters,
    { limit: query.limit, offset: query.offset },
    actorUserId,
  );

  const items = await Promise.all(
    page.items.map(async (request) => {
      const visibility = await readHandymanRequestStatusVisibility(
        actorUserId,
        request.id,
      );
      return toHandymanOperationsQueueItem(request, visibility);
    }),
  );

  return {
    items,
    pagination: {
      limit: query.limit,
      offset: query.offset,
      nextOffset: page.hasMore ? query.offset + query.limit : null,
    },
  };
}
