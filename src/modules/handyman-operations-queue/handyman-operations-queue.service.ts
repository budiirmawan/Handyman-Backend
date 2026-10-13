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

/** CR-HM-DB-OPT-01 — max queue items whose status projection is resolved
 * concurrently. Kept small relative to the default pool size (10) because each
 * item's projection itself fans out several parallel point lookups. */
const VISIBILITY_BATCH_SIZE = 4;

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

  // CR-HM-DB-OPT-01 PART 01 — the per-item status projection fans out many
  // small point lookups. Resolving every page item in one unbounded
  // Promise.all can stampede the shared pool (limit ≤ 50 items × ~25 queries).
  // Resolve in small concurrent batches instead: identical output and order,
  // bounded pool pressure.
  const items: HandymanOperationsQueueItem[] = [];
  for (let i = 0; i < page.items.length; i += VISIBILITY_BATCH_SIZE) {
    const batch = page.items.slice(i, i + VISIBILITY_BATCH_SIZE);
    const resolved = await Promise.all(
      batch.map(async (request) => {
        const visibility = await readHandymanRequestStatusVisibility(
          actorUserId,
          request.id,
        );
        return toHandymanOperationsQueueItem(request, visibility);
      }),
    );
    items.push(...resolved);
  }

  return {
    items,
    pagination: {
      limit: query.limit,
      offset: query.offset,
      nextOffset: page.hasMore ? query.offset + query.limit : null,
    },
  };
}
