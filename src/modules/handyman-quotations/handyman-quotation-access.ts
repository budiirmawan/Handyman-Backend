import type { PoolClient } from 'pg';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
} from '../context-access';
import { handymanServiceRequestRepository } from '../handyman-requests';
import type { HandymanQuotationRecord } from './handyman-quotation.types';

/**
 * CR-HM-SEC-01 PART 02 — quotation thread building-scope authority.
 *
 * The quotation row carries `clientId` + `handymanRequestId` but NO
 * `building_id`: a quotation thread's Building is the PARENT REQUEST's
 * `building_id` (server-derived from the immutable CR-HM-01 attribution
 * per CR-HM-02). Every quotation-scoped operation therefore traces the
 * thread to its parent request and enforces the reusable BE-02G guard
 * (`assertBuildingScopedResourceAccess`): explicit ACTIVE assignment to
 * that exact Building resolving under the thread's Client. No same-Client
 * shortcut, no client-wide privilege, no existence leak — a valid but
 * inaccessible Building is denied exactly like an unknown one.
 */
export async function assertQuotationThreadBuildingAccess(
  executor: Pick<PoolClient, 'query'>,
  quotation: Pick<HandymanQuotationRecord, 'clientId' | 'handymanRequestId'>,
  actorUserId: string,
): Promise<void> {
  const request = await handymanServiceRequestRepository.findById(
    executor,
    quotation.handymanRequestId,
  );
  if (!request) {
    // The parent request is the provenance root of the thread; without it
    // the thread cannot be building-scoped. Deny exactly like an
    // inaccessible Building (no existence leak).
    throw buildingAccessDeniedError();
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: quotation.clientId,
    buildingId: request.buildingId,
  });
}
