import { AppError, ERROR_CODES } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
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
 * material, and tenant PIC contact data. The intake reporter/contact snapshot
 * IS exposed (W02 PART 03) because triage needs it; it grants no authority.
 * Reporter, PIC approval, cancel, and
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
  /** W02 PART 03 — reporter/contact snapshot recorded at intake; null when the
   * intake carried no reporter. Data for triage only; not an authority. */
  contact: OperationsRequestContact | null;
};

export type OperationsRequestContact = {
  capturedAt: string;
  reporter: { name: string; phone: string | null; email: string | null };
  contactPerson: { name: string; phone: string | null; email: string | null } | null;
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
    contact: toOperationsContact(row),
  };
}

function toOperationsContact(row: OperationsQueueRow): OperationsRequestContact | null {
  if (row.contactCapturedAt === null || row.reporterName === null) return null;
  return {
    capturedAt: row.contactCapturedAt.toISOString(),
    reporter: {
      name: row.reporterName,
      phone: row.reporterPhone,
      email: row.reporterEmail,
    },
    contactPerson: row.contactPersonName === null ? null : {
      name: row.contactPersonName,
      phone: row.contactPersonPhone,
      email: row.contactPersonEmail,
    },
  };
}

/**
 * W02 PART 02A — explicit denial for a caller with no ACTIVE Building
 * assignment (the permission alone is not enough). Uses the existing
 * Building resolver; no new authority source.
 */
async function assertHasOperationsBuildingScope(actorUserId: string): Promise<void> {
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  if (buildingIds.length === 0) throw buildingAccessDeniedError();
}

/** Lists the actor's Building-scoped queue, oldest first (FIFO). */
export async function listOperationsRequests(
  input: Omit<OperationsQueueSelection, 'actorUserId'>,
  actorUserId: string,
): Promise<OperationsRequestPage> {
  await assertHasOperationsBuildingScope(actorUserId);
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
  await assertHasOperationsBuildingScope(actorUserId);
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
