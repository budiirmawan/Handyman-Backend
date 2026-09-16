/**
 * BE-22F — Supporting Document.
 * Uses shared Document foundation, may support Work Completion, BAST, Handover, Sign-Off, Tenant or Vendor.
 * No separate engine, file_reference only, preserves history.
 */

import type { DocumentContextType, DocumentSourceType, DocumentStatus, PublicDocument } from '../documents/document.types';

export const SUPPORTING_PARENT_TYPES = [
  'WORK_COMPLETION',
  'BAST',
  'HANDOVER',
  'SIGN_OFF',
  'TENANT_COMPANY',
  'VENDOR',
  'DOCUMENT',
  'RFQ',
  'QUOTATION_REVISION',
  // CR-HM-BE-03 RUN 3 — customer quotation approval evidence (migration 0352)
  'HANDYMAN_QUOTATION_APPROVAL',
] as const;
export type SupportingParentType = (typeof SUPPORTING_PARENT_TYPES)[number];
export function isSupportingParentType(v: unknown): v is SupportingParentType {
  return typeof v === 'string' && (SUPPORTING_PARENT_TYPES as readonly string[]).includes(v);
}

export type SupportingDocumentRecord = {
  id: string;
  documentId: string;
  parentType: SupportingParentType;
  parentId: string;
  clientId: string;
  buildingId: string | null;
  contextType: DocumentContextType;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSupportingDocument = {
  id: string;
  documentId: string;
  parentType: SupportingParentType;
  parentId: string;
  clientId: string;
  buildingId: string | null;
  contextType: DocumentContextType;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  document: PublicDocument;
};

export type CreateSupportingDocumentInput = {
  clientId: string;
  buildingId?: string | null;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference: string;
  status?: DocumentStatus;
  documentNumber: string;
  documentType: string;
  parentType: SupportingParentType;
  parentId: string;
};

export type SupportingDocumentFilters = {
  parentType?: SupportingParentType;
  parentId?: string;
  buildingId?: string;
  contextType?: DocumentContextType;
  clientId?: string;
  documentType?: string;
};
