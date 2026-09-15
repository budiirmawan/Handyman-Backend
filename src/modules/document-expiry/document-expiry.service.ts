import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { documentRepository } from '../documents/document.repository';
import { documentUpdateNotAllowedError } from '../documents/document.errors';
import { documentVersionRepository } from '../document-versions/document-version.repository';
import { recordOperationalEvent } from '../operational-events';
import { getPool } from '../../database';
import { documentNotFoundForVersionError } from '../document-versions/document-version.errors';
import type { PublicDocumentExpiry, ExpiryState } from './document-expiry.types';

const EXPIRING_THRESHOLD_DAYS = 30;

function resolveExpiryState(expiryDate: Date | null): ExpiryState {
  if (!expiryDate) return 'ACTIVE';
  const now = new Date();
  if (expiryDate.getTime() < now.getTime()) return 'EXPIRED';
  const diffDays = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays <= EXPIRING_THRESHOLD_DAYS) return 'EXPIRING';
  return 'ACTIVE';
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

export async function setDocumentExpiry(
  documentId: string,
  expiryDate: Date | null,
  actorUserId: string,
): Promise<PublicDocumentExpiry> {
  const doc = await documentRepository.findById(documentId);
  if (!doc) {
    const { documentNotFoundError } = await import('../documents/document.errors');
    throw documentNotFoundError();
  }
  if (doc.status === 'ARCHIVED') throw documentUpdateNotAllowedError();
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }

  // Update document expiry
  await getPool().query('UPDATE documents SET expiry_date = $2, updated_at = NOW() WHERE id = $1', [documentId, expiryDate]);

  // Preserve history via a new immutable version. Persistence failures must be
  // visible; silently accepting an expiry change without its history is unsafe.
  const maxVersion = await documentVersionRepository.getMaxVersionNumber(documentId);
  await documentVersionRepository.create({
    documentId,
    versionNumber: maxVersion + 1,
    title: doc.title,
    description: doc.description,
    fileReference: doc.fileReference,
    documentType: doc.documentType,
    status: doc.status,
    expiryDate,
    createdByUserId: actorUserId,
  });

  await recordOperationalEvent({
    clientId: doc.clientId,
    buildingId: doc.buildingId,
    entityType: 'DOCUMENT_EXPIRY',
    entityId: documentId,
    eventType: 'DOCUMENT_EXPIRY_UPDATED',
    actorUserId,
    summary: `Document ${doc.documentNumber} expiry updated`,
    metadata: { documentId, expiryDate: expiryDate ? expiryDate.toISOString() : null },
  });

  const expiryState = resolveExpiryState(expiryDate);
  return {
    documentId,
    expiryDate: expiryDate ? expiryDate.toISOString() : null,
    expiryState,
    clientId: doc.clientId,
    buildingId: doc.buildingId,
  };
}

export async function getDocumentExpiry(documentId: string, actorUserId: string): Promise<PublicDocumentExpiry> {
  const doc = await documentRepository.findById(documentId);
  if (!doc) {
    const { documentNotFoundError } = await import('../documents/document.errors');
    throw documentNotFoundError();
  }
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }
  const expiryState = resolveExpiryState(doc.expiryDate);
  return {
    documentId,
    expiryDate: doc.expiryDate ? (doc.expiryDate as Date).toISOString() : null,
    expiryState,
    clientId: doc.clientId,
    buildingId: doc.buildingId,
  };
}

export async function setVersionExpiry(
  versionId: string,
  expiryDate: Date | null,
  actorUserId: string,
): Promise<PublicDocumentExpiry> {
  const version = await documentVersionRepository.findById(versionId);
  if (!version) {
    const { documentVersionNotFoundError } = await import('../document-versions/document-version.errors');
    throw documentVersionNotFoundError();
  }
  const doc = await documentRepository.findById(version.documentId);
  if (!doc) throw documentNotFoundForVersionError();
  if (doc.status === 'ARCHIVED') throw documentUpdateNotAllowedError();
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }

  // Versions are immutable history. Record the expiry change as a new latest
  // snapshot rather than overwriting the addressed version.
  const maxVersion = await documentVersionRepository.getMaxVersionNumber(version.documentId);
  const expiryVersion = await documentVersionRepository.create({
    documentId: version.documentId,
    versionNumber: maxVersion + 1,
    title: version.title,
    description: version.description,
    fileReference: version.fileReference,
    documentType: version.documentType,
    status: version.status,
    expiryDate,
    createdByUserId: actorUserId,
  });
  await getPool().query(
    'UPDATE documents SET expiry_date = $2, updated_at = NOW() WHERE id = $1',
    [version.documentId, expiryDate],
  );

  await recordOperationalEvent({
    clientId: doc.clientId,
    buildingId: doc.buildingId,
    entityType: 'DOCUMENT_VERSION_EXPIRY',
    entityId: expiryVersion.id,
    eventType: 'DOCUMENT_VERSION_EXPIRY_UPDATED',
    actorUserId,
    summary: `Document version ${expiryVersion.versionNumber} created with updated expiry`,
    metadata: {
      documentId: version.documentId,
      sourceVersionId: versionId,
      versionId: expiryVersion.id,
      expiryDate: expiryDate ? expiryDate.toISOString() : null,
    },
  });

  const expiryState = resolveExpiryState(expiryDate);
  return {
    documentId: version.documentId,
    versionId: expiryVersion.id,
    expiryDate: expiryDate ? expiryDate.toISOString() : null,
    expiryState,
    clientId: doc.clientId,
    buildingId: doc.buildingId,
  };
}

export async function getVersionExpiry(versionId: string, actorUserId: string): Promise<PublicDocumentExpiry> {
  const version = await documentVersionRepository.findById(versionId);
  if (!version) {
    const { documentVersionNotFoundError } = await import('../document-versions/document-version.errors');
    throw documentVersionNotFoundError();
  }
  const doc = await documentRepository.findById(version.documentId);
  if (!doc) throw documentNotFoundForVersionError();
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }
  const expiryState = resolveExpiryState(version.expiryDate);
  return {
    documentId: version.documentId,
    versionId,
    expiryDate: version.expiryDate ? (version.expiryDate as Date).toISOString() : null,
    expiryState,
    clientId: doc.clientId,
    buildingId: doc.buildingId,
  };
}

export const documentExpiryService = {
  getDocumentExpiry,
  getVersionExpiry,
  setDocumentExpiry,
  setVersionExpiry,
};
