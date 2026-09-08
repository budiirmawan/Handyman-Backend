import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { documentRepository } from '../documents/document.repository';
import { documentUpdateNotAllowedError } from '../documents/document.errors';
import { recordOperationalEvent } from '../operational-events';
import { getPool } from '../../database';
import {
  documentNotFoundForVersionError,
  documentVersionInvalidSequenceError,
  documentVersionNotFoundError,
} from './document-version.errors';
import { documentVersionRepository } from './document-version.repository';
import type { CreateDocumentVersionInput, DocumentVersionRecord, PublicDocumentVersion } from './document-version.types';

function toPublic(record: DocumentVersionRecord): PublicDocumentVersion {
  return {
    id: record.id,
    documentId: record.documentId,
    versionNumber: record.versionNumber,
    title: record.title,
    description: record.description,
    fileReference: record.fileReference,
    documentType: record.documentType,
    status: record.status,
    expiryDate: record.expiryDate ? (record.expiryDate as Date).toISOString() : null,
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

async function assertDocumentAccess(userId: string, documentId: string): Promise<{ clientId: string; buildingId: string | null }> {
  const doc = await documentRepository.findById(documentId);
  if (!doc) throw documentNotFoundForVersionError();
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, doc.buildingId);
  } else {
    await assertClientAccess(userId, doc.clientId);
  }
  return { clientId: doc.clientId, buildingId: doc.buildingId };
}

export async function createDocumentVersion(
  documentId: string,
  input: CreateDocumentVersionInput,
  actorUserId: string,
): Promise<PublicDocumentVersion> {
  const doc = await documentRepository.findById(documentId);
  if (!doc) throw documentNotFoundForVersionError();
  if (doc.status === 'ARCHIVED' || input.status === 'ARCHIVED') {
    throw documentUpdateNotAllowedError();
  }

  // Isolation check
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }

  // Determine next version number (preserve history, previous must not be overwritten)
  const maxVersion = await documentVersionRepository.getMaxVersionNumber(documentId);
  const nextVersion = maxVersion + 1;

  // If no history yet, we need to ensure version 1 exists as snapshot of current document
  // But our migration seeds version 1 for existing docs; for docs created after migration,
  // we should create version 1 lazily if missing, then next will be 2 etc.
  // Simpler: if max is 0, we treat next as 1 and snapshot current doc with overrides

  // Resolve snapshot values: use input overrides or fall back to current document
  const title = input.title !== undefined ? (input.title as string) : doc.title;
  const description = input.description !== undefined ? input.description : doc.description;
  const fileReference = input.fileReference !== undefined ? input.fileReference : doc.fileReference;
  const documentType = input.documentType ?? doc.documentType;
  const status = input.status ?? doc.status;
  const expiryDate = (input as any).expiryDate !== undefined ? (input as any).expiryDate : (doc as any).expiryDate ?? null;

  // Basic validation: title must not be empty if provided
  if (typeof title === 'string' && title.trim() === '') {
    throw documentVersionInvalidSequenceError();
  }

  // Create version
  let record: DocumentVersionRecord;
  try {
    record = await documentVersionRepository.create({
      documentId,
      versionNumber: nextVersion,
      title: title as string,
      description: description as string | null,
      fileReference: fileReference as string | null,
      documentType: documentType as string,
      status: status as string,
      expiryDate: expiryDate as Date | null,
      createdByUserId: actorUserId,
    });
  } catch (error) {
    if (isVersionUniqueViolation(error)) throw documentVersionInvalidSequenceError();
    throw error;
  }

  // Track current/latest: update parent document to reflect latest version (so document table stays in sync)
  // This preserves that latest version resolution matches parent document state
  await getPool().query(
    `UPDATE documents SET title = $2, description = $3, file_reference = $4, document_type = $5, status = $6, expiry_date = $7, updated_at = NOW() WHERE id = $1`,
    [documentId, title, description, fileReference, documentType, status, expiryDate as Date | null],
  );

  await recordOperationalEvent({
    clientId: doc.clientId,
    buildingId: doc.buildingId,
    entityType: 'DOCUMENT_VERSION',
    entityId: record.id,
    eventType: 'DOCUMENT_VERSION_CREATED',
    actorUserId,
    summary: `Document ${doc.documentNumber} version ${nextVersion} created`,
    metadata: {
      documentId,
      versionId: record.id,
      versionNumber: nextVersion,
      title,
    },
  });

  return toPublic(record);
}

export async function getDocumentVersion(versionId: string, actorUserId: string): Promise<PublicDocumentVersion> {
  const record = await documentVersionRepository.findById(versionId);
  if (!record) throw documentVersionNotFoundError();
  // Isolation via parent document
  await assertDocumentAccess(actorUserId, record.documentId);
  return toPublic(record);
}

export async function getDocumentVersionByNumber(
  documentId: string,
  versionNumber: number,
  actorUserId: string,
): Promise<PublicDocumentVersion> {
  const record = await documentVersionRepository.findByDocumentAndVersion(documentId, versionNumber);
  if (!record) throw documentVersionNotFoundError();
  await assertDocumentAccess(actorUserId, documentId);
  return toPublic(record);
}

export async function listDocumentVersions(documentId: string, actorUserId: string): Promise<PublicDocumentVersion[]> {
  const doc = await documentRepository.findById(documentId);
  if (!doc) throw documentNotFoundForVersionError();
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }
  const records = await documentVersionRepository.listByDocument(documentId);
  // If no versions yet (should not happen due to seed, but handle lazily create version 1 snapshot)
  if (records.length === 0) {
    // Create implicit version 1 from current document state for history preservation
    const implicit = await documentVersionRepository.create({
      documentId,
      versionNumber: 1,
      title: doc.title,
      description: doc.description,
      fileReference: doc.fileReference,
      documentType: doc.documentType,
      status: doc.status,
      expiryDate: (doc as any).expiryDate ?? null,
      createdByUserId: doc.createdByUserId,
    });
    return [toPublic(implicit)];
  }
  return records.map(toPublic);
}

export async function resolveLatestVersion(documentId: string, actorUserId: string): Promise<PublicDocumentVersion> {
  const doc = await documentRepository.findById(documentId);
  if (!doc) throw documentNotFoundForVersionError();
  if (doc.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, doc.buildingId);
  } else {
    await assertClientAccess(actorUserId, doc.clientId);
  }
  let latest = await documentVersionRepository.findLatestByDocument(documentId);
  if (!latest) {
    // Lazily create version 1 if missing
    const created = await documentVersionRepository.create({
      documentId,
      versionNumber: 1,
      title: doc.title,
      description: doc.description,
      fileReference: doc.fileReference,
      documentType: doc.documentType,
      status: doc.status,
      expiryDate: (doc as any).expiryDate ?? null,
      createdByUserId: doc.createdByUserId,
    });
    latest = created;
  }
  return toPublic(latest);
}

function isVersionUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const c = error as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'document_versions_document_version_unique';
}

export const documentVersionService = {
  createDocumentVersion,
  getDocumentVersion,
  getDocumentVersionByNumber,
  listDocumentVersions,
  resolveLatestVersion,
};
