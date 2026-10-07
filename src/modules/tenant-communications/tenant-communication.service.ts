import { buildingAccessDeniedError, contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantComplaintRepository } from '../tenant-complaints';
import { tenantDocumentRepository } from '../tenant-documents';
import { tenantPicRepository } from '../tenant-pics';
import { tenantServiceRequestRepository } from '../tenant-service-requests';
import { tenantUtilityRequestRepository } from '../tenant-utility-requests';
import { userRepository } from '../users';
import {
  tenantCommunicationAlreadyReadError,
  tenantCommunicationContextInvalidError,
  tenantCommunicationNotDraftError,
  tenantCommunicationNotFoundError,
  tenantCommunicationNotSentError,
  tenantCommunicationRecipientInvalidError,
  tenantCommunicationRelatedInvalidError,
  tenantCommunicationUnauthorizedError,
} from './tenant-communication.errors';
import { tenantCommunicationRepository } from './tenant-communication.repository';
import type {
  CreateTenantCommunicationInput,
  NewTenantCommunication,
  PublicTenantCommunication,
  TenantCommunicationFilters,
  TenantCommunicationRecord,
  TenantCommunicationRelatedType,
  UpdateTenantCommunicationInput,
} from './tenant-communication.types';

type RelatedContext = {
  tenantCompanyId: string;
  clientId: string;
  buildingId: string | null;
};

function relatedId(record: TenantCommunicationRecord): string | null {
  return record.serviceRequestId ?? record.complaintId ??
    record.utilityRequestId ?? record.documentId;
}
function toPublic(record: TenantCommunicationRecord): PublicTenantCommunication {
  return {
    ...record,
    relatedId: relatedId(record),
    sentAt: record.sentAt?.toISOString() ?? null,
    readAt: record.readAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function resolveRelated(
  type: TenantCommunicationRelatedType,
  id: string,
): Promise<RelatedContext> {
  const record = type === 'SERVICE_REQUEST'
    ? await tenantServiceRequestRepository.findById(id)
    : type === 'COMPLAINT'
      ? await tenantComplaintRepository.findById(id)
      : type === 'UTILITY_REQUEST'
        ? await tenantUtilityRequestRepository.findById(id)
        : await tenantDocumentRepository.findById(id);
  if (!record) throw tenantCommunicationRelatedInvalidError();
  return {
    tenantCompanyId: record.tenantCompanyId,
    clientId: record.clientId,
    buildingId: record.buildingId,
  };
}

async function assertBuildingContext(
  tenantCompanyId: string,
  buildingId: string,
  actorUserId: string,
): Promise<void> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  if (!(await tenantBuildingContextRepository.findActive(tenantCompanyId, buildingId))) {
    throw tenantCommunicationContextInvalidError();
  }
}

async function assertRecipient(
  tenantCompanyId: string,
  clientId: string,
  buildingId: string | null,
  recipientTenantPicId: string | undefined,
  recipientUserId: string | undefined,
): Promise<void> {
  if (!recipientTenantPicId && !recipientUserId) {
    throw tenantCommunicationRecipientInvalidError();
  }
  let picUserId: string | null = null;
  if (recipientTenantPicId) {
    const pic = await tenantPicRepository.findById(recipientTenantPicId);
    if (
      !pic ||
      pic.tenantCompanyId !== tenantCompanyId ||
      pic.status !== 'ACTIVE'
    ) {
      throw tenantCommunicationRecipientInvalidError();
    }
    picUserId = pic.userId;
  }
  if (recipientUserId) {
    const user = await userRepository.findById(recipientUserId);
    if (!user || user.status !== 'ACTIVE') {
      throw tenantCommunicationRecipientInvalidError();
    }
    const accessible = buildingId
      ? await contextAccessService.canAccessBuilding(recipientUserId, buildingId)
      : await contextAccessService.canAccessClient(recipientUserId, clientId);
    if (!accessible) throw tenantCommunicationRecipientInvalidError();
    if (recipientTenantPicId && picUserId !== recipientUserId) {
      throw tenantCommunicationRecipientInvalidError();
    }
  }
}

export async function createTenantCommunication(
  input: CreateTenantCommunicationInput,
  actorUserId: string,
): Promise<PublicTenantCommunication> {
  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);

  let buildingId = input.buildingId ?? null;
  let related: RelatedContext | null = null;
  if (input.relatedType && input.relatedId) {
    related = await resolveRelated(input.relatedType, input.relatedId);
    if (
      related.tenantCompanyId !== input.tenantCompanyId ||
      related.clientId !== company.clientId ||
      (buildingId !== null && buildingId !== related.buildingId)
    ) {
      throw tenantCommunicationRelatedInvalidError();
    }
    buildingId = related.buildingId;
  }
  if (buildingId) {
    await assertBuildingContext(input.tenantCompanyId, buildingId, actorUserId);
  }
  await assertRecipient(
    input.tenantCompanyId,
    company.clientId,
    buildingId,
    input.recipientTenantPicId,
    input.recipientUserId,
  );

  const record: NewTenantCommunication = {
    clientId: company.clientId,
    tenantCompanyId: input.tenantCompanyId,
    buildingId,
    senderUserId: actorUserId,
    recipientTenantPicId: input.recipientTenantPicId ?? null,
    recipientUserId: input.recipientUserId ?? null,
    communicationType: input.communicationType,
    subject: input.subject,
    messageBody: input.messageBody,
    relatedType: input.relatedType ?? null,
    serviceRequestId: input.relatedType === 'SERVICE_REQUEST'
      ? input.relatedId! : null,
    complaintId: input.relatedType === 'COMPLAINT' ? input.relatedId! : null,
    utilityRequestId: input.relatedType === 'UTILITY_REQUEST'
      ? input.relatedId! : null,
    documentId: input.relatedType === 'DOCUMENT' ? input.relatedId! : null,
  };
  return toPublic(await tenantCommunicationRepository.create(record));
}

export async function getTenantCommunication(
  id: string,
  actorUserId: string,
): Promise<PublicTenantCommunication> {
  const record = await tenantCommunicationRepository.findById(id);
  if (!record) throw tenantCommunicationNotFoundError();
  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  } else {
    await assertClientAccess(actorUserId, record.clientId);
  }
  return toPublic(record);
}

export async function listTenantCommunications(
  tenantCompanyId: string,
  filters: TenantCommunicationFilters,
  actorUserId: string,
): Promise<PublicTenantCommunication[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await tenantCommunicationRepository.listByTenant(
      tenantCompanyId,
      filters,
      buildingIds,
    )
  ).map(toPublic);
}

export async function updateTenantCommunicationDraft(
  id: string,
  input: UpdateTenantCommunicationInput,
  actorUserId: string,
): Promise<PublicTenantCommunication> {
  const existing = await tenantCommunicationRepository.findById(id);
  if (!existing) throw tenantCommunicationNotFoundError();
  if (existing.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  } else {
    await assertClientAccess(actorUserId, existing.clientId);
  }
  if (existing.senderUserId !== actorUserId) {
    throw tenantCommunicationUnauthorizedError();
  }
  if (existing.status !== 'DRAFT') throw tenantCommunicationNotDraftError();
  const updated = await tenantCommunicationRepository.updateDraft(id, input);
  if (!updated) throw tenantCommunicationNotDraftError();
  return toPublic(updated);
}

export async function sendTenantCommunication(
  id: string,
  actorUserId: string,
): Promise<PublicTenantCommunication> {
  const existing = await tenantCommunicationRepository.findById(id);
  if (!existing) throw tenantCommunicationNotFoundError();
  if (existing.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  } else {
    await assertClientAccess(actorUserId, existing.clientId);
  }
  if (existing.senderUserId !== actorUserId) {
    throw tenantCommunicationUnauthorizedError();
  }
  if (existing.status !== 'DRAFT') throw tenantCommunicationNotDraftError();
  const sent = await tenantCommunicationRepository.markSent(id);
  if (!sent) throw tenantCommunicationNotDraftError();
  await tenantCommunicationRepository.recordOperationalEvent({
    clientId: sent.clientId,
    buildingId: sent.buildingId,
    communicationId: sent.id,
    actorUserId,
    eventType: 'TENANT_COMMUNICATION_SENT',
    summary: 'Tenant communication marked sent',
  });
  return toPublic(sent);
}

export async function readTenantCommunication(
  id: string,
  actorUserId: string,
): Promise<PublicTenantCommunication> {
  const existing = await tenantCommunicationRepository.findById(id);
  if (!existing) throw tenantCommunicationNotFoundError();
  if (existing.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  } else {
    await assertClientAccess(actorUserId, existing.clientId);
  }
  if (existing.status === 'READ') throw tenantCommunicationAlreadyReadError();
  if (existing.status !== 'SENT') throw tenantCommunicationNotSentError();
  const pic = existing.recipientTenantPicId
    ? await tenantPicRepository.findById(existing.recipientTenantPicId)
    : null;
  const authorizedRecipient = existing.recipientUserId === actorUserId ||
    pic?.userId === actorUserId;
  if (!authorizedRecipient) throw tenantCommunicationUnauthorizedError();
  const read = await tenantCommunicationRepository.markRead(id);
  if (!read) throw tenantCommunicationNotSentError();
  await tenantCommunicationRepository.recordOperationalEvent({
    clientId: read.clientId,
    buildingId: read.buildingId,
    communicationId: read.id,
    actorUserId,
    eventType: 'TENANT_COMMUNICATION_READ',
    summary: 'Tenant communication marked read',
  });
  return toPublic(read);
}

export const tenantCommunicationService = {
  createTenantCommunication,
  getTenantCommunication,
  listTenantCommunications,
  readTenantCommunication,
  sendTenantCommunication,
  updateTenantCommunicationDraft,
};
