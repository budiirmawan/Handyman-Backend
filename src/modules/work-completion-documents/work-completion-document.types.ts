/**
 * BE-22B — Work Completion Document.
 *
 * Binds ONE shared Document foundation (BE-22A) to a valid completed work context
 * (Work Order COMPLETED, optionally Vendor Work COMPLETED). No duplication of
 * Work Order / Vendor Work data — only references.
 * Supports INTERNAL / TENANT / VENDOR via shared document context.
 */

import type { DocumentContextType, DocumentSourceType, DocumentStatus, PublicDocument } from '../documents/document.types';

export type WorkCompletionDocumentRecord = {
  id: string;
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicWorkCompletionDocument = {
  id: string;
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  document: PublicDocument;
};

export type CreateWorkCompletionDocumentInput = {
  clientId: string;
  buildingId: string;
  documentNumber: string;
  documentType: string;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  workOrderId: string;
  vendorWorkId?: string | null;
};

export type WorkCompletionDocumentFilters = {
  workOrderId?: string;
  vendorWorkId?: string;
  buildingId?: string;
  contextType?: DocumentContextType;
  documentType?: string;
  status?: DocumentStatus;
  clientId?: string;
};
