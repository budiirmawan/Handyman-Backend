/**
 * BE-22D — Handover Document.
 *
 * Binds shared Document foundation to valid work / completion / BAST context.
 * Reuses Work Order / Vendor Work / Work Completion (BE-22B) / BAST (BE-22C)
 * — no separate handover engine.
 * Supports INTERNAL / TENANT / VENDOR.
 */

import type { DocumentContextType, DocumentSourceType, DocumentStatus, PublicDocument } from '../documents/document.types';

export const HANDOVER_STATUSES = ['DRAFT', 'HANDED_OVER'] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];
export function isHandoverStatus(v: unknown): v is HandoverStatus {
  return typeof v === 'string' && (HANDOVER_STATUSES as readonly string[]).includes(v);
}

export type HandoverDocumentRecord = {
  id: string;
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  workCompletionDocumentId: string | null;
  bastDocumentId: string | null;
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  handoverNumber: string;
  handoverDate: string; // YYYY-MM-DD
  handoverStatus: HandoverStatus;
  notes: string | null;
  fileReference: string | null;
  preparedByUserId: string;
  handedOverByUserId: string | null;
  handedOverAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHandoverDocument = {
  id: string;
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  workCompletionDocumentId: string | null;
  bastDocumentId: string | null;
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  handoverNumber: string;
  handoverDate: string;
  handoverStatus: HandoverStatus;
  notes: string | null;
  fileReference: string | null;
  preparedByUserId: string;
  handedOverByUserId: string | null;
  handedOverAt: string | null;
  createdAt: string;
  updatedAt: string;
  document: PublicDocument;
};

export type CreateHandoverDocumentInput = {
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  documentNumber: string;
  documentType: string;
  workOrderId: string;
  vendorWorkId?: string | null;
  workCompletionDocumentId?: string | null;
  bastDocumentId?: string | null;
  handoverNumber: string;
  handoverDate: string;
  notes?: string | null;
};

export type HandoverDocumentFilters = {
  workOrderId?: string;
  vendorWorkId?: string;
  workCompletionDocumentId?: string;
  bastDocumentId?: string;
  buildingId?: string;
  contextType?: DocumentContextType;
  handoverStatus?: HandoverStatus;
  clientId?: string;
  handoverNumber?: string;
  status?: DocumentStatus;
};
