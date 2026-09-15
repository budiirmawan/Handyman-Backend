import { buildingRepository } from '../buildings';
import { clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { propertyRepository } from '../properties';
import { tenantCompanyRepository } from '../tenant-companies';
import { vendorRepository } from '../vendors';
import { workOrderRepository } from '../work-orders';
import { vendorWorkRepository } from '../vendor-work';
import { workCompletionDocumentRepository } from '../work-completion-documents/work-completion-document.repository';
import { bastDocumentRepository } from '../bast-documents/bast-document.repository';
import { documentRepository } from '../documents/document.repository';
import { documentService } from '../documents/document.service';
import { recordOperationalEvent } from '../operational-events';
import { getPool } from '../../database';
import type { PublicDocument } from '../documents/document.types';
import {
  handoverAlreadyExistsError,
  handoverBastMismatchError,
  handoverBastNotFoundError,
  handoverBuildingMismatchError,
  handoverContextMismatchError,
  handoverDocumentNotFoundError,
  handoverNumberAlreadyExistsError,
  handoverWorkNotCompletedError,
  handoverWorkNotFoundError,
} from './handover-document.errors';
import { handoverDocumentRepository } from './handover-document.repository';
import type {
  CreateHandoverDocumentInput,
  HandoverDocumentFilters,
  HandoverDocumentRecord,
  PublicHandoverDocument,
} from './handover-document.types';

function toPublic(record: HandoverDocumentRecord, doc: PublicDocument): PublicHandoverDocument {
  return {
    id: record.id,
    documentId: record.documentId,
    workOrderId: record.workOrderId,
    vendorWorkId: record.vendorWorkId,
    workCompletionDocumentId: record.workCompletionDocumentId,
    bastDocumentId: record.bastDocumentId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    contextType: record.contextType as PublicHandoverDocument['contextType'],
    handoverNumber: record.handoverNumber,
    handoverDate: record.handoverDate,
    handoverStatus: record.handoverStatus,
    notes: record.notes,
    fileReference: record.fileReference,
    preparedByUserId: record.preparedByUserId,
    handedOverByUserId: record.handedOverByUserId,
    handedOverAt: record.handedOverAt ? record.handedOverAt.toISOString() : null,
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

async function assertHandoverWorkContext(input: CreateHandoverDocumentInput): Promise<void> {
  const workOrder = await workOrderRepository.findById(input.workOrderId);
  if (!workOrder) throw handoverWorkNotFoundError();
  if (workOrder.status !== 'COMPLETED') throw handoverWorkNotCompletedError();
  if (workOrder.clientId !== input.clientId) throw handoverContextMismatchError('Handover client does not match work client.');
  if (workOrder.buildingId !== input.buildingId) throw handoverBuildingMismatchError();

  if (input.vendorWorkId) {
    const vw = await vendorWorkRepository.findById(input.vendorWorkId);
    if (!vw) throw handoverWorkNotFoundError();
    if (vw.workOrderId !== input.workOrderId) throw handoverContextMismatchError('Vendor work does not belong to work order.');
    if (vw.buildingId !== input.buildingId) throw handoverBuildingMismatchError();
    if (vw.status !== 'COMPLETED') throw handoverWorkNotCompletedError();
    if (input.contextType === 'VENDOR' && input.sourceId && vw.vendorId !== input.sourceId) {
      throw handoverContextMismatchError('Vendor work vendor does not match handover source.');
    }
  }

  if (input.workCompletionDocumentId) {
    const wcd = await workCompletionDocumentRepository.findById(input.workCompletionDocumentId);
    if (!wcd) throw handoverWorkNotFoundError();
    if (wcd.workOrderId !== input.workOrderId) throw handoverContextMismatchError('Work completion does not belong to work order.');
    if (wcd.buildingId !== input.buildingId) throw handoverBuildingMismatchError();
    if (wcd.clientId !== input.clientId) throw handoverContextMismatchError('Work completion client mismatch.');
    if (input.vendorWorkId && wcd.vendorWorkId && wcd.vendorWorkId !== input.vendorWorkId) {
      throw handoverContextMismatchError('Work completion vendor mismatch.');
    }
  }

  if (input.bastDocumentId) {
    const bd = await bastDocumentRepository.findById(input.bastDocumentId);
    if (!bd) throw handoverBastNotFoundError();
    if (bd.workOrderId !== input.workOrderId) throw handoverBastMismatchError();
    if (bd.buildingId !== input.buildingId) throw handoverBuildingMismatchError();
    if (bd.clientId !== input.clientId) throw handoverContextMismatchError('BAST client mismatch.');
    if (input.vendorWorkId && bd.vendorWorkId && bd.vendorWorkId !== input.vendorWorkId) {
      throw handoverBastMismatchError();
    }
    // BAST compatibility: bast's vendorWork should align with handover's vendorWork if both present
    // Also ensure bast is at least DRAFT (any status allowed for now)
  }
}

export async function createHandoverDocument(
  input: CreateHandoverDocumentInput,
  actorUserId: string,
): Promise<PublicHandoverDocument> {
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
  if (!property || property.clientId !== input.clientId) throw handoverBuildingMismatchError();
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  await assertHandoverWorkContext(input);

  if (input.contextType === 'TENANT') {
    if (!input.sourceId) throw handoverContextMismatchError('TENANT context requires TENANT_COMPANY source.');
    const c = await tenantCompanyRepository.findById(input.sourceId);
    if (!c) {
      const { documentSourceNotFoundError } = await import('../documents/document.errors');
      throw documentSourceNotFoundError();
    }
    if (c.clientId !== input.clientId) {
      const { documentSourceClientMismatchError } = await import('../documents/document.errors');
      throw documentSourceClientMismatchError();
    }
  }
  if (input.contextType === 'VENDOR') {
    if (!input.sourceId) throw handoverContextMismatchError('VENDOR context requires VENDOR source.');
    const v = await vendorRepository.findById(input.sourceId);
    if (!v) {
      const { documentSourceNotFoundError } = await import('../documents/document.errors');
      throw documentSourceNotFoundError();
    }
    if (v.clientId !== input.clientId) {
      const { documentSourceClientMismatchError } = await import('../documents/document.errors');
      throw documentSourceClientMismatchError();
    }
  }
  if (input.contextType === 'INTERNAL' && input.sourceType && input.sourceType !== 'INTERNAL') {
    throw handoverContextMismatchError('INTERNAL context only allows INTERNAL source or no source.');
  }

  const existingHandoverNumber = await handoverDocumentRepository.findByHandoverNumber(input.clientId, input.handoverNumber);
  if (existingHandoverNumber) throw handoverNumberAlreadyExistsError();

  if (input.vendorWorkId) {
    const existingByVendorWork = await getPool().query('SELECT id FROM handover_documents WHERE vendor_work_id = $1', [input.vendorWorkId]);
    if (existingByVendorWork.rowCount && existingByVendorWork.rowCount > 0) throw handoverAlreadyExistsError();
  }

  const existingDocNumber = await documentRepository.findByClientAndNumber(input.clientId, input.documentNumber);
  if (existingDocNumber) {
    const { documentNumberAlreadyExistsError } = await import('../documents/document.errors');
    throw documentNumberAlreadyExistsError();
  }

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

  try {
    const record = await handoverDocumentRepository.create({
      documentId: doc.id,
      workOrderId: input.workOrderId,
      vendorWorkId: input.vendorWorkId ?? null,
      workCompletionDocumentId: input.workCompletionDocumentId ?? null,
      bastDocumentId: input.bastDocumentId ?? null,
      clientId: input.clientId,
      buildingId: input.buildingId,
      contextType: input.contextType,
      handoverNumber: input.handoverNumber,
      handoverDate: input.handoverDate,
      notes: input.notes ?? null,
      fileReference: input.fileReference ?? null,
      preparedByUserId: actorUserId,
    });

    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      entityType: 'HANDOVER_DOCUMENT',
      entityId: record.id,
      eventType: 'HANDOVER_DOCUMENT_CREATED',
      actorUserId,
      summary: `Handover ${record.handoverNumber} created for work ${input.workOrderId}`,
      metadata: {
        documentId: doc.id,
        handoverId: record.id,
        workOrderId: input.workOrderId,
        vendorWorkId: input.vendorWorkId ?? null,
        workCompletionDocumentId: input.workCompletionDocumentId ?? null,
        bastDocumentId: input.bastDocumentId ?? null,
        handoverNumber: record.handoverNumber,
      },
    });

    return toPublic(record, doc);
  } catch (error) {
    try { await getPool().query('DELETE FROM documents WHERE id = $1', [doc.id]); } catch {}
    if (isHandoverNumberUniqueViolation(error)) throw handoverNumberAlreadyExistsError();
    if (isVendorWorkUniqueViolation(error)) throw handoverAlreadyExistsError();
    throw error;
  }
}

export async function getHandoverDocument(id: string, actorUserId: string): Promise<PublicHandoverDocument> {
  const record = await handoverDocumentRepository.findById(id);
  if (!record) throw handoverDocumentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  const doc = await documentRepository.findById(record.documentId);
  if (!doc) throw handoverDocumentNotFoundError();
  const publicDoc = documentService.toPublic(doc as any);
  return toPublic(record, publicDoc);
}

export async function listHandoverDocuments(
  filters: HandoverDocumentFilters,
  actorUserId: string,
): Promise<PublicHandoverDocument[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  if (filters.clientId) await assertClientAccess(actorUserId, filters.clientId);
  if (filters.workOrderId) {
    const wo = await workOrderRepository.findById(filters.workOrderId);
    if (!wo) throw handoverWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, wo.buildingId);
  }
  if (filters.vendorWorkId) {
    const vw = await vendorWorkRepository.findById(filters.vendorWorkId);
    if (!vw) throw handoverWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, vw.buildingId);
  }
  if (filters.bastDocumentId) {
    const bd = await bastDocumentRepository.findById(filters.bastDocumentId);
    if (!bd) throw handoverBastNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, bd.buildingId);
  }
  if (filters.workCompletionDocumentId) {
    const wcd = await workCompletionDocumentRepository.findById(filters.workCompletionDocumentId);
    if (!wcd) throw handoverWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, wcd.buildingId);
  }

  const accessibleBuildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);
  const records = await handoverDocumentRepository.list(filters, accessibleBuildingIds, accessibleClientIds);
  const result: PublicHandoverDocument[] = [];
  for (const rec of records) {
    const doc = await documentRepository.findById(rec.documentId);
    if (!doc) continue;
    const publicDoc = documentService.toPublic(doc as any);
    result.push(toPublic(rec, publicDoc));
  }
  return result;
}

function isHandoverNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const c = error as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'handover_documents_client_number_unique';
}
function isVendorWorkUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const c = error as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'handover_documents_vendor_work_unique';
}

export const handoverDocumentService = {
  createHandoverDocument,
  getHandoverDocument,
  listHandoverDocuments,
};
