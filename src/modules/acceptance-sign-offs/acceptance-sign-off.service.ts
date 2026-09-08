import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { userRepository } from '../users';
import { bastDocumentRepository } from '../bast-documents/bast-document.repository';
import { handoverDocumentRepository } from '../handover-documents/handover-document.repository';
import { documentRepository } from '../documents/document.repository';
import { documentUpdateNotAllowedError } from '../documents/document.errors';
import { recordOperationalEvent } from '../operational-events';
import {
  acceptanceDocumentNotFoundError,
  acceptanceInvalidContextError,
  acceptanceSignOffNotFoundError,
  acceptanceUnauthorizedSignerError,
} from './acceptance-sign-off.errors';
import { acceptanceSignOffRepository } from './acceptance-sign-off.repository';
import type {
  AcceptanceSignOffFilters,
  AcceptanceSignOffRecord,
  CreateAcceptanceSignOffInput,
  PublicAcceptanceSignOff,
} from './acceptance-sign-off.types';

function toPublic(record: AcceptanceSignOffRecord): PublicAcceptanceSignOff {
  return {
    id: record.id,
    bastDocumentId: record.bastDocumentId,
    handoverDocumentId: record.handoverDocumentId,
    bastSubmissionAttemptId: record.bastSubmissionAttemptId,
    documentVersionId: record.documentVersionId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    contextType: record.contextType,
    decision: record.decision,
    signerUserId: record.signerUserId,
    notes: record.notes,
    signedAt: record.signedAt.toISOString(),
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

async function isAuthorizedSigner(signerUserId: string, buildingId: string): Promise<boolean> {
  const user = await userRepository.findById(signerUserId);
  if (!user || user.status !== 'ACTIVE') return false;
  // Must have building access (authoritative isolation)
  const canAccess = await contextAccessService.canAccessBuilding(signerUserId, buildingId);
  if (!canAccess) return false;
  // Optionally check permission document.manage / document.read ? For minimal, building access is enough.
  // But we also ensure signer has at least document.read permission to be considered authorized.
  // Reuse permission check via permissionService if needed.
  // For now, building access + active user is considered authorized.
  return true;
}

export async function submitAcceptanceSignOff(
  input: CreateAcceptanceSignOffInput,
  actorUserId: string,
): Promise<PublicAcceptanceSignOff> {
  if (input.bastDocumentId) {
    throw acceptanceInvalidContextError(
      'BAST decisions must use the canonical /bast-documents/:id/decisions command',
    );
  }

  // Resolve target BAST or Handover
  let target: {
    clientId: string;
    buildingId: string;
    contextType: 'INTERNAL' | 'TENANT' | 'VENDOR';
    documentId: string;
  } | null = null;
  let bastDocumentId: string | null = null;
  let handoverDocumentId: string | null = null;

  if (input.bastDocumentId) {
    const bd = await bastDocumentRepository.findById(input.bastDocumentId);
    if (!bd) throw acceptanceDocumentNotFoundError();
    target = {
      clientId: bd.clientId,
      buildingId: bd.buildingId,
      contextType: bd.contextType as any,
      documentId: bd.documentId,
    };
    bastDocumentId = bd.id;
  } else if (input.handoverDocumentId) {
    const hd = await handoverDocumentRepository.findById(input.handoverDocumentId);
    if (!hd) throw acceptanceDocumentNotFoundError();
    target = {
      clientId: hd.clientId,
      buildingId: hd.buildingId,
      contextType: hd.contextType as any,
      documentId: hd.documentId,
    };
    handoverDocumentId = hd.id;
  } else {
    throw acceptanceInvalidContextError('Provide bastDocumentId or handoverDocumentId.');
  }

  if (!target) throw acceptanceInvalidContextError();
  const targetDocument = await documentRepository.findById(target.documentId);
  if (!targetDocument) throw acceptanceDocumentNotFoundError();
  if (targetDocument.status === 'ARCHIVED') throw documentUpdateNotAllowedError();

  // Validate building access for actor (RBAC + isolation)
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);

  // Validate signer is authorized (must have building access and be active)
  // Actor is the signer in this model (signer = actor)
  const signerUserId = actorUserId;
  const authorized = await isAuthorizedSigner(signerUserId, target.buildingId);
  if (!authorized) throw acceptanceUnauthorizedSignerError();

  // Validate decision is valid (already via validation, but re-check)
  if (input.decision !== 'ACCEPTED' && input.decision !== 'REJECTED') {
    throw acceptanceInvalidContextError('Invalid decision.');
  }

  // For BAST, we could check that BAST is in SUBMITTED state before ACCEPTED/REJECTED, but minimal allows any
  // Preserve history: allow multiple sign-offs per target (no unique constraint)

  const record = await acceptanceSignOffRepository.create({
    bastDocumentId,
    handoverDocumentId,
    clientId: target.clientId,
    buildingId: target.buildingId,
    contextType: target.contextType,
    decision: input.decision,
    signerUserId,
    notes: input.notes ?? null,
  });

  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    entityType: 'ACCEPTANCE_SIGN_OFF',
    entityId: record.id,
    eventType: input.decision === 'ACCEPTED' ? 'ACCEPTANCE_SIGNED_ACCEPTED' : 'ACCEPTANCE_SIGNED_REJECTED',
    actorUserId: signerUserId,
    summary: `Acceptance ${input.decision} by ${signerUserId} for ${bastDocumentId ? 'BAST ' + bastDocumentId : 'Handover ' + handoverDocumentId}`,
    metadata: {
      bastDocumentId,
      handoverDocumentId,
      decision: input.decision,
      signerUserId,
    },
  });

  return toPublic(record);
}

export async function getAcceptanceSignOff(id: string, actorUserId: string): Promise<PublicAcceptanceSignOff> {
  const record = await acceptanceSignOffRepository.findById(id);
  if (!record) throw acceptanceSignOffNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}

export async function listAcceptanceSignOffs(
  filters: AcceptanceSignOffFilters,
  actorUserId: string,
): Promise<PublicAcceptanceSignOff[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  if (filters.clientId) await assertClientAccess(actorUserId, filters.clientId);
  if (filters.bastDocumentId) {
    const bd = await bastDocumentRepository.findById(filters.bastDocumentId);
    if (!bd) throw acceptanceDocumentNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, bd.buildingId);
  }
  if (filters.handoverDocumentId) {
    const hd = await handoverDocumentRepository.findById(filters.handoverDocumentId);
    if (!hd) throw acceptanceDocumentNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, hd.buildingId);
  }

  const accessibleBuildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);
  const records = await acceptanceSignOffRepository.list(filters, accessibleBuildingIds, accessibleClientIds);
  return records.map(toPublic);
}

export const acceptanceSignOffService = {
  getAcceptanceSignOff,
  listAcceptanceSignOffs,
  submitAcceptanceSignOff,
};
