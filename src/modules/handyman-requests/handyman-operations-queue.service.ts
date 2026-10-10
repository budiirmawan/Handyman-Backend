import { AppError, ERROR_CODES } from '../../shared/errors';
import {
  handymanOperationsQueueRepository,
  type OperationsQueueRow,
  type OperationsQueueSelection,
} from './handyman-operations-queue.repository';
import type { HandymanServiceRequestStatus } from './handyman-service-request.types';

/**
 * W02 PART 02 — Operations queue service.
 *
 * Read-only. Projects governed request fields plus the Customer Care
 * attribution provenance. Excluded by design: `actorReference` (assertion
 * subject reference), `createdByUserId`, any token/exchange/assertion
 * material, and tenant PIC contact data. Reporter, PIC approval, cancel, and
 * notification are out of scope for this PART.
 */

export type OperationsRequestPublic = {
  id: string;
  clientId: string;
  status: HandymanServiceRequestStatus;
  description: string;
  createdAt: string;
  updatedAt: string;
  tenant: { id: string; code: string; name: string; picId: string | null };
  location: {
    propertyId: string;
    propertyName: string;
    buildingId: string;
    buildingCode: string;
    buildingName: string;
    spaceId: string | null;
    spaceCode: string | null;
    spaceName: string | null;
  };
  service: { catalogId: string; catalogName: string; variantId: string | null };
  attribution: {
    originChannel: string;
    actorType: string;
    careActorId: string | null;
    createdAt: string;
  };
};

export type OperationsRequestPage = {
  items: OperationsRequestPublic[];
  nextCursor: string | null;
};

export function toOperationsRequestPublic(
  row: OperationsQueueRow,
): OperationsRequestPublic {
  return {
    id: row.id,
    clientId: row.clientId,
    status: row.status,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tenant: {
      id: row.tenantCompanyId,
      code: row.tenantCode,
      name: row.tenantName,
      picId: row.tenantPicId,
    },
    location: {
      propertyId: row.propertyId,
      propertyName: row.propertyName,
      buildingId: row.buildingId,
      buildingCode: row.buildingCode,
      buildingName: row.buildingName,
      spaceId: row.spaceId,
      spaceCode: row.spaceCode,
      spaceName: row.spaceName,
    },
    service: {
      catalogId: row.serviceCatalogId,
      catalogName: row.serviceCatalogName,
      variantId: row.serviceVariantId,
    },
    attribution: {
      originChannel: row.originChannel,
      actorType: row.actorType,
      careActorId: row.careActorId,
      createdAt: row.attributionCreatedAt.toISOString(),
    },
  };
}

/** Lists the actor's Building-scoped queue, oldest first (FIFO). */
export async function listOperationsRequests(
  input: Omit<OperationsQueueSelection, 'actorUserId'>,
  actorUserId: string,
): Promise<OperationsRequestPage> {
  const rows = await handymanOperationsQueueRepository.listOperationsQueue({
    ...input,
    actorUserId,
  });
  const items = rows.slice(0, input.limit);
  let nextCursor: string | null = null;
  if (rows.length > input.limit) {
    const last = items[items.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify({ c: last.cursorCreatedAt, i: last.id }),
    ).toString('base64url');
  }
  return { items: items.map(toOperationsRequestPublic), nextCursor };
}

/**
 * Detail for triage. Unknown and out-of-scope requests return the same 404,
 * so existence is not leaked across Buildings.
 */
export async function getOperationsRequestDetail(
  id: string,
  actorUserId: string,
): Promise<OperationsRequestPublic> {
  const row = await handymanOperationsQueueRepository.findOperationsRequestById(
    actorUserId,
    id,
  );
  if (!row) {
    throw new AppError({
      code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_FOUND,
      message: 'Handyman service request not found.',
      statusCode: 404,
    });
  }
  return toOperationsRequestPublic(row);
}

export const handymanOperationsQueueService = {
  getOperationsRequestDetail,
  listOperationsRequests,
};
