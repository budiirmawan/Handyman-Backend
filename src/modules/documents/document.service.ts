import { randomUUID } from 'node:crypto';
import { buildingRepository } from '../buildings';
import { clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { propertyRepository } from '../properties';
import { tenantCompanyRepository } from '../tenant-companies';
import { vendorRepository } from '../vendors';
import { getPool } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import {
  documentAlreadyArchivedError,
  documentBuildingMismatchError,
  documentContextInvalidError,
  documentNotArchivedError,
  documentNotFoundError,
  documentRestoreNotAllowedError,
  documentNumberAlreadyExistsError,
  documentSourceClientMismatchError,
  documentSourceNotFoundError,
  documentUpdateNotAllowedError,
} from './document.errors';
import { documentRepository } from './document.repository';
import type {
  CreateDocumentInput,
  DocumentFilters,
  DocumentRecord,
  NewDocument,
  PublicDocument,
  UpdateDocumentInput,
} from './document.types';

function toPublic(record: DocumentRecord): PublicDocument {
  return {
    ...record,
    expiryDate: record.expiryDate ? (record.expiryDate as Date).toISOString() : null,
    archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function getAccessibleClientIds(userId: string): Promise<string[]> {
  const contexts = await resolveBuildingsForUser(userId);
  const ids = new Set<string>();
  for (const c of contexts) {
    if (c.client?.id) ids.add(c.client.id);
  }
  return Array.from(ids);
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  const accessible = await getAccessibleClientIds(userId);
  if (!accessible.includes(clientId)) {
    // Reuse building access denied to avoid leaking client existence when no assignment
    const { buildingAccessDeniedError } = await import('../context-access/context-access.errors');
    throw buildingAccessDeniedError();
  }
}

async function assertBuildingClientMatch(
  buildingId: string,
  clientId: string,
): Promise<void> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    const { buildingNotFoundError } = await import('../buildings/building.errors');
    throw buildingNotFoundError();
  }
  const property = await propertyRepository.findById(building.propertyId);
  if (!property || property.clientId !== clientId) {
    throw documentBuildingMismatchError();
  }
}

/**
 * Validates context/source invariants and building/client coherence.
 * Throws DOCUMENT_CONTEXT_INVALID or DOCUMENT_SOURCE_* on violation.
 * This is the single authority for ONE document foundation invariants.
 */
async function assertContextAndSource(
  input: CreateDocumentInput,
): Promise<void> {
  const { contextType, sourceType, sourceId } = input;

  // Source pairing already validated in parsing, but re-check for service-level safety
  const hasSourceType = sourceType !== undefined && sourceType !== null;
  const hasSourceId = sourceId !== undefined && sourceId !== null && sourceId !== '';
  if (hasSourceType !== hasSourceId) {
    throw documentContextInvalidError('sourceType and sourceId must be provided together.');
  }

  if (contextType === 'INTERNAL') {
    if (hasSourceType && sourceType !== 'INTERNAL') {
      throw documentContextInvalidError('INTERNAL context only allows INTERNAL sourceType or no source.');
    }
    // INTERNAL requires no cross-entity check; sourceId if present would be internal reference
    // but we allow null source for pure internal docs.
    return;
  }

  if (contextType === 'TENANT') {
    if (!hasSourceType || sourceType !== 'TENANT_COMPANY' || !hasSourceId) {
      throw documentContextInvalidError('TENANT context requires TENANT_COMPANY source.');
    }
    const company = await tenantCompanyRepository.findById(sourceId as string);
    if (!company) throw documentSourceNotFoundError();
    if (company.clientId !== input.clientId) throw documentSourceClientMismatchError();
    return;
  }

  if (contextType === 'VENDOR') {
    if (!hasSourceType || sourceType !== 'VENDOR' || !hasSourceId) {
      throw documentContextInvalidError('VENDOR context requires VENDOR source.');
    }
    const vendor = await vendorRepository.findById(sourceId as string);
    if (!vendor) throw documentSourceNotFoundError();
    if (vendor.clientId !== input.clientId) throw documentSourceClientMismatchError();
    return;
  }

  throw documentContextInvalidError('Unknown context type.');
}

export async function createDocument(
  input: CreateDocumentInput,
  actorUserId: string,
): Promise<PublicDocument> {
  // ARCHIVED is a lifecycle state and can only be entered through the archive action.
  if (input.status === 'ARCHIVED') throw documentUpdateNotAllowedError();

  // Validate client exists
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    const { clientNotFoundError } = await import('../clients/client.errors');
    throw clientNotFoundError();
  }

  // Validate building/client coherence if building provided
  if (input.buildingId !== undefined && input.buildingId !== null) {
    await assertBuildingClientMatch(input.buildingId, input.clientId);
    await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);
  } else {
    await assertClientAccess(actorUserId, input.clientId);
  }

  await assertContextAndSource(input);

  // Unique number per client
  const existing = await documentRepository.findByClientAndNumber(
    input.clientId,
    input.documentNumber,
  );
  if (existing) throw documentNumberAlreadyExistsError();

  const newDoc: NewDocument = {
    clientId: input.clientId,
    buildingId: input.buildingId ?? null,
    documentNumber: input.documentNumber,
    documentType: input.documentType,
    contextType: input.contextType,
    sourceType: (input.sourceType as unknown as NewDocument['sourceType']) ?? null,
    sourceId: input.sourceId ?? null,
    title: input.title,
    description: input.description ?? null,
    fileReference: input.fileReference ?? null,
    status: input.status ?? 'DRAFT',
    expiryDate: input.expiryDate ?? null,
    createdByUserId: actorUserId,
  };

  try {
    const record = await documentRepository.create(newDoc);
    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      entityType: 'DOCUMENT',
      entityId: record.id,
      eventType: 'DOCUMENT_CREATED',
      actorUserId,
      summary: `Document ${record.documentNumber} created`,
      metadata: {
        documentNumber: record.documentNumber,
        documentType: record.documentType,
        contextType: record.contextType,
        sourceType: record.sourceType,
        sourceId: record.sourceId,
      },
    });
    // BE-22G — every Document starts with an immutable history baseline.
    // Do not hide persistence failures: returning a Document without version 1
    // would violate the document-history contract.
    await getPool().query(
      `INSERT INTO document_versions
         (id, document_id, version_number, title, description, file_reference, document_type, status, expiry_date, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (document_id, version_number) DO NOTHING`,
      [
        randomUUID(),
        record.id,
        1,
        record.title,
        record.description,
        record.fileReference,
        record.documentType,
        record.status,
        record.expiryDate,
        actorUserId,
      ],
    );
    return toPublic(record);
  } catch (error) {
    if (isDocumentNumberUniqueViolation(error)) throw documentNumberAlreadyExistsError();
    throw error;
  }
}

export async function getDocument(
  id: string,
  actorUserId: string,
): Promise<PublicDocument> {
  const record = await documentRepository.findById(id);
  if (!record) throw documentNotFoundError();

  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  } else {
    await assertClientAccess(actorUserId, record.clientId);
  }

  return toPublic(record);
}

export async function listDocuments(
  filters: DocumentFilters,
  actorUserId: string,
): Promise<PublicDocument[]> {
  // If filters narrow to specific building/client, assert access first
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  if (filters.clientId) {
    await assertClientAccess(actorUserId, filters.clientId);
  } else if (filters.buildingId) {
    // already checked building; client derived from building but still need to ensure
    // building check passed
  }

  // For building/client scoped isolation, resolve accessible sets
  const accessibleBuildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);

  // If filtering by building/client, the isolation clause in repo will additionally scope,
  // but we already asserted specific access above.
  const records = await documentRepository.list(filters, accessibleBuildingIds, accessibleClientIds);
  return records.map(toPublic);
}

export async function updateDocument(
  id: string,
  input: UpdateDocumentInput,
  actorUserId: string,
): Promise<PublicDocument> {
  const existing = await documentRepository.findById(id);
  if (!existing) throw documentNotFoundError();

  // Isolation check on existing record
  if (existing.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  } else {
    await assertClientAccess(actorUserId, existing.clientId);
  }

  const canonicalBastDocument =
    await documentRepository.isCanonicalBastDocument(existing.id);
  if (
    canonicalBastDocument &&
    ((input.documentType !== undefined && input.documentType !== 'BAST') ||
      (input.buildingId !== undefined &&
        input.buildingId !== existing.buildingId))
  ) {
    // Once linked, identity and Building scope are controlled by the canonical
    // BAST aggregate rather than by the generic Document update endpoint.
    throw documentUpdateNotAllowedError();
  }

  // "update while allowed" — for BE-22A minimal, DRAFT and ACTIVE are mutable, INACTIVE is not
  if (existing.status === 'INACTIVE' || existing.status === 'ARCHIVED') {
    throw documentUpdateNotAllowedError();
  }
  // Archive metadata must only be established by the dedicated archive action.
  if (input.status === 'ARCHIVED') throw documentUpdateNotAllowedError();

  // If buildingId is being changed, validate new building/client match and access
  if (input.buildingId !== undefined) {
    if (input.buildingId !== null) {
      await assertBuildingClientMatch(input.buildingId, existing.clientId);
      await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);
    } else {
      // clearing building: need client access (already checked) — no extra mismatch
    }
  }

  // If status is being changed, validate allowed values already via parsing; no archiving yet
  // No version/expiry logic in BE-22A

  const updated = await documentRepository.update(id, input);
  if (!updated) throw documentNotFoundError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'DOCUMENT',
    entityId: updated.id,
    eventType: 'DOCUMENT_UPDATED',
    actorUserId,
    summary: `Document ${updated.documentNumber} updated`,
    metadata: {
      fields: Object.keys(input),
      previousStatus: existing.status,
      newStatus: updated.status,
    },
  });

  return toPublic(updated);
}

async function assertRecordAccess(
  record: DocumentRecord,
  actorUserId: string,
): Promise<void> {
  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  } else {
    await assertClientAccess(actorUserId, record.clientId);
  }
}

export async function archiveDocument(
  id: string,
  reason: string | null,
  actorUserId: string,
): Promise<PublicDocument> {
  const existing = await documentRepository.findById(id);
  if (!existing) throw documentNotFoundError();
  await assertRecordAccess(existing, actorUserId);
  if (existing.status === 'ARCHIVED') throw documentAlreadyArchivedError();
  if (await documentRepository.isCanonicalBastDocument(existing.id)) {
    // Archiving a linked source Document would invalidate canonical BAST
    // identity through a generic command.
    throw documentUpdateNotAllowedError();
  }

  const archived = await documentRepository.archive(id, actorUserId, reason);
  if (!archived) throw documentAlreadyArchivedError();

  await recordOperationalEvent({
    clientId: archived.clientId,
    buildingId: archived.buildingId,
    entityType: 'DOCUMENT',
    entityId: archived.id,
    eventType: 'DOCUMENT_ARCHIVED',
    actorUserId,
    summary: `Document ${archived.documentNumber} archived`,
    metadata: {
      previousStatus: existing.status,
      archiveReason: reason,
      archivedAt: archived.archivedAt?.toISOString() ?? null,
    },
  });
  return toPublic(archived);
}

export async function restoreDocument(
  id: string,
  actorUserId: string,
): Promise<PublicDocument> {
  const existing = await documentRepository.findById(id);
  if (!existing) throw documentNotFoundError();
  await assertRecordAccess(existing, actorUserId);
  if (existing.status !== 'ARCHIVED') throw documentNotArchivedError();
  if (!existing.statusBeforeArchive) throw documentRestoreNotAllowedError();

  const restored = await documentRepository.restore(id);
  if (!restored) throw documentRestoreNotAllowedError();

  await recordOperationalEvent({
    clientId: restored.clientId,
    buildingId: restored.buildingId,
    entityType: 'DOCUMENT',
    entityId: restored.id,
    eventType: 'DOCUMENT_RESTORED',
    actorUserId,
    summary: `Document ${restored.documentNumber} restored`,
    metadata: {
      restoredStatus: restored.status,
      previousArchivedAt: existing.archivedAt?.toISOString() ?? null,
      previousArchivedByUserId: existing.archivedByUserId,
      previousArchiveReason: existing.archiveReason,
    },
  });
  return toPublic(restored);
}

function isDocumentNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === 'documents_client_number_unique';
}

export const documentService = {
  createDocument,
  getDocument,
  listDocuments,
  updateDocument,
  archiveDocument,
  restoreDocument,
  toPublic,
};
