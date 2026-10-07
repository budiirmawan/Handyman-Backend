import { buildingRepository } from '../buildings';
import { clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { propertyRepository } from '../properties';
import { tenantCompanyRepository } from '../tenant-companies';
import { vendorRepository } from '../vendors';
import { workOrderRepository } from '../work-orders';
import { vendorWorkRepository } from '../vendor-work';
import { documentRepository } from '../documents/document.repository';
import { recordOperationalEvent } from '../operational-events';
import { documentService } from '../documents/document.service';
import type { PublicDocument } from '../documents/document.types';
import {
  workCompletionAlreadyExistsError,
  workCompletionBuildingMismatchError,
  workCompletionContextMismatchError,
  workCompletionDocumentNotFoundError,
  workCompletionWorkNotCompletedError,
  workCompletionWorkNotFoundError,
} from './work-completion-document.errors';
import { workCompletionDocumentRepository } from './work-completion-document.repository';
import type {
  CreateWorkCompletionDocumentInput,
  PublicWorkCompletionDocument,
  WorkCompletionDocumentFilters,
  WorkCompletionDocumentRecord,
} from './work-completion-document.types';

function toPublicWithDocument(
  record: WorkCompletionDocumentRecord,
  doc: PublicDocument,
): PublicWorkCompletionDocument {
  return {
    id: record.id,
    documentId: record.documentId,
    workOrderId: record.workOrderId,
    vendorWorkId: record.vendorWorkId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    contextType: record.contextType as PublicWorkCompletionDocument['contextType'],
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    document: doc,
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

async function assertWorkCompletionContext(
  input: CreateWorkCompletionDocumentInput,
): Promise<{ workOrderClientId: string; workOrderBuildingId: string; vendorWork: { id: string; vendorId: string } | null }> {
  const workOrder = await workOrderRepository.findById(input.workOrderId);
  if (!workOrder) throw workCompletionWorkNotFoundError();

  // Must be completed work context
  if (workOrder.status !== 'COMPLETED') throw workCompletionWorkNotCompletedError();

  // Client/Building coherence: document's client/building must match work's
  if (workOrder.clientId !== input.clientId) throw workCompletionContextMismatchError('Document client does not match work client.');
  if (workOrder.buildingId !== input.buildingId) throw workCompletionBuildingMismatchError();

  let vendorWork: { id: string; vendorId: string } | null = null;
  if (input.vendorWorkId !== undefined && input.vendorWorkId !== null) {
    const vw = await vendorWorkRepository.findById(input.vendorWorkId);
    if (!vw) throw workCompletionWorkNotFoundError();
    if (vw.workOrderId !== input.workOrderId) throw workCompletionContextMismatchError('Vendor work does not belong to the work order.');
    if (vw.buildingId !== input.buildingId) throw workCompletionBuildingMismatchError();
    if (vw.status !== 'COMPLETED') throw workCompletionWorkNotCompletedError();
    vendorWork = { id: vw.id, vendorId: vw.vendorId };

    // For VENDOR context, vendor must match source
    if (input.contextType === 'VENDOR') {
      if (!input.sourceId || vw.vendorId !== input.sourceId) {
        throw workCompletionContextMismatchError('VENDOR work vendor does not match document source.');
      }
    }
  } else {
    // If vendorWorkId not provided but context is VENDOR, we allow work-order-only vendor doc? But validate source exists
    if (input.contextType === 'VENDOR') {
      // Vendor context without vendor work is allowed if work order itself is vendor-related? Keep permissive but ensure source vendor exists
      // No additional check needed beyond document source validation already done via documentService
    }
  }

  // Additional cross-check: tenant/vendor source client already validated via document binding, but re-check building tenancy if needed
  // For TENANT context, vendor work not required; work order building already matches document building

  return { workOrderClientId: workOrder.clientId, workOrderBuildingId: workOrder.buildingId, vendorWork };
}

export async function createWorkCompletionDocument(
  input: CreateWorkCompletionDocumentInput,
  actorUserId: string,
): Promise<PublicWorkCompletionDocument> {
  // Validate client/building existence and isolation
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    const { clientNotFoundError } = await import('../clients/client.errors');
    throw clientNotFoundError();
  }
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    const { buildingNotFoundError } = await import('../buildings/building.errors');
    throw buildingNotFoundError();
  }
  const property = await propertyRepository.findById(building.propertyId);
  if (!property || property.clientId !== input.clientId) {
    throw workCompletionBuildingMismatchError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  // Validate work context first (so invalid work reference is prioritized)
  const workContext = await assertWorkCompletionContext(input);

  // Now validate document context/source via shared foundation invariants
  // Reuse document validation for context/source; but also check contextType matches workCompletion contextType
  // Use documentService's internal validation by attempting to create document; however we need to create document and binding atomically.
  // We'll call documentRepository directly after manual checks to avoid double isolation checks.

  // Validate source existence/client match (similar to documentService)
  if (input.contextType === 'TENANT') {
    if (!input.sourceId) throw workCompletionContextMismatchError('TENANT context requires TENANT_COMPANY source.');
    const company = await tenantCompanyRepository.findById(input.sourceId);
    if (!company) {
      const { documentSourceNotFoundError } = await import('../documents/document.errors');
      throw documentSourceNotFoundError();
    }
    if (company.clientId !== input.clientId) {
      const { documentSourceClientMismatchError } = await import('../documents/document.errors');
      throw documentSourceClientMismatchError();
    }
  }
  if (input.contextType === 'VENDOR') {
    if (!input.sourceId) throw workCompletionContextMismatchError('VENDOR context requires VENDOR source.');
    const vendor = await vendorRepository.findById(input.sourceId);
    if (!vendor) {
      const { documentSourceNotFoundError } = await import('../documents/document.errors');
      throw documentSourceNotFoundError();
    }
    if (vendor.clientId !== input.clientId) {
      const { documentSourceClientMismatchError } = await import('../documents/document.errors');
      throw documentSourceClientMismatchError();
    }
    // If vendorWork provided, ensure vendor matches source (already checked above)
  }
  if (input.contextType === 'INTERNAL' && input.sourceType && input.sourceType !== 'INTERNAL') {
    throw workCompletionContextMismatchError('INTERNAL context only allows INTERNAL source or no source.');
  }

  // Check duplicate document number (reuse document logic)
  const existingDocNumber = await documentRepository.findByClientAndNumber(input.clientId, input.documentNumber);
  if (existingDocNumber) {
    const { documentNumberAlreadyExistsError } = await import('../documents/document.errors');
    throw documentNumberAlreadyExistsError();
  }

  // Create underlying document via shared foundation (reuses documentService to keep invariants)
  // We call documentService.createDocument to reuse its building/client and context validation, but we already validated work building,
  // so bypassing double check is okay; using repository directly after validation is simpler to keep atomicity.
  // For history preservation, we will still record operational event via document creation.

  // Create document
  const doc = await documentService.createDocument(
    {
      clientId: input.clientId,
      buildingId: input.buildingId,
      documentNumber: input.documentNumber,
      documentType: input.documentType,
      contextType: input.contextType,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      title: input.title,
      description: input.description ?? null,
      fileReference: input.fileReference ?? null,
      status: input.status ?? 'DRAFT',
    },
    actorUserId,
  );

  // Create binding
  try {
    const record = await workCompletionDocumentRepository.create({
      documentId: doc.id,
      workOrderId: input.workOrderId,
      vendorWorkId: input.vendorWorkId ?? null,
      clientId: input.clientId,
      buildingId: input.buildingId,
      contextType: input.contextType,
      createdByUserId: actorUserId,
    });

    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      entityType: 'WORK_COMPLETION_DOCUMENT',
      entityId: record.id,
      eventType: 'WORK_COMPLETION_DOCUMENT_CREATED',
      actorUserId,
      summary: `Work completion document ${doc.documentNumber} bound to work ${input.workOrderId}`,
      metadata: {
        documentId: doc.id,
        workOrderId: input.workOrderId,
        vendorWorkId: input.vendorWorkId ?? null,
        contextType: input.contextType,
      },
    });

    return toPublicWithDocument(record, doc);
  } catch (error) {
    // Rollback document if binding fails (to avoid orphaned docs)
    // Documents are not hard-deleted normally, but for atomicity we remove the just-created doc
    // Use direct query to delete; history preserved via operational_events already
    try {
      const { getPool } = await import('../../database');
      await getPool().query('DELETE FROM documents WHERE id = $1', [doc.id]);
    } catch {
      // ignore cleanup failure
    }
    if (isUniqueViolation(error)) throw workCompletionAlreadyExistsError();
    throw error;
  }
}

export async function getWorkCompletionDocument(
  id: string,
  actorUserId: string,
): Promise<PublicWorkCompletionDocument> {
  const record = await workCompletionDocumentRepository.findById(id);
  if (!record) throw workCompletionDocumentNotFoundError();

  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);

  const doc = await documentRepository.findById(record.documentId);
  if (!doc) throw workCompletionDocumentNotFoundError();
  // Convert doc to public via documentService
  const { documentService: ds } = await import('../documents/document.service');
  const publicDoc = ds.toPublic(doc as any);

  return toPublicWithDocument(record, publicDoc);
}

export async function listWorkCompletionDocuments(
  filters: WorkCompletionDocumentFilters,
  actorUserId: string,
): Promise<PublicWorkCompletionDocument[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  if (filters.clientId) await assertClientAccess(actorUserId, filters.clientId);
  if (filters.workOrderId) {
    const wo = await workOrderRepository.findById(filters.workOrderId);
    if (!wo) throw workCompletionWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, wo.buildingId);
  }
  if (filters.vendorWorkId) {
    const vw = await vendorWorkRepository.findById(filters.vendorWorkId);
    if (!vw) throw workCompletionWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, vw.buildingId);
  }

  const accessibleBuildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);

  const records = await workCompletionDocumentRepository.list(filters, accessibleBuildingIds, accessibleClientIds);

  // Batch load documents
  const result: PublicWorkCompletionDocument[] = [];
  for (const rec of records) {
    const doc = await documentRepository.findById(rec.documentId);
    if (!doc) continue;
    const { documentService: ds } = await import('../documents/document.service');
    const publicDoc = ds.toPublic(doc as any);
    result.push(toPublicWithDocument(rec, publicDoc));
  }
  return result;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const c = error as { code?: string; constraint?: string };
  return c.code === '23505' && (c.constraint === 'work_completion_documents_document_id_key' || c.constraint === 'work_completion_documents_pkey');
}

export const workCompletionDocumentService = {
  createWorkCompletionDocument,
  getWorkCompletionDocument,
  listWorkCompletionDocuments,
};
