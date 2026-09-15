import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { documentRepository } from '../documents/document.repository';
import { documentUpdateNotAllowedError } from '../documents/document.errors';
import { documentVersionRepository } from '../document-versions/document-version.repository';
import { userRepository } from '../users';
import { permissionService } from '../permissions';
import { recordOperationalEvent } from '../operational-events';
import {
  documentApprovalAlreadyDecidedError,
  documentApprovalAlreadyPendingError,
  documentApprovalContextInvalidError,
  documentApprovalNotFoundError,
  documentApprovalUnauthorizedError,
} from './document-approval.errors';
import { documentApprovalRepository } from './document-approval.repository';
import type {
  CreateDocumentApprovalInput,
  DocumentApprovalRecord,
  PublicDocumentApproval,
} from './document-approval.types';

function toPublic(record: DocumentApprovalRecord): PublicDocumentApproval {
  const approvalStatus = record.status === 'PENDING' ? 'PENDING' : (record.decision as 'APPROVED' | 'REJECTED');
  return {
    id: record.id,
    documentId: record.documentId,
    versionId: record.versionId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    contextType: record.contextType,
    approvalStatus,
    decision: record.decision,
    reviewerUserId: record.reviewerUserId,
    notes: record.notes,
    reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function getAccessibleClientIds(userId: string): Promise<string[]> {
  const contexts = await resolveBuildingsForUser(userId);
  const ids = new Set<string>();
  for (const c of contexts) if (c.client?.id) ids.add(c.client.id);
  return Array.from(ids);
}
async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  const accessible = await getAccessibleClientIds(userId);
  if (!accessible.includes(clientId)) {
    const { buildingAccessDeniedError } = await import('../context-access/context-access.errors');
    throw buildingAccessDeniedError();
  }
}

async function canActAsApprover(userId: string, buildingId: string | null, clientId: string): Promise<boolean> {
  const user = await userRepository.findById(userId);
  if (!user || user.status !== 'ACTIVE') return false;
  if (buildingId) {
    if (!(await contextAccessService.canAccessBuilding(userId, buildingId))) return false;
  } else {
    const accessible = await getAccessibleClientIds(userId);
    if (!accessible.includes(clientId)) return false;
  }
  const perms = await permissionService.resolvePermissionsForUser(userId);
  // Require document.approve or document.manage as approver authority
  return perms.includes('document.approve') || perms.includes('document.manage');
}

export async function submitForApproval(
  input: CreateDocumentApprovalInput,
  actorUserId: string,
): Promise<PublicDocumentApproval> {
  // Validate document exists
  const doc = await documentRepository.findById(input.documentId);
  if (!doc) throw documentApprovalContextInvalidError();
  if (doc.status === 'ARCHIVED') throw documentUpdateNotAllowedError();
  // If versionId provided, validate version belongs to document
  let versionBuildingId: string | null = null;
  if (input.versionId) {
    const version = await documentVersionRepository.findById(input.versionId);
    if (!version || version.documentId !== input.documentId) throw documentApprovalContextInvalidError();
    versionBuildingId = doc.buildingId; // version inherits document building
  }

  // Isolation check for actor (submitter)
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }

  // Validate approver is authorized
  const canApprove = await canActAsApprover(input.approverUserId, doc.buildingId, doc.clientId);
  if (!canApprove) throw documentApprovalUnauthorizedError();

  // Check if already pending approval for same document/reviewer
  const existingPending = await documentApprovalRepository.findPendingByTargetAndReviewer(
    input.documentId,
    input.versionId ?? null,
    input.approverUserId,
  );
  if (existingPending) throw documentApprovalAlreadyPendingError();

  // Check if document already has a final APPROVED decision? For minimal, we allow new submissions even after approved, but preserve history
  // However final decision cannot be silently overwritten — we just create new pending, not overwrite old
  // So no check here

  const record = await documentApprovalRepository.create({
    documentId: input.documentId,
    versionId: input.versionId ?? null,
    clientId: doc.clientId,
    buildingId: doc.buildingId,
    reviewerUserId: input.approverUserId,
    notes: input.notes ?? null,
    createdByUserId: actorUserId,
  } as any);

  await recordOperationalEvent({
    clientId: doc.clientId,
    buildingId: doc.buildingId,
    entityType: 'DOCUMENT_APPROVAL',
    entityId: record.id,
    eventType: 'DOCUMENT_APPROVAL_SUBMITTED',
    actorUserId,
    summary: `Document ${doc.documentNumber} submitted for approval`,
    metadata: { documentId: input.documentId, versionId: input.versionId ?? null, approverUserId: input.approverUserId },
  });

  return toPublic(record);
}

export async function approve(
  approvalId: string,
  actorUserId: string,
  notes?: string | null,
): Promise<PublicDocumentApproval> {
  return decide(approvalId, 'APPROVED', actorUserId, notes);
}
export async function reject(
  approvalId: string,
  actorUserId: string,
  notes?: string | null,
): Promise<PublicDocumentApproval> {
  return decide(approvalId, 'REJECTED', actorUserId, notes);
}

async function decide(
  approvalId: string,
  decision: 'APPROVED' | 'REJECTED',
  actorUserId: string,
  notes?: string | null,
): Promise<PublicDocumentApproval> {
  const existing = await documentApprovalRepository.findById(approvalId);
  if (!existing) throw documentApprovalNotFoundError();
  const document = await documentRepository.findById(existing.documentId);
  if (!document) throw documentApprovalContextInvalidError();
  if (document.status === 'ARCHIVED') throw documentUpdateNotAllowedError();

  // Isolation check
  if (existing.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  } else {
    await assertClientAccess(actorUserId, existing.clientId);
  }

  // Only authorized approver may decide
  if (existing.reviewerUserId !== actorUserId) throw documentApprovalUnauthorizedError();

  // Final decision cannot be silently overwritten
  if (existing.status !== 'PENDING' || existing.decision !== null) throw documentApprovalAlreadyDecidedError();

  // Also check approver still authorized
  const canApprove = await canActAsApprover(actorUserId, existing.buildingId, existing.clientId);
  if (!canApprove) throw documentApprovalUnauthorizedError();

  const completed = await documentApprovalRepository.completeReview(approvalId, decision, notes ?? null);
  if (!completed) throw documentApprovalAlreadyDecidedError();

  const updated = await documentApprovalRepository.findById(approvalId);
  if (!updated) throw documentApprovalNotFoundError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'DOCUMENT_APPROVAL',
    entityId: updated.id,
    eventType: decision === 'APPROVED' ? 'DOCUMENT_APPROVAL_APPROVED' : 'DOCUMENT_APPROVAL_REJECTED',
    actorUserId,
    summary: `Document approval ${decision}`,
    metadata: { documentId: updated.documentId, versionId: updated.versionId, decision },
  });

  return toPublic(updated);
}

export async function getApprovalStatus(approvalId: string, actorUserId: string): Promise<PublicDocumentApproval> {
  const record = await documentApprovalRepository.findById(approvalId);
  if (!record) throw documentApprovalNotFoundError();
  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  } else {
    await assertClientAccess(actorUserId, record.clientId);
  }
  return toPublic(record);
}

export async function listApprovalHistory(documentId: string, actorUserId: string): Promise<PublicDocumentApproval[]> {
  const doc = await documentRepository.findById(documentId);
  if (!doc) throw documentApprovalContextInvalidError();
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }
  const records = await documentApprovalRepository.listByDocument(documentId);
  return records.map(toPublic);
}

export async function listApprovalsByDocument(documentId: string, actorUserId: string): Promise<PublicDocumentApproval[]> {
  return listApprovalHistory(documentId, actorUserId);
}

export const documentApprovalService = {
  approve,
  getApprovalStatus,
  listApprovalHistory,
  reject,
  submitForApproval,
};
