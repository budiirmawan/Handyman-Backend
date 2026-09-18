import { buildingRepository } from '../buildings';
import { clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { propertyRepository } from '../properties';
import { tenantCompanyRepository } from '../tenant-companies';
import { vendorRepository } from '../vendors';
import { workCompletionDocumentRepository } from '../work-completion-documents/work-completion-document.repository';
import { bastDocumentRepository } from '../bast-documents/bast-document.repository';
import { handoverDocumentRepository } from '../handover-documents/handover-document.repository';
import { acceptanceSignOffRepository } from '../acceptance-sign-offs/acceptance-sign-off.repository';
import { documentRepository } from '../documents/document.repository';
import { documentUpdateNotAllowedError } from '../documents/document.errors';
import { documentService } from '../documents/document.service';
import { recordOperationalEvent } from '../operational-events';
import { getPool } from '../../database';
import type { PublicDocument } from '../documents/document.types';
import {
  supportingDocumentBuildingMismatchError,
  supportingDocumentContextMismatchError,
  supportingDocumentInvalidParentError,
  supportingDocumentNotFoundError,
  supportingDocumentParentNotFoundError,
} from './supporting-document.errors';
import { supportingDocumentRepository } from './supporting-document.repository';
import type {
  CreateSupportingDocumentInput,
  PublicSupportingDocument,
  SupportingDocumentFilters,
  SupportingDocumentRecord,
} from './supporting-document.types';

function toPublic(record: SupportingDocumentRecord, doc: PublicDocument): PublicSupportingDocument {
  return {
    id: record.id,
    documentId: record.documentId,
    parentType: record.parentType,
    parentId: record.parentId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    contextType: record.contextType as PublicSupportingDocument['contextType'],
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

async function isArchivedDocument(documentId: string): Promise<boolean> {
  return (await documentRepository.findById(documentId))?.status === 'ARCHIVED';
}

async function resolveParentContext(
  parentType: string,
  parentId: string,
): Promise<{
  clientId: string;
  buildingId: string | null;
  contextType?: string;
  archived?: boolean;
} | null> {
  switch (parentType) {
    case 'WORK_COMPLETION': {
      const wcd = await workCompletionDocumentRepository.findById(parentId);
      if (!wcd) return null;
      return {
        clientId: wcd.clientId,
        buildingId: wcd.buildingId,
        contextType: wcd.contextType as any,
        archived: await isArchivedDocument(wcd.documentId),
      };
    }
    case 'BAST': {
      const bd = await bastDocumentRepository.findById(parentId);
      if (!bd) return null;
      return {
        clientId: bd.clientId,
        buildingId: bd.buildingId,
        contextType: bd.contextType as any,
        archived: await isArchivedDocument(bd.documentId),
      };
    }
    case 'HANDOVER': {
      const hd = await handoverDocumentRepository.findById(parentId);
      if (!hd) return null;
      return {
        clientId: hd.clientId,
        buildingId: hd.buildingId,
        contextType: hd.contextType as any,
        archived: await isArchivedDocument(hd.documentId),
      };
    }
    case 'SIGN_OFF': {
      const aso = await acceptanceSignOffRepository.findById(parentId);
      if (!aso) return null;
      let documentId: string | null = null;
      if (aso.bastDocumentId) {
        documentId = (await bastDocumentRepository.findById(aso.bastDocumentId))?.documentId ?? null;
      } else if (aso.handoverDocumentId) {
        documentId = (await handoverDocumentRepository.findById(aso.handoverDocumentId))?.documentId ?? null;
      }
      return {
        clientId: aso.clientId,
        buildingId: aso.buildingId,
        contextType: aso.contextType as any,
        archived: documentId ? await isArchivedDocument(documentId) : false,
      };
    }
    case 'TENANT_COMPANY': {
      const tc = await tenantCompanyRepository.findById(parentId);
      if (!tc) return null;
      return { clientId: tc.clientId, buildingId: null };
    }
    case 'VENDOR': {
      const v = await vendorRepository.findById(parentId);
      if (!v) return null;
      return { clientId: v.clientId, buildingId: null };
    }
    case 'DOCUMENT': {
      const doc = await documentRepository.findById(parentId);
      if (!doc) return null;
      return {
        clientId: doc.clientId,
        buildingId: doc.buildingId,
        contextType: doc.contextType as any,
        archived: doc.status === 'ARCHIVED',
      };
    }
    case 'RFQ': {
      const result = await getPool().query<{ clientId: string; buildingId: string }>(
        `SELECT client_id AS "clientId", building_id AS "buildingId"
           FROM rfqs WHERE id = $1`,
        [parentId],
      );
      const row = result.rows[0];
      return row ? { clientId: row.clientId, buildingId: row.buildingId, contextType: 'VENDOR' } : null;
    }
    case 'QUOTATION_REVISION': {
      const result = await getPool().query<{ clientId: string; buildingId: string }>(
        `SELECT r.client_id AS "clientId", r.building_id AS "buildingId"
           FROM vendor_quotation_revisions r
          WHERE r.id = $1`,
        [parentId],
      );
      const row = result.rows[0];
      return row ? { clientId: row.clientId, buildingId: row.buildingId, contextType: 'VENDOR' } : null;
    }
    case 'HANDYMAN_QUOTATION_APPROVAL': {
      // CR-HM-BE-03 RUN 3 — approval evidence binds through the existing
      // supporting-documents authority (migration 0352 parent-type extension).
      const result = await getPool().query<{ clientId: string; buildingId: string }>(
        `SELECT a.client_id AS "clientId", a.building_id AS "buildingId"
           FROM handyman_quotation_approvals a
          WHERE a.id = $1`,
        [parentId],
      );
      const row = result.rows[0];
      return row ? { clientId: row.clientId, buildingId: row.buildingId, contextType: 'TENANT' } : null;
    }
    case 'HANDYMAN_MATERIAL_DEMAND':
    case 'HANDYMAN_MATERIAL_ADDENDUM':
    case 'HANDYMAN_MATERIAL_APPROVAL':
    case 'HANDYMAN_MATERIAL_ISSUE':
    case 'HANDYMAN_MATERIAL_USAGE':
    case 'HANDYMAN_MATERIAL_RETURN': {
      // CR-HM-BE-07 RUN 3 — material operations evidence binds through the
      // existing supporting-documents authority (migration 0360 parent-type
      // extension). Parent existence + same-client/building scoping is
      // proven here; actor access is asserted by the caller flow; the
      // existing client/building/context guards below apply unchanged.
      // Evidence is INTERNAL operational support and never mutates CR07
      // lifecycle, commercial, or inventory state.
      const table =
        parentType === 'HANDYMAN_MATERIAL_DEMAND'
          ? 'handyman_material_demands'
          : parentType === 'HANDYMAN_MATERIAL_ADDENDUM'
            ? 'handyman_material_commercial_addenda'
            : parentType === 'HANDYMAN_MATERIAL_APPROVAL'
              ? 'handyman_material_approvals'
              : parentType === 'HANDYMAN_MATERIAL_ISSUE'
                ? 'handyman_material_controlled_issues'
                : parentType === 'HANDYMAN_MATERIAL_USAGE'
                  ? 'handyman_material_actual_usages'
                  : 'handyman_material_returns';
      const result = await getPool().query<{ clientId: string; buildingId: string }>(
        `SELECT t.client_id AS "clientId", t.building_id AS "buildingId"
           FROM ${table} t
          WHERE t.id = $1`,
        [parentId],
      );
      const row = result.rows[0];
      return row ? { clientId: row.clientId, buildingId: row.buildingId, contextType: 'INTERNAL' } : null;
    }
    default:
      return null;
  }
}

export async function createSupportingDocument(
  input: CreateSupportingDocumentInput,
  actorUserId: string,
): Promise<PublicSupportingDocument> {
  // Validate parent exists
  const parentContext = await resolveParentContext(input.parentType, input.parentId);
  if (!parentContext) throw supportingDocumentParentNotFoundError();
  if (parentContext.archived) throw documentUpdateNotAllowedError();

  // Validate client/building for supporting document itself
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    const { clientNotFoundError } = await import('../clients/client.errors');
    throw clientNotFoundError();
  }

  // Building validation
  let effectiveBuildingId: string | null = input.buildingId ?? null;
  if (effectiveBuildingId) {
    const building = await buildingRepository.findById(effectiveBuildingId);
    if (!building) {
      const { buildingNotFoundError } = await import('../buildings/building.errors');
      throw buildingNotFoundError();
    }
    const property = await propertyRepository.findById(building.propertyId);
    if (!property || property.clientId !== input.clientId) throw supportingDocumentBuildingMismatchError();
    await contextAccessService.assertBuildingAccess(actorUserId, effectiveBuildingId);
  } else {
    // No building provided — need client access, and if parent has building, we should require building match?
    // For supporting docs, allow building-less only if parent is tenant/vendor without building and context is matching
    await assertClientAccess(actorUserId, input.clientId);
    // If parent has building but supporting has none, it's a mismatch unless parent is building-less
    if (parentContext.buildingId && !effectiveBuildingId) {
      // Allow? For now, require building if parent has building — treat as mismatch
      // But to keep minimal, allow supporting without building if parent has building? We'll check context mismatch later.
    }
  }

  // Context mismatch: supporting document's client must match parent's client
  if (parentContext.clientId !== input.clientId) throw supportingDocumentContextMismatchError('Supporting document client does not match parent.');

  // Building mismatch: if both have building, they must match
  if (parentContext.buildingId && effectiveBuildingId && parentContext.buildingId !== effectiveBuildingId) {
    throw supportingDocumentBuildingMismatchError();
  }
  // If parent has building and supporting has none, we can inherit parent building
  if (!effectiveBuildingId && parentContext.buildingId) {
    effectiveBuildingId = parentContext.buildingId;
    // Still need building access for inherited building
    await contextAccessService.assertBuildingAccess(actorUserId, effectiveBuildingId);
  }

  // Context type mismatch: supporting context should align with parent context if parent has contextType
  if (parentContext.contextType && parentContext.contextType !== input.contextType) {
    // For DOCUMENT parent, allow any? But for work contexts, require match
    // Enforce strict for WORK_COMPLETION/BAST/HANDOVER/SIGN_OFF
    if (['WORK_COMPLETION', 'BAST', 'HANDOVER', 'SIGN_OFF', 'DOCUMENT'].includes(input.parentType)) {
      throw supportingDocumentContextMismatchError('Supporting document context does not match parent.');
    }
  }

  // Source validation for supporting document's own context (like document foundation)
  if (input.contextType === 'TENANT') {
    if (!input.sourceId) throw supportingDocumentContextMismatchError('TENANT context requires TENANT_COMPANY source.');
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
    if (!input.sourceId) throw supportingDocumentContextMismatchError('VENDOR context requires VENDOR source.');
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
    throw supportingDocumentContextMismatchError('INTERNAL context only allows INTERNAL source or no source.');
  }

  // File reference is required for supporting docs (must not be empty, file storage convention)
  if (!input.fileReference || !input.fileReference.trim()) {
    throw supportingDocumentContextMismatchError('fileReference is required for supporting documents.');
  }
  if (input.fileReference.length > 512) throw supportingDocumentContextMismatchError('fileReference too long.');

  // Check duplicate document number
  const existingDocNumber = await documentRepository.findByClientAndNumber(input.clientId, input.documentNumber);
  if (existingDocNumber) {
    const { documentNumberAlreadyExistsError } = await import('../documents/document.errors');
    throw documentNumberAlreadyExistsError();
  }

  // Create underlying document via shared foundation
  const doc = await documentService.createDocument(
    {
      clientId: input.clientId,
      buildingId: effectiveBuildingId,
      documentNumber: input.documentNumber,
      documentType: input.documentType,
      contextType: input.contextType,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      title: input.title,
      description: input.description ?? null,
      fileReference: input.fileReference,
      status: input.status ?? 'DRAFT',
    },
    actorUserId,
  );

  try {
    const record = await supportingDocumentRepository.create({
      documentId: doc.id,
      parentType: input.parentType,
      parentId: input.parentId,
      clientId: input.clientId,
      buildingId: effectiveBuildingId,
      contextType: input.contextType,
      createdByUserId: actorUserId,
    });

    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      entityType: 'SUPPORTING_DOCUMENT',
      entityId: record.id,
      eventType: 'SUPPORTING_DOCUMENT_CREATED',
      actorUserId,
      summary: `Supporting document ${doc.documentNumber} bound to ${input.parentType} ${input.parentId}`,
      metadata: {
        documentId: doc.id,
        supportingId: record.id,
        parentType: input.parentType,
        parentId: input.parentId,
        fileReference: input.fileReference,
      },
    });

    return toPublic(record, doc);
  } catch (error) {
    try { await getPool().query('DELETE FROM documents WHERE id = $1', [doc.id]); } catch {}
    throw error;
  }
}

export async function getSupportingDocument(id: string, actorUserId: string): Promise<PublicSupportingDocument> {
  const record = await supportingDocumentRepository.findById(id);
  if (!record) throw supportingDocumentNotFoundError();
  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  } else {
    await assertClientAccess(actorUserId, record.clientId);
  }
  const doc = await documentRepository.findById(record.documentId);
  if (!doc) throw supportingDocumentNotFoundError();
  const publicDoc = documentService.toPublic(doc as any);
  return toPublic(record, publicDoc);
}

export async function listSupportingDocuments(
  filters: SupportingDocumentFilters,
  actorUserId: string,
): Promise<PublicSupportingDocument[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  if (filters.clientId) await assertClientAccess(actorUserId, filters.clientId);
  if (filters.parentId) {
    // Validate parent exists and actor has access to parent's building/client
    const parentCtx = await resolveParentContext(filters.parentType ?? 'DOCUMENT', filters.parentId);
    if (!parentCtx) throw supportingDocumentParentNotFoundError();
    if (parentCtx.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, parentCtx.buildingId);
    else await assertClientAccess(actorUserId, parentCtx.clientId);
  }

  const accessibleBuildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);
  const records = await supportingDocumentRepository.list(filters, accessibleBuildingIds, accessibleClientIds);
  const result: PublicSupportingDocument[] = [];
  for (const rec of records) {
    const doc = await documentRepository.findById(rec.documentId);
    if (!doc) continue;
    const publicDoc = documentService.toPublic(doc as any);
    result.push(toPublic(rec, publicDoc));
  }
  return result;
}

export const supportingDocumentService = {
  createSupportingDocument,
  getSupportingDocument,
  listSupportingDocuments,
};
